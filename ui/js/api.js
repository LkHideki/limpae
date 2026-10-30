// Camada fina sobre window.__TAURI__ (withGlobalTauri). Erros do backend chegam como string rejeitada.
const T = () => window.__TAURI__;
const subs = new Set();
let hooked = false;
let notifier = () => {};
let cancelRequested = false;

export const setNotifier = (fn) => { notifier = fn; };

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
    const msg = typeof e === 'string' ? e : (e && e.message) || 'Erro inesperado';
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
  remove: (ids) => call('remove', { ids }),
  uninstall: (appId, leftoverIds) => call('uninstall', { appId, leftoverIds }),
  cancel: () => call('cancel_scan', undefined, { quiet: true }),
  reveal: (id) => call('reveal', { id }),
  revealLog: () => call('reveal_log'),
  openFda: () => call('open_fda_settings'),
  settings: () => call('get_settings', undefined, { quiet: true }),
  saveSettings: (settings) => call('set_settings', { settings }),
  ignore: (id) => call('ignore_item', { id }),
  ignored: () => call('list_ignored', undefined, { quiet: true }),
  unignore: (path) => call('unignore', { path }),
  quickLook: (id) => call('quick_look', { id }),
};
