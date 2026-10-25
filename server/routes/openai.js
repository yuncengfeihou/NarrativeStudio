/**
 * OpenAI-compatible surface.
 *
 *   GET  /v1/models
 *   POST /v1/chat/completions
 *
 * Two modes:
 *   1. Passthrough (no session_id): proxy to StepFun with full fidelity
 *      (streaming SSE piped through, usage + reasoning forwarded).
 *   2. Roleplay (session_id present): runs the multi-agent orchestrator;
 *      the narrator's narrative becomes `content`, its reasoning becomes
 *      `reasoning_content`/`reasoning`. Branch options are appended to the
 *      content as a trailing fenced block (and emitted as tool_calls-free
 *      plain text) so generic clients still see them.
 */
import { Router } from 'express';
import { chat } from '../llm.js';
import { getEffectiveConfig, resolveModelTarget } from '../model-registry.js';
import { runTurn, createSessionWithSettings } from '../agents/orchestrator.js';
import { getSession } from '../memory/store.js';

export const openaiRouter = Router();

/** 对外暴露的模型清单：运行期配置里的模型 + 两个 roleplay 虚拟模型。 */
function listVirtualModels() {
  const configured = getEffectiveConfig().models
    .filter((m) => m.enabled !== false)
    .map((m) => ({
      id: m.model, object: 'model', created: 1700000000, owned_by: m.providerId === 'env-provider' ? 'stepfun' : 'configured',
    }));
  const data = [];
  const seen = new Set();
  for (const entry of [
    ...configured,
    { id: 'roleplay-narrator', object: 'model', created: 1700000000, owned_by: 'narrative-studio' },
    { id: 'roleplay-branch', object: 'model', created: 1700000000, owned_by: 'narrative-studio' },
    { id: 'step-router-v1', object: 'model', created: 1700000000, owned_by: 'stepfun' },
  ]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    data.push(entry);
  }
  return data;
}

openaiRouter.get('/v1/models', (req, res) => {
  res.json({ object: 'list', data: listVirtualModels() });
});

openaiRouter.post('/v1/chat/completions', async (req, res) => {
  const body = req.body || {};
  const sessionId = body.session_id;

  try {
    if (!sessionId) {
      return await handlePassthrough(req, res, body);
    }
    return await handleRoleplay(req, res, body, sessionId);
  } catch (err) {
    sendOpenAiError(res, err);
  }
});

/* ----------------------------- passthrough ----------------------------- */

async function handlePassthrough(req, res, body) {
  const upstreamBody = sanitizeBody(body);
  const wantsStream = body.stream === true;
  // 透传也走运行期配置：未指定 model 时用 narrator 的生效模型；指定了就按配置解析服务商。
  // 客户端显式给的 model 字符串永远优先，未登记的名字按原样转发。
  const target = resolveModelTarget({ model: body.model || null });
  upstreamBody.model = target.model;

  if (!wantsStream) {
    const out = await chat({
      model: upstreamBody.model,
      messages: upstreamBody.messages,
      temperature: upstreamBody.temperature,
      maxTokens: upstreamBody.max_tokens,
      topP: upstreamBody.top_p,
      stop: upstreamBody.stop,
      frequencyPenalty: upstreamBody.frequency_penalty,
      reasoningEffort: upstreamBody.reasoning_effort,
      reasoningFormat: upstreamBody.reasoning_format,
      responseFormat: upstreamBody.response_format,
      signal: req.signal,
    });
    return res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: out.model || body.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: out.content,
          ...(out.reasoning ? { reasoning_content: out.reasoning, reasoning: out.reasoning } : {}),
        },
        finish_reason: out.finishReason || 'stop',
      }],
      usage: out.usage || undefined,
    });
  }

  // Stream: pipe upstream SSE through untouched (already OpenAI format).
  const upstream = await fetch(`${target.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(target.timeoutMs)]),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return sendOpenAiError(res, { message: `upstream ${upstream.status}: ${text.slice(0, 300)}`, status: upstream.status });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const reader = upstream.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    if (!res.writableEnded) res.write(`data: {"error":{"message":"${escape(err.message)}"}}\n\n`);
  }
  res.end();
}

function sanitizeBody(body) {
  const {
    model, messages, temperature, max_tokens, top_p, stop, frequency_penalty,
    reasoning_effort, reasoning_format, response_format, stream, stream_options,
    // strip our custom fields
    session_id, settings, generate_branches, branch_choice, roleplay, world_id, is_opening,
    directive, ...rest
  } = body;
  // model 只保留客户端显式给的值；缺省时由 handlePassthrough 用运行期配置补。
  const out = { model: model || '', messages: messages || [], ...rest };
  if (temperature != null) out.temperature = temperature;
  if (max_tokens != null) out.max_tokens = max_tokens;
  if (top_p != null) out.top_p = top_p;
  if (stop != null) out.stop = stop;
  if (frequency_penalty != null) out.frequency_penalty = frequency_penalty;
  if (reasoning_effort != null) out.reasoning_effort = reasoning_effort;
  if (reasoning_format != null) out.reasoning_format = reasoning_format;
  if (response_format != null) out.response_format = response_format;
  if (stream === true) { out.stream = true; if (stream_options) out.stream_options = stream_options; }
  return out;
}

/* ------------------------------ roleplay ------------------------------- */

async function handleRoleplay(req, res, body, sessionIdRaw) {
  let sessionId = sessionIdRaw;
  const settings = body.settings || body.roleplay?.settings;
  const worldId = body.world_id || body.roleplay?.world_id || settings?.world_id || null;

  // session_id === 'new'（或不存在 + 提供了 settings）→ 创建会话
  if ((sessionIdRaw === 'new' || sessionIdRaw === 'auto') || (settings && !getSession(sessionIdRaw))) {
    const session = createSessionWithSettings({
      title: settings?.title || '未命名剧情',
      worldId,
      settings: settings || {},
    });
    sessionId = session.id;
  }
  if (!getSession(sessionId)) {
    return sendOpenAiError(res, { message: `session not found: ${sessionIdRaw}`, type: 'invalid_request_error', code: 'session_not_found' }, 404);
  }

  // Extract the player action from the last user message (text + images).
  const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
  const { text: playerText, images } = extractUserContent(lastUser);

  const isOpening = body.is_opening === true || body.generate_opening === true;
  const generateBranches = body.generate_branches !== false;
  const branchChoice = body.branch_choice || body.roleplay?.branch_choice || null;
  const wantsStream = body.stream === true;

  const completionId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || resolveModelTarget({ agent: 'narrator' }).model;

  if (!wantsStream) {
    const result = await runTurn({
      sessionId, playerText, images, branchChoice, generateBranches, isOpening,
      signal: req.signal,
    });
    return res.json({
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: withBranchAppendix(result.narrative, result.branches),
          ...(result.reasoning ? { reasoning_content: result.reasoning, reasoning: result.reasoning } : {}),
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: result.usage?.prompt_tokens ?? 0,
        completion_tokens: result.usage?.completion_tokens ?? 0,
        total_tokens: result.usage?.total_tokens ?? 0,
        prompt_tokens_details: {
          cached_tokens: result.usage?.cached_tokens ?? 0,
        },
      },
      roleplay: {
        session_id: sessionId,
        turn_no: result.turn_no,
        branches: result.branches?.branches || [],
        usage: result.usage || null,
        session_usage: result.sessionUsage || null,
      },
    });
  }

  // Streaming roleplay: translate orchestrator events into OpenAI chunks.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (delta, finish) => {
    if (res.writableEnded) return;
    const chunk = {
      id: completionId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    };
    try {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    } catch {
      /* 客户端已断开：写入失败静默忽略 */
    }
  };
  send({ role: 'assistant', content: '' });

  let usage = null;
  let sentContent = false;
  const aborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });
  const onEvent = (evt) => {
    switch (evt.type) {
      case 'reasoning':
        send({ reasoning_content: evt.delta, reasoning: evt.delta });
        break;
      case 'narrative':
        sentContent = true;
        send({ content: evt.delta });
        break;
      case 'narrative_done':
        // 分段演绎不逐段推 content（草稿可能被 draft_edit 改写），定稿后一次给出。
        if (!sentContent && evt.content) {
          sentContent = true;
          send({ content: evt.content });
        }
        break;
      case 'branches':
        if (evt.branches?.length) {
          send({ content: `\n\n${formatBranchAppendix(evt.branches, evt.scene_summary)}` });
        }
        break;
      case 'done':
        usage = evt.usage;
        break;
      case 'error':
        res.write(`data: ${JSON.stringify({ error: { message: evt.message, type: 'server_error', code: 'roleplay_error' } })}\n\n`);
        break;
    }
  };

  try {
    await runTurn({
      sessionId, playerText, images, branchChoice, generateBranches, isOpening,
      onEvent, signal: aborter.signal,
    });
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error', code: 'roleplay_error' } })}\n\n`);
    }
  }
  const finalChunk = {
    id: completionId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: usage ? {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    } : null,
  };
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
  }
  res.end();
}

function extractUserContent(msg) {
  if (!msg) return { text: '', images: [] };
  const content = msg.content;
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts = [];
  const images = [];
  for (const part of content) {
    if (part?.type === 'text') texts.push(part.text || '');
    else if (part?.type === 'image_url' && part.image_url?.url) images.push({ url: part.image_url.url });
  }
  return { text: texts.join('\n'), images };
}

function withBranchAppendix(narrative, branches) {
  if (!branches?.branches?.length) return narrative;
  return narrative + formatBranchAppendix(branches.branches, branches.scene_summary);
}

function formatBranchAppendix(branches, sceneSummary) {
  const lines = branches.map((b, i) =>
    `${i + 1}. 【${b.tone || '抉择'}】${b.title} — ${b.description}`);
  return `\n\n---\n\n**【剧情分支选项】**${sceneSummary ? `（${sceneSummary}）\n` : '\n'}${lines.join('\n')}\n\n回复数字序号或描述你的行动。`;
}

function escape(s) {
  return String(s).replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function sendOpenAiError(res, err, status = 400) {
  if (res.headersSent) {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
    return res.end();
  }
  res.status(err.status || status).json({
    error: {
      message: err.message || 'internal error',
      type: err.type || 'invalid_request_error',
      code: err.code || null,
      param: err.param || null,
    },
  });
}
