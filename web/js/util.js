/**
 * util.js — 纯函数工具集
 * 无副作用，供各视图复用。DOM 创建统一走 el()，避免 innerHTML 注入。
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * 创建 DOM 元素。
 * 标签支持 'div.cls#id' 简写；attrs 中 on* 为事件，class/dataset/style 特殊处理。
 * @param {string} tag
 * @param {object} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  let tagName = tag;
  let id = null;
  const classes = [];
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][^.#]+)*)$/.exec(tag);
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
    if (value == null || value === false) continue;
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
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'svg') {
      continue;
    } else if (key in node && key !== 'list' && typeof value !== 'object') {
      try { node[key] = value; } catch { node.setAttribute(key, String(value)); }
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function hueFromString(seed) {
  return hashString(seed) % 360;
}

export function hueToColor(hue, s = 68, l = 50) {
  const h = ((hue % 360) + 360) % 360;
  return `hsl(${h.toFixed(0)} ${s}% ${l}%)`;
}

/**
 * 由 hue 派生一组和谐渐变（用于封面/头像）。
 * 两个 stop 相隔 36°，明度略微下沉，追求 iOS 风格的柔和而非高饱和。
 */
export function hueToGradient(hue, { s = 68, l = 56 } = {}) {
  const h = ((hue % 360) + 360) % 360;
  const h2 = (h + 36) % 360;
  return `linear-gradient(140deg, hsl(${h} ${s}% ${l}%), hsl(${h2} ${Math.min(100, s + 6)}% ${Math.max(28, l - 14)}%))`;
}

/** 头像/封面的背景（字符串种子或 hue） */
export function avatarBackground(seedOrHue) {
  const hue = typeof seedOrHue === 'number' ? seedOrHue : hueFromString(seedOrHue);
  return hueToGradient(hue);
}

export function debounce(fn, wait = 200) {
  let t = null;
  return function debounced(...args) {
    if (t != null) clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(this, args); }, wait);
  };
}

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
      timer = setTimeout(() => { timer = null; last = Date.now(); fn.apply(this, args); }, remain);
    }
  };
}

export function toDate(ts) {
  if (ts instanceof Date) return ts;
  if (typeof ts === 'number') return new Date(ts);
  if (typeof ts === 'string') {
    const n = Number(ts);
    return new Date(Number.isFinite(n) && /^\d+$/.test(ts) ? n : ts);
  }
  return new Date(ts);
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / M月D日 / YYYY年M月D日
 */
export function formatTime(ts) {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const min = 60_000, hour = 60 * min, day = 24 * hour;
  if (diff < 0) return '刚刚';
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const y = d.getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return y === new Date().getFullYear() ? md : `${y}年${md}`;
}

export function formatClock(ts) {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatDate(ts) {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function truncate(str, max = 60) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** 毫秒 → 人类可读时长：820ms / 3.4s / 1m12s */
export function fmtDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '—';
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export function fmtPercent(ratio, digits = 0) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  return `${(r * 100).toFixed(digits)}%`;
}

export function fmtNumber(n) {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function firstChar(str) {
  const s = String(str || '').trim();
  return s ? [...s][0] : '?';
}

export async function copyToClipboard(str) {
  const text = String(str ?? '');
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 降级：临时 textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function haptic(ms = 8) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  } catch { /* 忽略 */ }
}

/**
 * 触发文件下载。
 * @param {string} filename
 * @param {string} content
 * @param {string} [mime]
 */
export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

/** 读取 File → dataURL */
export function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 估算文本字数（中文字符按 1 计，英文单词按 0.5 计） */
export function charCount(str) {
  const s = String(str || '');
  let n = 0;
  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    n += /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(ch) ? 1 : 0.5;
  }
  return Math.round(n);
}

/** 安全 JSON 解析 */
export function tryParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/** 数组分组 */
export function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list || []) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/** 只在可见时滚动到底部 */
export function scrollToBottom(node, smooth = true) {
  if (!node) return;
  requestAnimationFrame(() => {
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  });
}

export function isNearBottom(node, threshold = 120) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < threshold;
}
