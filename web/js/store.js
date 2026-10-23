/**
 * store.js — 全局 UI 状态 + localStorage 偏好
 */

import { $ } from './util.js';
import { fontStack } from './fonts.js';

const PREF_KEY = 'narra.prefs.v4';

/* ------------------------------------------------------------------ */

function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    get() { return state; },
    set(patch) {
      const prev = state;
      state = typeof patch === 'function' ? { ...state, ...patch(state) } : { ...state, ...patch };
      for (const fn of listeners) {
        try { fn(state, prev); } catch (err) { console.error('[store] listener', err); }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const ui = createStore({
  theme: 'system',
  readingWidth: 'normal',   // compact | normal | wide
  readingSize: 17,          // 正文字号
  uiFont: '',               // 界面字体：除正文外的所有 UI 文字
  readingFont: '',          // 正文内容字体：'' = 跟随系统默认
  showReasoning: false,
  showTurnMarks: true,
  showUsage: true,          // 显示 token 遥测
  lastWorldId: null,
  lastSessionId: null,
});

/* ------------------------------------------------------------------ */

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writePrefs(patch) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
  } catch { /* 隐私模式忽略 */ }
}

export function setPref(key, value) {
  ui.set({ [key]: value });
  writePrefs({ [key]: value });
}

const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function resolveTheme(theme = ui.get().theme) {
  if (theme === 'system') return mq && mq.matches ? 'dark' : 'light';
  return theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme = ui.get().theme) {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0C0B09' : '#F1E9DA');
}

export function setTheme(theme) {
  if (!['light', 'dark', 'system'].includes(theme)) theme = 'system';
  setPref('theme', theme);
  applyTheme(theme);
}

export function cycleTheme() {
  const order = ['light', 'dark', 'system'];
  const cur = ui.get().theme;
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setTheme(next);
  return next;
}

if (mq && typeof mq.addEventListener === 'function') {
  mq.addEventListener('change', () => {
    if (ui.get().theme === 'system') applyTheme('system');
  });
}

/* ------------------------------------------------------------------ */

const WIDTH_MAP = {
  compact: '34em',
  normal: '42em',
  wide: '50em',
};

/** 把偏好写进对应的 CSS 变量。空值 = 回到 tokens.css 的出厂默认。 */
function applyFontVar(name, value, fallback) {
  const stack = fontStack(value, fallback);
  if (stack) document.documentElement.style.setProperty(name, stack);
  else document.documentElement.style.removeProperty(name);
}

export function applyAppearancePrefs() {
  const s = ui.get();
  const root = document.documentElement;
  root.style.setProperty('--read-max', WIDTH_MAP[s.readingWidth] || WIDTH_MAP.normal);
  if (typeof s.readingSize === 'number') {
    root.style.setProperty('--fs-read', `${s.readingSize}px`);
  }
  applyFontVar('--font-ui', s.uiFont, 'var(--font-ui-base)');
  applyFontVar('--font-read', s.readingFont, 'var(--font-read-base)');
}

/* ------------------------------------------------------------------ */

export function initStore() {
  const prefs = readPrefs();
  // beta 期间 UI 偏好从「界面标题」扩成了「界面字体」，把旧键读过来即可。
  if (prefs.uiFont == null && prefs.titleFont != null) prefs.uiFont = prefs.titleFont;
  if ('titleFont' in prefs) {
    delete prefs.titleFont;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 忽略 */ }
  }
  ui.set(prefs);
  applyTheme(ui.get().theme);
  applyAppearancePrefs();
  return ui.get();
}
