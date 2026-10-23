/**
 * 剧情分支 Agent：基于当前局势生成 3-4 个走向选项。
 *
 * 解析容错链（对应任务要求「绝不抛错」）：
 *   1) 整体 JSON.parse；
 *   2) 正则提取第一个 {...} 块再 parse；
 *   3) 打捞（salvage）：括号配对扫描出 branches 数组中的完整分支对象，逐个 parse
 *      ——容忍 JSON 被截断或输出带尾部杂质的情况；
 *   4) 仍不足 3 个：退化为 3 个通用选项（顺势而为/冒险试探/按兵不动）。
 *   LLM 调用失败同样降级为通用选项，保证回合管线不被分支功能阻断。
 *
 * context 由 assembler 提供：{state} 为裸 state 对象（也兼容 {turn_no, state} 包装）。
 */
import { config } from '../config.js';
import { chat } from '../llm.js';
import { branchSystemPrompt, branchUserPrompt, BRANCH_TONES } from '../prompts/branch.js';

/** 通用兜底选项（解析与调用都失败时使用）。 */
const FALLBACK_BRANCHES = [
  { title: '顺势而为', description: '顺着当前局势稳步行动，不冒进也不退缩，先摸清周围的情况再决定下一步怎么走。', tone: '谨慎', tension_delta: 0.05 },
  { title: '冒险试探', description: '抓住眼前的机会主动试探，承担可见的风险，争取换来关键情报或突破口。', tone: '激进', tension_delta: 0.25 },
  { title: '按兵不动', description: '暂缓行动，仔细观察周围的细节与相关者的反应，等待更合适的时机再出手。', tone: '探索', tension_delta: 0.0 },
];

/**
 * 从 assembler 的 context 中提取 state 快照。
 * 兼容三种形态：{turn_no, state}（store.getState 产物）、裸 state 对象（assembler 现状）、null。
 */
function pickState(context) {
  const s = context?.state;
  if (!s || typeof s !== 'object') return null;
  if ('state' in s && s.state && typeof s.state === 'object') return s.state;
  if ('turn_no' in s) return null;
  return s;
}

/**
 * 把 state 快照提炼为「当前局势」一句话。
 * @param {object|null} state
 * @returns {string}
 */
export function summarizeScene(state) {
  if (!state || typeof state !== 'object') return '';
  const bits = [];
  if (state.time) bits.push(`时间：${state.time}`);
  if (state.location) bits.push(`地点：${state.location}`);
  if (state.weather) bits.push(`天气：${state.weather}`);
  if (typeof state.tension === 'number') bits.push(`紧张度：${state.tension.toFixed(2)}`);
  if (state.characters && typeof state.characters === 'object') {
    const chars = Object.entries(state.characters)
      .map(([name, c]) => `${name}（${c?.mood || '情绪不明'}@${c?.location || '去向不明'}）`)
      .join('、');
    if (chars) bits.push(`人物：${chars}`);
  }
  if (state.last_hook) bits.push(`上一幕钩子：${state.last_hook}`);
  return bits.join('；');
}

/** 尽力解析 JSON：整体 parse → 正则提取第一个 {...} 块。 */
function tryParseJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续尝试提取 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* 落入打捞/降级路径 */ }
  }
  return null;
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

/**
 * 括号配对扫描：取出文本中 key 对应数组里的「完整顶层对象」。
 * 容忍嵌套（attributes 等）与截断（残缺对象自然被跳过）。
 * @param {string} text
 * @param {string} key  如 'branches'
 * @returns {Array<object>}
 */
function salvageArrayOfObjects(text, key) {
  const ki = text.indexOf(`"${key}"`);
  if (ki < 0) return [];
  const bi = text.indexOf('[', ki);
  if (bi < 0) return [];
  const out = [];
  let arrDepth = 0;   // [] 深度
  let objDepth = 0;   // {} 深度
  let start = -1;     // 当前顶层对象起始下标
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

/** 单条分支字段清洗与补齐（description 为必需字段，缺失则丢弃）。 */
function sanitizeBranch(b) {
  if (!b || typeof b !== 'object') return null;
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (!description) return null;
  const rawTitle = typeof b.title === 'string' ? b.title.trim() : '';
  const title = (rawTitle || description).slice(0, 12);
  const tone = BRANCH_TONES.includes(b.tone) ? b.tone : '谨慎';
  const td = Number(b.tension_delta);
  const tension_delta = Number.isFinite(td) ? Math.round(Math.max(-0.5, Math.min(0.5, td)) * 100) / 100 : 0.1;
  return { id: '', title, description, tone, tension_delta };
}

/** 打捞字符串标量："key": "value"（正确反转义）。 */
function salvageStringValue(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = text.match(re);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

/** 重新规范 id 为 b1..bn。 */
function reindex(list) {
  return list.map((b, i) => ({ ...b, id: `b${i + 1}` }));
}

/**
 * 解析并校验 LLM 返回的分支 JSON；最终失败退化为 3 个通用选项（纯函数，便于单测）。
 * @param {string} content LLM 原始输出
 * @returns {{branches: Array, scene_summary: string}}
 */
export function parseBranchPayload(content) {
  const text = typeof content === 'string' ? escapeRawControlCharsInStrings(content) : '';
  const parsed = tryParseJson(text);
  let rawList = parsed && Array.isArray(parsed.branches) ? parsed.branches : [];

  // 打捞：整体解析失败时，从 branches 数组中抢救完整的分支对象
  if (rawList.length === 0 && text.trim()) {
    rawList = salvageArrayOfObjects(text, 'branches')
      .filter(o => o && typeof o === 'object' && (typeof o.title === 'string' || typeof o.description === 'string'));
  }

  let branches = rawList.map(sanitizeBranch).filter(Boolean).slice(0, 4);

  // 数量不足 3 个时用通用选项补齐（避免与已有选项重名）
  if (branches.length < 3) {
    for (const fb of FALLBACK_BRANCHES) {
      if (branches.length >= 3) break;
      if (!branches.some(b => b.title === fb.title)) branches.push({ ...fb });
    }
  }
  branches = reindex(branches);

  let scene_summary = parsed && typeof parsed.scene_summary === 'string' ? parsed.scene_summary.trim() : '';
  if (!scene_summary && text.includes('"scene_summary"')) {
    scene_summary = (salvageStringValue(text, 'scene_summary') || '').trim();
  }
  return { branches, scene_summary };
}

/**
 * 运行分支 Agent（非流式）。
 * @param {object} opts
 * @param {object} opts.session
 * @param {object} [opts.context]          assembler 产物（取 context.state）
 * @param {string} [opts.recentNarrative] 最近一轮剧情正文
 * @param {object} [opts.options]          覆盖 {temperature, maxTokens, reasoningEffort, model}
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{branches: Array, scene_summary: string, usage: object|null}>}
 */
export async function runBranchAgent({ session, context, recentNarrative, options = {}, signal } = {}) {
  const cfg = config.agents.branch;
  const state = pickState(context);
  const sceneSummary = state
    ? summarizeScene(state)
    : (typeof context?.sceneSummary === 'string' ? context.sceneSummary.trim() : '');

  const messages = [
    { role: 'system', content: branchSystemPrompt(session) },
    { role: 'user', content: branchUserPrompt({ sceneSummary, lastNarrative: recentNarrative || '', state }) },
  ];

  let content = '';
  let usage = null;
  try {
    const res = await chat({
      messages,
      temperature: options.temperature ?? cfg.temperature,
      maxTokens: options.maxTokens ?? cfg.maxTokens,
      reasoningEffort: options.reasoningEffort ?? cfg.reasoningEffort,
      model: options.model,
      responseFormat: { type: 'json_object' },
      signal,
    });
    content = res.content;
    usage = res.usage ?? null;
  } catch (err) {
    // 分支是体验增强功能，LLM 失败也绝不影响回合主流程：降级为通用选项
    console.warn(`[branch-agent] LLM 调用失败，降级为通用选项：${err?.message || err}`);
  }

  const parsed = parseBranchPayload(content);
  if (parsed.branches.every(b => FALLBACK_BRANCHES.some(fb => fb.title === b.title))) {
    // 全部为兜底选项：记录原始输出便于诊断（LLM 未按 JSON 输出且打捞失败）
    console.warn(`[branch-agent] 未能解析出有效分支选项，已降级。原始输出前 300 字：${String(content).slice(0, 300)}`);
  }
  return {
    branches: parsed.branches,
    scene_summary: parsed.scene_summary || sceneSummary,
    usage,
  };
}
