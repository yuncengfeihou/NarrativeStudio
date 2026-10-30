#!/usr/bin/env node
/**
 * _work/check-context.mjs — 上下文装配规模模拟（无网络）
 *
 *   node _work/check-context.mjs 500
 *
 * 验证：装配出来的提示词体积不随轮数增长。
 * v4 的上下文是「渲染」出来的（索引 + 最近原文 + 场记单），
 * 不是「检索」出来的，所以理论上与轮数无关。
 */
import '../server/load-env.js';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `narra-scale-${Date.now()}.db`);

const turns = Number(process.argv[2]) || 500;

const store = await import('../server/memory/store.js');
const engine = await import('../server/memory/context-engine.js');
const { currentPlan } = await import('../server/memory/context-plan.js');
const { config } = await import('../server/config.js');
const { normalizeCard } = await import('../server/world/schema.js');
const fs = await import('node:fs');

const preset = JSON.parse(fs.readFileSync('presets/nvzun-jianpolan.json', 'utf8'));
const card = normalizeCard(preset.card);

const world = { id: 'scale-test', title: card.title, card };
store.saveWorld(world);
const session = store.createSession({ id: 'scale-session', title: '规模模拟', worldId: 'scale-test' });
store.createBranch('scale-session', { branchId: 'main' });
store.setSessionAnchor('scale-session', 'prologue', 'main');

const S = { ...session, branch_id: 'main', anchor_id: 'prologue' };

// 塞入假回合，让「最近原文」层有真实数据（只追加，模拟长会话）
const NARRATIVE = ('雨顺着他的围巾往下淌，冰凉。他忽然发现，自己竟然没有立刻甩开那只手'
  + '——不是不想，是这具身体好像认得她。凌玥的手很凉，握得很轻，像怕捏碎什么。').repeat(3);
// 场次长度按**配置允许的最坏情况**取：地点/时间每拍都变时，能切到多短就多短。
// 取 SCENE_EVERY 是旧口径，它只是上限——长跑实测 65 拍切了 29 场（2.24 拍/场），
// 模拟按 12 拍一场会把场次索引层低估 5 倍，「1000 轮体积有上界」就成了自证。
// MIN_SCENE_TURNS=0 时没有下限，最坏是 1 拍一场。
const SCENE_LEN = Math.max(1, Math.min(
  config.context.minSceneTurns || 1, config.context.sceneEvery || 1,
));
for (let i = 1; i <= turns; i++) {
  store.addTurn('scale-session', { turn_no: i, kind: 'player', content: '我低着头没说话。', branch_id: 'main' });
  store.addTurn('scale-session', { turn_no: i, kind: 'narrator', content: NARRATIVE, branch_id: 'main' });
  // 模拟回合末的封场：原文窗口只保留当前场次（上一场结束 + 1 起）。
  if (i % SCENE_LEN === 0) {
    const n = i / SCENE_LEN;
    store.addScene('scale-session', {
      branch_id: 'main',
      scene_id: `S${String(n).padStart(3, '0')}`,
      level: 1,
      turn_from: i - SCENE_LEN + 1,
      turn_to: i,
      place: `地点${i}`,
      question: `第 ${n} 场真正在问的问题？`,
      outcome: `第 ${n} 场结束时局势变成了什么样。`,
      key_detail: n % 3 === 0 ? `关键细节${n}` : '',
      importance: n % 3 === 0 ? 'major' : 'normal',
      hooks: n % 3 === 0 ? [`钩子${n}`] : [],
    });
  }
}

console.log(`\n模拟 ${turns} 轮的装配体积：\n`);
console.log('  轮次    系统  场次索引   原文   场记单   本轮    合计   覆盖');

const samples = [1, 10, 50, 100, 200, 500, 1000].filter((n) => n <= turns);
const results = [];
for (const n of samples) {
  const ctx = await engine.assembleContext({
    session: S, world, turnNo: n, playerText: '我沿着雨街往东走。',
  });
  const b = ctx.budget;
  results.push({ n, ...b, recall: ctx.meta.recall, index: ctx.meta.system_blocks?.index, coverage: ctx.meta.coverage });
  const c = ctx.meta.coverage || {};
  // 接缝判据（D1）：重叠合法、洞非法。`recent_from + overlap_turns` 必须等于 `scene_to + 1`。
  const seam = c.recent_from == null
    ? '✓'
    : (c.recent_from <= c.scene_to + 1
      && c.recent_from + (c.overlap_turns || 0) === c.scene_to + 1 ? '✓' : '✗');
  console.log(
    `  ${String(n).padStart(4)}  ${String(b.system).padStart(6)}  ${String(b.archive).padStart(8)}`
    + `  ${String(b.recent).padStart(6)}  ${String(b.scene).padStart(6)}  ${String(b.current).padStart(5)}`
    + `  ${String(b.total).padStart(6)}   ${c.scene_to ?? 0}→${c.recent_from ?? '-'} ${seam}`
    + `  重叠 ${c.overlap_turns ?? 0}/${c.overlap_limit ?? '-'}`,
  );
  if (seam === '✗') process.exitCode = 1;
}

const first = results[0].total;
const last = results[results.length - 1];
const growth = last.total / first;
console.log(`\n首轮 ${first} → 第 ${last.n} 轮 ${last.total} tok`
  + `（增长 ${((growth - 1) * 100).toFixed(1)}%）`);

// 场次索引随场数增长，但有明确上界；其余层与轮数无关。
const plan = currentPlan();
const maxArchive = Math.max(...results.map((r) => r.archive));
console.log(`场次索引峰值 ${maxArchive} tok（规划配额 ${plan.layers.archive}，靠降级而不是硬砍收敛）`);
const lastIndex = last.index || {};
console.log(`世界索引 ${lastIndex.rendered ?? '?'}/${lastIndex.total ?? '?'} 实体`
  + `（丢 ${lastIndex.dropped ?? 0}），实体召回率 ${last.recall?.rate ?? '?'}`);
console.log(`场次索引丢行 ${last.coverage?.scene_index_dropped ?? 0}、降级 ${last.coverage?.scene_index_degraded ?? 0}`);

if (growth > 6) {
  console.error('✗ 体积随轮数增长过多，不符合设计');
  process.exit(1);
}
if (maxArchive > plan.layers.archive + 40) {
  console.error('✗ 场次索引超出规划配额，降级没有收敛');
  process.exit(1);
}
if (last.coverage?.scene_index_dropped) {
  console.error('✗ 场次索引整行丢弃：长程记忆被静默裁掉');
  process.exit(1);
}
if ((last.recall?.rate ?? 0) < 0.99) {
  console.error('✗ 实体召回率低于 99%：有实体在本轮上下文中完全不可见');
  process.exit(1);
}
console.log('✓ 体积有上界：场次索引随场数增长并被配额收敛，其余层与轮数无关');
