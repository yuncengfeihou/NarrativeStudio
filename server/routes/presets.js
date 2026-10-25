/**
 * server/routes/presets.js — 世界卡种子
 *
 * presets/*.json 承载的是**世界卡**（world card）：
 *   { id, title, subtitle, cover_hue, tags, card: {…v5 形状（entities[]）…}, source: {…} }
 *
 * beta 阶段只认 v5 形状：旧格式不会自动迁移，导入前请按 v5 重写。
 *
 *   GET  /api/presets              -> 磁盘上的卡摘要
 *   GET  /api/presets/:id          -> 完整卡
 *   POST /api/presets               -> 写回磁盘（作者工作流）
 *   POST /api/presets/:id/import   -> 导入数据库（成为可用的世界卡）
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEntities, saveWorld } from '../memory/store.js';
import { normalizeCard } from '../world/schema.js';

export const presetsRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PRESETS_DIR = path.resolve(__dirname, '..', '..', 'presets');

function ensureDir() {
  if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });
}

/** 读取全部预设（按 title 排序，坏文件跳过）。 */
export function loadPresets() {
  ensureDir();
  const out = [];
  for (const file of fs.readdirSync(PRESETS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8'));
      const card = normalizeCard(data.card || {});
      if (!card.title) continue;
      out.push({
        id: data.id || file.replace(/\.json$/, ''),
        title: card.title,
        subtitle: card.subtitle,
        tags: data.tags || card.tags || [],
        cover_hue: data.cover_hue ?? null,
        kind: card.kind,
        premise: card.prompt.premise,
        persons: card.entities.filter((e) => e.type === 'person').map((p) => ({ id: p.id, name: p.name, role: p.role, summary: p.summary })),
        entity_count: card.entities.length,
        fact_count: card.entities.filter((e) => e.type !== 'person').length,
        player: card.player.name ? { name: card.player.name, identity: card.player.identity, mode: card.player.mode } : null,
        charter_count: card.charter.length,
        timeline_past: card.timeline.filter((t) => t.canon === 'past').length,
        timeline_future: card.timeline.filter((t) => t.canon === 'future').length,
        anchors: card.anchors.map((a) => ({ id: a.id, label: a.label })),
        source: data.source || card.source || null,
      });
    } catch (err) {
      console.warn(`[presets] 跳过无法解析的 ${file}: ${err.message}`);
    }
  }
  return out.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
}

export function loadPreset(id) {
  ensureDir();
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(PRESETS_DIR, `${safe}.json`);
  if (!file.startsWith(PRESETS_DIR) || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 把一份磁盘预设导入数据库（幂等：同 id 覆盖）。 */
export function importPreset(data) {
  const card = normalizeCard(data.card || {});
  const id = data.id || card.title;
  if (!id || !card.title) throw new Error('preset 缺少 id 或 title');
  const world = saveWorld({
    id,
    title: card.title,
    subtitle: card.subtitle,
    coverHue: data.cover_hue ?? 210,
    tags: data.tags || card.tags || [],
    card,
    source: data.source || card.source || null,
  });
  return { ...world, entities: getEntities(world.id) };
}

presetsRouter.get('/presets', (req, res) => {
  res.json(loadPresets());
});

presetsRouter.get('/presets/:id', (req, res) => {
  const p = loadPreset(req.params.id);
  if (!p) return res.status(404).json({ error: { message: 'preset not found' } });
  res.json({ ...p, card: normalizeCard(p.card || {}) });
});

presetsRouter.post('/presets', (req, res) => {
  const data = req.body || {};
  const card = normalizeCard(data.card || {});
  if (!data.id || !card.title) {
    return res.status(400).json({ error: { message: 'id and title are required' } });
  }
  const safe = String(data.id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return res.status(400).json({ error: { message: 'invalid id' } });
  ensureDir();
  fs.writeFileSync(
    path.join(PRESETS_DIR, `${safe}.json`),
    JSON.stringify({ ...data, id: safe, card }, null, 2),
    'utf8',
  );
  res.status(201).json({ id: safe });
});

presetsRouter.post('/presets/:id/import', (req, res) => {
  const p = loadPreset(req.params.id);
  if (!p) return res.status(404).json({ error: { message: 'preset not found' } });
  try {
    const world = importPreset(p);
    res.status(201).json(world);
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});
