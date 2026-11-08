// DOM helpers. File names come from disk (untrusted): only textContent / createElement.
const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'disabled' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, kids);
  return el;
}

export function s(tag, props, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(props || {})) if (v != null) el.setAttribute(k, String(v));
  append(el, kids);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...kids) {
  clear(el);
  append(el, kids);
  return el;
}

// Runs a repaint that rebuilds controls inside `root` and keeps keyboard focus: the focused control's data-fk key is
// read first and the matching new node refocused afterwards (otherwise focus would fall back to <body>).
export function keepFocus(root, fn) {
  const a = document.activeElement;
  const key = a && a !== document.body && root.contains(a) && a.dataset ? a.dataset.fk : null;
  fn();
  if (!key || root.contains(document.activeElement)) return;
  const n = root.querySelector(`[data-fk="${CSS.escape(key)}"]`);
  if (n && !n.disabled) n.focus();
}

// A phase change rebuilds the whole screen with mount(): focus that was inside it (a button the keyboard user pressed)
// would fall to <body>, and the next Tab would start over from the sidebar. After fn(), lost focus goes to the control
// with the same data-fk, or to the new screen's heading (like focusScreen in main.js).
export function keepPhaseFocus(root, fn) {
  const a = document.activeElement;
  const inside = !!a && a !== document.body && root.contains(a);
  const key = inside && a.dataset ? a.dataset.fk : null;
  const r = fn();
  if (!inside) return r;
  const now = document.activeElement;
  if (now && now !== document.body && root.contains(now)) return r;
  let n = key ? root.querySelector(`[data-fk="${CSS.escape(key)}"]`) : null;
  if (!n || n.disabled) {
    n = root.querySelector('h1, h2');
    if (n && !n.hasAttribute('tabindex')) n.setAttribute('tabindex', '-1');
  }
  if (n) n.focus({ preventScroll: true });
  return r;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Path with an ellipsis in the middle: the start shrinks, the end (file name) stays.
export function mid(text, tail = 24) {
  const t = text || '';
  let cut = Math.max(0, t.length - tail);
  const slash = t.indexOf('/', cut);
  if (slash > 0 && t.length - slash > 8) cut = slash;
  return h('span', { class: 'mid', title: t }, h('span', null, t.slice(0, cut)), h('span', null, t.slice(cut)));
}
