// Meus Arquivos (Files): arquivos grandes e antigos, duplicados, imagens parecidas e downloads.
// Nada vem pré-selecionado; a ação é mover para o Lixo; a interface só envia ids do registro, nunca caminhos.
// Nomes e caminhos vêm do disco (não confiáveis): só textContent / createElement.
import { play } from '../sound.js';
import { h, s, mount, mid } from '../dom.js';
import { icon, groupIcon } from '../art.js';
import { api } from '../api.js';
import { store, selectedSize, pruneResult, bump, countItems } from '../store.js';
import { bytesParts, fmtBytes, fmtNum, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, chipRow, checkbox, segmented } from '../ui.js';
import { outcomesToFailures, stopDock } from '../actions.js';

const OPTIONS = [{ value: 50, label: '50 MB' }, { value: 100, label: '100 MB' }, { value: 500, label: '500 MB' }, { value: 1000, label: '1 GB' }];
const CHUNK = 60;
const SETS_CHUNK = 40;
const REMOVE_BATCH = 100;

// Ícones locais (art.js pertence a outro módulo): mesmo traço dos demais.
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
  { id: 'large', label: 'Grandes e antigos', ic: 'folder', desc: 'Arquivos pesados que talvez você não use mais. Nada é removido sem a sua escolha.' },
  { id: 'dups', label: 'Duplicados', ic: 'copy', desc: 'Cópias idênticas de arquivos, em pastas diferentes, que ocupam espaço à toa. Acima de 100 KB.' },
  { id: 'sim', label: 'Imagens parecidas', ic: 'image', desc: 'Fotos quase iguais. O ponto verde marca a melhor cópia para manter. Acima de 100 KB.' },
  { id: 'dl', label: 'Downloads', ic: 'download', desc: 'Arquivos da pasta Downloads, agrupados pelo app que os baixou.' },
];
const SELECT_MODES = {
  dups: [['smart', 'Inteligente', 'Tudo, menos o original sugerido'], ['oldest', 'Mais antigos', 'As cópias mais antigas; mantém a mais nova'], ['newest', 'Mais novos', 'As cópias mais novas; mantém a mais antiga'], ['none', 'Nada', 'Limpa a seleção']],
  sim: [['smart', 'Inteligente', 'Tudo, menos a melhor qualidade'], ['smallest', 'Menores', 'As menores; mantém a maior de cada grupo'], ['largest', 'Maiores', 'As maiores; mantém a menor de cada grupo'], ['none', 'Nada', 'Limpa a seleção']],
};

const dtf = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'always' });
const fmtDate = (sec) => (sec ? dtf.format(new Date(sec * 1000)) : '—');
function accessText(sec) {
  if (!sec) return '';
  const d = Date.now() / 1000 - sec;
  for (const [unit, size] of [['year', 31557600], ['month', 2629800], ['week', 604800], ['day', 86400]]) {
    if (d >= size) return 'acessado ' + rtf.format(-Math.floor(d / size), unit);
  }
  return 'acessado hoje';
}

// Estado que sobrevive à troca de módulo (a view é recriada a cada entrada).
const S = {
  locs: null, loc: 0,
  res: null,            // { large, dups, sim, dl, loc, locName, minMb, full }; cada um é um ScanResult ou null
  lsel: new Set(),      // seleção de Grandes e antigos
  sel: new Set(),       // seleção de duplicados, parecidas e downloads (ids são únicos)
  cat: 'large', view: 'kind', open: new Set(), limits: new Map(), thumbs: new Map(),
};

const resOf = (c) => (S.res ? S.res[c] : null);
const selOf = (c) => (c === 'large' ? S.lsel : S.sel);
const countOf = (c) => (resOf(c) ? countItems(resOf(c)) : 0);
const keeperOf = (g) => g.items.find((i) => i.note) || g.items[0];

// Cópias que sobrariam depois de remover tudo menos o original sugerido.
function reclaim(result) {
  let n = 0, bytes = 0;
  if (result) for (const g of result.groups) { const k = keeperOf(g); for (const i of g.items) if (i !== k) { n++; bytes += i.size; } }
  return { n, bytes };
}

function totals() {
  let bytes = 0, count = 0;
  for (const c of CATS) { const t = selectedSize(resOf(c.id), selOf(c.id)); bytes += t.bytes; count += t.count; }
  return { bytes, count };
}

function groupState(items, sel) {
  let n = 0;
  for (const i of items) if (sel.has(i.id)) n++;
  return n === 0 ? 'off' : n === items.length ? 'on' : 'mixed';
}

// Seleção em lote de duplicados/parecidas: sempre deixa pelo menos uma cópia de cada grupo fora da seleção.
function applySelect(cat, mode) {
  const sel = S.sel;
  const result = resOf(cat);
  for (const g of result.groups) for (const i of g.items) sel.delete(i.id);
  if (mode === 'none') return;
  for (const g of result.groups) {
    const byDate = [...g.items].sort((a, b) => (a.modified || 0) - (b.modified || 0) || a.path.localeCompare(b.path));
    const bySize = [...g.items].sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
    const keep = { smart: keeperOf(g), oldest: byDate[byDate.length - 1], newest: byDate[0], smallest: bySize[bySize.length - 1], largest: bySize[0] }[mode];
    for (const i of g.items) if (i !== keep) sel.add(i.id);
  }
}

// Grandes e antigos: subgrupos por tipo (do backend), tamanho ou data de acesso.
function largeSections(result, view) {
  if (view === 'kind') return result.groups.map((g) => ({ id: g.id, title: g.title, items: g.items }));
  const all = result.groups.flatMap((g) => g.items);
  const buckets = view === 'size'
    ? [['s5', 'Acima de 5 GB', (i) => i.size >= 5e9], ['s1', 'De 1 GB a 5 GB', (i) => i.size >= 1e9], ['s05', 'De 500 MB a 1 GB', (i) => i.size >= 5e8], ['s0', 'Abaixo de 500 MB', () => true]]
    : (() => {
      const age = (i) => (i.accessed ? (Date.now() / 1000 - i.accessed) / 86400 : null);
      return [['a365', 'Acessados há mais de 1 ano', (i) => age(i) !== null && age(i) >= 365], ['a180', 'Entre 6 meses e 1 ano', (i) => age(i) !== null && age(i) >= 180], ['a30', 'Entre 1 e 6 meses', (i) => age(i) !== null && age(i) >= 30], ['a0', 'No último mês', (i) => age(i) !== null], ['an', 'Sem data de acesso', () => true]];
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

  // Sweep entrega só o resultado de arquivos grandes (fase "review"): abre o gerenciador só com essa categoria.
  if (store.large && F.phase === 'review' && (!S.res || S.res.largeRef !== store.large)) {
    S.res = { large: store.large, dups: null, sim: null, dl: null, loc: 0, locName: 'Pasta pessoal', minMb: store.largeMb, full: false, largeRef: store.large, ownsStore: true };
    S.lsel = new Set(); S.sel = new Set(); S.cat = 'large';
  }
  if (!S.res && !['idle', 'scanning'].includes(F.phase)) F.phase = 'idle';
  if (F.phase === 'scanning' || F.phase === 'moving') F.phase = 'idle';

  function ensureStage() {
    if (!st) { st = stage('files', 'folder', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    st.busy(false);
  }

  function render() {
    teardown();
    if (F.phase === 'review' && S.res) return renderManager();
    if (F.phase === 'results' && S.res && S.res.full) return renderResults();
    ensureStage();
    if (F.phase === 'done') return renderDone();
    return renderIdle();
  }

  // ---------- Início ----------
  function renderIdle() {
    F.phase = 'idle';
    const select = h('select', { class: 'fl-select', 'aria-label': 'Local para analisar', onChange: (e) => { S.loc = Number(e.target.value); } },
      (S.locs || [{ index: 0, name: 'Pasta pessoal', free: 0, total: 0 }]).map((l) => h('option', { value: l.index, selected: l.index === S.loc }, l.total ? `${l.name} · ${fmtBytes(l.free)} livres` : l.name)));
    const feats = [['folder', 'Arquivos grandes e antigos'], ['copy', 'Duplicados'], ['image', 'Imagens parecidas'], ['download', 'Downloads']];
    st.show(h('h1', { class: 'h1' }, 'Meus Arquivos'),
      h('p', { class: 'sub' }, 'Organize seus arquivos e reduza a bagunça em poucos cliques.'),
      h('ul', { class: 'feats' }, feats.map(([ic, txt]) => h('li', null, h('span', { class: 'feat-chip' }, fi(ic, 17)), txt))),
      h('div', { class: 'fl-where' },
        h('label', { class: 'fl-lab' }, 'Local'),
        h('div', { class: 'fl-select-wrap' }, fi('disk', 18), select, fi('down', 15)),
        h('label', { class: 'fl-lab' }, 'Arquivos grandes a partir de'),
        chipRow(OPTIONS, store.largeMb, (v) => { store.largeMb = v; })),
      S.res ? h('div', { class: 'row-actions', style: 'margin-top:18px' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { F.phase = S.res.full ? 'results' : 'review'; render(); } }, 'Voltar aos resultados')) : null);
    ctx.setDock({ label: 'Analisar', mod: 'files', onClick: scan });
    if (!S.locs) {
      api.clutterLocations().then((l) => { if (!ctx.alive) return; S.locs = l; S.loc = Math.min(S.loc, l.length - 1); if (F.phase === 'idle' && st) renderIdle(); }).catch(() => {});
    }
  }

  // ---------- Análise ----------
  async function scan() {
    const loc = S.loc, mb = store.largeMb;
    const home = loc === 0;
    const steps = [
      { k: 'large', task: 'large', label: 'Arquivos grandes e antigos', run: () => api.largeAt(loc, mb) },
      home && { k: 'dl', task: 'downloads', label: 'Downloads', run: () => api.downloads() },
      { k: 'dups', task: 'duplicates', label: 'Duplicados', run: () => api.duplicates(loc) },
      { k: 'sim', task: 'similar', label: 'Imagens parecidas', run: () => api.similar(loc) },
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
    st.show(h('h1', { class: 'h1' }, 'Analisando…'), h('p', { class: 'sub' }, S.locs && S.locs[loc] ? S.locs[loc].name : 'Pasta pessoal'), h('ul', { class: 'fl-steps' }, [...rows.values()]), ticker);
    let current = '';
    ctx.onProgress((p) => { if (p.task === current) ticker.textContent = p.path || ''; });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'files', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'files' }); api.cancel().catch(() => {}); } });
    const out = {};
    for (const step of steps) {
      if (cancelled) break;
      current = step.task;
      ticker.textContent = '';
      mark(step.k, 'run');
      try {
        const r = await step.run();
        if (cancelled) break;
        out[step.k] = r;
        mark(step.k, 'done', plural(countItems(r), 'item', 'itens'));
      } catch (e) {
        if (cancelled) break;
        out[step.k] = { groups: [], total: 0, needsFda: false };
        mark(step.k, 'skip', 'não concluído');
      }
    }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (cancelled) { F.phase = 'idle'; return render(); }
    const empty = { groups: [], total: 0, needsFda: false };
    S.res = { large: out.large || empty, dl: out.dl || (home ? empty : null), dups: out.dups || empty, sim: out.sim || empty, loc, locName: S.locs && S.locs[loc] ? S.locs[loc].name : 'Pasta pessoal', minMb: mb, full: true, largeRef: null, ownsStore: home };
    S.lsel = new Set(); S.sel = new Set(); S.open = new Set(); S.limits = new Map(); S.thumbs = new Map();
    if (home) { store.large = S.res.large; store.largeSel = S.lsel; }
    S.res.largeRef = store.large;
    bump();
    F.phase = 'results';
    play('found');
    render();
  }

  // ---------- Resultados (blocos) ----------
  function renderResults() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const r = S.res;
    const dup = reclaim(r.dups), sim = reclaim(r.sim);
    const dlTop = r.dl && r.dl.groups[0];
    const total = countOf('large') + dup.n + sim.n + countOf('dl');
    const tiles = [
      {
        cat: 'dups', ic: 'copy', n: dup.n, label: 'Duplicados',
        title: `${fmtNum(dup.n)} ${dup.n === 1 ? 'duplicado' : 'duplicados'}`,
        sub: `Libere ${fmtBytes(dup.bytes)} removendo cópias idênticas.`, empty: 'Nenhuma cópia idêntica encontrada.',
      },
      {
        cat: 'sim', ic: 'image', n: sim.n, label: 'Imagens parecidas',
        title: `${fmtNum(sim.n)} ${sim.n === 1 ? 'imagem parecida' : 'imagens parecidas'}`,
        sub: `${fmtBytes(sim.bytes)} em fotos quase idênticas.`, empty: 'Nenhuma imagem parecida encontrada.',
      },
      {
        cat: 'dl', ic: 'download', n: r.dl ? countOf('dl') : 0, label: 'Downloads',
        title: dlTop ? (dlTop.title === 'Outros' ? `${fmtBytes(dlTop.total)} em outros downloads` : `${fmtBytes(dlTop.total)} de downloads do ${dlTop.title}`) : 'Downloads',
        sub: dlTop ? `${plural(dlTop.items.length, 'arquivo', 'arquivos')}${r.dl.groups.length > 1 ? ` · e mais ${plural(r.dl.groups.length - 1, 'origem', 'origens')}` : ''}` : '',
        empty: r.dl ? 'A pasta Downloads está vazia.' : 'Os Downloads são analisados só na pasta pessoal.',
      },
      {
        cat: 'large', ic: 'folder', n: countOf('large'), label: 'Arquivos grandes e antigos',
        title: `${fmtBytes(r.large.total)} em arquivos grandes e antigos`,
        sub: `${plural(countOf('large'), 'arquivo', 'arquivos')} acima de ${fmtBytes(r.minMb * 1e6)}.`, empty: `Nenhum arquivo acima de ${fmtBytes(r.minMb * 1e6)}.`,
      },
    ];
    const el = h('section', { class: 'fl-results enter', dataset: { mod: 'files' }, 'aria-label': 'Resultados' },
      h('div', { class: 'fl-bar' }, h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { F.phase = 'idle'; render(); } }, icon('back', 15), 'Recomeçar'), h('span', { class: 'fl-where-tag' }, r.locName)),
      h('h2', { class: 'fl-title' }, total ? `Você tem ${plural(total, 'arquivo', 'arquivos')} para revisar.` : 'Nada para revisar por aqui.'),
      h('p', { class: 'sub fl-sub' }, total ? 'Revise cada categoria. Nada é selecionado nem removido sem a sua escolha.' : 'Tente outro local ou um tamanho mínimo menor.'),
      total ? h('button', { class: 'btn primary fl-all', type: 'button', onClick: () => open(CATS.find((c) => countOf(c.id))?.id || 'large') }, 'Revisar todos os arquivos') : null,
      h('div', { class: 'fl-tiles' }, tiles.map((t) => h('div', { class: 'fl-tile' + (t.n ? '' : ' none'), dataset: { cat: t.cat } },
        h('span', { class: 'fl-tile-ic' }, fi(t.ic, 26)),
        h('div', { class: 'fl-tile-t' }, t.n ? t.title : t.label),
        h('div', { class: 'fl-tile-s' }, t.n ? t.sub : t.empty),
        t.n ? h('button', { class: 'btn sm', type: 'button', onClick: () => open(t.cat) }, 'Revisar') : null))));
    mount(ctx.root, el);
  }

  function open(cat) { S.cat = cat; F.phase = 'review'; render(); }

  // ---------- Gerenciador ----------
  function renderManager() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const avail = CATS.filter((c) => resOf(c.id));
    if (!avail.some((c) => c.id === S.cat)) S.cat = (avail.find((c) => countOf(c.id)) || avail[0]).id;

    const catsEl = h('nav', { class: 'fm-cats', 'aria-label': 'Categorias' });
    const headEl = h('div', { class: 'fm-pane-head' });
    const listEl = h('div', { class: 'fm-list' });
    const selEl = h('div', { class: 'rv-sel' });
    const actionBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => move() }, 'Mover para o Lixo');
    let io = null;
    listeners.push(() => { if (io) io.disconnect(); });
    const queue = [];
    let inflight = 0;

    function renderCats() {
      mount(catsEl, avail.map((c) => {
        const t = selectedSize(resOf(c.id), selOf(c.id));
        const result = resOf(c.id);
        return h('button', { class: 'fm-cat', type: 'button', 'aria-current': String(c.id === S.cat), onClick: () => { if (S.cat !== c.id) { S.cat = c.id; renderPane(); renderCats(); } } },
          h('span', { class: 'fm-cat-ic' }, fi(c.ic, 17)),
          h('span', { class: 'fm-cat-t' }, h('b', null, c.label), h('span', null, countOf(c.id) ? `${plural(countOf(c.id), 'item', 'itens')} · ${fmtBytes(result.total)}` : 'Nada encontrado')),
          t.count ? h('span', { class: 'fm-cat-n', title: `${plural(t.count, 'item selecionado', 'itens selecionados')}` }, fmtNum(t.count)) : null);
      }));
    }

    function renderFoot() {
      const { bytes, count } = totals();
      mount(selEl, 'Selecionado: ', h('b', null, fmtBytes(bytes)), h('small', null, plural(count, 'item', 'itens')));
      actionBtn.disabled = count === 0;
    }

    function refresh() { renderCats(); renderList(); renderFoot(); }

    function menu(cat) {
      const modes = SELECT_MODES[cat];
      const label = h('b', null, 'escolher');
      const btn = h('button', { class: 'fm-sel', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, h('span', null, 'Selecionar:'), label, fi('down', 14));
      const pop = h('div', { class: 'fm-menu', role: 'menu', hidden: true }, modes.map(([mode, text, hint]) => h('button', { class: 'fm-menu-i', type: 'button', role: 'menuitem', title: hint, onClick: () => { close(); applySelect(cat, mode); label.textContent = mode === 'none' ? 'nada' : text.toLowerCase(); refresh(); } }, text)));
      const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
      const onKey = (e) => { if (e.key === 'Escape') { close(); btn.focus(); } };
      function close() { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); }
      btn.addEventListener('click', () => {
        if (!pop.hidden) return close();
        pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true);
        listeners.push(close);
        pop.querySelector('button').focus();
      });
      const wrap = h('div', { class: 'fm-menu-wrap' }, btn, pop);
      return wrap;
    }

    function renderPane() {
      const c = CATS.find((x) => x.id === S.cat);
      const kids = [h('div', { class: 'fm-pane-t' }, h('h3', null, c.label), h('p', null, c.desc))];
      const tools = [];
      if (c.id === 'large') tools.push(segmented([{ value: 'kind', label: 'Tipo' }, { value: 'size', label: 'Tamanho' }, { value: 'access', label: 'Data de acesso' }], S.view, (v) => { S.view = v; renderList(); }, 'Agrupar por'));
      if (c.id === 'dups' || c.id === 'sim') tools.push(menu(c.id));
      if (tools.length && countOf(c.id)) kids.push(h('div', { class: 'fm-tools' }, tools));
      mount(headEl, kids);
      listEl.scrollTop = 0;
      renderList();
    }

    // ---- linhas e seções ----
    function fileRow(it, sel, opts = {}) {
      const cb = checkbox(sel.has(it.id) ? 'on' : 'off', () => toggle(), `Selecionar ${it.name}`);
      const toggle = () => { sel.has(it.id) ? sel.delete(it.id) : sel.add(it.id); refresh(); };
      return h('div', { class: 'fm-row', onClick: toggle },
        cb,
        h('div', { class: 'fm-ic' }, itemIcon(it.name)),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, h('span', { title: it.name }, it.name), it.note ? h('span', { class: 'badge info' }, it.note) : null),
          h('div', { class: 'fm-meta' }, mid(it.path, 26))),
        h('span', { class: 'fm-size' }, fmtBytes(it.size), opts.when ? h('small', null, opts.when(it)) : null),
        h('button', { class: 'icon-btn fm-act', type: 'button', title: 'Mostrar no Finder', 'aria-label': `Mostrar ${it.name} no Finder`, onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 16)));
    }

    function more(key, total, shown, step = CHUNK) {
      return h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.limits.set(key, (S.limits.get(key) || step) + step * 3); renderList(); } }, `Mostrar mais (${plural(total - shown, 'item', 'itens')})`));
    }

    function section(sec, sel, key, opts) {
      const limit = S.limits.get(key) || CHUNK;
      const shown = sec.items.slice(0, limit);
      const cb = checkbox(groupState(sec.items, sel), (cur) => { for (const i of sec.items) cur === 'on' ? sel.delete(i.id) : sel.add(i.id); refresh(); }, `Selecionar ${sec.title}`);
      const total = sec.items.reduce((a, i) => a + i.size, 0);
      return h('section', { class: 'fm-sec' },
        h('div', { class: 'fm-sec-head' }, cb, h('b', { title: sec.title }, sec.title), h('span', null, `${plural(sec.items.length, 'item', 'itens')} · ${fmtBytes(total)}`)),
        shown.map((it) => fileRow(it, sel, opts)),
        sec.items.length > shown.length ? more(key, sec.items.length, shown.length) : null);
    }

    function dupSet(g) {
      const sel = S.sel;
      const open = S.open.has(g.id);
      const n = g.items.filter((i) => sel.has(i.id)).length;
      const all = n === g.items.length;
      const head = h('button', { class: 'fm-set-head', type: 'button', 'aria-expanded': String(open), onClick: () => { open ? S.open.delete(g.id) : S.open.add(g.id); renderList(); } },
        h('span', { class: 'fm-chev' }, fi('chevron', 16)),
        h('span', { class: 'fm-ic' }, itemIcon(g.title)),
        h('span', { class: 'fm-set-t' }, h('b', { title: g.title }, g.title), h('span', null, g.description)),
        all ? h('span', { class: 'badge', title: 'Todas as cópias estão selecionadas; nenhuma vai sobrar' }, 'Todas selecionadas') : null,
        n && !all ? h('span', { class: 'fm-count' }, h('i', null, fmtNum(n)), h('span', null, fmtNum(g.items.length))) : h('span', { class: 'fm-count off' }, fmtNum(g.items.length)));
      return h('section', { class: 'fm-set', 'data-open': String(open) }, head,
        open ? g.items.map((it) => fileRow(it, sel, { when: (x) => `modificado ${fmtDate(x.modified)}` })) : null);
    }

    function simCluster(g, idx) {
      const sel = S.sel;
      const n = g.items.filter((i) => sel.has(i.id)).length;
      const all = n === g.items.length;
      const cb = checkbox(groupState(g.items, sel), (cur) => { for (const i of g.items) cur === 'on' ? sel.delete(i.id) : sel.add(i.id); refresh(); }, `Selecionar o grupo ${idx + 1}`);
      const keeper = keeperOf(g);
      return h('section', { class: 'fm-sec' },
        h('div', { class: 'fm-sec-head' }, cb, h('b', { title: g.title }, `Grupo ${idx + 1} · ${g.title}`), h('span', null, `${g.description} · ${fmtBytes(g.total)}`), all ? h('span', { class: 'badge', title: 'Todas as imagens estão selecionadas; nenhuma vai sobrar' }, 'Todas selecionadas') : null),
        h('div', { class: 'fm-grid' }, g.items.map((it) => {
          const on = sel.has(it.id);
          const img = h('img', { alt: '', draggable: 'false', hidden: true });
          const ph = h('span', { class: 'fm-img-ph' }, fi('image', 22));
          const card = h('div', { class: 'fm-img', role: 'button', tabindex: '0', 'aria-pressed': String(on), 'aria-label': `${on ? 'Desmarcar' : 'Selecionar'} ${it.name}`, dataset: { on: String(on), id: it.id },
            onClick: () => { on ? sel.delete(it.id) : sel.add(it.id); refresh(); },
            onKeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); on ? sel.delete(it.id) : sel.add(it.id); refresh(); } } },
            h('div', { class: 'fm-img-box' }, ph, img),
            h('span', { class: 'cb fm-img-cb', 'data-state': on ? 'on' : 'off', 'aria-hidden': 'true' }, icon('check', 14)),
            it === keeper ? h('span', { class: 'fm-keep', title: 'Melhor qualidade: sugerida para manter' }) : null,
            h('div', { class: 'fm-img-cap' }, h('span', { title: it.name }, it.name), h('small', null, `${fmtBytes(it.size)} · ${fmtDate(it.modified)}`)),
            h('button', { class: 'icon-btn fm-act fm-img-act', type: 'button', title: 'Mostrar no Finder', 'aria-label': `Mostrar ${it.name} no Finder`, onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 15)));
          loadThumb(card, img, ph, it.id);
          return card;
        })));
    }

    // ---- miniaturas: carregadas só quando visíveis, 3 por vez ----
    function loadThumb(card, img, ph, id) {
      const apply = (url) => { if (url) { img.src = url; img.hidden = false; ph.hidden = true; } };
      card._thumb = { id, apply };
      if (S.thumbs.has(id)) return apply(S.thumbs.get(id));
      if (io) io.observe(card);
    }
    function pump() {
      while (inflight < 3 && queue.length) {
        const { id, apply } = queue.shift();
        inflight++;
        api.thumb(id).then((url) => { S.thumbs.set(id, url || null); if (ctx.alive) apply(url); }).catch(() => { S.thumbs.set(id, null); }).finally(() => { inflight--; pump(); });
      }
    }

    function renderList() {
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
        body = h('div', { class: 'rv-empty' }, c === 'large' ? `Nenhum arquivo acima de ${fmtBytes(S.res.minMb * 1e6)}.` : 'Nada encontrado nesta categoria.');
      } else if (c === 'large') {
        body = largeSections(result, S.view).map((sec) => section(sec, S.lsel, `large:${S.view}:${sec.id}`, { when: (i) => accessText(i.accessed) || `modificado ${fmtDate(i.modified)}` }));
      } else if (c === 'dl') {
        body = result.groups.map((g) => section({ id: g.id, title: g.title, items: g.items }, S.sel, `dl:${g.id}`, { when: (i) => fmtDate(i.modified) }));
      } else {
        const limit = S.limits.get(c) || SETS_CHUNK;
        if (c === 'dups' && !S.open.size && result.groups[0]) S.open.add(result.groups[0].id);
        const shown = result.groups.slice(0, limit);
        body = [shown.map((g, i) => (c === 'dups' ? dupSet(g) : simCluster(g, i))),
          result.groups.length > shown.length ? h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.limits.set(c, limit + SETS_CHUNK); renderList(); } }, `Mostrar mais (${plural(result.groups.length - shown.length, 'grupo', 'grupos')})`)) : null];
      }
      mount(listEl, body);
      listEl.scrollTop = keep;
    }

    const back = () => { F.phase = S.res.full ? 'results' : 'idle'; render(); };
    const subtitle = S.res.full ? `${S.res.locName}` : 'Pasta pessoal';
    const el = h('section', { class: 'review fm enter', dataset: { mod: 'files' }, 'aria-label': 'Gerenciador de arquivos' },
      h('div', { class: 'rv-head' }, h('div', { class: 'rv-title' }, h('h2', null, 'Gerenciador de arquivos'), h('p', null, subtitle))),
      h('div', { class: 'fm-body' }, catsEl, h('div', { class: 'fm-pane' }, headEl, listEl)),
      h('div', { class: 'rv-foot' }, selEl, h('button', { class: 'btn', type: 'button', onClick: back }, S.res.full ? 'Voltar' : 'Início'), actionBtn));
    mount(ctx.root, el);
    renderPane();
    renderCats();
    renderFoot();
  }

  // ---------- Remoção ----------
  async function move() {
    const picked = [];
    for (const c of CATS) { const r = resOf(c.id); if (r) for (const g of r.groups) for (const i of g.items) if (selOf(c.id).has(i.id)) picked.push(i); }
    if (!picked.length) return;
    const bytes = picked.reduce((a, i) => a + i.size, 0);
    let allSel = 0;
    for (const c of ['dups', 'sim']) { const r = resOf(c); if (r) for (const g of r.groups) if (g.items.length && g.items.every((i) => S.sel.has(i.id))) allSel++; }
    const ok = await confirmDialog({
      title: `Mover ${plural(picked.length, 'arquivo', 'arquivos')} para o Lixo?`,
      body: [`${fmtBytes(bytes)} serão enviados ao Lixo. Você pode restaurá-los de lá `, h('strong', null, 'até esvaziar a Lixeira'), '.',
        allSel ? h('span', { class: 'fl-warn' }, ` Atenção: em ${plural(allSel, 'grupo', 'grupos')} de cópias todos os itens estão selecionados, então nenhuma cópia vai sobrar.`) : null],
      confirm: 'Mover para o Lixo', glyph: 'trash', mod: 'files',
      permanentChoice: true, permanentDefault: !!(store.settings && store.settings.permanentDelete),
    });
    if (!ok) return;
    const permanent = ok === 'permanent';
    F.phase = 'moving';
    ctx.setBusy(true);
    st = null; ensureStage(); st.busy(true);
    const prog = h('p', { class: 'sub' }, `0 de ${fmtNum(picked.length)}`);
    st.show(h('h1', { class: 'h1' }, permanent ? 'Apagando…' : 'Movendo para o Lixo…'), prog);
    const sd = stopDock(ctx, 'files');
    const byId = new Map(picked.map((i) => [i.id, i]));
    const ids = picked.map((i) => i.id);
    const okIds = new Set();
    const failures = [];
    let freed = 0, done = 0;
    for (let i = 0; i < ids.length; i += REMOVE_BATCH) {
      const chunk = ids.slice(i, i + REMOVE_BATCH);
      if (sd.stopped()) { failures.push(...chunk.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: 'cancelado; o item continua no lugar' }))); continue; }
      try {
        const res = await api.remove(chunk, permanent);
        for (const o of res.outcomes) if (o.ok) { okIds.add(o.id); freed += o.freed || 0; }
        failures.push(...outcomesToFailures(res.outcomes, byId));
      } catch (e) {
        failures.push(...chunk.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: e.message })));
      }
      done += chunk.length;
      prog.textContent = `${fmtNum(done)} de ${fmtNum(ids.length)}`;
      sd.progress(done / ids.length);
    }
    for (const c of CATS) {
      const r = resOf(c.id);
      if (!r) continue;
      let pruned = pruneResult(r, okIds);
      // Um grupo de cópias com um item só deixou de ser grupo.
      if (c.id === 'dups' || c.id === 'sim') {
        const groups = pruned.groups.filter((g) => g.items.length > 1);
        pruned = { ...pruned, groups, total: groups.reduce((a, g) => a + g.total, 0) };
      }
      S.res[c.id] = pruned;
      for (const id of okIds) selOf(c.id).delete(id);
    }
    if (S.res.ownsStore && store.large === S.res.largeRef) { store.large = S.res.large; S.res.largeRef = store.large; }
    bump(); store.trash = null;
    F.moved = freed; F.failed = failures.length; F.permanent = permanent; F.phase = 'done';
    play(freed ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (failures.length) failuresSheet(failures);
  }

  function renderDone() {
    const left = CATS.some((c) => countOf(c.id));
    st.show(h('div', { class: 'big' }, bytesParts(F.moved).value, h('small', null, bytesParts(F.moved).unit)), h('div', { class: 'big-cap' }, F.permanent ? 'apagados definitivamente' : 'movidos para o Lixo'),
      h('p', { class: 'sub' }, F.permanent ? 'O espaço já foi liberado.' : 'Esvazie a Lixeira para liberar o espaço no disco.'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        left ? h('button', { class: 'btn', type: 'button', onClick: () => { F.phase = S.res.full ? 'results' : 'review'; render(); } }, 'Revisar mais itens') : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { S.res = null; F.phase = 'idle'; render(); } }, 'Concluir')));
    ctx.setDock(null);
  }

  render();
}
