// Junk: landing -> scan -> summary -> review -> cleanup -> done.
import { play } from '../sound.js';
import { h, mount, keepPhaseFocus } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store, selectedIds, selectedSize, pruneResult, bump, countItems } from '../store.js';
import { bytesParts, fmtBytes } from '../format.js';
import { confirmDialog, confirmRestart, failuresSheet, stage, features } from '../ui.js';
import { removeGroups, realFailures, stopDock } from '../actions.js';
import { createReview } from './review.js';
import { t, tn, tr } from '../i18n.js';
import { showGuide } from '../fda.js';

// Junk under protected parts of ~/Library is invisible without Full Disk Access; say so instead of looking complete.
const fdaHint = (r) => (r && r.needsFda
  ? h('p', { class: 'fda-hint' }, t('Sem Acesso Total ao Disco, parte do lixo em ~/Library não aparece aqui.') + ' ', h('button', { class: 'link', type: 'button', onClick: () => showGuide() }, t('Como conceder')))
  : null);

const bigNum = (n, cap) => [
  h('div', { class: 'big' }, bytesParts(n).value, h('small', null, bytesParts(n).unit)),
  h('div', { class: 'big-cap' }, cap),
];

// Summary tiles: each one groups backend categories and has its own Review and Clean.
const AI_GROUP = 'ai_clutter', MAIL_GROUP = 'mail_attachments';
const tileDefs = () => [
  { id: 'system', title: t('Lixo do sistema'), ic: 'clean', blurb: t('Caches, registros, Xcode, ferramentas de desenvolvimento e backups antigos.'), has: (g) => g.id !== AI_GROUP && g.id !== MAIL_GROUP },
  { id: 'ai', title: t('Lixo de IA'), ic: 'chip', blurb: t('Caches e logs de ferramentas de IA; modelos locais ficam desmarcados.'), has: (g) => g.id === AI_GROUP },
  { id: 'mail', title: t('Anexos do Mail'), ic: 'mail', blurb: t('Cópias de anexos que o Mail baixa de novo; os que você editou ficam de fora.'), has: (g) => g.id === MAIL_GROUP },
];

// Translated text with a bold fragment: the translator positions {b} and the node goes in its place.
const MARK = '\u0001';
const withNode = (s, node) => { const [a, b = ''] = s.split(MARK); return [a, node, b]; };

export function enter(ctx) {
  const C = store.cleanup;
  let st = null, cancelled = false, focusGid = null;
  if (!['summary', 'review', 'done'].includes(C.phase) || (C.phase !== 'done' && !store.junk)) C.phase = 'idle';

  function ensureStage() {
    if (!st) { st = stage('clean', 'clean', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    return st;
  }

  function render() { return keepPhaseFocus(ctx.root, paintScreen); }

  function paintScreen() {
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
    st.show(h('h1', { class: 'h1' }, t('Entulho')), h('p', { class: 'sub' }, t('Libere espaço removendo o que o Mac acumulou sem você perceber.')),
      features('clean', [['box', t('Lixo do sistema: caches, registros, Xcode e backups antigos')], ['chip', t('Lixo de IA e modelos locais')], ['mail', t('Anexos do Mail')]]));
    ctx.setDock({ label: t('Analisar'), mod: 'clean', onClick: scan });
  }

  async function scan() {
    cancelled = false;
    C.phase = 'scanning';
    play('start');
    ctx.setBusy(true);
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, t('Procurando lixo…')), h('p', { class: 'sub' }, t('Isso pode levar alguns instantes.')), ticker);
    ctx.onProgress((p) => { if (p.task === 'junk') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: t('Parar'), busy: true, mod: 'clean', onClick: () => { cancelled = true; ctx.setDock({ label: t('Parando'), busy: true, disabled: true, mod: 'clean' }); api.cancel().catch(() => {}); } });
    try {
      const r = await api.junk();
      if (!cancelled) { store.junk = r; store.junkSel = selectedIds(r); bump(); C.phase = 'summary'; play('found'); }
    } catch (e) { if (!cancelled) play('error'); /* the toast's 'err' is gated on focus, while 'error' is a result cue that also reaches a background window (the two duck each other) */ }
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
      st.show(h('h1', { class: 'h1' }, t('Tudo limpo')), h('p', { class: 'sub' }, t('Não encontramos lixo para remover agora.')),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => { store.junk = null; C.phase = 'idle'; render(); } }, t('Analisar de novo'))), fdaHint(r));
      ctx.setDock(null);
      return;
    }
    st = null;
    ctx.reserveDock(true);
    const sel = selectedSize(r, store.junkSel);
    const tiles = tileDefs().map((tl) => {
      const gs = r.groups.filter(tl.has);
      if (!gs.length) return null;
      const items = gs.flatMap((g) => g.items);
      const pre = items.filter((i) => store.junkSel.has(i.id));
      return { tl, gs, total: gs.reduce((a, g) => a + g.total, 0), pre, preBytes: pre.reduce((a, i) => a + i.size, 0) };
    }).filter(Boolean);
    const review = (gid) => { focusGid = gid; C.phase = 'review'; render(); };
    mount(ctx.root, h('section', { class: 'fl-results cl-results enter', dataset: { mod: 'clean' }, 'aria-label': t('Resultados do Entulho') },
      h('div', { class: 'fl-bar' }, h('button', { class: 'btn sm ghost', type: 'button', onClick: async () => { if (await confirmRestart('clean')) { store.junk = null; C.phase = 'idle'; render(); } } }, icon('back', 15), t('Recomeçar'))),
      h('h2', { class: 'fl-title' }, t('Encontramos {size} de lixo no seu Mac.', { size: fmtBytes(r.total) })),
      h('p', { class: 'sub fl-sub' }, sel.bytes !== r.total ? t('{size} pré-selecionados para limpar.', { size: fmtBytes(sel.bytes) }) : t('Itens seguros de remover já vêm selecionados.')),
      h('button', { class: 'btn primary fl-all', type: 'button', onClick: () => review(null) }, t('Revisar todo o lixo')),
      h('div', { class: 'cl-tiles', dataset: { n: tiles.length } }, tiles.map(({ tl, gs, total, pre, preBytes }) => h('div', { class: 'cl-tile', dataset: { tile: tl.id } },
        h('span', { class: 'fl-tile-ic' }, icon(tl.ic, 26)),
        h('div', { class: 'cl-tile-n' }, fmtBytes(total)),
        h('div', { class: 'cl-tile-t' }, tl.title),
        h('div', { class: 'fl-tile-s' }, pre.length ? t('{size} pré-selecionados. {blurb}', { size: fmtBytes(preBytes), blurb: tl.blurb }) : t('Nada pré-selecionado: revise para escolher. {blurb}', { blurb: tl.blurb })),
        h('div', { class: 'cl-tile-act' },
          h('button', { class: 'btn sm', type: 'button', onClick: () => review(gs[0].id) }, t('Revisar')),
          h('button', { class: 'btn sm primary', type: 'button', disabled: !pre.length, onClick: () => clean(new Set(pre.map((i) => i.id))) }, t('Limpar')))))),
      fdaHint(r)));
    ctx.setDock({ label: t('Limpar'), mod: 'clean', disabled: sel.bytes === 0, onClick: () => clean() });
  }

  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const back = () => { C.phase = 'summary'; render(); };
    const rv = createReview({
      result: store.junk, sel: store.junkSel, mod: 'clean', title: t('Entulho'), subtitle: t('Revisar detalhes · escolha o que será removido.'),
      actionLabel: t('Limpar'), gid: focusGid, onBack: back, onAction: () => clean(),
    });
    mount(ctx.root, rv.el);
    ctx.onBack(back);
  }

  // `only` = ids of one tile; without it, cleans the whole current selection.
  async function clean(only = null) {
    const selected = only || store.junkSel;
    const { bytes, count } = selectedSize(store.junk, selected);
    const moved = new Set();
    for (const g of store.junk.groups) for (const i of g.items) if (selected.has(i.id) && i.trash) moved.add(i.id);
    const perm = count - moved.size;
    const trashNote = withNode(tn(moved.size,
      '{n} item vai para o {b} e dá para recuperá-lo de lá; o espaço só é liberado quando você esvaziar a Lixeira.',
      '{n} itens vão para o {b} e dá para recuperá-los de lá; o espaço só é liberado quando você esvaziar a Lixeira.', { b: MARK }), h('strong', null, t('Lixo')));
    const permNote = withNode(tn(perm,
      '{n} item será {b}. Esta ação não pode ser desfeita.',
      '{n} itens serão {b}. Esta ação não pode ser desfeita.', { b: MARK }), h('strong', null, tn(perm, 'removido definitivamente', 'removidos definitivamente')));
    const ok = await confirmDialog({
      title: moved.size === count ? t('Mover {size} para o Lixo?', { size: fmtBytes(bytes) }) : t('Limpar {size}?', { size: fmtBytes(bytes) }),
      body: moved.size === 0 ? permNote : perm === 0 ? trashNote : [...permNote, h('br'), ...trashNote],
      confirm: moved.size === count ? t('Mover para o Lixo') : t('Limpar'), danger: perm > 0, glyph: 'trash', mod: 'clean',
      permanentChoice: moved.size > 0, permanentDefault: !!(store.settings && store.settings.permanentDelete), trashCount: moved.size,
      permanentTitle: moved.size === count ? t('Apagar {size} definitivamente?', { size: fmtBytes(bytes) }) : t('Limpar {size} definitivamente?', { size: fmtBytes(bytes) }),
    });
    if (!ok) return;
    C.phase = 'cleaning';
    ctx.setBusy(true);
    ensureStageFresh();
    st.busy(true);
    const groups = store.junk.groups.filter((g) => g.items.some((i) => selected.has(i.id)));
    const rows = new Map(groups.map((g) => [g.id, h('div', { class: 'prog-row', dataset: { st: 'wait' } }, h('span', { class: 'nm', title: tr(g.title) }, tr(g.title)), h('span', { class: 'sz' }), h('span', { class: 'st' }))]));
    st.show(h('h1', { class: 'h1' }, t('Limpando…')), h('div', { class: 'group-list' }, [...rows.values()]));
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
    store.trash = null; // items may have gone to the Trash: the cached Trash result is stale
    // "freed" only counts what was deleted for good; what went to Trash appears separately.
    C.freed = res.freed; C.trashed = res.trashed; C.failed = res.failures.length; C.phase = 'done';
    C.moved = ok === 'permanent' ? 0 : [...moved].filter((id) => res.okIds.has(id)).length;
    // A Stop before anything was handled already sounded 'stop' on the click: no 'error' on top, and the
    // sheet opens only for real failures, never for the items the user chose to leave.
    const real = realFailures(res.failures);
    if (res.handled) play('clean'); else if (!sd.stopped() || real.length) play('error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (real.length) failuresSheet(real);
  }

  function ensureStageFresh() { if (!st) ensureStage(); }

  function renderDone() {
    const remaining = countItems(store.junk);
    // With nothing actually freed, the big number is what went to Trash (never called "freed").
    const onlyTrash = !C.freed && C.trashed > 0;
    st.show(...bigNum(onlyTrash ? C.trashed : C.freed, onlyTrash ? t('enviados ao Lixo') : t('liberados')),
      h('p', { class: 'sub' }, C.failed ? tn(C.failed, '{n} item não foi removido.', '{n} itens não foram removidos.') : onlyTrash ? t('Esvazie a Lixeira para liberar esse espaço.') : t('Seu Mac agradece. Tudo certo por aqui.')),
      C.trashed > 0 && !onlyTrash ? h('p', { class: 'sub fine' }, t('{size} foram para o Lixo; esvazie a Lixeira para liberar esse espaço.', { size: fmtBytes(C.trashed) })) : null,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), t('Ver log')),
        remaining ? h('button', { class: 'btn', type: 'button', onClick: () => { focusGid = null; C.phase = 'review'; render(); } }, icon('search', 15), t('Revisar itens restantes')) : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { store.junk = null; C.phase = 'idle'; render(); } }, t('Concluir'))));
    st.succeeded(C.freed + C.trashed > 0); // celebrated only when something was actually handled
    ctx.setDock(null);
  }

  render();
}
