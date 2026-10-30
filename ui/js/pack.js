// Circle packing sem bibliotecas: front-chain de d3.packSiblings (Wang et al.), sem círculo envolvente exato.
// Recebe círculos { r } e define x, y de cada um; devolve o raio do círculo que envolve todos, centrado em (0, 0).

function place(b, a, c) {
  const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
  if (d2) {
    let a2 = a.r + c.r, b2 = b.r + c.r;
    a2 *= a2; b2 *= b2;
    if (a2 > b2) {
      const x = (d2 + b2 - a2) / (2 * d2), y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
      c.x = b.x - x * dx - y * dy;
      c.y = b.y - x * dy + y * dx;
    } else {
      const x = (d2 + a2 - b2) / (2 * d2), y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
      c.x = a.x + x * dx - y * dy;
      c.y = a.y + x * dy + y * dx;
    }
  } else {
    c.x = a.x + c.r;
    c.y = a.y;
  }
}

function intersects(a, b) {
  const dr = a.r + b.r - 1e-6, dx = b.x - a.x, dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

// Quadrado da distância do centroide ponderado do par (node, node.next) à origem.
function score(node) {
  const a = node.c, b = node.next.c, ab = a.r + b.r;
  const dx = (a.x * b.r + b.x * a.r) / ab, dy = (a.y * b.r + b.y * a.r) / ab;
  return dx * dx + dy * dy;
}

export function packSiblings(circles) {
  const n = circles.length;
  if (!n) return 0;
  let a = circles[0];
  a.x = 0; a.y = 0;
  if (n === 1) return a.r;
  let b = circles[1];
  a.x = -b.r; b.x = a.r; b.y = 0;
  if (n === 2) { center(circles); return enclose(circles); }
  let c = circles[2];
  place(b, a, c);

  // Cadeia frontal (lista circular duplamente ligada) com os três primeiros círculos.
  a = { c: a, next: null, prev: null };
  b = { c: b, next: null, prev: null };
  c = { c, next: null, prev: null };
  a.next = c.prev = b;
  b.next = a.prev = c;
  c.next = b.prev = a;

  pack: for (let i = 3; i < n; ++i) {
    const circle = circles[i];
    place(a.c, b.c, circle);
    c = { c: circle, next: null, prev: null };
    // Procura o círculo da cadeia que intersecta o novo, andando nos dois sentidos.
    let j = b.next, k = a.prev, sj = b.c.r, sk = a.c.r;
    do {
      if (sj <= sk) {
        if (intersects(j.c, c.c)) { b = j; a.next = b; b.prev = a; --i; continue pack; }
        sj += j.c.r; j = j.next;
      } else {
        if (intersects(k.c, c.c)) { a = k; a.next = b; b.prev = a; --i; continue pack; }
        sk += k.c.r; k = k.prev;
      }
    } while (j !== k.next);
    // Sem interseção: insere c entre a e b e procura o par mais próximo do centroide.
    c.prev = a; c.next = b; a.next = b.prev = b = c;
    let best = score(a), cur = c;
    while ((cur = cur.next) !== b) {
      const s = score(cur);
      if (s < best) { a = cur; best = s; }
    }
    b = a.next;
  }
  center(circles);
  return enclose(circles);
}

// Centraliza pela caixa delimitadora (mais barato que o círculo mínimo e visualmente equivalente).
function center(circles) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of circles) {
    x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r);
    y0 = Math.min(y0, c.y - c.r); y1 = Math.max(y1, c.y + c.r);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (const c of circles) { c.x -= cx; c.y -= cy; }
}

function enclose(circles) {
  let r = 0;
  for (const c of circles) r = Math.max(r, Math.hypot(c.x, c.y) + c.r);
  return r;
}

// Empacota e escala os círculos para caber em w × h; x e y ficam em coordenadas do retângulo.
export function layout(circles, w, h, pad = 6) {
  if (!circles.length) return;
  packSiblings(circles);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of circles) {
    x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r);
    y0 = Math.min(y0, c.y - c.r); y1 = Math.max(y1, c.y + c.r);
  }
  const k = Math.min((w - 2 * pad) / (x1 - x0 || 1), (h - 2 * pad) / (y1 - y0 || 1));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (const c of circles) { c.x = w / 2 + (c.x - cx) * k; c.y = h / 2 + (c.y - cy) * k; c.r *= k; }
}

// ---- Mapa de bolhas do Disk Map ----------------------------------------------------------------------------
// Raio por raiz quadrada do tamanho, comprimido entre rMin e rMax: r = rMin + (rMax − rMin)·sqrt(size/maxSize).
// O fator `f` escala os dois extremos juntos; a folga entre bolhas (gap) e a margem (pad) ficam fixas em pixels.

// Gerador determinístico (a mesma pasta sempre produz o mesmo desenho).
function lcg(seed) {
  let x = seed >>> 0;
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// Cópias dos círculos com raio inflado em gap/2: dois círculos encostados no empacotamento ficam a `gap` de distância.
function packWith(radii, order, gap) {
  const cs = order.map((i) => ({ i, r: radii[i] + gap / 2 }));
  packSiblings(cs);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cs) {
    x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r);
    y0 = Math.min(y0, c.y - c.r); y1 = Math.max(y1, c.y + c.r);
  }
  return { cs, w: x1 - x0 - gap, h: y1 - y0 - gap, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

// Ordens de inserção candidatas: o empacotamento muda de forma conforme a ordem, e algumas ficam bem mais compactas.
function orders(n) {
  const desc = Array.from({ length: n }, (_, i) => i);
  const out = [desc];
  if (n > 2) {
    out.push([1, 0, ...desc.slice(2)]);
    const alt = [];
    for (let a = 0, b = n - 1; a <= b; a++, b--) { alt.push(a); if (a !== b) alt.push(b); }
    out.push(alt);
    const mid = [];
    for (let i = 0; i < n; i += 2) mid.push(i);
    for (let i = 1; i < n; i += 2) mid.push(i);
    out.push(mid);
  }
  const rnd = lcg(7919 * n + 13);
  for (let k = 0; k < 70 && n > 3; k++) {
    const o = desc.slice();
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
    out.push(o);
  }
  return out;
}

// Define x, y, r em cada item ({ size }, já em ordem decrescente) dentro de w × h. Devolve o fator de escala usado
// e se coube na escala mínima. opts: gap, pad, rMin, rMax, fMax (escala máxima), fMin.
export function fitBubbles(items, w, h, opts = {}) {
  const { gap = 10, pad = 6, rMin = 46, rMax = 120, fMax = 1.25, fMin = 0.3, tCap = 1 } = opts;
  const n = items.length;
  if (!n) return { f: 1, fits: true };
  const maxSize = Math.max(...items.map((i) => i.size), 1);
  const t = items.map((i) => Math.min(tCap, Math.sqrt(Math.max(0, i.size) / maxSize)));
  const radiiAt = (f) => t.map((u) => f * (rMin + (rMax - rMin) * u));
  const availW = w - 2 * pad, availH = h - 2 * pad;
  const ords = orders(n);
  // Melhor empacotamento para o fator f: o que ocupa a menor caixa em relação à área disponível.
  const bestAt = (f) => {
    const radii = radiiAt(f);
    let best = null;
    for (const o of ords) {
      const p = packWith(radii, o, gap);
      const fitK = Math.max(p.w / availW, p.h / availH);
      if (!best || fitK < best.fitK) best = { p, fitK, radii };
    }
    return best;
  };
  let lo = fMin, hi = fMax, pick = null;
  const top = bestAt(hi);
  if (top.fitK <= 1) { lo = hi; pick = top; } else {
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2, b = bestAt(mid);
      if (b.fitK <= 1) { lo = mid; pick = b; } else hi = mid;
    }
  }
  if (!pick) pick = bestAt(lo);
  const fits = pick.fitK <= 1 + 1e-9;
  for (const c of pick.p.cs) {
    const it = items[c.i];
    it.r = pick.radii[c.i];
    it.x = w / 2 + (c.x - pick.p.cx);
    it.y = h / 2 + (c.y - pick.p.cy);
  }
  return { f: lo, fits };
}
