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
  expect(tones.includes(247) || tones.includes(233)).toBe(true);
  expect(tones.includes(247) && tones.includes(233)).toBe(false); // 'err' (toast) and 'error' (view) never both
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
  expect(tones).toContain(233); // 'error'
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
  expect(tones).toContain(247); // 'warn'
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
  expect(tones).not.toContain(247);
  expect(tones).not.toContain(196);
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
