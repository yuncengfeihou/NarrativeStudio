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
import { buildAliasIndex, normalizeCard } from '../world/schema.js';
import {
  addAssertion, addPatch, addVoice, findConflictingAssertions, getState, getThreads,
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

/**
 * 把账本增量合并进旧账本。
 * 规则：标量出现即覆盖；characters 逐键合并（键先归一）；
 * 物品按名增删；目标按 goal 精确匹配更新，否则新增。
 */
export function mergeLedger(oldState, delta, { aliasIndex = [] } = {}) {
  const base = obj(oldState);
  const d = obj(delta);
  const next = { ...base };

  for (const k of ['time', 'place', 'place_id', 'weather', 'last_hook']) {
    if (str(d[k])) next[k] = str(d[k]);
  }
  if (Number.isFinite(Number(d.tension))) next.tension = Math.max(0, Math.min(1, Number(d.tension)));

  const characters = obj(next.characters);
  for (const [rawWho, fields] of Object.entries(obj(d.characters))) {
    const who = canonicalize(rawWho, aliasIndex);
    if (!who) continue;
    characters[who] = { ...(characters[who] || {}), ...obj(fields) };
  }
  next.characters = characters;

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
  scene_change: { changed: false, reason: '', when: '', place: '', place_id: '', weather: '', tension: null },
  ledger: { characters: {}, inventory_add: [], inventory_remove: [], quests_add: [], quests_update: [], last_hook: '', theme_tags: [] },
  assertions: [], states: [], relations: [], threads: [], quotes: [], uncertain: [],
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
      tension: Number.isFinite(Number(scene.tension)) ? Number(scene.tension) : null,
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
  session, world, turnNo, playerText, narrative, branchChoice, options = {}, signal,
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
  const openThreads = getThreads(sessionId, { status: 'open', limit: 12 }).map((t) => t.title);

  const res = await chat({
    messages: [
      { role: 'system', content: archivistSystemPrompt({ castIndex, codexIndex, openThreads, playerName: card.player?.name }) },
      { role: 'user', content: archivistUserPrompt({ turnNo: no, playerText, branchChoice, narrative }) },
    ],
    temperature: options.temperature ?? cfg.temperature,
    maxTokens: options.maxTokens ?? cfg.maxTokens,
    reasoningEffort: options.reasoningEffort ?? cfg.reasoningEffort,
    model: options.model,
    responseFormat: { type: 'json_object' },
    signal,
  });

  const update = parseArchivistUpdate(res.content);

  const applied = applyArchivistUpdate({ sessionId, branchId, turnNo: no, update, aliasIndex });
  return { applied, scene_change: update.scene_change, uncertain: update.uncertain, usage: res.usage || null };
}

/**
 * 确定性应用史官提案。所有写入都在这里发生，全部可回放、可审计。
 */
export function applyArchivistUpdate({ sessionId, branchId, turnNo, update, aliasIndex = [] }) {
  const applied = { assertions: 0, assertions_invalidated: 0, states: 0, relations: 0, threads: 0, voices: 0, ledger: false };

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
    applied.states++;
  }

  /* ---- 关系账本 ---- */
  for (const raw of update.relations || []) {
    const r = obj(raw);
    const from = canonicalize(r.from, aliasIndex);
    const to = canonicalize(r.to, aliasIndex);
    if (!from || !to || from === to) continue;
    upsertRelation(sessionId, {
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
      const open = getThreads(sessionId, { status: 'open', limit: 50 });
      const hit = open.find((x) => x.title === title) || open.find((x) => str(x.title) === title);
      if (hit) {
        upsertThread(sessionId, { title: hit.title, status: 'resolved', resolved_turn: turnNo });
        applied.threads++;
      }
      continue;
    }
    const open = getThreads(sessionId, { status: 'open', limit: 50 });
    const hit = open.find((x) => x.title === title);
    upsertThread(sessionId, {
      title: hit ? hit.title : title,
      status: 'open',
      weight: Number.isFinite(Number(t.weight)) ? Math.max(0, Math.min(1, Number(t.weight))) : 0.5,
      note: str(t.note).slice(0, 200),
      planted_turn: hit ? hit.planted_turn : turnNo,
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

  /* ---- 账本合并 ---- */
  const old = getState(sessionId);
  const delta = update.ledger || {};
  const scene = update.scene_change || {};
  const mergedDelta = {
    ...delta,
    time: scene.when || undefined,
    place: scene.place || undefined,
    place_id: scene.place_id || undefined,
    weather: scene.weather || undefined,
    tension: scene.tension,
  };
  const next = mergeLedger(old?.state || {}, mergedDelta, { aliasIndex });
  setState(sessionId, turnNo, next);
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
