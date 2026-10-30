// Lixeira: landing -> verificação -> resumo (por lixeira) -> revisão item a item -> esvaziar o que foi marcado.
// Esvaziar é permanente: tudo vem marcado, mas o usuário pode manter itens na revisão.
import { play } from '../sound.js';
import { h, mount } from '../dom.js';
import { icon, groupIcon } from '../art.js';
import { api } from '../api.js';
import { store, countItems, bump, selectedSize, pruneResult } from '../store.js';
import { bytesParts, fmtBytes, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, features } from '../ui.js';
import { removeGroups, stopDock } from '../actions.js';
import { createReview } from './review.js';

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

  // Marcação: tudo, por padrão. Recalculada quando o resultado muda (nova leitura, ou a feita pelo Faxina).
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
    ctx.setBusy(true);
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, 'Verificando…'), h('p', { class: 'sub' }, 'Lendo o conteúdo da Lixeira.'), ticker);
    ctx.onProgress((p) => { if (p.task === 'trash') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'trash', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'trash' }); api.cancel().catch(() => {}); } });
    let r = null;
    try { r = await api.trash(); } catch (e) { failed = !cancelled; /* toast já exibido */ }
    ctx.setBusy(false);
    if (r && !cancelled) {
      for (const g of r.groups) if (g.id === 'trash') g.title = 'Lixeira do Mac';
      store.trash = r;
      T.phase = 'ready';
    } else T.phase = 'idle';
    if (!ctx.alive) return;
    render();
  }

  function render() {
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
      st.show(h('h1', { class: 'h1' }, 'Lixeira'), h('p', { class: 'sub' }, 'Não foi possível ler a Lixeira agora.'),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: load }, 'Tentar de novo')));
      ctx.setDock(null);
      return;
    }
    st.show(h('h1', { class: 'h1' }, 'Lixeira'),
      h('p', { class: 'sub' }, cancelled ? 'Verificação interrompida. Nada foi alterado.' : 'Veja o que está na Lixeira do Mac e nos discos externos antes de esvaziar.'),
      features('trash', [['trash', 'Lixeira do Mac e dos discos externos'], ['search', 'Revisão item a item'], ['shield', 'Você escolhe o que sai de vez']]));
    ctx.setDock({ label: 'Verificar', mod: 'trash', onClick: load });
  }

  // ---------- resumo ----------
  function renderReady(r) {
    T.phase = 'ready';
    const n = countItems(r);
    if (!n || r.total === 0) {
      st.show(h('h1', { class: 'h1' }, 'Lixeira vazia'), h('p', { class: 'sub' }, 'Não há nada para esvaziar.'),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: load }, icon('refresh', 15), 'Atualizar')));
      return ctx.setDock(null);
    }
    const sel = selection();
    const picked = selectedSize(r, sel);
    const multi = r.groups.length > 1 || r.groups.some((g) => g.id !== 'trash');
    const all = picked.count === n;
    st.show(...big(picked.bytes, all
      ? (multi ? `em ${plural(n, 'item', 'itens')} de ${plural(r.groups.length, 'lixeira', 'lixeiras')}` : `em ${plural(n, 'item', 'itens')} na Lixeira`)
      : `${plural(picked.count, 'item selecionado', 'itens selecionados')} de ${fmtBytes(r.total)}`),
      h('p', { class: 'sub' }, 'Esvaziar remove de forma permanente: depois disso não há como recuperar. Revise para manter algum item.'),
      multi ? volumeList(r.groups) : null,
      r.needsFda ? h('p', { class: 'fda-hint' }, 'A Lixeira do Mac não foi lida: ela exige Acesso Total ao Disco. ', h('button', { class: 'link', type: 'button', onClick: () => api.openFda().catch(() => {}) }, 'Abrir Ajustes')) : null,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => { T.phase = 'review'; render(); } }, icon('search', 15), 'Revisar itens'),
        h('button', { class: 'btn', type: 'button', onClick: load }, icon('refresh', 15), 'Atualizar')));
    ctx.setDock({ label: 'Esvaziar', mod: 'trash', disabled: picked.count === 0, onClick: empty });
  }

  // Uma linha por lixeira: a do Mac e uma por volume externo, com tamanho e quantidade.
  function volumeList(groups) {
    return h('ul', { class: 'vol-list', 'aria-label': 'Lixeiras encontradas' }, groups.map((g) => h('li', { class: 'vol-row' },
      h('span', { class: 'vol-ic' }, icon(groupIcon(g.id), 16)),
      h('span', { class: 'vol-nm', title: g.title }, g.title),
      h('span', { class: 'vol-n' }, plural(g.items.length, 'item', 'itens')),
      h('span', { class: 'vol-sz' }, fmtBytes(g.total)))));
  }

  function renderFda() {
    st.show(h('div', { class: 'panel' },
      h('div', { class: 'glyph-chip' }, icon('lock', 22)),
      h('h3', null, 'Acesso Total ao Disco necessário'),
      h('p', null, 'O macOS protege a Lixeira. Para o Limpae ver e esvaziar o que está nela, conceda acesso:'),
      h('ol', null, h('li', null, 'Abra Ajustes do Sistema › Privacidade e Segurança.'), h('li', null, 'Entre em Acesso Total ao Disco e ative o Limpae.'), h('li', null, 'Volte aqui e toque em Verificar de novo.')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => api.openFda().catch(() => {}) }, 'Abrir Ajustes'),
        h('button', { class: 'btn', type: 'button', onClick: async () => { await load(); ctx.refreshDisk(); } }, 'Verificar de novo'))));
    ctx.setDock(null);
  }

  // ---------- revisão ----------
  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const r = store.trash;
    const sel = selection();
    const back = () => { T.phase = 'ready'; render(); };
    const rv = createReview({
      result: r, sel, mod: 'trash', title: 'Lixeira',
      subtitle: `Revisar · ${plural(countItems(r), 'item', 'itens')} · ${fmtBytes(r.total)}`,
      extra: h('p', { class: 'pf-notice' }, icon('alert', 14), 'Esvaziar exclui os itens marcados de forma permanente. Desmarque o que quiser manter.'),
      actionLabel: 'Esvaziar', emptyText: 'A Lixeira está vazia.', ignore: false,
      onBack: back, onAction: () => empty(),
    });
    mount(ctx.root, rv.el);
    ctx.onBack(back);
  }

  // ---------- esvaziar ----------
  async function empty() {
    const r = store.trash;
    const sel = selection();
    const { bytes, count } = selectedSize(r, sel);
    if (!count) return;
    const vols = r.groups.filter((g) => g.items.some((i) => sel.has(i.id))).length;
    const plain = vols > 1;
    const ok = await confirmDialog({
      title: plain ? 'Esvaziar as lixeiras?' : 'Esvaziar a Lixeira?',
      body: [`${plural(count, 'item', 'itens')} (${fmtBytes(bytes)}${plain ? `, em ${plural(vols, 'lixeira', 'lixeiras')}` : ''}) serão `, h('strong', null, 'excluídos permanentemente'),
        '. Não é possível desfazer.', count < countItems(r) ? ` Os outros ${plural(countItems(r) - count, 'item fica', 'itens ficam')} na Lixeira.` : ''],
      confirm: count < countItems(r) ? 'Excluir selecionados' : plain ? 'Esvaziar lixeiras' : 'Esvaziar Lixeira', danger: true, glyph: 'trash', mod: 'trash',
    });
    if (!ok) return;
    ctx.onBack(null);
    ctx.setBusy(true);
    ensureStage();
    st.busy(true);
    st.show(h('h1', { class: 'h1' }, 'Esvaziando…'), h('p', { class: 'sub' }, 'Removendo itens da Lixeira.'));
    const sd = stopDock(ctx, 'trash');
    const res = await removeGroups(r, sel, (g, status, info) => { if (status !== 'run') sd.progress(info.done / info.total); }, { stopped: sd.stopped });
    bump();
    const left = pruneResult(r, res.okIds);
    store.trash = left;
    store.trashSelRef = left;
    for (const id of res.okIds) sel.delete(id);
    T.freed = res.freed; T.failed = res.failures.length; T.phase = 'done';
    play(res.freed ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    st.busy(false);
    render();
    if (res.failures.length) failuresSheet(res.failures);
  }

  function renderDone() {
    const left = store.trash ? countItems(store.trash) : 0;
    st.show(...big(T.freed, 'liberados'),
      h('p', { class: 'sub' }, left ? `${plural(left, 'item continua', 'itens continuam')} na Lixeira.` : 'A Lixeira foi esvaziada.'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        left ? h('button', { class: 'btn', type: 'button', onClick: () => { T.phase = 'ready'; render(); } }, icon('search', 15), 'Revisar itens restantes') : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { T.phase = 'idle'; store.trash = null; render(); } }, 'Concluir')));
    ctx.setDock(null);
  }

  render();
}
