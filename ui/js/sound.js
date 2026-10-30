// Feedback sonoro das ações principais, sintetizado com WebAudio (sem arquivos de áudio, nada de rede).
let ac = null, master = null, enabled = true;

export const setSoundEnabled = (b) => { enabled = !!b; };

function audio() {
  if (!ac) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ac = new C();
    master = ac.createGain();
    master.gain.value = 0.5;
    master.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  return ac;
}

function tone(a, { f, f2, t0 = 0, dur = 0.25, type = 'sine', gain = 0.12 }) {
  const o = a.createOscillator(), g = a.createGain(), s = a.currentTime + t0;
  o.type = type;
  o.frequency.setValueAtTime(f, s);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, s + dur);
  g.gain.setValueAtTime(0.0001, s);
  g.gain.exponentialRampToValueAtTime(gain, s + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
  o.connect(g).connect(master);
  o.start(s);
  o.stop(s + dur + 0.05);
}

// Sopro de ruído filtrado subindo de tom: o "whoosh" da limpeza.
function whoosh(a, { t0 = 0, dur = 0.55, gain = 0.09 }) {
  const n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource(), bp = a.createBiquadFilter(), g = a.createGain(), s = a.currentTime + t0;
  src.buffer = buf;
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(500, s);
  bp.frequency.exponentialRampToValueAtTime(5000, s + dur);
  g.gain.setValueAtTime(0.0001, s);
  g.gain.exponentialRampToValueAtTime(gain, s + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
  src.connect(bp).connect(g).connect(master);
  src.start(s);
  src.stop(s + dur);
}

const SOUNDS = {
  start: (a) => tone(a, { f: 420, f2: 760, dur: 0.32, gain: 0.06 }),
  found: (a) => { tone(a, { f: 659, dur: 0.28, type: 'triangle', gain: 0.09 }); tone(a, { f: 988, t0: 0.12, dur: 0.42, type: 'triangle', gain: 0.08 }); },
  clean: (a) => {
    whoosh(a, {});
    [1047, 1319, 1568, 2093].forEach((f, i) => tone(a, { f, t0: 0.32 + i * 0.07, dur: 0.5, type: 'sine', gain: 0.06 }));
  },
  error: (a) => { tone(a, { f: 220, dur: 0.18, type: 'triangle', gain: 0.09 }); tone(a, { f: 165, t0: 0.14, dur: 0.3, type: 'triangle', gain: 0.09 }); },
};

export function play(name) {
  if (!enabled || !SOUNDS[name]) return;
  try { const a = audio(); if (a) SOUNDS[name](a); } catch (e) { /* som é opcional */ }
}
