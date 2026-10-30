/**
 * server/agents/archivist.js — 史官 Agent
 *
 * 每一轮正文写完后跑一次。它是唯一被允许写记忆的模型，但**只提案，不落库**：
 * 输出的 JSON 全部经过确定性校验（谓词白名单、别名归一、冲突失效、有效期）
 * 之后才由代码写入。旁白模型永远不碰 JSON。
 *
 * 落库的表：assertions / character_states / relations / threads / voices / states(账本)
 * 审计的表：patches（谁提的、证据是什么、被接受了哪几条）
 */
import { chat } from '../llm.js';
import {
  ENTITY_TYPES, PERSON_TYPE, buildAliasIndex, linkEntities, normalizeCard, resolveEntity, slugify,
} from '../world/schema.js';
import {
  ENTITY_KINDS, FACT_CANON_PATHS, LIST_PATH_SET, isNumberPath, pathsFor,
} from '../world/state-paths.js';
import {
  addAssertion, addPatch, addVoice, addWorldState, findConflictingAssertions, getState, getThreads,
  getWorldState, invalidateAssertion, setCharState, setState, upsertRelation, upsertThread,
} from '../memory/store.js';
import {
  LIFE_STATES, PREDICATES, STATE_FIELDS, VISIBILITIES, archivistSystemPrompt, archivistUserPrompt,
} from '../prompts/archivist.js';
import { THREAD_MIN_WEIGHT, THREAD_RENDER_MAX } from '../world/scene-sheet.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
/** 生死/离场只认受控词；不做中文同义词映射（那会变成又一份名字名单）。 */
const asLifeState = (v) => {
  const s = str(v).toLowerCase();
  return LIFE_STATES.includes(s) ? s : '';
};
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/* ══════════════════════════════════════════════════════════════════════ */
/* 纯函数：规范化与校验（可单测）                                          */
/* ══════════════════════════════════════════════════════════════════════ */

/** 把一个名字/别名归一成世界卡里的规范名；不认识就原样返回。 */
function canonicalize(name, aliasIndex) {
  const n = str(name);
  if (!n) return '';
  const hit = (aliasIndex || []).find((e) => e.alias === n);
  return hit ? hit.name : n;
}

/**
 * 构建「目标声明集合」：史官只能更新这一拍真正进场/已声明的实体。
 *
 * 输入都来自装配结果，不由模型声明：卡片（投影后）给作者公理里的实体，
 * present / codex 给本拍场记单里的条目，账本人物给本世界线已登场过的临时实体；
 * player 永远允许。未知实体只能走 introduce（见 sanitizeChange）。
 *
 * `world` 同样永远允许（D25）：它和 `player` 一样**不是卡里的实体**，而是投影目标
 * （`world/status` → `world.runtime.status` → 场记单的「局势」行 + 常驻笔记）。
 * 曾经只 add 了 `player` 没 add `world`，于是史官每一次世界局势变更都被这条
 * 声明校验静默拦掉：全库实测 `world_state` 里 `entity_kind='world'` 的写入 **0 行**，
 * 而这条路径的消费方一直在（场记单渲染「局势 …」、定稿时收进常驻笔记），
 * 提示词里也一直写着「world: status」。这是「白名单挡住运行时才出现的东西」的
 * 第六个实例（前五个：layers_truncated / facts_many_limit / relations_limit /
 * echoes_rendered / 装配 meta 的 10 个键）。
 */
export function buildDeclaredTargets({
  card, present = [], codex = [], ledgerCharacters = [], playerName = '',
} = {}) {
  const out = new Set();
  const add = (v) => {
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (v && typeof v === 'object') { add(v.id); add(v.name); return; }
    const s = str(v);
    if (s) out.add(s);
  };
  for (const e of arr(card?.entities)) { add(e.id); add(e.name); add(e.aliases); }
  add(present); add(codex); add(ledgerCharacters); add(playerName); add('player'); add('world');
  return [...out];
}

/** 把声明集合归一成可比对的集合（含规范名与实体 id）。null = 不启用白名单。 */
function declaredSetOf(declaredTargets, aliasIndex) {
  if (!Array.isArray(declaredTargets)) return null;
  const set = new Set();
  for (const raw of declaredTargets) {
    const name = str(raw);
    if (!name) continue;
    set.add(name);
    const canonical = canonicalize(name, aliasIndex);
    if (canonical) set.add(canonical);
    const ref = resolveEntity(name, aliasIndex);
    if (ref.id) set.add(ref.id);
    if (ref.name) set.add(ref.name);
  }
  return set;
}

/**
 * 目标是否在声明集合内。未启用白名单（declaredSet 为 null）时一律放行。
 *
 * 除了精确名/别名/id，还接受**包含已声明别名的写法**（D13-A1）：
 * 模型在正文里用简称指代长名（「蛇纹纸」指「蛇纹圆印纸」），简称本身永远不在别名里，
 * 于是那个物件的每一次 change 都被静默拒绝。判据仍走唯一的字符串匹配入口
 * （`linkEntities`，红线 2），且只在「解析出的实体确实已声明」时放行——
 * 不做同义词映射，也叫不出没登场过的东西。
 */
function isDeclaredTarget(target, declaredSet, aliasIndex) {
  if (!declaredSet) return true;
  const raw = str(target);
  if (!raw) return false;
  if (declaredSet.has(raw)) return true;
  const canonical = canonicalize(raw, aliasIndex);
  if (canonical && declaredSet.has(canonical)) return true;
  const ref = resolveEntity(raw, aliasIndex);
  if ((ref.id && declaredSet.has(ref.id)) || (ref.name && declaredSet.has(ref.name))) return true;
  // 简称：raw 里包含了某个已声明实体的别名（最长匹配由 linkEntities 负责）。
  const linked = linkEntities(raw, aliasIndex);
  for (const id of [...linked.person, ...linked.fact]) {
    if (declaredSet.has(id)) return true;
    const e = (aliasIndex || []).find((x) => x.id === id);
    if (e && declaredSet.has(e.name)) return true;
  }
  return false;
}

/** 校验并清洗一条断言。不合法返回 null。 */
export function sanitizeAssertion(a, aliasIndex) {
  const o = obj(a);
  const subject = canonicalize(o.subject, aliasIndex);
  const object = str(o.object);
  const predicate = str(o.predicate);
  if (!subject || !predicate || !object) return null;
  if (!PREDICATES.includes(predicate)) return null;
  const confidence = Number(o.confidence);
  return {
    subject,
    predicate,
    object: object.slice(0, 200),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.9,
    visibility: VISIBILITIES.includes(o.visibility) ? o.visibility : 'public',
    evidence: str(o.evidence).slice(0, 120),
  };
}

/** 校验并清洗一条人物状态。 */
export function sanitizeState(s, aliasIndex) {
  const o = obj(s);
  const who = canonicalize(o.who, aliasIndex);
  const field = str(o.field);
  const value = str(o.value);
  if (!who || !STATE_FIELDS.includes(field) || !value) return null;
  if (field === 'life_state') {
    const state = asLifeState(value);
    // 枚举外的写法（例如模型写「已死」「战死」）不静默丢：退回 status 保留原文，
    // 让场记单还能显示，同时旧关键词兜底仍可能接住。不在此处做同义词映射。
    if (!state) return { who, field: 'status', value: value.slice(0, 200) };
    return { who, field, value: state };
  }
  return { who, field, value: value.slice(0, 200) };
}

const CODEX_REVEALS = ['public', 'rumor', 'secret'];

const asCleanList = (v, max = 12) => arr(v)
  .map((x) => str(x).slice(0, 120))
  .filter(Boolean)
  .slice(0, max);

/** 新登场实体只收渲染需要的字段，并截断长度，避免模型塞进无限细节。 */
function sanitizeIntroduce(kind, fields, name) {
  const f = obj(fields);
  if (kind === PERSON_TYPE) {
    const out = { name: name.slice(0, 60), type: PERSON_TYPE };
    for (const k of ['role', 'summary', 'status', 'condition', 'mood', 'location', 'goal']) {
      if (str(f[k])) out[k] = str(f[k]).slice(0, 200);
    }
    if (arr(f.aliases).length) out.aliases = asCleanList(f.aliases);
    const knowledge = obj(f.knowledge);
    if (Object.keys(knowledge).length) {
      out.knowledge = {};
      for (const k of ['knows', 'does_not_know', 'believes_falsely']) {
        if (arr(knowledge[k]).length) out.knowledge[k] = asCleanList(knowledge[k]);
      }
    }
    const psyche = obj(f.psyche);
    if (Object.keys(psyche).length) {
      out.psyche = {};
      for (const k of ['traits', 'wants', 'fears', 'hides', 'values']) {
        if (arr(psyche[k]).length) out.psyche[k] = asCleanList(psyche[k]);
      }
    }
    return out;
  }
  const type = ENTITY_TYPES.includes(kind) && kind !== PERSON_TYPE ? kind : 'custom';
  const out = {
    name: name.slice(0, 60),
    type,
  };
  for (const k of ['summary', 'detail', 'sensory', 'history', 'parent_id']) {
    if (str(f[k])) out[k] = str(f[k]).slice(0, 400);
  }
  if (str(f.reveal)) out.reveal = CODEX_REVEALS.includes(f.reveal) ? f.reveal : 'public';
  for (const k of ['aliases', 'tags', 'links']) {
    if (arr(f[k]).length) out[k] = asCleanList(f[k]);
  }
  const facets = obj(f.facets);
  if (Object.keys(facets).length) {
    out.facets = {};
    for (const k of ['sensory', 'history']) {
      if (str(facets[k])) out.facets[k] = str(facets[k]).slice(0, 400);
    }
    for (const k of ['rules', 'consequences']) {
      if (arr(facets[k]).length) out.facets[k] = asCleanList(facets[k]);
    }
  }
  return out;
}

/**
 * 从正文里吸收「名字的前缀简称」（D13-A1）。
 *
 * 中文叙事里用简称指代长名是默认行为：「蛇纹圆印纸」在正文里被简称 11 次，
 * 而 `aliases` 只能由卡作者或 introduce 一次性声明——于是任何长名物品一旦被简称，
 * 就永久写不进账本（`skipped_targets` 里反复出现同一个名字）。
 *
 * 判据**必须确定性、不猜**：只收 name 的前缀，且该前缀在正文里真的出现过。
 * 不做「首 2 字 + 末 1 字」这类组合——那是在猜作者怎么简称，属于 §1.2 禁止的识别器堆叠。
 * 代价是抓不到中段省略式简称（`蛇纹纸` 不是 `蛇纹圆印纸` 的连续子串），
 * 但那部分由 `skipped_targets` 可见化兜住，不假装有解。
 *
 * @returns {string[]} 最多 1 个：最短的那个命中前缀（更长前缀对匹配是冗余的）
 */
function prefixesFoundIn(name, narrative, taken) {
  const n = str(name);
  const t = str(narrative);
  if (n.length < 3 || !t) return [];
  for (let len = 2; len < n.length; len += 1) {
    const sub = n.slice(0, len);
    if (taken.has(sub)) continue;
    if (t.includes(sub)) return [sub];
  }
  return [];
}

/**
 * 校验一条实体变更提案。
 *
 * 只放行 state-paths 白名单；身份根（id/name/identity）不可写。
 * 未知实体默认当作「本世界线临时登场」，不会写回世界卡。
 */
export function sanitizeChange(raw, { aliasIndex = [], playerName = '', narrative = '' } = {}) {
  const o = obj(raw);
  const op = str(o.op) || (o.fields ? 'introduce' : 'set');
  if (!['set', 'add', 'remove', 'introduce', 'delta'].includes(op)) return null;
  let kind = str(o.kind);
  if (!ENTITY_KINDS.includes(kind)) return null;

  if (op === 'introduce') {
    if (!ENTITY_TYPES.includes(kind)) return null;
    const fields = obj(o.fields || o.value);
    const name = str(fields.name || o.id);
    if (!name) return null;
    const value = sanitizeIntroduce(kind, fields, name);
    // D13-A1：把正文里真的出现过的**名字前缀**收成别名。
    // 落在这里而不是提示词里：模型不需要知道这件事，代码一次性吸收。
    const taken = new Set([name, ...(value.aliases || [])]);
    const shorts = prefixesFoundIn(name, narrative, taken);
    if (shorts.length) value.aliases = [...(value.aliases || []), ...shorts];
    return {
      kind,
      entity_id: str(o.id) || slugify(name),
      path: '',
      op,
      value,
      name,
      ...(shorts.length ? { aliases_from_narrative: shorts } : {}),
    };
  }

  const rawName = str(o.id || o.name || o.who || o.entity);
  if (!rawName) return null;
  const path = str(o.path);

  let entityId = rawName;
  if (kind === 'player') {
    entityId = 'player';
  } else if (playerName && rawName === playerName) {
    kind = 'player';
    entityId = 'player';
  } else {
    const resolved = resolveEntity(rawName, aliasIndex);
    if (resolved.type) {
      kind = resolved.type;
      entityId = resolved.id;
    } else {
      // D13-A1：简称（「蛇纹纸」→「蛇纹圆印纸」）不是别名也不是 id，
      // 上面查不到。再用一次实体链接（红线 2 唯一允许的字符串匹配）看它是不是
      // 指向了某个**已存在**的实体：唯一命中才归一，多命中就保持原样（交给白名单判）。
      const linked = linkEntities(rawName, aliasIndex);
      const ids = [...linked.person, ...linked.fact];
      if (ids.length === 1) {
        const hit = (aliasIndex || []).find((x) => x.id === ids[0]);
        if (hit) {
          kind = hit.type;
          entityId = hit.id;
        }
      }
    }
  }

  // 事实实体的定义（summary/detail/facets.history）是作者公理：已有条目只能写运行态，
  // 想新增定义必须走 introduce（上面已返回）。人物没有这个限制。
  if (kind !== PERSON_TYPE && FACT_CANON_PATHS.has(path)) return null;

  // 先按别名归一实体类型，再按最终类型校验路径。
  const allowed = pathsFor(kind);
  if (!allowed || !allowed.has(path)) return null;

  const isList = LIST_PATH_SET.has(path);
  if ((op === 'add' || op === 'remove') && !isList) return null;
  if (op === 'set' && isList) return null;

  // 数值路径：值必须是数字，路径本身也不能是列表。delta 只对数值路径合法——
  // 「模型写一个数字」不能把任意字符串路径变成数值路径（路径的性质由白名单决定）。
  // 注意 Number('') 与 Number(null) 都是 0：空值必须判非法，否则「没写金额」会被当成「余额归零」。
  const isNumber = isNumberPath(kind, path);
  if (op === 'delta' && !isNumber) return null;
  if (isNumber) {
    if (op !== 'set' && op !== 'delta') return null;
    const n = typeof o.value === 'number'
      ? o.value
      : (typeof o.value === 'string' && o.value.trim() !== '' ? Number(o.value) : NaN);
    if (!Number.isFinite(n)) return null;
    return { kind, entity_id: entityId, path, op, value: Math.round(n * 100) / 100 };
  }

  let value = o.value;
  if (kind !== PERSON_TYPE && path === 'reveal') {
    value = CODEX_REVEALS.includes(str(value)) ? str(value) : null;
    if (!value) return null;
  }
  if (path === 'life_state') {
    const state = asLifeState(value);
    // 与 sanitizeState 同口径：枚举外不静默丢，退回 status 保留原文。
    if (!state) {
      const raw = str(value);
      if (!raw) return null;
      return { kind, entity_id: entityId, path: 'status', op: 'set', value: raw.slice(0, 300) };
    }
    value = state;
  }
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    value = text.slice(0, 300);
  }
  return { kind, entity_id: entityId, path, op, value };
}

/**
 * 把账本增量合并进旧账本。
 * 规则：标量出现即覆盖；characters 逐键合并（键先归一）；
 * 物品按名增删；目标按 goal 精确匹配更新，否则新增。
 */
export function mergeLedger(oldState, delta, { aliasIndex = [] } = {}) {
  const base = obj(oldState);
  const d = obj(delta);
  const next = { ...base };

  for (const k of ['time', 'place', 'weather', 'last_hook']) {
    if (str(d[k])) next[k] = str(d[k]);
  }
  // place_id 允许显式清空：地点换了但没有对应实体时，不能沿用旧地点的 id。
  if (d.place_id !== undefined) next.place_id = str(d.place_id);
  // null / 缺省表示「这一拍没有新信息」，不能把张力清零。
  if (d.tension != null && d.tension !== '' && Number.isFinite(Number(d.tension))) {
    next.tension = Math.max(0, Math.min(1, Number(d.tension)));
  }

  const characters = obj(next.characters);
  for (const [rawWho, fields] of Object.entries(obj(d.characters))) {
    const who = canonicalize(rawWho, aliasIndex);
    if (!who) continue;
    characters[who] = { ...(characters[who] || {}), ...obj(fields) };
  }
  next.characters = characters;

  // 在场是「这一拍镜头里的人物」，不是「账本里出现过的所有人」。
  if (Array.isArray(d.present)) {
    const present = [];
    const seen = new Set();
    for (const raw of d.present) {
      const who = canonicalize(raw, aliasIndex) || str(raw);
      if (!who || seen.has(who)) continue;
      seen.add(who);
      present.push(who);
    }
    next.present = present;
  }

  const inventory = arr(next.inventory).map((i) => (typeof i === 'string' ? { name: i, holder: '' } : { ...obj(i) }));
  const remove = new Set(arr(d.inventory_remove).map((x) => str(typeof x === 'string' ? x : obj(x).name)).filter(Boolean));
  for (const raw of arr(d.inventory_add)) {
    const name = str(typeof raw === 'string' ? raw : obj(raw).name);
    if (!name || remove.has(name)) continue;
    const holder = str(typeof raw === 'string' ? '' : obj(raw).holder);
    if (!inventory.some((i) => i.name === name)) inventory.push({ id: str(typeof raw === 'string' ? '' : obj(raw).id), name, holder });
  }
  next.inventory = inventory.filter((i) => !remove.has(i.name));

  const quests = arr(next.quests).map((q) => ({ ...obj(q) }));
  for (const q of arr(d.quests_add)) {
    const goal = str(typeof q === 'string' ? q : obj(q).goal);
    if (goal && !quests.some((x) => x.goal === goal)) {
      quests.push({ goal, status: str(obj(q).status) || 'active', progress: str(obj(q).progress) });
    }
  }
  for (const q of arr(d.quests_update)) {
    const o = obj(q);
    const goal = str(o.goal);
    const hit = quests.find((x) => x.goal === goal);
    if (hit) {
      if (str(o.progress)) hit.progress = str(o.progress);
      if (str(o.status)) hit.status = str(o.status);
    } else if (goal) {
      quests.push({ goal, status: str(o.status) || 'active', progress: str(o.progress) });
    }
  }
  next.quests = quests.slice(-12);

  if (arr(d.theme_tags).length) next.theme_tags = arr(d.theme_tags).map(str).filter(Boolean);

  return next;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* JSON 解析容错                                                          */
/* ══════════════════════════════════════════════════════════════════════ */

function tryParseJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* 落到打捞 */ } }
  return null;
}

function escapeRawControlCharsInStrings(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : code === 0x09 ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

const EMPTY_UPDATE = {
  scene_change: { changed: false, reason: '', when: '', place: '', place_id: '', weather: '', tension: null, present: [] },
  ledger: { characters: {}, inventory_add: [], inventory_remove: [], quests_add: [], quests_update: [], last_hook: '', theme_tags: [] },
  assertions: [], changes: [], states: [], relations: [], threads: [], quotes: [], uncertain: [],
};

export function parseArchivistUpdate(content) {
  const text = escapeRawControlCharsInStrings(String(content || ''));
  const parsed = tryParseJson(text);
  if (!isPlainObject(parsed)) return { ...EMPTY_UPDATE };
  const p = parsed;

  const scene = obj(p.scene_change);
  const ledger = obj(p.ledger);
  const characters = {};
  for (const [who, fields] of Object.entries(obj(ledger.characters))) {
    const f = obj(fields);
    // 字段白名单与 STATE_FIELDS 同源；只收非空值，避免空串把账本里的旧值覆盖掉。
    const out = {};
    for (const key of STATE_FIELDS) {
      const v = str(f[key]);
      if (v) out[key] = v;
    }
    characters[who] = out;
  }

  return {
    scene_change: {
      changed: !!scene.changed,
      reason: str(scene.reason),
      when: str(scene.when),
      place: str(scene.place),
      place_id: str(scene.place_id),
      weather: str(scene.weather),
      tension: scene.tension != null && scene.tension !== '' && Number.isFinite(Number(scene.tension))
        ? Number(scene.tension)
        : null,
      present: arr(scene.present).map(str).filter(Boolean),
    },
    ledger: {
      characters,
      inventory_add: arr(ledger.inventory_add),
      inventory_remove: arr(ledger.inventory_remove).map((x) => str(typeof x === 'string' ? x : obj(x).name)),
      quests_add: arr(ledger.quests_add),
      quests_update: arr(ledger.quests_update),
      last_hook: str(ledger.last_hook),
      theme_tags: arr(ledger.theme_tags).map(str).filter(Boolean),
    },
    assertions: arr(p.assertions),
    changes: arr(p.changes),
    states: arr(p.states),
    relations: arr(p.relations),
    threads: arr(p.threads),
    quotes: arr(p.quotes),
    uncertain: arr(p.uncertain).map(str).filter(Boolean),
  };
}

/* ── 解析失败的补救协议 ────────────────────────────────────────────────
 * 只用于「重试一次」：把坏输出与错误回灌给模型，要求它只重发 JSON。
 * 不改 system、不新增注入点；正常路径永远不会走到这里。 */
export function buildArchivistRetryMessages(baseMessages, badContent, error) {
  const raw = String(badContent || '').slice(0, 2000);
  return [
    ...baseMessages,
    { role: 'assistant', content: raw || '（上一轮回复为空）' },
    {
      role: 'user',
      content: `你上一次的回复无法解析成 JSON（${error || '格式错误'}）。`
        + '请只输出一个符合要求的 JSON 对象：不要代码块、不要解释、不要任何前后缀；'
        + '字段与内容按上一条要求重写，能确认的保留，其余留空。',
    },
  ];
}

/** 严格解析：只有顶层是 JSON 对象才算成功；失败返回原因，供重试与留痕。 */
export function parseArchivistUpdateStrict(content) {
  const text = escapeRawControlCharsInStrings(String(content || ''));
  const parsed = tryParseJson(text);
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: String(content || '').trim() ? '输出不是合法 JSON 对象' : '输出为空',
      update: { ...EMPTY_UPDATE },
    };
  }
  return { ok: true, error: '', update: parseArchivistUpdate(content) };
}

/** 合并两次调用的 usage：token 相加、耗时相加、tps 置空（混算没有意义）。 */
function mergeUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...a };
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens', 'output_chars']) {
    out[k] = Number(a[k] || 0) + Number(b[k] || 0);
  }
  out.duration_ms = Number(a.duration_ms || 0) + Number(b.duration_ms || 0);
  out.cache_rate = out.prompt_tokens > 0
    ? Math.round((out.cached_tokens / out.prompt_tokens) * 1000) / 1000
    : null;
  out.ttft_ms = a.ttft_ms ?? b.ttft_ms ?? null;
  out.tps = null;
  return out;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 主流程                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 跑一轮史官。
 * @returns {Promise<{applied:object, scene_change:object, uncertain:string[], usage:object|null}>}
 */
export async function runArchivist({
  session, world, turnNo, playerText, narrative, branchChoice, options = {}, declaredTargets = null,
  signal, guard,
}) {
  const sessionId = session?.id;
  if (!sessionId) throw new Error('runArchivist: session.id 不能为空');
  const no = Number.isFinite(Number(turnNo)) ? Number(turnNo) : 0;
  const branchId = session.branch_id || 'main';
  const card = normalizeCard(world?.card || {});
  const aliasIndex = buildAliasIndex(card);

  const persons = (card.entities || []).filter((e) => e.type === PERSON_TYPE);
  const facts = (card.entities || []).filter((e) => e.type !== PERSON_TYPE);
  const castIndex = persons
    .map((c) => `· ${c.name}${c.aliases.length ? `（又称：${c.aliases.join('、')}）` : ''}${c.role ? `｜${c.role}` : ''}`)
    .join('\n');
  const codexIndex = facts
    .slice(0, 60)
    .map((e) => `· ${e.name}${e.aliases.length ? `（${e.aliases.join('、')}）` : ''}${e.summary ? `｜${e.summary}` : ''}`)
    .join('\n');
  // 给模型的未回收线索清单必须与**场记单渲染的那一份**同源同长（THREAD_RENDER_MAX）。
  // 上限 = 渲染容量之后这里永远拿得到全部，所以 `resolve` 的「title 完全一致」
  // 不再是「清单太长、末位看不见」的问题，而只是一层防误匹配的保护，保留。
  const openThreads = getThreads(sessionId, { branchId, status: 'open', limit: THREAD_RENDER_MAX })
    .map((t) => t.title);

  const baseMessages = [
    { role: 'system', content: archivistSystemPrompt() },
    {
      role: 'user',
      content: archivistUserPrompt({
        turnNo: no, playerText, branchChoice, narrative,
        castIndex, codexIndex, openThreads, threadLimit: THREAD_RENDER_MAX,
        playerName: card.player?.name,
      }),
    },
  ];
  const callOpts = {
    agent: 'archivist',
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    reasoningEffort: options.reasoningEffort,
    model: options.model,
    responseFormat: { type: 'json_object' },
    signal,
  };

  const res = await chat({ messages: baseMessages, ...callOpts });
  let usage = res.usage || null;
  let parsed = parseArchivistUpdateStrict(res.content);
  let retried = false;
  if (!parsed.ok) {
    // 解析失败回灌一次：只重发 JSON，不改提示词结构。仍失败则写一条 failed patch，
    // 让「这一轮记忆没落」在审计里可见，而不是静默当空提案。
    retried = true;
    const retry = await chat({
      messages: buildArchivistRetryMessages(baseMessages, res.content, parsed.error),
      ...callOpts,
    });
    usage = mergeUsage(usage, retry.usage);
    parsed = parseArchivistUpdateStrict(retry.content);
    if (!parsed.ok) {
      addPatch(sessionId, {
        branch_id: branchId, agent: 'archivist', kind: 'archivist_parse_failed',
        turn_no: no, status: 'failed', severity: 'warn',
        payload: { error: parsed.error, retried: true, preview: String(retry.content || '').slice(0, 400) },
      });
      return {
        applied: {
          assertions: 0, assertions_invalidated: 0, states: 0, changes: 0,
          relations: 0, threads: 0, voices: 0, ledger: false, skipped: 0,
        },
        scene_change: { ...EMPTY_UPDATE.scene_change },
        uncertain: [],
        usage,
        parse_failed: true,
        retried,
      };
    }
  }
  const update = parsed.update;

  // 分支守卫：旁路调用期间用户可能 rollback / rewrite。分支变了就整批丢弃，
  // 不让旧线的提案写进新线（新线会从自己的分叉点状态重建）。
  if (typeof guard === 'function' && !guard()) {
    addPatch(sessionId, {
      branch_id: branchId, agent: 'archivist', kind: 'stale', turn_no: no, status: 'stale',
      severity: 'info', payload: { reason: 'branch changed during archivist call' },
    });
    return {
      applied: {
        assertions: 0, assertions_invalidated: 0, states: 0, changes: 0,
        relations: 0, threads: 0, voices: 0, ledger: false, skipped: 0,
      },
      scene_change: update.scene_change, uncertain: update.uncertain,
      usage, stale: true,
    };
  }

  const applied = applyArchivistUpdate({
    sessionId, branchId, turnNo: no, update, aliasIndex, playerName: card.player?.name || '',
    declaredTargets, narrative,
  });
  return { applied, scene_change: update.scene_change, uncertain: update.uncertain, usage };
}

/**
 * 把地点名映射到实体 id；映射不到就是空——空只表示「这个地点没有对应条目」，
 * 不会把错实体带进上下文（`context-engine` 的地点加分是按 place_id 匹配的）。
 *
 * 两段式，两段都只做确定性匹配 + 唯一性判定，不做任何名字特判：
 *   ① 正向：地点文本 ⊇ 某 label，取**最长**命中；
 *   ② 反向：某 label ⊇ 地点文本，取**最短**命中，且必须唯一——
 *      「回春堂」要靠这一档命中「镇东回春堂」，但「别墅」会同时命中
 *      别墅/凌玥的别墅/西式别墅，歧义直接判失败，不猜。
 * @returns {string|null} 空串 = 解析失败（写空）；null = 无地点信息（保持旧值）
 */
function resolvePlaceId(place, explicitId, placeEntities) {
  const norm = (v) => str(v).replace(/[\s·・,，。、；;：:（）()【】\[\]—\-–~～→>]/g, '');
  const labelsOf = (e) => [e.name, ...(e.aliases || [])].map(norm).filter((l) => l.length >= 2);

  if (place) {
    const raw = norm(place);
    if (!raw) return '';
    let best = '';
    let bestLen = 0;
    for (const e of placeEntities) {
      for (const l of labelsOf(e)) {
        if (raw.includes(l) && l.length > bestLen) { best = e.id; bestLen = l.length; }
      }
    }
    if (best) return best;
    const cands = [];
    for (const e of placeEntities) {
      for (const l of labelsOf(e)) if (l.includes(raw)) cands.push({ id: e.id, len: l.length });
    }
    if (!cands.length) return '';
    const shortest = Math.min(...cands.map((c) => c.len));
    const uniq = new Set(cands.filter((c) => c.len === shortest).map((c) => c.id));
    return uniq.size === 1 ? cands.find((c) => c.len === shortest).id : '';
  }
  if (explicitId) {
    const hit = placeEntities.find((e) => e.id === explicitId || norm(e.name) === norm(explicitId));
    return hit ? hit.id : null;
  }
  return null;
}

/**
 * 收集本拍可见的 place 实体：卡快照（经别名索引）+ 本分支已 introduce 的地点。
 * 后者不能省——运行期新登场的地点（官道/柴房/回春堂）不在卡里，只从卡建索引
 * 会让它们的 place_id 永远是自由文本。
 */
function collectPlaceEntities(aliasIndex, sessionId, branchId, turnNo) {
  const byId = new Map();
  for (const e of aliasIndex || []) {
    if (e.type !== 'place') continue;
    const cur = byId.get(e.id) || { id: e.id, name: e.name, aliases: [] };
    if (e.alias && e.alias !== e.name) cur.aliases.push(e.alias);
    byId.set(e.id, cur);
  }
  let introduced = [];
  try {
    introduced = getWorldState(sessionId, { branchId, atTurn: turnNo });
  } catch { introduced = []; }
  for (const d of introduced) {
    if (d.entity_kind !== 'place' || d.op !== 'introduce' || !isPlainObject(d.value)) continue;
    const id = str(d.entity_id);
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      name: str(d.value.name) || id,
      aliases: Array.isArray(d.value.aliases) ? d.value.aliases.map(str).filter(Boolean) : [],
    });
  }
  return [...byId.values()];
}

/**
 * 确定性应用史官提案。所有写入都在这里发生，全部可回放、可审计。
 */
export function applyArchivistUpdate({
  sessionId, branchId, turnNo, update, aliasIndex = [], playerName = '', declaredTargets = null,
  narrative = '',
}) {
  const applied = {
    assertions: 0, assertions_invalidated: 0, states: 0, changes: 0,
    relations: 0, threads: 0, voices: 0, ledger: false, skipped: 0,
    // 这一拍真实写进去的「谁在场」证据（含 life_state 本身），供回程通道判断
    // 「他是不是自己回到镜头里了」。只做事后审计/回程用，不进任何提示词。
    onstage: [],
  };
  // 目标声明：只允许更新已登场/已声明的实体。未提供 declaredTargets 时不启用（内部/测试兼容）。
  const declaredSet = declaredSetOf(declaredTargets, aliasIndex);
  const skipped = [];
  const skipTarget = (kind, target) => { skipped.push({ kind, target: str(target) }); };
  // 被 WIP 上限/权重阈值挡下的线索提案。不静默丢：合并成一条
  // patches(kind='thread_rejected')，让「模型一直在埋、系统一直在拒」在报告里看得见。
  const rejectedThreads = [];

  // 同一批提案里，模型可能先写新角色的账本/状态/关系，再把 introduce 放进 changes。
  // 先扫一遍 introduce 纳入声明集合，避免「同拍引入的实体被自己的提案拒掉」。
  if (declaredSet) {
    for (const raw of update.changes || []) {
      const c = sanitizeChange(raw, { aliasIndex, playerName, narrative });
      if (c && c.op === 'introduce' && c.entity_id) declaredSet.add(c.entity_id);
    }
  }

  /* ---- 断言：冲突时旧断言失效，不删除 ---- */
  for (const raw of update.assertions || []) {
    const a = sanitizeAssertion(raw, aliasIndex);
    if (!a) continue;
    if (!isDeclaredTarget(a.subject, declaredSet, aliasIndex)) { skipTarget('assertion', a.subject); continue; }
    const conflicts = findConflictingAssertions(sessionId, {
      branchId, subject: a.subject, predicate: a.predicate, object: a.object, validFrom: turnNo,
    });
    const id = addAssertion(sessionId, {
      branch_id: branchId, ...a, valid_from: turnNo, asserted_turn: turnNo, source_turn: turnNo,
    });
    for (const c of conflicts) {
      invalidateAssertion(sessionId, c.id, { validTo: turnNo, supersededBy: id });
      applied.assertions_invalidated++;
    }
    addPatch(sessionId, {
      branch_id: branchId, agent: 'archivist', kind: 'assertion', turn_no: turnNo, status: 'applied',
      payload: a, evidence: a.evidence,
    });
    applied.assertions++;
  }

  /* ---- 人物状态：按字段可寻址，局部更新 ---- */
  // states 与 ledger.characters 可能写同一个字段，以 states 为准，按 (who, field) 去重。
  // 目标声明：越界人物既不进状态表，也不进账本；逐条留痕，不静默丢。
  const ledgerDelta = { ...obj(update.ledger) };
  if (declaredSet && ledgerDelta.characters) {
    const declaredChars = {};
    for (const [who, fields] of Object.entries(obj(ledgerDelta.characters))) {
      if (isDeclaredTarget(who, declaredSet, aliasIndex) || (playerName && who === playerName)) {
        declaredChars[who] = fields;
      } else {
        skipTarget('ledger', who);
      }
    }
    ledgerDelta.characters = declaredChars;
  }
  const stateItems = [];
  const seen = new Set();
  for (const s of (update.states || []).map((s) => sanitizeState(s, aliasIndex))) {
    if (!s) continue;
    if (!isDeclaredTarget(s.who, declaredSet, aliasIndex) && !(playerName && s.who === playerName)) {
      skipTarget('state', s.who);
      continue;
    }
    stateItems.push(s);
    seen.add(`${s.who}::${s.field}`);
  }
  for (const [who, fields] of Object.entries(ledgerDelta.characters || {})) {
    for (const [field, value] of Object.entries(fields)) {
      if (!str(value)) continue;
      const s = sanitizeState({ who, field, value }, aliasIndex);
      if (!s || seen.has(`${s.who}::${s.field}`)) continue;
      seen.add(`${s.who}::${s.field}`);
      stateItems.push(s);
    }
  }
  for (const s of stateItems) {
    setCharState(sessionId, { branchId, who: s.who, field: s.field, value: s.value, turn: turnNo });
    // 回程证据（D10 延伸）：这一拍写进人物状态表的每一条，都是「谁在镜头里」的结构化声明。
    // `life_state` 也记下来——同一拍模型自己声明了生死时不翻案，靠这条判断。
    applied.onstage.push({ who: s.who, field: s.field, life_state: s.field === 'life_state' ? s.value : '' });
    const ref = resolveEntity(s.who, aliasIndex);
    const isPlayer = !ref.type && playerName && s.who === playerName;
    addWorldState(sessionId, {
      branch_id: branchId,
      entity_kind: isPlayer ? 'player' : (ref.type || PERSON_TYPE),
      entity_id: isPlayer ? 'player' : (ref.id || s.who),
      path: s.field,
      op: 'set',
      value: s.value,
      turn: turnNo,
      source: 'archivist',
      evidence: 'ledger/states',
    });
    applied.states++;
  }

  /* ---- 关系账本 ---- */
  for (const raw of update.relations || []) {
    const r = obj(raw);
    const from = canonicalize(r.from, aliasIndex);
    const to = canonicalize(r.to, aliasIndex);
    if (!from || !to || from === to) continue;
    const fromOk = isDeclaredTarget(from, declaredSet, aliasIndex);
    const toOk = isDeclaredTarget(to, declaredSet, aliasIndex);
    if (!fromOk || !toOk) { skipTarget('relation', fromOk ? to : from); continue; }
    upsertRelation(sessionId, {
      branch_id: branchId,
      from, to,
      kind: str(r.kind),
      sentiment: Number.isFinite(Number(r.sentiment)) ? Math.max(-1, Math.min(1, Number(r.sentiment))) : 0,
      note: str(r.note).slice(0, 200),
      turn_no: turnNo,
    });
    applied.relations++;
  }

  /* ---- 线索账本 ---- */
  // 上限 = 场记单的渲染容量（THREAD_RENDER_MAX）：超过它，埋下的线索根本不会出现在
  // 下一拍的提示词里，等于埋了个自己看不见的东西。所以到顶就**拒绝新埋**并留痕，
  // 而不是默默写进表里假装成功。`resolve` 永远允许——它减少条数。
  for (const raw of update.threads || []) {
    const t = obj(raw);
    const title = str(t.title);
    if (!title) continue;
    const action = str(t.action) === 'resolve' ? 'resolve' : 'plant';
    if (action === 'resolve') {
      const open = getThreads(sessionId, { branchId, status: 'open', limit: 50 });
      const hit = open.find((x) => x.title === title) || open.find((x) => str(x.title) === title);
      if (hit) {
        upsertThread(sessionId, {
          branch_id: branchId, title: hit.title, status: 'resolved',
          resolved_turn: turnNo, turn_no: turnNo,
        });
        applied.threads++;
      }
      continue;
    }
    const open = getThreads(sessionId, { branchId, status: 'open', limit: 50 });
    const hit = open.find((x) => x.title === title);
    // 重复 plant（标题已存在）走更新，不受上限约束——它不是新增一条。
    if (!hit) {
      const weight = Number.isFinite(Number(t.weight))
        ? Math.max(0, Math.min(1, Number(t.weight)))
        : 0.5;
      if (weight < THREAD_MIN_WEIGHT) {
        rejectedThreads.push({ title, reason: 'low_weight', weight });
        continue;
      }
      if (open.length >= THREAD_RENDER_MAX) {
        rejectedThreads.push({ title, reason: 'wip_full', open: open.length });
        continue;
      }
    }
    upsertThread(sessionId, {
      branch_id: branchId,
      title: hit ? hit.title : title,
      status: 'open',
      weight: Number.isFinite(Number(t.weight)) ? Math.max(0, Math.min(1, Number(t.weight))) : 0.5,
      note: str(t.note).slice(0, 200),
      planted_turn: hit ? hit.planted_turn : turnNo,
      turn_no: turnNo,
    });
    applied.threads++;
  }

  /* ---- 原声：只收正文里真出现过的台词 ---- */
  for (const raw of update.quotes || []) {
    const q = obj(raw);
    const who = canonicalize(q.who, aliasIndex);
    const text = str(q.text);
    if (!who || !text || text.length > 60) continue;
    addVoice(sessionId, { branch_id: branchId, who, text, turn_no: turnNo, kind: 'line' });
    applied.voices++;
  }

  /* ---- 实体变更：世界线自己的运行期状态 ---- */
  for (const raw of update.changes || []) {
    const c = sanitizeChange(raw, { aliasIndex, playerName, narrative });
    if (!c) continue;
    // introduce 是唯一允许新实体的入口（且已限定 cast/codex）；其余变更受目标声明约束。
    if (declaredSet && c.op !== 'introduce' && !isDeclaredTarget(c.entity_id, declaredSet, aliasIndex)) {
      skipTarget('change', c.entity_id);
      continue;
    }
    addWorldState(sessionId, {
      branch_id: branchId,
      entity_kind: c.kind,
      entity_id: c.entity_id,
      path: c.path,
      op: c.op,
      value: c.value,
      turn: turnNo,
      source: 'archivist',
      evidence: str(obj(raw).evidence).slice(0, 120),
    });
    // D32：`life_state` 有两条写入入口（本循环的 changes 与上面的 states），但只有 states
    // 会同时写 `character_states`。changes 只写 world_state，于是同一个「离场」在
    // `character_states` 里查不到——而 `reviveNamedGone()` / `applyLifeChanges()` 读的正是
    // 那张表，回程通道因此从未对 changes 写出的 gone 生效（实测凌玥 t18 经 changes 标 gone，
    // 之后 19 拍正文都在演她，回程一次也没触发）。这里把同一条事实补进那张表，不改任何
    // 判定口径：world_state 仍是投影唯一写入口，character_states 只是它的记忆表镜像。
    if (c.kind === PERSON_TYPE && c.path === 'life_state' && c.op === 'set') {
      // `character_states` 的主键是**人物名**（`sanitizeState` 走 canonicalize 得到 name），
      // 不是实体 id。两者在卡里通常相同，但 slug 化过的 id 不同，必须按 id 反查名字。
      const named = (aliasIndex || []).find((x) => x.id === c.entity_id);
      const who = named?.name || c.entity_id;
      // 同一拍 states 已经写过这条就不再重复写：`setCharState` 每次都会把上一条的
      // valid_to 封到当拍，同拍写两次会留下零长度的一行。
      if (!seen.has(`${who}::life_state`)) {
        setCharState(sessionId, { branchId, who, field: 'life_state', value: c.value, turn: turnNo });
      }
    }
    addPatch(sessionId, {
      branch_id: branchId, agent: 'archivist', kind: 'world_change', turn_no: turnNo,
      status: 'applied', payload: c, evidence: str(obj(raw).evidence).slice(0, 120),
    });
    // 同一条回程证据：`changes` 与 `states` 是两个入口，写的都是「谁在镜头里」。
    applied.onstage.push({
      who: c.entity_id, field: c.path,
      life_state: c.path === 'life_state' && c.op === 'set' ? c.value : '',
    });
    applied.changes++;
    if (declaredSet && c.op === 'introduce' && c.entity_id) declaredSet.add(c.entity_id);
  }
  /* ---- 账本合并 ---- */
  const old = getState(sessionId, { branchId, atTurn: turnNo });
  const delta = ledgerDelta;
  const scene = update.scene_change || {};

  // place_id 只做一件事：把地点名映射到「卡里或本分支已 introduce」的 place 实体。
  // 原实现有两个洞：①解析失败时会退回 linkEntities 的**第一个**命中（不是最长），
  // 于是「老旅馆二楼房间」被别墅的别名「二楼」抢走（长跑 t59/t60 的错指）；
  // ②别名索引只从卡快照建，运行期 introduce 的官道/柴房/回春堂永远解析不到，
  // place_id 只能退化成自由文本，「当前地点 +20 分」失效。
  const placeEntities = collectPlaceEntities(aliasIndex, sessionId, branchId, turnNo);
  const placeId = resolvePlaceId(scene.place, scene.place_id, placeEntities);

  const mergedDelta = {
    ...delta,
    time: scene.when || undefined,
    place: scene.place || undefined,
    place_id: (scene.place || scene.place_id) ? placeId : undefined,
    weather: scene.weather || undefined,
    tension: scene.tension,
    present: scene.present?.length ? scene.present : undefined,
  };
  const next = mergeLedger(old?.state || {}, mergedDelta, { aliasIndex });
  next.turn_no = turnNo;
  // 账本 `present` 同样是「谁在镜头里」的结构化声明（史官读完整段正文后才敢这么写）。
  // 与人物状态表分开记：它没有对应字段，不能走 states 那条路径。
  if (scene.present?.length) {
    for (const who of next.present || []) {
      applied.onstage.push({ who, field: 'present', life_state: '' });
    }
  }
  setState(sessionId, turnNo, next, branchId);
  applied.ledger = true;

  /* ---- 未确定项：只保留提示词出口，不落库 ---- */
  // `uncertain` 是给史官的**减压阀**：允许它说「正文没明说，我不猜」，从而不必编造。
  // 但它没有消费方——不进提示词、不进 threads、没有任何 Agent 读它，45 拍长跑里积了
  // 209 条（每拍 2–5 条、去重率 0.5%），只是 `patches` 表里的噪音。
  // 所以提示词那一句保留（删了会诱发编造），写 `patches` 的这一段删掉。
  // 解析仍然保留（`parseArchivistUpdate()` 的 `uncertain` 字段）：模型输出里还有这个键，
  // 不解析会落进未知字段。它现在只是「模型自述的思考痕迹」，用完即弃。

  /* ---- 目标声明：越界提案留痕（不静默丢，也不阻断同批合法写入） ---- */
  applied.skipped = skipped.length;
  if (skipped.length) {
    addPatch(sessionId, {
      branch_id: branchId, agent: 'archivist', kind: 'skipped_targets', turn_no: turnNo,
      status: 'skipped', severity: 'warn', evidence: 'declared-targets',
      payload: { total: skipped.length, items: skipped.slice(0, 50) },
    });
  }

  /* ---- 线索被拒留痕：WIP 到顶 / 权重太低 ---- */
  // 和 skipped_targets 同一个口径：不写进提示词、不占预算，只让「写了但没落库」不失踪。
  applied.threads_rejected = rejectedThreads.length;
  if (rejectedThreads.length) {
    addPatch(sessionId, {
      branch_id: branchId, agent: 'archivist', kind: 'thread_rejected', turn_no: turnNo,
      status: 'rejected', severity: 'info', evidence: 'thread-wip',
      payload: {
        total: rejectedThreads.length,
        wip_limit: THREAD_RENDER_MAX,
        items: rejectedThreads.slice(0, 20),
      },
    });
  }

  return applied;
}

