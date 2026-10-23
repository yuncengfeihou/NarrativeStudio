/**
 * views/world.js — 世界卡详情
 *
 * 一屏看尽这张卡的骨架：宪章 / 主角 / 卡司 / 幕结构 / 词条。
 * 右侧是「开一局」与统计。
 */

import { el, clear, formatTime } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, openSheet, openActionSheet, confirmDialog } from '../app.js';
import { hueTint, hueGlyph } from '../ui-kit.js';

const LORE_CATEGORY_LABEL = {
  setting: '设定', rule: '规则', location: '地点', institution: '制度',
  faction: '势力', character: '人物', item: '物件', mystery: '悬念', foreshadow: '伏笔',
};

export default {
  id: 'world',
  title: '世界卡',

  async mount(root, params) {
    const worldId = params.id;
    if (!worldId) { navigate('#/worlds'); return { unmount() {} }; }

    let world = null;
    let loading = true;
    let loreQuery = '';
    let activeTab = 'charter';

    const nav = el('header.topbar', {},
      el('button.icon-btn.mobile-only', {
        type: 'button', 'aria-label': '目录',
        onclick: () => import('../shell.js').then((m) => m.openDrawer()),
      }, icon('sidebar', { size: 17 })),
      el('div.topbar-title', {}, '世界卡'),
      el('div.topbar-actions', {},
        el('button.btn.btn-ghost.btn-sm', {
          type: 'button', onclick: () => navigate(`#/edit/${worldId}`),
        }, icon('edit', { size: 13 }), '编辑'),
        el('button.btn.btn-primary.btn-sm', {
          type: 'button', onclick: startSession,
        }, icon('play', { size: 12, fill: true }), '开一局'),
      ),
    );

    const scroll = el('div.scroll');
    const view = el('section.view', { 'data-view': 'world' }, nav, scroll);
    root.appendChild(view);

    scroll.addEventListener('scroll', () => {
      nav.classList.toggle('is-scrolled', scroll.scrollTop > 4);
    }, { passive: true });

    /* ---------------- 载入 ---------------- */
    async function load() {
      loading = true;
      render();
      try {
        world = await api.getWorld(worldId);
        document.title = `${world.title} · 叙事台`;
        const shell = await import('../shell.js');
        shell.setContext({ worldId: world.id, sessionId: null });
      } catch (err) {
        loading = false;
        render();
        toast(`加载失败：${err.message}`, { type: 'error' });
        return;
      }
      loading = false;
      render();
    }

    async function startSession() {
      try {
        const s = await api.createWorldSession(worldId, {});
        window.dispatchEvent(new CustomEvent('worlds:changed'));
        toast('已开局', { type: 'success' });
        navigate(`#/play/${s.id}`);
      } catch (err) {
        toast(err.message || '开局失败', { type: 'error' });
      }
    }

    /* ---------------- 渲染 ---------------- */
    function render() {
      clear(scroll);
      const page = el('div.page');
      scroll.appendChild(page);

      if (loading) {
        page.appendChild(el('div.skeleton', { style: 'height:70px;border-radius:8px;' }));
        page.appendChild(el('div.skeleton', { style: 'height:200px;margin-top:20px;border-radius:10px;' }));
        return;
      }
      if (!world) {
        page.appendChild(el('div.empty', {},
          el('div.empty-icon', {}, icon('warn', { size: 20 })),
          el('div.empty-title', {}, '找不到这张世界卡'),
          el('button.btn.btn-secondary', { onclick: () => navigate('#/worlds') }, '返回列表'),
        ));
        return;
      }

      const card = world.card || {};
      const lore = world.lore || [];
      const sessions = world.sessions || [];

      const grid = el('div.wk');
      const main = el('div.wk-main');
      const side = el('div.wk-side');
      grid.appendChild(main);
      grid.appendChild(side);
      page.appendChild(grid);

      main.appendChild(hero(world, card));
      main.appendChild(tabBar());

      const panes = el('div', {});
      panes.appendChild(pane('charter', charterPane(card)));
      panes.appendChild(pane('cast', castPane(card)));
      panes.appendChild(pane('arcs', arcsPane(card)));
      panes.appendChild(pane('lore', lorePane(lore)));
      main.appendChild(panes);

      side.appendChild(statsCard(world, card, lore, sessions));
      side.appendChild(sessionsCard(sessions));
      side.appendChild(sourceCard(world));
    }

    function hero(w, card) {
      const tags = (w.tags || card.genre || []).slice(0, 6);
      return el('div.wk-hero', {},
        el('div.wk-cover', { style: `background:${hueTint(w.cover_hue, { s: 34, l: 38 })};` },
          [...(w.title || '世')][0]),
        el('div.wk-hero-text', {},
          el('h1.wk-title', {}, w.title),
          el('div.wk-tagline', {}, w.subtitle || card.subtitle || ''),
          tags.length
            ? el('div.wk-tags', {}, ...tags.map((t) => el('span.chip.is-plain', {}, t)))
            : null,
        ),
      );
    }

    function tabBar() {
      const items = [
        ['charter', '宪章', 'scroll'],
        ['cast', `人物 ${(world.card?.cast || []).length}`, 'users'],
        ['arcs', `幕 ${(world.card?.arcs || []).length}`, 'layers'],
        ['lore', `词条 ${(world.lore || []).length}`, 'file'],
      ];
      const bar = el('div.editor-tabs');
      for (const [key, label, iconName] of items) {
        bar.appendChild(el('button.editor-tab', {
          type: 'button',
          class: activeTab === key ? 'is-active' : '',
          onclick: () => {
            activeTab = key;
            Array.from(bar.children).forEach((c, i) => c.classList.toggle('is-active', items[i][0] === key));
            scroll.querySelectorAll('.editor-pane').forEach((p) => {
              p.classList.toggle('is-active', p.dataset.pane === key);
            });
          },
        }, icon(iconName, { size: 13 }), label));
      }
      return bar;
    }

    function pane(name, content) {
      return el('div.editor-pane', {
        class: activeTab === name ? 'is-active' : '',
        dataset: { pane: name },
      }, content);
    }

    /* ---- 宪章 ---- */
    function charterPane(card) {
      const wrap = el('div', {});
      const charter = card.charter || [];

      if (Array.isArray(charter) && charter.length) {
        const list = el('div.wk-charter');
        charter.forEach((c, i) => {
          list.appendChild(el('div.wk-rule', {},
            el('div.wk-rule-num', {}, String(i + 1).padStart(2, '0')),
            el('div', {}, c.rule || c.text || ''),
          ));
        });
        wrap.appendChild(section('世界宪章', list));
      }

      // 主角
      const p = card.player;
      if (p) {
        const rows = [];
        const row = (k, v) => { if (v) rows.push([k, v]); };
        row('身份', [p.name, p.age, p.identity].filter(Boolean).join(' · '));
        row('处境', p.situation);
        row('能力边界', p.capability);
        row('内心声音', p.inner_voice);
        row('想要的', p.wants);
        row('害怕的', p.afraid);

        wrap.appendChild(section('主角',
          el('div.group-card', {}, ...rows.map(([k, v]) => el('div.li', { style: 'align-items:flex-start;padding:10px 14px;' },
            el('div', { style: 'flex:none;width:64px;font-size:var(--fs-caption);font-weight:600;color:var(--ink-4);padding-top:2px;' }, k),
            el('div', { style: 'flex:1;min-width:0;font-size:var(--fs-label);line-height:1.8;color:var(--ink-2);' }, v),
          ))),
        ));
      }

      // 文风
      const style = card.style;
      if (style) {
        const rows = [];
        if (style.pov) rows.push(['视角', style.pov]);
        if (style.voice) rows.push(['文风', style.voice]);
        if (style.length) rows.push(['篇幅', style.length]);
        if (style.tense) rows.push(['时态', style.tense]);
        if (rows.length) {
          wrap.appendChild(section('演出范式',
            el('div.group-card', {}, ...rows.map(([k, v]) => el('div.li', { style: 'align-items:flex-start;padding:10px 14px;' },
              el('div', { style: 'flex:none;width:44px;font-size:var(--fs-caption);font-weight:600;color:var(--ink-4);padding-top:2px;' }, k),
              el('div', { style: 'flex:1;min-width:0;font-size:var(--fs-caption);line-height:1.8;color:var(--ink-2);' }, v),
            ))),
          ));
        }
      }

      // 禁令
      const bans = card.bans || [];
      if (bans.length) {
        wrap.appendChild(section('绝对禁止',
          el('div.group-card', {}, ...bans.map((b, i) => el('div.li', { style: 'align-items:flex-start;padding:9px 14px;' },
            el('div', { style: 'flex:none;width:16px;font-size:var(--fs-caption);font-weight:650;color:var(--danger);' }, String(i + 1)),
            el('div', { style: 'flex:1;min-width:0;font-size:var(--fs-caption);line-height:1.75;color:var(--ink-2);' }, b),
          ))),
        ));
      }

      return wrap;
    }

    /* ---- 人物 ---- */
    function castPane(card) {
      const cast = card.cast || [];
      if (!cast.length) {
        return el('div.empty', {},
          el('div.empty-icon', {}, icon('users', { size: 20 })),
          el('div.empty-title', {}, '还没有人物'),
          el('div.empty-sub', {}, '点右上角「编辑」添加角色卡。'),
        );
      }
      const grid = el('div.cast-grid');
      cast.forEach((c) => grid.appendChild(castCell(c)));

      // 开场种子
      const seed = String(card.opening_seed || '').trim();
      const wrap = el('div', {}, section('卡司', grid));
      if (seed) {
        wrap.appendChild(section('开场种子',
          el('div', { style: 'border:1px solid var(--line);border-radius:var(--r-lg);background:var(--paper-raised);padding:14px;' },
            el('div.prose-block', {}, seed),
          ),
          el('button.btn.btn-ghost.btn-sm', {
            type: 'button', style: 'margin-top:8px;',
            onclick: () => openSeedViewer(card),
          }, icon('expand', { size: 13 }), '展开阅读'),
        ));
      }
      return wrap;
    }

    function castCell(c) {
      return el('button.cast-cell', {
        type: 'button',
        onclick: () => openCastDetail(c),
      },
        el('div.cast-face', { style: hueGlyph(c.avatar_hue) }, [...(c.name || '?')][0]),
        el('div.cast-info', {},
          el('div.cast-name', {},
            c.name,
            c.always ? el('span.chip.is-accent', { style: 'font-size:9px;padding:0 4px;' }, '常驻') : null,
          ),
          el('div.cast-role', {}, c.role || ''),
          c.one_line ? el('div.cast-line', {}, c.one_line) : null,
        ),
      );
    }

    function openCastDetail(c) {
      const rows = [];
      const push = (k, v) => { if (v) rows.push([k, v]); };
      push('定位', c.role);
      push('性格', c.personality);
      push('口吻', c.voice);
      push('与主角', c.relation);
      push('背景', c.background);
      push('习惯', c.manner);
      push('隐秘动机', c.secret);

      openSheet({
        title: c.name,
        cancelText: '关闭',
        render(body) {
          body.appendChild(el('div', {},
            c.one_line ? el('div', {
              style: 'padding:11px 13px;border-radius:8px;background:var(--paper-sunken);border-left:2px solid var(--line-strong);font-size:var(--fs-label);line-height:1.75;color:var(--ink-2);margin-bottom:16px;',
            }, c.one_line) : null,
            ...rows.map(([k, v]) => el('div', {
              style: 'display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--line-soft);align-items:flex-start;',
            },
              el('div', { style: 'flex:none;width:60px;font-size:var(--fs-caption);font-weight:600;color:var(--ink-4);padding-top:2px;' }, k),
              el('div', {
                style: `flex:1;min-width:0;font-size:var(--fs-label);line-height:1.8;color:${k === '隐秘动机' ? 'var(--warn)' : 'var(--ink-2)'};`,
              }, v),
            )),
            (c.alias || []).length
              ? el('div', { style: 'margin-top:14px;display:flex;gap:4px;flex-wrap:wrap;' },
                ...c.alias.map((a) => el('span.chip.is-plain', {}, a)))
              : null,
          ));
        },
      });
    }

    function openSeedViewer(card) {
      openSheet({
        title: '开场种子',
        cancelText: '关闭',
        render(body) {
          body.appendChild(el('div.prose', {}, card.opening_seed || ''));
        },
      });
    }

    /* ---- 幕 ---- */
    function arcsPane(card) {
      const arcs = card.arcs || [];
      if (!arcs.length) {
        return el('div.empty', {},
          el('div.empty-icon', {}, icon('layers', { size: 20 })),
          el('div.empty-title', {}, '还没有幕结构'),
          el('div.empty-sub', {}, '幕结构决定剧情推进的节奏——没有它，演绎容易原地打转。'),
        );
      }
      const list = el('div.arc-list');
      let cursor = 1;
      const defaultTurns = Number(card.arc_turns) || 8;

      arcs.forEach((a, i) => {
        const span = Number(a.turns) || defaultTurns;
        const from = cursor;
        const to = cursor + span - 1;
        cursor = to + 1;

        const beats = el('div.arc-beats');
        (a.beats || []).forEach((b) => beats.appendChild(el('div.arc-beat', {}, b)));
        (a.avoid || []).forEach((b) => beats.appendChild(el('div.arc-beat', { style: 'color:var(--danger);' }, `忌：${b}`)));

        list.appendChild(el('div.arc-row', {},
          el('div.arc-index', {}, String(i + 1).padStart(2, '0')),
          el('div.arc-body', {},
            el('div.arc-title', {},
              a.title || `第 ${i + 1} 幕`,
              el('span.arc-span', {}, `第 ${from}–${to} 轮`),
            ),
            a.goal ? el('div.arc-goal', {}, a.goal) : null,
            beats.children.length ? beats : null,
          ),
        ));
      });
      return section('幕结构', list,
        el('span.sect-action', {}, `${arcs.length} 幕 · 约 ${cursor - 1} 轮`));
    }

    /* ---- 词条 ---- */
    function lorePane(lore) {
      const wrap = el('div', {});

      const searchInput = el('input.field', {
        type: 'text', placeholder: '搜索词条标题或触发词…', value: loreQuery,
        oninput: (e) => { loreQuery = e.target.value; paintLore(); },
      });

      const toolbar = el('div.lore-toolbar', {},
        searchInput,
        el('button.btn.btn-secondary.btn-sm', {
          type: 'button', onclick: () => addLoreEntry(),
        }, icon('plus', { size: 12 }), '新增'),
      );
      wrap.appendChild(toolbar);

      const listEl = el('div.lore-list');
      wrap.appendChild(listEl);

      wrap.appendChild(el('div.group-note', { style: 'padding-top:10px;' },
        '词条只在它的触发词出现在「本轮输入 / 最近若干轮 / 场景账本」里时才进入上下文。常驻词条（如世界骨架）每轮都在。'));

      function paintLore() {
        clear(listEl);
        const q = loreQuery.trim().toLowerCase();
        const items = q
          ? lore.filter((e) => (e.title || '').toLowerCase().includes(q)
            || (e.keys || []).some((k) => String(k).toLowerCase().includes(q))
            || (e.content || '').toLowerCase().includes(q))
          : lore;

        if (!items.length) {
          listEl.appendChild(el('div.empty', { style: 'padding:28px 20px;' },
            el('div.empty-sub', {}, q ? '没有匹配的词条' : '还没有词条'),
          ));
          return;
        }

        items.forEach((e) => {
          const item = el('div.lore-item');
          const head = el('button.lore-head', { type: 'button' },
            e.constant ? el('span.chip.is-accent', { style: 'font-size:9px;padding:0 4px;' }, '常驻') : null,
            el('span.lore-title', {}, e.title || (e.content || '').slice(0, 20)),
            el('span.chip.is-plain', { style: 'font-size:9px;padding:0 4px;' },
              LORE_CATEGORY_LABEL[e.category] || e.category || '设定'),
            el('span.lore-keys', {}, ...(e.keys || []).slice(0, 3).map((k) => el('span.lore-key', {}, k))),
            el('span', { style: 'display:flex;color:var(--ink-4);' }, icon('chevronDown', { size: 12 })),
          );
          head.addEventListener('click', () => item.classList.toggle('is-open'));

          const body = el('div.lore-body', {},
            el('div.lore-content', {}, e.content),
            el('div', { style: 'display:flex;gap:5px;margin-top:10px;' },
              el('button.btn.btn-ghost.btn-sm', {
                type: 'button', onclick: (ev) => { ev.stopPropagation(); editLoreEntry(e); },
              }, '编辑'),
              el('button.btn.btn-ghost.btn-sm', {
                type: 'button', style: 'color:var(--danger);',
                onclick: async (ev) => {
                  ev.stopPropagation();
                  const ok = await confirmDialog({
                    title: '删除词条', message: `「${e.title || '该词条'}」会被删除。`,
                    confirmText: '删除', destructive: true,
                  });
                  if (!ok) return;
                  await api.deleteLore(worldId, e.id);
                  await load();
                },
              }, '删除'),
            ),
          );

          item.appendChild(head);
          item.appendChild(body);
          listEl.appendChild(item);
        });
      }

      paintLore();
      return section('世界词条', wrap,
        el('span.sect-action', {}, `共 ${lore.length} 条`));
    }

    async function addLoreEntry() {
      const draft = { title: '', keys: [], secondary: [], content: '', category: 'setting', constant: false };
      openLoreEditor(draft, async (payload) => {
        await api.addLore(worldId, payload);
        toast('已添加', { type: 'success' });
        await load();
      });
    }

    function editLoreEntry(entry) {
      openLoreEditor(entry, async (payload) => {
        await api.updateLore(worldId, entry.id, payload);
        toast('已保存', { type: 'success' });
        await load();
      });
    }

    function openLoreEditor(draft, onSave) {
      const titleInput = el('input.field', { value: draft.title || '', placeholder: '标题（如「司楼」）' });
      const keysInput = el('input.field', {
        value: (draft.keys || []).join('、'),
        placeholder: '触发词，用顿号分隔（如：司楼、青楼、卖进去）',
      });
      const secondaryInput = el('input.field', {
        value: (draft.secondary || []).join('、'),
        placeholder: '（可选）二次触发词：必须同时命中其中之一才生效',
      });
      const contentInput = el('textarea.field', { rows: 7 });
      contentInput.value = draft.content || '';

      const catSel = el('select.field', { style: 'height:32px;' },
        ...Object.entries(LORE_CATEGORY_LABEL).map(([v, l]) =>
          el('option', { value: v, selected: draft.category === v || undefined }, l)));

      const constSw = el('div.switch', {
        role: 'switch', 'aria-checked': String(!!draft.constant), tabindex: '0',
      }, el('div.switch-knob'));
      let isConst = !!draft.constant;
      constSw.addEventListener('click', () => {
        isConst = !isConst;
        constSw.setAttribute('aria-checked', String(isConst));
      });

      openSheet({
        title: draft.id ? '编辑词条' : '新增词条',
        confirmText: '保存',
        async onConfirm() {
          const content = contentInput.value.trim();
          if (!content) { toast('内容不能为空'); return false; }
          await onSave({
            title: titleInput.value.trim(),
            keys: splitKeys(keysInput.value),
            secondary: splitKeys(secondaryInput.value),
            content,
            category: catSel.value,
            constant: isConst,
            priority: Number(draft.priority) || 50,
          });
          return true;
        },
        render(body) {
          body.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:12px;' },
            field('标题', titleInput),
            field('触发词', keysInput, '任一触发词出现在最近的文本里，这条词条就会进入上下文。'),
            field('二次触发词（可选）', secondaryInput, '用于过滤误触发，比如「凌」太泛，配「玉佩」才生效。'),
            field('内容', contentInput),
            el('div', { style: 'display:flex;gap:10px;' },
              el('div', { style: 'flex:1;' }, field('分类', catSel)),
              el('div', { style: 'flex:none;padding-top:20px;' },
                el('div', { style: 'display:flex;align-items:center;gap:8px;' },
                  constSw,
                  el('span', { style: 'font-size:var(--fs-caption);color:var(--ink-2);' }, '常驻'),
                ),
              ),
            ),
          ));
        },
      });
    }

    /* ---- 侧栏 ---- */
    function statsCard(w, card, lore, sessions) {
      const turns = sessions.reduce((s, x) => s + (x.turn_count || 0), 0);
      return el('div.side-card', {},
        el('div.side-card-head', {}, '概览'),
        el('div.side-card-body', {},
          el('div.side-stats', {},
            stat(`${card.cast?.length || 0}`, '人物'),
            stat(`${card.arcs?.length || 0}`, '幕'),
            stat(`${lore.length}`, '词条'),
            stat(`${lore.filter((e) => e.constant).length}`, '常驻'),
            stat(`${sessions.length}`, '剧情'),
            stat(`${turns}`, '轮次'),
          ),
        ),
      );
    }

    function stat(v, k) {
      return el('div', {},
        el('div.side-stat-v', {}, v),
        el('div.side-stat-k', {}, k),
      );
    }

    function sessionsCard(sessions) {
      const card = el('div.side-card');
      card.appendChild(el('div.side-card-head', {},
        el('span', {}, '剧情会话'),
        el('span', { style: 'font-variant-numeric:tabular-nums;' }, String(sessions.length)),
      ));

      const body = el('div', {});
      if (!sessions.length) {
        body.appendChild(el('div', { style: 'padding:18px 13px;text-align:center;font-size:var(--fs-caption);color:var(--ink-4);line-height:1.7;' },
          '还没有从这张卡开出剧情。'));
      } else {
        sessions.slice(0, 6).forEach((s) => {
          body.appendChild(el('button.li.is-button', {
            type: 'button', style: 'width:100%;text-align:left;',
            onclick: () => navigate(`#/play/${s.id}`),
          },
            el('div.li-body', {},
              el('div.li-title', { style: 'font-size:var(--fs-caption);' }, s.title),
              el('div.li-sub', {}, `${s.turn_count || 0} 轮 · ${formatTime(s.updated_at)}`),
            ),
            el('span.li-accent', {}, icon('chevronRight', { size: 13 })),
          ));
        });
      }
      card.appendChild(body);

      card.appendChild(el('button.li.is-button', {
        type: 'button', style: 'width:100%;text-align:left;border-top:1px solid var(--line);',
        onclick: startSession,
      },
        el('div.li-body', {}, el('div.li-title', { style: 'font-size:var(--fs-caption);color:var(--accent);' }, '＋ 从这张卡开一局')),
      ));
      return card;
    }

    function sourceCard(w) {
      const src = w.source;
      if (!src) return el('div');
      return el('div.side-card', {},
        el('div.side-card-head', {}, '来源'),
        el('div.side-card-body', {},
          el('div', { style: 'font-size:var(--fs-caption);line-height:1.8;color:var(--ink-3);' },
            src.title || '',
            src.chapters ? el('div', {}, `${src.chapters} 章 · ${Math.round((src.chars || 0) / 1000)}K 字`) : null,
          ),
        ),
      );
    }

    function section(title, content, action = null) {
      return el('div', { style: 'margin-bottom:26px;' },
        el('div.sect', {},
          el('span.sect-title', {}, title),
          action,
        ),
        content,
      );
    }

    function field(label, input, hint) {
      return el('div', {},
        el('label.field-label', {}, label),
        input,
        hint ? el('div.field-hint', {}, hint) : null,
      );
    }

    load();
    return {
      unmount() { document.title = '叙事台'; },
    };
  },
};

function splitKeys(text) {
  return String(text || '')
    .split(/[、,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
