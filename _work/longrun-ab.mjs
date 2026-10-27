#!/usr/bin/env node
/**
 * _work/longrun-ab.mjs — 同长度 A/B：基线（旧代码）vs 新代码，各取前 N 拍
 *
 *   node _work/longrun-ab.mjs --n 24 --a <baseline-sid> --b <new-sid>
 *
 * 为什么必须同长度：MIN_SCENE_TURNS 是路径相关的（它只闸「软触发」，而软触发
 * 次数取决于模型每拍怎么写地点），只有跑同样的剧本、同样的拍数，两边才可比。
 * 只读 data/roleplay.db。
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
const db = new DatabaseSync('data/roleplay.db', { readOnly: true });

const rows = [];
const add = (dim, a, b, better) => rows.push({ dim, a, b, better });

function measure(sid, label) {
  const narr = db.prepare(
    "SELECT turn_no, content, meta_json FROM turns WHERE session_id=? AND kind='narrator' AND turn_no<=? ORDER BY turn_no",
  ).all(sid, N);
  const body = narr.map((r) => r.content || '');
  const lens = body.map((s) => s.length).sort((x, y) => x - y);
  const q = (p) => lens.length ? lens[Math.min(lens.length - 1, Math.floor(p * lens.length))] : 0;

  const cov = narr.map((r) => JSON.parse(r.meta_json || '{}').assembly?.coverage).filter(Boolean);
  const nullRecent = cov.filter((c) => c.recent_from == null).length;

  const scenes = db.prepare('SELECT turn_from, turn_to FROM scenes WHERE session_id=? AND turn_to<=? ORDER BY turn_from').all(sid, N);
  const slens = scenes.map((s) => s.turn_to - s.turn_from + 1);

  const assertMoney = db.prepare(
    `SELECT subject,predicate,object FROM assertions WHERE session_id=? AND status='active'
      AND valid_from<=? AND (object LIKE '%块%' OR object LIKE '%元%')`,
  ).all(sid, N);

  const deltaMoney = db.prepare(
    "SELECT op,value_json,valid_from FROM world_state WHERE session_id=? AND path='money' AND valid_from<=? ORDER BY id",
  ).all(sid, N);

  // place_id 可解释性：pid 必须能被 place 文本或该地点实体的 name/aliases 解释
  const states = db.prepare(
    `SELECT turn_no, json_extract(state_json,'$.place') p, json_extract(state_json,'$.place_id') pid
      FROM states WHERE session_id=? AND turn_no<=? ORDER BY turn_no`,
  ).all(sid, N);
  const withPid = states.filter((s) => s.pid);
  const placeEntities = db.prepare(
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
  const off = db.prepare(
    "SELECT payload_json FROM patches WHERE session_id=? AND kind='offstage_event' AND turn_no<=?",
  ).all(sid, N);
  const whos = new Set();
  for (const o of off) {
    try { for (const w of JSON.parse(o.payload_json).who || []) whos.add(w); } catch {}
  }

  const uncertain = db.prepare(
    "SELECT COUNT(*) c FROM patches WHERE session_id=? AND kind='uncertain' AND turn_no<=?",
  ).get(sid, N).c;

  // 逐拍余额：卡初值 + 累计 delta（只对新代码有意义）
  const card = db.prepare('SELECT card_snapshot_json FROM sessions WHERE id=?').get(sid);
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
  };
}

const a = measure(A, `基线(旧代码) ${A.slice(0, 8)}`);
const b = B ? measure(B, `新代码 ${B.slice(0, 8)}`) : null;

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

// 余额自洽：新代码下 delta 合计是否与投影一致
if (b) {
  const states = db.prepare(
    "SELECT turn_no, json_extract(state_json,'$.place') p FROM states WHERE session_id=? AND turn_no<=? ORDER BY turn_no",
  ).all(B, N);
  console.log(`\n新代码场次依据（逐拍 place）：`);
  let prev = null, cur = [];
  for (const s of states) {
    if (s.p !== prev) { if (cur.length) console.log(`  ${cur.join(' → ')}`); cur = [`t${s.turn_no} ${s.p}`]; prev = s.p; }
    else cur.push(`t${s.turn_no}`);
  }
  if (cur.length) console.log(`  ${cur.join(' → ')}`);
  const sceneRows = db.prepare('SELECT scene_id,turn_from,turn_to,place,when_label,importance FROM scenes WHERE session_id=? AND turn_to<=? ORDER BY turn_from').all(B, N);
  console.log(`新代码场次表：`);
  for (const s of sceneRows) console.log(`  ${s.scene_id} t${s.turn_from}-${s.turn_to} (${s.turn_to - s.turn_from + 1}拍) place=${s.place} when=${s.when_label}`);
  for (const sid of [A, B]) {
    const p = db.prepare("SELECT turn_no,evidence FROM patches WHERE session_id=? AND kind='scene' AND turn_no<=? ORDER BY turn_no").all(sid, N);
    console.log(`${sid.slice(0, 8)} 封场理由：${p.map((x) => `t${x.turn_no}:${x.evidence || '空'}`).join(' | ')}`);
  }
}
db.close();
