#!/usr/bin/env node
/**
 * _work/real-tool-probe.mjs — 真实模型下，验证 codex_lookup 是否会被触发
 *
 * 用临时库导入预设，开一个 segmented 会话，跑两个“明确需要查设定”的行动：
 *   1. 问司楼的规则/后果（辞书里有明确 rules）
 *   2. 问无纹玉佩的来历（辞书里是 secret 条目）
 *
 * 输出每轮工具调用、轮数、正文是否命中辞书规则。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3215;
const BASE = `http://127.0.0.1:${PORT}`;

const ACTIONS = [
  '我拉住张兰，压低声音问：司楼到底是什么地方？进去的人会怎么样？',
  '我把手伸进口袋，摸到那枚无纹玉佩。我想知道它到底是什么来历。',
];

function hasKey() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return false;
  const m = fs.readFileSync(envPath, 'utf8').match(/^\s*STEPFUN_API_KEY\s*=\s*(.*)$/m);
  return Boolean(m && m[1].replace(/\s+#.*$/, '').trim());
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
    try { out.push(JSON.parse(payload)); } catch { /* ignore */ }
  }
  return out;
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server 未启动');
}

if (!hasKey()) {
  console.error('没有 STEPFUN_API_KEY');
  process.exit(2);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narra-probe-'));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(tmpDir, 'probe.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

try {
  await waitUp();
  const imp = await req('POST', '/api/presets/nvzun-jianpolan/import');
  if (imp.status !== 201) throw new Error(imp.text);
  const world = imp.json;
  const session = await req('POST', '/api/sessions', {
    world_id: world.id,
    settings: { narration_mode: 'segmented' },
  });
  if (session.status !== 201) throw new Error(session.text);
  const sid = session.json.id;

  for (let i = 0; i < ACTIONS.length; i++) {
    const action = ACTIONS[i];
    console.log(`\n=== 探针 ${i + 1} ===\n行动：${action}`);
    const started = Date.now();
    const res = await req('POST', `/api/sessions/${sid}/turn`, { playerText: action });
    const events = parseSse(res.text);
    const tools = events.filter((e) => e.type === 'tool_call');
    const draft = events.find((e) => e.type === 'draft_done');
    const narrative = events.find((e) => e.type === 'narrative_done')?.content || '';
    console.log(`状态 ${res.status}｜耗时 ${((Date.now() - started) / 1000).toFixed(1)}s｜`
      + `rounds=${draft?.rounds ?? '?'}｜tools=${tools.map((t) => `${t.name}(${t.ok ? 'ok' : 'err'})`).join(',') || '无'}｜`
      + `字数=${narrative.length}`);
    const probes = [
      ['入内即除籍', narrative.includes('入内即除籍')],
      ['办丧事', narrative.includes('办丧事')],
      ['无关玉佩/无纹玉佩', narrative.includes('无纹玉佩') || narrative.includes('玉佩')],
    ];
    console.log(`正文命中：${probes.map(([k, v]) => `${k}=${v ? '是' : '否'}`).join('｜')}`);
    console.log(`正文开头：${narrative.slice(0, 220).replace(/\n/g, ' ')}…`);
    console.log(`正文结尾：…${narrative.slice(-180).replace(/\n/g, ' ')}`);
  }
} catch (err) {
  console.error(`\n失败：${err?.message || err}`);
  console.error(log.slice(-3000));
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
