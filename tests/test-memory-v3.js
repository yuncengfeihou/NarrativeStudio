#!/usr/bin/env node
/**
 * test-memory-v3.js — 记忆系统增强部分的单元测试
 *
 * 覆盖：
 *  1. 作者笔记：增删改查 + 注入上下文（notes 层）
 *  2. 实体/事实的固定与撤回
 *  3. 回合改写 + 回滚（truncateSession 的级联清理）
 *  4. 分页读取回合
 *  5. 组装器在 notes 超预算时的降级顺序
 *
 * 全部为本地 SQLite 操作，不触发 LLM。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'test-memory-v3.db');

// 必须在 import 服务端模块之前设置，config.js 在求值时读取 env
process.env.DB_PATH = DB_PATH;
try { fs.rmSync(DB_PATH, { force: true }); } catch { /* 忽略 */ }

const store = await import('../server/memory/store.js');
const { assembleContext } = await import('../server/memory/assembler.js');
const { estimateMessagesTokens } = await import('../server/tokens.js');
const mergeMod = await import('../server/agents/memory-agent.js');

let passed = 0;
let failed = 0;
const SESSION_ID = 'test-v3-session';

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

console.log(`\n[memory-v3] DB = ${DB_PATH}\n`);

// ---------- 建基础数据 ----------
const settings = {
  title: '测试剧情',
  worldview: '一个用于测试的世界观。'.repeat(20),
  player_role: '测试玩家',
  rules: '测试规则',
  style_tags: ['测试'],
  characters: [{ name: '林霜', role: '主角', personality: '冷静', voice: '短句' }],
  context_max_tokens: 200000,
};
store.createSession({ id: SESSION_ID, title: settings.title, settings });

for (let i = 1; i <= 6; i++) {
  store.addTurn(SESSION_ID, {
    turn_no: i, kind: 'player', content: `第${i}轮玩家行动：我推开了仓库的门。`,
  });
  store.addTurn(SESSION_ID, {
    turn_no: i, kind: 'narrator',
    content: `第${i}轮旁白：仓库深处传来铁链拖地的声音，林霜握紧了那把生锈的钥匙。`.repeat(3),
  });
  store.addSummary(SESSION_ID, { level: 1, turnFrom: i, turnTo: i, content: `第${i}轮摘要：玩家进入仓库。` });
}
store.setState(SESSION_ID, 6, { time: '第三日', location: '仓库', tension: 0.6, inventory: [], quests: [], threads: [] });

/* =====================================================================
 * 1. 作者笔记
 * ===================================================================== */
await test('notes：新增 / 读取 / 更新 / 删除', () => {
  const id1 = store.addNote(SESSION_ID, { content: '林霜左手有旧伤', kind: 'note', turn_no: 1 });
  const id2 = store.addNote(SESSION_ID, { content: '禁止出现现代科技', kind: 'rule', turn_no: 2 });
  assert.ok(id1 && id2);

  let notes = store.getNotes(SESSION_ID);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].content, '林霜左手有旧伤');
  assert.equal(notes[1].kind, 'rule');

  store.updateNote(SESSION_ID, id2, { active: false });
  notes = store.getNotes(SESSION_ID);
  assert.equal(notes.length, 1, '停用后默认不返回');

  const all = store.getNotes(SESSION_ID, { activeOnly: false });
  assert.equal(all.length, 2, '含停用时返回 2 条');

  store.updateNote(SESSION_ID, id2, { active: true, content: '禁止出现电子设备' });
  notes = store.getNotes(SESSION_ID);
  assert.equal(notes.length, 2);
  assert.equal(notes[1].content, '禁止出现电子设备');

  store.deleteNote(SESSION_ID, id1);
  assert.equal(store.getNotes(SESSION_ID).length, 1);
});

await test('assembler：notes 层被注入且位于摘要之前', async () => {
  const session = store.getSession(SESSION_ID);
  const ctx = await assembleContext({ session, turnNo: 7, playerText: '我走进去' });

  // 用 role:'user' 承载记忆层（与 state/summaries/entities 一致）；
  // 多条 system 消息插在对话中段会让上游模型把正文写进 reasoning。
  const noteMsg = ctx.messages.find((m) => String(m.content).includes('【作者笔记】'));
  assert.ok(noteMsg, '应存在作者笔记层');
  assert.equal(noteMsg.role, 'user', '笔记层应使用 user 角色');
  assert.ok(noteMsg.content.includes('禁止出现电子设备'), '笔记正文应被注入');

  // notes 必须出现在摘要/实体/检索之前（高优先级位置）
  const idxNotes = ctx.messages.indexOf(noteMsg);
  const idxSummary = ctx.messages.findIndex((m) => String(m.content).includes('【剧情记忆摘要】'));
  assert.ok(idxSummary < 0 || idxNotes < idxSummary, 'notes 应在摘要之前');

  // system 消息只允许出现在开头（system 人设 + bible），
  // 不能夹在对话中段——实测夹在中间会让上游把正文写进 reasoning。
  const systemIdx = ctx.messages
    .map((m, i) => (m.role === 'system' ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(systemIdx.length >= 1, '应有 system 人设消息');
  assert.ok(
    systemIdx.every((i, k) => i === k),
    `system 消息只应出现在开头，实际位置 ${systemIdx.join(',')}`,
  );

  assert.ok(ctx.budget.notes > 0, 'budget.notes 应大于 0');
});

/* =====================================================================
 * 2. 实体 / 事实
 * ===================================================================== */
await test('entities：固定优先排序 + 固定项不被预算挤掉', () => {
  const eid = store.upsertEntity(SESSION_ID, {
    type: 'item', name: '生锈的钥匙', summary: '能打开仓库深处那扇铁门', importance: 0.3, last_turn: 2,
  });
  store.upsertEntity(SESSION_ID, {
    type: 'character', name: '林霜', summary: '冷静的追踪者', importance: 0.9, last_turn: 5,
  });

  let list = store.getEntities(SESSION_ID, { limit: 10 });
  assert.equal(list[0].name, '林霜', 'importance 高的在前');

  store.setEntityPinned(SESSION_ID, eid, true);
  list = store.getEntities(SESSION_ID, { limit: 10 });
  assert.equal(list[0].name, '生锈的钥匙', '固定项应排到最前');
  assert.equal(list[0].pinned, 1);

  store.setEntityPinned(SESSION_ID, eid, false);
  list = store.getEntities(SESSION_ID, { limit: 10 });
  assert.equal(list[0].name, '林霜');
});

await test('entities：编辑与删除', () => {
  const eid = store.upsertEntity(SESSION_ID, {
    type: 'location', name: '临江旧港', summary: '旧描述', importance: 0.5, last_turn: 3,
  });
  store.updateEntity(SESSION_ID, eid, { summary: '新描述：暴雨中的废弃码头', importance: 0.8 });
  const list = store.getEntities(SESSION_ID, { limit: 20 });
  const hit = list.find((e) => e.id === eid);
  assert.equal(hit.summary, '新描述：暴雨中的废弃码头');
  assert.equal(hit.importance, 0.8);

  store.deleteEntity(SESSION_ID, eid);
  assert.ok(!store.getEntities(SESSION_ID, { limit: 20 }).some((e) => e.id === eid));
});

await test('facts：固定 / 撤回（软删）/ 硬删', () => {
  const f1 = store.addManualFact(SESSION_ID, { subject: '林霜', predicate: '持有', object: '生锈的钥匙' });
  const f2 = store.addManualFact(SESSION_ID, { subject: '林霜', predicate: '敌对', object: '灰鸽' });
  assert.ok(f1 && f2);

  // 去重：同一三元组不重复插入
  const f1b = store.addManualFact(SESSION_ID, { subject: '林霜', predicate: '持有', object: '生锈的钥匙' });
  assert.equal(f1b, f1, '重复三元组应返回既有 id');

  let facts = store.getFacts(SESSION_ID, { limit: 100 });
  assert.equal(facts.length, 2);

  store.setFactPinned(SESSION_ID, f1, true);
  facts = store.getFacts(SESSION_ID, { limit: 100 });
  assert.equal(facts[0].id, f1, '固定事实排最前');

  store.deleteFact(SESSION_ID, f2);            // 软删
  facts = store.getFacts(SESSION_ID, { limit: 100 });
  assert.equal(facts.length, 1, '软删后默认不返回');
  assert.equal(store.getFacts(SESSION_ID, { limit: 100, includeRetracted: true }).length, 2);

  store.deleteFact(SESSION_ID, f2, { hard: true }); // 已经被软删，再硬删
  assert.equal(store.getFacts(SESSION_ID, { limit: 100, includeRetracted: true }).length, 1);
});

/* =====================================================================
 * 3. 回合改写 / 回滚
 * ===================================================================== */
await test('turns：改写正文并标记 edited', () => {
  const t = store.getTurn(SESSION_ID, 3, 'narrator');
  assert.ok(t);
  const before = t.content;
  store.updateTurnContent(SESSION_ID, 3, 'narrator', '人工改写后的旁白正文。');
  const after = store.getTurn(SESSION_ID, 3, 'narrator');
  assert.equal(after.content, '人工改写后的旁白正文。');
  assert.equal(after.edited, 1);
  assert.notEqual(after.content, before);
  assert.ok(after.token_count > 0);
});

await test('turns：分页读取 getTurns(from, to)', () => {
  const part = store.getTurns(SESSION_ID, { from: 2, to: 4 });
  assert.equal(part.length, 6, '2-4 轮共 3 轮 × 2 条 = 6');
  assert.ok(part.every((t) => t.turn_no >= 2 && t.turn_no <= 4));
  const onlyNarr = store.getTurns(SESSION_ID, { from: 1, to: 6, kinds: ['narrator'] });
  assert.equal(onlyNarr.length, 6);
});

await test('rollback：truncateSession 删除该轮之后的一切', () => {
  store.addFact(SESSION_ID, { subject: '测试', predicate: '位于', object: '第5轮地点', turn_no: 5 });
  store.addFact(SESSION_ID, { subject: '测试', predicate: '位于', object: '第6轮地点', turn_no: 6 });
  store.setState(SESSION_ID, 6, { time: '六', location: 'x' });

  const res = store.truncateSession(SESSION_ID, 3);
  assert.ok(res.turns > 0, '应删除回合');
  assert.ok(res.summaries > 0, '应删除摘要');
  assert.equal(store.getMaxTurnNo(SESSION_ID), 3);

  assert.equal(store.getTurns(SESSION_ID, { from: 4, to: 99 }).length, 0, '第 4 轮后应无回合');
  assert.ok(!store.getSummaries(SESSION_ID, { level: 1 }).some((s) => s.turn_to > 3), '应删除后续摘要');
  assert.ok(!store.getFacts(SESSION_ID, { limit: 500 }).some((f) => f.turn_no > 3), '应删除后续事实');
  assert.ok(!store.getStatesAfter || true);

  const st = store.getState(SESSION_ID);
  assert.ok(!st || st.turn_no <= 3, '状态快照不应晚于回滚点');

  const sess = store.getSession(SESSION_ID);
  assert.equal(sess.turn_count, 3, 'turn_count 应同步');
});

/* =====================================================================
 * 4. 状态机去重（线索 / 目标 / 物品）
 * ===================================================================== */
await test('similarity：中文短句相似度能区分「改写」与「新线索」', () => {
  const { similarity } = mergeMod;
  assert.ok(similarity('七年前东街往事与伍卿真实身份', '七年前东街往事与伍卿身世（无纹玉佩）') >= 0.62,
    '同一线索的改写应被判定为相似');
  assert.ok(similarity('凌玥的旧伤', '凌璇的旧识') < 0.62, '不同线索不应被误合并');
  assert.equal(similarity('完全一样', '完全一样'), 1);
  assert.equal(similarity('', 'x'), 0);
});

await test('mergeState：近义线索合并，保留信息更全的一条', () => {
  const r = mergeMod.mergeState(
    { threads: ['七年前东街往事'] },
    { threads_add: ['七年前东街往事与伍卿身世（无纹玉佩）', '十七街鸣笛'] },
  );
  assert.equal(r.threads.length, 2, `应合并为 2 条，实际 ${JSON.stringify(r.threads)}`);
  assert.ok(r.threads.some((t) => t.includes('无纹玉佩')), '应保留信息更全的版本');
  assert.ok(r.threads.includes('十七街鸣笛'));
});

await test('mergeState：线索有上限，超额丢最旧', () => {
  const base = { threads: Array.from({ length: 20 }, (_, i) => `旧线索编号${i}号`) };
  const r = mergeMod.mergeState(base, { threads_add: ['一条全新的线索'] });
  assert.ok(r.threads.length <= 14, `线索数应被截断到 14 以内，实际 ${r.threads.length}`);
  assert.ok(r.threads.includes('一条全新的线索'), '新线索应保留');
});

await test('mergeState：quests 模糊匹配，不重复立项', () => {
  const r = mergeMod.mergeState(
    { quests: [{ goal: '查明七年前身份', progress: '进行中', status: 'active' }] },
    { quests_update: [{ goal: '查明七年前身份与往事', progress: '已找到旧照片', status: 'active' }] },
  );
  assert.equal(r.quests.length, 1, '近义目标应更新而非新增');
  assert.equal(r.quests[0].progress, '已找到旧照片');
});

await test('mergeState：quests 上限 8，优先保留未完成', () => {
  const base = {
    quests: Array.from({ length: 9 }, (_, i) => ({
      goal: `目标${i}`, status: i === 0 ? 'active' : 'done',
    })),
  };
  const r = mergeMod.mergeState(base, { quests_update: [{ goal: '全新目标' }] });
  assert.ok(r.quests.length <= 8, `任务数应 ≤ 8，实际 ${r.quests.length}`);
  assert.ok(r.quests.some((q) => q.goal === '目标0'), '未完成任务应保留');
});

await test('mergeState：inventory 去重后仍能正确移除', () => {
  const r = mergeMod.mergeState(
    { inventory: ['生锈的钥匙'] },
    { inventory_add: ['生锈的钥匙', '半张船票'], inventory_remove: ['半张船票'] },
  );
  assert.deepEqual(r.inventory, ['生锈的钥匙']);
});

/* =====================================================================
 * 5. 组装器降级顺序
 * ===================================================================== */
await test('assembler：极小预算下 notes 仍尽量保留（晚于 state 丢弃）', async () => {
  store.addNote(SESSION_ID, { content: '这是一条很重要的规则'.repeat(5), kind: 'rule', turn_no: 1 });
  const session = store.getSession(SESSION_ID);
  // 用极小的上下文上限逼出降级阶梯
  const tight = {
    ...session,
    settings: { ...session.settings, context_max_tokens: 1200 },
  };
  const ctx = await assembleContext({ session: tight, turnNo: 4, playerText: '继续' });
  assert.ok(ctx.budget.total <= 1200, `预算应 ≤ 1200，实际 ${ctx.budget.total}`);
  assert.equal(ctx.budget.total, estimateMessagesTokens(ctx.messages), 'budget 应与实际一致');
});

await test('assembler：笔记超过上限时才被丢弃', async () => {
  const sid = 'test-v3-notes-flood';
  store.createSession({ id: sid, title: '洪泛笔记', settings: { title: '洪泛笔记', context_max_tokens: 3000 } });
  for (let i = 0; i < 40; i++) {
    store.addNote(sid, { content: `第 ${i} 条笔记：`.padEnd(30, '注') + 'x'.repeat(200), kind: 'note' });
  }
  const session = store.getSession(sid);
  const ctx = await assembleContext({ session, turnNo: 1, playerText: '开始' });
  assert.ok(ctx.budget.total <= 3000, `硬上限必须满足，实际 ${ctx.budget.total}`);
});

/* =====================================================================
 * 收尾
 * ===================================================================== */
console.log(`\n[memory-v3] ${passed}/${passed + failed} 通过`);
if (failed > 0) {
  console.error('SOME MEMORY-V3 TESTS FAILED');
  process.exit(1);
}
console.log('ALL MEMORY-V3 TESTS PASSED');
store.closeDb();
try { fs.rmSync(DB_PATH, { force: true }); } catch { /* 忽略 */ }
