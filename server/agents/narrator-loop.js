/**
 * server/agents/narrator-loop.js — 分段演绎（P1-1 第一阶段）
 *
 * 与 narrator.js 的区别只在于「怎么落笔」，不改变世界观与记忆：
 *   - narrator.js：一次流式写完，正文直接是最终稿；
 *   - 本模块：允许模型分段写、按需查辞书、修订草稿，最后只把定稿正文交回管线。
 *
 * 不变量：
 *   - 仍然只有一条 system，装配仍由 context-engine 负责；
 *   - 工具结果只活在当拍的临时消息里，绝不写入 turns，也不进入下一轮 recent；
 *   - 最终落库的只有定稿正文；史官仍然在正文之后独立记账；
 *   - 工具调用走 OpenAI tools 协议，旁白不输出 JSON 正文。
 *
 * 失败策略：上游不支持 tools、或循环内出现非取消错误时，由 orchestrator 回退到
 * 单发 narrator。分段模式默认关闭，会话 settings.narration_mode='segmented' 才启用。
 */
import { config } from '../config.js';
import { chatStream } from '../llm.js';
import { resolveAgent } from '../model-registry.js';
import { estimateTokens } from '../tokens.js';
import { lookupCodex, renderCodexHit } from '../world/scene-sheet.js';
import { buildNarratorMessages } from './narrator.js';
import { segmentedInstruction } from '../prompts/narrator.js';

/**
 * 会话设置优先于进程默认值；只认 single / segmented，其他值按默认处理。
 * 纯函数，便于单测。
 */
export function resolveNarrationMode(settings, defaultMode = config.narration.mode) {
  const explicit = settings?.narration_mode;
  if (explicit === 'segmented' || explicit === 'single') return explicit;
  return defaultMode === 'segmented' ? 'segmented' : 'single';
}

/** 第一阶段暴露五个工具；ask 属于 P1-3，等循环稳定后再加。 */
export const SEGMENTED_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'draft_append',
      description: '把一段正文追加到草稿末尾。如果正文已经通过流式输出写出，就不要重复调用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要追加的正文片段，保持可直接阅读。' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_edit',
      description: '修订草稿中已经写下的内容。find 必须原样出现在草稿里；只替换第一处。',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string', description: '草稿中要替换的原片段。' },
          replace: { type: 'string', description: '替换后的文本。' },
        },
        required: ['find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_seal',
      description: '确认草稿完整并定稿。调用后本拍不再修改。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codex_lookup',
      description: '当玩家问到具体地点/机构/物品/人物来历，或你要写到的规则、后果、细节不在场记单里时，先查辞书全文。不要凭印象编造；普通推进不要每段都查。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的辞书名称、别名或关键词。' },
          limit: { type: 'integer', description: '最多返回几条，1-3。', minimum: 1, maximum: 3 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_history',
      description: '当玩家提到很久以前发生过的事、要复用旧伏笔，或你需要确认前文原话时，检索本局已经发生过的回合原文。只返回命中片段，按时间从近到远；普通推进不要每段都查。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要检索的原文关键词：人名、地名、物件，或一句记得的原话。' },
          limit: { type: 'integer', description: '最多返回几条，1-6。', minimum: 1, maximum: 6 },
        },
        required: ['query'],
      },
    },
  },
];

/**
 * 在草稿里替换第一处（或全部）匹配。纯函数，便于单测。
 * @returns {{text:string, changed:boolean, count:number}}
 */
export function applyDraftEdit(draft, find, replace, { all = false } = {}) {
  const src = String(draft || '');
  const needle = String(find || '');
  if (!needle) return { text: src, changed: false, count: 0 };
  const repl = String(replace ?? '');
  if (!src.includes(needle)) return { text: src, changed: false, count: 0 };
  if (all) {
    const parts = src.split(needle);
    return { text: parts.join(repl), changed: true, count: parts.length - 1 };
  }
  const at = src.indexOf(needle);
  return {
    text: src.slice(0, at) + repl + src.slice(at + needle.length),
    changed: true,
    count: 1,
  };
}

/**
 * 把流式 tool_calls 增量合并成完整调用。
 * 上游会按 index 分片发送 id / name / arguments，必须按 index 聚合。
 * @returns {Map<number, {id:string,type:string,function:{name:string,arguments:string}}>}
 */
export function mergeToolCallDeltas(map, deltas) {
  for (const d of deltas || []) {
    const idx = Number.isInteger(d?.index) ? d.index : map.size;
    const cur = map.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (d?.id) cur.id = d.id;
    if (d?.type) cur.type = d.type;
    if (d?.function?.name) cur.function.name += d.function.name;
    if (d?.function?.arguments) cur.function.arguments += d.function.arguments;
    map.set(idx, cur);
  }
  return map;
}

/** 把 Map 变成 OpenAI assistant.tool_calls 需要的数组。 */
function finalizeToolCalls(map, round) {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, c]) => ({
      id: c.id || `call_${round}_${idx}`,
      type: c.type || 'function',
      function: {
        name: c.function.name,
        arguments: c.function.arguments || '{}',
      },
    }))
    .filter((c) => c.function.name);
}

/** 宽容解析工具参数；模型偶尔给空字符串或夹杂文本。 */
export function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { /* 继续 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* 落到失败 */ }
  }
  return {};
}

/** 合并多次调用的 usage：token 相加，首字延迟取第一次，缓存率/速度重算。 */
export function mergeUsage(acc, next) {
  if (!next) return acc || null;
  if (!acc) return { ...next };
  const out = { ...acc };
  for (const f of [
    'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens',
    'reasoning_tokens', 'duration_ms', 'output_chars',
  ]) {
    out[f] = (Number(acc[f]) || 0) + (Number(next[f]) || 0);
  }
  out.ttft_ms = acc.ttft_ms ?? next.ttft_ms ?? null;
  out.cache_rate = out.prompt_tokens > 0
    ? Math.round((out.cached_tokens / out.prompt_tokens) * 1000) / 1000
    : null;
  const genMs = Math.max(1, (Number(out.duration_ms) || 0) - (Number(out.ttft_ms) || 0));
  const genTokens = Math.max(0, (Number(out.completion_tokens) || 0) - (Number(out.reasoning_tokens) || 0));
  out.tps = genTokens > 0 ? Math.round((genTokens / (genMs / 1000)) * 10) / 10 : null;
  return out;
}

/**
 * 工具历史预算：只裁掉 baseLen 之后最旧的「assistant(tool_calls) + 它后面的 tool 消息」。
 * 基础上下文（system + 原文 + 场记单 + 本轮输入）永远不动。
 * @returns {number} 删掉的消息数
 */
export function trimToolHistory(messages, baseLen, budgetTokens) {
  const toolTokens = () => messages
    .slice(baseLen)
    .filter((m) => m?.role === 'tool')
    .reduce((sum, m) => sum + estimateTokens(String(m.content || '')), 0);

  let removed = 0;
  while (toolTokens() > budgetTokens) {
    let start = -1;
    for (let i = baseLen; i < messages.length; i++) {
      if (messages[i]?.role === 'assistant' && Array.isArray(messages[i].tool_calls)) {
        start = i;
        break;
      }
    }
    if (start < 0) break;
    let end = start + 1;
    while (end < messages.length && messages[end]?.role === 'tool') end++;
    removed += end - start;
    messages.splice(start, end - start);
  }
  return removed;
}

/** 粗略按 token 预算截断工具结果，避免单条检索把整个历史挤爆。 */
function clipToTokens(text, maxTokens) {
  const src = String(text || '');
  if (estimateTokens(src) <= maxTokens) return src;
  let maxChars = Math.max(120, Math.floor(maxTokens * 1.1));
  let out = src.slice(0, maxChars);
  while (out.length > 120 && estimateTokens(out) > maxTokens) {
    maxChars = Math.floor(maxChars * 0.85);
    out = src.slice(0, maxChars);
  }
  return `${out}…`;
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * 执行一个工具调用。只操作内存草稿与当拍检索，不写库。
 * @param {function} [recall] 历史检索回调（生产由 orchestrator 注入 recallHistory；
 *                            缺失时 recall_history 报错，不静默返回空结果）
 * @returns {{text:string, draft:string, changed?:boolean, appended?:string, sealed?:boolean, error?:boolean, label?:string}}
 */
export function runSegmentedTool({ name, args, draft, card, recall }) {
  const src = String(draft || '');
  switch (name) {
    case 'draft_append': {
      const text = typeof args?.text === 'string' ? args.text : '';
      if (!text.trim()) return { text: '错误：text 不能为空。', draft: src, error: true };
      const next = !src ? text
        : src.endsWith('\n') ? `${src}${text}`
          : `${src}\n\n${text}`;
      return {
        text: `已追加 ${text.length} 字。当前草稿约 ${next.length} 字。`,
        draft: next,
        changed: true,
        appended: !src || src.endsWith('\n') ? text : `\n\n${text}`,
        label: '写入草稿',
      };
    }
    case 'draft_edit': {
      const find = typeof args?.find === 'string' ? args.find : '';
      const replace = typeof args?.replace === 'string' ? args.replace : '';
      if (!find) return { text: '错误：find 不能为空。', draft: src, error: true };
      const r = applyDraftEdit(src, find, replace);
      if (!r.changed) return { text: '错误：find 没有在草稿中原样出现，未修改。', draft: src, error: true };
      return {
        text: `已替换 ${r.count} 处。当前草稿约 ${r.text.length} 字。`,
        draft: r.text,
        changed: true,
        label: '修订草稿',
      };
    }
    case 'draft_seal': {
      if (!src.trim()) return { text: '错误：草稿为空，不能定稿。', draft: src, error: true };
      return { text: '已定稿。', draft: src, sealed: true, label: '定稿' };
    }
    case 'codex_lookup': {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) return { text: '错误：query 不能为空。', draft: src, error: true };
      const limit = Math.max(1, Math.min(3, Number(args?.limit) || 2));
      const hits = lookupCodex(card, [query], { limit });
      if (!hits.length) {
        return {
          text: `未检索到与「${query}」相关的辞书条目。不要编造；按场记单已有信息写。`,
          draft: src,
          label: `查阅：${query}`,
        };
      }
      return {
        text: `【辞书检索：${query}】\n${hits.map((h) => renderCodexHit(h.entry)).join('\n\n')}`,
        draft: src,
        label: `查阅：${query}`,
      };
    }
    case 'recall_history': {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) return { text: '错误：query 不能为空。', draft: src, error: true };
      if (typeof recall !== 'function') {
        return { text: '错误：本局未启用历史检索。', draft: src, error: true };
      }
      const limit = Math.max(1, Math.min(6, Number(args?.limit) || 4));
      const out = recall({ query, limit });
      return {
        text: out?.text || '未检索到相关历史。',
        draft: src,
        label: `历史检索：${query}`,
      };
    }
    default:
      return { text: `错误：未知工具 ${name}。`, draft: src, error: true };
  }
}

/**
 * 分段演绎入口。
 *
 * @param {object} args
 * @param {object} args.session
 * @param {object} args.world
 * @param {object} args.context       context-engine 的装配结果
 * @param {number} args.turnNo
 * @param {object} [args.options]     narrator 选项（model/temperature/maxTokens/reasoningEffort/guidance）
 * @param {function} [args.onEvent]   SSE 事件回调：draft_* / reasoning / tool_call
 * @param {AbortSignal} [args.signal]
 * @param {function} [args.recall]     历史检索回调（recall_history 工具）；不传则该工具报错
 * @returns {Promise<{content, reasoning, usage, model, finishReason, narration}>}
 */
export async function runNarratorSegmented({
  session, world, context, turnNo, options = {}, onEvent = () => {}, signal, recall = null,
  // 测试注入点：生产环境永远用 chatStream，测试可传一个假流跑完整循环。
  stream = chatStream,
} = {}) {
  const seg = config.narration;
  // 单轮输出上限：显式 options.maxTokens（含 runTurn 的 override）> narrator 绑定上限与
  // 分段轮预算的较小者。推理过程也计入 max_tokens，所以不能只取 roundMaxTokens。
  const roundMaxTokens = options.maxTokens ?? Math.min(resolveAgent('narrator').maxTokens, seg.roundMaxTokens);
  const maxRounds = Math.max(1, seg.maxRounds);
  const emit = (evt) => { try { onEvent(evt); } catch { /* 监听器错误不影响演绎 */ } };

  const messages = buildNarratorMessages({
    session,
    world,
    context,
    guidance: options.guidance,
    segmentedNote: segmentedInstruction({ maxRounds }),
  });
  const baseLen = messages.length;

  let draft = '';
  let reasoning = '';
  let usage = null;
  let model = options.model;
  let finishReason = null;
  let rounds = 0;
  let tools = 0;
  let sealed = false;

  emit({ type: 'draft_start', turn_no: turnNo, mode: 'segmented', max_rounds: maxRounds });

  for (rounds = 1; rounds <= maxRounds; rounds++) {
    if (signal?.aborted) throw abortError();
    let content = '';
    let finish = null;
    const calls = new Map();

    for await (const ev of stream({
      agent: 'narrator',
      messages,
      model: options.model,
      temperature: options.temperature,
      maxTokens: roundMaxTokens,
      reasoningEffort: options.reasoningEffort,
      tools: SEGMENTED_TOOLS,
      toolChoice: 'auto',
      signal,
    })) {
      if (ev.type === 'reasoning' && ev.delta) {
        reasoning += ev.delta;
        emit({ type: 'reasoning', delta: ev.delta });
      } else if (ev.type === 'content' && ev.delta) {
        content += ev.delta;
        draft += ev.delta;
        emit({ type: 'draft_delta', delta: ev.delta });
      } else if (ev.type === 'tool_calls') {
        mergeToolCallDeltas(calls, ev.delta);
      } else if (ev.type === 'meta') {
        if (ev.usage) usage = mergeUsage(usage, ev.usage);
        if (ev.model) model = ev.model;
        if (ev.finishReason) finish = ev.finishReason;
      }
    }
    finishReason = finish || finishReason;

    const list = finalizeToolCalls(calls, rounds);
    if (!list.length) {
      // 没有工具调用：这一轮流式写下的正文就是定稿。
      sealed = Boolean(draft.trim());
      break;
    }

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: list,
    });

    for (const call of list) {
      if (signal?.aborted) throw abortError();
      const args = parseToolArgs(call.function.arguments);
      // 同一轮里既流式写了正文又调 draft_append 时，以流式正文为准，避免重复。
      const result = call.function.name === 'draft_append' && content.trim()
        ? { text: '已忽略：本轮正文已经通过流式输出写出。', draft, error: true }
        : runSegmentedTool({
          name: call.function.name,
          args,
          draft,
          card: world?.card || null,
          recall,
        });
      tools += 1;

      if (result.draft !== draft) {
        draft = result.draft;
        if (result.appended) emit({ type: 'draft_delta', delta: result.appended });
        else emit({ type: 'draft_reset', content: draft });
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: clipToTokens(result.text, seg.toolResultMaxTokens),
      });
      emit({
        type: 'tool_call',
        turn_no: turnNo,
        round: rounds,
        name: call.function.name,
        ok: !result.error,
        label: result.label || call.function.name,
      });

      if (result.sealed) { sealed = true; break; }
    }

    if (sealed) break;
    if (rounds >= maxRounds) break;
    // 工具结果只活在临时消息里；超预算时从最旧的一组开始丢。
    trimToolHistory(messages, baseLen, seg.toolHistoryTokens);
  }

  if (!draft.trim()) {
    return {
      content: '',
      reasoning,
      usage,
      model,
      finishReason,
      narration: { mode: 'segmented', rounds, tools, sealed: false, empty: true },
    };
  }

  emit({ type: 'draft_done', turn_no: turnNo, content: draft, rounds, tools, sealed });
  return {
    content: draft,
    reasoning,
    usage,
    model,
    finishReason,
    narration: { mode: 'segmented', rounds, tools, sealed },
  };
}
