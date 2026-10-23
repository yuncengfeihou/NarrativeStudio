/**
 * server/routes/sessions.js — 剧情会话接口
 *
 * 会话属于一张世界卡（world_id）。设定主要活在世界卡里，会话只存运行期参数与进度。
 */
import { Router } from 'express';
import { config } from '../config.js';
import {
  createSessionWithSettings, getMemoryStats, getSessionSnapshot, runTurn,
} from '../agents/orchestrator.js';
import {
  addManualFact, addNote, deleteEntity, deleteFact, deleteNote, deleteSession, getDb,
  getEntities, getMaxTurnNo, getNotes, getSession, getState, getTurn, getTurns, getWorld,
  listSessions, setEntityPinned, setFactPinned, setState, truncateSession, updateEntity,
  updateNote, updateSession, updateTurnContent, deleteRelation, deleteThread, deleteReflection,
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
      branch_effort: config.agents.branch.reasoningEffort,
      memory_effort: config.agents.memory.reasoningEffort,
      arc_every: config.context.arcEvery,
      saga_every: config.context.sagaEvery,
      chronicle_every: config.context.chronicleEvery,
      reflect_every: config.context.reflectEvery,
      recent_raw_turns: config.context.recentRawTurns,
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
  const { title, settings, world_id: worldId, worldId: worldId2 } = req.body || {};
  const wid = worldId || worldId2 || null;
  const world = wid ? getWorld(wid) : null;
  if (wid && !world) return res.status(404).json({ error: { message: 'world not found' } });
  const card = world?.card || {};
  const session = createSessionWithSettings({
    title: title || card.title || '未命名剧情',
    worldId: wid,
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
  const { title, settings, world_id: worldId } = req.body || {};
  const patch = { title, settings };
  if (worldId !== undefined) patch.worldId = worldId;
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
  const kinds = typeof req.query.kinds === 'string'
    ? req.query.kinds.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const limit = Math.min(intOr(req.query.limit, 400), 2000);
  const rows = getTurns(session.id, { from, to, kinds });
  res.json({ turns: rows.slice(-limit), total: rows.length, from, to });
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
    generateBranches = true, isOpening = false,
  } = req.body || {};

  sseHead(res);
  const send = (evt) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`); };
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);

  const aborter = new AbortController();
  // 只监听 res 的 close：req 的 close 在请求体读完后就会触发，会误杀长回合
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });

  try {
    await runTurn({
      sessionId: session.id,
      playerText, images, branchChoice, generateBranches, isOpening,
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
    const { getRecentTurns, getWorld } = await import('../memory/store.js');
    const world = session.world_id ? getWorld(session.world_id) : null;
    const recent = getRecentTurns(session.id, 1).filter((t) => t.kind === 'narrator').pop();
    const st = getState(session.id);
    const result = await runBranchAgent({
      world,
      state: st?.state || null,
      recentNarrative: recent?.content || '',
      present: [],
      director: null,
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
  if (!playerRow && !narratorRow) {
    return res.status(404).json({ error: { message: 'turn not found' } });
  }

  sseHead(res);
  const send = (evt) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`); };
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
  const aborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });

  try {
    const removed = truncateSession(session.id, turnNo - 1);
    send({ type: 'rollback', turn_no: turnNo - 1, removed });
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

sessionsRouter.post('/sessions/:id/rollback', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const turnNo = Number(req.body?.turn_no);
  if (!Number.isInteger(turnNo) || turnNo < 0) {
    return res.status(400).json({ error: { message: 'turn_no must be a non-negative integer' } });
  }
  const removed = truncateSession(session.id, turnNo);
  res.json({ ...removed, turn_no: turnNo, memoryStats: getMemoryStats(session.id) });
});

/* ------------------------------ 记忆 ------------------------------ */

sessionsRouter.get('/sessions/:id/memory', (req, res) => {
  const stats = getMemoryStats(req.params.id);
  if (!stats) return res.status(404).json({ error: { message: 'session not found' } });
  res.json(stats);
});

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

sessionsRouter.patch('/sessions/:id/entities/:entityId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const id = Number(req.params.entityId);
  const body = req.body || {};
  if (body.pinned != null) setEntityPinned(session.id, id, !!body.pinned);
  if (body.name != null || body.summary != null || body.importance != null) {
    updateEntity(session.id, id, body);
  }
  res.json({ entities: getEntities(session.id, { limit: 200 }) });
});

sessionsRouter.delete('/sessions/:id/entities/:entityId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  deleteEntity(session.id, Number(req.params.entityId));
  res.json({ entities: getEntities(session.id, { limit: 200 }) });
});

sessionsRouter.post('/sessions/:id/facts', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const { subject, predicate, object } = req.body || {};
  if (!subject || !predicate || !object) {
    return res.status(400).json({ error: { message: 'subject/predicate/object are required' } });
  }
  const id = addManualFact(session.id, { subject, predicate, object, turn_no: getMaxTurnNo(session.id) });
  res.status(201).json({ id, facts: getMemoryStats(session.id)?.facts || [] });
});

sessionsRouter.patch('/sessions/:id/facts/:factId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  if (req.body?.pinned != null) setFactPinned(session.id, Number(req.params.factId), !!req.body.pinned);
  res.json({ facts: getMemoryStats(session.id)?.facts || [] });
});

sessionsRouter.delete('/sessions/:id/facts/:factId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  deleteFact(session.id, Number(req.params.factId), { hard: req.query.hard === '1' });
  res.json({ facts: getMemoryStats(session.id)?.facts || [] });
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

/* --------------------------- 关系/线索/反思 --------------------------- */

sessionsRouter.delete('/sessions/:id/relations/:relId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  deleteRelation(session.id, Number(req.params.relId));
  res.json({ ok: true });
});

sessionsRouter.delete('/sessions/:id/threads/:threadId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  deleteThread(session.id, Number(req.params.threadId));
  res.json({ ok: true });
});

sessionsRouter.delete('/sessions/:id/reflections/:refId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  deleteReflection(session.id, Number(req.params.refId));
  res.json({ ok: true });
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

  let rememorized = false;
  if (kind === 'narrator' && req.body?.rememorize !== false) {
    try {
      const { updateMemory } = await import('../agents/memory-agent.js');
      const playerRow = getTurn(session.id, turnNo, 'player');
      getDb().prepare(`DELETE FROM summaries WHERE session_id=? AND level=1 AND turn_from=? AND turn_to=?`)
        .run(session.id, turnNo, turnNo);
      const world = session.world_id ? getWorld(session.world_id) : null;
      await updateMemory({
        session, world, turnNo,
        playerText: playerRow?.content || '(开场)',
        narrative: content,
        branchChoice: playerRow?.branch_choice || null,
      });
      rememorized = true;
    } catch (err) {
      console.warn(`[turns] 重建记忆失败（第 ${turnNo} 轮）：${err.message}`);
    }
  }
  res.json({ turn: getTurn(session.id, turnNo, kind), rememorized });
});
