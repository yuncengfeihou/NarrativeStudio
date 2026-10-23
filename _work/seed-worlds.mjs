#!/usr/bin/env node
/**
 * _work/seed-worlds.mjs — 把 presets/*.json 的世界卡导入数据库
 *
 *   node _work/seed-worlds.mjs            # 导入全部预设
 *   node _work/seed-worlds.mjs --reset    # 先清空世界卡与剧情会话，再导入
 *
 * 幂等：同 id 的卡被覆盖更新。只接受 v4 形状的卡。
 */
import '../server/load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PRESETS_DIR = path.join(ROOT, 'presets');

const reset = process.argv.includes('--reset');

const { getDb, listSessions, listWorlds, saveWorld, getCodex } = await import('../server/memory/store.js');
const { normalizeCard } = await import('../server/world/schema.js');

const db = getDb();

if (reset) {
  console.log('· 清空剧情会话与世界卡…');
  for (const s of listSessions()) {
    for (const t of ['turns', 'scenes', 'assertions', 'character_states', 'voices', 'patches', 'branches', 'notes', 'states', 'relations', 'threads']) {
      db.prepare(`DELETE FROM ${t} WHERE session_id=?`).run(s.id);
    }
    db.prepare(`DELETE FROM sessions WHERE id=?`).run(s.id);
  }
  for (const w of listWorlds()) {
    db.prepare(`DELETE FROM codex_entries WHERE world_id=?`).run(w.id);
    db.prepare(`DELETE FROM timeline_events WHERE world_id=?`).run(w.id);
    db.prepare(`DELETE FROM anchors WHERE world_id=?`).run(w.id);
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
    const codex = getCodex(id);
    console.log(`  ✓ ${id} — ${card.title}｜卡司 ${card.cast.length}｜辞书 ${codex.length}｜`
      + `时间线 ${card.timeline.length}｜锚点 ${card.anchors.length}`);
    count++;
  } catch (err) {
    console.warn(`  ✗ ${file}: ${err.message}`);
  }
}
console.log(`\n导入了 ${count} 张世界卡。`);
