/**
 * CJK-aware token 估算器。
 *
 * 原始计数（CJK 字 ≈ 1.1 tok / 字）是**保守高估**的：它按「每个汉字一个 token」算，
 * 但真实 BPE 对中文常用词有合并，且不额外计入 chat 模板开销。
 *
 * 用 19 次真实上游调用标定（`turns.usage_json` 的 prompt_tokens 对比装配估算）：
 *   est 199,011 / actual 141,817 → 高估 1.403 倍
 * 另一路独立测量（8 轮真实会话）得到 1.41，两处一致。
 *
 * 因此乘上 TOKEN_SCALE 让估算值贴近真实 token，**预算数字才有意义**：
 * 否则配额写着 24000，实际只用了约 17000，等于永远达不到设计意图。
 *
 * 保留一点安全余量（不用精确的 0.713），避免个别内容形状（大量英文/代码）
 * 被低估后击穿硬上限。可用 TOKEN_SCALE 环境变量覆盖。
 *
 *   - CJK 字 ≈ 1.1 × TOKEN_SCALE
 *   - 其他非 ASCII（全角标点等）同 CJK
 *   - ASCII 词 ≈ 1.3 × TOKEN_SCALE
 *   - 其他 ASCII 字符 ≈ 0.35 × TOKEN_SCALE
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/;

const parsedScale = Number(process.env.TOKEN_SCALE);
export const TOKEN_SCALE = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 0.72;

const CJK_WEIGHT = 1.1 * TOKEN_SCALE;
const ASCII_WORD_WEIGHT = 1.3 * TOKEN_SCALE;
const ASCII_OTHER_WEIGHT = 0.35 * TOKEN_SCALE;
/** 每条消息的角色字段与分隔符开销。也按同一比例缩放，保持口径一致。 */
const MESSAGE_OVERHEAD = Math.max(1, Math.round(4 * TOKEN_SCALE));

export function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== 'string') {
    // handle multipart content arrays
    if (Array.isArray(text)) return text.reduce((s, p) => s + estimateTokens(p?.text || p?.content || ''), 0) + text.filter(p => p?.image_url).length * 900;
    text = String(text);
  }
  let cjk = 0, asciiWords = 0, asciiOther = 0;
  let inWord = false;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (CJK.test(ch)) { cjk++; inWord = false; continue; }
    if (code > 0x2E80) { cjk++; inWord = false; continue; } // CJK punctuation, fullwidth
    if (/[A-Za-z0-9]/.test(ch)) { if (!inWord) { asciiWords++; inWord = true; } continue; }
    inWord = false;
    if (ch.trim() !== '') asciiOther++;
  }
  return Math.max(1, Math.ceil(cjk * CJK_WEIGHT + asciiWords * ASCII_WORD_WEIGHT + asciiOther * ASCII_OTHER_WEIGHT));
}

export function estimateMessageTokens(msg) {
  if (!msg) return 0;
  const role = msg.role ? estimateTokens(msg.role) : 0;
  return estimateTokens(msg.content) + role + MESSAGE_OVERHEAD;
}

/** Truncate text to approximately N tokens (keeps the head). 与 estimateTokens 同一口径。 */
export function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  // walk chars, accumulating estimated tokens
  let used = 0;
  const out = [];
  for (const ch of text) {
    const t = CJK.test(ch) || ch.codePointAt(0) > 0x2E80 ? CJK_WEIGHT : ASCII_OTHER_WEIGHT;
    if (used + t > maxTokens) break;
    used += t;
    out.push(ch);
  }
  return out.join('') + '…';
}
