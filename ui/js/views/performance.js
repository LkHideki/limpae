// Speed: background agents, login items, system monitor and Time Machine snapshots.
// The UI only sends ids; labels, paths and names stay in the backend. Names and paths come from disk
// (untrusted): only textContent / createElement. Everything that is disabled can be re-enabled; removing goes to Trash.
import { play } from '../sound.js';
import { h, s, mount, mid, keepFocus, keepPhaseFocus } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { fmtBytes, fmtNum } from '../format.js';
import { t, tn, tr, lazyIntl } from '../i18n.js';
import { confirmDialog, confirmRestart, failuresSheet, stage, features, segmented, toast, checkbox, managerBar } from '../ui.js';
import { attachMenu } from '../menus.js';

const tabs = () => [
  { id: 'agents', label: t('Agentes'), ic: 'chip' },
  { id: 'login', label: t('Itens de login'), ic: 'restart' },
  { id: 'monitor', label: t('Monitor'), ic: 'pulse' },
  { id: 'snaps', label: t('Snapshots'), ic: 'clock' },
];
const HIST = 60;
const SYS_STEP = 30;
const TICK_MS = 2000;
// The decision rests on stable ids (normal/warning/…); the text is translated only at display time.
const pressureLabel = (k) => ({ normal: t('normal'), warning: t('elevada'), critical: t('crítica') })[k] || t('indisponível');
const signaturePill = (k) => ({ unsigned: t('Sem assinatura válida'), invalid: t('Sem assinatura válida'), missing: t('Programa ausente') })[k];
const signatureHint = (k) => ({
  unsigned: t('O programa deste agente não tem assinatura de código.'),
  invalid: t('A assinatura de código do programa não passou na verificação.'),
  missing: t('O programa que este agente executa não existe mais no disco.'),
})[k];

// State that survives module switch (the view is recreated on every entry).
const S = { phase: 'idle', res: null, tab: 'agents', filter: 'all', sysLimit: SYS_STEP, icons: new Map(), hist: [], sel: new Set(), lsel: new Set(), note: null };

const dtf = lazyIntl('DateTimeFormat', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const rtf = lazyIntl('RelativeTimeFormat', { numeric: 'auto' });
const nf1 = lazyIntl('NumberFormat', { maximumFractionDigits: 1 });

function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), min = Math.floor((sec % 3600) / 60);
  if (d) return tn(d, '{n} dia e {h} h', '{n} dias e {h} h', { h: hr });
  return hr ? t('{h} h {m} min', { h: hr, m: min }) : t('{m} min', { m: min });
}

function relative(date) {
  const diff = (date.getTime() - Date.now()) / 1000;
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return t('agora');
}

const pill = (text, kind, title) => h('span', { class: 'pf-pill ' + kind, title }, text);
const agentName = (a) => (a.owner ? a.owner.name : a.label);
const userAgents = () => S.res.agents.filter((a) => a.scope === 'user');
const systemAgents = () => S.res.agents.filter((a) => a.scope !== 'user');
const loginCount = () => S.res.login.items.length;

// Icons of the owner apps, in a short queue so they do not compete with the scan for the disk.
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

const whyNote = (cls = '') => h('details', { class: 'pf-why ' + cls }, h('summary', null, t('Por que não está aqui?')), h('p', null, t('Limpar o cache de DNS, reindexar o Spotlight, reparar permissões, liberar espaço purgável e liberar RAM exigem senha de administrador ou já são feitos pelo macOS sozinho. O Limpae só oferece o que funciona sem root e tem efeito real.')));

export function enter(ctx) {
  let st = null, cancelled = false, timer = null, ticking = false, monitorUi = null;
  const stopMonitor = () => { if (timer) clearInterval(timer); timer = null; };
  ctx.onCleanup(() => { stopMonitor(); iconQueue.length = 0; monitorUi = null; });
  if (!S.res) S.phase = 'idle';
  if (S.phase === 'scanning') S.phase = 'idle';

  // fresh: false when the manager is rebuilt in place ("Try again"), so it does not replay its rise.
  function render(fresh = true) { return keepPhaseFocus(ctx.root, () => paintScreen(fresh)); }

  function paintScreen(fresh) {
    stopMonitor();
    ctx.onBack(null);
    if (S.phase === 'results' && S.res) return renderResults();
    if (S.phase === 'manager' && S.res) return renderManager(fresh);
    return renderIdle();
  }

  function ensureStage() {
    if (!st) { st = stage('perf', 'bolt', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    st.busy(false);
  }

  // ---------- Start ----------
  function renderIdle() {
    st = null;
    S.phase = 'idle';
    ensureStage();
    st.show(h('h1', { class: 'h1' }, t('Velocidade')),
      h('p', { class: 'sub' }, t('Veja o que roda sozinho no seu Mac e acompanhe a saúde do sistema.')),
      features('perf', [['chip', t('Agentes em segundo plano')], ['restart', t('Itens de login')], ['pulse', t('Monitor do sistema')]]),
      S.res ? h('div', { class: 'row-actions', style: 'margin-top:18px' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { S.phase = 'results'; render(); } }, t('Voltar aos resultados'))) : null,
      whyNote('pf-why-land'));
    ctx.setDock({ label: t('Analisar'), mod: 'perf', onClick: scan });
  }

  // ---------- Scan ----------
  async function scan() {
    cancelled = false;
    S.phase = 'scanning';
    play('start');
    ctx.setBusy(true);
    ensureStage();
    st.busy(true);
    const steps = [['agents', t('Agentes em segundo plano')], ['login', t('Itens de login')], ['snaps', t('Snapshots do Time Machine')]];
    const rows = new Map(steps.map(([k, label]) => [k, h('li', { class: 'pf-step', dataset: { st: 'run' } }, h('span', { class: 'pf-step-ic' }, h('i', { class: 'spin' })), h('span', { class: 'pf-step-nm' }, label), h('span', { class: 'pf-step-sum' }))]));
    const mark = (k, text, state = 'done') => {
      const li = rows.get(k);
      li.dataset.st = state;
      mount(li.firstChild, state === 'done' ? icon('check', 14) : icon('dash', 14));
      li.lastChild.textContent = text;
    };
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, t('Analisando…')), h('p', { class: 'sub' }, t('Verificando assinaturas e o estado de cada item. Isso leva alguns segundos.')), h('ul', { class: 'pf-steps' }, [...rows.values()]), ticker);
    ctx.onProgress((p) => { if (p.task === 'perf') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: t('Parar'), busy: true, mod: 'perf', onClick: () => { cancelled = true; ctx.setDock({ label: t('Parando'), busy: true, disabled: true, mod: 'perf' }); api.cancel().catch(() => {}); } });
    let res = null;
    // The toast's 'err' is gated on focus; 'error' also reaches a background window (the two duck each other).
    try { res = await api.perfScan(); } catch (e) { /* toast already shown */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    if (!res || cancelled) { if (!cancelled) play('error'); S.phase = S.res ? 'results' : 'idle'; return render(); }
    S.res = res;
    S.icons = new Map();
    S.sysLimit = SYS_STEP;
    S.filter = 'all';
    S.sel = new Set(); S.lsel = new Set(); S.note = null;
    const n = res.agents.length;
    mark('agents', tn(n, '{n} item', '{n} itens'));
    if (res.login.needsAutomation) mark('login', t('precisa de permissão'), 'skip');
    else if (res.login.error) mark('login', t('não concluído'), 'skip');
    else mark('login', tn(loginCount(), '{n} item', '{n} itens'));
    mark('snaps', res.snapshots.error ? t('não concluído') : tn(res.snapshots.items.length, '{n} snapshot', '{n} snapshots'), res.snapshots.error ? 'skip' : 'done');
    await new Promise((r) => setTimeout(r, 500));
    if (!ctx.alive) return;
    S.phase = 'results';
    play('found');
    render();
  }

  // ---------- Results ----------
  function renderResults() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const r = S.res;
    const all = r.agents, flagged = all.filter((a) => a.flagged).length, active = userAgents().filter((a) => a.state === 'active').length;
    const m = r.monitor.memory;
    const pressure = pressureLabel(m ? m.pressure : null);
    const snaps = r.snapshots.items.length;
    const login = r.login;
    const tiles = [
      {
        tab: 'agents', ic: 'chip', hot: true,
        title: tn(all.length, '{n} agente em segundo plano', '{n} agentes em segundo plano'),
        sub: t('{user} do usuário ({active} ativos) e {sys} do sistema.', { user: fmtNum(userAgents().length), active: fmtNum(active), sys: fmtNum(systemAgents().length) }),
        warn: flagged ? tn(flagged, '{n} pede atenção', '{n} pedem atenção') : null, action: t('Revisar'),
      },
      login.needsAutomation
        ? { tab: 'login', ic: 'lock', title: t('Itens de login'), sub: t('O macOS precisa liberar o Limpae para ler a lista de itens de login.'), action: t('Ver como liberar') }
        : login.error
          ? { tab: 'login', ic: 'restart', title: t('Itens de login'), sub: tr(login.error), action: t('Ver detalhes') }
          : { tab: 'login', ic: 'restart', title: tn(loginCount(), '{n} item de login', '{n} itens de login'), sub: loginCount() ? t('Apps que abrem sozinhos quando você entra no Mac.') : t('Nenhum app abre sozinho quando você entra.'), action: loginCount() ? t('Revisar') : null },
      {
        tab: 'monitor', ic: 'pulse',
        title: t('Memória: pressão {p}', { p: pressure }),
        sub: m ? (r.monitor.swap ? t('{used} de {total} em uso · troca de {swap}.', { used: fmtBytes(m.used), total: fmtBytes(m.total), swap: fmtBytes(r.monitor.swap.used) }) : t('{used} de {total} em uso.', { used: fmtBytes(m.used), total: fmtBytes(m.total) })) : t('Leitura indisponível.'), action: t('Abrir monitor'),
      },
      {
        tab: 'snaps', ic: 'clock',
        title: snaps ? tn(snaps, '{n} snapshot do Time Machine', '{n} snapshots do Time Machine') : t('Sem snapshots locais'),
        sub: r.snapshots.error ? tr(r.snapshots.error) : snaps ? t('Cópias temporárias do disco que o macOS guarda e apaga sozinho.') : t('Não há cópias temporárias ocupando espaço agora.'), action: snaps ? t('Revisar') : null,
      },
    ];
    const el = h('section', { class: 'pf-results enter', dataset: { mod: 'perf' }, 'aria-label': t('Resultados') },
      h('div', { class: 'pf-bar' }, h('button', { class: 'btn sm ghost', type: 'button', onClick: async () => { if (await confirmRestart('perf')) { S.phase = 'idle'; render(); } } }, icon('back', 15), t('Recomeçar'))),
      h('h2', { class: 'pf-title' }, t('Veja o que roda no seu Mac.')),
      h('p', { class: 'sub pf-sub' }, t('Nada é alterado sem a sua escolha. O que você desativar pode ser reativado, e o que remover vai para o Lixo.')),
      h('button', { class: 'btn primary pf-all', type: 'button', onClick: () => openManager('agents') }, t('Abrir o gerenciador')),
      h('div', { class: 'pf-tiles' }, tiles.map((tile) => h('div', { class: 'pf-tile' + (tile.hot ? ' hot' : ''), dataset: { tab: tile.tab } },
        h('span', { class: 'pf-tile-ic' }, icon(tile.ic, 26)),
        h('div', { class: 'pf-tile-t' }, tile.title),
        h('div', { class: 'pf-tile-s' }, tile.sub),
        tile.warn ? h('span', { class: 'pf-pill warn pf-tile-warn' }, icon('alert', 12), tile.warn) : null,
        tile.action ? h('button', { class: 'btn sm', type: 'button', onClick: () => openManager(tile.tab) }, tile.action) : null))),
      whyNote('pf-why-res'));
    mount(ctx.root, el);
  }

  function openManager(tab) { S.tab = tab; S.phase = 'manager'; render(); }

  async function refreshAll(btn) {
    if (btn) { btn.disabled = true; btn.textContent = t('Verificando…'); }
    let res = null;
    try { res = await api.perfScan(); } catch (e) { /* warning already shown */ }
    if (!ctx.alive) return;
    if (res) { S.res = res; S.icons = new Map(); S.sysLimit = SYS_STEP; S.sel = new Set(); S.lsel = new Set(); }
    render(false);
  }

  // ---------- Manager ----------
  function renderManager(fresh = true) {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const navEl = h('nav', { class: 'fm-cats pf-cats', 'aria-label': t('Seções') });
    const headEl = h('div', { class: 'fm-pane-head' });
    const bodyEl = h('div', { class: 'fm-list pf-body' });
    const footEl = h('div', { class: 'rv-sel' });
    const back = () => { S.note = null; S.phase = 'results'; render(); };
    const actionBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => removeSelected() }, icon('trash', 16), t('Remover'));
    // An operation (remove, thin) is in flight: no second confirmation or duplicate call for the same items.
    let busy = false;
    const lock = (b) => {
      busy = b;
      ctx.setBusy(b);
      headEl.querySelectorAll('button').forEach((x) => { if (b) { x.dataset.wasDisabled = String(x.disabled); x.disabled = true; } else { x.disabled = x.dataset.wasDisabled === 'true'; delete x.dataset.wasDisabled; } });
      if (b) actionBtn.disabled = true; else renderFoot();
    };

    const summary = (id) => {
      const r = S.res;
      if (id === 'agents') { const u = userAgents(); return t('{items} · {active} ativos', { items: tn(r.agents.length, '{n} item', '{n} itens'), active: fmtNum(u.filter((a) => a.state === 'active').length) }); }
      if (id === 'login') return r.login.needsAutomation ? t('Precisa de permissão') : r.login.error ? t('Não concluído') : tn(loginCount(), '{n} item', '{n} itens');
      if (id === 'monitor') return t('Ao vivo, a cada 2 s');
      return r.snapshots.error ? t('Não concluído') : tn(r.snapshots.items.length, '{n} snapshot', '{n} snapshots');
    };
    function renderNav() {
      mount(navEl, tabs().map((tab) => h('button', { class: 'fm-cat', type: 'button', dataset: { fk: 'tab:' + tab.id }, 'aria-current': String(tab.id === S.tab), onClick: () => { if (S.tab !== tab.id) keepFocus(ctx.root, () => { S.tab = tab.id; S.note = null; showTab(); }); } },
        h('span', { class: 'fm-cat-ic' }, icon(tab.ic, 17)),
        h('span', { class: 'fm-cat-t' }, h('b', null, tab.label), h('span', null, summary(tab.id))))), whyNote('pf-why-nav'));
    }
    // Footer: selection + "Remove" in the agents and login items tabs; notice of what just happened (with "View log").
    const selOfTab = () => (S.tab === 'agents' ? S.sel : S.tab === 'login' ? S.lsel : null);
    function renderFoot() {
      const flagged = S.res.agents.filter((a) => a.flagged).length;
      const sel = selOfTab();
      const kids = [];
      if (S.note) kids.push(S.note(), ' ', h('button', { class: 'link', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, t('Ver log')));
      else if (sel && sel.size) kids.push(h('b', null, tn(sel.size, '{n} item selecionado', '{n} itens selecionados')));
      else if (sel) kids.push(flagged && S.tab === 'agents' ? h('span', { class: 'pf-foot-warn' }, icon('alert', 14), tn(flagged, '{n} agente pede atenção', '{n} agentes pedem atenção')) : t('Nenhum item selecionado'));
      else kids.push(flagged ? h('span', { class: 'pf-foot-warn' }, icon('alert', 14), tn(flagged, '{n} agente pede atenção', '{n} agentes pedem atenção')) : t('Tudo o que você desativar pode ser reativado.'));
      mount(footEl, kids);
      actionBtn.hidden = !sel;
      actionBtn.disabled = busy || !sel || !sel.size;
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

    // --- Agents ---
    function paneAgents() {
      mount(headEl,
        h('div', { class: 'fm-pane-t' }, h('h3', null, t('Agentes em segundo plano')), h('p', null, t('Programas que o macOS inicia sozinho em seu nome. Desative o que você não usa; dá para reativar quando quiser.'))),
        h('div', { class: 'fm-tools' }, segmented([{ value: 'all', label: t('Todos') }, { value: 'flag', label: t('Pedem atenção') }], S.filter, (v) => { S.filter = v; S.sysLimit = SYS_STEP; listAgents(); }, t('Filtro de agentes'))));
      listAgents();
    }
    function listAgents() {
      const keep = (a) => S.filter === 'all' || a.flagged;
      const mine = userAgents().filter(keep), sys = systemAgents().filter(keep);
      const shown = sys.slice(0, S.sysLimit);
      const kids = [h('p', { class: 'pf-notice' }, icon('alert', 14), t('Alguns apps precisam dos itens em segundo plano para funcionar direito. Desative ou remova só o que você reconhece.'))];
      if (mine.length) kids.push(h('section', { class: 'fm-sec' }, h('div', { class: 'fm-sec-head' }, h('b', null, t('Seus agentes')), h('span', null, tn(mine.length, '{n} item', '{n} itens'))), mine.map(agentRow)));
      if (sys.length) {
        kids.push(h('section', { class: 'fm-sec' },
          h('div', { class: 'fm-sec-head' }, h('b', null, t('Do sistema · requer administrador')), h('span', null, t('{items} · somente leitura', { items: tn(sys.length, '{n} item', '{n} itens') }))),
          shown.map(agentRow),
          sys.length > shown.length ? h('div', { class: 'rv-more' }, h('button', { class: 'btn sm', type: 'button', onClick: () => {
            // The button is replaced by the new rows (system agents have no control of their own): focus goes to the first new row.
            const first = sys[S.sysLimit];
            S.sysLimit += SYS_STEP * 2;
            listAgents();
            const n = first && bodyEl.querySelector(`.pf-row[data-id="${CSS.escape(first.id)}"]`);
            if (n) { n.tabIndex = -1; n.focus(); }
          } }, tn(sys.length - shown.length, 'Mostrar mais ({n} item)', 'Mostrar mais ({n} itens)'))) : null));
      }
      if (kids.length === 1) kids.push(h('div', { class: 'rv-empty' }, S.filter === 'flag' ? t('Nenhum agente pede atenção.') : t('Nenhum agente encontrado.')));
      mount(bodyEl, kids);
    }
    function agentRow(a) {
      const slot = h('div', { class: 'pf-ic' }, icon('chip', 17));
      if (a.owner) loadIcon(a.id, slot);
      const user = a.scope === 'user';
      const pills = [];
      if (a.state === 'active') pills.push(pill(t('Ativo'), 'ok'));
      else if (a.state === 'inactive') pills.push(pill(t('Inativo'), 'idle', t('Habilitado, mas não carregado agora.')));
      else if (a.state === 'disabled') pills.push(pill(t('Desativado'), 'off'));
      if (signaturePill(a.signature)) pills.push(pill(signaturePill(a.signature), 'warn', signatureHint(a.signature)));
      if (user && !a.manageable && a.note) pills.push(pill(tr(a.note), 'idle'));
      const facts = [a.runAtLoad ? t('Abre no login') : null, a.keepAlive ? t('Reinicia sozinho') : null,
        a.signature === 'valid' ? (a.signer ? t('Assinado por {signer}', { signer: a.signer.replace(/^Developer ID Application: /, '') }) : t('Assinatura válida')) : a.signature === 'adHoc' ? t('Assinatura ad hoc') : a.signature === 'unknown' ? t('Assinatura não verificada') : null].filter(Boolean);
      const manageable = user && a.manageable;
      const actions = manageable
        ? [h('button', { class: 'pf-switch', type: 'button', role: 'switch', 'aria-checked': String(a.state !== 'disabled'), 'aria-label': a.state === 'disabled' ? t('Ativar {name}', { name: agentName(a) }) : t('Desativar {name}', { name: agentName(a) }), title: a.state === 'disabled' ? t('Ativar') : t('Desativar'), onClick: (e) => toggle(a, e.currentTarget.closest('.pf-row')) }, h('i'))]
        : [h('span', { class: 'pf-lock', title: user ? tr(a.note) : t('Do sistema · requer administrador') }, icon('lock', 15))];
      // A new selection replaces the "N removed" note: the footer must show what Remove will act on.
      const flip = () => { if (busy) return; S.sel.has(a.id) ? S.sel.delete(a.id) : S.sel.add(a.id); S.note = null; cb.set(S.sel.has(a.id) ? 'on' : 'off'); renderFoot(); };
      const cb = manageable ? checkbox(S.sel.has(a.id) ? 'on' : 'off', flip, t('Selecionar {name}', { name: agentName(a) })) : h('span', { class: 'pf-nocb', 'aria-hidden': 'true' });
      const row = h('div', { class: 'pf-row', dataset: { state: a.state || 'system', id: a.id }, onClick: manageable ? (e) => { if (!e.target.closest('button')) flip(); } : null }, cb, slot,
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, h('span', { title: agentName(a) }, agentName(a)), pills),
          h('div', { class: 'fm-meta pf-meta' }, h('span', { class: 'pf-label', title: a.label }, a.label), a.program ? mid(a.program, 26) : h('span', null, t('Sem programa'))),
          facts.length ? h('div', { class: 'pf-facts' }, facts.join(' · ')) : null),
        h('div', { class: 'pf-actions' }, actions));
      // Right click (user agents, registered in the backend): Show in Finder. The system ones are read-only.
      if (manageable) attachMenu(row, () => ({ id: a.id, name: agentName(a), quickLook: false, ignore: false, select: { on: S.sel.has(a.id), toggle: flip } }));
      return row;
    }
    async function toggle(a, row) {
      if (busy) return;
      const enable = a.state === 'disabled';
      const sw = row.querySelector('.pf-switch');
      const hadFocus = document.activeElement === sw; // read before disabling, which drops focus
      sw.disabled = true;
      sw.classList.add('busy');
      try {
        const r = await api.agentToggle(a.id, enable);
        a.state = r.state;
        // No sound of its own: the 'ok' toast is the feedback (a second sound would stack on it).
        if (ctx.alive) toast(enable ? t('{name} ativado.', { name: agentName(a) }) : t('{name} desativado. Dá para reativar quando quiser.', { name: agentName(a) }), 'ok');
      } catch (e) { if (!e.reported) play('error'); }
      if (!ctx.alive || S.tab !== 'agents') return;
      // The rebuilt row replaces the focused switch: focus moves to the new one so keyboard users keep their place.
      const fresh = agentRow(a);
      row.replaceWith(fresh);
      if (hadFocus) { const nsw = fresh.querySelector('.pf-switch'); if (nsw) nsw.focus({ preventScroll: true }); }
      renderNav();
    }
    // Removes what is checked in the open tab (agents or login items), with confirmation.
    async function removeSelected() {
      if (busy) return;
      const agents = S.tab === 'agents';
      const sel = agents ? S.sel : S.lsel;
      const list = agents ? S.res.agents.filter((x) => sel.has(x.id)) : S.res.login.items.filter((x) => sel.has(x.id));
      if (!list.length) return;
      const one = list.length === 1;
      const nameOf = (x) => (agents ? agentName(x) : x.name);
      const ok = await confirmDialog({
        title: one ? t('Remover {name}?', { name: nameOf(list[0]) }) : agents ? tn(list.length, 'Remover {n} agente?', 'Remover {n} agentes?') : tn(list.length, 'Remover {n} item de login?', 'Remover {n} itens de login?'),
        glyph: agents ? 'trash' : 'restart', danger: true, mod: 'perf', confirm: t('Remover'),
        body: agents
          ? h('span', null, one ? t('O agente será parado agora e o arquivo de configuração ({file}) irá para o Lixo, de onde dá para restaurar. Os apps donos não são removidos.', { file: list[0].file }) : t('Os agentes serão parados agora e os arquivos de configuração irão para o Lixo, de onde dá para restaurar. Os apps donos não são removidos.'))
          : h('span', null, t('Os apps deixam de abrir sozinhos quando você entra no Mac. Continuam instalados, e dá para adicioná-los de novo em Ajustes do Sistema › Geral › Itens de Início.')),
      });
      if (!ok || !ctx.alive || busy) return;
      lock(true);
      let res = null;
      try { res = await (agents ? api.agentRemove : api.loginItemRemove)(list.map((x) => x.id)); } catch (e) { if (!e.reported) play('error'); }
      lock(false);
      if (!res || !ctx.alive) return;
      const done = res.outcomes.filter((o) => o.ok).map((o) => o.id);
      const bad = res.outcomes.filter((o) => !o.ok);
      if (done.length) {
        if (agents) S.res.agents = S.res.agents.filter((x) => !done.includes(x.id)); else S.res.login.items = S.res.login.items.filter((x) => !done.includes(x.id));
        for (const id of done) sel.delete(id);
        const nDone = done.length;
        S.note = () => tn(nDone, '{n} item removido.', '{n} itens removidos.');
      }
      play(done.length ? 'clean' : 'error'); // exactly one result sound, even on a partial failure
      showTab();
      if (bad.length) {
        const byId = new Map(list.map((x) => [x.id, x]));
        await failuresSheet(bad.map((o) => ({ id: o.id, name: byId.has(o.id) ? nameOf(byId.get(o.id)) : t('Item'), path: '', error: tr(o.error) })));
      }
    }

    // --- Login items ---
    function paneLogin() {
      const L = S.res.login;
      mount(headEl, h('div', { class: 'fm-pane-t' }, h('h3', null, t('Itens de login')), h('p', null, t('Apps que abrem sozinhos quando você entra no Mac. Remover um item só tira o app da lista; o app continua instalado.'))));
      if (L.needsAutomation) {
        return mount(bodyEl, h('div', { class: 'pf-card pf-need' },
          h('span', { class: 'pf-card-ic' }, icon('lock', 22)),
          h('div', null, h('b', null, t('O macOS precisa liberar o acesso')),
            h('p', null, t('Para listar os itens de login, o Limpae conversa com o System Events. Abra Ajustes do Sistema › Privacidade e Segurança › Automação, ative o System Events para o Limpae e tente de novo.')),
            h('div', { class: 'row-actions', style: 'margin-top:14px' }, h('button', { class: 'btn primary', type: 'button', onClick: (e) => refreshAll(e.currentTarget) }, t('Tentar de novo'))))));
      }
      if (L.error) {
        return mount(bodyEl, h('div', { class: 'pf-card pf-need' }, h('span', { class: 'pf-card-ic' }, icon('alert', 22)),
          h('div', null, h('b', null, tr(L.error)), h('div', { class: 'row-actions', style: 'margin-top:14px' }, h('button', { class: 'btn', type: 'button', onClick: (e) => refreshAll(e.currentTarget) }, t('Tentar de novo'))))));
      }
      if (!L.items.length) return mount(bodyEl, h('div', { class: 'rv-empty' }, t('Nenhum app abre sozinho quando você entra no Mac.')));
      mount(bodyEl, h('section', { class: 'fm-sec' }, h('div', { class: 'fm-sec-head' }, h('b', null, t('Abrem ao entrar')), h('span', null, tn(L.items.length, '{n} item', '{n} itens'))), L.items.map(loginRow)));
    }
    function loginRow(it) {
      const slot = h('div', { class: 'pf-ic' }, icon('restart', 17));
      if (it.path && it.path.endsWith('.app')) loadIcon(it.id, slot);
      const flip = () => { if (busy) return; S.lsel.has(it.id) ? S.lsel.delete(it.id) : S.lsel.add(it.id); S.note = null; cb.set(S.lsel.has(it.id) ? 'on' : 'off'); renderFoot(); };
      const cb = checkbox(S.lsel.has(it.id) ? 'on' : 'off', flip, t('Selecionar {name}', { name: it.name }));
      const row = h('div', { class: 'pf-row', onClick: (e) => { if (!e.target.closest('button')) flip(); } }, cb, slot,
        h('div', { class: 'fm-main' }, h('div', { class: 'fm-name' }, h('span', { title: it.name }, it.name)), h('div', { class: 'fm-meta pf-meta' }, it.path ? mid(it.path, 26) : h('span', null, t('Sem caminho')))));
      return row;
    }

    // --- Monitor ---
    function paneMonitor() {
      mount(headEl, h('div', { class: 'fm-pane-t' }, h('h3', null, t('Monitor do sistema')), h('p', null, t('Leitura em tempo real, atualizada a cada 2 segundos enquanto esta tela está aberta. Só leitura: nada aqui altera o Mac.'))));
      monitorUi = buildMonitor();
      mount(bodyEl, monitorUi.el);
      monitorUi.update(S.res.monitor);
      const tick = async () => {
        if (ticking || document.hidden || !ctx.alive || S.tab !== 'monitor') return;
        ticking = true;
        try {
          const m = await api.perfMonitor();
          if (ctx.alive && S.tab === 'monitor' && monitorUi) monitorUi.update(m);
        } catch (e) { /* the next reading tries again */ } finally { ticking = false; }
      };
      tick();
      timer = setInterval(tick, TICK_MS);
    }

    // --- Snapshots ---
    function paneSnaps() {
      const Sn = S.res.snapshots;
      const n = Sn.items.length;
      mount(headEl,
        h('div', { class: 'fm-pane-t' }, h('h3', null, t('Snapshots locais do Time Machine')), h('p', null, t('Cópias temporárias do disco que o macOS guarda para o Time Machine e apaga sozinho quando precisa de espaço.'))),
        h('div', { class: 'fm-tools' }, Sn.canThin ? h('button', { class: 'btn sm', type: 'button', disabled: n === 0, onClick: thin }, t('Afinar snapshots')) : null));
      if (Sn.error) return mount(bodyEl, h('div', { class: 'pf-card pf-need' }, h('span', { class: 'pf-card-ic' }, icon('alert', 22)), h('div', null, h('b', null, tr(Sn.error)))));
      if (!n) return mount(bodyEl, h('div', { class: 'rv-empty' }, t('Nenhum snapshot local agora. Não há nada para afinar.')));
      mount(bodyEl, h('section', { class: 'fm-sec' }, h('div', { class: 'fm-sec-head' }, h('b', null, t('Neste Mac')), h('span', null, tn(n, '{n} snapshot', '{n} snapshots'))),
        Sn.items.map((x) => {
          const d = x.date ? new Date(x.date) : null;
          return h('div', { class: 'pf-row' }, h('div', { class: 'pf-ic' }, icon('clock', 17)),
            h('div', { class: 'fm-main' }, h('div', { class: 'fm-name' }, h('span', null, d ? dtf.format(d) : x.name)), h('div', { class: 'fm-meta pf-meta' }, h('span', { class: 'pf-label wide', title: x.name }, x.name))),
            h('span', { class: 'pf-when' }, d ? relative(d) : ''));
        })));
    }
    async function thin() {
      if (busy) return;
      const n = S.res.snapshots.items.length;
      const ok = await confirmDialog({
        title: t('Afinar os snapshots locais?'), glyph: 'clock', danger: true, mod: 'perf', confirm: t('Afinar'),
        body: h('span', null, tn(n, 'O snapshot local será apagado. Não dá para desfazer, mas o Time Machine cria novos sozinho e seus arquivos não são afetados.', 'Os {n} snapshots locais serão apagados. Não dá para desfazer, mas o Time Machine cria novos sozinho e seus arquivos não são afetados.')),
      });
      if (!ok || !ctx.alive || busy) return;
      lock(true);
      let res = null;
      try { res = await api.tmThin(); } catch (e) { if (!e.reported) play('error'); }
      lock(false);
      if (!res || !ctx.alive) return;
      S.res.snapshots.items = res.snapshots;
      play(res.removed ? 'clean' : 'error'); // the cue matches the note: nothing removed is not a success
      const nGone = res.removed;
      S.note = () => (nGone ? tn(nGone, '{n} snapshot removido.', '{n} snapshots removidos.') : t('Nenhum snapshot foi removido.'));
      if (S.tab === 'snaps') showTab(); else renderNav();
    }

    const el = h('section', { class: 'review fm pf' + (fresh ? ' enter' : ''), dataset: { mod: 'perf' }, 'aria-label': t('Gerenciador de velocidade') },
      managerBar({ title: t('Velocidade'), subtitle: t('Revise o que roda sozinho e acompanhe o uso do Mac.'), onBack: back }),
      h('div', { class: 'fm-body' }, navEl, h('div', { class: 'fm-pane' }, headEl, bodyEl)),
      h('div', { class: 'rv-foot' }, footEl, actionBtn));
    mount(ctx.root, el);
    ctx.onBack(back);
    showTab();
  }

  render();
}

// Monitor panel: mounts once and only updates texts and attributes on each reading (without recreating the DOM).
function buildMonitor() {
  const R = 52, C = 2 * Math.PI * R;
  const arc = (k) => s('circle', { class: 'pf-arc ' + k, cx: 70, cy: 70, r: R, fill: 'none', 'stroke-width': 14, transform: 'rotate(-90 70 70)', 'stroke-dasharray': `0 ${C}`, 'stroke-dashoffset': 0 });
  const arcs = { app: arc('app'), wired: arc('wired'), compressed: arc('compressed') };
  const ring = s('svg', { class: 'pf-ring', viewBox: '0 0 140 140', role: 'img', 'aria-label': t('Uso de memória') }, s('circle', { class: 'pf-track', cx: 70, cy: 70, r: R, fill: 'none', 'stroke-width': 14 }), arcs.app, arcs.wired, arcs.compressed);
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
      h('div', { class: 'pf-gt' }, t('Memória'), pressure),
      h('div', { class: 'pf-mem-in' },
        h('div', { class: 'pf-ring-wrap' }, ring, h('div', { class: 'pf-ring-c' }, memUsed, memOf)),
        h('ul', { class: 'pf-legend' },
          h('li', null, h('i', { class: 'app' }), h('span', null, t('App')), legend.app),
          h('li', null, h('i', { class: 'wired' }), h('span', null, t('Dedicada')), legend.wired),
          h('li', null, h('i', { class: 'compressed' }), h('span', null, t('Comprimida')), legend.compressed)))),
    gauge(t('Memória de troca'), swapV, h('div', { class: 'pf-bar-t' }, swapBar), swapS),
    gauge(t('Processador'), cpuV, spark, cpuS),
    h('div', { class: 'pf-card pf-gauge pf-bat' }, h('div', { class: 'pf-gt' }, t('Bateria')), batV, h('div', { class: 'pf-bar-t' }, batBar), batS),
    gauge(t('Tempo ligado'), upV, h('div', { class: 'pf-cap' }, t('desde a última reinicialização'))),
    h('div', { class: 'pf-card pf-topc' }, h('div', { class: 'pf-gt' }, t('Maiores consumidores de memória')), topEl));

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
      memOf.textContent = t('de {total}', { total: fmtBytes(mem.total) });
      pressure.textContent = t('Pressão {p}', { p: pressureLabel(mem.pressure) });
      pressure.className = 'pf-pill ' + (mem.pressure === 'normal' ? 'ok' : mem.pressure === 'critical' ? 'bad' : mem.pressure === 'warning' ? 'warn' : 'idle');
      ring.setAttribute('aria-label', t('Memória em uso: {used} de {total}', { used: fmtBytes(mem.used), total: fmtBytes(mem.total) }));
    }
    if (m.swap) {
      swapV.textContent = fmtBytes(m.swap.used);
      swapBar.style.width = (m.swap.total ? Math.min(100, (m.swap.used / m.swap.total) * 100) : 0) + '%';
      swapS.textContent = m.swap.total ? t('de {total} reservados', { total: fmtBytes(m.swap.total) }) : t('sem arquivo de troca');
    }
    const c = m.cpu;
    const usage = c.usage != null ? c.usage : Math.min(100, (c.load1 / Math.max(1, c.cores)) * 100);
    if (c.usage != null || !S.hist.length) S.hist.push(usage);
    if (S.hist.length > HIST) S.hist.shift();
    cpuV.textContent = `${fmtNum(Math.round(usage))}%`;
    cpuS.textContent = t('Carga média {a} · {b} · {c} ({cores})', { a: nf1.format(c.load1), b: nf1.format(c.load5), c: nf1.format(c.load15), cores: tn(c.cores, '{n} núcleo', '{n} núcleos') });
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
      const state = { charging: t('Carregando'), discharging: t('Usando a bateria'), charged: t('Carregada'), idle: t('Na tomada') }[b.state] || '';
      const rest = b.remainingMin ? ' · ' + t('{h} h {m} min', { h: Math.floor(b.remainingMin / 60), m: String(b.remainingMin % 60).padStart(2, '0') }) : '';
      const wear = [b.cycles != null ? tn(b.cycles, '{n} ciclo', '{n} ciclos') : null, b.healthPct != null ? t('capacidade {pct}%', { pct: b.healthPct }) : null].filter(Boolean).join(' · ');
      batS.textContent = state + (b.state === 'discharging' || b.state === 'charging' ? rest : '') + (wear ? ` · ${wear}` : '');
    } else {
      batV.textContent = '—';
      batBar.style.width = '0%';
      batS.textContent = t('Este Mac não tem bateria ou ela não foi lida ainda.');
    }
    upV.textContent = fmtUptime(m.uptimeSecs);
    mount(topEl, m.top.length ? m.top.map((p) => h('li', null, h('span', { class: 'pf-top-n', title: p.name }, p.name, p.count > 1 ? h('small', null, ' ', tn(p.count, '{n} processo', '{n} processos')) : null), h('span', { class: 'pf-top-v' }, fmtBytes(p.rss)))) : h('li', { class: 'pf-top-empty' }, t('Coletando…')));
  }
  return { el, update };
}
