// Limpeza: landing -> varredura -> resumo -> revisão -> limpeza -> conclusão.
import { h, mount } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store, selectedIds, selectedSize, pruneResult, bump } from '../store.js';
import { bytesParts, fmtBytes, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, features } from '../ui.js';
import { removeGroups } from '../actions.js';
import { createReview } from './review.js';

const bigNum = (n, cap) => [
  h('div', { class: 'big' }, bytesParts(n).value, h('small', null, bytesParts(n).unit)),
  h('div', { class: 'big-cap' }, cap),
];

export function enter(ctx) {
  const C = store.cleanup;
  let st = null, cancelled = false;
  if (!['summary', 'review', 'done'].includes(C.phase) || (C.phase !== 'done' && !store.junk)) C.phase = 'idle';

  function ensureStage() {
    if (!st) { st = stage('clean', 'clean', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    return st;
  }

  function render() {
    if (C.phase === 'review' && store.junk) return renderReview();
    ensureStage();
    st.busy(false);
    if (C.phase === 'summary') return renderSummary();
    if (C.phase === 'done') return renderDone();
    return renderIdle();
  }

  function renderIdle() {
    C.phase = 'idle';
    st.show(h('h1', { class: 'h1' }, 'Limpeza'), h('p', { class: 'sub' }, 'Libere espaço removendo o que o Mac acumulou sem você perceber.'),
      features('clean', [['box', 'Caches de aplicativos'], ['log', 'Registros e arquivos temporários'], ['code', 'Caches de desenvolvimento e Xcode']]));
    ctx.setDock({ label: 'Analisar', mod: 'clean', onClick: scan });
  }

  async function scan() {
    cancelled = false;
    C.phase = 'scanning';
    ctx.setBusy(true);
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, 'Procurando lixo…'), h('p', { class: 'sub' }, 'Isso pode levar alguns instantes.'), ticker);
    ctx.onProgress((p) => { if (p.task === 'junk') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'clean', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'clean' }); api.cancel().catch(() => {}); } });
    try {
      const r = await api.junk();
      if (!cancelled) { store.junk = r; store.junkSel = selectedIds(r); bump(); C.phase = 'summary'; }
    } catch (e) { /* erro já exibido em toast */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (C.phase !== 'summary') C.phase = 'idle';
    render();
  }

  function renderSummary() {
    const r = store.junk;
    if (!r.groups.length || r.total === 0) {
      st.show(h('h1', { class: 'h1' }, 'Tudo limpo'), h('p', { class: 'sub' }, 'Não encontramos lixo para remover agora.'),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => { store.junk = null; C.phase = 'idle'; render(); } }, 'Analisar de novo')));
      ctx.setDock(null);
      return;
    }
    const sel = selectedSize(r, store.junkSel);
    st.show(...bigNum(r.total, 'de lixo encontrado'),
      sel.bytes !== r.total ? h('p', { class: 'sub' }, `${fmtBytes(sel.bytes)} pré-selecionados para limpar`) : h('p', { class: 'sub' }, 'Itens seguros de remover já vêm selecionados.'),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => { C.phase = 'review'; render(); } }, 'Revisar detalhes')));
    ctx.setDock({ label: 'Limpar', mod: 'clean', disabled: sel.bytes === 0, onClick: () => clean() });
  }

  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const rv = createReview({
      result: store.junk, sel: store.junkSel, mod: 'clean', title: 'Revisar detalhes', subtitle: 'Escolha o que será removido.',
      actionLabel: 'Limpar', onBack: () => { C.phase = 'summary'; render(); }, onAction: () => clean(),
    });
    mount(ctx.root, rv.el);
  }

  async function clean() {
    const { bytes, count } = selectedSize(store.junk, store.junkSel);
    const ok = await confirmDialog({
      title: `Limpar ${fmtBytes(bytes)}?`,
      body: [`${plural(count, 'item selecionado será', 'itens selecionados serão')} `, h('strong', null, count === 1 ? 'removido definitivamente' : 'removidos definitivamente'), '. Esta ação não pode ser desfeita.'],
      confirm: 'Limpar', danger: true, glyph: 'trash', mod: 'clean',
    });
    if (!ok) return;
    C.phase = 'cleaning';
    ctx.setBusy(true);
    ensureStageFresh();
    st.busy(true);
    const groups = store.junk.groups.filter((g) => g.items.some((i) => store.junkSel.has(i.id)));
    const rows = new Map(groups.map((g) => [g.id, h('div', { class: 'prog-row', dataset: { st: 'wait' } }, h('span', { class: 'nm', title: g.title }, g.title), h('span', { class: 'sz' }), h('span', { class: 'st' }))]));
    st.show(h('h1', { class: 'h1' }, 'Limpando…'), h('div', { class: 'group-list' }, [...rows.values()]));
    ctx.setDock({ label: 'Limpando', busy: true, progress: 0, mod: 'clean' });
    const res = await removeGroups(store.junk, store.junkSel, (g, status, info) => {
      const row = rows.get(g.id);
      row.dataset.st = status;
      if (status === 'run') { mount(row.querySelector('.st'), h('span', { class: 'spin' })); return; }
      mount(row.querySelector('.st'), icon(status === 'done' ? 'check' : 'alert', 16));
      row.querySelector('.sz').textContent = fmtBytes(info.freed);
      ctx.setDock({ label: 'Limpando', busy: true, progress: info.done / info.total, mod: 'clean' });
    });
    store.junk = pruneResult(store.junk, res.okIds);
    for (const id of res.okIds) store.junkSel.delete(id);
    bump();
    C.freed = res.freed; C.failed = res.failures.length; C.phase = 'done';
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (res.failures.length) failuresSheet(res.failures);
  }

  function ensureStageFresh() { if (!st) ensureStage(); }

  function renderDone() {
    st.show(...bigNum(C.freed, 'liberados'),
      h('p', { class: 'sub' }, C.failed ? `${plural(C.failed, 'item não foi removido', 'itens não foram removidos')}.` : 'Seu Mac agradece. Tudo certo por aqui.'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        h('button', { class: 'btn primary', type: 'button', onClick: () => { store.junk = null; C.phase = 'idle'; render(); } }, icon('restart', 15), 'Recomeçar')));
    ctx.setDock(null);
  }

  render();
}
