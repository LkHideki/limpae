// Trash: landing -> check -> summary (per trash) -> item-by-item review -> empty what was checked.
// Emptying is permanent: everything comes checked, but the user can keep items in the review.
import { play } from '../sound.js';
import { h, mount, keepPhaseFocus } from '../dom.js';
import { icon, groupIcon } from '../art.js';
import { api } from '../api.js';
import { store, countItems, bump, selectedSize, pruneResult } from '../store.js';
import { bytesParts, fmtBytes, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, features } from '../ui.js';
import { removeGroups, realFailures, stopDock } from '../actions.js';
import { createReview } from './review.js';
import { t, tn, tr } from '../i18n.js';
import { openSettings, reopenButton } from '../fda.js';

const MARK = '\u0001'; // {b} marker where the bold fragment goes
const withNode = (s, node) => { const [a, b = ''] = s.split(MARK); return [a, node, b]; };

export function enter(ctx) {
  const T = store.trashUi;
  let st = null, cancelled = false, failed = false;
  if (T.phase === 'review' && !store.trash) T.phase = 'idle';
  if (T.phase === 'ready' && !store.trash) T.phase = 'idle';
  if (T.phase === 'idle' && store.trash) T.phase = 'ready';

  const big = (n, cap) => [h('div', { class: 'big' }, bytesParts(n).value, h('small', null, bytesParts(n).unit)), h('div', { class: 'big-cap' }, cap)];

  function ensureStage() {
    if (!st) { st = stage('trash', 'trash', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    st.busy(false);
  }

  // Marking: everything, by default. Recomputed when the result changes (new read, or the one made by Sweep).
  function selection() {
    const r = store.trash;
    if (store.trashSelRef !== r) {
      store.trashSelRef = r;
      store.trashSel = new Set(r ? r.groups.flatMap((g) => g.items.map((i) => i.id)) : []);
    }
    return store.trashSel;
  }

  async function load() {
    cancelled = false; failed = false;
    ensureStage();
    play('start');
    ctx.setBusy(true);
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, t('Verificando…')), h('p', { class: 'sub' }, t('Lendo o conteúdo da Lixeira.')), ticker);
    ctx.onProgress((p) => { if (p.task === 'trash') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: t('Parar'), busy: true, mod: 'trash', onClick: () => { cancelled = true; ctx.setDock({ label: t('Parando'), busy: true, disabled: true, mod: 'trash' }); api.cancel().catch(() => {}); } });
    let r = null;
    try { r = await api.trash(); } catch (e) { failed = !cancelled; if (failed) play('error'); /* the toast's 'err' is gated on focus; 'error' also reaches a background window and ducks it */ }
    ctx.setBusy(false);
    if (r && !cancelled) {
      for (const g of r.groups) if (g.id === 'trash') g.title = 'Lixeira do Mac'; // i18n-ignore: dictionary key, translated by tr() on display
      store.trash = r;
      T.phase = 'ready';
      play('found');
    } else T.phase = 'idle';
    if (!ctx.alive) return;
    render();
  }

  function render() { return keepPhaseFocus(ctx.root, paintScreen); }

  function paintScreen() {
    ctx.onBack(null);
    if (T.phase === 'review' && store.trash) return renderReview();
    ensureStage();
    st.busy(false);
    if (T.phase === 'done') return renderDone();
    const r = store.trash;
    if (!r) return renderIdle();
    if (r.needsFda && !r.groups.length) return renderFda();
    return renderReady(r);
  }

  // ---------- landing ----------
  function renderIdle() {
    T.phase = 'idle';
    if (failed) {
      st.show(h('h1', { class: 'h1' }, t('Lixeira')), h('p', { class: 'sub' }, t('Não foi possível ler a Lixeira agora.')),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: load }, t('Tentar de novo'))));
      ctx.setDock(null);
      return;
    }
    st.show(h('h1', { class: 'h1' }, t('Lixeira')),
      h('p', { class: 'sub' }, cancelled ? t('Verificação interrompida. Nada foi alterado.') : t('Veja o que está na Lixeira do Mac e nos discos externos antes de esvaziar.')),
      features('trash', [['trash', t('Lixeira do Mac e dos discos externos')], ['search', t('Revisão item a item')], ['shield', t('Você escolhe o que sai de vez')]]));
    ctx.setDock({ label: t('Verificar'), mod: 'trash', onClick: load });
  }

  // ---------- summary ----------
  function renderReady(r) {
    T.phase = 'ready';
    const n = countItems(r);
    if (!n || r.total === 0) {
      st.show(h('h1', { class: 'h1' }, t('Lixeira vazia')), h('p', { class: 'sub' }, t('Não há nada para esvaziar.')),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: load }, icon('refresh', 15), t('Atualizar'))));
      return ctx.setDock(null);
    }
    const sel = selection();
    const picked = selectedSize(r, sel);
    const multi = r.groups.length > 1 || r.groups.some((g) => g.id !== 'trash');
    const all = picked.count === n;
    st.show(...big(picked.bytes, all
      ? (multi ? t('em {items} de {bins}', { items: plural(n, 'item', 'itens'), bins: plural(r.groups.length, 'lixeira', 'lixeiras') }) : t('em {items} na Lixeira', { items: plural(n, 'item', 'itens') }))
      : tn(picked.count, '{n} item selecionado de {size}', '{n} itens selecionados de {size}', { size: fmtBytes(r.total) })),
      h('p', { class: 'sub' }, t('Esvaziar remove de forma permanente: depois disso não há como recuperar. Revise para manter algum item.')),
      multi ? volumeList(r.groups) : null,
      r.needsFda ? h('p', { class: 'fda-hint' }, t('A Lixeira do Mac não foi lida: ela exige Acesso Total ao Disco.') + ' ', h('button', { class: 'link', type: 'button', onClick: () => openSettings().then(ctx.refreshDisk) }, t('Abrir Ajustes'))) : null,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => { T.phase = 'review'; render(); } }, icon('search', 15), t('Revisar itens')),
        h('button', { class: 'btn', type: 'button', onClick: load }, icon('refresh', 15), t('Atualizar'))));
    ctx.setDock({ label: t('Esvaziar'), mod: 'trash', disabled: picked.count === 0, onClick: empty });
  }

  // One row per trash: the Mac's and one per external volume, with size and count.
  function volumeList(groups) {
    return h('ul', { class: 'vol-list', 'aria-label': t('Lixeiras encontradas') }, groups.map((g) => h('li', { class: 'vol-row' },
      h('span', { class: 'vol-ic' }, icon(groupIcon(g.id), 16)),
      h('span', { class: 'vol-nm', title: tr(g.title) }, tr(g.title)),
      h('span', { class: 'vol-n' }, plural(g.items.length, 'item', 'itens')),
      h('span', { class: 'vol-sz' }, fmtBytes(g.total)))));
  }

  function renderFda() {
    st.show(h('div', { class: 'panel' },
      h('div', { class: 'glyph-chip' }, icon('lock', 22)),
      h('h3', null, t('Acesso Total ao Disco necessário')),
      h('p', null, t('O macOS protege a Lixeira. Para o Limpae ver e esvaziar o que está nela, conceda acesso:')),
      h('ol', null, h('li', null, t('Abra Ajustes do Sistema › Privacidade e Segurança.')), h('li', null, t('Entre em Acesso Total ao Disco e ative o Limpae.')), h('li', null, t('Volte aqui e toque em Verificar de novo.'))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => openSettings().then(ctx.refreshDisk) }, t('Abrir Ajustes')),
        h('button', { class: 'btn', type: 'button', onClick: async () => { await load(); ctx.refreshDisk(); } }, t('Verificar de novo')),
        reopenButton())));
    ctx.setDock(null);
  }

  // ---------- review ----------
  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const r = store.trash;
    const sel = selection();
    const back = () => { T.phase = 'ready'; render(); };
    const rv = createReview({
      result: r, sel, mod: 'trash', title: t('Lixeira'),
      subtitle: t('Revisar · {items} · {size}', { items: plural(countItems(r), 'item', 'itens'), size: fmtBytes(r.total) }),
      extra: h('p', { class: 'pf-notice' }, icon('alert', 14), t('Esvaziar exclui os itens marcados de forma permanente. Desmarque o que quiser manter.')),
      actionLabel: t('Esvaziar'), emptyText: t('A Lixeira está vazia.'), ignore: false,
      onBack: back, onAction: () => empty(),
    });
    mount(ctx.root, rv.el);
    ctx.onBack(back);
  }

  // ---------- empty ----------
  async function empty() {
    const r = store.trash;
    const sel = selection();
    const { bytes, count } = selectedSize(r, sel);
    if (!count) return;
    const vols = r.groups.filter((g) => g.items.some((i) => sel.has(i.id))).length;
    const plain = vols > 1;
    const ok = await confirmDialog({
      title: plain ? t('Esvaziar as lixeiras?') : t('Esvaziar a Lixeira?'),
      body: [...withNode(plain
        ? t('{items} ({size}, em {bins}) serão {b}. Não é possível desfazer.', { items: plural(count, 'item', 'itens'), size: fmtBytes(bytes), bins: plural(vols, 'lixeira', 'lixeiras'), b: MARK })
        : t('{items} ({size}) serão {b}. Não é possível desfazer.', { items: plural(count, 'item', 'itens'), size: fmtBytes(bytes), b: MARK }), h('strong', null, t('excluídos permanentemente'))),
        count < countItems(r) ? ' ' + tn(countItems(r) - count, 'O outro item fica na Lixeira.', 'Os outros {n} itens ficam na Lixeira.') : ''],
      confirm: count < countItems(r) ? t('Excluir selecionados') : plain ? t('Esvaziar lixeiras') : t('Esvaziar Lixeira'), danger: true, glyph: 'trash', mod: 'trash',
    });
    if (!ok) return;
    ctx.onBack(null);
    ctx.setBusy(true);
    ensureStage();
    st.busy(true);
    st.show(h('h1', { class: 'h1' }, t('Esvaziando…')), h('p', { class: 'sub' }, t('Removendo itens da Lixeira.')));
    const sd = stopDock(ctx, 'trash');
    const res = await removeGroups(r, sel, (g, status, info) => { if (status !== 'run') sd.progress(info.done / info.total); }, { stopped: sd.stopped });
    bump();
    const left = pruneResult(r, res.okIds);
    store.trash = left;
    store.trashSelRef = left;
    for (const id of res.okIds) sel.delete(id);
    T.freed = res.freed; T.failed = res.failures.length; T.phase = 'done';
    // A bare Stop already sounded 'stop': no 'error' on top, and the items the user chose to leave are not failures.
    const real = realFailures(res.failures);
    if (res.freed) play('clean'); else if (!sd.stopped() || real.length) play('error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    st.busy(false);
    render();
    if (real.length) failuresSheet(real);
  }

  function renderDone() {
    const left = store.trash ? countItems(store.trash) : 0;
    st.show(...big(T.freed, t('liberados')),
      h('p', { class: 'sub' }, left ? tn(left, '{n} item continua na Lixeira.', '{n} itens continuam na Lixeira.') : t('A Lixeira foi esvaziada.')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), t('Ver log')),
        left ? h('button', { class: 'btn', type: 'button', onClick: () => { T.phase = 'ready'; render(); } }, icon('search', 15), t('Revisar itens restantes')) : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { T.phase = 'idle'; store.trash = null; render(); } }, t('Concluir'))));
    st.succeeded(T.freed > 0); // celebrated only when something was actually handled
    ctx.setDock(null);
  }

  render();
}
