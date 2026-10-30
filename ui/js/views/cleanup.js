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

// Tiles do resumo,: cada um agrupa categorias do backend e tem Revisar e Limpar próprios.
const AI_GROUP = 'ai_clutter', MAIL_GROUP = 'mail_attachments';
const TILES = [
  { id: 'system', title: 'Lixo do sistema', ic: 'clean', blurb: 'Caches, registros, Xcode, ferramentas de desenvolvimento e backups antigos.', has: (g) => g.id !== AI_GROUP && g.id !== MAIL_GROUP },
  { id: 'ai', title: 'Lixo de IA', ic: 'chip', blurb: 'Caches e logs de ferramentas de IA; modelos locais ficam desmarcados.', has: (g) => g.id === AI_GROUP },
  { id: 'mail', title: 'Anexos do Mail', ic: 'mail', blurb: 'Cópias de anexos que o Mail baixa de novo; os que você editou ficam de fora.', has: (g) => g.id === MAIL_GROUP },
];

export function enter(ctx) {
  const C = store.cleanup;
  let st = null, cancelled = false, focusGid = null;
  if (!['summary', 'review', 'done'].includes(C.phase) || (C.phase !== 'done' && !store.junk)) C.phase = 'idle';

  function ensureStage() {
    if (!st) { st = stage('clean', 'clean', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    return st;
  }

  function render() {
    ctx.onBack(null);
    if (C.phase === 'review' && store.junk) return renderReview();
    if (C.phase === 'summary' && store.junk) return renderSummary();
    ensureStage();
    st.busy(false);
    if (C.phase === 'done') return renderDone();
    return renderIdle();
  }

  function renderIdle() {
    C.phase = 'idle';
    st.show(h('h1', { class: 'h1' }, 'Limpeza'), h('p', { class: 'sub' }, 'Libere espaço removendo o que o Mac acumulou sem você perceber.'),
      features('clean', [['box', 'Lixo do sistema: caches, registros, Xcode e backups antigos'], ['chip', 'Lixo de IA e modelos locais'], ['mail', 'Anexos do Mail']]));
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
      ensureStage();
      st.busy(false);
      st.show(h('h1', { class: 'h1' }, 'Tudo limpo'), h('p', { class: 'sub' }, 'Não encontramos lixo para remover agora.'),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => { store.junk = null; C.phase = 'idle'; render(); } }, 'Analisar de novo')));
      ctx.setDock(null);
      return;
    }
    st = null;
    ctx.reserveDock(true);
    const sel = selectedSize(r, store.junkSel);
    const tiles = TILES.map((t) => {
      const gs = r.groups.filter(t.has);
      if (!gs.length) return null;
      const items = gs.flatMap((g) => g.items);
      const pre = items.filter((i) => store.junkSel.has(i.id));
      return { t, gs, total: gs.reduce((a, g) => a + g.total, 0), pre, preBytes: pre.reduce((a, i) => a + i.size, 0) };
    }).filter(Boolean);
    const review = (gid) => { focusGid = gid; C.phase = 'review'; render(); };
    mount(ctx.root, h('section', { class: 'fl-results cl-results enter', dataset: { mod: 'clean' }, 'aria-label': 'Resultados da Limpeza' },
      h('h2', { class: 'fl-title' }, `Encontramos ${fmtBytes(r.total)} de lixo no seu Mac.`),
      h('p', { class: 'sub fl-sub' }, sel.bytes !== r.total ? `${fmtBytes(sel.bytes)} pré-selecionados para limpar.` : 'Itens seguros de remover já vêm selecionados.'),
      h('button', { class: 'btn primary fl-all', type: 'button', onClick: () => review(null) }, 'Revisar todo o lixo'),
      h('div', { class: 'cl-tiles', dataset: { n: tiles.length } }, tiles.map(({ t, gs, total, pre, preBytes }) => h('div', { class: 'cl-tile', dataset: { tile: t.id } },
        h('span', { class: 'fl-tile-ic' }, icon(t.ic, 26)),
        h('div', { class: 'cl-tile-n' }, fmtBytes(total)),
        h('div', { class: 'cl-tile-t' }, t.title),
        h('div', { class: 'fl-tile-s' }, pre.length ? `${fmtBytes(preBytes)} pré-selecionados. ${t.blurb}` : `Nada pré-selecionado: revise para escolher. ${t.blurb}`),
        h('div', { class: 'cl-tile-act' },
          h('button', { class: 'btn sm', type: 'button', onClick: () => review(gs[0].id) }, 'Revisar'),
          h('button', { class: 'btn sm primary', type: 'button', disabled: !pre.length, onClick: () => clean(new Set(pre.map((i) => i.id))) }, 'Limpar')))))));
    ctx.setDock({ label: 'Limpar', mod: 'clean', disabled: sel.bytes === 0, onClick: () => clean() });
  }

  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const back = () => { C.phase = 'summary'; render(); };
    const rv = createReview({
      result: store.junk, sel: store.junkSel, mod: 'clean', title: 'Limpeza', subtitle: 'Revisar detalhes · escolha o que será removido.',
      actionLabel: 'Limpar', gid: focusGid, onBack: back, onAction: () => clean(),
    });
    mount(ctx.root, rv.el);
    ctx.onBack(back);
  }

  // `only` = ids de um tile; sem ele, limpa toda a seleção atual.
  async function clean(only = null) {
    const selected = only || store.junkSel;
    const { bytes, count } = selectedSize(store.junk, selected);
    const moved = new Set();
    for (const g of store.junk.groups) for (const i of g.items) if (selected.has(i.id) && i.trash) moved.add(i.id);
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
    const groups = store.junk.groups.filter((g) => g.items.some((i) => selected.has(i.id)));
    const rows = new Map(groups.map((g) => [g.id, h('div', { class: 'prog-row', dataset: { st: 'wait' } }, h('span', { class: 'nm', title: g.title }, g.title), h('span', { class: 'sz' }), h('span', { class: 'st' }))]));
    st.show(h('h1', { class: 'h1' }, 'Limpando…'), h('div', { class: 'group-list' }, [...rows.values()]));
    const sd = stopDock(ctx, 'clean');
    const res = await removeGroups(store.junk, selected, (g, status, info) => {
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
    // "liberados" só conta o que foi apagado de vez; o que foi para o Lixo aparece à parte.
    C.freed = res.freed; C.trashed = res.trashed; C.failed = res.failures.length; C.phase = 'done';
    C.moved = ok === 'permanent' ? 0 : [...moved].filter((id) => res.okIds.has(id)).length;
    play(res.handled ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (res.failures.length) failuresSheet(res.failures);
  }

  function ensureStageFresh() { if (!st) ensureStage(); }

  function renderDone() {
    const remaining = countItems(store.junk);
    // Sem nada liberado de fato, o número grande é o que foi para o Lixo (nunca chamado de "liberado").
    const onlyTrash = !C.freed && C.trashed > 0;
    st.show(...bigNum(onlyTrash ? C.trashed : C.freed, onlyTrash ? 'enviados ao Lixo' : 'liberados'),
      h('p', { class: 'sub' }, C.failed ? `${plural(C.failed, 'item não foi removido', 'itens não foram removidos')}.` : onlyTrash ? 'Esvazie a Lixeira para liberar esse espaço.' : 'Seu Mac agradece. Tudo certo por aqui.'),
      C.trashed > 0 && !onlyTrash ? h('p', { class: 'sub fine' }, `${fmtBytes(C.trashed)} foram para o Lixo; esvazie a Lixeira para liberar esse espaço.`) : null,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        remaining ? h('button', { class: 'btn', type: 'button', onClick: () => { focusGid = null; C.phase = 'review'; render(); } }, icon('search', 15), 'Revisar itens restantes') : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { store.junk = null; C.phase = 'idle'; render(); } }, 'Concluir')));
    ctx.setDock(null);
  }

  render();
}
