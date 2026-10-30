// Aplicativos: landing -> análise -> resultados (tiles) -> Gerenciador (Desinstalador / Atualizador / Restos) -> conclusão.
// A UI só envia ids. Apps, restos e instaladores vão para o Lixo; atualizações abrem a página do fornecedor.
import { play } from '../sound.js';
import { h, mount, mid, sleep } from '../dom.js';
import { icon, orb, groupIcon } from '../art.js';
import { api } from '../api.js';
import { store, selectedSize, selectedIds, pruneResult, bump } from '../store.js';
import { fmtBytes, plural } from '../format.js';
import { checkbox, confirmDialog, failuresSheet, stage, features, toast } from '../ui.js';
import { removeGroups, stopDock } from '../actions.js';

const NAME_MATCH = 'Correspondência pelo nome';
const UNUSED_DAYS = 180;
const DEFAULT_DIR = { size: 'desc', name: 'asc', last: 'desc' };
const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'always' });

// ---------- ícones sob demanda ----------
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

// ---------- estado (sobrevive à troca de módulo) ----------
function newState() {
  return {
    v: 2, phase: 'idle', over: null, meta: new Map(), appsRef: null,
    q: '', sort: 'size', dir: 'desc', pane: 'uninstaller', group: 'all',
    sel: new Set(), open: new Set(), lo: new Map(),
    upSel: new Set(), upFocus: null,
    leftSel: new Set(), instSel: new Set(), restGroup: 'leftovers',
    done: null,
  };
}

function lastText(sec) {
  if (!sec) return 'nunca aberto';
  const d = Date.now() / 1000 - sec;
  for (const [unit, size] of [['year', 31557600], ['month', 2629800], ['week', 604800], ['day', 86400]]) {
    if (d >= size) return 'aberto ' + rtf.format(-Math.floor(d / size), unit);
  }
  return 'aberto hoje';
}

const hostOf = (url) => { try { return new URL(url).host; } catch (e) { return ''; } };

// Ícone por tipo de resto (rótulo vindo do backend).
const KIND_ICON = {
  'Suporte do app': 'folder', Caches: 'box', 'Preferências': 'prefs', 'Preferências deste Mac': 'prefs', 'Contêiner do app': 'archive',
  'Contêiner compartilhado': 'apps', 'Scripts do app': 'code', 'Estado das janelas': 'restart', 'Armazenamento web': 'disk',
  Cookies: 'disk', 'Dados do WebKit': 'disk', Registros: 'log', 'Agente de inicialização': 'bolt',
};
const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

export function enter(ctx) {
  if (!store.appsUi || store.appsUi.v !== 2) store.appsUi = newState();
  const U = store.appsUi;
  if (['scan', 'busy'].includes(U.phase)) U.phase = 'idle';
  if (U.phase === 'manager' && !store.apps) U.phase = 'idle';
  if (U.phase === 'results' && (!U.over || !store.apps)) U.phase = 'idle';
  if (U.phase === 'done' && !U.done) U.phase = 'idle';
  queue.length = 0;
  const root = ctx.root;
  let cancelled = false;
  let M = null; // referências do Gerenciador montado

  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); lazyIcon(e.target._app, e.target); } }), { rootMargin: '120px' });
  ctx.onCleanup(() => io.disconnect());

  const apps = () => store.apps || [];
  const byId = () => new Map(apps().map((a) => [a.id, a]));
  const metaOf = (a) => U.meta.get(a.id) || {};
  const storeOf = (a) => metaOf(a).store || 'Outros';
  const vendorOf = (a) => metaOf(a).vendor || 'Outros';
  const isUnused = (a) => {
    if (a.running) return false;
    if (U.over) return U.over.unused.has(a.id);
    const t = metaOf(a).lastUsed;
    return !!t && Date.now() / 1000 - t > UNUSED_DAYS * 86400;
  };
  const updates = () => (U.over ? U.over.updates.filter((u) => byId().has(u.appId)) : []);
  const iconBox = (a, observe, cls = '') => {
    const b = h('div', { class: ('app-ic ' + cls).trim() }, icon('apps', 18));
    b._app = a;
    if (observe) io.observe(b); else lazyIcon(a, b);
    return b;
  };

  // ---------- dados ----------
  function resetData() {
    U.lo.clear(); U.sel.clear(); U.open.clear(); U.upSel.clear(); U.upFocus = null; U.meta = new Map(); U.over = null;
    U.group = 'all'; U.q = ''; U.appsRef = store.apps;
  }
  function applyMeta(list) {
    U.meta = new Map((list || []).map((m) => [m.appId, m]));
  }
  function applyOverview(ov) {
    U.over = { updates: ov.updates || [], unused: new Set(ov.unused || []), leftovers: ov.leftovers, installers: ov.installers };
    U.leftSel = selectedIds(ov.leftovers);
    U.instSel = selectedIds(ov.installers);
    U.upSel = new Set();
    U.upFocus = U.over.updates[0] ? U.over.updates[0].appId : null;
  }

  // ---------- roteamento ----------
  function render() {
    M = null;
    ctx.setDock(null);
    ctx.reserveDock(false);
    if (U.phase === 'results') return renderResults();
    if (U.phase === 'manager') return renderManager();
    if (U.phase === 'done') return renderDone();
    return renderIdle();
  }

  // ---------- landing ----------
  function renderIdle() {
    const st = stage('apps', 'apps', 260);
    mount(root, st.el);
    ctx.reserveDock(true);
    st.show(h('h1', { class: 'h1' }, 'Aplicativos'),
      h('p', { class: 'sub' }, 'Desinstale apps por completo, acompanhe atualizações e limpe o que sobrou deles.'),
      features('apps', [['trash', 'Desinstalação completa, com os restos'], ['refresh', 'Atualizações de apps fora da App Store'], ['clock', 'Apps que você não abre há meses']]),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: openDirect }, icon('apps', 15), 'Ver meus aplicativos')));
    ctx.setDock({ label: 'Analisar', mod: 'apps', onClick: scan });
  }

  function loadingScreen(title, sub) {
    const st = stage('apps', 'apps', 260);
    mount(root, st.el);
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, title), h('p', { class: 'sub' }, sub), ticker);
    ctx.onProgress((p) => { if (p.task === 'apps' || p.task === 'apps_overview') ticker.textContent = p.path || ''; });
    return st;
  }

  // Abre o Gerenciador sem a análise de atualizações/restos (só lista os apps).
  async function openDirect() {
    if (store.apps && U.appsRef === store.apps && U.meta.size) { U.phase = 'manager'; U.pane = 'uninstaller'; render(); return; }
    ctx.setBusy(true);
    ctx.reserveDock(false);
    ctx.setDock(null);
    loadingScreen('Listando aplicativos…', 'Isso pode levar alguns instantes.');
    let ok = false;
    try {
      store.apps = await api.apps();
      resetData();
      applyMeta(await api.appMeta().catch(() => []));
      ok = true;
    } catch (e) { /* erro já exibido em toast */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    U.phase = ok ? 'manager' : 'idle';
    U.pane = 'uninstaller';
    render();
  }

  // ---------- análise ----------
  async function scan() {
    cancelled = false;
    U.phase = 'scan';
    play('start');
    ctx.setBusy(true);
    ctx.reserveDock(true);
    loadingScreen('Analisando aplicativos…', 'Listando apps, procurando atualizações, restos e instaladores.');
    ctx.setDock({ label: 'Parar', busy: true, mod: 'apps', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'apps' }); api.cancel().catch(() => {}); } });
    let ok = false;
    try {
      store.apps = await api.apps();
      resetData();
      const ov = await api.appsOverview();
      const meta = await api.appMeta().catch(() => []);
      if (!cancelled) { applyOverview(ov); applyMeta(meta); ok = true; }
    } catch (e) { /* erro já exibido em toast */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    U.phase = ok ? 'results' : 'idle';
    if (ok) play('found');
    render();
  }

  // ---------- resultados (tiles) ----------
  function tile({ mod, glyph, title, sub, body, actions }) {
    return h('div', { class: 'ax-tile', dataset: { mod } },
      h('div', { class: 'ax-orb' }, orb(mod, 76, glyph)),
      h('div', { class: 'ax-t-title' }, title),
      sub ? h('div', { class: 'ax-t-sub' }, sub) : null,
      body || null,
      h('div', { class: 'ax-t-actions' }, actions));
  }

  const review = (pane, extra = {}) => () => { Object.assign(U, { phase: 'manager', pane, q: '' }, extra); render(); };

  function renderResults() {
    const n = apps().length;
    const ups = updates();
    const unusedN = apps().filter(isUnused).length;
    const left = U.over.leftovers, inst = U.over.installers;
    const leftSel = selectedSize(left, U.leftSel), instSel = selectedSize(inst, U.instSel);
    const empty = (txt) => h('div', { class: 'ax-t-ok' }, icon('check', 15), txt);

    const upIcons = ups.slice(0, 3).map((u) => byId().get(u.appId)).filter(Boolean);
    const tUpdates = ups.length
      ? tile({
        mod: 'apps', glyph: 'refresh', title: `${plural(ups.length, 'atualização disponível', 'atualizações disponíveis')}`,
        sub: 'Mantenha seus apps em dia com os recursos e correções mais recentes.',
        body: h('div', { class: 'ax-t-icons' }, upIcons.map((a) => iconBox(a, false, 'ax-ic'))),
        actions: [h('button', { class: 'btn sm', type: 'button', onClick: review('updater') }, 'Revisar'),
          h('button', { class: 'btn sm primary', type: 'button', onClick: () => openUpdates(ups.map((u) => u.appId)) }, 'Atualizar')],
      })
      : tile({ mod: 'apps', glyph: 'refresh', title: 'Apps em dia', sub: 'Nenhuma atualização encontrada nos apps que informam uma fonte.', body: empty('Tudo atualizado'), actions: [] });

    const tUnused = unusedN
      ? tile({
        mod: 'perf', glyph: 'clock', title: plural(unusedN, 'app não usado', 'apps não usados'),
        sub: 'Apps que você não abre há mais de 6 meses.',
        actions: [h('button', { class: 'btn sm primary', type: 'button', onClick: review('uninstaller', { group: 'unused' }) }, 'Revisar')],
      })
      : tile({ mod: 'perf', glyph: 'clock', title: 'Sem apps esquecidos', sub: 'Todos os apps foram usados nos últimos 6 meses.', body: empty('Nada a revisar'), actions: [] });

    const leftCount = left.groups.reduce((a, g) => a + g.items.length, 0);
    const tLeft = leftCount
      ? tile({
        mod: 'trash', glyph: 'folder', title: `${fmtBytes(left.total)} de restos de apps`,
        sub: `${plural(leftCount, 'item', 'itens')} de apps que não estão mais instalados. ${leftSel.count ? `${fmtBytes(leftSel.bytes)} vêm pré-selecionados.` : 'Nada vem pré-selecionado: podem guardar dados.'}`,
        actions: [h('button', { class: 'btn sm', type: 'button', onClick: review('leftovers', { restGroup: 'leftovers' }) }, 'Revisar'),
          h('button', { class: 'btn sm primary', type: 'button', disabled: !leftSel.count, onClick: () => removeResult('leftovers') }, 'Remover')],
      })
      : tile({ mod: 'trash', glyph: 'folder', title: 'Sem restos de apps', sub: 'Não há dados de apps já removidos.', body: empty('Tudo limpo'), actions: [] });

    const instCount = inst.groups.reduce((a, g) => a + g.items.length, 0);
    const tInst = instCount
      ? tile({
        mod: 'files', glyph: 'disk', title: `${fmtBytes(inst.total)} de instaladores`,
        sub: `${plural(instCount, 'arquivo', 'arquivos')} .dmg, .pkg ou .xip em Downloads e na Mesa, fáceis de baixar de novo.`,
        actions: [h('button', { class: 'btn sm', type: 'button', onClick: review('leftovers', { restGroup: 'installers' }) }, 'Revisar'),
          h('button', { class: 'btn sm primary', type: 'button', disabled: !instSel.count, onClick: () => removeResult('installers') }, 'Remover')],
      })
      : tile({ mod: 'files', glyph: 'disk', title: 'Sem instaladores', sub: 'Nenhum .dmg, .pkg ou .xip em Downloads ou na Mesa.', body: empty('Tudo limpo'), actions: [] });

    mount(root, h('div', { class: 'ax enter', dataset: { mod: 'apps' } },
      h('div', { class: 'ax-head' },
        h('h2', null, `Encontramos ${plural(n, 'app', 'apps')} no seu Mac.`),
        h('div', { class: 'ax-head-row' },
          h('button', { class: 'btn primary', type: 'button', onClick: review('uninstaller', { group: 'all' }) }, icon('apps', 15), 'Gerenciar meus aplicativos'),
          h('button', { class: 'btn ghost', type: 'button', onClick: () => { U.phase = 'idle'; render(); } }, icon('restart', 14), 'Analisar de novo'))),
      h('div', { class: 'ax-tiles' }, tUpdates, tUnused, tLeft, tInst)));
  }

  // ---------- atualizações (somente abre a página; nada é instalado) ----------
  async function openUpdates(ids) {
    if (!ids.length) return;
    if (ids.length > 3) {
      const ok = await confirmDialog({
        title: `Abrir ${plural(ids.length, 'página', 'páginas')} de atualização?`,
        body: [`Cada página abre no navegador padrão. `, h('strong', null, 'O Limpae não instala atualizações'), '; você conclui a instalação em cada app.'],
        confirm: 'Abrir', glyph: 'refresh', mod: 'apps',
      });
      if (!ok) return;
    }
    let opened = 0;
    for (const id of ids) {
      try { await api.openUpdate(id); opened++; } catch (e) { /* toast já exibido */ }
      await sleep(350);
    }
    if (opened && ctx.alive) toast(opened === 1 ? 'Abrindo a página da atualização.' : `Abrindo ${opened} páginas de atualização.`, 'ok');
  }

  // ---------- restos e instaladores: remover ----------
  async function removeResult(kind) {
    const res = kind === 'installers' ? U.over.installers : U.over.leftovers;
    const sel = kind === 'installers' ? U.instSel : U.leftSel;
    const { bytes, count } = selectedSize(res, sel);
    if (!count) return;
    const what = kind === 'installers' ? plural(count, 'instalador', 'instaladores') : plural(count, 'resto de app', 'restos de apps');
    const ok = await confirmDialog({
      title: `Remover ${fmtBytes(bytes)}?`,
      body: [h('strong', null, `${what} vão para o Lixo`), `. Você pode restaurá-${count === 1 ? 'lo' : 'los'} de lá até esvaziar a Lixeira.`],
      confirm: 'Remover', glyph: 'trash', mod: 'apps',
      permanentChoice: true, permanentDefault: !!(store.settings && store.settings.permanentDelete),
    });
    if (!ok) return;
    U.phase = 'busy';
    ctx.setBusy(true);
    const st = stage('apps', 'apps', 260);
    mount(root, st.el);
    st.busy(true);
    ctx.reserveDock(true);
    const groups = res.groups.filter((g) => g.items.some((i) => sel.has(i.id)));
    const rows = new Map(groups.map((g) => [g.id, h('div', { class: 'prog-row', dataset: { st: 'wait' } }, h('span', { class: 'nm', title: g.title }, g.title), h('span', { class: 'sz' }), h('span', { class: 'st' }))]));
    st.show(h('h1', { class: 'h1' }, 'Removendo…'), h('div', { class: 'group-list' }, [...rows.values()]));
    const sd = stopDock(ctx, 'apps');
    const r = await removeGroups(res, sel, (g, status, info) => {
      const row = rows.get(g.id);
      row.dataset.st = status;
      if (status === 'run') { mount(row.querySelector('.st'), h('span', { class: 'spin' })); return; }
      mount(row.querySelector('.st'), icon(status === 'done' ? 'check' : 'alert', 16));
      row.querySelector('.sz').textContent = fmtBytes(info.freed);
      sd.progress(info.done / info.total);
    }, { permanent: ok === 'permanent', stopped: sd.stopped });
    const pruned = pruneResult(res, r.okIds);
    if (kind === 'installers') { U.over.installers = pruned; r.okIds.forEach((id) => U.instSel.delete(id)); } else { U.over.leftovers = pruned; r.okIds.forEach((id) => U.leftSel.delete(id)); }
    bump(); store.trash = null;
    play(r.freed ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    U.done = { headline: plural(r.okIds.size, kind === 'installers' ? 'instalador removido' : 'resto de app removido', kind === 'installers' ? 'instaladores removidos' : 'restos de apps removidos'), freed: r.freed, failed: r.failures.length, permanent: ok === 'permanent', again: () => { U.pane = 'leftovers'; U.restGroup = kind; } };
    U.phase = 'done';
    render();
    if (r.failures.length) failuresSheet(r.failures);
  }

  // ---------- concluído ----------
  function renderDone() {
    const d = U.done;
    const st = stage('apps', 'check', 260);
    mount(root, st.el);
    ctx.reserveDock(false);
    const finish = () => { U.done = null; U.phase = U.over ? 'results' : 'idle'; render(); };
    const more = () => { const fn = d.again; U.done = null; U.phase = 'manager'; if (fn) fn(); render(); };
    st.show(h('h1', { class: 'h1' }, 'Pronto!'),
      h('div', { class: 'big-cap' }, d.headline),
      h('p', { class: 'sub' }, [d.permanent ? `${fmtBytes(d.freed)} apagados definitivamente.` : `${fmtBytes(d.freed)} movidos para o Lixo. Esvazie a Lixeira para liberar o espaço.`, d.failed ? ` ${plural(d.failed, 'item não foi removido', 'itens não foram removidos')}.` : ''].join('')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        h('button', { class: 'btn', type: 'button', onClick: more }, 'Gerenciar mais'),
        h('button', { class: 'btn primary', type: 'button', onClick: finish }, 'Concluir')));
  }

  // =====================================================================================================
  // Gerenciador de Aplicativos
  // =====================================================================================================
  const NAV = [['uninstaller', 'Desinstalador'], ['updater', 'Atualizador'], ['leftovers', 'Restos']];

  function renderManager() {
    M = {
      head: h('div', { class: 'am-head' }),
      left: h('nav', { class: 'am-left', 'aria-label': 'Seções' }),
      mid: h('div', { class: 'am-mid' }),
      main: h('div', { class: 'am-main' }),
      foot: h('div', { class: 'rv-foot' }),
    };
    mount(root, h('section', { class: 'am enter', dataset: { mod: 'apps' }, 'aria-label': 'Gerenciador de Aplicativos' },
      M.head, h('div', { class: 'am-body' }, M.left, M.mid, M.main), M.foot));
    paintAll();
  }

  function paintAll() {
    if (!M) return;
    paintHead(); paintLeft(); paintMid(); paintMain(); paintFoot();
  }

  const goBack = () => { U.phase = U.over ? 'results' : 'idle'; render(); };

  function paintHead() {
    const search = h('label', { class: 'search' }, icon('search', 16),
      h('input', { type: 'search', placeholder: 'Buscar', 'aria-label': 'Buscar', value: U.q, spellcheck: 'false', onInput: (e) => { U.q = e.target.value; paintMid(); paintMain(); } }));
    let sort = null;
    if (U.pane === 'uninstaller') {
      const dirBtn = h('button', { class: 'btn sm ghost am-dir', type: 'button', title: 'Inverter a ordem', 'aria-label': 'Inverter a ordem', onClick: () => { U.dir = U.dir === 'asc' ? 'desc' : 'asc'; dirBtn.textContent = U.dir === 'asc' ? '↑' : '↓'; paintMain(); } }, U.dir === 'asc' ? '↑' : '↓');
      const opts = [['size', 'Tamanho'], ['name', 'Nome'], ['last', 'Último uso']];
      const btns = opts.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(U.sort === v), onClick: () => {
        U.sort = v; U.dir = DEFAULT_DIR[v]; dirBtn.textContent = U.dir === 'asc' ? '↑' : '↓';
        btns.forEach((b, i) => b.setAttribute('aria-pressed', String(opts[i][0] === v)));
        paintMain();
      } }, label));
      sort = [h('div', { class: 'seg', role: 'group', 'aria-label': 'Ordenar por' }, btns), dirBtn];
    }
    mount(M.head,
      h('button', { class: 'btn sm ghost am-back', type: 'button', onClick: goBack }, icon('back', 14), 'Voltar'),
      h('div', { class: 'am-title' }, h('h2', null, 'Aplicativos'), h('p', null, `Gerenciador · ${plural(apps().length, 'app', 'apps')} · ${fmtBytes(apps().reduce((x, a) => x + a.size, 0))}`)),
      search, sort);
  }

  function paintLeft() {
    const upN = updates().length;
    const leftN = U.over ? U.over.leftovers.groups.concat(U.over.installers.groups).reduce((a, g) => a + g.items.length, 0) : 0;
    const badge = { uninstaller: '', updater: U.over ? upN : '', leftovers: U.over ? leftN : '' };
    mount(M.left, NAV.map(([id, label]) => h('button', { class: 'am-nav', type: 'button', 'aria-current': String(U.pane === id), onClick: () => { if (U.pane === id) return; U.pane = id; U.q = ''; paintAll(); } },
      h('span', null, label), badge[id] !== '' ? h('span', { class: 'n' }, String(badge[id])) : null)));
  }

  function paintMid() {
    if (U.pane === 'uninstaller') return paintMidApps();
    if (U.pane === 'updater') return paintMidUpdater();
    return paintMidRestos();
  }
  function paintMain() {
    if (U.pane === 'uninstaller') return paintMainApps();
    if (U.pane === 'updater') return paintMainUpdater();
    return paintMainRestos();
  }
  function paintFoot() {
    if (U.pane === 'uninstaller') return paintFootApps();
    if (U.pane === 'updater') return paintFootUpdater();
    return paintFootRestos();
  }

  const noScan = (what) => h('div', { class: 'rv-empty am-noscan' }, h('div', null, h('p', null, `Analise seu Mac para ver ${what}.`),
    h('button', { class: 'btn sm primary', type: 'button', style: 'margin-top:12px', onClick: scan }, 'Analisar')));

  // ---------- Desinstalador ----------
  function inGroup(a, g) {
    if (g === 'all') return true;
    if (g === 'unused') return isUnused(a);
    if (g === 'selected') return U.sel.has(a.id);
    if (g.startsWith('store:')) return storeOf(a) === g.slice(6);
    if (g.startsWith('vendor:')) return vendorOf(a) === g.slice(7);
    return true;
  }

  function visibleApps() {
    const q = U.q.trim().toLowerCase();
    const list = apps().filter((a) => inGroup(a, U.group)
      && (!q || a.name.toLowerCase().includes(q) || (a.bundleId || '').toLowerCase().includes(q) || vendorOf(a).toLowerCase().includes(q)));
    const sgn = U.dir === 'asc' ? 1 : -1;
    const lastOf = (a) => metaOf(a).lastUsed;
    return list.sort((a, b) => {
      if (U.sort === 'name') return sgn * a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
      if (U.sort === 'last') {
        const x = lastOf(a), y = lastOf(b);
        if (x == null && y == null) return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
        if (x == null) return 1;
        if (y == null) return -1;
        return sgn * (x - y);
      }
      return sgn * (a.size - b.size);
    });
  }

  function paintMidApps() {
    const all = apps();
    const count = (g) => all.filter((a) => inGroup(a, g)).length;
    const stores = ['App Store', 'Setapp', 'Outros'];
    const vendors = new Map();
    for (const a of all) vendors.set(vendorOf(a), (vendors.get(vendorOf(a)) || 0) + 1);
    const vlist = [...vendors].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'));
    const exists = (g) => g === 'all' || g === 'unused' || g === 'selected' || (g.startsWith('store:') && stores.includes(g.slice(6))) || (g.startsWith('vendor:') && vendors.has(g.slice(7)));
    if (!exists(U.group)) U.group = 'all';
    const row = (g, label, n) => h('button', { class: 'am-grp', type: 'button', 'aria-current': String(U.group === g), onClick: () => { U.group = g; paintMid(); paintMain(); paintFoot(); } },
      h('span', { title: label }, label), h('span', { class: 'n' }, String(n)));
    mount(M.mid,
      h('h3', null, 'Desinstalador'),
      h('p', { class: 'am-desc' }, 'Remova aplicativos por inteiro, junto com os arquivos relacionados.'),
      row('all', 'Todos', all.length), row('unused', 'Não usados', count('unused')), row('selected', 'Selecionados', U.sel.size),
      h('div', { class: 'am-gh' }, 'Lojas'), stores.map((s) => row('store:' + s, s, count('store:' + s))),
      h('div', { class: 'am-gh' }, 'Fornecedores'), vlist.map(([v, n]) => row('vendor:' + v, v, n)));
  }

  // Restos de um app (carregados sob demanda, no máximo 2 análises ao mesmo tempo).
  let loActive = 0;
  const loWait = [];
  function loSlot() {
    return new Promise((res) => { const go = () => { loActive++; res(); }; if (loActive < 2) go(); else loWait.push(go); });
  }
  function loDone() { loActive--; const next = loWait.shift(); if (next) next(); }

  function ensureLo(app) {
    let lo = U.lo.get(app.id);
    if (lo) return lo.promise || Promise.resolve(lo);
    lo = { loading: true, result: null, sel: new Set(), failed: false, promise: null };
    U.lo.set(app.id, lo);
    lo.promise = loSlot().then(() => api.leftovers(app.id)).then((r) => {
      for (const g of r.groups) for (const i of g.items) if (i.note === NAME_MATCH) i.selected = false;
      lo.result = r;
      lo.sel = new Set(r.groups.flatMap((g) => g.items.filter((i) => i.selected).map((i) => i.id)));
    }).catch(() => { lo.failed = true; lo.result = { groups: [], total: 0 }; U.lo.delete(app.id); })
      .finally(() => { loDone(); lo.loading = false; lo.promise = null; if (ctx.alive && M) { paintFoot(); const n = M.main.querySelector(`[data-app="${app.id}"]`); if (n) paintRes(app, n); } })
      .then(() => lo);
    return lo.promise;
  }

  function selectedApps() { return apps().filter((a) => U.sel.has(a.id)); }
  function totalFor(list) {
    let bytes = 0, rest = 0, loading = false;
    for (const a of list) {
      bytes += a.size;
      const lo = U.lo.get(a.id);
      if (lo && lo.result) { const s = selectedSize(lo.result, lo.sel); bytes += s.bytes; rest += s.count; } else if (lo && lo.loading) loading = true;
    }
    return { bytes, rest, loading };
  }

  function toggleApp(a, cb) {
    if (a.running) return;
    if (U.sel.has(a.id)) U.sel.delete(a.id); else { U.sel.add(a.id); ensureLo(a); }
    if (cb) cb.set(U.sel.has(a.id) ? 'on' : 'off');
    paintFoot();
    paintMid();
    if (U.group === 'selected') paintMain();
  }

  function paintRes(app, node) {
    const box = node.querySelector('.am-res');
    if (!box) return;
    const chev = node.querySelector('.am-chev');
    if (chev) chev.setAttribute('aria-expanded', String(U.open.has(app.id)));
    node.classList.toggle('open', U.open.has(app.id));
    if (!U.open.has(app.id)) { box.hidden = true; mount(box); return; }
    box.hidden = false;
    const lo = U.lo.get(app.id);
    const appRow = h('div', { class: 'lo-row', style: 'cursor:default' }, (() => { const c = checkbox('on', () => {}, app.name); c.disabled = true; return c; })(),
      h('div', { class: 'rv-ic' }, icon('apps', 16)),
      h('div', { class: 'rv-main' }, h('div', { class: 'rv-name' }, h('span', null, 'Aplicativo')), h('div', { class: 'rv-meta' }, mid(app.path, 20))),
      h('span', { class: 'rv-size' }, fmtBytes(app.size)));
    const kids = [appRow];
    if (!lo || lo.loading) kids.push(h('div', { class: 'ap-loading' }, h('span', { class: 'spin' }), 'Procurando restos…'));
    else if (!lo.result.groups.length) kids.push(h('div', { class: 'am-res-none' }, 'Nenhum resto encontrado.'));
    else {
      const items = lo.result.groups.flatMap((g) => g.items);
      const sure = items.filter((i) => !i.note), maybe = items.filter((i) => i.note);
      const row = (it) => {
        const cb = checkbox(lo.sel.has(it.id) ? 'on' : 'off', () => toggle(), `Selecionar ${it.name}`);
        const toggle = () => { if (lo.sel.has(it.id)) lo.sel.delete(it.id); else lo.sel.add(it.id); cb.set(lo.sel.has(it.id) ? 'on' : 'off'); paintFoot(); };
        return h('div', { class: 'lo-row' + (it.note ? ' maybe' : ''), onClick: toggle }, cb, h('div', { class: 'rv-ic' }, icon(KIND_ICON[it.name] || 'folder', 16)),
          h('div', { class: 'rv-main' },
            h('div', { class: 'rv-name' }, h('span', { title: it.name }, it.name)),
            h('div', { class: 'rv-meta', title: it.path }, mid(tilde(it.path), 26)),
            it.note ? h('div', { class: 'lo-why' }, icon('alert', 12), h('span', null, it.note)) : null),
          h('span', { class: 'rv-size' }, fmtBytes(it.size)));
      };
      if (sure.length) kids.push(h('div', { class: 'ap-sec ok', title: 'Pastas com o identificador do app ou de componentes dentro dele, agentes que executam o app e grupos declarados na assinatura.' }, icon('shield', 13), 'Do app · verificado'), ...sure.map(row));
      if (maybe.length) kids.push(h('div', { class: 'ap-sec warn', title: 'Parecem ser do app, mas não há prova. Vêm desmarcados.' }, icon('alert', 13), 'Talvez do app · revise'), ...maybe.map(row));
    }
    mount(box, kids);
  }

  function appNode(a) {
    const m = metaOf(a);
    const cb = checkbox(U.sel.has(a.id) ? 'on' : 'off', () => toggleApp(a, cb), a.running ? `${a.name} está em execução` : `Selecionar ${a.name}`);
    if (a.running) { cb.disabled = true; cb.title = 'Feche o app para desinstalar'; }
    const toggleOpen = () => {
      if (U.open.has(a.id)) U.open.delete(a.id); else { U.open.add(a.id); ensureLo(a); }
      paintRes(a, node);
    };
    const sub = [vendorOf(a), lastText(m.lastUsed)].filter(Boolean).join(' · ');
    const node = h('div', { class: 'am-item', dataset: { app: String(a.id) } },
      h('div', { class: 'am-row', onClick: toggleOpen },
        cb, iconBox(a, true),
        h('div', { class: 'rv-main' },
          h('div', { class: 'rv-name' }, h('span', { title: a.name }, a.name), a.running ? h('span', { class: 'badge info' }, 'Em execução') : null, isUnused(a) ? h('span', { class: 'badge' }, 'Não usado') : null),
          h('div', { class: 'am-sub', title: sub }, sub)),
        h('span', { class: 'rv-size' }, fmtBytes(a.size)),
        h('button', { class: 'am-chev', type: 'button', 'aria-label': `Arquivos relacionados de ${a.name}`, 'aria-expanded': String(U.open.has(a.id)), onClick: (e) => { e.stopPropagation(); toggleOpen(); } }, icon('back', 14))),
      h('div', { class: 'am-res', hidden: true }));
    if (U.open.has(a.id)) paintRes(a, node);
    return node;
  }

  function paintMainApps() {
    const list = visibleApps();
    const selectable = list.filter((a) => !a.running);
    const allSel = selectable.length > 0 && selectable.every((a) => U.sel.has(a.id));
    const prev = M.main.querySelector('.am-list');
    const top = prev ? prev.scrollTop : 0;
    const listEl = h('div', { class: 'am-list' });
    if (list.length) listEl.append(...list.map(appNode));
    else listEl.append(h('div', { class: 'rv-empty' }, U.q ? 'Nenhum aplicativo corresponde à busca.' : U.group === 'selected' ? 'Nenhum aplicativo selecionado.' : U.group === 'unused' ? 'Nenhum aplicativo sem uso há mais de 6 meses.' : 'Nenhum aplicativo encontrado.'));
    mount(M.main,
      h('div', { class: 'am-bar' },
        h('span', { class: 'am-count' }, `${plural(list.length, 'app', 'apps')} · ${fmtBytes(list.reduce((x, a) => x + a.size, 0))}`),
        h('button', { class: 'btn sm ghost', type: 'button', disabled: !selectable.length, onClick: () => {
          for (const a of selectable) { if (allSel) U.sel.delete(a.id); else { U.sel.add(a.id); ensureLo(a); } }
          paintMid(); paintMain(); paintFoot();
        } }, allSel ? 'Desmarcar todos' : 'Selecionar todos')),
      listEl);
    listEl.scrollTop = top;
  }

  function paintFootApps() {
    const sel = selectedApps();
    const t = totalFor(sel);
    const none = !sel.length;
    mount(M.foot,
      h('div', { class: 'rv-sel' }, none ? 'Nenhum app selecionado' : [h('b', null, plural(sel.length, 'app selecionado', 'apps selecionados')), h('small', null, fmtBytes(t.bytes)), t.loading ? h('span', { class: 'spin am-spin', title: 'Calculando restos…' }) : null]),
      h('button', { class: 'btn primary', type: 'button', disabled: none, onClick: uninstallSelected }, icon('trash', 16), 'Desinstalar'));
  }

  // ---------- desinstalação em lote ----------
  async function uninstallSelected() {
    const list = selectedApps().filter((a) => !a.running);
    if (!list.length) return;
    ctx.setBusy(true);
    await Promise.all(list.map((a) => ensureLo(a)));
    ctx.setBusy(false);
    if (!ctx.alive) return;
    const t = totalFor(list);
    const ok = await confirmDialog({
      title: list.length === 1 ? `Desinstalar ${list[0].name}?` : `Desinstalar ${plural(list.length, 'app', 'apps')}?`,
      body: [h('strong', null, 'Os apps e os itens selecionados vão para o Lixo'), `. São ${fmtBytes(t.bytes)} no total (${plural(list.length, 'aplicativo', 'aplicativos')} + ${plural(t.rest, 'resto', 'restos')}). Você pode restaurá-los de lá até esvaziar a Lixeira.`],
      confirm: 'Desinstalar', glyph: 'trash', mod: 'apps',
      permanentChoice: true, permanentDefault: !!(store.settings && store.settings.permanentDelete),
    });
    if (!ok) return;
    const permanent = ok === 'permanent';

    const back = U.phase;
    U.phase = 'busy';
    ctx.setBusy(true);
    const st = stage('apps', 'apps', 260);
    mount(root, st.el);
    st.busy(true);
    ctx.reserveDock(true);
    const rows = new Map(list.map((a) => [a.id, h('div', { class: 'prog-row', dataset: { st: 'wait' } }, h('span', { class: 'nm', title: a.name }, a.name), h('span', { class: 'sz' }), h('span', { class: 'st' }))]));
    st.show(h('h1', { class: 'h1' }, 'Desinstalando…'), h('div', { class: 'group-list' }, [...rows.values()]));
    const sd = stopDock(ctx, 'apps');

    const failures = [];
    let freed = 0, okCount = 0, finished = 0;
    for (const app of list) {
      const row = rows.get(app.id);
      if (sd.stopped()) { row.dataset.st = 'fail'; failures.push({ name: app.name, path: app.path, error: 'cancelado; o app continua instalado' }); continue; }
      row.dataset.st = 'run';
      mount(row.querySelector('.st'), h('span', { class: 'spin' }));
      const lo = U.lo.get(app.id);
      const names = new Map([[app.id, { name: app.name, path: app.path }], ...(lo && lo.result ? lo.result.groups.flatMap((g) => g.items.map((i) => [i.id, i])) : [])]);
      let res = null;
      try { res = await api.uninstall(app.id, lo ? [...lo.sel] : [], permanent); } catch (e) { /* toast já exibido */ }
      finished++;
      let appOk = false;
      if (res) {
        appOk = !res.outcomes.some((o) => !o.ok && o.id === app.id);
        freed += res.freed || 0;
        for (const o of res.outcomes) if (!o.ok) failures.push({ name: (names.get(o.id) || {}).name || `Item ${o.id}`, path: (names.get(o.id) || {}).path, error: o.error });
      } else failures.push({ name: app.name, path: app.path, error: 'Não foi possível desinstalar. O app pode estar aberto.' });
      row.dataset.st = appOk ? 'done' : 'fail';
      mount(row.querySelector('.st'), icon(appOk ? 'check' : 'alert', 16));
      row.querySelector('.sz').textContent = res ? fmtBytes(res.freed || 0) : '';
      sd.progress(finished / list.length);
      if (appOk) {
        okCount++;
        store.apps = apps().filter((a) => a.id !== app.id);
        U.appsRef = store.apps;
        U.sel.delete(app.id); U.lo.delete(app.id); U.open.delete(app.id);
        if (U.over) { U.over.unused.delete(app.id); U.over.updates = U.over.updates.filter((u) => u.appId !== app.id); U.upSel.delete(app.id); }
      } else U.lo.delete(app.id);
    }
    await sleep(400);
    bump(); store.trash = null;
    play(okCount ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    U.done = { headline: okCount === 1 ? '1 aplicativo desinstalado' : `${okCount} aplicativos desinstalados`, freed, failed: failures.length, permanent, again: () => { U.pane = 'uninstaller'; U.group = 'all'; } };
    U.phase = okCount || failures.length ? 'done' : back;
    render();
    if (failures.length) failuresSheet(failures);
  }

  // ---------- Atualizador ----------
  function visibleUpdates() {
    const q = U.q.trim().toLowerCase();
    const map = byId();
    return updates().map((u) => ({ u, a: map.get(u.appId) })).filter(({ a }) => a && (!q || a.name.toLowerCase().includes(q)))
      .sort((x, y) => x.a.name.localeCompare(y.a.name, 'pt-BR', { sensitivity: 'base' }));
  }

  function paintMidUpdater() {
    if (!U.over) { mount(M.mid, h('h3', null, 'Atualizador'), noScan('as atualizações')); return; }
    const list = visibleUpdates();
    const allSel = list.length > 0 && list.every(({ a }) => U.upSel.has(a.id));
    const head = [h('h3', null, 'Atualizador'), h('p', { class: 'am-desc' }, 'Acompanhe as versões mais recentes dos seus apps.')];
    if (!list.length) { mount(M.mid, head, h('div', { class: 'am-empty' }, U.q ? 'Nenhum app corresponde à busca.' : 'Todos os apps com fonte de atualização estão em dia.')); return; }
    mount(M.mid, head,
      h('div', { class: 'am-selrow' }, 'Selecionar:', h('button', { class: 'link', type: 'button', onClick: () => { for (const { a } of list) { if (allSel) U.upSel.delete(a.id); else U.upSel.add(a.id); } paintMid(); paintFoot(); } }, allSel ? 'Nenhum' : 'Todos')),
      list.map(({ u, a }) => {
        const cb = checkbox(U.upSel.has(a.id) ? 'on' : 'off', () => { if (U.upSel.has(a.id)) U.upSel.delete(a.id); else U.upSel.add(a.id); cb.set(U.upSel.has(a.id) ? 'on' : 'off'); paintFoot(); }, `Selecionar ${a.name}`);
        return h('div', { class: 'am-up', 'aria-current': String(U.upFocus === a.id), onClick: () => { U.upFocus = a.id; paintMid(); paintMain(); } },
          cb, iconBox(a, true),
          h('div', { class: 'rv-main' }, h('div', { class: 'rv-name' }, h('span', { title: a.name }, a.name)), h('div', { class: 'am-sub' }, `${u.current} → ${u.latest}`)));
      }));
  }

  function paintMainUpdater() {
    if (!U.over) { mount(M.main, noScan('atualizações disponíveis')); return; }
    const u = updates().find((x) => x.appId === U.upFocus);
    const a = u && byId().get(u.appId);
    if (!a) { mount(M.main, h('div', { class: 'rv-empty' }, updates().length ? 'Selecione um app para ver os detalhes da atualização.' : 'Nenhuma atualização disponível.')); return; }
    const src = hostOf(u.downloadUrl || u.notesUrl || '');
    mount(M.main, h('div', { class: 'am-detail enter' },
      h('div', { class: 'am-d-head' }, iconBox(a, false, 'ax-ic'), h('div', { style: 'min-width:0' }, h('h3', { title: a.name }, a.name), h('p', null, a.running ? 'Em execução' : 'Atualização disponível'))),
      h('dl', { class: 'am-d-list' },
        h('dt', null, 'Versão instalada'), h('dd', null, u.current),
        h('dt', null, 'Versão disponível'), h('dd', null, u.latest),
        src ? [h('dt', null, 'Fonte'), h('dd', { title: src }, src)] : null),
      h('p', { class: 'am-d-note' }, 'O Limpae só avisa e abre a página da atualização no navegador. A instalação é feita por você, no próprio app.'),
      h('div', { class: 'row-actions', style: 'margin-top:16px' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => openUpdates([a.id]) }, icon('refresh', 15), 'Abrir página de atualização'))));
  }

  function paintFootUpdater() {
    if (!U.over) { mount(M.foot, h('div', { class: 'rv-sel' }, 'Análise necessária'), h('button', { class: 'btn primary', type: 'button', onClick: scan }, 'Analisar')); return; }
    const ids = updates().filter((u) => U.upSel.has(u.appId)).map((u) => u.appId);
    mount(M.foot,
      h('div', { class: 'rv-sel' }, ids.length ? h('b', null, plural(ids.length, 'atualização selecionada', 'atualizações selecionadas')) : 'Nenhuma atualização selecionada'),
      h('button', { class: 'btn primary', type: 'button', disabled: !ids.length, onClick: () => openUpdates(ids) }, icon('refresh', 16), 'Atualizar'));
  }

  // ---------- Restos e instaladores ----------
  const restosRes = () => (U.restGroup === 'installers' ? U.over.installers : U.over.leftovers);
  const restosSel = () => (U.restGroup === 'installers' ? U.instSel : U.leftSel);

  function paintMidRestos() {
    if (!U.over) { mount(M.mid, h('h3', null, 'Restos'), noScan('restos e instaladores')); return; }
    const row = (id, label, res) => {
      const n = res.groups.reduce((a, g) => a + g.items.length, 0);
      return h('button', { class: 'am-grp two', type: 'button', 'aria-current': String(U.restGroup === id), onClick: () => { U.restGroup = id; paintMid(); paintMain(); paintFoot(); } },
        h('span', { title: label }, label), h('span', { class: 'n' }, n ? `${n} · ${fmtBytes(res.total)}` : '0'));
    };
    mount(M.mid, h('h3', null, 'Restos'), h('p', { class: 'am-desc' }, 'Dados de apps que já foram removidos e instaladores que podem ser baixados de novo.'),
      row('leftovers', 'Restos de apps', U.over.leftovers), row('installers', 'Instaladores', U.over.installers),
      U.over.leftovers.needsFda ? h('p', { class: 'am-desc', style: 'margin-top:14px' }, 'Sem Acesso Total ao Disco, parte de ~/Library pode não aparecer aqui.') : null);
  }

  function paintMainRestos() {
    if (!U.over) { mount(M.main, noScan('restos e instaladores')); return; }
    const res = restosRes(), sel = restosSel();
    const q = U.q.trim().toLowerCase();
    const groups = res.groups.map((g) => ({ g, items: g.items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.path.toLowerCase().includes(q)) })).filter((x) => x.items.length);
    const prev = M.main.querySelector('.am-list');
    const top = prev ? prev.scrollTop : 0;
    const listEl = h('div', { class: 'am-list' });
    if (!groups.length) listEl.append(h('div', { class: 'rv-empty' }, q ? 'Nenhum item corresponde à busca.' : U.restGroup === 'installers' ? 'Nenhum instalador encontrado.' : 'Nenhum resto de app encontrado.'));
    for (const { g, items } of groups) {
      const state = () => { const n = items.filter((i) => sel.has(i.id)).length; return n === 0 ? 'off' : n === items.length ? 'on' : 'mixed'; };
      const gcb = checkbox(state(), (s0) => { for (const i of items) { if (s0 === 'on') sel.delete(i.id); else sel.add(i.id); } paintMain(); paintFoot(); }, `Selecionar grupo ${g.title}`);
      listEl.append(h('div', { class: 'am-sec' }, gcb, h('div', { class: 'rv-main' }, h('b', { title: g.title }, g.title), h('span', null, g.description)), h('span', { class: 'rv-size' }, fmtBytes(items.reduce((x, i) => x + i.size, 0)))));
      for (const it of items) {
        const cb = checkbox(sel.has(it.id) ? 'on' : 'off', () => toggle(), `Selecionar ${it.name}`);
        const toggle = () => { if (sel.has(it.id)) sel.delete(it.id); else sel.add(it.id); cb.set(sel.has(it.id) ? 'on' : 'off'); gcb.set(state()); paintFoot(); };
        listEl.append(h('div', { class: 'rv-item am-it', onClick: toggle }, cb,
          h('div', { class: 'rv-ic' }, icon(U.restGroup === 'installers' ? 'disk' : groupIcon('leftovers'), 16)),
          h('div', { class: 'rv-main' }, h('div', { class: 'rv-name' }, h('span', { title: it.note ? `${it.name}: ${it.note}` : it.name }, it.name)), h('div', { class: 'rv-meta' }, mid(it.path, 24))),
          h('span', { class: 'rv-size' }, fmtBytes(it.size)),
          h('button', { class: 'icon-btn rv-act', type: 'button', title: 'Mostrar no Finder', 'aria-label': `Mostrar ${it.name} no Finder`, onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 16))));
      }
    }
    mount(M.main, listEl);
    listEl.scrollTop = top;
  }

  function paintFootRestos() {
    if (!U.over) { mount(M.foot, h('div', { class: 'rv-sel' }, 'Análise necessária'), h('button', { class: 'btn primary', type: 'button', onClick: scan }, 'Analisar')); return; }
    const { bytes, count } = selectedSize(restosRes(), restosSel());
    mount(M.foot,
      h('div', { class: 'rv-sel' }, count ? [h('b', null, plural(count, 'item selecionado', 'itens selecionados')), h('small', null, fmtBytes(bytes))] : 'Nenhum item selecionado'),
      h('button', { class: 'btn primary', type: 'button', disabled: !count, onClick: () => removeResult(U.restGroup) }, icon('trash', 16), 'Remover'));
  }

  render();
}
