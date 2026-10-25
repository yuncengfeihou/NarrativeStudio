/**
 * server/world/effective.js — EffectiveWorld 投影
 *
 * 世界卡是模板（公理 + 开局种子），world_state 是世界线的运行期增量。
 * 本模块把两者投影成「这一轮真实有效的世界」：上下文引擎只读投影结果，
 * 不读卡片里的初始值，也不把运行期变化写回卡片。
 *
 * 纯函数：不碰存储、不调 LLM。
 */

import {
  CAST_PATHS, CODEX_PATHS, PLAYER_PATHS, WORLD_PATHS, LIST_PATH_SET as LIST_PATHS,
} from './state-paths.js';
import { applyFates } from './fates.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);

function cloneCast(c) {
  return {
    ...c,
    aliases: [...(c.aliases || [])],
    identity: { ...(c.identity || {}) },
    voice: {
      ...(c.voice || {}),
      address: { ...(c.voice?.address || {}) },
      lexicon: [...(c.voice?.lexicon || [])],
      never: [...(c.voice?.never || [])],
      exemplars: [...(c.voice?.exemplars || [])],
    },
    psyche: {
      wants: [...(c.psyche?.wants || [])],
      fears: [...(c.psyche?.fears || [])],
      hides: [...(c.psyche?.hides || [])],
      values: [...(c.psyche?.values || [])],
    },
    knowledge: {
      knows: [...(c.knowledge?.knows || [])],
      does_not_know: [...(c.knowledge?.does_not_know || [])],
      believes_falsely: [...(c.knowledge?.believes_falsely || [])],
    },
    agenda: (c.agenda || []).map((a) => ({ ...a })),
    relations: (c.relations || []).map((r) => ({ ...r })),
  };
}

function cloneCodex(e) {
  return {
    ...e,
    aliases: [...(e.aliases || [])],
    tags: [...(e.tags || [])],
    links: [...(e.links || [])],
    facets: {
      ...(e.facets || {}),
      rules: [...(e.facets?.rules || [])],
      consequences: [...(e.facets?.consequences || [])],
    },
  };
}

/** 剧情里第一次出现的人物：只保证渲染所需的字段齐全，身份根保持空白。 */
export function emptyCastEntry(id, name = id) {
  return {
    id, name,
    aliases: [],
    role: '临时登场',
    one_line: '',
    status: '临时登场',
    condition: '',
    mood: '',
    location: '',
    goal: '',
    identity: { age: '', appearance: '', background: '', station: '' },
    voice: { address: {}, rhythm: '', lexicon: [], never: [], exemplars: [] },
    psyche: { wants: [], fears: [], hides: [], values: [] },
    knowledge: { knows: [], does_not_know: [], believes_falsely: [] },
    agenda: [],
    relations: [],
    always_present: false,
    weight: 0.3,
    improvised: true,
  };
}

/** 剧情里第一次出现的地点/物件/机构。 */
function emptyCodexEntry(id, fields = {}) {
  const facets = isObj(fields.facets) ? fields.facets : {};
  return {
    id,
    type: fields.type || 'custom',
    name: fields.name || id,
    aliases: asArray(fields.aliases),
    tags: asArray(fields.tags),
    summary: String(fields.summary || ''),
    facets: {
      sensory: String(facets.sensory || ''),
      rules: asArray(facets.rules).map(String),
      consequences: asArray(facets.consequences).map(String),
      history: String(facets.history || ''),
    },
    links: asArray(fields.links),
    reveal: ['public', 'rumor', 'secret'].includes(fields.reveal) ? fields.reveal : 'public',
    canon_from: String(fields.canon_from || 'session'),
    detail: String(fields.detail || ''),
    pinned: false,
    parent_id: String(fields.parent_id || ''),
    sources: asArray(fields.sources),
    improvised: true,
  };
}

function getAt(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setAt(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!isObj(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function addList(obj, path, value) {
  const list = asArray(getAt(obj, path)).slice();
  // add 允许一次给多个值：模型常把「学到 A 和 B」写成 value: ["A","B"]。
  // 不能 String(array)，否则会变成一条 "A,B"。
  const items = Array.isArray(value) ? value : [value];
  for (const raw of items) {
    const v = String(raw ?? '').trim();
    if (v && !list.includes(v)) list.push(v);
  }
  setAt(obj, path, list);
}

function removeList(obj, path, value) {
  const v = String(value ?? '');
  setAt(obj, path, asArray(getAt(obj, path)).filter((x) => String(x) !== v));
}

/**
 * 把一条增量应用到实体上。
 * set 写标量；add/remove 写列表；introduce 创建会话内的新实体。
 */
function applyDelta(world, delta) {
  const kind = String(delta.entity_kind || '');
  const id = String(delta.entity_id || '');
  const path = String(delta.path || '');
  const op = delta.op || 'set';
  const value = delta.value;

  if (kind === 'cast') {
    const introduceName = op === 'introduce' && isObj(value) ? String(value.name || '') : '';
    let c = world.cast.find((x) => x.id === id || x.name === id
      || (introduceName && x.name === introduceName));
    if (!c && op === 'introduce') {
      c = emptyCastEntry(id, introduceName || id);
      world.cast.push(c);
    }
    if (!c && op !== 'introduce') {
      c = emptyCastEntry(id, id);
      world.cast.push(c);
    }
    if (!c) return;
    if (op === 'introduce') {
      if (!isObj(value)) return;
      for (const [k, v] of Object.entries(value)) {
        if (k === 'id' || k === 'name') continue;
        if (LIST_PATHS.has(k)) c[k] = asArray(v).map(String);
        else if (CAST_PATHS.has(k)) c[k] = String(v ?? '');
        else if (k === 'knowledge' || k === 'psyche' || k === 'voice' || k === 'identity') {
          c[k] = { ...(c[k] || {}), ...(isObj(v) ? v : {}) };
        }
      }
      if (String(value.name || '').trim()) c.name = String(value.name).trim();
      return;
    }
    if (!CAST_PATHS.has(path)) return;
    if (op === 'add') addList(c, path, value);
    else if (op === 'remove') removeList(c, path, value);
    else if (path.includes('.')) setAt(c, path, value);
    else c[path] = String(value ?? '');
    return;
  }

  if (kind === 'codex') {
    const introduceName = op === 'introduce' && isObj(value) ? String(value.name || '') : '';
    let e = world.codex.find((x) => x.id === id || x.name === id
      || (introduceName && x.name === introduceName));
    if (!e && op === 'introduce') {
      e = emptyCodexEntry(id, isObj(value) ? value : {});
      world.codex.push(e);
      return;
    }
    if (!e) {
      e = emptyCodexEntry(id, { name: id });
      world.codex.push(e);
    }
    if (op === 'introduce') {
      if (!isObj(value)) return;
      for (const [k, v] of Object.entries(value)) {
        if (k === 'id') continue;
        if (k === 'name') e.name = String(v || e.name);
        else if (LIST_PATHS.has(k)) e[k] = asArray(v).map(String);
        else if (k === 'facets' && isObj(v)) e.facets = { ...e.facets, ...v };
        else if (CODEX_PATHS.has(k)) e[k] = String(v ?? '');
      }
      return;
    }
    if (!CODEX_PATHS.has(path)) return;
    if (op === 'add') addList(e, path, value);
    else if (op === 'remove') removeList(e, path, value);
    else if (path.includes('.')) setAt(e, path, value);
    else e[path] = String(value ?? '');
    return;
  }

  if (kind === 'player') {
    if (!PLAYER_PATHS.has(path)) return;
    if (op === 'add') addList(world.player, path, value);
    else if (op === 'remove') removeList(world.player, path, value);
    else if (path.includes('.')) setAt(world.player, path, value);
    else world.player[path] = String(value ?? '');
    return;
  }

  if (kind === 'world') {
    if (!WORLD_PATHS.has(path)) return;
    world.runtime[path] = path === 'tension' ? Number(value) : value;
  }
}

/**
 * 投影某一轮生效的世界。
 *
 * @param {object} card      会话冻结的世界卡快照（已 normalize）
 * @param {Array}  deltas    getWorldState(session, { branchId, atTurn }) 的结果
 * @returns {object} 世界卡形状的 effective world
 */
export function buildEffectiveWorld(card, deltas = [], fates = []) {
  const world = {
    ...card,
    cast: (card.cast || []).map(cloneCast),
    codex: (card.codex || []).map(cloneCodex),
    player: {
      ...(card.player || {}),
      knowledge: {
        knows: [...(card.player?.knowledge?.knows || [])],
        does_not_know: [...(card.player?.knowledge?.does_not_know || [])],
      },
    },
    runtime: {},
  };

  const ordered = deltas
    .slice()
    .sort((a, b) => (Number(a.valid_from) || 0) - (Number(b.valid_from) || 0)
      || (Number(a.id) || 0) - (Number(b.id) || 0));

  // 运行期增量先落，因为 introduce 会创建后续阶段要作用的实体。
  for (const d of ordered) applyDelta(world, d);

  // 优先级：运行期 world_state > fates > 卡初始值。
  // fates 代表「按条件解锁的预置增量」，语义上就是 valid_from 由条件表达式决定的
  // world_state delta。运行期已经显式写过的路径，fates 不得覆盖——否则玩家/史官
  // 在剧情里造就的变化会被卡里的预设轨迹抹掉。
  if (fates && fates.length) {
    const touched = new Set();
    for (const d of ordered) {
      if (d.path) touched.add(`${d.entity_id}::${d.path}`);
    }
    applyFates(world, fates, { touched });
  }

  return world;
}
