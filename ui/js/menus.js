// Menu de contexto compartilhado pelos gerenciadores (Aplicativos, Arquivos, Proteção, Desempenho).
// Reaproveita o menu acessível de review.js; a interface só manda o id, o backend resolve o caminho.
import { h } from './dom.js';
import { icon } from './art.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { t } from './i18n.js';
import { openMenu } from './views/review.js';

const below = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; };
const isMenuKey = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

// Abre o menu de uma linha.
// select: { on, toggle } acrescenta "Selecionar/Desmarcar"; openApp: acrescenta "Abrir" (só apps instalados);
// reveal/quickLook/ignore: false esconde a ação; onIgnored(): a linha saiu da lista no backend, a tela se ajusta.
export function entryMenu({ id, name, at, opener = null, label, select = null, openApp = false, reveal = true, quickLook = true, ignore = true, onIgnored, onClose }) {
  const items = [];
  if (select) items.push({ label: select.on ? t('Desmarcar') : t('Selecionar'), icon: 'select', onSelect: select.toggle });
  if (openApp) items.push({ label: t('Abrir'), icon: 'apps', onSelect: () => api.openApp(id).catch(() => {}) });
  if (reveal) items.push({ label: t('Mostrar no Finder'), icon: 'reveal', onSelect: () => api.reveal(id).catch(() => {}) });
  if (quickLook) items.push({ label: t('Visualização Rápida'), icon: 'eye', onSelect: () => api.quickLook(id).catch(() => {}) });
  if (ignore) {
    items.push({ sep: true });
    items.push({
      label: t('Ignorar'), icon: 'ban',
      onSelect: async () => {
        try { await api.ignore(id); } catch (e) { return; } // o erro já foi mostrado
        if (onIgnored) onIgnored();
        toast(t('“{name}” não aparecerá mais nas análises. Gerencie em Ajustes.', { name }), 'ok');
      },
    });
  }
  return openMenu({ at, opener, label: label || t('Ações de {name}', { name }), items, onClose });
}

// Botão "Selecionar: <modo> ▾" dos gerenciadores. modes = [[id, rótulo], ...]; mode = id atual ('part' = parcial).
// O mesmo rótulo (Inteligente, Tudo, Nada, Parcial) vale em todos os módulos.
export function selectMenuButton({ modes, mode, onPick, label = t('Selecionar'), disabled = false }) {
  const text = (modes.find(([id]) => id === mode) || [null, t('Parcial')])[1];
  const btn = h('button', { class: 'btn sm ghost sel-btn', type: 'button', disabled, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, t('{label}: ', { label }), h('b', null, text), icon('chevron', 14));
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-expanded', 'true');
    openMenu({
      at: below(btn), opener: btn, label, onClose: () => btn.setAttribute('aria-expanded', 'false'),
      items: modes.map(([id, name]) => ({ label: name, checked: id === mode, onSelect: () => onPick(id) })),
    });
  });
  return btn;
}

// Liga o menu à linha: botão direito e a tecla de menu (Shift+F10). `make()` devolve as opções de entryMenu
// no momento do clique (estado atual da seleção). `anchor` = botão "mais ações" (âncora do menu por teclado).
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
