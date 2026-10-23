/**
 * server/routes/presets.js — 世界卡种子（兼容旧的「剧本库」概念）
 *
 * presets/*.json 现在承载的是**世界卡**（world card）：
 *   { id, title, subtitle, cover_hue, tags, card: {...}, lore: [...], source: {...} }
 *
 * 启动时可用 `pnpm seed` 把它们写进数据库；也可以随时通过
 * POST /api/presets/:id/import 单独导入。
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
import { getLore, replaceLore, upsertWorld } from '../memory/store.js';

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
      const card = data.card || {};
      if (!card.title && !data.title) continue;
      out.push({
        id: data.id || file.replace(/\.json$/, ''),
        title: card.title || data.title,
        subtitle: data.subtitle || card.subtitle || '',
        tags: data.tags || card.genre || [],
        cover_hue: data.cover_hue ?? card.cover_hue ?? null,
        cast: (card.cast || []).map((c) => ({ name: c.name, role: c.role, one_line: c.one_line, avatar_hue: c.avatar_hue })),
        player: card.player ? { name: card.player.name, identity: card.player.identity } : null,
        arc_count: Array.isArray(card.arcs) ? card.arcs.length : 0,
        lore_count: Array.isArray(data.lore) ? data.lore.length : 0,
        opening_preview: String(card.opening_seed || '').slice(0, 160),
        source: data.source || null,
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
  const card = data.card || {};
  const id = data.id || card.title;
  if (!id || !card.title) throw new Error('preset 缺少 id 或 card.title');
  const world = upsertWorld({
    id,
    title: card.title,
    subtitle: data.subtitle || card.subtitle || '',
    coverHue: data.cover_hue ?? card.cover_hue ?? 210,
    tags: data.tags || card.genre || [],
    card,
    source: data.source || null,
  });
  replaceLore(world.id, Array.isArray(data.lore) ? data.lore : []);
  return { ...world, lore: getLore(world.id, { enabledOnly: false }) };
}

presetsRouter.get('/presets', (req, res) => {
  res.json(loadPresets());
});

presetsRouter.get('/presets/:id', (req, res) => {
  const p = loadPreset(req.params.id);
  if (!p) return res.status(404).json({ error: { message: 'preset not found' } });
  res.json(p);
});

presetsRouter.post('/presets', (req, res) => {
  const data = req.body || {};
  const card = data.card || {};
  if (!data.id || !(card.title || data.title)) {
    return res.status(400).json({ error: { message: 'id and card.title are required' } });
  }
  const safe = String(data.id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return res.status(400).json({ error: { message: 'invalid id' } });
  ensureDir();
  fs.writeFileSync(path.join(PRESETS_DIR, `${safe}.json`), JSON.stringify(data, null, 2), 'utf8');
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
