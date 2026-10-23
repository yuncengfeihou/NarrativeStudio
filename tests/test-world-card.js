#!/usr/bin/env node
/**
 * tests/test-world-card.js — 世界卡 v4：schema / 索引 / 辞书挑选 / 场记单（无网络）
 *
 * 覆盖：
 *   - normalizeCard 的归一与默认值
 *   - beta 约定：旧格式字段不被读取（没有隐式迁移）
 *   - 别名索引与实体链接（最长匹配、不重叠计数）
 *   - 世界索引渲染与降级
 *   - 辞书挑选：实体连接 / 主题标签 / 钉选
 *   - 场记单渲染：字段、优先级、配额裁剪
 */
import './load-env.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = path.join(os.tmpdir(), `narra-card-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const schema = await import('../server/world/schema.js');
const sheet = await import('../server/world/scene-sheet.js');

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
console.log('\n=== normalizeCard ===');
{
  const card = schema.normalizeCard({
    title: '女尊世界',
    premise: '一个被丢掉的人被重新捡起来',
    charter: ['女子主外', { rule: '枪与凤椅共存' }],
    cast: [{ name: '凌玥', aliases: ['玥姐姐'], voice: { rhythm: '短句' }, agenda: [{ goal: '带走他', pressure: 2 }] }],
    codex: [{ name: '司楼', type: 'institution', tags: ['制度'] }],
    timeline: [{ what: '母亲丢下他', canon: 'past' }],
    anchors: [{ label: '序章', snapshot: { place: '雨街' }, opening_seed: '雨落下来' }],
    player: { name: '伍卿' },
  });
  ok(card.version === 4, 'version 归一为 4');
  ok(card.kind === 'original', '默认 original');
  eq(card.charter.length, 2, '宪章兼容字符串与对象两种写法');
  eq(card.charter[1], { rule: '枪与凤椅共存', kind: 'law' }, '宪章补 kind 默认值');
  eq(card.cast[0].agenda[0].pressure, 1, 'agenda.pressure 被 clamp 到 0-1');
  eq(card.cast[0].id, '凌玥', 'cast id 默认取名字 slug');
  ok(Array.isArray(card.cast[0].voice.exemplars), 'voice.exemplars 有默认值');
  eq(card.timeline[0].canon, 'past', 'timeline canon 保留');
  ok(card.anchors.length === 1, 'anchor 归一');
  ok(card.player.mode === 'original', '玩家未匹配卡司时是 original');
}

{
  const card = schema.normalizeCard({
    title: 'x', source: { title: '某小说' },
    cast: [{ name: '伍卿' }],
    player: { name: '伍卿', mode: 'canon' },
  });
  ok(card.kind === 'adapted', '有 source.title 时是 adapted');
  eq(card.player.mode, 'canon', '玩家名字命中卡司时是 canon');
  ok(card.player.canon_character === '伍卿', 'canon_character 解析成 cast id');
}

{
  const card = schema.normalizeCard({ title: '空卡' });
  eq(card.prompt.pov, '第三人称限知，镜头贴在主角身上', 'prompt 有默认值');
  eq(card.charter, [], '空宪章');
  eq(card.anchors, [], '无锚点');
  ok(card.player.name === '主角', '玩家名有兜底');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== beta：旧格式字段不被读取 ===');
{
  // beta 阶段不做隐式迁移。旧字段传进来只会被忽略，不会变成 v4 数据。
  const card = schema.normalizeCard({
    title: '旧卡',
    style: { pov: '第三人称', voice: '短句' },
    bans: ['不写元叙述'],
    opening_seed: '雨落下来',
    opening_state: { place: '雨街' },
    lore: [{ title: '司楼', content: '官营青楼', category: 'institution' }],
    arcs: [{ title: '第一幕', goal: '目标', beats: ['节拍'] }],
    cast: [{ name: '凌玥', alias: ['玥姐姐'], secret: '七年前', always: true }],
  });
  eq(card.prompt.pov, '第三人称限知，镜头贴在主角身上', '不读取旧 style.pov');
  eq(card.prompt.style_guide, '', '不读取旧 style.voice');
  eq(card.prompt.bans, [], '不读取旧顶层 bans');
  eq(card.codex, [], '不读取旧 lore');
  eq(card.timeline, [], '不读取旧 arcs');
  eq(card.anchors, [], '不读取旧 opening_state / opening_seed');
  eq(card.cast[0].aliases, [], '不读取旧 cast.alias');
  eq(card.cast[0].psyche.hides, [], '不读取旧 cast.secret');
  eq(card.cast[0].always_present, false, '不读取旧 cast.always');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 别名索引与实体链接 ===');
{
  const card = schema.normalizeCard({
    title: 't',
    cast: [{ name: '凌玥', aliases: ['玥姐姐', '姐姐'] }, { name: '伍卿' }],
    codex: [{ name: '司楼', aliases: ['青楼'] }],
  });
  const idx = schema.buildAliasIndex(card);
  eq(idx[0].alias, '玥姐姐', '长别名排在前面');

  const l1 = schema.linkEntities('玥姐姐站在青楼门口', idx);
  ok(l1.cast.includes('凌玥'), '命中别名「玥姐姐」→ 凌玥');
  ok(l1.codex.includes('司楼'), '命中别名「青楼」→ 司楼');

  const l2 = schema.linkEntities('姐姐来了', idx);
  eq(l2.cast, ['凌玥'], '短别名「姐姐」单独出现也能命中');

  const l3 = schema.linkEntities('凌乱的风', idx);
  eq(l3.cast, [], '「凌」不是别名，不误命中');

  const l4 = schema.linkEntities('凌玥和玥姐姐', idx);
  eq(l4.cast, ['凌玥'], '同一实体的多个别名只计一次');

  const l5 = schema.linkEntities('', idx);
  eq(l5.cast, [], '空文本返回空');
  eq(schema.resolveWho('玥姐姐', idx), '凌玥', 'resolveWho 归一别名');
  eq(schema.resolveWho('张三是谁', idx), '张三是谁', '未知名原样返回');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 世界索引 ===');
{
  const card = schema.normalizeCard({
    title: 't',
    cast: [
      { name: '凌玥', role: '凌家家主', weight: 1 },
      { name: '张兰', role: '保安', weight: 0.3 },
      { name: '龙套甲' },
    ],
    codex: [
      { name: '司楼', type: 'institution', summary: '官营青楼' },
      { name: '玉佩', type: 'item', summary: '来路不明' },
      { name: '女尊', type: 'concept', summary: '女子为尊' },
    ],
  });
  const index = sheet.renderWorldIndex(card, 1200);
  ok(index.includes('【世界索引】'), '有索引头');
  ok(index.includes('凌玥（凌家家主）'), '人物带 role 摘要');
  ok(index.includes('机构　司楼（官营青楼）'), '按类型分组');
  ok(index.includes('物件　玉佩（来路不明）'), '物品分组');
  ok(!index.includes('priority'), '不含任何触发机制字样');

  // 极小配额 → 降级为只留名字
  const tiny = sheet.renderWorldIndex(card, 60);
  ok(tiny.includes('凌玥'), '超配额时仍保留人物名');
  ok(!tiny.includes('官营青楼'), '超配额时丢掉摘要');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 辞书挑选（无关键词）===');
{
  const card = schema.normalizeCard({
    title: 't',
    cast: [{ id: 'ling-yue', name: '凌玥' }],
    codex: [
      { id: 'silou', name: '司楼', type: 'institution', tags: ['制度', '交易'], links: ['cast:ling-yue'] },
      { id: 'jiajie', name: '称呼礼法', type: 'concept', tags: ['制度'], pinned: true },
      { id: 'wujia', name: '无关之物', type: 'item', tags: ['杂物'] },
      { id: 'mai', name: '买卖规矩', type: 'concept', tags: ['交易'] },
    ],
  });

  const a = sheet.selectCodex(card, { presentIds: ['cast:ling-yue'], threadTags: [] });
  const names = a.map((x) => x.entry.name);
  ok(names.includes('司楼'), '实体连接命中');
  ok(names.includes('称呼礼法'), '钉选项无条件进候选');
  ok(!names.includes('无关之物'), '无连接无主题的条目不进候选');

  const b = sheet.selectCodex(card, { presentIds: [], threadTags: ['交易'] });
  ok(b.some((x) => x.entry.name === '买卖规矩'), '主题标签命中');
  ok(b.some((x) => x.why.includes('本场主题')), '标注命中原因');

  const c = sheet.selectCodex(card, { presentIds: [], threadTags: [] });
  ok(c.every((x) => x.entry.pinned), '无连接无主题时只剩钉选项');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 场记单 ===');
{
  const card = schema.normalizeCard({
    title: 't',
    cast: [{
      id: 'ling-yue', name: '凌玥', role: '凌家家主',
      voice: { rhythm: '短句，笑着说的狠话' },
      psyche: { wants: ['带走他'], hides: ['七年前'] },
      knowledge: { knows: ['七年前的真相'], does_not_know: ['他见过南荣兰冰'] },
      agenda: [{ goal: '今天必须把他带走', method: '不能用施舍的方式', pressure: 0.9 }],
    }],
  });

  const out = sheet.renderSceneSheet({
    ledger: { time: '初冬 · 黄昏', place: '商务大厦门口', weather: '冷雨', tension: 0.7, characters: { 'ling-yue': { mood: '克制', location: '台阶上' } } },
    present: card.cast,
    relations: [{ from_name: '凌玥', to_name: '伍卿', kind: '旧识·执念', sentiment: 0.8, note: '未说破' }],
    threads: [{ title: '七年前的雨夜', status: 'open', weight: 0.9, note: '凌玥知情' }],
    codex: [{ entry: { name: '司楼', summary: '官营青楼', reveal: 'public', facets: { rules: ['入内即除籍'] } }, why: ['实体在场'] }],
    voices: { 'ling-yue': ['「卿儿，过来。」'] },
    echoes: [],
    directive: '这一场不要让她解释七年前',
    capTokens: 2400,
  });

  ok(out.text.includes('【场记单】'), '有场记单头');
  ok(out.text.includes('时间 初冬 · 黄昏｜地点 商务大厦门口'), '时空行');
  ok(out.text.includes('在场'), '在场段');
  ok(out.text.includes('私心：今天必须把他带走——不能用施舍的方式'), '私心段（动机，不是节拍）');
  ok(out.text.includes('边界：'), '知识边界段');
  ok(out.text.includes('原声：「卿儿，过来。」'), '原声回声');
  ok(out.text.includes('未回收的线索'), '线索段');
  ok(out.text.includes('关系'), '关系段');
  ok(out.text.includes('压力'), '压力段');
  ok(out.text.includes('本场指令（作者钦定，优先级最高）'), '本场指令段');
  ok(out.text.includes('本场可用设定'), '设定段');
  ok(!out.text.includes('必达节拍'), '没有节拍这种东西');
  ok(!out.text.includes('这一幕不要做'), '没有忌避清单');
  ok(!out.text.includes('第 1/2 幕'), '没有幕进度');

  // 空状态
  const empty = sheet.renderSceneSheet({ present: [], capTokens: 1000 });
  eq(empty.text, '', '无在场者时返回空');

  // 极小配额：保留必要段，砍掉可选段
  const tiny = sheet.renderSceneSheet({
    ledger: { place: '雨街' },
    present: card.cast,
    relations: [{ from_name: '凌玥', to_name: '伍卿', kind: 'x', sentiment: 0 }],
    threads: [{ title: '线索一', status: 'open' }],
    codex: [{ entry: { name: '司楼', summary: '很长很长的设定内容'.repeat(50), facets: {} }, why: [] }],
    capTokens: 260,
  });
  ok(tiny.text.includes('在场'), '小配额保留在场');
  ok(estimate(tiny.text) <= 320, `小配额受控（${estimate(tiny.text)} tok）`);
}

function estimate(s) {
  // 与 server/tokens.js 同口径的粗估：CJK 1 字 ≈ 1 token
  return Math.ceil(String(s).length * 0.6);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== renderCardText（导出）===');
{
  const card = schema.normalizeCard({
    title: '女尊世界', subtitle: '捡破烂',
    premise: '被丢掉的人被重新捡起来',
    charter: ['女子主外'],
    cast: [{ name: '凌玥', role: '家主', voice: { rhythm: '短句' }, psyche: { wants: ['带走他'] }, agenda: [{ goal: '今天带走他' }] }],
    codex: [{ name: '司楼', summary: '官营青楼', facets: { rules: ['入内即除籍'] } }],
    timeline: [{ what: '母亲丢下他', canon: 'past' }, { what: '黎婆确诊', canon: 'future' }],
    anchors: [{ label: '序章' }],
  });
  const text = schema.renderCardText(card);
  ok(text.includes('# 女尊世界 · 捡破烂'), '标题');
  ok(text.includes('## 命题'), '命题段');
  ok(text.includes('## 卡司'), '卡司段');
  ok(text.includes('私心：'), '导出演私心');
  ok(text.includes('## 辞书'), '辞书段');
  ok(text.includes('[past] 母亲丢下他'), '时间线标 canon');
  ok(text.includes('[future] 黎婆确诊'), 'future 也标出来（给人看，不给模型）');
  ok(text.includes('## 可玩时间点'), '可玩时间点段');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-world-card: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
