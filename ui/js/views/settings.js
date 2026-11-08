// Settings: sounds, Sweep scope and ignored list.
import { h, mount, mid } from '../dom.js';
import { icon } from '../art.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { checkbox, segmented } from '../ui.js';
import { setSoundEnabled, play } from '../sound.js';
import { t, applyLangSetting, LANGS } from '../i18n.js';

// Function: the language is only known after the module is loaded.
const scopeList = () => [
  ['junk', t('Entulho')], ['trash', t('Lixeira')], ['protection', t('Segurança')],
  ['performance', t('Velocidade')], ['apps', t('Aplicativos')], ['files', t('Arquivos')],
];

export function enter(ctx) {
  const root = h('div', { class: 'settings' });
  mount(ctx.root, root);
  let s = store.settings, ignored = [], ignErr = false;

  async function save(next) {
    const prev = s;
    s = store.settings = next;
    setSoundEnabled(s.sounds);
    try { await api.saveSettings(s); } catch (e) { s = store.settings = prev; setSoundEnabled(prev.sounds); render(); }
  }

  // The checkbox does not change state by itself: applies the new value on the button itself (keeps focus) before saving.
  const toggle = (label, hint, on, onChange) => {
    const cb = checkbox(on ? 'on' : 'off', (st) => { const v = st !== 'on'; cb.set(v ? 'on' : 'off'); onChange(v); }, label);
    return h('div', { class: 'set-row' },
      h('div', null, h('div', { class: 'set-label' }, label), hint ? h('div', { class: 'set-hint' }, hint) : null), cb);
  };

  // The ignored list has its own box: it changes alone (load, add, remove) without remounting the screen, which
  // would replace the cards mid-entrance.
  const ignBox = h('div');
  const addBtn = h('button', { class: 'btn sm', type: 'button', onClick: addFolder }, t('Adicionar pasta…'));
  function renderIgnored() {
    if (ignErr) return mount(ignBox, h('div', { class: 'set-empty' }, t('Não foi possível carregar a lista de ignorados.')));
    mount(ignBox, ignored.length
      ? h('div', { class: 'ign-list' }, ignored.map((p) => h('div', { class: 'ign-row' },
        h('span', { class: 'ign-path', title: p }, mid(p, 48)),
        h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': t('Parar de ignorar {path}', { path: p }), onClick: (e) => unignore(p, e.currentTarget) }, icon('x', 14), t('Remover')))))
      : h('div', { class: 'set-empty' }, t('Nenhum item ignorado. Clique com o botão direito em um item da revisão para ignorá-lo.')));
  }

  function render() {
    if (!s) return mount(root, h('div', { class: 'set-loading' }, h('span', { class: 'spin' })));
    renderIgnored();
    const scope = s.smartCare || {};
    mount(root,
      h('header', { class: 'set-head' }, h('h1', { class: 'h2' }, t('Ajustes'))),
      h('section', { class: 'set-card' }, h('h3', null, t('Geral')),
        h('div', { class: 'set-row' },
          h('div', null, h('div', { class: 'set-label' }, t('Idioma')), h('div', { class: 'set-hint' }, t('Escolha o idioma da interface.'))),
          segmented(LANGS.map((l) => ({ value: l.id, label: l.label })), s.language || 'en',
            (v) => { save({ ...s, language: v }); applyLangSetting(v); }, t('Idioma'))),
        toggle(t('Reproduzir sons nas ações principais'), t('Ao iniciar e concluir análises e limpezas.'), s.sounds, (v) => { save({ ...s, sounds: v }); if (v) play('found'); }),
        toggle(t('Mostrar na barra de menus'), t('Saúde, espaço livre, memória e Lixeira num relance. Com o ícone ligado, fechar a janela mantém o app aberto na barra de menus.'), !!s.menuBar, (v) => save({ ...s, menuBar: v }))),
      h('section', { class: 'set-card' }, h('h3', null, t('Remoção')),
        toggle(t('Apagar definitivamente por padrão'), t('Arquivos, apps e restos são apagados sem passar pelo Lixo. Cada confirmação ainda deixa você escolher. Caches e registros regeneráveis sempre são apagados direto.'), !!s.permanentDelete, (v) => save({ ...s, permanentDelete: v }))),
      h('section', { class: 'set-card' }, h('h3', null, t('Faxina')),
        h('p', { class: 'set-hint' }, t('Módulos incluídos na análise.')),
        scopeList().map(([k, label]) => toggle(label, null, scope[k] !== false, (v) => save({ ...s, smartCare: { ...scope, [k]: v } })))),
      h('section', { class: 'set-card' }, h('div', { class: 'set-card-head' }, h('h3', null, t('Lista de ignorados')), addBtn),
        h('p', { class: 'set-hint' }, t('Itens ignorados não aparecem em nenhuma análise e nunca são removidos, nem o que estiver dentro deles.')),
        ignBox),
    );
  }

  async function addFolder() {
    try {
      const list = await api.ignoreFolder(t('Escolha uma pasta que o Limpae nunca deve tocar'));
      if (list) { ignored = list; ignErr = false; renderIgnored(); }
    } catch (e) { /* toast already shown */ }
  }

  // The removed row takes its focused button with it: focus moves to the row that takes its place (or the one
  // above), else to "Add folder…", so keyboard users keep their place.
  async function unignore(p, btn) {
    const had = btn && btn === document.activeElement;
    const i = ignored.indexOf(p);
    try { await api.unignore(p); } catch (e) { return; } // toast already shown
    ignored = ignored.filter((x) => x !== p);
    renderIgnored();
    if (!had) return;
    const btns = ignBox.querySelectorAll('.ign-row button');
    (btns[Math.min(i, btns.length - 1)] || addBtn).focus();
  }

  function renderLoadError() {
    mount(root, h('div', { class: 'set-loading' }, h('div', { class: 'set-error' },
      h('p', null, t('Não foi possível ler os ajustes.')),
      h('button', { class: 'btn', type: 'button', onClick: () => { render(); load(); } }, t('Tentar de novo')))));
  }

  // Settings usually come from the store (screen already drawn): then only the ignored list is refreshed.
  // The two reads fail separately: without settings the screen offers a retry; without the ignored list only that box says so.
  async function load() {
    const had = !!s;
    const [rs, ri] = await Promise.allSettled([s ? Promise.resolve(s) : api.settings(), api.ignored()]);
    if (rs.status === 'fulfilled') s = store.settings = rs.value;
    ignErr = ri.status === 'rejected';
    ignored = ignErr ? [] : ri.value || [];
    if (!ctx.alive) return;
    if (!s) return renderLoadError();
    if (had) renderIgnored();
    else { root.classList.add('enter'); render(); } // spinner → cards: they rise instead of popping in
  }

  render();
  load();
}
