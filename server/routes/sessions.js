/**
 * server/routes/sessions.js — 剧情会话接口（v4）
 *
 * 会话属于一张世界卡（world_id）。设定活在世界卡里，会话只存运行期参数与进度。
 * 记忆相关的读写全部走 v4 的表：scenes / assertions / character_states / voices / patches / branches。
 */
import { Router } from 'express';
import { config } from '../config.js';
import {
  EFFORTS, getEffectiveConfig, resetRuntimeConfig, resolveAgent, saveRuntimeConfig,
} from '../model-registry.js';
import { currentPlan } from '../memory/context-plan.js';
import {
  auditSession, canonizeSession, checkoutBranchSafe, createSessionWithSettings, forkSessionSafe,
  getMemoryStats, getSessionSnapshot, recallSession, runTurn,
} from '../agents/orchestrator.js';
import {
  addAssertion, addNote, countVisibleTurns, deleteNote, deleteSession, deleteVoice, getAssertions,
  getBranch, getCharStates, getDb, getMaxTurnNo, getNotes, getScenes, getSession, getState, getThreads,
  getTurnsForBranch, getTurn, getVoices, getWorld, getWorldState, listBranches, listPatches, listSessions,
  countPatches, patchKindCounts, countVoices,
  retractAssertion, setPatchStatus, setState, setVoicePinned, updateNote, updateSession,
  updateTurnContent,
} from '../memory/store.js';
import { recallHistory } from '../memory/recall-history.js';
import { craftCatalog, normalizeCraftSettings } from '../world/craft.js';

export const sessionsRouter = Router();

function intOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 生效配置视图 + 预算规划：窗口是硬事实，硬上限/软目标/各层配额从它推导。 */
function runtimeWithPlan() {
  const runtime = getEffectiveConfig();
  const plan = currentPlan();
  return {
    ...runtime,
    context: {
      ...runtime.context,
      hard_max_tokens: plan.hardMax,
      soft_target_tokens: plan.softMax,
      auto_soft: plan.autoSoft,
      layers: { ...plan.layers },
      shares: { ...plan.shares },
    },
  };
}

/* ------------------------------ 配置 ------------------------------ */

/**
 * GET /api/config
 * 旧字段（models/defaults/limits/budget/narration）保持原形状与含义，值改为「生效值」：
 * 未保存运行期配置时与 .env 逐项一致；保存后无需重启即反映 DB 绑定。
 * `runtime` 是模型配置层的完整视图（服务商 / 模型 / Agent 绑定，apiKey 只给掩码）。
 */
sessionsRouter.get('/config', (req, res) => {
  const narrator = resolveAgent('narrator');
  const archivist = resolveAgent('archivist');
  const branch = resolveAgent('branch');
  const plan = currentPlan();
  res.json({
    models: {
      default: narrator.model,
      reasoning_efforts: [...EFFORTS],
    },
    defaults: {
      narrator_effort: narrator.effort ?? config.agents.narrator.reasoningEffort,
      archivist_effort: archivist.effort ?? config.agents.archivist.reasoningEffort,
      branch_effort: branch.effort ?? config.agents.branch.reasoningEffort,
      archive_budget: plan.layers.archive,
      archive_detail_budget: plan.layers.archiveDetail,
      scene_every: config.context.sceneEvery,
      scene_max_tokens: config.context.sceneMaxTokens,
      continuity_every: config.context.continuityEvery,
      continuity_max_applied: config.context.continuityMaxApplied,
      world_tick_every: config.context.worldTickEvery,
    },
    limits: {
      // 提示词硬上限（窗口 − 生成预留 − 安全余量）；窗口本身单独给出。
      context_max_tokens: plan.hardMax,
      context_soft_tokens: plan.softMax,
      context_window_tokens: plan.window,
      context_output_reserve_tokens: plan.outputReserve,
      narrator_max_tokens: narrator.maxTokens,
    },
    // 各层配额：由窗口推导（不是 env 常量）。比例见 context-plan.js。
    budget: plan.layers,
    budget_shares: plan.shares,
    narration: {
      default_mode: config.narration.mode,
      max_rounds: config.narration.maxRounds,
      round_max_tokens: config.narration.roundMaxTokens,
      tool_history_tokens: config.narration.toolHistoryTokens,
      tool_result_max_tokens: config.narration.toolResultMaxTokens,
    },
    // 工艺层的轴与取值由 craft.js 独家提供：前端不再自带一份选项清单，
    // 加/删预设只改后端一处（见 AGENTS.md §11.8）。
    craft: craftCatalog(),
    runtime: runtimeWithPlan(),
  });
});

/** PUT /api/config —— 全量保存运行期模型配置（立即生效，不需要重启）。 */
sessionsRouter.put('/config', (req, res) => {
  try {
    saveRuntimeConfig(req.body || {});
    res.json({ ok: true, runtime: runtimeWithPlan() });
  } catch (err) {
    const status = err?.status === 400 ? 400 : 500;
    if (status === 500) console.warn(`[config] 保存失败：${err?.message || err}`);
    res.status(status).json({ error: { message: err?.message || String(err) } });
  }
});

/** DELETE /api/config —— 删除运行期配置，回到 .env 默认（立即生效）。 */
sessionsRouter.delete('/config', (req, res) => {
  try {
    resetRuntimeConfig();
    res.json({ ok: true, runtime: runtimeWithPlan() });
  } catch (err) {
    console.warn(`[config] 重置失败：${err?.message || err}`);
    res.status(500).json({ error: { message: err?.message || String(err) } });
  }
});

/* ------------------------------ 会话 ------------------------------ */

sessionsRouter.get('/sessions', (req, res) => {
  const worldId = req.query.world_id ? String(req.query.world_id) : null;
  res.json(listSessions({ worldId }));
});

sessionsRouter.post('/sessions', (req, res) => {
  const { title, settings, world_id: worldId, worldId: worldId2, anchor_id } = req.body || {};
  const wid = worldId || worldId2 || null;
  const world = wid ? getWorld(wid) : null;
  if (wid && !world) return res.status(404).json({ error: { message: 'world not found' } });
  const card = world?.card || {};
  const cap = currentPlan().hardMax;
  const sessionSettings = {
    title: title || card.title || '未命名剧情',
    narrator_effort: 'high',
    context_max_tokens: cap,
    style_tags: card.genre || [],
    ...(settings || {}),
  };
  // 工艺层取值归一：非法值不静默落库（否则改回默认时旧值会一直躺在 settings 里）。
  Object.assign(sessionSettings, normalizeCraftSettings(sessionSettings, { fill: true }));
  // 会话级上限只能是模型窗口内的一次收窄，不能超过 narrator 绑定模型的 contextWindow。
  const requestedMax = Number(sessionSettings.context_max_tokens);
  sessionSettings.context_max_tokens = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.min(requestedMax, cap)
    : cap;
  const session = createSessionWithSettings({
    title: title || card.title || '未命名剧情',
    worldId: wid,
    anchorId: anchor_id || null,
    settings: sessionSettings,
  });
  res.status(201).json(session);
});

sessionsRouter.get('/sessions/:id', (req, res) => {
  const snapshot = getSessionSnapshot(req.params.id);
  if (!snapshot) return res.status(404).json({ error: { message: 'session not found' } });
  res.json(snapshot);
});

sessionsRouter.patch('/sessions/:id', (req, res) => {
  const { title, settings, world_id: worldId, scene_directive } = req.body || {};
  const patch = { title, settings };
  if (worldId !== undefined) patch.worldId = worldId;
  if (scene_directive !== undefined) {
    const cur = getSession(req.params.id);
    patch.settings = { ...(cur?.settings || {}), scene_directive: String(scene_directive || '') };
  }
  if (patch.settings) patch.settings = normalizeCraftSettings(patch.settings);
  const session = updateSession(req.params.id, patch);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json(session);
});

sessionsRouter.delete('/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  deleteSession(req.params.id);
  res.json({ deleted: req.params.id });
});

/* --------------------------- 回合读取/检索 --------------------------- */

sessionsRouter.get('/sessions/:id/turns', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const from = intOr(req.query.from, 1);
  const to = intOr(req.query.to, Number.MAX_SAFE_INTEGER);
  const limit = Math.min(intOr(req.query.limit, 400), 2000);
  const branchId = session.branch_id || 'main';
  const branch = getDb().prepare(`SELECT * FROM branches WHERE session_id=? AND branch_id=?`).get(session.id, branchId);
  const forkTurn = branch ? branch.fork_turn : Number.MAX_SAFE_INTEGER;
  const rows = getTurnsForBranch(session.id, branchId, forkTurn, { from, to });
  res.json({ turns: rows.slice(-limit), total: rows.length, from, to, branch: branchId });
});

sessionsRouter.get('/sessions/:id/search', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ hits: [] });
  const rows = getDb().prepare(
    `SELECT turn_no, kind, content, created_at FROM turns
     WHERE session_id=? AND content LIKE ? ORDER BY turn_no ASC LIMIT 120`,
  ).all(session.id, `%${q}%`);
  const hits = rows.map((r) => {
    const idx = r.content.indexOf(q);
    const start = Math.max(0, idx - 45);
    const end = Math.min(r.content.length, idx + q.length + 75);
    return {
      turn_no: r.turn_no,
      kind: r.kind,
      created_at: r.created_at,
      before: (start > 0 ? '…' : '') + r.content.slice(start, idx),
      match: q,
      after: r.content.slice(idx + q.length, end) + (end < r.content.length ? '…' : ''),
    };
  });
  res.json({ hits, query: q });
});

/* ------------------------------ 跑回合 ------------------------------ */

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

sessionsRouter.post('/sessions/:id/turn', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });

  const {
    playerText = '', images = null, branchChoice = null,
    generateBranches = true, isOpening = false, directive = '',
  } = req.body || {};

  sseHead(res);
  const send = (evt) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`); };
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);

  const aborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });

  try {
    await runTurn({
      sessionId: session.id,
      playerText, images, branchChoice, generateBranches, isOpening,
      options: directive ? { directive } : {},
      onEvent: send,
      signal: aborter.signal,
    });
  } catch (err) {
    send({ type: 'error', message: err.message || String(err) });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

sessionsRouter.post('/sessions/:id/opening', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });

  sseHead(res);
  const send = (evt) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`); };
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
  const aborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });

  try {
    await runTurn({
      sessionId: session.id,
      playerText: '', images: null, branchChoice: null,
      generateBranches: req.body?.generateBranches !== false,
      isOpening: true,
      options: req.body?.directive ? { directive: req.body.directive } : {},
      onEvent: send,
      signal: aborter.signal,
    });
  } catch (err) {
    send({ type: 'error', message: err.message || String(err) });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

sessionsRouter.post('/sessions/:id/branches', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  try {
    const { runBranchAgent } = await import('../agents/branch.js');
    const { getRecentTurnsForBranch, getBranch } = await import('../memory/store.js');
    const world = session.world_id ? getWorld(session.world_id) : null;
    const branchId = session.branch_id || 'main';
    const branch = getBranch(session.id, branchId);
    const forkTurn = branch ? branch.fork_turn : Number.MAX_SAFE_INTEGER;
    const recent = getRecentTurnsForBranch(session.id, branchId, forkTurn, 2)
      .filter((t) => t.kind === 'narrator').pop();
    const st = getState(session.id, { branchId: session.branch_id || 'main' });
    const result = await runBranchAgent({
      world,
      state: st?.state || null,
      recentNarrative: recent?.content || '',
      present: [],
      sceneSheet: '',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

sessionsRouter.post('/sessions/:id/rewrite', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const turnNo = Number(req.body?.turn_no);
  if (!Number.isInteger(turnNo) || turnNo < 1) {
    return res.status(400).json({ error: { message: 'turn_no must be a positive integer' } });
  }
  const playerRow = getTurn(session.id, turnNo, 'player');
  const narratorRow = getTurn(session.id, turnNo, 'narrator');
  if (!playerRow && !narratorRow) return res.status(404).json({ error: { message: 'turn not found' } });

  sseHead(res);
  const send = (evt) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`); };
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
  const aborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });

  try {
    // 重写 = 从这一轮开新分支，旧线保留为「如果当时那么写」
    const fork = await forkSessionSafe({ sessionId: session.id, toTurn: turnNo - 1, note: `重写第 ${turnNo} 轮` });
    send({ type: 'fork', branch: fork.branch_id, fork_turn: fork.fork_turn });
    const guidance = String(req.body?.guidance || '').trim();
    await runTurn({
      sessionId: session.id,
      playerText: playerRow?.content || '',
      images: playerRow?.images || null,
      branchChoice: playerRow?.branch_choice || null,
      generateBranches: req.body?.generateBranches !== false,
      options: guidance ? { narrator: { guidance } } : {},
      onEvent: send,
      signal: aborter.signal,
    });
  } catch (err) {
    send({ type: 'error', message: err.message || String(err) });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

/** 回滚 = 开新分支。旧分支标 abandoned，历史不删。 */
sessionsRouter.post('/sessions/:id/rollback', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const turnNo = Number(req.body?.turn_no);
  if (!Number.isInteger(turnNo) || turnNo < 0) {
    return res.status(400).json({ error: { message: 'turn_no must be a non-negative integer' } });
  }
  try {
    const fork = await forkSessionSafe({ sessionId: session.id, toTurn: turnNo, note: `回到第 ${turnNo} 轮` });
    res.json({ ...fork, turn_no: turnNo, memoryStats: getMemoryStats(session.id) });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

sessionsRouter.get('/sessions/:id/branches', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const current = session.branch_id || 'main';
  const branches = listBranches(session.id).map((b) => ({
    ...b,
    // 每条线各能看见多少拍：fork 之后各线长度不同，只有一条 turn_count 是错的。
    turn_count: countVisibleTurns(session.id, b.branch_id),
    is_current: b.branch_id === current,
  }));
  res.json({ branches, current, turn_count: countVisibleTurns(session.id, current) });
});

/**
 * 切回一条已有的世界线（不新建分支）。
 *
 * 界面一直写着「旧线随时可以回去看」，在此之前没有任何入口真的切回去——
 * `setSessionBranch` 只被 `forkSession` 调过。这是那条文案的实现（D33）。
 */
sessionsRouter.post('/sessions/:id/checkout', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const branchId = String(req.body?.branch_id || '').trim();
  if (!branchId) return res.status(400).json({ error: { message: 'branch_id is required' } });
  if (!getBranch(session.id, branchId)) {
    return res.status(404).json({ error: { message: `branch not found: ${branchId}` } });
  }
  try {
    const result = await checkoutBranchSafe({ sessionId: session.id, branchId });
    res.json({ ...result, memoryStats: getMemoryStats(session.id) });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/** 把当前世界线定稿为一张新世界卡（显式操作，不改动旧会话）。 */
sessionsRouter.post('/sessions/:id/canonize', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  try {
    const body = req.body || {};
    const targetId = body.id ? String(body.id) : null;
    if (targetId && getWorld(targetId)) {
      return res.status(409).json({ error: { message: 'world id already exists' } });
    }
    const result = canonizeSession({
      sessionId: session.id,
      title: String(body.title || '').trim(),
      anchorLabel: String(body.anchor_label || '').trim(),
      openingSeed: String(body.opening_seed || '').trim(),
      id: targetId,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/* --------------------------- 检索与校勘 --------------------------- */

sessionsRouter.post('/sessions/:id/recall', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: { message: 'question is required' } });
  try {
    const result = await recallSession({ sessionId: session.id, question });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

sessionsRouter.post('/sessions/:id/recall-history', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: { message: 'query is required' } });
  try {
    const out = recallHistory({
      sessionId: session.id,
      branchId: session.branch_id || 'main',
      atTurn: req.body?.at_turn != null ? intOr(req.body.at_turn, getMaxTurnNo(session.id)) : getMaxTurnNo(session.id),
      query,
      limit: req.body?.limit,
      kinds: Array.isArray(req.body?.kinds) ? req.body.kinds : undefined,
    });
    res.json({ query: out.meta.query, hits: out.hits, text: out.text, meta: out.meta });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

sessionsRouter.post('/sessions/:id/audit', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  try {
    const report = await auditSession({ sessionId: session.id });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/* ------------------------------ 记忆 ------------------------------ */

sessionsRouter.get('/sessions/:id/memory', (req, res) => {
  const stats = getMemoryStats(req.params.id);
  if (!stats) return res.status(404).json({ error: { message: 'session not found' } });
  res.json(stats);
});

sessionsRouter.get('/sessions/:id/assertions', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const branchId = session.branch_id || 'main';
  res.json({
    assertions: getAssertions(session.id, {
      branchId,
      subject: req.query.subject ? String(req.query.subject) : null,
      includeInvalid: req.query.all === '1',
      limit: 300,
    }),
  });
});

sessionsRouter.post('/sessions/:id/assertions', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const { subject, predicate, object, visibility } = req.body || {};
  if (!subject || !predicate || !object) {
    return res.status(400).json({ error: { message: 'subject/predicate/object are required' } });
  }
  const id = addAssertion(session.id, {
    branch_id: session.branch_id || 'main',
    subject, predicate, object,
    visibility: visibility || 'public',
    valid_from: getMaxTurnNo(session.id),
    asserted_turn: getMaxTurnNo(session.id),
    source_turn: getMaxTurnNo(session.id),
    confidence: 1,
    evidence: '作者手工添加',
  });
  res.status(201).json({ id, assertions: getAssertions(session.id, { branchId: session.branch_id || 'main', limit: 300 }) });
});

sessionsRouter.delete('/sessions/:id/assertions/:assertionId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  retractAssertion(session.id, Number(req.params.assertionId));
  res.json({ ok: true });
});

sessionsRouter.get('/sessions/:id/states', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json({ states: getCharStates(session.id, { branchId: session.branch_id || 'main' }) });
});

sessionsRouter.put('/sessions/:id/state', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const next = req.body?.state;
  if (!next || typeof next !== 'object') return res.status(400).json({ error: { message: 'state object is required' } });
  const turnNo = req.body?.turn_no ?? getMaxTurnNo(session.id);
  setState(session.id, Number(turnNo), next, session.branch_id || 'main');
  res.json({ state: next, turn_no: Number(turnNo), branch: session.branch_id || 'main' });
});

sessionsRouter.get('/sessions/:id/scenes', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json({ scenes: getScenes(session.id, { branchId: session.branch_id || 'main', limit: 200 }) });
});

sessionsRouter.get('/sessions/:id/threads', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json({ threads: getThreads(session.id, { branchId: session.branch_id || 'main', limit: 100 }) });
});

/** 本局世界线的运行期变化（不是世界卡模板）。 */
sessionsRouter.get('/sessions/:id/world-state', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const branchId = session.branch_id || 'main';
  res.json({
    branch: branchId,
    world_version: session.world_version ?? null,
    changes: getWorldState(session.id, {
      branchId,
      atTurn: req.query.at_turn != null ? Number(req.query.at_turn) : getMaxTurnNo(session.id),
    }),
  });
});

sessionsRouter.get('/sessions/:id/voices', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const branchId = session.branch_id || 'main';
  // limit 可调（默认 100、上限 500），并回 total：面板要能说「共 N 条，显示最近 M 条」，
  // 而不是在 234 条样本上显示 100 却看不出被截断。
  const limit = Math.max(1, Math.min(500, intOr(req.query.limit, 100)));
  res.json({ voices: getVoices(session.id, { branchId, limit }), total: countVoices(session.id, { branchId }) });
});

sessionsRouter.post('/sessions/:id/voices/:voiceId/pin', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  setVoicePinned(session.id, Number(req.params.voiceId), !!req.body?.pinned);
  res.json({ voices: getVoices(session.id, { branchId: session.branch_id || 'main', limit: 100 }) });
});

sessionsRouter.delete('/sessions/:id/voices/:voiceId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  deleteVoice(session.id, Number(req.params.voiceId));
  res.json({ voices: getVoices(session.id, { branchId: session.branch_id || 'main', limit: 100 }) });
});

sessionsRouter.get('/sessions/:id/patches', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const branchId = session.branch_id || 'main';
  const status = req.query.status ? String(req.query.status) : null;
  const kind = req.query.kind ? String(req.query.kind) : null;
  const limit = Math.max(1, Math.min(500, intOr(req.query.limit, 100)));
  // total / counts 让面板能说「这一类共 N 条，显示最近 M 条」，
  // 而不是把 209 条待确认和 3 条矛盾混在一起静默截断到 100。
  // open_total / open_counts 是「还没处置的」计数：总览卡的待处理数必须用它，
  // 从前端拿到的这一页列表本地过滤会漏（实测报 22、实际 133）。
  res.json({
    patches: listPatches(session.id, { branchId, status, kind, limit }),
    total: countPatches(session.id, { branchId, status, kind }),
    counts: patchKindCounts(session.id, { branchId, status }),
    open_total: countPatches(session.id, { branchId, status: 'open', kind }),
    open_counts: patchKindCounts(session.id, { branchId, status: 'open' }),
  });
});

sessionsRouter.post('/sessions/:id/patches/:patchId/resolve', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const status = ['applied', 'dismissed'].includes(req.body?.status) ? req.body.status : 'dismissed';
  setPatchStatus(session.id, Number(req.params.patchId), status);
  res.json({ ok: true, status });
});

/* ------------------------------ 作者笔记 ------------------------------ */

sessionsRouter.get('/sessions/:id/notes', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json({ notes: getNotes(session.id, { activeOnly: false }) });
});

sessionsRouter.post('/sessions/:id/notes', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const { content, kind = 'note' } = req.body || {};
  if (!String(content || '').trim()) return res.status(400).json({ error: { message: 'content is required' } });
  const id = addNote(session.id, { content, kind, turn_no: getMaxTurnNo(session.id) });
  res.status(201).json({ id, notes: getNotes(session.id, { activeOnly: false }) });
});

sessionsRouter.patch('/sessions/:id/notes/:noteId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const ok = updateNote(session.id, Number(req.params.noteId), req.body || {});
  if (!ok) return res.status(404).json({ error: { message: 'note not found' } });
  res.json({ notes: getNotes(session.id, { activeOnly: false }) });
});

sessionsRouter.delete('/sessions/:id/notes/:noteId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  deleteNote(session.id, Number(req.params.noteId));
  res.json({ notes: getNotes(session.id, { activeOnly: false }) });
});

/* ------------------------------ 编辑 ------------------------------ */

sessionsRouter.patch('/sessions/:id/turns/:turnNo', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const turnNo = Number(req.params.turnNo);
  const kind = req.body?.kind === 'player' ? 'player' : 'narrator';
  const content = String(req.body?.content ?? '');
  if (!content.trim()) return res.status(400).json({ error: { message: 'content is required' } });
  if (!getTurn(session.id, turnNo, kind)) return res.status(404).json({ error: { message: 'turn not found' } });
  updateTurnContent(session.id, turnNo, kind, content);
  res.json({ turn: getTurn(session.id, turnNo, kind) });
});
