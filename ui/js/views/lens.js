// Disk Map: mapa de bolhas navegável. Só ids de nós trafegam; o backend resolve caminhos e valida cada remoção.
import { play } from '../sound.js';
import { h, s, mount } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store, bump } from '../store.js';
import { bytesParts, fmtBytes, plural, pct } from '../format.js';
import { confirmDialog, failuresSheet, stage, checkbox } from '../ui.js';
import { removeGroups } from '../actions.js';
import { layout } from '../pack.js';
import { createReview } from './review.js';

const MAX_BUBBLES = 120;
const MAP_W = 560, MAP_H = 520;
const LIST_CHUNK = 250;
const KIND_ICON = { dir: 'folder', file: 'file', package: 'box', small: 'file', other: 'archive' };

// Estado da sessão: sobrevive à troca de módulo (o mapa fica no backend até o próximo scan).
const S = { phase: 'idle', roots: null, rootIdx: 0, root: null, vol: null, cache: new Map(), sel: new Set(), hist: [], pos: -1, cur: null, expanded: false, listLimit: LIST_CHUNK, review: null, moved: 0, hasMap: false };

export function enter(ctx) {
  let st = null, cancelled = false, navToken = 0;
  let rows = new Map(), bubs = new Map(), cbs = new Map();
  let selLabel = null, footEl = null, reviewBtn = null, menuBtn = null;
  if (!['map', 'review', 'done'].includes(S.phase) || (S.phase === 'map' && !S.cur) || (S.phase === 'review' && !S.review)) S.phase = 'idle';

  const node = (id) => S.cache.get(id);

  function render() {
    if (S.phase === 'map' && S.cur) return renderMap();
    if (S.phase === 'review' && S.review) return renderReview();
    ctx.reserveDock(true);
    if (!st) { st = stage('lens', 'lens', 260); mount(ctx.root, st.el); }
    st.busy(false);
    if (S.phase === 'done') return renderDone();
    S.phase = 'idle';
    return renderIdle();
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
      const on = id !== 'other' && stateOf(id, partial) === 'on';
      el.classList.toggle('sel', on);
      el.classList.toggle('part', id !== 'other' && !on && stateOf(id, partial) === 'mixed');
      if (id !== 'other') el.setAttribute('aria-pressed', String(on));
    }
    for (const [id, cb] of cbs) {
      cb.set(stateOf(id, partial));
      cb.disabled = ancestorsSelected(id) || !node(id).selectable;
    }
    const kids = S.cur.children.filter((c) => c.selectable);
    const nSel = kids.filter((c) => stateOf(c.id, partial) === 'on').length;
    if (menuBtn) menuBtn.firstChild.textContent = nSel === 0 ? 'Nenhum' : nSel === kids.length ? 'Todos' : `${nSel} de ${kids.length}`;
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
        S.root = r.root; S.vol = { total: r.volumeTotal, used: r.volumeUsed, name: rootTitle(S.roots[S.rootIdx]) };
        S.cache = new Map([[r.root.id, r.root]]); S.sel = new Set(); S.hist = []; S.pos = -1; S.cur = null;
        ok = true;
      }
    } catch (e) { /* toast já exibido */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (ok) {
      const loaded = await open(S.root.id, true, true);
      if (!ctx.alive) return;
      S.phase = loaded ? 'map' : 'idle';
      S.hasMap = loaded;
      if (loaded) play('found');
    } else S.phase = 'idle';
    render();
  }

  // ---------- navegação ----------
  async function open(id, push = true, quiet = false) {
    const token = ++navToken;
    let r;
    try { r = await api.lensChildren(id); } catch (e) { return false; }
    if (token !== navToken || !ctx.alive) return false;
    S.cache.set(r.node.id, r.node);
    for (const c of r.children) S.cache.set(c.id, c);
    if (push) { S.hist = S.hist.slice(0, S.pos + 1); S.hist.push(id); S.pos = S.hist.length - 1; }
    S.cur = r; S.expanded = false; S.listLimit = LIST_CHUNK;
    if (!quiet) renderMap();
    return true;
  }
  const canBack = () => S.pos > 0;
  const canFwd = () => S.pos < S.hist.length - 1;
  const goBack = () => { if (canBack()) { S.pos--; open(S.hist[S.pos], false); } };
  const goFwd = () => { if (canFwd()) { S.pos++; open(S.hist[S.pos], false); } };
  const goUp = () => { if (S.cur && S.cur.node.parent != null) open(S.cur.node.parent); };
  const drill = (n) => { if (n && n.drillable) open(n.id); };

  // ---------- mapa ----------
  function hover(id, on) {
    const r = rows.get(id), b = bubs.get(id);
    if (r) r.classList.toggle('hot', on);
    if (b) b.classList.toggle('hot', on);
  }

  function crumbsEl() {
    const cr = S.cur.crumbs;
    const show = cr.length > 4 ? [cr[0], null, ...cr.slice(-2)] : cr;
    const out = [];
    show.forEach((c, i) => {
      if (i) out.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, icon('back', 12)));
      if (!c) { out.push(h('span', { class: 'crumb dots', title: cr.slice(1, -2).map((x) => x.name).join(' › ') }, '…')); return; }
      const last = c.id === S.cur.node.id;
      out.push(h('button', { class: 'crumb', type: 'button', title: c.name, 'aria-current': last ? 'page' : null, disabled: last, onClick: () => open(c.id) }, c.name));
    });
    return h('nav', { class: 'crumbs', 'aria-label': 'Caminho' }, out);
  }

  function row(n) {
    const partial = partialIds();
    const cb = checkbox(stateOf(n.id, partial), () => toggle(n.id), `Selecionar ${n.name}`);
    if (!n.selectable) { cb.disabled = true; cb.title = n.kind === 'small' ? 'Arquivos pequenos não são listados um a um' : 'Item protegido: não pode ser removido'; }
    cbs.set(n.id, cb);
    const el = h('div', { class: 'ln-row' + (n.drillable ? ' dir' : ''), tabindex: '0', dataset: { id: String(n.id) },
      onMouseenter: () => hover(n.id, true), onMouseleave: () => hover(n.id, false), onFocus: () => hover(n.id, true), onBlur: () => hover(n.id, false),
      onDblclick: () => drill(n),
      onKeydown: (e) => { if (e.key === 'Enter') drill(n); else if (e.key === ' ' && e.target === el) { e.preventDefault(); toggle(n.id); } } },
      cb, h('span', { class: 'ln-ic', dataset: { kind: n.kind } }, icon(KIND_ICON[n.kind] || 'file', 18)),
      h('span', { class: 'ln-name', title: n.path }, n.name),
      n.drillable ? h('button', { class: 'icon-btn ln-open', type: 'button', 'aria-label': `Abrir ${n.name}`, title: 'Abrir', onClick: (e) => { e.stopPropagation(); drill(n); } }, icon('back', 14)) : null,
      h('span', { class: 'ln-size' }, fmtBytes(n.size)));
    rows.set(n.id, el);
    return el;
  }

  function otherRow(rest, total) {
    const el = h('button', { class: 'ln-row other', type: 'button', onMouseenter: () => hover('other', true), onMouseleave: () => hover('other', false),
      onClick: () => { S.expanded = !S.expanded; drawList(); } },
      h('span', { class: 'ln-ic', dataset: { kind: 'other' } }, icon('archive', 18)),
      h('span', { class: 'ln-name' }, 'Outros itens', h('small', null, plural(rest, 'item', 'itens'))),
      h('span', { class: 'ln-size' }, fmtBytes(total)),
      h('span', { class: 'ln-chev' + (S.expanded ? ' open' : ''), 'aria-hidden': 'true' }, icon('back', 14)));
    rows.set('other', el);
    el.setAttribute('aria-expanded', String(S.expanded));
    return el;
  }

  let listEl = null;
  function drawList() {
    rows = new Map(); cbs = new Map();
    const kids = S.cur.children;
    const head = kids.slice(0, MAX_BUBBLES), rest = kids.slice(MAX_BUBBLES);
    const out = head.map(row);
    if (rest.length) {
      out.push(otherRow(rest.length, rest.reduce((a, c) => a + c.size, 0)));
      if (S.expanded) {
        out.push(...rest.slice(0, S.listLimit).map(row));
        if (rest.length > S.listLimit) out.push(h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.listLimit += LIST_CHUNK; drawList(); } }, `Mostrar mais (${plural(rest.length - S.listLimit, 'item', 'itens')})`)));
      }
    }
    if (!kids.length) out.push(h('div', { class: 'rv-empty' }, 'Esta pasta está vazia.'));
    mount(listEl, out);
    refreshSel();
  }

  function drawMap(svg) {
    bubs = new Map();
    const kids = S.cur.children;
    const items = kids.slice(0, MAX_BUBBLES).map((n) => ({ n, id: n.id, size: n.size, other: false }));
    const rest = kids.slice(MAX_BUBBLES);
    if (rest.length) items.push({ n: null, id: 'other', size: rest.reduce((a, c) => a + c.size, 0), other: true, count: rest.length });
    if (!items.length) return;
    // Área proporcional ao tamanho, com piso para que itens minúsculos continuem visíveis.
    const rmax = Math.sqrt(Math.max(...items.map((i) => i.size), 1));
    for (const it of items) it.r = Math.max(Math.sqrt(it.size), rmax * 0.17);
    const circles = [...items].sort((a, b) => b.r - a.r);
    layout(circles, MAP_W, MAP_H, 8);
    const defs = s('defs', null,
      grad('g-dir', ['rgba(214,255,150,.72)', 'rgba(60,200,150,.34)', 'rgba(8,70,80,.62)']),
      grad('g-file', ['rgba(170,210,255,.7)', 'rgba(79,140,255,.34)', 'rgba(18,36,110,.62)']),
      grad('g-package', ['rgba(214,190,255,.7)', 'rgba(124,92,255,.36)', 'rgba(40,20,100,.64)']),
      grad('g-small', ['rgba(205,220,240,.46)', 'rgba(120,145,180,.22)', 'rgba(22,38,72,.6)']),
      grad('g-sel', ['rgba(255,176,230,.82)', 'rgba(232,70,176,.46)', 'rgba(96,14,72,.68)']));
    const bg = s('rect', { class: 'map-bg', x: 0, y: 0, width: MAP_W, height: MAP_H, fill: 'transparent' });
    const gs = circles.map((c) => bubble(c));
    svg.append(defs, bg, ...gs);
  }

  const grad = (id, [a, b, c]) => s('radialGradient', { id, cx: '36%', cy: '26%', r: '82%' },
    s('stop', { offset: '0%', 'stop-color': a }), s('stop', { offset: '55%', 'stop-color': b }), s('stop', { offset: '100%', 'stop-color': c }));

  function bubble(c) {
    const n = c.n, r = c.r;
    const kind = c.other ? 'small' : n.kind;
    const label = c.other ? 'Outros itens' : n.name;
    const sizeText = fmtBytes(c.size);
    const g = s('g', { class: `bub k-${c.other ? 'other' : n.kind}`, transform: `translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`, tabindex: c.other ? null : '0', role: c.other ? null : 'button', 'aria-label': `${label}, ${sizeText}` },
      s('title', null, `${label} · ${sizeText}`),
      s('circle', { class: 'body', r: r.toFixed(1) }),
      s('circle', { class: 'rim', r: Math.max(r - 3, 1).toFixed(1) }));
    const showIcon = r >= 24, showName = r >= 28, showSize = r >= 42;
    if (showIcon) {
      const isz = Math.min(Math.max(r * 0.5, 16), 40);
      const top = showName ? -r * (showSize ? 0.55 : 0.42) - 2 : -isz / 2;
      const ic = icon(KIND_ICON[kind] || 'folder', isz, 'bub-ic');
      ic.setAttribute('x', (-isz / 2).toFixed(1)); ic.setAttribute('y', top.toFixed(1));
      g.append(ic);
    }
    if (showName) {
      const cap = Math.max(3, Math.floor((r * 1.5) / 6.6));
      const text = label.length > cap ? label.slice(0, Math.max(1, cap - 1)) + '…' : label;
      const ty = showIcon ? (showSize ? r * 0.16 : r * 0.3) : 4;
      g.append(s('text', { class: 'bub-name', y: (ty + 10).toFixed(1), 'text-anchor': 'middle' }, text));
      if (showSize) g.append(s('text', { class: 'bub-size', y: (ty + 25).toFixed(1), 'text-anchor': 'middle' }, sizeText));
    }
    bubs.set(c.id, g);
    g.addEventListener('mouseenter', () => hover(c.id, true));
    g.addEventListener('mouseleave', () => hover(c.id, false));
    g.addEventListener('focus', () => hover(c.id, true));
    g.addEventListener('blur', () => hover(c.id, false));
    if (c.other) {
      g.addEventListener('click', () => { S.expanded = true; drawList(); const r0 = rows.get('other'); if (r0) r0.scrollIntoView({ block: 'nearest' }); });
    } else {
      let timer = 0;
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!n.drillable) return toggle(n.id);
        // Aguarda um possível duplo clique antes de marcar.
        clearTimeout(timer);
        timer = setTimeout(() => toggle(n.id), 230);
      });
      g.addEventListener('dblclick', (e) => { e.stopPropagation(); clearTimeout(timer); drill(n); });
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && n.drillable) { e.preventDefault(); drill(n); }
        else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(n.id); }
      });
    }
    return g;
  }

  function renderMap() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const { node: cur } = S.cur;
    const vol = S.vol;
    const root = S.root;
    const usedPct = pct(vol.used, vol.total), rootPct = Math.min(usedPct, pct(root.size, vol.total));

    const volCard = h('div', { class: 'lens-vol' },
      h('div', { class: 'lv-top' }, h('b', null, vol.name), h('span', null, vol.total ? `${fmtBytes(vol.used)} de ${fmtBytes(vol.total)} usados` : `${fmtBytes(root.size)} analisados`)),
      h('div', { class: 'lv-bar', role: 'img', 'aria-label': `${Math.round(usedPct)}% do volume em uso` }, h('i', { class: 'used', style: `width:${usedPct}%` }), h('i', { class: 'mine', style: `width:${rootPct}%` })));

    const menu = h('div', { class: 'ln-menu', role: 'menu', hidden: true },
      h('button', { type: 'button', role: 'menuitem', onClick: () => { for (const c of S.cur.children) S.sel.delete(c.id); closeMenu(); refreshSel(); } }, 'Nenhum'),
      h('button', { type: 'button', role: 'menuitem', onClick: () => { for (const c of S.cur.children) if (c.selectable && !ancestorsSelected(c.id)) S.sel.add(c.id); closeMenu(); refreshSel(); } }, 'Todos'));
    menuBtn = h('button', { class: 'ln-select', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); } }, h('span', null, 'Nenhum'), icon('back', 12));
    function openMenu() { menu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true'); setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0); }
    function closeMenu() { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }

    listEl = h('div', { class: 'ln-rows' });
    const listCard = h('div', { class: 'lens-list' },
      h('div', { class: 'll-head' },
        h('span', { class: 'll-ic' }, icon(cur.id === root.id ? 'disk' : 'folder', 26)),
        h('div', { class: 'll-t' }, h('b', { title: cur.path }, cur.id === root.id ? vol.name : cur.name), h('span', null, `${fmtBytes(cur.size)} | ${plural(cur.items, 'arquivo', 'arquivos')}`))),
      h('div', { class: 'll-sel' }, h('span', null, 'Selecionar:'), h('div', { class: 'll-menu' }, menuBtn, menu)),
      listEl);

    const svg = s('svg', { class: 'lens-svg', viewBox: `0 0 ${MAP_W} ${MAP_H}`, role: 'group', 'aria-label': 'Mapa de bolhas' });
    drawMap(svg);
    svg.addEventListener('dblclick', (e) => { if (!e.target.closest('.bub')) goUp(); });
    const empty = S.cur.children.length ? null : h('div', { class: 'map-empty' }, 'Nada para mostrar aqui.');

    const nav = h('div', { class: 'lens-nav' },
      h('button', { class: 'nav-arrow', type: 'button', 'aria-label': 'Voltar', disabled: !canBack(), onClick: goBack }, icon('back', 16)),
      h('button', { class: 'nav-arrow fwd', type: 'button', 'aria-label': 'Avançar', disabled: !canFwd(), onClick: goFwd }, icon('back', 16)),
      crumbsEl());

    selLabel = h('div', { class: 'lens-sel', 'aria-live': 'polite' });
    reviewBtn = h('button', { class: 'btn primary lens-review', type: 'button', disabled: true, onClick: review }, 'Revisar e Remover');
    footEl = h('div', { class: 'lens-foot' }, selLabel, reviewBtn);

    mount(ctx.root, h('section', { class: 'lens enter', dataset: { mod: 'lens' }, 'aria-label': 'Disk Map' },
      h('div', { class: 'lens-top' }, h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { S.phase = 'idle'; S.hasMap = true; st = null; render(); } }, icon('back', 14), 'Recomeçar')),
      h('div', { class: 'lens-body' },
        h('aside', { class: 'lens-left' }, volCard, listCard),
        h('div', { class: 'lens-right' }, nav, h('div', { class: 'lens-map' }, svg, empty))),
      footEl));
    drawList();
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
    });
    if (!ok) return;
    ctx.setBusy(true);
    ctx.reserveDock(true);
    st = stage('lens', 'lens', 260); mount(ctx.root, st.el); st.busy(true);
    st.show(h('h1', { class: 'h1' }, 'Movendo para o Lixo…'), h('p', { class: 'sub' }, plural(count, 'item', 'itens') + '.'));
    ctx.setDock({ label: 'Movendo', busy: true, mod: 'lens' });
    const res = await removeGroups(result, sel);
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
