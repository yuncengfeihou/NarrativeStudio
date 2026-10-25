/**
 * server/memory/context-engine.js — 世界卡上下文引擎（v4 的核心）
 *
 * v4 与 v3 的根本差别：**提示词不是从词条库里检索出来的，是从世界状态里渲染出来的。**
 * 没有关键词触发、没有扫描深度、没有递归、没有优先级、没有常驻开关。
 *
 * 装配顺序（缓存友好：冻结前缀 → 只追加历史 → 易变尾部）：
 *   1. system  演绎契约 + 命题 + 宪章 + 世界索引 + 主角（canon，**只读模板快照**）
 *   2. user    本局场次索引（每场一行，只追加）
 *   3. …       当前场次逐字原文（上一场 turn_to + 1 起，player/narrator 交替，只追加）
 *   4. user    刚才这一场怎么收的（最近 1–2 场细节）
 *   5. user    场记单 + 回声（runtime，每场变一次，尾部注意力最强）
 *   6. user    本场指令 + 本轮行动
 *
 * 记忆不变量：场次边界 + 1 必须等于原文窗口的第一轮。原文窗口不做字符串裁剪；
 * 它由「场次记录」（每场一行、只追加、永不互相改写）接住，场次从本场完整原文生成。
 *
 * 缓存不变量：system 只承载 canon，绝不读 world_state 投影后的运行态——
 * 它一变，后面整段前缀全部失效。判据见 test-context.js 的「缓存前缀」段。
 *
 * 词条（codex）进场靠三条路：实体连接（在场/被提及/被钉选）、主题标签、用户钉选。
 * 唯一保留的字符串匹配是实体链接：它只回答「文本提到了谁」，用来更新场记单的
 * 在场者与随身物，不回答「该注入哪段设定」。
 */
import { config } from '../config.js';
import { resolveContextWindow } from '../model-registry.js';
import { estimateMessageTokens, estimateTokens, truncateToTokens } from '../tokens.js';
import { normalizeCard, buildAliasIndex, linkEntities, sceneThemeTags } from '../world/schema.js';
import { buildEffectiveWorld, emptyCastEntry } from '../world/effective.js';
import { renderWorldIndex, renderWorldTree, renderTimelinePast, selectCodex, renderSceneSheet, renderSceneIndex, renderRecentScenes } from '../world/scene-sheet.js';
import { buildWorldGraph, graphNeighbors } from '../world/graph.js';
import { isFunctionalPredicate } from './predicates.js';
import { lintState } from './lint-state.js';
import { comparePromptMessages } from './prompt-drift.js';
import { evaluateFates, renderOmens } from '../world/fates.js';
import { narratorTailInstruction } from '../prompts/narrator.js';
import {
  getAssertions, getBranch, getRelations, getRecentTextForBranch,
  getScenes, getState, getThreads, getTurnsForBranch, getVoiceMap, getWorldState,
} from './store.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const join = (arr, sep = '、') => (arr || []).filter(Boolean).join(sep);

/** 稳定短哈希：用于判断「这一轮 system 与上一轮是否逐字节相同」。 */
function hashText(text) {
  let h = 5381;
  const t = String(text || '');
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

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

/**
 * 系统层总装：契约 + 命题 + 宪章 + 世界索引 + 主角（canon）。
 *
 * **只读模板快照，绝不读运行态。** system 是缓存前缀里最长的一段，
 * 一旦混进随轮次变化的内容（cast.role / cast.status / player.situation /
 * 剧情里临时登场的新实体），上一轮的 prompt 就不再是这一轮的前缀，
 * 命中率会被压缩到个位数。实测：system 冻结后相邻轮可共享前缀 +16.7pp。
 *
 * 运行态（此刻处境、伤情、临时登场者）由场记单负责，它不是 canon。
 */
export function buildSystemLayer(
  session, world, {
    card = normalizeCard(world?.card || {}),
    indexCap = config.context.layerBudget.system,
    graph = null,
    pastText = '',
  } = {},
) {
  /* ---- 必需单元：契约 + 宪章 + 主角 + 常驻作者笔记。它们先占预算，永不参与尾部截断。 ---- */
  const fixed = [buildContract(session, world, card)];
  const charter = (card.charter || [])
    .map((c, i) => `${i + 1}. ${c.rule}`)
    .join('\n');
  if (charter) {
    fixed.push(`【世界宪章】这个世界的硬设定，任何场景下都成立，不得违背。\n${charter}`);
  }
  const fixedText = fixed.join('\n\n');

  const tail = [];
  const player = card.player;
  if (player && (player.name || player.situation || player.inner_voice)) {
    const pl = [`【主角】${player.name}${player.age ? `，${player.age}` : ''}${player.identity ? `｜${player.identity}` : ''}`];
    // 这一段的每一项都是「他是谁」，不是「他此刻如何」。
    // 运行态（此刻处境 / 伤情 / 情绪 / 位置 / 当下目标）由场记单渲染，不进 system。
    if (player.situation) pl.push(`来路：${player.situation}`);
    if (player.capability) pl.push(`能力边界：${player.capability}`);
    if (player.inner_voice) pl.push(`内心声音：${player.inner_voice}`);
    if (player.wants) pl.push(`想要的：${player.wants}`);
    if (player.afraid) pl.push(`害怕的：${player.afraid}`);
    if (player.knowledge?.does_not_know?.length) pl.push(`他不知道：${join(player.knowledge.does_not_know)}`);
    tail.push(pl.join('\n'));
  }
  const notes = (card.author_notes || []).filter((n) => n.scope === 'always');
  if (notes.length) {
    tail.push(`【作者笔记】作者亲手写下的事实与规则，优先级高于一切自动记忆与即兴创作。\n${notes.map((n) => `· ${n.text}`).join('\n')}`);
  }
  const tailText = tail.join('\n\n');

  /* ---- 索引是可选单元：只吃剩余预算；超了先砍索引，不砍主角/作者笔记。 ---- */
  // 前史块（canon=past）排在索引之后、主角之前：它不是选择项，是与世界索引
  // 同级的 canon；先给它留出空间，索引再吃剩下的（前史自己按行丢最旧，见
  // renderTimelinePast）。future/branch 永不在这里出现（红线 3）。
  const reserve = estimateTokens(tailText) + 32;
  const pastTokens = pastText ? estimateTokens(pastText) + 2 : 0;
  const indexCapNow = Math.max(200, indexCap - estimateTokens(fixedText) - reserve - pastTokens);
  // 有包含关系时用树形索引；否则保持平铺。去重后的 codex 不再重复出现。
  const index = graph
    ? renderWorldTree(card, indexCapNow, { skipIds: graph.mergedCodexIds })
    : renderWorldIndex(card, indexCapNow);

  let text = [fixedText, index, pastText, tailText].filter(Boolean).join('\n\n');
  if (estimateTokens(text) > indexCap) {
    const excess = estimateTokens(text) - indexCap;
    const keep = estimateTokens(index) - excess - 8;
    const trimmedIndex = keep > 8 ? truncateToTokens(index, keep) : '';
    text = [fixedText, trimmedIndex, pastText, tailText].filter(Boolean).join('\n\n');
  }
  return text;
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
function pickCodex(card, { ledger, linked, present = [], pinnedIds = [], graph = null, playerLinked = null }) {
  const currentPlaceId = ledger?.place_id || null;
  const presentIds = [
    ...(linked?.cast || []),
    ...(linked?.codex || []),
    ...pinnedIds,
  ];
  if (currentPlaceId) presentIds.push(currentPlaceId);
  for (const item of ledger?.inventory || []) if (item.id) presentIds.push(item.id);

  const tags = sceneThemeTags(card, presentIds, ledger?.theme_tags || []);
  const skipIds = graph?.mergedCodexIds || null;
  const candidates = selectCodex(card, {
    presentIds,
    mentionedIds: linked?.codex || [],
    threadTags: tags,
    pinnedIds,
    currentPlaceId,
    skipIds,
  });

  if (!graph) return { candidates, t0: candidates, t1: [], themeTags: tags };

  // 焦点 = 在场人物 + 当前地点 + 随身物 + 钉选 + 玩家这一拍点名的辞书。
  const focus = new Set();
  const addFocus = (ref) => {
    const id = graph.resolve(ref);
    if (id) focus.add(id);
  };
  for (const c of present) addFocus(c.id);
  for (const id of playerLinked?.codex || []) addFocus(id);
  if (currentPlaceId) addFocus(currentPlaceId);
  for (const id of pinnedIds) addFocus(id);
  for (const item of ledger?.inventory || []) if (item.id) addFocus(item.id);

  const neighborIds = graphNeighbors(graph, focus, { depth: 1 });
  const byId = new Map(candidates.map((c) => [c.entry.id, c]));

  // 邻域里没有链接/标签/钉选的条目也要进 T1（一句摘要），否则图边白建。
  for (const id of neighborIds) {
    const entry = graph.codexById.get(id);
    if (!entry || skipIds?.has(id) || byId.has(id)) continue;
    const cand = { entry, score: 10, why: ['邻域'] };
    candidates.push(cand);
    byId.set(id, cand);
  }

  const t0 = [];
  const t1 = [];
  for (const cand of candidates) {
    const id = cand.entry.id;
    if (skipIds?.has(id)) continue; // 与 cast 同名的 codex，人物块已经覆盖
    const nodeId = graph.resolve(id) || id;
    if (focus.has(id) || focus.has(nodeId)) {
      t0.push(cand);
      continue;
    }
    // 未点名的 secret 不靠「邻域/主题」自动进场；要出现必须被钉选或玩家点名。
    if (cand.entry.reveal === 'secret') continue;
    if (neighborIds.has(id) || neighborIds.has(nodeId)
      || cand.why.includes('本场主题') || cand.why.includes('实体在场')) {
      t1.push(cand);
    }
  }
  return { candidates, t0, t1, themeTags: tags };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 4.5 断言选择（单值常驻 + 多值按相关性）                                  */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 选择进场的断言。旧实现是 `slice(0, 6)`——语义是「最近 6 条」，
 * 与「此刻相关的 6 条」完全是两件事。
 *
 * 分两类渲染是必要的：
 *   - **单值谓词**（位于/是/曾经是）：同一时刻只有一个对象，数量天然有界，**全部渲染**。
 *     漏掉它们就等于漏掉「他在哪」「她是谁」，是最贵的失忆。
 *   - **多值谓词**（知道/拥有/想要…）：数量无界，必须按相关性选。
 *
 * 相关性只用确定性信号，不做语义打分（避免变成变相的检索注入）：
 *   主语/宾语命中在场者 +3、命中当前地点 +2、命中未回收线索 +2、
 *   secret/engine 可见性 +1（张力来源）、越新越优先。
 *
 * @returns {{single:Array, many:Array, meta:object}}
 */
export function selectFacts(assertions = [], {
  presentKeys = new Set(), placeId = null, threadTitles = [], manyLimit = 10,
} = {}) {
  const threadText = (threadTitles || []).join('|');
  const hits = (text) => (text ? threadText.includes(text) : false);

  const score = (a) => {
    let s = 0;
    if (presentKeys.has(a.subject) || presentKeys.has(a.object)) s += 3;
    if (placeId && (a.object === placeId || a.subject === placeId)) s += 2;
    if (hits(a.subject) || hits(a.object)) s += 2;
    if (a.visibility === 'secret') s += 1;
    else if (a.visibility === 'engine') s += 1;
    return s;
  };

  const single = [];
  const many = [];
  for (const a of assertions || []) {
    if (isFunctionalPredicate(a.predicate)) single.push(a);
    else many.push({ a, s: score(a) });
  }

  many.sort((x, y) => y.s - x.s
    || (Number(y.a.valid_from) || 0) - (Number(x.a.valid_from) || 0));

  const keptMany = many.slice(0, Math.max(0, manyLimit)).map((x) => x.a);
  return {
    single,
    many: keptMany,
    meta: {
      single: single.length,
      many_candidates: many.length,
      many_rendered: keptMany.length,
      many_dropped: Math.max(0, many.length - keptMany.length),
    },
  };
}

/**
 * 知识边界按**线索组织**，而不是泛泛列 knows / does_not_know。
 * 「七年前的真相：凌玥知道；伍卿不知道」比两串词表有用得多——
 * 前者直接回答「这一拍谁不能说什么」。
 */
export function renderKnowledgeMatrix(present = []) {
  const byTopic = new Map();
  for (const c of present) {
    const k = c.knowledge || {};
    for (const t of k.knows || []) {
      if (!byTopic.has(t)) byTopic.set(t, { know: [], notKnow: [], wrong: [] });
      byTopic.get(t).know.push(c.name);
    }
    for (const t of k.does_not_know || []) {
      if (!byTopic.has(t)) byTopic.set(t, { know: [], notKnow: [], wrong: [] });
      byTopic.get(t).notKnow.push(c.name);
    }
    for (const t of k.believes_falsely || []) {
      if (!byTopic.has(t)) byTopic.set(t, { know: [], notKnow: [], wrong: [] });
      byTopic.get(t).wrong.push(c.name);
    }
  }
  const lines = [];
  for (const [topic, v] of byTopic) {
    const parts = [];
    if (v.know.length) parts.push(`${v.know.join('、')}知道`);
    if (v.notKnow.length) parts.push(`${v.notKnow.join('、')}不知道`);
    if (v.wrong.length) parts.push(`${v.wrong.join('、')}误信`);
    if (parts.length) lines.push(`${topic}：${parts.join('；')}`);
  }
  return lines;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 5. 回声（过去的原话）                                                    */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 回声 = 在场角色最近的原文台词 + 与未回收线索同文的旧原文片段。
 * 逐字引用，不是摘要——这是「细节能唤起」的落地方式。
 *
 * 轮次必须是真的：旧实现写死 turn_no:0，渲染成「第0轮」，模型无法判断这句是何时说的。
 */
function buildEchoes(voices, { present }) {
  const echoes = [];
  for (const c of present) {
    const lines = voices[c.name] || voices[c.id] || [];
    for (const v of lines.slice(0, 2)) {
      if (v?.text) echoes.push({ who: c.name, text: v.text, turn_no: Number(v.turn_no) || 0 });
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
  retrieval = null, previousMessages = null,
}) {
  const budget = config.context.layerBudget;
  // 硬上限由 narrator 绑定模型的 contextWindow 决定（未保存运行期配置时 = CONTEXT_MAX_TOKENS）。
  // 会话可以请求更小的上限，但不能超过模型窗口。
  const modelCap = resolveContextWindow('narrator');
  const requestedMax = Number(session?.settings?.context_max_tokens);
  const hardMax = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.min(requestedMax, modelCap)
    : modelCap;
  const softMax = Math.min(config.context.softTokens, hardMax);
  // 超硬上限策略：fail（默认，拒绝本轮并报错）| truncate（旧行为，调试/应急）。
  const hardCapMode = config.context.overHardCap === 'truncate' ? 'truncate' : 'fail';
  const sessionId = session.id;
  const branchId = session.branch_id || 'main';
  const branch = getBranch(sessionId, branchId);
  const forkTurn = branch ? branch.fork_turn : Number.MAX_SAFE_INTEGER;

  /* ---- 模板快照 + 世界线增量 → 本轮真实有效的世界 ---- */
  const templateCard = normalizeCard(session?.card_snapshot || world?.card || {});
  const deltas = getWorldState(sessionId, { branchId, atTurn: Number.isInteger(turnNo) ? turnNo : 0 });

  /* ---- 账本（fates 解锁判定要用到它，所以先读） ---- */
  const anchors = templateCard.anchors || [];
  const anchorId = session.anchor_id || anchors[0]?.id || null;
  const anchor = anchors.find((a) => a.id === anchorId) || anchors[0] || null;
  const ledgerAtTurn = Number.isInteger(turnNo) && turnNo > 0 ? turnNo - 1 : 0;
  const ledger = loadLedger(sessionId, anchor, { branchId, atTurn: ledgerAtTurn });

  /* ---- 成长曲线（fates）：纯函数求值，不调模型 ----
   * 没有 fates 的卡这里得到空数组，行为与纯 v4 完全一致。 */
  const fateState = evaluateFates(templateCard, {
    turnNo: Number(turnNo) || 0,
    ledger,
    assertions: getAssertions(sessionId, { branchId, atTurn: Number(turnNo) || 0, limit: 300 }),
    relations: getRelations(sessionId, { branchId, limit: 120 }),
    charStates: ledger?.characters || {},
  });

  const card = buildEffectiveWorld(templateCard, deltas, fateState.unlocked);
  // 辞书图谱：实体去重、包含关系、1 跳邻域都从投影后的世界计算。
  const graph = buildWorldGraph(card);

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
  const present0 = pickPresent(card, { ledger, linked: linkedPlayer });

  /* ---- 渲染前体检：能确定性修的矛盾就地修（死亡角色不应仍在场） ---- */
  const lint = lintState({
    ledger, present: present0, assertions: [], scenes: [], turnNo: Number(turnNo) || 0,
  });
  const present = lint.present;

  /* ---- 辞书 ---- */
  const pinnedIds = (card.codex || []).filter((e) => e.pinned).map((e) => e.id);
  const { t0: codexT0, t1: codexT1, themeTags } = pickCodex(card, {
    ledger, linked, present, pinnedIds, graph, playerLinked: linkedPlayer,
  });

  /* ---- 关系 / 线索 / 已成立的事实 ---- */
  const relations = getRelations(sessionId, { branchId, limit: 60 });
  const threads = getThreads(sessionId, { branchId, limit: 40 });
  const presentKeys = new Set(present.flatMap((c) => [c.id, c.name]));
  const allFacts = getAssertions(sessionId, { branchId, atTurn: Number.isInteger(turnNo) ? turnNo : 0, limit: 300 })
    .filter((a) => a.visibility !== 'secret' || presentKeys.has(a.subject));
  // 单值谓词全渲染（有界），多值谓词按相关性选（无界）。
  const factSel = selectFacts(allFacts, {
    presentKeys,
    placeId: ledger?.place_id || null,
    threadTitles: threads.filter((t) => t.status === 'open').map((t) => t.title),
    manyLimit: 10,
  });
  const facts = [...factSel.single, ...factSel.many];
  // 知识边界按线索组织（谁能在这一拍说出什么），而不是泛泛词表。
  const knowledgeMatrix = renderKnowledgeMatrix(present);
  // 成长曲线的「预兆」：只取已解锁且在场者，最多 2 条，进既有「压力」段。
  // 这样不需要新增注入通道——它就是压力的一种。
  const presentNames = new Set(present.flatMap((c) => [c.id, c.name]));
  const omens = renderOmens(fateState.unlocked, presentNames, 2);

  /* ---- 原声：既做「回声」，也按角色给在场者卡锚定声线 ---- */
  const voiceMap = getVoiceMap(sessionId, { branchId, perWho: 3 });
  const voices = {};
  for (const [who, lines] of Object.entries(voiceMap)) voices[who] = lines.map((v) => v.text);
  const echoes = buildEchoes(voiceMap, { present });

  /* ---- 场记单 ---- */
  // 辞书条目按「每条预估成本」决定能塞几条，而不是固定 slice：
  // 优先高分（实体连接/钉选）的条目，低分的在配额不够时整条放弃。
  const sceneCap = budget.scene;
  const perEntryCost = 90;
  const codexSlots = Math.max(1, Math.floor(sceneCap * 0.45 / perEntryCost));
  const selectedCodex = codexT0.slice(0, codexSlots);
  const briefSlots = Math.max(0, Math.floor(sceneCap * 0.2 / 40));
  const selectedBrief = codexT1.slice(0, briefSlots);
  const sheet = renderSceneSheet({
    ledger,
    present,
    relations,
    threads,
    codex: selectedCodex,
    codexBrief: selectedBrief,
    voices,
    echoes,
    facts,
    knowledgeMatrix,
    omens,
    worldRuntime: card.runtime || {},
    // 主角运行态从 system 搬到场记单：信息不丢，但 system 得以逐字节冻结。
    playerNow: {
      condition: card.player?.condition, mood: card.player?.mood,
      location: card.player?.location, goal: card.player?.goal,
      status: card.player?.status, situation: card.player?.situation,
    },
    directive: directive || str(session.settings?.scene_directive),
    capTokens: sceneCap,
  });
  // 候选 ≠ 实际渲染：场记单预算不足时，codex/facts 可能整段被丢。
  const codexRendered = sheet.meta?.codex_rendered ?? selectedCodex.length;
  const codexBriefRendered = sheet.meta?.codex_brief_rendered ?? 0;
  const factsRendered = (sheet.meta?.kept || []).includes('facts') ? facts.length : 0;

  /* ---- 系统层（稳定前缀，只读 canon） ---- */
  // 关键：传的是**模板快照** templateCard，不是投影后的 card。
  // system 一旦读运行态，前缀每轮都失效（实测 1000 轮里 system 变 251 次）。
  // 前史块（timeline canon=past）也来自模板快照：它是「开局之前已经成立」的
  // canon，不是本局演出结果。future/branch 永不渲染（红线 3）。
  const timelinePast = renderTimelinePast(templateCard, 240);
  const systemMsg = {
    role: 'system',
    content: buildSystemLayer(session, world, {
      card: templateCard,
      indexCap: budget.system,
      graph: buildWorldGraph(templateCard),
      pastText: timelinePast.text,
    }),
  };

  /* ---- 场次索引（长程记忆的载体，只追加） ---- */
  // 只取「本轮之前」已经封场的场次；当前这一场还在写，不能进索引。
  // 索引是缓存友好的：老场次的行永远不变，只有末尾追加新行。
  const allScenes = getScenes(sessionId, { branchId, limit: 4000 });
  const closedScenes = (Number.isInteger(turnNo) && turnNo > 0)
    ? allScenes.filter((s) => s.turn_to < turnNo)
    : allScenes;
  const sceneIndex = renderSceneIndex(closedScenes, budget.archive);
  const archiveMsg = sceneIndex.text ? { role: 'user', content: sceneIndex.text } : null;

  /* ---- 逐字原文窗口 ---- */
  // 窗口 = **当前场次起点到本轮之前**的全部回合：不按「最后 N 轮」取，也不做字符串裁剪。
  // 旧实现用「摘要边界 + 1」做起点；摘要被移除后，边界改由场次决定：
  // 场次记录已经覆盖的回合不再逐字出现（它们在场次索引里），当前场次逐字保留。
  // 这条不变量比旧版更强：不会出现「摘要覆盖了但场次没记」的空洞。
  const sceneCoveredTo = closedScenes.length ? closedScenes[closedScenes.length - 1].turn_to : 0;
  const rawRows = getTurnsForBranch(sessionId, branchId, forkTurn, {
    from: sceneCoveredTo + 1,
    kinds: ['player', 'narrator'],
  });
  const recentRows = (Number.isInteger(turnNo) && turnNo > 0)
    ? rawRows.filter((r) => r.turn_no < turnNo)
    : rawRows;
  const recentMsgs = toRecentMessages(recentRows);
  const recentTurnNos = [...new Set(recentRows.map((r) => r.turn_no))];

  /* ---- 刚才这一场怎么收的（场次细节，位置贴近生成点） ---- */
  const recentScenes = renderRecentScenes(closedScenes, budget.archiveDetail);
  let recentSceneMsg = recentScenes.text ? { role: 'user', content: recentScenes.text } : null;

  const coverage = {
    // 这两个字段保留旧名，便于 UI/测试平滑读取；含义改为「场次覆盖到哪」。
    summary_to: sceneCoveredTo,
    recent_from: recentTurnNos.length ? recentTurnNos[0] : null,
    recent_to: recentTurnNos.length ? recentTurnNos[recentTurnNos.length - 1] : null,
    turns: recentTurnNos.length,
    // 场次覆盖：索引覆盖到第几轮，当前场从哪一轮起。
    scene_count: closedScenes.length,
    scene_to: sceneCoveredTo,
    scene_index_rendered: sceneIndex.meta.rendered,
    scene_index_dropped: sceneIndex.meta.dropped,
    scene_index_degraded: sceneIndex.meta.degraded,
  };

  /* ---- 本轮输入 ---- */
  const sceneNotes = (card.author_notes || []).filter((n) => n.scope === 'scene' || n.scope === 'session');
  // 逐轮 directive 也必须进尾注：场记单可能因为预算丢掉「本场指令」，
  // 尾注是最贴近生成点的通道，不能只保护 session 级指令。
  const directiveText = [...new Set([
    str(directive),
    str(session.settings?.scene_directive),
    ...sceneNotes.map((n) => str(n.text)),
  ].filter(Boolean))].join('\n');
  let extra = '';
  if (isOpening) {
    extra = str(anchor?.opening_seed)
      ? `【开场】这是剧情的第一轮。请从下面的开场种子起笔：交代环境、主角处境与第一个可回应的情势，让在场的人物以各自的方式登场，并埋下核心悬念。\n\n${anchor.opening_seed}`
      : '【开场】这是剧情的第一轮。请依据世界宪章与主角设定，自行起笔一个强有力的开场。';
  }
  const currentMsg = buildCurrent(playerText, images, branchChoice, extra, buildTail(card, { directive: directiveText, isOpening }));

  /* ---- 汇总：system → 场次索引 → 最近原文 → 场次细节 → 场记单 → 检索 → 本轮 ---- */
  // 缓存友好的顺序：稳定前缀（system）→ 只追加的历史（场次索引 + 逐字原文）→
  // 每轮易变的尾部（场景细节 + 场记单 + 检索 + 本轮输入）。
  let sheetMsg = sheet.text ? { role: 'user', content: sheet.text } : null;
  let retrievalMsg = retrieval?.text ? { role: 'user', content: retrieval.text } : null;
  const compose = () => [
    systemMsg,
    ...(archiveMsg ? [archiveMsg] : []),
    ...recentMsgs,
    ...(recentSceneMsg ? [recentSceneMsg] : []),
    ...(sheetMsg ? [sheetMsg] : []),
    ...(retrievalMsg ? [retrievalMsg] : []),
    currentMsg,
  ];
  let messages = compose();

  /* ---- 超预算降级：软目标只裁易变尾部；硬上限整层收窄，绝不切半句 ----
   * 顺序原则：**先牺牲易变尾部，再牺牲历史**。
   * 场次索引（archive）与逐字原文（recent）不在软目标降级范围内：
   * 它们是记忆载体，砍了就是静默失忆。
   * 硬上限是「事故」不是「策略」：默认 fail-closed（拒绝本轮并说明处置办法），
   * 不允许把半句话送进模型；只有显式 CONTEXT_OVER_HARD_CAP=truncate 才回退旧行为。
   */
  const totalNow = () => messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  const degraded = [];
  if (totalNow() > softMax && recentSceneMsg) {
    const excess = totalNow() - softMax;
    const cur = estimateMessageTokens(recentSceneMsg);
    recentSceneMsg.content = truncateToTokens(recentSceneMsg.content, Math.max(200, cur - excess));
    messages = compose();
    degraded.push('scene_detail');
  }
  if (totalNow() > softMax && sheetMsg) {
    const excess = totalNow() - softMax;
    const cur = estimateMessageTokens(sheetMsg);
    sheetMsg.content = truncateToTokens(sheetMsg.content, Math.max(600, cur - excess));
    messages = compose();
    degraded.push('scene_sheet');
  }

  // 硬上限：先按「整层」收窄（场景细节 → 场记单 → 检索）。每次都是完整消息进/出，
  // 不会出现「半句话」；记忆载体（archive/recent/current/system）永不被字符串截断。
  const narrowed = [];
  if (totalNow() > hardMax && recentSceneMsg) {
    recentSceneMsg = null;
    messages = compose();
    narrowed.push('scene_detail');
    degraded.push('scene_detail_dropped');
  }
  if (totalNow() > hardMax && sheetMsg) {
    sheetMsg = null;
    messages = compose();
    narrowed.push('scene_sheet');
    degraded.push('scene_sheet_dropped');
  }
  if (totalNow() > hardMax && retrievalMsg) {
    retrievalMsg = null;
    messages = compose();
    narrowed.push('retrieval');
    degraded.push('retrieval_dropped');
  }
  let hardCapped = false;
  if (totalNow() > hardMax) {
    if (hardCapMode === 'truncate') {
      // 显式回退：旧行为，只给调试/应急。仍然必须显式记录，不允许静默失真。
      for (let guard = 0; guard < 30 && totalNow() > hardMax; guard++) {
        const candidates = messages
          .map((m, i) => ({ m, i }))
          .filter(({ m, i }) => typeof m.content === 'string' && m.role !== 'system'
            && i !== messages.length - 1 && m !== currentMsg);
        if (!candidates.length) break;
        candidates.sort((a, b) => estimateMessageTokens(b.m) - estimateMessageTokens(a.m));
        const m = candidates[0].m;
        const t = estimateMessageTokens(m);
        if (t < 80) break;
        m.content = truncateToTokens(m.content, Math.max(60, Math.floor(t * 0.7)));
        hardCapped = true;
      }
      // 记「仍超硬上限」而不是「是否真的截过」：即使只剩 system 一条放不下，
      // 也必须让调用方看到 over_hard_cap，而不是静默送模。
      if (totalNow() > hardMax || hardCapped) degraded.push('over_hard_cap');
    } else {
      const over = totalNow();
      const err = new Error(
        `上下文超过硬上限 ${hardMax} tok（当前约 ${over} tok）。场次索引与逐字原文是记忆载体，`
        + `不做字符串截断；已整层收窄：[${narrowed.join(', ') || '无'}]。`
        + `请先封场（减少当前场原文）、换更大上下文的模型，或调低 BUDGET_RECENT。`,
      );
      err.code = 'CONTEXT_OVER_HARD_CAP';
      err.meta = {
        total: over,
        hard_max: hardMax,
        soft_max: softMax,
        mode: hardCapMode,
        narrowed,
        degraded: [...degraded, 'over_hard_cap'],
      };
      throw err;
    }
  }

  const budgetOf = (content) => (content ? estimateTokens(content) + 4 : 0);
  const breakdown = {
    system: budgetOf(systemMsg.content),
    archive: archiveMsg ? budgetOf(archiveMsg.content) : 0,
    summary: 0,
    recent: recentMsgs.reduce((s, m) => s + estimateMessageTokens(m), 0),
    scene: (sheetMsg ? budgetOf(sheetMsg.content) : 0)
      + (recentSceneMsg ? budgetOf(recentSceneMsg.content) : 0),
    retrieval: retrievalMsg ? budgetOf(retrievalMsg.content) : 0,
    current: estimateMessageTokens(currentMsg),
  };
  breakdown.total = breakdown.system + breakdown.archive + breakdown.summary + breakdown.recent
    + breakdown.scene + breakdown.retrieval + breakdown.current;

  /* ---- 缓存可归因信息：这一轮的前缀能复用多少、第一个断点在哪 ----
   * 没有这两个字段，就无法回答「这一轮缓存没命中是因为什么」，
   * 所有优化都只能靠猜。纯字符串比较，零 token 成本。 */
  const prev = previousMessages && previousMessages.length ? previousMessages : null;
  let prefixShared = 0;
  let firstDivergence = null;
  if (prev) {
    const labels = ['system', 'archive', 'recent', 'scene', 'retrieval', 'current'];
    const bucket = (i) => {
      if (i === 0) return 'system';
      if (archiveMsg && i === 1) return 'archive';
      if (recentSceneMsg && messages[i] === recentSceneMsg) return 'scene';
      if (sheetMsg && messages[i] === sheetMsg) return 'scene';
      if (retrievalMsg && messages[i] === retrievalMsg) return 'retrieval';
      if (messages[i] === currentMsg) return 'current';
      return 'recent';
    };
    const lim = Math.min(prev.length, messages.length);
    for (let i = 0; i < lim; i++) {
      const a = prev[i], b = messages[i];
      const ca = typeof a.content === 'string' ? a.content : JSON.stringify(a.content);
      const cb = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      if (a.role === b.role && ca === cb) { prefixShared += estimateMessageTokens(b); continue; }
      if (a.role === b.role) {
        let k = 0;
        while (k < ca.length && k < cb.length && ca[k] === cb[k]) k++;
        prefixShared += estimateTokens(ca.slice(0, k));
      }
      firstDivergence = bucket(i) || labels[0];
      break;
    }
  }
  // 消息级漂移探针：比「层名」更细——给出第一条分叉的消息 index、字符 offset
  // 与两侧摘录，用来回答「缓存没命中到底断在哪个字」。纯字符串比较，零 token。
  const drift = comparePromptMessages(prev, messages);

  // 渲染归属：每条送模消息来自哪一层（顺序与 compose 一致）。只进 meta，不进提示词，
  // 用来回答「这句是谁加的」；后续按层归因开销也从这里查。
  const messageOwners = ['system'];
  if (archiveMsg) messageOwners.push('archive');
  for (let i = 0; i < recentMsgs.length; i++) messageOwners.push('recent');
  if (recentSceneMsg) messageOwners.push('scene_detail');
  if (sheetMsg) messageOwners.push('scene_sheet');
  if (retrievalMsg) messageOwners.push('retrieval');
  messageOwners.push('current');

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
      codex_candidates: codexT0.length,
      codex_rendered: codexRendered,
      codex_dropped: Math.max(0, codexT0.length - codexRendered),
      codex_brief_candidates: codexT1.length,
      codex_brief_rendered: codexBriefRendered,
      graph: {
        entities: graph.entities.size,
        edges: graph.edges.length,
        merged_codex: graph.mergedCodexIds.size,
      },
      timeline_past: (card.timeline || []).filter((t) => t.canon === 'past').length,
      timeline_future_held: (card.timeline || []).filter((t) => t.canon === 'future').length,
      // 前史块落位：只进 system 世界索引（与世界索引共享 system 预算），
      // 是 canon=past 的唯一入口；future/branch 不在这里计数（它们不进提示词）。
      system_blocks: {
        timeline_past: { ...timelinePast.meta, cap: 240 },
      },
      world_state_changes: deltas.length,
      facts: factsRendered,
      facts_candidates: facts.length,
      facts_single: factSel.meta.single,
      facts_many_rendered: factSel.meta.many_rendered,
      facts_many_dropped: factSel.meta.many_dropped,
      // 渲染前体检：修了什么、还有什么矛盾（都不进提示词，只进 meta 供排查）
      state_fixes: lint.fixes,
      state_warnings: lint.warnings,
      // 成长曲线：解锁了哪些阶段、渲染了哪几条预兆
      fates: {
        total: fateState.meta.total,
        unlocked: fateState.unlocked.map((f) => ({ who: f.who, stage: f.stage, label: f.label })),
        omens: omens.map((o) => ({ who: o.who, stage: o.stage })),
      },
      dropped_sections: sheet.meta?.dropped || [],
      branch: branchId,
      // 覆盖清单：场次索引边界 + 原文窗口。两者应当首尾相接：
      // recent_from 必须等于 scene_to + 1（场次无缝、无洞）。
      coverage,
      // 摘要层已移除，保留这个字段为 null 以保持下游读取形状稳定。
      summary: null,
      retrieval: retrieval?.text
        ? { queries: retrieval.queries || [], entries: retrieval.entries || [], tokens: breakdown.retrieval }
        : null,
      degraded,
      // 渲染归属审计：逐条列出 owner 与估算 token（只进 meta，不进提示词）。
      messages: messages.map((m, i) => ({
        index: i,
        role: m.role,
        owner: messageOwners[i] || 'unknown',
        tokens: estimateMessageTokens(m),
      })),
      // 缓存可归因：上一轮消息序列与本轮的最长公共前缀（估算 tok），
      // 以及第一个分叉发生在哪一层。有了它才能回答「为什么没命中」。
      cache: {
        prefix_shared_tokens: prefixShared,
        prefix_shared_rate: breakdown.total > 0
          ? Math.round((prefixShared / breakdown.total) * 1000) / 1000
          : null,
        first_divergence: firstDivergence,
        system_hash: hashText(systemMsg.content),
        // identical / appendedMessages / broken / unknown + index/offset/摘录。
        // 只进 meta 与诊断日志，不进提示词；摘录可能含正文，不往前端展示面推。
        drift,
      },
      soft_max: softMax,
      hard_max: hardMax,
      // 硬上限策略与「整层收窄」记录：fail 模式下本字段只出现在错误 meta 里。
      hard_cap: { mode: hardCapMode, narrowed },
    },
  };
}
