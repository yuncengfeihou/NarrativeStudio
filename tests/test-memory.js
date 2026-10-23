#!/usr/bin/env node
/**
 * tests/test-memory.js — 记忆 Agent 的确定性逻辑（无网络）
 *
 * 覆盖：
 *   - state 合并（标量/人物/物品/任务）
 *   - 中文相似度
 *   - memory update 的 JSON 解析与打捞容错
 *   - 反思解析
 *   - 线索 / 关系 / 反思的存储与回滚清理
 */
import './load-env.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = path.join(os.tmpdir(), `narra-mem-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const agent = await import('../server/agents/memory-agent.js');
const store = await import('../server/memory/store.js');

let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\n=== state 合并 ===');
{
  const old = {
    time: '第一日', location: '村口', tension: 0.2,
    characters: { 伍卿: { mood: '平静' }, 黎婆: { mood: '沉默' } },
    inventory: ['牛绳', '干粮'],
    quests: [{ goal: '卖破烂', progress: '在路上', status: 'active' }],
  };
  const delta = {
    time: '第二日',
    tension: 0.7,
    characters: { 伍卿: { mood: '惊疑' } },
    inventory_add: ['玉佩'],
    inventory_remove: ['干粮'],
    quests_update: [{ goal: '卖破烂', progress: '已卖出', status: 'done' }],
  };
  const next = agent.mergeState(old, delta);
  eq(next.time, '第二日', '标量覆盖');
  eq(next.location, '村口', '未提及的标量保留');
  eq(next.characters['伍卿'].mood, '惊疑', '角色状态更新');
  eq(next.characters['黎婆'].mood, '沉默', '未提及的角色保留');
  ok(next.inventory.includes('牛绳'), '原物品保留');
  ok(next.inventory.includes('玉佩'), '物品加入');
  ok(!next.inventory.includes('干粮'), '物品移除');
  eq(next.quests[0].progress, '已卖出', '任务进度更新');
  eq(next.quests[0].status, 'done', '任务状态更新');
}

console.log('\n=== 相似度 ===');
{
  ok(agent.similarity('七年前东街往事', '七年前东街往事') === 1, '完全相同 → 1');
  ok(agent.similarity('七年前东街往事', '七年前东街往事与伍卿身份') > 0.6, '追加限定语 → 仍高相似');
  ok(agent.similarity('凌玥的旧伤', '凌璇的旧识') < 0.62, '不同线索 → 低于阈值');
}

console.log('\n=== JSON 解析容错 ===');
{
  const good = JSON.stringify({
    round_summary: '他认出了她。',
    entities: [{ type: 'character', name: '凌玥', summary: '家主' }],
    facts: [{ subject: '凌玥', predicate: '认识', object: '伍卿' }],
    state_delta: { time: '初冬' },
    relations: [{ from: '凌玥', to: '伍卿', kind: '旧识', sentiment: 0.8 }],
    threads: [{ title: '玉佩之谜', action: 'plant', weight: 0.9 }],
  });
  const p1 = agent.parseMemoryUpdate(good, '');
  eq(p1.round_summary, '他认出了她。', '正常 JSON → 摘要');
  eq(p1.entities.length, 1, '正常 JSON → 实体');
  eq(p1.relations.length, 1, '正常 JSON → 关系');
  eq(p1.threads.length, 1, '正常 JSON → 线索');

  // 带 Markdown 围栏
  const fenced = '```json\n' + good + '\n```';
  const p2 = agent.parseMemoryUpdate(fenced, '');
  eq(p2.round_summary, '他认出了她。', 'Markdown 围栏 → 仍能解析');

  // 截断的 JSON：应打捞 round_summary
  const truncated = '{"round_summary": "他站在雨里，看着那只手。"';
  const p3 = agent.parseMemoryUpdate(truncated, '');
  ok(p3.round_summary.includes('雨里'), '截断 JSON → 打捞摘要');

  // 完全不是 JSON
  const p4 = agent.parseMemoryUpdate('这不是 JSON，只是一段普通文字描述，长度足够长以触发降级路径。', '');
  ok(p4.round_summary.length > 0, '非 JSON → 降级为文本摘要');

  // 空输出 → 用正文兜底
  const p5 = agent.parseMemoryUpdate('', '本轮正文内容');
  eq(p5.round_summary, '本轮正文内容', '空输出 → 正文兜底');
}

console.log('\n=== 反思解析 ===');
{
  const good = JSON.stringify({ reflections: [{ kind: 'insight', content: '她在试他。' }, { kind: 'theme', content: '被抛弃者的自我救赎。' }] });
  const r = agent.parseReflections(good);
  eq(r.length, 2, '正常 JSON → 2 条反思');
  eq(r[0].kind, 'insight', '反思类型保留');

  const bad = agent.parseReflections('```json\n{"reflections":[{"kind":"insight","content":"只此一条"}]}\n```');
  ok(bad.length === 1, 'Markdown 围栏 → 仍能解析');

  ok(agent.parseReflections('无关内容').length === 0, '无反思 → 空数组');

  const many = agent.parseReflections(JSON.stringify({
    reflections: Array.from({ length: 8 }, (_, i) => ({ kind: 'insight', content: `第 ${i} 条` })),
  }));
  ok(many.length <= 3, '反思条数上限 3');
}

console.log('\n=== 关系 / 线索 / 反思 存储 ===');
{
  const sid = `m-${Date.now()}`;
  store.createSession({ id: sid, title: '记忆测试', settings: {} });

  store.upsertRelation(sid, { from: '凌玥', to: '伍卿', kind: '执念', sentiment: 0.9, note: '找了七年', turn_no: 1 });
  store.upsertRelation(sid, { from: '凌玥', to: '伍卿', kind: '执念', sentiment: 0.95, note: '找到了', turn_no: 2 });
  const rels = store.getRelations(sid);
  eq(rels.length, 1, '同一对关系 → upsert 不重复');
  eq(rels[0].note, '找到了', '关系被更新');

  store.upsertThread(sid, { title: '玉佩之谜', status: 'open', weight: 0.9, planted_turn: 1 });
  store.upsertThread(sid, { title: '左腿旧伤', status: 'open', weight: 0.8, planted_turn: 1 });
  eq(store.getThreads(sid, { status: 'open' }).length, 2, '线索入库');

  store.upsertThread(sid, { title: '玉佩之谜', status: 'resolved', resolved_turn: 5 });
  eq(store.getThreads(sid, { status: 'open' }).length, 1, '线索回收后不计入未回收');

  store.addReflection(sid, { turn_from: 1, turn_to: 5, kind: 'insight', content: '她在试他' });
  eq(store.getReflections(sid).length, 1, '反思入库');

  // 回滚应级联清理
  store.addTurn(sid, { turn_no: 6, kind: 'player', content: '行动' });
  const removed = store.truncateSession(sid, 1);
  ok(removed.turns >= 1, '回滚删除回合');
  ok(removed.reflections >= 1, '回滚删除 5 轮之后的反思');
  eq(store.getThreads(sid, { status: 'open' }).length, 2, '回滚把已回收的线索复位为未回收');

  store.deleteSession(sid);
}

console.log('\n=== 会话遥测累计 ===');
{
  const sid = `u-${Date.now()}`;
  store.createSession({ id: sid, title: '遥测', settings: {} });
  store.accumulateUsage(sid, { prompt_tokens: 100, completion_tokens: 200, cached_tokens: 10, duration_ms: 1000, ttft_ms: 100, output_chars: 500 });
  store.accumulateUsage(sid, { prompt_tokens: 150, completion_tokens: 250, cached_tokens: 20, duration_ms: 2000, ttft_ms: 200, output_chars: 600 });
  const s = store.getSession(sid);
  eq(s.usage.requests, 2, '累计请求数');
  eq(s.usage.prompt_tokens, 250, '累计输入 token');
  eq(s.usage.completion_tokens, 450, '累计输出 token');
  eq(s.usage.cached_tokens, 30, '累计缓存 token');
  eq(s.usage.first_token_ms, 300, '累计首字延迟');
  store.deleteSession(sid);
}

store.closeDb();
try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }

console.log(`\n${'─'.repeat(50)}`);
console.log(`记忆系统：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
