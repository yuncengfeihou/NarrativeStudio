/**
 * sidebar.js — 侧栏：会话库（桌面常驻 / 移动端抽屉）
 *
 * 职责：
 *  - 渲染应用标识、搜索框、会话列表、底部操作（主题/设置）
 *  - 当前路由高亮；会话增删改后通过 window 事件 'sessions:changed' 刷新
 *  - 移动端：抽屉式滑入，遮罩点击关闭；视图通过 openSidebar() 唤出
 */
import { $, $$, el, clear } from './util.js';
import { api } from './api.js';
import { navigate, matchRoute, openActionSheet, confirmDialog, toggleTheme, toast } from './app.js';
import { ui } from './store.js';

const sidebar = $('#sidebar');
const scrim = $('#sidebar-scrim');

let sessions = [];
let query = '';
let activeId = null;
let loading = false;

/* ------------------------------------------------------------------ */
/* 渲染                                                               */
/* ------------------------------------------------------------------ */

function hueOf(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function avatarColor(text) {
  const h = hueOf(text);
  return `linear-gradient(135deg, hsl(${h}, 82%, 62%), hsl(${(h + 48) % 360}, 76%, 52%))`;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function renderShell() {
  clear(sidebar);
  sidebar.appendChild(el('div.sidebar-head', {},
    el('div.sidebar-logo', {}, '剧'),
    el('div.sidebar-titles', {},
      el('div.sidebar-title', {}, '角色剧场'),
      el('div.sidebar-sub', {}, sessions.length ? `${sessions.length} 段剧情` : 'AI 角色扮演'),
    ),
    el('button.sidebar-new', {
      type: 'button', title: '创建新剧情', 'aria-label': '创建新剧情',
      onclick: () => navigate('#/setup'),
    }, '+'),
  ));

  const searchInput = el('input', {
    type: 'text', placeholder: '搜索标题、风格或剧情…', value: query,
    oninput: (e) => { query = e.target.value; renderList(); },
  });
  const field = el('div.sidebar-search-field', { class: query ? 'has-value' : '' },
    el('span.search-icon', {}, '🔍'),
    searchInput,
    el('button.sidebar-search-clear', {
      type: 'button', 'aria-label': '清空搜索',
      onclick: () => { query = ''; searchInput.value = ''; field.classList.remove('has-value'); renderList(); },
    }, '✕'),
  );
  sidebar.appendChild(el('div.sidebar-search', {}, field));

  sidebar.appendChild(el('div.sidebar-section-label', {}, '剧情会话'));
  const list = el('div.sidebar-list');
  sidebar.appendChild(list);
  renderListInto(list);

  const themeIcon = () => ui.get().theme === 'dark' ? '☀️' : ui.get().theme === 'light' ? '🌙' : '🌗';
  sidebar.appendChild(el('div.sidebar-foot', {},
    el('button.side-foot-btn', {
      type: 'button', title: '切换外观',
      onclick: () => { toggleTheme(); requestAnimationFrame(renderShell); },
    }, el('span.foot-icon', {}, themeIcon()), '外观'),
    el('span', { style: 'flex:1' }),
    el('button.side-foot-btn.icon-only', {
      type: 'button', title: '设置', 'aria-label': '设置',
      onclick: () => navigate('#/settings'),
    }, el('span.foot-icon', {}, '⚙️')),
  ));
}

function filteredSessions() {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter(s =>
    (s.title || '').toLowerCase().includes(q) ||
    (s.style_tags || s.settings?.style_tags || []).some(t => t.toLowerCase().includes(q)) ||
    (s.settings?.worldview || '').toLowerCase().includes(q) ||
    (s.last_message || '').toLowerCase().includes(q)
  );
}

function renderList() {
  const list = $('.sidebar-list', sidebar);
  if (list) renderListInto(list);
}

function renderListInto(list) {
  clear(list);
  const items = filteredSessions();

  if (!items.length) {
    list.appendChild(el('div.sidebar-empty', {},
      query ? '没有匹配的剧情' : '还没有剧情\n点右上角 + 开始创作',
    ));
    return;
  }

  for (const s of items) {
    const isActive = s.id === activeId;
    const btn = el('button.side-item', {
      type: 'button',
      class: isActive ? 'is-active' : '',
      onclick: () => {
        closeSidebar();
        navigate(`#/chat/${s.id}`);
      },
    },
      el('div.side-item-avatar', { style: `background:${avatarColor(s.title || s.id)}` }, (s.title || '?').trim().charAt(0)),
      el('div.side-item-body', {},
        el('div.side-item-title', {}, s.title || '未命名剧情'),
        el('div.side-item-meta', {},
          el('span', {}, `${s.turn_count || 0} 回合`),
          el('span.dot'),
          el('span', {}, relativeTime(s.updated_at)),
        ),
      ),
      el('button.side-item-menu', {
        type: 'button', title: '更多操作', 'aria-label': '更多操作',
        onclick: async (e) => {
          e.stopPropagation();
          const action = await openActionSheet({
            title: s.title || '未命名剧情',
            actions: [
              { label: '进入剧情', value: 'open' },
              { label: '编辑设定', value: 'edit' },
              { label: '导出剧情', value: 'export' },
              { label: '删除剧情', value: 'delete', destructive: true },
            ],
          });
          if (action === 'open') navigate(`#/chat/${s.id}`);
          else if (action === 'edit') navigate(`#/setup/${s.id}`);
          else if (action === 'delete') {
            const ok = await confirmDialog({
              title: '删除剧情', message: `「${s.title}」的所有回合与记忆将被永久删除。`, confirmText: '删除', destructive: true,
            });
            if (ok) {
              await api.deleteSession(s.id);
              toast('已删除');
              refresh();
              if (matchRoute().params.id === s.id) navigate('#/library');
            }
          } else if (action === 'export') {
            exportSession(s.id);
          }
        },
      }, '⋯'),
    );
    list.appendChild(btn);
  }
}

/* ------------------------------------------------------------------ */
/* 数据                                                               */
/* ------------------------------------------------------------------ */

export async function refresh() {
  if (loading) return;
  loading = true;
  try {
    sessions = (await api.listSessions()) || [];
  } catch (err) {
    sessions = [];
    console.warn('[sidebar] 加载会话失败', err);
  } finally {
    loading = false;
  }
  renderShell();
}

/** 路由变化时调用：高亮当前会话 */
export function syncActive(id) {
  activeId = id || null;
  renderList();
}

async function exportSession(id) {
  try {
    const detail = await api.getSession(id);
    const lines = [`# ${detail.session.title}`, '', `> 风格：${(detail.session.settings?.style_tags || []).join('、')}`, ''];
    for (const t of detail.turns || []) {
      if (t.kind === 'narrator') lines.push(t.content, '');
      else if (t.kind === 'player') lines.push(`**（玩家）** ${t.content}`, '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${detail.session.title || '剧情'}.md` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已导出 Markdown');
  } catch (err) {
    toast(`导出失败：${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 移动端抽屉                                                          */
/* ------------------------------------------------------------------ */

export function openSidebar() {
  sidebar.classList.add('is-open');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('is-open'));
}

export function closeSidebar() {
  sidebar.classList.remove('is-open');
  scrim.classList.remove('is-open');
  setTimeout(() => { scrim.hidden = true; }, 320);
}

scrim.addEventListener('click', closeSidebar);

/* ------------------------------------------------------------------ */
/* 初始化                                                             */
/* ------------------------------------------------------------------ */

export function initSidebar() {
  window.addEventListener('sessions:changed', () => refresh());
  window.addEventListener('hashchange', () => {
    const route = matchRoute();
    syncActive(route.name === 'chat' ? route.params.id : null);
  });
  refresh().then(() => {
    const route = matchRoute();
    syncActive(route.name === 'chat' ? route.params.id : null);
  });
}
