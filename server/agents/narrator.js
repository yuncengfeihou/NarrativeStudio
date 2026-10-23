/**
 * 剧情演绎 Agent：流式调用 LLM 生成本轮剧情正文。
 *
 * context 由 assembler.assembleContext() 提供（{messages, budget, retriever, state, recentTurns}），
 * 本模块只消费 context.messages 与 context.extraPrompt：
 *   - context.messages 已含 system 时不重复添加 narratorSystemPrompt；
 *   - isOpening 时把最后一条 current user 消息替换为 narratorOpeningPrompt(session) 的产物；
 *   - context.messages 为空或缺 system 时，用 narratorSystemPrompt(session) 兜底组装；
 *   - context.extraPrompt（assembler 附加提示，如记忆使用规范）插入到最后一条 user 消息之前。
 *
 * LLM 失败（LlmError）直接向上抛，由 orchestrator 转 error 事件。
 */
import { config } from '../config.js';
import { chatStream } from '../llm.js';
import { narratorSystemPrompt, narratorOpeningPrompt } from '../prompts/narrator.js';

/** 最后一条 user 消息的下标；没有则返回 -1。 */
function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/**
 * 组装最终可发送的 messages（纯函数，便于单测）。
 * @param {object} opts
 * @param {object} opts.session
 * @param {object} [opts.context]   assembler 产物
 * @param {boolean} [opts.isOpening] 是否开场轮
 * @returns {Array<{role:string, content:string}>}
 */
export function buildNarratorMessages({ session, context, isOpening = false, guidance = '' } = {}) {
  const messages = Array.isArray(context?.messages)
    ? context.messages.map(m => ({ ...m }))
    : [];

  // 兜底：没有 system 消息时补上 narrator 专属 system prompt
  if (!messages.some(m => m?.role === 'system')) {
    messages.unshift({ role: 'system', content: narratorSystemPrompt(session) });
  }

  // 开场轮：用开场指令替换最后的 current user 消息（没有则追加）
  if (isOpening) {
    const openingUser = { role: 'user', content: narratorOpeningPrompt(session) };
    const idx = lastUserIndex(messages);
    if (idx >= 0) messages[idx] = openingUser;
    else messages.push(openingUser);
  }

  // assembler 附加提示：插入到最后一条 user 消息之前，避免打断 current user 行动
  const extra = typeof context?.extraPrompt === 'string' ? context.extraPrompt.trim() : '';
  if (extra) {
    const idx = lastUserIndex(messages);
    const msg = { role: 'system', content: extra };
    if (idx >= 0) messages.splice(idx, 0, msg);
    else messages.push(msg);
  }

  // 重写指令（作者对本次演绎的额外要求，例如「更压抑，不要引入新角色」）
  const note = String(guidance || '').trim();
  if (note) {
    const idx = lastUserIndex(messages);
    const msg = {
      role: 'system',
      content: `【本轮改稿要求】（作者对本次演绎的额外要求，优先级高，但不得违背世界观与角色设定）\n${note}`,
    };
    if (idx >= 0) messages.splice(idx, 0, msg);
    else messages.push(msg);
  }

  return messages;
}

/**
 * 运行剧情演绎 Agent（流式）。
 * @param {object} opts
 * @param {object} opts.session
 * @param {object} [opts.context]    assembler.assembleContext() 产物
 * @param {number} [opts.turnNo]     回合号（仅作上下文记录）
 * @param {boolean} [opts.isOpening] 是否开场轮
 * @param {object} [opts.options]    覆盖 {temperature, maxTokens, reasoningEffort, model}
 * @param {function} [opts.onDelta]  回调 onDelta({type:'reasoning'|'content', delta})
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content:string, reasoning:string, usage:object, model:string, finishReason:string}>}
 */
export async function runNarrator({ session, context, turnNo, isOpening = false, options = {}, onDelta, signal } = {}) {
  const cfg = config.agents.narrator;
  const messages = buildNarratorMessages({ session, context, isOpening, guidance: options.guidance });

  let content = '';
  let reasoning = '';
  let usage = null;
  let model = options.model;
  let finishReason = null;

  for await (const ev of chatStream({
    messages,
    model: options.model,
    temperature: options.temperature ?? cfg.temperature,
    maxTokens: options.maxTokens ?? cfg.maxTokens,
    reasoningEffort: options.reasoningEffort ?? cfg.reasoningEffort,
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
