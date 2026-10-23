/**
 * app.js — 应用入口：hash 路由 + 视图调度 + 启动
 *
 * 职责：
 *  - 初始化 store（主题恢复）与侧栏（会话库）
 *  - hash 路由：#/library、#/setup、#/setup/:id、#/chat/:id、#/settings
 *  - 动态加载并挂载视图模块（每个视图 default 导出 {mount(root, params) -> {unmount}}）
 *  - 提供全局共享浮层 UI：toast / loading / sheet / actionSheet / confirm
 */

import { $, el, clear } from './util.js';
import { initStore, cycleTheme, ui } from './store.js';
import { initSidebar } from './sidebar.js';

const appRoot = $('#main');
const overlayRoot = $('#overlay-root');

// ============================================================
// 导航
// ============================================================

/** 跳转到某个 hash 路由 */
export function navigate(path) {
  const target = path.startsWith('#') ? path : '#' + path;
  if (location.hash === target) {
    // 相同 hash 时手动触发一次（hashchange 不会触发）
    handleRoute();
  } else {
    location.hash = target;
  }
}

/** 解析当前 hash 为 {name, params} */
export function matchRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: 'library', params: {} };
  switch (parts[0]) {
    case 'library': return { name: 'library', params: {} };
    case 'setup': return { name: 'setup', params: { id: parts[1] || null } };
    case 'chat': return { name: 'chat', params: { id: parts[1] || null } };
    case 'settings': return { name: 'settings', params: {} };
    default: return { name: 'library', params: {} };
  }
}

// 视图懒加载器（原生动态 import，等价代码分割）
const viewLoaders = {
  library: () => import('./library.js'),
  setup: () => import('./setup.js'),
  chat: () => import('./chat.js'),
  settings: () => import('./settings.js'),
};

let currentView = null; // {name, handle}

/** 路由变化 → 卸载旧视图 + 挂载新视图 */
async function handleRoute() {
  const route = matchRoute();

  // 卸载旧视图
  if (currentView && currentView.handle && typeof currentView.handle.unmount === 'function') {
    try { currentView.handle.unmount(); } catch (err) { console.error('[app] unmount error', err); }
  }
  currentView = null;
  clear(appRoot);

  const loader = viewLoaders[route.name] || viewLoaders.library;
  try {
    const mod = await loader();
    const view = mod.default;
    if (!view || typeof view.mount !== 'function') {
      throw new Error(`视图模块 ${route.name} 缺少 default.mount`);
    }
    const handle = await view.mount(appRoot, route.params);
    currentView = { name: route.name, handle: handle || {} };
    // 视图根默认为 display:none，挂载后激活（单一来源，避免各视图遗漏）
    const viewEl = appRoot.querySelector('.view');
    if (viewEl) viewEl.classList.add('is-active');
  } catch (err) {
    console.error('[app] 视图挂载失败', err);
    renderRouteError(err);
  }
}

/** 渲染路由级错误 */
function renderRouteError(err) {
  const box = el('div.view.is-active', {},
    el('div.main-nav', {}, el('span.main-nav-title', {}, '出错了')),
    el('div.main-scroll', { style: 'padding:32px;' },
      el('div.empty-state', {},
        el('div.empty-title', {}, '页面加载失败'),
        el('div.empty-sub', {}, err && err.message ? err.message : String(err)),
        el('button.btn-filled', { onclick: () => navigate('#/library') }, '返回角色库'),
      ),
    ),
  );
  appRoot.appendChild(box);
}

// ============================================================
// 全局浮层 UI（挂载到 #overlay-root）
// ============================================================

/** 轻提示 toast */
let toastTimer = null;
export function toast(message, duration = 2200) {
  let node = $('#app-toast');
  if (!node) {
    node = el('div.toast#app-toast');
    overlayRoot.appendChild(node);
  }
  node.textContent = message;
  // 强制 reflow 以重启动画
  void node.offsetWidth;
  node.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), duration);
}

/** 全屏加载遮罩 */
let loadingCount = 0;
export function showLoading() {
  loadingCount++;
  let veil = $('#app-loading');
  if (!veil) {
    veil = el('div.loading-veil#app-loading', {}, el('span.spinner'));
    overlayRoot.appendChild(veil);
  }
  void veil.offsetWidth;
  veil.classList.add('is-visible');
}
export function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount > 0) return;
  const veil = $('#app-loading');
  if (veil) veil.classList.remove('is-visible');
}

/** 锁定 body 滚动（打开 sheet 时） */
function lockScroll(lock) {
  document.body.style.overflow = lock ? 'hidden' : '';
}

/**
 * 打开底部 sheet。
 * @param {object} opts
 * @param {string} [opts.title] 标题（为空则不显示 header）
 * @param {(body:HTMLElement, api:object)=>void} opts.render 内容渲染回调
 * @param {string} [opts.confirmText] 确认按钮文字（有则显示）
 * @param {(api:object)=>void} [opts.onConfirm] 确认回调；返回 false 可阻止关闭
 * @param {string} [opts.cancelText] 取消按钮文字（默认「取消」）
 * @returns {{close:Function, body:HTMLElement}}
 */
export function openSheet(opts = {}) {
  const {
    title = '',
    render,
    confirmText = '',
    onConfirm,
    cancelText = '取消',
  } = opts;

  const mask = el('div.sheet-mask');
  const body = el('div.sheet-body');

  const api = {
    body,
    close,
    setConfirmDisabled(disabled) {
      if (confirmBtn) confirmBtn.disabled = disabled;
    },
  };

  const doClose = () => {
    mask.classList.remove('is-open');
    sheet.classList.remove('is-open');
    lockScroll(false);
    const done = () => {
      mask.remove();
      sheet.remove();
      document.removeEventListener('keydown', onKey);
    };
    setTimeout(done, 300);
  };

  let confirmBtn = null;
  if (confirmText) {
    confirmBtn = el('button.sheet-confirm', { type: 'button' }, confirmText);
    confirmBtn.addEventListener('click', async () => {
      if (onConfirm) {
        const r = await onConfirm(api);
        if (r === false) return;
      }
      doClose();
    });
  }
  const cancelBtn = el('button.sheet-cancel', { type: 'button' }, cancelText);

  const header = el('div.sheet-header', {},
    cancelBtn,
    title ? el('div.sheet-title', {}, title) : el('div.sheet-title'),
    confirmBtn || el('span', { style: 'min-width:48px;' }),
  );

  const sheet = el('div.sheet', { role: 'dialog', 'aria-modal': 'true' },
    el('div.sheet-grabber'),
    title || confirmText ? header : el('div', { style: 'height:8px;' }),
    body,
  );

  mask.addEventListener('click', doClose);

  const onKey = (e) => { if (e.key === 'Escape') doClose(); };
  document.addEventListener('keydown', onKey);

  overlayRoot.appendChild(mask);
  overlayRoot.appendChild(sheet);
  lockScroll(true);
  // 触发进场动画
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      mask.classList.add('is-open');
      sheet.classList.add('is-open');
    });
  });

  if (typeof render === 'function') render(body, api);

  function close() { doClose(); }
  return { close, body, sheet };
}

/**
 * 打开 action sheet（底部动作菜单）。
 * @param {object} opts
 * @param {string} [opts.title] 顶部说明文字
 * @param {Array<{label:string, destructive?:boolean, value?:any}>} opts.actions
 * @param {string} [opts.cancelText]
 * @returns {Promise<any>} 选中项的 value（取消时 resolve null）
 */
export function openActionSheet(opts = {}) {
  const {
    title = '',
    actions = [],
    cancelText = '取消',
  } = opts;

  return new Promise((resolve) => {
    const mask = el('div.sheet-mask');
    const group = el('div.action-group');
    const cancelGroup = el('div.action-group');

    const close = (result) => {
      mask.classList.remove('is-open');
      sheet.classList.remove('is-open');
      lockScroll(false);
      setTimeout(() => { mask.remove(); sheet.remove(); }, 300);
      resolve(result);
    };

    if (title) group.appendChild(el('div.action-title', {}, title));

    for (const action of actions) {
      const btn = el('button.action-item', {
        type: 'button',
        class: action.destructive ? 'is-destructive' : '',
      }, action.label);
      btn.addEventListener('click', () => close(action.value !== undefined ? action.value : action.label));
      group.appendChild(btn);
    }

    const cancelBtn = el('button.action-item.is-cancel', { type: 'button' }, cancelText);
    cancelBtn.addEventListener('click', () => close(null));
    cancelGroup.appendChild(cancelBtn);

    const sheet = el('div.action-sheet', { role: 'dialog', 'aria-modal': 'true' }, group, cancelGroup);
    mask.addEventListener('click', () => close(null));

    overlayRoot.appendChild(mask);
    overlayRoot.appendChild(sheet);
    lockScroll(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        mask.classList.add('is-open');
        sheet.classList.add('is-open');
      });
    });
  });
}

/**
 * iOS 风确认对话框（居中 alert）。
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title = '', message = '', confirmText = '确定', cancelText = '取消', destructive = false }) {
  return new Promise((resolve) => {
    const mask = el('div.sheet-mask');
    const close = (result) => {
      mask.classList.remove('is-open');
      dialog.classList.remove('is-open');
      lockScroll(false);
      setTimeout(() => { mask.remove(); dialog.remove(); }, 220);
      resolve(result);
    };

    const confirmBtn = el('button.btn-filled', {
      type: 'button',
      class: destructive ? 'btn-red' : '',
      style: 'flex:1;',
    }, confirmText);
    confirmBtn.addEventListener('click', () => close(true));
    const cancelBtn = el('button.btn-tinted', { type: 'button', style: 'flex:1;background:var(--fill-secondary);color:var(--label);' }, cancelText);
    cancelBtn.addEventListener('click', () => close(false));

    const dialog = el('div', {
      role: 'alertdialog',
      'aria-modal': 'true',
      style: 'position:fixed;left:50%;top:50%;transform:translate(-50%,-46%) scale(0.92);z-index:201;width:min(300px,82vw);background:var(--glass-bg-strong);-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);border:0.5px solid var(--glass-border);border-radius:14px;box-shadow:var(--shadow-float);overflow:hidden;opacity:0;transition:opacity 0.22s var(--ease-fade), transform 0.28s var(--ease-spring);padding:20px;text-align:center;',
    },
      el('div', { style: 'font-size:17px;font-weight:700;margin-bottom:6px;' }, title),
      message ? el('div', { style: 'font-size:14px;color:var(--label-secondary);line-height:1.45;margin-bottom:18px;white-space:pre-wrap;' }, message) : el('div', { style: 'height:12px;' }),
      el('div', { style: 'display:flex;gap:10px;' }, cancelBtn, confirmBtn),
    );

    mask.addEventListener('click', () => close(false));
    overlayRoot.appendChild(mask);
    overlayRoot.appendChild(dialog);
    lockScroll(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        mask.classList.add('is-open');
        dialog.style.opacity = '1';
        dialog.style.transform = 'translate(-50%,-50%) scale(1)';
      });
    });
  });
}

/** 切换主题（light → dark → system），并 toast 提示 */
export function toggleTheme() {
  const next = cycleTheme();
  const label = next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统';
  toast(`外观：${label}`);
  return next;
}

// 订阅 store 变化（可用于调试 / 全局响应）
ui.subscribe((state) => {
  document.documentElement.dataset.appTheme = state.theme;
});

// ============================================================
// 启动
// ============================================================

function boot() {
  initStore();
  initSidebar();
  window.addEventListener('hashchange', handleRoute);
  handleRoute(); // 首次进入
}

// DOM 已就绪（script type=module 默认 defer，DOM 已解析完成）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
