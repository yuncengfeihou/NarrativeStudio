#!/usr/bin/env node
/**
 * _work/check-context.mjs — 验证「上下文体积不随剧情增长」
 *
 * 模拟 200 轮，每 20 轮装配一次，打印各层 token 与总计，
 * 断言总量稳定在软预算附近（不随轮数上升）。
 */
import '../server/load-env.js';

const { getDb, createSession, addTurn, addSummary, upsertEntity, addFact, setState, addNote,
  getWorld, getMaxTurnNo } = await import('../server/memory/store.js');
const { assembleContext } = await import('../server/memory/context-engine.js');

const world = getWorld('nvzun-jianpolan');
if (!world) { console.error('先运行 node _work/seed-worlds.mjs'); process.exit(1); }

const { checkCompression } = await import('../server/memory/compressor.js');

const MAX_TURNS = Number(process.argv[2]) || 400;

const sid = `sim-ctx-${Date.now()}`;
createSession({ id: sid, worldId: world.id, title: '上下文规模测试', settings: {} });

const NARR = '雨顺着他的围巾往下淌，冰凉。他忽然发现，自己竟然没有立刻甩开那只手——不是不想，是这具身体好像认得她。'.repeat(12);

const results = [];
for (let i = 1; i <= MAX_TURNS; i++) {
  addTurn(sid, {
    turn_no: i, kind: 'player',
    content: ['我低头往前走', '我抬头看她', '我把牛绳往手里一收', '我小声问了一句「你谁啊」'][i % 4],
  });
  addTurn(sid, { turn_no: i, kind: 'narrator', content: NARR });
  addSummary(sid, { level: 1, turnFrom: i, turnTo: i, content: '他沿着雨街往东走，凌玥跟在半步之后。张兰在玻璃门里叫人。'.repeat(3) });
  if (i % 3 === 0) {
    upsertEntity(sid, { type: 'character', name: `路人${i}`, summary: '街上一个没有名字的路人，看了他一眼。', last_turn: i, importance: 0.3 });
    addFact(sid, { subject: '伍卿', predicate: '位于', object: `东街第${i}号`, turn_no: i });
  }
  setState(sid, i, {
    time: `第三日·${i % 24}时`, location: '湘曲市·雨街', weather: '冷雨', tension: (i % 10) / 10,
    characters: { 伍卿: { mood: '窘迫', location: '雨里', status: '湿透' }, 凌玥: { mood: '克制', location: '他面前' } },
    inventory: ['无纹玉佩', '半袋瓶罐'], quests: [{ goal: '弄清她为什么认识自己', progress: '还没问出口', status: 'active' }],
    last_hook: '她说出「以前认识」四个字',
  });
  if (i === 40) addNote(sid, { content: '伍卿左腿有旧疾，跑不快。', kind: 'note', turn_no: 40 });

  if (i % 12 === 0) await checkCompression(sid, i);

  if (i % 40 === 0) {
    const ctx = await assembleContext({
      session: { id: sid, settings: {}, title: '测试' }, world, turnNo: i + 1,
      playerText: '我把牛绳往手里一收，问她：「你到底是谁？」',
    });
    const b = ctx.budget;
    results.push({ turn: i, total: b.total, ...b });
  }
}

console.log('轮次  总量   契约  世界  卡司  词条  场景  导演  记忆  检索  最近  输入');
for (const r of results) {
  console.log(
    String(r.turn).padStart(4),
    String(r.total).padStart(6),
    String(r.contract).padStart(5),
    String(r.world).padStart(5),
    String(r.cast).padStart(5),
    String(r.lore).padStart(5),
    String(r.scene).padStart(5),
    String(r.director).padStart(5),
    String(r.memory).padStart(6),
    String(r.retrieval).padStart(5),
    String(r.recent).padStart(5),
    String(r.current).padStart(5),
  );
}

const first = results[0].total;
const last = results[results.length - 1].total;
const max = Math.max(...results.map((r) => r.total));
console.log(`\n第一段 ${first} tok → 最后一段 ${last} tok，峰值 ${max} tok`);
const growth = last - first;
console.log(`增长 ${growth} tok（${((growth / first) * 100).toFixed(1)}%）`);
if (max > 60000) {
  console.log('✕ 峰值超过 60K，预算控制失效');
  process.exit(1);
}
console.log('✓ 上下文体积稳定在软预算内');

getDb().prepare(`DELETE FROM turns WHERE session_id=?`).run(sid);
getDb().prepare(`DELETE FROM summaries WHERE session_id=?`).run(sid);
getDb().prepare(`DELETE FROM entities WHERE session_id=?`).run(sid);
getDb().prepare(`DELETE FROM facts WHERE session_id=?`).run(sid);
getDb().prepare(`DELETE FROM states WHERE session_id=?`).run(sid);
getDb().prepare(`DELETE FROM notes WHERE session_id=?`).run(sid);
getDb().prepare(`DELETE FROM sessions WHERE id=?`).run(sid);
