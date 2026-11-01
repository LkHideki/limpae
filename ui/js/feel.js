// Sound feedback for gestures (clicks, switches, menus, dialogs, toasts), via event delegation: no view needs to call play().
import { play, lastPlayedAt } from './sound.js';

const later = (fn) => setTimeout(fn, 0);

// The view changes state in the element's own handler, after capture: reads the already-settled result.
// If the element was recreated on render, infers from the previous state.
function afterCheckbox(el, prev) {
  later(() => {
    const st = el.isConnected ? el.dataset.state : (prev === 'on' ? 'off' : 'on');
    play(st === 'on' ? 'tick' : 'untick');
  });
}
function afterSwitch(el, prev) {
  const t0 = performance.now();
  later(() => {
    if (lastPlayedAt() >= t0) return; // the view already responded (e.g. confirmation when turning sounds on)
    const on = el.isConnected ? el.getAttribute('aria-checked') === 'true' : prev !== 'true';
    play(on ? 'switch-on' : 'switch-off');
  });
}
// Primary button: only plays if the view played nothing right after the click (scans already have 'start').
function afterPrimary() {
  const t0 = performance.now();
  later(() => { if (lastPlayedAt() < t0) play('pop'); });
}
// Menu opens synchronously on click/context; checks whether a new one appeared.
function afterMenuOpener() {
  const before = document.querySelector('.ctx-menu');
  later(() => { const now = document.querySelector('.ctx-menu'); if (now && now !== before) play('menu'); });
}

document.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  const cb = el.closest('.cb');
  if (cb) return afterCheckbox(cb, cb.dataset.state);
  const sw = el.closest('.switch');
  if (sw) return afterSwitch(sw, sw.getAttribute('aria-checked'));
  const nav = el.closest('.nav-item');
  if (nav) { if (nav.getAttribute('aria-current') !== 'page') play('nav'); return; }
  if (el.closest('.ctx-item:not(:disabled), .fm-menu button:not(:disabled)')) return play('menu');
  const opener = el.closest('[aria-haspopup="menu"]');
  if (opener) return afterMenuOpener();
  const sel = el.closest('.chip, .seg button');
  if (sel) { if (sel.getAttribute('aria-pressed') !== 'true') play('tick'); return; }
  // Dialog buttons get the close sound.
  if (el.closest('.btn.primary, .go') && !el.closest('.modal')) afterPrimary();
}, true);

document.addEventListener('contextmenu', afterMenuOpener, true);

// Dialogs: open/close (the 'out' class marks closing, before the node is removed).
const modalRoot = document.getElementById('modal-root');
if (modalRoot) {
  const closed = new WeakSet();
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList.contains('modal-back')) play(n.querySelector('.modal.danger') ? 'warn' : 'open');
        }
      } else if (m.target.classList.contains('modal-back') && m.target.classList.contains('out') && !closed.has(m.target)) {
        closed.add(m.target); play('close');
      }
    }
  }).observe(modalRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

// Toasts: success → ok; error → err (the limiter stays silent if the view already played 'error').
const toastRoot = document.getElementById('toast-root');
if (toastRoot) {
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && n.classList.contains('toast')) play(n.classList.contains('ok') ? 'ok' : 'err');
    }
  }).observe(toastRoot, { childList: true });
}
