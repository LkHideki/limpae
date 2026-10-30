// Aplicativos: landing -> análise -> resultados (tiles) -> Gerenciador (Desinstalador / Atualizador / Restos) -> conclusão.
// A UI só envia ids. Apps, restos e instaladores vão para o Lixo; atualizações abrem a página do fornecedor.
import { play } from '../sound.js';
import { h, mount, mid, sleep } from '../dom.js';
import { icon, orb, groupIcon } from '../art.js';
import { api } from '../api.js';
import { store, selectedSize, selectedIds, pruneResult, bump } from '../store.js';
import { fmtBytes, fmtNum } from '../format.js';
import { t, tn, tr, lazyIntl, cmp } from '../i18n.js';
import { checkbox, confirmDialog, failuresSheet, stage, features, toast, managerBar } from '../ui.js';
import { removeGroups, stopDock } from '../actions.js';
import { attachMenu, selectMenuButton } from '../menus.js';

const NAME_MATCH = 'Correspondência pelo nome'; // i18n-ignore (valor do backend, só comparação)
const UNUSED_DAYS = 180;
const DEFAULT_DIR = { size: 'desc', name: 'asc', last: 'desc' };
const rtf = lazyIntl('RelativeTimeFormat', { numeric: 'always' });

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
  if (!sec) return t('nunca aberto');
  const d = Date.now() / 1000 - sec;
  for (const [unit, size] of [['year', 31557600], ['month', 2629800], ['week', 604800], ['day', 86400]]) {
    if (d >= size) return t('aberto {when}', { when: rtf.format(-Math.floor(d / size), unit) });
  }
  return t('aberto hoje');
}

const hostOf = (url) => { try { return new URL(url).host; } catch (e) { return ''; } };

// Ícone por tipo de resto (rótulo vindo do backend).
const KIND_ICON = {
  'Suporte do app': 'folder', Caches: 'box', 'Preferências': 'prefs', 'Preferências deste Mac': 'prefs', 'Contêiner do app': 'archive', // i18n-ignore
  'Contêiner compartilhado': 'apps', 'Scripts do app': 'code', 'Estado das janelas': 'restart', 'Armazenamento web': 'disk', // i18n-ignore
  Cookies: 'disk', 'Dados do WebKit': 'disk', Registros: 'log', 'Agente de inicialização': 'bolt', // i18n-ignore
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
  const storeOf = (a) => metaOf(a).store || 'Outros'; // i18n-ignore
  const vendorOf = (a) => metaOf(a).vendor || 'Outros'; // i18n-ignore
  const otherLabel = (v) => (v === 'Outros' ? t('Outros') : v); // i18n-ignore
  const isUnused = (a) => {
    if (a.running) return false;
    if (U.over) return U.over.unused.has(a.id);
    const lu = metaOf(a).lastUsed;
    return !!lu && Date.now() / 1000 - lu > UNUSED_DAYS * 86400;
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
    ctx.onBack(null);
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
    st.show(h('h1', { class: 'h1' }, t('Aplicativos')),
      h('p', { class: 'sub' }, t('Desinstale apps por completo, acompanhe atualizações e limpe o que sobrou deles.')),
      features('apps', [['trash', t('Desinstalação completa, com os restos')], ['refresh', t('Atualizações de apps fora da App Store')], ['clock', t('Apps que você não abre há meses')]]),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: openDirect }, icon('apps', 15), t('Ver meus aplicativos'))));
    ctx.setDock({ label: t('Analisar'), mod: 'apps', onClick: scan });
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
    loadingScreen(t('Listando aplicativos…'), t('Isso pode levar alguns instantes.'));
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
    loadingScreen(t('Analisando aplicativos…'), t('Listando apps, procurando atualizações, restos e instaladores.'));
    ctx.setDock({ label: t('Parar'), busy: true, mod: 'apps', onClick: () => { cancelled = true; ctx.setDock({ label: t('Parando'), busy: true, disabled: true, mod: 'apps' }); api.cancel().catch(() => {}); } });
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
        mod: 'apps', glyph: 'refresh', title: tn(ups.length, '{n} atualização disponível', '{n} atualizações disponíveis'),
        sub: t('Mantenha seus apps em dia com os recursos e correções mais recentes.'),
        body: h('div', { class: 'ax-t-icons' }, upIcons.map((a) => iconBox(a, false, 'ax-ic'))),
        actions: [h('button', { class: 'btn sm', type: 'button', onClick: review('updater') }, t('Revisar')),
          h('button', { class: 'btn sm primary', type: 'button', onClick: () => openUpdates(ups.map((u) => u.appId)) }, t('Atualizar||update'))],
      })
      : tile({ mod: 'apps', glyph: 'refresh', title: t('Apps em dia'), sub: t('Nenhuma atualização encontrada nos apps que informam uma fonte.'), body: empty(t('Tudo atualizado')), actions: [] });

    const tUnused = unusedN
      ? tile({
        mod: 'perf', glyph: 'clock', title: tn(unusedN, '{n} app não usado', '{n} apps não usados'),
        sub: t('Apps que você não abre há mais de 6 meses.'),
        actions: [h('button', { class: 'btn sm primary', type: 'button', onClick: review('uninstaller', { group: 'unused' }) }, t('Revisar'))],
      })
      : tile({ mod: 'perf', glyph: 'clock', title: t('Sem apps esquecidos'), sub: t('Todos os apps foram usados nos últimos 6 meses.'), body: empty(t('Nada a revisar')), actions: [] });

    const leftCount = left.groups.reduce((a, g) => a + g.items.length, 0);
    const tLeft = leftCount
      ? tile({
        mod: 'trash', glyph: 'folder', title: t('{size} de restos de apps', { size: fmtBytes(left.total) }),
        sub: tn(leftCount, '{n} item de apps que não estão mais instalados.', '{n} itens de apps que não estão mais instalados.') + ' '
          + (leftSel.count ? t('{size} vêm pré-selecionados.', { size: fmtBytes(leftSel.bytes) }) : t('Nada vem pré-selecionado: podem guardar dados.')),
        actions: [h('button', { class: 'btn sm', type: 'button', onClick: review('leftovers', { restGroup: 'leftovers' }) }, t('Revisar')),
          h('button', { class: 'btn sm primary', type: 'button', disabled: !leftSel.count, onClick: () => removeResult('leftovers') }, t('Remover'))],
      })
      : tile({ mod: 'trash', glyph: 'folder', title: t('Sem restos de apps'), sub: t('Não há dados de apps já removidos.'), body: empty(t('Tudo limpo')), actions: [] });

    const instCount = inst.groups.reduce((a, g) => a + g.items.length, 0);
    const tInst = instCount
      ? tile({
        mod: 'files', glyph: 'disk', title: t('{size} de instaladores', { size: fmtBytes(inst.total) }),
        sub: tn(instCount, '{n} arquivo .dmg, .pkg ou .xip em Downloads e na Mesa, fácil de baixar de novo.', '{n} arquivos .dmg, .pkg ou .xip em Downloads e na Mesa, fáceis de baixar de novo.'),
        actions: [h('button', { class: 'btn sm', type: 'button', onClick: review('leftovers', { restGroup: 'installers' }) }, t('Revisar')),
          h('button', { class: 'btn sm primary', type: 'button', disabled: !instSel.count, onClick: () => removeResult('installers') }, t('Remover'))],
      })
      : tile({ mod: 'files', glyph: 'disk', title: t('Sem instaladores'), sub: t('Nenhum .dmg, .pkg ou .xip em Downloads ou na Mesa.'), body: empty(t('Tudo limpo')), actions: [] });

    mount(root, h('div', { class: 'ax enter', dataset: { mod: 'apps' } },
      h('div', { class: 'ax-head' },
        h('h2', null, tn(n, 'Encontramos {n} app no seu Mac.', 'Encontramos {n} apps no seu Mac.')),
        h('div', { class: 'ax-head-row' },
          h('button', { class: 'btn primary', type: 'button', onClick: review('uninstaller', { group: 'all' }) }, icon('apps', 15), t('Gerenciar meus aplicativos')),
          h('button', { class: 'btn ghost', type: 'button', onClick: () => { U.phase = 'idle'; render(); } }, icon('restart', 14), t('Analisar de novo')))),
      h('div', { class: 'ax-tiles' }, tUpdates, tUnused, tLeft, tInst)));
  }

  // ---------- atualizações (somente abre a página; nada é instalado) ----------
  async function openUpdates(ids) {
    if (!ids.length) return;
    if (ids.length > 3) {
      const ok = await confirmDialog({
        title: tn(ids.length, 'Abrir {n} página de atualização?', 'Abrir {n} páginas de atualização?'),
        body: [t('Cada página abre no navegador padrão.') + ' ', h('strong', null, t('O Limpae não instala atualizações')), t('; você conclui a instalação em cada app.')],
        confirm: t('Abrir'), glyph: 'refresh', mod: 'apps',
      });
      if (!ok) return;
    }
    let opened = 0;
    for (const id of ids) {
      try { await api.openUpdate(id); opened++; } catch (e) { /* toast já exibido */ }
      await sleep(350);
    }
    if (opened && ctx.alive) toast(opened === 1 ? t('Abrindo a página da atualização.') : t('Abrindo {n} páginas de atualização.', { n: fmtNum(opened) }), 'ok');
  }

  // ---------- restos e instaladores: remover ----------
  async function removeResult(kind) {
    const res = kind === 'installers' ? U.over.installers : U.over.leftovers;
    const sel = kind === 'installers' ? U.instSel : U.leftSel;
    const { bytes, count } = selectedSize(res, sel);
    if (!count) return;
    const what = kind === 'installers'
      ? tn(count, '{n} instalador vai para o Lixo', '{n} instaladores vão para o Lixo')
      : tn(count, '{n} resto de app vai para o Lixo', '{n} restos de apps vão para o Lixo');
    const ok = await confirmDialog({
      title: t('Mover {size} para o Lixo?', { size: fmtBytes(bytes) }),
      permanentTitle: t('Apagar {size} definitivamente?', { size: fmtBytes(bytes) }),
      body: [h('strong', null, what), tn(count, '. Você pode restaurá-lo de lá até esvaziar a Lixeira.', '. Você pode restaurá-los de lá até esvaziar a Lixeira.')],
      confirm: t('Mover para o Lixo'), glyph: 'trash', mod: 'apps',
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
    const rows = new Map(groups.map((g) => [g.id, h('div', { class: 'prog-row', dataset: { st: 'wait' } }, h('span', { class: 'nm', title: tr(g.title) }, tr(g.title)), h('span', { class: 'sz' }), h('span', { class: 'st' }))]));
    st.show(h('h1', { class: 'h1' }, t('Removendo…')), h('div', { class: 'group-list' }, [...rows.values()]));
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
    play(r.handled ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    U.done = { headline: kind === 'installers' ? tn(r.okIds.size, '{n} instalador removido', '{n} instaladores removidos') : tn(r.okIds.size, '{n} resto de app removido', '{n} restos de apps removidos'), freed: r.handled, failed: r.failures.length, permanent: ok === 'permanent', again: () => { U.pane = 'leftovers'; U.restGroup = kind; } };
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
    st.show(h('h1', { class: 'h1' }, t('Pronto!')),
      h('div', { class: 'big-cap' }, d.headline),
      h('p', { class: 'sub' }, [d.permanent ? t('{size} apagados definitivamente.', { size: fmtBytes(d.freed) }) : t('{size} movidos para o Lixo. Esvazie a Lixeira para liberar o espaço.', { size: fmtBytes(d.freed) }), d.failed ? ' ' + tn(d.failed, '{n} item não foi removido.', '{n} itens não foram removidos.') : ''].join('')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), t('Ver log')),
        h('button', { class: 'btn', type: 'button', onClick: more }, t('Gerenciar mais')),
        h('button', { class: 'btn primary', type: 'button', onClick: finish }, t('Concluir'))));
  }

  // =====================================================================================================
  // Gerenciador de Aplicativos
  // =====================================================================================================
  const NAV = ['uninstaller', 'updater', 'leftovers'];

  function renderManager() {
    M = {
      head: h('div', { class: 'rv-head mgr-bar' }),
      left: h('nav', { class: 'am-left', 'aria-label': t('Seções') }),
      mid: h('div', { class: 'am-mid' }),
      main: h('div', { class: 'am-main' }),
      foot: h('div', { class: 'rv-foot' }),
    };
    mount(root, h('section', { class: 'am enter', dataset: { mod: 'apps' }, 'aria-label': t('Gerenciador de Aplicativos') },
      M.head, h('div', { class: 'am-body' }, M.left, M.mid, M.main), M.foot));
    ctx.onBack(goBack);
    paintAll();
  }

  function paintAll() {
    if (!M) return;
    paintHead(); paintLeft(); paintMid(); paintMain(); paintFoot();
  }

  const goBack = () => { U.phase = U.over ? 'results' : 'idle'; render(); };

  function paintHead() {
    const search = h('label', { class: 'search' }, icon('search', 16),
      h('input', { type: 'search', placeholder: t('Buscar'), 'aria-label': t('Buscar'), value: U.q, spellcheck: 'false', onInput: (e) => { U.q = e.target.value; paintMid(); paintMain(); } }));
    let sort = null;
    if (U.pane === 'uninstaller') {
      const dirBtn = h('button', { class: 'btn sm ghost am-dir', type: 'button', title: t('Inverter a ordem'), 'aria-label': t('Inverter a ordem'), onClick: () => { U.dir = U.dir === 'asc' ? 'desc' : 'asc'; dirBtn.textContent = U.dir === 'asc' ? '↑' : '↓'; paintMain(); } }, U.dir === 'asc' ? '↑' : '↓');
      const opts = [['size', t('Tamanho')], ['name', t('Nome')], ['last', t('Último uso')]];
      const btns = opts.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(U.sort === v), onClick: () => {
        U.sort = v; U.dir = DEFAULT_DIR[v]; dirBtn.textContent = U.dir === 'asc' ? '↑' : '↓';
        btns.forEach((b, i) => b.setAttribute('aria-pressed', String(opts[i][0] === v)));
        paintMain();
      } }, label));
      sort = [h('div', { class: 'seg', role: 'group', 'aria-label': t('Ordenar por') }, btns), dirBtn];
    }
    managerBar({ into: M.head, title: t('Aplicativos'), subtitle: `${tn(apps().length, '{n} app', '{n} apps')} · ${fmtBytes(apps().reduce((x, a) => x + a.size, 0))}`, onBack: goBack, controls: [search, sort] });
  }

  function paintLeft() {
    const upN = updates().length;
    const leftN = U.over ? U.over.leftovers.groups.concat(U.over.installers.groups).reduce((a, g) => a + g.items.length, 0) : 0;
    const badge = { uninstaller: '', updater: U.over ? upN : '', leftovers: U.over ? leftN : '' };
    const navLabel = { uninstaller: t('Desinstalador'), updater: t('Atualizador'), leftovers: t('Restos') };
    mount(M.left, NAV.map((id) => h('button', { class: 'am-nav', type: 'button', 'aria-current': String(U.pane === id), onClick: () => { if (U.pane === id) return; U.pane = id; U.q = ''; paintAll(); } },
      h('span', null, navLabel[id]), badge[id] !== '' ? h('span', { class: 'n' }, String(badge[id])) : null)));
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

  const noScan = (what) => h('div', { class: 'rv-empty am-noscan' }, h('div', null, h('p', null, what),
    h('button', { class: 'btn sm primary', type: 'button', style: 'margin-top:12px', onClick: scan }, t('Analisar'))));

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
      if (U.sort === 'name') return sgn * cmp(a.name, b.name);
      if (U.sort === 'last') {
        const x = lastOf(a), y = lastOf(b);
        if (x == null && y == null) return cmp(a.name, b.name);
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
    const vlist = [...vendors].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
    const exists = (g) => g === 'all' || g === 'unused' || g === 'selected' || (g.startsWith('store:') && stores.includes(g.slice(6))) || (g.startsWith('vendor:') && vendors.has(g.slice(7)));
    if (!exists(U.group)) U.group = 'all';
    const row = (g, label, n) => h('button', { class: 'am-grp', type: 'button', 'aria-current': String(U.group === g), onClick: () => { U.group = g; paintMid(); paintMain(); paintFoot(); } },
      h('span', { title: label }, label), h('span', { class: 'n' }, String(n)));
    mount(M.mid,
      h('h3', null, t('Desinstalador')),
      h('p', { class: 'am-desc' }, t('Remova aplicativos por inteiro, junto com os arquivos relacionados.')),
      row('all', t('Todos'), all.length), row('unused', t('Não usados'), count('unused')), row('selected', t('Selecionados'), U.sel.size),
      h('div', { class: 'am-gh' }, t('Lojas')), stores.map((s) => row('store:' + s, otherLabel(s), count('store:' + s))),
      h('div', { class: 'am-gh' }, t('Fornecedores')), vlist.map(([v, n]) => row('vendor:' + v, otherLabel(v), n)));
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
    const oldSel = M.main.querySelector('.am-bar .sel-btn');
    if (oldSel) oldSel.replaceWith(selBtn());
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
      h('div', { class: 'rv-main' }, h('div', { class: 'rv-name' }, h('span', null, t('Aplicativo'))), h('div', { class: 'rv-meta' }, mid(app.path, 20))),
      h('span', { class: 'rv-size' }, fmtBytes(app.size)));
    const kids = [appRow];
    if (!lo || lo.loading) kids.push(h('div', { class: 'ap-loading' }, h('span', { class: 'spin' }), t('Procurando restos…')));
    else if (!lo.result.groups.length) kids.push(h('div', { class: 'am-res-none' }, t('Nenhum resto encontrado.')));
    else {
      const items = lo.result.groups.flatMap((g) => g.items);
      const sure = items.filter((i) => !i.note), maybe = items.filter((i) => i.note);
      const row = (it) => {
        const cb = checkbox(lo.sel.has(it.id) ? 'on' : 'off', () => toggle(), t('Selecionar {name}', { name: tr(it.name) }));
        const toggle = () => { if (lo.sel.has(it.id)) lo.sel.delete(it.id); else lo.sel.add(it.id); cb.set(lo.sel.has(it.id) ? 'on' : 'off'); paintFoot(); };
        const el = h('div', { class: 'lo-row' + (it.note ? ' maybe' : ''), onClick: toggle }, cb, h('div', { class: 'rv-ic' }, icon(KIND_ICON[it.name] || 'folder', 16)),
          h('div', { class: 'rv-main' },
            h('div', { class: 'rv-name' }, h('span', { title: tr(it.name) }, tr(it.name))),
            h('div', { class: 'rv-meta', title: it.path }, mid(tilde(it.path), 26)),
            it.note ? h('div', { class: 'lo-why' }, icon('alert', 12), h('span', null, tr(it.note))) : null),
          h('span', { class: 'rv-size' }, fmtBytes(it.size)));
        attachMenu(el, () => ({ id: it.id, name: it.name, ignore: false, select: { on: lo.sel.has(it.id), toggle } }));
        return el;
      };
      if (sure.length) kids.push(h('div', { class: 'ap-sec ok', title: t('Pastas com o identificador do app ou de componentes dentro dele, agentes que executam o app e grupos declarados na assinatura.') }, icon('shield', 13), t('Do app · verificado')), ...sure.map(row));
      if (maybe.length) kids.push(h('div', { class: 'ap-sec warn', title: t('Parecem ser do app, mas não há prova. Vêm desmarcados.') }, icon('alert', 13), t('Talvez do app · revise')), ...maybe.map(row));
    }
    mount(box, kids);
  }

  function appNode(a) {
    const m = metaOf(a);
    const cb = checkbox(U.sel.has(a.id) ? 'on' : 'off', () => toggleApp(a, cb), a.running ? t('{name} está em execução', { name: a.name }) : t('Selecionar {name}', { name: a.name }));
    if (a.running) { cb.disabled = true; cb.title = t('Feche o app para desinstalar'); }
    const toggleOpen = () => {
      if (U.open.has(a.id)) U.open.delete(a.id); else { U.open.add(a.id); ensureLo(a); }
      paintRes(a, node);
    };
    const sub = [otherLabel(vendorOf(a)), lastText(m.lastUsed)].filter(Boolean).join(' · ');
    // Clicar na linha seleciona; a seta expande os arquivos relacionados. App aberto não seleciona.
    const rowEl = h('div', { class: 'am-row', onClick: () => (a.running ? toggleOpen() : toggleApp(a, cb)) },
        cb, iconBox(a, true),
        h('div', { class: 'rv-main' },
          h('div', { class: 'rv-name' }, h('span', { title: a.name }, a.name), a.running ? h('span', { class: 'badge info' }, t('Em execução')) : null, isUnused(a) ? h('span', { class: 'badge' }, t('Não usado')) : null),
          h('div', { class: 'am-sub', title: sub }, sub)),
        h('span', { class: 'rv-size' }, fmtBytes(a.size)),
        h('button', { class: 'am-chev', type: 'button', 'aria-label': t('Arquivos relacionados de {name}', { name: a.name }), 'aria-expanded': String(U.open.has(a.id)), onClick: (e) => { e.stopPropagation(); toggleOpen(); } }, icon('back', 14)));
    const node = h('div', { class: 'am-item', dataset: { app: String(a.id) } }, rowEl, h('div', { class: 'am-res', hidden: true }));
    // Botão direito: Abrir, Mostrar no Finder e Ignorar (e Selecionar quando o app pode ser desinstalado).
    attachMenu(rowEl, () => ({
      id: a.id, name: a.name, openApp: true, quickLook: false,
      select: a.running ? null : { on: U.sel.has(a.id), toggle: () => toggleApp(a, cb) },
      onIgnored: () => {
        store.apps = apps().filter((x) => x.id !== a.id);
        U.appsRef = store.apps;
        U.sel.delete(a.id); U.lo.delete(a.id); U.open.delete(a.id);
        paintAll();
      },
    }));
    if (U.open.has(a.id)) paintRes(a, node);
    return node;
  }

  // "Selecionar: Tudo/Nada/Parcial ▾" da barra da lista (refeito quando a seleção muda).
  function selBtn() {
    const selectable = visibleApps().filter((a) => !a.running);
    const nSel = selectable.filter((a) => U.sel.has(a.id)).length;
    return selectMenuButton({
      modes: [['all', t('Tudo')], ['none', t('Nada')]], mode: selectable.length && nSel === selectable.length ? 'all' : nSel ? 'part' : 'none', disabled: !selectable.length,
      onPick: (mode) => {
        for (const a of selectable) { if (mode === 'none') U.sel.delete(a.id); else { U.sel.add(a.id); ensureLo(a); } }
        paintMid(); paintMain(); paintFoot();
      },
    });
  }

  function paintMainApps() {
    const list = visibleApps();
    const prev = M.main.querySelector('.am-list');
    const top = prev ? prev.scrollTop : 0;
    const listEl = h('div', { class: 'am-list' });
    if (list.length) listEl.append(...list.map(appNode));
    else listEl.append(h('div', { class: 'rv-empty' }, U.q ? t('Nenhum aplicativo corresponde à busca.') : U.group === 'selected' ? t('Nenhum aplicativo selecionado.') : U.group === 'unused' ? t('Nenhum aplicativo sem uso há mais de 6 meses.') : t('Nenhum aplicativo encontrado.')));
    mount(M.main,
      h('div', { class: 'am-bar' },
        h('span', { class: 'am-count' }, `${tn(list.length, '{n} app', '{n} apps')} · ${fmtBytes(list.reduce((x, a) => x + a.size, 0))}`),
        selBtn()),
      listEl);
    listEl.scrollTop = top;
  }

  function paintFootApps() {
    const sel = selectedApps();
    const tot = totalFor(sel);
    const none = !sel.length;
    mount(M.foot,
      h('div', { class: 'rv-sel' }, none ? t('Nenhum app selecionado') : [h('b', null, tn(sel.length, '{n} app selecionado', '{n} apps selecionados')), h('small', null, fmtBytes(tot.bytes)), tot.loading ? h('span', { class: 'spin am-spin', title: t('Calculando restos…') }) : null]),
      h('button', { class: 'btn primary', type: 'button', disabled: none, onClick: uninstallSelected }, icon('trash', 16), t('Desinstalar')));
  }

  // ---------- desinstalação em lote ----------
  async function uninstallSelected() {
    const list = selectedApps().filter((a) => !a.running);
    if (!list.length) return;
    ctx.setBusy(true);
    await Promise.all(list.map((a) => ensureLo(a)));
    ctx.setBusy(false);
    if (!ctx.alive) return;
    const tot = totalFor(list);
    const ok = await confirmDialog({
      title: list.length === 1 ? t('Desinstalar {name}?', { name: list[0].name }) : t('Desinstalar {n} apps?', { n: fmtNum(list.length) }),
      permanentTitle: list.length === 1 ? t('Apagar {name} definitivamente?', { name: list[0].name }) : t('Apagar {n} apps definitivamente?', { n: fmtNum(list.length) }),
      body: [h('strong', null, t('Os apps e os itens selecionados vão para o Lixo')), t('. São {size} no total ({apps} + {rest}). Você pode restaurá-los de lá até esvaziar a Lixeira.', {
        size: fmtBytes(tot.bytes), apps: tn(list.length, '{n} aplicativo', '{n} aplicativos'), rest: tn(tot.rest, '{n} resto', '{n} restos'),
      })],
      confirm: t('Desinstalar'), glyph: 'trash', mod: 'apps',
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
    st.show(h('h1', { class: 'h1' }, t('Desinstalando…')), h('div', { class: 'group-list' }, [...rows.values()]));
    const sd = stopDock(ctx, 'apps');

    const failures = [];
    let freed = 0, okCount = 0, finished = 0;
    for (const app of list) {
      const row = rows.get(app.id);
      if (sd.stopped()) { row.dataset.st = 'fail'; failures.push({ name: app.name, path: app.path, error: t('cancelado; o app continua instalado') }); continue; }
      row.dataset.st = 'run';
      mount(row.querySelector('.st'), h('span', { class: 'spin' }));
      const lo = U.lo.get(app.id);
      const names = new Map([[app.id, { name: app.name, path: app.path }], ...(lo && lo.result ? lo.result.groups.flatMap((g) => g.items.map((i) => [i.id, { name: tr(i.name), path: i.path }])) : [])]);
      let res = null;
      try { res = await api.uninstall(app.id, lo ? [...lo.sel] : [], permanent); } catch (e) { /* toast já exibido */ }
      finished++;
      let appOk = false;
      if (res) {
        appOk = !res.outcomes.some((o) => !o.ok && o.id === app.id);
        freed += res.freed || 0;
        for (const o of res.outcomes) if (!o.ok) failures.push({ name: (names.get(o.id) || {}).name || t('Item {id}', { id: o.id }), path: (names.get(o.id) || {}).path, error: tr(o.error) });
      } else failures.push({ name: app.name, path: app.path, error: t('Não foi possível desinstalar. O app pode estar aberto.') });
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
    U.done = { headline: tn(okCount, '{n} aplicativo desinstalado', '{n} aplicativos desinstalados'), freed, failed: failures.length, permanent, again: () => { U.pane = 'uninstaller'; U.group = 'all'; } };
    U.phase = okCount || failures.length ? 'done' : back;
    render();
    if (failures.length) failuresSheet(failures);
  }

  // ---------- Atualizador ----------
  function visibleUpdates() {
    const q = U.q.trim().toLowerCase();
    const map = byId();
    return updates().map((u) => ({ u, a: map.get(u.appId) })).filter(({ a }) => a && (!q || a.name.toLowerCase().includes(q)))
      .sort((x, y) => cmp(x.a.name, y.a.name));
  }

  function paintMidUpdater() {
    if (!U.over) { mount(M.mid, h('h3', null, t('Atualizador')), noScan(t('Analise seu Mac para ver as atualizações.'))); return; }
    const list = visibleUpdates();
    const allSel = list.length > 0 && list.every(({ a }) => U.upSel.has(a.id));
    const head = [h('h3', null, t('Atualizador')), h('p', { class: 'am-desc' }, t('Acompanhe as versões mais recentes dos seus apps.'))];
    if (!list.length) { mount(M.mid, head, h('div', { class: 'am-empty' }, U.q ? t('Nenhum app corresponde à busca.') : t('Todos os apps com fonte de atualização estão em dia.'))); return; }
    mount(M.mid, head,
      h('div', { class: 'am-selrow' }, t('Selecionar:'), h('button', { class: 'link', type: 'button', onClick: () => { for (const { a } of list) { if (allSel) U.upSel.delete(a.id); else U.upSel.add(a.id); } paintMid(); paintFoot(); } }, allSel ? t('Nenhum') : t('Todos'))),
      list.map(({ u, a }) => {
        const cb = checkbox(U.upSel.has(a.id) ? 'on' : 'off', () => { if (U.upSel.has(a.id)) U.upSel.delete(a.id); else U.upSel.add(a.id); cb.set(U.upSel.has(a.id) ? 'on' : 'off'); paintFoot(); }, t('Selecionar {name}', { name: a.name }));
        return h('div', { class: 'am-up', 'aria-current': String(U.upFocus === a.id), onClick: () => { U.upFocus = a.id; paintMid(); paintMain(); } },
          cb, iconBox(a, true),
          h('div', { class: 'rv-main' }, h('div', { class: 'rv-name' }, h('span', { title: a.name }, a.name)), h('div', { class: 'am-sub' }, `${u.current} → ${u.latest}`)));
      }));
  }

  function paintMainUpdater() {
    if (!U.over) { mount(M.main, noScan(t('Analise seu Mac para ver atualizações disponíveis.'))); return; }
    const u = updates().find((x) => x.appId === U.upFocus);
    const a = u && byId().get(u.appId);
    if (!a) { mount(M.main, h('div', { class: 'rv-empty' }, updates().length ? t('Selecione um app para ver os detalhes da atualização.') : t('Nenhuma atualização disponível.'))); return; }
    const src = hostOf(u.downloadUrl || u.notesUrl || '');
    mount(M.main, h('div', { class: 'am-detail enter' },
      h('div', { class: 'am-d-head' }, iconBox(a, false, 'ax-ic'), h('div', { style: 'min-width:0' }, h('h3', { title: a.name }, a.name), h('p', null, a.running ? t('Em execução') : t('Atualização disponível')))),
      h('dl', { class: 'am-d-list' },
        h('dt', null, t('Versão instalada')), h('dd', null, u.current),
        h('dt', null, t('Versão disponível')), h('dd', null, u.latest),
        src ? [h('dt', null, t('Fonte')), h('dd', { title: src }, src)] : null),
      h('p', { class: 'am-d-note' }, t('O Limpae só avisa e abre a página da atualização no navegador. A instalação é feita por você, no próprio app.')),
      h('div', { class: 'row-actions', style: 'margin-top:16px' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => openUpdates([a.id]) }, icon('refresh', 15), t('Abrir página de atualização')))));
  }

  function paintFootUpdater() {
    if (!U.over) { mount(M.foot, h('div', { class: 'rv-sel' }, t('Análise necessária')), h('button', { class: 'btn primary', type: 'button', onClick: scan }, t('Analisar'))); return; }
    const ids = updates().filter((u) => U.upSel.has(u.appId)).map((u) => u.appId);
    mount(M.foot,
      h('div', { class: 'rv-sel' }, ids.length ? h('b', null, tn(ids.length, '{n} atualização selecionada', '{n} atualizações selecionadas')) : t('Nenhuma atualização selecionada')),
      h('button', { class: 'btn primary', type: 'button', disabled: !ids.length, onClick: () => openUpdates(ids) }, icon('refresh', 16), t('Atualizar||update')));
  }

  // ---------- Restos e instaladores ----------
  const restosRes = () => (U.restGroup === 'installers' ? U.over.installers : U.over.leftovers);
  const restosSel = () => (U.restGroup === 'installers' ? U.instSel : U.leftSel);

  function paintMidRestos() {
    if (!U.over) { mount(M.mid, h('h3', null, t('Restos')), noScan(t('Analise seu Mac para ver restos e instaladores.'))); return; }
    const row = (id, label, res) => {
      const n = res.groups.reduce((a, g) => a + g.items.length, 0);
      return h('button', { class: 'am-grp two', type: 'button', 'aria-current': String(U.restGroup === id), onClick: () => { U.restGroup = id; paintMid(); paintMain(); paintFoot(); } },
        h('span', { title: label }, label), h('span', { class: 'n' }, n ? `${n} · ${fmtBytes(res.total)}` : '0'));
    };
    mount(M.mid, h('h3', null, t('Restos')), h('p', { class: 'am-desc' }, t('Dados de apps que já foram removidos e instaladores que podem ser baixados de novo.')),
      row('leftovers', t('Restos de apps'), U.over.leftovers), row('installers', t('Instaladores'), U.over.installers),
      U.over.leftovers.needsFda ? h('p', { class: 'am-desc', style: 'margin-top:14px' }, t('Sem Acesso Total ao Disco, parte de ~/Library pode não aparecer aqui.')) : null);
  }

  function paintMainRestos() {
    if (!U.over) { mount(M.main, noScan(t('Analise seu Mac para ver restos e instaladores.'))); return; }
    const res = restosRes(), sel = restosSel();
    const q = U.q.trim().toLowerCase();
    const groups = res.groups.map((g) => ({ g, items: g.items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.path.toLowerCase().includes(q)) })).filter((x) => x.items.length);
    const prev = M.main.querySelector('.am-list');
    const top = prev ? prev.scrollTop : 0;
    const listEl = h('div', { class: 'am-list' });
    if (!groups.length) listEl.append(h('div', { class: 'rv-empty' }, q ? t('Nenhum item corresponde à busca.') : U.restGroup === 'installers' ? t('Nenhum instalador encontrado.') : t('Nenhum resto de app encontrado.')));
    for (const { g, items } of groups) {
      const state = () => { const n = items.filter((i) => sel.has(i.id)).length; return n === 0 ? 'off' : n === items.length ? 'on' : 'mixed'; };
      const gcb = checkbox(state(), (s0) => { for (const i of items) { if (s0 === 'on') sel.delete(i.id); else sel.add(i.id); } paintMain(); paintFoot(); }, t('Selecionar grupo {name}', { name: tr(g.title) }));
      listEl.append(h('div', { class: 'am-sec' }, gcb, h('div', { class: 'rv-main' }, h('b', { title: tr(g.title) }, tr(g.title)), h('span', null, tr(g.description))), h('span', { class: 'rv-size' }, fmtBytes(items.reduce((x, i) => x + i.size, 0)))));
      for (const it of items) {
        const cb = checkbox(sel.has(it.id) ? 'on' : 'off', () => toggle(), t('Selecionar {name}', { name: it.name }));
        const toggle = () => { if (sel.has(it.id)) sel.delete(it.id); else sel.add(it.id); cb.set(sel.has(it.id) ? 'on' : 'off'); gcb.set(state()); paintFoot(); };
        // Por que um item não vem marcado (ou o que ele é) fica à vista: selo curto ao lado do nome, nota longa em linha própria.
        const longNote = !!it.note && it.note.length > 30;
        const row = h('div', { class: 'rv-item am-it' + (longNote ? ' has-note' : ''), onClick: toggle }, cb, // i18n-ignore
          h('div', { class: 'rv-ic' }, icon(U.restGroup === 'installers' ? 'disk' : groupIcon('leftovers'), 16)),
          h('div', { class: 'rv-main' },
            h('div', { class: 'rv-name' }, h('span', { title: it.name }, it.name), it.note && !longNote ? h('span', { class: 'badge' + (it.selected ? ' info' : ''), title: tr(it.note) }, tr(it.note)) : null),
            h('div', { class: 'rv-meta' }, mid(it.path, 24)),
            longNote ? h('div', { class: 'rv-note' + (it.selected ? ' info' : ''), title: tr(it.note) }, tr(it.note)) : null),
          h('span', { class: 'rv-size' }, fmtBytes(it.size)),
          h('button', { class: 'icon-btn rv-act', type: 'button', title: t('Mostrar no Finder'), 'aria-label': t('Mostrar {name} no Finder', { name: it.name }), onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 16)));
        attachMenu(row, () => ({ id: it.id, name: it.name, ignore: false, select: { on: sel.has(it.id), toggle } }));
        listEl.append(row);
      }
    }
    mount(M.main, listEl);
    listEl.scrollTop = top;
  }

  function paintFootRestos() {
    if (!U.over) { mount(M.foot, h('div', { class: 'rv-sel' }, t('Análise necessária')), h('button', { class: 'btn primary', type: 'button', onClick: scan }, t('Analisar'))); return; }
    const { bytes, count } = selectedSize(restosRes(), restosSel());
    mount(M.foot,
      h('div', { class: 'rv-sel' }, count ? [h('b', null, tn(count, '{n} item selecionado', '{n} itens selecionados')), h('small', null, fmtBytes(bytes))] : t('Nenhum item selecionado')),
      h('button', { class: 'btn primary', type: 'button', disabled: !count, onClick: () => removeResult(U.restGroup) }, icon('trash', 16), t('Remover')));
  }

  render();
}
