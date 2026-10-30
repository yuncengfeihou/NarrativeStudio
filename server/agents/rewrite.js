/**
 * server/agents/rewrite.js — 定点改稿的确定性部分（S1）。
 *
 * 职责：把「只改这一段」翻译成三件纯函数——(a) 请求校验、(b) 送模文案、(c) 改完后的越界判定。
 * 定位**不进模型**：区间与原文快照由前端给，服务端逐字核对；改完也只做确定性 diff。
 *
 * 不变量：
 * - 快照不符就是「正文已变」，让用户重新选，绝不猜他指的是哪一段——猜错＝静默改错地方。
 * - 越界只报不拦：模型重演的是整拍正文，字面重排天然会外溢；「改了范围外」是**事实**，
 *   落 `patches(kind='rewrite_out_of_range')` 供报告与前端提示，不自动回滚（回滚要人决定）。
 * - 片段上限是防「拿定点改稿当整拍重写用」：超了就该走 `/rewrite` 不带 target。
 */

/** 一次定点改稿的片段上限（字符）。超过说明用户要的是整拍重写，不是圈一段。 */
export const MAX_TARGET_CHARS = 4000;

/**
 * 解析并校验 `body.target`。
 * @returns {{ok:boolean, target?:{start:number,end:number,expect:string}, error?:string}}
 *   `target` 为 null 表示「没给」（整拍重演，旧行为）。
 */
export function parseRewriteTarget(raw) {
  if (raw == null) return { ok: true, target: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'target 必须是对象' };
  const start = Number(raw.start);
  const end = Number(raw.end);
  const expect = typeof raw.expect === 'string' ? raw.expect : '';
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    return { ok: false, error: 'target.start/end 必须是整数，且 0 <= start < end' };
  }
  if (!expect) return { ok: false, error: 'target.expect 不能为空（它是对原文的快照校验）' };
  if (end - start !== expect.length) {
    return { ok: false, error: 'target.end - target.start 必须等于 expect 的长度' };
  }
  if (expect.length > MAX_TARGET_CHARS) {
    return { ok: false, error: `target 片段过长：上限 ${MAX_TARGET_CHARS} 字符，整段重写请不带 target` };
  }
  return { ok: true, target: { start, end, expect } };
}

/**
 * 快照校验：`target` 描述的片段现在还在不在原位。
 * 不符一律 `text_mismatch`——调用方把它翻成 409（让用户重选），不要降级成整拍重演。
 */
export function checkRewriteTarget({ content = '', target = null } = {}) {
  const text = String(content || '');
  if (!target) return { ok: true };
  if (target.end > text.length) return { ok: false, code: 'text_mismatch' };
  if (text.slice(target.start, target.end) !== target.expect) return { ok: false, code: 'text_mismatch' };
  return { ok: true };
}

/**
 * 送模文案。走 narrator 既有的 `【本轮改稿要求】` 通道（`buildNarratorMessages` 的 guidance），
 * 不新增注入点；只写「这次和平时不一样的地方」——范围与「其余保持原样」。
 */
export function composeRewriteGuidance({ guidance = '', target = null } = {}) {
  const parts = [];
  const note = String(guidance || '').trim();
  if (note) parts.push(note);
  if (target) {
    parts.push(`只重写下面这一段，其余内容保持原样：\n【待改片段】${target.expect}`);
  }
  return parts.join('\n\n');
}

/**
 * 改完之后的确定性判定：新旧正文的公共前缀/后缀之差就是「模型真正动了哪一段」。
 *
 * @returns {{out_of_range:boolean, changed:{from:number,old_end:number,new_end:number},
 *            outside:{before:number,after:number}}}
 *   `changed` 用旧/新两套坐标各给一个尾端：`[from, old_end)` 是旧文本里被替换掉的区间，
 *   `[from, new_end)` 是新文本里换上的区间。`outside` 是**落在 target 之外**的改动字符数。
 */
export function assessRewrite({ before = '', after = '', target = null } = {}) {
  const a = String(before || '');
  const b = String(after || '');
  const limit = Math.min(a.length, b.length);
  let from = 0;
  while (from < limit && a[from] === b[from]) from += 1;
  let tail = 0;
  while (tail < limit - from && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const oldEnd = a.length - tail;
  const newEnd = b.length - tail;
  const changed = { from, old_end: oldEnd, new_end: newEnd };
  if (!target) return { out_of_range: false, changed, outside: { before: 0, after: 0 } };
  // 一个字都没动（公共前后缀把整段吃满）时没有「范围外」可言——别拿坐标去比长度。
  if (from === oldEnd && from === newEnd) {
    return { out_of_range: false, changed, outside: { before: 0, after: 0 } };
  }
  const outsideBefore = from < target.start ? target.start - from : 0;
  const outsideAfter = oldEnd > target.end ? oldEnd - target.end : 0;
  return {
    out_of_range: outsideBefore > 0 || outsideAfter > 0,
    changed,
    outside: { before: outsideBefore, after: outsideAfter },
  };
}
