// Files: large and old files, duplicates, similar images and downloads.
// Nothing comes preselected; the action is move to Trash ("Remover do Mac" in the iCloud category, which only evicts
// the local copy and never deletes anything from iCloud); the UI only sends registry ids, never paths.
// Names and paths come from disk (untrusted): only textContent / createElement.
import { play } from '../sound.js';
import { t, tn, tr, lazyIntl, cmp } from '../i18n.js';
import { h, s, mount, mid, keepFocus, keepPhaseFocus } from '../dom.js';
import { icon, groupIcon } from '../art.js';
import { api } from '../api.js';
import { store, selectedSize, pruneResult, bump, countItems } from '../store.js';
import { bytesParts, fmtBytes, fmtNum, plural } from '../format.js';
import { confirmDialog, confirmRestart, failuresSheet, stage, chipRow, checkbox, segmented, managerBar } from '../ui.js';
import { outcomesToFailures, realFailures, stopDock } from '../actions.js';
import { attachMenu, selectMenuButton } from '../menus.js';
import { quickLook, quickLookRow } from '../quicklook.js';
import { openSettings, reopenButton } from '../fda.js';

const OPTIONS = [{ value: 50, label: '50 MB' }, { value: 100, label: '100 MB' }, { value: 500, label: '500 MB' }, { value: 1000, label: '1 GB' }];
const CHUNK = 60;
const SETS_CHUNK = 40;
const REMOVE_BATCH = 100;
const EVICT_BATCH = 8;
const MARK = '\u0001'; // {b} marker where the bold fragment goes
const withNode = (str, node) => { const [a, b = ''] = str.split(MARK); return [a, node, b]; };

// Local icons (art.js belongs to another module): same stroke as the others.
const PATHS = {
  copy: ['M8.5 8.5h10v11h-10z', 'M5.5 15.5v-10h10'],
  image: ['M4.5 5.5h15v13h-15z', 'M4.5 16l4.6-4.6 3.6 3.6 2.4-2.4 4.4 4.4', 'M9 9.4h.01'],
  download: ['M12 4.5v10', 'M7.8 10.8l4.2 4.2 4.2-4.2', 'M5.5 19h13'],
  chevron: ['M9.5 6l6 6-6 6'],
  down: ['M6.5 9.5l5.5 5.5 5.5-5.5'],
  disk: ['M4 9.5h16v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M4 9.5l2-4h12l2 4', 'M16.5 14h.01'],
};
function fi(name, size = 18) {
  if (!PATHS[name]) return icon(name, size);
  return s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `i-${name}`, 'aria-hidden': 'true' },
    ...PATHS[name].map((d) => s('path', { d })));
}

const EXT_KIND = {
  video: ['mp4', 'mov', 'mkv', 'avi', 'm4v', 'webm', 'wmv', 'flv', 'mpg', 'mpeg'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'],
  disk_image: ['dmg', 'iso', 'img', 'sparseimage', 'pkg'],
  audio: ['mp3', 'wav', 'aiff', 'aif', 'flac', 'm4a', 'aac', 'ogg'],
  image: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'tiff', 'tif', 'webp', 'gif', 'bmp'],
};
function itemIcon(name, size = 16) {
  const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
  const kind = Object.keys(EXT_KIND).find((k) => EXT_KIND[k].includes(ext));
  if (kind === 'image') return fi('image', size);
  return icon(kind ? groupIcon(kind) : 'file', size);
}

const CATS = [
  { id: 'large', label: 'Grandes e antigos', ic: 'folder', desc: 'Arquivos pesados que talvez você não use mais. Nada é removido sem a sua escolha.' }, // i18n-ignore (key; translated on display)
  { id: 'dups', label: 'Duplicados', ic: 'copy', desc: 'Cópias idênticas de arquivos, em pastas diferentes, que ocupam espaço à toa. Acima de 100 KB.' }, // i18n-ignore (key; translated on display)
  { id: 'sim', label: 'Imagens parecidas', ic: 'image', desc: 'Fotos quase iguais. O ponto verde marca a melhor cópia para manter. Acima de 100 KB.' }, // i18n-ignore (key; translated on display)
  { id: 'dl', label: 'Downloads', ic: 'download', desc: 'Arquivos da pasta Downloads, agrupados pelo app que os baixou.' }, // i18n-ignore (key; translated on display)
  { id: 'icloud', label: 'Baixados do iCloud', ic: 'cloud', desc: 'Arquivos do iCloud Drive que estão baixados neste Mac. Remover do Mac libera espaço; nada é apagado do iCloud.' }, // i18n-ignore (key; translated on display)
];
// Categories whose action is "move to Trash". iCloud has its own action (evict) and its own selection.
const TRASH_CATS = CATS.filter((c) => c.id !== 'icloud');
// "Select" modes per category: [id, label]. The Smart/All/None/Partial labels apply across the whole app.
const SELECT_MODES = { // i18n-ignore (key; translated on display)
  dups: [['smart', 'Recomendado'], ['oldest', 'Mais antigos'], ['newest', 'Mais novos'], ['none', 'Nada']], // i18n-ignore (key; translated on display)
  sim: [['smart', 'Recomendado'], ['smallest', 'Menores'], ['largest', 'Maiores'], ['none', 'Nada']], // i18n-ignore (key; translated on display)
  large: [['all', 'Tudo'], ['none', 'Nada']], // i18n-ignore (key; translated on display)
  dl: [['all', 'Tudo'], ['none', 'Nada']], // i18n-ignore (key; translated on display)
  icloud: [['all', 'Tudo'], ['none', 'Nada']], // i18n-ignore (key; translated on display)
};
// "Show" filter for duplicates, by file type.
const SHOW = [['all', 'Todos os arquivos'], ['apps', 'Aplicativos'], ['archives', 'Compactados'], ['pictures', 'Imagens'], ['other', 'Outros']]; // i18n-ignore (key; translated on display)
const SHOW_EXT = { apps: ['app', 'dmg', 'pkg', 'mpkg', 'ipa', 'xip', 'iso'], archives: EXT_KIND.archive, pictures: EXT_KIND.image };
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const showKind = (name) => { const e = extOf(name); return Object.keys(SHOW_EXT).find((k) => SHOW_EXT[k].includes(e)) || 'other'; };
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : p; };
const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

const dtf = lazyIntl('DateTimeFormat', { day: '2-digit', month: '2-digit', year: 'numeric' });
const rtf = lazyIntl('RelativeTimeFormat', { numeric: 'always' });
const HOME_NAME = 'Pasta pessoal'; // i18n-ignore (name of the location that comes from the backend)
const locLabel = (n) => (n === HOME_NAME ? t('Pasta pessoal') : n);
const fmtDate = (sec) => (sec ? dtf.format(new Date(sec * 1000)) : '—');
function accessText(sec) {
  if (!sec) return '';
  const d = Date.now() / 1000 - sec;
  for (const [unit, size] of [['year', 31557600], ['month', 2629800], ['week', 604800], ['day', 86400]]) {
    if (d >= size) return t('acessado {when}', { when: rtf.format(-Math.floor(d / size), unit) });
  }
  return t('acessado hoje');
}

// State that survives module switch (the view is recreated on every entry).
const S = {
  locs: null, loc: 0,
  res: null,            // { large, dups, sim, dl, icloud, loc, locName, minMb, full }; each one is a ScanResult or null
  lsel: new Set(),      // selection of Large and old
  sel: new Set(),       // selection of duplicates, similar images and downloads (ids are unique)
  csel: new Set(),      // selection of the iCloud category (evicted, never sent to the Trash)
  optimize: undefined,  // macOS "Optimize Mac Storage": undefined = not asked yet, null = unknown, else boolean
  cat: 'large', view: 'kind', open: new Set(), limits: new Map(), thumbs: new Map(),
  q: '', sort: 'size', show: 'all',
};

const catLabel = (c) => t(c.label); // i18n-dynamic
const catDesc = (c) => t(c.desc); // i18n-dynamic
const resOf = (c) => (S.res ? S.res[c] : null);
const selOf = (c) => (c === 'large' ? S.lsel : c === 'icloud' ? S.csel : S.sel);
const countOf = (c) => (resOf(c) ? countItems(resOf(c)) : 0);
const keeperOf = (g) => g.items.find((i) => i.note) || g.items[0];

// Copies that would remain after removing everything but the suggested original.
function reclaim(result) {
  let n = 0, bytes = 0;
  if (result) for (const g of result.groups) { const k = keeperOf(g); for (const i of g.items) if (i !== k) { n++; bytes += i.size; } }
  return { n, bytes };
}

function totals() {
  let bytes = 0, count = 0;
  for (const c of TRASH_CATS) { const sz = selectedSize(resOf(c.id), selOf(c.id)); bytes += sz.bytes; count += sz.count; }
  return { bytes, count };
}

function groupState(items, sel) {
  let n = 0;
  for (const i of items) if (sel.has(i.id)) n++;
  return n === 0 ? 'off' : n === items.length ? 'on' : 'mixed';
}

// Ids that each "Select" mode would check in the category. In duplicates/similar images, at least one
// copy of each group always stays out of the selection.
function pickIds(cat, mode) {
  const out = new Set();
  const result = resOf(cat);
  if (!result || mode === 'none') return out;
  for (const g of result.groups) {
    if (mode === 'all') { for (const i of g.items) out.add(i.id); continue; }
    const byDate = [...g.items].sort((a, b) => (a.modified || 0) - (b.modified || 0) || cmp(a.path, b.path));
    const bySize = [...g.items].sort((a, b) => a.size - b.size || cmp(a.path, b.path));
    const keep = { smart: keeperOf(g), oldest: byDate[byDate.length - 1], newest: byDate[0], smallest: bySize[bySize.length - 1], largest: bySize[0] }[mode];
    for (const i of g.items) if (i !== keep) out.add(i.id);
  }
  return out;
}
function applySelect(cat, mode) {
  const sel = selOf(cat);
  for (const g of resOf(cat).groups) for (const i of g.items) sel.delete(i.id);
  for (const id of pickIds(cat, mode)) sel.add(id);
}
// Mode that the category's current selection reproduces; 'part' when it matches none.
function modeOf(cat) {
  const sel = selOf(cat);
  const have = new Set();
  for (const g of resOf(cat).groups) for (const i of g.items) if (sel.has(i.id)) have.add(i.id);
  for (const [mode] of SELECT_MODES[cat]) {
    const want = pickIds(cat, mode);
    if (want.size === have.size && [...want].every((id) => have.has(id))) return mode;
  }
  return 'part';
}

// Large and old: subgroups by type (from the backend), size or access date.
function largeSections(result, view) {
  if (view === 'kind') return result.groups.map((g) => ({ id: g.id, title: tr(g.title), items: g.items }));
  const all = result.groups.flatMap((g) => g.items);
  const buckets = view === 'size'
    ? [['s5', t('Acima de 5 GB'), (i) => i.size >= 5e9], ['s1', t('De 1 GB a 5 GB'), (i) => i.size >= 1e9], ['s05', t('De 500 MB a 1 GB'), (i) => i.size >= 5e8], ['s0', t('Abaixo de 500 MB'), () => true]]
    : (() => {
      const age = (i) => (i.accessed ? (Date.now() / 1000 - i.accessed) / 86400 : null);
      return [['a365', t('Acessados há mais de 1 ano'), (i) => age(i) !== null && age(i) >= 365], ['a180', t('Entre 6 meses e 1 ano'), (i) => age(i) !== null && age(i) >= 180], ['a30', t('Entre 1 e 6 meses'), (i) => age(i) !== null && age(i) >= 30], ['a0', t('No último mês'), (i) => age(i) !== null], ['an', t('Sem data de acesso'), () => true]];
    })();
  const out = buckets.map(([id, title]) => ({ id, title, items: [] }));
  for (const i of all) out[buckets.findIndex(([, , test]) => test(i))].items.push(i);
  for (const sec of out) sec.items.sort((a, b) => b.size - a.size);
  return out.filter((sec) => sec.items.length);
}

export function enter(ctx) {
  const F = store.files;
  let st = null, cancelled = false;
  const listeners = [];
  const teardown = () => { listeners.splice(0).forEach((f) => f()); };
  ctx.onCleanup(teardown);

  // Sweep hands over the Downloads duplicates ("review" phase): opens the manager with only that category, with nothing
  // checked. "Back" returns to Sweep.
  if (store.filesFrom && F.phase === 'review' && (!S.res || S.res.fromRef !== store.filesFrom)) {
    S.res = { large: null, dups: store.filesFrom, sim: null, dl: null, icloud: null, loc: 0, locName: 'Downloads', minMb: store.largeMb, full: false, largeRef: null, ownsStore: false, fromRef: store.filesFrom, fromSmart: true };
    S.lsel = new Set(); S.sel = new Set(); S.csel = new Set(); S.open = new Set(); S.autoOpened = false; S.limits = new Map(); S.thumbs = new Map(); S.cat = 'dups'; S.q = ''; S.show = 'all';
  }
  // Back goes to Sweep only when the manager was entered from it in this visit; a handed-over result reopened from
  // the landing ("Back to results") returns to the landing.
  const cameFromSweep = !!(S.res && S.res.fromSmart && F.phase === 'review');
  if (!S.res && !['idle', 'scanning'].includes(F.phase)) F.phase = 'idle';
  if (F.phase === 'scanning' || F.phase === 'moving') F.phase = 'idle';

  function ensureStage() {
    if (!st) { st = stage('files', 'folder', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    st.busy(false);
  }

  function render() { return keepPhaseFocus(ctx.root, paintScreen); }

  function paintScreen() {
    teardown();
    ctx.onBack(null);
    if (F.phase === 'review' && S.res) return renderManager();
    if (F.phase === 'results' && S.res && S.res.full) return renderResults();
    ensureStage();
    if (F.phase === 'done') return renderDone();
    return renderIdle();
  }

  // ---------- Start ----------
  function renderIdle() {
    F.phase = 'idle';
    const select = h('select', { class: 'fl-select', 'aria-label': t('Local para analisar'), onChange: (e) => { S.loc = Number(e.target.value); } },
      (S.locs || [{ index: 0, name: HOME_NAME, free: 0, total: 0 }]).map((l) => h('option', { value: l.index, selected: l.index === S.loc }, l.total ? t('{name} · {free} livres', { name: locLabel(l.name), free: fmtBytes(l.free) }) : locLabel(l.name))));
    const feats = [['folder', t('Arquivos grandes e antigos')], ['copy', t('Duplicados')], ['image', t('Imagens parecidas')], ['download', t('Downloads')], ['cloud', t('Baixados do iCloud')]];
    st.show(h('h1', { class: 'h1' }, t('Arquivos')),
      h('p', { class: 'sub' }, t('Organize seus arquivos e reduza a bagunça em poucos cliques.')),
      h('ul', { class: 'feats' }, feats.map(([ic, txt]) => h('li', null, h('span', { class: 'feat-chip' }, fi(ic, 17)), txt))),
      h('div', { class: 'fl-where' },
        h('label', { class: 'fl-lab' }, t('Local')),
        h('div', { class: 'fl-select-wrap' }, fi('disk', 18), select, fi('down', 15)),
        h('label', { class: 'fl-lab' }, t('Arquivos grandes a partir de')),
        chipRow(OPTIONS, store.largeMb, (v) => { store.largeMb = v; })),
      S.res ? h('div', { class: 'row-actions', style: 'margin-top:18px' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { F.phase = S.res.full ? 'results' : 'review'; render(); } }, t('Voltar aos resultados'))) : null);
    ctx.setDock({ label: t('Analisar'), mod: 'files', onClick: scan });
    if (!S.locs) {
      api.clutterLocations().then((l) => { if (!ctx.alive) return; S.locs = l; S.loc = Math.min(S.loc, l.length - 1); if (F.phase === 'idle' && st) renderIdle(); }).catch(() => {});
    }
  }

  // ---------- Scan ----------
  async function scan() {
    const loc = S.loc, mb = store.largeMb;
    const home = loc === 0;
    const steps = [
      { k: 'large', task: 'large', label: t('Arquivos grandes e antigos'), run: () => api.largeAt(loc, mb) },
      home && { k: 'dl', task: 'downloads', label: t('Downloads'), run: () => api.downloads() },
      { k: 'dups', task: 'duplicates', label: t('Duplicados'), run: () => api.duplicates(loc) },
      { k: 'sim', task: 'similar', label: t('Imagens parecidas'), run: () => api.similar(loc) },
      home && { k: 'icloud', task: 'icloud', label: t('Baixados do iCloud'), run: () => api.cloudScan() },
    ].filter(Boolean);
    cancelled = false;
    F.phase = 'scanning';
    play('start');
    ctx.setBusy(true);
    ensureStage();
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    const rows = new Map(steps.map((x) => [x.k, h('li', { class: 'fl-step', dataset: { st: 'wait' } }, h('span', { class: 'fl-step-ic' }), h('span', { class: 'fl-step-nm' }, x.label), h('span', { class: 'fl-step-sum' }))]));
    const mark = (k, state, text = '') => {
      const li = rows.get(k);
      li.dataset.st = state;
      mount(li.firstChild, state === 'run' ? h('i', { class: 'spin' }) : state === 'done' ? icon('check', 14) : state === 'skip' ? icon('dash', 14) : null);
      li.lastChild.textContent = text;
    };
    st.show(h('h1', { class: 'h1' }, t('Analisando…')), h('p', { class: 'sub' }, locLabel(S.locs && S.locs[loc] ? S.locs[loc].name : HOME_NAME)), h('ul', { class: 'fl-steps' }, [...rows.values()]), ticker);
    let current = '';
    ctx.onProgress((p) => { if (p.task === current) ticker.textContent = p.path || ''; });
    ctx.setDock({ label: t('Parar'), busy: true, mod: 'files', onClick: () => { cancelled = true; ctx.setDock({ label: t('Parando'), busy: true, disabled: true, mod: 'files' }); api.cancel().catch(() => {}); } });
    const out = {}, failed = new Set(); // failed: steps that threw, so their empty result is not read as "nothing found"
    let okSteps = 0;
    for (const step of steps) {
      if (cancelled) break;
      current = step.task;
      ticker.textContent = '';
      mark(step.k, 'run');
      try {
        const r = await step.run();
        if (cancelled) break;
        out[step.k] = r;
        okSteps++;
        mark(step.k, 'done', plural(countItems(r), 'item', 'itens'));
      } catch (e) {
        if (cancelled) break;
        out[step.k] = { groups: [], total: 0, needsFda: false };
        failed.add(step.k);
        mark(step.k, 'skip', t('não concluído'));
      }
    }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (cancelled) { F.phase = 'idle'; return render(); }
    const empty = { groups: [], total: 0, needsFda: false };
    S.res = { large: out.large || empty, dl: out.dl || (home ? empty : null), dups: out.dups || empty, sim: out.sim || empty, icloud: out.icloud || (home ? empty : null), loc, locName: S.locs && S.locs[loc] ? S.locs[loc].name : HOME_NAME, minMb: mb, full: true, largeRef: null, ownsStore: home, failed, steps: steps.length };
    S.lsel = new Set(); S.sel = new Set(); S.csel = new Set(); S.open = new Set(); S.autoOpened = false; S.limits = new Map(); S.thumbs = new Map();
    S.optimize = undefined; // asked again the next time the iCloud category is opened
    if (home) { store.large = S.res.large; store.largeSel = S.lsel; }
    S.res.largeRef = store.large;
    bump();
    F.phase = 'results';
    play(okSteps ? 'found' : 'error'); // every step failed: no success chime over a screen of "not completed"
    render();
  }

  // ---------- Results (blocks) ----------
  function renderResults() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const r = S.res;
    const dup = reclaim(r.dups), sim = reclaim(r.sim);
    const dlTop = r.dl && r.dl.groups[0];
    const total = countOf('large') + dup.n + sim.n + countOf('dl') + countOf('icloud');
    const failed = r.failed || new Set();
    const allFailed = failed.size > 0 && failed.size >= (r.steps || 0);
    const tiles = [
      {
        cat: 'dups', ic: 'copy', n: dup.n, label: t('Duplicados'),
        title: tn(dup.n, '{n} duplicado', '{n} duplicados'),
        sub: t('Libere {size} removendo cópias idênticas.', { size: fmtBytes(dup.bytes) }), empty: t('Nenhuma cópia idêntica encontrada.'),
      },
      {
        cat: 'sim', ic: 'image', n: sim.n, label: t('Imagens parecidas'),
        title: tn(sim.n, '{n} imagem parecida', '{n} imagens parecidas'),
        sub: t('{size} em fotos quase idênticas.', { size: fmtBytes(sim.bytes) }), empty: t('Nenhuma imagem parecida encontrada.'),
      },
      {
        cat: 'dl', ic: 'download', n: r.dl ? countOf('dl') : 0, label: t('Downloads'),
        title: dlTop ? (dlTop.title === 'Outros' ? t('{size} em outros downloads', { size: fmtBytes(dlTop.total) }) : t('{size} de downloads do {app}', { size: fmtBytes(dlTop.total), app: dlTop.title })) : t('Downloads'), // i18n-ignore (compares with the backend label)
        sub: dlTop ? (r.dl.groups.length > 1 ? t('{files} · e mais {sources}', { files: plural(dlTop.items.length, 'arquivo', 'arquivos'), sources: plural(r.dl.groups.length - 1, 'origem', 'origens') }) : plural(dlTop.items.length, 'arquivo', 'arquivos')) : '',
        empty: r.dl ? t('A pasta Downloads está vazia.') : t('Os Downloads são analisados só na pasta pessoal.'),
      },
      {
        cat: 'large', ic: 'folder', n: countOf('large'), label: t('Arquivos grandes e antigos'),
        title: t('{size} em arquivos grandes e antigos', { size: fmtBytes(r.large.total) }),
        sub: t('{files} acima de {size}.', { files: plural(countOf('large'), 'arquivo', 'arquivos'), size: fmtBytes(r.minMb * 1e6) }), empty: t('Nenhum arquivo acima de {size}.', { size: fmtBytes(r.minMb * 1e6) }),
      },
      {
        cat: 'icloud', ic: 'cloud', n: countOf('icloud'), label: t('Baixados do iCloud'),
        title: r.icloud ? t('{size} baixados do iCloud', { size: fmtBytes(r.icloud.total) }) : t('Baixados do iCloud'),
        sub: r.icloud ? t('{files} neste Mac. Continuam no iCloud.', { files: plural(countOf('icloud'), 'arquivo', 'arquivos') }) : '',
        empty: !r.icloud ? t('O iCloud Drive é analisado só na pasta pessoal.')
          : r.icloud.needsFda ? t('O macOS protege o iCloud Drive. Conceda Acesso Total ao Disco para listar os arquivos baixados.')
            : t('Nenhum arquivo grande do iCloud Drive baixado neste Mac.'),
      },
    ];
    const el = h('section', { class: 'fl-results enter', dataset: { mod: 'files' }, 'aria-label': t('Resultados') },
      h('div', { class: 'fl-bar' }, h('button', { class: 'btn sm ghost', type: 'button', onClick: async () => { if (await confirmRestart('files')) { F.phase = 'idle'; render(); } } }, icon('back', 15), t('Recomeçar')), h('span', { class: 'fl-where-tag' }, locLabel(r.locName))),
      h('h2', { class: 'fl-title' }, allFailed ? t('Não foi possível analisar.') : total ? t('Você tem {files} para revisar.', { files: plural(total, 'arquivo', 'arquivos') }) : t('Nada para revisar por aqui.')),
      h('p', { class: 'sub fl-sub' }, allFailed ? t('Tente de novo em instantes.') : total ? t('Revise cada categoria. Nada é selecionado nem removido sem a sua escolha.') : t('Tente outro local ou um tamanho mínimo menor.')),
      allFailed ? h('button', { class: 'btn primary fl-all', type: 'button', onClick: scan }, t('Analisar de novo')) : null,
      total ? h('button', { class: 'btn primary fl-all', type: 'button', onClick: () => open(CATS.find((c) => countOf(c.id))?.id || 'large') }, t('Revisar todos os arquivos')) : null,
      h('div', { class: 'fl-tiles', dataset: { n: tiles.length } }, tiles.map((tile) => h('div', { class: 'fl-tile' + (tile.n ? '' : ' none') + (failed.has(tile.cat) ? ' failed' : ''), dataset: { cat: tile.cat } },
        h('span', { class: 'fl-tile-ic' }, fi(tile.ic, 26)),
        h('div', { class: 'fl-tile-t' }, tile.n ? tile.title : tile.label),
        h('div', { class: 'fl-tile-s' }, tile.n ? tile.sub : failed.has(tile.cat) ? t('Não foi possível analisar esta categoria.') : tile.empty),
        tile.n ? h('button', { class: 'btn sm', type: 'button', onClick: () => open(tile.cat) }, t('Revisar'))
          : failed.has(tile.cat) && !allFailed ? h('button', { class: 'btn sm', type: 'button', onClick: scan }, t('Analisar de novo'))
            : tile.cat === 'icloud' && r.icloud && r.icloud.needsFda ? h('button', { class: 'btn sm', type: 'button', onClick: () => openSettings().then(ctx.refreshDisk) }, t('Abrir Ajustes')) : null))));
    mount(ctx.root, el);
  }

  function open(cat) { S.cat = cat; F.phase = 'review'; render(); }

  // ---------- Manager ----------
  // Removes ids from all categories (after removing or ignoring); a set of copies with a single item ceases to exist.
  function prune(okIds) {
    for (const c of CATS) {
      const r = resOf(c.id);
      if (!r) continue;
      let pruned = pruneResult(r, okIds);
      if (c.id === 'dups' || c.id === 'sim') {
        const groups = pruned.groups.filter((g) => g.items.length > 1);
        pruned = { ...pruned, groups, total: groups.reduce((a, g) => a + g.total, 0) };
      }
      S.res[c.id] = pruned;
      for (const id of okIds) selOf(c.id).delete(id);
    }
    if (S.res.ownsStore && store.large === S.res.largeRef) { store.large = S.res.large; S.res.largeRef = store.large; }
    if (S.res.fromSmart) { store.filesFrom = S.res.dups; S.res.fromRef = store.filesFrom; }
  }

  function renderManager() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const avail = CATS.filter((c) => resOf(c.id));
    if (!avail.some((c) => c.id === S.cat)) S.cat = (avail.find((c) => countOf(c.id)) || avail[0]).id;

    const catsEl = h('nav', { class: 'fm-cats', 'aria-label': t('Categorias') });
    const headEl = h('div', { class: 'fm-pane-head' });
    const listEl = h('div', { class: 'fm-list' });
    const selEl = h('div', { class: 'rv-sel' });
    const actionBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => (S.cat === 'icloud' ? evict() : move()) }, t('Mover para o Lixo'));
    let io = null;
    listeners.push(() => { if (io) io.disconnect(); });
    const queue = [];
    let inflight = 0;

    const matches = (it) => { const q = S.q.trim().toLowerCase(); return !q || it.name.toLowerCase().includes(q) || it.path.toLowerCase().includes(q); };
    const sortItems = (items) => [...items].sort(S.sort === 'name' ? (a, b) => cmp(a.name, b.name) : (a, b) => b.size - a.size);
    const noMatch = () => h('div', { class: 'rv-empty' }, t('Nenhum item corresponde à busca ou ao filtro.'));

    function renderCats() {
      mount(catsEl, avail.map((c) => {
        const sz = selectedSize(resOf(c.id), selOf(c.id));
        const result = resOf(c.id);
        return h('button', { class: 'fm-cat', type: 'button', dataset: { fk: 'cat:' + c.id }, 'aria-current': String(c.id === S.cat), onClick: () => { if (S.cat !== c.id) keepFocus(ctx.root, () => { S.cat = c.id; renderPane(); renderCats(); renderFoot(); }); } },
          h('span', { class: 'fm-cat-ic' }, fi(c.ic, 17)),
          h('span', { class: 'fm-cat-t' }, h('b', null, catLabel(c)), h('span', null, countOf(c.id) ? t('{items} · {size}', { items: plural(countOf(c.id), 'item', 'itens'), size: fmtBytes(result.total) }) : result.needsFda ? t('Acesso necessário') : t('Nada encontrado'))),
          sz.count ? h('span', { class: 'fm-cat-n', title: plural(sz.count, 'item selecionado', 'itens selecionados') }, fmtNum(sz.count)) : null);
      }));
    }

    function renderFoot() {
      // The iCloud category has its own action and selection; every other category shares the Trash selection.
      const cloud = S.cat === 'icloud';
      const { bytes, count } = cloud ? selectedSize(resOf('icloud'), S.csel) : totals();
      if (!count) mount(selEl, t('Nenhum item selecionado'));
      else mount(selEl, t('Selecionado:') + ' ', h('b', null, fmtBytes(bytes)), h('small', null, plural(count, 'item', 'itens')));
      actionBtn.textContent = cloud ? t('Remover do Mac') : t('Mover para o Lixo');
      actionBtn.dataset.act = cloud ? 'evict' : 'trash';
      actionBtn.disabled = count === 0;
    }

    function refresh() { renderCats(); renderHead(); renderList(); renderFoot(); }

    function renderHead() { keepFocus(ctx.root, drawHead); }
    function drawHead() {
      const c = CATS.find((x) => x.id === S.cat);
      const kids = [h('div', { class: 'fm-pane-t' }, h('h3', null, catLabel(c)), h('p', null, catDesc(c)))];
      const tools = [];
      if (countOf(c.id)) {
        if (c.id === 'large') tools.push(segmented([{ value: 'kind', label: t('Tipo') }, { value: 'size', label: t('Tamanho') }, { value: 'access', label: t('Data de acesso') }], S.view, (v) => { S.view = v; renderList(); }, t('Agrupar por')));
        if (c.id === 'dups') tools.push(selectMenuButton({ label: t('Mostrar'), modes: SHOW.map(([i, l]) => [i, t(l)]), mode: S.show, onPick: (m) => { S.show = m; refresh(); } })); // i18n-dynamic
        tools.push(selectMenuButton({ label: t('Selecionar'), modes: SELECT_MODES[c.id].map(([i, l]) => [i, t(l)]), mode: modeOf(c.id), onPick: (m) => { applySelect(c.id, m); refresh(); } })); // i18n-dynamic
      }
      if (tools.length) kids.push(h('div', { class: 'fm-tools' }, tools));
      if (c.id === 'icloud') kids.push(cloudNote());
      mount(headEl, kids);
    }

    // iCloud category notice: nothing is deleted from iCloud, plus whether macOS "Optimize Mac Storage" is on.
    function cloudNote() {
      if (S.optimize === undefined) {
        S.optimize = null; // asked once; the answer repaints the header
        api.cloudOptimizeStatus().then((v) => { S.optimize = typeof v === 'boolean' ? v : null; }).catch(() => {})
          .finally(() => { if (ctx.alive && F.phase === 'review' && S.cat === 'icloud') renderHead(); });
      }
      const opt = S.optimize === true ? t('Otimizar Armazenamento do Mac está ativado: o macOS também libera esses arquivos sozinho quando falta espaço.')
        : S.optimize === false ? t('Otimizar Armazenamento do Mac está desativado. Ative em Ajustes do Sistema › Apple ID › iCloud › Drive para o macOS liberar esses arquivos sozinho quando faltar espaço.') : '';
      return h('div', { class: 'cloud-note fm-cloud-note', dataset: { optimize: S.optimize === null ? 'unknown' : String(S.optimize) } },
        h('b', null, t('Nada é apagado do iCloud.')), ' ' + t('Os arquivos continuam guardados lá e baixam de novo quando você abrir.'),
        opt ? h('p', { class: 'fm-cloud-opt' }, opt) : null);
    }

    function renderPane() {
      renderHead();
      listEl.scrollTop = 0;
      renderList();
    }

    // Removes the item from the review (it is already on the ignored list in the backend).
    function dropItem(it) { prune(new Set([it.id])); refresh(); }

    // ---- rows and sections ----
    // opts.dir: row of one copy (the name is the same in all of them): shows the folder, which is what tells them apart.
    // opts.noQuickLook: iCloud files (previewing one would download it again).
    function fileRow(it, sel, opts = {}) {
      const cb = checkbox(sel.has(it.id) ? 'on' : 'off', () => toggle(), t('Selecionar {name}', { name: it.name }));
      cb.dataset.fk = 'c:' + it.id;
      const toggle = () => { sel.has(it.id) ? sel.delete(it.id) : sel.add(it.id); refresh(); };
      const main = opts.dir
        ? h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, mid(tilde(dirOf(it.path)), 30), it.note ? h('span', { class: 'badge info' }, tr(it.note)) : null),
          h('div', { class: 'fm-meta fm-meta-dir' }, h('span', { class: 'fm-fname', title: it.name }, it.name), opts.when ? h('span', { class: 'fm-when' }, ' · ' + opts.when(it)) : null))
        : h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, h('span', { title: it.name }, it.name), it.note ? h('span', { class: 'badge info' }, tr(it.note)) : null),
          h('div', { class: 'fm-meta' }, mid(it.path, 26)));
      const row = h('div', { class: 'fm-row', onClick: toggle },
        cb,
        h('div', { class: 'fm-ic' }, itemIcon(it.name)),
        main,
        h('span', { class: 'fm-size' }, fmtBytes(it.size), opts.when && !opts.dir ? h('small', null, opts.when(it)) : null),
        opts.noQuickLook ? null : h('button', { class: 'icon-btn fm-act', type: 'button', title: t('Visualização Rápida'), 'aria-label': t('Visualização Rápida de {name}', { name: it.name }), onClick: (e) => { e.stopPropagation(); quickLook(it.id); } }, icon('eye', 16)),
        h('button', { class: 'icon-btn fm-act', type: 'button', title: t('Mostrar no Finder'), 'aria-label': t('Mostrar {name} no Finder', { name: it.name }), onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 16)));
      attachMenu(row, () => ({ id: it.id, name: it.name, select: { on: sel.has(it.id), toggle }, quickLook: !opts.noQuickLook, onIgnored: () => dropItem(it) }));
      // The list re-renders on every toggle: the row key lets keepFocus put focus back on the row.
      row.dataset.fk = 'r:' + it.id;
      if (!opts.noQuickLook) quickLookRow(row, () => quickLook(it.id));
      return row;
    }

    // The "Show more" button is replaced by the new rows: focus goes to the first of them (its data-fk) instead of <body>.
    function focusFirstNew(fk) {
      const n = fk && listEl.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
      if (n) n.focus();
    }

    function more(key, total, shown, next, step = CHUNK) {
      return h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.limits.set(key, (S.limits.get(key) || step) + step * 3); renderList(); focusFirstNew(next && 'c:' + next.id); } }, t('Mostrar mais ({items})', { items: plural(total - shown, 'item', 'itens') })));
    }

    function section(sec, sel, key, opts) {
      const limit = S.limits.get(key) || CHUNK;
      const shown = sec.items.slice(0, limit);
      const cb = checkbox(groupState(sec.items, sel), (cur) => { for (const i of sec.items) cur === 'on' ? sel.delete(i.id) : sel.add(i.id); refresh(); }, t('Selecionar {name}', { name: sec.title }));
      cb.dataset.fk = 'sc:' + key;
      const total = sec.items.reduce((a, i) => a + i.size, 0);
      return h('section', { class: 'fm-sec' },
        h('div', { class: 'fm-sec-head' }, cb, h('b', { title: sec.title }, sec.title), h('span', null, t('{items} · {size}', { items: plural(sec.items.length, 'item', 'itens'), size: fmtBytes(total) }))),
        shown.map((it) => fileRow(it, sel, opts)),
        sec.items.length > shown.length ? more(key, sec.items.length, shown.length, sec.items[shown.length]) : null);
    }

    function dupSet(g) {
      const sel = S.sel;
      const open = S.open.has(g.id);
      const n = g.items.filter((i) => sel.has(i.id)).length;
      const all = n === g.items.length;
      const head = h('button', { class: 'fm-set-head', type: 'button', dataset: { fk: 'sh:' + g.id }, 'aria-expanded': String(open), onClick: () => { open ? S.open.delete(g.id) : S.open.add(g.id); renderList(); } },
        h('span', { class: 'fm-chev' }, fi('chevron', 16)),
        h('span', { class: 'fm-ic' }, itemIcon(g.title)),
        h('span', { class: 'fm-set-t' }, h('b', { title: g.title }, g.title), h('span', null, tr(g.description))),
        all ? h('span', { class: 'badge', title: t('Todas as cópias estão selecionadas; nenhuma vai sobrar') }, t('Todas selecionadas')) : null,
        n && !all ? h('span', { class: 'fm-count' }, h('i', null, fmtNum(n)), h('span', null, fmtNum(g.items.length))) : h('span', { class: 'fm-count off' }, fmtNum(g.items.length)));
      return h('section', { class: 'fm-set', 'data-open': String(open) }, head,
        open ? g.items.map((it) => fileRow(it, sel, { dir: true, when: (x) => t('modificado {date}', { date: fmtDate(x.modified) }) })) : null);
    }

    function simCluster(g, idx) {
      const sel = S.sel;
      const n = g.items.filter((i) => sel.has(i.id)).length;
      const all = n === g.items.length;
      const cb = checkbox(groupState(g.items, sel), (cur) => { for (const i of g.items) cur === 'on' ? sel.delete(i.id) : sel.add(i.id); refresh(); }, t('Selecionar o grupo {n}', { n: idx + 1 }));
      cb.dataset.fk = 'sg:' + g.id;
      const keeper = keeperOf(g);
      return h('section', { class: 'fm-sec' },
        h('div', { class: 'fm-sec-head' }, cb, h('b', { title: g.title }, t('Grupo {n} · {title}', { n: idx + 1, title: g.title })), h('span', null, `${tr(g.description)} · ${fmtBytes(g.total)}`), all ? h('span', { class: 'badge', title: t('Todas as imagens estão selecionadas; nenhuma vai sobrar') }, t('Todas selecionadas')) : null),
        h('div', { class: 'fm-grid' }, g.items.map((it) => {
          const on = sel.has(it.id);
          const toggle = () => { on ? sel.delete(it.id) : sel.add(it.id); refresh(); };
          const img = h('img', { alt: '', draggable: 'false', hidden: true });
          const ph = h('span', { class: 'fm-img-ph' }, fi('image', 22));
          const card = h('div', { class: 'fm-img', role: 'button', tabindex: '0', 'aria-pressed': String(on), 'aria-label': on ? t('Desmarcar {name}', { name: it.name }) : t('Selecionar {name}', { name: it.name }), dataset: { on: String(on), id: it.id, fk: 'img:' + it.id },
            onClick: toggle,
            onKeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } } },
            h('div', { class: 'fm-img-box' }, ph, img),
            h('span', { class: 'cb fm-img-cb', 'data-state': on ? 'on' : 'off', 'aria-hidden': 'true' }, icon('check', 14)),
            it === keeper ? h('span', { class: 'fm-keep', title: t('Melhor qualidade: sugerida para manter') }) : null,
            h('div', { class: 'fm-img-cap' }, h('span', { title: it.name }, it.name), h('small', null, `${fmtBytes(it.size)} · ${fmtDate(it.modified)}`)),
            h('button', { class: 'icon-btn fm-act fm-img-act', type: 'button', title: t('Mostrar no Finder'), 'aria-label': t('Mostrar {name} no Finder', { name: it.name }), onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 15)));
          attachMenu(card, () => ({ id: it.id, name: it.name, select: { on: sel.has(it.id), toggle }, onIgnored: () => dropItem(it) }));
          loadThumb(card, img, ph, it.id);
          return card;
        })));
    }

    // ---- thumbnails: loaded only when visible, 3 at a time ----
    function loadThumb(card, img, ph, id) {
      const apply = (url, cached = false) => { if (url) { img.classList.toggle('cached', cached); img.src = url; img.hidden = false; ph.hidden = true; } };
      card._thumb = { id, apply };
      if (S.thumbs.has(id)) return apply(S.thumbs.get(id), true); // already loaded: no fade-in replay
      if (io) io.observe(card);
    }
    function pump() {
      while (inflight < 3 && queue.length) {
        const { id, apply } = queue.shift();
        inflight++;
        api.thumb(id).then((url) => { S.thumbs.set(id, url || null); if (ctx.alive) apply(url); }).catch(() => { S.thumbs.set(id, null); }).finally(() => { inflight--; pump(); });
      }
    }

    // macOS protects the iCloud Drive folder: same guidance as the other protected locations.
    function fdaPanel() {
      return h('div', { class: 'fm-fda' },
        h('div', { class: 'glyph-chip' }, icon('lock', 22)),
        h('h3', null, t('Acesso Total ao Disco necessário')),
        h('p', null, t('O macOS protege a pasta do iCloud Drive. Para o Limpae listar os arquivos baixados, conceda acesso:')),
        h('ol', null, h('li', null, t('Abra Ajustes do Sistema › Privacidade e Segurança.')), h('li', null, t('Entre em Acesso Total ao Disco e ative o Limpae.')), h('li', null, t('Volte aqui e analise de novo.'))),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn primary', type: 'button', onClick: () => openSettings().then(ctx.refreshDisk) }, t('Abrir Ajustes')),
          reopenButton()));
    }

    function renderList() { keepFocus(ctx.root, drawList); }
    function drawList() {
      const keep = listEl.scrollTop;
      if (io) io.disconnect();
      queue.length = 0;
      io = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
          for (const e of entries) if (e.isIntersecting && e.target._thumb) { io.unobserve(e.target); if (!S.thumbs.has(e.target._thumb.id)) queue.push(e.target._thumb); }
          pump();
        }, { root: listEl, rootMargin: '240px' })
        : null;
      const c = S.cat;
      const result = resOf(c);
      let body;
      if (!countOf(c)) {
        body = c === 'icloud' && result.needsFda ? fdaPanel()
          : h('div', { class: 'rv-empty' }, c === 'large' ? t('Nenhum arquivo acima de {size}.', { size: fmtBytes(S.res.minMb * 1e6) }) : c === 'icloud' ? t('Nenhum arquivo grande do iCloud Drive baixado neste Mac.') : t('Nada encontrado nesta categoria.'));
      } else if (c === 'icloud') {
        body = result.groups.map((g) => ({ id: g.id, title: tr(g.title), items: sortItems(g.items.filter(matches)) })).filter((sec) => sec.items.length)
          .map((sec) => section(sec, S.csel, `icloud:${sec.id}`, { noQuickLook: true, when: (i) => fmtDate(i.modified) }));
        if (!body.length) body = noMatch();
      } else if (c === 'large') {
        body = largeSections(result, S.view).map((sec) => ({ ...sec, items: sortItems(sec.items.filter(matches)) })).filter((sec) => sec.items.length)
          .map((sec) => section(sec, S.lsel, `large:${S.view}:${sec.id}`, { when: (i) => accessText(i.accessed) || t('modificado {date}', { date: fmtDate(i.modified) }) }));
        if (!body.length) body = noMatch();
      } else if (c === 'dl') {
        body = result.groups.map((g) => ({ id: g.id, title: g.title === 'Outros' ? t('Outros') : g.title, items: sortItems(g.items.filter(matches)) })).filter((sec) => sec.items.length)
          .map((sec) => section(sec, S.sel, `dl:${sec.id}`, { when: (i) => fmtDate(i.modified) }));
        if (!body.length) body = noMatch();
      } else {
        const limit = S.limits.get(c) || SETS_CHUNK;
        let groups = result.groups.filter((g) => g.items.some(matches) && (c !== 'dups' || S.show === 'all' || showKind(g.title) === S.show));
        if (S.sort === 'name') groups = [...groups].sort((a, b) => cmp(a.title, b.title));
        const index = new Map(result.groups.map((g, i) => [g, i]));
        if (c === 'dups' && !S.autoOpened && groups[0]) { S.autoOpened = true; S.open.add(groups[0].id); } // once per result: the user may collapse every set
        const shown = groups.slice(0, limit);
        body = groups.length
          ? [shown.map((g) => (c === 'dups' ? dupSet(g) : simCluster(g, index.get(g)))),
            groups.length > shown.length ? h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { const next = groups[shown.length]; S.limits.set(c, limit + SETS_CHUNK); renderList(); focusFirstNew(next && (c === 'dups' ? 'sh:' : 'sg:') + next.id); } }, t('Mostrar mais ({items})', { items: plural(groups.length - shown.length, 'grupo', 'grupos') }))) : null]
          : noMatch();
      }
      mount(listEl, body);
      listEl.scrollTop = keep;
    }

    const back = () => {
      if (S.res.fromSmart && cameFromSweep) { F.phase = 'idle'; ctx.nav('smart'); return; }
      F.phase = S.res.full ? 'results' : 'idle';
      render();
    };
    const search = h('label', { class: 'search' }, icon('search', 16),
      h('input', { type: 'search', placeholder: t('Buscar'), 'aria-label': t('Buscar arquivos'), value: S.q, spellcheck: 'false', onInput: (e) => { S.q = e.target.value; renderList(); } }));
    const sortSeg = segmented([{ value: 'size', label: t('Tamanho') }, { value: 'name', label: t('Nome') }], S.sort, (v) => { S.sort = v; renderList(); }, t('Ordenar por'));
    const el = h('section', { class: 'review fm enter', dataset: { mod: 'files' }, 'aria-label': t('Gerenciador de arquivos') },
      managerBar({ title: t('Arquivos'), subtitle: locLabel(S.res.locName), onBack: back, controls: [search, sortSeg] }),
      h('div', { class: 'fm-body' }, catsEl, h('div', { class: 'fm-pane' }, headEl, listEl)),
      h('div', { class: 'rv-foot' }, selEl, actionBtn));
    mount(ctx.root, el);
    ctx.onBack(back);
    renderPane();
    renderCats();
    renderFoot();
  }

  // ---------- Removal ----------
  async function move() {
    const picked = [];
    for (const c of TRASH_CATS) { const r = resOf(c.id); if (r) for (const g of r.groups) for (const i of g.items) if (selOf(c.id).has(i.id)) picked.push(i); }
    if (!picked.length) return;
    const bytes = picked.reduce((a, i) => a + i.size, 0);
    let allSel = 0;
    for (const c of ['dups', 'sim']) { const r = resOf(c); if (r) for (const g of r.groups) if (g.items.length && g.items.every((i) => S.sel.has(i.id))) allSel++; }
    const undoNote = t('{size} serão enviados ao Lixo. Você pode restaurá-los de lá {until}.', { size: fmtBytes(bytes), until: '\u0001' }).split('\u0001');
    const undoParts = undoNote.flatMap((part, i) => (i ? [h('strong', null, t('até esvaziar a Lixeira')), part] : [part]));
    const ok = await confirmDialog({
      title: tn(picked.length, 'Mover {n} arquivo para o Lixo?', 'Mover {n} arquivos para o Lixo?'),
      body: [...undoParts,
        allSel ? h('span', { class: 'fl-warn' }, ' ' + t('Atenção: em {groups} de cópias todos os itens estão selecionados, então nenhuma cópia vai sobrar.', { groups: plural(allSel, 'grupo', 'grupos') })) : null],
      permanentTitle: tn(picked.length, 'Apagar {n} arquivo definitivamente?', 'Apagar {n} arquivos definitivamente?'),
      confirm: t('Mover para o Lixo'), glyph: 'trash', mod: 'files',
      permanentChoice: true, permanentDefault: !!(store.settings && store.settings.permanentDelete),
    });
    if (!ok) return;
    const permanent = ok === 'permanent';
    F.phase = 'moving';
    ctx.setBusy(true);
    st = null; ensureStage(); st.busy(true);
    const prog = h('p', { class: 'sub' }, t('{done} de {total}', { done: fmtNum(0), total: fmtNum(picked.length) }));
    st.show(h('h1', { class: 'h1' }, permanent ? t('Apagando…') : t('Movendo para o Lixo…')), prog);
    const sd = stopDock(ctx, 'files');
    const byId = new Map(picked.map((i) => [i.id, i]));
    const ids = picked.map((i) => i.id);
    const okIds = new Set();
    const failures = [];
    let freed = 0, done = 0;
    for (let i = 0; i < ids.length; i += REMOVE_BATCH) {
      const chunk = ids.slice(i, i + REMOVE_BATCH);
      if (sd.stopped()) { failures.push(...chunk.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: t('cancelado; o item continua no lugar') }))); continue; }
      try {
        const res = await api.remove(chunk, permanent);
        for (const o of res.outcomes) if (o.ok) { okIds.add(o.id); freed += o.freed || 0; }
        failures.push(...outcomesToFailures(res.outcomes, byId));
      } catch (e) {
        failures.push(...chunk.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: tr(e.message) })));
      }
      done += chunk.length;
      prog.textContent = t('{done} de {total}', { done: fmtNum(done), total: fmtNum(ids.length) });
      sd.progress(done / ids.length);
    }
    prune(okIds);
    bump(); store.trash = null;
    F.moved = freed; F.failed = failures.length; F.permanent = permanent; F.evicted = false; F.phase = 'done';
    const real = realFailures(failures);
    if (freed) play('clean'); else if (!sd.stopped() || real.length) play('error'); // a bare Stop is not an error
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (real.length) failuresSheet(real);
  }

  // ---------- iCloud: remove the local copy ("Remover do Mac"); the file stays in iCloud ----------
  async function evict() {
    const r = resOf('icloud');
    if (!r) return;
    const picked = r.groups.flatMap((g) => g.items).filter((i) => S.csel.has(i.id));
    if (!picked.length) return;
    const bytes = picked.reduce((a, i) => a + i.size, 0);
    const ok = await confirmDialog({
      title: t('Remover {files} deste Mac?', { files: plural(picked.length, 'arquivo', 'arquivos') }),
      body: withNode(t('Isso libera cerca de {size}. {b} e baixam de novo quando você abrir. Nada é apagado da nuvem nem enviado ao Lixo.', { size: fmtBytes(bytes), b: MARK }), h('strong', null, t('Os arquivos continuam no iCloud'))),
      confirm: t('Remover do Mac'), glyph: 'cloud', mod: 'files',
    });
    if (!ok) return;
    F.phase = 'moving';
    ctx.setBusy(true);
    st = null; ensureStage(); st.busy(true);
    const line = h('p', { class: 'sub' }, t('{done} de {total}', { done: fmtNum(0), total: fmtNum(picked.length) }));
    st.show(h('h1', { class: 'h1' }, t('Removendo do Mac…')), line);
    ctx.setDock(null); // the backend cannot interrupt between batches: no button that looks like Stop
    const byId = new Map(picked.map((i) => [i.id, i]));
    const okIds = new Set(), failures = [];
    let freed = 0, done = 0;
    for (let i = 0; i < picked.length; i += EVICT_BATCH) {
      const chunk = picked.slice(i, i + EVICT_BATCH);
      try {
        const res = await api.cloudEvict(chunk.map((c) => c.id));
        for (const o of res.outcomes) if (o.ok) { okIds.add(o.id); freed += o.freed || 0; }
        failures.push(...outcomesToFailures(res.outcomes, byId));
      } catch (e) {
        failures.push(...chunk.map((c) => ({ id: c.id, name: c.name, path: c.path, error: tr(e.message) })));
      }
      done += chunk.length;
      if (ctx.alive) line.textContent = t('{done} de {total}', { done: fmtNum(done), total: fmtNum(picked.length) });
    }
    prune(okIds);
    bump(); // the Trash is untouched: its cached result stays valid
    F.moved = freed; F.failed = failures.length; F.permanent = false; F.evicted = true; F.phase = 'done';
    play(freed ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (failures.length) failuresSheet(failures);
  }

  function renderDone() {
    const left = CATS.some((c) => countOf(c.id));
    const cap = F.evicted ? t('liberados neste Mac') : F.permanent ? t('apagados definitivamente') : t('movidos para o Lixo');
    st.show(h('div', { class: 'big' }, bytesParts(F.moved).value, h('small', null, bytesParts(F.moved).unit)), h('div', { class: 'big-cap' }, cap),
      h('p', { class: 'sub' }, [
        // With nothing moved, "Empty the Trash" would send the user to do something pointless.
        F.evicted ? (F.moved > 0 || !F.failed ? t('Os arquivos continuam no iCloud e baixam de novo quando você abrir.') : t('Nada foi liberado.'))
          : F.moved === 0 ? t('Nada foi movido.') : F.permanent ? t('O espaço já foi liberado.') : t('Esvazie a Lixeira para liberar o espaço no disco.'),
        F.failed ? ' ' + tn(F.failed, '{n} item não foi removido.', '{n} itens não foram removidos.') : '',
      ]),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), t('Ver log')),
        left ? h('button', { class: 'btn', type: 'button', onClick: () => { F.phase = S.res.full ? 'results' : 'review'; render(); } }, t('Revisar mais itens')) : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { S.res = null; F.phase = 'idle'; render(); } }, t('Concluir'))));
    st.succeeded(F.moved > 0); // celebrated only when something was actually handled
    ctx.setDock(null);
  }

  render();
}
