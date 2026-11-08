// Shell: sidebar, disk footer, router and the context handed to the views.
import { h, mount, clear } from './dom.js';
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
import * as cloud from './views/cloud.js';
import * as activity from './views/activity.js';
import * as tools from './views/tools.js';
import * as settings from './views/settings.js';
import { setSoundEnabled } from './sound.js';
import './feel.js';
import './motion.js';
import { applyLangSetting, onLang, t, tn, tr } from './i18n.js';
import { restoreBatches } from './undo.js';

const VIEWS = { smart, clean, trash, protect, perf, apps, files, lens, cloud, tools, activity, settings };
const view = document.getElementById('view');
const go = createGo(document.getElementById('dock'));
const navEl = document.getElementById('nav');
const foot = document.getElementById('sb-foot');
let current = null, cleanups = [], alive = false;
let backFn = null; // "Back" of the manager mounted right now (Esc and ⌘[ call the same one)
let fdaDismissed = false;
try { fdaDismissed = localStorage.getItem('limpae.fda.dismissed') === '1'; } catch (e) { /* storage unavailable */ }

setNotifier((msg) => toast(tr(msg)));
setUndoNotifier((batches, n) => toast(tn(n, '{n} item movido para o Lixo', '{n} itens movidos para o Lixo'), 'ok', { label: t('Desfazer'), onClick: () => restoreBatches(batches) }));
window.addEventListener('unhandledrejection', (e) => { if (!(e.reason && e.reason.reported)) toast(tr(String((e.reason && e.reason.message) || e.reason || t('Erro inesperado')))); });

function setBusy(b) {
  store.busy = b;
  document.body.classList.toggle('locked', b);
}

const ctx = {
  root: view, store, bump,
  get alive() { return alive; },
  nav: (id) => navigate(id, true),
  setBusy,
  setDock: (cfg) => { if (alive) go.set(cfg); },
  reserveDock: (b) => view.classList.toggle('has-dock', b),
  onProgress: (cb) => { cleanups.push(onProgress(cb)); },
  onCleanup: (fn) => { cleanups.push(fn); },
  // Registers (or clears, with null) the current screen's "Back" action; only managers register.
  onBack: (fn) => { backFn = typeof fn === 'function' ? fn : null; },
  refreshDisk,
};

function navigate(id, force = false) {
  if (!VIEWS[id] || (store.busy && !force && id !== current)) return;
  if (store.busy && id !== current && !force) return;
  cleanups.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
  cleanups = [];
  alive = false;
  backFn = null;
  setBusy(false);
  go.set(null);
  current = id;
  document.body.dataset.mod = id;
  navEl.querySelectorAll('.nav-item').forEach((b) => b.setAttribute('aria-current', b.dataset.id === id ? 'page' : 'false'));
  clear(view);
  view.className = 'view';
  alive = true;
  VIEWS[id].enter(ctx);
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
        h('div', null, h('button', { class: 'link', type: 'button', onClick: () => api.openFda().catch(() => {}) }, t('Abrir Ajustes'))),
        h('button', { class: 'x', type: 'button', 'aria-label': t('Dispensar aviso'), onClick: () => { fdaDismissed = true; try { localStorage.setItem('limpae.fda.dismissed', '1'); } catch (e) { /* ignore */ } renderFoot(); } }, icon('x', 14))));
    }
  }
  mount(foot, kids);
}

async function refreshDisk() {
  try { store.disk = await api.disk(); } catch (e) { /* no disk info */ }
  renderFoot();
}

// Request from the menu bar menu ("Sweep…", "Empty Trash…", "Settings…"). Respects the
// in-progress operation lock: without `force`, a cleanup or scan is never interrupted by a click there.
try {
  Promise.resolve(window.__TAURI__.event.listen('navigate', (e) => navigate(String(e.payload)))).catch(() => {});
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
const syncIdle = () => document.body.classList.toggle('idle', document.hidden || !document.hasFocus());
window.addEventListener('blur', syncIdle);
window.addEventListener('focus', syncIdle);
document.addEventListener('visibilitychange', syncIdle);
syncIdle();

// Language switch in Settings: rebuilds the menu, footer and current screen in the new language.
onLang(() => { buildNav(); renderFoot(); if (current) navigate(current, true); });

// The language must be set before the first paint (the default is English; reading the settings is local and fast).
api.settings().catch(() => null).then((st) => {
  if (st) { store.settings = st; setSoundEnabled(st.sounds); }
  applyLangSetting(st && st.language);
  buildNav();
  refreshDisk();
  navigate('smart');
});
