// Desempenho: implementado nas fases F2–F6 (placeholder até lá).
import { h, mount } from '../dom.js';
import { stage } from '../ui.js';

export function enter(ctx) {
  const st = stage('perf', 'bolt', 260);
  mount(ctx.root, st.el);
  st.show(h('h1', { class: 'h1' }, 'Desempenho'), h('p', { class: 'sub' }, 'Agentes em segundo plano, itens de login e monitor do sistema.'), h('p', { class: 'sub' }, 'Em desenvolvimento.'));
}
