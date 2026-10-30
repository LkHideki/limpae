// Minha Atividade: implementado nas fases F2–F6 (placeholder até lá).
import { h, mount } from '../dom.js';
import { stage } from '../ui.js';

export function enter(ctx) {
  const st = stage('activity', 'pulse', 260);
  mount(ctx.root, st.el);
  st.show(h('h1', { class: 'h1' }, 'Minha Atividade'), h('p', { class: 'sub' }, 'Saúde do Mac e o espaço que você já recuperou.'), h('p', { class: 'sub' }, 'Em desenvolvimento.'));
}
