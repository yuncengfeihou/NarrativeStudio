#!/usr/bin/env node
/**
 * _work/longrun-verify-prs.mjs — 三个 PR 的端到端验证（只读 DB）
 *
 *   node _work/longrun-verify-prs.mjs <session-id 或前 8 位>
 *
 * 这不是评测报告，是**回归证据**：单元测试证明纯函数对，这个脚本证明真实跑出来的
 * 数据里那三条路径确实生效了。
 *
 *   ① PR-3a place_id：账本里 place_id 与 place 文本是否互相解释得上
 *   ② PR-3b 最小场长：场次长度分布 + recent_from=null 的比例
 *   ③ PR-2  生死：character_states 的 life_state 时窗 vs 场次 outcome 里的死亡语义
 *   ④ PR-1  数值：world_state 里有没有 delta 行、账本 player_view 的银钱是否落在数字路径上
 *
 * 退出码：0 = 全部 PASS/WARN，1 = 有 FAIL。判据对不上时先看这里，再看报告。
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getWorldState } from '../server/memory/store.js';
import { buildEffectiveWorld } from '../server/world/effective.js';
import { normalizeCard } from '../server/world/schema.js';

const argv = process.argv.slice(2);
const sessionArg = argv.find((a) => !a.startsWith('--')) || '';
if (!sessionArg) {
  console.error('用法: node _work/longrun-verify-prs.mjs <session-id>');
  process.exit(2);
}

const db = new DatabaseSync('data/roleplay.db', { readOnly: true });
const row = db.prepare('SELECT id, title FROM sessions WHERE id=? OR substr(id,1,8)=? LIMIT 1')
  .get(sessionArg, sessionArg);
if (!row) {
  console.error(`找不到会话 ${sessionArg}`);
  process.exit(2);
}
const S = row.id;

const rows = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

let pass = 0;
let warn = 0;
let fail = 0;
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
};
const wa = (label, extra = '') => { warn++; console.log(`  ! ${label}${extra ? ` — ${extra}` : ''}`); };
const info = (label) => console.log(`    ${label}`);

console.log(`\n会话 ${S}`);
console.log(`标题 ${row.title}\n`);

/* ── ① place_id 自洽 ───────────────────────────────────────────────── */
{
  const views = rows(
    `SELECT json_extract(state_json,'$.place') AS place,
            json_extract(state_json,'$.place_id') AS place_id
       FROM states WHERE session_id=? ORDER BY turn_no ASC`, S,
  );
  const withId = views.filter((v) => v.place_id);
  // 投影后的实体名，用来判断 place_id 是否落在真实条目上
  const snap = one('SELECT card_snapshot_json FROM sessions WHERE id=?', S);
  const card = JSON.parse(snap?.card_snapshot_json || '{}');
  const byId = new Map((card.entities || []).map((e) => [e.id, e]));
  const introduced = rows(
    `SELECT entity_id, value_json FROM world_state
      WHERE session_id=? AND op='introduce' AND entity_kind='place'`, S,
  );
  for (const r of introduced) {
    const v = JSON.parse(r.value_json || 'null');
    if (v && typeof v === 'object' && !byId.has(r.entity_id)) byId.set(r.entity_id, { id: r.entity_id, ...v });
  }
  const norm = (s) => String(s ?? '').replace(/[\s·・,，。、；;：:（）()【】\[\]—\-–~～→>]/g, '');
  // 老数据里 place_id 有时存的是 name 而不是 id，两种都算「解释得上」。
  const lookup = (pid) => byId.get(pid)
    || [...byId.values()].find((e) => norm(e.name) === norm(pid));
  const explains = (pid, place) => {
    const e = lookup(pid);
    if (!e) return false;
    const raw = norm(place);
    if (!raw) return false;
    return [e.name, ...(e.aliases || [])].map(norm).filter(Boolean)
      .some((l) => l.length >= 2 && (raw.includes(l) || l.includes(raw)));
  };
  const bad = withId.filter((v) => !explains(v.place_id, v.place));
  console.log(`  ① place_id 自洽：${withId.length} 拍有 place_id，其中解释不通 ${bad.length} 条`);
  for (const b of bad.slice(0, 8)) info(`place=${b.place} → place_id=${b.place_id}（对不上）`);
  if (!withId.length) wa('这局还没有 place_id（跑太短或史官没写地点）');
  else ok(bad.length === 0, 'place_id 都能被 place 文本解释', `${bad.length} 条对不上`);
  const blank = views.filter((v) => v.place && !v.place_id).length;
  info(`place 有值但 place_id 为空：${blank}/${views.length}（空 = 该地点不在卡里，属正常）`);
}

/* ── ② 最小场长 / 上一拍正文可见率 ─────────────────────────────────── */
{
  const turns = one(
    `SELECT MAX(turn_no) AS mx FROM turns WHERE session_id=? AND kind='narrator'`, S,
  )?.mx || 0;
  const scenes = rows(
    `SELECT scene_id, turn_from, turn_to FROM scenes WHERE session_id=? ORDER BY turn_from ASC`, S,
  );
  const lens = scenes.map((s) => s.turn_to - s.turn_from + 1);
  const avg = lens.length ? (lens.reduce((a, b) => a + b, 0) / lens.length) : 0;
  console.log(`\n  ② 场次：${turns} 拍 → ${scenes.length} 场，平均 ${avg.toFixed(2)} 拍/场，场长 ${lens.join(',') || '（无）'}`);
  // recent_from=null 的拍数恒等于场数（每场第一拍必然没有本场已有原文）
  const metaRows = rows(
    `SELECT turn_no, meta_json FROM turns
      WHERE session_id=? AND kind='narrator' ORDER BY turn_no ASC`, S,
  );
  let nulls = 0;
  let seen = 0;
  for (const m of metaRows) {
    let meta = null;
    try { meta = JSON.parse(m.meta_json || 'null'); } catch { /* 坏 meta 跳过 */ }
    const cov = meta?.assembly?.coverage || meta?.coverage;
    if (!cov) continue;
    seen++;
    if (cov.recent_from == null) nulls++;
  }
  if (seen) {
    const rate = nulls / seen;
    info(`coverage 可读 ${seen} 拍，其中 recent_from=null ${nulls} 拍（${(rate * 100).toFixed(1)}%）`);
    // 三拍一场时理论值约 33%；给到 45% 的宽容线，超了说明下限没生效
    if (rate <= 0.45) ok(true, `recent_from=null 占 ${(rate * 100).toFixed(1)}% ≤ 45%`);
    else wa(`recent_from=null 占 ${(rate * 100).toFixed(1)}%（>45%，最小场长可能没生效）`);
  } else {
    wa('没有 coverage meta（可能历史数据或本轮未落 meta）');
  }
  // 单场不得超过 SCENE_EVERY
  const over = scenes.filter((s) => s.turn_to - s.turn_from + 1 > 12);
  ok(over.length === 0, '没有场次超过 SCENE_EVERY=12', over.map((s) => s.scene_id).join(','));
}

/* ── ③ 生死交叉校正 ────────────────────────────────────────────────── */
{
  const dead = rows(
    `SELECT who, value, valid_from, valid_to FROM character_states
      WHERE session_id=? AND field='life_state' AND value IN ('dead','gone')
      ORDER BY valid_from ASC`, S,
  );
  const inferred = rows(
    `SELECT turn_no, payload_json FROM patches
      WHERE session_id=? AND kind='life_state_inferred'`, S,
  );
  console.log(`\n  ③ 生死：life_state 落到 dead/gone 的 ${dead.length} 条；交叉校正审计 ${inferred.length} 条`);
  for (const d of dead.slice(0, 6)) info(`${d.who} ${d.value}（t${d.valid_from}→${d.valid_to ?? 'now'}）`);
  for (const i of inferred.slice(0, 6)) info(`patch t${i.turn_no}: ${i.payload_json}`);
  // 场次 outcome 提到死、但 life_state 没跟上 —— 这就是 PR-2 要消灭的形态
  const sceneDeath = rows(
    `SELECT scene_id, turn_to, outcome FROM scenes
      WHERE session_id=? AND (outcome LIKE '%离世%' OR outcome LIKE '%死%' OR outcome LIKE '%断气%'
        OR outcome LIKE '%亡%') ORDER BY turn_to ASC`, S,
  );
  const missing = [];
  for (const sc of sceneDeath) {
    const hit = one(
      `SELECT 1 AS x FROM character_states
        WHERE session_id=? AND field='life_state' AND value IN ('dead','gone')
          AND valid_from<=? AND (valid_to IS NULL OR valid_to>=?) LIMIT 1`,
      S, sc.turn_to + 1, sc.turn_to + 1,
    );
    if (!hit) missing.push(sc.scene_id);
  }
  info(`场次 outcome 提到死亡 ${sceneDeath.length} 场；到下一拍仍无 dead 的 ${missing.length} 场`);
  if (!sceneDeath.length) wa('这局还没有死亡场次（跑太短，PR-2 未被触发）');
  else ok(missing.length === 0, '死亡语义的场次都在下一拍前落了 dead', missing.join(','));
}

/* ── ④ 数值 delta ─────────────────────────────────────────────────── */
{
  const deltas = rows(
    `SELECT entity_kind, entity_id, path, value_json, valid_from FROM world_state
      WHERE session_id=? AND op='delta' ORDER BY valid_from ASC`, S,
  );
  const rejected = rows(
    `SELECT turn_no, payload_json FROM patches WHERE session_id=? AND kind='rejected_delta'`, S,
  );
  console.log(`\n  ④ 数值：world_state op='delta' ${deltas.length} 条；拒绝审计 ${rejected.length} 条`);
  for (const d of deltas.slice(0, 10)) info(`${d.entity_kind}/${d.entity_id} ${d.path} Δ${d.value_json} @t${d.valid_from}`);
  const nonNumber = deltas.filter((d) => typeof JSON.parse(d.value_json || 'null') !== 'number');
  ok(nonNumber.length === 0, 'delta 的 value 都是数字', nonNumber.length ? `${nonNumber.length} 条不是` : '');
  if (deltas.length) {
    // 余额是代码算的：把 delta 累加（从卡里的初值起）应该等于**投影**出来的 money。
    // 注意 ledger（states.state_json）里没有 money——银钱是 world_state 累加出来的，
    // 从 ledger 读只会得到 undefined（已踩过）。
    const snap = one('SELECT card_snapshot_json, branch_id FROM sessions WHERE id=?', S);
    const card = normalizeCard(JSON.parse(snap?.card_snapshot_json || '{}'));
    const init = Number(card.player?.money ?? 0) || 0;
    const sum = deltas.filter((d) => d.entity_kind === 'player' && d.path === 'money')
      .reduce((a, d) => a + Number(JSON.parse(d.value_json || '0')), 0);
    const projected = buildEffectiveWorld(card, getWorldState(S, { branchId: snap?.branch_id })).player?.money;
    info(`卡初值 ${init} + delta 合计 ${sum} = ${init + sum}；投影 money=${projected ?? '（未写）'}`);
    ok(Math.abs((init + sum) - Number(projected)) < 0.005, '投影余额 = 卡初值 + delta 累加');
    ok(Number(projected) >= 0, '余额没被扣成负数（负数会被整条拒绝）');
  } else {
    wa('这局还没有 delta 行（跑太短或没花钱）');
  }
}

console.log('\n' + '─'.repeat(52));
console.log(`PR 验证：${pass} passed, ${warn} warn, ${fail} failed`);
process.exit(fail ? 1 : 0);
