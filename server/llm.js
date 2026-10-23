/**
 * StepFun LLM client (OpenAI-compatible chat completions).
 * Supports non-streaming, SSE streaming (content + reasoning deltas),
 * reasoning_effort control, multipart (image) messages, retries and abort.
 */
import { config } from './config.js';

const REASONING_FIELDS = ['reasoning_content', 'reasoning'];

export class LlmError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

let requestCounter = 0;

/**
 * One chat completion call.
 * @param {object} opts
 * @param {Array} opts.messages  OpenAI-format messages
 * @param {string} [opts.model]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {'low'|'medium'|'high'} [opts.reasoningEffort]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content:string, reasoning:string, usage:object, model:string, raw:object}>}
 */
export async function chat(opts) {
  const body = buildBody(opts, false);
  const res = await withRetry(() => fetchJson(`${config.upstream.baseUrl}/chat/completions`, body, opts.signal));
  const choice = res.choices?.[0];
  const msg = choice?.message || {};
  return {
    content: msg.content || '',
    reasoning: pickReasoning(msg),
    usage: res.usage || null,
    model: res.model,
    finishReason: choice?.finish_reason,
    raw: res,
  };
}

/**
 * Streaming chat completion. Async generator yielding
 * {type:'reasoning'|'content'|'meta', delta, usage?}.
 */
export async function* chatStream(opts) {
  const body = buildBody(opts, true);
  const res = await withRetry(() => fetchStream(`${config.upstream.baseUrl}/chat/completions`, body, opts.signal));
  if (!res.ok || !res.body) {
    const text = await safeText(res);
    throw new LlmError(`Upstream ${res.status}: ${text.slice(0, 500)}`, { status: res.status, retryable: res.status >= 500 });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let model = opts.model || config.upstream.model;
  let finishReason = null;

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
        if (reasoning) yield { type: 'reasoning', delta: reasoning };
        if (delta.content) yield { type: 'content', delta: delta.content };
        if (delta.tool_calls) yield { type: 'tool_calls', delta: delta.tool_calls };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  yield { type: 'meta', usage, model, finishReason };
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
  if (stream && opts.streamOptions) body.stream_options = opts.streamOptions;
  return body;
}

function pickReasoning(obj) {
  for (const f of REASONING_FIELDS) {
    if (typeof obj?.[f] === 'string' && obj[f]) return obj[f];
  }
  return '';
}

async function fetchJson(url, body, signal) {
  const res = await fetchOnce(url, body, signal);
  if (!res.ok) {
    const text = await safeText(res);
    throw new LlmError(`Upstream ${res.status}: ${text.slice(0, 500)}`, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  return res.json();
}

async function fetchStream(url, body, signal) {
  return fetchOnce(url, body, signal);
}

async function fetchOnce(url, body, signal) {
  const timeout = AbortSignal.timeout(config.upstream.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.upstream.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: combined,
  });
}

async function safeText(res) {
  try { return await res.text(); } catch { return '<no body>'; }
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= config.upstream.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Caller/client cancellation is never retried.
      if (err?.name === 'AbortError') throw err;
      const retryable = err?.retryable
        || err?.name === 'TimeoutError'
        || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code)
        || (err?.status >= 500 && err?.status < 600);
      if (!retryable || attempt === config.upstream.maxRetries) throw err;
      const backoff = Math.min(1000 * 2 ** attempt, 8000);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

function isTimeout(err) {
  return err?.name === 'TimeoutError';
}

/** Model id used by OpenAI-compatible surface. */
export const UPSTREAM_MODEL = config.upstream.model;
