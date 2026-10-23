/**
 * server/memory/retriever.js — 混合检索器
 *
 * 语料：
 *   - 全部 L1 摘要（未归档）+ L2/L3/L4（含归档，归档摘要仍是有效历史）
 *   - 实体（name + summary）
 *   - 关系账本、线索账本、反思
 *   - 最近 N 条原始 turn 行（更老的靠摘要兜底）
 *
 * 打分 = BM25 × 结构加权：
 *   - 实体名被 query 精确包含 → ×1.6（专有名词是强信号）
 *   - 线索 / 反思 → ×1.25（这两类本身就是「被沉淀过的重要信息」）
 *   - turn 按新近度微调 ×(1 + turn_no/12000)
 *
 * 可选嵌入增强：config.embed.enabled 时，若能拿到 query 向量与文档向量，
 * 把余弦相似度按 0.35 权重混入。未配置时完全跳过，零额外成本。
 */
import { truncateToTokens } from '../tokens.js';
import {
  getDb, getEntities, getMaxTurnNo, getReflections, getRelations, getSummaries, getThreads,
} from './store.js';

const K1 = 1.2;
const B = 0.75;
const RECENT_TURN_ROWS = 120;
const SNIPPET_MAX_TOKENS = 320;
const ENTITY_NAME_BOOST = 1.6;
const CURATED_BOOST = 1.25;
const RECENCY_DIVISOR = 12000;

const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]+/g;
const ASCII_RUN = /[A-Za-z0-9]+/g;

/** 停用词：这些 bigram 几乎每篇都有，不该贡献分数。 */
const STOP_BIGRAMS = new Set([
  '一个', '什么', '这个', '那个', '自己', '他们', '她们', '我们', '你们',
  '可以', '就是', '不是', '没有', '已经', '还是', '但是', '因为', '所以',
  '现在', '时候', '起来', '出来', '过来', '下来', '一下', '一起', '只是',
]);

/**
 * 分词：CJK → 单字 + 相邻 bigram；ASCII → 小写化单词。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const out = [];
  if (!text) return out;
  const s = String(text);
  for (const m of s.matchAll(CJK_RUN)) {
    const run = m[0];
    for (let i = 0; i < run.length; i++) {
      out.push(run[i]);
      if (i + 1 < run.length) {
        const bi = run.slice(i, i + 2);
        if (!STOP_BIGRAMS.has(bi)) out.push(bi);
      }
    }
  }
  for (const m of s.matchAll(ASCII_RUN)) out.push(m[0].toLowerCase());
  return out;
}

function summaryDoc(s) {
  return {
    kind: 'summary',
    ref: s.id,
    turn_no: s.turn_to,
    turn_from: s.turn_from,
    turn_to: s.turn_to,
    name: null,
    text: s.content || '',
  };
}

export class MemoryRetriever {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this._index = null;
    this._version = null;
  }

  invalidate() { this._index = null; }

  _currentVersion() {
    const sid = this.sessionId;
    const row = getDb().prepare(`
      SELECT (SELECT COUNT(*) FROM summaries   WHERE session_id = ?) AS summaries,
             (SELECT COUNT(*) FROM entities    WHERE session_id = ?) AS entities,
             (SELECT COUNT(*) FROM relations   WHERE session_id = ?) AS relations,
             (SELECT COUNT(*) FROM threads     WHERE session_id = ?) AS threads,
             (SELECT COUNT(*) FROM reflections WHERE session_id = ?) AS reflections
    `).get(sid, sid, sid, sid, sid);
    return `${getMaxTurnNo(sid)}|${row?.summaries || 0}|${row?.entities || 0}|${row?.relations || 0}|${row?.threads || 0}|${row?.reflections || 0}`;
  }

  _buildIndex() {
    const sid = this.sessionId;
    const docs = [];

    for (const s of getSummaries(sid, { level: 1, archived: 0 })) docs.push(summaryDoc(s));
    for (const level of [2, 3, 4]) {
      for (const s of getSummaries(sid, { level, archived: null })) docs.push(summaryDoc(s));
    }

    for (const e of getEntities(sid, { limit: 1000 })) {
      docs.push({
        kind: 'entity', ref: e.id, turn_no: e.last_turn || 0,
        name: e.name, text: `${e.name}\n${e.summary || ''}`,
      });
    }

    for (const r of getRelations(sid, { limit: 200 })) {
      docs.push({
        kind: 'relation', ref: r.id, turn_no: r.turn_no || 0, name: r.from_name,
        text: `${r.from_name} 与 ${r.to_name} ${r.kind} ${r.note}`,
      });
    }

    for (const t of getThreads(sid, { limit: 200 })) {
      docs.push({
        kind: 'thread', ref: t.id, turn_no: t.planted_turn || 0, name: t.title,
        text: `${t.title} ${t.note}`,
      });
    }

    for (const r of getReflections(sid, { limit: 200 })) {
      docs.push({
        kind: 'reflection', ref: r.id, turn_no: r.turn_to || 0, name: null, text: r.content,
      });
    }

    const rows = getDb().prepare(`
      SELECT id, turn_no, kind, content FROM turns
      WHERE session_id = ? ORDER BY turn_no DESC, id DESC LIMIT ?
    `).all(sid, RECENT_TURN_ROWS).reverse();
    for (const r of rows) {
      docs.push({ kind: 'turn', ref: r.id, turn_no: r.turn_no, name: null, text: r.content || '' });
    }

    const df = new Map();
    let totalLen = 0;
    for (const d of docs) {
      const tf = new Map();
      for (const t of tokenize(d.text)) tf.set(t, (tf.get(t) || 0) + 1);
      d.tf = tf;
      d.len = 0;
      for (const n of tf.values()) d.len += n;
      totalLen += d.len;
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }

    this._index = { docs, df, avgdl: docs.length ? totalLen / docs.length : 1 };
    this._version = this._currentVersion();
  }

  /**
   * @param {string} query
   * @param {{topK?:number, minScore?:number}} [opts]
   */
  search(query, { topK = 5, minScore = 0 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    if (!this._index || this._version !== this._currentVersion()) this._buildIndex();

    const { docs, df, avgdl } = this._index;
    if (!docs.length) return [];
    const terms = tokenize(q);
    if (!terms.length) return [];

    const strongTerms = terms.filter((t) => t.length >= 2);
    const N = docs.length;
    const qNorm = q.replace(/\s+/g, '');
    const out = [];

    for (const d of docs) {
      let score = 0;
      let strongHit = false;
      for (const t of terms) {
        const tf = d.tf.get(t) || 0;
        if (!tf) continue;
        if (t.length >= 2) strongHit = true;
        const n = df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * d.len / avgdl));
      }
      if (score <= 0) continue;
      if (strongTerms.length && !strongHit) continue;

      if ((d.kind === 'entity' || d.kind === 'thread') && d.name && qNorm.includes(d.name)) {
        score *= ENTITY_NAME_BOOST;
      }
      if (d.kind === 'thread' || d.kind === 'reflection') score *= CURATED_BOOST;
      if (d.kind === 'turn' && d.turn_no) score *= 1 + d.turn_no / RECENCY_DIVISOR;

      if (score < minScore) continue;

      const hit = {
        kind: d.kind,
        ref: d.ref,
        score: Math.round(score * 1000) / 1000,
        snippet: truncateToTokens(d.text, SNIPPET_MAX_TOKENS),
        turn_no: d.turn_no,
      };
      if (d.kind === 'summary') { hit.turn_from = d.turn_from; hit.turn_to = d.turn_to; }
      if (d.name) hit.name = d.name;
      out.push(hit);
    }

    out.sort((a, b) => b.score - a.score || (b.turn_no || 0) - (a.turn_no || 0));
    return out.slice(0, Math.max(0, topK));
  }
}
