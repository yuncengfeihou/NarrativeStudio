/**
 * views/world.js — 世界卡详情
 *
 * 一屏看尽这张卡的骨架：故事方向 / 世界规则 / 角色 / 设定集 / 时间线 / 开局点。
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
    let lintReport = null;

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
      try { lintReport = await fetchLint(worldId); } catch { lintReport = null; }
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
      panes.appendChild(pane('codex', codexPane()));
      main.appendChild(panes);

      side.appendChild(statsCard(world, card, sessions));
      side.appendChild(healthCard(lintReport));
      side.appendChild(sessionsCard(sessions));
      side.appendChild(sourceCard(world));
    }

    /**
     * v5 只有一个实体数组：person 与事实实体靠 type 区分，人物=person，设定集=其余类型。
     * 详情接口顶层返回 entities（已合并 pinned/muted），缺失时退回卡片内同一份。
     */
    function allEntities() {
      const card = world?.card || {};
      return Array.isArray(world?.entities) ? world.entities
        : Array.isArray(card.entities) ? card.entities : [];
    }

    function personEntities() {
      return allEntities().filter((e) => e.type === 'person');
    }

    function factEntities() {
      return allEntities().filter((e) => e.type !== 'person');
    }

    function hero(w, card) {
      const tags = (w.tags || card.genre || []).slice(0, 6);
      return el('div.wk-hero', {},
        el('div.wk-cover', { style: hueCover(w.cover_hue) },
          [...(w.title || '世')][0]),
        el('div.wk-hero-text', {},
          el('div.eyebrow', {}, '世界设定'),
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
      const items = [
        ['charter', '世界规则', 'scroll'],
        ['cast', `人物 ${personEntities().length}`, 'users'],
        ['timeline', `时间线 ${(world?.card?.timeline || []).length}`, 'layers'],
        ['codex', `设定集 ${factEntities().length}`, 'book'],
      ];
      const bar = el('div.editor-tabs');
      for (const [key, label, iconName] of items) {
        bar.appendChild(el('button.editor-tab', {
          type: 'button',
          class: activeTab === key ? 'is-active' : '',
          onclick: () => {
            activeTab = key;
            Array.from(bar.querySelectorAll('.editor-tab')).forEach((c, i) => {
              c.classList.toggle('is-active', items[i]?.[0] === key);
            });
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

    /* ---- 世界规则 ---- */
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
        wrap.appendChild(section('世界世界规则', list));
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
          wrap.appendChild(section('叙事风格',
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
      const persons = personEntities();
      if (!persons.length) {
        return el('div.empty', {},
          el('div.empty-icon', {}, icon('users', { size: 20 })),
          el('div.empty-title', {}, '还没有人物'),
          el('div.empty-sub', {}, '点右上角「编辑」添加角色卡。'),
        );
      }
      const grid = el('div.cast-grid');
      persons.forEach((c) => grid.appendChild(castCell(c)));

      // 开局种子（v4：每个开局点各有一份，这里显示默认开局点的）
      const anchor = (card.anchors || [])[0];
      const seed = String(anchor?.opening_seed || '').trim();
      const premise = String(card.prompt?.premise || '').trim();
      const wrap = el('div', {}, section('角色', grid));
      if (premise) {
        wrap.appendChild(section('故事方向',
          el('div.premise-block', {}, premise),
          el('p.sect-desc', {}, '这是这个故事要往哪去。它是方向，不是剧本——剧情具体怎么走由玩家和角色决定。'),
        ));
      }
      if (seed) {
        wrap.appendChild(section('开局种子',
          el('div', { style: 'border:1px solid var(--line);border-radius:var(--r-lg);background:var(--paper-raised);padding:14px;' },
            el('div.prose-block', {}, seed),
          ),
          el('button.btn.btn-ghost.btn-sm', {
            type: 'button', style: 'margin-top:8px;',
            onclick: () => openSeedViewer(card),
          }, icon('expand', { size: 13 }), '展开阅读'),
          anchor?.label ? el('p.sect-desc', {}, `默认开局点：${anchor.label}`) : null,
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
          c.summary ? el('div.cast-line', {}, c.summary) : null,
          c.psyche?.traits?.length
            ? el('div.cast-traits', {}, ...c.psyche.traits.slice(0, 3)
              .map((t) => el('span.chip.is-plain', { style: 'font-size:9px;padding:0 4px;' }, t)))
            : null,
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
      push('性格', list(psyche.traits));
      push('身份', identity.station);
      push('背景', identity.background);
      push('口吻', voice.rhythm);
      push('称呼', Object.entries(voice.address || {}).map(([to, how]) => `${to}→${how}`).join('；'));
      push('常用词', list(voice.lexicon));
      push('绝不说', list(voice.never));
      push('台词样本', list(voice.exemplars));
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
      // 运行期初始值：由记忆 Agent 在会话里改写，卡片这里只是开局值。
      push('初始状态', c.status);
      push('初始处境', c.condition);
      push('初始心境', c.mood);
      push('初始所在', c.location);
      push('初始目标', c.goal);

      openSheet({
        title: c.name,
        cancelText: '关闭',
        render(body) {
          body.appendChild(el('div', {},
            c.summary ? el('div', {
              style: 'padding:11px 13px;border-radius:8px;background:var(--paper-sunken);border-left:2px solid var(--line-strong);font-size:var(--fs-label);line-height:1.75;color:var(--ink-2);margin-bottom:16px;',
            }, c.summary) : null,
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
        title: `开局种子 · ${anchor?.label || '序章'}`,
        cancelText: '关闭',
        render(body) {
          body.appendChild(el('div.prose', {}, anchor?.opening_seed || ''));
        },
      });
    }

    /* ---- 时间线 ---- */
    function timelinePane(card) {
      const events = card.timeline || [];
      const past = events.filter((e) => e.canon !== 'future');
      const future = events.filter((e) => e.canon === 'future');
      const anchors = card.anchors || [];
      const adapted = card.kind === 'adapted';

      const wrap = el('div', {});

      if (anchors.length) {
        wrap.appendChild(el('div.sect', {},
          el('h3.sect-title', {}, '开局点'),
          el('p.sect-desc', {}, '从哪一刻起笔。默认第一个；每个开局点各有一份开局种子。'),
          el('div.anchor-list', {}, ...anchors.map((a, i) => el('div.anchor', {},
            el('span.anchor-label', {}, a.label + (i === 0 ? ' · 默认' : '')),
            a.note ? el('span.anchor-note', {}, a.note) : null,
          ))),
        ));
      }

      wrap.appendChild(el('div.sect', {},
        el('h3.sect-title', {}, '前史 · 开局之前'),
        el('p.sect-desc', {}, '开局时这些事已经发生，会作为世界背景进入上下文，剧情需与之自洽。'),
        past.length
          ? el('div.tl-list', {}, ...past.map((e) => el('div.tl-item', {},
              el('span.tl-when', {}, e.when || '—'),
              el('span.tl-what', {}, e.what),
              e.source ? el('span.tl-src', {}, e.source) : null,
            )))
          : el('p.muted', {}, '（可以留空——世界从开局那一刻开始长。）'),
      ));

      wrap.appendChild(el('div.sect', {},
        el('h3.sect-title', {}, '参考走向 · 开局之后'),
        el('p.sect-desc', {}, adapted
          ? '原作在开局之后的后续，只作一致性检查参考，不会注入提示词，也不作为演绎目标——玩家把剧情带偏是正常玩法。'
          : '你为这个世界预想的后续（可选），只作作者对照，不会注入提示词，也不作为演绎目标。'),
        future.length
          ? el('div.tl-list.is-future', {}, ...future.map((e) => el('div.tl-item', {},
              el('span.tl-when', {}, e.when || '—'),
              el('span.tl-what', {}, e.what),
              e.source ? el('span.tl-src', {}, e.source) : null,
            )))
          : el('p.muted', {}, '（可以留空，让故事自己长。）'),
      ));

      // canon_arc / divergence 没有运行时消费者：只在界面上标明「仅供参考」，
      // 免得作者把它们当成引擎会强制执行的约束。
      const arcs = card.canon_arc || [];
      if (arcs.length) {
        wrap.appendChild(el('div.sect', {},
          el('h3.sect-title', {}, '参考弧线 · 仅供参考'),
          el('p.sect-desc', {}, '改编时抓出的章级走向，只给作者对照：不注入提示词，引擎也不会强制按它演绎。'),
          el('div.tl-list', {}, ...arcs.map((a) => el('div.tl-item', {},
            el('span.tl-when', {}, a.chapter_from
              ? `ch${a.chapter_from}${a.chapter_to && a.chapter_to !== a.chapter_from ? `–${a.chapter_to}` : ''}`
              : (a.id || '—')),
            el('span.tl-what', {}, a.label || a.summary || ''),
          ))),
        ));
      }
      const divergence = card.divergence || {};
      const holds = divergence.must_hold || [];
      const allows = divergence.allow || [];
      if (holds.length || allows.length) {
        wrap.appendChild(el('div.sect', {},
          el('h3.sect-title', {}, '改编边界 · 仅供参考'),
          el('p.sect-desc', {}, '制卡时记下的「必须保住 / 可以改」清单，同样不注入提示词，引擎不会强制执行。'),
          holds.length ? el('p.sect-desc', {}, `必须保住：${holds.map((x) => (typeof x === 'string' ? x : x?.what || x?.note || '')).filter(Boolean).join('；')}`) : null,
          allows.length ? el('p.sect-desc', {}, `可以改编：${allows.map((x) => (typeof x === 'string' ? x : x?.what || x?.note || '')).filter(Boolean).join('；')}`) : null,
        ));
      }

      return wrap;
    }

    /* ---- 设定集（非 person 的事实实体） ---- */
    const FACT_TYPE_LABEL = {
      place: '地点', institution: '机构', item: '物品',
      faction: '势力', concept: '概念', custom: '其他',
    };
    // 分组顺序固定，未知 type 追加在末尾（后端 normalize 之外的脏值也不能吞掉）。
    const FACT_TYPE_ORDER = ['place', 'institution', 'faction', 'item', 'concept', 'custom'];

    function codexPane() {
      const facts = factEntities();
      const q = codexQuery.trim().toLowerCase();
      const list = q
        ? facts.filter((e) => [e.name, e.summary, ...(e.aliases || [])]
          .some((s) => String(s || '').toLowerCase().includes(q)))
        : facts;

      const wrap = el('div', {});
      wrap.appendChild(el('div.sect-head', {},
        el('h3.sect-title', {}, '设定集'),
        el('span.sect-action', {}, `${facts.length} 条`),
      ));
      wrap.appendChild(el('p.sect-desc', {},
        '类型化的世界实体。它们不靠关键词触发——进场靠「实体在场 / 主题匹配 / 你固定带出」，由引擎按当前场景渲染。'),
      );

      const searchInput = el('input.field', {
        type: 'text', placeholder: '搜索名称、别名或摘要…', value: codexQuery,
        oninput: (e) => { codexQuery = e.target.value; render(); },
      });
      wrap.appendChild(el('div.sect-search', {}, searchInput));

      if (!list.length) {
        wrap.appendChild(el('p.muted', {}, q ? '没有匹配的条目。' : '还没有设定集条目。'));
        return wrap;
      }

      const groups = new Map(FACT_TYPE_ORDER.map((t) => [t, []]));
      for (const e of list) {
        const t = e.type || 'custom';
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(e);
      }

      for (const [type, items] of groups) {
        if (!items.length) continue;
        wrap.appendChild(el('div.codex-group', {},
          el('div.codex-group-head', {}, FACT_TYPE_LABEL[type] || type, el('span', {}, `${items.length}`)),
          ...items.map((e) => el('div.codex-item', {},
            el('div.codex-item-head', {},
              el('span.codex-item-name', {}, e.name),
              e.pinned ? el('span.codex-item-pin', {}, '固定带出') : null,
              e.muted ? el('span.codex-item-muted', {}, '不自动带出') : null,
              e.reveal === 'secret' ? el('span.codex-item-secret', {}, '秘密') : null,
            ),
            e.summary ? el('div.codex-item-summary', {}, e.summary) : null,
            (e.facets && ((e.facets.rules || []).length || (e.facets.consequences || []).length))
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
    function statsCard(w, card, sessions) {
      const turns = sessions.reduce((s, x) => s + (x.turn_count || 0), 0);
      const past = (card.timeline || []).filter((e) => e.canon !== 'future').length;
      const future = (card.timeline || []).filter((e) => e.canon === 'future').length;
      const entities = allEntities();
      const persons = entities.filter((e) => e.type === 'person').length;
      return el('div.side-card', {},
        el('div.side-card-head', {}, '概览'),
        el('div.side-card-body', {},
          el('div.side-stats', {},
            stat(`${persons}`, '人物'),
            stat(`${entities.length - persons}`, '设定集'),
            stat(`${entities.filter((e) => e.pinned).length}`, '固定带出'),
            stat(`${past}`, '前史'),
            stat(`${future}`, '参考走向'),
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

    /* ---- 内容体检（A-2） ----
     * lint 是只读报告：blocker 会拦保存，其余是内容充分性建议。 */
    const LINT_SEVERITY_LABEL = { blocker: '阻断', major: '警告', minor: '注意', info: '提示' };
    const LINT_SEVERITY_COLOR = {
      blocker: 'var(--danger)', major: 'var(--warn)', minor: 'var(--accent)', info: 'var(--ink-4)',
    };
    const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, info: 3 };

    async function fetchLint(id) {
      return api.getWorldLint(id);
    }

    function healthCard(report) {
      const card = el('div.side-card');
      card.appendChild(el('div.side-card-head', {},
        el('span', {}, '内容体检'),
        report ? el('span', { style: 'font-variant-numeric:tabular-nums;' }, String(report.issues.length)) : null,
      ));
      const body = el('div.side-card-body');
      if (!report) {
        body.appendChild(el('div', { style: 'padding:14px 13px;font-size:var(--fs-caption);color:var(--ink-4);line-height:1.7;' },
          '体检结果暂时不可用，刷新页面重试。'));
        card.appendChild(body);
        return card;
      }
      const by = report.counts?.bySeverity || {};
      body.appendChild(el('div.side-stats', {},
        stat(String(report.counts?.entities ?? 0), '实体'),
        stat(String(report.counts?.edges ?? 0), '关联'),
        stat(String(by.blocker || 0), '阻断'),
        stat(String((by.major || 0) + (by.minor || 0)), '待改'),
      ));
      const issues = [...(report.issues || [])]
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
        .slice(0, 5);
      if (!issues.length) {
        body.appendChild(el('div', { style: 'padding:14px 13px;font-size:var(--fs-caption);color:var(--ink-4);line-height:1.7;' },
          '没有发现问题。'));
      } else {
        const list = el('div', { style: 'padding:0 6px 8px;' });
        for (const it of issues) list.appendChild(issueLine(it));
        body.appendChild(list);
        if ((report.issues || []).length > issues.length) {
          body.appendChild(el('div', { style: 'padding:0 13px 10px;font-size:var(--fs-caption);color:var(--ink-4);' },
            `还有 ${report.issues.length - issues.length} 条，保存时会再次提示。`));
        }
      }
      body.appendChild(el('div', { style: 'padding:0 13px 13px;font-size:var(--fs-caption);color:var(--ink-4);line-height:1.7;' },
        '阻断项会阻止保存；其余是内容充分性建议，不拦截。'));
      card.appendChild(body);
      return card;
    }

    function issueLine(it) {
      const color = LINT_SEVERITY_COLOR[it.severity] || 'var(--ink-4)';
      return el('div', { style: 'display:flex;gap:8px;align-items:flex-start;padding:7px;font-size:var(--fs-caption);line-height:1.65;' },
        el('span', { style: `flex:0 0 auto;margin-top:5px;width:6px;height:6px;border-radius:50%;background:${color};` }),
        el('div', { style: 'min-width:0;' },
          el('div', { style: 'color:var(--ink-2);' }, it.message || it.code || ''),
          el('div', { style: 'color:var(--ink-4);font-size:11px;' },
            `${LINT_SEVERITY_LABEL[it.severity] || it.severity || ''} · ${it.code || ''}`),
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
