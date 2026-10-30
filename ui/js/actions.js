// Remoção em lotes por grupo (para mostrar progresso), consolidando falhas por item.
import { api } from './api.js';

export function outcomesToFailures(outcomes, byId) {
  return outcomes.filter((o) => !o.ok).map((o) => {
    const it = byId.get(o.id);
    return { id: o.id, name: it ? it.name : `Item ${o.id}`, path: it ? it.path : '', error: o.error };
  });
}

// onGroup(group, status, info) com status: run | done | fail.
// opts.permanent: apaga em vez de mandar ao Lixo; opts.stopped(): interrompe entre grupos (o backend também
// interrompe entre itens via cancel_scan).
export async function removeGroups(result, sel, onGroup = () => {}, opts = {}) {
  const okIds = new Set();
  const failures = [];
  let freed = 0, done = 0;
  const groups = result.groups.filter((g) => g.items.some((i) => sel.has(i.id)));
  for (const g of groups) {
    const items = g.items.filter((i) => sel.has(i.id));
    if (opts.stopped && opts.stopped()) {
      failures.push(...items.map((i) => ({ id: i.id, name: i.name, path: i.path, error: 'cancelado; o item continua no lugar' })));
      onGroup(g, 'fail', { freed: 0, done, total: groups.length, failed: items.length });
      continue;
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    onGroup(g, 'run', { done, total: groups.length });
    try {
      const res = await api.remove(items.map((i) => i.id), !!opts.permanent);
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

// Botão redondo "Parar" com o anel de progresso durante uma remoção: progress(p) atualiza o anel e
// stopped() diz se o usuário parou (o backend também para entre itens via cancel_scan).
export function stopDock(ctx, mod) {
  let stop = false, last = 0;
  const paint = () => ctx.setDock({ label: stop ? 'Parando' : 'Parar', busy: true, progress: last, mod, disabled: stop,
    onClick: () => { if (stop) return; stop = true; api.cancel().catch(() => {}); paint(); } });
  paint();
  return { progress: (p) => { last = p; paint(); }, stopped: () => stop };
}
