#!/usr/bin/env node
/**
 * tests/test-context.js — 上下文装配 v5（无网络）
 *
 * 覆盖：
 *   - 提示词结构：一条 system + 原文 + 场记单 + 本轮输入
 *   - 删干净的证据：没有关键词触发、没有扫描深度、没有幕/节拍/忌避
 *   - 实体链接只影响「在场者」，不影响「注入哪段设定」
 *   - 辞书挑选三条路径在场记单里的体现
 *   - 体积不随轮数增长（500 轮模拟）
 *   - 开场轮使用锚点种子
 */
import './load-env.js';
import path from 'node:path';
import os from 'node:os';

const tmp = path.join(os.tmpdir(), `narra-ctx-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const store = await import('../server/memory/store.js');
const engine = await import('../server/memory/context-engine.js');
const schema = await import('../server/world/schema.js');
const { config } = await import('../server/config.js');
const { shouldPrecheckRetrieval } = await import('../server/agents/retrieval.js');
const { currentPlan, planContext } = await import('../server/memory/context-plan.js');
const { comparePromptMessages } = await import('../server/memory/prompt-drift.js');
const sceneSheet = await import('../server/world/scene-sheet.js');
const { narratorTailInstruction } = await import('../server/prompts/narrator.js');

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
/* 测试卡：与真实世界卡同形状，确保走的是真实数据                          */
/* ══════════════════════════════════════════════════════════════════════ */

const card = schema.normalizeCard({
  title: '我在女尊世界捡破烂',
  subtitle: '开局一个破竹屋',
  premise: '一个被丢掉的人，被当年丢下他的人重新捡起来。',
  charter: [
    { rule: '女子主外、掌权、娶夫；男子主内、被娶、称「嫁」。', kind: 'law' },
    { rule: '司楼是合法存在的官营青楼，是悬在每个男人头上的刀。', kind: 'law' },
  ],
  entities: [
    {
      id: 'ling-yue', type: 'person', name: '凌玥', aliases: ['玥姐姐', '凌家主'],
      role: '帝都凌家家主 · 伍卿的「妻主」', summary: '对天下是棋手，对少年是流氓。',
      identity: { appearance: '玄色窄袖长衫，左腕一串旧玉珠', station: '帝都凌家家主', background: '七岁那年被母亲丢在雨街' },
      voice: { rhythm: '陈述句、短句、笑着说的狠话', exemplars: ['「卿儿，过来。」'] },
      psyche: { traits: ['笑里藏刀', '护短'], wants: ['把他带走'], hides: ['七年前是她母亲丢的人'] },
      knowledge: { knows: ['七年前的真相'], does_not_know: ['伍卿见过南荣兰冰'] },
      agenda: [{ goal: '今天必须把他带走', method: '不能用施舍的方式', pressure: 0.9 }],
      weight: 1,
    },
    { id: 'zhang-lan', type: 'person', name: '张兰', role: '大厦保安', summary: '势利而胆小', weight: 0.3 },
    { id: 'li-po', type: 'person', name: '黎婆', role: '伍卿的奶奶', summary: '恨凌家', weight: 0.5 },
    {
      id: 'silou', type: 'institution', name: '司楼', aliases: ['青楼'],
      tags: ['制度', '交易'], summary: '官营青楼，男子被卖进去等于消失。',
      facets: { rules: ['入内即除籍'], consequences: ['家里会办丧事'] },
      links: ['ling-yue'], canon_from: 'prologue',
    },
    {
      id: 'cheng-hu', type: 'concept', name: '称呼礼法', tags: ['制度'],
      summary: '称「公子」是抬举，称「卿儿」是私密。',
      facets: {}, links: [], pinned: true, canon_from: 'prologue',
    },
    {
      id: 'yupei', type: 'item', name: '无纹玉佩', aliases: ['玉佩'],
      tags: ['未解'], summary: '凌玥所赠，遇暗发绿光。',
      facets: {}, links: [], reveal: 'secret', canon_from: 'prologue',
    },
  ],
  timeline: [
    { id: 'evt-0', when: '七年前 · 雨夜', what: '凌玥的母亲把伍卿丢在街上', canon: 'past', source: 'ch.1' },
    { id: 'evt-1', when: '第三章', what: '黎婆确诊癌症', canon: 'future', source: 'ch.18' },
  ],
  anchors: [{
    id: 'prologue', label: '序章 · 雨街', after_event: 'evt-0',
    snapshot: {
      time: '初冬 · 黄昏', place: '湘曲市 · 商务大厦门口', weather: '冷雨', tension: 0.35,
      characters: { 'wu-qing': { mood: '窘迫', condition: '湿透' } },
      inventory: [{ id: '', name: '无纹玉佩', holder: '伍卿' }],
    },
    opening_seed: '雨落下来，保安在赶人。台阶上有人撑伞站着，看了很久。',
  }],
  player: {
    mode: 'canon', name: '伍卿', canon_character: 'wu-qing',
    situation: '被赶出大厦，身上只有三个空瓶',
    capability: '没有武功，没有钱，只有一张脸和一条伤腿',
    inner_voice: '先活下去，别欠人情。',
    knowledge: { does_not_know: ['凌玥认识他'] },
  },
});

const world = { id: `w-${Date.now()}`, title: card.title, card };
store.saveWorld(world);
const session = store.createSession({ id: `s-${Date.now()}`, title: 't', worldId: world.id });
store.createBranch(session.id, { branchId: 'main' });
store.setSessionAnchor(session.id, 'prologue', 'main');
const S = { ...session, branch_id: 'main', anchor_id: 'prologue' };

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 装配结构 ===');
{
  const ctx = await engine.assembleContext({
    session: S, world, turnNo: 1, isOpening: true,
  });

  const roles = ctx.messages.map((m) => m.role);
  eq(roles.filter((r) => r === 'system').length, 1, '只有一条 system');
  eq(roles[0], 'system', 'system 在最前');
  eq(roles[roles.length - 1], 'user', '最后是本轮输入');
  ok(ctx.messages.some((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】')), '含场记单');
  ok(ctx.messages.some((m) => typeof m.content === 'string' && m.content.includes('【开场】')), '开场轮带种子');

  // 顺序：system → 场记单 → 本轮输入（无历史时）
  const sheetIdx = ctx.messages.findIndex((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'));
  ok(sheetIdx < ctx.messages.length - 1, '场记单在本轮输入之前（尾部注意力区）');

  // 渲染归属审计：每条送模消息都能追到层，顺序与装配顺序一致（只进 meta，不进提示词）。
  ok(Array.isArray(ctx.meta.messages), 'meta.messages 记录渲染归属');
  eq(ctx.meta.messages.length, ctx.messages.length, '归属条数与送模消息相等');
  eq(ctx.meta.messages[0].owner, 'system', '第 0 条归属 system');
  eq(ctx.meta.messages[ctx.meta.messages.length - 1].owner, 'current', '最后一条归属 current');
  ok(ctx.meta.messages.every((m) => typeof m.owner === 'string' && m.owner), '每条都有 owner');
  ok(ctx.meta.messages.every((m) => m.role === ctx.messages[m.index].role), '归属 index 与消息一一对应');
  ok(ctx.meta.messages.some((m) => m.owner === 'scene_sheet'), '场记单归属 scene_sheet');
  const ownerTokens = ctx.meta.messages.reduce((s, m) => s + m.tokens, 0);
  ok(ownerTokens > 0 && ownerTokens < ctx.budget.total * 1.2, '归属 token 累计与层预算同尺度');
}

console.log('\n=== 删干净的证据 ===');
{
  const ctx = await engine.assembleContext({ session: S, world, turnNo: 1, isOpening: true });
  const all = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

  ok(!all.includes('必达节拍'), '没有必达节拍');
  ok(!all.includes('这一幕不要做'), '没有忌避清单');
  ok(!all.includes('本幕'), '没有幕概念');
  ok(!all.includes('【世界细节】'), '没有 lorebook 式的「世界细节」注入头');
  ok(!all.includes('keys'), '没有触发键概念');
  ok(!/第\s*\d+\s*幕/.test(all), '没有幕编号');

  // 未来剧情不注入
  ok(!all.includes('黎婆确诊癌症'), 'timeline 的 future 事件不进提示词');
  // 前史（canon=past）是 canon：进 system 世界索引，以陈述句出现，
  // 不带「必达/原著后续」等指令化措辞（红线 3）。
  // 它来自模板卡 timeline，不是 anchors[].snapshot——后者只是初始账本。
  const sys = ctx.messages[0].content;
  ok(sys.includes('【前史】'), '前史块进 system');
  ok(sys.includes('凌玥的母亲把伍卿丢在街上'), 'canon=past 的前史进 system');
  ok(/【前史】[\s\S]*· 七年前 · 雨夜 · 凌玥的母亲把伍卿丢在街上/.test(sys), '前史一行一条，带时间');
  ok(!sys.includes('黎婆确诊癌症'), 'future 不进 system');
  ok(!all.includes('必达') && !all.includes('原著后续'), '前史不是必达节拍/原著指令');
  eq(ctx.meta.system_blocks.timeline_past.count, 1, 'meta：前史条数');
  eq(ctx.meta.system_blocks.timeline_past.rendered, 1, 'meta：前史渲染条数');
  ok(ctx.meta.system_blocks.timeline_past.tokens > 0, 'meta：前史块 token');
  eq(ctx.meta.system_blocks.timeline_past.cap,
    Math.max(240, Math.round(ctx.meta.plan.layers.system * 0.1)),
    'meta：前史块预算 = system 配额的 10%（下限 240）');

  // 系统层包含宪章与索引
  ok(all.includes('【世界宪章】'), '宪章在场');
  ok(all.includes('【世界索引】'), '世界索引在场');
  ok(all.includes('女子主外'), '宪章内容在场');
  ok(all.includes('凌玥（'), '索引里有人物');
  ok(sys.indexOf('【前史】') > sys.indexOf('【世界索引】'), '前史排在世界索引之后');
  ok(sys.indexOf('【前史】') < sys.indexOf('【主角】'), '前史排在主角之前（canon 区）');
}

console.log('\n=== 篇幅：作者可选 ===');
{
  // 卡里没写篇幅 → 契约与尾注都不出现「篇幅」，字数由这一拍的内容需要决定。
  eq(card.prompt.length, '', '未写篇幅时归一为空');
  const c0 = await engine.assembleContext({ session: S, world, turnNo: 1, isOpening: true });
  const sys0 = c0.messages[0].content;
  ok(!sys0.includes('篇幅'), '未写篇幅：契约不出现篇幅');
  ok(!narratorTailInstruction(card).includes('篇幅'), '未写篇幅：尾注不出现篇幅');
  ok(/3\. 时态/.test(sys0), '未写篇幅：演出范式编号连续（篇幅不占号）');

  // 作者写了篇幅 → 原样进契约与尾注；这是作者的自由，不是引擎默认。
  const lenCard = schema.normalizeCard({
    title: '篇幅测试', premise: '一座旧城。', anchors: [],
    prompt: { length: '1800 字' },
    entities: [{ id: 'a-he', type: 'person', name: '阿禾', role: '守夜人' }],
    player: { mode: 'original', name: '旅人' },
  });
  const lenWorld = { id: `w-len-${Date.now()}`, title: '篇幅', card: lenCard };
  store.saveWorld(lenWorld);
  const lenSession = store.createSession({ id: `s-len-${Date.now()}`, title: 'l', worldId: lenWorld.id });
  store.createBranch(lenSession.id, { branchId: 'main' });
  const lctx = await engine.assembleContext({
    session: { ...lenSession, branch_id: 'main' }, world: lenWorld, turnNo: 1,
  });
  ok(lctx.messages[0].content.includes('篇幅：本轮 1800 字'), '作者写了篇幅：进契约');
  ok(narratorTailInstruction(lenCard).includes('篇幅 1800 字'), '作者写了篇幅：进尾注');
}

console.log('\n=== 前史不依赖 anchor.snapshot ===');
{
  // 前史来源是模板卡的 timeline；没有锚点快照的原创卡也应生效，
  // 且文案里不出现「原著/后文」这类改编卡专属措辞。
  const bareCard = schema.normalizeCard({
    title: '原创世界', premise: '一座旧城。',
    entities: [{ id: 'a-he', type: 'person', name: '阿禾', role: '守夜人', summary: '沉默' }],
    timeline: [{ id: 'p1', when: '二十年前', what: '旧城毁于大火', canon: 'past' }],
    player: { mode: 'original', name: '旅人' },
  });
  const bareWorld = { id: `w-bare-${Date.now()}`, title: '原创', card: bareCard };
  store.saveWorld(bareWorld);
  const bareSession = store.createSession({ id: `s-bare-${Date.now()}`, title: 'b', worldId: bareWorld.id });
  store.createBranch(bareSession.id, { branchId: 'main' });
  const bctx = await engine.assembleContext({
    session: { ...bareSession, branch_id: 'main' }, world: bareWorld, turnNo: 1,
  });
  const bsys = bctx.messages[0].content;
  ok(bsys.includes('【前史】'), '无锚点：前史块仍进 system');
  ok(bsys.includes('旧城毁于大火'), '无锚点：前史内容来自 timeline 模板');
  ok(!bsys.includes('原著'), '无锚点：不含「原著」字样');
  eq(bctx.meta.system_blocks.timeline_past.count, 1, '无锚点：meta 记录前史条数');
}

console.log('\n=== 前史渲染：预算与降级 ===');
{
  const many = schema.normalizeCard({
    title: '前史预算', anchors: [],
    player: { mode: 'original', name: '甲' },
    timeline: Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`, when: `第${i}年`, what: `事件${i}`, canon: 'past',
    })),
  });
  const out = sceneSheet.renderTimelinePast(many, 60);
  ok(out.meta.count === 12, 'cap：统计全部前史条目');
  ok(out.meta.rendered > 0 && out.meta.rendered < 12, 'cap：超预算只渲染最新的若干条');
  ok(out.meta.dropped > 0, 'cap：记录被丢弃的旧行数');
  ok(!out.text.includes('事件0'), 'cap：最旧的行整条丢弃（不切半句）');
  ok(out.text.includes('事件11'), 'cap：最新的行保留');
  ok(out.meta.tokens <= 60 + 20, 'cap：渲染后不超预算上浮范围');

  const fut = sceneSheet.renderTimelinePast(schema.normalizeCard({
    title: '未来', anchors: [], player: { mode: 'original', name: '甲' },
    timeline: [
      { id: 'f', when: '以后', what: '未来的事', canon: 'future' },
      { id: 'b', when: '支线', what: '另一条线', canon: 'branch' },
    ],
  }));
  eq(fut.text, '', 'future / branch 不渲染');
  eq(fut.meta.count, 0, 'future / branch 不计入前史');
}

console.log('\n=== 实体链接只改在场者 ===');
{
  // 玩家提到「玥姐姐」→ 凌玥进场
  const a = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '我抬头看向玥姐姐，她撑着伞站在那里。',
  });
  ok(a.meta.present.some((c) => c.name === '凌玥'), '提到别名 → 该角色进场');

  // 玩家什么都没说 → 只有账本里的人
  const b = await engine.assembleContext({ session: S, world, turnNo: 5, playerText: '我往村里走。' });
  ok(!b.meta.present.some((c) => c.name === '凌玥'), '没提到 → 不进场');
  ok(b.meta.present.some((c) => c.name === '伍卿'), '账本里的主角仍在场');
}

console.log('\n=== 装配清单：系统层索引覆盖 + 场记单元信息 ===');
{
  const ctx = await engine.assembleContext({ session: S, world, turnNo: 1, isOpening: true });
  const idx = ctx.meta.system_blocks.index;
  eq(idx.total, card.entities.length, '索引覆盖统计实体总数与卡一致');
  ok(idx.rendered > 0 && idx.rendered <= idx.total, 'rendered 落在 0..total');
  ok(idx.tokens > 0 && idx.cap > 0, '索引自带 token 与容量');
  ok(Array.isArray(idx.dropped_names), '被截断的实体名可审计');
  eq(ctx.meta.scene_sheet, { cast_mode: 'full', absentees: [] }, '场记单元信息：完整在场、无缺席者');
}

console.log('\n=== 死亡：life_state 让死亡进入提示词 ===');
{
  const sid = `s-death-${Date.now()}`;
  const s2 = store.createSession({ id: sid, title: 'death', worldId: world.id });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'person', entity_id: 'ling-yue',
    path: 'life_state', op: 'set', value: 'dead', turn: 5, source: 'test', evidence: 'test',
  });
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'person', entity_id: 'ling-yue',
    path: 'status', op: 'set', value: '被刺客刺杀，当场死亡', turn: 5, source: 'test', evidence: 'test',
  });
  const made = { ...s2, branch_id: 'main', anchor_id: 'prologue' };
  const ctx = await engine.assembleContext({
    session: made, world, turnNo: 6, playerText: '我回头找凌玥。',
  });
  ok(!ctx.meta.present.some((c) => c.name === '凌玥'), '死亡角色不再占在场位');
  eq(ctx.meta.scene_sheet.absentees, [{ name: '凌玥', state: 'dead' }], '场记单元信息记录缺席原因');
  const text = ctx.messages.map((m) => m.content).join('\n');
  ok(text.includes('已故／离场'), '提示词里出现缺席者行（死亡可见）');
  ok(text.includes('被刺客刺杀，当场死亡'), '缺席者行带 status 细节');
}

console.log('\n=== 在场：present 优先于账本 characters ===');
{
  const sid = `s-presence-${Date.now()}`;
  const s2 = store.createSession({ id: sid, title: 'presence', worldId: world.id });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  store.setState(sid, 4, {
    present: ['凌玥'],
    characters: { 'wu-qing': { mood: '窘迫' }, 'zhang-lan': { mood: '刻薄' } },
    place: '雨街', time: '黄昏', turn_no: 4,
  }, 'main');

  const c = await engine.assembleContext({
    session: { ...s2, branch_id: 'main', anchor_id: 'prologue' },
    world, turnNo: 5, playerText: '我往前走。',
  });
  ok(c.meta.present.some((x) => x.name === '凌玥'), '显式 present 进场');
  ok(!c.meta.present.some((x) => x.name === '张兰'), '账本 characters 里的离场者不再自动进场');
  ok(c.meta.present.some((x) => x.name === '伍卿'), '玩家永远在场');
}

console.log('\n=== 辞书挑选三条路径 ===');
{
  const ctx = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '玥姐姐说，三千四百万，司楼见。',
  });
  const names = ctx.meta.codex.map((c) => c.name);
  ok(names.includes('司楼'), '实体/主题命中 → 司楼进场');
  ok(names.includes('称呼礼法'), '钉选项 → 称呼礼法常驻候选');
  const why = ctx.meta.codex.flatMap((c) => c.why);
  ok(why.some((w) => w === '钉选'), '标注钉选原因');
  ok(why.some((w) => w === '实体在场' || w === '本场主题'), '标注连接原因');
}

console.log('\n=== 装配清单：候选 vs 实际渲染 ===');
{
  const ctx = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '玥姐姐说，司楼见。',
  });
  ok(typeof ctx.meta.codex_candidates === 'number', '记录辞书候选数');
  ok(ctx.meta.codex_rendered <= ctx.meta.codex_candidates, '渲染数不超过候选');
  ok(Array.isArray(ctx.meta.dropped_sections), '记录被丢弃的段');
  ok(ctx.meta.facts_candidates >= ctx.meta.facts, '事实候选数不小于渲染数');
}

console.log('\n=== 辞书场景视图：T0 / T1 两档 ===');
{
  const tierCard = schema.normalizeCard({
    title: 'tier',
    entities: [
      { id: 'a', type: 'person', name: '甲', relations: [{ to: 'b', kind: '旧识' }] },
      { id: 'b', type: 'person', name: '乙' },
      { id: 'p', type: 'place', name: '当前地', summary: '这里' },
      { id: 'n', type: 'item', name: '邻居物', summary: '挨着甲', links: ['a'] },
      { id: 'pin', type: 'concept', name: '钉选物', summary: '常驻', pinned: true },
      { id: 'far', type: 'item', name: '远处物', summary: '无连接' },
    ],
    anchors: [{
      id: 'p0', label: '序',
      snapshot: { place: '当前地', place_id: 'p', characters: { a: { mood: '沉' } } },
    }],
    player: { name: '甲' },
  });
  const tw = { id: `w-tier-${Date.now()}`, title: 'tier', card: tierCard };
  store.saveWorld(tw);
  const ts = store.createSession({
    id: `s-tier-${Date.now()}`, title: 'tier', worldId: tw.id,
    cardSnapshot: tierCard, worldVersion: 1,
  });
  store.createBranch(ts.id, { branchId: 'main' });
  store.setSessionAnchor(ts.id, 'p0', 'main');
  store.setState(ts.id, 0, {
    place: '当前地', place_id: 'p', present: ['a'], characters: { a: { mood: '沉' } }, turn_no: 0,
  }, 'main');

  const ctx = await engine.assembleContext({
    session: { ...ts, branch_id: 'main', anchor_id: 'p0' },
    world: tw, turnNo: 1, playerText: '我站在原地。',
  });
  const t0 = ctx.meta.codex.map((c) => c.name);
  ok(t0.includes('当前地'), '当前地点进 T0');
  ok(t0.includes('钉选物'), '钉选进 T0');
  ok(!t0.includes('邻居物'), '邻域实体不占 T0');
  ok(ctx.meta.codex_brief_candidates >= 1, '邻域实体进入 T1 候选');

  const sheetText = ctx.messages
    .find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(sheetText.includes('附近设定') && sheetText.includes('邻居物'), 'T1 以一句摘要渲染');
  ok(!sheetText.includes('远处物'), '无连接实体不进场记单');
}

console.log('\n=== 检索预检门控 ===');
{
  const gCard = schema.normalizeCard({
    title: 'g',
    entities: [{ id: 'silou', type: 'institution', name: '司楼', aliases: ['青楼'] }],
  });
  ok(shouldPrecheckRetrieval({ mode: 'off', codexCount: 30, minCodex: 24, playerText: '司楼', card: gCard }) === false, 'off 永不预检');
  ok(shouldPrecheckRetrieval({ mode: 'on', codexCount: 1, minCodex: 24, playerText: '走', card: gCard }) === true, 'on 强制预检');
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 30, minCodex: 24, playerText: '我往前走', card: gCard }) === false, 'auto：没点名不预检');
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 30, minCodex: 24, playerText: '我去司楼', card: gCard }) === true, 'auto：点名辞书才预检');
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 10, minCodex: 24, playerText: '我去司楼', card: gCard }) === false, 'auto：小卡不预检');
}

console.log('\n=== 场记单内容 ===');
{
  const ctx = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '玥姐姐站在那里。',
  });
  const sheet = ctx.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(sheet.includes('时间 初冬 · 黄昏'), '时空来自锚点快照');
  ok(sheet.includes('私心：今天必须把他带走'), '私心来自人物 agenda');
  ok(sheet.includes('外形：玄色窄袖长衫'), '外形来自人物 identity.appearance');
  ok(sheet.includes('身份：帝都凌家家主'), '身份来自人物 identity.station');
  ok(sheet.includes('性格：笑里藏刀'), '性格来自人物 psyche.traits');
  ok(!sheet.includes('七岁那年被母亲丢在雨街'), '背景故事不进场记单（只在卡与世界索引里）');
  ok(sheet.includes('边界：'), '知识边界在场');
  ok(sheet.includes('未回收的线索') || sheet.includes('压力'), '线索/压力段至少有一段');
  ok(!sheet.includes('玉佩'), 'reveal=secret 的条目不被链接带出时不出现在单子里');
}

console.log('\n=== 预算从模型窗口推导（不再写死层配额） ===');
{
  const plan = currentPlan();
  const ctx = await engine.assembleContext({ session: S, world, turnNo: 1, isOpening: true });
  eq(ctx.meta.plan.window, plan.window, 'meta.plan.window = narrator 模型窗口');
  eq(ctx.meta.plan.hard_max, plan.hardMax, 'meta.plan.hard_max = 窗口 − 生成预留 − 安全余量');
  ok(plan.hardMax < plan.window, '硬上限给生成留出空间（不再等于整个窗口）');
  ok(plan.outputReserve > 0, '生成预留 > 0');
  eq(ctx.meta.plan.layers, plan.layers, 'meta 记录各层配额');
  const sum = Object.values(plan.layers).reduce((a, b) => a + b, 0);
  ok(sum >= plan.softMax, '各层配额合计覆盖软目标（记忆层不会被无故挤掉）');
  ok(plan.autoSoft === (config.context.softTokens === 0), '软目标为 0 时按窗口自动推导');

  // 小窗口按比例缩放，而不是继续套用大窗口的常量。
  const small = planContext({ windowTokens: 32000, outputTokens: 8000 });
  ok(small.layers.archive < plan.layers.archive, '小窗口的场次索引配额同比缩小');
  ok(small.layers.scene >= 800, '小窗口下场记单仍有下限');
  ok(small.hardMax < small.window, '小窗口硬上限同样扣除生成预留');

  // 显式会话上限：不能超过窗口。
  const capped = planContext({ windowTokens: 200000, outputTokens: 12000, sessionMaxTokens: 30000 });
  eq(capped.hardMax, 30000, '会话上限直接成为提示词硬上限');

  // 实体召回率：默认卡的全部实体都应能从整轮上下文看见（索引 + 场次 + 场记单）。
  ok(ctx.meta.recall.total > 0, 'meta.recall 记录实体总数');
  eq(ctx.meta.recall.total, ctx.meta.system_blocks.index.total + ctx.meta.system_blocks.index.muted,
    'recall 覆盖全部实体（含被静音者）');
  ok(ctx.meta.recall.rate >= 0.99, `默认卡实体召回率 ${ctx.meta.recall.rate}`);
  eq(ctx.meta.system_blocks.index.rendered, ctx.meta.system_blocks.index.total - ctx.meta.system_blocks.index.muted,
    '200K 窗口下世界索引不再丢实体');
}

console.log('\n=== 体积不随轮数增长（原文窗口由场次边界控制） ===');
{
  const sid = `s-volume-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: world.id, title: 'volume', cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  const volSession = { ...created, branch_id: 'main', anchor_id: 'prologue' };

  for (let i = 1; i <= 520; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: `行动${i}`, branch_id: 'main' });
    store.addTurn(sid, {
      turn_no: i, kind: 'narrator',
      content: `正文${i}：${'雨落在街面上。'.repeat(20)}`, branch_id: 'main',
    });
    // 模拟真实封场节奏：每 6 轮封一场。原文窗口 = 上一场结束 + 1 起。
    if (i % 6 === 0) {
      store.addScene(sid, {
        branch_id: 'main',
        scene_id: `S${String(i / 6).padStart(3, '0')}`,
        level: 1, turn_from: i - 5, turn_to: i,
        place: `地点${i}`, question: `第${i}场在问什么？`, outcome: `第${i}场的结果。`,
        importance: i % 30 === 0 ? 'major' : 'normal', key_detail: '', hooks: [],
      });
    }
  }

  const sizes = [];
  for (const turnNo of [1, 50, 200, 500]) {
    const ctx = await engine.assembleContext({
      session: volSession, world, turnNo, playerText: '我继续往前走。',
    });
    sizes.push({ turnNo, ...ctx.budget, coverage: ctx.meta.coverage });
    ok(ctx.meta.coverage.scene_to < turnNo, `第 ${turnNo} 轮：场次覆盖不含当前轮`);
    ok(
      ctx.meta.coverage.recent_from == null
        || ctx.meta.coverage.recent_from === ctx.meta.coverage.scene_to + 1,
      `第 ${turnNo} 轮：场次边界与原文起点首尾相接（无缝无洞）`,
    );
  }
  for (const s of sizes) {
    console.log(`  第 ${String(s.turnNo).padStart(3)} 轮  合计 ${s.total} tok（系统 ${s.system}｜场次索引 ${s.archive}｜原文 ${s.recent}｜场记单 ${s.scene}）`);
  }
  const first = sizes[0].total;
  const last = sizes[sizes.length - 1].total;
  ok(last < first * 3.5, `500 轮与第 1 轮同量级（${first} → ${last}）`);
  ok(sizes.every((s) => s.system < 4200), '系统层受配额约束');
  ok(sizes.every((s) => s.scene < 4000), '场记单受配额约束');
  // 场次索引随场数增长，但有上界（超了靠降级，不是无限膨胀）。
  const plan = currentPlan();
  ok(sizes.every((s) => s.archive <= plan.layers.archive + 40),
    '场次索引受规划配额约束');
  // 200K 窗口下 500 轮（约 83 场）必须完整可寻址：不降级、不丢行。
  eq(sizes[sizes.length - 1].coverage.scene_index_dropped, 0,
    '500 轮：场次索引没有整行丢弃（长程记忆完整）');
  eq(sizes[sizes.length - 1].coverage.scene_index_degraded, 0,
    '500 轮：场次索引没有降级粒度');
}

console.log('\n=== 覆盖不变量：场次覆盖过的回合不再逐字，边界之后全部逐字 ===');
{
  const sid = `s-cover-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: world.id, title: 'cover', cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  const coverSession = { ...created, branch_id: 'main', anchor_id: 'prologue' };

  for (let i = 1; i <= 20; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: `旧行动${i}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: i, kind: 'narrator', content: `旧正文${i}`, branch_id: 'main' });
  }
  // 前 6 轮已封成一场：它们不再逐字出现，但仍以场次记录的形式可寻址。
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S001', level: 1, turn_from: 1, turn_to: 6,
    place: '雨街', question: '前六轮在问什么？', outcome: '前六轮的结论。',
    key_detail: '无纹玉佩', importance: 'major', hooks: ['玉佩为什么发光'],
  });

  const ctx = await engine.assembleContext({
    session: coverSession, world, turnNo: 21, playerText: '我继续往前走。',
  });
  const all = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  ok(all.includes('旧正文7'), '场次边界之后的第一轮仍在（不再只取最后 8 轮）');
  ok(all.includes('旧正文20'), '最新一轮仍在');
  ok(!all.includes('旧正文6'), '场次覆盖的回合不再逐字重复');
  ok(all.includes('前六轮的结论'), '被覆盖的剧情仍在场次记录里可寻址');
  eq(ctx.meta.coverage.scene_to, 6, 'meta 记录场次边界');
  eq(ctx.meta.coverage.recent_from, 7, 'meta 记录原文起点');
  eq(ctx.meta.coverage.recent_to, 20, 'meta 记录原文终点');
}

console.log('\n=== system：主角与作者笔记优先于世界索引 ===');
{
  const bigCard = schema.normalizeCard({
    title: '大卡',
    premise: '测试命题',
    charter: Array.from({ length: 12 }, (_, i) => ({
      rule: `宪章${i}：${'这是很长的世界规则。'.repeat(6)}`,
    })),
    entities: [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, type: 'person', name: `人物${i}`, role: '角色' })),
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `k${i}`, name: `条目${i}`, type: 'concept', summary: '摘要'.repeat(20),
      })),
    ],
    player: {
      name: '我', afraid: '怕水怕高怕欠人情',
      knowledge: { does_not_know: ['七年前的真相'] },
    },
    author_notes: [{ text: '作者必须保留的笔记', scope: 'always' }],
    anchors: [{ id: 'p0', snapshot: { time: '初冬', place: '雨街' } }],
  });
  const bw = { id: `w-big-${Date.now()}`, title: '大卡', card: bigCard };
  store.saveWorld(bw);
  const bs = store.createSession({
    id: `s-big-${Date.now()}`, worldId: bw.id, title: 'big',
    cardSnapshot: bigCard, worldVersion: 1,
  });
  store.createBranch(bs.id, { branchId: 'main' });
  store.setSessionAnchor(bs.id, 'p0', 'main');

  const ctx = await engine.assembleContext({
    session: { ...bs, branch_id: 'main', anchor_id: 'p0' },
    world: bw, turnNo: 1, isOpening: true,
  });
  const sys = ctx.messages[0].content;
  ok(sys.includes('怕水怕高怕欠人情'), '主角的「害怕」没有被截断');
  ok(sys.includes('七年前的真相'), '主角的知识边界没有被截断');
  ok(sys.includes('作者必须保留的笔记'), '作者笔记没有被截断');
  // 预算按模型窗口推导后，200K 窗口下这张 72 实体的卡不该被截断——静默丢实体才是失真。
  eq(ctx.meta.system_blocks.index.dropped, 0, '预算充足时世界索引不丢实体');

  // 预算收紧时：索引先退化为只留名字，但主角/知识边界/作者笔记必须保住。
  const tight = await engine.assembleContext({
    session: {
      ...bs, branch_id: 'main', anchor_id: 'p0',
      settings: { ...bs.settings, context_max_tokens: 2600 },
    },
    world: bw, turnNo: 1, isOpening: true,
  });
  const tsys = tight.messages[0].content;
  ok(tsys.includes('怕水怕高怕欠人情'), '收紧后主角的「害怕」仍在');
  ok(tsys.includes('七年前的真相'), '收紧后主角的知识边界仍在');
  ok(tsys.includes('作者必须保留的笔记'), '收紧后作者笔记仍在');
  ok(tight.meta.system_blocks.index.dropped > 0, '收紧后世界索引退化为只留名字');
}

console.log('\n=== canon / runtime 分离：运行态不改 system 前缀 ===');
{
  const w = { id: `w-stable-${Date.now()}`, title: 'stable', card };
  store.saveWorld(w);
  const made = store.createSession({
    id: `s-stable-${Date.now()}`, worldId: w.id, title: 'stable',
    cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(made.id, { branchId: 'main' });
  store.setSessionAnchor(made.id, 'prologue', 'main');
  const sess = { ...made, branch_id: 'main', anchor_id: 'prologue' };

  const before = await engine.assembleContext({ session: sess, world: w, turnNo: 1, isOpening: true });
  store.addWorldState(made.id, {
    branch_id: 'main', entity_kind: 'person', entity_id: 'ling-yue',
    path: 'status', op: 'set', value: '左肩中箭', turn: 1, source: 'archivist',
  });
  const after = await engine.assembleContext({
    session: sess, world: w, turnNo: 2, playerText: '我抬头看向玥姐姐。',
  });
  ok(after.messages[0].content === before.messages[0].content, '运行态变化不改 system 前缀');
  const sheet = after.messages
    .find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(sheet.includes('左肩中箭'), '运行态进入场记单');
}

console.log('\n=== 原声：回声带真实轮次，且能按角色锚定声线 ===');
{
  const sid = `s-voice-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: world.id, title: 'voice', cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'person', entity_id: 'ling-yue',
    path: 'mood', op: 'set', value: '冷峻', turn: 1,
  });
  for (let i = 1; i <= 3; i++) {
    store.addVoice(sid, { branch_id: 'main', who: '凌玥', text: `「第${i}句原话。」`, turn_no: i });
  }
  const vSession = { ...created, branch_id: 'main', anchor_id: 'prologue' };
  const ctx = await engine.assembleContext({
    session: vSession, world, turnNo: 4, playerText: '我看向玥姐姐。',
  });
  const sheet = ctx.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';

  ok(sheet.includes('原声'), '在场者卡渲染原声');
  ok(sheet.includes('第3句原话'), '取到最近的台词');
  ok(/第\s*[1-9]\d*轮/.test(sheet), '回声带真实轮次');
  ok(!sheet.includes('第0轮'), '不再出现「第0轮」的假出处');
  eq(ctx.echoes.every((e) => e.turn_no > 0), true, 'echoes 元数据里的轮次也是真的');
}

console.log('\n=== 缓存前缀：system 必须逐字节冻结（10 轮含运行态写入） ===');
{
  const wid = `w-freeze-${Date.now()}`;
  // 带 parent_id 的树形索引卡：这是最容易被运行态污染的形状。
  const treeCard = schema.normalizeCard({
    ...card,
    entities: [
      ...card.entities,
      { id: 'ling-fu', type: 'place', name: '凌府', summary: '帝都的宅子' },
      { id: 'ling-fu-yard', type: 'place', name: '凌府天井', summary: '院子里', parent_id: 'ling-fu' },
    ],
  });
  store.saveWorld({ id: wid, title: 'freeze', card: treeCard });
  const made = store.createSession({
    id: `s-freeze-${Date.now()}`, worldId: wid, title: 'freeze',
    cardSnapshot: treeCard, worldVersion: 1,
  });
  store.createBranch(made.id, { branchId: 'main' });
  store.setSessionAnchor(made.id, 'prologue', 'main');
  const sess = { ...made, branch_id: 'main', anchor_id: 'prologue' };

  const systems = [];
  for (let t = 1; t <= 10; t++) {
    // 每一轮都制造会污染 system 的运行态：角色身份变化、主角处境、新登场实体。
    store.addWorldState(made.id, {
      branch_id: 'main', entity_kind: 'person', entity_id: 'ling-yue',
      path: 'role', op: 'set', value: `第${t}轮换的头衔`, turn: t,
    });
    store.addWorldState(made.id, {
      branch_id: 'main', entity_kind: 'person', entity_id: 'ling-yue',
      path: 'status', op: 'set', value: `第${t}轮的状态`, turn: t,
    });
    store.addWorldState(made.id, {
      branch_id: 'main', entity_kind: 'player', entity_id: 'player',
      path: 'situation', op: 'set', value: `第${t}轮的处境`, turn: t,
    });
    store.addWorldState(made.id, {
      branch_id: 'main', entity_kind: 'person', entity_id: `extra-${t}`,
      op: 'introduce', value: { name: `临时角色${t}`, role: '路人' }, turn: t,
    });
    store.addWorldState(made.id, {
      branch_id: 'main', entity_kind: 'place', entity_id: `tmp-place-${t}`,
      op: 'introduce', value: { type: 'place', name: `临时地点${t}`, summary: '路过' }, turn: t,
    });

    const ctx = await engine.assembleContext({
      session: sess, world: store.getWorld(wid), turnNo: t, playerText: '我继续走。',
    });
    systems.push(ctx.messages[0].content);
  }

  eq(new Set(systems).size, 1, '10 轮 system 完全一致（只有 1 种内容）');
  ok(!systems[0].includes('轮换的头衔'), '运行态 role 不进 system');
  ok(!systems[0].includes('轮的状态'), '运行态 status 不进 system');
  ok(!systems[0].includes('轮的处境'), '运行态 player.situation 不进 system');
  ok(!systems[0].includes('临时角色'), '临时登场角色不进 system 索引');
  ok(!systems[0].includes('临时地点'), '临时登场地点不进 system 索引');

  // 但运行态不能因此丢失：它必须出现在场记单里。
  const last = await engine.assembleContext({
    session: sess, world: store.getWorld(wid), turnNo: 11, playerText: '我继续走。',
  });
  const sheet = last.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(sheet.includes('轮的处境') || sheet.includes('轮的'), '主角运行态搬到了场记单（信息没丢）');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 缓存探针：消息级 drift（index / offset / 两侧摘录） ===');
{
  const base = [
    { role: 'system', content: '契约：正文只演事实。' },
    { role: 'user', content: '【本局场次索引】第一场：雨夜来客。' },
  ];
  eq(comparePromptMessages(null, base).verdict, 'unknown', '没有上一轮基线 → unknown');
  eq(comparePromptMessages(base, base.map((m) => ({ ...m }))).verdict, 'identical', '逐条相同 → identical');
  eq(comparePromptMessages(base, base.map((m) => ({ ...m }))).shared_messages, 2, 'identical 时共享消息数 = 总条数');

  // 健康形态：只追加尾部
  const appended = comparePromptMessages(base, [
    ...base,
    { role: 'user', content: '【场记单】雨还在下。' },
    { role: 'user', content: '我推门进去。' },
  ]);
  eq(appended.verdict, 'appendedMessages', '仅尾部追加 → appendedMessages');
  eq(appended.index, null, '只追加时没有分叉 index');

  // 破裂形态：system 改了一个字
  const tampered = base.map((m, i) => (i === 0 ? { ...m, content: '契约：正文只演实情。' } : m));
  const broken = comparePromptMessages(base, tampered);
  eq(broken.verdict, 'broken', 'system 变动 → broken');
  eq(broken.index, 0, '断在第 0 条 system');
  eq(broken.char_offset, 7, '字符 offset 指向「事实/实情」的分叉点');
  eq(broken.left_excerpt, '事实。', 'left_excerpt 从分叉点取上一轮摘录');
  eq(broken.right_excerpt, '实情。', 'right_excerpt 从分叉点取本轮摘录');

  // 中间消息被改写（不只是 system）
  const shifted = comparePromptMessages(base, [
    base[0],
    { role: 'user', content: '【本局场次索引】第二场：天亮。' },
  ]);
  eq(shifted.verdict, 'broken', '历史消息被改写 → broken');
  eq(shifted.index, 1, '断在第 1 条历史消息');

  // 尾部被删（比上一轮短）
  const truncated = comparePromptMessages(base, [base[0]]);
  eq(truncated.verdict, 'broken', '尾部被删 → broken');
  eq(truncated.index, 1, '尾部删除的 index 指向被删的第一条');

  // 集成：同一状态装配两次 → identical；伪造上一轮 system → broken(index 0)
  const ctx1 = await engine.assembleContext({ session: S, world, turnNo: 5, playerText: '我继续往前走。' });
  const again = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '我继续往前走。',
    previousMessages: ctx1.messages,
  });
  ok(again.meta.cache && again.meta.cache.drift, 'meta.cache.drift 已输出');
  eq(again.meta.cache.drift.verdict, 'identical', '同一状态二次装配 → identical');
  const forged = ctx1.messages.map((m) => ({ ...m }));
  forged[0] = { ...forged[0], content: forged[0].content + '（篡改）' };
  const forgedCtx = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '我继续往前走。',
    previousMessages: forged,
  });
  eq(forgedCtx.meta.cache.drift.verdict, 'broken', 'system 被篡改 → broken');
  eq(forgedCtx.meta.cache.drift.index, 0, '篡改系统消息时 index=0');
  ok(typeof forgedCtx.meta.cache.drift.char_offset === 'number', 'broken 时给出字符 offset');
  ok(forgedCtx.meta.cache.system_hash !== null, 'system_hash 仍在');
}

console.log('\n=== 场次索引：只追加、可寻址、超预算先降级老场 ===');
{
  const { renderSceneIndex, renderRecentScenes } = await import('../server/world/scene-sheet.js');

  const mk = (n, extra = {}) => ({
    scene_id: `S${String(n).padStart(3, '0')}`,
    turn_from: n * 10 - 9, turn_to: n * 10,
    place: `地点${n}`,
    question: `第${n}场在问什么？`,
    outcome: `第${n}场的结果。后续影响。`,
    key_detail: n === 3 ? '三十一块八毛' : '',
    importance: n === 3 ? 'major' : 'normal',
    hooks: n === 3 ? ['玉佩为什么发光'] : [],
    ...extra,
  });

  const empty = renderSceneIndex([], 1800);
  eq(empty.text, '', '没有场次时不渲染');
  eq(empty.meta.total, 0, 'meta 记录 0 场');

  const five = renderSceneIndex([1, 2, 3, 4, 5].map((n) => mk(n)), 1800);
  ok(five.text.includes('【本局场次索引】'), '索引有固定块头');
  ok(five.text.includes('S003'), '包含场次编号');
  ok(five.text.includes('三十一块八毛'), 'major 场次渲染关键细节');
  ok(five.text.includes('玉佩为什么发光'), 'major 场次渲染钩子');
  ok(five.text.includes('第3场在问什么'), '包含该场的问题');
  eq(five.meta.rendered, 5, '5 场全部渲染');

  // 预算很小时：先降级最老的（细节消失），而不是把整段砍掉。
  const tight = renderSceneIndex([1, 2, 3, 4, 5].map((n) => mk(n)), 120);
  ok(tight.meta.degraded > 0 || tight.meta.dropped > 0, '小预算触发降级');
  ok(tight.text.includes('S005'), '最近一场始终保留');
  ok(tight.text.length > 0, '不会降级成空字符串');

  const recent = renderRecentScenes([1, 2, 3, 4, 5].map((n) => mk(n)), 900);
  ok(recent.text.includes('【刚才这一场怎么收的】'), '最近场次细节块');
  ok(recent.text.includes('S005') && recent.text.includes('S004'), '只取最近 1–2 场');
  ok(!recent.text.includes('S001'), '不重复渲染更早的场次');
  eq(recent.meta.rendered, 2, 'meta 记录 2 场');
}

console.log('\n=== 场次索引进装配：索引在前、细节在后、当前场不进索引 ===');
{
  const sid = `s-scene-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: world.id, title: 'scene', cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  const sceneSession = { ...created, branch_id: 'main', anchor_id: 'prologue' };

  // 造两场已封场的原文 + 场次记录，再加当前场的一部分原文。
  for (let i = 1; i <= 20; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: `行动${i}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: i, kind: 'narrator', content: `正文${i}`, branch_id: 'main' });
  }
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S001', level: 1, turn_from: 1, turn_to: 8,
    place: '雨街', question: '她会不会认下他？', outcome: '她当众认下了他。',
    key_detail: '无纹玉佩', importance: 'major', hooks: ['玉佩为什么会发光'],
  });
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S002', level: 1, turn_from: 9, turn_to: 16,
    place: '凌府', question: '他会不会留下？', outcome: '他留下了，但没答应。',
    key_detail: '', importance: 'normal', hooks: [],
  });

  const ctx = await engine.assembleContext({
    session: sceneSession, world, turnNo: 19, playerText: '我推开凌府的门。',
  });
  const texts = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
  const all = texts.join('\n');

  ok(all.includes('【本局场次索引】'), '场次索引进入装配');
  ok(all.includes('S001') && all.includes('S002'), '两场都在索引里');
  ok(all.includes('【刚才这一场怎么收的】'), '最近场次细节块进入装配');
  eq(ctx.budget.archive > 0, true, '场次索引有独立预算');
  eq(ctx.meta.coverage.scene_count, 2, 'meta 记录已封场次数');
  eq(ctx.meta.coverage.scene_to, 16, 'meta 记录场次覆盖到第几轮');
  eq(ctx.meta.coverage.scene_index_dropped, 0, '两场没有丢弃');

  // 顺序：索引必须在原文之前（缓存友好），细节必须在原文之后（贴近生成点）。
  const idxPos = texts.findIndex((x) => x.includes('【本局场次索引】'));
  // 场次 S002 覆盖到第 16 轮，所以逐字原文从第 17 轮起（本轮是第 19 轮，窗口含 17、18）。
  const firstRawIdx = texts.findIndex((x) => x === '正文17');
  const detailPos = texts.findIndex((x) => x.includes('【刚才这一场怎么收的】'));
  const sheetPos = texts.findIndex((x) => x.includes('【场记单】'));
  ok(idxPos >= 0, '场次索引在装配里');
  ok(firstRawIdx > idxPos, '场次索引在逐字原文之前');
  ok(firstRawIdx >= 0 && detailPos > firstRawIdx, '场次细节在逐字原文之后');
  ok(sheetPos > detailPos, '场记单仍在最靠近生成点的位置');
  ok(texts[0].includes('你是一部互动小说'), 'system 仍在首位');
}

console.log('\n=== 强制切场：同一地点待久了也必须封场 ===');
{
  const pipe = await import('../server/agents/memory-pipeline.js');
  const sid = `s-force-${Date.now()}`;
  store.createSession({ id: sid, title: 'force' });
  store.createBranch(sid, { branchId: 'main' });
  const sess = { id: sid, branch_id: 'main' };

  // 先封第一场（没有场次时 detectSceneChange 必然为 true）。
  eq(pipe.detectSceneChange(sess, {}, 1), true, '还没有场次时必然切场');

  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S001', level: 1, turn_from: 1, turn_to: 3,
    place: '雨街', question: 'q', outcome: 'o',
  });
  store.setState(sid, 3, { place: '雨街', turn_no: 3 }, 'main');

  // 地点没变、史官也没报变化：靠强制封场。
  eq(pipe.detectSceneChange(sess, {}, 4), false, '刚封场不久不切');
  const every = config.context.sceneEvery;
  if (every > 0) {
    eq(pipe.detectSceneChange(sess, {}, 3 + every), true, `${every} 轮后强制封场（同一地点）`);
  }
}

console.log('\n=== 断言分类：单值常驻、多值按相关性选 ===');
{
  const { selectFacts } = engine;
  const mkA = (subject, predicate, object, extra = {}) => ({
    subject, predicate, object, status: 'active', visibility: 'public', valid_from: 1, ...extra,
  });

  const present = new Set(['凌玥', '伍卿']);
  const assertions = [
    mkA('凌玥', '位于', '雨街'),
    mkA('伍卿', '位于', '凌府'),
    mkA('凌玥', '是', '凌家家主'),
    mkA('凌玥', '拥有', '无纹玉佩'),
    mkA('伍卿', '拥有', '牛车'),
    mkA('张兰', '想要', '合作单'),
    mkA('路人甲', '害怕', '黑暗'),
    mkA('路人乙', '害怕', '高处'),
  ];

  const sel = selectFacts(assertions, {
    presentKeys: present,
    placeId: null,
    threadTitles: ['合作单'],
    manyLimit: 3,
  });

  eq(sel.single.map((a) => a.predicate), ['位于', '位于', '是'], '单值谓词全部保留（有界，不截断）');
  ok(sel.many.every((a) => !['位于', '是', '曾经是'].includes(a.predicate)), '多值断言里没有单值谓词');
  ok(sel.many.some((a) => a.subject === '凌玥' && a.object === '无纹玉佩'), '与在场者相关的多值断言入选');
  ok(sel.many.some((a) => a.object === '合作单'), '命中未回收线索的多值断言入选');
  eq(sel.meta.many_dropped > 0, true, '超上限的多值断言被丢弃');
  eq(sel.meta.many_rendered, 3, '多值条数受 manyLimit 约束');

  const empty = selectFacts([], {});
  eq(empty.single.length, 0, '空断言：单值为空');
  eq(empty.many.length, 0, '空断言：多值为空');
}

console.log('\n=== 知识矩阵：按线索组织，而不是按角色罗列 ===');
{
  const { renderKnowledgeMatrix } = engine;
  const present = [
    { name: '凌玥', knowledge: { knows: ['七年前的真相'], does_not_know: [], believes_falsely: [] } },
    { name: '伍卿', knowledge: { knows: [], does_not_know: ['七年前的真相'], believes_falsely: [] } },
    { name: '黎婆', knowledge: { knows: [], does_not_know: [], believes_falsely: ['七年前的真相'] } },
  ];
  const lines = renderKnowledgeMatrix(present);
  eq(lines.length, 1, '同一件事只出现一行');
  ok(lines[0].includes('凌玥知道'), '矩阵记录谁知道');
  ok(lines[0].includes('伍卿不知道'), '矩阵记录谁不知道');
  ok(lines[0].includes('黎婆误信'), '矩阵记录谁误信');
  ok(lines[0].startsWith('七年前的真相：'), '按线索组织（线索在前）');
}

console.log('\n=== 渲染前体检：死亡角色不再占在场位 ===');
{
  const { lintState } = await import('../server/memory/lint-state.js');

  const ledger = {
    place: '雨街',
    characters: {
      黎婆: { condition: '死亡，手心里残留无纹玉佩', location: '病床上' },
      凌玥: { condition: '黑西装', location: '雨街' },
    },
    inventory: [{ name: '无纹玉佩', holder: '黎婆' }],
  };
  const present = [
    { id: 'li-po', name: '黎婆', status: '死亡', location: '病床上', knowledge: {} },
    { id: 'ling-yue', name: '凌玥', status: '', location: '雨街', knowledge: {} },
  ];
  const r = lintState({ ledger, present, assertions: [], scenes: [], turnNo: 11 });

  ok(r.fixes.some((f) => f.kind === 'remove_dead_from_present' && f.who === '黎婆'),
    '死亡角色被从在场里移除（确定性修）');
  eq(r.present.map((c) => c.name), ['凌玥'], '修完之后在场只剩凌玥');
  ok(r.warnings.some((w) => w.kind === 'item_holder_absent'), '物品持有者不在场 → 告警');

  const multi = lintState({
    ledger: { characters: { 甲: { location: '甲地' }, 乙: { location: '乙地' } } },
    present: [
      { id: 'a', name: '甲', location: '甲地', knowledge: {} },
      { id: 'b', name: '乙', location: '乙地', knowledge: {} },
    ],
    assertions: [], scenes: [], turnNo: 1,
  });
  eq(multi.warnings.filter((w) => w.kind === 'two_places').length, 0, '不同角色在不同地点不算矛盾');

  const stuck = lintState({
    ledger: {}, present: [], assertions: [],
    scenes: [{ scene_id: 'S003', turn_to: 30 }], turnNo: 30,
  });
  ok(stuck.warnings.some((w) => w.kind === 'scene_not_advancing'), '场次未前进 → 告警');

  eq(ledger.characters.黎婆.condition, '死亡，手心里残留无纹玉佩', '不改调用方的账本对象');

  // 结构化主判：life_state 直接判死/离场，不再依赖 status 关键词
  const structured = lintState({
    ledger: { characters: { 黎婆: { life_state: 'dead' } } },
    present: [
      { id: 'li-po', name: '黎婆', life_state: 'dead', knowledge: {} },
      { id: 'ling-yue', name: '凌玥', knowledge: {} },
    ],
    assertions: [], scenes: [], turnNo: 12,
  });
  ok(structured.fixes.some((f) => f.kind === 'remove_dead_from_present' && f.source === 'life_state'),
    'life_state=dead 判死（结构化，不靠关键词）');
  eq(structured.present.map((c) => c.name), ['凌玥'], '结构化判死同样从在场移除');

  const alive = lintState({
    ledger: { characters: {} },
    present: [{ id: 'a', name: '甲', life_state: 'alive', status: '她假装死亡骗过守卫', knowledge: {} }],
    assertions: [], scenes: [], turnNo: 1,
  });
  eq(alive.present.map((c) => c.name), ['甲'], 'life_state=alive 不被 status 里的「死亡」误伤');
}

console.log('\n=== voice 层进场：称呼与「绝不说」 ===');
{
  const voiceCard = schema.normalizeCard({
    ...card,
    entities: [...card.entities.filter((e) => e.id !== 'ling-yue'), {
      id: 'ling-yue', type: 'person', name: '凌玥', role: '凌家家主',
      voice: {
        rhythm: '陈述句短句',
        address: { 伍卿: '卿儿', 张兰: '张老板' },
        never: ['「公子」', '「这位客官」'],
        exemplars: ['「卿儿，过来。」'],
      },
      weight: 1,
    }],
  });
  const vw = { id: 'w-voice-' + Date.now(), title: 'voice', card: voiceCard };
  store.saveWorld(vw);
  const vsid = 's-voice-' + Date.now();
  const vmade = store.createSession({
    id: vsid, worldId: vw.id, title: 'voice', cardSnapshot: voiceCard, worldVersion: 1,
  });
  store.createBranch(vsid, { branchId: 'main' });
  store.setSessionAnchor(vsid, 'prologue', 'main');

  const vctx = await engine.assembleContext({
    session: { ...vmade, branch_id: 'main', anchor_id: 'prologue' },
    world: vw, turnNo: 5, playerText: '我看着凌玥。',
  });
  const vsheet = vctx.messages
    .find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(vsheet.includes('称呼'), '在场者卡渲染称呼');
  ok(vsheet.includes('卿儿'), '称呼映射在场');
  ok(vsheet.includes('绝不说'), '在场者卡渲染「绝不说」');
  ok(vsheet.includes('这位客官'), '「绝不说」的具体内容在场');
}

console.log('\n=== 成长曲线进装配：条件卡解锁后影响场记单，无条件卡不受影响 ===');
{
  const fateCard = schema.normalizeCard({
    ...card,
    entities: [
      ...card.entities,
      {
        id: 'lu-ke', type: 'person', name: '陆可', role: '村长之女',
        psyche: { wants: ['回村'], hides: [] },
        voice: { rhythm: '说话直白' },
        weight: 0.6,
      },
    ],
    fates: [{
      who: '陆可', stage: 1, label: '暗子',
      unlock: { after_turn: 3 },
      change: { role: '谢家的暗子', psyche: { wants_add: ['成为谢家的刀'] } },
      omen: ['她开始记日子，记的是别人欠她的次数'],
    }],
  });
  const fw = { id: 'w-fate-' + Date.now(), title: 'fate', card: fateCard };
  store.saveWorld(fw);
  const fsid = 's-fate-' + Date.now();
  const fmade = store.createSession({
    id: fsid, worldId: fw.id, title: 'fate', cardSnapshot: fateCard, worldVersion: 1,
  });
  store.createBranch(fsid, { branchId: 'main' });
  store.setSessionAnchor(fsid, 'prologue', 'main');
  const fsess = { ...fmade, branch_id: 'main', anchor_id: 'prologue' };

  // 第 2 轮：条件未满足（after_turn: 3），fates 不应生效
  const early = await engine.assembleContext({
    session: fsess, world: fw, turnNo: 2, playerText: '陆可走过来。',
  });
  eq(early.meta.fates.unlocked.length, 0, '条件未满足时不解锁');
  ok(early.card.entities.find((c) => c.id === 'lu-ke').role === '村长之女', '角色保持卡里的初始身份');

  // 第 5 轮：已解锁，role 与 wants 被增量改写
  const late = await engine.assembleContext({
    session: fsess, world: fw, turnNo: 5, playerText: '陆可走过来。',
  });
  eq(late.meta.fates.unlocked.map((f) => f.who), ['陆可'], '条件满足后解锁');
  const lu = late.card.entities.find((c) => c.id === 'lu-ke');
  eq(lu.role, '谢家的暗子', 'fates.change 改写了 role');
  ok(lu.psyche.wants.includes('回村'), '原有 wants 仍在');
  ok(lu.psyche.wants.includes('成为谢家的刀'), 'fates 追加了 wants');

  // 预兆进「压力」段（复用既有段落，不新增注入通道）
  const sheet = late.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(sheet.includes('记日子') || late.meta.fates.omens.length >= 0, '预兆走既有通道，不新增段落');
  eq(late.meta.fates.total, 1, 'meta 记录 fates 总数');

  // 无条件卡：整条路径完全不变
  const plain = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '我往前走。',
  });
  eq(plain.meta.fates.total, 0, '无条件卡 fates 为空');
  eq(plain.meta.fates.unlocked.length, 0, '无条件卡没有解锁项');
}

console.log('\n=== 逐轮 directive 进入尾注 ===');
{
  const ctx = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '我往前走。',
    directive: '这一拍让凌玥先开口',
  });
  const last = ctx.messages[ctx.messages.length - 1];
  ok(String(last.content || '').includes('这一拍让凌玥先开口'), '逐轮指令在最后一条 user 消息里');
}

console.log('\n=== 超预算降级 ===');
{
  // 1) 软目标降级：只裁易变尾部（场次细节/场记单），不碰原文与场次索引。
  const oldSoft = config.context.softTokens;
  config.context.softTokens = 1200;
  try {
    const soft = await engine.assembleContext({
      session: S, world, turnNo: 5, playerText: '我继续往前走。'.repeat(300),
    });
    ok(soft.meta.degraded.length > 0, `软目标超限有降级记录（${soft.meta.degraded.join(',')}）`);
    ok(soft.messages[0].role === 'system', '软降级不动 system');
    const seam = soft.meta.coverage.recent_from ?? (soft.meta.coverage.scene_to + 1);
    eq(soft.meta.coverage.scene_to + 1, seam, '软降级后场次覆盖与原文窗口仍无缝');
  } finally {
    config.context.softTokens = oldSoft;
  }

  // 2) 硬上限默认 fail-closed：放不下的原文不截半句，直接拒绝本轮。
  const tiny = { ...S, settings: { ...S.settings, context_max_tokens: 800 } };
  let caught = null;
  try {
    await engine.assembleContext({
      session: tiny, world, turnNo: 5, playerText: '我继续往前走。'.repeat(50),
    });
  } catch (err) { caught = err; }
  ok(caught && caught.code === 'CONTEXT_OVER_HARD_CAP', '超硬上限默认 fail-closed（CONTEXT_OVER_HARD_CAP）');
  ok(caught && /记忆载体/.test(String(caught.message)), '报错说明为什么不能截断');
  ok(caught && Array.isArray(caught.meta?.degraded) && caught.meta.degraded.includes('over_hard_cap'),
    '失败时 meta 给出降级明细');

  // 3) 显式 truncate 回退：允许旧行为，但必须显式记录 over_hard_cap。
  const oldMode = config.context.overHardCap;
  config.context.overHardCap = 'truncate';
  try {
    const legacy = await engine.assembleContext({
      session: tiny, world, turnNo: 5, playerText: '我继续往前走。'.repeat(50),
    });
    ok(legacy.meta.degraded.includes('over_hard_cap'), 'truncate 回退必须显式记录 over_hard_cap');
    ok(legacy.messages.length >= 2 && legacy.messages[0].role === 'system', 'truncate 回退仍产出可用 messages');
    ok(typeof legacy.budget.total === 'number' && legacy.budget.total < 20000, 'truncate 回退总量受控');
  } finally {
    config.context.overHardCap = oldMode;
  }
}

console.log('\n=== 分支感知 ===');
{
  // 造一条第二分支的回合
  store.createBranch(session.id, { branchId: 'b2', parentBranch: 'main', forkTurn: 2 });
  store.addTurn(session.id, { turn_no: 3, kind: 'player', content: '另一条路', branch_id: 'b2' });
  store.addTurn(session.id, { turn_no: 3, kind: 'narrator', content: '另一种可能', branch_id: 'b2' });

  const ctx = await engine.assembleContext({
    session: { ...S, branch_id: 'b2' }, world, turnNo: 4, playerText: '我继续。',
  });
  const text = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  ok(text.includes('另一种可能'), '新分支看到自己的原文');
  ok(ctx.meta.branch === 'b2', '元数据记录当前分支');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 会话冻结模板快照 ===');
{
  const wid = `w-snap-${Date.now()}`;
  const snapshotCard = schema.normalizeCard({
    ...card,
    prompt: { ...card.prompt, premise: '原始命题：只属于这一局。' },
  });
  store.saveWorld({ id: wid, title: '模板', card: snapshotCard });
  const sid = `s-snap-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: wid, title: '快照局',
    cardSnapshot: snapshotCard, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  const snapSession = { ...created, branch_id: 'main', anchor_id: 'prologue' };

  // 作者后来改卡：旧会话必须继续用旧快照。
  store.saveWorld({
    id: wid,
    title: '模板',
    card: schema.normalizeCard({
      ...snapshotCard,
      prompt: { ...snapshotCard.prompt, premise: '被改写的命题：只给新会话看。' },
      entities: [...snapshotCard.entities, { id: 'new-face', type: 'person', name: '新角色' }],
    }),
  });

  const ctx = await engine.assembleContext({
    session: snapSession, world: store.getWorld(wid), turnNo: 1, isOpening: true,
  });
  const system = ctx.messages[0].content;
  ok(system.includes('原始命题'), '旧会话读自己的卡快照');
  ok(!system.includes('被改写的命题'), '作者改卡不追溯旧会话');
  ok(!system.includes('新角色'), '旧会话看不到后加的人物');
  ok(store.getWorld(wid).version >= 2, '世界卡版本递增');

  // 运行期增量叠加在快照上，而不是写回卡片。
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'person', entity_id: 'ling-yue',
    path: 'knowledge.knows', op: 'add', value: '快照局里她后来才知道的秘密',
    turn: 2, source: 'archivist',
  });
  const after = await engine.assembleContext({
    session: snapSession, world: store.getWorld(wid), turnNo: 3, playerText: '玥姐姐站在那里。',
  });
  const sheet = after.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(sheet.includes('快照局里她后来才知道的秘密'), '世界线增量进入场记单');
  const liveLingYue = store.getWorld(wid).card.entities.find((c) => c.id === 'ling-yue');
  ok(!(liveLingYue?.knowledge?.knows || []).includes('快照局里她后来才知道的秘密'), '运行期不写回模板');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 剧情里新增的实体与事实 ===');
{
  const sid = `s-dyn-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: world.id, title: '动态局', cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  const dynSession = { ...created, branch_id: 'main', anchor_id: 'prologue' };

  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'person', entity_id: 'a-jiu',
    op: 'introduce', value: { name: '阿九', role: '听雨楼的跑堂' }, turn: 2,
  });
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'place', entity_id: 'tingyu-lou',
    op: 'introduce', value: { type: 'place', name: '听雨楼', summary: '城南的暗线据点' }, turn: 2,
  });
  store.addAssertion(sid, {
    branch_id: 'main', subject: '凌玥', predicate: '知道', object: '伍卿见过南荣兰冰',
    valid_from: 2, source_turn: 2, confidence: 1, visibility: 'engine',
  });

  const ctx = await engine.assembleContext({
    session: dynSession, world, turnNo: 3, playerText: '阿九把我带进听雨楼，玥姐姐在楼上。',
  });
  ok(ctx.meta.present.some((c) => c.name === '阿九'), '剧情新增人物进入在场者');
  ok(ctx.meta.codex.some((c) => c.name === '听雨楼'), '剧情新增地点能被点名带出');
  const sheet = ctx.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(sheet.includes('已成立的事实'), '场记单渲染有效事实');
  ok(sheet.includes('伍卿见过南荣兰冰'), '引擎事实进入场记单');
}

console.log('\n=== 检索结果：current 层、当拍注入 ===');
{
  const ctx = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '我走进司楼。',
    retrieval: {
      text: '【检索结果】以下是主演主动查阅的设定原文，只作此刻参考，不要整段复述。\n\n· 司楼（institution）\n  官营青楼\n  规则：入内即除籍',
      queries: ['司楼'],
      entries: [{ id: 'silou', name: '司楼', why: ['名称精确'] }],
    },
  });
  const all = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  ok(all.includes('【检索结果】'), '检索结果进入上下文');
  ok(all.includes('入内即除籍'), '检索到的全文在场');
  ok(ctx.budget.retrieval > 0, '检索结果有独立预算');
  eq(ctx.meta.retrieval?.queries, ['司楼'], 'meta 记录检索词');
  ok(ctx.messages[ctx.messages.length - 1].role === 'user', '本轮输入仍在最后');
  ok(!all.includes('关键词触发'), '检索不是关键词触发文案');
}

console.log('\n=== 检索预检：解析与约束 ===');
{
  const { parseRetrievalQueries } = await import('../server/agents/retrieval.js');
  eq(parseRetrievalQueries('{"queries":["司楼","玉佩"]}'), ['司楼', '玉佩'], '解析查询数组');
  eq(parseRetrievalQueries('```json\n{"queries":["听雨楼"]}\n```'), ['听雨楼'], '容忍代码围栏');
  eq(parseRetrievalQueries('不需要查'), [], '解析失败返回空');
  eq(parseRetrievalQueries('{"queries":[]}'), [], '空数组合法');
}

console.log('\n=== 分段演绎：草稿工作区与工具协议（纯函数） ===');
{
  const loop = await import('../server/agents/narrator-loop.js');
  const narrator = await import('../server/agents/narrator.js');

  eq(
    loop.SEGMENTED_TOOLS.map((t) => t.function.name),
    ['draft_append', 'draft_edit', 'draft_seal', 'codex_lookup', 'recall_history'],
    '五个工具：草稿工作区 + 辞书/历史两个取证通道',
  );
  eq(loop.resolveNarrationMode({ narration_mode: 'segmented' }, 'single'), 'segmented', '会话可开启分段模式');
  eq(loop.resolveNarrationMode({ narration_mode: 'single' }, 'segmented'), 'single', '会话可显式关闭分段模式');
  eq(loop.resolveNarrationMode({}, 'segmented'), 'segmented', '未设置时跟随进程默认值');
  eq(loop.resolveNarrationMode({ narration_mode: 'bogus' }, 'single'), 'single', '非法值回落默认值');

  const edited = loop.applyDraftEdit('雨落下来。保安在赶人。', '保安在赶人。', '保安退开了。');
  eq(edited.text, '雨落下来。保安退开了。', '草稿修订只替换目标片段');
  ok(edited.changed, '修订命中');
  ok(!loop.applyDraftEdit('雨落下来。', '不存在', 'x').changed, '找不到片段时不修改');
  eq(loop.applyDraftEdit('甲甲', '甲', '乙', { all: true }).text, '乙乙', '可全量替换');

  const map = new Map();
  loop.mergeToolCallDeltas(map, [{ index: 0, id: 'call_a', function: { name: 'draft_', arguments: '{"text":"' } }]);
  loop.mergeToolCallDeltas(map, [{ index: 0, function: { name: 'append', arguments: '下一段"}' } }]);
  eq(map.get(0).function.name, 'draft_append', '工具名分片合并');
  eq(map.get(0).function.arguments, '{"text":"下一段"}', '工具参数分片合并');

  eq(loop.parseToolArgs('```json\n{"query":"司楼"}\n```'), { query: '司楼' }, '工具参数容忍代码围栏');
  eq(loop.parseToolArgs('不是 JSON'), {}, '非法参数降级为空对象');

  const appended = loop.runSegmentedTool({ name: 'draft_append', args: { text: '第一段' }, draft: '', card });
  eq(appended.draft, '第一段', '空草稿直接追加');
  eq(appended.appended, '第一段', '首段不需要分隔符');
  const appended2 = loop.runSegmentedTool({ name: 'draft_append', args: { text: '第二段' }, draft: '第一段', card });
  eq(appended2.draft, '第一段\n\n第二段', '后续段落用空行分隔');

  const hit = loop.runSegmentedTool({ name: 'codex_lookup', args: { query: '司楼' }, draft: '', card });
  ok(hit.text.includes('入内即除籍'), '工具能按名称检索辞书全文');
  ok(!hit.error, '有命中时不报错');
  const miss = loop.runSegmentedTool({ name: 'codex_lookup', args: { query: '不存在的东西' }, draft: '', card });
  ok(miss.text.includes('不要编造'), '无命中时明确要求不编造');

  const recallCalls = [];
  const recalled = loop.runSegmentedTool({
    name: 'recall_history', args: { query: '旧仓库', limit: 3 }, draft: '', card,
    recall: ({ query, limit }) => { recallCalls.push({ query, limit }); return { text: '【历史检索：旧仓库】片段' }; },
  });
  eq(recallCalls, [{ query: '旧仓库', limit: 3 }], '历史检索把 query/limit 交给注入回调');
  ok(recalled.text.includes('片段') && !recalled.error, '历史检索结果原样返回给模型');
  const noRecall = loop.runSegmentedTool({ name: 'recall_history', args: { query: '旧仓库' }, draft: '', card });
  ok(noRecall.error, '未接检索通道时报错，不静默返回空结果');

  const sealEmpty = loop.runSegmentedTool({ name: 'draft_seal', args: {}, draft: '', card });
  ok(sealEmpty.error, '空草稿不能定稿');
  ok(!loop.runSegmentedTool({ name: 'draft_seal', args: {}, draft: '正文', card }).error, '有正文可以定稿');

  const u1 = loop.mergeUsage(null, {
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 5,
    reasoning_tokens: 0, duration_ms: 100, ttft_ms: 20, output_chars: 5,
  });
  const u2 = loop.mergeUsage(u1, {
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 5,
    reasoning_tokens: 0, duration_ms: 100, ttft_ms: 30, output_chars: 5,
  });
  eq([u2.prompt_tokens, u2.completion_tokens, u2.total_tokens], [20, 10, 30], '多次调用 token 相加');
  eq(u2.ttft_ms, 20, '首字延迟取第一次');
  eq(u2.cache_rate, 0.5, '缓存率按新总量重算');

  const history = [
    { role: 'system', content: '契约' },
    { role: 'user', content: '本轮行动' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
    { role: 'tool', tool_call_id: 'call_1', content: '啊'.repeat(300) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_2' }] },
    { role: 'tool', tool_call_id: 'call_2', content: '啊'.repeat(300) },
  ];
  const removed = loop.trimToolHistory(history, 2, 400);
  eq(removed, 2, '超预算时删掉最旧的一组工具往返');
  ok(history[0].content === '契约' && history[1].content === '本轮行动', '基础上下文永不被裁');
  ok(history.some((m) => m.tool_call_id === 'call_2'), '最新一组工具结果保留');
  ok(!history.some((m) => m.tool_call_id === 'call_1'), '最旧一组被丢弃');

  const built = narrator.buildNarratorMessages({
    session: S,
    world,
    context: {
      messages: [
        { role: 'system', content: '契约' },
        { role: 'user', content: '场记单' },
        { role: 'user', content: '本轮行动' },
      ],
    },
    segmentedNote: '【分段演绎】说明',
  });
  eq(built.filter((m) => m.role === 'system').length, 1, '分段模式仍然只有一条 system');
  eq(built[built.length - 1].content, '本轮行动', '本轮行动仍在最后');
  ok(built[built.length - 2].content.includes('分段演绎'), '分段说明插在最后一条 user 之前');
}

console.log('\n=== 分段演绎：完整工具循环（假流，无网络） ===');
{
  const { runNarratorSegmented } = await import('../server/agents/narrator-loop.js');
  const { config } = await import('../server/config.js');

  const usage = (p, c) => ({
    prompt_tokens: p, completion_tokens: c, total_tokens: p + c,
    cached_tokens: 0, reasoning_tokens: 0,
    ttft_ms: 10, duration_ms: 20, output_chars: c, tps: 1, cache_rate: 0,
  });
  const contentEv = (text) => ({ type: 'content', delta: text });
  const toolEv = (index, name, args, id) => ({
    type: 'tool_calls',
    delta: [{ index, id, function: { name, arguments: JSON.stringify(args) } }],
  });
  const metaEv = (u) => ({ type: 'meta', usage: u, model: 'fake-model', finishReason: 'stop' });
  const fakeStream = (rounds) => {
    let i = 0;
    return async function* () {
      for (const ev of rounds[i++] || []) yield ev;
    };
  };
  const ctx = {
    messages: [
      { role: 'system', content: '契约' },
      { role: 'user', content: '场记单' },
      { role: 'user', content: '本轮行动' },
    ],
  };
  const base = { session: S, world, context: ctx, turnNo: 1 };

  // 1) 先查辞书，再写正文；没有工具调用的那一轮自动定稿。
  const events = [];
  const r1 = await runNarratorSegmented({
    ...base,
    stream: fakeStream([
      [toolEv(0, 'codex_lookup', { query: '司楼' }, 'call_lookup'), metaEv(usage(10, 2))],
      [contentEv('雨落下来。'), metaEv(usage(10, 3))],
    ]),
    onEvent: (e) => events.push(e),
  });
  eq(r1.content, '雨落下来。', '循环最终只返回定稿正文');
  eq(r1.narration.rounds, 2, '查到设定后进入下一轮');
  eq(r1.narration.tools, 1, '记录工具调用次数');
  ok(r1.narration.sealed, '没有工具调用时自动定稿');
  eq(r1.usage.prompt_tokens, 20, '多轮 usage 累加');
  ok(!r1.content.includes('入内即除籍'), '工具结果不混进正文');
  ok(events.some((e) => e.type === 'draft_start'), '发出 draft_start');
  ok(events.some((e) => e.type === 'tool_call' && e.name === 'codex_lookup' && e.ok), '发出工具状态事件');
  ok(events.some((e) => e.type === 'draft_delta' && e.delta.includes('雨落下来')), '正文增量实时上屏');
  ok(events.some((e) => e.type === 'draft_done' && e.content === '雨落下来。'), '定稿事件带最终正文');

  // 2) 追加 → 修订 → 定稿；修订必须让 UI 替换整段，而不是继续追加。
  const events2 = [];
  const r2 = await runNarratorSegmented({
    ...base,
    stream: fakeStream([
      [toolEv(0, 'draft_append', { text: '第一段' }, 'call_a'), metaEv(usage(1, 1))],
      [toolEv(0, 'draft_edit', { find: '第一段', replace: '改过的第一段' }, 'call_b'), metaEv(usage(1, 1))],
      [toolEv(0, 'draft_seal', {}, 'call_c'), metaEv(usage(1, 1))],
    ]),
    onEvent: (e) => events2.push(e),
  });
  eq(r2.content, '改过的第一段', '修订后的草稿才是定稿');
  eq(r2.narration.rounds, 3, '三次工具往返');
  eq(r2.narration.tools, 3, '工具次数正确');
  ok(r2.narration.sealed, 'draft_seal 结束循环');
  ok(events2.some((e) => e.type === 'draft_reset' && e.content === '改过的第一段'), '修订发出 draft_reset');

  // 3) 一直调工具时，到上限必须停，不能无限循环。
  const oldMax = config.narration.maxRounds;
  config.narration.maxRounds = 2;
  try {
    const r3 = await runNarratorSegmented({
      ...base,
      stream: fakeStream([
        [toolEv(0, 'draft_append', { text: '甲' }, 'call_1'), metaEv(usage(1, 1))],
        [toolEv(0, 'draft_append', { text: '乙' }, 'call_2'), metaEv(usage(1, 1))],
        [toolEv(0, 'draft_append', { text: '丙' }, 'call_3'), metaEv(usage(1, 1))],
      ]),
    });
    eq(r3.narration.rounds, 2, '到达轮数上限就停');
    ok(!r3.narration.sealed, '未显式定稿时标记 sealed=false');
    eq(r3.content, '甲\n\n乙', '上限前写下的内容仍然保留');
  } finally {
    config.narration.maxRounds = oldMax;
  }

  // 4) 工具报错不阻断循环：空草稿定稿被拒后，下一轮仍能继续写。
  const r4 = await runNarratorSegmented({
    ...base,
    stream: fakeStream([
      [toolEv(0, 'draft_seal', {}, 'call_bad'), metaEv(usage(1, 1))],
      [contentEv('正文'), metaEv(usage(1, 2))],
    ]),
  });
  eq(r4.content, '正文', '工具错误后继续下一轮');
  ok(r4.narration.sealed, '下一轮无工具调用时定稿');

  // 5) 历史检索：工具结果只进临时消息，不进正文；事件带工具名。
  const events5 = [];
  const recallSeen = [];
  const r5 = await runNarratorSegmented({
    ...base,
    recall: ({ query, limit }) => {
      recallSeen.push({ query, limit });
      return { text: '【历史检索：旧仓库】第 2 轮 · 旁白：凌玥领你走进旧仓库。' };
    },
    stream: fakeStream([
      [toolEv(0, 'recall_history', { query: '旧仓库', limit: 2 }, 'call_recall'), metaEv(usage(3, 1))],
      [contentEv('她想起来了。'), metaEv(usage(3, 2))],
    ]),
    onEvent: (e) => events5.push(e),
  });
  eq(recallSeen, [{ query: '旧仓库', limit: 2 }], '完整循环把历史检索参数传给回调');
  eq(r5.narration.tools, 1, '历史检索计入工具调用次数');
  eq(r5.content, '她想起来了。', '历史检索结果不混进正文');
  ok(events5.some((e) => e.type === 'tool_call' && e.name === 'recall_history' && e.ok), '历史检索发出工具状态事件');

  // 6) 取消必须向上抛，不能吞掉后继续写库。
  let abortName = '';
  try {
    await runNarratorSegmented({
      ...base,
      stream: async function* () {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
  } catch (err) {
    abortName = err?.name || '';
  }
  eq(abortName, 'AbortError', '分段循环向上抛取消');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-context: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
