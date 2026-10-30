// Faxina: landing -> varredura sequencial (bento) -> resultados -> limpeza -> conclusão.
import { play } from '../sound.js';
import { h, mount, sleep } from '../dom.js';
import { orb, icon } from '../art.js';
import { api } from '../api.js';
import { store, selectedSize, selectedIds, pruneResult, countItems } from '../store.js';
import { fmtBytes, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, features } from '../ui.js';
import { removeGroups, stopDock } from '../actions.js';

const TILES = [
  { id: 'clean', mod: 'clean', title: 'Limpeza', verb: 'Procurando lixo…', glyph: 'clean', task: 'junk' },
  { id: 'trash', mod: 'trash', title: 'Lixeira', verb: 'Verificando a Lixeira…', glyph: 'trash', task: 'trash' },
  { id: 'apps', mod: 'apps', title: 'Aplicativos', verb: 'Listando aplicativos…', glyph: 'apps', task: 'apps' },
  { id: 'files', mod: 'files', title: 'Meus Arquivos', verb: 'Procurando arquivos grandes…', glyph: 'folder', task: 'large' },
];
const tail = (p) => (p.length > 56 ? '…' + p.slice(-55) : p);

export function enter(ctx) {
  const S = store.smart;
  const root = ctx.root;
  if (S.phase !== 'idle' && S.rev !== store.rev) { S.phase = 'idle'; S.err = {}; }
  S.err = S.err || {};
  let cancelled = false, active = null;
  const els = {};          // id -> {el, main, ticker, list}
  let head, rows;

  const tileSummary = (t) => {
    if (S.err[t.id]) return { num: 'Indisponível', sub: 'tente de novo no módulo', sm: true };
    if (t.id === 'clean') {
      const tot = store.junk ? store.junk.total : 0;
      return tot > 0 ? { num: `${fmtBytes(tot)} de lixo`, sub: 'para limpar' } : { num: 'Sem lixo', sub: 'nada para limpar' };
    }
    if (t.id === 'trash') {
      if (store.trash && store.trash.needsFda) return { num: 'Requer acesso', sub: 'Acesso Total ao Disco', sm: true };
      const tot = store.trash ? store.trash.total : 0;
      return tot > 0 ? { num: `${fmtBytes(tot)} na Lixeira`, sub: 'para revisar' } : { num: 'Lixeira vazia', sub: 'nada para esvaziar', sm: true };
    }
    if (t.id === 'apps') {
      const a = store.apps || [];
      return { num: `${plural(a.length, 'app', 'apps')} · ${fmtBytes(a.reduce((x, y) => x + y.size, 0))}`, sub: 'instalados', sm: true };
    }
    const n = store.large ? countItems(store.large) : 0;
    return n ? { num: plural(n, 'arquivo grande', 'arquivos grandes'), sub: `acima de ${fmtBytes(store.largeMb * 1e6)}` } : { num: 'Nenhum arquivo grande', sub: `acima de ${fmtBytes(store.largeMb * 1e6)}`, sm: true };
  };

  // st: wait | hot | done | clean | cleaned | final
  function paint(t, st, dim = false) {
    const e = els[t.id];
    e.el.dataset.st = st;
    e.el.classList.toggle('hot', st === 'hot' || st === 'clean');
    e.el.style.opacity = dim ? '.6' : '';
    e.verb.textContent = st === 'clean' ? 'Limpando lixo…' : t.verb;
    const sm = tileSummary(t);
    let main = null;
    if (st === 'wait' && !dim) main = h('div', { class: 't-main' }, h('div', { class: 't-sub' }, 'Aguardando…'));
    else if (st === 'wait' || st === 'done' || st === 'final' || st === 'cleaned') {
      let sub = sm.sub;
      if (st === 'wait') sub = 'não incluído na limpeza';
      if (st === 'final' || st === 'cleaned') sub = null;
      const nm = st === 'cleaned' ? `${fmtBytes(S.freed)} de lixo` : sm.num;
      main = h('div', { class: 't-main' }, h('div', { class: 't-num' + (sm.sm && st !== 'cleaned' ? ' sm' : '') }, nm),
        sub ? h('div', { class: 't-sub' }, sub) : null,
        st === 'cleaned' ? h('div', { class: 't-sub' }, h('i', { class: 'dot' }), 'Limpo') : null,
        st === 'final' ? h('div', { class: 't-sub' }, h('i', { class: 'dot' }), h('button', { class: 'link t-link', type: 'button', onClick: () => go(t) }, 'Revisar')) : null);
    }
    const old = e.el.querySelector('.t-main');
    if (old) old.remove();
    if (main) e.el.append(main);
    const rv = e.el.querySelector('.t-review');
    if (rv) rv.remove();
    if (st === 'done' && S.phase === 'results') e.el.append(h('div', { class: 't-review' }, h('button', { class: 'btn sm', type: 'button', onClick: () => go(t) }, 'Revisar')));
    rows.forEach((r) => r.classList.toggle('hot', !!r.querySelector('.tile.hot')));
  }

  function go(t) {
    if (t.id === 'clean') store.cleanup.phase = store.junk && store.junk.groups.length ? 'review' : 'idle';
    ctx.nav(t.id);
  }

  function setHead(text, left) {
    mount(head, h('span', null, text), left || null);
  }

  function buildBento() {
    head = h('div', { class: 'bento-head' });
    const mk = (t) => {
      const ticker = h('div', { class: 't-ticker' });
      const list = h('div', { class: 't-list' });
      const verb = h('div', { class: 't-verb' }, t.verb);
      const el = h('div', { class: 'tile', dataset: { mod: t.mod, st: 'wait' } },
        h('div', { class: 'tile-fill' }), h('div', { class: 'tile-orb' }, orb(t.mod, 168, t.glyph)),
        h('div', { class: 't-label' }, t.title), verb, ticker, list);
      els[t.id] = { el, ticker, list, verb };
      return el;
    };
    const [a, b, c, d] = TILES.map(mk);
    rows = [h('div', { class: 'brow' }, a, b), h('div', { class: 'brow' }, c, d)];
    mount(root, h('div', { class: 'col enter' }, head, h('div', { class: 'bento' }, rows)));
  }

  // ---------- idle ----------
  function renderIdle() {
    ctx.reserveDock(true);
    const st = stage('smart', 'smart', 270);
    st.show(h('h1', { class: 'h1' }, 'Faxina'), h('p', { class: 'sub' }, 'Manutenção rápida que cuida do essencial.'),
      features('smart', [['search', 'Busca de lixo do sistema'], ['trash', 'Verificação da Lixeira e dos apps'], ['folder', 'Arquivos grandes esquecidos']]));
    mount(root, st.el);
    ctx.setDock({ label: 'Analisar', mod: 'smart', onClick: run });
  }

  // ---------- scan ----------
  async function load(t) {
    if (t.id === 'clean') { store.junk = await api.junk(); store.junkSel = selectedIds(store.junk); store.cleanup.phase = store.junk.groups.length ? 'summary' : 'idle'; }
    else if (t.id === 'trash') store.trash = await api.trash();
    else if (t.id === 'apps') store.apps = await api.apps();
    else { store.largeMb = 500; store.large = await api.large(500); store.largeSel = new Set(); store.files.phase = 'review'; }
  }

  async function run() {
    cancelled = false;
    S.phase = 'scan'; S.err = {};
    play('start');
    ctx.setBusy(true);
    buildBento();
    TILES.forEach((t) => paint(t, 'wait'));
    setHead('Analisando seu Mac…');
    ctx.onProgress((p) => { const t = TILES.find((x) => x.id === active); if (t && p.task === t.task) els[t.id].ticker.textContent = tail(p.path || ''); });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'smart', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true }); api.cancel().catch(() => {}); } });
    await sleep(120);
    for (const t of TILES) {
      if (cancelled) break;
      active = t.id;
      paint(t, 'hot');
      els[t.id].ticker.textContent = '';
      try { await Promise.all([load(t), sleep(700)]); } catch (e) { if (cancelled) break; S.err[t.id] = true; }
      if (cancelled) break;
      paint(t, 'done');
    }
    active = null;
    if (!ctx.alive) return;
    ctx.setBusy(false);
    if (cancelled) { S.phase = 'idle'; renderIdle(); return; }
    S.phase = 'results'; S.rev = store.rev;
    play('found');
    renderResults();
  }

  function renderResults() {
    if (!els.clean) { buildBento(); }
    TILES.forEach((t) => paint(t, 'done'));
    setHead('Análise concluída');
    const { bytes } = selectedSize(store.junk, store.junkSel);
    ctx.reserveDock(true);
    ctx.setDock({ label: 'Executar', mod: 'smart', disabled: bytes === 0, onClick: execute });
  }

  // ---------- execute ----------
  async function execute() {
    const { bytes, count } = selectedSize(store.junk, store.junkSel);
    let moved = 0;
    for (const g of store.junk.groups) for (const i of g.items) if (store.junkSel.has(i.id) && i.trash) moved++;
    const perm = count - moved;
    const body = [];
    if (perm) body.push(`${plural(perm, 'item regenerável será', 'itens regeneráveis serão')} `, h('strong', null, perm === 1 ? 'removido definitivamente' : 'removidos definitivamente'), '. ');
    if (moved) body.push(`${plural(moved, 'item vai', 'itens vão')} para o `, h('strong', null, 'Lixo'), ' e podem ser recuperados de lá.');
    const ok = await confirmDialog({
      title: `Limpar ${fmtBytes(bytes)} de lixo?`,
      body,
      confirm: 'Limpar', danger: perm > 0, glyph: 'trash', mod: 'clean',
      permanentChoice: moved > 0, permanentDefault: !!(store.settings && store.settings.permanentDelete),
    });
    if (!ok) return;
    S.phase = 'cleaning';
    ctx.setBusy(true);
    const clean = TILES[0];
    TILES.slice(1).forEach((t) => paint(t, 'wait', true));
    const groups = store.junk.groups.filter((g) => g.items.some((i) => store.junkSel.has(i.id)));
    const rowsEl = new Map(groups.map((g) => [g.id, h('div', { class: 'prog-row', dataset: { st: 'wait' } }, h('span', { class: 'nm', title: g.title }, g.title), h('span', { class: 'sz' }, ''), h('span', { class: 'st' }))]));
    mount(els.clean.list, [...rowsEl.values()]);
    paint(clean, 'clean');
    setHead('Limpando…');
    const sd = stopDock(ctx, 'smart');
    const res = await removeGroups(store.junk, store.junkSel, (g, status, info) => {
      const row = rowsEl.get(g.id);
      row.dataset.st = status;
      const stEl = row.querySelector('.st');
      if (status === 'run') mount(stEl, h('span', { class: 'spin' }));
      else { mount(stEl, icon(status === 'done' ? 'check' : 'alert', 16)); row.querySelector('.sz').textContent = fmtBytes(info.freed); sd.progress(info.done / info.total); }
    }, { permanent: ok === 'permanent', stopped: sd.stopped });
    await sleep(500);
    S.freed = res.freed;
    store.junk = pruneResult(store.junk, res.okIds);
    for (const id of res.okIds) store.junkSel.delete(id);
    store.cleanup.phase = store.junk.groups.length ? 'summary' : 'idle';
    if (!store.junk.groups.length) store.junk = null;
    S.phase = 'done'; S.rev = store.rev;
    play('clean');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    renderDone();
    if (res.failures.length) failuresSheet(res.failures);
  }

  function renderDone() {
    if (!els.clean) buildBento();
    paint(TILES[0], 'cleaned');
    TILES.slice(1).forEach((t) => paint(t, 'final'));
    setHead('Muito bem! Seu Mac está em ótima forma.', h('button', { class: 'btn sm ghost left', type: 'button', onClick: restart }, icon('restart', 14), 'Recomeçar'));
    ctx.setDock(null);
    const foot = h('div', { class: 'bento-foot enter' }, h('button', { class: 'btn sm', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 14), 'Ver log'));
    root.append(foot);
  }

  function restart() { S.phase = 'idle'; Object.keys(els).forEach((k) => delete els[k]); renderIdle(); }

  if (S.phase === 'results') { buildBento(); renderResults(); }
  else if (S.phase === 'done') { buildBento(); renderDone(); }
  else { S.phase = 'idle'; renderIdle(); }
}
