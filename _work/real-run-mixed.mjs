#!/usr/bin/env node
/**
 * _work/real-run-mixed.mjs — 真实模型「混入低张力行动」验证跑（P7）
 *
 *   node _work/real-run-mixed.mjs [--turns 8] [--world nvzun-jianpolan]
 *                                 [--anchor prologue] [--profile time]
 *                                 [--base http://127.0.0.1:3210]
 *
 * 走真实产品路径：新建会话 → 开局 → 逐轮玩家行动（刻意混入低张力/等待/回避/
 * 次日再来）。用于验证三件事是否真的发生：
 *   1) 时间能推进（场记单「时间」标签变化、跨日）；
 *   2) 走向不必每条下注（branches 的 tone/tension 分布）；
 *   3) 世界呼吸的幕外流言进入场记单压力段（context.scene_sheet 的「幕外：」行）。
 *
 * 只走 HTTP/SSE，不直接读写记忆表；原始记录落到 _work/tmp-realrun-<session>.jsonl。
 * 跑完用 node _work/longrun-report.mjs <session_id> 对比验收口径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const BASE = opt('base', process.env.TEST_BASE_URL || 'http://127.0.0.1:3210');
const WORLD = opt('world', 'nvzun-jianpolan');
const ANCHOR = opt('anchor', 'prologue');
const TURNS = Number(opt('turns', 8));

// 行动采样：至少 1/3 是低张力/等待/回避/时间推进；同时保留少量目标推进，
// 避免把「日常」跑成没有主线的散步。
const ACTIONS_DEFAULT = [
  '先不急着走，跟着她的话应下来，看看她到底想要什么。',
  '留在原地不动，等雨小一点再说。',
  '先把玉佩收好，回去睡一觉，明天再来这条街打听。',
  '去找个茶楼坐坐，听听街上的人都在说什么。',
  '绕开东街十五路，不想再碰那件事。',
  '顺路去看看黎婆，问问她最近身子怎么样。',
  '该谈正事了，去司楼找伍卿把话说清楚，但不带威胁。',
  '这一趟先到此为止，回去把今天听到的理一理。',
];

// 时间推进探针：每一拍都给出了「这一拍可以到此为止」的出口，用来验证
// 旁白尾注的「可以直接把时间推到次日/更晚」是否真的被用上。
const ACTIONS_TIME = [
  '把钱袋揣好，牵着牛掉头回村，天黑前不再进城。',
  '到家给黎婆熬药，收拾完就睡下；明天天亮再说。',
  '第二天中午才出门，慢悠悠走到茶楼坐下。',
  '在茶楼坐一整个下午，什么也不打听，只听。',
  '傍晚回家，把今天听到的理一理，早早歇下。',
];

const PROFILE = opt('profile', 'default');
const ACTIONS = PROFILE === 'time' ? ACTIONS_TIME : ACTIONS_DEFAULT;

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** 读 SSE 直到响应结束；每帧 data: {json}。 */
async function sse(p, body, onEvent) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`${p} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let at;
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, at);
      buf = buf.slice(at + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }
        onEvent(evt);
      }
    }
  }
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const tailOf = (s, n = 110) => norm(s).slice(-n);
const whenOf = (sheet) => (String(sheet || '').match(/时间[：: ]\s*([^\n｜]*)/) || [])[1]?.trim() || '';
const placeOf = (sheet) => (String(sheet || '').match(/地点[：: ]\s*([^\n｜]*)/) || [])[1]?.trim() || '';
const rumorsOf = (sheet) => String(sheet || '').match(/幕外：[^\n]*/g) || [];

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const records = [];
let sessionId = '';

function log(...a) { console.log(...a); }

async function oneTurn({ phase, turnNo, playerText, isOpening, branchChoice }) {
  const ctx = { scene_sheet: '', when: '', place: '', rumors: [], budget: null, meta: null };
  const branches = [];
  let narrative = '';
  const errors = [];
  const started = Date.now();
  log(`\n── ${phase}（turn_no=${turnNo}）────────────────────────────`);
  if (playerText) log(`行动：${playerText}`);
  await sse(
    isOpening ? `/api/sessions/${sessionId}/opening` : `/api/sessions/${sessionId}/turn`,
    isOpening ? {} : { playerText, branchChoice: branchChoice || null, generateBranches: true },
    (evt) => {
      if (evt.type === 'context') {
        ctx.scene_sheet = evt.scene_sheet || '';
        ctx.when = whenOf(ctx.scene_sheet);
        ctx.place = placeOf(ctx.scene_sheet);
        ctx.rumors = rumorsOf(ctx.scene_sheet);
        ctx.budget = evt.budget || null;
        ctx.meta = evt.meta ? { plan: evt.meta.plan, coverage: evt.meta.coverage, degraded: evt.meta.degraded } : null;
      } else if (evt.type === 'narrative') {
        narrative += evt.delta || '';
      } else if (evt.type === 'branches') {
        for (const b of evt.branches || []) branches.push({ title: b.title, tone: b.tone, tension: b.tension_delta, description: b.description });
      } else if (evt.type === 'error') {
        errors.push(evt.message || 'error');
      } else if (evt.type === 'memory' && evt.degraded) {
        errors.push(`memory degraded: ${evt.stats?.error || ''}`);
      }
    },
  );
  const secs = Math.round((Date.now() - started) / 1000);
  const rec = {
    phase, turn_no: turnNo, action: playerText || '(开场)', session_id: sessionId,
    when: ctx.when, place: ctx.place, rumors: ctx.rumors, scene_sheet: ctx.scene_sheet,
    branches, narrative, errors, seconds: secs,
    context_meta: ctx.meta, budget: ctx.budget,
  };
  records.push(rec);
  const toneText = branches.length
    ? branches.map((b) => `${b.tone || '?'}${b.tension >= 0 ? '+' : ''}${b.tension ?? '?'}`).join(' ')
    : '(无)';
  log(`正文 ${narrative.length} 字｜${secs}s｜时间「${ctx.when || '?'}」｜地点「${ctx.place || '?'}」`);
  log(`走向 ${branches.length} 条：${toneText}`);
  if (branches.length) log(`  首条：${branches[0].title}｜${tailOf(branches[0].description, 60)}`);
  if (ctx.rumors.length) log(`场记单幕外：${ctx.rumors.join(' ｜ ')}`);
  if (ctx.scene_sheet) {
    const sheetTail = tailOf(ctx.scene_sheet, 260);
    log(`场记单尾部：…${sheetTail}`);
  }
  log(`正文尾部：…${tailOf(narrative, 90)}`);
  if (errors.length) log(`⚠ 错误：${errors.join(' / ')}`);
  return rec;
}

// ── 1) 建会话 ───────────────────────────────────────────────────────────
const created = await api('POST', '/api/sessions', {
  world_id: WORLD,
  title: `机制验证·混合行动 ${stamp}`,
  anchor_id: ANCHOR || undefined,
});
sessionId = created.id;
log(`会话 ${sessionId}｜world=${WORLD}｜anchor=${ANCHOR}｜计划 ${TURNS} 轮（含开场共 ${TURNS + 1} 拍）`);

// ── 2) 开场 + 逐轮 ─────────────────────────────────────────────────────
await oneTurn({ phase: '开场', turnNo: 1, isOpening: true });
for (let i = 0; i < TURNS; i++) {
  const action = ACTIONS[i % ACTIONS.length];
  await oneTurn({ phase: `第 ${i + 1} 轮`, turnNo: i + 2, playerText: action });
}

// ── 3) 落地记录与汇总 ───────────────────────────────────────────────────
const outFile = path.join(__dirname, `tmp-realrun-${sessionId}.jsonl`);
fs.writeFileSync(outFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
const allRumors = records.flatMap((r) => r.rumors);
log('\n════════════ 汇总 ════════════');
log(`会话        ${sessionId}`);
log(`回合        ${records.length} 拍（开场 + ${TURNS} 轮玩家行动）`);
log(`用时        ${records.reduce((a, r) => a + r.seconds, 0)}s`);
log(`正文        总 ${records.reduce((a, r) => a + r.narrative.length, 0)} 字；逐拍 ${records.map((r) => r.narrative.length).join(' / ')}`);
log(`时间标签    ${[...new Set(records.map((r) => r.when).filter(Boolean))].join(' → ')}`);
log(`走向形态    ${records.flatMap((r) => r.branches).map((b) => b.tone).join(' ') || '(无)'}`);
log(`幕外流言    ${allRumors.length} 行${allRumors.length ? `：${[...new Set(allRumors)].slice(0, 6).join(' ｜ ')}` : ''}`);
log(`错误        ${records.flatMap((r) => r.errors).length ? records.flatMap((r) => r.errors).join(' / ') : '无'}`);
log(`原始记录    ${outFile}`);
log(`\n下一步：node _work/longrun-report.mjs ${sessionId}`);
