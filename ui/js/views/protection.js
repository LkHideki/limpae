// Security: security check (read-only), app permissions and privacy.
// Nothing is changed silently: the "fixes" only open the right Settings pane; revoking and removing ask for confirmation.
// The UI only sends backend ids, never paths, URLs or bundle ids. Names come from disk (untrusted):
// only textContent / createElement.
import { play } from '../sound.js';
import { h, s, mount, mid, keepFocus, keepPhaseFocus } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store, bump } from '../store.js';
import { bytesParts, fmtBytes, fmtNum, plural } from '../format.js';
import { confirmDialog, confirmRestart, failuresSheet, stage, checkbox, segmented, features, managerBar } from '../ui.js';
import { outcomesToFailures, realFailures, stopDock } from '../actions.js';
import { attachMenu, selectMenuButton } from '../menus.js';
import { t, tn, tr, lazyIntl } from '../i18n.js';
import { openSettings } from '../fda.js';

const REMOVE_BATCH = 100;

// Local icons (art.js belongs to another module): same stroke as the others.
const PATHS = {
  globe: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M4 12h16', 'M12 4c2.4 2.2 3.6 4.9 3.6 8s-1.2 5.8-3.6 8c-2.4-2.2-3.6-4.9-3.6-8S9.6 6.2 12 4z'],
  camera: ['M4 8h3l1.5-2h7L17 8h3v11H4z', 'M12 10.5a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z'],
  mic: ['M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3z', 'M6.5 11.5a5.5 5.5 0 0 0 11 0', 'M12 17v3'],
  screen: ['M4 5.5h16v10.5H4z', 'M9 19.5h6', 'M12 16v3.5'],
  access: ['M12 4.8a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z', 'M6 9.8h12', 'M12 9.8v4.4', 'M9 19.5l3-5.3 3 5.3'],
  keyboard: ['M3.5 7h17v10h-17z', 'M7 10.5h.01', 'M10 10.5h.01', 'M13 10.5h.01', 'M16.5 10.5h.01', 'M8 14h8'],
  person: ['M12 5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'M5 19.5c.8-3.2 3.7-5 7-5s6.2 1.8 7 5'],
  calendar: ['M4.5 6.5h15v13h-15z', 'M4.5 10.5h15', 'M8.5 4.5v3', 'M15.5 4.5v3'],
  reminders: ['M6 7h.01', 'M6 12h.01', 'M6 17h.01', 'M10 7h8', 'M10 12h8', 'M10 17h8'],
  image: ['M4.5 5.5h15v13h-15z', 'M4.5 16l4.6-4.6 3.6 3.6 2.4-2.4 4.4 4.4', 'M9 9.4h.01'],
  pin: ['M12 20s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z', 'M12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
  drive: ['M4 9.5h16v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M4 9.5l2-4h12l2 4', 'M16.5 14h.01'],
  down: ['M6.5 9.5l5.5 5.5 5.5-5.5'],
};
function pi(name, size = 18) {
  if (!PATHS[name]) return icon(name, size);
  return s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `i-${name}`, 'aria-hidden': 'true' },
    ...PATHS[name].map((d) => s('path', { d })));
}

const SERVICE_ICON = {
  Camera: 'camera', Microphone: 'mic', ScreenCapture: 'screen', Accessibility: 'access', ListenEvent: 'keyboard',
  SystemPolicyAllFiles: 'drive', AddressBook: 'person', Calendar: 'calendar', Reminders: 'reminders', Photos: 'image', Location: 'pin',
};
function serviceDesc(service) {
  switch (service) {
    case 'Camera': return t('Apps com permissão para usar a câmera.');
    case 'Microphone': return t('Apps com permissão para gravar áudio pelo microfone.');
    case 'ScreenCapture': return t('Apps que podem gravar o conteúdo da tela.');
    case 'Accessibility': return t('Apps que podem controlar o Mac por meio da Acessibilidade.');
    case 'ListenEvent': return t('Apps que podem observar o teclado e o mouse (Monitoramento de entrada).');
    case 'SystemPolicyAllFiles': return t('Apps com Acesso Total ao Disco: leem arquivos de qualquer pasta.');
    case 'AddressBook': return t('Apps que podem ler e alterar seus contatos.');
    case 'Calendar': return t('Apps que podem ler e alterar seus calendários.');
    case 'Reminders': return t('Apps que podem ler e alterar seus lembretes.');
    case 'Photos': return t('Apps com acesso à sua biblioteca de Fotos.');
    case 'Location': return t('Apps com acesso à sua localização.');
    default: return '';
  }
}

// tr() does not translate the value captured in {param}: the "(há 16 dias)" and the "desligada para: ..." list of the detail
// are translated beforehand, so the dictionary pattern matches with the fragments already in the right language.
function trDetail(text) {
  if (typeof text !== 'string') return text;
  const pre = text
    .replace(/\((hoje|há [^)]+)\)/, (m, ago) => `(${tr(ago)})`)
    .replace(/^(Instalação automática desligada para: )(.+)\.$/s, (m, a, items) => `${a}${tr(items)}.`);
  return tr(pre);
}

const areas = () => [{ value: 'checks', label: t('Verificação') }, { value: 'perms', label: t('Permissões') }, { value: 'privacy', label: t('Privacidade') }];

// Readable names of the macOS recent-item lists (the real file appears in the tooltip and in the path).
function recentLabel(name) {
  switch (name) {
    case 'com.apple.LSSharedFileList.RecentApplications.sfl3': return t('Apps abertos recentemente');
    case 'com.apple.LSSharedFileList.RecentDocuments.sfl3': return t('Documentos abertos recentemente');
    case 'com.apple.LSSharedFileList.RecentServers.sfl3':
    case 'com.apple.LSSharedFileList.RecentHosts.sfl3': return t('Servidores acessados recentemente');
    default: break;
  }
  const generic = /^com\.apple\.LSSharedFileList\.Recent(\w+)\.sfl\d?$/.exec(name);
  if (generic) return t('Recentes: {name}', { name: generic[1] });
  const app = /^(?:[\w-]+\.)+([\w-]+)\.sfl\d?$/.exec(name); // com.apple.preview.sfl3 -> Preview
  return app ? t('Documentos recentes do {app}', { app: app[1].charAt(0).toUpperCase() + app[1].slice(1) }) : name;
}

const dtf = lazyIntl('DateTimeFormat', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDate = (sec) => (sec ? dtf.format(new Date(sec * 1000)) : '');

const EMPTY_TCC = { needsFda: false, groups: [], cameraMicApps: 0, apps: 0 };
const EMPTY_PRIV = { groups: [], total: 0, browsers: [], needsFda: false };

// State that survives module switch (the view is recreated on every entry).
const S = {
  phase: 'idle', // idle | scanning | results | review | removing | done
  checks: null, tcc: null, priv: null,
  checksFailed: false, // the security_checks step failed: no checks to show, and no "protected" verdict
  tccFailed: false, privFailed: false, // the permissions / privacy read failed: their empty placeholders must not read as "nothing found"
  area: 'checks', svc: null, pcat: 'recent',
  rsel: new Set(), // permissions marked for revoking
  psel: new Set(), // privacy items marked for removal
  done: null,
};

const attention = () => (S.checks || []).filter((c) => c.ok === false).length;
const unknown = () => (S.checks || []).filter((c) => c.ok === null).length;
const privItems = () => S.priv.groups.flatMap((g) => g.items);

function privCats() {
  const groups = S.priv.groups;
  const cats = [{ id: 'recent', label: t('Itens recentes'), ic: 'clock', running: false, groups: groups.filter((g) => g.id === 'recent') }];
  for (const b of S.priv.browsers) {
    if (b.present) cats.push({ id: b.id, label: b.name, ic: 'globe', running: b.running, groups: groups.filter((g) => g.id.startsWith(b.id + ':')) });
  }
  return cats;
}
const catItems = (c) => c.groups.flatMap((g) => g.items);

function groupState(items, sel) {
  let n = 0;
  for (const i of items) if (sel.has(i.id)) n++;
  return n === 0 ? 'off' : n === items.length ? 'on' : 'mixed';
}

function selectPrivacy() {
  S.psel = new Set(privItems().filter((i) => i.selected).map((i) => i.id));
}
function selectInitial() {
  S.rsel = new Set();
  selectPrivacy();
}

function appIcon(row, size = 34) {
  const box = h('span', { class: 'pr-appic', style: `width:${size}px;height:${size}px` });
  if (row.icon) box.append(h('img', { src: row.icon, alt: '', draggable: 'false' }));
  else box.textContent = (row.name || '?').trim().charAt(0).toUpperCase();
  return box;
}

export function enter(ctx) {
  let st = null, cancelled = false;
  const listeners = [];
  const teardown = () => { listeners.splice(0).forEach((f) => f()); };
  ctx.onCleanup(teardown);

  if (['scanning', 'removing'].includes(S.phase)) S.phase = S.checks ? 'results' : 'idle';
  if (!S.checks && S.phase !== 'idle') S.phase = 'idle';

  function ensureStage() {
    if (!st) { st = stage('protect', 'shield', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    st.busy(false);
  }

  function render() { return keepPhaseFocus(ctx.root, paintScreen); }

  function paintScreen() {
    teardown();
    ctx.onBack(null);
    if (S.phase === 'review') return renderReview();
    if (S.phase === 'results') return renderResults();
    st = null;
    ensureStage();
    if (S.phase === 'done') return renderDone();
    return renderIdle();
  }

  // ---------- Start ----------
  function renderIdle() {
    S.phase = 'idle';
    st.show(h('h1', { class: 'h1' }, t('Segurança')),
      h('p', { class: 'sub' }, t('Confira a segurança do seu Mac, o que cada app pode acessar e o que fica registrado sobre o seu uso.')),
      features('protect', [['shield', t('Verificação de segurança')], ['lock', t('Permissões de apps')], ['eye', t('Privacidade')]]),
      S.checks ? h('div', { class: 'row-actions', style: 'margin-top:18px' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.phase = 'results'; render(); } }, t('Voltar aos resultados'))) : null);
    ctx.setDock({ label: t('Analisar'), mod: 'protect', onClick: scan });
  }

  // ---------- Scan ----------
  async function scan() {
    const steps = [
      { k: 'checks', task: null, label: t('Verificação de segurança'), run: () => api.securityChecks(), sum: (r) => (r.filter((c) => c.ok === false).length ? plural(r.filter((c) => c.ok === false).length, 'ponto de atenção', 'pontos de atenção') : t('tudo certo')) },
      { k: 'tcc', task: null, label: t('Permissões de apps'), run: () => api.tccPermissions(), sum: (r) => (r.needsFda ? t('requer acesso') : plural(r.apps, 'app', 'apps')) },
      { k: 'priv', task: 'privacy', label: t('Privacidade'), run: () => api.privacyScan(), sum: (r) => plural(r.groups.reduce((a, g) => a + g.items.length, 0), 'item', 'itens') },
    ];
    cancelled = false;
    S.phase = 'scanning';
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
    st.show(h('h1', { class: 'h1' }, t('Analisando…')), h('p', { class: 'sub' }, t('Somente leitura: nada é alterado nesta etapa.')), h('ul', { class: 'fl-steps' }, [...rows.values()]), ticker);
    let current = '';
    ctx.onProgress((p) => { if (current && p.task === current) ticker.textContent = p.path || ''; });
    ctx.setDock({ label: t('Parar'), busy: true, mod: 'protect', onClick: () => { cancelled = true; ctx.setDock({ label: t('Parando'), busy: true, disabled: true, mod: 'protect' }); api.cancel().catch(() => {}); } });
    const out = {};
    let okSteps = 0;
    for (const step of steps) {
      if (cancelled) break;
      current = step.task || '';
      ticker.textContent = '';
      mark(step.k, 'run');
      try {
        const r = await step.run();
        if (cancelled) break;
        out[step.k] = r;
        okSteps++;
        mark(step.k, 'done', step.sum(r));
      } catch (e) {
        if (cancelled) break;
        mark(step.k, 'skip', t('não concluído'));
      }
    }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (cancelled) { S.phase = S.checks ? 'results' : 'idle'; return render(); }
    S.checks = out.checks || [];
    S.checksFailed = !out.checks;
    S.tcc = out.tcc || EMPTY_TCC;
    S.priv = out.priv || EMPTY_PRIV;
    S.tccFailed = !out.tcc;
    S.privFailed = !out.priv;
    S.svc = null; S.pcat = 'recent';
    selectInitial();
    S.phase = 'results';
    play(okSteps ? 'found' : 'error'); // every step failed: no success chime over a screen of "not completed"
    render();
  }

  // ---------- Results (blocks) ----------
  function renderResults() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const bad = attention(), unk = unknown();
    const failed = S.checksFailed;
    const protectedMac = bad === 0 && !failed;
    const partial = S.tccFailed || S.privFailed; // a step could not be read: the title must not claim the Mac is protected
    const items = privItems();
    const itemBytes = items.reduce((a, i) => a + i.size, 0);
    const cams = S.tcc.cameraMicApps;
    const running = S.priv.browsers.filter((b) => b.present && b.running);

    const dotOf = (c) => (c.ok === true ? '' : c.ok === false ? ' bad' : ' unk');
    const mainTile = h('div', { class: 'pr-tile main' + (protectedMac ? '' : ' warn'), dataset: { area: 'checks' } },
      h('span', { class: 'pr-tile-ic' }, icon(protectedMac ? 'shield' : 'alert', 26)),
      h('div', { class: 'pr-tile-t' }, protectedMac ? (unk ? t('Nenhum problema encontrado') : t('Seu Mac está protegido')) : failed && !bad ? t('Verificação indisponível') : plural(bad, 'ponto de atenção', 'pontos de atenção')),
      h('div', { class: 'pr-tile-s' }, protectedMac
        ? (unk ? tn(unk, '{n} verificação não pôde ser concluída.', '{n} verificações não puderam ser concluídas.') : t('As proteções do macOS que conferimos estão em ordem.'))
        : failed ? t('Não foi possível ler o estado das proteções do macOS. Tente de novo.') : t('Algumas proteções do macOS estão desligadas ou desatualizadas.')),
      failed ? null : h('ul', { class: 'pr-mini' }, S.checks.map((c) => h('li', null, h('i', { class: 'dot' + dotOf(c) }), h('span', { class: 't', title: tr(c.title) }, tr(c.title))))),
      failed ? h('button', { class: 'btn sm', type: 'button', onClick: scan }, t('Analisar de novo')) : h('button', { class: 'btn sm', type: 'button', onClick: () => open('checks') }, t('Revisar')));

    let permTile;
    if (S.tccFailed) {
      permTile = h('div', { class: 'pr-tile none', dataset: { area: 'perms' } },
        h('span', { class: 'pr-tile-ic' }, icon('alert', 24)),
        h('div', { class: 'pr-tile-t' }, t('Permissões de apps')),
        h('div', { class: 'pr-tile-s' }, t('Não foi possível ler as permissões.')),
        h('button', { class: 'btn sm', type: 'button', onClick: scan }, t('Analisar de novo')));
    } else if (S.tcc.needsFda) {
      permTile = h('div', { class: 'pr-tile none', dataset: { area: 'perms' } },
        h('span', { class: 'pr-tile-ic' }, icon('lock', 24)),
        h('div', { class: 'pr-tile-t' }, t('Permissões de apps')),
        h('div', { class: 'pr-tile-s' }, t('Para listar o que cada app pode acessar, conceda o Acesso Total ao Disco ao Limpae.')),
        h('button', { class: 'btn sm', type: 'button', onClick: () => openSettings().then(ctx.refreshDisk) }, t('Abrir Ajustes')));
    } else {
      permTile = h('div', { class: 'pr-tile' + (S.tcc.apps ? '' : ' none'), dataset: { area: 'perms' } },
        h('span', { class: 'pr-tile-ic' }, pi('camera', 24)),
        h('div', { class: 'pr-tile-t' }, cams ? tn(cams, '{n} app com acesso à câmera e ao microfone', '{n} apps com acesso à câmera e ao microfone') : t('Nenhum app com acesso à câmera ou ao microfone')),
        h('div', { class: 'pr-tile-s' }, S.tcc.apps ? tn(S.tcc.apps, '{n} app tem alguma permissão liberada. Revogue o que não precisa.', '{n} apps têm alguma permissão liberada. Revogue o que não precisa.') : t('Nenhuma permissão liberada foi encontrada.')),
        S.tcc.apps ? h('button', { class: 'btn sm', type: 'button', onClick: () => open('perms') }, t('Revisar')) : null);
    }

    const privTile = S.privFailed ? h('div', { class: 'pr-tile none', dataset: { area: 'privacy' } },
      h('span', { class: 'pr-tile-ic' }, icon('alert', 24)),
      h('div', { class: 'pr-tile-t' }, t('Privacidade')),
      h('div', { class: 'pr-tile-s' }, t('Não foi possível ler os itens de privacidade.')),
      h('button', { class: 'btn sm', type: 'button', onClick: scan }, t('Analisar de novo')))
      : h('div', { class: 'pr-tile' + (items.length || running.length ? '' : ' none'), dataset: { area: 'privacy' } },
      h('span', { class: 'pr-tile-ic' }, icon('eye', 24)),
      h('div', { class: 'pr-tile-t' }, items.length ? tn(items.length, '{n} item de privacidade', '{n} itens de privacidade') : t('Nenhum item de privacidade')),
      h('div', { class: 'pr-tile-s' }, items.length
        ? t('{size} em itens recentes e dados de navegação.', { size: fmtBytes(itemBytes) }) + (running.length ? ' ' + t('Feche {names} para incluir.', { names: running.map((b) => b.name).join(', ') }) : '')
        : (running.length ? t('Feche {names} para limpar os dados de navegação.', { names: running.map((b) => b.name).join(', ') }) : (S.priv.needsFda ? t('Conceda o Acesso Total ao Disco para ver os itens recentes.') : t('Nada para limpar por aqui.')))),
      items.length || running.length ? h('div', { class: 'pr-tile-act' },
        h('button', { class: 'btn sm', type: 'button', onClick: () => open('privacy') }, t('Revisar')),
        S.psel.size ? h('button', { class: 'btn sm primary', type: 'button', onClick: removePrivacy }, t('Remover')) : null) : null);

    mount(ctx.root, h('section', { class: 'pr-results enter', dataset: { mod: 'protect' }, 'aria-label': t('Resultados da Segurança') },
      h('div', { class: 'fl-bar' }, h('button', { class: 'btn sm ghost', type: 'button', onClick: async () => { if (await confirmRestart('protect')) { S.phase = 'idle'; render(); } } }, icon('back', 15), t('Recomeçar')), h('span', { class: 'fl-where-tag' }, t('Segurança'))),
      h('h2', { class: 'fl-title' }, protectedMac && !unk && !partial ? t('Seu Mac está protegido.') : bad ? tn(bad, '{n} ponto precisa da sua atenção.', '{n} pontos precisam da sua atenção.') : failed ? t('Não foi possível verificar a segurança.') : partial ? t('Análise incompleta.') : t('Análise concluída.')),
      h('p', { class: 'sub fl-sub' }, t('Revise cada área. Nada é alterado nem removido sem a sua confirmação.')),
      h('button', { class: 'btn primary fl-all', type: 'button', onClick: () => open('checks') }, t('Revisar tudo')),
      h('div', { class: 'pr-tiles' }, mainTile, permTile, privTile)));
  }

  function open(area) { S.area = area; S.phase = 'review'; render(); }

  // ---------- Manager ----------
  // fresh: the manager is entered (with its rise); false when it is rebuilt in place (area switch, recheck, rescan).
  function renderReview(fresh = true) {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);

    const catsEl = h('nav', { class: 'fm-cats', 'aria-label': t('Categorias') });
    const headEl = h('div', { class: 'fm-pane-head' });
    const listEl = h('div', { class: 'fm-list' });
    const selEl = h('div', { class: 'rv-sel' });
    const actionBtn = h('button', { class: 'btn primary', type: 'button' });
    const bodyEl = h('div', { class: 'fm-body' });
    const areaSeg = h('div', { class: 'rv-extra' });

    function paintAreas() {
      const opts = areas();
      mount(areaSeg, segmented(opts, S.area, (v) => { S.area = v; keepFocus(ctx.root, () => renderReview(false)); }, t('Área de segurança')));
      areaSeg.querySelectorAll('button').forEach((b, i) => { b.dataset.fk = 'area:' + opts[i].value; }); // renderReview rebuilds them: focus is restored by key
    }

    function pane(title, desc, tools) {
      const kids = [h('div', { class: 'fm-pane-t' }, h('h3', null, title), h('p', null, desc))];
      if (tools) kids.push(h('div', { class: 'fm-tools' }, tools));
      mount(headEl, kids);
    }

    const back = () => { S.phase = 'results'; render(); };

    // ---- Check ----
    function viewChecks() {
      bodyEl.className = 'fm-body pr-single';
      mount(bodyEl, h('div', { class: 'fm-pane' }, headEl, listEl));
      pane(t('Verificação de segurança'), t('Estado das proteções do macOS. Somente leitura: o Limpae não altera nenhuma configuração.'));
      // The read itself failed: an empty list must not pass for an all-clear.
      const unavailable = S.checksFailed && !S.checks.length;
      if (unavailable) mount(listEl, h('div', { class: 'rv-empty' }, t('Não foi possível ler o estado das proteções do macOS. Tente de novo.')));
      else mount(listEl, S.checks.map((c) => h('div', { class: 'pr-check', dataset: { id: c.id } },
        h('span', { class: 'pr-st', dataset: { s: c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'unk' }, 'aria-label': c.ok === true ? t('Em ordem') : c.ok === false ? t('Atenção') : t('Não verificado') }, icon(c.ok === true ? 'check' : c.ok === false ? 'alert' : 'dash', 17)),
        h('div', { class: 'pr-check-t' }, h('b', null, tr(c.title)), h('span', null, trDetail(c.detail))),
        c.fix ? h('button', { class: 'btn sm', type: 'button', onClick: () => api.openSecurityFix(c.id).catch(() => {}) }, tr(c.fix.label)) : null)),
        h('p', { class: 'pr-note' }, t('Os botões abrem o painel certo dos Ajustes do Sistema. As configurações ficam sob o seu controle.')));
      const bad = attention();
      mount(selEl, unavailable ? [h('b', null, t('Verificação indisponível'))] : bad ? [h('b', null, plural(bad, 'ponto de atenção', 'pontos de atenção'))] : [t('Tudo em ordem')]);
      actionBtn.textContent = t('Verificar de novo');
      actionBtn.disabled = false;
      actionBtn.onclick = recheck;
    }

    async function recheck() {
      actionBtn.disabled = true;
      actionBtn.textContent = t('Verificando…');
      try { S.checks = await api.securityChecks(); S.checksFailed = false; } catch (e) { /* the error was already shown */ }
      if (ctx.alive && S.phase === 'review') renderReview(false);
    }

    // ---- Permissions ----
    const rowsOf = (g) => g.rows;
    const grantedOf = (g) => g.rows.filter((r) => r.granted);
    const selCount = () => S.rsel.size;

    function viewPerms() {
      bodyEl.className = 'fm-body';
      mount(bodyEl, catsEl, h('div', { class: 'fm-pane' }, headEl, listEl));
      const groups = S.tcc.groups;
      if (!groups.some((g) => g.service === S.svc)) S.svc = (groups.find((g) => grantedOf(g).length) || groups[0] || {}).service || null;
      paintPermCats();
      paintPermPane();
      paintPermFoot();
    }

    function paintPermCats() {
      mount(catsEl, S.tcc.groups.map((g) => {
        const ic = SERVICE_ICON[g.service] || 'lock';
        const n = g.rows.filter((r) => S.rsel.has(r.id)).length;
        return h('button', { class: 'fm-cat', type: 'button', dataset: { fk: 'svc:' + g.service }, 'aria-current': String(g.service === S.svc), onClick: () => { if (S.svc !== g.service) keepFocus(ctx.root, () => { S.svc = g.service; paintPermCats(); paintPermPane(); }); } },
          h('span', { class: 'fm-cat-ic' }, pi(ic, 17)),
          h('span', { class: 'fm-cat-t' }, h('b', null, tr(g.title)), h('span', null, plural(grantedOf(g).length, 'app liberado', 'apps liberados'))),
          n ? h('span', { class: 'fm-cat-n', title: plural(n, 'selecionado', 'selecionados') }, fmtNum(n)) : null);
      }));
    }

    function paintPermPane() { keepFocus(ctx.root, drawPermPane); }
    function drawPermPane() {
      if (S.tccFailed) {
        mount(headEl, h('div', { class: 'fm-pane-t' }, h('h3', null, t('Permissões de apps')), h('p', null, t('O que cada app pode acessar no seu Mac.'))));
        mount(listEl, h('div', { class: 'pr-closed' }, h('span', { class: 'pr-closed-ic' }, icon('alert', 26)), h('b', null, t('Não foi possível ler as permissões.')),
          h('button', { class: 'btn sm', type: 'button', onClick: (e) => rescanPerms(e.currentTarget) }, t('Analisar de novo'))));
        return;
      }
      if (S.tcc.needsFda || !S.tcc.groups.length) {
        mount(headEl, h('div', { class: 'fm-pane-t' }, h('h3', null, t('Permissões de apps')), h('p', null, t('O que cada app pode acessar no seu Mac.'))));
        mount(listEl, S.tcc.needsFda
          ? h('div', { class: 'pr-closed' }, h('span', { class: 'pr-closed-ic' }, icon('lock', 26)), h('b', null, t('É preciso o Acesso Total ao Disco')),
            h('p', null, t('O macOS guarda as permissões num banco protegido. Conceda o Acesso Total ao Disco ao Limpae em Ajustes do Sistema e analise de novo.')),
            h('button', { class: 'btn sm', type: 'button', onClick: () => openSettings().then(ctx.refreshDisk) }, t('Abrir Ajustes')))
          : h('div', { class: 'rv-empty' }, t('Nenhuma permissão encontrada.')));
        return;
      }
      const g = S.tcc.groups.find((x) => x.service === S.svc);
      const desc = serviceDesc(g.service);
      const granted = grantedOf(g), nPicked = granted.filter((r) => S.rsel.has(r.id)).length;
      pane(tr(g.title), desc, granted.length ? selectMenuButton({
        modes: [['all', t('Tudo')], ['none', t('Nada')]], mode: nPicked === granted.length ? 'all' : nPicked === 0 ? 'none' : 'part',
        onPick: (mode) => {
          for (const r of grantedOf(g)) mode === 'all' ? S.rsel.add(r.id) : S.rsel.delete(r.id);
          paintPermCats(); paintPermPane(); paintPermFoot();
        },
      }) : null);
      listEl.scrollTop = 0;
      mount(listEl, rowsOf(g).map((r) => permRow(r)));
    }

    function permRow(r) {
      const toggle = () => { S.rsel.has(r.id) ? S.rsel.delete(r.id) : S.rsel.add(r.id); paintPermCats(); paintPermPane(); paintPermFoot(); };
      const cb = r.granted ? checkbox(S.rsel.has(r.id) ? 'on' : 'off', toggle, t('Selecionar {name}', { name: r.name })) : null;
      if (cb) cb.dataset.fk = 'c:' + r.id;
      const sub = [r.bundleId, !r.installed ? t('app não encontrado') : null].filter(Boolean).join(' · ');
      const kids = [
        cb || h('span', { class: 'pr-nocb', 'aria-hidden': 'true' }),
        appIcon(r),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, h('span', { title: r.name }, r.name), r.limited ? h('span', { class: 'badge info' }, t('Acesso limitado')) : null, !r.granted ? h('span', { class: 'badge' }, t('Negado')) : null),
          h('div', { class: 'fm-meta' }, h('span', { class: 'mid', title: sub }, sub))),
        r.modified ? h('span', { class: 'pr-when' }, t('desde {date}', { date: fmtDate(r.modified) })) : null,
      ];
      return h('div', { class: 'pr-row' + (r.granted ? ' pick' : ' denied'), onClick: r.granted ? toggle : null }, kids);
    }

    function paintPermFoot() {
      const n = selCount();
      if (!n) mount(selEl, t('Nenhuma permissão selecionada'));
      else mount(selEl, t('Selecionadas:') + ' ', h('b', null, fmtNum(n)), h('small', null, n === 1 ? t('permissão') : t('permissões')));
      actionBtn.textContent = t('Revogar');
      actionBtn.disabled = n === 0;
      actionBtn.onclick = revoke;
    }

    // ---- Privacy ----
    function viewPrivacy() {
      bodyEl.className = 'fm-body';
      mount(bodyEl, catsEl, h('div', { class: 'fm-pane' }, headEl, listEl));
      const cats = privCats();
      if (!cats.some((c) => c.id === S.pcat)) S.pcat = 'recent';
      paintPrivCats();
      paintPrivPane();
      paintPrivFoot();
    }

    function paintPrivCats() {
      mount(catsEl, privCats().map((c) => {
        const items = catItems(c);
        const n = items.filter((i) => S.psel.has(i.id)).length;
        const bytes = items.reduce((a, i) => a + i.size, 0);
        const sub = c.running ? t('Aberto: feche para limpar') : items.length ? `${plural(items.length, 'item', 'itens')} · ${fmtBytes(bytes)}` : t('Nada encontrado');
        return h('button', { class: 'fm-cat', type: 'button', 'aria-current': String(c.id === S.pcat), dataset: { cat: c.id, fk: 'pcat:' + c.id }, onClick: () => { if (S.pcat !== c.id) keepFocus(ctx.root, () => { S.pcat = c.id; paintPrivCats(); paintPrivPane(); }); } },
          h('span', { class: 'fm-cat-ic' }, pi(c.ic, 17)),
          h('span', { class: 'fm-cat-t' }, h('b', null, c.label), h('span', { title: sub }, sub)),
          n ? h('span', { class: 'fm-cat-n', title: plural(n, 'selecionado', 'selecionados') }, fmtNum(n)) : null);
      }));
    }

    // Same labels as Junk: All, None, Smart (the backend's default selection) or Partial.
    function privMode(items) {
      const n = items.filter((i) => S.psel.has(i.id)).length;
      if (n === items.length) return 'all';
      if (n === 0) return 'none';
      return items.every((i) => S.psel.has(i.id) === !!i.selected) ? 'smart' : 'part';
    }

    function paintPrivPane() { keepFocus(ctx.root, drawPrivPane); }
    function drawPrivPane() {
      const c = privCats().find((x) => x.id === S.pcat);
      const isRecent = c.id === 'recent';
      pane(c.label, isRecent
        ? t('Listas de documentos, apps e servidores abertos recentemente. Vão para o Lixo e o macOS recria as listas conforme você usa o Mac.')
        : t('Dados de navegação que vão para o Lixo. Senhas salvas e favoritos do Chrome, Brave e Edge nunca são tocados.'),
      !c.running && catItems(c).length ? selectMenuButton({
        modes: [['smart', t('Recomendado')], ['all', t('Tudo')], ['none', t('Nada')]], mode: privMode(catItems(c)),
        onPick: (mode) => {
          for (const i of catItems(c)) (mode === 'all' || (mode === 'smart' && i.selected)) ? S.psel.add(i.id) : S.psel.delete(i.id);
          paintPrivCats(); paintPrivPane(); paintPrivFoot();
        },
      }) : null);
      listEl.scrollTop = 0;
      const items = catItems(c);
      if (c.running) {
        mount(listEl, h('div', { class: 'pr-closed' }, h('span', { class: 'pr-closed-ic' }, pi('globe', 26)), h('b', null, t('Feche o {browser} para limpar', { browser: c.label })),
          h('p', null, t('Os dados só podem ser limpos com o navegador fechado, para não corromper o que ele está usando.')),
          h('button', { class: 'btn sm', type: 'button', onClick: (e) => rescanPrivacy(e.currentTarget) }, t('Analisar de novo'))));
        return;
      }
      if (S.privFailed) {
        mount(listEl, h('div', { class: 'pr-closed' }, h('span', { class: 'pr-closed-ic' }, icon('alert', 26)), h('b', null, t('Não foi possível ler os itens de privacidade.')),
          h('button', { class: 'btn sm', type: 'button', onClick: (e) => rescanPrivacy(e.currentTarget) }, t('Analisar de novo'))));
        return;
      }
      if (!items.length) {
        mount(listEl, isRecent && S.priv.needsFda
          ? h('div', { class: 'pr-closed' }, h('span', { class: 'pr-closed-ic' }, icon('lock', 26)), h('b', null, t('É preciso o Acesso Total ao Disco')),
            h('p', null, t('O macOS protege a pasta das listas de itens recentes. Conceda o acesso ao Limpae e analise de novo.')),
            h('button', { class: 'btn sm', type: 'button', onClick: () => openSettings().then(ctx.refreshDisk) }, t('Abrir Ajustes')))
          : h('div', { class: 'rv-empty' }, t('Nada encontrado nesta categoria.')));
        return;
      }
      mount(listEl, c.groups.filter((g) => g.items.length).map((g) => privSection(g)));
    }

    function privSection(g) {
      const cb = checkbox(groupState(g.items, S.psel), (cur) => { for (const i of g.items) cur === 'on' ? S.psel.delete(i.id) : S.psel.add(i.id); paintPrivCats(); paintPrivPane(); paintPrivFoot(); }, t('Selecionar {name}', { name: tr(g.title) }));
      cb.dataset.fk = 'g:' + g.id;
      const total = g.items.reduce((a, i) => a + i.size, 0);
      return h('section', { class: 'fm-sec', dataset: { group: g.id } },
        h('div', { class: 'fm-sec-head' }, cb, h('b', { title: tr(g.title) }, tr(g.title)), h('span', null, `${plural(g.items.length, 'item', 'itens')} · ${fmtBytes(total)}`)),
        g.items.map((it) => {
          const toggle = () => { S.psel.has(it.id) ? S.psel.delete(it.id) : S.psel.add(it.id); paintPrivCats(); paintPrivPane(); paintPrivFoot(); };
          const label = g.id === 'recent' ? recentLabel(it.name) : it.name;
          const rowCb = checkbox(S.psel.has(it.id) ? 'on' : 'off', toggle, t('Selecionar {name}', { name: label }));
          rowCb.dataset.fk = 'c:' + it.id;
          const row = h('div', { class: 'fm-row', onClick: toggle },
            rowCb,
            h('div', { class: 'fm-ic' }, icon('file', 16)),
            h('div', { class: 'fm-main' },
              h('div', { class: 'fm-name' }, h('span', { title: it.name }, label), it.note ? h('span', { class: 'badge info', title: tr(it.note) }, tr(it.note)) : null),
              h('div', { class: 'fm-meta' }, mid(it.path, 26))),
            h('span', { class: 'fm-size' }, fmtBytes(it.size)),
            h('button', { class: 'icon-btn fm-act', type: 'button', title: t('Mostrar no Finder'), 'aria-label': t('Mostrar {name} no Finder', { name: label }), onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 16)));
          // Internal files (databases, lists): only Show in Finder; no Quick Look or Ignore.
          attachMenu(row, () => ({ id: it.id, name: label, quickLook: false, ignore: false, select: { on: S.psel.has(it.id), toggle } }));
          return row;
        }));
    }

    function paintPrivFoot() {
      const picked = privItems().filter((i) => S.psel.has(i.id));
      const bytes = picked.reduce((a, i) => a + i.size, 0);
      if (!picked.length) mount(selEl, t('Nenhum item selecionado'));
      else mount(selEl, t('Selecionado:') + ' ', h('b', null, fmtBytes(bytes)), h('small', null, plural(picked.length, 'item', 'itens')));
      actionBtn.textContent = t('Remover');
      actionBtn.disabled = picked.length === 0;
      actionBtn.onclick = removePrivacy;
    }

    // Retry of a failed permissions read (the manager's own button).
    async function rescanPerms(btn) {
      if (rescanning) return;
      rescanning = true;
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = t('Verificando…'); }
      try { S.tcc = await api.tccPermissions(); S.tccFailed = false; } catch (e) { /* the error was already shown */ }
      rescanning = false;
      if (ctx.alive && S.phase === 'review') renderReview(false);
    }

    let rescanning = false;
    async function rescanPrivacy(btn) {
      if (rescanning) return;
      rescanning = true;
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = t('Verificando…'); }
      try {
        const r = await api.privacyScan();
        S.priv = r; S.privFailed = false;
        selectPrivacy(); // the permissions marked for revoking stay as they were
      } catch (e) { /* the error was already shown */ }
      rescanning = false;
      if (ctx.alive && S.phase === 'review') renderReview(false);
    }

    // ---- assembly ----
    paintAreas();
    if (S.area === 'checks') viewChecks();
    else if (S.area === 'perms') viewPerms();
    else viewPrivacy();
    const subtitle = { checks: t('Verificação de segurança'), perms: t('Permissões de apps'), privacy: t('Privacidade') }[S.area];
    mount(ctx.root, h('section', { class: 'review fm pr-manager' + (fresh ? ' enter' : ''), dataset: { mod: 'protect' }, 'aria-label': t('Gerenciador de segurança') },
      managerBar({ title: t('Segurança'), subtitle, onBack: back, controls: [areaSeg] }),
      bodyEl,
      h('div', { class: 'rv-foot' }, selEl, actionBtn)));
    ctx.onBack(back);
  }

  // ---------- Actions ----------
  function busyStage(title, sub) {
    S.phase = 'removing';
    ctx.setBusy(true);
    st = null; ensureStage(); st.busy(true);
    const prog = h('p', { class: 'sub' }, sub);
    st.show(h('h1', { class: 'h1' }, title), prog);
    ctx.setDock(null); // no possible action here: no spinning ring; the privacy removal starts showing "Stop"
    return prog;
  }

  async function revoke() {
    const picked = [];
    for (const g of S.tcc.groups) for (const r of g.rows) if (S.rsel.has(r.id)) picked.push({ ...r, service: tr(g.title) });
    if (!picked.length) return;
    const names = picked.slice(0, 5).map((r) => `${r.name} (${r.service})`);
    const ok = await confirmDialog({
      title: tn(picked.length, 'Revogar {n} permissão?', 'Revogar {n} permissões?'),
      body: [t('Os apps perderão o acesso e o macOS vai perguntar de novo quando eles precisarem. Nenhum arquivo é apagado.') + ' ',
        h('strong', null, names.join('; ') + (picked.length > names.length ? '; ' + t('e mais {n}.', { n: fmtNum(picked.length - names.length) }) : '.'))],
      confirm: t('Revogar'), glyph: 'lock', mod: 'protect',
    });
    if (!ok) return;
    const prog = busyStage(t('Revogando…'), t('{done} de {total}', { done: fmtNum(0), total: fmtNum(picked.length) }));
    const byId = new Map(picked.map((r) => [r.id, { name: `${r.name} (${r.service})`, path: r.bundleId }]));
    const ids = picked.map((r) => r.id);
    let good = 0;
    const failures = [];
    try {
      const res = await api.tccRevoke(ids);
      for (const o of res.outcomes) if (o.ok) good++;
      failures.push(...outcomesToFailures(res.outcomes, byId));
    } catch (e) {
      failures.push(...ids.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: tr(e.message) })));
    }
    prog.textContent = t('{done} de {total}', { done: fmtNum(ids.length), total: fmtNum(ids.length) });
    // Ids are new on each read: fetches the list again to reflect what macOS really stores.
    try { S.tcc = await api.tccPermissions(); S.tccFailed = false; } catch (e) { /* keeps the old list */ }
    S.rsel = new Set();
    S.done = { kind: 'perms', n: good, failed: failures.length };
    S.phase = 'done';
    play(good ? 'clean' : 'error');
    ctx.setBusy(false);
    if (!ctx.alive) return;
    render();
    if (failures.length) failuresSheet(failures);
  }

  async function removePrivacy() {
    const picked = privItems().filter((i) => S.psel.has(i.id));
    if (!picked.length) return;
    const bytes = picked.reduce((a, i) => a + i.size, 0);
    const kinds = new Set();
    for (const g of S.priv.groups) for (const i of g.items) if (S.psel.has(i.id)) kinds.add(g.id.split(':')[1]);
    const has = (k) => kinds.has(k);
    const notes = [];
    if (has('cookies')) notes.push(t('Ao remover cookies, você será desconectado dos sites onde está logado.'));
    if (has('forms')) notes.push(t('Dados de preenchimento automático (como endereços e cartões salvos) também serão removidos.'));
    if (picked.some((i) => i.note && i.note.includes('favoritos'))) notes.push(t('No Firefox, este arquivo também guarda os favoritos.'));
    const ok = await confirmDialog({
      title: tn(picked.length, 'Mover {n} item para o Lixo?', 'Mover {n} itens para o Lixo?'),
      body: [t('{size} serão enviados ao Lixo.', { size: fmtBytes(bytes) }) + ' ' + t('Você pode restaurá-los de lá') + ' ', h('strong', null, t('até esvaziar a Lixeira')), '. ' + t('Senhas salvas não são tocadas.'),
        notes.length ? h('span', { class: 'fl-warn' }, ' ' + notes.join(' ')) : null],
      permanentTitle: tn(picked.length, 'Apagar {n} item definitivamente?', 'Apagar {n} itens definitivamente?'),
      confirm: t('Mover para o Lixo'), glyph: 'trash', mod: 'protect',
      permanentChoice: true, permanentDefault: !!(store.settings && store.settings.permanentDelete),
    });
    if (!ok) return;
    const permanent = ok === 'permanent';
    const prog = busyStage(permanent ? t('Apagando…') : t('Movendo para o Lixo…'), t('{done} de {total}', { done: fmtNum(0), total: fmtNum(picked.length) }));
    const sd = stopDock(ctx, 'protect');
    const byId = new Map(picked.map((i) => [i.id, i]));
    const ids = picked.map((i) => i.id);
    const okIds = new Set();
    const failures = [];
    let freed = 0, done = 0;
    for (let i = 0; i < ids.length; i += REMOVE_BATCH) {
      const chunk = ids.slice(i, i + REMOVE_BATCH);
      if (sd.stopped()) { failures.push(...chunk.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: t('cancelado; o item continua no lugar') }))); continue; }
      try {
        const res = await api.privacyRemove(chunk, permanent);
        for (const o of res.outcomes) if (o.ok) { okIds.add(o.id); freed += o.freed || 0; }
        failures.push(...outcomesToFailures(res.outcomes, byId));
      } catch (e) {
        failures.push(...chunk.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: tr(e.message) })));
      }
      done += chunk.length;
      prog.textContent = t('{done} de {total}', { done: fmtNum(done), total: fmtNum(ids.length) });
      sd.progress(done / ids.length);
    }
    S.priv = {
      ...S.priv,
      groups: S.priv.groups.map((g) => { const items = g.items.filter((i) => !okIds.has(i.id)); return { ...g, items, total: items.reduce((a, i) => a + i.size, 0) }; }),
    };
    for (const id of okIds) S.psel.delete(id);
    bump(); store.trash = null;
    S.done = { kind: 'privacy', n: okIds.size, bytes: freed, failed: failures.length, permanent, cookies: has('cookies') };
    S.phase = 'done';
    const real = realFailures(failures);
    if (okIds.size) play('clean'); else if (!sd.stopped() || real.length) play('error'); // a bare Stop is not an error
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (real.length) failuresSheet(real);
  }

  const failedNote = (n, perms) => (!n ? '' : ' ' + (perms ? tn(n, '{n} permissão não foi revogada.', '{n} permissões não foram revogadas.') : tn(n, '{n} item não foi removido.', '{n} itens não foram removidos.')));

  function renderDone() {
    const d = S.done || { kind: 'privacy', n: 0, bytes: 0, failed: 0 };
    const more = (S.priv && privItems().length) || (S.tcc && S.tcc.apps);
    const head = d.kind === 'perms'
      ? [h('div', { class: 'big' }, fmtNum(d.n)), h('div', { class: 'big-cap' }, d.n === 1 ? t('permissão revogada') : t('permissões revogadas')),
        h('p', { class: 'sub' }, [d.n ? t('Os apps vão pedir acesso de novo na próxima vez que precisarem.') : t('Nenhuma permissão foi revogada.'), failedNote(d.failed, true)])]
      : [h('div', { class: 'big' }, bytesParts(d.bytes).value, h('small', null, bytesParts(d.bytes).unit)), h('div', { class: 'big-cap' }, d.permanent ? t('apagados definitivamente') : t('movidos para o Lixo')),
        h('p', { class: 'sub' }, [
          // With nothing handled, the "empty the Trash" and "sign in again" advice would be wrong.
          d.n ? (d.permanent ? '' : t('Esvazie a Lixeira para liberar o espaço no disco.') + ' ') + (d.cookies ? t('Pode ser preciso entrar de novo em alguns sites.') : '') : t('Nada foi movido.'),
          failedNote(d.failed)])];
    st.show(...head,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), t('Ver log')),
        more ? h('button', { class: 'btn', type: 'button', onClick: () => { S.phase = 'review'; render(); } }, t('Revisar mais itens')) : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { S.phase = 'results'; render(); } }, t('Concluir'))));
    st.succeeded(d.n > 0); // celebrated only when something was actually handled
    ctx.setDock(null);
  }

  render();
}
