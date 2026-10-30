// Disk Map: mapa de bolhas navegável. Só ids de nós trafegam; o backend resolve caminhos e valida cada remoção.
import { play } from '../sound.js';
import { h, mount, sleep } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store, bump } from '../store.js';
import { bytesParts, fmtBytes, fmtNum, plural, pct } from '../format.js';
import { confirmDialog, failuresSheet, stage, checkbox } from '../ui.js';
import { removeGroups, stopDock } from '../actions.js';
import { fitBubbles } from '../pack.js';
import { createReview, openMenu } from './review.js';

// Quantas bolhas o mapa mostra no máximo; o resto vira "Outros itens". Em áreas pequenas o mapa mostra menos.
const TOP_MAX = 13, TOP_MIN = 6, TOP_TRY = [13, 12, 11, 10, 9, 8, 7, 6];
const GAP = 10, PAD = 8, R_MIN = 46, R_MAX = 120, F_GOOD = 0.66;
const LIST_CHUNK = 250;

// Estado da sessão: sobrevive à troca de módulo (o mapa fica no backend até o próximo scan).
const S = { phase: 'idle', roots: null, rootIdx: 0, root: null, vol: null, cache: new Map(), sel: new Set(), hist: [], pos: -1, cur: null, expanded: false, listLimit: LIST_CHUNK, review: null, moved: 0, hasMap: false, icons: new Map() };

const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ============================================================================================================
// Ícones estilo Finder (arte própria, SVG inline). Os gradientes ficam em um <svg> único no <body>.
// ============================================================================================================
const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<linearGradient id="lf-back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4ea6f2"/><stop offset="1" stop-color="#1f62c0"/></linearGradient>
<linearGradient id="lf-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9be3ff"/><stop offset=".5" stop-color="#58b8fa"/><stop offset="1" stop-color="#2d8ae6"/></linearGradient>
<linearGradient id="lf-page" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d3dcec"/></linearGradient>
<linearGradient id="lf-fold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e4eaf6"/><stop offset="1" stop-color="#a9b8d4"/></linearGradient>
<linearGradient id="lf-app" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b2a6ff"/><stop offset="1" stop-color="#5568ec"/></linearGradient>
<linearGradient id="lf-box" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d2c1ff"/><stop offset="1" stop-color="#7455ee"/></linearGradient>
<linearGradient id="lf-disk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f7fb"/><stop offset="1" stop-color="#a7b4c8"/></linearGradient>
<linearGradient id="lf-vid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#46587f"/><stop offset="1" stop-color="#1a2542"/></linearGradient>
<linearGradient id="lf-img" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8adcff"/><stop offset="1" stop-color="#4f8cff"/></linearGradient>
<linearGradient id="lf-zip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffdc94"/><stop offset="1" stop-color="#f0a53c"/></linearGradient>
<linearGradient id="lf-aud" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9ec1"/><stop offset="1" stop-color="#e64980"/></linearGradient>
</defs></svg>`;

const PAGE = '<path d="M16 5h24l14 14v34a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V11a6 6 0 0 1 6-6z" fill="url(#lf-page)"/><path d="M40 5v10a4 4 0 0 0 4 4h10z" fill="url(#lf-fold)"/><path d="M16.4 5.6h23.2" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity=".9"/>';
const FOLDER = '<path fill="url(#lf-back)" d="M5 17a6 6 0 0 1 6-6h12.2a6 6 0 0 1 4.7 2.3l2.4 3.1H53a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6z"/><rect x="9" y="19" width="46" height="9" rx="2.5" fill="#f1f6ff" opacity=".95"/><path fill="url(#lf-front)" d="M5 29a6 6 0 0 1 6-6h42a6 6 0 0 1 6 6v19a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6z"/><path d="M11.5 23.9h41" stroke="#fff" stroke-opacity=".6" stroke-width="1.4" stroke-linecap="round" fill="none"/>';
const ART = {
  folder: FOLDER,
  home: FOLDER + '<path d="M32 30.5l9.5 8h-2.3V47H34.8v-5.3h-5.6V47h-4.4v-8.5h-2.3z" fill="#fff" opacity=".92"/>',
  drive: '<rect x="5" y="17" width="54" height="31" rx="8" fill="url(#lf-disk)"/><rect x="5" y="39" width="54" height="9" rx="4.5" fill="#7e8ca2" opacity=".35"/><path d="M9 20.4h46" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".9"/><circle cx="50" cy="43.5" r="2.2" fill="#4ade80"/><path d="M12 43.5h18" stroke="#5b6a82" stroke-width="2.4" stroke-linecap="round"/>',
  doc: PAGE + '<path d="M18 28h28M18 34h28M18 40h20" stroke="#9aa9c4" stroke-width="2.6" stroke-linecap="round"/>',
  image: PAGE + '<rect x="17" y="27" width="30" height="22" rx="3" fill="url(#lf-img)"/><circle cx="25" cy="33.5" r="3" fill="#fff" opacity=".9"/><path d="M17 45l8.5-8 6 5.5 5-4.5 10.5 9.5V46a3 3 0 0 1-3 3H20a3 3 0 0 1-3-3z" fill="#2563c9" opacity=".85"/>',
  video: PAGE + '<rect x="16" y="27" width="32" height="22" rx="4" fill="url(#lf-vid)"/><path d="M29 33l9 5-9 5z" fill="#fff"/>',
  audio: PAGE + '<circle cx="32" cy="38" r="12" fill="url(#lf-aud)"/><path d="M35.5 31v9.2a3 3 0 1 1-1.8-2.7V33l-6 1.3" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  archive: PAGE + '<rect x="27" y="5" width="10" height="54" fill="url(#lf-zip)" opacity=".95"/><path d="M27 12h10M27 18h10M27 24h10M27 30h10" stroke="#a96a12" stroke-width="1.6" opacity=".55"/><rect x="29" y="38" width="6" height="9" rx="2" fill="#fff" opacity=".9"/>',
  app: '<rect x="7" y="7" width="50" height="50" rx="13" fill="url(#lf-app)"/><path d="M7 20a13 13 0 0 1 13-13h24a13 13 0 0 1 13 13" fill="#fff" opacity=".14"/><path d="M21.5 44.5l10.5-23 10.5 23M25.6 37h12.8" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  pkg: '<path d="M8 22l24-12 24 12v21L32 55 8 43z" fill="url(#lf-box)"/><path d="M8 22l24 12 24-12" stroke="#fff" stroke-opacity=".55" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M32 34v21" stroke="#fff" stroke-opacity=".35" stroke-width="1.8"/><path d="M20 16l24 12" stroke="#fff" stroke-opacity=".35" stroke-width="3"/>',
  small: '<g transform="translate(-5 4) scale(.82)">' + PAGE + '</g><g transform="translate(14 -1) scale(.82)">' + PAGE + '<path d="M18 28h28M18 34h28M18 40h20" stroke="#9aa9c4" stroke-width="2.6" stroke-linecap="round"/></g>',
  other: '<circle cx="32" cy="32" r="21" fill="#fff" fill-opacity=".08" stroke="#fff" stroke-opacity=".7" stroke-width="2.6" stroke-dasharray="4.5 5"/><circle cx="22.5" cy="32" r="3" fill="#fff"/><circle cx="32" cy="32" r="3" fill="#fff"/><circle cx="41.5" cy="32" r="3" fill="#fff"/>',
};
const EXT = {
  image: 'png jpg jpeg gif heic heif webp tif tiff bmp svg raw cr2 nef dng psd ai', video: 'mov mp4 m4v avi mkv webm mpg mpeg wmv', audio: 'mp3 wav aac flac m4a aiff aif ogg',
  archive: 'zip tar gz tgz bz2 xz 7z rar dmg iso pkg zst',
};
const EXT_KIND = {};
for (const [k, list] of Object.entries(EXT)) for (const e of list.split(' ')) EXT_KIND[e] = k;

function iconKind(n, root) {
  if (root) return root;
  if (n.kind === 'small') return 'small';
  if (n.kind === 'package') return /\.app$/i.test(n.name) ? 'app' : 'pkg';
  if (n.kind === 'dir') return 'folder';
  const m = /\.([^.]+)$/.exec(n.name);
  return (m && EXT_KIND[m[1].toLowerCase()]) || 'doc';
}

function ensureDefs() {
  if (document.getElementById('lens-defs')) return;
  const t = document.createElement('template');
  t.innerHTML = DEFS;
  const el = t.content.firstElementChild;
  el.id = 'lens-defs';
  document.body.append(el);
}

function svgIcon(kind) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">${ART[kind] || ART.doc}</svg>`;
  return t.content.firstElementChild;
}

// Cache dos ícones reais de .app (path -> data URL | null) e das requisições em andamento.
const pendingIcons = new Map();
function wantAppIcon(n, slot) {
  const put = (u) => { if (u && slot.isConnected) { const img = h('img', { class: 'fi-img', src: u, alt: '', draggable: 'false' }); slot.replaceChildren(img); } };
  const hit = S.icons.get(n.path);
  if (hit !== undefined) { put(hit); return; }
  if (!pendingIcons.has(n.path)) {
    pendingIcons.set(n.path, api.lensIcon(n.id).catch(() => null).then((u) => { S.icons.set(n.path, u || null); pendingIcons.delete(n.path); return u || null; }));
  }
  pendingIcons.get(n.path).then(put);
}

// Ícone de um nó, em `px` pixels. Pacotes .app trocam o desenho genérico pelo ícone real quando ele chega.
function nodeIcon(n, px, root) {
  const kind = iconKind(n, root);
  const slot = h('span', { class: 'fi', style: `width:${px}px;height:${px}px` }, svgIcon(kind));
  if (kind === 'app') queueMicrotask(() => wantAppIcon(n, slot));
  return slot;
}
const plainIcon = (kind, px) => h('span', { class: 'fi', style: `width:${px}px;height:${px}px` }, svgIcon(kind));

// Nome com reticências no meio, preservando a extensão: "CMPurgeableSpaceEntityPa…ntifier".
function midCut(name, cap) {
  if (name.length <= cap) return name;
  if (cap < 4) return name.slice(0, Math.max(1, cap - 1)) + '…';
  const m = /\.[A-Za-z0-9]{1,6}$/.exec(name);
  const ext = m && m.index > 2 ? m[0] : '';
  const tailLen = Math.max(ext.length + 2, Math.round((cap - 1) * 0.34));
  const tail = name.slice(-Math.min(tailLen, cap - 3));
  return name.slice(0, cap - 1 - tail.length) + '…' + tail;
}

// ============================================================================================================
export function enter(ctx) {
  let st = null, cancelled = false, navToken = 0;
  let rows = new Map(), bubs = new Map(), cbs = new Map(), restIds = new Set();
  let selLabel = null, reviewBtn = null, menuBtn = null;
  let shell = null, layoutInfo = null;
  if (!['map', 'review', 'done'].includes(S.phase) || (S.phase === 'map' && !S.cur) || (S.phase === 'review' && !S.review)) S.phase = 'idle';

  const node = (id) => S.cache.get(id);

  function render() {
    if (S.phase === 'map' && S.cur) return renderMap('first');
    dropShell();
    if (S.phase === 'review' && S.review) return renderReview();
    ctx.reserveDock(true);
    if (!st) { st = stage('lens', 'lens', 260); mount(ctx.root, st.el); }
    st.busy(false);
    if (S.phase === 'done') return renderDone();
    S.phase = 'idle';
    return renderIdle();
  }

  function dropShell() {
    if (shell && shell.ro) shell.ro.disconnect();
    shell = null; layoutInfo = null;
  }

  // ---------- seleção ----------
  function ancestorsSelected(id) {
    for (let p = node(id)?.parent; p != null; p = node(p)?.parent) if (S.sel.has(p)) return true;
    return false;
  }
  const topSelected = () => [...S.sel].filter((id) => !ancestorsSelected(id));
  function selTotal() {
    let bytes = 0, count = 0;
    for (const id of topSelected()) { bytes += node(id)?.size || 0; count++; }
    return { bytes, count };
  }
  function toggle(id) {
    const n = node(id);
    if (!n || !n.selectable || ancestorsSelected(id)) return;
    if (S.sel.has(id)) S.sel.delete(id);
    else {
      S.sel.add(id);
      // Marcar a pasta inclui tudo dentro dela.
      for (const o of [...S.sel]) if (o !== id && ancestorsSelected(o)) S.sel.delete(o);
    }
    refreshSel();
  }
  function partialIds() {
    const set = new Set();
    for (const id of S.sel) for (let p = node(id)?.parent; p != null; p = node(p)?.parent) set.add(p);
    return set;
  }
  const stateOf = (id, partial) => (S.sel.has(id) || ancestorsSelected(id) ? 'on' : partial.has(id) ? 'mixed' : 'off');

  function refreshSel() {
    if (!S.cur) return;
    const partial = partialIds();
    for (const [id, el] of bubs) {
      if (id === 'other') continue;
      const stt = stateOf(id, partial);
      el.classList.toggle('sel', stt === 'on');
      el.classList.toggle('part', stt === 'mixed');
      el.setAttribute('aria-pressed', String(stt === 'on'));
    }
    for (const [id, cb] of cbs) {
      cb.set(stateOf(id, partial));
      cb.disabled = ancestorsSelected(id) || !node(id).selectable;
    }
    for (const [id, el] of rows) if (id !== 'other') el.classList.toggle('sel', stateOf(id, partial) === 'on');
    const kids = S.cur.children.filter((c) => c.selectable);
    const nSel = kids.filter((c) => stateOf(c.id, partial) === 'on').length;
    if (menuBtn) menuBtn.firstChild.textContent = nSel === 0 ? 'Nenhum' : nSel === kids.length ? 'Tudo' : `${nSel} de ${kids.length}`;
    const { bytes, count } = selTotal();
    if (selLabel) mount(selLabel, h('b', null, count ? plural(count, 'item selecionado', 'itens selecionados') : 'Nenhum item selecionado'), h('i', { class: 'sep' }), h('span', null, fmtBytes(bytes)));
    if (reviewBtn) reviewBtn.disabled = count === 0;
  }

  // ---------- landing ----------
  function rootTitle(r) { return r.isVolume ? r.name : 'Pasta pessoal'; }

  function renderIdle() {
    const pick = h('div', { class: 'lens-roots', role: 'radiogroup', 'aria-label': 'Local para analisar' });
    const drawRoots = () => {
      if (!S.roots) { mount(pick, h('div', { class: 'lens-roots-load' }, h('span', { class: 'spin' }), 'Lendo os locais…')); return; }
      mount(pick, S.roots.map((r) => {
        const usedPct = pct(r.used, r.total);
        return h('button', { class: 'lens-root', type: 'button', role: 'radio', 'aria-checked': String(r.index === S.rootIdx), onClick: () => { S.rootIdx = r.index; drawRoots(); } },
          h('span', { class: 'lr-ic' }, icon(r.isVolume ? 'disk' : 'folder', 18)),
          h('span', { class: 'lr-main' }, h('b', null, rootTitle(r)), h('small', null, r.total ? `${fmtBytes(r.used)} de ${fmtBytes(r.total)} usados` : r.path)),
          h('span', { class: 'lr-bar' }, h('i', { style: `width:${usedPct}%` })));
      }));
    };
    drawRoots();
    st.show(h('h1', { class: 'h1' }, 'Disk Map'),
      h('p', { class: 'sub' }, 'Veja o que ocupa espaço no Mac em um mapa de bolhas e escolha o que mover para o Lixo.'),
      h('p', { class: 'lens-lead' }, 'Analisar'), pick,
      S.cur && S.phase === 'idle' && S.hasMap ? h('div', { class: 'row-actions', style: 'margin-top:18px' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.phase = 'map'; render(); } }, 'Voltar ao mapa')) : null);
    ctx.setDock({ label: 'Analisar', mod: 'lens', disabled: !S.roots, onClick: scan });
    if (!S.roots) {
      api.lensRoots().then((r) => { S.roots = r; if (S.rootIdx >= r.length) S.rootIdx = 0; if (ctx.alive && S.phase === 'idle') { drawRoots(); ctx.setDock({ label: 'Analisar', mod: 'lens', onClick: scan }); } })
        .catch(() => { if (ctx.alive) mount(pick, h('div', { class: 'lens-roots-load' }, 'Não foi possível ler os locais.', h('button', { class: 'link', type: 'button', onClick: () => { S.roots = null; render(); } }, 'Tentar de novo'))); });
    }
  }

  // ---------- varredura ----------
  async function scan() {
    cancelled = false;
    S.phase = 'scanning';
    S.hasMap = false;
    play('start');
    ctx.setBusy(true);
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    const count = h('p', { class: 'sub lens-count' });
    st.show(h('h1', { class: 'h1' }, 'Visualizando seu espaço…'), count, ticker);
    ctx.onProgress((p) => { if (p.task === 'lens') { ticker.textContent = p.path || ''; count.textContent = p.bytes ? `${fmtBytes(p.bytes)} medidos` : ''; } });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'lens', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'lens' }); api.cancel().catch(() => {}); } });
    let ok = false;
    try {
      const r = await api.lensScan(S.rootIdx);
      if (!cancelled) {
        const root = S.roots[S.rootIdx];
        S.root = r.root; S.vol = { total: r.volumeTotal, used: r.volumeUsed, name: rootTitle(root), isVolume: !!root.isVolume };
        S.cache = new Map([[r.root.id, r.root]]); S.sel = new Set(); S.hist = []; S.pos = -1; S.cur = null; S.icons = new Map();
        ok = true;
      }
    } catch (e) { /* toast já exibido */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (ok) {
      const loaded = await load(S.root.id, true);
      if (!ctx.alive) return;
      S.phase = loaded ? 'map' : 'idle';
      S.hasMap = loaded;
      if (loaded) play('found');
    } else S.phase = 'idle';
    render();
  }

  // ---------- navegação ----------
  // Carrega os filhos de `id` e os torna a pasta atual (sem desenhar). Maiores primeiro.
  async function load(id, push) {
    const token = ++navToken;
    let r;
    try { r = await api.lensChildren(id); } catch (e) { return false; }
    if (token !== navToken || !ctx.alive) return false;
    commit(r, id, push);
    return true;
  }
  function commit(r, id, push) {
    r.children.sort((a, b) => b.size - a.size);
    S.cache.set(r.node.id, r.node);
    for (const c of r.children) S.cache.set(c.id, c);
    if (push) { S.hist = S.hist.slice(0, S.pos + 1); S.hist.push(id); S.pos = S.hist.length - 1; }
    S.cur = r; S.expanded = false; S.listLimit = LIST_CHUNK;
  }

  // Navegação da interface, com transição: dir 'in' = entrar (a câmera mergulha na bolha), 'out' = subir/voltar.
  async function go(id, { push = true, dir = 'in', from = null } = {}) {
    if (!shell) return false;
    const token = ++navToken;
    const anim = leave(dir, from || bubs.get(id));
    let r;
    try { r = await api.lensChildren(id); } catch (e) { shell.layer.classList.remove('leave-in', 'leave-out'); return false; }
    await anim;
    if (token !== navToken || !ctx.alive || !shell) return false;
    commit(r, id, push);
    renderMap(dir);
    return true;
  }
  function leave(dir, fromEl) {
    const layer = shell.layer;
    if (reducedMotion()) return Promise.resolve();
    layer.style.transformOrigin = dir === 'in' && fromEl ? `${fromEl.offsetLeft + fromEl.offsetWidth / 2}px ${fromEl.offsetTop + fromEl.offsetHeight / 2}px` : '50% 50%';
    layer.classList.remove('leave-in', 'leave-out');
    void layer.offsetWidth;
    layer.classList.add(dir === 'in' ? 'leave-in' : 'leave-out');
    return sleep(dir === 'in' ? 300 : 220);
  }
  const canBack = () => S.pos > 0;
  const canFwd = () => S.pos < S.hist.length - 1;
  const goBack = () => { if (canBack()) { S.pos--; go(S.hist[S.pos], { push: false, dir: 'out' }); } };
  const goFwd = () => { if (canFwd()) { S.pos++; go(S.hist[S.pos], { push: false, dir: 'in' }); } };
  const goUp = () => { if (S.cur && S.cur.node.parent != null) go(S.cur.node.parent, { dir: 'out' }); };
  const drill = (n, from) => { if (n && n.drillable) go(n.id, { dir: 'in', from }); };

  // ---------- interações em comum (bolha e linha) ----------
  function hover(id, on) {
    const r = rows.get(id), b = bubs.get(id) || (restIds.has(id) ? bubs.get('other') : null);
    if (r) r.classList.toggle('hot', on);
    if (b) b.classList.toggle('hot', on);
  }

  const below = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; };
  const isMenuKey = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

  function nodeMenu(n, at, opener, mark) {
    const on = S.sel.has(n.id) || ancestorsSelected(n.id);
    const locked = !n.selectable || ancestorsSelected(n.id);
    if (mark) mark.classList.add('ctx-open');
    const from = bubs.get(n.id);
    openMenu({
      at, opener, label: `Ações de ${n.name}`, onClose: () => mark && mark.classList.remove('ctx-open'),
      items: [
        { label: S.sel.has(n.id) ? 'Desmarcar' : 'Selecionar', icon: 'select', disabled: locked && !on, onSelect: () => toggle(n.id) },
        ...(n.drillable ? [{ label: 'Abrir pasta', icon: 'folder', onSelect: () => drill(n, from) }] : []),
        { sep: true },
        { label: 'Mostrar no Finder', icon: 'reveal', onSelect: () => api.lensReveal(n.id).catch(() => {}) },
        { label: 'Visualização Rápida', icon: 'eye', disabled: n.kind === 'small', onSelect: () => api.lensQuicklook(n.id).catch(() => {}) },
      ],
    });
  }

  // Um clique marca; o segundo clique de um duplo clique desfaz a marcação e a pasta abre (como no Finder).
  function clickable(el, n, mark) {
    let pre = null;
    el.addEventListener('click', (e) => {
      if (e.detail > 1) return;
      pre = new Set(S.sel);
      toggle(n.id);
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (pre) { S.sel = pre; pre = null; refreshSel(); }
      drill(n, bubs.get(n.id));
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); nodeMenu(n, { x: e.clientX, y: e.clientY }, null, mark || el); });
    el.addEventListener('mouseenter', () => hover(n.id, true));
    el.addEventListener('mouseleave', () => hover(n.id, false));
    el.addEventListener('focus', () => hover(n.id, true));
    el.addEventListener('blur', () => hover(n.id, false));
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Enter') { e.preventDefault(); n.drillable ? drill(n, bubs.get(n.id)) : toggle(n.id); }
      else if (e.key === ' ') { e.preventDefault(); toggle(n.id); }
      else if (isMenuKey(e)) { e.preventDefault(); nodeMenu(n, below(el), el, mark || el); }
    });
  }

  // ---------- painel esquerdo ----------
  function drawHead() {
    const { node: cur } = S.cur, atRoot = cur.id === S.root.id;
    mount(shell.headIc, atRoot ? plainIcon(S.vol.isVolume ? 'drive' : 'home', 46) : nodeIcon(cur, 46));
    mount(shell.headT, h('b', { title: cur.path }, atRoot ? S.vol.name : cur.name),
      h('span', null, fmtBytes(cur.size), h('i', { class: 'sep' }), plural(cur.items, 'item', 'itens')));
  }

  function row(n, i) {
    const partial = partialIds();
    const cb = checkbox(stateOf(n.id, partial), () => toggle(n.id), `Selecionar ${n.name}`);
    if (!n.selectable) { cb.disabled = true; cb.title = n.kind === 'small' ? 'Arquivos pequenos não são listados um a um' : 'Item protegido: não pode ser removido'; }
    cbs.set(n.id, cb);
    const more = h('button', { class: 'icon-btn ln-act', type: 'button', title: 'Mais ações', 'aria-label': `Mais ações para ${n.name}`, 'aria-haspopup': 'menu',
      onClick: (e) => { e.stopPropagation(); nodeMenu(n, below(more), more, el); } }, icon('more', 16));
    const open = n.drillable ? h('button', { class: 'icon-btn ln-act ln-open', type: 'button', 'aria-label': `Abrir ${n.name}`, title: 'Abrir pasta',
      onClick: (e) => { e.stopPropagation(); drill(n, bubs.get(n.id)); } }, icon('back', 15)) : null;
    const el = h('div', { class: 'ln-row' + (n.drillable ? ' dir' : '') + (n.selectable ? '' : ' locked'), tabindex: '0', dataset: { id: String(n.id) }, vars: { '--i': String(Math.min(i, 24)) } },
      cb, h('span', { class: 'ln-ic' }, nodeIcon(n, 30)),
      h('span', { class: 'ln-name', title: n.path }, n.name),
      open, more,
      h('span', { class: 'ln-size' }, fmtBytes(n.size)));
    clickable(el, n);
    rows.set(n.id, el);
    return el;
  }

  function otherRow(rest, total) {
    const el = h('button', { class: 'ln-row other', type: 'button', onMouseenter: () => hover('other', true), onMouseleave: () => hover('other', false),
      onClick: () => { S.expanded = !S.expanded; drawList(); } },
      h('span', { class: 'ln-ic' }, plainIcon('other', 30)),
      h('span', { class: 'ln-name' }, 'Outros itens', h('small', null, plural(rest, 'item', 'itens'))),
      h('span', { class: 'ln-size' }, fmtBytes(total)),
      h('span', { class: 'ln-chev' + (S.expanded ? ' open' : ''), 'aria-hidden': 'true' }, icon('chevron', 14)));
    rows.set('other', el);
    el.setAttribute('aria-expanded', String(S.expanded));
    return el;
  }

  function drawList() {
    rows = new Map(); cbs = new Map();
    const kids = S.cur.children, k = layoutInfo ? layoutInfo.k : Math.min(TOP_MAX, kids.length);
    const head = kids.slice(0, k), rest = kids.slice(k);
    restIds = new Set(rest.map((c) => c.id));
    const out = head.map(row);
    if (rest.length) {
      out.push(otherRow(rest.length, rest.reduce((a, c) => a + c.size, 0)));
      if (S.expanded) {
        out.push(...rest.slice(0, S.listLimit).map((n, i) => row(n, i)));
        if (rest.length > S.listLimit) out.push(h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.listLimit += LIST_CHUNK; drawList(); } }, `Mostrar mais (${plural(rest.length - S.listLimit, 'item', 'itens')})`)));
      }
    }
    if (!kids.length) out.push(h('div', { class: 'rv-empty' }, 'Esta pasta está vazia.'));
    mount(shell.listEl, out);
    refreshSel();
  }

  // ---------- caminho (estilo Finder) ----------
  function crumbsEl() {
    const cr = S.cur.crumbs;
    const show = cr.length > 3 ? [cr[0], null, ...cr.slice(-2)] : cr;
    const out = [];
    show.forEach((c, i) => {
      if (i) out.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, icon('back', 11)));
      if (!c) { out.push(h('span', { class: 'crumb dots', title: cr.slice(1, -2).map((x) => x.name).join(' › ') }, '…')); return; }
      const last = c.id === S.cur.node.id, isRoot = c.id === S.root.id;
      const label = isRoot ? S.vol.name : c.name;
      out.push(h('button', { class: 'crumb' + (last ? ' cur' : ''), type: 'button', title: label, 'aria-current': last ? 'page' : null, disabled: last, onClick: () => go(c.id, { dir: 'out' }) },
        plainIcon(isRoot ? (S.vol.isVolume ? 'drive' : 'home') : 'folder', 17), h('span', null, label)));
    });
    return out;
  }

  // ---------- mapa ----------
  // Escolhe quantas bolhas cabem com tamanho confortável, e posiciona. Devolve null se o mapa ainda não tem tamanho.
  function computeLayout() {
    const w = shell.mapEl.clientWidth, hgt = shell.mapEl.clientHeight;
    if (w < 80 || hgt < 80) return null;
    const kids = S.cur.children;
    if (!kids.length) return { w, h: hgt, k: 0, items: [] };
    const cands = [...new Set(TOP_TRY.map((k) => Math.min(k, kids.length)))];
    let best = null;
    for (const k of cands) {
      const items = kids.slice(0, k).map((n) => ({ n, id: n.id, size: n.size, bytes: n.size, other: false }));
      const rest = kids.slice(k);
      if (rest.length) {
        const total = rest.reduce((a, c) => a + c.size, 0);
        // O raio de "Outros itens" é limitado: a bolha-resumo não pode roubar o destaque dos maiores.
        items.push({ n: null, id: 'other', size: Math.min(total, kids[0].size * 0.35), bytes: total, other: true, count: rest.length });
      }
      items.sort((a, b) => b.size - a.size);
      const res = fitBubbles(items, w, hgt, { gap: GAP, pad: PAD, rMin: R_MIN, rMax: R_MAX });
      best = { w, h: hgt, k, items, f: res.f };
      if (res.f >= F_GOOD || k <= TOP_MIN) break;
    }
    return best;
  }

  function bubble(it, i) {
    const r = it.r, n = it.n, other = it.other;
    const full = other ? `Outros itens (${fmtNum(it.count)})` : n.name;
    const label = full;
    const sizeText = fmtBytes(it.bytes);
    const tier = r >= 84 ? 'l' : r >= 62 ? 'm' : r >= 42 ? 's' : 'xs';
    const showName = r >= 40;
    const fs = tier === 'l' ? 13.5 : tier === 'm' ? 12.5 : 11.5;
    const cap = Math.max(4, Math.floor((r * 1.7) / (fs * 0.56)));
    const px = Math.round(Math.min(Math.max(r * (showName ? 0.56 : 0.7), 24), 66));
    const el = h('div', {
      class: `bub t-${tier} k-${other ? 'other' : n.kind}${!other && !n.selectable ? ' locked' : ''}`, role: 'button', tabindex: '0',
      'aria-label': `${label}, ${sizeText}${!other && n.drillable ? ', pasta' : ''}`, title: `${label} · ${sizeText}`,
      style: `left:${(it.x - r).toFixed(1)}px;top:${(it.y - r).toFixed(1)}px;width:${(2 * r).toFixed(1)}px;height:${(2 * r).toFixed(1)}px`, vars: { '--i': String(i) },
    },
    h('span', { class: 'bub-body' },
      h('span', { class: 'bub-in' },
        other ? plainIcon('other', px) : nodeIcon(n, px),
        showName ? h('span', { class: 'bub-name', style: `font-size:${fs}px` }, other ? (cap >= full.length ? full : cap >= 12 ? 'Outros itens' : 'Outros') : midCut(label, cap)) : null,
        h('span', { class: 'bub-size' }, sizeText)),
      !other && !n.selectable && n.kind !== 'small' ? h('span', { class: 'bub-lock', 'aria-hidden': 'true' }, icon('lock', 11)) : null,
      !other ? h('span', { class: 'bub-check', 'aria-hidden': 'true' }, icon('check', 14)) : null));
    bubs.set(it.id, el);
    if (other) {
      el.addEventListener('click', (e) => { e.stopPropagation(); S.expanded = true; drawList(); const r0 = rows.get('other'); if (r0) r0.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
      el.addEventListener('mouseenter', () => hover('other', true));
      el.addEventListener('mouseleave', () => hover('other', false));
    } else clickable(el, n);
    return el;
  }

  function drawMap(dir) {
    const layer = shell.layer;
    bubs = new Map();
    layoutInfo = computeLayout();
    layer.classList.remove('leave-in', 'leave-out', 'enter-in', 'enter-out', 'still');
    layer.style.transformOrigin = '';
    if (!layoutInfo) { mount(layer); return; }
    const els = layoutInfo.items.map(bubble);
    mount(layer, els);
    shell.empty.hidden = layoutInfo.items.length > 0;
    shell.size = [layoutInfo.w, layoutInfo.h];
    if (dir === 'resize' || reducedMotion()) layer.classList.add('still');
    else {
      void layer.offsetWidth;
      layer.classList.add(dir === 'out' ? 'enter-out' : 'enter-in');
    }
  }

  // ---------- montagem da tela de resultados ----------
  function buildShell() {
    ensureDefs();
    const { node: root } = { node: S.root }, vol = S.vol;
    const usedPct = pct(vol.used, vol.total), rootPct = Math.min(usedPct, pct(root.size, vol.total));

    const volCard = h('div', { class: 'lens-vol' },
      h('div', { class: 'lv-top' }, h('b', null, vol.name), h('span', null, vol.total ? `${fmtBytes(vol.used)} de ${fmtBytes(vol.total)} usados` : `${fmtBytes(root.size)} analisados`)),
      h('div', { class: 'lv-bar', role: 'img', 'aria-label': `${Math.round(usedPct)}% do volume em uso` }, h('i', { class: 'used', style: `width:${usedPct}%` }), h('i', { class: 'mine', style: `width:${rootPct}%` })));

    menuBtn = h('button', { class: 'ln-select', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: () => {
      const kids = S.cur.children.filter((c) => c.selectable);
      const partial = partialIds();
      const nSel = kids.filter((c) => stateOf(c.id, partial) === 'on').length;
      menuBtn.setAttribute('aria-expanded', 'true');
      openMenu({
        at: below(menuBtn), opener: menuBtn, label: 'Selecionar', onClose: () => menuBtn.setAttribute('aria-expanded', 'false'),
        items: [
          { label: 'Nenhum', checked: nSel === 0, onSelect: () => { for (const c of S.cur.children) S.sel.delete(c.id); refreshSel(); } },
          { label: 'Tudo', checked: kids.length > 0 && nSel === kids.length, onSelect: () => { for (const c of S.cur.children) if (c.selectable && !ancestorsSelected(c.id)) S.sel.add(c.id); refreshSel(); } },
        ],
      });
    } }, h('span', null, 'Nenhum'), icon('chevron', 13));

    const headIc = h('span', { class: 'll-ic' }), headT = h('div', { class: 'll-t' });
    const listEl = h('div', { class: 'ln-rows' });
    const listCard = h('div', { class: 'lens-list' },
      h('div', { class: 'll-head' }, headIc, headT),
      h('div', { class: 'll-sel' }, h('span', null, 'Selecionar:'), menuBtn),
      listEl);

    const layer = h('div', { class: 'bub-layer', role: 'group', 'aria-label': 'Mapa de bolhas' });
    layer.addEventListener('dblclick', (e) => { if (e.target === layer) goUp(); });
    const empty = h('div', { class: 'map-empty', hidden: true }, 'Nada para mostrar aqui.');
    const mapEl = h('div', { class: 'lens-map' }, layer, empty);
    mapEl.addEventListener('dblclick', (e) => { if (e.target === mapEl) goUp(); });

    const backBtn = h('button', { class: 'nav-arrow', type: 'button', 'aria-label': 'Voltar', title: 'Voltar (⌘[)', onClick: goBack }, icon('back', 16));
    const fwdBtn = h('button', { class: 'nav-arrow fwd', type: 'button', 'aria-label': 'Avançar', title: 'Avançar (⌘])', onClick: goFwd }, icon('back', 16));
    const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Caminho' });
    const nav = h('div', { class: 'lens-nav' }, backBtn, fwdBtn, crumbs);

    selLabel = h('div', { class: 'lens-sel', 'aria-live': 'polite' });
    reviewBtn = h('button', { class: 'btn primary lens-review', type: 'button', disabled: true, onClick: review }, 'Revisar e Remover');

    const el = h('section', { class: 'lens', dataset: { mod: 'lens' }, 'aria-label': 'Disk Map', tabindex: '-1' },
      h('div', { class: 'lens-top' }, h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { S.phase = 'idle'; S.hasMap = true; st = null; render(); } }, icon('back', 14), 'Recomeçar')),
      h('div', { class: 'lens-body' },
        h('aside', { class: 'lens-left' }, volCard, listCard),
        h('div', { class: 'lens-right' }, nav, mapEl)),
      h('div', { class: 'lens-foot' }, selLabel, reviewBtn));
    el.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key === 'Backspace' || (e.metaKey && e.key === 'ArrowUp')) { e.preventDefault(); goUp(); }
      else if (e.metaKey && e.key === '[') { e.preventDefault(); goBack(); }
      else if (e.metaKey && e.key === ']') { e.preventDefault(); goFwd(); }
    });
    el.addEventListener('click', (e) => { if (e.target.closest('button, [role="button"], .ln-row, .cb, a, input')) return; el.focus({ preventScroll: true }); });
    shell = { el, layer, mapEl, empty, listEl, headIc, headT, crumbs, backBtn, fwdBtn, size: [0, 0], ro: null };
    mount(ctx.root, el);

    // O desenho depende do tamanho do mapa: refaz (sem animação) quando a janela muda.
    let raf = 0;
    shell.ro = new ResizeObserver(() => {
      const w = mapEl.clientWidth, hh = mapEl.clientHeight;
      if (Math.abs(w - shell.size[0]) < 2 && Math.abs(hh - shell.size[1]) < 2) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (shell && shell.el === el && S.cur) { drawMap('resize'); drawList(); } });
    });
    shell.ro.observe(mapEl);
  }

  function renderMap(dir = 'first') {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    if (!shell || !shell.el.isConnected) { dropShell(); buildShell(); dir = 'first'; }
    drawHead();
    mount(shell.crumbs, crumbsEl());
    shell.backBtn.disabled = !canBack();
    shell.fwdBtn.disabled = !canFwd();
    drawMap(dir === 'first' ? 'in' : dir);
    drawList();
    shell.listEl.scrollTop = 0;
    shell.listEl.classList.remove('swap'); void shell.listEl.offsetWidth; shell.listEl.classList.add('swap');
    if (!shell.el.contains(document.activeElement) || document.activeElement === document.body) shell.el.focus({ preventScroll: true });
  }

  // ---------- revisão e remoção ----------
  async function review() {
    const ids = topSelected();
    if (!ids.length) return;
    let res;
    try { res = await api.lensReview(ids); } catch (e) { return; }
    if (!ctx.alive) return;
    S.review = { result: res, sel: new Set(res.groups.flatMap((g) => g.items.map((i) => i.id))) };
    S.phase = 'review';
    render();
  }

  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const { result, sel } = S.review;
    const rv = createReview({
      result, sel, mod: 'lens', title: 'Revisar e Remover',
      subtitle: `${plural(result.groups.reduce((a, g) => a + g.items.length, 0), 'item', 'itens')} · ${fmtBytes(result.total)}`,
      actionLabel: 'Mover para o Lixo', showAge: true, emptyText: 'Nada selecionado.',
      onBack: () => { S.phase = 'map'; render(); }, onAction: () => move(),
    });
    mount(ctx.root, rv.el);
  }

  async function move() {
    const { result, sel } = S.review;
    let bytes = 0, count = 0;
    for (const g of result.groups) for (const i of g.items) if (sel.has(i.id)) { bytes += i.size; count++; }
    if (!count) return;
    const ok = await confirmDialog({
      title: `Mover ${plural(count, 'item', 'itens')} para o Lixo?`,
      body: [`${fmtBytes(bytes)} serão enviados ao Lixo. Você pode restaurá-los de lá `, h('strong', null, 'até esvaziar a Lixeira'), '.'],
      confirm: 'Mover para o Lixo', glyph: 'trash', mod: 'lens',
      permanentChoice: true, permanentDefault: !!(store.settings && store.settings.permanentDelete),
    });
    if (!ok) return;
    const permanent = ok === 'permanent';
    ctx.setBusy(true);
    ctx.reserveDock(true);
    st = stage('lens', 'lens', 260); mount(ctx.root, st.el); st.busy(true);
    st.show(h('h1', { class: 'h1' }, permanent ? 'Apagando…' : 'Movendo para o Lixo…'), h('p', { class: 'sub' }, plural(count, 'item', 'itens') + '.'));
    const sd = stopDock(ctx, 'lens');
    const res = await removeGroups(result, sel, (g, status, info) => { if (status !== 'run') sd.progress(info.done / info.total); }, { permanent, stopped: sd.stopped });
    bump(); store.trash = null;
    S.moved = res.freed; S.phase = 'done'; S.hasMap = false; S.cur = null; S.review = null; S.sel = new Set();
    play(res.freed ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (res.failures.length) failuresSheet(res.failures);
  }

  function renderDone() {
    st.show(h('div', { class: 'big' }, bytesParts(S.moved).value, h('small', null, bytesParts(S.moved).unit)), h('div', { class: 'big-cap' }, 'movidos para o Lixo'),
      h('p', { class: 'sub' }, 'Esvazie a Lixeira para liberar o espaço no disco. O mapa mudou: analise de novo para ver o resultado.'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        h('button', { class: 'btn primary', type: 'button', onClick: () => { S.phase = 'idle'; st = null; render(); } }, 'Analisar de novo'),
        h('button', { class: 'btn', type: 'button', onClick: () => ctx.nav('trash') }, icon('trash', 15), 'Ir para a Lixeira')));
    ctx.setDock(null);
  }

  render();
}
