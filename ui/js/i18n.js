// Internationalization: English (default), Brazilian Portuguese and Bahasa Indonesia. The key is the interface's own text in
// Portuguese: in 'pt' it comes out as is; in the other languages it comes from the dictionary (fallback: en, then the key).
// `{name}` marks a parameter. Backend texts (Rust, in Portuguese) go through `tr`.
import { DICT } from './i18n/dict/index.js';

export const LANGS = [
  { id: 'pt', label: 'Português (Brasil)', locale: 'pt-BR' },
  { id: 'en', label: 'English', locale: 'en-US' },
  { id: 'id', label: 'Bahasa Indonesia', locale: 'id-ID' },
];
let lang = 'en';
const listeners = new Set();

export const getLang = () => lang;
export const intlLocale = () => LANGS.find((l) => l.id === lang).locale;

/** Applies the `language` setting ('pt' | 'en' | 'id'; any other value becomes 'en'). Notifies listeners only if it changed. */
export function applyLangSetting(code) {
  const next = LANGS.some((l) => l.id === code) ? code : 'en';
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = intlLocale();
  listeners.forEach((f) => { try { f(lang); } catch (e) { /* a listener never breaks the switch */ } });
}

export function onLang(cb) { listeners.add(cb); return () => listeners.delete(cb); }

const fill = (s, p) => (p ? s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : s);
// The same Portuguese word with two meanings uses a context suffix: 'Atualizar||update'. In pt, the suffix is dropped.
const base = (key) => { const i = key.indexOf('||'); return i < 0 ? key : key.slice(0, i); };
const pick = (key) => { const e = lang === 'pt' ? null : DICT[key]; return e ? (e[lang] ?? e.en ?? base(key)) : base(key); };

export function t(key, params) { return fill(pick(key), params); }

/** Singular for n === 1, plural otherwise; `{n}` already comes filled in with the formatted number. */
export function tn(n, one, many, params) {
  return t(n === 1 ? one : many, { n: new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0 }).format(n || 0), ...params });
}

// Keys with `{param}` become patterns to match backend texts that arrive with the values already in place.
let patterns = null;
const trCache = new Map();
function compile() {
  patterns = [];
  for (const k of Object.keys(DICT)) {
    if (!/\{\w+\}/.test(k)) continue;
    const names = [];
    const src = k.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? (names.push(part), '(.+?)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    patterns.push({ re: new RegExp('^' + src + '$', 's'), names, key: k });
  }
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
}

// Values already formatted by Rust in pt-BR ('5,5 GB', '31/12/2025'): in English they become '5.5 GB' and '12/31/2025'.
// Nothing is translated here: the captured value may be a volume, app or file name.
function localeValue(v) {
  if (lang !== 'en') return v;
  if (/^\d+,\d+ (B|KB|MB|GB|TB)$/.test(v)) return v.replace(',', '.');
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  return d ? `${d[2]}/${d[1]}/${d[3]}` : v;
}

/** Translates backend text: exact lookup, then `{param}` patterns. Never use on disk names/paths. */
export function tr(s) {
  if (lang === 'pt' || typeof s !== 'string' || !s) return s;
  if (DICT[s]) return pick(s);
  const ck = lang + '\u0000' + s;
  if (trCache.has(ck)) return trCache.get(ck);
  if (!patterns) compile();
  let out = s;
  for (const p of patterns) {
    const m = p.re.exec(s);
    if (m) { out = fill(pick(p.key), Object.fromEntries(p.names.map((n, i) => [n, localeValue(m[i + 1])]))); break; }
  }
  trCache.set(ck, out);
  return out;
}

// Intl formatters created on demand and rebuilt when the language changes (modules are loaded before the language
// is known, so no `new Intl.X('pt-BR')` at the top of a file).
export function lazyIntl(kind, options) {
  let cachedLang = null, inst = null;
  const get = () => { if (cachedLang !== lang) { inst = new Intl[kind](intlLocale(), options); cachedLang = lang; } return inst; };
  return { format: (...a) => get().format(...a), formatToParts: (...a) => get().formatToParts(...a) };
}

/** Text comparison in the current language's order (replaces `localeCompare(x, 'pt-BR', …)`). */
export const cmp = (a, b, options = { sensitivity: 'base' }) => String(a).localeCompare(String(b), intlLocale(), options);
