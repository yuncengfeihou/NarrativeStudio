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
const graphLib = await import('../server/world/graph.js');
const lintLib = await import('../server/world/lint.js');

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
      { name: '凌玥', role: '凌家家主', status: '左肩中箭', weight: 1 },
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
  ok(!index.includes('左肩中箭'), '索引只承载 canon，不渲染运行态 status');
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

  // 「当前地点」只认账本 place_id，不把所有被提及的地点都标成当前地点。
  const places = schema.normalizeCard({
    title: 'p',
    codex: [
      { id: 'ling-fu', name: '凌府', type: 'place' },
      { id: 'silou', name: '司楼', type: 'place' },
    ],
  });
  const d = sheet.selectCodex(places, {
    presentIds: ['ling-fu', 'silou'], currentPlaceId: 'ling-fu',
  });
  const lf = d.find((x) => x.entry.id === 'ling-fu');
  const sl = d.find((x) => x.entry.id === 'silou');
  eq(lf.score, 80, '当前地点 +20');
  ok(lf.why.includes('当前地点'), '只给当前地点标注');
  ok(!sl.why.includes('当前地点'), '被提及但不是当前地点不加分');

  // muted：作者显式静音 → 不进世界索引/场记候选（钉选也不豁免），但仍留在卡里可被检索。
  const mutedCard = schema.normalizeCard({
    title: 'm',
    cast: [{ id: 'ling-yue', name: '凌玥' }],
    codex: [
      { id: 'silou', name: '司楼', type: 'institution', tags: ['制度'], links: ['cast:ling-yue'], muted: true },
      { id: 'yupei', name: '玉佩', type: 'item', tags: ['杂物'] },
    ],
  });
  eq(mutedCard.codex.find((e) => e.id === 'silou').muted, true, 'muted 归一为布尔');
  const mutedSel = sheet.selectCodex(mutedCard, { presentIds: ['cast:ling-yue'], threadTags: ['制度'] });
  ok(!mutedSel.some((x) => x.entry.id === 'silou'), '静音条目不进自动进场候选');
  ok(!sheet.renderWorldIndex(mutedCard, 1200).includes('司楼'), '静音条目不进世界索引');
  ok(!sheet.renderWorldTree(mutedCard, 1200).includes('司楼'), '静音条目不进树形索引');
  ok(mutedCard.codex.find((e) => e.id === 'yupei').muted === false, '未静音条目保持 false');
  const mutedPinned = schema.normalizeCard({
    title: 'mp',
    codex: [{ id: 'p', name: '钉选静音', type: 'concept', pinned: true, muted: true }],
  });
  eq(sheet.selectCodex(mutedPinned, {}).length, 0, '静音优先于钉选，不无条件进场');
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
console.log('\n=== 辞书图谱：去重 / 关系 / 包含 ===');
{
  const card = schema.normalizeCard({
    title: '图',
    cast: [
      { id: 'ling-yue', name: '凌玥', aliases: ['玥姐姐'], relations: [{ to: 'wu-qing', kind: '旧识', sentiment: 0.8 }] },
      { id: 'wu-qing', name: '伍卿' },
      { id: 'zhang-lan', name: '张兰', role: '保安' },
    ],
    codex: [
      { id: 'ling-fu', name: '凌府', type: 'place', summary: '凌家主宅' },
      { id: 'tianjing', name: '天井', type: 'place', parent_id: 'ling-fu' },
      { id: 'yupei', name: '玉佩', type: 'item', summary: '无纹', links: ['cast:ling-yue'] },
      // 与 cast 同名：应合并为同一实体，索引/场记单不重复
      { id: 'zhang-lan-codex', name: '张兰', type: 'character', summary: '保安' },
    ],
    edges: [{ from: 'wu-qing', to: 'ling-fu', kind: 'located_in' }],
  });
  const g = graphLib.buildWorldGraph(card);

  ok(g.mergedCodexIds.has('zhang-lan-codex'), '同名 cast/codex 标记为合并');
  eq(g.resolve('zhang-lan-codex'), 'zhang-lan', 'codex id 解析到人物节点');
  ok(g.entities.has('ling-fu'), '地点是独立节点');
  ok(g.edges.some((e) => e.from === 'ling-yue' && e.to === 'wu-qing' && e.kind === '旧识'), 'cast.relations → 关系边');
  ok(g.edges.some((e) => (e.from === 'ling-yue' && e.to === 'yupei')
    || (e.from === 'yupei' && e.to === 'ling-yue')), 'codex.links → 关系边（cast: 前缀被剥掉）');
  ok(g.edges.some((e) => e.from === 'tianjing' && e.to === 'ling-fu' && e.kind === 'located_in'), 'parent_id → located_in 边');
  ok(g.edges.some((e) => e.from === 'wu-qing' && e.to === 'ling-fu' && e.kind === 'located_in'), '显式 edges 进入图');

  ok([...graphLib.graphNeighbors(g, ['ling-yue'], { depth: 1 })].includes('yupei'), '1 跳邻域包含玉佩');
  eq(graphLib.graphAncestors(g, 'tianjing'), ['ling-fu'], '包含关系可回溯祖先');

  const tree = sheet.renderWorldTree(card, 1200, { skipIds: g.mergedCodexIds });
  ok(!tree.includes('（当前）'), '树形索引不标注当前地点（运行态归场记单）');
  ok(tree.includes('└ 天井'), '子地点缩进在父地点下');
  eq((tree.match(/张兰/g) || []).length, 1, '同名实体只出现一次');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 卡级 lint ===');
{
  const card = schema.normalizeCard({
    title: 'lint',
    cast: [
      { id: 'wu-qing', name: '伍卿', aliases: ['阿卿'] },
      { id: 'ling-yue', name: '凌玥' },
      { id: 'zhang-lan', name: '张兰' },
    ],
    codex: [
      { id: 'zhang-lan', name: '张兰', type: 'character' },
      { id: 'broken', name: '断链', type: 'item', links: ['不存在'] },
      { id: 'bad-parent', name: '断父', type: 'place', parent_id: '没有这个地方' },
      { id: 'a', name: '环A', type: 'place', parent_id: 'b' },
      { id: 'b', name: '环B', type: 'place', parent_id: 'a' },
      { id: 'collide', name: '别名冲突', type: 'concept', aliases: ['阿卿'] },
    ],
    claims: [
      { subject: '伍卿', predicate: '位于', cardinality: 'one', object: { kind: 'entity', id: 'a' }, validity: { from_turn: 1 } },
      { subject: '伍卿', predicate: '位于', cardinality: 'one', object: { kind: 'entity', id: 'b' }, validity: { from_turn: 2 } },
    ],
  });
  const report = lintLib.lintCard(card);
  const codes = new Set(report.issues.map((i) => i.code));
  ok(codes.has('duplicate_identity'), '报告同名 cast/codex');
  ok(codes.has('alias_collision'), '报告别名冲突');
  ok(codes.has('broken_link'), '报告断链');
  ok(codes.has('broken_parent'), '报告断父');
  ok(codes.has('parent_cycle'), '报告包含环');
  ok(codes.has('claim_conflict'), '报告单值声明冲突');
  ok(report.counts.entities >= 4, '报告实体计数');
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

console.log('\n=== 辞书检索（模型主动取证） ===');
{
  const card = schema.normalizeCard({
    title: '检索测试',
    codex: [
      {
        id: 'silou', type: 'institution', name: '司楼', aliases: ['青楼'],
        summary: '官营青楼', tags: ['制度'], facets: { rules: ['入内即除籍'] },
      },
      {
        id: 'yupei', type: 'item', name: '无纹玉佩', aliases: ['玉佩'],
        summary: '遇暗发绿光', facets: { history: '凌玥所赠' },
      },
      {
        id: 'chenghu', type: 'concept', name: '称呼礼法',
        summary: '称公子是抬举', tags: ['制度'],
      },
    ],
  });

  eq(sheet.lookupCodex(card, '司楼').map((h) => h.entry.name), ['司楼'], '名称精确命中');
  eq(sheet.lookupCodex(card, '青楼').map((h) => h.entry.name), ['司楼'], '别名命中');
  eq(sheet.lookupCodex(card, '绿光').map((h) => h.entry.name), ['无纹玉佩'], '摘要命中');
  eq(
    sheet.lookupCodex(card, '制度').map((h) => h.entry.name).sort(),
    ['司楼', '称呼礼法'].sort(),
    '标签命中',
  );
  eq(sheet.lookupCodex(card, '不存在'), [], '无命中返回空');

  const text = sheet.renderCodexHit(card.codex[0]);
  ok(text.includes('入内即除籍'), '检索结果渲染规则');
  ok(text.includes('官营青楼'), '检索结果渲染摘要');

  const duplicated = sheet.renderCodexHit({
    name: '玉佩', summary: '无纹玉佩',
    facets: { history: '完整来历' }, detail: '完整来历',
  });
  eq((duplicated.match(/完整来历/g) || []).length, 1, 'summary/history/detail 重复文本只渲染一次');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-world-card: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
