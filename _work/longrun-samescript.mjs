#!/usr/bin/env node
/**
 * _work/longrun-samescript.mjs — 双局长跑的「同剧本」前提校验
 *
 *   node _work/longrun-samescript.mjs --a <sid> --a-db data/roleplay-a.db \
 *        --b <sid> --b-db data/roleplay.db
 *
 * 为什么必须有这一步：双局 A/B 的全部结论都建立在「两边玩家行动逐字相同」上。
 * 驱动脚本按 ACTIONS 顺序发同一串 playerText，但如果中途某局报错重试、跳拍、
 * 或者有人手动补了一拍，两边就会从某拍起走上不同剧情——之后所有指标差异都
 * 不能归因到被实验的那个变量，而报告本身**看不出来**（它只逐局统计）。
 * 这个脚本只回答一个问题：从第几拍开始不同。
 *
 * 判据：`逐字相同 == min(A 拍数, B 拍数)` 才算同剧本；跑完之前拍数不同是正常的。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SID_A = opt('a', '');
const SID_B = opt('b', '');
const DB_A = path.resolve(opt('a-db', 'data/roleplay-a.db'));
const DB_B = path.resolve(opt('b-db', 'data/roleplay.db'));

if (!SID_A || !SID_B) {
  console.error('用法: node _work/longrun-samescript.mjs --a <sid> --b <sid> [--a-db p] [--b-db p]');
  process.exit(2);
}

const open = (p) => new DatabaseSync(p, { readOnly: true });
const players = (d, sid) => d.prepare(
  "SELECT turn_no, content FROM turns WHERE session_id=? AND kind='player' ORDER BY turn_no",
).all(sid).map((r) => ({ turn_no: Number(r.turn_no), text: String(r.content || '') }));

const dA = open(DB_A);
const dB = open(DB_B);
const a = players(dA, SID_A);
const b = players(dB, SID_B);
dA.close();
dB.close();

const n = Math.min(a.length, b.length);
const diffs = [];
for (let i = 0; i < n; i++) if (a[i].text !== b[i].text) diffs.push({ i, a: a[i].text, b: b[i].text });

console.log(`A 局 ${SID_A.slice(0, 8)}  player 拍 ${a.length}`);
console.log(`B 局 ${SID_B.slice(0, 8)}  player 拍 ${b.length}`);
console.log(`逐字相同 ${n - diffs.length}/${n}${a.length !== b.length ? `（拍数不同：跑完前正常，跑完后就是分叉）` : ''}`);

if (diffs.length) {
  const first = diffs[0].i;
  console.log(`\n✗ 同剧本前提不成立：从第 ${first + 1} 条玩家行动起不同`);
  for (const d of diffs.slice(0, 5)) {
    console.log(`  #${d.i + 1}\n    A: ${JSON.stringify(d.a.slice(0, 100))}\n    B: ${JSON.stringify(d.b.slice(0, 100))}`);
  }
  console.log('\n→ 第 ' + (first + 1) + ' 拍之后的任何 A/B 差异都不能归因到被实验的变量。');
  process.exitCode = 1;
} else {
  console.log('✓ 同剧本前提成立：玩家行动逐字一致');
}
