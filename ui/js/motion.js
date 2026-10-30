// Movimento global, sem tocar nas views: observa body[data-mod] (troca de tela), #nav (menu reconstruído / item atual)
// e #view (heróis numéricos e estado "concluído"). Só transform/opacity; reduced-motion e body.idle desligam tudo.
// Um observer por alvo, trabalho adiado para um rAF só; nada de setInterval. Seletor ausente = nada acontece.
const view = document.getElementById('view');
const nav = document.getElementById('nav');
const dock = document.getElementById('dock');
const RM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const calm = () => RM.matches || document.hidden || document.body.classList.contains('idle');
const SPRING = 'cubic-bezier(.22, .7, .2, 1)';

let navAt = 0; // instante da última troca de tela: "concluído" logo após ela é reentrada, não conclusão ao vivo
const observers = [];

// ---------- 1) Transição de tela ----------
let enterAnims = [];

function enterScreen() {
  navAt = performance.now();
  slots.clear();
  enterAnims.forEach((a) => { try { a.cancel(); } catch (e) { /* já terminou */ } });
  enterAnims = [];
  if (!view || calm() || !view.animate) return;
  let kids = [...view.children];
  // Tela de um filho só (palco): escalona os filhos dele.
  if (kids.length === 1 && !kids[0].classList.contains('enter')) kids = [...kids[0].children];
  // Quem já entra com a própria animação (.enter) ou tem filho assim não é animado de novo: evita somar deslocamentos.
  kids = kids.filter((el) => !el.hidden && !el.classList.contains('enter') && !el.querySelector(':scope > .enter')).slice(0, 6);
  kids.forEach((el, i) => {
    enterAnims.push(el.animate(
      [{ opacity: 0, transform: 'translate3d(0, 12px, 0)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, delay: i * 36, easing: SPRING, fill: 'backwards' }));
  });
}

// ---------- 2) Pílula deslizante do menu ----------
let pill = null, pillPlaced = false, navRaf = 0;

function placePill() {
  navRaf = 0;
  if (!nav) return;
  if (!pill) { pill = document.createElement('i'); pill.className = 'nav-pill'; pill.setAttribute('aria-hidden', 'true'); }
  if (!pill.isConnected) { nav.prepend(pill); pillPlaced = false; } // mount() do menu apaga a pílula junto
  const cur = nav.querySelector('.nav-item[aria-current="page"]');
  const w = cur ? cur.offsetWidth : 0;
  if (!cur || !w) { nav.classList.remove('has-pill'); pill.style.opacity = '0'; pillPlaced = false; return; }
  pill.style.width = w + 'px';
  pill.style.height = cur.offsetHeight + 'px';
  const tf = `translate3d(${cur.offsetLeft}px, ${cur.offsetTop}px, 0)`;
  if (!pillPlaced) {
    // Primeira posição (ou menu novo): sem deslizar desde a origem.
    pill.classList.add('snap');
    pill.style.transform = tf;
    pill.style.opacity = '';
    void pill.offsetWidth;
    requestAnimationFrame(() => pill.classList.remove('snap'));
    pillPlaced = true;
  } else pill.style.transform = tf;
  nav.classList.add('has-pill');
}
const schedulePill = () => { if (!navRaf) navRaf = requestAnimationFrame(placePill); };

// ---------- 5) Contagem dos números "herói" ----------
// Só estes (resultado grande); linhas e listas nunca entram.
const HERO = '.big, .t-num, .cl-tile-n';
const DUR = 700;
const active = [];
const seen = new WeakMap(); // herói -> nó de texto já animado
const slots = new Map();    // herói repintado no mesmo lugar (tile) -> último texto, para não recontar à toa
let loop = 0;
const fmtCache = new Map();

function symbols(loc) {
  const parts = new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }).formatToParts(11111.1);
  const pick = (type) => (parts.find((p) => p.type === type) || { value: '' }).value;
  return { group: pick('group'), decimal: pick('decimal') };
}

// "12,3 GB" / "1.234" / "42 itens" -> { lead, tail, value, dec, fmt }. Só aceita se o texto reformatado for idêntico ao original.
function parse(text) {
  if (!text || text.length > 60) return null;
  const m = /^(\s*)(\d(?:[\d.,  ]*\d)?)([^\d]*)$/.exec(text);
  if (!m) return null;
  try {
    const loc = document.documentElement.lang || 'en-US';
    const { group, decimal } = symbols(loc);
    const s = (group ? m[2].split(group).join('') : m[2]).replace(decimal || '.', '.');
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const dec = s.includes('.') ? s.split('.')[1].length : 0;
    const key = loc + '|' + dec;
    let fmt = fmtCache.get(key);
    if (!fmt) { fmt = new Intl.NumberFormat(loc, { minimumFractionDigits: dec, maximumFractionDigits: dec }); fmtCache.set(key, fmt); }
    const value = Number(s);
    if (!isFinite(value) || fmt.format(value) !== m[2]) return null;
    return { lead: m[1], tail: m[3], value, dec, fmt };
  } catch (e) { return null; }
}

function slotKey(el) {
  const host = el.closest('.tile, .cl-tile');
  return (host ? host.dataset.id || host.dataset.tile || '' : '') + '|' + el.className;
}

function startCount(el) {
  if (calm() || !el.isConnected) return;
  const tn = [...el.childNodes].find((c) => c.nodeType === 3 && parse(c.nodeValue));
  if (!tn || seen.get(el) === tn) return;
  seen.set(el, tn);
  const text = tn.nodeValue, p = parse(text);
  let from = 0;
  if (!el.matches('.big')) {
    // Tile repintado com o mesmo valor não recontar; valor maior com a mesma unidade continua do anterior.
    const key = slotKey(el), prev = slots.get(key);
    slots.set(key, text);
    if (prev === text) return;
    const pp = prev && parse(prev);
    if (pp && pp.tail === p.tail && pp.value < p.value) from = pp.value;
  }
  if (p.value <= from || (p.value < 1 && p.dec === 0)) return;
  active.push({ tn, text, p, from, t0: 0 });
  tn.nodeValue = p.lead + p.fmt.format(from) + p.tail;
  if (!loop) loop = requestAnimationFrame(frame);
}

function frame(now) {
  loop = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    const a = active[i];
    if (!a.tn.isConnected || calm()) { a.tn.nodeValue = a.text; active.splice(i, 1); continue; }
    if (!a.t0) a.t0 = now;
    const k = Math.min(1, (now - a.t0) / DUR);
    if (k >= 1) { a.tn.nodeValue = a.text; active.splice(i, 1); continue; }
    const next = a.p.lead + a.p.fmt.format(a.from + (a.p.value - a.from) * (1 - Math.pow(1 - k, 3))) + a.p.tail;
    if (next !== a.tn.nodeValue) a.tn.nodeValue = next;
  }
  if (active.length) loop = requestAnimationFrame(frame);
}

// ---------- 6) Celebração ao concluir ----------
const celebrated = new Set(); // assinaturas já celebradas; zera quando a tela volta a trabalhar

function burst(anchor) {
  const r = anchor.getBoundingClientRect();
  if (!r.width || calm()) return;
  const rad = Math.min(r.width, r.height) / 2;
  const box = document.createElement('div');
  box.className = 'mo-fx';
  box.setAttribute('aria-hidden', 'true');
  box.style.left = (r.left + r.width / 2) + 'px';
  box.style.top = (r.top + r.height / 2) + 'px';
  box.style.setProperty('--d', (rad * 2) + 'px');
  const mk = (cls) => { const e = document.createElement('i'); e.className = cls; box.append(e); return e; };
  mk('mo-bloom'); mk('mo-ring'); mk('mo-ring two');
  for (let i = 0; i < 8; i++) {
    const a = ((i * 45 - 90 + (Math.random() * 20 - 10)) * Math.PI) / 180;
    const dist = rad * (1.12 + (i % 3) * 0.14) + 10, e = mk('mo-spark' + (i % 2 ? ' glow' : ''));
    e.style.setProperty('--x0', (Math.cos(a) * rad * 0.9).toFixed(1) + 'px');
    e.style.setProperty('--y0', (Math.sin(a) * rad * 0.9).toFixed(1) + 'px');
    e.style.setProperty('--dx', (Math.cos(a) * dist).toFixed(1) + 'px');
    e.style.setProperty('--dy', (Math.sin(a) * dist).toFixed(1) + 'px');
    e.style.setProperty('--t', (700 + (i % 3) * 100) + 'ms');
    e.style.setProperty('--sz', (3 + (i % 3)) + 'px');
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 1400);
}

function checkDone() {
  if (!view) return;
  const mod = document.body.dataset.mod || '';
  // Voltou a trabalhar (analisando/limpando): a próxima conclusão é nova.
  if (view.querySelector('.orb.busy, .bento[data-phase="scan"], .bento[data-phase="cleaning"]')) { celebrated.clear(); return; }
  let anchor = null, sig = '';
  const stage = view.querySelector('.stage');
  const bento = view.querySelector('.bento[data-phase="done"]');
  if (stage) {
    const text = stage.querySelector('.stage-text');
    const big = text && text.querySelector('.big');
    const dockOff = !dock || dock.classList.contains('off'); // com o botão redondo ativo ainda é pré-limpeza
    if ((big && dockOff) || stage.querySelector('.orb-glyph.i-check')) {
      anchor = stage.querySelector('.stage-art .orb');
      sig = mod + '|' + (text ? text.textContent.slice(0, 80) : '');
    }
  } else if (bento) {
    anchor = bento.querySelector('.tile[data-st="final"]:not(.skipped):not(.dim) .orb') || bento.parentElement.querySelector('.bento-head');
    sig = mod + '|bento';
  }
  if (!anchor || celebrated.has(sig)) return;
  celebrated.add(sig);
  if (performance.now() - navAt < 700) return; // reentrada em tela já concluída
  burst(anchor);
}

// ---------- Observação de #view ----------
let pending = new Set(), viewRaf = 0;

function collect(n, into) {
  if (n.nodeType === 3) n = n.parentElement;
  if (!n || n.nodeType !== 1) return;
  if (n.matches(HERO)) into.add(n);
  else {
    const up = n.closest(HERO);
    if (up) into.add(up);
    else if (n.firstElementChild) n.querySelectorAll(HERO).forEach((e) => into.add(e));
  }
}

function scanView() {
  viewRaf = 0;
  const nodes = pending;
  pending = new Set();
  const heroes = new Set();
  nodes.forEach((n) => { if (n.isConnected) collect(n, heroes); });
  heroes.forEach(startCount);
  checkDone();
}

function onView(records) {
  for (const r of records) {
    if (pending.size > 300) break;
    if (r.type === 'attributes') pending.add(r.target);
    else r.addedNodes.forEach((n) => pending.add(n));
  }
  if (!viewRaf) viewRaf = requestAnimationFrame(scanView);
}

// ---------- Ligação ----------
function watch(target, opts, cb) {
  if (!target || !window.MutationObserver) return;
  const mo = new MutationObserver(cb);
  mo.observe(target, opts);
  observers.push(mo);
}

watch(document.body, { attributes: true, attributeFilter: ['data-mod'] }, enterScreen);
watch(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current'] }, schedulePill);
watch(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] }, onView);
window.addEventListener('resize', schedulePill);
schedulePill();
// Descarta observers ao fechar a janela.
window.addEventListener('pagehide', () => { observers.forEach((o) => o.disconnect()); observers.length = 0; });

export {};
