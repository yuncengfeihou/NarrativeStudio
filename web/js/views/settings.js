/**
 * views/settings.js — 设置
 *
 * 分组：外观 / 阅读 / 遥测 / 模型与记忆 / 接入 / 关于
 * 所有项即时生效并持久化（localStorage），没有「保存」按钮。
 */

import { el, clear, fmtNumber, fmtTokens } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, openSheet } from '../app.js';
import { ui, setTheme, setPref, applyReadingPrefs } from '../store.js';
import { toggleRow, infoRow } from '../ui-kit.js';

export default {
  id: 'settings',
  title: '设置',

  async mount(root) {
    let cfg = null;

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
      clear(scroll);
      const box = el('div.page.is-narrow.settings-max');
      scroll.appendChild(box);

      box.appendChild(el('div.page-head', {},
        el('div.page-head-text', {},
          el('h1.page-title', {}, '设置'),
          el('div.page-sub', {}, '所有改动即时生效。'),
        ),
      ));

      box.appendChild(appearanceGroup());
      box.appendChild(readingGroup());
      box.appendChild(telemetryGroup());
      box.appendChild(modelGroup());
      box.appendChild(apiGroup());

      box.appendChild(el('div.about', {},
        el('div.about-mark', {}, '叙'),
        el('div.about-name', {}, '叙事台'),
        el('div.about-ver', {}, 'v3 · 世界卡驱动的剧情演绎'),
      ));
    }

    /* ---- 外观 ---- */
    function appearanceGroup() {
      const current = ui.get().theme;
      const card = el('div.group-card', { style: 'padding:0;' });
      const row = el('div.theme-cards');

      const options = [
        ['light', '浅色', 'is-light'],
        ['dark', '深色', 'is-dark'],
        ['system', '跟随系统', 'is-auto'],
      ];

      for (const [value, label, swatchCls] of options) {
        row.appendChild(el('button.theme-card', {
          type: 'button',
          class: current === value ? 'is-active' : '',
          onclick: () => {
            setTheme(value);
            Array.from(row.children).forEach((c, i) => c.classList.toggle('is-active', options[i][0] === value));
            toast(value === 'dark' ? '已切换深色' : value === 'light' ? '已切换浅色' : '跟随系统');
          },
        },
          el('div.theme-swatch', { class: swatchCls }, el('span'), el('span')),
          el('span.theme-card-label', {}, label),
        ));
      }

      card.appendChild(row);
      return el('div.group', {}, el('div.group-title', {}, '外观'), card);
    }

    /* ---- 阅读 ---- */
    function readingGroup() {
      const s = ui.get();
      const card = el('div.group-card');

      const sizeLabel = el('div.li-value', {}, `${s.readingSize} px`);
      const sizeSlider = el('input', {
        type: 'range', min: 15, max: 22, step: 0.5, value: s.readingSize,
        style: 'flex:1;accent-color:var(--accent);',
      });
      sizeSlider.addEventListener('input', () => {
        const v = Number(sizeSlider.value);
        sizeLabel.textContent = `${v} px`;
        setPref('readingSize', v);
        applyReadingPrefs();
      });
      card.appendChild(el('div.li', {},
        el('div.li-body', {}, el('div.li-title', {}, '正文字号')),
        sizeLabel,
      ));
      card.appendChild(el('div.li', { style: 'padding-top:0;' }, sizeSlider));

      const widths = [['compact', '紧凑'], ['normal', '标准'], ['wide', '宽松']];
      const widthSeg = el('div.segmented');
      for (const [value, label] of widths) {
        widthSeg.appendChild(el('button.segmented-item', {
          type: 'button',
          class: s.readingWidth === value ? 'is-active' : '',
          onclick: () => {
            setPref('readingWidth', value);
            applyReadingPrefs();
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

      return el('div.group', {}, el('div.group-title', {}, '阅读体验'), card);
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
            '首字 = 从发请求到第一个字出现的时间。用时 = 整轮耗时。输入/输出 = 这一轮消耗的 token。' +
            '速度 = 生成阶段的 tok/s（不含排队）。缓存 = 上游前缀缓存的命中率——越高越省钱。'),
        ),
      ));
      return el('div.group', {}, el('div.group-title', {}, '遥测'), card);
    }

    /* ---- 模型与记忆 ---- */
    function modelGroup() {
      const card = el('div.group-card');
      if (!cfg) {
        card.appendChild(el('div.li', {}, el('div.li-body', {}, el('div.li-sub', {}, '读取配置中…'))));
      } else {
        card.appendChild(infoRow('模型', cfg.models?.default || '—', '所有 Agent 共用'));
        card.appendChild(infoRow('演绎推理强度', effortLabel(cfg.defaults?.narrator_effort), '越高越细腻，越慢'));
        card.appendChild(infoRow('上下文软目标', `${fmtNumber(cfg.limits?.context_soft_tokens || 52000)} tok`, '每轮装配的目标体积'));
        card.appendChild(infoRow('上下文硬上限', `${fmtNumber(cfg.limits?.context_max_tokens || 200000)} tok`, '绝对安全线'));
        card.appendChild(infoRow('压缩节奏', `${cfg.defaults?.arc_every ?? 6} 轮/幕 · ${cfg.defaults?.saga_every ?? 4} 幕/卷`, 'L1→L2→L3 的合并节奏'));
        card.appendChild(infoRow('反思间隔', `每 ${cfg.defaults?.reflect_every ?? 5} 轮`, '跨轮结论的提炼频率'));
        card.appendChild(infoRow('保留原始回合', String(cfg.defaults?.recent_raw_turns ?? 4), '逐字保留的最近轮数'));
      }

      const b = cfg?.budget;
      if (b) {
        const wrap = el('div.group', {},
          el('div.group-title', {}, '各层 token 配额'),
          el('div.group-card', {},
            infoRow('演绎契约', `${b.system} tok`, '视角/文风/禁令，固定不变'),
            infoRow('世界设定', `${b.world} tok`, '宪章 + 主角 + 在场卡司'),
            infoRow('触发词条', `${b.lore} tok`, '按关键词命中注入'),
            infoRow('场景与导演', `${b.scene + b.director} tok`, '场景账本 + 本幕目标'),
            infoRow('分层记忆', `${fmtTokens(b.memory)} tok`, '摘要/关系/线索/实体/反思/笔记'),
            infoRow('最近原文', `${fmtTokens(b.recent)} tok`, '逐字保留的最近若干轮'),
          ),
          el('div.group-note', {},
            '每一层独立配额，互不挤占。剧情推进一千轮，每层仍只占这么多——变的是摘要的密度，不是层数。'),
        );
        return wrap;
      }

      return el('div.group', {},
        el('div.group-title', {}, '模型与记忆'),
        card,
        el('div.group-note', {}, '这些是服务端默认值，可在世界卡里单独覆盖上下文上限。'),
      );
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
      return el('div.group', {}, el('div.group-title', {}, '接入'), card);
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

    function effortLabel(v) {
      return ({ low: '低', medium: '中', high: '高' })[v] || v || '—';
    }

    render();
    api.getConfig().then((c) => { cfg = c; render(); }).catch(() => {});

    return { unmount() {} };
  },
};
