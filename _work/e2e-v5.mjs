#!/usr/bin/env node
/**
 * 真实模型端到端测试版（v5）。
 *
 * 与 tests/ 的单元/接口测试不同：这里跑的是**真实上游模型 + 真实 SSE 管线**，
 * 覆盖「开局 → 连续演绎 → 记忆落库 → 历史检索 → 分支回滚 → 定稿」整条链路，
 * 用断言把架构红线变成可重复的检查项。
 *
 * 隔离：默认自起一个临时服务（随机端口 + os.tmpdir() 下的临时 SQLite），
 * 从 presets/ 导入世界卡，跑完删除。**不碰 data/roleplay.db，也不碰 3210。**
 *
 * 用法：
 *   node _work/e2e-v5.mjs                        # core：开局 + 3 轮 + 历史检索 + 定稿
 *   node _work/e2e-v5.mjs --turns 5              # 多跑两轮
 *   node _work/e2e-v5.mjs --scenario full        # 追加回滚 / 重写 / 分段演绎 / 一致性检查
 *   node _work/e2e-v5.mjs --base http://127.0.0.1:3210 --world nvzun-jianpolan
 *                                                # 打到已有实例（会新建会话，不隔离数据）
 *   node _work/e2e-v5.mjs --keep                 # 保留临时服务与日志，便于排查
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败或运行异常。
 * 报告：默认写到 os.tmpdir()/ns-e2e-<时间戳>.json，可用 --report 指定。
 *
 * 断言目录（按阶段）：
 *   setup   卡是 v5、实体数与人物数 > 0、会话创建成功
 *   turn    无 error 事件 / 正文 ≥ 200 字 / done / 回合号递增 / 史官 memory 事件
 *           / state+player_view / 总预算 ≤ 软目标与硬上限 / 场次与原文无洞
 *           / system 层 token 与 system_hash 跨轮恒定（缓存前缀不破）
 *           / 无硬上限降级、无层降级
 *   data    回合成对、记忆表有数据、world_state 路径命中白名单、玩家运行态有写入
 *   recall  3 字查询走 FTS5（meta.engine 自报）、2 字查询走 LIKE 兜底、空查询 400
 *   branch  回滚开新分支且旧分支 abandoned、新分支继承历史、新回合落在新分支
 *   rewrite 重写产生 fork 并落新回合
 *   seg     分段模式事件链（或明确 fallback）、工具名合法
 *   canon   定稿产出 v5 新卡、关系账本并回人物 entities、旧会话不受影响
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsFor } from '../server/world/state-paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------- 参数 ------------------------------- */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
if (argv.help || argv.h) {
  console.log('用法: node _work/e2e-v5.mjs [--scenario core|full] [--turns N] [--preset id]');
  console.log('       [--base http://127.0.0.1:3210] [--world id] [--keep] [--report file] [--timeout ms]');
  process.exit(0);
}

const SCENARIO = String(argv.scenario || 'core').toLowerCase();
const FULL = SCENARIO === 'full';
const OPTS = {
  base: argv.base ? String(argv.base).replace(/\/+$/, '') : null,
  world: argv.world ? String(argv.world) : null,
  preset: String(argv.preset || 'nvzun-jianpolan'),
  turns: clampInt(argv.turns, 3, 1, 8),
  keep: !!argv.keep,
  report: argv.report ? String(argv.report) : null,
  timeoutMs: clampInt(argv.timeout, 15 * 60 * 1000, 60 * 1000, 60 * 60 * 1000),
};

/* 玩家行动：写成与卡无关的通用动作，换一张卡也能跑。 */
const ACTIONS = [
  '我环顾四周，先确认自己身在何处、身边都有谁。',
  '我向最近的人开口，问出此刻最要紧的那件事。',
  '我没有立刻回答，先观察对方的反应再决定怎么说。',
  '我答应帮忙，但要求对方先给出一个明确的保证。',
  '我找了个借口离开人群，想去安静的地方理清头绪。',
  '我把刚才听到的线索在心里过了一遍，决定先按兵不动。',
  '我伸手去碰那件最显眼的东西，想看它会有什么反应。',
  '我直接点破刚才被含糊带过的那句话，等对方解释。',
];

const ALLOWED_TOOLS = new Set(['draft_append', 'draft_edit', 'draft_seal', 'codex_lookup', 'recall_history']);

/* ------------------------------- 断言 ------------------------------- */

const checks = [];
const metrics = [];
let phase = 'boot';
const startedAt = new Date().toISOString();

function setPhase(name) {
  phase = name;
  console.log(`\n== ${name} ==`);
}

function check(name, ok, detail = '') {
  const item = { phase, name, ok: !!ok, detail: ok ? '' : String(detail ?? '').slice(0, 400) };
  checks.push(item);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !item.detail ? '' : ` — ${item.detail}`}`);
  return !!ok;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------- HTTP ------------------------------- */

let BASE = OPTS.base || null;

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  if (!res.ok) {
    const err = new Error(`${method} ${p} → ${res.status}${data?.error?.message ? ` (${data.error.message})` : ''}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** 消费 SSE 直到服务端结束；返回按帧解析后的事件数组。 */
async function sse(p, body) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, OPTS.timeoutMs);
  const events = [];
  try {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST ${p} → ${res.status}: ${text.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try { events.push(JSON.parse(raw)); } catch { /* 半帧/非 JSON 帧忽略 */ }
        }
      }
    }
  } catch (err) {
    if (timedOut) throw new Error(`SSE 超时（${OPTS.timeoutMs}ms）：${p}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

/* ----------------------------- 事件摘要 ----------------------------- */

function lastOf(events, type) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i];
  return null;
}

function digest(events) {
  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  return {
    counts,
    errors: events.filter((e) => e.type === 'error').map((e) => e.message || 'unknown'),
    context: lastOf(events, 'context'),
    narrative: lastOf(events, 'narrative_done'),
    memory: lastOf(events, 'memory'),
    state: lastOf(events, 'state'),
    scene: lastOf(events, 'scene'),
    worldTick: lastOf(events, 'world_tick'),
    continuity: lastOf(events, 'continuity'),
    branches: lastOf(events, 'branches'),
    done: lastOf(events, 'done'),
    fork: events.find((e) => e.type === 'fork') || null,
    draftStart: events.find((e) => e.type === 'draft_start') || null,
    draftDone: events.find((e) => e.type === 'draft_done') || null,
    fallback: events.find((e) => e.type === 'narration_fallback') || null,
    toolCalls: events.filter((e) => e.type === 'tool_call').map((e) => e.name || e.tool || '?'),
    firstReasoning: events.find((e) => e.type === 'reasoning') || null,
  };
}

/* ------------------------- 跨轮不变量的记录 ------------------------- */

const frozen = {
  systemTokens: null,
  systemHash: null,
  softMax: null,
  hardMax: null,
  model: null,
};

function assertContext(d, label) {
  const ctx = d.context;
  if (!check(`${label}: 有 context 事件`, !!ctx)) return;
  const meta = ctx.meta || {};
  const budget = ctx.budget || {};
  const cov = meta.coverage || {};

  check(`${label}: system 层非空`, num(budget.system) > 0, JSON.stringify(budget));
  if (frozen.softMax === null) frozen.softMax = meta.soft_max ?? null;
  if (frozen.hardMax === null) frozen.hardMax = meta.hard_max ?? null;
  if (meta.soft_max) check(`${label}: 总预算 ≤ 软目标`, num(budget.total) <= meta.soft_max, `total=${budget.total} soft=${meta.soft_max}`);
  if (meta.hard_max) check(`${label}: 总预算 ≤ 硬上限`, num(budget.total) <= meta.hard_max, `total=${budget.total} hard=${meta.hard_max}`);
  if (cov.recent_from) {
    check(`${label}: 场次与原文无洞（scene_to+1 === recent_from）`, num(cov.scene_to) + 1 === num(cov.recent_from), JSON.stringify(cov));
  }
  if (frozen.systemTokens === null) frozen.systemTokens = num(budget.system);
  check(`${label}: system 层 token 跨轮恒定`, num(budget.system) === frozen.systemTokens, `now=${budget.system} first=${frozen.systemTokens}`);
  const hash = meta.cache?.system_hash || null;
  if (hash) {
    if (frozen.systemHash === null) frozen.systemHash = hash;
    check(`${label}: system_hash 跨轮恒定（缓存前缀不破）`, hash === frozen.systemHash, `${hash} vs ${frozen.systemHash}`);
  }
  const narrowed = meta.hard_cap?.narrowed || [];
  check(`${label}: 无硬上限降级`, narrowed.length === 0, JSON.stringify(meta.hard_cap));
  check(`${label}: 无层降级`, !Array.isArray(meta.degraded) || meta.degraded.length === 0, JSON.stringify(meta.degraded));
  if (meta.model) {
    if (frozen.model === null) frozen.model = meta.model;
    check(`${label}: narrator 模型已解析且恒定`, meta.model === frozen.model, `${meta.model} vs ${frozen.model}`);
  }
}

function assertTurn(d, expectTurnNo, label) {
  check(`${label}: 无 error 事件`, d.errors.length === 0, d.errors.join(' | '));
  const narrative = d.narrative;
  if (!check(`${label}: 有 narrative_done`, !!narrative)) return '';
  const text = String(narrative.content || '');
  check(`${label}: 正文 ≥ 200 字`, text.length >= 200, `${text.length} 字`);
  if (expectTurnNo != null) check(`${label}: 回合号 = ${expectTurnNo}`, num(narrative.turn_no) === expectTurnNo, `got ${narrative.turn_no}`);
  check(`${label}: 有 done 事件`, !!d.done);
  check(`${label}: 有史官 memory 事件`, !!d.memory);
  check(`${label}: 有 state + player_view`, !!d.state && !!d.state.player_view);
  if (d.memory) {
    const applied = d.memory.stats || {};
    const wrote = ['assertions', 'states', 'changes', 'relations', 'threads', 'voices']
      .some((k) => num(applied[k]) > 0);
    check(`${label}: 史官至少写入一类记忆`, wrote, JSON.stringify({
      assertions: applied.assertions, states: applied.states, changes: applied.changes,
      relations: applied.relations, threads: applied.threads, voices: applied.voices,
    }));
  }
  assertContext(d, label);
  return text;
}

/* ------------------------------ 临时服务 ----------------------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'narra-e2e-'));
  const logPath = path.join(dir, 'server.log');
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'roleplay.db') };
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const sink = (chunk) => { const s = String(chunk); log += s; logStream.write(s); if (log.length > 200_000) log = log.slice(-120_000); };
  proc.stdout.on('data', sink);
  proc.stderr.on('data', sink);
  let exited = null;
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`临时服务启动即退出：${JSON.stringify(exited)}\n${log.slice(-2000)}`);
    try {
      const res = await fetch(`${base}/api/config`);
      if (res.ok) {
        return {
          base, proc, dir, port,
          getLog: () => log,
          waitExit: () => new Promise((resolve) => {
            if (exited) return resolve(exited);
            proc.once('exit', (code, signal) => resolve({ code, signal }));
          }),
        };
      }
    } catch { /* 还没监听 */ }
    await sleep(300);
  }
  throw new Error(`临时服务 30s 未就绪\n${log.slice(-2000)}`);
}

async function stopServer(server) {
  if (!server) return;
  if (server.proc.exitCode === null) {
    server.proc.kill();
    await Promise.race([server.waitExit(), sleep(5000)]);
  }
  if (!OPTS.keep) {
    try { rmSync(server.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 文件仍被占用时保留 */ }
  } else {
    console.log(`\n临时目录保留：${server.dir}`);
  }
}

/* ------------------------------ 运行阶段 ----------------------------- */

let server = null;
let worldId = null;
let sessionId = null;
let lastTurnNo = 0;
const turnReports = [];

async function phaseSetup() {
  setPhase('setup');
  if (!server) {
    if (!OPTS.base) {
      server = await startServer();
      BASE = server.base;
      console.log(`临时服务：${BASE}（DB: ${path.join(server.dir, 'roleplay.db')}）`);
    } else {
      BASE = OPTS.base;
    }
  }

  // 世界卡：临时实例从 presets 导入；外部实例用 --world 或唯一世界。
  if (!OPTS.base) {
    const imported = await api('POST', `/api/presets/${encodeURIComponent(OPTS.preset)}/import`);
    worldId = imported.id || imported.world?.id || OPTS.preset;
    check('导入预设成功', !!worldId, JSON.stringify(imported).slice(0, 300));
  } else if (OPTS.world) {
    worldId = OPTS.world;
  } else {
    const list = await api('GET', '/api/worlds');
    const worlds = list.worlds || [];
    if (worlds.length !== 1) throw new Error(`外部实例有 ${worlds.length} 张卡，请用 --world 指定`);
    worldId = worlds[0].id;
  }

  const world = await api('GET', `/api/worlds/${encodeURIComponent(worldId)}`);
  const card = world.card || {};
  const entities = world.entities || card.entities || [];
  check('世界卡版本 = 5', card.version === 5, `version=${card.version}`);
  check('世界卡实体数 > 0', entities.length > 0, `entities=${entities.length}`);
  check('世界卡人物数 > 0', entities.filter((e) => e.type === 'person').length > 0);
  check('世界卡不再有 cast/codex 字段', !('cast' in card) && !('codex' in card));

  const session = await api('POST', `/api/worlds/${encodeURIComponent(worldId)}/sessions`, {
    settings: { narration_mode: 'single' },
  });
  sessionId = session.id;
  check('会话创建成功', !!sessionId, JSON.stringify(session).slice(0, 300));
  console.log(`world=${worldId} session=${sessionId}`);
}

async function phaseOpening() {
  setPhase('turn 1 (opening)');
  const t0 = Date.now();
  const events = await sse(`/api/sessions/${encodeURIComponent(sessionId)}/opening`, { generateBranches: true });
  const d = digest(events);
  const wallMs = Date.now() - t0;
  const text = assertTurn(d, 1, 'opening');
  lastTurnNo = num(d.narrative?.turn_no) || 1;
  check('opening: 产出开场正文', text.length >= 200);
  turnReports.push({
    turn_no: lastTurnNo, label: 'opening', wall_ms: wallMs, chars: text.length,
    context_tokens: num(d.context?.budget?.total), counts: d.counts,
    memory: d.memory?.stats || null,
  });
}

async function phaseTurns() {
  for (let i = 1; i <= OPTS.turns; i++) {
    setPhase(`turn ${lastTurnNo + 1}（第 ${i}/${OPTS.turns} 轮玩家行动）`);
    const action = ACTIONS[(i - 1) % ACTIONS.length];
    const t0 = Date.now();
    const events = await sse(`/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
      playerText: action,
      generateBranches: i === OPTS.turns,
    });
    const d = digest(events);
    const wallMs = Date.now() - t0;
    const expected = lastTurnNo + 1;
    const text = assertTurn(d, expected, `turn${expected}`);
    lastTurnNo = num(d.narrative?.turn_no) || expected;
    turnReports.push({
      turn_no: expected, label: action, wall_ms: wallMs, chars: text.length,
      context_tokens: num(d.context?.budget?.total), counts: d.counts,
      memory: d.memory?.stats || null,
    });
    // 回合成对：GET /turns 里应能看到这一轮的 player + narrator
    const turns = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/turns`);
    const rows = turns.turns || [];
    const mine = rows.filter((r) => num(r.turn_no) === expected);
    check(`turn${expected}: 回合成对落库（player+narrator）`,
      mine.some((r) => r.kind === 'player') && mine.some((r) => r.kind === 'narrator'),
      `rows=${rows.length} kinds=${mine.map((r) => r.kind).join(',')}`);
    if (d.branches && !d.branches.error) {
      const options = d.branches.branches || [];
      check(`turn${expected}: 走向选项 2–4 条`, options.length >= 2 && options.length <= 4, `options=${options.length}`);
    }
  }
}

async function phaseData() {
  setPhase('data（记忆与投影）');
  // getMemoryStats 给的是汇总（场景/线索/世界统计），断言/状态/原声走各自的读接口。
  const mem = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/memory`);
  check('记忆：会话回合数 > 0', num(mem.turn_count) > 0, `turn_count=${mem.turn_count}`);
  check('记忆：世界实体统计存在', num(mem.world?.entity_count) > 0, JSON.stringify(mem.world || null).slice(0, 200));
  check('记忆：人物数与事实数之和 = 实体数',
    num(mem.world?.person_count) + num(mem.world?.fact_count) === num(mem.world?.entity_count),
    JSON.stringify(mem.world || null).slice(0, 200));

  const assertions = (await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/assertions`)).assertions || [];
  const states = (await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/states`)).states || [];
  const voices = (await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/voices`)).voices || [];
  check('记忆：断言总数 > 0', assertions.length > 0, `assertions=${assertions.length}`);
  check('记忆：人物状态 > 0', states.length > 0, `states=${states.length}`);
  check('记忆：原声 > 0', voices.length > 0, `voices=${voices.length}`);

  const snapshot = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
  const view = snapshot.player_view || snapshot.playerView || {};
  check('player_view：在场 ≥ 1 人', Array.isArray(view.present) && view.present.length >= 1,
    JSON.stringify(view.present || null).slice(0, 200));

  const scenes = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/scenes`);
  const sceneRows = scenes.scenes || [];
  check('场次记录：存在且区间合法', sceneRows.length >= 1
    && sceneRows.every((s) => num(s.turn_to) >= num(s.turn_from)), `scenes=${sceneRows.length}`);
  if (sceneRows.length) {
    const sorted = [...sceneRows].sort((a, b) => num(a.turn_from) - num(b.turn_from));
    let contiguous = true;
    for (let i = 1; i < sorted.length; i++) {
      if (num(sorted[i].turn_from) !== num(sorted[i - 1].turn_to) + 1) contiguous = false;
    }
    check('场次记录：首尾相接无洞', contiguous, sorted.map((s) => `${s.turn_from}-${s.turn_to}`).join(','));
    check('场次记录：没有覆盖到未来回合', num(sorted[sorted.length - 1].turn_to) <= lastTurnNo,
      `last=${sorted[sorted.length - 1].turn_to} now=${lastTurnNo}`);
  }

  const ws = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/world-state`);
  const changes = ws.changes || [];
  // 运行态投影的落点：每条 world_state 的 (kind, path) 必须命中 state-paths 白名单，
  // 否则 applyDelta 会静默丢掉一条运行态（v5 就靠这里暴露「实体族没接线」）。
  // introduce 行没有 path，不参与。
  const pathRows = changes.filter((c) => c.path && c.op !== 'introduce');
  const badPaths = pathRows.filter((c) => {
    const allowed = pathsFor(c.entity_kind);
    return !allowed || !allowed.has(c.path);
  });
  const playerRows = changes.filter((c) => c.entity_kind === 'player');
  check('运行态投影：world_state 已写入', changes.length > 0, `changes=${changes.length}`);
  check('运行态投影：路径都在实体白名单内', badPaths.length === 0,
    badPaths.slice(0, 5).map((c) => `${c.entity_kind}:${c.path}`).join(',') || 'ok');
  check('运行态投影：玩家运行态有写入', playerRows.length > 0,
    `player_rows=${playerRows.length} paths=${[...new Set(playerRows.map((c) => c.path))].join(',')}`);
}

async function phaseRecall() {
  setPhase('recall（历史检索）');
  // 查询词从本局正文/人物名里取，保证换一张卡也能命中（不写死某张卡的人名）。
  const turns = (await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/turns`)).turns || [];
  const corpus = turns.filter((t) => t.kind === 'narrator').map((t) => String(t.content || '')).join('\n');
  const snapshot = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
  const persons = (snapshot.card?.entities || []).filter((e) => e.type === 'person');
  const name2 = persons.map((p) => String(p.name || '')).find((n) => n.length === 2);
  const name3 = persons.map((p) => String(p.name || '')).find((n) => n.length >= 3);
  const query3 = name3 ? name3.slice(0, 3) : (corpus.match(/[\u4e00-\u9fa5]{3,}/) || ['历史检索'])[0].slice(0, 3);
  const query2 = name2 || (persons.map((p) => String(p.name || '')).find((n) => n.length >= 2) || '历史').slice(0, 2);

  const hit3 = await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/recall-history`, { query: query3, limit: 3 });
  check(`3 字查询「${query3}」命中（FTS5 主路）`, (hit3.hits || []).length >= 1, `hits=${(hit3.hits || []).length}`);
  check('检索文本带标题且标注只是片段', String(hit3.text || '').includes('历史检索'), String(hit3.text || '').slice(0, 80));
  check('检索结果带 turn_no/snippet', (hit3.hits || []).every((h) => h.turn_no != null && typeof h.snippet === 'string'));
  check('FTS5 引擎自报', ['fts5', 'like'].includes(hit3.meta?.engine || ''), `engine=${hit3.meta?.engine}`);

  const hit2 = await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/recall-history`, { query: query2, limit: 3 });
  check(`2 字查询「${query2}」走兜底且命中`, (hit2.hits || []).length >= 1, `hits=${(hit2.hits || []).length} engine=${hit2.meta?.engine}`);
  let emptyStatus = 0;
  try { await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/recall-history`, { query: '' }); }
  catch (err) { emptyStatus = err.status; }
  check('空查询返回 400', emptyStatus === 400, `status=${emptyStatus}`);
}

async function phaseBranch() {
  setPhase('branch（回滚开新分支）');
  const before = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/branches`);
  const oldBranch = before.current || 'main';
  const target = Math.max(1, lastTurnNo - 1);
  const rollback = await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/rollback`, { turn_no: target });
  check('回滚返回新分支', !!rollback.branch_id && rollback.branch_id !== oldBranch, JSON.stringify(rollback).slice(0, 200));
  check('回滚点 = 目标回合', num(rollback.fork_turn) === target, `fork_turn=${rollback.fork_turn}`);

  const after = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/branches`);
  check('会话当前分支已切换', after.current === rollback.branch_id, `${after.current} vs ${rollback.branch_id}`);
  const oldRow = (after.branches || []).find((b) => b.branch_id === oldBranch);
  check('旧分支标记 abandoned（历史未删）', !!oldRow && oldRow.status === 'abandoned', JSON.stringify(oldRow || null).slice(0, 200));

  const turns = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/turns`);
  check('新分支继承历史且看不到未来回合',
    (turns.turns || []).every((r) => num(r.turn_no) <= target) && (turns.turns || []).length > 0,
    `branch=${turns.branch} last=${(turns.turns || []).slice(-1)[0]?.turn_no}`);

  setPhase('branch（新分支上继续一轮）');
  const preMax = lastTurnNo;
  const t0 = Date.now();
  const events = await sse(`/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
    playerText: ACTIONS[0], generateBranches: false,
  });
  const d = digest(events);
  // 回合号全局递增：分叉后新回合 = 分叉前的全局最大号 + 1，不回到 fork_turn+1。
  const expected = preMax + 1;
  lastTurnNo = num(d.narrative?.turn_no) || expected;
  const text = assertTurn(d, expected, 'branch-turn');
  check('新分支回合号 = 全局最大 + 1', num(d.narrative?.turn_no) === expected, `got ${d.narrative?.turn_no} expected ${expected}`);
  check('新分支回合落在新分支', d.done?.branch === rollback.branch_id, `done.branch=${d.done?.branch}`);
  check('新分支仍能读到继承上下文（recent > 0）', num(d.context?.budget?.recent) > 0, JSON.stringify(d.context?.budget || null));
  turnReports.push({ turn_no: lastTurnNo, label: 'branch-turn', wall_ms: Date.now() - t0, chars: text.length, context_tokens: num(d.context?.budget?.total), counts: d.counts });
}

async function phaseRewrite() {
  setPhase('rewrite（重写上一轮）');
  const target = lastTurnNo;
  const t0 = Date.now();
  const events = await sse(`/api/sessions/${encodeURIComponent(sessionId)}/rewrite`, {
    turn_no: target,
    guidance: '换一个更克制的处理方式，保留相同事实。',
    generateBranches: false,
  });
  const d = digest(events);
  // 重写 = 从 target-1 开新分支，再按原玩家行动重跑一轮；新回合号 = 全局最大 + 1。
  const expected = target + 1;
  check('重写产生 fork 事件', !!d.fork, JSON.stringify(d.fork || null).slice(0, 200));
  check('重写无 error', d.errors.length === 0, d.errors.join(' | '));
  check('重写产出定稿正文', !!d.narrative && String(d.narrative.content || '').length >= 200);
  check('重写后回合号 = 全局最大 + 1', num(d.narrative?.turn_no) === expected, `got ${d.narrative?.turn_no} expected ${expected}`);
  const branches = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/branches`);
  check('重写后当前分支 = fork 分支', branches.current === d.fork?.branch, `${branches.current} vs ${d.fork?.branch}`);
  lastTurnNo = expected;
  turnReports.push({ turn_no: expected, label: 'rewrite', wall_ms: Date.now() - t0, chars: String(d.narrative?.content || '').length, counts: d.counts });
}

async function phaseSegmented() {
  setPhase('segmented（分段演绎）');
  await api('PATCH', `/api/sessions/${encodeURIComponent(sessionId)}`, { settings: { narration_mode: 'segmented' } });
  const t0 = Date.now();
  const events = await sse(`/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
    playerText: ACTIONS[1], generateBranches: false,
  });
  const d = digest(events);
  const text = assertTurn(d, null, 'segmented');
  const mode = d.done?.narration_mode;
  const fellBack = !!d.fallback;
  check('分段模式：事件链正常（draft_start 或明确 fallback）', !!d.draftStart || fellBack, `draft_start=${!!d.draftStart} fallback=${JSON.stringify(d.fallback || null).slice(0, 160)}`);
  check('分段模式：既非回退则 narration_mode = segmented', fellBack || mode === 'segmented', `mode=${mode}`);
  check('分段模式：工具名都在白名单内', d.toolCalls.every((n) => ALLOWED_TOOLS.has(n)), d.toolCalls.join(','));
  lastTurnNo = num(d.narrative?.turn_no) || lastTurnNo + 1;
  turnReports.push({ turn_no: lastTurnNo, label: 'segmented', wall_ms: Date.now() - t0, chars: text.length, counts: d.counts, tools: d.toolCalls });
  await api('PATCH', `/api/sessions/${encodeURIComponent(sessionId)}`, { settings: { narration_mode: 'single' } });
}

async function phaseCanonize() {
  setPhase('canonize（定稿成新卡）');
  const title = `E2E 定稿 ${new Date().toISOString().slice(0, 19)}`;
  const result = await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/canonize`, { title });
  const newWorld = result.world || {};
  const card = result.card || {};
  check('定稿返回新世界', !!newWorld.id, JSON.stringify(newWorld).slice(0, 200));
  check('定稿卡版本 = 5', card.version === 5, `version=${card.version}`);
  check('定稿卡实体数 > 0', Array.isArray(card.entities) && card.entities.length > 0);
  check('定稿来源指向本会话', result.from?.session_id === sessionId, JSON.stringify(result.from || null));

  const persons = (card.entities || []).filter((e) => e.type === 'person');
  const withRelations = persons.filter((p) => (p.relations || []).length > 0);
  check('定稿：关系账本并回人物 relations', withRelations.length > 0, `persons=${persons.length} withRelations=${withRelations.length}`);

  const stored = await api('GET', `/api/worlds/${encodeURIComponent(newWorld.id)}`);
  check('定稿新卡可读取', !!stored.card && stored.card.version === 5);
  const turns = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/turns`);
  check('定稿不删旧会话回合', (turns.turns || []).length > 0, `rows=${(turns.turns || []).length}`);
}

/* -------------------------------- 主流程 ------------------------------- */

const report = {
  schema: 1, started_at: startedAt, scenario: SCENARIO, preset: OPTS.preset,
  base: null, world_id: null, session_id: null,
  checks, metrics: turnReports, frozen, summary: null, error: null,
};

try {
  await phaseSetup();
  report.base = BASE;
  report.world_id = worldId;
  report.session_id = sessionId;
  if (SCENARIO !== 'setup') {
    await phaseOpening();
    await phaseTurns();
    await phaseData();
    await phaseRecall();
    if (FULL) {
      await phaseBranch();
      await phaseRewrite();
      await phaseSegmented();
    }
    await phaseCanonize();
  }
} catch (err) {
  report.error = `${err.message}${err.stack ? `\n${err.stack.split('\n').slice(0, 6).join('\n')}` : ''}`;
  console.error(`\n运行异常：${err.message}`);
  if (server) console.error(server.getLog().slice(-2000));
  checks.push({ phase, name: '运行未抛异常', ok: false, detail: String(err.message || err).slice(0, 400) });
} finally {
  await stopServer(server);
}

const passed = checks.filter((c) => c.ok).length;
const failed = checks.length - passed;
report.summary = { total: checks.length, passed, failed, ok: failed === 0 && !report.error };
report.finished_at = new Date().toISOString();
report.duration_ms = Date.now() - Date.parse(startedAt);

console.log('\n================ E2E 结果 ================');
for (const t of turnReports) {
  console.log(`turn ${String(t.turn_no).padStart(2)} ${String(t.label).slice(0, 14).padEnd(15)} `
    + `${String(t.chars).padStart(5)} 字  ctx ${String(t.context_tokens ?? '-').padStart(6)} tok  ${Math.round((t.wall_ms || 0) / 1000)}s`);
}
console.log(`断言：${passed} passed, ${failed} failed${report.error ? '（运行异常）' : ''}`);
console.log(`耗时：${Math.round(report.duration_ms / 1000)}s`);

const reportPath = OPTS.report || path.join(os.tmpdir(), `ns-e2e-${Date.now()}.json`);
try {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`报告：${reportPath}`);
} catch (err) {
  console.error(`报告写入失败：${err.message}`);
}

if (failed > 0) {
  console.log('\n失败明细：');
  for (const c of checks.filter((x) => !x.ok)) console.log(`  [${c.phase}] ${c.name} — ${c.detail}`);
}
process.exit(report.summary.ok ? 0 : 1);

/* -------------------------------- 小工具 ------------------------------- */

function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
