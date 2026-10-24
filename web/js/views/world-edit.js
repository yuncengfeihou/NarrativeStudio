/**
 * views/world-edit.js — 世界卡编辑器
 *
 * 七个分段：基本 / 宪章 / 主角 / 卡司 / 辞书 / 时间线 / 开场
 * 编辑的是「世界卡」，不是某一段剧情——改一次，以后每次开局都用新的。
 */

import { el, clear, charCount } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, showLoading, hideLoading, openSheet, openActionSheet } from '../app.js';
import { hueCover, hueGlyph, slidingThumb } from '../ui-kit.js';

export default {
  id: 'world-edit',
  title: '编辑世界卡',

  async mount(root, params) {
    const worldId = params.id || null;
    const isEdit = !!worldId;

    const CODEX_TYPES = [
      ['place', '地点'], ['institution', '机构'], ['item', '物品'],
      ['faction', '势力'], ['concept', '概念'], ['character', '角色'], ['custom', '其他'],
    ];

    /* ---------------- 模型 ---------------- */
    const model = {
      id: worldId,
      coverHue: 220,
      tags: [],
      card: {
        title: '', subtitle: '', genre: [],
        prompt: {
          premise: '', tone: [], style_guide: '', narrator_notes: '',
          bans: [], pov: '', length: '', tense: '',
        },
        charter: [],
        player: { name: '', age: '', identity: '', situation: '', capability: '', inner_voice: '', wants: '', afraid: '' },
        cast: [],
        codex: [],
        timeline: [],
        anchors: [{
          id: 'prologue', label: '序章', after_event: '',
          snapshot: {}, opening_seed: '', note: '',
        }],
      },
    };

    let saving = false;
    let dirty = false;
    let activeTab = 'basic';
    let tabBadges = {};
    let moveTabIndicator = () => {};
    let resizeHandler = null;

    /* ---------------- 骨架 ---------------- */
    const navTitle = el('div.topbar-title', {}, isEdit ? '编辑世界卡' : '新建世界卡');
    const saveBtn = el('button.btn.btn-primary.btn-sm', {
      type: 'button', title: '保存（Ctrl/⌘ + S）', onclick: submit,
    }, isEdit ? '保存' : '创建');
    const nav = el('header.topbar', {},
      el('button.icon-btn.mobile-only', {
        type: 'button', 'aria-label': '目录',
        onclick: () => import('../shell.js').then((m) => m.openDrawer()),
      }, icon('sidebar', { size: 17 })),
      isEdit
        ? el('button.icon-btn', { type: 'button', title: '返回', onclick: () => navigate(`#/world/${worldId}`) },
          icon('chevronLeft', { size: 17 }))
        : el('button.icon-btn', { type: 'button', title: '返回', onclick: () => navigate('#/worlds') },
          icon('chevronLeft', { size: 17 })),
      navTitle,
      el('div.topbar-actions', {}, saveBtn),
    );

    const scroll = el('div.scroll');
    const view = el('section.view', { 'data-view': 'world-edit' }, nav, scroll);
    root.appendChild(view);

    function setDirty(next) {
      dirty = next;
      saveBtn.classList.toggle('is-dirty', next);
    }

    function markDirty() { if (!dirty) setDirty(true); }

    // 所有字段都通过委托标记「有未保存改动」，不必给每个输入单独挂事件。
    scroll.addEventListener('input', markDirty);
    scroll.addEventListener('change', markDirty);
    scroll.addEventListener('click', (e) => {
      if (e.target.closest('.switch')) markDirty();
    });

    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        submit();
      }
    };
    const onBeforeUnload = (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', onBeforeUnload);

    /* ---------------- 载入 ---------------- */
    if (isEdit) {
      showLoading();
      try {
        const w = await api.getWorld(worldId);
        model.coverHue = w.cover_hue ?? 220;
        model.tags = w.tags || [];
        model.card = normalizeCard(w.card || {});
      } catch (err) {
        toast(`加载失败：${err.message}`, { type: 'error' });
      } finally {
        hideLoading();
      }
    } else {
      // 新建时若剧本库里已有卡，给个「从种子开始」的入口
      try {
        const presets = await api.listPresets();
        if (presets?.length) model._presets = presets;
      } catch { /* 忽略 */ }
    }
    render();

    /* =====================================================================
     * 渲染
     * ===================================================================== */
    function render(preserveScroll = false) {
      const keepTop = preserveScroll ? scroll.scrollTop : null;
      clear(scroll);
      const box = el('div.page.editor');
      box.appendChild(hero());
      box.appendChild(tabs());
      box.appendChild(pane('basic', basicPane()));
      box.appendChild(pane('charter', charterPane()));
      box.appendChild(pane('player', playerPane()));
      box.appendChild(pane('cast', castPane()));
      box.appendChild(pane('codex', codexPane()));
      box.appendChild(pane('timeline', timelinePane()));
      box.appendChild(pane('opening', openingPane()));
      scroll.appendChild(box);
      if (keepTop != null) scroll.scrollTop = keepTop;
    }

    function hero() {
      const cover = el('div.editor-cover', {
        style: hueCover(model.coverHue),
        title: '点击更换封面色调',
        role: 'button',
        tabindex: '0',
        onclick: () => openHuePicker(),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHuePicker(); } },
      },
        el('span.editor-cover-char', {}, [...(model.card.title || '世')][0]),
        el('span.editor-cover-tip', {}, icon('palette', { size: 12 })),
      );

      const titleInput = el('input.editor-title-input', {
        type: 'text', placeholder: '世界叫什么名字', maxlength: 60, value: model.card.title,
        oninput: (e) => {
          model.card.title = e.target.value;
          cover.querySelector('.editor-cover-char').textContent = [...(model.card.title || '世')][0];
          navTitle.textContent = model.card.title || (isEdit ? '编辑世界卡' : '新建世界卡');
        },
      });

      const subtitleInput = el('input.editor-subtitle-input', {
        type: 'text', placeholder: '一句话简介（显示在世界卡列表里）',
        maxlength: 100, value: model.card.subtitle || '',
        oninput: (e) => { model.card.subtitle = e.target.value; },
      });

      return el('div.editor-hero', {},
        cover,
        el('div.editor-hero-text', {},
          titleInput,
          subtitleInput,
        ),
      );
    }

    function openHuePicker() {
      let draftHue = model.coverHue;
      const slider = el('input', {
        type: 'range', min: 0, max: 359, style: 'width:100%;accent-color:var(--accent);',
      });
      slider.value = String(draftHue);
      const preview = el('div', {
        style: { width: '48px', height: '48px', borderRadius: '8px', flex: 'none', ...hueCover(draftHue) },
      });
      slider.addEventListener('input', () => {
        draftHue = Number(slider.value);
        preview.style.background = hueCover(draftHue).background;
      });
      openSheet({
        title: '封面色调',
        confirmText: '确定',
        render(body) {
          body.appendChild(el('div', { style: 'display:flex;align-items:center;gap:14px;' },
            preview, slider,
            el('div.field-hint', {}, '只影响封面，不进入演绎内容。'),
          ));
        },
        onConfirm() {
          if (draftHue !== model.coverHue) {
            model.coverHue = draftHue;
            markDirty();
          }
          render(true);
        },
      });
    }

    function tabs() {
      const items = [
        ['basic', '基本', 'list'],
        ['charter', '宪章', 'scroll'],
        ['player', '主角', 'user'],
        ['cast', '卡司', 'users'],
        ['codex', '辞书', 'book'],
        ['timeline', '时间线', 'layers'],
        ['opening', '开场', 'play'],
      ];

      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      const bar = el('div.editor-tabs.has-indicator', { role: 'tablist', 'aria-label': '编辑分区' });
      tabBadges = {};

      for (const [key, label, iconName] of items) {
        const badge = el('span.tab-count');
        tabBadges[key] = badge;
        const btn = el('button.editor-tab', {
          type: 'button',
          role: 'tab',
          dataset: { tab: key },
          'aria-selected': activeTab === key ? 'true' : 'false',
          class: activeTab === key ? 'is-active' : '',
          onclick: () => activateTab(key),
        }, icon(iconName, { size: 13 }), label, badge);
        bar.appendChild(btn);
      }

      moveTabIndicator = slidingThumb(bar, '.editor-tab');

      resizeHandler = () => requestAnimationFrame(moveTabIndicator);
      window.addEventListener('resize', resizeHandler);
      paintTabBadges();
      requestAnimationFrame(moveTabIndicator);
      return bar;
    }

    function activateTab(key) {
      activeTab = key;
      scroll.querySelectorAll('.editor-tab').forEach((b) => {
        const on = b.dataset.tab === key;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      scroll.querySelectorAll('.editor-pane').forEach((p) => {
        p.classList.toggle('is-active', p.dataset.pane === key);
      });
      moveTabIndicator();
      const bar = scroll.querySelector('.editor-tabs');
      const pane = scroll.querySelector(`.editor-pane[data-pane="${key}"]`);
      if (bar && pane) {
        const offset = bar.getBoundingClientRect().height + 8;
        const top = scroll.scrollTop + pane.getBoundingClientRect().top
          - scroll.getBoundingClientRect().top - offset;
        scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }

    function tabCount(key) {
      const c = model.card;
      if (key === 'charter') return c.charter.length;
      if (key === 'cast') return c.cast.length;
      if (key === 'codex') return c.codex.length;
      if (key === 'timeline') return c.timeline.length;
      if (key === 'opening') return charCount(c.anchors?.[0]?.opening_seed || '') ? '•' : '';
      return '';
    }

    function paintTabBadges() {
      for (const [key, badge] of Object.entries(tabBadges)) {
        const value = tabCount(key);
        badge.textContent = value;
        badge.hidden = !value;
      }
    }

    function paneHead(title, desc) {
      return el('div.pane-head', {},
        el('h2.pane-title', {}, title),
        desc ? el('p.pane-desc', {}, desc) : null,
      );
    }

    function pane(name, content) {
      return el('div.editor-pane', {
        class: activeTab === name ? 'is-active' : '',
        dataset: { pane: name },
        role: 'tabpanel',
      }, content);
    }

    /* ---- 基本 ---- */
    function basicPane() {
      const wrap = el('div');
      wrap.appendChild(paneHead('基本', '简介与封面色调在顶部编辑；这里决定引擎怎么讲这个故事。'));

      // 风格标签
      const tagInput = el('input', {
        type: 'text', placeholder: '输入后回车，如：女尊男卑',
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
            e.preventDefault();
            const v = e.target.value.trim().replace(/[,，]$/, '');
            if (v && !model.tags.includes(v)) {
              model.tags.push(v);
              model.card.genre = model.tags.slice();
              e.target.value = '';
              paintTags();
            }
          } else if (e.key === 'Backspace' && !e.target.value && model.tags.length) {
            model.tags.pop();
            model.card.genre = model.tags.slice();
            paintTags();
          }
        },
      });
      const tagBox = el('div.tagbox', { onclick: () => tagInput.focus() });
      function paintTags() {
        clear(tagBox);
        model.tags.forEach((t, i) => {
          tagBox.appendChild(el('span.chip.is-plain', {}, t,
            el('button.tag-x', {
              type: 'button', 'aria-label': `移除 ${t}`,
              onclick: (e) => {
                e.stopPropagation();
                model.tags.splice(i, 1);
                model.card.genre = model.tags.slice();
                markDirty();
                paintTags();
              },
            }, icon('close', { size: 8, stroke: 2.4 })),
          ));
        });
        tagBox.appendChild(tagInput);
      }
      paintTags();
      wrap.appendChild(fgroup('风格标签', tagBox, '用于筛选，也提示引擎的用词取向。'));

      // 文风
      const prompt = model.card.prompt;
      const styleRows = [
        ['pov', '视角', '第三人称限知，镜头贴在主角身上'],
        ['style_guide', '文风', '短句为主，对白与动作交错'],
        ['length', '篇幅', '1600-2600 字'],
        ['tense', '时态', '过去时叙述'],
      ];
      const styleCard = el('div.group-card');
      for (const [key, label, placeholder] of styleRows) {
        // 视角与文风通常较长，用可自增高的 textarea；篇幅/时态用单行即可
        const long = key === 'pov' || key === 'style_guide';
        const inp = long
          ? el('textarea', {
            rows: 2, placeholder, value: prompt[key] || '',
            style: 'flex:1;min-width:0;font-size:var(--fs-caption);line-height:1.7;color:var(--ink-2);padding:2px 0;resize:none;overflow:hidden;background:transparent;border:none;',
          })
          : el('input', {
            type: 'text', placeholder, value: prompt[key] || '',
            style: 'flex:1;min-width:0;font-size:var(--fs-caption);color:var(--ink-2);padding:2px 0;',
          });
        inp.addEventListener('input', () => {
          prompt[key] = inp.value;
          if (long) {
            inp.style.height = 'auto';
            inp.style.height = `${Math.min(inp.scrollHeight, 160)}px`;
          }
        });
        if (long && prompt[key]) {
          requestAnimationFrame(() => {
            inp.style.height = 'auto';
            inp.style.height = `${Math.min(inp.scrollHeight, 160)}px`;
          });
        }
        styleCard.appendChild(editorRow(label, inp));
      }
      wrap.appendChild(fgroup('演出范式', styleCard, '这四项会直接写进每一轮的演绎契约。'));

      // 命题
      const premiseInput = el('textarea.field', {
        rows: 4, placeholder: '三到五句话：这个世界的核心矛盾、主角的处境、故事大致要往哪去。',
        value: prompt.premise || '',
      });
      premiseInput.addEventListener('input', () => { prompt.premise = premiseInput.value; });
      wrap.appendChild(fgroup('命题', premiseInput,
        '这是故事要往哪去。它是方向，不是剧本——剧情具体怎么走由玩家和角色决定。'));

      // 演绎附注
      const notesInput = el('textarea.field', {
        rows: 3, placeholder: '给演绎的额外附注（可选）',
        value: prompt.narrator_notes || '',
      });
      notesInput.addEventListener('input', () => { prompt.narrator_notes = notesInput.value; });
      wrap.appendChild(fgroup('演绎附注', notesInput, '比如「留白多于解释」「不要替玩家做决定」。'));

      return wrap;
    }

    /* ---- 宪章 ---- */
    function charterPane() {
      const wrap = el('div');
      wrap.appendChild(paneHead('宪章', '任何场景下都成立的硬设定：世界的物理、制度、礼法与尺度。'));
      const list = el('div', { style: 'display:flex;flex-direction:column;gap:7px;' });
      paintCharter();

      function paintCharter() {
        clear(list);
        if (!model.card.charter.length) {
          list.appendChild(el('div.charter-empty', {}, '还没有宪章。先写一条这个世界绝不妥协的规则。'));
        }
        model.card.charter.forEach((c, i) => {
          const ta = growTextarea(el('textarea.field', { rows: 2, placeholder: '例如：任何人在「司楼」内都不得直呼对方真名。' }), 140);
          ta.value = c.rule || '';
          ta.addEventListener('input', () => { c.rule = ta.value; });
          list.appendChild(el('div.charter-edit-item', {},
            el('span.charter-edit-idx', {}, String(i + 1).padStart(2, '0')),
            ta,
            el('button.btn-icon', {
              type: 'button', title: '删除这条宪章',
              onclick: () => { model.card.charter.splice(i, 1); markDirty(); paintCharter(); },
            }, icon('trash', { size: 13 })),
          ));
        });
        list.appendChild(el('button.cast-add', {
          type: 'button',
          onclick: () => { model.card.charter.push({ rule: '' }); markDirty(); paintCharter(); },
        }, icon('plus', { size: 13 }), '添加一条宪章'));
        paintTabBadges();
      }

      wrap.appendChild(list);
      wrap.appendChild(el('div.group-note', { style: 'padding-top:10px;' },
        '只写规则，不写具体事件。宪章每轮都会进入上下文（约占 1.5K tok）。'));
      return wrap;
    }

    /* ---- 主角 ---- */
    function playerPane() {
      const wrap = el('div');
      wrap.appendChild(paneHead('主角', '引擎每轮都要记住的那几件事，不是人物百科。'));
      const p = model.card.player;
      const rows = [
        ['name', '姓名', '伍卿'],
        ['age', '年龄', '十七岁'],
        ['identity', '身份', '山村的破烂少年'],
        ['situation', '处境', '被谁养大、现在靠什么过活、有什么把柄在别人手上'],
        ['capability', '能力边界', '他能做什么、绝不能做什么——这是防 OOC 最重要的一条'],
        ['inner_voice', '内心声音', '他的幽默从哪里来、他会怎么想事情'],
        ['wants', '想要的', '他嘴上说想要的'],
        ['afraid', '害怕的', '他真正怕的东西'],
      ];
      const card = el('div.group-card');
      for (const [key, label, placeholder] of rows) {
        const isLong = ['situation', 'capability', 'inner_voice', 'wants', 'afraid'].includes(key);
        const inp = isLong
          ? el('textarea', { rows: 2, placeholder, style: 'flex:1;min-width:0;font-size:var(--fs-caption);line-height:1.7;color:var(--ink-2);padding:2px 0;resize:none;overflow:hidden;' })
          : el('input', { type: 'text', placeholder, style: 'flex:1;min-width:0;font-size:var(--fs-caption);color:var(--ink-2);padding:2px 0;' });
        inp.value = p[key] || '';
        inp.addEventListener('input', () => { p[key] = inp.value; });
        card.appendChild(editorRow(label, inp));
      }
      wrap.appendChild(card);
      wrap.appendChild(el('div.group-note', { style: 'padding-top:10px;' },
        '主角速写会每轮进入上下文（约 0.6K tok）。'));
      return wrap;
    }

    /* ---- 卡司 ---- */
    function castPane() {
      const wrap = el('div');
      wrap.appendChild(paneHead('卡司', '只有本轮在场的角色会进入上下文；「常驻」的人物每轮都在。'));
      const list = el('div.cast-list');
      paintCast();

      function paintCast() {
        clear(list);
        if (!model.card.cast.length) {
          list.appendChild(el('div.empty', { style: 'padding:28px 20px;' },
            el('div.empty-icon', {}, icon('users', { size: 18 })),
            el('div.empty-title', {}, '还没有人物'),
            el('div.empty-sub', {}, '至少添加一位，故事才有人可寻。'),
          ));
        } else {
          model.card.cast.forEach((c, i) => list.appendChild(castCard(c, i)));
        }
        list.appendChild(el('button.cast-add', {
          type: 'button', onclick: addCharacter,
        }, icon('plus', { size: 14 }), '添加人物'));
        paintTabBadges();
      }

      function addCharacter() {
        markDirty();
        model.card.cast.push({
          id: '', name: '', aliases: [], role: '', one_line: '',
          identity: { age: '', appearance: '', background: '', station: '' },
          voice: { address: {}, rhythm: '', lexicon: [], never: [], exemplars: [] },
          psyche: { wants: [], fears: [], hides: [], values: [] },
          knowledge: { knows: [], does_not_know: [], believes_falsely: [] },
          agenda: [], relations: [],
          always_present: false, weight: 0.5,
        });
        paintCast();
        requestAnimationFrame(() => {
          const inputs = list.querySelectorAll('.cast-name-input');
          inputs[inputs.length - 1]?.focus();
        });
      }

      function castCard(c, index) {
        c.identity = c.identity || {};
        c.voice = c.voice || {};
        c.psyche = c.psyche || {};
        c.knowledge = c.knowledge || {};
        c.agenda = c.agenda || [];
        c.relations = c.relations || [];
        c.aliases = c.aliases || [];

        const hue = (index * 47 + 200) % 360;
        const avatar = el('div.cast-avatar', {
          style: hueGlyph(hue),
        }, [...(c.name || '新')][0]);

        const nameInput = el('input.cast-name-input', {
          type: 'text', placeholder: '角色名', value: c.name,
          oninput: (e) => {
            c.name = e.target.value;
            avatar.textContent = [...(c.name || '新')][0];
          },
        });
        const roleInput = el('input.cast-role-input', {
          type: 'text', placeholder: '身份 / 在故事里的位置', value: c.role,
          oninput: (e) => { c.role = e.target.value; },
        });

        const alwaysSw = el('div.switch.is-sm', {
          role: 'switch', 'aria-checked': String(!!c.always_present), tabindex: '0',
          title: '常驻：每轮都在场',
        }, el('div.switch-knob'));
        alwaysSw.addEventListener('click', () => {
          c.always_present = !c.always_present;
          alwaysSw.setAttribute('aria-checked', String(c.always_present));
        });

        const card = el('div.cast-card', { style: `--char-hue:${hueGlyph(hue).color};` });
        const collapseBtn = el('button.btn-icon.cast-collapse', {
          type: 'button', title: '收起', 'aria-label': '收起角色',
          onclick: (e) => {
            e.stopPropagation();
            const collapsed = card.classList.toggle('is-collapsed');
            collapseBtn.classList.toggle('is-collapsed', collapsed);
            collapseBtn.title = collapsed ? '展开' : '收起';
            collapseBtn.setAttribute('aria-label', collapsed ? '展开角色' : '收起角色');
          },
        }, icon('chevronDown', { size: 13 }));

        const moreBtn = el('button.icon-btn.is-sm', {
          type: 'button', title: '更多', 'aria-label': '角色操作',
          onclick: async (e) => {
            e.stopPropagation();
            const action = await openActionSheet({
              title: c.name || '角色',
              actions: [
                { label: '上移', value: 'up', icon: 'chevronUp' },
                { label: '下移', value: 'down', icon: 'chevronDown' },
                { label: '删除人物', value: 'delete', icon: 'trash', destructive: true },
              ],
            });
            if (action === 'up' && index > 0) {
              [model.card.cast[index - 1], model.card.cast[index]] = [model.card.cast[index], model.card.cast[index - 1]];
              markDirty();
              paintCast();
            } else if (action === 'down' && index < model.card.cast.length - 1) {
              [model.card.cast[index + 1], model.card.cast[index]] = [model.card.cast[index], model.card.cast[index + 1]];
              markDirty();
              paintCast();
            } else if (action === 'delete') {
              model.card.cast.splice(index, 1);
              markDirty();
              paintCast();
            }
          },
        }, icon('more', { size: 14 }));

        card.append(
          el('div.cast-head', {},
            avatar,
            el('div.cast-head-text', {}, nameInput, roleInput),
            el('div.cast-tools', {},
              el('span.cast-always-label', {}, '常驻'),
              alwaysSw,
              collapseBtn,
              moreBtn,
            ),
          ),
          el('div.cast-body', {},
            row('一句话', '一句话能概括这个人（显示在卡司网格里）', c.one_line, (v) => { c.one_line = v; }, true),
            row('别名', '顿号分隔，如：玥姐姐、凌家主', c.aliases, (v) => { c.aliases = v; }, false, true),
            row('年龄', '十七岁 / 二十出头…', c.identity.age, (v) => { c.identity.age = v; }),
            row('外貌', '体态、穿着、显眼的特征', c.identity.appearance, (v) => { c.identity.appearance = v; }, true),
            row('身份', '家世、职业、社会位置', c.identity.station, (v) => { c.identity.station = v; }),
            row('背景', '过往经历、立场、与主角的渊源', c.identity.background, (v) => { c.identity.background = v; }, true),
            row('口吻', '台词风格、自称、对主角的称呼', c.voice.rhythm, (v) => { c.voice.rhythm = v; }, true),
            row('常用词', '顿号分隔，如：卿儿、姐姐、放肆', c.voice.lexicon, (v) => { c.voice.lexicon = v; }, false, true),
            row('绝不说', '顿号分隔：这个角色不会用的词或句式', c.voice.never, (v) => { c.voice.never = v; }, false, true),
            row('原声', '每行一句原文台词，用来锚定声音', c.voice.exemplars, (v) => { c.voice.exemplars = v; }, true, false, true),
            row('想要', '顿号分隔', c.psyche.wants, (v) => { c.psyche.wants = v; }, false, true),
            row('害怕', '顿号分隔', c.psyche.fears, (v) => { c.psyche.fears = v; }, false, true),
            row('藏着', '不为人知的动机——引擎会遵守，但不会说破', c.psyche.hides, (v) => { c.psyche.hides = v; }, true, true),
            row('在意', '顿号分隔：价值观、底线', c.psyche.values, (v) => { c.psyche.values = v; }, false, true),
            row('知道', '顿号分隔：他确实知道的事', c.knowledge.knows, (v) => { c.knowledge.knows = v; }, false, true),
            row('不知道', '顿号分隔：知识边界', c.knowledge.does_not_know, (v) => { c.knowledge.does_not_know = v; }, false, true),
            row('误信', '顿号分隔：他信错了的事', c.knowledge.believes_falsely, (v) => { c.knowledge.believes_falsely = v; }, false, true),
            agendaRow(c.agenda),
            relationsRow(c.relations),
          ),
        );
        return card;
      }

      /** 单行/多行文本。list=true 时按顿号/逗号拆成数组；lines=true 时按行拆。 */
      function row(label, placeholder, value, setter, multiline = false, list = false, lines = false) {
        const inp = multiline
          ? growTextarea(el('textarea', { rows: 1, placeholder }), 140)
          : el('input', { type: 'text', placeholder });
        inp.value = list || lines
          ? (Array.isArray(value) ? value.join(lines ? '\n' : '、') : (value || ''))
          : (value || '');
        inp.addEventListener('input', () => {
          if (list) setter(splitText(inp.value));
          else if (lines) setter(splitLines(inp.value));
          else setter(inp.value);
        });
        return el('div.cast-row', {}, el('span.cast-key', {}, label), inp);
      }

      /** 私心：每行「目标｜手段｜压力(0-1)」。 */
      function agendaRow(agenda) {
        const ta = growTextarea(el('textarea', {
          rows: 2,
          placeholder: '今天必须把他带走｜不能用施舍的方式｜0.9\n（每行一条：目标｜手段｜压力）',
        }), 180);
        ta.value = agenda.map((a) => [a.goal, a.method, a.pressure].filter((x) => x !== '' && x != null).join('｜')).join('\n');
        ta.addEventListener('input', () => {
          agenda.length = 0;
          for (const line of splitLines(ta.value)) {
            const [goal, method, pressure] = line.split('｜').map((s) => s.trim());
            if (!goal) continue;
            const p = Number(pressure);
            agenda.push({ goal, method: method || '', pressure: Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0.5, deadline: '' });
          }
        });
        return el('div.cast-row', {}, el('span.cast-key', {}, '私心'), ta);
      }

      /** 关系：每行「对方｜关系｜好感(-1~1)｜备注」。 */
      function relationsRow(relations) {
        const ta = growTextarea(el('textarea', {
          rows: 2,
          placeholder: '伍卿｜旧识·执念｜0.8｜找了七年\n（每行一条：对方｜关系｜好感｜备注）',
        }), 180);
        ta.value = relations
          .map((r) => [r.to, r.kind, r.sentiment ?? '', r.note].filter((x) => x !== '' && x != null).join('｜'))
          .join('\n');
        ta.addEventListener('input', () => {
          relations.length = 0;
          for (const line of splitLines(ta.value)) {
            const [to, kind, sentiment, note] = line.split('｜').map((s) => s.trim());
            if (!to) continue;
            const n = Number(sentiment);
            relations.push({ to, kind: kind || '', sentiment: Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0, note: note || '' });
          }
        });
        return el('div.cast-row', {}, el('span.cast-key', {}, '关系'), ta);
      }

      wrap.appendChild(list);
      wrap.appendChild(el('div.group-note', { style: 'padding-top:10px;' },
        '所以卡司可以写得很细，而上下文只装这一轮真正需要的那几张。'));
      return wrap;
    }

    /* ---- 辞书（codex）---- */
    function codexPane() {
      const list = model.card.codex;
      const wrap = el('div', {});
      wrap.appendChild(paneHead('辞书', '类型化的世界实体，按实体链接、主题与钉选进场。'));
      wrap.appendChild(el('p.field-hint', {},
        '类型化的世界实体。它们不靠关键词触发：进场靠「实体在场 / 主题匹配 / 你钉选」，由引擎按当前场景渲染。',
        '所以这里没有「触发词」——你只需要把它挂到相关的角色、地点或线索上。'));

      wrap.appendChild(el('div.sect-head', {},
        el('span.sect-count', {}, `${list.length} 条`),
        el('button.btn.btn-secondary.btn-sm', {
          type: 'button',
          onclick: () => openCodexEditor(null),
        }, icon('plus', { size: 13 }), '添加'),
      ));

      if (!list.length) {
        wrap.appendChild(el('div.empty', {},
          el('div.empty-icon', {}, icon('book', { size: 20 })),
          el('div.empty-title', {}, '还没有辞书条目'),
          el('div.empty-sub', {}, '地点、机构、物品、概念——凡是「提到时才需要知道细节」的东西。'),
        ));
        return wrap;
      }

      const items = el('div.codex-edit-list');
      list.forEach((e) => {
        const head = el('button.codex-edit-head', {
          type: 'button',
          onclick: () => openCodexEditor(e),
        },
          el('span.codex-edit-type', {}, (CODEX_TYPES.find((t) => t[0] === e.type) || ['custom', '其他'])[1]),
          el('span.codex-edit-name', {}, e.name || '（未命名）'),
          e.pinned ? el('span.chip.is-accent', { style: 'font-size:9px;padding:0 4px;' }, '钉选') : null,
          e.reveal === 'secret' ? el('span.chip.is-plain', { style: 'font-size:9px;padding:0 4px;' }, '未解') : null,
          el('span.codex-edit-chev', {}, icon('chevronRight', { size: 12 })),
        );
        const body = el('div.codex-edit-body', {},
          e.summary ? el('div.codex-edit-summary', {}, e.summary) : null,
          e.links?.length ? el('div.codex-edit-links', {}, `关联：${e.links.join('、')}`) : null,
        );
        items.appendChild(el('div.codex-edit-item', {}, head, body));
      });
      wrap.appendChild(items);
      return wrap;
    }

    function openCodexEditor(entry) {
      const draft = entry
        ? { ...entry, facets: { ...(entry.facets || {}) } }
        : {
          id: '', type: 'concept', name: '', aliases: [], tags: [],
          summary: '', facets: { sensory: '', rules: [], consequences: [], history: '' },
          links: [], reveal: 'public', detail: '', parent_id: '',
        };

      const nameInput = el('input.field', { value: draft.name || '', placeholder: '名称（如「司楼」）' });
      const aliasInput = el('input.field', {
        value: (draft.aliases || []).join('、'),
        placeholder: '别名/别称，顿号分隔（如「青楼」）',
      });
      const summaryInput = el('textarea.field', {
        rows: 2, placeholder: '一句话：它是什么',
      }, draft.summary || '');
      const rulesInput = el('textarea.field', {
        rows: 3, placeholder: '规则：这里什么被允许、什么被禁止（一行一条）',
      }, (draft.facets?.rules || []).join('\n'));
      const consInput = el('textarea.field', {
        rows: 2, placeholder: '后果：违反或触碰到它会怎样（一行一条）',
      }, (draft.facets?.consequences || []).join('\n'));
      const sensoryInput = el('textarea.field', {
        rows: 2, placeholder: '质感：气味、光线、声音——可以直接化用的描写',
      }, draft.facets?.sensory || '');
      const historyInput = el('textarea.field', {
        rows: 4, placeholder: '来历：完整背景',
      }, draft.facets?.history || draft.detail || '');
      const linksInput = el('input.field', {
        value: (draft.links || []).join('、'),
        placeholder: '关联到哪些实体（cast:凌玥 / codex:司楼）',
      });
      const tagsInput = el('input.field', {
        value: (draft.tags || []).join('、'),
        placeholder: '主题标签，顿号分隔（如「制度、交易」）',
      });
      const parentInput = el('input.field', {
        value: draft.parent_id || '',
        placeholder: '上级地点/机构 id（可选，如「帝都」；用于世界索引树）',
      });

      const typeSelect = el('select.field', {}, ...CODEX_TYPES.map(([v, l]) =>
        el('option', { value: v, selected: draft.type === v }, l)));
      const revealSelect = el('select.field', {},
        el('option', { value: 'public', selected: draft.reveal !== 'secret' && draft.reveal !== 'rumor' }, '公开'),
        el('option', { value: 'rumor', selected: draft.reveal === 'rumor' }, '流言'),
        el('option', { value: 'secret', selected: draft.reveal === 'secret' }, '未解（只引擎知道，不得说破）'),
      );

      openSheet({
        title: entry ? '编辑辞书条目' : '添加辞书条目',
        confirmText: entry ? '保存' : '添加',
        cancelText: '取消',
        render(b) {
          b.appendChild(field('名称', nameInput));
          b.appendChild(field('别名', aliasInput));
          b.appendChild(el('div.field-row', {}, field('类型', typeSelect), field('可见性', revealSelect)));
          b.appendChild(field('一句话摘要', summaryInput));
          b.appendChild(field('规则', rulesInput));
          b.appendChild(field('后果', consInput));
          b.appendChild(field('质感', sensoryInput));
          b.appendChild(field('来历', historyInput));
          b.appendChild(field('关联实体', linksInput));
          b.appendChild(field('主题标签', tagsInput));
          b.appendChild(field('上级地点/机构', parentInput));
          b.appendChild(el('p.field-hint', {},
            '「未解」条目会被标注为「只你可知，不得说破」——引擎会遵守，但不会让角色说出来。'));
        },
        onConfirm: () => {
          const name = nameInput.value.trim();
          if (!name) { toast('名称不能为空', { type: 'error' }); return false; }
          const split = (s) => String(s || '').split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean);
          const payload = {
            ...draft,
            id: draft.id || name,
            type: typeSelect.value,
            name,
            aliases: split(aliasInput.value),
            summary: summaryInput.value.trim(),
            tags: split(tagsInput.value),
            links: split(linksInput.value),
            parent_id: parentInput.value.trim(),
            reveal: revealSelect.value,
            facets: {
              sensory: sensoryInput.value.trim(),
              rules: split(rulesInput.value),
              consequences: split(consInput.value),
              history: historyInput.value.trim(),
            },
            detail: historyInput.value.trim(),
          };
          if (entry) Object.assign(entry, payload);
          else model.card.codex.push(payload);
          markDirty();
          render(true);
          return true;
        },
      });
    }

    /* ---- 时间线 ---- */
    function timelinePane() {
      const events = model.card.timeline;
      const anchors = model.card.anchors;
      const wrap = el('div', {});
      wrap.appendChild(paneHead('时间线', '起点之前是既定事实，起点之后只是原著参考。'));

      wrap.appendChild(sectionHead('可玩时间点', `${anchors.length} 个`, '添加时间点', addAnchor));
      wrap.appendChild(el('p.timeline-hint', {},
        '从哪个时间点开局；第一个是默认起点，每个时间点各有一份开场种子。'));

      const anchorList = el('div.anchor-edit-list');
      anchors.forEach((a, i) => {
        const labelInput = el('input.field', {
          value: a.label, placeholder: '如「序章 · 雨街」',
          oninput: (e) => { a.label = e.target.value; },
        });
        const seedInput = growTextarea(el('textarea.field', {
          rows: 3, placeholder: '这个时间点的开场种子（新写，不抄原文）',
          oninput: (e) => { a.opening_seed = e.target.value; },
        }), 220);
        seedInput.value = a.opening_seed || '';
        const noteInput = el('input.field', {
          value: a.note || '', placeholder: '备注（可选）',
          oninput: (e) => { a.note = e.target.value; },
        });
        anchorList.appendChild(el('div.anchor-edit', {},
          el('div.anchor-edit-head', {},
            el('span.anchor-edit-idx', {}, i === 0 ? '默认' : `#${i + 1}`),
            labelInput,
            anchors.length > 1
              ? el('button.btn-icon', {
                type: 'button', title: '删除这个时间点',
                onclick: () => { anchors.splice(i, 1); markDirty(); render(true); },
              }, icon('trash', { size: 14 }))
              : null,
          ),
          el('div.anchor-edit-body', {}, seedInput, noteInput),
        ));
      });
      wrap.appendChild(anchorList);

      wrap.appendChild(sectionHead('事件记录', `${events.length} 条`, '添加事件', addEvent));
      wrap.appendChild(el('p.timeline-hint', {},
        '每条只写「何时、发生了什么」。既定事实会约束剧情；原著后续只作校勘参考。'));

      if (!events.length) {
        wrap.appendChild(el('div.timeline-empty', {},
          el('div.timeline-empty-icon', {}, icon('clock', { size: 18 })),
          el('div.timeline-empty-title', {}, '还没有事件'),
          el('div.timeline-empty-sub', {}, '原创世界可以留空——一切从开局开始长。'),
        ));
      } else {
        wrap.appendChild(buildEventList());
      }

      return wrap;

      function sectionHead(title, count, addLabel, onAdd) {
        return el('div.sect-head', {},
          el('div.sect-head-main', {},
            el('h3.sect-title', {}, title),
            el('span.sect-count', {}, count),
          ),
          el('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: onAdd },
            icon('plus', { size: 13 }), addLabel),
        );
      }

      function addAnchor() {
        anchors.push({
          id: 'anchor-' + Date.now().toString(36),
          label: '新时间点', after_event: '', snapshot: {}, opening_seed: '', note: '',
        });
        markDirty();
        render(true);
      }

      function addEvent() {
        events.push({
          id: 'evt-' + Date.now().toString(36),
          when: '', what: '', who: [], canon: 'past', source: '',
        });
        markDirty();
        render(true);
      }

      function buildEventList() {
        const list = el('div.tl-edit-list');

        events.forEach((e, i) => {
          const whenInput = el('input.field.tl-when', {
            value: e.when || '', placeholder: '何时',
            oninput: (ev) => { e.when = ev.target.value; },
          });

          const whatInput = growTextarea(el('textarea.field.tl-what', {
            rows: 2, placeholder: '发生了什么',
            oninput: (ev) => { e.what = ev.target.value; },
          }), 220);
          whatInput.value = e.what || '';

          const card = el('div.tl-event');
          const setCanon = (value) => {
            e.canon = value;
            card.classList.toggle('is-future', value === 'future');
            card.classList.toggle('is-past', value !== 'future');
            pastBtn.classList.toggle('is-active', value !== 'future');
            futureBtn.classList.toggle('is-active', value === 'future');
            markDirty();
          };
          const pastBtn = el('button.segmented-item', {
            type: 'button',
            class: e.canon === 'future' ? '' : 'is-active',
            onclick: () => setCanon('past'),
          }, '既定');
          const futureBtn = el('button.segmented-item', {
            type: 'button',
            class: e.canon === 'future' ? 'is-active' : '',
            onclick: () => setCanon('future'),
          }, '原著');
          card.classList.add(e.canon === 'future' ? 'is-future' : 'is-past');

          card.append(
            el('div.tl-event-rail', {}, el('span.tl-event-dot')),
            el('div.tl-event-body', {},
              el('div.tl-event-head', {},
                whenInput,
                el('div.segmented.tl-canon', {}, pastBtn, futureBtn),
                el('button.btn-icon', {
                  type: 'button', title: '删除这条事件',
                  onclick: () => { events.splice(i, 1); markDirty(); render(true); },
                }, icon('trash', { size: 14 })),
              ),
              whatInput,
            ),
          );
          list.appendChild(card);
        });

        return list;
      }
    }

    function openingPane() {
      const wrap = el('div');
      wrap.appendChild(paneHead('开场', '给第一幕一个具体的落点；留空也可以，引擎会依据宪章起笔。'));
      const anchor = model.card.anchors[0];
      const ta = el('textarea.field', {
        rows: 10,
        placeholder: '开场种子：交代场景、人物、第一个悬念。引擎会把它扩写成完整的开场。',
      });
      ta.value = anchor.opening_seed || '';
      growTextarea(ta, 420);
      ta.addEventListener('input', () => {
        anchor.opening_seed = ta.value;
        updateCount();
      });

      const count = el('span.fgroup-count');
      function updateCount() {
        count.textContent = `${charCount(anchor.opening_seed)} 字`;
        paintTabBadges();
      }
      updateCount();

      wrap.appendChild(el('div.fgroup', {},
        el('div.fgroup-head', {}, el('div.fgroup-label', {}, '开场种子'), count),
        ta,
        el('div.fgroup-hint', {}, '留空也可以——引擎会依据宪章自行起笔。'),
      ));

      return wrap;
    }

    /* =====================================================================
     * 提交
     * ===================================================================== */
    async function submit() {
      if (saving) return;
      if (!model.card.title.trim()) {
        toast('先给世界起个名字');
        activeTab = 'basic';
        render();
        requestAnimationFrame(() => scroll.querySelector('.editor-title-input')?.focus());
        return;
      }

      saving = true;
      saveBtn.disabled = true;
      clear(saveBtn);
      saveBtn.appendChild(el('span.spinner.is-light'));
      saveBtn.appendChild(el('span', { style: 'margin-left:5px;' }, '保存中'));

      try {
        const payload = {
          id: model.id || slugify(model.card.title),
          title: model.card.title.trim(),
          subtitle: model.card.subtitle,
          cover_hue: model.coverHue,
          tags: model.tags,
          card: cleanCard(model.card),
        };

        let world;
        if (isEdit) {
          world = await api.patchWorld(worldId, payload);
        } else {
          world = await api.saveWorld(payload);
        }

        setDirty(false);
        toast('已保存', { type: 'success' });
        window.dispatchEvent(new CustomEvent('worlds:changed'));
        navigate(`#/world/${world.id}`);
      } catch (err) {
        toast(err.message || '保存失败', { type: 'error' });
        saveBtn.disabled = false;
        clear(saveBtn);
        saveBtn.appendChild(document.createTextNode(isEdit ? '保存' : '创建'));
      } finally {
        saving = false;
      }
    }

    return {
      unmount() {
        document.title = '叙事台';
        document.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('beforeunload', onBeforeUnload);
        if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      },
    };
  },
};

/* =========================================================================
 * 工具
 * ========================================================================= */

function normalizeCard(card) {
  const prompt = card.prompt || {};
  return {
    title: card.title || '',
    subtitle: card.subtitle || '',
    genre: card.genre || [],
    prompt: {
      premise: prompt.premise || '',
      tone: prompt.tone || card.genre || [],
      style_guide: prompt.style_guide || '',
      narrator_notes: prompt.narrator_notes || '',
      bans: prompt.bans || [],
      pov: prompt.pov || '',
      length: prompt.length || '',
      tense: prompt.tense || '',
    },
    charter: (card.charter || []).map((c) => (
      typeof c === 'string' ? { rule: c, kind: 'law' } : { rule: c.rule || '', kind: c.kind || 'law' }
    )),
    player: {
      name: '', age: '', identity: '', situation: '', capability: '',
      inner_voice: '', wants: '', afraid: '',
      ...(card.player || {}),
    },
    cast: (card.cast || []).map((c) => ({
      id: c.id || c.name || '',
      name: c.name || '',
      aliases: c.aliases || [],
      role: c.role || '',
      one_line: c.one_line || '',
      identity: c.identity || {},
      voice: c.voice || {},
      psyche: c.psyche || {},
      knowledge: c.knowledge || {},
      agenda: c.agenda || [],
      relations: c.relations || [],
      always_present: !!c.always_present,
      weight: c.weight ?? 0.5,
    })),
    codex: (card.codex || []).map((e) => ({ ...e })),
    timeline: (card.timeline || []).map((e) => ({ ...e })),
    anchors: (card.anchors && card.anchors.length)
      ? card.anchors.map((a) => ({ ...a }))
      : [{
        id: 'prologue', label: '序章', after_event: '',
        snapshot: {}, opening_seed: '', note: '',
      }],
  };
}

function cleanCard(card) {
  return {
    ...card,
    charter: card.charter.filter((c) => c.rule && c.rule.trim()),
    cast: card.cast.filter((c) => c.name && c.name.trim()),
    codex: card.codex.filter((e) => e.name && e.name.trim()),
    timeline: card.timeline.filter((e) => e.what && e.what.trim()),
    anchors: card.anchors.filter((a) => a.label && a.label.trim()),
  };
}

/** 「顿号/逗号」分隔的列表。 */
function splitText(text) {
  return String(text || '').split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean);
}

/** 按行拆分的列表（保留行内标点）。 */
function splitLines(text) {
  return String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

/** 编辑器里统一的「左侧字段名 + 右侧输入」行。 */
function editorRow(label, input) {
  return el('div.editor-row', {},
    el('span.editor-row-key', {}, label),
    input,
  );
}

/** 多行输入随内容增高，超过上限后内部滚动。 */
function growTextarea(ta, max = 160) {
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  };
  ta.addEventListener('input', grow);
  requestAnimationFrame(grow);
  return ta;
}

function fgroup(label, input, hint) {
  return el('div.fgroup', {},
    el('div.fgroup-head', {}, el('div.fgroup-label', {}, label)),
    input,
    hint ? el('div.fgroup-hint', {}, hint) : null,
  );
}

function field(label, input, hint) {
  return el('div', {},
    el('label.field-label', {}, label),
    input,
    hint ? el('div.field-hint', {}, hint) : null,
  );
}

function slugify(s) {
  const base = String(s || '').trim().toLowerCase();
  const ascii = base.replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii || `world-${Math.random().toString(36).slice(2, 10)}`;
}
