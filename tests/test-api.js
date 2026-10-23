#!/usr/bin/env node
/**
 * tests/test-api.js — HTTP 集成测试（需要服务端已启动，不调用 LLM）
 *
 *   node tests/test-api.js [baseUrl]
 *
 * 覆盖：配置、世界卡 CRUD、词条 CRUD、会话生命周期、记忆读取、
 *       回滚、状态修正、404 处理。
 */
const BASE = process.argv[2] || 'http://localhost:3210';

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

/* ------------------------------------------------------------------ */

console.log(`\n=== 连通性 (${BASE}) ===`);
try {
  const { status } = await req('GET', '/api/config');
  ok(status === 200, '服务端可达');
} catch (err) {
  console.log(`  ✗ 无法连接 ${BASE} — ${err.message}`);
  console.log('\n请先启动服务：node server/index.js');
  process.exit(1);
}

console.log('\n=== 配置 ===');
{
  const { data } = await req('GET', '/api/config');
  ok(data.models?.default, '返回默认模型');
  ok(data.limits?.context_soft_tokens > 0, '返回上下文软目标');
  ok(data.budget?.world > 0 && data.budget?.lore > 0, '返回分层配额');
  ok(typeof data.defaults?.reflect_every === 'number', '返回反思间隔');
}

console.log('\n=== 世界卡 ===');
const wid = `test-world-${Date.now()}`;
{
  const created = await req('POST', '/api/worlds', {
    id: wid,
    title: '集成测试世界',
    subtitle: '仅用于测试',
    cover_hue: 120,
    tags: ['测试'],
    card: {
      title: '集成测试世界',
      subtitle: '仅用于测试',
      genre: ['测试'],
      style: { pov: '第三人称', voice: '短句', length: '1000字', tense: '过去时' },
      charter: [{ rule: '这是测试世界的规则' }],
      player: { name: '测试者', identity: '测试身份', capability: '只会测试' },
      cast: [
        { name: '甲', role: '角色甲', weight: 1 },
        { name: '乙', role: '角色乙', always: true },
      ],
      arcs: [{ title: '测试幕', turns: 4, goal: '验证', beats: ['节拍一'] }],
      arc_turns: 4,
      bans: ['不得出戏'],
      opening_seed: '天亮了。',
      opening_state: { time: '清晨', location: '测试场', weather: '晴', tension: 0.2 },
    },
    lore: [
      { keys: ['测试词'], title: '测试词条', content: '这是测试词条内容', category: 'setting', priority: 60 },
      { keys: [], title: '常驻测试', content: '常驻内容', category: 'setting', priority: 90, constant: true },
    ],
  });
  ok(created.status === 201, '创建世界卡 → 201');
  ok(created.data.id === wid, '世界卡 id 正确');

  const list = await req('GET', '/api/worlds');
  ok(Array.isArray(list.data) && list.data.some((w) => w.id === wid), '列表包含新卡');

  const one = await req('GET', `/api/worlds/${wid}`);
  ok(one.data.card?.charter?.length === 1, '读取宪章');
  ok(one.data.card?.cast?.length === 2, '读取卡司');
  ok(one.data.card?.arcs?.length === 1, '读取幕');
  ok(one.data.lore.length === 2, '读取词条');

  const patched = await req('PATCH', `/api/worlds/${wid}`, { subtitle: '改过的简介' });
  ok(patched.data.subtitle === '改过的简介', '局部更新简介');
  ok(patched.data.card?.charter?.length === 1, '局部更新不丢宪章');
}

console.log('\n=== 词条 CRUD ===');
{
  const added = await req('POST', `/api/worlds/${wid}/lore`, {
    keys: ['新词'], title: '新增词条', content: '新增内容', category: 'setting', priority: 40,
  });
  ok(added.status === 201, '新增词条 → 201');
  ok(added.data.lore.length === 3, '词条数增加到 3');

  const entryId = added.data.lore.find((e) => e.title === '新增词条').id;
  const upd = await req('PATCH', `/api/worlds/${wid}/lore/${entryId}`, { content: '改过的内容' });
  ok(upd.data.lore.find((e) => e.id === entryId).content === '改过的内容', '修改词条内容');

  const del = await req('DELETE', `/api/worlds/${wid}/lore/${entryId}`);
  ok(del.data.lore.length === 2, '删除词条');

  const empty = await req('POST', `/api/worlds/${wid}/lore`, { content: '' });
  ok(empty.status === 400, '空内容词条 → 400');
}

console.log('\n=== 会话生命周期 ===');
let sid = null;
{
  const created = await req('POST', `/api/worlds/${wid}/sessions`, { title: '集成测试剧情' });
  ok(created.status === 201, '从世界卡开局 → 201');
  sid = created.data.id;
  ok(created.data.world_id === wid, '会话关联世界卡');

  const detail = await req('GET', `/api/sessions/${sid}`);
  ok(detail.data.session.id === sid, '读取会话详情');
  ok(detail.data.world?.title === '集成测试世界', '详情带世界卡信息');
  ok(Array.isArray(detail.data.turns) && detail.data.turns.length === 0, '新会话没有回合');

  const list = await req('GET', `/api/sessions?world_id=${wid}`);
  ok(list.data.some((s) => s.id === sid), '按世界卡筛选会话');

  const mem = await req('GET', `/api/sessions/${sid}/memory`);
  ok(mem.status === 200, '读取记忆统计');
  ok(mem.data.context_max > 0, '记忆统计带上下文上限');
  ok(Array.isArray(mem.data.tiers) && mem.data.tiers.length === 4, '记忆统计带四层');

  // 笔记
  const note = await req('POST', `/api/sessions/${sid}/notes`, { content: '测试者的左腿有旧伤', kind: 'note' });
  ok(note.status === 201 && note.data.notes.length === 1, '新增笔记');
  const noteId = note.data.notes[0].id;
  const toggled = await req('PATCH', `/api/sessions/${sid}/notes/${noteId}`, { active: false });
  ok(toggled.data.notes[0].active === 0, '停用笔记');
  await req('DELETE', `/api/sessions/${sid}/notes/${noteId}`);

  // 事实
  const fact = await req('POST', `/api/sessions/${sid}/facts`, {
    subject: '测试者', predicate: '患有', object: '旧伤',
  });
  ok(fact.status === 201, '新增事实');

  // 状态修正
  const st = await req('PUT', `/api/sessions/${sid}/state`, {
    state: { time: '第二天', location: '测试场', tension: 0.6 }, turn_no: 0,
  });
  ok(st.data.state.time === '第二天', '修正场景账本');
}

console.log('\n=== 错误处理 ===');
{
  ok((await req('GET', '/api/worlds/不存在')).status === 404, '不存在的世界卡 → 404');
  ok((await req('GET', '/api/sessions/不存在')).status === 404, '不存在的会话 → 404');
  ok((await req('GET', '/api/nonexistent')).status === 404, '未知 API 路径 → 404');
  ok((await req('POST', '/api/worlds', {})).status === 400, '缺字段创建世界卡 → 400');
}

console.log('\n=== 清理 ===');
{
  await req('DELETE', `/api/sessions/${sid}`);
  const gone = await req('GET', `/api/sessions/${sid}`);
  ok(gone.status === 404, '会话已删除');

  await req('DELETE', `/api/worlds/${wid}`);
  ok((await req('GET', `/api/worlds/${wid}`)).status === 404, '世界卡已删除');
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`API 集成：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
