// Feedback sonoro das ações principais, sintetizado com WebAudio (sem arquivos de áudio, nada de rede).
// Cadeia: vozes → (seco + reverb gerado) → compressor → saída. Sinos com parciais inarmônicos soam como vidro.
let ac = null, bus = null, enabled = true;

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
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  return ac;
}

function env(a, g, s, peak, attack, dur) {
  g.gain.setValueAtTime(0.0001, s);
  g.gain.exponentialRampToValueAtTime(peak, s + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
}

// Sino de vidro: parciais 1 / 2,76 / 5,4 / 8,9 com decaimentos cada vez mais curtos.
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

// Sopro de ar filtrado que atravessa o estéreo; `up` sobe o filtro (limpeza), senão desce.
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
  // Início da análise: sopro suave que sobe e um toque de vidro.
  start: (a) => { whoosh(a, 0, { dur: 0.55, gain: 0.035, from: -0.3, to: 0.3 }); tone(a, 784, 0.05, { f2: 1175, dur: 0.45, gain: 0.03 }); bell(a, 1568, 0.32, { gain: 0.035, dur: 0.9 }); },
  // Resultados prontos: arpejo de três sinos.
  found: (a) => { bell(a, 1047, 0, { gain: 0.07, pan: -0.25 }); bell(a, 1319, 0.08, { gain: 0.06 }); bell(a, 1568, 0.16, { gain: 0.06, pan: 0.25, dur: 1.4 }); },
  // Limpeza concluída: varrida estéreo + arpejo ascendente cintilante.
  clean: (a) => {
    whoosh(a, 0, { dur: 0.75, gain: 0.08 });
    [1047, 1319, 1568, 2093, 2637].forEach((f, i) => bell(a, f, 0.34 + i * 0.065, { gain: 0.055 - i * 0.006, pan: -0.5 + i * 0.25, dur: 1.2 }));
    bell(a, 3136, 0.78, { gain: 0.025, dur: 1.6 });
  },
  // Parar: dois tons descendentes, abafados.
  stop: (a) => { tone(a, 784, 0, { dur: 0.18, type: 'triangle', gain: 0.05, lp: 2400 }); tone(a, 523, 0.12, { dur: 0.32, type: 'triangle', gain: 0.05, lp: 2000 }); },
  // Erro: batida grave e curta, sem susto.
  error: (a) => { tone(a, 233, 0, { dur: 0.16, type: 'triangle', gain: 0.07, lp: 900 }); tone(a, 175, 0.13, { dur: 0.3, type: 'triangle', gain: 0.07, lp: 800 }); },
};

export function play(name) {
  if (!enabled || !SOUNDS[name]) return;
  try { const a = audio(); if (a) SOUNDS[name](a); } catch (e) { /* som é opcional */ }
}
