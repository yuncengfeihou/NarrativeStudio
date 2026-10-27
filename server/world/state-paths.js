/**
 * server/world/state-paths.js — world_state 允许的实体路径
 *
 * 记忆整理提案与 EffectiveWorld 投影共用这一份白名单，避免「能写进去但渲染不出来」
 * 或「渲染器支持但校验器拒绝」的漂移。身份根（id/name/identity）不在表内，
 * 它们属于世界卡公理，运行期不可改写。
 *
 * v5 起实体分两族：person（有 voice/psyche/agenda/relations）与世界事实（其余 type）。
 * 写路径按实体 type 分派；人物、事实、玩家、世界四套互不串写。
 */
import { ENTITY_TYPES, PERSON_TYPE } from './schema.js';

const PERSON_SCALARS = [
  'status', 'condition', 'mood', 'location', 'goal', 'summary', 'role',
  // 受控词表（alive / injured / dead / gone）：死亡/离场需要「能被代码可靠判定」，
  // 不能只靠 status 自由文本。见 prompts/archivist.js 的 LIFE_STATES。
  'life_state',
];

/**
 * 世界事实的定义（summary / detail / facets.history）是作者公理，运行期不可写；
 * 运行期只写「此刻如何」的字段。新实体第一次 introduce 时仍可写定义。
 */
export const FACT_CANON_PATHS = new Set(['summary', 'detail', 'facets.history']);

const FACT_SCALARS = [
  'status', 'condition', 'access', 'open_to', 'owner_id', 'location_id',
  'reveal', 'facets.sensory',
];

const PLAYER_SCALARS = [
  'situation', 'capability', 'inner_voice', 'wants', 'afraid', 'age', 'identity',
  'status', 'condition', 'mood', 'location', 'goal', 'life_state',
];

// 时间/地点/天气/张力属于场次账本（states），不在这里重复维护。
const WORLD_SCALARS = ['status'];

/**
 * 数值路径：只有这些路径的值是数字，也只有它们允许 `op='delta'`（由代码做加减）。
 *
 * 为什么要有这一族：长跑实测里模型「自己算完再报结果」的金额 6 次面额拆解 6 次算不平
 * （最大偏差 −25.7），而它本来就不该做算术——模型只声明「花了 60」，加減由代码做。
 *
 * 两条纪律：
 *   ① 路径是不是数值**由这张表决定**，不由模型吐出的字面量类型决定。模型写
 *      `{"path":"status","value":5}` 不能把 status 变成数字。
 *   ② 与 LIST_PATH_SET 不相交；除 money 外不再预留「以后可能有用」的数值路径——
 *      没有消费方的预留路径会变成「看起来生效、实际没有」（AGENTS §9 WORLD_TICK_EVERY 前科）。
 */
const PERSON_NUMBER_PATHS = [];
const FACT_NUMBER_PATHS = [];
// 玩家的银钱：数值路径族，由下面的 PLAYER_PATHS 一并放行（不需要再抄进 PLAYER_SCALARS）。
const PLAYER_NUMBER_PATHS = ['money'];
export const NUMBER_PATH_SET = new Set([
  ...PERSON_NUMBER_PATHS, ...FACT_NUMBER_PATHS, ...PLAYER_NUMBER_PATHS,
]);

/** 只能用 add / remove 的列表路径。按实体族分开，避免把事实字段写到人物上。 */
const PERSON_LIST_PATHS = [
  'knowledge.knows', 'knowledge.does_not_know', 'knowledge.believes_falsely',
  'psyche.wants', 'psyche.fears', 'psyche.hides', 'psyche.values',
  'aliases',
];
const FACT_LIST_PATHS = [
  'aliases', 'tags', 'links', 'facets.rules', 'facets.consequences',
];
const PLAYER_LIST_PATHS = ['knowledge.knows', 'knowledge.does_not_know'];

const PERSON_PATHS = new Set([...PERSON_SCALARS, ...PERSON_LIST_PATHS, ...PERSON_NUMBER_PATHS]);
const FACT_PATHS = new Set([...FACT_SCALARS, ...FACT_LIST_PATHS, ...FACT_NUMBER_PATHS]);
// FACT_CANON_PATHS 不在 FACT_PATHS 内：已有条目只能通过 introduce 写定义。
const PLAYER_PATHS = new Set([...PLAYER_SCALARS, ...PLAYER_LIST_PATHS, ...PLAYER_NUMBER_PATHS]);
const WORLD_PATHS = new Set(WORLD_SCALARS);
export const LIST_PATH_SET = new Set([
  ...PERSON_LIST_PATHS, ...FACT_LIST_PATHS, ...PLAYER_LIST_PATHS,
]);

/** 实体 kind：人物的类型值 + 事实类型值 + 玩家/世界两个非卡片主体。 */
export const ENTITY_KINDS = [...ENTITY_TYPES, 'player', 'world'];

export function pathsFor(kind) {
  if (kind === PERSON_TYPE) return PERSON_PATHS;
  if (kind === 'player') return PLAYER_PATHS;
  if (kind === 'world') return WORLD_PATHS;
  if (ENTITY_TYPES.includes(kind)) return FACT_PATHS;
  return null;
}

/**
 * 该 (实体族, 路径) 是不是数值路径。校验器与投影器共用这一个判定，
 * 避免「校验放行、投影当字符串」或反过来。
 */
export function isNumberPath(kind, path) {
  return NUMBER_PATH_SET.has(path) && !!pathsFor(kind)?.has(path);
}
