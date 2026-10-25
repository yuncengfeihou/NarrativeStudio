/**
 * views/settings.js — 设置
 *
 * 分组：外观 / 字体 / 阅读 / 遥测 / 模型 / 上下文与记忆 / 接入
 * 界面偏好即时生效并持久化（localStorage）；模型配置在服务端，需显式「保存」。
 * 桌面端左侧是吸顶的分组导航，窄屏折成横向滚动条。
 */

import { el, clear, fmtNumber, fmtTokens } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, openSheet, confirmDialog } from '../app.js';
import { ui, setTheme, setPref, applyAppearancePrefs, applyWithRipple } from '../store.js';
import {
  FONT_PRESETS, COMMON_FONTS, fontDisplayName, fontStack,
  listLocalFonts, supportsLocalFonts,
} from '../fonts.js';
import { toggleRow, infoRow } from '../ui-kit.js';

const SECTIONS = [
  ['appearance', '外观'],
  ['type', '字体'],
  ['reading', '阅读'],
  ['telemetry', '遥测'],
  ['model', '模型'],
  ['context', '上下文与记忆'],
  ['api', '接入'],
];

// Agent 在界面上的名字。服务端只认 key，这里只做展示。
const AGENT_META = {
  narrator: ['演绎旁白', '写正文，最常调用'],
  archivist: ['记忆整理', '每轮把正文抽成结构化记忆'],
  sceneKeeper: ['本场状态', '每场收尾时整理本场状态'],
  retrieval: ['设定检索', '判断这一拍要不要查设定集'],
  continuity: ['一致性检查', '定期核对矛盾与知识越界'],
  librarian: ['设定集维护', '整理设定集条目'],
  worldTick: ['后台推演', '切场时推演不在场角色的行动'],
  branch: ['走向生成', '回合末给 3–4 条走向'],
  cardSmith: ['世界卡生成', '小说 → 世界卡'],
};
const EFFORT_LABELS = { low: '低', medium: '中', high: '高' };
const EFFORTS_LOCAL = ['low', 'medium', 'high'];


// 字体列表在进程内缓存：设置页重新挂载、反复打开选择器都不用再扫一次。
let cachedFontList = null;
let serverFontLoading = null;

function loadServerFonts() {
  if (cachedFontList) return Promise.resolve(cachedFontList);
  if (!serverFontLoading) {
    serverFontLoading = api.getFonts()
      .then((res) => {
        if (res?.fonts?.length) cachedFontList = res.fonts;
        return cachedFontList;
      })
      .catch(() => null)
      .finally(() => { serverFontLoading = null; });
  }
  return serverFontLoading;
}

export default {
  id: 'settings',
  title: '设置',

  async mount(root) {
    let cfg = null;
    let draft = null;        // 可编辑副本：只在点「保存」时写服务端
    let dirty = false;
    let saving = false;
    let activeSection = 'appearance';
    let sectionNodes = [];
    let navButtons = [];
    let spyPaused = false;   // 点击导航后的平滑滚动期间，暂停滚动联动
    let spyToken = 0;
    let fontRowRefs = [];
    let fontPreview = null;

    const nav = el('header.topbar', {},
      el('button.icon-btn.mobile-only', {
        type: 'button', 'aria-label': '目录',
        onclick: () => import('../shell.js').then((m) => m.openDrawer()),
      }, icon('sidebar', { size: 17 })),
      el('button.icon-btn', { type: 'button', title: '返回', onclick: () => navigate('#/worlds') },
        icon('chevronLeft', { size: 17 })),
      el('div.topbar-title', {}, '设置'),
      el('div.topbar-actions'),
    );

    const scroll = el('div.scroll');
    const view = el('section.view', { 'data-view': 'settings' }, nav, scroll);
    root.appendChild(view);

    function render() {
      const keepTop = scroll.scrollTop;
      clear(scroll);

      const box = el('div.page.settings-page');
      const layout = el('div.settings-layout');

      const navInner = el('div.settings-nav-inner');
      navButtons = SECTIONS.map(([id, label]) => {
        const btn = el('button.settings-nav-item', {
          type: 'button',
          class: id === activeSection ? 'is-active' : '',
          onclick: () => {
            activeSection = id;
            paintNav();
            scrollToSection(id);
          },
        }, label);
        navInner.appendChild(btn);
        return { id, btn };
      });
      const navBox = el('aside.settings-nav', { 'aria-label': '设置分组' }, navInner);

      const content = el('div.settings-content');
      const appearance = section('appearance', '外观', '主题只影响界面，不改变世界卡的设定。');
      appearance.appendChild(appearanceGroup());
      const type = section('type', '字体', '界面字体覆盖除正文外的所有 UI 文字；正文内容单独设置，互不影响。');
      type.appendChild(typeGroup());
      const reading = section('reading', '阅读', '这些设置只作用于演绎正文。');
      reading.appendChild(readingGroup());
      const telemetry = section('telemetry', '遥测', '每轮旁白下方那排数字。');
      telemetry.appendChild(telemetryGroup());
      const model = section('model', '模型', '选择服务商与模型，并给每个 Agent 分配。保存后立即生效，无需重启。');
      model.appendChild(modelGroup());
      const contextSec = section('context', '上下文与记忆', '当前生效的预算与节奏。模型能读多长，取决于上面绑定的模型上下文窗口。');
      contextSec.appendChild(contextGroup());
      const apiSec = section('api', '接入', '把叙事台当成一个 OpenAI 兼容服务来用。');
      apiSec.appendChild(apiGroup());

      sectionNodes = [appearance, type, reading, telemetry, model, contextSec, apiSec];
      content.append(...sectionNodes);
      content.appendChild(about());

      layout.append(navBox, content);
      box.appendChild(layout);
      scroll.appendChild(box);
      scroll.scrollTop = keepTop;
      paintNav();
    }

    function section(id, title, desc) {
      return el('section.settings-sec', { id: `settings-${id}`, dataset: { section: id } },
        el('div.settings-sec-head', {},
          el('h2.settings-sec-title', {}, title),
          desc ? el('p.settings-sec-desc', {}, desc) : null,
        ),
      );
    }

    function paintNav() {
      for (const { id, btn } of navButtons) {
        btn.classList.toggle('is-active', id === activeSection);
      }
    }

    function scrollToSection(id) {
      const target = scroll.querySelector(`#settings-${id}`);
      if (!target) return;
      // 点击导航的平滑滚动期间暂停 scroll-spy：竖线直接落位到目标分组，
      // 不跟着途经的中间分组逐项跳动（否则看起来在上下抖动）。
      const token = ++spyToken;
      spyPaused = true;
      const release = () => {
        if (token !== spyToken) return;  // 期间又点了别的分组，让新的一次接管
        spyPaused = false;
        onScroll();
      };
      scroll.addEventListener('scrollend', release, { once: true });
      setTimeout(release, 900);  // scrollend 缺席时的兜底
      // scroll-margin-top 在窄屏会为吸顶的分组导航留出高度。
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function onScroll() {
      if (spyPaused) return;
      if (!sectionNodes.length) return;
      const edge = scroll.getBoundingClientRect().top + 44;
      let current = sectionNodes[0].dataset.section;
      for (const node of sectionNodes) {
        if (node.getBoundingClientRect().top <= edge) current = node.dataset.section;
      }
      if (current !== activeSection) {
        activeSection = current;
        paintNav();
      }
    }

    /* ---- 外观 ---- */
    function appearanceGroup() {
      const current = ui.get().theme;
      const card = el('div.group-card');
      const row = el('div.theme-cards');

      const options = [
        ['light', '浅色', 'is-light'],
        ['dark', '深色', 'is-dark'],
        ['system', '跟随系统', 'is-auto'],
      ];

      const cards = options.map(([value, label, swatchCls]) => {
        const check = el('span.theme-check', {}, icon('check', { size: 11, stroke: 2.2 }));
        const btn = el('button.theme-card', {
          type: 'button',
          class: current === value ? 'is-active' : '',
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            applyWithRipple(() => {
              setTheme(value);
              cards.forEach((c, i) => c.classList.toggle('is-active', options[i][0] === value));
            }, r.left + r.width / 2, r.top + r.height / 2);
            toast(value === 'dark' ? '已切换深色' : value === 'light' ? '已切换浅色' : '跟随系统');
          },
        },
          el('div.theme-swatch', { class: swatchCls }, el('span'), el('span')),
          el('span.theme-card-label', {}, label),
          check,
        );
        row.appendChild(btn);
        return btn;
      });

      card.appendChild(row);
      return el('div.group', {}, card);
    }

    /* ---- 字体 ---- */
    function typeGroup() {
      const card = el('div.group-card.font-card');
      fontRowRefs = [];

      card.appendChild(fontRow({
        key: 'uiFont',
        label: '界面字体',
        desc: '除正文外的所有界面文字：标题、按钮、表单、列表。',
      }));
      card.appendChild(fontRow({
        key: 'readingFont',
        label: '正文内容',
        desc: '演绎正文、开场种子与长段落阅读。',
      }));

      fontPreview = el('div.font-preview', {},
        el('div.font-preview-label', {}, '实时预览'),
        el('div.font-preview-title', { style: 'font-family:var(--font-ui)' }, '叙事台 · 世界卡'),
        el('div.font-preview-ui', {},
          el('span.font-preview-btn', {}, '设置'),
          el('span.font-preview-btn.is-primary', {}, '保存'),
          el('span.font-preview-input', {}, '搜索世界卡…'),
        ),
        el('div.font-preview-body', { style: 'font-family:var(--font-read)' },
          '雨落在青石板上，像有人轻轻数着更漏。她没有回头，只把伞往檐下挪了半寸。'),
      );
      card.appendChild(fontPreview);

      card.appendChild(el('div.font-card-note', {},
        '字体列表只从本机读取，不会上传。浏览器支持时直接读取，否则由本地服务端读取；'
        + '读不到时仍可手动输入字体名。'));
      return el('div.group', {}, card);
    }

    function fontRow({ key, label, desc }) {
      const raw = String(ui.get()[key] || '').trim();
      const sample = key === 'uiFont' ? '界面' : '正文';
      const valueEl = el('span.font-row-value', {}, fontDisplayName(raw));
      const sampleEl = el('span.font-row-sample', {
        style: `font-family:${fontStack(raw, key === 'uiFont' ? 'var(--font-ui-base)' : 'var(--font-read-base)') || 'var(--font-ui)'};`,
      }, sample);

      const btn = el('button.font-row', {
        type: 'button',
        onclick: () => openFontPicker(key, label),
      },
        el('div.font-row-body', {},
          el('div.font-row-title', {}, label),
          el('div.font-row-sub', {}, desc),
        ),
        el('div.font-row-meta', {}, sampleEl, valueEl),
        el('span.li-accent', {}, icon('chevronRight', { size: 13 })),
      );

      const ref = { key, valueEl, sampleEl, sample, btn };
      fontRowRefs.push(ref);
      return btn;
    }

    function refreshFontRows() {
      for (const ref of fontRowRefs) {
        const raw = String(ui.get()[ref.key] || '').trim();
        ref.valueEl.textContent = fontDisplayName(raw);
        const fallback = ref.key === 'uiFont' ? 'var(--font-ui-base)' : 'var(--font-read-base)';
        ref.sampleEl.style.fontFamily = fontStack(raw, fallback) || 'var(--font-ui)';
      }
    }

    function openFontPicker(key, label) {
      const fallback = key === 'uiFont' ? 'var(--font-ui-base)' : 'var(--font-read-base)';
      const sampleText = key === 'uiFont'
        ? '叙事台 · 设置 · 保存 · 世界卡'
        : '雨落在青石板上，像有人轻轻数着更漏。';

      let localFonts = cachedFontList;
      let query = '';

      const preview = el('div.font-pick-preview', {
        style: `font-family:${fontStack(ui.get()[key], fallback) || fallback};`,
      }, sampleText);
      const currentLabel = el('div.font-pick-current', {}, fontDisplayName(ui.get()[key]));
      const search = el('input.field', {
        type: 'search', placeholder: '搜索字体名…',
        oninput: (e) => { query = e.target.value; paintList(); },
      });
      const list = el('div.font-pick-list');
      const status = el('div.font-pick-status', {},
        localFonts
          ? `已读取 ${localFonts.length} 个字体族。`
          : '正在读取本机字体…');
      const manual = el('input.field', {
        type: 'text', placeholder: '手动输入字体名，如：霞鹜文楷',
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); applyManual(); }
        },
      });
      const manualBtn = el('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: applyManual }, '应用');
      const scanBtn = el('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: scan },
        icon('refresh', { size: 13 }), '扫描本机字体');

      function apply(value, name) {
        setPref(key, value);
        applyAppearancePrefs();
        refreshFontRows();
        preview.style.fontFamily = fontStack(value, fallback) || fallback;
        currentLabel.textContent = name || fontDisplayName(value);
        paintList();
        toast(`${label}已切换为 ${name || fontDisplayName(value)}`);
      }

      function applyManual() {
        const v = manual.value.trim();
        apply(v, v ? fontDisplayName(v) : '系统默认');
        if (!v) manual.value = '';
      }

      async function scan() {
        scanBtn.disabled = true;
        clear(scanBtn);
        scanBtn.append(el('span.spinner'), el('span', { style: 'margin-left:6px;' }, '扫描中'));
        status.textContent = '正在读取本机字体…';
        localFonts = null;

        try {
          if (supportsLocalFonts()) {
            try {
              const list = await listLocalFonts();
              if (list?.length) localFonts = list;
            } catch { /* 授权被拒或环境受限，继续走服务端 */ }
          }

          if (!localFonts) {
            const remote = await api.getFonts();
            if (remote?.fonts?.length) localFonts = remote.fonts;
          }

          if (localFonts) cachedFontList = localFonts;
          status.textContent = localFonts
            ? `已读取 ${localFonts.length} 个字体族。`
            : '没有读到本机字体，下面列出常用字体；也可以手动输入。';
        } catch {
          localFonts = null;
          status.textContent = '读取失败，下面列出常用字体；也可以手动输入。';
        } finally {
          scanBtn.disabled = false;
          clear(scanBtn);
          scanBtn.append(icon('refresh', { size: 13 }), '重新扫描');
          paintList();
        }
      }

      function paintList() {
        clear(list);
        const q = query.trim().toLowerCase();
        const current = String(ui.get()[key] || '').trim();

        const option = (name, stackValue, hint, applyName) => {
          const isActive = stackValue === current || (!stackValue && !current);
          const btn = el('button.font-option', {
            type: 'button',
            class: isActive ? 'is-active' : '',
            onclick: () => apply(stackValue, applyName || name),
          },
            el('span.font-option-name', {
              style: `font-family:${fontStack(stackValue, fallback) || fallback};`,
            }, name),
            hint && hint !== name ? el('span.font-option-hint', {}, hint) : null,
            isActive ? el('span.font-option-check', {}, icon('check', { size: 13, stroke: 2.2 })) : null,
          );
          list.appendChild(btn);
          return btn;
        };

        const group = (title, count) => {
          list.appendChild(el('div.font-pick-group', {},
            el('span', {}, title),
            count != null ? el('span', {}, String(count)) : null,
          ));
        };

        const matchedPresets = FONT_PRESETS.filter((p) => {
          if (!q) return true;
          return p.label.toLowerCase().includes(q) || String(p.stack || '').toLowerCase().includes(q);
        });
        if (matchedPresets.length) {
          group('预设', matchedPresets.length);
          for (const p of matchedPresets) option(p.label, p.stack, p.hint, p.label);
        }

        const presets = FONT_PRESETS
          .filter((p) => p.stack)
          .map((p) => p.label.toLowerCase());
        const source = localFonts || COMMON_FONTS;
        const filtered = source.filter((name) => {
          const lower = name.toLowerCase();
          if (!lower.includes(q)) return false;
          // 扫描结果里已经包含具体字体，不再重复展示预设标题。
          return !localFonts ? !presets.includes(lower) : true;
        });

        group(localFonts ? `本机字体 · ${localFonts.length}` : '常用字体', filtered.length);
        if (!filtered.length) {
          list.appendChild(el('div.font-pick-empty', {}, '没有匹配的字体。可以手动输入字体名。'));
        } else {
          for (const name of filtered) option(name, name);
        }
      }

      openSheet({
        title: `选择${label}`,
        confirmText: '完成',
        cancelText: null,
        width: 'min(560px, 100vw)',
        render(body) {
          body.appendChild(el('div.font-pick-head', {},
            el('div', {},
              el('div.font-pick-label', {}, `当前：${label}`),
              currentLabel,
            ),
            el('span.font-pick-hint', {}, '点击任意字体即时生效'),
          ));
          body.appendChild(preview);
          body.appendChild(search);
          body.appendChild(el('div.font-pick-actions', {}, scanBtn, status));
          body.appendChild(list);
          body.appendChild(el('div.font-pick-manual', {},
            el('div.font-pick-manual-title', {}, '手动输入'),
            el('div.font-pick-manual-row', {}, manual, manualBtn),
          ));
          paintList();
          if (!localFonts) {
            loadServerFonts().then((fonts) => {
              if (!fonts?.length) {
                status.textContent = '没有读到本机字体，下面列出常用字体；也可以手动输入。';
                return;
              }
              localFonts = fonts;
              status.textContent = `已读取 ${fonts.length} 个字体族。`;
              paintList();
            });
          }
        },
      });
    }

    /* ---- 阅读 ---- */
    function readingGroup() {
      const s = ui.get();
      const card = el('div.group-card');

      const sizeLabel = el('div.li-value', {}, `${s.readingSize} px`);
      const sizeSlider = el('input.range', {
        type: 'range', min: 15, max: 22, step: 0.5, value: s.readingSize,
        'aria-label': '正文字号',
      });
      sizeSlider.addEventListener('input', () => {
        const v = Number(sizeSlider.value);
        sizeLabel.textContent = `${v} px`;
        setPref('readingSize', v);
        applyAppearancePrefs();
      });
      card.appendChild(el('div.li.is-stack', {},
        el('div.li-body', {},
          el('div.li-title', {}, '正文字号'),
          el('div.li-sub', {}, '标题与界面控件不受影响'),
        ),
        sizeLabel,
        sizeSlider,
      ));

      const widths = [['compact', '紧凑'], ['normal', '标准'], ['wide', '宽松']];
      const widthSeg = el('div.segmented');
      for (const [value, label] of widths) {
        widthSeg.appendChild(el('button.segmented-item', {
          type: 'button',
          class: s.readingWidth === value ? 'is-active' : '',
          onclick: () => {
            setPref('readingWidth', value);
            applyAppearancePrefs();
            Array.from(widthSeg.children).forEach((c, i) => c.classList.toggle('is-active', widths[i][0] === value));
          },
        }, label));
      }
      card.appendChild(el('div.li', {},
        el('div.li-body', {},
          el('div.li-title', {}, '正文行宽'),
          el('div.li-sub', {}, '影响长段落的阅读舒适度'),
        ),
        widthSeg,
      ));

      card.appendChild(toggleRow('显示回合分隔', '每轮之间显示「第 N 轮」，关闭后更沉浸',
        ui.get().showTurnMarks !== false,
        (v) => setPref('showTurnMarks', v)));

      card.appendChild(toggleRow('默认展开思考过程', '演绎引擎的推理默认收起',
        ui.get().showReasoning === true,
        (v) => setPref('showReasoning', v)));

      return el('div.group', {}, card);
    }

    /* ---- 遥测 ---- */
    function telemetryGroup() {
      const card = el('div.group-card');
      card.appendChild(toggleRow('显示每轮遥测', '在旁白下方显示首字延迟、用时、tokens、速度与缓存率',
        ui.get().showUsage !== false,
        (v) => setPref('showUsage', v)));
      card.appendChild(el('div.li', { style: 'align-items:flex-start;' },
        el('div.li-icon', {}, icon('bolt', { size: 13 })),
        el('div.li-body', {},
          el('div.li-title', {}, '这些数字是什么'),
          el('div.li-sub', {},
            '首字 = 从发请求到第一个字出现的时间。用时 = 整轮耗时。输入/输出 = 这一轮消耗的 token。'
            + '速度 = 生成阶段的 tok/s（不含排队）。缓存 = 上游前缀缓存的命中率——越高越省钱。'),
        ),
      ));
      return el('div.group', {}, card);
    }

    /* ---- 模型草稿：界面只在闭包里改，点「保存」才落库 ---- */

    function cloneRuntime(rt) {
      const base = rt || {};
      const agentKeys = base.options?.agent_keys || Object.keys(AGENT_META);
      const agents = {};
      for (const key of agentKeys) {
        const a = base.agents?.[key];
        // 未绑定（source=env）的 Agent 不写进 agents，保住 .env 里的按 Agent *_MODEL。
        if (!a || a.source !== 'db' || !a.modelId) continue;
        agents[key] = {
          modelId: a.modelId,
          effort: EFFORTS_LOCAL.includes(a.effort) ? a.effort : null,
          temperature: typeof a.temperature === 'number' ? a.temperature : null,
          maxTokens: Number.isFinite(a.maxTokens) ? a.maxTokens : null,
        };
      }
      return {
        providers: (base.providers || []).map((p) => ({
          id: p.id, name: p.name, baseUrl: p.baseUrl,
          protocol: p.protocol || 'openai',
          enabled: p.enabled !== false,
          apiKey: p.hasKey ? '***' : '',
        })),
        models: (base.models || []).map((m) => ({
          id: m.id, providerId: m.providerId, model: m.model, label: m.label || m.model,
          contextWindow: m.contextWindow, maxOutput: m.maxOutput,
          supportsReasoning: m.supportsReasoning !== false,
          reasoningEfforts: Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length
            ? [...m.reasoningEfforts]
            : (m.supportsReasoning === false ? [] : [...EFFORTS_LOCAL]),
          supportsTemperature: m.supportsTemperature !== false,
          enabled: m.enabled !== false,
        })),
        agents,
      };
    }

    function syncDraft() {
      draft = cfg?.runtime ? cloneRuntime(cfg.runtime) : null;
      dirty = false;
    }

    function markDirty() {
      dirty = true;
      const top = scroll.scrollTop;
      render();
      scroll.scrollTop = top;
    }

    async function refreshConfig() {
      try { cfg = await api.getConfig(); } catch { /* 保留旧 cfg，界面提示由调用方处理 */ }
    }

    async function saveDraft() {
      if (!draft || saving) return;
      saving = true;
      const top = scroll.scrollTop;
      render();
      scroll.scrollTop = top;
      try {
        const res = await api.saveConfig(draft);
        cfg = { ...cfg, runtime: res.runtime };
        await refreshConfig();
        syncDraft();
        toast('已保存，立即生效');
      } catch (err) {
        toast(err?.message || '保存失败', { type: 'error', duration: 3600 });
      } finally {
        saving = false;
        const keep = scroll.scrollTop;
        render();
        scroll.scrollTop = keep;
      }
    }

    async function resetDraft() {
      const okd = await confirmDialog({
        title: '恢复 .env 默认',
        message: '删除这份运行期配置，所有服务商、模型、Agent 分配回到 .env 默认值。不会改 .env 文件。',
        confirmText: '恢复默认',
        destructive: true,
      });
      if (!okd) return;
      try {
        const res = await api.resetConfig();
        cfg = { ...cfg, runtime: res.runtime };
        await refreshConfig();
        syncDraft();
        toast('已恢复 .env 默认');
      } catch (err) {
        toast(err?.message || '恢复失败', { type: 'error', duration: 3600 });
      }
      const top = scroll.scrollTop;
      render();
      scroll.scrollTop = top;
    }

    /* ---- 模型（服务端配置，显式保存后立即生效） ---- */
    function modelGroup() {
      if (!cfg || !draft) {
        return el('div.group', {}, el('div.group-card', {},
          el('div.li', {}, el('div.li-body', {}, el('div.li-sub', {}, '读取配置中…')))));
      }

      const wrap = el('div.group');
      const fromDb = cfg.runtime?.source === 'db';
      const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' });

      const saveBtn = el('button.btn.btn-primary', { type: 'button', disabled: !dirty || saving },
        saving ? '保存中…' : (dirty ? '保存' : '已保存'));
      saveBtn.addEventListener('click', () => { void saveDraft(); });
      const resetBtn = el('button.btn.btn-ghost', { type: 'button' }, '恢复 .env 默认');
      resetBtn.addEventListener('click', () => { void resetDraft(); });
      actions.append(saveBtn, resetBtn);

      wrap.appendChild(el('div.group-card', {},
        el('div.li', { style: 'align-items:flex-start;flex-wrap:wrap;gap:8px;' },
          el('div.li-icon', {}, icon('sliders', { size: 13 })),
          el('div.li-body', {},
            el('div.li-title', {}, fromDb ? '运行期配置（已保存）' : '来自 .env 的默认值'),
            el('div.li-sub', {}, fromDb
              ? '保存后对新回合立即生效；「恢复 .env 默认」会删除这份运行期配置。'
              : '保存后会写入数据库并覆盖 .env 默认值；不保存则一直使用 .env。'),
          ),
          actions,
        ),
      ));

      wrap.appendChild(el('div', {},
        el('div.group-title', {}, '服务商'),
        el('div.group-card', {},
          ...draft.providers.map((p) => providerRow(p)),
          addRow('添加服务商', () => openProviderSheet(null)),
        ),
      ));

      wrap.appendChild(el('div', {},
        el('div.group-title', {}, '模型'),
        el('div.group-card', {},
          ...draft.models.map((m) => modelRow(m)),
          addRow('添加模型', () => openModelSheet(null)),
        ),
      ));

      wrap.appendChild(el('div', {},
        el('div.group-title', {}, 'Agent 分配'),
        el('div.group-card', {},
          ...Object.keys(AGENT_META).map((key) => agentRow(key)),
        ),
        el('div.group-note', {},
          '没有单独分配的 Agent 会跟随 .env（每轮对话的模型、温度、推理强度都来自环境变量）。'
          + '这里改的是「这一局怎么调用模型」，不改提示词。'),
      ));

      return wrap;
    }

    function addRow(label, onclick) {
      return el('div.li.is-button', { onclick },
        el('div.li-icon', {}, icon('plus', { size: 13 })),
        el('div.li-body', {}, el('div.li-title', {}, label)),
        el('span.li-accent', {}, icon('chevronRight', { size: 13 })),
      );
    }

    function providerRow(p) {
      const key = p.apiKey ? '密钥已配置' : '未配置密钥';
      const sub = `${p.baseUrl || '—'} · ${key}`;
      return el('div.li.is-button', { onclick: () => openProviderSheet(p) },
        el('div.li-icon', {}, icon('globe', { size: 13 })),
        el('div.li-body', {},
          el('div.li-title', {}, p.name || p.id || '未命名服务商'),
          el('div.li-sub', {}, (p.enabled === false ? '已停用 · ' : '') + sub),
        ),
        el('div.li-value', {}, icon('edit', { size: 13 })),
      );
    }

    function modelRow(m) {
      const provider = draft.providers.find((p) => p.id === m.providerId);
      return el('div.li.is-button', { onclick: () => openModelSheet(m) },
        el('div.li-icon', {}, icon('sparkles', { size: 13 })),
        el('div.li-body', {},
          el('div.li-title', {}, m.label || m.model),
          el('div.li-sub', {},
            `${m.model} · ${provider?.name || m.providerId} · 上下文 ${fmtNumber(m.contextWindow)} tok`),
        ),
        el('div.li-value', {}, icon('edit', { size: 13 })),
      );
    }

    function agentRow(key) {
      const [label, desc] = AGENT_META[key];
      const binding = draft.agents[key];
      const effective = cfg.runtime?.agents?.[key];
      let summary;
      if (binding) {
        const model = draft.models.find((m) => m.id === binding.modelId);
        const parts = [model?.label || '跟随 .env 模型'];
        if (binding.effort) parts.push(`推理 ${EFFORT_LABELS[binding.effort] || binding.effort}`);
        if (typeof binding.temperature === 'number') parts.push(`温度 ${binding.temperature}`);
        if (Number.isFinite(binding.maxTokens)) parts.push(`输出 ${fmtNumber(binding.maxTokens)}`);
        summary = parts.join(' · ');
      } else {
        summary = `跟随 .env（${effective?.model || '—'}）`;
      }
      return el('div.li.is-button', { onclick: () => openAgentSheet(key) },
        el('div.li-icon', {}, icon('users', { size: 13 })),
        el('div.li-body', {},
          el('div.li-title', {}, label),
          el('div.li-sub', {}, desc),
        ),
        el('div.li-value', { style: 'max-width:46%;text-align:right;font-size:var(--fs-caption);color:var(--ink-3);' }, summary),
      );
    }

    /* ---- 配置编辑 sheet ---- */

    function formLine(label, control, hint = null) {
      return el('div', { style: 'margin-bottom:14px;' },
        el('div.field-label', { style: 'margin-bottom:6px;' }, label),
        control,
        hint ? el('div.field-hint', { style: 'margin-top:6px;' }, hint) : null,
      );
    }

    function makeSelect(options, value) {
      const sel = el('select.field', {});
      for (const [v, label] of options) {
        const opt = el('option', { value: v }, label);
        if (String(v) === String(value ?? '')) opt.selected = true;
        sel.appendChild(opt);
      }
      return sel;
    }

    function openProviderSheet(existing) {
      const isNew = !existing;
      const item = existing || { id: null, name: '', baseUrl: '', protocol: 'openai', enabled: true, apiKey: '' };
      let keyAction = item.apiKey === '***' ? 'keep' : 'none';
      let enabled = item.enabled !== false;

      const nameIn = el('input.field', { type: 'text', value: item.name || '', placeholder: '例如：StepFun 主账号' });
      const urlIn = el('input.field', { type: 'text', value: item.baseUrl || '', placeholder: 'https://api.example.com/v1' });
      const keyIn = el('input.field', {
        type: 'password', value: '',
        placeholder: keyAction === 'keep' ? '已配置，留空表示保留' : 'sk-…（没有可留空）',
      });
      keyIn.addEventListener('input', () => { keyAction = keyIn.value ? 'set' : 'none'; });
      const keyHint = el('div.field-hint', { style: 'margin-top:6px;' }, keyAction === 'keep'
        ? `已保存的密钥末 4 位：${item.hasKey ? (cfg.runtime?.providers || []).find((p) => p.id === item.id)?.keyHint || '****' : '****'}；留空表示不修改。`
        : '留空表示这个服务商没有密钥（地址与 .env 相同则沿用 .env 的密钥）。');
      const clearBtn = el('button.btn.btn-ghost', { type: 'button', style: 'margin-top:8px;' }, '清除已保存的密钥');
      clearBtn.addEventListener('click', () => {
        keyIn.value = '';
        keyAction = 'clear';
        keyHint.textContent = '将清除已保存的密钥（保存后生效）。';
      });

      const sheetApi = openSheet({
        title: isNew ? '添加服务商' : '编辑服务商',
        confirmText: '保存',
        render(body) {
          body.appendChild(formLine('名称', nameIn));
          body.appendChild(formLine('Base URL', urlIn, 'OpenAI 兼容地址，通常以 /v1 结尾。'));
          body.appendChild(formLine('API Key', keyIn));
          body.appendChild(keyHint);
          if (item.apiKey === '***') body.appendChild(clearBtn);
          body.appendChild(toggleRow('启用', '停用后引用它的 Agent 会回落到 .env 默认模型', enabled, (v) => { enabled = v; }));
          if (!isNew) {
            const del = el('button.btn.btn-ghost', { type: 'button', style: 'margin-top:12px;color:var(--danger,#c0392b);' }, '删除这个服务商');
            del.addEventListener('click', async () => {
              const refs = draft.models.filter((m) => m.providerId === item.id);
              if (refs.length) { toast('还有模型引用这个服务商，先删除对应模型', { type: 'error' }); return; }
              const okd = await confirmDialog({ title: '删除服务商', message: `删除「${item.name || item.id}」？只影响界面配置，不改 .env。`, confirmText: '删除', destructive: true });
              if (!okd) return;
              draft.providers = draft.providers.filter((p) => p.id !== item.id);
              sheetApi.close();
              markDirty();
            });
            body.appendChild(del);
          }
        },
        onConfirm(api2) {
          const name = nameIn.value.trim();
          const baseUrl = urlIn.value.trim();
          if (!name) { toast('给服务商起个名字', { type: 'error' }); return false; }
          if (!/^https?:\/\/.+/i.test(baseUrl)) { toast('Base URL 需要以 http:// 或 https:// 开头', { type: 'error' }); return false; }
          const apiKey = keyAction === 'keep' ? '***' : keyAction === 'clear' ? '' : keyIn.value.trim();
          const record = { id: item.id || `provider-${Date.now().toString(36)}`, name, baseUrl, protocol: 'openai', enabled, apiKey };
          const i = draft.providers.findIndex((p) => p.id === record.id);
          if (i >= 0) draft.providers[i] = record; else draft.providers.push(record);
          markDirty();
          return true;
        },
      });
    }

    function openModelSheet(existing) {
      const isNew = !existing;
      const item = existing || {
        id: null, providerId: draft.providers[0]?.id || '', model: '', label: '',
        contextWindow: 200000, maxOutput: 12000,
        supportsReasoning: true, reasoningEfforts: ['low', 'medium', 'high'],
        supportsTemperature: true, enabled: true,
      };
      let enabled = item.enabled !== false;
      let supportsReasoning = item.supportsReasoning !== false;
      let supportsTemperature = item.supportsTemperature !== false;

      const labelIn = el('input.field', { type: 'text', value: item.label || '', placeholder: '例如：主力大模型' });
      const modelIn = el('input.field', { type: 'text', value: item.model || '', placeholder: '上游 model 名，例如 step-5-preview' });
      const providerSel = makeSelect(draft.providers.map((p) => [p.id, p.name || p.id]), item.providerId);
      const ctxIn = el('input.field', { type: 'number', min: 1, step: 1000, value: item.contextWindow || '' });
      const outIn = el('input.field', { type: 'number', min: 1, step: 1000, value: item.maxOutput || '' });

      const sheetApi = openSheet({
        title: isNew ? '添加模型' : '编辑模型',
        confirmText: '保存',
        render(body) {
          body.appendChild(formLine('显示名', labelIn));
          body.appendChild(formLine('服务商', providerSel));
          body.appendChild(formLine('上游 model 名', modelIn, '请求体里的 model 字段。'));
          body.appendChild(formLine('上下文窗口（token）', ctxIn, '决定这一局能读多长；超过这里的值会被硬上限拦住。'));
          body.appendChild(formLine('单次最大输出（token）', outIn, 'Agent 没有单独设置 maxTokens 时用它。'));
          body.appendChild(toggleRow('支持推理强度', '关掉后不向上游发送 reasoning_effort', supportsReasoning, (v) => { supportsReasoning = v; }));
          body.appendChild(toggleRow('支持温度', '关掉后不向上游发送 temperature', supportsTemperature, (v) => { supportsTemperature = v; }));
          body.appendChild(toggleRow('启用', '停用后引用它的 Agent 会回落到 .env 默认模型', enabled, (v) => { enabled = v; }));
          if (!isNew) {
            const del = el('button.btn.btn-ghost', { type: 'button', style: 'margin-top:12px;color:var(--danger,#c0392b);' }, '删除这个模型');
            del.addEventListener('click', async () => {
              const okd = await confirmDialog({ title: '删除模型', message: `删除「${item.label || item.model}」？引用它的 Agent 会回到「跟随 .env」。`, confirmText: '删除', destructive: true });
              if (!okd) return;
              draft.models = draft.models.filter((m) => m.id !== item.id);
              for (const key of Object.keys(draft.agents)) {
                if (draft.agents[key].modelId === item.id) draft.agents[key].modelId = null;
              }
              sheetApi.close();
              markDirty();
            });
            body.appendChild(del);
          }
        },
        onConfirm() {
          const model = modelIn.value.trim();
          if (!model) { toast('填一下上游 model 名', { type: 'error' }); return false; }
          const contextWindow = Number(ctxIn.value);
          const maxOutput = Number(outIn.value);
          if (!Number.isFinite(contextWindow) || contextWindow <= 0) { toast('上下文窗口需要是正整数', { type: 'error' }); return false; }
          if (!Number.isFinite(maxOutput) || maxOutput <= 0) { toast('最大输出需要是正整数', { type: 'error' }); return false; }
          const record = {
            id: item.id || `model-${Date.now().toString(36)}`,
            providerId: providerSel.value,
            model,
            label: labelIn.value.trim() || model,
            contextWindow: Math.trunc(contextWindow),
            maxOutput: Math.trunc(maxOutput),
            supportsReasoning,
            reasoningEfforts: supportsReasoning ? ['low', 'medium', 'high'] : [],
            supportsTemperature,
            enabled,
          };
          const i = draft.models.findIndex((m) => m.id === record.id);
          if (i >= 0) draft.models[i] = record; else draft.models.push(record);
          markDirty();
          return true;
        },
      });
    }

    function openAgentSheet(key) {
      const [label] = AGENT_META[key];
      const binding = draft.agents[key] || { modelId: null, effort: null, temperature: null, maxTokens: null };
      const effective = cfg.runtime?.agents?.[key] || {};
      const modelOptions = [['', `跟随 .env（${effective.model || '—'}）`],
        ...draft.models.map((m) => [m.id, `${m.label || m.model} · ${draft.providers.find((p) => p.id === m.providerId)?.name || m.providerId}`])];
      const modelSel = makeSelect(modelOptions, binding.modelId || '');
      const effortSel = makeSelect([['', `跟随 .env（${effective.effort ? (EFFORT_LABELS[effective.effort] || effective.effort) : '—'}）`], ...Object.entries(EFFORT_LABELS)], binding.effort || '');
      const tempIn = el('input.field', {
        type: 'number', min: 0, max: 2, step: 0.05,
        value: typeof binding.temperature === 'number' ? binding.temperature : '',
        placeholder: `跟随 .env（${effective.temperature ?? '—'}）`,
      });
      const maxIn = el('input.field', {
        type: 'number', min: 1, step: 1000,
        value: Number.isFinite(binding.maxTokens) ? binding.maxTokens : '',
        placeholder: `跟随 .env（${effective.maxTokens ?? '—'}）`,
      });

      const sheetApi = openSheet({
        title: `分配 · ${label}`,
        confirmText: '保存',
        render(body) {
          body.appendChild(formLine('使用模型', modelSel, '「跟随 .env」= 不写绑定，用环境变量里的模型。'));
          body.appendChild(formLine('推理强度', effortSel));
          body.appendChild(formLine('温度', tempIn, '留空表示跟随 .env。'));
          body.appendChild(formLine('单次最大输出（token）', maxIn, '留空表示跟随模型的最大输出或 .env。'));
          const clear = el('button.btn.btn-ghost', { type: 'button', style: 'margin-top:8px;' }, '清空绑定，回到跟随 .env');
          clear.addEventListener('click', () => {
            delete draft.agents[key];
            sheetApi.close();
            markDirty();
          });
          body.appendChild(clear);
        },
        onConfirm() {
          const modelId = modelSel.value || null;
          const effort = effortSel.value || null;
          const temperature = tempIn.value === '' ? null : Number(tempIn.value);
          const maxTokens = maxIn.value === '' ? null : Number(maxIn.value);
          if (temperature != null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
            toast('温度需要在 0–2 之间', { type: 'error' }); return false;
          }
          if (maxTokens != null && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
            toast('最大输出需要是正整数', { type: 'error' }); return false;
          }
          if (!modelId && !effort && temperature == null && maxTokens == null) delete draft.agents[key];
          else draft.agents[key] = { modelId, effort, temperature, maxTokens };
          markDirty();
          return true;
        },
      });
    }

    /* ---- 上下文与记忆（只读） ---- */
    function contextGroup() {
      if (!cfg) {
        return el('div.group', {}, el('div.group-card', {},
          el('div.li', {}, el('div.li-body', {}, el('div.li-sub', {}, '读取配置中…')))));
      }
      const wrap = el('div.group');
      const ctx = cfg.runtime?.context || {};
      const hard = ctx.hard_max_tokens ?? cfg.limits?.context_max_tokens ?? 0;
      const soft = ctx.soft_target_tokens ?? cfg.limits?.context_soft_tokens ?? 0;
      const windowTok = ctx.window_tokens ?? cfg.limits?.context_window_tokens ?? 0;
      const reserve = ctx.output_reserve_tokens ?? cfg.limits?.context_output_reserve_tokens ?? 0;

      wrap.appendChild(el('div', {},
        el('div.group-title', {}, '上下文'),
        el('div.group-card', {},
          infoRow('模型窗口', `${fmtNumber(windowTok)} tok`,
            `来自演绎模型${ctx.model ? `（${ctx.model}）` : ''}；预算从这里推导，不再写死各层常量`),
          infoRow('提示词硬上限', `${fmtNumber(hard)} tok`,
            `窗口 − 生成预留 ${fmtNumber(reserve)} tok − 安全余量；超过这一轮会被拒绝，绝不把半句话送进模型`),
          infoRow('软目标', `${fmtNumber(soft)} tok`,
            ctx.auto_soft
              ? '按窗口自动取 55%；超出时先收窄易变尾部，再收窄历史'
              : '每轮装配的目标体积（.env 指定）；超出时先收窄易变尾部，再收窄历史'),
        ),
      ));

      const b = cfg.budget;
      if (b) {
        wrap.appendChild(el('div', {},
          el('div.group-title', {}, '各层 token 配额'),
          el('div.group-card', {},
            infoRow('世界规则', `${fmtTokens(b.system)} tok`, '演绎契约 + 故事方向 + 世界规则 + 世界索引 + 前史 + 主角'),
            infoRow('场次索引', `${fmtTokens(b.archive)} tok`, '一行一场，只追加；这是长程记忆的载体'),
            infoRow('最近场次细节', `${fmtTokens(b.archiveDetail)} tok`, '刚才那一场怎么收的'),
            infoRow('最近原文', `${fmtTokens(b.recent)} tok`, '当前场次逐字原文的规划上限；只用于决定何时强制封场，不裁原文'),
            infoRow('本场状态', `${fmtTokens(b.scene)} tok`, '账本 + 在场者 + 设定集候选 + 关系 + 知识边界 + 原声'),
            infoRow('检索结果', `${fmtTokens(b.retrieval)} tok`, '模型主动查到的设定全文，当拍蒸发'),
            infoRow('本轮输入', `${fmtTokens(b.current)} tok`, '你的行动 + 本场指令 + 尾注'),
          ),
          el('div.group-note', {},
            '各层按职责比例从模型窗口推导（合计 = 软目标），记忆载体优先：'
            + '场次索引与逐字原文占 70%。历史不会被「再摘要一次」：场次索引只追加，'
            + '原文按场次边界收，收不下的部分先降级粒度而不是静默丢字。'),
        ));
      }

      const d = cfg.defaults || {};
      wrap.appendChild(el('div', {},
        el('div.group-title', {}, '节奏'),
        el('div.group-card', {},
          infoRow('一致性检查', `每 ${d.continuity_every ?? 10} 轮`, `最多保留 ${d.continuity_max_applied ?? 20} 条修正`),
          infoRow('强制封场', d.scene_every ? `每 ${d.scene_every} 轮` : '只按地点变化', `单场原文上限 ${fmtNumber(d.scene_max_tokens ?? 20000)} tok`),
          infoRow('后台推演', '切场时触发', '推演不在场角色的行动，不按固定轮数'),
        ),
      ));
      wrap.appendChild(el('div.group-note', {}, '这些是 .env 里的服务端节奏；模型与上下文窗口在上面的「模型」一节里配置。'));
      return wrap;
    }

    /* ---- 接入 ---- */
    function apiGroup() {
      const card = el('div.group-card');
      card.appendChild(el('div.li.is-button', { onclick: () => openApiSheet() },
        el('div.li-icon', {}, icon('globe', { size: 13 })),
        el('div.li-body', {},
          el('div.li-title', {}, 'OpenAI 兼容接口'),
          el('div.li-sub', {}, '任何支持 OpenAI 协议的客户端都能接入'),
        ),
        el('span.li-accent', {}, icon('chevronRight', { size: 13 })),
      ));
      return el('div.group', {}, card);
    }

    function openApiSheet() {
      const base = `${location.origin}/v1`;
      const model = cfg?.models?.default || 'step-5-preview';
      openSheet({
        title: 'OpenAI 兼容接入',
        cancelText: '关闭',
        render(body) {
          body.appendChild(el('div', {},
            el('div', { style: 'font-size:var(--fs-caption);line-height:1.7;color:var(--ink-2);margin-bottom:12px;' },
              '把任何 OpenAI 客户端的 Base URL 指到这里即可。'),
            el('div.group-title', { style: 'padding:0 0 6px;' }, '基础信息'),
            el('div.code', {}, `Base URL   ${base}\nAPI Key    任意非空字符串\nModel      ${model}`),

            el('div.group-title', { style: 'padding:16px 0 6px;' }, '普通对话（透传）'),
            el('div.code', {}, `curl ${base}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}],"stream":true}'`),

            el('div.group-title', { style: 'padding:16px 0 6px;' }, '角色扮演模式'),
            el('div', { style: 'font-size:var(--fs-caption);line-height:1.7;color:var(--ink-2);margin-bottom:6px;' },
              '带上 world_id 与 session_id 就进入世界卡管线。'),
            el('div.code', {}, `{\n  "model": "${model}",\n  "world_id": "nvzun-jianpolan",\n  "session_id": "new",\n  "messages": [{"role": "user", "content": "我的行动"}],\n  "generate_branches": true,\n  "stream": true\n}`),
          ));
        },
      });
    }

    function about() {
      return el('div.about', {},
        el('div.about-mark', {}, '叙'),
        el('div.about-name', {}, '叙事台'),
        el('div.about-ver', {}, 'v4 · 世界卡驱动的剧情演绎'),
      );
    }

    render();
    loadServerFonts();
    scroll.addEventListener('scroll', onScroll, { passive: true });

    api.getConfig().then((c) => {
      cfg = c;
      syncDraft();
      const keep = scroll.scrollTop;
      render();
      scroll.scrollTop = keep;
    }).catch(() => {});

    return {
      unmount() {
        scroll.removeEventListener('scroll', onScroll);
      },
    };
  },
};
