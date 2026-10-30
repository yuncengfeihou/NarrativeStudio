/**
 * server/agents/narrator.js — 剧情演绎 Agent
 *
 * 上下文已由 context-engine 装配好（唯一一条 system + 若干设定/记忆 user 层 + 最近原文 + 本轮输入），
 * 本模块只负责：
 *   - 必要时补一条 system（兜底）
 *   - 注入本轮的改稿要求（guidance）
 *   - 流式调用并透传增量
 */
import { chatStream } from '../llm.js';
import { buildContract } from '../memory/context-engine.js';

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

function insertBeforeLastUser(messages, content) {
  const idx = lastUserIndex(messages);
  const msg = { role: 'user', content };
  // 用 user 而非 system：把额外的 system 插进对话中段会让上游把正文写进 reasoning。
  if (idx >= 0) messages.splice(idx, 0, msg);
  else messages.push(msg);
  return messages;
}

/**
 * 组装最终 messages（纯函数，便于单测）。
 * segmentedNote 只在分段模式传；它和 guidance 一样是尾部 user 指令，不新增 system。
 */
export function buildNarratorMessages({
  session, world, context, guidance = '', segmentedNote = '',
} = {}) {
  const messages = Array.isArray(context?.messages)
    ? context.messages.map((m) => ({ ...m }))
    : [];

  if (!messages.some((m) => m?.role === 'system')) {
    // 兜底路径：context 里没有 system 时现算一份。带上 context.craft，
    // 否则这段兜底会丢掉工艺层（system 里有、兜底里没有，两条路径不一致）。
    messages.unshift({ role: 'system', content: buildContract(session, world, undefined, { craft: context?.craft || null }) });
  }

  const note = String(guidance || '').trim();
  if (note) {
    insertBeforeLastUser(
      messages,
      `【本轮改稿要求】（作者对这一次演绎的额外要求，优先级高，但不得违背世界观与人物设定）\n${note}`,
    );
  }

  const segmented = String(segmentedNote || '').trim();
  if (segmented) insertBeforeLastUser(messages, segmented);

  return messages;
}

/**
 * 运行剧情演绎 Agent（流式）。
 * @returns {Promise<{content, reasoning, usage, model, finishReason}>}
 */
export async function runNarrator({
  session, world, context, turnNo, options = {}, onDelta, signal,
} = {}) {
  const messages = buildNarratorMessages({ session, world, context, guidance: options.guidance });

  let content = '';
  let reasoning = '';
  let usage = null;
  let model = options.model;
  let finishReason = null;

  // 参数默认值由 llm.js 按 model-registry 的 narrator 绑定补齐（temperature / maxTokens /
  // reasoningEffort / model）；这里只透传单次覆盖。
  for await (const ev of chatStream({
    agent: 'narrator',
    messages,
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    reasoningEffort: options.reasoningEffort,
    signal,
  })) {
    if (ev.type === 'reasoning' && ev.delta) {
      reasoning += ev.delta;
      onDelta?.({ type: 'reasoning', delta: ev.delta });
    } else if (ev.type === 'content' && ev.delta) {
      content += ev.delta;
      onDelta?.({ type: 'content', delta: ev.delta });
    } else if (ev.type === 'meta') {
      if (ev.usage) usage = ev.usage;
      if (ev.model) model = ev.model;
      if (ev.finishReason) finishReason = ev.finishReason;
    }
  }

  return { content, reasoning, usage, model, finishReason };
}
