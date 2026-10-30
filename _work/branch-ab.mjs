/**
 * 走向 Agent 的场记单 A/B 配对回放（离线，不跑整局）。
 *
 * 为什么需要离线：`runBranchAgent` 的 `temperature = 0.9`（`server/config.js:143`），
 * 「A 跑一局、B 跑一局」的差异会被随机性淹没，也无法归因。这里的做法是
 * **同一拍、同一上下文，只换场记单**，同一拍内逐项相减，消掉题材差异。
 *
 * 为什么要有 B2 臂：单靠「A 的输出和 B 像不像」分辨不出信息差异——温度 0.9 下
 * 两次采样本来就不一样。`--arms B,A,B2` 的 B2 就是噪声底，任何差都要和它比。
 *
 * 用法：
 *   node _work/branch-ab.mjs --arms B,A --spread 16 --tag ba16
 *   node _work/branch-ab.mjs --arms B,A,B2 --limit 12 --tag noise
 *   node _work/branch-ab.mjs --analyze _work/tmp-ab3-ba16.jsonl
 *
 * 输出：`_work/tmp-ab3-<tag>.jsonl`（逐拍逐臂的选项与用量），
 *       `--analyze` 打印配对表 + 符号检验。
 *
 * `--arms` 的取值：
 *   B  = 线上版（`context.branchSheet`，已去掉「附近设定」段）
 *   A  = 只留 when/world/player/cast/relations/threads/pressure/directive
 *   B2 = B 的第二次采样（噪声底）
 *   N  = 完全不给场记单（用于判断「这张单子整体有没有被用」）
 */
import '../server/load-env.js';
import fs from 'node:fs';
import * as store from '../server/memory/store.js';
import { assembleContext } from '../server/memory/context-engine.js';
import { runBranchAgent } from '../server/agents/branch.js';

const DEFAULT_SID = '5fdb2eab-e9f7-4c3b-99a9-d4cc0db2d941';
const FALLBACK = new Set(['先应下', '当场顶回去', '问一句为什么']);
// A 臂保留的段：与 composeSheetText() 的 sections key 同名
const KEEP_A = new Set(['when', 'world', 'player', 'cast', 'relations', 'threads', 'pressure', 'directive']);
const HEAD_KEYS = [
  ['在场', 'cast'], ['关系', 'relations'], ['未回收的线索', 'threads'],
  ['已成立的事实', 'facts'], ['知识边界', 'knowledge'], ['压力', 'pressure'],
  ['本场可用设定', 'codex'], ['附近设定', 'codexBrief'], ['本场指令', 'directive'],
  ['主角此刻：', 'player'], ['局势 ', 'world'],
];

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const SID = flag('session', DEFAULT_SID);
const norm = (x) => String(x || '').replace(/\s+/g, '');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const usable = (a) => a && a.tokens != null && !(a.branches.length === 3 && a.branches.every((b) => FALLBACK.has(b.title)));

/* ---------- 场记单拆分：与 composeSheetText() 的拼法互逆 ---------- */
function keyOf(text) {
  const first = text.split('\n')[0];
  if (/^时间 /.test(first)) return 'when';
  for (const [prefix, key] of HEAD_KEYS) if (first.startsWith(prefix)) return key;
  return 'other';
}
function splitSheet(text) {
  const parts = String(text || '').split('\n\n');
  const head = parts.shift() || '';
  return { head, sections: parts.map((p) => ({ key: keyOf(p), text: p })) };
}
const joinSheet = (head, sections) => {
  const body = sections.map((x) => x.text).join('\n\n');
  return body ? `${head}\n\n${body}` : '';
};

/* ---------- 度量 ---------- */
function grams(s, n = 3) {
  const t = norm(s); const out = new Set();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}
function cos(a, b) {
  const A = grams(a); const B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const x of A) if (B.has(x)) hit += 1;
  return hit / Math.sqrt(A.size * B.size);
}
/** 臂内 4 条选项彼此的相似度：越低说明 4 条路越分散 */
function within(bs) {
  const t = bs.map((b) => `${b.title}｜${b.description}`);
  const out = [];
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) out.push(cos(t[i], t[j]));
  return out.length ? out.reduce((a, b) => a + b, 0) / out.length : 0;
}

/* ---------- 分析 ---------- */
async function analyze(file) {
  const raw = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const armNames = [...new Set(raw.flatMap((r) => Object.keys(r.arms)))].sort();
  const clean = raw.filter((r) => armNames.every((a) => usable(r.arms[a])));
  console.log(`样本 ${clean.length}/${raw.length} 拍（剔除上游挂死降级：${raw.filter((r) => !clean.includes(r)).map((r) => 't' + r.turn_no).join(',') || '无'}）｜臂 ${armNames.join(' / ')}\n`);

  const s = store.getSession(SID);
  const w = store.getWorld(s.world_id);
  const card = JSON.parse(s.card_snapshot_json || '{}');
  const cardText = norm(JSON.stringify(card));
  const allTurns = store.getTurnsForBranch(SID, s.branch_id || 'main', 1e9);
  const turnsText = norm(allTurns.filter((t) => t.content).map((t) => t.content).join(''));
  const names = (e) => [e.name, ...(e.aliases || [])].map((x) => String(x || '').trim()).filter((x) => norm(x).length >= 2);
  const objects = (card.entities || []).filter((e) => e.type !== 'person' && names(e).length).map((e) => names(e));
  const persons = (card.entities || []).filter((e) => e.type === 'person' && names(e).length)
    .map((e) => ({ id: e.id, names: names(e) }));
  const quoted = (text) => {
    const out = new Set(); const re = /[「“"]([^」”"]{2,8})[」”"]/g; let m;
    while ((m = re.exec(String(text || ''))) !== null) out.add(m[1]);
    return [...out];
  };

  const per = [];
  // 重放装配时必须带**当拍玩家原文**：在场判定里有「玩家点名的人」这条路
  // （`pickPresent()` 的 `linked.person`），传空字符串会让「只被玩家提到的人」
  // 从 present 里消失，于是「不在场人物」被高估。这一步踩过：t16 玩家写「问奶奶」，
  // 黎婆靠别名「奶奶」进场；空文本重放时她不在 present，探针就把她算成不在场。
  const byNo = new Map();
  for (const t of store.getTurnsForBranch(SID, s.branch_id || 'main', 1e9)) {
    if (!byNo.has(t.turn_no)) byNo.set(t.turn_no, {});
    byNo.get(t.turn_no)[t.kind] = t;
  }
  for (const r of clean) {
    const g = byNo.get(r.turn_no) || {};
    const ctx = await assembleContext({
      session: s, world: w, turnNo: r.turn_no, playerText: g.player?.content || '', images: null,
      branchChoice: null, isOpening: false, directive: '',
    });
    const pIds = new Set((ctx.meta.present || []).map((p) => String(p.id || p.name)));
    const pNames = new Set((ctx.meta.present || []).flatMap((p) => [p.id, p.name]).filter(Boolean).map(norm));
    // 判「不在场」用全部名字（含别名）：只比主名会把人品判成不在场，
    // 因为选项里常写「黎婆」「奶奶」这种别名。
    const absent = persons.filter((p) => !pIds.has(p.id) && !p.names.some((n) => pNames.has(norm(n))));
    const rec = { turn_no: r.turn_no, arms: {} };
    for (const arm of armNames) {
      const a = r.arms[arm];
      const text = a.branches.map((b) => `${b.title}｜${b.description}`).join('\n');
      const nt = norm(text);
      let onstage = 0; let offstage = 0; let obj = 0;
      for (const p of persons) {
        if (!p.names.some((n) => nt.includes(norm(n)))) continue;
        if (p.names.some((n) => pNames.has(norm(n)))) onstage += 1; else offstage += 1;
      }
      for (const o of objects) if (o.some((n) => nt.includes(norm(n)))) obj += 1;
      rec.arms[arm] = {
        onstage, offstage, objects: obj,
        fabricated: quoted(text).filter((t) => !cardText.includes(norm(t)) && !turnsText.includes(norm(t))).length,
        diversity: within(a.branches),
        desc_len: mean(a.branches.map((b) => String(b.description || '').length)),
        tones: new Set(a.branches.map((b) => b.tone)).size,
        abs_tension: mean(a.branches.map((b) => Math.abs(Number(b.tension_delta) || 0))),
        tokens: a.tokens,
      };
    }
    per.push(rec);
  }

  const rows = [
    ['onstage', '在场人物被提到', 'higher'],
    ['offstage', '不在场人物被写进选项', 'lower'],
    ['objects', '设定物件/地点被提到', 'higher'],
    ['fabricated', '引号内新造专名', 'lower'],
    ['diversity', '臂内选项彼此相似度', 'lower'],
    ['desc_len', '描述字数', 'higher'],
    ['abs_tension', '张力幅度', 'higher'],
    ['tokens', '上游 prompt tok', 'lower'],
  ];
  const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
  console.log('指标                        ' + armNames.map((a) => a.padStart(8)).join('') + '   极差');
  for (const [k, label] of rows) {
    const vals = armNames.map((a) => mean(per.map((r) => r.arms[a][k])));
    console.log(label.padEnd(24) + vals.map((v) => f(v).padStart(8)).join('') + '   ' + f(Math.max(...vals) - Math.min(...vals)));
  }

  // 只有两个臂时才做配对符号检验（三个以上要挑谁比谁，容易挑出想要的结论）
  if (armNames.length === 2) {
    const [X, Y] = armNames;
    console.log(`\n配对差（同拍内 ${X} − ${Y}）｜${X}更好/持平/${Y}更好`);
    for (const [k, label, dir] of rows) {
      const d = per.map((r) => r.arms[X][k] - r.arms[Y][k]);
      let a = 0; let b = 0; let tie = 0;
      for (const x of d) { if (Math.abs(x) < 1e-9) tie += 1; else if ((dir === 'higher') === x > 0) a += 1; else b += 1; }
      console.log(`${label.padEnd(24)} ${f(mean(d)).padStart(7)}   ${a}/${tie}/${b}`);
    }
  }
}

/* ---------- 跑 ---------- */
async function run() {
  const LIMIT = Number(flag('limit', 0)) || 0;
  const SPREAD = Number(flag('spread', 0)) || 0;
  const TAG = flag('tag', 'ab');
  const ARMS = String(flag('arms', 'B,A')).split(',').map((x) => x.trim()).filter(Boolean);
  const s = store.getSession(SID);
  const w = store.getWorld(s.world_id);
  const branchId = s.branch_id || 'main';
  const turns = store.getTurnsForBranch(SID, branchId, 1e9);
  const byNo = new Map();
  for (const t of turns) {
    if (!byNo.has(t.turn_no)) byNo.set(t.turn_no, {});
    byNo.get(t.turn_no)[t.kind] = t;
  }
  const pool = [...byNo.entries()].sort((a, b) => a[0] - b[0]).filter(([n, g]) => n >= 3 && g.narrator);
  // 只取开头几拍会让样本落在同一段剧情上；场记单的内容随剧情阶段变化（早期事实少、后期多）,
  // 所以 --spread 从全池里等距抽，--limit 取前 N。
  const picked = SPREAD > 0 && SPREAD < pool.length
    ? Array.from({ length: SPREAD }, (_, i) => pool[Math.round((i * (pool.length - 1)) / (SPREAD - 1))])
    : pool;
  const plan = LIMIT > 0 ? picked.slice(0, LIMIT) : picked;
  console.log(`会话 ${SID.slice(0, 8)}｜全池 ${pool.length} 拍 → 取 ${plan.length} 拍 × ${ARMS.length} 臂（${ARMS.join('/')}）`);
  console.log(`拍号：${plan.map(([n]) => 't' + n).join(' ')}`);

  const outPath = `_work/tmp-ab3-${TAG}.jsonl`;
  fs.writeFileSync(outPath, '');
  for (const [turnNo, g] of plan) {
    const ctx = await assembleContext({
      session: s, world: w, turnNo,
      playerText: g.player?.content || '', images: null,
      branchChoice: g.player?.branch_choice || null, isOpening: false, directive: '',
    });
    const bSheet = ctx.branchSheet || '';
    const { head, sections } = splitSheet(bSheet);
    const aSheet = joinSheet(head, sections.filter((x) => KEEP_A.has(x.key)));
    const sheetFor = (arm) => (arm === 'B' || arm === 'B2' ? bSheet : arm === 'A' ? aSheet : '');
    const st = store.getState(SID, { branchId, atTurn: turnNo })?.state || null;
    const base = {
      world: { ...w, card: ctx.card || w.card }, state: st,
      recentNarrative: g.narrator.content || '',
      present: ctx.meta?.present || [], craft: ctx.craft || null, options: {},
    };
    const rec = { turn_no: turnNo, b_tokens: bSheet.length, a_tokens: aSheet.length, arms: {} };
    for (const arm of ARMS) {
      const t0 = Date.now();
      // 单臂超时：实测上游偶发挂死（一次 2659s 才返回降级选项），不设这层会拖掉半小时并污染指标
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120000);
      let res = null; let err = null;
      try { res = await runBranchAgent({ ...base, sceneSheet: sheetFor(arm), signal: ac.signal }); }
      catch (e) { err = String(e?.name || e); }
      finally { clearTimeout(timer); }
      const bs = res?.branches || [];
      rec.arms[arm] = {
        branches: bs,
        fallback: bs.filter((b) => FALLBACK.has(b.title)).length,
        aborted: ac.signal.aborted, error: err,
        tokens: res?.usage?.prompt_tokens ?? null,
        seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      };
    }
    fs.appendFileSync(outPath, `${JSON.stringify(rec)}\n`);
    console.log(`t${turnNo} ` + ARMS.map((a) => `${a}:${rec.arms[a].branches.length}条/${rec.arms[a].tokens ?? '—'}tok${rec.arms[a].fallback ? '/FB' : ''}`).join(' | '));
  }
  console.log(`\n完成 → ${outPath}\n用 --analyze ${outPath} 看配对结论`);
}

const analyzeFile = flag('analyze');
(analyzeFile ? analyze(analyzeFile) : run()).catch((e) => { console.error(e); process.exit(1); });
