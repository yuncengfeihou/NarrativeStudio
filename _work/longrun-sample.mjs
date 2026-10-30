#!/usr/bin/env node
/**
 * _work/longrun-sample.mjs — 把抽样轮的完整正文导出成可读文件（人工评分用）
 *
 *   node _work/longrun-sample.mjs <sessionId> [--turns 1,5,10,15,...] [--out path]
 *
 * 只读数据库；不生成任何判定，只做「把原文按抽样轮号摆出来」。
 * 判定口径见 _work/longrun-baseline.md §2 A 维与 §3 探针。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const sid = argv[0];
if (!sid) {
  console.error('用法：node _work/longrun-sample.mjs <sessionId> [--turns 1,5,10] [--out file]');
  process.exit(2);
}
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const turnArg = opt('turns', '');
const outPath = opt('out', `_work/tmp-sample-${sid.slice(0, 8)}.txt`);

const db = new DatabaseSync('data/roleplay.db', { readOnly: true });
const rows = db.prepare(
  "select turn_no, kind, content from turns where session_id = ? order by turn_no, kind"
).all(sid);

// 每拍的玩家行动与旁白正文配对；抽样的对象是「旁白回合」。
const byTurn = new Map();
for (const r of rows) {
  if (!byTurn.has(r.turn_no)) byTurn.set(r.turn_no, { player: '', narrator: '' });
  byTurn.get(r.turn_no)[r.kind] = r.content;
}
const all = [...byTurn.entries()].map(([no, v]) => ({ turn_no: no, ...v }));

const wanted = turnArg
  ? new Set(turnArg.split(',').map((x) => Number(x.trim())).filter(Number.isFinite))
  : null;
const picked = wanted ? all.filter((t) => wanted.has(t.turn_no)) : all;

const chunks = [];
for (const t of picked) {
  chunks.push([
    `\n${'═'.repeat(70)}`,
    `第 ${t.turn_no} 拍｜玩家行动 ${t.player.length} 字｜正文 ${t.narrator.length} 字`,
    '─'.repeat(70),
    `【玩家】${t.player || '（开场，无玩家行动）'}`,
    '',
    '【正文】',
    t.narrator || '（空）',
  ].join('\n'));
}
fs.writeFileSync(outPath, chunks.join('\n'), 'utf8');
console.log(`已导出 ${picked.length} 拍 → ${path.resolve(outPath)}`);
console.log(`轮次：${picked.map((t) => 't' + t.turn_no).join(' ')}`);
