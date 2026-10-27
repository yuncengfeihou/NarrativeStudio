/**
 * _work/longrun-scenesim.mjs — 场次切分推演（只读 DB）
 *
 * 用途：回答「如果把 MIN_SCENE_TURNS 调成 N，这局会切成几场、有多少拍看不到上一拍正文」。
 * 它逐拍复现 `server/agents/memory-pipeline.js` 的 `detectSceneChange()`：
 *   ① 无 latestScene → 切（:189）
 *   ② 地点实质位移（isSubstantivePlaceShift，:163 互相包含视为同一处）
 *   ③ 时间标签不同 → 切（:195）
 *   ④ 轮数强制 SCENE_EVERY（:198，默认 12）
 *   ⑤ 单场 token 上限（:205）——本脚本**不复现**，因为它依赖 token_count，
 *      而这局最长场只有 6 拍，远未触发；要看它请用 longrun-report。
 *
 * 先做对齐校验：不加上限时重放出的场次边界必须与 DB 里 scenes 逐条一致，
 * 不一致就说明 detectSceneChange 换过逻辑，下面的推演不可信（脚本会直接报出来）。
 *
 * 用法：
 *   node _work/longrun-scenesim.mjs <session-id> [--scene-every 12]
 */

import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const sessionArg = argv.find((a) => !a.startsWith('--')) || '';
const everyIdx = argv.indexOf('--scene-every');
const SCENE_EVERY = everyIdx >= 0 ? Number(argv[everyIdx + 1]) || 12 : 12;

if (!sessionArg) {
  console.error('用法: node _work/longrun-scenesim.mjs <session-id> [--scene-every 12]');
  process.exit(1);
}

const db = new DatabaseSync('data/roleplay.db', { readOnly: true });

// 支持传前 8 位
const row = db.prepare('SELECT id FROM sessions WHERE id=? OR substr(id,1,8)=? LIMIT 1').get(sessionArg, sessionArg);
if (!row) {
  console.error(`找不到会话 ${sessionArg}`);
  process.exit(1);
}
const S = row.id;

const rows = db.prepare('SELECT turn_no, state_json FROM states WHERE session_id=? ORDER BY turn_no').all(S)
  .filter((r) => Number(r.turn_no) >= 1) // t0 是开局播种，不是一拍
  .map((r) => {
    let st = {};
    try { st = JSON.parse(r.state_json); } catch { /* 坏行按空处理 */ }
    return { turn: Number(r.turn_no), place: String(st.place || ''), time: String(st.time || '') };
  });
if (!rows.length) {
  console.error('该会话没有 states 行（可能一回合都没跑）');
  process.exit(1);
}
const actual = db.prepare('SELECT turn_from, turn_to FROM scenes WHERE session_id=? ORDER BY turn_from').all(S);
const LAST = rows[rows.length - 1].turn;
const TOTAL = rows.length;

const norm = (v) => String(v || '').replace(/[\s·・,，。、；;：:（）()【】[\]—\-–~～→>]/g, '');
const shift = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  return !(!x || !y || x === y) && !x.includes(y) && !y.includes(x);
};

function sim(minTurns, { dropTime = false } = {}) {
  let prev = null;
  const scenes = [];
  let starts = 0;
  for (const r of rows) {
    let change = false;
    if (!prev) change = true;
    else {
      // 本拍落下之后这一场会有几拍：prev 是「上一场已封的场」，本场从 prev.turn_from 起。
      const inScene = r.turn - prev.turn_from + 1;
      const gate = minTurns == null || inScene >= minTurns;
      if (gate && shift(prev.place, r.place)) change = true;
      else if (!dropTime && gate && prev.when_label && r.time && prev.when_label !== r.time) change = true;
      if (!change && SCENE_EVERY > 0 && r.turn - prev.turn_from + 1 >= SCENE_EVERY) change = true;
    }
    if (change) {
      const from = prev ? prev.turn_to + 1 : 1;
      scenes.push({ turn_from: from, turn_to: r.turn });
      starts += 1;
      prev = { turn_from: r.turn + 1, turn_to: r.turn, place: r.place, when_label: r.time };
    }
  }
  if (prev && prev.turn_from <= LAST) scenes.push({ turn_from: prev.turn_from, turn_to: LAST, open: true });
  const closed = scenes.filter((s) => !s.open);
  const lens = closed.map((s) => s.turn_to - s.turn_from + 1);
  return {
    minTurns,
    closed: closed.length,
    open: scenes.length - closed.length,
    avg: (TOTAL / Math.max(1, closed.length)).toFixed(2),
    min: lens.length ? Math.min(...lens) : 0,
    max: lens.length ? Math.max(...lens) : 0,
    starts,
    pct: ((starts / TOTAL) * 100).toFixed(1),
    list: scenes,
  };
}

// ── 对齐校验：不加上限时必须与 DB 逐条一致 ─────────────────────────────
const base = sim(null);
let match = 0;
for (let i = 0; i < Math.min(actual.length, base.list.length); i++) {
  if (actual[i].turn_from === base.list[i].turn_from && actual[i].turn_to === base.list[i].turn_to) match += 1;
}
const aligned = actual.length > 0 && match === actual.length && base.closed === actual.length;

console.log(`会话 ${S}`);
console.log(`拍数 ${TOTAL}（t${rows[0].turn}–t${LAST}）｜真实 scenes ${actual.length} 已封 + 1 未封｜SCENE_EVERY=${SCENE_EVERY}`);
console.log(`对齐校验：重放(minTurns=0) 已封 ${base.closed}，与 DB 边界一致 ${match}/${actual.length}` +
  (aligned ? '  ✅ 推演可信' : '  ⚠️ 不一致——detectSceneChange 逻辑可能已改，下表仅供参考'));
console.log('');
console.log('minTurns | 已封场 | 均拍/场 | 场长 | recent_from=null');
for (const n of [null, 1, 2, 3, 4, 5]) {
  const r = sim(n);
  console.log(`${String(r.minTurns).padStart(8)} | ${String(r.closed).padStart(6)} | ${r.avg.padStart(7)} | ${r.min}-${r.max} | ${r.starts}/${TOTAL} = ${r.pct}%`);
}
const dt = sim(null, { dropTime: true });
const both = sim(2, { dropTime: true });
console.log('');
console.log(`对照·仅去掉时间触发：已封 ${dt.closed}，recent_from=null ${dt.starts}/${TOTAL} = ${dt.pct}%`);
console.log(`对照·minTurns=2 + 去掉时间触发：已封 ${both.closed}，${both.starts}/${TOTAL} = ${both.pct}%`);
console.log('');
console.log('注：场长 1 是首场——detectSceneChange:189 在没有 latestScene 时直接 return true，首拍必然自成一场。');
db.close();
