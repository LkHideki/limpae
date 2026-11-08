// Global motion, without touching the views: observes body[data-mod] (screen change), #nav (menu rebuilt / current item)
// and #view (numeric heroes and "done" state). Only transform/opacity; reduced-motion and body.idle turn everything off.
// One observer per target, work deferred to a single rAF; no setInterval. Missing selector = nothing happens.
const view = document.getElementById('view');
const nav = document.getElementById('nav');
const RM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const calm = () => RM.matches || document.hidden || document.body.classList.contains('idle');
const SPRING = 'cubic-bezier(.22, .7, .2, 1)';

let navAt = 0; // instant of the last screen change: "done" right after it is a re-entry, not a live completion
const observers = [];

// ---------- 1) Screen transition ----------
let enterAnims = [];

function enterScreen() {
  navAt = performance.now();
  slots.clear();
  enterAnims.forEach((a) => { try { a.cancel(); } catch (e) { /* already finished */ } });
  enterAnims = [];
  if (!view || calm() || !view.animate) return;
  let kids = [...view.children];
  // Single-child screen (stage): staggers its children.
  if (kids.length === 1 && !kids[0].matches('.enter, .own-enter')) kids = [...kids[0].children];
  // Anything that already enters with its own animation (.enter), whose children do (.own-enter), or has such a
  // child is not animated again: avoids stacking offsets.
  kids = kids.filter((el) => !el.hidden && !el.matches('.enter, .own-enter') && !el.querySelector(':scope > .enter, :scope > .own-enter')).slice(0, 6);
  kids.forEach((el, i) => {
    enterAnims.push(el.animate(
      [{ opacity: 0, transform: 'translate3d(0, 12px, 0)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, delay: i * 36, easing: SPRING, fill: 'backwards' }));
  });
}

// ---------- 2) Sliding menu pill ----------
let pill = null, pillPlaced = false, navRaf = 0;

function placePill() {
  navRaf = 0;
  if (!nav) return;
  if (!pill) { pill = document.createElement('i'); pill.className = 'nav-pill'; pill.setAttribute('aria-hidden', 'true'); }
  if (!pill.isConnected) { nav.prepend(pill); pillPlaced = false; } // the menu's mount() wipes the pill along with it
  const cur = nav.querySelector('.nav-item[aria-current="page"]');
  const w = cur ? cur.offsetWidth : 0;
  if (!cur || !w) { nav.classList.remove('has-pill'); pill.style.opacity = '0'; pillPlaced = false; return; }
  pill.style.width = w + 'px';
  pill.style.height = cur.offsetHeight + 'px';
  const tf = `translate3d(${cur.offsetLeft}px, ${cur.offsetTop}px, 0)`;
  if (!pillPlaced) {
    // First position (or new menu): no sliding from the origin.
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

// ---------- 5) Counting up the "hero" numbers ----------
// Only these (big result); rows and lists never qualify.
const HERO = '.big, .t-num, .cl-tile-n';
const DUR = 700;
const active = [];
const seen = new WeakMap(); // hero -> text node already animated
const slots = new Map();    // hero repainted in the same place (tile) -> last text, to avoid pointless recounting
const bigSeen = new Map();  // screen|big hero -> last value shown, kept across navigation: a re-entry does not recount it
let loop = 0;
const fmtCache = new Map();

function symbols(loc) {
  const parts = new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }).formatToParts(11111.1);
  const pick = (type) => (parts.find((p) => p.type === type) || { value: '' }).value;
  return { group: pick('group'), decimal: pick('decimal') };
}

// "12,3 GB" / "1.234" / "42 itens" -> { lead, tail, value, dec, fmt }. Only accepted if the reformatted text is identical to the original.
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
    // A tile repainted with the same value does not recount; a larger value with the same unit continues from the previous one.
    const key = slotKey(el), prev = slots.get(key);
    slots.set(key, text);
    if (prev === text) return;
    const pp = prev && parse(prev);
    if (pp && pp.tail === p.tail && pp.value < p.value) from = pp.value;
  } else {
    // A hero whose value is unchanged since it was last shown does not recount, however it came back (screen revisited,
    // or a manager's Back re-mounting the stage). A new scan/removal resets it: see the busy branch of checkDone.
    const key = (document.body.dataset.mod || '') + '|' + slotKey(el), val = p.value + '|' + p.tail;
    const prev = bigSeen.get(key);
    bigSeen.set(key, val);
    if (prev === val) return;
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

// ---------- 6) Celebration on completion ----------
const celebrated = new Set(); // signatures already celebrated; reset when the screen goes back to working

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

// Runs fn once the element's running CSS transitions end (capped), so a burst is anchored where the element
// comes to rest instead of where it was when the transition started.
function afterSettle(el, fn) {
  const runs = el && el.getAnimations ? el.getAnimations().filter((a) => a.playState === 'running' && 'transitionProperty' in a) : [];
  if (!runs.length) return fn();
  let fired = false;
  const go = () => { if (!fired) { fired = true; fn(); } };
  Promise.all(runs.map((a) => a.finished.catch(() => {}))).then(go);
  setTimeout(go, 800);
}

function checkDone() {
  if (!view) return;
  const mod = document.body.dataset.mod || '';
  // Back to working (scanning/cleaning): the next completion is a new one.
  if (view.querySelector('.orb.busy, .bento[data-phase="scan"], .bento[data-phase="cleaning"]')) {
    celebrated.clear();
    for (const k of bigSeen.keys()) if (k.startsWith(mod + '|')) bigSeen.delete(k); // its hero counts again when the result lands
    return;
  }
  // Only a real success celebrates: views set data-result="ok" when the action handled something (never for a
  // result of 0 B, all failures or a Stop before anything was removed).
  let anchor = null, sig = '', settle = null;
  const stage = view.querySelector('.stage');
  const bento = view.querySelector('.bento[data-phase="done"][data-result="ok"]');
  if (stage) {
    const text = stage.querySelector('.stage-text[data-result="ok"]');
    if (text) {
      anchor = stage.querySelector('.stage-art .orb');
      // The caption/title, never the counting hero: its text changes while the count-up runs and would look like a new success.
      sig = mod + '|' + (text.querySelector('.big-cap, .h1') || text).textContent.slice(0, 80);
    }
  } else if (bento) {
    anchor = bento.querySelector('.tile[data-ok] .orb');
    settle = anchor && anchor.closest('.tile-orb'); // the last tile is still flying back to its corner
    sig = mod + '|bento';
  }
  if (!anchor || celebrated.has(sig)) return;
  // Finished in the background (window hidden or unfocused): not marked yet, so the burst plays when the user
  // comes back (see the focus listener below). Reduced motion still marks it: it never plays.
  if (document.hidden || document.body.classList.contains('idle')) return;
  // A dialog is up (e.g. the failures sheet of a partial success): the burst waits for it to go (see the #modal-root observer).
  if (document.querySelector('.modal-back:not(.out)')) return;
  celebrated.add(sig);
  if (performance.now() - navAt < 700) return; // re-entry into an already completed screen
  afterSettle(settle, () => { if (anchor.isConnected) burst(anchor); }); // burst() re-checks calm()
}

// ---------- Observing #view ----------
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

// ---------- Wiring ----------
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
// A dialog leaving may release a celebration held back while it was open.
watch(document.getElementById('modal-root'), { childList: true }, () => requestAnimationFrame(checkDone));
// Back to the window: a completion that happened while away celebrates now. Deferred a frame so main.js has
// already cleared body.idle (its focus listener is registered after this module runs).
const onReturn = () => requestAnimationFrame(checkDone);
window.addEventListener('focus', onReturn);
document.addEventListener('visibilitychange', () => { if (!document.hidden) onReturn(); });
schedulePill();
// Disconnects observers when the window closes.
window.addEventListener('pagehide', () => { observers.forEach((o) => o.disconnect()); observers.length = 0; });

export {};
