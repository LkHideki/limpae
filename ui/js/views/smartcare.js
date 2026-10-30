// Faxina: landing -> varredura sequencial (bento) -> resultados -> execução -> conclusão.
// Roda só os módulos ligados em Ajustes (store.settings.smartCare; ausente = ligado). Só Limpeza e Lixeira executam algo;
// Proteção, Desempenho, Aplicativos e Meus Arquivos são somente revisão.
import { play } from '../sound.js';
import { h, mount, sleep } from '../dom.js';
import { orb, icon } from '../art.js';
import { api } from '../api.js';
import { store, selectedSize, selectedIds, pruneResult, countItems } from '../store.js';
import { fmtBytes, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, features, checkbox } from '../ui.js';
import { removeGroups, stopDock } from '../actions.js';

// key = chave em settings.smartCare; tasks = valores de `task` do evento scan-progress; run = executa algo ao "Executar".
const MODS = [
  { id: 'clean', key: 'junk', mod: 'clean', title: 'Limpeza', verb: 'Procurando lixo…', glyph: 'clean', tasks: ['junk'], run: true, feat: ['search', 'Busca de lixo do sistema'] },
  { id: 'trash', key: 'trash', mod: 'trash', title: 'Lixeira', verb: 'Verificando a Lixeira…', glyph: 'trash', tasks: ['trash'], run: true, feat: ['trash', 'Verificação da Lixeira'] },
  { id: 'protect', key: 'protection', mod: 'protect', title: 'Proteção', verb: 'Verificando a segurança…', glyph: 'shield', tasks: [], feat: ['shield', 'Verificação de segurança do Mac'] },
  { id: 'perf', key: 'performance', mod: 'perf', title: 'Desempenho', verb: 'Analisando o desempenho…', glyph: 'bolt', tasks: ['perf'], feat: ['bolt', 'Agentes e itens de login'] },
  { id: 'apps', key: 'apps', mod: 'apps', title: 'Aplicativos', verb: 'Verificando atualizações…', glyph: 'apps', tasks: ['apps', 'apps_overview'], feat: ['apps', 'Atualizações e apps sem uso'] },
  { id: 'files', key: 'files', mod: 'files', title: 'Meus Arquivos', verb: 'Analisando seu armazenamento…', glyph: 'folder', tasks: ['large'], feat: ['folder', 'Arquivos grandes esquecidos'] },
];
const byId = (id) => MODS.find((m) => m.id === id);
const LARGE_MB = 500;
const tail = (p) => (p.length > 56 ? '…' + p.slice(-55) : p);
const layout = (n) => (n <= 3 ? [n] : n === 4 ? [2, 2] : n === 5 ? [3, 2] : [3, 3]);

export function enter(ctx) {
  const S = store.smart;
  const root = ctx.root;
  if (S.phase !== 'idle' && S.rev !== store.rev) { S.phase = 'idle'; S.err = {}; }
  S.err = S.err || {};
  if (!['idle', 'results', 'done'].includes(S.phase)) S.phase = 'idle';
  let cancelled = false, active = null, hooked = false;
  const els = {};          // id -> {el, ticker, list, verb, cb}
  let head, rows, bento;

  const enabled = () => {
    const sc = (store.settings && store.settings.smartCare) || {};
    return MODS.filter((m) => sc[m.key] !== false);
  };
  const mods = () => S.mods.map(byId).filter(Boolean);

  // ---------- resumo de cada módulo (texto do tile) ----------
  // {num, sub, sm: número em corpo menor, review: mostra "Revisar", act: tem algo executável}
  function summarize(m) {
    if (S.err[m.id]) return { num: 'Indisponível', sub: 'tente de novo no módulo', sm: true, review: true };
    if (m.id === 'clean') {
      const { bytes } = selectedSize(store.junk, store.junkSel);
      const has = store.junk && store.junk.groups.length > 0;
      return bytes > 0 ? { num: `${fmtBytes(bytes)} de lixo`, sub: 'para limpar', review: true, act: true }
        : { num: has ? 'Nada pré-selecionado' : 'Sem lixo', sub: has ? 'revise para escolher' : 'nada para limpar', sm: true, review: has };
    }
    if (m.id === 'trash') {
      const t = store.trash;
      const n = t ? countItems(t) : 0;
      if (t && t.needsFda && !n) return { num: 'Requer acesso', sub: 'Acesso Total ao Disco', sm: true, review: true };
      return n && t.total > 0 ? { num: `${fmtBytes(t.total)} na Lixeira`, sub: 'para esvaziar', review: true, act: true }
        : { num: 'Lixeira vazia', sub: 'nada para esvaziar', sm: true };
    }
    if (m.id === 'protect') {
      const c = S.sum.protect || { bad: 0, unknown: 0 };
      return c.bad ? { num: plural(c.bad, 'ponto de atenção', 'pontos de atenção'), sub: 'para revisar', review: true }
        : { num: 'Tudo em ordem', sub: c.unknown ? `${plural(c.unknown, 'item não verificado', 'itens não verificados')}` : 'nenhum ponto de atenção', sm: true, review: true };
    }
    if (m.id === 'perf') {
      const p = S.sum.perf || { flagged: 0, login: 0 };
      const login = p.needsAutomation ? 'itens de login: requer permissão' : p.loginErr ? 'itens de login indisponíveis' : `${plural(p.login, 'item', 'itens')} de login`;
      return p.flagged ? { num: plural(p.flagged, 'agente pede atenção', 'agentes pedem atenção'), sub: login, review: true }
        : { num: 'Tudo em ordem', sub: login, sm: true, review: true };
    }
    if (m.id === 'apps') {
      const a = S.sum.apps || { updates: 0, unused: 0 };
      const un = a.unused ? plural(a.unused, 'app sem uso', 'apps sem uso') : 'nenhum app sem uso';
      return a.updates ? { num: plural(a.updates, 'atualização', 'atualizações'), sub: un, review: true }
        : { num: 'Tudo atualizado', sub: un, sm: true, review: true };
    }
    const n = store.large ? countItems(store.large) : 0;
    const lim = `acima de ${fmtBytes(store.largeMb * 1e6)}`;
    return n ? { num: plural(n, 'arquivo grande', 'arquivos grandes'), sub: `${fmtBytes(store.large.total)} no total`, review: true }
      : { num: 'Nenhum arquivo grande', sub: lim, sm: true };
  }
  // Depois da análise vale o retrato tirado nela: a Lixeira e o lixo mudam durante a execução.
  const info = (m) => S.snap[m.id] || summarize(m);
  const checkable = (m) => !!m.run && !!info(m).act;
  const included = (m) => checkable(m) && !!S.inc[m.id];

  // ---------- pintura dos tiles ----------
  // st: wait | hot | found | done | clean (executando) | queue (aguardando execução) | off (fora da execução) | final
  function paint(m, st) {
    const e = els[m.id];
    const sm = info(m);
    const o = S.out[m.id];
    const skip = checkable(m) && !S.inc[m.id] && (st === 'done' || st === 'final' || st === 'off');
    e.el.dataset.st = st;
    e.el.classList.toggle('hot', st === 'hot' || st === 'clean');
    e.el.classList.toggle('skipped', skip);
    e.el.classList.toggle('dim', st === 'off' && !skip);
    e.verb.textContent = st === 'clean' ? (m.id === 'trash' ? 'Esvaziando a Lixeira…' : 'Limpando lixo…') : m.verb;
    let main = null;
    const num = (txt, small) => h('div', { class: 't-num' + (small ? ' sm' : '') }, txt);
    const sub = (...k) => h('div', { class: 't-sub' }, ...k);
    if (st === 'wait') main = h('div', { class: 't-main' }, sub('Aguardando…'));
    else if (st === 'found' || st === 'done' || st === 'queue' || st === 'off') {
      let line = sm.sub;
      if (st === 'queue') line = 'aguardando…';
      else if (checkable(m) && !S.inc[m.id] && st !== 'found') line = 'Pulado';
      else if (st === 'done' && m.id === 'trash' && S.inc.trash) line = 'esvaziar (permanente)';
      main = h('div', { class: 't-main' }, num(sm.num, sm.sm), sub(line));
    } else if (st === 'final') {
      const failTxt = { partial: 'em parte', failed: 'não concluído' };
      if (o === 'cleaned' || o === 'emptied' || o === 'partial') {
        const what = m.id === 'trash' ? 'Esvaziada' : 'Limpo';
        const freed = S.freed[m.id] || 0;
        main = h('div', { class: 't-main' }, num(m.id === 'trash' ? `${fmtBytes(freed)} da Lixeira` : `${fmtBytes(freed)} de lixo`),
          sub(h('i', { class: 'dot' + (o === 'partial' ? ' warn' : '') }), o === 'partial' ? `${what} ${failTxt.partial}` : what));
      } else if (o === 'failed') main = h('div', { class: 't-main' }, num('Não concluído', true), sub(h('i', { class: 'dot warn' }), 'Falhou'));
      else if (o === 'stopped') main = h('div', { class: 't-main' }, num(sm.num, sm.sm), sub(h('i', { class: 'dot warn' }), 'Interrompido'));
      else if (o === 'skipped') main = h('div', { class: 't-main' }, num(sm.num, sm.sm), sub('Pulado'));
      else main = h('div', { class: 't-main' }, num(sm.num, sm.sm),
        sub(h('i', { class: 'dot' }), sm.review ? h('button', { class: 'link t-link', type: 'button', onClick: () => go(m) }, 'Revisar') : 'Nada a fazer'));
    }
    const old = e.el.querySelector('.t-main');
    if (old) old.remove();
    if (main) e.el.append(main);
    const rv = e.el.querySelector('.t-review');
    if (rv) rv.remove();
    e.el.classList.toggle('has-rv', st === 'done' && S.phase === 'results' && !!sm.review);
    if (st === 'done' && S.phase === 'results' && sm.review) {
      e.el.append(h('div', { class: 't-review' }, h('button', { class: 'btn sm', type: 'button', 'aria-label': `Revisar ${m.title}`, onClick: () => go(m) }, 'Revisar')));
    }
    if (e.cb) {
      e.cb.parentElement.hidden = !checkable(m);
      e.cb.set(S.inc[m.id] ? 'on' : 'off');
    }
    rows.forEach((r) => r.classList.toggle('hot', !!r.querySelector('.tile.hot')));
  }

  // "Revisar": leva ao módulo com o resultado já carregado (store).
  function go(m) {
    if (m.id === 'clean') store.cleanup.phase = store.junk && store.junk.groups.length ? 'review' : 'idle';
    else if (m.id === 'files') store.files.phase = 'review';
    else if (m.id === 'apps') primeApps();
    ctx.nav(m.id);
  }

  // Entrega ao módulo Aplicativos o resultado da análise (mesma forma de `newState()` em apps.js, v2; se mudar, o
  // módulo descarta o estado e abre na tela inicial).
  function primeApps() {
    const a = S.apps;
    if (!a || !store.apps) return;
    const ov = a.ov;
    store.appsUi = {
      v: 2, phase: 'results', over: { updates: ov.updates || [], unused: new Set(ov.unused || []), leftovers: ov.leftovers, installers: ov.installers },
      meta: new Map((a.meta || []).map((x) => [x.appId, x])), appsRef: store.apps,
      q: '', sort: 'size', dir: 'desc', pane: 'uninstaller', group: 'all',
      sel: new Set(), open: new Set(), lo: new Map(),
      upSel: new Set(), upFocus: (ov.updates && ov.updates[0]) ? ov.updates[0].appId : null,
      leftSel: selectedIds(ov.leftovers), instSel: selectedIds(ov.installers), restGroup: 'leftovers', done: null,
    };
  }

  function setHead(text, left) {
    mount(head, h('span', null, text), left || null);
  }

  function buildBento() {
    const list = mods();
    head = h('div', { class: 'bento-head' });
    let at = 0;
    rows = layout(list.length).map((n) => {
      const kids = list.slice(at, at + n).map((m) => {
        const ticker = h('div', { class: 't-ticker' });
        const listEl = h('div', { class: 't-list' });
        const verb = h('div', { class: 't-verb' }, m.verb);
        let cb = null, cbWrap = null;
        if (m.run) {
          const label = m.id === 'trash' ? 'Incluir o esvaziamento da Lixeira (permanente)' : `Incluir ${m.title} na execução`;
          cb = checkbox(S.inc[m.id] ? 'on' : 'off', (state) => toggleInclude(m, state !== 'on'), label);
          cbWrap = h('span', { class: 't-cb' }, cb);
        }
        const el = h('div', { class: 'tile', dataset: { mod: m.mod, id: m.id, st: 'wait' } },
          h('div', { class: 'tile-fill' }), h('div', { class: 'tile-orb' }, orb(m.mod, 168, m.glyph)),
          h('div', { class: 't-top' }, cbWrap, h('div', { class: 't-label' }, m.title)), verb, ticker, listEl);
        els[m.id] = { el, ticker, list: listEl, verb, cb };
        return el;
      });
      at += n;
      return h('div', { class: 'brow' }, kids);
    });
    bento = h('div', { class: 'bento', dataset: { n: list.length, phase: S.phase } }, rows);
    mount(root, h('div', { class: 'col enter' }, head, bento));
  }

  function toggleInclude(m, on) {
    S.inc[m.id] = on;
    paint(m, 'done');
    updateDock();
  }

  const plan = () => mods().filter(included);

  function updateDock() {
    const n = plan().length;
    ctx.setDock({ label: 'Executar', mod: 'smart', disabled: n === 0, onClick: execute });
  }

  // ---------- idle ----------
  function renderIdle() {
    ctx.reserveDock(true);
    const list = enabled();
    const st = stage('smart', 'smart', 270);
    const items = list.length
      ? [features('smart', list.map((m) => m.feat)),
        h('div', { class: 'row-actions sc-scope' }, h('button', { class: 'link', type: 'button', onClick: () => ctx.nav('settings') }, 'Escolher módulos nos Ajustes'))]
      : [h('p', { class: 'sub' }, 'Nenhum módulo está incluído no Faxina.'),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => ctx.nav('settings') }, icon('gear', 15), 'Abrir Ajustes'))];
    st.show(h('h1', { class: 'h1' }, 'Faxina'), list.length ? h('p', { class: 'sub' }, 'Manutenção rápida que cuida do essencial.') : null, ...items);
    mount(root, st.el);
    ctx.setDock({ label: 'Analisar', mod: 'smart', disabled: !list.length, onClick: run });
  }

  // ---------- scan ----------
  async function load(m) {
    if (m.id === 'clean') { store.junk = await api.junk(); store.junkSel = selectedIds(store.junk); store.cleanup.phase = store.junk.groups.length ? 'summary' : 'idle'; }
    else if (m.id === 'trash') store.trash = await api.trash();
    else if (m.id === 'protect') {
      const checks = await api.securityChecks();
      S.sum.protect = { bad: checks.filter((c) => c.ok === false).length, unknown: checks.filter((c) => c.ok == null).length };
    } else if (m.id === 'perf') {
      const r = await api.perfScan();
      S.sum.perf = { flagged: r.agents.filter((a) => a.flagged).length, login: r.login.items.length, needsAutomation: !!r.login.needsAutomation, loginErr: !!r.login.error };
    } else if (m.id === 'apps') {
      store.apps = await api.apps();
      const ov = await api.appsOverview();
      const meta = await api.appMeta().catch(() => []);
      S.apps = { ov, meta };
      const ids = new Set(store.apps.map((a) => a.id));
      S.sum.apps = { updates: (ov.updates || []).filter((u) => ids.has(u.appId)).length, unused: (ov.unused || []).filter((id) => ids.has(id)).length };
    } else { store.largeMb = LARGE_MB; store.large = await api.large(LARGE_MB); store.largeSel = new Set(); }
  }

  async function run() {
    if (!store.settings) { try { store.settings = await api.settings(); } catch (e) { /* segue com todos os módulos */ } }
    const list = enabled();
    if (!list.length) return renderIdle();
    cancelled = false;
    S.phase = 'scan'; S.err = {}; S.mods = list.map((m) => m.id); S.sum = {}; S.snap = {}; S.out = {}; S.freed = {}; S.apps = null;
    S.inc = { clean: true, trash: false };
    play('start');
    ctx.setBusy(true);
    ctx.reserveDock(true);
    buildBento();
    list.forEach((m) => paint(m, 'wait'));
    setHead('Analisando seu Mac…');
    if (!hooked) {
      hooked = true;
      ctx.onProgress((p) => { const m = byId(active); if (m && m.tasks.includes(p.task)) els[m.id].ticker.textContent = tail(p.path || ''); });
    }
    ctx.setDock({ label: 'Parar', busy: true, mod: 'smart', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true }); api.cancel().catch(() => {}); } });
    await sleep(120);
    for (const m of list) {
      if (cancelled) break;
      active = m.id;
      paint(m, 'hot');
      els[m.id].ticker.textContent = m.id === 'protect' ? 'Gatekeeper · SIP · FileVault · Firewall' : '';
      try { await Promise.all([load(m), sleep(700)]); } catch (e) { if (cancelled) break; S.err[m.id] = true; }
      if (cancelled) break;
      paint(m, 'found');
    }
    active = null;
    if (!ctx.alive) return;
    ctx.setBusy(false);
    if (cancelled) { S.phase = 'idle'; renderIdle(); return; }
    S.phase = 'results'; S.rev = store.rev;
    S.snap = {};
    for (const m of list) S.snap[m.id] = summarize(m);
    // Sem dado para executar, o tile não entra no plano.
    for (const id of ['clean', 'trash']) if (S.mods.includes(id) && !checkable(byId(id))) S.inc[id] = false;
    const failedAll = list.every((m) => S.err[m.id]);
    play(failedAll ? 'error' : 'found');
    renderResults();
  }

  function renderResults() {
    bento.dataset.phase = 'results';
    mods().forEach((m) => paint(m, 'done'));
    const any = plan().length > 0 || mods().some((m) => checkable(m));
    setHead(any ? 'Suas tarefas estão prontas. Veja o que encontramos:' : 'Análise concluída. Veja o que encontramos:',
      h('button', { class: 'btn sm ghost left', type: 'button', onClick: confirmRestart }, icon('restart', 14), 'Recomeçar'));
    ctx.reserveDock(true);
    updateDock();
  }

  // ---------- execute ----------
  // Resumo do que a confirmação vai dizer, a partir do que está marcado agora.
  function describe() {
    const out = { clean: null, trash: null };
    if (included(byId('clean'))) {
      const { bytes, count } = selectedSize(store.junk, store.junkSel);
      let moved = 0;
      for (const g of store.junk.groups) for (const i of g.items) if (store.junkSel.has(i.id) && i.trash) moved++;
      out.clean = { bytes, count, moved, perm: count - moved };
    }
    if (included(byId('trash'))) out.trash = { bytes: store.trash.total, count: countItems(store.trash), vols: store.trash.groups.length };
    return out;
  }

  function planNode(d) {
    const nodes = [];
    const row = (mod, glyph, name, bytes, detail, warn) => {
      const detailEl = h('div', { class: 'sc-plan-d' + (warn ? ' warn' : '') }, detail);
      return { detailEl, node: h('div', { class: 'sc-plan-row', dataset: { mod } },
        h('span', { class: 'sc-plan-ic' }, icon(glyph, 16)),
        h('div', { class: 'sc-plan-t' }, h('b', null, name), detailEl),
        h('span', { class: 'sc-plan-sz' }, fmtBytes(bytes))) };
    };
    const cleanDetail = (perm) => {
      const c = d.clean;
      if (perm) return `${plural(c.count, 'item apagado', 'itens apagados')} definitivamente.`;
      const parts = [];
      if (c.perm) parts.push(`${plural(c.perm, 'item regenerável apagado', 'itens regeneráveis apagados')} direto`);
      if (c.moved) parts.push(`${plural(c.moved, 'item vai', 'itens vão')} para o Lixo (recuperável)`);
      return parts.join(' · ') + '.';
    };
    let cleanRow = null;
    if (d.clean) { cleanRow = row('clean', 'clean', 'Limpeza', d.clean.bytes, cleanDetail(false)); nodes.push(cleanRow.node); }
    if (d.trash) {
      const t = row('trash', 'trash', d.trash.vols > 1 ? 'Lixeiras' : 'Lixeira', d.trash.bytes,
        `${plural(d.trash.count, 'item excluído', 'itens excluídos')} permanentemente. Não dá para desfazer.`, true);
      nodes.push(t.node);
    }
    return { el: h('div', { class: 'sc-plan' }, nodes), setPerm: (p) => { if (cleanRow) cleanRow.detailEl.textContent = cleanDetail(p); } };
  }

  async function execute() {
    const d = describe();
    const tasks = plan();
    if (!tasks.length) return;
    const pl = planNode(d);
    const movedAny = d.clean && d.clean.moved > 0;
    const pending = confirmDialog({
      title: `Executar ${plural(tasks.length, 'tarefa', 'tarefas')}?`,
      body: 'Confira o que vai acontecer:',
      confirm: 'Executar', danger: !!d.trash, glyph: d.trash ? 'trash' : 'clean', mod: d.trash ? 'trash' : 'clean',
      permanentChoice: movedAny, permanentDefault: !!(store.settings && store.settings.permanentDelete),
    });
    // O corpo do diálogo some quando "Apagar definitivamente" está ligado; o resumo fica fora dele e acompanha a chave.
    const card = Array.from(document.querySelectorAll('#modal-root .modal')).pop();
    if (card) {
      const body = card.querySelector('.body');
      if (body) body.after(pl.el);
      const sw = card.querySelector('.switch');
      if (sw) {
        pl.setPerm(sw.getAttribute('aria-checked') === 'true');
        new MutationObserver(() => pl.setPerm(sw.getAttribute('aria-checked') === 'true')).observe(sw, { attributes: true, attributeFilter: ['aria-checked'] });
      }
    }
    const ok = await pending;
    if (!ok) return;

    S.phase = 'cleaning';
    bento.dataset.phase = 'cleaning';
    ctx.setBusy(true);
    S.out = {}; S.freed = {};
    const trashRes = store.trash;
    const cleanSel = store.junkSel;
    mods().forEach((m) => { if (checkable(m) && !tasks.includes(m)) S.out[m.id] = 'skipped'; });
    mods().forEach((m) => paint(m, tasks.includes(m) ? 'queue' : 'off'));
    setHead('Executando suas tarefas…');
    const sd = stopDock(ctx, 'smart');
    const countGroups = (m) => (m.id === 'clean' ? store.junk.groups.filter((g) => g.items.some((i) => cleanSel.has(i.id))).length : trashRes.groups.length);
    const grand = tasks.reduce((a, m) => a + countGroups(m), 0) || 1;
    let base = 0, anyOk = false, anyFail = false, stopped = false;
    const failures = [];
    for (const m of tasks) {
      if (sd.stopped()) { S.out[m.id] = 'stopped'; stopped = true; paint(m, 'final'); continue; }
      const result = m.id === 'clean' ? store.junk : trashRes;
      const sel = m.id === 'clean' ? cleanSel : new Set(trashRes.groups.flatMap((g) => g.items.map((i) => i.id)));
      const groups = result.groups.filter((g) => g.items.some((i) => sel.has(i.id)));
      const label = (g) => (m.id === 'trash' && g.id === 'trash' ? 'Lixeira do Mac' : g.title);
      const rowsEl = new Map(groups.map((g) => [g.id, h('div', { class: 'prog-row', dataset: { st: 'wait' } }, h('span', { class: 'nm', title: label(g) }, label(g)), h('span', { class: 'sz' }, ''), h('span', { class: 'st' }))]));
      mount(els[m.id].list, [...rowsEl.values()]);
      paint(m, 'clean');
      const res = await removeGroups(result, sel, (g, status, inf) => {
        const row = rowsEl.get(g.id);
        row.dataset.st = status;
        const stEl = row.querySelector('.st');
        if (status === 'run') mount(stEl, h('span', { class: 'spin' }));
        else { mount(stEl, icon(status === 'done' ? 'check' : 'alert', 16)); row.querySelector('.sz').textContent = fmtBytes(inf.freed); sd.progress((base + inf.done) / grand); }
      }, { permanent: ok === 'permanent' && m.id === 'clean', stopped: sd.stopped });
      base += groups.length;
      await sleep(400);
      S.freed[m.id] = res.freed;
      failures.push(...res.failures);
      const good = res.okIds.size > 0;
      S.out[m.id] = !res.failures.length ? (m.id === 'trash' ? 'emptied' : 'cleaned') : good ? 'partial' : 'failed';
      if (sd.stopped() && res.failures.length) S.out[m.id] = good ? 'partial' : 'stopped';
      anyOk = anyOk || good; anyFail = anyFail || !good;
      if (m.id === 'clean') {
        store.junk = pruneResult(store.junk, res.okIds);
        for (const id of res.okIds) store.junkSel.delete(id);
        store.cleanup.phase = store.junk.groups.length ? 'summary' : 'idle';
        if (!store.junk.groups.length) store.junk = null;
      }
      paint(m, 'final');
    }
    stopped = stopped || sd.stopped();
    // O Lixo e a Lixeira mudaram: a Lixeira é lida de novo ao abrir o módulo.
    store.trash = null;
    S.phase = 'done'; S.rev = store.rev;
    S.stopped = stopped;
    play(anyOk || !anyFail ? 'clean' : 'error');
    if (anyOk && !stopped) api.markSmartCare().catch(() => {});
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    renderDone();
    if (failures.length) failuresSheet(failures);
  }

  function renderDone() {
    bento.dataset.phase = 'done';
    mods().forEach((m) => paint(m, 'final'));
    setHead(S.stopped ? 'Execução interrompida. O que já rodou foi concluído.' : 'Muito bem! Seu Mac está em ótima forma.',
      h('button', { class: 'btn sm ghost left', type: 'button', onClick: restart }, icon('restart', 14), 'Recomeçar'));
    ctx.setDock(null);
    root.append(h('div', { class: 'bento-foot enter' }, h('button', { class: 'btn sm', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 14), 'Ver log')));
  }

  async function confirmRestart() {
    const ok = await confirmDialog({
      title: 'Recomeçar a análise?', body: 'Os resultados e as marcações atuais serão descartados. Nada foi removido até agora.',
      confirm: 'Recomeçar', glyph: 'restart', mod: 'smart',
    });
    if (ok) restart();
  }

  function restart() {
    S.phase = 'idle'; S.out = {}; S.sum = {}; S.snap = {}; S.freed = {}; S.inc = {}; S.apps = null; S.stopped = false;
    Object.keys(els).forEach((k) => delete els[k]);
    renderIdle();
  }

  if (!store.settings) api.settings().then((st) => { store.settings = st; if (ctx.alive && S.phase === 'idle') renderIdle(); }).catch(() => {});
  if (S.phase === 'results' && S.mods.length) { buildBento(); renderResults(); }
  else if (S.phase === 'done' && S.mods.length) { buildBento(); renderDone(); }
  else { S.phase = 'idle'; renderIdle(); }
}
