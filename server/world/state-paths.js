/**
 * server/world/state-paths.js — world_state 允许的实体路径
 *
 * 史官提案与 EffectiveWorld 投影共用这一份白名单，避免「能写进去但渲染不出来」
 * 或「渲染器支持但校验器拒绝」的漂移。身份根（id/name/identity）不在表内，
 * 它们属于世界卡公理，运行期不可改写。
 */

const CAST_SCALARS = [
  'status', 'condition', 'mood', 'location', 'goal', 'one_line', 'role',
];

/**
 * 辞书的定义（summary / detail / facets.history）是作者公理，运行期不可写；
 * 运行期只写「此刻如何」的字段。新实体第一次 introduce 时仍可写定义。
 */
export const CODEX_CANON_PATHS = new Set(['summary', 'detail', 'facets.history']);

const CODEX_SCALARS = [
  'status', 'condition', 'access', 'open_to', 'owner_id', 'location_id',
  'reveal', 'facets.sensory',
];

const PLAYER_SCALARS = [
  'situation', 'capability', 'inner_voice', 'wants', 'afraid', 'age', 'identity',
  'status', 'condition', 'mood', 'location', 'goal',
];

// 时间/地点/天气/张力属于场次账本（states），不在这里重复维护。
const WORLD_SCALARS = ['status'];

/** 只能用 add / remove 的列表路径。按实体类型分开，避免把辞书字段写到人物上。 */
const CAST_LIST_PATHS = [
  'knowledge.knows', 'knowledge.does_not_know', 'knowledge.believes_falsely',
  'psyche.wants', 'psyche.fears', 'psyche.hides', 'psyche.values',
  'aliases',
];
const CODEX_LIST_PATHS = [
  'aliases', 'tags', 'links', 'facets.rules', 'facets.consequences',
];
const PLAYER_LIST_PATHS = ['knowledge.knows', 'knowledge.does_not_know'];

export const CAST_PATHS = new Set([...CAST_SCALARS, ...CAST_LIST_PATHS]);
export const CODEX_PATHS = new Set([...CODEX_SCALARS, ...CODEX_LIST_PATHS]);
// CODEX_CANON_PATHS 不在 CODEX_PATHS 内：已有条目只能通过 introduce 写定义。
export const PLAYER_PATHS = new Set([...PLAYER_SCALARS, ...PLAYER_LIST_PATHS]);
export const WORLD_PATHS = new Set(WORLD_SCALARS);
export const LIST_PATH_SET = new Set([
  ...CAST_LIST_PATHS, ...CODEX_LIST_PATHS, ...PLAYER_LIST_PATHS,
]);

export const ENTITY_KINDS = ['cast', 'codex', 'player', 'world'];

export function pathsFor(kind) {
  if (kind === 'cast') return CAST_PATHS;
  if (kind === 'codex') return CODEX_PATHS;
  if (kind === 'player') return PLAYER_PATHS;
  if (kind === 'world') return WORLD_PATHS;
  return null;
}
