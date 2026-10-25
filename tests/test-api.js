#!/usr/bin/env node
/**
 * tests/test-api.js — HTTP 集成测试（需要服务端已启动，不调用 LLM）
 *
 *   node tests/test-api.js [baseUrl]     # baseUrl 缺省读 TEST_BASE_URL，再缺省 localhost:3210
 *
 * 覆盖：配置、世界卡 CRUD 与导出、辞书钉选、会话生命周期（含锚点）、
 *       记忆六表读取、断言手增、分支/回滚、404 处理。
 */
const BASE = process.argv[2] || process.env.TEST_BASE_URL || 'http://localhost:3210';

let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

console.log(`\n=== 连通性 (${BASE}) ===`);
try {
  const { status } = await req('GET', '/api/config');
  ok(status === 200, '服务端可达');
} catch (err) {
  console.log(`  ✗ 无法连接 ${BASE} — ${err.message}`);
  console.log('\n请先启动服务：node server/index.js');
  process.exit(1);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 配置 ===');
{
  const { data } = await req('GET', '/api/config');
  // 档位会被本地 .env 覆盖（如 max），只断言暴露且是合法档位。
  ok(['low', 'medium', 'high', 'max'].includes(data.defaults?.archivist_effort), '配置暴露 archivist 档位');
  ok(['low', 'medium', 'high', 'max'].includes(data.defaults?.narrator_effort), '配置暴露 narrator 档位');
  ok(data.budget?.system === 3200, '配置暴露 v4 四层预算');
  ok(!('lore' in (data.budget || {})), '预算里没有 lore 层');
  ok(!('director' in (data.budget || {})), '预算里没有 director 层');
  ok(data.defaults?.continuity_every === 10, '校勘节奏可配置');
  ok(data.defaults?.continuity_max_applied === 20, '校勘写入上限可配置');
  ok(data.runtime?.options?.agent_keys?.length === 9, '配置暴露 9 个 Agent 的绑定槽位');
  ok(data.models?.default === data.runtime?.agents?.narrator?.model, '旧字段 models.default 与生效配置一致');
  ok(data.limits?.context_max_tokens === data.runtime?.context?.hard_max_tokens, '旧字段硬上限与生效配置一致');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 运行期模型配置（DB 覆盖层） ===');
{
  const initial = (await req('GET', '/api/config')).data;
  const rt = initial.runtime;
  ok(rt && typeof rt === 'object', 'GET /api/config 暴露 runtime');
  ok(['env', 'db'].includes(rt.source), 'runtime.source 合法');
  ok(Array.isArray(rt.providers) && rt.providers.length >= 1, 'runtime.providers 是数组');
  ok(Array.isArray(rt.models) && rt.models.length >= 1, 'runtime.models 是数组');
  ok(rt.providers.every((p) => p.apiKey === ''), 'runtime 不回显明文 apiKey');
  ok(rt.providers.every((p) => typeof p.hasKey === 'boolean'), 'runtime 用 hasKey 表示是否已配置');
  ok(typeof rt.context?.hard_max_tokens === 'number', 'runtime 暴露上下文硬上限');
  ok(typeof rt.context?.soft_target_tokens === 'number', 'runtime 暴露上下文软目标');

  if (rt.source === 'db') {
    // 用户已经在界面上保存过配置：不做破坏性 PUT，避免测试清掉真实设置。
    console.log('  （检测到已保存的 DB 配置，跳过写入用例）');
    ok(rt.agents && typeof rt.agents === 'object', '已保存配置包含 Agent 绑定表');
  } else {
    const KEY = 'sk-api-test-key-1234';
    let wrote = false;
    try {
      wrote = true;
      const put = await req('PUT', '/api/config', {
        providers: [{ id: 'test-provider', name: '接口测试服务商', baseUrl: 'https://api.example.com/v1', apiKey: KEY, protocol: 'openai' }],
        models: [{ id: 'test-model', providerId: 'test-provider', model: 'api-test-model', contextWindow: 48000, maxOutput: 6000 }],
        agents: { narrator: { modelId: 'test-model', effort: 'low', temperature: 0.5, maxTokens: 3000 } },
      });
      ok(put.status === 200 && put.data.runtime.source === 'db', 'PUT 保存后 source=db');
      ok(!JSON.stringify(put.data).includes(KEY), '保存响应不含明文密钥');
      ok(put.data.runtime.providers[0].hasKey === true && put.data.runtime.providers[0].keyHint === '1234', '密钥以掩码形式返回');

      const after = (await req('GET', '/api/config')).data;
      ok(after.runtime.source === 'db', '无需重启：GET 立即读到 DB 配置');
      ok(after.models.default === 'api-test-model', '旧字段 models.default 跟随生效模型');
      ok(after.defaults.narrator_effort === 'low', '旧字段 narrator 档位跟随 DB 绑定');
      ok(after.limits.context_max_tokens === 48000, '旧字段硬上限跟随绑定模型 contextWindow');
      ok(after.budget.system === 3200, '预算字段不受模型配置影响');

      const keep = await req('PUT', '/api/config', {
        providers: [{ id: 'test-provider', name: '接口测试服务商', baseUrl: 'https://api.example.com/v1', apiKey: '***', protocol: 'openai' }],
        models: [{ id: 'test-model', providerId: 'test-provider', model: 'api-test-model', contextWindow: 48000, maxOutput: 6000 }],
      });
      ok(keep.data.runtime.providers[0].keyHint === '1234', "'***' 表示保留已保存的密钥");

      const badEmpty = await req('PUT', '/api/config', { providers: [], models: [] });
      ok(badEmpty.status === 400 && !!badEmpty.data.error?.message, '空服务商列表被 400 拒绝');
      const badUrl = await req('PUT', '/api/config', {
        providers: [{ id: 'x', name: 'x', baseUrl: 'not-a-url', protocol: 'openai' }],
        models: [{ id: 'm', providerId: 'x', model: 'm' }],
      });
      ok(badUrl.status === 400, '坏 baseUrl 被 400 拒绝');
      const badAgent = await req('PUT', '/api/config', { ...keep.data.runtime, agents: { seniorArchivist: { effort: 'low' } } });
      ok(badAgent.status === 400, '未知 Agent 被 400 拒绝');
      ok((await req('GET', '/api/config')).data.runtime.source === 'db', '校验失败不破坏已保存配置');

      const del = await req('DELETE', '/api/config');
      ok(del.status === 200 && del.data.runtime.source === 'env', 'DELETE 恢复 .env 默认');
      const restored = (await req('GET', '/api/config')).data;
      ok(restored.runtime.source === 'env', 'GET 立刻回到 .env');
      ok(restored.models.default === initial.models.default, '恢复后旧字段 models.default 与原值一致');
      ok(restored.defaults.narrator_effort === initial.defaults.narrator_effort, '恢复后旧字段档位与原值一致');
      ok(restored.limits.context_max_tokens === initial.limits.context_max_tokens, '恢复后旧字段硬上限与原值一致');
      ok(restored.budget.system === initial.budget.system, '恢复后预算字段与原值一致');
    } finally {
      if (wrote) await req('DELETE', '/api/config');
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 字体 ===');
{
  const { status, data } = await req('GET', '/api/fonts');
  ok(status === 200, '字体接口可达');
  ok(Array.isArray(data.fonts), '字体清单是数组');
  ok(typeof data.source === 'string', '标注了字体来源');
  ok(!Array.isArray(data.fonts) || data.fonts.every((f) => typeof f === 'string'), '字体族名都是字符串');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 世界卡 CRUD ===');
const WORLD_ID = `test-w-${Date.now()}`;
const CARD = {
  title: '接口测试世界',
  subtitle: '一个小卡',
  premise: '两个人被关在一间屋子里，只有一个能出去。',
  charter: [{ rule: '门在午夜打开一次。' }],
  entities: [{
    id: 'a', type: 'person', name: '阿砚', aliases: ['砚哥'], role: '囚犯',
    voice: { rhythm: '短句', exemplars: ['「别信他。」'] },
    psyche: { wants: ['出去'], hides: ['钥匙在他鞋里'] },
    knowledge: { knows: ['钥匙的位置'], does_not_know: ['对方也知道'] },
    agenda: [{ goal: '拿到钥匙', method: '装睡', pressure: 0.8 }],
  }, {
    id: 'room', type: 'place', name: '屋子', tags: ['封闭'],
    summary: '没有窗，一张桌，两把椅子。', facets: { sensory: '石灰味' },
    links: ['a'],
  }],
  timeline: [
    { id: 'e1', when: '三日前', what: '两人被抓进来', canon: 'past' },
    { id: 'e2', when: '七日后', what: '其中一人走出去', canon: 'future' },
  ],
  anchors: [{
    id: 'start', label: '开局 · 屋内', snapshot: {
      time: '午夜前十分钟', place: '屋子', characters: { a: { mood: '疲惫' } },
    }, opening_seed: '灯灭了。桌上多了一把钥匙。',
  }],
  player: { name: '阿砚', mode: 'canon' },
};

{
  const { status, data } = await req('POST', '/api/worlds', { id: WORLD_ID, card: CARD });
  ok(status === 201, '创建世界卡');
  ok(data.card?.version === 5, '落库的是 v5 形状');
  ok(data.entities?.length === 2 && data.entities.some((e) => e.type === 'place'), '实体投影表同步');

  const list = await req('GET', '/api/worlds');
  const found = list.data.find((w) => w.id === WORLD_ID);
  ok(!!found, '列表里能查到');
  ok(found.entity_count === 2 && found.fact_count === 1 && found.persons.length === 1, '摘要里有实体/人物/事实数');
  ok(found.card.anchors?.[0]?.label === '开局 · 屋内', '摘要里有可玩时间点');

  const one = await req('GET', `/api/worlds/${WORLD_ID}`);
  ok(one.data.card.timeline.length === 2, '详情含时间线');
  ok(one.data.card.entities.find((e) => e.type === 'person').psyche.hides[0] === '钥匙在他鞋里', '详情含人物私心');

  const lint = await req('GET', `/api/worlds/${WORLD_ID}/lint`);
  ok(lint.status === 200 && Array.isArray(lint.data.issues), '卡级 lint 接口可达');
  ok(lint.data.counts?.entities >= 1, 'lint 返回实体计数');

  const text = await fetch(`${BASE}/api/worlds/${WORLD_ID}/export`).then((r) => r.text());
  ok(text.includes('# 接口测试世界'), '导出纯文本');
  ok(text.includes('[参考走向]'), '导出标出 future 供人看');
  ok(text.includes('其中一人走出去'), '导出含 future 事件内容');

  const patch = await req('PATCH', `/api/worlds/${WORLD_ID}`, { card: { prompt: { premise: '改过的命题' } } });
  ok(patch.data.card.prompt.premise === '改过的命题', '局部更新');
  ok(patch.data.card.entities.filter((e) => e.type === 'person').length === 1, '局部更新不丢人物');
}

{
  const { status, data } = await req('POST', `/api/worlds/${WORLD_ID}/entities/room/pin`, { pinned: true });
  ok(status === 200 && data.entities.find((e) => e.id === 'room')?.pinned === true, '钉选实体');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 会话生命周期 ===');
let SESSION_ID;
{
  const { status, data } = await req('POST', `/api/worlds/${WORLD_ID}/sessions`, {});
  ok(status === 201, '从世界卡开会话');
  SESSION_ID = data.id;
  ok(data.anchor_id === 'start', '默认用第一个锚点开局');

  const mem = await req('GET', `/api/sessions/${SESSION_ID}/memory`);
  ok(mem.data.state?.place === '屋子', '账本用锚点快照初始化');
  ok(mem.data.state?.characters?.a?.mood === '疲惫', '快照里的人物状态就位');
  ok(mem.data.branches[0].branch_id === 'main', '主线分支已建');
  ok(mem.data.world.timeline_future === 1, '元数据记录扣留的未来事件数');

  const bad = await req('POST', `/api/worlds/${WORLD_ID}/sessions`, { anchor_id: '不存在' });
  ok(bad.status === 400, '非法锚点被拒绝');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 记忆六表 ===');
{
  const a = await req('GET', `/api/sessions/${SESSION_ID}/assertions`);
  ok(a.status === 200 && Array.isArray(a.data.assertions), '断言表可读');

  const add = await req('POST', `/api/sessions/${SESSION_ID}/assertions`, {
    subject: '阿砚', predicate: '拥有', object: '钥匙',
  });
  ok(add.status === 201, '手工添加断言');
  ok(add.data.assertions.some((x) => x.object === '钥匙'), '断言进入有效集');

  const st = await req('GET', `/api/sessions/${SESSION_ID}/states`);
  ok(st.status === 200, '人物状态表可读');

  const sc = await req('GET', `/api/sessions/${SESSION_ID}/scenes`);
  ok(sc.status === 200, '场次表可读');

  const th = await req('GET', `/api/sessions/${SESSION_ID}/threads`);
  ok(th.status === 200, '线索表可读');

  const v = await req('GET', `/api/sessions/${SESSION_ID}/voices`);
  ok(v.status === 200, '原声表可读');

  const p = await req('GET', `/api/sessions/${SESSION_ID}/patches`);
  ok(p.status === 200, '提案审计表可读');

  const br = await req('GET', `/api/sessions/${SESSION_ID}/branches`);
  ok(br.data.current === 'main', '分支列表');

  const detail = await req('GET', `/api/sessions/${SESSION_ID}`);
  ok(detail.data.card?.title === '接口测试世界', '会话返回冻结的卡片快照');
  ok(detail.data.world_version >= 1, '会话记录模板版本');
  ok(detail.data.playerView?.time === '午夜前十分钟', '会话返回状态条视图（时间）');
  ok(detail.data.playerView?.place === '屋子', '会话返回状态条视图（地点）');
  ok(detail.data.playerView?.present.includes('阿砚'), '状态条在场 id 归一成显示名');
  ok(!JSON.stringify(detail.data.playerView).includes('疲惫'), '状态条不投影人物心境');

  const ws = await req('GET', `/api/sessions/${SESSION_ID}/world-state`);
  ok(ws.status === 200 && Array.isArray(ws.data.changes), '世界状态增量可读');

  const canon = await req('POST', `/api/sessions/${SESSION_ID}/canonize`, {
    title: '接口测试定稿', anchor_label: '从屋内继续',
  });
  ok(canon.status === 201 && canon.data.world.id !== WORLD_ID, '世界线可定稿为独立新卡');
  ok(canon.data.card.anchors.some((a) => a.label === '从屋内继续'), '定稿生成新锚点');
  await req('DELETE', `/api/worlds/${canon.data.world.id}`);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 作者笔记与场记指令 ===');
{
  const n = await req('POST', `/api/sessions/${SESSION_ID}/notes`, { content: '钥匙必须是铜的', kind: 'rule' });
  ok(n.status === 201, '添加作者笔记');
  const d = await req('PATCH', `/api/sessions/${SESSION_ID}`, { scene_directive: '这一场只写两个人对视' });
  ok(d.data.settings.scene_directive === '这一场只写两个人对视', '设置本场指令');
  const seg = await req('PATCH', `/api/sessions/${SESSION_ID}`, { settings: { narration_mode: 'segmented' } });
  ok(seg.data.settings.narration_mode === 'segmented', '可开启分段演绎');
  ok(seg.data.settings.scene_directive === '这一场只写两个人对视', 'settings 局部更新不丢已有键');
  const del = await req('DELETE', `/api/sessions/${SESSION_ID}/notes/${n.data.id}`);
  ok(del.status === 200, '删除笔记');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 回滚 = 开新分支 ===');
{
  const r = await req('POST', `/api/sessions/${SESSION_ID}/rollback`, { turn_no: 0 });
  ok(r.status === 200, '回滚成功');
  ok(r.data.branch_id !== 'main', '得到新分支 id');
  ok(r.data.fork_turn === 0, '记录分叉轮次');
  const br = await req('GET', `/api/sessions/${SESSION_ID}/branches`);
  const main = br.data.branches.find((b) => b.branch_id === 'main');
  ok(main.status === 'abandoned', '旧分支标为 abandoned（历史没删）');
  ok(br.data.current === r.data.branch_id, '当前分支已切换');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 历史检索接口 ===');
{
  const missing = await req('POST', '/api/sessions/nope/recall-history', { query: '雨' });
  ok(missing.status === 404, '未知会话的历史检索 404');
  const noQuery = await req('POST', `/api/sessions/${SESSION_ID}/recall-history`, {});
  ok(noQuery.status === 400, '空 query 的历史检索 400');
  const rh = await req('POST', `/api/sessions/${SESSION_ID}/recall-history`, { query: '雨' });
  ok(rh.status === 200 && Array.isArray(rh.data.hits), '历史检索返回 hits 数组');
  ok(typeof rh.data.text === 'string' && typeof rh.data.meta?.tokens === 'number', '历史检索返回文本与 token 统计');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 制卡素材 ===');
{
  const m = await req('GET', '/api/smith/materials');
  ok(m.status === 200, '素材目录可列');
  const has = (m.data.materials || []).some((x) => x.name.includes('女尊'));
  ok(has, '找到小说素材目录');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 404 与错误 ===');
{
  ok((await req('GET', '/api/worlds/nope')).status === 404, '未知世界卡 404');
  ok((await req('GET', '/api/sessions/nope')).status === 404, '未知会话 404');
  ok((await req('GET', '/api/sessions/nope/memory')).status === 404, '未知会话记忆 404');
  const bad = await req('POST', '/api/worlds', { card: {} });
  ok(bad.status === 400, '缺 title 的世界卡 400');
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== 清理 ===');
{
  const d = await req('DELETE', `/api/worlds/${WORLD_ID}`);
  ok(d.status === 200, '删除世界卡');
  ok((await req('GET', `/api/worlds/${WORLD_ID}`)).status === 404, '删后查不到');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`test-api: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
