#!/usr/bin/env node
/**
 * tests/test-context-engine.js — 上下文引擎单元测试（无网络）
 *
 * 覆盖：
 *   - 世界宪章的生成与截断
 *   - 卡司在场判定（名字命中 / 场景账本 / always）
 *   - 词条触发（关键词 / 二次词 / 常驻 / 递归）
 *   - 导演卡的幕推进
 *   - 记忆层配额分配
 *   - 装配器的预算上限与层结构
 */
import './load-env.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = path.join(os.tmpdir(), `narra-test-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const engine = await import('../server/memory/context-engine.js');
const store = await import('../server/memory/store.js');
const { config } = await import('../server/config.js');

let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}

function eq(a, b, label) {
  ok(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\n=== 世界宪章 ===');
{
  const world = { card: { title: '测试世界', charter: [{ rule: '规则一' }, { rule: '规则二' }], style: {} } };
  const text = engine.buildContract({ settings: {} }, world);
  // 契约层只放「怎么演」，世界规则走宪章层——这是分层的核心设计
  ok(!text.includes('规则一'), '契约层不含世界规则（规则走宪章层）');
  ok(text.includes('演出范式'), '契约包含演出范式');
  ok(!text.includes('世界观'), '契约不再包含整段世界观');
  ok(text.includes('测试世界'), '契约带上作品标题');

  const charter = engine.buildCharter(world, 500);
  ok(charter.includes('规则一') && charter.includes('规则二'), '宪章层渲染全部规则');
  ok(charter.startsWith('【世界宪章】'), '宪章层有标题');
}

console.log('\n=== 卡司在场判定 ===');
{
  const card = {
    cast: [
      { name: '凌玥', role: '家主', weight: 1 },
      { name: '黎婆', role: '奶奶', always: true },
      { name: '姬淮澄', role: '太女', weight: 0.8 },
    ],
  };
  const r1 = engine.pickCast(card, { playerText: '我抬头看凌玥', recentText: '' });
  ok(r1.present.some((c) => c.name === '凌玥'), '玩家提到 → 在场');
  ok(r1.present.some((c) => c.name === '黎婆'), 'always 角色 → 常驻');
  ok(!r1.present.some((c) => c.name === '姬淮澄'), '未提及且不常驻 → 不在场');

  const r2 = engine.pickCast(card, {
    playerText: '',
    recentText: '',
    state: { characters: { 姬淮澄: { mood: '怒' } } },
  });
  ok(r2.present.some((c) => c.name === '姬淮澄'), '场景账本记着的角色 → 在场');
}

console.log('\n=== 词条触发 ===');
{
  const lore = [
    { id: 1, keys: ['司楼'], secondary: [], title: '司楼', content: '官营青楼', category: 'institution', constant: false, enabled: true, priority: 75, sort: 0 },
    { id: 2, keys: ['玉佩'], secondary: ['凌'], title: '玉佩', content: '会发光', category: 'mystery', constant: false, enabled: true, priority: 80, sort: 1 },
    { id: 3, keys: [], secondary: [], title: '骨架', content: '世界基础', category: 'setting', constant: true, enabled: true, priority: 90, sort: 2 },
    { id: 4, keys: ['不存在'], secondary: [], title: '噪声', content: '不该出现', category: 'setting', constant: false, enabled: true, priority: 10, sort: 3 },
  ];

  const a = engine.scanLore(lore, '他说要把人卖进司楼', { recursion: 0 });
  ok(a.entries.some((e) => e.title === '司楼'), '关键词命中 → 触发');
  ok(a.entries.some((e) => e.title === '骨架'), '常驻词条无条件注入');
  ok(!a.entries.some((e) => e.title === '噪声'), '未命中 → 不触发');

  const b = engine.scanLore(lore, '那块玉佩', { recursion: 0 });
  ok(!b.entries.some((e) => e.title === '玉佩'), '有二次词但未命中 → 不触发');

  const c = engine.scanLore(lore, '玉佩上有个凌字', { recursion: 0 });
  ok(c.entries.some((e) => e.title === '玉佩'), '主词 + 二次词同时命中 → 触发');

  const sorted = engine.scanLore(lore, '司楼', { recursion: 0 }).entries;
  eq(sorted[0].title, '骨架', '常驻（高优先级）排在最前');
}

console.log('\n=== 导演卡 ===');
{
  const world = {
    card: {
      arcs: [
        { title: '第一幕', turns: 4, goal: 'A', beats: ['a1', 'a2'] },
        { title: '第二幕', turns: 4, goal: 'B', beats: ['b1'] },
      ],
    },
  };
  const d1 = engine.buildDirector(world, 1, 500);
  eq(d1.arcIndex, 0, '第 1 轮落在第一幕');
  const d4 = engine.buildDirector(world, 4, 500);
  eq(d4.arcIndex, 0, '第 4 轮仍在第一幕');
  const d5 = engine.buildDirector(world, 5, 500);
  eq(d5.arcIndex, 1, '第 5 轮进入第二幕');
  ok(d1.text.includes('a1'), '导演卡包含必达节拍');
}

console.log('\n=== 记忆层配额 ===');
{
  const sid = `t-${Date.now()}`;
  store.createSession({ id: sid, title: 'x', settings: {} });
  store.addNote(sid, { content: '左腿有旧疾', kind: 'note', turn_no: 1 });
  store.addSummary(sid, { level: 1, turnFrom: 1, turnTo: 1, content: '第一轮摘要' });
  store.upsertRelation(sid, { from: '凌玥', to: '伍卿', kind: '执念', sentiment: 0.8, note: '找七年', turn_no: 1 });
  store.upsertThread(sid, { title: '玉佩之谜', status: 'open', weight: 0.9, planted_turn: 1 });
  store.addReflection(sid, { turn_from: 1, turn_to: 1, kind: 'insight', content: '她在试他' });

  const mem = engine.buildMemory(sid, 8000);
  ok(mem.text.includes('左腿有旧疾'), '笔记进入记忆层');
  ok(mem.text.includes('第一轮摘要'), '摘要进入记忆层');
  ok(mem.text.includes('玉佩之谜'), '线索进入记忆层');
  ok(mem.text.includes('她在试他'), '反思进入记忆层');
  ok(mem.text.includes('凌玥') && mem.text.includes('伍卿'), '关系进入记忆层');

  const tiny = engine.buildMemory(sid, 300);
  ok(tiny.text.length < mem.text.length, '配额收窄 → 内容变少');
  store.deleteSession(sid);
}

console.log('\n=== 装配器 ===');
{
  const wid = 'w-test';
  store.upsertWorld({
    id: wid,
    title: '测试世界',
    card: {
      title: '测试世界',
      charter: [{ rule: '这是女尊世界' }],
      player: { name: '伍卿', identity: '破烂少年' },
      cast: [{ name: '凌玥', role: '家主', weight: 1 }, { name: '黎婆', role: '奶奶', always: true }],
      arcs: [{ title: '第一幕', turns: 10, goal: '被认出', beats: ['雨里相遇'] }],
      style: { pov: '第三人称', voice: '短句', length: '2000字' },
      opening_state: { time: '初冬', location: '雨街', weather: '冷雨', tension: 0.3 },
      opening_seed: '雨落下来，她喊了一声卿儿。',
    },
  });
  store.replaceLore(wid, [
    { keys: ['司楼'], title: '司楼', content: '官营青楼', category: 'institution', priority: 70 },
  ]);

  const sid = `a-${Date.now()}`;
  store.createSession({ id: sid, worldId: wid, title: '装配测试', settings: {} });

  const ctx = await engine.assembleContext({
    session: store.getSession(sid),
    world: store.getWorld(wid),
    turnNo: 1,
    playerText: '我问她：你到底是谁？',
    isOpening: false,
  });

  ok(ctx.messages.length >= 3, '装配出多条消息');
  eq(ctx.messages[0].role, 'system', '第一条是 system');
  eq(ctx.messages.filter((m) => m.role === 'system').length, 1, '只有一条 system（避免正文写进 reasoning）');
  eq(ctx.messages[ctx.messages.length - 1].role, 'user', '最后一条是本轮 player');

  const all = JSON.stringify(ctx.messages);
  ok(all.includes('女尊世界'), '宪章进入上下文');
  ok(all.includes('破烂少年'), '主角进入上下文');
  ok(all.includes('被认出'), '导演卡进入上下文');

  ok(ctx.budget.total <= config.context.softTokens, `总量 ${ctx.budget.total} ≤ 软预算 ${config.context.softTokens}`);

  // 开场轮应该用 opening_state 锚定场景
  const ctx2 = await engine.assembleContext({
    session: store.getSession(sid),
    world: store.getWorld(wid),
    turnNo: 2,
    playerText: '',
    isOpening: true,
  });
  const all2 = JSON.stringify(ctx2.messages);
  ok(all2.includes('初冬'), '开场轮用 opening_state 锚定时间');
  ok(all2.includes('冷雨'), '开场轮用 opening_state 锚定天气');

  store.deleteSession(sid);
}

console.log('\n=== 预算不随层数增长 ===');
{
  // 同一份世界卡，模拟「记忆很多」的情况，总量仍应受软预算约束
  const wid = 'w-big';
  store.upsertWorld({
    id: wid,
    title: '大世界',
    card: {
      title: '大世界',
      charter: Array.from({ length: 20 }, (_, i) => ({ rule: `规则${i}` })),
      cast: Array.from({ length: 20 }, (_, i) => ({ name: `角色${i}`, role: 'r', weight: 0.5, always: i < 5 })),
      arcs: [{ title: '幕一', turns: 10 }],
    },
  });
  store.replaceLore(wid, Array.from({ length: 60 }, (_, i) => ({
    keys: [`触发词${i}`], title: `词条${i}`, content: '内容'.repeat(30), category: 'setting', priority: 50,
  })));

  const sid = `b-${Date.now()}`;
  store.createSession({ id: sid, worldId: wid, title: '预算测试', settings: { context_max_tokens: 60000 } });
  for (let i = 1; i <= 40; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: '我说话' });
    store.addTurn(sid, { turn_no: i, kind: 'narrator', content: '正文'.repeat(500) });
    store.addSummary(sid, { level: 1, turnFrom: i, turnTo: i, content: '摘要'.repeat(200) });
  }

  const ctx = await engine.assembleContext({
    session: store.getSession(sid),
    world: store.getWorld(wid),
    turnNo: 41,
    playerText: '触发词1 触发词2 触发词3',
  });
  ok(ctx.budget.total <= 60000, `硬上限内（${ctx.budget.total} ≤ 60000）`);
  ok(ctx.budget.setting < config.context.layerBudget.world + config.context.layerBudget.lore + 200,
    `设定层受配额约束（${ctx.budget.setting}）`);

  store.deleteSession(sid);
}

store.closeDb();
try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }

console.log(`\n${'─'.repeat(50)}`);
console.log(`上下文引擎：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
