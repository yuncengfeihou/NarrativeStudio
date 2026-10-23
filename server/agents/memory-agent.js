/**
 * 记忆 Agent：每轮回合结束后更新分层记忆。
 *
 * 流程：
 *   1) chat() 调用 roundSummaryUserPrompt（response_format=json_object）得到 memoryUpdate JSON；
 *      解析容错链：整体 parse → 正则提取 {...} → 打捞（salvage）各字段 → 纯文本摘要降级，绝不抛错。
 *   2) store.addSummary 写 L1 摘要（无 round_summary 时用 narrative 前 500 字截断）。
 *   3) entities 逐个 store.upsertEntity（importance 缺省 0.6，character 类型 0.8）；
 *      facts 逐个 store.addFact（turn_no=turnNo）。
 *   4) 读旧 state，把 state_delta 深度合并（mergeState，代码内完成，不调 LLM）后 setState。
 *   5) 动态 import compressor 并 checkCompression；compressor 由其他开发者并行实现，
 *      文件缺失或执行失败只静默跳过，不影响返回。
 *
 * 注意：只有「JSON 解析失败」会降级；LLM 调用失败（LlmError）向上抛给 orchestrator。
 */
import { config } from '../config.js';
import { chat } from '../llm.js';
import * as store from '../memory/store.js';
import { memorySystemPrompt, roundSummaryUserPrompt } from '../prompts/memory.js';

/** 降级摘要的最大长度（与契约「narrative 前 500 字截断」一致）。 */
const MAX_SUMMARY_FALLBACK = 500;

/** delta 中需要专门处理的键（其余键按标量/深合并处理）。 */
const RESERVED_DELTA_KEYS = new Set(['inventory_add', 'inventory_remove', 'quests_update', 'threads_add', 'threads_resolve']);

/** state_delta 中可通过字符串正则打捞的标量键。 */
const SALVAGE_STRING_KEYS = ['time', 'location', 'weather', 'last_hook'];

/** state_delta 中可通过字符串数组正则打捞的键。 */
const SALVAGE_ARRAY_KEYS = ['inventory_add', 'inventory_remove', 'threads_add', 'threads_resolve'];

/** characters 对象内不允许作为角色名的键（防误判）。 */
const CHARACTER_NAME_DENY = new Set([
  'type', 'name', 'summary', 'attributes', 'entities', 'facts', 'branches', 'scene_summary',
  'state_delta', 'characters', 'quests', 'threads', 'inventory', 'round_summary', 'goal',
  'progress', 'status', 'subject', 'predicate', 'object', 'confidence', 'importance', 'id',
  'title', 'description', 'tone', 'tension_delta', 'turn_no', 'level', 'turnFrom', 'turnTo',
  'content', 'first_turn', 'last_turn', 'weather', 'time', 'location', 'last_hook',
]);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function deepClone(v) {
  if (!isPlainObject(v) && !Array.isArray(v)) return v;
  return structuredClone(v);
}

/** 递归深合并：b 覆盖 a；两侧均为普通对象时逐键递归，null/undefined 视为未变化。 */
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || v === null) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : deepClone(v);
  }
  return out;
}

/** 归一化为字符串数组（过滤非字符串）。 */
function asStringArray(v) {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v == null ? [] : [v];
}

/**
 * 把 state_delta 深度合并进旧 state，产出完整新 state（纯函数，便于单测）。
 * 规则（对应 CONTRACTS.md 的 memory update / state schema）：
 *   - 标量字段（time/location/weather/tension/last_hook 及未知键）：delta 出现即覆盖；
 *   - characters：逐键深合并（同角色只更新变化字段，未提及角色保留）；
 *   - inventory_add 追加（去重）→ inventory_remove 移除（remove 优先）；
 *   - quests_update：按 goal 匹配更新 progress/status，未命中则 push；
 *   - threads_add 追加（去重）→ threads_resolve 移除；
 *   - 首轮 oldState 为 null 时以 delta 为基底。
 * @param {object|null} oldState
 * @param {object|null} delta
 * @returns {object} 完整新 state
 */
export function mergeState(oldState, delta) {
  const base = isPlainObject(oldState) ? oldState : {};
  const d = isPlainObject(delta) ? delta : {};
  const next = deepClone(base);

  // 1) 标量与深合并字段（characters 等普通对象逐键合并；数组类 delta 键在下方处理）
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    if (RESERVED_DELTA_KEYS.has(k)) continue;
    if (isPlainObject(v) && isPlainObject(next[k])) {
      next[k] = deepMerge(next[k], v);
    } else {
      next[k] = deepClone(v);
    }
  }

  // 2) inventory：先加后删（remove 优先）
  const inventory = Array.isArray(next.inventory) ? next.inventory.slice() : [];
  for (const item of asStringArray(d.inventory_add)) {
    if (!inventory.includes(item)) inventory.push(item);
  }
  const removeSet = new Set(asStringArray(d.inventory_remove));
  next.inventory = inventory.filter(item => !removeSet.has(item));

  // 3) quests：按 goal 匹配更新，未命中则追加
  const quests = Array.isArray(next.quests) ? next.quests.map(q => deepClone(q)) : [];
  for (const upd of asArray(d.quests_update)) {
    const goal = typeof upd === 'string' ? upd : upd?.goal;
    if (!goal || typeof goal !== 'string') continue;
    const hit = quests.find(q => q && q.goal === goal);
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
  next.quests = quests;

  // 4) threads：先加后回收
  const threads = Array.isArray(next.threads) ? next.threads.slice() : [];
  for (const t of asStringArray(d.threads_add)) {
    if (!threads.includes(t)) threads.push(t);
  }
  const resolvedSet = new Set(asStringArray(d.threads_resolve));
  next.threads = threads.filter(t => !resolvedSet.has(t));

  // 5) 规范化容器字段，保证 assembler 拿到完整结构
  next.characters = isPlainObject(next.characters) ? next.characters : {};
  if (!Array.isArray(next.inventory)) next.inventory = [];
  if (!Array.isArray(next.quests)) next.quests = [];
  if (!Array.isArray(next.threads)) next.threads = [];

  return next;
}

/* --------------------------- JSON 解析与打捞 --------------------------- */

/** 尽力解析 JSON：整体 parse → 正则提取第一个 {...} 块。 */
function tryParseJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续尝试提取 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* 落入打捞路径 */ }
  }
  return null;
}

/** 括号配对扫描：取出文本中 key 对应数组里的「完整顶层对象」（容忍嵌套与截断）。 */
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
    if (ch === '[') {
      arrDepth++;
    } else if (ch === ']') {
      arrDepth--;
      if (arrDepth === 0) break;
    } else if (ch === '{') {
      objDepth++;
      if (objDepth === 1 && arrDepth === 1 && start < 0) start = i;
    } else if (ch === '}') {
      objDepth--;
      if (objDepth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* 残缺对象，跳过 */ }
        start = -1;
      }
    }
  }
  return out;
}

/** 打捞字符串标量："key": "value"（正确反转义）。 */
function salvageStringValue(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = text.match(re);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

/**
 * 修复模型输出中的非法 JSON：把字符串值内的原始控制字符（裸换行/制表符等）转义。
 * 幂等：已转义的文本再次经过不会双重转义。
 */
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

/** 打捞被截断的字符串值（JSON 在字符串中途被切断，没有收尾引号）。片段过短则视为噪声。 */
function salvageTruncatedString(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]+)$`);
  const m = text.match(re);
  if (!m) return null;
  let v = m[1];
  if (v.endsWith('\\')) v = v.slice(0, -1);   // 去掉未完成的转义
  v = v.replace(/["'\]},:\s]+$/, '');          // 去掉尾部 JSON 结构字符
  if (v.length < 20) return null;              // 片段太短没有摘要价值，交还给降级链
  try { return JSON.parse(`"${v}"`); } catch { return v; }
}

/** 打捞字符串数组："key": ["a","b"]（跳过字符串内的 ]）。 */
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

/** 打捞 characters 对象："名字": {mood/status/location...}（仅在 "characters" 之后的窗口内）。 */
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
    if (!/"(?:mood|status|activity|posture)"\s*:/.test(m[2])) continue;
    try { out[name] = JSON.parse(`{${m[2]}}`); } catch { /* 跳过 */ }
  }
  return out;
}

/**
 * 打捞 memoryUpdate 各字段（整体 JSON 损坏/带尾部杂质时的中间降级层）。
 * @param {string} text LLM 原始输出
 * @returns {{round_summary: string, entities: Array, facts: Array, state_delta: object}|null}
 */
function salvageMemoryUpdate(text) {
  if (!text || !text.includes('"round_summary"')) return null;

  // 先把 round_summary 的字符串正文屏蔽成等长空格，避免摘要里的 "time" 等字样被误判为字段
  const masked = text.replace(/"round_summary"\s*:\s*"(?:[^"\\]|\\.)*"/, (m) => ' '.repeat(m.length));

  const round_summary = salvageStringValue(text, 'round_summary')
    || salvageTruncatedString(text, 'round_summary')
    || '';
  const entities = salvageArrayOfObjects(masked, 'entities')
    .filter(o => isPlainObject(o) && typeof o.type === 'string' && typeof o.name === 'string');
  const facts = salvageArrayOfObjects(masked, 'facts')
    .filter(o => isPlainObject(o) && typeof o.subject === 'string' && typeof o.predicate === 'string');

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
    .filter(o => isPlainObject(o) && typeof o.goal === 'string' && o.goal);
  if (quests.length) state_delta.quests_update = quests;

  if (!round_summary && !entities.length && !facts.length && !Object.keys(state_delta).length) return null;
  return { round_summary, entities, facts, state_delta };
}

/**
 * 解析 memoryUpdate JSON；解析容错链：整体 parse → 正则提取 → 打捞 → 纯文本摘要，绝不抛错。
 * @param {string} content   LLM 原始输出
 * @param {string} narrative 本轮剧情正文（最终降级时截断取用）
 * @returns {{round_summary: string, entities: Array, facts: Array, state_delta: object}}
 */
export function parseMemoryUpdate(content, narrative) {
  const text = typeof content === 'string' ? escapeRawControlCharsInStrings(content) : '';
  const parsed = tryParseJson(text);
  if (isPlainObject(parsed)) {
    return {
      round_summary: typeof parsed.round_summary === 'string' ? parsed.round_summary.trim() : '',
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      state_delta: isPlainObject(parsed.state_delta) ? parsed.state_delta : {},
    };
  }

  // 中间降级：打捞已生成的字段（LLM 输出 JSON 被截断/带尾部杂质时最大程度保住记忆）
  const salvaged = salvageMemoryUpdate(text);
  if (salvaged) return salvaged;

  // 最终降级：LLM 未输出合法 JSON 且无可打捞内容。若产出的是可读文本摘要则沿用，否则用 narrative 前 500 字截断。
  const trimmed = text.trim();
  const round_summary = (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[') && trimmed.length >= 30)
    ? trimmed.slice(0, MAX_SUMMARY_FALLBACK)
    : String(narrative || '').slice(0, MAX_SUMMARY_FALLBACK);
  return { round_summary, entities: [], facts: [], state_delta: {} };
}

/**
 * 更新一轮记忆（summary / entities / facts / state / 触发压缩）。
 * @param {object} opts
 * @param {object} opts.session       会话对象（取 session.id）
 * @param {number} opts.turnNo        回合号
 * @param {string} [opts.playerText]  玩家行动原文
 * @param {string} opts.narrative     本轮剧情正文
 * @param {object} [opts.branchChoice] 玩家选择的分支（如有）
 * @param {object} [opts.options]     覆盖 {temperature, maxTokens, reasoningEffort, model}
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{round_summary: string, entities: number, facts: number, compressed: object|null}>}
 */
export async function updateMemory({ session, turnNo, playerText, narrative, branchChoice, options = {}, signal } = {}) {
  const cfg = config.agents.memory;
  const sessionId = session?.id;
  if (!sessionId) throw new Error('updateMemory: session.id 不能为空');
  const no = Number.isFinite(Number(turnNo)) ? Number(turnNo) : store.getMaxTurnNo(sessionId) + 1;

  // 1) LLM 生成结构化 memoryUpdate（LlmError 向上抛；解析失败按容错链降级）
  const res = await chat({
    messages: [
      { role: 'system', content: memorySystemPrompt() },
      { role: 'user', content: roundSummaryUserPrompt({ turnNo: no, playerText, branchChoice, narrative }) },
    ],
    temperature: options.temperature ?? cfg.temperature,
    maxTokens: options.maxTokens ?? cfg.maxTokens,
    reasoningEffort: options.reasoningEffort ?? cfg.reasoningEffort,
    model: options.model,
    responseFormat: { type: 'json_object' },
    signal,
  });
  const memoryUpdate = parseMemoryUpdate(res.content, narrative);

  // 2) L1 摘要（无 round_summary 时用 narrative 前 500 字截断）
  const roundSummary = memoryUpdate.round_summary || String(narrative || '').slice(0, MAX_SUMMARY_FALLBACK);
  store.addSummary(sessionId, { level: 1, turnFrom: no, turnTo: no, content: roundSummary });

  // 3) entities / facts（单条失败只告警，不阻断整轮）
  let entityCount = 0;
  for (const e of memoryUpdate.entities) {
    const type = str(e?.type).trim();
    const name = str(e?.name).trim();
    if (!type || !name) continue;
    try {
      store.upsertEntity(sessionId, {
        type,
        name,
        summary: str(e.summary).trim(),
        attributes: isPlainObject(e.attributes) ? e.attributes : {},
        first_turn: Number.isFinite(Number(e.first_turn)) ? Number(e.first_turn) : no,
        last_turn: Number.isFinite(Number(e.last_turn)) ? Number(e.last_turn) : no,
        importance: Number.isFinite(Number(e.importance)) ? Number(e.importance) : (type === 'character' ? 0.8 : 0.6),
      });
      entityCount++;
    } catch (err) {
      console.warn(`[memory-agent] upsertEntity 失败（${type}/${name}）：${err?.message || err}`);
    }
  }

  let factCount = 0;
  for (const f of memoryUpdate.facts) {
    const subject = str(f?.subject).trim();
    const predicate = str(f?.predicate).trim();
    const object = str(f?.object).trim();
    if (!subject || !predicate || !object) continue;
    try {
      store.addFact(sessionId, {
        subject,
        predicate,
        object,
        turn_no: no,
        confidence: Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : 0.9,
      });
      factCount++;
    } catch (err) {
      console.warn(`[memory-agent] addFact 失败（${subject}/${predicate}）：${err?.message || err}`);
    }
  }

  // 4) state 深度合并（代码内完成，不调 LLM）；首轮旧 state 为 null 时以 delta 为基底
  const oldSnap = store.getState(sessionId);
  const newState = mergeState(oldSnap?.state ?? null, memoryUpdate.state_delta);
  store.setState(sessionId, no, newState);

  // 5) 层级压缩：compressor 并行开发中，动态 import + try/catch，失败不影响返回
  let compressed = null;
  try {
    const mod = await import('../memory/compressor.js');
    if (typeof mod?.checkCompression === 'function') {
      compressed = await mod.checkCompression(sessionId, no);
    }
  } catch {
    // compressor 尚未就绪或执行失败：静默跳过
  }

  return { round_summary: roundSummary, entities: entityCount, facts: factCount, compressed };
}
