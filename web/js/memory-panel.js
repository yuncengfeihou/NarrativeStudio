/**
 * memory-panel.js — 记忆系统面板（底部 sheet）
 *
 * 内容：
 *  - 上下文占用环（SVG，蓝→橙→红渐变，中心显示「45% · 90K/200K」）
 *  - 分层记忆堆叠横条（L1 单轮 / L2 篇章 / L3 史诗 / L4 编年）
 *  - 实体档案列表（type icon + name + summary 截断）
 *  - 当前状态卡（time/location/tension/quests/threads…）
 *  - 事实列表（主体-谓词-客体）
 *
 * 数据来源：GET /api/sessions/:id/memory 与 GET /api/sessions/:id
 */

import { el, clear, truncate, fmtTokens, fmtPercent } from './util.js';
import { api } from './api.js';
import { openSheet, toast } from './app.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 创建 SVG 元素（必须用 createElementNS） */
function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, String(v));
  }
  children.flat(Infinity).forEach((c) => { if (c != null) node.appendChild(c); });
  return node;
}

let ringSeq = 0;

/**
 * 构建上下文占用圆环。
 * @param {number} ratio 0-1
 * @param {object} [opts]
 * @returns {HTMLElement} 包裹层（含 SVG + 可选中心文字）
 */
export function buildContextRing(ratio, opts = {}) {
  const {
    size = 96,
    stroke = 9,
    centerPct = null,   // 中心主文字，如 "45%"
    centerSub = null,   // 中心副文字，如 "90K/200K"
    centerClass = 'mem-ring-center',
    pctSize = null,     // 主文字字号覆盖（如导航小环 '10px'）
    subSize = null,     // 副文字字号覆盖
  } = opts;

  const pct = Math.max(0, Math.min(1, Number(ratio) || 0));
  const r = 42;
  const C = 2 * Math.PI * r;
  const gid = `ring-grad-${++ringSeq}`;

  const svg = svgEl('svg', {
    class: 'ring', width: size, height: size, viewBox: '0 0 100 100',
  },
    svgEl('defs', {},
      svgEl('linearGradient', { id: gid, x1: '0%', y1: '0%', x2: '100%', y2: '100%' },
        svgEl('stop', { class: 'stop-blue', offset: '0%' }),
        svgEl('stop', { class: 'stop-orange', offset: '55%' }),
        svgEl('stop', { class: 'stop-red', offset: '100%' }),
      ),
    ),
    svgEl('circle', { class: 'ring-track', cx: 50, cy: 50, r, 'stroke-width': stroke }),
    svgEl('circle', {
      class: 'ring-value', cx: 50, cy: 50, r, 'stroke-width': stroke,
      stroke: `url(#${gid})`,
      'stroke-dasharray': C.toFixed(2),
      'stroke-dashoffset': (C * (1 - pct)).toFixed(2),
    }),
  );

  const wrap = el('div', { class: 'ring-wrap', style: `width:${size}px;height:${size}px;position:relative;` }, svg);
  if (centerPct != null || centerSub != null) {
    wrap.appendChild(el(`div.${centerClass}`, {},
      centerPct != null ? el('div.mem-ring-pct', { style: pctSize ? `font-size:${pctSize};` : '' }, centerPct) : null,
      centerSub != null ? el('div.mem-ring-tokens', { style: subSize ? `font-size:${subSize};` : '' }, centerSub) : null,
    ));
  }
  return wrap;
}

// 实体类型 → 图标 + 颜色
const ENTITY_META = {
  character: { icon: '👤', color: 'var(--sys-blue)' },
  item: { icon: '🔑', color: 'var(--sys-orange)' },
  location: { icon: '📍', color: 'var(--sys-green)' },
  faction: { icon: '🏴', color: 'var(--sys-purple)' },
  event: { icon: '⚡', color: 'var(--sys-red)' },
  concept: { icon: '💡', color: 'var(--sys-teal)' },
};

// 分层记忆 → 名称 + 颜色
const TIER_META = [
  { level: 1, name: 'L1 单轮', color: 'var(--sys-blue)' },
  { level: 2, name: 'L2 篇章', color: 'var(--sys-purple)' },
  { level: 3, name: 'L3 史诗', color: 'var(--sys-orange)' },
  { level: 4, name: 'L4 编年', color: 'var(--sys-red)' },
];

/**
 * 打开记忆面板。
 * @param {string} sessionId
 * @param {object} [initial] 预先获取的数据 {memory, session}（可选，避免重复请求）
 */
export async function openMemoryPanel(sessionId, initial = null) {
  const handle = openSheet({
    title: '记忆系统',
    cancelText: '完成',
    confirmText: '刷新',
    async onConfirm(api2) {
      await renderInto(api2.body, sessionId, null);
      return false; // 保持打开
    },
    render(body, api2) {
      body.appendChild(el('div', { style: 'padding:48px 0;text-align:center;color:var(--label-secondary);' },
        el('span.spinner', { style: 'width:26px;height:26px;border-width:3px;border-color:var(--fill);border-top-color:var(--sys-blue);' }),
      ));
      renderInto(body, sessionId, initial);
    },
  });
  return handle;
}

/** 拉取数据并渲染到容器 */
async function renderInto(container, sessionId, initial) {
  let memory = initial?.memory || null;
  let session = initial?.session || null;
  try {
    if (!memory) memory = await api.getMemory(sessionId);
    if (!session) session = await api.getSession(sessionId).catch(() => null);
  } catch (err) {
    clear(container);
    container.appendChild(el('div', { style: 'padding:40px 24px;text-align:center;color:var(--label-secondary);' },
      el('div', { style: 'font-size:16px;margin-bottom:8px;' }, '无法加载记忆数据'),
      el('div', { style: 'font-size:13px;' }, err.message || String(err)),
    ));
    return;
  }
  clear(container);
  container.appendChild(buildPanel(sessionId, memory, session));
}

/** 本轮检索命中 → 来源标注 */
function retrievalSource(h) {
  if (h.kind === 'turn') return `第 ${h.turn_no} 轮 · 原始记录`;
  if (h.kind === 'summary') return h.turn_from != null ? `第 ${h.turn_from}-${h.turn_to} 轮 · 摘要` : `第 ${h.turn_no} 轮 · 摘要`;
  if (h.kind === 'entity') return `实体档案 · ${h.name || ''}`;
  return '历史';
}

function retrievalKindLabel(kind) {
  return kind === 'turn' ? '原文' : kind === 'summary' ? '摘要' : kind === 'entity' ? '实体' : '历史';
}

function retrievalKindColor(kind) {
  return kind === 'turn' ? 'var(--sys-green)' : kind === 'summary' ? 'var(--sys-blue)' : 'var(--sys-purple)';
}

/** 组装面板内容 */
function buildPanel(sessionId, memory, session) {
  const stats = memory?.stats || {};
  const memStats = session?.memoryStats || {};
  const settings = session?.session?.settings || {};

  const contextTokens = firstNum(stats.context_tokens, memStats.context_tokens, 0);
  const contextMax = firstNum(stats.context_max, memStats.context_max, settings.context_max_tokens, 200000);
  const ratio = contextMax > 0 ? Math.min(1, contextTokens / contextMax) : 0;

  const tiers = normalizeTiers(memory?.tiers || stats.tiers || memStats.tiers || stats.summaries || memStats.summaries);
  const entities = Array.isArray(memory?.entities) ? memory.entities : [];
  const facts = Array.isArray(memory?.facts) ? memory.facts : [];
  const state = pickState(memory?.state, session?.state);

  const root = el('div', { style: 'padding-bottom:12px;' });

  // ---- 上下文占用环 ----
  root.appendChild(el('div.inset-grouped', {},
    el('div.ig-header', {}, '上下文占用'),
    el('div.card', { style: 'margin:0;' },
      el('div.mem-ring-block', {},
        buildContextRing(ratio, {
          size: 96,
          centerPct: fmtPercent(ratio),
          centerSub: `${fmtTokens(contextTokens)}/${fmtTokens(contextMax)}`,
        }),
        el('div.mem-ring-info', {},
          el('div.mem-ring-title', {}, '装配预算'),
          el('div.mem-ring-note', {}, occupancyNote(ratio, contextTokens, contextMax)),
          el('div.row.gap-8', { style: 'margin-top:4px;flex-wrap:wrap;' },
            el('span.chip', {}, `回合 ${firstNum(stats.turn_count, memStats.turn_count, 0)}`),
            el('span.chip', {}, `总 token ${fmtTokens(firstNum(stats.total_tokens, memStats.total_tokens, 0))}`),
            el('span.chip', {}, `实体 ${entities.length || firstNum(stats.entities, memStats.entities, 0)}`),
          ),
        ),
      ),
    ),
  ));

  // ---- 分层记忆堆叠横条 ----
  const totalTierTokens = tiers.reduce((s, t) => s + (t.tokens || 0), 0);
  const totalTierCount = tiers.reduce((s, t) => s + (t.count || 0), 0);
  root.appendChild(el('div.inset-grouped', { style: 'margin-top:20px;' },
    el('div.ig-header', {}, '分层记忆'),
    el('div.tier-bar', {},
      tiers.map((t) => {
        const share = totalTierTokens > 0
          ? (t.tokens || 0) / totalTierTokens
          : (totalTierCount > 0 ? (t.count || 0) / totalTierCount : 1 / tiers.length);
        return el('div.tier-seg', {
          style: `flex:${Math.max(share, 0.001)} 1 0;background:${tierColor(t.level)};`,
          title: `${tierName(t.level)}：${t.count || 0} 条 · ${fmtTokens(t.tokens || 0)} token`,
        }, t.count || 0);
      }),
    ),
    el('div.tier-legend', {},
      tiers.map((t) => el('span.tier-legend-item', {},
        el('span.tier-dot', { style: `background:${tierColor(t.level)};` }),
        `${tierName(t.level)} · ${t.count || 0} 条 / ${fmtTokens(t.tokens || 0)}`,
      )),
    ),
  ));

  // ---- 本轮检索命中（BM25 召回的历史细节） ----
  const retrieval = Array.isArray(memory?.last_retrieval) ? memory.last_retrieval : [];
  if (retrieval.length) {
    root.appendChild(el('div.inset-grouped', { style: 'margin-top:20px;' },
      el('div.ig-header', {}, `本轮检索（${retrieval.length}）`),
      el('div', { style: 'padding:0 16px 6px;font-size:12px;color:var(--label-secondary);line-height:1.5;' },
        '演绎前按当前行动从历史中召回的相关细节：',
      ),
      el('div.ig-list', {}, retrieval.map((h) => el('div.ig-row', { style: 'align-items:flex-start;' },
        el('span', { style: `flex:none;font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px;background:${retrievalKindColor(h.kind)};color:#fff;margin-top:2px;` }, retrievalKindLabel(h.kind)),
        el('div.ig-row-value', { style: 'flex:1;min-width:0;' },
          el('div', { style: 'font-size:12px;color:var(--sys-blue);font-weight:600;margin-bottom:2px;' }, retrievalSource(h)),
          el('div', { style: 'font-size:13px;color:var(--label-secondary);line-height:1.5;' }, truncate(String(h.snippet || ''), 110)),
        ),
      ))),
    ));
  }

  // ---- 实体档案 ----
  root.appendChild(el('div.inset-grouped', { style: 'margin-top:20px;' },
    el('div.ig-header', {}, `实体档案（${entities.length}）`),
    entities.length
      ? el('div.ig-list', {}, entities.slice(0, 40).map((e) => entityRow(e)))
      : el('div.ig-list', {}, el('div.ig-row', {}, el('div.ig-row-value', {}, '暂无实体'))),
  ));

  // ---- 当前状态卡 ----
  root.appendChild(el('div.inset-grouped', { style: 'margin-top:20px;' },
    el('div.ig-header', {}, '当前状态'),
    buildStateGrid(state),
  ));

  // ---- 事实列表 ----
  if (facts.length) {
    root.appendChild(el('div.inset-grouped', { style: 'margin-top:20px;' },
      el('div.ig-header', {}, `事实（${facts.length}）`),
      el('div.ig-list', {}, facts.slice(0, 40).map((f) => el('div.fact-row', {},
        el('span.fact-subject', {}, f.subject || '?'),
        el('span.fact-predicate', {}, `— ${f.predicate || ''} →`),
        el('span.fact-object', {}, f.object || '?'),
      ))),
    ));
  }

  return root;
}

// ============================================================
// 片段构建
// ============================================================

function entityRow(e) {
  const meta = ENTITY_META[e.type] || { icon: '•', color: 'var(--sys-gray)' };
  return el('div.ig-row.entity-row', {},
    el('div.entity-icon', { style: `background:${meta.color};` }, meta.icon),
    el('div.ig-row-body', {},
      el('div.entity-name', {}, e.name || '未命名'),
      e.summary ? el('div.entity-summary', {}, truncate(e.summary, 80)) : null,
    ),
  );
}

function buildStateGrid(state) {
  if (!state || Object.keys(state).length === 0) {
    return el('div.ig-list', {}, el('div.ig-row', {}, el('div.ig-row-value', {}, '暂无状态快照')));
  }
  const cells = [];
  const push = (key, val, full = false) => {
    if (val == null || val === '') return;
    cells.push(el('div.state-cell', { class: full ? 'full' : '' },
      el('div.state-key', {}, key),
      typeof val === 'object' ? val : el('div.state-val', {}, String(val)),
    ));
  };

  push('时间', state.time);
  push('地点', state.location);
  push('天气', state.weather);

  // 张力（0-1 仪表）
  if (typeof state.tension === 'number') {
    cells.push(el('div.state-cell.full', {},
      el('div.state-key', {}, '张力'),
      el('div.tension-meter', {},
        el('div.tension-track', {}, el('div.tension-fill', { style: `width:${Math.round(state.tension * 100)}%;` })),
        el('span', { style: 'font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;' }, fmtPercent(state.tension)),
      ),
    ));
  }

  // 物品
  if (Array.isArray(state.inventory) && state.inventory.length) {
    push('物品', el('div.state-val', { style: 'font-weight:500;' }, state.inventory.join('、')), true);
  }

  // 任务
  if (Array.isArray(state.quests) && state.quests.length) {
    const list = el('div', { style: 'margin-top:3px;display:flex;flex-direction:column;gap:3px;' },
      state.quests.map((q) => el('div', { style: 'font-size:13.5px;line-height:1.4;' },
        el('span', { style: `color:${questColor(q.status)};font-weight:700;` }, questMark(q.status) + ' '),
        q.goal || '（未命名目标）',
        q.progress ? el('span.muted', { style: 'font-size:12.5px;' }, ` · ${q.progress}`) : null,
      )),
    );
    cells.push(el('div.state-cell.full', {},
      el('div.state-key', {}, '任务'),
      list,
    ));
  }

  // 线索 / 悬念
  if (Array.isArray(state.threads) && state.threads.length) {
    push('线索', el('div.state-val', { style: 'font-weight:500;line-height:1.45;' }, state.threads.join('；')), true);
  }
  if (state.last_hook) {
    push('悬念钩子', el('div.state-val', { style: 'font-weight:500;line-height:1.45;color:var(--sys-orange);' }, state.last_hook), true);
  }

  return el('div.state-grid', {}, cells);
}

// ============================================================
// 数据规整辅助
// ============================================================

/** 归一化 tiers：保证 4 层都在，缺失补 0 */
function normalizeTiers(raw) {
  const byLevel = new Map();
  (Array.isArray(raw) ? raw : []).forEach((t) => {
    const level = Number(t.level);
    if (level >= 1 && level <= 4) byLevel.set(level, { level, count: t.count || 0, tokens: t.tokens || 0 });
  });
  return TIER_META.map((m) => byLevel.get(m.level) || { level: m.level, count: 0, tokens: 0 });
}

/** 提取 state 对象（兼容 {turn_no,state} 包装与直接对象） */
function pickState(...candidates) {
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      if (c.state && typeof c.state === 'object') return c.state;
      if ('time' in c || 'location' in c || 'tension' in c) return c;
    }
  }
  return {};
}

function tierName(level) {
  return (TIER_META.find((m) => m.level === level) || {}).name || `L${level}`;
}
function tierColor(level) {
  return (TIER_META.find((m) => m.level === level) || {}).color || 'var(--sys-gray)';
}
function questColor(status) {
  return status === 'done' ? 'var(--sys-green)'
    : status === 'failed' ? 'var(--sys-red)'
    : 'var(--sys-blue)';
}
function questMark(status) {
  return status === 'done' ? '✓' : status === 'failed' ? '✕' : '▶';
}

/** 占用率提示文案 */
function occupancyNote(ratio, tokens, max) {
  const pct = Math.round(ratio * 100);
  if (ratio >= 0.95) return `上下文接近上限（${pct}%），旧剧情将被更强压缩。`;
  if (ratio >= 0.8) return `上下文偏高（${pct}%），记忆系统会优先保留近期回合。`;
  if (ratio >= 0.4) return `上下文健康（${pct}%），可回忆较长历史。`;
  return `上下文宽裕（${pct}%），${fmtTokens(max - tokens)} 余量。`;
}

/** 取第一个有限数字 */
function firstNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export default { openMemoryPanel, buildContextRing };
