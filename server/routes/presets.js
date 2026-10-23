/**
 * 剧本预设（Preset）接口。
 *
 * 预设 = 一份可直接开局的完整设定（标题 / 世界观 / 角色卡 / 玩家身份 / 规则 / 开场白）。
 * 存放于 presets/ 目录下的 JSON 文件，供前端「从剧本开局」使用。
 *
 *   GET  /api/presets          -> [{id, title, subtitle, tags, characters, ...摘要}]
 *   GET  /api/presets/:id      -> {id, title, settings}   完整设定
 *   POST /api/presets/import   -> 由任意 JSON 校验入库（作者导出/分享用）
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const presetsRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PRESETS_DIR = path.resolve(__dirname, '..', '..', 'presets');

function ensureDir() {
  if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });
}

/** 读取全部预设（按 title 排序，坏文件跳过并记录）。 */
export function loadPresets() {
  ensureDir();
  const out = [];
  for (const file of fs.readdirSync(PRESETS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      if (!data?.settings) continue;
      out.push({
        id: data.id || file.replace(/\.json$/, ''),
        file,
        title: data.settings.title || data.title || file,
        subtitle: data.subtitle || '',
        tags: data.tags || data.settings.style_tags || [],
        characters: (data.settings.characters || []).map(c => ({
          name: c.name, role: c.role, avatar_hue: c.avatar_hue,
        })),
        accent_hue: data.accent_hue ?? null,
        source: data.source || null,
        opening_preview: String(data.settings.opening || '').slice(0, 160),
        worldview_preview: String(data.settings.worldview || '').slice(0, 160),
        turn_goal: data.turn_goal || null,
      });
    } catch (err) {
      console.warn(`[presets] 跳过无法解析的预设 ${file}: ${err.message}`);
    }
  }
  return out.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
}

/** 按 id 读取单个预设的完整内容。 */
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

presetsRouter.get('/presets', (req, res) => {
  res.json(loadPresets());
});

presetsRouter.get('/presets/:id', (req, res) => {
  const p = loadPreset(req.params.id);
  if (!p) return res.status(404).json({ error: { message: 'preset not found' } });
  res.json(p);
});

/** 校验并写入一份预设（作者工作流：把成果固化为预设）。 */
presetsRouter.post('/presets', (req, res) => {
  const data = req.body || {};
  if (!data.id || !data.settings || !data.settings.title) {
    return res.status(400).json({ error: { message: 'id and settings.title are required' } });
  }
  const safe = String(data.id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return res.status(400).json({ error: { message: 'invalid id' } });
  ensureDir();
  fs.writeFileSync(path.join(PRESETS_DIR, `${safe}.json`), JSON.stringify(data, null, 2), 'utf8');
  res.status(201).json({ id: safe });
});
