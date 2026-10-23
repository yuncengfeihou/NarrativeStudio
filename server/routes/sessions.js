/**
 * Native application API (drives the iOS-style web client).
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import {
  getSessionSnapshot, getMemoryStats, runTurn,
  createSessionWithSettings,
} from '../agents/orchestrator.js';
import {
  listSessions, updateSession, deleteSession, getSession, getMaxTurnNo, getDb,
  getTurns, addNote, getNotes, updateNote, deleteNote,
  setEntityPinned, updateEntity, deleteEntity,
  setFactPinned, deleteFact, addManualFact,
  getTurn, updateTurnContent, truncateSession, getState, setState, getEntities,
} from '../memory/store.js';

export const sessionsRouter = Router();

/** 解析整数查询参数 */
function intOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Public config for the frontend. */
sessionsRouter.get('/config', (req, res) => {
  res.json({
    models: {
      default: config.upstream.model,
      reasoning_efforts: ['low', 'medium', 'high'],
    },
    defaults: {
      narrator_effort: config.agents.narrator.reasoningEffort,
      branch_effort: config.agents.branch.reasoningEffort,
      context_max_tokens: config.context.maxTokens,
      recent_raw_turns: config.context.recentRawTurns,
      arc_every: config.context.arcEvery,
      saga_every: config.context.sagaEvery,
    },
    limits: {
      context_max_tokens: config.context.maxTokens,
      narrator_max_tokens: config.agents.narrator.maxTokens,
    },
  });
});

sessionsRouter.get('/sessions', (req, res) => {
  const rows = getDb().prepare(`
    SELECT s.*,
      (SELECT content FROM turns t WHERE t.session_id = s.id AND t.kind = 'narrator'
       ORDER BY t.turn_no DESC, t.id DESC LIMIT 1) AS last_narrative
    FROM sessions s ORDER BY s.updated_at DESC
  `).all();
  const sessions = rows.map(r => {
    const settings = JSON.parse(r.settings_json);
    return {
      id: r.id,
      title: r.title,
      turn_count: r.turn_count,
      updated_at: r.updated_at,
      created_at: r.created_at,
      style_tags: settings?.style_tags || [],
      characters: (settings?.characters || []).map(c => ({ name: c.name, role: c.role })),
      last_message: r.last_narrative || null,
    };
  });
  res.json(sessions);
});

sessionsRouter.post('/sessions', (req, res) => {
  const { title, settings } = req.body || {};
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: { message: 'settings is required' } });
  }
  const session = createSessionWithSettings({ title, settings });
  res.status(201).json(session);
});

sessionsRouter.get('/sessions/:id', (req, res) => {
  const snapshot = getSessionSnapshot(req.params.id);
  if (!snapshot) return res.status(404).json({ error: { message: 'session not found' } });
  res.json(snapshot);
});

/**
 * 分页读取回合（长会话用；?from=&to=&kinds=player,narrator）。
 * 前端「回到顶部加载更早」与「跳转到第 N 轮」都走这里。
 */
sessionsRouter.get('/sessions/:id/turns', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const from = intOr(req.query.from, 1);
  const to = intOr(req.query.to, Number.MAX_SAFE_INTEGER);
  const kinds = typeof req.query.kinds === 'string'
    ? req.query.kinds.split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const limit = Math.min(intOr(req.query.limit, 400), 2000);
  const rows = getTurns(session.id, { from, to, kinds });
  res.json({ turns: rows.slice(-limit), total: rows.length, from, to });
});

/** 搜索整个会话的原文（回合级全文检索，带上下文高亮片段）。 */
sessionsRouter.get('/sessions/:id/search', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ hits: [] });
  const rows = getDb().prepare(
    `SELECT turn_no, kind, content, created_at FROM turns
     WHERE session_id=? AND content LIKE ? ORDER BY turn_no ASC LIMIT 120`
  ).all(session.id, `%${q}%`);
  const hits = rows.map(r => {
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

sessionsRouter.patch('/sessions/:id', (req, res) => {
  const { title, settings } = req.body || {};
  const session = updateSession(req.params.id, { title, settings });
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json(session);
});

sessionsRouter.delete('/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  deleteSession(req.params.id);
  res.json({ deleted: req.params.id });
});

/**
 * Run a turn with SSE streaming.
 * Event protocol: see docs/CONTRACTS.md — each SSE `data:` line is one JSON event.
 *
 * 取消传播：监听 res 的 close（客户端断开时 writableEnded 仍为 false）。
 * 注意不要监听 req 的 close —— 请求体读取完成即触发，会误杀进行中的长回合。
 */
sessionsRouter.post('/sessions/:id/turn', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });

  const {
    playerText = '', images = null, branchChoice = null,
    generateBranches = true, isOpening = false,
  } = req.body || {};

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (evt) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  // heartbeat keeps proxies from closing idle connections during long LLM calls
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);

  const aborter = new AbortController();
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

/** Regenerate branch options (non-streaming JSON). */
sessionsRouter.post('/sessions/:id/branches', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  try {
    const { runBranchAgent } = await import('../agents/branch.js');
    const { getRecentTurns } = await import('../memory/store.js');
    const { assembleContext } = await import('../memory/assembler.js');
    const recent = getRecentTurns(session.id, 1).filter(t => t.kind === 'narrator').pop();
    const context = await assembleContext({
      session, turnNo: getMaxTurnNo(session.id), playerText: '', images: null, branchChoice: null,
    });
    const result = await runBranchAgent({
      session, context, recentNarrative: recent?.content || '',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * 重写指定回合的旁白：以该轮玩家行动 + 回滚到该轮之前的状态为输入，重新演绎。
 * SSE 事件协议与 /turn 一致；body: {turn_no, guidance?}
 * guidance 可选，作为「改稿方向」注入（例如「更压抑一些，不要出现新角色」）。
 */
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (evt) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`); };
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
  const aborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });

  try {
    // 先回滚到该轮之前（保留 1..turnNo-1），再以同一玩家行动重跑一轮
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

/** Memory system panel data. */
sessionsRouter.get('/sessions/:id/memory', (req, res) => {
  const stats = getMemoryStats(req.params.id);
  if (!stats) return res.status(404).json({ error: { message: 'session not found' } });
  res.json(stats);
});

/* ------------------------------------------------------------------ */
/* 记忆编辑：笔记 / 实体 / 事实 / 状态                                  */
/* ------------------------------------------------------------------ */

/** 读取作者笔记（含已停用）。 */
sessionsRouter.get('/sessions/:id/notes', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  res.json({ notes: getNotes(session.id, { activeOnly: false }) });
});

/** 新增作者笔记。body: {content, kind?} */
sessionsRouter.post('/sessions/:id/notes', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const { content, kind = 'note' } = req.body || {};
  if (!String(content || '').trim()) return res.status(400).json({ error: { message: 'content is required' } });
  const id = addNote(session.id, { content, kind, turn_no: getMaxTurnNo(session.id) });
  res.status(201).json({ id, notes: getNotes(session.id, { activeOnly: false }) });
});

/** 修改 / 启停笔记。 */
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

/** 固定 / 取消固定实体。body: {pinned:boolean} */
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

/** 新增 / 固定 / 撤回事实。 */
sessionsRouter.post('/sessions/:id/facts', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const { subject, predicate, object } = req.body || {};
  if (!subject || !predicate || !object) {
    return res.status(400).json({ error: { message: 'subject/predicate/object are required' } });
  }
  const id = addManualFact(session.id, {
    subject, predicate, object, turn_no: getMaxTurnNo(session.id),
  });
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

/** 人工改写当前剧情状态快照（修正跑偏的时间/地点/物品等）。 */
sessionsRouter.put('/sessions/:id/state', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const next = req.body?.state;
  if (!next || typeof next !== 'object') return res.status(400).json({ error: { message: 'state object is required' } });
  const turnNo = req.body?.turn_no ?? getMaxTurnNo(session.id);
  setState(session.id, Number(turnNo), next);
  res.json({ state: next, turn_no: Number(turnNo) });
});

/* ------------------------------------------------------------------ */
/* 剧情编辑：改写 / 回滚 / 重新生成                                      */
/* ------------------------------------------------------------------ */

/** 改写某一轮玩家行动或旁白正文（人工校订，之后记忆以新文本为准）。 */
sessionsRouter.patch('/sessions/:id/turns/:turnNo', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });
  const turnNo = Number(req.params.turnNo);
  const kind = req.body?.kind === 'player' ? 'player' : 'narrator';
  const content = String(req.body?.content ?? '');
  if (!content.trim()) return res.status(400).json({ error: { message: 'content is required' } });
  if (!getTurn(session.id, turnNo, kind)) return res.status(404).json({ error: { message: 'turn not found' } });
  updateTurnContent(session.id, turnNo, kind, content);

  // 旁白被人工改写后，用新正文重建该轮记忆，避免记忆与正文长期分叉
  let rememorized = false;
  if (kind === 'narrator' && req.body?.rememorize !== false) {
    try {
      const { updateMemory } = await import('../agents/memory-agent.js');
      const playerRow = getTurn(session.id, turnNo, 'player');
      const d = getDb();
      d.prepare(`DELETE FROM summaries WHERE session_id=? AND level=1 AND turn_from=? AND turn_to=?`)
        .run(session.id, turnNo, turnNo);
      await updateMemory({
        session, turnNo,
        playerText: playerRow?.content || '(开场)',
        narrative: content,
        branchChoice: playerRow?.branch_choice || null,
      });
      rememorized = true;
    } catch (err) {
      console.warn(`[turns] 重建记忆失败（turn ${turnNo}）：${err.message}`);
    }
  }
  res.json({ turn: getTurn(session.id, turnNo, kind), rememorized });
});

/**
 * 回滚到第 N 轮（保留含 N 轮）：删除其后的回合及其派生记忆。
 * 用于「剧情走歪了，退回重来」。
 */
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

/**
 * Generate (or regenerate) the opening narrative for an empty session.
 * Same SSE protocol as /turn.
 */
sessionsRouter.post('/sessions/:id/opening', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: { message: 'session not found' } });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (evt) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
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
