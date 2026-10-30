// Formatação pt-BR. Unidades decimais como o Finder (1 GB = 1e9 bytes).
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'always' });
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
export const plural = (n, one, many) => `${fmtNum(n)}${NB}${n === 1 ? one : many}`;

export function ageText(sec) {
  if (!sec) return '';
  const d = Date.now() / 1000 - sec;
  const steps = [['year', 31557600], ['month', 2629800], ['week', 604800], ['day', 86400]];
  for (const [unit, size] of steps) {
    if (d >= size) return 'modificado ' + rtf.format(-Math.floor(d / size), unit);
  }
  return 'modificado hoje';
}

export const pct = (a, b) => (b > 0 ? Math.min(100, Math.max(0, (a / b) * 100)) : 0);
