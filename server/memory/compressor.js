/**
 * server/memory/compressor.js — 层级压缩调度器
 *
 * L1（轮）→ L2（幕）→ L3（卷）→ L4（编年）
 *
 * 触发节奏由 config.context 控制：
 *   arcEvery=6      每 6 条未归档 L1 → 1 条 L2
 *   sagaEvery=4     每 4 条连续 L2 → 1 条 L3
 *   chronicleEvery=4 每 4 条连续 L3 → 1 条 L4
 *
 * 幂等：每级都先查「目标范围是否已被更高层覆盖」，重复调用不产生重复摘要。
 * 健壮：任何失败都被吞掉并返回 {created:[], archived:0, error}，绝不阻塞主流程。
 */
import { chat } from '../llm.js';
import { config } from '../config.js';
import { addSummary, archiveSummaries, getLatestSummaries, getSummaries } from './store.js';

const COMPRESSOR_SYSTEM = '你是长篇剧情的记忆压缩专家。把分段摘要合并成一段更凝练、更连贯的摘要，不丢失任何专有名词、数字、时间点、决定、关系变化与悬念。只输出摘要正文。';

const LEVEL_SPEC = {
  2: {
    sourceLevel: 1, name: '幕', maxTokens: 7000, target: '400-600 字',
    instruction: '合并时按时间顺序重述这一「幕」的完整经过，保留所有因果链；同一件事不要重复描述。',
  },
  3: {
    sourceLevel: 2, name: '卷', maxTokens: 9000, target: '500-800 字',
    instruction: '合并时抽掉具体场景细节，只留「人物做了什么、关系变成什么样、哪些线还悬着」。',
  },
  4: {
    sourceLevel: 3, name: '编年', maxTokens: 11000, target: '600-900 字',
    instruction: '合并时以「历史进程」的口吻写：谁崛起、谁失势、哪些承诺被兑现或背弃、哪些伏笔还没收。',
  },
};

function collectTiling(rows, from, to) {
  const picked = [];
  let cursor = from;
  for (const r of rows) {
    if (r.turn_to < from || r.turn_from > to) continue;
    if (r.turn_from !== cursor) return null;
    if (r.turn_to > to) return null;
    picked.push(r);
    cursor = r.turn_to + 1;
    if (cursor > to) break;
  }
  return picked.length && cursor > to ? picked : null;
}

function isRangeCovered(rows, from, to) {
  return rows.some((r) => r.turn_from <= from && r.turn_to >= to);
}

async function compress(sessionId, sourceRows, level, from, to) {
  const spec = LEVEL_SPEC[level];
  const body = sourceRows.map((r) => `【第${r.turn_from}-${r.turn_to}轮】\n${r.content}`).join('\n\n');

  const { content } = await chat({
    messages: [
      { role: 'system', content: COMPRESSOR_SYSTEM },
      {
        role: 'user',
        content:
          `请把下面 ${sourceRows.length} 段 ${level - 1} 级摘要合并为一条 ${level} 级（${spec.name}）摘要。\n` +
          `覆盖范围：第 ${from}-${to} 轮。目标长度：${spec.target}。\n` +
          `${spec.instruction}\n` +
          `必须保留：所有专有名词、关键数字与时间、重要决定、关系变化、物品得失、未回收的线索。\n` +
          `直接输出摘要正文，不要标题、不要解释、不要 JSON。\n\n${body}`,
      },
    ],
    reasoningEffort: 'low',
    temperature: 0.3,
    maxTokens: spec.maxTokens,
  });

  const summary = (content || '').trim();
  if (!summary) throw new Error(`L${level} 压缩结果为空`);

  const { id } = addSummary(sessionId, { level, turnFrom: from, turnTo: to, content: summary });
  archiveSummaries(sourceRows.map((r) => r.id));
  return { id, archived: sourceRows.length };
}

/**
 * 检查并执行层级压缩。幂等、绝不抛错。
 * @returns {Promise<{created:Array, archived:number, error?:string}>}
 */
export async function checkCompression(sessionId, turnNo) {
  const created = [];
  let archived = 0;
  try {
    const { arcEvery, sagaEvery, chronicleEvery } = config.context;
    if (!Number.isInteger(turnNo) || turnNo <= 0) return { created, archived };

    /* ---- L1 → L2 ---- */
    if (arcEvery > 0) {
      const l1s = getSummaries(sessionId, { level: 1, archived: 0 });
      // 未归档 L1 攒够 arcEvery 条，且首尾连续时压成一条 L2
      while (l1s.length >= arcEvery) {
        const batch = l1s.slice(0, arcEvery);
        let contiguous = true;
        for (let i = 1; i < batch.length; i++) {
          if (batch[i].turn_from !== batch[i - 1].turn_to + 1) { contiguous = false; break; }
        }
        if (!contiguous) break;
        const from = batch[0].turn_from;
        const to = batch[batch.length - 1].turn_to;
        const l2all = getSummaries(sessionId, { level: 2, archived: null });
        if (isRangeCovered(l2all, from, to)) {
          archiveSummaries(batch.map((r) => r.id));
          l1s.splice(0, arcEvery);
          continue;
        }
        const res = await compress(sessionId, batch, 2, from, to);
        created.push({ level: 2, turn_from: from, turn_to: to });
        archived += res.archived;
        l1s.splice(0, arcEvery);
      }
    }

    /* ---- L2 → L3 ---- */
    if (sagaEvery > 0) {
      for (;;) {
        const l2s = getLatestSummaries(sessionId, 2, sagaEvery * 2);
        const batch = l2s.slice(-sagaEvery);
        if (batch.length < sagaEvery) break;
        let contiguous = true;
        for (let i = 1; i < batch.length; i++) {
          if (batch[i].turn_from !== batch[i - 1].turn_to + 1) { contiguous = false; break; }
        }
        if (!contiguous) break;
        const from = batch[0].turn_from;
        const to = batch[batch.length - 1].turn_to;
        const l3all = getSummaries(sessionId, { level: 3, archived: null });
        if (isRangeCovered(l3all, from, to)) {
          archiveSummaries(batch.map((r) => r.id));
          continue;
        }
        const res = await compress(sessionId, batch, 3, from, to);
        created.push({ level: 3, turn_from: from, turn_to: to });
        archived += res.archived;
        break;   // 一次只压一组，避免递归过深
      }
    }

    /* ---- L3 → L4 ---- */
    if (chronicleEvery > 0) {
      const l3s = getLatestSummaries(sessionId, 3, chronicleEvery * 2);
      const batch = l3s.slice(-chronicleEvery);
      if (batch.length >= chronicleEvery) {
        let contiguous = true;
        for (let i = 1; i < batch.length; i++) {
          if (batch[i].turn_from !== batch[i - 1].turn_to + 1) { contiguous = false; break; }
        }
        if (contiguous) {
          const from = batch[0].turn_from;
          const to = batch[batch.length - 1].turn_to;
          const l4all = getSummaries(sessionId, { level: 4, archived: null });
          if (!isRangeCovered(l4all, from, to)) {
            const res = await compress(sessionId, batch, 4, from, to);
            created.push({ level: 4, turn_from: from, turn_to: to });
            archived += res.archived;
          }
        }
      }
    }

    return { created, archived };
  } catch (err) {
    return { created, archived, error: err?.message || String(err) };
  }
}

/** 压缩比统计（供记忆面板展示）。 */
export function computeCompression(sessionId) {
  const tiers = [1, 2, 3, 4].map((level) => {
    const rows = getSummaries(sessionId, { level, archived: 0 });
    return {
      level,
      count: rows.length,
      tokens: rows.reduce((s, r) => s + r.token_count, 0),
      last: rows.length
        ? {
          turn_from: rows[rows.length - 1].turn_from,
          turn_to: rows[rows.length - 1].turn_to,
          tokens: rows[rows.length - 1].token_count,
        }
        : null,
    };
  });
  return tiers;
}

export { collectTiling, isRangeCovered };
