#!/usr/bin/env node
/**
 * _work/segmented-e2e.mjs — 分段演绎端到端冒烟测试（不访问真实模型）
 *
 * 起一个本地假上游，模拟 OpenAI 的流式 tool_calls：
 *   round 1 → codex_lookup("司楼")
 *   round 2 → 流式正文，无工具调用 → 自动定稿
 * 然后让真实 server 跑一轮，检查：
 *   - SSE 事件顺序与内容
 *   - turns 里只有一条 narrator，且不含工具结果
 *   - meta.assembly.narration 记录轮数/工具次数
 *   - 上游拒绝 tools 时回退单发
 *
 * 用法：node _work/segmented-e2e.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 假上游                                                                  */
/* ══════════════════════════════════════════════════════════════════════ */

let rejectTools = false;
// D31：只回 reasoning、不回正文（复现「重试仍空」）。单发模式下两次都这样回，
// 用来验证「整拍回滚、不留空行、不留孤儿 player 行」。
let reasoningOnly = false;
// 断连（复现 `terminated`）：发一个 chunk 后直接销毁 socket。
let dropConnection = false;
// D33：只断 N 次，之后正常产出。用来验证「抖一下就整拍重发、内容不丢」。
let dropTimesLeft = 0;

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendSse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function completion({ delta = {}, finish = null, usage = null }) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

const fakeUpstream = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404); res.end('not found'); return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('bad json'); return; }

  if (rejectTools && Array.isArray(body.tools) && body.tools.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'tools unsupported by fake upstream' } }));
    return;
  }

  // 非流式：史官 / 走向 / 校勘等结构化 Agent 统一返回空对象。
  if (!body.stream) {
    sendJson(res, {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      model: 'fake-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '{}' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
    return;
  }

  // 流式旁白。
  const hasToolExchange = (body.messages || []).some(
    (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length,
  );
  const segmented = Array.isArray(body.tools) && body.tools.length > 0;

  if (dropConnection) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify(completion({ delta: { content: '半句' } }))}\n\n`);
    // 不写 [DONE]、不 end：直接断。上游「terminated」就是这种形状。
    res.socket?.destroy();
    return;
  }

  // D33：连续抖动 N 次后放行，用来验证整拍重发能救回来（不是整拍报废）。
  if (dropTimesLeft > 0) {
    dropTimesLeft -= 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify(completion({ delta: { content: '抖一下' } }))}\n\n`);
    res.socket?.destroy();
    return;
  }

  if (reasoningOnly) {
    sendSse(res, [
      completion({ delta: { reasoning_content: '我先想想这一拍该怎么接。' } }),
      completion({ finish: 'stop', usage: { prompt_tokens: 50, completion_tokens: 2369, total_tokens: 2419 } }),
    ]);
    return;
  }

  if (segmented && !hasToolExchange) {
    sendSse(res, [
      completion({
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_lookup_1',
            type: 'function',
            function: { name: 'codex_lookup', arguments: JSON.stringify({ query: '司楼' }) },
          }],
        },
      }),
      completion({ finish: 'tool_calls', usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 } }),
    ]);
    return;
  }

  if (segmented) {
    sendSse(res, [
      completion({ delta: { content: '雨落了下来。' } }),
      completion({ delta: { content: '司楼的灯在雨里亮着。' } }),
      completion({ finish: 'stop', usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } }),
    ]);
    return;
  }

  sendSse(res, [
    completion({ delta: { content: '单发正文。' } }),
    completion({ finish: 'stop', usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }),
  ]);
});

/* ══════════════════════════════════════════════════════════════════════ */
/* 启动真实 server                                                         */
/* ══════════════════════════════════════════════════════════════════════ */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narra-e2e-'));
const dbPath = path.join(tmpDir, 'e2e.db');
const API_PORT = 3213;
const BASE = `http://127.0.0.1:${API_PORT}`;

await new Promise((resolve) => fakeUpstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = fakeUpstream.address().port;

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    HOST: '127.0.0.1',
    DB_PATH: dbPath,
    STEPFUN_API_KEY: 'test-key',
    STEPFUN_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    LLM_MAX_RETRIES: '0',
    NARRATION_MODE: 'single',
    SUMMARY_HIGH_TOKENS: '999999',
    CONTINUITY_EVERY: '999',
    LORE_SCAN_DEPTH: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/config`);
      if (res.ok) return;
    } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server 未启动：\n${serverLog}`);
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE / 纯文本 */ }
  return { status: res.status, text, json };
}

function parseSse(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch { /* 忽略坏帧 */ }
  }
  return out;
}

try {
  await waitUp();
  console.log('\n=== 建卡 / 建局 ===');
  const worldRes = await req('POST', '/api/worlds', {
    card: {
      version: 5,
      title: '分段测试卡',
      premise: '一场雨里的测试。',
      entities: [
        { id: 'me', type: 'person', name: '我', role: '主角', summary: '测试' },
        {
          id: 'silou', type: 'institution', name: '司楼', aliases: ['青楼'],
          summary: '官营青楼。', facets: { rules: ['入内即除籍'] },
        },
      ],
      timeline: [],
      anchors: [{
        id: 'prologue', label: '序章', after_event: '',
        snapshot: { time: '夜', place: '街口', characters: {}, inventory: [], last_hook: '雨' },
        opening_seed: '雨。',
      }],
      player: { name: '我', mode: 'original' },
    },
  });
  ok(worldRes.status === 201, '世界卡创建成功', worldRes.text);
  const worldId = worldRes.json?.id;

  const sessionRes = await req('POST', '/api/sessions', {
    world_id: worldId,
    settings: { narration_mode: 'segmented' },
  });
  ok(sessionRes.status === 201, '会话创建成功', sessionRes.text);
  const sessionId = sessionRes.json?.id;
  eq(sessionRes.json?.settings?.narration_mode, 'segmented', '会话启用分段演绎');

  console.log('\n=== 分段回合：工具调用 → 定稿 ===');
  const turnRes = await req('POST', `/api/sessions/${sessionId}/turn`, {
    playerText: '我走进司楼。',
  });
  ok(turnRes.status === 200, '回合请求成功', turnRes.text.slice(0, 300));
  const events = parseSse(turnRes.text);
  const types = events.map((e) => e.type);
  ok(types.includes('draft_start'), 'SSE 有 draft_start');
  ok(types.includes('tool_call'), 'SSE 有 tool_call');
  ok(types.includes('draft_done'), 'SSE 有 draft_done');
  ok(types.includes('narrative_done'), 'SSE 有 narrative_done');
  ok(types.includes('done'), 'SSE 有 done');

  const toolEvt = events.find((e) => e.type === 'tool_call');
  eq(toolEvt?.name, 'codex_lookup', '工具名是 codex_lookup');
  ok(toolEvt?.ok === true, '工具调用成功');

  const idx = (t) => types.indexOf(t);
  ok(idx('draft_start') < idx('tool_call'), 'draft_start 在 tool_call 之前');
  ok(idx('tool_call') < idx('draft_done'), 'tool_call 在 draft_done 之前');
  ok(idx('draft_done') < idx('narrative_done'), 'draft_done 在 narrative_done 之前');

  const done = events.find((e) => e.type === 'done');
  eq(done?.narration_mode, 'segmented', 'done 标记分段模式');

  const narrative = events.find((e) => e.type === 'narrative_done')?.content || '';
  ok(narrative.includes('雨落了下来'), '定稿正文正确');
  ok(!narrative.includes('入内即除籍'), '工具结果没有混进正文');
  ok(!narrative.includes('辞书检索'), '工具结果没有混进正文（无检索头）');

  console.log('\n=== 落库：只有一条 narrator ===');
  const detail = await req('GET', `/api/sessions/${sessionId}`);
  const turns = detail.json?.turns || [];
  const narrators = turns.filter((t) => t.kind === 'narrator');
  const players = turns.filter((t) => t.kind === 'player');
  eq(narrators.length, 1, '只写入一条 narrator');
  eq(players.length, 1, '玩家行动照常落库');
  ok(narrators[0]?.content.includes('雨落了下来'), '落库正文是定稿');
  ok(!turns.some((t) => (t.content || '').includes('入内即除籍')), '工具结果没有落进 turns');

  const narrationMeta = narrators[0]?.meta?.assembly?.narration;
  eq(narrationMeta?.mode, 'segmented', 'meta 记录分段模式');
  eq(narrationMeta?.rounds, 2, 'meta 记录两轮');
  eq(narrationMeta?.tools, 1, 'meta 记录一次工具调用');
  ok(narrationMeta?.sealed === true, 'meta 记录已定稿');

  // P2：装配清单与场记单档位必须随回合落库——只在装配出口存在的话，
  // 事后无法从 turns 回答「这一拍到底给了模型什么」。
  const asm = narrators[0]?.meta?.assembly || {};
  ok(Array.isArray(asm.messages) && asm.messages.length > 0, 'meta 落库逐条渲染归属（messages）');
  ok(asm.messages.every((m) => typeof m.owner === 'string' && typeof m.tokens === 'number'),
    'messages 每条都带 owner 与 tokens');
  ok(asm.messages.some((m) => m.owner === 'scene_sheet'), 'messages 里有一条归属场记单');
  ok(asm.scene_sheet && typeof asm.scene_sheet === 'object', 'meta 落库场记单档位（scene_sheet）');
  ok(typeof asm.scene_sheet.cast_mode === 'string', 'scene_sheet 记录在场渲染档位');

  console.log('\n=== 回退：上游拒绝 tools ===');
  rejectTools = true;
  const session2 = await req('POST', '/api/sessions', {
    world_id: worldId,
    settings: { narration_mode: 'segmented' },
  });
  const sid2 = session2.json?.id;
  const fallbackRes = await req('POST', `/api/sessions/${sid2}/turn`, {
    playerText: '再试一次。',
  });
  ok(fallbackRes.status === 200, '回退回合仍然成功', fallbackRes.text.slice(0, 300));
  const fbEvents = parseSse(fallbackRes.text);
  const fbTypes = fbEvents.map((e) => e.type);
  ok(fbTypes.includes('narration_fallback'), 'SSE 有 narration_fallback');
  const fbNarrative = fbEvents.find((e) => e.type === 'narrative_done')?.content || '';
  ok(fbNarrative.includes('单发正文'), '回退后输出单发正文');

  const detail2 = await req('GET', `/api/sessions/${sid2}`);
  const narr2 = (detail2.json?.turns || []).filter((t) => t.kind === 'narrator');
  eq(narr2.length, 1, '回退后也只写入一条 narrator');
  eq(narr2[0]?.meta?.assembly?.narration?.fallback, 'segmented', 'meta 记录回退原因');
  eq(narr2[0]?.meta?.assembly?.narration?.mode, 'single', '回退后模式记为 single');

  /* ══════════════════════════════════════════════════════════════════ */
  /* D31：没有正文的那一拍，一行都不许落库                                  */
  /* ══════════════════════════════════════════════════════════════════ */
  console.log('\n=== D31：正文为空 → 整拍回滚（不留空行、不留孤儿） ===');
  reasoningOnly = true;   // 单发模式：首次空 → 关推理重试 → 仍空
  const session3 = await req('POST', '/api/sessions', { world_id: worldId });
  const sid3 = session3.json?.id;
  const emptyRes = await req('POST', `/api/sessions/${sid3}/turn`, { playerText: '我说一句话。' });
  const emptyEvents = parseSse(emptyRes.text);
  const emptyErr = emptyEvents.find((e) => e.type === 'error');
  ok(!!emptyErr, 'SSE 发出 error 事件（不是静默失败）');
  ok(emptyErr?.empty_narration === true, 'error 事件标 empty_narration');
  ok(emptyErr?.retryable === true, 'error 事件标 retryable（重发安全）');
  ok(emptyErr?.not_persisted === true, 'error 事件标 not_persisted（服务器没写库）');
  ok(!emptyEvents.some((e) => e.type === 'done'), '没有 done 事件（这一拍不算成功）');

  const detail3 = await req('GET', `/api/sessions/${sid3}`);
  const turns3 = detail3.json?.turns || [];
  eq(turns3.filter((t) => t.kind === 'player').length, 0, '玩家行动没有落库（不再留下孤儿 player 行）');
  eq(turns3.filter((t) => t.kind === 'narrator').length, 0, '空正文没有落库（不再有空 assistant 行）');
  eq(detail3.json?.turn_count || 0, 0, '会话回合数没有前进');

  reasoningOnly = false;
  // 再发一次正常回合：证明回滚后会话仍可用，且回合号从 1 开始（没有空洞）。
  const retryRes = await req('POST', `/api/sessions/${sid3}/turn`, { playerText: '我再说一句话。' });
  const retryEvents = parseSse(retryRes.text);
  ok(retryEvents.some((e) => e.type === 'done'), '回滚后重发成功');
  const detail4 = await req('GET', `/api/sessions/${sid3}`);
  const turns4 = detail4.json?.turns || [];
  eq(turns4.filter((t) => t.kind === 'player').map((t) => t.turn_no), [1], '重发用的是第 1 拍（回滚没留空洞）');
  eq(turns4.filter((t) => t.kind === 'narrator').length, 1, '重发后有一条 narrator');

  /* ══════════════════════════════════════════════════════════════════ */
  /* D31：上游断连 → 整拍回滚（原先是孤儿回合）                             */
  /* ══════════════════════════════════════════════════════════════════ */
  console.log('\n=== D31：上游断连 → 整拍回滚（原先会留孤儿回合） ===');
  dropConnection = true;
  const session4 = await req('POST', '/api/sessions', { world_id: worldId });
  const sid4 = session4.json?.id;
  const dropRes = await req('POST', `/api/sessions/${sid4}/turn`, { playerText: '推门出去。' });
  const dropEvents = parseSse(dropRes.text);
  const dropErr = dropEvents.find((e) => e.type === 'error');
  ok(!!dropErr, '断连时发出 error 事件');
  eq(dropErr?.aborted, undefined, '断连不算用户取消（aborted 不置位）');
  ok(dropErr?.not_persisted === true, '断连时标 not_persisted（服务器没写库，可安全重发）');

  const detail5 = await req('GET', `/api/sessions/${sid4}`);
  const turns5 = detail5.json?.turns || [];
  eq(turns5.length, 0, '断连后库里一行都没有（不再是孤儿 player 行）');
  eq(detail5.json?.turn_count || 0, 0, '断连后回合数没有前进');

  dropConnection = false;
  const afterDrop = await req('POST', `/api/sessions/${sid4}/turn`, { playerText: '推门出去。' });
  ok(parseSse(afterDrop.text).some((e) => e.type === 'done'), '断连整拍回滚后可以直接重发');
  const detail6 = await req('GET', `/api/sessions/${sid4}`);
  eq((detail6.json?.turns || []).filter((t) => t.kind === 'player').map((t) => t.turn_no), [1],
    '重发用的是第 1 拍（断连没留空洞）');

  /* ══════════════════════════════════════════════════════════════════ */
  /* D33：抖动两次 → 自动整拍重发，用户不用重打那句话                     */
  /* ══════════════════════════════════════════════════════════════════ */
  console.log('\n=== D33：上游抖动 → 自动整拍重发（用户无感，行动不丢） ===');
  dropTimesLeft = 2;
  const session5 = await req('POST', '/api/sessions', { world_id: worldId });
  const sid5 = session5.json?.id;
  const flakyRes = await req('POST', `/api/sessions/${sid5}/turn`, { playerText: '我数了数口袋里的钱。' });
  const flakyEvents = parseSse(flakyRes.text);
  const retryEvts = flakyEvents.filter((e) => e.type === 'narration_retry');
  eq(retryEvts.map((e) => e.attempt), [1, 2], '每次抖动都发 narration_retry（attempt 依次递增）');
  eq(retryEvts[0]?.max, 3, 'max 与 NARRATION_RETRY_MAX 一致');
  ok(!flakyEvents.some((e) => e.type === 'error'), '抖动两次没有把这一拍判失败');
  ok(flakyEvents.some((e) => e.type === 'done'), '第三次尝试成功后正常 done');
  eq(dropTimesLeft, 0, '假上游确实断过两次');

  const detail7 = await req('GET', `/api/sessions/${sid5}`);
  const turns7 = detail7.json?.turns || [];
  eq(turns7.filter((t) => t.kind === 'player').map((t) => t.turn_no), [1],
    '玩家行动只落库一次（重发不会重复记录同一句话）');
  const narr7 = turns7.filter((t) => t.kind === 'narrator');
  eq(narr7.length, 1, '正文只落一条');
  eq(narr7[0]?.meta?.assembly?.narration?.transient_retries, 2, 'meta 记下重试了 2 次（可审计）');
  ok(!String(narr7[0]?.content || '').includes('抖一下'), '残稿没有混进正文（重置后重新写）');
} finally {
  child.kill();
  await new Promise((r) => fakeUpstream.close(r));
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`segmented-e2e: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(`\n--- server log tail ---\n${serverLog.slice(-3000)}`);
  process.exit(1);
}
