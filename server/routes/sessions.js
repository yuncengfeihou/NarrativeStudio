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
} from '../memory/store.js';

export const sessionsRouter = Router();

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

/** Memory system panel data. */
sessionsRouter.get('/sessions/:id/memory', (req, res) => {
  const stats = getMemoryStats(req.params.id);
  if (!stats) return res.status(404).json({ error: { message: 'session not found' } });
  res.json(stats);
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
