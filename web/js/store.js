/**
 * store.js — 全局 UI 状态 + localStorage 偏好
 */

import { $ } from './util.js';

const PREF_KEY = 'narra.prefs.v3';

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

export function getPref(key, fallback = null) {
  const v = ui.get()[key];
  return v === undefined ? fallback : v;
}

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
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#171614' : '#FCFCFB');
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

export function applyReadingPrefs() {
  const s = ui.get();
  const root = document.documentElement;
  root.style.setProperty('--read-max', WIDTH_MAP[s.readingWidth] || WIDTH_MAP.normal);
  if (typeof s.readingSize === 'number') {
    root.style.setProperty('--fs-read', `${s.readingSize}px`);
  }
}

/* ------------------------------------------------------------------ */

export function initStore() {
  const prefs = readPrefs();
  ui.set(prefs);
  applyTheme(ui.get().theme);
  applyReadingPrefs();
  return ui.get();
}
