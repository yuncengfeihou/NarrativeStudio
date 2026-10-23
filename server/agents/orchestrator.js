/**
 * server/agents/orchestrator.js — 回合管线（v4）
 *
 * 一轮 = 玩家行动 → 装配上下文（索引 + 最近原文 + 场记单）→ 旁白流式输出
 *       → 落库 → 史官记账 →（切场时）场记归档 + 世界呼吸 →（每 N 轮）校勘
 *       → 分支 Agent 出走向
 *
 * 与 v3 的差别：
 *   - 不再有「记忆 Agent 在正文前塞摘要」。史官在正文**之后**跑，玩家不用等。
 *   - 切场是状态事件（地点/时间/在场者变了），不是轮数整除。
 *   - 回滚是「开新分支」，不是删历史。
 *
 * 会话级串行锁：同一 session 同一时刻只允许一个回合在跑。
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { estimateTokens } from '../tokens.js';
import { normalizeCard } from '../world/schema.js';
import {
  accumulateUsage, addTurn, createBranch, createSession, getAnchor, getAnchors, getBranch, getDb,
  getMaxTurnNo, getNotes, getScenes, getSession, getState, getThreads, getTurnsForBranch, getWorld,
  listBranches, setBranchStatus, setSessionAnchor, setSessionBranch, setState, touchSession, touchWorld,
} from '../memory/store.js';

// sessionId -> 串行链
const sessionLocks = new Map();
// 最近一次装配诊断（供记忆面板展示，进程内存）
const lastAssembly = new Map();
// 最近一次校勘结果
const lastContinuity = new Map();

function withSessionLock(sessionId, fn) {
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  sessionLocks.set(sessionId, prev.then(() => gate));
  return prev.then(fn).finally(() => {
    release();
    if (sessionLocks.get(sessionId) === gate) sessionLocks.delete(sessionId);
  });
}

/**
 * 跑一轮。
 */
export async function runTurn(opts) {
  const { sessionId } = opts;
  if (!sessionId) throw new Error('sessionId required');
  return withSessionLock(sessionId, () => runTurnInner(opts));
}

async function runTurnInner({
  sessionId, playerText = '', images = null, branchChoice = null,
  generateBranches = true, isOpening = false, options = {}, onEvent = () => {}, signal = null,
}) {
  const emit = (evt) => { try { onEvent(evt); } catch { /* 监听器错误不影响管线 */ } };

  const session = getDbSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const world = session.world_id ? getWorld(session.world_id) : null;
  const branchId = session.branch_id || 'main';
  const branch = getBranch(sessionId, branchId);

  const { assembleContext } = await import('../memory/context-engine.js');
  const { runNarrator } = await import('./narrator.js');
  const { runArchivist } = await import('./archivist.js');
  const { runBranchAgent } = await import('./branch.js');
  const { closeScene, detectSceneChange, runContinuity, runWorldTick } = await import('./memory-pipeline.js');

  const prevMax = getMaxTurnNo(sessionId);
  const turnNo = prevMax + 1;
  emit({ type: 'turn_start', turn_no: turnNo, is_opening: isOpening, branch: branchId });

  // 1) 持久化玩家行动
  if (!isOpening) {
    addTurn(sessionId, {
      turn_no: turnNo,
      kind: 'player',
      content: playerText || '',
      images,
      branch_choice: branchChoice,
      branch_id: branchId,
      meta: { source: branchChoice ? 'branch' : 'free' },
    });
  }

  // 2) 装配上下文
  let context;
  try {
    context = await assembleContext({
      session, world, turnNo, playerText, images, branchChoice, isOpening,
      directive: options.directive || '',
    });
  } catch (err) {
    emit({ type: 'error', message: `上下文装配失败: ${err.message}`, turn_no: turnNo });
    throw err;
  }
  lastAssembly.set(sessionId, { ...(context.meta || {}), budget: context.budget || null });

  emit({
    type: 'context',
    turn_no: turnNo,
    budget: context.budget,
    meta: context.meta,
    scene_sheet: context.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '',
  });

  // 3) 演绎
  let narrator;
  try {
    narrator = await runNarrator({
      session, world, context, turnNo,
      options: { ...options, guidance: options.narrator?.guidance },
      onDelta: (d) => emit({ type: d.type === 'reasoning' ? 'reasoning' : 'narrative', delta: d.delta }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      emit({ type: 'error', message: '已取消', turn_no: turnNo, aborted: true });
      throw err;
    }
    emit({ type: 'error', message: `剧情演绎失败: ${err.message}`, turn_no: turnNo });
    throw err;
  }

  // 上游偶发只产出 reasoning、content 为空 → 关闭推理重试一次
  if (!String(narrator.content || '').trim() && !signal?.aborted) {
    emit({ type: 'narrative_reset', reason: 'empty_content' });
    console.warn(`[orchestrator] 第 ${turnNo} 轮正文为空，重试一次（关闭推理）`);
    try {
      narrator = await runNarrator({
        session, world, context, turnNo,
        options: {
          ...options,
          reasoningEffort: 'low',
          maxTokens: Math.max(config.agents.narrator.maxTokens, 8000),
          guidance: [
            options.narrator?.guidance,
            '上一轮只输出了思考而没有任何正文。这次请直接输出剧情正文，不要输出思考过程。',
          ].filter(Boolean).join('\n'),
        },
        onDelta: (d) => emit({ type: d.type === 'reasoning' ? 'reasoning' : 'narrative', delta: d.delta }),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      console.warn(`[orchestrator] 第 ${turnNo} 轮重试失败：${err.message}`);
    }
  }

  const narrative = narrator.content || '';
  const narratorUsage = narrator.usage || null;

  addTurn(sessionId, {
    turn_no: turnNo,
    kind: 'narrator',
    content: narrative,
    reasoning: narrator.reasoning || null,
    token_count: estimateTokens(narrative),
    usage: narratorUsage,
    branch_id: branchId,
    meta: {
      model: narrator.model,
      finish_reason: narrator.finishReason,
      prompt_tokens: narratorUsage?.prompt_tokens,
      completion_tokens: narratorUsage?.completion_tokens,
    },
  });
  emit({
    type: 'narrative_done',
    turn_no: turnNo,
    content: narrative,
    token_count: estimateTokens(narrative),
    finish_reason: narrator.finishReason,
    usage: narratorUsage,
  });

  // 累计会话级遥测
  const sessionUsage = accumulateUsage(sessionId, narratorUsage ? {
    ...narratorUsage,
    output_chars: narrative.length + (narrator.reasoning?.length || 0),
  } : null);

  // 4) 史官记账（失败不阻断回合）
  let memoryStats = null;
  let sceneChanged = false;
  try {
    const arch = await runArchivist({
      session, world, turnNo,
      playerText: playerText || '(开场)',
      narrative, branchChoice,
      options: options.archivist || {},
      signal,
    });
    memoryStats = arch;
    emit({ type: 'memory', stats: summarizeMemory(sessionId, arch, context) });
    const st = getState(sessionId);
    if (st) emit({ type: 'state', state: st.state, turn_no: st.turn_no });
    sceneChanged = detectSceneChange(session, arch, turnNo);
  } catch (err) {
    emit({ type: 'memory', stats: { error: err.message }, degraded: true });
  }

  // 5) 切场：场记归档 + 世界呼吸（都不阻断回合）
  let sceneRecord = null;
  if (sceneChanged && !signal?.aborted) {
    try {
      sceneRecord = await closeScene({ session, world, turnNo, reason: memoryStats?.scene_change?.reason || '' });
      if (sceneRecord) emit({ type: 'scene', scene: sceneRecord });
    } catch (err) {
      console.warn(`[orchestrator] 场记归档失败：${err?.message || err}`);
    }
    try {
      const tick = await runWorldTick({ session, world, turnNo, signal });
      if (tick.events?.length) emit({ type: 'world_tick', events: tick.events });
    } catch (err) {
      if (err?.name !== 'AbortError') console.warn(`[orchestrator] 世界呼吸失败：${err?.message || err}`);
    }
  }

  // 6) 定期校勘
  const every = config.context.continuityEvery;
  if (every > 0 && turnNo % every === 0 && !signal?.aborted) {
    try {
      const report = await runContinuity({ session, world, turnNo, signal });
      lastContinuity.set(sessionId, report);
      emit({ type: 'continuity', report });
    } catch (err) {
      if (err?.name !== 'AbortError') console.warn(`[orchestrator] 校勘失败：${err?.message || err}`);
    }
  }

  // 7) 分支走向
  let branches = null;
  if (generateBranches && !signal?.aborted) {
    try {
      const st = getState(sessionId);
      branches = await runBranchAgent({
        world,
        state: st?.state || null,
        recentNarrative: narrative,
        present: context.meta?.present || [],
        sceneSheet: context.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '',
        options: options.branch || {},
        signal,
      });
      emit({ type: 'branches', branches: branches.branches, scene_summary: branches.scene_summary });
    } catch (err) {
      emit({ type: 'branches', branches: [], scene_summary: '', error: err.message, degraded: true });
    }
  }

  touchSession(sessionId, turnNo);
  if (world) touchWorld(world.id);

  emit({
    type: 'done',
    turn_no: turnNo,
    branch: branchId,
    usage: narratorUsage,
    session_usage: sessionUsage,
    memory: memoryStats ? { degraded: false, applied: memoryStats.applied } : { degraded: true },
  });

  return {
    turn_no: turnNo, narrative, reasoning: narrator.reasoning,
    branches, usage: narratorUsage, sessionUsage, memoryStats, scene: sceneRecord,
  };
}

function summarizeMemory(sessionId, arch, context = null) {
  const st = getState(sessionId);
  return {
    ...arch.applied,
    scene_change: arch.scene_change,
    uncertain: arch.uncertain || [],
    state_turn: st?.turn_no ?? null,
    context_tokens: context?.budget?.total ?? null,
    context_soft: context?.meta?.soft_max ?? null,
    context_max: context?.meta?.hard_max ?? null,
  };
}

function getDbSession(id) {
  const row = getDb().prepare(`SELECT * FROM sessions WHERE id=?`).get(id);
  if (!row) return null;
  return {
    ...row,
    settings: JSON.parse(row.settings_json || '{}'),
    branch_id: row.branch_id || 'main',
    anchor_id: row.anchor_id || null,
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 会话创建与分支                                                         */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 创建会话。anchorId 决定从哪个时间点开局；默认世界卡的第一个锚点（通常是序章）。
 * 创建时立刻用锚点的快照初始化账本，否则第一轮没有场景状态可接续。
 */
export function createSessionWithSettings({ title, settings, worldId = null, anchorId = null }) {
  const id = randomUUID();
  const session = createSession({ id, worldId, title, settings });
  let anchor = anchorId;
  if (worldId && !anchor) {
    const anchors = getAnchors(worldId);
    anchor = anchors[0]?.anchor_id || null;
  }
  if (worldId && anchor) setSessionAnchor(id, anchor, 'main');
  createBranch(id, { branchId: 'main', parentBranch: '', forkTurn: 0, note: '开局主线' });

  // 用锚点快照初始化账本（turn_no = 0 表示「开局之前」）
  const snap = worldId && anchor ? getAnchor(worldId, anchor) : null;
  if (snap?.snapshot && Object.keys(snap.snapshot).length) {
    setState(id, 0, { ...snap.snapshot, turn_no: 0 });
  }
  return getSession(id);
}

/**
 * 回滚到第 N 轮：不是删历史，是从这里开一条新分支。
 * 旧分支标 abandoned，共享 canon 到分叉点为止。
 */
export function forkSession({ sessionId, toTurn, note = '' }) {
  const session = getDbSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const oldBranch = session.branch_id || 'main';
  const newBranch = `b${Date.now().toString(36)}`;
  createBranch(sessionId, { branchId: newBranch, parentBranch: oldBranch, forkTurn: toTurn, note });
  setBranchStatus(sessionId, oldBranch, 'abandoned');
  setSessionBranch(sessionId, newBranch);
  return { branch_id: newBranch, fork_turn: toTurn, abandoned: oldBranch };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 快照与统计                                                             */
/* ══════════════════════════════════════════════════════════════════════ */

export function getSessionSnapshot(sessionId) {
  const session = getDbSession(sessionId);
  if (!session) return null;
  const world = session.world_id ? getWorld(session.world_id) : null;
  const branchId = session.branch_id || 'main';
  const branch = getBranch(sessionId, branchId);
  const forkTurn = branch ? branch.fork_turn : Number.MAX_SAFE_INTEGER;
  const turns = getTurnsForBranch(sessionId, branchId, forkTurn, {}).slice(-200);
  const stateEntry = getState(sessionId);
  const usage = session.usage_json ? JSON.parse(session.usage_json) : null;
  return {
    session,
    world: world ? {
      id: world.id, title: world.title, subtitle: world.subtitle, cover_hue: world.cover_hue,
      tags: world.tags, kind: world.card?.kind, anchor: session.anchor_id,
    } : null,
    turns,
    state: stateEntry?.state || null,
    usage,
    memoryStats: getMemoryStats(sessionId),
  };
}

export function getMemoryStats(sessionId) {
  const session = getDbSession(sessionId);
  if (!session) return null;
  const world = session.world_id ? getWorld(session.world_id) : null;
  const branchId = session.branch_id || 'main';
  const turnCount = session.turn_count || getMaxTurnNo(sessionId);

  const scenes = getScenes(sessionId, { branchId, limit: 100 });
  const threads = getThreads(sessionId, { limit: 200 });
  const notes = getNotes(sessionId, { activeOnly: true });
  const branches = listBranches(sessionId);
  const lastMeta = lastAssembly.get(sessionId) || null;
  const lastCont = lastContinuity.get(sessionId) || null;

  const card = normalizeCard(world?.card || {});
  const rawTokens = getDb().prepare(
    `SELECT COALESCE(SUM(token_count),0) AS t FROM turns WHERE session_id=?`,
  ).get(sessionId)?.t || 0;

  return {
    turn_count: turnCount,
    branch: branchId,
    branches: branches.map((b) => ({ branch_id: b.branch_id, fork_turn: b.fork_turn, status: b.status, note: b.note })),
    scenes: scenes.map((s) => ({
      scene_id: s.scene_id, turn_from: s.turn_from, turn_to: s.turn_to,
      when_label: s.when_label, place: s.place, question: s.question, outcome: s.outcome,
    })),
    scene_count: scenes.length,
    threads,
    notes,
    state: getState(sessionId)?.state || null,
    state_turn: getState(sessionId)?.turn_no ?? null,
    world: world ? {
      id: world.id, title: world.title,
      codex_count: card.codex.length,
      cast_count: card.cast.length,
      timeline_past: card.timeline.filter((t) => t.canon === 'past').length,
      timeline_future: card.timeline.filter((t) => t.canon === 'future').length,
      anchors: card.anchors.map((a) => ({ id: a.id, label: a.label })),
    } : null,
    last_assembly: lastMeta,
    context_tokens: lastMeta?.budget?.total ?? null,
    context_soft: lastMeta?.soft_max ?? null,
    context_max: lastMeta?.hard_max ?? null,
    last_continuity: lastCont,
    raw_tokens: rawTokens,
    usage: session.usage_json ? JSON.parse(session.usage_json) : null,
  };
}

/** 按需检索入口（Librarian）。 */
export async function recallSession({ sessionId, question, signal }) {
  const session = getDbSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const { runLibrarian } = await import('./memory-pipeline.js');
  return runLibrarian({ session, question, signal });
}

/** 手动跑一次校勘（UI「立即检查」用）。 */
export async function auditSession({ sessionId, signal }) {
  const session = getDbSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const world = session.world_id ? getWorld(session.world_id) : null;
  const { runContinuity } = await import('./memory-pipeline.js');
  const report = await runContinuity({ session, world, turnNo: getMaxTurnNo(sessionId), signal });
  lastContinuity.set(sessionId, report);
  return report;
}
