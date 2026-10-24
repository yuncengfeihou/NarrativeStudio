/**
 * views/world.js — 世界卡详情
 *
 * 一屏看尽这张卡的骨架：命题 / 宪章 / 卡司 / 辞书 / 时间线 / 可玩时间点。
 * 右侧是「开一局」与统计。
 */

import { el, clear, formatTime } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, openSheet } from '../app.js';
import { hueCover, hueGlyph, slidingThumb } from '../ui-kit.js';

export default {
  id: 'world',
  title: '世界卡',

  async mount(root, params) {
    const worldId = params.id;
    if (!worldId) { navigate('#/worlds'); return { unmount() {} }; }

    let world = null;
    let loading = true;
    let codexQuery = '';
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
      const codex = world.codex || [];
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
      panes.appendChild(pane('timeline', timelinePane(card)));
      panes.appendChild(pane('codex', codexPane(card, codex)));
      main.appendChild(panes);

      side.appendChild(statsCard(world, card, codex, sessions));
      side.appendChild(sessionsCard(sessions));
      side.appendChild(sourceCard(world));
    }

    function hero(w, card) {
      const tags = (w.tags || card.genre || []).slice(0, 6);
      return el('div.wk-hero', {},
        el('div.wk-cover', { style: hueCover(w.cover_hue) },
          [...(w.title || '世')][0]),
        el('div.wk-hero-text', {},
          el('div.eyebrow', {}, 'World Codex'),
          el('h1.wk-title', {}, w.title),
          el('div.wk-tagline', {}, w.subtitle || card.subtitle || ''),
          tags.length
            ? el('div.wk-tags', {}, ...tags.map((t) => el('span.chip.is-plain', {}, t)))
            : null,
          el('div.wk-hero-actions', {},
            el('button.btn.btn-primary', { type: 'button', onclick: startSession },
              icon('play', { size: 13, fill: true }), '开一局'),
            el('button.btn.btn-secondary', {
              type: 'button', onclick: () => navigate(`#/edit/${worldId}`),
            }, icon('edit', { size: 13 }), '编辑设定'),
          ),
        ),
      );
    }

    function tabBar() {
      const card = world.card || {};
      const items = [
        ['charter', '宪章', 'scroll'],
        ['cast', `人物 ${(card.cast || []).length}`, 'users'],
        ['timeline', `时间线 ${(card.timeline || []).length}`, 'layers'],
        ['codex', `辞书 ${(world.codex || []).length}`, 'book'],
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
            syncThumb();
          },
        }, icon(iconName, { size: 13 }), label));
      }
      const syncThumb = slidingThumb(bar, '.editor-tab');
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
      const prompt = card.prompt || {};
      if (prompt) {
        const rows = [];
        if (prompt.pov) rows.push(['视角', prompt.pov]);
        if (prompt.style_guide) rows.push(['文风', prompt.style_guide]);
        if (prompt.length) rows.push(['篇幅', prompt.length]);
        if (prompt.tense) rows.push(['时态', prompt.tense]);
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
      const bans = prompt.bans || [];
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

      // 开场种子（v4：每个可玩时间点各有一份）
      const anchor = (card.anchors || [])[0];
      const seed = String(anchor?.opening_seed || '').trim();
      const premise = String(card.prompt?.premise || '').trim();
      const wrap = el('div', {}, section('卡司', grid));
      if (premise) {
        wrap.appendChild(section('命题',
          el('div.premise-block', {}, premise),
          el('p.sect-desc', {}, '这是这个故事要往哪去。它是方向，不是剧本——剧情具体怎么走由玩家和角色决定。'),
        ));
      }
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
        el('div.cast-face', { style: hueGlyph(world?.cover_hue) }, [...(c.name || '?')][0]),
        el('div.cast-info', {},
          el('div.cast-name', {},
            c.name,
            c.always_present ? el('span.chip.is-accent', { style: 'font-size:9px;padding:0 4px;' }, '常驻') : null,
          ),
          el('div.cast-role', {}, c.role || ''),
          c.one_line ? el('div.cast-line', {}, c.one_line) : null,
        ),
      );
    }

    function openCastDetail(c) {
      const identity = c.identity || {};
      const voice = c.voice || {};
      const psyche = c.psyche || {};
      const knowledge = c.knowledge || {};
      const rows = [];
      const push = (k, v) => { if (v) rows.push([k, v]); };
      const list = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).join('；') : '');

      push('定位', c.role);
      push('年龄', identity.age);
      push('外貌', identity.appearance);
      push('身份', identity.station);
      push('背景', identity.background);
      push('口吻', voice.rhythm);
      push('常用词', list(voice.lexicon));
      push('绝不说', list(voice.never));
      push('原声', list(voice.exemplars));
      push('想要', list(psyche.wants));
      push('害怕', list(psyche.fears));
      push('藏着', list(psyche.hides));
      push('在意', list(psyche.values));
      push('知道', list(knowledge.knows));
      push('不知道', list(knowledge.does_not_know));
      push('误信', list(knowledge.believes_falsely));
      const agenda = (c.agenda || [])
        .map((a) => [a.goal, a.method].filter(Boolean).join('——'))
        .filter(Boolean);
      push('私心', agenda.join('；'));
      const relations = (c.relations || [])
        .map((r) => [`${r.to}`, r.kind, r.note].filter(Boolean).join('｜'))
        .filter(Boolean);
      push('关系', relations.join('；'));

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
                style: `flex:1;min-width:0;font-size:var(--fs-label);line-height:1.8;color:${k === '藏着' ? 'var(--warn)' : 'var(--ink-2)'};`,
              }, v),
            )),
            (c.aliases || []).length
              ? el('div', { style: 'margin-top:14px;display:flex;gap:4px;flex-wrap:wrap;' },
                ...c.aliases.map((a) => el('span.chip.is-plain', {}, a)))
              : null,
          ));
        },
      });
    }

    function openSeedViewer(card) {
      const anchor = (card.anchors || [])[0];
      openSheet({
        title: `开场种子 · ${anchor?.label || '序章'}`,
        cancelText: '关闭',
        render(body) {
          body.appendChild(el('div.prose', {}, anchor?.opening_seed || ''));
        },
      });
    }

    /* ---- 时间线 ---- */
    function timelinePane(card) {
      const events = card.timeline || [];
      const past = events.filter((e) => e.canon === 'past');
      const future = events.filter((e) => e.canon === 'future');
      const anchors = card.anchors || [];

      const wrap = el('div', {});

      if (anchors.length) {
        wrap.appendChild(el('div.sect', {},
          el('h3.sect-title', {}, '可玩时间点'),
          el('p.sect-desc', {}, '从哪个时间点开局。默认第一个（通常是序章）。'),
          el('div.anchor-list', {}, ...anchors.map((a, i) => el('div.anchor', {},
            el('span.anchor-label', {}, a.label + (i === 0 ? ' · 默认' : '')),
            a.note ? el('span.anchor-note', {}, a.note) : null,
          ))),
        ));
      }

      wrap.appendChild(el('div.sect', {},
        el('h3.sect-title', {}, '起点之前 · 既定事实'),
        el('p.sect-desc', {}, '开局时这些事已经发生过，剧情必须与之自洽。'),
        past.length
          ? el('div.tl-list', {}, ...past.map((e) => el('div.tl-item', {},
              el('span.tl-when', {}, e.when || '—'),
              el('span.tl-what', {}, e.what),
              e.source ? el('span.tl-src', {}, e.source) : null,
            )))
          : el('p.muted', {}, '（原创世界：起点之前没有既定事实，一切从开局开始长。）'),
      ));

      wrap.appendChild(el('div.sect', {},
        el('h3.sect-title', {}, '原著后续 · 参考'),
        el('p.sect-desc', {}, '这些是原著里后来发生的事。它们只作校勘参考，不会注入提示词，也不作为演绎目标——玩家把剧情带偏是正常玩法。'),
        future.length
          ? el('div.tl-list.is-future', {}, ...future.map((e) => el('div.tl-item', {},
              el('span.tl-when', {}, e.when || '—'),
              el('span.tl-what', {}, e.what),
              e.source ? el('span.tl-src', {}, e.source) : null,
            )))
          : el('p.muted', {}, '（无）'),
      ));

      return wrap;
    }

    /* ---- 辞书 ---- */
    const CODEX_TYPE_LABEL = {
      place: '地点', institution: '机构', item: '物品',
      faction: '势力', concept: '概念', character: '角色', custom: '其他',
    };

    function codexPane(card, codex) {
      const q = codexQuery.trim();
      const list = q
        ? codex.filter((e) => (e.name + ' ' + (e.aliases || []).join(' ') + ' ' + (e.summary || '')).includes(q))
        : codex;

      const wrap = el('div', {});
      wrap.appendChild(el('div.sect-head', {},
        el('h3.sect-title', {}, '辞书'),
        el('span.sect-action', {}, `${codex.length} 条`),
      ));
      wrap.appendChild(el('p.sect-desc', {},
        '类型化的世界实体。它们不靠关键词触发——进场靠「实体在场 / 主题匹配 / 你钉选」，由引擎按当前场景渲染。'),
      );

      const searchInput = el('input.field', {
        type: 'text', placeholder: '搜索名称或别名…', value: codexQuery,
        oninput: (e) => { codexQuery = e.target.value; render(); },
      });
      wrap.appendChild(el('div.sect-search', {}, searchInput));

      if (!list.length) {
        wrap.appendChild(el('p.muted', {}, q ? '没有匹配的条目。' : '还没有辞书条目。'));
        return wrap;
      }

      const grouped = {};
      for (const e of list) {
        const t = e.type || 'custom';
        grouped[t] = grouped[t] || [];
        grouped[t].push(e);
      }

      for (const [type, items] of Object.entries(grouped)) {
        wrap.appendChild(el('div.codex-group', {},
          el('div.codex-group-head', {}, CODEX_TYPE_LABEL[type] || type, el('span', {}, `${items.length}`)),
          ...items.map((e) => el('div.codex-item', {},
            el('div.codex-item-head', {},
              el('span.codex-item-name', {}, e.name),
              e.pinned ? el('span.codex-item-pin', {}, '钉选') : null,
              e.reveal === 'secret' ? el('span.codex-item-secret', {}, '未解') : null,
            ),
            e.summary ? el('div.codex-item-summary', {}, e.summary) : null,
            (e.facets && (e.facets.rules || e.facets.consequences))
              ? el('div.codex-item-facets', {},
                  e.facets.rules?.length ? el('span', {}, `规则：${e.facets.rules.join('；')}`) : null,
                  e.facets.consequences?.length ? el('span', {}, `后果：${e.facets.consequences.join('；')}`) : null,
                )
              : null,
            e.links?.length ? el('div.codex-item-links', {}, `关联：${e.links.join('、')}`) : null,
          )),
        ));
      }

      return wrap;
    }


    /* ---- 侧栏 ---- */
    function statsCard(w, card, codex, sessions) {
      const turns = sessions.reduce((s, x) => s + (x.turn_count || 0), 0);
      const past = (card.timeline || []).filter((e) => e.canon === 'past').length;
      const future = (card.timeline || []).filter((e) => e.canon === 'future').length;
      return el('div.side-card', {},
        el('div.side-card-head', {}, '概览'),
        el('div.side-card-body', {},
          el('div.side-stats', {},
            stat(`${card.cast?.length || 0}`, '人物'),
            stat(`${codex.length}`, '辞书'),
            stat(`${codex.filter((e) => e.pinned).length}`, '钉选'),
            stat(`${past}`, '既定事实'),
            stat(`${future}`, '原著参考'),
            stat(`${sessions.length}`, '剧情'),
            stat(`${turns}`, '轮次'),
            stat(`v${w.version ?? 1}`, '模板版本'),
          ),
          el('div', { style: 'padding:0 13px 13px;font-size:var(--fs-caption);color:var(--ink-4);line-height:1.7;' },
            '编辑世界卡只影响之后创建的新会话；已开的剧情继续使用创建时冻结的快照。'),
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

    load();
    return {
      unmount() { document.title = '叙事台'; },
    };
  },
};
