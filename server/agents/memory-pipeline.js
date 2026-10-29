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
import { buildAliasIndex, linkEntities, normalizeCard, PERSON_TYPE, resolveEntity } from '../world/schema.js';
import { pathsFor } from '../world/state-paths.js';
import {
  addPatch, addScene, addWorldState, getAssertions, getBranch, getCharStateMap, getRelations, getScenes,
  getState, getThreads, getTurnsForBranch, invalidateAssertion, latestScene, listPatches,
  searchAssertions, searchTurns, setCharState, upsertThread,
} from '../memory/store.js';
import {
  continuitySystemPrompt, continuityUserPrompt, librarianSystemPrompt, librarianUserPrompt,
  LIFE_STATES, sceneKeeperSystemPrompt, sceneKeeperUserPrompt, worldTickSystemPrompt, worldTickUserPrompt,
  STATE_FIELDS,
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
 * `gone` 的回程通道（D10-A）：玩家这一拍**点名**了一个标记为 `gone` 的人，
 * 说明他已经在镜头里回来了——把她写回 `alive`。
 *
 * 为什么由代码做而不是让模型写：模型看不到 `life_state`，它只在正文里写「凌玥站在门口」，
 * 不会想到要回头改一个它看不见的字段。而 `linkEntities` 已经算出了「玩家点名了谁」，
 * 这是红线 2 允许的唯一字符串匹配，**不是新的注入通道，只是同一信号的第二个消费者**。
 *
 * 边界（宁缺勿滥）：
 * - 只认**玩家这一拍亲自写到的名字**，不认旁白顺带提及（旁白常写回忆/幻觉）。
 * - 只处理 `gone`，不处理 `dead`——死人回来必须模型显式写，代码不替他决定。
 * - 只对卡里存在 / 账本里有过状态的人生效（`resolveEntity` 能解析的）。
 *
 * @returns {Array} 实际写回的条目（供 SSE / 测试）
 */
export function reviveNamedGone({
  sessionId, branchId, turnNo, world = null, card = null, playerText = '', ledger = null,
}) {
  const text = str(playerText);
  if (!text) return [];
  const worldCard = normalizeCard(card || world?.card || {});
  const aliasIndex = buildAliasIndex(worldCard);
  const linked = linkEntities(text, aliasIndex);
  if (!linked.person?.length) return [];
  const stateMap = getCharStateMap(sessionId, { branchId });
  const nameOf = new Map((worldCard.entities || []).map((e) => [e.id, e.name]));
  const applied = [];
  for (const id of linked.person) {
    const who = nameOf.get(id) || id;
    const life = str(stateMap[who]?.life_state) || str(stateMap[id]?.life_state);
    if (life !== 'gone') continue;
    // 玩家这一拍确实写到了「这个人」本身（而不是旁白里的回忆），才算回到镜头里。
    setCharState(sessionId, { branchId, who, field: 'life_state', value: 'alive', turn: turnNo });
    addWorldState(sessionId, {
      branch_id: branchId, entity_kind: 'person', entity_id: id,
      path: 'life_state', op: 'set', value: 'alive', turn: turnNo,
      source: 'archivist', evidence: `玩家这一拍点名了 ${who}`,
    });
    addPatch(sessionId, {
      branch_id: branchId, agent: 'archivist', kind: 'life_state_revived', turn_no: turnNo,
      status: 'applied', severity: 'info',
      payload: { who, from: 'gone', to: 'alive', reason: 'named_by_player' },
      evidence: text.slice(0, 120),
    });
    applied.push({ who, from: 'gone', to: 'alive' });
  }
  return applied;
}

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
/**
 * 把场记报上来的生死/离场变化落库。
 *
 * 为什么需要第二个人写 `life_state`：正文里「手垂在床沿，指节不再蜷着」这种写法
 * 不含任何关键词（`DEAD_MARKERS` 打不中），而 `lint-state` 只认 `life_state` 这个受控值。
 * 史官只看当拍、容易漏；场记读整场原文，是同一事实的第二次独立见证。
 *
 * 边界：只补「史官还没写成 dead/gone」的；值必须在 `LIFE_STATES` 内且只认本场 cast
 * （在调用方过滤）；落库仍走 store 具名函数，并留 `life_state_inferred` 审计。
 *
 * **`gone` 是「这一场不在镜头里」，不是永别（D10）**：曾经这里对 `dead` 和 `gone` 一视同仁
 * 地 `continue`，于是「第二见证人」也被永久挡住——50 拍实测：凌玥 t19 离场、t25/t33 玩家
 * 主动去找她、正文每拍都在写她说话，`life_state` 却一直是 `gone`，场记单每拍印
 * 「已故／离场：凌玥」，模型同时收到「她已离场」和「她在说话」两个矛盾信号。
 * 现在只挡 `dead`（真死了要模型显式写回），`gone → alive/injured` 放行。
 * 这不是第二个注入通道，是同一事实的第二次独立见证。
 *
 * @returns {Array} 实际写入的条目（供测试与 SSE 统计）
 */
export function applyLifeChanges({
  sessionId, branchId, turnNo, world = null, outcome = '', lifeChanges = [], sceneId = '',
}) {
  if (!lifeChanges?.length) return [];
  const aliasIndex = buildAliasIndex(world?.card || {});
  const stateMap = getCharStateMap(sessionId, { branchId });
  const applied = [];
  for (const c of lifeChanges) {
    const prevLife = stateMap[c.who]?.life_state;
    if (prevLife === 'dead') continue;
    const resolved = resolveEntity(c.who, aliasIndex);
    setCharState(sessionId, {
      branchId, who: c.who, field: 'life_state', value: c.life_state, turn: turnNo,
    });
    addWorldState(sessionId, {
      branch_id: branchId, entity_kind: 'person', entity_id: resolved.id || c.who,
      path: 'life_state', op: 'set', value: c.life_state, turn: turnNo,
      source: 'scene-keeper', evidence: outcome,
    });
    addPatch(sessionId, {
      branch_id: branchId, agent: 'scene-keeper', kind: 'life_state_inferred', turn_no: turnNo,
      status: 'applied', severity: 'info',
      payload: { scene_id: sceneId, who: c.who, life_state: c.life_state, from: prevLife || null },
      evidence: outcome,
    });
    applied.push({ who: c.who, life_state: c.life_state, from: prevLife || null });
  }
  return applied;
}

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
  // 本场在场名单：既要给提示词，也是 life_changes 的白名单（越界丢弃）。
  const castNames = Object.keys(ledger.characters || {});

  let record = {
    question: '', outcome: '', threads: [], key_detail: '', causal: '', hooks: [], life_changes: [],
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
            cast: castNames,
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
      // 生死/离场是代码必须能判定的字段（lint-state 只认 life_state）。场记是唯一读完整
      // 本场原文的 Agent，outcome 里早就写着「于黎明前离世」——只是过去没有结构化出口。
      life_changes: arr(parsed.life_changes)
        .map((x) => ({ who: str(obj(x).who), life_state: str(obj(x).life_state) }))
        .filter((x) => x.who && LIFE_STATES.includes(x.life_state))
        .filter((x) => castNames.includes(x.who))
        .slice(0, 8),
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

  // 生死交叉校正：史官每一拍只看见当拍正文，容易漏掉「就在这一拍死」的那一下；
  // 场记读的是**整场原文**，它的 life_changes 是对同一个事实的第二次独立见证。
  applyLifeChanges({
    sessionId, branchId, turnNo, world, outcome: record.outcome,
    lifeChanges: record.life_changes, sceneId,
  });

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

/** 地点是否真的换了一处（而不是同一场地的措辞变化）。 */
export function isSubstantivePlaceShift(prevPlace, nextPlace) {
  const norm = (v) => str(v).replace(/[\s·・,，。、；;：:（）()【】\[\]—\-–~～→>]/g, '');
  const a = norm(prevPlace);
  const b = norm(nextPlace);
  if (!a || !b || a === b) return false;
  // 互相包含视为同一场地的措辞变化（「黑色商务车」/「黑色商务车内」、
  // 「凌府门口」/「凌府门口 → 凌府天井」）；互不包含才算真的换了地方。
  return !a.includes(b) && !b.includes(a);
}

/**
 * 是否需要切场。
 *
 * 只认「实质变化」：时间真的换了一段，或地点真的换了一处。
 * 不再直接采信史官的 scene_change.changed——它会因为同一场地的措辞变化
 * （「黑色商务车 → 黑色商务车内」）报 changed，44 轮长跑里 12 场有 7 场就是这么切碎的。
 *
 * 强制封场是关键补充：`SCENE_EVERY=0` 时只有实质变化才切，于是角色在同一个地点
 * 待 100 轮就一场都不关，「最近一场」永远未归档，场次索引根本建不起来。
 * token 上限同理：单场原文无限增长会把场记 Agent 的输入撑爆。
 *
 * `_update` 保留在签名里是调用约定（史官 update）；是否切场只看落库后的账本。
 */
export function detectSceneChange(session, _update, turnNo) {
  const { sessionId, branchId, forkTurn } = branchCtx(session);
  const prev = latestScene(sessionId, branchId);
  if (!prev) return true;
  const ledger = getState(sessionId, { branchId, atTurn: turnNo })?.state || {};

  // 最小场长：场次第一拍的「本场逐字原文」必然为空（coverage.recent_from === null），
  // 模型那一拍看不到上一拍正文，只能靠场次索引续写。长跑实测 65 拍切 29 场
  // （2.24 拍/场），44.6% 的拍落在这种状态里，所以缺的是**下限**不是上限
  // （SCENE_EVERY=12 一次都没触发过）。这里只给「地点/时间」两个软触发加闸；
  // 轮数 / token 的强制封场必须照旧生效，否则 minTurns > sceneEvery 会死锁。
  // 本场已写下的拍数 = turnNo - prev.turn_to（prev 是上一场**已封**的场）。
  // 不能用 prev.turn_from：那是上一场的起点，上一场越长这个差越大，
  // 闸门会在第二场之后彻底失效——「下限」只在短场后面生效，等于没做。
  const minTurns = config.context.minSceneTurns;
  const tooShort = minTurns > 0 && turnNo - prev.turn_to < minTurns;

  if (!tooShort && isSubstantivePlaceShift(prev.place, ledger.place)) return true;
  const prevWhen = str(prev.when_label);
  const nextWhen = str(ledger.time);
  // 时间标签变了就是跨了一段（史官只该在真正跳跃时写 when；同刻续写由提示词约束）。
  if (!tooShort && prevWhen && nextWhen && prevWhen !== nextWhen) return true;

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
  // 校勘的回收靶池必须覆盖全量 open 线索：WIP 上限（THREAD_RENDER_MAX）已经保证
  // open 不超过 8 条，所以这里给全量，避免「第 41 条起连回收机会都没有」的老问题。
  const threads = getThreads(sessionId, { branchId, limit: -1 });
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
  const applied = applyContinuityFixes(sessionId, {
    branchId, turnNo, issues, threads, aliasIndex, playerName,
  });

  return { issues, healthy: arr(parsed.healthy).map(str).filter(Boolean), applied, usage };
}

/**
 * 把校勘的 fix 提案落库。抽成纯函数（不调模型）以便单测——
 * 此前这段逻辑内联在 `runContinuity` 里，`tests/` 对它零覆盖，
 * 于是「`target` 带 `#` 导致每条 invalidate_assertion 都落空」40 拍没被发现（D12）。
 *
 * @returns {number} 真正执行成功的条数
 */
export function applyContinuityFixes(sessionId, {
  branchId, turnNo, issues = [], threads = [], aliasIndex = [], playerName = '',
}) {
  let applied = 0;
  const maxApplied = config.context.continuityMaxApplied;
  /**
   * 记一条**终态**提案：执行不了，且不会因为「再等一拍」而变得可执行。
   *
   * 为什么不是 `open`：`open` 在本系统里的唯一语义是「等人裁决」，记忆面板会给它
   * 「接受 / 忽略」两个按钮。而形态填错的 set_state、没实现的 merge_alias、非人物 subject
   * 这三类，人点了接受也不会执行——它们过去全记 open，于是**看起来像在排队等人**，
   * 实际上是一批死通道，报告只能数出「执行 0 条」，数不出「它们已经废了」（D31）。
   *
   * `reason` 要区分「模型的错」（形态没写对）与「代码按设计拒写」（不是人物 / 字段不在表里），
   * 因为前者下一轮改提示词能修，后者修不了也不该修。
   */
  const reject = (issue, reason) => {
    issue.fix_result = {
      action: issue.fix.action || null,
      target: String(issue.fix.target || ''),
      state: 'unmatched',
      retryable: false,
      ...(reason ? { reason } : {}),
    };
    addPatch(sessionId, {
      branch_id: branchId, agent: 'continuity', kind: issue.kind, turn_no: turnNo,
      status: 'failed', severity: issue.severity, payload: issue, evidence: issue.evidence,
    });
  };
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
    // target 允许带 `#` 前缀：提示词里断言是渲染成 `#123` 给模型看的
    // （`continuityUserPrompt` 的 `#${a.id}`），模型照着抄就会带上井号。
    // 只认 `/^\d+$/` 会让**每一条** invalidate_assertion 落空——40 拍长跑实测
    // 7 条 fix 提案、0 条执行，而且状态仍记 open，看起来像「等人裁决」。
    // 这里只放宽一个可选的 `#`，不接受其它前缀（不要变成模糊匹配）。
    const fixTargetId = String(target || '').trim().replace(/^#/, '');
    if (action === 'invalidate_assertion' && /^\d+$/.test(fixTargetId)) {
      invalidateAssertion(sessionId, Number(fixTargetId), { validTo: turnNo });
      status = 'applied';
      applied++;
    } else if (action === 'set_state' && value && /^\d+$/.test(fixTargetId) && String(target || '').includes('#')) {
      // 模型把「断言的对象过时了」写成 `set_state` + 断言 id（`target:"#2023"`、
      // `value:"贴胸藏于衣襟内"`）。这不是状态改写，是「这条断言该失效了」——
      // 按 set_state 处理会落到下面的 `[subject,'condition']` 兜底，把地点写进
      // condition，还会给「伍卿的积蓄」「无纹玉佩」造出两个假人物（D15 实测）。
      // 意图与 invalidate_assertion 完全一致（红线 5：失效不删除），所以按它执行，
      // 并把「模型填错了 action」记进 payload，别静默改写语义。
      invalidateAssertion(sessionId, Number(fixTargetId), { validTo: turnNo });
      issue.fix_result = {
        action, target: String(target || ''), state: 'applied', interpreted_as: 'invalidate_assertion',
      };
      status = 'applied';
      applied++;
    } else if (action === 'set_state' && issue.subject && value && String(target || '').includes('::')) {
      const [who, field] = String(target).split('::').map((x) => str(x)).filter(Boolean);
      if (!who || !field) {
        // 形态不完整（`大黑牛::`）——模型的错，下一轮提示词能让它写对。
        reject(issue, 'bad_target_form');
        continue;
      }
      const ref = resolveEntity(who, aliasIndex);
      const isPlayer = who === playerName;
      const kind = isPlayer ? 'player' : (ref.type || '');
      // character_states 只装人物。校勘常把物品/钱财当成 subject（「伍卿的积蓄」
      // 「无纹玉佩」），按老逻辑会 setCharState 出一条假人物，投影时
      // `applyDelta` 再凭空 `emptyPersonEntry` 造出「伍卿的积蓄（临时登场）」——
      // 一个谁都不读、却会在场记单候选里排队的人物（D15 实测）。
      // 这两类要改写的是「这条断言的对象过时了」，不是人物状态，所以拒写并留痕。
      if (!isPlayer && kind !== PERSON_TYPE) {
        // 代码按设计拒写，不是模型的错，重试也不会变。
        reject(issue, 'not_a_person');
        continue;
      }
      if (!STATE_FIELDS.includes(field)) {
        reject(issue, 'unknown_field');
        continue;
      }
      setCharState(sessionId, { branchId, who, field, value, turn: turnNo });
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
    // 提案了但没执行：把原因写进 payload，并把它**判成终态**（status='failed'）。
    // 过去这里记 `open`，而 `open` 在本系统里的含义是「等人裁决」——于是一条永远不可能
    // 执行的提案会在记忆面板里永久排队，报告也只能数出「执行 0 条」，数不出「它已经废了」。
    // 只有 `action:'none'`（模型自己说不确定）才真的需要人来裁决，那种仍记 open。
    if (status !== 'applied' && action && action !== 'none') {
      status = 'failed';
      issue.fix_result = { action, target: String(target || ''), state: 'unmatched', retryable: false };
      // merge_alias 从来没有实现过（提示词里曾把它列进 action 枚举，代码里没有分支，
      // 于是 100% 落 unmatched 且记 open，看起来像「等人裁决」）。合并别名要改实体名，
      // 属于要人确认的操作，所以这里不补实现，只把「没有这条通道」和「形态填错」分开记。
      if (action === 'merge_alias') issue.fix_result.reason = 'not_implemented';
      // set_state 的 value 是「校勘那一拍应有的值」，不是「现在应有的值」：
      // 隔了 N 拍再执行会把状态改回 N 拍前，比不执行更坏。所以它不可重放，
      // 只能等下一次校勘重新发现问题（那时提示词已要求 `人物::字段`，形态是对的）。
      if (action === 'set_state') issue.fix_result.reason = 'stale_value';
    }
    addPatch(sessionId, {
      branch_id: branchId, agent: 'continuity', kind: issue.kind, turn_no: turnNo, status,
      severity: issue.severity, payload: issue, evidence: issue.evidence,
    });
  }
  return applied;
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
 * `recentCounts` 是「最近几次推演里各被点名过几次」，用于**软轮转**：
 * 排序分 = 原分数 − 0.12 × 次数，次数多的人往后排一点。
 * 分数排序本身是静态的（同一份账本永远选出同一批 top N），长跑实测 29 次推演
 * 只用到 6/45 个人，同一批人的同一件旧事被反复渲染。
 *
 * 为什么不删除、也不硬轮转：删了会让重要人物在幕外彻底停摆；「用过就排到队尾」
 * 的两段式实测会在第二次推演就把主角级人物整批挤出候选（世界呼吸不是发牌），
 * 而且一次推演覆盖 3–4 人、6 次窗口足以让全池都「出现过」，两段式随后整体失效。
 * 软轮转的语义是「用多了才让位」——权重 1.0 的人连用 3 次才会被权重 0.7 的新人顶掉。
 *
 * @param {Array} entities 卡实体（模板快照）
 * @param {object} opts
 * @param {Set} opts.presentIds 账本里的在场者（id 或名字）
 * @param {string} opts.playerName 玩家名字（不得被推演）
 * @param {Set<string>|Map<string, number>} opts.recentCounts 最近各被点名过几次
 * @returns {Array} 人物实体（最多 6 个，不修改输入）
 */
export function pickOffstagePersons(entities, {
  presentIds = new Set(), playerName = '', ledger = {}, limit = 6, recentCounts = new Map(),
} = {}) {
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

  // Set 视为「各被点名 1 次」，Map 直接用次数。
  const countOf = recentCounts instanceof Map
    ? (name) => Number(recentCounts.get(name)) || 0
    : (() => {
      const set = recentCounts instanceof Set ? recentCounts : new Set(recentCounts || []);
      return (name) => (set.has(name) ? 1 : 0);
    })();

  // 轮转是**软**的：按「分数 − 惩罚 × 已推演次数」排序，不是「用过的排到队尾」。
  // 硬轮转的实测后果：t4 就把凌玥/黎婆/姬淮澄整批挤出候选，
  // 主角级人物在幕外彻底消失——世界呼吸不是发牌，重要人物不能因为「上轮出现过」就停摆。
  // 软轮转的语义是「用多了才让位」：权重 1.0 的人要连用 3 次才会被权重 0.7 的新人顶掉。
  const ROTATION_PENALTY = 0.12;
  return persons
    .map((c) => ({ c, s: score(c) - ROTATION_PENALTY * countOf(c.name) }))
    .sort((a, b) => b.s - a.s
      || (Number(b.c.weight) || 0) - (Number(a.c.weight) || 0)
      || String(a.c.name).localeCompare(String(b.c.name)))
    .slice(0, Math.max(1, limit))
    .map((x) => x.c);
}

/**
 * 最近几次世界呼吸里，每个人各被点名过几次。
 *
 * 取最近 `WORLD_TICK_ROTATION` **次**推演（按 `turn_no` 去重，不是按事件条数——
 * 一次推演会写 1–4 条事件），统计这些事件的 `who` 里出现过的名字，返回次数的 Map，
 * 交给 `pickOffstagePersons` 做轮转。
 *
 * 为什么需要次数而不是「出现过没有」：一次推演覆盖 3–4 个人，6 次窗口足以让
 * 候选池里的所有人都至少出现过一次；此时「出现过就排到队尾」的两段式会整体失效。
 *
 * 为什么需要它：分数排序（权重 + 关系 + 压力）在同一份账本上是**静态**的——
 * 长跑 29 次推演里 top6 一直是同样 6 个人，剩下 39 个人一次都没被推演过，
 * 于是「幕外流言」段反复渲染同一批人的同一件旧事。
 */
function recentTickCounts(sessionId, branchId, window = 6) {
  const counts = new Map();
  try {
    const ticks = new Set();
    for (const p of listPatches(sessionId, { branchId, kind: 'offstage_event', limit: 200 })) {
      const turnNo = Number(p.turn_no) || 0;
      if (!ticks.has(turnNo)) {
        if (ticks.size >= Math.max(1, window)) continue;
        ticks.add(turnNo);
      }
      const who = p.payload?.who;
      const list = Array.isArray(who) ? who : who ? [who] : [];
      for (const name of list) {
        const key = String(name || '').trim();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  } catch (err) {
    // 轮转是可选优化：取不到历史时退回原排序，不阻断世界呼吸。
    console.warn(`[world-tick] 读取轮转窗口失败：${err?.message || err}`);
  }
  return counts;
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
  // 最近几次推演点名过的人往后排：分数排序是静态的，不轮转就会每次选同一批人，
  // 同一件旧事被反复渲染（长跑实测 8 次推演只用到 7/55 人）。
  const recentCounts = recentTickCounts(sessionId, branchId);
  const offstage = pickOffstagePersons(card.entities, { presentIds, playerName, ledger, recentCounts });
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
