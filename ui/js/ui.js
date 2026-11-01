// Shared components: toast, dialogs, tri-state checkbox, round button, stage.
import { h, s, mount, mid } from './dom.js';
import { icon, orb } from './art.js';
import { plural } from './format.js';
import { t, tn, tr } from './i18n.js';

export function toast(msg, kind = 'err') {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: 'toast ' + (kind === 'ok' ? 'ok' : ''), role: 'status' }, icon(kind === 'ok' ? 'check' : 'alert', 16), h('span', null, msg));
  root.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 5200);
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
    // Destructive: initial focus on Cancel, so Enter does not confirm by accident.
    requestAnimationFrame(() => requestAnimationFrame(() => { back.classList.add('in'); btns[danger ? 0 : btns.length - 1].focus({ preventScroll: true }); }));
  });
}

// First button = cancel (value false); last = confirm (true).
// permanentChoice: shows the "Delete permanently" switch (items that would go to Trash). Returns false, true
// or 'permanent' when the switch is on — the caller passes `permanent` on to the removal.
// permanentTitle: dialog title when the switch is on (the caller builds both already translated, e.g. "Move 2 items
// to Trash?" and "Delete 2 items permanently?"); without it, falls back to "Delete permanently?".
// trashCount: how many items of the batch would go to Trash (the rest is deleted directly, like caches); the note speaks
// only of them, so as not to contradict the dialog body in mixed selections.
export function confirmDialog({ title, body, confirm = t('Confirmar'), cancel = t('Cancelar'), danger = false, glyph = 'alert', mod, permanentChoice = false, permanentDefault = false, trashCount = null, permanentTitle = null }) {
  let permanent = permanentChoice && permanentDefault;
  const mixed = trashCount != null && danger;
  const confirmBtn = { label: confirm, value: true, kind: danger ? 'danger' : 'primary' };
  let extra = null;
  if (permanentChoice) {
    const note = h('p', { class: 'perm-note' });
    const paint = (row) => {
      const card = row.closest('.modal');
      if (permanent) {
        note.textContent = trashCount == null ? t('Os itens serão apagados sem passar pelo Lixo. Não dá para desfazer.')
          : tn(trashCount, 'O item recuperável será apagado sem passar pelo Lixo. Não dá para desfazer.', 'Os {n} itens recuperáveis serão apagados sem passar pelo Lixo. Não dá para desfazer.');
      } else {
        note.textContent = trashCount == null ? t('Os itens vão para o Lixo e podem ser recuperados de lá.')
          : tn(trashCount, 'O item recuperável vai para o Lixo e pode ser recuperado de lá.', 'Os {n} itens recuperáveis vão para o Lixo e podem ser recuperados de lá.');
      }
      if (!card) return;
      card.classList.toggle('danger', permanent || danger);
      // The text about Trash no longer applies: title rewritten and body hidden (the note above explains).
      const h3 = card.querySelector('h3'), bodyEl = card.querySelector('.body');
      if (h3) {
        h3.textContent = permanent ? (permanentTitle || t('Apagar definitivamente?')) : title;
      }
      // Body hidden only when it talks solely about Trash; in mixed batches it describes the items already permanent.
      if (bodyEl) bodyEl.hidden = permanent && !mixed;
      const btn = card.querySelector('.btns .btn:last-child');
      if (btn) { btn.textContent = permanent ? t('Apagar definitivamente') : confirm; btn.className = 'btn ' + (permanent || danger ? 'danger' : 'primary'); }
    };
    const row = h('div', { class: 'perm-row' },
      h('div', { class: 'perm-txt' }, h('b', null, t('Apagar definitivamente')), note),
      toggleSwitch(permanent, (on) => { permanent = on; paint(row); }, t('Apagar definitivamente')));
    extra = row;
    requestAnimationFrame(() => paint(row));
  }
  return modal({ title, body, danger, glyph, mod, extra, buttons: [{ label: cancel, value: false }, confirmBtn] }).then((ok) => (ok && permanent ? 'permanent' : ok));
}

// "Start over" discards results and marks: always with confirmation (nothing was removed up to that point).
export function confirmRestart(mod) {
  return confirmDialog({
    title: t('Recomeçar a análise?'), body: t('Os resultados e as marcações atuais serão descartados. Nada foi removido até agora.'),
    confirm: t('Recomeçar'), glyph: 'restart', mod: mod || 'smart',
  });
}

// Top bar of every manager: "‹ Back" + module name on the left; search and sorting (`controls`) on the
// right. The manager footer holds only the selection and the primary action.
// `into`: existing bar to repaint in place (search keeps focus between repaints only if it is not rebuilt).
export function managerBar({ title, subtitle, onBack, controls = [], into = null }) {
  const kids = [
    h('button', { class: 'btn sm ghost mgr-back', type: 'button', title: t('Voltar (Esc)'), onClick: onBack }, icon('back', 14), t('Voltar')),
    h('div', { class: 'rv-title' }, h('h2', null, title), subtitle ? h('p', null, subtitle) : null),
    controls,
  ];
  return into ? mount(into, kids) : h('div', { class: 'rv-head mgr-bar' }, kids);
}

// On/off switch (role=switch), animated.
export function toggleSwitch(on, onChange, label) {
  const b = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': label || '', 'aria-checked': String(!!on) }, h('i'));
  b.addEventListener('click', (e) => { e.stopPropagation(); const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onChange(v); });
  return b;
}

export function failuresSheet(failures) {
  // Failures with the same reason (e.g. leftovers kept because the app was running) become a single card.
  const byReason = new Map();
  for (const f of failures) {
    const k = f.error || '';
    if (!byReason.has(k)) byReason.set(k, []);
    byReason.get(k).push(f);
  }
  const card = (fs, reason) => {
    const one = fs.length === 1 ? fs[0] : null;
    return h('div', { class: 'fail-item' },
      h('span', { class: 'fail-dot', 'aria-hidden': 'true' }, icon('alert', 13)),
      h('div', { class: 'fail-txt' },
        h('b', null, one ? one.name || t('Item') : plural(fs.length, 'item', 'itens')),
        one && one.path ? h('small', { class: 'fail-path', title: one.path }, mid(one.path, 40)) : null,
        one ? null : h('small', { class: 'fail-path' }, fs.map((f) => f.name).filter(Boolean).slice(0, 3).join(' · ') + (fs.length > 3 ? ' …' : '')),
        h('p', { class: 'fail-err' }, reason ? tr(reason) : t('Erro desconhecido'))));
  };
  const list = h('div', { class: 'fail-list' }, [...byReason].map(([reason, fs]) => card(fs, reason)));
  return modal({
    title: t('Alguns itens não foram removidos'),
    body: tn(failures.length, '{n} item não pôde ser removido e continua no lugar.', '{n} itens não puderam ser removidos e continuam no lugar.'),
    glyph: 'alert', extra: list, buttons: [{ label: t('Entendi'), value: true, kind: 'primary' }],
  });
}

// Tri-state checkbox: data-state = on | off | mixed.
export function checkbox(state, onToggle, label) {
  const b = h('button', { class: 'cb', type: 'button', role: 'checkbox', 'aria-label': label || t('Selecionar') }, icon('check', 14), icon('dash', 14));
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
  const wrap = h('div', { class: 'chips', role: 'group', 'aria-label': t('Tamanho mínimo') });
  const btns = options.map((o) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(o.value === value), onClick: () => { btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === o.value))); onChange(o.value); } }, o.label));
  wrap.append(...btns);
  return wrap;
}

// Round button (96px) with a progress ring. A single persistent element in #dock.
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

// Module stage: orb on the left (persistent between phases) + swappable text column.
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
