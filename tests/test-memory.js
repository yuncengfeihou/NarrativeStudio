#!/usr/bin/env node
/**
 * tests/test-memory.js — 记忆系统 v4 的确定性逻辑（无网络）
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

  const a1 = store.addAssertion(sid, { subject: '凌玥', predicate: '位于', object: '帝都', valid_from: 1, source_turn: 1 });
  const a2 = store.addAssertion(sid, { subject: '凌玥', predicate: '位于', object: '湘曲', valid_from: 5, source_turn: 5 });

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

  store.addAssertion(sid, { subject: '凌玥', predicate: '想要', object: '带走他', valid_from: 6, source_turn: 6 });
  eq(store.getAssertions(sid, { branchId: 'main', subject: '凌玥' }).length, 2, '不同谓词不冲突');

  store.retractAssertion(sid, a2);
  eq(store.getAssertions(sid, { branchId: 'main' }).length, 1, '撤回后退出有效集');
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
  eq(map['凌玥'], ['第5句', '第4句'], '每人限量取最近');
  eq(map['张兰'], ['去去去'], '其他人不受影响');
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
    cast: [{ name: '凌玥', aliases: ['玥姐姐'] }, { name: '伍卿' }],
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
  const card = schema.normalizeCard({ title: 't', cast: [{ name: '凌玥', aliases: ['玥姐姐'] }, { name: '伍卿' }] });
  const next = arch.mergeLedger(old, delta, { aliasIndex: schema.buildAliasIndex(card) });

  eq(next.tension, 0.72, '标量覆盖');
  eq(next.characters['凌玥'], { condition: '西装肩上有雨' }, '新角色键按别名归一');
  eq(next.characters['伍卿'], { mood: '松动' }, '已有角色字段合并');
  eq(next.characters['张兰'], { mood: '轻蔑' }, '未提及的角色原样保留');
  eq(next.inventory.map((i) => i.name), ['玉佩', '伞'], '物品增删');
  eq(next.quests.length, 2, '目标新增');
  eq(next.quests.find((q) => q.goal === '弄清她是谁').progress, '还没问出口', '目标按 goal 更新');
  eq(next.last_hook, '她说出「以前认识」', 'last_hook 覆盖');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 史官：解析容错 ===');
{
  const good = arch.parseArchivistUpdate(JSON.stringify({
    scene_change: { changed: true, reason: '地点转移', place: '凌家院子', tension: 0.6 },
    ledger: { characters: { 凌玥: { mood: '克制' } }, last_hook: '钩子' },
    assertions: [{ subject: '凌玥', predicate: '知道', object: '真相', confidence: 0.95, evidence: '她看了一眼' }],
    states: [{ who: '伍卿', field: 'condition', value: '湿透' }],
    relations: [{ from: '凌玥', to: '伍卿', kind: '旧识·执念', sentiment: 0.8, note: '第一次没有甩开' }],
    threads: [{ action: 'plant', title: '玉佩发光', weight: 0.9 }],
    quotes: [{ who: '凌玥', text: '「卿儿，过来。」' }],
    uncertain: ['她这七年做了什么'],
  }));
  ok(good.scene_change.changed === true, '解析 scene_change');
  eq(good.assertions.length, 1, '解析断言');
  eq(good.quotes[0].who, '凌玥', '解析原声');
  eq(good.uncertain, ['她这七年做了什么'], '解析未确定项');

  const salvaged = arch.parseArchivistUpdate('前言文字\n{"assertions":[{"subject":"凌玥","predicate":"知道","object":"y"}]}\n后记');
  eq(salvaged.assertions.length, 1, '从夹杂文本里捞出 JSON');

  const empty = arch.parseArchivistUpdate('');
  ok(empty.scene_change.changed === false, '空输入降级不抛错');
  eq(empty.assertions, [], '空输入给空数组');

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
      cast: [{ name: '凌玥', aliases: ['玥姐姐'] }, { name: '伍卿' }],
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

  const patches = store.listPatches(sid, { limit: 50 });
  ok(patches.some((p) => p.kind === 'assertion' && p.status === 'applied'), '断言提案有审计');
  ok(patches.every((p) => p.agent === 'archivist'), '审计记录 Agent 名');

  const ledger = store.getState(sid).state;
  eq(ledger.characters['凌玥'].mood, '急切', '账本人物状态落库');
  eq(ledger.last_hook, '她认出他', '账本 last_hook 落库');
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
    cast: [{ name: '凌玥', aliases: ['玥姐姐'] }],
    codex: [{ name: '玉佩' }],
  });
  const idx = schema.buildAliasIndex(card);

  const add = arch.sanitizeChange(
    { kind: 'cast', id: '玥姐姐', path: 'knowledge.knows', op: 'add', value: '七年前的真相' },
    { aliasIndex: idx },
  );
  eq(add.entity_id, '凌玥', '实体变更按别名归一到 id');
  eq(add.path, 'knowledge.knows', '知识路径放行');
  ok(arch.sanitizeChange(
    { kind: 'cast', id: '凌玥', path: 'identity.age', op: 'set', value: '18' },
    { aliasIndex: idx },
  ) === null, '身份根不可写');
  ok(arch.sanitizeChange(
    { kind: 'cast', id: '凌玥', path: 'knowledge.knows', op: 'set', value: 'x' },
    { aliasIndex: idx },
  ) === null, '列表路径不能用 set');
  ok(arch.sanitizeChange(
    { kind: 'cast', id: '凌玥', path: 'mood', op: 'add', value: 'x' },
    { aliasIndex: idx },
  ) === null, '标量路径不能用 add');

  const introCodex = arch.sanitizeChange(
    { kind: 'codex', fields: { type: 'place', name: '听雨楼', summary: '城南暗线' } },
    { aliasIndex: idx },
  );
  eq(introCodex.op, 'introduce', 'introduce 放行新实体');
  eq(introCodex.entity_id, '听雨楼', '新实体 id 由名字生成');

  const player = arch.sanitizeChange(
    { kind: 'player', id: '伍卿', path: 'knowledge.knows', op: 'add', value: '凌玥认识他' },
    { aliasIndex: idx, playerName: '伍卿' },
  );
  eq(player.kind, 'player', '玩家角色命中玩家路径');
  eq(player.entity_id, 'player', '玩家实体统一为 player');
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
        { kind: 'cast', id: 'a-jiu', path: 'knowledge.knows', op: 'add', value: '听雨楼在城南' },
        { kind: 'codex', op: 'introduce', fields: { type: 'place', name: '听雨楼', summary: '暗线据点' } },
        { kind: 'cast', id: 'a-jiu', op: 'introduce', fields: { name: '阿九', role: '跑堂' } },
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
console.log('\n=== 定稿：世界线 → 新世界卡 ===');
{
  const baseCard = schema.normalizeCard({
    title: '定稿测试',
    cast: [{ id: 'ling-yue', name: '凌玥', role: '家主', knowledge: { knows: ['旧事'] } }],
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
    branch_id: 'main', entity_kind: 'cast', entity_id: 'ling-yue',
    path: 'knowledge.knows', op: 'add', value: '她后来才知道的事', turn: 1,
  });
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'codex', entity_id: 'tingyu-lou',
    op: 'introduce', value: { type: 'place', name: '听雨楼', summary: '暗线据点' }, turn: 1,
  });
  store.upsertThread(sid, { branch_id: 'main', title: '玉佩还在发绿光', status: 'open', planted_turn: 1 });
  store.upsertRelation(sid, {
    branch_id: 'main', from: '凌玥', to: '伍卿', kind: '旧识·执念', sentiment: 0.7, note: '雨里没有甩开',
  });

  const out = orch.canonizeSession({ sessionId: sid, title: '定稿后的世界', anchorLabel: '从雨夜继续' });
  ok(!!out.world.id && out.world.id !== wid, '定稿生成独立的新世界卡');
  const newCast = out.card.cast.find((c) => c.id === 'ling-yue');
  ok(newCast.knowledge.knows.includes('她后来才知道的事'), '人物知识被固化进新卡');
  ok(out.card.codex.some((c) => c.name === '听雨楼'), '剧情新增地点被固化进新卡');
  ok(out.card.anchors.some((a) => a.id === 'line-1' && a.snapshot.place === '凌家院子'), '当前账本成为新锚点');
  ok(out.card.author_notes.some((n) => n.text.includes('玉佩还在发绿光')), '未回收线索写进作者笔记');
  ok(newCast.relations.some((r) => r.to === '伍卿' && r.kind === '旧识·执念'), '关系账本并回人物卡');

  const nextSession = orch.createSessionWithSettings({
    title: '续章', worldId: out.world.id, anchorId: 'line-1',
  });
  ok(store.getRelations(nextSession.id, { branchId: 'main' })
    .some((r) => r.from_name === '凌玥' && r.to_name === '伍卿'), '新会话从卡片关系初始化账本');

  const oldCard = store.getWorld(wid).card;
  ok(!oldCard.cast.find((c) => c.id === 'ling-yue').knowledge.knows.includes('她后来才知道的事'), '原世界卡不被改写');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 前情提要：摘要、覆盖边界、分支复制 ===');
{
  const sid = `sum-${Date.now()}`;
  store.createSession({ id: sid, title: 'summary' });
  store.createBranch(sid, { branchId: 'main' });
  for (let i = 1; i <= 10; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: `行动${i}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: i, kind: 'narrator', content: `正文${i}`, branch_id: 'main' });
  }

  eq(store.getActiveSummary(sid, { branchId: 'main', atTurn: 5 }), null, '没有摘要时返回 null');
  const s1 = store.addSummary(sid, { branchId: 'main', coversTurnTo: 4, text: '前四轮摘要' });
  ok(s1 && s1.covers_turn_to === 4, '摘要写入');
  eq(store.getActiveSummary(sid, { branchId: 'main', atTurn: 4 }).text, '前四轮摘要', '覆盖边界内可取');
  eq(store.getActiveSummary(sid, { branchId: 'main', atTurn: 3 }), null, '覆盖边界之前不可取');

  const s2 = store.addSummary(sid, { branchId: 'main', coversTurnTo: 8, text: '前八轮摘要', prevId: s1.id });
  eq(store.getActiveSummary(sid, { branchId: 'main', atTurn: 10 }).id, s2.id, '取覆盖边界最大的那条');

  store.addSummary(sid, { branchId: 'main', coversTurnTo: 8, text: '前八轮摘要 v2', prevId: s1.id });
  eq(store.getSummaries(sid, { branchId: 'main' }).length, 2, '同一边界重压不新增行');
  eq(store.getActiveSummary(sid, { branchId: 'main' }).text, '前八轮摘要 v2', '重压覆盖文本');

  // fork：只继承覆盖到分叉点为止的摘要
  store.createBranch(sid, { branchId: 'b2', parentBranch: 'main', forkTurn: 5 });
  store.copyBranchState(sid, { fromBranch: 'main', toBranch: 'b2', forkTurn: 5 });
  eq(store.getActiveSummary(sid, { branchId: 'b2' }).covers_turn_to, 4, '新分支只继承分叉点内的摘要');
  eq(store.getActiveSummary(sid, { branchId: 'b2' }).text, '前四轮摘要', '继承的摘要内容正确');
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

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-memory: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
