import { test, expect } from '@playwright/test';
import { DICT } from '../../ui/js/i18n/dict/index.js';
import { boot, calls } from './mock.mjs';

const en = (key, p = {}) => (DICT[key]?.en ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));
const nav = (page, key) => page.locator('#nav').getByRole('button', { name: en(key), exact: true });

// A fake panel: asking for the item it shows closes it, another item swaps it (the backend does this for real).
const QL = `
  quick_look: ({ id }) => { window.__ql = window.__ql === 'i' + id ? null : 'i' + id; return window.__ql !== null; },
  lens_quicklook: ({ nodeId }) => { window.__ql = window.__ql === 'n' + nodeId ? null : 'n' + nodeId; return window.__ql !== null; },
  quick_look_close: () => { window.__ql = null; },`;

const item = (id, name, size = 1000) => `{ id: ${id}, name: '${name}', path: '/Users/u/Library/Caches/${name}', size: ${size}, selected: false, note: null, modified: null, trash: false, accessed: null }`;
const JUNK = `{ ${QL}
  scan_junk: () => ({ total: 3000, needsFda: false, groups: [{ id: 'user_caches', title: 'Caches de apps', description: '', total: 3000, items: [${item(1, 'com.alpha', 2000)}, ${item(2, 'com.beta')}] }] }),
}`;

async function openJunkReview(page) {
  await boot(page, JUNK);
  await nav(page, 'Entulho').click();
  await page.locator('#dock .go').click();
  await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
  await expect(page.locator('.rv-item')).toHaveCount(2);
}

const ql = (page, cmd = 'quick_look') => calls(page, cmd).then((c) => c.map((x) => x.args));

test.describe('Quick Look with Space', () => {
  test('review: Space on the focused row toggles the preview of that row', async ({ page }) => {
    await openJunkReview(page);
    const row = page.locator('.rv-item').first();
    await row.locator('.rv-name').click(); // selects the row and leaves focus on the row itself
    await expect(row).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(() => ql(page)).toEqual([{ id: 1 }]);
    await page.keyboard.press('Space'); // the backend closes the panel, as in Finder
    await expect.poll(() => ql(page)).toEqual([{ id: 1 }, { id: 1 }]);
    await page.locator('.rv-item').nth(1).locator('.rv-name').click();
    await page.keyboard.press('Space'); // another row swaps the item
    await expect.poll(() => ql(page)).toEqual([{ id: 1 }, { id: 1 }, { id: 2 }]);
  });

  test('review: a held Space does not repeat the toggle', async ({ page }) => {
    await openJunkReview(page);
    await page.locator('.rv-item').first().locator('.rv-name').click();
    await page.keyboard.down('Space');
    await page.keyboard.down('Space'); // auto-repeat
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await expect.poll(() => ql(page)).toEqual([{ id: 1 }]);
  });

  test('review: Space keeps its own meaning on a checkbox, a button and the search field', async ({ page }) => {
    await openJunkReview(page);
    const cb = page.getByRole('checkbox', { name: en('Selecionar {name}', { name: 'com.alpha' }) });
    await cb.focus();
    await page.keyboard.press('Space');
    await expect(cb).toHaveAttribute('aria-checked', 'true');
    const reveal = page.locator('.rv-item').first().locator('.rv-act').first();
    await reveal.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => calls(page, 'reveal').then((c) => c.length)).toBe(1);
    const search = page.locator('.search input');
    await search.focus();
    await page.keyboard.type('a b');
    await expect(search).toHaveValue('a b');
    expect(await ql(page)).toEqual([]);
  });

  test('review: Space with a modifier does nothing', async ({ page }) => {
    await openJunkReview(page);
    await page.locator('.rv-item').first().locator('.rv-name').click();
    await page.keyboard.press('Shift+Space');
    await page.keyboard.press('Meta+Space');
    expect(await ql(page)).toEqual([]);
  });

  test('Esc closes an open preview first; the next Esc leaves the screen as before', async ({ page }) => {
    await openJunkReview(page);
    await page.locator('.rv-item').first().locator('.rv-name').click();
    await page.keyboard.press('Space');
    await expect.poll(() => ql(page)).toEqual([{ id: 1 }]);
    await page.keyboard.press('Escape');
    await expect.poll(() => ql(page, 'quick_look_close').then((c) => c.length)).toBe(1);
    await expect(page.locator('.rv-item')).toHaveCount(2); // still in the review
    await page.keyboard.press('Escape');
    await expect(page.locator('.rv-item')).toHaveCount(0); // back
    expect(await ql(page, 'quick_look_close')).toHaveLength(1);
  });

  test('Esc ignores the preview once the backend reported it closed', async ({ page }) => {
    await openJunkReview(page);
    await page.locator('.rv-item').first().locator('.rv-name').click();
    await page.keyboard.press('Space');
    await expect.poll(() => ql(page)).toEqual([{ id: 1 }]);
    await page.evaluate(() => window.__ev.quicklook({ payload: false })); // closed from inside the panel
    await page.keyboard.press('Escape');
    await expect(page.locator('.rv-item')).toHaveCount(0);
    expect(await ql(page, 'quick_look_close')).toHaveLength(0);
  });

  test('the context menu entry and Space share the same toggle', async ({ page }) => {
    await openJunkReview(page);
    await page.locator('.rv-item').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: en('Visualização Rápida') }).click();
    await expect.poll(() => ql(page)).toEqual([{ id: 1 }]);
    await page.keyboard.press('Escape'); // an open preview owns Esc
    await expect.poll(() => ql(page, 'quick_look_close').then((c) => c.length)).toBe(1);
  });

  test('Files: Space previews the focused row, not a checkbox', async ({ page }) => {
    const empty = '({ groups: [], total: 0, needsFda: false })';
    await boot(page, `{ ${QL}
      scan_large_at: () => ({ total: 3000, needsFda: false, groups: [{ id: 'large', title: 'Arquivos grandes', description: '', total: 3000, items: [${item(7, 'big.mov', 2000)}, ${item(8, 'other.zip')}] }] }),
      scan_downloads: () => ${empty}, scan_duplicates: () => ${empty}, scan_similar: () => ${empty} }`);
    await nav(page, 'Arquivos').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('.fl-tiles')).toBeVisible({ timeout: 8000 });
    await page.locator('.fl-tile[data-cat="large"] .btn').click();
    const row = page.locator('.fm-row').first();
    await expect(row).toBeVisible();
    const cb = row.getByRole('checkbox');
    await cb.focus();
    await page.keyboard.press('Space');
    expect(await ql(page)).toEqual([]);
    const name = await row.locator('.fm-name').first().innerText();
    await page.locator('.fm-row', { hasText: name }).locator('.fm-name').first().click(); // selecting re-renders the list
    const focused = page.locator('.fm-row:focus');
    await expect(focused).toHaveCount(1); // focus came back to the row after the re-render
    await page.keyboard.press('Space');
    await expect.poll(() => ql(page)).toHaveLength(1);
    const id = (await ql(page))[0].id;
    expect([7, 8]).toContain(id);
    await page.keyboard.press('Space');
    await expect.poll(() => ql(page)).toHaveLength(2);
  });

  const FILES = `{ ${QL}
      scan_large_at: () => ({ total: 3000, needsFda: false, groups: [{ id: 'large', title: 'Arquivos grandes', description: '', total: 3000, items: [${item(7, 'big.mov', 2000)}, ${item(8, 'other.zip')}] }] }),
      scan_downloads: () => ({ groups: [], total: 0, needsFda: false }), scan_duplicates: () => ({ groups: [], total: 0, needsFda: false }), scan_similar: () => ({ groups: [], total: 0, needsFda: false }) }`;
  async function openLarge(page) {
    await boot(page, FILES);
    await nav(page, 'Arquivos').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('.fl-tiles')).toBeVisible({ timeout: 8000 });
    await page.locator('.fl-tile[data-cat="large"] .btn').click();
    await expect(page.locator('.fm-row').first()).toBeVisible();
  }

  test('Files: the context menu entry previews the row (menus.js helper)', async ({ page }) => {
    await openLarge(page);
    await page.locator('.fm-row').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: en('Visualização Rápida') }).click();
    await expect.poll(() => ql(page)).toHaveLength(1);
  });

  test('keyboard only: Tab reaches the row itself and Space previews it', async ({ page }) => {
    await openLarge(page);
    await page.locator('.fm-row').first().getByRole('checkbox').focus();
    await page.keyboard.press('Shift+Tab'); // back to the row that contains the checkbox
    await expect(page.locator('.fm-row:focus')).toHaveCount(1);
    await page.keyboard.press('Space');
    await expect.poll(() => ql(page)).toHaveLength(1);
  });

  const node = (id, name, extra = {}) => ({ id, parent: 1, name, path: '/Users/u/' + name, size: 5e6, isDir: false, kind: 'file', items: 0, selectable: true, drillable: false, ...extra });
  const LENS = `{ ${QL}
    lens_roots: () => [{ index: 0, path: '/', root: null, isVolume: true, total: 1e9, used: 5e8, name: 'Mac' }],
    lens_scan: () => ({ root: ${JSON.stringify(node(1, 'Mac', { parent: null, isDir: true, kind: 'dir', items: 3, drillable: true }))}, nodes: 4, treeBytes: 100, volumeTotal: 1e9, volumeUsed: 5e8 }),
    lens_children: ({ nodeId }) => ({ node: ${JSON.stringify(node(1, 'Mac', { parent: null, isDir: true, kind: 'dir', items: 3, drillable: true }))}, crumbs: [{ id: 1, name: 'Mac' }],
      children: ${JSON.stringify([node(2, 'movie.mov', { size: 9e6 }), node(3, 'Projects', { isDir: true, kind: 'dir', items: 5, drillable: true, size: 7e6 }), node(4, 'Arquivos pequenos', { kind: 'small', selectable: false, size: 2e6 })])} }),
  }`;

  async function openLens(page) {
    await boot(page, LENS);
    await nav(page, 'Mapa do Disco').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('.ln-row[data-id="2"]')).toBeVisible({ timeout: 8000 });
  }

  test('Disk Map: Space previews the focused row; Shift+Space selects; the small-files row still selects', async ({ page }) => {
    await openLens(page);
    const file = page.locator('.ln-row[data-id="2"]');
    await file.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => ql(page, 'lens_quicklook')).toEqual([{ nodeId: 2 }]);
    await expect(file.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Shift+Space');
    await expect(file.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    expect(await ql(page, 'lens_quicklook')).toHaveLength(1);
    const folder = page.locator('.ln-row[data-id="3"]');
    await folder.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => ql(page, 'lens_quicklook')).toEqual([{ nodeId: 2 }, { nodeId: 3 }]);
    // Nothing to preview for the synthetic small-files node: Space keeps selecting it, as before.
    const small = page.locator('.ln-row[data-id="4"]');
    await small.focus();
    await page.keyboard.press('Space');
    expect(await ql(page, 'lens_quicklook')).toHaveLength(2);
  });

  test('Disk Map: Space on the row checkbox selects instead of previewing', async ({ page }) => {
    await openLens(page);
    const cb = page.locator('.ln-row[data-id="2"]').getByRole('checkbox');
    await cb.focus();
    await page.keyboard.press('Space');
    await expect(cb).toHaveAttribute('aria-checked', 'true');
    expect(await ql(page, 'lens_quicklook')).toEqual([]);
  });
});
