/**
 * setup.js — 设定创建 / 编辑视图
 *
 * 功能：
 *  - inset-grouped 表单：标题、风格标签（chip 输入）、开场白（带字数）、世界观、
 *    玩家身份、扮演规则、叙事篇幅说明
 *  - 角色卡编辑器：动态增删（name/role/personality/voice/secret），可调头像色调
 *  - 高级设置（折叠 disclosure）：narrator_effort 分段控件 + context_max_tokens 步进器
 *  - 底部「开始剧情」主按钮（创建 → 建会话并进入；编辑 → 保存并进入）
 *  - 编辑模式「生成开场白」按钮（POST /opening，SSE 流式显示 reasoning/narrative）
 */

import { $, el, clear, escapeHtml, truncate, hueToColor, hueFromString, hashString } from './util.js';
import { api } from './api.js';
import { navigate, toast, showLoading, hideLoading } from './app.js';
import { openSidebar } from './sidebar.js';

export default {
  id: 'setup',
  title: '创建剧情',

  async mount(root, params) {
    const isEdit = !!params.id;
    const sessionId = params.id || null;

    // ---- 表单模型 ----
    const model = {
      title: '',
      styleTags: [],
      opening: '',
      worldview: '',
      playerRole: '',
      rules: '',
      narrativeLength: '',   // 折叠进 rules 的【叙事篇幅】段
      characters: [],
      narratorEffort: 'high',
      contextMaxTokens: 200000,
    };

    let openingAbort = null;   // 生成开场白的 AbortController
    let generating = false;
    let disposables = [];      // buildForm 内创建控件的销毁函数（重建时清理）

    // ---- 骨架：导航栏 ----
    const navTitle = isEdit ? '编辑设定' : '创建剧情';
    const navBar = el('header.main-nav', {},
      el('button.main-nav-btn.icon-only.nav-hamburger', {
        type: 'button', 'aria-label': '打开会话库', title: '会话库',
        onclick: () => openSidebar(),
      }, '☰'),
      el('button.main-nav-btn', {
        type: 'button',
        onclick: () => (isEdit ? history.back() : navigate('#/library')),
      }, el('span', {}, '‹'), isEdit ? '返回' : '取消'),
      el('span.main-nav-title', {}, navTitle),
      el('span.main-nav-btn.icon-only', { style: 'visibility:hidden;' }, ''),
    );

    const scroll = el('div.main-scroll');
    const view = el('section.view', { 'data-view': 'setup' }, navBar, scroll);
    root.appendChild(view);

    // ============================================================
    // 表单构建
    // ============================================================
    buildForm(scroll);

    function buildForm(container) {
      clear(container);
      // 清理上一次构建残留的控件监听（编辑模式会重建表单）
      disposables.forEach((fn) => { try { fn(); } catch { /* 忽略 */ } });
      disposables = [];

      const form = el('form.setup-form', {
        onsubmit: (e) => { e.preventDefault(); submit(); },
      });

      // ---- 标题 ----
      const titleInput = el('input', {
        type: 'text',
        placeholder: '给这段剧情起个名字',
        maxlength: 60,
        value: model.title,
        oninput: (e) => { model.title = e.target.value; },
      });
      form.appendChild(el('div.inset-grouped', {},
        el('div.ig-header', {}, '基础'),
        el('div.ig-list', {},
          el('div.ig-row', {},
            el('div.ig-row-label', { style: 'flex:none;width:64px;' }, '标题'),
            el('div.ig-field', {}, titleInput),
          ),
        ),
      ));

      // ---- 风格标签 ----
      const tagInput = el('input', {
        type: 'text',
        placeholder: '输入标签后回车，如：悬疑',
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const v = e.target.value.trim().replace(/,$/, '');
            if (v) { model.styleTags.push(v); e.target.value = ''; renderTags(); }
          } else if (e.key === 'Backspace' && !e.target.value && model.styleTags.length) {
            model.styleTags.pop(); renderTags();
          }
        },
      });
      const tagBox = el('div.chip-input', { onclick: () => tagInput.focus() });
      function renderTags() {
        clear(tagBox);
        model.styleTags.forEach((t, i) => {
          tagBox.appendChild(el('span.chip.chip-purple', {},
            t,
            el('button.chip-remove', {
              type: 'button',
              'aria-label': `移除 ${t}`,
              onclick: (e) => { e.stopPropagation(); model.styleTags.splice(i, 1); renderTags(); },
            }, '✕'),
          ));
        });
        tagBox.appendChild(tagInput);
      }
      renderTags();
      form.appendChild(el('div', {},
        el('div.form-label', {}, '风格标签'),
        el('div.section-pad', {}, tagBox),
      ));

      // ---- 开场白 ----
      const openingCount = el('span.char-count');
      const openingInput = el('textarea.form-textarea.tall', {
        placeholder: '第一幕的引子——场景、氛围、第一个悬念（200-800 字为宜）',
        oninput: (e) => { model.opening = e.target.value; updateOpeningCount(); },
      });
      openingInput.value = model.opening;
      function updateOpeningCount() { openingCount.textContent = `${model.opening.length} 字`; }
      updateOpeningCount();

      const openingBlock = el('div', {}, openingInput);
      form.appendChild(el('div', {},
        el('div.form-label', {}, '开场白', openingCount),
        el('div', {}, openingBlock),
      ));

      // 生成开场白的预览区（编辑模式）
      const openingPreview = el('div.opening-preview', { style: 'display:none;' });
      const openingReasoning = el('div.opening-reasoning', { style: 'display:none;' });
      form.appendChild(openingReasoning);
      form.appendChild(openingPreview);

      // ---- 世界观 ----
      const worldviewInput = el('textarea.form-textarea', {
        placeholder: '这个世界的时间、地点、规则、力量体系、氛围基调…',
        oninput: (e) => { model.worldview = e.target.value; },
      });
      worldviewInput.value = model.worldview;
      form.appendChild(el('div', {},
        el('div.form-label', {}, '世界观'),
        el('div', {}, worldviewInput),
      ));

      // ---- 玩家身份 ----
      const playerRoleInput = el('textarea.form-textarea', {
        placeholder: '玩家是谁？身份、目标、与角色的关系…',
        oninput: (e) => { model.playerRole = e.target.value; },
      });
      playerRoleInput.value = model.playerRole;
      form.appendChild(el('div', {},
        el('div.form-label', {}, '玩家身份'),
        el('div', {}, playerRoleInput),
      ));

      // ---- 扮演规则 ----
      const rulesInput = el('textarea.form-textarea', {
        placeholder: '禁止 OOC、保持角色口吻、叙事视角等硬性规则…',
        oninput: (e) => { model.rules = e.target.value; },
      });
      rulesInput.value = model.rules;
      form.appendChild(el('div', {},
        el('div.form-label', {}, '扮演规则'),
        el('div', {}, rulesInput),
      ));

      // ---- 叙事篇幅说明 ----
      const narrativeInput = el('textarea.form-textarea', {
        placeholder: '每轮叙事的期望篇幅与节奏，如：每轮 1500-3000 字，注重氛围与感官细节',
        style: 'min-height:72px;',
        oninput: (e) => { model.narrativeLength = e.target.value; },
      });
      narrativeInput.value = model.narrativeLength;
      form.appendChild(el('div', {},
        el('div.form-label', {}, '叙事篇幅说明'),
        el('div', {}, narrativeInput),
      ));

      // ---- 角色卡编辑器 ----
      const charContainer = el('div', { style: 'display:flex;flex-direction:column;gap:12px;margin-top:4px;' });
      function renderCharacters() {
        clear(charContainer);
        if (model.characters.length === 0) {
          charContainer.appendChild(el('div', {
            style: 'text-align:center;color:var(--label-tertiary);font-size:14px;padding:8px 16px;',
          }, '还没有角色。添加一位让故事有人可寻。'));
        }
        model.characters.forEach((c, i) => charContainer.appendChild(renderCharCard(c, i)));
        charContainer.appendChild(el('button.btn-add-char', {
          type: 'button',
          onclick: addCharacter,
        }, '＋ 添加角色'));
      }
      function addCharacter() {
        model.characters.push({
          name: '', role: '', personality: '', voice: '', secret: '',
          avatar_hue: Math.floor(Math.random() * 360),
        });
        renderCharacters();
      }
      function renderCharCard(c, index) {
        const hue = typeof c.avatar_hue === 'number' ? c.avatar_hue : hueFromString(c.name || 'x');
        const swatch = el('div.char-card-swatch', {
          style: `background:${hueToColor(hue, 72, 50)};`,
        }, firstChar(c.name));
        const card = el('div.char-card', { style: `--char-hue:${hueToColor(hue)};` },
          el('div.char-card-head', {},
            swatch,
            el('div.char-card-name', {},
              el('input', {
                type: 'text',
                placeholder: '角色名',
                value: c.name,
                oninput: (e) => {
                  c.name = e.target.value;
                  swatch.textContent = firstChar(c.name);
                  card.style.setProperty('--char-hue', hueToColor(hue));
                },
              }),
            ),
            el('button.char-card-del', {
              type: 'button',
              'aria-label': '删除角色',
              onclick: () => { model.characters.splice(index, 1); renderCharacters(); },
            }, '🗑'),
          ),
          el('div.char-card-body', {},
            charRow('身份', '角色定位 / 与玩家关系', (v) => { c.role = v; }, c.role),
            charRow('性格', '冷静、敏锐、外冷内热…', (v) => { c.personality = v; }, c.personality),
            charRow('台词', '语言风格：简短、句号收尾…', (v) => { c.voice = v; }, c.voice),
            charRow('秘密', '不为人知的动机（可选）', (v) => { c.secret = v; }, c.secret),
            el('div.char-hue-row', {},
              el('span.hue-label', {}, '头像色调'),
              el('input.char-hue-slider', {
                type: 'range', min: 0, max: 359, value: hue,
                'aria-label': '头像色调',
                oninput: (e) => {
                  c.avatar_hue = Number(e.target.value);
                  swatch.style.background = hueToColor(c.avatar_hue, 72, 50);
                  card.style.setProperty('--char-hue', hueToColor(c.avatar_hue));
                },
              }),
            ),
          ),
        );
        return card;
      }
      function charRow(label, placeholder, setter, value) {
        const input = el('input', { type: 'text', placeholder, value: value || '' });
        input.addEventListener('input', (e) => setter(e.target.value));
        return el('div.char-hue-row', {},
          el('span.hue-label', {}, label),
          input,
        );
      }
      renderCharacters();

      form.appendChild(el('div', {},
        el('div.form-label', {}, `角色卡（${model.characters.length}）`),
        charContainer,
      ));

      // ---- 高级设置（折叠）----
      const advancedPanel = el('div.disclosure-panel');
      const advancedBtn = el('button.disclosure-btn', { type: 'button' },
        el('span.disclosure-arrow', {}, '›'),
        '高级设置',
      );
      advancedBtn.addEventListener('click', () => {
        const open = advancedBtn.classList.toggle('is-open');
        advancedPanel.classList.toggle('is-open', open);
        if (open) setTimeout(() => segControl.layout(), 60);
      });

      // narrator_effort 分段控件
      const segControl = buildSegmented(
        [
          { value: 'low', label: '低' },
          { value: 'medium', label: '中' },
          { value: 'high', label: '高' },
        ],
        model.narratorEffort,
        (v) => { model.narratorEffort = v; },
      );
      disposables.push(() => segControl.destroy());

      // context_max_tokens 步进器
      const stepper = buildStepper(model.contextMaxTokens, {
        min: 20000, max: 400000, step: 10000,
        format: (v) => `${Math.round(v / 1000)}K`,
        onChange: (v) => { model.contextMaxTokens = v; },
      });

      advancedPanel.appendChild(el('div.inset-grouped', { style: 'margin-top:10px;' },
        el('div.ig-list', {},
          el('div.ig-row', {},
            el('div.ig-row-body', {},
              el('div.ig-row-label', {}, '叙事思考深度'),
              el('div.ig-row-value', {}, 'narrator_effort'),
            ),
          ),
          el('div.ig-row', { style: 'padding-top:0;padding-bottom:12px;' },
            el('div', { style: 'flex:1;' }, segControl.el),
          ),
          el('div.ig-row', {},
            el('div.ig-row-body', {},
              el('div.ig-row-label', {}, '上下文上限'),
              el('div.ig-row-value', {}, 'context_max_tokens'),
            ),
            stepper.el,
          ),
        ),
        el('div.ig-footer', {}, '思考深度越高，叙事越细腻但更慢；上下文上限决定可回忆的历史体量。'),
      ));

      form.appendChild(el('div.section-pad', { style: 'margin-top:8px;' },
        advancedBtn,
        advancedPanel,
      ));

      container.appendChild(form);

      // 生成开场白按钮（仅编辑模式）
      if (isEdit) {
        container.appendChild(el('div.section-pad', { style: 'margin-top:14px;' },
          el('button.btn-tinted', {
            type: 'button',
            id: 'gen-opening-btn',
            onclick: generateOpening,
          }, '✨ 生成开场白'),
        ));
      }
    }

    // ============================================================
    // 主按钮：开始剧情 / 保存
    // ============================================================
    const primaryBtn = el('button.btn-filled.btn-block', { type: 'button', onclick: submit },
      isEdit ? '保存并进入' : '开始剧情');

    const actionsBar = el('div.setup-actions', {}, primaryBtn);
    view.appendChild(actionsBar);

    async function submit() {
      if (!model.title.trim()) {
        toast('请先填写标题');
        const t = $('.setup-form input[type="text"]', view);
        if (t) t.focus();
        return;
      }
      const settings = buildSettings();
      primaryBtn.disabled = true;
      const originalLabel = primaryBtn.textContent;
      primaryBtn.textContent = '';
      primaryBtn.appendChild(el('span.spinner'));
      try {
        if (isEdit) {
          await api.patchSession(sessionId, { title: model.title.trim(), settings });
          toast('已保存');
          window.dispatchEvent(new CustomEvent('sessions:changed'));
          navigate(`#/chat/${encodeURIComponent(sessionId)}`);
        } else {
          const session = await api.createSession({ title: model.title.trim(), settings });
          toast('剧情已创建');
          window.dispatchEvent(new CustomEvent('sessions:changed'));
          navigate(`#/chat/${encodeURIComponent(session.id)}`);
        }
      } catch (err) {
        toast(err.message || '保存失败');
        primaryBtn.disabled = false;
        primaryBtn.textContent = originalLabel;
      }
    }

    // ============================================================
    // 生成开场白（SSE 流式）
    // ============================================================
    async function generateOpening() {
      if (generating) { // 再次点击 = 取消
        if (openingAbort) openingAbort.abort();
        return;
      }
      generating = true;
      openingAbort = new AbortController();

      const btn = $('#gen-opening-btn', view);
      if (btn) { btn.textContent = '⏹ 停止生成'; }

      const preview = $('.opening-preview', view);
      const reasoning = $('.opening-reasoning', view);
      if (preview) { preview.style.display = 'block'; clear(preview); }
      if (reasoning) { reasoning.style.display = 'none'; clear(reasoning); }

      let narrative = '';
      let reasoningText = '';
      let cursor = null;

      const onEvent = (evt) => {
        if (evt.type === 'reasoning') {
          reasoningText += evt.delta || '';
          if (reasoning) {
            reasoning.style.display = 'block';
            reasoning.textContent = `💭 ${reasoningText}`;
            reasoning.scrollTop = reasoning.scrollHeight;
          }
        } else if (evt.type === 'narrative') {
          narrative += evt.delta || '';
          if (preview) {
            if (cursor) cursor.remove();
            preview.appendChild(document.createTextNode(evt.delta || ''));
            cursor = el('span.stream-cursor');
            preview.appendChild(cursor);
            preview.scrollIntoView({ block: 'nearest' });
          }
        } else if (evt.type === 'narrative_done') {
          if (evt.content) narrative = evt.content;
        } else if (evt.type === 'error') {
          throw new Error(evt.message || '生成失败');
        }
      };

      try {
        await api.generateOpening(sessionId, { onEvent, signal: openingAbort.signal });
        // 应用生成的开场白
        model.opening = narrative.trim();
        const ta = $('.setup-form textarea', view);
        if (ta) ta.value = model.opening;
        const count = $('.char-count', view);
        if (count) count.textContent = `${model.opening.length} 字`;
        toast('开场白已生成并填入');
      } catch (err) {
        if (err && err.name === 'AbortError') toast('已停止生成');
        else toast(err.message || '生成开场白失败');
      } finally {
        generating = false;
        openingAbort = null;
        if (cursor) cursor.remove();
        if (btn) btn.textContent = '✨ 生成开场白';
      }
    }

    // ============================================================
    // 序列化 / 反序列化
    // ============================================================
    function buildSettings() {
      // 叙事篇幅折叠进 rules，保持 schema 纯净
      let rules = model.rules.trim();
      const nl = model.narrativeLength.trim();
      if (nl) {
        rules = (rules ? rules + '\n' : '') + `【叙事篇幅】${nl}`;
      }
      return {
        title: model.title.trim(),
        opening: model.opening,
        worldview: model.worldview,
        player_role: model.playerRole,
        rules,
        style_tags: model.styleTags.slice(),
        characters: model.characters.map((c) => ({
          name: c.name.trim(),
          role: c.role,
          personality: c.personality,
          voice: c.voice,
          secret: c.secret,
          avatar_hue: typeof c.avatar_hue === 'number' ? c.avatar_hue : hueFromString(c.name || 'x'),
        })).filter((c) => c.name),
        narrator_effort: model.narratorEffort,
        context_max_tokens: model.contextMaxTokens,
      };
    }

    function loadSettings(settings) {
      settings = settings || {};
      model.title = settings.title || '';
      model.styleTags = Array.isArray(settings.style_tags) ? settings.style_tags.slice() : [];
      model.opening = settings.opening || '';
      model.worldview = settings.worldview || '';
      model.playerRole = settings.player_role || '';
      model.narratorEffort = settings.narrator_effort || 'high';
      model.contextMaxTokens = settings.context_max_tokens || 200000;

      // 从 rules 中拆出【叙事篇幅】
      const rules = settings.rules || '';
      const m = /【叙事篇幅】([\s\S]*)$/.exec(rules);
      if (m) {
        model.narrativeLength = m[1].trim();
        model.rules = rules.replace(/\n?【叙事篇幅】[\s\S]*$/, '').trim();
      } else {
        model.rules = rules;
      }

      model.characters = (Array.isArray(settings.characters) ? settings.characters : []).map((c) => ({
        name: c.name || '',
        role: c.role || '',
        personality: c.personality || '',
        voice: c.voice || '',
        secret: c.secret || '',
        avatar_hue: typeof c.avatar_hue === 'number' ? c.avatar_hue : hueFromString(c.name || 'x'),
      }));
    }

    // ---- 载入配置默认值 + 编辑时载入会话 ----
    (async () => {
      try {
        const cfg = await api.getConfig();
        if (!isEdit) {
          const effort = cfg?.defaults?.narrator_effort;
          if (effort && ['low', 'medium', 'high'].includes(effort)) model.narratorEffort = effort;
          const max = cfg?.context_limits?.max || cfg?.defaults?.context_max_tokens;
          if (typeof max === 'number') model.contextMaxTokens = max;
        }
      } catch { /* 用内置默认值 */ }

      if (isEdit) {
        showLoading();
        try {
          const detail = await api.getSession(sessionId);
          loadSettings(detail.session?.settings);
          if (detail.session?.title) model.title = detail.session.title;
          buildForm(scroll); // 用载入的数据重建表单
          // 重建后同步主按钮
          view.appendChild(actionsBar);
        } catch (err) {
          toast(err.message || '加载会话失败');
          navigate('#/library');
          return;
        } finally {
          hideLoading();
        }
      }
    })();

    return {
      unmount() {
        disposables.forEach((fn) => { try { fn(); } catch { /* 忽略 */ } });
        disposables = [];
        if (openingAbort) openingAbort.abort();
      },
    };
  },
};

// ============================================================
// 本地辅助
// ============================================================

function firstChar(str) {
  const s = String(str || '').trim();
  return s ? [...s][0] : '?';
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/**
 * 构建 iOS 分段控件（白底滑块随选中项滑动）。
 * @returns {{el:HTMLElement, layout:Function, setValue:Function}}
 */
function buildSegmented(items, initial, onChange) {
  const thumb = el('span.segmented-thumb');
  const buttons = items.map((it) =>
    el('button.segmented-item', { type: 'button', 'data-value': it.value }, it.label),
  );
  const wrap = el('div.segmented', { role: 'tablist' }, thumb, ...buttons);
  let active = initial;

  function layout() {
    const idx = items.findIndex((it) => it.value === active);
    const btn = buttons[idx];
    if (!btn) return;
    const wr = wrap.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    thumb.style.width = `${br.width}px`;
    thumb.style.transform = `translateX(${br.left - wr.left}px)`;
    buttons.forEach((b, i) => b.classList.toggle('is-active', items[i].value === active));
  }

  buttons.forEach((b, i) => b.addEventListener('click', () => {
    active = items[i].value;
    layout();
    if (onChange) onChange(active);
  }));

  requestAnimationFrame(layout);
  const onResize = () => layout();
  window.addEventListener('resize', onResize);

  return {
    el: wrap,
    layout,
    setValue(v) { active = v; layout(); },
    destroy() { window.removeEventListener('resize', onResize); },
  };
}

/**
 * 构建步进器。
 * @returns {{el:HTMLElement, setValue:Function}}
 */
function buildStepper(value, { min, max, step, format, onChange }) {
  let val = clamp(value, min, max);
  const valueEl = el('span.stepper-value', {}, format(val));
  const dec = el('button', { type: 'button', 'aria-label': '减少', disabled: val <= min }, '−');
  const inc = el('button', { type: 'button', 'aria-label': '增加', disabled: val >= max }, '+');
  const sync = () => {
    valueEl.textContent = format(val);
    dec.disabled = val <= min;
    inc.disabled = val >= max;
  };
  dec.addEventListener('click', () => { val = clamp(val - step, min, max); sync(); onChange && onChange(val); });
  inc.addEventListener('click', () => { val = clamp(val + step, min, max); sync(); onChange && onChange(val); });
  const wrap = el('div.stepper', {}, dec, valueEl, inc);
  return { el: wrap, setValue(v) { val = clamp(v, min, max); sync(); } };
}
