// Review manager: groups (left) + items (right), search, sorting, tri-state selection,
// per-item context menu and "Select" menu.
import { h, mount, mid } from '../dom.js';
import { icon, groupIcon } from '../art.js';
import { api } from '../api.js';
import { fmtBytes, ageText } from '../format.js';
import { t, tn, tr, cmp } from '../i18n.js';
import { checkbox, confirmDialog, segmented, toast, managerBar } from '../ui.js';
import { selectedSize } from '../store.js';
import { nativeMenuApi, popupNative } from '../native-menu.js';

const CHUNK = 250;

// ---- Accessible DOM menu (context and "Select") ----
let closeActive = null, activeOpener = null;

// items: { label, icon?, checked?, disabled?, danger?, selects?, onSelect } | { sep: true }.
// `at` = { x, y } in viewport coordinates; `opener` receives focus on close.
// Inside the app (Tauri menu API present) this is a native NSMenu; the accessible DOM menu below is the fallback for a
// browser preview and for the case where the native one cannot be shown.
export function openMenu(opts) {
  const api = nativeMenuApi();
  if (!api) return openDomMenu(opts);
  let dom = null;
  const { opener, onClose } = opts;
  popupNative(api, opts).then(() => {
    if (onClose) onClose();
    if (opener && opener.isConnected) opener.focus();
  }, () => { dom = openDomMenu(opts); });
  return { close() { if (dom) dom.close(); } };
}

function openDomMenu({ items, at, label, opener, onClose }) {
  // Clicking the opener of the open menu toggles it closed (no new menu, so no second 'menu' cue).
  if (opener && closeActive && activeOpener === opener) { closeActive(true); return { close() {} }; }
  if (closeActive) closeActive(false);
  const menu = h('div', { class: 'ctx-menu', role: 'menu', 'aria-label': label || t('Ações'), style: 'visibility:hidden' });
  const btns = [];
  for (const it of items) {
    if (it.sep) { menu.append(h('div', { class: 'ctx-sep', role: 'separator' })); continue; }
    const radio = it.checked != null;
    const b = h('button', {
      class: 'ctx-item' + (it.danger ? ' danger' : ''), type: 'button', tabindex: '-1', disabled: !!it.disabled, dataset: it.selects ? { selects: it.selects } : null,
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
  // The opener counts as inside: its own click closes the menu (see the top of openMenu).
  const onDown = (e) => { if (!menu.contains(e.target) && !(opener && opener.contains(e.target))) close(false); };
  const onAway = () => close(false);
  function close(restoreFocus) {
    if (closeActive !== close) return;
    closeActive = null; activeOpener = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('scroll', onAway, true);
    window.removeEventListener('resize', onAway);
    window.removeEventListener('blur', onAway);
    menu.remove();
    if (onClose) onClose();
    if (restoreFocus && opener && opener.isConnected) opener.focus();
  }
  closeActive = close; activeOpener = opener || null;
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
  if (opener) focusAt(0); // opened by keyboard or by button: focus enters the menu
  return { close };
}

// Anchor point of an element (bottom-left corner) for menus opened by keyboard.
const below = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; };
const isMenuKey = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

// title = module name (top bar, with "Back"); subtitle = what this review shows.
// ignore: false hides "Ignore" (Trash is not sent to the ignored list); quickLook: false hides
// "Quick Look" (opening an iCloud file would download it again).
// simulate: offers "Simulate" (a dry run of the removal, with a report file); off for actions that are not removals.
// Dry run: the backend runs every removal check without removing anything and writes a report.
// onReady runs once the dry run returns (before the report dialog opens), to end the button's busy state.
async function simulateRemoval(ids, mod, onReady = () => {}) {
  let r;
  try { r = await api.simulate(ids, false); } catch (e) { return; } finally { onReady(); }
  const line = (label, tally) => h('li', null, h('span', null, label), h('b', { class: 'num' }, tn(tally.count, '{n} item', '{n} itens'), ' · ', fmtBytes(tally.bytes)));
  const reasons = new Map();
  for (const x of r.refused) reasons.set(x.error, (reasons.get(x.error) || 0) + 1);
  const body = h('div', { class: 'sim' },
    h('p', null, t('Nada foi removido. Se você limpar agora:')),
    h('ul', { class: 'sim-list' },
      line(t('Apagados definitivamente'), r.delete),
      line(t('Movidos para o Lixo (recuperáveis)'), r.trash),
      r.refused.length ? h('li', { class: 'bad' }, h('span', null, t('Recusados pela verificação de segurança')), h('b', { class: 'num' }, tn(r.refused.length, '{n} item', '{n} itens'))) : null),
    reasons.size ? h('ul', { class: 'sim-why' }, [...reasons].map(([why, n]) => h('li', null, tr(why), n > 1 ? ' (' + n + ')' : ''))) : null);
  const show = await confirmDialog({ title: t('Simulação da limpeza'), body, confirm: r.report ? t('Ver relatório') : t('Fechar'), cancel: t('Fechar'), glyph: 'search', mod });
  if (show && r.report) api.revealReport(r.report).catch(() => {});
}

export function createReview({ result, sel, mod, title, subtitle, actionLabel, showAge = false, extra = null, onBack, onAction, emptyText = null, ignore = true, quickLook = true, gid = null, simulate = true }) {
  const st = { q: '', sort: 'size', gid: result.groups.some((g) => g.id === gid) ? gid : (result.groups[0] ? result.groups[0].id : null), limit: CHUNK, anchor: null };
  const groupsEl = h('div', { class: 'rv-groups' });
  const itemsEl = h('div', { class: 'rv-items-wrap' });
  const selEl = h('div', { class: 'rv-sel' });
  const actionBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => onAction(new Set(sel)) }, actionLabel);
  // The dry run can take seconds on big selections: the button turns busy and ignores clicks, so a second click
  // cannot stack another simulation dialog.
  let simBusy = false;
  const simBtn = simulate ? h('button', { class: 'btn ghost', type: 'button', title: t('Mostra o que aconteceria, sem remover nada'), onClick: () => {
    if (simBusy) return;
    simBusy = true;
    simBtn.disabled = true;
    actionBtn.disabled = true; // a removal confirm opened now would end up under the simulation report
    simBtn.setAttribute('aria-busy', 'true');
    mount(simBtn, h('span', { class: 'spin', 'aria-hidden': 'true' }), t('Simulando…'));
    simulateRemoval([...sel], mod, () => { simBusy = false; simBtn.removeAttribute('aria-busy'); mount(simBtn, t('Simular')); renderFooter(); });
  } }, t('Simular')) : null;

  const sorter = () => (st.sort === 'size' ? (a, b) => b.size - a.size : (a, b) => cmp(a.name, b.name));
  const visible = (g) => {
    const q = st.q.trim().toLowerCase();
    const items = q ? g.items.filter((i) => i.name.toLowerCase().includes(q) || i.path.toLowerCase().includes(q)) : g.items;
    return [...items].sort(sorter());
  };
  // With a search active, the group checkbox reads and toggles only the rows the search shows (like ⌘A and
  // the Select menu): checking it never queues items the user cannot see.
  const groupItems = (g) => (st.q.trim() ? visible(g) : g.items);
  const groupState = (g) => {
    const items = groupItems(g);
    let n = 0;
    for (const i of items) if (sel.has(i.id)) n++;
    return n === 0 ? 'off' : n === items.length ? 'on' : 'mixed';
  };
  const groupsShown = () => {
    const gs = st.q.trim() ? result.groups.filter((g) => visible(g).length) : result.groups.slice();
    return gs.sort(st.sort === 'size' ? (a, b) => b.total - a.total : (a, b) => cmp(tr(a.title), tr(b.title)));
  };

  function renderFooter() {
    const { bytes, count } = selectedSize(result, sel);
    // Selections outside the open category also count for the action: the footer says how many categories they are in.
    const cats = result.groups.filter((g) => g.items.some((i) => sel.has(i.id))).length;
    if (!count) mount(selEl, t('Nenhum item selecionado'));
    else mount(selEl, t('Selecionado: '), h('b', null, fmtBytes(bytes)), h('small', null, cats > 1 ? tn(count, '{n} item em {cats}', '{n} itens em {cats}', { cats: tn(cats, '{n} categoria', '{n} categorias') }) : tn(count, '{n} item', '{n} itens')));
    actionBtn.disabled = count === 0 || simBusy;
    if (simBtn) simBtn.disabled = count === 0 || simBusy;
  }

  // The group column is rebuilt only when its content changes (search, sort, an item dropped); a selection-only refresh
  // updates the checkboxes in place, so the one just clicked animates (pop, check stroke) like the row ones do.
  let groupsSig = '';
  const groupNodes = new Map(); // group id -> { row, cb }
  function renderGroups() {
    const gs = groupsShown();
    if (!gs.some((g) => g.id === st.gid)) st.gid = gs[0] ? gs[0].id : null;
    const sig = gs.map((g) => `${g.id}:${g.items.length}:${g.total}`).join('|');
    if (sig === groupsSig && groupNodes.size === gs.length) {
      for (const g of gs) {
        const n = groupNodes.get(g.id);
        n.cb.set(groupState(g));
        n.row.setAttribute('aria-current', String(g.id === st.gid));
      }
      return;
    }
    groupsSig = sig;
    groupNodes.clear();
    mount(groupsEl, gs.map((g) => {
      const cb = checkbox(groupState(g), (s0) => { for (const i of groupItems(g)) s0 === 'on' ? sel.delete(i.id) : sel.add(i.id); refresh(); }, t('Selecionar grupo {name}', { name: tr(g.title) }));
      cb.dataset.fk = 'g:' + g.id;
      const row = h('div', { class: 'rv-group', 'aria-current': String(g.id === st.gid) },
        cb,
        h('button', { class: 'rv-group-main', type: 'button', dataset: { fk: 'gm:' + g.id }, onClick: () => { if (st.gid !== g.id) { st.gid = g.id; st.limit = CHUNK; keepFocus(() => { renderGroups(); renderItems(); }); } } },
          h('span', { class: 'rv-gic' }, icon(groupIcon(g.id), 15)),
          h('span', { class: 'rv-gtxt' }, h('b', { title: tr(g.title) }, tr(g.title)), h('span', null, `${fmtBytes(g.total)} · ${tn(g.items.length, '{n} item', '{n} itens')}`))));
      groupNodes.set(g.id, { row, cb });
      return row;
    }));
  }

  // Removes the item from the review (it already went to the ignored list in the backend): adjusts groups and totals in place.
  function dropLocal(it, fallback = []) {
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
    refresh(fallback);
  }

  async function ignoreItem(it) {
    try {
      await api.ignore(it.id);
    } catch (e) { return; } // the error was already shown
    // The row (and its focused "More actions" button) disappears: focus moves to the next row's, else the previous one's.
    const g = result.groups.find((x) => x.items.includes(it));
    const list = g ? visible(g) : [];
    const k = list.indexOf(it);
    dropLocal(it, [list[k + 1], list[k - 1]].filter(Boolean).map((x) => 'im:' + x.id));
    toast(t('“{name}” não aparecerá mais nas análises. Gerencie em Ajustes.', { name: it.name }), 'ok');
  }

  function rowMenu(g, it, list, row, at, opener) {
    const on = sel.has(it.id);
    row.classList.add('ctx-open');
    openMenu({
      at, opener, label: t('Ações de {name}', { name: it.name }), onClose: () => row.classList.remove('ctx-open'),
      items: [
        { label: on ? t('Desmarcar') : t('Selecionar'), icon: 'select', selects: on ? 'off' : 'on', onSelect: () => { on ? sel.delete(it.id) : sel.add(it.id); refresh(); } },
        { label: t('Mostrar no Finder'), icon: 'reveal', onSelect: () => api.reveal(it.id).catch(() => {}) },
        quickLook ? { label: t('Visualização Rápida'), icon: 'eye', onSelect: () => api.quickLook(it.id).catch(() => {}) } : null,
        ignore ? { sep: true } : null,
        ignore ? { label: t('Ignorar'), icon: 'ban', onSelect: () => ignoreItem(it) } : null,
      ].filter(Boolean),
    });
  }

  const rowCbs = new Map(); // item id -> checkbox of the rows currently shown
  function itemRow(g, it, list) {
    const cb = checkbox(sel.has(it.id) ? 'on' : 'off', (_s, e) => toggle(e), t('Selecionar {name}', { name: it.name }));
    // Shift+click applies the new state to the whole range since the last clicked item (as in Finder).
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
    cb.dataset.fk = 'i:' + it.id;
    rowCbs.set(it.id, cb);
    const more = h('button', {
      class: 'icon-btn rv-act', type: 'button', dataset: { fk: 'im:' + it.id }, title: t('Mais ações'), 'aria-label': t('Mais ações para {name}', { name: it.name }), 'aria-haspopup': 'menu',
      onClick: (e) => { e.stopPropagation(); rowMenu(g, it, list, row, below(more), more); },
    }, icon('more', 16));
    // Short notes become a badge next to the name; long ones (e.g. missing path) get their own line.
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
    h('button', { class: 'icon-btn rv-act', type: 'button', dataset: { fk: 'ir:' + it.id }, title: t('Mostrar no Finder'), 'aria-label': t('Mostrar {name} no Finder', { name: it.name }), onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 16)),
    more);
    return row;
  }

  // Selection of the open group (respects the search): All, None or the backend's default selection.
  const smartEq = (list) => list.every((i) => sel.has(i.id) === !!i.selected);
  function selectMode(list) {
    const n = list.filter((i) => sel.has(i.id)).length;
    if (list.length && n === list.length) return 'all';
    if (n === 0) return 'none';
    return smartEq(list) ? 'smart' : 'part';
  }
  const modeLabel = (m) => (m === 'all' ? t('Tudo') : m === 'none' ? t('Nada') : m === 'smart' ? t('Recomendado') : t('Parcial'));

  function openSelectMenu(list, btn) {
    const mode = selectMode(list);
    btn.setAttribute('aria-expanded', 'true');
    openMenu({
      at: below(btn), opener: btn, label: t('Selecionar'), onClose: () => btn.setAttribute('aria-expanded', 'false'),
      items: [
        { label: t('Seleção recomendada'), checked: mode === 'smart', onSelect: () => { for (const i of list) i.selected ? sel.add(i.id) : sel.delete(i.id); refresh(); } },
        { label: t('Tudo'), checked: mode === 'all', onSelect: () => { for (const i of list) sel.add(i.id); refresh(); } },
        { label: t('Nada'), checked: mode === 'none', onSelect: () => { for (const i of list) sel.delete(i.id); refresh(); } },
      ],
    });
  }

  let headEl = null;
  function renderHead(g, list) {
    if (!headEl) return;
    const mode = selectMode(list);
    const btn = h('button', { class: 'btn sm ghost sel-btn', type: 'button', dataset: { fk: 'sel' }, disabled: !list.length, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: () => openSelectMenu(list, btn) },
      t('Selecionar: '), h('b', null, modeLabel(mode)), icon('chevron', 14));
    mount(headEl, h('div', { class: 't' }, h('b', null, tr(g.title)), h('span', { title: tr(g.description) }, tr(g.description))), btn);
  }

  // Which list the items scroller shows: a selection-only refresh keeps its scroll position, a group/search/sort change resets it.
  // itemsSig also covers the rows shown: when only the selection changed, the rows stay and their checkboxes update in place.
  let itemsKey = '', itemsSig = '';
  function renderItems() {
    const g = result.groups.find((x) => x.id === st.gid);
    const key = g ? st.gid + '|' + st.q + '|' + st.sort : '';
    const oldBody = itemsEl.querySelector('.rv-items');
    const keepTop = oldBody && key && key === itemsKey ? oldBody.scrollTop : 0;
    itemsKey = key;
    if (!g) { itemsSig = ''; rowCbs.clear(); mount(itemsEl, h('div', { class: 'rv-empty' }, st.q ? t('Nenhum item corresponde à busca.') : (emptyText || t('Nada encontrado.')))); return; }
    const list = visible(g);
    const shown = list.slice(0, st.limit);
    const sig = key + '|' + st.limit + '|' + list.length + '|' + shown.map((i) => i.id).join(',');
    if (oldBody && headEl && sig === itemsSig) {
      const top = oldBody.scrollTop;
      for (const [id, cb] of rowCbs) cb.set(sel.has(id) ? 'on' : 'off');
      renderHead(g, list);
      oldBody.scrollTop = top; // the rows stay, but WebKit may re-snap a fractional scroll offset by a pixel on relayout
      return;
    }
    itemsSig = sig;
    rowCbs.clear();
    headEl = h('div', { class: 'rv-items-head' });
    const body = h('div', { class: 'rv-items' });
    body.append(...shown.map((it) => itemRow(g, it, list)));
    if (list.length > shown.length) {
      body.append(h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => {
        // The button is replaced by the new rows: focus goes to the first of them instead of falling to <body>.
        const first = list[shown.length];
        st.limit += CHUNK;
        renderItems();
        const n = first && itemsEl.querySelector(`[data-fk="${CSS.escape('i:' + first.id)}"]`);
        if (n) n.focus();
      } }, t('Mostrar mais ({count})', { count: tn(list.length - shown.length, '{n} item', '{n} itens') }))));
    }
    if (!list.length) body.append(h('div', { class: 'rv-empty' }, t('Nenhum item corresponde à busca.')));
    mount(itemsEl, headEl, body);
    if (keepTop) body.scrollTop = keepTop;
    renderHead(g, list);
  }

  // Re-renders replace the focused control (group checkbox, row menu opener, "Select"): its key (data-fk) is
  // recorded first and the matching new node refocused, so keyboard users keep their place.
  // fallback: keys tried in order when the focused control's own node is gone (its row was removed); without a
  // match, focus lands on the first row's menu button or the first group, never on <body>.
  function keepFocus(fn, fallback = null) {
    const a = document.activeElement;
    const key = a && el && el.contains(a) && a.dataset ? a.dataset.fk : null;
    fn();
    if (!key || el.contains(document.activeElement)) return;
    const find = (k) => { const n = el.querySelector(`[data-fk="${CSS.escape(k)}"]`); return n && !n.disabled ? n : null; };
    let n = find(key);
    if (!n && fallback) n = fallback.map(find).find(Boolean) || el.querySelector('[data-fk^="im:"], [data-fk^="gm:"]');
    if (n) n.focus();
  }

  function refresh(fallback = null) { keepFocus(() => { renderGroups(); renderItems(); renderFooter(); }, fallback); }

  const search = h('label', { class: 'search' }, icon('search', 16),
    h('input', { type: 'search', placeholder: t('Buscar'), 'aria-label': t('Buscar itens'), spellcheck: 'false', onInput: (e) => { st.q = e.target.value; st.limit = CHUNK; refresh(); } }));
  const sort = segmented([{ value: 'size', label: t('Tamanho') }, { value: 'name', label: t('Nome') }], st.sort, (v) => { st.sort = v; refresh(); }, t('Ordenar por'));

  const el = h('section', { class: 'review enter', dataset: { mod }, 'aria-label': title },
    managerBar({ title, subtitle, onBack, controls: [search, sort] }),
    extra ? h('div', { class: 'rv-extra' }, extra) : null,
    h('div', { class: 'rv-body' }, groupsEl, itemsEl),
    h('div', { class: 'rv-foot' }, selEl, simBtn, actionBtn));
  // ⌘A selects all visible items of the open group; ⌘⇧A deselects (outside text fields).
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
