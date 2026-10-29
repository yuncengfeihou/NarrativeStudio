/**
 * server/memory/lint-state.js — 场记单渲染前的确定性体检（纯函数）
 *
 * 定位：在把「这一刻的世界」渲染给旁白之前，用**纯代码**找那些一眼就矛盾的状态。
 * 它不是新的 Agent、不调模型、不新增注入通道——只做两件事：
 *
 *   1. 能确定性修的，就地修（写进 patches 审计，可回放）；
 *   2. 修不了的，作为「注意」带到台面上，让人或校勘去处理。
 *
 * 为什么放在渲染前而不是交给校勘 Agent：
 * 校勘每 N 轮才跑一次、只看最近 12 轮原文，而这些矛盾在**每一轮**都可能是错的。
 * 死亡角色仍记为「在场」这种问题，等校勘发现时，剧情已经演了好几轮。
 *
 * 五类检查（全部来自已有字段，不做语义推断）：
 *   - 死亡/离场的角色仍在 present（**玩家角色除外**：他就是镜头本身）
 *   - 同一角色出现在两个地点
 *   - 随身物品的持有者不在场
 *   - 单值谓词在同一时刻有多个有效对象
 *   - 场次时间没有前进（同一场次被反复重写）
 */

const DEAD_MARKERS = ['死亡', '已死', '身亡', '断气', '咽气', '阵亡', '毙命'];
const GONE_MARKERS = ['离场', '离开', '退场'];

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
/**
 * @param {object} args
 * @param {object} args.ledger       当前场次账本（states 表的最新一条）
 * @param {Array}  args.present      在场卡司（投影后的 cast 条目）
 * @param {Array}  args.assertions   当前有效的断言
 * @param {Array}  args.scenes       已封场的场次记录（按 turn_from 正序）
 * @param {number} args.turnNo       当前轮次
 * @param {string} args.playerName   玩家角色名：**永不因 life_state 被移出在场**（见下）
 * @param {string} args.playerId     玩家角色 id（同上）
 * @returns {{fixes:Array, warnings:Array, ledger:object, present:Array}}
 */
export function lintState({
  ledger = {}, present = [], assertions = [], scenes = [], turnNo = 0,
  playerName = '', playerId = '',
} = {}) {
  const fixes = [];
  const warnings = [];

  const L = { ...(ledger || {}) };
  const characters = { ...(L.characters || {}) };
  let nextPresent = Array.isArray(L.present) ? [...L.present] : null;
  let nextCast = [...(present || [])];

  /* ---- 1. 死亡/离场的角色仍在 present ---- */
  // 主判：world_state 投影过来的 life_state（受控词 alive/injured/dead/gone，史官每拍写）。
  // 兜底：旧数据或模型漏写 life_state 时的 status 自由文本关键词——名单冻结，不再扩充
  // （AGENTS §1.2：不堆叠识别器）。结构化值优先，避免关键词误伤正常台词。
  // **玩家角色不适用这条**：他是「镜头本身」（pickPresent 里造的最小条目也带 is_player:true），
  // 主角若真离场，戏就结束了，不是「这一场不在镜头里」。曾经这里一视同仁，
  // 于是史官把主角写成 gone 的那一拍起，场记单每拍在末尾印「已故／离场：伍卿」，
  // 而正文仍是他的第一人称——模型同时收到「你已离场」和「你在做事」。
  // 主角那条 `life_state:'gone'` 本身也是无意义的：`absentees` 只挑 type==='person'，
  // 没有任何消费方读 player.life_state（AGENTS §5.3：没有消费方的预留路径会变成假的）。
  const pName = str(playerName);
  const pId = str(playerId);
  const isPlayerCard = (c) => !!c.is_player
    || (!!pId && (c.id === pId || c.name === pId))
    || (!!pName && (c.name === pName || c.id === pName));

  const goneIds = new Set();
  for (const c of nextCast) {
    if (isPlayerCard(c)) continue;
    const charState = characters[c.name] || characters[c.id] || {};
    const life = str(c.life_state) || str(charState.life_state);
    const status = str(c.status) || str(charState.condition) || str(charState.status);
    const isDead = life ? life === 'dead' : DEAD_MARKERS.some((m) => status.includes(m));
    const isGone = life ? life === 'gone' : GONE_MARKERS.some((m) => status.includes(m));
    if (isDead || isGone) {
      goneIds.add(c.id);
      goneIds.add(c.name);
      fixes.push({
        kind: isDead ? 'remove_dead_from_present' : 'remove_gone_from_present',
        who: c.name,
        reason: status || life,
        source: life ? 'life_state' : 'status_keyword',
      });
    }
  }
  if (goneIds.size) {
    if (nextPresent) nextPresent = nextPresent.filter((w) => !goneIds.has(w) && !goneIds.has(str(w)));
    nextCast = nextCast.filter((c) => !goneIds.has(c.id) && !goneIds.has(c.name));
  }

  /* ---- 2. 同一角色出现在两个地点 ---- */
  const placeOf = new Map();
  for (const c of nextCast) {
    const place = str(characters[c.name]?.location) || str(characters[c.id]?.location) || str(c.location);
    if (!place) continue;
    if (placeOf.has(c.name) && placeOf.get(c.name) !== place) {
      warnings.push({
        kind: 'two_places',
        who: c.name,
        detail: `${placeOf.get(c.name)} 与 ${place}`,
      });
    } else {
      placeOf.set(c.name, place);
    }
  }

  /* ---- 3. 随身物品的持有者不在场 ---- */
  const presentNames = new Set(nextCast.flatMap((c) => [c.id, c.name]));
  for (const item of L.inventory || []) {
    const holder = str(item?.holder);
    if (!holder) continue;
    if (!presentNames.has(holder)) {
      warnings.push({ kind: 'item_holder_absent', who: holder, detail: str(item?.name) });
    }
  }

  /* ---- 4. 单值谓词在同一时刻有多个有效对象 ---- */
  const singleMap = new Map();
  for (const a of assertions || []) {
    if (str(a.status) && str(a.status) !== 'active') continue;
    const key = `${str(a.subject)}::${str(a.predicate)}`;
    if (!singleMap.has(key)) singleMap.set(key, new Set());
    singleMap.get(key).add(str(a.object));
  }
  // 只有「已知是单值」的谓词才检查；这里由调用方传入的断言自带 cardinality 语义，
  // 为避免重复维护词表，只报「同一主谓出现多个不同宾语」这一事实，不擅自失效。
  for (const [key, objects] of singleMap) {
    if (objects.size > 1) {
      const [subject, predicate] = key.split('::');
      warnings.push({
        kind: 'multi_object_single_predicate',
        who: subject,
        detail: `${predicate} → ${[...objects].join('、')}`,
      });
    }
  }

  /* ---- 5. 场次时间没有前进 ---- */
  const last = (scenes || [])[scenes.length - 1];
  if (last && Number(turnNo) > 0 && Number(last.turn_to) >= Number(turnNo)) {
    warnings.push({
      kind: 'scene_not_advancing',
      detail: `场次 ${last.scene_id} 覆盖到第 ${last.turn_to} 轮，当前已是第 ${turnNo} 轮`,
    });
  }

  return {
    fixes,
    warnings,
    ledger: { ...L, characters, ...(nextPresent ? { present: nextPresent } : {}) },
    present: nextCast,
  };
}
