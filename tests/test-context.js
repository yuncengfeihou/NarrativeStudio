#!/usr/bin/env node
/**
 * tests/test-context.js — 上下文装配 v4（无网络）
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
  cast: [
    {
      id: 'ling-yue', name: '凌玥', aliases: ['玥姐姐', '凌家主'],
      role: '帝都凌家家主 · 伍卿的「妻主」', one_line: '对天下是棋手，对少年是流氓。',
      voice: { rhythm: '陈述句、短句、笑着说的狠话', exemplars: ['「卿儿，过来。」'] },
      psyche: { wants: ['把他带走'], hides: ['七年前是她母亲丢的人'] },
      knowledge: { knows: ['七年前的真相'], does_not_know: ['伍卿见过南荣兰冰'] },
      agenda: [{ goal: '今天必须把他带走', method: '不能用施舍的方式', pressure: 0.9 }],
      weight: 1,
    },
    { id: 'zhang-lan', name: '张兰', role: '大厦保安', one_line: '势利而胆小', weight: 0.3 },
    { id: 'li-po', name: '黎婆', role: '伍卿的奶奶', one_line: '恨凌家', weight: 0.5 },
  ],
  codex: [
    {
      id: 'silou', type: 'institution', name: '司楼', aliases: ['青楼'],
      tags: ['制度', '交易'], summary: '官营青楼，男子被卖进去等于消失。',
      facets: { rules: ['入内即除籍'], consequences: ['家里会办丧事'] },
      links: ['cast:ling-yue'], canon_from: 'prologue',
    },
    {
      id: 'cheng-hu', type: 'concept', name: '称呼礼法', tags: ['制度'],
      summary: '称「公子」是抬举，称「卿儿」是私密。',
      facets: {}, links: [], pinned: true, canon_from: 'prologue',
    },
    {
      id: 'yupei', type: 'item', name: '无纹玉佩', aliases: ['玉佩'],
      tags: ['未解'], summary: '凌玥所赠，遇暗发绿光。',
      facets: {}, links: ['cast:ling-yue'], reveal: 'secret', canon_from: 'prologue',
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
      place_id: 'place:yujie',
      characters: { 'wu-qing': { mood: '窘迫', condition: '湿透' } },
      inventory: [{ id: 'item:yupei', name: '无纹玉佩', holder: '伍卿' }],
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
  // 过去的 canon 也不直接进（它活在状态与场记单里，不当成待复述的剧本）
  ok(!all.includes('凌玥的母亲把伍卿丢在街上'), 'timeline 的 past 事件也不当剧本注入');
  ok(ctx.meta.timeline_future_held === 1, '但元数据记录住「有 1 条未来参考被扣留」');

  // 系统层包含宪章与索引
  ok(all.includes('【世界宪章】'), '宪章在场');
  ok(all.includes('【世界索引】'), '世界索引在场');
  ok(all.includes('女子主外'), '宪章内容在场');
  ok(all.includes('凌玥（'), '索引里有人物');
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
    cast: [
      { id: 'a', name: '甲', relations: [{ to: 'b', kind: '旧识' }] },
      { id: 'b', name: '乙' },
    ],
    codex: [
      { id: 'p', name: '当前地', type: 'place', summary: '这里' },
      { id: 'n', name: '邻居物', type: 'item', summary: '挨着甲', links: ['cast:a'] },
      { id: 'pin', name: '钉选物', type: 'concept', summary: '常驻', pinned: true },
      { id: 'far', name: '远处物', type: 'item', summary: '无连接' },
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
  const gCard = schema.normalizeCard({ title: 'g', codex: [{ name: '司楼', aliases: ['青楼'] }] });
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
  ok(sheet.includes('私心：今天必须把他带走'), '私心来自 cast.agenda');
  ok(sheet.includes('边界：'), '知识边界在场');
  ok(sheet.includes('未回收的线索') || sheet.includes('压力'), '线索/压力段至少有一段');
  ok(!sheet.includes('玉佩'), 'reveal=secret 的条目不被链接带出时不出现在单子里');
}

console.log('\n=== 体积不随轮数增长（原文窗口由摘要沉淀控制） ===');
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
    // 模拟真实沉淀节奏：每 4 轮覆盖到 i-2，原文窗口只保留边界之后的回合。
    if (i % 4 === 0 && i >= 4) {
      store.addSummary(sid, {
        branchId: 'main', coversTurnTo: i - 2,
        text: `摘要覆盖到第 ${i - 2} 轮。${'旧剧情已经沉淀。'.repeat(80)}`,
      });
    }
  }

  const sizes = [];
  for (const turnNo of [1, 50, 200, 500]) {
    const ctx = await engine.assembleContext({
      session: volSession, world, turnNo, playerText: '我继续往前走。',
    });
    sizes.push({ turnNo, ...ctx.budget, coverage: ctx.meta.coverage });
    ok(ctx.meta.coverage.summary_to < turnNo, `第 ${turnNo} 轮：摘要不覆盖当前轮`);
    ok(
      ctx.meta.coverage.recent_from == null
        || ctx.meta.coverage.recent_from === ctx.meta.coverage.summary_to + 1,
      `第 ${turnNo} 轮：摘要边界与原文起点首尾相接`,
    );
  }
  for (const s of sizes) {
    console.log(`  第 ${String(s.turnNo).padStart(3)} 轮  合计 ${s.total}  tok（系统 ${s.system}｜原文 ${s.recent}｜场记单 ${s.scene}）`);
  }
  const first = sizes[0].total;
  const last = sizes[sizes.length - 1].total;
  ok(last < first * 2.2, `500 轮与第 1 轮同量级（${first} → ${last}）`);
  ok(sizes.every((s) => s.system < 4200), '系统层受配额约束');
  ok(sizes.every((s) => s.scene < 3000), '场记单受配额约束');
}

console.log('\n=== 覆盖不变量：摘要覆盖过的回合不再逐字，边界之后全部逐字 ===');
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
  store.addSummary(sid, { branchId: 'main', coversTurnTo: 6, text: '前六轮摘要。' });

  const ctx = await engine.assembleContext({
    session: coverSession, world, turnNo: 21, playerText: '我继续往前走。',
  });
  const all = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  ok(all.includes('旧正文7'), '摘要边界之后的第一轮仍在（不再只取最后 8 轮）');
  ok(all.includes('旧正文20'), '最新一轮仍在');
  ok(!all.includes('旧正文6'), '摘要覆盖的回合不再逐字重复');
  eq(ctx.meta.coverage.summary_to, 6, 'meta 记录摘要边界');
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
    cast: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `人物${i}`, role: '角色' })),
    codex: Array.from({ length: 60 }, (_, i) => ({
      id: `k${i}`, name: `条目${i}`, type: 'concept', summary: '摘要'.repeat(20),
    })),
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
  ok(!sys.includes('摘要'.repeat(5)), '世界索引在必需单元之后退化为只留名字');
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
    branch_id: 'main', entity_kind: 'cast', entity_id: 'ling-yue',
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
  // 用一个极小的软上限触发降级路径
  const tiny = { ...S, settings: { ...S.settings, context_max_tokens: 2000 } };
  const ctx = await engine.assembleContext({
    session: tiny, world, turnNo: 5, playerText: '我继续往前走。'.repeat(50),
  });
  ok(ctx.budget.total <= 2400, `软上限下总量受控（${ctx.budget.total} tok）`);
  ok(ctx.messages[0].role === 'system', '降级不动 system');
  ok(ctx.messages.some((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】')), '降级后场记单仍在');
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
      cast: [...snapshotCard.cast, { id: 'new-face', name: '新角色' }],
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
    branch_id: 'main', entity_kind: 'cast', entity_id: 'ling-yue',
    path: 'knowledge.knows', op: 'add', value: '快照局里她后来才知道的秘密',
    turn: 2, source: 'archivist',
  });
  const after = await engine.assembleContext({
    session: snapSession, world: store.getWorld(wid), turnNo: 3, playerText: '玥姐姐站在那里。',
  });
  const sheet = after.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(sheet.includes('快照局里她后来才知道的秘密'), '世界线增量进入场记单');
  const liveLingYue = store.getWorld(wid).card.cast.find((c) => c.id === 'ling-yue');
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
    branch_id: 'main', entity_kind: 'cast', entity_id: 'a-jiu',
    op: 'introduce', value: { name: '阿九', role: '听雨楼的跑堂' }, turn: 2,
  });
  store.addWorldState(sid, {
    branch_id: 'main', entity_kind: 'codex', entity_id: 'tingyu-lou',
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

console.log('\n=== 前情提要：覆盖边界与最近原文 ===');
{
  const sid = `s-sum-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: world.id, title: '摘要局', cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  const sumSession = { ...created, branch_id: 'main', anchor_id: 'prologue' };

  for (let i = 1; i <= 10; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: `旧行动${i}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: i, kind: 'narrator', content: `旧正文${i}`, branch_id: 'main' });
  }
  store.addSummary(sid, {
    branchId: 'main', coversTurnTo: 6,
    text: '前六轮摘要：凌玥在雨街带走了伍卿，玉佩还在她手里。',
  });

  const ctx = await engine.assembleContext({
    session: sumSession, world, turnNo: 9, playerText: '我继续往前走。',
  });
  const all = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

  ok(all.includes('【前情提要】'), '摘要层在场');
  ok(all.includes('前六轮摘要'), '摘要内容在场');
  ok(!all.includes('旧正文1'), '被覆盖的早期原文不再逐字出现');
  ok(all.includes('旧正文7'), '覆盖边界之后的最近原文仍在');
  ok(ctx.budget.summary > 0, '摘要层有独立预算');
  eq(ctx.meta.summary?.covers_turn_to, 6, 'meta 记录摘要覆盖边界');
  ok(ctx.messages[0].role === 'system', '摘要不改变 system 位置');
  ok(ctx.messages[ctx.messages.length - 1].role === 'user', '本轮输入仍在最后');

  // 摘要 Agent 写超时，装配层必须按 BUDGET_SUMMARY 截断，不能挤占其他层。
  store.addSummary(sid, { branchId: 'main', coversTurnTo: 6, text: '长'.repeat(6000) });
  const long = await engine.assembleContext({
    session: sumSession, world, turnNo: 9, playerText: '我继续往前走。',
  });
  ok(long.budget.summary <= config.context.layerBudget.summary + 8, '摘要层不超过独立配额');
  ok(!long.messages.some((m) => typeof m.content === 'string' && m.content.includes('长'.repeat(2000))),
    '超长摘要被截断');
}

console.log('\n=== 摘要沉淀：按 token 水位的纯函数 ===');
{
  const { planCompaction } = await import('../server/agents/summarizer.js');
  const rows = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({
    turn_no: offset + i + 1, content: '长'.repeat(100),
  }));
  eq(
    planCompaction({ active: null, rows: rows(4), highTokens: 10000, lowTokens: 8000, minRawTurns: 4, maxRawTurns: 12 }),
    null, '不超过高水位不压',
  );
  eq(
    planCompaction({ active: null, rows: rows(10), highTokens: 500, lowTokens: 200, minRawTurns: 4, maxRawTurns: 12 }),
    { from: 1, to: 6, covered: 0 },
    '超过高水位：压到低水位，保留至少 minRawTurns',
  );
  eq(
    planCompaction({ active: { covers_turn_to: 10 }, rows: rows(10, 10), highTokens: 500, lowTokens: 200, minRawTurns: 4, maxRawTurns: 12 }),
    { from: 11, to: 16, covered: 10 },
    '从上一份摘要边界之后开始',
  );
  eq(
    planCompaction({ active: null, rows: rows(6), highTokens: 100000, lowTokens: 80000, minRawTurns: 4, maxRawTurns: 4 }),
    { from: 1, to: 2, covered: 0 },
    '超过轮数上限也触发',
  );
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
    ['draft_append', 'draft_edit', 'draft_seal', 'codex_lookup'],
    '第一阶段只暴露四个工具',
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

  // 5) 取消必须向上抛，不能吞掉后继续写库。
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
