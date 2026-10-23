/**
 * views/home.js — 首页（仪表盘）
 *
 * 结构：
 *  - 问候 + 继续阅读大卡（最近一段剧情）
 *  - 指标（剧情数 / 回合 / 字数 / 记忆实体）
 *  - 最近剧情网格 + 新建卡片
 *  - 快捷入口（剧本库 / 设置 / 导出）
 */

import {
  el, clear, formatTime, firstChar, hueFromString, avatarBackground, hueToGradient,
  fmtNumber, truncate,
} from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, openActionSheet, openPopover, confirmDialog, toast } from '../app.js';
import { syncActive, refresh as refreshSidebar } from '../sidebar.js';

export default {
  id: 'home',
  title: '角色剧场',

  async mount(root) {
    let sessions = [];
    let loading = true;

    const nav = el('header.nav', {},
      el('button.icon-btn.nav-hamburger', {
        type: 'button', 'aria-label': '打开会话库',
        onclick: () => import('../sidebar.js').then((m) => m.openSidebar()),
      }, icon('sidebar', { size: 19 })),
      el('div.nav-title', {}, '角色剧场'),
      el('button.icon-btn', {
        type: 'button', 'aria-label': '剧本库', title: '剧本库',
        onclick: () => navigate('#/presets'),
      }, icon('book', { size: 18 })),
      el('button.icon-btn.is-accent', {
        type: 'button', 'aria-label': '设置', title: '设置',
        onclick: () => navigate('#/settings'),
      }, icon('settings', { size: 18 })),
      el('button.btn.btn-primary.btn-sm', {
        type: 'button', style: 'margin-left:2px;', onclick: () => navigate('#/new'),
      }, icon('plus', { size: 15, stroke: 2.2 }), '新建'),
    );

    const scroll = el('div.scroll');
    const view = el('section.view', { 'data-view': 'home' }, nav, scroll);
    root.appendChild(view);

    scroll.addEventListener('scroll', () => {
      nav.classList.toggle('is-scrolled', scroll.scrollTop > 4);
    }, { passive: true });

    /* ---------------- 加载 ---------------- */
    async function load() {
      loading = true;
      render();
      try {
        sessions = (await api.listSessions()) || [];
      } catch (err) {
        sessions = [];
        toast(`加载失败：${err.message}`, { type: 'error' });
      } finally {
        loading = false;
      }
      render();
    }

    /* ---------------- 渲染 ---------------- */
    function render() {
      clear(scroll);
      const box = el('div.container.dash');
      scroll.appendChild(box);

      if (loading) {
        box.appendChild(el('div.skeleton', { style: 'height:32px;width:200px;margin-bottom:8px;' }));
        box.appendChild(el('div.skeleton', { style: 'height:130px;border-radius:22px;margin-top:20px;' }));
        box.appendChild(el('div.skeleton', { style: 'height:76px;border-radius:17px;margin-top:22px;' }));
        return;
      }

      const latest = sessions[0] || null;

      box.appendChild(buildHello(latest));

      if (!sessions.length) {
        box.appendChild(buildFirstRun());
      } else {
        if (latest) box.appendChild(buildResume(latest));
        box.appendChild(buildMetrics());
        box.appendChild(buildRecent());
        box.appendChild(buildQuickTiles());
      }

      syncActive(null);
    }

    function buildHello(latest) {
      const hour = new Date().getHours();
      const greet = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好'
        : hour < 18 ? '下午好' : hour < 22 ? '晚上好' : '夜深了';
      return el('div.dash-hello', {},
        el('div.dash-hello-text', {},
          el('h1.dash-title', {}, greetingTitle(latest, greet)),
          el('div.dash-sub', {}, latest
            ? `已累计 ${sessions.length} 段剧情 · ${fmtNumber(sessions.reduce((s, x) => s + (x.turn_count || 0), 0))} 回合`
            : '写下世界观与角色，AI 会为你演绎长篇互动剧情。'),
        ),
      );
    }

    function greetingTitle(latest, greet) {
      if (!latest) return '欢迎来到角色剧场';
      return `${greet}`;
    }

    /** 继续阅读大卡 */
    function buildResume(s) {
      const hue = hueFromString(s.title || s.id);
      const card = el('button.resume-card', {
        type: 'button',
        onclick: () => navigate(`#/chat/${s.id}`),
      },
        el('div.resume-art', { style: `background:${hueToGradient(hue)};` },
          el('div.resume-art-glyph', {}, firstChar(s.title)),
        ),
        el('div.resume-body', {},
          el('div.resume-kicker', {}, '继续上次剧情'),
          el('div.resume-title', {}, s.title || '未命名剧情'),
          el('div.resume-excerpt', {}, excerptOf(s)),
          el('div.resume-meta', {},
            el('span', {}, `${s.turn_count || 0} 回合`),
            el('span.dot'),
            el('span', {}, formatTime(s.updated_at)),
            el('span', { style: 'margin-left:auto;' },
              el('span.resume-cta', {}, '继续', icon('chevronRight', { size: 13 })),
            ),
          ),
        ),
      );
      return card;
    }

    function excerptOf(s) {
      const text = s.last_message || s.opening_preview || '';
      return text ? truncate(String(text).replace(/\s+/g, ' ').trim(), 110) : '尚未开始剧情';
    }

    function buildMetrics() {
      const totalTurns = sessions.reduce((a, x) => a + (x.turn_count || 0), 0);
      const totalChars = sessions.reduce((a, x) => a + (x.turn_count || 0) * 2200, 0);
      const tags = new Set(sessions.flatMap((s) => s.style_tags || []));
      return el('div.metrics', {},
        metric(fmtNumber(sessions.length), '段剧情'),
        metric(fmtNumber(totalTurns), '累计回合'),
        metric(totalChars >= 10000 ? `${Math.round(totalChars / 10000)}万` : fmtNumber(totalChars), '估算字数'),
        metric(fmtNumber(tags.size), '种风格'),
      );
    }

    function metric(value, label) {
      return el('div.metric', {},
        el('div.metric-value', {}, value),
        el('div.metric-label', {}, label),
      );
    }

    function buildRecent() {
      const wrap = el('div', {});
      const rest = sessions.slice(1);
      wrap.appendChild(el('div.sect', {},
        el('div.sect-title', {}, '全部剧情'),
        el('button.sect-link', {
          type: 'button',
          onclick: () => import('../sidebar.js').then((m) => m.openSidebar()),
        }, '侧栏查看更多', icon('chevronRight', { size: 13 })),
      ));

      const grid = el('div.story-grid');
      sessions.slice(0, 12).forEach((s, i) => grid.appendChild(storyCard(s, i)));
      grid.appendChild(el('button.story.is-new', {
        type: 'button', onclick: () => navigate('#/new'),
      },
        el('span.plus-ring', {}, icon('plus', { size: 18, stroke: 2.2 })),
        el('span.new-label', {}, '创建新剧情'),
      ));
      wrap.appendChild(grid);
      return wrap;
    }

    function storyCard(s, i) {
      const hue = hueFromString(s.title || s.id);
      return el('div.story', {
        style: `--stagger:${Math.min(i * 24, 240)}ms;`,
        onclick: () => navigate(`#/chat/${s.id}`),
        role: 'button', tabindex: '0',
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`#/chat/${s.id}`); },
      },
        el('div.story-head', {},
          el('div.story-art', { style: `background:${avatarBackground(hue)};` }, firstChar(s.title)),
          el('div', { style: 'flex:1;min-width:0;' },
            el('div.story-name', {}, s.title || '未命名剧情'),
            (s.style_tags || []).length
              ? el('div.story-tags', {}, ...(s.style_tags || []).slice(0, 2).map((t) => el('span.chip', {}, t)))
              : null,
          ),
        ),
        el('div.story-excerpt', {}, excerptOf(s)),
        el('div.story-foot', {},
          el('span', {}, `${s.turn_count || 0} 回合`),
          el('span.dot'),
          el('span', {}, formatTime(s.updated_at)),
        ),
        el('span.story-menu', {
          role: 'button', 'aria-label': '更多操作',
          onclick: async (e) => {
            e.stopPropagation();
            const action = await openActionSheet({
              title: s.title || '未命名剧情',
              actions: [
                { label: '进入剧情', value: 'open', icon: 'play' },
                { label: '编辑设定', value: 'edit', icon: 'edit' },
                { label: '继续上次剧情', value: 'open' },
                { label: '导出剧情', value: 'export', icon: 'download' },
                { label: '删除剧情', value: 'delete', icon: 'trash', destructive: true },
              ],
            });
            if (action === 'open') navigate(`#/chat/${s.id}`);
            else if (action === 'edit') navigate(`#/edit/${s.id}`);
            else if (action === 'export') {
              try {
                const { exportMarkdown } = await import('../export.js');
                await exportMarkdown(s.id);
              } catch (err) { toast(err.message, { type: 'error' }); }
            } else if (action === 'delete') {
              const ok = await confirmDialog({
                title: '删除剧情',
                message: `「${s.title}」的全部回合与记忆将被永久删除。`,
                confirmText: '删除', destructive: true,
              });
              if (ok) {
                await api.deleteSession(s.id);
                toast('已删除', { type: 'success' });
                load();
                refreshSidebar();
              }
            }
          },
        }, icon('more', { size: 15 })),
      );
    }

    function buildQuickTiles() {
      return el('div.quick-row', {},
        tile('book', '剧本库', '从成品设定直接开局', () => navigate('#/presets')),
        tile('plus', '新建剧情', '从头写世界观与角色', () => navigate('#/new')),
        tile('settings', '偏好设置', '外观、字号、阅读宽度', () => navigate('#/settings')),
      );
    }

    function tile(iconName, title, sub, onClick) {
      return el('button.quick-tile', { type: 'button', onclick: onClick },
        el('span.quick-tile-icon', {}, icon(iconName, { size: 17 })),
        el('span.quick-tile-text', {},
          el('span.quick-tile-title', {}, title),
          el('span.quick-tile-sub', {}, sub),
        ),
      );
    }

    function buildFirstRun() {
      const steps = [
        ['设定', '世界观、角色卡与开场白，决定故事的底色'],
        ['演绎', '每轮数千字沉浸式叙述，流式呈现'],
        ['抉择', '3-4 个分支选项，或自由输入你的行动'],
      ];
      return el('div', {},
        el('div.firstrun', {},
          el('div.firstrun-art', {}, icon('wand', { size: 34, stroke: 1.5 })),
          el('div.firstrun-title', {}, '剧场还空着'),
          el('div.firstrun-sub', {},
            '先写下一段世界观与一位角色，剩下的交给演绎引擎。也可以从剧本库挑一份成品设定直接开局。',
          ),
          el('div', { style: 'display:flex;gap:9px;margin-top:16px;' },
            el('button.btn.btn-primary.btn-lg', { type: 'button', onclick: () => navigate('#/new') },
              icon('plus', { size: 17, stroke: 2.2 }), '创建第一段剧情'),
            el('button.btn.btn-secondary.btn-lg', { type: 'button', onclick: () => navigate('#/presets') },
              icon('book', { size: 16 }), '浏览剧本库'),
          ),
          el('div.firstrun-steps', {},
            ...steps.map(([t, d], i) => el('div.firstrun-step', {},
              el('div.firstrun-step-num', {}, String(i + 1)),
              el('div', {},
                el('div.firstrun-step-title', {}, t),
                el('div.firstrun-step-text', {}, d),
              ),
            )),
          ),
        ),
      );
    }

    load();

    return { unmount() {} };
  },
};
