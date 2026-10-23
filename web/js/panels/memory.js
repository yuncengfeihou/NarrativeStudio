/**
 * panels/memory.js — 记忆系统面板
 *
 * 五个分区（分段切换，避免一次塞太多）：
 *  概览 · 分层 · 档案 · 状态 · 笔记
 *
 * 设计取向：记忆系统是这套产品的核心卖点，但用户不需要理解架构。
 * 所以每个数字都配一句「这意味着什么」的中文说明，并把可操作项（固定、删除、
 * 新增笔记、修正状态）直接放在对应条目上，而不是另设一个「高级」入口。
 */

import {
  el, clear, fmtTokens, fmtPercent, fmtNumber, truncate, debounce,
} from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { openSheet, toast, confirmDialog } from '../app.js';

/* =========================================================================
 * 环形进度
 * ========================================================================= */

let ringSeq = 0;

/**
 * @param {number} ratio 0-1
 * @param {{size?:number, stroke?:number, center?:string, centerSize?:string, sub?:string}} [opts]
 * @returns {HTMLElement}
 */
export function buildRing(ratio, opts = {}) {
  const { size = 88, stroke = 8, center = null, centerSize = null, sub = null } = opts;
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0));
  const R = 42;
  const C = 2 * Math.PI * R;
  const gid = `rg${++ringSeq}`;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'ring');
  svg.style.transform = 'rotate(-90deg)';

  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id', gid);
  grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
  grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '100%');
  for (const [cls, offset] of [['stop-a', '0%'], ['stop-b', '55%'], ['stop-c', '100%']]) {
    const s = document.createElementNS(NS, 'stop');
    s.setAttribute('class', cls);
    s.setAttribute('offset', offset);
    grad.appendChild(s);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);

  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('class', 'ring-track');
  track.setAttribute('cx', '50'); track.setAttribute('cy', '50');
  track.setAttribute('r', String(R));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke-width', String(stroke));
  svg.appendChild(track);

  const val = document.createElementNS(NS, 'circle');
  val.setAttribute('class', 'ring-value');
  val.setAttribute('cx', '50'); val.setAttribute('cy', '50');
  val.setAttribute('r', String(R));
  val.setAttribute('fill', 'none');
  val.setAttribute('stroke', `url(#${gid})`);
  val.setAttribute('stroke-width', String(stroke));
  val.setAttribute('stroke-linecap', 'round');
  val.setAttribute('stroke-dasharray', C.toFixed(2));
  val.setAttribute('stroke-dashoffset', (C * (1 - pct)).toFixed(2));
  svg.appendChild(val);

  const wrap = el('div.ring-wrap', { style: `width:${size}px;height:${size}px;` }, svg);
  if (center != null || sub != null) {
    wrap.appendChild(el('div.ring-center', {},
      center != null ? el('div.ring-pct', { style: centerSize ? `font-size:${centerSize};` : '' }, center) : null,
      sub != null ? el('div.ring-sub', {}, sub) : null,
    ));
  }
  return wrap;
}

/* =========================================================================
 * 元数据
 * ========================================================================= */

const ENTITY_META = {
  character: { icon: 'user', color: 'var(--blue)', label: '角色' },
  item: { icon: 'key', color: 'var(--orange)', label: '物品' },
  location: { icon: 'mapPin', color: 'var(--green)', label: '地点' },
  faction: { icon: 'flag', color: 'var(--purple)', label: '势力' },
  event: { icon: 'bolt', color: 'var(--red)', label: '事件' },
  concept: { icon: 'lightbulb', color: 'var(--teal)', label: '概念' },
};

const TIERS = [
  { level: 1, name: 'L1 轮摘要', short: '单轮', color: 'var(--blue)', desc: '每一回合的压缩快照' },
  { level: 2, name: 'L2 篇章', short: '篇章', color: 'var(--purple)', desc: '每 5 回合合并为一段' },
  { level: 3, name: 'L3 史诗', short: '史诗', color: 'var(--orange)', desc: '每 5 篇章合并为一幕' },
  { level: 4, name: 'L4 编年史', short: '编年', color: 'var(--red)', desc: '每 5 幕合并为一卷' },
];

const NOTE_KINDS = [
  { value: 'note', label: '补充设定' },
  { value: 'rule', label: '硬性规则' },
  { value: 'foreshadow', label: '待回收伏笔' },
  { value: 'retcon', label: '覆盖记忆' },
];

const BUDGET_ROWS = [
  { key: 'settings', name: '设定与角色卡', color: 'var(--indigo)' },
  { key: 'notes', name: '作者笔记', color: 'var(--pink)' },
  { key: 'state', name: '剧情状态', color: 'var(--teal)' },
  { key: 'summaries', name: '分层记忆', color: 'var(--purple)' },
  { key: 'retrieval', name: '历史检索', color: 'var(--green)' },
  { key: 'recent_raw', name: '最近原文', color: 'var(--blue)' },
];

/* =========================================================================
 * 面板入口
 * ========================================================================= */

/**
 * 打开记忆面板。
 * @param {string} sessionId
 * @param {{onUpdate?:(stats:object)=>void}} [opts]
 */
export async function openMemoryPanel(sessionId, opts = {}) {
  const { onUpdate } = opts;
  let data = null;
  let tab = 'overview';

  const handle = openSheet({
    title: '记忆系统',
    cancelText: '完成',
    render(body) {
      body.appendChild(el('div', { style: 'padding:40px 0;text-align:center;' },
        el('span.spinner')));
      load(body);
    },
  });

  async function load(body) {
    try {
      data = await api.getMemory(sessionId);
      onUpdate?.(data);
    } catch (err) {
      clear(body);
      body.appendChild(el('div.empty', {},
        el('div.empty-icon', {}, icon('warn', { size: 24 })),
        el('div.empty-title', {}, '无法读取记忆'),
        el('div.empty-sub', {}, err.message),
      ));
      return;
    }
    paint(body);
  }

  function paint(body) {
    clear(body);
    const root = el('div.mem');

    // 分段导航
    const tabs = [
      ['overview', '概览'],
      ['tiers', '分层'],
      ['archive', '档案'],
      ['state', '状态'],
      ['notes', '笔记'],
    ];
    const tabBar = el('div.mem-tabs');
    for (const [key, label] of tabs) {
      tabBar.appendChild(el('button.mem-tab', {
        type: 'button',
        class: tab === key ? 'is-active' : '',
        onclick: (e) => {
          tab = key;
          Array.from(tabBar.children).forEach((c, i) => c.classList.toggle('is-active', tabs[i][0] === key));
          Array.from(root.querySelectorAll('.mem-pane')).forEach((p) => {
            p.classList.toggle('is-active', p.dataset.pane === key);
          });
        },
      }, label));
    }
    root.appendChild(tabBar);

    root.appendChild(pane('overview', tab, overviewPane()));
    root.appendChild(pane('tiers', tab, tiersPane()));
    root.appendChild(pane('archive', tab, archivePane(body)));
    root.appendChild(pane('state', tab, statePane(body)));
    root.appendChild(pane('notes', tab, notesPane(body)));

    body.appendChild(root);
  }

  function pane(name, active, content) {
    return el('div.mem-pane', { class: active === name ? 'is-active' : '', dataset: { pane: name } }, content);
  }

  /* ---------------------------------------------------------------------
   * 概览
   * ------------------------------------------------------------------ */
  function overviewPane() {
    const max = Number(data.context_max) || 200000;
    const used = Number(data.context_tokens) || 0;
    const ratio = max > 0 ? Math.min(1, used / max) : 0;

    const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:16px;' });

    wrap.appendChild(el('div.mem-hero', {},
      buildRing(ratio, {
        size: 88, stroke: 8,
        center: fmtPercent(ratio),
        sub: `${fmtTokens(used)}/${fmtTokens(max)}`,
      }),
      el('div.mem-hero-info', {},
        el('div.mem-hero-title', {}, occupancyTitle(ratio)),
        el('div.mem-hero-note', {}, occupancyNote(ratio, used, max)),
        el('div.mem-hero-chips', {},
          el('span.chip.is-tint', {}, `${fmtNumber(data.turn_count)} 回合`),
          el('span.chip', {}, `${fmtNumber(data.entities?.length || 0)} 实体`),
          el('span.chip', {}, `${fmtNumber(data.facts?.length || 0)} 事实`),
          el('span.chip.is-purple', {}, `${fmtNumber(data.notes?.length || 0)} 笔记`),
        ),
      ),
    ));

    // 压缩比说明
    if (data.raw_tokens > 0) {
      wrap.appendChild(el('div', {
        style: 'display:flex;align-items:center;gap:11px;padding:13px 15px;border-radius:var(--r-md);background:var(--tint-softer);',
      },
        el('span', { style: 'display:flex;color:var(--tint);flex:none;' }, icon('layers', { size: 20 })),
        el('div', { style: 'flex:1;min-width:0;' },
          el('div', { style: 'font-size:var(--fs-footnote);font-weight:650;' },
            `记忆压缩了 ${data.compression || 1} 倍`),
          el('div', { style: 'font-size:var(--fs-caption);color:var(--label-secondary);line-height:1.5;margin-top:2px;' },
            `原始剧情 ${fmtTokens(data.raw_tokens)} tok，现在只占 ${fmtTokens(used)} tok 的上下文。`),
        ),
      ));
    }

    // 预算分布
    const b = data.budget || {};
    const rows = BUDGET_ROWS
      .map((r) => ({ ...r, value: Number(b[r.key]) || 0 }))
      .filter((r) => r.value > 0);
    const total = rows.reduce((s, r) => s + r.value, 0) || 1;

    if (rows.length) {
      wrap.appendChild(el('div', {},
        el('div.mem-sec-title', { style: 'margin-bottom:9px;' }, '上下文预算构成'),
        el('div.budget-list', {},
          ...rows.map((r) => el('div.budget-row', {},
            el('span.budget-name', {}, r.name),
            el('span.budget-bar', {},
              el('span.budget-fill', {
                style: `width:${Math.max(2, (r.value / total) * 100).toFixed(1)}%;background:${r.color};`,
              }),
            ),
            el('span.budget-val', {}, fmtTokens(r.value)),
          )),
        ),
      ));
    }

    // 本轮检索
    const retrieval = Array.isArray(data.last_retrieval) ? data.last_retrieval : [];
    wrap.appendChild(el('div', {},
      el('div.mem-sec-title', { style: 'margin-bottom:9px;' }, `本轮检索命中（${retrieval.length}）`),
      retrieval.length
        ? el('div.retrieval-list', {}, ...retrieval.map(retrievalCard))
        : el('div', {
          style: 'padding:16px;border-radius:var(--r-md);background:var(--surface);border:1px solid var(--sep);font-size:var(--fs-footnote);color:var(--label-tertiary);text-align:center;line-height:1.6;',
        }, '本回合没有召回历史细节。', el('br'), '发生新事件或玩家行动涉及旧线索时，这里会显示命中的档案片段。'),
    ));

    return wrap;
  }

  function occupancyTitle(ratio) {
    if (ratio >= 0.9) return '上下文接近上限';
    if (ratio >= 0.7) return '上下文偏紧';
    if (ratio >= 0.35) return '上下文健康';
    return '上下文宽裕';
  }

  function occupancyNote(ratio, used, max) {
    const left = Math.max(0, max - used);
    if (ratio >= 0.9) return `已用 ${fmtPercent(ratio)}，更早的剧情会被更强地压缩，但不会丢失。`;
    if (ratio >= 0.7) return `已用 ${fmtPercent(ratio)}，系统会优先保留近期回合与固定档案。`;
    if (ratio >= 0.35) return `还剩 ${fmtTokens(left)} tok 余量，可以放心推进很久。`;
    return `还剩 ${fmtTokens(left)} tok 余量，相当于约 ${Math.floor(left / 2800)} 个回合。`;
  }

  function retrievalCard(h) {
    const meta = {
      turn: { label: '原文', color: 'var(--green)' },
      summary: { label: '摘要', color: 'var(--blue)' },
      entity: { label: '档案', color: 'var(--purple)' },
    }[h.kind] || { label: '历史', color: 'var(--gray)' };

    const src = h.kind === 'turn' ? `第 ${h.turn_no} 回合`
      : h.kind === 'summary' ? `第 ${h.turn_from}-${h.turn_to} 回合`
        : h.kind === 'entity' ? `档案 · ${h.name || ''}`
          : '历史';

    return el('div.retrieval', {},
      el('div.retrieval-head', {},
        el('span.retrieval-kind', { style: `background:${meta.color};` }, meta.label),
        el('span.retrieval-src', {}, src),
        el('span.retrieval-score', {}, `相关度 ${(Number(h.score) || 0).toFixed(2)}`),
      ),
      el('div.retrieval-text', {}, truncate(h.snippet || '', 150)),
    );
  }

  /* ---------------------------------------------------------------------
   * 分层
   * ------------------------------------------------------------------ */
  function tiersPane() {
    const tiers = normalizeTiers(data.tiers);
    const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:16px;' });

    const totalTokens = tiers.reduce((s, t) => s + t.tokens, 0);
    const totalCount = tiers.reduce((s, t) => s + t.count, 0);

    wrap.appendChild(el('div', {},
      el('div.mem-sec-title', { style: 'margin-bottom:9px;' },
        '四层记忆',
        el('span.spacer'),
        el('span', { style: 'text-transform:none;letter-spacing:0;font-weight:500;' },
          `${fmtNumber(totalCount)} 条 · ${fmtTokens(totalTokens)} tok`),
      ),
      el('div.tier-block', {},
        el('div.tier-bar', {},
          ...tiers.map((t) => {
            const share = totalTokens > 0 ? t.tokens / totalTokens : (t.count > 0 ? t.count / totalCount : 0.25);
            return el('div.tier-seg', {
              style: `flex:${Math.max(share, 0.001)} 1 0;background:${tierColor(t.level)};`,
              title: `${tierName(t.level)} · ${t.count} 条`,
            }, t.count > 0 ? String(t.count) : '');
          }),
        ),
        el('div.tier-rows', {},
          ...tiers.map((t) => el('div.tier-row', {},
            el('span.tier-dot', { style: `background:${tierColor(t.level)};` }),
            el('span.tier-name', {},
              tierName(t.level),
              el('small', {}, tierDesc(t.level)),
            ),
            el('span.tier-stat', {},
              `${fmtNumber(t.count)} 条`,
              el('br'),
              fmtTokens(t.tokens),
            ),
          )),
        ),
      ),
      el('div.group-note', {},
        '低层记录细节，高层保留全局。回合数增长时，旧的低层摘要会被自动合并到高层，' +
        '所以剧情可以无限推进而上下文不会爆掉。'),
    ));

    // 归档统计
    const archived = Array.isArray(data.archived_tiers) ? data.archived_tiers : [];
    const archiveTotal = archived.reduce((s, t) => s + (t.count || 0), 0);
    if (archiveTotal > 0) {
      wrap.appendChild(el('div.group-card', {},
        el('div.li', {},
          el('div.li-icon', {}, icon('layers', { size: 15 })),
          el('div.li-body', {},
            el('div.li-title', {}, '已归档摘要'),
            el('div.li-sub', {}, '被高层吸收后仍保留在数据库中，检索时可以命中'),
          ),
          el('div.li-value', {}, `${fmtNumber(archiveTotal)} 条 · ${fmtTokens(data.archive_tokens || 0)}`),
        ),
      ));
    }

    return wrap;
  }

  /* ---------------------------------------------------------------------
   * 档案（实体 + 事实）
   * ------------------------------------------------------------------ */
  function archivePane(body) {
    const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:16px;' });
    const entities = Array.isArray(data.entities) ? data.entities : [];
    const facts = Array.isArray(data.facts) ? data.facts : [];

    // 按类型分组
    const groups = new Map();
    for (const e of entities) {
      if (!groups.has(e.type)) groups.set(e.type, []);
      groups.get(e.type).push(e);
    }

    wrap.appendChild(el('div.mem-sec-title', {},
      `实体档案（${entities.length}）`,
      el('span.spacer'),
      el('button.mem-sec-action', { type: 'button', onclick: () => openAddFact(body) }, '+ 新增事实'),
    ));

    if (!entities.length) {
      wrap.appendChild(el('div.empty', {},
        el('div.empty-icon', {}, icon('users', { size: 22 })),
        el('div.empty-title', {}, '还没有实体档案'),
        el('div.empty-sub', {}, '开始演绎后，出现的角色、地点、物品会被自动收录进来。'),
      ));
    } else {
      for (const [type, list] of groups) {
        const meta = ENTITY_META[type] || { icon: 'info', color: 'var(--gray)', label: type };
        wrap.appendChild(el('div', {},
          el('div.mem-sec-title', { style: 'margin-bottom:7px;' },
            `${meta.label}（${list.length}）`,
          ),
          el('div.group-card', {},
            ...list.map((e) => entityRow(e, body)),
          ),
        ));
      }
    }

    // 事实
    wrap.appendChild(el('div', {},
      el('div.mem-sec-title', { style: 'margin-bottom:7px;' }, `事实关系（${facts.length}）`),
      facts.length
        ? el('div.group-card', {}, ...facts.map((f) => factRow(f, body)))
        : el('div.group-card', {}, el('div.li', {},
          el('div.li-body', {}, el('div.li-sub', {}, '还没有记录事实三元组')),
        )),
    ));

    return wrap;
  }

  function entityRow(e, body) {
    const meta = ENTITY_META[e.type] || { icon: 'info', color: 'var(--gray)' };
    return el('div.ent', {},
      el('div.ent-icon', { style: `background:${meta.color};` }, icon(meta.icon, { size: 15 })),
      el('div.ent-body', {},
        el('div.ent-name', {},
          e.name || '未命名',
          e.pinned ? el('span.chip.is-orange', { style: 'font-size:10px;padding:0 5px;' }, '固定') : null,
          e.mention_count > 1 ? el('span', { style: 'font-size:10px;color:var(--label-tertiary);font-weight:500;' }, `×${e.mention_count}`) : null,
        ),
        e.summary ? el('div.ent-sum', {}, truncate(e.summary, 110)) : null,
      ),
      el('div.ent-actions', {},
        el('button.ent-pin', {
          type: 'button', class: e.pinned ? 'is-on' : '',
          title: e.pinned ? '取消固定' : '固定（优先进入上下文）',
          onclick: async (ev) => {
            ev.stopPropagation();
            try {
              await api.updateEntity(sessionId, e.id, { pinned: !e.pinned });
              e.pinned = !e.pinned;
              reload();
            } catch (err) { toast(err.message, { type: 'error' }); }
          },
        }, icon('pin', { size: 13 })),
        el('button.ent-pin', {
          type: 'button', title: '删除这条档案',
          onclick: async (ev) => {
            ev.stopPropagation();
            const ok = await confirmDialog({
              title: '删除档案',
              message: `「${e.name}」将从记忆中移除，后续演绎不再主动引用。`,
              confirmText: '删除', destructive: true,
            });
            if (!ok) return;
            try {
              await api.deleteEntity(sessionId, e.id);
              toast('已删除', { type: 'success' });
              reload();
            } catch (err) { toast(err.message, { type: 'error' }); }
          },
        }, icon('trash', { size: 13 })),
      ),
    );
  }

  function factRow(f, body) {
    return el('div.fact', { class: f.status === 'retracted' ? 'is-retracted' : '' },
      el('span.fact-s', {}, f.subject),
      el('span.fact-p', {}, f.predicate),
      el('span.fact-o', {}, f.object),
      el('button.ent-pin', {
        type: 'button', class: f.pinned ? 'is-on' : '',
        title: f.pinned ? '取消固定' : '固定',
        onclick: async () => {
          try {
            await api.updateFact(sessionId, f.id, { pinned: !f.pinned });
            f.pinned = !f.pinned;
            reload();
          } catch (err) { toast(err.message, { type: 'error' }); }
        },
      }, icon('pin', { size: 12 })),
      el('button.ent-pin', {
        type: 'button', title: '撤回这条事实',
        onclick: async () => {
          try {
            await api.deleteFact(sessionId, f.id);
            toast('已撤回', { type: 'success' });
            reload();
          } catch (err) { toast(err.message, { type: 'error' }); }
        },
      }, icon('close', { size: 12 })),
    );
  }

  function openAddFact(body) {
    const s = el('input.field', { placeholder: '主体（例如：伍卿）' });
    const p = el('input.field', { placeholder: '关系（例如：左腿有旧疾）' });
    const o = el('input.field', { placeholder: '客体（例如：不能奔跑）' });
    openSheet({
      title: '新增事实',
      confirmText: '添加',
      render(b) {
        b.appendChild(el('div', { style: 'padding:12px 16px;display:flex;flex-direction:column;gap:10px;' },
          s, p, o,
          el('div.field-hint', {}, '作者钦定的事实在每轮演绎中都会作为「已确证」提供给引擎，优先级高于自动记忆。'),
        ));
        setTimeout(() => s.focus(), 220);
      },
      async onConfirm() {
        if (!s.value.trim() || !p.value.trim() || !o.value.trim()) {
          toast('三项都要填');
          return false;
        }
        try {
          await api.addFact(sessionId, {
            subject: s.value.trim(), predicate: p.value.trim(), object: o.value.trim(),
          });
          toast('已添加', { type: 'success' });
          reload();
        } catch (err) {
          toast(err.message, { type: 'error' });
          return false;
        }
        return true;
      },
    });
  }

  /* ---------------------------------------------------------------------
   * 状态
   * ------------------------------------------------------------------ */
  function statePane(body) {
    const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:14px;' });
    const st = data.state;
    const turn = data.state_turn;

    wrap.appendChild(el('div.mem-sec-title', {},
      `剧情状态${turn ? `（第 ${turn} 回合快照）` : ''}`,
      el('span.spacer'),
      el('button.mem-sec-action', { type: 'button', onclick: () => editState(body) }, '修正'),
    ));

    if (!st || !Object.keys(st).length) {
      wrap.appendChild(el('div.empty', {},
        el('div.empty-icon', {}, icon('compass', { size: 22 })),
        el('div.empty-title', {}, '还没有状态快照'),
        el('div.empty-sub', {}, '演绎一轮之后，时间、地点、人物状态会被自动记录在这里。'),
      ));
      return wrap;
    }

    const cells = [];
    const cell = (key, val, full = false, long = false) => {
      if (val == null || val === '') return;
      cells.push(el('div.state-cell', { class: full ? 'is-full' : '' },
        el('div.state-key', {}, key),
        typeof val === 'string'
          ? el('div.state-val', { class: long ? 'is-long' : '' }, val)
          : val,
      ));
    };

    cell('时间', st.time, false, false);
    cell('地点', st.location, false, false);
    // 天气单独占一行（补满双列会产生空格子，视觉上很脏）
    if (st.weather) {
      cells.push(el('div.state-cell.is-full', {},
        el('div.state-key', {}, '天气'),
        el('div.state-val', {}, st.weather),
      ));
    }

    if (typeof st.tension === 'number') {
      cells.push(el('div.state-cell.is-full', {},
        el('div.state-key', {}, '剧情张力'),
        el('div.tension', {},
          el('div.tension-track', {},
            el('div.tension-fill', { style: `width:${Math.round(Math.max(0, Math.min(1, st.tension)) * 100)}%;` }),
          ),
          el('span.tension-val', {}, fmtPercent(st.tension)),
        ),
      ));
    }

    if (st.characters && typeof st.characters === 'object' && Object.keys(st.characters).length) {
      const rows = el('div', { style: 'display:flex;flex-direction:column;gap:5px;margin-top:4px;' });
      for (const [name, info] of Object.entries(st.characters)) {
        const bits = [];
        if (info?.mood) bits.push(info.mood);
        if (info?.status) bits.push(info.status);
        if (info?.location) bits.push(`@${info.location}`);
        rows.appendChild(el('div', { style: 'font-size:var(--fs-footnote);line-height:1.5;' },
          el('span', { style: 'font-weight:650;' }, name),
          bits.length ? el('span', { style: 'color:var(--label-secondary);' }, ` · ${bits.join(' · ')}`) : null,
        ));
      }
      cell('人物', rows, true);
    }

    if (Array.isArray(st.inventory) && st.inventory.length) {
      cell('携带物品', st.inventory.join('、'), true, true);
    }

    if (Array.isArray(st.quests) && st.quests.length) {
      const list = el('div', { style: 'display:flex;flex-direction:column;gap:2px;margin-top:3px;' },
        ...st.quests.map((q) => el('div.quest', {},
          el('span.quest-mark', { style: `color:${q.status === 'done' ? 'var(--green)' : q.status === 'failed' ? 'var(--red)' : 'var(--blue)'};` },
            q.status === 'done' ? '✓' : q.status === 'failed' ? '✕' : '▸'),
          el('span', {},
            q.goal || '未命名目标',
            q.progress ? el('span.quest-prog', {}, ` · ${q.progress}`) : null,
          ),
        )),
      );
      cell('目标', list, true);
    }

    if (Array.isArray(st.threads) && st.threads.length) {
      cell('未解线索', st.threads.join('；'), true, true);
    }
    if (st.last_hook) {
      cell('悬念钩子', st.last_hook, true, true);
    }

    wrap.appendChild(el('div.state-grid', {}, ...cells));

    wrap.appendChild(el('div.group-note', {},
      '状态快照是每一轮演绎的起点。如果发现时间、地点或物品对不上，可以手动修正。'));

    return wrap;
  }

  function editState(body) {
    const st = data.state || {};
    const fields = [
      ['time', '时间'],
      ['location', '地点'],
      ['weather', '天气'],
      ['last_hook', '悬念钩子'],
    ];
    const inputs = {};
    let inv = null;
    let th = null;
    let ten = null;

    openSheet({
      title: '修正剧情状态',
      confirmText: '保存',
      render(b) {
        const wrap = el('div', { style: 'padding:12px 16px;display:flex;flex-direction:column;gap:11px;' });
        for (const [key, label] of fields) {
          const inp = el('input.field', { value: st[key] || '', placeholder: label });
          inputs[key] = inp;
          wrap.appendChild(el('div', {}, el('label.field-label', {}, label), inp));
        }

        inv = el('textarea.field', { rows: 3, placeholder: '物品，用顿号或换行分隔' });
        inv.value = Array.isArray(st.inventory) ? st.inventory.join('、') : '';
        wrap.appendChild(el('div', {}, el('label.field-label', {}, '携带物品'), inv));

        th = el('textarea.field', { rows: 3, placeholder: '未解线索，用换行分隔' });
        th.value = Array.isArray(st.threads) ? st.threads.join('\n') : '';
        wrap.appendChild(el('div', {}, el('label.field-label', {}, '未解线索'), th));

        ten = el('input.field', {
          type: 'range', min: 0, max: 1, step: 0.05,
          style: 'padding:0;background:transparent;border:none;box-shadow:none;',
        });
        ten.value = String(typeof st.tension === 'number' ? st.tension : 0.4);
        const tenVal = el('span', { style: 'font-size:var(--fs-caption);color:var(--label-secondary);font-variant-numeric:tabular-nums;' },
          fmtPercent(ten.value));
        ten.addEventListener('input', () => { tenVal.textContent = fmtPercent(ten.value); });
        wrap.appendChild(el('div', {},
          el('label.field-label', { style: 'display:flex;justify-content:space-between;align-items:baseline;' },
            el('span', {}, '剧情张力'), tenVal),
          ten,
        ));

        b.appendChild(wrap);
      },
      async onConfirm() {
        const next = { ...st };
        for (const [key] of fields) next[key] = inputs[key].value.trim();
        next.inventory = inv.value.split(/[、,\n]/).map((s) => s.trim()).filter(Boolean);
        next.threads = th.value.split(/\n/).map((s) => s.trim()).filter(Boolean);
        next.tension = Number(ten.value);
        try {
          await api.putState(sessionId, { state: next, turn_no: data.state_turn });
          toast('状态已更新', { type: 'success' });
          reload();
        } catch (err) {
          toast(err.message, { type: 'error' });
          return false;
        }
        return true;
      },
    });
  }

  /* ---------------------------------------------------------------------
   * 笔记
   * ------------------------------------------------------------------ */
  function notesPane(body) {
    const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:12px;' });
    const notes = Array.isArray(data.notes) ? data.notes : [];

    wrap.appendChild(el('div.mem-sec-title', {},
      `作者笔记（${notes.length}）`,
    ));
    wrap.appendChild(el('div.group-note', { style: 'padding:0 0 2px;' },
      '笔记是你亲手写下的确定事实：永不被压缩、永不遗忘，每一轮都会原样交给演绎引擎。'));

    const card = el('div.group-card');
    if (!notes.length) {
      card.appendChild(el('div.li', {},
        el('div.li-body', {}, el('div.li-sub', {},
          '还没有笔记。写下「伍卿左腿有旧疾，跑不快」或「凌玥从不说出自己的真实身份」这类设定，' +
          '引擎会在每次演绎时严格参考。')),
      ));
    } else {
      for (const n of notes) {
        card.appendChild(noteRow(n));
      }
    }

    // 快速新增
    const ta = el('textarea', { rows: 2, placeholder: '写下一条确定的事实或规则…' });
    const kindSel = el('select', {
      style: 'height:34px;padding:0 8px;border-radius:9px;background:var(--surface);border:1px solid var(--sep);font-size:var(--fs-caption);flex:none;',
    }, ...NOTE_KINDS.map((k) => el('option', { value: k.value }, k.label)));

    const addBtn = el('button.btn.btn-primary.btn-sm', {
      type: 'button',
      onclick: async () => {
        const content = ta.value.trim();
        if (!content) return toast('内容不能为空');
        try {
          await api.addNote(sessionId, { content, kind: kindSel.value });
          ta.value = '';
          toast('已添加笔记', { type: 'success' });
          reload();
        } catch (err) { toast(err.message, { type: 'error' }); }
      },
    }, icon('plus', { size: 13 }), '添加');

    const addRow = el('div.note-add', {},
      el('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:7px;' },
        ta,
        el('div', { style: 'display:flex;gap:7px;align-items:center;' }, kindSel, el('span.spacer'), addBtn),
      ),
    );
    card.appendChild(addRow);

    wrap.appendChild(card);
    return wrap;
  }

  function noteRow(n) {
    const kind = NOTE_KINDS.find((k) => k.value === n.kind) || NOTE_KINDS[0];
    return el('div.note-item', { class: n.active ? '' : 'is-off' },
      el('span.note-kind', { dataset: { kind: n.kind } }, kind.label),
      el('div.note-text', {}, n.content),
      el('button.ent-pin', {
        type: 'button',
        title: n.active ? '停用（保留但不注入）' : '重新启用',
        onclick: async () => {
          try {
            await api.updateNote(sessionId, n.id, { active: !n.active });
            reload();
          } catch (err) { toast(err.message, { type: 'error' }); }
        },
      }, icon(n.active ? 'check' : 'refresh', { size: 13 })),
      el('button.note-del', {
        type: 'button', 'aria-label': '删除',
        onclick: async () => {
          try {
            await api.deleteNote(sessionId, n.id);
            toast('已删除', { type: 'success' });
            reload();
          } catch (err) { toast(err.message, { type: 'error' }); }
        },
      }, icon('close', { size: 13 })),
    );
  }

  /* ---------------------------------------------------------------------
   * 刷新
   * ------------------------------------------------------------------ */
  let reloadTimer = null;
  function reload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try {
        data = await api.getMemory(sessionId);
        onUpdate?.(data);
        const body = handle.body;
        paint(body);
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    }, 120);
  }

  return handle;
}

/* =========================================================================
 * 工具
 * ========================================================================= */

function normalizeTiers(raw) {
  const by = new Map();
  (Array.isArray(raw) ? raw : []).forEach((t) => {
    const lv = Number(t.level);
    if (lv >= 1 && lv <= 4) by.set(lv, { level: lv, count: t.count || 0, tokens: t.tokens || 0 });
  });
  return TIERS.map((m) => by.get(m.level) || { level: m.level, count: 0, tokens: 0 });
}

function tierName(level) {
  return TIERS.find((t) => t.level === level)?.name || `L${level}`;
}
function tierColor(level) {
  return TIERS.find((t) => t.level === level)?.color || 'var(--gray)';
}
function tierDesc(level) {
  return TIERS.find((t) => t.level === level)?.desc || '';
}

export default { openMemoryPanel, buildRing };
