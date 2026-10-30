// Gerenciador de revisão: grupos (esq.) + itens (dir.), busca, ordenação, seleção tri-state,
// menu de contexto por item e menu "Selecionar".
import { h, mount, mid } from '../dom.js';
import { icon, groupIcon } from '../art.js';
import { api } from '../api.js';
import { fmtBytes, ageText } from '../format.js';
import { t, tn, tr, cmp } from '../i18n.js';
import { checkbox, segmented, toast, managerBar } from '../ui.js';
import { selectedSize } from '../store.js';

const CHUNK = 250;

// ---- Menu DOM acessível (contexto e "Selecionar") ----
let closeActive = null;

// items: { label, icon?, checked?, disabled?, danger?, onSelect } | { sep: true }.
// `at` = { x, y } em coordenadas de viewport; `opener` recebe o foco ao fechar.
export function openMenu({ items, at, label, opener, onClose }) {
  if (closeActive) closeActive(false);
  const menu = h('div', { class: 'ctx-menu', role: 'menu', 'aria-label': label || t('Ações'), style: 'visibility:hidden' });
  const btns = [];
  for (const it of items) {
    if (it.sep) { menu.append(h('div', { class: 'ctx-sep', role: 'separator' })); continue; }
    const radio = it.checked != null;
    const b = h('button', {
      class: 'ctx-item' + (it.danger ? ' danger' : ''), type: 'button', tabindex: '-1', disabled: !!it.disabled,
      role: radio ? 'menuitemradio' : 'menuitem', 'aria-checked': radio ? String(!!it.checked) : null,
      onClick: () => { close(true); it.onSelect(); },
    }, h('span', { class: 'ctx-ic' }, radio ? (it.checked ? icon('check', 14) : null) : (it.icon ? icon(it.icon, 15) : null)), h('span', { class: 'ctx-label' }, it.label));
    btns.push(b);
    menu.append(b);
  }
  const enabled = () => btns.filter((b) => !b.disabled);
  const focusAt = (i) => { const list = enabled(); if (list.length) list[(i + list.length) % list.length].focus(); };

  function onKey(e) {
    const list = enabled();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); focusAt(i < 0 ? -1 : i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(-1); }
    else if (e.key === 'Tab') close(false);
  }
  const onDown = (e) => { if (!menu.contains(e.target)) close(false); };
  const onAway = () => close(false);
  function close(restoreFocus) {
    if (closeActive !== close) return;
    closeActive = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('scroll', onAway, true);
    window.removeEventListener('resize', onAway);
    window.removeEventListener('blur', onAway);
    menu.remove();
    if (onClose) onClose();
    if (restoreFocus && opener && opener.isConnected) opener.focus();
  }
  closeActive = close;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('scroll', onAway, true);
  window.addEventListener('resize', onAway);
  window.addEventListener('blur', onAway);

  document.body.append(menu);
  const w = menu.offsetWidth, hh = menu.offsetHeight;
  const left = Math.max(8, Math.min(at.x, window.innerWidth - w - 8));
  const top = at.y + hh + 8 > window.innerHeight ? Math.max(8, at.y - hh) : at.y;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.visibility = '';
  if (opener) focusAt(0); // aberto por teclado ou por botão: o foco entra no menu
  return { close };
}

// Ponto de ancoragem de um elemento (canto inferior esquerdo) para menus abertos pelo teclado.
const below = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; };
const isMenuKey = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

// title = nome do módulo (barra superior, com "Voltar"); subtitle = o que esta revisão mostra.
// ignore: false esconde "Ignorar" (a Lixeira não vai para a lista de ignorados); quickLook: false esconde
// "Visualização Rápida" (abrir um arquivo do iCloud o baixaria de novo).
export function createReview({ result, sel, mod, title, subtitle, actionLabel, showAge = false, extra = null, onBack, onAction, emptyText = null, ignore = true, quickLook = true, gid = null }) {
  const st = { q: '', sort: 'size', gid: result.groups.some((g) => g.id === gid) ? gid : (result.groups[0] ? result.groups[0].id : null), limit: CHUNK, anchor: null };
  const groupsEl = h('div', { class: 'rv-groups' });
  const itemsEl = h('div', { class: 'rv-items-wrap' });
  const selEl = h('div', { class: 'rv-sel' });
  const actionBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => onAction(new Set(sel)) }, actionLabel);

  const sorter = () => (st.sort === 'size' ? (a, b) => b.size - a.size : (a, b) => cmp(a.name, b.name));
  const visible = (g) => {
    const q = st.q.trim().toLowerCase();
    const items = q ? g.items.filter((i) => i.name.toLowerCase().includes(q) || i.path.toLowerCase().includes(q)) : g.items;
    return [...items].sort(sorter());
  };
  const groupState = (g) => {
    let n = 0;
    for (const i of g.items) if (sel.has(i.id)) n++;
    return n === 0 ? 'off' : n === g.items.length ? 'on' : 'mixed';
  };
  const groupsShown = () => {
    const gs = st.q.trim() ? result.groups.filter((g) => visible(g).length) : result.groups.slice();
    return gs.sort(st.sort === 'size' ? (a, b) => b.total - a.total : (a, b) => cmp(tr(a.title), tr(b.title)));
  };

  function renderFooter() {
    const { bytes, count } = selectedSize(result, sel);
    // Seleções fora da categoria aberta também valem para a ação: o rodapé diz em quantas categorias estão.
    const cats = result.groups.filter((g) => g.items.some((i) => sel.has(i.id))).length;
    if (!count) mount(selEl, t('Nenhum item selecionado'));
    else mount(selEl, t('Selecionado: '), h('b', null, fmtBytes(bytes)), h('small', null, cats > 1 ? tn(count, '{n} item em {cats}', '{n} itens em {cats}', { cats: tn(cats, '{n} categoria', '{n} categorias') }) : tn(count, '{n} item', '{n} itens')));
    actionBtn.disabled = count === 0;
  }

  function renderGroups() {
    const gs = groupsShown();
    if (!gs.some((g) => g.id === st.gid)) st.gid = gs[0] ? gs[0].id : null;
    mount(groupsEl, gs.map((g) => {
      const cb = checkbox(groupState(g), (s0) => { for (const i of g.items) s0 === 'on' ? sel.delete(i.id) : sel.add(i.id); refresh(); }, t('Selecionar grupo {name}', { name: tr(g.title) }));
      return h('div', { class: 'rv-group', 'aria-current': String(g.id === st.gid) },
        cb,
        h('button', { class: 'rv-group-main', type: 'button', onClick: () => { if (st.gid !== g.id) { st.gid = g.id; st.limit = CHUNK; renderGroups(); renderItems(); } } },
          h('span', { class: 'rv-gic' }, icon(groupIcon(g.id), 15)),
          h('span', { class: 'rv-gtxt' }, h('b', { title: tr(g.title) }, tr(g.title)), h('span', null, `${fmtBytes(g.total)} · ${tn(g.items.length, '{n} item', '{n} itens')}`))));
    }));
  }

  // Remove o item da revisão (já foi para a lista de ignorados no backend): ajusta grupos e totais no lugar.
  function dropLocal(it) {
    for (const g of result.groups) {
      const i = g.items.indexOf(it);
      if (i < 0) continue;
      g.items.splice(i, 1);
      g.total -= it.size;
      result.total -= it.size;
      if (!g.items.length) result.groups.splice(result.groups.indexOf(g), 1);
      break;
    }
    sel.delete(it.id);
    refresh();
  }

  async function ignoreItem(it) {
    try {
      await api.ignore(it.id);
    } catch (e) { return; } // o erro já foi mostrado
    dropLocal(it);
    toast(t('“{name}” não aparecerá mais nas análises. Gerencie em Ajustes.', { name: it.name }), 'ok');
  }

  function rowMenu(g, it, list, row, at, opener) {
    const on = sel.has(it.id);
    row.classList.add('ctx-open');
    openMenu({
      at, opener, label: t('Ações de {name}', { name: it.name }), onClose: () => row.classList.remove('ctx-open'),
      items: [
        { label: on ? t('Desmarcar') : t('Selecionar'), icon: 'select', onSelect: () => { on ? sel.delete(it.id) : sel.add(it.id); refresh(); } },
        { label: t('Mostrar no Finder'), icon: 'reveal', onSelect: () => api.reveal(it.id).catch(() => {}) },
        quickLook ? { label: t('Visualização Rápida'), icon: 'eye', onSelect: () => api.quickLook(it.id).catch(() => {}) } : null,
        ignore ? { sep: true } : null,
        ignore ? { label: t('Ignorar'), icon: 'ban', onSelect: () => ignoreItem(it) } : null,
      ].filter(Boolean),
    });
  }

  function itemRow(g, it, list) {
    const cb = checkbox(sel.has(it.id) ? 'on' : 'off', (_s, e) => toggle(e), t('Selecionar {name}', { name: it.name }));
    // Shift+clique aplica o novo estado a todo o intervalo desde o último item clicado (como no Finder).
    const toggle = (e) => {
      const on = !sel.has(it.id);
      const a = e && e.shiftKey && st.anchor != null ? list.findIndex((x) => x.id === st.anchor) : -1;
      const b = list.findIndex((x) => x.id === it.id);
      if (a >= 0 && b >= 0) {
        for (let k = Math.min(a, b); k <= Math.max(a, b); k++) on ? sel.add(list[k].id) : sel.delete(list[k].id);
        st.anchor = it.id;
        return refresh();
      }
      on ? sel.add(it.id) : sel.delete(it.id);
      st.anchor = it.id;
      cb.set(on ? 'on' : 'off'); renderGroups(); renderFooter(); renderHead(g, list);
    };
    const more = h('button', {
      class: 'icon-btn rv-act', type: 'button', title: t('Mais ações'), 'aria-label': t('Mais ações para {name}', { name: it.name }), 'aria-haspopup': 'menu',
      onClick: (e) => { e.stopPropagation(); rowMenu(g, it, list, row, below(more), more); },
    }, icon('more', 16));
    // Notas curtas viram selo ao lado do nome; as longas (ex.: caminho ausente) ganham uma linha própria.
    const longNote = !!it.note && it.note.length > 30;
    const row = h('div', {
      class: 'rv-item' + (longNote ? ' has-note' : ''), onClick: (e) => toggle(e),
      onContextmenu: (e) => { e.preventDefault(); rowMenu(g, it, list, row, { x: e.clientX, y: e.clientY }, null); },
      onKeydown: (e) => { if (isMenuKey(e)) { e.preventDefault(); rowMenu(g, it, list, row, below(more), more); } },
    },
    cb,
    h('div', { class: 'rv-ic' }, icon(groupIcon(g.id), 16)),
    h('div', { class: 'rv-main' },
      h('div', { class: 'rv-name' }, h('span', { title: it.name }, it.name), it.note && !longNote ? h('span', { class: 'badge' + (it.selected ? ' info' : ''), title: tr(it.note) }, tr(it.note)) : null),
      h('div', { class: 'rv-meta' }, mid(it.path, 26)),
      longNote ? h('div', { class: 'rv-note' + (it.selected ? ' info' : ''), title: tr(it.note) }, tr(it.note)) : null),
    h('span', { class: 'rv-size' }, fmtBytes(it.size), showAge && it.modified ? h('small', { class: 'rv-age' }, ageText(it.modified)) : null),
    h('button', { class: 'icon-btn rv-act', type: 'button', title: t('Mostrar no Finder'), 'aria-label': t('Mostrar {name} no Finder', { name: it.name }), onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 16)),
    more);
    return row;
  }

  // Seleção do grupo aberto (respeita a busca): Tudo, Nada ou a seleção padrão do backend.
  const smartEq = (list) => list.every((i) => sel.has(i.id) === !!i.selected);
  function selectMode(list) {
    const n = list.filter((i) => sel.has(i.id)).length;
    if (list.length && n === list.length) return 'all';
    if (n === 0) return 'none';
    return smartEq(list) ? 'smart' : 'part';
  }
  const modeLabel = (m) => (m === 'all' ? t('Tudo') : m === 'none' ? t('Nada') : m === 'smart' ? t('Inteligente') : t('Parcial'));

  function openSelectMenu(list, btn) {
    const mode = selectMode(list);
    btn.setAttribute('aria-expanded', 'true');
    openMenu({
      at: below(btn), opener: btn, label: t('Selecionar'), onClose: () => btn.setAttribute('aria-expanded', 'false'),
      items: [
        { label: t('Seleção inteligente'), checked: mode === 'smart', onSelect: () => { for (const i of list) i.selected ? sel.add(i.id) : sel.delete(i.id); refresh(); } },
        { label: t('Tudo'), checked: mode === 'all', onSelect: () => { for (const i of list) sel.add(i.id); refresh(); } },
        { label: t('Nada'), checked: mode === 'none', onSelect: () => { for (const i of list) sel.delete(i.id); refresh(); } },
      ],
    });
  }

  let headEl = null;
  function renderHead(g, list) {
    if (!headEl) return;
    const mode = selectMode(list);
    const btn = h('button', { class: 'btn sm ghost sel-btn', type: 'button', disabled: !list.length, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: () => openSelectMenu(list, btn) },
      t('Selecionar: '), h('b', null, modeLabel(mode)), icon('chevron', 14));
    mount(headEl, h('div', { class: 't' }, h('b', null, tr(g.title)), h('span', { title: tr(g.description) }, tr(g.description))), btn);
  }

  function renderItems() {
    const g = result.groups.find((x) => x.id === st.gid);
    if (!g) { mount(itemsEl, h('div', { class: 'rv-empty' }, st.q ? t('Nenhum item corresponde à busca.') : (emptyText || t('Nada encontrado.')))); return; }
    const list = visible(g);
    headEl = h('div', { class: 'rv-items-head' });
    const body = h('div', { class: 'rv-items' });
    const shown = list.slice(0, st.limit);
    body.append(...shown.map((it) => itemRow(g, it, list)));
    if (list.length > shown.length) {
      body.append(h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { st.limit += CHUNK; renderItems(); } }, t('Mostrar mais ({count})', { count: tn(list.length - shown.length, '{n} item', '{n} itens') }))));
    }
    if (!list.length) body.append(h('div', { class: 'rv-empty' }, t('Nenhum item corresponde à busca.')));
    mount(itemsEl, headEl, body);
    renderHead(g, list);
  }

  function refresh() { renderGroups(); renderItems(); renderFooter(); }

  const search = h('label', { class: 'search' }, icon('search', 16),
    h('input', { type: 'search', placeholder: t('Buscar'), 'aria-label': t('Buscar itens'), spellcheck: 'false', onInput: (e) => { st.q = e.target.value; st.limit = CHUNK; refresh(); } }));
  const sort = segmented([{ value: 'size', label: t('Tamanho') }, { value: 'name', label: t('Nome') }], st.sort, (v) => { st.sort = v; refresh(); }, t('Ordenar por'));

  const el = h('section', { class: 'review enter', dataset: { mod }, 'aria-label': title },
    managerBar({ title, subtitle, onBack, controls: [search, sort] }),
    extra ? h('div', { class: 'rv-extra' }, extra) : null,
    h('div', { class: 'rv-body' }, groupsEl, itemsEl),
    h('div', { class: 'rv-foot' }, selEl, actionBtn));
  // ⌘A seleciona todos os itens visíveis do grupo aberto; ⌘⇧A desmarca (fora de campos de texto).
  el.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a' || e.target.tagName === 'INPUT') return;
    const g = result.groups.find((x) => x.id === st.gid);
    if (!g) return;
    e.preventDefault();
    for (const i of visible(g)) e.shiftKey ? sel.delete(i.id) : sel.add(i.id);
    refresh();
  });
  el.tabIndex = -1;
  refresh();
  return { el };
}
