/**
 * server/routes/sessions.js — 剧情会话接口（v4）
 *
 * 会话属于一张世界卡（world_id）。设定活在世界卡里，会话只存运行期参数与进度。
 * 记忆相关的读写全部走 v4 的表：scenes / assertions / character_states / voices / patches / branches。
 */
import { Router } from 'express';
import { config } from '../config.js';
import {
  auditSession, createSessionWithSettings, forkSession, getMemoryStats, getSessionSnapshot,
  recallSession, runTurn,
} from '../agents/orchestrator.js';
import {
  addAssertion, addNote, deleteNote, deleteSession, deleteVoice, getAssertions,
  getCharStates, getDb, getMaxTurnNo, getNotes, getScenes, getSession, getState, getThreads,
  getTurnsForBranch, getTurn, getVoices, getWorld, listBranches, listPatches, listSessions,
  retractAssertion, setPatchStatus, setState, setVoicePinned, updateNote, updateSession,
  updateTurnContent,
} from '../memory/store.js';

export const sessionsRouter = Router();

function intOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/* ------------------------------ 配置 ------------------------------ */

sessionsRouter.get('/config', (req, res) => {
  res.json({
    models: {
      default: config.upstream.model,
      reasoning_efforts: ['low', 'medium', 'high'],
    },
    defaults: {
      narrator_effort: config.agents.narrator.reasoningEffort,
      archivist_effort: config.agents.archivist.reasoningEffort,
      branch_effort: config.agents.branch.reasoningEffort,
      recent_raw_turns: config.context.recentRawTurns,
      continuity_every: config.context.continuityEvery,
      world_tick_every: config.context.worldTickEvery,
    },
    limits: {
      context_max_tokens: config.context.maxTokens,
      context_soft_tokens: config.context.softTokens,
      narrator_max_tokens: config.agents.narrator.maxTokens,
    },
    budget: config.context.layerBudget,
  });
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
  const session = createSessionWithSettings({
    title: title || card.title || '未命名剧情',
    worldId: wid,
    anchorId: anchor_id || null,
    settings: {
      title: title || card.title || '未命名剧情',
      narrator_effort: 'high',
      context_max_tokens: config.context.maxTokens,
      style_tags: card.genre || [],
      ...(settings || {}),
    },
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
    const st = getState(session.id);
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
    const fork = forkSession({ sessionId: session.id, toTurn: turnNo - 1, note: `重写第 ${turnNo} 轮` });
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
sessionsRouter.post('/sessions/:id/rollback', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const turnNo = Number(req.body?.turn_no);
  if (!Number.isInteger(turnNo) || turnNo < 0) {
    return res.status(400).json({ error: { message: 'turn_no must be a non-negative integer' } });
  }
  const fork = forkSession({ sessionId: session.id, toTurn: turnNo, note: `回到第 ${turnNo} 轮` });
  res.json({ ...fork, turn_no: turnNo, memoryStats: getMemoryStats(session.id) });
});

sessionsRouter.get('/sessions/:id/branches', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json({ branches: listBranches(session.id), current: session.branch_id || 'main' });
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
  setState(session.id, Number(turnNo), next);
  res.json({ state: next, turn_no: Number(turnNo) });
});

sessionsRouter.get('/sessions/:id/scenes', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json({ scenes: getScenes(session.id, { branchId: session.branch_id || 'main', limit: 200 }) });
});

sessionsRouter.get('/sessions/:id/threads', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json({ threads: getThreads(session.id, { limit: 100 }) });
});

sessionsRouter.get('/sessions/:id/voices', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json({ voices: getVoices(session.id, { branchId: session.branch_id || 'main', limit: 100 }) });
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
  res.json({
    patches: listPatches(session.id, {
      branchId: session.branch_id || 'main',
      status: req.query.status ? String(req.query.status) : null,
      limit: 100,
    }),
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
