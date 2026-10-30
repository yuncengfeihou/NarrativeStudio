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
import { isPerson, normalizeCard, buildAliasIndex } from '../world/schema.js';
import { buildEffectiveWorld } from '../world/effective.js';
import { isNumberPath } from '../world/state-paths.js';
import { resolveAgent } from '../model-registry.js';
import { branchSnapshot, guardOf, hashFingerprint, isBranchCurrent, makeEffectId, runEffectOnce } from '../memory/branch-guard.js';
import { buildPlayerView } from '../memory/player-view.js';
import { recallHistory } from '../memory/recall-history.js';
import { recallVisibleFrom } from '../memory/context-engine.js';
import {
  accumulateUsage, addPatch, addTurnPair, checkoutBranch, copyBranchState, countVisibleTurns,
  createBranch, createSession,
  getBranch, getDb, getMaxTurnNo, getNotes, getRelations, getScenes, getSession, latestScene,
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

/**
 * 上游抖动时的整拍重发次数上限。
 *
 * 与 `llm.js` 的 `withRetry` 不是一回事：那一层重试的是**一次 HTTP 请求**（连上之前），
 * 这一层重试的是**一整拍演绎**（连上了、流到一半断了、或者上游 5xx）。
 * 流式输出一旦开始就不可能在原连接上续上，只能在清屏后从同一份上下文重新采样。
 * 3 次（共 4 次尝试）是经验值：长跑实测连续 2 次抖动出现过，连续 4 次没见过。
 */
const NARRATION_RETRY_MAX = 3;

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

  // 1) 玩家行动**暂不落库**，等正文真的产出了再和 narrator 行在同一个事务里写（见 §3）。
  // 早写一步的后果实测过：上游 `terminated` / `fetch failed` 时留下一行没有正文的 player，
  // 这一拍的玩家行动在账本上等于发生了一半——recent 层里多一条没有回应的 user 消息，
  // 报告里表现为「孤儿回合」，只能靠人工 --repair 删行（D31）。
  const playerTurn = isOpening ? null : {
    turn_no: turnNo,
    kind: 'player',
    content: playerText || '',
    images,
    branch_choice: branchChoice,
    branch_id: branchId,
    meta: { source: branchChoice ? 'branch' : 'free' },
  };

  // 2) 设定集检索预检（模型主动取证；不是关键词触发）。
  // auto = 只在大卡上开；会话 settings.codex_retrieval 可强制 on/off。
  let retrieval = null;
  const retrievalMode = session.settings?.codex_retrieval || 'auto';
  // 两个通道的判定都必须用**投影后的卡**，不是冻结的模板卡。
  // 理由：D4 的历史通道由「点名了人」触发，而运行期 introduce 出来的 NPC 只存在于
  // world_state 增量里；拿模板卡建别名索引，玩家点名「卖炭翁张三」永远匹配不到，
  // 「老朋友重逢」这个原始动机场景反而触发不了。辞书计数同理——`introduce` 也能新增设定集条目。
  // 投影成本实测 1.6ms/次（109 行增量），只为判定多算一次不值得省。
  const effectiveForRetrieval = world?.card
    ? buildEffectiveWorld(
      normalizeCard(session.card_snapshot || world.card || {}),
      getWorldState(sessionId, { branchId, atTurn: Math.max(0, turnNo - 1) }),
      [],
    )
    : null;
  const retrievalCard = effectiveForRetrieval || world?.card || null;
  const factCount = (retrievalCard?.entities || []).filter((e) => !isPerson(e)).length;
  // 分段模式自带 codex_lookup，不再额外跑检索预检，避免同一拍查两次。
  const wantRetrieval = narrationMode !== 'segmented' && !isOpening
    && shouldPrecheckRetrieval({
      mode: retrievalMode,
      codexCount: factCount,
      minCodex: config.context.retrievalMinCodex,
      playerText,
      branchChoice,
      card: retrievalCard,
    });
  if (wantRetrieval && !signal?.aborted) {
    try {
      const ledger = getState(sessionId, { branchId, atTurn: Math.max(0, turnNo - 1) })?.state || null;
      // 上一拍正文：资料员判断「这一拍要不要回查历史」时唯一的锚点。
      // 不传的话提示词里的【上一拍结尾】永远是空，它只能凭玩家这一句瞎猜。
      const lastNarrative = getTurnsForBranch(sessionId, branchId, branch?.fork_turn ?? null, {
        from: Math.max(0, turnNo - 1), to: Math.max(0, turnNo - 1), kinds: ['narrator'],
      }).map((t) => t.content).join('\n');
      // 上下文里已经逐字可见的那几拍不必再查（D4 后验）：不设这条下界，
      // 模型会拿「这一拍刚说的话」当查询词，搜回来的就是它眼前已经有的东西。
      // 起点与装配层共读 recallVisibleFrom()（同一个 overlapWindowFrom），不各写一份规则。
      // 场次边界只认「本轮之前已封场」的：scenes 表每行都是一场，最新一行就是边界。
      const closedTo = Math.min(
        Number(latestScene(sessionId, branchId)?.turn_to) || 0,
        Math.max(0, turnNo - 1),
      );
      const excludeFrom = recallVisibleFrom(closedTo, turnNo, config.context.recentOverlapTurns);
      retrieval = await runRetrieval({
        card: retrievalCard, playerText, ledger, lastNarrative, signal,
        // 历史回查要按分支可见性过滤：不能查到废弃线上的原文。
        sessionId, branchId, forkTurn: branch?.fork_turn ?? null, atTurn: Math.max(0, turnNo - 1),
        excludeFrom,
      });
      trackUsage('retrieval', retrieval?.usage);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      console.warn(`[orchestrator] 检索预检失败：${err?.message || err}`);
    }
  }

  // 2.2) `gone` 的回程通道（D10-A）：玩家这一拍点名了某个被标成「已离场」的人，
  // 说明她已经回到镜头里了。模型看不见 life_state，不会自己写回；由代码按
  // 「玩家点名」这个已经算出来的信号补一次，并留 life_state_revived 审计。
  // 只认 playerText（不认旁白顺带提及），只处理 gone（dead 必须模型显式写回）。
  // 必须在装配之前：写回的 life_state 要能在这一拍的场记单里生效。
  // 不新增 SSE 事件：审计落在 patches，报告与记忆面板都能读。
  if (!isOpening && world?.card) {
    try {
      const { reviveNamedGone } = await import('./memory-pipeline.js');
      reviveNamedGone({ sessionId, branchId, turnNo, world, playerText });
    } catch (err) {
      console.warn(`[orchestrator] gone 回程失败：${err?.message || err}`);
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
  // 这一拍有可能在产出正文前失败（D31：失败就整拍回滚、一行都不落库）。
  // 那时「上一拍」缓存必须退回去，否则下一拍会拿一个不存在的回合当基线：
  // 缓存漂移探针的 `prev_count` 与装配清单对不上（D30 的 gap），记忆面板也会
  // 显示这一拍其实没发生的装配。所以先拍快照，失败路径统一还原。
  const prevAssemblyCache = lastAssembly.get(sessionId) || null;
  const prevMessagesCache = lastMessages.get(sessionId) || null;
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
  // 整拍重发要重置的缓存：装配诊断 + 上一拍消息基线。失败/重发时都退回进入这一拍之前的值。
  const restoreCaches = () => {
    lastAssembly.set(sessionId, prevAssemblyCache);
    lastMessages.set(sessionId, prevMessagesCache);
  };
  const runNarration = async () => {
    if (narrationMode !== 'segmented') return runSingleNarrator();
    try {
      return await runNarratorSegmented({
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
      // 上游抖动要整拍重发，不能先降级成单发——那是两次不同的调用，
      // 会让「重发几次才成功」的统计失去意义，也会把分段模式悄悄关掉（D33）。
      if (err?.retryable) throw err;
      // 上游不支持 tools、或循环内出错：清掉已上屏的草稿，回退到单发。
      emit({ type: 'narrative_reset', reason: 'segmented_fallback' });
      emit({ type: 'narration_fallback', mode: 'segmented', reason: err?.message || String(err) });
      console.warn(`[orchestrator] 分段演绎失败，回退单发：${err?.message || err}`);
      const single = await runSingleNarrator();
      single.narration = { mode: 'single', fallback: 'segmented', rounds: 1, tools: 0, sealed: true };
      return single;
    }
  };

  // 记下这一轮真正发给模型的 messages，供下一轮计算前缀复用率（缓存归因）。
  // 必须在 narrator 跑之前抓，因为 guidance 会被插进尾部。
  try {
    const { buildNarratorMessages } = await import('./narrator.js');
    lastMessages.set(sessionId, buildNarratorMessages({
      session, world: effectiveWorld, context, guidance: narratorOptions.guidance,
    }));
  } catch { /* 归因失败不影响回合 */ }

  let narrator;
  for (let attempt = 1; ; attempt++) {
    try {
      narrator = await runNarration();
      // 空正文：上游偶发只产出 reasoning、content 为空 → 关闭推理重试一次。
      // 与「整拍重发」分开：这里重试的是**同一份上下文**换个采样姿势，
      // 不涉及清屏（本来就没内容上屏）。
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
      if (attempt > 1) {
        narrator.narration = { ...(narrator.narration || {}), transient_retries: attempt - 1 };
      }
      break;
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        restoreCaches();
        emit({ type: 'error', message: '已取消', turn_no: turnNo, aborted: true });
        throw err;
      }
      // 上游抖动（断连 / 流中途断 / 5xx / 超时）不是这一拍的内容问题：
      // 清掉已经上屏的残稿、退避后整拍重发，而不是把错误甩给人去重打一遍（D33）。
      // 判据只看 `retryable`（llm.js 已经把网络层错误归一成这个标记）；
      // 请求本身有问题（4xx / 参数错）重发多少次都一样，必须立刻失败。
      const transient = !!err?.retryable;
      if (transient && attempt <= NARRATION_RETRY_MAX) {
        console.warn(
          `[orchestrator] 第 ${turnNo} 轮上游抖动（${err.message}），`
          + `第 ${attempt}/${NARRATION_RETRY_MAX} 次整拍重发`,
        );
        emit({
          type: 'narrative_reset',
          reason: 'transient',
          message: `上游中断，正在重试（${attempt}/${NARRATION_RETRY_MAX}）`,
        });
        emit({ type: 'narration_retry', turn_no: turnNo, attempt, max: NARRATION_RETRY_MAX, reason: err.message });
        await new Promise((r) => setTimeout(r, Math.min(800 * 2 ** (attempt - 1), 4000)));
        continue;
      }
      // 整拍回滚：一行都没落库，所以「上一拍」缓存也要退回去（D31）。
      restoreCaches();
      // 走到这里说明正文没产出 → 这一拍一行都没落库（D31：player 行延后到正文产出后同事务写）。
      // 带上 not_persisted，前端才好把玩家那句话还回输入框，而不是让人重打一遍。
      emit({
        type: 'error',
        message: `剧情演绎失败: ${err.message}`,
        turn_no: turnNo,
        not_persisted: true,
        retryable: true,
        transient_retries: attempt - 1,
      });
      throw err;
    }
  }

  const narrative = narrator.content || '';
  const narratorUsage = narrator.usage || null;

  // 3) 正文与玩家行动**同一个事务**落库。空正文不写：那一拍的玩家行动在账本上不该发生，
  // 写了空 narrator 行的后果是三重的——①字数统计被拉低 ②局部重复率分母虚高（指标虚好）
  // ③一条空 assistant 消息进下一拍 recent 层；下游账本（world_state / character_states /
  // assertions / relations / voices）全是 0 行，等于玩家白说了一句（D28 实测 A 局 t5/t10）。
  // 已经是**重试过一次**仍为空：再重试没有证据表明会好转，直接把这一拍判失败，
  // 让前端把玩家那句话留在输入框里重发——比静默吞掉一次行动好。
  if (!String(narrative).trim()) {
    // 整拍回滚（D31）：没落库，装配/消息缓存也不能前进到这一拍。
    restoreCaches();
    const detail = `上游连续两次只输出思考、没有正文（finish_reason=${narrator.finishReason || '?'}，`
      + `completion_tokens=${narratorUsage?.completion_tokens ?? '?'}）`;
    emit({
      type: 'error',
      message: `这一拍没有产出正文，已回滚：${detail}`,
      turn_no: turnNo,
      not_persisted: true,
      empty_narration: true,
      retryable: true,
    });
    throw new Error(`空正文：${detail}`);
  }

  addTurnPair(sessionId, [
    playerTurn,
    {
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
    },
  ]);
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

    // 数值增量被拒（值不是数字）：不 clamp、不静默吞，落成 patch 供排查。
    // 必须在本轮 delta 写完之后重新投影一次——装配时那份 card 是 turnNo-1 的，
    // 拿它看不到本轮刚写进去的 delta。只有本轮真写过数值路径才需要投影。
    //
    // 余额转负**不再**算拒绝（D11）：它照常落库、渲染成「欠 X」，这里记成
    // `overdrawn` 只是留痕（正文里真的开始欠债了，报告该看得见）。
    //
    // 投影还承担一件事（D34）：`introduce` 声明 person 却撞上卡里的非人物条目时，
    // 投影会把它升级成人物。升级是**投影期**行为（卡模板不动），所以只在这里留痕，
    // 让「这张卡的某个概念条目被剧情升级成了人」在报告里看得见。
    if (!archRun.skipped) {
      const turnDeltas = getWorldState(sessionId, { branchId, atTurn: turnNo })
        .filter((d) => Number(d.turn ?? d.valid_from) === turnNo);
      const needsProjection = turnDeltas.some((d) => isNumberPath(d.entity_kind, d.path)
        || d.op === 'introduce');
      if (needsProjection) {
        const projected = buildEffectiveWorld(
          normalizeCard(session.card_snapshot || world?.card || {}),
          getWorldState(sessionId, { branchId, atTurn: turnNo }),
        );
        for (const r of projected.rejected_deltas || []) {
          if (Number(r.turn) !== turnNo) continue;
          addPatch(sessionId, {
            branch_id: branchId, agent: 'archivist', kind: 'rejected_delta', turn_no: turnNo,
            status: 'failed', severity: 'warn', payload: r,
            evidence: `${r.path || ''} ${r.op || ''} ${r.value ?? ''}`.trim(),
          });
        }
        for (const r of projected.overdrafts || []) {
          if (Number(r.turn) !== turnNo) continue;
          addPatch(sessionId, {
            branch_id: branchId, agent: 'archivist', kind: 'overdrawn', turn_no: turnNo,
            status: 'applied', severity: 'info', payload: r,
            evidence: `${r.path || ''} ${r.prev} ${r.value >= 0 ? '+' : ''}${r.value} = ${r.next}`.trim(),
          });
        }
        for (const r of projected.promotions || []) {
          if (Number(r.turn) !== turnNo) continue;
          addPatch(sessionId, {
            branch_id: branchId, agent: 'archivist', kind: 'entity_promoted', turn_no: turnNo,
            status: 'applied', severity: 'info', payload: r,
            evidence: `${r.from} → ${r.to}：${r.name || r.id}`,
          });
        }
        // D34：被白名单挡掉的增量。以前这里什么都不留——卡里把某人写成 concept 之后，
        // 他的 life_state/mood/goal/location 全部消失，报告看不见、正文照演。
        // `entity_kind` 与 `entity_type` 不同就是「类型判错了」的直接证据。
        for (const r of projected.dropped_deltas || []) {
          if (Number(r.turn) !== turnNo) continue;
          addPatch(sessionId, {
            branch_id: branchId, agent: 'archivist', kind: 'dropped_delta', turn_no: turnNo,
            status: 'failed', severity: 'warn', payload: r,
            evidence: `${r.entity_kind}/${r.entity_type} ${r.entity_id || ''} ${r.path} ${r.op}`.trim(),
          });
        }
      }
    }

    // 4.5) `gone` 的回程第二路（D10 延伸）：史官这一拍把某人写成在场了。
    // 玩家点名只覆盖「玩家主动提到他」；「他自己回到镜头里」这一类（站在门外接话、
    // 史官每拍给他写 location/mood/goal）永远等不到点名，`life_state` 就卡在 gone——
    // 机制和正文各说各话。判据全部来自结构化写入（states/changes 的在场类字段、
    // 账本 present），不做文本匹配，也不新增注入通道：写回在**下一拍**装配前生效。
    if (!archRun.skipped && arch?.applied?.onstage?.length) {
      try {
        const { reviveOnstageGone } = await import('./memory-pipeline.js');
        const revived = reviveOnstageGone({
          sessionId, branchId, turnNo,
          aliasIndex: buildAliasIndex(normalizeCard(effectiveWorld?.card || world?.card || {})),
          entries: arch.applied.onstage,
        });
        if (revived.length) arch.applied.life_state_revived = revived;
      } catch (err) {
        console.warn(`[orchestrator] gone 回程（在场态）失败：${err?.message || err}`);
      }
    }

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

  // 5) 切场：场记归档（不阻断回合）
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
  }

  // 5.5) 世界呼吸（后台推演不在场角色的行动）
  //
  // 触发 = 切场 或 每 WORLD_TICK_EVERY 轮。两者是**正交**的：切场是剪辑决定，
  // 世界呼吸是时间流逝——只挂在切场上，一个 12 拍的长场里世界会完全静止。
  // `worldTickEvery = 0` 表示只保留切场触发（与 SCENE_EVERY / CONTINUITY_EVERY
  // 的「0 = 关掉」同构）。单一调用点 + 单一 effectId，切场与轮数节拍重合时不会跑两遍。
  // runWorldTick 在没有幕外候选时不发模型调用，直接返回 `{ events: [] }`。
  const tickEvery = config.context.worldTickEvery;
  const tickDue = sceneChanged || (tickEvery > 0 && turnNo % tickEvery === 0);
  if (tickDue && !signal?.aborted) {
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
        sceneSheet: context.branchSheet
          || context.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '',
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
export function buildAssemblyMeta(context, narrator) {
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
    // 断言真正进了提示词的是 `selectFacts` 的结果，不是 `getAssertions` 的返回。
    // 「单值谓词全渲染、多值谓词只留 manyLimit 条」这一步此前完全没有落库，
    // 于是报告只能看到 SQL `LIMIT 300` 那道窗，看不到窗内还有 5–10 倍的丢弃
    // （实测 t31：窗口内 123 条断言，实际渲染 24 条）。与 layers_truncated 同类，
    // 必须在白名单里，否则算出来也读不到。
    facts_candidates: meta.facts_candidates ?? 0,
    facts_single: meta.facts_single ?? 0,
    facts_many_rendered: meta.facts_many_rendered ?? 0,
    facts_many_dropped: meta.facts_many_dropped ?? 0,
    // D9 之后多值条数由场记单配额推导，不是一个常量。把它记下来才能区分
    // 「预算小所以渲染少」和「又退回写死 24 了」——报告里只看渲染数分不清这两者。
    facts_many_limit: meta.facts_many_limit ?? null,
    // 关系同理（D17）：`LIMIT 60` 只是加载量，真正决定模型看见什么的是渲染上限；
    // 只记 loaded/window 会让「8 条已经填满」在报告里显示成「8/60 还很空」。
    relations_limit: meta.relations_limit ?? null,
    relations_rendered: meta.relations_rendered ?? null,
    world_state_changes: meta.world_state_changes ?? 0,
    timeline_past: meta.timeline_past ?? 0,
    timeline_future_held: meta.timeline_future_held ?? 0,
    // 实体链接命中了谁（红线 2 的唯一字符串匹配出口，D24）：报告里追问
    // 「这个人为什么在场/为什么不在场」时，这是唯一的证据。
    mentioned: meta.mentioned || null,
    // 实体图规模（D24）：大卡的边数直接决定图遍历成本与「谁说认识谁」的可用性。
    graph: meta.graph || null,
    codex_total: meta.codex_total ?? 0,
    // 辞书两道出口的丢弃数（D24）：全文 codexT0 基本全渲染，但**简报** codexT1
    // 只取 floor(sceneCap*0.2/40) 条（200K 窗口下 112 条），51 拍实测丢了 4840/10552
    // = 46%，而这三个数此前一个都没落库——和 D3/D9/D17 同形：一个写死的上限，
    // 报告量不到，就一直显示健康。
    codex_candidates: meta.codex_candidates ?? null,
    codex_rendered: meta.codex_rendered ?? null,
    codex_dropped: meta.codex_dropped ?? null,
    codex_brief_candidates: meta.codex_brief_candidates ?? null,
    codex_brief_rendered: meta.codex_brief_rendered ?? null,
    // 渲染前体检的干预记录（D24）：lint-state 会从 present 里剔人、改物品持有人。
    // 51 拍实测 8 拍发生干预（全是「gone 的凌玥被剔出在场」，其中 4 拍玩家当拍名了她），
    // 但 state_fixes 从未落库，报告里连一行都没有——D10 那类缺陷正是靠它才看得见。
    state_fixes: meta.state_fixes || [],
    state_warnings: meta.state_warnings || [],
    // 成长曲线（D24）：total / unlocked / omens 三个数此前也没落库，
    // 于是「这条曲线一次都没解锁过」在报告里同样看不见。
    fates: meta.fates || null,
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
    // 渲染归属审计与场记单降级档位：两者都是「新增内容落进了哪一层」的验收证据，
    // 只在装配出口存在、不落库的话，事后无法回答「这一拍到底给了模型什么」。
    messages: meta.messages || [],
    scene_sheet: meta.scene_sheet || null,
    // SQL 层截断可见化（D3）：断言/关系/线索各取了窗口里的多少行、库里共有多少行。
    // 必须在白名单里，否则上面算出来的数字永远落不了库——报告读不到就等于没做
    // （初版就漏了这一条：`meta.layers_truncated` 已产出，`turns.meta_json` 里没有）。
    layers_truncated: meta.layers_truncated || null,
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
    // `uncertain` 是史官自述的「正文没明说」清单，用完即弃：没有消费方，
    // 既不落库也不再经 SSE 外发（见 archivist.js 的「未确定项」注释）。
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
 * 在会话锁内切到另一条已有世界线。
 *
 * 与 `forkSessionSafe` 同理：回滚/重写/切分支都要串行，否则旁路 Agent 会把
 * 结果写进刚被切换掉的那条线。
 */
export async function checkoutBranchSafe(opts) {
  return withSessionLock(opts.sessionId, () => checkoutBranch(opts.sessionId, opts.branchId));
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
  // turn_count 是缓存，换了线必须按新线重算（D33）：分叉到第 8 轮之后，
  // 界面还显示旧线的 90 轮，读起来像「历史没删所以新线也有 90 轮」。
  touchSession(sessionId, countVisibleTurns(sessionId, newBranch));
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
  // 回合数是**派生值**：切/开分支之后 sessions.turn_count 这个缓存可能还停在旧线上。
  // 缓存比实际大时以实际为准；缓存为空（旧会话）时也回落到派生值（D33）。
  const derivedTurns = countVisibleTurns(sessionId, branchId);
  const turnCount = session.turn_count ? Math.min(session.turn_count, derivedTurns) : derivedTurns;

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
    branches: branches.map((b) => ({
      branch_id: b.branch_id, fork_turn: b.fork_turn, status: b.status, note: b.note,
      turn_count: countVisibleTurns(sessionId, b.branch_id),
      is_current: b.branch_id === branchId,
    })),
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


