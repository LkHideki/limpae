// Limpeza: landing -> varredura -> resumo -> revisão -> limpeza -> conclusão.
import { play } from '../sound.js';
import { h, mount } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store, selectedIds, selectedSize, pruneResult, bump, countItems } from '../store.js';
import { bytesParts, fmtBytes, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, features } from '../ui.js';
import { removeGroups, stopDock } from '../actions.js';
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
      features('clean', [['box', 'Caches de aplicativos e registros'], ['chip', 'Lixo de ferramentas de IA e modelos locais'], ['code', 'Caches de desenvolvimento e Xcode'], ['phone', 'Backups antigos de iPhone e iPad'], ['mail', 'Anexos do Mail e preferências quebradas']]));
    ctx.setDock({ label: 'Analisar', mod: 'clean', onClick: scan });
  }

  async function scan() {
    cancelled = false;
    C.phase = 'scanning';
    play('start');
    ctx.setBusy(true);
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, 'Procurando lixo…'), h('p', { class: 'sub' }, 'Isso pode levar alguns instantes.'), ticker);
    ctx.onProgress((p) => { if (p.task === 'junk') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'clean', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'clean' }); api.cancel().catch(() => {}); } });
    try {
      const r = await api.junk();
      if (!cancelled) { store.junk = r; store.junkSel = selectedIds(r); bump(); C.phase = 'summary'; play('found'); }
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
    const moved = new Set();
    for (const g of store.junk.groups) for (const i of g.items) if (store.junkSel.has(i.id) && i.trash) moved.add(i.id);
    const perm = count - moved.size;
    const trashNote = [`${plural(moved.size, 'item vai', 'itens vão')} para o `, h('strong', null, 'Lixo'), ' e dá para recuperá-' + (moved.size === 1 ? 'lo' : 'los') + ' de lá; o espaço só é liberado quando você esvaziar a Lixeira.'];
    const permNote = [`${plural(perm, 'item será', 'itens serão')} `, h('strong', null, perm === 1 ? 'removido definitivamente' : 'removidos definitivamente'), '. Esta ação não pode ser desfeita.'];
    const ok = await confirmDialog({
      title: moved.size === count ? `Mover ${fmtBytes(bytes)} para o Lixo?` : `Limpar ${fmtBytes(bytes)}?`,
      body: moved.size === 0 ? permNote : perm === 0 ? trashNote : [...permNote, h('br'), ...trashNote],
      confirm: moved.size === count ? 'Mover para o Lixo' : 'Limpar', danger: perm > 0, glyph: 'trash', mod: 'clean',
      permanentChoice: moved.size > 0, permanentDefault: !!(store.settings && store.settings.permanentDelete), trashCount: moved.size,
    });
    if (!ok) return;
    C.phase = 'cleaning';
    ctx.setBusy(true);
    ensureStageFresh();
    st.busy(true);
    const groups = store.junk.groups.filter((g) => g.items.some((i) => store.junkSel.has(i.id)));
    const rows = new Map(groups.map((g) => [g.id, h('div', { class: 'prog-row', dataset: { st: 'wait' } }, h('span', { class: 'nm', title: g.title }, g.title), h('span', { class: 'sz' }), h('span', { class: 'st' }))]));
    st.show(h('h1', { class: 'h1' }, 'Limpando…'), h('div', { class: 'group-list' }, [...rows.values()]));
    const sd = stopDock(ctx, 'clean');
    const res = await removeGroups(store.junk, store.junkSel, (g, status, info) => {
      const row = rows.get(g.id);
      row.dataset.st = status;
      if (status === 'run') { mount(row.querySelector('.st'), h('span', { class: 'spin' })); return; }
      mount(row.querySelector('.st'), icon(status === 'done' ? 'check' : 'alert', 16));
      row.querySelector('.sz').textContent = fmtBytes(info.freed);
      sd.progress(info.done / info.total);
    }, { permanent: ok === 'permanent', stopped: sd.stopped });
    store.junk = pruneResult(store.junk, res.okIds);
    for (const id of res.okIds) store.junkSel.delete(id);
    bump();
    C.freed = res.freed; C.failed = res.failures.length; C.phase = 'done';
    C.moved = [...moved].filter((id) => res.okIds.has(id)).length;
    play(res.freed ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (res.failures.length) failuresSheet(res.failures);
  }

  function ensureStageFresh() { if (!st) ensureStage(); }

  function renderDone() {
    const remaining = countItems(store.junk);
    st.show(...bigNum(C.freed, 'liberados'),
      h('p', { class: 'sub' }, C.failed ? `${plural(C.failed, 'item não foi removido', 'itens não foram removidos')}.` : 'Seu Mac agradece. Tudo certo por aqui.'),
      C.moved ? h('p', { class: 'sub fine' }, `${plural(C.moved, 'item foi', 'itens foram')} para o Lixo: esvazie a Lixeira para liberar esse espaço.`) : null,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        remaining ? h('button', { class: 'btn', type: 'button', onClick: () => { C.phase = 'review'; render(); } }, icon('search', 15), 'Revisar itens restantes') : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { store.junk = null; C.phase = 'idle'; render(); } }, icon('restart', 15), 'Recomeçar')));
    ctx.setDock(null);
  }

  render();
}
