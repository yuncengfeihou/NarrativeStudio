/**
 * views/world-edit.js — 世界卡编辑器
 *
 * 七个分段：基本 / 宪章 / 主角 / 卡司 / 幕 / 词条 / 开场
 * 编辑的是「世界卡」，不是某一段剧情——改一次，以后每次开局都用新的。
 */

import { el, clear, charCount } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, showLoading, hideLoading, openSheet, openActionSheet, confirmDialog } from '../app.js';
import { hueTint, hueGlyph } from '../ui-kit.js';

const CATEGORY_OPTIONS = [
  ['setting', '设定'], ['rule', '规则'], ['location', '地点'], ['institution', '制度'],
  ['faction', '势力'], ['character', '人物'], ['item', '物件'],
  ['mystery', '悬念'], ['foreshadow', '伏笔'],
];

export default {
  id: 'world-edit',
  title: '编辑世界卡',

  async mount(root, params) {
    const worldId = params.id || null;
    const isEdit = !!worldId;

    /* ---------------- 模型 ---------------- */
    const model = {
      id: worldId,
      coverHue: 220,
      tags: [],
      card: {
        title: '', subtitle: '', genre: [],
        style: { pov: '', voice: '', length: '', tense: '' },
        charter: [],
        player: { name: '', age: '', identity: '', situation: '', capability: '', inner_voice: '', wants: '', afraid: '' },
        cast: [],
        arcs: [],
        arc_turns: 8,
        bans: [],
        opening_seed: '',
      },
      lore: [],
    };

    let loading = isEdit;
    let saving = false;
    let activeTab = 'basic';

    /* ---------------- 骨架 ---------------- */
    const navTitle = el('div.topbar-title', {}, isEdit ? '编辑世界卡' : '新建世界卡');
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
      el('div.topbar-actions', {},
        el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: submit },
          isEdit ? '保存' : '创建'),
      ),
    );

    const scroll = el('div.scroll');
    const view = el('section.view', { 'data-view': 'world-edit' }, nav, scroll);
    root.appendChild(view);

    /* ---------------- 载入 ---------------- */
    if (isEdit) {
      showLoading();
      try {
        const w = await api.getWorld(worldId);
        model.coverHue = w.cover_hue ?? 220;
        model.tags = w.tags || [];
        model.card = normalizeCard(w.card || {});
        model.lore = w.lore || [];
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
    loading = false;
    render();

    /* =====================================================================
     * 渲染
     * ===================================================================== */
    function render() {
      clear(scroll);
      const box = el('div.page.is-narrow.editor');
      box.appendChild(hero());
      box.appendChild(tabs());
      box.appendChild(pane('basic', basicPane()));
      box.appendChild(pane('charter', charterPane()));
      box.appendChild(pane('player', playerPane()));
      box.appendChild(pane('cast', castPane()));
      box.appendChild(pane('arcs', arcsPane()));
      box.appendChild(pane('lore', lorePane()));
      box.appendChild(pane('opening', openingPane()));
      scroll.appendChild(box);
    }

    function hero() {
      const cover = el('div.editor-cover', {
        style: `background:${hueTint(model.coverHue, { s: 34, l: 38 })};`,
        title: '点击更换色调',
        onclick: () => openHuePicker(),
      }, [...(model.card.title || '世')][0]);

      const titleInput = el('input.editor-title-input', {
        type: 'text', placeholder: '世界叫什么名字', maxlength: 60, value: model.card.title,
        oninput: (e) => {
          model.card.title = e.target.value;
          cover.textContent = [...(model.card.title || '世')][0];
          navTitle.textContent = model.card.title || (isEdit ? '编辑世界卡' : '新建世界卡');
        },
      });

      return el('div.editor-hero', {},
        cover,
        el('div', { style: 'flex:1;min-width:0;' },
          titleInput,
          model.card.subtitle
            ? el('div', { style: 'font-size:var(--fs-caption);color:var(--ink-3);margin-top:3px;' }, model.card.subtitle)
            : el('div', { style: 'font-size:var(--fs-caption);color:var(--ink-4);margin-top:3px;' }, '一句话简介会显示在列表里'),
        ),
      );
    }

    function openHuePicker() {
      const slider = el('input', {
        type: 'range', min: 0, max: 359, style: 'width:100%;accent-color:var(--accent);',
      });
      slider.value = String(model.coverHue);
      const preview = el('div', {
        style: `width:48px;height:48px;border-radius:8px;flex:none;background:${hueTint(model.coverHue, { s: 34, l: 38 })};`,
      });
      slider.addEventListener('input', () => {
        model.coverHue = Number(slider.value);
        preview.style.background = hueTint(model.coverHue, { s: 34, l: 38 });
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
          render();
        },
      });
    }

    function tabs() {
      const items = [
        ['basic', '基本', 'list'],
        ['charter', '宪章', 'scroll'],
        ['player', '主角', 'user'],
        ['cast', '卡司', 'users'],
        ['arcs', '幕', 'layers'],
        ['lore', '词条', 'file'],
        ['opening', '开场', 'play'],
      ];
      const bar = el('div.editor-tabs');
      for (const [key, label, iconName] of items) {
        const hasContent = key === 'charter' ? model.card.charter.length > 0
          : key === 'cast' ? model.card.cast.length > 0
            : key === 'arcs' ? model.card.arcs.length > 0
              : key === 'lore' ? model.lore.length > 0
                : key === 'opening' ? !!model.card.opening_seed.trim() : false;
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
        }, icon(iconName, { size: 13 }), label, hasContent ? el('span.tab-dot') : null));
      }
      return bar;
    }

    function pane(name, content) {
      return el('div.editor-pane', {
        class: activeTab === name ? 'is-active' : '',
        dataset: { pane: name },
      }, content);
    }

    /* ---- 基本 ---- */
    function basicPane() {
      const wrap = el('div');

      const subInput = el('input.field', {
        type: 'text', placeholder: '一句话简介（显示在世界卡列表里）', value: model.card.subtitle,
        oninput: (e) => { model.card.subtitle = e.target.value; },
      });
      wrap.appendChild(fgroup('简介', subInput));

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
              onclick: (e) => { e.stopPropagation(); model.tags.splice(i, 1); model.card.genre = model.tags.slice(); paintTags(); },
            }, icon('close', { size: 8, stroke: 2.4 })),
          ));
        });
        tagBox.appendChild(tagInput);
      }
      paintTags();
      wrap.appendChild(fgroup('风格标签', tagBox, '用于筛选，也提示引擎的用词取向。'));

      // 文风
      const style = model.card.style;
      const styleRows = [
        ['pov', '视角', '第三人称限知，镜头贴在主角身上'],
        ['voice', '文风', '短句为主，对白与动作交错'],
        ['length', '篇幅', '1600-2600 字'],
        ['tense', '时态', '过去时叙述'],
      ];
      const styleCard = el('div.group-card');
      for (const [key, label, placeholder] of styleRows) {
        const inp = el('input', {
          type: 'text', placeholder, value: style[key] || '',
          style: 'flex:1;min-width:0;font-size:var(--fs-caption);color:var(--ink-2);padding:2px 0;',
          oninput: (e) => { style[key] = e.target.value; },
        });
        styleCard.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:flex-start;padding:8px 12px;border-top:1px solid var(--line-soft);' },
          el('span', { style: 'flex:none;width:34px;font-size:10px;font-weight:600;letter-spacing:0.04em;color:var(--ink-4);padding-top:3px;' }, label),
          inp,
        ));
      }
      wrap.appendChild(fgroup('演出范式', styleCard, '这四项会直接写进每一轮的演绎契约。'));

      // 每幕轮数
      const turnsInput = el('input.field', {
        type: 'number', min: 3, max: 30, value: String(model.card.arc_turns || 8),
        style: 'max-width:110px;',
        oninput: (e) => { model.card.arc_turns = Number(e.target.value) || 8; },
      });
      wrap.appendChild(fgroup('每幕默认轮数', turnsInput, '没有单独设置 turns 的幕会用它。'));

      return wrap;
    }

    /* ---- 宪章 ---- */
    function charterPane() {
      const wrap = el('div');
      const list = el('div', { style: 'display:flex;flex-direction:column;gap:7px;' });
      paintCharter();

      function paintCharter() {
        clear(list);
        model.card.charter.forEach((c, i) => {
          const ta = el('textarea.field', { rows: 2, style: 'font-size:var(--fs-caption);' });
          ta.value = c.rule || '';
          ta.addEventListener('input', () => { c.rule = ta.value; });
          list.appendChild(el('div', {
            style: 'display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--paper-raised);',
          },
            el('span', { style: 'flex:none;width:18px;font-size:var(--fs-caption);font-weight:650;color:var(--ink-4);padding-top:7px;' },
              String(i + 1).padStart(2, '0')),
            ta,
            el('button.icon-btn.is-sm', {
              type: 'button', title: '删除', style: 'margin-top:4px;',
              onclick: () => { model.card.charter.splice(i, 1); paintCharter(); },
            }, icon('trash', { size: 12 })),
          ));
        });
        list.appendChild(el('button.cast-add', {
          type: 'button',
          onclick: () => { model.card.charter.push({ rule: '' }); paintCharter(); },
        }, icon('plus', { size: 13 }), '添加一条宪章'));
      }

      wrap.appendChild(list);
      wrap.appendChild(el('div.group-note', { style: 'padding-top:10px;' },
        '宪章是「任何场景下都成立」的硬设定——世界的物理、制度、礼法、尺度。' +
        '不写具体事件，只写这个世界的规则。它会每轮都进入上下文（约占 1.5K tok）。'));
      return wrap;
    }

    /* ---- 主角 ---- */
    function playerPane() {
      const wrap = el('div');
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
        card.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:flex-start;padding:8px 12px;border-top:1px solid var(--line-soft);' },
          el('span', { style: 'flex:none;width:52px;font-size:10px;font-weight:600;letter-spacing:0.04em;color:var(--ink-4);padding-top:3px;' }, label),
          inp,
        ));
      }
      wrap.appendChild(card);
      wrap.appendChild(el('div.group-note', { style: 'padding-top:10px;' },
        '主角速写会每轮进入上下文（约 0.6K tok）。这里写的不是设定百科，而是「引擎在演绎时最需要记住的那几件事」。'));
      return wrap;
    }

    /* ---- 卡司 ---- */
    function castPane() {
      const wrap = el('div');
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
      }

      function addCharacter() {
        model.card.cast.push({
          name: '', role: '', one_line: '', personality: '', voice: '', secret: '',
          background: '', relation: '', manner: '', always: false,
          avatar_hue: Math.floor(Math.random() * 360),
          weight: 0.5,
        });
        paintCast();
        requestAnimationFrame(() => {
          const inputs = list.querySelectorAll('.cast-name-input');
          inputs[inputs.length - 1]?.focus();
        });
      }

      function castCard(c, index) {
        const hue = typeof c.avatar_hue === 'number' ? c.avatar_hue : 210;
        const avatar = el('div.cast-avatar', {
          style: `background:${hueTint(hue, { s: 32, l: 40 })};`,
          title: '点击更换色调',
          onclick: () => {
            c.avatar_hue = (hue + 47) % 360;
            render();
          },
        }, [...(c.name || '新')][0]);

        const nameInput = el('input.cast-name-input', {
          type: 'text', placeholder: '角色名', value: c.name,
          oninput: (e) => {
            c.name = e.target.value;
            avatar.textContent = [...(c.name || '新')][0];
          },
        });
        const roleInput = el('input.cast-role-input', {
          type: 'text', placeholder: '身份 / 与主角的关系', value: c.role,
          oninput: (e) => { c.role = e.target.value; },
        });

        const alwaysSw = el('div.switch', {
          role: 'switch', 'aria-checked': String(!!c.always), tabindex: '0',
          style: 'width:28px;height:16px;',
        }, el('div.switch-knob', { style: 'width:12px;height:12px;' }));
        alwaysSw.addEventListener('click', () => {
          c.always = !c.always;
          alwaysSw.setAttribute('aria-checked', String(c.always));
        });

        const card = el('div.cast-card', { style: `--char-hue:${hueTint(hue, { s: 32, l: 40 })};` },
          el('div.cast-head', {},
            avatar,
            el('div', { style: 'flex:1;min-width:0;' }, nameInput, roleInput),
            el('div', { style: 'display:flex;align-items:center;gap:6px;flex:none;' },
              el('span', { style: 'font-size:10px;color:var(--ink-4);' }, '常驻'),
              alwaysSw,
              el('button.icon-btn.is-sm', {
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
                    paintCast();
                  } else if (action === 'down' && index < model.card.cast.length - 1) {
                    [model.card.cast[index + 1], model.card.cast[index]] = [model.card.cast[index], model.card.cast[index + 1]];
                    paintCast();
                  } else if (action === 'delete') {
                    model.card.cast.splice(index, 1);
                    paintCast();
                  }
                },
              }, icon('more', { size: 14 })),
            ),
          ),
          el('div.cast-body', {},
            row('一句话', '一句话能概括这个人（显示在卡司网格里）', c.one_line, (v) => { c.one_line = v; }, true),
            row('性格', '冷静、敏锐、外冷内热…', c.personality, (v) => { c.personality = v; }, true),
            row('口吻', '台词风格，含自称与对主角的称呼', c.voice, (v) => { c.voice = v; }, true),
            row('关系', '与主角的关系', c.relation, (v) => { c.relation = v; }, true),
            row('秘密', '不为人知的动机——引擎会遵守，但不会说破', c.secret, (v) => { c.secret = v; }, true),
            row('背景', '过往经历、立场、与主角的渊源', c.background, (v) => { c.background = v; }, true),
          ),
        );
        return card;
      }

      function row(label, placeholder, value, setter, multiline = false) {
        const inp = multiline
          ? el('textarea', { rows: 1, placeholder })
          : el('input', { type: 'text', placeholder });
        inp.value = value || '';
        inp.addEventListener('input', (e) => {
          setter(e.target.value);
          if (multiline) {
            inp.style.height = 'auto';
            inp.style.height = `${Math.min(inp.scrollHeight, 120)}px`;
          }
        });
        if (multiline && value) {
          requestAnimationFrame(() => {
            inp.style.height = 'auto';
            inp.style.height = `${Math.min(inp.scrollHeight, 120)}px`;
          });
        }
        return el('div.cast-row', {}, el('span.cast-key', {}, label), inp);
      }

      wrap.appendChild(list);
      wrap.appendChild(el('div.group-note', { style: 'padding-top:10px;' },
        '只有「本轮在场」的角色卡会进入上下文。「常驻」的人物（如随时在场的亲人）每轮都在。' +
        '所以卡司可以写得很细，而上下文只装这一轮真正需要的那几张。'));
      return wrap;
    }

    /* ---- 幕 ---- */
    function arcsPane() {
      const wrap = el('div');
      const list = el('div.arc-edit-list');
      paintArcs();

      function paintArcs() {
        clear(list);
        model.card.arcs.forEach((a, i) => list.appendChild(arcCard(a, i)));
        list.appendChild(el('button.cast-add', {
          type: 'button',
          onclick: () => {
            model.card.arcs.push({ title: '', goal: '', beats: [], avoid: [], turns: model.card.arc_turns || 8 });
            paintArcs();
          },
        }, icon('plus', { size: 14 }), '添加一幕'));
      }

      function arcCard(a, index) {
        const titleInput = el('input', {
          type: 'text', placeholder: '这一幕的标题', value: a.title || '',
          style: 'flex:1;min-width:0;font-size:var(--fs-label);font-weight:600;color:var(--ink);padding:2px 0;',
          oninput: (e) => { a.title = e.target.value; },
        });
        const turnsInput = el('input', {
          type: 'number', min: 3, max: 30, value: String(a.turns || model.card.arc_turns || 8),
          style: 'width:52px;padding:3px 6px;font-size:var(--fs-caption);background:var(--paper-sunken);border:1px solid var(--line);border-radius:5px;',
          oninput: (e) => { a.turns = Number(e.target.value) || 8; },
        });

        const goalTa = el('textarea.field', { rows: 2, placeholder: '这一幕要达成什么（一句话）' });
        goalTa.value = a.goal || '';
        goalTa.addEventListener('input', () => { a.goal = goalTa.value; });

        const beatsTa = el('textarea.field', { rows: 3, placeholder: '必达节拍，每行一个' });
        beatsTa.value = (a.beats || []).join('\n');
        beatsTa.addEventListener('input', () => {
          a.beats = beatsTa.value.split('\n').map((s) => s.trim()).filter(Boolean);
        });

        const avoidTa = el('textarea.field', { rows: 2, placeholder: '这一幕不要做的事，每行一个' });
        avoidTa.value = (a.avoid || []).join('\n');
        avoidTa.addEventListener('input', () => {
          a.avoid = avoidTa.value.split('\n').map((s) => s.trim()).filter(Boolean);
        });

        return el('div.arc-edit', {},
          el('div.arc-edit-head', {},
            el('span.arc-edit-num', {}, String(index + 1).padStart(2, '0')),
            titleInput,
            el('span', { style: 'font-size:10px;color:var(--ink-4);' }, '轮'),
            turnsInput,
            el('button.icon-btn.is-sm', {
              type: 'button', title: '删除',
              onclick: () => { model.card.arcs.splice(index, 1); paintArcs(); },
            }, icon('trash', { size: 12 })),
          ),
          el('div.arc-edit-body', {},
            el('div', {}, el('label.field-label', {}, '这一幕要达成'), goalTa),
            el('div', {}, el('label.field-label', {}, '必达节拍'), beatsTa),
            el('div', {}, el('label.field-label', {}, '忌避'), avoidTa),
          ),
        );
      }

      wrap.appendChild(list);
      wrap.appendChild(el('div.group-note', { style: 'padding-top:10px;' },
        '幕结构解决「设定很丰富但剧情原地打转」。引擎每轮会收到当前幕的目标与节拍，' +
        '并据此把剧情往前推——而不是无限铺陈氛围。'));
      return wrap;
    }

    /* ---- 词条 ---- */
    function lorePane() {
      const wrap = el('div');
      const list = el('div.lore-list');
      paintLore();

      function paintLore() {
        clear(list);
        if (!model.lore.length) {
          list.appendChild(el('div.empty', { style: 'padding:28px 20px;' },
            el('div.empty-icon', {}, icon('file', { size: 18 })),
            el('div.empty-title', {}, '还没有词条'),
            el('div.empty-sub', {}, '词条是「按需进入上下文」的设定碎片。'),
          ));
        }
        model.lore.forEach((e) => {
          const item = el('div.lore-item');
          const head = el('button.lore-head', { type: 'button' },
            e.constant ? el('span.chip.is-accent', { style: 'font-size:9px;padding:0 4px;' }, '常驻') : null,
            el('span.lore-title', {}, e.title || (e.content || '').slice(0, 20)),
            el('span.lore-keys', {}, ...(e.keys || []).slice(0, 2).map((k) => el('span.lore-key', {}, k))),
            el('span', { style: 'display:flex;color:var(--ink-4);' }, icon('chevronDown', { size: 11 })),
          );
          head.addEventListener('click', () => item.classList.toggle('is-open'));

          const body = el('div.lore-body', {},
            el('div.lore-content', {}, e.content),
            el('div', { style: 'display:flex;gap:5px;margin-top:9px;' },
              el('button.btn.btn-ghost.btn-sm', {
                type: 'button', onclick: () => editEntry(e),
              }, '编辑'),
              el('button.btn.btn-ghost.btn-sm', {
                type: 'button', style: 'color:var(--danger);',
                onclick: () => { model.lore = model.lore.filter((x) => x !== e); paintLore(); },
              }, '移除'),
            ),
          );

          item.appendChild(head);
          item.appendChild(body);
          list.appendChild(item);
        });

        list.appendChild(el('button.cast-add', {
          type: 'button', style: 'margin-top:7px;',
          onclick: () => editEntry(null),
        }, icon('plus', { size: 14 }), '新增词条'));
      }

      function editEntry(entry) {
        const isNew = !entry;
        const draft = entry || { title: '', keys: [], secondary: [], content: '', category: 'setting', constant: false, priority: 50 };

        const titleInput = el('input.field', { value: draft.title || '', placeholder: '标题' });
        const keysInput = el('input.field', {
          value: (draft.keys || []).join('、'), placeholder: '触发词，顿号分隔',
        });
        const secInput = el('input.field', {
          value: (draft.secondary || []).join('、'), placeholder: '二次触发词（可选）',
        });
        const contentInput = el('textarea.field', { rows: 6 });
        contentInput.value = draft.content || '';
        const catSel = el('select.field', { style: 'height:32px;' },
          ...CATEGORY_OPTIONS.map(([v, l]) => el('option', { value: v, selected: draft.category === v || undefined }, l)));
        const constSw = el('div.switch', { role: 'switch', 'aria-checked': String(!!draft.constant), tabindex: '0' },
          el('div.switch-knob'));
        let isConst = !!draft.constant;
        constSw.addEventListener('click', () => {
          isConst = !isConst;
          constSw.setAttribute('aria-checked', String(isConst));
        });

        openSheet({
          title: isNew ? '新增词条' : '编辑词条',
          confirmText: '确定',
          render(body) {
            body.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:11px;' },
              el('div', {}, el('label.field-label', {}, '标题'), titleInput),
              el('div', {}, el('label.field-label', {}, '触发词'), keysInput,
                el('div.field-hint', {}, '任一触发词出现在最近文本里，这条词条就进入上下文。')),
              el('div', {}, el('label.field-label', {}, '二次触发词'), secInput),
              el('div', {}, el('label.field-label', {}, '内容'), contentInput),
              el('div', { style: 'display:flex;gap:10px;align-items:center;' },
                el('div', { style: 'flex:1;' }, catSel),
                constSw,
                el('span', { style: 'font-size:var(--fs-caption);color:var(--ink-2);' }, '常驻'),
              ),
            ));
          },
          onConfirm() {
            const content = contentInput.value.trim();
            if (!content) { toast('内容不能为空'); return false; }
            const payload = {
              title: titleInput.value.trim(),
              keys: splitKeys(keysInput.value),
              secondary: splitKeys(secInput.value),
              content,
              category: catSel.value,
              constant: isConst,
              priority: draft.priority ?? 50,
            };
            if (isNew) model.lore.push({ ...payload, _new: true });
            else Object.assign(draft, payload);
            paintLore();
            return true;
          },
        });
      }

      wrap.appendChild(list);
      wrap.appendChild(el('div.group-note', { style: 'padding-top:10px;' },
        `词条只在被触发时进入上下文——这是「设定可以很细，但上下文不膨胀」的关键。当前 ${model.lore.length} 条。`));
      return wrap;
    }

    /* ---- 开场 ---- */
    function openingPane() {
      const wrap = el('div');
      const ta = el('textarea.field', { rows: 14, placeholder: '开场种子：交代场景、人物、第一个悬念。引擎会把它扩写成完整的开场。' });
      ta.value = model.card.opening_seed || '';
      ta.addEventListener('input', () => {
        model.card.opening_seed = ta.value;
        updateCount();
      });

      const count = el('span.fgroup-count');
      function updateCount() {
        count.textContent = `${charCount(model.card.opening_seed)} 字`;
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
      const btn = nav.querySelector('.btn-primary');
      btn.disabled = true;
      clear(btn);
      btn.appendChild(el('span.spinner.is-light'));
      btn.appendChild(el('span', { style: 'margin-left:5px;' }, '保存中'));

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
          // 词条：全量替换（简单可靠）
          await api.saveWorld({ ...payload, id: worldId, lore: cleanLore(model.lore) });
        } else {
          world = await api.saveWorld({ ...payload, lore: cleanLore(model.lore) });
        }

        toast('已保存', { type: 'success' });
        window.dispatchEvent(new CustomEvent('worlds:changed'));
        navigate(`#/world/${world.id}`);
      } catch (err) {
        toast(err.message || '保存失败', { type: 'error' });
        btn.disabled = false;
        clear(btn);
        btn.appendChild(document.createTextNode(isEdit ? '保存' : '创建'));
      } finally {
        saving = false;
      }
    }

    return {
      unmount() { document.title = '叙事台'; },
    };
  },
};

/* =========================================================================
 * 工具
 * ========================================================================= */

function normalizeCard(card) {
  return {
    title: card.title || '',
    subtitle: card.subtitle || '',
    genre: card.genre || [],
    style: {
      pov: card.style?.pov || '',
      voice: card.style?.voice || '',
      length: card.style?.length || '',
      tense: card.style?.tense || '',
    },
    charter: Array.isArray(card.charter)
      ? card.charter.map((c) => (typeof c === 'string' ? { rule: c } : { rule: c.rule || c.text || '' }))
      : [],
    player: {
      name: '', age: '', identity: '', situation: '', capability: '',
      inner_voice: '', wants: '', afraid: '',
      ...(card.player || {}),
    },
    cast: (card.cast || []).map((c) => ({ ...c })),
    arcs: (card.arcs || []).map((a) => ({
      title: a.title || '',
      goal: a.goal || '',
      beats: a.beats || [],
      avoid: a.avoid || [],
      turns: a.turns || card.arc_turns || 8,
    })),
    arc_turns: card.arc_turns || 8,
    bans: card.bans || [],
    opening_seed: card.opening_seed || '',
  };
}

function cleanCard(card) {
  return {
    ...card,
    charter: card.charter.filter((c) => c.rule && c.rule.trim()),
    cast: card.cast.filter((c) => c.name && c.name.trim()),
    arcs: card.arcs.filter((a) => a.title && a.title.trim()),
    bans: (card.bans || []).filter((b) => b && b.trim()),
  };
}

function cleanLore(lore) {
  return lore
    .filter((e) => e.content && e.content.trim())
    .map((e) => ({
      title: e.title || '',
      keys: e.keys || [],
      secondary: e.secondary || [],
      content: e.content,
      category: e.category || 'setting',
      constant: !!e.constant,
      priority: e.priority ?? 50,
    }));
}

function splitKeys(text) {
  return String(text || '').split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean);
}

function fgroup(label, input, hint) {
  return el('div.fgroup', {},
    el('div.fgroup-head', {}, el('div.fgroup-label', {}, label)),
    input,
    hint ? el('div.fgroup-hint', {}, hint) : null,
  );
}

function slugify(s) {
  const base = String(s || '').trim().toLowerCase();
  const ascii = base.replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii || `world-${Math.random().toString(36).slice(2, 10)}`;
}
