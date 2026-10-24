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
import { buildAliasIndex, normalizeCard, resolveEntity } from '../world/schema.js';
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

  const cfg = config.agents.sceneKeeper;
  let record = { question: '', outcome: '', threads: [], key_detail: '' };
  try {
    const res = await chat({
      messages: [
        { role: 'system', content: sceneKeeperSystemPrompt() },
        {
          role: 'user',
          content: sceneKeeperUserPrompt({
            sceneId, turnFrom: from, turnTo: turnNo,
            when: ledger.time, place: ledger.place,
            cast: Object.keys(ledger.characters || {}),
            turns: rows.map((r) => ({ turn_no: r.turn_no, kind: r.kind, content: r.content })),
          }),
        },
      ],
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      reasoningEffort: cfg.reasoningEffort,
      model: cfg.model || undefined,
      responseFormat: { type: 'json_object' },
    });
    const parsed = obj(tryParseJson(res.content));
    record = {
      question: str(parsed.question).slice(0, 60),
      outcome: str(parsed.outcome).slice(0, 120),
      threads: arr(parsed.threads).map(str).filter(Boolean).slice(0, 8),
      key_detail: str(parsed.key_detail).slice(0, 120),
    };
  } catch (err) {
    console.warn(`[scene-keeper] LLM 失败，降级为纯结构记录：${err?.message || err}`);
  }

  if (typeof guard === 'function' && !guard()) return null;

  addScene(sessionId, {
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
    outcome: [record.outcome, record.key_detail].filter(Boolean).join('｜'),
    threads: record.threads,
    state: ledger,
  });

  addPatch(sessionId, {
    branchId, agent: 'scene-keeper', kind: 'scene', turn_no: turnNo, status: 'applied',
    payload: { scene_id: sceneId, ...record }, evidence: reason,
  });
  return { scene_id: sceneId, turn_from: from, turn_to: turnNo, ...record };
}

/** 是否需要切场：账本的地点/时间/在场者变了，或到了固定轮数。 */
export function detectSceneChange(session, update, turnNo) {
  const { sessionId, branchId } = branchCtx(session);
  const prev = latestScene(sessionId, branchId);
  if (!prev) return true;
  const sc = update?.scene_change || {};
  if (sc.changed) return true;
  const ledger = getState(sessionId, { branchId, atTurn: turnNo })?.state || {};
  if (str(ledger.place) && str(prev.place) && str(ledger.place) !== str(prev.place)) return true;
  const every = config.context.sceneEvery;
  if (every > 0 && turnNo > 0 && turnNo % every === 0) return true;
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
  const cfg = config.agents.continuity;
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
  try {
    const res = await chat({
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
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      reasoningEffort: cfg.reasoningEffort,
      model: cfg.model || undefined,
      responseFormat: { type: 'json_object' },
      signal,
    });
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
        branchId, agent: 'continuity', kind: issue.kind, turn_no: turnNo, status: 'open',
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
      const kind = isPlayer ? 'player' : (ref.kind || 'cast');
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
      branchId, agent: 'continuity', kind: issue.kind, turn_no: turnNo, status,
      severity: issue.severity, payload: issue, evidence: issue.evidence,
    });
  }

  return { issues, healthy: arr(parsed.healthy).map(str).filter(Boolean), applied };
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
  const cfg = config.agents.librarian;
  const scene = getState(sessionId, { branchId })?.state || {};
  const sceneSummary = [scene.time, scene.place].filter(Boolean).join(' · ');

  const messages = [
    { role: 'system', content: librarianSystemPrompt() },
    { role: 'user', content: librarianUserPrompt({ question, sceneSummary }) },
  ];

  let calls = 0;
  for (let round = 0; round < 4; round++) {
    const res = await chat({
      messages,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      reasoningEffort: cfg.reasoningEffort,
      model: cfg.model || undefined,
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
 * 玩家看不见的地方，人物按自己的私心行动。产出的事件只作为压力与流言
 * 进入下一场的场记单，不得改写已发生的剧情。
 */
export async function runWorldTick({ session, world, turnNo, signal, guard }) {
  const { sessionId, branchId } = branchCtx(session);
  const card = normalizeCard(world?.card || {});
  const cfg = config.agents.worldTick;

  const ledger = getState(sessionId, { branchId, atTurn: turnNo })?.state || {};
  const presentIds = new Set(Object.keys(ledger.characters || {}));
  const playerName = card.player?.name || '';
  const offstage = (card.cast || [])
    .filter((c) => !c.always_present && !presentIds.has(c.id) && !presentIds.has(c.name) && c.name !== playerName)
    .filter((c) => (c.agenda?.length || c.psyche.wants?.length || c.psyche.hides?.length))
    .slice(0, 6);
  if (!offstage.length) return { events: [] };

  const last = latestScene(sessionId, branchId);
  let events = [];
  try {
    const res = await chat({
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
          }),
        },
      ],
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      reasoningEffort: cfg.reasoningEffort,
      model: cfg.model || undefined,
      responseFormat: { type: 'json_object' },
      signal,
    });
    const parsed = obj(tryParseJson(res.content));
    events = arr(parsed.events)
      .map((raw) => {
        const o = obj(raw);
        return {
          who: arr(o.who).map(str).filter(Boolean).slice(0, 4),
          what: str(o.what).slice(0, 200),
          visibility: ['rumor', 'hidden', 'public'].includes(o.visibility) ? o.visibility : 'rumor',
          affects: arr(o.affects).map(str).filter(Boolean).slice(0, 4),
          thread: str(o.thread).slice(0, 80),
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
      branchId, agent: 'world-tick', kind: 'offstage_event', turn_no: turnNo,
      status: e.visibility === 'hidden' ? 'applied' : 'open',
      severity: e.visibility === 'hidden' ? 'info' : 'minor',
      payload: e, evidence: `第 ${turnNo} 轮幕后推演`,
    });
    if (e.thread) {
      const open = getThreads(sessionId, { branchId, status: 'open', limit: 50 });
      if (!open.some((t) => t.title === e.thread)) {
        upsertThread(sessionId, {
          branch_id: branchId, title: e.thread, status: 'open', weight: 0.5,
          planted_turn: turnNo, turn_no: turnNo, note: '世界呼吸推演',
        });
      }
    }
  }
  return { events };
}
