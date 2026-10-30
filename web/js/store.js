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
  readingSize: 16,          // 正文字号
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
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#141110' : '#f7f4f0');
}

export function setTheme(theme) {
  if (!['light', 'dark', 'system'].includes(theme)) theme = 'system';
  setPref('theme', theme);
  applyTheme(theme);
}

/**
 * 带水波纹的外观切换：以 (x, y) 为圆心，新主题像涟漪一样加速扩散到全屏。
 * 依赖 View Transitions API；不支持或用户偏好减少动效时直接切换。
 * 状态变更只依赖 apply() 一次执行：过渡被跳过时由 finished 兜底补跑。
 * @param {() => void} apply  实际改主题（以及依赖主题的 DOM 重绘）的回调
 * @param {number} x  波纹圆心（视口坐标）
 * @param {number} y
 */
export function applyWithRipple(apply, x, y) {
  const reduce = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof document.startViewTransition !== 'function' || reduce) {
    apply();
    return;
  }
  let ran = false;
  const run = () => { if (!ran) { ran = true; apply(); } };
  let vt;
  try {
    vt = document.startViewTransition(run);
  } catch {
    run();
    return;
  }
  vt.finished.catch(() => {}).then(run);
  vt.ready.then(() => {
    const r = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    ) * 1.12;
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      {
        duration: 680,
        easing: 'cubic-bezier(0.42, 0, 0.9, 0.5)',  // 先缓后急：向右上加速漫开
        pseudoElement: '::view-transition-new(root)',
      },
    );
  }).catch(() => { /* 中断即直接切换，不报错 */ });
}

if (mq && typeof mq.addEventListener === 'function') {
  mq.addEventListener('change', () => {
    if (ui.get().theme === 'system') applyTheme('system');
  });
}

/* ------------------------------------------------------------------ */

const WIDTH_MAP = {
  compact: '720px',
  normal: '880px',
  wide: '1040px',
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
