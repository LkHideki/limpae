// Helpers de DOM. Nomes de arquivos vêm do disco (não confiáveis): só textContent / createElement.
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Caminho com reticências no meio: o início encolhe, o final (nome do arquivo) permanece.
export function mid(text, tail = 24) {
  const t = text || '';
  let cut = Math.max(0, t.length - tail);
  const slash = t.indexOf('/', cut);
  if (slash > 0 && t.length - slash > 8) cut = slash;
  return h('span', { class: 'mid', title: t }, h('span', null, t.slice(0, cut)), h('span', null, t.slice(cut)));
}
