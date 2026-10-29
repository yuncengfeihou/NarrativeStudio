#!/usr/bin/env node
/**
 * _work/scorecard.mjs — 把 `longrun-report.mjs --json` 的产出折算成 0–100 分
 *
 *   node _work/scorecard.mjs <session_id> [--db data/roleplay.db] [--json out.json]
 *
 * 为什么需要它：`longrun-report.mjs` 有 33 条判定项，每条只有 PASS/WARN/FAIL，
 * 回答不了「这一局比上一局好还是差」。但**不能把 PASS 条数当分数**——33 条里
 * 有 10 条是「样本不足就 PASS」，条数涨了不等于质量涨了（D7 的老教训）。
 *
 * 所以这里按**五个维度**各算一个 0–100 的分数，每个维度只用它自己的可复算指标，
 * 每项都写明公式与权重，任何一项都能手算核对。**维度分之间不加权成总分**：
 * 剧情质量和成本没有可比的量纲，合成一个数只会掩盖「分数好看但某一维塌了」。
 *
 * 打分原则（与长跑判定口径一致）：
 *   - 连续量用「越好越高」的线性/分段映射，不在阈值上做阶跃（阈值已经在报告里了）；
 *   - 分母固定的比率直接用 100×率；
 *   - 任何一项拿不到数据就**不给分**（记 null 并从分母里去掉），不按 0 算——
 *     把「没量到」当「量到 0」是本项目踩过最多的坑（D7/D30/D32 都是这个形状）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const sessionId = argv.find((a) => !a.startsWith('--'));
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const db = opt('db', 'data/roleplay.db');
const outJson = opt('json', '');

if (!sessionId) {
  console.error('用法: node _work/scorecard.mjs <session_id> [--db data/roleplay.db] [--json out.json]');
  process.exit(2);
}

/* 先让报告产出结构化 JSON（报告是唯一的数据来源，这里不再自己查库） */
const tmp = `_work/tmp-score-${sessionId.slice(0, 8)}.json`;
execFileSync(process.execPath, ['_work/longrun-report.mjs', sessionId, '--db', db, '--json', tmp], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
const r = JSON.parse(fs.readFileSync(tmp, 'utf8'));

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** 分段线性：points 是 [[x, y], ...]，x 递增。用来把「越低越好 / 越高越好」折成分。 */
function piecewise(x, points) {
  if (x === null) return null;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points[points.length - 1][1];
}
/** 一组子项求加权平均；null 的子项整条剔除（含权重）。 */
function blend(items) {
  const ok = items.filter((i) => i.score !== null);
  if (!ok.length) return { score: null, items };
  const w = ok.reduce((s, i) => s + i.weight, 0);
  const score = ok.reduce((s, i) => s + i.score * (i.weight / w), 0);
  return { score: Math.round(score * 10) / 10, items };
}

/* ───────────────────────── ① 剧情质量 ─────────────────────────
 * 只放「读正文就能验证」的东西：写得多长、重复多少、结尾是否公式化、
 * 玩家选的选项是不是每次都是同一类。**不放「好不好看」**——那个只能人读。
 */
const len = r.scale.chars;
const lenScore = piecewise(num(len.mean), [[600, 40], [900, 70], [1200, 90], [1450, 100], [2000, 100], [2600, 85]]);
const lenFloor = num(len.min) === null ? null : piecewise(num(len.min), [[300, 40], [700, 80], [1000, 100]]);
const outlier = num(len.len_outlier_ratio) === null ? null
  : piecewise(num(len.len_outlier_ratio), [[1.2, 100], [1.5, 95], [2.0, 85], [3.0, 70], [4.0, 50]]);
const rep = r.memory.repeat_local;
const repMean = num(rep?.stats?.mean);
const repP90 = num(rep?.stats?.p90);
const repScore = repP90 === null ? null
  : piecewise(repP90 * 100, [[0, 100], [5, 95], [8, 85], [12, 70], [16, 50], [22, 25]]);
const gram3P90 = num(r.memory.gram3?.stats?.p90);
const gram3Score = gram3P90 === null ? null
  : piecewise(gram3P90 * 100, [[0, 100], [30, 90], [45, 75], [55, 55], [70, 30]]);
const endings = r.quality.endings;
const endingScore = num(endings?.formulaic_rate) === null ? null
  : 100 - 100 * clamp(num(endings.formulaic_rate) / 0.25, 0, 1) * 0.85;
const tones = num(r.quality.distinct_tones);
const toneScore = tones === null ? null : piecewise(tones, [[1, 30], [3, 65], [5, 90], [6, 100], [7, 100]]);
const optCount = num(r.quality.branch_options?.avg_desc_chars);
const optScore = optCount === null ? null : piecewise(optCount, [[20, 40], [45, 75], [60, 92], [70, 100], [110, 95]]);
const emptyOpt = num(r.quality.branch_options?.empty_turns?.length);
const emptyOptScore = emptyOpt === null ? null : piecewise(emptyOpt, [[0, 100], [1, 85], [3, 60], [6, 30]]);

const quality = blend([
  { key: '正文均长', weight: 2.0, score: lenScore, raw: len.mean, unit: '字/拍', note: '600 字以下偏薄，1450 上下最好（本卡实测区间）' },
  { key: '最短一拍', weight: 0.8, score: lenFloor, raw: len.min, unit: '字', note: '有 300 字以下的一拍就是「敷衍了一拍」' },
  { key: '长度离群', weight: 0.8, score: outlier, raw: len.len_outlier_ratio, unit: 'max/p50', note: '单拍暴涨超过 3 倍会让节奏断掉' },
  { key: '局部重复均值', weight: 1.4, score: repMean === null ? null : piecewise(repMean * 100, [[0, 100], [4, 95], [6, 85], [9, 70], [14, 45]]), raw: repMean === null ? null : Math.round(repMean * 1000) / 10, unit: '%', note: '5-gram vs 前 3 轮' },
  { key: '局部重复 p90', weight: 1.4, score: repScore, raw: repP90 === null ? null : Math.round(repP90 * 1000) / 10, unit: '%', note: '尖峰比均值更能说明「有一拍在套模板」' },
  { key: '累积 3-gram', weight: 0.6, score: gram3Score, raw: gram3P90 === null ? null : Math.round(gram3P90 * 1000) / 10, unit: '%', note: '随轮数必然上涨，只作参考' },
  { key: '结尾公式化', weight: 1.0, score: endingScore, raw: endings?.formulaic_rate === undefined ? null : Math.round(endings.formulaic_rate * 1000) / 10, unit: '%', note: '「必须…了 / 该…了」型收尾' },
  { key: '走向 tone 覆盖', weight: 1.0, score: toneScore, raw: tones, unit: '种', note: '全局能给出几种不同气质的选项' },
  { key: '选项描述均长', weight: 0.8, score: optScore, raw: optCount, unit: '字', note: '太短=空话，太长=替玩家写' },
  { key: '选项缺失拍', weight: 0.8, score: emptyOptScore, raw: emptyOpt, unit: '拍', note: '走向 Agent 降级/超时的次数' },
]);

/* ───────────────────────── ② 记忆一致性 ─────────────────────────
 * 这一维最重要，所以权重也最重。核心是「说过的和记住的是不是同一件事」。
 */
const facts = r.budget.sql_truncation?.last?.assertions;
const factKeep = facts && facts.loaded ? num(facts.rendered) / num(facts.loaded) : null;
const factScore = factKeep === null ? null : 100 * clamp(factKeep, 0, 1);
const life = r.memory.life_state;
const lifeDist = life?.distribution || [];
const lifeKnown = lifeDist.reduce((s, d) => s + d.n, 0);
// 「生死状态有三种以上取值」说明这套机制真的在被用，不是恒等于 alive
const lifeUsed = new Set(lifeDist.filter((d) => d.n > 0).map((d) => d.value)).size;
const lifeScore = lifeKnown ? piecewise(lifeUsed, [[1, 60], [2, 85], [3, 100]]) : null;
const lifeCheck = r.checks.find((c) => c.id === 'life_state_consistency');
const lifeCheckScore = lifeCheck ? { PASS: 100, WARN: 70, FAIL: 25, INFO: null }[lifeCheck.status] ?? null : null;
const orphanChk = r.checks.find((c) => c.id === 'orphan_player_turns');
const orphanScore = orphanChk ? { PASS: 100, WARN: 60, FAIL: 20 }[orphanChk.status] ?? null : null;
const emptyChk = r.checks.find((c) => c.id === 'empty_narration');
const emptyScore = emptyChk ? { PASS: 100, WARN: 60, FAIL: 20 }[emptyChk.status] ?? null : null;
const cont = r.memory.continuity;
const contOpen = num(cont?.major_open);
const contScore = contOpen === null ? null : piecewise(contOpen, [[0, 100], [1, 85], [2, 70], [4, 45], [8, 20]]);
const contFixRate = (() => {
  const rows = cont?.rows || [];
  const withFix = rows.filter((x) => x.fix && x.fix !== 'none');
  if (!withFix.length) return null;
  const done = withFix.filter((x) => x.fix_state !== 'unmatched' && x.fix_state !== 'failed');
  return done.length / withFix.length;
})();
const contFixScore = contFixRate === null ? null : 100 * contFixRate;
const targetRej = num(r.memory.skipped_targets?.items);
const targetScore = targetRej === null ? null : piecewise(targetRej, [[0, 100], [2, 90], [5, 75], [10, 55], [20, 30]]);
const rejected = num(r.memory.rejected_delta?.n);
const rejectedScore = rejected === null ? null : piecewise(rejected, [[0, 100], [1, 60], [3, 25]]);
const threadRej = num(r.memory.thread_rejected?.patches);
const threadScore = threadRej === null ? null : piecewise(threadRej, [[0, 100], [2, 85], [5, 60], [10, 35]]);
const coverage = r.budget.coverage;
const seamOk = coverage && coverage.rows?.length
  ? coverage.rows.filter((x) => x.ok).length / coverage.rows.length : null;
const seamScore = seamOk === null ? null : 100 * seamOk;
const sceneGaps = num(r.memory.scene_gaps?.length);
const sceneGapScore = sceneGaps === null ? null : (sceneGaps === 0 ? 100 : Math.max(0, 100 - sceneGaps * 25));
const stateFix = num(r.memory.state_fixes?.n);
const stateFixScore = stateFix === null ? null : piecewise(stateFix, [[0, 100], [3, 85], [8, 65], [15, 40]]);

const memory = blend([
  { key: '断言可见率', weight: 2.0, score: factScore, raw: factKeep === null ? null : Math.round(factKeep * 1000) / 10, unit: '%', note: '渲染/装载：D9 之后应当接近 100%' },
  { key: '生死状态被用到', weight: 1.0, score: lifeScore, raw: lifeUsed, unit: '种取值', note: '三种取值都在用 = 这套机制是活的' },
  { key: 'D32 双表一致', weight: 2.0, score: lifeCheckScore, raw: lifeCheck?.status, unit: '', note: 'life_state 投影与记忆表是否分裂' },
  { key: '孤儿回合', weight: 1.5, score: orphanScore, raw: orphanChk?.status, unit: '', note: '玩家行动落库但正文没产出' },
  { key: '空正文落库', weight: 1.5, score: emptyScore, raw: emptyChk?.status, unit: '', note: 'D31 之后应当为 0' },
  { key: '校勘 major 挂 open', weight: 1.2, score: contScore, raw: contOpen, unit: '条', note: '报出来却没人处理的不一致' },
  { key: '校勘 fix 执行率', weight: 1.0, score: contFixScore, raw: contFixRate === null ? null : Math.round(contFixRate * 100), unit: '%', note: 'D12/D29 之后应当接近 100%' },
  { key: '目标声明拦下', weight: 0.8, score: targetScore, raw: targetRej, unit: '条', note: '被合法目标校验挡住的写入' },
  { key: '数值增量被拒', weight: 0.8, score: rejectedScore, raw: rejected, unit: '条', note: 'D11 之后应当为 0' },
  { key: '线索被拒', weight: 0.6, score: threadScore, raw: threadRej, unit: '条', note: 'WIP 上限挡下的线索提案' },
  { key: '场次接缝', weight: 1.5, score: seamScore, raw: seamOk === null ? null : Math.round(seamOk * 1000) / 10, unit: '%', note: '场次区间与原文窗口无洞无重叠' },
  { key: '场次空洞', weight: 1.2, score: sceneGapScore, raw: sceneGaps, unit: '处', note: '两场之间漏掉的拍' },
  { key: 'lint 干预', weight: 0.6, score: stateFixScore, raw: stateFix, unit: '次', note: '渲染前确定性体检改了在场名单' },
]);

/* ───────────────────────── ③ 上下文效率 ─────────────────────────
 * 这个维度回答「花掉的 token 有多少真的用上了」。
 */
const budget = r.budget;
const slope = num(budget.slope_per_turn);
const slopeScore = slope === null ? null : piecewise(slope, [[0, 60], [40, 100], [120, 95], [200, 80], [350, 55], [600, 30]]);
const peak = num(budget.peak?.total);
const plan = budget.plan || {};
const softMax = num(plan.soft_max);
const peakRatio = peak !== null && softMax ? peak / softMax : null;
const peakScore = peakRatio === null ? null : piecewise(peakRatio * 100, [[20, 70], [40, 95], [60, 100], [85, 90], [100, 60]]);
const index = budget.index || [];
const indexFull = index.length ? index.filter((x) => x.dropped === 0 && x.rendered === x.total).length / index.length : null;
const indexScore = indexFull === null ? null : 100 * indexFull;
const degraded = budget.degraded || [];
const degradeRate = index.length ? degraded.length / index.length : null;
const degradeScore = degradeRate === null ? null : piecewise(degradeRate * 100, [[0, 100], [2, 90], [10, 60], [25, 30]]);
const mention = r.mention;
const mentionHit = num(mention?.hit);
const mentionScore = mentionHit === null ? null : piecewise(mentionHit, [[0, 40], [15, 70], [25, 90], [35, 100], [60, 95]]);
const persons = mention?.tiers;
const highTier = persons?.high?.total ? persons.high.hit / persons.high.total : null;
const highScore = highTier === null ? null : 100 * clamp(highTier, 0, 1);
const rel = budget.sql_truncation?.last?.relations;
const relServe = rel && rel.loaded ? num(rel.rendered) / num(rel.loaded) : null;
const relScore = relServe === null ? null : 100 * clamp(mathMin(relServe / 0.6, 1), 0, 1);
const branchSheet = r.memory.branch_sheet;
const sheetSaved = num(branchSheet?.saved_rate);
const sheetScore = sheetSaved === null ? null : piecewise(sheetSaved * 100, [[0, 40], [10, 75], [25, 100], [45, 100], [70, 70]]);
const codex = r.memory.codex;
const codexFull = codex?.full_candidates ? codex.full_rendered / codex.full_candidates : null;
const codexScore = codexFull === null ? null : 100 * clamp(codexFull, 0, 1);
const ret = r.retrieval;
const retHit = num(ret?.history_hit_rate);
const retScore = retHit === null ? null : piecewise(retHit * 100, [[0, 40], [10, 70], [25, 95], [40, 100]]);
const selfEcho = num(ret?.self_echo_rate);
const echoScore = selfEcho === null ? null : piecewise(selfEcho * 100, [[0, 100], [15, 90], [35, 70], [60, 40], [80, 20]]);

function mathMin(a, b) { return Math.min(a, b); }

const context = blend([
  { key: '预算斜率', weight: 1.2, score: slopeScore, raw: slope === null ? null : Math.round(slope * 10) / 10, unit: 'tok/轮', note: '正交增长最好；太平说明没记东西，太陡说明早期就要撞墙' },
  { key: '峰值占软目标', weight: 1.0, score: peakScore, raw: peakRatio === null ? null : Math.round(peakRatio * 1000) / 10, unit: '%', note: '离软目标太近 = 长一点就降级' },
  { key: '世界索引完整', weight: 1.4, score: indexScore, raw: indexFull === null ? null : Math.round(indexFull * 1000) / 10, unit: '% 轮次', note: '310 个实体一个没丢' },
  { key: '降级轮次', weight: 1.2, score: degradeScore, raw: degradeRate === null ? null : Math.round(degradeRate * 1000) / 10, unit: '%', note: '软目标收窄过的轮次' },
  { key: '叙事覆盖率', weight: 1.0, score: mentionScore, raw: mentionHit, unit: '/310 实体', note: '卡里有多少实体真在正文出现过' },
  { key: '主线人物覆盖率', weight: 1.2, score: highScore, raw: highTier === null ? null : Math.round(highTier * 1000) / 10, unit: '%', note: 'weight≥0.8 的人物用上多少' },
  { key: '关系渲染率', weight: 0.8, score: relScore, raw: relServe === null ? null : Math.round(relServe * 1000) / 10, unit: '%', note: '装载的关系里渲染了多少' },
  { key: '场记单裁剪', weight: 0.8, score: sheetScore, raw: sheetSaved === null ? null : Math.round(sheetSaved * 1000) / 10, unit: '% 节省', note: 'D26-B：走向 Agent 那份单子省了多少' },
  { key: '辞书全文渲染', weight: 0.8, score: codexScore, raw: codexFull === null ? null : Math.round(codexFull * 1000) / 10, unit: '%', note: '候选里真正塞进去的比例' },
  { key: '历史检索命中', weight: 0.8, score: retScore, raw: retHit === null ? null : Math.round(retHit * 1000) / 10, unit: '%', note: '查了历史且查到东西的轮次' },
  { key: '自问自答率', weight: 0.8, score: echoScore, raw: selfEcho === null ? null : Math.round(selfEcho * 1000) / 10, unit: '%', note: '查的词就是玩家刚说的话（D4 下界应当压住它）' },
]);

/* ───────────────────────── ④ 稳定性 ─────────────────────────
 * 「同样的输入会不会得到同样的上下文」——缓存与冻结前缀。
 */
const cache = r.cache;
const sysHash = cache?.system_hash;
const frozen = sysHash && num(sysHash.unique_count) === 1 && num(sysHash.turns_with_hash) > 0;
const frozenScore = frozen === null ? null : (frozen ? 100 : 40);
const rewrite = num(cache?.broken?.real_break_rewrite);
const rewriteScore = rewrite === null ? null : (rewrite === 0 ? 100 : Math.max(0, 100 - rewrite * 15));
const prefixRate = num(cache?.prefix_shared_rate?.mean);
const prefixScore = prefixRate === null ? null : piecewise(prefixRate * 100, [[20, 40], [40, 75], [55, 100], [70, 100], [85, 85]]);
const upRate = num(cache?.upstream?.session_rate);
const upScore = upRate === null ? null : piecewise(upRate * 100, [[0, 50], [10, 70], [20, 85], [35, 100], [60, 95]]);
const cacheChk = r.checks.find((c) => c.id === 'cache_prefix_reuse');
const cacheChkScore = cacheChk ? { PASS: 100, WARN: 70, FAIL: 30 }[cacheChk.status] ?? null : null;
const degradedChk = r.checks.find((c) => c.id === 'degraded_rate');
const degradeChkScore = degradedChk ? { PASS: 100, WARN: 65, FAIL: 25 }[degradedChk.status] ?? null : null;
const scaled = r.sample;
const isLong = scaled?.is_long_run;

const stability = blend([
  { key: 'system 逐字节冻结', weight: 1.6, score: frozenScore, raw: sysHash ? `${sysHash.unique_count} 种 hash` : null, unit: '', note: 'D6 的硬约束：会话内 system 必须完全一致' },
  { key: '真改写断点', weight: 1.4, score: rewriteScore, raw: rewrite, unit: '轮', note: '同一位置被改写=整个前缀重算，应为 0' },
  { key: '前缀共享率', weight: 1.2, score: prefixScore, raw: prefixRate === null ? null : Math.round(prefixRate * 1000) / 10, unit: '%', note: '本地估算的可复用前缀比例' },
  { key: '上游真实命中', weight: 0.8, score: upScore, raw: upRate === null ? null : Math.round(upRate * 1000) / 10, unit: '%', note: '上游实际吃到缓存的比例（路由抽签，不完全可控）' },
  { key: '前缀判据', weight: 1.0, score: cacheChkScore, raw: cacheChk?.status, unit: '', note: '报告里那条综合判定' },
  { key: '无降级处置', weight: 0.8, score: degradeChkScore, raw: degradedChk?.status, unit: '', note: '硬上限收窄/拒跑的次数' },
]);

/* ───────────────────────── ⑤ 成本 ─────────────────────────
 * 分数越高越省。分母是「每拍成本」，因为局长短了成本自然低，不可比。
 */
const usage = r.usage;
const per = usage?.per_turn || {};
const promptPerTurn = num(per.prompt_tokens);
const promptScore = promptPerTurn === null ? null : piecewise(promptPerTurn, [[8000, 100], [20000, 90], [35000, 75], [50000, 55], [80000, 30]]);
const compPerTurn = num(per.completion_tokens);
const compScore = compPerTurn === null ? null : piecewise(compPerTurn, [[4000, 100], [12000, 90], [20000, 75], [30000, 55], [50000, 30]]);
const wallPerTurn = num(per.total_ms);
const wallScore = wallPerTurn === null ? null : piecewise(wallPerTurn / 1000, [[60, 100], [120, 95], [200, 80], [300, 60], [450, 35]]);
const reqPerTurn = num(per.requests);
const reqScore = reqPerTurn === null ? null : piecewise(reqPerTurn, [[1, 100], [3, 95], [4.5, 85], [6, 70], [9, 45]]);
const cacheRate = num(usage?.session?.cache_rate);
const cacheRateScore = cacheRate === null ? null : piecewise(cacheRate * 100, [[0, 50], [10, 65], [20, 85], [35, 100], [55, 95]]);

const cost = blend([
  { key: '每拍 prompt', weight: 1.4, score: promptScore, raw: promptPerTurn === null ? null : Math.round(promptPerTurn), unit: 'tok', note: '所有 Agent 加起来每拍送进模型多少' },
  { key: '每拍 completion', weight: 1.2, score: compScore, raw: compPerTurn === null ? null : Math.round(compPerTurn), unit: 'tok', note: '推理也计入，所以推理强度直接影响这一项' },
  { key: '每拍墙钟', weight: 1.2, score: wallScore, raw: wallPerTurn === null ? null : Math.round(wallPerTurn / 1000), unit: 's', note: '用户实际等多久' },
  { key: '每拍请求数', weight: 0.8, score: reqScore, raw: reqPerTurn === null ? null : Math.round(reqPerTurn * 100) / 100, unit: '次', note: '旁路 Agent 调用密度' },
  { key: '会话缓存命中', weight: 0.8, score: cacheRateScore, raw: cacheRate === null ? null : Math.round(cacheRate * 1000) / 10, unit: '%', note: '整体（含旁路 Agent）' },
]);

/* ───────────────────────── 输出 ───────────────────────── */
const bar = (v) => {
  if (v === null) return '  —  ';
  const n = Math.round(v / 5);
  return `${'█'.repeat(n)}${'░'.repeat(20 - n)}`;
};
const fmt = (v) => (v === null ? '  — ' : String(v).padStart(5));

const dims = [
  ['剧情质量', quality, '写得多厚、重复多少、选项够不够多样'],
  ['记忆一致性', memory, '说过的和记住的是不是同一件事'],
  ['上下文效率', context, '花掉的 token 有多少真用上了'],
  ['稳定性', stability, '同样的输入会不会得到同样的上下文'],
  ['成本', cost, '每拍花多少 token / 多少时间（越高越省）'],
];

console.log(`\n════════════ 指标打分卡 ════════════`);
console.log(`会话    ${sessionId}`);
console.log(`标题    ${r.scale.session?.title || '(无)'}`);
console.log(`样本    ${r.sample?.narrator_turns} 拍（${r.sample?.is_long_run ? '长跑口径' : '短会话口径，分数仅供参考'}）`);
console.log(`判定    ${r.verdict} (PASS ${r.tally.PASS} / WARN ${r.tally.WARN} / FAIL ${r.tally.FAIL})`);

console.log(`\n──── 五维总分 ────`);
for (const [name, d, desc] of dims) {
  console.log(`${name.padEnd(7)} ${fmt(d.score)}  ${bar(d.score)}  ${d.score === null ? '（无数据）' : ''}`);
  console.log(`${' '.repeat(8)}${desc}`);
}

for (const [name, d] of dims) {
  console.log(`\n──── ${name}（${d.score ?? '—'}）明细 ────`);
  for (const it of d.items) {
    const sc = it.score === null ? '  — ' : String(Math.round(it.score)).padStart(4);
    const raw = it.raw === null || it.raw === undefined ? '—' : `${it.raw}${it.unit || ''}`;
    console.log(`  ${sc}  w=${String(it.weight).padEnd(4)} ${it.key.padEnd(16)} 实测 ${String(raw).padEnd(14)} ${it.note || ''}`);
  }
}

const missing = dims.flatMap(([n, d]) => d.items.filter((i) => i.score === null).map((i) => `${n}/${i.key}`));
if (missing.length) console.log(`\n未取到数据（已从加权平均里剔除，未按 0 计）：${missing.join('、')}`);

console.log(`\n──── 原始指标速览 ────`);
console.log(`正文      ${len.total} 字 / ${len.n} 拍｜均 ${Math.round(len.mean)}｜p50 ${len.p50}｜min ${len.min}｜max ${len.max}`);
console.log(`重复      局部 5-gram 均 ${(repMean ?? 0).toFixed(1)}% / p90 ${(repP90 ?? 0).toFixed(1)}%｜3-gram p90 ${(gram3P90 ?? 0).toFixed(1)}%`);
console.log(`记忆      断言 ${r.memory.assertions?.map((a) => `${a.status}=${a.n}`).join(' ')}｜线索 ${r.memory.threads?.map((t) => `${t.status}=${t.n}`).join(' ')}｜场次 ${r.scale.scenes?.count}`);
console.log(`一致性    校勘 ${cont?.total} 条（major ${cont?.major}｜挂 open ${cont?.major_open}）｜目标拦下 ${r.memory.skipped_targets?.items}｜孤儿 ${orphanChk?.detail?.slice(0, 30) ?? '—'}`);
console.log(`上下文    斜率 ${Math.round(slope ?? 0)} tok/轮｜峰值 ${peak}｜索引 ${(indexFull ?? 0) * 100 | 0}% 轮完整｜覆盖 ${mentionHit ?? '—'}/310`);
console.log(`缓存      前缀共享 ${Math.round((prefixRate ?? 0) * 1000) / 10}%｜上游命中 ${Math.round((upRate ?? 0) * 1000) / 10}%｜真改写 ${rewrite}`);
console.log(`用量      ${usage?.session?.requests} 请求｜prompt ${usage?.session?.prompt_tokens}｜completion ${usage?.session?.completion_tokens}｜墙钟 ${Math.round((usage?.session?.total_ms ?? 0) / 1000)}s`);

const payload = {
  generated_at: new Date().toISOString(),
  session_id: sessionId,
  db,
  verdict: r.verdict,
  tally: r.tally,
  sample: r.sample,
  dimensions: Object.fromEntries(dims.map(([n, d]) => [n, { score: d.score, items: d.items }])),
  raw: {
    chars: len, repeat_local: rep, gram3_p90: gram3P90, continuity: { total: cont?.total, major: cont?.major, major_open: cont?.major_open },
    assertions: r.memory.assertions, threads: r.memory.threads, scenes: r.scale.scenes?.count,
    budget: { slope, peak, plan, index_full_rate: indexFull, degraded_turns: degraded.length },
    mention: { hit: mentionHit, total: mention?.total, tiers: mention?.tiers },
    cache: { prefix_shared_rate: prefixRate, upstream_hit_rate: upRate, real_break_rewrite: rewrite },
    usage: usage?.session, per_turn: per,
  },
};
if (outJson) {
  fs.writeFileSync(outJson, JSON.stringify(payload, null, 2));
  console.log(`\nJSON  ${outJson}`);
}
try { fs.unlinkSync(tmp); } catch { /* 临时文件清不掉不影响结果 */ }
