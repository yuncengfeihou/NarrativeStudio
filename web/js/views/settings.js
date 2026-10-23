/**
 * views/settings.js — 设置
 *
 * 分组：外观 / 阅读 / 模型与记忆 / 接口 / 关于
 * 所有可调项都直接生效并持久化（localStorage），不做「保存」按钮。
 */

import { el, clear, fmtNumber } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { navigate, toast, openSheet } from '../app.js';
import { ui, setTheme, setPref, applyReadingPrefs } from '../store.js';

export default {
  id: 'settings',
  title: '设置',

  async mount(root) {
    let cfg = null;

    const nav = el('header.nav', {},
      el('button.icon-btn.nav-hamburger', {
        type: 'button', 'aria-label': '会话库',
        onclick: () => import('../sidebar.js').then((m) => m.openSidebar()),
      }, icon('sidebar', { size: 19 })),
      el('button.nav-back', { type: 'button', onclick: () => navigate('#/') },
        icon('chevronLeft', { size: 19, stroke: 2.2 }), '首页'),
      el('div.nav-title', {}, '设置'),
      el('span', { style: 'width:34px;' }),
    );

    const scroll = el('div.scroll');
    const view = el('section.view', { 'data-view': 'settings' }, nav, scroll);
    root.appendChild(view);

    scroll.addEventListener('scroll', () => {
      nav.classList.toggle('is-scrolled', scroll.scrollTop > 4);
    }, { passive: true });

    function render() {
      clear(scroll);
      const box = el('div.container.is-narrow.settings', {});
      scroll.appendChild(box);

      box.appendChild(appearanceGroup());
      box.appendChild(readingGroup());
      box.appendChild(chatGroup());
      box.appendChild(modelGroup());
      box.appendChild(apiGroup());
      box.appendChild(aboutGroup());

      box.appendChild(el('div.about', {},
        el('div.about-logo', {}, icon('wand', { size: 26, stroke: 1.8 })),
        el('div.about-name', {}, '角色剧场'),
        el('div.about-ver', {}, 'v2.0 · 多 Agent 分层记忆'),
        el('div', { style: 'font-size:var(--fs-caption);color:var(--label-tertiary);margin-top:5px;text-align:center;line-height:1.6;' },
          '每一轮剧情，都由你选择走向。'),
      ));
    }

    /* ---------------------------------------------------------------------
     * 外观
     * ------------------------------------------------------------------ */
    function appearanceGroup() {
      const current = ui.get().theme;
      const card = el('div.group-card', { style: 'padding:0;' });
      const row = el('div.theme-cards');

      const options = [
        ['light', '浅色', 'is-light', 'sun'],
        ['dark', '深色', 'is-dark', 'moon'],
        ['system', '跟随系统', 'is-auto', 'palette'],
      ];

      for (const [value, label, swatchCls] of options) {
        row.appendChild(el('button.theme-card', {
          type: 'button',
          class: current === value ? 'is-active' : '',
          onclick: () => {
            setTheme(value);
            Array.from(row.children).forEach((c, i) => c.classList.toggle('is-active', options[i][0] === value));
            toast(value === 'dark' ? '已切换深色' : value === 'light' ? '已切换浅色' : '跟随系统外观');
          },
        },
          el('div.theme-swatch', { class: swatchCls }, el('span'), el('span')),
          el('span.theme-card-label', {}, label),
        ));
      }

      card.appendChild(row);
      return el('div.group', {},
        el('div.group-title', {}, '外观'),
        card,
      );
    }

    /* ---------------------------------------------------------------------
     * 阅读
     * ------------------------------------------------------------------ */
    function readingGroup() {
      const s = ui.get();
      const card = el('div.group-card');

      // 正文字号
      const sizeLabel = el('div.li-value', {}, `${s.readingSize} px`);
      const sizeSlider = el('input', {
        type: 'range', min: 15, max: 22, step: 0.5, value: s.readingSize,
        style: 'flex:1;accent-color:var(--tint);',
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
      card.appendChild(el('div.li', { style: 'padding-top:2px;' }, sizeSlider));

      // 阅读宽度
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

      // 回合分隔
      card.appendChild(toggleRow('显示回合分隔', '每轮之间显示「第 N 回合」，关闭后更沉浸',
        ui.get().showTurnMarks !== false,
        (v) => setPref('showTurnMarks', v)));

      // 默认展开思考
      card.appendChild(toggleRow('默认展开思考过程', '演绎引擎的推理过程默认收起，开启后自动展开',
        ui.get().showReasoning === true,
        (v) => setPref('showReasoning', v)));

      return el('div.group', {},
        el('div.group-title', {}, '阅读体验'),
        card,
      );
    }

    /* ---------------------------------------------------------------------
     * 对话
     * ------------------------------------------------------------------ */
    function chatGroup() {
      const card = el('div.group-card');
      card.appendChild(el('div.li', { style: 'align-items:flex-start;' },
        el('div.li-icon', {}, icon('compass', { size: 15 })),
        el('div.li-body', {},
          el('div.li-title', {}, '分支选项'),
          el('div.li-sub', {},
            '每轮结束后，分支引擎会给出 3-4 条可选走向。双击卡片可直接发送，也可以无视它们自由输入行动。'),
        ),
      ));
      card.appendChild(el('div.li', { style: 'align-items:flex-start;' },
        el('div.li-icon', {}, icon('memory', { size: 15 })),
        el('div.li-body', {},
          el('div.li-title', {}, '记忆与改写'),
          el('div.li-sub', {},
            '在对话里点旁白下方的「回到此轮」可以回滚重来；点「记忆系统」可以查看、固定或修正引擎记住的一切。'),
        ),
      ));
      return el('div.group', {},
        el('div.group-title', {}, '操作说明'),
        card,
      );
    }

    /* ---------------------------------------------------------------------
     * 模型与记忆
     * ------------------------------------------------------------------ */
    function modelGroup() {
      const card = el('div.group-card');
      if (!cfg) {
        card.appendChild(el('div.li', {}, el('div.li-body', {}, el('div.li-sub', {}, '读取配置中…'))));
      } else {
        card.appendChild(infoRow('模型', cfg.models?.default || '—', '所有 Agent 共用'));
        card.appendChild(infoRow('演绎推理强度', effortLabel(cfg.defaults?.narrator_effort), '越高越细腻，越慢'));
        card.appendChild(infoRow('分支推理强度', effortLabel(cfg.defaults?.branch_effort), '分支设计的思考深度'));
        card.appendChild(infoRow('记忆推理强度', effortLabel(cfg.defaults?.memory_effort), '每轮归档的思考深度'));
        card.appendChild(infoRow('上下文硬上限', `${fmtNumber(cfg.limits?.context_max_tokens || 200000)} tok`, '装配提示词的绝对上限'));
        card.appendChild(infoRow('保留原始回合', String(cfg.defaults?.recent_raw_turns ?? 4), '逐字保留的最近回合数'));
        card.appendChild(infoRow('压缩节奏', `每 ${cfg.defaults?.arc_every ?? 5} 轮 / ${cfg.defaults?.saga_every ?? 5} 篇章`, 'L1→L2→L3 的合并节奏'));
        card.appendChild(infoRow('单轮生成上限', `${fmtNumber(cfg.limits?.narrator_max_tokens || 12000)} tok`, '一轮最多生成多少'));
      }
      return el('div.group', {},
        el('div.group-title', {}, '模型与记忆'),
        card,
        el('div.group-note', {}, '这些是服务端默认值，可在每段剧情的「编辑设定 → 高级」里单独覆盖。'),
      );
    }

    /* ---------------------------------------------------------------------
     * 接口
     * ------------------------------------------------------------------ */
    function apiGroup() {
      const card = el('div.group-card');
      card.appendChild(el('div.li.is-button', {
        onclick: () => openApiSheet(),
      },
        el('div.li-icon', {}, icon('globe', { size: 15 })),
        el('div.li-body', {},
          el('div.li-title', {}, 'OpenAI 兼容接口'),
          el('div.li-sub', {}, '任何支持 OpenAI 协议的客户端都可以接入'),
        ),
        el('span.li-accent', {}, icon('chevronRight', { size: 15 })),
      ));
      return el('div.group', {},
        el('div.group-title', {}, '接入'),
        card,
      );
    }

    function openApiSheet() {
      const base = `${location.origin}/v1`;
      const model = cfg?.models?.default || 'step-5-preview';
      openSheet({
        title: 'OpenAI 兼容接入',
        cancelText: '关闭',
        render(body) {
          body.appendChild(el('div', { style: 'padding:8px 16px 16px;' },
            el('div', { style: 'font-size:var(--fs-footnote);line-height:1.7;color:var(--label-secondary);' },
              '把任何 OpenAI 客户端的 Base URL 指到这里即可。'),
            el('div.group-title', { style: 'padding:14px 0 6px;' }, '基础信息'),
            el('div.code', {}, `Base URL   ${base}\nAPI Key    任意非空字符串\nModel      ${model}`),

            el('div.group-title', { style: 'padding:16px 0 6px;' }, '普通对话（透传）'),
            el('div', { style: 'font-size:var(--fs-footnote);line-height:1.7;color:var(--label-secondary);margin-bottom:6px;' },
              '不带 session_id 时，请求会原样转发给上游，支持流式与 reasoning。'),
            el('div.code', {}, `curl ${base}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}],"stream":true}'`),

            el('div.group-title', { style: 'padding:16px 0 6px;' }, '角色扮演模式'),
            el('div', { style: 'font-size:var(--fs-footnote);line-height:1.7;color:var(--label-secondary);margin-bottom:6px;' },
              '带上 session_id 就进入多 Agent 管线：记忆 + 分支 + 演绎。'),
            el('div.code', {}, `{\n  "model": "${model}",\n  "session_id": "new",\n  "settings": { "title": "…", "worldview": "…", "characters": [] },\n  "messages": [{"role": "user", "content": "我的行动"}],\n  "generate_branches": true,\n  "stream": true\n}`),
          ));
        },
      });
    }

    /* ---------------------------------------------------------------------
     * 关于
     * ------------------------------------------------------------------ */
    function aboutGroup() {
      const card = el('div.group-card');
      card.appendChild(infoRow('版本', 'v2.0.0', '重写的前端 + 增强记忆'));
      card.appendChild(infoRow('技术栈', 'Node + SQLite', '无构建，原生 ES modules'));
      card.appendChild(infoRow('上游', 'StepFun step_plan', 'OpenAI 兼容协议'));
      return el('div.group', {}, el('div.group-title', {}, '关于'), card);
    }

    /* ---------------------------------------------------------------------
     * 组件
     * ------------------------------------------------------------------ */
    function infoRow(label, value, desc) {
      return el('div.li', {},
        el('div.li-body', {},
          el('div.li-title', {}, label),
          desc ? el('div.li-sub', {}, desc) : null,
        ),
        el('div.li-value', {}, value),
      );
    }    function toggleRow(label, desc, initial, onChange) {
      let on = initial;
      const sw = el('div.switch', { role: 'switch', 'aria-checked': String(on), tabindex: '0' },
        el('div.switch-knob'));
      const toggle = () => {
        on = !on;
        sw.setAttribute('aria-checked', String(on));
        onChange(on);
      };
      sw.addEventListener('click', toggle);
      sw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      return el('div.li', {},
        el('div.li-body', {},
          el('div.li-title', {}, label),
          desc ? el('div.li-sub', {}, desc) : null,
        ),
        sw,
      );
    }

    function effortLabel(v) {
      return ({ low: '低', medium: '中', high: '高' })[v] || v || '—';
    }

    render();
    api.getConfig().then((c) => { cfg = c; render(); }).catch(() => {});

    return { unmount() {} };
  },
};
