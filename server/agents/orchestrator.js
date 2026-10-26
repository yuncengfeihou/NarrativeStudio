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
import { isPerson, normalizeCard } from '../world/schema.js';
import { buildEffectiveWorld } from '../world/effective.js';
import { resolveAgent } from '../model-registry.js';
import { branchSnapshot, guardOf, hashFingerprint, isBranchCurrent, makeEffectId, runEffectOnce } from '../memory/branch-guard.js';
import { buildPlayerView } from '../memory/player-view.js';
import { recallHistory } from '../memory/recall-history.js';
import {
  accumulateUsage, addTurn, copyBranchState, createBranch, createSession,
  getBranch, getDb, getMaxTurnNo, getNotes, getRelations, getScenes, getSession,
  getState, getThreads, getTurnsForBranch, getWorld, getWorldState, listBranches, saveWorld,
  setBranchStatus, setSessionAnchor, setSessionBranch, setState, touchSession, touchWorld,
  upsertRelation,
  upsertThread,
} from '../memory/store.js';
import { runRetrieval, shouldPrecheckRetrieval } from './retrieval.js';

// sessionId -> 串行链
const sessionLocks = new Map();
// 最近一次装配诊断（供记忆面板展示，进程内存）
const lastAssembly = new Map();
// 最近一次真实发给模型的 messages（只用于下一轮计算前缀复用率，不参与装配内容）
const lastMessages = new Map();
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
 * 在会话锁内开新分支。
 * `/rollback`、`/rewrite` 必须走这里：直接在回合进行中 fork 会让旁路 Agent
 * 把结果写进旧分支（历史 bug）。锁保证 fork 等当前回合收尾。
 */
export async function forkSessionSafe(opts) {
  return withSessionLock(opts.sessionId, () => forkSession(opts));
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

  /**
   * 旁路 Agent 的用量也必须进会话账本。
   * 旧实现只累计 narrator 一路，于是「一局花了多少 token / 缓存命中多少」的分母是错的，
   * 所有成本结论都建立在错误数字上。定义在使用点之前，避免 TDZ。
   */
  const trackUsage = (agent, usage) => {
    if (!usage) return;
    try { accumulateUsage(sessionId, usage, agent); } catch { /* 遥测失败不影响管线 */ }
  };

  const session = getDbSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const worldRow = session.world_id ? getWorld(session.world_id) : null;
  // 会话一旦创建就冻结模板：作者之后编辑世界卡，不会追溯改写这一局的公理与开局。
  const world = worldRow
    ? { ...worldRow, card: session.card_snapshot || worldRow.card, version: session.world_version ?? worldRow.version }
    : null;
  const branchId = session.branch_id || 'main';
  const branch = getBranch(sessionId, branchId);

  const { assembleContext } = await import('../memory/context-engine.js');
  const { runNarrator } = await import('./narrator.js');
  const { resolveNarrationMode, runNarratorSegmented } = await import('./narrator-loop.js');
  const { buildDeclaredTargets, runArchivist } = await import('./archivist.js');
  const { runBranchAgent } = await import('./branch.js');
  const { closeScene, detectSceneChange, runContinuity, runWorldTick } = await import('./memory-pipeline.js');

  // 分段演绎是会话级实验开关；默认 single，失败了也能回退到单发。
  const narrationMode = resolveNarrationMode(session.settings, config.narration.mode);

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

  // 2) 设定集检索预检（模型主动取证；不是关键词触发）。
  // auto = 只在大卡上开；会话 settings.codex_retrieval 可强制 on/off。
  let retrieval = null;
  const retrievalMode = session.settings?.codex_retrieval || 'auto';
  const factCount = (world?.card?.entities || []).filter((e) => !isPerson(e)).length;
  // 分段模式自带 codex_lookup，不再额外跑检索预检，避免同一拍查两次。
  const wantRetrieval = narrationMode !== 'segmented' && !isOpening
    && shouldPrecheckRetrieval({
      mode: retrievalMode,
      codexCount: factCount,
      minCodex: config.context.retrievalMinCodex,
      playerText,
      branchChoice,
      card: world?.card || null,
    });
  if (wantRetrieval && !signal?.aborted) {
    try {
      const ledger = getState(sessionId, { branchId, atTurn: Math.max(0, turnNo - 1) })?.state || null;
      retrieval = await runRetrieval({ card: world?.card || null, playerText, ledger, signal });
      trackUsage('retrieval', retrieval?.usage);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      console.warn(`[orchestrator] 检索预检失败：${err?.message || err}`);
    }
  }

  // 2.5) 装配上下文
  let context;
  try {
    context = await assembleContext({
      session, world, turnNo, playerText, images, branchChoice, isOpening,
      directive: options.directive || '',
      retrieval,
      // 上一轮真实发给模型的 messages：用于计算「这一轮可以复用多少前缀」。
      // 只做字符串比较，不影响装配内容本身。
      previousMessages: lastMessages.get(sessionId) || null,
    });
  } catch (err) {
    emit({ type: 'error', message: `上下文装配失败: ${err.message}`, turn_no: turnNo });
    throw err;
  }
  lastAssembly.set(sessionId, { ...(context.meta || {}), budget: context.budget || null });
  // 上下文已经完成投影；下游 Agent 共享同一份 effective world，
  // 否则史官不认识剧情里新登场的人，走向也只看得见开局卡司。
  const effectiveWorld = world ? { ...world, card: context.card || world.card } : null;

  emit({
    type: 'context',
    turn_no: turnNo,
    budget: context.budget,
    meta: context.meta,
    scene_sheet: context.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '',
  });

  // 3) 演绎
  const narratorOptions = { ...options, guidance: options.narrator?.guidance };
  const runSingleNarrator = () => runNarrator({
    session, world: effectiveWorld, context, turnNo,
    options: narratorOptions,
    onDelta: (d) => emit({ type: d.type === 'reasoning' ? 'reasoning' : 'narrative', delta: d.delta }),
    signal,
  });

  // 记下这一轮真正发给模型的 messages，供下一轮计算前缀复用率（缓存归因）。
  // 必须在 narrator 跑之前抓，因为 guidance 会被插进尾部。
  try {
    const { buildNarratorMessages } = await import('./narrator.js');
    lastMessages.set(sessionId, buildNarratorMessages({
      session, world: effectiveWorld, context, guidance: narratorOptions.guidance,
    }));
  } catch { /* 归因失败不影响回合 */ }

  let narrator;
  try {
    if (narrationMode === 'segmented') {
      try {
        narrator = await runNarratorSegmented({
          session, world: effectiveWorld, context, turnNo,
          options: narratorOptions,
          onEvent: emit,
          signal,
          // 模型主动发起的历史检索：只读已发生回合，按当前分支可见性过滤，不写库。
          recall: ({ query, limit }) => recallHistory({
            sessionId, branchId: session.branch_id || 'main', atTurn: turnNo, query, limit,
          }),
        });
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        // 上游不支持 tools、或循环内出错：清掉已上屏的草稿，回退到单发。
        emit({ type: 'narrative_reset', reason: 'segmented_fallback' });
        emit({ type: 'narration_fallback', mode: 'segmented', reason: err?.message || String(err) });
        console.warn(`[orchestrator] 分段演绎失败，回退单发：${err?.message || err}`);
        narrator = await runSingleNarrator();
        narrator.narration = { mode: 'single', fallback: 'segmented', rounds: 1, tools: 0, sealed: true };
      }
    } else {
      narrator = await runSingleNarrator();
    }
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
        session, world: effectiveWorld, context, turnNo,
        options: {
          ...options,
          reasoningEffort: 'low',
          maxTokens: Math.max(resolveAgent('narrator').maxTokens, 8000),
          guidance: [
            options.narrator?.guidance,
            '上一轮只输出了思考而没有任何正文。这次请直接输出剧情正文，不要输出思考过程。',
          ].filter(Boolean).join('\n'),
        },
        onDelta: (d) => emit({ type: d.type === 'reasoning' ? 'reasoning' : 'narrative', delta: d.delta }),
        signal,
      });
      narrator.narration = {
        mode: 'single',
        fallback: narrationMode === 'segmented' ? 'segmented_empty' : 'empty_content',
        rounds: 1, tools: 0, sealed: true,
      };
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
      // 装配清单随回合持久化：刷新后仍能回答「这一轮为什么是这些内容」。
      assembly: buildAssemblyMeta(context, narrator),
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
  } : null, 'narrator');

  // 4) 史官记账（失败不阻断回合）
  let memoryStats = null;
  let sceneChanged = false;
  try {
    // 旁路调用期间用户可能 rollback / rewrite；落库前核对分支与回合没变。
    // 回执保证同一轮的同一次写入不会因重试/重复调用落两遍。
    const archivistSnap = branchSnapshot(sessionId, branchId);
    // 目标声明集合来自装配结果（卡 + 在场/辞书 + 账本人物），不由模型声明：
    // 史官越界提案会被拒写并记 skipped_targets，避免模型给「没出现过的人」记账。
    const targetLedger = getState(sessionId, { branchId, atTurn: turnNo });
    const declaredTargets = buildDeclaredTargets({
      card: effectiveWorld?.card || {},
      present: context.meta?.present || [],
      codex: context.meta?.codex || [],
      ledgerCharacters: Object.keys(targetLedger?.state?.characters || {}),
      playerName: effectiveWorld?.card?.player?.name || '',
    });
    const archEffect = {
      sessionId, branchId, turnNo, agent: 'archivist',
      effectId: makeEffectId('archivist', `t${turnNo}`),
      fingerprint: hashFingerprint('archivist', turnNo, branchId, playerText || '', narrative),
    };
    const archRun = await runEffectOnce(archEffect, () => runArchivist({
      session, world: effectiveWorld, turnNo,
      playerText: playerText || '(开场)',
      narrative, branchChoice,
      options: options.archivist || {},
      declaredTargets,
      signal,
      guard: guardOf(archivistSnap),
    }), { isStale: (r) => !!r?.stale });
    // skipped 表示这一轮的记账已经落过（applied）或旧分支已废弃（stale）：不重复写。
    const arch = archRun.skipped
      ? { applied: {}, stale: archRun.status === 'stale', skipped: archRun.status, effect_id: archEffect.effectId }
      : archRun.result;
    memoryStats = arch;
    if (!archRun.skipped) trackUsage('archivist', arch.usage);
    emit({ type: 'memory', stats: summarizeMemory(sessionId, arch, context, branchId) });
    const st = getState(sessionId, { branchId, atTurn: turnNo });
    // state 是完整账本（导出/排查用）；状态条只认 player_view，前端不得从 state 自取展示字段。
    if (st) {
      emit({
        type: 'state', state: st.state, turn_no: st.turn_no,
        player_view: buildPlayerView(st.state, { persons: (context.card?.entities || []).filter(isPerson) }),
      });
    }
    sceneChanged = !arch.stale && detectSceneChange(session, arch, turnNo);
  } catch (err) {
    emit({ type: 'memory', stats: { error: err.message }, degraded: true });
  }

  // 5) 切场：场记归档 + 世界呼吸（都不阻断回合）
  // 场次记录取代了原来的「滚动摘要」：每场一行、只追加、永不互相改写。
  let sceneRecord = null;
  if (sceneChanged && !signal?.aborted) {
    try {
      const sceneEffect = {
        sessionId, branchId, turnNo, agent: 'scene_keeper',
        effectId: makeEffectId('scene', `t${turnNo}`),
        fingerprint: hashFingerprint('scene', turnNo, branchId, memoryStats?.scene_change?.reason || ''),
      };
      const sceneRun = await runEffectOnce(sceneEffect, () => closeScene({
        session, world: effectiveWorld, turnNo,
        reason: memoryStats?.scene_change?.reason || '',
        guard: guardOf(branchSnapshot(sessionId, branchId)),
      }), { isStale: (r) => r === null });
      sceneRecord = sceneRun.skipped ? null : sceneRun.result;
      if (sceneRecord) { trackUsage('scene-keeper', sceneRecord.usage); emit({ type: 'scene', scene: sceneRecord }); }
    } catch (err) {
      console.warn(`[orchestrator] 场记归档失败：${err?.message || err}`);
    }
    try {
      const tickEffect = {
        sessionId, branchId, turnNo, agent: 'world_tick',
        effectId: makeEffectId('world_tick', `t${turnNo}`),
        fingerprint: hashFingerprint('world_tick', turnNo, branchId),
      };
      const tickRun = await runEffectOnce(tickEffect, () => runWorldTick({
        session, world: effectiveWorld, turnNo, signal,
        guard: guardOf(branchSnapshot(sessionId, branchId)),
      }), { isStale: (r) => !!r?.stale });
      if (!tickRun.skipped) {
        const tick = tickRun.result;
        if (tick.events?.length) emit({ type: 'world_tick', events: tick.events });
        trackUsage('world-tick', tick.usage);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') console.warn(`[orchestrator] 世界呼吸失败：${err?.message || err}`);
    }
  }

  // 6) 定期校勘
  const every = config.context.continuityEvery;
  if (every > 0 && turnNo % every === 0 && !signal?.aborted) {
    try {
      const continuityEffect = {
        sessionId, branchId, turnNo, agent: 'continuity',
        effectId: makeEffectId('continuity', `t${turnNo}`),
        fingerprint: hashFingerprint('continuity', turnNo, branchId, every),
      };
      const continuityRun = await runEffectOnce(continuityEffect, () => runContinuity({
        session, world: effectiveWorld, turnNo, signal,
        guard: guardOf(branchSnapshot(sessionId, branchId)),
      }), { isStale: (r) => !!r?.stale });
      if (!continuityRun.skipped) {
        const report = continuityRun.result;
        if (!report.stale) lastContinuity.set(sessionId, report);
        trackUsage('continuity', report.usage);
        emit({ type: 'continuity', report });
      }
    } catch (err) {
      if (err?.name !== 'AbortError') console.warn(`[orchestrator] 校勘失败：${err?.message || err}`);
    }
  }

  // 7) 分支走向
  let branches = null;
  if (generateBranches && !signal?.aborted) {
    try {
      const branchAgentSnap = branchSnapshot(sessionId, branchId);
      const st = getState(sessionId, { branchId, atTurn: turnNo });
      const branchEffect = {
        sessionId, branchId, turnNo, agent: 'branch',
        effectId: makeEffectId('branch', `t${turnNo}`),
        fingerprint: hashFingerprint('branch', turnNo, branchId, narrative),
      };
      const branchRun = await runEffectOnce(branchEffect, () => runBranchAgent({
        world: effectiveWorld,
        state: st?.state || null,
        recentNarrative: narrative,
        present: context.meta?.present || [],
        sceneSheet: context.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '',
        craft: context.craft || null,
        options: options.branch || {},
        signal,
      }));
      if (branchRun.skipped) {
        branches = null;
      } else {
        branches = branchRun.result;
        // 走向只是展示；期间切了分支就不上屏，避免把旧线的选项塞给新线。
        trackUsage('branch', branches.usage);
        if (isBranchCurrent(branchAgentSnap)) {
          emit({ type: 'branches', branches: branches.branches, scene_summary: branches.scene_summary });
        } else {
          branches = null;
          emit({ type: 'branches', branches: [], scene_summary: '', stale: true });
        }
      }
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
    narration_mode: narrator?.narration?.mode || narrationMode,
    usage: narratorUsage,
    session_usage: sessionUsage,
    memory: memoryStats ? { degraded: false, applied: memoryStats.applied } : { degraded: true },
  });

  return {
    turn_no: turnNo, narrative, reasoning: narrator.reasoning,
    branches, usage: narratorUsage, sessionUsage, memoryStats, scene: sceneRecord,
    narration: narrator?.narration || { mode: narrationMode },
  };
}


/**
 * 装配清单：把「这一轮模型看到了什么、为什么」写进 turns.meta_json。
 * 只存摘要级信息（层预算、在场、辞书候选与原因、降级标记），不存正文。
 */
function buildAssemblyMeta(context, narrator) {
  const meta = context?.meta || {};
  const budget = context?.budget || {};
  // 生效的 narrator 参数（DB 绑定优先于 .env）；这里记录的是配置来源，不是单次覆盖。
  const narratorAgent = resolveAgent('narrator');
  return {
    budget: { ...budget },
    present: meta.present || [],
    codex: meta.codex || [],
    theme_tags: meta.theme_tags || [],
    facts: meta.facts ?? 0,
    world_state_changes: meta.world_state_changes ?? 0,
    timeline_past: meta.timeline_past ?? 0,
    timeline_future_held: meta.timeline_future_held ?? 0,
    codex_total: meta.codex_total ?? 0,
    branch: meta.branch || null,
    degraded: meta.degraded || [],
    summary: meta.summary || null,
    retrieval: meta.retrieval || null,
    soft_max: meta.soft_max ?? null,
    hard_max: meta.hard_max ?? null,
    // 预算推导与召回审计：换模型后仍能从回合记录回答「当时给了多少、漏了什么」。
    plan: meta.plan || null,
    recall: meta.recall || null,
    index: meta.system_blocks?.index || null,
    craft: meta.system_blocks?.craft || null,
    dropped_sections: meta.dropped_sections || [],
    // P0-2/P0-1 的可观测结果随回合持久化：缓存前缀归因与硬上限处置。
    cache: meta.cache || null,
    hard_cap: meta.hard_cap || null,
    coverage: meta.coverage || null,
    model: narrator?.model || null,
    effort: narratorAgent.effort,
    temperature: narratorAgent.temperature,
    // 分段演绎的可观测信息：轮数、工具次数、是否定稿、是否回退。
    narration: narrator?.narration || { mode: 'single', rounds: 1, tools: 0, sealed: true },
  };
}

function summarizeMemory(sessionId, arch, context = null, branchId = 'main') {
  const st = getState(sessionId, { branchId });
  return {
    ...arch.applied,
    scene_change: arch.scene_change,
    uncertain: arch.uncertain || [],
    stale: !!arch.stale,
    summary: context?.meta?.summary || null,
    retrieval: context?.meta?.retrieval || null,
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
    card_snapshot: row.card_snapshot_json ? JSON.parse(row.card_snapshot_json) : null,
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
  const world = worldId ? getWorld(worldId) : null;
  // 冻结模板：新会话从这一份快照开始，之后作者改卡不影响它。
  const card = world ? normalizeCard(world.card || {}) : null;
  const session = createSession({
    id, worldId, title, settings,
    cardSnapshot: card,
    worldVersion: world?.version ?? null,
  });

  let anchor = anchorId;
  if (card && !anchor) anchor = card.anchors[0]?.id || null;
  if (worldId && anchor && !card?.anchors.some((a) => a.id === anchor)) {
    // 传入了不存在于快照的锚点：退回第一个，避免开局没有起点。
    anchor = card?.anchors[0]?.id || null;
  }
  if (worldId && anchor) setSessionAnchor(id, anchor, 'main');
  createBranch(id, { branchId: 'main', parentBranch: '', forkTurn: 0, note: '开局主线' });

  // 卡片里的初始关系进入本分支账本，之后由剧情继续演化。
  for (const c of (card?.entities || []).filter(isPerson)) {
    for (const r of c.relations || []) {
      if (!r.to) continue;
      upsertRelation(id, {
        branch_id: 'main', from: c.name, to: r.to,
        kind: r.kind, sentiment: r.sentiment, note: r.note, turn_no: 0,
      });
    }
  }

  // 伏笔表播种成线索：这是「必须回收的钩子」唯一的初始值来源。
  // 只靠史官在正文里「埋」，漏埋一次就永久丢失（旧实现就是这样）。
  for (const seed of card?.seeds || []) {
    if (!seed?.title) continue;
    upsertThread(id, {
      branch_id: 'main',
      title: seed.title,
      status: 'open',
      weight: Number.isFinite(Number(seed.weight)) ? Number(seed.weight) : 0.5,
      note: seed.note || '',
      planted_turn: 0,
      turn_no: 0,
    });
  }

  // 用锚点快照初始化账本（turn_no = 0 表示「开局之前」）
  const snap = anchor ? card?.anchors.find((a) => a.id === anchor) : null;
  if (snap?.snapshot && Object.keys(snap.snapshot).length) {
    // 开局在场 = 锚点快照里真正有状态的人；之后由史官的 scene_change.present 维护。
    const present = Array.isArray(snap.snapshot.present)
      ? snap.snapshot.present
      : Object.keys(snap.snapshot.characters || {});
    setState(id, 0, { ...snap.snapshot, present, turn_no: 0 }, 'main');
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
  // copy-on-fork：新分支从分叉点有效的世界状态开始，不继承旧线之后的变化。
  copyBranchState(sessionId, { fromBranch: oldBranch, toBranch: newBranch, forkTurn: toTurn });
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
  const stateEntry = getState(sessionId, { branchId });
  const usage = session.usage_json ? JSON.parse(session.usage_json) : null;
  // 阅读视图也只读会话快照，不读作者后来又改过的模板。
  const card = normalizeCard(session.card_snapshot || world?.card || {});
  return {
    session,
    card,
    world_version: session.world_version ?? world?.version ?? null,
    world: world ? {
      id: world.id, title: world.title, subtitle: world.subtitle, cover_hue: world.cover_hue,
      tags: world.tags, kind: card.kind, anchor: session.anchor_id,
    } : null,
    turns,
    state: stateEntry?.state || null,
    playerView: buildPlayerView(stateEntry?.state, { persons: (card.entities || []).filter(isPerson) }),
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
  const threads = getThreads(sessionId, { branchId, limit: 200 });
  const notes = getNotes(sessionId, { activeOnly: true });
  const branches = listBranches(sessionId);
  const lastMeta = lastAssembly.get(sessionId) || null;
  const lastCont = lastContinuity.get(sessionId) || null;
  const stateEntry = getState(sessionId, { branchId });

  const card = normalizeCard(session.card_snapshot || world?.card || {});
  const stateChanges = getWorldState(sessionId, { branchId, atTurn: getMaxTurnNo(sessionId) }).length;
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
    state: stateEntry?.state || null,
    state_turn: stateEntry?.turn_no ?? null,
    world_state_changes: stateChanges,
    world_version: session.world_version ?? world?.version ?? null,
    world: world ? {
      id: world.id, title: world.title,
      entity_count: card.entities.length,
      fact_count: card.entities.filter((e) => !isPerson(e)).length,
      person_count: card.entities.filter(isPerson).length,
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

/**
 * 把某条世界线在当前轮定稿为一张**新的**世界卡。
 *
 * 这是一次显式作者操作：运行期状态不会自动写回模板；只有调用这里，
 * 才会把 effective world 固化成新卡与新锚点。旧会话不受影响。
 */
export function canonizeSession({
  sessionId, title = '', anchorLabel = '', openingSeed = '', id = null,
}) {
  const session = getDbSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const worldRow = session.world_id ? getWorld(session.world_id) : null;
  const branchId = session.branch_id || 'main';
  const branch = getBranch(sessionId, branchId);
  const forkTurn = branch ? branch.fork_turn : Number.MAX_SAFE_INTEGER;
  const visibleTurns = getTurnsForBranch(sessionId, branchId, forkTurn, {});
  // 回合编号全局递增，但当前分支可能没有旧线分叉后的编号；用分支里实际最后一轮。
  const turnNo = visibleTurns.length ? visibleTurns[visibleTurns.length - 1].turn_no : 0;
  const base = normalizeCard(session.card_snapshot || worldRow?.card || {});
  const effective = buildEffectiveWorld(base, getWorldState(sessionId, { branchId, atTurn: turnNo }));
  const ledger = getState(sessionId, { branchId, atTurn: turnNo })?.state || {};
  const relations = getRelations(sessionId, { branchId, limit: 200 });
  const threads = getThreads(sessionId, { branchId, status: 'open', limit: 20 });
  const label = anchorLabel || `第 ${turnNo} 轮 · 定稿`;

  // 关系账本不是卡片字段；定稿时并回人物实体的 relations，新会话才能接着用。
  for (const r of relations) {
    const c = (effective.entities || []).find((x) => isPerson(x) && (x.name === r.from_name || x.id === r.from_name));
    if (!c) continue;
    const rel = { to: r.to_name, kind: r.kind, sentiment: r.sentiment, note: r.note };
    const idx = c.relations.findIndex((x) => x.to === r.to_name);
    if (idx >= 0) c.relations[idx] = rel;
    else c.relations.push(rel);
  }

  const notes = [...(effective.author_notes || [])];
  if (effective.runtime?.status) {
    notes.push({ text: `定稿时的世界局势：${effective.runtime.status}`, scope: 'always' });
  }
  if (threads.length) {
    notes.push({
      text: `未回收线索：${threads.map((t) => t.title).join('、')}`,
      scope: 'always',
    });
  }

  const card = normalizeCard({
    ...effective,
    anchors: [
      ...(effective.anchors || []),
      {
        id: `line-${turnNo}`,
        label,
        after_event: '',
        snapshot: {
          time: ledger.time,
          place: ledger.place,
          place_id: ledger.place_id,
          weather: ledger.weather,
          tension: ledger.tension,
          characters: ledger.characters,
          inventory: ledger.inventory,
          quests: ledger.quests,
          last_hook: ledger.last_hook,
          theme_tags: ledger.theme_tags,
        },
        opening_seed: openingSeed || '',
        note: `由会话 ${sessionId} 第 ${turnNo} 轮定稿`,
      },
    ],
    author_notes: notes,
  });

  const newId = id || `line-${randomUUID().slice(0, 8)}`;
  const world = saveWorld({
    id: newId,
    title: title || `${card.title} · ${label}`,
    subtitle: card.subtitle,
    coverHue: worldRow?.cover_hue ?? 210,
    tags: card.tags,
    card,
    source: card.source,
  });
  return {
    world,
    card,
    from: { session_id: sessionId, turn_no: turnNo, branch: branchId },
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
  const worldRow = session.world_id ? getWorld(session.world_id) : null;
  const branchId = session.branch_id || 'main';
  const turnNo = getMaxTurnNo(sessionId);
  const base = normalizeCard(session.card_snapshot || worldRow?.card || {});
  const world = worldRow
    ? {
      ...worldRow,
      card: buildEffectiveWorld(base, getWorldState(sessionId, { branchId, atTurn: turnNo })),
    }
    : null;
  const { runContinuity } = await import('./memory-pipeline.js');
  const snap = branchSnapshot(sessionId, branchId);
  const report = await runContinuity({ session, world, turnNo, signal, guard: guardOf(snap) });
  if (!report.stale) lastContinuity.set(sessionId, report);
  return report;
}
