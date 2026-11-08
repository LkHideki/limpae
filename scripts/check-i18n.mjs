#!/usr/bin/env node
// Checks the UI internationalization. Usage: node scripts/check-i18n.mjs [files...]   (no arguments: all of ui/js)
//  - every t()/tn()/plural() key exists in the dictionary with `en` and `id`, both with the key's {placeholders};
//  - the key is a literal (or a ternary of literals); text built at runtime is an error (mark the line `i18n-dynamic`);
//  - Portuguese literals outside t()/tn()/plural()/tr() are reported (mark the line `i18n-ignore` if legitimate);
//  - keys repeated across dictionaries must have the same translation.
//  - Portuguese string literals in the Rust backend (outside tests) must be dictionary keys, since the UI shows them
//    through tr(); `{x}` in format! strings matches any {placeholder}. Mark a line `i18n-ignore` if it never reaches the UI.
// Exits with code 1 on any problem.
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

// ---- dictionary ------------------------------------------------------------------------------------------
const files = readdirSync(DICT_DIR).filter((f) => f.endsWith('.js') && f !== 'index.js');
const EN = {}, owner = {};
const problems = [];
const params = (x) => [...String(x).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const f of files) {
  const dict = (await import(pathToFileURL(join(DICT_DIR, f)).href)).default;
  for (const [k, v] of Object.entries(dict)) {
    if (k in EN && (EN[k].en !== v.en || EN[k].id !== v.id)) problems.push(`dictionary: "${k}" translated differently in ${owner[k]} and ${f}`);
    EN[k] = v; owner[k] = f;
    for (const l of ['en', 'id']) {
      if (typeof v[l] !== 'string' || !v[l].trim()) { problems.push(`dictionary (${f}): missing ${l} for "${k}"`); continue; }
      if (params(k) !== params(v[l])) problems.push(`dictionary (${f}): placeholders differ for "${k}" → ${l}: "${v[l]}"`);
    }
  }
}

// ---- JS tokenizer (strings, templates, comments, regexes) ---------------------------------------------------------
function tokenize(src) {
  const toks = []; // { kind: 'str', start, end, value, tpl }
  let i = 0, prevSig = '';
  const n = src.length;
  const regexOk = () => prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prevSig) || /(return|typeof|case|in|of)$/.test(prevSig);
  function readTemplate(start) {
    // returns the (exclusive) end; string tokens inside ${} are recorded separately
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

// Splits the arguments of a call whose '(' is at `open`; returns [{start,end}] for each argument.
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
  if (/^[\w./:#@-]+$/.test(s) && !ACCENT.test(s)) return false; // ids, classes, paths
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
  const wrapped = new Set(); // start of tokens that are t()/tn()/plural() keys
  const report = (pos, msg) => problems.push(`${rel}:${lineOf(pos)}: ${msg}`);
  const useKey = (tok, pos) => {
    wrapped.add(tok.start);
    const k = keyOf(tok.value);
    if (tok.dyn) return;
    if (!(k in EN) && /[A-Za-zÀ-ÿ]/.test(k) && !/^[\s\d{}.,:;%/()·—–-]+$/.test(k.replace(/\{\w+\}/g, ''))) report(pos, `no translation (en/id): "${k}"`);
  };
  const callRe = /(?<![\w.$])(t|tn|tr|plural)\(/g;
  for (let m; (m = callRe.exec(src));) {
    const open = m.index + m[0].length - 1, fn = m[1];
    if (fn === 'tr') {
      // tr() receives backend text (dynamic); literals there are tolerated.
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
      if (!single && !ternary) { if (!dynOk) report(m.index, `${fn}() key is not a literal: ${text.slice(0, 60)}`); continue; }
      for (const tok of inside) { if (tok.tpl && tok.dyn && !dynOk) report(m.index, `${fn}() key with \${}: use a {placeholder}`); else useKey(tok, m.index); }
    }
  }
  for (const tok of toks) {
    if (wrapped.has(tok.start)) continue;
    const line = lineText(tok.start);
    if (/i18n-ignore/.test(line) || /^\s*(import|export .* from)\b/.test(line)) continue;
    if (/\b(console\.\w+|querySelector(All)?|closest|matches|getElementById|setAttribute\(\s*'(class|role|type|data-|aria-live)|classList\.\w+|dataset\.|localStorage\.\w+|addEventListener|new RegExp|Intl\.\w+|\.test\()/.test(line) && !ACCENT.test(tok.value)) continue;
    if (looksPt(tok.value)) report(tok.start, `Portuguese literal outside t(): "${tok.value.slice(0, 70)}"`);
  }
}

// ---- Rust backend texts ----------------------------------------------------------------------------------
// Heuristic: a literal with a space and Portuguese marks or words is user-facing text. The menu bar extra is
// localized natively (tray.rs), so it is skipped.
const RUST_DIRS = ['crates/limpa-core/src', 'src-tauri/src'].map((d) => join(ROOT, d));
const RUST_SKIP = new Set(['tray.rs']);
const RUST_PT = /[ãõçáéíóúâêôà]|\b(não|sem|para|itens?|arquivos?|pasta|está|foi|uma?)\b/i;
const shape = (s) => s.replace(/\{[^}]*\}/g, '{}');
function checkRust() {
  const known = new Set(Object.keys(EN).map(shape));
  const rs = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? rs(p) : p.endsWith('.rs') && !RUST_SKIP.has(n) ? [p] : [];
  });
  let count = 0;
  for (const f of RUST_DIRS.flatMap(rs)) {
    count++;
    let src = readFileSync(f, 'utf8');
    const cut = src.indexOf('#[cfg(test)]');
    if (cut >= 0) src = src.slice(0, cut);
    src.split('\n').forEach((line, i) => {
      if (/^\s*\/\//.test(line) || /i18n-ignore/.test(line)) return;
      for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        const s = m[1].replace(/\\"/g, '"');
        if (s.length < 6 || !/ /.test(s) || !RUST_PT.test(s)) continue;
        if (!known.has(shape(s))) problems.push(`${relative(ROOT, f)}:${i + 1}: backend text without translation: "${s.slice(0, 80)}"`);
      }
    });
  }
  return count;
}

const targets = process.argv.length > 2 ? process.argv.slice(2).map((p) => resolve(p)) : walk(UI);
for (const f of targets) checkFile(f);
const rustFiles = process.argv.length > 2 ? 0 : checkRust();
if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} problem(s) in ${targets.length} file(s).`);
  process.exit(1);
}
console.log(`ok: ${targets.length} UI file(s), ${rustFiles} Rust file(s), ${Object.keys(EN).length} dictionary keys.`);
