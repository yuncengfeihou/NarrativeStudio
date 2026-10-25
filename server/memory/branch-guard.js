/**
 * server/memory/branch-guard.js — 异步写入的分支守卫
 *
 * 旁路 Agent（史官/场记/校勘/世界呼吸/走向）是异步的：调用期间用户可能
 * rollback / rewrite / 切世界线。落库前必须核对「还是不是同一条分支、还是不是同一轮」，
 * 否则会把结果写进旧分支，或者用旧输入覆盖新状态。
 *
 * 判据是结构（sessions.branch_id + 最大回合号），不是时间窗口或启发式。
 * 丢弃是安全的：所有分支级状态都是 f(分支)，新分支会从自己的副本重建。
 */
import { createHash } from 'node:crypto';
import { claimEffect, getSession, getTurnWatermark, settleEffect } from './store.js';

/** 取当前分支快照。branchId 省略时用会话当前分支。 */
export function branchSnapshot(sessionId, branchId = null) {
  const session = getSession(sessionId);
  if (!session) return null;
  const mark = getTurnWatermark(sessionId);
  return {
    sessionId,
    branchId: branchId || session.branch_id || 'main',
    maxTurnNo: mark.maxTurnNo,
    maxTurnId: mark.maxId,
  };
}

/** 快照是否仍然成立：分支没变，且回合水位没变（任何一行追写都会失效）。 */
export function isBranchCurrent(snapshot) {
  if (!snapshot) return false;
  const session = getSession(snapshot.sessionId);
  if (!session) return false;
  if ((session.branch_id || 'main') !== snapshot.branchId) return false;
  if (Number.isInteger(snapshot.maxTurnId)) {
    const mark = getTurnWatermark(snapshot.sessionId);
    if (mark.maxId !== snapshot.maxTurnId) return false;
  }
  return true;
}

/** 便捷闭包：给旁路 Agent 传 `guard: guardOf(snapshot)`。 */
export function guardOf(snapshot) {
  return () => isBranchCurrent(snapshot);
}

/* ── 幂等回执 ─────────────────────────────────────────────────────────── */

/** effect_id 构造：稳定、可读、可重放（例：`archivist:t12`）。 */
export function makeEffectId(agent, ...parts) {
  return [agent, ...parts.filter((p) => p !== undefined && p !== null && p !== '')].join(':');
}

/** 输入指纹：同一 effect_id 只接受同一份输入；用摘要避免把正文写进回执表。 */
export function hashFingerprint(...parts) {
  return createHash('sha1')
    .update(parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('\u0001'))
    .digest('hex');
}

/**
 * 执行一次「旁路写入」，带幂等回执：
 * - 已 applied / stale 的 effect 直接跳过（返回 skipped=true）；
 * - pending / failed 可重试；同一 effect_id 换输入指纹 → conflict，不执行；
 * - 执行成功后按 isStale(result) 落 applied 或 stale；抛错落 failed 并继续向上抛。
 *
 * 分支守卫仍由 Agent 内部的 guard 负责：回执只管「同一次写入别落两遍」。
 */
export async function runEffectOnce(meta, fn, { isStale = null } = {}) {
  const { sessionId, branchId = null, turnNo = 0, agent, effectId, fingerprint = '' } = meta;
  const claim = claimEffect({ sessionId, branchId, turnNo, agent, effectId, fingerprint });
  if (!claim.claimed) return { skipped: true, status: claim.status, conflict: claim.conflict, result: null };
  try {
    const result = await fn();
    const status = typeof isStale === 'function' && isStale(result) ? 'stale' : 'applied';
    settleEffect(sessionId, effectId, { branchId, status, turnNo, agent });
    return { skipped: false, status, conflict: false, result };
  } catch (err) {
    settleEffect(sessionId, effectId, { branchId, status: 'failed', turnNo, agent });
    throw err;
  }
}
