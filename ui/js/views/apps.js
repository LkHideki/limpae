// Aplicativos (desinstalador): lista + painel com restos (leftovers) e confirmação.
import { h, mount, mid } from '../dom.js';
import { icon, orb, groupIcon } from '../art.js';
import { api } from '../api.js';
import { store, selectedSize, bump } from '../store.js';
import { bytesParts, fmtBytes, plural } from '../format.js';
import { checkbox, confirmDialog, failuresSheet, segmented } from '../ui.js';

const NAME_MATCH = 'Correspondência pelo nome';
const queue = [];
let active = 0;

function setIcon(box, url) {
  if (typeof url === 'string' && url.startsWith('data:image/')) mount(box, h('img', { src: url, alt: '' }));
}
function pump() {
  while (active < 3 && queue.length) {
    const [app, box] = queue.shift();
    active++;
    api.icon(app.id).then((u) => { store.icons.set(app.id, u); if (u && box.isConnected) setIcon(box, u); })
      .catch(() => store.icons.set(app.id, null)).finally(() => { active--; pump(); });
  }
}
function lazyIcon(app, box) {
  if (store.icons.has(app.id)) { setIcon(box, store.icons.get(app.id)); return; }
  queue.push([app, box]); pump();
}

export function enter(ctx) {
  const U = store.appsUi || (store.appsUi = { q: '', sort: 'size', sel: null, lo: new Map(), done: null });
  ctx.reserveDock(false);
  ctx.setDock(null);
  queue.length = 0;
  const left = h('div', { class: 'apps-left' });
  const right = h('div', { class: 'apps-right', dataset: { mod: 'apps' } });
  const subtitle = h('p', null, ' ');
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); lazyIcon(e.target._app, e.target); } }), { rootMargin: '120px' });
  ctx.onCleanup(() => io.disconnect());
  let listEl;

  mount(ctx.root, h('div', { class: 'col enter' },
    h('div', { class: 'rv-head', style: 'margin-bottom:14px' }, h('div', { class: 'rv-title' }, h('h2', null, 'Aplicativos'), subtitle)),
    h('div', { class: 'apps' }, left, right)));

  const iconBox = (a, observe) => {
    const b = h('div', { class: 'app-ic' }, icon('apps', 18));
    b._app = a;
    if (observe) io.observe(b); else lazyIcon(a, b);
    return b;
  };

  // ---------- lista ----------
  function renderList() {
    const apps = store.apps || [];
    const q = U.q.trim().toLowerCase();
    const list = apps.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.bundleId || '').toLowerCase().includes(q))
      .sort(U.sort === 'size' ? (a, b) => b.size - a.size : (a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
    subtitle.textContent = `${plural(apps.length, 'app', 'apps')} · ${fmtBytes(apps.reduce((x, a) => x + a.size, 0))}`;
    const rows = list.map((a) => h('button', { class: 'app-row', type: 'button', 'aria-current': String(U.sel === a.id), onClick: () => select(a.id) },
      iconBox(a, true),
      h('div', { class: 'app-main' }, h('b', null, h('span', { title: a.name }, a.name), a.running ? h('span', { class: 'badge info' }, 'Em execução') : null), h('small', null, a.version ? `Versão ${a.version}` : a.bundleId || '')),
      h('span', { class: 'app-size' }, fmtBytes(a.size))));
    mount(listEl, rows.length ? rows : h('div', { class: 'rv-empty' }, q ? 'Nenhum aplicativo corresponde à busca.' : 'Nenhum aplicativo encontrado.'));
  }

  function buildLeft() {
    listEl = h('div', { class: 'apps-list' });
    const search = h('label', { class: 'search' }, icon('search', 16),
      h('input', { type: 'search', placeholder: 'Buscar aplicativos', 'aria-label': 'Buscar aplicativos', value: U.q, spellcheck: 'false', onInput: (e) => { U.q = e.target.value; renderList(); } }));
    mount(left, h('div', { class: 'apps-bar' }, search, segmented([{ value: 'size', label: 'Tamanho' }, { value: 'name', label: 'Nome' }], U.sort, (v) => { U.sort = v; renderList(); }, 'Ordenar por')), listEl);
    renderList();
  }

  async function loadApps() {
    ctx.setBusy(true);
    const ticker = h('div', { class: 'ticker', style: 'margin:0' });
    mount(left, h('div', { class: 'ap-empty enter' }, h('span', { class: 'spin' }), h('div', null, 'Listando aplicativos…'), ticker));
    ctx.onProgress((p) => { if (p.task === 'apps') ticker.textContent = p.path || ''; });
    try { store.apps = await api.apps(); } catch (e) { store.apps = null; }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (store.apps) buildLeft();
    else mount(left, h('div', { class: 'ap-empty' }, h('div', null, 'Não foi possível listar os aplicativos.'), h('button', { class: 'btn', type: 'button', onClick: loadApps }, 'Tentar de novo')));
  }

  // ---------- painel ----------
  const renderEmpty = () => mount(right, h('div', { class: 'ap-empty enter' }, orb('apps', 120), h('div', null, 'Selecione um aplicativo para ver o que será removido junto com ele.')));

  function select(id) {
    U.sel = id; U.done = null;
    renderList();
    renderPane();
  }

  function renderDone() {
    const d = U.done;
    mount(right, h('div', { class: 'ap-done enter' }, orb('apps', 96, 'check'),
      h('div', { class: 'big' }, bytesParts(d.freed).value, h('small', null, bytesParts(d.freed).unit)),
      h('div', { class: 'big-cap', style: 'font-size:15px' }, 'movidos para o Lixo'),
      h('div', { class: 'sub', style: 'font-size:13px' }, `${d.name} foi desinstalado.`),
      h('button', { class: 'btn sm', type: 'button', style: 'margin-top:12px', onClick: () => { U.done = null; renderEmpty(); } }, 'Fechar')));
  }

  async function renderPane() {
    if (U.done) return renderDone();
    const app = (store.apps || []).find((a) => a.id === U.sel);
    if (!app) return renderEmpty();
    const head = h('div', { class: 'ap-head' }, iconBox(app, false),
      h('div', { style: 'min-width:0;flex:1' }, h('b', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, app.name), h('small', null, [app.version && `Versão ${app.version}`, fmtBytes(app.size)].filter(Boolean).join(' · '))),
      app.running ? h('span', { class: 'badge info' }, 'Em execução') : null);
    let lo = U.lo.get(app.id);
    if (!lo) {
      lo = { loading: true };
      U.lo.set(app.id, lo);
      mount(right, head, h('div', { class: 'ap-body' }, h('div', { class: 'ap-loading' }, h('span', { class: 'spin' }), 'Procurando restos…')));
      try {
        const r = await api.leftovers(app.id);
        for (const g of r.groups) for (const i of g.items) if (i.note === NAME_MATCH) i.selected = false;
        lo = { result: r, sel: new Set(r.groups.flatMap((g) => g.items.filter((i) => i.selected).map((i) => i.id))) };
      } catch (e) { U.lo.delete(app.id); lo = { result: { groups: [], total: 0 }, sel: new Set(), failed: true }; }
      if (!lo.failed) U.lo.set(app.id, lo);
      if (U.sel !== app.id || !ctx.alive) return;
    } else if (lo.loading) { mount(right, head, h('div', { class: 'ap-body' }, h('div', { class: 'ap-loading' }, h('span', { class: 'spin' }), 'Procurando restos…'))); return; }

    const totalEl = h('b');
    const btn = h('button', { class: 'btn primary', type: 'button', disabled: app.running, onClick: () => uninstall(app, lo) }, icon('trash', 16), 'Desinstalar');
    const updateTotal = () => { totalEl.textContent = fmtBytes(app.size + selectedSize(lo.result, lo.sel).bytes); };
    const body = h('div', { class: 'ap-body enter' });
    const appRow = checkbox('on', () => {}, app.name);
    appRow.disabled = true; appRow.style.opacity = '.7';
    body.append(h('div', { class: 'ap-sec' }, 'Aplicativo'),
      h('div', { class: 'lo-row', style: 'cursor:default' }, appRow, h('div', { class: 'rv-ic' }, icon('apps', 16)), h('div', { class: 'rv-main' }, h('div', { class: 'rv-name' }, h('span', null, app.name)), h('div', { class: 'rv-meta' }, mid(app.path, 20))), h('span', { class: 'rv-size' }, fmtBytes(app.size))));
    if (!lo.result.groups.length) body.append(h('div', { class: 'ap-sec' }, 'Restos'), h('div', { class: 'rv-empty', style: 'min-height:90px' }, lo.failed ? 'Não foi possível procurar os restos.' : 'Nenhum resto encontrado.'));
    for (const g of lo.result.groups) {
      body.append(h('div', { class: 'ap-sec' }, g.title));
      for (const it of g.items) {
        const cb = checkbox(lo.sel.has(it.id) ? 'on' : 'off', () => toggle(), `Selecionar ${it.name}`);
        const toggle = () => { lo.sel.has(it.id) ? lo.sel.delete(it.id) : lo.sel.add(it.id); cb.set(lo.sel.has(it.id) ? 'on' : 'off'); updateTotal(); };
        body.append(h('div', { class: 'lo-row', onClick: toggle }, cb, h('div', { class: 'rv-ic' }, icon(groupIcon(g.id), 16)),
          h('div', { class: 'rv-main' }, h('div', { class: 'rv-name' }, h('span', { title: it.name }, it.name), it.note ? h('span', { class: 'badge' }, it.note) : null), h('div', { class: 'rv-meta' }, mid(it.path, 20))),
          h('span', { class: 'rv-size' }, fmtBytes(it.size))));
      }
    }
    updateTotal();
    mount(right, head, body, h('div', { class: 'ap-foot' }, h('div', { class: 'ap-total' }, 'Total a remover', totalEl), app.running ? h('div', { class: 'ap-hint' }, 'Feche o app para desinstalar') : null, btn));
  }

  async function uninstall(app, lo) {
    const { bytes } = selectedSize(lo.result, lo.sel);
    const ok = await confirmDialog({
      title: `Desinstalar ${app.name}?`,
      body: [h('strong', null, 'O app e os itens selecionados vão para o Lixo'), `. São ${fmtBytes(app.size + bytes)} no total (${plural(lo.sel.size, 'resto', 'restos')} + o aplicativo). Você pode restaurá-los de lá até esvaziar a Lixeira.`],
      confirm: 'Desinstalar', glyph: 'trash', mod: 'apps',
    });
    if (!ok) return;
    ctx.setBusy(true);
    mount(right, h('div', { class: 'ap-empty' }, h('span', { class: 'spin' }), h('div', null, `Desinstalando ${app.name}…`)));
    let res = null;
    try { res = await api.uninstall(app.id, [...lo.sel]); } catch (e) { /* toast já exibido */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (!res) return renderPane();
    const names = new Map([[app.id, { name: app.name, path: app.path }], ...lo.result.groups.flatMap((g) => g.items.map((i) => [i.id, i]))]);
    const failures = res.outcomes.filter((o) => !o.ok).map((o) => ({ name: (names.get(o.id) || {}).name || `Item ${o.id}`, path: (names.get(o.id) || {}).path, error: o.error }));
    const appFailed = res.outcomes.some((o) => !o.ok && o.id === app.id);
    bump(); store.trash = null;
    ctx.refreshDisk();
    if (!appFailed) {
      store.apps = store.apps.filter((a) => a.id !== app.id);
      U.lo.delete(app.id); U.sel = null; U.done = { name: app.name, freed: res.freed };
    } else U.lo.delete(app.id);
    renderList();
    renderPane();
    if (failures.length) failuresSheet(failures);
  }

  renderEmpty();
  if (store.apps) buildLeft(); else loadApps();
  if (U.sel && store.apps) renderPane();
}
