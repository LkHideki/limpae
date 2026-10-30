// Componentes compartilhados: toast, diálogos, checkbox tri-state, botão redondo, stage.
import { h, s, mount, mid } from './dom.js';
import { icon, orb } from './art.js';
import { plural } from './format.js';

export function toast(msg, kind = 'err') {
  const root = document.getElementById('toast-root');
  const t = h('div', { class: 'toast ' + (kind === 'ok' ? 'ok' : ''), role: 'status' }, icon(kind === 'ok' ? 'check' : 'alert', 16), h('span', null, msg));
  root.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 5200);
}

function modal({ title, body, buttons, glyph = 'alert', danger = false, mod, extra }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const prev = document.activeElement;
    const titleId = 'm-' + Math.random().toString(36).slice(2, 8);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      back.classList.remove('in');
      back.classList.add('out');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => back.remove(), 260);
      if (prev && prev.focus) prev.focus();
      resolve(v);
    };
    const btns = buttons.map((b) => h('button', { class: 'btn ' + (b.kind || ''), type: 'button', onClick: () => finish(b.value) }, b.label));
    const card = h('div', { class: 'modal' + (danger ? ' danger' : ''), role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, dataset: { mod: mod || 'smart' } },
      h('div', { class: 'modal-glow', 'aria-hidden': 'true' }),
      h('div', { class: 'modal-icon' }, h('i', { class: 'ring', 'aria-hidden': 'true' }), h('div', { class: 'glyph-chip' }, icon(glyph, 26))),
      h('h3', { id: titleId }, title), h('div', { class: 'body' }, body), extra,
      h('div', { class: 'btns' + (btns.length === 1 ? ' single' : '') }, btns));
    const back = h('div', { class: 'modal-back', role: 'presentation', onMouseDown: (e) => { if (e.target === back) finish(buttons[0].value); } }, card);
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); finish(buttons[0].value); }
      else if (e.key === 'Tab') {
        const i = btns.indexOf(document.activeElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    root.append(back);
    // Destrutivo: foco inicial em Cancelar, para Enter não confirmar sem querer.
    requestAnimationFrame(() => requestAnimationFrame(() => { back.classList.add('in'); btns[danger ? 0 : btns.length - 1].focus({ preventScroll: true }); }));
  });
}

// Primeiro botão = cancelar (valor false); último = confirmar (true).
// permanentChoice: mostra a chave "Apagar definitivamente" (itens que iriam para o Lixo). Retorna false, true
// ou 'permanent' quando a chave está ligada — o chamador repassa `permanent` à remoção.
// trashCount: quantos itens do lote iriam para o Lixo (o resto já é apagado direto, como caches); a nota fala
// só deles, para não contradizer o corpo do diálogo em seleções mistas.
export function confirmDialog({ title, body, confirm = 'Confirmar', cancel = 'Cancelar', danger = false, glyph = 'alert', mod, permanentChoice = false, permanentDefault = false, trashCount = null }) {
  let permanent = permanentChoice && permanentDefault;
  const mixed = trashCount != null && danger;
  const confirmBtn = { label: confirm, value: true, kind: danger ? 'danger' : 'primary' };
  let extra = null;
  if (permanentChoice) {
    const note = h('p', { class: 'perm-note' });
    const paint = (row) => {
      const card = row.closest('.modal');
      const who = trashCount == null ? 'Os itens' : trashCount === 1 ? 'O item recuperável' : `Os ${trashCount} itens recuperáveis`;
      const verb = trashCount === 1 ? ['será apagado', 'vai', 'pode ser recuperado'] : ['serão apagados', 'vão', 'podem ser recuperados'];
      note.textContent = permanent ? `${who} ${verb[0]} sem passar pelo Lixo. Não dá para desfazer.` : `${who} ${verb[1]} para o Lixo e ${verb[2]} de lá.`;
      if (!card) return;
      card.classList.toggle('danger', permanent || danger);
      // O texto sobre o Lixo deixa de valer: título reescrito e corpo escondido (a nota acima explica).
      const h3 = card.querySelector('h3'), bodyEl = card.querySelector('.body');
      if (h3) {
        if (!h3.dataset.orig) h3.dataset.orig = h3.textContent;
        const m = /^Mover (.+) para o Lixo\?$/.exec(h3.dataset.orig);
        h3.textContent = permanent ? (m ? `Apagar ${m[1]} definitivamente?` : 'Apagar definitivamente?') : h3.dataset.orig;
      }
      // Corpo escondido só quando ele fala apenas do Lixo; em lotes mistos ele descreve os itens já definitivos.
      if (bodyEl) bodyEl.hidden = permanent && !mixed;
      const btn = card.querySelector('.btns .btn:last-child');
      if (btn) { btn.textContent = permanent ? 'Apagar definitivamente' : confirm; btn.className = 'btn ' + (permanent || danger ? 'danger' : 'primary'); }
    };
    const row = h('div', { class: 'perm-row' },
      h('div', { class: 'perm-txt' }, h('b', null, 'Apagar definitivamente'), note),
      toggleSwitch(permanent, (on) => { permanent = on; paint(row); }, 'Apagar definitivamente'));
    extra = row;
    requestAnimationFrame(() => paint(row));
  }
  return modal({ title, body, danger, glyph, mod, extra, buttons: [{ label: cancel, value: false }, confirmBtn] }).then((ok) => (ok && permanent ? 'permanent' : ok));
}

// Chave liga/desliga (role=switch), animada.
export function toggleSwitch(on, onChange, label) {
  const b = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': label || '', 'aria-checked': String(!!on) }, h('i'));
  b.addEventListener('click', (e) => { e.stopPropagation(); const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onChange(v); });
  return b;
}

export function failuresSheet(failures) {
  // Falhas com o mesmo motivo (ex.: restos mantidos porque o app ficou) viram um cartão só.
  const byReason = new Map();
  for (const f of failures) {
    const k = f.error || 'Erro desconhecido';
    if (!byReason.has(k)) byReason.set(k, []);
    byReason.get(k).push(f);
  }
  const card = (fs, reason) => {
    const one = fs.length === 1 ? fs[0] : null;
    return h('div', { class: 'fail-item' },
      h('span', { class: 'fail-dot', 'aria-hidden': 'true' }, icon('alert', 13)),
      h('div', { class: 'fail-txt' },
        h('b', null, one ? one.name || 'Item' : plural(fs.length, 'item', 'itens')),
        one && one.path ? h('small', { class: 'fail-path', title: one.path }, mid(one.path, 40)) : null,
        one ? null : h('small', { class: 'fail-path' }, fs.map((f) => f.name).filter(Boolean).slice(0, 3).join(' · ') + (fs.length > 3 ? ' …' : '')),
        h('p', { class: 'fail-err' }, reason)));
  };
  const list = h('div', { class: 'fail-list' }, [...byReason].map(([reason, fs]) => card(fs, reason)));
  return modal({
    title: 'Alguns itens não foram removidos',
    body: `${plural(failures.length, 'item não pôde', 'itens não puderam')} ser removido${failures.length === 1 ? '' : 's'} e continua${failures.length === 1 ? '' : 'm'} no lugar.`,
    glyph: 'alert', extra: list, buttons: [{ label: 'Entendi', value: true, kind: 'primary' }],
  });
}

// Checkbox tri-state: data-state = on | off | mixed.
export function checkbox(state, onToggle, label) {
  const b = h('button', { class: 'cb', type: 'button', role: 'checkbox', 'aria-label': label || 'Selecionar' }, icon('check', 14), icon('dash', 14));
  b.set = (st) => {
    if (b.dataset.state && b.dataset.state !== st) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
    b.dataset.state = st; b.setAttribute('aria-checked', st === 'mixed' ? 'mixed' : String(st === 'on'));
  };
  b.set(state);
  b.addEventListener('click', (e) => { e.stopPropagation(); onToggle(b.dataset.state, e); });
  return b;
}

export function segmented(options, value, onChange, label) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const btns = options.map((o) => h('button', { type: 'button', 'aria-pressed': String(o.value === value), onClick: () => { btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === o.value))); onChange(o.value); } }, o.label));
  wrap.append(...btns);
  return wrap;
}

export function chipRow(options, value, onChange) {
  const wrap = h('div', { class: 'chips', role: 'group', 'aria-label': 'Tamanho mínimo' });
  const btns = options.map((o) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(o.value === value), onClick: () => { btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === o.value))); onChange(o.value); } }, o.label));
  wrap.append(...btns);
  return wrap;
}

// Botão redondo (96px) com anel de progresso. Um único elemento persistente no #dock.
export function createGo(host) {
  const R = 52, C = 2 * Math.PI * R;
  const ring = s('svg', { class: 'go-ring', viewBox: '0 0 114 114', 'aria-hidden': 'true' },
    s('circle', { class: 'track', cx: 57, cy: 57, r: R }), s('circle', { class: 'arc', cx: 57, cy: 57, r: R, 'stroke-dashoffset': 0 }));
  const label = h('span', { class: 'go-label' });
  const btn = h('button', { class: 'go', type: 'button' }, ring, label);
  let handler = null;
  btn.addEventListener('click', () => handler && handler());
  host.append(btn);
  return {
    set(cfg) {
      if (!cfg) { host.classList.add('off'); btn.disabled = true; handler = null; return; }
      host.classList.remove('off');
      label.textContent = cfg.label;
      btn.setAttribute('aria-label', cfg.label);
      btn.disabled = !!cfg.disabled;
      handler = cfg.onClick;
      host.dataset.mod = cfg.mod || 'smart';
      btn.classList.toggle('busy', !!cfg.busy);
      const det = cfg.progress != null;
      btn.classList.toggle('det', det);
      btn.querySelector('.arc').setAttribute('stroke-dashoffset', det ? String(C * (1 - cfg.progress)) : '0');
    },
  };
}

// Palco de módulo: orb à esquerda (persistente entre fases) + coluna de texto trocável.
export function stage(mod, glyph, size = 260) {
  const art = orb(mod, size, glyph);
  const text = h('div', { class: 'stage-text' });
  const el = h('div', { class: 'stage', dataset: { mod } }, h('div', { class: 'stage-art' }, art), text);
  return {
    el, art, text,
    show(...nodes) { mount(text, h('div', { class: 'enter' }, nodes)); },
    busy(b) { art.classList.toggle('busy', b); },
  };
}

export function features(mod, items) {
  return h('ul', { class: 'feats' }, items.map(([ic, txt]) => h('li', null, h('span', { class: 'feat-chip' }, icon(ic, 17)), txt)));
}
