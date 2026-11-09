// Quick Look from the UI, like Finder. The backend owns a native panel (QLPreviewPanel); this module
//  - calls the registry-id commands (the UI never sends a path),
//  - makes Space on a row preview it, and Esc close the panel before anything else reacts to it.
// Space rule: only when the row ITSELF has focus (event target === row). A focused button, checkbox or text field
// is never the row, so Space keeps its native meaning there (toggle the checkbox, press the button, type a space).
// Rows get tabindex 0 so a keyboard-only user can Tab to the row itself (the checkbox and buttons inside it are
// separate stops); the focus survives re-renders through their data-fk.
import { api } from './api.js';

// Whether the panel is on screen; the backend answers every toggle and reports closes it did not start.
let shown = false;
const set = (v) => { shown = v === true; };

try {
  Promise.resolve(window.__TAURI__.event.listen('quicklook', (e) => set(e.payload))).catch(() => {});
} catch (e) { /* no shell events (browser preview) */ }

// Both resolve once the backend answered; errors were already shown as a toast.
export const quickLook = (id) => api.quickLook(id).then(set, () => {});
export const lensQuickLook = (nodeId) => api.lensQuicklook(nodeId).then(set, () => {});

const rows = new WeakMap();

// Makes `row` previewable with Space. run() starts the preview (one of the helpers above).
export function quickLookRow(row, run) {
  rows.set(row, run);
  if (!row.hasAttribute('tabindex')) row.tabIndex = 0;
  return row;
}

const plain = (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;

document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.defaultPrevented || !plain(e) || !(e.target instanceof Element)) return;
  const run = rows.get(e.target);
  if (!run) return;
  e.preventDefault(); // no page scroll
  if (!e.repeat) run(); // a held key must not flicker the panel
}, false);

// Capture phase and stopImmediatePropagation: one Esc closes only the panel, not also the open menu, dialog or screen.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !shown || !plain(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  shown = false;
  api.quickLookClose().catch(() => {});
}, true);
