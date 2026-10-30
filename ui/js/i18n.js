// Internacionalização: inglês (padrão), português do Brasil e Bahasa Indonesia. A chave é o próprio texto em
// português da interface: em 'pt' ela sai como está; nos outros idiomas vem do dicionário (fallback: en, depois a chave).
// `{nome}` marca parâmetro. Textos do backend (Rust, em português) passam por `tr`.
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

/** Aplica o ajuste `language` ('pt' | 'en' | 'id'; qualquer outro valor vira 'en'). Avisa os ouvintes só se mudou. */
export function applyLangSetting(code) {
  const next = LANGS.some((l) => l.id === code) ? code : 'en';
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = intlLocale();
  listeners.forEach((f) => { try { f(lang); } catch (e) { /* ouvinte não derruba a troca */ } });
}

export function onLang(cb) { listeners.add(cb); return () => listeners.delete(cb); }

const fill = (s, p) => (p ? s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : s);
// Uma mesma palavra em português com dois sentidos usa sufixo de contexto: 'Atualizar||update'. Em pt, o sufixo cai.
const base = (key) => { const i = key.indexOf('||'); return i < 0 ? key : key.slice(0, i); };
const pick = (key) => { const e = lang === 'pt' ? null : DICT[key]; return e ? (e[lang] ?? e.en ?? base(key)) : base(key); };

export function t(key, params) { return fill(pick(key), params); }

/** Singular para n === 1, plural nos demais; `{n}` já vem preenchido com o número formatado. */
export function tn(n, one, many, params) {
  return t(n === 1 ? one : many, { n: new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0 }).format(n || 0), ...params });
}

// Chaves com `{param}` viram padrões para casar textos do backend que chegam já com os valores no lugar.
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

// Valores já formatados pelo Rust em pt-BR ('5,5 GB', '31/12/2025'): em inglês viram '5.5 GB' e '12/31/2025'.
// Nada é traduzido aqui: o valor capturado pode ser nome de volume, app ou arquivo.
function localeValue(v) {
  if (lang !== 'en') return v;
  if (/^\d+,\d+ (B|KB|MB|GB|TB)$/.test(v)) return v.replace(',', '.');
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  return d ? `${d[2]}/${d[1]}/${d[3]}` : v;
}

/** Traduz texto vindo do backend: busca exata, depois padrões com `{param}`. Nunca use em nomes/caminhos do disco. */
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

// Formatadores Intl criados sob demanda e refeitos quando o idioma muda (módulos são carregados antes de o idioma
// ser conhecido, então nada de `new Intl.X('pt-BR')` no topo de arquivo).
export function lazyIntl(kind, options) {
  let cachedLang = null, inst = null;
  const get = () => { if (cachedLang !== lang) { inst = new Intl[kind](intlLocale(), options); cachedLang = lang; } return inst; };
  return { format: (...a) => get().format(...a), formatToParts: (...a) => get().formatToParts(...a) };
}

/** Comparação de texto na ordem do idioma atual (substitui `localeCompare(x, 'pt-BR', …)`). */
export const cmp = (a, b, options = { sensitivity: 'base' }) => String(a).localeCompare(String(b), intlLocale(), options);
