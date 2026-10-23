/**
 * End-to-end integration test against the REAL StepFun API.
 * Starts the server on a test port with a temp DB, then exercises:
 *   1. opening generation (narrator agent, streaming)
 *   2. branch generation (branch agent)
 *   3. a full turn with a branch choice (narrator + memory + branches)
 *   4. memory stats
 *   5. OpenAI-compatible passthrough (non-stream + stream)
 *   6. OpenAI-compatible roleplay mode (stream)
 *
 * Run: node tests/integration.js   (requires STEPFUN_API_KEY)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Load .env so the spawned server child inherits STEPFUN_API_KEY
try { process.loadEnvFile?.(path.join(ROOT, '.env')); } catch { /* no .env */ }

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, 'data', 'integration-test.db');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('server did not start');
}

/** Consume an SSE response, collecting typed events. */
async function consumeSSE(res, { onEvent } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { events.push({ type: '[DONE]' }); continue; }
        try {
          const evt = JSON.parse(payload);
          if (evt.type !== 'ping') { events.push(evt); onEvent?.(evt); }
        } catch { /* ignore */ }
      }
    }
  }
  return events;
}

function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); process.exitCode = 1; throw new Error(msg); }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });

  console.log('== starting server (temp DB, port %d) ==', PORT);
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  await waitForServer();
  console.log('  server up');

  try {
    /* ---------- 1. create session ---------- */
    console.log('\n== 1. create session ==');
    const settings = {
      title: '雨夜锈钥',
      opening: '暴雨夜，临江旧港的探照灯划破雨幕。你——失踪案唯一的目击者——在码头七号仓的阴影里，第一次见到了那个叫林霜的女人，和她掌心那枚泛着青光的古钥匙。',
      worldview: '现代都市临江市。表层是繁华港口城市，里层存在操控地下交易的神秘组织"灰鸽"。三个月内已有七人失踪，警方毫无头绪。',
      characters: [
        { name: '林霜', role: '追踪者', personality: '冷静、敏锐、外冷内热，不信任任何人', voice: '台词简短，句号收尾，几乎不用感叹号', secret: '她曾是灰鸽成员，钥匙是她带出的' },
        { name: '赵四海', role: '码头老板', personality: '圆滑世故，笑面虎', voice: '客套话多，喜欢绕弯子', secret: '暗地里为灰鸽洗货' },
      ],
      player_role: '失踪案唯一目击者，能看到别人看不见的"痕迹"',
      rules: '每轮1500-2500字；保持角色口吻；第三人称限知视角；结尾留悬念钩子；严禁meta评论。',
      style_tags: ['悬疑', '都市异能'],
      narrator_effort: 'high',
    };
    const createRes = await fetch(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: settings.title, settings }),
    });
    assert(createRes.ok, 'POST /api/sessions returns 2xx');
    const session = await createRes.json();
    assert(!!session.id, `session created (${session.id.slice(0, 8)}...)`);

    /* ---------- 2. opening via SSE ---------- */
    console.log('\n== 2. opening generation (narrator, streaming) ==');
    const t0 = Date.now();
    const openingRes = await fetch(`${BASE}/api/sessions/${session.id}/opening`, { method: 'POST' });
    assert(openingRes.ok && openingRes.headers.get('content-type')?.includes('text/event-stream'), 'SSE stream opened');
    const openingEvents = await consumeSSE(openingRes);
    const narrative = openingEvents.filter(e => e.type === 'narrative').map(e => e.delta).join('');
    const reasoning = openingEvents.filter(e => e.type === 'reasoning').map(e => e.delta).join('');
    const doneEvt = openingEvents.find(e => e.type === 'done');
    const branchEvt = openingEvents.find(e => e.type === 'branches');
    const memEvt = openingEvents.find(e => e.type === 'memory');
    console.log(`  opening: ${narrative.length} chars, reasoning: ${reasoning.length} chars, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    assert(narrative.length > 400, `narrative generated (${narrative.length} chars)`);
    assert(reasoning.length > 0, 'reasoning trace received');
    assert(!!doneEvt, 'done event received');
    assert(branchEvt?.branches?.length >= 3, `branch agent produced ${branchEvt?.branches?.length} options`);
    assert(!!memEvt, 'memory update event received');
    if (branchEvt?.branches?.[0]) {
      console.log(`  branch[0]: [${branchEvt.branches[0].tone}] ${branchEvt.branches[0].title} — ${branchEvt.branches[0].description.slice(0, 40)}...`);
    }

    /* ---------- 3. turn with branch choice ---------- */
    console.log('\n== 3. full turn with branch choice ==');
    const choice = branchEvt?.branches?.[0];
    const turnRes = await fetch(`${BASE}/api/sessions/${session.id}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerText: '我压低声音问林霜："这把钥匙，你从哪儿拿到的？"',
        branchChoice: choice,
        generateBranches: true,
      }),
    });
    assert(turnRes.ok, 'turn stream opened');
    const turnEvents = await consumeSSE(turnRes);
    const turnNarrative = turnEvents.filter(e => e.type === 'narrative').map(e => e.delta).join('');
    const turnDone = turnEvents.find(e => e.type === 'done');
    const turnBranches = turnEvents.find(e => e.type === 'branches');
    const turnError = turnEvents.find(e => e.type === 'error');
    if (turnNarrative.length <= 400) {
      console.log('  [debug] turn events:', JSON.stringify(turnEvents.map(e => ({ t: e.type, len: (e.delta || e.content || e.message || '').length }))));
      if (turnError) console.log('  [debug] error event:', turnError.message);
    }
    console.log(`  turn narrative: ${turnNarrative.length} chars, usage: ${JSON.stringify(turnDone?.usage)}`);
    assert(turnNarrative.length > 400, `turn narrative generated (${turnNarrative.length} chars)`);
    assert(!!turnDone, 'turn done event');
    assert(turnBranches?.branches?.length >= 3, 'branches regenerated for next round');

    /* ---------- 4. memory stats ---------- */
    console.log('\n== 4. memory system stats ==');
    const memRes = await fetch(`${BASE}/api/sessions/${session.id}/memory`);
    const mem = await memRes.json();
    console.log(`  turns=${mem.turn_count} context=${mem.context_tokens}/${mem.context_max} tiers=${JSON.stringify(mem.tiers)} entities=${mem.entities.length} facts=${mem.facts.length}`);
    assert(mem.turn_count >= 2, 'turn count advanced');
    assert(mem.tiers[0].count >= 2, 'L1 round summaries exist');
    assert(mem.state?.location || mem.state?.time, 'state tracker populated');
    assert(mem.context_tokens < mem.context_max, 'context under cap');

    /* ---------- 5. OpenAI passthrough ---------- */
    console.log('\n== 5. OpenAI-compatible passthrough ==');
    const modelsRes = await fetch(`${BASE}/v1/models`);
    const models = await modelsRes.json();
    assert(models.object === 'list' && models.data.some(m => m.id === 'step-5-preview'), 'GET /v1/models lists step-5-preview');

    const chatRes = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'step-5-preview',
        messages: [{ role: 'user', content: '用一句话回答：1+1=?' }],
        max_tokens: 200, reasoning_effort: 'low',
      }),
    });
    const chatJson = await chatRes.json();
    assert(chatJson.choices?.[0]?.message?.content, `passthrough non-stream ok: "${chatJson.choices[0].message.content.slice(0, 30)}..."`);
    assert(chatJson.usage?.total_tokens > 0, 'usage reported');

    const streamRes = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'step-5-preview',
        messages: [{ role: 'user', content: '数到三' }],
        max_tokens: 100, reasoning_effort: 'low', stream: true,
      }),
    });
    assert(streamRes.headers.get('content-type')?.includes('text/event-stream'), 'passthrough stream SSE');
    let streamed = '';
    const reader = streamRes.body.getReader();
    const dec = new TextDecoder();
    let sawDone = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      if (text.includes('data: [DONE]')) sawDone = true;
      for (const m of text.matchAll(/"content":"([^"]*)"/g)) streamed += m[1];
    }
    assert(sawDone && streamed.length > 0, `passthrough stream ok (${streamed.length} chars)`);

    /* ---------- 6. OpenAI roleplay mode ---------- */
    console.log('\n== 6. OpenAI-compatible roleplay mode (stream) ==');
    const rpRes = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'step-5-preview',
        session_id: session.id,
        messages: [{ role: 'user', content: '我跟着林霜拐进巷子，注意着身后的脚步声。' }],
        stream: true,
        generate_branches: true,
      }),
    });
    assert(rpRes.headers.get('content-type')?.includes('text/event-stream'), 'roleplay stream SSE');
    let rpContent = '';
    let rpReasoning = '';
    let rpSawDone = false;
    const r2 = rpRes.body.getReader();
    while (true) {
      const { done, value } = await r2.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      if (text.includes('data: [DONE]')) rpSawDone = true;
      for (const m of text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)) rpContent += m[1].replace(/\\n/g, '\n');
      for (const m of text.matchAll(/"reasoning_content":"((?:[^"\\]|\\.)*)"/g)) rpReasoning += m[1];
    }
    assert(rpSawDone, 'roleplay stream terminated with [DONE]');
    assert(rpContent.length > 300, `roleplay narrative streamed via OpenAI API (${rpContent.length} chars)`);
    assert(rpContent.includes('剧情分支选项'), 'branch options appended to OpenAI response');
    assert(rpReasoning.length > 0, 'reasoning_content field present');

    console.log('\n== ALL INTEGRATION TESTS PASSED ==');
  } finally {
    server.kill();
    await sleep(800);
    for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
  }
}

main().catch(err => {
  console.error('\nINTEGRATION TEST FAILED:', err.message);
  process.exit(1);
});
