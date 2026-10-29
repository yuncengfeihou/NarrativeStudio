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
const { pickOffstagePersons, detectSceneChange, isSubstantivePlaceShift } = await import('../server/agents/memory-pipeline.js');
const pipe = await import('../server/agents/memory-pipeline.js');
const { worldTickUserPrompt, archivistSystemPrompt, continuitySystemPrompt } = await import('../server/prompts/archivist.js');
const config = (await import('../server/config.js')).config;
const { pathsFor } = await import('../server/world/state-paths.js');

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

  /* ---- countAssertions 必须与 getAssertions 同口径（D3 的 total 用它） ---- */
  // 这里是 D3 自己踩过的坑：loaded 用 atTurn 回溯（窗口里含「当拍已失效」的历史断言），
  // 而 total 最初只数 status='active'，于是 t18 出现 loaded=75 > total=75 的临界、
  // 过了 300 条之后会变成「看见的比库里还多」，报告判据自相矛盾。
  const at3Count = store.countAssertions(sid, { branchId: 'main', atTurn: 3 });
  eq(at3Count, store.getAssertions(sid, { branchId: 'main', atTurn: 3, limit: 1000 }).length,
    'countAssertions(atTurn) 与 getAssertions(atTurn) 同口径');
  ok(!store.getAssertions(sid, { branchId: 'main' }).some((a) => a.id === a1),
    'a1 已失效，不在 active 集合里');
  ok(store.getAssertions(sid, { branchId: 'main', atTurn: 3 }).some((a) => a.id === a1),
    '但 a1 在第 3 拍仍然有效，落在回溯窗口里');
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

  // D23：每人限量必须是**按人分区**的，不是「全局前 400 行再按人切」。
  // 旧实现下，一个高频角色（这里是 500 行的凌玥）就能把全局窗口吃满，
  // 久没开口的角色整段掉出去、声线永久消失，而 meta 里没有任何信号。
  {
    const noisy = `s-${Date.now()}-d23`;
    store.createSession({ id: noisy, title: 't' });
    store.createBranch(noisy, { branchId: 'main' });
    for (let i = 1; i <= 500; i++) {
      store.addVoice(noisy, { branchId: 'main', who: '凌玥', text: `高频第${i}句`, turn_no: i });
    }
    store.addVoice(noisy, { branchId: 'main', who: '谢沐', text: '我走了', turn_no: 3 });
    const big = store.getVoiceMap(noisy, { branchId: 'main', perWho: 2 });
    eq(big['谢沐']?.map((v) => v.text), ['我走了'], '低频角色不会被高频角色挤出窗口（按人分区取前 N）');
    eq(big['凌玥'].map((v) => v.text), ['高频第500句', '高频第499句'], '高频角色仍取各自最近 2 条');
    const pinnedOk = store.addVoice(noisy, { branchId: 'main', who: '谢沐', text: '（钉选）别忘了我', turn_no: 2 });
    store.setVoicePinned(noisy, pinnedOk, 1);
    const withPin = store.getVoiceMap(noisy, { branchId: 'main', perWho: 2 });
    eq(withPin['谢沐'][0].pinned, true, '钉选的原声排在该人前面（不会被 newer 挤掉）');
  }
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
console.log('\n=== D31：一回合的两行要么都写、要么都不写 ===');
{
  const sid = `s-turnpair-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });

  // 正常路径：两条都在同一个事务里落库。
  store.addTurnPair(sid, [
    { turn_no: 1, kind: 'player', content: '推门进去。', branch_id: 'main' },
    { turn_no: 1, kind: 'narrator', content: '门后是空的。', branch_id: 'main' },
  ]);
  ok(store.getTurn(sid, 1, 'player')?.content === '推门进去。', '成对写入：player 行在');
  ok(store.getTurn(sid, 1, 'narrator')?.content === '门后是空的。', '成对写入：narrator 行在');

  // 失败路径：narrator 那行非法（缺 kind 会抛）→ 事务回滚，player 行也不能留在库里。
  // 这就是 D31 要修的「孤儿回合」：过去 player 行在演绎之前就写死了，上游一断，
  // 库里就留下一条没人回应的玩家行动，只能靠 --repair 删行收拾。
  let threw = false;
  try {
    store.addTurnPair(sid, [
      { turn_no: 2, kind: 'player', content: '再推一次。', branch_id: 'main' },
      { turn_no: 2, kind: null, content: '不该写进去。', branch_id: 'main' },
    ]);
  } catch { threw = true; }
  ok(threw, '第二行非法时 addTurnPair 抛错');
  ok(!store.getTurn(sid, 2, 'player'), '事务回滚：player 行没有留下（不再有孤儿回合）');
  ok(!store.getTurn(sid, 2, 'narrator'), '事务回滚：narrator 行也没有');

  // 空数组是合法的 no-op（opening 那一拍没有 player 行）。
  eq(store.addTurnPair(sid, []), [], '空列表不报错');
  eq(store.addTurnPair(sid, [null, undefined]), [], '只有 null 时也不报错');
  eq(store.getMaxTurnNo(sid), 1, '回滚后回合水位没有前进');
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

  /* ---- 下界（D4 后验）：上下文里已经逐字可见的段不再检索 ---- */
  // 50 轮实测：20 条历史查询里 15 条是本拍玩家动作的子串，跨距长的查询全部落空——
  // 因为模型拿「刚说过的话」当查询词，搜回来的必然是它眼前已经有的东西。
  const all = await recall.recallHistory({ sessionId: sid, branchId: 'b2', atTurn: 3, query: '旧仓库' });
  ok(all.hits.some((h) => h.turn_no <= 2), '不设下界时能查到早期回合');
  eq(all.meta.excluded, null, '不传下界时 meta.excluded 为 null');
  // 「旧仓库」只出现在第 2 拍；excludeFrom=2 表示第 2 拍起已逐字可见，不该再查。
  const bounded = await recall.recallHistory({
    sessionId: sid, branchId: 'b2', atTurn: 3, excludeFrom: 2, query: '旧仓库',
  });
  eq(bounded.hits.length, 0, 'excludeFrom=2 时第 2 拍起不再检索');
  ok(bounded.text.includes('没有在已经发生的回合里找到'), '落空时明确告知而不是留白');
  eq(bounded.meta.excluded, 2, 'meta 记下排除起点（报告要能核对）');
  // 下界不该把「更早的命中」也一起挡掉：它只影响 >= excludeFrom 的部分。
  const keepEarly = await recall.recallHistory({
    sessionId: sid, branchId: 'b2', atTurn: 3, excludeFrom: 2, query: '玥姐姐',
  });
  ok(keepEarly.hits.length >= 1 && keepEarly.hits.every((h) => h.turn_no < 2),
    '下界只挡较新的段，早期命中仍可查');

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

  /* ---- 线索账本 WIP 上限与权重阈值（D5） ----
   * 上限 = 场记单渲染容量：埋下的线索若渲染不出来，等于埋了个看不见的东西。
   * 到顶拒绝新埋（并留 thread_rejected 审计），但 resolve 永远允许——它减少条数。 */
  const sheetMod = await import('../server/world/scene-sheet.js');
  eq(sheetMod.THREAD_RENDER_MAX, 8, '线索渲染容量 = 8（与场记单 slice 共读一个常量）');
  eq(sheetMod.THREAD_MIN_WEIGHT, 0.6, '线索落库权重下限 = 0.6');

  // 低权重：不落库，留痕。
  r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 12,
    update: { scene_change: {}, threads: [{ action: 'plant', title: '气氛有点沉', weight: 0.4 }] },
  });
  eq(r.threads, 0, '权重 0.4 的线索不落库');
  eq(r.threads_rejected, 1, '被拒线索计数 = 1');
  eq(store.getThreads(sid, { status: 'open' }).length, 0, '低权重线索没写进表');
  const rejPatch = store.listPatches(sid, { branchId: 'main', kind: 'thread_rejected' })[0];
  eq(rejPatch?.payload?.items?.[0]?.reason, 'low_weight', 'thread_rejected 记录拒绝原因 low_weight');
  eq(rejPatch?.status, 'rejected', 'thread_rejected 的 status = rejected');

  // 填满到上限。
  for (let i = 1; i <= sheetMod.THREAD_RENDER_MAX; i++) {
    arch.applyArchivistUpdate({
      sessionId: sid, branchId: 'main', turnNo: 13,
      update: { scene_change: {}, threads: [{ action: 'plant', title: `钩子${i}`, weight: 0.7 }] },
    });
  }
  eq(store.getThreads(sid, { branchId: 'main', status: 'open' }).length, sheetMod.THREAD_RENDER_MAX,
    `开放线索填满到 ${sheetMod.THREAD_RENDER_MAX} 条`);

  // 到顶：第 N+1 条被拒，原因 wip_full。
  r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 14,
    update: { scene_change: {}, threads: [{ action: 'plant', title: '溢出的钩子', weight: 0.9 }] },
  });
  eq(r.threads, 0, '到顶后新线索不落库');
  const rej2 = store.listPatches(sid, { branchId: 'main', kind: 'thread_rejected' })[0];
  eq(rej2?.payload?.items?.[0]?.reason, 'wip_full', 'thread_rejected 记录拒绝原因 wip_full');
  eq(rej2?.payload?.wip_limit, sheetMod.THREAD_RENDER_MAX, 'patch 里带 wip_limit 便于诊断');
  ok(!store.getThreads(sid, { branchId: 'main', status: 'open' }).some((t) => t.title === '溢出的钩子'),
    '溢出的钩子确实没写进表（不是静默写入后不渲染）');

  // 到顶时 resolve 仍然允许——它让条数下降，是唯一的出口。
  r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 15,
    update: { scene_change: {}, threads: [{ action: 'resolve', title: '钩子1' }] },
  });
  eq(r.threads, 1, '到顶时 resolve 仍然生效');
  eq(store.getThreads(sid, { branchId: 'main', status: 'open' }).length, sheetMod.THREAD_RENDER_MAX - 1,
    '回收后开放线索少一条');

  // 已存在的标题重复 plant 是「更新」，不受权重阈值与上限约束（否则改不动已有线索）。
  r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 16,
    update: { scene_change: {}, threads: [{ action: 'plant', title: '钩子2', weight: 0.2, note: '降级' }] },
  });
  eq(r.threads, 1, '重复 plant 已存在标题 = 更新，不拒绝');
  eq(r.threads_rejected, 0, '重复 plant 不记 rejected');

  // 卡内预埋伏笔（seeds）不受阈值约束：它们是「必须回收的钩子」唯一的初始值来源，
  // 播种走 upsertThread 直写、不经 applyArchivistUpdate。预设里真有一条 0.55。
  store.upsertThread(sid, {
    branch_id: 'main', title: '作者预埋的低权伏笔', status: 'open', weight: 0.55, planted_turn: 0, turn_no: 0,
  });
  ok(store.getThreads(sid, { branchId: 'main', status: 'open' }).some((t) => t.title === '作者预埋的低权伏笔'),
    'seeds 播种路径不受 0.6 阈值影响（作者写了就是作者的意思）');

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

  /* ---- place_id 重算：最长命中 + 唯一性，不做名字特判 ---- */
  // 别名索引与场景里一致：别墅有「二楼」这个别名，「老旅馆二楼房间」不能被它抢走。
  const villaIdx = [
    { alias: '别墅', kind: 'codex', id: 'bie-shu', name: '别墅', type: 'place' },
    { alias: '二楼', kind: 'codex', id: 'bie-shu', name: '别墅', type: 'place' },
    { alias: '凌玥的别墅', kind: 'codex', id: 'bie-shu', name: '别墅', type: 'place' },
    { alias: '老旅馆', kind: 'codex', id: 'lao-lv-guan', name: '老旅馆', type: 'place' },
  ];
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 12, aliasIndex: villaIdx,
    update: { scene_change: { changed: true, place: '老旅馆二楼房间' } },
  });
  eq(store.getState(sid, { branchId: 'main', atTurn: 12 }).state.place_id, 'lao-lv-guan',
    '最长命中：老旅馆二楼房间 → 老旅馆，不被别名「二楼」抢走');

  // 反向包含：地点文本比条目名短，要能命中全名；但必须唯一。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 13,
    aliasIndex: [{ alias: '镇东回春堂', kind: 'codex', id: 'hui-chun-tang', name: '镇东回春堂', type: 'place' }],
    update: { scene_change: { changed: true, place: '回春堂' } },
  });
  eq(store.getState(sid, { branchId: 'main', atTurn: 13 }).state.place_id, 'hui-chun-tang',
    '反向包含唯一时解析成功：回春堂 → 镇东回春堂');

  // 反向歧义（「东别墅」「西别墅」都同样长短地包住「别墅」）→ 判失败写空，不猜。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 14,
    aliasIndex: [
      { alias: '东别墅', kind: 'codex', id: 'a', name: '东别墅', type: 'place' },
      { alias: '西别墅', kind: 'codex', id: 'b', name: '西别墅', type: 'place' },
    ],
    update: { scene_change: { changed: true, place: '别墅' } },
  });
  eq(store.getState(sid, { branchId: 'main', atTurn: 14 }).state.place_id, '',
    '反向包含歧义 → 写空而不是猜一个实体');

  // 但「别墅」自身就是一个条目时不算歧义：最短命中的那个才是本意，长名条目只是它的变体。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 141,
    aliasIndex: [
      { alias: '别墅', kind: 'codex', id: 'villa', name: '别墅', type: 'place' },
      { alias: '凌玥的别墅', kind: 'codex', id: 'villa', name: '别墅', type: 'place' },
    ],
    update: { scene_change: { changed: true, place: '别墅' } },
  });
  eq(store.getState(sid, { branchId: 'main', atTurn: 141 }).state.place_id, 'villa',
    '最短命中的唯一实体优先（长名只是同一条目的别名）');

  // 运行期 introduce 的地点也要能被解析（卡快照里没有它的别名索引）。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 15, aliasIndex: [],
    update: {
      scene_change: { changed: true, place: '官道' },
      changes: [{ kind: 'place', id: 'guan-dao', op: 'introduce', value: { name: '官道' } }],
    },
  });
  const st15 = store.getState(sid, { branchId: 'main', atTurn: 15 });
  eq(st15.state.place_id, 'guan-dao', '本分支 introduce 的地点也能解析成 place_id');

  // 解析不到就写空，不把自由文本留成 place_id；且空不会把上一拍的 place_id 抹成脏值。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 16, aliasIndex: villaIdx,
    update: { scene_change: { changed: true, place: '黑色商务车内／村路' } },
  });
  eq(store.getState(sid, { branchId: 'main', atTurn: 16 }).state.place_id, '',
    '解析不到的地点写空（不保留自由文本当 id）');

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
  // D25：`world` 和 `player` 一样不是卡里的实体，而是投影目标。曾经只放行了 player，
  // 于是史官每一次世界局势变更都被这道校验静默拦掉（全库 `entity_kind='world'` 的
  // world_state 写入 0 行），而消费方一直在（场记单「局势 …」行 + 定稿常驻笔记）。
  ok(declaredTargets.includes('world'), '世界局势永远允许（D25：world 是投影目标，不是卡实体）');

  // 端到端：写一条 world/status 必须真的落库、且投影后能渲染出「局势」行。
  // 只断言 declaredTargets 里有 'world' 不够——守卫有三段（声明集合 → sanitizeChange
  // 的 pathsFor → applyDelta 的投影），任何一段断开都等于写不进去。
  {
    const before = store.getWorldState(sid, { branchId: 'main' }).length;
    arch.applyArchivistUpdate({
      sessionId: sid, branchId: 'main', turnNo: 1, aliasIndex, declaredTargets,
      update: { changes: [{ kind: 'world', id: 'world', path: 'status', op: 'set', value: '全城戒严' }] },
    });
    const ws = store.getWorldState(sid, { branchId: 'main' })
      .filter((d) => d.entity_kind === 'world' && d.path === 'status');
    ok(ws.length === 1, '世界局势写入真的落库（不再被目标声明静默拦掉）',
      `world_state 新增 ${store.getWorldState(sid, { branchId: 'main' }).length - before} 行`);
    eq(ws[0]?.value, '全城戒严', '世界局势的值原样落库');
    const graded = effective.buildEffectiveWorld(world.card, ws, []);
    eq(graded.runtime?.status, '全城戒严', '投影后 world.runtime.status 可读（消费方接得上）');
  }

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
console.log('\n=== 简称指代：introduce 吸收正文前缀 + 变更能对上实体（D13） ===');
{
  const sid = `d13-${Date.now()}`;
  const world = {
    id: `w13-${Date.now()}`, title: 't',
    card: schema.normalizeCard({
      title: 't',
      entities: [{ type: 'person', name: '伍卿' }],
    }),
  };
  store.saveWorld(world);
  store.createSession({ id: sid, title: 't', worldId: world.id });
  store.createBranch(sid, { branchId: 'main' });

  // ① introduce 时把「正文里真出现过」的名字前缀收成别名（纯确定性，不猜）。
  const intro = arch.sanitizeChange(
    { kind: 'item', op: 'introduce', fields: { name: '蛇纹圆印纸', summary: '一张旧纸' } },
    { aliasIndex: schema.buildAliasIndex(world.card), narrative: '我把那张蛇纹纸摊开，纸角发脆。' },
  );
  ok(intro.value.aliases?.includes('蛇纹'), '正文里出现过的名字前缀被收成别名');
  eq(intro.aliases_from_narrative, ['蛇纹'], '吸收了什么进提案里可见');
  const noNarr = arch.sanitizeChange(
    { kind: 'item', op: 'introduce', fields: { name: '蛇纹圆印纸' } },
    { aliasIndex: [], narrative: '我把那张纸摊开。' },
  );
  ok(!noNarr.value.aliases, '正文里没出现过就不收（不凭名字自己造简称）');
  const tooShort = arch.sanitizeChange(
    { kind: 'item', op: 'introduce', fields: { name: '玉佩' } },
    { aliasIndex: [], narrative: '玉佩碎了。' },
  );
  ok(!tooShort.value.aliases, '三字以下的名字不做前缀吸收（避免「玉」这种噪声）');

  // ② 落地后：正文里的简称能对上实体，变更不再被白名单静默拒掉。
  const aliasIndex = schema.buildAliasIndex(world.card);
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 1, aliasIndex, declaredTargets: null,
    update: { scene_change: {}, changes: [intro] },
  });
  const projected = schema.normalizeCard({
    ...world.card,
    entities: [...world.card.entities, intro.value],
  });
  const aliasIndex2 = schema.buildAliasIndex(projected);
  const declaredTargets = arch.buildDeclaredTargets({
    card: projected, present: [], codex: [], ledgerCharacters: [], playerName: '伍卿',
  });
  const r = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 2, aliasIndex: aliasIndex2, declaredTargets,
    update: {
      scene_change: {},
      changes: [{ kind: 'item', op: 'set', id: '蛇纹纸', path: 'status', value: '被水泡软' }],
    },
  });
  eq(r.changes, 1, '简称变更写进账本（旧实现被 skipped_targets 静默拒）');
  eq(r.skipped, 0, '不再记为越界目标');
  const ws = store.getWorldState(sid, { branchId: 'main', atTurn: 2 });
  ok(ws.some((d) => d.op === 'set' && d.path === 'status' && d.value === '被水泡软'
    && d.entity_id === intro.entity_id), '落库到正确实体（按简称归一到 id）');

  // ③ 多命中不猜：简称同时指向两个实体时保持原样，仍交给白名单判。
  const ambiguous = arch.sanitizeChange(
    { kind: 'item', op: 'set', id: '纸', path: 'status', value: 'x' },
    { aliasIndex: [
      { alias: '纸', kind: 'item', id: 'a', name: '甲纸', type: 'item' },
      { alias: '纸', kind: 'item', id: 'b', name: '乙纸', type: 'item' },
    ] },
  );
  ok(!!ambiguous, '多命中时不清空提案（只不归一）');
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

console.log('\n=== 提案窗口：按 kind 取数 + 计数不静默截断 ===');
{
  const sid = `s-patchwin-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });
  // 复现长跑的形状：高频类（越界目标，每拍 3 条）+ 低频类（幕外流言，每拍 1 条），共 10 拍。
  for (let t = 1; t <= 10; t++) {
    for (let k = 0; k < 3; k++) {
      store.addPatch(sid, {
        branchId: 'main', agent: 'archivist', kind: 'skipped_targets', turn_no: t, status: 'skipped',
        payload: { items: [{ path: `x.${t}.${k}` }] }, severity: 'warn',
      });
    }
    store.addPatch(sid, {
      branchId: 'main', agent: 'world-tick', kind: 'offstage_event', turn_no: t, status: 'open',
      payload: { who: `人物${t}`, what: `第 ${t} 拍幕外`, visibility: 'rumor' }, severity: 'minor',
    });
  }
  // 混 kind 的 24 条窗口里以高频类为主（复现「流言被挤到最旧的一小撮」）
  const mixed = store.listPatches(sid, { limit: 24 });
  eq(mixed.filter((x) => x.kind === 'offstage_event').length, 6,
    '混 kind 的 24 条窗口只有 6 条是流言（其余 18 条被高频类占掉）');
  // 按 kind 过滤后，窗口真的属于流言，而且拿到的是最新的
  const rumors = store.listPatches(sid, { status: 'open', kind: 'offstage_event', limit: 24 });
  eq(rumors.length, 10, 'kind 过滤后拿到全部 10 条流言');
  eq(rumors[0].turn_no, 10, '窗口里最新的一条在前');
  eq(store.countPatches(sid, { kind: 'offstage_event' }), 10, '计数按 kind');
  eq(store.countPatches(sid, { status: 'open' }), 10, '计数不静默截断');
  const counts = store.patchKindCounts(sid);
  eq(counts.skipped_targets, 30, '分组计数：高频类');
  eq(counts.offstage_event, 10, '分组计数：流言');
  eq(counts.uncertain, undefined, 'uncertain 不再落库（D6：保留出口、不写表）');
  eq(store.countVoices(sid), 0, '原声计数（空表为 0）');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 校勘自动修复（D12）：target 接受 # 前缀 ===');
{
  const sid = `s-contfix-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });
  const a1 = store.addAssertion(sid, {
    branch_id: 'main', subject: '伍卿', predicate: '相信', object: '凌玥要走',
    visibility: 'public', valid_from: 1, turn_no: 1,
  });
  const a2 = store.addAssertion(sid, {
    branch_id: 'main', subject: '伍卿', predicate: '相信', object: '凌玥会留下',
    visibility: 'public', valid_from: 2, turn_no: 2,
  });
  ok(a1 > 0 && a2 > 0, '两条冲突断言落库');

  const issue = (target) => ({
    kind: 'contradiction', severity: 'major', subject: '伍卿',
    claim: '两条信念互相冲突', evidence: '第2轮原文',
    fix: { action: 'invalidate_assertion', target, value: '' },
  });

  // 提示词把断言渲染成 `#123`（continuityUserPrompt 的 `#${a.id}`），模型照着抄带井号。
  const n1 = pipe.applyContinuityFixes(sid, {
    branchId: 'main', turnNo: 5, threads: [], aliasIndex: new Map(),
    issues: [issue(`#${a1}`)],
  });
  eq(n1, 1, 'target 带 # 时 fix 真的执行了（旧实现这里恒为 0）');
  const row1 = store.getAssertions(sid, { branchId: 'main', includeInvalid: true }).find((x) => x.id === a1);
  eq(row1.status, 'invalidated', '断言被失效而不是删除');
  eq(row1.valid_to, 5, 'valid_to 记成校勘那一拍');

  // 不带 # 的仍然工作
  const n2 = pipe.applyContinuityFixes(sid, {
    branchId: 'main', turnNo: 6, threads: [], aliasIndex: new Map(),
    issues: [issue(String(a2))],
  });
  eq(n2, 1, 'target 不带 # 时照旧执行');

  // 脏 target 不执行，且把原因记进 payload（旧实现只记 open，看不出为什么没执行）
  const n3 = pipe.applyContinuityFixes(sid, {
    branchId: 'main', turnNo: 7, threads: [], aliasIndex: new Map(),
    issues: [issue('第 3 条断言')],
  });
  eq(n3, 0, '非数字 target 不执行');
  const p = store.listPatches(sid, { kind: 'contradiction', limit: 5 })[0];
  // D31：执行不了的提案是**终态**（failed），不是「等人裁决」（open）。
  // 过去记 open 会让记忆面板显示「接受/忽略」两个按了没反应的按钮，
  // 报告也只能数出「执行 0 条」，数不出「它已经废了」。
  eq(p.status, 'failed', '未执行的提案记 failed 终态（不是 open，open 专指等人裁决）');
  eq(p.payload?.fix_result?.state, 'unmatched', '未执行的原因记进 payload（报告能看见为什么 0 执行）');
  eq(p.payload?.fix_result?.retryable, false, '标记为不可重放：隔拍再执行会把状态改回过去');

  /* ---- D15：模型把断言 id 填进 set_state，不能当成状态改写 ---- */
  // 实测形状：{"action":"set_state","target":"#2036","value":"伍家竹院牛棚"}。
  // 老逻辑会落到 [subject,'condition'] 兜底 → 把地点写进 condition，
  // 还给「伍卿的积蓄」这种非人物 subject 造出一个假人物（投影时 emptyPersonEntry）。
  const a3 = store.addAssertion(sid, {
    branch_id: 'main', subject: '大黑牛', predicate: '位于', object: '断墙根另一侧',
    visibility: 'public', valid_from: 1, turn_no: 1,
  });
  const stateIssue = (subject, target, value) => ({
    kind: 'contradiction', severity: 'major', subject,
    claim: '断言里的位置已经过时', evidence: '第10轮原文',
    fix: { action: 'set_state', target, value },
  });

  const n4 = pipe.applyContinuityFixes(sid, {
    branchId: 'main', turnNo: 10, threads: [], aliasIndex: new Map(),
    issues: [stateIssue('大黑牛', `#${a3}`, '伍家竹院牛棚')],
  });
  eq(n4, 1, 'set_state + 断言 id 按 invalidate_assertion 执行（不是写 condition）');
  const row3 = store.getAssertions(sid, { branchId: 'main', includeInvalid: true }).find((x) => x.id === a3);
  eq(row3.status, 'invalidated', '过时的断言被失效');
  const p4 = store.listPatches(sid, { kind: 'contradiction', limit: 5 })[0];
  eq(p4.payload?.fix_result?.interpreted_as, 'invalidate_assertion', '改写了模型原意要留痕');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['大黑牛'], undefined, '没有把「伍家竹院牛棚」写进人物 condition');

  // 非人物 subject + who::field 形态：拒写并留痕，不造假人物
  const n5 = pipe.applyContinuityFixes(sid, {
    branchId: 'main', turnNo: 11, threads: [], aliasIndex: [],
    issues: [stateIssue('伍卿的积蓄', '伍卿的积蓄::condition', '怀里（粗布小包）')],
  });
  eq(n5, 0, '非人物 subject 的 set_state 拒写（不造「伍卿的积蓄」这种假人物）');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['伍卿的积蓄'], undefined, 'character_states 里没有假人物');
  const p5 = store.listPatches(sid, { kind: 'contradiction', limit: 5 })[0];
  eq(p5.payload?.fix_result?.reason, 'not_a_person', '拒写原因留痕（报告能看见为什么没执行）');
  eq(p5.status, 'failed', '「不是人物」是代码按设计拒写，重试也不会变，记终态');

  // 合法形态仍然工作：who::field
  // aliasIndex 必须是 buildAliasIndex() 产出的数组（`resolveEntity` 用 `.find`）；
  // 前面几条传 `new Map()` 不会出事，只是因为它们全在 resolveEntity 之前就返回了。
  const contCard = schema.normalizeCard({ title: 't', entities: [{ type: 'person', name: '大黑牛' }] });
  const n6 = pipe.applyContinuityFixes(sid, {
    branchId: 'main', turnNo: 12, threads: [], aliasIndex: schema.buildAliasIndex(contCard),
    issues: [stateIssue('大黑牛', '大黑牛::location', '牛棚')],
  });
  eq(n6, 1, 'who::field 的 set_state 照旧执行');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['大黑牛']?.location, '牛棚', '合法字段真的写进去了');

  /* ---- D29：提示词没写清 target 形态，模型写「人物.字段」→ 100% 落空却记 open ---- */
  // 双局长跑实测：set_state 7 条全部 unmatched，形态分别是 `大黑牛.condition`（点号）、
  // `凌玥`（裸人名）、`伍卿 —拥有→ 金钱`（把断言三元组填进 target）。
  const n7 = pipe.applyContinuityFixes(sid, {
    branchId: 'main', turnNo: 13, threads: [], aliasIndex: schema.buildAliasIndex(contCard),
    issues: [stateIssue('大黑牛', '大黑牛.condition', '平静吃草')],
  });
  eq(n7, 0, '点号形态 `人物.字段` 不执行（代码只认 `::`，这是提示词该说清的事）');
  const p7 = store.listPatches(sid, { kind: 'contradiction', limit: 5 })[0];
  eq(p7.payload?.fix_result?.state, 'unmatched', '落空原因留痕，不是静默挂 open');
  eq(p7.payload?.fix_result?.reason, 'stale_value',
    '点号形态的 set_state 记 stale_value：它的 value 是「校勘那一拍应有的值」，不能隔拍重放');
  eq(p7.status, 'failed', '终态，不会在记忆面板里永远排队');

  // merge_alias 从来没有实现分支。提示词已把它从 action 枚举删掉；万一模型仍写出来，
  // 要能和「形态填错」区分开——否则又是一个「看起来在等人裁决」的死通道。
  const n8 = pipe.applyContinuityFixes(sid, {
    branchId: 'main', turnNo: 14, threads: [], aliasIndex: schema.buildAliasIndex(contCard),
    issues: [{
      kind: 'alias', severity: 'minor', subject: '东宫玄衣人', claim: '同一实体的两个名字',
      evidence: '第36-37轮原文', fix: { action: 'merge_alias', target: '2677', value: '东宫玄衣人' },
    }],
  });
  eq(n8, 0, 'merge_alias 不执行（没有这条自动通道）');
  const p8 = store.listPatches(sid, { kind: 'alias', limit: 5 })[0];
  eq(p8.payload?.fix_result?.reason, 'not_implemented', 'merge_alias 的落空原因是「没有实现」，不是「填错了」');
  eq(p8.status, 'failed', 'merge_alias 落 failed 终态（不是 open——它不是「等人裁决」）');

  // 提示词必须写明 set_state 的 target 形态，且不能把 merge_alias 列成可用的 action——
  // 这两条是上面的代码约束在提示词侧的唯一证据，写漏一条就回到 D29。
  const contPrompt = continuitySystemPrompt();
  ok(contPrompt.includes('::'), '校勘提示词写明了 `人物::字段` 分隔符');
  ok(!/action[^\n]*merge_alias/.test(contPrompt), '校勘提示词的 action 枚举里没有 merge_alias');
  ok(contPrompt.includes('merge_alias') === false, '提示词完全不再提 merge_alias（避免模型照抄）');
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
  // 玩家**没有** life_state（D14）：主角不会「这一场不在镜头里」，离场整场戏就结束了。
  // 没有消费方读 player.life_state（absentees 只挑 type==='person'），
  // 曾经放行的后果是史官写一条 gone 之后 `card.player.life_state` 永久停在 gone。
  const playerHurt = arch.sanitizeChange(
    { kind: 'player', id: '伍卿', path: 'life_state', op: 'set', value: 'injured' },
    { aliasIndex: idx, playerName: '伍卿' },
  );
  eq(playerHurt, null, '玩家没有 life_state 这条路（D14：主角不会离场）');
  ok(!pathsFor('player').has('life_state'), 'PLAYER_SCALARS 不含 life_state');
  ok(pathsFor('person').has('life_state'), '人物仍然有 life_state（受控值不变）');
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
console.log('\n=== D32：life_state 的两条写入入口必须落到同一张表 ===');
{
  // 史官有两种写法写人物状态：`states` 数组（走 setCharState）和 `changes` 数组
  // （走 world_state）。只有前者会写 `character_states`，而 gone 的回程通道
  // （reviveNamedGone）与场记的第二见证（applyLifeChanges）读的正是那张表。
  // 结果：经 changes 写出的 gone 在回程通道里**根本看不见**，`lint-state` 却按
  // 投影里的 life_state 把人剔出在场 —— 实测凌玥 t18 被 changes 标 gone 之后
  // 19 拍正文都在演她，回程一次也没触发。这里断言两条路写出同一张表。
  const sid = `s-d32-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });
  const card = schema.normalizeCard({
    title: 't',
    entities: [
      { id: 'ling-yue', name: '凌玥', type: 'person', aliases: ['凌总'] },
      { id: '凌玥', name: '凌玥二', type: 'person' },
    ],
  });
  const idx = schema.buildAliasIndex(card);

  // ① changes 路径，实体 id 是 slug 化的 ling-yue → 必须按 id 反查成人物名
  const r1 = arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 2, aliasIndex: idx, playerName: '伍卿',
    update: { changes: [{ kind: 'person', id: 'ling-yue', path: 'life_state', op: 'set', value: 'gone' }] },
  });
  eq(r1.changes, 1, 'changes 里的 life_state 落库');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['凌玥']?.life_state, 'gone',
    'changes 写的 gone 同时进 character_states（id 用别名索引反查成人物名）');
  ok(!store.getCharStateMap(sid, { branchId: 'main' })['ling-yue'],
    '不会按 id 另起一条人物（两张表的键都是人物名）');

  // ② 回程通道因此看得见它 —— 这正是 D32 要修的那件事
  const revived = pipe.reviveNamedGone({
    sessionId: sid, branchId: 'main', turnNo: 3, card, playerText: '我去找凌总问清楚。',
  });
  eq(revived, [{ who: '凌玥', from: 'gone', to: 'alive' }],
    '经 changes 写的 gone 也能被玩家点名唤回（修复前这条永远返回空数组）');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['凌玥']?.life_state, 'alive', '回程写回 alive');

  // ③ states 路径不受影响（它本来就走这张表）
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 4, aliasIndex: idx, playerName: '伍卿',
    update: { states: [{ who: '凌玥', field: 'life_state', value: 'dead' }] },
  });
  eq(store.getCharStateMap(sid, { branchId: 'main' })['凌玥']?.life_state, 'dead',
    'states 路径照旧写 character_states');

  // ④ 非 life_state 的 changes 不该被顺手写进人物状态表
  const statesBefore = store.getCharStates(sid, { branchId: 'main' }).length;
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 5, aliasIndex: idx, playerName: '伍卿',
    update: { changes: [{ kind: 'person', id: 'ling-yue', path: 'mood', op: 'set', value: '冷' }] },
  });
  eq(store.getCharStates(sid, { branchId: 'main' }).length, statesBefore,
    '只有 life_state 补写 memory 表；condition/mood 等仍只走 world_state（不重复两份真相）');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 数值账本：模型只报变化量，加减与余额由代码算 ===');
{
  const paths = await import('../server/world/state-paths.js');
  ok(paths.NUMBER_PATH_SET.has('money'), 'money 是数值路径');
  ok(![...paths.NUMBER_PATH_SET].some((p) => paths.LIST_PATH_SET.has(p)), '数值路径与列表路径不相交');
  ok(paths.isNumberPath('player', 'money') === true, 'player.money 是数值路径');
  ok(paths.isNumberPath('person', 'money') === false, '人物没有 money 路径');

  const sid = `num-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });
  const card = schema.normalizeCard({ title: 't', player: { name: '伍卿', money: 100 } });
  const project = (turn) => effective.buildEffectiveWorld(
    card, store.getWorldState(sid, { branchId: 'main', atTurn: turn }),
  );

  eq(project(0).player.money, 100, '卡里的初始银钱进投影');

  // 模型只声明「花了 60」，不写余额。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 1, aliasIndex: [], playerName: '伍卿',
    update: { changes: [{ kind: 'player', id: 'player', path: 'money', op: 'delta', value: -60 }] },
  });
  eq(project(1).player.money, 40, 'delta 由代码做加减（100 - 60 = 40）');

  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 2, aliasIndex: [], playerName: '伍卿',
    update: { changes: [{ kind: 'player', id: 'player', path: 'money', op: 'delta', value: 5.5 }] },
  });
  eq(project(2).player.money, 45.5, '再次 delta 累加到同一余额');

  // 余额可以扣成负数（欠债）：**照常落库**，并记进 overdrafts 供报告看见（D11）。
  // 旧实现整条拒绝且不改正基准，prev=0 时任何负数都被拒 → 余额永久卡在 0，
  // 模型看不到余额也看不到被拒，只能照正文里的账继续花钱（实测公开矛盾 19 拍）。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 3, aliasIndex: [], playerName: '伍卿',
    update: { changes: [{ kind: 'player', id: 'player', path: 'money', op: 'delta', value: -100 }] },
  });
  const eff3 = project(3);
  eq(eff3.player.money, -54.5, '超支的 delta 落成负余额（欠债），不再被拒绝');
  ok((eff3.overdrafts || []).some((r) => r.path === 'money' && r.next === -54.5),
    '负余额留下 overdrafts 证据（报告能看见「开始欠债」）');
  eq((eff3.rejected_deltas || []).filter((r) => r.reason === 'negative').length, 0,
    '负数不再走 rejected_deltas（那是「模型输出错」的口径，不是「钱不够」）');

  // 关键：被拒之后基准不前进才是死锁的成因。现在负余额可写，后续负数继续正常累加。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 4, aliasIndex: [], playerName: '伍卿',
    update: { changes: [{ kind: 'player', id: 'player', path: 'money', op: 'delta', value: -10 }] },
  });
  eq(project(4).player.money, -64.5, '负余额之后继续扣钱仍然生效（旧实现这里永久卡在 0）');
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 5, aliasIndex: [], playerName: '伍卿',
    update: { changes: [{ kind: 'player', id: 'player', path: 'money', op: 'delta', value: 70 }] },
  });
  eq(project(5).player.money, 5.5, '还债后回到正数');

  // 非数字仍然是拒绝（那是模型输出错，不是世界状态）——在 sanitize 阶段就被挡下，
  // 所以既不会写库，也不会产生 rejected_delta（rejected_delta 只留给「进到写数层的非法值」）。
  arch.applyArchivistUpdate({
    sessionId: sid, branchId: 'main', turnNo: 6, aliasIndex: [], playerName: '伍卿',
    update: { changes: [{ kind: 'player', id: 'player', path: 'money', op: 'delta', value: '很多' }] },
  });
  const eff6 = project(6);
  eq(eff6.player.money, 5.5, '非数字 delta 被拒，余额不变');
  eq((eff6.rejected_deltas || []).length, 0, '非数字在 sanitize 阶段就挡下，不到写数层');

  // 渲染层：负余额必须显示「欠 X」，不能显示成 0 或隐藏。
  {
    const sheetMod = await import('../server/world/scene-sheet.js');
    const sheet = sheetMod.renderSceneSheet({
      ledger: { time: '次日', place: '镇上', present: ['伍卿'] },
      present: [], playerNow: { name: '伍卿', money: -54.5 }, capTokens: 4000,
    });
    ok(String(sheet.text || '').includes('欠 54.5'), '场记单把负余额渲染成「欠 X」');
    const pos = sheetMod.renderSceneSheet({
      ledger: { time: '次日', place: '镇上', present: ['伍卿'] },
      present: [], playerNow: { name: '伍卿', money: 5.5 }, capTokens: 4000,
    });
    ok(String(pos.text || '').includes('银钱 5.5') && !String(pos.text || '').includes('欠'),
      '正余额照旧渲染成「银钱 X」，不带「欠」');
  }

  // 数值路径的判定只看白名单，不看模型吐出的字面量：给 status 塞数字不能把它变成数字。
  const dirty = arch.sanitizeChange(
    { kind: 'person', id: 'a-jiu', path: 'status', op: 'delta', value: 5 },
    { aliasIndex: [], playerName: '伍卿' },
  );
  eq(dirty, null, '非数值路径上的 delta 被拒（不像素级信任模型的字面量类型）');

  const badMoney = arch.sanitizeChange(
    { kind: 'player', id: 'player', path: 'money', op: 'delta', value: '很多' },
    { aliasIndex: [], playerName: '伍卿' },
  );
  eq(badMoney, null, 'money 的 delta 值不是数字就整条拒绝');

  // 空值不能当 0：Number('') === 0，会把「没写金额」误记成「余额归零」。
  eq(arch.sanitizeChange(
    { kind: 'player', id: 'player', path: 'money', op: 'set', value: '' },
    { aliasIndex: [], playerName: '伍卿' },
  ), null, 'money 的空值不当成 0');
  eq(arch.sanitizeChange(
    { kind: 'player', id: 'player', path: 'money', op: 'delta', value: null },
    { aliasIndex: [], playerName: '伍卿' },
  ), null, 'money 的 null 不当成 0');

  // 分支复制：数值增量按 valid_to 裁剪，与其它 world_state 同一条规则。
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'player', entity_id: 'player',
    path: 'money', op: 'delta', value: -1, turn: 9,
  });
  ok(store.getWorldState(sid, { branchId: 'main', atTurn: 9 }).some((d) => d.path === 'money'),
    '数值增量同样进 world_state（因此天然被分支复制覆盖）');

  // 金额不能再走断言：断言没有数量概念、「拥有」又可并存，同一个钱包会留下互相矛盾的余额，
  // 而且每拍都渲染进「已成立的事实」——真跑里就出现过场记单写「银钱 0」、事实段写「七十五块钱」。
  const prompt = archivistSystemPrompt();
  ok(prompt.includes('金额不写成断言'), '史官提示词明确禁止把金额写成断言');
  ok(prompt.includes('op": "delta"') && prompt.includes('path": "money"'),
    '史官提示词给出 money + delta 的示例（模型只报变化量）');
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
console.log('\n=== 生死交叉校正：场记读整场原文，补史官漏掉的那一拍 ===');
{
  const sid = `life-${Date.now()}`;
  store.createSession({ id: sid, title: 'life' });
  store.createBranch(sid, { branchId: 'main' });
  const card = schema.normalizeCard({
    title: 'life',
    player: { name: '伍卿' },
    entities: [
      { id: 'li-po', type: 'person', name: '黎婆', aliases: ['奶奶'] },
      { id: 'jun-yi', type: 'person', name: '军医' },
    ],
  });
  store.setState(sid, 1, {
    time: '黎明前', place: '竹屋', present: ['wu-qing', 'li-po'],
    characters: { 黎婆: { condition: '掌心朝上，指节不再蜷着' }, 伍卿: {} }, turn_no: 1,
  }, 'main');

  // 史官只写了「不明说的状态」，没写 life_state —— 就是长跑里 t37 的原样。
  store.setCharState(sid, { branchId: 'main', who: '黎婆', field: 'life_state', value: 'injured', turn: 1 });

  const applied = pipe.applyLifeChanges({
    sessionId: sid, branchId: 'main', turnNo: 1,
    world: { card },
    outcome: '奶奶于黎明前离世',
    lifeChanges: [{ who: '黎婆', life_state: 'dead' }],
    sceneId: 'S001',
  });
  eq(applied.length, 1, '场记报的生死变化被接受');
  eq(applied[0].from, 'injured', '记下被覆盖的前值');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['黎婆'].life_state, 'dead',
    'closeScene 后 life_state 被交叉校正为 dead');
  ok(store.listPatches(sid, { branchId: 'main', limit: 50 })
    .some((p) => p.kind === 'life_state_inferred' && p.payload?.who === '黎婆'),
  '交叉校正留了可追溯的审计记录');

  // 投影侧：effective world 里也必须是 dead，否则 lint-state 看不到。
  const eff = effective.buildEffectiveWorld(card, store.getWorldState(sid, { branchId: 'main', atTurn: 1 }));
  eq(eff.entities.find((e) => e.id === 'li-po').life_state, 'dead', '投影后 life_state 生效');

  // 幂等：史官已经写成 dead 的，不重复写、不覆盖成 injured。
  const again = pipe.applyLifeChanges({
    sessionId: sid, branchId: 'main', turnNo: 2, world: { card },
    lifeChanges: [{ who: '黎婆', life_state: 'injured' }],
  });
  eq(again.length, 0, '已经是 dead 的不再被改回 injured');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['黎婆'].life_state, 'dead', 'dead 是终态');

  // 不越界：不是本场 cast 的人，由 closeScene 的白名单过滤（这里直接验证 applyLifeChanges 的
  // 契约——它只信任调用方过滤后的名单，所以给空数组即无写入）。
  eq(pipe.applyLifeChanges({
    sessionId: sid, branchId: 'main', turnNo: 3, world: { card }, lifeChanges: [],
  }).length, 0, '没有生死变化就不写库');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== gone 的回程通道（D10）===');
{
  const sid = `s-gone-${Date.now()}`;
  store.createSession({ id: sid, title: 't' });
  store.createBranch(sid, { branchId: 'main' });
  const card = schema.normalizeCard({
    title: 't',
    entities: [
      { id: 'ling-yue', type: 'person', name: '凌玥', aliases: ['玥姐姐'] },
      { id: 'xie-mu', type: 'person', name: '谢沐' },
    ],
  });
  // t19：凌玥离场（长跑里的原样）
  store.setCharState(sid, { branchId: 'main', who: '凌玥', field: 'life_state', value: 'gone', turn: 19 });

  // 场记这个「第二见证人」不再被 gone 永久挡住：gone → alive 必须放行（旧实现 continue）。
  const back = pipe.applyLifeChanges({
    sessionId: sid, branchId: 'main', turnNo: 25, world: { card },
    outcome: '凌玥跟到镇上，站在药店门口', sceneId: 'S006',
    lifeChanges: [{ who: '凌玥', life_state: 'alive' }],
  });
  eq(back.length, 1, '场记能把 gone 改回 alive（旧实现被 continue 永久挡住）');
  eq(back[0].from, 'gone', '记下前值 gone');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['凌玥'].life_state, 'alive', 'gone 不再是终态');

  // dead 仍是终态：场记不能把死人写活。
  store.setCharState(sid, { branchId: 'main', who: '谢沐', field: 'life_state', value: 'dead', turn: 7 });
  const noRevive = pipe.applyLifeChanges({
    sessionId: sid, branchId: 'main', turnNo: 30, world: { card },
    lifeChanges: [{ who: '谢沐', life_state: 'alive' }],
  });
  eq(noRevive.length, 0, 'dead 仍是终态，场记不能把死人写活');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['谢沐'].life_state, 'dead', 'dead 不被覆盖');

  // ---- 当拍回程：玩家点名 —— 代码补写 alive，而不是靠模型 ----
  store.setCharState(sid, { branchId: 'main', who: '凌玥', field: 'life_state', value: 'gone', turn: 26 });
  const revived = pipe.reviveNamedGone({
    sessionId: sid, branchId: 'main', turnNo: 33, world: { card },
    playerText: '把陆可的话原样告诉凌玥。',
  });
  eq(revived.length, 1, '玩家点名 gone 的人 → 代码写回 alive');
  eq(revived[0].who, '凌玥', '写回的是被点名的那个人');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['凌玥'].life_state, 'alive', 'life_state 已回写');
  ok(store.listPatches(sid, { branchId: 'main', limit: 80 })
    .some((p) => p.kind === 'life_state_revived' && p.payload?.who === '凌玥'),
  '回程留了 life_state_revived 审计');

  // 只处理 gone：dead 的人被点名也不复活（死人回来必须模型显式写）。
  const deadNamed = pipe.reviveNamedGone({
    sessionId: sid, branchId: 'main', turnNo: 34, world: { card },
    playerText: '我去找谢沐。',
  });
  eq(deadNamed.length, 0, 'dead 的人被点名也不复活（与 gone 区别对待）');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['谢沐'].life_state, 'dead', '谢沐仍是 dead');

  // 只认玩家点名：旁白式提及（不经过 playerText）不该触发。
  store.setCharState(sid, { branchId: 'main', who: '凌玥', field: 'life_state', value: 'gone', turn: 35 });
  eq(pipe.reviveNamedGone({
    sessionId: sid, branchId: 'main', turnNo: 36, world: { card }, playerText: '我继续赶路。',
  }).length, 0, '玩家没点名就不回程');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['凌玥'].life_state, 'gone', '没点名时保持 gone');

  // 别名也算点名（红线 2 的实体链接本来就认别名）。
  const aliasRevive = pipe.reviveNamedGone({
    sessionId: sid, branchId: 'main', turnNo: 37, world: { card },
    playerText: '我问玥姐姐那封信的事。',
  });
  eq(aliasRevive.length, 1, '用别名点名也回程');
  eq(store.getCharStateMap(sid, { branchId: 'main' })['凌玥'].life_state, 'alive', '别名回程生效');
}

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

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 世界呼吸：不在场候选按「份量/关系/私心」排序 ===');
{
  const entities = [
    { id: 'ling-yue', type: 'person', name: '凌玥', weight: 1, always_present: true },
    { id: 'wu-qing', type: 'person', name: '伍卿', weight: 1, agenda: [{ goal: '活下去', pressure: 0.9 }] },
    { id: 'xie-mu', type: 'person', name: '谢沐', weight: 0.9,
      agenda: [{ goal: '向凌家要个说法', pressure: 0.8 }],
      relations: [{ to: '凌玥', kind: '旧识' }] },
    { id: 'ling-xuan', type: 'person', name: '凌璇', weight: 0.9, psyche: { wants: ['保住家业'] } },
    { id: 'zhang-lan', type: 'person', name: '张兰', weight: 0.3,
      agenda: [{ goal: '换个差事', pressure: 0.5 }] },
    { id: 'silou', type: 'institution', name: '司楼' },
  ];
  const picked = pickOffstagePersons(entities, {
    presentIds: new Set(['凌玥']), playerName: '伍卿',
    ledger: { characters: { 凌玥: { mood: '疲惫' } } },
  });
  eq(picked.map((c) => c.name), ['谢沐', '凌璇', '张兰'], '按份量+关系+私心排序，且不在场');
  ok(!picked.some((c) => c.name === '凌玥'), '在场者不再被推演');
  ok(!picked.some((c) => c.name === '伍卿'), '玩家不被推演');
  eq(picked.length, 3, '非人物不混入候选');

  const prompt = worldTickUserPrompt({
    turnNo: 9, offstage: [], recentSummary: '', place: '茶楼', when: '次日 · 清晨',
  });
  ok(prompt.includes('【本场时间】次日 · 清晨'), '世界呼吸拿到这一场的时间');
}

console.log('\n=== 世界呼吸：候选轮转（静态排序会让同一批人被反复推演） ===');
{
  // 8 个人、权重递减：不轮转时永远只选前 4 个（长跑实测 29 次推演只用到 6/45 人）。
  // 分数 = 权重 + 压力 0.5×0.5 = 权重 + 0.25。
  const entities = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`, type: 'person', name: `人${i}`, weight: 1 - i * 0.1,
    agenda: [{ goal: '有事', pressure: 0.5 }],
  }));
  const pick = (recentCounts) => pickOffstagePersons(entities, {
    presentIds: new Set(), playerName: '玩家', ledger: {}, limit: 4, recentCounts,
  }).map((c) => c.name);

  eq(pick(new Map()), ['人0', '人1', '人2', '人3'], '不轮转：永远是最高的 4 个（复现问题）');

  // 轮转是**软**的：分数 − 0.12 × 已用次数，不是「用过的排到队尾」。
  // 用一次（-0.12 ≈ 一个以上权重档）会让 0.7 的 人3 被 0.6 的 人4 顶掉，
  // 但**权重最高的人仍在前列**——重要人物不会因为「上轮出现过」就整个停摆。
  const onceTop = new Map([['人0', 1], ['人1', 1], ['人2', 1], ['人3', 1]]);
  eq(pick(onceTop), ['人0', '人1', '人2', '人4'], '用过一次：只让出一个末位，不是整批换人');
  eq(pick(onceTop)[0], '人0', '权重最高的人用过一次仍排第一（不会因为出现过就消失）');

  // 用得多才让位：top4 各用 5 次（-0.6）之后新人成片顶上来，
  // 但权重最高的 人0 仍保住一个名额（1.25-0.6=0.65，与 人6 同分，靠权重序胜出）。
  eq(pick(new Map([['人0', 5], ['人1', 5], ['人2', 5], ['人3', 5]])),
    ['人4', '人5', '人0', '人6'], '用多了才让位，但最高权重仍保一个名额');

  // 不会饿死：次数全部相等时回到纯分数序
  eq(pick(new Map(entities.map((c) => [c.name, 3]))), ['人0', '人1', '人2', '人3'],
    '次数全相等时回落分数序，不会没人可推');

  // 兼容 Set 入参（只关心「出现过没有」的调用方，按各 1 次处理）
  eq(pick(new Set(['人0', '人1', '人2', '人3'])), ['人0', '人1', '人2', '人4'],
    'Set 入参按各 1 次处理，语义与计数 1 相同');
}

console.log('\n=== 切场只认实质变化：同场景措辞不封场 ===');
{
  ok(isSubstantivePlaceShift('黑色商务车', '黑色商务车内') === false, '车 → 车内：同一场地的措辞变化');
  ok(isSubstantivePlaceShift('凌府门口', '凌府门口 → 凌府天井') === false, '同一院内的位置变化不算换地点');
  ok(isSubstantivePlaceShift('茶楼', '司楼门口') === true, '互不包含才是真的换地点');

  const sid = `scene-change-${Date.now()}`;
  store.createSession({ id: sid, title: 'scene-change' });
  store.createBranch(sid, { branchId: 'main' });
  const session = { id: sid, branch_id: 'main' };
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S001', level: 1, turn_from: 1, turn_to: 1,
    when_label: '初冬 · 午后', place: '黑色商务车',
  });

  // 下面三条都在「本场已满最小场长」之后（否则切场会被最小场长拦掉，
  // 测不到「只认实质变化」这条规则本身）。prev.turn_from=1，所以 turnNo>=4 起闸门失效。
  // 史官报了 changed，但账本里地点只是「车 → 车内」——不封场。
  store.setState(sid, 4, { time: '初冬 · 午后', place: '黑色商务车内' }, 'main');
  eq(detectSceneChange(session, { scene_change: { changed: true } }, 4), false,
    '同场景措辞变化 + 史官 changed:true 也不封场');

  // 真的换了地方才封场。
  store.setState(sid, 5, { time: '初冬 · 午后', place: '茶楼' }, 'main');
  eq(detectSceneChange(session, { scene_change: { changed: true } }, 5), true, '实质换地点封场');

  // 时间跳到另一段也封场（跨日）。这里换回同一地点，排除地点变量的干扰。
  store.setState(sid, 6, { time: '第二天 · 清晨', place: '茶楼' }, 'main');
  eq(detectSceneChange(session, { scene_change: { changed: true } }, 6), true, '时间跳到次日封场');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 最小场长：场次太短会让「本场逐字原文」为空 ===');
{
  const sid = `scene-min-${Date.now()}`;
  store.createSession({ id: sid, title: 'scene-min' });
  store.createBranch(sid, { branchId: 'main' });
  const session = { id: sid, branch_id: 'main' };
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S001', level: 1, turn_from: 1, turn_to: 1,
    when_label: '初冬 · 午后', place: '茶楼',
  });
  // 第 2、3 拍：地点已经变了，但本场还没满 MIN_SCENE_TURNS=3 拍 → 不切。
  store.setState(sid, 2, { time: '初冬 · 午后', place: '柴房' }, 'main');
  eq(detectSceneChange(session, { scene_change: {} }, 2), false, '本场第 2 拍：不因换地点切场');
  store.setState(sid, 3, { time: '初冬 · 午后', place: '柴房' }, 'main');
  eq(detectSceneChange(session, { scene_change: {} }, 3), false, '本场第 3 拍：仍不切');
  // 第 4 拍满了下限 → 换地点照常切。
  store.setState(sid, 4, { time: '初冬 · 夜', place: '官道' }, 'main');
  eq(detectSceneChange(session, { scene_change: {} }, 4), true, '满下限后地点/时间变化照常切场');

  // 下限必须在**每一场**都生效，不能只在第一场后面生效。
  // 判据取 turnNo - prev.turn_to（本场已写下的拍数），不是 turnNo - prev.turn_from：
  // prev.turn_from 是上一场的起点，上一场越长这个差越大，闸门就越早失效——
  // 一场 6 拍之后的下一场，第 2 拍就会被放行（实测 65 拍里 29 场全是 1–2 拍）。
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S002', level: 1, turn_from: 2, turn_to: 6,
    when_label: '初冬 · 夜', place: '官道',
  });
  store.setState(sid, 7, { time: '初冬 · 夜', place: '废品站' }, 'main');
  eq(detectSceneChange(session, { scene_change: {} }, 7), false,
    '长场之后的下一场：本场第 1 拍不因换地点切场');
  store.setState(sid, 8, { time: '初冬 · 夜', place: '废品站' }, 'main');
  eq(detectSceneChange(session, { scene_change: {} }, 8), false,
    '长场之后的下一场：本场第 2 拍仍不切');
  store.setState(sid, 9, { time: '初冬 · 夜', place: '废品站' }, 'main');
  eq(detectSceneChange(session, { scene_change: {} }, 9), true,
    '长场之后的下一场：满下限后照常切场');

  // 硬触发不受下限约束：SCENE_EVERY 到点必须封场，否则长局会「一场都不关」，
  // 且 minSceneTurns > sceneEvery 时会死锁。
  const sid2 = `scene-hard-${Date.now()}`;
  store.createSession({ id: sid2, title: 'scene-hard' });
  store.createBranch(sid2, { branchId: 'main' });
  const every = config.context.sceneEvery;
  store.addScene(sid2, {
    branch_id: 'main', scene_id: 'S001', level: 1, turn_from: 1, turn_to: 1,
    when_label: '初冬 · 午后', place: '茶楼',
  });
  // 地点和时间都不变，只有轮数走到上限。
  store.setState(sid2, every, { time: '初冬 · 午后', place: '茶楼' }, 'main');
  eq(detectSceneChange({ id: sid2, branch_id: 'main' }, { scene_change: {} }, every), true,
    `轮数强制封场不受最小场长影响（SCENE_EVERY=${every}）`);
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-memory: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
