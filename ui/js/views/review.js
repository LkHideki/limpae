// Gerenciador de revisão: grupos (esq.) + itens (dir.), busca, ordenação, seleção tri-state.
import { h, mount, mid } from '../dom.js';
import { icon, groupIcon } from '../art.js';
import { api } from '../api.js';
import { fmtBytes, plural, ageText } from '../format.js';
import { checkbox, segmented } from '../ui.js';
import { selectedSize } from '../store.js';

const CHUNK = 250;

export function createReview({ result, sel, mod, title, subtitle, actionLabel, showAge = false, extra = null, onBack, onAction, emptyText = 'Nada encontrado.' }) {
  const st = { q: '', sort: 'size', gid: result.groups[0] ? result.groups[0].id : null, limit: CHUNK };
  const groupsEl = h('div', { class: 'rv-groups' });
  const itemsEl = h('div', { class: 'rv-items-wrap' });
  const selEl = h('div', { class: 'rv-sel' });
  const actionBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => onAction(new Set(sel)) }, actionLabel);

  const cmp = () => (st.sort === 'size' ? (a, b) => b.size - a.size : (a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
  const visible = (g) => {
    const q = st.q.trim().toLowerCase();
    const items = q ? g.items.filter((i) => i.name.toLowerCase().includes(q) || i.path.toLowerCase().includes(q)) : g.items;
    return [...items].sort(cmp());
  };
  const groupState = (g) => {
    let n = 0;
    for (const i of g.items) if (sel.has(i.id)) n++;
    return n === 0 ? 'off' : n === g.items.length ? 'on' : 'mixed';
  };
  const groupsShown = () => {
    const gs = st.q.trim() ? result.groups.filter((g) => visible(g).length) : result.groups.slice();
    return gs.sort(st.sort === 'size' ? (a, b) => b.total - a.total : (a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  };

  function renderFooter() {
    const { bytes, count } = selectedSize(result, sel);
    mount(selEl, 'Selecionado: ', h('b', null, fmtBytes(bytes)), h('small', null, plural(count, 'item', 'itens')));
    actionBtn.disabled = count === 0;
  }

  function renderGroups() {
    const gs = groupsShown();
    if (!gs.some((g) => g.id === st.gid)) st.gid = gs[0] ? gs[0].id : null;
    mount(groupsEl, gs.map((g) => {
      const cb = checkbox(groupState(g), (s0) => { for (const i of g.items) s0 === 'on' ? sel.delete(i.id) : sel.add(i.id); refresh(); }, `Selecionar grupo ${g.title}`);
      return h('div', { class: 'rv-group', 'aria-current': String(g.id === st.gid) },
        cb,
        h('button', { class: 'rv-group-main', type: 'button', onClick: () => { if (st.gid !== g.id) { st.gid = g.id; st.limit = CHUNK; renderGroups(); renderItems(); } } },
          h('b', { title: g.title }, g.title), h('span', null, `${fmtBytes(g.total)} · ${plural(g.items.length, 'item', 'itens')}`)));
    }));
  }

  function itemRow(g, it, list) {
    const cb = checkbox(sel.has(it.id) ? 'on' : 'off', () => toggle(), `Selecionar ${it.name}`);
    const toggle = () => { sel.has(it.id) ? sel.delete(it.id) : sel.add(it.id); cb.set(sel.has(it.id) ? 'on' : 'off'); renderGroups(); renderFooter(); renderHead(g, list); };
    return h('div', { class: 'rv-item', onClick: toggle },
      cb,
      h('div', { class: 'rv-ic' }, icon(groupIcon(g.id), 16)),
      h('div', { class: 'rv-main' },
        h('div', { class: 'rv-name' }, h('span', { title: it.name }, it.name), it.note ? h('span', { class: 'badge' }, it.note) : null),
        h('div', { class: 'rv-meta' }, mid(it.path, 26))),
      h('span', { class: 'rv-size' }, fmtBytes(it.size), showAge && it.modified ? h('small', { class: 'rv-age' }, ageText(it.modified)) : null),
      h('button', { class: 'icon-btn rv-act', type: 'button', title: 'Mostrar no Finder', 'aria-label': `Mostrar ${it.name} no Finder`, onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 16)));
  }

  let headEl = null;
  function renderHead(g, list) {
    if (!headEl) return;
    const all = list.length > 0 && list.every((i) => sel.has(i.id));
    mount(headEl,
      h('div', { class: 't' }, h('b', null, g.title), h('span', { title: g.description }, g.description)),
      h('button', { class: 'btn sm ghost', type: 'button', disabled: !list.length, onClick: () => { for (const i of list) all ? sel.delete(i.id) : sel.add(i.id); refresh(); } }, all ? 'Desmarcar tudo' : 'Selecionar tudo'));
  }

  function renderItems() {
    const g = result.groups.find((x) => x.id === st.gid);
    if (!g) { mount(itemsEl, h('div', { class: 'rv-empty' }, st.q ? 'Nenhum item corresponde à busca.' : emptyText)); return; }
    const list = visible(g);
    headEl = h('div', { class: 'rv-items-head' });
    const body = h('div', { class: 'rv-items' });
    const shown = list.slice(0, st.limit);
    body.append(...shown.map((it) => itemRow(g, it, list)));
    if (list.length > shown.length) {
      body.append(h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { st.limit += CHUNK; renderItems(); } }, `Mostrar mais (${plural(list.length - shown.length, 'item', 'itens')})`)));
    }
    if (!list.length) body.append(h('div', { class: 'rv-empty' }, 'Nenhum item corresponde à busca.'));
    mount(itemsEl, headEl, body);
    renderHead(g, list);
  }

  function refresh() { renderGroups(); renderItems(); renderFooter(); }

  const search = h('label', { class: 'search' }, icon('search', 16),
    h('input', { type: 'search', placeholder: 'Buscar', 'aria-label': 'Buscar itens', spellcheck: 'false', onInput: (e) => { st.q = e.target.value; st.limit = CHUNK; refresh(); } }));
  const sort = segmented([{ value: 'size', label: 'Tamanho' }, { value: 'name', label: 'Nome' }], st.sort, (v) => { st.sort = v; refresh(); }, 'Ordenar por');

  const el = h('section', { class: 'review enter', dataset: { mod }, 'aria-label': title },
    h('div', { class: 'rv-head' }, h('div', { class: 'rv-title' }, h('h2', null, title), subtitle ? h('p', null, subtitle) : null), search, sort),
    extra ? h('div', { class: 'rv-extra' }, extra) : null,
    h('div', { class: 'rv-body' }, groupsEl, itemsEl),
    h('div', { class: 'rv-foot' }, selEl, h('button', { class: 'btn', type: 'button', onClick: onBack }, 'Voltar'), actionBtn));
  refresh();
  return { el };
}
