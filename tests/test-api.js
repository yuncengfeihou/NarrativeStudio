#!/usr/bin/env node
/**
 * tests/test-api.js — HTTP 集成测试（需要服务端已启动，不调用 LLM）
 *
 *   node tests/test-api.js [baseUrl]
 *
 * 覆盖：配置、世界卡 CRUD 与导出、辞书钉选、会话生命周期（含锚点）、
 *       记忆六表读取、断言手增、分支/回滚、404 处理。
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
  cast: [{
    id: 'a', name: '阿砚', aliases: ['砚哥'], role: '囚犯',
    voice: { rhythm: '短句', exemplars: ['「别信他。」'] },
    psyche: { wants: ['出去'], hides: ['钥匙在他鞋里'] },
    knowledge: { knows: ['钥匙的位置'], does_not_know: ['对方也知道'] },
    agenda: [{ goal: '拿到钥匙', method: '装睡', pressure: 0.8 }],
  }],
  codex: [{
    id: 'room', type: 'place', name: '屋子', tags: ['封闭'],
    summary: '没有窗，一张桌，两把椅子。', facets: { sensory: '石灰味' },
    links: ['cast:a'],
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
  ok(data.card?.version === 4, '落库的是 v4 形状');
  ok(data.codex?.length === 1, '辞书投影表同步');

  const list = await req('GET', '/api/worlds');
  const found = list.data.find((w) => w.id === WORLD_ID);
  ok(!!found, '列表里能查到');
  ok(found.card.codex_count === 1, '摘要里有辞书数');
  ok(found.card.anchors?.[0]?.label === '开局 · 屋内', '摘要里有可玩时间点');

  const one = await req('GET', `/api/worlds/${WORLD_ID}`);
  ok(one.data.card.timeline.length === 2, '详情含时间线');
  ok(one.data.card.cast[0].psyche.hides[0] === '钥匙在他鞋里', '详情含卡司私心');

  const lint = await req('GET', `/api/worlds/${WORLD_ID}/lint`);
  ok(lint.status === 200 && Array.isArray(lint.data.issues), '卡级 lint 接口可达');
  ok(lint.data.counts?.entities >= 1, 'lint 返回实体计数');

  const text = await fetch(`${BASE}/api/worlds/${WORLD_ID}/export`).then((r) => r.text());
  ok(text.includes('# 接口测试世界'), '导出纯文本');
  ok(text.includes('[future]'), '导出标出 future 供人看');
  ok(text.includes('其中一人走出去'), '导出含 future 事件内容');

  const patch = await req('PATCH', `/api/worlds/${WORLD_ID}`, { card: { prompt: { premise: '改过的命题' } } });
  ok(patch.data.card.prompt.premise === '改过的命题', '局部更新');
  ok(patch.data.card.cast.length === 1, '局部更新不丢卡司');
}

{
  const { status, data } = await req('POST', `/api/worlds/${WORLD_ID}/codex/room/pin`, { pinned: true });
  ok(status === 200 && data.codex.find((c) => c.codex_id === 'room')?.pinned === true, '钉选辞书');
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
