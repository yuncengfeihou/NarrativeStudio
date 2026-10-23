/**
 * store.js — 全局 UI 状态 + localStorage 偏好
 *
 * 主题三态（light / dark / system）在这里被解析成确定值写到 <html data-theme>，
 * 因此 CSS 只需一套令牌，不再需要 prefers-color-scheme 的重复定义。
 */

import { $ } from './util.js';

const PREF_KEY = 'ai-roleplay.prefs.v2';

/* ------------------------------------------------------------------ */
/* 极简响应式 store                                                    */
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
  readingSize: 17.5,        // 正文字号
  showReasoning: false,     // 默认展开思考过程
  showTurnMarks: true,      // 显示回合分隔
  branchStyle: 'cards',     // cards | pills
  lastSessionId: null,
  sidebarOpen: false,
});

/* ------------------------------------------------------------------ */
/* 偏好持久化                                                          */
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

export function getPref(key, fallback = null) {
  const v = ui.get()[key];
  return v === undefined ? fallback : v;
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function resolveTheme(theme = ui.get().theme) {
  if (theme === 'system') return mq && mq.matches ? 'dark' : 'light';
  return theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme = ui.get().theme) {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0E0E12' : '#F2F2F7');
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
/* 阅读偏好应用（写 CSS 变量）                                          */
/* ------------------------------------------------------------------ */

const WIDTH_MAP = {
  compact: '34em',
  normal: '40em',
  wide: '48em',
};

export function applyReadingPrefs() {
  const s = ui.get();
  const root = document.documentElement;
  root.style.setProperty('--read-max', WIDTH_MAP[s.readingWidth] || WIDTH_MAP.normal);
  if (typeof s.readingSize === 'number') {
    root.style.setProperty('--fs-read', `${s.readingSize}px`);
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

export function initStore() {
  const prefs = readPrefs();
  ui.set(prefs);
  applyTheme(ui.get().theme);
  applyReadingPrefs();
  return ui.get();
}
