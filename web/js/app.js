/**
 * app.js — 应用入口
 *
 * 职责：
 *  - 启动 store / 外壳（图标栏 + 目录栏）/ 路由
 *  - hash 路由：#/worlds  #/world/:id  #/play/:id  #/settings  #/new
 *  - 全局浮层：toast / loading / sheet / actionSheet / confirm / popover
 */

import { $, el, clear } from './util.js';
import { icon } from './icons.js';
import { initStore, ui } from './store.js';

const mainRoot = $('#main');
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
  if (parts.length === 0) return { name: 'worlds', params: {} };
  switch (parts[0]) {
    case 'worlds': return { name: 'worlds', params: {} };
    case 'world': return { name: 'world', params: { id: parts[1] || null } };
    case 'play': return { name: 'play', params: { id: parts[1] || null } };
    case 'new': return { name: 'world-edit', params: { id: null } };
    case 'edit': return { name: 'world-edit', params: { id: parts[1] || null } };
    case 'settings': return { name: 'settings', params: {} };
    default: return { name: 'worlds', params: {} };
  }
}

const loaders = {
  worlds: () => import('./views/worlds.js'),
  world: () => import('./views/world.js'),
  play: () => import('./views/play.js'),
  'world-edit': () => import('./views/world-edit.js'),
  settings: () => import('./views/settings.js'),
};

let current = null;

/** 路由切换时清掉所有浮层（内部用，不对外导出）。 */
function closeAllOverlays() {
  const nodes = overlayRoot.querySelectorAll('.veil, .sheet, .dialog, .popover, .actions');
  nodes.forEach((n) => {
    n.classList.remove('is-open');
    n.remove();
  });
  lockCount = 0;
  // loading 也是浮层：视图在 showLoading 后中途被路由切走时，unmount 不会补 hideLoading，
  // 计数一旦泄漏，「处理中」就会常驻在每一页（只能刷新才能清掉）。所有权跟着路由走。
  loadingCount = 0;
  $('#loading')?.classList.remove('is-visible');
  document.body.style.overflow = '';
}

async function handleRoute() {
  // 整个流程纳入 try：路由解析、卸载旧视图、清空主区任何一步抛错，
  // 都要显示成错误页而不是静默停在「正在载入」。
  try {
    const route = matchRoute();
    closeAllOverlays();
    if (current?.handle?.unmount) {
      try { current.handle.unmount(); } catch (err) { console.error('[route] unmount', err); }
    }
    current = null;
    clear(mainRoot);
    try {
      const mod = await (loaders[route.name] || loaders.worlds)();
      const view = mod.default;
      if (!view?.mount) throw new Error(`视图 ${route.name} 缺少 mount`);
      const handle = await view.mount(mainRoot, route.params);
      current = { name: route.name, handle: handle || {} };
      mainRoot.querySelector('.view')?.classList.add('is-active');
    } catch (err) {
      console.error('[route] mount failed', err);
      renderError(err);
    }
    document.dispatchEvent(new CustomEvent('route:changed', { detail: route }));
  } catch (err) {
    console.error('[route] failed', err);
    renderError(err);
  }
}

function renderError(err) {
  mainRoot.appendChild(el('div.view.is-active', {},
    el('div.scroll', {},
      el('div.empty', { style: 'padding-top:100px;' },
        el('div.empty-icon', {}, icon('warn', { size: 20 })),
        el('div.empty-title', {}, '页面加载失败'),
        el('div.empty-sub', {}, err?.message || String(err)),
        el('button.btn.btn-secondary', { onclick: () => navigate('#/') }, '返回世界卡'),
      ),
    ),
  ));
}

/* =========================================================================
 * Toast
 * ========================================================================= */

let toastTimer = null;

export function toast(message, opts = {}) {
  const { duration = 2000, type = 'info' } = typeof opts === 'number' ? { duration: opts } : opts;
  let node = $('#toast');
  if (!node) {
    node = el('div.toast#toast', { role: 'status', 'aria-live': 'polite' });
    overlayRoot.appendChild(node);
  }
  clear(node);
  node.appendChild(el('span', {}, message));
  node.dataset.type = type;
  void node.offsetWidth;
  node.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), duration);
}

/* =========================================================================
 * Loading
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
  if (t) t.textContent = text || '处理中';
  void node.offsetWidth;
  node.classList.add('is-visible');
}

export function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount > 0) return;
  $('#loading')?.classList.remove('is-visible');
}

/* =========================================================================
 * 滚动锁
 * ========================================================================= */

let lockCount = 0;
function lockScroll(on) {
  lockCount = Math.max(0, lockCount + (on ? 1 : -1));
  document.body.style.overflow = lockCount > 0 ? 'hidden' : '';
}

/* =========================================================================
 * Sheet
 * ========================================================================= */

export function openSheet(opts = {}) {
  const {
    title = '', render, confirmText = '', onConfirm, cancelText = '取消', footer = null,
    width = null,
  } = opts;

  const veil = el('div.veil');
  const body = el('div.sheet-body');
  const sheet = el('div.sheet', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '面板',
    style: width ? `width:${width};` : '',
  });

  let confirmBtn = null;
  const api = { body, sheet, close: () => close(), setConfirmDisabled(v) { if (confirmBtn) confirmBtn.disabled = v; } };

  const cancelBtn = cancelText === null ? null : el('button.btn.btn-ghost', { type: 'button' }, cancelText);
  if (cancelBtn) cancelBtn.addEventListener('click', () => close());

  if (confirmText) {
    confirmBtn = el('button.btn.btn-primary', { type: 'button' }, confirmText);
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
    el('div.sheet-title', {}, title),
    el('div.sheet-head-actions', {}, cancelBtn, confirmBtn),
  );

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
    setTimeout(() => { veil.remove(); sheet.remove(); }, 460);
  };

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  veil.addEventListener('click', close);

  overlayRoot.appendChild(veil);
  overlayRoot.appendChild(sheet);
  lockScroll(true);
  requestAnimationFrame(() => {
    veil.classList.add('is-open');
    sheet.classList.add('is-open');
  });

  if (typeof render === 'function') render(body, api);
  return { close, body, sheet, veil, confirmBtn };
}

/* =========================================================================
 * Action Sheet
 * ========================================================================= */

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
      setTimeout(() => { veil.remove(); sheet.remove(); }, 400);
      resolve(result);
    }
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    for (const a of actions) {
      const btn = el('button.action-item', { type: 'button', class: a.destructive ? 'is-destructive' : '' },
        a.icon ? el('span.action-icon', {}, icon(a.icon, { size: 15 })) : null,
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
      veil.classList.add('is-open');
      sheet.classList.add('is-open');
    });
  });
}

/* =========================================================================
 * 确认框
 * ========================================================================= */

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
      setTimeout(() => { veil.remove(); dialog.remove(); }, 380);
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
      veil.classList.add('is-open');
      dialog.classList.add('is-open');
    });
  });
}

/* =========================================================================
 * Popover
 * ========================================================================= */

export function openPopover(anchor, items, opts = {}) {
  const { align = 'end' } = opts;
  return new Promise((resolve) => {
    const veil = el('div.veil', { style: 'background:transparent;' });
    const pop = el('div.popover', { role: 'menu' });
    let closed = false;
    function close(v) {
      if (closed) return;
      closed = true;
      veil.classList.remove('is-open');
      pop.remove();
      document.removeEventListener('keydown', onKey);
      setTimeout(() => veil.remove(), 320);
      resolve(v);
    }
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    for (const it of items) {
      if (it.separator) { pop.appendChild(el('div.pop-sep')); continue; }
      const b = el('button.pop-item', { type: 'button', class: it.destructive ? 'is-destructive' : '' },
        it.icon ? el('span.pop-icon', {}, icon(it.icon, { size: 14 })) : null,
        el('span', {}, it.label),
      );
      b.addEventListener('click', () => close(it.value !== undefined ? it.value : it.label));
      pop.appendChild(b);
    }

    veil.addEventListener('click', () => close(null));
    overlayRoot.appendChild(veil);
    overlayRoot.appendChild(pop);
    veil.classList.add('is-open');

    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = align === 'end' ? r.right - pr.width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
    let top = r.bottom + 4;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 4);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  });
}

/* =========================================================================
 * 主题
 * ========================================================================= */

ui.subscribe((s, prev) => {
  if (s.theme !== prev.theme) document.documentElement.dataset.prefTheme = s.theme;
});

/* =========================================================================
 * 启动
 * ========================================================================= */

async function boot() {
  try {
    initStore();
    const { initShell } = await import('./shell.js');
    initShell();
    window.addEventListener('hashchange', handleRoute);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('shell:focus-search'));
      }
    });
    await handleRoute();
  } catch (err) {
    console.error('[boot] failed', err);
    renderError(err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
