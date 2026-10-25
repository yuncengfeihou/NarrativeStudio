/**
 * server/world/fates.js — 成长曲线的确定性解锁器（纯函数）
 *
 * 「未来固定」是同人改编卡的核心资产：原著里已经写好了角色怎么变。
 * 但把原著后续当成「必达节拍」会让演绎变成剧本复述，把未来的成长直接写进
 * `cast.role` 又是剧透。所以未来必须以**第三条形式**存在：
 *
 *   阶段 + 确定性解锁条件 + 解锁后的增量 + 一行「预兆」
 *
 * 运行期只做两件事：
 *   1. `evaluateFates()` 读当前账本，用**代码**判断哪些阶段已经解锁；
 *   2. `applyFates()` 把已解锁阶段的 `change` 投影进 effective world。
 *
 * 它不调模型、不新增注入通道、不动 `world_state`。
 * 为什么不用「命运 Agent」：那等于每场重写一次大纲，1000 轮后必然漂移到
 * 作者没写过的地方，而作者无处可改、测试无法断言、fork 后各分支不可比。
 *
 * 没有 `fates` 的卡（全部原创卡、以及所有旧卡）走同一条路径，行为与今天完全一致。
 */

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/**
 * 判定单个 unlock 条件。
 *
 * 所有子条件之间是 AND；`any_of` / `all_of` 是嵌套组合。
 * 空条件 = 无条件（只靠 after_turn 或什么都不靠）。
 *
 * @returns {boolean}
 */
export function checkUnlock(unlock, ctx) {
  if (!isObj(unlock)) return true;
  const { turnNo = 0, ledger = {}, assertions = [], relations = [], charStates = {} } = ctx || {};

  if (num(unlock.after_turn, 0) > 0 && turnNo < num(unlock.after_turn, 0)) return false;

  // 账本里必须已经出现过的事件 id（由 orchestrator 写进 ledger.events 时才有意义）
  const seenEvents = new Set(asArray(ledger.events).map((e) => String(isObj(e) ? e.id : e)));
  for (const ev of asArray(unlock.after_events)) {
    if (!seenEvents.has(String(ev))) return false;
  }

  // 必须已经成立的断言（走现有 predicates 词表，不新增语义）
  for (const claim of asArray(unlock.claims)) {
    if (!isObj(claim)) continue;
    const hit = (assertions || []).some((a) => a.status !== 'invalidated'
      && String(a.subject) === String(claim.subject || '')
      && String(a.predicate) === String(claim.predicate || '')
      && (claim.object == null || String(a.object) === String(claim.object)));
    if (!hit) return false;
  }

  // 该角色必须已经知道的事
  const knows = new Set([
    ...asArray(charStates.knows),
    ...asArray(ledger.knows),
  ].map(String));
  for (const k of asArray(unlock.knowledge)) {
    if (!knows.has(String(k))) return false;
  }

  // 关系阈值：{ to, kind?, sentiment_gte? }
  for (const rule of asArray(unlock.min_relation)) {
    if (!isObj(rule)) continue;
    const rel = (relations || []).find((r) => String(r.to_name) === String(rule.to || '')
      || String(r.to) === String(rule.to || ''));
    if (!rel) return false;
    if (rule.kind && String(rel.kind) !== String(rule.kind)) return false;
    if (rule.sentiment_gte != null && num(rel.sentiment, 0) < num(rule.sentiment_gte, 0)) return false;
  }

  if (asArray(unlock.any_of).length) {
    const ok = asArray(unlock.any_of).some((u) => checkUnlock(u, ctx));
    if (!ok) return false;
  }
  if (asArray(unlock.all_of).length) {
    const ok = asArray(unlock.all_of).every((u) => checkUnlock(u, ctx));
    if (!ok) return false;
  }
  return true;
}

/**
 * 求出当前时刻已解锁的成长阶段。
 *
 * 同一角色的多个阶段按 `stage` 升序；**只有前面的阶段都解锁，后面才算解锁**
 * （成长是路径依赖的，不能跳过 stage 1 直接到 stage 3）。
 *
 * @param {object} card   世界卡（含 card.fates，可缺省）
 * @param {object} ctx    {turnNo, ledger, assertions, relations, charStates}
 * @returns {{unlocked:Array, meta:object}}
 */
export function evaluateFates(card, ctx = {}) {
  const fates = asArray(card?.fates);
  const meta = { total: fates.length, unlocked: 0, skipped_by_order: 0 };
  if (!fates.length) return { unlocked: [], meta };

  // 按 who 分组并排序
  const byWho = new Map();
  for (const f of fates) {
    if (!isObj(f) || !f.who) continue;
    const who = String(f.who);
    if (!byWho.has(who)) byWho.set(who, []);
    byWho.get(who).push(f);
  }

  const unlocked = [];
  for (const [, stages] of byWho) {
    const sorted = stages.slice().sort((a, b) => num(a.stage, 1) - num(b.stage, 1));
    for (const f of sorted) {
      if (!checkUnlock(f.unlock, ctx)) break; // 阶段依赖：前一个没解锁，后面就都不到
      if (String(f.visibility || 'engine') === 'author') continue; // 只给作者看，不进演绎
      unlocked.push(f);
    }
    const reached = unlocked.filter((u) => String(u.who) === String(sorted[0].who)).length;
    if (reached < sorted.length) meta.skipped_by_order += sorted.length - reached;
  }

  meta.unlocked = unlocked.length;
  return { unlocked, meta };
}

/**
 * 把已解锁阶段的 `change` 应用到 effective world 上。
 *
 * 优先级：**运行期 world_state > fates > 卡初始值**。
 * `touched` 是运行期已经显式写过的 `${entity_id}::${path}` 集合；
 * 落在其中的标量路径，fates **不得覆盖**——否则剧情里造就的变化会被卡里的
 * 预设轨迹抹掉。列表类增量（wants_add 等）是「追加」，不参与这个互斥。
 *
 * @param {object} world  已经投影过 world_state 的 effective world
 * @param {Array}  unlocked  evaluateFates() 的结果
 * @param {{touched?:Set<string>}} [opts]
 * @returns {object} 同一个 world（原地修改，调用方本来就持有副本）
 */
export function applyFates(world, unlocked = [], { touched = null } = {}) {
  if (!world || !unlocked.length) return world;
  const blocked = (id, path) => Boolean(touched && touched.has(`${id}::${path}`));

  for (const f of unlocked) {
    const change = isObj(f.change) ? f.change : {};
    const who = String(f.who);
    const target = (world.entities || []).find((c) => c.type === 'person'
      && (c.id === who || c.name === who || (c.aliases || []).includes(who)));
    if (!target) continue;
    const eid = target.id;

    if (change.role && !blocked(eid, 'role')) target.role = String(change.role);
    const summary = change.summary || change.one_line;
    if (summary && !blocked(eid, 'summary')) target.summary = String(summary);

    if (isObj(change.voice)) {
      if (change.voice.rhythm && !blocked(eid, 'voice.rhythm')) {
        target.voice.rhythm = String(change.voice.rhythm);
      }
      for (const k of ['lexicon_add']) {
        const add = asArray(change.voice[k]).map(String);
        const cur = new Set(target.voice.lexicon || []);
        for (const v of add) cur.add(v);
        target.voice.lexicon = [...cur];
      }
      for (const k of ['never_add']) {
        const add = asArray(change.voice[k]).map(String);
        const cur = new Set(target.voice.never || []);
        for (const v of add) cur.add(v);
        target.voice.never = [...cur];
      }
    }

    if (isObj(change.psyche)) {
      const map = { wants_add: 'wants', fears_add: 'fears', hides_add: 'hides', values_add: 'values' };
      for (const [src, dst] of Object.entries(map)) {
        const add = asArray(change.psyche[src]).map(String);
        if (!add.length) continue;
        const cur = new Set(target.psyche[dst] || []);
        for (const v of add) cur.add(v);
        target.psyche[dst] = [...cur];
      }
    }

    if (isObj(change.knowledge)) {
      const map = { knows_add: 'knows', believes_falsely_add: 'believes_falsely' };
      for (const [src, dst] of Object.entries(map)) {
        const add = asArray(change.knowledge[src]).map(String);
        if (!add.length) continue;
        const cur = new Set(target.knowledge[dst] || []);
        for (const v of add) cur.add(v);
        target.knowledge[dst] = [...cur];
      }
    }

    for (const a of asArray(change.agenda_add)) {
      if (!isObj(a) || !a.goal) continue;
      target.agenda = target.agenda || [];
      if (!target.agenda.some((x) => x.goal === a.goal)) {
        target.agenda.push({
          goal: String(a.goal),
          method: String(a.method || ''),
          pressure: Math.max(0, Math.min(1, num(a.pressure, 0.5))),
          deadline: String(a.deadline || ''),
        });
      }
    }

    for (const r of asArray(change.relations_set)) {
      if (!isObj(r) || !r.to) continue;
      target.relations = target.relations || [];
      const rel = {
        to: String(r.to),
        kind: String(r.kind || ''),
        sentiment: Math.max(-1, Math.min(1, num(r.sentiment, 0))),
        note: String(r.note || ''),
      };
      const idx = target.relations.findIndex((x) => x.to === rel.to);
      if (idx >= 0) target.relations[idx] = rel;
      else target.relations.push(rel);
    }
  }
  return world;
}

/**
 * 取「可以进提示词」的预兆：只取已解锁、且在场者的，每人最多一条、全员最多 `limit` 条。
 * `omen` 是唯一进上下文的文本，它写倾向、不写结局。
 *
 * 每人一条是有意的约束：预兆是「压力」的一个来源，不是人物小传。
 * 同一角色列出多条会让模型把它当成必达的剧情清单。
 */
export function renderOmens(unlocked = [], presentNames = new Set(), limit = 2) {
  const out = [];
  const seen = new Set();
  for (const f of unlocked) {
    const who = String(f.who);
    if (!presentNames.has(who) || seen.has(who)) continue;
    const text = asArray(f.omen).map((o) => String(o || '').trim()).find(Boolean);
    if (!text) continue;
    seen.add(who);
    out.push({ who, stage: num(f.stage, 1), text });
    if (out.length >= limit) return out;
  }
  return out;
}
