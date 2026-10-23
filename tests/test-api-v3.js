#!/usr/bin/env node
/**
 * test-api-v3.js — 新增 HTTP 端点的集成测试（需服务已启动）
 *
 * 覆盖：presets / notes / entities / facts / state / turns / rollback / search
 * 不产生 LLM 调用，因此无需 API Key。
 *
 * 用法：BASE=http://127.0.0.1:3210 node tests/test-api-v3.js
 */
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:3210';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

console.log(`\n[api-v3] BASE = ${BASE}\n`);

let sessionId = null;

/* ------------------------------------------------------------------ */
/* 可达性                                                             */
/* ------------------------------------------------------------------ */
await test('服务可达（GET /api/config）', async () => {
  const cfg = await req('/api/config');
  assert.ok(cfg.models?.default, '应返回默认模型');
  assert.ok(cfg.limits?.context_max_tokens > 0);
});

/* ------------------------------------------------------------------ */
/* 预设                                                              */
/* ------------------------------------------------------------------ */
await test('presets：列表包含女尊剧本', async () => {
  const list = await req('/api/presets');
  assert.ok(Array.isArray(list));
  const hit = list.find((p) => p.id === 'nvzun-jianpolan');
  assert.ok(hit, '应存在 nvzun-jianpolan 预设');
  assert.ok(hit.characters.length >= 8, `角色数应 ≥ 8，实际 ${hit.characters.length}`);
  assert.ok(hit.tags.includes('女尊男卑'));
});

await test('presets：详情含完整 settings 字段', async () => {
  const p = await req('/api/presets/nvzun-jianpolan');
  const s = p.settings;
  assert.ok(s.title && s.worldview && s.player_role && s.opening && s.rules);
  assert.ok(s.worldview.length > 500, 'worldview 应有实质长度');
  assert.ok(s.characters.some((c) => c.name === '凌玥'));
  assert.ok(s.characters.every((c) => c.name && c.voice), '每个角色都应有 name 与 voice');
});

await test('presets：404 处理', async () => {
  const res = await fetch(`${BASE}/api/presets/__nonexistent__`);
  assert.equal(res.status, 404);
});

/* ------------------------------------------------------------------ */
/* 建会话（用预设 settings）                                            */
/* ------------------------------------------------------------------ */
await test('sessions：由预设创建会话', async () => {
  const p = await req('/api/presets/nvzun-jianpolan');
  const s = p.settings;
  const created = await req('/api/sessions', {
    method: 'POST',
    body: { title: `[test] ${s.title}`, settings: s },
  });
  assert.ok(created.id);
  sessionId = created.id;
});

/* ------------------------------------------------------------------ */
/* 笔记                                                              */
/* ------------------------------------------------------------------ */
let noteId = null;

await test('notes：新增', async () => {
  const r = await req(`/api/sessions/${sessionId}/notes`, {
    method: 'POST',
    body: { content: '黎婆其实是凌家的旧识', kind: 'note' },
  });
  assert.ok(r.id);
  noteId = r.id;
  assert.ok(r.notes.some((n) => n.content.includes('黎婆')));
});

await test('notes：修改（停用）', async () => {
  const r = await req(`/api/sessions/${sessionId}/notes/${noteId}`, {
    method: 'PATCH', body: { active: false },
  });
  const n = r.notes.find((x) => x.id === noteId);
  assert.equal(n.active, 0);
});

await test('notes：空内容被拒（400）', async () => {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '   ' }),
  });
  assert.equal(res.status, 400);
});

await test('notes：删除', async () => {
  const r = await req(`/api/sessions/${sessionId}/notes/${noteId}`, { method: 'DELETE' });
  assert.ok(!r.notes.some((x) => x.id === noteId));
});

/* ------------------------------------------------------------------ */
/* 事实                                                              */
/* ------------------------------------------------------------------ */
let factId = null;

await test('facts：新增作者钦定事实', async () => {
  const r = await req(`/api/sessions/${sessionId}/facts`, {
    method: 'POST',
    body: { subject: '伍卿', predicate: '左腿有旧疾', object: '不能奔跑' },
  });
  assert.ok(r.id);
  factId = r.id;
  assert.ok(r.facts.some((f) => f.subject === '伍卿'));
});

await test('facts：缺字段被拒（400）', async () => {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/facts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: 'x' }),
  });
  assert.equal(res.status, 400);
});

await test('facts：固定 + 撤回', async () => {
  await req(`/api/sessions/${sessionId}/facts/${factId}`, { method: 'PATCH', body: { pinned: true } });
  const r = await req(`/api/sessions/${sessionId}/facts/${factId}`, { method: 'DELETE' });
  assert.ok(!r.facts.some((f) => f.id === factId), '撤回后默认列表不应包含');
});

/* ------------------------------------------------------------------ */
/* 状态                                                              */
/* ------------------------------------------------------------------ */
await test('state：人工修正状态快照', async () => {
  const state = {
    time: '初冬·午后',
    location: '湘曲市商务大厦门口',
    weather: '大雨',
    tension: 0.7,
    inventory: ['生锈的钥匙'],
    quests: [{ goal: '确认奶奶安全', status: 'active' }],
    threads: ['凌玥为何认得伍卿'],
  };
  const r = await req(`/api/sessions/${sessionId}/state`, {
    method: 'PUT', body: { state, turn_no: 0 },
  });
  assert.equal(r.state.location, state.location);

  const mem = await req(`/api/sessions/${sessionId}/memory`);
  assert.equal(mem.state.location, state.location);
  assert.equal(mem.state.tension, 0.7);
});

/* ------------------------------------------------------------------ */
/* 记忆统计                                                          */
/* ------------------------------------------------------------------ */
await test('memory：返回完整统计结构', async () => {
  const m = await req(`/api/sessions/${sessionId}/memory`);
  assert.ok(Array.isArray(m.tiers) && m.tiers.length === 4, '应有 4 层');
  assert.ok(Array.isArray(m.archived_tiers));
  assert.equal(typeof m.context_tokens, 'number');
  assert.equal(typeof m.context_max, 'number');
  assert.equal(typeof m.compression, 'number');
  assert.ok(Array.isArray(m.entities));
  assert.ok(Array.isArray(m.facts));
  assert.ok(Array.isArray(m.notes));
  assert.ok(m.budget && typeof m.budget.notes === 'number');
  assert.ok(m.context_tokens <= m.context_max * 1.2, '上下文估算应大致在预算内');
});

/* ------------------------------------------------------------------ */
/* 回合检索                                                          */
/* ------------------------------------------------------------------ */
await test('turns：分页端点', async () => {
  const r = await req(`/api/sessions/${sessionId}/turns?from=1&to=10`);
  assert.ok(Array.isArray(r.turns));
  assert.equal(typeof r.total, 'number');
});

await test('search：空查询返回空结果', async () => {
  const r = await req(`/api/sessions/${sessionId}/search?q=`);
  assert.deepEqual(r.hits, []);
});

/* ------------------------------------------------------------------ */
/* 回滚边界                                                          */
/* ------------------------------------------------------------------ */
await test('rollback：入参校验（负数 → 400）', async () => {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/rollback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turn_no: -1 }),
  });
  assert.equal(res.status, 400);
});

await test('rollback：空会话回滚到 0 不报错', async () => {
  const r = await req(`/api/sessions/${sessionId}/rollback`, {
    method: 'POST', body: { turn_no: 0 },
  });
  assert.equal(r.turn_no, 0);
  assert.ok(r.memoryStats);
});

/* ------------------------------------------------------------------ */
/* 清理                                                              */
/* ------------------------------------------------------------------ */
await test('清理测试会话', async () => {
  await req(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  const res = await fetch(`${BASE}/api/sessions/${sessionId}`);
  assert.equal(res.status, 404);
});

console.log(`\n[api-v3] ${passed}/${passed + failed} 通过`);
if (failed > 0) {
  console.error('SOME API-V3 TESTS FAILED');
  process.exit(1);
}
console.log('ALL API-V3 TESTS PASSED');
