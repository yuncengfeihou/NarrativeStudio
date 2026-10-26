/**
 * server/world/lint.js — 世界卡静态体检（纯函数，不调模型）
 *
 * 只报告、不修改。检查的是「结构能不能被渲染/遍历」与「设定之间有没有硬矛盾」：
 * - 实体 id 冲突、别名冲突、断链、断父、包含环
 * - 从未进入任何关系的孤立实体
 * - future 信息泄漏：标成 past 的事件实际发生在 canon 截止章之后
 * - 单值声明在有效期上重叠且对象不同
 * - 内容充分性：进运行时会不会是空壳（只报 info，不拦保存）
 *
 * v5 是单一实体命名空间（persons + facts），不再有 cast/codex 同名合并，
 * 也不再有 type='character' 的重复分类。
 *
 * 严重度约定：blocker 只给「运行时会出错/身份会打架/后文会漏进前史」的问题
 * （id 冲突、包含环、future 泄漏）；其余一律 info / minor / major。
 * lint 永不修改卡，保存拦截由路由层决定。
 */

import { buildWorldGraph } from './graph.js';
import { renderWorldTree } from './scene-sheet.js';

/**
 * 世界索引的名义容量：与 renderWorldTree 默认 cap 对齐。
 * 运行时实际预算还要先扣掉契约/宪章/前史/主角（本卡实测 cap≈1023），所以真机的
 * 可见实体只少不多——这个检查宁可少报，不制造假警报。
 * 必须用运行期同一个渲染器（tree）：平铺会多算出一批其实能进树的实体。
 */
const INDEX_NOMINAL_TOKENS = 1200;

const stripRef = (v) => String(v || '').trim().replace(/^(?:cast|codex|entity):/, '');
const isPerson = (e) => e?.type === 'person';

/**
 * 从 `ch5` / `ch.5` / `第5章` / 裸数字里取章节号。
 * 只认本项目自己的来源格式（card-smith 写 `chN`，预设同形），不猜作者措辞。
 */
function chapterNo(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  const direct = s.match(/^(?:ch(?:apter)?|第)?[.\s#-]*(\d{1,6})\s*章?$/i);
  if (direct) return Number(direct[1]);
  const prefixed = s.match(/(?:ch(?:apter)?[.\s#-]*|第\s*)(\d{1,6})/i);
  return prefixed ? Number(prefixed[1]) : 0;
}

function overlaps(a, b) {
  const aTo = a.to_turn == null ? Infinity : Number(a.to_turn);
  const bTo = b.to_turn == null ? Infinity : Number(b.to_turn);
  return Number(a.from_turn || 0) < bTo && Number(b.from_turn || 0) < aTo;
}

export function lintCard(card) {
  const issues = [];
  const push = (severity, code, message, extra = {}) => {
    issues.push({ severity, code, message, ...extra });
  };

  const entities = card.entities || [];
  const persons = entities.filter(isPerson);
  const facts = entities.filter((e) => !isPerson(e));
  const graph = buildWorldGraph(card);

  /* ---- 别名冲突：同一别名指向不同实体 ---- */
  const aliasOwner = new Map();
  const addAlias = (alias, id) => {
    const key = String(alias || '').trim();
    if (!key) return;
    const prev = aliasOwner.get(key);
    if (prev && prev.id !== id) {
      push('major', 'alias_collision', `别名「${key}」同时指向 ${prev.id} 与 ${id}`, {
        ids: [prev.id, id],
      });
    } else {
      aliasOwner.set(key, { id });
    }
  };
  for (const e of entities) {
    addAlias(e.name, e.id);
    for (const a of e.aliases || []) addAlias(a, e.id);
  }

  /* ---- 断链 / 断父 / 断关系 ---- */
  const known = new Set();
  for (const e of entities) {
    known.add(e.id); known.add(e.name);
    for (const a of e.aliases || []) known.add(a);
  }

  for (const e of entities) {
    for (const link of e.links || []) {
      if (!known.has(stripRef(link))) {
        push('major', 'broken_link', `「${e.name}」的 links 指向不存在的实体「${link}」`, { ids: [e.id] });
      }
    }
    if (e.parent_id && !known.has(stripRef(e.parent_id))) {
      push('major', 'broken_parent', `「${e.name}」的 parent_id 指向不存在的实体「${e.parent_id}」`, { ids: [e.id] });
    }
  }
  for (const c of persons) {
    for (const r of c.relations || []) {
      if (r.to && !known.has(stripRef(r.to))) {
        push('minor', 'broken_relation', `人物「${c.name}」的关系指向不存在的实体「${r.to}」`, { ids: [c.id] });
      }
    }
  }

  /* ---- 包含环 ---- */
  const parentOf = new Map(entities.map((e) => [e.id, stripRef(e.parent_id)]));
  const reported = new Set();
  for (const e of entities) {
    const path = [];
    let cur = e.id;
    const seen = new Set();
    while (cur && parentOf.get(cur)) {
      if (seen.has(cur)) {
        if (!reported.has(cur)) {
          reported.add(cur);
          push('blocker', 'parent_cycle', `包含关系成环：${[...path, cur].join(' → ')}`, { ids: [cur] });
        }
        break;
      }
      seen.add(cur);
      path.push(cur);
      cur = parentOf.get(cur);
    }
  }

  /* ---- 孤立事实实体：没有边、没钉选、没标签 ---- */
  const incoming = new Set(graph.edges.map((e) => e.to));
  for (const e of facts) {
    if (e.pinned) continue;
    if ((e.links || []).length) continue;
    if (incoming.has(e.id)) continue;
    if ((e.tags || []).length) continue;
    push('info', 'orphan_entity', `「${e.name}」没有任何连接、标签或钉选，可能永远不会自动进场`, { ids: [e.id] });
  }

  /* ---- 内容充分性（info）：进运行时会是空壳的人物/事实，只提示不拦保存 ---- */
  for (const c of persons) {
    const missing = [];
    if (!String(c.identity?.appearance || '').trim()) missing.push('appearance');
    if (!String(c.summary || '').trim()) missing.push('summary');
    if (!String(c.voice?.rhythm || '').trim()) missing.push('rhythm');
    if (missing.length) {
      push('info', 'person_incomplete', `人物「${c.name}」缺少 ${missing.join(' / ')}，进运行时容易变成空壳`, {
        ids: [c.id], missing,
      });
    }
    const wants = c.psyche?.wants || [];
    const hides = c.psyche?.hides || [];
    if (!wants.length && !hides.length) {
      push('info', 'person_hollow', `人物「${c.name}」既没有欲望也没有秘密，演绎时缺少内在驱动`, { ids: [c.id] });
    }
  }
  for (const e of facts) {
    const summary = String(e.summary || '').trim();
    const facets = e.facets || {};
    const hasFacet = [facets.sensory, facets.history].some((v) => String(v || '').trim())
      || (facets.rules || []).length > 0
      || (facets.consequences || []).length > 0;
    if (!summary || !hasFacet) {
      push('info', 'fact_incomplete', `「${e.name}」缺少${summary ? '' : ' summary'}${hasFacet ? '' : ' 细节（facets 全空）'}`, {
        ids: [e.id],
      });
    }
  }

  /* ---- id 冲突（blocker）：graph 用 id 建 Map，重复会互相覆盖 ---- */
  const idOwner = new Map();
  for (const e of entities) {
    const id = String(e.id || '').trim();
    if (!id) continue;
    if (idOwner.has(id)) {
      push('blocker', 'duplicate_id', `实体 id 重复：「${id}」同时属于「${idOwner.get(id)}」与「${e.name}」，运行时身份会互相覆盖`, { ids: [id] });
    } else {
      idOwner.set(id, e.name);
    }
  }

  /* ---- future 信息泄漏（blocker）：past 事件实际发生在 canon 截止章之后 ----
   * 约定：canon_cutoff 及之后的章节属于「参考走向」，≥ cutoff 的事件只能是
   * future / branch；标成 past 就会通过 renderTimelinePast 漏进 system 前史。
   * 没有 source.canon_cutoff 的卡不做猜测（旧卡/手写卡不误报）。 */
  const cutoff = chapterNo(card.source?.canon_cutoff);
  if (cutoff) {
    for (const ev of card.timeline || []) {
      if (ev.canon !== 'past') continue;
      const ch = chapterNo(ev.source);
      if (ch && ch >= cutoff) {
        push('blocker', 'future_leak', `时间线事件「${ev.what}」标成了 past，但来源 ${ev.source} 不早于 canon 截止章 ${card.source.canon_cutoff}：后文信息会漏进前史`, {
          ids: [ev.id].filter(Boolean),
        });
      }
    }
  }

  /* ---- 卡级声明：单值谓词的有效期冲突 ---- */
  const claims = card.claims || [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.cardinality !== 'one' || b.cardinality !== 'one') continue;
      if (a.subject !== b.subject || a.predicate !== b.predicate) continue;
      if (JSON.stringify(a.object) === JSON.stringify(b.object)) continue;
      if (!overlaps(a.validity || {}, b.validity || {})) continue;
      push('major', 'claim_conflict', `单值声明冲突：${a.subject} ${a.predicate} 同时指向两个对象`, {
        ids: [],
      });
    }
  }

  /* ---- 世界索引容量（major）：卡大到名字清单都放不下 ----
   * 小说卡常见 300+ 实体：索引会先丢摘要、再截断名字，被截掉的实体不会自动出现在
   * 系统层，模型只能从「被点名 / 主动检索」知道它们存在——这是制卡期的容量问题，
   * 不是运行时 bug。只报告、不拦保存；真实覆盖率还看每轮 meta.system_blocks.index。 */
  const indexText = renderWorldTree(card, INDEX_NOMINAL_TOKENS);
  const notInIndex = entities.filter((e) => {
    const name = String(e.name || '').trim();
    if (!name) return false;
    if (e.muted && e.type !== 'person') return false;
    return !indexText.includes(name);
  });
  if (notInIndex.length) {
    push('major', 'index_overflow',
      `世界索引在 ${INDEX_NOMINAL_TOKENS} tok 名义容量下放不下 ${notInIndex.length}/${entities.length} 个实体`
      + `（如 ${notInIndex.slice(0, 5).map((e) => e.name).join('、')}）：它们不会自动出现在系统层，演绎时容易被当成不存在`,
      { ids: notInIndex.slice(0, 20).map((e) => e.id), dropped: notInIndex.length });
  }

  /* ---- 仅供作者参考的改编元数据（info）----
   * canon_arc / divergence 当前没有任何运行时消费者：不注入提示词，也不参与校勘、解锁或
   * 强制节拍。报告出来，避免作者把它们误当成「引擎会执行的约束」。 */
  const arcs = Array.isArray(card.canon_arc) ? card.canon_arc : [];
  if (arcs.length) {
    push('info', 'canon_arc_reference_only',
      `canon_arc 有 ${arcs.length} 条弧线（${arcs.slice(0, 3).map((a) => a.label || a.id || '未命名').join('、')}）：只作作者对照，不注入提示词，也不参与演绎与解锁`);
  }
  const divergence = card.divergence || {};
  const mustHold = Array.isArray(divergence.must_hold) ? divergence.must_hold : [];
  const allow = Array.isArray(divergence.allow) ? divergence.allow : [];
  if (mustHold.length || allow.length) {
    push('info', 'divergence_reference_only',
      `改编边界（must_hold ${mustHold.length} 条 / allow ${allow.length} 条）同样只作作者对照：不注入提示词，引擎不会强制执行`);
  }

  const bySeverity = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const issue of issues) bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;

  const counts = {
    entities: graph.entities.size,
    persons: persons.length,
    facts: facts.length,
    edges: graph.edges.length,
    issues: issues.length,
    bySeverity,
  };
  return { issues, counts };
}
