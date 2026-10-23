/**
 * CJK-aware token estimator.
 * Good enough for context budgeting (±10% of real BPE counts).
 *   - CJK chars (Han, Kana, Hangul) ≈ 1 token / char (conservative: 1.1)
 *   - ASCII words ≈ 1.3 tokens
 *   - other ASCII chars ≈ 0.35 tokens
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/;

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
  return Math.ceil(cjk * 1.1 + asciiWords * 1.3 + asciiOther * 0.35);
}

export function estimateMessageTokens(msg) {
  if (!msg) return 0;
  const role = msg.role ? estimateTokens(msg.role) : 0;
  return estimateTokens(msg.content) + role + 4;
}

export function estimateMessagesTokens(messages) {
  return (messages || []).reduce((s, m) => s + estimateMessageTokens(m), 0);
}

/** Truncate text to approximately N tokens (keeps the head). */
export function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  // walk chars, accumulating estimated tokens
  let used = 0;
  const out = [];
  for (const ch of text) {
    const t = CJK.test(ch) || ch.codePointAt(0) > 0x2E80 ? 1.1 : 0.35;
    if (used + t > maxTokens) break;
    used += t;
    out.push(ch);
  }
  return out.join('') + '…';
}
