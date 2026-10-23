/**
 * server/routes/worlds.js — 世界卡接口（v4）
 *
 * 世界卡（World）= 可复用的世界沙盒：命题 / 宪章 / 卡司 / 辞书 / 时间线 / 可玩时间点。
 * 它描述世界，不描述故事——所以没有「幕结构」接口，也没有「键控词条」接口。
 *
 *   GET    /api/worlds                    -> 卡片摘要列表（含会话数）
 *   GET    /api/worlds/:id                -> 完整卡（card + codex + timeline + anchors）
 *   POST   /api/worlds                    -> 新建/覆盖（body = {id?, title, card, source?}）
 *   PATCH  /api/worlds/:id                -> 局部更新
 *   DELETE /api/worlds/:id                -> 删除
 *   GET    /api/worlds/:id/export         -> 卡的纯文本形态（给用户外带）
 *   POST   /api/worlds/:id/codex/:codexId/pin -> 钉选/取消钉选一条辞书
 *   POST   /api/worlds/:id/sessions       -> 从这张卡开一局（可指定 anchorId）
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  deleteWorld, getCodex, getWorld, listSessions, listWorlds, saveWorld, setCodexPinned,
} from '../memory/store.js';
import { normalizeCard, renderCardText } from '../world/schema.js';
import { createSessionWithSettings } from '../agents/orchestrator.js';

export const worldsRouter = Router();

/** 从卡片生成会话的初始 settings。 */
function settingsFromWorld(world, overrides = {}) {
  const card = normalizeCard(world.card || {});
  return {
    world_id: world.id,
    title: overrides.title || card.title || world.title,
    narrator_effort: overrides.narrator_effort || 'high',
    context_max_tokens: overrides.context_max_tokens || 200000,
    style_tags: card.genre,
    ...overrides,
  };
}

worldsRouter.get('/worlds', (req, res) => {
  const rows = listWorlds();
  res.json(rows.map((w) => {
    const card = normalizeCard(w.card || {});
    return {
      id: w.id,
      title: w.title,
      subtitle: w.subtitle,
      cover_hue: w.cover_hue,
      tags: w.tags,
      session_count: w.session_count,
      updated_at: w.updated_at,
      card: {
        title: card.title,
        subtitle: card.subtitle,
        kind: card.kind,
        genre: card.genre,
        premise: card.prompt.premise,
        cast: card.cast.map((c) => ({ id: c.id, name: c.name, role: c.role, one_line: c.one_line })),
        player: card.player.name ? { name: card.player.name, identity: card.player.identity, mode: card.player.mode } : null,
        charter_count: card.charter.length,
        codex_count: card.codex.length,
        timeline_past: card.timeline.filter((t) => t.canon === 'past').length,
        timeline_future: card.timeline.filter((t) => t.canon === 'future').length,
        anchors: card.anchors.map((a) => ({ id: a.id, label: a.label })),
      },
      source: w.source,
    };
  }));
});

worldsRouter.get('/worlds/:id', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  res.json({
    ...world,
    card: normalizeCard(world.card || {}),
    codex: getCodex(world.id),
    sessions: listSessions({ worldId: world.id }),
  });
});

worldsRouter.get('/worlds/:id/export', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  res.type('text/plain; charset=utf-8').send(renderCardText(world.card || {}));
});

worldsRouter.post('/worlds', (req, res) => {
  const body = req.body || {};
  const rawCard = body.card || {};
  if (!rawCard.title && !body.title) {
    return res.status(400).json({ error: { message: 'card.title is required' } });
  }
  const card = normalizeCard({ ...rawCard, title: rawCard.title || body.title });
  const id = body.id || slugify(card.title);
  const world = saveWorld({
    id,
    title: body.title || card.title,
    subtitle: body.subtitle || card.subtitle || '',
    coverHue: body.cover_hue ?? rawCard.cover_hue ?? 210,
    tags: body.tags || card.tags,
    card,
    source: body.source || card.source || null,
  });
  res.status(201).json({ ...world, codex: getCodex(world.id) });
});

worldsRouter.patch('/worlds/:id', (req, res) => {
  const existing = getWorld(req.params.id);
  if (!existing) return res.status(404).json({ error: { message: 'world not found' } });
  const body = req.body || {};
  const merged = body.card ? { ...normalizeCard(existing.card || {}), ...body.card } : (existing.card || {});
  const card = normalizeCard(merged);
  const world = saveWorld({
    id: existing.id,
    title: body.title ?? existing.title,
    subtitle: body.subtitle ?? existing.subtitle,
    coverHue: body.cover_hue ?? existing.cover_hue,
    tags: body.tags ?? existing.tags,
    card,
    source: body.source ?? existing.source,
  });
  res.json({ ...world, codex: getCodex(world.id) });
});

worldsRouter.delete('/worlds/:id', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  deleteWorld(world.id);
  res.json({ deleted: world.id });
});

/* ------------------------------ 辞书钉选 ------------------------------ */

worldsRouter.post('/worlds/:id/codex/:codexId/pin', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  const pinned = !!req.body?.pinned;
  setCodexPinned(world.id, req.params.codexId, pinned);
  res.json({ codex: getCodex(world.id) });
});

/* ------------------------------- 开局 -------------------------------- */

worldsRouter.post('/worlds/:id/sessions', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  const card = normalizeCard(world.card || {});
  const body = req.body || {};
  const anchorId = body.anchor_id || card.anchors[0]?.id || null;
  if (body.anchor_id && !card.anchors.some((a) => a.id === body.anchor_id)) {
    return res.status(400).json({ error: { message: `unknown anchor: ${body.anchor_id}` } });
  }
  const title = body.title || `${card.title} · ${card.anchors.find((a) => a.id === anchorId)?.label || '序章'}`;
  const session = createSessionWithSettings({
    title,
    worldId: world.id,
    anchorId,
    settings: settingsFromWorld(world, body.settings || {}),
  });
  res.status(201).json(session);
});

function slugify(s) {
  const base = String(s || '').trim().toLowerCase();
  const ascii = base.replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii || `world-${randomUUID().slice(0, 8)}`;
}
