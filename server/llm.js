/**
 * server/llm.js — StepFun LLM 客户端（OpenAI 兼容）
 *
 * 支持：非流式 / SSE 流式（content + reasoning 双通道）、reasoning_effort、
 * 多模态消息、重试、取消，以及**完整的用量遥测**。
 *
 * 遥测（usage）字段：
 *   prompt_tokens       输入 token
 *   completion_tokens   输出 token
 *   total_tokens        合计
 *   cached_tokens       命中前缀缓存的输入 token（上游若返回）
 *   reasoning_tokens    推理过程占用的 token（上游若返回）
 *   ttft_ms             首字延迟（从发请求到第一个内容增量）
 *   duration_ms         总耗时
 *   output_chars        实际输出字符数
 *   tps                 生成速度（completion_tokens / 生成阶段的秒数）
 *
 * 这些字段既用于 UI 展示，也用于 sessions.usage_json 的累计统计。
 */
import { config } from './config.js';
import { resolveModelTarget } from './model-registry.js';

const REASONING_FIELDS = ['reasoning_content', 'reasoning'];

/**
 * 有 agent key 时，用模型注册表的生效值补缺省（temperature / maxTokens / reasoningEffort /
 * model）。调用方显式传入的字段仍然优先——单次覆盖（分段演绎的 roundMaxTokens、
 * runTurn 的 options.model 等）不能被 DB 绑定压掉。
 * 没有 agent 的调用（`/v1` 透传、测试假上游）只解析传输目标，不注入任何默认值。
 */
function withAgentDefaults(opts, target) {
  if (!opts.agent) return { ...opts, model: target.model };
  return {
    ...opts,
    model: target.model,
    temperature: opts.temperature ?? target.temperature ?? undefined,
    maxTokens: opts.maxTokens ?? target.maxTokens ?? undefined,
    reasoningEffort: opts.reasoningEffort ?? target.effort ?? undefined,
  };
}

export class LlmError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * 归一化上游 usage。不同供应商字段名不统一，这里做兼容抽取。
 * @param {object|null} raw
 * @returns {{prompt_tokens:number, completion_tokens:number, total_tokens:number, cached_tokens:number, reasoning_tokens:number}|null}
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = num(raw.prompt_tokens ?? raw.input_tokens);
  const completion = num(raw.completion_tokens ?? raw.output_tokens);
  const total = num(raw.total_tokens) || prompt + completion;
  // 缓存命中：OpenAI 用 prompt_tokens_details.cached_tokens，部分国产模型用 cached_tokens / prompt_cache_hit_tokens
  const cached = num(
    raw.prompt_tokens_details?.cached_tokens
    ?? raw.cached_tokens
    ?? raw.prompt_cache_hit_tokens
    ?? raw.input_tokens_details?.cached_tokens,
  );
  const reasoning = num(
    raw.completion_tokens_details?.reasoning_tokens
    ?? raw.reasoning_tokens
    ?? raw.output_tokens_details?.reasoning_tokens,
  );
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 在一次调用结束后补齐耗时类字段。 */
function withTiming(usage, { startedAt, firstTokenAt, endedAt, outputChars = 0 }) {
  if (!usage) usage = {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0,
  };
  const duration = Math.max(0, endedAt - startedAt);
  const ttft = firstTokenAt ? Math.max(0, firstTokenAt - startedAt) : null;
  // 生成阶段耗时：首字之后到结束。用它算 tps 才准确（不含排队与预填充）。
  const genMs = firstTokenAt ? Math.max(1, endedAt - firstTokenAt) : Math.max(1, duration);
  const genTokens = Math.max(0, usage.completion_tokens - usage.reasoning_tokens);
  return {
    ...usage,
    ttft_ms: ttft,
    duration_ms: Math.round(duration),
    output_chars: outputChars,
    tps: genTokens > 0 ? Math.round((genTokens / (genMs / 1000)) * 10) / 10 : null,
    cache_rate: usage.prompt_tokens > 0
      ? Math.round((usage.cached_tokens / usage.prompt_tokens) * 1000) / 1000
      : null,
  };
}

/**
 * 非流式调用。
 * @returns {Promise<{content, reasoning, usage, model, finishReason, raw}>}
 */
export async function chat(opts) {
  const target = resolveModelTarget({ agent: opts.agent || null, model: opts.model || null });
  const effective = withAgentDefaults(opts, target);
  const run = async (call) => {
    const body = buildBody(call, false);
    const startedAt = Date.now();
    const res = await withRetry(
      () => fetchJson(`${target.baseUrl}/chat/completions`, body, call.signal, target),
      target,
    );
    const endedAt = Date.now();
    const choice = res.choices?.[0];
    const msg = choice?.message || {};
    const content = msg.content || '';
    const reasoning = pickReasoning(msg);
    return {
      content,
      reasoning,
      usage: withTiming(normalizeUsage(res.usage), {
        startedAt, firstTokenAt: startedAt, endedAt, outputChars: content.length + reasoning.length,
      }),
      model: res.model,
      finishReason: choice?.finish_reason,
      raw: res,
    };
  };

  const first = await run(effective);
  if (first.content.trim() || effective.signal?.aborted || effective.noEmptyRetry) return first;

  // step-5-preview 的推理过程也计入 max_tokens：预算被推理耗尽时 content 会是空的。
  // 这不能被当成「模型没有内容」——旁路 Agent 会把空 JSON 误读成「本轮无变化」。
  const budget = Number(effective.maxTokens);
  const used = Number(first.usage?.completion_tokens) || 0;
  const exhausted = first.finishReason === 'length'
    || (Number.isFinite(budget) && budget > 0 && used >= budget * 0.9);
  if (!exhausted) return first;

  console.warn(`[llm] 空内容且预算耗尽（${used}/${Number.isFinite(budget) ? budget : '?'}），降推理重试一次`);
  const retry = await run({
    ...effective,
    reasoningEffort: 'low',
    maxTokens: Math.max(8000, Math.min(64000, Number.isFinite(budget) && budget > 0 ? budget * 2 : 12000)),
    noEmptyRetry: true,
  });
  return retry.content.trim() ? retry : first;
}

/**
 * 流式调用。异步生成器，yield：
 *   {type:'reasoning'|'content', delta}
 *   {type:'meta', usage, model, finishReason}
 */
export async function* chatStream(opts) {
  const target = resolveModelTarget({ agent: opts.agent || null, model: opts.model || null });
  const effective = withAgentDefaults(opts, target);
  const body = buildBody(effective, true);
  const startedAt = Date.now();
  let firstTokenAt = null;
  let usage = null;
  let model = target.model;
  let finishReason = null;
  let outputChars = 0;

  const res = await withRetry(
    () => fetchStream(`${target.baseUrl}/chat/completions`, body, effective.signal, target),
    target,
  );
  if (!res.ok || !res.body) {
    const text = await safeText(res);
    throw new LlmError(`上游 ${res.status}: ${text.slice(0, 500)}`, {
      status: res.status, retryable: res.status >= 500 || res.status === 429,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.model) model = json.model;
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        const reasoning = pickReasoning(delta);
        if (reasoning) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          outputChars += reasoning.length;
          yield { type: 'reasoning', delta: reasoning };
        }
        if (delta.content) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          outputChars += delta.content.length;
          yield { type: 'content', delta: delta.content };
        }
        if (delta.tool_calls) yield { type: 'tool_calls', delta: delta.tool_calls };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  yield {
    type: 'meta',
    usage: withTiming(normalizeUsage(usage), {
      startedAt, firstTokenAt, endedAt: Date.now(), outputChars,
    }),
    model,
    finishReason,
  };
}

function buildBody(opts, stream) {
  const body = {
    model: opts.model || config.upstream.model,
    messages: opts.messages,
    stream,
  };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.topP != null) body.top_p = opts.topP;
  if (opts.stop) body.stop = opts.stop;
  if (opts.frequencyPenalty != null) body.frequency_penalty = opts.frequencyPenalty;
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  if (opts.reasoningFormat) body.reasoning_format = opts.reasoningFormat;
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  // 工具循环只用于分段演绎；工具结果由调用方自己管理，不进入 messages 的持久层。
  if (Array.isArray(opts.tools) && opts.tools.length) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  // 请求上游在流末尾带上 usage，否则流式拿不到 token 统计
  if (stream) body.stream_options = { include_usage: true, ...(opts.streamOptions || {}) };
  return body;
}

function pickReasoning(obj) {
  for (const f of REASONING_FIELDS) {
    if (typeof obj?.[f] === 'string' && obj[f]) return obj[f];
  }
  return '';
}

async function fetchJson(url, body, signal, target) {
  const res = await fetchOnce(url, body, signal, target);
  if (!res.ok) {
    const text = await safeText(res);
    throw new LlmError(`上游 ${res.status}: ${text.slice(0, 500)}`, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  return res.json();
}

async function fetchStream(url, body, signal, target) {
  return fetchOnce(url, body, signal, target);
}

async function fetchOnce(url, body, signal, target) {
  const timeout = AbortSignal.timeout(target?.timeoutMs || config.upstream.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${target?.apiKey || config.upstream.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: combined,
  });
}

async function safeText(res) {
  try { return await res.text(); } catch { return '<no body>'; }
}

async function withRetry(fn, target) {
  const maxRetries = Number.isFinite(target?.maxRetries) ? target.maxRetries : config.upstream.maxRetries;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err?.name === 'AbortError') throw err;
      const retryable = err?.retryable
        || err?.name === 'TimeoutError'
        || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code)
        || (err?.status >= 500 && err?.status < 600);
      if (!retryable || attempt === maxRetries) throw err;
      const backoff = Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

