#!/usr/bin/env node
/**
 * _work/real-10turn-audit.mjs — 真实上游 12 轮全链路审计
 *
 * 使用临时 SQLite + 独立端口，不污染 data/roleplay.db。
 * 每轮记录 SSE 事件、装配 meta、记忆落库统计；跑完再核对记忆表、
 * 回滚开分支、手工编辑、FTS/LIKE 检索、recall、/v1 兼容层。
 *
 * 用法：node _work/real-10turn-audit.mjs
 * 产物：_work/real-10turn-report.json / real-10turn-progress.json / real-10turn-server.log
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3216;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, 'real-10turn-report.json');
const PROGRESS = path.join(__dirname, 'real-10turn-progress.json');
const SERVER_LOG = path.join(__dirname, 'real-10turn-server.log');

const ACTIONS = [
  '雨还在下。我把蛇皮袋往肩上一甩，隔着雨幕问那个撑伞的女人：「你认得我？」',
  '我说：「我叫伍卿，就住在东街十五路后头的山村里。你认错人了。」',
  '我被她拉上牛车，扭头小声问黎婆：「这女人到底什么来头？」',
  '牛车停在凌府门口，我没敢往里走，只盯着门前的石狮子。',
  '我问她：「七年前那个雨夜，凌璇是不是也在场？」',
  '我在凌府偏房里坐下，盯着她腰间那块无纹玉佩，问她是哪来的。',
  '夜里睡不着，我偷偷溜去西街训练场，想看看这里到底在练什么。',
  '我跟凌玥说，我想回山村看看奶奶，明天就走。',
  '回到竹屋，大黑牛在门口等我。我蹲下去摸了摸它的角。',
  '陆可突然找上门来，说谢沐要见我，让我现在就跟他走。',
  '我决定回帝都，先去司楼打听一下最近的动静。',
  '我在司楼门口撞见姬淮澄，她拦住我问：「你在查什么？」',
];

function hasKey() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return false;
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(/^\s*STEPFUN_API_KEY\s*=\s*(.*)$/m);
  return Boolean(m && m[1].replace(/\s+#.*$/, '').trim());
}

async function req(method, url, body, timeoutMs = 900000) {
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
  for (const block of String(text || '').split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch { /* 坏帧忽略 */ }
  }
  return out;
}

async function waitUp() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server 未启动');
}

const report = {
  startedAt: new Date().toISOString(),
  actions: ACTIONS,
  turns: [],
  checks: {},
  db: null,
  errors: [],
};

function save() {
  fs.writeFileSync(PROGRESS, JSON.stringify(report, null, 2), 'utf8');
}

function shortState(state) {
  if (!state) return null;
  return {
    turn_no: state.turn_no,
    time: state.time,
    place: state.place,
    place_id: state.place_id,
    weather: state.weather,
    tension: state.tension,
    characters: state.characters,
    inventory: state.inventory,
    quests: state.quests,
    threads: state.threads,
    last_hook: state.last_hook,
    theme_tags: state.theme_tags,
  };
}

function pickBranches(ev) {
  const list = ev?.branches || [];
  return list.map((b) => (typeof b === 'string' ? b : (b.text || b.label || b.title || JSON.stringify(b))));
}

async function runOneTurn(sessionId, n, action, extra = {}) {
  const started = Date.now();
  const res = await req('POST', `/api/sessions/${sessionId}/turn`, {
    playerText: action, ...extra,
  });
  const durationMs = Date.now() - started;
  const events = parseSse(res.text);
  const ev = (t) => events.find((e) => e.type === t);
  const context = ev('context');
  const memory = ev('memory');
  const state = ev('state');
  const summaryEnd = events.find((e) => e.type === 'summary' && e.state === 'end');
  const summaryStart = events.find((e) => e.type === 'summary' && e.state === 'start');
  const scene = ev('scene');
  const tick = ev('world_tick');
  const continuity = ev('continuity');
  const branches = ev('branches');
  const narr = ev('narrative_done');
  const done = ev('done');
  const error = ev('error');
  const fallback = ev('narration_fallback');
  const sceneSheet = context?.scene_sheet || '';

  return {
    n,
    action,
    status: res.status,
    durationMs,
    eventTypes: [...new Set(events.map((e) => e.type))],
    narrative: narr?.content || '',
    narrativeChars: (narr?.content || '').length,
    usage: done?.usage || null,
    sessionUsage: done?.session_usage || null,
    context: context ? {
      budget: context.budget,
      present: context.meta?.present,
      codex: context.meta?.codex,
      facts: context.meta?.facts,
      world_state_changes: context.meta?.world_state_changes,
      timeline_past: context.meta?.timeline_past,
      timeline_future_held: context.meta?.timeline_future_held,
      codex_total: context.meta?.codex_total,
      summary: context.meta?.summary,
      retrieval: context.meta?.retrieval,
      degraded: context.meta?.degraded,
    } : null,
    sceneSheetHead: sceneSheet.slice(0, 700),
    memory: memory ? {
      applied: memory.stats?.applied,
      scene_change: memory.stats?.scene_change,
      stale: memory.stats?.stale,
      uncertain: memory.stats?.uncertain,
      context_tokens: memory.stats?.context_tokens,
      error: memory.stats?.error,
      degraded: memory.degraded || false,
    } : null,
    state: shortState(state?.state),
    summary: summaryEnd
      ? { state: 'end', ok: summaryEnd.ok, from: summaryEnd.from, to: summaryEnd.to, reason: summaryEnd.reason, chars: summaryEnd.chars }
      : (summaryStart ? { state: 'start', from: summaryStart.from, to: summaryStart.to } : null),
    scene: scene?.scene ? {
      scene_id: scene.scene.scene_id,
      turn_from: scene.scene.turn_from,
      turn_to: scene.scene.turn_to,
      place: scene.scene.place,
      when_label: scene.scene.when_label,
      outcome: scene.scene.outcome,
    } : null,
    worldTick: tick?.events || null,
    continuity: continuity?.report ? {
      keys: Object.keys(continuity.report),
      issues: Array.isArray(continuity.report.issues) ? continuity.report.issues.length : null,
      healthy: Array.isArray(continuity.report.healthy) ? continuity.report.healthy.length : null,
      applied: continuity.report.applied || null,
      stale: continuity.report.stale || false,
    } : null,
    branches: pickBranches(branches),
    branchesError: branches?.error || null,
    narrationFallback: fallback || null,
    error: error ? { message: error.message, aborted: error.aborted || false } : null,
  };
}

if (!hasKey()) {
  console.error('没有找到 STEPFUN_API_KEY，无法做真实运行。');
  process.exit(2);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narra-audit-'));
const dbPath = path.join(tmpDir, 'audit.db');
const logStream = fs.createWriteStream(SERVER_LOG, { flags: 'w' });

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: dbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => logStream.write(d));
child.stderr.on('data', (d) => logStream.write(d));

let worldId = null;
let sessionId = null;

try {
  await waitUp();
  console.log('· 导入预设…');
  const imp = await req('POST', '/api/presets/nvzun-jianpolan/import');
  if (imp.status !== 201) throw new Error(`导入失败 ${imp.status}: ${imp.text}`);
  worldId = imp.json.id;
  console.log(`· 世界卡：${imp.json.title}（卡司 ${imp.json.card?.cast?.length}，辞书 ${imp.json.card?.codex?.length}）`);

  const session = await req('POST', '/api/sessions', {
    world_id: worldId,
    title: '真实 12 轮审计',
    settings: { narration_mode: 'single' },
  });
  if (session.status !== 201) throw new Error(`建局失败 ${session.status}: ${session.text}`);
  sessionId = session.json.id;
  report.sessionId = sessionId;
  report.worldId = worldId;
  save();

  // 起始账本（锚点 turn 0）
  report.initial = { settings: session.json.settings, anchor: session.json.anchor_id, branch: session.json.branch_id };

  for (let i = 0; i < ACTIONS.length; i++) {
    const n = i + 1;
    console.log(`\n--- 第 ${n} 轮 ---\n${ACTIONS[i]}`);
    let rec;
    try {
      rec = await runOneTurn(sessionId, n, ACTIONS[i]);
    } catch (err) {
      rec = { n, action: ACTIONS[i], fatal: err?.message || String(err) };
      report.errors.push({ n, error: rec.fatal });
    }
    report.turns.push(rec);
    save();
    if (rec.fatal) {
      console.log(`失败：${rec.fatal}`);
    } else {
      const b = rec.context?.budget || {};
      console.log(
        `状态 ${rec.status}｜${(rec.durationMs / 1000).toFixed(1)}s｜正文 ${rec.narrativeChars} 字｜`
        + `ctx=${b.total ?? '?'}tok｜present=${(rec.context?.present || []).join('/')}｜`
        + `codex=${(rec.context?.codex || []).length}｜future_held=${rec.context?.timeline_future_held ?? '?'}`,
      );
      if (rec.memory) console.log(`记忆：${JSON.stringify(rec.memory)}`);
      if (rec.summary) console.log(`摘要：${JSON.stringify(rec.summary)}`);
      if (rec.scene) console.log(`切场：${JSON.stringify(rec.scene)}`);
      if (rec.worldTick) console.log(`世界呼吸：${rec.worldTick.length} 条`);
      if (rec.continuity) console.log(`校勘：${JSON.stringify(rec.continuity)}`);
      if (rec.branches?.length) console.log(`走向：${rec.branches.length} 条｜${rec.branches[0]?.slice(0, 40)}`);
      if (rec.error) console.log(`SSE 错误：${rec.error.message}`);
    }
  }

  /* ------------------------------ 跑后核对 ------------------------------ */
  console.log('\n=== 跑后核对 ===');
  const get = async (url) => {
    const r = await req('GET', url, undefined, 60000);
    if (r.status !== 200) throw new Error(`GET ${url} -> ${r.status}: ${r.text.slice(0, 200)}`);
    return r.json;
  };

  const detail = await get(`/api/sessions/${sessionId}`);
  const turns = detail.turns || [];
  const playerTurns = turns.filter((t) => t.kind === 'player');
  const narratorTurns = turns.filter((t) => t.kind === 'narrator');
  const memoryStats = await get(`/api/sessions/${sessionId}/memory`);
  const assertions = (await get(`/api/sessions/${sessionId}/assertions?all=1`)).assertions || [];
  const assertionsLive = (await get(`/api/sessions/${sessionId}/assertions`)).assertions || [];
  const states = (await get(`/api/sessions/${sessionId}/states`)).states || [];
  const scenes = (await get(`/api/sessions/${sessionId}/scenes`)).scenes || [];
  const threads = (await get(`/api/sessions/${sessionId}/threads`)).threads || [];
  const worldState = await get(`/api/sessions/${sessionId}/world-state`);
  const voices = (await get(`/api/sessions/${sessionId}/voices`)).voices || [];
  const patches = (await get(`/api/sessions/${sessionId}/patches`)).patches || [];
  const branchesBefore = await get(`/api/sessions/${sessionId}/branches`);

  const toolLeak = turns.some((t) => /【辞书检索|已追加|已替换|已定稿|draft_append/.test(t.content || ''));
  const narrationMeta = narratorTurns.map((t) => t.meta?.assembly?.narration).filter(Boolean);
  const totals = narratorTurns.map((t) => t.meta?.assembly?.budget?.total || 0).filter(Boolean);

  report.checks.afterRun = {
    turnRows: turns.length,
    playerTurns: playerTurns.length,
    narratorTurns: narratorTurns.length,
    emptyNarratives: narratorTurns.filter((t) => !String(t.content || '').trim()).length,
    toolLeak,
    sessionTurnCount: detail.turn_count,
    sessionUsage: detail.usage,
    assemblyOnEveryNarrator: narratorsHaveAssembly(narratorTurns),
    contextTotals: totals,
    contextTotalMin: Math.min(...totals),
    contextTotalMax: Math.max(...totals),
    memoryStats,
    assertions: {
      total: assertions.length,
      live: assertionsLive.length,
      invalidated: assertions.filter((a) => a.status === 'invalidated').length,
      predicates: unique(assertions.map((a) => a.predicate)),
      sample: assertions.slice(0, 8).map((a) => `${a.subject} ${a.predicate} ${a.object} [${a.status}]`),
    },
    states: {
      total: states.length,
      fields: unique(states.map((s) => s.field)),
      sample: states.slice(0, 8).map((s) => `${s.who}.${s.field}=${String(s.value).slice(0, 30)}`),
    },
    scenes: {
      total: scenes.length,
      items: scenes.map((s) => ({ id: s.scene_id, from: s.turn_from, to: s.turn_to, place: s.place, outcome: String(s.outcome || '').slice(0, 60) })),
    },
    threads: {
      total: threads.length,
      statuses: countBy(threads, 'status'),
      sample: threads.slice(0, 6).map((t) => `${t.name || t.id}:${t.status}`),
    },
    worldStateChanges: worldState.changes?.length ?? null,
    voices: { total: voices.length, kinds: countBy(voices, 'kind') },
    patches: { total: patches.length, statuses: countBy(patches, 'status') },
    branches: branchesBefore,
    narrationMeta,
  };

  // 检索
  const search = await get(`/api/sessions/${sessionId}/search?q=${encodeURIComponent('凌玥')}`);
  report.checks.search = { hits: search.hits?.length ?? 0, first: search.hits?.[0] || null };

  // 作者笔记
  const notePost = await req('POST', `/api/sessions/${sessionId}/notes`, {
    content: '审计：凌玥在第三人面前必须收束温柔。', kind: 'audit',
  });
  report.checks.notes = { createStatus: notePost.status, body: notePost.json };

  // 手工改稿（只改正文，不重跑记忆）
  const editTarget = narratorTurns[2];
  if (editTarget) {
    const edited = await req('PATCH', `/api/sessions/${sessionId}/turns/${editTarget.turn_no}`, {
      kind: 'narrator',
      content: `${editTarget.content}\n\n［审计标记］这一拍手工补了一句。`,
    });
    report.checks.edit = {
      status: edited.status,
      edited: edited.json?.turn?.edited,
      length: edited.json?.turn?.content?.length,
    };
  }

  // 校勘接口（手动立即检查，第 10 轮管线已自动跑过一次）
  const audit = await req('POST', `/api/sessions/${sessionId}/audit`, {});
  report.checks.audit = { status: audit.status, keys: audit.json ? Object.keys(audit.json) : null };

  // 回滚 = 开新分支（到第 8 轮）
  const wsKey = (rows) => (rows || []).map((r) => ({
    entity_kind: r.entity_kind, entity_id: r.entity_id, path: r.path, op: r.op,
    value: r.value, valid_from: r.valid_from, valid_to: r.valid_to,
  }));
  const worldAt8Before = await get(`/api/sessions/${sessionId}/world-state?at_turn=8`);
  const rollback = await req('POST', `/api/sessions/${sessionId}/rollback`, { turn_no: 8 });
  const branchesAfter = await get(`/api/sessions/${sessionId}/branches`);
  const turnsAfterFork = (await get(`/api/sessions/${sessionId}`)).turns || [];
  const worldAt8After = await get(`/api/sessions/${sessionId}/world-state?at_turn=8`);
  report.checks.fork = {
    rollbackStatus: rollback.status,
    rollback: rollback.json ? {
      branch_id: rollback.json.branch_id,
      fork_turn: rollback.json.fork_turn,
      from: rollback.json.from || null,
      memoryStats: rollback.json.memoryStats || null,
    } : null,
    branches: branchesAfter,
    visibleTurns: turnsAfterFork.length,
    visibleNarrators: turnsAfterFork.filter((t) => t.kind === 'narrator').length,
    maxVisibleTurn: Math.max(0, ...turnsAfterFork.map((t) => t.turn_no)),
    worldStateAt8Before: worldAt8Before.changes?.length ?? null,
    worldStateAt8After: worldAt8After.changes?.length ?? null,
    sameAtFork: JSON.stringify(wsKey(worldAt8Before.changes)) === JSON.stringify(wsKey(worldAt8After.changes)),
    worldStateAt8Sample: wsKey(worldAt8After.changes).slice(0, 12),
  };

  // 新分支再跑一轮（第 13 轮）
  const turn13 = await runOneTurn(sessionId, 13, '我在新开的时间线里重新推开凌府的门，先去找黎婆。');
  report.checks.forkTurn = {
    status: turn13.status,
    turn_no: turn13.state?.turn_no,
    branchEcho: turn13.branches?.length,
    narrativeChars: turn13.narrativeChars,
    error: turn13.error,
    contextBudget: turn13.context?.budget,
    present: turn13.context?.present,
  };

  // recall（Librarian）与 /v1 兼容层
  const recall = await req('POST', `/api/sessions/${sessionId}/recall`, { question: '凌玥和伍卿之间的债是什么？' });
  report.checks.recall = {
    status: recall.status,
    keys: recall.json ? Object.keys(recall.json) : null,
    text: typeof recall.json?.answer === 'string' ? recall.json.answer.slice(0, 300) : null,
  };

  const v1 = await req('POST', '/v1/chat/completions', {
    model: 'step-5-preview',
    session_id: sessionId,
    stream: false,
    generate_branches: false,
    messages: [{ role: 'user', content: '我问黎婆：当年你是在哪儿捡到我的？' }],
  }, 900000);
  report.checks.v1 = {
    status: v1.status,
    hasContent: Boolean(v1.json?.choices?.[0]?.message?.content),
    contentHead: v1.json?.choices?.[0]?.message?.content?.slice(0, 240) || null,
    reasoning: Boolean(v1.json?.choices?.[0]?.message?.reasoning_content),
    error: v1.json?.error || null,
  };

  save();
} catch (err) {
  report.errors.push({ fatal: err?.message || String(err) });
  save();
  console.error(`\n审计失败：${err?.message || err}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  logStream.end();

  // 服务停掉后直接读临时库，核对全局行数
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = ['turns', 'assertions', 'character_states', 'world_state', 'relations', 'threads',
      'voices', 'patches', 'states', 'summaries', 'scenes', 'branches', 'notes'];
    const counts = {};
    for (const t of tables) {
      try { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch (e) { counts[t] = `ERR:${e.message}`; }
    }
    const byKind = db.prepare(`SELECT kind, COUNT(*) AS c FROM turns GROUP BY kind`).all();
    const byStatus = db.prepare(`SELECT status, COUNT(*) AS c FROM assertions GROUP BY status`).all();
    const patchStatus = db.prepare(`SELECT status, COUNT(*) AS c FROM patches GROUP BY status`).all();
    const summaries = db.prepare(`SELECT covers_turn_to, token_count, substr(text,1,80) AS head FROM summaries ORDER BY covers_turn_to`).all();
    const branches = db.prepare(`SELECT branch_id, parent_branch, fork_turn, status, note FROM branches`).all();
    const worldState = db.prepare(`SELECT entity_kind, entity_id, path, op, valid_from, valid_to FROM world_state ORDER BY id`).all();
    const sceneRows = db.prepare(`SELECT scene_id, turn_from, turn_to, place, when_label, outcome FROM scenes ORDER BY turn_from`).all();
    const assertionRows = db.prepare(`SELECT subject, predicate, object, status, asserted_turn, superseded_by FROM assertions ORDER BY id`).all();
    const characterStates = db.prepare(`SELECT who, field, value, valid_from, valid_to FROM character_states ORDER BY id`).all();
    const relationRows = db.prepare(`SELECT * FROM relations`).all();
    const threadRows = db.prepare(`SELECT * FROM threads`).all();
    const voiceRows = db.prepare(`SELECT id, who, substr(text,1,40) AS text, turn_no, kind FROM voices ORDER BY id`).all();
    report.db = {
      path: dbPath,
      counts, byKind, byStatus, patchStatus, summaries, branches,
      worldState, sceneRows, assertionRows, characterStates, relationRows, threadRows, voiceRows,
    };
    db.close();
  } catch (err) {
    report.errors.push({ dbRead: err?.message || String(err) });
  }

  save();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告：${OUT}`);
  console.log(`服务日志：${SERVER_LOG}`);
  printSummary(report);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ------------------------------ helpers ------------------------------ */

function unique(arr) { return [...new Set(arr.filter(Boolean))]; }
function countBy(rows, key) {
  const out = {};
  for (const r of rows) out[r[key]] = (out[r[key]] || 0) + 1;
  return out;
}
function narratorsHaveAssembly(narrators) {
  if (!narrators.length) return false;
  return narrators.every((t) => t.meta?.assembly && typeof t.meta.assembly.budget?.total === 'number');
}

function printSummary(r) {
  const c = r.checks || {};
  console.log('\n====== 审计摘要 ======');
  const ok = (v) => (v ? '✓' : '✗');
  console.log(`轮数：player=${c.afterRun?.playerTurns} narrator=${c.afterRun?.narratorTurns} 空正文=${c.afterRun?.emptyNarratives}`);
  console.log(`装配 meta：${ok(c.afterRun?.assemblyOnEveryNarrator)}｜上下文 token 范围 ${c.afterRun?.contextTotalMin}–${c.afterRun?.contextTotalMax}`);
  console.log(`工具文本漏进正文：${ok(!c.afterRun?.toolLeak)}`);
  console.log(`断言 ${c.afterRun?.assertions?.total}（有效 ${c.afterRun?.assertions?.live}，失效 ${c.afterRun?.assertions?.invalidated}）`);
  console.log(`人物状态 ${c.afterRun?.states?.total}｜场次 ${c.afterRun?.scenes?.total}｜线索 ${c.afterRun?.threads?.total}｜原声 ${c.afterRun?.voices?.total}`);
  console.log(`world_state 变化 ${c.afterRun?.worldStateChanges}｜patches ${c.afterRun?.patches?.total}`);
  console.log(`摘要事件：${JSON.stringify((r.turns || []).map((t) => t.summary).filter(Boolean))}`);
  console.log(`分支：before=${c.afterRun?.branches?.branches?.length} after=${c.fork?.branches?.branches?.length}`);
  console.log(`回滚到第 8 轮：${ok(c.fork?.rollbackStatus === 200)}｜分叉点状态一致：${ok(c.fork?.sameAtFork)}｜可见回合 ${c.fork?.visibleTurns}（最大 ${c.fork?.maxVisibleTurn}）`);
  console.log(`新分支第 13 轮：${ok(c.forkTurn?.status === 200 && c.forkTurn?.narrativeChars > 0)}｜正文 ${c.forkTurn?.narrativeChars} 字`);
  console.log(`检索命中：${c.search?.hits}｜改稿：${ok(c.edit?.edited)}｜笔记：${ok(c.notes?.createStatus === 201)}`);
  console.log(`recall：${ok(c.recall?.status === 200)}｜/v1：${ok(c.v1?.status === 200 && c.v1?.hasContent)}`);
  console.log(`DB：${JSON.stringify(r.db?.counts || {})}`);
  if (r.errors?.length) console.log(`错误：${JSON.stringify(r.errors)}`);
  console.log('=====================');
  console.log(`摘要事件：${JSON.stringify((r.turns || []).map((t) => t.summary).filter(Boolean))}`);
}
