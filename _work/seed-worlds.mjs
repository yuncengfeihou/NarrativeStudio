#!/usr/bin/env node
/**
 * _work/seed-worlds.mjs — 把 presets/*.json 的世界卡导入数据库
 *
 * 用法：
 *   node _work/seed-worlds.mjs            # 导入全部预设
 *   node _work/seed-worlds.mjs --reset    # 先清空世界卡与剧情会话，再导入
 *
 * 幂等：同 id 的卡会被覆盖更新；lore 词条整批替换。
 */
import '../server/load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PRESETS_DIR = path.join(ROOT, 'presets');

const reset = process.argv.includes('--reset');

const { getDb, upsertWorld, replaceLore, getWorld, listWorlds, listSessions } = await import('../server/memory/store.js');

const db = getDb();

if (reset) {
  console.log('· 清空剧情会话与世界卡…');
  for (const s of listSessions()) {
    db.prepare(`DELETE FROM turns WHERE session_id=?`).run(s.id);
    db.prepare(`DELETE FROM summaries WHERE session_id=?`).run(s.id);
    db.prepare(`DELETE FROM entities WHERE session_id=?`).run(s.id);
    db.prepare(`DELETE FROM facts WHERE session_id=?`).run(s.id);
    db.prepare(`DELETE FROM states WHERE session_id=?`).run(s.id);
    db.prepare(`DELETE FROM notes WHERE session_id=?`).run(s.id);
    db.prepare(`DELETE FROM relations WHERE session_id=?`).run(s.id);
    db.prepare(`DELETE FROM threads WHERE session_id=?`).run(s.id);
    db.prepare(`DELETE FROM reflections WHERE session_id=?`).run(s.id);
    db.prepare(`DELETE FROM sessions WHERE id=?`).run(s.id);
  }
  db.prepare(`DELETE FROM lore_entries`).run();
  db.prepare(`DELETE FROM worlds`).run();
  console.log('  已清空。');
}

const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json'));
if (!files.length) {
  console.log('presets/ 下没有 json 文件。');
  process.exit(0);
}

for (const file of files) {
  const full = path.join(PRESETS_DIR, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    console.warn(`✕ ${file} 解析失败：${err.message}`);
    continue;
  }
  const card = data.card || {};
  if (!card.title) {
    console.warn(`✕ ${file} 缺少 card.title，跳过`);
    continue;
  }
  const id = data.id || file.replace(/\.json$/, '');

  upsertWorld({
    id,
    title: card.title,
    subtitle: data.subtitle || card.subtitle || '',
    coverHue: data.cover_hue ?? card.cover_hue ?? 210,
    tags: data.tags || card.genre || [],
    card,
    source: data.source || null,
  });
  const loreCount = replaceLore(id, Array.isArray(data.lore) ? data.lore : []);

  const w = getWorld(id);
  const castCount = Array.isArray(card.cast) ? card.cast.length : 0;
  const arcCount = Array.isArray(card.arcs) ? card.arcs.length : 0;
  console.log(`✓ ${card.title}`);
  console.log(`    id=${id}  卡司 ${castCount} 人 · 幕 ${arcCount} 段 · 词条 ${loreCount} 条`);
}

console.log('\n当前世界卡：');
for (const w of listWorlds()) {
  const sessions = listSessions({ worldId: w.id });
  console.log(`  · ${w.title}  (${sessions.length} 段剧情)`);
}
