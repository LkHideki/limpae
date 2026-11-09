import { play } from './sound.js';
import { tr } from './i18n.js';
// Thin layer over window.__TAURI__ (withGlobalTauri). Backend errors arrive as a rejected string.
const T = () => window.__TAURI__;
const subs = new Set();
let hooked = false;
let notifier = () => {};
let cancelRequested = false;

export const setNotifier = (fn) => { notifier = fn; };

// Undo: removals that sent items to the Trash return a batch id per item. Batches from removals that follow each
// other (a Sweep removes group by group) are gathered and offered as one "Undo" once the burst ends. The burst stays
// open while any removal is in flight: the 900 ms timer is armed only when the last one settles, so a group that
// takes longer than that to remove does not split the operation into several toasts.
let undoNotifier = () => {};
let undoBatches = new Set(), undoCount = 0, undoTimer = null, undoInflight = 0;
export const setUndoNotifier = (fn) => { undoNotifier = fn; };
function armUndo() {
  clearTimeout(undoTimer);
  if (undoInflight || !undoBatches.size) return;
  undoTimer = setTimeout(() => { const b = [...undoBatches], n = undoCount; undoBatches = new Set(); undoCount = 0; undoNotifier(b, n); }, 900);
}
function withUndo(p) {
  undoInflight++;
  clearTimeout(undoTimer);
  return p.then((res) => {
    undoInflight--;
    for (const o of (res && res.outcomes) || []) if (o.ok && o.undo) { undoBatches.add(o.undo); undoCount++; }
    armUndo();
    return res;
  }, (e) => { undoInflight--; armUndo(); throw e; });
}

export function onProgress(cb) {
  if (!hooked) {
    hooked = true;
    Promise.resolve(T().event.listen('scan-progress', (e) => subs.forEach((f) => f(e.payload)))).catch(() => {});
  }
  subs.add(cb);
  return () => subs.delete(cb);
}

export async function call(name, args, opts = {}) {
  if (name === 'cancel_scan') cancelRequested = true; else if (!opts.quiet) cancelRequested = false;
  try {
    return await T().core.invoke(name, args);
  } catch (e) {
    const msg = tr(typeof e === 'string' ? e : (e && e.message) || 'Erro inesperado');
    const show = !opts.quiet && !cancelRequested;
    if (show) notifier(msg);
    const err = new Error(msg);
    err.reported = show || cancelRequested;
    throw err;
  }
}

export const api = {
  disk: () => call('disk_overview', undefined, { quiet: true }),
  junk: () => call('scan_junk'),
  trash: () => call('scan_trash'),
  large: (minMb) => call('scan_large', { minMb }),
  apps: () => call('list_apps'),
  icon: (appId) => call('app_icon', { appId }, { quiet: true }),
  leftovers: (appId) => call('app_leftovers', { appId }),
  remove: (ids, permanent = false) => withUndo(call('remove', { ids, permanent })),
  uninstall: (appId, leftoverIds, permanent = false) => withUndo(call('uninstall', { appId, leftoverIds, permanent })),
  trashHistory: () => call('trash_history', undefined, { quiet: true }),
  restoreTrashed: (batches) => call('restore_trashed', { batches }),
  simulate: (ids, permanent = false) => call('simulate_removal', { ids, permanent }),
  revealReport: (path) => call('reveal_report', { path }),
  cancel: () => { play('stop'); return call('cancel_scan', undefined, { quiet: true }); },
  reveal: (id) => call('reveal', { id }),
  openApp: (appId) => call('open_app', { appId }),
  downloadDups: () => call('scan_download_dups'),
  revealLog: () => call('reveal_log'),
  openFda: () => call('open_fda_settings'),
  settings: () => call('get_settings', undefined, { quiet: true }),
  saveSettings: (settings) => call('set_settings', { settings }),
  ignore: (id) => call('ignore_item', { id }),
  ignored: () => call('list_ignored', undefined, { quiet: true }),
  unignore: (path) => call('unignore', { path }),
  ignoreFolder: (prompt) => call('ignore_folder', { prompt }),
  quickLook: (id) => call('quick_look', { id }),
  clutterLocations: () => call('clutter_locations', undefined, { quiet: true }),
  duplicates: (location) => call('scan_duplicates', { location }),
  similar: (location) => call('scan_similar', { location }),
  downloads: () => call('scan_downloads'),
  largeAt: (location, minMb) => call('scan_large_at', { location, minMb }),
  thumb: (id) => call('thumb', { id }, { quiet: true }),
  appsOverview: () => call('apps_overview'),
  appMeta: () => call('app_meta', undefined, { quiet: true }),
  openUpdate: (appId) => call('open_update', { appId }),
  lensRoots: () => call('lens_roots'),
  lensScan: (root) => call('lens_scan', { root }),
  lensChildren: (nodeId) => call('lens_children', { nodeId }),
  lensReview: (nodeIds) => call('lens_select_review', { nodeIds }),
  cloudScan: () => call('cloud_scan'),
  cloudEvict: (ids) => call('cloud_evict', { ids }),
  cloudOptimizeStatus: () => call('cloud_optimize_status', undefined, { quiet: true }),
  securityChecks: () => call('security_checks'),
  openSecurityFix: (checkId) => call('open_security_fix', { checkId }),
  tccPermissions: () => call('tcc_permissions'),
  tccRevoke: (ids) => call('tcc_revoke', { ids }),
  privacyScan: () => call('privacy_scan'),
  privacyRemove: (ids, permanent = false) => withUndo(call('privacy_remove', { ids, permanent })),
  perfScan: () => call('perf_scan'),
  perfMonitor: () => call('perf_monitor', undefined, { quiet: true }),
  perfIcon: (id) => call('perf_icon', { id }, { quiet: true }),
  agentToggle: (id, enable) => call('agent_toggle', { id, enable }),
  agentRemove: (ids) => call('agent_remove', { ids }),
  loginItemRemove: (ids) => call('login_item_remove', { ids }),
  tmThin: () => call('tm_thin'),
  lensIcon: (nodeId) => call('lens_icon', { nodeId }, { quiet: true }),
  lensReveal: (nodeId) => call('lens_reveal', { nodeId }),
  lensQuicklook: (nodeId) => call('lens_quicklook', { nodeId }),
  markSmartCare: () => call('mark_smart_care', undefined, { quiet: true }),
};
