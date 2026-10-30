#!/usr/bin/env node
/**
 * tests/test-fates.js — 成长曲线（fates）：纯函数解锁器
 *
 * 覆盖：
 *   - 没有 fates 的卡行为不变（向后兼容的关键）
 *   - 各种 unlock 条件：after_turn / claims / knowledge / min_relation / any_of / all_of
 *   - 阶段依赖：前面没解锁，后面不跳级
 *   - visibility='author' 只给作者看，不进演绎
 *   - change 增量正确合并（不覆盖已有的关系/知识）
 *   - 预兆只对已解锁且在场者渲染
 *   - 与 buildEffectiveWorld 的优先级：world_state > fates > 卡初始值
 */
import './load-env.js';
import path from 'node:path';
import os from 'node:os';

process.env.DB_PATH = path.join(os.tmpdir(), `narra-fates-${Date.now()}.db`);

const fatesMod = await import('../server/world/fates.js');
const { evaluateFates, checkUnlock, applyFates, renderOmens } = fatesMod;
const { normalizeCard } = await import('../server/world/schema.js');
const { buildEffectiveWorld } = await import('../server/world/effective.js');

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const mkCard = (extra = {}) => normalizeCard({
  title: '测试卡',
  premise: 'p',
  entities: [{ id: 'lu-ke', type: 'person', name: '陆可', role: '村长之女' }],
  anchors: [{ id: 'p0', label: '序章', snapshot: { time: '初冬' } }],
  ...extra,
});

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 向后兼容：没有 fates 的卡行为不变 ===');
{
  const card = mkCard();
  const r = evaluateFates(card, { turnNo: 100, ledger: {}, assertions: [], relations: {} });
  eq(r.unlocked, [], '没有 fates 时解锁集为空');
  eq(r.meta.total, 0, 'meta 记录 0 条');

  const world = buildEffectiveWorld(card, []);
  const worldWithEmptyFates = buildEffectiveWorld(card, [], []);
  eq(JSON.stringify(world), JSON.stringify(worldWithEmptyFates), '不传 fates 与传空数组等价');

  const brief = mkCard({ fates: [{ who: '不存在的人', stage: 1 }] });
  ok(brief.fates.length === 1, 'fates 被 normalize 保留');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== unlock 条件：after_turn ===');
{
  const card = mkCard({
    fates: [{
      who: '陆可', stage: 1, label: '暗子的开始',
      unlock: { after_turn: 40 },
      change: { role: '谢家的暗子' },
      omen: ['她开始记日子'],
    }],
  });
  eq(evaluateFates(card, { turnNo: 39 }).unlocked.length, 0, '不到第 40 轮不解锁');
  eq(evaluateFates(card, { turnNo: 40 }).unlocked.length, 1, '第 40 轮解锁');
  eq(evaluateFates(card, { turnNo: 999 }).unlocked.length, 1, '之后一直解锁');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== unlock 条件：claims（必须已成立的事实） ===');
{
  const card = mkCard({
    fates: [{
      who: '陆可', stage: 1,
      unlock: { claims: [{ subject: '凌玥', predicate: '伤害', object: '陆可的家人' }] },
      change: { role: '暗子' },
    }],
  });
  const noClaim = evaluateFates(card, { turnNo: 50, assertions: [] });
  eq(noClaim.unlocked.length, 0, '事实未成立时不解锁');

  const hasClaim = evaluateFates(card, {
    turnNo: 50,
    assertions: [{ subject: '凌玥', predicate: '伤害', object: '陆可的家人', status: 'active' }],
  });
  eq(hasClaim.unlocked.length, 1, '事实成立后解锁');

  const invalid = evaluateFates(card, {
    turnNo: 50,
    assertions: [{ subject: '凌玥', predicate: '伤害', object: '陆可的家人', status: 'invalidated' }],
  });
  eq(invalid.unlocked.length, 0, '已失效的事实不算');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== unlock 条件：knowledge / min_relation / any_of / all_of ===');
{
  const withKnowledge = mkCard({
    fates: [{ who: '陆可', stage: 1, unlock: { knowledge: ['凌家与谢家结盟'] }, change: {} }],
  });
  eq(evaluateFates(withKnowledge, { turnNo: 1, charStates: {} }).unlocked.length, 0, '不知道时不解锁');
  eq(evaluateFates(withKnowledge, {
    turnNo: 1, charStates: { knows: ['凌家与谢家结盟'] },
  }).unlocked.length, 1, '知道后解锁');

  const withRelation = mkCard({
    fates: [{
      who: '陆可', stage: 1,
      unlock: { min_relation: [{ to: '伍卿', sentiment_gte: 0.5 }] },
      change: {},
    }],
  });
  eq(evaluateFates(withRelation, {
    turnNo: 1, relations: [{ to_name: '伍卿', sentiment: 0.2 }],
  }).unlocked.length, 0, '关系温度不够不解锁');
  eq(evaluateFates(withRelation, {
    turnNo: 1, relations: [{ to_name: '伍卿', sentiment: 0.8 }],
  }).unlocked.length, 1, '关系温度达到后解锁');

  // any_of 用 OR 语义：直接测纯函数更清楚
  const anyCtx = { turnNo: 5, ledger: {}, assertions: [], relations: [] };
  ok(checkUnlock({ any_of: [{ after_turn: 100 }, { after_turn: 3 }] }, anyCtx),
    'any_of：任一条件满足即可');
  ok(!checkUnlock({ any_of: [{ after_turn: 100 }, { after_turn: 50 }] }, anyCtx),
    'any_of：都不满足则不解锁');
  ok(checkUnlock({ all_of: [{ after_turn: 3 }, { after_turn: 4 }] }, anyCtx),
    'all_of：全部满足才解锁');
  ok(!checkUnlock({ all_of: [{ after_turn: 3 }, { after_turn: 50 }] }, anyCtx),
    'all_of：有一个不满足就锁');
  ok(checkUnlock({}, anyCtx), '空条件 = 无条件解锁');
  ok(checkUnlock(null, anyCtx), 'null 条件 = 无条件解锁');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 阶段依赖：不能跳级 ===');
{
  const card = mkCard({
    fates: [
      { who: '陆可', stage: 1, label: '一', unlock: { after_turn: 100 }, change: {} },
      { who: '陆可', stage: 2, label: '二', unlock: { after_turn: 10 }, change: {} },
      { who: '陆可', stage: 3, label: '三', unlock: { after_turn: 20 }, change: {} },
    ],
  });
  // 第 50 轮：stage1 未解锁（要 100），所以 2、3 也不能解锁
  eq(evaluateFates(card, { turnNo: 50 }).unlocked.map((f) => f.stage), [],
    '前一阶段未解锁时，后面的阶段都不解锁（成长是路径依赖的）');
  eq(evaluateFates(card, { turnNo: 100 }).unlocked.map((f) => f.stage), [1, 2, 3],
    '前一阶段解锁后，后续阶段一并解锁');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== visibility：author 只给作者，不进演绎 ===');
{
  const card = mkCard({
    fates: [
      { who: '陆可', stage: 1, unlock: {}, omen: ['给作者看的'] , visibility: 'author' },
      { who: '陆可', stage: 2, unlock: {}, omen: ['给模型看的'] , visibility: 'engine' },
    ],
  });
  const r = evaluateFates(card, { turnNo: 1 });
  eq(r.unlocked.length, 1, 'author 阶段不进 unlocked');
  eq(r.unlocked[0].stage, 2, '只保留 engine 阶段');
  const omens = renderOmens(r.unlocked, new Set(['陆可']));
  eq(omens.map((o) => o.text), ['给模型看的'], '预兆不含作者专属内容');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== change 增量：相加不覆盖 ===');
{
  const card = mkCard({
    entities: [{
      id: 'lu-ke', type: 'person', name: '陆可', role: '村长之女',
      psyche: { wants: ['回村'], hides: ['旧事'] },
      knowledge: { knows: ['村里的事'] },
      relations: [{ to: '伍卿', kind: '暗恋', sentiment: 0.3 }],
    }],
    fates: [{
      who: '陆可', stage: 2, unlock: {},
      change: {
        role: '谢家的暗子',
        voice: { rhythm: '说话变短', never_add: ['「卿哥」'] },
        psyche: { wants_add: ['成为谢家的刀'], hides_add: ['她在给谢家递信'] },
        knowledge: { knows_add: ['凌家与谢家结盟'] },
        agenda_add: [{ goal: '把伍卿从凌家摘出来', pressure: 0.8 }],
        relations_set: [{ to: '伍卿', kind: '利用 · 心软', sentiment: -0.2 }],
      },
    }],
  });

  const world = buildEffectiveWorld(card, [], evaluateFates(card, { turnNo: 1 }).unlocked);
  const lu = world.entities.find((c) => c.id === 'lu-ke');

  eq(lu.role, '谢家的暗子', 'role 被改写');
  ok(lu.psyche.wants.includes('回村'), '原有 wants 保留');
  ok(lu.psyche.wants.includes('成为谢家的刀'), '新 wants 加入');
  ok(lu.psyche.hides.includes('旧事'), '原有 hides 保留');
  ok(lu.knowledge.knows.includes('村里的事'), '原有知识保留');
  ok(lu.knowledge.knows.includes('凌家与谢家结盟'), '新知识加入');
  eq(lu.relations.length, 1, '同一关系不重复，而是替换');
  eq(lu.relations[0].kind, '利用 · 心软', '关系被 relations_set 覆盖');
  eq(lu.agenda.length, 1, '私心加入');
  eq(lu.voice.never, ['「卿哥」'], 'never 加入');
  // 身份根不可改写
  eq(lu.name, '陆可', 'name 不被 fates 改写');
  eq(lu.id, 'lu-ke', 'id 不被 fates 改写');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 优先级：world_state > fates > 卡初始值 ===');
{
  const card = mkCard({
    entities: [{ id: 'lu-ke', type: 'person', name: '陆可', role: '村长之女' }],
    fates: [{ who: '陆可', stage: 1, unlock: {}, change: { role: '谢家的暗子' } }],
  });
  // 运行期已经写了 role → fates 不应覆盖运行期值
  const deltas = [{
    id: 1, entity_kind: 'person', entity_id: 'lu-ke', path: 'role',
    op: 'set', value: '剧情里变成的第三个身份', valid_from: 5, valid_to: null,
  }];
  const world = buildEffectiveWorld(card, deltas, evaluateFates(card, { turnNo: 10 }).unlocked);
  const lu = world.entities.find((c) => c.id === 'lu-ke');
  eq(lu.role, '剧情里变成的第三个身份', '运行期 world_state 优先于 fates');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 预兆：只对已解锁且在场者 ===');
{
  const card = mkCard({
    fates: [
      { who: '陆可', stage: 1, unlock: {}, omen: ['一', '二'] },
      { who: '旁人', stage: 1, unlock: {}, omen: ['旁人的预兆'] },
    ],
  });
  const r = evaluateFates(card, { turnNo: 1 });
  eq(renderOmens(r.unlocked, new Set(['陆可'])).length, 1, '每人只取一条（不把预兆当剧情清单）');
  eq(renderOmens(r.unlocked, new Set()).length, 0, '不在场则不渲染');
  eq(renderOmens(r.unlocked, new Set(['陆可', '旁人']), 1).length, 1, 'limit 限制总条数');
  eq(renderOmens(r.unlocked, new Set(['陆可', '旁人']), 5).length, 2, '每人最多一条，所以上限是人数');
  ok(renderOmens(r.unlocked, new Set(['陆可']))[0].text === '一', '按数组顺序取第一条');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== normalize：fates / seeds / canon_arc / divergence 都容错 ===');
{
  const card = normalizeCard({
    title: 't',
    fates: [
      { who: '甲', stage: 1, unlock: { after_turn: '5' }, change: { role: 'r' }, omen: ['o'] },
      { who: '', stage: 1 },           // 没 who → 丢弃
      { stage: 1 },                    // 没 who → 丢弃
    ],
    seeds: [
      { title: '左腿旧伤的成因', kind: 'mystery', weight: 0.9 },
      { title: '' },                    // 没 title → 丢弃
    ],
    canon_arc: [
      { id: 'arc-1', chapter_from: 1, chapter_to: 10, label: '雨街', load_bearing: true },
      { label: '' },                    // 没 id 没 label → 丢弃
    ],
    divergence: { mode: 'strict', cutoff: { chapter: 5 } },
  });

  eq(card.fates.length, 1, 'fates 丢弃无 who 的条目');
  eq(card.fates[0].unlock.after_turn, 5, 'after_turn 字符串被归一成数字');
  eq(card.seeds.length, 1, 'seeds 丢弃无 title 的条目');
  eq(card.seeds[0].kind, 'mystery', 'seed kind 保留');
  eq(card.canon_arc.length, 1, 'canon_arc 保留合法条目');
  eq(card.canon_arc[0].chapter_from, 1, '章号区间归一');
  eq(card.divergence.mode, 'strict', 'divergence mode 保留');

  // 缺省时全部为空 → 行为与纯 v4 一致
  const bare = normalizeCard({ title: 'bare' });
  eq(bare.fates, [], '没有 fates 时为空数组');
  eq(bare.seeds, [], '没有 seeds 时为空数组');
  eq(bare.canon_arc, [], '没有 canon_arc 时为空数组');
  eq(bare.divergence.mode, 'loose', '没有 divergence 时默认 loose');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== seeds：开局播种成线索（伏笔不靠史官「碰巧埋到」） ===');
{
  const store = await import('../server/memory/store.js');
  const orch = await import('../server/agents/orchestrator.js');

  const seedCard = normalizeCard({
    title: '种卡',
    premise: 'p',
    entities: [{ id: 'a', type: 'person', name: '甲', role: '角色' }],
    anchors: [{ id: 'p0', label: '序章', snapshot: { time: '初冬' } }],
    seeds: [
      { title: '左腿旧伤的成因', kind: 'mystery', weight: 0.9, note: '原文写过不是天生的' },
      { title: '玉佩为什么会发光', kind: 'mystery', weight: 0.8 },
    ],
  });
  const wid = 'w-seed-' + Date.now();
  store.saveWorld({ id: wid, title: '种子卡', card: seedCard });

  const sess = orch.createSessionWithSettings({ title: '种子局', worldId: wid });
  const threads = store.getThreads(sess.id, { branchId: 'main' });

  eq(threads.length, 2, '开局把 seeds 播种成 2 条线索');
  eq(threads.map((t) => t.title).sort(), ['左腿旧伤的成因', '玉佩为什么会发光'].sort(), '线索标题来自 seeds');
  ok(threads.every((t) => t.status === 'open'), '播种的线索都是 open');
  ok(threads.every((t) => t.planted_turn === 0), '播种轮次是 0（开局之前）');

  // 没有 seeds 的卡：一条都不种，行为不变
  const bareCard = normalizeCard({ title: 'b', premise: 'p', anchors: [{ id: 'p0', label: 'x' }] });
  const wid2 = 'w-noseed-' + Date.now();
  store.saveWorld({ id: wid2, title: '无种子', card: bareCard });
  const sess2 = orch.createSessionWithSettings({ title: '无种子局', worldId: wid2 });
  eq(store.getThreads(sess2.id, { branchId: 'main' }).length, 0, '没有 seeds 时不播种');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-fates: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);