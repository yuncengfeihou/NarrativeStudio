/**
 * server/memory/context-engine.js — 世界卡上下文引擎（v4 的核心）
 *
 * v4 与 v3 的根本差别：**提示词不是从词条库里检索出来的，是从世界状态里渲染出来的。**
 * 没有关键词触发、没有扫描深度、没有递归、没有优先级、没有常驻开关。
 *
 * 装配顺序（缓存友好：稳定前缀 → 追加原文 → 易变尾部）：
 *   1. system  演绎契约 + 命题 + 宪章 + 世界索引   （一个会话内几乎不变，吃前缀缓存）
 *   2. …      最近原文（player/narrator 交替，只追加）
 *   3. user    场记单 + 回声                       （每场变一次，放在尾部注意力最强处）
 *   4. user    本场指令 + 本轮行动
 *
 * 词条（codex）进场靠三条路：实体连接（在场/被提及/被钉选）、主题标签、用户钉选。
 * 唯一保留的字符串匹配是实体链接：它只回答「文本提到了谁」，用来更新场记单的
 * 在场者与随身物，不回答「该注入哪段设定」。
 */
import { config } from '../config.js';
import { estimateMessageTokens, estimateTokens, truncateToTokens } from '../tokens.js';
import { normalizeCard, buildAliasIndex, linkEntities, sceneThemeTags } from '../world/schema.js';
import { buildEffectiveWorld, emptyCastEntry } from '../world/effective.js';
import { renderWorldIndex, selectCodex, renderSceneSheet } from '../world/scene-sheet.js';
import { narratorTailInstruction } from '../prompts/narrator.js';
import {
  getActiveSummary, getAssertions, getBranch, getRelations, getRecentTurnsForBranch,
  getRecentTextForBranch, getState, getThreads, getVoiceMap, getWorldState,
} from './store.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const join = (arr, sep = '、') => (arr || []).filter(Boolean).join(sep);

/* ══════════════════════════════════════════════════════════════════════ */
/* 1. 演绎契约（唯一一条 system 消息）                                      */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 契约只留「怎么演」，不留世界观细节——细节走宪章、索引和场记单。
 * 硬性规则控制在 10 条以内：规则越多，越没有一条被真正执行。
 */
export function buildContract(session, world, card = normalizeCard(world?.card || {})) {
  const p = card.prompt;
  const title = card.title || session?.title || '未命名剧情';

  const lines = [
    '你是一部互动小说的「世界本身」。你不是助手、不是评论员、不是写作教练。',
    '你的全部输出就是剧情正文。',
    '',
    `# 作品`,
    `《${title}》${card.subtitle ? ` · ${card.subtitle}` : ''}${card.genre.length ? `｜${join(card.genre)}` : ''}`,
  ];

  if (p.premise) {
    lines.push('', '# 命题', '这是这个世界的故事要往哪去。它是方向，不是剧本：', p.premise);
  }

  lines.push(
    '',
    '# 演出范式（硬性）',
    `1. 视角：${p.pov}。主角不在场的信息只能通过痕迹、传闻、他人转述呈现，不得直接叙述。`,
    `2. 文风：${p.style_guide || '短句为主，一段不超过三行；对白与动作交错，少用形容词堆砌'}`,
    `3. 篇幅：本轮 ${p.length}。`,
    `4. 时态：${p.tense}。每一段都必须推动情势或揭示人物，不写纯装饰性描写。`,
    '5. 结尾必须留钩子：停在悬念、危机、或一个必须立刻做出的选择前夜。禁止平稳收尾。',
    '6. 不得出现元叙述：不写「作为 AI」「本章」「综上所述」「作者」，不解释、不总结、不预告。',
    '7. 不得替主角做决定，不代写主角的台词与内心。主角的行动由玩家给出。',
    '8. 不得让任何角色说出他不可能知道的信息；不得为了推进剧情让角色降智。',
    '9. 专有名词一次定义、终身一致：人名、地名、称谓、器物名不得漂移或改写。',
    '10. 只输出剧情正文。不要标题、不要章节号、不要 Markdown 标记、不要任何前后缀说明。',
  );

  if (p.narrator_notes) {
    lines.push('', '# 作者给演绎的附注', p.narrator_notes);
  }

  const bans = [...p.bans];
  if (bans.length) {
    lines.push('', '# 绝对禁止（作者钦定）');
    bans.forEach((b, i) => lines.push(`${i + 1}. ${b}`));
  }

  return lines.join('\n');
}

/** 系统层总装：契约 + 命题 + 宪章 + 世界索引。 */
export function buildSystemLayer(
  session, world, { card = normalizeCard(world?.card || {}), indexCap = config.context.layerBudget.system } = {},
) {
  const parts = [buildContract(session, world, card)];

  const charter = (card.charter || [])
    .map((c, i) => `${i + 1}. ${c.rule}`)
    .join('\n');
  if (charter) {
    parts.push(`【世界宪章】这个世界的硬设定，任何场景下都成立，不得违背。\n${charter}`);
  }

  const index = renderWorldIndex(card, Math.max(400, indexCap - estimateTokens(parts.join('\n\n')) - 200));
  if (index) parts.push(index);

  const player = card.player;
  if (player && (player.name || player.situation || player.inner_voice)) {
    const pl = [`【主角】${player.name}${player.age ? `，${player.age}` : ''}${player.identity ? `｜${player.identity}` : ''}`];
    if (player.situation) pl.push(`处境：${player.situation}`);
    if (player.capability) pl.push(`能力边界：${player.capability}`);
    if (player.inner_voice) pl.push(`内心声音：${player.inner_voice}`);
    if (player.wants) pl.push(`想要的：${player.wants}`);
    if (player.afraid) pl.push(`害怕的：${player.afraid}`);
    if (player.knowledge.does_not_know.length) pl.push(`他不知道：${join(player.knowledge.does_not_know)}`);
    parts.push(pl.join('\n'));
  }

  const notes = (card.author_notes || []).filter((n) => n.scope === 'always');
  if (notes.length) {
    parts.push(`【作者笔记】作者亲手写下的事实与规则，优先级高于一切自动记忆与即兴创作。\n${notes.map((n) => `· ${n.text}`).join('\n')}`);
  }

  return truncateToTokens(parts.join('\n\n'), Math.max(2000, indexCap));
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 2. 账本（场景状态）                                                     */
/* ══════════════════════════════════════════════════════════════════════ */

/** 读当前场景账本；没有快照时退回起点锚点的 snapshot。 */
function loadLedger(sessionId, anchor, { branchId, atTurn }) {
  const rec = getState(sessionId, { branchId, atTurn });
  if (rec?.state) return { ...rec.state, turn_no: rec.turn_no };
  return { ...(anchor?.snapshot || {}), turn_no: 0 };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 3. 在场判定                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 在场 = 账本显式 present + 玩家这一拍提到的人 + always_present 的 + 玩家角色本身。
 *
 * 旧会话没有 ledger.present 时退回 characters（兼容），但新会话不再把
 * 「账本里出现过的人」等同于「镜头里的人」——那是人物块膨胀的根因。
 * 最近原文提到的人只进辞书邻域/关系提示，不自动占完整人物卡位。
 * @returns {Array}
 */
function pickPresent(card, { ledger, linked }) {
  const byId = new Map((card.cast || []).map((c) => [c.id, c]));
  const byName = new Map((card.cast || []).map((c) => [c.name, c]));
  const ids = new Set();

  for (const c of card.cast || []) if (c.always_present) ids.add(c.id);
  const stage = Array.isArray(ledger?.present) && ledger.present.length
    ? ledger.present
    : Object.keys(ledger?.characters || {});
  for (const key of stage) {
    const hit = byId.get(key) || byName.get(key);
    ids.add(hit ? hit.id : key);
  }
  for (const id of linked?.cast || []) ids.add(id);
  // 玩家角色永远在场：他就是镜头本身
  if (card.player?.canon_character) ids.add(card.player.canon_character);
  else if (card.player?.name) ids.add(card.player.name);

  // 账本里出现过、但卡司里没有的名字，是剧情即兴造出来的人：
  // 给一个最小条目，让他至少能进场，而不是被静默丢掉。
  const present = [...ids]
    .map((id) => byId.get(id) || byName.get(id) || emptyCastEntry(id, id))
    .filter(Boolean);

  // 玩家角色可能不在卡司里（原创主角）。为他造一个最小条目，保证场记单有他。
  const playerId = card.player?.canon_character || card.player?.name;
  if (playerId && !present.some((c) => c.id === playerId || c.name === playerId)) {
    const p = card.player;
    present.unshift({
      id: playerId,
      name: p.name || '主角',
      aliases: [],
      role: '主角',
      one_line: '',
      status: p.status || '',
      condition: p.condition || '',
      mood: p.mood || '',
      location: p.location || '',
      goal: p.goal || '',
      identity: {},
      voice: { address: {}, rhythm: p.inner_voice || '', lexicon: [], never: [], exemplars: [] },
      psyche: { wants: p.wants ? [p.wants] : [], fears: p.afraid ? [p.afraid] : [], hides: [], values: [] },
      knowledge: { knows: p.knowledge?.knows || [], does_not_know: p.knowledge?.does_not_know || [], believes_falsely: [] },
      agenda: [],
      relations: [],
      always_present: true,
      weight: 1,
      is_player: true,
    });
  }
  return present;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 4. 辞书挑选                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 三条进场路径：实体连接 / 主题标签 / 用户钉选。
 * presentIds 里既有卡司 id，也有账本里的地点 id 与随身物品 id。
 */
function pickCodex(card, { ledger, linked, pinnedIds = [] }) {
  const presentIds = [
    ...(linked?.cast || []),
    ...(linked?.codex || []),
    ...pinnedIds,
  ];
  if (ledger?.place_id) presentIds.push(ledger.place_id);
  for (const item of ledger?.inventory || []) if (item.id) presentIds.push(item.id);

  const tags = sceneThemeTags(card, presentIds, ledger?.theme_tags || []);
  return {
    candidates: selectCodex(card, {
      presentIds,
      mentionedIds: linked?.codex || [],
      threadTags: tags,
      pinnedIds,
      currentPlaceId: ledger?.place_id || null,
    }),
    themeTags: tags,
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 5. 回声（过去的原话）                                                    */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 回声 = 在场角色最近的原文台词 + 与未回收线索同文的旧原文片段。
 * 逐字引用，不是摘要——这是「细节能唤起」的落地方式。
 */
function buildEchoes(sessionId, { branchId, present }) {
  const voices = getVoiceMap(sessionId, { branchId, perWho: 2 });
  const echoes = [];
  for (const c of present) {
    const name = c.name;
    for (const line of (voices[name] || voices[c.id] || []).slice(0, 2)) {
      echoes.push({ who: name, text: line, turn_no: 0 });
    }
  }
  return echoes;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 6. 本轮输入                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

function normalizeImages(images) {
  if (!images) return [];
  const list = Array.isArray(images) ? images : [images];
  const out = [];
  for (const img of list) {
    if (!img) continue;
    if (typeof img === 'string') out.push(img);
    else if (typeof img.url === 'string') out.push(img.url);
    else if (typeof img.image_url?.url === 'string') out.push(img.image_url.url);
  }
  return out;
}

function buildCurrent(playerText, images, branchChoice, extra, tail) {
  let text = '';
  if (branchChoice) {
    text = `【玩家选择的走向】${branchChoice.title || ''}：${branchChoice.description || ''}\n【玩家的具体行动】${playerText || ''}`;
  } else if (playerText) {
    text = str(playerText);
  }
  if (extra) text = text ? `${extra}\n\n${text}` : extra;

  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of normalizeImages(images)) parts.push({ type: 'image_url', image_url: { url } });
  if (!parts.length) parts.push({ type: 'text', text: '（请从这里继续演绎。）' });

  const content = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
  return { role: 'user', content: tail ? `${content}\n\n${tail}` : content };
}

/** 尾注：最后一条指令，紧贴玩家行动，影响力最强。只放此刻的事。 */
function buildTail(card, { directive, isOpening }) {
  return narratorTailInstruction(card, { directive, isOpening });
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 7. 最近原文                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

function toRecentMessages(rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind === 'player') out.push({ role: 'user', content: r.content });
    else if (r.kind === 'narrator') out.push({ role: 'assistant', content: r.content });
  }
  return out;
}

function fitRecent(msgs, capTokens, floor = 3) {
  if (!msgs.length) return [];
  let total = msgs.reduce((s, m) => s + estimateMessageTokens(m), 0);
  let start = 0;
  while (start < msgs.length && total > capTokens && msgs.length - start > floor) {
    total -= estimateMessageTokens(msgs[start]);
    start++;
  }
  return msgs.slice(start);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 主入口                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 装配一轮的完整 messages。
 *
 * @param {object} args
 * @param {object} args.session
 * @param {object|null} args.world
 * @param {number} [args.turnNo]
 * @param {string} [args.playerText]
 * @param {Array}  [args.images]
 * @param {object} [args.branchChoice]
 * @param {boolean}[args.isOpening]
 * @param {string} [args.directive]   作者的本场指令
 * @returns {Promise<object>}
 */
export async function assembleContext({
  session, world, turnNo, playerText, images, branchChoice, isOpening = false, directive = '',
  retrieval = null,
}) {
  const budget = config.context.layerBudget;
  const hardMax = session?.settings?.context_max_tokens ?? config.context.maxTokens;
  const softMax = Math.min(config.context.softTokens, hardMax);
  const sessionId = session.id;
  const branchId = session.branch_id || 'main';
  const branch = getBranch(sessionId, branchId);
  const forkTurn = branch ? branch.fork_turn : Number.MAX_SAFE_INTEGER;

  /* ---- 模板快照 + 世界线增量 → 本轮真实有效的世界 ---- */
  const templateCard = normalizeCard(session?.card_snapshot || world?.card || {});
  const deltas = getWorldState(sessionId, { branchId, atTurn: Number.isInteger(turnNo) ? turnNo : 0 });
  const card = buildEffectiveWorld(templateCard, deltas);
  const anchors = card.anchors || [];
  const anchorId = session.anchor_id || anchors[0]?.id || null;
  const anchor = anchors.find((a) => a.id === anchorId) || anchors[0] || null;

  /* ---- 账本 ---- */
  const ledgerAtTurn = Number.isInteger(turnNo) && turnNo > 0 ? turnNo - 1 : 0;
  const ledger = loadLedger(sessionId, anchor, { branchId, atTurn: ledgerAtTurn });

  /* ---- 实体链接：只回答「提到了谁」，不回答「注入什么」 ---- */
  const aliasIndex = buildAliasIndex(card);
  const recentText = getRecentTextForBranch(sessionId, branchId, forkTurn, config.context.loreScanDepth || 8);
  const openingSeed = isOpening ? str(anchor?.opening_seed) : '';
  // 在场只看「玩家这一拍提到谁」；最近原文的提及只用于辞书邻域与关系提示。
  const linkedPlayer = linkEntities(
    [playerText || '', branchChoice?.description || '', openingSeed].join('\n'),
    aliasIndex,
  );
  const linkedRecent = linkEntities(recentText, aliasIndex);
  const linked = {
    cast: [...new Set([...(linkedPlayer.cast || []), ...(linkedRecent.cast || [])])],
    codex: [...new Set([...(linkedPlayer.codex || []), ...(linkedRecent.codex || [])])],
  };

  /* ---- 在场卡司 ---- */
  const present = pickPresent(card, { ledger, linked: linkedPlayer });

  /* ---- 辞书 ---- */
  const pinnedIds = (card.codex || []).filter((e) => e.pinned).map((e) => e.id);
  const { candidates, themeTags } = pickCodex(card, { ledger, linked, pinnedIds });

  /* ---- 关系 / 线索 / 已成立的事实 ---- */
  const relations = getRelations(sessionId, { branchId, limit: 60 });
  const threads = getThreads(sessionId, { branchId, limit: 40 });
  const presentKeys = new Set(present.flatMap((c) => [c.id, c.name]));
  const facts = getAssertions(sessionId, { branchId, atTurn: Number.isInteger(turnNo) ? turnNo : 0, limit: 60 })
    .filter((a) => a.visibility !== 'secret' || presentKeys.has(a.subject))
    .slice(0, 6);

  /* ---- 原声 → 回声 ---- */
  const echoes = buildEchoes(sessionId, { branchId, present });

  /* ---- 场记单 ---- */
  // 辞书条目按「每条预估成本」决定能塞几条，而不是固定 slice：
  // 优先高分（实体连接/钉选）的条目，低分的在配额不够时整条放弃。
  const sceneCap = budget.scene;
  const perEntryCost = 90;
  const codexSlots = Math.max(1, Math.floor(sceneCap * 0.45 / perEntryCost));
  const selectedCodex = candidates.slice(0, codexSlots);
  const sheet = renderSceneSheet({
    ledger,
    present,
    relations,
    threads,
    codex: selectedCodex,
    voices: {},
    echoes,
    facts,
    worldRuntime: card.runtime || {},
    directive: directive || str(session.settings?.scene_directive),
    capTokens: sceneCap,
  });
  // 候选 ≠ 实际渲染：场记单预算不足时，codex/facts 可能整段被丢。
  const codexRendered = sheet.meta?.codex_rendered ?? selectedCodex.length;
  const factsRendered = (sheet.meta?.kept || []).includes('facts') ? facts.length : 0;

  /* ---- 系统层（稳定前缀） ---- */
  const systemMsg = { role: 'system', content: buildSystemLayer(session, world, { card, indexCap: budget.system }) };

  /* ---- 前情提要（滚动摘要） ---- */
  // atTurn 传当前回合：只取覆盖边界不超过本轮的摘要。摘要只影响装配，不改写 turns。
  const summary = getActiveSummary(sessionId, {
    branchId,
    atTurn: Number.isInteger(turnNo) ? turnNo : 0,
  });
  // 摘要层有独立配额：摘要 Agent 可能写超，装配时按 BUDGET_SUMMARY 截断，
  // 不能因为总预算还宽裕就让它越过自己的层预算。
  const summaryMsg = summary
    ? {
      role: 'user',
      content: truncateToTokens(
        `【前情提要】以下是更早剧情的接力摘要，是既定事实。\n\n${summary.text}`,
        budget.summary,
      ),
    }
    : null;

  /* ---- 最近原文 ---- */
  const rawRows = getRecentTurnsForBranch(sessionId, branchId, forkTurn, config.context.recentRawTurns + 4);
  const visibleRows = (Number.isInteger(turnNo) && turnNo > 0)
    ? rawRows.filter((r) => r.turn_no < turnNo)
    : rawRows;
  // 摘要覆盖过的回合不再逐字重复；最近保留回合永远逐字。
  const recentRows = summary
    ? visibleRows.filter((r) => r.turn_no > summary.covers_turn_to)
    : visibleRows;
  let recentMsgs = fitRecent(toRecentMessages(recentRows), budget.recent);

  /* ---- 本轮输入 ---- */
  const sceneNotes = (card.author_notes || []).filter((n) => n.scope === 'scene' || n.scope === 'session');
  const directiveText = [str(session.settings?.scene_directive), ...sceneNotes.map((n) => n.text)].filter(Boolean).join('\n');
  let extra = '';
  if (isOpening) {
    extra = str(anchor?.opening_seed)
      ? `【开场】这是剧情的第一轮。请从下面的开场种子起笔：交代环境、主角处境与第一个可回应的情势，让在场的人物以各自的方式登场，并埋下核心悬念。\n\n${anchor.opening_seed}`
      : '【开场】这是剧情的第一轮。请依据世界宪章与主角设定，自行起笔一个强有力的开场。';
  }
  const currentMsg = buildCurrent(playerText, images, branchChoice, extra, buildTail(card, { directive: directiveText, isOpening }));

  /* ---- 汇总：system → 前情提要 → 最近原文 → 场记单 → 检索结果 → 本轮输入 ---- */
  const sheetMsg = sheet.text ? { role: 'user', content: sheet.text } : null;
  const retrievalMsg = retrieval?.text ? { role: 'user', content: retrieval.text } : null;
  const compose = () => [
    systemMsg,
    ...(summaryMsg ? [summaryMsg] : []),
    ...recentMsgs,
    ...(sheetMsg ? [sheetMsg] : []),
    ...(retrievalMsg ? [retrievalMsg] : []),
    currentMsg,
  ];
  let messages = compose();

  /* ---- 超预算降级：场记单 → 摘要 → 最近原文减半 → 截最长非 system ---- */
  // 最近原文是续演点，优先保住；摘要是压缩过的，截尾损失最小。
  const totalNow = () => messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  const degraded = [];
  if (totalNow() > softMax && sheetMsg) {
    const excess = totalNow() - softMax;
    const cur = estimateMessageTokens(sheetMsg);
    sheetMsg.content = truncateToTokens(sheetMsg.content, Math.max(600, cur - excess));
    messages = compose();
    degraded.push('scene_sheet');
  }
  if (totalNow() > softMax && summaryMsg) {
    const excess = totalNow() - softMax;
    const cur = estimateMessageTokens(summaryMsg);
    summaryMsg.content = truncateToTokens(summaryMsg.content, Math.max(600, cur - excess));
    messages = compose();
    degraded.push('summary');
  }
  if (totalNow() > softMax) {
    recentMsgs = fitRecent(toRecentMessages(recentRows), Math.max(2000, budget.recent * 0.5));
    messages = compose();
    degraded.push('recent');
  }
  for (let guard = 0; guard < 30 && totalNow() > hardMax; guard++) {
    const candidates = messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => typeof m.content === 'string' && m.role !== 'system');
    if (!candidates.length) break;
    candidates.sort((a, b) => estimateMessageTokens(b.m) - estimateMessageTokens(a.m));
    const m = candidates[0].m;
    const t = estimateMessageTokens(m);
    if (t < 80) break;
    m.content = truncateToTokens(m.content, Math.max(60, Math.floor(t * 0.7)));
  }

  const budgetOf = (content) => (content ? estimateTokens(content) + 4 : 0);
  const breakdown = {
    system: budgetOf(systemMsg.content),
    summary: summaryMsg ? budgetOf(summaryMsg.content) : 0,
    recent: recentMsgs.reduce((s, m) => s + estimateMessageTokens(m), 0),
    scene: sheetMsg ? budgetOf(sheetMsg.content) : 0,
    retrieval: retrievalMsg ? budgetOf(retrievalMsg.content) : 0,
    current: estimateMessageTokens(currentMsg),
  };
  breakdown.total = breakdown.system + breakdown.summary + breakdown.recent
    + breakdown.scene + breakdown.retrieval + breakdown.current;

  return {
    messages,
    budget: breakdown,
    // 本轮投影后的世界：下游 Agent（史官/世界呼吸/走向）用它，而不是模板。
    card,
    state: ledger,
    ledger,
    anchor: anchor ? { id: anchor.id, label: anchor.label } : null,
    recentTurns: recentRows,
    echoes,
    meta: {
      present: present.map((c) => ({ id: c.id, name: c.name, role: c.role })),
      mentioned: linked,
      theme_tags: themeTags,
      codex: selectedCodex.slice(0, Math.min(codexRendered, 8))
        .map((c) => ({ id: c.entry.id, name: c.entry.name, why: c.why })),
      codex_total: card.codex.length,
      codex_candidates: selectedCodex.length,
      codex_rendered: codexRendered,
      codex_dropped: Math.max(0, selectedCodex.length - codexRendered),
      timeline_past: (card.timeline || []).filter((t) => t.canon === 'past').length,
      timeline_future_held: (card.timeline || []).filter((t) => t.canon === 'future').length,
      world_state_changes: deltas.length,
      facts: factsRendered,
      facts_candidates: facts.length,
      dropped_sections: sheet.meta?.dropped || [],
      branch: branchId,
      summary: summary ? { id: summary.id, covers_turn_to: summary.covers_turn_to, tokens: breakdown.summary } : null,
      retrieval: retrieval?.text
        ? { queries: retrieval.queries || [], entries: retrieval.entries || [], tokens: breakdown.retrieval }
        : null,
      degraded,
      soft_max: softMax,
      hard_max: hardMax,
    },
  };
}
