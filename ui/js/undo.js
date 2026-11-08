// Restoring items that a removal sent to the Trash (the backend re-checks each move and never overwrites).
import { api } from './api.js';
import { toast, failuresSheet } from './ui.js';
import { t, tn } from './i18n.js';

// Returns how many items came back; failures are listed in the usual failures sheet.
export async function restoreBatches(batches) {
  let out;
  try { out = await api.restoreTrashed(batches); } catch (e) { return 0; }
  const ok = out.filter((o) => o.ok).length;
  const bad = out.filter((o) => !o.ok).map((o) => ({ name: o.from.split('/').pop(), path: o.from, error: o.error }));
  if (!out.length) toast(t('Nada para restaurar: os itens já saíram do Lixo.'), 'info');
  else if (ok) toast(tn(ok, '{n} item restaurado', '{n} itens restaurados'), 'ok');
  if (bad.length) {
    failuresSheet(bad, {
      title: t('Alguns itens não foram restaurados'),
      body: (n) => tn(n, '{n} item continua no Lixo.', '{n} itens continuam no Lixo.'),
    });
  }
  return ok;
}
