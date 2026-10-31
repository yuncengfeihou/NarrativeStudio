/**
 * 定点改稿的「片段模式」（S2）：模型只出替换片段，拼接与校验全部是确定性的。
 *
 * 为什么不直接让模型重写整段：整段重写会顺带改掉范围外的句子（作者越改越多），
 * 而且模型每次都会重新组织全部文字——改一个词也要整篇重写，反而更容易漂。
 * 这里把「写什么」交给模型、把「放哪里」交给代码。
 */

// 与 rewrite.js 的 MAX_TARGET_CHARS 同量级：一次只改一屏以内的文字。
export const MAX_FRAGMENT_CHARS = 4000;

/**
 * 送模指令走 narrator 既有的 `guidance` 通道（不新增注入点）。
 * 只写这种写法特有的要求，通用底线不重复。
 */
export function composeFragmentGuidance({ target, instruction = '' }) {
  const lines = [
    instruction,
    '只输出替换【待改片段】的那一小段新文字：不要重写整段正文，不要解释，不要加标题或引号。',
    `【待改片段】${target?.expect || ''}`,
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * 去掉模型习惯性加的包装：代码块围栏、「改写：」前缀、把整段包起来的外层引号。
 * 只剥**最外层**，正文内部的引号（对白）必须原样保留。
 */
export function cleanFragment(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-zA-Z]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
  s = s.replace(/^(改写|替换|新文字|修改后)\s*[:：]\s*/, '');
  const pairs = [['「', '」'], ['“', '”'], ['"', '"']];
  for (const [open, close] of pairs) {
    if (s.length > 2 && s.startsWith(open) && s.endsWith(close)) {
      const inner = s.slice(open.length, s.length - close.length);
      // 里面还有同种引号说明这是正文本身（对白），不是外层包装
      if (!inner.includes(open)) { s = inner; break; }
    }
  }
  return s.trim();
}

/**
 * 确定性拼接：before 只被 target 圈定的一段替换成 piece。
 * 返回值里的 `ok:false` 都是**拒写**（不改正文），由调用方决定怎么报。
 */
export function spliceFragment({ before, target, piece }) {
  const src = String(before || '');
  if (!target || !Number.isInteger(target.start) || !Number.isInteger(target.end)) {
    return { ok: false, error: 'no_target' };
  }
  const body = cleanFragment(piece);
  if (!body) return { ok: false, error: 'empty_fragment' };
  if (body.length > MAX_FRAGMENT_CHARS) return { ok: false, error: 'fragment_too_long' };
  const next = src.slice(0, target.start) + body + src.slice(target.end);
  if (next === src) return { ok: false, error: 'unchanged' };
  return { ok: true, text: next, piece: body, delta: next.length - src.length };
}
