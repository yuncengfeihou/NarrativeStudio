#!/usr/bin/env node
/**
 * _work/real-segmented-run.mjs — 用真实模型跑几轮分段演绎
 *
 * 使用临时 SQLite + 独立端口，不污染 data/roleplay.db。
 * 依赖 .env 里的 STEPFUN_API_KEY；没有密钥时会直接报错退出。
 *
 * 流程：
 *   1. 导入 presets/nvzun-jianpolan.json
 *   2. 开一个 segmented 会话，跑 3 轮
 *   3. 开一个 single 会话，用同一个首轮行动跑 1 轮做对照
 *   4. 输出每轮耗时、工具调用、正文长度、usage，并保存全文到 _work/real-run-output.json
 *
 * 用法：node _work/real-segmented-run.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3214;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, 'real-run-output.json');

const ACTIONS = [
  '雨还在下，我把蛇皮袋往肩上一甩，问她：你认得我？',
  '我没有跟她走，先退后一步，盯着她撑伞的手。',
  '我问她七年前那个雨夜，她是不是也在场。',
];

function hasKey() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return false;
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(/^\s*STEPFUN_API_KEY\s*=\s*(.*)$/m);
  if (!m) return false;
  return Boolean(m[1].replace(/\s+#.*$/, '').trim());
}

async function req(method, url, body, timeoutMs = 600000) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
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

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server 未启动');
}

async function runTurn(sessionId, playerText) {
  const started = Date.now();
  const res = await req('POST', `/api/sessions/${sessionId}/turn`, { playerText });
  const durationMs = Date.now() - started;
  const events = parseSse(res.text);
  const narrative = events.find((e) => e.type === 'narrative_done')?.content || '';
  const done = events.find((e) => e.type === 'done') || null;
  const draftDone = events.find((e) => e.type === 'draft_done') || null;
  const tools = events.filter((e) => e.type === 'tool_call').map((e) => e.name);
  const fallback = events.find((e) => e.type === 'narration_fallback') || null;
  const error = events.find((e) => e.type === 'error') || null;
  return {
    status: res.status,
    durationMs,
    narrative,
    usage: done?.usage || null,
    sessionUsage: done?.session_usage || null,
    narrationMode: done?.narration_mode || null,
    draft: draftDone ? { rounds: draftDone.rounds, tools: draftDone.tools, sealed: draftDone.sealed } : null,
    toolNames: tools,
    fallback,
    error,
    eventTypes: events.map((e) => e.type),
  };
}

if (!hasKey()) {
  console.error('没有找到 STEPFUN_API_KEY，无法做真实运行。');
  process.exit(2);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narra-real-'));
const dbPath = path.join(tmpDir, 'real.db');

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DB_PATH: dbPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const report = { startedAt: new Date().toISOString(), actions: ACTIONS, segmented: [], single: null };

try {
  await waitUp();
  console.log('· 导入预设…');
  const imp = await req('POST', '/api/presets/nvzun-jianpolan/import');
  if (imp.status !== 201) throw new Error(`导入失败 ${imp.status}: ${imp.text}`);
  const world = imp.json;

  const persons = (world.card?.entities || []).filter((e) => e.type === 'person').length;
  console.log(`· 世界卡：${world.title}（角色 ${persons}，设定集 ${(world.card?.entities || []).length - persons}）`);

  console.log('\n=== 分段演绎：3 轮 ===');
  const segSession = await req('POST', '/api/sessions', {
    world_id: world.id,
    settings: { narration_mode: 'segmented' },
  });
  if (segSession.status !== 201) throw new Error(`建局失败 ${segSession.status}: ${segSession.text}`);
  const segId = segSession.json.id;

  for (let i = 0; i < ACTIONS.length; i++) {
    const action = ACTIONS[i];
    console.log(`\n--- 第 ${i + 1} 轮 ---`);
    console.log(`行动：${action}`);
    const r = await runTurn(segId, action);
    report.segmented.push({ action, ...r });
    console.log(`状态 ${r.status}｜耗时 ${(r.durationMs / 1000).toFixed(1)}s｜正文 ${r.narrative.length} 字｜`
      + `mode=${r.narrationMode}｜draft=${JSON.stringify(r.draft)}｜tools=${r.toolNames.join(',') || '无'}`);
    if (r.fallback) console.log(`回退：${r.fallback.reason}`);
    if (r.error) console.log(`错误：${r.error.message}`);
    console.log(`正文开头：${r.narrative.slice(0, 160).replace(/\n/g, ' ')}…`);
    console.log(`正文结尾：…${r.narrative.slice(-120).replace(/\n/g, ' ')}`);
  }

  console.log('\n=== 单发对照：第 1 轮 ===');
  const singleSession = await req('POST', '/api/sessions', {
    world_id: world.id,
    settings: { narration_mode: 'single' },
  });
  if (singleSession.status !== 201) throw new Error(`建对照局失败 ${singleSession.status}: ${singleSession.text}`);
  const singleId = singleSession.json.id;
  const sr = await runTurn(singleId, ACTIONS[0]);
  report.single = { action: ACTIONS[0], ...sr };
  console.log(`状态 ${sr.status}｜耗时 ${(sr.durationMs / 1000).toFixed(1)}s｜正文 ${sr.narrative.length} 字｜`
    + `mode=${sr.narrationMode}｜tools=${sr.toolNames.join(',') || '无'}`);
  console.log(`正文开头：${sr.narrative.slice(0, 160).replace(/\n/g, ' ')}…`);

  console.log('\n=== 落库检查 ===');
  const detail = await req('GET', `/api/sessions/${segId}`);
  const turns = detail.json?.turns || [];
  const narrators = turns.filter((t) => t.kind === 'narrator');
  console.log(`分段局 turns：player=${turns.filter((t) => t.kind === 'player').length}，`
    + `narrator=${narrators.length}，总字数=${narrators.reduce((n, t) => n + (t.content || '').length, 0)}`);
  console.log('每轮 narration meta：');
  for (const t of narrators) {
    const m = t.meta?.assembly?.narration;
    console.log(`  第 ${t.turn_no} 轮：${JSON.stringify(m)}`);
  }
  const toolLeak = turns.some((t) => /【辞书检索|已追加|已替换|已定稿/.test(t.content || ''));
  console.log(`工具文本是否漏进 turns：${toolLeak ? '是（异常）' : '否'}`);

  const detailSingle = await req('GET', `/api/sessions/${singleId}`);
  const sNarr = (detailSingle.json?.turns || []).filter((t) => t.kind === 'narrator');
  console.log(`单发局 turns：narrator=${sNarr.length}，字数=${sNarr.reduce((n, t) => n + (t.content || '').length, 0)}`);
  console.log(`单发局 narration meta：${JSON.stringify(sNarr[0]?.meta?.assembly?.narration)}`);

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n全文已保存：${OUT}`);
} catch (err) {
  console.error(`\n真实运行失败：${err?.message || err}`);
  console.error(`\n--- server log tail ---\n${log.slice(-4000)}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
