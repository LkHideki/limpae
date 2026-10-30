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
