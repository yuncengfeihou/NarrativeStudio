#!/usr/bin/env node
/**
 * tests/test-world-card.js — 世界卡 v5：schema / 索引 / 辞书挑选 / 场记单（无网络）
 *
 * v5 起人物与事实统一在 card.entities（type 区分 person / 其余类型），
 * 没有 cast / codex 双数组，也没有 type='character' 的辞书条目。
 *
 * 覆盖：
 *   - normalizeCard 的归一与默认值
 *   - beta 约定：旧格式字段（含 v4 的 cast / codex）不被读取（没有隐式迁移）
 *   - 别名索引与实体链接（最长匹配、不重叠计数）
 *   - 世界索引渲染与降级
 *   - 辞书挑选：实体连接 / 主题标签 / 钉选
 *   - 场记单渲染：字段、优先级、配额裁剪
 *   - 图谱 / 卡级 lint / 导出 / 检索 / 制卡
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
const smithLib = await import('../server/agents/card-smith.js');

let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/** v5：人物 / 事实都是 entities 里的条目，只按 type 分流。 */
const personsOf = (card) => card.entities.filter((e) => e.type === 'person');
const factsOf = (card) => card.entities.filter((e) => e.type !== 'person');

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== normalizeCard ===');
{
  const card = schema.normalizeCard({
    title: '女尊世界',
    premise: '一个被丢掉的人被重新捡起来',
    charter: ['女子主外', { rule: '枪与凤椅共存' }],
    entities: [
      { type: 'person', name: '凌玥', aliases: ['玥姐姐'], voice: { rhythm: '短句' }, agenda: [{ goal: '带走他', pressure: 2 }] },
      { type: 'institution', name: '司楼', tags: ['制度'] },
    ],
    timeline: [{ what: '母亲丢下他', canon: 'past' }],
    anchors: [{ label: '序章', snapshot: { place: '雨街' }, opening_seed: '雨落下来' }],
    player: { name: '伍卿' },
  });
  ok(card.version === 5, 'version 归一为 5');
  ok(card.kind === 'original', '默认 original');
  eq(card.charter.length, 2, '宪章兼容字符串与对象两种写法');
  eq(card.charter[1], { rule: '枪与凤椅共存', kind: 'law' }, '宪章补 kind 默认值');
  eq(personsOf(card)[0].agenda[0].pressure, 1, 'agenda.pressure 被 clamp 到 0-1');
  eq(personsOf(card)[0].id, '凌玥', 'person id 默认取名字 slug');
  ok(Array.isArray(personsOf(card)[0].voice.exemplars), 'voice.exemplars 有默认值');
  eq(card.timeline[0].canon, 'past', 'timeline canon 保留');
  ok(card.anchors.length === 1, 'anchor 归一');
  ok(card.player.mode === 'original', '玩家未匹配人物时是 original');
  eq(card.entities.length, 2, '人物与事实都收在 entities 里');
}

{
  const card = schema.normalizeCard({
    title: 'x', source: { title: '某小说' },
    entities: [{ type: 'person', name: '伍卿' }],
    player: { name: '伍卿', mode: 'canon' },
  });
  ok(card.kind === 'adapted', '有 source.title 时是 adapted');
  eq(card.player.mode, 'canon', '玩家名字命中人物时是 canon');
  ok(card.player.canon_character === '伍卿', 'canon_character 解析成人物 id');
}

{
  const card = schema.normalizeCard({ title: '空卡' });
  eq(card.prompt.pov, '第三人称限知，镜头贴在主角身上', 'prompt 有默认值');
  eq(card.charter, [], '空宪章');
  eq(card.anchors, [], '无锚点');
  eq(card.entities, [], '空卡没有实体');
  ok(card.player.name === '主角', '玩家名有兜底');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== beta：旧格式字段不被读取 ===');
{
  // beta 阶段不做隐式迁移。旧字段传进来只会被忽略，不会变成 v5 数据；
  // 包括 v4 的 cast / codex 双数组：v5 只读 entities。
  const card = schema.normalizeCard({
    title: '旧卡',
    style: { pov: '第三人称', voice: '短句' },
    bans: ['不写元叙述'],
    opening_seed: '雨落下来',
    opening_state: { place: '雨街' },
    lore: [{ title: '司楼', content: '官营青楼', category: 'institution' }],
    arcs: [{ title: '第一幕', goal: '目标', beats: ['节拍'] }],
    cast: [{ name: '凌玥', alias: ['玥姐姐'], secret: '七年前', always: true }],
    codex: [{ name: '司楼', type: 'institution', summary: '官营青楼' }],
  });
  eq(card.prompt.pov, '第三人称限知，镜头贴在主角身上', '不读取旧 style.pov');
  eq(card.prompt.style_guide, '', '不读取旧 style.voice');
  eq(card.prompt.bans, [], '不读取旧顶层 bans');
  eq(card.entities, [], '不读取旧 cast / codex / lore');
  ok(!('cast' in card) && !('codex' in card), '输出不含 v4 的 cast / codex 字段');
  eq(card.timeline, [], '不读取旧 arcs');
  eq(card.anchors, [], '不读取旧 opening_state / opening_seed');
  ok(card.version === 5, '旧卡输出也标 v5 形状');
  ok(!JSON.stringify(card).includes('七年前'), '不读取旧 cast.secret');
  ok(!JSON.stringify(card).includes('第一幕'), '不读取旧 arcs 内容');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 别名索引与实体链接 ===');
{
  const card = schema.normalizeCard({
    title: 't',
    entities: [
      { type: 'person', name: '凌玥', aliases: ['玥姐姐', '姐姐'] },
      { type: 'person', name: '伍卿' },
      { type: 'institution', name: '司楼', aliases: ['青楼'] },
    ],
  });
  const idx = schema.buildAliasIndex(card);
  eq(idx[0].alias, '玥姐姐', '长别名排在前面');

  const l1 = schema.linkEntities('玥姐姐站在青楼门口', idx);
  ok(l1.person.includes('凌玥'), '命中别名「玥姐姐」→ 凌玥');
  ok(l1.fact.includes('司楼'), '命中别名「青楼」→ 司楼');

  const l2 = schema.linkEntities('姐姐来了', idx);
  eq(l2.person, ['凌玥'], '短别名「姐姐」单独出现也能命中');

  const l3 = schema.linkEntities('凌乱的风', idx);
  eq(l3.person, [], '「凌」不是别名，不误命中');

  const l4 = schema.linkEntities('凌玥和玥姐姐', idx);
  eq(l4.person, ['凌玥'], '同一实体的多个别名只计一次');

  const l5 = schema.linkEntities('', idx);
  eq(l5.person, [], '空文本返回空人物');
  eq(l5.fact, [], '空文本返回空事实');
  eq(schema.resolveWho('玥姐姐', idx), '凌玥', 'resolveWho 归一别名');
  eq(schema.resolveWho('张三是谁', idx), '张三是谁', '未知名原样返回');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 世界索引 ===');
{
  const card = schema.normalizeCard({
    title: 't',
    entities: [
      { type: 'person', name: '凌玥', role: '凌家家主', status: '左肩中箭', weight: 1 },
      { type: 'person', name: '张兰', role: '保安', weight: 0.3 },
      { type: 'person', name: '龙套甲' },
      { type: 'institution', name: '司楼', summary: '官营青楼' },
      { type: 'item', name: '玉佩', summary: '来路不明' },
      { type: 'concept', name: '女尊', summary: '女子为尊' },
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
    entities: [
      { id: 'ling-yue', type: 'person', name: '凌玥' },
      { id: 'silou', type: 'institution', name: '司楼', tags: ['制度', '交易'], links: ['ling-yue'] },
      { id: 'jiajie', type: 'concept', name: '称呼礼法', tags: ['制度'], pinned: true },
      { id: 'wujia', type: 'item', name: '无关之物', tags: ['杂物'] },
      { id: 'mai', type: 'concept', name: '买卖规矩', tags: ['交易'] },
    ],
  });

  const a = sheet.selectCodex(card, { presentIds: ['ling-yue'], threadTags: [] });
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
    entities: [
      { id: 'ling-fu', type: 'place', name: '凌府' },
      { id: 'silou', type: 'place', name: '司楼' },
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
    entities: [
      { id: 'ling-yue', type: 'person', name: '凌玥' },
      { id: 'silou', type: 'institution', name: '司楼', tags: ['制度'], links: ['ling-yue'], muted: true },
      { id: 'yupei', type: 'item', name: '玉佩', tags: ['杂物'] },
    ],
  });
  eq(mutedCard.entities.find((e) => e.id === 'silou').muted, true, 'muted 归一为布尔');
  const mutedSel = sheet.selectCodex(mutedCard, { presentIds: ['ling-yue'], threadTags: ['制度'] });
  ok(!mutedSel.some((x) => x.entry.id === 'silou'), '静音条目不进自动进场候选');
  ok(!sheet.renderWorldIndex(mutedCard, 1200).includes('司楼'), '静音条目不进世界索引');
  ok(!sheet.renderWorldTree(mutedCard, 1200).includes('司楼'), '静音条目不进树形索引');
  eq(mutedCard.entities.find((e) => e.id === 'yupei').muted, false, '未静音条目保持 false');
  const mutedPinned = schema.normalizeCard({
    title: 'mp',
    entities: [{ id: 'p', type: 'concept', name: '钉选静音', pinned: true, muted: true }],
  });
  eq(sheet.selectCodex(mutedPinned, {}).length, 0, '静音优先于钉选，不无条件进场');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 场记单 ===');
{
  const card = schema.normalizeCard({
    title: 't',
    entities: [{
      id: 'ling-yue', type: 'person', name: '凌玥', role: '凌家家主',
      identity: { appearance: '窄袖玄色长衫，左手一枚旧玉扳指', station: '凌家家主' },
      voice: { rhythm: '短句，笑着说的狠话' },
      psyche: { traits: ['笑着说话，下手极快', '护短'], wants: ['带走他'], hides: ['七年前'] },
      knowledge: { knows: ['七年前的真相'], does_not_know: ['他见过南荣兰冰'] },
      agenda: [{ goal: '今天必须把他带走', method: '不能用施舍的方式', pressure: 0.9 }],
    }],
  });

  const out = sheet.renderSceneSheet({
    ledger: { time: '初冬 · 黄昏', place: '商务大厦门口', weather: '冷雨', tension: 0.7, characters: { 'ling-yue': { mood: '克制', location: '台阶上' } } },
    present: personsOf(card),
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
  ok(out.text.includes('外形：窄袖玄色长衫'), '外形来自 person.identity.appearance');
  ok(out.text.includes('身份：凌家家主'), '身份来自 person.identity.station');
  ok(out.text.includes('性格：笑着说话，下手极快'), '性格来自 person.psyche.traits');
  ok(out.text.includes('边界：'), '知识边界段');
  ok(out.text.includes('原声：「卿儿，过来。」'), '原声回声');
  ok(out.text.includes('未回收的线索'), '线索段');
  ok(!out.text.includes('本轮至少要动其中一条'), '压力段不再命令「每轮至少动一条线索」');
  ok(out.text.includes('关系'), '关系段');
  ok(out.text.includes('压力'), '压力段');
  ok(out.text.includes('本场指令（作者钦定，优先级最高）'), '本场指令段');
  ok(out.text.includes('本场可用设定'), '设定段');
  ok(!out.text.includes('必达节拍'), '没有节拍这种东西');
  ok(!out.text.includes('这一幕不要做'), '没有忌避清单');
  ok(!out.text.includes('第 1/2 幕'), '没有幕进度');

  // 人物声音与价值排序：lexicon 给「用词」、exemplars 给「说话像这样」、values 给「看重」。
  // 三者都只在作者写了才有；没写就不出现（不生成占位行）。
  const voiced = schema.normalizeCard({
    title: 'v',
    entities: [{
      id: 'xy', type: 'person', name: '谢云',
      voice: {
        rhythm: '先笑后刺',
        lexicon: ['本座', '听好', '不妨'],
        exemplars: ['「本座说过，不妨再听一遍。」', '「听好——只这一次。」', '「不必了。」'],
      },
      psyche: { traits: ['护短'], values: ['门第', '旧约', '不欠人情'] },
    }],
  });
  const voicedOut = sheet.renderSceneSheet({
    ledger: { place: '廊下' }, present: personsOf(voiced), capTokens: 2000,
  });
  ok(voicedOut.text.includes('用词：本座'), 'voice.lexicon 渲染成「用词」');
  ok(voicedOut.text.includes('说话像这样：「本座说过，不妨再听一遍。」'), 'voice.exemplars 渲染成原话示范');
  ok(!voicedOut.text.includes('不必了'), 'exemplars 只取前两条（不无界堆叠）');
  ok(voicedOut.text.includes('看重：门第、旧约、不欠人情'), 'psyche.values 渲染成「看重」');

  const unvoiced = schema.normalizeCard({
    title: 'nv', entities: [{ id: 'q', type: 'person', name: '钱四', voice: { rhythm: '急' }, psyche: { traits: ['贪'] } }],
  });
  const unvoicedOut = sheet.renderSceneSheet({
    ledger: { place: '廊下' }, present: personsOf(unvoiced), capTokens: 2000,
  });
  ok(!unvoicedOut.text.includes('用词：'), '没写 lexicon 就不出「用词」行');
  ok(!unvoicedOut.text.includes('说话像这样：'), '没写 exemplars 就不出原话行');
  ok(!unvoicedOut.text.includes('看重：'), '没写 values 就不出「看重」行');

  // 空状态
  const empty = sheet.renderSceneSheet({ present: [], capTokens: 1000 });
  eq(empty.text, '', '无在场者时返回空');

  // 极小配额：保留必要段，砍掉可选段
  const tiny = sheet.renderSceneSheet({
    ledger: { place: '雨街' },
    present: personsOf(card),
    relations: [{ from_name: '凌玥', to_name: '伍卿', kind: 'x', sentiment: 0 }],
    threads: [{ title: '线索一', status: 'open' }],
    codex: [{ entry: { name: '司楼', summary: '很长很长的设定内容'.repeat(50), facets: {} }, why: [] }],
    capTokens: 260,
  });
  ok(tiny.text.includes('在场'), '小配额保留在场');
  ok(estimate(tiny.text) <= 320, `小配额受控（${estimate(tiny.text)} tok）`);

  // 人群场：在场段绝不整段消失，按 完整 → 紧凑 → 极简 内部降级
  const crowd = Array.from({ length: 9 }, (_, i) => ({
    type: 'person', name: `群演${i + 1}`, role: '宾客',
    identity: { appearance: '锦缎长衫，袖口绣着暗纹', station: '座上客' },
    voice: { rhythm: '慢条斯理' },
    psyche: { traits: ['谨慎', '爱看热闹', '说话留半句'] },
    agenda: [{ goal: '看清主位上的动静', method: '不先开口', pressure: 0.7 }],
    knowledge: { knows: ['这场宴席的来客'], does_not_know: ['主位上的旧事'] },
  }));
  const crowdCard = schema.normalizeCard({ title: 'crowd', entities: crowd });
  const crowdOut = sheet.renderSceneSheet({
    ledger: { place: '宴席' },
    present: personsOf(crowdCard),
    capTokens: 3000,
    absentees: [{ name: '凌玥', state: 'dead', note: '被刺客刺杀，当场死亡' }],
  });
  ok(crowdOut.text.includes('在场'), '人群场：在场段不被整段丢弃');
  ok(!crowdOut.meta.dropped.includes('cast'), '人群场：cast 从不进 dropped');
  ok(['full', 'compact', 'minimal'].includes(crowdOut.meta.cast_mode), '人群场：记录 cast 档位');
  ok(crowdOut.text.includes('已故／离场：凌玥'), '缺席者在场记单里可见');

  const crowdTight = sheet.renderSceneSheet({
    ledger: { place: '宴席' }, present: personsOf(crowdCard), capTokens: 700,
  });
  ok(crowdTight.text.includes('在场'), '小配额下人群场仍保留在场');
  ok(crowdTight.meta.cast_mode !== 'full', '小配额下 cast 降级（不是整段丢）');
}

function estimate(s) {
  // 与 server/tokens.js 同口径的粗估：CJK 1 字 ≈ 1 token
  return Math.ceil(String(s).length * 0.6);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 辞书图谱：别名 / 关系 / 包含 ===');
{
  const card = schema.normalizeCard({
    title: '图',
    entities: [
      { id: 'ling-yue', type: 'person', name: '凌玥', aliases: ['玥姐姐'], relations: [{ to: 'wu-qing', kind: '旧识', sentiment: 0.8 }] },
      { id: 'wu-qing', type: 'person', name: '伍卿' },
      { id: 'zhang-lan', type: 'person', name: '张兰', role: '保安' },
      { id: 'ling-fu', type: 'place', name: '凌府', summary: '凌家主宅' },
      { id: 'tianjing', type: 'place', name: '天井', parent_id: 'ling-fu' },
      { id: 'yupei', type: 'item', name: '玉佩', summary: '无纹', links: ['ling-yue'] },
    ],
    edges: [{ from: 'wu-qing', to: 'ling-fu', kind: 'located_in' }],
  });
  const g = graphLib.buildWorldGraph(card);

  eq(g.resolve('玥姐姐'), 'ling-yue', '别名解析到人物节点');
  eq(g.resolve('ling-fu'), 'ling-fu', 'id 解析到自身');
  ok(g.entities.has('ling-fu'), '地点是独立节点');
  ok(g.edges.some((e) => e.from === 'ling-yue' && e.to === 'wu-qing' && e.kind === '旧识'), 'person.relations → 关系边');
  ok(g.edges.some((e) => (e.from === 'ling-yue' && e.to === 'yupei')
    || (e.from === 'yupei' && e.to === 'ling-yue')), 'entity.links → 关系边');
  ok(g.edges.some((e) => e.from === 'tianjing' && e.to === 'ling-fu' && e.kind === 'located_in'), 'parent_id → located_in 边');
  ok(g.edges.some((e) => e.from === 'wu-qing' && e.to === 'ling-fu' && e.kind === 'located_in'), '显式 edges 进入图');

  ok([...graphLib.graphNeighbors(g, ['ling-yue'], { depth: 1 })].includes('yupei'), '1 跳邻域包含玉佩');
  eq(graphLib.graphAncestors(g, 'tianjing'), ['ling-fu'], '包含关系可回溯祖先');

  const tree = sheet.renderWorldTree(card, 1200);
  ok(!tree.includes('（当前）'), '树形索引不标注当前地点（运行态归场记单）');
  ok(tree.includes('└ 天井'), '子地点缩进在父地点下');
  eq((tree.match(/张兰/g) || []).length, 1, '同一人物只出现一次');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 卡级 lint ===');
{
  const card = schema.normalizeCard({
    title: 'lint',
    entities: [
      { id: 'wu-qing', type: 'person', name: '伍卿', aliases: ['阿卿'] },
      { id: 'ling-yue', type: 'person', name: '凌玥' },
      { id: 'zhang-lan', type: 'person', name: '张兰' },
      { id: 'broken', type: 'item', name: '断链', links: ['不存在'] },
      { id: 'bad-parent', type: 'place', name: '断父', parent_id: '没有这个地方' },
      { id: 'a', type: 'place', name: '环A', parent_id: 'b' },
      { id: 'b', type: 'place', name: '环B', parent_id: 'a' },
      { id: 'collide', type: 'concept', name: '别名冲突', aliases: ['阿卿'] },
    ],
    claims: [
      { subject: '伍卿', predicate: '位于', cardinality: 'one', object: { kind: 'entity', id: 'a' }, validity: { from_turn: 1 } },
      { subject: '伍卿', predicate: '位于', cardinality: 'one', object: { kind: 'entity', id: 'b' }, validity: { from_turn: 2 } },
    ],
  });
  const report = lintLib.lintCard(card);
  const codes = new Set(report.issues.map((i) => i.code));
  ok(codes.has('alias_collision'), '报告别名冲突');
  ok(codes.has('broken_link'), '报告断链');
  ok(codes.has('broken_parent'), '报告断父');
  ok(codes.has('parent_cycle'), '报告包含环');
  ok(codes.has('claim_conflict'), '报告单值声明冲突');
  ok(report.counts.entities >= 7, '报告实体计数');

  // normalizeCard 会直接丢掉重复 id 的条目，所以 duplicate_id 只能对裸卡对象检查。
  const dup = lintLib.lintCard({
    entities: [
      { id: 'dup', type: 'person', name: '重复甲' },
      { id: 'dup', type: 'person', name: '重复乙' },
    ],
    timeline: [], claims: [], edges: [], anchors: [],
  });
  ok(new Set(dup.issues.map((i) => i.code)).has('duplicate_id'), '报告重复 id');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 卡级 lint：世界索引容量 ===');
{
  // 400 个实体：名字清单本身就会超出 1200 tok 名义容量。
  const many = schema.normalizeCard({
    title: 'big',
    entities: Array.from({ length: 400 }, (_, i) => ({
      type: i % 5 === 0 ? 'person' : 'concept',
      name: `实体${String(i).padStart(3, '0')}长名字`,
    })),
  });
  const report = lintLib.lintCard(many);
  const overflow = report.issues.find((i) => i.code === 'index_overflow');
  ok(!!overflow, '实体会挤爆世界索引时给出提示');
  eq(overflow?.severity, 'major', '索引容量不是 blocker（不拦保存）');
  ok((overflow?.dropped || 0) > 0, '报告被截掉的实体数量');

  const small = lintLib.lintCard(schema.normalizeCard({
    title: 'small', entities: [{ type: 'person', name: '凌玥' }, { type: 'place', name: '雨街' }],
  }));
  ok(!small.issues.some((i) => i.code === 'index_overflow'), '小卡不报索引容量问题');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== renderCardText（导出）===');
{
  const card = schema.normalizeCard({
    title: '女尊世界', subtitle: '捡破烂',
    premise: '被丢掉的人被重新捡起来',
    charter: ['女子主外'],
    entities: [
      {
        type: 'person', name: '凌玥', role: '家主',
        identity: { appearance: '玄色长衫', station: '凌家家主' },
        voice: { rhythm: '短句' },
        psyche: { traits: ['笑里藏刀'], wants: ['带走他'] },
        agenda: [{ goal: '今天带走他' }],
      },
      { type: 'institution', name: '司楼', summary: '官营青楼', facets: { rules: ['入内即除籍'] } },
    ],
    timeline: [{ what: '母亲丢下他', canon: 'past' }, { what: '黎婆确诊', canon: 'future' }],
    anchors: [{ label: '序章' }],
  });
  const text = schema.renderCardText(card);
  ok(text.includes('# 女尊世界 · 捡破烂'), '标题');
  ok(text.includes('## 故事方向'), '故事方向段');
  ok(text.includes('## 角色'), '角色段');
  ok(text.includes('外貌：玄色长衫'), '导出含外貌');
  ok(text.includes('性格：笑里藏刀'), '导出含性格');
  ok(text.includes('身份：凌家家主'), '导出含身份');
  ok(text.includes('私心：'), '导出演私心');
  ok(text.includes('## 设定集'), '设定集段');
  ok(text.includes('[前史] 母亲丢下他'), '时间线标前史');
  ok(text.includes('[参考走向] 黎婆确诊'), '参考走向标出来（给人看，不给模型）');
  ok(text.includes('## 开局点'), '开局点段');
}

console.log('\n=== 辞书检索（模型主动取证） ===');
{
  const card = schema.normalizeCard({
    title: '检索测试',
    entities: [
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

  const text = sheet.renderCodexHit(card.entities[0]);
  ok(text.includes('入内即除籍'), '检索结果渲染规则');
  ok(text.includes('官营青楼'), '检索结果渲染摘要');

  const duplicated = sheet.renderCodexHit({
    name: '玉佩', summary: '无纹玉佩',
    facets: { history: '完整来历' }, detail: '完整来历',
  });
  eq((duplicated.match(/完整来历/g) || []).length, 1, 'summary/history/detail 重复文本只渲染一次');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 制卡：逐章抽取字段 + cutoff 定格（A-1） ===');
{
  const chapter1 = smithLib.parseChapterExtract(JSON.stringify({
    entities: [
      {
        kind: 'character', name: '凌玥', aliases: ['玥姐姐'],
        summary: '凌家家主', detail: '凌家现任家主，'.repeat(30),
        appearance: '一身玄色长衫，'.repeat(20),
        station: '凌家家主',
        traits: ['笑里藏刀', '护短'],
        wants: ['把伍卿带回家'],
        fears: ['被家族抛弃'],
        values: ['家族体面'],
        hides: ['其实怕黑'],
        knowledge: {
          knows: ['伍卿被她母亲丢在司楼'],
          does_not_know: ['玉佩的来历'],
          believes_falsely: ['伍卿过得很好'],
        },
        agenda: [{ goal: '今天把伍卿带走', method: '直接去司楼要人', pressure: 0.8, deadline: '三日内' }],
        voice: {
          address: { 对伍卿: '阿卿', 对下人: '喂' },
          rhythm: '短句，先结论后解释',
          lexicon: ['本座', '听好'],
          never: ['求人'],
        },
      },
      { kind: 'character', name: '伍卿', aliases: ['阿卿'], summary: '被丢在司楼的人', detail: '原被凌玥母亲丢下' },
      { kind: 'institution', name: '司楼', summary: '官营青楼', detail: '入内即除籍' },
      { kind: 'place', name: '天井', summary: '凌家天井' },
      { kind: 'item', name: '无纹玉佩', summary: '遇暗发绿光', detail: '来历不明' },
    ],
    relations: [{ from: '凌玥', to: '伍卿', kind: '旧识', sentiment: 0.6, note: '十年前认识' }],
    events: [{ when: '清晨', what: '凌玥在司楼遇见伍卿', who: ['凌玥', '伍卿'], significant: true }],
    voices: [
      { who: '凌玥', text: '今天带走他' },
      { who: '凌玥', text: '这句原文里没有' },
    ],
    rules: ['女子主外'],
  }), 1);
  const chapter2 = smithLib.parseChapterExtract(JSON.stringify({
    entities: [
      {
        kind: 'character', name: '凌玥', detail: '后章才揭示：她早知玉佩来历',
        hides: ['早就知道玉佩来历'],
        knowledge: { knows: ['后章才知道的秘密'] },
        agenda: [{ goal: '后章才有的目标' }],
      },
    ],
    relations: [{ from: '凌玥', to: '司楼', kind: '暗中掌控', sentiment: -0.2, note: '后章关系' }],
    events: [{ when: '三日后', what: '凌玥封了司楼', who: ['凌玥', '司楼'], significant: true }],
    voices: [{ who: '凌玥', text: '我偏要留下' }],
    rules: ['官营青楼不得私封'],
  }), 2);
  const chapter3 = smithLib.parseChapterExtract(JSON.stringify({
    entities: [{ kind: 'character', name: '黎婆', summary: '后章才登场' }],
    events: [{ when: '一个月后', what: '黎婆确诊', who: ['黎婆'], significant: true }],
  }), 3);

  eq(chapter1.entities[0].appearance.length, 120, '单章解析：appearance 先按 120 字收口');
  eq(smithLib.parseChapterExtract('不是 JSON', 9).entities, [], '坏 JSON 不抛错、给空字段');

  const sourceTexts = ['今天带走他。', '我偏要留下。'];
  const card = smithLib.buildCardFromExtracts({
    chapters: [chapter1, chapter2, chapter3],
    title: '女尊世界', premise: '被丢掉的人被重新捡起来', startAt: 2, sourceTexts,
  });
  const lingYue = personsOf(card).find((c) => c.name === '凌玥');

  ok(!!lingYue, '人物实体含主角');
  eq(card.kind, 'adapted', 'kind=adapted');
  ok(card.entities.every((e) => e.type !== 'character'), '不产出 character 类型（抽取契约的 character 落成 person）');
  ok(lingYue.identity.appearance.length > 0 && lingYue.identity.appearance.length <= 60, 'appearance 抽到且 ≤60 字');
  eq(lingYue.identity.station, '凌家家主', 'station 抽到');
  ok(lingYue.identity.background.length > 0 && lingYue.identity.background.length <= 160, 'background 裁到 ≤160 字');
  ok(lingYue.psyche.traits.includes('笑里藏刀'), 'psyche.traits 抽到');
  ok(lingYue.psyche.wants.includes('把伍卿带回家'), 'psyche.wants 抽到');
  ok(lingYue.psyche.fears.includes('被家族抛弃'), 'psyche.fears 抽到');
  ok(lingYue.psyche.values.includes('家族体面'), 'psyche.values 抽到');
  ok(lingYue.psyche.hides.includes('其实怕黑'), 'psyche.hides 抽到');
  for (const key of ['traits', 'wants', 'fears', 'values', 'hides']) {
    ok(lingYue.psyche[key].every((s) => s.length <= 40), `psyche.${key} 每条 ≤40 字`);
  }
  ok(lingYue.knowledge.knows.includes('伍卿被她母亲丢在司楼'), 'knowledge.knows 抽到起点前的知识');
  ok(!lingYue.knowledge.knows.includes('后章才知道的秘密'), 'knowledge 不吸收 cutoff 之后的知识');
  ok(lingYue.knowledge.does_not_know.includes('玉佩的来历'), 'knowledge.does_not_know 抽到');
  ok(lingYue.knowledge.believes_falsely.includes('伍卿过得很好'), 'knowledge.believes_falsely 抽到');
  eq(lingYue.agenda[0].goal, '今天把伍卿带走', 'agenda 取起点前的目标');
  eq(lingYue.agenda.length, 1, 'agenda 不吸收后章目标');
  eq(lingYue.relations.map((r) => r.to), ['伍卿'], 'relations 的 to 归一为人物 id，且只取起点前');
  eq(lingYue.relations[0].kind, '旧识', 'relations 带关系类型');
  eq(lingYue.voice.rhythm, '短句，先结论后解释', 'voice.rhythm 抽到');
  eq(lingYue.voice.address['对伍卿'], '阿卿', 'voice.address 抽到');
  ok(lingYue.voice.lexicon.includes('本座'), 'voice.lexicon 抽到');
  ok(lingYue.voice.never.includes('求人'), 'voice.never 抽到');
  eq(lingYue.voice.exemplars, ['今天带走他', '我偏要留下'], 'exemplars 只留原文里逐字出现的台词');
  ok(!lingYue.voice.exemplars.some((t) => t.includes('这句原文里没有')), '模型编的台词被丢弃');

  eq(card.timeline.filter((e) => e.canon === 'past').map((e) => e.what), ['凌玥在司楼遇见伍卿'], 'cutoff 之前的事件才是 past');
  eq(card.timeline.filter((e) => e.canon === 'future').length, 2, 'cutoff 之后的事件标 future');
  ok(card.timeline.every((e) => e.canon === 'past' || e.canon === 'future'), 'timeline 不出现第三种 canon');
  eq(card.source?.kind, 'novel', '定格写出来源元数据（source.kind）');
  eq(card.source?.canon_cutoff, 'ch2', 'source.canon_cutoff 与 cutoff 同口径，供后文泄漏检查');
  ok(!lintLib.lintCard(card).issues.some((i) => i.code === 'future_leak'), '制卡产出：past 事件全部早于 cutoff，lint 不误报');

  const snapshot = card.anchors[0].snapshot;
  ok('凌玥' in snapshot.characters && '伍卿' in snapshot.characters, '快照含起点时已登场的人');
  ok(!('黎婆' in snapshot.characters), '快照不含 cutoff 之后才登场的人');
  eq(snapshot.place, '天井', '快照地点取起点章节的地点');
  eq(snapshot.place_id, '天井', '快照 place_id 是地点实体的裸 id');
  eq(snapshot.last_hook, '凌玥在司楼遇见伍卿', '快照 last_hook 取最后一条 past 事件');

  eq(factsOf(card).map((e) => e.name).sort(), ['天井', '司楼', '无纹玉佩'].sort(), '事实实体收非人物条目');
  const known = new Set();
  const factIds = new Set(factsOf(card).map((e) => e.id));
  for (const e of card.entities) { known.add(e.id); known.add(e.name); for (const a of e.aliases) known.add(a); }
  ok(card.entities.every((e) => (e.links || []).every((l) => known.has(l))), '同章共现 links 都是已知实体');
  ok(card.entities.every((e) => e.type === 'person' || (e.links || []).every((l) => factIds.has(l))), '同章共现 links 只连事实实体');
  const linkOf = (name) => card.entities.find((e) => e.name === name).links;
  ok(linkOf('司楼').includes('无纹玉佩') && linkOf('无纹玉佩').includes('司楼'), '同章共现：司楼 ↔ 无纹玉佩');
  ok(linkOf('天井').includes('司楼'), '同章共现：天井 ↔ 司楼');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 制卡：同章共现 links 确定性 ===');
{
  const extracts = [
    smithLib.parseChapterExtract(JSON.stringify({
      entities: [
        { kind: 'place', name: '甲地' },
        { kind: 'item', name: '乙物' },
        { kind: 'character', name: '丙人' },
        { kind: 'concept', name: '丁理' },
      ],
    }), 1),
    smithLib.parseChapterExtract(JSON.stringify({
      entities: [
        { kind: 'place', name: '甲地' },
        { kind: 'concept', name: '丁理' },
        { kind: 'place', name: '戊地' },
      ],
    }), 2),
  ];
  const build = () => smithLib.buildCardFromExtracts({ chapters: extracts, title: 'links', startAt: 1 });
  const a = build();
  const b = build();
  eq(factsOf(a).map((e) => e.links), factsOf(b).map((e) => e.links), '同一输入两次定格，links 完全一致');
  const byName = (card, name) => card.entities.find((e) => e.name === name);
  ok(byName(a, '甲地').links.includes('乙物'), '同章两实体互链（甲地 → 乙物）');
  ok(byName(a, '乙物').links.includes('甲地'), 'links 双向');
  ok(byName(a, '甲地').links.includes('丁理'), '跨章共现也补链（甲地 ↔ 丁理）');
  ok(!byName(a, '乙物').links.includes('戊地'), '不同章不共现 → 不补链');
  ok(byName(a, '丙人').type === 'person', '抽取里的 character 落成人物实体，不进事实候选');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 制卡：定格 pass（引用归一） ===');
{
  const card = schema.normalizeCard({
    title: '归位',
    entities: [
      { id: 'ling-yue', type: 'person', name: '凌玥', identity: { background: '家主' }, relations: [{ to: '阿卿', kind: '旧识' }] },
      { id: 'wu-qing', type: 'person', name: '伍卿', aliases: ['阿卿'] },
      { id: 'yupei', type: 'item', name: '无纹玉佩', summary: '遇暗发绿光', links: ['ling-yue'] },
    ],
  });
  const fixed = smithLib.finalizeCard(card);
  eq(fixed.entities.map((e) => e.id), ['ling-yue', 'wu-qing', 'yupei'], '人物与事实都在 entities 里，不需要归位');
  ok(fixed.entities.every((e) => e.type !== 'character'), '定格后没有 character 类型');
  eq(personsOf(fixed).map((e) => e.id), ['ling-yue', 'wu-qing'], '人物仍是人物');
  const ling = fixed.entities.find((e) => e.id === 'ling-yue');
  eq(ling.relations[0].to, 'wu-qing', '关系里指向别名的 to 归一为人物 id');
  eq(fixed.entities.find((e) => e.id === 'yupei').links, [], 'links 只连事实实体，指向人物的链接被丢弃');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 制卡：断点续跑（按章缓存） ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narra-smith-'));
  fs.writeFileSync(path.join(dir, '第1章 捡人.txt'), '第一章原文。', 'utf8');
  fs.writeFileSync(path.join(dir, '第2章 风波.txt'), '第二章原文。', 'utf8');
  const cacheDir = path.join(dir, 'cache');

  const fakeExtract = (counter) => async (chapter, index) => {
    counter.n++;
    return {
      chapter: index,
      entities: [{ kind: 'character', name: `角色${index}`, summary: '某人', detail: '来历' }],
      relations: [], events: [], voices: [], rules: [],
    };
  };

  const firstCounter = { n: 0 };
  const first = await smithLib.smithCard({
    dir, title: '缓存测试', concurrency: 1, extract: fakeExtract(firstCounter), cacheDir,
  });
  eq(firstCounter.n, 2, '首次运行：两章都调模型');
  eq(first.stats.cached, 0, '首次运行：无缓存命中');
  eq(first.stats.chapters, 2, 'stats 报告章数');
  eq(first.stats.entities, 2, 'stats 报告实体数');
  eq(first.stats.persons, 2, 'stats 报告人物数');
  eq(first.card.source?.canon_cutoff, 'ch1', 'smithCard 写入 canon_cutoff（缺省 = 起点章）');
  eq(first.card.source?.chapters, 2, 'source.chapters 记整本素材章数，不是本次抽取章数');
  ok(!lintLib.lintCard(first.card).issues.some((i) => i.code === 'future_leak'), '续跑产出的卡不触发 future 泄漏');

  const secondCounter = { n: 0 };
  const second = await smithLib.smithCard({
    dir, title: '缓存测试', concurrency: 1, extract: fakeExtract(secondCounter), cacheDir,
  });
  eq(secondCounter.n, 0, '断点续跑：已完成章不再调模型');
  eq(second.stats.cached, 2, '断点续跑：命中两章缓存');
  eq(JSON.stringify(second.card), JSON.stringify(first.card), '缓存命中产出的卡与首次一致');

  const thirdCounter = { n: 0 };
  fs.appendFileSync(path.join(dir, '第1章 捡人.txt'), '补了一段。', 'utf8');
  const third = await smithLib.smithCard({
    dir, title: '缓存测试', concurrency: 1, extract: fakeExtract(thirdCounter), cacheDir,
  });
  eq(thirdCounter.n, 1, '素材改动 → 指纹失效，只重跑改动章');
  eq(third.stats.cached, 1, '素材改动 → 另一章仍命中缓存');

  // 并发抽取：结果按章号确定性合并，与串行一致（不因完成顺序漂移）。
  const parDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narra-smith-par-'));
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(parDir, `第${i}章.txt`), `第${i}章原文。`, 'utf8');
  const extractAsync = () => async (chapter, index) => {
    // 让第 1 章最慢完成，验证合并顺序不受完成顺序影响。
    await new Promise((r) => setTimeout(r, index === 1 ? 30 : 1));
    return {
      chapter: index,
      entities: [{ kind: 'character', name: `角色${index}`, summary: '某人', detail: '来历' }],
      relations: [], events: [], voices: [], rules: [],
    };
  };
  const serial = await smithLib.smithCard({
    dir: parDir, title: '并发', concurrency: 1, extract: extractAsync(), cacheDir: path.join(parDir, 'cache-serial'),
  });
  const parallel = await smithLib.smithCard({
    dir: parDir, title: '并发', concurrency: 3, extract: extractAsync(), cacheDir: path.join(parDir, 'cache-par'),
  });
  eq(JSON.stringify(parallel.card), JSON.stringify(serial.card), '并发抽取与串行产出同一张卡（按章号合并）');
  eq(parallel.stats.chapters, 3, '并发抽取章数完整');

  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narra-smith-fail-'));
  fs.writeFileSync(path.join(failDir, '第1章.txt'), '一。', 'utf8');
  fs.writeFileSync(path.join(failDir, '第2章.txt'), '二。', 'utf8');
  const failCache = path.join(failDir, 'cache');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const boom = (counter) => async (chapter, index) => {
      counter.n++;
      if (index === 2) throw new Error('模拟上游失败');
      return { chapter: index, entities: [{ kind: 'character', name: `角色${index}`, summary: '', detail: '' }], relations: [], events: [], voices: [], rules: [] };
    };
    const c1 = { n: 0 };
    const r1 = await smithLib.smithCard({ dir: failDir, title: '失败重试', concurrency: 1, extract: boom(c1), cacheDir: failCache });
    eq(c1.n, 2, '失败章不中断整卡，另一章照常抽');
    eq(personsOf(r1.card).length, 1, '失败章不产出空壳人物');
    const c2 = { n: 0 };
    const r2 = await smithLib.smithCard({ dir: failDir, title: '失败重试', concurrency: 1, extract: boom(c2), cacheDir: failCache });
    eq(c2.n, 1, '断点续跑：只重试失败章');
    eq(r2.stats.cached, 1, '断点续跑：成功章读缓存');
  } finally {
    console.warn = warn;
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 卡级 lint：内容充分性 + id 冲突 blocker（A-2） ===');
{
  const card = schema.normalizeCard({
    title: 'lint 内容',
    entities: [
      { id: 'wu-qing', type: 'person', name: '伍卿' },
      { id: 'c1', type: 'item', name: '素条' },
      { id: 'ok', type: 'place', name: '有内容', summary: '有摘要', facets: { rules: ['规矩'] } },
    ],
  });
  const report = lintLib.lintCard(card);
  const codes = new Set(report.issues.map((i) => i.code));
  ok(codes.has('person_incomplete'), '内容充分性：缺 appearance/summary/rhythm');
  ok(report.issues.some((i) => i.code === 'person_incomplete' && i.missing.includes('appearance')), 'person_incomplete 带 missing 明细');
  ok(codes.has('person_hollow'), '内容充分性：既无欲望又无秘密');
  ok(codes.has('fact_incomplete'), '内容充分性：事实缺 summary/facets');

  const dup = lintLib.lintCard({
    entities: [
      { id: 'dup', type: 'person', name: '重复甲' },
      { id: 'dup', type: 'person', name: '重复乙' },
    ],
    timeline: [], claims: [], edges: [], anchors: [],
  });
  ok(new Set(dup.issues.map((i) => i.code)).has('duplicate_id'), 'blocker：id 冲突');
  ok(report.counts.bySeverity.blocker === 0, '纯内容问题不产生 blocker（不拦保存）');
  eq(
    Object.values(report.counts.bySeverity).reduce((a, b) => a + b, 0),
    report.issues.length,
    'bySeverity 合计等于 issues 总数',
  );

  const soft = lintLib.lintCard(schema.normalizeCard({
    entities: [
      { type: 'person', name: '空壳甲' },
      { type: 'item', name: '素辞' },
    ],
  }));
  eq(soft.counts.bySeverity.blocker, 0, '纯内容问题不产生 blocker（不拦保存）');
  ok(soft.issues.some((i) => i.code === 'person_incomplete' && i.severity === 'info'), '内容问题只报 info');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 卡级 lint：future 信息泄漏 blocker（A-2） ===');
{
  const source = { kind: 'novel', title: '某书', chapters: 10, canon_cutoff: 'ch3' };
  const clean = lintLib.lintCard(schema.normalizeCard({
    title: '不泄漏',
    source,
    timeline: [
      { id: 'evt-1', when: '开局前', what: '旧事', who: [], source: 'ch.2', canon: 'past' },
      { id: 'evt-2', when: '后文', what: '原著后续', who: [], source: 'ch.5', canon: 'future' },
    ],
  }));
  ok(!clean.issues.some((i) => i.code === 'future_leak'), 'past 都早于 cutoff：不报泄漏');

  const leaked = lintLib.lintCard(schema.normalizeCard({
    title: '泄漏',
    source,
    timeline: [
      { id: 'evt-1', what: '旧事', source: 'ch.2', canon: 'past' },
      { id: 'evt-2', what: '后章的事', source: '第5章', canon: 'past' },
    ],
  }));
  const leak = leaked.issues.find((i) => i.code === 'future_leak');
  ok(!!leak, 'past 事件来自 cutoff 之后：报 future_leak');
  eq(leak?.severity, 'blocker', 'future_leak 是 blocker（拦保存）');
  ok(leak?.message.includes('第5章') && leak?.message.includes('ch3'), 'future_leak 消息带来源与截止章');
  eq(leaked.counts.bySeverity.blocker, 1, 'future_leak 计入 bySeverity.blocker');

  const noSource = lintLib.lintCard(schema.normalizeCard({
    title: '没有来源',
    timeline: [{ what: '手写前史', source: 'ch.99', canon: 'past' }],
  }));
  ok(!noSource.issues.some((i) => i.code === 'future_leak'), '没有 source.canon_cutoff 的卡不做猜测');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-world-card: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
