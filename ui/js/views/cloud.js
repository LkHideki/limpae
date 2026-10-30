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
import { t } from '../i18n.js';

const MARK = '\u0001'; // marcador {b} onde entra o trecho em negrito
const withNode = (s, node) => { const [a, b = ''] = s.split(MARK); return [a, node, b]; };

const BATCH = 8;
// Sessão do módulo: sobrevive à troca de aba.
const C = { phase: 'idle', result: null, sel: new Set(), freed: 0 };

export function enter(ctx) {
  let st = null, cancelled = false;
  if (['summary', 'review'].includes(C.phase) && !C.result) C.phase = 'idle';
  if (!['summary', 'review', 'done'].includes(C.phase)) C.phase = 'idle';

  function ensureStage() {
    if (!st) { st = stage('cloud', 'cloud', 260); mount(ctx.root, st.el); }
    ctx.reserveDock(true);
    st.busy(false);
  }

  function render() {
    ctx.onBack(null);
    if (['summary', 'review'].includes(C.phase) && C.result) {
      if (C.result.needsFda) return renderFda();
      if (!countItems(C.result)) return renderEmpty();
      return C.phase === 'review' ? renderReview() : renderSummary();
    }
    ensureStage();
    if (C.phase === 'done') return renderDone();
    return renderIdle();
  }

  function renderIdle() {
    C.phase = 'idle';
    st.show(h('h1', { class: 'h1' }, t('Libere espaço sem perder nada do iCloud')),
      h('p', { class: 'sub' }, t('Remova do Mac as cópias dos arquivos do iCloud Drive que você não usa agora.')),
      features('cloud', [['cloud', t('Os arquivos continuam guardados no iCloud')], ['refresh', t('Baixam de novo quando você abrir')], ['shield', t('Nada é apagado da nuvem')]]),
      C.result ? h('div', { class: 'row-actions' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { C.phase = 'summary'; st = null; render(); } }, t('Voltar aos resultados'))) : null);
    ctx.setDock({ label: t('Analisar'), mod: 'cloud', onClick: scan });
  }

  async function scan() {
    cancelled = false;
    C.phase = 'scanning';
    play('start');
    ctx.setBusy(true);
    ensureStage();
    st.busy(true);
    const ticker = h('div', { class: 'ticker' });
    st.show(h('h1', { class: 'h1' }, t('Procurando no iCloud Drive…')), h('p', { class: 'sub' }, t('Buscando arquivos grandes que estão baixados neste Mac.')), ticker);
    ctx.onProgress((p) => { if (p.task === 'icloud') ticker.textContent = p.path || ''; });
    ctx.setDock({ label: t('Parar'), busy: true, mod: 'cloud', onClick: () => { cancelled = true; ctx.setDock({ label: t('Parando'), busy: true, disabled: true, mod: 'cloud' }); api.cancel().catch(() => {}); } });
    let ok = false;
    try {
      const r = await api.cloudScan();
      if (!cancelled) { C.result = r; C.sel = new Set(); ok = true; }
    } catch (e) { /* toast já exibido */ }
    ctx.setBusy(false);
    if (!ctx.alive) return;
    C.phase = ok ? 'summary' : 'idle';
    if (ok) { st = null; play('found'); }
    render();
  }

  function renderFda() {
    st = null; ensureStage();
    st.show(h('div', { class: 'panel' },
      h('div', { class: 'glyph-chip' }, icon('lock', 22)),
      h('h3', null, t('Acesso Total ao Disco necessário')),
      h('p', null, t('O macOS protege a pasta do iCloud Drive. Para o Limpae listar os arquivos baixados, conceda acesso:')),
      h('ol', null, h('li', null, t('Abra Ajustes do Sistema › Privacidade e Segurança.')), h('li', null, t('Entre em Acesso Total ao Disco e ative o Limpae.')), h('li', null, t('Volte aqui e analise de novo.'))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => api.openFda().catch(() => {}) }, t('Abrir Ajustes')),
        h('button', { class: 'btn', type: 'button', onClick: () => { C.phase = 'idle'; C.result = null; render(); ctx.refreshDisk(); } }, t('Voltar')))));
    ctx.setDock(null);
  }

  function renderEmpty() {
    st = null; ensureStage();
    st.show(h('h1', { class: 'h1' }, t('Nada para liberar')), h('p', { class: 'sub' }, t('Não há arquivos grandes do iCloud Drive baixados neste Mac.')),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => { C.phase = 'idle'; C.result = null; render(); } }, icon('refresh', 15), t('Analisar de novo'))));
    ctx.setDock(null);
  }

  // Resumo: o total baixado e os arquivos grandes, cada um com Revisar e Liberar do Mac.
  // Nada vem marcado: "Liberar do Mac" num bloco marca só aquele bloco e pede confirmação.
  const BIG = 100e6;
  function renderSummary() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const items = C.result.groups.flatMap((g) => g.items);
    const big = items.filter((i) => i.size >= BIG);
    const bigBytes = big.reduce((a, i) => a + i.size, 0);
    const tile = (id, ic, title, sub, list, extra) => h('div', { class: 'cl-tile', dataset: { tile: id } },
      h('span', { class: 'fl-tile-ic' }, icon(ic, 26)),
      h('div', { class: 'cl-tile-n' }, title),
      h('div', { class: 'cl-tile-t' }, sub),
      h('div', { class: 'fl-tile-s' }, extra),
      h('div', { class: 'cl-tile-act' },
        h('button', { class: 'btn sm', type: 'button', onClick: () => { C.phase = 'review'; render(); } }, t('Revisar')),
        h('button', { class: 'btn sm primary', type: 'button', onClick: async () => { C.sel = new Set(list.map((i) => i.id)); if (!(await evict())) C.sel = new Set(); } }, t('Liberar do Mac'))));
    mount(ctx.root, h('section', { class: 'fl-results cl-results enter', dataset: { mod: 'cloud' }, 'aria-label': t('Resultados da Nuvem') },
      h('h2', { class: 'fl-title' }, t('{size} de arquivos do iCloud neste Mac.', { size: fmtBytes(C.result.total) })),
      h('p', { class: 'sub fl-sub' }, t('Continuam guardados no iCloud e baixam de novo quando você abrir. Nada vem marcado.')),
      h('button', { class: 'btn primary fl-all', type: 'button', onClick: () => { C.phase = 'review'; render(); } }, t('Revisar todos os arquivos')),
      h('div', { class: 'cl-tiles', dataset: { n: big.length ? 2 : 1 } },
        tile('all', 'cloud', fmtBytes(C.result.total), t('Arquivos baixados'), items, t('{files} ocupando espaço neste Mac.', { files: plural(items.length, 'arquivo', 'arquivos') })),
        big.length ? tile('big', 'disk', fmtBytes(bigBytes), t('Arquivos grandes baixados'), big, t('{files} acima de {size}.', { files: plural(big.length, 'arquivo', 'arquivos'), size: fmtBytes(BIG) })) : null)));
  }

  function renderReview() {
    st = null;
    ctx.reserveDock(false);
    ctx.setDock(null);
    const n = countItems(C.result);
    const back = () => { C.phase = 'summary'; render(); };
    const rv = createReview({
      result: C.result, sel: C.sel, mod: 'cloud', title: t('Nuvem'),
      subtitle: t('{files} do iCloud neste Mac · {size} ocupados · continuam no iCloud', { files: plural(n, 'arquivo', 'arquivos'), size: fmtBytes(C.result.total) }),
      actionLabel: t('Liberar do Mac'), showAge: true, emptyText: t('Nenhum arquivo baixado.'), quickLook: false,
      onBack: back, onAction: () => evict(),
    });
    mount(ctx.root, rv.el);
    ctx.onBack(back);
  }

  async function evict() {
    const { bytes, count } = selectedSize(C.result, C.sel);
    if (!count) return;
    const ok = await confirmDialog({
      title: t('Liberar {files} deste Mac?', { files: plural(count, 'arquivo', 'arquivos') }),
      body: withNode(t('Isso libera cerca de {size}. {b} e baixam de novo quando você abrir. Nada é apagado da nuvem nem enviado ao Lixo.', { size: fmtBytes(bytes), b: MARK }), h('strong', null, t('Os arquivos continuam no iCloud'))),
      confirm: t('Liberar do Mac'), glyph: 'cloud', mod: 'cloud',
    });
    if (!ok) return false;
    C.phase = 'working';
    ctx.onBack(null);
    ctx.setBusy(true);
    st = null; ensureStage(); st.busy(true);
    const line = h('p', { class: 'sub' }, t('{done} de {total}', { done: 0, total: count }));
    st.show(h('h1', { class: 'h1' }, t('Liberando do Mac…')), line);
    ctx.setDock(null); // a operação não pode ser interrompida entre lotes pelo backend: sem botão que pareça Parar

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
      if (ctx.alive) line.textContent = t('{done} de {total}', { done, total: count });
    }
    C.result = pruneResult(C.result, okIds);
    for (const id of okIds) C.sel.delete(id);
    C.freed = freed; C.phase = 'done';
    play(freed ? 'clean' : 'error');
    ctx.setBusy(false);
    ctx.refreshDisk();
    if (!ctx.alive) return true;
    st = null;
    render();
    if (failures.length) failuresSheet(failures);
    return true;
  }

  function renderDone() {
    const left = C.result ? countItems(C.result) : 0;
    st.show(h('div', { class: 'big' }, bytesParts(C.freed).value, h('small', null, bytesParts(C.freed).unit)), h('div', { class: 'big-cap' }, t('liberados neste Mac')),
      h('p', { class: 'sub' }, t('Os arquivos continuam no iCloud e baixam de novo quando você abrir.')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => api.revealLog().catch(() => {}) }, icon('log', 15), t('Ver log')),
        left ? h('button', { class: 'btn', type: 'button', onClick: () => { C.phase = 'review'; st = null; render(); } }, icon('search', 15), t('Revisar itens restantes')) : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => { C.phase = 'idle'; C.result = null; render(); } }, t('Concluir'))));
    ctx.setDock(null);
  }

  render();
}
