/**
 * server/world/lint.js — 世界卡静态体检（纯函数，不调模型）
 *
 * 只报告、不修改。检查的是「结构能不能被渲染/遍历」与「设定之间有没有硬矛盾」：
 * - cast 与 codex 同名（同一实体两套身份）
 * - 别名冲突、断链、断父、包含环、id 冲突
 * - 从未进入任何关系的孤立辞书
 * - future 信息泄漏：标成 past 的事件实际发生在 canon 截止章之后
 * - 单值声明在有效期上重叠且对象不同
 * - 内容充分性：进运行时会不会是空壳（只报 info，不拦保存）
 *
 * 严重度约定：blocker 只给「运行时会出错/身份会打架/后文会漏进前史」的问题
 * （id 冲突、包含环、future 泄漏）；其余一律 info / minor / major。
 * lint 永不修改卡，保存拦截由路由层决定。
 */

import { buildWorldGraph } from './graph.js';

const stripRef = (v) => String(v || '').trim().replace(/^(cast|codex):/, '');

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

  const cast = card.cast || [];
  const codex = card.codex || [];
  const graph = buildWorldGraph(card);

  /* ---- 同名 cast/codex：会被 graph 合并，但仍提示作者整理 ---- */
  const castByAlias = new Map();
  for (const c of cast) {
    for (const name of [c.name, ...(c.aliases || [])]) {
      if (name) castByAlias.set(name, c);
    }
  }
  for (const e of codex) {
    const hit = [e.name, ...(e.aliases || [])].map((n) => castByAlias.get(n)).find(Boolean);
    if (hit) {
      push('info', 'duplicate_identity', `辞书「${e.name}」与人物「${hit.name}」同名，运行时会按同一实体合并`, {
        ids: [e.id, hit.id],
      });
    }
  }

  /* ---- 别名冲突：同一别名指向不同实体 ---- */
  const aliasOwner = new Map();
  const addAlias = (alias, id, kind) => {
    const key = String(alias || '').trim();
    if (!key) return;
    const prev = aliasOwner.get(key);
    if (prev && prev.id !== id) {
      push('major', 'alias_collision', `别名「${key}」同时指向 ${prev.id} 与 ${id}`, {
        ids: [prev.id, id],
      });
    } else {
      aliasOwner.set(key, { id, kind });
    }
  };
  for (const c of cast) {
    addAlias(c.name, c.id, 'cast');
    for (const a of c.aliases || []) addAlias(a, c.id, 'cast');
  }
  for (const e of codex) {
    addAlias(e.name, e.id, 'codex');
    for (const a of e.aliases || []) addAlias(a, e.id, 'codex');
  }

  /* ---- 断链 / 断父 ---- */
  const known = new Set();
  for (const c of cast) {
    known.add(c.id); known.add(c.name);
    for (const a of c.aliases || []) known.add(a);
  }
  for (const e of codex) {
    known.add(e.id); known.add(e.name);
    for (const a of e.aliases || []) known.add(a);
  }

  for (const e of codex) {
    for (const link of e.links || []) {
      if (!known.has(stripRef(link))) {
        push('major', 'broken_link', `辞书「${e.name}」的 links 指向不存在的实体「${link}」`, { ids: [e.id] });
      }
    }
    if (e.parent_id && !known.has(stripRef(e.parent_id))) {
      push('major', 'broken_parent', `辞书「${e.name}」的 parent_id 指向不存在的实体「${e.parent_id}」`, { ids: [e.id] });
    }
  }
  for (const c of cast) {
    for (const r of c.relations || []) {
      if (r.to && !known.has(stripRef(r.to))) {
        push('minor', 'broken_relation', `人物「${c.name}」的关系指向不存在的实体「${r.to}」`, { ids: [c.id] });
      }
    }
  }

  /* ---- 包含环 ---- */
  const parentOf = new Map(codex.map((e) => [e.id, stripRef(e.parent_id)]));
  const reported = new Set();
  for (const e of codex) {
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

  /* ---- 孤立辞书：没有边、没钉选、没标签 ---- */
  const incoming = new Set(graph.edges.map((e) => e.to));
  for (const e of codex) {
    if (e.pinned) continue;
    if ((e.links || []).length) continue;
    if (incoming.has(e.id)) continue;
    if ((e.tags || []).length) continue;
    push('info', 'orphan_codex', `辞书「${e.name}」没有任何连接、标签或钉选，可能永远不会自动进场`, { ids: [e.id] });
  }

  /* ---- 内容充分性（info）：进运行时会是空壳的卡司/辞书，只提示不拦保存 ---- */
  for (const c of cast) {
    const missing = [];
    if (!String(c.identity?.appearance || '').trim()) missing.push('appearance');
    if (!String(c.one_line || '').trim()) missing.push('one_line');
    if (!String(c.voice?.rhythm || '').trim()) missing.push('rhythm');
    if (missing.length) {
      push('info', 'cast_incomplete', `人物「${c.name}」缺少 ${missing.join(' / ')}，进运行时容易变成空壳`, {
        ids: [c.id], missing,
      });
    }
    const wants = c.psyche?.wants || [];
    const hides = c.psyche?.hides || [];
    if (!wants.length && !hides.length) {
      push('info', 'cast_hollow', `人物「${c.name}」既没有欲望也没有秘密，演绎时缺少内在驱动`, { ids: [c.id] });
    }
  }
  for (const e of codex) {
    const summary = String(e.summary || '').trim();
    const facets = e.facets || {};
    const hasFacet = [facets.sensory, facets.history].some((v) => String(v || '').trim())
      || (facets.rules || []).length > 0
      || (facets.consequences || []).length > 0;
    if (!summary || !hasFacet) {
      push('info', 'codex_incomplete', `辞书「${e.name}」缺少${summary ? '' : ' summary'}${hasFacet ? '' : ' 细节（facets 全空）'}`, {
        ids: [e.id],
      });
    }
    if (e.type === 'character') {
      const matched = [e.name, ...(e.aliases || [])].some((n) => castByAlias.has(n));
      if (!matched) {
        push('info', 'character_codex_orphan', `辞书「${e.name}」是 character 类型，但卡司里没有同名/同别名角色，建议归位（转 identity.background）或删除`, {
          ids: [e.id],
        });
      }
    }
  }

  /* ---- id 冲突（blocker）：graph 用 id 建 Map，重复会互相覆盖 ---- */
  const castIdOwner = new Map();
  for (const c of cast) {
    const id = String(c.id || '').trim();
    if (!id) continue;
    if (castIdOwner.has(id)) {
      push('blocker', 'duplicate_id', `卡司 id 重复：「${id}」同时属于「${castIdOwner.get(id)}」与「${c.name}」，运行时身份会互相覆盖`, { ids: [id] });
    } else {
      castIdOwner.set(id, c.name);
    }
  }
  const codexIdOwner = new Map();
  for (const e of codex) {
    const id = String(e.id || '').trim();
    if (!id) continue;
    if (codexIdOwner.has(id)) {
      push('blocker', 'duplicate_id', `辞书 id 重复：「${id}」同时属于「${codexIdOwner.get(id)}」与「${e.name}」，运行时身份会互相覆盖`, { ids: [id] });
    } else {
      codexIdOwner.set(id, e.name);
    }
  }
  for (const [id, name] of codexIdOwner) {
    if (castIdOwner.has(id)) {
      push('blocker', 'duplicate_id', `cast 与 codex 共用 id「${id}」（${castIdOwner.get(id)} / ${name}），运行时身份会互相覆盖`, { ids: [id] });
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

  const bySeverity = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const issue of issues) bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;

  const counts = {
    entities: graph.entities.size,
    edges: graph.edges.length,
    merged_codex: graph.mergedCodexIds.size,
    issues: issues.length,
    bySeverity,
  };
  return { issues, counts };
}
