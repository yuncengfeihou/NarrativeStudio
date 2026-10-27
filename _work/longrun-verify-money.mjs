#!/usr/bin/env node
/**
 * _work/longrun-verify-money.mjs — 数值路径的真实上游端到端验证（会产生一次真实调用）
 *
 *   node _work/longrun-verify-money.mjs <session-id> [action]
 *
 * 做一件事：给现有会话追加一拍「明确花钱」的玩家行动，然后查 `world_state` 里
 * 有没有 `op='delta'` 行、投影余额是否等于「卡初值 + 全部 delta 之和」。
 *
 * 单测证明 `sanitizeChange` / 数值写入对；这个脚本证明**模型真的会按新提示词
 * 报变化量**——提示词改了但模型不照着写，是这类改动最常见的失败方式。
 *
 * 余额只能从投影读（`buildEffectiveWorld`）：ledger（`states.state_json`）里没有 money，
 * 银钱是 world_state 的数值增量累加出来的，读 ledger 只会得到 undefined。
 */
import { DatabaseSync } from 'node:sqlite';
import { getWorldState } from '../server/memory/store.js';
import { buildEffectiveWorld } from '../server/world/effective.js';
import { normalizeCard } from '../server/world/schema.js';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3210';
const arg = process.argv[2] || '';
const action = process.argv[3]
  || '把四麻袋瓶罐卖给废品站，老板数了六十六块二，我数了两遍，揣进怀里。';

const db = new DatabaseSync('data/roleplay.db', { readOnly: true });
const row = db.prepare('SELECT id,title,branch_id,card_snapshot_json FROM sessions WHERE id=? OR substr(id,1,8)=? LIMIT 1').get(arg, arg);
if (!row) { console.error(`找不到会话 ${arg}`); process.exit(2); }
const S = row.id;
const card = normalizeCard(JSON.parse(row.card_snapshot_json));

const project = (atTurn) => buildEffectiveWorld(
  card, getWorldState(S, { branchId: row.branch_id, atTurn }),
);
const before = project(1e9).player?.money;
const lastTurn = db.prepare('SELECT MAX(turn_no) t FROM turns WHERE session_id=?').get(S).t || 0;
console.log(`会话 ${S}\n行动「${action}」\n卡初值 ${card.player?.money}｜跑之前投影余额 ${before ?? '(未写)'}（已跑到 t${lastTurn}）`);

const res = await fetch(`${BASE}/api/sessions/${S}/turn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  // 字段名必须是 playerText：路由解构的是 playerText，传 action 会静默变成空行动
  // （空行动仍会跑完一整拍并落一条空的 player 回合——已踩过一次）。
  body: JSON.stringify({ playerText: action, stream: true }),
});
if (!res.ok) { console.error('turn 请求失败', res.status, await res.text()); process.exit(1); }

let narrative = '';
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const frames = buf.split('\n\n');
  buf = frames.pop() || '';
  for (const f of frames) {
    const line = f.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    let evt = null;
    try { evt = JSON.parse(line.slice(6)); } catch { continue; }
    if (evt.type === 'narrative') narrative += evt.delta || '';
    if (evt.type === 'error') { console.error('SSE error:', evt.error || evt); process.exit(1); }
  }
}
console.log(`\n正文 ${narrative.length} 字`);

const after = project(1e9).player?.money;
const moneyRows = db.prepare(
  `SELECT op, value_json, valid_from FROM world_state
    WHERE session_id=? AND entity_kind='player' AND path='money' AND valid_from>=? ORDER BY id`,
).all(S, lastTurn + 1);
const rejected = db.prepare(
  `SELECT turn_no, payload_json FROM patches WHERE session_id=? AND kind='rejected_delta' AND turn_no>=? ORDER BY id`,
).all(S, lastTurn + 1);

console.log(`\n本次新增 money 行 ${moneyRows.length} 条：`);
for (const d of moneyRows) console.log(`  t${d.valid_from} op=${d.op} value=${d.value_json}`);
console.log(rejected.length ? `拒绝审计 ${rejected.length} 条：` : '拒绝审计 0 条');
for (const r of rejected) console.log(`  t${r.turn_no} ${r.payload_json}`);

const deltas = moneyRows.filter((d) => d.op === 'delta')
  .map((d) => Number(JSON.parse(d.value_json)));
const declared = deltas.reduce((a, b) => a + b, 0);
const expect = Number(before ?? 0) + declared;
console.log(`\n校验：起始 ${before} + 本次声明 ${declared} = ${expect}；投影余额 ${after}`);
const consistent = Math.abs(expect - Number(after)) < 0.005 && Number(after) >= 0;
const reported = moneyRows.length > 0 && (declared !== 0 || moneyRows.some((d) => d.op !== 'delta'));
console.log(`模型报变化量：${reported ? '是' : '否（这一拍没写任何 money 行）'}；账本自洽：${consistent ? '是' : '否'}`);
console.log(reported && consistent
  ? '✓ 端到端通过：模型报的是变化量，余额由代码累加，落库与投影一致'
  : '✗ 端到端未通过（「模型没报 money」和「报了但账本对不上」是两种不同的问题）');
process.exit(reported && consistent ? 0 : 1);
