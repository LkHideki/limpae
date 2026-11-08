import { test, expect } from '@playwright/test';
import { DICT } from '../../ui/js/i18n/dict/index.js';
import { boot, calls } from './mock.mjs';

// English text of a Portuguese key (the UI's source language), with {params} filled in.
const en = (key, p = {}) => (DICT[key]?.en ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));

const nav = (page, key) => page.locator('#nav').getByRole('button', { name: en(key), exact: true });

const JUNK = `{
  scan_junk: () => ({ total: 6000, needsFda: false, groups: [{
    id: 'user_caches', title: 'Caches de apps', description: '', total: 6000, items: [
      { id: 1, name: 'com.alpha', path: '/Users/u/Library/Caches/com.alpha', size: 1000, selected: true, note: null, modified: null, trash: false, accessed: null },
      { id: 2, name: 'com.beta', path: '/Users/u/Library/Caches/com.beta', size: 2000, selected: true, note: null, modified: null, trash: true, accessed: null },
      { id: 3, name: 'com.costly', path: '/Users/u/Library/Caches/com.costly', size: 3000, selected: false, note: null, modified: null, trash: false, accessed: null },
    ] }] }),
  remove: ({ ids }) => ({ freed: 0, outcomes: ids.map((id) => ({ id, ok: true, freed: id * 1000, error: null, undo: id === 2 ? 'b-1' : undefined })) }),
  restore_trashed: ({ batches }) => batches.map(() => ({ from: '/Users/u/Library/Caches/com.beta', ok: true, error: null })),
  simulate_removal: ({ ids }) => ({ delete: { count: 1, bytes: 1000 }, trash: { count: 1, bytes: 2000 }, refused: [{ id: 3, error: 'local protegido' }], report: '/r.tsv' }),
}`;

async function scanJunk(page) {
  await nav(page, 'Entulho').click();
  await page.locator('#dock .go').click();
  await expect(page.getByRole('button', { name: en('Revisar todo o lixo') })).toBeVisible();
}

test('junk cleanup removes only what is selected and confirms first', async ({ page }) => {
  await boot(page, JUNK);
  await scanJunk(page);
  await page.locator('#dock .go').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  expect(await calls(page, 'remove')).toHaveLength(0);
  await dialog.getByRole('button', { name: en('Limpar'), exact: true }).click();
  await expect.poll(async () => (await calls(page, 'remove')).flatMap((c) => c.args.ids).sort()).toEqual([1, 2]);
  const [first] = await calls(page, 'remove');
  expect(first.args.permanent).toBe(false);
});

test('cancelling the confirmation removes nothing', async ({ page }) => {
  await boot(page, JUNK);
  await scanJunk(page);
  await page.locator('#dock .go').click();
  await page.getByRole('alertdialog').getByRole('button', { name: en('Cancelar') }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await calls(page, 'remove')).toHaveLength(0);
});

test('items moved to the Trash can be undone from the toast', async ({ page }) => {
  await boot(page, JUNK);
  await scanJunk(page);
  await page.locator('#dock .go').click();
  await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
  const undo = page.getByRole('button', { name: en('Desfazer') });
  await expect(undo).toBeVisible();
  await expect(page.locator('.toast').filter({ hasText: en('{n} item movido para o Lixo', { n: 1 }) })).toBeVisible();
  await undo.click();
  await expect.poll(async () => (await calls(page, 'restore_trashed')).map((c) => c.args.batches)).toEqual([['b-1']]);
  await expect(page.locator('.toast').filter({ hasText: en('{n} item restaurado', { n: 1 }) })).toBeVisible();
});

test('simulate shows the plan and removes nothing', async ({ page }) => {
  await boot(page, JUNK);
  await scanJunk(page);
  await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
  await page.getByRole('button', { name: en('Simular') }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(en('Simulação da limpeza'));
  await expect(dialog).toContainText(en('Recusados pela verificação de segurança'));
  await expect(dialog).toContainText(DICT['local protegido']?.en ?? 'local protegido');
  const [sim] = await calls(page, 'simulate_removal');
  expect(sim.args.ids.sort()).toEqual([1, 2]);
  await dialog.getByRole('button', { name: en('Ver relatório') }).click();
  await expect.poll(async () => (await calls(page, 'reveal_report')).map((c) => c.args.path)).toEqual(['/r.tsv']);
  expect(await calls(page, 'remove')).toHaveLength(0);
});

test('Full Disk Access guide shows once on first launch without access', async ({ page }) => {
  const noFda = `{ disk_overview: () => ({ total: 500e9, free: 120e9, used: 380e9, fda: false }) }`;
  await boot(page, noFda);
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(en('Conceder Acesso Total ao Disco'));
  await dialog.getByRole('button', { name: en('Abrir Ajustes') }).click();
  await expect.poll(async () => (await calls(page, 'open_fda_settings')).length).toBe(1);
  await expect(page.getByRole('button', { name: en('Reabrir o Limpae') })).toBeVisible();
  await page.reload();
  await page.locator('#nav .nav-item').first().waitFor();
  await page.waitForTimeout(300);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('Health lists trashed batches and restores one', async ({ page }) => {
  const history = `{
    trash_history: (_, calls) => calls.some((c) => c.cmd === 'restore_trashed') ? [] : [{ id: 'b-9', time: 1762600000, items: [
      { name: 'report.pdf', from: '/Users/u/Documents/report.pdf', size: 4096, state: 'ready' }] }],
    restore_trashed: () => [{ from: '/Users/u/Documents/report.pdf', ok: true, error: null }],
  }`;
  await boot(page, history);
  await nav(page, 'Saúde').click();
  const section = page.getByRole('region', { name: en('Movidos para o Lixo') });
  await expect(section).toContainText('report.pdf');
  await section.getByRole('button', { name: en('Restaurar') }).click();
  await expect.poll(async () => (await calls(page, 'restore_trashed')).map((c) => c.args.batches)).toEqual([['b-9']]);
  await expect(section).toHaveCount(0);
});

test('Settings adds a folder to the ignore list', async ({ page }) => {
  await boot(page, `{ ignore_folder: () => ['/Users/u/Projects/keep'] }`);
  await nav(page, 'Ajustes').click();
  await page.getByRole('button', { name: en('Adicionar pasta…') }).click();
  await expect(page.locator('.ign-path')).toHaveText('/Users/u/Projects/keep');
  const [c] = await calls(page, 'ignore_folder');
  expect(c.args.prompt).toBe(en('Escolha uma pasta que o Limpae nunca deve tocar'));
});

test('Portuguese setting renders the interface in Portuguese', async ({ page }) => {
  await boot(page, `{ get_settings: () => ({ ignored: [], smartCare: {}, menuBar: false, sounds: false, permanentDelete: false, lastSmartCare: null, language: 'pt' }) }`);
  await expect(page.locator('#nav').getByRole('button', { name: 'Entulho', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
});
