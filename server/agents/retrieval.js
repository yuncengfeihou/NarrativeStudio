/**
 * server/agents/retrieval.js — 资料员预检：辞书全文 + 历史原文（模型主动取证的最小形态）
 *
 * 一拍开始前，让模型判断「这一拍要不要查、查什么」；代码执行确定性匹配，把命中原文压成
 * 一段【检索结果】进 retrieval 子层。它不改变场记单的渲染路径，也不把结果写进任何表：
 * 当拍结束即蒸发。
 *
 * 两种检索同一条链路、同一次模型往返（零额外开销）：
 * - `codex`   → `lookupCodex()`，查设定集条目全文；
 * - `history` → `recallHistory()`，查已发生回合的原文片段（与分段模式的 recall_history 同源）。
 *
 * 不是关键词触发：代码不会因为正文里出现某个名字就自动注入；查询由模型发起。
 */
import { config } from '../config.js';
import { chat } from '../llm.js';
import { estimateTokens, truncateToTokens } from '../tokens.js';
import { currentPlan } from '../memory/context-plan.js';
import { recallHistory } from '../memory/recall-history.js';
import { lookupCodex, renderCodexHit } from '../world/scene-sheet.js';
import { buildAliasIndex, linkEntities } from '../world/schema.js';
import { retrievalSystemPrompt, retrievalUserPrompt } from '../prompts/retrieval.js';

/**
 * 纯函数：这一拍要不要跑检索预检。
 *
 * 两条触发通道，判据不同：
 * 1. **辞书通道**（原有）：只在大卡上开——小卡的辞书条目少，场记单里已经能看到全文。
 * 2. **历史通道**（新增）：玩家文本/走向里点名了**已登场的人物**就跑，与卡大小无关。
 *    记忆一致性的问题和「卡上有多少辞书条目」没有因果关系：小卡一样会把第 3 轮说过的
 *    承诺忘掉。所以这一条不看 codexCount。
 *
 * 这不是「按关键词注入」：它只决定要不要花一次模型调用去判断，查什么、查不查仍由模型
 * 决定，代码只执行确定性检索。
 */
export function shouldPrecheckRetrieval({
  mode = 'auto', codexCount = 0, minCodex = 0, playerText = '', branchChoice = null, card = null,
} = {}) {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (!card) return (codexCount >= minCodex);
  const linked = linkEntities(
    [playerText || '', branchChoice?.description || ''].join('\n'),
    buildAliasIndex(card),
  );
  // 历史通道：点名了人（而不是事物）就值得查一次「他之前说过/发生过什么」。
  if ((linked.person || []).length > 0) return true;
  return codexCount >= minCodex && (linked.fact || []).length > 0;
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

/**
 * 宽容解析：拆成两条通道。
 *
 * 兼容旧形状 `{"queries":[...]}`（当时只有辞书一条通道）：它等价于「只查辞书」。
 * 新形状 `{"codex":[...],"history":[...]}`。解析失败返回两个空数组（本拍不检索）。
 */
export function parseRetrievalRequest(content) {
  const obj = tryParseObject(content);
  const clean = (v) => (Array.isArray(v) ? v : [])
    .map((q) => String(q || '').trim())
    .filter((q) => q.length >= 2 && q.length <= 40)
    .slice(0, config.context.retrievalMaxQueries);
  if (!obj) return { codex: [], history: [] };
  return { codex: clean(obj.codex ?? obj.queries), history: clean(obj.history) };
}

/** 只取辞书查询词。保留给测试与旧调用方。 */
export function parseRetrievalQueries(content) {
  return parseRetrievalRequest(content).codex;
}

/**
 * @returns {Promise<
 *   {text:string, queries:string[], codex_queries:string[], history_queries:string[],
 *    entries:Array<{id:string,name:string,why:string[]}>, history_hits:Array,
 *    tokens:{codex:number,history:number}, usage:object|null}
 *   | null
 * >}
 */
export async function runRetrieval({
  card, playerText = '', ledger = null, lastNarrative = '', signal,
  // 历史回查需要分支可见性上下文；不传就只做辞书通道。
  sessionId = null, branchId = null, forkTurn = null, atTurn = null,
  // 上下文已经逐字可见的那一段起点：从这一拍起不再检索（D4 后验）。
  excludeFrom = null,
}) {
  const entities = card?.entities || [];
  if (!entities.length) return null;
  const canRecall = !!sessionId;

  // 名字/别名的紧凑清单；给模型判断「有什么可查」。
  const names = [...new Set(entities.flatMap((e) => [e.name, ...(e.aliases || [])]).filter(Boolean))];
  const res = await chat({
    agent: 'retrieval',
    messages: [
      {
        role: 'system',
        content: retrievalSystemPrompt({
          names: names.slice(0, 400),
          maxQueries: config.context.retrievalMaxQueries,
          canRecall,
        }),
      },
      {
        role: 'user',
        content: retrievalUserPrompt({ playerText, ledger, lastNarrative, canRecall }),
      },
    ],
    temperature: null,
    maxTokens: null,
    reasoningEffort: null,
    signal,
  });

  const { codex: codexQueries, history: historyQueries } = parseRetrievalRequest(res.content);
  const queries = [...codexQueries, ...historyQueries];
  if (!queries.length) {
    // 模型这一拍决定不查：仍要留痕，否则「触发了但没查」和「没触发」在报告里分不开，
    // 而这条空查询路径在长跑里占触发拍的一半（50 轮实测 13/27）。
    return {
      text: '', queries: [], codex_queries: [], history_queries: [],
      entries: [], history_hits: [], history_self_echo: [],
      exclude_from: Number.isInteger(excludeFrom) && excludeFrom > 0 ? excludeFrom : null,
      tokens: { codex: 0, history: 0 }, usage: res.usage || null,
    };
  }

  /* ---- 辞书通道 ---- */
  const hits = [];
  const seen = new Set();
  for (const q of codexQueries) {
    for (const hit of lookupCodex(card, q, { limit: 2 })) {
      const id = hit.entry.id || hit.entry.name;
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push(hit);
    }
  }

  /* ---- 历史通道：与分段模式的 recall_history 同源，只是这里由预检发起 ---- */
  const histBlocks = [];
  const histHits = [];
  // 「自问自答」计数（D4 后验的判据）：查询词本身就是玩家这一拍写的字。
  // 那种查询检索回来的必然是模型已经看得见的东西——50 轮实测 20 条里 15 条是这样。
  // 现在有了 excludeFrom 下界，这类查询多半直接落空；留着这个计数是为了证明它真的降下去了。
  const selfEcho = historyQueries.filter((q) => String(playerText || '').includes(q));
  if (canRecall) {
    for (const q of historyQueries) {
      const r = recallHistory({
        sessionId, branchId, forkTurn, atTurn, query: q, limit: 3, excludeFrom,
      });
      // 明确写「没找到」要带上：让模型知道「这段历史确实没有」，而不是留白让它编。
      histBlocks.push(r.text);
      if (r.hits?.length) histHits.push(...r.hits.map((h) => ({ ...h, query: q })));
    }
  }

  const layerBudget = currentPlan().layers.retrieval;
  // 两条通道都要时有历史结果的，才分预算；只有一条时那条拿满。
  const hasCodex = hits.length > 0;
  const hasHistory = histBlocks.length > 0;
  const histShare = (hasCodex && hasHistory) ? Math.floor(layerBudget * 0.45) : layerBudget;
  const codexShare = (hasCodex && hasHistory) ? layerBudget - histShare : layerBudget;

  const codexText = hasCodex
    ? `【设定集检索】以下是主演主动查阅的设定原文，只作此刻参考，不要整段复述。\n\n${
      truncateToTokens(hits.map(({ entry }) => renderCodexHit(entry)).join('\n'), codexShare)}`
    : '';
  const historyText = hasHistory ? truncateToTokens(histBlocks.join('\n\n'), histShare) : '';

  // 拼接顺序：辞书在前（「这个世界是什么」），历史在后（「之前发生过什么」）。
  // 末端离当前输入最近，注意力最强的位置留给「刚发生的事」。
  const sections = [codexText, historyText].filter(Boolean);
  if (!sections.length) {
    return {
      text: '', queries, codex_queries: codexQueries, history_queries: historyQueries,
      entries: [], history_hits: [], history_self_echo: selfEcho,
      exclude_from: Number.isInteger(excludeFrom) && excludeFrom > 0 ? excludeFrom : null,
      tokens: { codex: 0, history: 0 }, usage: res.usage || null,
    };
  }
  // 最终兜底：分账之和可能略超（两个 truncate 各自留了余量），整段再压一次。
  const text = truncateToTokens(sections.join('\n\n'), layerBudget);
  return {
    text,
    queries,
    codex_queries: codexQueries,
    history_queries: historyQueries,
    entries: hits.map(({ entry, why }) => ({ id: entry.id, name: entry.name, why })),
    history_hits: histHits.slice(0, 12).map((h) => ({ turn_no: h.turn_no, kind: h.kind, query: h.query })),
    history_self_echo: selfEcho,
    exclude_from: Number.isInteger(excludeFrom) && excludeFrom > 0 ? excludeFrom : null,
    tokens: {
      codex: codexText ? estimateTokens(codexText) : 0,
      history: historyText ? estimateTokens(historyText) : 0,
    },
    usage: res.usage || null,
  };
}
