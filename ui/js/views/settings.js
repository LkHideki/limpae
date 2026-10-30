// Ajustes: sons, escopo do Faxina e lista de ignorados.
import { h, mount, mid } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { checkbox, toast } from '../ui.js';
import { setSoundEnabled, play } from '../sound.js';

const SCOPE = [
  ['junk', 'Limpeza'], ['trash', 'Lixeira'], ['protection', 'Proteção'],
  ['performance', 'Desempenho'], ['apps', 'Aplicativos'], ['files', 'Meus Arquivos'],
];

export function enter(ctx) {
  const root = h('div', { class: 'settings' });
  mount(ctx.root, root);
  let s = store.settings, ignored = [];

  async function save(next) {
    const prev = s;
    s = store.settings = next;
    setSoundEnabled(s.sounds);
    try { await api.saveSettings(s); } catch (e) { s = store.settings = prev; setSoundEnabled(prev.sounds); render(); }
  }

  const toggle = (label, hint, on, onChange) => h('div', { class: 'set-row' },
    h('div', null, h('div', { class: 'set-label' }, label), hint ? h('div', { class: 'set-hint' }, hint) : null),
    checkbox(on ? 'on' : 'off', (st) => onChange(st !== 'on'), label));

  function render() {
    if (!s) return mount(root, h('div', { class: 'set-loading' }, h('span', { class: 'spin' })));
    const scope = s.smartCare || {};
    mount(root,
      h('header', { class: 'set-head' }, h('h1', { class: 'h2' }, 'Ajustes')),
      h('section', { class: 'set-card' }, h('h3', null, 'Geral'),
        toggle('Reproduzir sons nas ações principais', 'Ao iniciar e concluir análises e limpezas.', s.sounds, (v) => { save({ ...s, sounds: v }); if (v) play('found'); })),
      h('section', { class: 'set-card' }, h('h3', null, 'Faxina'),
        h('p', { class: 'set-hint' }, 'Módulos incluídos na análise.'),
        SCOPE.map(([k, label]) => toggle(label, null, scope[k] !== false, (v) => save({ ...s, smartCare: { ...scope, [k]: v } })))),
      h('section', { class: 'set-card' }, h('h3', null, 'Lista de ignorados'),
        h('p', { class: 'set-hint' }, 'Itens ignorados não aparecem em nenhuma análise. As mudanças valem na próxima análise.'),
        ignored.length
          ? h('div', { class: 'ign-list' }, ignored.map((p) => h('div', { class: 'ign-row' },
            h('span', { class: 'ign-path', title: p }, mid(p, 48)),
            h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `Parar de ignorar ${p}`, onClick: () => unignore(p) }, icon('x', 14), 'Remover'))))
          : h('div', { class: 'set-empty' }, 'Nenhum item ignorado. Clique com o botão direito em um item da revisão para ignorá-lo.')),
    );
  }

  async function unignore(p) {
    try { await api.unignore(p); ignored = ignored.filter((x) => x !== p); render(); } catch (e) { /* toast já exibido */ }
  }

  async function load() {
    try {
      const [st, ig] = await Promise.all([s ? Promise.resolve(s) : api.settings(), api.ignored()]);
      s = store.settings = st; ignored = ig;
    } catch (e) { toast('Não foi possível ler os ajustes.'); }
    if (ctx.alive) render();
  }

  render();
  load();
}
