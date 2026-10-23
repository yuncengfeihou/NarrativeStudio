/**
 * util.js — 通用工具函数集合
 * 纯函数，无副作用，供各视图模块复用。
 * 约定：所有 DOM 创建尽量走 el()，避免 innerHTML 拼接带来的 XSS 风险；
 *       需要插入 HTML 片段时（如富文本渲染）先 escapeHtml 再处理。
 */

/** querySelector 简写 */
export const $ = (selector, root = document) => root.querySelector(selector);

/** querySelectorAll → 真数组 */
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * 创建一个 DOM 元素。
 * @param {string} tag  标签名，支持 'div.foo#bar' 简写
 * @param {object} [attrs] 属性对象；on* 视为事件监听，class/dataset/style 特殊处理
 * @param  {...any} children 子节点：字符串/Node/数组/null 均可，null/undefined 忽略
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  let tagName = tag;
  let id = null;
  const classes = [];
  // 解析 'tag.cls1.cls2#id' 简写
  const m = /^([a-zA-Z0-9]+)?((?:[.#][^.#]+)*)$/.exec(tag);
  if (m) {
    if (m[1]) tagName = m[1];
    if (m[2]) {
      for (const token of m[2].match(/[.#][^.#]+/g) || []) {
        if (token[0] === '.') classes.push(token.slice(1));
        else id = token.slice(1);
      }
    }
  }
  const node = document.createElement(tagName || 'div');
  if (id) node.id = id;
  if (classes.length) node.classList.add(...classes);

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === 'class') {
      const extra = Array.isArray(value) ? value.join(' ') : String(value);
      if (extra) node.classList.add(...extra.split(/\s+/).filter(Boolean));
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value)) {
        if (dv != null) node.dataset[dk] = String(dv);
      }
    } else if (key === 'style') {
      if (typeof value === 'string') node.setAttribute('style', value);
      else Object.assign(node.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && typeof value !== 'object') {
      // 直接映射到属性（value / checked / disabled / href / placeholder…）
      try { node[key] = value; } catch { node.setAttribute(key, String(value)); }
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

/** 递归追加子节点 */
export function appendChildren(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** 清空节点所有子元素 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** HTML 转义，防止用户输入注入 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把字符串安全地设置为 textContent（等价于 escapeHtml 语义）。
 * @returns {Text}
 */
export function text(str) {
  return document.createTextNode(String(str ?? ''));
}

/** 简单 hash：返回 32 位无符号整数（用于 hue 派生） */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 由字符串稳定派生一个色相 hue（0-360）。
 * @param {string} seed 任意种子（通常是标题）
 * @returns {number} hue 0-359
 */
export function hueFromString(seed) {
  return hashString(seed) % 360;
}

/**
 * hue → CSS 颜色。默认生成一个适合作为头像/渐变的饱和色。
 * @param {number} hue 0-360
 * @param {number} [s] 饱和度 %
 * @param {number} [l] 亮度 %
 */
export function hueToColor(hue, s = 72, l = 52) {
  const h = ((hue % 360) + 360) % 360;
  return `hsl(${h.toFixed(0)}, ${s}%, ${l}%)`;
}

/** 由 hue 生成线性渐变字符串（135deg） */
export function hueToGradient(hue) {
  const h = ((hue % 360) + 360) % 360;
  const h2 = (h + 42) % 360;
  return `linear-gradient(135deg, hsl(${h}, 78%, 60%), hsl(${h2}, 82%, 46%))`;
}

/**
 * 生成头像用的 CSS background（由 hue 派生）。
 * @param {string|number} seedOrHue 种子字符串或直接给 hue
 * @returns {string} CSS background 值
 */
export function avatarBackground(seedOrHue) {
  const hue = typeof seedOrHue === 'number' ? seedOrHue : hueFromString(seedOrHue);
  return hueToGradient(hue);
}

/**
 * 防抖。返回的函数在 wait ms 内重复调用只执行最后一次。
 */
export function debounce(fn, wait = 200) {
  let t = null;
  return function debounced(...args) {
    if (t != null) clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(this, args); }, wait);
  };
}

/**
 * 节流（时间戳版）：保证 fn 每 wait ms 最多执行一次（首次立即执行）。
 */
export function throttle(fn, wait = 200) {
  let last = 0;
  let timer = null;
  return function throttled(...args) {
    const now = Date.now();
    const remain = wait - (now - last);
    if (remain <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn.apply(this, args);
      }, remain);
    }
  };
}

/**
 * 时间格式化：
 * - 1 分钟内：刚刚
 * - 1 小时内：N 分钟前
 * - 24 小时内：N 小时前
 * - 7 天内：N 天前
 * - 同年：M月D日
 * - 跨年：YYYY年M月D日
 * @param {number|string|Date} ts 毫秒时间戳 / ISO 字符串 / Date
 * @returns {string}
 */
export function formatTime(ts) {
  let d;
  if (ts instanceof Date) d = ts;
  else if (typeof ts === 'number') d = new Date(ts);
  else if (typeof ts === 'string') {
    const n = Number(ts);
    // ISO 字符串或纯数字字符串都支持
    d = new Date(Number.isFinite(n) && /^\d+$/.test(ts) ? n : ts);
  } else d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';

  const now = Date.now();
  const diff = now - d.getTime();
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;

  const nowY = new Date(now).getFullYear();
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const dd = d.getDate();
  if (y === nowY) return `${mo}月${dd}日`;
  return `${y}年${mo}月${dd}日`;
}

/** 时钟时间 HH:MM（用于消息气泡角标） */
export function formatClock(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 截断文本并追加省略号 */
export function truncate(str, max = 60) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** token 数量友好显示：1234 → 1.2K，1234567 → 1.2M */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** 百分比格式化（0-1 → '45%'） */
export function fmtPercent(ratio) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  return `${Math.round(r * 100)}%`;
}

/** 休眠 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成随机 id */
export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** 复制到剪贴板（带降级提示） */
export async function copyToClipboard(str) {
  try {
    await navigator.clipboard.writeText(String(str ?? ''));
    return true;
  } catch {
    return false;
  }
}

/** 触发一次短暂的设备级触觉反馈（支持的浏览器） */
export function haptic(ms = 8) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(ms); } catch { /* 忽略 */ }
  }
}
