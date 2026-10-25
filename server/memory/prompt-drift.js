/**
 * server/memory/prompt-drift.js — 运行时缓存前缀探针（纯函数，零依赖）
 *
 * 只回答一个问题：**上一轮真实送模的 messages 与本轮 messages，前缀在哪里断的？**
 * 逐条比较 role + content，第一条不一致的消息给出 index、字符 offset 与两侧摘录；
 * 判定 identical / appendedMessages（健康，只追加）/ broken（前缀破裂）/ unknown（无基线）。
 *
 * 约束：
 *  - 只进 meta.cache.drift 与诊断日志，**绝不进提示词**，也不占任何层预算；
 *  - 摘录可能含正文（剧透），因此不写进 `turns.meta_json` 以外的用户可见面；
 *  - 只做字符串比较，不调模型、不估算 token（token 口径归 tokens.js）。
 */

const DEFAULT_EXCERPT_CHARS = 60;

/** 消息内容统一成字符串：非字符串（图片等）用 JSON 形态参与比较。 */
function textOf(message) {
  if (!message) return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  return content == null ? '' : JSON.stringify(content);
}

/**
 * 比较两轮送模消息序列（按 index 对位）。
 *
 * @param {Array<{role:string, content:any}>|null} prevMessages 上一轮真实送给模型的 messages
 * @param {Array<{role:string, content:any}>} nextMessages 本轮将要送给模型的 messages
 * @param {{excerptChars?:number}} [options]
 * @returns {{
 *   verdict: 'identical'|'appendedMessages'|'broken'|'unknown',
 *   shared_messages: number,
 *   index: number|null,
 *   char_offset: number|null,
 *   role_prev: string|null,
 *   role_next: string|null,
 *   left_excerpt: string|null,
 *   right_excerpt: string|null,
 *   prev_count: number,
 *   next_count: number,
 * }}
 */
export function comparePromptMessages(prevMessages, nextMessages, options = {}) {
  const excerptChars = Number.isInteger(options.excerptChars) && options.excerptChars > 0
    ? options.excerptChars
    : DEFAULT_EXCERPT_CHARS;
  const base = Array.isArray(prevMessages) ? prevMessages : [];
  const cur = Array.isArray(nextMessages) ? nextMessages : [];
  const result = {
    verdict: 'unknown',
    shared_messages: 0,
    index: null,
    char_offset: null,
    role_prev: null,
    role_next: null,
    left_excerpt: null,
    right_excerpt: null,
    prev_count: base.length,
    next_count: cur.length,
  };
  // 没有上一轮基线就没有「断点」可谈：unknown 而不是 broken。
  if (!base.length) return result;

  const limit = Math.min(base.length, cur.length);
  for (let i = 0; i < limit; i++) {
    const a = base[i];
    const b = cur[i];
    const ca = textOf(a);
    const cb = textOf(b);
    if (a?.role === b?.role && ca === cb) continue;

    // 第一条不一致的消息：同 role 时给字符级公共前缀（区分「改了开头」与「追加了结尾」）。
    let offset = 0;
    if (a?.role === b?.role && ca !== null && cb !== null) {
      const max = Math.min(ca.length, cb.length);
      while (offset < max && ca[offset] === cb[offset]) offset++;
    }
    return {
      ...result,
      verdict: 'broken',
      shared_messages: i,
      index: i,
      char_offset: offset,
      role_prev: a?.role ?? null,
      role_next: b?.role ?? null,
      left_excerpt: ca === null ? null : ca.slice(offset, offset + excerptChars),
      right_excerpt: cb === null ? null : cb.slice(offset, offset + excerptChars),
    };
  }

  // 前 limit 条完全一致：区分「等长全同」「只在尾部追加」与「尾部被删掉」。
  if (cur.length >= base.length) {
    return {
      ...result,
      verdict: cur.length === base.length ? 'identical' : 'appendedMessages',
      shared_messages: base.length,
    };
  }
  const dropped = textOf(base[cur.length]);
  return {
    ...result,
    verdict: 'broken',
    shared_messages: cur.length,
    index: cur.length,
    char_offset: 0,
    role_prev: base[cur.length]?.role ?? null,
    left_excerpt: dropped === null ? null : dropped.slice(0, excerptChars),
  };
}
