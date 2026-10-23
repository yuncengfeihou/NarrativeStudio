/**
 * app.js — 应用入口
 *
 * 职责：
 *  - 启动 store / 侧栏 / 路由
 *  - hash 路由：#/  #/chat/:id  #/new  #/edit/:id  #/presets  #/settings
 *  - 全局浮层：toast / loading / sheet / actionSheet / confirm / popover
 */

import { $, el, clear } from './util.js';
import { icon } from './icons.js';
import { initStore, cycleTheme, ui } from './store.js';
import { initSidebar, openSidebar } from './sidebar.js';

const appRoot = $('#main');
const overlayRoot = $('#overlay-root');

/* =========================================================================
 * 路由
 * ========================================================================= */

export function navigate(path) {
  const target = path.startsWith('#') ? path : '#' + path;
  if (location.hash === target) handleRoute();
  else location.hash = target;
}

export function matchRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  if (parts.length === 0) return { name: 'home', params: {} };
  switch (parts[0]) {
    case 'library': return { name: 'home', params: {} };
    case 'home': return { name: 'home', params: {} };
    case 'chat': return { name: 'chat', params: { id: parts[1] || null } };
    case 'new': return { name: 'editor', params: { id: null } };
    case 'edit': return { name: 'editor', params: { id: parts[1] || null } };
    case 'setup': return { name: 'editor', params: { id: parts[1] || null } };
    case 'presets': return { name: 'presets', params: {} };
    case 'settings': return { name: 'settings', params: {} };
    default: return { name: 'home', params: {} };
  }
}

const loaders = {
  home: () => import('./views/home.js'),
  chat: () => import('./views/chat.js'),
  editor: () => import('./views/editor.js'),
  presets: () => import('./views/presets.js'),
  settings: () => import('./views/settings.js'),
};

let current = null;

/** 关闭所有浮层（路由切换时调用，避免 sheet 跟着页面走） */
export function closeAllOverlays() {
  const nodes = overlayRoot.querySelectorAll('.veil, .sheet, .actions, .dialog, .popover');
  nodes.forEach((n) => {
    n.classList.remove('is-open');
    n.remove();
  });
  lockCount = 0;
  document.body.style.overflow = '';
}

async function handleRoute() {
  const route = matchRoute();
  closeAllOverlays();
  if (current?.handle?.unmount) {
    try { current.handle.unmount(); } catch (err) { console.error('[route] unmount', err); }
  }
  current = null;
  clear(appRoot);
  try {
    const mod = await (loaders[route.name] || loaders.home)();
    const view = mod.default;
    if (!view?.mount) throw new Error(`视图 ${route.name} 缺少 mount`);
    const handle = await view.mount(appRoot, route.params);
    current = { name: route.name, handle: handle || {} };
    appRoot.querySelector('.view')?.classList.add('is-active');
  } catch (err) {
    console.error('[route] mount failed', err);
    renderError(err);
  }
  document.dispatchEvent(new CustomEvent('route:changed', { detail: route }));
}

function renderError(err) {
  appRoot.appendChild(el('div.view.is-active', {},
    el('header.nav', {}, el('div.nav-title', {}, '出错了')),
    el('div.scroll', {},
      el('div.empty', {},
        el('div.empty-icon', {}, icon('warn', { size: 26 })),
        el('div.empty-title', {}, '页面加载失败'),
        el('div.empty-sub', {}, err?.message || String(err)),
        el('button.btn.btn-primary', { onclick: () => navigate('#/') }, '返回首页'),
      ),
    ),
  ));
}

/* =========================================================================
 * Toast
 * ========================================================================= */

let toastTimer = null;
/**
 * @param {string} message
 * @param {{duration?:number, type?:'info'|'error'|'success', icon?:string}} [opts]
 */
export function toast(message, opts = {}) {
  const { duration = 2200, type = 'info', iconName = null } = typeof opts === 'number' ? { duration: opts } : opts;
  let node = $('#toast');
  if (!node) {
    node = el('div.toast#toast', { role: 'status', 'aria-live': 'polite' });
    overlayRoot.appendChild(node);
  }
  clear(node);
  const ic = iconName || (type === 'error' ? 'warn' : type === 'success' ? 'check' : null);
  if (ic) node.appendChild(el('span.toast-icon', {}, icon(ic, { size: 15 })));
  node.appendChild(el('span', {}, message));
  node.classList.toggle('is-error', type === 'error');
  void node.offsetWidth;
  node.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), duration);
}

/* =========================================================================
 * 全屏 loading
 * ========================================================================= */

let loadingCount = 0;
export function showLoading(text = '') {
  loadingCount++;
  let node = $('#loading');
  if (!node) {
    node = el('div.loading#loading', {},
      el('span.spinner'),
      el('div.loading-text', {}, text),
    );
    overlayRoot.appendChild(node);
  }
  const t = node.querySelector('.loading-text');
  if (t && text) t.textContent = text;
  void node.offsetWidth;
  node.classList.add('is-visible');
}
export function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount > 0) return;
  $('#loading')?.classList.remove('is-visible');
}

/* =========================================================================
 * 滚动锁定（多浮层共存时计数）
 * ========================================================================= */

let lockCount = 0;
function lockScroll(on) {
  lockCount = Math.max(0, lockCount + (on ? 1 : -1));
  document.body.style.overflow = lockCount > 0 ? 'hidden' : '';
}

/* =========================================================================
 * Sheet
 * ========================================================================= */

/**
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {(body:HTMLElement, api:object)=>void} opts.render
 * @param {string} [opts.confirmText]
 * @param {()=>any} [opts.onConfirm]  返回 false 阻止关闭
 * @param {string} [opts.cancelText]
 * @param {boolean} [opts.fullHeight]
 * @returns {{close:Function, body:HTMLElement, sheet:HTMLElement, confirmBtn:HTMLElement|null}}
 */
export function openSheet(opts = {}) {
  const {
    title = '', render, confirmText = '', onConfirm, cancelText = '取消', footer = null,
  } = opts;

  const veil = el('div.veil');
  const body = el('div.sheet-body');
  const sheet = el('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '面板' });

  let confirmBtn = null;
  const api = {
    body,
    sheet,
    close: () => close(),
    setConfirmDisabled(v) { if (confirmBtn) confirmBtn.disabled = v; },
  };

  const cancelBtn = el('button.sheet-btn', { type: 'button' }, cancelText);
  cancelBtn.addEventListener('click', () => close());

  if (confirmText) {
    confirmBtn = el('button.sheet-btn.is-confirm', { type: 'button' }, confirmText);
    confirmBtn.addEventListener('click', async () => {
      if (onConfirm) {
        confirmBtn.disabled = true;
        try {
          const r = await onConfirm(api);
          if (r === false) return;
        } finally {
          confirmBtn.disabled = false;
        }
      }
      close();
    });
  }

  const head = el('div.sheet-head', {},
    cancelBtn,
    el('div.sheet-title', {}, title),
    confirmBtn || el('span', { style: 'min-width:52px;' }),
  );

  sheet.appendChild(el('div.sheet-grab'));
  if (title || confirmText) sheet.appendChild(head);
  sheet.appendChild(body);
  if (footer) sheet.appendChild(footer);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    veil.classList.remove('is-open');
    sheet.classList.remove('is-open');
    lockScroll(false);
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { veil.remove(); sheet.remove(); }, 420);
  }

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  veil.addEventListener('click', close);

  overlayRoot.appendChild(veil);
  overlayRoot.appendChild(sheet);
  lockScroll(true);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      veil.classList.add('is-open');
      sheet.classList.add('is-open');
    });
  });

  if (typeof render === 'function') render(body, api);

  return { close, body, sheet, veil, confirmBtn };
}

/* =========================================================================
 * Action Sheet
 * ========================================================================= */

/**
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {Array<{label:string, value?:any, icon?:string, desc?:string, destructive?:boolean}>} opts.actions
 * @param {string} [opts.cancelText]
 * @returns {Promise<any>} 选中的 value；取消为 null
 */
export function openActionSheet(opts = {}) {
  const { title = '', actions = [], cancelText = '取消' } = opts;
  return new Promise((resolve) => {
    const veil = el('div.veil');
    const group = el('div.actions-group');
    if (title) group.appendChild(el('div.actions-title', {}, title));

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      veil.classList.remove('is-open');
      sheet.classList.remove('is-open');
      lockScroll(false);
      document.removeEventListener('keydown', onKey);
      setTimeout(() => { veil.remove(); sheet.remove(); }, 420);
      resolve(result);
    }
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    for (const a of actions) {
      const btn = el('button.action-item', { type: 'button', class: a.destructive ? 'is-destructive' : '' },
        a.icon ? el('span.action-icon', {}, icon(a.icon, { size: 18 })) : null,
        el('span.action-main', {},
          el('span.action-label', {}, a.label),
          a.desc ? el('span.action-desc', {}, a.desc) : null,
        ),
      );
      btn.addEventListener('click', () => close(a.value !== undefined ? a.value : a.label));
      group.appendChild(btn);
    }

    const cancelGroup = el('div.actions-group');
    const cancelBtn = el('button.action-item.is-cancel', { type: 'button' }, cancelText);
    cancelBtn.addEventListener('click', () => close(null));
    cancelGroup.appendChild(cancelBtn);

    const sheet = el('div.actions', { role: 'dialog', 'aria-modal': 'true' }, group, cancelGroup);
    veil.addEventListener('click', () => close(null));

    overlayRoot.appendChild(veil);
    overlayRoot.appendChild(sheet);
    lockScroll(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        veil.classList.add('is-open');
        sheet.classList.add('is-open');
      });
    });
  });
}

/* =========================================================================
 * 确认对话框
 * ========================================================================= */

/**
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title = '', message = '', confirmText = '确定', cancelText = '取消', destructive = false } = {}) {
  return new Promise((resolve) => {
    const veil = el('div.veil');
    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      veil.classList.remove('is-open');
      dialog.classList.remove('is-open');
      lockScroll(false);
      document.removeEventListener('keydown', onKey);
      setTimeout(() => { veil.remove(); dialog.remove(); }, 260);
      resolve(result);
    }
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);

    const dialog = el('div.dialog', { role: 'alertdialog', 'aria-modal': 'true' },
      el('div.dialog-title', {}, title),
      message ? el('div.dialog-msg', {}, message) : null,
      el('div.dialog-actions', {},
        el('button.btn.btn-secondary', { type: 'button', onclick: () => close(false) }, cancelText),
        el('button.btn', {
          type: 'button',
          class: destructive ? 'btn-danger' : 'btn-primary',
          onclick: () => close(true),
        }, confirmText),
      ),
    );

    veil.addEventListener('click', () => close(false));
    overlayRoot.appendChild(veil);
    overlayRoot.appendChild(dialog);
    lockScroll(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        veil.classList.add('is-open');
        dialog.classList.add('is-open');
      });
    });
  });
}

/* =========================================================================
 * Popover（锚定菜单）
 * ========================================================================= */

/**
 * @param {HTMLElement} anchor 定位锚点
 * @param {Array<{label:string,icon?:string,value?:any,destructive?:boolean,separator?:boolean}>} items
 * @param {{align?:'start'|'end'}} [opts]
 * @returns {Promise<any>}
 */
export function openPopover(anchor, items, opts = {}) {
  const { align = 'end' } = opts;
  return new Promise((resolve) => {
    const veil = el('div.veil', { style: 'background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;' });
    const pop = el('div.popover', { role: 'menu' });
    let closed = false;
    function close(v) {
      if (closed) return;
      closed = true;
      veil.classList.remove('is-open');
      pop.remove();
      document.removeEventListener('keydown', onKey);
      setTimeout(() => veil.remove(), 260);
      resolve(v);
    }
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    for (const it of items) {
      if (it.separator) { pop.appendChild(el('div.pop-sep')); continue; }
      const b = el('button.pop-item', { type: 'button', class: it.destructive ? 'is-destructive' : '' },
        it.icon ? el('span.pop-icon', {}, icon(it.icon, { size: 16 })) : null,
        el('span', {}, it.label),
      );
      b.addEventListener('click', () => close(it.value !== undefined ? it.value : it.label));
      pop.appendChild(b);
    }

    veil.addEventListener('click', () => close(null));
    overlayRoot.appendChild(veil);
    overlayRoot.appendChild(pop);
    veil.classList.add('is-open');

    // 定位：优先下方，空间不足则上方
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = align === 'end' ? r.right - pr.width : r.left;
    left = Math.max(10, Math.min(left, window.innerWidth - pr.width - 10));
    let top = r.bottom + 6;
    if (top + pr.height > window.innerHeight - 12) top = Math.max(10, r.top - pr.height - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  });
}

/* =========================================================================
 * 主题切换
 * ========================================================================= */

export function toggleTheme() {
  const next = cycleTheme();
  const label = next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统';
  toast(`外观：${label}`);
  return next;
}

ui.subscribe((s, prev) => {
  if (s.theme !== prev.theme) document.documentElement.dataset.appTheme = s.theme;
});

/* =========================================================================
 * 启动
 * ========================================================================= */

function boot() {
  initStore();
  initSidebar();
  window.addEventListener('hashchange', handleRoute);
  document.addEventListener('keydown', (e) => {
    // ⌘K / Ctrl+K 全局搜索（在聊天页里聚焦搜索、其它页跳到剧本库）
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openSidebar();
      setTimeout(() => $('#sidebar input[type="text"]')?.focus(), 120);
    }
  });
  handleRoute();
}

export { openSidebar };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
