// Remoção em lotes por grupo (para mostrar progresso), consolidando falhas por item.
import { api } from './api.js';

export function outcomesToFailures(outcomes, byId) {
  return outcomes.filter((o) => !o.ok).map((o) => {
    const it = byId.get(o.id);
    return { id: o.id, name: it ? it.name : `Item ${o.id}`, path: it ? it.path : '', error: o.error };
  });
}

// onGroup(group, status, info) com status: run | done | fail
export async function removeGroups(result, sel, onGroup = () => {}) {
  const okIds = new Set();
  const failures = [];
  let freed = 0, done = 0;
  const groups = result.groups.filter((g) => g.items.some((i) => sel.has(i.id)));
  for (const g of groups) {
    const items = g.items.filter((i) => sel.has(i.id));
    const byId = new Map(items.map((i) => [i.id, i]));
    onGroup(g, 'run', { done, total: groups.length });
    try {
      const res = await api.remove(items.map((i) => i.id));
      let gFreed = 0;
      for (const o of res.outcomes) if (o.ok) { okIds.add(o.id); gFreed += o.freed || 0; }
      const bad = outcomesToFailures(res.outcomes, byId);
      failures.push(...bad);
      freed += gFreed;
      done++;
      onGroup(g, bad.length === items.length ? 'fail' : 'done', { freed: gFreed, done, total: groups.length, failed: bad.length });
    } catch (e) {
      failures.push(...items.map((i) => ({ id: i.id, name: i.name, path: i.path, error: e.message })));
      done++;
      onGroup(g, 'fail', { freed: 0, done, total: groups.length, failed: items.length });
    }
  }
  return { okIds, failures, freed };
}
