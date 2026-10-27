#!/usr/bin/env node
/**
 * _work/longrun-compare.mjs — 长跑分段对比（第一段 vs 第二段）
 *
 *   node _work/longrun-compare.mjs <session-id> [--split 46]
 *
 * 目的：`longrun-report.mjs` 判的是「整局」；长度拉长后需要回答的是
 * **「同一会话的后半段有没有比前半段更差」**，所以要按 turn_no 切两段、
 * 用同一套公式分别算，再并排放。
 *
 * 只读 `data/roleplay.db` 与 `_work/tmp-longrun-<sid>.jsonl`，不改任何东西。
 * 判据说明全部写在输出里；阈值与 `longrun-baseline.md` §10 一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const sessionId = argv.find((a) => !a.startsWith('--'));
/**
 * 分段点：**第二阶段第一拍**。第一阶段是 t1–t46（开场 + 45 次玩家行动），
 * 第二阶段从 t47 起。默认 47；换成别的值时必须重新核对两段各含多少拍。
 */
const split = Number((() => {
  const i = argv.indexOf('--split');
  return i >= 0 ? argv[i + 1] : 0;
})()) || 47;

if (!sessionId) {
  console.error('用法: node _work/longrun-compare.mjs <session-id> [--split 46]');
  process.exit(2);
}

const db = new DatabaseSync('data/roleplay.db', { readOnly: true });
const turns = db
  .prepare(
    `select turn_no, kind, content, meta_json, usage_json, created_at
       from turns where session_id = ? order by turn_no asc, id asc`
  )
  .all(sessionId);
const scenes = db
  .prepare(`select scene_id, turn_from, turn_to, when_label, place from scenes where session_id = ? order by turn_from asc`)
  .all(sessionId);
const session = db.prepare('select usage_json from sessions where id = ?').get(sessionId);
db.close();

const charLen = (s) => [...String(s ?? '')].length;
const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const quantile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const slope = (pts) => {
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? num / den : null;
};
const r1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

/* ── 分段 ─────────────────────────────────────────────────────────────── */
const narrAll = turns.filter((t) => t.kind === 'narrator');
const bySegment = (from, to) => narrAll.filter((t) => Number(t.turn_no) >= from && Number(t.turn_no) <= to);

const segA = bySegment(1, split - 1);
const segB = bySegment(split, Infinity);
const maxTurnNo = Math.max(0, ...narrAll.map((t) => Number(t.turn_no)));
const SEGS = [
  { name: `A 段`, rows: segA },
  { name: `B 段`, rows: segB },
];

const jsonlFile = path.join(__dirname, `tmp-longrun-${sessionId}.jsonl`);
const jsonl = [];
if (fs.existsSync(jsonlFile)) {
  for (const line of fs.readFileSync(jsonlFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.phase) jsonl.push(r); } catch { /* 忽略半行 */ }
  }
}
// jsonl 的拍号隐在 phase 里（`第 N 拍（turn_no=M）`），取 turn_no 更可靠。
const jsonlByTurn = new Map();
for (const r of jsonl) {
  const m = /turn_no=(\d+)/.exec(String(r.phase || ''));
  if (m) jsonlByTurn.set(Number(m[1]), r);
}

/* ── 逐段指标 ─────────────────────────────────────────────────────────── */
function segmentStats({ name, rows }) {
  const chars = rows.map((t) => charLen(t.content));
  const nos = rows.map((t) => Number(t.turn_no));
  const budgets = rows.map((t) => {
    // `asm.budget` 是**扁平**对象：{ system, archive, summary, recent, scene, retrieval, current, total }。
    // 早先按 { total, layers } 读会全取到 0，静默输出空层状——这条注释就是防止再次读错。
    const asm = safeJson(t.meta_json)?.assembly || {};
    const b = asm.budget || {};
    const { total, ...layers } = b;
    return {
      no: Number(t.turn_no),
      total: Number(total || 0),
      layers,
      degraded: asm.degraded || [],
    };
  });
  const budgetSlope = slope(budgets.filter((b) => b.total > 0).map((b) => [b.no, b.total]));
  const reason = [];
  const echo = [];
  for (const t of rows) {
    const r = jsonlByTurn.get(Number(t.turn_no));
    if (r) reason.push(Number(r.reasoning_chars || 0));
    // 回声率：玩家行动 2-gram 在旁白中的覆盖率（确定性代理，见 baseline §A2）
    const p = jsonlByTurn.get(Number(t.turn_no));
    if (p && p.action && p.action !== '(开场)') {
      const a = String(p.action).replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
      const n = String(t.content).replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
      const grams = new Set();
      for (let i = 0; i + 2 <= a.length; i++) grams.add(a.slice(i, i + 2));
      if (grams.size) {
        let hit = 0;
        for (const g of grams) if (n.includes(g)) hit++;
        echo.push(hit / grams.size);
      }
    }
  }
  const secs = [];
  for (const t of rows) {
    const r = jsonlByTurn.get(Number(t.turn_no));
    if (r) secs.push(Number(r.seconds || 0));
  }
  const lastLayer = budgets.filter((b) => b.total > 0).at(-1)?.layers || {};
  const peak = Math.max(0, ...budgets.map((b) => b.total));
  const degradedCount = budgets.filter((b) => Array.isArray(b.degraded) && b.degraded.length).length;
  const inRange = chars.filter((c) => c >= 1200 && c <= 2000).length;
  return {
    name,
    turns: rows.length,
    chars: { mean: mean(chars), p50: quantile(chars, 0.5), min: Math.min(...chars), max: Math.max(...chars), inRange, inRangeRate: inRange / (chars.length || 1) },
    reasoning: { mean: mean(reason), p90: quantile(reason, 0.9) },
    echo: { mean: mean(echo), p50: quantile(echo, 0.5) },
    seconds: { mean: mean(secs), p50: quantile(secs, 0.5), p90: quantile(secs, 0.9), max: Math.max(0, ...secs) },
    budget: { slope: budgetSlope, peak, lastLayers: lastLayer, degradedCount },
  };
}

/* ── 局部重复率（5-gram vs 前 3 拍，与 report.mjs 同公式） ─────────────── */
function localRepeat(rows, n = 5, back = 3) {
  const grams = (s) => {
    const t = String(s).replace(/\s+/g, '');
    const set = new Set();
    for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
    return set;
  };
  const gs = rows.map((t) => grams(t.content));
  const out = [];
  for (let i = 0; i < gs.length; i++) {
    const prev = new Set();
    for (let k = Math.max(0, i - back); k < i; k++) for (const g of gs[k]) prev.add(g);
    if (!prev.size || !gs[i].size) continue;
    let hit = 0;
    for (const g of gs[i]) if (prev.has(g)) hit++;
    out.push({ turn_no: Number(rows[i].turn_no), rate: hit / gs[i].size });
  }
  return out;
}

/**
 * 必须**在整条序列上**算一次再切片。
 * 逐段算会让每段开头几拍的「前 3 拍」为空或不足（B 段第一拍 t46 没有前文），
 * 于是 t47 的对照只有 t46 一条 → 重复率虚高到 23.9%。这是分段统计的经典陷阱，
 * 实测踩到过，记在这里防止改回去。
 */
const repeatAll = localRepeat(narrAll);
const repA = repeatAll.filter((r) => r.turn_no <= split - 1);
const repB = repeatAll.filter((r) => r.turn_no >= split);

/* ── 输出 ─────────────────────────────────────────────────────────────── */
const A = segmentStats(SEGS[0]);
const B = segmentStats(SEGS[1]);

console.log('═'.repeat(20) + ' 分段对比 ' + '═'.repeat(20));
console.log(`会话 ${sessionId}｜分段点 turn_no=${split}｜
A 段 ${A.turns} 拍（t1–t${split - 1}）｜B 段 ${B.turns} 拍（t${split}–t${maxTurnNo}）`);
console.log('');

const row = (label, a, b, note = '') => {
  const warn = note ? `  ${note}` : '';
  console.log(`  ${label.padEnd(22)} A=${String(a).padStart(9)}   B=${String(b).padStart(9)}${warn}`);
};
// 少于 5 个点算斜率没有意义（两点必过直线），直接标出来，免得读者把 1947 tok/轮当真。
const slopeText = (seg) => (seg.turns >= 5 ? r1(seg.budget.slope) : `样本不足(${seg.turns}拍)`);
console.log('── 正文长度（卡要求 1200–2000 字）');
row('均值', r1(A.chars.mean), r1(B.chars.mean));
row('中位数', r1(A.chars.p50), r1(B.chars.p50));
row('min / max', `${A.chars.min}/${A.chars.max}`, `${B.chars.min}/${B.chars.max}`);
row('合规率', pct(A.chars.inRange, A.turns), pct(B.chars.inRange, B.turns));

console.log('\n── 推理长度（reasoning_chars）');
row('均值', r1(A.reasoning.mean), r1(B.reasoning.mean));
row('p90', r1(A.reasoning.p90), r1(B.reasoning.p90));

console.log('\n── 玩家行动回声率（2-gram 覆盖率）');
row('均值', pct(A.echo.mean, 1), pct(B.echo.mean, 1));
row('中位数', pct(A.echo.p50, 1), pct(B.echo.p50, 1));

console.log('\n── 单拍耗时');
row('均值 s', r1(A.seconds.mean), r1(B.seconds.mean));
row('p50 / p90', `${r1(A.seconds.p50)}/${r1(A.seconds.p90)}`, `${r1(B.seconds.p50)}/${r1(B.seconds.p90)}`);
row('max s', r1(A.seconds.max), r1(B.seconds.max));

console.log('\n── 预算');
row('斜率 tok/轮', slopeText(A), slopeText(B), 'B 段天然偏低（archive 已积满），只看是否仍为正');
row('峰值 total', A.budget.peak, B.budget.peak);
row('降级拍数', A.budget.degradedCount, B.budget.degradedCount);
console.log(`  A 末拍层状 ${JSON.stringify(A.budget.lastLayers)}`);
console.log(`  B 末拍层状 ${JSON.stringify(B.budget.lastLayers)}`);

console.log('\n── 局部重复率（5-gram vs 前 3 拍，WARN 线 12%）');
const over = (rs) => rs.filter((r) => r.rate > 0.12);
row('均值', pct(mean(repA.map((r) => r.rate)), 1), pct(mean(repB.map((r) => r.rate)), 1));
row('p90', pct(quantile(repA.map((r) => r.rate), 0.9), 1), pct(quantile(repB.map((r) => r.rate), 0.9), 1));
row('越线拍数', `${over(repA).length}/${repA.length}`, `${over(repB).length}/${repB.length}`,
  over(repB).length ? `越线：${over(repB).map((r) => `t${r.turn_no}:${(r.rate * 100).toFixed(1)}%`).join(' ')}` : '');

console.log('\n── 场次');
const sceneIn = (seg) => scenes.filter((s) => {
  const from = Number(s.turn_from), to = Number(s.turn_to);
  return seg[0] <= from && from <= seg[1];
});
const sa = sceneIn([1, split - 1]), sb = sceneIn([split, maxTurnNo]);
row('场次数', sa.length, sb.length);
row('拍/场', r1(A.turns / (sa.length || 1)), sa.length || sb.length ? r1(B.turns / (sb.length || 1)) : '样本不足');
row('时间标签种类', new Set(sa.map((s) => s.when_label)).size, new Set(sb.map((s) => s.when_label)).size);

const usage = safeJson(session?.usage_json) || {};
console.log('\n── 会话累计用量（不可分段，仅供成本口径）');
console.log(`  requests=${usage.requests} prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} cached=${usage.cached_tokens}`);

/* ── Q 组探针（第二阶段） ────────────────────────────────────────────── */
/**
 * 拍号 → turn_no 的对应关系：**turn_no = 拍号 + 1**。
 * 开场是 turn_no=1（没有玩家行动），第 N 拍玩家行动落在 turn_no=N+1。
 * 基准 §10.3 写的是「拍号」，这里必须换算，否则每个探针都会核对到隔壁一拍。
 * 第一阶段踩过一次同类错位（P 组按拍号查 turn_no），所以换算写在数据定义里，
 * 不要让读代码的人自己去推。
 */
const PROBES = [
  { id: 'Q1', plant: 48, recall: 58, what: '掌心红印拓纸塞鞋底', must: ['鞋', '纸'] },
  { id: 'Q2', plant: 50, recall: 61, what: '许映给的旧钢笔', must: ['笔'] },
  { id: 'Q3', plant: 52, recall: 62, what: '账本封面上的名字', must: ['账本'] },
  { id: 'Q4', plant: 55, recall: 64, what: '奶奶的半块糖纸夹进账本', must: ['糖纸'] },
  { id: 'Q5', plant: 57, recall: 65, what: '窗外第三个坏路灯', must: ['路灯'] },
];
const toTurnNo = (beat) => beat + 1;
const narratorAt = (no) => narrAll.find((t) => Number(t.turn_no) === no);
const anyMention = (fromNo, toNo, words) => {
  const hits = [];
  for (const t of narrAll) {
    const no = Number(t.turn_no);
    if (no < fromNo || no >= toNo) continue;
    for (const w of words) if (String(t.content).includes(w)) { hits.push(`t${no}:${w}`); break; }
  }
  return hits;
};

console.log('\n' + '═'.repeat(20) + ' Q 组探针（第二阶段） ' + '═'.repeat(20));
console.log('判定口径见 _work/longrun-baseline.md §10.3：必须复现**具体内容**，只认出载体不算。');
console.log('拍号 → turn_no = 拍号 + 1（开场占 turn_no=1）。');
for (const p of PROBES) {
  const plantNo = toTurnNo(p.plant);
  const recallNo = toTurnNo(p.recall);
  const rec = narratorAt(recallNo);
  const recText = String(rec?.content || '');
  const present = p.must.filter((w) => recText.includes(w));
  const selfMentions = anyMention(plantNo + 1, recallNo, p.must);
  console.log(`\n${p.id} ${p.what}｜种 第${p.plant}拍(t${plantNo}) → 回指 第${p.recall}拍(t${recallNo})`);
  console.log(`  回指拍含关键词 ${present.length}/${p.must.length} ${JSON.stringify(present)}`);
  console.log(`  种下后自发提及 ${selfMentions.length} 拍${selfMentions.length ? `：${selfMentions.join(' ')}` : '（0 拍，说明这条没被上下文反复强化）'}`);
  if (!rec) console.log('  ⚠ 回指拍还没跑到');
  else if (!present.length) console.log(`  → 初判 MISS｜回指拍开头：${recText.slice(0, 90).replace(/\n/g, ' ')}`);
  else console.log(`  → 需人工读全文（${charLen(recText)} 字）确认是否复现了具体内容`);
}

console.log('\n（Q 组最终判定需人工读回指拍全文：node _work/longrun-sample.mjs ' + sessionId +
  ' --turns ' + PROBES.map((p) => toTurnNo(p.recall)).join(',') + ' --out _work/tmp-q.txt）');
