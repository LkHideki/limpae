// Disk Map: implementado nas fases F2–F6 (placeholder até lá).
import { h, mount } from '../dom.js';
import { stage } from '../ui.js';

export function enter(ctx) {
  const st = stage('lens', 'lens', 260);
  mount(ctx.root, st.el);
  st.show(h('h1', { class: 'h1' }, 'Disk Map'), h('p', { class: 'sub' }, 'Veja o que ocupa espaço em um mapa navegável.'), h('p', { class: 'sub' }, 'Em desenvolvimento.'));
}
