/**
 * Orchestrator — the multi-agent turn pipeline.
 *
 * One "turn" = player action → (memory-augmented context) → narrator streams
 * the narrative → turn persisted → memory agent updates → branch agent
 * proposes next options.
 *
 * Session-level serialization: only one turn may run per session at a time.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { estimateTokens, estimateMessagesTokens } from '../tokens.js';
import {
  getSession, createSession, getMaxTurnNo, addTurn, getRecentTurns, getState,
  getEntities, getFacts, getSummaries, touchSession,
} from '../memory/store.js';

// Per-session promise chain enforcing serial turns.
const sessionLocks = new Map();

// 最近一次检索命中（供记忆面板展示；进程内存，重启后清空）
const lastRetrievals = new Map();

function withSessionLock(sessionId, fn) {
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  let release;
  const gate = new Promise(r => { release = r; });
  sessionLocks.set(sessionId, prev.then(() => gate));
  return prev.then(fn).finally(() => {
    release();
    // cleanup when idle
    const cur = sessionLocks.get(sessionId);
    if (cur === gate) sessionLocks.delete(sessionId);
  });
}

/**
 * Run one full turn.
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} [opts.playerText]      player's free-text action (null for opening turn)
 * @param {Array}  [opts.images]          [{url|data, name?}]
 * @param {object} [opts.branchChoice]    {id,title,description,tone}
 * @param {boolean}[opts.generateBranches]
 * @param {boolean}[opts.isOpening]       generate the opening narrative (turn 1)
 * @param {object} [opts.options]         LLM overrides
 * @param {function}[opts.onEvent]        (evt) => void
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
  const emit = (evt) => { try { onEvent(evt); } catch { /* listener errors never break the pipeline */ } };

  const session = getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  const { assembleContext } = await import('../memory/assembler.js');
  const { runNarrator } = await import('./narrator.js');
  const { updateMemory } = await import('./memory-agent.js');
  const { runBranchAgent } = await import('./branch.js');

  const prevMax = getMaxTurnNo(sessionId);
  const turnNo = prevMax + 1;
  emit({ type: 'turn_start', turn_no: turnNo, is_opening: isOpening });

  // 1) Persist the player action (skip for opening turns)
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

  // 2) Assemble memory-augmented context (retrieval sees the just-stored player turn)
  // 首轮（无任何历史回合）时把开场种子并入上下文，让 narrator 从开场场景起笔
  // 再回应玩家行动，保证 UI 展示的开场白与 LLM 演绎无缝衔接。
  const openingSeed = (session.settings?.opening || '').trim();
  const contextPlayerText = (prevMax === 0 && !isOpening && openingSeed)
    ? `【开场种子】\n${openingSeed}\n\n【玩家行动】\n${playerText || ''}`
    : (playerText || '');
  let context;
  try {
    context = await assembleContext({
      session, turnNo,
      playerText: contextPlayerText, images, branchChoice,
    });
  } catch (err) {
    emit({ type: 'error', message: `上下文装配失败: ${err.message}`, turn_no: turnNo });
    throw err;
  }

  // 3) Narrator streams the round
  if (context.retrievalSnippets?.length) {
    lastRetrievals.set(sessionId, context.retrievalSnippets.slice(0, 8).map(h => ({
      kind: h.kind, turn_no: h.turn_no, turn_from: h.turn_from, turn_to: h.turn_to,
      name: h.name, score: h.score, snippet: (h.snippet || '').slice(0, 220),
    })));
  } else {
    lastRetrievals.delete(sessionId);
  }
  let narrator;
  try {
    narrator = await runNarrator({
      session, context, turnNo, isOpening,
      options: { ...options, ...(isOpening ? {} : {}) },
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

  const narrative = narrator.content || '';
  addTurn(sessionId, {
    turn_no: turnNo,
    kind: 'narrator',
    content: narrative,
    reasoning: narrator.reasoning || null,
    token_count: estimateTokens(narrative),
    meta: {
      model: narrator.model,
      finish_reason: narrator.finishReason,
      prompt_tokens: narrator.usage?.prompt_tokens,
      completion_tokens: narrator.usage?.completion_tokens,
    },
  });
  emit({
    type: 'narrative_done',
    content: narrative,
    token_count: estimateTokens(narrative),
    finish_reason: narrator.finishReason,
  });

  // 4) Memory agent updates (never breaks the turn on failure)
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
    // 附带真实上下文估算，驱动前端记忆环
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
      },
    });
    const st = getState(sessionId);
    if (st) emit({ type: 'state', state: st.state, turn_no: st.turn_no });
  } catch (err) {
    emit({ type: 'memory', stats: { error: err.message }, degraded: true });
  }

  // 5) Branch agent proposes options for the next round
  let branches = null;
  if (generateBranches && !signal?.aborted) {
    try {
      branches = await runBranchAgent({
        session, context, recentNarrative: narrative,
        options: options.branch || {},
        signal,
      });
      emit({ type: 'branches', branches: branches.branches, scene_summary: branches.scene_summary });
    } catch (err) {
      emit({ type: 'branches', branches: [], scene_summary: '', error: err.message, degraded: true });
    }
  }

  touchSession(sessionId, turnNo);
  const usage = {
    prompt_tokens: narrator.usage?.prompt_tokens ?? null,
    completion_tokens: narrator.usage?.completion_tokens ?? null,
    total_tokens: narrator.usage?.total_tokens ?? null,
  };
  emit({ type: 'done', turn_no: turnNo, usage, memory: memoryStats ? { degraded: !!memoryStats.error } : null });

  return { turn_no: turnNo, narrative, reasoning: narrator.reasoning, branches, usage, memoryStats };
}

/* --------------------------- snapshots & stats --------------------------- */

/** Full session payload for the frontend (initial load). */
export function getSessionSnapshot(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  const turns = getRecentTurns(sessionId, 1000);
  const stateEntry = getState(sessionId);
  return {
    session,
    turns,
    state: stateEntry?.state || null,
    memoryStats: getMemoryStats(sessionId),
  };
}

/**
 * Memory system statistics + current context estimate (drives the UI ring).
 * Reuses the assembler's budget math so the ring matches the real prompt.
 */
export function getMemoryStats(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  const turnCount = session.turn_count || getMaxTurnNo(sessionId);

  const tiers = [1, 2, 3, 4].map(level => {
    const rows = getSummaries(sessionId, { level, archived: 0 });
    return { level, count: rows.length, tokens: rows.reduce((s, r) => s + r.token_count, 0) };
  });

  const entities = getEntities(sessionId, { limit: 500 });
  const facts = getFacts(sessionId, { limit: 10000 });
  const recentTurns = getRecentTurns(sessionId, config.context.recentRawTurns);
  const archiveTokens = getSummaries(sessionId, { archived: 1 }).reduce((s, r) => s + r.token_count, 0);

  // Cheap context estimate that mirrors assembler priorities (no retrieval call).
  const settingsTokens = estimateTokens(JSON.stringify(session.settings));
  const stateEntry = getState(sessionId);
  const stateTokens = stateEntry ? estimateTokens(JSON.stringify(stateEntry.state)) : 0;
  const recentTokens = recentTurns.reduce((s, t) => s + t.token_count, 0);
  const summaryTokens = tiers.reduce((s, t) => s + t.tokens, 0);
  const contextEstimate = settingsTokens + stateTokens + recentTokens + Math.min(summaryTokens, 60000);

  return {
    turn_count: turnCount,
    context_tokens: contextEstimate,
    context_max: session.settings?.context_max_tokens || config.context.maxTokens,
    last_retrieval: lastRetrievals.get(sessionId) || [],
    budget: {
      settings: settingsTokens,
      state: stateTokens,
      summaries: Math.min(summaryTokens, 60000),
      recent_raw: recentTokens,
      entities: entities.length,
      facts: facts.length,
    },
    tiers,
    entities: entities.slice(0, 60).map(e => ({
      type: e.type, name: e.name, summary: e.summary,
      importance: e.importance, last_turn: e.last_turn,
    })),
    facts: facts.slice(0, 60),
    state: stateEntry?.state || null,
    archive_tokens: archiveTokens,
  };
}

/** Create a session and return it. */
export function createSessionWithSettings({ title, settings }) {
  const id = randomUUID();
  return createSession({ id, title, settings });
}
