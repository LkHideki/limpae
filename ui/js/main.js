// Shell: sidebar, rodapé de disco, roteador e contexto entregue às views.
import { h, mount, clear } from './dom.js';
import { icon, MODS } from './art.js';
import { api, onProgress, setNotifier } from './api.js';
import { store, bump } from './store.js';
import { fmtBytes } from './format.js';
import { createGo, toast } from './ui.js';
import * as smart from './views/smartcare.js';
import * as clean from './views/cleanup.js';
import * as trash from './views/trash.js';
import * as apps from './views/apps.js';
import * as files from './views/files.js';

const VIEWS = { smart, clean, trash, apps, files };
const view = document.getElementById('view');
const go = createGo(document.getElementById('dock'));
const navEl = document.getElementById('nav');
const foot = document.getElementById('sb-foot');
let current = null, cleanups = [], alive = false;
let fdaDismissed = false;
try { fdaDismissed = localStorage.getItem('limpaemeo.fda.dismissed') === '1'; } catch (e) { /* storage indisponível */ }

setNotifier((msg) => toast(msg));
window.addEventListener('unhandledrejection', (e) => { if (!(e.reason && e.reason.reported)) toast(String((e.reason && e.reason.message) || e.reason || 'Erro inesperado')); });

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
  refreshDisk,
};

function navigate(id, force = false) {
  if (!VIEWS[id] || (store.busy && !force && id !== current)) return;
  if (store.busy && id !== current && !force) return;
  cleanups.forEach((f) => { try { f(); } catch (e) { /* ignora */ } });
  cleanups = [];
  alive = false;
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
  mount(navEl, MODS.map((m) => h('button', { class: 'nav-item', type: 'button', dataset: { id: m.id }, 'aria-current': 'false', onClick: () => navigate(m.id) },
    h('span', { class: 'nav-chip', dataset: { mod: m.id } }, icon(m.glyph, 16)), m.label)));
}

function renderFoot() {
  const d = store.disk;
  const kids = [];
  if (d) {
    const pctUsed = d.total ? Math.min(100, (d.used / d.total) * 100) : 0;
    kids.push(h('div', { class: 'disk', title: `${fmtBytes(d.used)} usados` },
      h('div', { class: 'disk-bar', role: 'img', 'aria-label': `${Math.round(pctUsed)}% do disco em uso` }, h('i', { style: `width:${pctUsed}%` })),
      h('div', { class: 'disk-txt' }, h('b', null, fmtBytes(d.free)), ' livres de ', fmtBytes(d.total))));
    if (d.fda === false && !fdaDismissed) {
      kids.push(h('div', { class: 'fda-banner' },
        h('b', null, 'Acesso Total ao Disco'), 'Conceda para uma análise completa, incluindo a Lixeira.',
        h('div', null, h('button', { class: 'link', type: 'button', onClick: () => api.openFda().catch(() => {}) }, 'Abrir Ajustes')),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Dispensar aviso', onClick: () => { fdaDismissed = true; try { localStorage.setItem('limpaemeo.fda.dismissed', '1'); } catch (e) { /* ignora */ } renderFoot(); } }, icon('x', 14))));
    }
  }
  mount(foot, kids);
}

async function refreshDisk() {
  try { store.disk = await api.disk(); } catch (e) { /* sem info de disco */ }
  renderFoot();
}

buildNav();
refreshDisk();
navigate('smart');
