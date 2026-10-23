/**
 * Agent 层自测试：node tests/test-agents.js（在项目根目录运行）。
 *
 * 分两部分：
 *   A. mock 测试（不调真实 LLM）：提示词生成、state 合并、分支 JSON 解析降级、memoryUpdate 解析降级；
 *   B. 真实 LLM 测试：仅在 RUN_LLM_TESTS=1 且配置了 STEPFUN_API_KEY 时运行，否则打印 SKIP。
 *
 * 无第三方测试框架，基于 node:assert/strict + 极简 runner。
 */
import assert from 'node:assert/strict';
import './load-env.js';
import { narratorSystemPrompt, narratorOpeningPrompt } from '../server/prompts/narrator.js';
import { branchSystemPrompt, branchUserPrompt } from '../server/prompts/branch.js';
import { memorySystemPrompt, roundSummaryUserPrompt, stateMergeUserPrompt } from '../server/prompts/memory.js';
import { runNarrator, buildNarratorMessages } from '../server/agents/narrator.js';
import { runBranchAgent, parseBranchPayload, summarizeScene } from '../server/agents/branch.js';
import { mergeState, parseMemoryUpdate } from '../server/agents/memory-agent.js';
import { config } from '../server/config.js';

/* ------------------------------ 测试 fixture ------------------------------ */

const TEST_SESSION = {
  id: 'test-session-agents',
  title: '雨夜码头',
  settings: {
    title: '雨夜码头',
    opening: '暴雨夜的临江旧港区，刑警沈默追查连环失踪案。第三个证人约他在三号仓库见面，却只留下一只沾血的工牌。',
    worldview: '现代都市悬疑：临江市江雾常年不散，旧港区废弃十年，地下流传着「灰鸽」组织掳人的传闻。',
    characters: [
      { name: '林霜', role: '追踪者/线人', personality: '冷静、敏锐、外冷内热', voice: '台词简短，句号收尾，少用感叹', secret: '她其实是失踪者之一，靠反水才活下来', avatar_hue: 210 },
      { name: '灰鸽七号', role: '神秘组织中层', personality: '彬彬有礼、掌控欲强', voice: '措辞客气却带命令感', secret: '真实身份是市局内鬼', avatar_hue: 0 },
    ],
    player_role: '刑警沈默，因三年前误判导致线人死亡的执念而独自追查真相。',
    rules: '禁止OOC；保持角色口吻；每轮1500-3000字；第三人称限知视角；结尾必须留钩子。',
    style_tags: ['悬疑', '都市'],
  },
};

const OLD_STATE = {
  time: '第二日·夜',
  location: '码头B仓',
  weather: '暴雨',
  tension: 0.4,
  characters: { '林霜': { mood: '警惕', location: '码头B仓', status: '受伤' } },
  inventory: ['半张船票'],
  quests: [{ goal: '查明失踪案', progress: '发现第一个证人', status: 'active' }],
  threads: ["神秘组织'灰鸽'的线索", '林霜的旧伤'],
  last_hook: 'B仓大门虚掩，里面有脚步声',
};

/* -------------------------------- runner ---------------------------------- */

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}: ${err?.message || err}`);
  }
}

/* --------------------------- A. mock 测试（无 LLM） --------------------------- */

// A1. narrator system prompt 注入了角色名/世界观/玩家身份/secret/演绎规范
test('prompts: narratorSystemPrompt 注入角色卡、世界观、玩家身份与 secret', () => {
  const p = narratorSystemPrompt(TEST_SESSION);
  for (const kw of ['林霜', '灰鸽七号', '临江市', '沈默', '反水才活下来', '市局内鬼']) {
    assert.ok(p.includes(kw), `system prompt 应包含「${kw}」`);
  }
  for (const kw of ['沉浸式剧情演绎引擎', '1500-3000', '第三人称限知视角', '钩子', '严禁', '专有名词']) {
    assert.ok(p.includes(kw), `system prompt 应包含规范关键词「${kw}」`);
  }
  assert.ok(p.includes('剧情记忆摘要'), 'system prompt 应包含记忆使用规范');
});

// A2. narrator opening prompt 基于 settings.opening
test('prompts: narratorOpeningPrompt 包含开场种子与任务指令', () => {
  const p = narratorOpeningPrompt(TEST_SESSION);
  assert.ok(p.includes('三号仓库'), '应包含开场种子内容');
  assert.ok(p.includes('开场'), '应声明这是开场轮');
  assert.ok(p.includes('雨夜码头'), '应包含作品标题');
});

// A3. branch prompt 规定 JSON schema 与选项质量标准
test('prompts: branchSystemPrompt 规定 schema 与质量标准', () => {
  const p = branchSystemPrompt(TEST_SESSION);
  for (const kw of ['branches', 'scene_summary', 'tension_delta', '3-4', '高风险高回报', 'response_format=json_object']) {
    assert.ok(p.includes(kw), `branch system prompt 应包含「${kw}」`);
  }
  assert.ok(!p.includes('市局内鬼'), 'branch prompt 不应泄露角色 secret');
});

// A4. branch user prompt 组装 sceneSummary / lastNarrative / state
test('prompts: branchUserPrompt 组装局势、剧情与状态', () => {
  const p = branchUserPrompt({
    sceneSummary: '时间：第三日·黄昏；地点：三号仓库',
    lastNarrative: '仓库深处传来铁链拖地声。',
    state: { location: '三号仓库', tension: 0.8 },
  });
  assert.ok(p.includes('第三日·黄昏'), '应包含 sceneSummary');
  assert.ok(p.includes('铁链拖地声'), '应包含最近剧情');
  assert.ok(p.includes('"tension":0.8'), '应包含 state JSON');
});

// A5. memory prompt 覆盖三段提示词
test('prompts: memorySystemPrompt / roundSummaryUserPrompt / stateMergeUserPrompt', () => {
  const sys = memorySystemPrompt();
  for (const kw of ['round_summary', 'entities', 'facts', 'state_delta', 'inventory_add', 'quests_update', 'threads_resolve']) {
    assert.ok(sys.includes(kw), `memory system prompt 应包含「${kw}」`);
  }
  const user = roundSummaryUserPrompt({ turnNo: 7, playerText: '我推开了仓库大门', branchChoice: { id: 'b1' }, narrative: '门轴发出刺耳的呻吟。' });
  assert.ok(user.includes('7') && user.includes('我推开了仓库大门') && user.includes('门轴'), 'round summary user prompt 应包含回合数据');
  assert.ok(user.includes('b1'), '应包含分支选择');
  const merge = stateMergeUserPrompt({ oldState: OLD_STATE, memoryUpdate: { state_delta: { time: '第三日·黄昏' } } });
  assert.ok(merge.includes('码头B仓') && merge.includes('第三日·黄昏'), 'state merge prompt 应包含旧 state 与 delta');
});

// A6. mergeState：首轮以 delta 为基底
test('mergeState: 首轮（oldState=null）以 delta 为基底', () => {
  const next = mergeState(null, {
    time: '第三日·黄昏',
    location: '临江旧港区',
    tension: 0.72,
    characters: { '林霜': { mood: '警惕' } },
    inventory_add: ['生锈的钥匙', '半张船票'],
    quests_update: [{ goal: '查明失踪案', progress: '发现第二个证人', status: 'active' }],
    threads_add: ["神秘组织'灰鸽'的线索"],
    last_hook: '仓库深处传来铁链拖地声',
  });
  assert.equal(next.time, '第三日·黄昏');
  assert.equal(next.location, '临江旧港区');
  assert.equal(next.tension, 0.72);
  assert.deepEqual(next.inventory, ['生锈的钥匙', '半张船票']);
  assert.equal(next.quests.length, 1);
  assert.equal(next.quests[0].progress, '发现第二个证人');
  assert.deepEqual(next.threads, ["神秘组织'灰鸽'的线索"]);
  assert.equal(next.characters['林霜'].mood, '警惕');
  assert.equal(next.last_hook, '仓库深处传来铁链拖地声');
});

// A7. mergeState：全字段合并语义
test('mergeState: 标量覆盖 / 角色逐键 / 物品增删 / 任务匹配 / 线索回收', () => {
  const next = mergeState(OLD_STATE, {
    time: '第三日·黄昏',
    tension: 0.8,
    characters: { '林霜': { status: '康复' }, '灰鸽七号': { mood: '微笑', location: '暗处' } },
    inventory_add: ['生锈的钥匙'],
    inventory_remove: ['半张船票'],
    quests_update: [
      { goal: '查明失踪案', progress: '发现第二个证人' },
      { goal: '潜入灰鸽', status: 'active' },
    ],
    threads_add: ['内鬼传闻'],
    threads_resolve: ['林霜的旧伤'],
    last_hook: '仓库深处传来铁链拖地声',
  });
  // 标量：变化的覆盖，未变化的保留
  assert.equal(next.time, '第三日·黄昏');
  assert.equal(next.tension, 0.8);
  assert.equal(next.weather, '暴雨');
  assert.equal(next.location, '码头B仓');
  // characters：同角色只更新变化字段，新角色追加
  assert.deepEqual(next.characters['林霜'], { mood: '警惕', location: '码头B仓', status: '康复' });
  assert.equal(next.characters['灰鸽七号'].mood, '微笑');
  // inventory：remove 优先
  assert.deepEqual(next.inventory, ['生锈的钥匙']);
  // quests：goal 命中更新，未命中追加
  assert.equal(next.quests.length, 2);
  assert.equal(next.quests[0].progress, '发现第二个证人');
  assert.equal(next.quests[0].status, 'active');
  assert.equal(next.quests[1].goal, '潜入灰鸽');
  // threads：新增去重、按原文回收
  assert.deepEqual(next.threads, ["神秘组织'灰鸽'的线索", '内鬼传闻']);
  assert.equal(next.last_hook, '仓库深处传来铁链拖地声');
  // 旧对象不被 mutate
  assert.equal(OLD_STATE.tension, 0.4);
  assert.deepEqual(OLD_STATE.inventory, ['半张船票']);
});

// A8. mergeState 边界：空 delta / falsy 标量 / 容器归一化
test('mergeState: 边界（空 delta、tension=0、容器归一化）', () => {
  assert.deepEqual(mergeState(null, {}), { characters: {}, inventory: [], quests: [], threads: [] });
  assert.equal(mergeState(OLD_STATE, { tension: 0 }).tension, 0);
  const norm = mergeState({ inventory: null, quests: 'x' }, {});
  assert.deepEqual(norm.inventory, []);
  assert.deepEqual(norm.quests, []);
  assert.deepEqual(norm.characters, {});
});

// A9. parseBranchPayload：坏 JSON → 3 个通用选项
test('parseBranchPayload: 坏 JSON 降级为 3 个通用选项', () => {
  const { branches, scene_summary } = parseBranchPayload('完全不是 JSON 的输出');
  assert.equal(branches.length, 3);
  assert.equal(scene_summary, '');
  assert.deepEqual(branches.map(b => b.id), ['b1', 'b2', 'b3']);
  assert.ok(branches.some(b => b.title === '顺势而为'));
  assert.ok(branches.some(b => b.title === '冒险试探'));
  assert.ok(branches.some(b => b.title === '按兵不动'));
  for (const b of branches) {
    assert.ok(b.title && b.description && b.tone && typeof b.tension_delta === 'number');
  }
});

// A10. parseBranchPayload：合法 JSON 的校验/截断/重编号
test('parseBranchPayload: 合法 JSON 校验、>4 截断、id 重编号', () => {
  const payload = JSON.stringify({
    branches: [
      { id: 'x9', title: '夜探B仓', description: '趁雨夜摸进B仓二楼，翻看灰鸽留下的货单，可能找到证人下落。', tone: '探索', tension_delta: 0.2 },
      { id: 'x1', title: '当面对质', description: '直接在码头堵住林霜，逼问她和灰鸽的关系，风险是撕破信任。', tone: '激进', tension_delta: 0.3 },
      { id: 'x2', title: '求援内线', description: '打电话给局里旧识请求支援，稳妥但可能打草惊蛇。', tone: '谨慎', tension_delta: -0.1 },
      { id: 'x3', title: '跟踪七号', description: '暗中跟踪灰鸽七号进城，或许能顺藤摸瓜找到据点。', tone: '智取', tension_delta: 0.15 },
      { id: 'x4', title: '多余选项', description: '第五个选项应被截断丢弃，只保留前四个。', tone: '诡道', tension_delta: 0.05 },
    ],
    scene_summary: '沈默在雨夜码头得知林霜身份可疑',
  });
  const { branches, scene_summary } = parseBranchPayload(payload);
  assert.equal(branches.length, 4, '超过 4 个应截断为 4');
  assert.deepEqual(branches.map(b => b.id), ['b1', 'b2', 'b3', 'b4'], 'id 应重编号');
  assert.equal(branches[0].title, '夜探B仓');
  assert.equal(branches[1].tone, '激进');
  assert.equal(scene_summary, '沈默在雨夜码头得知林霜身份可疑');
});

// A11. parseBranchPayload：JSON 外裹着废话 → 正则提取；数量不足 → 补齐
test('parseBranchPayload: 正则提取 + 数量不足补齐', () => {
  const messy = '好的，结果如下：\n{"branches":[{"title":"硬闯","description":"直接踹开三号仓库大门，可能打草惊蛇也可能一击制胜。","tone":"激进","tension_delta":0.4}],"scene_summary":"仓库外雨越下越大"}\n以上。';
  const { branches } = parseBranchPayload(messy);
  assert.equal(branches.length, 3, '有效选项不足 3 个应补齐');
  assert.equal(branches[0].title, '硬闯');
  assert.ok(branches.slice(1).every(b => ['顺势而为', '冒险试探', '按兵不动'].includes(b.title)));
  // description 缺失的选项应被丢弃
  const bad = JSON.stringify({ branches: [{ title: '只有标题' }], scene_summary: '' });
  assert.equal(parseBranchPayload(bad).branches.length, 3);
});

// A11b. parseBranchPayload：打捞层（JSON 截断 / 尾部杂质也能抢救分支对象）
test('parseBranchPayload: 打捞层恢复被截断/污染的 JSON', () => {
  // 场景 1：JSON 在中途被截断（maxTokens 打满），最后一个分支不完整
  const truncated = '{"branches":[{"id":"b1","title":"硬闯仓库","description":"直接踹开三号仓库大门，可能打草惊蛇也可能一击制胜。","tone":"激进","tension_delta":0.4},{"id":"b2","title":"联系援';
  const r1 = parseBranchPayload(truncated);
  assert.equal(r1.branches.length, 3, '打捞出 1 个 + 补齐到 3 个');
  assert.equal(r1.branches[0].title, '硬闯仓库');
  assert.equal(r1.branches[0].tone, '激进');
  assert.equal(r1.branches[0].id, 'b1');
  // 场景 2：JSON 合法但尾部带了含花括号的杂质，整体 parse 与贪婪正则都失败
  const dirty = '{"branches":[{"id":"b1","title":"追踪七号","description":"暗中跟踪灰鸽七号进城，或许能顺藤摸瓜找到据点。","tone":"智取","tension_delta":0.15}],"scene_summary":"雨夜码头局势紧张"}\n备注：以上选项覆盖多种风格 {激进|谨慎|探索}';
  const r2 = parseBranchPayload(dirty);
  assert.equal(r2.branches.length, 3);
  assert.equal(r2.branches[0].title, '追踪七号', '应打捞到真实分支而非兜底');
  assert.equal(r2.branches[0].tone, '智取');
  assert.equal(r2.scene_summary, '雨夜码头局势紧张', 'scene_summary 也应打捞');
  // 场景 3：连续两个 JSON 对象（模型重发）
  const doubled = JSON.stringify({ branches: [{ title: 'A选项', description: '描述A：趁夜潜入码头调度室翻看货单。', tone: '探索', tension_delta: 0.1 }], scene_summary: '局势' })
    + '\n' + JSON.stringify({ branches: [{ title: 'B选项', description: '描述B：直接联系局里旧识求援。', tone: '谨慎', tension_delta: -0.05 }], scene_summary: '局势2' });
  const r3 = parseBranchPayload(doubled);
  assert.equal(r3.branches[0].title, 'A选项');
  assert.ok(r3.branches.length >= 3);
  // 场景 4：description 字符串值内混入原始换行（非法 JSON），修复后应能解析
  const rawNewline = '{"branches":[{"title":"硬闯","description":"第一行：趁夜摸到仓库西侧。\n第二行：撬开铁门查看水道。","tone":"激进","tension_delta":0.4}],"scene_summary":"雨夜合围"}';
  const r4 = parseBranchPayload(rawNewline);
  assert.equal(r4.branches[0].title, '硬闯');
  assert.ok(r4.branches[0].description.includes('\n第二行'), '应修复裸换行并保留内容');
  assert.equal(r4.scene_summary, '雨夜合围');
});

// A12. parseMemoryUpdate：坏 JSON 降级
test('parseMemoryUpdate: 坏 JSON 降级为文本摘要', () => {
  const narrative = '雨夜里，沈默推开了三号仓库的大门。'.repeat(50);
  const r = parseMemoryUpdate('{{ 坏 JSON', narrative);
  assert.equal(r.round_summary, narrative.slice(0, 500));
  assert.deepEqual(r.entities, []);
  assert.deepEqual(r.facts, []);
  assert.deepEqual(r.state_delta, {});
  // LLM 输出可读文本（非 JSON）时直接沿用为摘要
  const prose = '本轮沈默进入仓库，发现沾血工牌与一串脚印，悬念指向灰鸽七号。'.repeat(3);
  const r2 = parseMemoryUpdate(prose, narrative);
  assert.equal(r2.round_summary, prose.slice(0, 500));
  // 合法 JSON 正常提取
  const ok = parseMemoryUpdate(JSON.stringify({
    round_summary: '摘要', entities: [{ type: 'item', name: '工牌' }],
    facts: [{ subject: '沈默', predicate: '拥有', object: '工牌' }],
    state_delta: { time: '第三日·黄昏' },
  }), narrative);
  assert.equal(ok.round_summary, '摘要');
  assert.equal(ok.entities.length, 1);
  assert.equal(ok.facts.length, 1);
  assert.deepEqual(ok.state_delta, { time: '第三日·黄昏' });
});

// A12b. parseMemoryUpdate：打捞层（JSON 截断 / 尾部杂质时抢救字段）
test('parseMemoryUpdate: 打捞层恢复被截断/污染的 JSON', () => {
  const narrative = '雨夜里，沈默推开了三号仓库的大门。'.repeat(50);
  // 摘要里故意埋下带引号的假字段（"time":"假时间"），验证屏蔽逻辑不会误取
  const dirty = '{"round_summary":"半夜沈默进入三号仓库，记录 \\"time\\":\\"假时间\\" 与 \\"last_hook\\":\\"假钩子\\" 均属摘要正文，不应进入 state_delta。",'
    + '"entities":[{"type":"item","name":"工牌","summary":"周德海的蓝色工牌","attributes":{"color":"蓝"},"importance":0.7}],'
    + '"facts":[{"subject":"沈默","predicate":"知晓","object":"灰鸽存在","confidence":0.8}],'
    + '"state_delta":{"time":"第一日·午夜","location":"三号仓库","tension":0.7,"characters":{"林霜":{"mood":"警惕","status":"受伤"}},"threads_add":["工牌线索","高处阴影"]}}'
    + ' 备注：以上输出符合 schema 要求 {OK}';
  const r = parseMemoryUpdate(dirty, narrative);
  assert.ok(r.round_summary.includes('沈默进入三号仓库'), '应打捞到 round_summary');
  assert.ok(r.round_summary.includes('"time":"假时间"'), '摘要内的转义引号应被正确还原');
  assert.equal(r.entities.length, 1, '应打捞到 entities（含嵌套 attributes）');
  assert.equal(r.entities[0].name, '工牌');
  assert.deepEqual(r.entities[0].attributes, { color: '蓝' });
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].subject, '沈默');
  assert.equal(r.state_delta.time, '第一日·午夜', 'state_delta 的 time 优先，不得被摘要里的假字段污染');
  assert.equal(r.state_delta.location, '三号仓库');
  assert.equal(r.state_delta.tension, 0.7);
  assert.deepEqual(r.state_delta.threads_add, ['工牌线索', '高处阴影']);
  assert.equal(r.state_delta.characters['林霜'].mood, '警惕');
  // 截断场景：entities 数组中途截断，完整的第一个实体仍应打捞出来
  const truncated = '{"round_summary":"沈默发现工牌与脚印，悬念升级。","entities":[{"type":"item","name":"工牌","summary":"周德海的工牌"},{"type":"character","name":"林';
  const r2 = parseMemoryUpdate(truncated, narrative);
  assert.equal(r2.round_summary, '沈默发现工牌与脚印，悬念升级。');
  assert.equal(r2.entities.length, 1, '只打捞完整的实体');
  assert.equal(r2.entities[0].name, '工牌');
  // 打捞不到任何有效字段时，仍然走文本摘要降级
  const junk = '{"round_summary":"x';
  const r3 = parseMemoryUpdate(junk, narrative);
  assert.equal(r3.round_summary, narrative.slice(0, 500));
});

// A12c. parseMemoryUpdate：裸控制字符修复 + 截断字符串打捞
test('parseMemoryUpdate: 裸换行修复与截断摘要恢复', () => {
  const narrative = '雨夜里，沈默推开了三号仓库的大门。'.repeat(50);
  // 字符串值内混入原始换行（非法 JSON），修复后应能整体解析
  const withRawNewline = '{"round_summary":"第一行：沈默进入仓库。\n第二行：发现工牌与 \\"周德海\\" 字样。","entities":[{"type":"item","name":"工牌"}],"state_delta":{"time":"第一日·午夜"}}';
  const r = parseMemoryUpdate(withRawNewline, narrative);
  assert.ok(r.round_summary.includes('第一行：沈默进入仓库。'), '应修复裸换行并解析出摘要');
  assert.ok(r.round_summary.includes('\n第二行'), '摘要内的换行应保留');
  assert.equal(r.entities.length, 1);
  assert.equal(r.state_delta.time, '第一日·午夜');
  // JSON 在 round_summary 字符串中途被截断（maxTokens 打满）：恢复部分摘要而非原文截断
  const truncated = '{"round_summary":"半夜十二点十七分，沈默推开三号仓库大门，在积水里发现一只蓝色工牌';
  const r2 = parseMemoryUpdate(truncated, narrative);
  assert.ok(r2.round_summary.includes('蓝色工牌'), '应打捞到被截断的摘要');
  assert.ok(r2.round_summary.length < 500);
  assert.notEqual(r2.round_summary, narrative.slice(0, 500), '不应退化为原文截断');
});

// A13. buildNarratorMessages：兜底组装 / 开场替换 / extraPrompt
test('buildNarratorMessages: 兜底、开场替换、extraPrompt 插入', () => {
  // 空 context → 兜底 system + 开场 user
  let msgs = buildNarratorMessages({ session: TEST_SESSION, context: { messages: [] }, isOpening: true });
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('林霜'));
  assert.equal(msgs.at(-1).role, 'user');
  assert.ok(msgs.at(-1).content.includes('三号仓库'), '末条应为开场指令');
  // assembler 已给 system + user → 不重复加 system，开场轮替换最后一条 user
  msgs = buildNarratorMessages({
    session: TEST_SESSION,
    context: {
      messages: [
        { role: 'system', content: 'assembler-system' },
        { role: 'user', content: 'assembler-memory-block' },
        { role: 'user', content: '玩家的旧行动' },
      ],
    },
    isOpening: true,
  });
  assert.equal(msgs.filter(m => m.role === 'system').length, 1, '不得重复添加 system');
  assert.equal(msgs[0].content, 'assembler-system', '保留 assembler 的 system');
  assert.equal(msgs.at(-1).role, 'user');
  assert.ok(msgs.at(-1).content.includes('开场'), '最后一条 user 应被替换为开场指令');
  // 非开场轮 + extraPrompt → 插入到最后一条 user 之前
  msgs = buildNarratorMessages({
    session: TEST_SESSION,
    context: { messages: [{ role: 'system', content: 's' }, { role: 'user', content: '行动' }], extraPrompt: '记忆使用补充规范' },
    isOpening: false,
  });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].content, '记忆使用补充规范');
  assert.equal(msgs.at(-1).content, '行动');
});

// A14. summarizeScene：从 state 提炼局势（接收裸 state；{turn_no,state} 解包由 pickState 负责）
test('summarizeScene: 从 state 快照生成一句话', () => {
  const s = summarizeScene(OLD_STATE);
  assert.ok(s.includes('时间：第二日·夜'));
  assert.ok(s.includes('地点：码头B仓'));
  assert.ok(s.includes('林霜'));
  assert.ok(s.includes('上一幕钩子'));
  assert.equal(summarizeScene(null), '');
});

/* --------------------------- B. 真实 LLM 测试（门控） --------------------------- */

async function llmTests() {
  if (process.env.RUN_LLM_TESTS !== '1') {
    console.log('SKIP 真实 LLM 测试（设置 RUN_LLM_TESTS=1 启用）');
    return;
  }
  if (!config.upstream.apiKey) {
    console.log('SKIP 真实 LLM 测试（未配置 STEPFUN_API_KEY）');
    return;
  }

  await test('LLM: runNarrator 开场轮产出 500+ 字中文剧情', async () => {
    const deltas = [];
    const res = await runNarrator({
      session: TEST_SESSION,
      context: { messages: [] },
      turnNo: 1,
      isOpening: true,
      onDelta: ({ type, delta }) => deltas.push({ type, delta }),
    });
    const cjk = (res.content.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    assert.ok(res.content.length >= 500, `开场剧情应 ≥500 字，实际 ${res.content.length}`);
    assert.ok(cjk >= 400, `中文内容应 ≥400 字，实际 ${cjk}`);
    assert.ok(deltas.some(d => d.type === 'content'), '应转发 content delta');
    assert.ok(typeof res.usage === 'object' && res.usage !== null, '应返回 usage');
    console.log(`     开场长度 ${res.content.length} 字（CJK ${cjk}），usage=${JSON.stringify(res.usage)}，model=${res.model}`);
  });

  await test('LLM: runBranchAgent 返回 3-4 个合法选项', async () => {
    const first = await runNarrator({ session: TEST_SESSION, context: { messages: [] }, turnNo: 1, isOpening: true });
    const res = await runBranchAgent({
      session: TEST_SESSION,
      context: { state: { turn_no: 1, state: { time: '第一日·午夜', location: '三号仓库', tension: 0.7, last_hook: '仓库深处传来铁链拖地声' } } },
      recentNarrative: first.content,
    });
    assert.ok(res.branches.length >= 3 && res.branches.length <= 4, `选项数应为 3-4，实际 ${res.branches.length}`);
    const tones = new Set(res.branches.map(b => b.tone));
    assert.ok(tones.size >= 2, `tone 应多样，实际 ${[...tones].join('/')}`);
    for (const b of res.branches) {
      assert.ok(b.id && /^b\d+$/.test(b.id), `id 应规范：${b.id}`);
      assert.ok(b.title && b.title.length <= 12, `title 应 ≤12 字：${b.title}`);
      assert.ok(b.description && b.description.length >= 20, `description 过短：${b.description}`);
      assert.ok(typeof b.tension_delta === 'number', 'tension_delta 应为数字');
    }
    console.log(`     选项：${res.branches.map(b => `${b.id} ${b.title}[${b.tone}]`).join(' | ')}`);
  });
}

/* -------------------------------- 入口 ---------------------------------- */

async function main() {
  await llmTests();
  if (failures.length) {
    console.error(`\n${failures.length} 个测试失败：`);
    for (const f of failures) {
      console.error(` - ${f.name}\n   ${(f.err?.stack || f.err || '').toString().split('\n').slice(0, 3).join('\n   ')}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`\n${passed} 项断言组全部通过`);
  console.log('ALL AGENT TESTS PASSED');
}

await main();
