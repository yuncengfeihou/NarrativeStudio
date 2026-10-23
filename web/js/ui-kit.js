/**
 * ui-kit.js — 复用的 UI 片段
 *
 * 这里只放「多个视图都要用」的东西：token 遥测条、环形进度、区块标题、
 * 空状态、色相工具。视图专属的 DOM 留在各自文件里。
 */

import { el, fmtTokens, fmtPercent, fmtNumber, fmtDuration } from './util.js';
import { icon } from './icons.js';

/* =========================================================================
 * 色相工具
 * ========================================================================= */

/**
 * 由色相生成一个「纸感」底色——低饱和、低亮度差。
 * 之前的高饱和渐变会让整个界面显得很吵；这里只求能区分不同世界卡。
 */
export function hueTint(hue, { s = 26, l = 32, alpha = 1 } = {}) {
  const h = ((Number(hue) || 210) % 360 + 360) % 360;
  return `hsla(${h.toFixed(0)}, ${s}%, ${l}%, ${alpha})`;
}

export function hueGlyph(hue) {
  return { background: hueTint(hue, { s: 30, l: 38 }) };
}

/* =========================================================================
 * 环形进度
 * ========================================================================= */

let ringSeq = 0;

export function buildRing(ratio, opts = {}) {
  const { size = 40, stroke = 3, center = null, centerSize = null, sub = null, color = null } = opts;
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0));
  const R = 42;
  const C = 2 * Math.PI * R;
  const gid = `rg${++ringSeq}`;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.style.transform = 'rotate(-90deg)';
  svg.style.display = 'block';

  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', '50'); track.setAttribute('cy', '50');
  track.setAttribute('r', String(R));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'var(--line)');
  track.setAttribute('stroke-width', String(stroke));
  svg.appendChild(track);

  const val = document.createElementNS(NS, 'circle');
  val.setAttribute('cx', '50'); val.setAttribute('cy', '50');
  val.setAttribute('r', String(R));
  val.setAttribute('fill', 'none');
  val.setAttribute('stroke', color || 'var(--accent)');
  val.setAttribute('stroke-width', String(stroke));
  val.setAttribute('stroke-linecap', 'round');
  val.setAttribute('stroke-dasharray', C.toFixed(2));
  val.setAttribute('stroke-dashoffset', (C * (1 - pct)).toFixed(2));
  val.style.transition = 'stroke-dashoffset 0.4s cubic-bezier(0.4,0,0.2,1)';
  svg.appendChild(val);

  const wrap = el('div.ring-wrap', { style: `width:${size}px;height:${size}px;` }, svg);
  if (center != null || sub != null) {
    wrap.appendChild(el('div.ring-center', {},
      center != null ? el('div.ring-pct', { style: centerSize ? `font-size:${centerSize};` : '' }, center) : null,
      sub != null ? el('div.ring-sub', {}, sub) : null,
    ));
  }
  return wrap;
}

/* =========================================================================
 * Token 遥测
 * ========================================================================= */

/**
 * 单轮遥测条。
 *
 * 展示四件事（用户要求的「首字/用时/tokens/速度」）：
 *   首字延迟 · 总用时 · 输入/输出 tokens · 生成速度
 * 缓存率只在有数据时出现。
 *
 * @param {object|null} usage  来自 narrator 的 usage 对象
 * @param {{session?:object, compact?:boolean}} [opts]
 */
export function usageBar(usage, opts = {}) {
  const { compact = false } = opts;
  if (!usage) return el('div.usage-bar.is-empty', {}, '—');

  const items = [];

  if (usage.ttft_ms != null) {
    items.push(stat('首字', fmtDuration(usage.ttft_ms)));
  }
  if (usage.duration_ms != null) {
    items.push(stat('用时', fmtDuration(usage.duration_ms)));
  }
  items.push(stat('输入', fmtTokens(usage.prompt_tokens || 0)));
  items.push(stat('输出', fmtTokens(usage.completion_tokens || 0)));
  if (usage.tps != null) {
    items.push(stat('速度', `${usage.tps} tok/s`));
  }
  if (usage.cache_rate != null && usage.cached_tokens > 0) {
    items.push(stat('缓存', fmtPercent(usage.cache_rate, 0), 'is-ok'));
  }

  const bar = el('div.usage-bar', { class: compact ? 'is-compact' : '' });
  items.forEach((it, i) => {
    if (i > 0) bar.appendChild(el('span.usage-sep'));
    bar.appendChild(it);
  });

  bar.title = [
    `首字延迟：${usage.ttft_ms != null ? fmtDuration(usage.ttft_ms) : '—'}`,
    `总用时：${usage.duration_ms != null ? fmtDuration(usage.duration_ms) : '—'}`,
    `输入 ${fmtNumber(usage.prompt_tokens || 0)} tok`,
    `输出 ${fmtNumber(usage.completion_tokens || 0)} tok`,
    usage.cached_tokens ? `其中缓存命中 ${fmtNumber(usage.cached_tokens)} tok` : '未命中缓存',
    usage.reasoning_tokens ? `推理占用 ${fmtNumber(usage.reasoning_tokens)} tok` : '',
    usage.tps != null ? `生成速度 ${usage.tps} tok/s` : '',
  ].filter(Boolean).join('\n');

  return bar;
}

function stat(label, value, cls = '') {
  return el('span.usage-stat', { class: cls },
    el('span.usage-key', {}, label),
    el('span.usage-val', {}, value),
  );
}

/**
 * 会话级遥测汇总。用户要求的「整个剧情会话的 tokens + 缓存率」。
 * @param {object|null} usage sessions.usage_json
 */
export function sessionUsageSummary(usage) {
  if (!usage || !usage.requests) {
    return el('div.session-usage', {},
      el('div.session-usage-empty', {}, '还没有完成任何一轮演绎。'),
    );
  }
  const totalIn = usage.prompt_tokens || 0;
  const totalOut = usage.completion_tokens || 0;
  const cached = usage.cached_tokens || 0;
  const cacheRate = totalIn > 0 ? cached / totalIn : 0;
  const avgTtft = usage.requests > 0 ? usage.first_token_ms / usage.requests : null;
  const avgTps = usage.total_ms > 0
    ? Math.round(((totalOut - (usage.reasoning_tokens || 0)) / (usage.total_ms / 1000)) * 10) / 10
    : null;

  return el('div.session-usage', {},
    el('div.session-usage-grid', {},
      big('总请求', fmtNumber(usage.requests), '轮'),
      big('总输入', fmtTokens(totalIn), 'tok'),
      big('总输出', fmtTokens(totalOut), 'tok'),
      big('平均首字', avgTtft != null ? fmtDuration(avgTtft) : '—', ''),
      big('平均速度', avgTps != null ? `${avgTps}` : '—', 'tok/s'),
      big('缓存命中率', fmtPercent(cacheRate, 1), ''),
    ),
    el('div.session-usage-bar', {},
      el('div.session-usage-fill', { style: `width:${Math.min(100, cacheRate * 100).toFixed(1)}%;` }),
    ),
    el('div.session-usage-note', {},
      `缓存命中 ${fmtNumber(cached)} / ${fmtNumber(totalIn)} tok`,
      usage.reasoning_tokens ? ` · 其中推理过程占用 ${fmtNumber(usage.reasoning_tokens)} tok` : '',
      ` · 累计生成 ${fmtNumber(usage.output_chars || 0)} 字`,
    ),
  );
}

function big(label, value, unit) {
  return el('div.session-usage-cell', {},
    el('div.session-usage-label', {}, label),
    el('div.session-usage-value', {},
      value,
      unit ? el('span.session-usage-unit', {}, unit) : null,
    ),
  );
}

/* =========================================================================
 * 小部件
 * ========================================================================= */

/** 带标题的区块 */
export function section(title, children, action = null) {
  return el('div.sect-wrap', {},
    el('div.sect', {},
      el('span.sect-title', {}, title),
      action,
    ),
    ...(Array.isArray(children) ? children : [children]),
  );
}

/** 空态 */
export function emptyState({ iconName = 'info', title = '', sub = '', action = null } = {}) {
  return el('div.empty', {},
    el('div.empty-icon', {}, icon(iconName, { size: 18 })),
    title ? el('div.empty-title', {}, title) : null,
    sub ? el('div.empty-sub', {}, sub) : null,
    action,
  );
}

/** 键值对列表项 */
export function infoRow(label, value, sub = null) {
  return el('div.li', {},
    el('div.li-body', {},
      el('div.li-title', {}, label),
      sub ? el('div.li-sub', {}, sub) : null,
    ),
    el('div.li-value', {}, value),
  );
}

/** 开关行 */
export function toggleRow(label, desc, initial, onChange) {
  let on = initial;
  const sw = el('div.switch', { role: 'switch', 'aria-checked': String(on), tabindex: '0' },
    el('div.switch-knob'));
  const toggle = () => {
    on = !on;
    sw.setAttribute('aria-checked', String(on));
    onChange(on);
  };
  sw.addEventListener('click', toggle);
  sw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  return el('div.li', {},
    el('div.li-body', {},
      el('div.li-title', {}, label),
      desc ? el('div.li-sub', {}, desc) : null,
    ),
    sw,
  );
}

/** 色调标签 */
export const TONE = {
  激进: 'is-danger',
  谨慎: 'is-accent',
  探索: 'is-ok',
  情感: 'is-warn',
  智取: 'is-plain',
  诡道: 'is-plain',
};

export function toneChip(tone) {
  return el('span.chip', { class: TONE[tone] || 'is-plain' }, tone || '行动');
}
