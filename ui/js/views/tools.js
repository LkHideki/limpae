// Minhas Ferramentas: grade pesquisável das ferramentas do app, com favoritos e o Modo de limpeza de tela.
import { h, s, mount } from '../dom.js';
import { icon } from '../art.js';
import { store } from '../store.js';

const FAV_KEY = 'limpae.tools.fav';

// Ícones que o conjunto principal não tem; os demais vêm de art.js.
const PATHS = {
  copy: ['M8.5 8.5h10v11h-10z', 'M5.5 15.5v-10h10'],
  image: ['M4.5 5.5h15v13h-15z', 'M4.5 16l4.6-4.6 3.6 3.6 2.4-2.4 4.4 4.4', 'M9 9.4h.01'],
  download: ['M12 4.5v10', 'M7.8 10.8l4.2 4.2 4.2-4.2', 'M5.5 19h13'],
  display: ['M4 5.5h16v10.5H4z', 'M9 19.5h6', 'M12 16v3.5'],
  star: ['M12 4.2l2.4 5 5.4.7-4 3.7 1 5.4-4.8-2.7-4.8 2.7 1-5.4-4-3.7 5.4-.7z'],
  keyboard: ['M3.5 7.5h17v9h-17z', 'M7 11h.01M10 11h.01M13 11h.01M16 11h.01', 'M8 14h8'],
};
function ti(name, size = 18, cls = '') {
  if (!PATHS[name]) return icon(name, size, cls);
  return s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `i-${name} ${cls}`.trim(), 'aria-hidden': 'true' },
    ...PATHS[name].map((d) => s('path', { d })));
}

// to = id do módulo (ctx.nav); `mod` dá a cor do tile. Sem seção interna: os módulos não leem dica de seção.
const TOOLS = [
  { id: 'junk', name: 'Lixo do sistema', desc: 'Caches, registros e restos que os apps recriam sozinhos.', ic: 'clean', mod: 'clean', to: 'clean' },
  { id: 'trash', name: 'Lixeira', desc: 'Veja o que há na Lixeira e esvazie de uma vez.', ic: 'trash', mod: 'trash', to: 'trash' },
  { id: 'ai', name: 'Lixo de IA', desc: 'Modelos e caches de ferramentas de IA que ocupam espaço.', ic: 'chip', mod: 'clean', to: 'clean' },
  { id: 'mail', name: 'Anexos do Mail', desc: 'Anexos baixados pelo Mail que já estão no servidor.', ic: 'mail', mod: 'clean', to: 'clean' },
  { id: 'large', name: 'Arquivos grandes e antigos', desc: 'Arquivos pesados que talvez você não use mais.', ic: 'folder', mod: 'files', to: 'files' },
  { id: 'dups', name: 'Duplicados', desc: 'Cópias idênticas de arquivos em pastas diferentes.', ic: 'copy', mod: 'files', to: 'files' },
  { id: 'similar', name: 'Imagens parecidas', desc: 'Fotos quase iguais, com a melhor cópia marcada.', ic: 'image', mod: 'files', to: 'files' },
  { id: 'downloads', name: 'Downloads', desc: 'Arquivos da pasta Downloads, agrupados pelo app que os baixou.', ic: 'download', mod: 'files', to: 'files' },
  { id: 'uninstall', name: 'Desinstalador', desc: 'Remova apps por completo, com todos os arquivos relacionados.', ic: 'apps', mod: 'apps', to: 'apps' },
  { id: 'updater', name: 'Atualizador', desc: 'Acompanhe as versões mais recentes dos seus apps.', ic: 'refresh', mod: 'apps', to: 'apps' },
  { id: 'leftovers', name: 'Restos de apps', desc: 'Encontre o que sobrou de apps que já foram removidos.', ic: 'unlink', mod: 'apps', to: 'apps' },
  { id: 'installers', name: 'Instaladores', desc: 'Arquivos .dmg e .pkg que já cumpriram o papel.', ic: 'box', mod: 'apps', to: 'apps' },
  { id: 'lens', name: 'Disk Map', desc: 'Um mapa visual do que ocupa espaço no disco.', ic: 'lens', mod: 'lens', to: 'lens' },
  { id: 'cloud', name: 'Nuvem (iCloud)', desc: 'Libere espaço tirando do Mac cópias que já estão no iCloud.', ic: 'cloud', mod: 'cloud', to: 'cloud' },
  { id: 'security', name: 'Verificação de segurança', desc: 'Gatekeeper, FileVault, firewall e outros ajustes de proteção.', ic: 'shield', mod: 'protect', to: 'protect' },
  { id: 'perms', name: 'Permissões de apps', desc: 'Veja e revogue o que cada app pode acessar no Mac.', ic: 'lock', mod: 'protect', to: 'protect' },
  { id: 'privacy', name: 'Privacidade', desc: 'Históricos e rastros de uso que ficam registrados.', ic: 'eye', mod: 'protect', to: 'protect' },
  { id: 'agents', name: 'Agentes em segundo plano', desc: 'Gerencie o que roda sozinho no seu Mac.', ic: 'chip', mod: 'perf', to: 'perf' },
  { id: 'login', name: 'Itens de login', desc: 'Apps que abrem sozinhos quando você entra no Mac.', ic: 'restart', mod: 'perf', to: 'perf' },
  { id: 'monitor', name: 'Monitor do sistema', desc: 'Memória, processador, bateria e tempo ligado.', ic: 'pulse', mod: 'perf', to: 'perf' },
  { id: 'snaps', name: 'Snapshots do Time Machine', desc: 'Cópias locais temporárias que o macOS guarda no disco.', ic: 'clock', mod: 'perf', to: 'perf' },
  { id: 'screen', name: 'Modo de limpeza de tela', desc: 'Bloqueia teclado e mouse para você limpar a tela e as teclas.', ic: 'display', mod: 'tools', action: 'screen' },
];

function loadFavs() {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => TOOLS.some((t) => t.id === x)) : [];
  } catch (e) { return []; }
}
function saveFavs(list) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) { /* armazenamento indisponível: vale só nesta sessão */ }
}
// ---------- Modo de limpeza de tela ----------
// Sobreposição preta em tela cheia que engole teclado e mouse; sai segurando Esc por 2 s. Atalhos do sistema
// (Cmd+Q, Cmd+Tab, Mission Control) são tratados pelo macOS antes da página e continuam funcionando.
const HOLD_MS = 2000;
const BLOCK = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'auxclick', 'contextmenu',
  'wheel', 'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'dragstart', 'selectstart', 'copy', 'cut', 'paste'];

// Pede tela cheia pela API da janela do Tauri (precisa da permissão core:window:allow-set-fullscreen) e, se ela
// falhar, pela API do navegador. Devolve a função que desfaz, ou null se nada mudou.
async function enterFullscreen() {
  try {
    const T = window.__TAURI__;
    const w = T && T.window && T.window.getCurrentWindow && T.window.getCurrentWindow();
    if (w) {
      if (await w.isFullscreen()) return null;
      await w.setFullscreen(true);
      return async () => { try { await w.setFullscreen(false); } catch (e) { /* ignora */ } };
    }
  } catch (e) { /* sem permissão ou sem API: tenta a do navegador */ }
  try {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      return async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (e) { /* ignora */ } };
    }
  } catch (e) { /* a sobreposição sozinha já cobre a janela */ }
  return null;
}

function screenCleaning() {
  if (document.getElementById('sclean')) return;
  const R = 34, C = 2 * Math.PI * R;
  const arc = s('circle', { class: 'arc', cx: 40, cy: 40, r: R, 'stroke-dasharray': C.toFixed(2), 'stroke-dashoffset': C.toFixed(2) });
  const ring = s('svg', { class: 'sc-ring', viewBox: '0 0 80 80', 'aria-hidden': 'true' }, s('circle', { class: 'track', cx: 40, cy: 40, r: R }), arc);
  const ov = h('div', { id: 'sclean', class: 'sclean', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Modo de limpeza de tela ativo', tabindex: '-1' },
    h('div', { class: 'sc-center' }, ring, h('p', { class: 'sc-hint' }, 'Segure Esc para sair')));
  const prev = document.activeElement;
  let t0 = 0, raf = 0, closed = false, restore = null;

  const cancelHold = () => { t0 = 0; cancelAnimationFrame(raf); ov.classList.remove('holding'); arc.setAttribute('stroke-dashoffset', C.toFixed(2)); };
  const frame = () => {
    const p = Math.min(1, (performance.now() - t0) / HOLD_MS);
    arc.setAttribute('stroke-dashoffset', (C * (1 - p)).toFixed(2));
    if (p >= 1) exit(); else raf = requestAnimationFrame(frame);
  };
  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code !== 'Escape' && e.key !== 'Escape') return;
    if (e.type === 'keydown' && !e.repeat && !t0) { t0 = performance.now(); ov.classList.add('holding'); raf = requestAnimationFrame(frame); }
    else if (e.type === 'keyup') cancelHold();
  };
  function exit() {
    if (closed) return;
    closed = true;
    cancelHold();
    BLOCK.forEach((n) => window.removeEventListener(n, swallow, true));
    window.removeEventListener('blur', cancelHold);
    ov.classList.add('out');
    setTimeout(() => ov.remove(), 220);
    if (restore) restore();
    if (prev && prev.focus && document.contains(prev)) prev.focus({ preventScroll: true });
  }
  BLOCK.forEach((n) => window.addEventListener(n, swallow, { capture: true, passive: false }));
  window.addEventListener('blur', cancelHold);
  document.body.append(ov);
  ov.focus({ preventScroll: true });
  enterFullscreen().then((r) => { if (closed) { if (r) r(); } else restore = r; }).catch(() => {});
}

const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function enter(ctx) {
  ctx.reserveDock(false);
  ctx.setDock(null);
  store.openSection = null;
  let favs = loadFavs();
  let q = '';
  const search = h('input', { type: 'search', placeholder: 'Buscar ferramentas…', 'aria-label': 'Buscar ferramentas', autocomplete: 'off', spellcheck: 'false' });
  const body = h('div', { class: 'tl-body' });
  const root = h('section', { class: 'tools enter', dataset: { mod: 'tools' } },
    h('header', { class: 'tl-head' },
      h('div', { class: 'tl-title' }, h('h1', { class: 'h2' }, 'Minhas Ferramentas'), h('p', { class: 'tl-sub' }, 'Ferramentas rápidas para tarefas pontuais: limpe, proteja e cuide do seu Mac em poucos cliques.')),
      h('label', { class: 'search' }, icon('search', 16), search)),
    body);
  mount(ctx.root, root);

  const open = (t) => {
    if (t.action === 'screen') return screenCleaning();
    store.openSection = t.id;
    ctx.nav(t.to);
  };
  const toggleFav = (id) => {
    favs = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
    saveFavs(favs);
    render();
  };

  function tile(t) {
    const fav = favs.includes(t.id);
    const star = h('button', { class: 'tl-star', type: 'button', 'aria-pressed': String(fav), 'aria-label': fav ? `Remover ${t.name} dos favoritos` : `Favoritar ${t.name}`, title: fav ? 'Remover dos favoritos' : 'Favoritar', onClick: () => toggleFav(t.id) },
      fav ? h('span', { class: 'tl-saved' }, 'Salvo') : null, ti('star', 16));
    return h('div', { class: 'tl-tile', dataset: { mod: t.mod, tool: t.id } },
      h('div', { class: 'tl-top' }, h('span', { class: 'tl-ic' }, ti(t.ic, 22)), star),
      h('h3', { class: 'tl-name' }, t.name),
      h('p', { class: 'tl-desc' }, t.desc),
      h('div', { class: 'tl-act' }, h('button', { class: 'btn sm tl-open', type: 'button', 'aria-label': `${t.action ? 'Iniciar' : 'Abrir'} ${t.name}`, onClick: () => open(t) }, t.action ? 'Iniciar' : 'Abrir')));
  }

  function render() {
    const f = norm(q.trim());
    const match = (t) => !f || norm(t.name).includes(f) || norm(t.desc).includes(f);
    const list = TOOLS.filter(match);
    const fav = list.filter((t) => favs.includes(t.id)).sort((a, b) => favs.indexOf(a.id) - favs.indexOf(b.id));
    const rest = list.filter((t) => !favs.includes(t.id));
    const grid = (items) => h('div', { class: 'tl-grid' }, items.map(tile));
    const kids = [];
    if (!list.length) kids.push(h('div', { class: 'tl-empty' }, `Nenhuma ferramenta encontrada para “${q.trim()}”.`));
    if (fav.length) kids.push(h('h2', { class: 'tl-sec' }, 'Favoritos'), grid(fav));
    if (rest.length) kids.push(fav.length ? h('h2', { class: 'tl-sec' }, 'Outras ferramentas') : null, grid(rest));
    mount(body, kids);
  }

  search.addEventListener('input', () => { q = search.value; render(); });
  render();
}
