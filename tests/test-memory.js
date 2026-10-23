/**
 * tests/test-memory.js — 分层记忆系统自测试
 *
 * 运行方式（在项目根目录）：
 *   node tests/test-memory.js
 *
 * 使用临时 DB（DB_PATH=./data/test-memory.db），跑完自动删除。
 * checkCompression 需要真实 LLM：未配置 STEPFUN_API_KEY 或调用失败时打印 SKIP，不算失败。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 加载 .env（若存在），使真实 LLM 测试可以执行
try { process.loadEnvFile?.(path.join(ROOT, '.env')); } catch { /* no .env */ }

const DB_PATH = process.env.DB_PATH || './data/test-memory.db';

// store / config 在模块装载时读取 DB_PATH，必须先设置再动态 import
process.env.DB_PATH = DB_PATH;

const { config } = await import('../server/config.js');
const store = await import('../server/memory/store.js');
const { MemoryRetriever, tokenize } = await import('../server/memory/retriever.js');
const { assembleContext, buildNarratorSystemPrompt } = await import('../server/memory/assembler.js');
const { checkCompression } = await import('../server/memory/compressor.js');
const { estimateMessagesTokens } = await import('../server/tokens.js');

const {
  createSession, getSession, addTurn, upsertEntity, addFact, setState,
  addSummary, getSummaries, getEntities, getFacts, getState, getDb,
} = store;

/* ------------------------------------------------------------------ */
/* 测试夹具数据                                                        */
/* ------------------------------------------------------------------ */

const SETTINGS = {
  title: '雨港异闻录',
  opening: '暴雨夜的临江旧港区，一封没有署名的船票把你和女追踪者林霜卷进了灰鸽组织的旧案。',
  worldview: '近未来的临江市。水下三千米沉睡着一座青铜古城，每逢大潮，港口就会出现不该出现的货箱。异能者组织"灰鸽"在暗处清点这些货，而官方记录里它从未存在过。',
  characters: [
    {
      name: '林霜', role: '女主角/追踪者', personality: '冷静、敏锐、外冷内热',
      voice: '台词简短，句号收尾，少用感叹', secret: '她在寻找失踪的妹妹林汐',
      avatar_hue: 210,
    },
    {
      name: '沈枢', role: '旧港管理员', personality: '圆滑、怕事、嘴严',
      voice: '爱用俗语，说到正题就转移话题', secret: '他收过灰鸽组织的钱',
      avatar_hue: 40,
    },
  ],
  player_role: '私人侦探，经营一家濒临倒闭的事务所，左臂有旧枪伤',
  rules: '禁止OOC，保持角色口吻，每轮1500-3000字，关键专有名词必须前后一致',
  style_tags: ['悬疑', '都市异能'],
  narrator_effort: 'high',
  context_max_tokens: 200000,
};

/** 20 轮剧情文本（含专有名词：林霜 / 灰鸽组织 / 青铜钥匙 / 沈枢 / 白鸮 / 水下古城） */
const ROUNDS = [
  '雨夜。林霜把我堵在事务所门口，说灰鸽组织的人正在临江旧港区清点一批来路不明的货。她递来半张船票，背面刻着灰鸽的印记。',
  '我们潜入旧港区B仓。林霜用青铜钥匙打开了锈死的铁门，门后是一排冷藏柜，柜门上贴着编号：07、08、09——唯独没有06。',
  '灰鸽组织的巡逻队打着黑伞经过。林霜屏住呼吸，把青铜钥匙攥得指节发白。我注意到她的旧伤又在渗血。',
  '冷藏柜06号里躺着一本湿透的航海日志，记录着三次抵达水下古城的航程。沈枢的名字出现在最后一页，墨迹被水洇开。',
  '林霜说沈枢是她妹妹林汐唯一的联系人。她的声音很轻，句号一样收尾，然后把手电筒塞进我手里，自己贴向了阴影。',
  '沈枢在码头办公室装睡。我们从他抽屉里翻出一张灰鸽组织的调运单，货物品类一栏只写了两个字：潮声。',
  '白鸮的人先一步烧了码头办公室。火里沈枢只抢救出那只铁皮盒，盒里是半枚青铜钥匙的模具。',
  '林霜把两半青铜钥匙模具对在一起，齿轮咬合，指向旧港区最深处的潜水钟塔。她说：下去的人，都没上来。',
  '潜水钟塔的缆绳是新的。这说明七天后还有人来过这里。灰鸽组织比我们快了整整一步。',
  '塔底的水面上浮着一盏气死风灯。灯下栓着一只木箱，箱面用白漆写着"林汐"两个字的拼音。',
  '林霜当场红了眼，但没哭。她用青铜钥匙撬开木箱，里面只有一件湿透的校服和一张合影。',
  '合影背面写着：灰鸽不养活口。沈枢看到这行字时，手抖得点不着烟。',
  '我们决定分头行动。林霜去追沈枢的口供，我留守钟塔等下一次大潮。临分别她把青铜钥匙交给我保管。',
  '大潮在凌晨两点到来。水下古城的钟声透过水面传上来，旧港区的铁链全部同时绷紧。',
  '灰鸽组织的主力出现在钟塔门口，带头的女人戴着白鸮面具。她认识林霜，喊她"汐的姐姐"。',
  '我按林霜教的，把青铜钥匙插进钟塔底座的锁孔。整座旧港区的灯在同一秒熄灭，只剩古城方向一点青光。',
  '青光里浮出一艘没有舷号的货船。白鸮面具女人登船前留下一句话：林汐还在海底，你们迟了十四年。',
  '林霜赶回来时只看到远去的船灯。她沉默了很久，说：十四年前被带走的人里，也有我。',
  '沈枢在警局做完笔录后失踪。只留下一张字条：灰鸽的调运单是假的白鸮是真的钥匙在塔底。',
  '我们把青铜钥匙重新插回塔底锁孔。古城方向传来一声钟鸣，像是应答，也像是倒计时。',
];

const PLAYER_ACTIONS = [
  '我推开门，把船票拍在桌上', '我压低声音跟在她身后摸进仓库', '我示意她别轻举妄动',
  '我翻开那本航海日志', '我追问林汐的下落', '我假扮稽查员敲开了办公室的门',
  '我拉着她绕到火场侧面', '我检查了潜水钟塔的锁孔', '我数了数缆绳的磨损痕迹',
  '我打捞起那盏气死风灯', '我拦住想立刻开箱的林霜', '我把字条拿给沈枢看',
  '我答应分头行动', '我盯着水面等潮位', '我抄起铁管挡在门口',
  '我按照她教的转动钥匙', '我记下了货船的舷侧特征', '我追上林霜按住她的肩',
  '我把字条折好收进内袋', '我把钥匙插回锁孔',
];

const NOUNS = ['灰鸽组织', '青铜钥匙', '沈枢', '白鸮', '水下古城', '林汐'];

const SESSION_ID = `test-memory-${Date.now()}`;
const LONG_SESSION_ID = `test-memory-long-${Date.now()}`;

/* ------------------------------------------------------------------ */
/* 迷你测试运行器                                                      */
/* ------------------------------------------------------------------ */

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
    process.exitCode = 1;
  }
}

function cleanup() {
  try { getDb().close(); } catch { /* 忽略 */ }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* 忽略 */ }
  }
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`\n[memory] DB = ${path.resolve(ROOT, DB_PATH)}`);

  /* ---------- 造数据：1 个 session + 20 轮 ---------- */
  await test('建会话并写入 20 轮剧情 / 实体 / 事实 / 状态', () => {
    createSession({ id: SESSION_ID, title: '记忆系统测试', settings: SETTINGS });
    for (let i = 1; i <= 20; i++) {
      addTurn(SESSION_ID, {
        turn_no: i, kind: 'player',
        content: `第${i}轮，${PLAYER_ACTIONS[i - 1]}，同时留意${NOUNS[i % NOUNS.length]}的动静。`,
      });
      addTurn(SESSION_ID, {
        turn_no: i, kind: 'narrator',
        content: ROUNDS[i - 1] + `（第${i}轮演出）`,
      });
      // L1 轮摘要（供检索与压缩使用）
      addSummary(SESSION_ID, {
        level: 1, turnFrom: i, turnTo: i,
        content: `第${i}轮摘要：${ROUNDS[i - 1].slice(0, 60)}`,
      });
      if (i % 4 === 0) {
        upsertEntity(SESSION_ID, {
          type: 'character', name: '林霜', summary: '冷静敏锐的追踪者，在寻找妹妹林汐，持有青铜钥匙。',
          attributes: { mood: '警惕', status: '受伤' }, first_turn: 1, last_turn: i, importance: 0.95,
        });
        upsertEntity(SESSION_ID, {
          type: 'faction', name: '灰鸽组织', summary: '暗处清点古城货箱的神秘组织，与白鸮面具人有关。',
          first_turn: 1, last_turn: i, importance: 0.9,
        });
        upsertEntity(SESSION_ID, {
          type: 'item', name: '青铜钥匙', summary: '能打开旧港区潜水钟塔底座与木箱的青铜钥匙，现由玩家保管。',
          first_turn: 2, last_turn: i, importance: 0.85,
        });
      }
      if (i % 5 === 0) addFact(SESSION_ID, { subject: '林霜', predicate: '敌对', object: '灰鸽组织', turn_no: i, confidence: 0.95 });
      if (i % 5 === 0) addFact(SESSION_ID, { subject: '林霜', predicate: '拥有', object: '青铜钥匙', turn_no: i, confidence: 0.9 });
      if (i % 5 === 0) {
        setState(SESSION_ID, i, {
          time: `第${i}日·暴雨`, location: '临江旧港区', tension: Math.min(0.95, 0.3 + i * 0.03),
          characters: { 林霜: { mood: '警惕', location: '潜水钟塔', status: '受伤' } },
          inventory: ['青铜钥匙', '半张船票', '湿透的校服'],
          quests: [{ goal: '查明林汐失踪案', progress: '锁定灰鸽组织', status: 'active' }],
          threads: ['白鸮面具女人的真实身份', '十四年前的旧案'],
          last_hook: '古城方向传来一声钟鸣',
        });
      }
    }
    const turns = store.getTurns(SESSION_ID, {});
    assert.equal(turns.length, 40, '应有 40 条 turn 行');
    assert.equal(getEntities(SESSION_ID, { limit: 100 }).length, 3);
    assert.ok(getFacts(SESSION_ID, { limit: 100 }).length >= 2);
    assert.ok(getState(SESSION_ID), '应有 state');
  });

  /* ---------- retriever ---------- */
  await test('retriever：中文分词（bigram + 单字 + ASCII 小写）', () => {
    assert.ok(tokenize('林霜, 青铜!Key-42').includes('林霜'));
    assert.ok(tokenize('林霜, 青铜!Key-42').includes('林'));
    assert.ok(tokenize('林霜, 青铜!Key-42').includes('霜'));
    assert.ok(tokenize('林霜, 青铜!Key-42').includes('青铜'));
    assert.ok(tokenize('林霜, 青铜!Key-42').includes('key'));
    assert.ok(tokenize('林霜, 青铜!Key-42').includes('42'));
    assert.ok(!tokenize('林霜, 青铜!Key-42').includes('，'));
    assert.deepEqual(tokenize('   '), []);
  });

  await test('retriever：search("林霜 钥匙") 命中含这些词的 turn/summary', () => {
    const r = new MemoryRetriever(SESSION_ID);
    const hits = r.search('林霜 钥匙', { topK: 6 });
    assert.ok(hits.length > 0, '应有命中');
    assert.ok(hits.length <= 6, '不超过 topK');
    for (const h of hits) {
      assert.ok(['turn', 'summary', 'entity'].includes(h.kind));
      assert.equal(typeof h.ref, 'number');
      assert.ok(h.score > 0);
      assert.equal(typeof h.snippet, 'string');
      assert.equal(typeof h.turn_no, 'number');
    }
    // 分数降序
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
    const hit = hits.find(h => h.snippet.includes('林霜') || h.snippet.includes('钥匙') || h.snippet.includes('青铜'));
    assert.ok(hit, '命中文档应包含林霜/钥匙相关文本');
    assert.ok(hits.some(h => h.kind === 'turn' || h.kind === 'summary' || h.kind === 'entity'));
  });

  await test('retriever：实体名精确命中加权（"林霜" 首位命中其档案）', () => {
    const r = new MemoryRetriever(SESSION_ID);
    const hits = r.search('林霜', { topK: 3 });
    assert.ok(hits.length > 0);
    assert.ok(hits[0].snippet.includes('林霜'), `首位命中应含林霜，实际：${hits[0].snippet.slice(0, 40)}`);
  });

  await test('retriever：空 query 返回空数组', () => {
    const r = new MemoryRetriever(SESSION_ID);
    assert.deepEqual(r.search('', { topK: 6 }), []);
    assert.deepEqual(r.search('   ', { topK: 6 }), []);
    assert.deepEqual(r.search(null), []);
  });

  await test('retriever：addTurn 后 invalidate 生效（也能靠版本号自动重建）', () => {
    const r = new MemoryRetriever(SESSION_ID);
    assert.equal(r.search('玄铁令牌').length, 0, '初始不应命中');
    // 1) 显式 invalidate 路径
    addTurn(SESSION_ID, { turn_no: 21, kind: 'narrator', content: '第21轮：潜水钟塔底座的夹层里插着一枚玄铁令牌，令牌背面刻着白鸮的纹章。' });
    r.invalidate();
    const after = r.search('玄铁令牌');
    assert.ok(after.length > 0 && after[0].snippet.includes('玄铁令牌'), 'invalidate 后应命中新 turn');
    // 2) 版本号自动重建路径（不调用 invalidate）
    addTurn(SESSION_ID, { turn_no: 22, kind: 'narrator', content: '第22轮：鹤纹匕首躺在玄铁令牌旁边，刃上还挂着海草。' });
    const auto = r.search('鹤纹匕首');
    assert.ok(auto.length > 0 && auto[0].snippet.includes('鹤纹匕首'), '版本号变化应触发自动重建');
    // 清理这两条测试 turn，避免影响后续断言
    store.getDb().prepare(`DELETE FROM turns WHERE session_id=? AND turn_no IN (21,22)`).run(SESSION_ID);
    r.invalidate();
    assert.equal(r.search('玄铁令牌').length, 0, '删除后应重新索引');
  });

  /* ---------- assembler ---------- */
  await test('assembler：messages 非空、预算 ≤ 200000、含 state 与 recent', async () => {
    const playerText = '我推开B仓的铁门，示意林霜跟上';
    addTurn(SESSION_ID, { turn_no: 21, kind: 'player', content: playerText });
    const session = getSession(SESSION_ID);
    const ctx = await assembleContext({ session, turnNo: 21, playerText, images: null, branchChoice: null });

    assert.ok(ctx.messages.length > 0, 'messages 不应为空');
    assert.equal(ctx.messages[0].role, 'system', '首条应为 system');
    assert.ok(ctx.messages.some(m => m.role === 'user' && String(m.content).includes('【当前剧情状态】')), '应包含 state 层');
    assert.ok(ctx.messages.some(m => m.role === 'assistant'), '应包含 recent narrator 消息');
    assert.ok(ctx.messages.some(m => m.role === 'user' && String(m.content).includes('【剧情记忆摘要】')), '应包含摘要层');
    assert.ok(ctx.messages.some(m => m.role === 'user' && String(m.content).includes('【关键实体与事实档案】')), '应包含实体层');
    assert.ok(ctx.messages.some(m => m.role === 'user' && String(m.content).includes('【检索到的历史细节】')), '应包含检索层');

    // 预算
    for (const k of ['system', 'bible', 'state', 'summaries', 'entities', 'retrieval', 'recent', 'current', 'total']) {
      assert.equal(typeof ctx.budget[k], 'number', `budget.${k} 应为数字`);
    }
    assert.ok(ctx.budget.total <= 200000, `budget.total=${ctx.budget.total} 应 ≤ 200000`);
    assert.equal(ctx.budget.total, estimateMessagesTokens(ctx.messages), 'budget.total 应与实际一致');
    assert.ok(ctx.budget.total > 0);

    // 返回值
    assert.ok(ctx.retriever instanceof MemoryRetriever);
    assert.ok(ctx.state && typeof ctx.state === 'object', 'state 应为对象');
    assert.ok(Array.isArray(ctx.recentTurns) && ctx.recentTurns.length > 0);
    assert.ok(Array.isArray(ctx.retrievalSnippets) && ctx.retrievalSnippets.length > 0, '应检索到历史细节');

    // 本轮玩家消息不应在 recent 层重复出现
    assert.ok(ctx.recentTurns.every(t => t.turn_no < 21), 'recent 不应包含本轮');
    const currentMsg = ctx.messages[ctx.messages.length - 1];
    assert.equal(currentMsg.role, 'user');
    assert.equal(currentMsg.content, playerText, '最后一条应是本轮玩家输入');

    // 摘要格式检查
    const summaryMsg = ctx.messages.find(m => String(m.content).includes('【剧情记忆摘要】'));
    assert.ok(/\[第\d+-\d+轮\]/.test(summaryMsg.content), '摘要应为 [第X-Y轮] 格式');
    // 实体格式检查
    const entityMsg = ctx.messages.find(m => String(m.content).includes('【关键实体与事实档案】'));
    assert.ok(entityMsg.content.includes('林霜'), '实体层应含林霜');
    assert.ok(entityMsg.content.includes('青铜钥匙'), '实体层应含青铜钥匙');
    assert.ok(/林霜 - 敌对 - 灰鸽组织/.test(entityMsg.content), '事实应为 主体-谓词-客体 格式');
    // 系统提示词可独立复用
    assert.ok(buildNarratorSystemPrompt(session).includes('你是剧情演绎引擎'));
  });

  await test('assembler：branchChoice + images → multipart 当前消息', async () => {
    const session = getSession(SESSION_ID);
    const ctx = await assembleContext({
      session, turnNo: 21, playerText: '我侧身闪进雨里',
      images: ['data:image/png;base64,AAAA', { url: 'https://example.com/a.png' }],
      branchChoice: { id: 'b1', title: '硬闯', description: '直接突破钟塔大门', tone: '激进', tension_delta: 0.15 },
    });
    const current = ctx.messages[ctx.messages.length - 1];
    assert.equal(current.role, 'user');
    assert.ok(Array.isArray(current.content), '带图时应为 multipart');
    const text = current.content.find(p => p.type === 'text');
    assert.ok(text.text.includes('【玩家选择的剧情分支】硬闯'), '应包含分支标题');
    assert.ok(text.text.includes('直接突破钟塔大门'), '应包含分支描述');
    assert.ok(text.text.includes('【玩家行动】我侧身闪进雨里'), '应包含玩家行动');
    const imgs = current.content.filter(p => p.type === 'image_url');
    assert.equal(imgs.length, 2, '应有两张图');
    assert.equal(imgs[0].image_url.url, 'data:image/png;base64,AAAA');
    assert.equal(imgs[1].image_url.url, 'https://example.com/a.png');
    assert.ok(ctx.budget.total <= 200000);
  });

  await test('assembler：极小 context_max_tokens 时仍满足硬上限', async () => {
    const sid = LONG_SESSION_ID;
    const longSettings = { ...SETTINGS, context_max_tokens: 12000 };
    createSession({ id: sid, title: '预算压测', settings: longSettings });
    const filler = '暴雨砸在潜水钟塔的铁皮顶上，林霜握着青铜钥匙站在阴影里，灰鸽组织的探照灯扫过水面，水下古城的钟声一声声传上来。'.repeat(60);
    for (let i = 1; i <= 4; i++) {
      addTurn(sid, { turn_no: i, kind: 'player', content: `第${i}轮行动：我握紧青铜钥匙准备下塔。` + filler });
      addTurn(sid, { turn_no: i, kind: 'narrator', content: filler });
      addSummary(sid, { level: 1, turnFrom: i, turnTo: i, content: `第${i}轮摘要：${filler.slice(0, 200)}` });
    }
    setState(sid, 4, { time: '第四日·暴雨', location: '潜水钟塔', tension: 0.9, threads: ['白鸮面具'] });
    upsertEntity(sid, { type: 'item', name: '青铜钥匙', summary: filler.slice(0, 100), first_turn: 1, last_turn: 4, importance: 0.9 });
    addFact(sid, { subject: '林霜', predicate: '持有', object: '青铜钥匙', turn_no: 4 });

    const session = getSession(sid);
    const ctx = await assembleContext({ session, turnNo: 5, playerText: '我转动钥匙。' });
    assert.ok(ctx.budget.total <= 12000, `budget.total=${ctx.budget.total} 应 ≤ 12000`);
    assert.ok(ctx.messages.length >= 2, '至少应保留 system 与 current');
    assert.equal(ctx.messages[0].role, 'system');
    assert.equal(ctx.messages[ctx.messages.length - 1].role, 'user');
  });

  /* ---------- compressor ---------- */
  await test('compressor：非 arcEvery 倍数 / L1 不齐 → 空结果且不调 LLM', async () => {
    const r3 = await checkCompression(SESSION_ID, 3);
    assert.deepEqual(r3.created, []);
    assert.equal(r3.archived, 0);
    assert.equal(r3.error, undefined);
    const r25 = await checkCompression(SESSION_ID, 25);   // 21-25 的 L1 不存在
    assert.deepEqual(r25.created, []);
    assert.equal(r25.archived, 0);
  });

  await test('compressor：turnNo=5 的 L1→L2（需真实 LLM，不可用则 SKIP）', async () => {
    const l2Before = getSummaries(SESSION_ID, { level: 2, archived: null }).length;
    if (!config.upstream.apiKey) {
      console.log('      [SKIP] 未配置 STEPFUN_API_KEY，跳过真实 LLM 压缩');
      return;
    }
    let r;
    try {
      r = await checkCompression(SESSION_ID, 5);
    } catch (err) {
      throw new Error(`checkCompression 抛出异常（契约要求绝不抛出）：${err?.message || err}`);
    }
    if (!r.created.length) {
      console.log(`      [SKIP] LLM 不可用或压缩失败：${r.error || 'unknown'}`);
      return;
    }
    assert.equal(r.created[0].level, 2);
    assert.equal(r.created[0].turn_from, 1);
    assert.equal(r.created[0].turn_to, 5);
    assert.ok(r.archived >= 5, '应归档 5 条 L1');
    assert.equal(getSummaries(SESSION_ID, { level: 2, archived: null }).length, l2Before + 1);

    // 幂等：同一 turnNo 重复调用不得产生重复 L2
    const r2 = await checkCompression(SESSION_ID, 5);
    assert.equal(r2.created.filter(c => c.level === 2).length, 0, '重复调用不应再产生 L2');
    assert.equal(getSummaries(SESSION_ID, { level: 2, archived: null }).length, l2Before + 1);
  });

  await test('compressor：已有覆盖该范围的 L2 → 幂等跳过（不调 LLM）', async () => {
    const sid = `test-memory-idem-${Date.now()}`;
    createSession({ id: sid, title: '幂等测试', settings: SETTINGS });
    for (let i = 1; i <= 5; i++) {
      addTurn(sid, { turn_no: i, kind: 'narrator', content: ROUNDS[i - 1] });
      addSummary(sid, { level: 1, turnFrom: i, turnTo: i, content: `第${i}轮摘要：${ROUNDS[i - 1].slice(0, 40)}` });
    }
    // 预置一条已覆盖 [1,5] 的 L2，模拟此前已压缩过
    addSummary(sid, { level: 2, turnFrom: 1, turnTo: 5, content: '既有 L2 摘要（预置）' });
    const r = await checkCompression(sid, 5);
    assert.deepEqual(r.created, [], '已覆盖时不应再压缩');
    assert.equal(r.archived, 0);
    assert.equal(r.error, undefined, '不应触达 LLM（无 error 即未调用失败）');
    assert.equal(getSummaries(sid, { level: 2, archived: null }).length, 1, 'L2 数量应仍为 1');
    assert.equal(getSummaries(sid, { level: 1, archived: 0 }).length, 5, 'L1 不应被归档');
    store.deleteSession(sid);
  });

  await test('compressor：L2→L3 / L3→L4 已有覆盖 → 幂等跳过（不调 LLM）', async () => {
    const sid = `test-memory-idem2-${Date.now()}`;
    createSession({ id: sid, title: '幂等测试2', settings: SETTINGS });
    // 5 条连续 L2：1-5, 6-10, 11-15, 16-20, 21-25
    for (let k = 0; k < 5; k++) {
      addSummary(sid, { level: 2, turnFrom: k * 5 + 1, turnTo: k * 5 + 5, content: `L2-${k + 1}（预置）` });
    }
    // 5 条连续 L3：1-25, 26-50, 51-75, 76-100, 101-125
    for (let k = 0; k < 5; k++) {
      addSummary(sid, { level: 3, turnFrom: k * 25 + 1, turnTo: k * 25 + 25, content: `L3-${k + 1}（预置）` });
    }
    // 预置已覆盖 [1,25] 的 L3 与 [1,125] 的 L4
    addSummary(sid, { level: 3, turnFrom: 1, turnTo: 25, content: '既有 L3 摘要（预置）' });
    addSummary(sid, { level: 4, turnFrom: 1, turnTo: 125, content: '既有 L4 摘要（预置）' });

    const r = await checkCompression(sid, 25);
    assert.deepEqual(r.created, [], 'L2→L3 / L3→L4 已覆盖时不应再压缩');
    assert.equal(r.archived, 0);
    assert.equal(r.error, undefined, '不应触达 LLM');
    assert.equal(getSummaries(sid, { level: 3, archived: null }).length, 6, 'L3 数量应仍为 6');
    assert.equal(getSummaries(sid, { level: 4, archived: null }).length, 1, 'L4 数量应仍为 1');
    assert.equal(getSummaries(sid, { level: 2, archived: 0 }).length, 5, 'L2 不应被归档');
    store.deleteSession(sid);
  });

  /* ---------- 汇总 ---------- */
  const failed = results.filter(([ok]) => !ok);
  console.log(`\n[memory] ${results.length - failed.length}/${results.length} 通过`);
  cleanup();
  if (failed.length) {
    console.error(`[memory] ${failed.length} 个测试失败`);
    process.exit(1);
  }
  console.log('ALL MEMORY TESTS PASSED');
}

main().catch(err => {
  console.error('[memory] 运行器异常：', err);
  cleanup();
  process.exit(1);
});
