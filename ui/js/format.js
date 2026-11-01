// Formatting in the interface language. Decimal units like Finder (1 GB = 1e9 bytes).
import { t, lazyIntl } from './i18n.js';

const nf0 = lazyIntl('NumberFormat', { maximumFractionDigits: 0 });
const nf1 = lazyIntl('NumberFormat', { maximumFractionDigits: 1 });
const rtf = lazyIntl('RelativeTimeFormat', { numeric: 'always' });
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const NB = ' ';

export function bytesParts(n) {
  let v = Math.max(0, Number(n) || 0);
  let i = 0;
  while (v >= 1000 && i < 4) { v /= 1000; i++; }
  if (i >= 2 && Math.round(v * 10) / 10 >= 1000 && i < 4) { v /= 1000; i++; }
  const fmt = i <= 1 || v >= 100 ? nf0 : nf1;
  return { value: fmt.format(v), unit: UNITS[i] };
}

export function fmtBytes(n) {
  const { value, unit } = bytesParts(n);
  return value + NB + unit;
}

export const fmtNum = (n) => nf0.format(n || 0);
export const plural = (n, one, many) => `${fmtNum(n)}${NB}${t(n === 1 ? one : many)}`; // i18n-dynamic

export function ageText(sec) {
  if (!sec) return '';
  const d = Date.now() / 1000 - sec;
  const steps = [['year', 31557600], ['month', 2629800], ['week', 604800], ['day', 86400]];
  for (const [unit, size] of steps) {
    if (d >= size) return t('modificado {when}', { when: rtf.format(-Math.floor(d / size), unit) });
  }
  return t('modificado hoje');
}

export const pct = (a, b) => (b > 0 ? Math.min(100, Math.max(0, (a / b) * 100)) : 0);
