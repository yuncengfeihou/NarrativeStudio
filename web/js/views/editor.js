/**
 * views/editor.js — 设定编辑器
 *
 * 分五个分段页签（基础 / 世界 / 角色 / 规则 / 开局），
 * 避免一次性把十几个文本框铺在用户面前。
 *
 * 交互要点：
 *  - 标题实时决定封面色与首字
 *  - 角色卡可折叠、可调色调、可排序
 *  - 开场白支持「从设定生成」（SSE 流式）
 *  - 从预设载入（#/new?preset=xxx 或选择器）
 */

import {
  el, clear, firstChar, hueFromString, hueToGradient, hueToColor, charCount,
  debounce,
} from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, showLoading, hideLoading, openSheet, openActionSheet, confirmDialog } from '../app.js';
import { syncActive } from '../sidebar.js';

const EFFORTS = [
  { value: 'low', label: '快速' },
  { value: 'medium', label: '均衡' },
  { value: 'high', label: '细腻' },
];

export default {
  id: 'editor',
  title: '设定',

  async mount(root, params) {
    const sessionId = params.id || null;
    const isEdit = !!sessionId;

    /* ---------------- 模型 ---------------- */
    const model = {
      title: '',
      styleTags: [],
      worldview: '',
      playerRole: '',
      rules: '',
      opening: '',
      characters: [],
      narratorEffort: 'high',
      contextMaxTokens: 200000,
      lengthHint: '',
    };

    let loading = isEdit;
    let saving = false;
    let generating = false;
    let genAbort = null;
    let activeTab = 'basic';

    /* ---------------- 骨架 ---------------- */
    const navTitle = el('div.nav-title', {}, isEdit ? '编辑设定' : '新建剧情');
    const nav = el('header.nav', {},
      el('button.icon-btn.nav-hamburger', {
        type: 'button', 'aria-label': '会话库',
        onclick: () => import('../sidebar.js').then((m) => m.openSidebar()),
      }, icon('sidebar', { size: 19 })),
      isEdit
        ? el('button.nav-back', { type: 'button', onclick: () => history.back() },
          icon('chevronLeft', { size: 19, stroke: 2.2 }), '返回')
        : null,
      navTitle,
      el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: submit },
        isEdit ? '保存' : '开始'),
    );

    const scroll = el('div.scroll');
    const view = el('section.view', { 'data-view': 'editor' }, nav, scroll);
    root.appendChild(view);

    scroll.addEventListener('scroll', () => {
      nav.classList.toggle('is-scrolled', scroll.scrollTop > 4);
    }, { passive: true });

    /* ---------------- 载入 ---------------- */
    showLoading();
    try {
      if (isEdit) {
        const detail = await api.getSession(sessionId);
        loadSettings(detail.session?.settings || {});
        if (detail.session?.title) model.title = detail.session.title;
      } else {
        // 支持 ?preset=xxx
        const presetId = new URLSearchParams((location.hash.split('?')[1] || '')).get('preset');
        if (presetId) {
          const p = await api.getPreset(presetId);
          loadSettings(p.settings || {});
        } else {
          const cfg = await api.getConfig();
          if (cfg?.defaults?.narrator_effort) model.narratorEffort = cfg.defaults.narrator_effort;
          if (cfg?.limits?.context_max_tokens) model.contextMaxTokens = cfg.limits.context_max_tokens;
        }
      }
    } catch (err) {
      toast(`加载失败：${err.message}`, { type: 'error' });
    } finally {
      loading = false;
      hideLoading();
    }

    render();
    syncActive(isEdit ? sessionId : null);

    /* =====================================================================
     * 渲染
     * ===================================================================== */
    function render() {
      clear(scroll);
      if (loading) {
        const sk = el('div.container.is-narrow', {});
        sk.appendChild(el('div.skeleton', { style: 'height:76px;border-radius:17px;' }));
        sk.appendChild(el('div.skeleton', { style: 'height:40px;border-radius:12px;margin-top:20px;' }));
        sk.appendChild(el('div.skeleton', { style: 'height:180px;border-radius:17px;margin-top:16px;' }));
        scroll.appendChild(sk);
        return;
      }

      const box = el('div.container.is-narrow.editor', {});
      box.appendChild(hero());
      box.appendChild(tabs());

      box.appendChild(pane('basic', basicPane()));
      box.appendChild(pane('world', worldPane()));
      box.appendChild(pane('cast', castPane()));
      box.appendChild(pane('rules', rulesPane()));
      box.appendChild(pane('opening', openingPane()));

      scroll.appendChild(box);
    }

    function hero() {
      const hue = hueFromString(model.title || '新剧情');
      const cover = el('div.editor-cover', {
        style: `background:${hueToGradient(hue)};`,
        title: '点击更换色调',
        onclick: async () => {
          const fake = { name: '', avatar_hue: hue };
          const next = await pickHue(hue);
          if (next != null) {
            cover.style.background = hueToGradient(next);
            model._hue = next;
          }
        },
      }, firstChar(model.title || '剧'));

      const titleInput = el('input.editor-title-input', {
        type: 'text', placeholder: '给这段剧情起个名字', maxlength: 60, value: model.title,
        oninput: (e) => {
          model.title = e.target.value;
          const h = hueFromString(model.title || '新剧情');
          cover.textContent = firstChar(model.title || '剧');
          if (model._hue == null) cover.style.background = hueToGradient(h);
          navTitle.textContent = model.title || (isEdit ? '编辑设定' : '新建剧情');
        },
      });

      return el('div.editor-hero', {},
        cover,
        el('div', { style: 'flex:1;min-width:0;' },
          titleInput,
          el('div', { style: 'font-size:var(--fs-caption);color:var(--label-tertiary);margin-top:3px;' },
            model.title ? `${charCount(model.title)} 字标题` : '标题会决定封面色与首字'),
        ),
      );
    }

    function tabs() {
      const items = [
        ['basic', '基础', 'list'],
        ['world', '世界', 'globe'],
        ['cast', '角色', 'users'],
        ['rules', '规则', 'scroll'],
        ['opening', '开局', 'play'],
      ];
      const bar = el('div.editor-tabs');
      for (const [key, label, iconName] of items) {
        const hasContent = key === 'world' ? !!model.worldview.trim()
          : key === 'cast' ? model.characters.length > 0
            : key === 'opening' ? !!model.opening.trim() : false;
        bar.appendChild(el('button.editor-tab', {
          type: 'button',
          class: activeTab === key ? 'is-active' : '',
          onclick: () => {
            activeTab = key;
            Array.from(bar.children).forEach((c, i) => c.classList.toggle('is-active', items[i][0] === key));
            Array.from(scroll.querySelectorAll('.editor-pane')).forEach((p) => {
              p.classList.toggle('is-active', p.dataset.pane === key);
            });
          },
        },
          icon(iconName, { size: 14 }),
          label,
          hasContent && activeTab !== key ? el('span.tab-dot') : null,
        ));
      }
      return bar;
    }

    function pane(name, content) {
      return el('div.editor-pane', { class: activeTab === name ? 'is-active' : '', dataset: { pane: name } }, content);
    }

    /* ---------------------------------------------------------------------
     * 基础
     * ------------------------------------------------------------------ */
    function basicPane() {
      const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:18px;' });

      // 风格标签
      const tagInput = el('input', {
        type: 'text',
        placeholder: '输入后回车，如：古代架空',
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
            e.preventDefault();
            const v = e.target.value.trim().replace(/[,，]$/, '');
            if (v && !model.styleTags.includes(v)) {
              model.styleTags.push(v);
              e.target.value = '';
              paintTags();
            }
          } else if (e.key === 'Backspace' && !e.target.value && model.styleTags.length) {
            model.styleTags.pop();
            paintTags();
          }
        },
      });
      const tagBox = el('div.tagbox', { onclick: () => tagInput.focus() });
      function paintTags() {
        clear(tagBox);
        model.styleTags.forEach((t, i) => {
          tagBox.appendChild(el('span.chip.is-purple', {}, t,
            el('button.tag-x', {
              type: 'button', 'aria-label': `移除 ${t}`,
              onclick: (e) => { e.stopPropagation(); model.styleTags.splice(i, 1); paintTags(); },
            }, icon('close', { size: 9, stroke: 2.6 })),
          ));
        });
        tagBox.appendChild(tagInput);
      }
      paintTags();

      wrap.appendChild(el('div.fgroup', {},
        el('div.fgroup-head', {}, el('div.fgroup-label', {}, '风格标签')),
        tagBox,
        el('div.fgroup-hint', {}, '影响引擎的用词与氛围取向，也用于首页筛选。'),
      ));

      // 叙事篇幅
      const lenInput = el('input.field', {
        type: 'text',
        placeholder: '每轮 1500-3000 字，注重氛围与感官细节',
        value: model.lengthHint,
        oninput: (e) => { model.lengthHint = e.target.value; },
      });
      wrap.appendChild(el('div.fgroup', {},
        el('div.fgroup-head', {}, el('div.fgroup-label', {}, '叙事篇幅')),
        lenInput,
        el('div.fgroup-hint', {}, '留空则使用默认（每轮 1500-3000 字）。'),
      ));

      // 高级
      wrap.appendChild(advancedBlock());

      return wrap;
    }

    function advancedBlock() {
      const seg = buildSegmented(EFFORTS, model.narratorEffort, (v) => { model.narratorEffort = v; });
      const stepper = buildStepper(model.contextMaxTokens, {
        min: 20000, max: 400000, step: 20000,
        format: (v) => `${Math.round(v / 1000)}K`,
        onChange: (v) => { model.contextMaxTokens = v; },
      });

      const card = el('div.group-card', {},
        el('div.li', {},
          el('div.li-body', {},
            el('div.li-title', {}, '演绎细腻度'),
            el('div.li-sub', {}, '越高叙事越细腻，生成也越慢'),
          ),
          seg.el,
        ),
        el('div.li', {},
          el('div.li-body', {},
            el('div.li-title', {}, '上下文上限'),
            el('div.li-sub', {}, '可回忆的历史体量，越高越不容易忘事'),
          ),
          stepper.el,
        ),
      );

      return el('div.fgroup', {},
        el('div.fgroup-head', {}, el('div.fgroup-label', {}, '高级')),
        card,
      );
    }

    /* ---------------------------------------------------------------------
     * 世界
     * ------------------------------------------------------------------ */
    function worldPane() {
      const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:18px;' });

      const wv = el('textarea.field', {
        rows: 10,
        placeholder:
          '描述这是什么样的世界：\n' +
          '· 时代与地理\n' +
          '· 社会制度与权力结构\n' +
          '· 力量体系 / 特殊规则\n' +
          '· 与故事相关的风俗与禁忌',
        oninput: (e) => { model.worldview = e.target.value; updateCount(); },
      });
      wv.value = model.worldview;

      const count = el('span.fgroup-count');
      function updateCount() { count.textContent = `${charCount(model.worldview)} 字`; }
      updateCount();

      wrap.appendChild(el('div.fgroup', {},
        el('div.fgroup-head', {},
          el('div.fgroup-label', {}, '世界观'),
          count,
        ),
        wv,
        el('div.fgroup-hint', {}, '越具体越好——具体的地名、称谓、制度会让演绎更可信。'),
      ));

      // 玩家身份
      const pr = el('textarea.field', {
        rows: 6,
        placeholder: '玩家是谁：身份、年龄、处境、目标、与主要角色的关系…',
        oninput: (e) => { model.playerRole = e.target.value; },
      });
      pr.value = model.playerRole;

      wrap.appendChild(el('div.fgroup', {},
        el('div.fgroup-head', {}, el('div.fgroup-label', {}, '玩家身份')),
        pr,
        el('div.fgroup-hint', {}, '引擎会以第三/第二人称跟随这个角色叙述，不会替你做决定。'),
      ));

      return wrap;
    }

    /* ---------------------------------------------------------------------
     * 角色
     * ------------------------------------------------------------------ */
    function castPane() {
      const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:13px;' });
      const list = el('div.cast-list');
      paintCast();

      function paintCast() {
        clear(list);
        if (!model.characters.length) {
          list.appendChild(el('div.empty', { style: 'padding:32px 20px;' },
            el('div.empty-icon', {}, icon('users', { size: 22 })),
            el('div.empty-title', {}, '还没有角色'),
            el('div.empty-sub', {}, '至少添加一位主要角色，故事才有人可寻。'),
          ));
        } else {
          model.characters.forEach((c, i) => list.appendChild(castCard(c, i)));
        }
        list.appendChild(el('button.cast-add', {
          type: 'button', onclick: addCharacter,
        }, icon('plus', { size: 15, stroke: 2.2 }), '添加角色'));
      }

      function addCharacter() {
        model.characters.push({
          name: '', role: '', personality: '', voice: '', secret: '', background: '',
          avatar_hue: Math.floor(Math.random() * 360),
        });
        paintCast();
        // 聚焦到新卡片的名字
        requestAnimationFrame(() => {
          const inputs = list.querySelectorAll('.cast-name-input');
          inputs[inputs.length - 1]?.focus();
        });
      }

      function castCard(c, index) {
        const hue = typeof c.avatar_hue === 'number' ? c.avatar_hue : hueFromString(c.name || 'x');
        const avatar = el('div.cast-avatar', {
          style: `background:${hueToColor(hue, 66, 52)};`,
          title: '点击更换色调',
          onclick: async () => {
            const next = await pickHue(hue);
            if (next == null) return;
            c.avatar_hue = next;
            avatar.style.background = hueToColor(next, 66, 52);
            card.style.setProperty('--char-hue', hueToColor(next, 66, 52));
          },
        }, firstChar(c.name || '新'));

        const nameInput = el('input.cast-name-input', {
          type: 'text', placeholder: '角色名', value: c.name,
          oninput: (e) => {
            c.name = e.target.value;
            avatar.textContent = firstChar(c.name || '新');
            if (typeof c.avatar_hue !== 'number') {
              avatar.style.background = hueToColor(hueFromString(c.name), 66, 52);
            }
          },
        });
        const roleInput = el('input.cast-role-input', {
          type: 'text', placeholder: '身份 / 与玩家的关系', value: c.role,
          oninput: (e) => { c.role = e.target.value; },
        });

        const card = el('div.cast-card', { style: `--char-hue:${hueToColor(hue, 66, 52)};` },
          el('div.cast-head', {},
            avatar,
            el('div', { style: 'flex:1;min-width:0;' }, nameInput, roleInput),
            el('button.icon-btn.is-sm', {
              type: 'button', title: '更多', 'aria-label': '角色操作',
              onclick: async (e) => {
                e.stopPropagation();
                const action = await openActionSheet({
                  title: c.name || '角色',
                  actions: [
                    { label: '上移', value: 'up', icon: 'chevronUp' },
                    { label: '下移', value: 'down', icon: 'chevronDown' },
                    { label: '删除角色', value: 'delete', icon: 'trash', destructive: true },
                  ],
                });
                if (action === 'up' && index > 0) {
                  [model.characters[index - 1], model.characters[index]] = [model.characters[index], model.characters[index - 1]];
                  paintCast();
                } else if (action === 'down' && index < model.characters.length - 1) {
                  [model.characters[index + 1], model.characters[index]] = [model.characters[index], model.characters[index + 1]];
                  paintCast();
                } else if (action === 'delete') {
                  model.characters.splice(index, 1);
                  paintCast();
                }
              },
            }, icon('more', { size: 16 })),
          ),
          el('div.cast-body', {},
            castRow('性格', '冷静、敏锐、外冷内热…', c.personality, (v) => { c.personality = v; }),
            castRow('台词', '「…」短句，句号收尾，少用感叹', c.voice, (v) => { c.voice = v; }, true),
            castRow('秘密', '不为人知的动机（引擎会遵守，但不会说破）', c.secret, (v) => { c.secret = v; }, true),
            castRow('背景', '过往经历、立场、与玩家的渊源', c.background, (v) => { c.background = v; }, true),
          ),
        );
        return card;
      }

      function castRow(label, placeholder, value, setter, multiline = false) {
        const input = multiline
          ? el('textarea', { rows: 1, placeholder })
          : el('input', { type: 'text', placeholder });
        input.value = value || '';
        input.addEventListener('input', (e) => {
          setter(e.target.value);
          if (multiline) {
            input.style.height = 'auto';
            input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
          }
        });
        if (multiline && value) {
          requestAnimationFrame(() => {
            input.style.height = 'auto';
            input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
          });
        }
        return el('div.cast-row', {},
          el('span.cast-key', {}, label),
          input,
        );
      }

      wrap.appendChild(list);
      return wrap;
    }

    /* ---------------------------------------------------------------------
     * 规则
     * ------------------------------------------------------------------ */
    function rulesPane() {
      const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:16px;' });

      const ta = el('textarea.field', {
        rows: 10,
        placeholder:
          '写清硬性规则，例如：\n' +
          '· 禁止 OOC，角色不得知道玩家未说出口的秘密\n' +
          '· 不得替玩家做决定或代写玩家台词\n' +
          '· 保持在第三人称限知视角\n' +
          '· 尺度：不写露骨情节',
        oninput: (e) => { model.rules = e.target.value; },
      });
      ta.value = model.rules;

      wrap.appendChild(el('div.fgroup', {},
        el('div.fgroup-head', {}, el('div.fgroup-label', {}, '扮演规则')),
        ta,
        el('div.fgroup-hint', {}, '规则的优先级高于引擎的默认演绎规范，适合写「绝不能发生的事」。'),
      ));

      // 常用规则快捷插入
      const presets = [
        '禁止 OOC，任何角色不得说出违背其设定的话',
        '不得替玩家角色做决定或代写玩家的台词',
        '保持第三人称限知视角，只跟随玩家角色',
        '每轮结尾停留在悬念或抉择前，不要平稳收尾',
        '不出现「作为 AI」「本章讲述了」等元叙述',
        '尺度：不写露骨情节，以留白处理',
      ];
      wrap.appendChild(el('div.fgroup', {},
        el('div.fgroup-head', {}, el('div.fgroup-label', {}, '常用规则')),
        el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' },
          ...presets.map((p) => el('button.chip', {
            type: 'button',
            style: 'cursor:pointer;',
            onclick: () => {
              if (model.rules.includes(p)) return toast('这条规则已经在里面了');
              model.rules = (model.rules ? model.rules.trimEnd() + '\n' : '') + `· ${p}`;
              ta.value = model.rules;
              toast('已插入', { type: 'success' });
            },
          }, '+ ', p)),
        ),
      ));

      return wrap;
    }

    /* ---------------------------------------------------------------------
     * 开局
     * ------------------------------------------------------------------ */
    function openingPane() {
      const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:14px;' });

      const ta = el('textarea.field', {
        rows: 9,
        placeholder: '第一幕的引子：场景、氛围、第一个悬念。大约 200-800 字，引擎会把它扩写成完整开场。',
        oninput: (e) => { model.opening = e.target.value; updateCount(); },
      });
      ta.value = model.opening;

      const count = el('span.fgroup-count');
      function updateCount() { count.textContent = `${charCount(model.opening)} 字`; }
      updateCount();

      const genBtn = el('button.btn.btn-tinted.btn-sm', { type: 'button', onclick: generateOpening },
        icon('wand', { size: 14 }), '从设定生成');

      wrap.appendChild(el('div.fgroup', {},
        el('div.fgroup-head', {},
          el('div.fgroup-label', {}, '开场白'),
          genBtn,
        ),
        ta,
        el('div', { style: 'display:flex;justify-content:space-between;gap:10px;' },
          el('div.fgroup-hint', {}, '留空也可以——进入剧情后会由引擎自行起笔。'),
          count,
        ),
      ));

      const preview = el('div', { style: 'display:none;' });
      wrap.appendChild(preview);

      async function generateOpening() {
        if (generating) { genAbort?.abort(); return; }

        // 未保存的新会话：先创建，再生成开场
        let targetId = sessionId;
        if (!targetId) {
          if (!model.title.trim()) { toast('先给剧情起个名字'); return; }
          try {
            const s = await api.createSession({ title: model.title.trim(), settings: buildSettings() });
            targetId = s.id;
            toast('已创建剧情，正在生成开场…');
            history.replaceState(null, '', `#/edit/${s.id}`);
          } catch (err) {
            toast(err.message, { type: 'error' });
            return;
          }
        }

        generating = true;
        genAbort = new AbortController();
        clear(preview);
        preview.style.display = '';
        const box = el('div.gen-preview', {}, el('span', {}, '正在起笔…'));
        const reasoningBox = el('div.gen-reasoning', { style: 'display:none;' });
        preview.appendChild(reasoningBox);
        preview.appendChild(box);
        clear(genBtn);
        genBtn.appendChild(el('span.spinner'));
        genBtn.appendChild(el('span', {}, '停止'));

        let text = '';
        let reasoning = '';
        try {
          await api.generateOpening(targetId, {
            signal: genAbort.signal,
            onEvent: (evt) => {
              if (evt.type === 'reasoning') {
                reasoning += evt.delta || '';
                reasoningBox.style.display = '';
                reasoningBox.textContent = reasoning;
              } else if (evt.type === 'narrative') {
                text += evt.delta || '';
                box.textContent = text;
                box.scrollTop = box.scrollHeight;
              } else if (evt.type === 'narrative_done' && evt.content) {
                text = evt.content;
                box.textContent = text;
              }
            },
          });
          model.opening = text.trim();
          ta.value = model.opening;
          updateCount();
          box.textContent = model.opening;
          toast('开场白已生成，确认后点保存', { type: 'success', duration: 3000 });
          // 已生成过开场：把这段作为正文，保存时不再重复
        } catch (err) {
          if (err?.name === 'AbortError') toast('已停止');
          else toast(err.message || '生成失败', { type: 'error' });
        } finally {
          generating = false;
          genAbort = null;
          clear(genBtn);
          genBtn.appendChild(icon('wand', { size: 14 }));
          genBtn.appendChild(el('span', {}, '从设定生成'));
        }
      }

      return wrap;
    }

    /* =====================================================================
     * 提交
     * ===================================================================== */
    async function submit() {
      if (saving) return;
      if (!model.title.trim()) {
        toast('先给剧情起个名字');
        activeTab = 'basic';
        render();
        requestAnimationFrame(() => scroll.querySelector('.editor-title-input')?.focus());
        return;
      }
      if (!model.characters.some((c) => c.name.trim())) {
        const go = await confirmDialog({
          title: '还没有角色',
          message: '没有角色卡也能演绎，但引擎只能自行发挥。要继续吗？',
          confirmText: '继续', cancelText: '去添加',
        });
        if (!go) {
          activeTab = 'cast';
          render();
          return;
        }
      }

      saving = true;
      const btn = nav.querySelector('.btn-primary');
      btn.disabled = true;
      const original = btn.textContent;
      clear(btn);
      btn.appendChild(el('span.spinner.is-light'));
      try {
        const settings = buildSettings();
        if (isEdit) {
          await api.patchSession(sessionId, { title: model.title.trim(), settings });
          toast('已保存', { type: 'success' });
          window.dispatchEvent(new CustomEvent('sessions:changed'));
          navigate(`#/chat/${sessionId}`);
        } else {
          const s = await api.createSession({ title: model.title.trim(), settings });
          toast('剧情已创建', { type: 'success' });
          window.dispatchEvent(new CustomEvent('sessions:changed'));
          navigate(`#/chat/${s.id}`);
        }
      } catch (err) {
        toast(err.message || '保存失败', { type: 'error' });
        btn.disabled = false;
        clear(btn);
        btn.appendChild(document.createTextNode(original));
      } finally {
        saving = false;
      }
    }

    function buildSettings() {
      let rules = model.rules.trim();
      if (model.lengthHint.trim()) {
        rules = (rules ? rules + '\n' : '') + `【叙事篇幅】${model.lengthHint.trim()}`;
      }
      return {
        title: model.title.trim(),
        opening: model.opening,
        worldview: model.worldview,
        player_role: model.playerRole,
        rules,
        style_tags: model.styleTags.slice(),
        characters: model.characters
          .filter((c) => c.name.trim())
          .map((c) => ({
            name: c.name.trim(),
            role: c.role?.trim() || '',
            personality: c.personality?.trim() || '',
            voice: c.voice?.trim() || '',
            secret: c.secret?.trim() || '',
            background: c.background?.trim() || '',
            avatar_hue: typeof c.avatar_hue === 'number' ? c.avatar_hue : hueFromString(c.name),
          })),
        narrator_effort: model.narratorEffort,
        context_max_tokens: model.contextMaxTokens,
      };
    }

    function loadSettings(s) {
      model.title = s.title || '';
      model.styleTags = Array.isArray(s.style_tags) ? s.style_tags.slice() : [];
      model.worldview = s.worldview || '';
      model.playerRole = s.player_role || '';
      model.narratorEffort = s.narrator_effort || 'high';
      model.contextMaxTokens = s.context_max_tokens || 200000;

      let rules = s.rules || '';
      const m = /(?:^|\n)【叙事篇幅】([\s\S]*)$/.exec(rules);
      if (m) {
        model.lengthHint = m[1].trim();
        rules = rules.replace(/\n?【叙事篇幅】[\s\S]*$/, '').trim();
      }
      model.rules = rules;
      model.opening = s.opening || '';
      model.characters = (Array.isArray(s.characters) ? s.characters : []).map((c) => ({
        name: c.name || '',
        role: c.role || '',
        personality: c.personality || '',
        voice: c.voice || '',
        secret: c.secret || '',
        background: c.background || '',
        avatar_hue: typeof c.avatar_hue === 'number' ? c.avatar_hue : hueFromString(c.name || 'x'),
      }));
    }

    return {
      unmount() { genAbort?.abort(); },
    };
  },
};

/* =========================================================================
 * 组件工具
 * ========================================================================= */

/** 分段控件（带滑动拇指） */
function buildSegmented(items, initial, onChange) {
  const thumb = el('span.segmented-thumb');
  const buttons = items.map((it) => el('button.segmented-item', { type: 'button' }, it.label));
  const wrap = el('div.segmented', { role: 'tablist' }, thumb, ...buttons);
  let active = initial;

  function layout() {
    const idx = items.findIndex((it) => it.value === active);
    const btn = buttons[idx];
    if (!btn || !btn.isConnected) return;
    const wr = wrap.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    if (!br.width) return;
    thumb.style.width = `${br.width}px`;
    thumb.style.transform = `translateX(${br.left - wr.left - 2.5}px)`;
    buttons.forEach((b, i) => b.classList.toggle('is-active', items[i].value === active));
  }

  buttons.forEach((b, i) => b.addEventListener('click', () => {
    active = items[i].value;
    layout();
    onChange?.(active);
  }));

  requestAnimationFrame(layout);
  const onResize = () => layout();
  window.addEventListener('resize', onResize);

  return {
    el: wrap,
    layout,
    destroy() { window.removeEventListener('resize', onResize); },
  };
}

/** 数字步进器 */
function buildStepper(value, { min, max, step, format, onChange }) {
  let v = Math.max(min, Math.min(max, value));
  const valueEl = el('span', { style: 'font-size:var(--fs-footnote);font-weight:600;font-variant-numeric:tabular-nums;min-width:52px;text-align:center;' }, format(v));
  const dec = el('button.icon-btn.is-sm', { type: 'button', 'aria-label': '减少' }, icon('minus', { size: 14, stroke: 2.2 }));
  const inc = el('button.icon-btn.is-sm', { type: 'button', 'aria-label': '增加' }, icon('plus', { size: 14, stroke: 2.2 }));
  const sync = () => {
    valueEl.textContent = format(v);
    dec.disabled = v <= min;
    inc.disabled = v >= max;
  };
  dec.addEventListener('click', () => { v = Math.max(min, v - step); sync(); onChange?.(v); });
  inc.addEventListener('click', () => { v = Math.min(max, v + step); sync(); onChange?.(v); });
  const wrap = el('div', {
    style: 'display:flex;align-items:center;gap:2px;background:var(--fill);border-radius:9px;padding:2px;',
  }, dec, valueEl, inc);
  return { el: wrap, setValue(nv) { v = Math.max(min, Math.min(max, nv)); sync(); } };
}

/** 取色面板（返回 Promise<number|null>） */
function pickHue(initial) {
  return new Promise((resolve) => {
    const slider = el('input.hue-slider', { type: 'range', min: 0, max: 359 });
    slider.value = String(initial);
    const preview = el('div', {
      style: `width:56px;height:56px;border-radius:15px;flex:none;background:${hueToColor(initial, 66, 52)};`,
    });
    let result = initial;
    let settled = false;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    slider.addEventListener('input', () => {
      result = Number(slider.value);
      preview.style.background = hueToColor(result, 66, 52);
    });

    const handle = openSheet({
      title: '角色色调',
      confirmText: '确定',
      render(body) {
        body.appendChild(el('div', { style: 'padding:12px 16px;display:flex;flex-direction:column;gap:14px;' },
          el('div', { style: 'display:flex;align-items:center;gap:14px;' }, preview, slider),
          el('div.field-hint', {}, '色调只影响头像与封面，不进入演绎内容。'),
        ));
      },
      onConfirm() {
        finish(result);
      },
    });

    // 取消 / 遮罩关闭 → null
    handle.veil?.addEventListener('click', () => finish(null));
    handle.sheet.querySelector('.sheet-btn:not(.is-confirm)')?.addEventListener('click', () => finish(null));
  });
}
