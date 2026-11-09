// Context menu shared by the managers (Apps, Files, Security, Speed).
// Reuses the accessible menu from review.js; the UI only sends the id, the backend resolves the path.
import { h } from './dom.js';
import { icon } from './art.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { t } from './i18n.js';
import { openMenu } from './views/review.js';
import { quickLook as previewItem } from './quicklook.js';

const below = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; };
const isMenuKey = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

// Opens a row's menu.
// select: { on, toggle } adds "Select/Deselect"; openApp: adds "Open" (installed apps only);
// reveal/quickLook/ignore: false hides the action; onIgnored(): the row left the list in the backend, the screen adjusts.
export function entryMenu({ id, name, at, opener = null, label, select = null, openApp = false, reveal = true, quickLook = true, ignore = true, onIgnored, onClose }) {
  const items = [];
  if (select) items.push({ label: select.on ? t('Desmarcar') : t('Selecionar'), icon: 'select', selects: select.on ? 'off' : 'on', onSelect: select.toggle });
  if (openApp) items.push({ label: t('Abrir'), icon: 'apps', onSelect: () => api.openApp(id).catch(() => {}) });
  if (reveal) items.push({ label: t('Mostrar no Finder'), icon: 'reveal', onSelect: () => api.reveal(id).catch(() => {}) });
  if (quickLook) items.push({ label: t('Visualização Rápida'), icon: 'eye', onSelect: () => previewItem(id) });
  if (ignore) {
    items.push({ sep: true });
    items.push({
      label: t('Ignorar'), icon: 'ban',
      onSelect: async () => {
        try { await api.ignore(id); } catch (e) { return; } // the error was already shown
        if (onIgnored) onIgnored();
        toast(t('“{name}” não aparecerá mais nas análises. Gerencie em Ajustes.', { name }), 'ok');
      },
    });
  }
  return openMenu({ at, opener, label: label || t('Ações de {name}', { name }), items, onClose });
}

// "Select: <mode> ▾" button of the managers. modes = [[id, label], ...]; mode = current id ('part' = partial).
// The same label (Smart, All, None, Partial) applies in every module.
export function selectMenuButton({ modes, mode, onPick, label = t('Selecionar'), disabled = false }) {
  const text = (modes.find(([id]) => id === mode) || [null, t('Parcial')])[1];
  const btn = h('button', { class: 'btn sm ghost sel-btn', type: 'button', disabled, dataset: { fk: 'sel:' + label }, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, t('{label}: ', { label }), h('b', null, text), icon('chevron', 14));
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-expanded', 'true');
    openMenu({
      at: below(btn), opener: btn, label, onClose: () => btn.setAttribute('aria-expanded', 'false'),
      items: modes.map(([id, name]) => ({ label: name, checked: id === mode, onSelect: () => onPick(id) })),
    });
  });
  return btn;
}

// Binds the menu to the row: right click and the menu key (Shift+F10). `make()` returns the entryMenu options
// at click time (current selection state). `anchor` = "more actions" button (anchor of the keyboard menu).
export function attachMenu(row, make, anchor = null) {
  const show = (at, opener) => {
    row.classList.add('ctx-open');
    entryMenu({ ...make(), at, opener, onClose: () => row.classList.remove('ctx-open') });
  };
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); show({ x: e.clientX, y: e.clientY }, null); });
  row.addEventListener('keydown', (e) => {
    if (!isMenuKey(e)) return;
    e.preventDefault();
    const a = anchor || row;
    show(below(a), a);
  });
  return (e) => show(below(anchor || row), anchor || row);
}
