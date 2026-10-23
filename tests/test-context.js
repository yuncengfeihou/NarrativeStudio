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

console.log('\n=== 体积不随轮数增长 ===');
{
  const sizes = [];
  for (const turnNo of [1, 50, 200, 500]) {
    const ctx = await engine.assembleContext({
      session: S, world, turnNo, playerText: '我继续往前走。',
    });
    sizes.push({ turnNo, total: ctx.budget.total, scene: ctx.budget.scene, system: ctx.budget.system });
  }
  for (const s of sizes) {
    console.log(`  第 ${String(s.turnNo).padStart(3)} 轮  合计 ${s.total}  tok（系统 ${s.system}｜场记单 ${s.scene}）`);
  }
  const first = sizes[0].total;
  const last = sizes[sizes.length - 1].total;
  ok(last < first * 2.2, `500 轮与第 1 轮同量级（${first} → ${last}）`);
  ok(sizes.every((s) => s.system < 4200), '系统层受配额约束');
  ok(sizes.every((s) => s.scene < 3000), '场记单受配额约束');
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

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-context: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
