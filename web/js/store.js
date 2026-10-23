/**
 * store.js — 极简响应式 store + localStorage UI 偏好持久化
 *
 * 设计目标：
 *  - 单例全局 store，subscribe/patch 两个核心 API
 *  - UI 偏好（theme / lastSessionId 等）持久化到 localStorage
 *  - 主题三态：light / dark / system，system 跟随 prefers-color-scheme
 *  - 主题通过根元素 data-theme 属性驱动 CSS 变量切换
 */

import { $ } from './util.js';

const PREF_KEY = 'ai-roleplay.prefs.v1';
const THEME_KEY = 'ai-roleplay.theme.v1';

// ---------- 响应式 store 核心 ----------

function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();

  return {
    get() {
      return state;
    },
    set(patch) {
      const prev = state;
      state = typeof patch === 'function' ? { ...state, ...patch(state) } : { ...state, ...patch };
      listeners.forEach((fn) => {
        try { fn(state, prev); } catch (err) { console.error('[store] listener error', err); }
      });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// 全局 UI store：仅存放跨视图共享的轻量状态
export const ui = createStore({
  theme: 'system',            // 'light' | 'dark' | 'system'
  lastSessionId: null,        // 最近打开的会话（用于角色库置顶/恢复）
  sidebarOpen: false,
});

// ---------- localStorage 偏好 ----------

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writePrefs(patch) {
  try {
    const next = { ...readPrefs(), ...patch };
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
  } catch { /* 隐私模式下 localStorage 可能不可用，忽略 */ }
}

/** 持久化某个 UI 偏好字段 */
export function setPref(key, value) {
  ui.set({ [key]: value });
  writePrefs({ [key]: value });
}

/** 读取某个 UI 偏好（未设置时返回 fallback） */
export function getPref(key, fallback = null) {
  const v = ui.get()[key];
  return v === undefined ? fallback : v;
}

// ---------- 主题管理 ----------

const mediaQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** 解析当前实际生效的颜色模式 */
export function resolveTheme(theme = ui.get().theme) {
  if (theme === 'system') {
    return mediaQuery && mediaQuery.matches ? 'dark' : 'light';
  }
  return theme === 'dark' ? 'dark' : 'light';
}

/** 把主题应用到 DOM（根元素 data-theme + meta[theme-color]） */
export function applyTheme(theme = ui.get().theme) {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  if (resolved === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');

  // 同步浏览器 UI（地址栏）配色
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#000000' : '#F2F2F7');
}

/**
 * 切换主题：在 light → dark → system 间循环。
 * @returns {string} 切换后的 theme 值
 */
export function cycleTheme() {
  const order = ['light', 'dark', 'system'];
  const cur = ui.get().theme;
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setPref('theme', next);
  applyTheme(next);
  return next;
}

/** 设置主题 */
export function setTheme(theme) {
  if (!['light', 'dark', 'system'].includes(theme)) theme = 'system';
  setPref('theme', theme);
  applyTheme(theme);
}

// 监听系统主题变化（仅在 system 模式下影响显示）
if (mediaQuery && typeof mediaQuery.addEventListener === 'function') {
  mediaQuery.addEventListener('change', () => {
    if (ui.get().theme === 'system') applyTheme('system');
  });
}

// ---------- 初始化 ----------

/** 从 localStorage 恢复偏好并应用主题。在 app.js 启动时调用一次。 */
export function initStore() {
  const prefs = readPrefs();
  ui.set(prefs);
  applyTheme(ui.get().theme);
  return ui.get();
}
