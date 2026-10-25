/**
 * server/memory/player-view.js — 玩家可见状态投影（纯函数）
 *
 * 规则：状态条只展示「已经在演出里出现过」的场景字段——时间 / 地点 / 天气 / 在场。
 * 账本里的人物心境、目标、关系、物品、任务、张力、last_hook 一律不投影：
 * 那些是史官给模型装配场记单用的派生数据，常驻展示既会剧透，也会把概率性抽取
 * 抬成与正文同等的「既定事实」。
 *
 * 不变量：
 *   - 这是展示层投影，不参与 assembleContext，不占 §6.3 的层预算，没有模型调用；
 *   - 只读传入的账本，不落库、不写 world_state、不碰分支；
 *   - 字段白名单写死在这里，过滤必须在服务端完成（前端过滤等于秘密已经出网）；
 *     前端不得改从 GET /api/sessions/:id 的 state 里自行取材。
 */

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * 账本 present 里存的是角色 id 或名字（史官写名字，锚点快照写 id），
 * 展示前统一归一成卡司显示名；不在卡司里的原样保留。
 */
function buildNameLookup(persons) {
  const lookup = new Map();
  for (const member of Array.isArray(persons) ? persons : []) {
    if (!member) continue;
    const name = text(member.name);
    if (!name) continue;
    const keys = [member.id, name, ...(Array.isArray(member.aliases) ? member.aliases : [])];
    for (const key of keys) {
      const normalized = text(key);
      if (normalized && !lookup.has(normalized)) lookup.set(normalized, name);
    }
  }
  return lookup;
}

/**
 * 把账本投影成状态条数据。
 * @param {object|null|undefined} ledger  states.state_json 的形状（见 mergeLedger）
 * @param {{persons?: object[]}} [options]   人物实体（用于把 present 里的 id/别名归一成显示名）
 * @returns {{time: string, place: string, weather: string, present: string[]}}
 */
export function buildPlayerView(ledger, { persons = [] } = {}) {
  const state = ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {};
  const nameOf = buildNameLookup(persons);
  const present = Array.isArray(state.present)
    ? [...new Set(state.present.map((who) => nameOf.get(text(who)) || text(who)).filter(Boolean))]
    : [];
  return {
    time: text(state.time),
    place: text(state.place),
    weather: text(state.weather),
    present,
  };
}
