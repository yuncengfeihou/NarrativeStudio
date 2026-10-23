/**
 * util.js — 纯函数工具集
 * 无副作用，供各视图复用。DOM 创建统一走 el()，避免 innerHTML 注入。
 */

export const $ = (sel, root = document) => root.querySelector(sel);

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

function appendChildren(parent, children) {
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

function toDate(ts) {
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

export function isNearBottom(node, threshold = 120) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < threshold;
}
