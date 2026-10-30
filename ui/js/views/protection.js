// Proteção: verificação de segurança (somente leitura), permissões de apps e privacidade.
// Nada é alterado em silêncio: os "consertos" só abrem o painel certo dos Ajustes; revogar e remover pedem confirmação.
// A interface só envia ids do backend, nunca caminhos, URLs nem bundle ids. Nomes vêm do disco (não confiáveis):
// só textContent / createElement.
import { play } from '../sound.js';
import { h, s, mount, mid } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store, bump } from '../store.js';
import { bytesParts, fmtBytes, fmtNum, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, checkbox, segmented, features } from '../ui.js';
import { outcomesToFailures, stopDock } from '../actions.js';

const REMOVE_BATCH = 100;

// Ícones locais (art.js pertence a outro módulo): mesmo traço dos demais.
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

const SERVICE_UI = {
  Camera: ['camera', 'Apps com permissão para usar a câmera.'],
  Microphone: ['mic', 'Apps com permissão para gravar áudio pelo microfone.'],
  ScreenCapture: ['screen', 'Apps que podem gravar o conteúdo da tela.'],
  Accessibility: ['access', 'Apps que podem controlar o Mac por meio da Acessibilidade.'],
  ListenEvent: ['keyboard', 'Apps que podem observar o teclado e o mouse (Monitoramento de entrada).'],
  SystemPolicyAllFiles: ['drive', 'Apps com Acesso Total ao Disco: leem arquivos de qualquer pasta.'],
  AddressBook: ['person', 'Apps que podem ler e alterar seus contatos.'],
  Calendar: ['calendar', 'Apps que podem ler e alterar seus calendários.'],
  Reminders: ['reminders', 'Apps que podem ler e alterar seus lembretes.'],
  Photos: ['image', 'Apps com acesso à sua biblioteca de Fotos.'],
  Location: ['pin', 'Apps com acesso à sua localização.'],
};

const AREAS = [{ value: 'checks', label: 'Verificação' }, { value: 'perms', label: 'Permissões' }, { value: 'privacy', label: 'Privacidade' }];

const dtf = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDate = (sec) => (sec ? dtf.format(new Date(sec * 1000)) : '');

const EMPTY_TCC = { needsFda: false, groups: [], cameraMicApps: 0, apps: 0 };
const EMPTY_PRIV = { groups: [], total: 0, browsers: [], needsFda: false };

// Estado que sobrevive à troca de módulo (a view é recriada a cada entrada).
const S = {
  phase: 'idle', // idle | scanning | results | review | removing | done
  checks: null, tcc: null, priv: null,
  area: 'checks', svc: null, pcat: 'recent',
  rsel: new Set(), // permissões marcadas para revogar
  psel: new Set(), // itens de privacidade marcados para remover
  done: null,
};

const attention = () => (S.checks || []).filter((c) => c.ok === false).length;
const unknown = () => (S.checks || []).filter((c) => c.ok === null).length;
const privItems = () => S.priv.groups.flatMap((g) => g.items);

function privCats() {
  const groups = S.priv.groups;
  const cats = [{ id: 'recent', label: 'Itens recentes', ic: 'clock', running: false, groups: groups.filter((g) => g.id === 'recent') }];
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

function selectInitial() {
  S.rsel = new Set();
  S.psel = new Set(privItems().filter((i) => i.selected).map((i) => i.id));
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

  function render() {
    teardown();
    if (S.phase === 'review') return renderReview();
    if (S.phase === 'results') return renderResults();
    st = null;
    ensureStage();
    if (S.phase === 'done') return renderDone();
    return renderIdle();
  }

  // ---------- Início ----------
  function renderIdle() {
    S.phase = 'idle';
    st.show(h('h1', { class: 'h1' }, 'Proteção'),
      h('p', { class: 'sub' }, 'Confira a segurança do seu Mac, o que cada app pode acessar e o que fica registrado sobre o seu uso.'),
      features('protect', [['shield', 'Verificação de segurança'], ['lock', 'Permissões de apps'], ['eye', 'Privacidade']]),
      S.checks ? h('div', { class: 'row-actions', style: 'margin-top:18px' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.phase = 'results'; render(); } }, 'Voltar aos resultados')) : null);
    ctx.setDock({ label: 'Analisar', mod: 'protect', onClick: scan });
  }

  // ---------- Análise ----------
  async function scan() {
    const steps = [
      { k: 'checks', task: null, label: 'Verificação de segurança', run: () => api.securityChecks(), sum: (r) => (r.filter((c) => c.ok === false).length ? plural(r.filter((c) => c.ok === false).length, 'ponto de atenção', 'pontos de atenção') : 'tudo certo') },
      { k: 'tcc', task: null, label: 'Permissões de apps', run: () => api.tccPermissions(), sum: (r) => (r.needsFda ? 'requer acesso' : plural(r.apps, 'app', 'apps')) },
      { k: 'priv', task: 'privacy', label: 'Privacidade', run: () => api.privacyScan(), sum: (r) => plural(r.groups.reduce((a, g) => a + g.items.length, 0), 'item', 'itens') },
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
    st.show(h('h1', { class: 'h1' }, 'Analisando…'), h('p', { class: 'sub' }, 'Somente leitura: nada é alterado nesta etapa.'), h('ul', { class: 'fl-steps' }, [...rows.values()]), ticker);
    let current = '';
    ctx.onProgress((p) => { if (current && p.task === current) ticker.textContent = p.path || ''; });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'protect', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'protect' }); api.cancel().catch(() => {}); } });
    const out = {};
    for (const step of steps) {
      if (cancelled) break;
      current = step.task || '';
      ticker.textContent = '';
      mark(step.k, 'run');
      try {
        const r = await step.run();
        if (cancelled) break;
        out[step.k] = r;
        mark(step.k, 'done', step.sum(r));
      } catch (e) {
        if (cancelled) break;
        mark(step.k, 'skip', 'não concluído');
      }
    }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (cancelled) { S.phase = S.checks ? 'results' : 'idle'; return render(); }
    S.checks = out.checks || [];
    S.tcc = out.tcc || EMPTY_TCC;
    S.priv = out.priv || EMPTY_PRIV;
    S.svc = null; S.pcat = 'recent';
    selectInitial();
    S.phase = 'results';
    play('found');
    render();
  }

  // ---------- Resultados (blocos) ----------
  function renderResults() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const bad = attention(), unk = unknown();
    const protectedMac = bad === 0;
    const items = privItems();
    const itemBytes = items.reduce((a, i) => a + i.size, 0);
    const cams = S.tcc.cameraMicApps;
    const running = S.priv.browsers.filter((b) => b.present && b.running);

    const dotOf = (c) => (c.ok === true ? '' : c.ok === false ? ' bad' : ' unk');
    const mainTile = h('div', { class: 'pr-tile main' + (protectedMac ? '' : ' warn'), dataset: { area: 'checks' } },
      h('span', { class: 'pr-tile-ic' }, icon(protectedMac ? 'shield' : 'alert', 26)),
      h('div', { class: 'pr-tile-t' }, protectedMac ? (unk ? 'Nenhum problema encontrado' : 'Seu Mac está protegido') : plural(bad, 'ponto de atenção', 'pontos de atenção')),
      h('div', { class: 'pr-tile-s' }, protectedMac
        ? (unk ? `${plural(unk, 'verificação não pôde', 'verificações não puderam')} ser concluída${unk === 1 ? '' : 's'}.` : 'As proteções do macOS que conferimos estão em ordem.')
        : 'Algumas proteções do macOS estão desligadas ou desatualizadas.'),
      h('ul', { class: 'pr-mini' }, S.checks.map((c) => h('li', null, h('i', { class: 'dot' + dotOf(c) }), h('span', { class: 't', title: c.title }, c.title)))),
      h('button', { class: 'btn sm', type: 'button', onClick: () => open('checks') }, 'Revisar'));

    let permTile;
    if (S.tcc.needsFda) {
      permTile = h('div', { class: 'pr-tile none', dataset: { area: 'perms' } },
        h('span', { class: 'pr-tile-ic' }, icon('lock', 24)),
        h('div', { class: 'pr-tile-t' }, 'Permissões de apps'),
        h('div', { class: 'pr-tile-s' }, 'Para listar o que cada app pode acessar, conceda o Acesso Total ao Disco ao Limpae.'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => api.openFda().catch(() => {}) }, 'Abrir Ajustes'));
    } else {
      permTile = h('div', { class: 'pr-tile' + (S.tcc.apps ? '' : ' none'), dataset: { area: 'perms' } },
        h('span', { class: 'pr-tile-ic' }, pi('camera', 24)),
        h('div', { class: 'pr-tile-t' }, cams ? `${plural(cams, 'app', 'apps')} com acesso à câmera e ao microfone` : 'Nenhum app com acesso à câmera ou ao microfone'),
        h('div', { class: 'pr-tile-s' }, S.tcc.apps ? `${plural(S.tcc.apps, 'app tem', 'apps têm')} alguma permissão liberada. Revogue o que não precisa.` : 'Nenhuma permissão liberada foi encontrada.'),
        S.tcc.apps ? h('button', { class: 'btn sm', type: 'button', onClick: () => open('perms') }, 'Revisar') : null);
    }

    const privTile = h('div', { class: 'pr-tile' + (items.length || running.length ? '' : ' none'), dataset: { area: 'privacy' } },
      h('span', { class: 'pr-tile-ic' }, icon('eye', 24)),
      h('div', { class: 'pr-tile-t' }, items.length ? `${plural(items.length, 'item de privacidade', 'itens de privacidade')}` : 'Nenhum item de privacidade'),
      h('div', { class: 'pr-tile-s' }, items.length
        ? `${fmtBytes(itemBytes)} em itens recentes e dados de navegação.${running.length ? ` Feche ${running.map((b) => b.name).join(', ')} para incluir.` : ''}`
        : (running.length ? `Feche ${running.map((b) => b.name).join(', ')} para limpar os dados de navegação.` : (S.priv.needsFda ? 'Conceda o Acesso Total ao Disco para ver os itens recentes.' : 'Nada para limpar por aqui.'))),
      items.length || running.length ? h('button', { class: 'btn sm', type: 'button', onClick: () => open('privacy') }, 'Revisar') : null);

    mount(ctx.root, h('section', { class: 'pr-results enter', dataset: { mod: 'protect' }, 'aria-label': 'Resultados da Proteção' },
      h('div', { class: 'fl-bar' }, h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { S.phase = 'idle'; render(); } }, icon('back', 15), 'Recomeçar'), h('span', { class: 'fl-where-tag' }, 'Proteção')),
      h('h2', { class: 'fl-title' }, protectedMac && !unk ? 'Seu Mac está protegido.' : bad ? `${plural(bad, 'ponto precisa', 'pontos precisam')} da sua atenção.` : 'Análise concluída.'),
      h('p', { class: 'sub fl-sub' }, 'Revise cada área. Nada é alterado nem removido sem a sua confirmação.'),
      h('div', { class: 'pr-tiles' }, mainTile, permTile, privTile)));
  }

  function open(area) { S.area = area; S.phase = 'review'; render(); }

  // ---------- Gerenciador ----------
  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);

    const catsEl = h('nav', { class: 'fm-cats', 'aria-label': 'Categorias' });
    const headEl = h('div', { class: 'fm-pane-head' });
    const listEl = h('div', { class: 'fm-list' });
    const selEl = h('div', { class: 'rv-sel' });
    const actionBtn = h('button', { class: 'btn primary', type: 'button' });
    const bodyEl = h('div', { class: 'fm-body' });
    const areaSeg = h('div', { class: 'rv-extra' });

    function paintAreas() {
      mount(areaSeg, segmented(AREAS, S.area, (v) => { S.area = v; renderReview(); }, 'Área de proteção'));
    }

    // Menu "Selecionar ▾" (mesmo padrão do gerenciador de arquivos).
    function menu(modes, onPick) {
      const label = h('b', null, 'escolher');
      const btn = h('button', { class: 'fm-sel', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, h('span', null, 'Selecionar:'), label, pi('down', 14));
      const pop = h('div', { class: 'fm-menu', role: 'menu', hidden: true }, modes.map(([mode, text]) => h('button', { class: 'fm-menu-i', type: 'button', role: 'menuitem', onClick: () => { close(); label.textContent = text.toLowerCase(); onPick(mode); } }, text)));
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

    function pane(title, desc, tools) {
      const kids = [h('div', { class: 'fm-pane-t' }, h('h3', null, title), h('p', null, desc))];
      if (tools) kids.push(h('div', { class: 'fm-tools' }, tools));
      mount(headEl, kids);
    }

    const back = () => { S.phase = 'results'; render(); };
    const backBtn = h('button', { class: 'btn', type: 'button', onClick: back }, 'Voltar');

    // ---- Verificação ----
    function viewChecks() {
      bodyEl.className = 'fm-body pr-single';
      mount(bodyEl, h('div', { class: 'fm-pane' }, headEl, listEl));
      pane('Verificação de segurança', 'Estado das proteções do macOS. Somente leitura: o Limpae não altera nenhuma configuração.');
      mount(listEl, S.checks.map((c) => h('div', { class: 'pr-check', dataset: { id: c.id } },
        h('span', { class: 'pr-st', dataset: { s: c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'unk' }, 'aria-label': c.ok === true ? 'Em ordem' : c.ok === false ? 'Atenção' : 'Não verificado' }, icon(c.ok === true ? 'check' : c.ok === false ? 'alert' : 'dash', 17)),
        h('div', { class: 'pr-check-t' }, h('b', null, c.title), h('span', null, c.detail)),
        c.fix ? h('button', { class: 'btn sm', type: 'button', onClick: () => api.openSecurityFix(c.id).catch(() => {}) }, c.fix.label) : null)),
        h('p', { class: 'pr-note' }, 'Os botões abrem o painel certo dos Ajustes do Sistema. As configurações ficam sob o seu controle.'));
      const bad = attention();
      mount(selEl, bad ? [h('b', null, plural(bad, 'ponto de atenção', 'pontos de atenção'))] : ['Tudo em ordem']);
      actionBtn.textContent = 'Verificar de novo';
      actionBtn.disabled = false;
      actionBtn.onclick = recheck;
    }

    async function recheck() {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Verificando…';
      try { S.checks = await api.securityChecks(); } catch (e) { /* o erro já foi mostrado */ }
      if (ctx.alive && S.phase === 'review') renderReview();
    }

    // ---- Permissões ----
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
        const [ic] = SERVICE_UI[g.service] || ['lock'];
        const n = g.rows.filter((r) => S.rsel.has(r.id)).length;
        return h('button', { class: 'fm-cat', type: 'button', 'aria-current': String(g.service === S.svc), onClick: () => { if (S.svc !== g.service) { S.svc = g.service; paintPermCats(); paintPermPane(); } } },
          h('span', { class: 'fm-cat-ic' }, pi(ic, 17)),
          h('span', { class: 'fm-cat-t' }, h('b', null, g.title), h('span', null, plural(grantedOf(g).length, 'app liberado', 'apps liberados'))),
          n ? h('span', { class: 'fm-cat-n', title: plural(n, 'selecionado', 'selecionados') }, fmtNum(n)) : null);
      }));
    }

    function paintPermPane() {
      if (S.tcc.needsFda || !S.tcc.groups.length) {
        mount(headEl, h('div', { class: 'fm-pane-t' }, h('h3', null, 'Permissões de apps'), h('p', null, 'O que cada app pode acessar no seu Mac.')));
        mount(listEl, S.tcc.needsFda
          ? h('div', { class: 'pr-closed' }, h('span', { class: 'pr-closed-ic' }, icon('lock', 26)), h('b', null, 'É preciso o Acesso Total ao Disco'),
            h('p', null, 'O macOS guarda as permissões num banco protegido. Conceda o Acesso Total ao Disco ao Limpae em Ajustes do Sistema e analise de novo.'),
            h('button', { class: 'btn sm', type: 'button', onClick: () => api.openFda().catch(() => {}) }, 'Abrir Ajustes'))
          : h('div', { class: 'rv-empty' }, 'Nenhuma permissão encontrada.'));
        return;
      }
      const g = S.tcc.groups.find((x) => x.service === S.svc);
      const [, desc] = SERVICE_UI[g.service] || ['lock', ''];
      pane(g.title, desc, grantedOf(g).length ? menu([['all', 'Todos'], ['none', 'Nada']], (mode) => {
        for (const r of grantedOf(g)) mode === 'all' ? S.rsel.add(r.id) : S.rsel.delete(r.id);
        paintPermCats(); paintPermPane(); paintPermFoot();
      }) : null);
      listEl.scrollTop = 0;
      mount(listEl, rowsOf(g).map((r) => permRow(r)));
    }

    function permRow(r) {
      const toggle = () => { S.rsel.has(r.id) ? S.rsel.delete(r.id) : S.rsel.add(r.id); paintPermCats(); paintPermPane(); paintPermFoot(); };
      const sub = [r.bundleId, !r.installed ? 'app não encontrado' : null].filter(Boolean).join(' · ');
      const kids = [
        r.granted ? checkbox(S.rsel.has(r.id) ? 'on' : 'off', toggle, `Selecionar ${r.name}`) : h('span', { class: 'pr-nocb', 'aria-hidden': 'true' }),
        appIcon(r),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, h('span', { title: r.name }, r.name), r.limited ? h('span', { class: 'badge info' }, 'Acesso limitado') : null, !r.granted ? h('span', { class: 'badge' }, 'Negado') : null),
          h('div', { class: 'fm-meta' }, h('span', { class: 'mid', title: sub }, sub))),
        r.modified ? h('span', { class: 'pr-when' }, `desde ${fmtDate(r.modified)}`) : null,
      ];
      return h('div', { class: 'pr-row' + (r.granted ? ' pick' : ' denied'), onClick: r.granted ? toggle : null }, kids);
    }

    function paintPermFoot() {
      const n = selCount();
      mount(selEl, 'Selecionadas: ', h('b', null, fmtNum(n)), h('small', null, n === 1 ? 'permissão' : 'permissões'));
      actionBtn.textContent = 'Revogar';
      actionBtn.disabled = n === 0;
      actionBtn.onclick = revoke;
    }

    // ---- Privacidade ----
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
        const sub = c.running ? 'Aberto: feche para limpar' : items.length ? `${plural(items.length, 'item', 'itens')} · ${fmtBytes(bytes)}` : 'Nada encontrado';
        return h('button', { class: 'fm-cat', type: 'button', 'aria-current': String(c.id === S.pcat), dataset: { cat: c.id }, onClick: () => { if (S.pcat !== c.id) { S.pcat = c.id; paintPrivCats(); paintPrivPane(); } } },
          h('span', { class: 'fm-cat-ic' }, pi(c.ic, 17)),
          h('span', { class: 'fm-cat-t' }, h('b', null, c.label), h('span', null, sub)),
          n ? h('span', { class: 'fm-cat-n', title: plural(n, 'selecionado', 'selecionados') }, fmtNum(n)) : null);
      }));
    }

    function paintPrivPane() {
      const c = privCats().find((x) => x.id === S.pcat);
      const isRecent = c.id === 'recent';
      pane(c.label, isRecent
        ? 'Listas de documentos, apps e servidores abertos recentemente. Vão para o Lixo e o macOS recria as listas conforme você usa o Mac.'
        : 'Dados de navegação que vão para o Lixo. Senhas salvas e favoritos do Chrome, Brave e Edge nunca são tocados.',
      !c.running && catItems(c).length ? menu([['all', 'Tudo desta lista'], ['none', 'Nada']], (mode) => {
        for (const i of catItems(c)) mode === 'all' ? S.psel.add(i.id) : S.psel.delete(i.id);
        paintPrivCats(); paintPrivPane(); paintPrivFoot();
      }) : null);
      listEl.scrollTop = 0;
      const items = catItems(c);
      if (c.running) {
        mount(listEl, h('div', { class: 'pr-closed' }, h('span', { class: 'pr-closed-ic' }, pi('globe', 26)), h('b', null, `Feche o ${c.label} para limpar`),
          h('p', null, 'Os dados só podem ser limpos com o navegador fechado, para não corromper o que ele está usando.'),
          h('button', { class: 'btn sm', type: 'button', onClick: rescanPrivacy }, 'Analisar de novo')));
        return;
      }
      if (!items.length) {
        mount(listEl, isRecent && S.priv.needsFda
          ? h('div', { class: 'pr-closed' }, h('span', { class: 'pr-closed-ic' }, icon('lock', 26)), h('b', null, 'É preciso o Acesso Total ao Disco'),
            h('p', null, 'O macOS protege a pasta das listas de itens recentes. Conceda o acesso ao Limpae e analise de novo.'),
            h('button', { class: 'btn sm', type: 'button', onClick: () => api.openFda().catch(() => {}) }, 'Abrir Ajustes'))
          : h('div', { class: 'rv-empty' }, 'Nada encontrado nesta categoria.'));
        return;
      }
      mount(listEl, c.groups.filter((g) => g.items.length).map((g) => privSection(g)));
    }

    function privSection(g) {
      const cb = checkbox(groupState(g.items, S.psel), (cur) => { for (const i of g.items) cur === 'on' ? S.psel.delete(i.id) : S.psel.add(i.id); paintPrivCats(); paintPrivPane(); paintPrivFoot(); }, `Selecionar ${g.title}`);
      const total = g.items.reduce((a, i) => a + i.size, 0);
      return h('section', { class: 'fm-sec', dataset: { group: g.id } },
        h('div', { class: 'fm-sec-head' }, cb, h('b', { title: g.title }, g.title), h('span', null, `${plural(g.items.length, 'item', 'itens')} · ${fmtBytes(total)}`)),
        g.items.map((it) => {
          const toggle = () => { S.psel.has(it.id) ? S.psel.delete(it.id) : S.psel.add(it.id); paintPrivCats(); paintPrivPane(); paintPrivFoot(); };
          return h('div', { class: 'fm-row', onClick: toggle },
            checkbox(S.psel.has(it.id) ? 'on' : 'off', toggle, `Selecionar ${it.name}`),
            h('div', { class: 'fm-ic' }, icon('file', 16)),
            h('div', { class: 'fm-main' },
              h('div', { class: 'fm-name' }, h('span', { title: it.name }, it.name), it.note ? h('span', { class: 'badge info', title: it.note }, it.note) : null),
              h('div', { class: 'fm-meta' }, mid(it.path, 26))),
            h('span', { class: 'fm-size' }, fmtBytes(it.size)),
            h('button', { class: 'icon-btn fm-act', type: 'button', title: 'Mostrar no Finder', 'aria-label': `Mostrar ${it.name} no Finder`, onClick: (e) => { e.stopPropagation(); api.reveal(it.id).catch(() => {}); } }, icon('reveal', 16)));
        }));
    }

    function paintPrivFoot() {
      const picked = privItems().filter((i) => S.psel.has(i.id));
      const bytes = picked.reduce((a, i) => a + i.size, 0);
      mount(selEl, 'Selecionado: ', h('b', null, fmtBytes(bytes)), h('small', null, plural(picked.length, 'item', 'itens')));
      actionBtn.textContent = 'Remover';
      actionBtn.disabled = picked.length === 0;
      actionBtn.onclick = removePrivacy;
    }

    async function rescanPrivacy() {
      try {
        const r = await api.privacyScan();
        S.priv = r;
        selectInitial();
      } catch (e) { /* o erro já foi mostrado */ }
      if (ctx.alive && S.phase === 'review') renderReview();
    }

    // ---- montagem ----
    paintAreas();
    if (S.area === 'checks') viewChecks();
    else if (S.area === 'perms') viewPerms();
    else viewPrivacy();
    const subtitle = { checks: 'Verificação de segurança', perms: 'Permissões de apps', privacy: 'Privacidade' }[S.area];
    mount(ctx.root, h('section', { class: 'review fm pr-manager enter', dataset: { mod: 'protect' }, 'aria-label': 'Gerenciador de proteção' },
      h('div', { class: 'rv-head' }, h('div', { class: 'rv-title' }, h('h2', null, 'Gerenciador de proteção'), h('p', null, subtitle)), areaSeg),
      bodyEl,
      h('div', { class: 'rv-foot' }, selEl, backBtn, actionBtn)));
  }

  // ---------- Ações ----------
  function busyStage(title, sub) {
    S.phase = 'removing';
    ctx.setBusy(true);
    st = null; ensureStage(); st.busy(true);
    const prog = h('p', { class: 'sub' }, sub);
    st.show(h('h1', { class: 'h1' }, title), prog);
    ctx.setDock({ label: 'Aguarde', busy: true, mod: 'protect' });
    return prog;
  }

  async function revoke() {
    const picked = [];
    for (const g of S.tcc.groups) for (const r of g.rows) if (S.rsel.has(r.id)) picked.push({ ...r, service: g.title });
    if (!picked.length) return;
    const names = picked.slice(0, 5).map((r) => `${r.name} (${r.service})`);
    const ok = await confirmDialog({
      title: `Revogar ${plural(picked.length, 'permissão', 'permissões')}?`,
      body: [`Os apps perderão o acesso e o macOS vai perguntar de novo quando eles precisarem. Nenhum arquivo é apagado. `,
        h('strong', null, names.join('; ') + (picked.length > names.length ? `; e mais ${picked.length - names.length}.` : '.'))],
      confirm: 'Revogar', glyph: 'lock', mod: 'protect',
    });
    if (!ok) return;
    const prog = busyStage('Revogando…', `0 de ${fmtNum(picked.length)}`);
    const byId = new Map(picked.map((r) => [r.id, { name: `${r.name} (${r.service})`, path: r.bundleId }]));
    const ids = picked.map((r) => r.id);
    let good = 0;
    const failures = [];
    try {
      const res = await api.tccRevoke(ids);
      for (const o of res.outcomes) if (o.ok) good++;
      failures.push(...outcomesToFailures(res.outcomes, byId));
    } catch (e) {
      failures.push(...ids.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: e.message })));
    }
    prog.textContent = `${fmtNum(ids.length)} de ${fmtNum(ids.length)}`;
    // Ids são novos a cada leitura: busca a lista de novo para refletir o que o macOS realmente guarda.
    try { S.tcc = await api.tccPermissions(); } catch (e) { /* mantém a lista antiga */ }
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
    if (has('cookies')) notes.push('Ao remover cookies, você será desconectado dos sites onde está logado.');
    if (has('forms')) notes.push('Dados de preenchimento automático (como endereços e cartões salvos) também serão removidos.');
    if (picked.some((i) => i.note && i.note.includes('favoritos'))) notes.push('No Firefox, este arquivo também guarda os favoritos.');
    const ok = await confirmDialog({
      title: `Mover ${plural(picked.length, 'item', 'itens')} para o Lixo?`,
      body: [`${fmtBytes(bytes)} serão enviados ao Lixo. Você pode restaurá-los de lá `, h('strong', null, 'até esvaziar a Lixeira'), '. Senhas salvas não são tocadas.',
        notes.length ? h('span', { class: 'fl-warn' }, ' ' + notes.join(' ')) : null],
      confirm: 'Remover', glyph: 'trash', mod: 'protect',
      permanentChoice: true, permanentDefault: !!(store.settings && store.settings.permanentDelete),
    });
    if (!ok) return;
    const permanent = ok === 'permanent';
    const prog = busyStage(permanent ? 'Apagando…' : 'Movendo para o Lixo…', `0 de ${fmtNum(picked.length)}`);
    const sd = stopDock(ctx, 'protect');
    const byId = new Map(picked.map((i) => [i.id, i]));
    const ids = picked.map((i) => i.id);
    const okIds = new Set();
    const failures = [];
    let freed = 0, done = 0;
    for (let i = 0; i < ids.length; i += REMOVE_BATCH) {
      const chunk = ids.slice(i, i + REMOVE_BATCH);
      if (sd.stopped()) { failures.push(...chunk.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: 'cancelado; o item continua no lugar' }))); continue; }
      try {
        const res = await api.privacyRemove(chunk, permanent);
        for (const o of res.outcomes) if (o.ok) { okIds.add(o.id); freed += o.freed || 0; }
        failures.push(...outcomesToFailures(res.outcomes, byId));
      } catch (e) {
        failures.push(...chunk.map((id) => ({ id, name: byId.get(id).name, path: byId.get(id).path, error: e.message })));
      }
      done += chunk.length;
      prog.textContent = `${fmtNum(done)} de ${fmtNum(ids.length)}`;
      sd.progress(done / ids.length);
    }
    S.priv = {
      ...S.priv,
      groups: S.priv.groups.map((g) => { const items = g.items.filter((i) => !okIds.has(i.id)); return { ...g, items, total: items.reduce((a, i) => a + i.size, 0) }; }),
    };
    for (const id of okIds) S.psel.delete(id);
    bump(); store.trash = null;
    S.done = { kind: 'privacy', n: okIds.size, bytes: freed, failed: failures.length };
    S.phase = 'done';
    play(okIds.size ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    render();
    if (failures.length) failuresSheet(failures);
  }

  function renderDone() {
    const d = S.done || { kind: 'privacy', n: 0, bytes: 0, failed: 0 };
    const more = (S.priv && privItems().length) || (S.tcc && S.tcc.apps);
    const head = d.kind === 'perms'
      ? [h('div', { class: 'big' }, fmtNum(d.n)), h('div', { class: 'big-cap' }, d.n === 1 ? 'permissão revogada' : 'permissões revogadas'),
        h('p', { class: 'sub' }, 'Os apps vão pedir acesso de novo na próxima vez que precisarem.')]
      : [h('div', { class: 'big' }, bytesParts(d.bytes).value, h('small', null, bytesParts(d.bytes).unit)), h('div', { class: 'big-cap' }, 'movidos para o Lixo'),
        h('p', { class: 'sub' }, 'Esvazie a Lixeira para liberar o espaço no disco. Pode ser preciso entrar de novo em alguns sites.')];
    st.show(...head,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        more ? h('button', { class: 'btn', type: 'button', onClick: () => { S.phase = 'review'; render(); } }, 'Revisar mais itens') : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { S.phase = 'results'; render(); } }, 'Concluir')));
    ctx.setDock(null);
  }

  render();
}
