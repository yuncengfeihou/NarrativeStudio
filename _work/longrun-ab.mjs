#!/usr/bin/env node
/**
 * _work/longrun-ab.mjs — 同长度 A/B：基线（旧代码）v新代码（或任一臂），各取前 N 拍
 *
 *   node _work/longrun-ab.mjs --n 24 --a <sid> [--db data/roleplay.db]
 *   node _work/longrun-ab.mjs --n 45 --a <B局sid> --b <A局sid> \
 *        --a-db data/roleplay.db --b-db data/roleplay-a.db
 *
 * 为什么必须同长度：MIN_SCENE_TURNS 是路径相关的（它只闸「软触发」，而软触发
 * 次数取决于模型每拍怎么写地点），只有跑同样的剧本、同样的拍数，两边才可比。
 *
 * 为什么支持两库：D26 的双局长跑用独立 `DB_PATH` 并行跑（互不串写），
 * 一个库只装一局。默认 `--db` 仍指向 data/roleplay.db，旧用法不变；
 * 不给 `--b-db` 时 b 臂与 a 臂同库（同一库两局＝旧行为）。
 */
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const N = Number(opt('n', 24));
const A = opt('a', '8cfb7f62-9c16-43de-a451-ca7ccb98de96');
const B = opt('b', '');
const DB_A = opt('a-db', opt('db', 'data/roleplay.db'));
const DB_B = opt('b-db', '');
const dbA = new DatabaseSync(DB_A, { readOnly: true });
const dbB = DB_B && DB_B !== DB_A ? new DatabaseSync(DB_B, { readOnly: true }) : dbA;
const db = dbA; // 默认库：a 臂与「按 --db 查的附加信息」

const rows = [];
const add = (dim, a, b, better) => rows.push({ dim, a, b, better });

function measure(sid, label, d = dbA) {
  const narr = d.prepare(
    "SELECT turn_no, content, meta_json FROM turns WHERE session_id=? AND kind='narrator' AND turn_no<=? ORDER BY turn_no",
  ).all(sid, N);
  const body = narr.map((r) => r.content || '');
  const lens = body.map((s) => s.length).sort((x, y) => x - y);
  const q = (p) => lens.length ? lens[Math.min(lens.length - 1, Math.floor(p * lens.length))] : 0;

  const cov = narr.map((r) => JSON.parse(r.meta_json || '{}').assembly?.coverage).filter(Boolean);
  const nullRecent = cov.filter((c) => c.recent_from == null).length;

  const scenes = d.prepare('SELECT turn_from, turn_to FROM scenes WHERE session_id=? AND turn_to<=? ORDER BY turn_from').all(sid, N);
  const slens = scenes.map((s) => s.turn_to - s.turn_from + 1);

  const assertMoney = d.prepare(
    `SELECT subject,predicate,object FROM assertions WHERE session_id=? AND status='active'
      AND valid_from<=? AND (object LIKE '%块%' OR object LIKE '%元%')`,
  ).all(sid, N);

  const deltaMoney = d.prepare(
    "SELECT op,value_json,valid_from FROM world_state WHERE session_id=? AND path='money' AND valid_from<=? ORDER BY id",
  ).all(sid, N);

  // place_id 可解释性：pid 必须能被 place 文本或该地点实体的 name/aliases 解释
  const states = d.prepare(
    `SELECT turn_no, json_extract(state_json,'$.place') p, json_extract(state_json,'$.place_id') pid
      FROM states WHERE session_id=? AND turn_no<=? ORDER BY turn_no`,
  ).all(sid, N);
  const withPid = states.filter((s) => s.pid);
  const placeEntities = d.prepare(
    "SELECT entity_id,name,aliases_json FROM entities WHERE world_id=(SELECT world_id FROM sessions WHERE id=?) AND type='place'",
  ).all(sid);
  // 与 PR-3 的判据一致：place_id 必须能被 place 文本与 name/aliases 互含解释。
  const explainable = withPid.filter((s) => {
    const text = String(s.p || '');
    const e = placeEntities.find((x) => x.entity_id === s.pid);
    if (!e) return false; // id 不在卡里 → 自由文本 id
    const names = [e.name, ...(JSON.parse(e.aliases_json || '[]'))].filter(Boolean);
    return names.some((n) => text.includes(n) || String(n).includes(text));
  }).length;

  // 局部重复 5-gram vs 前 3 拍
  const grams = (s) => {
    const out = new Set();
    const t = String(s).replace(/\s+/g, '');
    for (let i = 0; i + 5 <= t.length; i++) out.add(t.slice(i, i + 5));
    return out;
  };
  let rep = 0, repN = 0;
  for (let i = 0; i < body.length; i++) {
    const cur = grams(body[i]);
    const prev = new Set();
    for (let k = Math.max(0, i - 3); k < i; k++) for (const g of grams(body[k])) prev.add(g);
    if (!cur.size || !prev.size) continue;
    let h = 0; for (const g of cur) if (prev.has(g)) h++;
    rep += h / cur.size; repN++;
  }

  // 场外事件多样性
  const off = d.prepare(
    "SELECT payload_json FROM patches WHERE session_id=? AND kind='offstage_event' AND turn_no<=?",
  ).all(sid, N);
  const whos = new Set();
  for (const o of off) {
    try { for (const w of JSON.parse(o.payload_json).who || []) whos.add(w); } catch {}
  }

  const uncertain = d.prepare(
    "SELECT COUNT(*) c FROM patches WHERE session_id=? AND kind='uncertain' AND turn_no<=?",
  ).get(sid, N).c;

  // D26 A/B 专用：走向 Agent 拿到的场记单有多大、砍了多少。
  // 这是被实验的那个变量本身，必须出现在对比表里——否则「省了多少」只能靠另一份报告读。
  const sheetMeta = narr.map((r) => JSON.parse(r.meta_json || '{}').assembly?.scene_sheet?.branch_sheet).filter(Boolean);
  const branchTok = sheetMeta.reduce((acc, b) => acc + (b.tokens || 0), 0);
  const branchFullTok = sheetMeta.reduce((acc, b) => acc + (b.full_tokens || 0), 0);
  const trims = [...new Set(sheetMeta.map((b) => b.trim || 'default'))];

  // 空正文与孤儿回合：都是「玩家行动没换来正文」，会污染字数/重复率分母。
  const emptyTurns = body.filter((s) => s.length === 0).length;
  const orphans = d.prepare(
    `SELECT COUNT(*) c FROM turns WHERE session_id=? AND kind='player' AND turn_no<=?
       AND turn_no NOT IN (SELECT turn_no FROM turns WHERE session_id=? AND kind='narrator')`,
  ).get(sid, N, sid).c;
  const pt = narr.reduce((acc, r) => acc + (JSON.parse(r.meta_json || '{}').prompt_tokens || 0), 0);
  const ct = narr.reduce((acc, r) => acc + (JSON.parse(r.meta_json || '{}').completion_tokens || 0), 0);

  // 逐拍余额：卡初值 + 累计 delta（只对新代码有意义）
  const card = d.prepare('SELECT card_snapshot_json FROM sessions WHERE id=?').get(sid);
  const initMoney = (() => { try { return JSON.parse(card.card_snapshot_json).player?.money; } catch { return undefined; } })();
  const bal = deltaMoney.reduce((a, d) => a + (d.op === 'delta' ? Number(d.value_json) : 0), 0);

  return {
    label,
    turns: body.length,
    chars: body.reduce((a, s) => a + s.length, 0),
    p50: q(0.5), p90: q(0.9), max: lens[lens.length - 1] || 0,
    nullRecent, nullRecentRate: cov.length ? nullRecent / cov.length : 0,
    scenes: scenes.length, sceneAvg: slens.length ? slens.reduce((a, b) => a + b, 0) / slens.length : 0, sceneMax: Math.max(0, ...slens),
    assertMoney: assertMoney.length, assertMoneyDistinct: new Set(assertMoney.map((x) => x.object)).size,
    deltaMoney: deltaMoney.length, initMoney, bal: Number(initMoney || 0) + bal,
    pid: withPid.length, pidBad: withPid.length - explainable,
    rep: repN ? rep / repN : 0,
    offstage: off.length, offWhos: whos.size,
    uncertain,
    branchTok, branchFullTok, trims,
    emptyTurns, orphans, pt, ct,
  };
}

const a = measure(A, `A 臂 ${A.slice(0, 8)}`, dbA);
const b = B ? measure(B, `B 臂 ${B.slice(0, 8)}`, dbB) : null;

const line = (s) => s.padEnd(26, ' ');
const fmt = (v, kind) => {
  if (v == null) return '(缺失)';
  if (kind === 'pct') return `${(v * 100).toFixed(1)}%`;
  if (kind === 'f2') return v.toFixed(2);
  if (kind === 'f1') return v.toFixed(1);
  return String(v);
};

const dims = [
  ['旁白拍数', 'turns', null],
  ['正文总字数', 'chars', null],
  ['单拍字数 p50 / p90 / max', null, null],
  ['本场原文为空占比(recent_from=null)', 'nullRecentRate', 'pct'],
  ['封过的场次数', 'scenes', null],
  ['平均场长(拍)', 'sceneAvg', 'f2'],
  ['最长场(拍)', 'sceneMax', null],
  ['金额类 active 断言', 'assertMoney', null],
  ['  └ distinct 金额文本', 'assertMoneyDistinct', null],
  ['money delta 行数', 'deltaMoney', null],
  ['投影余额(卡初值+Σdelta)', 'bal', null],
  ['place_id 有值/不可解释', null, null],
  ['局部重复 5-gram vs 前3拍', 'rep', 'pct'],
  ['场外事件条数 / distinct who', null, null],
  ['uncertain patches', 'uncertain', null],
  ['空正文回合', 'emptyTurns', null],
  ['孤儿玩家回合', 'orphans', null],
  ['上游 prompt tok 合计', 'pt', null],
  ['上游 completion tok 合计', 'ct', null],
  ['走向版场记单 tok 合计', 'branchTok', null],
  ['  └ 未裁前 tok 合计', 'branchFullTok', null],
];

console.log(`\n同长度 A/B（前 ${N} 拍，同一剧本前 ${N} 条行动）`);
console.log(line('维度') + line(a.label) + (b ? b.label : ''));
console.log('─'.repeat(26 + 20 + (b ? 20 : 0)));
for (const [name, key, kind] of dims) {
  let av, bv;
  if (name.startsWith('单拍字数')) { av = `${a.p50}/${a.p90}/${a.max}`; bv = b ? `${b.p50}/${b.p90}/${b.max}` : ''; }
  else if (name.startsWith('place_id')) { av = `${a.pid}/${a.pidBad}`; bv = b ? `${b.pid}/${b.pidBad}` : ''; }
  else if (name.startsWith('场外事件')) { av = `${a.offstage}/${a.offWhos}`; bv = b ? `${b.offstage}/${b.offWhos}` : ''; }
  else { av = fmt(a[key], kind); bv = b ? fmt(b[key], kind) : ''; }
  console.log(line(name) + line(String(av)) + String(bv));
}

// 余额自洽：b 臂下 delta 合计是否与投影一致
if (b) {
  // 被实验变量本身：档位与走向版场记单体积。两臂档位不同才叫 A/B 成立。
  console.log(`\n场记单档位：A=[${a.trims.join(',')}] ${a.branchTok}/${a.branchFullTok} tok（省 ${a.branchFullTok - a.branchTok}）`
    + `｜B=[${b.trims.join(',')}] ${b.branchTok}/${b.branchFullTok} tok（省 ${b.branchFullTok - b.branchTok}）`);
  if (a.trims.join() === b.trims.join()) console.log('  ⚠ 两臂档位相同 → 本次不是 A/B，是同一臂跑了两遍');
  const states = dbB.prepare(
    "SELECT turn_no, json_extract(state_json,'$.place') p FROM states WHERE session_id=? AND turn_no<=? ORDER BY turn_no",
  ).all(B, N);
  console.log(`\n${b.label} 场次依据（逐拍 place）：`);
  let prev = null, cur = [];
  for (const s of states) {
    if (s.p !== prev) { if (cur.length) console.log(`  ${cur.join(' → ')}`); cur = [`t${s.turn_no} ${s.p}`]; prev = s.p; }
    else cur.push(`t${s.turn_no}`);
  }
  if (cur.length) console.log(`  ${cur.join(' → ')}`);
  const sceneRows = dbB.prepare('SELECT scene_id,turn_from,turn_to,place,when_label,importance FROM scenes WHERE session_id=? AND turn_to<=? ORDER BY turn_from').all(B, N);
  console.log(`${b.label} 场次表：`);
  for (const s of sceneRows) console.log(`  ${s.scene_id} t${s.turn_from}-${s.turn_to} (${s.turn_to - s.turn_from + 1}拍) place=${s.place} when=${s.when_label}`);
  for (const [sid, d] of [[A, dbA], [B, dbB]]) {
    const p = d.prepare("SELECT turn_no,evidence FROM patches WHERE session_id=? AND kind='scene' AND turn_no<=? ORDER BY turn_no").all(sid, N);
    console.log(`${sid.slice(0, 8)} 封场理由：${p.map((x) => `t${x.turn_no}:${x.evidence || '空'}`).join(' | ')}`);
  }
}
if (dbB !== dbA) dbB.close();
db.close();
