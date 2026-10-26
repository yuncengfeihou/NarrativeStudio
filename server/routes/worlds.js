/**
 * server/routes/worlds.js — 世界卡接口（v5）
 *
 * 世界卡（World）= 可复用的世界沙盒：故事方向 / 世界规则 / 实体（人物 + 世界事实）/
 * 时间线 / 开局点。它描述世界，不描述故事——所以没有「幕结构」接口，也没有「键控词条」接口。
 *
 *   GET    /api/worlds                    -> 卡片摘要列表（含会话数、persons/entity_count/fact_count）
 *   GET    /api/worlds/:id                -> 完整卡（card + entities + sessions）
 *   POST   /api/worlds                    -> 新建/覆盖（body = {id?, title, card, source?}）
 *   PATCH  /api/worlds/:id                -> 局部更新
 *   DELETE /api/worlds/:id                -> 删除
 *   GET    /api/worlds/:id/export         -> 卡的纯文本形态（给用户外带）
 *   POST   /api/worlds/:id/entities/:entityId/pin -> 固定带出/取消固定带出
 *   POST   /api/worlds/:id/sessions       -> 从这张卡开一局（可指定 anchorId）
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  deleteWorld, getEntities, getLatestSessionSettings, getWorld, listSessions, listWorlds, saveWorld,
  setEntityPinned,
} from '../memory/store.js';
import { normalizeCard, renderCardText } from '../world/schema.js';
import { lintCard } from '../world/lint.js';
import { createSessionWithSettings } from '../agents/orchestrator.js';
import { currentPlan } from '../memory/context-plan.js';
import { normalizeCraftSettings, pickCraftSettings, pickCraftHint } from '../world/craft.js';

export const worldsRouter = Router();

/**
 * 同一张卡上一局用过的工艺设置。
 *
 * 「再开一局」是这张卡的常见操作，而工艺（文风/对白/推进）是这张卡的写法偏好、
 * 不是某一局的偶然参数——每局都退回默认等于让用户每次重新选一遍。
 * 只继承三个工艺轴，设备参数（温度/预算/指令）不跨局继承。
 */
function inheritedCraft(worldId) {
  const prev = getLatestSessionSettings(worldId);
  return prev ? pickCraftSettings(prev) : {};
}

/** 从卡片生成会话的初始 settings。 */
function settingsFromWorld(world, overrides = {}) {
  const card = normalizeCard(world.card || {});
  // 会话级上限默认取「提示词硬上限」（窗口 − 生成预留 − 安全余量），而不是整个模型窗口；
  // 否则会话设置里会存一个装配层还要再扣一次的数字。显式值只能在这个上限内收紧。
  const cap = currentPlan().hardMax;
  const settings = {
    world_id: world.id,
    title: overrides.title || card.title || world.title,
    narrator_effort: overrides.narrator_effort || 'high',
    style_tags: card.genre,
    // 工艺层三层兜底，优先级从低到高：卡的默认写法 → 上一局的写法 → 本次显式传入。
    // 卡级默认回答「这张卡适合怎么写」，上一局回答「你上次为这张卡选了什么」——
    // 后者是用户的选择，应当压过卡的默认；两者都缺才由归一函数补程序默认。
    ...pickCraftHint(card.craft),
    ...inheritedCraft(world.id),
    ...overrides,
  };
  // 工艺层取值归一：非法值不静默落库。缺省轴在这里补齐（开局要有确定值），
  // 与 `POST /api/sessions` 走同一个函数，避免两条开局路径对「什么算合法」分叉。
  // `defaults` 传卡级默认：某一轴既没继承也没显式给时，落到这张卡自己偏好的写法。
  Object.assign(settings, normalizeCraftSettings(settings, { fill: true, defaults: card.craft }));
  // 会话级上限只能是模型窗口内的一次收窄；超过窗口按窗口处理（装配层还会再 clamp）。
  const requested = Number(settings.context_max_tokens);
  settings.context_max_tokens = Number.isFinite(requested) && requested > 0 ? Math.min(requested, cap) : cap;
  return settings;
}

/**
 * 实体投影给前端的形状。投影表由 saveWorld 从 card_json 同步，pinned/muted 都在表里；
 * 还在卡片里编辑的字段（facets/detail 等）由编辑器整卡保存，不单开 PATCH 接口。
 */
function entitiesView(world) {
  return getEntities(world.id).map((e) => ({
    id: e.entity_id,
    type: e.type,
    name: e.name,
    aliases: e.aliases,
    tags: e.tags,
    summary: e.summary,
    facets: e.facets,
    links: e.links,
    reveal: e.reveal,
    canon_from: e.canon_from,
    detail: e.detail,
    pinned: e.pinned,
    muted: e.muted,
    parent_id: e.parent_id,
  }));
}

worldsRouter.get('/worlds', (req, res) => {
  const rows = listWorlds();
  res.json(rows.map((w) => {
    const card = normalizeCard(w.card || {});
    const persons = card.entities.filter((e) => e.type === 'person');
    const factCount = card.entities.length - persons.length;
    return {
      id: w.id,
      title: w.title,
      subtitle: w.subtitle,
      cover_hue: w.cover_hue,
      tags: w.tags,
      session_count: w.session_count,
      updated_at: w.updated_at,
      // 列表页只需要人物与计数，别把整张卡推给前端。
      persons: persons.map((p) => ({ id: p.id, name: p.name, role: p.role, summary: p.summary })),
      entity_count: card.entities.length,
      fact_count: factCount,
      card: {
        title: card.title,
        subtitle: card.subtitle,
        kind: card.kind,
        genre: card.genre,
        premise: card.prompt.premise,
        player: card.player.name ? { name: card.player.name, identity: card.player.identity, mode: card.player.mode } : null,
        charter_count: card.charter.length,
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
    entities: entitiesView(world),
    sessions: listSessions({ worldId: world.id }),
  });
});

/** 卡级静态体检：断链、别名冲突、包含环、孤立辞书、单值声明冲突。 */
worldsRouter.get('/worlds/:id/lint', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  res.json(lintCard(normalizeCard(world.card || {})));
});

worldsRouter.get('/worlds/:id/export', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  res.type('text/plain; charset=utf-8').send(renderCardText(world.card || {}));
});

/** 保存前的内容体检：blocker 拒绝保存（422），其余只报告。 */
function blockingIssues(card) {
  return lintCard(card).issues.filter((issue) => issue.severity === 'blocker');
}

worldsRouter.post('/worlds', (req, res) => {
  const body = req.body || {};
  const rawCard = body.card || {};
  if (!rawCard.title && !body.title) {
    return res.status(400).json({ error: { message: 'card.title is required' } });
  }
  const card = normalizeCard({ ...rawCard, title: rawCard.title || body.title });
  const blockers = blockingIssues(card);
  if (blockers.length) {
    return res.status(422).json({
      error: { message: `卡片存在 ${blockers.length} 个阻断性问题，无法保存`, issues: blockers },
    });
  }
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
  res.status(201).json({ ...world, entities: entitiesView(world) });
});

worldsRouter.patch('/worlds/:id', (req, res) => {
  const existing = getWorld(req.params.id);
  if (!existing) return res.status(404).json({ error: { message: 'world not found' } });
  const body = req.body || {};
  const merged = body.card ? { ...normalizeCard(existing.card || {}), ...body.card } : (existing.card || {});
  const card = normalizeCard(merged);
  const blockers = blockingIssues(card);
  if (blockers.length) {
    return res.status(422).json({
      error: { message: `卡片存在 ${blockers.length} 个阻断性问题，无法保存`, issues: blockers },
    });
  }
  const world = saveWorld({
    id: existing.id,
    title: body.title ?? existing.title,
    subtitle: body.subtitle ?? existing.subtitle,
    coverHue: body.cover_hue ?? existing.cover_hue,
    tags: body.tags ?? existing.tags,
    card,
    source: body.source ?? existing.source,
  });
  res.json({ ...world, entities: entitiesView(world) });
});

worldsRouter.delete('/worlds/:id', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  deleteWorld(world.id);
  res.json({ deleted: world.id });
});

/* ------------------------------ 固定带出 ------------------------------ */

worldsRouter.post('/worlds/:id/entities/:entityId/pin', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) return res.status(404).json({ error: { message: 'world not found' } });
  const pinned = !!req.body?.pinned;
  setEntityPinned(world.id, req.params.entityId, pinned);
  res.json({ entities: entitiesView(world) });
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
