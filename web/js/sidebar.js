/**
 * sidebar.js — 侧栏：会话库 + 搜索 + 筛选 + 外观/设置
 *
 * 桌面常驻，移动端抽屉。会话数据通过 window 事件 'sessions:changed' 刷新。
 */

import { $, el, clear, formatTime, firstChar, avatarBackground, hueFromString } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { navigate, matchRoute, openActionSheet, openPopover, confirmDialog, toggleTheme, toast } from './app.js';
import { ui } from './store.js';

const sidebar = $('#sidebar');
const scrim = $('#sidebar-scrim');

let sessions = [];
let query = '';
let filter = 'all';          // all | recent | starred
let activeId = null;
let loading = false;
let listEl = null;

/* =========================================================================
 * 数据
 * ========================================================================= */

export async function refresh() {
  if (loading) return;
  loading = true;
  try {
    sessions = (await api.listSessions()) || [];
  } catch (err) {
    sessions = [];
    console.warn('[sidebar] 会话加载失败', err);
  } finally {
    loading = false;
  }
  renderShell();
}

/* =========================================================================
 * 外壳
 * ========================================================================= */

function renderShell() {
  clear(sidebar);
  sidebar.appendChild(buildBrand());
  sidebar.appendChild(buildSearch());
  sidebar.appendChild(buildFilters());
  sidebar.appendChild(el('div.sb-section', {},
    el('span', {}, '剧情会话'),
    el('span', { style: 'font-weight:600;text-transform:none;letter-spacing:0;' }, String(sessions.length || '')),
  ));
  listEl = el('div.sb-list');
  sidebar.appendChild(listEl);
  renderList();
  sidebar.appendChild(buildFoot());
}

function buildBrand() {
  return el('div.sb-brand', {},
    el('div.sb-logo', {}, icon('sparkles', { size: 18, stroke: 2 })),
    el('div.sb-brand-text', {},
      el('div.sb-title', {}, '角色剧场'),
      el('div.sb-sub', {}, sessions.length ? `${sessions.length} 段剧情` : 'AI 角色扮演'),
    ),
    el('button.sb-new', {
      type: 'button', title: '新建剧情', 'aria-label': '新建剧情',
      onclick: () => navigate('#/new'),
    }, icon('plus', { size: 17, stroke: 2.2 })),
  );
}

function buildSearch() {
  const input = el('input', {
    type: 'text',
    placeholder: '搜索标题、风格、剧情',
    value: query,
    'aria-label': '搜索剧情',
    oninput: (e) => {
      query = e.target.value;
      wrap.classList.toggle('has-value', !!query);
      renderList();
    },
  });
  const clearBtn = el('button.sb-search-clear', {
    type: 'button', 'aria-label': '清空搜索',
    onclick: () => { query = ''; input.value = ''; wrap.classList.remove('has-value'); renderList(); input.focus(); },
  }, icon('close', { size: 13 }));
  const wrap = el('div.sb-search', { class: query ? 'has-value' : '' },
    icon('search', { size: 14 }),
    input,
    clearBtn,
  );
  return el('div.sb-search-wrap', {}, wrap);
}

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'recent', label: '最近' },
  { value: 'long', label: '长篇' },
];

function buildFilters() {
  const bar = el('div.sb-filters');
  for (const f of FILTERS) {
    bar.appendChild(el('button.sb-filter', {
      type: 'button',
      class: filter === f.value ? 'is-active' : '',
      onclick: () => {
        filter = f.value;
        Array.from(bar.children).forEach((c, i) => c.classList.toggle('is-active', FILTERS[i].value === filter));
        renderList();
      },
    }, f.label));
  }
  return bar;
}

function buildFoot() {
  const themeIconName = ui.get().theme === 'dark' ? 'sun' : ui.get().theme === 'light' ? 'moon' : 'palette';
  const themeLabel = ui.get().theme === 'dark' ? '浅色' : ui.get().theme === 'light' ? '深色' : '跟随系统';
  return el('div.sb-foot', {},
    el('button.sb-foot-btn', {
      type: 'button', title: '切换外观',
      onclick: () => { toggleTheme(); refresh(); },
    }, el('span', { style: 'display:flex;' }, icon(themeIconName, { size: 15 })), themeLabel),
    el('button.sb-foot-btn', {
      type: 'button', title: '剧本库',
      onclick: () => { closeSidebar(); navigate('#/presets'); },
    }, el('span', { style: 'display:flex;' }, icon('book', { size: 15 })), '剧本库'),
    el('span', { class: 'spacer' }),
    el('button.sb-foot-btn.is-icon', {
      type: 'button', title: '设置', 'aria-label': '设置',
      onclick: () => { closeSidebar(); navigate('#/settings'); },
    }, icon('settings', { size: 16 })),
  );
}

/* =========================================================================
 * 列表
 * ========================================================================= */

function filtered() {
  let list = sessions.slice();
  if (filter === 'recent') {
    const day = 86_400_000;
    list = list.filter((s) => Date.now() - s.updated_at < 7 * day);
  } else if (filter === 'long') {
    list = list.filter((s) => (s.turn_count || 0) >= 20);
  }
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) =>
    (s.title || '').toLowerCase().includes(q) ||
    (s.style_tags || []).some((t) => String(t).toLowerCase().includes(q)) ||
    (s.last_message || '').toLowerCase().includes(q)
  );
}

function renderList() {
  if (!listEl) return;
  clear(listEl);
  const items = filtered();

  if (!items.length) {
    listEl.appendChild(el('div.sb-empty', {},
      query ? '没有匹配的剧情' : el('span', {}, '还没有剧情', el('br'), '点右上角 + 开始创作'),
    ));
    return;
  }

  for (const s of items) {
    const hue = hueFromString(s.title || s.id);
    const item = el('button.sb-item', {
      type: 'button',
      class: s.id === activeId ? 'is-active' : '',
      onclick: () => { closeSidebar(); navigate(`#/chat/${s.id}`); },
    },
      el('div.sb-avatar', { style: `background:${avatarBackground(hue)};` }, firstChar(s.title)),
      el('div.sb-item-body', {},
        el('div.sb-item-title', {}, s.title || '未命名剧情'),
        el('div.sb-item-meta', {},
          el('span', {}, `${s.turn_count || 0} 回合`),
          el('span.dot'),
          el('span', {}, formatTime(s.updated_at)),
        ),
      ),
      el('span.sb-item-menu', {
        role: 'button',
        'aria-label': '更多操作',
        onclick: async (e) => {
          e.stopPropagation();
          const action = await openActionSheet({
            title: s.title || '未命名剧情',
            actions: [
              { label: '进入剧情', value: 'open', icon: 'play' },
              { label: '编辑设定', value: 'edit', icon: 'edit' },
              { label: '查看记忆', value: 'memory', icon: 'memory' },
              { label: '导出 Markdown', value: 'export', icon: 'download' },
              { label: '删除剧情', value: 'delete', icon: 'trash', destructive: true },
            ],
          });
          if (action === 'open') navigate(`#/chat/${s.id}`);
          else if (action === 'edit') navigate(`#/edit/${s.id}`);
          else if (action === 'memory') {
            navigate(`#/chat/${s.id}`);
            setTimeout(() => document.dispatchEvent(new CustomEvent('chat:open-memory')), 700);
          } else if (action === 'export') exportSession(s.id);
          else if (action === 'delete') {
            const ok = await confirmDialog({
              title: '删除剧情',
              message: `「${s.title}」的全部回合与记忆将被永久删除，无法恢复。`,
              confirmText: '删除', destructive: true,
            });
            if (ok) {
              await api.deleteSession(s.id);
              toast('已删除', { type: 'success' });
              await refresh();
              if (matchRoute().params.id === s.id) navigate('#/');
              window.dispatchEvent(new CustomEvent('sessions:changed'));
            }
          }
        },
      }, icon('more', { size: 15 })),
    );
    listEl.appendChild(item);
  }
}

/** 路由变化 → 高亮当前会话 */
export function syncActive(id) {
  activeId = id || null;
  renderList();
}

async function exportSession(id) {
  try {
    const { exportMarkdown } = await import('./export.js');
    await exportMarkdown(id);
  } catch (err) {
    toast(`导出失败：${err.message}`, { type: 'error' });
  }
}

/* =========================================================================
 * 抽屉
 * ========================================================================= */

export function openSidebar() {
  if (window.innerWidth > 860) return;   // 桌面常驻，无需抽屉
  sidebar.classList.add('is-open');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('is-open'));
}

export function closeSidebar() {
  sidebar.classList.remove('is-open');
  scrim.classList.remove('is-open');
  setTimeout(() => { scrim.hidden = true; }, 380);
}

scrim.addEventListener('click', closeSidebar);

/* =========================================================================
 * 初始化
 * ========================================================================= */

export function initSidebar() {
  window.addEventListener('sessions:changed', () => refresh());
  document.addEventListener('route:changed', (e) => {
    const route = e.detail || matchRoute();
    syncActive(route.name === 'chat' ? route.params.id : null);
  });
  refresh().then(() => {
    const route = matchRoute();
    syncActive(route.name === 'chat' ? route.params.id : null);
  });
}
