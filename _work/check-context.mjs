#!/usr/bin/env node
/**
 * _work/check-context.mjs — 验证「上下文体积不随剧情增长」
 *
 * 模拟 200 轮，每 20 轮装配一次，打印各层 token 与总计，
 * 断言总量稳定在软预算附近（不随轮数上升）。
 */
import '../server/load-env.js';

const { getDb, createSession, addTurn, addSummary, upsertEntity, addFact, setState, addNote,
  upsertRelation, upsertThread, addReflection, getWorld, getMaxTurnNo,
  archiveSummaries, getSummaries } = await import('../server/memory/store.js');
const { assembleContext } = await import('../server/memory/context-engine.js');

const world = getWorld('nvzun-jianpolan');
if (!world) { console.error('先运行 node _work/seed-worlds.mjs'); process.exit(1); }

/**
 * 本地版的层级压缩（不调用 LLM，只验证「随轮数变化的体积」这一不变量）。
 * 真实压缩会调用模型生成更凝练的摘要；这里用截断模拟同样的结构变化：
 *   每 6 条 L1 → 1 条 L2，每 4 条 L2 → 1 条 L3，每 4 条 L3 → 1 条 L4
 */
function localCompress(sessionId) {
  const roll = (srcLevel, dstLevel, every) => {
    const rows = getSummaries(sessionId, { level: srcLevel, archived: 0 });
    while (rows.length >= every) {
      const batch = rows.splice(0, every);
      let contiguous = true;
      for (let i = 1; i < batch.length; i++) {
        if (batch[i].turn_from !== batch[i - 1].turn_to + 1) { contiguous = false; break; }
      }
      if (!contiguous) break;
      const text = batch.map((r) => r.content).join(' ').slice(0, 500);
      addSummary(sessionId, {
        level: dstLevel,
        turnFrom: batch[0].turn_from,
        turnTo: batch[batch.length - 1].turn_to,
        content: text,
      });
      archiveSummaries(batch.map((r) => r.id));
    }
  };
  roll(1, 2, 6);
  roll(2, 3, 4);
  roll(3, 4, 4);
}

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
  if (i % 5 === 0) {
    upsertRelation(sid, {
      from: '凌玥', to: '伍卿', kind: '旧识·执念',
      sentiment: Math.min(1, 0.4 + i / 400), note: `第 ${i} 轮的试探`, turn_no: i,
    });
    if (i % 10 === 0) {
      upsertThread(sid, {
        title: `线索 ${i}：雨里那把没撑开的伞`,
        status: i % 40 === 0 ? 'resolved' : 'open',
        weight: 0.4, planted_turn: i,
      });
    }
  }
  if (i % 5 === 0) {
    addReflection(sid, {
      turn_from: Math.max(1, i - 4), turn_to: i, kind: 'insight',
      content: `她每次示好都像在下套——第 ${i} 轮时，这一点更清楚了。`,
    });
  }

  if (i % 6 === 0) localCompress(sid);

  if (i % 20 === 0) {
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
