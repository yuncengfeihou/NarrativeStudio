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
import { getBranch, getState, getTurnsForBranch } from '../memory/store.js';
import { summarySystemPrompt, summaryUserPrompt } from '../prompts/summarizer.js';

/**
 * 纯函数：判断这一轮是否该压、压哪一段。
 * @returns {{from:number,to:number,covered:number}|null}
 */
export function planSummary({ turnNo, active = null, every, keepRecent = 4 }) {
  if (!Number.isInteger(turnNo) || turnNo <= 0) return null;
  if (!Number.isFinite(every) || every <= 0) return null;
  const covered = Number(active?.covers_turn_to) || 0;
  if (turnNo - covered < every) return null;
  const keep = Math.max(0, Number.isInteger(keepRecent) ? keepRecent : 4);
  const to = turnNo - keep;
  const from = covered + 1;
  if (to < from) return null;
  return { from, to, covered };
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
