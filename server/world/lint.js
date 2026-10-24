/**
 * server/world/lint.js — 世界卡静态体检（纯函数，不调模型）
 *
 * 只报告、不修改。检查的是「结构能不能被渲染/遍历」与「设定之间有没有硬矛盾」：
 * - cast 与 codex 同名（同一实体两套身份）
 * - 别名冲突、断链、断父、包含环
 * - 从未进入任何关系的孤立辞书
 * - 单值声明在有效期上重叠且对象不同
 */

import { buildWorldGraph } from './graph.js';

const stripRef = (v) => String(v || '').trim().replace(/^(cast|codex):/, '');

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

  const counts = {
    entities: graph.entities.size,
    edges: graph.edges.length,
    merged_codex: graph.mergedCodexIds.size,
    issues: issues.length,
  };
  return { issues, counts };
}
