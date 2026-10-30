// Meus Arquivos: arquivos grandes por tamanho mínimo; nada vem pré-selecionado; ação = mover para o Lixo.
import { h, mount } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store, selectedSize, pruneResult, bump, countItems } from '../store.js';
import { bytesParts, fmtBytes, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, chipRow } from '../ui.js';
import { removeGroups } from '../actions.js';
import { createReview } from './review.js';

const OPTIONS = [{ value: 50, label: '50 MB' }, { value: 100, label: '100 MB' }, { value: 500, label: '500 MB' }, { value: 1000, label: '1 GB' }];

export function enter(ctx) {
  const F = store.files;
  let st = null, cancelled = false;
  if (F.phase !== 'done' && F.phase !== 'idle' && !store.large) F.phase = 'idle';

  function ensureStage() {
    if (!st) { st = stage('files', 'folder', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    st.busy(false);
  }

  const chips = (onChange) => chipRow(OPTIONS, store.largeMb, (v) => { store.largeMb = v; if (onChange) onChange(v); });

  function render() {
    if (F.phase === 'review' && store.large) return renderReview();
    ensureStage();
    if (F.phase === 'done') return renderDone();
    return renderIdle();
  }

  function renderIdle() {
    F.phase = 'idle';
    st.show(h('h1', { class: 'h1' }, 'Meus Arquivos'), h('p', { class: 'sub' }, 'Encontre arquivos grandes que você já esqueceu e decida o que vai para o Lixo.'),
      h('div', { style: 'margin-top:26px' }, h('p', { class: 'sub', style: 'font-size:13px;margin:0 0 10px' }, 'Tamanho mínimo'), chips()),
      store.large ? h('div', { class: 'row-actions' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { F.phase = 'review'; render(); } }, 'Voltar aos resultados')) : null);
    ctx.setDock({ label: 'Analisar', mod: 'files', onClick: () => scan(store.largeMb) });
  }

  async function scan(mb) {
    cancelled = false;
    F.phase = 'scanning';
    ctx.setBusy(true);
    ensureStage();
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, 'Procurando arquivos…'), h('p', { class: 'sub' }, `Arquivos acima de ${fmtBytes(mb * 1e6)}.`), ticker);
    ctx.onProgress((p) => { if (p.task === 'large') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'files', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'files' }); api.cancel().catch(() => {}); } });
    let ok = false;
    try {
      const r = await api.large(mb);
      if (!cancelled) { store.large = r; store.largeSel = new Set(); bump(); ok = true; }
    } catch (e) { /* toast já exibido */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    F.phase = ok ? 'review' : 'idle';
    render();
  }

  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const rv = createReview({
      result: store.large, sel: store.largeSel, mod: 'files', title: 'Arquivos grandes',
      subtitle: store.large.groups.length ? `${plural(countItems(store.large), 'arquivo', 'arquivos')} acima de ${fmtBytes(store.largeMb * 1e6)} · ${fmtBytes(store.large.total)}` : null,
      actionLabel: 'Mover para o Lixo', showAge: true, extra: chips((mb) => scan(mb)),
      emptyText: `Nenhum arquivo acima de ${fmtBytes(store.largeMb * 1e6)}.`,
      onBack: () => { F.phase = 'idle'; render(); }, onAction: () => move(),
    });
    mount(ctx.root, rv.el);
  }

  async function move() {
    const { bytes, count } = selectedSize(store.large, store.largeSel);
    const ok = await confirmDialog({
      title: `Mover ${plural(count, 'arquivo', 'arquivos')} para o Lixo?`,
      body: [`${fmtBytes(bytes)} serão enviados ao Lixo. Você pode restaurá-los de lá `, h('strong', null, 'até esvaziar a Lixeira'), '.'],
      confirm: 'Mover para o Lixo', glyph: 'trash', mod: 'files',
    });
    if (!ok) return;
    F.phase = 'moving';
    ctx.setBusy(true);
    st = null; ensureStage(); st.busy(true);
    st.show(h('h1', { class: 'h1' }, 'Movendo para o Lixo…'), h('p', { class: 'sub' }, plural(count, 'arquivo', 'arquivos') + '.'));
    ctx.setDock({ label: 'Movendo', busy: true, mod: 'files' });
    const res = await removeGroups(store.large, store.largeSel);
    store.large = pruneResult(store.large, res.okIds);
    for (const id of res.okIds) store.largeSel.delete(id);
    bump(); store.trash = null;
    F.moved = res.freed; F.failed = res.failures.length; F.phase = 'done';
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (res.failures.length) failuresSheet(res.failures);
  }

  function renderDone() {
    st.show(h('div', { class: 'big' }, bytesParts(F.moved).value, h('small', null, bytesParts(F.moved).unit)), h('div', { class: 'big-cap' }, 'movidos para o Lixo'),
      h('p', { class: 'sub' }, 'Esvazie a Lixeira para liberar o espaço no disco.'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        store.large && store.large.groups.length ? h('button', { class: 'btn primary', type: 'button', onClick: () => { F.phase = 'review'; render(); } }, 'Continuar revisando') : null,
        h('button', { class: 'btn', type: 'button', onClick: () => ctx.nav('trash') }, icon('trash', 15), 'Ir para a Lixeira')));
    ctx.setDock(null);
  }

  if (F.phase === 'done' || F.phase === 'review') render();
  else { F.phase = 'idle'; render(); }
}
