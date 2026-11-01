// Saúde: saúde do Mac, recomendações e o que o Limpae já liberou (lido do registro de ações).
import { h, s, mount } from '../dom.js';
import { icon } from '../art.js';
import { api, call } from '../api.js';
import { bytesParts, fmtBytes, fmtNum, pct, plural } from '../format.js';
import { t, tn, tr, lazyIntl } from '../i18n.js';

const getHealth = () => call('health', undefined, { quiet: true });
const getActivity = () => call('activity', undefined, { quiet: true });

// Chaves = nível em português como o backend envia (decisão lógica); o texto exibido é traduzido na hora.
const LEVELS = {
  'Excelente': { key: 'excelente', text: () => t('Seu Mac está ótimo. Mantenha a manutenção em dia para ele continuar assim.') }, // i18n-ignore
  'Boa': { key: 'boa', text: () => t('Seu Mac está em boa forma. Alguns cuidados deixam o desempenho ainda melhor.') }, // i18n-ignore
  'Regular': { key: 'regular', text: () => t('Seu Mac está bem, mas algumas manutenções são recomendadas para evitar lentidão.') }, // i18n-ignore
  'Requer atenção': { key: 'atencao', text: () => t('Seu Mac não está bem. Siga as recomendações para ele voltar ao normal.') }, // i18n-ignore
  'Crítica': { key: 'critica', text: () => t('Recomendamos agir agora para o Mac voltar ao normal.') }, // i18n-ignore
};
const SEV_ICON = { critical: 'alert', warn: 'alert', info: 'clock' };
const shortDateFmt = lazyIntl('DateTimeFormat', { day: 'numeric', month: 'short' });

function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

// "hoje", "ontem", "há 5 dias", "há 2 meses" (por dia do calendário, não por 24 h).
export function relativeDays(unixSec, now = new Date()) {
  const days = Math.round((dayStart(now) - dayStart(new Date(unixSec * 1000))) / 86400000);
  if (days <= 0) return t('hoje');
  if (days === 1) return t('ontem');
  if (days < 60) return t('há {n} dias', { n: days });
  const months = Math.floor(days / 30.44);
  return months < 24 ? tn(months, 'há {n} mês', 'há {n} meses') : tn(Math.floor(months / 12), 'há {n} ano', 'há {n} anos');
}

const shortDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return shortDateFmt.format(new Date(y, m - 1, d)); };

// Anel de pontuação: trilho + arco proporcional ao score, na cor do nível.
function ring(score) {
  const R = 84, C = 2 * Math.PI * R;
  const arc = s('circle', { class: 'ring-arc', cx: 100, cy: 100, r: R, 'stroke-dasharray': C.toFixed(1), 'stroke-dashoffset': C.toFixed(1), transform: 'rotate(-90 100 100)' });
  const svg = s('svg', { class: 'act-ring', viewBox: '0 0 200 200', role: 'img', 'aria-label': t('Pontuação de saúde: {score} de 100', { score }) },
    s('defs', null, s('linearGradient', { id: 'ring-g', x1: 0, y1: 0, x2: 1, y2: 1 }, s('stop', { class: 'g1', offset: 0 }), s('stop', { class: 'g2', offset: 1 }))),
    s('circle', { class: 'ring-track', cx: 100, cy: 100, r: R }), arc);
  requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', (C * (1 - score / 100)).toFixed(1))));
  return svg;
}

function healthCard(hl) {
  const lv = LEVELS[hl.level] || LEVELS['Boa'];
  const used = Math.max(0, hl.diskTotal - hl.diskFree);
  const usedPct = pct(used, hl.diskTotal);
  const low = hl.diskTotal > 0 && hl.diskFree / hl.diskTotal < 0.1;
  return h('section', { class: 'act-card act-health', dataset: { level: lv.key }, 'aria-label': t('Saúde do Mac') },
    h('div', { class: 'ah-top' },
      h('div', { class: 'ah-text' },
        h('div', { class: 'ah-cap' }, t('Saúde do Mac:')),
        h('div', { class: 'ah-level' }, tr(hl.level)),
        h('div', { class: 'ah-model' }, hl.model ? tr(hl.model) : 'Mac')),
      h('div', { class: 'ah-ring' }, ring(hl.score), h('div', { class: 'ah-score' }, h('b', { class: 'num' }, String(hl.score)), h('small', null, t('de 100'))))),
    h('p', { class: 'ah-blurb' }, lv.text()),
    hl.diskTotal > 0 ? h('div', { class: 'ah-disk' + (low ? ' low' : '') },
      h('div', { class: 'ahd-top' }, h('b', null, 'Macintosh HD'), h('span', { class: 'num' }, t('{used} de {total} em uso', { used: fmtBytes(used), total: fmtBytes(hl.diskTotal) }))),
      h('div', { class: 'ahd-bar', role: 'img', 'aria-label': t('{pct}% do disco em uso, {free} livres', { pct: Math.round(usedPct), free: fmtBytes(hl.diskFree) }) }, h('i', { style: `width:${usedPct}%` }))) : null);
}

function recommendations(ctx, hl) {
  const list = hl.factors || [];
  const go = (a) => {
    if (a.module === 'fda') api.openFda().catch(() => {});
    else ctx.nav(a.module);
  };
  return h('section', { class: 'act-recs', 'aria-label': t('Recomendações') },
    h('h2', { class: 'act-h' }, list.length ? plural(list.length, 'recomendação', 'recomendações') : t('Recomendações')),
    list.length
      ? h('ul', { class: 'rec-list' }, list.map((f) => h('li', { class: 'rec', dataset: { sev: f.severity } },
        h('span', { class: 'rec-ic', 'aria-hidden': 'true' }, icon(SEV_ICON[f.severity] || 'alert', 18)),
        h('div', { class: 'rec-main' }, h('b', null, tr(f.title)), h('p', null, tr(f.detail))),
        f.action ? h('button', { class: 'btn sm', type: 'button', onClick: () => go(f.action) }, tr(f.action.label)) : null)))
      : h('div', { class: 'rec-ok' }, h('span', { class: 'rec-ic ok', 'aria-hidden': 'true' }, icon('check', 18)), h('div', null, h('b', null, t('Tudo certo por aqui')), h('p', null, t('Nenhuma recomendação no momento. Continue cuidando do Mac com regularidade.')))));
}

// Sparkline em SVG: área + linha dos últimos 30 dias, com um alvo (<title>) por dia para o tooltip nativo.
function sparkline(days) {
  const W = 300, H = 72, PAD = 6;
  const max = Math.max(...days.map((d) => d.bytes), 1);
  const x = (i) => PAD + (i * (W - 2 * PAD)) / (days.length - 1);
  const y = (v) => H - PAD - (v / max) * (H - 2 * PAD - 4);
  const pts = days.map((d, i) => [x(i), y(d.bytes)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${H - PAD} L${pts[0][0].toFixed(1)} ${H - PAD} Z`;
  const total = days.reduce((a, d) => a + d.bytes, 0);
  const step = (W - 2 * PAD) / (days.length - 1);
  const last = pts[pts.length - 1];
  return s('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': t('Espaço liberado nos últimos 30 dias: {size}', { size: fmtBytes(total) }) },
    s('defs', null, s('linearGradient', { id: 'spark-g', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { class: 'a1', offset: 0 }), s('stop', { class: 'a2', offset: 1 }))),
    s('line', { class: 'spark-base', x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD }),
    s('path', { class: 'spark-area', d: area }), s('path', { class: 'spark-line', d: line }),
    s('circle', { class: 'spark-dot', cx: last[0], cy: last[1], r: 3.2 }),
    days.map((d, i) => s('rect', { class: 'spark-hit', x: Math.max(0, x(i) - step / 2), y: 0, width: step, height: H }, s('title', null, d.bytes ? t('{date}: {size}', { date: shortDate(d.date), size: fmtBytes(d.bytes) }) : t('{date}: nada liberado', { date: shortDate(d.date) })))));
}

function statCards(ctx, a) {
  const goSmart = () => ctx.nav('smart');
  if (!a.items) {
    return [
      h('section', { class: 'act-card act-stat act-empty' },
        h('span', { class: 'as-ic', 'aria-hidden': 'true' }, icon('smart', 22)),
        h('h3', null, t('Nenhuma limpeza ainda')),
        h('p', null, t('Comece pela Faxina para ver aqui quantos GB você libera, mês a mês.')),
        h('button', { class: 'btn primary sm', type: 'button', onClick: goSmart }, t('Ir para a Faxina'))),
      h('section', { class: 'act-card act-spark empty' },
        h('div', { class: 'asp-top' }, h('h3', null, t('Últimos 30 dias'))),
        h('div', { class: 'asp-empty' }, t('O gráfico aparece depois da primeira limpeza.'))),
    ];
  }
  const tot = bytesParts(a.totalFreed);
  const total30 = a.days.reduce((n, d) => n + d.bytes, 0);
  const sc = a.lastSmartCare ? relativeDays(a.lastSmartCare) : null;
  return [
    h('section', { class: 'act-card act-stat', 'aria-label': t('Espaço liberado') },
      h('div', { class: 'as-cap' }, t('Liberado no total')),
      h('div', { class: 'as-big' }, h('b', { class: 'num' }, tot.value), h('small', null, tot.unit)),
      h('div', { class: 'as-sub' }, t('Este mês:'), ' ', h('b', { class: 'num' }, fmtBytes(a.monthFreed)))),
    h('section', { class: 'act-card act-stat', 'aria-label': t('Itens e última limpeza') },
      h('div', { class: 'as-cap' }, t('Itens limpos')),
      h('div', { class: 'as-big' }, h('b', { class: 'num' }, fmtNum(a.items))),
      h('div', { class: 'as-sub stack' }, t('Última limpeza'), h('b', null, a.lastCleanup ? relativeDays(a.lastCleanup) : '—')),
      h('div', { class: 'as-sub stack' }, t('Faxina'), h('b', null, sc || t('nunca')))),
    h('section', { class: 'act-card act-spark', 'aria-label': t('Últimos 30 dias') },
      h('div', { class: 'asp-top' }, h('h3', null, t('Últimos 30 dias')), h('span', { class: 'num' }, total30 ? t('{size} liberados', { size: fmtBytes(total30) }) : t('Nada liberado'))),
      total30 ? sparkline(a.days) : h('div', { class: 'asp-empty' }, t('Nenhuma limpeza nos últimos 30 dias.')),
      h('div', { class: 'asp-axis' }, h('span', null, shortDate(a.days[0].date)), h('span', null, t('hoje')))),
  ];
}

export function enter(ctx) {
  const healthBox = h('div', { class: 'act-health-box' }, h('section', { class: 'act-card act-health loading' }, h('span', { class: 'spin' }), t('Verificando o Mac…')));
  const statsBox = h('div', { class: 'act-stats' });
  const recsBox = h('div', { class: 'act-recs-box' });
  mount(ctx.root, h('div', { class: 'act' },
    h('header', { class: 'set-head' }, h('h1', { class: 'h2' }, t('Saúde'))),
    h('div', { class: 'act-grid' }, healthBox, statsBox),
    recsBox));

  getHealth().then((hl) => {
    if (!ctx.alive) return;
    mount(healthBox, healthCard(hl));
    mount(recsBox, recommendations(ctx, hl));
  }).catch(() => {
    if (!ctx.alive) return;
    mount(healthBox, h('section', { class: 'act-card act-health loading' }, t('Não foi possível avaliar a saúde do Mac agora.')));
  });

  getActivity().then((a) => {
    if (ctx.alive) mount(statsBox, statCards(ctx, a));
  }).catch(() => {
    if (ctx.alive) mount(statsBox, h('section', { class: 'act-card act-stat act-empty' }, h('h3', null, t('Histórico indisponível')), h('p', null, t('Não foi possível ler o registro de ações.'))));
  });
}
