#!/usr/bin/env node
// Confere a internacionalização da UI. Uso: node scripts/check-i18n.mjs [arquivos...]   (sem argumentos: ui/js inteiro)
//  - toda chave de t()/tn()/plural() existe no dicionário com `en` e `id`, ambos com os mesmos {parâmetros} da chave;
//  - a chave é literal (ou ternário de literais); texto montado em runtime é erro (marque a linha com `i18n-dynamic`);
//  - literais em português fora de t()/tn()/plural()/tr() são apontados (marque a linha com `i18n-ignore` se for legítimo);
//  - chaves repetidas entre dicionários têm de ter a mesma tradução.
// Sai com código 1 se achar qualquer problema.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const UI = join(ROOT, 'ui/js');
const DICT_DIR = join(UI, 'i18n/dict');

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? (p.includes('/i18n') ? [] : walk(p)) : p.endsWith('.js') && n !== 'i18n.js' ? [p] : [];
});

// ---- dicionário -------------------------------------------------------------------------------------------
const files = readdirSync(DICT_DIR).filter((f) => f.endsWith('.js') && f !== 'index.js');
const EN = {}, owner = {};
const problems = [];
const params = (x) => [...String(x).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const f of files) {
  const dict = (await import(pathToFileURL(join(DICT_DIR, f)).href)).default;
  for (const [k, v] of Object.entries(dict)) {
    if (k in EN && (EN[k].en !== v.en || EN[k].id !== v.id)) problems.push(`dicionário: "${k}" traduzido diferente em ${owner[k]} e ${f}`);
    EN[k] = v; owner[k] = f;
    for (const l of ['en', 'id']) {
      if (typeof v[l] !== 'string' || !v[l].trim()) { problems.push(`dicionário (${f}): falta ${l} em "${k}"`); continue; }
      if (params(k) !== params(v[l])) problems.push(`dicionário (${f}): parâmetros divergem em "${k}" → ${l}: "${v[l]}"`);
    }
  }
}

// ---- tokenizador de JS (strings, templates, comentários, regex) --------------------------------------------------
function tokenize(src) {
  const toks = []; // { kind: 'str', start, end, value, tpl }
  let i = 0, prevSig = '';
  const n = src.length;
  const regexOk = () => prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prevSig) || /(return|typeof|case|in|of)$/.test(prevSig);
  function readTemplate(start) {
    // devolve fim (exclusivo); tokens de strings dentro de ${} são registrados à parte
    let j = start + 1, text = '', dyn = false;
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') {
        dyn = true; j += 2; let depth = 1;
        while (j < n && depth) {
          const c = src[j];
          if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) break; }
          else if (c === "'" || c === '"') { const e = readQuoted(j); toks.push({ kind: 'str', start: j, end: e, value: src.slice(j + 1, e - 1), tpl: false }); j = e; continue; }
          else if (c === '`') { j = readTemplate(j); continue; }
          j++;
        }
        j++; text += '${…}'; continue;
      }
      text += src[j++];
    }
    toks.push({ kind: 'str', start, end: j + 1, value: text, tpl: true, dyn });
    return j + 1;
  }
  function readQuoted(start) {
    const q = src[start]; let j = start + 1;
    while (j < n && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === "'" || c === '"') { const e = readQuoted(i); toks.push({ kind: 'str', start: i, end: e, value: src.slice(i + 1, e - 1), tpl: false }); i = e; prevSig = 'x'; continue; }
    if (c === '`') { i = readTemplate(i); prevSig = 'x'; continue; }
    if (c === '/' && regexOk()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      i = j + 1; while (/[a-z]/.test(src[i] || '')) i++; prevSig = 'x'; continue;
    }
    if (!/\s/.test(c)) prevSig = (prevSig + c).slice(-8);
    i++;
  }
  return toks.sort((a, b) => a.start - b.start);
}

// Divide os argumentos de uma chamada cujo '(' está em `open`; devolve [{start,end}] de cada argumento.
function splitArgs(src, open, toks) {
  const strAt = new Map(toks.map((t) => [t.start, t]));
  const args = []; let depth = 0, from = open + 1, j = open;
  for (; j < src.length; j++) {
    const t = strAt.get(j);
    if (t) { j = t.end - 1; continue; }
    const c = src[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) { args.push({ start: from, end: j }); break; } }
    else if (c === ',' && depth === 1) { args.push({ start: from, end: j }); from = j + 1; }
  }
  return args;
}

const PT_WORDS = /\b(não|nao|para|com|uma|você|seu|sua|seus|suas|será|serão|foram|foi|está|estão|itens|item|arquivos?|pasta|todos?|nenhum[a]?|mais|menos|ou|ao|aos|dos|das|pelo|pela|sem|ainda|depois|antes|nunca|sempre|apenas|também|já|cada|quando|desta|deste|nesta|neste|esse|essa|esta|este|isso|isto|aqui|abrir|fechar|remover|apagar|limpar|mover|selecionar|cancelar|confirmar|voltar|continuar)\b/i;
const ACCENT = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/;
const looksPt = (s) => {
  if (!/[A-Za-zÀ-ÿ]/.test(s) || s.length < 2) return false;
  if (/^[\w./:#@-]+$/.test(s) && !ACCENT.test(s)) return false; // ids, classes, caminhos
  if (ACCENT.test(s)) return true;
  const words = s.trim().split(/\s+/);
  return words.length >= 2 && PT_WORDS.test(s);
};

const keyOf = (v) => v.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');

function checkFile(path) {
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');
  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  const lineText = (pos) => lines[lineOf(pos) - 1] || '';
  const rel = relative(ROOT, path);
  const toks = tokenize(src);
  const wrapped = new Set(); // início dos tokens que são chave de t()/tn()/plural()
  const report = (pos, msg) => problems.push(`${rel}:${lineOf(pos)}: ${msg}`);
  const useKey = (tok, pos) => {
    wrapped.add(tok.start);
    const k = keyOf(tok.value);
    if (tok.dyn) return;
    if (!(k in EN) && /[A-Za-zÀ-ÿ]/.test(k) && !/^[\s\d{}.,:;%/()·—–-]+$/.test(k.replace(/\{\w+\}/g, ''))) report(pos, `sem tradução (en/id): "${k}"`);
  };
  const callRe = /(?<![\w.$])(t|tn|tr|plural)\(/g;
  for (let m; (m = callRe.exec(src));) {
    const open = m.index + m[0].length - 1, fn = m[1];
    if (fn === 'tr') {
      // tr() recebe texto do backend (dinâmico); literais ali são tolerados.
      continue;
    }
    const args = splitArgs(src, open, toks);
    const keyArgs = fn === 't' ? [args[0]] : [args[1], args[2]];
    for (const a of keyArgs) {
      if (!a) continue;
      const inside = toks.filter((t) => t.start >= a.start && t.end <= a.end + 1);
      const text = src.slice(a.start, a.end).trim();
      const dynOk = /i18n-dynamic/.test(lineText(m.index));
      const ternary = /^[^?]+\?\s*(['"`]).*\1\s*:\s*(['"`]).*\2$/s.test(text);
      const single = /^(['"`])(?:\\.|(?!\1).)*\1$/s.test(text);
      if (!single && !ternary) { if (!dynOk) report(m.index, `chave de ${fn}() não é literal: ${text.slice(0, 60)}`); continue; }
      for (const tok of inside) { if (tok.tpl && tok.dyn && !dynOk) report(m.index, `chave de ${fn}() com \${}: use {parâmetro}`); else useKey(tok, m.index); }
    }
  }
  for (const tok of toks) {
    if (wrapped.has(tok.start)) continue;
    const line = lineText(tok.start);
    if (/i18n-ignore/.test(line) || /^\s*(import|export .* from)\b/.test(line)) continue;
    if (/\b(console\.\w+|querySelector(All)?|closest|matches|getElementById|setAttribute\(\s*'(class|role|type|data-|aria-live)|classList\.\w+|dataset\.|localStorage\.\w+|addEventListener|new RegExp|Intl\.\w+|\.test\()/.test(line) && !ACCENT.test(tok.value)) continue;
    if (looksPt(tok.value)) report(tok.start, `literal em português fora de t(): "${tok.value.slice(0, 70)}"`);
  }
}

const targets = process.argv.length > 2 ? process.argv.slice(2).map((p) => resolve(p)) : walk(UI);
for (const f of targets) checkFile(f);
if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} problema(s) em ${targets.length} arquivo(s).`);
  process.exit(1);
}
console.log(`ok: ${targets.length} arquivo(s), ${Object.keys(EN).length} chaves no dicionário.`);
