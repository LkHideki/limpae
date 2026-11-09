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
  // Same refresh as the undo toast: the free-space footer is read again.
  await expect.poll(async () => (await calls(page, 'disk_overview')).length).toBe(2);
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

// Two groups and a slow backend: removals longer than the undo debounce still give one combined "Undo".
const JUNK2 = `{
  scan_junk: () => ({ total: 3000, needsFda: false, groups: [
    { id: 'user_caches', title: 'Caches de apps', description: '', total: 1000, items: [
      { id: 1, name: 'com.alpha', path: '/Users/u/Library/Caches/com.alpha', size: 1000, selected: true, note: null, modified: null, trash: true, accessed: null }] },
    { id: 'user_logs', title: 'Registros', description: '', total: 2000, items: [
      { id: 2, name: 'app.log', path: '/Users/u/Library/Logs/app.log', size: 2000, selected: true, note: null, modified: null, trash: true, accessed: null }] }] }),
  remove: ({ ids }) => new Promise((r) => setTimeout(() => r({ freed: 0, outcomes: ids.map((id) => ({ id, ok: true, freed: 1000, error: null, undo: 'b-' + id })) }), 1300)),
}`;

test('one cleanup gives a single Undo toast even when each group is slow', async ({ page }) => {
  await boot(page, JUNK2);
  await scanJunk(page);
  await page.locator('#dock .go').click();
  await page.getByRole('alertdialog').getByRole('button', { name: en('Mover para o Lixo') }).click();
  await expect(page.locator('.toast').filter({ hasText: en('{n} itens movidos para o Lixo', { n: 2 }) })).toBeVisible({ timeout: 6000 });
  expect(await calls(page, 'remove')).toHaveLength(2);
  await expect(page.getByRole('button', { name: en('Desfazer') })).toHaveCount(1);
});

test('Tab inside a removal confirm reaches the permanent-delete switch', async ({ page }) => {
  await boot(page, JUNK);
  await scanJunk(page);
  await page.locator('#dock .go').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(100);
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    seen.add(await page.evaluate(() => document.activeElement.getAttribute('role') || document.activeElement.textContent));
  }
  expect(seen.has('switch')).toBe(true);
  expect(await page.evaluate(() => !!document.activeElement.closest('.modal'))).toBe(true);
});

test('review keeps keyboard focus after toggling a group with Space', async ({ page }) => {
  await boot(page, JUNK);
  await scanJunk(page);
  await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
  const group = page.locator('.rv-group .cb').first();
  const label = await group.getAttribute('aria-label');
  await group.focus();
  await page.keyboard.press('Space');
  await expect(group).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe(label);
  // The row menu's Select/Deselect also refocuses its opener after the list is rebuilt.
  const more = page.locator('.rv-item .rv-act[aria-haspopup="menu"]').first();
  const moreLabel = await more.getAttribute('aria-label');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ctx-menu')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe(moreLabel);
});

// Records the base frequency of every oscillator the sound synth starts (sounds on, window focused).
async function recordTones(page) {
  await page.addInitScript(() => {
    window.__tones = [];
    const orig = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function (v, t) { if (this.__osc) window.__tones.push(Math.round(v)); return orig.call(this, v, t); };
    const C = window.AudioContext || window.webkitAudioContext;
    const make = C.prototype.createOscillator;
    C.prototype.createOscillator = function () { const o = make.call(this); o.frequency.__osc = true; return o; };
  });
}
const SOUND_ON = `get_settings: () => ({ ignored: [], smartCare: {}, menuBar: false, sounds: true, permanentDelete: false, lastSmartCare: null, language: 'en' })`;

test('a cleanup that moves items to the Trash plays one result sound, not the toast on top', async ({ page }) => {
  await recordTones(page);
  await boot(page, JUNK.replace('{', '{ ' + SOUND_ON + ','));
  await scanJunk(page);
  await page.locator('#dock .go').click();
  await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
  await expect(page.getByRole('button', { name: en('Desfazer') })).toBeVisible();
  const tones = await page.evaluate(() => window.__tones);
  expect(tones).toContain(2093); // 'clean' played
  expect(tones).not.toContain(1760); // the 'ok' toast bell did not
});

test('a failed Speed scan plays a single error sound', async ({ page }) => {
  await recordTones(page);
  await boot(page, `{ ${SOUND_ON}, perf_scan: () => { throw 'falhou'; } }`);
  await nav(page, 'Velocidade').click();
  await page.locator('#dock .go').click();
  await expect(page.locator('.toast')).toBeVisible();
  await page.waitForTimeout(200);
  const tones = await page.evaluate(() => window.__tones);
  expect(tones.includes(494) || tones.includes(466)).toBe(true);
  expect(tones.includes(494) && tones.includes(466)).toBe(false); // 'err' (toast) and 'error' (view) never both
});

test('with a search active, the group checkbox only toggles the rows the search shows', async ({ page }) => {
  await boot(page, JUNK);
  await scanJunk(page);
  await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
  await page.getByRole('searchbox', { name: en('Buscar itens') }).fill('alpha');
  await expect(page.locator('.rv-item')).toHaveCount(1);
  const group = page.locator('.rv-group .cb').first();
  await expect(group).toHaveAttribute('aria-checked', 'true'); // the one visible row is selected
  await group.click();
  await expect(page.locator('.rv-sel small')).toHaveText(en('{n} item', { n: 1 })); // com.beta (hidden) stays; com.costly not added
});

test('a failed removal plays the error sound without the dialog chime of its failures sheet', async ({ page }) => {
  await recordTones(page);
  await boot(page, JUNK.replace('{', '{ ' + SOUND_ON + ',').replace(/remove: \(\{ ids \}\) => \(\{[^\n]*\n/, "remove: ({ ids }) => ({ freed: 0, outcomes: ids.map((id) => ({ id, ok: false, freed: 0, error: 'em uso' })) }),\n"));
  await scanJunk(page);
  await page.locator('#dock .go').click();
  await page.evaluate(() => { window.__tones = []; }); // from here: only the confirm's close, the result and the sheet
  await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: en('Alguns itens não foram removidos') })).toBeVisible();
  await page.waitForTimeout(150);
  const tones = await page.evaluate(() => window.__tones);
  expect(tones).toContain(466); // 'error'
  expect(tones).not.toContain(440); // 'open' ducked
});

test('stopping a removal does not open a failures sheet for the items left in place', async ({ page }) => {
  await boot(page, JUNK2);
  await scanJunk(page);
  await page.locator('#dock .go').click();
  await page.getByRole('alertdialog').getByRole('button', { name: en('Mover para o Lixo') }).click();
  await page.getByRole('button', { name: en('Parar') }).click();
  await expect(page.locator('.toast').filter({ hasText: en('{n} item movido para o Lixo', { n: 1 }) })).toBeVisible({ timeout: 6000 });
  expect(await calls(page, 'remove')).toHaveLength(1);
  await page.waitForTimeout(200);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('keyboard navigation from inside a screen moves focus to the new screen', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: en('Escolher módulos nos Ajustes') }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-mod', 'settings');
  await expect.poll(() => page.evaluate(() => { const a = document.activeElement; return a !== document.body && !!a.closest('#view, #nav'); })).toBe(true);
});

const PERF = `{
  perf_scan: () => ({ agents: [
    { id: 1, label: 'com.a.agent', scope: 'user', manageable: true, state: 'active', signature: 'valid', owner: null, program: '/x/a', file: 'a.plist' },
    { id: 2, label: 'com.b.agent', scope: 'user', manageable: true, state: 'active', signature: 'valid', owner: null, program: '/x/b', file: 'b.plist' },
    { id: 3, label: 'com.c.agent', scope: 'user', manageable: true, state: 'active', signature: 'valid', owner: null, program: '/x/c', file: 'c.plist' } ],
    login: { items: [], needsAutomation: false, error: null }, snapshots: { items: [], error: null, canThin: false },
    monitor: { memory: null, swap: null, cpu: { usage: 10, load1: 1, load5: 1, load15: 1, cores: 8 }, battery: null, uptimeSecs: 100, top: [] } }),
  agent_toggle: ({ enable }) => ({ state: enable ? 'active' : 'disabled' }),
  agent_remove: ({ ids }) => new Promise((r) => setTimeout(() => r({ outcomes: ids.map((id) => ({ id, ok: true, error: null })) }), 500)),
}`;

test('Speed manager: keyboard toggle keeps focus, Remove locks while running, a new selection replaces the note', async ({ page }) => {
  await boot(page, PERF);
  await nav(page, 'Velocidade').click();
  await page.locator('#dock .go').click();
  await page.getByRole('button', { name: en('Abrir o gerenciador') }).click();
  const sw = page.locator('.pf-switch').first();
  await sw.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.pf-row').first()).toHaveAttribute('data-state', 'disabled');
  expect(await page.evaluate(() => document.activeElement.classList.contains('pf-switch'))).toBe(true);

  const remove = page.locator('.rv-foot .btn.primary');
  await page.locator('.pf-row').nth(1).click();
  await remove.click();
  await page.getByRole('alertdialog').getByRole('button', { name: en('Remover'), exact: true }).click();
  await expect(remove).toBeDisabled(); // in flight: no second confirmation for the same items
  await expect(page.locator('.rv-foot .rv-sel')).toContainText(en('{n} item removido.', { n: 1 }));
  await page.locator('.pf-row').nth(1).click();
  await expect(page.locator('.rv-foot .rv-sel')).toHaveText(en('{n} item selecionado', { n: 1 }));
  await expect(remove).toBeEnabled();
  expect(await calls(page, 'agent_remove')).toHaveLength(1);
});

test('after visiting System Settings, Reopen Limpae stays reachable with the banner dismissed', async ({ page }) => {
  await boot(page, `{ disk_overview: () => ({ total: 500e9, free: 120e9, used: 380e9, fda: false }), scan_trash: () => ({ total: 0, needsFda: true, groups: [] }) }`,
    { storage: { 'limpae.fda.onboarded': '1', 'limpae.fda.visited': '1', 'limpae.fda.dismissed': '1' } });
  await expect(page.locator('.fda-banner')).toHaveCount(0);
  await nav(page, 'Lixeira').click();
  await page.locator('#dock .go').click();
  await page.getByRole('button', { name: en('Reabrir o Limpae') }).click();
  await expect.poll(async () => (await calls(page, 'relaunch')).length).toBe(1);
});

test('with "Delete permanently" as the default, the confirm opens red, focused on Cancel, with the warn cue', async ({ page }) => {
  await recordTones(page);
  await boot(page, JUNK.replace('{', '{ ' + SOUND_ON.replace('permanentDelete: false', 'permanentDelete: true') + ','));
  await scanJunk(page);
  await page.evaluate(() => { window.__tones = []; });
  await page.locator('#dock .go').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toHaveClass(/danger/);
  await expect.poll(() => page.evaluate(() => document.activeElement.textContent)).toBe(en('Cancelar'));
  const tones = await page.evaluate(() => window.__tones);
  expect(tones).toContain(494); // 'warn'
  expect(tones).not.toContain(440); // not the rising 'open'
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, 'remove')).toHaveLength(0);
});

test('Simulate turns busy while the dry run runs, so a second click opens no second dialog', async ({ page }) => {
  await boot(page, JUNK.replace("simulate_removal: ({ ids }) => (", "simulate_removal: ({ ids }) => new Promise((r) => setTimeout(() => r(").replace("report: '/r.tsv' }),", "report: '/r.tsv' }), 600)),"));
  await scanJunk(page);
  await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
  const sim = page.locator('.rv-foot .btn.ghost');
  await sim.click();
  await expect(sim).toBeDisabled();
  await expect(sim).toContainText(en('Simulando…'));
  await sim.click({ force: true });
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.locator('.modal-back')).toHaveCount(1);
  expect(await calls(page, 'simulate_removal')).toHaveLength(1);
});

const MANY = `{
  scan_junk: () => ({ total: 300000, needsFda: false, groups: [{ id: 'user_caches', title: 'Caches de apps', description: '', total: 300000,
    items: Array.from({ length: 300 }, (_, i) => ({ id: i + 1, name: 'item' + (i + 1), path: '/Users/u/Library/Caches/item' + (i + 1), size: 1000 + 300 - i, selected: true, note: null, modified: null, trash: false, accessed: null })) }] }),
  ignore_item: () => null,
}`;

test('review: "Show more" and "Ignore" keep keyboard focus in the list', async ({ page }) => {
  await boot(page, MANY);
  await scanJunk(page);
  await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
  await page.locator('.rv-more button').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.rv-item')).toHaveCount(300);
  expect(await page.evaluate(() => document.activeElement.dataset.fk)).toBe('i:251');
  // Ignoring a row from its menu moves focus to the next row's menu button.
  await page.locator('[data-fk="im:1"]').focus();
  await page.keyboard.press('Enter');
  await page.locator('.ctx-menu').getByRole('menuitem', { name: en('Ignorar') }).click();
  await expect(page.locator('[data-fk="im:1"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement.dataset.fk)).toBe('im:2');
});

test('turning sounds on plays the confirmation chime only, not the checkbox tick on top', async ({ page }) => {
  await recordTones(page);
  await boot(page);
  await nav(page, 'Ajustes').click();
  const cb = page.getByRole('checkbox', { name: en('Reproduzir sons nas ações principais') });
  await cb.click();
  await expect(cb).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(150);
  const tones = await page.evaluate(() => window.__tones);
  expect(tones).toContain(1047); // 'found'
  expect(tones).not.toContain(1976); // 'tick'
});

test('Settings that fail to load show a retry instead of an endless spinner', async ({ page }) => {
  await boot(page, `{ get_settings: () => { if (!window.__settingsOk) throw 'falhou'; return { ignored: [], smartCare: {}, menuBar: false, sounds: false, permanentDelete: false, lastSmartCare: null, language: 'en' }; } }`);
  await nav(page, 'Ajustes').click();
  const retry = page.getByRole('button', { name: en('Tentar de novo') });
  await expect(retry).toBeVisible();
  await expect(page.locator('.set-loading .spin')).toHaveCount(0);
  await page.evaluate(() => { window.__settingsOk = true; });
  await retry.click();
  await expect(page.getByRole('heading', { name: en('Ajustes') })).toBeVisible();
});

test('Undo with nothing left to restore shows a neutral toast without the error sound', async ({ page }) => {
  await recordTones(page);
  await boot(page, JUNK.replace('{', '{ ' + SOUND_ON + ',').replace("restore_trashed: ({ batches }) => batches.map(() => ({ from: '/Users/u/Library/Caches/com.beta', ok: true, error: null })),", 'restore_trashed: () => [],'));
  await scanJunk(page);
  await page.locator('#dock .go').click();
  await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
  await page.getByRole('button', { name: en('Desfazer') }).click();
  await page.evaluate(() => { window.__tones = []; });
  await expect(page.locator('.toast.info')).toBeVisible();
  await page.waitForTimeout(150);
  const tones = await page.evaluate(() => window.__tones);
  expect(tones).not.toContain(494);
  expect(tones).not.toContain(349);
});

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' });
  const bursts = (page) => page.evaluate(() => window.__bursts);
  const countBursts = (page) => page.addInitScript(() => {
    window.__bursts = 0;
    new MutationObserver((l) => l.forEach((m) => m.addedNodes.forEach((n) => { if (n.classList && n.classList.contains('mo-fx')) window.__bursts++; })))
      .observe(document, { childList: true, subtree: true });
  });

  test('a cleanup where every removal failed does not celebrate; a real one does', async ({ page }) => {
    await countBursts(page);
    await boot(page, JUNK.replace(/remove: \(\{ ids \}\) => \(\{[^\n]*\n/, "remove: ({ ids }, calls) => ({ freed: 0, outcomes: ids.map((id) => ({ id, ok: calls.filter((c) => c.cmd === 'remove').length > 1, freed: 1000, error: 'em uso' })) }),\n"));
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: en('Alguns itens não foram removidos') })).toBeVisible();
    await page.waitForTimeout(400);
    expect(await bursts(page)).toBe(0);
    await page.getByRole('button', { name: en('Entendi') }).click();
    await page.getByRole('button', { name: en('Revisar itens restantes') }).click();
    await page.locator('.rv-foot .btn.primary').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
    await expect.poll(() => bursts(page)).toBe(1);
  });
});

// ---- gauntlet round 1 ----

test.describe('gauntlet round 1 (motion)', () => {
  test.use({ reducedMotion: 'no-preference' });
  const bursts = (page) => page.evaluate(() => window.__bursts);
  const countBursts = (page) => page.addInitScript(() => {
    window.__bursts = 0;
    new MutationObserver((l) => l.forEach((m) => m.addedNodes.forEach((n) => { if (n.classList && n.classList.contains('mo-fx')) window.__bursts++; })))
      .observe(document, { childList: true, subtree: true });
  });
  const cleanJunk = async (page) => {
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
  };

  test('the celebration does not replay when the window gets focus back after the count-up', async ({ page }) => {
    await countBursts(page);
    await boot(page, JUNK);
    await cleanJunk(page);
    await expect.poll(() => bursts(page)).toBe(1);
    await page.waitForTimeout(1800); // the counting hero is done: its text no longer reads 0
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(500);
    expect(await bursts(page)).toBe(1);
  });

  test('the dock ring spins until a real step arrives, never unwinds, and a hidden dock keeps its ring until it has faded', async ({ page }) => {
    await boot(page, JUNK2);
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Mover para o Lixo') }).click();
    // While the first (slow) group runs there is no progress yet: the ring spins instead of showing a static empty arc.
    const samples = await page.evaluate(() => new Promise((resolve) => {
      const arc = document.querySelector('#dock .arc'), btn = document.querySelector('#dock .go'), ring = btn.querySelector('.go-ring'), out = [], t0 = performance.now();
      const tick = () => {
        out.push({ det: btn.classList.contains('det'), busy: btn.classList.contains('busy'), spin: getComputedStyle(ring).animationName, off: parseFloat(getComputedStyle(arc).strokeDashoffset) });
        if (performance.now() - t0 < 2200) requestAnimationFrame(tick); else resolve(out);
      };
      tick();
    }));
    const early = samples.filter((x) => !x.det && x.busy);
    expect(early.length).toBeGreaterThan(20);
    expect(early.every((x) => x.spin === 'go-spin')).toBe(true);
    // Once the first group is done the ring is determinate and jumps to 1/2 (no unwinding from the full ring).
    const det = samples.filter((x) => x.det);
    expect(det.length).toBeGreaterThan(5);
    expect(Math.max(...det.map((x) => x.off))).toBeLessThan(2 * Math.PI * 52 * 0.5 + 2);
    await expect(page.getByRole('button', { name: en('Concluir') })).toBeVisible({ timeout: 6000 });
    await page.waitForTimeout(450); // the dock has faded: only now is the ring reset
    const cls = await page.locator('#dock .go').getAttribute('class');
    expect(cls).not.toMatch(/\b(busy|det)\b/);
  });

  test('a one-step removal keeps the dock ring spinning and never flashes an arc while the dock fades', async ({ page }) => {
    await boot(page, JUNK.replace(/remove: [^\n]*\n/, "remove: ({ ids }) => new Promise((r) => setTimeout(() => r({ freed: 0, outcomes: ids.map((id) => ({ id, ok: true, freed: id * 1000, error: null })) }), 1200)),\n"));
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
    const seen = await page.evaluate(() => new Promise((resolve) => {
      const btn = document.querySelector('#dock .go'), host = document.getElementById('dock'), arc = btn.querySelector('.arc'), out = { det: false, spinning: 0, fadeOffsets: [] }, t0 = performance.now();
      const tick = () => {
        if (btn.classList.contains('det')) out.det = true;
        if (btn.classList.contains('busy') && getComputedStyle(btn.querySelector('.go-ring')).animationName === 'go-spin') out.spinning++;
        if (host.classList.contains('off') && btn.classList.contains('busy')) out.fadeOffsets.push(parseFloat(getComputedStyle(arc).strokeDashoffset));
        if (performance.now() - t0 < 2200) requestAnimationFrame(tick); else resolve(out);
      };
      tick();
    }));
    expect(seen.det).toBe(false);
    expect(seen.spinning).toBeGreaterThan(20);
    // While the dock fades the arc geometry stays put: no sweep from a full offset down to 0.
    expect(new Set(seen.fadeOffsets).size).toBeLessThanOrEqual(1);
  });

  test('Screen Cleaning exit fades the overlay instead of holding it opaque', async ({ page }) => {
    await boot(page);
    const opacity = await page.evaluate(async () => {
      const ov = document.createElement('div');
      ov.className = 'sclean';
      document.body.append(ov);
      await new Promise((r) => setTimeout(r, 600)); // the entrance is over
      ov.classList.add('out');
      await new Promise((r) => setTimeout(r, 90));
      return parseFloat(getComputedStyle(ov).opacity);
    });
    expect(opacity).toBeLessThan(0.95);
  });

  test('toasts do not cover the manager bar', async ({ page }) => {
    await boot(page, MANY);
    await scanJunk(page);
    await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
    await page.evaluate(() => { const d = document.createElement('div'); d.className = 'toast ok'; d.textContent = 'x'; document.getElementById('toast-root').append(d); });
    await page.waitForTimeout(300);
    const [toast, bar] = await page.evaluate(() => ['.toast', '.mgr-bar'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    expect(toast.top).toBeGreaterThan(bar.bottom);
  });
});

test('review keeps its scroll position on selection-only refreshes and resets it on a search change', async ({ page }) => {
  await boot(page, MANY);
  await scanJunk(page);
  await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
  await page.locator('.rv-items').evaluate((el) => { el.scrollTop = 1200; });
  const top = await page.locator('.rv-items').evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(500);
  await page.locator('.rv-item').nth(30).evaluate((el) => el.click()); // the row is on screen at this scroll position
  expect(await page.locator('.rv-items').evaluate((el) => el.scrollTop)).toBe(top);
  await page.locator('.sel-btn').click();
  await page.getByRole('menuitemradio', { name: en('Nada') }).click();
  expect(await page.locator('.rv-items').evaluate((el) => el.scrollTop)).toBe(top);
  await page.getByRole('searchbox', { name: en('Buscar itens') }).fill('item2');
  expect(await page.locator('.rv-items').evaluate((el) => el.scrollTop)).toBe(0);
});

test('Toolbox: favoriting with the keyboard keeps focus on the tool\'s star', async ({ page }) => {
  await boot(page);
  await nav(page, 'Ferramentas').click();
  const star = page.locator('.tl-star').nth(1);
  const tool = await star.evaluate((el) => el.closest('.tl-tile').dataset.tool);
  await star.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`.tl-tile[data-tool="${tool}"] .tl-star`)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.activeElement.closest('.tl-tile')?.dataset.tool)).toBe(tool);
  expect(await page.evaluate(() => document.activeElement.classList.contains('tl-star'))).toBe(true);
});

test('the junk summary offers Start over, which returns to the landing page', async ({ page }) => {
  await boot(page, JUNK);
  await scanJunk(page);
  await page.getByRole('button', { name: en('Recomeçar') }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: en('Recomeçar'), exact: true }).click();
  await expect(page.getByRole('heading', { name: en('Entulho') })).toBeVisible();
  await expect(page.locator('#dock .go')).toContainText(en('Analisar'));
});

test.describe('gauntlet round 1 (sound)', () => {
  const soundBoot = (page, extra = '') => boot(page, `{ ${SOUND_ON}, ${extra} }`);
  const settle = (page, ms = 300) => page.waitForTimeout(ms);
  const tonesOf = (page) => page.evaluate(() => window.__tones);

  test('Trash scan plays the start and found cues', async ({ page }) => {
    await recordTones(page);
    await soundBoot(page, `scan_trash: () => new Promise((r) => setTimeout(() => r({ total: 0, needsFda: false, groups: [] }), 300))`);
    await nav(page, 'Lixeira').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__tones = []; });
    await page.locator('#dock .go').click();
    await settle(page, 900);
    const tones = await tonesOf(page);
    expect(tones.length).toBeGreaterThan(0);
    expect(tones).not.toEqual(expect.arrayContaining([392])); // not the generic 'pop'
    expect(tones).toContain(1047); // 'found'
  });

  test('a row click selects an app with the checkbox sound', async ({ page }) => {
    await recordTones(page);
    await soundBoot(page, `list_apps: () => [{ id: 1, name: 'Alpha', path: '/Applications/Alpha.app', size: 5000, bundleId: 'x.alpha', running: false, version: '1', kind: 'app' }],
      apps_overview: () => ({ updates: [], unused: [], leftovers: { total: 0, needsFda: false, groups: [] }, installers: { total: 0, needsFda: false, groups: [] } }),
      app_meta: () => [], app_leftovers: () => ({ total: 0, needsFda: false, groups: [] })`);
    await nav(page, 'Aplicativos').click();
    await page.getByRole('button', { name: en('Ver meus aplicativos') }).click();
    const row = page.locator('.am-row').first();
    await expect(row).toBeVisible();
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.__tones = []; });
    await row.locator('.rv-name').click();
    await expect(row.locator('.cb')).toHaveAttribute('aria-checked', 'true');
    await settle(page, 200);
    expect(await tonesOf(page)).toContain(1976); // 'tick'
  });

  test('Time Machine thinning that removes nothing does not play the success sound', async ({ page }) => {
    await recordTones(page);
    const snap = `{ name: 'com.apple.TimeMachine.2026-01-01', date: null }`;
    const m = PERF.replace('snapshots: { items: [], error: null, canThin: false }', `snapshots: { items: [${snap}], error: null, canThin: true }`)
      .replace('{', `{ ${SOUND_ON}, tm_thin: () => ({ removed: 0, snapshots: [${snap}] }),`);
    await boot(page, m);
    await nav(page, 'Velocidade').click();
    await page.locator('#dock .go').click();
    await page.getByRole('button', { name: en('Abrir o gerenciador') }).click();
    await page.locator('.fm-cat', { hasText: en('Snapshots') }).click();
    await page.getByRole('button', { name: en('Afinar snapshots') }).click();
    await page.evaluate(() => { window.__tones = []; });
    await page.getByRole('alertdialog').getByRole('button', { name: en('Afinar'), exact: true }).click();
    await expect(page.locator('.rv-foot .rv-sel')).toContainText(en('Nenhum snapshot foi removido.'));
    await settle(page, 400);
    expect(await tonesOf(page)).not.toContain(2093); // 'clean' fanfare
  });

  test('keyboard activation of another module while a scan runs plays no navigation sound', async ({ page }) => {
    await recordTones(page);
    await soundBoot(page, `scan_junk: () => new Promise(() => {})`);
    await nav(page, 'Entulho').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('body.locked')).toHaveCount(1);
    await page.evaluate(() => { window.__tones = []; });
    await nav(page, 'Lixeira').focus();
    await page.keyboard.press('Enter');
    await settle(page, 300);
    expect(await tonesOf(page)).toEqual([]);
    await expect(page.locator('body')).toHaveAttribute('data-mod', 'clean');
  });

  test('a removal whose call rejects sounds one error, with no dialog chime on top', async ({ page }) => {
    await recordTones(page);
    const m = JUNK2.replace(/remove: [^\n]*\n/, "remove: () => new Promise((_, rej) => setTimeout(() => rej('falhou'), 150)),\n");
    await boot(page, m.replace('{', '{ ' + SOUND_ON + ','));
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.evaluate(() => { window.__tones = []; }); // after the confirmation's own chime
    await page.getByRole('alertdialog').getByRole('button', { name: en('Mover para o Lixo') }).click();
    await expect(page.getByRole('alertdialog', { name: en('Alguns itens não foram removidos') })).toBeVisible({ timeout: 6000 });
    await settle(page, 300);
    const tones = await tonesOf(page);
    expect(tones.filter((f) => f === 494).length).toBe(1); // one error voice, not one per group
    expect(tones).not.toContain(440); // the rising 'open' chime stayed out
  });

  test('an Undo that restores nothing plays the error cue, not just the dialog chime', async ({ page }) => {
    await recordTones(page);
    await boot(page, JUNK.replace('{', '{ ' + SOUND_ON + ',').replace(/restore_trashed: [^\n]*\n/, "restore_trashed: () => [{ from: '/Users/u/Library/Caches/com.beta', ok: false, error: 'já existe' }],\n"));
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
    await page.evaluate(() => { window.__tones = []; });
    await page.getByRole('button', { name: en('Desfazer') }).click();
    await expect(page.getByRole('alertdialog', { name: en('Alguns itens não foram restaurados') })).toBeVisible();
    await settle(page, 300);
    const tones = await tonesOf(page);
    expect(tones.includes(494) || tones.includes(466)).toBe(true);
    expect(tones).not.toContain(440);
  });
});

test('the failures sheet pauses the Undo toast countdown while it is open', async ({ page }) => {
  await boot(page, JUNK.replace(/remove: [^\n]*\n/, "remove: ({ ids }) => ({ freed: 0, outcomes: ids.map((id) => id === 1 ? { id, ok: false, freed: 0, error: 'em uso' } : { id, ok: true, freed: 2000, error: null, undo: 'b-1' }) }),\n"));
  await scanJunk(page);
  await page.locator('#dock .go').click();
  await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
  const sheet = page.getByRole('alertdialog', { name: en('Alguns itens não foram removidos') });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('button', { name: en('Desfazer') })).toBeVisible();
  // Past the 9 s lifetime of an Undo toast: it must survive because the sheet is open.
  const alive = await page.evaluate(() => new Promise((r) => setTimeout(() => r(!!document.querySelector('.toast-act')), 9600)));
  expect(alive).toBe(true);
  await page.getByRole('button', { name: en('Entendi') }).click();
  await expect(page.getByRole('button', { name: en('Desfazer') })).toBeVisible();
});

const APPS = `{
  list_apps: () => [{ id: 1, name: 'Alpha', path: '/Applications/Alpha.app', size: 5000, bundleId: 'x.alpha', running: false, version: '1', kind: 'app' }],
  apps_overview: () => ({ updates: [], unused: [], leftovers: { total: 0, needsFda: false, groups: [] }, installers: { total: 0, needsFda: false, groups: [] } }),
  app_meta: () => [],
  app_leftovers: () => new Promise((r) => setTimeout(() => r({ total: 0, needsFda: false, groups: [] }), 1500)),
}`;

test('Uninstall shows a busy state while leftovers are scanned, and a second click opens no second dialog', async ({ page }) => {
  await boot(page, APPS);
  await nav(page, 'Aplicativos').click();
  await page.getByRole('button', { name: en('Ver meus aplicativos') }).click();
  await page.locator('.am-row .cb').first().click();
  const btn = page.locator('.rv-foot .btn.primary');
  await btn.click();
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveAttribute('aria-busy', 'true');
  await expect(btn).toContainText(en('Calculando restos…'));
  await btn.click({ force: true });
  await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 4000 });
  await page.waitForTimeout(300);
  await expect(page.locator('.modal-back')).toHaveCount(1);
  expect(await calls(page, 'app_leftovers')).toHaveLength(1);
});

const SECURITY = `{
  security_checks: () => [],
  privacy_scan: () => ({ needsFda: false, groups: [], browsers: [] }),
  tcc_permissions: () => ({ needsFda: false, apps: 2, cameraMicApps: 2, groups: [{ service: 'Camera', title: 'Câmera', rows: [
    { id: 1, name: 'Zoom', bundleId: 'us.zoom.xos', installed: true, granted: true, limited: false, modified: null },
    { id: 2, name: 'Meet', bundleId: 'com.meet', installed: true, granted: true, limited: false, modified: null }] }] }),
}`;

test('Security permissions: toggling a row with the keyboard keeps focus on its checkbox', async ({ page }) => {
  await boot(page, SECURITY);
  await nav(page, 'Segurança').click();
  await page.locator('#dock .go').click();
  await page.locator('.pr-tile[data-area="perms"] button').click();
  const cb = page.getByRole('checkbox', { name: en('Selecionar {name}', { name: 'Zoom' }) });
  await cb.focus();
  await page.keyboard.press('Space');
  await expect(cb).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe(en('Selecionar {name}', { name: 'Zoom' }));
  // The "Select" menu returns focus to its (rebuilt) opener too.
  const sel = page.locator('.sel-btn');
  await sel.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement.classList.contains('sel-btn'))).toBe(true);
});

// ---- gauntlet round 2 ----

test.describe('gauntlet round 2', () => {
  test.use({ reducedMotion: 'no-preference' });
  const blur = (page) => page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });

  test('screens rendered while the window is unfocused are visible (one-shot entrances are not paused)', async ({ page }) => {
    await boot(page, JUNK);
    await nav(page, 'Entulho').click();
    await blur(page);
    await expect(page.locator('body')).toHaveClass(/idle/);
    // The infinite decorative loops are paused while idle.
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#view .orb')).animationPlayState)).toBe('paused');
    await page.locator('#dock .go').click();
    await expect(page.getByRole('button', { name: en('Revisar todo o lixo') })).toBeAttached();
    await page.waitForTimeout(900);
    const hidden = await page.evaluate(() => [...document.querySelectorAll('#view .enter, #view .t-main')].filter((e) => getComputedStyle(e).opacity !== '1').length);
    expect(hidden).toBe(0);
    // A dialog opened while idle shows its card too.
    await page.locator('#dock .go').click();
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.modal')).opacity)).toBe('1');
  });

  test('a menu-bar navigation is ignored while a dialog is open, and a late screen cannot take over the dock', async ({ page }) => {
    await boot(page, JUNK.replace('{', "{ lens_roots: () => new Promise((r) => setTimeout(() => r([{ index: 0, path: '/', root: null, isVolume: true, total: 100, used: 50, name: 'Mac' }]), 700)),"));
    await nav(page, 'Mapa do Disco').click();
    await nav(page, 'Entulho').click();
    await page.waitForTimeout(1000);
    // Junk's own dock, not the Disk Map's late "Scan" handler.
    await expect(page.locator('#dock')).toHaveAttribute('data-mod', 'clean');
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.evaluate(() => window.__ev.navigate({ payload: 'settings' }));
    await expect(page.locator('body')).toHaveAttribute('data-mod', 'clean');
  });

  test('a rebuilt window lands on the module asked for in the URL', async ({ page }) => {
    await boot(page, '{}', { hash: '#nav=trash' });
    await expect(page.locator('body')).toHaveAttribute('data-mod', 'trash');
    expect(new URL(page.url()).hash).toBe('');
  });

  test('a module requested while the UI was booting (ui_ready) wins over the URL', async ({ page }) => {
    await boot(page, "{ ui_ready: () => 'settings' }", { hash: '#nav=trash' });
    await expect(page.locator('body')).toHaveAttribute('data-mod', 'settings');
    expect((await calls(page, 'ui_ready')).length).toBe(1);
  });

  test('an unknown #nav module opens Sweep', async ({ page }) => {
    await boot(page, '{}', { hash: '#nav=nope' });
    await expect(page.locator('body')).toHaveAttribute('data-mod', 'smart');
  });

  test('the UI reports operations in progress to the backend (ui_busy) only when the state changes', async ({ page }) => {
    await boot(page, JUNK);
    expect(await calls(page, 'ui_busy')).toEqual([]);
    await scanJunk(page);
    const seen = (await calls(page, 'ui_busy')).map((c) => c.args.busy);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe(true);
    expect(seen.at(-1)).toBe(false);
    expect(seen.every((b, i) => i === 0 || b !== seen[i - 1])).toBe(true);
  });

  test('a Simulate in progress disables the removal action, and Esc closes one stacked dialog at a time', async ({ page }) => {
    await boot(page, JUNK.replace("simulate_removal: ({ ids }) => (", "simulate_removal: ({ ids }) => new Promise((r) => setTimeout(() => r(").replace("report: '/r.tsv' }),", "report: '/r.tsv' }), 500)),"));
    await scanJunk(page);
    await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
    const action = page.locator('.rv-foot .btn.primary');
    await page.locator('.rv-foot .btn.ghost').click();
    await expect(action).toBeDisabled();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(action).toBeEnabled();
    // Two dialogs stacked (the report on top of a confirm): Esc closes only the top one.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    await action.click();
    await expect(page.locator('.modal-back:not(.out)')).toHaveCount(1);
    await page.evaluate(() => document.querySelector('.rv-foot .btn.ghost').click());
    await expect(page.locator('.modal-back:not(.out)')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-back:not(.out)')).toHaveCount(1);
  });

  test('a failed security check does not report a protected Mac', async ({ page }) => {
    await boot(page, `{ security_checks: () => { throw 'falha ao ler o estado do sistema'; }, tcc_permissions: () => ({ needsFda: false, groups: [], cameraMicApps: 0, apps: 0 }), privacy_scan: () => ({ groups: [], total: 0, browsers: [], needsFda: false }) }`);
    await nav(page, 'Segurança').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('.fl-title')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.fl-title')).toHaveText(en('Não foi possível verificar a segurança.'));
    await expect(page.locator('.pr-tile.main')).not.toContainText(en('Seu Mac está protegido'));
    await expect(page.locator('.pr-tile.main').getByRole('button', { name: en('Analisar de novo') })).toBeVisible();
  });

  test('keyboard focus stays on the Speed tab that was picked', async ({ page }) => {
    await boot(page, PERF);
    await nav(page, 'Velocidade').click();
    await page.locator('#dock .go').click();
    await page.getByRole('button', { name: en('Abrir o gerenciador') }).click();
    const tab = page.locator('.fm-cat').nth(1);
    await tab.focus();
    await page.keyboard.press('Enter');
    await expect(tab).toHaveAttribute('aria-current', 'true');
    expect(await page.evaluate(() => document.activeElement.dataset.fk)).toMatch(/^tab:/);
  });

  test('keyboard focus moves to the done screen when the dock hides after a removal', async ({ page }) => {
    await boot(page, JUNK);
    await nav(page, 'Entulho').click();
    await page.locator('#dock .go').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: en('Revisar todo o lixo') })).toBeVisible();
    await page.locator('#dock .go').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement.textContent)).toBe(en('Cancelar')); // destructive: Cancel has the focus
    await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: en('Concluir') })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (document.activeElement && document.activeElement.closest('#view') ? document.activeElement.textContent : 'lost'))).toBe(en('Concluir'));
  });

  test('keyboard focus survives closing the Full Disk Access guide', async ({ page }) => {
    await boot(page, `{ disk_overview: () => ({ total: 500e9, free: 120e9, used: 380e9, fda: false }) }`,
      { storage: { 'limpae.fda.onboarded': '1' } });
    const how = page.getByRole('button', { name: en('Como conceder') });
    await how.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.textContent)).toBe(en('Como conceder'));
  });

  test('the Sweep tiles do not replay their entrance when the results arrive', async ({ page }) => {
    await boot(page, JUNK);
    await nav(page, 'Faxina').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('.t-review').first()).toBeAttached({ timeout: 8000 });
    await page.waitForTimeout(100);
    const replay = await page.evaluate(() => [...document.querySelectorAll('.t-main')].filter((m) => m.getAnimations().some((a) => a.animationName === 'rise' && a.currentTime < 300 && !m.classList.contains('still'))).length);
    expect(replay).toBe(0);
  });
  test('a sleeping audio context is woken on pointerdown, before the click needs its sound', async ({ page }) => {
    await page.addInitScript(() => {
      window.__resumes = 0;
      const C = window.AudioContext || window.webkitAudioContext;
      const orig = C.prototype.resume;
      C.prototype.resume = function () { window.__resumes++; return orig.call(this); };
    });
    await boot(page, `{ ${SOUND_ON} }`);
    await nav(page, 'Entulho').click(); // 'nav' cue: creates the context
    await page.waitForFunction(() => window.__resumes >= 0);
    await page.waitForTimeout(3200); // the voice and the reverb tail are over: the context is suspended
    const before = await page.evaluate(() => window.__resumes);
    const box = await nav(page, 'Lixeira').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 10);
    await page.mouse.down();
    await expect.poll(() => page.evaluate(() => window.__resumes)).toBeGreaterThan(before);
    await page.mouse.up();
  });
});

// ---- gauntlet round 3 ----

const SLOW_JUNK = (ms) => JUNK.replace('scan_junk: () => ({', `scan_junk: () => new Promise((r) => setTimeout(() => r({`).replace(/\] \}\] \}\),\n  remove/, `] }] }), ${ms})),\n  remove`);

test.describe('gauntlet round 3', () => {
  const dbl = (page, sel) => page.locator(sel).dblclick();

  test('double-clicking Analyze starts the scan and does not stop it; double-clicking Clean keeps the confirmation open', async ({ page }) => {
    await boot(page, SLOW_JUNK(900));
    await nav(page, 'Entulho').click();
    await dbl(page, '#dock .go');
    await page.waitForTimeout(300);
    expect(await calls(page, 'cancel_scan')).toHaveLength(0);
    await expect(page.locator('#dock .go')).toContainText(en('Parar'));
    await expect(page.getByRole('button', { name: en('Revisar todo o lixo') })).toBeVisible({ timeout: 8000 });
    await dbl(page, '#dock .go');
    await page.waitForTimeout(500);
    await expect(page.getByRole('alertdialog')).toBeVisible();
  });

  test('clicking the opener of an open menu closes it without opening a new one', async ({ page }) => {
    await boot(page, SECURITY);
    await nav(page, 'Segurança').click();
    await page.locator('#dock .go').click();
    await page.locator('.pr-tile[data-area="perms"] button').click();
    const sel = page.locator('.sel-btn');
    await sel.click();
    await expect(page.locator('.ctx-menu')).toHaveCount(1);
    await expect(sel).toHaveAttribute('aria-expanded', 'true');
    await sel.click();
    await expect(page.locator('.ctx-menu')).toHaveCount(0);
    await expect(sel).toHaveAttribute('aria-expanded', 'false');
  });

  test('keyboard focus survives phase changes inside a screen (summary, review, back)', async ({ page }) => {
    await boot(page, JUNK);
    await scanJunk(page);
    const inView = () => page.evaluate(() => !!document.activeElement && document.activeElement !== document.body && !!document.activeElement.closest('#view'));
    const review = page.getByRole('button', { name: en('Revisar todo o lixo') });
    await review.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.rv-foot')).toBeVisible();
    expect(await inView()).toBe(true);
    await page.keyboard.press('Escape');
    await expect(review).toBeVisible();
    expect(await inView()).toBe(true);
  });

  test('a failed security read shows an unavailable state in the manager, and a good recheck clears it', async ({ page }) => {
    await boot(page, `{ security_checks: (a, calls) => { if (calls.filter((c) => c.cmd === 'security_checks').length < 2) throw 'falha ao ler o estado do sistema'; return [{ id: 'fv', title: 'FileVault', detail: '', ok: true, fix: null }]; },
      tcc_permissions: () => ({ needsFda: false, groups: [], cameraMicApps: 0, apps: 0 }), privacy_scan: () => ({ groups: [], total: 0, browsers: [], needsFda: false }) }`);
    await nav(page, 'Segurança').click();
    await page.locator('#dock .go').click();
    await page.getByRole('button', { name: en('Revisar tudo') }).click();
    await expect(page.locator('.pr-check')).toHaveCount(0);
    await expect(page.locator('.rv-foot')).not.toContainText(en('Tudo em ordem'));
    await expect(page.locator('.rv-foot')).toContainText(en('Verificação indisponível'));
    await page.locator('.rv-foot .btn.primary').click();
    await expect(page.locator('.pr-check')).toHaveCount(1);
    await page.getByRole('button', { name: en('Voltar'), exact: true }).first().click();
    await expect(page.locator('.fl-title')).not.toHaveText(en('Não foi possível verificar a segurança.'));
  });

  test('when every Files scan step fails the results say so instead of "nothing found"', async ({ page }) => {
    const boom = `() => { throw 'falhou'; }`;
    await boot(page, `{ scan_large_at: ${boom}, scan_downloads: ${boom}, scan_duplicates: ${boom}, scan_similar: ${boom}, cloud_scan: ${boom} }`);
    await nav(page, 'Arquivos').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('.fl-title')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.fl-title')).toHaveText(en('Não foi possível analisar.'));
    await expect(page.locator('.fl-tile-s').first()).toHaveText(en('Não foi possível analisar esta categoria.'));
    await expect(page.locator('.fl-all')).toHaveText(en('Analisar de novo'));
  });

  // The iCloud category of Files: a scan with empty results for the other categories, plus the given iCloud handlers.
  const FILES_EMPTY = '({ groups: [], total: 0, needsFda: false })';
  const cloudItem = (id, name, size, selected = false) => `{ id: ${id}, name: '${name}', path: '/Users/u/Library/Mobile Documents/${name}', size: ${size}, selected: ${selected}, note: null, modified: null, trash: false, accessed: null }`;
  const bootFiles = (page, extra) => boot(page, `{ scan_large_at: () => ${FILES_EMPTY}, scan_downloads: () => ${FILES_EMPTY}, scan_duplicates: () => ${FILES_EMPTY}, scan_similar: () => ${FILES_EMPTY}, ${extra} }`);
  const scanFiles = async (page) => { await nav(page, 'Arquivos').click(); await page.locator('#dock .go').click(); await expect(page.locator('.fl-tiles')).toBeVisible({ timeout: 8000 }); };

  test('cancelling the iCloud eviction in Files keeps the selection made in the review', async ({ page }) => {
    await bootFiles(page, `cloud_scan: () => ({ total: 100 + 600e6, needsFda: false, groups: [{ id: 'g', title: 'Documentos', description: '', total: 100 + 600e6, items: [${cloudItem(1, 'c.txt', 100)}, ${cloudItem(2, 'big.mov', 600e6)}] }] })`);
    await scanFiles(page);
    await page.locator('.fl-tile[data-cat="icloud"] .btn').click();
    await page.getByRole('checkbox', { name: en('Selecionar {name}', { name: 'c.txt' }) }).click();
    await expect(page.locator('.rv-sel')).not.toContainText(en('Nenhum item selecionado'));
    const act = page.locator('.rv-foot .btn.primary');
    await expect(act).toHaveText(en('Remover do Mac'));
    await act.click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Cancelar') }).click();
    await expect(page.locator('.rv-sel')).not.toContainText(en('Nenhum item selecionado'));
    await expect(page.getByRole('checkbox', { name: en('Selecionar {name}', { name: 'c.txt' }) })).toBeChecked();
  });

  test('the iCloud category evicts through cloud_evict (never the Trash), keeps its own selection and refreshes the disk', async ({ page }) => {
    await bootFiles(page, `cloud_scan: () => ({ total: 600e6, needsFda: false, groups: [{ id: 'g', title: 'Documentos', description: '', total: 600e6, items: [${cloudItem(2, 'big.mov', 600e6)}] }] }),
      cloud_evict: ({ ids }) => ({ freed: 600e6, outcomes: ids.map((id) => ({ id, ok: true, freed: 600e6, error: null })) })`);
    await scanFiles(page);
    await page.locator('.fl-tile[data-cat="icloud"] .btn').click();
    // The Trash action of the other categories stays out of this category: nothing selected there, own label here.
    await expect(page.locator('.rv-foot .btn.primary')).toHaveAttribute('data-act', 'evict');
    await expect(page.locator('.rv-foot .btn.primary')).toBeDisabled();
    await page.getByRole('checkbox', { name: en('Selecionar {name}', { name: 'big.mov' }) }).click();
    const disk = (await calls(page, 'disk_overview')).length;
    await page.locator('.rv-foot .btn.primary').click();
    await expect(page.getByRole('alertdialog')).toContainText(en('Os arquivos continuam no iCloud'));
    await page.getByRole('alertdialog').getByRole('button', { name: en('Remover do Mac') }).click();
    await expect(page.locator('.big-cap')).toHaveText(en('liberados neste Mac'), { timeout: 8000 });
    await expect(page.locator('.stage .sub')).toContainText(en('Os arquivos continuam no iCloud e baixam de novo quando você abrir.'));
    expect((await calls(page, 'cloud_evict')).map((c) => c.args.ids)).toEqual([[2]]);
    expect(await calls(page, 'remove')).toHaveLength(0);
    expect((await calls(page, 'disk_overview')).length).toBeGreaterThan(disk);
  });

  test('the iCloud category shows the "Optimize Mac Storage" state and what is not deleted', async ({ page }) => {
    for (const [value, expected] of [[true, 'true'], [false, 'false'], [null, 'unknown']]) {
      await bootFiles(page, `cloud_scan: () => ({ total: 600e6, needsFda: false, groups: [{ id: 'g', title: 'Documentos', description: '', total: 600e6, items: [${cloudItem(2, 'big.mov', 600e6)}] }] }), cloud_optimize_status: () => ${value}`);
      await scanFiles(page);
      await page.locator('.fl-tile[data-cat="icloud"] .btn').click();
      const note = page.locator('.fm-cloud-note');
      await expect(note).toContainText(en('Nada é apagado do iCloud.'));
      await expect(note).toHaveAttribute('data-optimize', expected);
      if (value === false) await expect(note).toContainText(en('Otimizar Armazenamento do Mac está desativado. Ative em Ajustes do Sistema › Apple ID › iCloud › Drive para o macOS liberar esses arquivos sozinho quando faltar espaço.'));
      if (value === true) await expect(note).toContainText(en('Otimizar Armazenamento do Mac está ativado: o macOS também libera esses arquivos sozinho quando falta espaço.'));
      if (value === null) await expect(page.locator('.fm-cloud-opt')).toHaveCount(0);
    }
  });

  test('iCloud in Files: empty and needs-access states', async ({ page }) => {
    await bootFiles(page, `cloud_scan: () => ({ total: 0, needsFda: false, groups: [] })`);
    await scanFiles(page);
    await expect(page.locator('.fl-tile[data-cat="icloud"]')).toHaveClass(/none/);
    await expect(page.locator('.fl-tile[data-cat="icloud"] .fl-tile-s')).toHaveText(en('Nenhum arquivo grande do iCloud Drive baixado neste Mac.'));
    await boot(page, `{ scan_large_at: () => ${FILES_EMPTY}, scan_downloads: () => ${FILES_EMPTY}, scan_duplicates: () => ({ total: 400, needsFda: false, groups: [{ id: 'd', title: 'Arquivo', description: '', total: 200, items: [${cloudItem(11, 'a', 100)}, ${cloudItem(12, 'b', 100)}] }] }), scan_similar: () => ${FILES_EMPTY}, cloud_scan: () => ({ total: 0, needsFda: true, groups: [] }) }`);
    await scanFiles(page);
    const tile = page.locator('.fl-tile[data-cat="icloud"]');
    await expect(tile.locator('.fl-tile-s')).toHaveText(en('O macOS protege o iCloud Drive. Conceda Acesso Total ao Disco para listar os arquivos baixados.'));
    await expect(tile.getByRole('button', { name: en('Abrir Ajustes') })).toBeVisible();
    // Reachable from the manager's category list too, with the access guide instead of an empty list.
    await page.locator('.fl-tile[data-cat="dups"] .btn').click();
    await page.locator('.fm-cat[data-fk="cat:icloud"]').click();
    await expect(page.locator('.fm-fda')).toContainText(en('Acesso Total ao Disco necessário'));
  });

  test('moving to the Trash in Files never includes iCloud selections', async ({ page }) => {
    await bootFiles(page, `cloud_scan: () => ({ total: 600e6, needsFda: false, groups: [{ id: 'g', title: 'Documentos', description: '', total: 600e6, items: [${cloudItem(2, 'big.mov', 600e6)}] }] }),
      scan_downloads: () => ({ total: 50, needsFda: false, groups: [{ id: 'dl', title: 'Outros', description: '', total: 50, items: [${cloudItem(7, 'x.zip', 50)}] }] })`);
    await scanFiles(page);
    await page.locator('.fl-tile[data-cat="icloud"] .btn').click();
    await page.getByRole('checkbox', { name: en('Selecionar {name}', { name: 'big.mov' }) }).click();
    await page.locator('.fm-cat[data-fk="cat:dl"]').click();
    await expect(page.locator('.rv-sel')).toContainText(en('Nenhum item selecionado')); // the iCloud pick does not leak in
    await expect(page.locator('.rv-foot .btn.primary')).toHaveAttribute('data-act', 'trash');
    await page.getByRole('checkbox', { name: en('Selecionar {name}', { name: 'x.zip' }) }).click();
    await page.locator('.rv-foot .btn.primary').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Mover para o Lixo') }).click();
    await expect(page.locator('.big-cap')).toHaveText(en('movidos para o Lixo'), { timeout: 8000 });
    expect((await calls(page, 'remove')).map((c) => c.args.ids)).toEqual([[7]]);
    expect(await calls(page, 'cloud_evict')).toHaveLength(0);
  });
});

test.describe('gauntlet round 3 (motion)', () => {
  test.use({ reducedMotion: 'no-preference' });
  const bursts = (page) => page.evaluate(() => window.__bursts);
  const countBursts = (page) => page.addInitScript(() => {
    window.__bursts = 0;
    new MutationObserver((l) => l.forEach((m) => m.addedNodes.forEach((n) => { if (n.classList && n.classList.contains('mo-fx')) window.__bursts++; })))
      .observe(document, { childList: true, subtree: true });
  });

  test('a partial success celebrates only after the failures sheet is dismissed', async ({ page }) => {
    await countBursts(page);
    await boot(page, JUNK.replace(/remove: \(\{ ids \}\) => \(\{[^\n]*\n/, "remove: ({ ids }) => ({ freed: 0, outcomes: ids.map((id) => ({ id, ok: id === 1, freed: 1000, error: 'em uso' })) }),\n"));
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: en('Alguns itens não foram removidos') })).toBeVisible();
    await page.waitForTimeout(600);
    expect(await bursts(page)).toBe(0);
    await page.getByRole('button', { name: en('Entendi') }).click();
    await expect.poll(() => bursts(page)).toBe(1);
  });

  test('switching the Security area repaints in place without replaying the rise', async ({ page }) => {
    await boot(page, SECURITY);
    await nav(page, 'Segurança').click();
    await page.locator('#dock .go').click();
    await page.locator('.pr-tile[data-area="perms"] button').click();
    await page.waitForTimeout(700);
    await page.locator('.seg button').first().click();
    const anims = await page.evaluate(() => document.querySelector('.pr-manager').getAnimations().map((a) => a.animationName));
    expect(anims).not.toContain('rise');
  });

  test('locking the sidebar fades the other items instead of snapping them', async ({ page }) => {
    await boot(page, SLOW_JUNK(900));
    await nav(page, 'Entulho').click();
    await page.evaluate(() => {
      window.__ops = new Set();
      const el = [...document.querySelectorAll('.nav-item')].find((b) => b.dataset.id === 'trash');
      const tick = () => { window.__ops.add(Number(getComputedStyle(el).opacity).toFixed(2)); requestAnimationFrame(tick); };
      tick();
    });
    await page.locator('#dock .go').click();
    await expect(page.getByRole('button', { name: en('Revisar todo o lixo') })).toBeVisible({ timeout: 8000 });
    const seen = (await page.evaluate(() => [...window.__ops])).map(Number);
    expect(seen.some((v) => v > 0.46 && v < 0.99)).toBe(true);
  });

  test('a second toast grows into the stack instead of pushing the first one up in a single frame', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { setTimeout(() => Promise.reject(new Error('first problem'))); });
    await expect(page.locator('.toast')).toHaveCount(1);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      window.__tops = [];
      const first = document.querySelector('.toast');
      const tick = () => { window.__tops.push(first.getBoundingClientRect().top); if (window.__tops.length < 40) requestAnimationFrame(tick); };
      tick();
      setTimeout(() => Promise.reject(new Error('second problem')));
    });
    await expect(page.locator('.toast')).toHaveCount(2);
    await page.waitForTimeout(700);
    const tops = await page.evaluate(() => window.__tops);
    const full = tops[0] - tops[tops.length - 1];
    expect(full).toBeGreaterThan(20);
    const maxStep = Math.max(...tops.slice(1).map((v, i) => Math.abs(v - tops[i])));
    expect(maxStep).toBeLessThan(full * 0.7);
  });

  test('re-entering a finished screen does not count its hero up again', async ({ page }) => {
    await boot(page, JUNK);
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
    await expect(page.getByRole('button', { name: en('Concluir') })).toBeVisible();
    await page.waitForTimeout(1200);
    const final = await page.locator('.big').first().textContent();
    await nav(page, 'Lixeira').click();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__bigs = [];
      const tick = () => { const b = document.querySelector('.big'); if (b) window.__bigs.push(b.textContent); if (window.__bigs.length < 40) requestAnimationFrame(tick); };
      document.querySelector('#nav .nav-item[data-id="clean"]').click();
      tick();
    });
    await page.waitForTimeout(900);
    const bigs = await page.evaluate(() => window.__bigs);
    expect(bigs.length).toBeGreaterThan(0);
    expect(new Set(bigs)).toEqual(new Set([final]));
  });
});

test.describe('gauntlet round 3 (sound)', () => {
  test('the "restored" confirmation after Undo is not ducked by the cleanup cue', async ({ page }) => {
    await recordTones(page);
    await boot(page, JUNK.replace('{', '{ ' + SOUND_ON + ','));
    await scanJunk(page);
    await page.locator('#dock .go').click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Limpar'), exact: true }).click();
    const undo = page.getByRole('button', { name: en('Desfazer') });
    await expect(undo).toBeVisible();
    await page.evaluate(() => { window.__tones = []; });
    await undo.click();
    await expect(page.locator('.toast').filter({ hasText: en('{n} item restaurado', { n: 1 }) })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__tones)).toContain(1319); // 'ok'
  });

  test('typing in a text field does not wake the audio device', async ({ page }) => {
    await page.addInitScript(() => {
      window.__resumes = 0;
      const C = window.AudioContext || window.webkitAudioContext;
      const orig = C.prototype.resume;
      C.prototype.resume = function () { window.__resumes++; return orig.call(this); };
    });
    await boot(page, JUNK.replace('{', '{ ' + SOUND_ON + ','));
    await scanJunk(page); // cues create the context
    await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
    await page.waitForTimeout(3400); // voices and reverb tail are over: the context is suspended
    const before = await page.evaluate(() => window.__resumes);
    await page.locator('.search input').click();
    await page.keyboard.type('a b c');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__resumes)).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------
test.describe('gauntlet round 4', () => {
  test.use({ reducedMotion: 'no-preference' });
  // JUNK with a slow scan: the busy state lasts `ms`.
  const slowJunk = (ms) => `(() => { const J = ${JUNK}; return { ...J, scan_junk: async (...a) => { await new Promise((r) => setTimeout(r, ${ms})); return J.scan_junk(...a); } }; })()`;
  const withSound = (src) => src.replace('{', '{ ' + SOUND_ON + ',');
  // Oscillator start frequencies with the instant they were scheduled.
  async function recordTimes(page) {
    await recordTones(page);
    await page.addInitScript(() => {
      window.__tt = [];
      const orig = AudioParam.prototype.setValueAtTime;
      AudioParam.prototype.setValueAtTime = function (v, t) { if (this.__osc) window.__tt.push([Math.round(v), performance.now()]); return orig.call(this, v, t); };
    });
  }

  test('busy indicators keep turning while the window is unfocused and pause only when it is hidden', async ({ page }) => {
    await boot(page, slowJunk(4000));
    await nav(page, 'Entulho').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('#dock .go.busy')).toHaveCount(1);
    const state = () => page.locator('#dock .go-ring').evaluate((el) => getComputedStyle(el).animationPlayState);
    await page.evaluate(() => document.body.classList.add('idle'));
    expect(await state()).toBe('running');
    await page.evaluate(() => document.body.classList.add('hidden'));
    expect(await state()).toBe('paused');
  });

  test('the dock ring keeps its spin (paused) when the busy state ends, so it fades in place', async ({ page }) => {
    await boot(page, JUNK);
    await nav(page, 'Entulho').click();
    await page.locator('#dock .go').click();
    await expect(page.getByRole('button', { name: en('Revisar todo o lixo') })).toBeVisible();
    await expect(page.locator('#dock .go.busy')).toHaveCount(0);
    const anim = await page.locator('#dock .go-ring').evaluate((el) => { const cs = getComputedStyle(el); return [cs.animationName, cs.animationPlayState]; });
    expect(anim).toEqual(['go-spin', 'paused']);
  });

  test('the round button fades its opacity together with its filter when disabled', async ({ page }) => {
    await boot(page);
    const tp = await page.locator('#dock .go').evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(tp).toContain('opacity');
  });

  test('pressing Stop with the keyboard keeps focus on the dock button', async ({ page }) => {
    await boot(page, slowJunk(1500));
    await nav(page, 'Entulho').click();
    const go = page.locator('#dock .go');
    await go.click();
    await expect(page.locator('#dock .go.busy')).toHaveCount(1);
    await go.focus();
    await page.keyboard.press('Enter');
    await expect(go).toHaveAttribute('aria-disabled', 'true');
    await expect(go).toBeFocused();
    await expect(go).not.toHaveAttribute('aria-disabled', 'true', { timeout: 8000 }); // the scan settled
    await expect(go).toBeFocused();
  });

  test('a hero that did not change is not counted up again when a manager goes Back', async ({ page }) => {
    await boot(page, `{ scan_trash: () => ({ total: 6e9, needsFda: false, groups: [{ id: 'trash', title: 'x', description: '', total: 6e9, items: [{ id: 1, name: 'big.mov', path: '/Users/u/.Trash/big.mov', size: 6e9, selected: true, note: null, modified: null, trash: false, accessed: null }] }] }) }`);
    await nav(page, 'Lixeira').click();
    await page.waitForTimeout(300);
    await page.locator('#dock .go').click();
    await expect(page.getByRole('button', { name: en('Revisar itens') })).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(1200);
    const final = await page.locator('.big').first().textContent();
    expect(final).toContain('6');
    await page.getByRole('button', { name: en('Revisar itens') }).click();
    await page.locator('.mgr-back').click();
    await page.evaluate(() => {
      window.__bigs = [];
      const tick = () => { const b = document.querySelector('.big'); if (b) window.__bigs.push(b.textContent); if (window.__bigs.length < 40) requestAnimationFrame(tick); };
      tick();
    });
    await page.waitForTimeout(900);
    const bigs = await page.evaluate(() => window.__bigs);
    expect(bigs.length).toBeGreaterThan(0);
    expect(new Set(bigs)).toEqual(new Set([final]));
  });

  test('a group checkbox in the review animates in place instead of being re-created', async ({ page }) => {
    await boot(page, JUNK);
    await scanJunk(page);
    await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
    const cb = page.locator('.rv-group .cb').first();
    await cb.evaluate((el) => { el.dataset.mark = '1'; });
    await cb.click();
    await expect(page.locator('.rv-group .cb[data-mark="1"]')).toHaveCount(1); // the same node
    expect(await page.locator('.rv-group .cb[data-mark="1"]').evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
    // Selecting a row refreshes the group checkbox state in place too.
    await page.locator('.rv-item .cb').first().click();
    await expect(page.locator('.rv-group .cb[data-mark="1"]')).toHaveCount(1);
  });

  test('finishing an iCloud eviction in Files keeps the orb that was floating', async ({ page }) => {
    const FILES_EMPTY = '({ groups: [], total: 0, needsFda: false })';
    const item = (id, name, size) => `{ id: ${id}, name: '${name}', path: '/Users/u/Library/Mobile Documents/${name}', size: ${size}, selected: true, note: null, modified: null, trash: false, accessed: null }`;
    await boot(page, `{ scan_large_at: () => ${FILES_EMPTY}, scan_downloads: () => ${FILES_EMPTY}, scan_duplicates: () => ${FILES_EMPTY}, scan_similar: () => ${FILES_EMPTY},
      cloud_scan: () => ({ total: 600e6, needsFda: false, groups: [{ id: 'g', title: 'Documentos', description: '', total: 600e6, items: [${item(2, 'big.mov', 600e6)}] }] }),
      cloud_evict: async () => { await new Promise((r) => setTimeout(r, 600)); return { freed: 600e6, outcomes: [{ id: 2, ok: true, freed: 600e6, error: null }] }; } }`);
    await nav(page, 'Arquivos').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('.fl-tile[data-cat="icloud"] .btn')).toBeVisible({ timeout: 8000 });
    await page.locator('.fl-tile[data-cat="icloud"] .btn').click();
    await page.getByRole('checkbox', { name: en('Selecionar {name}', { name: 'big.mov' }) }).click();
    await page.locator('.rv-foot .btn.primary').click();
    await page.getByRole('alertdialog').getByRole('button').last().click();
    await expect(page.locator('.orb.busy')).toHaveCount(1);
    await page.locator('.orb').evaluate((el) => { el.dataset.mark = '1'; });
    await expect(page.getByRole('button', { name: en('Concluir') })).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.orb[data-mark="1"]')).toHaveCount(1);
  });

  test('cached app icons are mounted at once (no placeholder flash, no fade replay) when the list is rebuilt', async ({ page }) => {
    const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAACAkQBADs=';
    await boot(page, `{ list_apps: () => [{ id: 1, name: 'Alpha', path: '/Applications/Alpha.app', size: 5000, bundleId: 'x.alpha', running: false, version: '1', kind: 'app' }, { id: 2, name: 'Beta', path: '/Applications/Beta.app', size: 4000, bundleId: 'x.beta', running: false, version: '1', kind: 'app' }],
      app_meta: () => [], app_icon: () => '${GIF}' }`);
    await nav(page, 'Aplicativos').click();
    await page.getByRole('button', { name: en('Ver meus aplicativos') }).click();
    await expect(page.locator('.am-row .app-ic img')).toHaveCount(2);
    await page.locator('.search input').fill('a'); // rebuilds the list
    await expect(page.locator('.am-row .app-ic img.cached')).toHaveCount(2);
    const names = await page.locator('.am-row .app-ic img.cached').evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName));
    expect(names).toEqual(['none', 'none']);
  });

  const APP_ONE = `list_apps: () => [{ id: 1, name: 'Alpha', path: '/Applications/Alpha.app', size: 5000, bundleId: 'x.alpha', running: false, version: '1', kind: 'app' }],
    apps_overview: () => ({ updates: [], unused: [], leftovers: { total: 0, needsFda: false, groups: [] }, installers: { total: 0, needsFda: false, groups: [] } }), app_meta: () => []`;

  test('a failed leftovers scan shows a retry instead of an endless spinner', async ({ page }) => {
    await boot(page, `{ ${APP_ONE}, app_leftovers: (a, calls) => { if (calls.filter((c) => c.cmd === 'app_leftovers').length < 2) throw 'falhou'; return { total: 0, needsFda: false, groups: [] }; } }`);
    await nav(page, 'Aplicativos').click();
    await page.getByRole('button', { name: en('Ver meus aplicativos') }).click();
    await page.locator('.am-row .am-chev').first().click();
    const res = page.locator('.am-res');
    await expect(res).toContainText(en('Não foi possível procurar os restos.'));
    await expect(res).not.toContainText(en('Procurando restos…'));
    await res.getByRole('button', { name: en('Tentar de novo') }).click();
    await expect(res).toContainText(en('Nenhum resto encontrado.'));
    expect(await calls(page, 'app_leftovers')).toHaveLength(2);
  });

  test('a double click on Update opens each vendor page once', async ({ page }) => {
    await boot(page, `{ ${APP_ONE.replace('updates: []', "updates: [{ appId: 1, current: '1', latest: '2', downloadUrl: 'https://a.example/x', notesUrl: null }]")}, open_update: () => null }`);
    await nav(page, 'Aplicativos').click();
    await page.getByRole('button', { name: en('Ver meus aplicativos') }).click();
    await page.locator('.mgr-back').click().catch(() => {});
    await page.locator('#dock .go').click();
    const upd = page.getByRole('button', { name: en('Atualizar||update') }).first();
    await expect(upd).toBeVisible({ timeout: 8000 });
    await upd.dblclick();
    await page.waitForTimeout(700);
    expect(await calls(page, 'open_update')).toHaveLength(1);
  });

  test('a failed permissions read does not read as "nothing found" or "protected"', async ({ page }) => {
    await boot(page, `{ security_checks: () => [], tcc_permissions: () => { throw 'falhou'; }, privacy_scan: () => { throw 'falhou'; } }`);
    await nav(page, 'Segurança').click();
    await page.locator('#dock .go').click();
    await expect(page.locator('.fl-title')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.fl-title')).not.toHaveText(en('Seu Mac está protegido.'));
    await expect(page.locator('.pr-tile[data-area="perms"]')).toContainText(en('Não foi possível ler as permissões.'));
    await expect(page.locator('.pr-tile[data-area="privacy"]')).toContainText(en('Não foi possível ler os itens de privacidade.'));
    await expect(page.locator('.pr-tile[data-area="perms"]').getByRole('button', { name: en('Analisar de novo') })).toBeVisible();
  });

  test('removing only Recent Items does not warn about signing in again', async ({ page }) => {
    await boot(page, `{ security_checks: () => [], tcc_permissions: () => ({ needsFda: false, groups: [], cameraMicApps: 0, apps: 0 }),
      privacy_scan: () => ({ needsFda: false, total: 10, browsers: [], groups: [{ id: 'recent', title: 'Itens recentes', description: '', total: 10, items: [{ id: 5, name: 'com.apple.LSSharedFileList.RecentDocuments.sfl3', path: '/Users/u/x.sfl3', size: 10, selected: true, note: null }] }] }),
      privacy_remove: ({ ids }) => ({ freed: 10, outcomes: ids.map((id) => ({ id, ok: true, freed: 10, error: null })) }) }`);
    await nav(page, 'Segurança').click();
    await page.locator('#dock .go').click();
    await page.locator('.pr-tile[data-area="privacy"]').getByRole('button', { name: en('Remover') }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: en('Mover para o Lixo') }).click();
    await expect(page.getByRole('button', { name: en('Concluir') })).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.stage-text')).not.toContainText(en('Pode ser preciso entrar de novo em alguns sites.'));
  });

  test('Duplicates: the only open set can be collapsed', async ({ page }) => {
    const it = (id, name) => `{ id: ${id}, name: '${name}', path: '/Users/u/${name}', size: 100, selected: false, note: null, modified: 1, trash: false, accessed: null }`;
    const grp = (id, n) => `{ id: 'g${id}', title: 'Arquivo ${id}', description: '', total: 200, items: [${it(id * 10 + 1, 'a' + n)}, ${it(id * 10 + 2, 'b' + n)}] }`;
    const empty = '({ groups: [], total: 0, needsFda: false })';
    await boot(page, `{ scan_large_at: () => ${empty}, scan_downloads: () => ${empty}, scan_similar: () => ${empty}, scan_duplicates: () => ({ total: 400, needsFda: false, groups: [${grp(1, 1)}, ${grp(2, 2)}] }) }`);
    await nav(page, 'Arquivos').click();
    await page.locator('#dock .go').click();
    await page.locator('.fl-tile[data-cat="dups"] .btn').click();
    const heads = page.locator('.fm-set-head');
    await expect(heads.first()).toHaveAttribute('aria-expanded', 'true');
    await heads.first().click();
    await expect(heads.first()).toHaveAttribute('aria-expanded', 'false');
    await heads.nth(1).click();
    await heads.nth(1).click();
    await expect(heads.first()).toHaveAttribute('aria-expanded', 'false');
    await expect(heads.nth(1)).toHaveAttribute('aria-expanded', 'false');
  });

  test.describe('sound', () => {
    test('the first press builds the audio context and one wake resumes it once', async ({ page }) => {
      await page.addInitScript(() => {
        window.__ac = { made: 0, resumes: 0 };
        const C = window.AudioContext || window.webkitAudioContext;
        const orig = C.prototype.resume;
        C.prototype.resume = function () { window.__ac.resumes++; return orig.call(this); };
        const Sub = class extends C { constructor(...a) { super(...a); window.__ac.made++; } };
        window.AudioContext = Sub; window.webkitAudioContext = Sub;
      });
      await boot(page, withSound(JUNK));
      expect(await page.evaluate(() => window.__ac.made)).toBe(0);
      const item = page.locator('#nav .nav-item').nth(1);
      await item.hover();
      await page.mouse.down();
      expect(await page.evaluate(() => window.__ac.made)).toBe(1); // created on the press, before the click
      await page.mouse.up();
      await page.waitForTimeout(3600); // voices and reverb tail are over: the context is suspended
      await page.evaluate(() => { window.__ac.resumes = 0; });
      const other = page.locator('#nav .nav-item').nth(2);
      await other.hover();
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.__ac.resumes)).toBe(1);
    });

    test('a fast scan does not stack the found cue on the start cue', async ({ page }) => {
      await recordTimes(page);
      await boot(page, withSound(JUNK));
      await nav(page, 'Entulho').click();
      await page.waitForTimeout(400);
      await page.evaluate(() => { window.__tt = []; });
      await page.locator('#dock .go').click();
      await expect(page.getByRole('button', { name: en('Revisar todo o lixo') })).toBeVisible();
      await page.waitForTimeout(900);
      const tt = await page.evaluate(() => window.__tt);
      const start = tt.find(([f]) => f === 784);
      const found = tt.find(([f, t]) => f === 1047 && start && t > start[1]);
      expect(start).toBeTruthy();
      expect(found).toBeTruthy();
      expect(found[1] - start[1]).toBeGreaterThanOrEqual(400);
    });

    const openRowMenu = async (page) => {
      await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
      const more = page.locator('.rv-item .rv-act[aria-haspopup="menu"]').first();
      await more.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.ctx-menu')).toBeVisible();
      await page.waitForTimeout(300);
      await page.evaluate(() => { window.__tones = []; });
    };

    test('a context-menu item that answers with a toast plays no menu tick on top of it', async ({ page }) => {
      await recordTones(page);
      await boot(page, withSound(JUNK));
      await scanJunk(page);
      await openRowMenu(page);
      await page.getByRole('menuitem', { name: en('Ignorar') }).click();
      await expect(page.locator('.toast')).toBeVisible();
      await page.waitForTimeout(500);
      const tones = await page.evaluate(() => window.__tones);
      expect(tones).toContain(1319); // 'ok'
      expect(tones).not.toContain(2093); // 'menu'
    });

    test('Select from the context menu ticks like the checkbox', async ({ page }) => {
      await recordTones(page);
      await boot(page, withSound(JUNK));
      await scanJunk(page);
      await openRowMenu(page);
      await page.getByRole('menuitem', { name: en('Selecionar'), exact: true }).click(); // the first row (largest) starts unselected
      await page.waitForTimeout(500);
      const tones = await page.evaluate(() => window.__tones);
      expect(tones).toContain(1976); // 'tick'
      expect(tones).not.toContain(2093);
    });

    test('favoriting a tool with the star ticks', async ({ page }) => {
      await recordTones(page);
      await boot(page, `{ ${SOUND_ON} }`);
      await nav(page, 'Ferramentas').click();
      await page.waitForTimeout(500);
      await page.evaluate(() => { window.__tones = []; });
      await page.locator('.tl-star').nth(1).click();
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => window.__tones)).toContain(1976); // 'tick'
    });
  });
});

test.describe('native look', () => {
  test('the sidebar turns translucent only when the backend reports the native material', async ({ page }) => {
    await boot(page, '{ sidebar_vibrancy: () => true }');
    await expect(page.locator('html')).toHaveClass(/vfx/);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  });

  test('without the native material the sidebar and body stay opaque', async ({ page }) => {
    await boot(page);
    await expect(page.locator('html')).not.toHaveClass(/vfx/);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toContain('linear-gradient');
  });

  test('the row menu is native when the Tauri menu API exists', async ({ page }) => {
    await boot(page, JUNK, { nativeMenu: true });
    await scanJunk(page);
    await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
    await page.locator('.rv-item').first().click({ button: 'right' });
    await expect.poll(() => page.evaluate(() => window.__menus.length)).toBe(1);
    await expect(page.locator('.ctx-menu')).toHaveCount(0);
    const items = await page.evaluate(() => window.__menus[0].items.map((i) => ({ kind: i.kind, text: i.text, enabled: i.enabled })));
    expect(items.filter((i) => i.kind !== 'Predefined').map((i) => i.text)).toEqual(
      expect.arrayContaining([en('Selecionar'), en('Mostrar no Finder'), en('Visualização Rápida'), en('Ignorar')]));
    expect(items.some((i) => i.kind === 'Predefined')).toBe(true); // the separator before "Ignore"
    expect(await page.evaluate(() => window.__menus[0].at.type)).toBe('Logical');
    // Picking an entry runs the same handler as the DOM menu.
    await page.evaluate((txt) => window.__menus[0].items.find((i) => i.text === txt).action(), en('Mostrar no Finder'));
    expect((await calls(page, 'reveal')).length).toBe(1);
  });

  test('the button menu is native too, with its current choice checked', async ({ page }) => {
    await boot(page, JUNK, { nativeMenu: true });
    await scanJunk(page);
    await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
    await page.locator('.sel-btn').first().click();
    await expect.poll(() => page.evaluate(() => window.__menus.length)).toBe(1);
    await expect(page.locator('.ctx-menu')).toHaveCount(0);
    const kinds = await page.evaluate(() => window.__menus[0].items.map((i) => [i.kind, !!i.checked]));
    expect(kinds.every(([k]) => k === 'CheckMenuItem')).toBe(true);
    expect(kinds.some(([, c]) => c)).toBe(true);
    await expect(page.locator('.sel-btn').first()).toHaveAttribute('aria-expanded', 'false');
  });

  test('a menu that cannot be shown natively falls back to the HTML menu', async ({ page }) => {
    await boot(page, JUNK, { nativeMenu: true });
    await page.evaluate(() => { window.__TAURI__.menu.Menu.new = () => Promise.reject(new Error('denied')); });
    await scanJunk(page);
    await page.getByRole('button', { name: en('Revisar todo o lixo') }).click();
    await page.locator('.rv-item').first().click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible();
  });
});
