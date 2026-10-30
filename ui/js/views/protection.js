// Proteção: implementado nas fases F2–F6 (placeholder até lá).
import { h, mount } from '../dom.js';
import { stage } from '../ui.js';

export function enter(ctx) {
  const st = stage('protect', 'shield', 260);
  mount(ctx.root, st.el);
  st.show(h('h1', { class: 'h1' }, 'Proteção'), h('p', { class: 'sub' }, 'Verificação de segurança do Mac, persistência e privacidade.'), h('p', { class: 'sub' }, 'Em desenvolvimento.'));
}
