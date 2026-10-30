#!/usr/bin/env node
/**
 * _work/d32-check.mjs — D32 专项：`life_state` 两张表是否还在分裂
 *
 *   node _work/d32-check.mjs <session_id> [--db data/roleplay.db]
 *
 * 判据（D32 的验收口径，报告里那条 `life_state_consistency` 判的是同一件事，
 * 这里把它拆成可逐行核对的清单，方便肉眼看是哪一条漏了）：
 *
 *   1. `world_state` 里每条 `path='life_state'` 的 set，都必须在 `character_states` 有
 *      同 who / 同 value / 同 valid_from 的一行——**没有就是分裂**（回程通道读不到它）。
 *   2. 反向也查：`character_states` 的 life_state 行应能在 `world_state` 找到对应写入。
 *      反向漏一行不致命（记忆表是镜像，投影才是唯一真相），但要在输出里标出来。
 *   3. `gone` 的人如果之后出现在正文里、且玩家点过名，应当有 `life_state_revived` 回执；
 *      只有 gone 没有回程才是「D10 通道没接上」。
 *
 * 为什么单独写一个：报告只给一行 PASS/FAIL + 「分裂 N 行」，定位不到具体是谁、哪一拍。
 * 长跑中途想快速确认 D32 有没有复发，用这个比重新出整份报告快。
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const sessionId = argv.find((a) => !a.startsWith('--'));
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const dbPath = path.resolve(opt('db', 'data/roleplay.db'));

if (!sessionId) {
  console.error('用法: node _work/d32-check.mjs <session_id> [--db data/roleplay.db]');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const all = (sql, params = {}) => {
  try { return db.prepare(sql).all(params); } catch { return []; }
};

const liveStates = new Set(['dead', 'gone']);
const unq = (v) => String(v ?? '').replace(/^"|"$/g, '');

/* 归一化：world_state 用实体 id 写（`liu-shen`），character_states 用人物名写（`刘婶`）。
 * 两侧直接比 id 会把「同一件事的两种拼法」全报成分裂——第一版就踩了这个，
 * 一局 110 拍报出 4 行假分裂，真分裂其实是 0。所以先把 id 映射回名字再比。 */
const card = (() => {
  const row = all('select card_snapshot_json c from sessions where id = :sid', { sid: sessionId })[0];
  try { return JSON.parse(row?.c || '{}'); } catch { return {}; }
})();
const nameById = new Map();
for (const e of card.entities || []) {
  if (e?.id) nameById.set(String(e.id), String(e.name || e.id));
}
const canonWho = (who) => nameById.get(String(who)) || String(who);

/* ① world_state 侧：投影写入的 life_state */
const ws = all(`select who, value_json, valid_from, valid_to, source, branch_id, turn_no
                  from (select entity_id as who, value_json, valid_from, valid_to, source, branch_id,
                               0 as turn_no
                          from world_state
                         where session_id = :sid and path = 'life_state' and op = 'set')
                 order by valid_from`, { sid: sessionId })
  .map((r) => ({ ...r, raw_who: r.who, who: canonWho(r.who), value: unq(r.value_json) }));

/* ② character_states 侧：记忆表镜像 */
const cs = all(`select who, value, valid_from, valid_to
                  from character_states
                 where session_id = :sid and field = 'life_state'
                 order by valid_from`, { sid: sessionId })
  .map((r) => ({ ...r, who: canonWho(r.who), value: unq(r.value) }));

const key = (r) => `${r.who}::${r.value}::${Number(r.valid_from)}`;
const wsKeys = new Set(ws.map(key));
const csKeys = new Set(cs.map(key));

/* 分裂 = 投影有、记忆表没有（这是 D32 修的那个洞） */
const onlyWorldState = ws.filter((r) => !csKeys.has(key(r)));
/* 反向 = 记忆表有、投影没有（不致命，但要看见） */
const onlyCharState = cs.filter((r) => !wsKeys.has(key(r)));

/* ③ gone 的回程：有 gone 但一次 revive 都没有，且玩家后来点名过，就是通道没接上 */
const revived = all(`select turn_no, json_extract(payload_json, '$.who') as who,
                            json_extract(payload_json, '$.from') as from_state,
                            json_extract(payload_json, '$.reason') as reason
                       from patches
                      where session_id = :sid and kind = 'life_state_revived'
                      order by turn_no`, { sid: sessionId });
const reviveWho = new Set(revived.map((r) => r.who));

console.log(`\n═══ D32 双表一致性 ═══`);
console.log(`会话     ${sessionId}`);
console.log(`库       ${dbPath}`);
console.log(`world_state life_state 写入   ${ws.length} 行（其中 dead/gone ${ws.filter((r) => liveStates.has(r.value)).length} 行）`);
console.log(`character_states life_state   ${cs.length} 行（其中 dead/gone ${cs.filter((r) => liveStates.has(r.value)).length} 行）`);

console.log(`\n① 投影有、记忆表没有（D32 的病根，必须为 0）: ${onlyWorldState.length} 行`);
for (const r of onlyWorldState) {
  console.log(`   ✗ ${r.who}(${r.raw_who}) = ${r.value} @t${r.valid_from}（source=${r.source}）→ 回程通道看不见它`);
}
if (!onlyWorldState.length) console.log('   ✓ 全部对齐');

console.log(`\n② 记忆表有、投影没有（镜像多写，不致命）: ${onlyCharState.length} 行`);
for (const r of onlyCharState) console.log(`   · ${r.who} = ${r.value} @t${r.valid_from}`);
if (!onlyCharState.length) console.log('   ✓ 无');

console.log(`\n③ gone 的回程审计（D10 通道）: ${revived.length} 次`);
for (const r of revived) console.log(`   · t${r.turn_no} ${r.who}：${r.from_state} → alive（${r.reason}）`);
if (!revived.length) console.log('   本局没有回程（可能剧情里没人「离场又被叫回来」）');

const goneWho = [...new Set(ws.filter((r) => r.value === 'gone').map((r) => r.who))];
const noReturn = goneWho.filter((w) => !reviveWho.has(w));
if (goneWho.length) {
  console.log(`\n   本局写进 gone 的人：${goneWho.join('、')}`);
  console.log(`   其中没有回程：${noReturn.length ? noReturn.join('、') : '无'}`);
  console.log('   （没有回程不等于缺陷：只有玩家点名过才算「该回没回」，见报告 life_state_consistency）');
}

const verdict = onlyWorldState.length === 0 ? 'PASS' : 'FAIL';
console.log(`\n结论     ${verdict}（① 必须为 0）`);
db.close();
process.exitCode = onlyWorldState.length === 0 ? 0 : 1;
