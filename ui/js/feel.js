// Sound feedback for gestures (clicks, switches, menus, dialogs, toasts), via event delegation: no view needs to call play().
import { play, lastPlayedAt, warm } from './sound.js';

const later = (fn) => setTimeout(fn, 0);
// Rows/cards whose click (outside their buttons) toggles the selection; each has its checkbox as a direct child.
const ROWS = '.pf-row, .rv-item, .fm-row, .lo-row, .am-row, .ln-row:not(.other), .fm-img, .pr-row.pick'; // i18n-ignore: CSS selector

// The view changes state in the element's own handler, after capture: reads the already-settled result.
// If the element was recreated on render, infers from the previous state.
function afterCheckbox(el, prev) {
  const t0 = performance.now();
  later(() => {
    if (lastPlayedAt() >= t0) return; // the view already responded (e.g. the chime when turning sounds on)
    if (el.isConnected && el.dataset.state === prev) return; // the click changed nothing (e.g. ignored while busy)
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
// Elements updated in place (Space Lens rows and bubbles): plays only if the 'sel' class actually changed, so a
// protected item, or Enter that opened a folder instead, stays silent.
function afterSel(el) {
  const prev = el.classList.contains('sel');
  later(() => { if (el.isConnected && el.classList.contains('sel') !== prev) play(prev ? 'untick' : 'tick'); });
}
// Primary button: only plays if the view played nothing right after the click (scans already have 'start').
function afterPrimary() {
  const t0 = performance.now();
  later(() => { if (lastPlayedAt() < t0) play('pop'); });
}
// Context-menu item: a "Select/Deselect" item sounds like the checkbox it toggles (data-selects = the resulting state).
// Any other item gets the menu tick only if its outcome (e.g. the "ignored" toast, after the IPC call) stayed silent.
function afterMenuItem(item) {
  const to = item.dataset.selects;
  if (to) return play(to === 'on' ? 'tick' : 'untick');
  const t0 = performance.now();
  setTimeout(() => { if (lastPlayedAt() < t0) play('menu'); }, 150);
}
// Toggle buttons (aria-pressed, e.g. the favorite star): tick/untick from the state after the click.
function afterPressed(el) {
  const prev = el.getAttribute('aria-pressed') === 'true';
  const t0 = performance.now();
  later(() => {
    if (lastPlayedAt() >= t0) return;
    const on = el.isConnected ? el.getAttribute('aria-pressed') === 'true' : !prev;
    if (on !== prev) play(on ? 'tick' : 'untick');
  });
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
  // Rows and cards that toggle their selection when clicked outside their buttons: same sound as the checkbox inside.
  // The second click of a double click in Space Lens opens the folder (and undoes the first click's check).
  if (e.detail > 1 && el.closest('.ln-row, .bub')) return;
  const bub = el.closest('.bub:not(.k-other)');
  if (bub) return afterSel(bub);
  const row = el.closest(ROWS);
  const rowCb = row && !el.closest('button, a, input') ? row.querySelector(':scope > .cb') : null;
  if (rowCb && !rowCb.disabled) return afterCheckbox(rowCb, rowCb.dataset.state);
  const sw = el.closest('.switch');
  if (sw) return afterSwitch(sw, sw.getAttribute('aria-checked'));
  const nav = el.closest('.nav-item');
  // Locked (a scan or removal is running): navigate() refuses, so the whoosh would answer nothing.
  if (nav) { if (nav.getAttribute('aria-current') !== 'page' && !document.body.classList.contains('locked')) play('nav'); return; }
  const item = el.closest('.ctx-item:not(:disabled), .fm-menu button:not(:disabled)');
  if (item) return afterMenuItem(item);
  const opener = el.closest('[aria-haspopup="menu"]');
  if (opener) return afterMenuOpener();
  const sel = el.closest('.chip, .seg button, [role="radio"]');
  if (sel) { if (sel.getAttribute('aria-pressed') !== 'true' && sel.getAttribute('aria-checked') !== 'true') play('tick'); return; }
  const pressed = el.closest('button[aria-pressed]');
  if (pressed) return afterPressed(pressed);
  // Dialog buttons get the close sound.
  if (el.closest('.btn.primary, .go') && !el.closest('.modal')) afterPrimary();
}, true);

document.addEventListener('contextmenu', afterMenuOpener, true);

// Presses that usually answer with a sound wake the audio device on the way down (see warm() in sound.js).
// Text fields are left out: typing in them plays nothing, so waking the device would only cycle it.
const SOUNDING = 'button, a, input[type="checkbox"], input[type="radio"], .cb, .switch, .bub, [role="switch"], [role="checkbox"], [role="radio"], [aria-haspopup], ' + ROWS; // i18n-ignore: CSS selector
document.addEventListener('pointerdown', (e) => { if (e.target instanceof Element && e.target.closest(SOUNDING)) warm(); }, true);

// Keyboard toggles handled in keydown (no click event): Space/Enter on image cards and Space Lens rows/bubbles.
document.addEventListener('keydown', (e) => {
  if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  if (el.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable]')) return; // i18n-ignore: CSS selector
  warm();
  if (el.matches('.fm-img')) { const cb = el.querySelector(':scope > .cb'); if (cb) afterCheckbox(cb, cb.dataset.state); }
  else if (el.matches('.ln-row:not(.other), .bub:not(.k-other)')) afterSel(el);
}, true);

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

// Toasts: success → ok; error → err (the limiter stays silent if the view already played 'error'); info is silent.
const toastRoot = document.getElementById('toast-root');
if (toastRoot) {
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType !== 1 || !n.classList.contains('toast') || n.classList.contains('info')) continue;
      // The toast with an action is the Undo offer that follows a cleanup (ducked); a plain one, e.g. "restored", answers the user.
      play(n.classList.contains('ok') ? (n.classList.contains('has-act') ? 'ok-offer' : 'ok') : 'err');
    }
  }).observe(toastRoot, { childList: true });
}
