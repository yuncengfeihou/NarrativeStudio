/**
 * views/presets.js — 剧本库
 *
 * 一份「预设」= 可直接开局的完整设定（世界观 / 角色卡 / 玩家身份 / 规则 / 开场白）。
 * 用户点开可以直接开局，也可以复制一份改成自己的。
 */

import { el, clear, firstChar, hueFromString, hueToGradient, truncate } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, showLoading, hideLoading, openActionSheet, openSheet } from '../app.js';

export default {
  id: 'presets',
  title: '剧本库',

  async mount(root) {
    let presets = [];
    let loading = true;

    const nav = el('header.nav', {},
      el('button.icon-btn.nav-hamburger', {
        type: 'button', 'aria-label': '会话库',
        onclick: () => import('../sidebar.js').then((m) => m.openSidebar()),
      }, icon('sidebar', { size: 19 })),
      el('button.nav-back', { type: 'button', onclick: () => navigate('#/') },
        icon('chevronLeft', { size: 19, stroke: 2.2 }), '首页'),
      el('div.nav-title', {}, '剧本库'),
      el('button.icon-btn', {
        type: 'button', title: '新建空白剧情', 'aria-label': '新建',
        onclick: () => navigate('#/new'),
      }, icon('plus', { size: 19, stroke: 2 })),
    );

    const scroll = el('div.scroll');
    const view = el('section.view', { 'data-view': 'presets' }, nav, scroll);
    root.appendChild(view);

    scroll.addEventListener('scroll', () => {
      nav.classList.toggle('is-scrolled', scroll.scrollTop > 4);
    }, { passive: true });

    async function load() {
      loading = true;
      render();
      try {
        presets = (await api.listPresets()) || [];
      } catch (err) {
        presets = [];
        toast(`剧本库加载失败：${err.message}`, { type: 'error' });
      } finally {
        loading = false;
      }
      render();
    }

    function render() {
      clear(scroll);
      const box = el('div.container', {});
      scroll.appendChild(box);

      if (loading) {
        box.appendChild(el('div.skeleton', { style: 'height:26px;width:160px;' }));
        box.appendChild(el('div.preset-grid', { style: 'margin-top:18px;' },
          el('div.skeleton', { style: 'height:190px;border-radius:17px;' }),
          el('div.skeleton', { style: 'height:190px;border-radius:17px;' }),
        ));
        return;
      }

      box.appendChild(el('div.page-head', {},
        el('div.page-title', {}, '剧本库'),
        el('div.page-sub', {}, '挑一份成品设定直接开局，完成后可以改成你自己的版本。'),
      ));

      if (!presets.length) {
        box.appendChild(el('div.empty', {},
          el('div.empty-icon', {}, icon('book', { size: 26 })),
          el('div.empty-title', {}, '剧本库还是空的'),
          el('div.empty-sub', {}, '把任意一份设定保存为预设，它就会出现在这里。也可以从零新建一段剧情。'),
          el('button.btn.btn-primary', { type: 'button', onclick: () => navigate('#/new') },
            icon('plus', { size: 15, stroke: 2.2 }), '新建剧情'),
        ));
        return;
      }

      const grid = el('div.preset-grid');
      presets.forEach((p, i) => grid.appendChild(presetCard(p, i)));
      box.appendChild(grid);
    }

    function presetCard(p, i) {
      const hue = p.accent_hue ?? hueFromString(p.title);
      return el('button.preset', {
        type: 'button',
        style: `--stagger:${Math.min(i * 30, 300)}ms;`,
        onclick: () => previewPreset(p),
      },
        el('div.preset-banner', { style: `background:${hueToGradient(hue, { s: 62, l: 54 })};` },
          el('div.preset-banner-glyph', {}, firstChar(p.title)),
        ),
        el('div.preset-body', {},
          el('div.preset-name', {}, p.title),
          p.tags.length
            ? el('div.preset-cast', {}, ...p.tags.slice(0, 3).map((t) => el('span.chip.is-purple', {}, t)))
            : null,
          el('div.preset-sub', {}, p.subtitle || p.worldview_preview || p.opening_preview || ''),
          p.characters.length
            ? el('div.preset-cast', {},
              ...p.characters.slice(0, 4).map((c) => el('span.chip', {}, c.name)),
              p.characters.length > 4 ? el('span.chip', {}, `+${p.characters.length - 4}`) : null,
            )
            : null,
        ),
      );
    }

    async function previewPreset(p) {
      showLoading('读取剧本…');
      let full = null;
      try {
        full = await api.getPreset(p.id);
      } catch (err) {
        hideLoading();
        toast(err.message, { type: 'error' });
        return;
      }
      hideLoading();

      const s = full.settings || {};
      openSheet({
        title: p.title,
        confirmText: '用这份开局',
        cancelText: '关闭',
        async onConfirm() {
          try {
            const session = await api.createSession({ title: s.title || p.title, settings: s });
            window.dispatchEvent(new CustomEvent('sessions:changed'));
            toast('已创建，开始演绎', { type: 'success' });
            // 等面板关闭动画结束后再跳转，避免节点被提前卸载
            setTimeout(() => navigate(`#/chat/${session.id}`), 160);
            return true;
          } catch (err) {
            toast(err.message, { type: 'error' });
            return false;
          }
        },
        render(body) {
          body.appendChild(el('div', { style: 'padding:6px 16px 8px;' },
            p.tags.length ? el('div', { style: 'display:flex;gap:5px;flex-wrap:wrap;margin-bottom:12px;' },
              ...p.tags.map((t) => el('span.chip.is-purple', {}, t))) : null,

            s.worldview ? el('div', { style: 'margin-bottom:16px;' },
              el('div.group-title', { style: 'padding:0 0 6px;' }, '世界观'),
              el('div', {
                style: 'font-size:var(--fs-footnote);line-height:1.75;color:var(--label-secondary);white-space:pre-wrap;max-height:180px;overflow-y:auto;',
              }, s.worldview),
            ) : null,

            (s.characters || []).length ? el('div', { style: 'margin-bottom:16px;' },
              el('div.group-title', { style: 'padding:0 0 6px;' }, `登场角色（${s.characters.length}）`),
              el('div.group-card', {},
                ...s.characters.map((c) => el('div.li', {},
                  el('div.li-icon', {
                    style: `background:${hueToGradient(typeof c.avatar_hue === 'number' ? c.avatar_hue : hueFromString(c.name))};color:#fff;`,
                  }, firstChar(c.name)),
                  el('div.li-body', {},
                    el('div.li-title', {}, c.name),
                    el('div.li-sub', {}, [c.role, c.personality].filter(Boolean).join(' · ')),
                  ),
                )),
              ),
            ) : null,

            s.player_role ? el('div', { style: 'margin-bottom:16px;' },
              el('div.group-title', { style: 'padding:0 0 6px;' }, '你的身份'),
              el('div', { style: 'font-size:var(--fs-footnote);line-height:1.7;color:var(--label-secondary);white-space:pre-wrap;' },
                s.player_role),
            ) : null,

            s.opening ? el('div', { style: 'margin-bottom:8px;' },
              el('div.group-title', { style: 'padding:0 0 6px;' }, '开场'),
              el('div.gen-preview', { style: 'max-height:200px;' }, s.opening),
            ) : null,
          ));
        },
      });
    }

    load();
    return { unmount() {} };
  },
};
