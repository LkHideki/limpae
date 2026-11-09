// Native NSMenu popups through the Tauri menu API (window.__TAURI__.menu). `nativeMenuApi()` is null in a browser
// preview or a test mock without the API; the callers then fall back to the HTML menu in views/review.js.
import { play } from './sound.js';

export function nativeMenuApi() {
  const T = window.__TAURI__;
  const m = T && T.menu;
  return m && m.Menu && m.MenuItem && m.CheckMenuItem && m.PredefinedMenuItem ? m : null;
}

// The Rust side keeps one resource per item and per menu until it is closed. A click may be reported just after
// popup() settles, so the release waits a little.
const RELEASE_MS = 2000;

// items: same shape as openMenu in views/review.js ({ label, checked?, disabled?, selects?, onSelect } | { sep: true }).
// `at` = { x, y } in viewport coordinates (the webview fills the window, so they are window coordinates too).
// Resolves when the menu is dismissed; rejects when it could not be shown (the caller then falls back).
export async function popupNative(api, { items, at }) {
  const made = [];
  try {
    for (const it of items) {
      if (it.sep) { made.push(await api.PredefinedMenuItem.new({ item: 'Separator' })); continue; }
      // A "Select/Deselect" item keeps the sound of the checkbox it toggles; other items stay silent (no HTML tick).
      const action = () => { if (it.selects) play(it.selects === 'on' ? 'tick' : 'untick'); it.onSelect(); };
      const text = String(it.label);
      made.push(it.checked != null
        ? await api.CheckMenuItem.new({ text, checked: !!it.checked, enabled: !it.disabled, action })
        : await api.MenuItem.new({ text, enabled: !it.disabled, action }));
    }
    const menu = await api.Menu.new({ items: [...made] });
    made.push(menu); // released with the items
    const dpi = window.__TAURI__.dpi;
    // Without a position the menu opens at the cursor.
    const pos = at && dpi && dpi.LogicalPosition ? new dpi.LogicalPosition(Math.round(at.x), Math.round(at.y)) : undefined;
    await menu.popup(pos);
  } finally {
    setTimeout(() => { for (const r of made) { try { Promise.resolve(r.close()).catch(() => {}); } catch (e) { /* ignore */ } } }, RELEASE_MS);
  }
}
