/**
 * server/world/graph.js — 辞书图谱（v5 核心，纯函数）
 *
 * 把世界卡里的 cast / codex / relations / links / parent_id / edges 投影成
 * 统一的实体图：实体（节点）+ 类型化关系（边）+ 别名解析 + 去重。
 *
 * 三条硬约束：
 * - 不按关键词触发；图只回答「谁和谁有关系」与「包含关系是什么」。
 * - 卡是唯一真源；这里只做只读投影，不写库。
 * - 没有显式 edges 的 v4 卡也能用：从 cast.relations / codex.links / parent_id 推导。
 */

const stripRef = (v) => String(v || '').trim().replace(/^(cast|codex):/, '');

/** codex 条目的分层视图：public 给所有人，engine 给引擎。 */
function codexLayers(e) {
  const f = e.facets || {};
  const engine = {};
  if (e.reveal === 'secret' || e.reveal === 'rumor') engine.truth = e.detail || f.history || '';
  if (f.consequences?.length) engine.consequences = f.consequences;
  return {
    public: { summary: e.summary || '', rules: f.rules || [], sensory: f.sensory || '' },
    engine,
  };
}

/**
 * 建立实体图。
 *
 * - cast 与 codex 同名/同别名时合并为一个节点（mergedCodexIds），索引与场记单不再重复；
 * - cast.relations → 无向关系边；
 * - codex.links → 无向关系边；
 * - codex.parent_id → located_in 有向边；
 * - card.edges → 显式类型化边（可覆盖/补充推导边）。
 *
 * @returns {{
 *   entities: Map<string, object>, edges: Array<object>,
 *   aliasToId: Map<string, string>, mergedCodexIds: Set<string>,
 *   codexById: Map<string, object>, castById: Map<string, object>,
 *   adjacency: Map<string, Set<string>>, resolve: (ref:string)=>string,
 * }}
 */
export function buildWorldGraph(card) {
  const entities = new Map();
  const aliasToId = new Map();
  const mergedCodexIds = new Set();
  const codexById = new Map((card.codex || []).map((e) => [e.id, e]));
  const castById = new Map((card.cast || []).map((c) => [c.id, c]));

  const bindAliases = (id, names) => {
    for (const raw of names) {
      const name = String(raw || '').trim();
      if (name && !aliasToId.has(name)) aliasToId.set(name, id);
    }
  };

  for (const c of card.cast || []) {
    entities.set(c.id, {
      id: c.id,
      kind: 'character',
      name: c.name,
      aliases: c.aliases || [],
      tags: [],
      parent_id: '',
      cast: c,
      codex: null,
      definition: c,
      layers: {},
      sources: [],
    });
    bindAliases(c.id, [c.name, ...(c.aliases || [])]);
  }

  for (const e of card.codex || []) {
    const names = [e.name, ...(e.aliases || [])].filter(Boolean);
    const hitId = names.map((n) => aliasToId.get(n)).find(Boolean);
    if (hitId && entities.get(hitId)?.kind === 'character') {
      // 同名 cast/codex：合并到人物节点，codex 只作为该人物的附加层。
      mergedCodexIds.add(e.id);
      const node = entities.get(hitId);
      node.codex = e;
      node.layers = { ...node.layers, ...codexLayers(e) };
      node.sources = [...(node.sources || []), ...(e.sources || [])];
      aliasToId.set(e.id, hitId);
      for (const n of names) if (!aliasToId.has(n)) aliasToId.set(n, hitId);
      continue;
    }

    entities.set(e.id, {
      id: e.id,
      kind: e.type,
      name: e.name,
      aliases: e.aliases || [],
      tags: e.tags || [],
      parent_id: e.parent_id || '',
      cast: null,
      codex: e,
      definition: e,
      layers: codexLayers(e),
      sources: e.sources || [],
    });
    bindAliases(e.id, names);
  }

  const resolve = (ref) => {
    const r = stripRef(ref);
    if (!r) return '';
    return aliasToId.get(r) || (entities.has(r) ? r : '');
  };

  const edges = [];
  const seen = new Set();
  const addEdge = (from, to, kind, opts = {}) => {
    const f = resolve(from);
    const t = resolve(to);
    if (!f || !t || f === t) return;
    const k = kind || 'related_to';
    const key = `${f}|${t}|${k}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      from: f,
      to: t,
      kind: k,
      directed: opts.directed !== false,
      weight: Number.isFinite(Number(opts.weight)) ? Number(opts.weight) : 0.5,
      visibility: opts.visibility || 'public',
      note: opts.note || '',
    });
  };

  for (const c of card.cast || []) {
    for (const r of c.relations || []) {
      addEdge(c.id, r.to, r.kind || 'related_to', {
        weight: r.sentiment, note: r.note, directed: false,
      });
    }
  }

  for (const e of card.codex || []) {
    const nodeId = mergedCodexIds.has(e.id) ? aliasToId.get(e.id) : e.id;
    for (const l of e.links || []) addEdge(nodeId, l, 'related_to', { directed: false });
    if (e.parent_id) addEdge(e.id, e.parent_id, 'located_in', { directed: true });
  }

  for (const e of card.edges || []) {
    addEdge(e.from, e.to, e.kind, e);
  }

  const adjacency = new Map();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
    if (!adjacency.has(e.to)) adjacency.set(e.to, new Set());
    adjacency.get(e.from).add(e.to);
    adjacency.get(e.to).add(e.from);
  }

  return { entities, edges, aliasToId, mergedCodexIds, codexById, castById, adjacency, resolve };
}

/** 1 跳（或 N 跳）邻域。只用于场景视图的候选扩展，不写库。 */
export function graphNeighbors(graph, ids, { depth = 1 } = {}) {
  const out = new Set();
  let frontier = new Set();
  for (const raw of ids || []) {
    const id = graph.resolve ? graph.resolve(raw) : raw;
    if (id) frontier.add(id);
  }
  for (let d = 0; d < Math.max(0, Number(depth) || 0); d++) {
    const next = new Set();
    for (const id of frontier) {
      for (const n of graph.adjacency.get(id) || []) {
        if (!out.has(n)) next.add(n);
      }
    }
    for (const n of next) out.add(n);
    frontier = next;
  }
  return out;
}

/** 地点/机构的祖先链（由 parent_id 决定）。 */
export function graphAncestors(graph, id) {
  const out = [];
  const seen = new Set();
  let cur = graph.resolve ? graph.resolve(id) : id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = graph.entities.get(cur);
    const parent = node?.parent_id ? graph.resolve(node.parent_id) : '';
    if (!parent || seen.has(parent)) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

/** 直接子节点。 */
export function graphChildren(graph, id) {
  const target = graph.resolve ? graph.resolve(id) : id;
  const out = [];
  for (const node of graph.entities.values()) {
    if (!node.parent_id) continue;
    if (graph.resolve(node.parent_id) === target) out.push(node.id);
  }
  return out;
}

/** 卡里是否存在包含关系（决定世界索引是否用树）。 */
export function hasContainment(graph) {
  for (const node of graph.entities.values()) if (node.parent_id) return true;
  return false;
}
