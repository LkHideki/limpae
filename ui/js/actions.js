// Batch removal by group (to show progress), consolidating failures per item.
import { api } from './api.js';
import { t } from './i18n.js';

// What a user Stop left in place is not a failure: the result sound and the failures sheet skip it.
// Matches the backend's untranslated text (remove.rs CANCELLED) and the views' translated one.
export function realFailures(failures) {
  const cancelled = new Set([
    'cancelado; o item continua no lugar', // i18n-ignore: the backend's text, before translation
    t('cancelado; o item continua no lugar'), t('cancelado; o app continua instalado'),
  ]);
  return failures.filter((f) => !cancelled.has(f.error));
}

export function outcomesToFailures(outcomes, byId) {
  return outcomes.filter((o) => !o.ok).map((o) => {
    const it = byId.get(o.id);
    return { id: o.id, name: it ? it.name : t('Item {id}', { id: o.id }), path: it ? it.path : '', error: o.error };
  });
}

// onGroup(group, status, info) with status: run | done | fail.
// info.freed = bytes handled in the group (freed + sent to Trash); info.trashed = the part that only went to Trash.
// opts.permanent: deletes instead of sending to Trash; opts.stopped(): stops between groups (the backend also
// stops between items via cancel_scan).
// Result: `freed` = bytes actually freed (deleted for good); `trashed` = bytes that only went to Trash
// (the space returns once Trash is emptied); `handled` = both combined. The per-item result does not say what
// happened: it is derived from the item's `trash` flag and the "Delete permanently" choice.
export async function removeGroups(result, sel, onGroup = () => {}, opts = {}) {
  const okIds = new Set();
  const failures = [];
  let freed = 0, trashed = 0, done = 0;
  const groups = result.groups.filter((g) => g.items.some((i) => sel.has(i.id)));
  for (const g of groups) {
    const items = g.items.filter((i) => sel.has(i.id));
    if (opts.stopped && opts.stopped()) {
      failures.push(...items.map((i) => ({ id: i.id, name: i.name, path: i.path, error: 'cancelado; o item continua no lugar' /* i18n-ignore: key of tr() in failuresSheet */ })));
      onGroup(g, 'fail', { freed: 0, trashed: 0, done, total: groups.length, failed: items.length });
      continue;
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    onGroup(g, 'run', { done, total: groups.length });
    try {
      const res = await api.remove(items.map((i) => i.id), !!opts.permanent);
      let gFreed = 0, gTrashed = 0;
      for (const o of res.outcomes) {
        if (!o.ok) continue;
        okIds.add(o.id);
        const it = byId.get(o.id);
        if (it && it.trash && !opts.permanent) gTrashed += o.freed || 0; else gFreed += o.freed || 0;
      }
      const bad = outcomesToFailures(res.outcomes, byId);
      failures.push(...bad);
      freed += gFreed;
      trashed += gTrashed;
      done++;
      onGroup(g, bad.length === items.length ? 'fail' : 'done', { freed: gFreed + gTrashed, trashed: gTrashed, done, total: groups.length, failed: bad.length });
    } catch (e) {
      failures.push(...items.map((i) => ({ id: i.id, name: i.name, path: i.path, error: e.message })));
      done++;
      onGroup(g, 'fail', { freed: 0, trashed: 0, done, total: groups.length, failed: items.length });
    }
  }
  return { okIds, failures, freed, trashed, handled: freed + trashed };
}

// Round "Stop" button with the progress ring during a removal: progress(p) updates the ring and
// stopped() tells whether the user stopped (the backend also stops between items via cancel_scan).
// The ring spins (indeterminate) until a real intermediate step arrives: a one-step removal would otherwise show an
// empty static arc for its whole duration.
export function stopDock(ctx, mod) {
  let stop = false, last = null;
  const paint = () => ctx.setDock({ label: stop ? t('Parando') : t('Parar'), busy: true, progress: last, mod, disabled: stop,
    onClick: () => { if (stop) return; stop = true; api.cancel().catch(() => {}); paint(); } });
  paint();
  return { progress: (p) => { if (p > 0 && (p < 1 || last != null)) last = p; paint(); }, stopped: () => stop };
}
