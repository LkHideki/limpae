// Desempenho: agentes em segundo plano, itens de login, monitor do sistema e snapshots do Time Machine.
// A interface só envia ids; rótulos, caminhos e nomes ficam no backend. Nomes e caminhos vêm do disco
// (não confiáveis): só textContent / createElement. Tudo o que é desativado pode ser reativado; remover vai ao Lixo.
import { play } from '../sound.js';
import { h, s, mount, mid } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { fmtBytes, fmtNum, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, features, segmented, toast } from '../ui.js';

const TABS = [
  { id: 'agents', label: 'Agentes', ic: 'chip' },
  { id: 'login', label: 'Itens de login', ic: 'restart' },
  { id: 'monitor', label: 'Monitor', ic: 'pulse' },
  { id: 'snaps', label: 'Snapshots', ic: 'clock' },
];
const HIST = 60;
const SYS_STEP = 30;
const TICK_MS = 2000;
const PRESSURE = { normal: 'normal', warning: 'elevada', critical: 'crítica', unknown: 'indisponível' };
const WHY = 'Limpar o cache de DNS, reindexar o Spotlight, reparar permissões, liberar espaço purgável e liberar RAM exigem senha de administrador ou já são feitos pelo macOS sozinho. O Limpaemeo só oferece o que funciona sem root e tem efeito real.';
const SIGNATURE_PILL = { unsigned: 'Sem assinatura válida', invalid: 'Sem assinatura válida', missing: 'Programa ausente' };
const SIGNATURE_HINT = {
  unsigned: 'O programa deste agente não tem assinatura de código.',
  invalid: 'A assinatura de código do programa não passou na verificação.',
  missing: 'O programa que este agente executa não existe mais no disco.',
};

// Estado que sobrevive à troca de módulo (a view é recriada a cada entrada).
const S = { phase: 'idle', res: null, tab: 'agents', filter: 'all', sysLimit: SYS_STEP, icons: new Map(), hist: [] };

const dtf = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), min = Math.floor((sec % 3600) / 60);
  if (d) return `${plural(d, 'dia', 'dias')} e ${hr} h`;
  return hr ? `${hr} h ${min} min` : `${min} min`;
}

function relative(date) {
  const diff = (date.getTime() - Date.now()) / 1000;
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return 'agora';
}

const pill = (text, kind, title) => h('span', { class: 'pf-pill ' + kind, title }, text);
const agentName = (a) => (a.owner ? a.owner.name : a.label);
const userAgents = () => S.res.agents.filter((a) => a.scope === 'user');
const systemAgents = () => S.res.agents.filter((a) => a.scope !== 'user');
const loginCount = () => S.res.login.items.length;

// Ícones dos apps donos, em fila curta para não disputar o disco com a análise.
const iconQueue = [];
let iconBusy = 0;
function applyIcon(slot, url) {
  if (url && slot.isConnected) { slot.classList.add('img'); mount(slot, h('img', { src: url, alt: '', draggable: 'false' })); }
}
function pumpIcons() {
  while (iconBusy < 3 && iconQueue.length) {
    const { id, slot } = iconQueue.shift();
    iconBusy++;
    api.perfIcon(id).then((u) => { S.icons.set(id, u); applyIcon(slot, u); }).catch(() => S.icons.set(id, null)).finally(() => { iconBusy--; pumpIcons(); });
  }
}
function loadIcon(id, slot) {
  if (S.icons.has(id)) return applyIcon(slot, S.icons.get(id));
  iconQueue.push({ id, slot });
  pumpIcons();
}

const whyNote = (cls = '') => h('details', { class: 'pf-why ' + cls }, h('summary', null, 'Por que não está aqui?'), h('p', null, WHY));

export function enter(ctx) {
  let st = null, cancelled = false, timer = null, ticking = false, monitorUi = null;
  const stopMonitor = () => { if (timer) clearInterval(timer); timer = null; };
  ctx.onCleanup(() => { stopMonitor(); iconQueue.length = 0; monitorUi = null; });
  if (!S.res) S.phase = 'idle';
  if (S.phase === 'scanning') S.phase = 'idle';

  function render() {
    stopMonitor();
    if (S.phase === 'results' && S.res) return renderResults();
    if (S.phase === 'manager' && S.res) return renderManager();
    return renderIdle();
  }

  function ensureStage() {
    if (!st) { st = stage('perf', 'bolt', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    st.busy(false);
  }

  // ---------- Início ----------
  function renderIdle() {
    st = null;
    S.phase = 'idle';
    ensureStage();
    st.show(h('h1', { class: 'h1' }, 'Desempenho'),
      h('p', { class: 'sub' }, 'Veja o que roda sozinho no seu Mac e acompanhe a saúde do sistema.'),
      features('perf', [['chip', 'Agentes em segundo plano'], ['restart', 'Itens de login'], ['pulse', 'Monitor do sistema']]),
      S.res ? h('div', { class: 'row-actions', style: 'margin-top:18px' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.phase = 'results'; render(); } }, 'Voltar aos resultados')) : null,
      whyNote('pf-why-land'));
    ctx.setDock({ label: 'Analisar', mod: 'perf', onClick: scan });
  }

  // ---------- Análise ----------
  async function scan() {
    cancelled = false;
    S.phase = 'scanning';
    play('start');
    ctx.setBusy(true);
    ensureStage();
    st.busy(true);
    const steps = [['agents', 'Agentes em segundo plano'], ['login', 'Itens de login'], ['snaps', 'Snapshots do Time Machine']];
    const rows = new Map(steps.map(([k, label]) => [k, h('li', { class: 'pf-step', dataset: { st: 'run' } }, h('span', { class: 'pf-step-ic' }, h('i', { class: 'spin' })), h('span', { class: 'pf-step-nm' }, label), h('span', { class: 'pf-step-sum' }))]));
    const mark = (k, text, state = 'done') => {
      const li = rows.get(k);
      li.dataset.st = state;
      mount(li.firstChild, state === 'done' ? icon('check', 14) : icon('dash', 14));
      li.lastChild.textContent = text;
    };
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, 'Analisando…'), h('p', { class: 'sub' }, 'Verificando assinaturas e o estado de cada item. Isso leva alguns segundos.'), h('ul', { class: 'pf-steps' }, [...rows.values()]), ticker);
    ctx.onProgress((p) => { if (p.task === 'perf') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'perf', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'perf' }); api.cancel().catch(() => {}); } });
    let res = null;
    try { res = await api.perfScan(); } catch (e) { /* o aviso já foi exibido por api.call */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (!res || cancelled) { if (!cancelled) play('error'); S.phase = S.res ? 'results' : 'idle'; return render(); }
    S.res = res;
    S.icons = new Map();
    S.sysLimit = SYS_STEP;
    S.filter = 'all';
    const n = res.agents.length;
    mark('agents', plural(n, 'item', 'itens'));
    if (res.login.needsAutomation) mark('login', 'precisa de permissão', 'skip');
    else if (res.login.error) mark('login', 'não concluído', 'skip');
    else mark('login', plural(loginCount(), 'item', 'itens'));
    mark('snaps', res.snapshots.error ? 'não concluído' : plural(res.snapshots.items.length, 'snapshot', 'snapshots'), res.snapshots.error ? 'skip' : 'done');
    await new Promise((r) => setTimeout(r, 500));
    if (!ctx.alive) return;
    S.phase = 'results';
    play('found');
    render();
  }

  // ---------- Resultados ----------
  function renderResults() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const r = S.res;
    const all = r.agents, flagged = all.filter((a) => a.flagged).length, active = userAgents().filter((a) => a.state === 'active').length;
    const m = r.monitor.memory;
    const pressure = m ? PRESSURE[m.pressure] || PRESSURE.unknown : PRESSURE.unknown;
    const snaps = r.snapshots.items.length;
    const login = r.login;
    const tiles = [
      {
        tab: 'agents', ic: 'chip', hot: true,
        title: `${plural(all.length, 'agente', 'agentes')} em segundo plano`,
        sub: `${fmtNum(userAgents().length)} do usuário (${fmtNum(active)} ativos) e ${fmtNum(systemAgents().length)} do sistema.`,
        warn: flagged ? `${plural(flagged, 'pede', 'pedem')} atenção` : null, action: 'Revisar',
      },
      login.needsAutomation
        ? { tab: 'login', ic: 'lock', title: 'Itens de login', sub: 'O macOS precisa liberar o Limpaemeo para ler a lista de itens de login.', action: 'Ver como liberar' }
        : login.error
          ? { tab: 'login', ic: 'restart', title: 'Itens de login', sub: login.error, action: 'Ver detalhes' }
          : { tab: 'login', ic: 'restart', title: `${plural(loginCount(), 'item', 'itens')} de login`, sub: loginCount() ? 'Apps que abrem sozinhos quando você entra no Mac.' : 'Nenhum app abre sozinho quando você entra.', action: loginCount() ? 'Revisar' : null },
      {
        tab: 'monitor', ic: 'pulse',
        title: `Memória: pressão ${pressure}`,
        sub: m ? `${fmtBytes(m.used)} de ${fmtBytes(m.total)} em uso${r.monitor.swap ? ` · troca de ${fmtBytes(r.monitor.swap.used)}` : ''}.` : 'Leitura indisponível.', action: 'Abrir monitor',
      },
      {
        tab: 'snaps', ic: 'clock',
        title: snaps ? `${plural(snaps, 'snapshot', 'snapshots')} do Time Machine` : 'Sem snapshots locais',
        sub: r.snapshots.error ? r.snapshots.error : snaps ? 'Cópias temporárias do disco que o macOS guarda e apaga sozinho.' : 'Não há cópias temporárias ocupando espaço agora.', action: snaps ? 'Revisar' : null,
      },
    ];
    const el = h('section', { class: 'pf-results enter', dataset: { mod: 'perf' }, 'aria-label': 'Resultados' },
      h('div', { class: 'pf-bar' }, h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { S.phase = 'idle'; render(); } }, icon('back', 15), 'Recomeçar')),
      h('h2', { class: 'pf-title' }, 'Veja o que roda no seu Mac.'),
      h('p', { class: 'sub pf-sub' }, 'Nada é alterado sem a sua escolha. O que você desativar pode ser reativado, e o que remover vai para o Lixo.'),
      h('button', { class: 'btn primary pf-all', type: 'button', onClick: () => openManager('agents') }, 'Abrir o gerenciador'),
      h('div', { class: 'pf-tiles' }, tiles.map((t) => h('div', { class: 'pf-tile' + (t.hot ? ' hot' : ''), dataset: { tab: t.tab } },
        h('span', { class: 'pf-tile-ic' }, icon(t.ic, 26)),
        h('div', { class: 'pf-tile-t' }, t.title),
        h('div', { class: 'pf-tile-s' }, t.sub),
        t.warn ? h('span', { class: 'pf-pill warn pf-tile-warn' }, icon('alert', 12), t.warn) : null,
        t.action ? h('button', { class: 'btn sm', type: 'button', onClick: () => openManager(t.tab) }, t.action) : null))),
      whyNote('pf-why-res'));
    mount(ctx.root, el);
  }

  function openManager(tab) { S.tab = tab; S.phase = 'manager'; render(); }

  async function refreshAll(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }
    let res = null;
    try { res = await api.perfScan(); } catch (e) { /* aviso já exibido */ }
    if (!ctx.alive) return;
    if (res) { S.res = res; S.icons = new Map(); S.sysLimit = SYS_STEP; }
    render();
  }

  // ---------- Gerenciador ----------
  function renderManager() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const navEl = h('nav', { class: 'fm-cats pf-cats', 'aria-label': 'Seções' });
    const headEl = h('div', { class: 'fm-pane-head' });
    const bodyEl = h('div', { class: 'fm-list pf-body' });
    const footEl = h('div', { class: 'rv-sel' });

    const summary = (id) => {
      const r = S.res;
      if (id === 'agents') { const u = userAgents(); return `${plural(r.agents.length, 'item', 'itens')} · ${fmtNum(u.filter((a) => a.state === 'active').length)} ativos`; }
      if (id === 'login') return r.login.needsAutomation ? 'Precisa de permissão' : r.login.error ? 'Não concluído' : plural(loginCount(), 'item', 'itens');
      if (id === 'monitor') return 'Ao vivo, a cada 2 s';
      return r.snapshots.error ? 'Não concluído' : plural(r.snapshots.items.length, 'snapshot', 'snapshots');
    };
    function renderNav() {
      mount(navEl, TABS.map((t) => h('button', { class: 'fm-cat', type: 'button', 'aria-current': String(t.id === S.tab), onClick: () => { if (S.tab !== t.id) { S.tab = t.id; showTab(); } } },
        h('span', { class: 'fm-cat-ic' }, icon(t.ic, 17)),
        h('span', { class: 'fm-cat-t' }, h('b', null, t.label), h('span', null, summary(t.id))))), whyNote('pf-why-nav'));
    }
    function renderFoot() {
      const flagged = S.res.agents.filter((a) => a.flagged).length;
      mount(footEl, flagged ? h('span', { class: 'pf-foot-warn' }, icon('alert', 14), `${plural(flagged, 'agente pede', 'agentes pedem')} atenção`) : 'Tudo o que você desativar pode ser reativado.');
    }
    function showTab() {
      stopMonitor();
      monitorUi = null;
      iconQueue.length = 0;
      renderNav();
      renderFoot();
      ({ agents: paneAgents, login: paneLogin, monitor: paneMonitor, snaps: paneSnaps })[S.tab]();
      bodyEl.scrollTop = 0;
    }

    // --- Agentes ---
    function paneAgents() {
      mount(headEl,
        h('div', { class: 'fm-pane-t' }, h('h3', null, 'Agentes em segundo plano'), h('p', null, 'Programas que o macOS inicia sozinho em seu nome. Desative o que você não usa; dá para reativar quando quiser.')),
        h('div', { class: 'fm-tools' }, segmented([{ value: 'all', label: 'Todos' }, { value: 'flag', label: 'Pedem atenção' }], S.filter, (v) => { S.filter = v; S.sysLimit = SYS_STEP; listAgents(); }, 'Filtro de agentes')));
      listAgents();
    }
    function listAgents() {
      const keep = (a) => S.filter === 'all' || a.flagged;
      const mine = userAgents().filter(keep), sys = systemAgents().filter(keep);
      const shown = sys.slice(0, S.sysLimit);
      const kids = [];
      if (mine.length) kids.push(h('section', { class: 'fm-sec' }, h('div', { class: 'fm-sec-head' }, h('b', null, 'Seus agentes'), h('span', null, plural(mine.length, 'item', 'itens'))), mine.map(agentRow)));
      if (sys.length) {
        kids.push(h('section', { class: 'fm-sec' },
          h('div', { class: 'fm-sec-head' }, h('b', null, 'Do sistema · requer administrador'), h('span', null, `${plural(sys.length, 'item', 'itens')} · somente leitura`)),
          shown.map(agentRow),
          sys.length > shown.length ? h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.sysLimit += SYS_STEP * 2; listAgents(); } }, `Mostrar mais (${plural(sys.length - shown.length, 'item', 'itens')})`)) : null));
      }
      if (!kids.length) kids.push(h('div', { class: 'rv-empty' }, S.filter === 'flag' ? 'Nenhum agente pede atenção.' : 'Nenhum agente encontrado.'));
      mount(bodyEl, kids);
    }
    function agentRow(a) {
      const slot = h('div', { class: 'pf-ic' }, icon('chip', 17));
      if (a.owner) loadIcon(a.id, slot);
      const user = a.scope === 'user';
      const pills = [];
      if (a.state === 'active') pills.push(pill('Ativo', 'ok'));
      else if (a.state === 'inactive') pills.push(pill('Inativo', 'idle', 'Habilitado, mas não carregado agora.'));
      else if (a.state === 'disabled') pills.push(pill('Desativado', 'off'));
      if (SIGNATURE_PILL[a.signature]) pills.push(pill(SIGNATURE_PILL[a.signature], 'warn', SIGNATURE_HINT[a.signature]));
      if (user && !a.manageable && a.note) pills.push(pill(a.note, 'idle'));
      const facts = [a.runAtLoad ? 'Abre no login' : null, a.keepAlive ? 'Reinicia sozinho' : null,
        a.signature === 'valid' ? (a.signer ? `Assinado por ${a.signer.replace(/^Developer ID Application: /, '')}` : 'Assinatura válida') : a.signature === 'adHoc' ? 'Assinatura ad hoc' : a.signature === 'unknown' ? 'Assinatura não verificada' : null].filter(Boolean);
      const actions = user && a.manageable
        ? [h('button', { class: 'pf-switch', type: 'button', role: 'switch', 'aria-checked': String(a.state !== 'disabled'), 'aria-label': `${a.state === 'disabled' ? 'Ativar' : 'Desativar'} ${agentName(a)}`, title: a.state === 'disabled' ? 'Ativar' : 'Desativar', onClick: (e) => toggle(a, e.currentTarget.closest('.pf-row')) }, h('i')),
          h('button', { class: 'btn sm pf-rm', type: 'button', 'aria-label': `Remover ${agentName(a)}`, onClick: () => removeAgent(a) }, icon('trash', 14), 'Remover')]
        : [h('span', { class: 'pf-lock', title: user ? a.note : 'Do sistema · requer administrador' }, icon('lock', 15))];
      return h('div', { class: 'pf-row', dataset: { state: a.state || 'system' } }, slot,
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, h('span', { title: agentName(a) }, agentName(a)), pills),
          h('div', { class: 'fm-meta pf-meta' }, h('span', { class: 'pf-label', title: a.label }, a.label), a.program ? mid(a.program, 26) : h('span', null, 'Sem programa')),
          facts.length ? h('div', { class: 'pf-facts' }, facts.join(' · ')) : null),
        h('div', { class: 'pf-actions' }, actions));
    }
    async function toggle(a, row) {
      const enable = a.state === 'disabled';
      const sw = row.querySelector('.pf-switch');
      sw.disabled = true;
      sw.classList.add('busy');
      try {
        const r = await api.agentToggle(a.id, enable);
        a.state = r.state;
        play('start');
        if (ctx.alive) toast(enable ? `${agentName(a)} ativado.` : `${agentName(a)} desativado. Dá para reativar quando quiser.`, 'ok');
      } catch (e) { play('error'); }
      if (!ctx.alive || S.tab !== 'agents') return;
      row.replaceWith(agentRow(a));
      renderNav();
    }
    async function removeAgent(a) {
      const ok = await confirmDialog({
        title: `Remover ${agentName(a)}?`, glyph: 'trash', danger: true, mod: 'perf', confirm: 'Remover',
        body: h('span', null, 'O agente será parado agora e o arquivo de configuração (', h('b', null, a.file), ') irá para o Lixo, de onde dá para restaurar. O app dono não é removido.'),
      });
      if (!ok || !ctx.alive) return;
      ctx.setBusy(true);
      let res = null;
      try { res = await api.agentRemove([a.id]); } catch (e) { play('error'); }
      ctx.setBusy(false);
      if (!res || !ctx.alive) return;
      const done = res.outcomes.filter((o) => o.ok).map((o) => o.id);
      const bad = res.outcomes.filter((o) => !o.ok);
      if (done.length) { S.res.agents = S.res.agents.filter((x) => !done.includes(x.id)); play('clean'); }
      if (S.tab === 'agents') { showTab(); } else { renderNav(); }
      if (bad.length) { play('error'); await failuresSheet(bad.map((o) => ({ id: o.id, name: agentName(a), path: '', error: o.error }))); }
    }

    // --- Itens de login ---
    function paneLogin() {
      const L = S.res.login;
      mount(headEl, h('div', { class: 'fm-pane-t' }, h('h3', null, 'Itens de login'), h('p', null, 'Apps que abrem sozinhos quando você entra no Mac. Remover um item só tira o app da lista; o app continua instalado.')));
      if (L.needsAutomation) {
        return mount(bodyEl, h('div', { class: 'pf-card pf-need' },
          h('span', { class: 'pf-card-ic' }, icon('lock', 22)),
          h('div', null, h('b', null, 'O macOS precisa liberar o acesso'),
            h('p', null, 'Para listar os itens de login, o Limpaemeo conversa com o System Events. Abra Ajustes do Sistema › Privacidade e Segurança › Automação, ative o System Events para o Limpaemeo e tente de novo.'),
            h('div', { class: 'row-actions', style: 'margin-top:14px' }, h('button', { class: 'btn primary', type: 'button', onClick: (e) => refreshAll(e.currentTarget) }, 'Tentar de novo')))));
      }
      if (L.error) {
        return mount(bodyEl, h('div', { class: 'pf-card pf-need' }, h('span', { class: 'pf-card-ic' }, icon('alert', 22)),
          h('div', null, h('b', null, L.error), h('div', { class: 'row-actions', style: 'margin-top:14px' }, h('button', { class: 'btn', type: 'button', onClick: (e) => refreshAll(e.currentTarget) }, 'Tentar de novo')))));
      }
      if (!L.items.length) return mount(bodyEl, h('div', { class: 'rv-empty' }, 'Nenhum app abre sozinho quando você entra no Mac.'));
      mount(bodyEl, h('section', { class: 'fm-sec' }, h('div', { class: 'fm-sec-head' }, h('b', null, 'Abrem ao entrar'), h('span', null, plural(L.items.length, 'item', 'itens'))), L.items.map(loginRow)));
    }
    function loginRow(it) {
      const slot = h('div', { class: 'pf-ic' }, icon('restart', 17));
      if (it.path && it.path.endsWith('.app')) loadIcon(it.id, slot);
      return h('div', { class: 'pf-row' }, slot,
        h('div', { class: 'fm-main' }, h('div', { class: 'fm-name' }, h('span', { title: it.name }, it.name)), h('div', { class: 'fm-meta pf-meta' }, it.path ? mid(it.path, 26) : h('span', null, 'Sem caminho'))),
        h('div', { class: 'pf-actions' }, h('button', { class: 'btn sm pf-rm', type: 'button', 'aria-label': `Remover ${it.name} dos itens de login`, onClick: () => removeLogin(it) }, icon('trash', 14), 'Remover')));
    }
    async function removeLogin(it) {
      const ok = await confirmDialog({
        title: `Remover ${it.name} dos itens de login?`, glyph: 'restart', danger: true, mod: 'perf', confirm: 'Remover',
        body: h('span', null, 'O app deixa de abrir sozinho quando você entra no Mac. Ele continua instalado, e dá para adicioná-lo de novo em Ajustes do Sistema › Geral › Itens de Início.'),
      });
      if (!ok || !ctx.alive) return;
      ctx.setBusy(true);
      let res = null;
      try { res = await api.loginItemRemove([it.id]); } catch (e) { play('error'); }
      ctx.setBusy(false);
      if (!res || !ctx.alive) return;
      const done = res.outcomes.filter((o) => o.ok).map((o) => o.id);
      const bad = res.outcomes.filter((o) => !o.ok);
      if (done.length) { S.res.login.items = S.res.login.items.filter((x) => !done.includes(x.id)); play('clean'); }
      if (S.tab === 'login') showTab(); else renderNav();
      if (bad.length) { play('error'); await failuresSheet(bad.map((o) => ({ id: o.id, name: it.name, path: it.path || '', error: o.error }))); }
    }

    // --- Monitor ---
    function paneMonitor() {
      mount(headEl, h('div', { class: 'fm-pane-t' }, h('h3', null, 'Monitor do sistema'), h('p', null, 'Leitura em tempo real, atualizada a cada 2 segundos enquanto esta tela está aberta. Só leitura: nada aqui altera o Mac.')));
      monitorUi = buildMonitor();
      mount(bodyEl, monitorUi.el);
      monitorUi.update(S.res.monitor);
      const tick = async () => {
        if (ticking || document.hidden || !ctx.alive || S.tab !== 'monitor') return;
        ticking = true;
        try {
          const m = await api.perfMonitor();
          if (ctx.alive && S.tab === 'monitor' && monitorUi) monitorUi.update(m);
        } catch (e) { /* próxima leitura tenta de novo */ } finally { ticking = false; }
      };
      tick();
      timer = setInterval(tick, TICK_MS);
    }

    // --- Snapshots ---
    function paneSnaps() {
      const Sn = S.res.snapshots;
      const n = Sn.items.length;
      mount(headEl,
        h('div', { class: 'fm-pane-t' }, h('h3', null, 'Snapshots locais do Time Machine'), h('p', null, 'Cópias temporárias do disco que o macOS guarda para o Time Machine e apaga sozinho quando precisa de espaço.')),
        h('div', { class: 'fm-tools' }, Sn.canThin ? h('button', { class: 'btn sm', type: 'button', disabled: n === 0, onClick: thin }, 'Afinar snapshots') : null));
      if (Sn.error) return mount(bodyEl, h('div', { class: 'pf-card pf-need' }, h('span', { class: 'pf-card-ic' }, icon('alert', 22)), h('div', null, h('b', null, Sn.error))));
      if (!n) return mount(bodyEl, h('div', { class: 'rv-empty' }, 'Nenhum snapshot local agora. Não há nada para afinar.'));
      mount(bodyEl, h('section', { class: 'fm-sec' }, h('div', { class: 'fm-sec-head' }, h('b', null, 'Neste Mac'), h('span', null, plural(n, 'snapshot', 'snapshots'))),
        Sn.items.map((x) => {
          const d = x.date ? new Date(x.date) : null;
          return h('div', { class: 'pf-row' }, h('div', { class: 'pf-ic' }, icon('clock', 17)),
            h('div', { class: 'fm-main' }, h('div', { class: 'fm-name' }, h('span', null, d ? dtf.format(d) : x.name)), h('div', { class: 'fm-meta pf-meta' }, h('span', { class: 'pf-label wide', title: x.name }, x.name))),
            h('span', { class: 'pf-when' }, d ? relative(d) : ''));
        })));
    }
    async function thin() {
      const n = S.res.snapshots.items.length;
      const ok = await confirmDialog({
        title: 'Afinar os snapshots locais?', glyph: 'clock', danger: true, mod: 'perf', confirm: 'Afinar',
        body: h('span', null, `Os ${plural(n, 'snapshot', 'snapshots')} locais serão apagados. Não dá para desfazer, mas o Time Machine cria novos sozinho e seus arquivos não são afetados.`),
      });
      if (!ok || !ctx.alive) return;
      ctx.setBusy(true);
      let res = null;
      try { res = await api.tmThin(); } catch (e) { play('error'); }
      ctx.setBusy(false);
      if (!res || !ctx.alive) return;
      S.res.snapshots.items = res.snapshots;
      play('clean');
      toast(res.removed ? `${plural(res.removed, 'snapshot removido', 'snapshots removidos')}.` : 'Nenhum snapshot foi removido.', 'ok');
      if (S.tab === 'snaps') showTab(); else renderNav();
    }

    const el = h('section', { class: 'review fm pf enter', dataset: { mod: 'perf' }, 'aria-label': 'Gerenciador de desempenho' },
      h('div', { class: 'rv-head' }, h('div', { class: 'rv-title' }, h('h2', null, 'Gerenciador de desempenho'), h('p', null, 'Revise o que roda sozinho e acompanhe o uso do Mac.'))),
      h('div', { class: 'fm-body' }, navEl, h('div', { class: 'fm-pane' }, headEl, bodyEl)),
      h('div', { class: 'rv-foot' }, footEl, h('button', { class: 'btn', type: 'button', onClick: () => { S.phase = 'results'; render(); } }, 'Voltar')));
    mount(ctx.root, el);
    showTab();
  }

  render();
}

// Painel do monitor: monta uma vez e só atualiza textos e atributos a cada leitura (sem recriar o DOM).
function buildMonitor() {
  const R = 52, C = 2 * Math.PI * R;
  const arc = (k) => s('circle', { class: 'pf-arc ' + k, cx: 70, cy: 70, r: R, fill: 'none', 'stroke-width': 14, transform: 'rotate(-90 70 70)', 'stroke-dasharray': `0 ${C}`, 'stroke-dashoffset': 0 });
  const arcs = { app: arc('app'), wired: arc('wired'), compressed: arc('compressed') };
  const ring = s('svg', { class: 'pf-ring', viewBox: '0 0 140 140', role: 'img', 'aria-label': 'Uso de memória' }, s('circle', { class: 'pf-track', cx: 70, cy: 70, r: R, fill: 'none', 'stroke-width': 14 }), arcs.app, arcs.wired, arcs.compressed);
  const T = () => h('b', null, '—');
  const memUsed = h('div', { class: 'pf-big' }, '—'), memOf = h('div', { class: 'pf-of' }, ' ');
  const pressure = h('span', { class: 'pf-pill idle' }, '—');
  const legend = { app: T(), wired: T(), compressed: T() };
  const swapV = h('div', { class: 'pf-val' }, '—'), swapBar = h('i'), swapS = h('div', { class: 'pf-cap' }, ' ');
  const cpuV = h('div', { class: 'pf-val' }, '—'), cpuS = h('div', { class: 'pf-cap' }, ' ');
  const spark = s('svg', { class: 'pf-spark', viewBox: '0 0 240 64', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const sparkArea = s('path', { class: 'area', d: '' }), sparkLine = s('path', { class: 'line', d: '' });
  spark.append(sparkArea, sparkLine);
  const batV = h('div', { class: 'pf-val' }, '—'), batBar = h('i'), batS = h('div', { class: 'pf-cap' }, ' ');
  const upV = h('div', { class: 'pf-val' }, '—');
  const topEl = h('ul', { class: 'pf-top' });

  const gauge = (title, ...kids) => h('div', { class: 'pf-card pf-gauge' }, h('div', { class: 'pf-gt' }, title), ...kids);
  const el = h('div', { class: 'pf-mon' },
    h('div', { class: 'pf-card pf-mem' },
      h('div', { class: 'pf-gt' }, 'Memória', pressure),
      h('div', { class: 'pf-mem-in' },
        h('div', { class: 'pf-ring-wrap' }, ring, h('div', { class: 'pf-ring-c' }, memUsed, memOf)),
        h('ul', { class: 'pf-legend' },
          h('li', null, h('i', { class: 'app' }), h('span', null, 'App'), legend.app),
          h('li', null, h('i', { class: 'wired' }), h('span', null, 'Dedicada'), legend.wired),
          h('li', null, h('i', { class: 'compressed' }), h('span', null, 'Comprimida'), legend.compressed)))),
    gauge('Memória de troca', swapV, h('div', { class: 'pf-bar-t' }, swapBar), swapS),
    gauge('Processador', cpuV, spark, cpuS),
    h('div', { class: 'pf-card pf-gauge pf-bat' }, h('div', { class: 'pf-gt' }, 'Bateria'), batV, h('div', { class: 'pf-bar-t' }, batBar), batS),
    gauge('Tempo ligado', upV, h('div', { class: 'pf-cap' }, 'desde a última reinicialização')),
    h('div', { class: 'pf-card pf-topc' }, h('div', { class: 'pf-gt' }, 'Maiores consumidores de memória'), topEl));

  function update(m) {
    const mem = m.memory;
    if (mem) {
      let off = 0;
      for (const k of ['app', 'wired', 'compressed']) {
        const len = mem.total ? (C * mem[k]) / mem.total : 0;
        arcs[k].setAttribute('stroke-dasharray', `${Math.max(0, len - 1.5)} ${C}`);
        arcs[k].setAttribute('stroke-dashoffset', String(-off));
        off += len;
        legend[k].textContent = fmtBytes(mem[k]);
      }
      memUsed.textContent = fmtBytes(mem.used);
      memOf.textContent = `de ${fmtBytes(mem.total)}`;
      pressure.textContent = `Pressão ${PRESSURE[mem.pressure] || PRESSURE.unknown}`;
      pressure.className = 'pf-pill ' + (mem.pressure === 'normal' ? 'ok' : mem.pressure === 'critical' ? 'bad' : mem.pressure === 'warning' ? 'warn' : 'idle');
      ring.setAttribute('aria-label', `Memória em uso: ${fmtBytes(mem.used)} de ${fmtBytes(mem.total)}`);
    }
    if (m.swap) {
      swapV.textContent = fmtBytes(m.swap.used);
      swapBar.style.width = (m.swap.total ? Math.min(100, (m.swap.used / m.swap.total) * 100) : 0) + '%';
      swapS.textContent = m.swap.total ? `de ${fmtBytes(m.swap.total)} reservados` : 'sem arquivo de troca';
    }
    const c = m.cpu;
    const usage = c.usage != null ? c.usage : Math.min(100, (c.load1 / Math.max(1, c.cores)) * 100);
    if (c.usage != null || !S.hist.length) S.hist.push(usage);
    if (S.hist.length > HIST) S.hist.shift();
    cpuV.textContent = `${fmtNum(Math.round(usage))}%`;
    cpuS.textContent = `Carga média ${nf1.format(c.load1)} · ${nf1.format(c.load5)} · ${nf1.format(c.load15)} (${plural(c.cores, 'núcleo', 'núcleos')})`;
    const step = 240 / (HIST - 1);
    const pts = S.hist.map((v, i) => [240 - (S.hist.length - 1 - i) * step, 60 - (Math.min(100, v) / 100) * 56]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    sparkLine.setAttribute('d', line);
    sparkArea.setAttribute('d', pts.length ? `${line} L${pts[pts.length - 1][0].toFixed(1)} 64 L${pts[0][0].toFixed(1)} 64 Z` : '');
    const b = m.battery;
    if (b) {
      batV.textContent = `${b.percent}%`;
      batBar.style.width = b.percent + '%';
      batBar.className = b.percent <= 20 && b.state === 'discharging' ? 'low' : '';
      const state = { charging: 'Carregando', discharging: 'Usando a bateria', charged: 'Carregada', idle: 'Na tomada' }[b.state] || '';
      const rest = b.remainingMin ? ` · ${Math.floor(b.remainingMin / 60)} h ${String(b.remainingMin % 60).padStart(2, '0')} min` : '';
      const wear = [b.cycles != null ? plural(b.cycles, 'ciclo', 'ciclos') : null, b.healthPct != null ? `capacidade ${b.healthPct}%` : null].filter(Boolean).join(' · ');
      batS.textContent = state + (b.state === 'discharging' || b.state === 'charging' ? rest : '') + (wear ? ` · ${wear}` : '');
    } else {
      batV.textContent = '—';
      batBar.style.width = '0%';
      batS.textContent = 'Este Mac não tem bateria ou ela não foi lida ainda.';
    }
    upV.textContent = fmtUptime(m.uptimeSecs);
    mount(topEl, m.top.length ? m.top.map((p) => h('li', null, h('span', { class: 'pf-top-n', title: p.name }, p.name, p.count > 1 ? h('small', null, ` ${p.count} processos`) : null), h('span', { class: 'pf-top-v' }, fmtBytes(p.rss)))) : h('li', { class: 'pf-top-empty' }, 'Coletando…'));
  }
  return { el, update };
}
