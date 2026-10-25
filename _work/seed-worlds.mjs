#!/usr/bin/env node
/**
 * _work/seed-worlds.mjs — 把 presets/*.json 的世界卡导入数据库
 *
 *   node _work/seed-worlds.mjs            # 导入全部预设
 *   node _work/seed-worlds.mjs --reset    # 先清空世界卡与剧情会话，再导入
 *
 * 幂等：同 id 的卡被覆盖更新。只接受 v5 形状的卡（v4 预设先跑 _work/migrate-v5.mjs）。
 */
import '../server/load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PRESETS_DIR = path.join(ROOT, 'presets');

const reset = process.argv.includes('--reset');

const { getDb, listSessions, listWorlds, saveWorld } = await import('../server/memory/store.js');
const { normalizeCard, isPerson } = await import('../server/world/schema.js');

const db = getDb();

// 世界卡投影表由 store.js 维护：按 world_id 列动态清理，表改名/新增都不必回来改这里
const worldTables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((row) => row.name)
  .filter((name) => name !== 'worlds'
    && db.prepare('SELECT name FROM pragma_table_info(?)').all(name).some((col) => col.name === 'world_id'));

if (reset) {
  console.log('· 清空剧情会话与世界卡…');
  for (const s of listSessions()) {
    for (const t of ['turns', 'scenes', 'assertions', 'character_states', 'voices', 'patches', 'branches', 'notes', 'states', 'relations', 'threads']) {
      db.prepare(`DELETE FROM ${t} WHERE session_id=?`).run(s.id);
    }
    db.prepare(`DELETE FROM sessions WHERE id=?`).run(s.id);
  }
  for (const w of listWorlds()) {
    for (const table of worldTables) db.prepare(`DELETE FROM ${table} WHERE world_id=?`).run(w.id);
    db.prepare(`DELETE FROM worlds WHERE id=?`).run(w.id);
  }
}

let count = 0;
for (const file of fs.readdirSync(PRESETS_DIR)) {
  if (!file.endsWith('.json')) continue;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8'));
    const card = normalizeCard(raw.card || {});
    const id = raw.id || file.replace(/\.json$/, '');
    saveWorld({
      id,
      title: card.title,
      subtitle: card.subtitle,
      tags: raw.tags || card.tags || [],
      card,
      source: raw.source || card.source || null,
    });
    const persons = card.entities.filter(isPerson).length;
    console.log(`  ✓ ${id} — ${card.title}｜实体 ${card.entities.length}（人物 ${persons} / 事实 ${card.entities.length - persons}）｜`
      + `时间线 ${card.timeline.length}｜锚点 ${card.anchors.length}`);
    count++;
  } catch (err) {
    console.warn(`  ✗ ${file}: ${err.message}`);
  }
}
console.log(`\n导入了 ${count} 张世界卡。`);
