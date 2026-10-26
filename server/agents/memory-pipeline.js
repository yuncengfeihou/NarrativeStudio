/**
 * server/agents/memory-pipeline.js — 场记 / 校勘 / 检索 / 世界呼吸
 *
 * 与史官（archivist.js）同属记忆系统，但职责不同：
 *
 *   scene-keeper  场次记录。从**完整原文**重写，不是摘要的摘要——防漂移的关键。
 *   continuity    校勘。查矛盾、知识越界、别名冲突、时间线、陈旧线索。只报问题。
 *   librarian     检索。按需工具循环，交回带出处的原文片段。找不到就说找不到。
 *   world-tick    世界呼吸。玩家看不见的地方，人物按自己的私心行动。
 *
 * 全部遵循同一条铁律：**Agent 只提案，代码才落库。**
 */
import { config } from '../config.js';
import { chat } from '../llm.js';
import { currentPlan } from '../memory/context-plan.js';
import { buildAliasIndex, normalizeCard, PERSON_TYPE, resolveEntity } from '../world/schema.js';
import { pathsFor } from '../world/state-paths.js';
import {
  addPatch, addScene, addWorldState, getAssertions, getBranch, getCharStateMap, getRelations, getScenes,
  getState, getThreads, getTurnsForBranch, invalidateAssertion, latestScene,
  searchAssertions, searchTurns, setCharState, upsertThread,
} from '../memory/store.js';
import {
  continuitySystemPrompt, continuityUserPrompt, librarianSystemPrompt, librarianUserPrompt,
  sceneKeeperSystemPrompt, sceneKeeperUserPrompt, worldTickSystemPrompt, worldTickUserPrompt,
} from '../prompts/archivist.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

function tryParseJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* 降级 */ } }
  return null;
}

/** 会话的分支上下文。 */
function branchCtx(session) {
  const sessionId = session.id;
  const branchId = session.branch_id || 'main';
  const branch = getBranch(sessionId, branchId);
  return { sessionId, branchId, forkTurn: branch ? branch.fork_turn : Number.MAX_SAFE_INTEGER };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 1. 场记（Scene Keeper）                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 一场戏结束时调用：读这一场的完整原文，写一行场次记录。
 * 记录是检索入口，不是摘要——它必须能让人判断「这场里有什么」。
 */
/**
 * 一场戏结束时调用：读这一场的完整原文，写一行场次记录。
 * 记录是长程记忆的载体，不是摘要——它必须能让人（和模型）判断「这场里有什么」。
 *
 * 三条不变量：
 * - 输入是本场**完整原文**，不是摘要，也不是上一个场次记录；
 * - 关闭后不可变（同一 scene_id 只会在追加轮次时扩展 turn_to）；
 * - 字段要够具体：「八万」而不是「一大笔钱」。
 */
export async function closeScene({ session, world, turnNo, reason = '', guard }) {
  const { sessionId, branchId, forkTurn } = branchCtx(session);
  const prev = latestScene(sessionId, branchId);
  const from = prev ? prev.turn_to + 1 : 1;
  if (turnNo < from) return null;

  const rows = getTurnsForBranch(sessionId, branchId, forkTurn, { from, to: turnNo });
  if (!rows.length) return null;

  const ledger = getState(sessionId, { branchId, atTurn: turnNo })?.state || {};
  const sceneNo = (prev ? Number(String(prev.scene_id).replace(/\D/g, '')) || 0 : 0) + 1;
  const sceneId = `S${String(sceneNo).padStart(3, '0')}`;

  let record = {
    question: '', outcome: '', threads: [], key_detail: '', causal: '', hooks: [],
  };
  let usage = null;
  try {
    const res = await chat({
      agent: 'sceneKeeper',
      messages: [
        { role: 'system', content: sceneKeeperSystemPrompt() },
        {
          role: 'user',
          content: sceneKeeperUserPrompt({
            sceneId, turnFrom: from, turnTo: turnNo,
            when: ledger.time, place: ledger.place,
            cast: Object.keys(ledger.characters || {}),
            previous: prev ? { scene_id: prev.scene_id, outcome: prev.outcome, hooks: prev.hooks } : null,
            turns: rows.map((r) => ({ turn_no: r.turn_no, kind: r.kind, content: r.content })),
          }),
        },
      ],
      temperature: null,
      maxTokens: null,
      reasoningEffort: null,
      responseFormat: { type: 'json_object' },
    });
    usage = res.usage || null;
    const parsed = obj(tryParseJson(res.content));
    record = {
      question: str(parsed.question).slice(0, 60),
      outcome: str(parsed.outcome).slice(0, 120),
      threads: arr(parsed.threads).map(str).filter(Boolean).slice(0, 8),
      key_detail: str(parsed.key_detail).slice(0, 120),
      causal: str(parsed.causal).slice(0, 120),
      hooks: arr(parsed.hooks).map(str).filter(Boolean).slice(0, 6),
    };
  } catch (err) {
    console.warn(`[scene-keeper] LLM 失败，降级为纯结构记录：${err?.message || err}`);
  }

  if (typeof guard === 'function' && !guard()) return null;

  // 重要度由确定性规则判定，不靠模型自评：
  // 有具体细节 / 有钩子 / 有线索变化 / 有剧本级转折（question 非空）→ major。
  const importance = (record.key_detail || record.hooks.length || record.threads.length)
    ? 'major'
    : (record.question || record.outcome ? 'normal' : 'minor');

  const sceneRow = {
    branch_id: branchId,
    scene_id: sceneId,
    level: 1,
    turn_from: from,
    turn_to: turnNo,
    when_label: str(ledger.time),
    place: str(ledger.place),
    place_id: str(ledger.place_id),
    cast: Object.keys(ledger.characters || {}),
    question: record.question,
    outcome: record.outcome,
    key_detail: record.key_detail,
    causal: record.causal,
    importance,
    threads: record.threads,
    hooks: record.hooks,
    state: ledger,
  };
  addScene(sessionId, sceneRow);

  addPatch(sessionId, {
    branch_id: branchId, agent: 'scene-keeper', kind: 'scene', turn_no: turnNo, status: 'applied',
    payload: { scene_id: sceneId, importance, ...record }, evidence: reason,
  });
  // 返回给调用方的字段里必须带 place / when_label：切场事件是「时间轴」实时刷新的唯一信源，
  // 只回 question/outcome 会让前端拿到一张没有时间地点的场次卡。
  return {
    scene_id: sceneId, turn_from: from, turn_to: turnNo, importance,
    when_label: sceneRow.when_label, place: sceneRow.place, place_id: sceneRow.place_id,
    cast: sceneRow.cast,
    ...record, usage,
  };
}

/**
 * 是否需要切场。
 *
 * 三种触发：史官报告场景变化 / 地点变了 / **到了强制封场上限**。
 *
 * 强制封场是关键补充：`SCENE_EVERY=0` 时只有地点变化才切，于是角色在同一个地点
 * 待 100 轮就一场都不关，「最近一场」永远未归档，场次索引根本建不起来。
 * token 上限同理：单场原文无限增长会把场记 Agent 的输入撑爆。
 */
export function detectSceneChange(session, update, turnNo) {
  const { sessionId, branchId, forkTurn } = branchCtx(session);
  const prev = latestScene(sessionId, branchId);
  if (!prev) return true;
  const sc = update?.scene_change || {};
  if (sc.changed) return true;
  const ledger = getState(sessionId, { branchId, atTurn: turnNo })?.state || {};
  if (str(ledger.place) && str(prev.place) && str(ledger.place) !== str(prev.place)) return true;

  // 强制封场：按轮数
  const every = config.context.sceneEvery;
  if (every > 0 && turnNo > 0 && turnNo - prev.turn_from + 1 >= every) return true;

  // 强制封场：按本场原文 token（场记 Agent 的输入不能无限增长）。
  // 上限同时受两个约束：显式 SCENE_MAX_TOKENS，以及「逐字原文的规划配额」——
  // 后者从模型窗口推导。小窗口模型会在原文撑爆提示词之前就封场，
  // 而不是等硬上限 fail-closed 才报错。原文本身永不按 token 裁剪（那是静默失忆）。
  const sceneMax = config.context.sceneMaxTokens;
  const planRecent = Math.max(4000, currentPlan({ session }).layers.recent);
  const maxTokens = sceneMax > 0 ? Math.min(sceneMax, planRecent) : planRecent;
  if (maxTokens > 0) {
    const rows = getTurnsForBranch(sessionId, branchId, forkTurn, {
      from: prev.turn_to + 1, to: turnNo, kinds: ['player', 'narrator'],
    });
    const tokens = rows.reduce((sum, r) => sum + (Number(r.token_count) || 0), 0);
    if (tokens >= maxTokens) return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 2. 校勘（Continuity）                                                  */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 定期检查记忆账本与最近原文。只报问题 + 给最小补丁建议；
 * 安全的补丁（invalidate_assertion / set_state / resolve_thread）由代码直接应用，
 * 其余留在 patches 表里给人看。
 */
export async function runContinuity({ session, world, turnNo, signal, guard }) {
  const { sessionId, branchId, forkTurn } = branchCtx(session);
  const card = normalizeCard(world?.card || {});
  const aliasIndex = buildAliasIndex(card);
  const playerName = card.player?.name || '';

  const assertions = getAssertions(sessionId, { branchId, limit: 200 });
  const states = getCharStateMap(sessionId, { branchId });
  const threads = getThreads(sessionId, { branchId, limit: 40 });
  const rows = getTurnsForBranch(sessionId, branchId, forkTurn, { from: Math.max(1, turnNo - 12), to: turnNo });
  const recentText = rows.map((r) => `第${r.turn_no}轮${r.kind === 'player' ? '（玩家）' : ''}：${r.content}`).join('\n\n');
  if (!recentText) return { issues: [], healthy: [] };

  let parsed = {};
  let usage = null;
  try {
    const res = await chat({
      agent: 'continuity',
      messages: [
        { role: 'system', content: continuitySystemPrompt() },
        {
          role: 'user',
          content: continuityUserPrompt({
            turnFrom: Math.max(1, turnNo - 12), turnTo: turnNo,
            assertions, states, threads, recentText,
          }),
        },
      ],
      temperature: null,
      maxTokens: null,
      reasoningEffort: null,
      responseFormat: { type: 'json_object' },
      signal,
    });
    usage = res.usage || null;
    parsed = obj(tryParseJson(res.content));
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.warn(`[continuity] LLM 失败：${err?.message || err}`);
    return { issues: [], healthy: [], error: err?.message || String(err) };
  }

  const issues = arr(parsed.issues)
    .map((raw) => {
      const o = obj(raw);
      const fix = obj(o.fix);
      return {
        kind: str(o.kind) || 'contradiction',
        severity: ['blocker', 'major', 'minor'].includes(o.severity) ? o.severity : 'minor',
        subject: str(o.subject),
        claim: str(o.claim).slice(0, 200),
        evidence: str(o.evidence).slice(0, 300),
        fix: {
          action: str(fix.action) || 'none',
          target: str(fix.target),
          value: str(fix.value).slice(0, 200),
        },
      };
    })
    .filter((i) => i.claim);

  // 分支守卫：审查是异步的，落补丁前核对分支/回合没变。
  if (typeof guard === 'function' && !guard()) {
    return { issues: [], healthy: [], applied: 0, stale: true };
  }

  /* ---- 应用安全补丁 ---- */
  let applied = 0;
  const maxApplied = config.context.continuityMaxApplied;
  for (const issue of issues) {
    const { action, target, value } = issue.fix;
    let status = 'open';
    // 单次校勘最多自动落库 N 条；超出的保留为 open，交给人或下一次校勘。
    if (applied >= maxApplied) {
      addPatch(sessionId, {
        branch_id: branchId, agent: 'continuity', kind: issue.kind, turn_no: turnNo, status: 'open',
        severity: issue.severity, payload: issue, evidence: issue.evidence,
      });
      continue;
    }
    if (action === 'invalidate_assertion' && /^\d+$/.test(target)) {
      invalidateAssertion(sessionId, Number(target), { validTo: turnNo });
      status = 'applied';
      applied++;
    } else if (action === 'set_state' && issue.subject && value) {
      const [who, field] = target.includes('::') ? target.split('::') : [issue.subject, 'condition'];
      setCharState(sessionId, { branchId, who, field, value, turn: turnNo });
      const ref = resolveEntity(who, aliasIndex);
      const isPlayer = who === playerName;
      const kind = isPlayer ? 'player' : (ref.type || PERSON_TYPE);
      // 校勘模型可能给出任意字段；只有投影器认识的路径才写进世界状态。
      if (pathsFor(kind)?.has(field)) {
        addWorldState(sessionId, {
          branch_id: branchId,
          entity_kind: kind,
          entity_id: isPlayer ? 'player' : (ref.id || who),
          path: field,
          op: 'set',
          value,
          turn: turnNo,
          source: 'continuity',
          evidence: issue.evidence,
        });
      }
      status = 'applied';
      applied++;
    } else if (action === 'resolve_thread' && target) {
      const hit = threads.find((t) => t.title === target);
      if (hit) {
        upsertThread(sessionId, {
          branch_id: branchId, title: hit.title, status: 'resolved',
          resolved_turn: turnNo, turn_no: turnNo,
        });
        status = 'applied';
        applied++;
      }
    }
    addPatch(sessionId, {
      branch_id: branchId, agent: 'continuity', kind: issue.kind, turn_no: turnNo, status,
      severity: issue.severity, payload: issue, evidence: issue.evidence,
    });
  }

  return { issues, healthy: arr(parsed.healthy).map(str).filter(Boolean), applied, usage };
}

/** 供 UI 的 canon 健康度：最近未处理的补丁 + 断言规模。 */
const TOOLS = {
  search_events: (sessionId, branchId, args) => searchTurns(sessionId, str(args.query), { branchId, limit: Number(args.limit) || 6 }),
  search_assertions: (sessionId, branchId, args) => searchAssertions(sessionId, str(args.query), { branchId, limit: Number(args.limit) || 10 }),
  get_character_state: (sessionId, branchId, args) => {
    const map = getCharStateMap(sessionId, { branchId });
    const who = str(args.who);
    return map[who] ? [{ who, ...map[who] }] : [];
  },
  get_threads: (sessionId, branchId, args) => {
    const status = str(args.status) || 'all';
    return getThreads(sessionId, { branchId, status: status === 'all' ? null : status, limit: 30 })
      .map((t) => ({ title: t.title, status: t.status, note: t.note, planted_turn: t.planted_turn }));
  },
  get_scene: (sessionId, branchId, args) => {
    const rows = getScenes(sessionId, { branchId, limit: 200 });
    const turn = Number(args.turn_no);
    const hit = rows.find((s) => s.turn_from <= turn && s.turn_to >= turn);
    return hit ? [{ scene_id: hit.scene_id, turn_from: hit.turn_from, turn_to: hit.turn_to, question: hit.question, outcome: hit.outcome }] : [];
  },
  get_relations: (sessionId, branchId, args) => {
    const who = str(args.who);
    return getRelations(sessionId, { branchId, limit: 60 })
      .filter((r) => !who || r.from_name === who || r.to_name === who)
      .map((r) => ({
        from: r.from_name, to: r.to_name, kind: r.kind,
        sentiment: r.sentiment, note: r.note, turn_no: r.turn_no,
      }));
  },
  search_claims: (sessionId, branchId, args) => getAssertions(sessionId, {
    branchId,
    subject: str(args.subject) || null,
    predicate: str(args.predicate) || null,
    limit: 20,
  }).map((a) => ({
    subject: a.subject, predicate: a.predicate, object: a.object,
    status: a.status, asserted_turn: a.asserted_turn,
  })),
};

/**
 * 跑一次检索。最多 3 次工具调用，第 4 次必须交答案。
 * @returns {Promise<{found:boolean, answer:string, citations:Array, calls:number}>}
 */
export async function runLibrarian({ session, question, signal }) {
  const { sessionId, branchId } = branchCtx(session);
  const scene = getState(sessionId, { branchId })?.state || {};
  const sceneSummary = [scene.time, scene.place].filter(Boolean).join(' · ');

  const messages = [
    { role: 'system', content: librarianSystemPrompt() },
    { role: 'user', content: librarianUserPrompt({ question, sceneSummary }) },
  ];

  let calls = 0;
  for (let round = 0; round < 4; round++) {
    const res = await chat({
      agent: 'librarian',
      messages,
      temperature: null,
      maxTokens: null,
      reasoningEffort: null,
      responseFormat: { type: 'json_object' },
      signal,
    });
    const parsed = obj(tryParseJson(res.content));

    if (parsed.done) {
      return {
        found: !!parsed.found,
        answer: str(parsed.answer).slice(0, 400),
        citations: arr(parsed.citations)
          .map((c) => ({ turn_no: Number(obj(c).turn_no) || 0, quote: str(obj(c).quote).slice(0, 120) }))
          .filter((c) => c.quote)
          .slice(0, 5),
        calls,
      };
    }

    const name = str(parsed.action);
    const fn = TOOLS[name];
    if (!fn || calls >= 3) {
      messages.push({ role: 'user', content: '工具不存在或已达调用上限。请立即用 {"done":true,...} 交答案。' });
      continue;
    }
    calls++;
    const result = fn(sessionId, branchId, obj(parsed.args));
    messages.push({
      role: 'user',
      content: `【工具结果 ${name}】\n${JSON.stringify(result).slice(0, 4000)}\n\n继续：再调一个工具，或 {"done":true,...} 交答案。`,
    });
  }

  return { found: false, answer: '检索超时，没有结论。', citations: [], calls };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 4. 世界呼吸（World Tick）                                              */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 从卡里挑「此刻不在场、但最该推动世界」的人物。
 *
 * 纯函数、确定性排序。旧实现是卡内顺序 `.slice(0, 6)`：一张 55 人的卡里，
 * 世界呼吸永远只推演前 6 个人物，后面的人（哪怕 weight 0.9）根本轮不到。
 * 这里按「权重 + 与在场者的关系 + 私心压力」排序，让不在场的主角级人物
 * 也有机会产生流言，从而获得入场通道。
 *
 * @param {Array} entities 卡实体（模板快照）
 * @param {object} opts
 * @param {Set} opts.presentIds 账本里的在场者（id 或名字）
 * @param {string} opts.playerName 玩家名字（不得被推演）
 * @returns {Array} 人物实体（最多 6 个，不修改输入）
 */
export function pickOffstagePersons(entities, { presentIds = new Set(), playerName = '', ledger = {}, limit = 6 } = {}) {
  const present = new Set(presentIds || []);
  for (const key of Object.keys(ledger.characters || {})) present.add(key);
  const persons = (entities || [])
    .filter((c) => c.type === PERSON_TYPE)
    .filter((c) => !c.always_present && !present.has(c.id) && !present.has(c.name) && c.name !== playerName)
    .filter((c) => (c.agenda?.length || c.psyche?.wants?.length || c.psyche?.hides?.length));

  const score = (c) => {
    const weight = Number(c.weight) || 0.5;
    const pressure = Math.max(0, ...(c.agenda || []).map((a) => Number(a?.pressure) || 0));
    const related = (c.relations || [])
      .filter((r) => present.has(r.to)).length;
    // 权重是「这个人对故事有多重要」；压力是「他自己的事有多急」；
    // 与在场者的关系是「他有多可能被这一场卷进来」。
    return weight + Math.min(pressure, 1) * 0.5 + Math.min(related, 2) * 0.35;
  };

  return persons
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s
      || (Number(b.c.weight) || 0) - (Number(a.c.weight) || 0)
      || String(a.c.name).localeCompare(String(b.c.name)))
    .slice(0, Math.max(1, limit))
    .map((x) => x.c);
}

/**
 * 玩家看不见的地方，人物按自己的私心行动。产出的事件只作为压力与流言
 * 进入下一场的场记单，不得改写已发生的剧情。
 */
export async function runWorldTick({ session, world, turnNo, signal, guard }) {
  const { sessionId, branchId } = branchCtx(session);
  const card = normalizeCard(world?.card || {});

  const ledger = getState(sessionId, { branchId, atTurn: turnNo })?.state || {};
  const presentIds = new Set(Object.keys(ledger.characters || {}));
  const playerName = card.player?.name || '';
  const offstage = pickOffstagePersons(card.entities, { presentIds, playerName, ledger });
  if (!offstage.length) return { events: [] };

  const last = latestScene(sessionId, branchId);
  let events = [];
  let usage = null;
  try {
    const res = await chat({
      agent: 'worldTick',
      messages: [
        {
          role: 'system',
          content: worldTickSystemPrompt().replace('{{player}}', playerName || '玩家角色'),
        },
        {
          role: 'user',
          content: worldTickUserPrompt({
            turnNo,
            offstage: offstage.map((c) => ({
              name: c.name, role: c.role,
              wants: c.psyche.wants, hides: c.psyche.hides, agenda: c.agenda,
            })),
            recentSummary: last ? `${last.scene_id}｜${last.question}｜${last.outcome}` : '',
            place: ledger.place,
            when: ledger.time,
          }),
        },
      ],
      temperature: null,
      maxTokens: null,
      reasoningEffort: null,
      responseFormat: { type: 'json_object' },
      signal,
    });
    usage = res.usage || null;
    const parsed = obj(tryParseJson(res.content));
    events = arr(parsed.events)
      .map((raw) => {
        const o = obj(raw);
        return {
          who: arr(o.who).map(str).filter(Boolean).slice(0, 4),
          what: str(o.what).slice(0, 200),
          visibility: ['rumor', 'hidden', 'public'].includes(o.visibility) ? o.visibility : 'rumor',
          affects: arr(o.affects).map(str).filter(Boolean).slice(0, 4),
          pressure: Number.isFinite(Number(o.pressure)) ? Math.max(0, Math.min(1, Number(o.pressure))) : 0.4,
        };
      })
      .filter((e) => e.what)
      .slice(0, 4);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.warn(`[world-tick] LLM 失败：${err?.message || err}`);
    return { events: [], error: err?.message || String(err) };
  }

  if (typeof guard === 'function' && !guard()) return { events: [], stale: true };

  for (const e of events) {
    addPatch(sessionId, {
      branch_id: branchId, agent: 'world-tick', kind: 'offstage_event', turn_no: turnNo,
      status: e.visibility === 'hidden' ? 'applied' : 'open',
      severity: e.visibility === 'hidden' ? 'info' : 'minor',
      payload: e, evidence: `第 ${turnNo} 轮幕后推演`,
    });
  }
  return { events, usage };
}
