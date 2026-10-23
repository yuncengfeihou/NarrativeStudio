/**
 * _work/clean-sims.mjs — 清掉模拟/测试产生的剧情会话
 */
import '../server/load-env.js';

const { getDb, listSessions, deleteSession } = await import('../server/memory/store.js');

const KEEP = /^我在女尊世界捡破烂/;
const rows = listSessions();
let removed = 0;

for (const s of rows) {
  const isSim = /规模测试|模拟|sim-ctx|v2-|test-/i.test(s.id) || /规模测试|模拟/.test(s.title);
  if (isSim && !KEEP.test(s.title)) {
    deleteSession(s.id);
    console.log(`removed: ${s.title} (${s.id})`);
    removed++;
  }
}

console.log(`\n完成，移除 ${removed} 段。当前：`);
for (const s of listSessions()) {
  console.log(`  · ${s.title}   ${s.turn_count} 轮   world=${s.world_id || '—'}`);
}
getDb();
