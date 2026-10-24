/**
 * server/agents/summarizer.js — 前情提要（滚动摘要）Agent
 *
 * 只在回合末跑，读「上一份摘要之后、最近保留回合之前」的完整原文，
 * 合并上一份摘要，写一份新的覆盖更大的摘要。
 *
 * 三条约束：
 * - 原文是唯一真相：摘要只是装配层派生数据，turns 永不改写；
 * - 最近 N 轮永远逐字保留，摘要只接更早的剧情（防止续演点被压缩）；
 * - 失败只跳过本次，下一拍再判；绝不阻断正文与落库。
 */
import { config } from '../config.js';
import { chat } from '../llm.js';
import { estimateTokens } from '../tokens.js';
import { getBranch, getState, getTurnsForBranch } from '../memory/store.js';
import { summarySystemPrompt, summaryUserPrompt } from '../prompts/summarizer.js';

/**
 * 纯函数：按 token 高/低水位决定这一轮把哪一段旧原文沉淀进摘要。
 *
 * rows 是摘要边界之后的全部原文回合（player/narrator，按时间正序）。
 * 返回值必须从 active.covers_turn_to + 1 开始，压缩完成后原文窗口自然从 to + 1 继续；
 * 这样「摘要边界」和「原文起点」始终是同一条线，不会出现中间空洞。
 *
 * 触发条件（任一）：原文超过 highTokens，或原文轮数超过 maxRawTurns。
 * 压缩目标：降到 lowTokens 以下且不超过 maxRawTurns，但至少保留 minRawTurns 轮逐字。
 *
 * @returns {{from:number,to:number,covered:number}|null}
 */
export function planCompaction({
  active = null, rows = [], highTokens, lowTokens,
  minRawTurns = 4, maxRawTurns = 12,
} = {}) {
  const covered = Number(active?.covers_turn_to) || 0;
  const turns = (rows || []).filter((r) => r && r.turn_no > covered);
  const minKeep = Math.max(1, Number.isInteger(minRawTurns) ? minRawTurns : 4);
  const maxKeep = Math.max(minKeep, Number.isInteger(maxRawTurns) ? maxRawTurns : 12);
  if (turns.length <= minKeep) return null;

  const cost = (r) => estimateTokens(String(r.content || '')) + 4;
  const lowWater = Number.isFinite(lowTokens)
    ? lowTokens
    : (Number.isFinite(highTokens) ? highTokens * 0.6 : Infinity);
  let kept = turns.length;
  let keptTokens = turns.reduce((sum, r) => sum + cost(r), 0);
  const overHigh = (Number.isFinite(highTokens) && keptTokens > highTokens) || kept > maxKeep;
  if (!overHigh) return null;

  let cut = 0;
  while (cut < turns.length - minKeep && (keptTokens > lowWater || kept > maxKeep)) {
    keptTokens -= cost(turns[cut]);
    kept -= 1;
    cut += 1;
  }
  if (cut <= 0) return null;

  return {
    from: covered + 1,
    to: turns[cut - 1].turn_no,
    covered,
  };
}

function stripFence(text) {
  const t = String(text || '').trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  return (m ? m[1] : t).trim();
}

/**
 * 跑一次摘要。
 * @returns {Promise<
 *   {text:string, turns:number, chars:number, usage:object|null}
 *   | {skipped:true, reason:string, chars?:number}
 * >}
 */
export async function runSummarizer({
  session, branchId, turnFrom, turnTo, previousSummary, playerName = '', charName = '', signal,
}) {
  const sessionId = session?.id;
  if (!sessionId) throw new Error('runSummarizer: session.id 不能为空');
  const branch = getBranch(sessionId, branchId);
  const forkTurn = branch ? branch.fork_turn : Number.MAX_SAFE_INTEGER;
  const rows = getTurnsForBranch(sessionId, branchId, forkTurn, {
    from: turnFrom, to: turnTo, kinds: ['player', 'narrator'],
  }).filter((r) => String(r.content || '').trim());

  if (!rows.length) return { skipped: true, reason: 'no-turns', chars: 0 };

  const turnsText = rows
    .map((r) => `${r.kind === 'player' ? '玩家' : '旁白'}（第${r.turn_no}轮）：${r.content}`)
    .join('\n\n');
  if (turnsText.length < config.context.summaryMinChars) {
    return { skipped: true, reason: 'too-short', chars: turnsText.length };
  }

  const ledger = getState(sessionId, { branchId, atTurn: turnTo })?.state || null;
  const cfg = config.agents.summarizer;
  const prompt = summaryUserPrompt({
    previousSummary: String(previousSummary || '').trim(),
    turnsText, ledger, playerName, charName, turnFrom, turnTo,
  });

  const res = await chat({
    messages: [
      { role: 'system', content: summarySystemPrompt() },
      { role: 'user', content: prompt },
    ],
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    reasoningEffort: cfg.reasoningEffort,
    model: cfg.model || undefined,
    signal,
  });

  const text = stripFence(res.content);
  if (!text) return { skipped: true, reason: 'empty', chars: turnsText.length };
  return { text, turns: rows.length, chars: turnsText.length, usage: res.usage || null };
}
