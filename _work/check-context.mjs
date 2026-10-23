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
for (let i = 1; i <= turns; i++) {
  store.addTurn('scale-session', { turn_no: i, kind: 'player', content: '我低着头没说话。', branch_id: 'main' });
  store.addTurn('scale-session', { turn_no: i, kind: 'narrator', content: NARRATIVE, branch_id: 'main' });
}

console.log(`\n模拟 ${turns} 轮的装配体积：\n`);
console.log('  轮次    系统    原文   场记单   本轮    合计');

const samples = [1, 10, 50, 100, 200, 500, 1000].filter((n) => n <= turns);
const results = [];
for (const n of samples) {
  const ctx = await engine.assembleContext({
    session: S, world, turnNo: n, playerText: '我沿着雨街往东走。',
  });
  const b = ctx.budget;
  results.push({ n, ...b });
  console.log(
    `  ${String(n).padStart(4)}  ${String(b.system).padStart(6)}  ${String(b.recent).padStart(6)}`
    + `  ${String(b.scene).padStart(6)}  ${String(b.current).padStart(5)}  ${String(b.total).padStart(6)}`,
  );
}

const first = results[0].total;
const last = results[results.length - 1];
const growth = last.total / first;
console.log(`\n首轮 ${first} → 第 ${last.n} 轮 ${last.total} tok`
  + `（增长 ${((growth - 1) * 100).toFixed(1)}%）`);

if (growth > 2.5) {
  console.error('✗ 体积随轮数显著增长，不符合设计');
  process.exit(1);
}
console.log('✓ 体积与轮数无关（含历史时受 recent 配额约束，超出部分由 fitRecent 裁剪）');
