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
const { branchSystemPrompt, BRANCH_TONES } = await import('../server/prompts/branch.js');

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
  // 收束不再强制「每拍必须加压/必须立刻回应」——时间倒退与张力跑步机的两个源头。
  ok(!all.includes('必须立刻回应'), '没有「必须立刻回应」的收束强制');
  ok(!all.includes('禁止平稳收尾'), '没有「禁止平稳收尾」');
  ok(!all.includes('结尾必须留钩子'), '没有强制钩子');
  ok(!all.includes('每一段都必须推动情势'), '没有「每段必须推动」');
  ok(all.includes('结尾用在场者的动作、台词或一个未完成的场景收住'), '收束改为许可式（自然走完/推进时间都合法）');
  ok(all.includes('可以直接用一句过渡把时间推到'), '尾注给出时间推进通道（许可，不是强制）');
  ok(all.includes('不必把中间的每一分钟都演完'), '明确不必逐分钟演');
  ok(all.includes('玩家明确要做的动作'), '玩家明说要做的动作先发生（不被每拍拦回原地）');

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
  ok(/2\. 时态/.test(sys0), '未写篇幅：演出范式编号连续（篇幅不占号）');

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

console.log('\n=== 走向层：卡红线进场 + 赌注不再是每条 ===');
{
  const branchCard = schema.normalizeCard({
    title: '走向测试', premise: '一座旧城。', anchors: [],
    prompt: { bans: ['不得让主角突然会武'] },
    author_notes: [
      { text: '保持市井气', scope: 'always' },
      { text: '本场才用', scope: 'scene' },
    ],
    entities: [{ id: 'a-he', type: 'person', name: '阿禾', role: '守夜人' }],
    player: { mode: 'original', name: '旅人' },
  });
  const bp = branchSystemPrompt({ card: branchCard });
  ok(bp.includes('不得让主角突然会武'), '卡红线进走向提示词');
  ok(bp.includes('保持市井气'), '常驻作者笔记进走向提示词');
  ok(!bp.includes('本场才用'), 'scene 范围笔记不常驻');
  ok(bp.includes('至少 1 条') && bp.includes('有赌注'), '赌注降为至少一条');
  ok(bp.includes('日常'), '日常形态在标准/枚举里');
  ok(BRANCH_TONES.includes('日常'), '受控语气含日常');
  ok(!bp.includes('每条都要有明确的风险或代价'), '删掉了「每条都要赌注」');
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
  // 原声可见性（D23）：`voices` 按人分区取 perWho 条（不是全局窗口），
  // 在场者里有几个真有声线锚点，也要能读到。
  // （回声段已删（D18）；走向版场记单少哪段、省多少 token 由 branch_sheet 记录（D26）。）
  eq(
    ctx.meta.scene_sheet,
    {
      cast_mode: 'full', absentees: [], rumors: 0,
      voice_speakers: 0, voice_lines: 0, voice_present_covered: 0,
      branch_sheet: {
        trim: 'default',
        dropped_sections: ['codexBrief'], tokens: 120, full_tokens: 150,
      },
    },
    '场记单元信息：完整在场、无缺席者、声线计数与走向版裁剪可读',
  );
}

console.log('\n=== 走向版场记单：档位开关只裁走向那一份（D26）===');
{
  // 默认档位必须与旧实现逐字节等价：只少「附近设定」。
  ok(engine.resolveBranchSheetTrim({}) === 'default', '缺省档位 = default');
  ok(engine.resolveBranchSheetTrim({ branch_sheet_trim: '瞎写' }) === 'default', '非法档位不静默生效');
  ok(engine.resolveBranchSheetTrim({ branch_sheet_trim: 'core_only' }) === 'core_only', '合法档位透传');

  const secs = [
    { key: 'cast', text: '在场\n甲' },
    { key: 'facts', text: '已成立的事实\n· 甲 —知道→ 乙' },
    { key: 'knowledge', text: '知识边界\n甲不知道丙' },
    { key: 'codex', text: '本场可用设定\n· 物件' },
    { key: 'codexBrief', text: '附近设定\n· 一条' },
  ];
  eq(
    engine.selectBranchSections(secs, 'default').map((s) => s.key),
    ['cast', 'facts', 'knowledge', 'codex'],
    'default 只去掉「附近设定」（与旧实现逐字节等价）',
  );
  eq(
    engine.selectBranchSections(secs, 'core_only').map((s) => s.key),
    ['cast'],
    'core_only 只留走向真正会读的段',
  );

  // 会话级开关：同一拍、同一上下文，只换档位 → 送模那份场记单必须逐字节不变。
  const def = await engine.assembleContext({ session: S, world, turnNo: 1, isOpening: true });
  const core = await engine.assembleContext({
    session: { ...S, settings: { ...S.settings, branch_sheet_trim: 'core_only' } },
    world, turnNo: 1, isOpening: true,
  });
  const sheetOf = (c) => c.messages
    .find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  eq(sheetOf(core), sheetOf(def), '开关只影响走向那一份，送模场记单逐字节不变');
  ok(core.branchSheet.length < def.branchSheet.length || def.branchSheet === '',
    'core_only 的走向版更短', `def=${def.branchSheet.length} core=${core.branchSheet.length}`);
  ok((core.meta.scene_sheet.branch_sheet?.tokens ?? 0) <= (def.meta.scene_sheet.branch_sheet?.tokens ?? 0),
    'meta 记录的走向版 token 不增');
  ok((core.meta.scene_sheet.branch_sheet?.dropped_sections || []).includes('codexBrief'),
    'core_only 下 codexBrief 仍记为被丢');
  ok(!def.meta.scene_sheet.branch_sheet.dropped_sections.includes('facts'),
    'default 下 facts 不被记为丢弃');
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
  // 断言的真渲染上限不是 SQL 的 300，而是 selectFacts 的 manyLimit——
  // 而 manyLimit 现在是**按预算推导**的变量（D9-A1），不是写死的 10。
  ok(typeof ctx.meta.facts_single === 'number', '单值断言条数可数');
  ok(typeof ctx.meta.facts_many_rendered === 'number', '多值断言渲染条数可数');
  ok(typeof ctx.meta.facts_many_dropped === 'number', '多值断言丢弃条数可数');
  ok(typeof ctx.meta.facts_many_limit === 'number', '多值条数上限可数（推导值要能被核对）');
  eq(ctx.meta.facts_single + ctx.meta.facts_many_rendered, ctx.meta.facts, '渲染数 = 单值 + 多值（口径闭合）');
  // 推导式对着 plan 核一遍：场记单配额的 25% ÷ 单条成本 12.4，下限 10。
  eq(ctx.meta.facts_many_limit,
    Math.max(10, Math.floor((ctx.meta.plan.layers.scene * 0.25) / 12.4)),
    '多值条数上限 = 场记单配额 × 25% ÷ 12.4（预算驱动，不是魔数）');
  ok(ctx.meta.facts_many_limit > 10, '200K 窗口下上限远大于旧的魔数 10');

  /* ---- 截断可见化（D3）：SQL LIMIT 挡掉的行必须可数 ---- */
  // 之前只有 facts_many_dropped，它只统计「已取回 300 条里再丢的」，被 SQL 窗口挡在
  // 外面的永远测不到 → 「断言长到看不见」在报告里显示为健康。
  const lt = ctx.meta.layers_truncated;
  ok(!!lt, 'meta 里有 layers_truncated 分账');
  eq(lt.assertions.window, 300, '断言 SQL 窗口 = 300');
  eq(typeof lt.assertions.total, 'number', '断言总行数可数');
  ok(lt.assertions.total >= lt.assertions.loaded, '总行数不小于已取回数');
  eq(lt.assertions.sql_window_full, lt.assertions.loaded >= 300, 'sql_window_full 与 loaded 一致');
  eq(typeof lt.relations.total, 'number', '关系总行数可数');
  eq(lt.threads.window, 40, '线索 SQL 窗口 = 40');
  eq(typeof lt.threads.open_total, 'number', '开放线索总数可数');
}

console.log('\n=== 断言渲染条数由预算决定（D9）：不再卡在两个魔数上 ===');
{
  // 造一个会话，塞 120 条多值断言（知道/拥有），全落在同一批在场者身上。
  const sid = `s-d9-${Date.now()}`;
  const s9 = store.createSession({
    id: sid, title: 'd9', worldId: world.id, cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  store.setState(sid, 0, {
    place: '雨街', present: ['ling-yue'], characters: { 'ling-yue': {} }, turn_no: 0,
  }, 'main');
  for (let i = 0; i < 120; i += 1) {
    store.addAssertion(sid, {
      branch_id: 'main', subject: '凌玥', predicate: '知道',
      object: `第${i}件事`, valid_from: 1, source_turn: 1, confidence: 1, visibility: 'public',
    });
  }
  const c9 = await engine.assembleContext({
    session: { ...s9, branch_id: 'main', anchor_id: 'prologue' },
    world, turnNo: 2, playerText: '我看着她。',
  });
  const limit9 = c9.meta.facts_many_limit;
  const rendered9 = c9.meta.facts_many_rendered;
  ok(limit9 > 24, '上限不再是 10（也不会被渲染端切回 24）');
  // 真正的回归判据：候选远超旧的两道闸时，渲染数必须跟着上限走，而不是停在 24。
  eq(rendered9, Math.min(120, limit9), '多值渲染数 = min(候选数, 推导上限)');
  ok(c9.meta.facts > 24, '送模事实数超过旧的 24 条硬顶');
  // 渲染端确实没有二次切片：场记单里的事实行数 = 装配层给出的条数。
  const sheet9 = c9.messages
    .find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  const factBlock = sheet9.split('\n\n').find((b) => b.startsWith('已成立的事实')) || '';
  const lines = factBlock.split('\n').filter((l) => l.startsWith('· ')).length;
  eq(lines, c9.meta.facts_many_rendered, '场记单事实行数 = 装配层渲染条数（渲染端没有再 slice）');
}

console.log('\n=== 断言的重复是可量化的（D9-A2 的判据）===');
{
  // 同主同谓的重复率必须能被算出来：这是判断「该不该合并渲染」的唯一依据。
  // selectFacts 自己不去重（它只按相关性排序），所以这里量的是**候选里**的重复形状。
  const many = [];
  for (let i = 0; i < 20; i += 1) {
    many.push({ subject: '伍卿', predicate: '知道', object: `事${i % 5}`, visibility: 'public' });
  }
  const groups = new Map();
  for (const a of many) {
    const k = `${a.subject}|${a.predicate}`;
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  eq(groups.get('伍卿|知道'), 20, '同主同谓可分组计数（报告口径）');
  const dupRate = (many.length - groups.size) / many.length;
  eq(Math.round(dupRate * 100), 95, '重复率 = (条数 − 组数) / 条数');
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
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 10, minCodex: 24, playerText: '我去司楼', card: gCard }) === false, 'auto：小卡不预检辞书');

  /* ---- 历史通道（D4）：点名「人」就跑，与卡大小无关 ---- */
  // 记忆一致性不该依赖卡上有多少辞书条目：小卡一样会忘掉第 3 轮说过的承诺。
  const personCard = schema.normalizeCard({
    title: 'p',
    entities: [
      { id: 'lingyue', type: 'person', name: '凌玥' },
      { id: 'wuwu', type: 'person', name: '伍卿', aliases: ['卿儿'] },
    ],
  });
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 0, minCodex: 24, playerText: '我问凌玥她还记得那件事吗', card: personCard }) === true,
    'auto：点名人物就预检（历史通道不看卡大小）');
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 0, minCodex: 24, playerText: '「卿儿，过来。」', card: personCard }) === true,
    'auto：用别名点名人物也预检');
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 0, minCodex: 24, playerText: '我四处看看', card: personCard }) === false,
    'auto：没点名任何人就不预检');
  ok(shouldPrecheckRetrieval({ mode: 'off', codexCount: 0, minCodex: 24, playerText: '我问凌玥', card: personCard }) === false,
    'off 仍然压过历史通道');
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 30, minCodex: 24, playerText: '我问凌玥司楼在哪', card: personCard }) === true,
    '人和事物同时点名时仍预检');
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 30, minCodex: 24, playerText: '我往前走', card: null }) === true,
    '无卡时退回「够大就预检」的旧行为');

  /* ---- 触发必须看投影后的卡，不是冻结的模板卡 ---- */
  // 运行期 introduce 出来的 NPC 只存在于 world_state 增量里。若拿模板卡建别名索引，
  // 玩家点名「卖炭翁张三」匹配不到任何人 → 历史通道不触发——而「老朋友重逢」正是
  // D4 加 person 通道的原始动机。这条测试锁的是 orchestrator 传哪个 card 进来。
  const { buildEffectiveWorld } = await import('../server/world/effective.js');
  const tplCard = schema.normalizeCard({
    title: 't',
    entities: [{ id: 'lingyue', type: 'person', name: '凌玥' }],
  });
  const effCard = buildEffectiveWorld(tplCard, [{
    entity_kind: 'person', entity_id: 'zhangsan', path: '', op: 'introduce',
    value: { name: '卖炭翁张三', type: 'person' },
    valid_from: 1,
  }], []);
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 0, minCodex: 24, playerText: '我去找卖炭翁张三', card: tplCard }) === false,
    '模板卡看不到 introduce 出来的人（这就是要修的缺口）');
  ok(shouldPrecheckRetrieval({ mode: 'auto', codexCount: 0, minCodex: 24, playerText: '我去找卖炭翁张三', card: effCard }) === true,
    '投影卡能看到 → 历史通道正常触发');
}

console.log('\n=== 资料员两通道解析（D4）===');
{
  const { parseRetrievalRequest } = await import('../server/agents/retrieval.js');
  const both = parseRetrievalRequest('{"codex":["司楼"],"history":["凌玥","玉佩"]}');
  eq(both.codex, ['司楼'], '解析 codex 通道');
  eq(both.history, ['凌玥', '玉佩'], '解析 history 通道');

  // 旧形状（当时只有辞书一条通道）等价于「只查辞书」，不能因为加通道就崩掉。
  const legacy = parseRetrievalRequest('{"queries":["司楼","青楼"]}');
  eq(legacy.codex, ['司楼', '青楼'], '旧 queries 形状当作 codex');
  eq(legacy.history, [], '旧形状不产生 history 查询');

  eq(parseRetrievalRequest('不需要查').history, [], '解析失败返回空 history');
  eq(parseRetrievalRequest('{"codex":[],"history":[]}'), { codex: [], history: [] }, '两个空数组合法');
  // 单字查询词无意义（FTS5 trigram 也要 3 字才走索引），空串/超长同样丢。
  eq(parseRetrievalRequest(`{"history":["玥","","${'很长的句子'.repeat(10)}"]}`).history,
    [], '单字/空/超长（>40 字）查询词被过滤');
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

console.log('\n=== 银钱：数值路径每拍可见，且不与列表路径冲突 ===');
{
  const numCard = schema.normalizeCard({
    title: 'n',
    player: { name: '伍卿', money: 88.4 },
    entities: [{ id: 'ling-yue', type: 'person', name: '凌玥' }],
  });
  const person = numCard.entities.find((e) => e.type === 'person');
  const sheet = sceneSheet.renderSceneSheet({
    ledger: { time: '初冬 · 午后', place: '柴房', present: [person.name] },
    present: [person],
    playerNow: { money: numCard.player.money },
  });
  ok(sheet.text.includes('银钱 88.4'), '银钱随场记单进提示词（模型不必自己记账）');

  const noMoney = sceneSheet.renderSceneSheet({
    ledger: { time: 't', place: 'p' },
    present: [person],
    playerNow: { goal: '活下去' },
  });
  ok(!noMoney.text.includes('银钱'), '没有数值就不渲染这一格（不写 0 占位）');

  // 数值路径必须是标量路径：同一路径不能既在 LIST_PATH_SET 又在 NUMBER_PATH_SET。
  const paths = await import('../server/world/state-paths.js');
  for (const p of paths.NUMBER_PATH_SET) {
    ok(!paths.LIST_PATH_SET.has(p), `数值路径 ${p} 不是列表路径`);
  }
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
        || ctx.meta.coverage.recent_from === ctx.meta.coverage.scene_to + 1 - ctx.meta.coverage.overlap_turns,
      `第 ${turnNo} 轮：场次边界与原文起点首尾相接（有意的重叠已在 overlap_turns 记账，没有洞）`,
    );
    ok(ctx.meta.coverage.overlap_turns <= ctx.meta.coverage.overlap_limit,
      `第 ${turnNo} 轮：重叠不超过配置上限`);
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
  // 场次覆盖 1–6、重叠 2 拍 → 窗口从 5 起：旧正文5/6 作为封场尾巴有意重复，旧正文4 不该出现。
  ok(!all.includes('旧正文4'), '场次记录里更早的回合不再逐字重复（重叠只回看 overlap_turns 拍）');
  ok(all.includes('前六轮的结论'), '被覆盖的剧情仍在场次记录里可寻址');
  eq(ctx.meta.coverage.scene_to, 6, 'meta 记录场次边界');
  eq(ctx.meta.coverage.recent_from, 5, '起点只由场次边界决定：scene_to + 1 − overlap_turns');
  eq(ctx.meta.coverage.overlap_turns, 2, '重叠 2 拍一直陪到本场封场（有界，不是「收敛回去」）');
  eq(ctx.meta.coverage.recent_to, 20, 'meta 记录原文终点');
}

console.log('\n=== 封场尾巴（D1）：刚切场时上一场最后两拍仍逐字可见 ===');
{
  const sid = `s-overlap-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: world.id, title: 'overlap', cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  const ovSession = { ...created, branch_id: 'main', anchor_id: 'prologue' };

  for (let i = 1; i <= 20; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: `旧行动${i}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: i, kind: 'narrator', content: `旧正文${i}`, branch_id: 'main' });
  }
  // 第 1–20 轮全部封成一场：第 21 拍就是「刚切场的第一拍」，原文窗口本来是空的。
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S001', level: 1, turn_from: 1, turn_to: 20,
    place: '雨街', question: '前二十轮在问什么？', outcome: '前二十轮的结论。',
    key_detail: '无纹玉佩', importance: 'major', hooks: ['玉佩为什么发光'],
  });

  const ctx = await engine.assembleContext({
    session: ovSession, world, turnNo: 21, playerText: '我继续往前走。',
  });
  const all = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  // 这是 D1 的全部意义：封场那一刻原文窗口不再是空的，上一拍怎么说话还看得见。
  ok(ctx.meta.coverage.recent_from !== null, '刚切场时原文窗口不为空（D1 的核心收益）');
  eq(ctx.meta.coverage.recent_from, 19, '往回带 2 拍：起点 = scene_to + 1 − 2');
  eq(ctx.meta.coverage.overlap_turns, 2, '重叠拍数记账为 2');
  ok(all.includes('旧正文19') && all.includes('旧正文20'), '上一场最后两拍逐字可见');
  ok(!all.includes('旧正文18'), '只带 2 拍，不整场回灌');
  ok(all.includes('前二十轮的结论'), '场次索引仍然在场（重叠不等于用原文替掉索引）');
  // 重叠永远不会变成洞：起点绝不会晚于 scene_to + 1。
  ok(ctx.meta.coverage.recent_from <= ctx.meta.coverage.scene_to + 1, '窗口起点不晚于场次边界（没有洞）');

  // 关掉重叠开关：行为退回旧口径（窗口为空），证明这个开关真的只有一个作用点。
  const oldOverlap = config.context.recentOverlapTurns;
  config.context.recentOverlapTurns = 0;
  try {
    const none = await engine.assembleContext({
      session: ovSession, world, turnNo: 21, playerText: '我继续往前走。',
    });
    eq(none.meta.coverage.recent_from, null, 'RECENT_OVERLAP_TURNS=0 时退回「封场即清零」');
    eq(none.meta.coverage.overlap_turns, 0, '关闭后无重叠');
  } finally {
    config.context.recentOverlapTurns = oldOverlap;
  }
}

console.log('\n=== 原文窗口只追加、不滑动（D16）：同一场次内 recent_from 必须不动 ===');
{
  // 曾经写成 min(scene_to + 1, turnNo − overlap)：短场时 turnNo − overlap 被选中，
  // 起点每拍往后爬一格，每拍丢掉最旧一条消息 → 缓存前缀每拍作废（报告里 broken 47/51）。
  // 判据：封场之后连续几拍，起点恒等于 scene_to + 1 − overlap，逐字原文只增不减。
  const sid = `s-slide-${Date.now()}`;
  const created = store.createSession({
    id: sid, worldId: world.id, title: 'slide', cardSnapshot: card, worldVersion: 1,
  });
  store.createBranch(sid, { branchId: 'main' });
  store.setSessionAnchor(sid, 'prologue', 'main');
  const slideSession = { ...created, branch_id: 'main', anchor_id: 'prologue' };

  for (let i = 1; i <= 14; i++) {
    store.addTurn(sid, { turn_no: i, kind: 'player', content: `旧行动${i}`, branch_id: 'main' });
    store.addTurn(sid, { turn_no: i, kind: 'narrator', content: `旧正文${i}`, branch_id: 'main' });
  }
  // 1–10 封成一场，之后第 11–14 拍属于当前场（不封场 → 起点必须一直停在 9）。
  store.addScene(sid, {
    branch_id: 'main', scene_id: 'S001', level: 1, turn_from: 1, turn_to: 10,
    place: '雨街', question: '前十轮在问什么？', outcome: '前十轮的结论。',
    key_detail: '无纹玉佩', importance: 'major', hooks: ['玉佩为什么发光'],
  });

  const starts = [];
  const texts = [];
  for (const turnNo of [11, 12, 13, 14, 15]) {
    const one = await engine.assembleContext({
      session: slideSession, world, turnNo, playerText: '我继续往前走。',
    });
    starts.push(one.meta.coverage.recent_from);
    texts.push(one.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
  }
  eq(starts, [9, 9, 9, 9, 9], '五个连续拍点：起点恒为 scene_to + 1 − 2，不随 turnNo 爬');
  // 「只追加」的直接证据：第 12 拍的消息里，第 11 拍那条玩家行动仍在（没被滑掉）。
  ok(texts[1].includes('旧行动11'), '第 12 拍仍看得见第 11 拍的玩家行动（窗口没有滑走最旧一条）');
  ok(texts[4].includes('旧行动9'), '末尾拍仍看得见起点那一拍（起点固定 ⇒ 只追加）');
  ok(!texts[0].includes('旧正文8'), '起点之前的一拍不回顾（重叠上限就是 overlap_turns）');
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

console.log('\n=== 原声：带真实轮次、按角色锚定声线，且不再有回声段（D18） ===');
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
  ok(/第\s*[1-9]\d*轮/.test(sheet), '原声带真实轮次（回声段删除后唯一的出处）');
  ok(!sheet.includes('第0轮'), '不再出现「第0轮」的假出处');
  // D18：回声段是「原声：」的逐字复制品（76 拍 278/278 条 100% 重复），已删。
  // 留一条「删干净的证据」：段头与括号出处都不该再出现。
  ok(!sheet.includes('回声（过去的原话'), '回声段已删除（D18）');
  ok(!ctx.echoes, '装配结果不再带 echoes 字段（D18）');
  ok(!ctx.meta.scene_sheet.echoes && !ctx.meta.scene_sheet.echoes_rendered, '场景层不再产出回声计数（D18）');
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

  // D14：玩家角色是「镜头本身」，不因 life_state 被移出在场。
  // 长跑实测：史官某一拍给 player/player 写了 gone，投影后 card.player.life_state 永久停在
  // gone（没有消费方会清它），场记单每拍在末尾印「已故／离场：主角」，而正文仍是第一人称。
  const playerGone = lintState({
    ledger: { characters: { 伍卿: { life_state: 'gone' } } },
    present: [
      { id: '伍卿', name: '伍卿', life_state: 'gone', is_player: true, knowledge: {} },
      { id: 'li-po', name: '黎婆', life_state: 'gone', knowledge: {} },
    ],
    assertions: [], scenes: [], turnNo: 6, playerName: '伍卿', playerId: '伍卿',
  });
  eq(playerGone.present.map((c) => c.name), ['伍卿'], '玩家不因 life_state=gone 被踢出在场（D14）');
  ok(playerGone.fixes.some((f) => f.kind === 'remove_gone_from_present' && f.who === '黎婆'),
    '非玩家照旧被踢出（豁免只给主角）');
  // 只靠名字也能认出玩家（原创主角造的最小条目不一定带 is_player）
  const byName = lintState({
    ledger: {}, present: [{ id: '伍卿', name: '伍卿', life_state: 'gone', knowledge: {} }],
    assertions: [], scenes: [], turnNo: 1, playerName: '伍卿',
  });
  eq(byName.present.map((c) => c.name), ['伍卿'], '按 playerName 也能认出主角');
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
    const seam = soft.meta.coverage.recent_from == null
      ? null
      : soft.meta.coverage.recent_from + soft.meta.coverage.overlap_turns;
    eq(soft.meta.coverage.scene_to + 1, seam ?? soft.meta.coverage.scene_to + 1,
      '软降级后场次覆盖与原文窗口仍无缝（重叠已记账）');
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
  ok(ctx.meta.retrieval?.rendered === true, 'meta.retrieval.rendered 标记本次真的出了检索文本');
  ok(ctx.messages[ctx.messages.length - 1].role === 'user', '本轮输入仍在最后');
  ok(!all.includes('关键词触发'), '检索不是关键词触发文案');
}

console.log('\n=== 检索结果：跑过但没查到也要留痕（D4 可观测） ===');
{
  // 资料员被调用了、但模型判断不需要查（或查了没命中）：这一拍没有【检索结果】消息，
  // 但 meta.retrieval 必须存在且 rendered=false。否则报告里「没调用」和「调用了没查」
  // 长得一模一样，history_queries 的比例就失去了分母。
  const ctx = await engine.assembleContext({
    session: S, world, turnNo: 5, playerText: '我站在原地想事情。',
    retrieval: {
      text: '', rendered: false, queries: [], entries: [],
      codex_queries: [], history_queries: ['玉佩'], history_hits: [],
      tokens: { codex: 0, history: 0 },
    },
  });
  const all = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  ok(!all.includes('【检索结果】'), '空检索不产生检索消息');
  eq(ctx.budget.retrieval, 0, '空检索不占 retrieval 预算');
  ok(!!ctx.meta.retrieval, 'meta.retrieval 仍然存在（跑过就记）');
  eq(ctx.meta.retrieval?.rendered, false, 'rendered=false 表示没出文本');
  eq(ctx.meta.retrieval?.history_queries, ['玉佩'], 'meta 记录历史查询词');
  eq(ctx.meta.retrieval?.history_hits, [], 'meta 记录历史命中为空');
}

console.log('\n=== 检索预检：解析与约束 ===');{
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

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 世界呼吸：幕外流言进场记单（hidden 永不外泄） ===');
{
  const rumorCard = schema.normalizeCard({
    title: '流言测试',
    premise: '一座旧城，消息比雨下得快。',
    entities: [
      { id: 'wu-qing', type: 'person', name: '伍卿', weight: 1 },
      { id: 'xie-mu', type: 'person', name: '谢沐', weight: 0.9 },
      { id: 'ling-xuan', type: 'person', name: '凌璇', weight: 0.9 },
      { id: 'chalou', type: 'place', name: '茶楼' },
    ],
    anchors: [{
      id: 'prologue', label: '序章',
      snapshot: { time: '初冬 · 黄昏', place: '茶楼', weather: '冷雨', tension: 0.3, characters: {} },
      opening_seed: '雨停了。',
    }],
    player: { mode: 'original', name: '伍卿' },
  });
  const rumorWorld = { id: `w-rumor-${Date.now()}`, title: rumorCard.title, card: rumorCard };
  store.saveWorld(rumorWorld);
  const rumorSession = store.createSession({ id: `s-rumor-${Date.now()}`, title: 'r', worldId: rumorWorld.id });
  store.createBranch(rumorSession.id, { branchId: 'main' });
  store.setSessionAnchor(rumorSession.id, 'prologue', 'main');
  const RS = { ...rumorSession, branch_id: 'main', anchor_id: 'prologue' };

  store.addPatch(rumorSession.id, {
    branch_id: 'main', agent: 'world-tick', kind: 'offstage_event', turn_no: 1, status: 'open',
    severity: 'minor',
    payload: { who: '谢沐', what: '在茶楼窗边朝这边看了很久', visibility: 'rumor' },
    evidence: '测试：幕外流言',
  });
  store.addPatch(rumorSession.id, {
    branch_id: 'main', agent: 'world-tick', kind: 'offstage_event', turn_no: 1, status: 'open',
    severity: 'info',
    payload: { who: '凌璇', what: '在祠堂烧掉一封信', visibility: 'hidden' },
    evidence: '测试：幕后秘密',
  });

  const rctx = await engine.assembleContext({ session: RS, world: rumorWorld, turnNo: 2 });
  const sheet = rctx.messages
    .find((m) => typeof m.content === 'string' && m.content.startsWith('【场记单】'))?.content || '';
  ok(sheet.includes('幕外：谢沐'), 'rumor 事件进入压力段');
  ok(!sheet.includes('凌璇'), 'hidden 事件不进提示词');
  ok(rctx.meta.scene_sheet.rumors === 1, 'meta 记录渲染的流言条数');
}

console.log('\n=== 工艺层：三个轴 / 预算降级 / 优先级 ===');
{
  const craftMod = await import('../server/world/craft.js');

  // 轴取值：非法值一律回退默认，不静默生效。
  const bad = craftMod.resolveCraft({ craft_preset: 'nope', craft_dialogue: 'nope', pacing: 'nope' });
  eq(bad.preset, craftMod.DEFAULT_CRAFT.preset, 'craft：非法 preset 回退默认');
  eq(bad.dialogue, craftMod.DEFAULT_CRAFT.dialogue, 'craft：非法 dialogue 回退默认');
  eq(bad.pacing, craftMod.DEFAULT_CRAFT.pacing, 'craft：非法 pacing 回退默认');

  // 底线常驻、与 preset 无关：任何预设都有 floor 与 time。
  for (const p of craftMod.CRAFT_AXES.preset) {
    const c = craftMod.resolveCraft({ craft_preset: p });
    const b = craftMod.renderCraftBlock(c);
    ok(b.text.includes('只给证据，不写判决'), `craft/${p}：通用底线常驻`);
    ok(b.text.includes('文字长不等于时间过去了很久'), `craft/${p}：时间流速常驻`);
    eq(b.meta.preset, p, `craft/${p}：meta 记录预设`);
  }
  // 不同文风产出不同文本（否则「可单选的轴」是假的）。
  const lightText = craftMod.renderCraftBlock(craftMod.resolveCraft({ craft_preset: 'light' })).text;
  const plainText = craftMod.renderCraftBlock(craftMod.resolveCraft({ craft_preset: 'plain' })).text;
  ok(lightText !== plainText, 'craft：不同文风产出不同文本');
  ok(!lightText.includes('几乎不用形容词与比喻'), 'craft：light 不串入 plain 的规则');

  // 预算降级：底线硬保留，其余按 time → style → dialogue 的优先级整条丢，绝不留半句。
  const c3 = craftMod.resolveCraft({ craft_preset: 'literary', craft_dialogue: 'separated' });
  const tight = craftMod.renderCraftBlock(c3, { capTokens: 400 });
  ok(tight.meta.dropped.includes('style'), 'craft：预算不足时先丢文风');
  ok(tight.meta.dropped.includes('dialogue'), 'craft：预算不足时丢对白形态');
  ok(!tight.text.includes('【文风取向'), 'craft：被丢的段不出现半句');
  ok(tight.text.includes('只给证据，不写判决'), 'craft：底线是硬保留，永不被丢');
  ok(tight.meta.capped === true, 'craft：meta 标记 capped');
  // 连底线都放不下的极端上限：仍保留底线，但 meta 暴露 over_floor（不静默降级成没有底线）。
  const extreme = craftMod.renderCraftBlock(c3, { capTokens: 50 });
  ok(extreme.text.includes('只给证据，不写判决'), 'craft：极端上限下底线仍在');
  ok(extreme.meta.over_floor === true, 'craft：极端上限记 over_floor');
  const roomy = craftMod.renderCraftBlock(c3, { capTokens: 1800 });
  ok(roomy.meta.dropped.length === 0 && roomy.meta.capped === false, 'craft：预算充足不丢弃');

  // 作者写了文风 → 预设文风不渲染（优先级：卡 > 预设 > 默认）。
  const styleCard = schema.normalizeCard({
    title: '文风优先级', premise: '一座旧城。', anchors: [],
    prompt: { style_guide: '作者钦定的文风：通篇用第二人称短句。' },
    entities: [{ id: 'a-he', type: 'person', name: '阿禾', role: '守夜人' }],
    player: { mode: 'original', name: '旅人' },
  });
  const contract = engine.buildContract(
    { settings: { craft_preset: 'literary' } }, { card: styleCard }, styleCard,
  );
  ok(contract.includes('作者钦定的文风'), 'buildContract：作者文风进契约');
  ok(!contract.includes('【文风取向'), 'buildContract：作者文风存在时不渲染预设文风');
  ok(contract.includes('只给证据，不写判决'), 'buildContract：通用底线与作者文风并存');
  // 旧契约里被工艺层接管的规则不应再重复出现（替换而不是叠加）。
  ok(!contract.includes('收束：可以停在需要立刻回应'), 'buildContract：旧收束条已移交给工艺层');
  ok(!contract.includes('不得替主角做决定'), 'buildContract：旧「不替主角决定」条已移交');

  // 推进尺度：尾注与走向共读同一个值。
  const steady = craftMod.resolveCraft({ pacing: 'steady' });
  ok(steady.pacingText.includes('只推进一小步'), 'craft：steady 尾注文本');
  ok(steady.pacingBranch.includes('保守'), 'craft：steady 走向文本');
  const bold = craftMod.resolveCraft({ pacing: 'bold' });
  ok(bold.pacingText.includes('让意外发生'), 'craft：bold 尾注文本');
  ok(bold.pacingBranch.includes('激进'), 'craft：bold 走向文本');

  // 尾注：推进尺度与结尾落点都在最贴近生成点的位置。
  const tail = narratorTailInstruction(schema.normalizeCard({}), { craft: bold });
  ok(tail.includes('【推进尺度·激进】'), '尾注：带推进尺度');
  ok(tail.includes('【怎么收尾】'), '尾注：带结尾落点');
  ok(!narratorTailInstruction(schema.normalizeCard({})).includes('【推进尺度'), '尾注：无 craft 时不出现推进尺度');

  // 会话 settings 真的改变了 system（否则工艺层等于没接上）。
  const craftCard = schema.normalizeCard({
    title: '工艺接线', premise: '一座旧城。', anchors: [],
    prompt: { pov: '第三人称' },
    entities: [{ id: 'a-he', type: 'person', name: '阿禾', role: '守夜人' }],
    player: { mode: 'original', name: '旅人' },
  });
  const cw = { id: `w-craft-${Date.now()}`, title: '工艺', card: craftCard };
  store.saveWorld(cw);
  const cs = store.createSession({
    id: `s-craft-${Date.now()}`, title: 'c', worldId: cw.id,
    settings: { craft_preset: 'plain', pacing: 'bold' },
  });
  store.createBranch(cs.id, { branchId: 'main' });
  const csess = { ...cs, branch_id: 'main' };
  const cctx = await engine.assembleContext({ session: csess, world: cw, turnNo: 1 });
  const csys = cctx.messages[0].content;
  ok(csys.includes('【文风取向·白描·冷硬】'), 'assembly：settings.craft_preset 进 system');
  ok(csys.includes('【推进尺度·激进】') || cctx.messages[cctx.messages.length - 1].content.includes('【推进尺度·激进】'),
    'assembly：settings.pacing 进尾注');
  eq(cctx.craft.preset, 'plain', 'assembly：返回 craft 供走向 Agent 共读');
  eq(cctx.meta.system_blocks.craft.preset, 'plain', 'meta：工艺块落位记录');
  ok(typeof cctx.meta.system_blocks.craft.tokens === 'number', 'meta：工艺块 token 数');

  // system 冻结不变量仍然成立：连续两轮 system 逐字节相等。
  const cctx2 = await engine.assembleContext({ session: csess, world: cw, turnNo: 2 });
  eq(cctx2.messages[0].content, csys, '缓存：工艺块不破坏 system 逐字节冻结');
}

console.log('\n=== 工艺层：取值归一 / 同一真源 / 同卡继承 ===');
{
  // 1) normalizeCraftSettings 是唯一归一入口：非法值回退，fill 与否是两种语义。
  const { normalizeCraftSettings, pickCraftSettings, craftCatalog, DEFAULT_CRAFT } = await import('../server/world/craft.js');
  const bad = normalizeCraftSettings({ craft_preset: 'nope', pacing: 'nope' }, { fill: true });
  eq(bad.craft_preset, DEFAULT_CRAFT.preset, 'normalize：非法 preset 回退默认');
  eq(bad.pacing, DEFAULT_CRAFT.pacing, 'normalize：非法 pacing 回退默认');
  eq(bad.craft_dialogue, DEFAULT_CRAFT.dialogue, 'normalize(fill)：缺省轴补成默认');
  const partial = normalizeCraftSettings({ pacing: 'bold' }, { fill: false });
  ok(!('craft_preset' in partial) && !('craft_dialogue' in partial),
    'normalize(不 fill)：不把未涉及的轴写死（PATCH 只改一个轴时不能顺带覆盖另两个）');
  eq(partial.pacing, 'bold', 'normalize(不 fill)：合法值原样保留');

  // 2) 前端清单来自后端：catalog 与 CRAFT_AXES 必须同源，
  //    否则后端加了取值、前端还显示旧选项，点旧项会被静默回退成默认。
  const catalog = craftCatalog();
  const { CRAFT_AXES } = await import('../server/world/craft.js');
  for (const axis of catalog.axes) {
    eq(catalog.axes.length, Object.keys(CRAFT_AXES).length, 'catalog：轴数量与 CRAFT_AXES 一致');
    eq(axis.options.length, CRAFT_AXES[axis.axis].length, `catalog/${axis.axis}：选项数与 CRAFT_AXES 一致`);
    for (const opt of axis.options) {
      ok(CRAFT_AXES[axis.axis].includes(opt.value), `catalog/${axis.axis}：${opt.value} 在 CRAFT_AXES 里`);
      ok(!!opt.label, `catalog/${axis.axis}：${opt.value} 有标签（前端没有兜底文案）`);
    }
    eq(axis.default, DEFAULT_CRAFT[axis.axis], `catalog/${axis.axis}：默认值与 DEFAULT_CRAFT 一致`);
    ok(axis.options.some((o) => o.value === axis.default), `catalog/${axis.axis}：默认值是合法选项`);
  }

  // 3) 同卡再开一局继承上一局的写法：只搬三个工艺轴。
  const picked = pickCraftSettings({
    craft_preset: 'literary', craft_dialogue: 'long', pacing: 'steady', context_max_tokens: 1234,
  });
  eq(picked.craft_preset, 'literary', 'pick：继承 preset');
  eq(picked.craft_dialogue, 'long', 'pick：继承 dialogue');
  eq(picked.pacing, 'steady', 'pick：继承 pacing');
  ok(!('context_max_tokens' in picked), 'pick：不继承设备参数（预算/温度等留在各自会话）');
  eq(pickCraftSettings({ craft_preset: 'nope' }).craft_preset, DEFAULT_CRAFT.preset,
    'pick：非法值归一，不把脏值搬进新会话');
}

console.log('\n=== 工艺层：卡级默认的优先级 / 取值被删后的回落 ===');
{
  const craft = await import('../server/world/craft.js');
  const { resolveCraft, pickCraftHint, renderCraftBlock } = craft;
  const D = craft.DEFAULT_CRAFT;

  // 优先级：本拍 overrides > 会话 settings > 卡级默认 > 程序默认。
  eq(resolveCraft({}, {}, { craft_preset: 'plain' }).preset, 'plain',
    '卡级默认：会话没设置时用它');
  eq(resolveCraft({ craft_preset: 'literary' }, {}, { craft_preset: 'plain' }).preset, 'literary',
    '会话 settings 压过卡级默认');
  eq(resolveCraft({ craft_preset: 'literary' }, { preset: 'gufeng' }, { craft_preset: 'plain' }).preset, 'gufeng',
    '本拍 overrides 压过会话 settings');
  eq(resolveCraft({}, {}).preset, D.preset, '两者都没有：回程序默认');
  eq(resolveCraft({}, {}, { craft_preset: '不存在的取值' }).preset, D.preset,
    '卡级默认是坏值时回程序默认（不留无效值）');
  eq(resolveCraft({ craft_preset: '不存在的取值' }).preset, D.preset,
    '会话里是坏值时回程序默认');

  // pickCraftHint：只摘非空的三个轴，别名合并。
  eq(pickCraftHint({ preset: 'light', 'craft_dialogue': 'short', pacing: '' }),
    { craft_preset: 'light', craft_dialogue: 'short' }, 'pickCraftHint：别名归一、空值丢弃');
  eq(pickCraftHint(null), {}, 'pickCraftHint：null 安全');

  // 卡级默认要真的进 system 文本：card.craft 设成 plain 时，
  // 渲染出的工艺块里出现 plain 的正文，而不是默认 preset 的正文。
  const plainText = craft.BUILTIN.preset.plain.text;
  const block = renderCraftBlock(resolveCraft({}, {}, { craft_preset: 'plain' })).text;
  ok(block.includes(plainText), '卡级默认（plain）的正文真的渲染进了工艺块');
  // 「default」这个取值的正文是空串（＝不额外指定），所以用另一条有正文的预设做对照。
  ok(!block.includes(craft.BUILTIN.preset.literary.text),
    '卡级默认生效时，没选中的预设正文不出现（不是把所有预设都塞进去）');

  // 世界卡的 style_guide 压过预设文风：此时工艺块里不该出现预设正文。
  const withAuthor = renderCraftBlock(resolveCraft({}, {}, { craft_preset: 'plain' }), { includeStyle: false }).text;
  ok(!withAuthor.includes(plainText), '作者写了文风时，预设文风正文不渲染');
  ok(withAuthor.includes('怎么写'), '但通用底线仍然渲染（它是硬保留）');

  // pacing 的两段正文分别去尾注与走向，不能串台。
  const p = resolveCraft({ pacing: 'bold' });
  eq(p.pacingText, craft.BUILTIN.pacing.bold.tail, 'pacing 尾注正文取 tail');
  eq(p.pacingBranch, craft.BUILTIN.pacing.bold.branch, 'pacing 走向正文取 branch');
  ok(p.pacingText !== p.pacingBranch, 'tail 与 branch 是两段不同的文本（不是同一份复用）');
}

console.log('\n=== meta 落库完整性：装配算出来的键必须都能读到（D24）===');
{
  // `assembleContext` 产出 41 个 meta 键，`buildAssemblyMeta()` 是一道**手写白名单**。
  // 历史上漏过四次（layers_truncated / facts_many_limit / relations_limit，以及 D24 这批
  // 10 个键），每次的症状都一样：装配层算得好好的，报告里读不到，于是「健康」。
  // 这条断言用**运行时对象**而不是扫源码：源码里的键名会出现在注释、字符串、解构里，
  // 只有装配出来的那个对象才是真的。新增 meta 键忘了进白名单，这里就红。
  const { buildAssemblyMeta } = await import('../server/agents/orchestrator.js');
  const { createSession, createBranch, setSessionAnchor, setState } = store;

  const card = schema.normalizeCard({
    premise: '落库完整性', player: { name: '甲', canon_character: 'a' },
    entities: [{ id: 'a', name: '甲', type: 'person' }, { id: 'b', name: '乙', type: 'person' }],
  });
  const worldId = `w-wl-${Date.now()}`;
  store.saveWorld({ id: worldId, title: card.title, card });
  const s = createSession({ id: `s-wl-${Date.now()}`, title: '落库完整性', worldId });
  createBranch(s.id, { branchId: 'main' });
  setSessionAnchor(s.id, 'prologue', 'main');
  setState(s.id, 1, { time: '午后', place: '院中', present: ['a'], characters: { a: {} }, turn_no: 1 }, 'main');

  const ctx = await engine.assembleContext({
    session: { ...s, branch_id: 'main', anchor_id: 'prologue', card_snapshot: card },
    world: { card },
    turnNo: 2,
    playerText: '我看着他。',
  });
  const persisted = buildAssemblyMeta(ctx, { model: 'x' });
  // `system_blocks` 是有意的聚合容器：落库时拆成 index / craft / timeline_past 三个平铺键
  // （`index` 与 `craft` 直接给报告读），所以它本身不进白名单。
  const ALLOWED_CONTAINERS = new Set(['system_blocks']);
  const missing = Object.keys(ctx.meta).filter((k) => !(k in persisted) && !ALLOWED_CONTAINERS.has(k));
  ok(missing.length === 0, '装配 meta 的每个键都进了 buildAssemblyMeta 白名单', missing.join(', '));
  ok('index' in persisted && 'craft' in persisted, 'system_blocks 拆出来的 index / craft 都能读到');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-context: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
