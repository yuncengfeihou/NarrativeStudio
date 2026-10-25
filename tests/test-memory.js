#!/usr/bin/env node
/**
 * tests/test-memory.js — 记忆系统 v5 的确定性逻辑（无网络）
 *
 * 覆盖：
 *   - 断言：冲突失效不删除、有效期查询、撤回
 *   - 人物状态：按字段可寻址、局部更新、历史可查
 *   - 原声：存取与每人限量
 *   - 分支：回合可见性（自己的 + 继承的）
 *   - 场记：写入与查询
 *   - 史官：sanitize / mergeLedger / parseArchivistUpdate / applyArchivistUpdate
 *   - 提案审计表
 */
import './load-env.js';
import path from 'node:path';
import os from 'node:os';

const tmp = path.join(os.tmpdir(), `narra-mem-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const store = await import('../server/memory/store.js');
const arch = await import('../server/agents/archivist.js');
const orch = await import('../server/agents/orchestrator.js');
const schema = await import('../server/world/schema.js');
const effective = await import('../server/world/effective.js');
const playerView = await import('../server/memory/player-view.js');
const recall = await import('../server/memory/recall-history.js');

let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 断言：冲突失效，不删除 ===');
{
  const sid = `s-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  const a1 = store.addAssertion(sid, { branch_id: 'main', subject: '凌玥', predicate: '位于', object: '帝都', valid_from: 1, source_turn: 1 });
  const a2 = store.addAssertion(sid, { branch_id: 'main', subject: '凌玥', predicate: '位于', object: '湘曲', valid_from: 5, source_turn: 5 });

  const conflict = store.findConflictingAssertions(sid, {
    branchId: 'main', subject: '凌玥', predicate: '位于', object: '湘曲', validFrom: 5,
  });
  eq(conflict.map((c) => c.id), [a1], '同主同谓不同对象 → 判为冲突');

  store.invalidateAssertion(sid, a1, { validTo: 5, supersededBy: a2 });

  const active = store.getAssertions(sid, { branchId: 'main' });
  eq(active.map((a) => a.id), [a2], '冲突后旧断言退出有效集');
  const all = store.getAssertions(sid, { branchId: 'main', includeInvalid: true });
  ok(all.length === 2, '旧断言仍在库里（没被删）');
  eq(all.find((a) => a.id === a1).status, 'invalidated', '状态标为 invalidated');
  eq(all.find((a) => a.id === a1).valid_to, 5, '记下失效轮次');
  eq(all.find((a) => a.id === a1).superseded_by, a2, '指向继任者');

  const at3 = store.getAssertions(sid, { branchId: 'main', atTurn: 3 });
  eq(at3.map((a) => a.object), ['帝都'], '按时间点回溯得到当时的事实');
  const at9 = store.getAssertions(sid, { branchId: 'main', atTurn: 9 });
  eq(at9.map((a) => a.object), ['湘曲'], '按时间点查询得到新事实');

  store.addAssertion(sid, { branch_id: 'main', subject: '凌玥', predicate: '想要', object: '带走他', valid_from: 6, source_turn: 6 });
  eq(store.getAssertions(sid, { branchId: 'main', subject: '凌玥' }).length, 2, '不同谓词不冲突');

  store.retractAssertion(sid, a2);
  eq(store.getAssertions(sid, { branchId: 'main' }).length, 1, '撤回后退出有效集');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 断言：多值谓词不误判冲突 ===');
{
  const sid = `s-many-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  store.addAssertion(sid, { branch_id: 'main', subject: '伍卿', predicate: '知道', object: '玉佩在发光', valid_from: 1, source_turn: 1 });
  const conflict = store.findConflictingAssertions(sid, {
    branchId: 'main', subject: '伍卿', predicate: '知道', object: '凌玥在门外', validFrom: 2,
  });
  eq(conflict.length, 0, '知道 A 与知道 B 不冲突');

  store.addAssertion(sid, { branch_id: 'main', subject: '伍卿', predicate: '知道', object: '凌玥在门外', valid_from: 2, source_turn: 2 });
  const knows = store.getAssertions(sid, { branchId: 'main', subject: '伍卿' })
    .filter((a) => a.predicate === '知道');
  eq(knows.length, 2, '多值事实可以并存');

  store.addAssertion(sid, { branch_id: 'main', subject: '伍卿', predicate: '拥有', object: '无纹玉佩', valid_from: 2, source_turn: 2 });
  store.addAssertion(sid, { branch_id: 'main', subject: '伍卿', predicate: '拥有', object: '牛车', valid_from: 3, source_turn: 3 });
  eq(store.getAssertions(sid, { branchId: 'main', subject: '伍卿' })
    .filter((a) => a.predicate === '拥有').length, 2, '拥有多个物品不冲突');

  store.addAssertion(sid, { branch_id: 'main', subject: '伍卿', predicate: '位于', object: '雨街', valid_from: 1, source_turn: 1 });
  const move = store.findConflictingAssertions(sid, {
    branchId: 'main', subject: '伍卿', predicate: '位于', object: '凌府', validFrom: 4,
  });
  eq(move.map((a) => a.object), ['雨街'], '单值谓词仍然判冲突');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 人物状态：按字段可寻址 ===');
{
  const sid = `s-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  store.setCharState(sid, { branchId: 'main', who: '伍卿', field: 'condition', value: '湿透', turn: 1 });
  store.setCharState(sid, { branchId: 'main', who: '伍卿', field: 'mood', value: '窘迫', turn: 1 });
  store.setCharState(sid, { branchId: 'main', who: '伍卿', field: 'condition', value: '换了干衣', turn: 3 });

  const now = store.getCharStateMap(sid, { branchId: 'main' });
  eq(now['伍卿'], { condition: '换了干衣', mood: '窘迫' }, '每字段各取最新，互不覆盖');
  const at1 = store.getCharStateMap(sid, { branchId: 'main', atTurn: 2 });
  eq(at1['伍卿'].condition, '湿透', '可按轮次回溯');
  const at5 = store.getCharStateMap(sid, { branchId: 'main', atTurn: 5 });
  eq(at5['伍卿'].condition, '换了干衣', '新值对后续轮次生效');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 原声 ===');
{
  const sid = `s-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  for (let i = 1; i <= 5; i++) {
    store.addVoice(sid, { branchId: 'main', who: '凌玥', text: `第${i}句`, turn_no: i });
  }
  store.addVoice(sid, { branchId: 'main', who: '张兰', text: '去去去', turn_no: 1 });

  const map = store.getVoiceMap(sid, { branchId: 'main', perWho: 2 });
  eq(map['凌玥'].map((v) => v.text), ['第5句', '第4句'], '每人限量取最近（最新在前）');
  eq(map['凌玥'].map((v) => v.turn_no), [5, 4], '原声保留真实轮次（不再丢成第 0 轮）');
  eq(map['张兰'].map((v) => v.text), ['去去去'], '其他人不受影响');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 分支：回合可见性 ===');
{
  const sid = `s-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  for (let i = 1; i <= 3; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: `行动${i}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: i, kind: 'narrator', content: `正文${i}`, branch_id: 'main' });
  }

  store.createBranch(sid, { branchId: 'b2', parentBranch: 'main', forkTurn: 2 });
  store.addTurn(sid, { turn_no: 4, kind: 'player', content: '另一条路', branch_id: 'b2' });
  store.addTurn(sid, { turn_no: 4, kind: 'narrator', content: '另一种可能', branch_id: 'b2' });

  const inMain = store.getTurnsForBranch(sid, 'main', 0).map((t) => `${t.turn_no}${t.kind[0]}`);
  eq(inMain, ['1p', '1n', '2p', '2n', '3p', '3n'], 'main 分支只看得到自己的 3 轮');

  const inB2 = store.getTurnsForBranch(sid, 'b2', 2).map((t) => `${t.turn_no}${t.kind[0]}`);
  eq(inB2, ['1p', '1n', '2p', '2n', '4p', '4n'], 'b2 看得到继承的 1-2 轮 + 自己的第 4 轮');

  // n 的单位是「回合」不是「消息」：一个回合 = player + narrator 两条
  const recent = store.getRecentTurnsForBranch(sid, 'b2', 2, 2).map((t) => t.content);
  eq(recent, ['行动2', '正文2', '另一条路', '另一种可能'], '最近 2 个回合 = 4 条消息，按时间正序');

  const one = store.getRecentTurnsForBranch(sid, 'b2', 2, 1).map((t) => t.content);
  eq(one, ['另一条路', '另一种可能'], 'n=1 只取最后一个回合');

  const text = store.getRecentTextForBranch(sid, 'b2', 2, 8);
  ok(text.includes('另一种可能') && text.includes('正文1'), '分支原文含继承与新写');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 历史检索：FTS5 + 分支可见性 ===');
{
  const sid = `s-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  store.addTurn(sid, { turn_no: 1, kind: 'player', content: '我去找玥姐姐借伞。', branch_id: 'main' });
  store.addTurn(sid, { turn_no: 1, kind: 'narrator', content: '雨很大，玥姐姐在檐下等你。', branch_id: 'main' });
  store.addTurn(sid, { turn_no: 2, kind: 'player', content: '凌玥说她知道旧仓库。', branch_id: 'main' });
  store.addTurn(sid, { turn_no: 2, kind: 'narrator', content: '凌玥领你走进旧仓库。', branch_id: 'main' });

  eq(store.searchTurns(sid, '玥姐姐', { branchId: 'main' }).map((h) => h.turn_no), [1, 1], 'FTS5 能检索 ≥3 字中文子串');
  eq(store.searchTurns(sid, '凌玥', { branchId: 'main' }).map((h) => h.turn_no), [2, 2], '两字查询由 LIKE 兜底');
  eq(store.searchTurnsDetailed(sid, '玥姐姐', { branchId: 'main' }).engine, 'fts5', 'searchTurnsDetailed 自报 FTS5 主路');
  eq(store.searchTurnsDetailed(sid, '凌玥', { branchId: 'main' }).engine, 'like', 'searchTurnsDetailed 自报 LIKE 兜底');

  store.updateTurnContent(sid, 2, 'player', '梅雨天她撑伞等你。');
  eq(store.searchTurns(sid, '梅雨天', { branchId: 'main' }).map((h) => h.turn_no), [2], '段落改写后索引同步');
  eq(store.searchTurns(sid, '凌玥说她知道旧仓库', { branchId: 'main' }).length, 0, '旧内容不再命中');

  store.createBranch(sid, { branchId: 'b2', parentBranch: 'main', forkTurn: 2 });
  store.createBranch(sid, { branchId: 'b3', parentBranch: 'main', forkTurn: 2 });
  store.addTurn(sid, { turn_no: 3, kind: 'player', content: 'b2 线：我去了码头。', branch_id: 'b2' });
  store.addTurn(sid, { turn_no: 4, kind: 'player', content: 'b3 线：我去了书院。', branch_id: 'b3' });

  ok(store.searchTurns(sid, '旧仓库', { branchId: 'b2' }).length >= 1, 'b2 能检索到继承的父分支原文');
  eq(store.searchTurns(sid, '书院', { branchId: 'b2' }).length, 0, 'b2 检索不到兄弟分支的回合');
  eq(store.searchTurns(sid, '码头', { branchId: 'b3' }).length, 0, 'b3 也检索不到兄弟分支');
  eq(store.searchTurns(sid, '码头', { branchId: 'b2', atTurn: 2 }).length, 0, 'atTurn 之后的回合不参与检索');

  const r = await recall.recallHistory({ sessionId: sid, branchId: 'b2', atTurn: 3, query: '旧仓库' });
  ok(r.text.includes('【历史检索：旧仓库】'), 'recallHistory 渲染带标题');
  ok(r.hits.length >= 1 && r.meta.tokens > 0, 'recallHistory 返回命中与 token 预算');
  eq(r.meta.engine, 'fts5', 'recallHistory meta 自报检索引擎');
  ok(!r.text.includes('书院'), '召回文本不泄漏兄弟分支内容');

  const empty = recall.renderRecallResults('旧仓库', []);
  ok(empty.includes('没有在已经发生的回合里找到'), 'renderRecallResults 空命中给出确定文案');
  const capped = recall.renderRecallResults('旧仓库', [
    { turn_no: 1, kind: 'player', snippet: '一'.repeat(400) },
  ], { maxTokens: 20 });
  eq(capped.split('\n').length, 1, 'renderRecallResults 超预算时只保留标题');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 场记 ===');
{
  const sid = `s-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S001', turn_from: 1, turn_to: 4,
    when_label: '初冬', place: '雨街', cast: ['伍卿', '凌玥'],
    question: '她会不会认下这个乞丐？', outcome: '她把他带上了车',
    threads: ['七年前的雨夜'], state: { place: '雨街' },
  });
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S002', turn_from: 5, turn_to: 9,
    when_label: '当夜', place: '凌家院子', cast: ['伍卿', '凌玥', '黎婆'],
    question: '奶奶会接受她吗？', outcome: '逐客令', threads: [],
    state: { place: '凌家院子' },
  });

  const scenes = store.getScenes(sid, { branchId: 'main' });
  eq(scenes.length, 2, '两场记录');
  eq(scenes[0].question, '她会不会认下这个乞丐？', '场次要写成一个问题');
  ok(scenes[0].outcome.includes('带上了车'), '结局记局势变化');
  eq(store.getSceneAt(sid, 6, 'main').scene_id, 'S002', '按轮次定位场次');
  eq(store.latestScene(sid, 'main').scene_id, 'S002', '最近一场');

  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S002', turn_from: 5, turn_to: 11,
    question: '奶奶会接受她吗？', outcome: ' revised',
  });
  eq(store.getScenes(sid, { branchId: 'main' }).length, 2, '同 scene_id 是更新不是新增');
  eq(store.latestScene(sid, 'main').turn_to, 11, '更新生效');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 史官：净化与合并 ===');
{
  const card = schema.normalizeCard({
    title: 't',
    entities: [{ type: 'person', name: '凌玥', aliases: ['玥姐姐'] }, { type: 'person', name: '伍卿' }],
  });
  const idx = schema.buildAliasIndex(card);

  const a = arch.sanitizeAssertion({ subject: '玥姐姐', predicate: '知道', object: '七年前的真相', confidence: 9, visibility: 'x' }, idx);
  eq(a.subject, '凌玥', '断言主语按别名归一');
  eq(a.confidence, 1, 'confidence 越界被 clamp');
  eq(a.visibility, 'public', '非法 visibility 回落 public');
  ok(arch.sanitizeAssertion({ subject: '凌玥', predicate: '瞬移', object: 'x' }, idx) === null, '谓词不在白名单 → 拒绝');
  ok(arch.sanitizeAssertion({ subject: '', predicate: '知道', object: 'x' }, idx) === null, '缺主语 → 拒绝');

  const s = arch.sanitizeState({ who: '玥姐姐', field: 'mood', value: ' 急切 ' }, idx);
  eq(s, { who: '凌玥', field: 'mood', value: '急切' }, '状态键按别名归一并去空白');
  ok(arch.sanitizeState({ who: '凌玥', field: '心情', value: 'x' }, idx) === null, '字段不在白名单 → 拒绝');

  // life_state：受控词表，死亡/离场不再依赖自由文本关键词
  eq(arch.sanitizeState({ who: '凌玥', field: 'life_state', value: 'dead' }, idx),
    { who: '凌玥', field: 'life_state', value: 'dead' }, '受控生死值放行');
  eq(arch.sanitizeState({ who: '凌玥', field: 'life_state', value: ' DEAD ' }, idx),
    { who: '凌玥', field: 'life_state', value: 'dead' }, '受控值大小写归一');
  eq(arch.sanitizeState({ who: '凌玥', field: 'life_state', value: '已死' }, idx),
    { who: '凌玥', field: 'status', value: '已死' }, '枚举外不静默丢：回退 status 保留原文');
}

{
  const old = {
    time: '初冬', place: '雨街', tension: 0.3,
    characters: { 伍卿: { mood: '窘迫' }, 张兰: { mood: '轻蔑' } },
    inventory: [{ name: '玉佩', holder: '伍卿' }, { name: '空瓶' }],
    quests: [{ goal: '弄清她是谁', status: 'active' }],
  };
  const delta = {
    characters: { 玥姐姐: { condition: '西装肩上有雨' }, 伍卿: { mood: '松动' } },
    inventory_add: [{ name: '伞', holder: '凌玥' }],
    inventory_remove: ['空瓶'],
    quests_add: [{ goal: '查南荣家', status: 'active' }],
    quests_update: [{ goal: '弄清她是谁', progress: '还没问出口' }],
    last_hook: '她说出「以前认识」',
    tension: 0.72,
  };
  const card = schema.normalizeCard({ title: 't', entities: [{ type: 'person', name: '凌玥', aliases: ['玥姐姐'] }, { type: 'person', name: '伍卿' }] });
  const next = arch.mergeLedger(old, delta, { aliasIndex: schema.buildAliasIndex(card) });

  eq(next.tension, 0.72, '标量覆盖');
  eq(next.characters['凌玥'], { condition: '西装肩上有雨' }, '新角色键按别名归一');
  eq(next.characters['伍卿'], { mood: '松动' }, '已有角色字段合并');
  eq(next.characters['张兰'], { mood: '轻蔑' }, '未提及的角色原样保留');
  eq(next.inventory.map((i) => i.name), ['玉佩', '伞'], '物品增删');
  eq(next.quests.length, 2, '目标新增');
  eq(next.quests.find((q) => q.goal === '弄清她是谁').progress, '还没问出口', '目标按 goal 更新');
  eq(next.last_hook, '她说出「以前认识」', 'last_hook 覆盖');

  const noTension = arch.mergeLedger(old, { tension: null }, {});
  eq(noTension.tension, 0.3, '缺省张力不清零');
  const zeroTension = arch.mergeLedger(old, { tension: 0 }, {});
  eq(zeroTension.tension, 0, '显式 0 可以写入');

  const withPresent = arch.mergeLedger(old, { present: ['玥姐姐', '伍卿', '伍卿'] }, {
    aliasIndex: schema.buildAliasIndex(card),
  });
  eq(withPresent.present, ['凌玥', '伍卿'], '在场名单按别名归一、去重');
  const noPresent = arch.mergeLedger({ ...old, present: ['凌玥'] }, {}, {});
  eq(noPresent.present, ['凌玥'], '缺省 present 不清空上场名单');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 玩家视图：状态条只拿场景字段 ===');
{
  const persons = [
    { id: 'c-lingyue', type: 'person', name: '凌玥', aliases: ['玥姐姐'] },
    { id: 'c-wuqing', type: 'person', name: '伍卿' },
  ];
  const full = {
    time: '辰时', place: '凌府天井', weather: '细雨',
    tension: 0.8, last_hook: '玉佩在她袖中发烫',
    present: ['c-lingyue', ' 伍卿 ', '', null, '玥姐姐'],
    characters: { 凌玥: { mood: '戒备', goal: '藏起玉佩', condition: '袖口湿了' } },
    inventory: [{ name: '玉佩', holder: '凌玥' }],
    quests: [{ goal: '弄清玉佩来历', status: 'active' }],
    theme_tags: ['雨', '秘密'],
  };
  const view = playerView.buildPlayerView(full, { persons });

  eq(Object.keys(view).sort(), ['place', 'present', 'time', 'weather'], '字段白名单只有四个');
  eq(view.time, '辰时', '时间进视图');
  eq(view.place, '凌府天井', '地点进视图');
  eq(view.weather, '细雨', '天气进视图');
  eq(view.present, ['凌玥', '伍卿'], '在场 id/别名归一成显示名并去重');

  const serialized = JSON.stringify(view);
  for (const secret of ['戒备', '藏起玉佩', '玉佩', '弄清玉佩来历', '玉佩在她袖中发烫', '0.8', '秘密']) {
    ok(!serialized.includes(secret), `不投影账本细节：${secret}`);
  }

  eq(playerView.buildPlayerView(null), { time: '', place: '', weather: '', present: [] }, '空账本给空视图');
  eq(playerView.buildPlayerView('坏数据').present, [], '非对象账本不抛错');
  eq(playerView.buildPlayerView({ present: ['陌生路人'] }).present, ['陌生路人'], '不在卡司里的名字原样保留');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 史官：解析容错 ===');
{
  const good = arch.parseArchivistUpdate(JSON.stringify({
    scene_change: { changed: true, reason: '地点转移', place: '凌家院子', tension: 0.6 },
    ledger: { characters: { 凌玥: { mood: '克制', life_state: 'dead', goal: '' } }, last_hook: '钩子' },
    assertions: [{ subject: '凌玥', predicate: '知道', object: '真相', confidence: 0.95, evidence: '她看了一眼' }],
    states: [{ who: '伍卿', field: 'condition', value: '湿透' }],
    relations: [{ from: '凌玥', to: '伍卿', kind: '旧识·执念', sentiment: 0.8, note: '第一次没有甩开' }],
    threads: [{ action: 'plant', title: '玉佩发光', weight: 0.9 }],
    quotes: [{ who: '凌玥', text: '「卿儿，过来。」' }],
    uncertain: ['她这七年做了什么'],
  }));
  ok(good.scene_change.changed === true, '解析 scene_change');
  eq(good.assertions.length, 1, '解析断言');
  eq(good.ledger.characters['凌玥'], { mood: '克制', life_state: 'dead' },
    '账本人物收 life_state，空字段不进覆盖（避免用空串抹掉旧状态）');
  eq(good.quotes[0].who, '凌玥', '解析原声');
  eq(good.uncertain, ['她这七年做了什么'], '解析未确定项');

  const salvaged = arch.parseArchivistUpdate('前言文字\n{"assertions":[{"subject":"凌玥","predicate":"知道","object":"y"}]}\n后记');
  eq(salvaged.assertions.length, 1, '从夹杂文本里捞出 JSON');

  const empty = arch.parseArchivistUpdate('');
  ok(empty.scene_change.changed === false, '空输入降级不抛错');
  eq(empty.assertions, [], '空输入给空数组');

  const noTension = arch.parseArchivistUpdate('{"scene_change":{"changed":false}}');
  eq(noTension.scene_change.tension, null, '缺省 tension 解析为 null，不是 0');
  const withPresent = arch.parseArchivistUpdate('{"scene_change":{"present":["凌玥","伍卿"]}}');
  eq(withPresent.scene_change.present, ['凌玥', '伍卿'], '解析在场名单');

  const truncated = arch.parseArchivistUpdate('{"assertions":[{"subject":"凌玥","predicate":"知');
  ok(Array.isArray(truncated.assertions), '截断 JSON 不抛错');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 史官：确定性落库 ===');
{
  const sid = `s-${Date.now()}`;
  const world = {
    id: `w-${Date.now()}`, title: 't',
    card: schema.normalizeCard({
      title: 't',
      entities: [{ type: 'person', name: '凌玥', aliases: ['玥姐姐'] }, { type: 'person', name: '伍卿' }],
    }),
  };
  store.saveWorld(world);
  const session = store.createSession({ id: sid, title: 't', worldId: world.id });
  store.createBranch(sid, { branchId: 'main' });

  let r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 1,
    aliasIndex: schema.buildAliasIndex(world.card),
    update: {
      scene_change: { changed: false },
      ledger: { characters: { 凌玥: { mood: '急切' } }, last_hook: '她认出他' },
      assertions: [{ subject: '凌玥', predicate: '位于', object: '帝都', confidence: 1 }],
      states: [{ who: '伍卿', field: 'condition', value: '湿透' }],
      relations: [{ from: '凌玥', to: '伍卿', kind: '旧识·执念', sentiment: 0.8, note: '未说破' }],
      threads: [{ action: 'plant', title: '玉佩发光', weight: 0.9 }],
      quotes: [{ who: '凌玥', text: '「卿儿，过来。」' }],
    },
  });
  eq(r.assertions, 1, '第一轮写入 1 条断言');
  eq(r.states, 2, '写入 2 条状态（伍卿 condition + 凌玥 mood，不同人不同字段）');
  eq(r.threads, 1, '埋下 1 条线索');
  const st1 = store.getState(sid, { branchId: 'main', atTurn: 1 });
  eq(st1.turn_no, 1, 'states 行记录正确轮次');
  eq(st1.state.turn_no, 1, '账本对象内部轮次也同步');

  r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 5,
    aliasIndex: schema.buildAliasIndex(world.card),
    update: {
      scene_change: {},
      ledger: {},
      assertions: [{ subject: '凌玥', predicate: '位于', object: '湘曲', confidence: 1 }],
    },
  });
  eq(r.assertions, 1, '第二轮写入新断言');
  eq(r.assertions_invalidated, 1, '旧断言被标记失效');

  const active = store.getAssertions(sid, { branchId: 'main' });
  eq(active.length, 1, '有效集只剩新的');
  eq(active[0].object, '湘曲', '新断言生效');
  const hist = store.getAssertions(sid, { branchId: 'main', atTurn: 3 });
  eq(hist[0].object, '帝都', '回溯第 3 轮仍是帝都');

  r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 9,
    aliasIndex: [],
    update: { scene_change: {}, ledger: {}, threads: [{ action: 'resolve', title: '玉佩发光' }] },
  });
  eq(r.threads, 1, '回收线索');
  eq(store.getThreads(sid, { status: 'open' }).length, 0, '回收后无未回收线索');

  // 地点名能对上辞书 place 时自动补 place_id（当前地点加分不再依赖模型手写 id）。
  const placeIdx = [{ alias: '司楼', kind: 'codex', id: 'silou', name: '司楼', type: 'place' }];
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 10,
    aliasIndex: placeIdx,
    update: { scene_change: { changed: true, place: '司楼' } },
  });
  const st10 = store.getState(sid, { branchId: 'main', atTurn: 10 });
  eq(st10.state.place_id, 'silou', '地点名自动解析成 place_id');
  eq(st10.state.tension, undefined, '缺省张力不写入 0');

  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 11,
    aliasIndex: [{ alias: '凌府', kind: 'codex', id: 'ling-fu', name: '凌府', type: 'place' }],
    update: { scene_change: { changed: true, place: '凌府门口 → 凌府天井' } },
  });
  const st11 = store.getState(sid, { branchId: 'main', atTurn: 11 });
  eq(st11.state.place_id, 'ling-fu', '复合地名按实体链接解析 place_id');

  const patches = store.listPatches(sid, { limit: 50 });
  ok(patches.some((p) => p.kind === 'assertion' && p.status === 'applied'), '断言提案有审计');
  ok(patches.every((p) => p.agent === 'archivist'), '审计记录 Agent 名');

  const ledger = store.getState(sid).state;
  eq(ledger.characters['凌玥'].mood, '急切', '账本人物状态落库');
  eq(ledger.last_hook, '她认出他', '账本 last_hook 落库');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 提案白名单：越界目标拒写并留痕 ===');
{
  const sid = `declared-${Date.now()}`;
  const world = {
    id: `w-${Date.now()}`, title: 't',
    card: schema.normalizeCard({
      title: 't',
      entities: [{ type: 'person', name: '凌玥', aliases: ['玥姐姐'] }, { type: 'person', name: '伍卿' }],
    }),
  };
  store.saveWorld(world);
  store.createSession({ id: sid, title: 't', worldId: world.id });
  store.createBranch(sid, { branchId: 'main' });
  const aliasIndex = schema.buildAliasIndex(world.card);

  const declaredTargets = arch.buildDeclaredTargets({
    card: world.card, present: ['凌玥'], codex: [], ledgerCharacters: [], playerName: '',
  });
  ok(declaredTargets.includes('凌玥') && declaredTargets.includes('伍卿'), '声明集合包含人物实体');
  ok(declaredTargets.includes('玥姐姐'), '声明集合包含别名');
  ok(declaredTargets.includes('player'), '玩家永远允许');

  const r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 1, aliasIndex, declaredTargets,
    update: {
      scene_change: {},
      ledger: { characters: { 凌玥: { mood: '急切' }, 幽灵甲: { mood: '阴森' } } },
      assertions: [
        { subject: '凌玥', predicate: '位于', object: '帝都', confidence: 1 },
        { subject: '白袍客', predicate: '知道', object: '玉佩', confidence: 1 },
      ],
      states: [
        { who: '伍卿', field: 'condition', value: '湿透' },
        { who: '陌生人乙', field: 'mood', value: '敌意' },
      ],
      relations: [
        { from: '凌玥', to: '伍卿', kind: '旧识' },
        { from: '凌玥', to: '路人丙', kind: '敌对' },
      ],
    },
  });
  eq(r.assertions, 1, '声明内的断言写入');
  eq(r.states, 2, '声明内的状态写入（凌玥 mood + 伍卿 condition）');
  eq(r.relations, 1, '声明内的关系写入');
  eq(r.skipped, 4, '越界的账本人物/断言/状态/关系各 1 条');

  const st = store.getState(sid, { branchId: 'main', atTurn: 1 }).state;
  eq(st.characters['凌玥'].mood, '急切', '声明内账本人物落库');
  ok(!st.characters['幽灵甲'], '越界账本人物未落库');
  ok(!st.characters['陌生人乙'], '越界状态未落库');
  ok(!store.getAssertions(sid, { branchId: 'main' }).some((a) => a.subject === '白袍客'), '越界断言未落库');
  ok(!store.getRelations(sid, { branchId: 'main' }).some(
    (x) => [x.from_name, x.to_name].includes('路人丙'),
  ), '越界关系未落库');

  const skips = store.listPatches(sid, { limit: 50 }).filter((p) => p.kind === 'skipped_targets');
  eq(skips.length, 1, '越界项合并成一条 patches 记录');
  eq(skips[0].status, 'skipped', '状态 skipped，不静默');
  eq(skips[0].payload.items.length, 4, '明细可审计');

  // 未提供 declaredTargets 时不启用白名单（内部/测试路径保持旧行为）。
  const legacy = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 2, aliasIndex,
    update: {
      scene_change: {},
      assertions: [{ subject: '白袍客', predicate: '知道', object: '玉佩', confidence: 1 }],
    },
  });
  eq(legacy.assertions, 1, '未提供声明集合时不做白名单');
  eq(legacy.skipped, 0, '未提供声明集合时无越界计数');

  // 同一批提案里的 introduce 先纳入声明集合：模型可能先写账本/关系，再在 changes 声明引入。
  const introR = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 3, aliasIndex, declaredTargets,
    update: {
      scene_change: {},
      ledger: { characters: { 新面孔: { mood: '警觉' } } },
      assertions: [{ subject: '新面孔', predicate: '效忠', object: '凌玥', confidence: 1 }],
      relations: [{ from: '新面孔', to: '凌玥', kind: '主仆' }],
      changes: [{ kind: 'person', op: 'introduce', id: '新面孔', fields: { name: '新面孔', role: '探子' } }],
    },
  });
  eq(introR.skipped, 0, '同批 introduce 的实体不被自己的提案拒掉');
  eq(introR.changes, 1, 'introduce 落库');
  eq(introR.assertions, 1, '同批引入的断言落库');
  eq(introR.relations, 1, '同批引入的关系落库');
  ok(store.getAssertions(sid, { branchId: 'main' }).some((a) => a.subject === '新面孔'), '同批引入的断言可查');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 提案审计表 ===');
{
  const sid = `s-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });
  const id = store.addPatch(sid, { branchId: 'main', agent: 'continuity', kind: 'contradiction', severity: 'blocker', payload: { claim: '时间对不上' }, evidence: '第3轮原文' });
  store.setPatchStatus(sid, id, 'applied');
  const p = store.listPatches(sid, { limit: 5 })[0];
  eq(p.status, 'applied', '补丁状态可改');
  ok(p.applied_at > 0, '记录应用时间');
  eq(store.listPatches(sid, { status: 'open' }).length, 0, '按状态过滤');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 世界状态：变更校验 ===');
{
  const card = schema.normalizeCard({
    title: 't',
    entities: [
      { type: 'person', name: '凌玥', aliases: ['玥姐姐'] },
      { type: 'item', name: '玉佩' },
    ],
  });
  const idx = schema.buildAliasIndex(card);

  const add = arch.sanitizeChange(
    { kind: 'person', id: '玥姐姐', path: 'knowledge.knows', op: 'add', value: '七年前的真相' },
    { aliasIndex: idx },
  );
  eq(add.entity_id, '凌玥', '实体变更按别名归一到 id');
  eq(add.path, 'knowledge.knows', '知识路径放行');
  ok(arch.sanitizeChange(
    { kind: 'person', id: '凌玥', path: 'identity.age', op: 'set', value: '18' },
    { aliasIndex: idx },
  ) === null, '身份根不可写');
  ok(arch.sanitizeChange(
    { kind: 'person', id: '凌玥', path: 'knowledge.knows', op: 'set', value: 'x' },
    { aliasIndex: idx },
  ) === null, '列表路径不能用 set');
  ok(arch.sanitizeChange(
    { kind: 'person', id: '凌玥', path: 'mood', op: 'add', value: 'x' },
    { aliasIndex: idx },
  ) === null, '标量路径不能用 add');

  const introCodex = arch.sanitizeChange(
    { kind: 'place', fields: { name: '听雨楼', summary: '城南暗线' } },
    { aliasIndex: idx },
  );
  eq(introCodex.op, 'introduce', 'introduce 放行新实体');
  eq(introCodex.entity_id, '听雨楼', '新实体 id 由名字生成');

  ok(arch.sanitizeChange(
    { kind: 'item', id: '玉佩', path: 'summary', op: 'set', value: '改写定义' },
    { aliasIndex: idx },
  ) === null, '已有辞书定义不可改写');
  const codexRuntime = arch.sanitizeChange(
    { kind: 'item', id: '玉佩', path: 'status', op: 'set', value: '发绿光' },
    { aliasIndex: idx },
  );
  eq(codexRuntime.path, 'status', '辞书运行态可写');

  const player = arch.sanitizeChange(
    { kind: 'player', id: '伍卿', path: 'knowledge.knows', op: 'add', value: '凌玥认识他' },
    { aliasIndex: idx, playerName: '伍卿' },
  );
  eq(player.kind, 'player', '玩家角色命中玩家路径');
  eq(player.entity_id, 'player', '玩家实体统一为 player');

  // life_state 是受控路径：合法值原样落库，非法写法回退 status 而不是丢弃
  const dead = arch.sanitizeChange(
    { kind: 'person', id: '凌玥', path: 'life_state', op: 'set', value: 'dead' },
    { aliasIndex: idx },
  );
  eq(dead.path, 'life_state', '生死走受控路径');
  eq(dead.value, 'dead', '受控值原样保留');
  const oddDeath = arch.sanitizeChange(
    { kind: 'person', id: '凌玥', path: 'life_state', op: 'set', value: '战死' },
    { aliasIndex: idx },
  );
  eq(oddDeath.path, 'status', '枚举外的生死值回退 status（保留信息）');
  eq(oddDeath.value, '战死', '回退后原文仍在');
  const playerHurt = arch.sanitizeChange(
    { kind: 'player', id: '伍卿', path: 'life_state', op: 'set', value: 'injured' },
    { aliasIndex: idx, playerName: '伍卿' },
  );
  eq(playerHurt.value, 'injured', '玩家也支持 life_state');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 世界状态：落库与投影 ===');
{
  const sid = `s-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  const r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 3,
    aliasIndex: [], playerName: '伍卿',
    update: {
      scene_change: {}, ledger: {},
      changes: [
        { kind: 'person', id: 'a-jiu', path: 'knowledge.knows', op: 'add', value: '听雨楼在城南' },
        { kind: 'place', op: 'introduce', fields: { name: '听雨楼', summary: '暗线据点' } },
        { kind: 'person', id: 'a-jiu', op: 'introduce', fields: { name: '阿九', role: '跑堂' } },
      ],
    },
  });
  eq(r.changes, 3, '三条实体变更落库');

  const now = store.getWorldState(sid, { branchId: 'main', atTurn: 3 });
  eq(now.length, 3, '投影输入包含三条增量');
  const before = store.getWorldState(sid, { branchId: 'main', atTurn: 2 });
  eq(before.length, 0, '变更对之前的轮次不可见');

  const patches = store.listPatches(sid, { branchId: 'main', limit: 20 });
  ok(patches.some((p) => p.kind === 'world_change' && p.status === 'applied'), '实体变更进入审计');

  // 模型常把「学到 A 和 B」写成数组；投影必须逐项写入，不能拼成 "A,B"。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 4,
    aliasIndex: [], playerName: '伍卿',
    update: {
      changes: [{ kind: 'person', id: 'a-jiu', path: 'knowledge.knows', op: 'add', value: ['A', 'B'] }],
    },
  });
  const eff = effective.buildEffectiveWorld(schema.normalizeCard({ title: 't' }), store.getWorldState(sid, {
    branchId: 'main', atTurn: 4,
  }));
  const ajiu = eff.entities.find((c) => c.id === 'a-jiu' && c.type === 'person');
  ok(ajiu.knowledge.knows.includes('A'), '数组 add 逐项写入');
  ok(ajiu.knowledge.knows.includes('B'), '数组 add 不拼成一个字符串');

  // 辞书运行态进入 effective world，而不是改写定义。
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'place', entity_id: 'ling-fu',
    path: 'status', op: 'set', value: '全府戒严', turn: 5,
  });
  const effCodex = effective.buildEffectiveWorld(
    schema.normalizeCard({ title: 't', entities: [{ id: 'ling-fu', name: '凌府', type: 'place', summary: '主宅' }] }),
    store.getWorldState(sid, { branchId: 'main', atTurn: 5 }),
  );
  eq(effCodex.entities.find((e) => e.id === 'ling-fu').status, '全府戒严', '事实运行态进入投影');
  eq(effCodex.entities.find((e) => e.id === 'ling-fu').summary, '主宅', '定义不被运行态覆盖');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 分支：分叉复制世界状态 ===');
{
  const sid = `s-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  store.setState(sid, 2, { place: '雨街', turn_no: 2 }, 'main');
  store.setState(sid, 10, { place: '凌家院子', turn_no: 10 }, 'main');
  store.upsertRelation(sid, { branch_id: 'main', from: '凌玥', to: '伍卿', kind: '旧识', sentiment: 0.6 });
  store.upsertThread(sid, { branch_id: 'main', title: '玉佩发光', status: 'open', planted_turn: 2 });
  store.setCharState(sid, { branchId: 'main', who: '伍卿', field: 'condition', value: '湿透', turn: 1 });
  store.addAssertion(sid, {
    branch_id: 'main', subject: '凌玥', predicate: '位于', object: '雨街', valid_from: 1, source_turn: 1,
  });

  store.createBranch(sid, { branchId: 'b2', parentBranch: 'main', forkTurn: 2 });
  store.copyBranchState(sid, { fromBranch: 'main', toBranch: 'b2', forkTurn: 2 });

  eq(store.getState(sid, { branchId: 'b2', atTurn: 10 }).state.place, '雨街', '新分支回到分叉点，而不是旧线第 10 轮');
  eq(store.getRelations(sid, { branchId: 'b2' }).length, 1, '关系复制到新分支');
  eq(store.getThreads(sid, { branchId: 'b2' }).length, 1, '线索复制到新分支');
  eq(store.getCharStateMap(sid, { branchId: 'b2' }).伍卿.condition, '湿透', '人物状态复制到新分支');
  eq(store.getAssertions(sid, { branchId: 'b2' }).length, 1, '有效断言复制到新分支');
  eq(store.getState(sid, { branchId: 'main', atTurn: 10 }).state.place, '凌家院子', '旧分支保持原样');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 分支：嵌套分叉不读废弃兄弟分支 ===');
{
  const sid = `s-nested-${Date.now()}`;
  store.createSession({ id: sid, title: 'nested' });
  store.createBranch(sid, { branchId: 'main' });
  for (let n = 1; n <= 12; n++) {
    store.addTurn(sid, { turn_no: n, kind: 'player', content: `P${n}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: n, kind: 'narrator', content: `N${n}`, branch_id: 'main' });
  }

  const f1 = orch.forkSession({ sessionId: sid, toTurn: 8, note: 'b2' });
  store.addTurn(sid, { turn_no: 13, kind: 'player', content: 'P13', branch_id: f1.branch_id });
  store.addTurn(sid, { turn_no: 13, kind: 'narrator', content: 'N13', branch_id: f1.branch_id });
  const f2 = orch.forkSession({ sessionId: sid, toTurn: 13, note: 'b3' });

  const visible = store.getTurnsForBranch(sid, f2.branch_id, f2.fork_turn, { kinds: ['player'] });
  eq(visible.map((t) => t.turn_no), [1, 2, 3, 4, 5, 6, 7, 8, 13], 'b3 只看祖先链：main ≤8 + b2 第 13 轮');
  ok(!visible.some((t) => t.branch_id === 'main' && t.turn_no > 8), '看不到废弃兄弟分支的 9–12 轮');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 分支：关系/线索按分叉点重放 ===');
{
  const sid = `s-replay-${Date.now()}`;
  store.createSession({ id: sid, title: 'replay' });
  store.createBranch(sid, { branchId: 'main' });
  for (let n = 1; n <= 12; n++) {
    store.addTurn(sid, { turn_no: n, kind: 'player', content: `P${n}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: n, kind: 'narrator', content: `N${n}`, branch_id: 'main' });
  }

  store.upsertRelation(sid, {
    branch_id: 'main', from: '凌玥', to: '伍卿', kind: '旧识', sentiment: 0.3, turn_no: 1,
  });
  store.upsertThread(sid, {
    branch_id: 'main', title: '玉佩发光', status: 'open', planted_turn: 1, turn_no: 1,
  });
  // 分叉点之后才发生的变化：新线不应该看到。
  store.upsertRelation(sid, {
    branch_id: 'main', from: '凌玥', to: '伍卿', kind: '决裂', sentiment: -0.8, turn_no: 9,
  });
  store.upsertThread(sid, {
    branch_id: 'main', title: '玉佩发光', status: 'resolved', resolved_turn: 9, turn_no: 9,
  });
  store.upsertRelation(sid, {
    branch_id: 'main', from: '姬凡', to: '伍卿', kind: '敌意', sentiment: -0.5, turn_no: 9,
  });
  store.upsertThread(sid, {
    branch_id: 'main', title: '第九轮才埋的线索', status: 'open', planted_turn: 9, turn_no: 9,
  });

  const f = orch.forkSession({ sessionId: sid, toTurn: 8, note: '回滚' });
  const rel = store.getRelations(sid, { branchId: f.branch_id });
  eq(rel.find((r) => r.from_name === '凌玥' && r.to_name === '伍卿').kind, '旧识', '关系回到分叉点的版本');
  ok(!rel.some((r) => r.from_name === '姬凡'), '分叉后才建立的关系不出现');

  const th = store.getThreads(sid, { branchId: f.branch_id });
  eq(th.find((t) => t.title === '玉佩发光').status, 'open', '线索回到未回收状态');
  ok(!th.some((t) => t.title === '第九轮才埋的线索'), '分叉后才埋的线索不出现');

  const mainRel = store.getRelations(sid, { branchId: 'main' });
  eq(mainRel.find((r) => r.from_name === '凌玥' && r.to_name === '伍卿').kind, '决裂', '旧分支保持原样');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 定稿：世界线 → 新世界卡 ===');
{
  const baseCard = schema.normalizeCard({
    title: '定稿测试',
    entities: [{ id: 'ling-yue', type: 'person', name: '凌玥', role: '家主', knowledge: { knows: ['旧事'] } }],
    anchors: [{ id: 'prologue', label: '序章', snapshot: { place: '雨街' }, opening_seed: '雨落下来。' }],
    player: { name: '伍卿' },
  });
  const wid = `w-canon-${Date.now()}`;
  store.saveWorld({ id: wid, title: '定稿测试', card: baseCard });
  const sid = `s-canon-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: wid, title: '本局', cardSnapshot: baseCard, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  store.addTurn(sid, { turn_no: 1, kind: 'player', content: '我走进雨里。', branch_id: 'main' });
  store.addTurn(sid, { turn_no: 1, kind: 'narrator', content: '雨更大了。', branch_id: 'main' });
  store.setState(sid, 1, { place: '凌家院子', time: '当夜', turn_no: 1 }, 'main');
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'person', entity_id: 'ling-yue',
    path: 'knowledge.knows', op: 'add', value: '她后来才知道的事', turn: 1,
  });
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'place', entity_id: 'tingyu-lou',
    op: 'introduce', value: { type: 'place', name: '听雨楼', summary: '暗线据点' }, turn: 1,
  });
  store.upsertThread(sid, { branch_id: 'main', title: '玉佩还在发绿光', status: 'open', planted_turn: 1 });
  store.upsertRelation(sid, {
    branch_id: 'main', from: '凌玥', to: '伍卿', kind: '旧识·执念', sentiment: 0.7, note: '雨里没有甩开',
  });

  const out = orch.canonizeSession({ sessionId: sid, title: '定稿后的世界', anchorLabel: '从雨夜继续' });
  ok(!!out.world.id && out.world.id !== wid, '定稿生成独立的新世界卡');
  const newCast = out.card.entities.find((c) => c.id === 'ling-yue' && c.type === 'person');
  ok(newCast.knowledge.knows.includes('她后来才知道的事'), '人物知识被固化进新卡');
  ok(out.card.entities.some((c) => c.type !== 'person' && c.name === '听雨楼'), '剧情新增地点被固化进新卡');
  ok(out.card.anchors.some((a) => a.id === 'line-1' && a.snapshot.place === '凌家院子'), '当前账本成为新锚点');
  ok(out.card.author_notes.some((n) => n.text.includes('玉佩还在发绿光')), '未回收线索写进作者笔记');
  ok(newCast.relations.some((r) => r.to === '伍卿' && r.kind === '旧识·执念'), '关系账本并回人物卡');

  const nextSession = orch.createSessionWithSettings({
    title: '续章', worldId: out.world.id, anchorId: 'line-1',
  });
  ok(store.getRelations(nextSession.id, { branchId: 'main' })
    .some((r) => r.from_name === '凌玥' && r.to_name === '伍卿'), '新会话从卡片关系初始化账本');

  const oldCard = store.getWorld(wid).card;
  ok(!oldCard.entities.find((c) => c.id === 'ling-yue' && c.type === 'person').knowledge.knows.includes('她后来才知道的事'), '原世界卡不被改写');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 场次记录：取代滚动摘要的记忆载体 ===');
{
  const sid = `scene-${Date.now()}`;
  store.createSession({ id: sid, title: 'scene' });
  store.createBranch(sid, { branchId: 'main' });

  for (let i = 1; i <= 10; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: `行动${i}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: i, kind: 'narrator', content: `正文${i}`, branch_id: 'main' });
  }

  eq(store.getScenes(sid, { branchId: 'main' }).length, 0, '没有封场时场次为空');

  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S001', level: 1, turn_from: 1, turn_to: 4,
    place: '雨街', question: '她会不会认下他？', outcome: '她当众认下了他。',
    key_detail: '三十一块八毛', causal: '', importance: 'major',
    threads: ['玉佩'], hooks: ['玉佩为什么发光'],
  });
  const s1 = store.latestScene(sid, 'main');
  ok(s1 && s1.scene_id === 'S001', '场次写入成功');
  eq(s1.key_detail, '三十一块八毛', '关键细节独立成列（不再被拼进 outcome 后截断）');
  eq(s1.hooks, ['玉佩为什么发光'], '钩子独立存列');
  eq(s1.causal, '', '因果连接可为空');
  eq(s1.importance, 'major', '重要度落库');

  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S002', level: 1, turn_from: 5, turn_to: 8,
    place: '凌府', outcome: '他留下了。',
  });
  eq(store.getScenes(sid, { branchId: 'main' }).length, 2, '两场都在');
  eq(store.latestScene(sid, 'main').scene_id, 'S002', '最新场次正确');
  eq(store.getSceneAt(sid, 6, 'main').scene_id, 'S002', '按轮次定位场次');

  // 同一 scene_id 再写只扩展内容，不新增行（追加轮次时的正常路径）。
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S002', level: 1, turn_from: 5, turn_to: 9,
    place: '凌府', outcome: '他留下了，但没答应。', key_detail: '烫金帖子',
  });
  eq(store.getScenes(sid, { branchId: 'main' }).length, 2, '同一场次不新增行');
  eq(store.latestScene(sid, 'main').turn_to, 9, 'turn_to 被扩展');
  eq(store.latestScene(sid, 'main').key_detail, '烫金帖子', '内容被更新');

  // fork：场次记录按 turn_to 复制
  store.createBranch(sid, { branchId: 'b2', parentBranch: 'main', forkTurn: 5 });
  store.copyBranchState(sid, { fromBranch: 'main', toBranch: 'b2', forkTurn: 5 });
  eq(store.getScenes(sid, { branchId: 'b2' }).length, 1, '只复制分叉点之前已封的场次（S002 的 turn_to=9 > forkTurn=5）');
  eq(store.getScenes(sid, { branchId: 'b2' })[0].scene_id, 'S001', '复制的是 S001');
  // 回归：copyBranchState 的列清单曾漏掉 key_detail / causal / importance / hooks_json，
  // 结果 fork 之后所有历史大事件在时间轴上降级成 normal、细节整段消失。
  const b2S1 = store.getScenes(sid, { branchId: 'b2' })[0];
  eq(b2S1.key_detail, '三十一块八毛', 'fork 保留关键细节（时间轴 major 展开依赖它）');
  eq(b2S1.hooks, ['玉佩为什么发光'], 'fork 保留钩子');
  eq(b2S1.importance, 'major', 'fork 保留重要度，不被降级成 normal');
  eq(store.getScenes(sid, { branchId: 'main' }).length, 2, '旧分支场次保持原样');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 摘要层已移除：表与函数都不存在 ===');
{
  const hasTable = store.getDb().prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='summaries'`,
  ).get();
  ok(!hasTable, 'summaries 表不存在（长程记忆改由 scenes 承担）');
  eq(typeof store.addSummary, 'undefined', 'addSummary 已删除');
  eq(typeof store.getActiveSummary, 'undefined', 'getActiveSummary 已删除');
  eq(typeof store.getSummaries, 'undefined', 'getSummaries 已删除');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 分支写入：branch_id 必须显式，缺失即报错（不再静默兜底 main） ===');
{
  const sid = `br-req-${Date.now()}`;
  store.createSession({ id: sid, title: 'brreq' });
  store.createBranch(sid, { branchId: 'main' });

  const throwsOn = (fn) => {
    try { fn(); return false; } catch { return true; }
  };
  ok(throwsOn(() => store.addAssertion(sid, { subject: 'A', predicate: '位于', object: 'B' })),
    'addAssertion 缺 branch_id 抛错');
  ok(throwsOn(() => store.addVoice(sid, { who: 'A', text: 'hi' })), 'addVoice 缺 branch_id 抛错');
  ok(throwsOn(() => store.addPatch(sid, { agent: 'x', kind: 'y' })), 'addPatch 缺 branch_id 抛错');

  // camelCase 也必须被接受（历史调用方这么传过），但绝不能被兜底成 main。
  store.createBranch(sid, { branchId: 'b2', parentBranch: 'main', forkTurn: 0 });
  const aCamel = store.addAssertion(sid, { branchId: 'b2', subject: '丙', predicate: '位于', object: '丁', valid_from: 1 });
  const vCamel = store.addVoice(sid, { branchId: 'b2', who: '丙', text: '一句', turn_no: 1 });
  const pCamel = store.addPatch(sid, { branchId: 'b2', agent: 'x', kind: 'y' });
  ok(aCamel > 0 && vCamel > 0 && pCamel > 0, 'camelCase branchId 仍然可用');

  eq(store.getAssertions(sid, { branchId: 'b2' }).map((a) => a.subject), ['丙'], '断言落在指定分支');
  eq(store.getAssertions(sid, { branchId: 'main' }).length, 0, '没有写进 main');
  eq(store.getVoices(sid, { branchId: 'b2' }).length, 1, '原声落在指定分支');
  eq(store.getVoices(sid, { branchId: 'main' }).length, 0, '原声没有写进 main');
  eq(store.listPatches(sid, { branchId: 'b2' }).length, 1, '审计落在指定分支');
  eq(store.listPatches(sid, { branchId: 'main' }).length, 0, '审计没有写进 main');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 分支复制：不把旧线「分叉之后才发生的失效」带进新分支 ===');
{
  const sid = `fork-vt-${Date.now()}`;
  store.createSession({ id: sid, title: 'forkvt' });
  store.createBranch(sid, { branchId: 'main' });

  // 第 1 轮：A 位于「甲」。第 5 轮：A 改到「乙」，甲被失效（valid_to=5）。
  const a1 = store.addAssertion(sid, {
    branch_id: 'main', subject: '甲', predicate: '位于', object: '甲地', valid_from: 1, source_turn: 1,
  });
  store.addAssertion(sid, {
    branch_id: 'main', subject: '甲', predicate: '位于', object: '乙地', valid_from: 5, source_turn: 5,
  });
  store.invalidateAssertion(sid, a1, { validTo: 5 });

  store.setCharState(sid, { branchId: 'main', who: '甲', field: 'condition', value: '完好', turn: 1 });
  store.setCharState(sid, { branchId: 'main', who: '甲', field: 'condition', value: '重伤', turn: 5 });
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'person', entity_id: '甲', path: 'mood',
    op: 'set', value: '平静', turn: 1,
  });
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'person', entity_id: '甲', path: 'mood',
    op: 'set', value: '暴怒', turn: 5,
  });

  // 从第 2 轮分叉（在「甲」失效之前）。
  store.createBranch(sid, { branchId: 'b2', parentBranch: 'main', forkTurn: 2 });
  store.copyBranchState(sid, { fromBranch: 'main', toBranch: 'b2', forkTurn: 2 });

  const b2Assertions = store.getAssertions(sid, { branchId: 'b2' });
  eq(b2Assertions.map((a) => a.object), ['甲地'], '分叉后仍能看到当时的事实（甲地被复制为有效）');
  eq(b2Assertions[0].valid_to, null, '失效时刻没有被带过来');
  eq(b2Assertions[0].status, 'active', '失效状态被重置为 active');

  const b2At6 = store.getAssertions(sid, { branchId: 'b2', atTurn: 6 });
  eq(b2At6.map((a) => a.object), ['甲地'], '新分支第 6 轮位置不凭空消失');

  eq(store.getCharStateMap(sid, { branchId: 'b2', atTurn: 6 }).甲.condition, '完好',
    '新分支人物状态不凭空失效');
  const b2Mood = store.getWorldState(sid, { branchId: 'b2', atTurn: 6 })
    .filter((d) => d.path === 'mood').map((d) => d.value);
  eq(b2Mood, ['平静'], '新分支 world_state 不凭空失效');

  // 旧线必须保持原样（失效仍然有效）。
  const mainAt6 = store.getAssertions(sid, { branchId: 'main', atTurn: 6 });
  eq(mainAt6.map((a) => a.object), ['乙地'], '旧分支的第 6 轮仍是新事实');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 会话遥测：按 Agent 分路累计（旁路不再是缺失的分母） ===');
{
  const sid = `usage-${Date.now()}`;
  store.createSession({ id: sid, title: 'usage' });

  store.accumulateUsage(sid, { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 40, duration_ms: 5 }, 'narrator');
  store.accumulateUsage(sid, { prompt_tokens: 50, completion_tokens: 5, cached_tokens: 0, duration_ms: 3 }, 'archivist');
  store.accumulateUsage(sid, { prompt_tokens: 20, completion_tokens: 2, cached_tokens: 0, duration_ms: 1 }, 'branch');
  const u = store.getSession(sid).usage;

  eq(u.requests, 3, '三次调用全部计数');
  eq(u.prompt_tokens, 170, '总额含旁路');
  eq(u.cached_tokens, 40, '缓存命中累计');
  eq(u.by_agent.narrator.prompt_tokens, 100, 'narrator 分路独立');
  eq(u.by_agent.archivist.prompt_tokens, 50, 'archivist 分路独立');
  eq(u.by_agent.branch.prompt_tokens, 20, 'branch 分路独立');
  eq(Object.keys(u.by_agent).length, 3, '分路数是 3');

  // 缺 usage 时不记一次请求（避免把空气泡算进成本）。
  store.accumulateUsage(sid, null, 'world-tick');
  eq(store.getSession(sid).usage.requests, 3, '空 usage 不增加请求数');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 分支守卫：异步写入不落到旧分支 ===');
{
  const guard = await import('../server/memory/branch-guard.js');
  const sid = `guard-${Date.now()}`;
  store.createSession({ id: sid, title: 'guard' });
  store.createBranch(sid, { branchId: 'main' });
  store.addTurn(sid, { turn_no: 1, kind: 'player', content: '走', branch_id: 'main' });

  const snap = guard.branchSnapshot(sid, 'main');
  ok(guard.isBranchCurrent(snap), '刚取的快照成立');
  store.addTurn(sid, { turn_no: 1, kind: 'narrator', content: '走了', branch_id: 'main' });
  ok(!guard.isBranchCurrent(snap), '同一分支新增回合后旧快照失效');

  const snap2 = guard.branchSnapshot(sid, 'main');
  orch.forkSession({ sessionId: sid, toTurn: 1, note: 'test fork' });
  ok(!guard.isBranchCurrent(snap2), '切分支后旧快照失效');
  ok(guard.isBranchCurrent(guard.branchSnapshot(sid)), '新分支快照成立');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 幂等回执：同一 effect_id 只落一次 ===');
{
  const guard = await import('../server/memory/branch-guard.js');
  const sid = `effect-${Date.now()}`;
  store.createSession({ id: sid, title: 'effect' });
  store.createBranch(sid, { branchId: 'main' });

  const base = {
    sessionId: sid, branchId: 'main', turnNo: 3, agent: 'archivist',
    effectId: guard.makeEffectId('archivist', 't3'),
    fingerprint: guard.hashFingerprint('archivist', 3, 'main', '行动', '正文'),
  };
  eq(base.effectId, 'archivist:t3', 'effect_id 稳定可读');
  eq(base.fingerprint.length, 40, '指纹是 sha1 摘要，不把正文写进回执');

  const c1 = store.claimEffect(base);
  ok(c1.claimed, '首次认领拿到执行权');
  eq(c1.status, 'pending', '首次落 pending');
  ok(store.claimEffect(base).claimed, 'pending 同指纹可重试');

  store.settleEffect(sid, base.effectId, { branchId: 'main', status: 'applied' });
  const receipt = store.getEffectReceipt(sid, base.effectId, { branchId: 'main' });
  eq(receipt.status, 'applied', '落库后回执 applied');
  ok(receipt.applied_at > 0, '记录 applied_at');

  const c2 = store.claimEffect(base);
  ok(!c2.claimed, 'applied 后重复认领不再执行');
  eq(c2.status, 'applied', '跳过原因是 applied');

  const c3 = store.claimEffect({ ...base, fingerprint: 'changed-input' });
  ok(!c3.claimed && c3.conflict, '同 effect_id 换输入 → 冲突拒绝，不静默覆盖');

  let calls = 0;
  const run = async () => { calls += 1; return { applied: 2 }; };
  const runOnce = { sessionId: sid, branchId: 'main', turnNo: 4, agent: 'archivist', effectId: 'archivist:t4', fingerprint: 'fp4' };
  const r1 = await guard.runEffectOnce(runOnce, run);
  const r2 = await guard.runEffectOnce(runOnce, run);
  eq(calls, 1, '同一 effect 只执行一次');
  ok(!r1.skipped && r1.status === 'applied', '首次执行并落 applied');
  ok(r2.skipped, '第二次直接跳过');
  eq(store.getEffectReceipt(sid, 'archivist:t4', { branchId: 'main' }).status, 'applied', '执行后回执已落库');

  const staleRun = await guard.runEffectOnce(
    { sessionId: sid, branchId: 'main', turnNo: 5, agent: 'scene_keeper', effectId: 'scene:t5', fingerprint: 'fp5' },
    async () => null,
    { isStale: (r) => r === null },
  );
  eq(staleRun.status, 'stale', '守卫判定失效 → 回执 stale');
  ok(!store.claimEffect({ sessionId: sid, branchId: 'main', turnNo: 5, agent: 'scene_keeper', effectId: 'scene:t5', fingerprint: 'fp5' }).claimed,
    'stale 后不再重放（旧线丢弃不回写）');

  let threw = false;
  try {
    await guard.runEffectOnce(
      { sessionId: sid, branchId: 'main', turnNo: 6, agent: 'world_tick', effectId: 'world_tick:t6', fingerprint: 'fp6' },
      async () => { throw new Error('boom'); },
    );
  } catch { threw = true; }
  ok(threw, '失败向上抛');
  eq(store.getEffectReceipt(sid, 'world_tick:t6', { branchId: 'main' }).status, 'failed', '失败回执 failed');
  ok(store.claimEffect({ sessionId: sid, branchId: 'main', turnNo: 6, agent: 'world_tick', effectId: 'world_tick:t6', fingerprint: 'fp6' }).claimed,
    'failed 回执可重试（供重放）');

  // fork：分叉点之前已 applied 的回执随状态复制，之后的/失败的旧线回执不带过去。
  store.createBranch(sid, { branchId: 'b2' });
  store.copyBranchState(sid, { fromBranch: 'main', toBranch: 'b2', forkTurn: 3 });
  eq(store.getEffectReceipt(sid, 'archivist:t3', { branchId: 'b2' })?.status, 'applied', '分叉点前 applied 回执复制到新分支');
  ok(!store.getEffectReceipt(sid, 'archivist:t4', { branchId: 'b2' }), '分叉点之后的回执不带过去');
  ok(!store.getEffectReceipt(sid, 'world_tick:t6', { branchId: 'b2' }), 'failed 回执不带过去');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 史官解析失败：严格判定与失败回灌 ===');
{
  const bad = arch.parseArchivistUpdateStrict('这一轮不是 JSON，只是一段解释。');
  eq(bad.ok, false, '非 JSON 判定失败');
  ok(bad.error.includes('JSON'), '失败原因可读');
  eq(bad.update.assertions?.length, 0, '失败时返回空提案形状');

  const empty = arch.parseArchivistUpdateStrict('   ');
  eq(empty.ok, false, '空输出判定失败');

  const good = arch.parseArchivistUpdateStrict('{"scene_change":{"changed":true},"assertions":[]}');
  eq(good.ok, true, '合法 JSON 对象判定成功');
  eq(good.update.scene_change.changed, true, '成功时返回归一后的 update');

  const fenced = arch.parseArchivistUpdateStrict('```json\n{"scene_change":{"changed":true}}\n```');
  eq(fenced.ok, true, '代码块包裹仍可打捞（沿用既有容错）');

  const base = [{ role: 'system', content: '系统提示' }, { role: 'user', content: '本轮输入' }];
  const retryMsgs = arch.buildArchivistRetryMessages(base, '坏输出'.repeat(800), '输出不是合法 JSON 对象');
  eq(retryMsgs.length, 4, '回灌 = 原消息 + assistant 坏输出 + user 纠正');
  eq(retryMsgs[0].role, 'system', 'system 仍在最前');
  eq(retryMsgs.filter((m) => m.role === 'system').length, 1, '只有一条 system，不新增注入点');
  ok(retryMsgs[2].role === 'assistant' && retryMsgs[2].content.length <= 2000, '坏输出作为 assistant 回灌且截断');
  ok(retryMsgs[3].content.includes('JSON'), '纠正消息明确要求重发 JSON');
  ok(retryMsgs[3].content.includes('不要代码块'), '要求只输出 JSON 对象');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-memory: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
