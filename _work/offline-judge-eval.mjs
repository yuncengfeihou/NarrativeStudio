/**
 * offline-judge-eval.mjs — 「决策模型当离线判官」可行性评测（只读 DB / 卡，不写库，不改运行时）。
 *
 * 为什么要评：AGENTS §15.1 挂着「Jev 类决策模型作离线判官」，论据只有一句
 * 「只对显式单跳可靠（多跳 3/6）」，没有可复算的测量。这个脚本把三类判官任务都放到
 * **有确定性地形真值**的题上，量它的准确率 / 稳定性 / 延迟 / 成本：
 *
 *   A. 模糊单跳（无可查真值，只能估）：两拍正文的最长逐字重复字数。真值 = 确定性 LCS。
 *      ——这是判官唯一有存在价值的场景：代码算不出的「像不像复述」。
 *   B. 结构单跳（可查真值）：一堆实体里哪些 `links` 指向不存在的 id。真值 = 代码精确计算。
 *      ——用来判断判官在「本来就能确定性算」的题上有没有超额能力（若有，纯浪费）。
 *   C. 图多跳（可查真值）：沿 `links` 两跳能到达的 person 实体集合。真值 = BFS。
 *      ——验证「多跳不可靠」的断言。
 *
 * 用法：
 *   node _work/offline-judge-eval.mjs                 # 全跑（约 20 次调用）
 *   node _work/offline-judge-eval.mjs --json out.json # 落结构化结果
 *   node _work/offline-judge-eval.mjs --only A        # 只跑一类
 *
 * 判官模型：`JUDGE_MODEL` 环境变量 → `resolveAgent('continuity')` 的绑定 → 默认上游模型。
 * 之所以默认复用 continuity 的档位：离线判官如果要接，最可能就是拿一个已有的旁路 Agent 档。
 *
 * ── 2026-11-01 实跑结论（14 次调用 / 1547917ms / prompt 31779 / completion 135539）──
 *   A 12 对：MAE 1 字（最大偏差 4 字：394→390）、秩相关 0.98、100 字判定 tp/fp/fn/tn = 4/0/0/8（全对）；单次 53–265s。
 *   B 30 实体：precision=recall=1（29.5s）。C 合成两跳图：完全正确（5.7s）。
 *   → **准确率不是问题，成本是**：均 110.6s/次、输出均 9.7K tok/次；A 里有 2 次把 16000 预算耗在推理上。
 *     而 B/C 这类题代码 0 成本 100% 准，A 的「像不像复述」也已有确定性替代
 *     （`server/memory/replay.js` 的 longestCommonCjk）→ 结论：**不接离线判官**，脚本留作复测入口。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import '../server/load-env.js';
import { chat } from '../server/llm.js';
import { resolveAgent } from '../server/model-registry.js';
import { longestCommonCjk } from '../server/memory/replay.js';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const DB_PATH = 'data/roleplay.db';
const CARD_PATH = 'presets/nvzun-jianpolan.json';

const JUDGE_MODEL = process.env.JUDGE_MODEL || resolveAgent('continuity')?.model || null;
const SYSTEM = [
  '你是一个严格的离线裁判。只根据我给的资料判断，不要补充资料里没有的信息。',
  '只输出一个 JSON 对象，不要解释、不要 markdown 代码块。',
].join('\n');

const results = { model: JUDGE_MODEL, tasks: {}, calls: 0, totalMs: 0, promptTokens: 0, completionTokens: 0 };

function parseJson(text) {
  const src = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const at = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (at < 0 || end <= at) return null;
  try { return JSON.parse(src.slice(at, end + 1)); } catch { return null; }
}

async function judge(user, tag) {
  const startedAt = Date.now();
  const res = await chat({
    model: JUDGE_MODEL || undefined,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    temperature: 0,
    maxTokens: 16000,
    responseFormat: { type: 'json_object' },
  });
  const ms = Date.now() - startedAt;
  results.calls += 1;
  results.totalMs += ms;
  results.promptTokens += Number(res.usage?.prompt_tokens) || 0;
  results.completionTokens += Number(res.usage?.completion_tokens) || 0;
  const parsed = parseJson(res.content);
  process.stderr.write(
    `  · ${tag} ${ms}ms finish=${res.finishReason} content=${String(res.content || '').length}字`
    + `${parsed ? '' : ' (JSON 解析失败)'}\n`,
  );
  return { parsed, raw: res.content, ms };
}

/* ── A. 模糊单跳：最长逐字重复字数 ───────────────────────────────────── */

function loadNarratives(db) {
  const sessions = db.prepare(
    "select id, title from sessions order by created_at asc",
  ).all();
  const rows = db.prepare(
    "select session_id, turn_no, content from turns where kind = 'narrator' order by session_id, turn_no",
  ).all();
  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(r);
  }
  return { sessions, bySession };
}

function pickReplayPairs(bySession) {
  // 正例优先（跨拍大幅度照搬在长跑里很少，全库扫一遍才有样本），再补几个正常拍当负例。
  const scored = [];
  for (const [sessionId, list] of bySession) {
    for (let i = 1; i < list.length; i += 1) {
      for (const back of [1, 2]) {
        const j = i - back;
        if (j < 0) continue;
        const lcs = longestCommonCjk(list[i].content, list[j].content);
        scored.push({
          sessionId,
          prevTurn: list[j].turn_no,
          turnNo: list[i].turn_no,
          prev: list[j].content,
          cur: list[i].content,
          truth: lcs.length,
        });
      }
    }
  }
  scored.sort((a, b) => b.truth - a.truth);
  const positives = scored.filter((p) => p.truth >= 40).slice(0, 6);
  const seen = new Set(positives.map((p) => `${p.sessionId}:${p.prevTurn}:${p.turnNo}`));
  const negatives = [];
  for (const p of scored.slice(Math.floor(scored.length * 0.4))) {
    if (negatives.length >= 6) break;
    const key = `${p.sessionId}:${p.prevTurn}:${p.turnNo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    negatives.push(p);
  }
  return [...positives, ...negatives];
}

async function taskA(db) {
  const { bySession } = loadNarratives(db);
  const pairs = pickReplayPairs(bySession);
  const rows = [];
  for (const p of pairs) {
    const user = [
      '下面两段是同一部小说相邻的两拍正文。',
      '请估出：第二段里与第一段**逐字相同的最长连续片段**大约有多少个汉字（标点不计）。',
      '如果完全没有成句重复，回答 0。只估数字，不要判断好坏。',
      '输出 JSON：{"repeat_chars": 数字}',
      '',
      '【第一段】',
      p.prev,
      '',
      '【第二段】',
      p.cur,
    ].join('\n');
    const r = await judge(user, `A ${p.sessionId.slice(0, 8)} t${p.prevTurn}->t${p.turnNo} (真值 ${p.truth})`);
    const guess = Number(r.parsed?.repeat_chars);
    rows.push({
      session: p.sessionId,
      prev_turn: p.prevTurn,
      turn_no: p.turnNo,
      truth: p.truth,
      guess: Number.isFinite(guess) ? guess : null,
      abs_error: Number.isFinite(guess) ? Math.abs(guess - p.truth) : null,
      ms: r.ms,
    });
  }
  const scored = rows.filter((r) => r.abs_error !== null);
  const mae = scored.length ? scored.reduce((s, r) => s + r.abs_error, 0) / scored.length : null;
  // 阈值判定：真值 >=100 视为「确实回放」（回放护栏的线），看判官能否分清。
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  for (const r of scored) {
    const truth = r.truth >= 100;
    const pred = (r.guess ?? 0) >= 100;
    if (truth && pred) tp += 1;
    else if (!truth && pred) fp += 1;
    else if (truth && !pred) fn += 1;
    else tn += 1;
  }
  // Spearman：判官数字与真值的秩相关（有没有「大致能排序」的能力）。
  const rank = (vals) => {
    const order = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(vals.length);
    order.forEach(([, i], k) => { out[i] = k + 1; });
    return out;
  };
  const ra = rank(scored.map((r) => r.truth));
  const rb = rank(scored.map((r) => r.guess));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const ma = mean(ra); const mb = mean(rb);
  const cov = ra.reduce((s, v, i) => s + (v - ma) * (rb[i] - mb), 0);
  const sda = Math.sqrt(ra.reduce((s, v) => s + (v - ma) ** 2, 0));
  const sdb = Math.sqrt(rb.reduce((s, v) => s + (v - mb) ** 2, 0));
  const spearman = sda > 0 && sdb > 0 ? cov / (sda * sdb) : null;
  results.tasks.A = { rows, mae: mae === null ? null : Math.round(mae), confusion: { tp, fp, fn, tn }, spearman };
  return { mae, confusion: { tp, fp, fn, tn }, spearman };
}

/* ── B/C. 结构题：注入断链后问判官 ──────────────────────────────────── */

function loadCard() {
  const raw = JSON.parse(fs.readFileSync(CARD_PATH, 'utf8'));
  const card = raw.card || raw;
  return card;
}

function compactEntities(card, ids) {
  return ids.map((id) => {
    const e = card.entities.find((x) => x.id === id);
    return { id: e.id, type: e.type, name: e.name, links: e.links || [] };
  });
}

/**
 * 取一个**闭合子卡**：从种子实体出发 BFS 3 跳，凑够 cap 个。
 * 闭合是关键——判官看到的世界必须自洽，否则「links 指向列表外」会被判成悬空
 * （第一版就是这么翻车的：给了 40 个实体却说「不在列表里就是悬空」，它答了 125 条）。
 */
function closedSubset(card, seeds, cap = 40) {
  const byId = new Map(card.entities.map((e) => [e.id, e]));
  const picked = [];
  const seen = new Set();
  let frontier = seeds.filter((id) => byId.has(id));
  frontier.forEach((id) => { seen.add(id); });
  for (let hop = 0; hop < 3 && picked.length < cap; hop += 1) {
    const next = [];
    for (const id of frontier) {
      const e = byId.get(id);
      if (e && picked.length < cap) picked.push(e);
      for (const link of e?.links || []) {
        const target = String(link).replace(/^(?:cast|codex|entity):/, '');
        if (!byId.has(target) || seen.has(target)) continue;
        seen.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  for (const e of card.entities) {
    if (picked.length >= cap) break;
    if (!seen.has(e.id)) { seen.add(e.id); picked.push(e); }
  }
  return picked;
}

function compactRows(list) {
  return list.map((e) => `${e.id} (${e.type}) -> ${(e.links || []).join(', ') || '（无）'}`).join('\n');
}

function twoHopPersons(card, startId, hops = 2) {
  const byId = new Map(card.entities.map((e) => [e.id, e]));
  const seen = new Set([startId]);
  let frontier = [startId];
  for (let h = 0; h < hops; h += 1) {
    const next = [];
    for (const id of frontier) {
      for (const link of byId.get(id)?.links || []) {
        const target = String(link).replace(/^(?:cast|codex|entity):/, '');
        if (!byId.has(target) || seen.has(target)) continue;
        seen.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  return [...seen].filter((id) => id !== startId && byId.get(id)?.type === 'person');
}

/** 从种子出发收集全部可达实体（不设上限）；给判官的「世界」必须闭包，否则它会如实报悬空。 */
function closureOf(card, seeds, maxHops = 3) {
  const byId = new Map(card.entities.map((e) => [e.id, e]));
  const seen = new Set();
  let frontier = seeds.filter((id) => byId.has(id));
  frontier.forEach((id) => seen.add(id));
  for (let hop = 0; hop < maxHops; hop += 1) {
    const next = [];
    for (const id of frontier) {
      for (const link of byId.get(id)?.links || []) {
        const target = String(link).replace(/^(?:cast|codex|entity):/, '');
        if (!byId.has(target) || seen.has(target)) continue;
        seen.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  return [...seen].map((id) => byId.get(id));
}

/** 找一个「闭包足够小」的种子：判官的输入必须可读，又不能把世界切碎。
 *  刻意取**能达到上限的最大闭包**——题目太小（8 个实体）会假绿。 */
function pickSmallClosure(card, { from, maxSize = 36, maxHops = 2 }) {
  const candidates = card.entities
    .filter((e) => (from === 'person' ? e.type === 'person' : e.type !== 'person'))
    .filter((e) => Array.isArray(e.links) && e.links.length >= 1);
  let best = null;
  for (const e of candidates) {
    const closure = closureOf(card, [e.id], maxHops);
    if (closure.length < 12 || closure.length > maxSize) continue;
    if (!best || closure.length > best.closure.length) best = { seed: e.id, closure };
  }
  return best;
}

async function taskB(card) {
  const picked = pickSmallClosure(card, { from: 'fact', maxSize: 30, maxHops: 2 });
  if (!picked) throw new Error('找不到足够小的闭包');
  const world = picked.closure.map((e) => ({ id: e.id, type: e.type, links: [...(e.links || [])] }));
  const injected = [world[1], world[Math.floor(world.length / 2)], world[world.length - 1]]
    .filter(Boolean)
    .map((e, i) => {
      e.links = [...e.links, `不存在的实体${i + 1}`];
      return `${e.id}|不存在的实体${i + 1}`;
    });
  const universe = card.entities.map((e) => e.id).join('、');
  const user = [
    '第一部分是本卡**全部**实体 id（以此为准）；第二部分是其中若干实体的 links 明细。',
    '请找出：第二部分里哪些 links 指向的 id **不在这份 id 清单里**（即悬空引用）。',
    '输出 JSON：{"dangling":[{"id":"实体id","link":"悬空的目标id"}]}',
    '',
    `【全部 id】${universe}`,
    '',
    '【links 明细】',
    compactRows(world),
  ].join('\n');
  const r = await judge(user, `B dangling (${world.length} 实体明细，注入 ${injected.length} 条断链)`);
  const got = new Set((r.parsed?.dangling || []).map((d) => `${String(d.id).trim()}|${String(d.link).trim()}`));
  const want = new Set(injected);
  let hit = 0;
  for (const g of got) if (want.has(g)) hit += 1;
  results.tasks.B = {
    world_size: world.length,
    injected: [...want],
    answered: [...got],
    precision: got.size ? Math.round((hit / got.size) * 100) / 100 : 0,
    recall: want.size ? Math.round((hit / want.size) * 100) / 100 : 0,
  };
  return results.tasks.B;
}

async function taskC() {
  // 真实卡的 links 是星形（道具/地点 1 跳直连人物），两跳内几乎到不了 2 个人 → 测不出多跳。
  // 所以多跳用**合成小图**：结构已知、真值由 BFS 算、并放三跳外的同类型干扰项。
  const graph = [
    { id: 'n01', type: 'item', links: ['n02', 'n03'] },
    { id: 'n02', type: 'place', links: ['n04', 'n06'] },
    { id: 'n03', type: 'item', links: ['n05'] },
    { id: 'n04', type: 'person', links: ['n07'] },
    { id: 'n05', type: 'person', links: ['n08'] },
    { id: 'n06', type: 'item', links: ['n09'] },
    { id: 'n07', type: 'item', links: ['n10'] },
    { id: 'n08', type: 'person', links: [] },
    { id: 'n09', type: 'person', links: [] },
    { id: 'n10', type: 'item', links: [] },
    { id: 'n11', type: 'person', links: [] },
    { id: 'n12', type: 'place', links: [] },
  ];
  const byId = new Map(graph.map((e) => [e.id, e]));
  const hop = (seed) => {
    const one = (byId.get(seed)?.links || []).filter((id) => byId.has(id));
    const two = [];
    for (const id of one) for (const l of byId.get(id)?.links || []) if (!one.includes(l) && l !== seed) two.push(l);
    return { one, two };
  };
  const { one, two } = hop('n01');
  const truth = [...new Set([...one, ...two])].filter((id) => byId.get(id).type === 'person');
  const user = [
    '下面是一张关系图的全部节点（id / type / links）。links 只指向本表里的 id。',
    '问题：从「n01」出发，沿 links 走**两跳之内**（第 1 跳 + 第 2 跳，不含起点本身），',
    '能到达哪些 type=person 的节点？三跳才到的不算。',
    '输出 JSON：{"persons":["id1","id2"]}',
    '',
    graph.map((e) => `${e.id} (${e.type}) -> ${(e.links || []).join(', ') || '（无）'}`).join('\n'),
  ].join('\n');
  const r = await judge(user, `C 2hop 合成图 (真值 ${truth.length}: ${truth.join(',')})`);
  const got = new Set((r.parsed?.persons || []).map((v) => String(v).trim()));
  const want = new Set(truth);
  let hit = 0;
  for (const g of got) if (want.has(g)) hit += 1;
  const row = {
    start: 'n01',
    world_size: graph.length,
    truth: [...want],
    answered: [...got],
    precision: got.size ? Math.round((hit / got.size) * 100) / 100 : 1,
    recall: want.size ? Math.round((hit / want.size) * 100) / 100 : 1,
    exact: got.size === want.size && hit === want.size,
    ms: r.ms,
  };
  results.tasks.C = { rows: [row], exact: row.exact ? 1 : 0 };
  return results.tasks.C;
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

const db = new DatabaseSync(path.resolve(DB_PATH), { readOnly: true });
const card = loadCard();

try {
  if (!only || only === 'A') {
    console.log('\nA. 模糊单跳：两拍最长逐字重复字数');
    const a = await taskA(db);
    console.log(`   MAE=${a.mae} 字  秩相关=${a.spearman === null ? 'n/a' : a.spearman.toFixed(2)}  100 字判定 tp/fp/fn/tn=${a.confusion.tp}/${a.confusion.fp}/${a.confusion.fn}/${a.confusion.tn}`);
  }
  if (!only || only === 'B') {
    console.log('\nB. 结构单跳：找出注入的断链');
    const b = await taskB(card);
    console.log(`   世界 ${b.world_size} 实体；precision=${b.precision} recall=${b.recall}（注入 ${b.injected.length} 条，答了 ${b.answered.length} 条）`);
  }
  if (!only || only === 'C') {
    console.log('\nC. 图多跳：两跳内的 person 集合');
    const c = await taskC(card);
    const row = c.rows[0];
    console.log(`   世界 ${row.world_size} 实体；P=${row.precision} R=${row.recall} 完全正确=${row.exact}`);
    console.log(`   真值 ${row.truth.length} 个，答了 ${row.answered.length} 个`);
  }
} finally {
  db.close();
}

results.avgMs = results.calls ? Math.round(results.totalMs / results.calls) : 0;
console.log(`\n用量：${results.calls} 次调用 / ${results.totalMs}ms（均 ${results.avgMs}ms）/ prompt ${results.promptTokens} tok / completion ${results.completionTokens} tok`);
if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2), 'utf8');
  console.log(`结构化结果写入 ${jsonOut}`);
}
