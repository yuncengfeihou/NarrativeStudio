/**
 * recall_history —— 历史原文检索（模型主动取证通道）。
 *
 * 与 codex_lookup 同构：由模型发起、只返回命中片段、结果进 retrieval 子层当拍蒸发。
 * 代码绝不根据文本匹配自动把历史塞进上下文（红线 1 的例外通道，见 AGENTS.md §1.1）。
 *
 * 传给模型的不是整段原文：snippet 截 400 字，再按 maxTokens 预算逐条装，
 * 装不下就停，避免一次检索把上下文撑爆。
 */
import { estimateTokens, truncateToTokens } from '../tokens.js';
import { searchTurnsDetailed } from './store.js';

const KIND_LABEL = { player: '玩家', narrator: '旁白', system: '系统' };
const SNIPPET_TOKENS = 120;
const DEFAULT_MAX_TOKENS = 600;

/** 把命中片段渲染成给模型看的工具结果文本。纯函数，便于单测。 */
export function renderRecallResults(query, hits, { maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  const q = String(query || '');
  if (!hits?.length) {
    return `【历史检索：${q}】没有在已经发生的回合里找到匹配的原文。不要编造；按当前场次与场记单写。`;
  }
  const lines = [`【历史检索：${q}】（${hits.length} 条，按时间从近到远；只是片段，完整前文以逐字原文为准）`];
  for (const h of hits) {
    const line = `· 第 ${h.turn_no} 轮 · ${KIND_LABEL[h.kind] || h.kind}：${truncateToTokens(h.snippet, SNIPPET_TOKENS)}`;
    if (estimateTokens([...lines, line].join('\n')) > maxTokens) break;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * 检索本局已经发生的回合原文。
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} [args.branchId]  当前分支；传入后按分支可见性过滤（含继承的父分支）
 * @param {number} [args.forkTurn]  没有分支记录时的兜底分叉点
 * @param {number} [args.atTurn]    检索时点，默认到最新
 * @param {string} args.query
 * @param {number} [args.limit]     1-8，默认 4
 * @returns {{text:string, hits:Array, meta:{query,hits,limit,tokens,engine}}}  engine ∈ fts5|like|none
 */
export function recallHistory({
  sessionId, branchId = null, forkTurn = null, atTurn, query, limit = 4,
  kinds = ['player', 'narrator'], maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return { text: '错误：query 不能为空。', hits: [], meta: { query: q, hits: 0, limit: 0, tokens: 0, engine: 'none' } };
  }
  const lim = Math.max(1, Math.min(8, Number(limit) || 4));
  const { hits, engine } = searchTurnsDetailed(sessionId, q, { branchId, forkTurn, atTurn, limit: lim, kinds });
  const text = renderRecallResults(q, hits, { maxTokens });
  return {
    text,
    hits,
    meta: { query: q, hits: hits.length, limit: lim, tokens: estimateTokens(text), engine },
  };
}
