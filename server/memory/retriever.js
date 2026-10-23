/**
 * server/memory/retriever.js — BM25 全文检索器（分层记忆的召回层）
 *
 * 语料（corpus）构成：
 *   - 全部未归档 L1 摘要（round summary）
 *   - 全部 L2 / L3 / L4 摘要（归档与否均入索引：被上层吸收的摘要仍是有效历史，
 *     检索层需要它能兜底那些已从上下文中消失的细节）
 *   - 实体（name + summary）
 *   - 最近 RECENT_TURN_ROWS 条原始 turn 行（更老的 raw turn 不入索引，靠摘要兜底）
 *
 * 分词：CJK 连续段生成 bigram（相邻两字）+ 单字；ASCII 生成小写化单词；标点/空白忽略。
 *
 * 评分：BM25（k1=1.2, b=0.75）
 *   - 实体名被 query 精确包含时 ×1.5（专有名词是强信号）
 *   - turn 文档按 turn_no 轻微加权 ×(1 + turn_no/10000)（越新越容易被召回）
 *
 * 索引缓存：惰性构建。以 (max turn_no, summary 总数, entity 总数) 作为版本号，
 * search 前若版本发生变化则自动重建；invalidate() 可强制下次 search 重建。
 */
import { truncateToTokens } from '../tokens.js';
import { getDb, getEntities, getMaxTurnNo, getSummaries } from './store.js';

const K1 = 1.2;                       // BM25 词频饱和参数
const B = 0.75;                       // BM25 长度归一化参数
const RECENT_TURN_ROWS = 80;          // 仅索引最近 80 条原始 turn 行（约 40 轮）
const SNIPPET_MAX_TOKENS = 400;       // snippet 截断长度（token）
const ENTITY_NAME_BOOST = 1.5;        // 实体名精确命中 query 的加权倍数
const RECENCY_BOOST_DIVISOR = 10000;  // turn 新近度加权除数：×(1 + turn_no / 10000)

/** CJK 连续字符段（与 tokens.js 使用同一字符类） */
const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]+/g;
/** ASCII 单词段 */
const ASCII_RUN = /[A-Za-z0-9]+/g;

/**
 * 分词：CJK → 单字 + 相邻 bigram；ASCII → 小写化单词；标点与空白忽略。
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
      out.push(run[i]);                                       // 单字
      if (i + 1 < run.length) out.push(run.slice(i, i + 2));  // 相邻 bigram
    }
  }
  for (const m of s.matchAll(ASCII_RUN)) out.push(m[0].toLowerCase());
  return out;
}

/** 摘要行 → 索引文档 */
function summaryDoc(s) {
  return {
    kind: 'summary',
    ref: s.id,
    turn_no: s.turn_to,     // 以其覆盖的最后一轮作为时间坐标
    turn_from: s.turn_from,
    name: null,
    text: s.content || '',
  };
}

export class MemoryRetriever {
  /**
   * @param {string} sessionId
   */
  constructor(sessionId) {
    this.sessionId = sessionId;
    /** @type {{docs:Array, df:Map<string,number>, avgdl:number}|null} */
    this._index = null;
    this._version = null;
  }

  /** 数据变化后调用，强制下次 search 重建索引 */
  invalidate() {
    this._index = null;
  }

  /**
   * 当前数据版本号：max turn_no + summary 总数 + entity 总数。
   * 任一楼层的增删/归档都会改变它，从而触发索引重建。
   * @returns {string}
   */
  _currentVersion() {
    const sid = this.sessionId;
    const maxTurn = getMaxTurnNo(sid);
    const row = getDb().prepare(`
      SELECT (SELECT COUNT(*) FROM summaries WHERE session_id = ?) AS summaries,
             (SELECT COUNT(*) FROM entities  WHERE session_id = ?) AS entities
    `).get(sid, sid);
    return `${maxTurn}|${row?.summaries || 0}|${row?.entities || 0}`;
  }

  /** 惰性重建索引（_buildIndex 由 search / invalidate 触发） */
  _buildIndex() {
    const sid = this.sessionId;
    const docs = [];

    // ---- 摘要：L1 仅未归档；L2/L3/L4 全部 ----
    for (const s of getSummaries(sid, { level: 1, archived: 0 })) docs.push(summaryDoc(s));
    for (const level of [2, 3, 4]) {
      // archived: null → 不加归档过滤（归档摘要同样是可检索的历史）
      for (const s of getSummaries(sid, { level, archived: null })) docs.push(summaryDoc(s));
    }

    // ---- 实体 ----
    for (const e of getEntities(sid, { limit: 1000 })) {
      docs.push({
        kind: 'entity',
        ref: e.id,
        turn_no: e.last_turn || 0,
        name: e.name,
        text: `${e.name}\n${e.summary || ''}`,
      });
    }

    // ---- 最近 N 条原始 turn 行（更老的 raw turn 不入索引，靠摘要兜底） ----
    const rows = getDb().prepare(`
      SELECT id, turn_no, kind, content FROM turns
      WHERE session_id = ? ORDER BY turn_no DESC, id DESC LIMIT ?
    `).all(sid, RECENT_TURN_ROWS).reverse();
    for (const r of rows) {
      docs.push({
        kind: 'turn',
        ref: r.id,
        turn_no: r.turn_no,
        name: null,
        text: r.content || '',
      });
    }

    // ---- 词频 / 文档频率 / 平均长度 ----
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
   * BM25 检索。
   * @param {string} query 检索语句（空串返回 []）
   * @param {{topK?: number}} [opts]
   * @returns {Array<{kind:'turn'|'summary'|'entity', ref:number, score:number,
   *                  snippet:string, turn_no:number,
   *                  turn_from?:number, turn_to?:number, name?:string}>}
   */
  search(query, { topK = 6 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    // 版本变化（新增 turn / 新增或归档 summary / 新增实体）→ 自动重建
    if (!this._index || this._version !== this._currentVersion()) this._buildIndex();

    const { docs, df, avgdl } = this._index;
    if (!docs.length) return [];
    const terms = tokenize(q);
    if (!terms.length) return [];
    // 强词 = 长度 ≥2 的 token（CJK bigram / ASCII 单词）。
    // 单字是弱信号（"铁/令/牌"这类常见字几乎每篇都含），
    // 因此当查询存在强词时，文档必须至少命中一个强词才有资格入选，
    // 单字只参与入选文档间的排序加权，避免弱相关噪声。
    const strongTerms = terms.filter(t => t.length >= 2);

    const N = docs.length;
    const qNorm = q.replace(/\s+/g, '');   // 实体名精确命中判定用（忽略空白）
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
      if (strongTerms.length && !strongHit) continue;   // 只命中单字 → 无资格
      // 实体名精确命中 query → 加权
      if (d.kind === 'entity' && d.name && qNorm.includes(d.name)) score *= ENTITY_NAME_BOOST;
      // turn 越新越容易被召回
      if (d.kind === 'turn' && d.turn_no) score *= 1 + d.turn_no / RECENCY_BOOST_DIVISOR;

      const hit = {
        kind: d.kind,
        ref: d.ref,
        score: Math.round(score * 1000) / 1000,
        snippet: truncateToTokens(d.text, SNIPPET_MAX_TOKENS),
        turn_no: d.turn_no,
      };
      // 附加定位信息（契约五个字段的超集，便于调用方标注出处）
      if (d.kind === 'summary') { hit.turn_from = d.turn_from; hit.turn_to = d.turn_to; }
      if (d.kind === 'entity') { hit.name = d.name; }
      out.push(hit);
    }

    out.sort((a, b) => b.score - a.score || (b.turn_no || 0) - (a.turn_no || 0));
    return out.slice(0, Math.max(0, topK));
  }
}
