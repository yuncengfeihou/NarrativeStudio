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
import { getSession, getTurnWatermark } from './store.js';

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
