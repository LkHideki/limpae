// Shell: sidebar, disk footer, router and the context handed to the views.
import { h, mount, clear, keepFocus } from './dom.js';
import { icon, MODS } from './art.js';
import { api, onProgress, setNotifier, setUndoNotifier } from './api.js';
import { store, bump } from './store.js';
import { fmtBytes } from './format.js';
import { createGo, toast } from './ui.js';
import * as smart from './views/smartcare.js';
import * as clean from './views/cleanup.js';
import * as trash from './views/trash.js';
import * as apps from './views/apps.js';
import * as files from './views/files.js';
import * as protect from './views/protection.js';
import * as perf from './views/performance.js';
import * as lens from './views/lens.js';
import * as activity from './views/activity.js';
import * as tools from './views/tools.js';
import * as settings from './views/settings.js';
import { setSoundEnabled } from './sound.js';
import './feel.js';
import './motion.js';
import { applyLangSetting, onLang, t, tn, tr } from './i18n.js';
import { restoreBatches } from './undo.js';
import { maybeOnboard, noticeGrant, openSettings, relaunch, showGuide, visitedSettings } from './fda.js';

const VIEWS = { smart, clean, trash, protect, perf, apps, files, lens, tools, activity, settings };
const view = document.getElementById('view');
const go = createGo(document.getElementById('dock'));
const navEl = document.getElementById('nav');
const foot = document.getElementById('sb-foot');
let current = null, cleanups = [], navSeq = 0;
let backFn = null; // "Back" of the manager mounted right now (Esc and ⌘[ call the same one)
let reportedBusy = false;
let fdaDismissed = false;
try { fdaDismissed = localStorage.getItem('limpae.fda.dismissed') === '1'; } catch (e) { /* storage unavailable */ }

setNotifier((msg) => toast(tr(msg)));
// After an undo the files are back: cached Trash results and the free-space footer are stale. A Trash screen
// showing the old list is reopened (not during an operation).
setUndoNotifier((batches, n) => toast(tn(n, '{n} item movido para o Lixo', '{n} itens movidos para o Lixo'), 'ok', {
  label: t('Desfazer'),
  onClick: () => restoreBatches(batches).then((ok) => {
    if (!ok) return;
    bump(); store.trash = null; refreshDisk();
    if (current === 'trash' && !store.busy) navigate('trash', true);
  }),
}));
window.addEventListener('unhandledrejection', (e) => { if (!(e.reason && e.reason.reported)) toast(tr(String((e.reason && e.reason.message) || e.reason || t('Erro inesperado')))); });

function setBusy(b) {
  store.busy = b;
  document.body.classList.toggle('locked', b);
  // The backend frees the webview after the window stays hidden, but never during an operation.
  if (b !== reportedBusy) {
    reportedBusy = b;
    try { Promise.resolve(window.__TAURI__.core.invoke('ui_busy', { busy: b })).catch(() => {}); } catch (e) { /* browser preview */ }
  }
}

// One ctx per screen entry. Work a screen started may finish after the user moved on: `alive` turns false for it and
// whatever it still does to the shared chrome (dock, lock, back action, cleanups) is ignored, so it cannot act on the
// screen that is showing now.
function makeCtx(seq) {
  const live = () => seq === navSeq;
  return {
    root: view, store, bump,
    get alive() { return live(); },
    nav: (id) => { if (live()) navigate(id, true); },
    setBusy: (b) => { if (live()) setBusy(b); },
    setDock: (cfg) => { if (live()) go.set(cfg); },
    reserveDock: (b) => { if (live()) view.classList.toggle('has-dock', b); },
    onProgress: (cb) => { const off = onProgress(cb); if (live()) cleanups.push(off); else off(); },
    onCleanup: (fn) => { if (live()) cleanups.push(fn); else fn(); },
    // Registers (or clears, with null) the current screen's "Back" action; only managers register.
    onBack: (fn) => { if (live()) backFn = typeof fn === 'function' ? fn : null; },
    refreshDisk,
  };
}

function navigate(id, force = false) {
  if (!VIEWS[id] || (store.busy && !force && id !== current)) return;
  if (store.busy && id !== current && !force) return;
  cleanups.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
  cleanups = [];
  const seq = ++navSeq;
  backFn = null;
  setBusy(false);
  go.set(null);
  current = id;
  document.body.dataset.mod = id;
  navEl.querySelectorAll('.nav-item').forEach((b) => b.setAttribute('aria-current', b.dataset.id === id ? 'page' : 'false'));
  // Focus inside the old screen dies with it (keyboard navigation from a tile, a link, the language switch):
  // it moves to the new screen's heading, or the menu item, instead of falling back to <body>.
  const lostFocus = view.contains(document.activeElement);
  clear(view);
  view.className = 'view';
  VIEWS[id].enter(makeCtx(seq));
  if (lostFocus && (!document.activeElement || document.activeElement === document.body)) focusScreen(id);
}

function focusScreen(id) {
  const head = view.querySelector('h1, h2');
  const target = head || navEl.querySelector(`.nav-item[data-id="${id}"]`);
  if (!target) return;
  if (head && !head.hasAttribute('tabindex')) head.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

function buildNav() {
  navEl.setAttribute('aria-label', t('Módulos'));
  mount(navEl, MODS.map((m) => m.spacer ? h('div', { class: 'nav-spacer' }) : h('button', { class: 'nav-item', type: 'button', dataset: { id: m.id }, 'aria-current': 'false', onClick: () => navigate(m.id) },
    h('span', { class: 'nav-chip', dataset: { mod: m.id } }, icon(m.glyph, 16)), m.label())));
}

function renderFoot() {
  const d = store.disk;
  const kids = [];
  if (d) {
    const pctUsed = d.total ? Math.min(100, (d.used / d.total) * 100) : 0;
    kids.push(h('div', { class: 'disk', title: t('{size} usados', { size: fmtBytes(d.used) }) },
      h('div', { class: 'disk-bar', role: 'img', 'aria-label': t('{pct}% do disco em uso', { pct: Math.round(pctUsed) }) }, h('i', { style: `width:${pctUsed}%` })),
      h('div', { class: 'disk-txt' }, h('b', null, fmtBytes(d.free)), ' ', t('livres de {total}', { total: fmtBytes(d.total) }))));
    if (d.fda === false && !fdaDismissed) {
      kids.push(h('div', { class: 'fda-banner' },
        h('b', null, t('Acesso Total ao Disco')), h('span', { class: 'fda-desc' }, t('Conceda para uma análise completa, incluindo a Lixeira.')),
        h('div', { class: 'fda-acts' },
          h('button', { class: 'link', type: 'button', dataset: { fk: 'fda:guide' }, onClick: () => showGuide().then(() => { renderFoot(); const n = foot.querySelector('[data-fk="fda:guide"]'); if (n) n.focus(); }) }, t('Como conceder')),
          visitedSettings() ? h('button', { class: 'link', type: 'button', dataset: { fk: 'fda:relaunch' }, onClick: relaunch }, t('Reabrir o Limpae')) : null),
        h('button', { class: 'x', type: 'button', 'aria-label': t('Dispensar aviso'), onClick: () => { fdaDismissed = true; try { localStorage.setItem('limpae.fda.dismissed', '1'); } catch (e) { /* ignore */ } renderFoot(); const cur = navEl.querySelector('.nav-item[aria-current="page"]'); if (cur) cur.focus({ preventScroll: true }); } }, icon('x', 14))));
    }
  }
  // The banner is rebuilt on every update (guide closed, dismissed, window focus): keyboard focus returns by key.
  keepFocus(foot, () => mount(foot, kids));
}

async function refreshDisk() {
  const before = store.disk;
  try { store.disk = await api.disk(); } catch (e) { /* no disk info */ }
  renderFoot();
  return noticeGrant(before, store.disk);
}

// Coming back from System Settings: re-check access (and free space) so the grant shows up without a restart.
window.addEventListener('focus', () => { if (store.disk && store.disk.fda === false) refreshDisk(); });

// Request from the menu bar menu ("Sweep…", "Empty Trash…", "Settings…"). Respects the
// in-progress operation lock: without `force`, a cleanup or scan is never interrupted by a click there.
try {
  Promise.resolve(window.__TAURI__.event.listen('navigate', (e) => {
    // An open dialog (e.g. a removal confirm) belongs to the screen that opened it: switching under it would let the
    // confirm run its action inside another screen.
    if (document.querySelector('.modal-back:not(.out)')) return;
    navigate(String(e.payload));
  })).catch(() => {});
} catch (e) { /* no shell events (browser preview) */ }

// Esc (or ⌘[) leaves the open manager, like the top "Back". Does nothing with a menu, dialog or operation in progress,
// nor while the search has text (the first Esc clears the field).
document.addEventListener('keydown', (e) => {
  const esc = e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  const bracket = e.metaKey && !e.ctrlKey && !e.altKey && e.key === '[';
  if (!(esc || bracket) || e.defaultPrevented || !backFn || store.busy) return;
  if (document.querySelector('.modal-back:not(.out), .ctx-menu, .fm-menu:not([hidden])')) return;
  const tgt = e.target;
  if (esc && tgt instanceof HTMLInputElement && tgt.value) return;
  e.preventDefault();
  backFn();
});

// Pauses continuous animations when the window is not in use (see body.idle in the CSS).
const syncIdle = () => {
  document.body.classList.toggle('idle', document.hidden || !document.hasFocus());
  document.body.classList.toggle('hidden', document.hidden);
};
window.addEventListener('blur', syncIdle);
window.addEventListener('focus', syncIdle);
document.addEventListener('visibilitychange', syncIdle);
syncIdle();

// A window rebuilt by the backend (after it freed the webview) lands on the requested module via `#nav=<id>`; the live
// `navigate` event can't reach a UI that did not exist yet.
function bootModule() {
  const m = /^#nav=([a-z]+)$/.exec(location.hash);
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  return m && VIEWS[m[1]] ? m[1] : 'smart';
}

// Language switch in Settings: rebuilds the menu, footer and current screen in the new language.
onLang(() => { buildNav(); renderFoot(); if (current) navigate(current, true); });

// The window has a native sidebar material (config-driven, so a rebuilt window gets it too): the sidebar turns translucent.
api.sidebarVibrancy().then((on) => { if (on === true) document.documentElement.classList.add('vfx'); }, () => {});

// The language must be set before the first paint (the default is English; reading the settings is local and fast).
api.settings().catch(() => null).then((st) => {
  if (st) { store.settings = st; setSoundEnabled(st.sounds); }
  applyLangSetting(st && st.language);
  buildNav();
  refreshDisk().then(() => maybeOnboard(store.disk)).then(renderFoot);
  // The backend hands over a module requested while this UI was booting (menu click right after a rebuild).
  const hash = bootModule();
  let pending = null;
  try { pending = Promise.resolve(window.__TAURI__.core.invoke('ui_ready')).catch(() => null); } catch (e) { /* browser preview */ }
  Promise.resolve(pending).then((m) => navigate(typeof m === 'string' && VIEWS[m] ? m : hash));
});
