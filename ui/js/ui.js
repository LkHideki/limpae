// Componentes compartilhados: toast, diálogos, checkbox tri-state, botão redondo, stage.
import { h, s, mount } from './dom.js';
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
    const finish = (v) => {
      back.classList.remove('in');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => back.remove(), 240);
      if (prev && prev.focus) prev.focus();
      resolve(v);
    };
    const btns = buttons.map((b) => h('button', { class: 'btn ' + (b.kind || ''), type: 'button', onClick: () => finish(b.value) }, b.label));
    const card = h('div', { class: 'modal' + (danger ? ' danger' : ''), role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, dataset: { mod: mod || 'smart' } },
      h('div', { class: 'glyph-chip' }, icon(glyph, 22)),
      h('h3', { id: titleId }, title), h('div', { class: 'body' }, body), extra, h('div', { class: 'btns' }, btns));
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
    requestAnimationFrame(() => { back.classList.add('in'); btns[btns.length - 1].focus(); });
  });
}

// Primeiro botão = cancelar (valor false); último = confirmar (true).
export function confirmDialog({ title, body, confirm = 'Confirmar', cancel = 'Cancelar', danger = false, glyph = 'alert', mod }) {
  return modal({ title, body, danger, glyph, mod, buttons: [{ label: cancel, value: false }, { label: confirm, value: true, kind: danger ? 'danger' : 'primary' }] });
}

export function failuresSheet(failures) {
  const list = h('div', { class: 'fail-list' }, failures.map((f) => h('div', { class: 'fail-item' }, h('b', { title: f.path || '' }, f.name || f.path || 'Item'), h('span', null, f.error || 'Erro desconhecido'))));
  return modal({
    title: 'Alguns itens não foram removidos',
    body: `${plural(failures.length, 'item não pôde', 'itens não puderam')} ser removido${failures.length === 1 ? '' : 's'} e continua${failures.length === 1 ? '' : 'm'} no lugar.`,
    glyph: 'alert', extra: list, buttons: [{ label: 'Entendi', value: true, kind: 'primary' }],
  });
}

// Checkbox tri-state: data-state = on | off | mixed.
export function checkbox(state, onToggle, label) {
  const b = h('button', { class: 'cb', type: 'button', role: 'checkbox', 'aria-label': label || 'Selecionar' }, icon('check', 14), icon('dash', 14));
  b.set = (st) => { b.dataset.state = st; b.setAttribute('aria-checked', st === 'mixed' ? 'mixed' : String(st === 'on')); };
  b.set(state);
  b.addEventListener('click', (e) => { e.stopPropagation(); onToggle(b.dataset.state); });
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
