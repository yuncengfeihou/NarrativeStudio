/**
 * server/routes/smith.js — 制卡流水线接口（Card Smith）
 *
 * 把一部小说/设定素材抽成一张 v4 世界卡。这是长任务：
 *   POST /api/smith/run     开始抽取（SSE 进度）
 *   POST /api/smith/preview 只跑前 N 章，返回卡草案（不落库）
 *   POST /api/smith/save    把卡草案存成世界卡
 *
 * 默认素材目录：素材/（用户自己的小说）。
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCard } from '../world/schema.js';
import { saveWorld, getWorld } from '../memory/store.js';
import { readChapters, smithCard } from '../agents/card-smith.js';

export const smithRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATERIALS_DIR = path.resolve(__dirname, '..', '..', '素材');

/** 列出可用的素材目录。 */
smithRouter.get('/smith/materials', (req, res) => {
  if (!fs.existsSync(MATERIALS_DIR)) return res.json({ materials: [] });
  const out = [];
  for (const name of fs.readdirSync(MATERIALS_DIR)) {
    const dir = path.join(MATERIALS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    try {
      const chapters = readChapters(dir);
      if (!chapters.length) continue;
      out.push({
        name,
        chapters: chapters.length,
        chars: chapters.reduce((s, c) => s + c.text.length, 0),
        first: chapters[0].title,
        last: chapters[chapters.length - 1].title,
      });
    } catch { /* 跳过读不出来的目录 */ }
  }
  res.json({ materials: out });
});

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/** 只跑前 N 章，返回卡草案（不落库）。 */
smithRouter.post('/smith/preview', async (req, res) => {
  const body = req.body || {};
  const dir = String(body.dir || '');
  if (!dir) return res.status(400).json({ error: { message: 'dir is required' } });
  const abs = path.resolve(MATERIALS_DIR, dir);
  if (!abs.startsWith(MATERIALS_DIR) || !fs.existsSync(abs)) {
    return res.status(400).json({ error: { message: 'dir must be inside 素材/' } });
  }

  sseHead(res);
  const send = (evt) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`); };
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
  const aborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) aborter.abort(); });

  try {
    const out = await smithCard({
      dir: abs,
      title: String(body.title || path.basename(dir)),
      premise: String(body.premise || ''),
      maxChapters: Number(body.max_chapters) || 3,
      concurrency: Number(body.concurrency) || 3,
      startAt: Number(body.start_at) || 1,
      openingSeed: String(body.opening_seed || ''),
      player: body.player || null,
      onProgress: (p) => send({ type: 'progress', ...p }),
      signal: aborter.signal,
    });
    send({ type: 'done', card: out.card, stats: out.stats });
  } catch (err) {
    send({ type: 'error', message: err.message || String(err) });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

/** 把卡草案存成世界卡。 */
smithRouter.post('/smith/save', (req, res) => {
  const body = req.body || {};
  const card = normalizeCard(body.card || {});
  if (!card.title) return res.status(400).json({ error: { message: 'card.title is required' } });
  const id = String(body.id || card.title).replace(/[^a-zA-Z0-9_-]/g, '-') || `world-${Date.now()}`;
  if (getWorld(id)) return res.status(409).json({ error: { message: `world already exists: ${id}` } });
  const world = saveWorld({
    id,
    title: card.title,
    subtitle: card.subtitle,
    tags: body.tags || card.tags || [],
    card,
    source: body.source || card.source || null,
  });
  res.status(201).json(world);
});
