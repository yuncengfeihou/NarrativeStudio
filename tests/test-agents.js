/**
 * 旁路 Agent 端到端：runArchivist / runContinuity / runWorldTick / runRetrieval。
 *
 * 为什么单独一套：这四个模块的**纯函数**（parseArchivistUpdateStrict / applyArchivistUpdate /
 * applyContinuityFixes / pickOffstagePersons / parseRetrievalRequest）早已被各套件覆盖，
 * 但从没测过「真发一次模型调用 → 拿到形状不对的回复 → 回灌重问 / guard / 降级」这一段。
 * 接口一改（字段改名、回灌丢了、guard 忘了接、异常被吞成空提案）纯函数测试全绿，
 * 线上却是坏的——D34 的「空过」就是这么漏掉的。
 *
 * 用进程内假上游驱动真实的 Agent 函数：不起服务、不占端口，只换 globalThis.fetch
 * （llm.js 的 chat / chatStream 都走全局 fetch）。分派键只有协议字段
 * （body.model / body.stream），不读提示词首行——提示词一改就会假红。
 */
import './load-env.js';
import os from 'node:os';
import path from 'node:path';

// DB_PATH 必须在 import store 之前设置：store 在第一次 getDb() 时读 config。
process.env.DB_PATH = path.join(os.tmpdir(), `narra-agents-${Date.now()}.db`);

// 每个 Agent 绑不同的上游模型名。假上游按 body.model 分派——这是协议字段，
// 也是唯一能让「哪个 Agent 被调了几次」在测试里可数、且不依赖调用顺序的办法。
process.env.NARRATOR_MODEL = 'fake-narrator';
process.env.ARCHIVIST_MODEL = 'fake-archivist';
process.env.SCENE_KEEPER_MODEL = 'fake-scene-keeper';
process.env.CONTINUITY_MODEL = 'fake-continuity';
process.env.WORLD_TICK_MODEL = 'fake-world-tick';
process.env.RETRIEVAL_MODEL = 'fake-retrieval';
process.env.BRANCH_MODEL = 'fake-branch';
process.env.LIBRARIAN_MODEL = 'fake-librarian';
process.env.CARD_SMITH_MODEL = 'fake-card-smith';
// 管线接线那一块要把节奏拧到最短：2 轮一次校勘、每 2 轮强制封场、最小场长 1。
process.env.CONTINUITY_EVERY = '2';
process.env.SCENE_EVERY = '2';
process.env.MIN_SCENE_TURNS = '1';

const schema = await import('../server/world/schema.js');
const store = await import('../server/memory/store.js');
const pipe = await import('../server/agents/memory-pipeline.js');
const { runArchivist, buildDeclaredTargets } = await import('../server/agents/archivist.js');
const { runRetrieval, shouldPrecheckRetrieval } = await import('../server/agents/retrieval.js');
const orch = await import('../server/agents/orchestrator.js');

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
/* 假上游                                                                  */
/* ══════════════════════════════════════════════════════════════════════ */

const encoder = new TextEncoder();
function streamReply(reasoning, content) {
  const frames = [];
  if (reasoning) frames.push({ choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] });
  if (content) frames.push({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  frames.push({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  });
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`,
        ));
        controller.close();
      },
    }),
    text: async () => '',
  };
}

function jsonReply(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
    text: async () => '',
  };
}

function errorReply(status, message) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message } }),
    text: async () => JSON.stringify({ error: { message } }),
  };
}

/**
 * 装一个按 body.model 分派的假上游。
 * handlers[model] 可以是字符串（回复内容）或 `(body, nthCallOfThisModel) => 字符串 | {content} | {error}`。
 * 返回 `{ calls, count(model), restore() }`——每个用例都必须 finally restore。
 */
function install(handlers) {
  const realFetch = globalThis.fetch;
  const calls = [];
  const perModel = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body || '{}');
    const model = String(body.model || 'unknown');
    const nth = (perModel.get(model) || 0) + 1;
    perModel.set(model, nth);
    calls.push({ model, nth, body });
    const h = handlers[model];
    const out = typeof h === 'function' ? h(body, nth) : h;
    if (out == null) return jsonReply('');
    if (typeof out === 'object' && out.error) return errorReply(out.error, out.message || 'boom');
    const content = typeof out === 'string' ? out : String(out.content ?? '');
    const reasoning = typeof out === 'string' ? '' : String(out.reasoning ?? '');
    return body.stream ? streamReply(reasoning, content) : jsonReply(content);
  };
  return {
    calls,
    count: (model) => perModel.get(model) || 0,
    restore() { globalThis.fetch = realFetch; },
  };
}

async function using(handlers, fn) {
  const fake = install(handlers);
  try { return await fn(fake); } finally { fake.restore(); }
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 夹具                                                                    */
/* ══════════════════════════════════════════════════════════════════════ */

const BASE_CARD = {
  title: '旁路 Agent 端到端',
  player: { name: '伍卿' },
  entities: [
    {
      id: 'ling-yue', name: '凌玥', type: 'person', role: '旧识',
      psyche: { wants: ['找回玉佩'], hides: ['她已许人'] }, weight: 0.9,
    },
    { id: 'wu-qing', name: '伍卿', type: 'person' },
    { id: 'yu-pei', name: '无纹玉佩', type: 'item', summary: '贴身收藏的白玉，纹路全无' },
  ],
  anchors: [{ id: 'p0', label: '序章', snapshot: { time: '初冬 · 午后', place: '茶楼' } }],
};

let seq = 0;
function newSession(label) {
  const card = schema.normalizeCard({ ...BASE_CARD, title: label });
  const worldId = `w-ag-${++seq}-${Date.now()}`;
  store.saveWorld({ id: worldId, title: label, card });
  const created = orch.createSessionWithSettings({ title: label, worldId });
  const session = store.getSession(created.id);
  return { card, world: { card }, session };
}

/** 给会话塞一拍原文：校勘只处理「最近 N 轮原文」，没有原文它直接返回不调用模型。 */
function seedTurn(sessionId, turnNo, narr = '他把玉佩搁在桌上。') {
  store.addTurn(sessionId, { turn_no: turnNo, kind: 'player', content: '我推门进去。', branch_id: 'main' });
  store.addTurn(sessionId, { turn_no: turnNo, kind: 'narrator', content: narr, branch_id: 'main' });
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 1. runArchivist：解析回灌 / 落库 / 目标声明 / guard ===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const OK_UPDATE = {
    scene_change: { changed: false },
    assertions: [{ subject: '凌玥', predicate: '知道', object: '玉佩在伍卿手上', confidence: 0.9 }],
    states: [{ who: '伍卿', field: 'condition', value: '湿透' }],
    quotes: [{ who: '凌玥', text: '「卿儿，过来。」' }],
  };
  const call = (ctx, extra = {}) => runArchivist({
    session: ctx.session, world: ctx.world, turnNo: 1,
    playerText: '我推门进去。', narrative: '他把玉佩搁在桌上。', ...extra,
  });

  // ① 正常一枪过：一次调用就落库，不应触发回灌。
  {
    const ctx = newSession('史官正常');
    const r = await using({ 'fake-archivist': JSON.stringify(OK_UPDATE) },
      (fake) => call(ctx).then((x) => ({ ...x, calls: fake.count('fake-archivist') })));
    eq(r.calls, 1, '一次就解析成功（不需要回灌）');
    eq(r.applied.assertions, 1, '断言落库 1 条');
    eq(r.applied.states, 1, '人物状态落库 1 条');
    eq(r.parse_failed, undefined, '不需要回灌时没有 parse_failed');
    const rows = store.getAssertions(ctx.session.id, { branchId: 'main' });
    eq(rows.filter((x) => x.subject === '凌玥').length, 1, '断言真的写进了库');
  }

  // ② 首次回复不是 JSON → 回灌重问一次；第二次合法 → 照常落库，且不留 failed 提案。
  {
    const ctx = newSession('史官回灌');
    const r = await using({
      'fake-archivist': (body, nth) => (nth === 1 ? '好的，我记录如下：' : JSON.stringify(OK_UPDATE)),
    }, (fake) => call(ctx).then((x) => ({ ...x, calls: fake.count('fake-archivist') })));
    eq(r.calls, 2, '解析失败后回灌重问（共 2 次调用）');
    eq(r.parse_failed, undefined, '第二次解析成功，不算 parse_failed');
    eq(r.applied.assertions, 1, '重问之后照常落库');
    eq(store.listPatches(ctx.session.id, { branchId: 'main', kind: 'archivist_parse_failed' }).length,
      0, '没有留下 archivist_parse_failed');
  }

  // ③ 两次都不是 JSON → 记 failed 提案并返回全零，而不是静默当「本轮无变化」。
  {
    const ctx = newSession('史官两fail');
    const r = await using({ 'fake-archivist': '我不能输出 JSON。' }, (fake) => call(ctx).then((x) => ({ ...x, calls: fake.count('fake-archivist') })));
    eq(r.calls, 2, '回灌只重问一次（不做无限重试）');
    eq(r.parse_failed, true, '返回 parse_failed=true');
    eq(r.applied.assertions, 0, 'applied 全零');
    const failed = store.listPatches(ctx.session.id, { branchId: 'main', kind: 'archivist_parse_failed' });
    eq(failed.length, 1, '落 1 条 archivist_parse_failed（报告看得见「这一轮记忆没落」）');
    eq(failed[0].status, 'failed', '提案状态是 failed');
    eq(failed[0].payload?.retried, true, 'payload.retried=true 证明是重问过的');
  }

  // ④ guard 变假（调用期间分支被 rollback / rewrite）→ 整批丢弃，不写任何记忆。
  {
    const ctx = newSession('史官stale');
    const r = await using({ 'fake-archivist': JSON.stringify(OK_UPDATE) }, () => call(ctx, { guard: () => false }));
    eq(r.stale, true, '返回 stale=true');
    eq(r.applied.assertions, 0, 'stale 时不落库');
    eq(store.getAssertions(ctx.session.id, { branchId: 'main' }).length, 0, '库里 0 条断言');
    eq(store.listPatches(ctx.session.id, { branchId: 'main', kind: 'stale' }).length, 1,
       '落 1 条 stale 提案（并发 fork 的审计留痕）');
  }

  // ⑤ 目标声明生效：没声明过的 subject 必须被拒，并合并成一条 skipped_targets。
  {
    const ctx = newSession('史官声明');
    const declared = buildDeclaredTargets({
      card: schema.normalizeCard({ title: '只有主角', player: { name: '伍卿' }, entities: [{ id: 'wu-qing', name: '伍卿', type: 'person' }] }),
      playerName: '伍卿',
    });
    ok(!declared.includes('凌玥'), '前置：声明集合里没有凌玥');
    const r = await using({ 'fake-archivist': JSON.stringify(OK_UPDATE) }, () => call(ctx, { declaredTargets: declared }));
    eq(r.applied.assertions, 0, '未声明的断言被拒写');
    ok(r.applied.skipped >= 1, 'skipped 计数 > 0', `got ${r.applied.skipped}`);
    eq(store.listPatches(ctx.session.id, { branchId: 'main', kind: 'skipped_targets' }).length, 1,
       '合并成 1 条 skipped_targets（不是每条一条）');
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 2. runContinuity：无原文短路 / fix 分流 / 异常降级 / guard ===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // ① 没有最近原文就连模型都不该调——这是成本闸门，不是优化。
  {
    const ctx = newSession('校勘短路');
    const r = await using({ 'fake-continuity': '{"issues":[]}' }, (fake) => pipe.runContinuity({
      session: ctx.session, world: ctx.world, turnNo: 1,
    }).then((x) => ({ ...x, calls: fake.count('fake-continuity') })));
    eq(r.calls, 0, '无最近原文时不发模型调用');
    eq(r.issues, [], '返回空 issues');
  }

  // ② 合法 fix（set_state 人物::字段）→ 直接落库，applied 计数 +1。
  {
    const ctx = newSession('校勘fix');
    seedTurn(ctx.session.id, 1);
    const reply = JSON.stringify({
      issues: [{
        kind: 'contradiction', severity: 'major', subject: '凌玥',
        claim: '她上一拍说在城外，这一拍却在茶楼', evidence: '第1轮原文',
        fix: { action: 'set_state', target: '凌玥::mood', value: '强作镇定' },
      }],
      healthy: [],
    });
    const r = await using({ 'fake-continuity': reply }, () => pipe.runContinuity({
      session: ctx.session, world: ctx.world, turnNo: 1,
    }));
    eq(r.issues.length, 1, '解析出 1 条 issue');
    eq(r.applied, 1, '自动修 1 条');
    const st = store.getCharStateMap(ctx.session.id, { branchId: 'main' });
    eq(st['凌玥']?.mood, '强作镇定', '人物状态真的改了');
  }

  // ③ 形态填错的 fix → 拒写，留终态提案。旧实现会兜底成 [subject, 'condition']，
  //    报告显示「自动修复成功」。两种错形态的 reason 不同，因为修法不同：
  //    完全没有 `::`（整个「哪个人物的哪个字段」都漏了）vs 有 `::` 但字段空（`凌玥::`）。
  {
    const ctx = newSession('校勘坏形态');
    seedTurn(ctx.session.id, 1);
    const reply = JSON.stringify({
      issues: [
        {
          kind: 'contradiction', severity: 'major', subject: '凌玥',
          claim: '状态说法不一致', evidence: '第1轮原文',
          fix: { action: 'set_state', target: '凌玥', value: '强作镇定' },
        },
        {
          kind: 'contradiction', severity: 'minor', subject: '凌玥',
          claim: '字段漏了', evidence: '第1轮原文',
          fix: { action: 'set_state', target: '凌玥::', value: '强作镇定' },
        },
      ],
    });
    const r = await using({ 'fake-continuity': reply }, () => pipe.runContinuity({
      session: ctx.session, world: ctx.world, turnNo: 1,
    }));
    eq(r.applied, 0, '形态不对 → 一条都不自动落库');
    const rows = store.listPatches(ctx.session.id, { branchId: 'main', kind: 'contradiction' });
    eq(rows.length, 2, '两条都落成终态提案');
    eq(rows.every((p) => p.status === 'failed'), true, '状态都是 failed（不是 open：再等一拍也不会变可执行）');
    eq(rows.every((p) => p.payload?.fix_result?.state === 'unmatched'), true,
      'payload.fix_result.state=unmatched');
    eq(rows.every((p) => p.payload?.fix_result?.retryable === false), true,
      'payload.fix_result.retryable=false');
    ok(rows.some((p) => p.payload?.fix_result?.reason === 'bad_target_form'),
      '字段空的 reason=bad_target_form（模型的错，改提示词能修）',
      JSON.stringify(rows.map((p) => p.payload?.fix_result?.reason)));
    eq(store.getCharStateMap(ctx.session.id, { branchId: 'main' })['凌玥']?.condition, undefined,
       '没有兜底写进 condition（静默失真的老路）');
  }

  // ④ 模型侧报错 → 降级返回 error，不抛（旁路 Agent 不能阻断回合）。
  {
    const ctx = newSession('校勘报错');
    seedTurn(ctx.session.id, 1);
    const r = await using({ 'fake-continuity': { error: 400, message: 'bad request' } }, () => pipe.runContinuity({
      session: ctx.session, world: ctx.world, turnNo: 1,
    }));
    ok(r && typeof r.error === 'string' && r.error.length > 0, '返回 error 字符串而不是抛异常');
    eq(r.issues, [], '降级后 issues 为空');
  }

  // ⑤ guard 变假 → 不落库（并发 fork 期间）。
  {
    const ctx = newSession('校勘stale');
    seedTurn(ctx.session.id, 1);
    const reply = JSON.stringify({
      issues: [{
        kind: 'contradiction', severity: 'minor', subject: '凌玥', claim: 'x', evidence: 'e',
        fix: { action: 'set_state', target: '凌玥::mood', value: '平静' },
      }],
    });
    const r = await using({ 'fake-continuity': reply }, () => pipe.runContinuity({
      session: ctx.session, world: ctx.world, turnNo: 1, guard: () => false,
    }));
    eq(r.stale, true, '返回 stale=true');
    eq(r.applied, 0, 'stale 时不落库');
    eq(store.listPatches(ctx.session.id, { branchId: 'main', kind: 'contradiction' }).length, 0,
       '库里没有提案');
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 3. runWorldTick：候选闸门 / 事件归一 / patch 形状 / guard ===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // ① 有幕外候选：发一次调用，事件归一后写成 offstage_event 提案。
  //    注意 status 由 visibility 决定——hidden 才算 applied，其余是 open（等场记单渲染压力）。
  {
    const ctx = newSession('呼吸正常');
    const reply = JSON.stringify({
      events: [
        { who: ['凌玥'], what: '她在灯下等他回话', visibility: 'rumor', affects: ['伍卿'], pressure: 0.6 },
        { who: ['凌玥'], what: '她烧掉了旧信', visibility: 'hidden', pressure: 2 },
      ],
    });
    const r = await using({ 'fake-world-tick': reply }, (fake) => pipe.runWorldTick({
      session: ctx.session, world: ctx.world, turnNo: 3,
    }).then((x) => ({ ...x, calls: fake.count('fake-world-tick') })));
    eq(r.calls, 1, '有幕外候选时发 1 次调用');
    eq(r.events.length, 2, '解析出 2 条事件');
    eq(r.events[1].pressure, 1, 'pressure 夹在 0..1');
    const patches = store.listPatches(ctx.session.id, { branchId: 'main', kind: 'offstage_event' });
    eq(patches.length, 2, '每件事写 1 条 offstage_event');
    const rumor = patches.find((p) => p.payload?.visibility === 'rumor');
    const hidden = patches.find((p) => p.payload?.visibility === 'hidden');
    eq(rumor?.status, 'open', 'rumor 是 open（等场记单渲染成压力）');
    eq(hidden?.status, 'applied', 'hidden 是 applied（玩家不可见，直接当事实）');
    ok(String(hidden?.evidence || '').includes('第 3 轮'), 'evidence 带轮次（报告能定位）');
  }

  // ② 幕外候选为空 → 一次都不调（世界呼吸是最贵的一次调用之一）。
  {
    const ctx = newSession('呼吸空转');
    // 只有主角在场：主角不是 person 实体、也不进候选池。
    const card = schema.normalizeCard({
      title: '只有主角', player: { name: '伍卿' },
      entities: [{ id: 'wu-qing', name: '伍卿', type: 'person' }],
    });
    const r = await using({ 'fake-world-tick': '{"events":[{"what":"不该被调用"}]}' }, (fake) => pipe.runWorldTick({
      session: ctx.session, world: { card }, turnNo: 2,
    }).then((x) => ({ ...x, calls: fake.count('fake-world-tick') })));
    eq(r.calls, 0, '没有幕外候选时 0 次调用');
    eq(r.events, [], 'events 为空');
  }

  // ③ guard 变假 → 事件不落 patch。
  {
    const ctx = newSession('呼吸stale');
    const reply = JSON.stringify({ events: [{ who: ['凌玥'], what: '她出门去了', visibility: 'rumor' }] });
    const r = await using({ 'fake-world-tick': reply }, () => pipe.runWorldTick({
      session: ctx.session, world: ctx.world, turnNo: 4, guard: () => false,
    }));
    eq(r.stale, true, '返回 stale=true');
    eq(store.listPatches(ctx.session.id, { branchId: 'main', kind: 'offstage_event' }).length, 0,
      'stale 时不写 patch');
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 4. runRetrieval：查询词 / 空查询留痕 / 空卡短路 / 失败上抛 ===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // ① 模型给出辞书查询词 → 确定性检索命中 → 文本带固定前缀进 retrieval 子层。
  {
    const ctx = newSession('检索命中');
    const r = await using({ 'fake-retrieval': '{"codex":["玉佩"],"history":[]}' }, () => runRetrieval({
      card: ctx.card, playerText: '我想看看那枚玉佩。', sessionId: ctx.session.id, branchId: 'main', atTurn: 0,
    }));
    eq(r.queries, ['玉佩'], 'queries 记录模型给的查询词');
    eq(r.codex_queries, ['玉佩'], 'codex_queries 只有辞书通道');
    ok(r.entries.length >= 1, '辞书命中 1 条以上', `got ${r.entries.length}`);
    ok(r.text.startsWith('【设定集检索】'), '文本带固定前缀（装配层靠它归到 retrieval 层）');
    ok(r.text.includes('无纹玉佩'), '命中的是卡里那条设定原文');
  }

  // ② 模型这一拍决定不查：仍返回对象（留痕「触发了但没查」），不是 null。
  {
    const ctx = newSession('检索空转');
    const r = await using({ 'fake-retrieval': '{"codex":[],"history":[]}' }, () => runRetrieval({
      card: ctx.card, playerText: '我坐下喝茶。', sessionId: ctx.session.id, branchId: 'main',
    }));
    ok(r !== null, '空查询也返回对象');
    eq(r.queries, [], 'queries 为空');
    eq(r.text, '', 'text 为空');
    eq(r.tokens, { codex: 0, history: 0 }, 'tokens 全零');
  }

  // ③ 卡里没有任何实体 → 直接 null（不发调用）。
  {
    const r = await using({ 'fake-retrieval': '{"codex":["玉佩"]}' }, (fake) => runRetrieval({
      card: schema.normalizeCard({ title: '空卡', player: { name: '伍卿' } }),
      playerText: '随便看看。',
    }).then((x) => ({ x, calls: fake.count('fake-retrieval') })));
    eq(r.calls, 0, '空卡不发调用');
    eq(r.x, null, '返回 null');
  }

  // ④ 模型侧报错：runRetrieval 不吞错——降级由 orchestrator 的 try/catch 负责。
  //    这条是契约断言：若哪天 Agent 自己吞掉，orchestrator 的告警就永远不触发。
  {
    const ctx = newSession('检索报错');
    let threw = false;
    await using({ 'fake-retrieval': { error: 400, message: 'bad request' } }, async () => {
      try {
        await runRetrieval({ card: ctx.card, playerText: '查玉佩。' });
      } catch { threw = true; }
    });
    eq(threw, true, 'LLM 失败向上抛（由 orchestrator 降级，不在 Agent 内静默吞掉）');
  }

  // ⑤ 预检闸门：off 永不用；on 永远用；auto 只看实体链接与辞书条数。
  {
    const ctx = newSession('预检');
    eq(shouldPrecheckRetrieval({ mode: 'off', card: ctx.card, playerText: '凌玥在哪？' }), false,
       "mode=off 一律不预检");
    eq(shouldPrecheckRetrieval({ mode: 'on', card: ctx.card, playerText: '我坐下。' }), true,
       'mode=on 一律预检');
    eq(shouldPrecheckRetrieval({ mode: 'auto', card: ctx.card, playerText: '我问问凌玥。', minCodex: 24 }), true,
       'auto + 点名人物 → 预检');
    // 设定集条目只认卡上的完整名/别名（箭头 → 不做同义词映射，红线 2）：
    // 「玉佩」是「无纹玉佩」的后缀，不算命中；写全名才算。
    eq(shouldPrecheckRetrieval({ mode: 'auto', card: ctx.card, playerText: '我看看那枚玉佩。', minCodex: 0 }), false,
       'auto + 只写条目名后缀 → 不算命中（不做同义词映射）');
    eq(shouldPrecheckRetrieval({ mode: 'auto', card: ctx.card, playerText: '我看看那枚无纹玉佩。', minCodex: 0 }), true,
       'auto + 点名设定集条目全名 → 预检');
    eq(shouldPrecheckRetrieval({ mode: 'auto', card: ctx.card, playerText: '我坐下喝茶。', minCodex: 24 }), false,
       'auto + 无点名且小卡 → 不预检');
    // 没给 card 时退回「辞书条数」这一条腿（旧调用方的路径）。
    eq(shouldPrecheckRetrieval({ mode: 'auto', card: null, codexCount: 30, minCodex: 24 }), true,
       'auto + 未提供卡 + 辞书条数达下限 → 预检');
    eq(shouldPrecheckRetrieval({ mode: 'auto', card: null, codexCount: 3, minCodex: 24 }), false,
       'auto + 未提供卡 + 辞书条数不足 → 不预检');
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 5. 管线接线：runTurn 真的按节奏调到了这四个 Agent ===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // 前面四块证明的是「函数本身对」，这一块证明「orchestrator 真的会调它、调几次」。
  // 分派仍按 body.model（协议字段），因此每个 Agent 的调用次数可直接从假上游数出来，
  // 不依赖调用顺序、不读提示词。
  //
  // 节奏被本文件顶部拧成：CONTINUITY_EVERY=2、SCENE_EVERY=2、MIN_SCENE_TURNS=1。
  // 于是 2 拍里应出现：史官 2 次、场记 2 次（第 1 拍无 prev → 判定切场，第 2 拍按轮数强制封场）、
  // 世界呼吸 2 次（每拍都有幕外候选）、校勘 1 次（只在第 2 拍）。
  const handlers = {
    'fake-narrator': () => ({ content: '他把玉佩搁在桌上，灯影一晃。' }),
    'fake-archivist': () => '{"scene_change":{"changed":false}}',
    'fake-scene-keeper': () => JSON.stringify({
      question: '他来做什么', outcome: '他说明了来意', key_detail: '玉佩摆在桌上',
      threads: [], hooks: [], life_changes: [],
    }),
    'fake-world-tick': () => JSON.stringify({
      events: [{ who: ['凌玥'], what: '她在灯下等他回话', visibility: 'rumor', pressure: 0.6 }],
    }),
    'fake-continuity': () => '{"issues":[],"healthy":[]}',
    'fake-retrieval': () => '{"codex":[],"history":[]}',
  };
  const ctx = newSession('管线接线');
  const events = [];
  await using(handlers, async (fake) => {
    for (const text of ['我向凌玥打听玉佩的来历。', '我把玉佩收进袖中，凌玥看着我没说话。']) {
      await orch.runTurn({
        sessionId: ctx.session.id, playerText: text, generateBranches: false,
        onEvent: (e) => events.push(e),
      });
    }
    eq(fake.count('fake-narrator'), 2, '旁白 2 拍各 1 次');
    eq(fake.count('fake-archivist'), 2, '史官每拍 1 次');
    eq(fake.count('fake-scene-keeper'), 2, '场记在切场拍各 1 次');
    eq(fake.count('fake-world-tick'), 2, '世界呼吸在切场拍各 1 次');
    eq(fake.count('fake-continuity'), 1, '校勘只在第 2 拍（CONTINUITY_EVERY=2）');
    eq(fake.count('fake-retrieval'), 2, '检索预检在点名人物的拍触发');
  });

  ok(events.some((e) => e.type === 'scene'), 'SSE 上有 scene 事件');
  ok(events.some((e) => e.type === 'world_tick'), 'SSE 上有 world_tick 事件');
  ok(events.some((e) => e.type === 'continuity'), 'SSE 上有 continuity 事件');
  const kinds = new Set(store.listPatches(ctx.session.id, { branchId: 'main', limit: 200 }).map((p) => p.kind));
  ok(kinds.has('scene'), 'patches 里有场记归档（kind=scene）');
  ok(kinds.has('offstage_event'), 'patches 里有幕后事件（kind=offstage_event）——报告靠它数呼吸产出');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 6. 世界呼吸的轮数节拍：切场之外也会跑（WORLD_TICK_EVERY）===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // 世界呼吸的触发有两路：切场（叙事结构变了）与每 N 轮（时间在流逝）。两路正交——
  // 只挂在切场上时，一个 12 拍的长场里世界完全静止。这块专门测**第二路**：
  // 关掉强制封场（SCENE_EVERY=0）、把节拍拧到 1 轮一次，跑 3 拍。场记只会在第 1 拍
  // （没有上一场）归档一次，但幕后推演必须每拍都有——否则就是「只挂切场」退回来了。
  const { config } = await import('../server/config.js');
  const prevEvery = config.context.worldTickEvery;
  const prevSceneEvery = config.context.sceneEvery;
  const handlers = {
    'fake-narrator': () => ({ content: '他把玉佩收进袖中，灯影一晃。' }),
    'fake-archivist': () => '{"scene_change":{"changed":false}}',
    'fake-scene-keeper': () => JSON.stringify({
      question: '他在等什么', outcome: '他把玉佩收了起来', key_detail: '玉佩贴身收着',
      threads: [], hooks: [], life_changes: [],
    }),
    'fake-world-tick': () => JSON.stringify({
      events: [{ who: ['凌玥'], what: '她独自在廊下站了很久', visibility: 'rumor', pressure: 0.5 }],
    }),
    'fake-continuity': () => '{"issues":[],"healthy":[]}',
    'fake-retrieval': () => '{"codex":[],"history":[]}',
  };
  const ctx = newSession('呼吸节拍');
  const events = [];
  config.context.worldTickEvery = 1;
  config.context.sceneEvery = 0;
  try {
    await using(handlers, async (fake) => {
      // 玩家文本不提任何人名：凌玥保持幕外，幕外候选恒非空（否则 runWorldTick 直接返回）。
      for (let i = 0; i < 3; i += 1) {
        await orch.runTurn({
          sessionId: ctx.session.id, playerText: '我把玉佩收进袖中。', generateBranches: false,
          onEvent: (e) => events.push(e),
        });
      }
      eq(fake.count('fake-world-tick'), 3, '节拍=1 时三拍都推演了世界呼吸');
      eq(fake.count('fake-scene-keeper'), 1, '场记只在第 1 拍归档（强制封场已关、地点时间没变）');
    });
  } finally {
    config.context.worldTickEvery = prevEvery;
    config.context.sceneEvery = prevSceneEvery;
  }
  const offstage = store.listPatches(ctx.session.id, { branchId: 'main', limit: 300 })
    .filter((p) => p.kind === 'offstage_event');
  ok(offstage.length > 0, '幕后事件落库（kind=offstage_event）');
  ok(
    offstage.some((p) => String(p.evidence || '').includes('第 3 轮')),
    '第 3 拍没有切场，也留下了幕后推演——证明轮数节拍真的接上了',
  );
  // 反证：节拍关掉时（0 = 只在切场），同长度的一局不会多出幕后推演。
  eq(config.context.worldTickEvery, prevEvery, '测试结束后节拍复位');
  eq(config.context.sceneEvery, prevSceneEvery, '测试结束后强制封场复位');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 7. 定点改稿的确定性部分（server/agents/rewrite.js）===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // 定位不进模型：区间与原文快照由前端给，服务端逐字核对；改完只做确定性 diff。
  const RW = await import('../server/agents/rewrite.js');

  // --- parseRewriteTarget：请求校验 ---
  eq(RW.parseRewriteTarget(null).target, null, '不传 target = 整拍重演（旧行为不变）');
  eq(RW.parseRewriteTarget(undefined).ok, true, 'undefined 也不报错');
  ok(!RW.parseRewriteTarget('第3段').ok, '字符串 target 拒绝');
  ok(!RW.parseRewriteTarget([1, 2]).ok, '数组 target 拒绝');
  ok(!RW.parseRewriteTarget({ start: 5, end: 5, expect: '' }).ok, 'start === end 拒绝');
  ok(!RW.parseRewriteTarget({ start: -1, end: 2, expect: 'abc' }).ok, '负 start 拒绝');
  ok(!RW.parseRewriteTarget({ start: 0, end: 2, expect: '' }).ok, '空 expect 拒绝（没有快照就没法校验）');
  ok(!RW.parseRewriteTarget({ start: 0, end: 5, expect: 'abc' }).ok, '区间长度与 expect 不符 → 拒绝');
  ok(
    !RW.parseRewriteTarget({ start: 0, end: RW.MAX_TARGET_CHARS + 1, expect: 'x'.repeat(RW.MAX_TARGET_CHARS + 1) }).ok,
    '超长片段拒绝（超了就该走整段重写）',
  );
  const parsed = RW.parseRewriteTarget({ start: 2, end: 5, expect: '灯影一' });
  eq(parsed.ok, true, '合法 target 通过');
  eq(parsed.target, { start: 2, end: 5, expect: '灯影一' }, '合法 target 归一成纯字段');

  // --- checkRewriteTarget：原文快照校验 ---
  const text = '他推门进来，灯影一晃，屋里没人。';
  eq(RW.checkRewriteTarget({ content: text, target: null }), { ok: true }, '没 target 时校验直接通过');
  eq(RW.checkRewriteTarget({ content: text, target: { start: 6, end: 10, expect: '灯影一晃' } }), { ok: true }, '片段还在原位 → 通过');
  eq(
    RW.checkRewriteTarget({ content: text, target: { start: 6, end: 10, expect: '风灯一晃' } }).code,
    'text_mismatch',
    '片段内容变了 → text_mismatch（调用方翻成 409，让用户重选）',
  );
  eq(
    RW.checkRewriteTarget({ content: '短', target: { start: 0, end: 9, expect: '一二三四五六七八九' } }).code,
    'text_mismatch',
    '区间越出正文长度 → text_mismatch（不抛异常）',
  );

  // --- composeRewriteGuidance：走既有 guidance 通道 ---
  eq(RW.composeRewriteGuidance({}), '', '两者都没有 → 空串（不产生空 guidance）');
  eq(RW.composeRewriteGuidance({ guidance: '更压抑一些' }), '更压抑一些', '只有作者要求 → 原样');
  const onlyTarget = RW.composeRewriteGuidance({ target: { start: 0, end: 4, expect: '灯影一晃' } });
  ok(onlyTarget.includes('【待改片段】灯影一晃'), '只有 target → 带上待改片段');
  ok(onlyTarget.includes('保持原样'), '只有 target → 明说其余保持原样（这次和平时不一样的地方）');
  const both = RW.composeRewriteGuidance({ guidance: '更压抑一些', target: { start: 0, end: 4, expect: '灯影一晃' } });
  ok(both.startsWith('更压抑一些'), '同时给时作者要求在前');
  ok(both.includes('【待改片段】'), '同时给时片段在后');

  // --- assessRewrite：改完之后的越界判定 ---
  const before = '他推门进来，灯影一晃，屋里没人。';
  const targetFix = { start: 4, end: 10, expect: '进来，灯影' }; // 覆盖要改的那一小段
  const unchanged = RW.assessRewrite({ before, after: before, target: targetFix });
  eq(unchanged.out_of_range, false, '正文一字未改 → 不算越界（前后缀吃满时不能拿坐标比长度）');
  eq(unchanged.outside, { before: 0, after: 0 }, '未改动时 outside 归零');

  const exact = RW.assessRewrite({
    before: '他推门进来，灯影一晃。',
    after: '他推门进来，灯火一晃。',
    target: { start: 6, end: 10, expect: '灯影一晃' },
  });
  eq(exact.out_of_range, false, '改动落在 target 内 → 不越界');
  eq(exact.changed, { from: 7, old_end: 8, new_end: 8 }, 'diff 给出旧/新两套尾端坐标（「影」→「火」，前后缀各吃一段）');

  const outsideAfter = RW.assessRewrite({
    before: '他推门进来，灯影一晃，屋里没人。',
    after: '他推门进来，灯影一晃，屋里空着。',
    target: { start: 6, end: 10, expect: '灯影一晃' },
  });
  eq(outsideAfter.out_of_range, true, '改了 target 之后的内容 → 越界');
  eq(outsideAfter.outside.before, 0, '越界只发生在后面');
  ok(outsideAfter.outside.after > 0, '越界字符数 > 0，前端/报告要能说清改了多少');

  const outsideBefore = RW.assessRewrite({
    before: '他推门进来，灯影一晃。',
    after: '他踹门进来，灯影一晃。',
    target: { start: 6, end: 10, expect: '灯影一晃' },
  });
  eq(outsideBefore.out_of_range, true, '改了 target 之前的内容 → 越界');
  ok(outsideBefore.outside.before > 0, '越界发生在前面');

  const wholeRewrite = RW.assessRewrite({
    before: '他推门进来，灯影一晃。',
    after: '风雨掠过檐角，他站在门外。',
    target: { start: 6, end: 10, expect: '灯影一晃' },
  });
  eq(wholeRewrite.out_of_range, true, '整拍重排 → 越界（模型重演整拍，字面重排天然外溢）');
  eq(RW.assessRewrite({ before: '甲', after: '乙' }).out_of_range, false, '没给 target 时永远不判越界');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 8. 提示词白名单与 state-paths 同构 ===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // 长跑实测（t4/t5/t9）：史官三次写 `player/psyche.fears`、一次写 player 的 life_state——
  // 提示词照抄了人物那行，而 pathsFor('player') 里没有这些路，于是每条都成了
  // `rejected_change(path_not_allowed)`。提示词里列一条**代码必然拒绝**的路，
  // 等于每拍制造一次可见噪声，还让 D35 的判据永远 WARN。两者必须同构。
  const { archivistSystemPrompt } = await import('../server/prompts/archivist.js');
  const { ENTITY_KINDS, pathsFor } = await import('../server/world/state-paths.js');
  const prompt = archivistSystemPrompt();

  const universe = new Set();
  for (const kind of ENTITY_KINDS) for (const p of pathsFor(kind) || []) universe.add(p);

  // 取「- <label>:」这条 bullet 到下一个同缩进 bullet 为止
  const advertised = (label) => {
    const at = prompt.indexOf(`- ${label}:`);
    if (at < 0) return null;
    const rest = prompt.slice(at);
    const next = rest.indexOf('\n  - ', 1);
    const text = next < 0 ? rest : rest.slice(0, next);
    const tokens = text.match(/[a-z][a-z_]*(?:\.[a-z_]+)*/g) || [];
    return [...new Set(tokens)].filter((t) => universe.has(t));
  };

  const playerPaths = advertised('player');
  ok(Array.isArray(playerPaths) && playerPaths.length >= 8, '能解析出主角 changes 白名单', String(playerPaths?.length));
  eq(playerPaths.filter((p) => !pathsFor('player').has(p)), [], '主角白名单只列 pathsFor(player) 里真有的路径（否则每拍一条 rejected_change）');
  ok(playerPaths.includes('wants') && playerPaths.includes('afraid'), '主角动机字段是 wants / afraid');
  ok(!playerPaths.includes('life_state'), '主角不列 life_state（PLAYER_SCALARS 没有它）');
  ok(playerPaths.some((p) => p.startsWith('psyche.')) === false, '主角不列 psyche.*（照抄人物行必被拒）');

  const personPaths = advertised('person');
  ok(Array.isArray(personPaths) && personPaths.length >= 8, '能解析出人物 changes 白名单', String(personPaths?.length));
  eq(personPaths.filter((p) => !pathsFor('person').has(p)), [], '人物白名单同理（含 life_state / psyche.*）');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 9. runLibrarian：工具循环 / 调用上限 / 超时兜底 ===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  // 资料员是唯一「模型自己决定查几次」的旁路 Agent：最多 3 次工具调用、之后必须交答案。
  // 单个工具的 SQL 包装由 store 层覆盖，这里测的是**循环与降级**——它一旦不收敛，
  // 这一拍就没有结论；而把「超时」写成「找到」会让下游把空答案当事实。
  const { librarianSystemPrompt } = await import('../server/prompts/archivist.js');
  const ctx = newSession('资料员');
  const ask = (question = '伍卿的玉佩去哪了？') => pipe.runLibrarian({ session: ctx.session, question });

  // ① 一枪交答案：不调工具，calls=0。
  await using({ 'fake-librarian': JSON.stringify({
    done: true, found: true, answer: '在凌玥手里。',
    citations: [{ turn_no: 3, quote: '她把玉佩收进袖中。' }],
  }) }, async (fake) => {
    const r = await ask();
    eq(fake.count('fake-librarian'), 1, '① 交答案只需一次模型调用');
    eq(r.calls, 0, '① 没调工具 → calls=0');
    eq(r.found, true, '① found 透传');
    eq(r.answer, '在凌玥手里。', '① answer 透传');
    eq(r.citations, [{ turn_no: 3, quote: '她把玉佩收进袖中。' }], '① citations 透传');
    const msgs = fake.calls[0].body.messages;
    eq(msgs[0].content, librarianSystemPrompt(), '① 首条 system 就是 librarianSystemPrompt()');
    ok(msgs[1].content.includes('伍卿的玉佩去哪了？'), '① 问题进 user 消息');
  });

  // ② 先调一次工具再交答案：calls=1，工具结果回灌。
  await using({ 'fake-librarian': (body, nth) => nth === 1
    ? JSON.stringify({ action: 'get_threads', args: { status: 'open' } })
    : JSON.stringify({ done: true, found: false, answer: '没有记录。' }) }, async (fake) => {
    const r = await ask();
    eq(fake.count('fake-librarian'), 2, '② 一次工具 + 一次交答案 = 两次调用');
    eq(r.calls, 1, '② calls=1');
    eq(r.found, false, '② found=false 原样返回（「查了但没找到」也是结论）');
    const second = fake.calls[1].body.messages;
    ok(second.some((m) => String(m.content).startsWith('【工具结果 get_threads】')), '② 工具结果以【工具结果】回灌');
  });

  // ③ 一直不交答案：最多 3 次工具调用，第 4 轮被逼收尾，返回超时兜底。
  await using({ 'fake-librarian': JSON.stringify({ action: 'get_threads', args: { status: 'all' } }) }, async (fake) => {
    const r = await ask();
    eq(fake.count('fake-librarian'), 4, '③ 循环上限 4 轮（模型调用 4 次）');
    eq(r.calls, 3, '③ 工具最多调 3 次');
    eq(r.found, false, '③ 超时不冒充「找到了」');
    eq(r.answer, '检索超时，没有结论。', '③ 超时有确定的兜底文案');
    const last = fake.calls[3].body.messages;
    ok(last.some((m) => String(m.content).includes('工具调用已达上限')), '③ 第 4 轮在调用**之前**就要求交答案（旧实现把这句话推在调用之后，永远发不出去）');
  });

  // ④ 模型编了个不存在的工具：不计数、不崩，逼它重说。
  await using({ 'fake-librarian': (body, nth) => nth === 1
    ? JSON.stringify({ action: 'search_everything', args: {} })
    : JSON.stringify({ done: true, found: false, answer: '无。' }) }, async (fake) => {
    const r = await ask();
    eq(r.calls, 0, '④ 不存在的工具不计入调用上限');
    eq(fake.count('fake-librarian'), 2, '④ 被逼重说一次');
  });

  // ⑤ citations 清洗：没有 quote 的丢掉，最多 5 条。
  await using({ 'fake-librarian': JSON.stringify({
    done: true, found: true, answer: '有。',
    citations: [
      { turn_no: 1, quote: '甲' }, { turn_no: 2, quote: '乙' }, { turn_no: 3, quote: '丙' },
      { turn_no: 4, quote: '丁' }, { turn_no: 5, quote: '戊' }, { turn_no: 6, quote: '己' },
      { turn_no: 7 },
    ],
  }) }, async () => {
    const r = await ask();
    eq(r.citations.length, 5, '⑤ 最多 5 条引用');
    ok(r.citations.every((c) => c.quote && c.quote.length <= 120), '⑤ 每条都有 quote 且截断到 120 字');
    ok(r.citations.every((c) => Number.isInteger(c.turn_no)), '⑤ turn_no 归一成整数');
  });
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 10. 回放校验：把上一拍整段重演时同等级重写一次（D7 基线局 t42→t44）===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const { cjkOnly, longestCommonCjk, detectReplay, REPLAY_MIN_CJK } = await import('../server/memory/replay.js');

  // ① 判据本身是确定性的：CJK 去标点后取最长公共子串，阈值 100 字（与报告 repeat_longest 的 FAIL 线同一个数）。
  eq(cjkOnly('他的刀，在桌上！ok 3'), '他的刀在桌上', '① 只留汉字：标点、拉丁字母、数字、空白都剔掉');
  eq(longestCommonCjk('他推门进来，灯影一晃。', '他推门进来，灯火一晃。').length, 6,
    '① 最长公共子串口径（「他推门进来灯」6 字）');
  eq(REPLAY_MIN_CJK, 100, '① 阈值与报告 repeat_longest 的 FAIL 线一致');
  eq(detectReplay({ content: '短句', recent: [{ turn_no: 1, content: '短句' }] }).hit, false,
    '① 低于阈值不算回放（短句重复不是回放，是中文的正常现象）');

  // 两条长正文：LONG 会被整段重演，CLEAN 与上一拍几乎无重叠。
  const LONG = '他把药碗搁回床头的矮几上，碗底还剩小半口，药面结了一层薄皮。黎婆的手压在枕边的包袱上，'
    + '五指扣着那个绳结，也不知是睡着了还是怕人夜里拿走。他抬手抹了把嘴，苦味顺着舌根往喉咙里钻。'
    + '窗外的雨丝斜着扫过纸窗，灯芯爆了一下，把影子推到墙根去。他退开半步，左脚拖过地面，蹭出一点灰。'
    + '门外传来谁家孩子的哭声，隔着雨声听不真切。';
  const CLEAN = '天色忽然放亮，他推门出去，院子里积了半尺深的水。牛车歪在门口，绳子松了，'
    + '车辕上落着一只湿透的草鞋。他弯腰去解绳结，指头冻得发僵，解了三次才松开。'
    + '远处田埂上有个人影走过，扛着锄头，没回头。';
  ok(cjkOnly(LONG).length > REPLAY_MIN_CJK, '夹具：LONG 的汉字数过阈值（'
    + `${cjkOnly(LONG).length} > ${REPLAY_MIN_CJK}）`);
  ok(detectReplay({ content: CLEAN, recent: [{ turn_no: 1, content: LONG }] }).hit === false,
    '夹具：CLEAN 与 LONG 不算回放');

  const baseHandlers = (narrator) => ({
    'fake-narrator': narrator,
    'fake-archivist': () => '{"scene_change":{"changed":false}}',
    'fake-scene-keeper': () => JSON.stringify({
      question: '他在等什么', outcome: '他等着天亮', key_detail: '药碗搁在矮几上',
      threads: [], hooks: [], life_changes: [],
    }),
    'fake-world-tick': () => JSON.stringify({ events: [] }),
    'fake-continuity': () => '{"issues":[],"healthy":[]}',
    'fake-retrieval': () => '{"codex":[],"history":[]}',
  });
  const { config } = await import('../server/config.js');
  const prevWorldTick = config.context.worldTickEvery;
  const prevSceneEvery = config.context.sceneEvery;
  config.context.worldTickEvery = 0;
  config.context.sceneEvery = 0;
  try {
    // ② 命中 → 重写一次 → 采用重写稿，且全过程留痕（patch + meta + SSE）。
    {
      const ctx = newSession('回放重写');
      const events = [];
      // 第 1 拍产出 LONG；第 2 拍首次照搬 LONG（触发回放），重写返回 CLEAN。
      await using(baseHandlers((body, nth) => ({ content: nth === 3 ? CLEAN : LONG })), async (fake) => {
        await orch.runTurn({
          sessionId: ctx.session.id, playerText: '我把药碗推到一边，坐在床边等天亮。',
          generateBranches: false, onEvent: (e) => events.push(e),
        });
        await orch.runTurn({
          sessionId: ctx.session.id, playerText: '天快亮了，我起身推门。',
          generateBranches: false, onEvent: (e) => events.push(e),
        });
        eq(fake.count('fake-narrator'), 3, '② 第 2 拍被重写一次（1 拍 1 次 + 第 2 拍 2 次）');
        const narratorCalls = fake.calls.filter((c) => c.model === 'fake-narrator');
        eq(narratorCalls[2].body.messages.some((m) => String(m.content).includes('已经写过这段')), true,
          '② 重写走的是既有 guidance 通道（不新增注入点），且告诉模型重复了哪一拍');
      });
      const row = store.getTurn(ctx.session.id, 2, 'narrator');
      eq(row.content, CLEAN, '② 落库的是重写稿，不是照搬稿');
      const meta = JSON.parse(row.meta_json || '{}');
      eq(meta.replay?.resolved, true, '② meta.replay.resolved=true（这一拍被重写过）');
      eq(meta.replay?.prev_turn, 1, '② meta.replay.prev_turn 指出重复的是第 1 拍');
      const patches = store.listPatches(ctx.session.id, { branchId: 'main', kind: 'narrator_replay' });
      eq(patches.length, 1, '② 每次命中写 1 条 narrator_replay');
      eq(patches[0].status, 'applied', '② 重写解决了 → patch applied');
      ok(patches[0].payload?.longest >= REPLAY_MIN_CJK, '② patch 记下重复字数（报告靠它数发生率）');
      eq(patches[0].payload?.prev_turn, 1, '② patch 记下被重复的回合号');
      ok(events.some((e) => e.type === 'narrative_reset' && e.reason === 'replay'),
        '② SSE 通知前端「这一拍在重写」（否则阅读区已经上屏的错稿不会消失）');
      ok(events.some((e) => e.type === 'narrative_done' && e.content === CLEAN),
        '② narrative_done 给的是最终采用的那一版');
    }

    // ③ 两次都照搬 → 不采用第二稿、不静默改写，如实记 open。
    {
      const ctx = newSession('回放未解决');
      await using(baseHandlers(() => ({ content: LONG })), async (fake) => {
        await orch.runTurn({
          sessionId: ctx.session.id, playerText: '我把药碗推到一边，坐在床边等天亮。',
          generateBranches: false,
        });
        await orch.runTurn({ sessionId: ctx.session.id, playerText: '天快亮了，我起身推门。', generateBranches: false });
        eq(fake.count('fake-narrator'), 3, '③ 只重写一次就停（不无限重试）');
      });
      const row = store.getTurn(ctx.session.id, 2, 'narrator');
      eq(row.content, LONG, '③ 两稿一样烂时保留首稿（不为了「看起来改善」而换稿）');
      const patches = store.listPatches(ctx.session.id, { branchId: 'main', kind: 'narrator_replay' });
      eq(patches.length, 1, '③ 仍然留痕');
      eq(patches[0].status, 'open', '③ 没解决 → status=open（报告会把它数成 WARN，而不是假装修好了）');
      eq(patches[0].payload?.resolved, false, '③ payload.resolved=false');
      ok(patches[0].payload?.retry_longest >= REPLAY_MIN_CJK, '③ 记下第二稿的照搬长度（两稿可比较）');
      const meta = JSON.parse(row.meta_json || '{}');
      eq(meta.replay?.resolved, false, '③ meta.replay.resolved=false');
    }
  } finally {
    config.context.worldTickEvery = prevWorldTick;
    config.context.sceneEvery = prevSceneEvery;
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 11. 定点改稿的片段模式：模型只写片段，拼接与重跑记忆是确定性的 ===');
/* ══════════════════════════════════════════════════════════════════════ */
{
  const { cleanFragment, composeFragmentGuidance, spliceFragment, MAX_FRAGMENT_CHARS }
    = await import('../server/agents/fragment.js');

  // ① 包装清洗：模型爱加的代码块 / 前缀 / 外层引号要剥掉，正文内部的对白引号必须保留。
  eq(cleanFragment('```\n他推门进来，灯火一晃。\n```'), '他推门进来，灯火一晃。', '① 剥掉代码块围栏');
  eq(cleanFragment('改写：他推门进来，灯火一晃。'), '他推门进来，灯火一晃。', '① 剥掉「改写：」前缀');
  eq(cleanFragment('「他推门进来，灯火一晃。」'), '他推门进来，灯火一晃。', '① 剥掉把整段包住的外层引号');
  eq(cleanFragment('他说：「别动。」'), '他说：「别动。」', '① 正文内部的对白引号原样保留（只剥最外层）');
  eq(cleanFragment('   '), '', '① 空白片段洗成空串 → 后面会被拒写');

  // ② 拼接：范围外一个字节都不动，这是片段模式存在的唯一理由。
  const BEFORE = '他推门进来，灯影一晃。他把伞靠在门边，雨水顺着伞骨滴在青砖上。';
  // 定位由前端给（选中的字符偏移 + 原文快照）；测试里用 indexOf 算，别手数汉字。
  const targetStart = BEFORE.indexOf('灯影');
  const TARGET = { start: targetStart, end: targetStart + 2, expect: '灯影' };
  const spliced = spliceFragment({ before: BEFORE, target: TARGET, piece: '灯火' });
  eq(spliced.ok, true, '② 合法片段可以拼接');
  eq(spliced.text, '他推门进来，灯火一晃。他把伞靠在门边，雨水顺着伞骨滴在青砖上。',
    '② 只有 target 圈住的两个字被替换，其余逐字不变');
  eq(spliced.piece, '灯火', '② 返回清洗后的片段（前端要展示它）');
  eq(spliceFragment({ before: BEFORE, target: TARGET, piece: '   ' }).error, 'empty_fragment', '② 空片段拒写');
  eq(spliceFragment({ before: BEFORE, target: TARGET, piece: '灯影' }).error, 'unchanged', '② 与原文相同拒写');
  eq(spliceFragment({ before: BEFORE, target: TARGET, piece: '灯'.repeat(MAX_FRAGMENT_CHARS + 1) }).error,
    'fragment_too_long', '② 超长片段拒写（一次只改一屏以内）');
  eq(spliceFragment({ before: BEFORE, target: null, piece: '灯火' }).error, 'no_target', '② 没有定位信息拒写');

  // ③ 送模指令只写这种写法特有的要求：不重写整段、只给那一小段。
  const guidance = composeFragmentGuidance({ target: TARGET, instruction: '把「灯影」改成「灯火」' });
  ok(guidance.includes('【待改片段】灯影'), '③ 指令里带原文片段（模型才知道在改哪句）');
  ok(guidance.includes('把「灯影」改成「灯火」'), '③ 作者的要求原样带上');
  ok(!/JSON|schema|patch/i.test(guidance), '③ 不让旁白输出结构化内容（红线 8）');

  const { config } = await import('../server/config.js');
  const prevWorldTick = config.context.worldTickEvery;
  const prevSceneEvery = config.context.sceneEvery;
  config.context.worldTickEvery = 0;
  config.context.sceneEvery = 0;
  const handlers = {
    'fake-narrator': () => ({ content: '灯火' }),
    'fake-archivist': () => JSON.stringify({
      scene_change: { changed: false },
      assertions: [{ subject: '凌玥', predicate: '知道', object: '玉佩在桌上' }],
    }),
    'fake-scene-keeper': () => JSON.stringify({
      question: '他在等什么', outcome: '他等着天亮', key_detail: '伞立在门边',
      threads: [], hooks: [], life_changes: [],
    }),
    'fake-world-tick': () => JSON.stringify({ events: [] }),
    'fake-continuity': () => '{"issues":[],"healthy":[]}',
    'fake-retrieval': () => '{"codex":[],"history":[]}',
  };
  try {
    // ④ 片段模式：模型只写「灯火」，落库的是拼好的全文。
    {
      const ctx = newSession('片段改稿');
      const events = [];
      await using(handlers, async (fake) => {
        await orch.runTurn({
          sessionId: ctx.session.id,
          playerText: '我推门进去。',
          generateBranches: false,
          fragment: { ...TARGET, before: BEFORE },
          onEvent: (e) => events.push(e),
        });
        eq(fake.count('fake-narrator'), 1, '④ 只调一次旁白');
        const sent = fake.calls.find((c) => c.model === 'fake-narrator');
        const flat = JSON.stringify(sent?.body?.messages || []);
        ok(flat.includes('【待改片段】灯影'), '④ 片段指令真的进了送模消息（走既有 guidance 通道）');
      });
      const row = store.getTurn(ctx.session.id, 1, 'narrator');
      eq(row.content, '他推门进来，灯火一晃。他把伞靠在门边，雨水顺着伞骨滴在青砖上。',
        '④ 落库的是拼接后的全文，不是模型只写的那两个字');
      ok(events.some((e) => e.type === 'rewrite_fragment' && e.piece === '灯火'),
        '④ SSE 把片段与前后字数回给前端（要能展示「只改了这两个字」）');
      eq(store.getAssertions(ctx.session.id, { branchId: 'main' }).length, 1,
        '④ 记忆照常重建（拼接后的正文进了史官）');
    }

    // ⑤ 只重跑记忆：正文不进模型，史官照跑。手工改完正文用它补记忆。
    {
      const ctx = newSession('重跑记忆');
      await using(handlers, async (fake) => {
        await orch.runTurn({
          sessionId: ctx.session.id,
          playerText: '我推门进去。',
          generateBranches: false,
          narrativeOverride: '他把伞立在门边，转身看着我。',
        });
        eq(fake.count('fake-narrator'), 0, '⑤ 不调旁白（正文由作者定稿）');
        eq(fake.count('fake-archivist'), 1, '⑤ 史官照跑');
      });
      eq(store.getTurn(ctx.session.id, 1, 'narrator').content, '他把伞立在门边，转身看着我。',
        '⑤ 落库的正文就是作者给的那一段（不重新演绎）');
      eq(store.getAssertions(ctx.session.id, { branchId: 'main' }).length, 1, '⑤ 记忆真的重建了');
    }

    // ⑥ 片段拼接失败 = 拒写：这一拍一行都不落库，玩家那句话还能重发。
    {
      const ctx = newSession('片段拒写');
      const events = [];
      // 模型原样吐回「灯影」→ 拼接结果与原文相同 → unchanged → 拒写。
      await using({ ...handlers, 'fake-narrator': () => ({ content: '灯影' }) }, async () => {
        let threw = null;
        try {
          await orch.runTurn({
            sessionId: ctx.session.id,
            playerText: '我推门进去。',
            generateBranches: false,
            fragment: { ...TARGET, before: BEFORE },
            onEvent: (e) => events.push(e),
          });
        } catch (err) { threw = err; }
        ok(!!threw, '⑥ 拼接失败要抛错（不静默落一版坏正文）');
      });
      eq(store.getTurnsForBranch(ctx.session.id, 'main', null, { from: 1, to: 9 }).length, 0,
        '⑥ 一个字都没落库（半截正文比失败更坏）');
      ok(events.some((e) => e.type === 'error' && e.not_persisted),
        '⑥ error 事件带 not_persisted，前端才能把玩家行动还回输入框');
    }
  } finally {
    config.context.worldTickEvery = prevWorldTick;
    config.context.sceneEvery = prevSceneEvery;
  }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-agents: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
