/**
 * panels/memory.js — 记忆与上下文面板
 *
 * 六个分区：概览 / 遥测 / 分层 / 档案 / 状态 / 笔记
 *
 * 设计取向：这些数字存在的意义是「让作者知道引擎记得什么」。
 * 所以每一块都配一句解释它在做什么，而不是只给一堆指标。
 */

import {
  el, clear, fmtTokens, fmtPercent, fmtNumber, truncate, fmtDuration,
} from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { openSheet, toast, confirmDialog } from '../app.js';
import {
  buildRing, sessionUsageSummary, usageBar,
} from '../ui-kit.js';

/* =========================================================================
 * 元数据
 * ========================================================================= */

const ENTITY_META = {
  character: { icon: 'user', label: '角色' },
  item: { icon: 'key', label: '物品' },
  location: { icon: 'mapPin', label: '地点' },
  faction: { icon: 'flag', label: '势力' },
  event: { icon: 'bolt', label: '事件' },
  concept: { icon: 'lightbulb', label: '概念' },
};

const TIERS = [
  { level: 1, name: '轮', desc: '每一轮的独立摘要' },
  { level: 2, name: '幕', desc: '每 6 轮合并' },
  { level: 3, name: '卷', desc: '每 4 幕合并' },
  { level: 4, name: '编年', desc: '每 4 卷合并' },
];

const NOTE_KINDS = [
  { value: 'note', label: '补充设定' },
  { value: 'rule', label: '硬性规则' },
  { value: 'foreshadow', label: '待回收伏笔' },
  { value: 'retcon', label: '覆盖记忆' },
];

const BUDGET_ROWS = [
  { key: 'contract', name: '演绎契约' },
  { key: 'world', name: '世界宪章' },
  { key: 'cast', name: '在场人物' },
  { key: 'lore', name: '触发词条' },
  { key: 'scene', name: '场景账本' },
  { key: 'director', name: '导演卡' },
  { key: 'memory', name: '分层记忆' },
  { key: 'retrieval', name: '历史检索' },
  { key: 'recent', name: '最近原文' },
  { key: 'current', name: '本轮输入' },
];

/* =========================================================================
 * 入口
 * ========================================================================= */

export async function openMemoryPanel(sessionId, opts = {}) {
  const { onUpdate, onReset } = opts;
  let data = null;
  let tab = 'overview';

  const handle = openSheet({
    title: '记忆与上下文',
    cancelText: '完成',
    render(body) {
      body.appendChild(el('div', { style: 'padding:40px 0;text-align:center;' }, el('span.spinner')));
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
        el('div.empty-icon', {}, icon('warn', { size: 20 })),
        el('div.empty-title', {}, '无法读取记忆'),
        el('div.empty-sub', {}, err.message),
      ));
      return;
    }
    paint(body);
  }

  function paint(body) {
    clear(body);
    const root = el('div');

    const tabs = [
      ['overview', '概览'],
      ['usage', '遥测'],
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
          root.querySelectorAll('.mem-pane').forEach((p) => {
            p.classList.toggle('is-active', p.dataset.pane === key);
          });
        },
      }, label));
    }
    root.appendChild(tabBar);

    root.appendChild(pane('overview', tab, overviewPane()));
    root.appendChild(pane('usage', tab, usagePane()));
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
    const soft = Number(data.context_soft) || 52000;
    const used = Number(data.context_tokens) || 0;
    const ratio = soft > 0 ? Math.min(1, used / soft) : 0;

    const wrap = el('div');

    wrap.appendChild(el('div.mem-hero', {},
      buildRing(ratio, {
        size: 62, stroke: 5,
        center: `${Math.round(ratio * 100)}%`,
        centerSize: '12px',
      }),
      el('div.mem-hero-info', {},
        el('div.mem-hero-title', {}, occupancyTitle(ratio)),
        el('div.mem-hero-note', {}, occupancyNote(ratio, used, soft)),
        el('div.mem-hero-chips', {},
          el('span.chip.is-plain', {}, `${fmtNumber(data.turn_count)} 轮`),
          el('span.chip.is-plain', {}, `${(data.entities || []).length} 实体`),
          el('span.chip.is-plain', {}, `${(data.relations || []).length} 关系`),
          el('span.chip.is-plain', {}, `${(data.threads || []).length} 线索`),
          el('span.chip.is-plain', {}, `${(data.reflections || []).length} 反思`),
        ),
      ),
    ));

    // 压缩效果
    if (data.raw_tokens > 0) {
      wrap.appendChild(el('div', {
        style: 'display:flex;align-items:center;gap:11px;padding:12px 13px;border-radius:8px;background:var(--accent-soft);border:1px solid var(--accent-border);',
      },
        el('span', { style: 'display:flex;color:var(--accent);flex:none;' }, icon('layers', { size: 17 })),
        el('div', { style: 'flex:1;min-width:0;' },
          el('div', { style: 'font-size:var(--fs-label);font-weight:600;color:var(--accent);' },
            `压缩了 ${data.compression || 1} 倍`),
          el('div', { style: 'font-size:var(--fs-caption);color:var(--ink-2);line-height:1.6;margin-top:2px;' },
            `原始正文 ${fmtTokens(data.raw_tokens)} tok，装配进上下文的是 ${fmtTokens(used)} tok。`),
        ),
      ));
    }

    // 预算构成
    const b = data.last_assembly || {};
    const rows = BUDGET_ROWS
      .map((r) => ({ ...r, value: Number(b[r.name === '演绎契约' ? 'contract' : r.key]) || 0 }))
      .filter((r) => r.value > 0);
    const total = rows.reduce((s, r) => s + r.value, 0) || 1;

    if (rows.length) {
      wrap.appendChild(el('div', {},
        el('div.mem-sec-title', {}, '上一轮的上下文构成'),
        el('div.budget-list', {},
          ...rows.map((r) => el('div.budget-row', {},
            el('span.budget-name', {}, r.name),
            el('span.budget-bar', {},
              el('span.budget-fill', { style: `width:${Math.max(2, (r.value / total) * 100).toFixed(1)}%;` }),
            ),
            el('span.budget-val', {}, fmtTokens(r.value)),
          )),
        ),
        el('div.group-note', { style: 'padding-top:8px;' },
          '每一层都有独立的 token 配额。设定写得再多，也只会撑满「触发词条」这一层，不会挤掉记忆。'),
      ));
    }

    // 在场人物
    const present = data.last_assembly?.cast_present || [];
    if (present.length) {
      wrap.appendChild(el('div', {},
        el('div.mem-sec-title', {}, `本轮在场（${present.length}）`),
        el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;' },
          ...present.map((c) => el('span.chip.is-plain', {}, `${c.name}${c.role ? ` · ${c.role}` : ''}`))),
      ));
    }

    // 触发词条
    const lore = data.last_assembly?.lore_entries || [];
    if (lore.length) {
      wrap.appendChild(el('div', {},
        el('div.mem-sec-title', {}, `本轮触发的词条（${lore.length}）`),
        el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;' },
          ...lore.map((e) => el('span.chip', { class: e.constant ? 'is-accent' : 'is-plain' },
            e.title || `#${e.id}`))),
      ));
    }

    // 记忆检索命中
    const retrieval = Array.isArray(data.last_retrieval) ? data.last_retrieval : [];
    wrap.appendChild(el('div', {},
      el('div.mem-sec-title', {}, `本轮检索命中（${retrieval.length}）`),
      retrieval.length
        ? el('div.retrieval-list', {}, ...retrieval.map(retrievalCard))
        : el('div', {
          style: 'padding:14px;border-radius:8px;background:var(--paper-sunken);border:1px solid var(--line);font-size:var(--fs-caption);color:var(--ink-3);text-align:center;line-height:1.7;',
        }, '这一轮没有召回旧线索。'),
    ));

    return wrap;
  }

  function occupancyTitle(ratio) {
    if (ratio >= 0.9) return '上下文接近软预算';
    if (ratio >= 0.7) return '上下文偏紧';
    if (ratio >= 0.35) return '上下文健康';
    return '上下文宽裕';
  }

  function occupancyNote(ratio, used, soft) {
    const left = Math.max(0, soft - used);
    if (ratio >= 0.9) return `已用到软预算的 ${fmtPercent(ratio)}，更早的剧情会被压得更紧，但不会丢失。`;
    if (ratio >= 0.7) return `已用 ${fmtPercent(ratio)}，系统会优先保住设定层与最近原文。`;
    return `还剩 ${fmtTokens(left)} tok 余量。这是「每轮都会占用」的固定开销，不会随剧情变长而增长。`;
  }

  function retrievalCard(h) {
    const meta = {
      turn: { label: '原文' },
      summary: { label: '摘要' },
      entity: { label: '档案' },
      thread: { label: '线索' },
      reflection: { label: '反思' },
      relation: { label: '关系' },
    }[h.kind] || { label: '历史' };

    const src = h.kind === 'turn' ? `第 ${h.turn_no} 轮`
      : (h.kind === 'summary') ? `第 ${h.turn_from}-${h.turn_to} 轮`
        : h.name ? `${meta.label} · ${h.name}`
          : meta.label;

    return el('div.retrieval', {},
      el('div.retrieval-head', {},
        el('span.retrieval-kind', {}, meta.label),
        el('span.retrieval-src', {}, src),
        el('span.retrieval-score', {}, `相关度 ${(Number(h.score) || 0).toFixed(2)}`),
      ),
      el('div.retrieval-text', {}, truncate(h.snippet || '', 140)),
    );
  }

  /* ---------------------------------------------------------------------
   * 遥测
   * ------------------------------------------------------------------ */
  function usagePane() {
    const wrap = el('div');

    wrap.appendChild(el('div', {},
      el('div.mem-sec-title', {}, '整个剧情会话'),
      sessionUsageSummary(data.usage),
    ));

    wrap.appendChild(el('div.group-note', {},
      '「输入」是每轮装配后发给模型的提示词 token；「输出」是本轮生成的正文字数折算。' +
      '缓存命中率来自上游返回的 prompt_tokens_details —— 命中越高，同样的上下文越便宜。'));

    // 分层配额的当前占用
    const b = data.last_assembly || {};
    if (b && Object.keys(b).length) {
      const rows = BUDGET_ROWS
        .map((r) => ({ ...r, value: Number(b[r.key]) || 0 }))
        .filter((r) => r.value > 0);
      if (rows.length) {
        wrap.appendChild(el('div', {},
          el('div.mem-sec-title', {}, '本轮各层开销'),
          el('div.group-card', {}, ...rows.map((r) => el('div.li', {},
            el('div.li-body', {}, el('div.li-title', { style: 'font-size:var(--fs-caption);' }, r.name)),
            el('div.li-value', {}, `${fmtNumber(r.value)} tok`),
          ))),
        ));
      }
    }

    return wrap;
  }

  /* ---------------------------------------------------------------------
   * 分层
   * ------------------------------------------------------------------ */
  function tiersPane() {
    const tiers = normalizeTiers(data.tiers);
    const wrap = el('div');
    const totalTokens = tiers.reduce((s, t) => s + t.tokens, 0);
    const totalCount = tiers.reduce((s, t) => s + t.count, 0);

    wrap.appendChild(el('div', {},
      el('div.mem-sec-title', {},
        el('span', {}, '四层压缩'),
        el('span', { style: 'margin-left:auto;font-weight:500;letter-spacing:0;text-transform:none;color:var(--ink-4);' },
          `${fmtNumber(totalCount)} 条 · ${fmtTokens(totalTokens)} tok`),
      ),
      el('div.tier-block', {},
        el('div.tier-bar', {},
          ...tiers.map((t) => {
            const share = totalTokens > 0 ? t.tokens / totalTokens : 0.25;
            return el('div.tier-seg', {
              style: `flex:${Math.max(share, 0.001)} 1 0;background:var(--accent);opacity:${0.35 + t.level * 0.14};`,
              title: `${t.name} · ${t.count} 条`,
            }, t.count > 0 ? String(t.count) : '');
          }),
        ),
        el('div.tier-rows', {},
          ...tiers.map((t) => el('div.tier-row', {},
            el('span.tier-dot', { style: `background:var(--accent);opacity:${0.35 + t.level * 0.14};` }),
            el('span.tier-name', {}, `${t.level} · ${t.name}`, el('small', {}, t.desc)),
            el('span.tier-stat', {}, `${fmtNumber(t.count)} 条`, el('br'), fmtTokens(t.tokens)),
          )),
        ),
      ),
      el('div.group-note', {},
        '低层记细节，高层保全局。轮次增长时，旧的低层摘要被合并进高层，' +
        '所以剧情可以无限推进，而上下文不会爆掉。'),
    ));

    const archived = data.archive_tokens || 0;
    if (archived > 0) {
      wrap.appendChild(el('div.group-card', {},
        el('div.li', {},
          el('div.li-icon', {}, icon('layers', { size: 13 })),
          el('div.li-body', {},
            el('div.li-title', { style: 'font-size:var(--fs-caption);' }, '已归档摘要'),
            el('div.li-sub', {}, '被高层吸收后仍留在库里，检索时依然能命中'),
          ),
          el('div.li-value', {}, fmtTokens(archived)),
        ),
      ));
    }

    // 反思
    const refs = data.reflections || [];
    if (refs.length) {
      wrap.appendChild(el('div', {},
        el('div.mem-sec-title', {}, `反思洞察（${refs.length}）`),
        el('div.group-card', {}, ...refs.slice().reverse().map((r) => el('div.li', {
          style: 'align-items:flex-start;padding:9px 12px;',
        },
          el('span.chip', { class: 'is-plain', style: 'flex:none;font-size:9.5px;' },
            { insight: '洞察', relationship: '关系', theme: '主题', rule: '约束' }[r.kind] || '洞察'),
          el('div.li-body', {},
            el('div', { style: 'font-size:var(--fs-caption);line-height:1.7;color:var(--ink-2);' }, r.content),
            el('div.li-sub', {}, `第 ${r.turn_from}–${r.turn_to} 轮`),
          ),
          el('button.ent-pin', {
            type: 'button', title: '删除',
            onclick: async () => {
              await api.deleteReflection(sessionId, r.id);
              reload();
            },
          }, icon('close', { size: 11 })),
        ))),
        el('div.group-note', { style: 'padding-top:8px;' },
          '反思是每 5 轮由引擎回看摘要后提炼的判断——它比摘要更浓缩，用来防止「剧情走形」。'),
      ));
    }

    return wrap;
  }

  /* ---------------------------------------------------------------------
   * 档案
   * ------------------------------------------------------------------ */
  function archivePane(body) {
    const wrap = el('div');
    const entities = Array.isArray(data.entities) ? data.entities : [];
    const facts = Array.isArray(data.facts) ? data.facts : [];
    const relations = Array.isArray(data.relations) ? data.relations : [];
    const threads = Array.isArray(data.threads) ? data.threads : [];

    // 关系账本
    if (relations.length) {
      wrap.appendChild(el('div', {},
        el('div.mem-sec-title', {}, `关系账本（${relations.length}）`),
        el('div.group-card', {}, ...relations.map(relRow)),
      ));
    }

    // 线索账本
    if (threads.length) {
      wrap.appendChild(el('div', {},
        el('div.mem-sec-title', {}, `线索账本（${threads.length}）`),
        el('div.group-card', {}, ...threads.map(threadRow)),
      ));
    }

    // 实体
    wrap.appendChild(el('div.mem-sec-title', {},
      el('span', {}, `实体档案（${entities.length}）`),
      el('span.spacer'),
      el('button.mem-sec-action', { type: 'button', onclick: () => openAddFact(body) }, '+ 新增事实'),
    ));

    if (!entities.length) {
      wrap.appendChild(el('div.empty', { style: 'padding:28px 20px;' },
        el('div.empty-icon', {}, icon('users', { size: 18 })),
        el('div.empty-title', {}, '还没有实体档案'),
        el('div.empty-sub', {}, '演绎几轮之后，出现的角色、地点、物件会被自动收录。'),
      ));
    } else {
      const groups = new Map();
      for (const e of entities) {
        if (!groups.has(e.type)) groups.set(e.type, []);
        groups.get(e.type).push(e);
      }
      for (const [type, list] of groups) {
        const meta = ENTITY_META[type] || { icon: 'info', label: type };
        wrap.appendChild(el('div', { style: 'margin-bottom:12px;' },
          el('div.mem-sec-title', { style: 'margin-bottom:6px;font-size:10px;' }, `${meta.label}（${list.length}）`),
          el('div.group-card', {}, ...list.map((e) => entityRow(e, meta))),
        ));
      }
    }

    // 事实
    wrap.appendChild(el('div', {},
      el('div.mem-sec-title', { style: 'margin-bottom:6px;' }, `事实三元组（${facts.length}）`),
      facts.length
        ? el('div.group-card', {}, ...facts.map(factRow))
        : el('div.group-card', {}, el('div.li', {},
          el('div.li-body', {}, el('div.li-sub', {}, '还没有记录事实')),
        )),
    ));

    return wrap;
  }

  function relRow(r) {
    const s = Number(r.sentiment) || 0;
    const pct = Math.abs(s) * 50;
    return el('div.rel-row', {},
      el('span.rel-pair', {}, `${r.from_name} → ${r.to_name}`),
      r.kind ? el('span.rel-kind', {}, r.kind) : null,
      el('span.rel-note', {}, r.note || ''),
      el('span.rel-meter', {},
        el('span.rel-meter-fill', {
          style: `width:${pct}%;background:${s >= 0 ? 'var(--ok)' : 'var(--danger)'};${s >= 0 ? 'left:50%;' : `right:50%;`}`,
        }),
      ),
    );
  }

  function threadRow(t) {
    const open = t.status === 'open';
    return el('div.thread-row', { class: open ? '' : 'is-done' },
      el('span.thread-mark', { class: open ? 'is-open' : 'is-done' }, open ? '◆' : '✓'),
      el('span.thread-title', {},
        t.title,
        t.note ? el('span.thread-note', {}, t.note) : null,
      ),
      el('button.ent-pin', {
        type: 'button', title: '删除',
        onclick: async () => {
          await api.deleteThread(sessionId, t.id);
          reload();
        },
      }, icon('close', { size: 11 })),
    );
  }

  function entityRow(e, meta) {
    return el('div.ent', {},
      el('div.ent-icon', { style: 'background:var(--ink-3);' }, icon(meta.icon, { size: 12 })),
      el('div.ent-body', {},
        el('div.ent-name', {},
          e.name || '未命名',
          e.pinned ? el('span.chip.is-warn', { style: 'font-size:9px;padding:0 4px;' }, '固定') : null,
          e.mention_count > 1
            ? el('span', { style: 'font-size:9.5px;color:var(--ink-4);font-weight:500;' }, `×${e.mention_count}`)
            : null,
        ),
        e.summary ? el('div.ent-sum', {}, truncate(e.summary, 120)) : null,
      ),
      el('div.ent-actions', {},
        el('button.ent-pin', {
          type: 'button', class: e.pinned ? 'is-on' : '',
          title: e.pinned ? '取消固定' : '固定（优先进入上下文）',
          onclick: async () => {
            await api.updateEntity(sessionId, e.id, { pinned: !e.pinned });
            reload();
          },
        }, icon('pin', { size: 11 })),
        el('button.ent-pin', {
          type: 'button', title: '删除',
          onclick: async () => {
            const ok = await confirmDialog({
              title: '删除档案', message: `「${e.name}」会从记忆中移除。`,
              confirmText: '删除', destructive: true,
            });
            if (!ok) return;
            await api.deleteEntity(sessionId, e.id);
            reload();
          },
        }, icon('trash', { size: 11 })),
      ),
    );
  }

  function factRow(f) {
    return el('div.fact', { class: f.status === 'retracted' ? 'is-retracted' : '' },
      el('span.fact-s', {}, f.subject),
      el('span.fact-p', {}, `—${f.predicate}→`),
      el('span.fact-o', {}, f.object),
      el('button.ent-pin', {
        type: 'button', class: f.pinned ? 'is-on' : '',
        title: f.pinned ? '取消固定' : '固定',
        onclick: async () => {
          await api.updateFact(sessionId, f.id, { pinned: !f.pinned });
          reload();
        },
      }, icon('pin', { size: 10 })),
      el('button.ent-pin', {
        type: 'button', title: '撤回',
        onclick: async () => {
          await api.deleteFact(sessionId, f.id);
          reload();
        },
      }, icon('close', { size: 10 })),
    );
  }

  function openAddFact(body) {
    const s = el('input.field', { placeholder: '主体（例如：伍卿）' });
    const p = el('input.field', { placeholder: '关系（例如：左腿有旧疾）' });
    const o = el('input.field', { placeholder: '客体（例如：跑不快）' });
    openSheet({
      title: '新增事实',
      confirmText: '添加',
      render(b) {
        b.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:10px;' },
          s, p, o,
          el('div.field-hint', {}, '作者钦定的事实在每一轮都会作为「已确证」交给引擎，优先级高于自动记忆。'),
        ));
        setTimeout(() => s.focus(), 200);
      },
      async onConfirm() {
        if (!s.value.trim() || !p.value.trim() || !o.value.trim()) {
          toast('三项都要填');
          return false;
        }
        await api.addFact(sessionId, {
          subject: s.value.trim(), predicate: p.value.trim(), object: o.value.trim(),
        });
        toast('已添加', { type: 'success' });
        reload();
        return true;
      },
    });
  }

  /* ---------------------------------------------------------------------
   * 状态
   * ------------------------------------------------------------------ */
  function statePane(body) {
    const wrap = el('div');
    const st = data.state;
    const turn = data.state_turn;

    wrap.appendChild(el('div.mem-sec-title', {},
      el('span', {}, `场景账本${turn ? `（第 ${turn} 轮）` : ''}`),
      el('span.spacer'),
      el('button.mem-sec-action', { type: 'button', onclick: () => editState(body) }, '修正'),
    ));

    if (!st || !Object.keys(st).length) {
      wrap.appendChild(el('div.empty', { style: 'padding:28px 20px;' },
        el('div.empty-icon', {}, icon('compass', { size: 18 })),
        el('div.empty-title', {}, '还没有场景快照'),
        el('div.empty-sub', {}, '演绎一轮之后，时间、地点、人物状态会被记录在这里。'),
      ));
      return wrap;
    }

    const cells = [];
    const cell = (key, val, { full = false, long = false } = {}) => {
      if (val == null || val === '') return;
      cells.push(el('div.state-cell', { class: full ? 'is-full' : '' },
        el('div.state-key', {}, key),
        typeof val === 'string'
          ? el('div.state-val', { class: long ? 'is-long' : '' }, val)
          : val,
      ));
    };

    cell('时间', st.time);
    cell('地点', st.location);
    if (st.weather) cell('天气', st.weather, { full: true });

    if (typeof st.tension === 'number') {
      cells.push(el('div.state-cell.is-full', {},
        el('div.state-key', {}, '张力'),
        el('div.tension', {},
          el('div.tension-track', {},
            el('div.tension-fill', { style: `width:${Math.round(Math.max(0, Math.min(1, st.tension)) * 100)}%;` }),
          ),
          el('span.tension-val', {}, fmtPercent(st.tension)),
        ),
      ));
    }

    if (st.characters && typeof st.characters === 'object' && Object.keys(st.characters).length) {
      const rows = el('div', { style: 'display:flex;flex-direction:column;gap:4px;margin-top:3px;' });
      for (const [name, info] of Object.entries(st.characters)) {
        const bits = [];
        if (info?.mood) bits.push(info.mood);
        if (info?.status) bits.push(info.status);
        if (info?.location) bits.push(`@${info.location}`);
        rows.appendChild(el('div', { style: 'font-size:var(--fs-caption);line-height:1.6;' },
          el('span', { style: 'font-weight:600;' }, name),
          bits.length ? el('span', { style: 'color:var(--ink-3);' }, ` · ${bits.join(' · ')}`) : null,
        ));
      }
      cell('人物', rows, { full: true });
    }

    if (Array.isArray(st.inventory) && st.inventory.length) {
      cell('随身', st.inventory.join('、'), { full: true, long: true });
    }
    if (Array.isArray(st.quests) && st.quests.length) {
      const list = el('div', { style: 'display:flex;flex-direction:column;gap:2px;margin-top:3px;' },
        ...st.quests.map((q) => el('div.quest', {},
          el('span.quest-mark', {
            style: `color:${q.status === 'done' ? 'var(--ok)' : q.status === 'failed' ? 'var(--danger)' : 'var(--accent)'};`,
          }, q.status === 'done' ? '✓' : q.status === 'failed' ? '✕' : '▸'),
          el('span', {},
            q.goal || '未命名目标',
            q.progress ? el('span.quest-prog', {}, ` · ${q.progress}`) : null,
          ),
        )),
      );
      cell('目标', list, { full: true });
    }
    if (st.last_hook) cell('悬念钩子', st.last_hook, { full: true, long: true });

    wrap.appendChild(el('div.state-grid', {}, ...cells));
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
    let ten = null;

    openSheet({
      title: '修正场景账本',
      confirmText: '保存',
      render(b) {
        const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:11px;' });
        for (const [key, label] of fields) {
          const inp = el('input.field', { value: st[key] || '', placeholder: label });
          inputs[key] = inp;
          wrap.appendChild(el('div', {}, el('label.field-label', {}, label), inp));
        }

        inv = el('textarea.field', { rows: 2, placeholder: '物品，用顿号分隔' });
        inv.value = Array.isArray(st.inventory) ? st.inventory.join('、') : '';
        wrap.appendChild(el('div', {}, el('label.field-label', {}, '随身'), inv));

        ten = el('input', {
          type: 'range', min: 0, max: 1, step: 0.05,
          style: 'width:100%;accent-color:var(--accent);',
        });
        ten.value = String(typeof st.tension === 'number' ? st.tension : 0.4);
        const tenVal = el('span', {
          style: 'font-size:var(--fs-caption);color:var(--ink-3);font-variant-numeric:tabular-nums;',
        }, fmtPercent(ten.value));
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
        next.inventory = inv.value.split(/[、,]/).map((s) => s.trim()).filter(Boolean);
        next.tension = Number(ten.value);
        await api.putState(sessionId, { state: next, turn_no: data.state_turn });
        toast('已更新', { type: 'success' });
        reload();
        return true;
      },
    });
  }

  /* ---------------------------------------------------------------------
   * 笔记
   * ------------------------------------------------------------------ */
  function notesPane(body) {
    const wrap = el('div');
    const notes = Array.isArray(data.notes) ? data.notes : [];

    wrap.appendChild(el('div.mem-sec-title', {}, `作者笔记（${notes.length}）`));
    wrap.appendChild(el('div.group-note', { style: 'padding:0 0 10px;' },
      '笔记是你亲手写下的确定事实：永不压缩、永不遗忘，每一轮都会原样交给引擎。'));

    const card = el('div.group-card');
    if (!notes.length) {
      card.appendChild(el('div.li', {},
        el('div.li-body', {}, el('div.li-sub', {},
          '还没有笔记。像「伍卿左腿有旧疾，跑不快」这样的设定写在这里，引擎每次演绎都会严格遵守。')),
      ));
    } else {
      for (const n of notes) card.appendChild(noteRow(n));
    }

    const ta = el('textarea', { rows: 2, placeholder: '写下一条确定的设定或规则…' });
    const kindSel = el('select', {}, ...NOTE_KINDS.map((k) => el('option', { value: k.value }, k.label)));

    const addBtn = el('button.btn.btn-primary.btn-sm', {
      type: 'button',
      onclick: async () => {
        const content = ta.value.trim();
        if (!content) return toast('内容不能为空');
        await api.addNote(sessionId, { content, kind: kindSel.value });
        toast('已添加', { type: 'success' });
        reload();
      },
    }, icon('plus', { size: 11 }), '添加');

    card.appendChild(el('div.note-add', {},
      ta,
      el('div', { style: 'display:flex;gap:7px;align-items:center;margin-top:7px;' },
        kindSel,
        el('span.spacer'),
        addBtn,
      ),
    ));

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
        title: n.active ? '停用' : '重新启用',
        onclick: async () => {
          await api.updateNote(sessionId, n.id, { active: !n.active });
          reload();
        },
      }, icon(n.active ? 'check' : 'refresh', { size: 11 })),
      el('button.note-del', {
        type: 'button', 'aria-label': '删除',
        onclick: async () => {
          await api.deleteNote(sessionId, n.id);
          toast('已删除', { type: 'success' });
          reload();
        },
      }, icon('close', { size: 11 })),
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
        paint(handle.body);
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
  return TIERS.map((m) => by.get(m.level) || { level: m.level, count: 0, tokens: 0, ...m });
}

export default { openMemoryPanel, buildRing };
