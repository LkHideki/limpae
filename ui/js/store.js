// State shared between modules. Selection lives on the client; only selected ids go to `remove`.
export const store = {
  rev: 0,            // increments when data changes outside Sweep (invalidates its results)
  busy: false,
  disk: null,
  junk: null, junkSel: new Set(),
  trash: null, trashSel: new Set(), trashSelRef: null,   // trashSel = items marked for emptying (all, by default)
  apps: null,
  large: null, largeMb: 500, largeSel: new Set(),
  smart: { phase: 'idle', rev: 0, tiles: {}, freed: {}, trashed: {}, mods: [], inc: {}, sum: {}, snap: {}, out: {}, apps: null, stopped: false },
  cleanup: { phase: 'idle', freed: 0, failed: 0 },
  trashUi: { phase: 'idle', freed: 0 },
  files: { phase: 'idle', moved: 0 },
  filesFrom: null,   // duplicates result in Downloads handed over by Sweep (review in Files)
  icons: new Map(),
  settings: null,
  openSection: null,   // section hint for the destination module (Toolbox); the module may read and clear it
};

export const bump = () => { store.rev++; };

export const selectedIds = (result) => new Set(result.groups.flatMap((g) => g.items.filter((i) => i.selected).map((i) => i.id)));

export function selectedSize(result, sel) {
  let n = 0, c = 0;
  if (result) for (const g of result.groups) for (const i of g.items) if (sel.has(i.id)) { n += i.size; c++; }
  return { bytes: n, count: c };
}

export function pruneResult(result, okIds) {
  const groups = [];
  let total = 0;
  for (const g of result.groups) {
    const items = g.items.filter((i) => !okIds.has(i.id));
    if (!items.length) continue;
    const t = items.reduce((a, i) => a + i.size, 0);
    total += t;
    groups.push({ ...g, items, total: t });
  }
  return { ...result, groups, total };
}

export const countItems = (result) => (result ? result.groups.reduce((a, g) => a + g.items.length, 0) : 0);
