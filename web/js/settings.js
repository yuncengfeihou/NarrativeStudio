/**
 * settings.js — 设置视图
 *
 * 分组：外观 / 模型与推理 / 记忆系统 / 关于
 * 数据来源：GET /api/config（服务端实际配置）
 */
import { $, el, clear } from './util.js';
import { api } from './api.js';
import { navigate, toast, openSheet } from './app.js';
import { openSidebar } from './sidebar.js';
import { ui, setTheme, cycleTheme } from './store.js';

export default {
  id: 'settings',
  title: '设置',

  async mount(root) {
    let cfg = null;

    /* ---------------- 导航栏 ---------------- */
    const navBar = el('header.main-nav', {},
      el('button.main-nav-btn.icon-only.nav-hamburger', {
        type: 'button', 'aria-label': '打开会话库', onclick: () => openSidebar(),
      }, '☰'),
      el('span.main-nav-title', {}, '设置'),
      el('span.main-nav-btn.icon-only', { style: 'visibility:hidden;' }, ''),
    );

    const scroll = el('div.main-scroll');
    const view = el('section.view', { 'data-view': 'settings' }, navBar, scroll);
    root.appendChild(view);

    /* ---------------- 渲染 ---------------- */
    function render() {
      clear(scroll);
      const wrap = el('div.settings');

      /* 外观 */
      wrap.appendChild(groupTitle('外观'));
      const themeCard = el('div.settings-card');
      const themeRow = el('div.settings-row',
        rowBody('主题', '浅色 / 深色 / 跟随系统'),
        segmented(
          [['light', '浅色'], ['dark', '深色'], ['system', '系统']],
          ui.get().theme,
          (v) => { setTheme(v); toast(v === 'dark' ? '已切换深色' : v === 'light' ? '已切换浅色' : '跟随系统外观'); renderTheme(); },
        ),
      );
      themeCard.appendChild(themeRow);
      wrap.appendChild(themeCard);

      /* 模型与推理 */
      wrap.appendChild(groupTitle('模型与推理'));
      const modelCard = el('div.settings-card');
      if (cfg) {
        modelCard.appendChild(row('默认模型', cfg.models?.default || '—', '所有 Agent 共用的上游模型'));
        modelCard.appendChild(row('剧情演绎推理强度', cfg.defaults?.narrator_effort || 'high', '越高叙事越细腻，响应越慢'));
        modelCard.appendChild(row('分支生成推理强度', cfg.defaults?.branch_effort || 'medium', '分支设计的思考深度'));
        modelCard.appendChild(row('记忆归档推理强度', cfg.defaults?.memory_effort || 'low', '每轮记忆更新的思考深度'));
      } else {
        modelCard.appendChild(row('配置', '加载中…', ''));
      }
      wrap.appendChild(modelCard);

      /* 记忆系统 */
      wrap.appendChild(groupTitle('记忆系统'));
      const memCard = el('div.settings-card');
      if (cfg) {
        memCard.appendChild(row('上下文硬上限', `${(cfg.limits?.context_max_tokens || 200000).toLocaleString()} tokens`, '装配提示词的绝对上限'));
        memCard.appendChild(row('保留原始回合', String(cfg.defaults?.recent_raw_turns ?? 4), '上下文中逐字保留的最近回合数'));
        memCard.appendChild(row('弧摘要节奏', `每 ${cfg.defaults?.arc_every ?? 5} 轮`, 'L1 轮摘要压缩为 L2 弧摘要'));
        memCard.appendChild(row('史诗摘要节奏', `每 ${cfg.defaults?.saga_every ?? 5} 弧`, 'L2 压缩为 L3 史诗摘要'));
        memCard.appendChild(row('单轮生成上限', `${(cfg.limits?.narrator_max_tokens || 12000).toLocaleString()} tokens`, '剧情演绎单轮最大生成量'));
      } else {
        memCard.appendChild(row('配置', '加载中…', ''));
      }
      wrap.appendChild(memCard);

      /* API */
      wrap.appendChild(groupTitle('API 接入'));
      const apiCard = el('div.settings-card');
      apiCard.appendChild(el('div.settings-row', {},
        rowBody('OpenAI 兼容接口', '任何支持 OpenAI 协议的客户端均可接入'),
        el('button.btn-tinted', {
          type: 'button', onclick: () => openSheet({
            title: 'OpenAI 兼容接入',
            render(body) {
              body.appendChild(el('div', { style: 'padding:4px 4px 12px;font-size:14px;line-height:1.7;color:var(--label-secondary);' },
                '在本服务地址后追加 /v1 即可作为 OpenAI 兼容端点使用：',
              ));
              body.appendChild(codeBlock(`Base URL  ${location.origin}/v1\nAPI Key   任意非空字符串\nModel     ${cfg?.models?.default || 'step-5-preview'}`));
              body.appendChild(el('div', { style: 'padding:14px 4px 4px;font-size:14px;line-height:1.7;color:var(--label-secondary);' },
                '角色扮演模式：请求体中附加 ',
                el('code', { style: 'background:var(--fill);padding:1px 6px;border-radius:5px;font-size:12.5px;' }, 'session_id'),
                ' 字段即进入多 Agent 管线（记忆 + 分支 + 演绎）。',
              ));
              body.appendChild(codeBlock(`{\n  "model": "${cfg?.models?.default || 'step-5-preview'}",\n  "session_id": "new",\n  "settings": { "title": "…", "worldview": "…" },\n  "messages": [{ "role": "user", "content": "我的行动" }],\n  "stream": true\n}`));
            },
          }),
        }, '查看'),
      ));
      wrap.appendChild(apiCard);

      /* 关于 */
      wrap.appendChild(groupTitle('关于'));
      const aboutCard = el('div.settings-card');
      aboutCard.appendChild(row('版本', 'v1.0.0', 'AI 角色剧场'));
      aboutCard.appendChild(row('技术栈', 'Node.js + SQLite', '原生 ESM 前端，无构建'));
      aboutCard.appendChild(row('上游服务', 'StepFun step_plan', 'OpenAI 兼容协议'));
      wrap.appendChild(aboutCard);

      wrap.appendChild(el('div', {
        style: 'text-align:center;font-size:12px;color:var(--label-tertiary);padding:8px 0 4px;line-height:1.6;',
      }, 'AI 角色剧场 · 多 Agent 协同记忆系统', el('br'), '每一轮剧情，都由你选择走向'));

      scroll.appendChild(wrap);
    }

    function renderTheme() {
      const seg = $('.segmented', scroll);
      if (!seg) return;
      $$('.segmented-item', seg).forEach(item => {
        item.classList.toggle('is-active', item.dataset.value === ui.get().theme);
      });
    }

    render();

    api.getConfig().then(c => { cfg = c; render(); }).catch(() => {});

    return { unmount() {} };
  },
};

/* ---------------- 组件工具 ---------------- */

function groupTitle(text) {
  return el('div.settings-group-title', {}, text);
}

function rowBody(label, desc) {
  return el('div.settings-row-body', {},
    el('div.settings-row-label', {}, label),
    desc ? el('div.settings-row-desc', {}, desc) : null,
  );
}

function row(label, value, desc) {
  return el('div.settings-row', {}, rowBody(label, desc), el('div.settings-row-value', {}, value));
}

function segmented(options, current, onChange) {
  const wrap = el('div.segmented');
  for (const [value, label] of options) {
    wrap.appendChild(el('button.segmented-item', {
      type: 'button',
      class: value === current ? 'is-active' : '',
      dataset: { value },
      onclick: () => onChange(value),
    }, label));
  }
  return wrap;
}

function codeBlock(text) {
  const pre = el('pre', {
    style: 'margin:8px 0;padding:12px 14px;border-radius:12px;background:var(--fill);font-size:12.5px;line-height:1.7;overflow-x:auto;white-space:pre;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--label);',
  }, text);
  return pre;
}
