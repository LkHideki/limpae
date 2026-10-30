// Lixeira: tamanho/itens, esvaziar com confirmação permanente, e painel de Acesso Total ao Disco.
import { play } from '../sound.js';
import { h, mount } from '../dom.js';
import { icon, groupIcon } from '../art.js';
import { api } from '../api.js';
import { store, countItems, bump } from '../store.js';
import { bytesParts, fmtBytes, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage } from '../ui.js';
import { removeGroups } from '../actions.js';

export function enter(ctx) {
  const T = store.trashUi;
  const st = stage('trash', 'trash', 260);
  let cancelled = false;
  mount(ctx.root, st.el);
  ctx.reserveDock(true);

  const big = (n, cap) => [h('div', { class: 'big' }, bytesParts(n).value, h('small', null, bytesParts(n).unit)), h('div', { class: 'big-cap' }, cap)];

  async function load() {
    cancelled = false;
    ctx.setBusy(true);
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, 'Verificando…'), h('p', { class: 'sub' }, 'Lendo o conteúdo da Lixeira.'), ticker);
    ctx.onProgress((p) => { if (p.task === 'trash') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'trash', onClick: () => { cancelled = true; api.cancel().catch(() => {}); } });
    try {
      const r = await api.trash();
      if (!cancelled) { store.trash = r; T.phase = 'ready'; }
    } catch (e) { /* toast já exibido */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    st.busy(false);
    render();
  }

  function render() {
    const r = store.trash;
    if (T.phase === 'done') return renderDone();
    if (!r) {
      st.show(h('h1', { class: 'h1' }, 'Lixeira'), h('p', { class: 'sub' }, 'Não foi possível ler a Lixeira agora.'),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: load }, 'Tentar de novo')));
      return ctx.setDock(null);
    }
    if (r.needsFda && !r.groups.length) return renderFda();
    const n = countItems(r);
    if (!n || r.total === 0) {
      st.show(h('h1', { class: 'h1' }, 'Lixeira vazia'), h('p', { class: 'sub' }, 'Não há nada para esvaziar.'),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: load }, icon('refresh', 15), 'Atualizar')));
      return ctx.setDock(null);
    }
    const multi = r.groups.length > 1 || r.groups.some((g) => g.id !== 'trash');
    st.show(...big(r.total, multi ? `em ${plural(n, 'item', 'itens')} de ${plural(r.groups.length, 'lixeira', 'lixeiras')}` : `em ${plural(n, 'item', 'itens')} na Lixeira`),
      h('p', { class: 'sub' }, 'Esvaziar remove tudo de forma permanente: depois disso não há como recuperar.'),
      multi ? volumeList(r.groups) : null,
      r.needsFda ? h('p', { class: 'fda-hint' }, 'A Lixeira do Mac não foi lida: ela exige Acesso Total ao Disco. ', h('button', { class: 'link', type: 'button', onClick: () => api.openFda().catch(() => {}) }, 'Abrir Ajustes')) : null,
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: load }, icon('refresh', 15), 'Atualizar')));
    ctx.setDock({ label: 'Esvaziar', mod: 'trash', onClick: empty });
  }

  // Uma linha por lixeira: a do Mac e uma por volume externo, com tamanho e quantidade.
  function volumeList(groups) {
    return h('ul', { class: 'vol-list', 'aria-label': 'Lixeiras encontradas' }, groups.map((g) => h('li', { class: 'vol-row' },
      h('span', { class: 'vol-ic' }, icon(groupIcon(g.id), 16)),
      h('span', { class: 'vol-nm', title: g.title }, g.id === 'trash' ? 'Lixeira do Mac' : g.title),
      h('span', { class: 'vol-n' }, plural(g.items.length, 'item', 'itens')),
      h('span', { class: 'vol-sz' }, fmtBytes(g.total)))));
  }

  function renderFda() {
    st.show(h('div', { class: 'panel' },
      h('div', { class: 'glyph-chip' }, icon('lock', 22)),
      h('h3', null, 'Acesso Total ao Disco necessário'),
      h('p', null, 'O macOS protege a Lixeira. Para o Limpaemeo ver e esvaziar o que está nela, conceda acesso:'),
      h('ol', null, h('li', null, 'Abra Ajustes do Sistema › Privacidade e Segurança.'), h('li', null, 'Entre em Acesso Total ao Disco e ative o Limpaemeo.'), h('li', null, 'Volte aqui e toque em Verificar de novo.')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => api.openFda().catch(() => {}) }, 'Abrir Ajustes'),
        h('button', { class: 'btn', type: 'button', onClick: async () => { await load(); ctx.refreshDisk(); } }, 'Verificar de novo'))));
    ctx.setDock(null);
  }

  async function empty() {
    const r = store.trash;
    const n = countItems(r);
    const ok = await confirmDialog({
      title: r.groups.length > 1 ? 'Esvaziar as lixeiras?' : 'Esvaziar a Lixeira?',
      body: [`${plural(n, 'item', 'itens')} (${bytesParts(r.total).value} ${bytesParts(r.total).unit}${r.groups.length > 1 ? `, em ${plural(r.groups.length, 'lixeira', 'lixeiras')}` : ''}) serão `, h('strong', null, 'excluídos permanentemente'), '. Não é possível desfazer.'],
      confirm: r.groups.length > 1 ? 'Esvaziar lixeiras' : 'Esvaziar Lixeira', danger: true, glyph: 'trash', mod: 'trash',
    });
    if (!ok) return;
    ctx.setBusy(true);
    st.busy(true);
    st.show(h('h1', { class: 'h1' }, 'Esvaziando…'), h('p', { class: 'sub' }, 'Removendo itens da Lixeira.'));
    ctx.setDock({ label: 'Esvaziando', busy: true, mod: 'trash' });
    const all = new Set(r.groups.flatMap((g) => g.items.map((i) => i.id)));
    const res = await removeGroups(r, all);
    bump();
    T.freed = res.freed; T.phase = 'done'; store.trash = null;
    play(res.freed ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    st.busy(false);
    render();
    if (res.failures.length) failuresSheet(res.failures);
  }

  function renderDone() {
    st.show(...big(T.freed, 'liberados'), h('p', { class: 'sub' }, 'A Lixeira foi esvaziada.'),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => { T.phase = 'idle'; load(); } }, icon('refresh', 15), 'Verificar de novo')));
    ctx.setDock(null);
  }

  if (T.phase === 'done') render();
  else if (store.trash) { T.phase = 'ready'; render(); }
  else load();
}
