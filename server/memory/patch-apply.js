/**
 * server/memory/patch-apply.js — 人工处置提案的**确定性**入口
 *
 * 背景：记忆面板的「接受」过去只调 `setPatchStatus()`，那是一条
 * `UPDATE patches SET status='applied'`，对实体零效果。于是校勘报的
 * 「同一实体两个名字」在界面上被点掉了，账本里两个名字依然各写各的
 * （45 拍实测：t40 报「提酒男子 / 姬凡」，点接受不会有任何变化）。
 *
 * 这里只做能确定性完成的那一半，判据写死在代码里：
 *
 *   ① 谁是规范名，由**卡快照**的别名索引决定，不由模型说、也不由投影卡决定。
 *      投影卡里可能已经有运行期 `introduce` 出来的幽灵实体（t30 凭空造了个
 *      「提酒男子」），拿它当索引会把幽灵认成「卡里有的」。
 *      用卡快照也守住了红线 2：这是实体链接，不是触发器。
 *
 *   ② 只自动合并「一个名字在卡里、另一个不在卡里」这一种形态。
 *      两边都在卡里（真·两名冲突）或两边都不在（都是运行期新造的）→ 不猜，
 *      记 `reason` 交人。猜错的代价是把两个真实体永久并成一个，不可逆。
 *
 *   ③ 合并动作只有一条：`world_state` 的 `aliases` add（走 `pathsFor` 白名单）。
 *      不改 `name` —— 身份根不可写（`state-paths.js` 顶部）。也不删除运行期那个
 *      同名幽灵实体：原文与历史只追加不删除（红线 4/6），它留在账本里，
 *      但别名索引会让后续的实体链接指向规范名。
 *
 * 纯确定性代码，不调模型、不碰提示词。
 */
import {
  addWorldState, getMaxTurnNo, getPatch, getSession, getWorldState, setPatchStatus,
} from './store.js';
import { buildAliasIndex, normalizeCard, resolveEntity } from '../world/schema.js';

/** 只有这一类提案有确定性动作；其余 kind 一律拒绝，让界面别给出「按了有用」的错觉。 */
const APPLY_KINDS = new Set(['alias']);

/** 名字之间的分隔符。只认这几种，宁可判「两边都不在卡里」也不做模糊切分。 */
const NAME_SPLIT = /[\/／、,，]|与/;

const cleanName = (s) => String(s || '')
  .replace(/[「」『』“”"'‘’]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * 从提案的 subject 里拆出两个候选名字。拆不开就返回空数组（交人）。
 *
 * 不 export：它只是本模块的实现细节，外面没有任何调用方（`_work/deadcode-scan.mjs`
 * 会把它报成死导出）。要测就测 `applyPatchAction` 的端到端行为。
 */
const aliasCandidates = (subject) => {
  const raw = cleanName(subject);
  if (!raw) return [];
  const parts = raw.split(NAME_SPLIT).map(cleanName).filter(Boolean);
  return [...new Set(parts)];
};

/**
 * 合并一条 alias 提案。
 *
 * @returns {{found:boolean, ok:boolean, status:string, reason?:string, fix_result?:object}}
 *   `found=false` 表示提案不存在（路由回 404）；`ok=false` 表示按设计不自动执行。
 */
export function applyPatchAction(sessionId, patchId, { branchId = null } = {}) {
  const patch = getPatch(sessionId, Number(patchId));
  if (!patch) return { found: false, ok: false, status: '', reason: 'patch_not_found' };
  const branch = branchId || patch.branch_id || 'main';
  const session = getSession(sessionId);

  // 幂等：重复点「接受」不重复写别名。
  if (patch.payload?.fix_result?.state === 'applied') {
    return { found: true, ok: true, status: patch.status, already: true, fix_result: patch.payload.fix_result };
  }
  if (!APPLY_KINDS.has(String(patch.kind))) {
    return { found: true, ok: false, status: patch.status, reason: 'kind_not_supported' };
  }

  const done = (status, fixResult, humanReason) => {
    const payload = { ...(patch.payload || {}), fix_result: fixResult };
    if (humanReason) payload.apply_reason = humanReason;
    setPatchStatus(sessionId, patch.id, status, { payload });
    return { found: true, ok: status === 'applied', status, reason: humanReason, fix_result: fixResult };
  };

  const names = aliasCandidates(patch.payload?.subject || patch.payload?.claim || '');
  if (names.length < 2) {
    // 只有一个名字时无法确定「和谁合并」。这不是模型填错，是这类提案本来就缺信息。
    return done('failed', {
      action: 'merge_alias', target: '', state: 'unmatched', retryable: false,
      reason: 'need_two_names',
    }, 'need_two_names');
  }

  // 规范名只认卡快照：投影卡里可能已有运行期造出来的同名幽灵实体。
  const snapshot = normalizeCard(session?.card_snapshot || {});
  const index = buildAliasIndex(snapshot);
  const inCard = names.filter((n) => resolveEntity(n, index).type);
  const notInCard = names.filter((n) => !resolveEntity(n, index).type);

  if (inCard.length === 0) {
    // 两个名字都是运行期新造的：合成谁都是猜，而且可能是剧情里真的两个人。
    return done('failed', {
      action: 'merge_alias', target: names.join('/'), state: 'unmatched', retryable: false,
      reason: 'neither_in_card',
    }, 'neither_in_card');
  }
  if (inCard.length > 1) {
    const ids = new Set(inCard.map((n) => resolveEntity(n, index).id));
    if (ids.size === 1) {
      return done('applied', {
        action: 'merge_alias', target: names.join('/'), state: 'applied',
        canonical: { id: [...ids][0], name: inCard[0] }, aliases: [],
        note: '两个名字在卡里已属同一实体，无需合并',
      });
    }
    return done('failed', {
      action: 'merge_alias', target: names.join('/'), state: 'unmatched', retryable: false,
      reason: 'both_in_card',
    }, 'both_in_card');
  }

  const canonical = resolveEntity(inCard[0], index);
  const turnNo = getMaxTurnNo(sessionId);
  const runtime = getWorldState(sessionId, { branchId, atTurn: turnNo })
    .filter((d) => d.op === 'introduce' && cleanName(d.value?.name) && notInCard.includes(cleanName(d.value.name)));
  const runtimeNames = [...new Set(runtime.map((d) => cleanName(d.value.name)))];

  for (const alias of notInCard) {
    addWorldState(sessionId, {
      branch_id: branch,
      entity_kind: canonical.type,
      entity_id: canonical.id,
      path: 'aliases',
      op: 'add',
      value: alias,
      turn: turnNo,
      source: 'human',
      evidence: `人工合并别名：${alias} → ${canonical.name}`,
    });
  }

  return done('applied', {
    action: 'merge_alias',
    target: names.join('/'),
    state: 'applied',
    canonical: { id: canonical.id, name: canonical.name, type: canonical.type },
    aliases: notInCard,
    // 运行期造出来的同名实体不删除（红线 4/6：原文与历史只追加）。它留在账本里，
    // 但别名索引里规范名排在前面，后续实体链接不会再指向它。这里如实报出来，
    // 不然「合并成功」会掩盖「世界里还多着一个同名的人」。
    runtime_duplicates: runtimeNames,
  });
}
