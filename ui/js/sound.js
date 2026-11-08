// Sound feedback for the main actions, synthesized with WebAudio (no audio files, nothing over the network).
// Chain: voices → (dry + generated reverb) → compressor → output. Bells with inharmonic partials sound like glass.
let ac = null, bus = null, enabled = true, sleeping = false;

export const setSoundEnabled = (b) => { enabled = !!b; };

function impulse(a, seconds = 1.8, decay = 3.2) {
  const n = Math.floor(a.sampleRate * seconds), buf = a.createBuffer(2, n, a.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
  }
  return buf;
}

function audio() {
  if (!ac) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ac = new C();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2;
    const out = ac.createGain(); out.gain.value = 0.55;
    const verb = ac.createConvolver(); verb.buffer = impulse(ac);
    const wet = ac.createGain(); wet.gain.value = 0.28;
    bus = ac.createGain();
    bus.connect(comp); bus.connect(verb); verb.connect(wet); wet.connect(comp);
    comp.connect(out); out.connect(ac.destination);
  }
  // `sleeping`: a suspend() may still be pending (state reads 'running'); resume() queues after it.
  if (sleeping || ac.state === 'suspended') { sleeping = false; ac.resume().catch(() => {}); }
  return ac;
}

function env(a, g, s, peak, attack, dur) {
  g.gain.setValueAtTime(0.0001, s);
  g.gain.exponentialRampToValueAtTime(peak, s + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
}

// Glass bell: partials 1 / 2.76 / 5.4 / 8.9 with increasingly shorter decays.
function bell(a, f, t0, { gain = 0.08, dur = 1.1, pan = 0 } = {}) {
  const s = a.currentTime + t0, p = a.createStereoPanner();
  p.pan.value = pan; p.connect(bus);
  [[1, 1, 1], [2.76, 0.45, 0.6], [5.4, 0.22, 0.35], [8.93, 0.1, 0.2]].forEach(([mul, amp, len]) => {
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f * mul, s);
    env(a, g, s, gain * amp, 0.004, dur * len);
    o.connect(g).connect(p); o.start(s); o.stop(s + dur * len + 0.05);
  });
}

function tone(a, f, t0, { f2, dur = 0.3, type = 'sine', gain = 0.06, pan = 0, lp } = {}) {
  const s = a.currentTime + t0, o = a.createOscillator(), g = a.createGain(), p = a.createStereoPanner();
  o.type = type; o.frequency.setValueAtTime(f, s);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, s + dur * 0.8);
  env(a, g, s, gain, 0.02, dur);
  p.pan.value = pan;
  let node = o.connect(g);
  if (lp) { const fl = a.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; node = node.connect(fl); }
  node.connect(p).connect(bus);
  o.start(s); o.stop(s + dur + 0.05);
}

// Puff of filtered air crossing the stereo field; `up` raises the filter (cleanup), otherwise it lowers it.
function whoosh(a, t0, { dur = 0.7, gain = 0.07, up = true, from = -0.8, to = 0.8 } = {}) {
  const n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const s = a.currentTime + t0, src = a.createBufferSource(), bp = a.createBiquadFilter(), g = a.createGain(), p = a.createStereoPanner();
  src.buffer = buf;
  bp.type = 'bandpass'; bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(up ? 400 : 3200, s);
  bp.frequency.exponentialRampToValueAtTime(up ? 5200 : 500, s + dur);
  p.pan.setValueAtTime(from, s); p.pan.linearRampToValueAtTime(to, s + dur);
  g.gain.setValueAtTime(0.0001, s);
  g.gain.exponentialRampToValueAtTime(gain, s + dur * 0.4);
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
  src.connect(bp).connect(g).connect(p).connect(bus);
  src.start(s); src.stop(s + dur);
}

const SOUNDS = {
  // Scan start: soft puff that rises, plus a glass tap.
  start: (a) => { whoosh(a, 0, { dur: 0.55, gain: 0.035, from: -0.3, to: 0.3 }); tone(a, 784, 0.05, { f2: 1175, dur: 0.45, gain: 0.03 }); bell(a, 1568, 0.32, { gain: 0.035, dur: 0.9 }); },
  // Results ready: arpeggio of three bells.
  found: (a) => { bell(a, 1047, 0, { gain: 0.07, pan: -0.25 }); bell(a, 1319, 0.08, { gain: 0.06 }); bell(a, 1568, 0.16, { gain: 0.06, pan: 0.25, dur: 1.4 }); },
  // Cleanup finished: stereo sweep + sparkling ascending arpeggio.
  clean: (a) => {
    whoosh(a, 0, { dur: 0.75, gain: 0.08 });
    [1047, 1319, 1568, 2093, 2637].forEach((f, i) => bell(a, f, 0.34 + i * 0.065, { gain: 0.055 - i * 0.006, pan: -0.5 + i * 0.25, dur: 1.2 }));
    bell(a, 3136, 0.78, { gain: 0.025, dur: 1.6 });
  },
  // Stop: two descending, muffled tones.
  stop: (a) => { tone(a, 784, 0, { dur: 0.18, type: 'triangle', gain: 0.05, lp: 2400 }); tone(a, 523, 0.12, { dur: 0.32, type: 'triangle', gain: 0.05, lp: 2000 }); },
  // Error: short, soft, falling pair, no scare. Kept above ~350 Hz: lower fundamentals vanish on laptop speakers
  // and in the ear's sensitivity curve, which made the cue far quieter than the success ones.
  error: (a) => { tone(a, 466, 0, { dur: 0.16, type: 'triangle', gain: 0.15, lp: 1800 }); tone(a, 349, 0.13, { dur: 0.3, type: 'triangle', gain: 0.15, lp: 1700 }); },

  // Gestures: very short (<250 ms), quiet, never on hover.
  // Check: crisp, dry glass; uncheck: dull, lower tap.
  tick: (a) => bell(a, 1976, 0, { gain: 0.03, dur: 0.16 }),
  untick: (a) => tone(a, 660, 0, { dur: 0.09, type: 'triangle', gain: 0.035, lp: 1500 }),
  // Switches: short rise when turned on, muffled fall when turned off.
  'switch-on': (a) => { tone(a, 520, 0, { f2: 780, dur: 0.14, gain: 0.04 }); bell(a, 1568, 0.05, { gain: 0.025, dur: 0.2 }); },
  'switch-off': (a) => tone(a, 659, 0, { f2: 440, dur: 0.14, type: 'triangle', gain: 0.04, lp: 1800 }),
  // Module switch: very quiet puff and a tap.
  nav: (a) => { whoosh(a, 0, { dur: 0.16, gain: 0.012, from: -0.15, to: 0.15 }); bell(a, 1175, 0.03, { gain: 0.03, dur: 0.22 }); },
  // Pressing the primary button.
  pop: (a) => { tone(a, 392, 0, { f2: 587, dur: 0.09, gain: 0.04, lp: 2200 }); bell(a, 1047, 0, { gain: 0.02, dur: 0.15 }); },
  // Dialog: opens with a slight rise, closes with a fall.
  open: (a) => { tone(a, 440, 0, { f2: 660, dur: 0.18, gain: 0.03 }); bell(a, 1319, 0.05, { gain: 0.025, dur: 0.18 }); },
  close: (a) => tone(a, 587, 0, { f2: 392, dur: 0.16, type: 'triangle', gain: 0.03, lp: 1800 }),
  // Destructive dialog: two soft, falling tones, no scare (at least as present as the ordinary 'open').
  warn: (a) => { tone(a, 494, 0, { dur: 0.12, gain: 0.045, lp: 1800 }); tone(a, 392, 0.09, { dur: 0.16, gain: 0.045, lp: 1700 }); },
  // Menu opening: minimal tick.
  menu: (a) => bell(a, 2093, 0, { gain: 0.03, dur: 0.09 }),
  // Toasts: success with two bells; error is a softer 'error'.
  ok: (a) => { bell(a, 1319, 0, { gain: 0.045, dur: 0.5, pan: -0.15 }); bell(a, 1760, 0.09, { gain: 0.04, dur: 0.7, pan: 0.15 }); },
  err: (a) => { tone(a, 494, 0, { dur: 0.14, type: 'triangle', gain: 0.095, lp: 1800 }); tone(a, 392, 0.1, { dur: 0.24, type: 'triangle', gain: 0.095, lp: 1700 }); },
};

// The toast that offers "Undo" is the same cue as 'ok' under its own name, so it alone is ducked after a result cue.
SOUNDS['ok-offer'] = SOUNDS.ok;

// Approximate duration (ms) of each voice, to count the active ones without tracking each node.
const LIFE = { start: 1500, found: 1600, clean: 2700, stop: 600, error: 600, tick: 250, untick: 200, 'switch-on': 350, 'switch-off': 300, nav: 350, pop: 250, open: 350, close: 250, warn: 350, menu: 200, ok: 900, 'ok-offer': 900, err: 450 };
// A toast that accompanies an already-played result sound does not sound again. Each pair has its own window:
// the undo offer (toast with an action: 'ok-offer', see feel.js) arrives ~900 ms after the cleanup ends, while 'clean' is still ringing. 'error' and 'err' duck
// each other because api.call shows the error toast before the view's catch runs.
// 'err' also ducks itself: a failing multi-group removal shows one toast per group, which must sound once (a
// failures sheet opening right after those toasts belongs to the same outcome, hence 'err' in 'open' too).
// 'open' is ducked after a result cue: a failures sheet opening right after 'clean'/'error'/'ok' belongs to that
// same outcome and must not add a rising chime over it.
const DUCK = { 'ok-offer': [['clean', 2000], ['found', 1700]], err: [['error', 600], ['err', 1500]], error: [['err', 600]], open: [['clean', 1500], ['error', 1500], ['ok', 1500], ['ok-offer', 1500], ['err', 1500]] };
// Completion cues of long operations: they still play with the window in the background (that is when the user
// needs them). Every other sound answers a gesture, so it stays gated on focus.
const RESULT = new Set(['found', 'clean', 'error', 'stop']);
const MIN_GAP = 40, MAX_VOICES = 6;
const last = new Map();
let active = 0, lastAt = 0, sleepTimer = 0;
// Once the last voice and the reverb tail (impulse of 1.8 s) are over, the context is suspended so the audio
// thread and output device stop rendering silence; audio() resumes it on the next sound.
const TAIL = 2000;
function sleepLater() {
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => { sleepTimer = 0; if (!active && ac && ac.state === 'running') { sleeping = true; ac.suspend().catch(() => {}); } }, TAIL);
}

// Instant (performance.now) of the last sound that actually played; feel.js uses it to avoid adding the 'pop' to a view's sound.
export const lastPlayedAt = () => lastAt;

// Wakes a suspended context ahead of the gesture's sound: restarting the output device takes ~100 ms, which hides in the
// gap between pointerdown/keydown and click instead of delaying the cue. Never creates the context (that happens on play).
export function warm() {
  if (!enabled || !ac || document.hidden || !document.hasFocus() || document.body.classList.contains('idle')) return;
  if (!sleeping && ac.state !== 'suspended') return;
  sleeping = false;
  ac.resume().catch(() => {});
  if (!active) sleepLater(); // nothing may follow (a press that plays no cue): go back to sleep
}

export function play(name) {
  if (!enabled || !SOUNDS[name]) return;
  if (!RESULT.has(name) && (!document.hasFocus() || document.body.classList.contains('idle'))) return;
  const now = performance.now();
  if (now - (last.get(name) ?? -1e9) < MIN_GAP) return;
  if (DUCK[name] && DUCK[name].some(([n, ms]) => now - (last.get(n) ?? -1e9) < ms)) return;
  if (active >= MAX_VOICES) return;
  try {
    const a = audio();
    if (!a) return;
    clearTimeout(sleepTimer); sleepTimer = 0;
    SOUNDS[name](a);
    last.set(name, now); lastAt = now; active++;
    setTimeout(() => { active = Math.max(0, active - 1); if (!active) sleepLater(); }, LIFE[name] || 800);
  } catch (e) { /* sound is optional */ }
}
