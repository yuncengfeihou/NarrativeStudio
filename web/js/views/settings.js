/**
 * views/settings.js — 设置
 *
 * 分组：外观 / 字体 / 阅读 / 遥测 / 模型 / 接入
 * 所有项即时生效并持久化（localStorage），没有「保存」按钮。
 * 桌面端左侧是吸顶的分组导航，窄屏折成横向滚动条。
 */

import { el, clear, fmtNumber, fmtTokens } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, openSheet } from '../app.js';
import { ui, setTheme, setPref, applyAppearancePrefs } from '../store.js';
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
  ['api', '接入'],
];

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
    let activeSection = 'appearance';
    let sectionNodes = [];
    let navButtons = [];
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
      const model = section('model', '模型与记忆', '服务端默认值；改 .env 才能调整。');
      model.appendChild(modelGroup());
      const apiSec = section('api', '接入', '把叙事台当成一个 OpenAI 兼容服务来用。');
      apiSec.appendChild(apiGroup());

      sectionNodes = [appearance, type, reading, telemetry, model, apiSec];
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
      // scroll-margin-top 在窄屏会为吸顶的分组导航留出高度。
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function onScroll() {
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
          onclick: () => {
            setTheme(value);
            cards.forEach((c, i) => c.classList.toggle('is-active', options[i][0] === value));
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

    /* ---- 模型与记忆 ---- */
    function modelGroup() {
      const card = el('div.group-card');
      if (!cfg) {
        card.appendChild(el('div.li', {}, el('div.li-body', {}, el('div.li-sub', {}, '读取配置中…'))));
      } else {
        card.appendChild(infoRow('模型', cfg.models?.default || '—', '所有 Agent 共用'));
        card.appendChild(infoRow('演绎推理强度', effortLabel(cfg.defaults?.narrator_effort), '越高越细腻，越慢'));
        card.appendChild(infoRow('史官推理强度', effortLabel(cfg.defaults?.archivist_effort), '每轮把正文抽成结构化记忆'));
        card.appendChild(infoRow('上下文软目标', `${fmtNumber(cfg.limits?.context_soft_tokens || 52000)} tok`, '每轮装配的目标体积'));
        card.appendChild(infoRow('上下文硬上限', `${fmtNumber(cfg.limits?.context_max_tokens || 200000)} tok`, '绝对安全线'));
        card.appendChild(infoRow('逐字保留回合', String(cfg.defaults?.recent_raw_turns ?? 4), '一个回合 = 你的行动 + 旁白'));
        card.appendChild(infoRow('校勘间隔', `每 ${cfg.defaults?.continuity_every ?? 10} 轮`, '查矛盾、知识越界、别名冲突'));
        card.appendChild(infoRow('世界呼吸间隔', `每 ${cfg.defaults?.world_tick_every ?? 8} 轮`, '推演不在场角色的行动'));
      }

      const b = cfg?.budget;
      const wrap = el('div.group', {}, card);

      if (b) {
        wrap.appendChild(el('div.group', {},
          el('div.group-title', {}, '各层 token 配额'),
          el('div.group-card', {},
            infoRow('系统层', `${fmtTokens(b.system)} tok`, '演绎契约 + 命题 + 宪章 + 世界索引'),
            infoRow('最近原文', `${fmtTokens(b.recent)} tok`, '逐字保留的最近若干轮'),
            infoRow('场记单', `${fmtTokens(b.scene)} tok`, '当前这一刻的世界状态，每场渲染一次'),
            infoRow('本轮输入', `${fmtTokens(b.current)} tok`, '你的行动 + 本场指令 + 尾注'),
          ),
          el('div.group-note', {},
            '提示词是从世界状态渲染出来的，不是从词条库检索出来的。四层各自独立配额，'
            + '互不挤占；剧情推进一千轮，每层仍只占这么多。'),
        ));
      }

      wrap.appendChild(el('div.group-note', {}, '这些是服务端默认值，可在 .env 里调整。'));
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

    function effortLabel(v) {
      return ({ low: '低', medium: '中', high: '高' })[v] || v || '—';
    }

    render();
    loadServerFonts();
    scroll.addEventListener('scroll', onScroll, { passive: true });

    api.getConfig().then((c) => {
      cfg = c;
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
