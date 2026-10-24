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
import { config } from '../config.js';
import { chat } from '../llm.js';
import {
  CODEX_TYPES, buildAliasIndex, linkEntities, normalizeCard, resolveEntity, slugify,
} from '../world/schema.js';
import {
  CODEX_CANON_PATHS, LIST_PATH_SET, ENTITY_KINDS, pathsFor,
} from '../world/state-paths.js';
import {
  addAssertion, addPatch, addVoice, addWorldState, findConflictingAssertions, getState, getThreads,
  invalidateAssertion, setCharState, setState, upsertRelation, upsertThread,
} from '../memory/store.js';
import {
  PREDICATES, STATE_FIELDS, VISIBILITIES, archivistSystemPrompt, archivistUserPrompt,
} from '../prompts/archivist.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
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
  if (kind === 'cast') {
    const out = { name: name.slice(0, 60) };
    for (const k of ['role', 'one_line', 'status', 'condition', 'mood', 'location', 'goal']) {
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
      for (const k of ['wants', 'fears', 'hides', 'values']) {
        if (arr(psyche[k]).length) out.psyche[k] = asCleanList(psyche[k]);
      }
    }
    return out;
  }
  const out = {
    name: name.slice(0, 60),
    type: CODEX_TYPES.includes(f.type) ? f.type : 'custom',
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
 * 校验一条实体变更提案。
 *
 * 只放行 state-paths 白名单；身份根（id/name/identity）不可写。
 * 未知实体默认当作「本世界线临时登场」，不会写回世界卡。
 */
export function sanitizeChange(raw, { aliasIndex = [], playerName = '' } = {}) {
  const o = obj(raw);
  const op = str(o.op) || (o.fields ? 'introduce' : 'set');
  if (!['set', 'add', 'remove', 'introduce'].includes(op)) return null;
  let kind = str(o.kind);
  if (!ENTITY_KINDS.includes(kind)) return null;

  if (op === 'introduce') {
    if (kind !== 'cast' && kind !== 'codex') return null;
    const fields = obj(o.fields || o.value);
    const name = str(fields.name || o.id);
    if (!name) return null;
    return {
      kind,
      entity_id: str(o.id) || slugify(name),
      path: '',
      op,
      value: sanitizeIntroduce(kind, fields, name),
      name,
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
    if (resolved.kind === 'cast' || resolved.kind === 'codex') {
      kind = resolved.kind;
      entityId = resolved.id;
    }
  }

  // 辞书定义（summary/detail/facets.history）是作者公理：已有条目只能写运行态，
  // 想新增定义必须走 introduce（上面已返回）。
  if (kind === 'codex' && CODEX_CANON_PATHS.has(path)) return null;

  // 先按别名归一实体类型，再按最终类型校验路径。
  const allowed = pathsFor(kind);
  if (!allowed || !allowed.has(path)) return null;

  const isList = LIST_PATH_SET.has(path);
  if ((op === 'add' || op === 'remove') && !isList) return null;
  if (op === 'set' && isList) return null;

  let value = o.value;
  if (kind === 'codex' && path === 'reveal') {
    value = CODEX_REVEALS.includes(str(value)) ? str(value) : null;
    if (!value) return null;
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
    characters[who] = {
      condition: str(obj(fields).condition),
      mood: str(obj(fields).mood),
      location: str(obj(fields).location),
      goal: str(obj(fields).goal),
    };
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

/* ══════════════════════════════════════════════════════════════════════ */
/* 主流程                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 跑一轮史官。
 * @returns {Promise<{applied:object, scene_change:object, uncertain:string[], usage:object|null}>}
 */
export async function runArchivist({
  session, world, turnNo, playerText, narrative, branchChoice, options = {}, signal, guard,
}) {
  const cfg = config.agents.archivist;
  const sessionId = session?.id;
  if (!sessionId) throw new Error('runArchivist: session.id 不能为空');
  const no = Number.isFinite(Number(turnNo)) ? Number(turnNo) : 0;
  const branchId = session.branch_id || 'main';
  const card = normalizeCard(world?.card || {});
  const aliasIndex = buildAliasIndex(card);

  const castIndex = (card.cast || [])
    .map((c) => `· ${c.name}${c.aliases.length ? `（又称：${c.aliases.join('、')}）` : ''}${c.role ? `｜${c.role}` : ''}`)
    .join('\n');
  const codexIndex = (card.codex || [])
    .slice(0, 60)
    .map((e) => `· ${e.name}${e.aliases.length ? `（${e.aliases.join('、')}）` : ''}${e.summary ? `｜${e.summary}` : ''}`)
    .join('\n');
  const openThreads = getThreads(sessionId, { branchId, status: 'open', limit: 12 }).map((t) => t.title);

  const res = await chat({
    messages: [
      { role: 'system', content: archivistSystemPrompt() },
      {
        role: 'user',
        content: archivistUserPrompt({
          turnNo: no, playerText, branchChoice, narrative,
          castIndex, codexIndex, openThreads, playerName: card.player?.name,
        }),
      },
    ],
    temperature: options.temperature ?? cfg.temperature,
    maxTokens: options.maxTokens ?? cfg.maxTokens,
    reasoningEffort: options.reasoningEffort ?? cfg.reasoningEffort,
    model: options.model ?? cfg.model ?? undefined,
    responseFormat: { type: 'json_object' },
    signal,
  });

  const update = parseArchivistUpdate(res.content);

  // 分支守卫：旁路调用期间用户可能 rollback / rewrite。分支变了就整批丢弃，
  // 不让旧线的提案写进新线（新线会从自己的分叉点状态重建）。
  if (typeof guard === 'function' && !guard()) {
    addPatch(sessionId, {
      branchId, agent: 'archivist', kind: 'stale', turn_no: no, status: 'stale',
      severity: 'info', payload: { reason: 'branch changed during archivist call' },
    });
    return {
      applied: {
        assertions: 0, assertions_invalidated: 0, states: 0, changes: 0,
        relations: 0, threads: 0, voices: 0, ledger: false,
      },
      scene_change: update.scene_change, uncertain: update.uncertain,
      usage: res.usage || null, stale: true,
    };
  }

  const applied = applyArchivistUpdate({
    sessionId, branchId, turnNo: no, update, aliasIndex, playerName: card.player?.name || '',
  });
  return { applied, scene_change: update.scene_change, uncertain: update.uncertain, usage: res.usage || null };
}

/**
 * 确定性应用史官提案。所有写入都在这里发生，全部可回放、可审计。
 */
export function applyArchivistUpdate({
  sessionId, branchId, turnNo, update, aliasIndex = [], playerName = '',
}) {
  const applied = {
    assertions: 0, assertions_invalidated: 0, states: 0, changes: 0,
    relations: 0, threads: 0, voices: 0, ledger: false,
  };

  /* ---- 断言：冲突时旧断言失效，不删除 ---- */
  for (const raw of update.assertions || []) {
    const a = sanitizeAssertion(raw, aliasIndex);
    if (!a) continue;
    const conflicts = findConflictingAssertions(sessionId, {
      branchId, subject: a.subject, predicate: a.predicate, object: a.object, validFrom: turnNo,
    });
    const id = addAssertion(sessionId, {
      branchId, ...a, valid_from: turnNo, asserted_turn: turnNo, source_turn: turnNo,
    });
    for (const c of conflicts) {
      invalidateAssertion(sessionId, c.id, { validTo: turnNo, supersededBy: id });
      applied.assertions_invalidated++;
    }
    addPatch(sessionId, {
      branchId, agent: 'archivist', kind: 'assertion', turn_no: turnNo, status: 'applied',
      payload: a, evidence: a.evidence,
    });
    applied.assertions++;
  }

  /* ---- 人物状态：按字段可寻址，局部更新 ---- */
  // states 与 ledger.characters 可能写同一个字段，以 states 为准，按 (who, field) 去重
  const stateItems = [];
  const seen = new Set();
  for (const s of (update.states || []).map((s) => sanitizeState(s, aliasIndex))) {
    if (!s) continue;
    stateItems.push(s);
    seen.add(`${s.who}::${s.field}`);
  }
  for (const [who, fields] of Object.entries(update.ledger?.characters || {})) {
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
    const ref = resolveEntity(s.who, aliasIndex);
    const isPlayer = !ref.kind && playerName && s.who === playerName;
    addWorldState(sessionId, {
      branch_id: branchId,
      entity_kind: isPlayer ? 'player' : (ref.kind || 'cast'),
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
    addVoice(sessionId, { branchId, who, text, turn_no: turnNo, kind: 'line' });
    applied.voices++;
  }

  /* ---- 实体变更：世界线自己的运行期状态 ---- */
  for (const raw of update.changes || []) {
    const c = sanitizeChange(raw, { aliasIndex, playerName });
    if (!c) continue;
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
    addPatch(sessionId, {
      branch_id: branchId, agent: 'archivist', kind: 'world_change', turn_no: turnNo,
      status: 'applied', payload: c, evidence: str(obj(raw).evidence).slice(0, 120),
    });
    applied.changes++;
  }

  /* ---- 账本合并 ---- */
  const old = getState(sessionId, { branchId, atTurn: turnNo });
  const delta = update.ledger || {};
  const scene = update.scene_change || {};

  // 地点名能对上辞书里的 place 时，自动补 place_id；这让「当前地点」加分与
  // 地点辞书进场不再依赖模型是否手写了 id。
  let placeId = scene.place_id || '';
  if (!placeId && scene.place) {
    const resolved = resolveEntity(scene.place, aliasIndex);
    if (resolved.kind === 'codex' && resolved.type === 'place') {
      placeId = resolved.id;
    } else {
      // 「凌府门口 → 凌府天井」这类复合地名：用实体链接取最长的 place 命中。
      const hit = linkEntities(scene.place, aliasIndex).codex
        .map((id) => aliasIndex.find((e) => e.kind === 'codex' && e.id === id && e.type === 'place'))
        .find(Boolean);
      if (hit) placeId = hit.id;
    }
  }

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
  setState(sessionId, turnNo, next, branchId);
  applied.ledger = true;

  /* ---- 未确定项：交给人，不当事实 ---- */
  for (const u of update.uncertain || []) {
    addPatch(sessionId, {
      branchId, agent: 'archivist', kind: 'uncertain', turn_no: turnNo, status: 'open',
      payload: { text: u }, severity: 'minor',
    });
  }

  return applied;
}
