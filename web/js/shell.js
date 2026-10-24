/**
 * shell.js — 应用外壳：图标栏（一级导航）+ 目录栏（二级导航）
 *
 * 布局与参考图一致：左侧窄图标栏常驻，旁边是可折叠的目录栏。
 * 目录栏的内容随当前路由变化——
 *   世界卡页 → 该卡下的剧情会话列表
 *   世界卡总览 → 世界卡列表
 *   其他页 → 隐藏
 */

import { $, el, clear, formatTime, firstChar } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { navigate, matchRoute, openActionSheet, confirmDialog, toast, openPopover } from './app.js';
import { ui, setTheme, applyWithRipple } from './store.js';
import { hueGlyph } from './ui-kit.js';

const railEl = $('#rail');
const subbarEl = $('#subbar');
const scrimEl = $('#subbar-scrim');

let worlds = [];
let sessions = [];
let activeWorldId = null;
let activeSessionId = null;
let query = '';
let listEl = null;

/* =========================================================================
 * 一级导航
 * ========================================================================= */

const RAIL_ITEMS = [
  { key: 'worlds', label: '世界', icon: 'book', route: '#/worlds' },
  { key: 'play', label: '演绎', icon: 'play', route: null },
  { key: 'settings', label: '设置', icon: 'settings', route: '#/settings' },
];

function renderRail() {
  clear(railEl);
  railEl.appendChild(el('div.rail-logo', { title: '叙事台' }, '叙'));

  const route = matchRoute();
  const items = el('div.rail-items');

  for (const it of RAIL_ITEMS) {
    const isActive = it.key === 'worlds' ? (route.name === 'worlds' || route.name === 'world')
      : it.key === 'play' ? (route.name === 'play')
        : route.name === 'settings';
    const btn = el('button.rail-item', {
      type: 'button',
      class: isActive ? 'is-active' : '',
      title: it.label,
      'aria-label': it.label,
      onclick: () => {
        if (it.key === 'play') {
          // 演绎 → 回到最近一次会话，没有就去世界卡
          const id = ui.get().lastSessionId;
          navigate(id ? `#/play/${id}` : '#/worlds');
        } else {
          navigate(it.route);
        }
      },
    },
      icon(it.icon, { size: 17 }),
      el('span.rail-item-label', {}, it.label),
    );
    items.appendChild(btn);
  }

  railEl.appendChild(items);

  const foot = el('div.rail-foot');
  // 快捷切换只在深浅两档间翻转（跟随系统留给设置页），图标对应当前外观。
  const resolved = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  foot.appendChild(el('button.rail-item', {
    type: 'button', title: '切换外观', 'aria-label': '切换外观',
    onclick: (e) => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      const r = e.currentTarget.getBoundingClientRect();
      applyWithRipple(
        () => { setTheme(next); renderRail(); },
        r.left + r.width / 2, r.top + r.height / 2,
      );
    },
  },
    icon(resolved === 'dark' ? 'sun' : 'moon', { size: 17 }),
    el('span.rail-item-label', {}, resolved === 'dark' ? '浅色' : '深色'),
  ));
  railEl.appendChild(foot);
}

/* =========================================================================
 * 二级栏
 * ========================================================================= */

function renderSubbar() {
  const route = matchRoute();
  clear(subbarEl);
  listEl = null;

  if (route.name === 'worlds' || route.name === 'world-edit') {
    buildWorldsSubbar();
  } else if (route.name === 'world' || route.name === 'play') {
    buildWorldSubbar(activeWorldId);
  } else {
    subbarEl.hidden = true;
    return;
  }
  subbarEl.hidden = false;
}

function buildWorldsSubbar() {
  subbarEl.appendChild(el('div.subbar-head', {},
    el('div.subbar-title', {}, '世界卡'),
    el('button.icon-btn', {
      type: 'button', title: '新建世界卡', 'aria-label': '新建世界卡',
      onclick: () => navigate('#/new'),
    }, icon('plus', { size: 15 })),
  ));

  subbarEl.appendChild(buildSearch('搜索世界卡'));

  listEl = el('div.subbar-list');
  subbarEl.appendChild(listEl);
  paintWorlds();
}

function buildWorldSubbar(worldId) {
  const world = worlds.find((w) => w.id === worldId);

  subbarEl.appendChild(el('div.subbar-head', {},
    el('button.icon-btn', {
      type: 'button', title: '返回世界卡列表', 'aria-label': '返回',
      onclick: () => navigate('#/worlds'),
    }, icon('chevronLeft', { size: 16 })),
    el('div.subbar-title', {}, world?.title || '世界卡'),
    el('button.icon-btn', {
      type: 'button', title: '更多', 'aria-label': '更多',
      onclick: (e) => openWorldMenu(e.currentTarget, worldId),
    }, icon('more', { size: 15 })),
  ));

  if (world) {
    subbarEl.appendChild(el('div.subbar-world-info', {},
      el('div.subbar-world-meta', {},
        el('span.chip.is-plain', {}, `${world.card?.charter_count || 0} 条宪章`),
        el('span.chip.is-plain', {}, `${world.card?.cast?.length || 0} 人`),
        el('span.chip.is-plain', {}, `${world.card?.codex_count || 0} 条辞书`),
      ),
    ));
  }

  subbarEl.appendChild(el('div.subbar-section', {},
    el('span', {}, '剧情会话'),
    el('span', { style: 'font-weight:500;text-transform:none;letter-spacing:0;color:var(--ink-4);' },
      String(sessions.length || '')),
  ));

  listEl = el('div.subbar-list');
  subbarEl.appendChild(listEl);
  paintSessions();
}

function buildSearch(placeholder) {
  const input = el('input', {
    type: 'text', placeholder, value: query,
    oninput: (e) => { query = e.target.value; paintWorlds(); },
  });
  return el('div.subbar-search', {}, input);
}

function paintWorlds() {
  if (!listEl) return;
  clear(listEl);

  const q = query.trim().toLowerCase();
  const items = q
    ? worlds.filter((w) => (w.title || '').toLowerCase().includes(q)
      || (w.tags || []).some((t) => String(t).toLowerCase().includes(q)))
    : worlds;

  if (!items.length) {
    listEl.appendChild(el('div.sb-empty', {}, q ? '没有匹配的世界卡' : '还没有世界卡'));
    return;
  }

  for (const w of items) {
    listEl.appendChild(el('button.sb-item', {
      type: 'button',
      class: w.id === activeWorldId ? 'is-active' : '',
      onclick: () => { closeDrawer(); navigate(`#/world/${w.id}`); },
    },
      el('span.sb-glyph', { style: hueGlyph(w.cover_hue) }, firstChar(w.title)),
      el('div.sb-item-body', {},
        el('div.sb-item-title', {}, w.title),
        el('div.sb-item-meta', {},
          el('span', {}, `${w.session_count || 0} 段`),
          w.card?.codex_count ? el('span.dot') : null,
          w.card?.codex_count ? el('span', {}, `${w.card.codex_count} 条辞书`) : null,
        ),
      ),
    ));
  }
}

function paintSessions() {
  if (!listEl) return;
  clear(listEl);

  // 「开一段新剧情」永远是列表第一项
  listEl.appendChild(el('button.sb-item', {
    type: 'button',
    onclick: () => startNewSession(activeWorldId),
  },
    el('span.sb-glyph', { style: 'background:var(--paper-sunken);border:1px solid var(--line);color:var(--ink-3);' },
      icon('plus', { size: 13 })),
    el('div.sb-item-body', {},
      el('div.sb-item-title', { style: 'color:var(--ink-2);' }, '开一段新剧情'),
    ),
  ));

  if (!sessions.length) {
    listEl.appendChild(el('div.sb-empty', {}, '还没有剧情'));
    return;
  }

  for (const s of sessions) {
    const item = el('button.sb-item', {
      type: 'button',
      class: s.id === activeSessionId ? 'is-active' : '',
      onclick: () => { closeDrawer(); navigate(`#/play/${s.id}`); },
    },
      el('div.sb-item-body', {},
        el('div.sb-item-title', {}, s.title || '未命名剧情'),
        el('div.sb-item-meta', {},
          el('span', {}, `${s.turn_count || 0} 轮`),
          el('span.dot'),
          el('span', {}, formatTime(s.updated_at)),
        ),
      ),
      el('span.sb-item-menu', {
        role: 'button', 'aria-label': '更多操作',
        onclick: async (e) => {
          e.stopPropagation();
          const action = await openActionSheet({
            title: s.title || '未命名剧情',
            actions: [
              { label: '继续演绎', value: 'open', icon: 'play' },
              { label: '导出 Markdown', value: 'export', icon: 'download' },
              { label: '删除这段剧情', value: 'delete', icon: 'trash', destructive: true },
            ],
          });
          if (action === 'open') navigate(`#/play/${s.id}`);
          else if (action === 'export') {
            const { exportMarkdown } = await import('./export.js');
            exportMarkdown(s.id).catch((err) => toast(err.message, { type: 'error' }));
          } else if (action === 'delete') {
            const ok = await confirmDialog({
              title: '删除剧情',
              message: `「${s.title}」的全部回合与记忆将被永久删除，无法恢复。`,
              confirmText: '删除', destructive: true,
            });
            if (ok) {
              await api.deleteSession(s.id);
              toast('已删除', { type: 'success' });
              await refresh();
              if (matchRoute().params.id === s.id) navigate(`#/world/${activeWorldId}`);
            }
          }
        },
      }, icon('more', { size: 14 })),
    );
    listEl.appendChild(item);
  }
}

async function openWorldMenu(anchor, worldId) {
  const action = await openPopover(anchor, [
    { label: '编辑世界卡', value: 'edit', icon: 'edit' },
    { label: '开始新剧情', value: 'new', icon: 'plus' },
    { separator: true },
    { label: '删除世界卡', value: 'delete', icon: 'trash', destructive: true },
  ], { align: 'end' });

  if (action === 'edit') navigate(`#/edit/${worldId}`);
  else if (action === 'new') startNewSession(worldId);
  else if (action === 'delete') {
    const w = worlds.find((x) => x.id === worldId);
    const ok = await confirmDialog({
      title: '删除世界卡',
      message: `「${w?.title || worldId}」以及它的全部设定会被删除。`,
      confirmText: '删除', destructive: true,
    });
    if (!ok) return;
    await api.deleteWorld(worldId);
    toast('已删除');
    window.dispatchEvent(new CustomEvent('worlds:changed'));
    navigate('#/worlds');
  }
}

async function startNewSession(worldId) {
  if (!worldId) return;
  try {
    const s = await api.createWorldSession(worldId, {});
    window.dispatchEvent(new CustomEvent('worlds:changed'));
    toast('已开局', { type: 'success' });
    navigate(`#/play/${s.id}`);
  } catch (err) {
    toast(err.message || '开局失败', { type: 'error' });
  }
}

/* =========================================================================
 * 抽屉（移动端）
 * ========================================================================= */

export function openDrawer() {
  if (window.innerWidth > 900) return;
  subbarEl.hidden = false;
  subbarEl.classList.add('is-open');
  scrimEl.hidden = false;
  requestAnimationFrame(() => scrimEl.classList.add('is-open'));
}

export function closeDrawer() {
  if (window.innerWidth > 900) return;
  subbarEl.classList.remove('is-open');
  scrimEl.classList.remove('is-open');
  setTimeout(() => {
    scrimEl.hidden = true;
    if (!subbarEl.classList.contains('is-open')) {
      const route = matchRoute();
      if (route.name !== 'world' && route.name !== 'play' && route.name !== 'worlds') subbarEl.hidden = true;
    }
  }, 420);
}

scrimEl.addEventListener('click', closeDrawer);

/* =========================================================================
 * 数据
 * ========================================================================= */

export async function refresh() {
  try {
    worlds = (await api.listWorlds()) || [];
  } catch (err) {
    worlds = [];
    console.warn('[shell] 世界卡加载失败', err);
  }
  if (activeWorldId) {
    try {
      sessions = (await api.listSessions({ world_id: activeWorldId })) || [];
    } catch { sessions = []; }
  }
  renderRail();
  renderSubbar();
}

export function setContext({ worldId, sessionId } = {}) {
  if (worldId !== undefined) activeWorldId = worldId;
  if (sessionId !== undefined) activeSessionId = sessionId;
  if (activeWorldId) {
    ui.set({ lastWorldId: activeWorldId });
  }
  if (activeSessionId) {
    ui.set({ lastSessionId: activeSessionId });
  }
  renderRail();
  renderSubbar();
  // 切到某段剧情时，目录栏要显示它所在世界卡的会话列表
  if (activeWorldId) {
    api.listSessions({ world_id: activeWorldId })
      .then((list) => {
        sessions = list || [];
        if (listEl) paintSessions();
      })
      .catch(() => {});
  }
}

/* =========================================================================
 * 初始化
 * ========================================================================= */

export function initShell() {
  window.addEventListener('worlds:changed', () => refresh());
  window.addEventListener('sessions:changed', () => {
    if (!activeWorldId) return;
    api.listSessions({ world_id: activeWorldId })
      .then((list) => { sessions = list || []; paintSessions(); })
      .catch(() => {});
  });
  document.addEventListener('route:changed', (e) => {
    const route = e.detail || matchRoute();
    if (route.name === 'world') {
      setContext({ worldId: route.params.id, sessionId: null });
    } else if (route.name === 'play') {
      renderRail();   // world id 由视图通过 setContext 回填
    } else if (route.name === 'worlds') {
      setContext({ worldId: null, sessionId: null });
    } else {
      renderRail();
      renderSubbar();
    }
  });

  refresh();
}
