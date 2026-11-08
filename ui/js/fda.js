// Full Disk Access onboarding: what it unlocks, how to grant it, and noticing when it was granted.
// macOS applies the grant to new file accesses, but some versions only after the app reopens, so after the user
// visited System Settings and came back without access, the guide offers "Reopen Limpae".
import { h } from './dom.js';
import { api, call } from './api.js';
import { confirmDialog, toast } from './ui.js';
import { t } from './i18n.js';

const KEY_SEEN = 'limpae.fda.onboarded';
const KEY_VISITED = 'limpae.fda.visited';
const get = (k) => { try { return localStorage.getItem(k) === '1'; } catch (e) { return false; } };
const set = (k, v) => { try { if (v) localStorage.setItem(k, '1'); else localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } };

export const visitedSettings = () => get(KEY_VISITED);
export const relaunch = () => call('relaunch').catch(() => {});

// "Reopen Limpae" wherever access is asked for, once the user has been to System Settings: dismissing the
// sidebar banner must not remove the only way to relaunch. Null before that visit.
export function reopenButton(cls = 'btn') {
  return visitedSettings() ? h('button', { class: cls, type: 'button', onClick: relaunch }, t('Reabrir o Limpae')) : null;
}

export function openSettings() {
  set(KEY_VISITED, true);
  return api.openFda().catch(() => {});
}

function body() {
  const step = (n, text) => h('li', null, h('span', { class: 'fda-n', 'aria-hidden': 'true' }, String(n)), h('span', null, text));
  return h('div', { class: 'fda-guide' },
    h('p', null, t('O macOS protege a Lixeira, os anexos do Mail e parte de ~/Library. Sem esse acesso, o Limpae mostra menos do que existe.')),
    h('ol', { class: 'fda-steps' },
      step(1, t('Clique em Abrir Ajustes.')),
      step(2, t('Ative o Limpae na lista (ou use + e escolha o app em Aplicativos).')),
      step(3, t('Volte para cá. Se o macOS pedir, reabra o Limpae.'))),
    visitedSettings() ? h('p', { class: 'fda-fine' }, t('Já ativou o Limpae? Alguns macOS só aplicam o acesso depois que o app reabre.') + ' ', reopenButton('link')) : null,
    h('p', { class: 'fda-fine' }, t('O Limpae só lê seus arquivos até você confirmar uma limpeza, e não usa a rede.')));
}

// Returns true if the user went to System Settings.
export async function showGuide() {
  set(KEY_SEEN, true);
  const ok = await confirmDialog({ title: t('Conceder Acesso Total ao Disco'), body: body(), confirm: t('Abrir Ajustes'), cancel: t('Agora não'), glyph: 'lock' });
  if (ok) await openSettings();
  return !!ok;
}

// First launch without access: the guide shows once by itself. Resolves when it was closed (or not shown).
export function maybeOnboard(disk) {
  return disk && disk.fda === false && !get(KEY_SEEN) ? showGuide() : Promise.resolve(false);
}

// Called with the old and new disk overview: access just appeared → thank and let the caller refresh.
export function noticeGrant(before, after) {
  if (before && before.fda === false && after && after.fda === true) {
    set(KEY_VISITED, false);
    toast(t('Acesso Total ao Disco concedido. Analise de novo para ver tudo.'), 'ok');
    return true;
  }
  return false;
}
