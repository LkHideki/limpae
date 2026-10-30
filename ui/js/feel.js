// Feedback sonoro dos gestos (cliques, chaves, menus, diálogos, toasts), por delegação de eventos: nenhuma view precisa chamar play().
import { play, lastPlayedAt } from './sound.js';

const later = (fn) => setTimeout(fn, 0);

// A view altera o estado no handler do próprio elemento, depois da captura: lê o resultado já assentado.
// Se o elemento foi recriado no render, deduz pelo estado anterior.
function afterCheckbox(el, prev) {
  later(() => {
    const st = el.isConnected ? el.dataset.state : (prev === 'on' ? 'off' : 'on');
    play(st === 'on' ? 'tick' : 'untick');
  });
}
function afterSwitch(el, prev) {
  const t0 = performance.now();
  later(() => {
    if (lastPlayedAt() >= t0) return; // a view já respondeu (ex.: confirmação ao ligar os sons)
    const on = el.isConnected ? el.getAttribute('aria-checked') === 'true' : prev !== 'true';
    play(on ? 'switch-on' : 'switch-off');
  });
}
// Botão primário: só toca se a view não tocou nada logo após o clique (análises já têm 'start').
function afterPrimary() {
  const t0 = performance.now();
  later(() => { if (lastPlayedAt() < t0) play('pop'); });
}
// Menu abre de forma síncrona no clique/contexto; confere se surgiu um novo.
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
  // Botões do diálogo ficam com o som de fechar.
  if (el.closest('.btn.primary, .go') && !el.closest('.modal')) afterPrimary();
}, true);

document.addEventListener('contextmenu', afterMenuOpener, true);

// Diálogos: abre/fecha (a classe 'out' marca o fechamento, antes de o nó sair).
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

// Toasts: sucesso → ok; erro → err (o limitador silencia se a view já tocou 'error').
const toastRoot = document.getElementById('toast-root');
if (toastRoot) {
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && n.classList.contains('toast')) play(n.classList.contains('ok') ? 'ok' : 'err');
    }
  }).observe(toastRoot, { childList: true });
}
