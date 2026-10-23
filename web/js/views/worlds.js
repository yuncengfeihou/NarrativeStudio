/**
 * views/worlds.js — 世界卡总览
 */

import { el, clear } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, openActionSheet, confirmDialog } from '../app.js';
import { hueTint } from '../ui-kit.js';

export default {
  id: 'worlds',
  title: '世界卡',

  async mount(root) {
    let worlds = [];
    let loading = true;

    const nav = el('header.topbar', {},
      el('button.icon-btn.mobile-only', {
        type: 'button', 'aria-label': '目录',
        onclick: () => import('../shell.js').then((m) => m.openDrawer()),
      }, icon('sidebar', { size: 17 })),
      el('div.topbar-title', {}, '世界卡'),
      el('div.topbar-actions', {},
        el('button.btn.btn-secondary.btn-sm', {
          type: 'button', onclick: () => navigate('#/settings'),
        }, icon('settings', { size: 13 }), '设置'),
        el('button.btn.btn-primary.btn-sm', {
          type: 'button', onclick: () => navigate('#/new'),
        }, icon('plus', { size: 13 }), '新建'),
      ),
    );

    const scroll = el('div.scroll');
    const view = el('section.view', { 'data-view': 'worlds' }, nav, scroll);
    root.appendChild(view);

    async function load() {
      loading = true;
      render();
      try {
        worlds = (await api.listWorlds()) || [];
      } catch (err) {
        worlds = [];
        toast(`加载失败：${err.message}`, { type: 'error' });
      } finally {
        loading = false;
      }
      render();
    }

    function render() {
      clear(scroll);
      const page = el('div.page');
      scroll.appendChild(page);

      if (loading) {
        page.appendChild(el('div.skeleton', { style: 'height:22px;width:180px;' }));
        page.appendChild(el('div.skeleton', { style: 'height:60px;margin-top:16px;border-radius:10px;' }));
        page.appendChild(el('div.skeleton', { style: 'height:60px;margin-top:8px;border-radius:10px;' }));
        return;
      }

      page.appendChild(el('div.page-head', {},
        el('div.page-head-text', {},
          el('h1.page-title', {}, '世界卡'),
          el('div.page-sub', {},
            worlds.length
              ? `${worlds.length} 张卡 · 一共 ${worlds.reduce((s, w) => s + (w.session_count || 0), 0)} 段剧情`
              : '一张世界卡 = 一套设定。可以从它开出任意多段剧情。'),
        ),
      ));

      if (!worlds.length) {
        page.appendChild(el('div.empty', {},
          el('div.empty-icon', {}, icon('book', { size: 20 })),
          el('div.empty-title', {}, '还没有世界卡'),
          el('div.empty-sub', {},
            '世界卡承载这个世界的一切：宪章、人物、辞书、时间线。有了它，每一次开局都不必重写一遍。'),
          el('button.btn.btn-primary', { type: 'button', onclick: () => navigate('#/new') },
            icon('plus', { size: 13 }), '创建第一张卡'),
        ));
        return;
      }

      const list = el('div.worlds-list');
      worlds.forEach((w) => list.appendChild(worldRow(w, load)));
      page.appendChild(list);

      page.appendChild(el('div.group-note', { style: 'padding-top:14px;' },
        '提示：世界卡的「辞书」靠实体在场、主题匹配或你手动钉选进入上下文，不靠关键词触发——所以卡可以写得很细，却不会撑爆提示词。'));
    }

    load();
    return { unmount() {} };
  },
};

function worldRow(w, reload) {
  const card = w.card || {};
  return el('div.world-row', {
    role: 'button', tabindex: '0',
    onclick: () => navigate(`#/world/${w.id}`),
    onkeydown: (e) => { if (e.key === 'Enter') navigate(`#/world/${w.id}`); },
  },
    el('div.world-spine', { style: `background:${hueTint(w.cover_hue, { s: 40, l: 45 })};` }),
    el('div.world-body', {},
      el('div.world-name', {}, w.title || '未命名世界'),
      el('div.world-sub', {}, w.subtitle || card.subtitle || '还没有写简介'),
    ),
    el('div.world-facts', {},
      fact(w.session_count || 0, '剧情'),
      fact(card.codex_count || (card.codex || []).length, '辞书'),
      fact((card.cast || []).length, '人物'),
    ),
    el('span.icon-btn', {
      role: 'button', 'aria-label': '更多操作',
      onclick: async (e) => {
        e.stopPropagation();
        const action = await openActionSheet({
          title: w.title,
          actions: [
            { label: '查看世界卡', value: 'open', icon: 'book' },
            { label: '编辑设定', value: 'edit', icon: 'edit' },
            { label: '开始新剧情', value: 'play', icon: 'play' },
            { label: '删除世界卡', value: 'delete', icon: 'trash', destructive: true },
          ],
        });
        if (action === 'open') navigate(`#/world/${w.id}`);
        else if (action === 'edit') navigate(`#/edit/${w.id}`);
        else if (action === 'play') {
          try {
            const s = await api.createWorldSession(w.id, {});
            window.dispatchEvent(new CustomEvent('worlds:changed'));
            navigate(`#/play/${s.id}`);
          } catch (err) { toast(err.message, { type: 'error' }); }
        } else if (action === 'delete') {
          const ok = await confirmDialog({
            title: '删除世界卡',
            message: `「${w.title}」以及它的全部设定会被删除。已经开出的剧情会话会保留，但不再关联这张卡。`,
            confirmText: '删除', destructive: true,
          });
          if (!ok) return;
          await api.deleteWorld(w.id);
          toast('已删除');
          window.dispatchEvent(new CustomEvent('worlds:changed'));
          reload();
        }
      },
    }, icon('more', { size: 14 })),
  );
}

function fact(value, label) {
  return el('div.world-fact', {},
    el('div.world-fact-v', {}, String(value)),
    el('div.world-fact-k', {}, label),
  );
}
