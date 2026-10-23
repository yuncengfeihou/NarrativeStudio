/**
 * server/agents/memory-agent.js — 记忆 Agent
 *
 * 每轮结束后：
 *   1) 调 LLM 产出「本轮记忆包」（summary / entities / facts / state_delta / relations / threads）
 *   2) L1 摘要落库；实体与事实 upsert
 *   3) state_delta 用确定性代码合并（不调 LLM，零成本、可测试）
 *   4) relations / threads 用相似度去重后 upsert
 *   5) 触发层级压缩（compressor）
 *   6) 每 N 轮触发反思（reflection）
 *
 * 容错：JSON 解析失败会走「打捞 → 降级」链，绝不抛错中断回合。
 * 只有上游 LLM 调用失败（网络/5xx）才向上抛，由 orchestrator 决定是否重试。
 */
import { config } from '../config.js';
import { chat } from '../llm.js';
import * as store from '../memory/store.js';
import {
  memorySystemPrompt, roundMemoryUserPrompt, reflectionSystemPrompt, reflectionUserPrompt,
} from '../prompts/memory.js';

const MAX_SUMMARY_FALLBACK = 500;

const RESERVED_DELTA_KEYS = new Set(['inventory_add', 'inventory_remove', 'quests_update']);

const SALVAGE_STRING_KEYS = ['time', 'location', 'weather', 'last_hook'];
const SALVAGE_ARRAY_KEYS = ['inventory_add', 'inventory_remove'];

const CHARACTER_NAME_DENY = new Set([
  'type', 'name', 'summary', 'attributes', 'entities', 'facts', 'branches', 'scene_summary',
  'state_delta', 'characters', 'quests', 'threads', 'inventory', 'round_summary', 'goal',
  'progress', 'status', 'subject', 'predicate', 'object', 'confidence', 'importance', 'id',
  'title', 'description', 'tone', 'tension_delta', 'turn_no', 'level', 'content',
  'weather', 'time', 'location', 'last_hook', 'relations', 'from', 'to', 'kind', 'note',
  'sentiment', 'action', 'weight', 'inventory_add', 'inventory_remove', 'quests_update',
]);

const MAX_THREADS = 16;
const MAX_QUESTS = 8;
const MAX_INVENTORY = 40;
const MAX_RELATIONS = 60;

/** 相似度阈值：超过即视为同一条线索/目标。 */
const SIMILARITY_THRESHOLD = 0.62;

/* ══════════════════════════════════════════════════════════════════════ */
/* 文本相似度（中文短句）                                                  */
/* ══════════════════════════════════════════════════════════════════════ */

function bigrams(s) {
  const t = String(s || '').replace(/[\s，。、；：""''（）()《》【】「」『』·…—\-]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (!set.size && t.length) set.add(t);
  return set;
}

function normalize(s) {
  return String(s || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s，。、；：""''「」『』（）()《》【】…—\-·]/g, '');
}

function lcsLength(a, b) {
  if (!a || !b) return 0;
  const n = a.length;
  const m = b.length;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  let best = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev; prev = cur; cur = tmp;
    cur.fill(0);
  }
  return best;
}

/**
 * 相似度：取 bigram Jaccard 与最长公共子串占比的较大值。
 * 前者稳定，后者能吸收「同一条线索被追加限定语」的情况。
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = bigrams(na);
  const B = bigrams(nb);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const jaccard = (A.size + B.size - inter) > 0 ? inter / (A.size + B.size - inter) : 0;
  const lcs = lcsLength(na, nb) / Math.min(na.length, nb.length);
  return Math.max(jaccard, lcs);
}

function mergeDedup(base, incoming, max) {
  const out = base.slice();
  for (const raw of incoming) {
    const item = String(raw || '').trim();
    if (!item) continue;
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      if (similarity(out[i], item) >= SIMILARITY_THRESHOLD) {
        if (item.length > out[i].length + 2) out[i] = item;
        merged = true;
        break;
      }
    }
    if (!merged) out.push(item);
  }
  return out.length > max ? out.slice(out.length - max) : out;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 小工具                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
const asArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
const asStringArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function deepClone(v) {
  if (!isPlainObject(v) && !Array.isArray(v)) return v;
  return structuredClone(v);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || v === null) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : deepClone(v);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* state 合并（纯函数，可单测）                                            */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 把 state_delta 合并进旧 state。
 * 规则：
 *   - 标量（time/location/weather/tension/last_hook）出现即覆盖
 *   - characters 逐键深合并，未提及的角色原样保留
 *   - inventory_add 追加去重 → inventory_remove 移除（remove 优先）
 *   - quests_update 按 goal 模糊匹配更新，未命中则新增
 */
export function mergeState(oldState, delta) {
  const base = isPlainObject(oldState) ? oldState : {};
  const d = isPlainObject(delta) ? delta : {};
  const next = deepClone(base);

  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    if (RESERVED_DELTA_KEYS.has(k)) continue;
    if (isPlainObject(v) && isPlainObject(next[k])) next[k] = deepMerge(next[k], v);
    else next[k] = deepClone(v);
  }

  const inventory = Array.isArray(next.inventory) ? next.inventory.slice() : [];
  const grew = mergeDedup(inventory, asStringArray(d.inventory_add), MAX_INVENTORY);
  const removeSet = new Set(asStringArray(d.inventory_remove));
  next.inventory = grew.filter((item) => !removeSet.has(item));

  const quests = Array.isArray(next.quests) ? next.quests.map((q) => deepClone(q)) : [];
  for (const upd of asArray(d.quests_update)) {
    const goal = typeof upd === 'string' ? upd : upd?.goal;
    if (!goal || typeof goal !== 'string') continue;
    const hit = quests.find((q) => q && q.goal === goal)
      || quests.find((q) => q && q.goal && similarity(q.goal, goal) >= SIMILARITY_THRESHOLD);
    if (hit) {
      if (isPlainObject(upd)) {
        for (const [k, v] of Object.entries(upd)) {
          if (k === 'goal' || v === undefined || v === null) continue;
          hit[k] = deepClone(v);
        }
      }
    } else {
      quests.push(isPlainObject(upd) ? deepClone(upd) : { goal, status: 'active' });
    }
  }
  next.quests = quests.length > MAX_QUESTS
    ? [...quests.filter((q) => q && q.status === 'active'), ...quests.filter((q) => !q || q.status !== 'active')]
      .slice(0, MAX_QUESTS)
    : quests;

  next.characters = isPlainObject(next.characters) ? next.characters : {};
  if (!Array.isArray(next.inventory)) next.inventory = [];
  if (!Array.isArray(next.quests)) next.quests = [];
  return next;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* JSON 解析与打捞                                                         */
/* ══════════════════════════════════════════════════════════════════════ */

function tryParseJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* 落到打捞 */ }
  }
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
      if (ch === '"') { out += ch; inStr = false; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : code === 0x09 ? '\\t'
          : `\\u${code.toString(16).padStart(4, '0')}`;
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

function salvageArrayOfObjects(text, key) {
  const ki = text.indexOf(`"${key}"`);
  if (ki < 0) return [];
  const bi = text.indexOf('[', ki);
  if (bi < 0) return [];
  const out = [];
  let arrDepth = 0;
  let objDepth = 0;
  let start = -1;
  for (let i = bi; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') arrDepth++;
    else if (ch === ']') {
      arrDepth--;
      if (arrDepth === 0) break;
    } else if (ch === '{') {
      objDepth++;
      if (objDepth === 1 && arrDepth === 1 && start < 0) start = i;
    } else if (ch === '}') {
      objDepth--;
      if (objDepth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* 残缺对象跳过 */ }
        start = -1;
      }
    }
  }
  return out;
}

function salvageStringValue(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = text.match(re);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

function salvageTruncatedString(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]+)$`);
  const m = text.match(re);
  if (!m) return null;
  let v = m[1];
  if (v.endsWith('\\')) v = v.slice(0, -1);
  v = v.replace(/["'\]},:\s]+$/, '');
  if (v.length < 20) return null;
  try { return JSON.parse(`"${v}"`); } catch { return v; }
}

function salvageStringArray(text, key) {
  const ki = text.indexOf(`"${key}"`);
  if (ki < 0) return [];
  const bi = text.indexOf('[', ki);
  if (bi < 0) return [];
  let inStr = false;
  let esc = false;
  let ei = -1;
  for (let i = bi + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === ']') { ei = i; break; }
  }
  if (ei < 0) return [];
  const seg = text.slice(bi + 1, ei);
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(seg))) {
    try { out.push(JSON.parse(`"${m[1]}"`)); } catch { out.push(m[1]); }
  }
  return out;
}

function salvageCharacters(text) {
  const ki = text.indexOf('"characters"');
  if (ki < 0) return {};
  const window = text.slice(ki, ki + 1500);
  const out = {};
  const re = /"([^"{}]{1,20})"\s*:\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(window))) {
    const name = m[1];
    if (CHARACTER_NAME_DENY.has(name)) continue;
    if (!/"(?:mood|status|activity)"\s*:/.test(m[2]) && !/"location"\s*:/.test(m[2])) continue;
    try { out[name] = JSON.parse(`{${m[2]}}`); } catch { /* 跳过 */ }
  }
  return out;
}

function salvageMemoryUpdate(text) {
  if (!text || !text.includes('"round_summary"')) return null;

  const masked = text.replace(/"round_summary"\s*:\s*"(?:[^"\\]|\\.)*"/, (m) => ' '.repeat(m.length));

  const round_summary = salvageStringValue(text, 'round_summary')
    || salvageTruncatedString(text, 'round_summary') || '';

  const entities = salvageArrayOfObjects(masked, 'entities')
    .filter((o) => isPlainObject(o) && typeof o.type === 'string' && typeof o.name === 'string');
  const facts = salvageArrayOfObjects(masked, 'facts')
    .filter((o) => isPlainObject(o) && typeof o.subject === 'string' && typeof o.predicate === 'string');
  const relations = salvageArrayOfObjects(masked, 'relations')
    .filter((o) => isPlainObject(o) && typeof o.from === 'string' && typeof o.to === 'string');
  const threads = salvageArrayOfObjects(masked, 'threads')
    .filter((o) => isPlainObject(o) && typeof o.title === 'string' && o.title);

  const state_delta = {};
  for (const k of SALVAGE_STRING_KEYS) {
    const v = salvageStringValue(masked, k);
    if (typeof v === 'string' && v) state_delta[k] = v;
  }
  const tension = masked.match(/"tension"\s*:\s*(-?\d+(?:\.\d+)?)/);
  if (tension) state_delta.tension = Number(tension[1]);
  for (const k of SALVAGE_ARRAY_KEYS) {
    const arr = salvageStringArray(masked, k);
    if (arr.length) state_delta[k] = arr;
  }
  const characters = salvageCharacters(masked);
  if (Object.keys(characters).length) state_delta.characters = characters;
  const quests = salvageArrayOfObjects(masked, 'quests_update')
    .filter((o) => isPlainObject(o) && typeof o.goal === 'string' && o.goal);
  if (quests.length) state_delta.quests_update = quests;

  if (!round_summary && !entities.length && !facts.length && !Object.keys(state_delta).length
    && !relations.length && !threads.length) return null;
  return { round_summary, entities, facts, state_delta, relations, threads };
}

export function parseMemoryUpdate(content, narrative) {
  const text = typeof content === 'string' ? escapeRawControlCharsInStrings(content) : '';
  const parsed = tryParseJson(text);
  if (isPlainObject(parsed)) {
    return {
      round_summary: typeof parsed.round_summary === 'string' ? parsed.round_summary.trim() : '',
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      state_delta: isPlainObject(parsed.state_delta) ? parsed.state_delta : {},
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
    };
  }

  const salvaged = salvageMemoryUpdate(text);
  if (salvaged) return salvaged;

  const trimmed = text.trim();
  const round_summary = (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[') && trimmed.length >= 30)
    ? trimmed.slice(0, MAX_SUMMARY_FALLBACK)
    : String(narrative || '').slice(0, MAX_SUMMARY_FALLBACK);
  return { round_summary, entities: [], facts: [], state_delta: {}, relations: [], threads: [] };
}

/** 解析反思输出（同样容错）。 */
export function parseReflections(content) {
  const text = escapeRawControlCharsInStrings(String(content || ''));
  const parsed = tryParseJson(text);
  const raw = Array.isArray(parsed?.reflections)
    ? parsed.reflections
    : salvageArrayOfObjects(text, 'reflections');
  return raw
    .filter((r) => r && typeof r.content === 'string' && r.content.trim())
    .map((r) => ({
      kind: ['insight', 'relationship', 'theme', 'rule'].includes(r.kind) ? r.kind : 'insight',
      content: r.content.trim().slice(0, 160),
    }))
    .slice(0, 3);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 主流程                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 更新一轮记忆。
 * @returns {Promise<{round_summary, entities, facts, relations, threads, reflection, compressed, usage}>}
 */
export async function updateMemory({
  session, turnNo, playerText, narrative, branchChoice, options = {}, signal,
}) {
  const cfg = config.agents.memory;
  const sessionId = session?.id;
  if (!sessionId) throw new Error('updateMemory: session.id 不能为空');
  const no = Number.isFinite(Number(turnNo)) ? Number(turnNo) : store.getMaxTurnNo(sessionId) + 1;

  const priorThreads = store.getThreads(sessionId, { status: 'open', limit: 12 }).map((t) => t.title);

  const res = await chat({
    messages: [
      { role: 'system', content: memorySystemPrompt() },
      {
        role: 'user',
        content: roundMemoryUserPrompt({ turnNo: no, playerText, branchChoice, narrative, priorThreads }),
      },
    ],
    temperature: options.temperature ?? cfg.temperature,
    maxTokens: options.maxTokens ?? cfg.maxTokens,
    reasoningEffort: options.reasoningEffort ?? cfg.reasoningEffort,
    model: options.model,
    responseFormat: { type: 'json_object' },
    signal,
  });

  const update = parseMemoryUpdate(res.content, narrative);

  /* ---- L1 摘要 ---- */
  const roundSummary = update.round_summary || String(narrative || '').slice(0, MAX_SUMMARY_FALLBACK);
  store.addSummary(sessionId, { level: 1, turnFrom: no, turnTo: no, content: roundSummary });

  /* ---- 实体 ---- */
  let entityCount = 0;
  for (const e of update.entities) {
    const type = str(e?.type).trim();
    const name = str(e?.name).trim();
    if (!type || !name) continue;
    try {
      store.upsertEntity(sessionId, {
        type, name,
        summary: str(e.summary).trim(),
        attributes: isPlainObject(e.attributes) ? e.attributes : {},
        first_turn: Number.isFinite(Number(e.first_turn)) ? Number(e.first_turn) : no,
        last_turn: Number.isFinite(Number(e.last_turn)) ? Number(e.last_turn) : no,
        importance: Number.isFinite(Number(e.importance)) ? Number(e.importance)
          : (type === 'character' ? 0.8 : 0.6),
      });
      entityCount++;
    } catch (err) {
      console.warn(`[memory-agent] upsertEntity 失败（${type}/${name}）：${err?.message || err}`);
    }
  }

  /* ---- 事实 ---- */
  let factCount = 0;
  for (const f of update.facts) {
    const subject = str(f?.subject).trim();
    const predicate = str(f?.predicate).trim();
    const object = str(f?.object).trim();
    if (!subject || !predicate || !object) continue;
    try {
      store.addFact(sessionId, {
        subject, predicate, object, turn_no: no,
        confidence: Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : 0.9,
      });
      factCount++;
    } catch (err) {
      console.warn(`[memory-agent] addFact 失败：${err?.message || err}`);
    }
  }

  /* ---- 关系账本 ---- */
  let relationCount = 0;
  for (const r of update.relations) {
    const from = str(r?.from).trim();
    const to = str(r?.to).trim();
    if (!from || !to || from === to) continue;
    try {
      store.upsertRelation(sessionId, {
        from, to,
        kind: str(r.kind).trim(),
        sentiment: Math.max(-1, Math.min(1, Number(r.sentiment) || 0)),
        note: str(r.note).trim(),
        turn_no: no,
      });
      relationCount++;
    } catch (err) {
      console.warn(`[memory-agent] upsertRelation 失败：${err?.message || err}`);
    }
  }

  /* ---- 线索账本 ---- */
  let threadCount = 0;
  for (const t of update.threads) {
    const title = str(t?.title).trim();
    if (!title) continue;
    const action = str(t.action).trim();
    try {
      if (action === 'resolve') {
        // 先尝试精确标题，再用相似度匹配「同一句话的小幅改写」
        const open = store.getThreads(sessionId, { status: 'open', limit: 50 });
        const hit = open.find((x) => x.title === title)
          || open.find((x) => similarity(x.title, title) >= SIMILARITY_THRESHOLD);
        if (hit) {
          store.upsertThread(sessionId, { title: hit.title, status: 'resolved', resolved_turn: no });
          threadCount++;
        }
      } else {
        const open = store.getThreads(sessionId, { status: 'open', limit: 50 });
        const hit = open.find((x) => x.title === title)
          || open.find((x) => similarity(x.title, title) >= SIMILARITY_THRESHOLD);
        store.upsertThread(sessionId, {
          title: hit ? hit.title : title,
          status: 'open',
          weight: Number.isFinite(Number(t.weight)) ? Number(t.weight) : 0.5,
          note: str(t.note).trim(),
          planted_turn: hit ? hit.planted_turn : no,
        });
        threadCount++;
      }
    } catch (err) {
      console.warn(`[memory-agent] upsertThread 失败：${err?.message || err}`);
    }
  }

  // 线索上限：超出时优先丢权重最低、最老的
  const allThreads = store.getThreads(sessionId, { limit: 999 });
  const openThreads = allThreads.filter((x) => x.status === 'open');
  if (openThreads.length > MAX_THREADS) {
    const keep = openThreads
      .slice()
      .sort((a, b) => (b.weight - a.weight) || (b.updated_at - a.updated_at))
      .slice(0, MAX_THREADS);
    const keepIds = new Set(keep.map((x) => x.id));
    for (const x of openThreads) {
      if (!keepIds.has(x.id)) store.upsertThread(sessionId, { title: x.title, status: 'abandoned' });
    }
  }

  // 关系上限
  const rels = store.getRelations(sessionId, { limit: 999 });
  if (rels.length > MAX_RELATIONS) {
    const sortBy = rels.slice().sort((a, b) => (Math.abs(b.sentiment) - Math.abs(a.sentiment)) || (b.turn_no - a.turn_no));
    for (const r of sortBy.slice(MAX_RELATIONS)) store.deleteRelation(sessionId, r.id);
  }

  /* ---- state 合并（代码内，确定性） ---- */
  const oldSnap = store.getState(sessionId);
  const newState = mergeState(oldSnap?.state ?? null, update.state_delta);
  store.setState(sessionId, no, newState);

  /* ---- 层级压缩 ---- */
  let compressed = null;
  try {
    const mod = await import('../memory/compressor.js');
    if (typeof mod?.checkCompression === 'function') {
      compressed = await mod.checkCompression(sessionId, no);
    }
  } catch { /* 压缩失败不阻断 */ }

  /* ---- 反思（每 N 轮） ---- */
  let reflection = null;
  const every = config.context.reflectEvery;
  if (every > 0 && no % every === 0) {
    try {
      reflection = await runReflection({ session, turnNo: no, signal });
    } catch (err) {
      console.warn(`[memory-agent] 反思失败（turn ${no}）：${err?.message || err}`);
    }
  }

  return {
    round_summary: roundSummary,
    entities: entityCount,
    facts: factCount,
    relations: relationCount,
    threads: threadCount,
    reflection,
    compressed,
    usage: res.usage || null,
  };
}

/**
 * 生成反思：回看最近若干条 L1/L2 摘要，提炼跨轮判断。
 * 失败返回 null（不抛错）。
 */
export async function runReflection({ session, turnNo, signal }) {
  const sessionId = session.id;
  const window = Math.max(6, (config.context.reflectEvery || 5) * 2);
  const from = Math.max(1, turnNo - window + 1);
  const summaries = store.getSummaries(sessionId, { level: 1, archived: 0 })
    .filter((s) => s.turn_to >= from && s.turn_to <= turnNo);
  if (summaries.length < 3) return null;

  const prior = store.getReflections(sessionId, { limit: 8 }).map((r) => r.content);

  const res = await chat({
    messages: [
      { role: 'system', content: reflectionSystemPrompt() },
      {
        role: 'user',
        content: reflectionUserPrompt({
          turnFrom: from, turnTo: turnNo, summaries, priorReflections: prior,
        }),
      },
    ],
    temperature: 0.4,
    maxTokens: 2500,
    reasoningEffort: 'low',
    responseFormat: { type: 'json_object' },
    signal,
  });

  const items = parseReflections(res.content);
  if (!items.length) return null;
  for (const it of items) {
    store.addReflection(sessionId, { turn_from: from, turn_to: turnNo, kind: it.kind, content: it.content });
  }
  // 反思上限 24 条，超出丢最老的
  const all = store.getReflections(sessionId, { limit: 999 });
  for (const r of all.slice(0, Math.max(0, all.length - 24))) store.deleteReflection(sessionId, r.id);

  return items;
}
