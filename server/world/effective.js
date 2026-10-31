/**
 * server/world/effective.js — EffectiveWorld 投影
 *
 * 世界卡是模板（公理 + 开局种子），world_state 是世界线的运行期增量。
 * 本模块把两者投影成「这一轮真实有效的世界」：上下文引擎只读投影结果，
 * 不读卡片里的初始值，也不把运行期变化写回卡片。
 *
 * 纯函数：不碰存储、不调 LLM。
 */

import { pathsFor, isNumberPath as isNumberPathOf, LIST_PATH_SET as LIST_PATHS } from './state-paths.js';
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

/** 数值路径的判定只看白名单，不看模型吐出的字面量类型。 */
const isNumberPath = (kind, path) => isNumberPathOf(kind, path);
const numericOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
/** 百分位取整：0.1+0.2 这类浮点毛刺不能写进「钱」。 */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 写一条数值增量。
 *
 * delta 做加减，**结果允许为负**（欠债）。
 *
 * 这里曾经是「结果为负就整条拒绝」——理由是「静默 clamp 成 0 会让钱变少了却没人知道」。
 * 但拒绝在长跑里造成了更坏的结果：`prev=0` 时任何负数必然被拒，**被拒又不改基准**，
 * 于是余额永久卡在 0；模型看不到余额、也看不到被拒，只能照自己正文里的账继续花钱，
 * 50 拍实测「正文说七十五块二、账本一直是 0」公开矛盾 19 拍（见 D11）。
 * 唯一能解开的是模型偶然用一次 `op:'set'`。
 *
 * 现行口径：负数照常落，渲染成「欠 X」（`renderPlayerView`/场记单负责读），
 * 并记进 `world.overdrafts` 供报告看见。真正的非法输入（不是数字）仍然拒绝，
 * 因为那是模型输出错，不是世界状态。
 */
function writeNumber(world, target, path, op, value, src = {}) {
  const n = numericOf(value);
  const tag = { path, op, delta_id: src.id ?? null, turn: Number(src.valid_from) || 0 };
  if (n == null) {
    pushRejected(world, { ...tag, value, reason: 'not_a_number' });
    return;
  }
  if (op === 'set') {
    setAt(target, path, round2(n));
    return;
  }
  const prev = numericOf(getAt(target, path)) ?? 0;
  const next = round2(prev + n);
  setAt(target, path, next);
  if (next < 0) {
    if (!Array.isArray(world.overdrafts)) world.overdrafts = [];
    world.overdrafts.push({ ...tag, value: n, prev, next });
  }
}

function pushRejected(world, item) {
  if (!Array.isArray(world.rejected_deltas)) world.rejected_deltas = [];
  world.rejected_deltas.push(item);
}

/**
 * 记一条「被白名单挡掉」的增量（D34）。
 *
 * 这里以前是 `if (!allowed.has(path)) return;` —— 什么都不留。于是卡里的「宫男」
 * 被写成 concept 之后，它的 life_state/mood/goal/location 全部消失，而
 * `rejected_deltas` 里没有、报告看不见、正文照常演，110 拍跑完只能靠「某个人物
 * 状态一片空白」倒推。这与 D10/D12/D29/D31 是同一个形状：**为安全而设的拒绝，
 * 让状态悄悄停在一个错值上**。所以现在两条路分开记：值非法 → rejected_deltas；
 * 路径不被允许 → dropped_deltas（带实体当前类型，能直接看出是不是类型判错了）。
 */
function pushDropped(world, item) {
  if (!Array.isArray(world.dropped_deltas)) world.dropped_deltas = [];
  world.dropped_deltas.push(item);
}

/**
 * 升级成人物时要搬过去的字段（D34）。
 *
 * 不能只把 `type` 改成 person：概念/地点条目没有 voice / psyche / knowledge /
 * identity，场记单渲染会直接取 `c.voice.rhythm` 而抛错。所以造一份人物骨架，
 * 再把原条目里**世界事实**那部分搬过去——卡的模板不动，只动这条世界线的投影。
 */
const PROMOTE_KEEP = [
  'aliases', 'tags', 'links', 'summary', 'detail', 'facets', 'role', 'status',
  'condition', 'mood', 'location', 'goal', 'reveal', 'weight', 'pinned', 'muted',
  'parent_id', 'always_present', 'sources', 'canon_from', 'improvised',
];

/**
 * 把一个既有非人物条目就地升级成人物（D34）。
 *
 * 触发条件只有一个：`introduce` 声明它是 person，而按 id/name 命中的卡内条目不是。
 * 典型形状是卡里把一个「宫男」写成 `type:'concept'`（一类人），剧情里真的走出一个
 * 同名人物。此时若停在 concept，`pathsFor('concept')` 没有 life_state/mood/goal/
 * location，这些运行态会被白名单丢掉，最终表现为「已离场的人还在场」。
 */
function promoteToPerson(world, entity, delta) {
  const idx = world.entities.indexOf(entity);
  if (idx < 0) return entity;
  const promoted = emptyPersonEntry(entity.id, entity.name);
  for (const k of PROMOTE_KEEP) {
    const v = entity[k];
    if (v === undefined || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    promoted[k] = v;
  }
  world.entities[idx] = promoted;
  if (!Array.isArray(world.promotions)) world.promotions = [];
  world.promotions.push({
    id: entity.id,
    name: entity.name,
    from: String(entity.type || ''),
    to: PERSON_TYPE,
    turn: Number(delta.valid_from) || 0,
    delta_id: delta.id ?? null,
  });
  return promoted;
}

/**
 * 把一条增量应用到实体上。
 * set 写标量；add/remove 写列表；introduce 创建会话内的新实体；delta 只作用于数值路径。
 * entity_kind 是 v5 的实体类型值（person / place / …），不再有 cast/codex 两套。
 * player / world 不是卡里的实体：前者投影到 world.player，后者投影到 world.runtime。
 *
 * D34：实体路径的白名单按「这个实体在世界里**当前是什么**」取，不按「模型这一拍
 * 声明它是什么」取（与 §5.3「路径是不是数值由白名单决定，不由模型吐出的字面量类型
 * 决定」同源）。原先按声明取，一旦名称撞上卡里的非人物条目，person 的运行态
 * （life_state/mood/goal/location）就会被 concept 的白名单吃掉且不留痕。
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
    if (!isObj(target)) return;
    if (!allowed.has(path)) {
      pushDropped(world, {
        entity_kind: kind, entity_id: id, path, op,
        entity_type: kind, turn: Number(delta.valid_from) || 0, delta_id: delta.id ?? null,
      });
      return;
    }
    if (op === 'add') addList(target, path, value);
    else if (op === 'remove') removeList(target, path, value);
    else if (isNumberPath(kind, path)) writeNumber(world, target, path, op, value, delta);
    else if (path.includes('.')) setAt(target, path, value);
    else target[path] = String(value ?? '');
    return;
  }

  const person = kind === PERSON_TYPE;
  const introduceName = op === 'introduce' && isObj(value) ? String(value.name || '') : '';
  let entity = world.entities.find((x) => x.id === id || x.name === id
    || (introduceName && x.name === introduceName));
  // D34：introduce 声明 person，却按 id/name 撞上卡里的非人物条目（同名概念/地点/物件）
  // → 就地升级成人物。不升级的话它的运行态会被概念的白名单静默吃掉。
  if (entity && person && op === 'introduce' && entity.type !== PERSON_TYPE) {
    entity = promoteToPerson(world, entity, delta);
  }
  // 实体已存在时，白名单用它的**真实类型**；只有新建实体才用模型声明的 kind。
  const effectiveKind = entity ? String(entity.type || kind) : kind;
  const effectiveAllowed = entity ? pathsFor(effectiveKind) : allowed;
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
      } else if (effectiveAllowed.has(k)) {
        entity[k] = String(v ?? '');
      } else if (['knowledge', 'psyche', 'voice', 'identity'].includes(k)) {
        entity[k] = { ...(entity[k] || {}), ...(isObj(v) ? v : {}) };
      }
    }
    return;
  }
  if (!effectiveAllowed.has(path)) {
    // D34：路径不被允许时留痕，而不是悄悄 return。`entity_type` 记的是**实体实际类型**，
    // 与 `entity_kind`（模型声明的）不一致时，就是「类型判错了」的直接证据。
    pushDropped(world, {
      entity_kind: kind, entity_id: entity.id, path, op,
      entity_type: String(entity.type || ''), turn: Number(delta.valid_from) || 0,
      delta_id: delta.id ?? null,
    });
    return;
  }
  if (op === 'add') addList(entity, path, value);
  else if (op === 'remove') removeList(entity, path, value);
  else if (isNumberPath(effectiveKind, path)) writeNumber(world, entity, path, op, value);
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

  // introduce 一律先应用：史官的 `states` 循环写在 `changes` 之前，同拍里「先写运行态、
  // 后写 introduce」是常态，delta id 也自然排在前。撞名实体在 introduce 之前还是概念/
  // 地点，它的运行态会按**原类型**的白名单被丢掉（D34 同类静默失真）；引入之后再应用就
  // 全部成立。真实跑里 45 拍局的一拍里 2 条 mood/location 就是这样被丢的。
  const applies = [
    ...ordered.filter((d) => d.op === 'introduce'),
    ...ordered.filter((d) => d.op !== 'introduce'),
  ];
  for (const d of applies) applyDelta(world, d);

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
