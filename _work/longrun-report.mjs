/**
 * longrun-report.mjs — 长跑（40+ 轮）验收的**量化半边**（只读 DB，不调模型、不改数据）。
 *
 * 它既是「这一局发生了什么」也是「算不算通过」：逐项陈述在前六段，判定在 §7。
 * 所以每个数字都必须落进某个检查项，没被检查的数字只是证据，不是结论。
 * （原先还有一份 `longrun-audit.mjs` 做定性半边，它唯一独有且判定层没覆盖的
 * 「正文点名率 / 人物分档」已于 2026-10-29 并入本脚本第 2 段，遂删除该文件。）
 *
 * 六段：规模节奏 / 上下文增量 / 缓存前缀 / 记忆一致性 / 走向张力 / 用量耗时，
 * 最后是 §7 的 PASS/WARN/FAIL 判定表。阈值全部提到文件顶部并注明依据——阈值散落在
 * 检查逻辑里时，改装订口径就得读完全文，最后没人敢改。
 *
 * 语义边界（不变量出处见 AGENTS.md）：
 *   - `meta.recall` 是「索引饱和度」，恒 ≈100%，**不衡量叙事有没有用到卡**；
 *     叙事覆盖率由正文点名率承担（已在第 2 段「叙事点名」报）。本脚本不重复报 recall 当质量分。
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

  // 场次覆盖无洞 + `recent_from + overlap_turns === scene_to+1` 必须恒成立（§13.14）。
  // 原文窗口是「场次接住之后」的唯一真相，漏一轮就是静默失忆，所以要求 100%。
  // D1 之后判据放宽的是**重叠**（刚封场还留着上一拍，有意为之），不是**洞**：
  // `recent_from > scene_to + 1` 仍然一票违规，且重叠拍数必须与 overlap_turns 对得上。
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
  // 判定用**回合粒度**（states.time 逐拍），不是场次粒度。少于这么多拍时不给 FAIL。
  // 场次粒度会低估：`when_label` 只记封场那一刻，场内推进不产生新标签。
  WHEN_TURN_MIN: 10,

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
// 单值百分比（已经是 0..1 的比例）：pct(a, b) 是「a 占 b 的百分比」，
// 不能把比例当成 a 传进去，否则会显示成 —（分母缺失）。
const pctv = (r) => (typeof r === 'number' && Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : '(缺失)');
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
/** 分位数按「已升序」数组取（线性插值），与 _work/README.md 记录的口径一致。 */
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

  // 时间推进必须按**回合粒度**量，不能只看场次。
  // `scenes.when_label` 记的是封场那一刻的 `ledger.time`，一个场次只有一行，
  // 场内推进（同一天从「午后」走到「天擦黑」）根本不产生新的场景标签。
  // 曾因此把「5 场只有 3 个标签」判成 FAIL，而同一局回合粒度是 4 次变化——
  // 与 D19 同一种病：判据量错了层级，结论方向就反了。
  const stateRows = all(
    `select turn_no, state_json from states where session_id = :sid order by turn_no asc`,
    { sid: sessionId }
  ) ?? [];
  const whenTurnSeq = stateRows
    .map((r) => {
      const st = safeJson(r.state_json) || {};
      return String(st.time || st.when || '').trim();
    })
    .filter(Boolean);
  const whenTurnChanges = whenTurnSeq.slice(1).filter((w, i) => w !== whenTurnSeq[i]).length;

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
      layers_truncated: asm.layers_truncated || null,
      // 断言在**窗口内**还要再过一道 selectFacts：单值谓词全渲染、多值谓词只留 manyLimit 条。
      // 不记这一组，报告会把「加载 123 条、渲染 24 条」显示成「123 条都给了模型」。
      // `split` 为 false = 存量会话（加这组字段之前跑的），只有 rendered 与 loaded 可用；
      // 这两个数足以算出「窗口内被裁掉多少」，不要因为细分项缺失就整段判「无数据」。
      facts: (() => {
        const candidates = Number(asm.facts_candidates) || 0;
        const rendered = Number(asm.facts) || 0;
        const single = Number(asm.facts_single) || 0;
        const manyRendered = Number(asm.facts_many_rendered) || 0;
        const manyDropped = Number(asm.facts_many_dropped) || 0;
        const split = candidates > 0;
        const loaded = Number(asm.layers_truncated?.assertions?.loaded) || 0;
        return {
          rendered,
          candidates: split ? candidates : loaded,
          single,
          many_rendered: manyRendered,
          many_dropped: split ? manyDropped : Math.max(0, loaded - rendered),
          split,
        };
      })(),
      // 关系渲染上限（D17）：`LIMIT 60` 只是加载量，真上限由预算推导。
      // `relations_limit` 是后加的字段：旧会话行没有它 → null，报告要显示 MISSING
      // 而不是把 undefined 当成「0 条上限」（同 history_self_echo 的坑）。
      relations: (() => {
        const limit = asm.relations_limit == null ? null : Number(asm.relations_limit);
        const rendered = asm.relations_rendered == null ? null : Number(asm.relations_rendered);
        const lt = asm.layers_truncated?.relations || {};
        const loaded = Number(lt.loaded) || 0;
        const total = Number(lt.total) || 0;
        // 两端都在场的关系数：要现场从 relations 表反查代价太大，这里用「渲染条数里
        // 有多少是两端在场」的近似不可得 → 只报渲染/上限/装载，两端在场由探针另算。
        return {
          limit,
          rendered: rendered ?? (limit == null ? null : loaded),
          loaded,
          total,
          both_present: null,
        };
      })(),
      // 走向版场记单（D26-B）：agent=branch 拿到的单子比送模那份少了哪一段、各多少 token。
      // 回声段（D18）已从代码里删掉，旧会话没有这个字段 → null（不是 0）。
      branch_sheet: (() => {
        const b = asm.scene_sheet?.branch_sheet;
        if (!b) return { known: false, trim: null, dropped: null, tokens: null, full_tokens: null };
        return {
          known: true,
          // 档位（D26）：default = 只去「附近设定」；core_only = 方案 A 实验臂。
          // 不记下来的话，两局报告长得一样，看不出跑的是哪个臂。
          trim: b.trim || 'default',
          dropped: Array.isArray(b.dropped_sections) ? b.dropped_sections : [],
          tokens: b.tokens == null ? null : Number(b.tokens),
          full_tokens: b.full_tokens == null ? null : Number(b.full_tokens),
        };
      })(),
      // 原声可见性（D23）：`voices` 每人取 perWho 条、渲染 slice(0,2)，两道都按人分区，
      // 所以「有没有声线锚点」只看在场者里被覆盖了几个人。
      // 旧会话没有这三个字段 → null（不是 0）。
      voices: (() => {
        const sp = asm.scene_sheet?.voice_speakers;
        const ln = asm.scene_sheet?.voice_lines;
        const cov = asm.scene_sheet?.voice_present_covered;
        return {
          speakers: sp == null ? null : Number(sp),
          lines: ln == null ? null : Number(ln),
          present_covered: cov == null ? null : Number(cov),
        };
      })(),
      // 资料员预检（D4）：两条通道各查了什么、各花了多少 token。
      // 没有这个字段，报告里回答不了「历史回查到底被触发了几次」。
      retrieval: asm.retrieval || null,
      // 辞书两道出口（D24）：全文 codexT0 与简报 codexT1 各自的候选/渲染数。
      // 简报那道是 floor(sceneCap*0.2/40) 条（200K 下 112），51 拍实测丢了 46%——
      // 这几个数此前一个都没落库，报告里显示为完全健康。
      // 旧会话没有这些字段 → null（不是 0），否则「没量到」会被读成「一条都没丢」。
      codex: (() => {
        const num = (v) => (v == null ? null : Number(v));
        return {
          candidates: num(asm.codex_candidates),
          rendered: num(asm.codex_rendered),
          dropped: num(asm.codex_dropped),
          brief_candidates: num(asm.codex_brief_candidates),
          brief_rendered: num(asm.codex_brief_rendered),
        };
      })(),
      // 渲染前体检的干预记录（D24）：lint-state 从 present 剔人、改物品持有人。
      // 51 拍实测 8 拍有干预（全是「gone 的凌玥被剔出在场」），此前完全不落库。
      state_fixes: Array.isArray(asm.state_fixes) ? asm.state_fixes : null,
      state_warnings: Array.isArray(asm.state_warnings) ? asm.state_warnings : null,
      // 成长曲线（D24）：total / unlocked / omens。旧会话 null。
      fates: asm.fates && typeof asm.fates === 'object'
        ? {
          total: Number(asm.fates.total) || 0,
          unlocked: arr(asm.fates.unlocked).length,
          omens: arr(asm.fates.omens).length,
        }
        : null,
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

  /* 空正文回合：上游偶发只产出 reasoning、content 为空。orchestrator 会关推理重试一次
   * （`server/agents/orchestrator.js:282-309`）。
   *
   * **`narration.fallback='empty_content'` 只说明「首次为空、重试过」，不代表这一拍是空的。**
   * 全库实测：主库 146 拍里 7 次重试全部救回（最终空 0 拍），只在 A 局长跑里出现
   * 2 拍重试仍空（t5/t10）。把 fallback 当失败判据会把 7 次成功的自愈报成 7 个缺陷——
   * 这就是 D19/D20/D25 那种「分类名即结论」的错法，只不过方向相反（给合格发缺陷通知）。
   * 所以判据只看**落库正文长度 == 0**。
   *
   * 为什么它只被记为 FAIL 而不算「偶尔一抖」：空行照样 `addTurn()` 落库
   * （`orchestrator.js:311 const narrative = narrator.content || ''`），于是
   * ①进字数统计与重复率分母；②作为一条空 assistant 消息进入下一拍 recent 层
   * （实测 t6 的 recent 里有 `["assistant", 4]` tok）。下游记账因为拿到空正文而
   * 什么都不写，这一拍的玩家行动等于没发生——但玩家在界面上看得见「没输出」。 */
  const emptyTurns = asmRows
    .filter((r) => r.chars === 0)
    .map((r) => ({
      turn_no: r.turn_no,
      // 首次是否也空过（fallback 是「重试过」的痕迹，不是失败标记）
      retried: r.asm.narration?.fallback === 'empty_content',
      completion_tokens: r.meta.completion_tokens ?? null,
      // 空回合有没有作为 assistant 消息进入下一拍（tokens>0 的空内容仍占一条消息）
      fed_into_next: asmRows.some((n) => n.turn_no === r.turn_no + 1
        && (n.asm.messages || []).some((mm) => mm.owner === 'recent' && mm.role === 'assistant' && mm.tokens <= 5)),
    }));
  // 重试自愈的拍数（首次空、重试后有了正文）：正例，必须能在报告里看见，否则
  // 「empty_content 出现了 8 次」会被读成「8 拍没正文」。
  const retriedHealedTurns = asmRows
    .filter((r) => r.chars > 0 && r.asm.narration?.fallback === 'empty_content')
    .map((r) => r.turn_no);

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
    turns: {
      rows: turns.length, player: players.length, narrator: narr.length, unpaired_player_turns: unpairedPlayers,
      empty_narrator: emptyTurns.length, empty_narrator_turns: emptyTurns,
      retried_healed: retriedHealedTurns,
    },
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
  if (emptyTurns.length) {
    console.log(
      `空正文       ${emptyTurns.length} 拍：`
      + emptyTurns.map((e) => `t${e.turn_no}(ct=${num(e.completion_tokens)}${e.retried ? ',首次也空' : ''}${e.fed_into_next ? ',已进下一拍' : ''})`).join(' ')
      + '｜上游只出推理未出正文，重试一次仍空 → 静默落库 content=\'\'，并作为空 assistant 消息进入下一拍'
    );
  }
  if (retriedHealedTurns.length) {
    console.log(
      `重试自愈     ${retriedHealedTurns.length} 拍（t${retriedHealedTurns.join(',')}）首次正文为空、关推理重试后正常`
      + '｜`narration.fallback=empty_content` 是「重试过」的痕迹，不是失败标记'
    );
  }
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
  console.log(`时间推进     ${whenTurnSeq[0] || MISSING} → ${whenTurnSeq[whenTurnSeq.length - 1] || MISSING}（回合粒度变化 ${whenTurnChanges} 次）`);
  // 场次粒度的标签也要打：它是「每场开头模型看到的是什么时间」，与回合粒度不是一回事。
  console.log(`场次时间     ${whenSeq.length ? `${whenSeq.length} 场 → ${new Set(whenSeq).size} 种、${whenChanges} 次变化` : MISSING}`);
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
    const overlapTurns = Number(c.overlap_turns ?? 0);
    const overlapLimit = c.overlap_limit === undefined ? null : Number(c.overlap_limit);
    // recent_from 为 null 有两种合法情形：本轮之前没有未封场的原文（turns=0），
    // 或者根本没渲染原文层。只有「有原文但接不上」才算违约（§13.14）。
    const vacuous = recentFrom === null && recentTurns === 0;
    // 接缝判据（D1 之后）：有意的**重叠**合法，**洞**不合法。
    // 重叠 = recent_from 比 scene_to + 1 小，差值必须恰好等于 overlap_turns；
    // 洞 = recent_from 比 scene_to + 1 大。旧判据 `=== scene_to + 1` 会把
    // 「刚封场还留着上一拍」误判成违约，同时放过 overlap_turns 记账错的情况。
    const seamOk = vacuous || (
      recentFrom !== null
      && recentFrom <= sceneTo + 1
      && recentFrom + overlapTurns === sceneTo + 1
      && (overlapLimit === null || overlapTurns <= overlapLimit)
    );
    return {
      turn_no: r.turn_no,
      scene_to: sceneTo,
      recent_from: recentFrom,
      recent_to: c.recent_to ?? null,
      turns: recentTurns,
      overlap_turns: overlapTurns,
      overlap_limit: overlapLimit,
      ok: seamOk,
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

  /* 截断可见化（D3）：哪些层已经顶到 SQL 窗口。
   *
   * `degraded` 只记录「预算不够时丢了什么」；SQL 层的 `LIMIT` 是另一种静默截断——
   * 取数时行就没进进程，连 degraded 都不会出现。长跑实测：断言 300 条窗口在 48 拍左右
   * 填满，之后新断言进不了装配，而报告一直显示健康。这里把它变成显式信号。 */
  const truncRows = asmRows
    .filter((r) => r.layers_truncated)
    .map((r) => ({ turn_no: r.turn_no, ...r.layers_truncated }));
  const lastTrunc = truncRows.length ? truncRows[truncRows.length - 1] : null;
  // 第一次顶到窗口的轮次：比「最终有没有溢出」更有用——它说明余量还剩多少。
  const firstAssertionFull = truncRows.find((r) => r.assertions?.sql_window_full)?.turn_no ?? null;
  const firstRelationFull = truncRows.find((r) => r.relations?.sql_window_full)?.turn_no ?? null;

  /* 资料员预检（D4）：历史回查是否真的被触发。
   *
   * D4 之前单发模式没有任何回查通道（`recall_history` 只在分段模式注入），所以「模型记不住
   * 久远细节」是没有出口的问题。D4 把历史检索并进资料员同一次往返，触发条件是「玩家/走向
   * 点名了已登场人物」——与卡大小无关。这里要看的不是「跑没跑」，而是
   * **history_queries 非空的比例**：它恒为 0 说明通道没接上，恒为 1 说明判据太松、每拍都在查。 */
  const retRows = asmRows
    .filter((r) => r.retrieval)
    .map((r) => {
      const codexTokens = Number(r.retrieval.codex_tokens) || 0;
      const historyTokens = Number(r.retrieval.history_tokens) || 0;
      const totalTokens = Number(r.retrieval.tokens) || (codexTokens + historyTokens);
      // `rendered` 是后加的字段：加它之前，装配层只在「真出了文本」时才写 meta.retrieval，
      // 所以旧行的 rendered 是 undefined。直接 `!!undefined` 会把「出过文本」判成「没出」，
      // 于是报告出现「出文本 0 拍」却又有「token 辞书 845」的自相矛盾。
      // 旧行没有这个字段时按 token>0 回退推断——存量会话不必重跑也能读。
      const rendered = r.retrieval.rendered === undefined ? totalTokens > 0 : !!r.retrieval.rendered;
      return {
        turn_no: r.turn_no,
        rendered,
        codex: arr(r.retrieval.codex_queries),
        history: arr(r.retrieval.history_queries),
        hits: arr(r.retrieval.history_hits),
        // D4 后验：查询词本身是玩家这一拍写的字 = 自问自答。
        // 没有 exclude_from 下界时 20 条里 15 条是这样，检索回来的必然是眼前已有的东西。
        // `history_self_echo` 是后加的字段：旧会话行里根本没有这个键，
        // 直接 arr(undefined) 会得到 []，于是报告显示「0% 自问自答」——把最脏的一条洗成最干净的。
        self_echo: Array.isArray(r.retrieval.history_self_echo) ? r.retrieval.history_self_echo : null,
        exclude_from: r.retrieval.exclude_from ?? null,
        // D21：命中的回合里，有多少条本来就躺在当拍的可见窗口内。
        // 「自问自答」测的是**查询词**像不像玩家原话，但 D4 加上 exclude_from 下界之后，
        // 这一点已经无害了——下界保证搜回来的都在窗口之外。真正要看的是**命中结果**有没有
        // 落在模型已经逐字看得见的那几拍上：那才是「白查一趟」。
        // 判据（`_work/tmp-d21q2.mjs` 三局实测 29 条命中、7 条落在窗口内）：
        // 旧局 d7a6f899 下界未接时 7/24 落在窗口内（29%），接了下界的两局 0/5。
        hits_in_visible: (() => {
          const rf = Number(r.coverage?.recent_from);
          const hs = arr(r.retrieval.history_hits);
          if (!hs.length) return null;
          if (!Number.isFinite(rf) || rf <= 0) return null;
          return hs.filter((h) => Number(h.turn_no) >= rf).length;
        })(),
        hits_total: arr(r.retrieval.history_hits).length,
        codex_tokens: codexTokens,
        history_tokens: historyTokens,
        tokens: totalTokens,
      };
    });
  const retWithHistory = retRows.filter((r) => r.history.length > 0);
  const retWithHits = retRows.filter((r) => r.hits.length > 0);
  const retRendered = retRows.filter((r) => r.rendered);
  // 自问自答只在「有 history_self_echo 字段的轮次」上统计：旧会话行没有这个键，
  // 混进来会把分母撑大、把比例冲淡成看起来健康的数字。
  const retEchoKnown = retRows.filter((r) => Array.isArray(r.self_echo));
  const retSelfEchoTurns = retEchoKnown.filter((r) => r.self_echo.length > 0);
  const retHistoryQueryTotal = retEchoKnown.reduce((a, r) => a + r.history.length, 0);
  const retSelfEchoTotal = retEchoKnown.reduce((a, r) => a + r.self_echo.length, 0);
  // 全部历史查询条数（含旧会话）：只用来判断「有查询但量不了自问自答」时该报 MISSING。
  const retHistoryQueryTotalAll = retRows.reduce((a, r) => a + r.history.length, 0);
  // D21：命中结果落地率。分母是「有命中的轮次里的命中条数」，不是查询条数——
  // 一条查询可能命中多条原文，每一条都是要占 retrieval 子层的 token。
  const retHitKnown = retRows.filter((r) => r.hits_in_visible !== null && r.hits_total > 0);
  const retHitsTotal = retHitKnown.reduce((a, r) => a + r.hits_total, 0);
  const retHitsInVisible = retHitKnown.reduce((a, r) => a + r.hits_in_visible, 0);
  const retUselessTurns = retHitKnown.filter((r) => r.hits_in_visible > 0);
  // 资料员「被调用」= 有 retrieval meta（跑过就记，不只在出文本时记）。
  // 触发率的分母是「有装配记录的全部轮次」，不是「有 retrieval 的轮次」——
  // 否则一旦 D4 的触发条件收紧，报告会把「没调用」也算成 100% 触发。
  const retTriggerDenom = asmRows.length || null;

  report.retrieval = {
    rows: retRows,
    triggered: retRows.length,
    trigger_rate: retTriggerDenom ? retRows.length / retTriggerDenom : null,
    rendered: retRendered.length,
    rendered_rate: retRows.length ? retRendered.length / retRows.length : null,
    history_queries_turns: retWithHistory.length,
    history_query_rate: retRows.length ? retWithHistory.length / retRows.length : null,
    history_hit_turns: retWithHits.length,
    history_hit_rate: retRows.length ? retWithHits.length / retRows.length : null,
    // D4 后验：自问自答率 = 查询词是玩家这一拍原话的比例。有了 exclude_from 之后应该趋近 0。
    self_echo_known_turns: retEchoKnown.length,
    history_queries_total: retHistoryQueryTotal,
    history_queries_total_all: retHistoryQueryTotalAll,
    self_echo_queries: retSelfEchoTotal,
    self_echo_turns: retSelfEchoTurns.length,
    self_echo_rate: retHistoryQueryTotal ? retSelfEchoTotal / retHistoryQueryTotal : null,
    exclude_from_present: retRows.some((r) => r.exclude_from != null),
    // D21：命中结果有多少落在当拍已可见的窗口内 = 白查。D4 之后这是「通道有没有用」的真判据；
    // 自问自答只说明「查询词像玩家原话」，下界已经让这一点无害了。
    hits_known_turns: retHitKnown.length,
    hits_total: retHitsTotal,
    hits_in_visible: retHitsInVisible,
    hits_in_visible_rate: retHitsTotal ? retHitsInVisible / retHitsTotal : null,
    useless_query_turns: retUselessTurns.map((r) => r.turn_no),
    tokens: {
      codex_total: retRows.reduce((a, r) => a + r.codex_tokens, 0),
      history_total: retRows.reduce((a, r) => a + r.history_tokens, 0),
    },
    note: 'triggered = 资料员被调用（meta.retrieval 存在）；rendered = 真出了【检索结果】文本；'
      + 'trigger_rate 的分母是全部有装配记录的轮次；self_echo_rate 是「查询词就是玩家原话」的比例（D4 后验，应趋近 0）',
  };

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
    // 截断可见化（D3）：SQL LIMIT 挡掉的行数。degraded 只记「预算不够丢了什么」，
    // 这一类是「取数时就没取回来」，之前完全不可观测。
    sql_truncation: {
      last: lastTrunc,
      first_assertion_full_turn: firstAssertionFull,
      first_relation_full_turn: firstRelationFull,
      rows: truncRows,
      // 第二道丢弃（比 SQL 窗口早得多）：`selectFacts` 只渲染单值谓词的全部 + 多值谓词的前
      // `manyLimit`(10) 条。所以「断言能有多少条进提示词」实际由它决定，不是由 300 决定。
      facts: {
        last: asmRows.length ? asmRows[asmRows.length - 1].facts : null,
        first_dropped_turn: asmRows.find((r) => r.facts.many_dropped > 0)?.turn_no ?? null,
        max_dropped: asmRows.reduce((m, r) => Math.max(m, r.facts.many_dropped), 0),
      },
      // 关系的第二道丢弃（D17）：同上，`LIMIT 60` 只是加载量，真上限由预算推导。
      relations: {
        last: asmRows.length ? asmRows[asmRows.length - 1].relations : null,
        first_limit_turn: asmRows.find((r) => r.relations.limit != null)?.turn_no ?? null,
        max_rendered: asmRows.reduce((m, r) => Math.max(m, Number(r.relations.rendered) || 0), 0),
      },
      note: 'sql_window_full = 该层已顶到 SQL LIMIT，再长也不会被渲染；'
        + 'total 是库里真实行数，loaded 是进入进程的行数。'
        + 'facts.many_dropped 是窗口内第二道丢弃（多值谓词超出 manyLimit），它比 SQL 窗口先到；'
        + 'relations.rendered/limit 同理（D17 之前这里写死 8）。',
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
  // ── 这一段的硬约束（踩过五次，2026-10-29） ────────────────────────────────
  // 第 2 段的所有行都必须在 `report.memory` 赋值**之前**跑完，所以任何一行都
  // 不许读 `report.memory.*`：那时它还是 undefined，分支会走进 else
  // 打印「旧会话没有 X 字段，需重跑才能量」——把「有数据」印成「没测到」。
  // branch_sheet / codex / lint / fates / voices 五处都这样错过一轮。
  // 要报的东西一律从 `asmRows` / 已算好的局部变量现算（与 relations 行一致）；
  // 确实要复用的聚合值，就在这一段之前算好、赋到局部常量上。
  // ─────────────────────────────────────────────────────────────────────────
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
    const ovl = covChecked.filter((c) => c.overlap_turns > 0).length;
    const ovlTurns = covChecked.reduce((a, c) => a + c.overlap_turns, 0);
    console.log(`coverage     scene_to+1 === recent_from + overlap_turns（重叠合法、洞非法）：` +
      `${covViolations.length ? '违约轮 t' + turnRanges(covViolations) : '全部满足'}` +
      `（${pct(covChecked.length - covViolations.length, covChecked.length)}）` +
      `｜封场尾巴 ${ovl}/${covChecked.length} 拍、共 ${ovlTurns} 拍重叠`);
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
  // 叙事点名率：卡内实体名有没有真的出现在正文里。
  // 必须和 `meta.recall` 分开看——世界索引把全部实体名塞进 system，recall 恒 ≈100%，
  // 它衡量「索引完整」，不衡量「叙事用到了卡」。把两者混为一谈会让「卡很大但一句没用到」
  // 看起来像满分。口径只读 card_snapshot + 正文，不看运行期投影（那是「谁在场」，另一件事）。
  {
    const snap = safeJson(session.card_snapshot_json) || {};
    const ents = Array.isArray(snap.entities) ? snap.entities : [];
    if (ents.length && asmRows.length) {
      const body = asmRows.map((r) => r.content).join('\n');
      const formsOf = (e) => [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])]
        .filter((f) => typeof f === 'string' && f.length > 1);
      const hitOf = (e) => formsOf(e).some((f) => body.includes(f));
      const byType = {};
      const neverNamed = [];
      for (const e of ents) {
        const t = e.type || '(none)';
        byType[t] = byType[t] || { hit: 0, total: 0 };
        byType[t].total += 1;
        if (hitOf(e)) byType[t].hit += 1;
        else if (e.type === 'person') neverNamed.push(e.name);
      }
      const hit = Object.values(byType).reduce((a, v) => a + v.hit, 0);
      // 人物按卡自带 weight 分档：high = 作者标的主线级（≥0.8）。分档不是新字段，
      // 只是给已有 weight 一个可读口径——「主线人物被点名率」比「全体 25%」有意义得多。
      const tiers = { high: { hit: 0, total: 0 }, mid: { hit: 0, total: 0 }, low: { hit: 0, total: 0 } };
      for (const e of ents.filter((x) => x.type === 'person')) {
        const t = Number(e.weight) >= 0.8 ? 'high' : Number(e.weight) >= 0.5 ? 'mid' : 'low';
        tiers[t].total += 1;
        if (hitOf(e)) tiers[t].hit += 1;
      }
      report.mention = {
        total: ents.length,
        hit,
        rate: hit / ents.length,
        by_type: byType,
        persons_never_named: neverNamed,
        tiers,
        note: '正文点名率（叙事有没有用到卡）；与之区分：meta.recall 是索引饱和度（恒 ≈100%），'
          + '不衡量叙事。high = 人物 weight≥0.8。',
      };
      console.log(
        `叙事点名     ${hit}/${ents.length}（${pct(hit, ents.length)}）｜`
        + Object.entries(byType).map(([k, v]) => `${k} ${v.hit}/${v.total}`).join(' · ')
      );
      const tierText = Object.entries(tiers).map(([k, v]) => `${k} ${v.hit}/${v.total}`).join('｜');
      console.log(
        `  人物分档   ${tierText}（high=weight≥0.8）`
        + (neverNamed.length ? `｜未登场 ${neverNamed.length} 人：${neverNamed.slice(0, 12).join('、')}${neverNamed.length > 12 ? ' …' : ''}` : '')
        + '｜`meta.recall` 恒 100% 是索引饱和度，不是叙事覆盖'
      );
    } else {
      console.log(`叙事点名     ${MISSING}（没有 card_snapshot.entities 或没有正文）`);
    }
  }
  console.log(`degraded     ${asmRows.length === 0 ? MISSING : degradedTurns.length ? degradedTurns.map((d) => `t${d.turn_no}:${d.degraded.join('+')}`).join(' ') : '无'}`);
  console.log(`hard_cap     ${asmRows.length === 0 ? MISSING : hardCapTurns.length ? hardCapTurns.map((d) => `t${d.turn_no}:${d.mode}${d.narrowed.length ? '/' + d.narrowed.join('+') : ''}`).join(' ') : '全部 mode=fail 且 narrowed 为空'}`);
  // SQL 层截断：degraded 看不见的那一类静默丢失。窗口满 = 再长也不会进提示词。
  if (!lastTrunc) {
    console.log(`sql_trunc    ${MISSING}（meta 里没有 layers_truncated，旧数据）`);
  } else {
    const flag = (x) => (x ? '已满' : '有余量');
    const th = lastTrunc.threads || {};
    // 线索跟另外两道不是一个口径：SQL 读 40 条，但**渲染只有 THREAD_RENDER_MAX 条**，
    // open 到 8 就已经「满」了、第 9 条起根本不渲染。只打 N/40 会把「已满」显示成「很空」。
    const threadState = (() => {
      if (!th.render_max) return `开放线索 ${num(th.open_total)}/${num(th.window)}`;
      const used = Number(th.open_total) || 0;
      const cap = Number(th.render_max) || 0;
      const tail = th.open_over_capacity > 0
        ? `超出 ${th.open_over_capacity} 条（写了也不渲染）`
        : (used >= cap ? '**已满**（新线索会被 WIP 拒绝）' : `剩 ${cap - used} 个额度`);
      return `线索 open ${num(used)}/${num(cap)}（渲染容量，${tail}）`;
    })();
    const threadLine = `｜${threadState}`;
    console.log(
      `sql_trunc    断言 ${num(lastTrunc.assertions?.loaded)}/${num(lastTrunc.assertions?.window)}（库内 ${num(lastTrunc.assertions?.total)}，${flag(lastTrunc.assertions?.sql_window_full)}）`
      + `｜关系 ${num(lastTrunc.relations?.loaded)}/${num(lastTrunc.relations?.window)}（库内 ${num(lastTrunc.relations?.total)}，`
      + `渲染上限 ${num(lastTrunc.relations?.render_limit)}，${flag(lastTrunc.relations?.sql_window_full)}）`
      + threadLine
    );
    if (firstAssertionFull != null) console.log(`  断言窗口首次填满 t${firstAssertionFull}（之后新断言不再进入装配）`);
    if (firstRelationFull != null) console.log(`  关系窗口首次填满 t${firstRelationFull}`);
    // 关系也有第二道丢弃（D17）：`LIMIT 60` 只是加载量，渲染上限由预算推导。
    // 只报 SQL 窗口会让「8 条已经填满、42 条过场关系里只有 11 条露过面」显示成「8/60 还很空」。
    {
      const rs = asmRows.length ? asmRows[asmRows.length - 1].relations : null;
      if (rs && rs.limit != null) {
        console.log(
          `relations   渲染 ${num(rs.rendered)}/${num(rs.limit)} 条上限`
          + `（装载 ${num(rs.loaded)}，库内 ${num(rs.total)}；两端在场 ${num(rs.both_present)} 条）`
        );
      }
    }
    // 走向版场记单（D26-B）：branch 的输入比送模那份少了哪一段、每次省多少 token。
    // 这条以前根本没打印，于是「branch 每拍重传一整张 8000 tok 的场记单」
    // 在报告里完全是空白。回声（D18）已删，不再有回声行。
    {
      // 现算而不是读 `report.memory`：memory 段在文件后面才赋值，这一段先执行，
      // 读 report.memory 会永远得到 undefined → 把「有数据」误印成「旧会话没有」。
      // 判据与 `report.memory.branch_sheet` 同一份（同 known 过滤、同算法）。
      const known = asmRows.filter((r) => r.branch_sheet?.known);
      if (known.length) {
        const saved = known.reduce((s, r) => s + ((r.branch_sheet.full_tokens || 0) - (r.branch_sheet.tokens || 0)), 0);
        const fullSum = known.reduce((s, r) => s + (r.branch_sheet.full_tokens || 0), 0);
        const dropped = new Set();
        for (const r of known) for (const k of (r.branch_sheet.dropped || [])) dropped.add(k);
        const trims = [...new Set(known.map((r) => r.branch_sheet.trim || 'default'))];
        const last = known[known.length - 1].branch_sheet;
        console.log(
          `branch_sheet 去掉 ${[...dropped].join('/') || '(无)'} 后每次省 ${num(Math.round(saved / known.length))} tok`
          + `（${pctv(fullSum > 0 ? saved / fullSum : null)}）｜累计省 ${num(saved)} tok｜样本 ${known.length} 拍`
          + `｜档位 ${trims.join('/')}`
          + `｜末拍 ${num(last.tokens)}/${num(last.full_tokens)} tok`
        );
      } else if (asmRows.length) {
        console.log(`branch_sheet ${MISSING}（旧会话没有 scene_sheet.branch_sheet，需重跑才能量）`);
      }
    }
    // 辞书两道出口（D24）：全文基本全渲染，简报只取 `floor(sceneCap*0.2/40)` 条。
    // 51 拍实测简报丢 46%，而这三个数此前一个都没落库——报告里显示为完全健康。
    {
      // 现算：`report.memory` 在文件后面才赋值，这一段先执行（见 branch_sheet 处同一注释）。
      const known = asmRows.filter((r) => r.codex.candidates != null);
      if (known.length) {
        const sum = (k) => known.reduce((s, r) => s + (r.codex[k] || 0), 0);
        const cand = sum('candidates'), rend = sum('rendered');
        const bc = sum('brief_candidates'), br = sum('brief_rendered');
        console.log(
          `codex       全文 ${num(rend)}/${num(cand)} 条渲染`
          + `｜简报 ${num(br)}/${num(bc)}（丢 ${num(Math.max(0, bc - br))}，${pct(Math.max(0, bc - br), bc)}）`
          + `｜样本 ${known.length} 拍`
        );
      } else if (asmRows.length) {
        console.log(`codex       ${MISSING}（旧会话没有 codex_* 字段，需重跑才能量）`);
      }
    }
    // 渲染前体检（D24）：lint-state 每拍剔谁。D10/D14 那类缺陷正是靠它才看得见。
    {
      const fixRows = asmRows.filter((r) => Array.isArray(r.state_fixes));
      const warnRows = asmRows.filter((r) => Array.isArray(r.state_warnings));
      if (fixRows.length) {
        const all = fixRows.flatMap((r) => r.state_fixes.map((f) => ({ turn_no: r.turn_no, ...f })));
        const byKind = {};
        for (const x of all) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
        const kinds = Object.entries(byKind).map(([k, v]) => `${k}×${v}`).join('、') || '无';
        const whens = all.map((x) => `t${x.turn_no}:${x.who}`).slice(0, 8).join(',');
        const nWarn = warnRows.reduce((s, r) => s + r.state_warnings.length, 0);
        console.log(`lint        干预 ${all.length} 次（${kinds}）${whens ? `｜${whens}` : ''}｜告警 ${num(nWarn)} 条｜样本 ${fixRows.length} 拍`);
      } else if (asmRows.length) {
        console.log(`lint        ${MISSING}（旧会话没有 state_fixes，需重跑才能量）`);
      }
    }
    // 成长曲线（D24）：一次都没解锁过也要能看见。
    {
      const known = asmRows.filter((r) => r.fates != null);
      const last = known.at(-1);
      if (known.length) {
        const everUnlocked = known.some((r) => (r.fates.unlocked || 0) > 0);
        console.log(`fates       曲线 ${num(last.fates.total)} 条｜解锁 ${num(last.fates.unlocked)}｜预兆 ${num(last.fates.omens)}｜${everUnlocked ? '本局解锁过' : '本局一次都没解锁'}`);
      } else if (asmRows.length) {
        console.log(`fates       ${MISSING}（旧会话没有 fates 字段，需重跑才能量）`);
      }
    }
    // 原声可见性（D23）：报「在场里有几个人真有声线锚点」。
    // 以前这一层连计数都没有，于是「久没开口的角色声线永久消失」在报告里是空白。
    {
      const known = asmRows.filter((r) => r.voices.present_covered != null);
      if (known.length) {
        const cov = known.reduce((s, r) => s + (r.voices.present_covered || 0), 0);
        const sp = known.reduce((s, r) => s + (r.voices.speakers || 0), 0);
        const last = known.at(-1).voices;
        console.log(
          `voices      声线锚点 平均 ${(cov / known.length).toFixed(1)} 人/拍`
          + `（说话者累计 ${num(sp)} 人/拍）｜末拍 ${num(last.present_covered)}/${num(last.speakers)}｜样本 ${known.length} 拍`
        );
      } else if (asmRows.length) {
        console.log(`voices      ${MISSING}（旧会话没有 scene_sheet.voice_present_covered，需重跑才能量）`);
      }
    }
    // 断言在窗口内还有第二道丢弃：selectFacts 只把单值谓词全渲染 + 多值谓词前 manyLimit 条
    // 送进提示词。只报 SQL 窗口会让人以为「123 条都给了模型」，实际这一步就砍到 24 条。
    {
      const fs = asmRows.length ? asmRows[asmRows.length - 1].facts : null;
      if (fs && fs.candidates) {
        const detail = fs.split
          ? `（单值 ${num(fs.single)} 全渲染 + 多值 ${num(fs.many_rendered)}/${num(fs.single) + num(fs.many_rendered) + num(fs.many_dropped)}）`
            + `｜多值丢弃 ${num(fs.many_dropped)} 条`
          : '（存量会话只有合计口径：细分项是后加的）';
        console.log(`facts       渲染 ${num(fs.rendered)}/${num(fs.candidates)} 条候选${detail}`);
      }
    }
  }
  // 资料员两条通道（D4）：关键看 history 通道有没有真的被用起来。
  if (!report.retrieval.triggered) {
    console.log(`retrieval    ${MISSING}（资料员一次都没触发，或旧数据没有 meta.retrieval）`);
  } else {
    const r = report.retrieval;
    console.log(
      `retrieval    触发 ${r.triggered} 拍`
      + `｜出文本 ${r.rendered} 拍`
      + `｜其中查历史 ${r.history_queries_turns} 拍（${pct(r.history_queries_turns, r.triggered)}）`
      + `｜查到历史 ${r.history_hit_turns} 拍（${pct(r.history_hit_turns, r.triggered)}）`
      + `｜token 辞书 ${num(r.tokens.codex_total)} / 历史 ${num(r.tokens.history_total)}`
    );
    if (r.history_queries_turns === 0) {
      console.log('  历史通道一次都没触发：要么玩家没点名过已登场人物，要么 D4 的触发条件没接上');
    }
    // D21：白查率 = 命中的原文里有多少条本来就躺在当拍的可见窗口内。
    // D4 之前这里看的是「自问自答」（查询词像玩家原话），但加了 exclude_from 下界之后，
    // 查询词像不像原话已经无害了——下界保证搜回来的都在窗口之外。真判据是命中结果。
    if (r.hits_known_turns > 0) {
      console.log(
        `  命中落地     ${r.hits_in_visible}/${r.hits_total} 条命中落在可见窗口内（${pct(r.hits_in_visible, r.hits_total)}）`
        + `｜有白查的拍 t${r.useless_query_turns.join(',') || '无'}`
        + (r.hits_in_visible_rate !== null && r.hits_in_visible_rate > 0.3 ? '  ← 白查过半：查回来的都是眼前已有的' : ''),
      );
    }
    // 自问自答只作为「模型怎么理解 history」的参考值，不再参与判定。
    if (r.self_echo_known_turns > 0) {
      const ex = r.exclude_from_present ? '下界已接' : `下界${MISSING}（旧数据或没传 exclude_from）`;
      console.log(
        `  自问自答     ${r.self_echo_queries}/${r.history_queries_total} 条查询用玩家原话（${pct(r.self_echo_queries, r.history_queries_total)}）`
        + `｜${ex}｜参考值，不判定：下界已保证搜回来的在窗口之外`,
      );
    } else if (r.history_queries_total_all > 0) {
      console.log(`  自问自答     ${MISSING}（旧会话没有 history_self_echo 字段，需重跑才能量）`);
    }
  }

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

  /* 真断点再分性质。原来的分法是「消息数变多 = 层首次插入 / 否则 = 同消息改写」，
   * 但那个命名是错的，会把人引到错误的结论上：
   *
   *   · 消息数变多**不等于**「某层首次出现」。`recent` 层每拍都在中间追加两条
   *     （player + narrator），后面的细节/场记单被整体右移 —— drift 逐条对位比，
   *     于是报 broken 在「原来那条细节消息」的位置上。前缀其实只断在 recent 内部，
   *     尾部全部原样右移，一次结构性事件，每拍都发生。
   *   · 消息数不变**也**不等于「同一条消息被改写」。封场后 `recent` 整层被清空重填，
   *     消息数恰好打平；此时对位比较会把「上轮第 3 条 recent」与「本轮第 3 条 recent」
   *     判成同一条被改。
   *
   * 判据改成用**本轮消息序列里是否还能找到上轮那条消息**（owner + tokens 指纹）：
   *   shift   上轮该消息在本轮 j>i 处原样出现 → 整段右移，前缀其实连着
   *   layer   上轮某个 owner 在本轮整体消失（检索层当拍蒸发）→ 结构性
   *   first   找不到原消息、也没有层消失 → 真正的「层首次插入」（t2 的 archive 等）
   *   slide   对位相等条数、且 recent 起点 +1 而 scene_to 未变 → D16 的窗口滑动
   *   rewrite 以上都不是 → 唯一真正要担心的一类
   *
   * 这条口径直接决定 cache_prefix_reuse 判 FAIL 还是 PASS，判错等于给错误发合格证。
   */
  const ownersOf = (r) => [...new Set((r.asm?.messages || []).map((m) => m.owner))];
  const asmPrevOf = (r) => asmRows[asmRows.indexOf(r) - 1] || null;
  const prevMsgsOf = (r) => (asmPrevOf(r)?.asm?.messages || []);
  const classifyBreak = (r) => {
    const i = r.drift.index;
    if (i === null || i === undefined) return 'layer';
    const prev = prevMsgsOf(r);
    const cur = r.asm?.messages || [];
    /* ⓿ 基线本身就是错的：drift 的基线是「上一拍真正送模的 messages」（orchestrator 的
     * lastMessages），它**每拍都写**，包括装配成功但旁白失败的那一拍（孤儿拍）；
     * 而装配清单只存在于有 narrator 行的拍。于是孤儿拍的下一拍，drift 拿的是孤儿拍的
     * 消息、报告拿的是孤儿拍之前那拍的消息 —— 对位比较必然错位，产出的是假 rewrite。
     * 实测：B 局 t14 孤儿 → t15 报「同消息改写」；A 局 t16/t18 孤儿 → t17/t19 同样。
     * 判据用 drift 自带的 prev_count 与报告基线的 messages 长度比，不等就是 gap：
     * 这是「少了一拍」，不是「同一条消息被改写」，两者代价完全不同（前者一次性，
     * 后者每拍重复烧前缀）。不修这里就会把孤儿回合算成缓存缺陷，给错的东西判 FAIL。
     */
    const driftPrevCount = Number(r.drift.prev_count);
    if (prev.length && Number.isFinite(driftPrevCount) && driftPrevCount !== prev.length) return 'gap';
    const prevMsg = prev[Number(i)];
    // ① 上轮那条消息在本轮更靠后的位置原样出现 → 整段右移
    if (prevMsg) {
      for (let j = Number(i) + 1; j < cur.length; j++) {
        if (cur[j].owner === prevMsg.owner && cur[j].tokens === prevMsg.tokens) return 'shift';
      }
    }
    // ② 上轮某个 owner 在本轮整体消失
    const curOwners = new Set(ownersOf(r));
    const gone = ownersOf(asmPrevOf(r) || {}).filter((o) => !curOwners.has(o));
    if (gone.length) return 'layer';
    // ③ 消息数变多但没有位移也没有层消失 → 真的首次插入
    if (Number(r.drift.next_count) > Number(r.drift.prev_count)) return 'first';
    // ④ 对位段里 recent 起点前移一格（D16 的窗口滑动）
    const pc = asmPrevOf(r)?.asm?.coverage || {};
    const cc = r.asm?.coverage || {};
    if (cc.scene_to === pc.scene_to && Number(cc.recent_from) === Number(pc.recent_from) + 1) return 'slide';
    return 'rewrite';
  };
  for (const r of realBreaks) r.breakKind = classifyBreak(r);
  const gapBreaks = realBreaks.filter((r) => r.breakKind === 'gap');
  const shiftBreaks = realBreaks.filter((r) => r.breakKind === 'shift');
  const layerBreaks = realBreaks.filter((r) => r.breakKind === 'layer');
  const firstInsertBreaks = realBreaks.filter((r) => r.breakKind === 'first');
  const slideBreaks = realBreaks.filter((r) => r.breakKind === 'slide');
  const rewriteBreaks = realBreaks.filter((r) => r.breakKind === 'rewrite');
  // 兼容旧字段名：insert 类 = 右移 + 首次插入（都不是「同一条消息被改写」）。
  const insertBreaks = [...shiftBreaks, ...firstInsertBreaks];

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
  // 回退再分两类：
  //   · 可解释：断点性质是 shift / layer / first（结构事件），
  //     或本轮消息数变少（封场清 recent）。这些都会让前缀掉一次，但下次就接上。
  //   · 无法解释（unexplained）：`rewrite`（同一条消息被改写）或
  //     `slide`（recent 起点每拍 +1 = D16 的窗口滑动，前缀每拍作废）。
  //     这两类才是真问题——它们会**反复**烧前缀，而不是一次性。
  const asmByTurn = new Map(asmRows.map((r) => [r.turn_no, r]));
  // gap 也算结构性：它是一拍没有落库造成的位移，原因在孤儿回合（另有判据），
  // 不是「同一条消息每拍被改写」那种持续烧前缀。放到这里只让它不被重复判罚。
  const EXPLAINED_KINDS = new Set(['shift', 'layer', 'first', 'gap']);
  const isStructural = (x) => {
    const r = asmByTurn.get(x.to);
    if (Number(r?.drift?.next_count) < Number(r?.drift?.prev_count)) return true;
    return EXPLAINED_KINDS.has(r?.breakKind);
  };
  const unexplainedRegressions = prefixRegressions.filter((x) => !isStructural(x));
  const structuralRegressions = prefixRegressions.filter(isStructural);
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
      // 真断点按「本轮还能不能找到上轮那条消息」分五类（见上面 classifyBreak）：
      //   shift   上轮消息整体右移（recent 中间追加所致）→ 前缀其实连着
      //   layer   某层整体消失（封场清 recent / 检索当拍蒸发）→ 结构性，只发生一次
      //   first   真的层首次插入（t2 的 archive/recent 进场）→ 一次性
      //   slide   recent 起点前移（D16 窗口滑动）→ 真缺陷，已修但要留痕
      //   rewrite 找不到任何结构性解释 → 唯一真正要担心的一类
      real_break_shift: shiftBreaks.length,
      real_break_layer: layerBreaks.length,
      real_break_first: firstInsertBreaks.length,
      real_break_slide: slideBreaks.length,
      real_break_gap: gapBreaks.length,
      gap_turns: gapBreaks.map((r) => r.turn_no),
      real_break_insert: insertBreaks.length,
      real_break_rewrite: rewriteBreaks.length,
      rewrite_turns: rewriteBreaks.map((r) => r.turn_no),
      slide_turns: slideBreaks.map((r) => r.turn_no),
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
      `（右移 ${shiftBreaks.length} · 层消失 ${layerBreaks.length} · 首次插入 ${firstInsertBreaks.length}` +
      ` · 窗口滑动 ${slideBreaks.length} · 少一拍 ${gapBreaks.length} · **真改写 ${rewriteBreaks.length}**）· 消息减少 ${droppedBreaks.length}`);
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
  /* 上游真实缓存命中（2026-10-28 补，D27 的依据）：
   * `prefix_shared_rate` 是**本地按消息文本估算的上限**，不是上游真的命中率。
   * 实测三局：本地估 50.8/52.1/53.2%，上游真命中 47.7/19.5/6.7%——
   * 差值全部来自上游返回的 cached_tokens 时有时无（同一份 prompt 连发 12 次，
   * 11 次 94.6%、1 次 0%）。所以这一行只用来判断「上游到底吃到了多少」，
   * 判断「我们的前缀有没有断」仍然看上面的断点性质。
   */
  const realCacheRows = narr
    .map((r) => {
      const u = safeJson(r.usage_json) || {};
      const p = Number(u.prompt_tokens) || 0;
      const c = Number(u.cached_tokens) || 0;
      return p > 0 ? { turn_no: Number(r.turn_no), prompt: p, cached: c, rate: c / p } : null;
    })
    .filter(Boolean);
  const realCacheHit = realCacheRows.filter((r) => r.rate > 0.5).length;
  const realCacheZero = realCacheRows.filter((r) => r.cached === 0).length;
  const realCacheRate = realCacheRows.length
    ? realCacheRows.reduce((a, r) => a + r.rate, 0) / realCacheRows.length
    : null;
  const sessionRealRate = (() => {
    const p = Number(sessionUsage?.prompt_tokens) || 0;
    const c = Number(sessionUsage?.cached_tokens) || 0;
    return p > 0 ? c / p : null;
  })();
  report.cache.upstream = {
    sessions_prompt_tokens: Number(sessionUsage?.prompt_tokens) || 0,
    sessions_cached_tokens: Number(sessionUsage?.cached_tokens) || 0,
    session_rate: sessionRealRate,
    narrator_turns: realCacheRows.length,
    narrator_hit_turns: realCacheHit,
    narrator_zero_turns: realCacheZero,
    narrator_mean_rate: realCacheRate,
    local_estimate_mean: rateStats ? rateStats.mean : null,
  };
  if (realCacheRows.length) {
    console.log(
      `上游真命中   narrator ${realCacheHit}/${realCacheRows.length} 拍命中过半（${realCacheZero} 拍 0 tok）｜均值 ${pctv(realCacheRate)}｜全会话 ${pctv(sessionRealRate)}｜本地估算上限 ${pctv(rateStats ? rateStats.mean : null)}`
    );
    console.log(
      `             ${realCacheZero > realCacheRows.length * 0.3 ? '⚠ 超过三成回合 0 命中：不是前缀断了（断点性质那行可证），是上游缓存按节点/分片、命中是路由抽签——同一份 prompt 连发 12 次实测 11 次 94.6%、1 次 0%' : '上游缓存基本吃满，本地估算与真实接近'}`
    );
  } else {
    console.log('上游真命中   (缺失)（turns 里没有 usage_json.cached_tokens）');
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

  // 死亡/离场口径：正文出现这些词就该有 life_state 写入。
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
  // D32：`life_state` 有两条写入入口——`states` 数组（写 character_states）与
  // `changes` 数组（只写 world_state）。判据只读 character_states 时，经 changes 写出的
  // gone 在报告里**根本不存在**：实测凌玥 t18 就是这样被标 gone 的，这一整条判据一条都没抓到，
  // 而 lint-state 读的是投影（world_state），据此把她剔出 present 整整 19 拍。
  // 所以取两边的并集；`only_in:'world_state'` 的行本身就是「两套存储分裂」的证据。
  const lifeRowsCs = all(
    'select who, value, valid_from, valid_to from character_states where session_id = :sid' +
      " and field = 'life_state' and value in ('dead','gone') order by valid_from",
    { sid: sessionId }
  ) || [];
  const lifeRowsWs = all(
    `select entity_id as who, value_json as value, valid_from, valid_to from world_state
      where session_id = :sid and path = 'life_state' and op = 'set'
        and value_json in ('"dead"', '"gone"') order by valid_from`,
    { sid: sessionId }
  ) || [];
  const lifeKey = (r) => `${r.who}::${r.value}::${Number(r.valid_from)}`;
  const lifeSeenCs = new Set(lifeRowsCs.map(lifeKey));
  const lifeRows = [
    ...lifeRowsCs,
    ...lifeRowsWs
      .map((r) => ({
        who: r.who,
        value: String(r.value ?? '').replace(/^"|"$/g, ''),
        valid_from: r.valid_from,
        valid_to: r.valid_to,
      }))
      .filter((r) => !lifeSeenCs.has(lifeKey(r))),
  ];
  const lifeOnlyWorldState = lifeRowsWs
    .map((r) => ({ who: r.who, value: String(r.value ?? '').replace(/^"|"$/g, ''), valid_from: r.valid_from }))
    .filter((r) => !lifeSeenCs.has(lifeKey(r)));
  const presentByTurn = new Map();
  for (const r of asmRows) {
    const p = r.meta?.assembly?.present;
    if (Array.isArray(p)) presentByTurn.set(Number(r.turn_no), p.map((x) => (typeof x === 'string' ? x : x?.name || x?.id)));
  }
  // D14：主角被判「离场」后会被 lint-state 从 present 剔掉，场记单末尾改印「已故／离场：主角」。
  // 报告此前完全看不到这件事（absentees 从没被读过），于是「主角消失」在报告里是健康的。
  // 判据取 card_snapshot 里的玩家名，与 lintState 收到的 playerName/playerId 同源。
  const snapshot = safeJson(session.card_snapshot_json) || {};
  const playerNames = [...new Set(
    [snapshot?.player?.name, snapshot?.player?.canon_character].map((x) => String(x ?? '').trim()).filter(Boolean)
  )];
  const absenteesRows = asmRows
    .map((r) => ({
      turn_no: r.turn_no,
      absent: (Array.isArray(r.asm.scene_sheet?.absentees) ? r.asm.scene_sheet.absentees : [])
        .map((x) => String(x?.name ?? x?.who ?? x ?? '').trim())
        .filter(Boolean),
    }))
    .filter((x) => x.absent.length > 0);
  const playerAbsentRows = playerNames.length
    ? absenteesRows.filter((x) => x.absent.some((n) => playerNames.includes(n)))
    : [];
  const absenteesKnown = asmRows.some((r) => r.asm.scene_sheet != null);

  const stillDeadAt = (lr, tn) => lr.valid_to == null || Number(lr.valid_to) > tn;
  // D22：`present` 名单之外的第二个确定性信号——史官在那一拍给这个人写了**在场类**状态。
  // 史官只给真正在场的人写 location/condition/mood/goal/status（`setCharState` 的入参来自
  // states 数组，而 states 直接来自旁白正文里谁在动）。所以「正文出现名字 + 史官写了在场态 +
  // present 里没有他」三个信号同时成立时，缺的不是正文、是机制的在场判定。
  //
  // 为什么需要这个：只看「名字出现在正文」会把「甲提到乙」也算成乙上场。
  // 实测三局 16 条泄漏里 9 条是纯名字提及（对白/心里想）、7 条史官同时写了在场态。
  // 旧口径把两类都判 WARN，于是「凌玥 t25 玩家点名要见她、正文她在药店门口说话、
  // 史官写了她的 location/condition/mood，present 里却没有她」这种真缺陷被降成 WARN。
  const lifeLeaks = [];
  for (const lr of lifeRows) {
    const who = lr.who;
    // D14 已单独判「主角被判离场」。主角被史官写成 gone 是另一个缺陷
    // （`player.life_state` 没有消费方却被 lint 读到），不归这条判据管——
    // 否则同一件事在报告里出现两遍，一个叫「离场角色不得再上场」、一个叫「主角不得被判离场」。
    if (playerNames.includes(String(who))) continue;
    const from = Number(lr.valid_from);
    const live = asmRows.filter((r) => Number(r.turn_no) > from && stillDeadAt(lr, Number(r.turn_no)));
    const later = live.filter((r) => String(r.content || '').includes(who)).map((r) => Number(r.turn_no));
    if (!later.length) continue;
    const inPresent = later.filter((tn) => (presentByTurn.get(tn) || []).includes(who));
    // D10：区分「正文自己提了一嘴」与「玩家主动点名要去找这个人」。
    // 玩家点名是最强信号——他明确要求这一拍和这个人互动，代码仍把她从在场里剔除，
    // 那就是**机制没跟上正文**，不是「正文没跟上机制」。判据方向反了等于给错误发合格证。
    const namedByPlayer = live
      .filter((r) => {
        const p = playerByTurn.get(Number(r.turn_no));
        return p && String(p.content || '').includes(who);
      })
      .map((r) => Number(r.turn_no));
    lifeLeaks.push({
      who, value: lr.value, from,
      valid_to: lr.valid_to == null ? null : Number(lr.valid_to),
      turns: later, in_present: inPresent, named_by_player: namedByPlayer,
    });
  }
  const lifeFatal = lifeLeaks.filter((x) => x.in_present.length > 0);
  // D10：玩家点名过 + 不在 present = 机制漏了（FAIL）。
  // 只剩「正文出现名字、玩家没点名」（旁白顺带一提）才 WARN。
  // D22 曾加过一个独立信号（史官写了在场态），三局边际贡献都是 0，已按当时的判据撤销
  // ——零收益的判据分支和零消费方的路径一样，会让报告看起来更严而实际没变。
  const lifeReviveMissing = lifeLeaks.filter((x) => x.in_present.length === 0 &&
    x.named_by_player.length > 0);

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
  // 「按事件」的分子会被单拍放大：一条正文拍一次点名 5 个事件就贡献 5。
  // 所以同时记一个「按正文拍」的口径（点中 ≥1 个可外泄事件的正文拍数），
  // 两个口径差得远时说明是指标被少数拍放大，不是世界呼吸真的被读了。
  const offstageCitedBodyTurns = new Set();
  for (const p of offstageRows) {
    const pl = safeJson(p.payload_json);
    const names = [].concat(pl.who ?? []).map(String).filter(Boolean);
    const visible = pl.visibility === 'rumor' || pl.visibility === 'public';
    if (visible) offstageVisible += 1;
    else offstageHidden += 1;
    const hitTurn = visible && names.length
      ? narr.find((t) => Number(t.turn_no) > Number(p.turn_no) && names.some((w) => String(t.content || '').includes(w)))?.turn_no ?? null
      : null;
    if (hitTurn !== null) {
      offstageCited += 1;
      offstageCitedBodyTurns.add(Number(hitTurn));
    }
    offstageDetail.push({
      turn_no: Number(p.turn_no), status: p.status, visibility: pl.visibility ?? null,
      who: names, cited_at: hitTurn,
    });
  }

  // D5 线索 WIP 上限：模型「埋了但被拒」的提案。
  //
  // 判据不是「有没有被拒」（到顶本来就该拒），而是**被拒的构成**：
  // - low_weight 多 = 提示词判据没说服模型，它还在按惯性埋 atmosphere；
  // - wip_full 多 = 上限压住了真正想推进的线索，说明 8 条对这张卡偏小。
  // 两者都意味着提示词与代码之间的落差，所以必须出现在报告里，而不是沉默地 continue。
  const threadRejected = all(
    "select turn_no, payload_json from patches where session_id = :sid and kind = 'thread_rejected' order by turn_no asc, id asc",
    { sid: sessionId }
  ).map((p) => {
    const pl = safeJson(p.payload_json);
    const items = Array.isArray(pl.items) ? pl.items : [];
    return { turn_no: Number(p.turn_no), total: Number(pl.total) || items.length, items };
  });
  const threadRejectedTotal = threadRejected.reduce((a, r) => a + r.total, 0);
  const threadRejectReasons = {};
  for (const r of threadRejected) {
    for (const it of r.items) threadRejectReasons[it.reason] = (threadRejectReasons[it.reason] || 0) + 1;
  }

  // 校勘（continuity）产出的问题有没有被吸收，以及「史官写了但没人读」的写入 ROI。
  //
  // 口径：continuity 是系统唯一「主动发现问题」的通道（interim-findings O8），
  // 它报出的 major 级问题（contradiction / state_jump）若长期挂 open，说明写入没有消费方。
  // minor（knowledge_breach / stale_thread）只计数不判定——它们本来就是提示性的。
  //
  // `uncertain` 曾是史官每拍写的「叙事悬念」（约 3 条/拍，无任何消费方，O9）。
  // D6 之后它不落库，这条计数退化成「回退探针」：非 0 就说明又写回表了。
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
      fix_target: pl.fix?.target ?? '',
      // D15：模型常把「断言过时了」写成 set_state + 断言 id。修好之后代码按
      // invalidate_assertion 执行，并把「改写了模型原意」记在 interpreted_as 里。
      // 这个字段非空 = 提示词与模型的 schema 理解仍有偏差，别当噪声跳过。
      fix_state: pl.fix_result?.state ?? null,
      fix_interpreted_as: pl.fix_result?.interpreted_as ?? null,
      fix_reason: pl.fix_result?.reason ?? null,
    };
  });
  const contMajor = contRows.filter((r) => r.severity === 'major');
  const contMajorOpen = contMajor.filter((r) => r.status === 'open');
  // D31：形态不对 / 通道没实现的提案不再记 `open`，改成 `failed` 终态。
  // 这不是「发明了一个新状态」，而是**把「等人裁决」和「永远执行不了」分开**：
  // 过去两者都是 open，于是「major 挂 open N 条」既可能是待人工裁决，也可能是一条
  // 100% 落空的通道在排队，报告只能数出数、数不出性质。存量会话仍是 open，所以两列都要报。
  const contFailed = contRows.filter((r) => r.status === 'failed');
  const contMinor = contRows.filter((r) => r.severity !== 'major');
  // D12：校勘的自动修复是否真的执行过。
  //
  // 判据不是「有没有 open 的 major」，而是「invalidate_assertion 这条 fix 有没有一条
  // 变成 applied」。历史事故：提示词把断言渲染成 `#1789`，而 memory-pipeline.js 的判据是
  // /^\d+$/ —— 带 # 的一律落空，fix 从未生效过，而 patch 仍记成 status='open'，
  // 看上去像「发现了问题、等人裁决」。所以这里单独量「带 # 的 target 占比」。
  const contFixRows = contRows.filter((r) => r.fix && r.fix !== 'none');
  const contFixApplied = contRows.filter((r) => r.status === 'applied' && r.fix && r.fix !== 'none');
  const contHashTargets = contRows.filter((r) => String(r.fix_target || '').startsWith('#'));
  // D15：模型把断言 id 填进 set_state 的次数。代码按 invalidate_assertion 执行了，
  // 但这是「读懂了模型的错」而不是「模型写对了」——占比高说明提示词的 fix schema
  // 还不够清楚，下一轮该改的是提示词，不是继续在代码里猜。
  const contInterpreted = contRows.filter((r) => r.fix_interpreted_as);
  // 拒写留痕：非人物 subject / 字段不在受控表 / target 形态不完整。
  const contRejectedFixes = contRows.filter((r) => r.fix_state === 'unmatched');
  // D15 修复后的代码对 set_state **一定**写 fix_result（interpreted_as 或 unmatched）。
  // 所以「set_state 且已执行、却没有 fix_result」的行只可能来自修复前的旧代码——
  // 那正是把地点写进 condition、还造出假人物的那一版。存量会话要单独标出来，
  // 否则 contInterpreted=0 会被读成「模型全写对了」（和 history_self_echo 同一个坑）。
  const contLegacySetState = contRows.filter(
    (r) => r.fix === 'set_state' && r.status === 'applied' && r.fix_state === null
  );
  // D6 之后 uncertain 不再落库，所以这里应当是 0。留着这一行是为了让「它又长回来了」
  // 变成一个显眼的违约信号，而不是悄悄回到 patches 表里继续当噪音。
  const uncertainRows = (one(
    "select count(*) c from patches where session_id = :sid and kind = 'uncertain'",
    { sid: sessionId }
  ) || {}).c;
  // D11（修复后）：余额转负不再被拒，改成「欠 X」渲染 + 一条 overdrawn 留痕。
  // 这两个探针要一起看：rejected_delta 必须归零，overdrawn 应该出现（角色真的会欠钱）。
  // 只看前者会得出「钱没问题」，只看后者会以为「出现了新故障」。
  const overdrawnRows = (all(
    "select turn_no, payload_json from patches where session_id = :sid and kind = 'overdrawn' order by turn_no asc, id asc",
    { sid: sessionId }
  ) || []).map((p) => {
    const pl = safeJson(p.payload_json);
    return {
      turn_no: Number(p.turn_no), path: pl.path ?? null, op: pl.op ?? null,
      value: pl.value ?? null, prev: pl.prev ?? null, next: pl.next ?? null,
    };
  });
  // D10（修复后）：玩家点名让 gone 的人回到场记单，每次回程留一条 life_state_revived。
  // 它非 0 说明回程通道真的被用过——而不是「规则写好了但永远不触发」。
  const revivedRows = (all(
    "select turn_no, payload_json from patches where session_id = :sid and kind = 'life_state_revived' order by turn_no asc, id asc",
    { sid: sessionId }
  ) || []).map((p) => {
    const pl = safeJson(p.payload_json);
    return { turn_no: Number(p.turn_no), who: pl.who ?? null, from: pl.from ?? null, to: pl.to ?? null, reason: pl.reason ?? null };
  });
  // D11：被拒的数值增量。钱是唯一的数值账本，拒绝之后余额卡死、正文与账本公开打架。
  // 这个探针必须存在，否则「银钱」在报告里永远是健康的。
  const rejectedDeltaRows = (all(
    "select turn_no, payload_json from patches where session_id = :sid and kind = 'rejected_delta' order by turn_no asc, id asc",
    { sid: sessionId }
  ) || []).map((p) => {
    const pl = safeJson(p.payload_json);
    return {
      turn_no: Number(p.turn_no), path: pl.path ?? null, op: pl.op ?? null,
      value: pl.value ?? null, prev: pl.prev ?? null, next: pl.next ?? null,
      reason: pl.reason ?? null,
    };
  });
  // D13：被目标声明挡掉的写入。模型在正文里用简称指代长名实体（「蛇纹纸」指「蛇纹圆印纸」），
  // 简称不在别名索引里 → canonicalize 失败 → 整条写入被拒，而正文继续按它推进。
  // 拒写本身是对的（白名单防模型给没出现过的东西记账），**看不见才是问题**。
  const skippedTargetRows = (all(
    "select turn_no, payload_json from patches where session_id = :sid and kind = 'skipped_targets' order by turn_no asc, id asc",
    { sid: sessionId }
  ) || []).map((p) => {
    const pl = safeJson(p.payload_json);
    const items = arr(pl.items);
    return { turn_no: Number(p.turn_no), total: Number(pl.total || items.length), items };
  });
  const skippedTargetItems = skippedTargetRows.flatMap((r) => r.items.map((i) => ({ turn_no: r.turn_no, ...i })));
  // D25：world / player 不是卡实体，而是投影目标；它们被拒是结构性缺口，不是别名问题。
  // 必须先剔出去，否则同一个问题会被 D13（反复被拒）与 D25 两条判定重复计数，
  // 还会被错误归因成「简称不在别名索引里」——两处口径不同的病。
  const skippedStructuralItems = skippedTargetItems.filter((x) => x.target === 'world' || x.target === 'player');
  const skippedAliasItems = skippedTargetItems.filter((x) => x.target !== 'world' && x.target !== 'player');
  const skippedByTarget = {};
  for (const i of skippedAliasItems) {
    const k = String(i.target ?? '?');
    skippedByTarget[k] = (skippedByTarget[k] || 0) + 1;
  }
  const skippedRepeat = Object.entries(skippedByTarget).filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]).map(([target, n]) => ({ target, n }));

  report.memory = {
    counts,
    patches: patchDist,
    continuity: {
      total: contRows.length,
      major: contMajor.length,
      major_open: contMajorOpen.length,
      minor: contMinor.length,
      rows: contRows,
      // D12：fix 通道是否真的跑通过。applied=0 而 fix 非 none 的条目 >0，就是「提了但没执行」。
      fix_proposed: contFixRows.length,
      fix_applied: contFixApplied.length,
      hash_targets: contHashTargets.length,
      applied_rate: contFixRows.length ? contFixApplied.length / contFixRows.length : null,
      // D15：模型把断言 id 填进 set_state —— 代码按 invalidate_assertion 执行了，
      // 但这是「读懂了模型的错」。占比高说明 fix schema 的措辞该改，不是代码该继续猜。
      interpreted_as_invalidate: contInterpreted.length,
      // 拒写留痕：非人物 subject、字段不在受控表、target 形态不完整。
      rejected_fixes: contRejectedFixes.length,
      rejected_by_reason: contRejectedFixes.reduce((m, r) => {
        const k = r.fix_reason || 'unknown';
        m[k] = (m[k] || 0) + 1;
        return m;
      }, {}),
      threshold_note: 'major 级校勘问题（contradiction / state_jump）长期挂 open = 发现了但没人处置；'
        + 'fix_applied=0 而 fix_proposed>0 = 自动修复通道从没生效过（D12：target 带 # 被 /^\\d+$/ 挡掉）；'
        + 'interpreted_as_invalidate>0 = 模型把断言 id 填进 set_state（D15，代码兜住了但提示词没说清）；'
        + 'minor 只计数不判定。',
    },
    rejected_delta: {
      n: rejectedDeltaRows.length,
      rows: rejectedDeltaRows,
      note: 'D11：数值增量被拒（余额会变负）。拒绝后基准不动，会形成「余额卡死、正文继续花」'
        + '的分裂；非 0 就说明这条链路上出现过静默丢弃。',
    },
    overdrawn: {
      n: overdrawnRows.length,
      rows: overdrawnRows,
      min_balance: overdrawnRows.reduce((m, r) => (typeof r.next === 'number' && (m === null || r.next < m) ? r.next : m), null),
      note: 'D11 修复后余额转负是允许的（渲染成「欠 X」），每笔留一条 overdrawn。'
        + '它 >0 而 rejected_delta=0 才是新的正确形状；两者都 0 = 本局没花超。',
    },
    life_state_revived: {
      n: revivedRows.length,
      rows: revivedRows,
      who: [...new Set(revivedRows.map((r) => r.who).filter(Boolean))],
      note: 'D10-A：玩家点名让 gone 的角色回到场记单，每次留一条回程审计。'
        + '0 条 = 本局没有「离场又回来」的剧作结构（或回程通道没接上，见 dead_gone_reentry）。',
    },
    skipped_targets: {
      patches: skippedTargetRows.length,
      items: skippedTargetItems.length,
      by_target: skippedByTarget,
      repeated: skippedRepeat,
      rows: skippedTargetRows,
      // D25：`world` 被拒**不是**别名问题。它是和 `player` 同级的投影目标
      // （`world/status` → `world.runtime.status` → 场记单「局势」行 + 常驻笔记），
      // 但 `buildDeclaredTargets()` 曾经只 add 了 `player`、漏了 `world`，
      // 于是史官每一次世界局势变更都被目标声明静默拦掉（全库 `entity_kind='world'`
      // 的 world_state 写入 0 行）。这条判据原来把所有被拒都解释成「简称不在别名索引里」，
      // 把结构性缺口说成了模型措辞问题——方向错了。现在单列出来。
      structural: skippedStructuralItems,
      alias_total: skippedAliasItems.length,
      note: 'D13：被目标声明拦下的写入。多数是模型用简称指代长名实体（「蛇纹纸」→「蛇纹圆印纸」），'
        + '简称不在别名索引里，整条写入被拒；正文继续按它推进，账本里永远没有它。'
        + 'repeated 里出现「同一目标被拒 ≥2 次」＝这个实体在本局实际上是黑的。'
        + '但 target=world/player 的被拒属于结构性缺口（D25，已修），不是别名问题——'
        + '老会话里出现它们，说明那一局跑在 D25 之前。',
    },
    uncertain: {
      n: Number(uncertainRows || 0),
      consumers: 0,
      note: 'D6 之后 uncertain 不落库（保留提示词出口、不再写 patches），这里应为 0；'
        + '非 0 说明回退了。',
    },
    assertions: assertionStatus,
    threads: threadStatus,
    thread_rejected: {
      patches: threadRejected.length,
      total: threadRejectedTotal,
      reasons: threadRejectReasons,
      rows: threadRejected,
      note: 'D5 之后线索有 WIP 上限与 0.6 权重阈值：被拒的提案记在 patches(kind=\'thread_rejected\')。'
        + 'low_weight 多 = 提示词判据没说服模型；wip_full 多 = 上限对这张卡偏小。',
    },
    life_state: { distribution: lifeStates, dead_writes: deadWrites, death_turns: deathTurns },
    // D14：主角进 absentees = 他从自己的场记单里消失了，而正文仍是第一人称。
    player_absentees: {
      known: absenteesKnown,
      player_names: playerNames,
      turns: playerAbsentRows.map((x) => x.turn_no),
      rows: absenteesRows,
      note: 'D14：主角是「镜头本身」，不该因 life_state 被判离场。'
        + '这里非空 = lintState 又把他剔出去了（修法见 §13）。known=false 说明装配层没记 scene_sheet。',
    },
    // 回声（D18）：候选 vs 渲染。两者长期相等且都 >0 = 没被削；候选>渲染 = 被 slice/预算削掉。
    // 辞书两道出口（D24）：简报那道是 `floor(sceneCap*0.2/40)` 条，51 拍实测丢 46%。
    // 旧会话没有 codex_* 字段 → known_turns 为 0，报告显示 MISSING 而不是「一条没丢」。
    codex: (() => {
      const known = asmRows.filter((r) => r.codex.candidates != null);
      const cand = known.reduce((s, r) => s + (r.codex.candidates || 0), 0);
      const rend = known.reduce((s, r) => s + (r.codex.rendered || 0), 0);
      const bc = known.reduce((s, r) => s + (r.codex.brief_candidates || 0), 0);
      const br = known.reduce((s, r) => s + (r.codex.brief_rendered || 0), 0);
      return {
        known_turns: known.length,
        full_candidates: cand,
        full_rendered: rend,
        brief_candidates: bc,
        brief_rendered: br,
        brief_dropped: Math.max(0, bc - br),
        brief_rate: bc ? br / bc : null,
      };
    })(),
    // 渲染前体检干预（D24）：lint-state 每拍剔谁、为什么。D10/D14 那类缺陷正是靠它才看得见。
    state_fixes: (() => {
      const known = asmRows.filter((r) => Array.isArray(r.state_fixes));
      const rows = [];
      for (const r of known) {
        for (const f of r.state_fixes) rows.push({ turn_no: r.turn_no, ...f });
      }
      const byKind = {};
      for (const x of rows) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
      return { known_turns: known.length, n: rows.length, by_kind: byKind, rows: rows.slice(0, 40) };
    })(),
    state_warnings: (() => {
      const known = asmRows.filter((r) => Array.isArray(r.state_warnings));
      const rows = [];
      for (const r of known) for (const w of r.state_warnings) rows.push({ turn_no: r.turn_no, ...w });
      const byKind = {};
      for (const x of rows) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
      return { known_turns: known.length, n: rows.length, by_kind: byKind, rows: rows.slice(0, 40) };
    })(),
    // 成长曲线（D24）：一次都没解锁过也要能看见，否则「这条曲线是不是死的」无从判断。
    fates: (() => {
      const known = asmRows.filter((r) => r.fates != null);
      const last = known.at(-1);
      return {
        known_turns: known.length,
        total: last ? last.fates.total : null,
        unlocked: last ? last.fates.unlocked : null,
        omens: last ? last.fates.omens : null,
        ever_unlocked: known.some((r) => (r.fates.unlocked || 0) > 0),
      };
    })(),
    // 走向版场记单（D26-B）：branch 每次少看多少 token，以及少的是哪一段。
    // 旧会话没有 scene_sheet.branch_sheet → known_turns 为 0（不是「省了 0 字节」）。
    branch_sheet: (() => {
      const known = asmRows.filter((r) => r.branch_sheet?.known);
      const saved = known.reduce((s, r) => s + ((r.branch_sheet.full_tokens || 0) - (r.branch_sheet.tokens || 0)), 0);
      const fullSum = known.reduce((s, r) => s + (r.branch_sheet.full_tokens || 0), 0);
      const droppedSet = new Set();
      for (const r of known) for (const k of (r.branch_sheet.dropped || [])) droppedSet.add(k);
      // 档位分布（D26）：正常只有一种；出现两种以上说明同一局中途改过会话设置，
      // 那这局的「省了多少」就不能当成一个臂的结果。
      const trimSet = new Set(known.map((r) => r.branch_sheet.trim || 'default'));
      return {
        known_turns: known.length,
        trims: [...trimSet],
        dropped_sections: [...droppedSet],
        saved_tokens_total: known.length ? saved : null,
        saved_tokens_avg: known.length ? Math.round(saved / known.length) : null,
        saved_rate: fullSum > 0 ? saved / fullSum : null,
      };
    })(),
    // 原声可见性（D23）：voices 按人分区（每人 perWho 条、渲染 slice(0,2)），
    // 所以「有几个人有声音锚点」才是可判定的。旧实现是全局 400 行窗口，
    // 长跑顶穿后久没开口的角色整段消失——这里报覆盖人数，让报告能看出那件事。
    voices: (() => {
      const known = asmRows.filter((r) => r.voices.present_covered != null);
      const covered = known.reduce((s, r) => s + (r.voices.present_covered || 0), 0);
      const speakers = known.reduce((s, r) => s + (r.voices.speakers || 0), 0);
      // 「有说话者、但一个都没落到在场者」＝窗口错位最强信号（D23 回退时会整片出现）
      const blind = known.filter((r) => (r.voices.speakers || 0) > 0 && (r.voices.present_covered || 0) === 0).length;
      return {
        known_turns: known.length,
        speakers_avg: known.length ? speakers / known.length : null,
        present_covered_avg: known.length ? covered / known.length : null,
        speakers_without_cover_turns: blind,
        per_turn: known.map((r) => ({
          turn_no: r.turn_no, sp: r.voices.speakers, cov: r.voices.present_covered,
        })),
      };
    })(),
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
    offstage: {
      total: offstageRows.length, cited: offstageCited,
      rate: offstageRows.length ? offstageCited / offstageRows.length : null,
      visible: offstageVisible, hidden: offstageHidden,
      cited_body_turns: offstageCitedBodyTurns.size,
      detail: offstageDetail,
    },
  };

  console.log(h('4. 记忆一致性（确定性口径）'));
  console.log('表计数       ' + tableNames.map((t) => `${t}=${counts[t] === null ? MISSING : counts[t]}`).join(' · '));
  console.log(`patches      ${patchDist.length ? patchDist.map((p) => `${p.agent}/${p.kind}/${p.status}=${p.n}`).join(' · ') : MISSING}`);
  console.log(`assertions   ${assertionStatus.length ? assertionStatus.map((a) => `${a.status}=${a.n}`).join(' ') : MISSING}` +
    (assertionStatus.some((a) => a.status === 'invalidated') ? '｜冲突失效在不删除的前提下生效' : '｜未见 invalidated（无冲突或未触发）'));
  console.log(`threads      ${threadStatus.length ? threadStatus.map((t) => `${t.status}=${t.n}`).join(' ') : MISSING}`
    + (report.memory.thread_rejected.total
      ? `｜被拒 ${report.memory.thread_rejected.total} 条（${Object.entries(report.memory.thread_rejected.reasons).map(([k, v]) => `${k}=${v}`).join(' / ')}）`
      : '｜无被拒线索'));
  console.log(`生命体征     life_state ${lifeStates.length ? JSON.stringify(lifeMap) : MISSING}｜正文含死亡表述 ${deathTurns.length} 轮${deathTurns.length ? '（t' + deathTurns.join(',') + '）' : ''}｜dead/gone 写入 ${deadWrites} 行`);
  // D14：主角缺席是最刺眼的一种「记忆失真」——他从自己的场记单里消失，而正文仍是第一人称。
  if (!report.memory.player_absentees.known) {
    console.log(`主角缺席     ${MISSING}（装配层没记 scene_sheet，需重跑）`);
  } else if (report.memory.player_absentees.turns.length) {
    console.log(`主角缺席     ✗ t${report.memory.player_absentees.turns.join(',')} 被列进 absentees（主角被判离场，D14 回退）`);
  } else {
    console.log(`主角缺席     0 拍（${report.memory.player_absentees.player_names.join('/') || '玩家名未知'} 从未被剔出在场）`);
  }
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
    `｜按正文拍 ${offstageCitedBodyTurns.size}/${narr.length}（${pct(offstageCitedBodyTurns.size, narr.length)}）` +
    (offstageDetail.length ? '｜' + offstageDetail.slice(0, 6).map((o) => `t${o.turn_no}:${o.who.join('/') || '?'}${o.cited_at ? '✓' : '✗'}`).join(' ') : ''));
  console.log(`校勘         ${contRows.length} 条（major ${contMajor.length}｜其中挂 open ${contMajorOpen.length}｜minor ${contMinor.length}）` +
    (contFailed.length ? `｜未执行终态 ${contFailed.length}` : ''));
  console.log(`  自动修复     fix 提案 ${contFixRows.length} 条｜已执行 ${contFixApplied.length} 条｜target 带 # 的 ${contHashTargets.length} 条` +
    (contFixRows.length && !contFixApplied.length
      ? '  ← 提案全落空：检查 memory-pipeline.js 的 /^\\d+$/ 是否该接受 # 前缀（D12）'
      : ''));
  for (const r of contMajor) {
    console.log(`  t${r.turn_no} ${r.kind}/${r.status}${r.severity === 'major' ? '' : ''} [${r.subject}] ${r.claim}`);
  }
  console.log(`史官 uncertain ${Number(uncertainRows || 0)} 条｜应为 0（D6 后不落库；非 0 即回退）`);
  console.log(`数值被拒     ${rejectedDeltaRows.length} 条` +
    (rejectedDeltaRows.length
      ? '｜' + rejectedDeltaRows.slice(0, 6).map((r) => `t${r.turn_no}:${r.path} ${r.value}（${r.reason}，余额停在 ${r.prev}）`).join(' ')
      : '｜应为 0（D11：拒绝会让余额卡死、正文与账本分裂）'));
  if (overdrawnRows.length) {
    const minBal = overdrawnRows.reduce((m, r) => (typeof r.next === 'number' && (m === null || r.next < m) ? r.next : m), null);
    console.log(`  余额转负     ${overdrawnRows.length} 笔｜最低 ${minBal ?? '?'}｜首次 t${overdrawnRows[0].turn_no}（渲染成「银钱 欠 X」，D11 的新正确形状）`);
  }
  if (revivedRows.length) {
    console.log(`  gone 回程    ${revivedRows.length} 次｜${[...new Set(revivedRows.map((r) => `t${r.turn_no} ${r.who}`))].slice(0, 6).join('，')}`);
  }
  console.log(`目标越界     ${skippedTargetItems.length} 条（${skippedTargetRows.length} 拍）` +
    (skippedTargetItems.length
      ? '｜' + Object.entries(skippedByTarget).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${t}×${n}`).join(' ') +
        (skippedRepeat.length ? `  ← 反复被拒：${skippedRepeat.slice(0, 4).map((x) => `${x.target}×${x.n}`).join(' ')}` + (skippedRepeat.length === 0 ? '（结构性：投影目标被拦，D25）' : '（D13：简称不在别名索引里）') : '')
      : '｜应为 0（非 0 说明有实体被目标声明挡住）'));

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

  // 结尾探针只认具体的「逼你做决定」句式，
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
  } else if (slideBreaks.length > 0) {
    // D16：原文窗口起点每拍 +1（`recent_from` 随 turnNo 爬），窗口在滑不在长。
    // 表现是消息数不变、对位段第一条被改写 —— 旧口径会把它算进「同消息改写」，
    // 也能被 rewrite==0 瞒过去（消息数打平时它落到 rewrite 之外）。单列一条，
    // 因为它是**每拍重复**的烧前缀，不是一次性结构事件。
    prefixStatus = 'FAIL';
    prefixDetail += `｜原文窗口滑动 ${slideBreaks.length} 轮（t${turnRanges(slideBreaks.map((r) => r.turn_no))}）` +
      '：recent_from 随 turnNo 每拍 +1，窗口在滑不在长（D16 回退）';
  } else if (unexplainedRegressions.length > 0) {
    // 前缀变短且消息数没变少、断点也不属于任何结构事件＝同一条消息被改写/裁掉。
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
  if (gapBreaks.length > 0) {
    // 少一拍：上一拍装配成功、旁白失败（孤儿回合），于是下一拍的 drift 基线跨了一拍。
    // 这是一次性位移，不是持续改写；罚它等于把孤儿回合算两遍。
    prefixDetail += `｜少一拍基线错位 ${gapBreaks.length} 轮（t${turnRanges(gapBreaks.map((r) => r.turn_no))}，成因是孤儿回合，见孤儿判据）`;
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

  // 上游真实缓存命中：与上一条判据分离。上一条判「我们的前缀有没有断」，
  // 这一条判「上游到底吃到了多少」——实测同一份 prompt 连发 12 次，11 次 94.6%、1 次 0%，
  // 说明命中是上游按节点/分片的路由抽签，不是我们的结构问题。
  // 因此它最多 WARN，绝不 FAIL（FAIL 会让人去改没错的东西）。
  const up = report.cache.upstream;
  add(
    'cache_upstream_hit',
    '上游真实缓存命中率应接近本地估算上限（差距大说明命中是路由抽签，不是前缀断了）',
    (up && up.narrator_turns ? (up.narrator_zero_turns > up.narrator_turns * 0.3 ? 'WARN' : 'PASS') : 'WARN'),
    up && up.narrator_turns
      ? `narrator ${up.narrator_hit_turns}/${up.narrator_turns} 拍命中过半，${up.narrator_zero_turns} 拍 0 tok｜真实均值 ${pctv(up.narrator_mean_rate)} vs 本地上限 ${pctv(up.local_estimate_mean)}｜**WARN 不代表前缀断了**：上游缓存按节点/分片，同一份 prompt 连发 12 次实测 11 次 94.6%、1 次 0%`
      : '没有 usage_json.cached_tokens，量不到'
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
    'recent_from + overlap_turns === scene_to+1（重叠合法、洞非法）且场次无洞',
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
  // 说明「发现」没有变成「处置」——同类缺口在 O9（史官写 uncertain 没人读，已于 D6 修掉）。
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
        `｜minor ${contMinor.length} 条只计数` +
        // D31：failed 是终态（形态不对 / 通道没实现 / 按设计拒写），它**不是**待裁决，
        // 所以不能算进「挂 open」。但也不能不提——「有 4 条已经判死」和「一条都没有」
        // 是两种状态，混在一起会让一个死通道看起来像健康的。
        (contFailed.length
          ? `｜已判终态 ${contFailed.length} 条（${Object.entries(contFailReasons).map(([k, n]) => `${k} ${n}`).join('，')}）`
          : '')
  );

  add(
    'continuity_fix_applied',
    '校勘提出的自动修复应至少执行过一条（D12）',
    contFixRows.length === 0 ? 'PASS'
      : contFixApplied.length > 0 ? 'PASS' : 'FAIL',
    contFixRows.length === 0
      ? '本局校勘没有提任何 fix（action 全是 none），这条判据不适用'
      : contFixApplied.length > 0
        ? `fix 提案 ${contFixRows.length} 条，执行 ${contFixApplied.length} 条（${pct(contFixApplied.length, contFixRows.length)}）`
        : `fix 提案 ${contFixRows.length} 条，**执行 0 条**` +
          (contHashTargets.length ? `，其中 ${contHashTargets.length} 条 target 带 # 前缀` : '') +
          '｜自动修复通道从未生效：见 D12'
  );

  // D15：模型把断言 id 填进 set_state。代码按 invalidate_assertion 兜住了（语义一致），
  // 所以不判 FAIL——但占比高说明 fix schema 的措辞没说服模型，下一轮该改提示词。
  add(
    'continuity_fix_schema',
    '模型应能区分「断言过时」与「状态改写」（D15）',
    contLegacySetState.length > 0 ? 'WARN'
      : contInterpreted.length === 0 ? 'PASS' : 'WARN',
    contLegacySetState.length > 0
      ? `${contLegacySetState.length} 条 set_state 已执行但没有 fix_result（t${contLegacySetState.slice(0, 6).map((r) => r.turn_no).join(',t')}）` +
        '｜这是 D15 修复前的形状：它把值写进 `condition`（地点装进伤情），'
        + '还会给「伍卿的积蓄」这类非人物 subject 造出一个假人物。**存量会话无法回溯判定**，'
        + '要验证 D15 必须重跑'
      : contInterpreted.length === 0
        ? (contRejectedFixes.length === 0
          ? 'fix 提案的 action / target 与 schema 一致'
          : `action/target 与 schema 一致；另有 ${contRejectedFixes.length} 条因 subject 不是人物或字段不在受控表被拒写（${JSON.stringify(contRejectedFixes.reduce((m, r) => { const k = r.fix_reason || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {}))}）`)
        : `${contInterpreted.length} 条把断言 id 填进 set_state（代码按 invalidate_assertion 执行）` +
          `：t${contInterpreted.slice(0, 6).map((r) => r.turn_no).join(',t')}` +
          '｜这不是故障而是 schema 措辞问题——`fix.target` 该说清「状态键用 `人物::字段`、断言用 `#id`」'
  );

  // D29：`set_state` 的 target 形态。代码只认 `人物::字段`；双局长跑实测 7 条 set_state
  // 全部落空，形态是 `大黑牛.condition`（点号）、`凌玥`（裸人名）、`伍卿 —拥有→ 金钱`。
  // 原因在提示词：schema 只写「状态键 / 线索标题」，没规定分隔符，模型就自己发明了。
  //
  // D31 之后 `fix_reason` 把这些落空拆开了，判据要跟着改：
  //   stale_value    = target 解析不出 `人物::字段`（模型的错，改提示词能修）→ 形态问题
  //   bad_target_form= 有 `::` 但人名/字段为空（模型的错）→ 形态问题
  //   not_a_person / unknown_field = 代码按设计拒写（不该修）→ 不是形态问题
  //   reason 为空    = 修复前的存量行（那时根本没人写 reason），无法判定，只能单列
  // 继续用老判据（unmatched && !reason && 不含 ::）会让这条在修复后恒为 PASS——
  // 一个只剩合格证的判据。
  const contSetState = contRows.filter((r) => r.fix === 'set_state');
  const FORM_REASONS = new Set(['stale_value', 'bad_target_form']);
  const contSetStateBadForm = contSetState.filter(
    (r) => r.fix_state === 'unmatched' && FORM_REASONS.has(r.fix_reason)
  );
  const contSetStateRejected = contSetState.filter(
    (r) => r.fix_state === 'unmatched' && r.fix_reason && !FORM_REASONS.has(r.fix_reason)
  );
  const contSetStateLegacy = contSetState.filter(
    (r) => r.fix_state === 'unmatched' && !r.fix_reason
  );
  // alias 类问题只报告：`merge_alias` 没有实现分支，提示词里已从 action 枚举删掉。
  // 模型仍写出来的话，这里单独可见——不然它和「填错形态」混在同一个 unmatched 里。
  const contMergeAlias = contRows.filter((r) => r.fix === 'merge_alias');

  // D29：`set_state` 落空不能只看「执行了几条」——要分清「提示词没写清形态（可修）」与
  // 「代码按设计拒写（该拒）」两件事。混在一起时，7 条全落空既可能是模型的错，
  // 也可能是代码在正确地拒绝非人物 subject，而报告给不出任何区别。
  add(
    'continuity_fix_target_form',
    'set_state 的 target 形态应能被代码解析（D29）',
    contSetState.length === 0 ? 'PASS'
      : contSetStateBadForm.length === 0 ? 'PASS' : 'WARN',
    contSetState.length === 0
      ? '本局校勘没提 set_state，这条判据不适用'
      : `set_state 提案 ${contSetState.length} 条，` +
        `执行 ${contSetState.filter((r) => r.fix_state === 'applied' || r.status === 'applied').length} 条，` +
        `形态没写对 ${contSetStateBadForm.length} 条` +
        (contSetStateBadForm.length
          ? `：${contSetStateBadForm.slice(0, 5).map((r) => `t${r.turn_no} ${JSON.stringify(r.fix_target)}`).join('，')}` +
            '｜代码只认 `人物::字段`（两个半角冒号）。形态不对的提案现在记 failed 终态，不再冒充「等人裁决」'
          : '') +
        (contSetStateRejected.length
          ? `｜按设计拒写 ${contSetStateRejected.length} 条（不是人物 / 字段不在受控表）`
          : '') +
        (contSetStateLegacy.length
          ? `｜存量无原因 ${contSetStateLegacy.length} 条（D31 之前写的，那时没人记 reason，无法判定形态，要验证必须重跑）`
          : '') +
        `｜merge_alias 提案 ${contMergeAlias.length} 条（没有实现分支，提示词已删掉这个枚举）`
  );

  // D11：数值增量被拒。钱是唯一的数值账本，拒绝之后基准不动 → 余额卡死、正文继续花。
  // 判 FAIL 而不是 WARN：这是「账本与正文公开矛盾」，不是质量瑕疵。
  add(
    'numeric_delta_rejected',
    '不应有数值增量被拒（D11）',
    rejectedDeltaRows.length === 0 ? 'PASS' : 'FAIL',
    rejectedDeltaRows.length === 0
      ? '没有数值增量被拒，银钱账本链路正常'
      : `${rejectedDeltaRows.length} 条被拒：` +
        rejectedDeltaRows.slice(0, 6).map((r) => `t${r.turn_no} ${r.path} ${r.value}（${r.reason}）`).join('，') +
        '｜被拒后基准不动，余额会卡在旧值上而正文继续按新值写'
  );

  // D13：目标越界。判 WARN 而不是 FAIL——拒写本身是白名单在正常工作；
  // 但「同一个目标被拒 ≥2 次」说明它在正文里反复出现、账本里却永远没有，
  // 那是实质性的记忆缺口，单列出来。
  add(
    'target_declaration_rejections',
    '目标声明拦下的写入不应反复指向同一实体（D13）',
    skippedAliasItems.length === 0 ? 'PASS'
      : skippedRepeat.length === 0 ? 'PASS' : 'WARN',
    skippedAliasItems.length === 0
      ? '没有被目标声明拦下的别名写入'
      : `${skippedAliasItems.length} 条被拒（${skippedTargetRows.length} 拍）` +
        (skippedRepeat.length
          ? `｜反复被拒：${skippedRepeat.slice(0, 5).map((x) => `${x.target}×${x.n}`).join('、')}` +
            '｜这些实体在正文里活着、在账本里是黑的（简称不在别名索引里，见 D13）'
          : '｜都是一次性提及，无反复被拒的实体')
  );

  // D25：world / player 被目标声明拦下是**结构性缺口**，不是别名问题。
  // 这两者不是卡里的实体，而是投影目标；它们的写入永远该被放行。
  // 老会话里出现 = 那一局跑在 D25 之前，需重跑才能验；新会话出现 = 回退。
  {
    const structural = skippedStructuralItems;
    const byTarget = {};
    for (const x of structural) byTarget[x.target] = (byTarget[x.target] || 0) + 1;
    add(
      'structural_target_rejection',
      'world/player 的写入不应被目标声明拦下（D25）',
      structural.length === 0 ? 'PASS' : 'FAIL',
      structural.length === 0
        ? '投影目标（world/player）没有被拦'
        : `${structural.length} 条 ` + Object.entries(byTarget).map(([k, v]) => `${k}×${v}`).join('、')
          + '｜world/player 是投影目标不是卡实体，被拦＝buildDeclaredTargets 漏了它们（D25 回退）',
    );
  }
  // D26-B：走向 Agent 的场记单应当「比送模那份少一段」而不是少得无影无踪。
  // 判据的两面：①字段在（旧会话量不到 → WARN，不判 PASS）；
  // ②省下的量必须落在合理区间——省 0 说明裁剪没接上，省到 70% 以上说明砍过头了
  // （走向会看不到在场者/线索，只能靠「刚刚发生的这一幕」猜）。
  {
    const bs = report.memory?.branch_sheet;
    const known = Number(bs?.known_turns || 0);
    const rate = bs?.saved_rate == null ? null : Number(bs.saved_rate);
    let status = 'PASS';
    let detail;
    if (known === 0) {
      status = 'WARN';
      detail = '没有 scene_sheet.branch_sheet（旧会话或进程未重启）→ 量不到走向版场记单省了多少';
    } else if (rate == null || rate <= 0) {
      status = 'FAIL';
      detail = `走向版场记单没有任何裁剪（${known} 拍均值省 ${num(bs.saved_tokens_avg)} tok）→ D26-B 没接上`;
    } else if (rate > 0.7) {
      status = 'FAIL';
      detail = `走向版省掉 ${pctv(rate)}（>70%），砍过头了：走向会失去在场者/线索锚点`;
    } else {
      detail = `${known} 拍｜档位 ${(bs.trims || ['default']).join('/')}`
        + `｜去掉 ${(bs.dropped_sections || []).join('/') || '(无)'}`
        + `｜每次省 ${num(bs.saved_tokens_avg)} tok（${pctv(rate)}）｜累计 ${num(bs.saved_tokens_total)} tok`;
    }
    add('branch_sheet_trim', '走向 Agent 的场记单应精简且不砍过头（D26）', status, detail);
  }

  // D23：声线锚点。旧实现是「全局前 400 行再按人切」，久没开口的角色声线整段消失，
  // 现场表现是「这个人重新登场时说话没有锚点」——不报错、不留痕。
  {
    const vc = report.memory?.voices;
    const known = Number(vc?.known_turns || 0);
    const blind = Number(vc?.speakers_without_cover_turns || 0);
    add(
      'voices_anchored',
      '在场者应有声线锚点（D23：声线按人取，不是全局窗口）',
      known === 0 ? 'WARN' : blind / known > 0.2 ? 'FAIL' : 'PASS',
      known === 0
        ? '没有 scene_sheet.voice_present_covered（旧会话或进程未重启）→ 量不到'
        : `${known} 拍有声线计数｜在场者平均覆盖 ${vc.present_covered_avg ?? '-'} 人/拍｜有说话者但覆盖为 0 的 ${blind} 拍`,
    );
  }

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

  // 7.3b SQL 层静默截断（D3）
  //
  // 和 7.3 是两种不同的失败：degraded 是「预算不够，按既定顺序丢了什么」，
  // SQL LIMIT 是「取数时就没取回来」，连 degraded 都不会出现。断言窗口填满之后，
  // 新写的事实再也不会进入提示词——这是长跑里最容易「看起来正常、实际在失忆」的一环。
  // 定 WARN 而不是 FAIL：50 轮内填不满是正常的，填满了也不代表当拍就坏，
  // 但它必须被看见，因为它是「记忆一致性从哪一拍开始往下掉」的分界线。
  const assertFullTurn = firstAssertionFull;
  const relFullTurn = firstRelationFull;
  const truncFlagged = assertFullTurn != null || relFullTurn != null;
  add(
    'sql_window_truncation',
    '断言/关系未顶到 SQL 窗口（50 轮内余量充足）',
    truncFlagged ? 'WARN' : 'PASS',
    !lastTrunc
      ? 'meta 里没有 layers_truncated（旧数据或探针未装）'
      : `断言 ${num(lastTrunc.assertions?.loaded)}/${num(lastTrunc.assertions?.window)}（库内 ${num(lastTrunc.assertions?.total)}）`
        + `｜关系 ${num(lastTrunc.relations?.loaded)}/${num(lastTrunc.relations?.window)}（库内 ${num(lastTrunc.relations?.total)}）`
        + (assertFullTurn != null ? `｜断言窗口 t${assertFullTurn} 起填满` : '')
        + (relFullTurn != null ? `｜关系窗口 t${relFullTurn} 起填满` : '')
  );

  // 7.3b2 断言在窗口内还有第二道丢弃（selectFacts 的 manyLimit）
  //
  // 比 SQL 窗口早得多、也更狠：`LIMIT 300` 决定「加载多少条」，`selectFacts` 决定
  // 「多少条能进提示词」——单值谓词全渲染，多值谓词只留前 10 条。实测 t31：加载 123 条、
  // 实际渲染 24 条。判 WARN 的门限是「丢弃数超过渲染数」，那说明模型看到的事实
  // 主要被相关性打分决定了，而这件事此前完全不可见。
  {
    const fs = report.budget.sql_truncation.facts;
    const lastFs = fs.last;
    let status = 'PASS';
    let detail = lastFs
      ? (lastFs.split
        ? `末轮渲染 ${num(lastFs.rendered)}/${num(lastFs.candidates)} 条（单值 ${num(lastFs.single)} + 多值 ${num(lastFs.many_rendered)}，多值丢弃 ${num(lastFs.many_dropped)}）`
        : `末轮渲染 ${num(lastFs.rendered)}/${num(lastFs.candidates)} 条（存量会话只有合计口径）`)
      : 'meta 里没有 facts 分项（旧数据或探针未装）';
    // candidates 为 0 说明这一轮根本没有断言分项（旧数据/探针未装），不能算 PASS——
    // 「没有数据」被读成「没问题」正是 D3 要消灭的那种假健康。
    if (!lastFs || !lastFs.candidates) {
      status = 'WARN';
      detail += '｜无法验证';
    } else if (lastFs.many_dropped > lastFs.rendered) {
      status = 'WARN';
      detail += '｜多值谓词丢弃数已超过渲染数：模型看到的事实主要由打分决定';
    }
    add('facts_selection_truncation', '断言窗口内没有过度丢弃（selectFacts 的 manyLimit）', status, detail);
  }

  // 7.3b3 关系层的渲染上限由预算推导，而不是写死 8（D17）
  //
  // 与 7.3b2 同构，但此前连记账都没有：`getRelations(limit:60)` 是加载量，
  // `renderSceneSheet` 里 `.slice(0, 8)` 才是真上限。长跑实测 51 拍里只有 11/42 条
  // 过场关系曾经露过面（同几条强关系锁死 8 个槽位），而关系段只占场景层配额的 1.6%。
  // 判 FAIL 的门限：渲染上限恒为 8（= 又退回写死）且库里过场关系明显多于 8。
  {
    const rs = report.budget.sql_truncation.relations;
    const lastRs = rs?.last || null;
    let status = 'PASS';
    let detail = lastRs && lastRs.limit != null
      ? `末轮关系 ${num(lastRs.rendered)}/${num(lastRs.limit)} 条上限（装载 ${num(lastRs.loaded)}，库内 ${num(lastRs.total)}）`
      : 'meta 里没有 relations_limit（旧数据或进程早于 D17）';
    if (!lastRs || lastRs.limit == null) {
      status = 'WARN';
      detail += '｜无法验证';
    } else if (lastRs.limit <= 8 && lastRs.total > 12) {
      status = 'FAIL';
      detail += '｜渲染上限仍是 8：条数退回写死，库里关系远超 8 条却只有 8 个槽位';
    } else if (lastRs.rendered != null && lastRs.limit > 0 && lastRs.rendered < lastRs.limit * 0.5 && lastRs.loaded > lastRs.limit) {
      status = 'WARN';
      detail += '｜渲染数远低于上限：段内被别的段挤掉了（检查 retained scenes 的 order）';
    }
    add('relations_render_limit', '关系条数由预算推导，不是写死 8（D17）', status, detail);
  }

  // 7.3c 资料员历史回查通道真的被用起来了吗（D4）
  //
  // D4 之前单发模式根本没有回查出口：`recall_history` 只在分段模式注入，而默认是 single。
  // 所以这一条不看「有没有报错」，看**通道是否被使用**：触发率恒为 0 说明 D4 没接上
  // （或玩家全程没点名任何人），查到历史的拍数为 0 说明查询词命不中（trigram/LIKE 门槛、
  // 分支可见性过滤都可能）。定 WARN 不 FAIL：50 拍里本来就可能一次都不需要回查。
  {
    const r = report.retrieval;
    let status = 'PASS';
    let detail = r.triggered
      ? `资料员触发 ${r.triggered} 拍（出文本 ${r.rendered}）｜查历史 ${r.history_queries_turns} 拍｜命中 ${r.history_hit_turns} 拍`
      : '资料员一次都没触发（meta.retrieval 全空）';
    if (!r.triggered) {
      status = 'WARN';
      detail += '｜无法验证 D4 通道';
    } else if (r.history_queries_turns === 0) {
      status = 'WARN';
      detail += '｜历史通道零触发：检查 shouldPrecheckRetrieval 的 person 分支是否接上，'
        + '以及剧本是否点名过已登场人物';
    } else if (r.hits_known_turns > 0 && r.hits_in_visible_rate !== null && r.hits_in_visible_rate > 0.3) {
      // D21：通道通了，但查回来的原文一半以上本来就躺在可见窗口里 → 白查。
      // 定 WARN 不 FAIL：它浪费一次调用 + 几百 token，但不会写错账本。
      status = 'WARN';
      detail += `｜命中落地 ${r.hits_in_visible}/${r.hits_total} 条落在可见窗口内（${pct(r.hits_in_visible, r.hits_total)}）：` +
        `查回的都是眼前已有的（t${r.useless_query_turns.join(',')}）｜检查 exclude_from 下界是否生效`;
    } else if (r.self_echo_known_turns > 0 && r.self_echo_rate !== null && r.self_echo_rate > 0.3) {
      // D21：自问自答降级为参考值。查询词用玩家原话未必白查——下界已经把窗口内那几拍排除了，
      // 「七十五块」这种专名在原话里出现、但在更早回合里也有它的来历，照样是有效检索。
      // 所以这条不再判 WARN，只在 detail 里留一个数，供人读时参考。
      detail += `｜自问自答 ${r.self_echo_queries}/${r.history_queries_total} 条（参考值，D21 起不判定）`;
    } else if (r.history_queries_total_all > 0 && r.self_echo_known_turns === 0) {
      status = 'WARN';
      detail += '｜旧会话缺 history_self_echo 字段，自问自答率无法核对（需重跑）';
    }
    add('retrieval_history_channel', '资料员的历史回查通道被实际使用', status, detail);
  }

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

  // 7.5b 趋势：前 1/3 与后 1/3 的局部重复率对比（D7 第 1 条，此前只有 p90 —— 早该有）。
  // p90 只能说「最差那一段有多差」，说不出「是否在恶化」。长跑真正要防的是后者：
  // 前 1/3 均值明显低于后 1/3，说明模型在**逐渐**变懒/复读，而不是偶发几拍。
  const trendVals = localVals.map((g, i) => ({ turn_no: g.turn_no, rate: g.rate, idx: i }));
  const trendN = Math.max(1, Math.floor(trendVals.length / 3));
  const headThird = trendVals.slice(0, trendN);
  const tailThird = trendVals.slice(-trendN);
  const meanOf = (xs) => (xs.length ? xs.reduce((a, x) => a + x.rate, 0) / xs.length : null);
  const headMean = meanOf(headThird);
  const tailMean = meanOf(tailThird);
  // 判据：后段不得比前段高出一个 WARN 线相对量（用绝对差，避免小基数放大）。
  // 门槛 GRAM3_TREND_DELTA = WARN 线的一半：12% → 6 个百分点。
  const trendDelta = (headMean !== null && tailMean !== null) ? tailMean - headMean : null;
  const trendGate = TH.REPEAT_LOCAL_WARN * 0.5;
  add(
    'repeat_local_trend',
    `后 1/3 的局部重复率不得比前 1/3 高出 ${(trendGate * 100).toFixed(0)} 个百分点（D7：看是否在恶化）`,
    trendDelta === null
      ? 'WARN'
      : trendDelta > trendGate ? 'FAIL' : trendDelta > trendGate * 0.5 ? 'WARN' : 'PASS',
    trendDelta === null
      ? '样本不足'
      : `前 1/3 ${(headMean * 100).toFixed(1)}%（t${headThird[0].turn_no}–t${headThird[headThird.length - 1].turn_no}）` +
        ` → 后 1/3 ${(tailMean * 100).toFixed(1)}%（t${tailThird[0].turn_no}–t${tailThird[tailThird.length - 1].turn_no}）` +
        `｜差 ${(trendDelta * 100).toFixed(1)} 个百分点` +
        (trendDelta > trendGate ? '｜**在恶化**' : trendDelta < -trendGate * 0.5 ? '｜在后段改善' : '｜持平')
  )
  report.quality.repeat_trend = {
    thirds: trendN,
    head: { mean: headMean, rows: headThird },
    tail: { mean: tailMean, rows: tailThird },
    delta: trendDelta,
    gate: trendGate,
    note: 'D7 第 1 条。p90 看「最差有多差」，本项看「是否在恶化」——长跑真正要防的是后者。'
      + '用绝对差而不是比值，避免小基数（前段 2% → 后段 4%）把恶化放大成 100%。',
  };

  // 7.6 死亡表述 vs life_state 写入
  // 口径改过两次，最终只认确定性信号，不再用「死亡表述轮次 vs 写入行数」的比例：
  //   ① 正文死亡词是**叙述用语**（死寂/死的凉/跪死/该死了），与「谁死了」无确定关系，
  //      比例判据在 30 拍样本上只会产出误报（实测 16 轮 → 去噪后 5 轮，且无一是角色死亡）；
  //   ② 真正可证伪的是「写了 gone/dead 的人，后文还能不能上场」——用 present 名单交叉。
  let lifeStatus = 'PASS';
  let lifeDetail =
    `dead/gone 写入 ${deadWrites} 行｜正文死亡用语 ${deathTurns.length} 轮（仅叙述用语，不作判据）` +
    `｜离场后仍被提名 ${lifeLeaks.length} 例`;
  // D32：两套存储分裂的直接证据。只在 world_state 里出现的 gone/dead 一定来自 changes 路径，
  // 修复前回程通道（读 character_states）对它完全失效。非 0 说明这局跑在 D32 之前。
  if (lifeOnlyWorldState.length > 0) {
    lifeStatus = 'WARN';
    lifeDetail += `｜两套存储分裂 ${lifeOnlyWorldState.length} 行（只写进 world_state、没进 character_states` +
      ` → 回程通道看不见：${lifeOnlyWorldState.map((x) => `${x.who}@t${Number(x.valid_from)}`).join(' ')}` +
      '）；D32 起 changes 的 life_state 会同时写两张表，非 0 说明这局跑在修复前';
  }
  if (lifeFatal.length > 0) {
    lifeStatus = 'FAIL';
    lifeDetail += `｜离场后仍在场：${lifeFatal.map((x) => `${x.who}(${x.value}@t${x.from}${x.valid_to == null ? '' : `-t${x.valid_to}`}→t${x.in_present.join(',')})`).join(' · ')}（§13.22）`;
  } else if (lifeReviveMissing.length > 0) {
    // D10/D22：玩家点名要见这个人、或史官给她写了在场态（她在正文里说话做事），
    // 但代码仍按 gone 把她从在场剔除 —— 机制没跟上正文。
    lifeStatus = 'FAIL';
    lifeDetail += `｜离场后仍在镜头里：${lifeReviveMissing.map((x) =>
      `${x.who}(${x.value}@t${x.from})→玩家点名 t${x.named_by_player.join(',')}、正文 t${x.turns.join(',')}，但 present 一直没有她`
    ).join(' · ')}` +
      '｜机制没跟上正文：gone 被当成永别，没有回程通道（D10）' +
      (lifeOnlyWorldState.length > 0
        ? `｜根因见 D32：${lifeOnlyWorldState.length} 行 gone/dead 只写进 world_state，`
          + '回程通道（读 character_states）对它们完全失效；这条 FAIL 是修复前的存量数据'
        : '');
  } else if (lifeLeaks.length > 0) {
    lifeStatus = 'WARN';
    lifeDetail += `｜${lifeLeaks.map((x) => {
      const why = x.named_by_player.length
        ? `只在正文里被提到（玩家点名 t${x.named_by_player.join(',')}）`
        : '只在正文里被提到（对白/心里想）';
      return `${x.who}(${x.value}@t${x.from}${x.valid_to == null ? '' : `-t${x.valid_to}`})→正文 t${x.turns.join(',')}，但不在 present 名单（${why}）`;
    }).join(' · ')}`;
  }
  add('life_state_consistency', '离场/死亡角色不得再上场（present 名单交叉，非比例判据）', lifeStatus, lifeDetail);

  // 7.6b 主角不得被判离场（D14）
  // 与 life_state_consistency 分开：那条管「配角走了又上场」，这条管「主角被删掉了」。
  // 两者机制不同（前者是 gone 无回程，后者是 player.life_state 没有消费方却仍被 lint 读到）。
  {
    const pa = report.memory.player_absentees;
    const paStatus = !pa.known ? 'SKIP' : pa.turns.length ? 'FAIL' : 'PASS';
    const paDetail = !pa.known
      ? '装配层没有 scene_sheet 记录（旧会话或未装探针），无法判定\n'
      : pa.turns.length
        ? `主角 ${pa.player_names.join('/')} 在 t${pa.turns.join(',')} 被列进 absentees —— 他从自己的场记单里消失了，而正文仍是第一人称。`
          + '成因：史官写了 player/player 的 life_state=gone，lint-state 读到就剔出 present（D14）。'
        : `主角 ${pa.player_names.join('/') || '(未知)'} 从未被剔出在场（${absenteesRows.length} 拍有 absentees，均不含主角）`;
    add('player_not_absent', '主角不得被判离场（D14）', paStatus, paDetail);
  }

  // 7.7 封场与时间推进
  add(
    'scene_closure',
    `场景数 ≥ ${TH.SCENE_MIN}（长跑必须真的封过场）`,
    sceneRows.length >= TH.SCENE_MIN ? 'PASS' : 'FAIL',
    `scenes=${sceneRows.length}`
  );
  let whenStatus = 'PASS';
  // 回合粒度是说人话的那个数（「世界有没有往前走」）；场次粒度只是它的粗采样，
  // 保留在明细里做对照，不参与判定。
  if (whenTurnChanges < TH.WHEN_CHANGE_MIN) {
    whenStatus = whenTurnSeq.length >= TH.WHEN_TURN_MIN ? 'FAIL' : 'WARN';
  }
  add(
    'time_progression',
    `时间标签变化 ≥ ${TH.WHEN_CHANGE_MIN} 次`,
    whenStatus,
    `回合粒度变化 ${whenTurnChanges} 次 / ${whenTurnSeq.length} 拍（${whenTurnSeq[0] || '—'} → ${whenTurnSeq[whenTurnSeq.length - 1] || '—'}）`
    + `｜场次粒度 ${whenChanges} 次 / ${sceneRows.length} 场`
    + (whenStatus === 'WARN' ? '｜拍数不足，无法产生 3 次变化（样本不足）' : '')
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

  // 7.9c 空正文回合（静默落库的空拍）
  // 判据只看**落库正文长度 == 0**，不看 `narration.fallback`——后者是「重试过」的痕迹。
  // 主库 146 拍里 7 次重试全部救回；把 fallback 当失败会把自愈报成缺陷（给合格发缺陷通知）。
  //
  // D31 之后这条判据在**新会话**上应当恒为 PASS：重试仍空的回合不再落库（整拍回滚），
  // 所以旧会话里能查到空正文行 = 修复前的存量。两者要分开报，否则「0/44」既可能是
  // 修好了、也可能只是这一局没撞上。
  add(
    'empty_narration',
    '没有静默落库的空正文回合',
    emptyTurns.length === 0 ? 'PASS' : 'FAIL',
    emptyTurns.length === 0
      ? `${narr.length} 拍全部有正文`
        + (retriedHealedTurns.length
          ? `｜其中 ${retriedHealedTurns.length} 拍（t${retriedHealedTurns.join(',')}）首次为空、关推理重试后救回`
          : '')
      : `${emptyTurns.length}/${narr.length} 拍正文为空：`
        + emptyTurns.map((e) => `t${e.turn_no}(ct=${num(e.completion_tokens)}${e.retried ? ',首次也空' : ''}${e.fed_into_next ? ',已进下一拍上下文' : ''})`).join(' ')
        + '｜成因：上游只产出 reasoning、content 为空；重试一次仍空后落库 content=\'\'。'
        + '影响：该拍进入字数统计与重复率分母，并以空 assistant 消息进入下一拍 recent 层；下游记账拿到空正文、这一拍的玩家行动等于没发生。'
        + '｜D31 起这类回合整拍回滚、不再落库，所以本项非 0 说明这局跑在修复前'
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
  //
  // 两个口径同时给：按事件（沿用阈值）与按正文拍（点中 ≥1 个可外泄事件的正文拍）。
  // 前者会被单拍放大——一条正文拍一次点名 5 个事件就贡献 5，长跑实测见过
  // 63.2%(事件) vs 11.1%(正文拍) 的差，读起来像「世界呼吸被读了一半」，实际是
  // 结尾两拍把几个名字一起写进去了。差得远时明写在 detail 里，别让人只看前一个数。
  const offRate = offstageVisible ? offstageCited / offstageVisible : null;
  const offTurnRate = narr.length ? offstageCitedBodyTurns.size / narr.length : null;
  const offInflation = offRate !== null && offTurnRate !== null && offTurnRate > 0 && offRate >= offTurnRate * 2;
  add(
    'offstage_cited',
    `场外事件（rumor/public）被后文点名 ≥ ${(TH.OFFSTAGE_CITE_MIN * 100).toFixed(0)}%`,
    offRate === null ? 'WARN' : offRate >= TH.OFFSTAGE_CITE_MIN ? 'PASS' : 'WARN',
    offRate === null
      ? '没有可进提示词的 offstage_event'
      : `${offstageCited}/${offstageVisible}（${pct(offstageCited, offstageVisible)}）` +
        `｜按正文拍 ${offstageCitedBodyTurns.size}/${narr.length}（${pct(offstageCitedBodyTurns.size, narr.length)}）` +
        (offInflation ? ' ⚠ 两个口径差 ≥2×：是少数拍一次点名多个事件放大的，不是引用面真的这么宽' : '') +
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
