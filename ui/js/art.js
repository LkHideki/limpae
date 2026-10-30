// Ícones SVG (traço) e ilustrações "orb" em CSS. Arte original, sem assets externos.
import { h, s } from './dom.js';
import { t } from './i18n.js';

const P = {
  smart: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'],
  clean: ['M14.5 9.5L20 4', 'M9 10.5l4.5 4.5-2 3.5c-1.6 1.2-4.4 1.4-7-.5 1.2-.7 1.7-2.2 1.8-3.5.2-1.7 1.6-3.2 2.7-4z'],
  trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.2 7l.9 12.2a1 1 0 0 0 1 .9h7.8a1 1 0 0 0 1-.9L17.8 7', 'M10 11v6', 'M14 11v6'],
  apps: ['M5 5h5.5v5.5H5z', 'M13.5 5H19v5.5h-5.5z', 'M5 13.5h5.5V19H5z', 'M16.2 13v6M13.5 16.2H19'],
  folder: ['M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z'],
  file: ['M7 3.5h6.5L18 8v12.5H7z', 'M13.5 3.5V8H18'],
  video: ['M4 6.5h11v11H4z', 'M15 10.5l5-3v9l-5-3'],
  archive: ['M4 4.5h16v4H4z', 'M5.5 8.5v11h13v-11', 'M10 12.5h4'],
  disk: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
  audio: ['M9 17.5V6.5l10-2v11', 'M9 17.5a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9 17.5z', 'M19 15.5a2.5 2.5 0 1 1-2.5-2.5 2.5 2.5 0 0 1 2.5 2.5z'],
  code: ['M8.5 8l-4 4 4 4', 'M15.5 8l4 4-4 4', 'M13 5.5l-2 13'],
  box: ['M4 8l8-4 8 4v8l-8 4-8-4z', 'M4 8l8 4 8-4', 'M12 12v8'],
  log: ['M5 6.5h14', 'M5 12h14', 'M5 17.5h9'],
  hammer: ['M13 6l5 5', 'M4.5 19.5l8.5-8.5', 'M12 5l3-2 5 5-2 3z'],
  search: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M20 20l-4.2-4.2'],
  check: ['M5.5 12.5l4.2 4.2L18.5 7.8'],
  dash: ['M6.5 12h11'],
  back: ['M14.5 5.5L8 12l6.5 6.5'],
  x: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
  reveal: ['M13.5 4.5H19.5v6', 'M19.5 4.5l-8 8', 'M17.5 14v4.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1H11'],
  lock: ['M6.5 11h11v8.5h-11z', 'M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11'],
  alert: ['M12 4.5l8.5 14.5h-17z', 'M12 10v4', 'M12 16.8v.1'],
  refresh: ['M19.5 11a7.5 7.5 0 1 0-2.2 5.3', 'M19.8 5v6h-6'],
  shield: ['M12 3.5l7 2.8v5c0 4.5-3 7.5-7 9.2-4-1.7-7-4.7-7-9.2v-5z', 'M9 12l2.2 2.2L15.5 10'],
  bolt: ['M13 3.5L5.5 13.5H12l-1 7 7.5-10H12z'],
  clock: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 8v4.2l2.8 1.8'],
  restart: ['M4.5 12a7.5 7.5 0 1 1 2.2 5.3', 'M4.2 18v-6h6'],
  gear: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6'],
  lens: ['M8 8a4 4 0 1 0 0 .01', 'M16.5 6.5a3 3 0 1 0 0 .01', 'M15 15.5a4.5 4.5 0 1 0 0 .01'],
  pulse: ['M3.5 12h4l2-5 4 10 2-5h5'],
  chip: ['M8 8h8v8H8z', 'M10.8 10.8h2.4v2.4h-2.4z', 'M10 4v2.5M14 4v2.5M10 17.5V20M14 17.5V20M4 10h2.5M4 14h2.5M17.5 10H20M17.5 14H20'],
  prefs: ['M5 8h8M17 8h2M15 6v4', 'M5 16h2M11 16h8M9 14v4', 'M5 12h3M12 12h7M10 10v4'],
  unlink: ['M10.5 13.5a3.5 3.5 0 0 1 0-5l1.8-1.8a3.5 3.5 0 0 1 5 5l-.9.9', 'M13.5 10.5a3.5 3.5 0 0 1 0 5l-1.8 1.8a3.5 3.5 0 0 1-5-5l.9-.9', 'M4.5 4.5l2 2M19.5 19.5l-2-2'],
  phone: ['M8 3.5h8A1.5 1.5 0 0 1 17.5 5v14a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5z', 'M11 17.5h2'],
  mail: ['M4 6.5h16v11H4z', 'M4.5 7.2l7.5 5.8 7.5-5.8'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  ban: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M6.3 6.3l11.4 11.4'],
  select: ['M5 5h14v14H5z', 'M8.5 12l2.5 2.5 4.5-5'],
  chevron: ['M7 10l5 5 5-5'],
  tools: ['M12 4l8 4-8 4-8-4z', 'M4 12l8 4 8-4', 'M4 16l8 4 8-4'],
  cloud: ['M7.5 18.5a4.5 4.5 0 0 1-.5-8.97 5.5 5.5 0 0 1 10.6-.8A4.5 4.5 0 0 1 17 18.5z'],
};

export function icon(name, size = 18, cls = '') {
  return s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `i-${name} ${cls}`.trim(), 'aria-hidden': 'true' },
    ...P[name].map((d) => s('path', { d })));
}

// Ícone por id de grupo (junk/large/lixeira); cai em "folder". Lixeiras de volumes externos têm id "trash:<volume>".
const GROUP_ICON = {
  user_caches: 'box', user_logs: 'log', xcode: 'hammer', dev_caches: 'code', ai_clutter: 'chip', broken_prefs: 'prefs',
  broken_login_items: 'unlink', ios_backups: 'phone', mail_attachments: 'mail', video: 'video', archive: 'archive',
  disk_image: 'disk', audio: 'audio', other: 'file', trash: 'trash', volume_trash: 'disk', apps: 'apps', leftovers: 'folder', icloud: 'cloud',
};
export const groupIcon = (id) => {
  const key = String(id).startsWith('trash:') ? 'volume_trash' : id;
  return P[GROUP_ICON[key]] ? GROUP_ICON[key] : 'folder';
};

// Orb: bolha glossy em camadas de gradiente radial + glifo; `mod` escolhe paleta/forma via CSS.
export function orb(mod, size = 200, glyph) {
  const g = icon(glyph || mod, 24, 'orb-glyph');
  g.removeAttribute('width'); g.removeAttribute('height');
  return h('div', { class: 'orb', dataset: { mod }, vars: { '--s': size + 'px' } },
    h('div', { class: 'orb-body' }), h('div', { class: 'orb-rim' }), h('div', { class: 'orb-gloss' }), g);
}

// `label` é uma função: MODS é constante de módulo e o idioma só é conhecido depois, então traduz na hora de exibir.
export const MODS = [
  { id: 'smart', label: () => t('Faxina'), glyph: 'smart' },
  { id: 'clean', label: () => t('Limpeza'), glyph: 'clean' },
  { id: 'trash', label: () => t('Lixeira'), glyph: 'trash' },
  { id: 'protect', label: () => t('Proteção'), glyph: 'shield' },
  { id: 'perf', label: () => t('Desempenho'), glyph: 'bolt' },
  { id: 'apps', label: () => t('Aplicativos'), glyph: 'apps' },
  { id: 'files', label: () => t('Meus Arquivos'), glyph: 'folder' },
  { id: 'lens', label: () => t('Disk Map'), glyph: 'lens' },
  { id: 'cloud', label: () => t('Nuvem'), glyph: 'cloud' },
  { id: 'tools', label: () => t('Minhas Ferramentas'), glyph: 'tools' },
  { spacer: true },
  { id: 'activity', label: () => t('Minha Atividade'), glyph: 'pulse' },
  { id: 'settings', label: () => t('Ajustes'), glyph: 'gear' },
];
