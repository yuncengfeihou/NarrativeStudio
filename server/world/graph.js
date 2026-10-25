/**
 * server/world/graph.js — 实体图谱（v5 核心，纯函数）
 *
 * 把世界卡里的 entities / relations / links / parent_id / edges 投影成
 * 统一的实体图：实体（节点）+ 类型化关系（边）+ 别名解析。
 *
 * 三条硬约束：
 * - 不按关键词触发；图只回答「谁和谁有关系」与「包含关系是什么」。
 * - 卡是唯一真源；这里只做只读投影，不写库。
 * - 人物与事实在同一张图里；人物用 relations，事实用 links/parent_id。
 */

const stripRef = (v) => String(v || '').trim().replace(/^(?:cast|codex|entity):/, '');

/** 实体的分层视图：public 给所有人，engine 给引擎。 */
function entityLayers(e) {
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
 * - 节点直接来自 card.entities（单一命名空间，不需要 cast/codex 合并）；
 * - person.relations → 无向关系边；
 * - 任意实体的 links → 无向关系边；
 * - parent_id → located_in 有向边；
 * - card.edges → 显式类型化边（可覆盖/补充推导边）。
 *
 * @returns {{
 *   entities: Map<string, object>, edges: Array<object>,
 *   aliasToId: Map<string, string>, entityById: Map<string, object>,
 *   personById: Map<string, object>, adjacency: Map<string, Set<string>>,
 *   resolve: (ref:string)=>string,
 * }}
 */
export function buildWorldGraph(card) {
  const entities = new Map();
  const aliasToId = new Map();
  const entityById = new Map((card.entities || []).map((e) => [e.id, e]));
  const personById = new Map((card.entities || []).filter((e) => e.type === 'person').map((e) => [e.id, e]));

  const bindAliases = (id, names) => {
    for (const raw of names) {
      const name = String(raw || '').trim();
      if (name && !aliasToId.has(name)) aliasToId.set(name, id);
    }
  };

  for (const e of card.entities || []) {
    entities.set(e.id, {
      id: e.id,
      type: e.type,
      name: e.name,
      aliases: e.aliases || [],
      tags: e.tags || [],
      parent_id: e.parent_id || '',
      entity: e,
      layers: entityLayers(e),
    });
    bindAliases(e.id, [e.name, ...(e.aliases || [])]);
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

  for (const e of card.entities || []) {
    for (const r of e.relations || []) {
      addEdge(e.id, r.to, r.kind || 'related_to', {
        weight: r.sentiment, note: r.note, directed: false,
      });
    }
  }

  for (const e of card.entities || []) {
    for (const l of e.links || []) addEdge(e.id, l, 'related_to', { directed: false });
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

  return { entities, edges, aliasToId, entityById, personById, adjacency, resolve };
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
