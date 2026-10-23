/**
 * server/routes/worlds.js — 世界卡接口
 *
 * 世界卡（World）= 可复用的设定总集：宪章 / 卡司 / 主角 / 幕结构 / 词条库 / 开场种子。
 * 一张世界卡可以派生任意多个剧情会话（sessions.world_id）。
 *
 *   GET    /api/worlds                    -> 卡片摘要列表（含会话数）
 *   GET    /api/worlds/:id                -> 完整卡（card + lore entries）
 *   POST   /api/worlds                    -> 新建/覆盖（body = {id?, title, card, lore, tags…}）
 *   PATCH  /api/worlds/:id                -> 局部更新
 *   DELETE /api/worlds/:id                -> 删除（会话的 world_id 置空，不级联删会话）
 *
 *   POST   /api/worlds/:id/lore           -> 新增词条
 *   PATCH  /api/worlds/:id/lore/:entryId  -> 修改词条
 *   DELETE /api/worlds/:id/lore/:entryId  -> 删除词条
 *   POST   /api/worlds/:id/sessions       -> 从这张卡开一局（可带 title / 起始幕）
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  addLore, deleteLore, deleteWorld, getLore, getWorld, listSessions, listWorlds,
  replaceLore, updateLore, upsertWorld,
} from '../memory/store.js';
import { createSessionWithSettings } from '../agents/orchestrator.js';

export const worldsRouter = Router();

/** 从卡片生成会话的初始 settings（大部分设定已进世界卡，这里只留运行期参数）。 */
function settingsFromWorld(world, overrides = {}) {
  const card = world.card || {};
  return {
    world_id: world.id,
    title: overrides.title || card.title || world.title,
    narrator_effort: overrides.narrator_effort || 'high',
    context_max_tokens: overrides.context_max_tokens || 200000,
    style_tags: Array.isArray(card.genre) ? card.genre : [],
    ...overrides,
  };
}

worldsRouter.get('/worlds', (req, res) => {
  const rows = listWorlds();
  res.json(rows.map((w) => ({
    id: w.id,
    title: w.title,
    subtitle: w.subtitle,
    cover_hue: w.cover_hue,
    tags: w.tags,
    session_count: w.session_count,
    updated_at: w.updated_at,
    card: {
      title: w.card?.title || w.title,
      subtitle: w.card?.subtitle || w.subtitle,
      genre: w.card?.genre || [],
      cast: (w.card?.cast || []).map((c) => ({ name: c.name, role: c.role, one_line: c.one_line, avatar_hue: c.avatar_hue })),
      player: w.card?.player ? { name: w.card.player.name, identity: w.card.player.identity } : null,
      arc_count: Array.isArray(w.card?.arcs) ? w.card.arcs.length : 0,
      charter_count: Array.isArray(w.card?.charter) ? w.card.charter.length : 0,
      opening_seed: String(w.card?.opening_seed || '').slice(0, 160),
    },
    source: w.source,
  })));
});

worldsRouter.get('/worlds/:id', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  res.json({
    ...world,
    lore: getLore(world.id, { enabledOnly: false }),
    sessions: listSessions({ worldId: world.id }),
  });
});

worldsRouter.post('/worlds', (req, res) => {
  const body = req.body || {};
  const card = body.card || {};
  if (!card.title && !body.title) {
    return res.status(400).json({ error: { message: 'card.title is required' } });
  }
  const id = body.id || slugify(card.title || body.title);
  const world = upsertWorld({
    id,
    title: body.title || card.title,
    subtitle: body.subtitle || card.subtitle || '',
    coverHue: body.cover_hue ?? card.cover_hue ?? 210,
    tags: body.tags || card.genre || [],
    card: { ...card, title: card.title || body.title },
    source: body.source || null,
  });
  if (Array.isArray(body.lore)) {
    // 只有在显式提供了 lore 数组时才整批替换，避免局部更新误删词条
    replaceLore(id, body.lore);
  }
  res.status(201).json({
    ...getWorld(world.id),
    lore: getLore(world.id, { enabledOnly: false }),
  });
});

worldsRouter.patch('/worlds/:id', (req, res) => {
  const existing = getWorld(req.params.id);
  if (!existing) return res.status(404).json({ error: { message: 'world not found' } });
  const body = req.body || {};
  const card = body.card ? { ...existing.card, ...body.card } : existing.card;
  const world = upsertWorld({
    id: existing.id,
    title: body.title ?? existing.title,
    subtitle: body.subtitle ?? existing.subtitle,
    coverHue: body.cover_hue ?? existing.cover_hue,
    tags: body.tags ?? existing.tags,
    card,
    source: body.source ?? existing.source,
  });
  res.json({ ...world, lore: getLore(world.id, { enabledOnly: false }) });
});

worldsRouter.delete('/worlds/:id', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  deleteWorld(world.id);
  res.json({ deleted: world.id });
});

/* ------------------------------- 词条 ------------------------------- */

worldsRouter.post('/worlds/:id/lore', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  const entry = req.body || {};
  if (!String(entry.content || '').trim()) {
    return res.status(400).json({ error: { message: 'content is required' } });
  }
  const id = addLore(world.id, entry);
  res.status(201).json({ id, lore: getLore(world.id, { enabledOnly: false }) });
});

worldsRouter.patch('/worlds/:id/lore/:entryId', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  const ok = updateLore(world.id, Number(req.params.entryId), req.body || {});
  if (!ok) return res.status(404).json({ error: { message: 'entry not found' } });
  res.json({ lore: getLore(world.id, { enabledOnly: false }) });
});

worldsRouter.delete('/worlds/:id/lore/:entryId', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  deleteLore(world.id, Number(req.params.entryId));
  res.json({ lore: getLore(world.id, { enabledOnly: false }) });
});

/* ------------------------------ 开局 ------------------------------- */

worldsRouter.post('/worlds/:id/sessions', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  const body = req.body || {};
  const title = body.title || `${world.title} · ${new Date().toLocaleDateString('zh-CN')}`;
  const session = createSessionWithSettings({
    title,
    worldId: world.id,
    settings: settingsFromWorld(world, body.settings || {}),
  });
  res.status(201).json(session);
});

function slugify(s) {
  const base = String(s || '').trim().toLowerCase();
  const ascii = base.replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii || `world-${randomUUID().slice(0, 8)}`;
}
