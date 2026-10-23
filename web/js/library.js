/**
 * library.js — 仪表盘视图（主区）
 *
 * 桌面双栏下的「家」页面：
 *  - Hero：欢迎语 + 主操作（创建剧情 / 继续最近）
 *  - 统计：剧情数 / 总回合 / 记忆实体
 *  - 最近故事卡片网格（进入 / 菜单：编辑·导出·删除）
 *  - 首次使用空态：插画 + 三步上手指南
 */
import { $, el, clear, truncate } from './util.js';
import { api } from './api.js';
import { navigate, openActionSheet, confirmDialog, toast, toggleTheme } from './app.js';
import { openSidebar, refresh as refreshSidebar, syncActive } from './sidebar.js';
import { ui } from './store.js';

export default {
  id: 'library',
  title: '角色剧场',

  async mount(root) {
    let sessions = [];
    let loading = true;

    /* ---------------- 导航栏 ---------------- */
    const navBar = el('header.main-nav', {},
      el('button.main-nav-btn.icon-only.nav-hamburger', {
        type: 'button', 'aria-label': '打开会话库', onclick: () => openSidebar(),
      }, '☰'),
      el('span.main-nav-title', {}, '角色剧场'),
      el('button.main-nav-btn.icon-only', {
        type: 'button', 'aria-label': '切换外观', title: '切换外观（浅色/深色/系统）',
        onclick: () => toggleTheme(),
      }, ui.get().theme === 'dark' ? '☀️' : '☾'),
      el('button.main-nav-btn.icon-only', {
        type: 'button', 'aria-label': '新建剧情', title: '新建剧情',
        onclick: () => navigate('#/setup'),
      }, '+'),
    );

    /* ---------------- 内容 ---------------- */
    const scroll = el('div.main-scroll');
    const view = el('section.view', { 'data-view': 'library' }, navBar, scroll);
    root.appendChild(view);

    /* ---------------- 加载 ---------------- */
    async function load() {
      loading = true;
      render();
      try {
        sessions = (await api.listSessions()) || [];
      } catch (err) {
        sessions = [];
        toast(`加载失败：${err.message}`);
      } finally {
        loading = false;
      }
      render();
    }

    /* ---------------- 渲染 ---------------- */
    function render() {
      clear(scroll);
      const dash = el('div.dash');

      if (loading) {
        dash.appendChild(el('div.dash-hero', { style: 'opacity:0.55;' },
          el('div.dash-hero-badge', {}, '剧'),
          el('div.dash-hero-body', {},
            el('div.dash-hero-title', {}, '正在加载剧场…'),
            el('div.dash-hero-sub', {}, '读取你的剧情会话'),
          ),
        ));
        scroll.appendChild(dash);
        return;
      }

      const recent = sessions.slice(0, 6);
      const totalTurns = sessions.reduce((s, x) => s + (x.turn_count || 0), 0);
      const allTags = new Set(sessions.flatMap(s => (s.style_tags || s.settings?.style_tags || [])));

      dash.appendChild(buildHero(recent[0]));

      if (sessions.length) {
        dash.appendChild(el('div.dash-stats', {},
          statCard(String(sessions.length), '段剧情'),
          statCard(String(totalTurns), '累计回合'),
          statCard(String(allTags.size), '种风格'),
        ));
      }

      if (!sessions.length) {
        dash.appendChild(buildFirstRun());
      } else {
        dash.appendChild(el('div.dash-section-head', {},
          el('div.dash-section-title', {}, '最近剧情'),
          sessions.length > 6
            ? el('button.dash-section-link', { type: 'button', onclick: () => openSidebar() }, '查看全部 →')
            : null,
        ));
        const grid = el('div.dash-grid');
        for (const s of recent) grid.appendChild(storyCard(s));
        grid.appendChild(el('button.story-card.is-new', {
          type: 'button', onclick: () => navigate('#/setup'),
        },
          el('span.new-icon', {}, '+'),
          el('span.new-label', {}, '创建新剧情'),
        ));
        dash.appendChild(grid);
      }

      scroll.appendChild(dash);
    }

    function buildHero(latest) {
      return el('div.dash-hero', {},
        el('div.dash-hero-badge', {}, '剧'),
        el('div.dash-hero-body', {},
          el('div.dash-hero-title', {}, latest ? '欢迎回到剧场' : '欢迎来到角色剧场'),
          el('div.dash-hero-sub', {},
            latest
              ? `继续「${truncate(latest.title, 18)}」，或开启一段新的故事。`
              : '写下世界观与角色，AI 会为你演绎长篇互动剧情——每一轮都由你选择走向。',
          ),
          el('div.dash-hero-actions', {},
            el('button.btn-filled', {
              type: 'button',
              onclick: () => latest ? navigate(`#/chat/${latest.id}`) : navigate('#/setup'),
            }, latest ? '继续上次剧情' : '创建第一个角色'),
            latest
              ? el('button.btn-tinted', { type: 'button', onclick: () => navigate('#/setup') }, '创建新剧情')
              : el('button.btn-tinted', { type: 'button', onclick: () => navigate('#/settings') }, '先看看设置'),
          ),
        ),
      );
    }

    function buildFirstRun() {
      return el('div.dash-empty', {},
        emptyIllustration(),
        el('div.dash-empty-title', {}, '剧场还空着'),
        el('div.dash-empty-sub', {},
          '创建你的第一个角色：写下世界观、角色卡与开场白，故事从这里开始。',
        ),
        el('button.btn-filled', { type: 'button', onclick: () => navigate('#/setup') }, '+ 创建你的第一个角色'),
        el('div.dash-tips', {},
          tip('📖', '提供', '开场白、世界观、角色与扮演规则'),
          tip('🎭', '演绎', '每轮数千字沉浸式剧情，流式呈现'),
          tip('🧠', '记忆', '上千轮不失忆，上下文始终低于 200K'),
        ),
      );
    }

    function storyCard(s) {
      const card = el('button.story-card', {
        type: 'button',
        onclick: () => navigate(`#/chat/${s.id}`),
      },
        el('div.story-card-head', {},
          el('div.story-card-avatar', { style: avatarBg(s.title || s.id) }, (s.title || '?').trim().charAt(0)),
          el('div', { style: 'min-width:0;flex:1;' },
            el('div.story-card-title', {}, s.title || '未命名剧情'),
            el('div.story-card-tags', {},
              ...(s.style_tags || s.settings?.style_tags || []).slice(0, 2).map(t => el('span.chip', {}, t)),
            ),
          ),
        ),
        el('div.story-card-summary', {}, s.last_message || s.settings?.opening || '尚未开始剧情'),
        el('div.story-card-foot', {},
          el('span', {}, `${s.turn_count || 0} 回合`),
          el('span.dot'),
          el('span', {}, relTime(s.updated_at)),
        ),
        el('button.story-card-menu', {
          type: 'button', title: '更多操作', 'aria-label': '更多操作',
          onclick: async (e) => {
            e.stopPropagation();
            const action = await openActionSheet({
              title: s.title || '未命名剧情',
              actions: [
                { label: '进入剧情', value: 'open' },
                { label: '编辑设定', value: 'edit' },
                { label: '导出 Markdown', value: 'export' },
                { label: '删除剧情', value: 'delete', destructive: true },
              ],
            });
            if (action === 'open') navigate(`#/chat/${s.id}`);
            else if (action === 'edit') navigate(`#/setup/${s.id}`);
            else if (action === 'export') exportSession(s.id);
            else if (action === 'delete') {
              const ok = await confirmDialog({
                title: '删除剧情', message: `「${s.title}」的所有回合与记忆将被永久删除。`, confirmText: '删除', destructive: true,
              });
              if (ok) {
                await api.deleteSession(s.id);
                toast('已删除');
                refreshSidebar();
                load();
              }
            }
          },
        }, '⋯'),
      );
      return card;
    }

    /* ---------------- 工具 ---------------- */
    function statCard(value, label) {
      return el('div.dash-stat', {},
        el('div.dash-stat-value', {}, value),
        el('div.dash-stat-label', {}, label),
      );
    }

    function tip(icon, lead, text) {
      return el('div.dash-tip', {},
        el('span.dash-tip-icon', {}, icon),
        el('div', {}, el('b', {}, lead + '　'), text),
      );
    }

    function emptyIllustration() {
      const svg = `<svg class="dash-empty-ill" viewBox="0 0 108 108" fill="none">
        <defs>
          <linearGradient id="eg1" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#00A9FF"/><stop offset="1" stop-color="#AF52DE"/>
          </linearGradient>
        </defs>
        <rect x="14" y="20" width="80" height="68" rx="14" fill="url(#eg1)" opacity="0.14"/>
        <rect x="22" y="14" width="64" height="80" rx="13" fill="url(#eg1)" opacity="0.22"/>
        <rect x="30" y="8" width="48" height="92" rx="12" fill="url(#eg1)"/>
        <path d="M44 34v14M54 34v14M44 41h10" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>
        <path d="M42 62h24M42 72h16" stroke="#fff" stroke-width="3.4" stroke-linecap="round" opacity="0.85"/>
      </svg>`;
      const wrap = el('div');
      wrap.innerHTML = svg;
      return wrap.firstElementChild;
    }

    load();
    syncActive(null);

    return {
      unmount() { /* 无全局监听需要清理 */ },
    };
  },
};

/* ---------------- 模块级工具 ---------------- */

function hueFromString(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function avatarBg(text) {
  const h = hueFromString(text);
  return `linear-gradient(135deg, hsl(${h}, 82%, 62%), hsl(${(h + 48) % 360}, 76%, 52%))`;
}

function relTime(ts) {
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
