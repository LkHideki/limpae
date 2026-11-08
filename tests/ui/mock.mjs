// A fake `window.__TAURI__` installed before the app loads. Every invoke is recorded in `window.__calls`;
// `handlers` (JS source of an object literal of functions, evaluated in the page) override the defaults.
export async function boot(page, handlers = '{}', { storage = {} } = {}) {
  await page.addInitScript(({ handlers, storage }) => {
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    const calls = [];
    window.__calls = calls;
    const settings = { ignored: [], smartCare: {}, menuBar: false, notifyTrashGb: null, notifyLowDiskGb: null, sounds: false, permanentDelete: false, lastSmartCare: null, language: 'en' };
    const defaults = {
      get_settings: () => settings,
      set_settings: () => null,
      disk_overview: () => ({ total: 500e9, free: 120e9, used: 380e9, fda: true }),
      list_ignored: () => [],
      trash_history: () => [],
      health: () => ({ score: 90, level: 'Excelente', model: 'MacBook Pro', diskTotal: 500e9, diskFree: 120e9, factors: [] }),
      activity: () => ({ totalFreed: 0, monthFreed: 0, items: 0, lastCleanup: null, days: [] }),
    };
    // eslint-disable-next-line no-new-func
    const custom = new Function('return (' + handlers + ')')();
    window.__TAURI__ = {
      core: {
        invoke(cmd, args) {
          calls.push({ cmd, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) });
          const f = custom[cmd] || defaults[cmd];
          if (!f) return Promise.resolve(null);
          try { return Promise.resolve(f(args, calls)); } catch (e) { return Promise.reject(e); }
        },
      },
      // Handlers are kept in `window.__ev` so a test can emit a shell event (e.g. the menu bar's `navigate`).
      event: { listen: (name, cb) => { (window.__ev = window.__ev || {})[name] = cb; return Promise.resolve(() => {}); } },
    };
  }, { handlers, storage });
  await page.goto('/index.html');
  await page.locator('#nav .nav-item').first().waitFor();
}

export const calls = (page, cmd) => page.evaluate((c) => window.__calls.filter((x) => x.cmd === c), cmd);
