// Faxina: landing -> varredura sequencial (bento) -> resultados -> execução -> conclusão.
// Roda só os módulos ligados em Ajustes (store.settings.smartCare; ausente = ligado). Só Limpeza e Lixeira executam algo;
// Proteção, Desempenho, Aplicativos e Arquivos são somente revisão.
import { play } from '../sound.js';
import { h, mount, sleep } from '../dom.js';
import { orb, icon } from '../art.js';
import { api } from '../api.js';
import { store, selectedSize, selectedIds, pruneResult, countItems } from '../store.js';
import { fmtBytes } from '../format.js';
import { t, tn, tr } from '../i18n.js';
import { confirmDialog, failuresSheet, stage, features, checkbox } from '../ui.js';
import { removeGroups, stopDock } from '../actions.js';

// key = chave em settings.smartCare; tasks = valores de `task` do evento scan-progress; run = executa algo ao "Executar".
// Textos como getters: o idioma só é conhecido depois que o módulo carrega, e a chave precisa ficar literal.
const MODS = [
  { id: 'clean', key: 'junk', mod: 'clean', get title() { return t('Entulho'); }, get verb() { return t('Procurando lixo…'); }, glyph: 'clean', tasks: ['junk'], run: true, get feat() { return ['search', t('Busca de lixo do sistema')]; } },
  { id: 'trash', key: 'trash', mod: 'trash', get title() { return t('Lixeira'); }, get verb() { return t('Verificando a Lixeira…'); }, glyph: 'trash', tasks: ['trash'], run: true, get feat() { return ['trash', t('Verificação da Lixeira')]; } },
  { id: 'protect', key: 'protection', mod: 'protect', get title() { return t('Segurança'); }, get verb() { return t('Verificando a segurança…'); }, glyph: 'shield', tasks: [], get feat() { return ['shield', t('Verificação de segurança do Mac')]; } },
  { id: 'perf', key: 'performance', mod: 'perf', get title() { return t('Velocidade'); }, get verb() { return t('Analisando o desempenho…'); }, glyph: 'bolt', tasks: ['perf'], get feat() { return ['bolt', t('Agentes e itens de login')]; } },
  { id: 'apps', key: 'apps', mod: 'apps', get title() { return t('Aplicativos'); }, get verb() { return t('Verificando atualizações…'); }, glyph: 'apps', tasks: ['apps', 'apps_overview'], get feat() { return ['apps', t('Atualizações e apps sem uso')]; } },
  { id: 'files', key: 'files', mod: 'files', get title() { return t('Arquivos'); }, get verb() { return t('Procurando duplicados…'); }, glyph: 'folder', tasks: ['duplicates'], get feat() { return ['folder', t('Duplicados em Downloads')]; } },
];
const byId = (id) => MODS.find((m) => m.id === id);
// Cópias que sobrariam depois de remover tudo menos o original sugerido de cada conjunto (só para o resumo).
function reclaim(result) {
  let n = 0, bytes = 0;
  if (result) for (const g of result.groups) { const keep = g.items.find((i) => i.note) || g.items[0]; for (const i of g.items) if (i !== keep) { n++; bytes += i.size; } }
  return { n, bytes };
}
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
    if (S.err[m.id]) return { num: () => t('Indisponível'), sub: () => t('tente de novo no módulo'), sm: true, review: true };
    if (m.id === 'clean') {
      const { bytes } = selectedSize(store.junk, store.junkSel);
      const has = store.junk && store.junk.groups.length > 0;
      return bytes > 0 ? { num: () => t('{size} de lixo', { size: fmtBytes(bytes) }), sub: () => t('para limpar'), review: true, act: true }
        : { num: () => (has ? t('Nada pré-selecionado') : t('Sem lixo')), sub: () => (has ? t('revise para escolher') : t('nada para limpar')), sm: true, review: has };
    }
    if (m.id === 'trash') {
      const tr0 = store.trash;
      const n = tr0 ? countItems(tr0) : 0;
      if (tr0 && tr0.needsFda && !n) return { num: () => t('Requer acesso'), sub: () => t('Acesso Total ao Disco'), sm: true, review: true };
      return n && tr0.total > 0 ? { num: () => t('{size} na Lixeira', { size: fmtBytes(tr0.total) }), sub: () => t('para esvaziar'), review: true, act: true }
        : { num: () => t('Lixeira vazia'), sub: () => t('nada para esvaziar'), sm: true };
    }
    if (m.id === 'protect') {
      const c = S.sum.protect || { bad: 0, unknown: 0 };
      return c.bad ? { num: () => tn(c.bad, '{n} ponto de atenção', '{n} pontos de atenção'), sub: () => t('para revisar'), review: true }
        : { num: () => t('Tudo em ordem'), sub: () => (c.unknown ? tn(c.unknown, '{n} item não verificado', '{n} itens não verificados') : t('nenhum ponto de atenção')), sm: true, review: true };
    }
    if (m.id === 'perf') {
      const p = S.sum.perf || { flagged: 0, login: 0 };
      const login = () => (p.needsAutomation ? t('itens de login: requer permissão') : p.loginErr ? t('itens de login indisponíveis') : tn(p.login, '{n} item de login', '{n} itens de login'));
      return p.flagged ? { num: () => tn(p.flagged, '{n} agente pede atenção', '{n} agentes pedem atenção'), sub: login, review: true }
        : { num: () => t('Tudo em ordem'), sub: login, sm: true, review: true };
    }
    if (m.id === 'apps') {
      const a = S.sum.apps || { updates: 0, unused: 0 };
      const un = () => (a.unused ? tn(a.unused, '{n} app sem uso', '{n} apps sem uso') : t('nenhum app sem uso'));
      return a.updates ? { num: () => tn(a.updates, '{n} atualização', '{n} atualizações'), sub: un, review: true }
        : { num: () => t('Tudo atualizado'), sub: un, sm: true, review: true };
    }
    // Arquivos: só revisão. Arquivos do usuário nunca vêm marcados nem entram na execução.
    const d = reclaim(store.filesFrom);
    return d.n ? { num: () => tn(d.n, '{n} duplicado', '{n} duplicados'), sub: () => t('{size} em Downloads', { size: fmtBytes(d.bytes) }), review: true }
      : { num: () => t('Sem duplicados'), sub: () => t('nenhum arquivo repetido em Downloads'), sm: true };
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
    e.verb.textContent = st === 'clean' ? (m.id === 'trash' ? t('Esvaziando a Lixeira…') : t('Limpando lixo…')) : m.verb;
    let main = null;
    const num = (txt, small) => h('div', { class: 't-num' + (small ? ' sm' : '') }, txt);
    const sub = (...k) => h('div', { class: 't-sub' }, ...k);
    if (st === 'wait') main = h('div', { class: 't-main' }, sub(t('Aguardando…')));
    else if (st === 'found' || st === 'done' || st === 'queue' || st === 'off') {
      let line = sm.sub();
      if (st === 'queue') line = t('aguardando…');
      else if (checkable(m) && !S.inc[m.id] && st !== 'found') line = t('Pulado');
      else if (st === 'done' && m.id === 'trash' && S.inc.trash) line = t('esvaziar (permanente)');
      main = h('div', { class: 't-main' }, num(sm.num(), sm.sm), sub(line));
    } else if (st === 'final') {
      if (o === 'cleaned' || o === 'emptied' || o === 'partial') {
        // "Liberado" é só o que foi apagado de vez; o que foi para o Lixo aparece à parte.
        const freed = S.freed[m.id] || 0, trashed = (S.trashed && S.trashed[m.id]) || 0;
        const headline = m.id === 'trash' ? t('{size} da Lixeira', { size: fmtBytes(freed) }) : freed || !trashed ? t('{size} de lixo', { size: fmtBytes(freed) }) : t('{size} no Lixo', { size: fmtBytes(trashed) });
        const isTrash = m.id === 'trash';
        const verb = o === 'partial' ? (isTrash ? t('Esvaziada em parte') : t('Limpo em parte')) : (!freed && trashed ? t('Enviado ao Lixo') : isTrash ? t('Esvaziada') : t('Limpo'));
        main = h('div', { class: 't-main' }, num(headline),
          sub(h('i', { class: 'dot' + (o === 'partial' ? ' warn' : '') }), verb + (freed && trashed ? ' · ' + t('{size} no Lixo', { size: fmtBytes(trashed) }) : '')));
      } else if (o === 'failed') main = h('div', { class: 't-main' }, num(t('Não concluído'), true), sub(h('i', { class: 'dot warn' }), t('Falhou')));
      else if (o === 'stopped') main = h('div', { class: 't-main' }, num(sm.num(), sm.sm), sub(h('i', { class: 'dot warn' }), t('Interrompido')));
      else if (o === 'skipped') main = h('div', { class: 't-main' }, num(sm.num(), sm.sm), sub(t('Pulado')));
      else main = h('div', { class: 't-main' }, num(sm.num(), sm.sm),
        sub(h('i', { class: 'dot' }), sm.review ? h('button', { class: 'link t-link', type: 'button', onClick: () => go(m) }, t('Revisar')) : t('Nada a fazer')));
    }
    const old = e.el.querySelector('.t-main');
    if (old) old.remove();
    if (main) e.el.append(main);
    const rv = e.el.querySelector('.t-review');
    if (rv) rv.remove();
    e.el.classList.toggle('has-rv', st === 'done' && S.phase === 'results' && !!sm.review);
    if (st === 'done' && S.phase === 'results' && sm.review) {
      e.el.append(h('div', { class: 't-review' }, h('button', { class: 'btn sm', type: 'button', 'aria-label': t('Revisar {name}', { name: m.title }), onClick: () => go(m) }, t('Revisar'))));
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
    else if (m.id === 'files') store.files.phase = store.filesFrom && store.filesFrom.groups.length ? 'review' : 'idle';
    else if (m.id === 'trash') store.trashUi.phase = store.trash && countItems(store.trash) ? 'review' : 'idle';
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
          const label = m.id === 'trash' ? t('Incluir o esvaziamento da Lixeira (permanente)') : t('Incluir {name} na execução', { name: m.title });
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
    ctx.setDock({ label: t('Executar'), mod: 'smart', disabled: n === 0, onClick: execute });
  }

  // ---------- idle ----------
  function renderIdle() {
    ctx.reserveDock(true);
    const list = enabled();
    const st = stage('smart', 'smart', 270);
    const items = list.length
      ? [features('smart', list.map((m) => m.feat)),
        h('div', { class: 'row-actions sc-scope' }, h('button', { class: 'link', type: 'button', onClick: () => ctx.nav('settings') }, t('Escolher módulos nos Ajustes')))]
      : [h('p', { class: 'sub' }, t('Nenhum módulo está incluído na Faxina.')),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => ctx.nav('settings') }, icon('gear', 15), t('Abrir Ajustes')))];
    st.show(h('h1', { class: 'h1' }, t('Faxina')), list.length ? h('p', { class: 'sub' }, t('Manutenção rápida que cuida do essencial.')) : null, ...items);
    mount(root, st.el);
    ctx.setDock({ label: t('Analisar'), mod: 'smart', disabled: !list.length, onClick: run });
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
    } else { store.filesFrom = await api.downloadDups(); }
  }

  async function run() {
    if (!store.settings) { try { store.settings = await api.settings(); } catch (e) { /* segue com todos os módulos */ } }
    const list = enabled();
    if (!list.length) return renderIdle();
    cancelled = false;
    S.phase = 'scan'; S.err = {}; S.mods = list.map((m) => m.id); S.sum = {}; S.snap = {}; S.out = {}; S.freed = {}; S.trashed = {}; S.apps = null;
    store.filesFrom = null;
    S.inc = { clean: true, trash: false };
    play('start');
    ctx.setBusy(true);
    ctx.reserveDock(true);
    buildBento();
    list.forEach((m) => paint(m, 'wait'));
    setHead(t('Analisando seu Mac…'));
    if (!hooked) {
      hooked = true;
      ctx.onProgress((p) => { const m = byId(active); if (m && m.tasks.includes(p.task)) els[m.id].ticker.textContent = tail(p.path || ''); });
    }
    ctx.setDock({ label: t('Parar'), busy: true, mod: 'smart', onClick: () => { cancelled = true; ctx.setDock({ label: t('Parando'), busy: true, disabled: true }); api.cancel().catch(() => {}); } });
    await sleep(120);
    for (const m of list) {
      if (cancelled) break;
      active = m.id;
      paint(m, 'hot');
      els[m.id].ticker.textContent = m.id === 'protect' ? 'Gatekeeper · SIP · FileVault · Firewall' : ''; // i18n-ignore
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
    setHead(any ? t('Faxina pronta. Veja o que encontramos:') : t('Análise concluída. Veja o que encontramos:'),
      h('button', { class: 'btn sm ghost left', type: 'button', onClick: confirmRestart }, icon('restart', 14), t('Recomeçar')));
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
      if (perm) return tn(c.count, '{n} item apagado definitivamente.', '{n} itens apagados definitivamente.');
      const parts = [];
      if (c.perm) parts.push(tn(c.perm, '{n} item regenerável apagado direto', '{n} itens regeneráveis apagados direto'));
      if (c.moved) parts.push(tn(c.moved, '{n} item vai para o Lixo (recuperável)', '{n} itens vão para o Lixo (recuperável)'));
      return parts.join(' · ') + '.';
    };
    let cleanRow = null;
    if (d.clean) { cleanRow = row('clean', 'clean', t('Entulho'), d.clean.bytes, cleanDetail(false)); nodes.push(cleanRow.node); }
    if (d.trash) {
      const tRow = row('trash', 'trash', d.trash.vols > 1 ? t('Lixeiras') : t('Lixeira'), d.trash.bytes,
        tn(d.trash.count, '{n} item excluído permanentemente. Não dá para desfazer.', '{n} itens excluídos permanentemente. Não dá para desfazer.'), true);
      nodes.push(tRow.node);
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
      title: tn(tasks.length, 'Executar {n} tarefa?', 'Executar {n} tarefas?'),
      permanentTitle: tn(tasks.length, 'Executar {n} tarefa definitivamente?', 'Executar {n} tarefas definitivamente?'),
      body: t('Confira o que vai acontecer:'),
      confirm: t('Executar'), danger: !!d.trash, glyph: d.trash ? 'trash' : 'clean', mod: d.trash ? 'trash' : 'clean',
      permanentChoice: movedAny, permanentDefault: !!(store.settings && store.settings.permanentDelete),
      trashCount: movedAny ? d.clean.moved : null,
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
    S.out = {}; S.freed = {}; S.trashed = {};
    const trashRes = store.trash;
    const cleanSel = store.junkSel;
    mods().forEach((m) => { if (checkable(m) && !tasks.includes(m)) S.out[m.id] = 'skipped'; });
    mods().forEach((m) => paint(m, tasks.includes(m) ? 'queue' : 'off'));
    setHead(t('Executando suas tarefas…'));
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
      const label = (g) => (m.id === 'trash' && g.id === 'trash' ? t('Lixeira do Mac') : tr(g.title));
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
      S.freed[m.id] = res.freed; S.trashed[m.id] = res.trashed;
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
    // O título diz o que de fato aconteceu: falhas e pontos ainda abertos não viram "ótima forma".
    const outs = Object.values(S.out);
    const failed = outs.some((o) => o === 'failed' || o === 'partial');
    const sm = S.sum || {};
    const open = (sm.protect && sm.protect.bad) || (sm.perf && sm.perf.flagged) || (sm.apps && (sm.apps.updates || sm.apps.unused));
    const head = S.stopped ? t('Execução interrompida. O que já rodou foi concluído.')
      : failed ? t('Concluído, mas alguns itens não puderam ser removidos.')
        : open ? t('Limpeza concluída. Ainda há pontos para revisar.')
          : t('Muito bem! Seu Mac está em ótima forma.');
    setHead(head);
    ctx.setDock(null);
    // Rodapé: "Ver log" (link) e "Concluir" (volta ao início, sem confirmar: nada fica pendente).
    root.append(h('div', { class: 'bento-foot center enter' },
      h('button', { class: 'btn sm ghost', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 14), t('Ver log')),
      h('button', { class: 'btn primary', type: 'button', onClick: restart }, t('Concluir'))));
  }

  async function confirmRestart() {
    const ok = await confirmDialog({
      title: t('Recomeçar a análise?'), body: t('Os resultados e as marcações atuais serão descartados. Nada foi removido até agora.'),
      confirm: t('Recomeçar'), glyph: 'restart', mod: 'smart',
    });
    if (ok) restart();
  }

  function restart() {
    S.phase = 'idle'; S.out = {}; S.sum = {}; S.snap = {}; S.freed = {}; S.trashed = {}; S.inc = {}; S.apps = null; S.stopped = false;
    Object.keys(els).forEach((k) => delete els[k]);
    renderIdle();
  }

  if (!store.settings) api.settings().then((st) => { store.settings = st; if (ctx.alive && S.phase === 'idle') renderIdle(); }).catch(() => {});
  if (S.phase === 'results' && S.mods.length) { buildBento(); renderResults(); }
  else if (S.phase === 'done' && S.mods.length) { buildBento(); renderDone(); }
  else { S.phase = 'idle'; renderIdle(); }
}
