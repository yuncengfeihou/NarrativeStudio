/**
 * server/world/effective.js — EffectiveWorld 投影
 *
 * 世界卡是模板（公理 + 开局种子），world_state 是世界线的运行期增量。
 * 本模块把两者投影成「这一轮真实有效的世界」：上下文引擎只读投影结果，
 * 不读卡片里的初始值，也不把运行期变化写回卡片。
 *
 * 纯函数：不碰存储、不调 LLM。
 */

import { pathsFor, LIST_PATH_SET as LIST_PATHS } from './state-paths.js';
import { isPerson, PERSON_TYPE } from './schema.js';
import { applyFates } from './fates.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);

function cloneEntity(e) {
  const base = {
    ...e,
    aliases: [...(e.aliases || [])],
    tags: [...(e.tags || [])],
    links: [...(e.links || [])],
    facets: {
      ...(e.facets || {}),
      rules: [...(e.facets?.rules || [])],
      consequences: [...(e.facets?.consequences || [])],
    },
    sources: asArray(e.sources).map((s) => ({ ...s })),
  };
  if (!isPerson(e)) return base;
  return {
    ...base,
    identity: { ...(e.identity || {}) },
    voice: {
      ...(e.voice || {}),
      address: { ...(e.voice?.address || {}) },
      lexicon: [...(e.voice?.lexicon || [])],
      never: [...(e.voice?.never || [])],
      exemplars: [...(e.voice?.exemplars || [])],
    },
    psyche: {
      traits: [...(e.psyche?.traits || [])],
      wants: [...(e.psyche?.wants || [])],
      fears: [...(e.psyche?.fears || [])],
      hides: [...(e.psyche?.hides || [])],
      values: [...(e.psyche?.values || [])],
    },
    knowledge: {
      knows: [...(e.knowledge?.knows || [])],
      does_not_know: [...(e.knowledge?.does_not_know || [])],
      believes_falsely: [...(e.knowledge?.believes_falsely || [])],
    },
    agenda: (e.agenda || []).map((a) => ({ ...a })),
    relations: (e.relations || []).map((r) => ({ ...r })),
  };
}

/** 剧情里第一次出现的人物：只保证渲染所需的字段齐全，身份根保持空白。 */
export function emptyPersonEntry(id, name = id) {
  return {
    id,
    type: PERSON_TYPE,
    name,
    aliases: [],
    tags: [],
    links: [],
    summary: '',
    detail: '',
    facets: { sensory: '', rules: [], consequences: [], history: '' },
    role: '临时登场',
    status: '临时登场',
    condition: '',
    mood: '',
    location: '',
    goal: '',
    identity: { age: '', appearance: '', background: '', station: '' },
    voice: { address: {}, rhythm: '', lexicon: [], never: [], exemplars: [] },
    psyche: { traits: [], wants: [], fears: [], hides: [], values: [] },
    knowledge: { knows: [], does_not_know: [], believes_falsely: [] },
    agenda: [],
    relations: [],
    reveal: 'public',
    canon_from: 'session',
    sources: [],
    pinned: false,
    muted: false,
    parent_id: '',
    always_present: false,
    weight: 0.3,
    improvised: true,
  };
}

/** 剧情里第一次出现的地点/物件/机构/概念。 */
function emptyFactEntry(id, fields = {}) {
  const facets = isObj(fields.facets) ? fields.facets : {};
  const type = ['place', 'institution', 'item', 'faction', 'concept', 'custom'].includes(fields.type)
    ? fields.type
    : 'custom';
  return {
    id,
    type,
    name: fields.name || id,
    aliases: asArray(fields.aliases),
    tags: asArray(fields.tags),
    summary: String(fields.summary || ''),
    detail: String(fields.detail || ''),
    facets: {
      sensory: String(facets.sensory || ''),
      rules: asArray(facets.rules).map(String),
      consequences: asArray(facets.consequences).map(String),
      history: String(facets.history || ''),
    },
    links: asArray(fields.links),
    reveal: ['public', 'rumor', 'secret'].includes(fields.reveal) ? fields.reveal : 'public',
    canon_from: String(fields.canon_from || 'session'),
    sources: asArray(fields.sources),
    pinned: false,
    muted: false,
    parent_id: String(fields.parent_id || ''),
    status: String(fields.status || ''),
    condition: String(fields.condition || ''),
    access: String(fields.access || ''),
    open_to: String(fields.open_to || ''),
    owner_id: String(fields.owner_id || ''),
    location_id: String(fields.location_id || ''),
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
 * entity_kind 是 v5 的实体类型值（person / place / …），不再有 cast/codex 两套。
 * player / world 不是卡里的实体：前者投影到 world.player，后者投影到 world.runtime。
 */
function applyDelta(world, delta) {
  const kind = String(delta.entity_kind || '');
  const id = String(delta.entity_id || '');
  const path = String(delta.path || '');
  const op = delta.op || 'set';
  const value = delta.value;
  const allowed = pathsFor(kind);
  if (!allowed) return;

  if (kind === 'player' || kind === 'world') {
    const target = kind === 'player' ? world.player : world.runtime;
    if (!isObj(target) || !allowed.has(path)) return;
    if (op === 'add') addList(target, path, value);
    else if (op === 'remove') removeList(target, path, value);
    else if (path.includes('.')) setAt(target, path, value);
    else target[path] = String(value ?? '');
    return;
  }

  const person = kind === PERSON_TYPE;
  const introduceName = op === 'introduce' && isObj(value) ? String(value.name || '') : '';
  let entity = world.entities.find((x) => x.id === id || x.name === id
    || (introduceName && x.name === introduceName));
  if (!entity && op === 'introduce') {
    entity = person
      ? emptyPersonEntry(id, introduceName || id)
      : emptyFactEntry(id, { ...(isObj(value) ? value : {}), name: introduceName || id });
    world.entities.push(entity);
    if (!person) return;
  }
  if (!entity) {
    entity = person ? emptyPersonEntry(id, id) : emptyFactEntry(id, { name: id });
    world.entities.push(entity);
  }
  if (op === 'introduce') {
    if (!isObj(value)) return;
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id') continue;
      if (k === 'type') continue;
      if (k === 'name') {
        entity.name = String(v || entity.name);
      } else if (k === 'facets' && isObj(v)) {
        entity.facets = { ...entity.facets, ...v };
      } else if (LIST_PATHS.has(k)) {
        entity[k] = asArray(v).map(String);
      } else if (allowed.has(k)) {
        entity[k] = String(v ?? '');
      } else if (['knowledge', 'psyche', 'voice', 'identity'].includes(k)) {
        entity[k] = { ...(entity[k] || {}), ...(isObj(v) ? v : {}) };
      }
    }
    return;
  }
  if (!allowed.has(path)) return;
  if (op === 'add') addList(entity, path, value);
  else if (op === 'remove') removeList(entity, path, value);
  else if (path.includes('.')) setAt(entity, path, value);
  else entity[path] = String(value ?? '');
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
    entities: (card.entities || []).map(cloneEntity),
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
  // world_state delta。运行期已经显式写过的路径，fates 不得覆盖——否则玩家/记忆整理
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
