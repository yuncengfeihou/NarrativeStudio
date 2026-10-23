/**
 * server/memory/compressor.js — 层级压缩调度器
 *
 * 触发节奏（由 config.context 控制）：
 *   L1 → L2 ：每 arcEvery 轮，把 [turnNo-arcEvery+1, turnNo] 的 L1 摘要压成 1 条 L2
 *   L2 → L3 ：未归档 L2 数量 ≥ sagaEvery 且最近 sagaEvery 条连续时压成 1 条 L3
 *   L3 → L4 ：未归档 L3 数量 ≥ chronicleEvery 且最近 chronicleEvery 条连续时压成 1 条 L4
 *
 * 幂等：每一级都带「目标范围是否已被更高层覆盖」的前置检查，
 *       同一 turnNo 重复调用不会产生重复摘要。
 *
 * 健壮性：任何失败（LLM 报错、返回空、DB 异常）都被捕获并返回
 *   {created: [], archived: 0, error: msg}，绝不抛出 —— 压缩失败不阻塞主流程。
 */
import { chat } from '../llm.js';
import { config } from '../config.js';
import { getLatestSummaries, getSummaries, addSummary, archiveSummaries } from './store.js';

/** 压缩专家的系统提示词（三层共用） */
const COMPRESSOR_SYSTEM_PROMPT =
  '你是剧情记忆压缩专家，把以下分段摘要合并为一段高密度连贯摘要，不丢失任何专有名词、数字、决定、关系变化和悬念。';

/** 各压缩层级的目标参数（maxTokens 已计入 low-effort 推理 ~3200 tok 的占用） */
const LEVEL_SPEC = {
  2: { sourceLevel: 1, name: '篇章（arc）摘要', maxTokens: 8000, target: '1200-1800 tok' },
  3: { sourceLevel: 2, name: '史诗（saga）摘要', maxTokens: 10000, target: '2000-3000 tok' },
  4: { sourceLevel: 3, name: '编年史（chronicle）', maxTokens: 14000, target: '4000-6000 tok' },
};

/**
 * 从按 turn_from 升序排列的同层摘要中，取出恰好铺满 [from, to] 的一段。
 * 要求无缺口、无重叠、不越界；任何不满足都返回 null。
 * @returns {Array|null}
 */
function collectTiling(rows, from, to) {
  const picked = [];
  let cursor = from;
  for (const r of rows) {
    if (r.turn_to < from || r.turn_from > to) continue;   // 与目标范围无交集
    if (r.turn_from !== cursor) return null;              // 有缺口或重叠
    if (r.turn_to > to) return null;                      // 越界（未对齐）
    picked.push(r);
    cursor = r.turn_to + 1;
    if (cursor > to) break;
  }
  return picked.length && cursor > to ? picked : null;
}

/** 目标范围是否已被某一条现存摘要完整覆盖（幂等闸门） */
function isRangeCovered(rows, from, to) {
  return rows.some(r => r.turn_from <= from && r.turn_to >= to);
}

/**
 * 调用 LLM 把 sourceRows 压缩成一条 level 级摘要，落库并归档源摘要。
 * @returns {Promise<{id:number, archived:number}>}
 */
async function compress(sessionId, sourceRows, level, from, to) {
  const spec = LEVEL_SPEC[level];
  const body = sourceRows
    .map(r => `【第${r.turn_from}-${r.turn_to}轮】\n${r.content}`)
    .join('\n\n');
  const userPrompt =
    `请把以下 ${sourceRows.length} 段 ${level - 1} 级分段摘要压缩为一条 ${level} 级${spec.name}，` +
    `覆盖回合范围：第 ${from}-${to} 轮，目标长度 ${spec.target}。\n` +
    `必须保留：所有实体名、关键数字与时间、重要决定、关系变化、物品得失、未解悬念。\n` +
    `直接输出压缩后的摘要正文，不要输出解释、标题或 JSON。\n\n${body}`;

  const { content } = await chat({
    messages: [
      { role: 'system', content: COMPRESSOR_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    reasoningEffort: 'low',
    temperature: 0.3,
    maxTokens: spec.maxTokens,
  });

  const summary = (content || '').trim();
  if (!summary) throw new Error(`L${level} 压缩结果为空`);

  const { id } = addSummary(sessionId, { level, turnFrom: from, turnTo: to, content: summary });
  archiveSummaries(sourceRows.map(r => r.id));
  return { id, archived: sourceRows.length };
}

/**
 * 检查并执行层级压缩（幂等，绝不抛出）。
 * @param {string} sessionId
 * @param {number} turnNo 刚完成记忆更新的回合号
 * @returns {Promise<{created:Array<{level:number,turn_from:number,turn_to:number}>, archived:number, error?:string}>}
 */
export async function checkCompression(sessionId, turnNo) {
  const created = [];
  let archived = 0;
  try {
    const { arcEvery, sagaEvery, chronicleEvery } = config.context;
    if (!Number.isInteger(turnNo) || turnNo <= 0) return { created, archived };
    if (arcEvery <= 0 || turnNo % arcEvery !== 0) return { created, archived };

    /* ---------------- L1 → L2（arc） ---------------- */
    const arcFrom = turnNo - arcEvery + 1;
    if (arcFrom >= 1) {
      const l1s = getSummaries(sessionId, { level: 1, archived: 0 });
      const picked = collectTiling(l1s, arcFrom, turnNo);
      // archived: null → 查全部 L2（含已归档），避免重复压缩同一范围
      const l2all = getSummaries(sessionId, { level: 2, archived: null });
      if (picked && !isRangeCovered(l2all, arcFrom, turnNo)) {
        const res = await compress(sessionId, picked, 2, arcFrom, turnNo);
        created.push({ level: 2, turn_from: arcFrom, turn_to: turnNo });
        archived += res.archived;
      }
    }

    /* ---------------- L2 → L3（saga） ---------------- */
    if (sagaEvery > 0) {
      const l2s = getLatestSummaries(sessionId, 2, sagaEvery);   // 未归档，按 turn_from 升序
      if (l2s.length >= sagaEvery) {
        const recent = l2s.slice(-sagaEvery);
        let contiguous = true;
        for (let i = 1; i < recent.length; i++) {
          if (recent[i].turn_from !== recent[i - 1].turn_to + 1) { contiguous = false; break; }
        }
        if (contiguous) {
          const from = recent[0].turn_from;
          const to = recent[recent.length - 1].turn_to;
          const l3all = getSummaries(sessionId, { level: 3, archived: null });
          if (!isRangeCovered(l3all, from, to)) {
            const res = await compress(sessionId, recent, 3, from, to);
            created.push({ level: 3, turn_from: from, turn_to: to });
            archived += res.archived;
          }
        }
      }
    }

    /* ---------------- L3 → L4（chronicle） ---------------- */
    if (chronicleEvery > 0) {
      const l3s = getLatestSummaries(sessionId, 3, chronicleEvery);
      if (l3s.length >= chronicleEvery) {
        const recent = l3s.slice(-chronicleEvery);
        let contiguous = true;
        for (let i = 1; i < recent.length; i++) {
          if (recent[i].turn_from !== recent[i - 1].turn_to + 1) { contiguous = false; break; }
        }
        if (contiguous) {
          const from = recent[0].turn_from;
          const to = recent[recent.length - 1].turn_to;
          const l4all = getSummaries(sessionId, { level: 4, archived: null });
          if (!isRangeCovered(l4all, from, to)) {
            const res = await compress(sessionId, recent, 4, from, to);
            created.push({ level: 4, turn_from: from, turn_to: to });
            archived += res.archived;
          }
        }
      }
    }

    return { created, archived };
  } catch (err) {
    // 压缩失败绝不阻塞主流程
    return { created: [], archived: 0, error: err?.message || String(err) };
  }
}
