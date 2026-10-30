// Nuvem (iCloud Drive): lista arquivos baixados no Mac e remove só a cópia local ("desincronizar").
// O arquivo continua no iCloud e baixa de novo quando é aberto. Nada aqui apaga dados da nuvem.
import { play } from '../sound.js';
import { h, mount } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { selectedSize, pruneResult, countItems } from '../store.js';
import { bytesParts, fmtBytes, plural } from '../format.js';
import { confirmDialog, failuresSheet, stage, features } from '../ui.js';
import { outcomesToFailures } from '../actions.js';
import { createReview } from './review.js';

const BATCH = 8;
// Sessão do módulo: sobrevive à troca de aba.
const C = { phase: 'idle', result: null, sel: new Set(), freed: 0 };

export function enter(ctx) {
  let st = null, cancelled = false;
  if (C.phase === 'review' && !C.result) C.phase = 'idle';
  if (!['review', 'done'].includes(C.phase)) C.phase = 'idle';

  function ensureStage() {
    if (!st) { st = stage('cloud', 'cloud', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    st.busy(false);
  }

  function render() {
    if (C.phase === 'review' && C.result) {
      if (C.result.needsFda) return renderFda();
      if (!countItems(C.result)) return renderEmpty();
      return renderReview();
    }
    ensureStage();
    if (C.phase === 'done') return renderDone();
    return renderIdle();
  }

  function renderIdle() {
    C.phase = 'idle';
    st.show(h('h1', { class: 'h1' }, 'Libere espaço sem perder nada do iCloud'),
      h('p', { class: 'sub' }, 'Remova do Mac as cópias dos arquivos do iCloud Drive que você não usa agora.'),
      features('cloud', [['cloud', 'Os arquivos continuam guardados no iCloud'], ['refresh', 'Baixam de novo quando você abrir'], ['shield', 'Nada é apagado da nuvem']]),
      C.result ? h('div', { class: 'row-actions' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { C.phase = 'review'; st = null; render(); } }, 'Voltar aos resultados')) : null);
    ctx.setDock({ label: 'Analisar', mod: 'cloud', onClick: scan });
  }

  async function scan() {
    cancelled = false;
    C.phase = 'scanning';
    play('start');
    ctx.setBusy(true);
    ensureStage();
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, 'Procurando no iCloud Drive…'), h('p', { class: 'sub' }, 'Buscando arquivos grandes que estão baixados neste Mac.'), ticker);
    ctx.onProgress((p) => { if (p.task === 'icloud') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: 'Parar', busy: true, mod: 'cloud', onClick: () => { cancelled = true; ctx.setDock({ label: 'Parando', busy: true, disabled: true, mod: 'cloud' }); api.cancel().catch(() => {}); } });
    let ok = false;
    try {
      const r = await api.cloudScan();
      if (!cancelled) { C.result = r; C.sel = new Set(); ok = true; }
    } catch (e) { /* toast já exibido */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    C.phase = ok ? 'review' : 'idle';
    if (ok) { st = null; play('found'); }
    render();
  }

  function renderFda() {
    st = null; ensureStage();
    st.show(h('div', { class: 'panel' },
      h('div', { class: 'glyph-chip' }, icon('lock', 22)),
      h('h3', null, 'Acesso Total ao Disco necessário'),
      h('p', null, 'O macOS protege a pasta do iCloud Drive. Para o Limpae listar os arquivos baixados, conceda acesso:'),
      h('ol', null, h('li', null, 'Abra Ajustes do Sistema › Privacidade e Segurança.'), h('li', null, 'Entre em Acesso Total ao Disco e ative o Limpae.'), h('li', null, 'Volte aqui e analise de novo.')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => api.openFda().catch(() => {}) }, 'Abrir Ajustes'),
        h('button', { class: 'btn', type: 'button', onClick: () => { C.phase = 'idle'; C.result = null; render(); ctx.refreshDisk(); } }, 'Voltar'))));
    ctx.setDock(null);
  }

  function renderEmpty() {
    st = null; ensureStage();
    st.show(h('h1', { class: 'h1' }, 'Nada para liberar'), h('p', { class: 'sub' }, 'Não há arquivos grandes do iCloud Drive baixados neste Mac.'),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => { C.phase = 'idle'; C.result = null; render(); } }, icon('refresh', 15), 'Analisar de novo')));
    ctx.setDock(null);
  }

  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const n = countItems(C.result);
    const rv = createReview({
      result: C.result, sel: C.sel, mod: 'cloud', title: 'Arquivos do iCloud neste Mac',
      subtitle: `${plural(n, 'arquivo', 'arquivos')} · ${fmtBytes(C.result.total)} ocupados · continuam no iCloud`,
      actionLabel: 'Remover do Mac', showAge: true, emptyText: 'Nenhum arquivo baixado.',
      onBack: () => { C.phase = 'idle'; render(); }, onAction: () => evict(),
    });
    mount(ctx.root, rv.el);
  }

  async function evict() {
    const { bytes, count } = selectedSize(C.result, C.sel);
    if (!count) return;
    const ok = await confirmDialog({
      title: `Remover ${plural(count, 'arquivo', 'arquivos')} deste Mac?`,
      body: [`Isso libera cerca de ${fmtBytes(bytes)}. `, h('strong', null, 'Os arquivos continuam no iCloud'), ' e baixam de novo quando você abrir. Nada é apagado da nuvem nem enviado ao Lixo.'],
      confirm: 'Remover do Mac', glyph: 'cloud', mod: 'cloud',
    });
    if (!ok) return;
    C.phase = 'working';
    ctx.setBusy(true);
    st = null; ensureStage(); st.busy(true);
    const line = h('p', { class: 'sub' }, `0 de ${count}`);
    st.show(h('h1', { class: 'h1' }, 'Removendo do Mac…'), line);
    ctx.setDock({ label: 'Removendo', busy: true, mod: 'cloud' });

    const items = C.result.groups.flatMap((g) => g.items).filter((i) => C.sel.has(i.id));
    const byId = new Map(items.map((i) => [i.id, i]));
    const okIds = new Set(), failures = [];
    let freed = 0, done = 0;
    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH);
      try {
        const res = await api.cloudEvict(chunk.map((c) => c.id));
        for (const o of res.outcomes) if (o.ok) { okIds.add(o.id); freed += o.freed || 0; }
        failures.push(...outcomesToFailures(res.outcomes, byId));
      } catch (e) {
        failures.push(...chunk.map((c) => ({ id: c.id, name: c.name, path: c.path, error: e.message })));
      }
      done += chunk.length;
      if (ctx.alive) line.textContent = `${done} de ${count}`;
    }
    C.result = pruneResult(C.result, okIds);
    for (const id of okIds) C.sel.delete(id);
    C.freed = freed; C.phase = 'done';
    play(freed ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return;
    st = null;
    render();
    if (failures.length) failuresSheet(failures);
  }

  function renderDone() {
    st.show(h('div', { class: 'big' }, bytesParts(C.freed).value, h('small', null, bytesParts(C.freed).unit)), h('div', { class: 'big-cap' }, 'liberados neste Mac'),
      h('p', { class: 'sub' }, 'Os arquivos continuam no iCloud e baixam de novo quando você abrir.'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), 'Ver log'),
        C.result && countItems(C.result) ? h('button', { class: 'btn primary', type: 'button', onClick: () => { C.phase = 'review'; st = null; render(); } }, 'Continuar revisando') : h('button', { class: 'btn primary', type: 'button', onClick: () => { C.phase = 'idle'; C.result = null; render(); } }, 'Analisar de novo')));
    ctx.setDock(null);
  }

  render();
}
