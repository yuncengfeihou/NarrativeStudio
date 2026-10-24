/**
 * server/agents/retrieval.js — 辞书检索预检（模型主动取证的最小形态）
 *
 * 一拍开始前，让模型判断「这一拍要不要查辞书全文、查什么」；代码执行确定性匹配，
 * 把命中的原文压成 current 层的一段【检索结果】。它不改变场记单的渲染路径，
 * 也不把结果写进任何表：当拍结束即蒸发。
 *
 * 不是关键词触发：代码不会因为正文里出现某个名字就自动注入；查询由模型发起。
 */
import { config } from '../config.js';
import { chat } from '../llm.js';
import { truncateToTokens } from '../tokens.js';
import { lookupCodex, renderCodexHit } from '../world/scene-sheet.js';
import { buildAliasIndex, linkEntities } from '../world/schema.js';
import { retrievalSystemPrompt, retrievalUserPrompt } from '../prompts/retrieval.js';

/**
 * 纯函数：这一拍要不要跑检索预检。
 *
 * auto 模式下只在大卡且玩家文本真的提到某个辞书实体时跑。这不是「按关键词注入」：
 * 它只决定要不要花一次模型调用去判断，不决定注入哪段设定。分段模式另有 codex_lookup。
 */
export function shouldPrecheckRetrieval({
  mode = 'auto', codexCount = 0, minCodex = 0, playerText = '', branchChoice = null, card = null,
} = {}) {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (!(codexCount >= minCodex)) return false;
  if (!card) return true;
  const linked = linkEntities(
    [playerText || '', branchChoice?.description || ''].join('\n'),
    buildAliasIndex(card),
  );
  return (linked.codex || []).length > 0;
}

function tryParseObject(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** 宽容解析：只取字符串查询词；解析失败返回空数组（本拍不检索）。 */
export function parseRetrievalQueries(content) {
  const obj = tryParseObject(content);
  if (!obj || !Array.isArray(obj.queries)) return [];
  return obj.queries
    .map((q) => String(q || '').trim())
    .filter((q) => q.length >= 2 && q.length <= 40)
    .slice(0, config.context.retrievalMaxQueries);
}

/**
 * @returns {Promise<
 *   {text:string, queries:string[], entries:Array<{id:string,name:string,why:string[]}>, usage:object|null}
 *   | null
 * >}
 */
export async function runRetrieval({
  card, playerText = '', ledger = null, lastNarrative = '', signal,
}) {
  const codex = card?.codex || [];
  if (!codex.length) return null;

  // 名字/别名的紧凑清单；给模型判断「有什么可查」。
  const names = [...new Set(codex.flatMap((e) => [e.name, ...(e.aliases || [])]).filter(Boolean))];
  const cfg = config.agents.retrieval;
  const res = await chat({
    messages: [
      {
        role: 'system',
        content: retrievalSystemPrompt({
          names: names.slice(0, 400),
          maxQueries: config.context.retrievalMaxQueries,
        }),
      },
      {
        role: 'user',
        content: retrievalUserPrompt({ playerText, ledger, lastNarrative }),
      },
    ],
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    reasoningEffort: cfg.reasoningEffort,
    model: cfg.model || undefined,
    signal,
  });

  const queries = parseRetrievalQueries(res.content);
  if (!queries.length) return { text: '', queries: [], entries: [], usage: res.usage || null };

  const hits = [];
  const seen = new Set();
  for (const q of queries) {
    for (const hit of lookupCodex(card, q, { limit: 2 })) {
      const id = hit.entry.id || hit.entry.name;
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push(hit);
    }
  }
  if (!hits.length) return { text: '', queries, entries: [], usage: res.usage || null };

  const body = hits.map(({ entry }) => renderCodexHit(entry)).join('\n');
  const text = truncateToTokens(
    `【检索结果】以下是主演主动查阅的设定原文，只作此刻参考，不要整段复述。\n\n${body}`,
    config.context.layerBudget.retrieval,
  );
  return {
    text,
    queries,
    entries: hits.map(({ entry, why }) => ({ id: entry.id, name: entry.name, why })),
    usage: res.usage || null,
  };
}
