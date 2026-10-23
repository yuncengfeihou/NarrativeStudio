/**
 * server/agents/orchestrator.js — 回合管线
 *
 * 一轮 = 玩家行动 → 装配上下文（世界卡引擎）→ 演绎流式输出 → 持久化
 *       → 记忆 Agent 更新 → 分支 Agent 出选项
 *
 * 会话级串行锁：同一 session 同一时刻只允许一个回合在跑。
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { estimateTokens } from '../tokens.js';
import {
  accumulateUsage, addTurn, createSession, getDb, getEntities, getFacts, getMaxTurnNo,
  getNotes, getRecentTurns, getReflections, getRelations, getState, getSummaries,
  getThreads, getWorld, touchSession, touchWorld,
} from '../memory/store.js';

// sessionId -> 串行链
const sessionLocks = new Map();
// 最近一次检索命中（仅供记忆面板展示，进程内存）
const lastRetrievals = new Map();
// 最近一次装配的诊断信息
const lastAssembly = new Map();

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
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} [opts.playerText]
 * @param {Array}  [opts.images]
 * @param {object} [opts.branchChoice]
 * @param {boolean}[opts.generateBranches]
 * @param {boolean}[opts.isOpening]
 * @param {object} [opts.options]
 * @param {function}[opts.onEvent]
 * @param {AbortSignal}[opts.signal]
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

  const { assembleContext } = await import('../memory/context-engine.js');
  const { runNarrator } = await import('./narrator.js');
  const { updateMemory } = await import('./memory-agent.js');
  const { runBranchAgent } = await import('./branch.js');

  const prevMax = getMaxTurnNo(sessionId);
  const turnNo = prevMax + 1;
  emit({ type: 'turn_start', turn_no: turnNo, is_opening: isOpening });

  // 1) 持久化玩家行动
  if (!isOpening) {
    addTurn(sessionId, {
      turn_no: turnNo,
      kind: 'player',
      content: playerText || '',
      images,
      branch_choice: branchChoice,
      meta: { source: branchChoice ? 'branch' : 'free' },
    });
  }

  // 2) 装配上下文
  let context;
  try {
    context = await assembleContext({
      session, world, turnNo, playerText, images, branchChoice, isOpening,
    });
  } catch (err) {
    emit({ type: 'error', message: `上下文装配失败: ${err.message}`, turn_no: turnNo });
    throw err;
  }

  if (context.retrievalSnippets?.length) {
    lastRetrievals.set(sessionId, context.retrievalSnippets.slice(0, 8).map((h) => ({
      kind: h.kind, turn_no: h.turn_no, turn_from: h.turn_from, turn_to: h.turn_to,
      name: h.name, score: h.score, snippet: (h.snippet || '').slice(0, 220),
    })));
  } else {
    lastRetrievals.delete(sessionId);
  }
  lastAssembly.set(sessionId, context.meta || null);

  // 装配诊断发给前端
  emit({
    type: 'context',
    turn_no: turnNo,
    budget: context.budget,
    meta: context.meta,
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

  // 上游偶发只产出 reasoning、content 为空（推理吃满 token 预算）→ 关闭推理重试一次
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
    meta: {
      model: narrator.model,
      finish_reason: narrator.finishReason,
      prompt_tokens: narratorUsage?.prompt_tokens,
      completion_tokens: narratorUsage?.completion_tokens,
    },
  });
  emit({
    type: 'narrative_done',
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

  // 4) 记忆更新（失败不阻断回合）
  let memoryStats = null;
  try {
    const mem = await updateMemory({
      session, turnNo,
      playerText: playerText || '(开场)',
      narrative, branchChoice,
      options: options.memory || {},
      signal,
    });
    memoryStats = mem;
    const ctxStats = getMemoryStats(sessionId);
    emit({
      type: 'memory',
      stats: {
        ...mem,
        context_tokens: ctxStats.context_tokens,
        context_max: ctxStats.context_max,
        turn_count: ctxStats.turn_count,
        entities: ctxStats.entities.length,
        facts: ctxStats.facts.length,
        notes: ctxStats.notes.length,
        relations: ctxStats.relations.length,
        threads: ctxStats.threads.length,
        reflections: ctxStats.reflections.length,
        compression: ctxStats.compression,
        tiers: ctxStats.tiers,
      },
    });
    const st = getState(sessionId);
    if (st) emit({ type: 'state', state: st.state, turn_no: st.turn_no });
  } catch (err) {
    emit({ type: 'memory', stats: { error: err.message }, degraded: true });
  }

  // 5) 分支
  let branches = null;
  if (generateBranches && !signal?.aborted) {
    try {
      const st = getState(sessionId);
      branches = await runBranchAgent({
        world,
        state: st?.state || null,
        recentNarrative: narrative,
        present: context.meta?.cast_present || [],
        director: context.meta?.director || null,
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

  const usage = {
    ...(narratorUsage || {}),
    turn_tokens: (narratorUsage?.completion_tokens || 0) + estimateTokens(narrative) * 0,
  };
  emit({
    type: 'done',
    turn_no: turnNo,
    usage: narratorUsage,
    session_usage: sessionUsage,
    memory: memoryStats ? { degraded: !!memoryStats.error } : null,
  });

  return {
    turn_no: turnNo, narrative, reasoning: narrator.reasoning,
    branches, usage: narratorUsage, sessionUsage, memoryStats,
  };
}

function getDbSession(id) {
  const row = getDb().prepare(`SELECT * FROM sessions WHERE id=?`).get(id);
  if (!row) return null;
  return { ...row, settings: JSON.parse(row.settings_json || '{}') };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 快照与统计                                                             */
/* ══════════════════════════════════════════════════════════════════════ */

export function getSessionSnapshot(sessionId) {
  const session = getDbSession(sessionId);
  if (!session) return null;
  const world = session.world_id ? getWorld(session.world_id) : null;
  const turns = getRecentTurns(sessionId, 1000);
  const stateEntry = getState(sessionId);
  const usage = session.usage_json ? JSON.parse(session.usage_json) : null;
  return {
    session,
    world: world ? { id: world.id, title: world.title, subtitle: world.subtitle, cover_hue: world.cover_hue, tags: world.tags } : null,
    turns,
    state: stateEntry?.state || null,
    usage,
    memoryStats: getMemoryStats(sessionId),
  };
}

/**
 * 记忆与上下文统计（驱动记忆面板与导航环）。
 * context_tokens 用真实装配体积的估算，而不是把全部设定加起来。
 */
export function getMemoryStats(sessionId) {
  const session = getDbSession(sessionId);
  if (!session) return null;
  const world = session.world_id ? getWorld(session.world_id) : null;
  const turnCount = session.turn_count || getMaxTurnNo(sessionId);

  const tiers = [1, 2, 3, 4].map((level) => {
    const rows = getSummaries(sessionId, { level, archived: 0 });
    return {
      level,
      count: rows.length,
      tokens: rows.reduce((s, r) => s + r.token_count, 0),
      last: rows.length
        ? {
          turn_from: rows[rows.length - 1].turn_from,
          turn_to: rows[rows.length - 1].turn_to,
          tokens: rows[rows.length - 1].token_count,
        }
        : null,
    };
  });

  const entities = getEntities(sessionId, { limit: 500 });
  const facts = getFacts(sessionId, { limit: 10000 });
  const notes = getNotes(sessionId, { activeOnly: true });
  const relations = getRelations(sessionId, { limit: 200 });
  const threads = getThreads(sessionId, { limit: 200 });
  const reflections = getReflections(sessionId, { limit: 100 });
  const recentTurns = getRecentTurns(sessionId, config.context.recentRawTurns);
  const archiveTokens = getSummaries(sessionId, { archived: 1 }).reduce((s, r) => s + r.token_count, 0);
  const rawTokens = getDb().prepare(
    `SELECT COALESCE(SUM(token_count),0) AS t FROM turns WHERE session_id=?`,
  ).get(sessionId)?.t || 0;

  // 用真实装配配方估算上下文体积（不跑检索，避免额外开销）
  const budgetCfg = config.context.layerBudget;
  const totalSummaryTokens = tiers.reduce((s, t) => s + t.tokens, 0);
  const contextEstimate = budgetCfg.system + budgetCfg.world + budgetCfg.lore
    + budgetCfg.scene + budgetCfg.director + budgetCfg.current
    + Math.min(totalSummaryTokens, budgetCfg.memory)
    + recentTurns.reduce((s, t) => s + t.token_count, 0);

  const lastMeta = lastAssembly.get(sessionId) || null;

  return {
    turn_count: turnCount,
    context_tokens: contextEstimate,
    context_max: session.settings?.context_max_tokens || config.context.maxTokens,
    context_soft: config.context.softTokens,
    last_retrieval: lastRetrievals.get(sessionId) || [],
    last_assembly: lastMeta,
    world: world ? { id: world.id, title: world.title, lore_count: null } : null,
    budget: {
      ...budgetCfg,
      summaries: Math.min(totalSummaryTokens, budgetCfg.memory),
      recent_raw: recentTurns.reduce((s, t) => s + t.token_count, 0),
      entities: entities.length,
      facts: facts.length,
    },
    tiers,
    archive_tokens: archiveTokens,
    raw_tokens: rawTokens,
    notes,
    entities: entities.slice(0, 100).map((e) => ({
      id: e.id, type: e.type, name: e.name, summary: e.summary,
      importance: e.importance, last_turn: e.last_turn, pinned: !!e.pinned,
      mention_count: e.mention_count, attributes: e.attributes,
    })),
    facts: facts.slice(0, 100),
    relations,
    threads,
    reflections,
    state: getState(sessionId)?.state || null,
    state_turn: getState(sessionId)?.turn_no ?? null,
    usage: session.usage_json ? JSON.parse(session.usage_json) : null,
    compression: rawTokens > 0 ? Math.max(1, Math.round(rawTokens / Math.max(1, contextEstimate))) : 1,
  };
}

/** 创建会话（world_id 可选）。 */
export function createSessionWithSettings({ title, settings, worldId = null }) {
  const id = randomUUID();
  return createSession({ id, worldId, title, settings });
}
