/**
 * longrun-report.mjs — 长跑（40+ 轮）验收的**量化半边**（只读 DB，不调模型、不改数据）。
 *
 * 与 `longrun-audit.mjs` 的分工：audit 回答「这一局发生了什么」（定性、逐项陈述），
 * 本脚本回答「这一局算不算通过」（定量、逐条判定）。所以每个数字都必须落进某个检查项，
 * 没被检查的数字只是证据，不是结论。
 *
 * 六段：规模节奏 / 上下文增量 / 缓存前缀 / 记忆一致性 / 走向张力 / 用量耗时，
 * 最后是 §7 的 PASS/WARN/FAIL 判定表。阈值全部提到文件顶部并注明依据——阈值散落在
 * 检查逻辑里时，改装订口径就得读完全文，最后没人敢改。
 *
 * 语义边界（不变量出处见 AGENTS.md）：
 *   - `meta.recall` 是「索引饱和度」，恒 ≈100%，**不衡量叙事有没有用到卡**；
 *     叙事覆盖率由正文点名率承担（audit 已算）。本脚本不重复报 recall 当质量分。
 *   - `meta.assembly.budget` 是「这一轮送模的真实体积」；它随场次线性增长是设计目标
 *     （§6.3 被改写过两次，别再要求「与轮数无关」）。所以斜率 > 0 是 PASS 条件而不是隐患。
 *   - 全部按实际出现的 `turn_no` 取最近 N 个：分支继承会跳号（§13.3），
 *     任何 `turn_no + 1` 的假设都必须先核对行是否存在。
 *
 * 用法：
 *   node _work/longrun-report.mjs <session_id>
 *   node _work/longrun-report.mjs <session_id> --db data/roleplay.db --json out.json
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/* ══════════════════════════════════════════════════════════════════════════
 * 阈值。每条都写清「凭什么」，否则下一个人只能照抄或乱调。
 * ══════════════════════════════════════════════════════════════════════════ */
const TH = {
  // system 必须逐字节冻结（AGENTS §6.2）：哈希一变，上游缓存前缀整段作废，
  // 40 轮长跑的 prompt 成本会翻倍。unique 只能是 1，没有商量余地。
  SYSTEM_HASH_UNIQUE: 1,

  // 场次覆盖无洞 + recent_from === scene_to+1 必须恒成立（§13.14）。
  // 原文窗口是「场次接住之后」的唯一真相，漏一轮就是静默失忆，所以要求 100%。
  COVERAGE_OK_RATE: 1,

  // 降级是异常而不是常态（§1.1 红线 10）。40 轮里 ≤4 轮可接受；
  // 再多说明预算推导偏紧或场次封得太晚，需要看 §6.3 的降级顺序而不是加预算。
  DEGRADED_MAX_RATE: 0.10,

  // hard_cap 的 fail 是 fail-closed：出现一次就意味着「那一轮没写成」，
  // 长跑里这是硬伤，不接受「偶发」。
  HARD_CAP_FAIL_MAX: 0,

  // 预算斜率应 > 0：场次索引与原文在累积（§6.3 的线性增长是设计目标）。
  // 斜率 ≤ 0 反而是坏信号——记忆没在长，或者场次索引被反复降级。
  BUDGET_SLOPE_MIN: 0,

  // 3-gram 跨轮重复率（「套话化」量化口径）。**这是启发式，不是契约**：
  // 基线来自 4 轮实测 p90 ≈ 10.7%，按每 40 轮约 +3%/10 轮的经验漂移外推；
  // 超过 22% 文本开始明显复用句式，超过 32% 就是模板化生产。
  GRAM3_P90_WARN: 0.22,
  GRAM3_P90_FAIL: 0.32,

  // 局部重复率（5-gram vs 前 3 轮）的阈值。这是**长跑真正可用**的口径：
  // 它跟轮数解耦，衡量「最近几拍有没有在自我重复」。
  // 依据：本局实测 mean 4.0% / p90 8.2%；句中真正抄自己上一拍时会在 20% 以上
  // （能看到整句复用），所以 12% WARN、20% FAIL 是同量级的分界。
  REPEAT_LOCAL_WARN: 0.12,
  REPEAT_LOCAL_FAIL: 0.2,

  // 长跑必须真的封过场：一场都没关，场次索引与「最近这场怎么收的」就是空的，
  // 等于长程记忆根本没接上（§13.15）。
  SCENE_MIN: 2,

  // 时间必须真的推进。40 轮里只有 1-2 个时间标签＝世界是静止的。
  WHEN_CHANGE_MIN: 3,
  // 3 次变化至少需要 4 场；场景更少时不给 FAIL（样本不足，给 WARN）。
  SCENE_MIN_FOR_WHEN: 4,

  // 走向不能只有一个形态，否则「选择」是假的。
  TONE_MIN: 2,
  // 分支选择少于 3 次时，tone 多样性没有统计意义 → WARN 而不是 FAIL。
  BRANCH_SAMPLE_MIN: 3,

  // 长跑样本量。低于它时报告照常输出，但结论只对短会话有效，
  // 末尾会打一行样本不足提示（避免拿 4 轮的报告去当 40 轮的验收结论）。
  LONG_RUN_MIN_TURNS: 40,

  // 结尾 60 字内公式化句式的容忍度：命中率过高＝结尾在念同一句台词。
  ENDING_FORMULA_MAX_RATE: 0.25,

  // 单拍正文长度离群比（max / p50）。3× 是「一拍写成了一章」的经验阈值：
  // 它同时是内容信号（模型自己造冲突把篇幅填满）和结构信号（recent 层被撑满→提前封场）。
  LEN_OUTLIER_RATIO: 3,

  // 场外事件被后文点名的引用率。低于此值说明世界呼吸写的支线从未接住，
  // 是「写了不用」的浪费（不算红线，只 WARN）。
  OFFSTAGE_CITE_MIN: 0.2,
};

/* ══════════════════════════════════════════════════════════════════════════
 * 参数
 * ══════════════════════════════════════════════════════════════════════════ */
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--db', '--json']);
let sessionId = null;
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    if (VALUE_FLAGS.has(a)) {
      flags[name] = argv[i + 1];
      i += 1;
    } else {
      flags[name] = true;
    }
  } else if (!sessionId) {
    sessionId = a;
  }
}
if (!sessionId) {
  console.error('usage: node _work/longrun-report.mjs <session_id> [--db data/roleplay.db] [--json out.json]');
  process.exit(2);
}
const dbPath = flags.db || 'data/roleplay.db';
const jsonOut = typeof flags.json === 'string' ? flags.json : null;

/* ══════════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════════ */
const MISSING = '(缺失)';
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const h = (s) => `\n${'═'.repeat(12)} ${s} ${'═'.repeat(12)}`;
// null/undefined 必须显示成 (缺失) 而不是 0：0 是一个真实的测量值，
// 用它冒充「没测到」会让「峰值 0 tok」看起来像一次成功的空跑。
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? MISSING : String(Number(v)));
const r1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : MISSING);
const r3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : MISSING);
const len = (s) => [...String(s ?? '')].length;

function safeJson(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
/** 分位数按「已升序」数组取，口径与 longrun-audit.mjs 一致，便于两份报告互相对照。 */
function quantile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const i = Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p));
  return sortedAsc[i];
}
function stats(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  return {
    n: a.length,
    min: a[0],
    p25: quantile(a, 0.25),
    p50: quantile(a, 0.5),
    p75: quantile(a, 0.75),
    p90: quantile(a, 0.9),
    max: a[a.length - 1],
    mean: a.reduce((x, y) => x + y, 0) / a.length,
  };
}
/** 最小二乘斜率（y 单位 / x 单位）。点不足 2 个或无方差时返回 null。 */
function slopeOf(points) {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const n = pts.length;
  if (n < 2) return null;
  const sx = pts.reduce((s, p) => s + p[0], 0);
  const sy = pts.reduce((s, p) => s + p[1], 0);
  const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0);
  const sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
  const den = n * sxx - sx * sx;
  if (!den) return null;
  return (n * sxy - sx * sy) / den;
}
/** 把 turn 号列表压成区间（2-4,7,9-11）。40 轮的报告里逐号罗列会占掉半屏。 */
function turnRanges(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const out = [];
  let i = 0;
  while (i < a.length) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j += 1;
    out.push(j > i ? `${a[i]}-${a[j]}` : String(a[i]));
    i = j + 1;
  }
  return out.join(',');
}
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return [...t].slice(0, n).join('') + ([...t].length > n ? '…' : '');
};
/** 汉字切片：3-gram / 短语重复只统计汉字，标点与空白不参与（否则句读习惯会被当成套话）。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
function cjkOnly(s) {
  let out = '';
  for (const ch of String(s ?? '')) if (CJK_RE.test(ch)) out += ch;
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 读库（全部只读；任何一张表读失败都不能中断报告——运行中的库可能缺表）
 * ══════════════════════════════════════════════════════════════════════════ */
const db = (() => {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    // 只读打开失败几乎总是「库路径写错」或「库还没建」。给一句人话，
    // 不要把 SQLite 的英文栈糊到 stdout 上（这份输出会被贴进验收记录）。
    console.error(`cannot open db (readOnly): ${dbPath}\n  ${e?.message || e}`);
    process.exit(1);
  }
})();
const all = (sql, params = {}) => {
  try {
    return db.prepare(sql).all(params);
  } catch {
    return null;
  }
};
const one = (sql, params = {}) => {
  try {
    return db.prepare(sql).get(params) ?? null;
  } catch {
    return null;
  }
};

const report = {
  generated_at: new Date().toISOString(),
  schema: 1,
  session_id: sessionId,
  db: dbPath,
  thresholds: TH,
};

try {
  const session = db.prepare('select * from sessions where id = :id').get({ id: sessionId });
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  const turns = db
    .prepare(
      `select id, turn_no, kind, content, branch_choice_json, meta_json, usage_json,
              token_count, branch_id, created_at
         from turns where session_id = :sid order by turn_no asc, id asc`
    )
    .all({ sid: sessionId });
  const narr = turns.filter((t) => t.kind === 'narrator');
  const players = turns.filter((t) => t.kind === 'player');
  const scenes = all(
    `select scene_id, level, turn_from, turn_to, when_label, place, place_id, importance,
            hooks_json, threads_json, cast_json, token_count
       from scenes where session_id = :sid order by turn_from asc, id asc`,
    { sid: sessionId }
  ) ?? [];
  const settings = safeJson(session.settings_json);
  const sessionUsage = safeJson(session.usage_json);

  // 逐 narrator 轮解析一次 assembly，后面各段共用（避免重复 JSON.parse 2KB×N）。
  const asmRows = narr.map((t, i) => {
    const meta = safeJson(t.meta_json);
    const asm = meta.assembly || {};
    return {
      i,
      turn_no: Number(t.turn_no),
      branch_id: t.branch_id,
      meta,
      asm,
      budget: asm.budget || {},
      plan: asm.plan || {},
      coverage: asm.coverage || {},
      index: asm.index || {},
      cache: asm.cache || {},
      drift: asm.cache?.drift || {},
      hard_cap: asm.hard_cap || {},
      degraded: arr(asm.degraded),
      chars: len(t.content || ''),
      content: String(t.content || ''),
      usage: safeJson(t.usage_json),
    };
  });

  // 同一 turn_no 可能有多行（重写/分支）；取 id 最大的一条作为「这一拍最终被采纳的行动」。
  const playerByTurn = new Map();
  for (const p of players) {
    const prev = playerByTurn.get(Number(p.turn_no));
    if (!prev || Number(p.id) > Number(prev.id)) playerByTurn.set(Number(p.turn_no), p);
  }

  // 会话可能不再有 world_id（世界卡被删或旧数据），标题优先用 world 表的名字，
  // 拿不到就退回 undefined 而不是打印 '?'——'?' 会让人以为脚本读错了字段。
  const worldTitle = session.world_id
    ? one('select title from worlds where id = :id', { id: session.world_id })?.title ?? null
    : null;

  /* ────────────────────────────────────────────────────────────────────
   * 1. 规模与节奏
   * ──────────────────────────────────────────────────────────────────── */
  const charLens = asmRows.map((r) => r.chars);
  const charStats = stats(charLens);
  const totalChars = charLens.reduce((a, b) => a + b, 0);

  /* 单拍长度离群：长跑里「某一拍忽然写成了一章」是节奏失控的可观测代理。
   * 用 max / p50 而不是绝对字数——不同世界卡的长度基线差很远（本卡要求 1200–2000）。
   * 离群的影响不只是读感：正文进 recent 层，一拍 5k 字会把当前场次窗口一下撑满，
   * 触发提前封场，于是场次索引的粒度也跟着坏掉。所以这是结构指标，不是文风指标。 */
  const lenP50 = charStats?.p50 ?? 0;
  const lenOutliers = charStats && lenP50 > 0
    ? asmRows
        .filter((r) => r.chars / lenP50 > TH.LEN_OUTLIER_RATIO)
        .map((r) => ({ turn_no: r.turn_no, chars: r.chars, ratio: Number((r.chars / lenP50).toFixed(2)) }))
    : [];
  const lenRatio = charStats && lenP50 > 0 ? Number((charStats.max / lenP50).toFixed(2)) : null;

  // 每 5 轮一档：按 turn_no 分桶（不是按数组下标），跳号时不会把两段剧情混进一格。
  const by5 = new Map();
  for (const r of asmRows) {
    const bucket = Math.floor((r.turn_no - 1) / 5) * 5 + 1;
    if (!by5.has(bucket)) by5.set(bucket, []);
    by5.get(bucket).push(r.chars);
  }
  const trend5 = [...by5.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([from, lens]) => ({
      from,
      to: from + 4,
      turns: lens.length,
      mean: Math.round(lens.reduce((a, b) => a + b, 0) / lens.length),
    }));

  const whenSeq = scenes.map((s) => s.when_label).filter(Boolean);
  const whenChanges = whenSeq.slice(1).filter((w, i) => w !== whenSeq[i]).length;
  const placeSeq = scenes.map((s) => s.place).filter(Boolean);
  // 「跑到一半」的判据：有玩家行动却没有对应 narrator 行。这类会话不该被判成失败，
  // 报告只需说明最后几轮还没收尾（否则「字数 min 很小」会被误读成正文被截断）。
  const narrTurnNos = new Set(narr.map((t) => Number(t.turn_no)));
  const unpairedPlayers = [...playerByTurn.keys()].filter((n) => !narrTurnNos.has(n)).sort((a, b) => a - b);
  const sceneRows = scenes.map((s) => ({
    scene_id: s.scene_id,
    level: s.level,
    turn_from: Number(s.turn_from),
    turn_to: Number(s.turn_to),
    when: s.when_label || null,
    place: s.place || null,
    importance: s.importance || null,
    hooks: arr(safeJson(s.hooks_json)).length,
    threads: arr(safeJson(s.threads_json)).length,
    cast: arr(safeJson(s.cast_json)).length,
  }));

  report.scale = {
    session: {
      id: session.id,
      title: session.title,
      world_id: session.world_id,
      branch_id: session.branch_id,
      turn_count: Number(session.turn_count || 0),
      status: session.status,
    },
    turns: { rows: turns.length, player: players.length, narrator: narr.length, unpaired_player_turns: unpairedPlayers },
    chars: {
      total: totalChars,
      ...(charStats || {}),
      buckets: [
        [0, 500], [500, 1000], [1000, 1600], [1600, 2600], [2600, Infinity],
      ].map(([lo, hi]) => ({
        range: `${lo}-${hi === Infinity ? '∞' : hi}`,
        count: charLens.filter((n) => n >= lo && n < hi).length,
      })),
      trend5,
      len_outlier_ratio: lenRatio,
      len_outliers: lenOutliers,
    },
    scenes: {
      count: scenes.length,
      when_sequence: whenSeq,
      when_first: whenSeq[0] ?? null,
      when_last: whenSeq[whenSeq.length - 1] ?? null,
      when_changes: whenChanges,
      distinct_whens: new Set(whenSeq).size,
      places: placeSeq,
      distinct_places: new Set(placeSeq).size,
      rows: sceneRows,
    },
  };

  console.log(h('1. 规模与节奏'));
  console.log(`session      ${session.id}`);
  console.log(`title        ${session.title}｜world ${worldTitle || session.world_id || MISSING}｜branch ${session.branch_id || '?'}`);
  console.log(`回合         turn_count=${num(session.turn_count)}｜turns 行 ${turns.length}（player ${players.length} / narrator ${narr.length}）` +
    (unpairedPlayers.length ? `｜未收尾的玩家行动 t${unpairedPlayers.join(',')}` : ''));
  if (charStats) {
    console.log(
      `正文         总 ${totalChars} 字｜均 ${Math.round(charStats.mean)}｜` +
      `min ${charStats.min}｜p25 ${charStats.p25}｜p50 ${charStats.p50}｜p75 ${charStats.p75}｜p90 ${charStats.p90}｜max ${charStats.max}`
    );
    console.log(`字数分布     ${report.scale.chars.buckets.map((b) => `${b.range}:${b.count}`).join(' · ')}`);
    console.log(`长度离群     max/p50 = ${lenRatio}×（阈值 ${TH.LEN_OUTLIER_RATIO}×）` +
      (lenOutliers.length
        ? '｜' + lenOutliers.map((o) => `t${o.turn_no}:${o.chars}字(${o.ratio}×)`).join(' ')
        : '｜无'));
    console.log(`每 5 轮均值  ${trend5.map((b) => `t${b.from}-${b.to}:${b.mean}(${b.turns}轮)`).join(' · ')}`);
  } else {
    console.log(`正文         ${MISSING}（没有 narrator 轮）`);
  }
  // 时间标签报**去重后**的种数：`whenSeq.length` 是场数，曾把「24 场」印成「24 种」，
  // 会让「世界时间是否推进」这个判据看起来永远满分。
  console.log(`场景         ${scenes.length} 场｜地点 ${report.scale.scenes.distinct_places} 个｜时间标签 ${new Set(whenSeq).size} 种`);
  console.log(`时间推进     ${whenSeq[0] || MISSING} → ${whenSeq[whenSeq.length - 1] || MISSING}（变化 ${whenChanges} 次）`);
  console.log(`地点序列     ${placeSeq.length ? placeSeq.join(' → ') : MISSING}`);
  for (const s of sceneRows) {
    console.log(
      `  ${s.scene_id} t${s.turn_from}-${s.turn_to}｜${s.when || '—'} @ ${s.place || '—'}` +
      `｜${s.importance || '—'}｜hooks ${s.hooks}｜threads ${s.threads}｜cast ${s.cast}`
    );
  }

  /* ────────────────────────────────────────────────────────────────────
   * 2. 上下文增量趋势
   * 预算随场次线性增长是设计目标（§6.3）；这里量的是「有没有失控」：
   * 斜率、峰值、软目标、退化轮次、覆盖不变量。
   * ──────────────────────────────────────────────────────────────────── */
  const budgetKeys = ['system', 'archive', 'recent', 'scene', 'current'];
  const budgetRows = asmRows.map((r) => {
    const row = { turn_no: r.turn_no, total: Number(r.budget.total) || 0 };
    for (const k of budgetKeys) row[k] = Number(r.budget[k]) || 0;
    return row;
  });
  const totalSlope = slopeOf(budgetRows.filter((b) => b.total > 0).map((b) => [b.turn_no, b.total]));
  const peakRow = budgetRows.reduce((best, b) => (b.total > (best?.total ?? -1) ? b : best), null);
  const lastPlan = [...asmRows].reverse().find((r) => Number(r.plan.soft_max) > 0)?.plan || {};
  const softMax = Number(lastPlan.soft_max) || Number([...asmRows].reverse().find((r) => Number(r.asm.soft_max) > 0)?.asm.soft_max) || null;
  const hardMax = Number(lastPlan.hard_max) || Number([...asmRows].reverse().find((r) => Number(r.asm.hard_max) > 0)?.asm.hard_max) || null;

  const covRows = asmRows.map((r) => {
    const c = r.coverage;
    const sceneTo = Number(c.scene_to ?? 0);
    const recentFrom = c.recent_from === null || c.recent_from === undefined ? null : Number(c.recent_from);
    const recentTurns = Number(c.turns ?? 0);
    // recent_from 为 null 有两种合法情形：本轮之前没有未封场的原文（turns=0），
    // 或者根本没渲染原文层。只有「有原文但接不上」才算违约（§13.14）。
    const vacuous = recentFrom === null && recentTurns === 0;
    const ok = vacuous ? true : recentFrom === sceneTo + 1;
    return {
      turn_no: r.turn_no,
      scene_to: sceneTo,
      recent_from: recentFrom,
      recent_to: c.recent_to ?? null,
      turns: recentTurns,
      ok,
      vacuous,
      has_coverage: Object.keys(c).length > 0,
    };
  });
  const covChecked = covRows.filter((c) => c.has_coverage);
  const covViolations = covChecked.filter((c) => !c.ok).map((c) => c.turn_no);
  const covOkRate = covChecked.length ? (covChecked.length - covViolations.length) / covChecked.length : null;

  const indexRows = asmRows
    .filter((r) => Object.keys(r.index).length)
    .map((r) => ({
      turn_no: r.turn_no,
      rendered: r.index.rendered ?? null,
      total: r.index.total ?? null,
      dropped: r.index.dropped ?? null,
      tokens: r.index.tokens ?? null,
      mode: r.index.mode ?? null,
    }));
  const degradedTurns = asmRows.filter((r) => r.degraded.length > 0).map((r) => ({
    turn_no: r.turn_no,
    degraded: r.degraded,
  }));
  const hardCapTurns = asmRows
    .filter((r) => {
      const mode = r.hard_cap?.mode;
      const narrowed = arr(r.hard_cap?.narrowed);
      return (mode && mode !== 'fail') || narrowed.length > 0;
    })
    .map((r) => ({
      turn_no: r.turn_no,
      mode: r.hard_cap?.mode ?? null,
      narrowed: arr(r.hard_cap?.narrowed),
    }));

  report.budget = {
    rows: budgetRows,
    first: budgetRows[0]?.total ?? null,
    last: budgetRows[budgetRows.length - 1]?.total ?? null,
    peak: peakRow ? { turn_no: peakRow.turn_no, total: peakRow.total } : null,
    slope_per_turn: totalSlope,
    plan: {
      window: lastPlan.window ?? null,
      output_reserve: lastPlan.output_reserve ?? null,
      hard_max: hardMax,
      soft_max: softMax,
      layers: lastPlan.layers ?? null,
    },
    coverage: {
      rows: covRows,
      violations: covViolations,
      ok_rate: covOkRate,
    },
    index: indexRows,
    degraded: degradedTurns,
    hard_cap_flagged: hardCapTurns,
    sub_slopes: Object.fromEntries(
      // 分项斜率用**全部**轮次（含 0）：`recent` 这类层在封场前恒为 0，
      // 只拿 >0 的轮次拟合会得到 null，看起来像「没数据」，其实是「刚要开始长」。
      budgetKeys.map((k) => [k, slopeOf(budgetRows.map((b) => [b.turn_no, b[k]]))])
    ),
  };

  console.log(h('2. 上下文增量趋势'));
  console.log(`plan         window=${num(lastPlan.window)} hard_max=${num(hardMax)} soft_max=${num(softMax)}｜layers=${JSON.stringify(lastPlan.layers || {})}`);
  console.log(
    `budget 首/末 ${num(budgetRows[0]?.total)} → ${num(budgetRows[budgetRows.length - 1]?.total)}｜` +
    `峰值 t${peakRow?.turn_no ?? '—'}=${num(peakRow?.total)}｜斜率 ${r1(totalSlope)} tok/轮`
  );
  console.log(`分项斜率     ${Object.entries(report.budget.sub_slopes).map(([k, v]) => `${k}=${r1(v)}`).join(' · ')}`);
  const sampleRows = budgetRows.filter((_, i) => i % 5 === 0 || i === budgetRows.length - 1);
  if (sampleRows.length) {
    console.log('采样表       ' + 'turn '.padEnd(8) + budgetKeys.map((k) => k.padEnd(9)).join('') + 'total');
    for (const r of sampleRows) {
      console.log(
        '             ' + `t${r.turn_no}`.padEnd(8) + budgetKeys.map((k) => String(r[k]).padEnd(9)).join('') + r.total
      );
    }
  } else {
    console.log(`采样表       ${MISSING}`);
  }
  if (covChecked.length === 0) {
    console.log(`coverage     ${MISSING}（没有 meta.assembly.coverage，旧数据或未装探针）`);
  } else {
    console.log(`coverage     scene_to+1 === recent_from：${covViolations.length ? '违约轮 t' + turnRanges(covViolations) : '全部满足'}` +
      `（${pct(covChecked.length - covViolations.length, covChecked.length)}）`);
  }
  // 40 轮以上的序列一行放不下：压成「每 5 轮采样 + 前 8 个违约点」，违约点才是要看的。
  // 全量序列在 --json 的 budget.coverage.rows 里；短会话（≤ SEQ_MAX 轮）全量打印，
  // 否则 4 轮的会话也被采样成 2 行，读起来像数据丢了。
  const SEQ_MAX = 12;
  const covSeqFull = covRows.map((c) => (c.has_coverage
    ? `t${c.turn_no}:${c.scene_to}/${c.recent_from ?? '∅'}${c.ok ? '' : '✗'}`
    // 没有 coverage 的轮次不能画成 0/∅——那会被读成「接缝正确」。
    : `t${c.turn_no}:?`));
  let covSeq = covSeqFull;
  if (covRows.length > SEQ_MAX) {
    const keepSet = new Set();
    covRows.forEach((c, i) => {
      if (i % 5 === 0 || i === covRows.length - 1) keepSet.add(i);
    });
    covRows.forEach((c, i) => {
      // 违约点全给，但总量封顶到 16 格：40+ 轮的报告重点不是「每一轮都长什么样」，
      // 而是「从哪一轮开始坏」。
      if (!c.ok && keepSet.size < 16) keepSet.add(i);
    });
    covSeq = [...keepSet].sort((a, b) => a - b).map((i) => covSeqFull[i]);
  }
  console.log(`  序列       ${covSeq.length ? covSeq.join(' ') + (covSeq.length < covSeqFull.length ? ` （采样 ${covSeq.length}/${covSeqFull.length} 轮；全量见 --json）` : '') : MISSING}`);
  const lastIndex = indexRows[indexRows.length - 1];
  console.log(`index        rendered=${num(lastIndex?.rendered)}/${num(lastIndex?.total)} dropped=${num(lastIndex?.dropped)} tokens=${num(lastIndex?.tokens)} mode=${lastIndex?.mode ?? MISSING}`);
  console.log(`degraded     ${asmRows.length === 0 ? MISSING : degradedTurns.length ? degradedTurns.map((d) => `t${d.turn_no}:${d.degraded.join('+')}`).join(' ') : '无'}`);
  console.log(`hard_cap     ${asmRows.length === 0 ? MISSING : hardCapTurns.length ? hardCapTurns.map((d) => `t${d.turn_no}:${d.mode}${d.narrowed.length ? '/' + d.narrowed.join('+') : ''}`).join(' ') : '全部 mode=fail 且 narrowed 为空'}`);

  /* ────────────────────────────────────────────────────────────────────
   * 3. 缓存前缀稳定性
   * system 逐字节冻结是「长跑不烧钱」的前提（§6.2）。drift 是逐条比对上一轮
   * 送模消息的结果：identical/appendedMessages 都算健康，broken 说明稳定前缀被
   * 插入了新内容（历史上多是场次索引插队），unknown 是首轮或旧数据。
   * ──────────────────────────────────────────────────────────────────── */
  const hashRows = asmRows.filter((r) => r.cache.system_hash);
  const hashes = hashRows.map((r) => String(r.cache.system_hash));
  const uniqueHashes = [...new Set(hashes)];
  const driftRows = asmRows.filter((r) => r.drift && r.drift.verdict);
  const verdicts = {};
  for (const r of driftRows) verdicts[r.drift.verdict] = (verdicts[r.drift.verdict] || 0) + 1;
  // 首轮没有「上一轮」可比（prev_count=0），prefix_shared_rate 必为 0；
  // 把它算进均值会把「缓存命中」永久拉低，所以只统计有前驱的轮次。
  const rateRows = asmRows.filter((r) => Number(r.cache?.drift?.prev_count) > 0 && Number.isFinite(Number(r.cache.prefix_shared_rate)));
  const rateStats = stats(rateRows.map((r) => Number(r.cache.prefix_shared_rate)));
  const breakRows = driftRows.filter((r) => r.drift.verdict === 'broken');
  const breakHist = new Map();

  /* C5 口径（baseline §9 2026-10-27 04:05 变更）：drift.verdict 不看总数，看**断点性质**。
   *
   * `comparePromptMessages` 逐条比整条消息是否全等，所以只要场次索引这条 user 消息
   * 在尾部又长了一行，它就报 broken —— 但前缀其实一直是连续的。真正的信号是：
   *   ① prefix_shared_tokens 是否单调不降（断点没往前提）；
   *   ② 断点是不是「同一条消息内部追加」（char_offset == 上轮该消息全长的位置）。
   * ②的判据用 drift 自己的摘录就能判：offset 落在 prev 内容末尾时 left_excerpt 为空串。
   * 摘录为空而右侧非空 ⇒ 纯尾部追加；左侧非空 ⇒ 上轮那条消息被改写/插队（才是真断点）。
   */
  const appendBreaks = breakRows.filter((r) => r.drift.left_excerpt === '' && r.drift.role_next);
  const realBreaks = breakRows.filter((r) => !(r.drift.left_excerpt === '' && r.drift.role_next));
  const droppedBreaks = breakRows.filter((r) => r.drift.role_next === null || r.drift.role_next === undefined);

  // 真断点再分两性质：消息条数变多的几乎都是「某层首次出现/原文窗口插入」导致整段右移，
  // 条数不变或变少才是「同一条消息被改写」。两者成本含义不同，报告必须分开写。
  const insertBreaks = realBreaks.filter((r) => Number(r.drift.next_count) > Number(r.drift.prev_count));
  const rewriteBreaks = realBreaks.filter((r) => !(Number(r.drift.next_count) > Number(r.drift.prev_count)));

  // prefix_shared_tokens 序列：单调不降 = 稳定前缀只增不减（缓存可以逐轮复用）。
  const prefixSeries = asmRows
    .filter((r) => Number(r.drift?.prev_count) > 0 && Number.isFinite(Number(r.cache?.prefix_shared_tokens)))
    .map((r) => ({ turn_no: r.turn_no, tokens: Number(r.cache.prefix_shared_tokens) }));
  // 回退分「抖动」与「实降」：prefix_shared_tokens 是按字符比例估算的，
  // 同一段文本换个拼接点就会差几个 tok（实测 t5→t6 只差 4 tok＝0.05%），
  // 那不叫断点前移。真正的前缀前移会掉掉整层（上千 tok），量级完全不同。
  const PREFIX_REGRESS_TOL_TOKENS = 50;
  const PREFIX_REGRESS_TOL_RATE = 0.01;
  const prefixRegressions = [];
  const prefixJitters = [];
  for (let k = 1; k < prefixSeries.length; k++) {
    const delta = prefixSeries[k].tokens - prefixSeries[k - 1].tokens;
    if (delta >= 0) continue;
    const tol = Math.max(PREFIX_REGRESS_TOL_TOKENS, prefixSeries[k - 1].tokens * PREFIX_REGRESS_TOL_RATE);
    const item = { from: prefixSeries[k - 1].turn_no, to: prefixSeries[k].turn_no, delta };
    if (-delta > tol) prefixRegressions.push(item);
    else prefixJitters.push(item);
  }
  // 回退再分两类（baseline §9 2026-10-27 04:3x 第三次变更）：
  //   · 记忆窗口轮转（structural）：本轮消息数**变少**（next_count < prev_count）。
  //     `recent` 层是「当前场次逐字原文」，封场后整层清空、下一场再从 0 填起；
  //     它位于消息序列中段（system → archive → recent → 细节 → 场记单 → 本轮），
  //     所以每封一次场，前缀必然掉回 system+archive —— 这是 §6.2 顺序的必然结果，
  //     不是缓存被破坏。代价是每场一次「原文块重付」，量 = 掉下来的 tok。
  //   · 无法解释（unexplained）：消息数没有变少，前缀却变短 ⇒ 同一条消息被改写/被裁。
  //     这才是真问题。
  const asmByTurn = new Map(asmRows.map((r) => [r.turn_no, r]));
  const isStructural = (x) => {
    const r = asmByTurn.get(x.to);
    return Number(r?.drift?.next_count) < Number(r?.drift?.prev_count);
  };
  const structuralRegressions = prefixRegressions.filter(isStructural);
  const unexplainedRegressions = prefixRegressions.filter((x) => !isStructural(x));
  const structuralCostTokens = structuralRegressions.reduce((s, x) => s - x.delta, 0);

  for (const r of breakRows) {
    const idx = r.drift.index === null || r.drift.index === undefined ? '(null)' : Number(r.drift.index);
    breakHist.set(idx, (breakHist.get(idx) || 0) + 1);
  }
  const breakHistSorted = [...breakHist.entries()].sort((a, b) => b[1] - a[1]);
  const topBreak = breakHistSorted[0] || null;
  const topBreakSample = topBreak
    ? breakRows.find((r) => (r.drift.index === null || r.drift.index === undefined ? '(null)' : Number(r.drift.index)) === topBreak[0])
    : null;

  report.cache = {
    system_hash: { unique_count: uniqueHashes.length, hashes: uniqueHashes, turns_with_hash: hashRows.length },
    drift_verdicts: verdicts,
    prefix_shared_rate: rateStats ? { mean: rateStats.mean, min: rateStats.min, max: rateStats.max, n: rateStats.n } : null,
    broken: {
      count: breakRows.length,
      // broken 按**性质**拆分，这是 C5 的判据来源（见上面注释）：
      //   append_only   上轮那条消息只是尾部变长（场次索引逐轮追加）→ 前缀没断
      //   real_break    上轮消息被改写、或分叉点前移到别处 → 前缀真的断了
      //   dropped       本轮消息数少于上轮（裁层/丢历史）→ 也要看
      append_only: appendBreaks.length,
      real_break: realBreaks.length,
      // 真断点两性质：insert = 某层首次出现导致整段右移（一次性的结构事件）；
      // rewrite = 同一条消息被改写（才是真正反复烧前缀的东西）。
      real_break_insert: insertBreaks.length,
      real_break_rewrite: rewriteBreaks.length,
      dropped: droppedBreaks.length,
      histogram: Object.fromEntries(breakHistSorted.map(([k, v]) => [String(k), v])),
      top_index: topBreak ? topBreak[0] : null,
      top_count: topBreak ? topBreak[1] : 0,
      sample: topBreakSample
        ? {
            turn_no: topBreakSample.turn_no,
            role_prev: topBreakSample.drift.role_prev ?? null,
            role_next: topBreakSample.drift.role_next ?? null,
            left: clip(topBreakSample.drift.left_excerpt, 40),
            right: clip(topBreakSample.drift.right_excerpt, 40),
          }
        : null,
      real_break_turns: realBreaks.map((r) => r.turn_no),
    },
    prefix_shared_tokens: {
      series: prefixSeries,
      first: prefixSeries[0]?.tokens ?? null,
      last: prefixSeries[prefixSeries.length - 1]?.tokens ?? null,
      regressions: prefixRegressions,
      structural_regressions: structuralRegressions,
      unexplained_regressions: unexplainedRegressions,
      structural_cost_tokens: structuralCostTokens,
      jitters: prefixJitters,
      tolerance: { tokens: PREFIX_REGRESS_TOL_TOKENS, rate: PREFIX_REGRESS_TOL_RATE },
    },
  };

  console.log(h('3. 缓存前缀稳定性'));
  console.log(`system_hash  unique ${uniqueHashes.length}${uniqueHashes.length ? '：' + uniqueHashes.join(' / ') : ''}（${hashRows.length} 轮有 hash）`);
  console.log(`drift verdict ${Object.keys(verdicts).length ? Object.entries(verdicts).map(([k, v]) => `${k}=${v}`).join(' · ') : MISSING}`);
  console.log(`prefix共享   均值 ${rateStats ? (rateStats.mean * 100).toFixed(1) + '%' : MISSING}｜最小 ${rateStats ? (rateStats.min * 100).toFixed(1) + '%' : MISSING}｜最大 ${rateStats ? (rateStats.max * 100).toFixed(1) + '%' : MISSING}｜样本 ${rateStats?.n ?? 0} 轮（不含首轮）`);
  if (breakRows.length) {
    console.log(`断点性质    纯尾部追加 ${appendBreaks.length} · 真断点 ${realBreaks.length}` +
      `（层首次插入 ${insertBreaks.length} / 同消息改写 ${rewriteBreaks.length}）· 消息减少 ${droppedBreaks.length}`);
    console.log(`断点直方图   ${breakHistSorted.map(([k, v]) => `#${k}×${v}`).join(' · ')}`);
    if (realBreaks.length) {
      console.log(`真断点轮次   t${turnRanges(realBreaks.map((r) => r.turn_no))}`);
    }
    console.log(`最常见断点   #${topBreak[0]}（${topBreak[1]}/${breakRows.length} 次）` +
      (topBreakSample ? `｜t${topBreakSample.turn_no} ${topBreakSample.drift.role_prev ?? MISSING}→${topBreakSample.drift.role_next ?? MISSING}` : ''));
    if (topBreakSample) {
      // 摘录可能含正文（drift 记录的是真实送模消息），只上 stdout，截断到 40 字。
      console.log(`  样例       ← ${report.cache.broken.sample.left}`);
      console.log(`             → ${report.cache.broken.sample.right}`);
    }
  } else {
    console.log('断点直方图   无 broken 轮次');
  }
  console.log(`prefix共享tok 首 ${num(report.cache.prefix_shared_tokens.first)} → 末 ${num(report.cache.prefix_shared_tokens.last)}` +
    `｜实降 ${prefixRegressions.length} 次` +
    (prefixRegressions.length ? '：' + prefixRegressions.map((x) => `t${x.from}→t${x.to}(${x.delta})`).join(',') : '') +
    (prefixJitters.length
      ? `｜抖动 ${prefixJitters.length} 次（±${report.cache.prefix_shared_tokens.tolerance.tokens} tok 内，估算噪声）`
      : ''));

  /* ────────────────────────────────────────────────────────────────────
   * 4. 记忆一致性（确定性口径）
   * 这一段的每个数字都对应一条可证伪的不变量：冲突失效不删除、场次首尾相接、
   * 死亡有受控值、场外事件被后文接住。
   * ──────────────────────────────────────────────────────────────────── */
  const tableNames = ['scenes', 'assertions', 'character_states', 'voices', 'relations', 'threads', 'patches', 'effect_receipts', 'states', 'world_state'];
  const counts = {};
  for (const t of tableNames) {
    const r = one(`select count(*) c from ${t} where session_id = :sid`, { sid: sessionId });
    counts[t] = r ? Number(r.c) : null;
  }
  const patchDist = (all(
    'select agent, kind, status, count(*) c from patches where session_id = :sid group by agent, kind, status order by c desc',
    { sid: sessionId }
  ) || []).map((p) => ({ agent: p.agent, kind: p.kind, status: p.status, n: Number(p.c) }));
  const assertionStatus = (all('select status, count(*) c from assertions where session_id = :sid group by status', { sid: sessionId }) || [])
    .map((a) => ({ status: a.status, n: Number(a.c) }));
  const threadStatus = (all('select status, count(*) c from threads where session_id = :sid group by status', { sid: sessionId }) || [])
    .map((t) => ({ status: t.status, n: Number(t.c) }));
  const lifeStates = (all(
    "select value, count(*) c from character_states where session_id = :sid and field = 'life_state' group by value",
    { sid: sessionId }
  ) || []).map((r) => ({ value: r.value, n: Number(r.c) }));
  const lifeMap = Object.fromEntries(lifeStates.map((r) => [r.value, r.n]));
  const deadWrites = (lifeMap.dead || 0) + (lifeMap.gone || 0);

  // 死亡/离场口径与 longrun-audit.mjs 完全一致：正文出现这些词就该有 life_state 写入。
  // 这里只做「有无」判定，不猜谁死了——谁死了由史官写受控值，代码不认自由文本（§13.22）。
  // 单字「死」必须排除非死亡的固定搭配（死死抠着／拽得死紧／死心眼），否则每一轮都会被
  // 误判成「写了死亡却没有 life_state 写入」。排除表**冻结**：它不是语义识别器，只是把
  // 实测到的误报词挡掉；再发现新误报时应改评据措辞，不要再往里加词（§1.2.3）。
  // 实测补充（t30 复核）：`死寂的凉`（玉佩固定意象，出现 8 轮）、`死的凉`、`像问一个死人`
  // 都是比喻/固定搭配，会把「死亡表述轮次」虚高 3 倍。排除表仍冻结，只补这三类已实测误报。
  const DEATH_RE = /(?<!死)(?:死(?!死|紧|盯|守|撑|抠|攥|抓|拽|磕|心|气|板|结|寂|人|的)|身亡|断气|咽气|离世|尸体|尸首|丧命|毙命)/;
  const deathTurns = asmRows.filter((r) => DEATH_RE.test(r.content)).map((r) => r.turn_no);

  // life_state 交叉判定：写了 dead/gone 之后，角色若在**同一状态有效期内**又真人出场，
  // 就是机制漏了（`lint-state.js` 只按这个受控值剔除在场，写错就没人兜底）。
  // 这里不做语义判定，只用两个确定性信号交叉：
  //   ① 该角色名仍出现在后续正文；② 该角色是否仍在后续 `present` 名单里。
  // ①有②无 = 机制生效（在场被剔除）但正文没跟上 → WARN；
  // ①②都有 = 机制漏了（死人还能上场）→ FAIL。
  //
  // **必须带有效期判据**：`character_states` 与 `world_state` 一样是按 valid_from/valid_to
  // 分段的（`setCharState()` 每次写入都把上一条的 valid_to 封到当拍，store.js:1476-1485）。
  // 只看「写过 gone 的行」而不看它什么时候失效，等于断言「曾经离场过 = 永远离场」——
  // 实测本局：黎婆 t5 写 gone 但 valid_to=12，t12 起回写 alive，t13/16/17/18 都在场；
  // 旧判据把 t13 之后的每一次出场都算成「死人上场」，于是整条判据永久 FAIL。
  // 正确口径：只看**当时仍然有效**的 dead/gone（valid_to 为 NULL 或 > 当拍）。
  const lifeRows = all(
    'select who, value, valid_from, valid_to from character_states where session_id = :sid' +
      " and field = 'life_state' and value in ('dead','gone') order by valid_from",
    { sid: sessionId }
  ) || [];
  const presentByTurn = new Map();
  for (const r of asmRows) {
    const p = r.meta?.assembly?.present;
    if (Array.isArray(p)) presentByTurn.set(Number(r.turn_no), p.map((x) => (typeof x === 'string' ? x : x?.name || x?.id)));
  }
  const stillDeadAt = (lr, tn) => lr.valid_to == null || Number(lr.valid_to) > tn;
  const lifeLeaks = [];
  for (const lr of lifeRows) {
    const who = lr.who;
    const from = Number(lr.valid_from);
    const later = asmRows
      .filter((r) => Number(r.turn_no) > from && stillDeadAt(lr, Number(r.turn_no)) && String(r.content || '').includes(who))
      .map((r) => Number(r.turn_no));
    if (!later.length) continue;
    const inPresent = later.filter((tn) => (presentByTurn.get(tn) || []).includes(who));
    lifeLeaks.push({ who, value: lr.value, from, valid_to: lr.valid_to == null ? null : Number(lr.valid_to), turns: later, in_present: inPresent });
  }
  const lifeFatal = lifeLeaks.filter((x) => x.in_present.length > 0);

  // 场次首尾相接：next.turn_from 应等于 prev.turn_to + 1。但分支继承会跳号（§13.3），
  // 所以「不是 +1」时还要看中间是否真的有回合行——有回合才是洞，没回合只是编号跳号。
  const turnNos = new Set(turns.map((t) => Number(t.turn_no)));
  const sceneGaps = [];
  for (let i = 1; i < sceneRows.length; i++) {
    const prev = sceneRows[i - 1];
    const cur = sceneRows[i];
    const expected = prev.turn_to + 1;
    if (cur.turn_from === expected) continue;
    const coveredTurns = [];
    for (let n = expected; n < cur.turn_from; n++) if (turnNos.has(n)) coveredTurns.push(n);
    sceneGaps.push({
      prev_scene: prev.scene_id,
      next_scene: cur.scene_id,
      expected_from: expected,
      actual_from: cur.turn_from,
      uncovered_turns: coveredTurns,
      hole: coveredTurns.length > 0,
    });
  }

  // 3-gram 跨轮重复率：先把每轮压成纯汉字串，再取 3-gram 集合。
  // 「出现在 ≥2 轮里的 3-gram 占本轮的比例」= 这一轮的用语有多少是从别处搬来的。
  // 这是启发式口径：它不区分「必要的专名复用」与「套话」，所以阈值给得宽。
  const gramSets = asmRows.map((r) => {
    const s = cjkOnly(r.content);
    const set = new Set();
    for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
    return set;
  });
  const gramDf = new Map();
  for (const set of gramSets) for (const g of set) gramDf.set(g, (gramDf.get(g) || 0) + 1);
  const gramRates = gramSets.map((set, i) => {
    if (!set.size) return { turn_no: asmRows[i].turn_no, rate: null, grams: 0 };
    let rep = 0;
    for (const g of set) if ((gramDf.get(g) || 0) >= 2) rep += 1;
    return { turn_no: asmRows[i].turn_no, rate: rep / set.size, grams: set.size, repeated: rep };
  });
  const gramStats = stats(gramRates.map((g) => g.rate).filter((v) => v !== null));

  /* 局部重复率（长跑可用的那个口径）。
   *
   * 上面那个 3-gram 是**累积口径**：分母是「本轮 gram 集合」，分子是「在全部轮次里出现过
   * ≥2 次的 gram」。轮次越多，任何常见搭配都更容易跨过 df≥2，所以这个数**必然随轮数单调上涨**，
   * 与文风退化无关。实测（本局）：4 轮 17.6% → 8 轮 25.2% → 12 轮 29.8% → 16 轮 33.2% → 20 轮 37.0%。
   * 拿它当「长跑套话化」判据，等价于宣称「写得越多越套话」，是口径自身的伪影。
   *
   * 换成两个都跟轮数解耦的口径：
   *   - 5-gram，只跟**前 3 轮**比（局部）：衡量「最近几拍是不是在自我重复」，而不是「全书用词频率」。
   *     3-gram 太短（「了一下」「，声音」都要 2 轮才命中），5-gram 才是句法级重复。
   *   - 累积口径保留为**参考值**，只打印不判定。
   */
  const LOCAL_N = 5;
  const LOCAL_WINDOW = 3;
  const localSets = asmRows.map((r) => {
    const s = cjkOnly(r.content);
    const set = new Set();
    for (let i = 0; i + LOCAL_N <= s.length; i++) set.add(s.slice(i, i + LOCAL_N));
    return set;
  });
  const localRates = localSets.map((set, i) => {
    if (!set.size || i === 0) return { turn_no: asmRows[i].turn_no, rate: null, grams: set.size };
    const prev = new Set();
    for (let j = Math.max(0, i - LOCAL_WINDOW); j < i; j++) for (const g of localSets[j]) prev.add(g);
    let hit = 0;
    for (const g of set) if (prev.has(g)) hit += 1;
    return { turn_no: asmRows[i].turn_no, rate: hit / set.size, grams: set.size, repeated: hit };
  });
  const localStats = stats(localRates.map((g) => g.rate).filter((v) => v !== null));

  // 8 字以上「跨轮重复短语」：先把每轮里「每个 3-gram 都跨轮出现过」的连续区间合并成
  // 极大片段，再按「出现在几轮里」排序。必须合并——固定窗口会把同一句话切成一串
  // 逐字右移的 8-gram，top 10 全变成同一句的十个位移，等于没报。
  // 展示时截断到 PHRASE_SHOW 字：真正的证据是「这几轮说了同一句话」，不是那句有多长。
  const PHRASE_N = 8;
  const PHRASE_MIN_TURNS = 3;
  const PHRASE_SHOW = 24;
  const phraseTurns = new Map(); // 片段 -> Set(turn_no)
  for (const r of asmRows) {
    const s = cjkOnly(r.content);
    let runStart = -1;
    for (let i = 0; i + 3 <= s.length; i++) {
      const common = (gramDf.get(s.slice(i, i + 3)) || 0) >= 2;
      if (common && runStart < 0) runStart = i;
      if (!common && runStart >= 0) {
        // 区间 [runStart, i) 的 3-gram 全部常见 → 片段正文是 [runStart, i+2)。
        const frag = s.slice(runStart, i + 2);
        if (frag.length >= PHRASE_N) {
          if (!phraseTurns.has(frag)) phraseTurns.set(frag, new Set());
          phraseTurns.get(frag).add(r.turn_no);
        }
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      const frag = s.slice(runStart);
      if (frag.length >= PHRASE_N) {
        if (!phraseTurns.has(frag)) phraseTurns.set(frag, new Set());
        phraseTurns.get(frag).add(r.turn_no);
      }
    }
  }
  const phraseTop = [];
  const seenPrefix = new Set();
  for (const [phrase, set] of [...phraseTurns.entries()]
    .filter(([, set]) => set.size >= PHRASE_MIN_TURNS)
    .sort((a, b) => b[1].size - a[1].size || b[0].length - a[0].length)) {
    // 同一句话在相邻轮可能因为前后文不同而多出几个字；按「开头 12 字」去重，
    // 只保留最长的一条，避免同一句霸榜。
    const key = phrase.slice(0, 12);
    if (seenPrefix.has(key)) continue;
    seenPrefix.add(key);
    phraseTop.push({ phrase, turns: set.size, chars: phrase.length, shown: clip(phrase, PHRASE_SHOW) });
    if (phraseTop.length >= 10) break;
  }

  // 开头 20 字重复：长跑里最刺眼的模板化信号（每场都从同一句天气开场）。
  const openings = asmRows.map((r) => ({
    turn_no: r.turn_no,
    head: cjkOnly(r.content).slice(0, 20),
  }));
  const headCount = new Map();
  for (const o of openings) if (o.head) headCount.set(o.head, (headCount.get(o.head) || 0) + 1);
  const dupOpenings = [...headCount.entries()].filter(([, n]) => n >= 2);

  // 场外事件引用率：世界呼吸写了支线，后文正文是否点名 who。
  //
  // 口径修正（2026-10-27 04:5x，跑到 t15）：分母必须只算**可能进提示词**的事件。
  // `context-engine.js:737-752` 的 rumors 段只取 `visibility ∈ {rumor,public}` 且
  // `status='open'` 的事件；`hidden` 按设计**永不外泄**（世界呼吸写它是给校勘/作者看的）。
  // 把 hidden 算进分母等于要求「不该被看见的事件也被点名」，是判据自身错误。
  // 因此分三档：hidden（不计入）、rumor/public（计入）、以及被点名数。
  const offstageRows = all(
    "select turn_no, status, payload_json from patches where session_id = :sid and kind = 'offstage_event' order by turn_no asc, id asc",
    { sid: sessionId }
  ) || [];
  let offstageCited = 0;
  const offstageDetail = [];
  let offstageVisible = 0;
  let offstageHidden = 0;
  for (const p of offstageRows) {
    const pl = safeJson(p.payload_json);
    const names = [].concat(pl.who ?? []).map(String).filter(Boolean);
    const visible = pl.visibility === 'rumor' || pl.visibility === 'public';
    if (visible) offstageVisible += 1;
    else offstageHidden += 1;
    const hitTurn = visible && names.length
      ? narr.find((t) => Number(t.turn_no) > Number(p.turn_no) && names.some((w) => String(t.content || '').includes(w)))?.turn_no ?? null
      : null;
    if (hitTurn !== null) offstageCited += 1;
    offstageDetail.push({
      turn_no: Number(p.turn_no), status: p.status, visibility: pl.visibility ?? null,
      who: names, cited_at: hitTurn,
    });
  }

  // 校勘（continuity）产出的问题有没有被吸收，以及「史官写了但没人读」的写入 ROI。
  //
  // 口径：continuity 是系统唯一「主动发现问题」的通道（interim-findings O8），
  // 它报出的 major 级问题（contradiction / state_jump）若长期挂 open，说明写入没有消费方。
  // minor（knowledge_breach / stale_thread）只计数不判定——它们本来就是提示性的。
  //
  // `uncertain` 是史官每拍写的「叙事悬念」（约 3 条/拍），`context-engine.js` 不消费、
  // 不进 threads、没有 agent 读（O9）。这里只记 INFO：它是写入 ROI 的事实，不是违约。
  const contRows = (all(
    "select turn_no, kind, status, payload_json from patches where session_id = :sid and agent = 'continuity' order by turn_no asc, id asc",
    { sid: sessionId }
  ) || []).map((p) => {
    const pl = safeJson(p.payload_json);
    return {
      turn_no: Number(p.turn_no), kind: p.kind, status: p.status,
      severity: pl.severity ?? null, subject: pl.subject ?? null,
      claim: String(pl.claim ?? '').slice(0, 160),
      fix: pl.fix?.action ?? null,
    };
  });
  const contMajor = contRows.filter((r) => r.severity === 'major');
  const contMajorOpen = contMajor.filter((r) => r.status === 'open');
  const contMinor = contRows.filter((r) => r.severity !== 'major');
  const uncertainRows = (one(
    "select count(*) c from patches where session_id = :sid and kind = 'uncertain'",
    { sid: sessionId }
  ) || {}).c;

  report.memory = {
    counts,
    patches: patchDist,
    continuity: {
      total: contRows.length,
      major: contMajor.length,
      major_open: contMajorOpen.length,
      minor: contMinor.length,
      rows: contRows,
      threshold_note: 'major 级校勘问题（contradiction / state_jump）长期挂 open = 发现了但没人处置；'
        + 'minor 只计数不判定。',
    },
    uncertain: {
      n: Number(uncertainRows || 0),
      consumers: 0,
      note: '史官写的叙事悬念；不进提示词、不进 threads、无 agent 读取，属写入 ROI 事实。',
    },
    assertions: assertionStatus,
    threads: threadStatus,
    life_state: { distribution: lifeStates, dead_writes: deadWrites, death_turns: deathTurns },
    scene_gaps: sceneGaps,
    gram3: {
      per_turn: gramRates,
      stats: gramStats,
      threshold_note: '累积口径只作参考：分母固定为本轮 gram 集合、分子是「全库出现≥2 次」的 gram，'
        + '轮数越多越容易跨过 df≥2，因此这个数必然随轮数单调上涨，不能当长跑判据。',
    },
    repeat_local: {
      n: LOCAL_N,
      window: LOCAL_WINDOW,
      per_turn: localRates,
      stats: localStats,
      threshold_note: '长跑口径：5-gram 只与前 3 轮比，与轮数解耦；衡量「最近几拍是否在自我重复」。',
    },
    phrases: { min_chars: PHRASE_N, min_turns: PHRASE_MIN_TURNS, top10: phraseTop },
    openings: { dup_count: dupOpenings.length, dup: dupOpenings.map(([head, n]) => ({ head, n })) },
    offstage: { total: offstageRows.length, cited: offstageCited, rate: offstageRows.length ? offstageCited / offstageRows.length : null, detail: offstageDetail },
  };

  console.log(h('4. 记忆一致性（确定性口径）'));
  console.log('表计数       ' + tableNames.map((t) => `${t}=${counts[t] === null ? MISSING : counts[t]}`).join(' · '));
  console.log(`patches      ${patchDist.length ? patchDist.map((p) => `${p.agent}/${p.kind}/${p.status}=${p.n}`).join(' · ') : MISSING}`);
  console.log(`assertions   ${assertionStatus.length ? assertionStatus.map((a) => `${a.status}=${a.n}`).join(' ') : MISSING}` +
    (assertionStatus.some((a) => a.status === 'invalidated') ? '｜冲突失效在不删除的前提下生效' : '｜未见 invalidated（无冲突或未触发）'));
  console.log(`threads      ${threadStatus.length ? threadStatus.map((t) => `${t.status}=${t.n}`).join(' ') : MISSING}`);
  console.log(`生命体征     life_state ${lifeStates.length ? JSON.stringify(lifeMap) : MISSING}｜正文含死亡表述 ${deathTurns.length} 轮${deathTurns.length ? '（t' + deathTurns.join(',') + '）' : ''}｜dead/gone 写入 ${deadWrites} 行`);
  if (!sceneRows.length) {
    console.log(`场次相接     ${MISSING}`);
  } else if (!sceneGaps.length) {
    console.log(`场次相接     无洞（${sceneRows.length} 场首尾相接）`);
  } else {
    for (const g of sceneGaps) {
      console.log(
        `场次相接     ${g.hole ? '断点' : '跳号'} ${g.prev_scene}→${g.next_scene}：期望 t${g.expected_from}，实际 t${g.actual_from}` +
        (g.hole ? `｜未覆盖回合 t${g.uncovered_turns.join(',')}` : '｜中间无回合行（分支跳号，不算洞）')
      );
    }
  }
  console.log(`3-gram 重复  均值 ${gramStats ? (gramStats.mean * 100).toFixed(1) + '%' : MISSING}｜p50 ${gramStats ? (gramStats.p50 * 100).toFixed(1) + '%' : MISSING}｜p90 ${gramStats ? (gramStats.p90 * 100).toFixed(1) + '%' : MISSING}｜max ${gramStats ? (gramStats.max * 100).toFixed(1) + '%' : MISSING}（累积口径，只作参考：随轮数必然上涨）`);
  console.log(`  最低轮     ${gramRates.filter((g) => g.rate !== null).sort((a, b) => a.rate - b.rate).slice(0, 3).map((g) => `t${g.turn_no}:${(g.rate * 100).toFixed(0)}%`).join(' ') || MISSING}`);
  console.log(`  最高轮     ${gramRates.filter((g) => g.rate !== null).sort((a, b) => b.rate - a.rate).slice(0, 3).map((g) => `t${g.turn_no}:${(g.rate * 100).toFixed(0)}%`).join(' ') || MISSING}`);
  console.log(`局部重复     5-gram vs 前 ${LOCAL_WINDOW} 轮：均值 ${localStats ? (localStats.mean * 100).toFixed(1) + '%' : MISSING}｜p90 ${localStats ? (localStats.p90 * 100).toFixed(1) + '%' : MISSING}（长跑判据看这一行）`);
  console.log(`  逐轮       ${localRates.filter((g) => g.rate !== null).map((g) => `t${g.turn_no}:${(g.rate * 100).toFixed(0)}%`).join(' ')}`);
  if (phraseTop.length) {
    console.log(`重复短语 top ${phraseTop.length}（≥${PHRASE_N} 字片段，出现在 ≥${PHRASE_MIN_TURNS} 轮）：`);
    for (const p of phraseTop) console.log(`  ${String(p.turns).padStart(2)} 轮｜${p.shown}`);
  } else {
    console.log(`重复短语     无（没有 ≥${PHRASE_N} 字片段出现在 ≥${PHRASE_MIN_TURNS} 轮）`);
  }
  console.log(`重复开头     ${dupOpenings.length ? dupOpenings.map(([head, n]) => `${n}×「${clip(head, 20)}」`).join(' · ') : '无'}`);
  console.log(`场外引用     ${offstageRows.length} 条（可进提示词 ${offstageVisible} / hidden ${offstageHidden}）｜被后文点名 ${offstageCited}（${pct(offstageCited, offstageVisible)} of visible）` +
    (offstageDetail.length ? '｜' + offstageDetail.slice(0, 6).map((o) => `t${o.turn_no}:${o.who.join('/') || '?'}${o.cited_at ? '✓' : '✗'}`).join(' ') : ''));
  console.log(`校勘         ${contRows.length} 条（major ${contMajor.length}｜其中挂 open ${contMajorOpen.length}｜minor ${contMinor.length}）`);
  for (const r of contMajor) {
    console.log(`  t${r.turn_no} ${r.kind}/${r.status}${r.severity === 'major' ? '' : ''} [${r.subject}] ${r.claim}`);
  }
  console.log(`史官 uncertain ${Number(uncertainRows || 0)} 条｜消费方 0（不进提示词/不进 threads/无 agent 读）`);

  /* ────────────────────────────────────────────────────────────────────
   * 5. 走向/张力质量
   * 「选择」只有在真的分叉时才是玩法；玩家原文等于 branch description 说明
   * 前端把选项文本当行动文本提交了（选项描述是给玩家看的意图，不是行动）。
   * ──────────────────────────────────────────────────────────────────── */
  const toneMap = new Map();
  const tensionVals = [];
  let branchTurns = 0;
  let copiedPlayer = 0;
  const playerSources = {};
  for (const p of players) {
    const choice = safeJson(p.branch_choice_json);
    const hasChoice = choice && (choice.title || choice.description);
    const meta = safeJson(p.meta_json);
    const src = meta.source || (hasChoice ? 'branch' : 'free');
    playerSources[src] = (playerSources[src] || 0) + 1;
    if (hasChoice) {
      branchTurns += 1;
      const tone = choice.tone || '(none)';
      toneMap.set(tone, (toneMap.get(tone) || 0) + 1);
      if (Number.isFinite(Number(choice.tension_delta))) tensionVals.push(Number(choice.tension_delta));
      if (choice.description && String(p.content || '').trim() === String(choice.description).trim()) copiedPlayer += 1;
    }
  }
  const tensionStats = stats(tensionVals);
  const RISK_TONES = new Set(['激进', '智取', '诡道', '探索']);

  /* 走向选项本身的质量：只能从驱动脚本的 jsonl 读（branches 不落库，只推 SSE）。
   * 这里统计「每拍给了几条」「tone 覆盖面」「描述长度趋势」——
   * 选项条数掉到 0/3 是 branch agent 降级或失败的信号，比玩家选了哪条更早暴露问题。 */
  let branchOptions = null;
  try {
    const jsonl = `_work/tmp-longrun-${sessionId}.jsonl`;
    if (fs.existsSync(jsonl)) {
      const recs = fs
        .readFileSync(jsonl, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => safeJson(l))
        .filter((r) => r && r.phase);
      const optTone = new Map();
      const per = [];
      for (const r of recs) {
        const bs = arr(r.branches);
        const lens = bs.map((b) => String(b.description || '').length);
        for (const b of bs) optTone.set(b.tone || '(none)', (optTone.get(b.tone || '(none)') || 0) + 1);
        per.push({
          phase: r.phase,
          turn_no: Number((String(r.phase).match(/turn_no=(\d+)/) || [])[1]) || null,
          count: bs.length,
          avg_desc_chars: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
        });
      }
      const counts = per.map((p) => p.count);
      const empty = per.filter((p) => p.count === 0);
      const short = per.filter((p) => p.count > 0 && p.count < 4);
      branchOptions = {
        turns_recorded: per.length,
        counts_hist: counts.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {}),
        empty_turns: empty.map((p) => p.phase),
        short_turns: short.map((p) => `${p.phase}:${p.count}`),
        tone_spread: Object.fromEntries([...optTone.entries()].sort((a, b) => b[1] - a[1])),
        avg_desc_chars: per.length ? Math.round(per.reduce((a, p) => a + p.avg_desc_chars, 0) / per.length) : 0,
        desc_first: per[1]?.avg_desc_chars ?? null,
        desc_last: per[per.length - 1]?.avg_desc_chars ?? null,
        per_turn: per,
      };
    }
  } catch { /* jsonl 缺失不影响主判定 */ }

  // 结尾探针沿用 longrun-audit.mjs 的写法：只认具体的「逼你做决定」句式，
  // 不做泛化的「必须」统计（那会把正常叙事里的义务陈述也算成公式化）。
  const FORMULAIC = /必须立刻|必须在这|必须出声|必须决定|必须选择|必须给出|必须回应|该抽手|该选/;
  const COUNTDOWN = /(第[一二三]声|数到|倒数|数了[一二三]|数[一二三]声)/;
  const ENDING_GENERIC = /必须|该[^。，]{0,6}了/;
  let formulaicHits = 0;
  let countdownHits = 0;
  let genericHits = 0;
  const formulaicTurns = [];
  for (const r of asmRows) {
    const tail = r.content.slice(-60);
    if (FORMULAIC.test(tail)) {
      formulaicHits += 1;
      formulaicTurns.push(r.turn_no);
    }
    if (COUNTDOWN.test(tail)) countdownHits += 1;
    if (ENDING_GENERIC.test(tail)) genericHits += 1;
  }

  report.quality = {
    branch_turns: branchTurns,
    player_turns: players.length,
    player_sources: playerSources,
    tones: Object.fromEntries([...toneMap.entries()].sort((a, b) => b[1] - a[1])),
    distinct_tones: toneMap.size,
    tension: tensionStats
      ? {
          ...tensionStats,
          gt0: tensionVals.filter((x) => x > 0).length,
          lt0: tensionVals.filter((x) => x < 0).length,
          eq0: tensionVals.filter((x) => x === 0).length,
        }
      : null,
    copied_player_text: copiedPlayer,
    branch_options: branchOptions,
    endings: {
      window_chars: 60,
      formulaic: formulaicHits,
      formulaic_rate: asmRows.length ? formulaicHits / asmRows.length : null,
      formulaic_turns: formulaicTurns,
      countdown: countdownHits,
      generic_must: genericHits,
    },
  };

  console.log(h('5. 走向/张力质量'));
  console.log(`分支选择     ${branchTurns}/${players.length} 轮有分支｜来源 ${JSON.stringify(playerSources)}`);
  if (branchOptions) {
    console.log(
      `选项供给     记录 ${branchOptions.turns_recorded} 拍｜条数分布 ${JSON.stringify(branchOptions.counts_hist)}` +
      `｜空 ${branchOptions.empty_turns.length} 拍${branchOptions.empty_turns.length ? '（' + branchOptions.empty_turns.join(',') + '）' : ''}` +
      `｜不足 4 条 ${branchOptions.short_turns.length} 拍`
    );
    console.log(
      `选项文本     描述均长 ${branchOptions.avg_desc_chars} 字（首拍 ${branchOptions.desc_first} → 末拍 ${branchOptions.desc_last}）` +
      `｜tone 覆盖 ${Object.keys(branchOptions.tone_spread).length} 种 ${JSON.stringify(branchOptions.tone_spread)}`
    );
  }
  console.log(`tone 分布    ${toneMap.size ? [...toneMap.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ') : MISSING}｜${toneMap.size} 种` +
    (tensionVals.length ? `｜冒险面 ${tensionVals.filter((x) => x > 0).length}·日常面 ${tensionVals.filter((x) => x <= 0).length}` : ''));
  console.log(`张力         ${tensionStats ? `mean=${r3(tensionStats.mean)}｜min=${tensionStats.min}｜p50=${tensionStats.p50}｜max=${tensionStats.max}｜>0 ${report.quality.tension.gt0}｜<0 ${report.quality.tension.lt0}｜=0 ${report.quality.tension.eq0}` : MISSING}`);
  console.log(`玩家行动     = 分支描述原文 ${copiedPlayer}/${players.length}｜风险向 tone 命中 ${[...toneMap.entries()].filter(([k]) => RISK_TONES.has(k)).reduce((a, b) => a + b[1], 0)}`);
  console.log(`结尾公式     60 字内「必须/该…了」型 ${formulaicHits}/${narr.length}（${pct(formulaicHits, narr.length)}）` +
    `｜倒数/数声 ${countdownHits}｜泛化必须/该…了 ${genericHits}`);

  /* ────────────────────────────────────────────────────────────────────
   * 6. 用量与耗时
   * 整轮成本 ≈ narrator + 史官 + 场记 + 世界呼吸 + 走向 + 检索。只看 narrator
   * 会低估 3-5 倍（§4.4 的实测结论），所以两个数都给。
   * ──────────────────────────────────────────────────────────────────── */
  const narratorUsage = asmRows.map((r) => r.usage).filter((u) => u && Object.keys(u).length);
  const durStats = stats(narratorUsage.map((u) => Number(u.duration_ms)));
  const compStats = stats(narratorUsage.map((u) => Number(u.completion_tokens)));
  const promptPts = asmRows
    .filter((r) => Number(r.usage?.prompt_tokens) > 0)
    .map((r) => [r.turn_no, Number(r.usage.prompt_tokens)]);
  const promptSlope = slopeOf(promptPts);
  const byAgent = sessionUsage.by_agent && typeof sessionUsage.by_agent === 'object' ? sessionUsage.by_agent : null;
  const totalReq = Number(sessionUsage.requests) || 0;
  const narratorPrompt = narratorUsage.reduce((a, u) => a + (Number(u.prompt_tokens) || 0), 0);
  const narratorComp = narratorUsage.reduce((a, u) => a + (Number(u.completion_tokens) || 0), 0);
  const perTurn = narr.length
    ? {
        requests: totalReq / narr.length,
        prompt_tokens: (Number(sessionUsage.prompt_tokens) || 0) / narr.length,
        completion_tokens: (Number(sessionUsage.completion_tokens) || 0) / narr.length,
        narrator_prompt_tokens: narratorPrompt / narr.length,
        narrator_completion_tokens: narratorComp / narr.length,
        total_ms: (Number(sessionUsage.total_ms) || 0) / narr.length,
      }
    : null;

  report.usage = {
    session: {
      requests: Number(sessionUsage.requests) || 0,
      prompt_tokens: Number(sessionUsage.prompt_tokens) || 0,
      completion_tokens: Number(sessionUsage.completion_tokens) || 0,
      cached_tokens: Number(sessionUsage.cached_tokens) || 0,
      reasoning_tokens: Number(sessionUsage.reasoning_tokens) || 0,
      total_ms: Number(sessionUsage.total_ms) || 0,
      cache_rate: Number(sessionUsage.prompt_tokens)
        ? (Number(sessionUsage.cached_tokens) || 0) / Number(sessionUsage.prompt_tokens)
        : null,
    },
    by_agent: byAgent,
    narrator: {
      duration_ms: durStats,
      completion_tokens: compStats,
      prompt_slope_per_turn: promptSlope,
    },
    per_turn: perTurn,
  };

  console.log(h('6. 用量与耗时'));
  console.log(`总计         requests=${num(sessionUsage.requests)} prompt=${num(sessionUsage.prompt_tokens)} completion=${num(sessionUsage.completion_tokens)} ` +
    `cached=${num(sessionUsage.cached_tokens)}（命中 ${pct(Number(sessionUsage.cached_tokens) || 0, Number(sessionUsage.prompt_tokens) || 0)}） total_ms=${num(sessionUsage.total_ms)}`);
  if (byAgent) {
    for (const [agent, u] of Object.entries(byAgent)) {
      console.log(`  ${String(agent).padEnd(12)} req=${num(u.requests)} prompt=${num(u.prompt_tokens)} completion=${num(u.completion_tokens)} cached=${num(u.cached_tokens)}`);
    }
  } else {
    console.log(`  by_agent     ${MISSING}`);
  }
  console.log(`narrator     duration p50=${durStats ? Math.round(durStats.p50) : MISSING}ms p90=${durStats ? Math.round(durStats.p90) : MISSING}ms max=${durStats ? Math.round(durStats.max) : MISSING}ms` +
    `｜completion p50=${compStats ? compStats.p50 : MISSING} p90=${compStats ? compStats.p90 : MISSING}`);
  console.log(`prompt 斜率  ${r1(promptSlope)} tok/轮（narrator 送模体积随轮次增长）`);
  console.log(`每轮成本     ≈ prompt ${Math.round(perTurn?.prompt_tokens ?? 0)} tok / completion ${Math.round(perTurn?.completion_tokens ?? 0)} tok / 墙钟 ${((perTurn?.total_ms ?? 0) / 1000).toFixed(1)}s` +
    `｜其中 narrator 部分 prompt ${Math.round(perTurn?.narrator_prompt_tokens ?? 0)} / completion ${Math.round(perTurn?.narrator_completion_tokens ?? 0)}` +
    `｜每轮 ${r1(perTurn?.requests)} 次请求`);
  console.log(`说明         货币成本 = 上述 token × 当前模型单价；本脚本不内置价格，避免过期数字误导`);

  /* ────────────────────────────────────────────────────────────────────
   * 7. 验收判定
   * 每条检查返回 {id, label, status, detail}。FAIL 优先于 WARN：
   * 只要有一条 FAIL，整体 VERDICT 就是 FAIL（长跑验收不接受「大部分通过」）。
   * ──────────────────────────────────────────────────────────────────── */
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });

  // 7.1 缓存前缀不可漂
  add(
    'system_hash_unique',
    `system_hash unique == ${TH.SYSTEM_HASH_UNIQUE}`,
    hashRows.length === 0
      ? 'WARN'
      : uniqueHashes.length === TH.SYSTEM_HASH_UNIQUE
        ? 'PASS'
        : 'FAIL',
    hashRows.length === 0 ? '没有 cache.system_hash（旧数据或未装探针）' : `unique=${uniqueHashes.length} / ${hashRows.length} 轮 (${uniqueHashes.join(',')})`
  );

  // 7.1b 缓存前缀复用（C5，baseline §9 变更后的口径）
  //
  // 判的是**前缀是否真的在复用**，不是 drift 的字符串 verdict：
  //   · prefix_shared_tokens 单调不降（断点没往前提）→ 缓存能逐轮吃掉整段前缀
  //   · broken 里真断点（上轮消息被改写/插队）占比为 0
  // 为什么不再看 drift.verdict：场次索引是**同一条 user 消息**逐轮尾部追加，
  // 只要索引在长，整条比对就恒为 broken（见 prompt-drift.js:70 与 interim-findings O3）。
  const appendOnlyRate = breakRows.length ? appendBreaks.length / breakRows.length : null;
  let prefixStatus = 'PASS';
  let prefixDetail =
    `prefix_shared_tokens ${num(report.cache.prefix_shared_tokens.first)} → ${num(report.cache.prefix_shared_tokens.last)}` +
    `｜回退 ${prefixRegressions.length} 次` +
    `｜broken ${breakRows.length} 轮 = 追加 ${appendBreaks.length} + 真断 ${realBreaks.length} + 减消息 ${droppedBreaks.length}`;
  // 真断点分两种，代价完全不同，而且可以从 drift 自带字段确定性区分：
  //   · insert（next_count > prev_count）本轮消息数变多 ⇒ 某层在断点位置**插入/重新进入**
  //     （场次索引首次有内容、原文窗口随封场清空后又重新填满）→ 后面的消息整体右移。
  //     这是结构生命周期的必然事件，不是「前缀被改动」；
  //   · rewrite（next_count <= prev_count）消息数没变或变少仍有断点 ⇒ 同一条消息被**改写**
  //     （分支切换、降级裁层、措辞变化）。这才是每轮重复烧前缀的东西，必须为 0。
  // 判据因此是「prefix 不回退 + rewrite == 0」，insert 只计数并在报告里注明成因。
  const insertByIndex = new Map();
  for (const r of insertBreaks) {
    const k = r.drift.index === null || r.drift.index === undefined ? '(null)' : Number(r.drift.index);
    insertByIndex.set(k, (insertByIndex.get(k) || 0) + 1);
  }
  // 同一位重复插入 = 该层在反复进出（实测是 recent：每次封场清空、下几拍再填回）。
  const repeatedInsertPositions = [...insertByIndex.entries()].filter(([, c]) => c > 1);
  if (prefixSeries.length < 2) {
    prefixStatus = 'WARN';
    prefixDetail += '｜样本不足 2 轮';
  } else if (unexplainedRegressions.length > 0) {
    // 前缀变短且消息数没变少＝同一条消息被改写/裁掉，缓存整段作废，这是真问题。
    prefixStatus = 'FAIL';
    prefixDetail += `｜无法解释的前缀回退 ${unexplainedRegressions.length} 次` +
      `（${unexplainedRegressions.map((x) => `t${x.from}→t${x.to} ${x.delta}`).join(' · ')}）` +
      '：消息数没变少却变短＝同消息被改写';
  } else if (report.cache.broken.real_break_rewrite > 0) {
    prefixStatus = 'FAIL';
    prefixDetail += `｜同消息改写断点 ${report.cache.broken.real_break_rewrite} 轮（t${turnRanges(rewriteBreaks.map((r) => r.turn_no))}）`;
  } else if (droppedBreaks.length > 0) {
    prefixStatus = 'WARN';
    prefixDetail += '｜存在消息数减少的轮次（裁层/丢历史）';
  }
  if (structuralRegressions.length > 0) {
    prefixDetail += `｜记忆窗口轮转 ${structuralRegressions.length} 次、累计重付 ${structuralCostTokens} tok` +
      `（${structuralRegressions.map((x) => `t${x.from}→t${x.to} ${x.delta}`).join(' · ')}）`;
  }
  if (repeatedInsertPositions.length > 0) {
    prefixDetail += `｜层重复进出 ${repeatedInsertPositions.map(([k, c]) => `#${k}×${c}`).join(' · ')}` +
      '（每次封场清空 recent、后续再填回，属设计行为；它让该位置之后的前缀重算一次）';
  }
  add(
    'cache_prefix_reuse',
    '无「同消息改写」断点 且 前缀回退只能由记忆窗口轮转解释（structural 只计数）',
    prefixStatus,
    prefixDetail
  );

  // 7.2 场次覆盖 + 原文窗口接缝
  const covStatus = covChecked.length === 0
    ? 'WARN'
    : covViolations.length === 0 && covOkRate >= TH.COVERAGE_OK_RATE
      ? 'PASS'
      : 'FAIL';
  const holeScenes = sceneGaps.filter((g) => g.hole);
  add(
    'coverage_seam',
    'scene_to+1 === recent_from（100%）且场次无洞',
    covStatus === 'PASS' && holeScenes.length > 0 ? 'FAIL' : covStatus,
    `接缝 ${covChecked.length ? pct(covChecked.length - covViolations.length, covChecked.length) : MISSING}` +
    `｜违约轮 ${covViolations.length ? 't' + turnRanges(covViolations) : '无'}` +
    `｜场次洞 ${holeScenes.length ? holeScenes.map((g) => g.prev_scene + '→' + g.next_scene).join(',') : '无'}`
  );

  // 7.2b 孤儿玩家回合（interim-findings O6）
  //
  // `runTurn()` 先把玩家行动落库、再跑 narrator。narrator 失败（上游 fetch failed）
  // 时行动已落库而正文为空，下一拍装配的 recent 窗口按 `turn_no > scene_to` 取回合，
  // **不区分「被演过的行动」与「没人应答的行动」**，于是同一段正文把两次行动一起演掉，
  // 随后史官把这一场记成 turn_from=孤儿轮、turn_to=本轮，把缺口吸收掉
  // → `scene_to + 1 === recent_from` 仍然成立，结构检查抓不到。
  // 所以必须单列一条：孤儿回合数必须为 0。
  // 末尾那条「有玩家行动、还没旁白」是跑到一半的正常状态（脚本可能正在跑），
  // 只有**被后面回合越过**的孤儿才是真缺口。
  const maxTurnNo = Math.max(0, ...turns.map((t) => Number(t.turn_no)));
  const pendingTurns = unpairedPlayers.filter((n) => n === maxTurnNo);
  const orphanTurns = unpairedPlayers.filter((n) => n !== maxTurnNo);
  // 被吸收的证据：孤儿轮落在某场次的 [turn_from, turn_to] 区间里，却没有自己的旁白。
  const absorbedOrphans = orphanTurns.filter((no) =>
    sceneRows.some((r) => no >= r.turn_from && no <= r.turn_to));
  add(
    'orphan_player_turns',
    '孤儿玩家回合 == 0（玩家行动落库但旁白为空，会被下一拍连演两次）',
    orphanTurns.length === 0 ? 'PASS' : 'FAIL',
    (orphanTurns.length === 0
      ? `player ${players.length} 行全部有对应旁白`
      : `孤儿 ${orphanTurns.length} 个：t${turnRanges(orphanTurns)}` +
        `（其中 ${absorbedOrphans.length} 个已被场次区间吸收，覆盖检查查不出来）` +
        `｜复现：select turn_no from turns where session_id=? and kind='player' and turn_no not in ` +
        `(select turn_no from turns where session_id=? and kind='narrator')`) +
    (pendingTurns.length ? `｜末尾 t${turnRanges(pendingTurns)} 为在跑回合，未计入` : '')
  );

  // 7.2c 校勘结论是否被吸收（interim-findings O8）
  //
  // 校勘是系统里唯一「主动发现问题」的通道：它读原文与账本、产出 contradiction /
  // state_jump / knowledge_breach / stale_thread。若它报出的 major 级问题一直挂 open，
  // 说明「发现」没有变成「处置」——这和 O9（史官写 uncertain 没人读）是同一类缺口。
  // 定 WARN 而不是 FAIL：校勘的 fix 是否该自动应用是产品决策（当前只自动应用
  // state_jump / stale_thread 两类），挂 open 的 contradiction 是**待人工裁决**，
  // 不是系统的违约行为。但长跑里它必须被看见，所以不能只记 INFO。
  add(
    'continuity_absorbed',
    '校勘报出的 major 级问题不应长期挂 open',
    contMajor.length === 0 ? 'WARN'
      : contMajorOpen.length === 0 ? 'PASS' : 'WARN',
    contMajor.length === 0
      ? '本局未触发 major 级校勘（间隔/切场才触发，样本不足）'
      : `major ${contMajor.length} 条，open ${contMajorOpen.length} 条` +
        (contMajorOpen.length ? '：' + contMajorOpen.map((r) => `t${r.turn_no}/${r.kind}`).join(',') : '') +
        `｜minor ${contMinor.length} 条只计数`
  );

  // 7.3 降级与硬上限
  const degradedRate = narr.length ? degradedTurns.length / narr.length : 0;
  const hardCapFailTurns = asmRows.filter((r) => r.hard_cap?.mode === 'fail' && arr(r.hard_cap?.narrowed).length > 0);
  const hardCapErrorTurns = asmRows.filter((r) => String(r.hard_cap?.mode || '').startsWith('error'));
  add(
    'degraded_rate',
    `degraded 轮次占比 < ${(TH.DEGRADED_MAX_RATE * 100).toFixed(0)}% 且无 hard_cap 处置`,
    degradedRate > TH.DEGRADED_MAX_RATE || hardCapTurns.length > 0 || hardCapFailTurns.length > 0 || hardCapErrorTurns.length > 0
      ? 'FAIL'
      : 'PASS',
    `degraded ${degradedTurns.length}/${narr.length}（${pct(degradedTurns.length, narr.length)}）` +
    `｜hard_cap 收窄/非 fail ${hardCapTurns.length} 轮` +
    (hardCapTurns.length ? '：' + hardCapTurns.map((x) => `t${x.turn_no}/${x.mode}`).join(',') : '')
  );

  // 7.4 预算斜率与上下界
  const overSoft = softMax && peakRow && peakRow.total > softMax;
  const overHard = hardMax && peakRow && peakRow.total > hardMax;
  let budgetStatus = 'PASS';
  let budgetDetail = `斜率 ${r1(totalSlope)} tok/轮｜峰值 ${peakRow?.total ?? MISSING} vs soft ${num(softMax)} / hard ${num(hardMax)}`;
  if (totalSlope === null) {
    budgetStatus = 'WARN';
    budgetDetail += '｜预算样本不足 2 轮';
  } else if (totalSlope <= TH.BUDGET_SLOPE_MIN) {
    budgetStatus = 'FAIL';
    budgetDetail += '｜斜率 ≤ 0：记忆没有在累积';
  } else if (overHard) {
    // 越过硬上限是 fail-closed 的前兆，属于违约而不是「偏大」。
    budgetStatus = 'FAIL';
    budgetDetail += '｜峰值越过 hard_max';
  } else if (overSoft) {
    budgetStatus = 'WARN';
    budgetDetail += '｜峰值越过 soft_max（只 WARN，§6.3 允许软目标被记忆载体占用）';
  }
  add('budget_growth', '预算斜率 > 0 且峰值 ≤ soft_max（> soft 仅 WARN）', budgetStatus, budgetDetail);

  // 7.5 套话化（3-gram p90，启发式）
  const gramP90 = gramStats?.p90 ?? null;
  const gram3Detail =
    gramP90 === null
      ? '样本不足'
      : `p90 ${(gramP90 * 100).toFixed(1)}%（WARN 线 ${(TH.GRAM3_P90_WARN * 100).toFixed(0)}% / FAIL 线 ${(TH.GRAM3_P90_FAIL * 100).toFixed(0)}%；阈值是启发式，非契约）` +
        `｜重复开头 ${dupOpenings.length} 处｜重复短语 ${phraseTop.length} 条`;
  // 累积口径只作参考值打印：它随轮数单调上涨（df≥2 集合只增不减），不能当长跑判据。
  add(
    'gram3_p90_ref',
    '累积 3-gram 重复率（参考值，不判定）',
    'INFO',
    gram3Detail || '样本不足'
  );

  // 7.5b 局部重复率（5-gram vs 前 3 轮）：长跑真正可用的口径，与轮数解耦。
  //
  // 只报 p90 会把「少数几拍真的在抄自己」抹平：实测 64 个样本里 p90 = 6.5% 判 PASS，
  // 但 t47 = 23.2%、t50 = 23.6% 已越过 20% 的 FAIL 线，另有 t44/t45 越 WARN 线——
  // 分位数本来就会把 3% 的尾部忽略掉。所以尾部单独给一条判据：
  // 「越 FAIL 线的拍数占比 ≤ 5%」且「越 WARN 线的拍数占比 ≤ 10%」。
  const localP90 = localStats?.p90 ?? null;
  const localVals = localRates.filter((g) => g.rate !== null);
  const overFail = localVals.filter((g) => g.rate > TH.REPEAT_LOCAL_FAIL);
  const overWarn = localVals.filter((g) => g.rate > TH.REPEAT_LOCAL_WARN);
  const failShare = localVals.length ? overFail.length / localVals.length : null;
  const warnShare = localVals.length ? overWarn.length / localVals.length : null;
  add(
    'repeat_local',
    `局部重复率 p90 < ${(TH.REPEAT_LOCAL_WARN * 100).toFixed(0)}%（5-gram vs 前 3 轮）`,
    localP90 === null
      ? 'WARN'
      : localP90 <= TH.REPEAT_LOCAL_WARN
        ? 'PASS'
        : localP90 <= TH.REPEAT_LOCAL_FAIL
          ? 'WARN'
          : 'FAIL',
    localP90 === null
      ? '样本不足'
      : `mean ${(localStats.mean * 100).toFixed(1)}% / p90 ${(localP90 * 100).toFixed(1)}%` +
        (localRates.filter((g) => g.rate !== null).sort((a, b) => b.rate - a.rate).slice(0, 3)
          .map((g) => `｜最高 t${g.turn_no}:${(g.rate * 100).toFixed(0)}%`).join(''))
  );
  // 尾部判据：分位数看不见的少数几拍，单独一条。
  add(
    'repeat_local_tail',
    `越 FAIL 线（>${(TH.REPEAT_LOCAL_FAIL * 100).toFixed(0)}%）的拍数占比 ≤ 5% 且越 WARN 线 ≤ 10%`,
    failShare === null
      ? 'WARN'
      : failShare > 0.05 ? 'FAIL' : warnShare > 0.10 ? 'WARN' : 'PASS',
    failShare === null
      ? '样本不足'
      : `越 FAIL ${overFail.length}/${localVals.length}（${(failShare * 100).toFixed(1)}%）` +
        `｜越 WARN ${overWarn.length}/${localVals.length}（${(warnShare * 100).toFixed(1)}%）` +
        (overFail.length ? `｜${overFail.map((g) => `t${g.turn_no}:${(g.rate * 100).toFixed(0)}%`).join(' ')}` : '')
  )

  // 7.6 死亡表述 vs life_state 写入
  // 口径改过两次，最终只认确定性信号，不再用「死亡表述轮次 vs 写入行数」的比例：
  //   ① 正文死亡词是**叙述用语**（死寂/死的凉/跪死/该死了），与「谁死了」无确定关系，
  //      比例判据在 30 拍样本上只会产出误报（实测 16 轮 → 去噪后 5 轮，且无一是角色死亡）；
  //   ② 真正可证伪的是「写了 gone/dead 的人，后文还能不能上场」——用 present 名单交叉。
  let lifeStatus = 'PASS';
  let lifeDetail =
    `dead/gone 写入 ${deadWrites} 行｜正文死亡用语 ${deathTurns.length} 轮（仅叙述用语，不作判据）` +
    `｜离场后仍被提名 ${lifeLeaks.length} 例`;
  if (lifeFatal.length > 0) {
    lifeStatus = 'FAIL';
    lifeDetail += `｜离场后仍在场：${lifeFatal.map((x) => `${x.who}(${x.value}@t${x.from}${x.valid_to == null ? '' : `-t${x.valid_to}`}→t${x.in_present.join(',')})`).join(' · ')}（§13.22）`;
  } else if (lifeLeaks.length > 0) {
    lifeStatus = 'WARN';
    lifeDetail += `｜${lifeLeaks.map((x) => `${x.who}(${x.value}@t${x.from}${x.valid_to == null ? '' : `-t${x.valid_to}`})→正文 t${x.turns.join(',')}，但不在 present 名单（机制生效、正文没跟上）`).join(' · ')}`;
  }
  add('life_state_consistency', '离场/死亡角色不得再上场（present 名单交叉，非比例判据）', lifeStatus, lifeDetail);

  // 7.7 封场与时间推进
  add(
    'scene_closure',
    `场景数 ≥ ${TH.SCENE_MIN}（长跑必须真的封过场）`,
    sceneRows.length >= TH.SCENE_MIN ? 'PASS' : 'FAIL',
    `scenes=${sceneRows.length}`
  );
  let whenStatus = 'PASS';
  if (whenChanges < TH.WHEN_CHANGE_MIN) whenStatus = sceneRows.length >= TH.SCENE_MIN_FOR_WHEN ? 'FAIL' : 'WARN';
  add(
    'time_progression',
    `时间标签变化 ≥ ${TH.WHEN_CHANGE_MIN} 次`,
    whenStatus,
    `变化 ${whenChanges} 次 / ${sceneRows.length} 场（${whenSeq[0] || '—'} → ${whenSeq[whenSeq.length - 1] || '—'}）` +
    (whenStatus === 'WARN' ? '｜场次不足，无法产生 3 次变化（样本不足）' : '')
  );

  // 7.8 tone 多样性
  let toneStatus = 'PASS';
  if (toneMap.size < TH.TONE_MIN) toneStatus = branchTurns < TH.BRANCH_SAMPLE_MIN ? 'WARN' : 'FAIL';
  add(
    'tone_variety',
    `分支 tone ≥ ${TH.TONE_MIN} 种`,
    toneStatus,
    `tone ${toneMap.size} 种 / ${branchTurns} 次分支选择` + (toneStatus === 'WARN' ? '｜分支样本不足 3 次（样本不足）' : '')
  );

  // 7.9b 单拍长度离群（超阈值只 WARN：它衡量节奏，不衡量正确性）
  add(
    'len_outlier',
    `单拍正文长度 max/p50 ≤ ${TH.LEN_OUTLIER_RATIO}×`,
    lenRatio === null ? 'WARN' : lenRatio <= TH.LEN_OUTLIER_RATIO ? 'PASS' : 'WARN',
    lenRatio === null
      ? '无 narrator 轮'
      : `${lenRatio}×` + (lenOutliers.length ? `｜离群 ${lenOutliers.map((o) => `t${o.turn_no}:${o.chars}字`).join(' ')}` : '')
  );

  // 7.9 结尾公式化（辅助项：超阈值只 WARN，它衡量文风而不衡量正确性）
  const formulaicRate = narr.length ? formulaicHits / narr.length : null;
  add(
    'ending_formula',
    `结尾公式化 ≤ ${(TH.ENDING_FORMULA_MAX_RATE * 100).toFixed(0)}%`,
    formulaicRate === null ? 'WARN' : formulaicRate <= TH.ENDING_FORMULA_MAX_RATE ? 'PASS' : 'WARN',
    formulaicRate === null ? '无 narrator 轮' : `${formulaicHits}/${narr.length}（${(formulaicRate * 100).toFixed(0)}%）`
  );

  // 7.10 场外事件引用率
  // 分母只算 rumor/public（hidden 按设计永不进提示词，见上方口径修正）。
  const offRate = offstageVisible ? offstageCited / offstageVisible : null;
  add(
    'offstage_cited',
    `场外事件（rumor/public）被后文点名 ≥ ${(TH.OFFSTAGE_CITE_MIN * 100).toFixed(0)}%`,
    offRate === null ? 'WARN' : offRate >= TH.OFFSTAGE_CITE_MIN ? 'PASS' : 'WARN',
    offRate === null
      ? '没有可进提示词的 offstage_event'
      : `${offstageCited}/${offstageVisible}（${pct(offstageCited, offstageVisible)}）` +
        `｜另 hidden ${offstageHidden} 条按设计永不外泄，不计入`
  );

  const tally = { PASS: 0, WARN: 0, FAIL: 0 };
  // INFO 是参考值，不进 tally——否则 PASS+WARN+FAIL 之和与检查条数对不上。
  for (const c of checks) if (c.status in tally) tally[c.status] += 1;
  const verdict = tally.FAIL > 0 ? 'FAIL' : tally.WARN > 0 ? 'WARN' : 'PASS';

  report.checks = checks;
  report.verdict = verdict;
  report.tally = tally;
  report.sample = {
    narrator_turns: narr.length,
    long_run_min_turns: TH.LONG_RUN_MIN_TURNS,
    is_long_run: narr.length >= TH.LONG_RUN_MIN_TURNS,
  };

  console.log(h('7. 验收判定'));
  for (const c of checks) {
    const tag = c.status === 'INFO' ? 'INFO' : c.status === 'PASS' ? 'PASS' : c.status === 'WARN' ? 'WARN' : 'FAIL';
    console.log(`[${tag}] ${c.label}`);
    console.log(`       ${c.detail}`);
  }
  if (!report.sample.is_long_run) {
    console.log(`\n注意：narrator 轮 ${narr.length} < ${TH.LONG_RUN_MIN_TURNS}，本报告按长跑口径判定，` +
      `短会话的 FAIL 属预期（阈值不是为 4 轮设计的）。`);
  }
  // VERDICT 必须是最后一行：验收脚本会 grep 这一行，前面留空行会让 `tail -1` 拿到空串。
  console.log(`VERDICT: ${verdict}   (PASS ${tally.PASS} / WARN ${tally.WARN} / FAIL ${tally.FAIL})`);

  if (jsonOut) {
    // 报告已经打到 stdout 了，写 JSON 失败不该把一个跑成功的报告变成「看起来崩了」：
    // 只报一行人话并置非零退出码，方便 CI 发现「以为存了其实没存」。
    try {
      fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n', 'utf8');
      console.error(`json written: ${jsonOut}`);
    } catch (e) {
      console.error(`cannot write json: ${jsonOut}\n  ${e?.message || e}`);
      process.exitCode = 1;
    }
  }
} finally {
  db.close();
}
