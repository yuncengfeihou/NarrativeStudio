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
 *   5. user    场记单（runtime，每场变一次，尾部注意力最强）
 *   6. user    本场指令 + 本轮行动
 *
 * 记忆不变量：场次索引覆盖到的边界 + 1 是原文窗口的**默认**起点；封场后允许再往回带
 * 至多 `config.context.recentOverlapTurns` 个回合（D1 封场尾巴，见下）。
 * 原文窗口不做字符串裁剪；它由「场次记录」（每场一行、只追加、永不互相改写）接住，
 * 场次从本场完整原文生成。窗口只会比场次边界更宽（重叠），绝不会更窄（出现洞）。
 *
 * 缓存不变量：system 只承载 canon，绝不读 world_state 投影后的运行态——
 * 它一变，后面整段前缀全部失效。判据见 test-context.js 的「缓存前缀」段。
 *
 * 词条（codex）进场靠三条路：实体连接（在场/被提及/被钉选）、主题标签、用户钉选。
 * 唯一保留的字符串匹配是实体链接：它只回答「文本提到了谁」，用来更新场记单的
 * 在场者与随身物，不回答「该注入哪段设定」。
 */
import { config } from '../config.js';
import { estimateMessageTokens, estimateTokens, truncateToTokens } from '../tokens.js';
import { normalizeCard, buildAliasIndex, linkEntities, sceneThemeTags } from '../world/schema.js';
import { buildEffectiveWorld, emptyPersonEntry } from '../world/effective.js';
import { renderWorldIndex, renderWorldTree, renderTimelinePast, selectCodex, renderSceneSheet, composeSheetText, renderSceneIndex, renderRecentScenes, THREAD_RENDER_MAX } from '../world/scene-sheet.js';
import { buildWorldGraph, graphNeighbors } from '../world/graph.js';
import { isFunctionalPredicate } from './predicates.js';
import { currentPlan } from './context-plan.js';
import { lintState } from './lint-state.js';
import { comparePromptMessages } from './prompt-drift.js';
import { evaluateFates, renderOmens } from '../world/fates.js';
import { narratorTailInstruction } from '../prompts/narrator.js';
import { resolveCraft, renderCraftBlock } from '../world/craft.js';
import {
  countAssertions, countRelations, countThreads,
  getAssertions, getBranch, getRelations, getRecentTextForBranch,
  getScenes, getState, getThreads, getTurnsForBranch, getVoiceMap, getWorldState, listPatches,
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
 *
 * 工艺层（`server/world/craft.js`）与这里是**替换关系**，不是叠加：
 *   - 「收束」「不替主角做决定」「专名一致」原先散在范式里，现归 craft 的通用底线 + 结尾落点，
 *     范式里相应删掉，避免同一条规则换两种说法各说一遍。
 *   - 「文风」优先级恒定：卡的 `prompt.style_guide` > 工艺预设 > 无。作者写了就不再注入预设文风。
 *
 * @param {object} [craft] resolveCraft() 的结果；缺省则按默认轴现算（单独调用也能用）。
 */
export function buildContract(session, world, card = normalizeCard(world?.card || {}), { craft = null } = {}) {
  const p = card.prompt;
  const title = card.title || session?.title || '未命名剧情';
  const c = craft || resolveCraft(session?.settings || {});
  // 作者在卡里写了文风，就以卡为准；工艺预设的文风不再出现（否则同一层里两套写法互相打架）。
  const authorStyle = str(p.style_guide);

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

  // 篇幅只有作者在卡里写了才渲染；不写就不出现这一条（编号顺延，不留空号）。
  const paradigm = [
    `视角：${p.pov}。主角不在场的信息只能通过痕迹、传闻、他人转述呈现，不得直接叙述。`,
    p.length ? `篇幅：本轮 ${p.length}。` : '',
    `时态：${p.tense}。不写纯装饰性描写。`,
    '不得出现元叙述：不写「作为 AI」「本章」「综上所述」「作者」，不解释、不总结、不预告。',
    '不得让任何角色说出他不可能知道的信息；不得为了推进剧情让角色降智。',
    '只输出剧情正文。不要标题、不要章节号、不要 Markdown 标记、不要任何前后缀说明。',
  ].filter(Boolean);

  lines.push(
    '',
    '# 演出范式（硬性）',
    ...paradigm.map((rule, i) => `${i + 1}. ${rule}`),
  );

  // 通用底线 + 时间流速 + 对白形态（+ 预设文风）：全部落在 system，不新增注入通道。
  const block = renderCraftBlock(c, { includeStyle: !authorStyle });
  if (block.text) lines.push('', block.text);

  if (authorStyle) {
    lines.push('', '# 文风（作者钦定）', authorStyle);
  }
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
    // 默认取当前规划（装配器总会显式传）；单独调用时也不至于把索引清空。
    indexCap = currentPlan().layers.system,
    graph = null,
    pastText = '',
    craft = null,
  } = {},
) {
  /* ---- 必需单元：契约 + 宪章 + 主角 + 常驻作者笔记。它们先占预算，永不参与尾部截断。 ---- */
  // meta 必须记录「实际渲染的那一块」：作者写了 style_guide 时预设文风不渲染，
  // 这里也要用同一个 includeStyle 口径，否则 meta 会报一条没进提示词的文风。
  const authorStyle = str(card.prompt?.style_guide);
  const craftBlock = renderCraftBlock(
    craft || resolveCraft(session?.settings || {}, {}, card.craft),
    { includeStyle: !authorStyle },
  );
  const fixed = [buildContract(session, world, card, { craft })];
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
  const indexMode = graph ? 'tree' : 'flat';
  let index = graph
    ? renderWorldTree(card, indexCapNow)
    : renderWorldIndex(card, indexCapNow);

  let text = [fixedText, index, pastText, tailText].filter(Boolean).join('\n\n');
  if (estimateTokens(text) > indexCap) {
    const excess = estimateTokens(text) - indexCap;
    const keep = estimateTokens(index) - excess - 8;
    index = keep > 8 ? truncateToTokens(index, keep) : '';
    text = [fixedText, index, pastText, tailText].filter(Boolean).join('\n\n');
  }
  return {
    text,
    // 覆盖率跟着「最终送进 system 的那段索引」测量，而不是渲染前的候选。
    meta: {
      index_coverage: measureIndexCoverage(card, index, indexCapNow, indexMode),
      // 工艺块：渲染了几段、被 system 预算挤掉了哪几段（整条丢，不留半句）。
      craft: craftBlock.meta,
    },
  };
}

/**
 * 索引覆盖率：世界索引是「世界里有什么」的唯一自动入口。
 * 卡变大后它会退化成名字清单、再被截断——被截掉的实体不等于不存在，
 * 但模型只能从索引知道它们存在。覆盖率只进 meta（不进提示词），
 * 用来回答「这张卡在系统层里还剩多少实体是可见的」，也是制卡期告警的数据源。
 *
 * 注意：这是**事后测量**（在渲染文本里找名字），不是又一次实体匹配注入；
 * 名字是子串命中，只用于统计，不参与任何注入决策。
 */
function measureIndexCoverage(card, indexText, capTokens, mode) {
  const entities = card.entities || [];
  const text = String(indexText || '');
  let rendered = 0;
  let muted = 0;
  const droppedNames = [];
  for (const e of entities) {
    const name = str(e.name || e.id).trim();
    if (!name) continue;
    // 静音只对「自动带出」生效，且只作用于非人物事实（与 scene-sheet 的 factsOf 同口径）。
    if (e.muted && e.type !== 'person') { muted++; continue; }
    if (text.includes(name)) { rendered++; continue; }
    droppedNames.push(name);
  }
  return {
    total: entities.length,
    rendered,
    muted,
    dropped: droppedNames.length,
    // 只带名字，便于排查；上限防止 meta 自己膨胀（meta 不进提示词，但会进库里 JSON）。
    dropped_names: droppedNames.slice(0, 20),
    tokens: estimateTokens(text),
    cap: capTokens,
    mode,
  };
}

/**
 * 实体召回率：最终送模文本里出现了多少个卡内实体的名字。
 * 与 measureIndexCoverage 的区别：后者只看 system 的世界索引（自动入口），
 * 这里看整轮上下文（索引 + 场次索引 + 逐字原文 + 场记单），回答「模型这一拍
 * 到底看得见多少实体」。只进 meta，不进提示词，不参与任何注入决策；
 * 名字是子串命中，是近似指标，不是「模型一定知道」。
 */
function measureEntityRecall(card, messages) {
  const entities = (card?.entities || []).filter((e) => str(e.name || e.id).trim());
  const text = (messages || [])
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
  const byType = {};
  let visible = 0;
  for (const e of entities) {
    const name = str(e.name || e.id).trim();
    const type = str(e.type) || 'custom';
    if (!byType[type]) byType[type] = { visible: 0, total: 0 };
    byType[type].total++;
    if (text.includes(name)) {
      visible++;
      byType[type].visible++;
    }
  }
  return {
    total: entities.length,
    visible,
    rate: entities.length ? Math.round((visible / entities.length) * 1000) / 1000 : null,
    by_type: byType,
  };
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
  const persons = (card.entities || []).filter((e) => e.type === 'person');
  const byId = new Map(persons.map((c) => [c.id, c]));
  const byName = new Map(persons.map((c) => [c.name, c]));
  const ids = new Set();

  for (const c of persons) if (c.always_present) ids.add(c.id);
  const stage = Array.isArray(ledger?.present) && ledger.present.length
    ? ledger.present
    : Object.keys(ledger?.characters || {});
  for (const key of stage) {
    const hit = byId.get(key) || byName.get(key);
    ids.add(hit ? hit.id : key);
  }
  for (const id of linked?.person || []) ids.add(id);
  // 玩家角色永远在场：他就是镜头本身
  if (card.player?.canon_character) ids.add(card.player.canon_character);
  else if (card.player?.name) ids.add(card.player.name);

  // 账本里出现过、但卡里没有的名字，是剧情即兴造出来的人：
  // 给一个最小条目，让他至少能进场，而不是被静默丢掉。
  const present = [...ids]
    .map((id) => byId.get(id) || byName.get(id) || emptyPersonEntry(id, id))
    .filter(Boolean);

  // 玩家角色可能不在卡里（原创主角）。为他造一个最小条目，保证场记单有他。
  const playerId = card.player?.canon_character || card.player?.name;
  if (playerId && !present.some((c) => c.id === playerId || c.name === playerId)) {
    const p = card.player;
    present.unshift({
      id: playerId,
      type: 'person',
      name: p.name || '主角',
      aliases: [],
      role: '主角',
      summary: '',
      status: p.status || '',
      condition: p.condition || '',
      mood: p.mood || '',
      location: p.location || '',
      goal: p.goal || '',
      identity: { age: p.age || '', appearance: p.appearance || '', background: '', station: '' },
      voice: { address: {}, rhythm: p.inner_voice || '', lexicon: [], never: [], exemplars: [] },
      psyche: {
        traits: [],
        wants: p.wants ? [p.wants] : [],
        fears: p.afraid ? [p.afraid] : [],
        hides: [],
        values: [],
      },
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
    ...(linked?.person || []),
    ...(linked?.fact || []),
    ...pinnedIds,
  ];
  if (currentPlaceId) presentIds.push(currentPlaceId);
  for (const item of ledger?.inventory || []) if (item.id) presentIds.push(item.id);

  const tags = sceneThemeTags(card, presentIds, ledger?.theme_tags || []);
  const candidates = selectCodex(card, {
    presentIds,
    mentionedIds: linked?.fact || [],
    threadTags: tags,
    pinnedIds,
    currentPlaceId,
  });

  if (!graph) return { candidates, t0: candidates, t1: [], themeTags: tags };

  // 焦点 = 在场人物 + 当前地点 + 随身物 + 钉选 + 玩家这一拍点名的设定。
  const focus = new Set();
  const addFocus = (ref) => {
    const id = graph.resolve(ref);
    if (id) focus.add(id);
  };
  for (const c of present) addFocus(c.id);
  for (const id of playerLinked?.fact || []) addFocus(id);
  if (currentPlaceId) addFocus(currentPlaceId);
  for (const id of pinnedIds) addFocus(id);
  for (const item of ledger?.inventory || []) if (item.id) addFocus(item.id);

  const neighborIds = graphNeighbors(graph, focus, { depth: 1 });
  const byId = new Map(candidates.map((c) => [c.entry.id, c]));

  // 邻域里没有链接/标签/钉选的**事实实体**也要进 T1（一句摘要），否则图边白建。
  // 人物不进设定集候选：他们在场时由场记单渲染，不等于「设定集条目」。
  for (const id of neighborIds) {
    const entry = graph.entityById.get(id);
    if (!entry || entry.type === 'person' || byId.has(id)) continue;
    const cand = { entry, score: 10, why: ['邻域'] };
    candidates.push(cand);
    byId.set(id, cand);
  }

  const t0 = [];
  const t1 = [];
  for (const cand of candidates) {
    const id = cand.entry.id;
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

/* 回声段已删除（D18）。原来的「回声」= 在场角色最近 2 句原话，与场记单
 * 「在场」段里每人的「原声：」逐字相同——同一段文本在一张单子里出现两次，
 * 76 拍实测 278/278 条 100% 重复，占总预算 73 tok/拍却零新增信息。
 * 它承担的唯一功能是「让模型看见这句是第几轮说的」，已并入「原声」行的
 * 「第N轮」标注（renderCastLine），信息不丢、不再重复。
 * 不要把它加回来：段头那句「可自然带出，不要整段复述」没有拦住复制，
 * 而复制品在报告里永远显示健康（它从不缺预算、从不进 dropped_sections）。 */

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
function buildTail(card, { directive, isOpening, craft }) {
  return narratorTailInstruction(card, { directive, isOpening, craft });
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

/**
 * 逐字原文窗口的起点（D1 封场尾巴）。
 *
 * 规则本体只写一处：资料员的历史通道要用「这一拍上下文里已经看得见哪几拍」来决定
 * 少查掉哪一段（D4 后验），所以两边必须共读同一个函数，否则
 * 「上下文里有」和「检索不再查」会各自漂。
 *
 * **起点只由场次边界决定：`sceneCoveredTo + 1 - overlapTurns`（不小于 1）。**
 * 它绝不能含 `turnNo`。曾经写成 `min(covered + 1, turnNo - n)`，看起来「短场多带、
 * 长场收敛」，实际后果是窗口每拍往后滑一格（`turnNo - n` 是随轮数增长的下限，
 * `min()` 在短场时正好选中它）：`recent_from` 在同一个场次里 t5=3 → t6=4 → t7=5 一路爬，
 * 每拍丢掉最旧一条消息，缓存前缀每拍作废（D16，见
 * _work/longrun-scale-discussion.md）。窗口必须是「固定起点 + 只追加」，
 * 否则 §6.2 的「稳定前缀 → 只追加历史」整条失效。
 *
 * 于是刚切场那一刻窗口 = 上一场末尾 n 拍..当前拍之前；当前场继续时起点不变、只加新的，
 * 上一场那 n 拍会一直陪到本场封场（有界：每场固定多 n 拍），这正是「封场尾巴」的含义。
 * `turnNo` 只做「不能看到未来」的收口，不参与起点。
 */
export function overlapWindowFrom(sceneCoveredTo, turnNo, overlapTurns = 0) {
  const covered = Math.max(0, Number(sceneCoveredTo) || 0);
  const n = Math.max(0, Number(overlapTurns) || 0);
  // 只在「已封场范围比本轮还靠后」（回合编号有空洞时的极端情形）夹到本轮之前；
  // 否则起点原样返回，`overlap_turns = 0` 时 start > turnNo − 1，取数自然为空窗口。
  const start = Math.max(1, covered + 1 - n);
  if (Number.isInteger(turnNo) && turnNo > 0 && start > turnNo) {
    return Math.max(1, turnNo - n > 0 ? turnNo - n : turnNo);
  }
  return start;
}

/**
 * 历史检索不该再查的起点（D4 后验）。
 *
 * 上下文里逐字可见的那一段（`recent` 层）再去检索一次，拿回来的必然是模型已经看见的东西：
 * 50 轮实测 20 条历史查询里 15 条是本拍玩家动作的子串，而跨距长的查询全部落空。
 * 这里只回答「从第几拍起已经在上下文里了」，实际跳过由 store 的 `excludeFrom` 执行。
 */
export function recallVisibleFrom(sceneCoveredTo, turnNo, overlapTurns = 0) {
  return overlapWindowFrom(sceneCoveredTo, turnNo, overlapTurns);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 走向版场记单的裁剪档位（D26）                                          */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 走向 Agent 只读「这张单子里跟『下一步能走哪条路』有关的那几段」。
 *
 * - `default`（默认）：只去掉「附近设定」。那是给正文展开细节用的，实测每拍
 *   1595 tok（branch user 的 18%），离线配对 A/B 里从未影响走向标题与描述。
 * - `core_only`（D26 方案 A，实验开关）：再去掉「已成立的事实 / 知识边界 /
 *   本场可用设定」三段。离线 21 拍配对回放：省 25.4% 的 branch prompt，
 *   在场人物被提到 0.00 差、不在场人物 −0.38（更聚焦）、物件/地点 −0.71。
 *
 * **为什么是会话级开关而不是直接改默认**：这是待长跑定案的实验，
 * 默认值一变，`tests/test-context.js` 里那条「走向版只少 codexBrief」的断言
 * 就不再描述线上行为了。开关关闭时下面 filter 的表达式与旧实现逐字节等价。
 *
 * **裁的是「同一份 sections」，不是重新渲染**：重渲染会连字数取舍都变，
 * A/B 就不再是「只差被删的段」。
 */
export const BRANCH_SHEET_TRIMS = ['default', 'core_only'];

/** `core_only` 保留的段：与 renderSceneSheet 的 sections key 同名。 */
export const BRANCH_CORE_KEYS = new Set([
  'when', 'world', 'player', 'cast', 'relations', 'threads', 'pressure', 'directive',
]);

/** 会话设置归一：非法/缺省一律回 `default`（不因为写错一个词就静默改文风）。 */
export function resolveBranchSheetTrim(settings) {
  const raw = str(settings?.branch_sheet_trim);
  return BRANCH_SHEET_TRIMS.includes(raw) ? raw : 'default';
}

/** 按档位挑出给走向 Agent 的段。`default` 与旧实现（只滤 codexBrief）逐字节等价。 */
export function selectBranchSections(sections, trim = 'default') {
  const keep = trim === 'core_only' ? BRANCH_CORE_KEYS : null;
  return (sections || []).filter((s) => (keep ? keep.has(s.key) : s.key !== 'codexBrief'));
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
  // 预算从 narrator 绑定模型的窗口推导：窗口 − 生成预留 = 提示词硬上限，
  // 各层按职责比例分（见 context-plan.js）。会话可以请求更小的上限，但不能超过窗口。
  // 没有任何一层再被写死成常量——换模型即换预算，不需要改 .env。
  const plan = currentPlan({ session });
  const budget = plan.layers;
  const hardMax = plan.hardMax;
  const softMax = plan.softMax;
  // 超硬上限策略：fail（默认，拒绝本轮并报错）| truncate（旧行为，调试/应急）。
  const hardCapMode = config.context.overHardCap === 'truncate' ? 'truncate' : 'fail';
  // 封场尾巴拍数：0 关；缺省 2（见 config.context.recentOverlapTurns）。
  const overlapTurns = Math.max(0, Number(config.context.recentOverlapTurns) || 0);
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
  // 工艺层：会话 settings > 世界卡卡级默认（`card.craft`）> 程序默认。
  // 卡的 style_guide 永远压过预设文风。它只影响「怎么写」，不参与「世界里有什么」。
  // 注意只允许**推进尺度**按拍覆盖（它只进尾注，不影响 system）；
  // preset/dialogue 会改 system 文本，必须整会话恒定，
  // 否则 system 逐字节冻结的缓存前缀就断了。
  const craft = resolveCraft(session?.settings || {}, {}, templateCard.craft);

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
    person: [...new Set([...(linkedPlayer.person || []), ...(linkedRecent.person || [])])],
    fact: [...new Set([...(linkedPlayer.fact || []), ...(linkedRecent.fact || [])])],
  };

  /* ---- 在场卡司 ---- */
  const present0 = pickPresent(card, { ledger, linked: linkedPlayer });

  /* ---- 渲染前体检：能确定性修的矛盾就地修（死亡角色不应仍在场） ---- */
  // 玩家角色要单独告诉 lintState：主角不会「因为离场而不在场」（D14）。
  const lint = lintState({
    ledger, present: present0, assertions: [], scenes: [], turnNo: Number(turnNo) || 0,
    playerName: str(card.player?.name), playerId: str(card.player?.canon_character),
  });
  const present = lint.present;

  /* ---- 已故 / 离场：解释「名单里为什么少了一个人」 ---- */
  // 来源只认 world_state 的 life_state（史官结构化写入），不认自由文本关键词；
  // 存活分支用有效投影值，取最近被标记的 ≤3 人，交给场记单渲染成一行。
  const lifeMarked = new Map();
  for (const d of deltas) {
    if (d.path !== 'life_state' || d.op !== 'set') continue;
    const key = `${d.entity_id}::${d.entity_kind}`;
    const at = Number(d.valid_from) || 0;
    if (!lifeMarked.has(key) || lifeMarked.get(key) <= at) lifeMarked.set(key, at);
  }
  const absentees = (card.entities || [])
    .filter((e) => e.type === 'person' && (e.life_state === 'dead' || e.life_state === 'gone'))
    .filter((e) => lifeMarked.has(`${e.id}::person`) || lifeMarked.has(`${e.name}::person`))
    .sort((a, b) => (lifeMarked.get(`${b.id}::person`) || lifeMarked.get(`${b.name}::person`) || 0)
      - (lifeMarked.get(`${a.id}::person`) || lifeMarked.get(`${a.name}::person`) || 0))
    .slice(0, 3)
    .map((e) => ({ name: e.name, state: e.life_state, note: str(e.status) }));

  /* ---- 设定集（事实实体） ---- */
  const pinnedIds = (card.entities || [])
    .filter((e) => e.type !== 'person' && e.pinned)
    .map((e) => e.id);
  const { t0: codexT0, t1: codexT1, themeTags } = pickCodex(card, {
    ledger, linked, present, pinnedIds, graph, playerLinked: linkedPlayer,
  });

  /* ---- 关系 / 线索 / 已成立的事实 ---- */
  // 关系的 SQL 窗口：不再用 60 当「渲染上限」（那是历史误读，`LIMIT 60` 只是加载量）。
  // 真实容量由预算推导（下面 RELATION_SHARE），窗口必须比它大，否则「预算涨了条数不涨」。
  // 一条关系约 34.5 tok，22506 的 15% 也只装得下 ~97 条，200 足够覆盖任何窗口。
  const RELATION_WINDOW = 200;
  // SQL 只做粗筛（库里可能上千行），渲染条数在下面按预算推导。
  const relations = getRelations(sessionId, { branchId, limit: RELATION_WINDOW });
  const threads = getThreads(sessionId, { branchId, limit: 40 });
  // 场次边界：既用于「最近一次封场之后」的流言窗口，也用于下面的场次索引与原文窗口。
  // 只取「本轮之前」已经封场的场次；当前这一场还在写，不能进索引。
  const allScenes = getScenes(sessionId, { branchId, limit: 4000 });
  const closedScenes = (Number.isInteger(turnNo) && turnNo > 0)
    ? allScenes.filter((s) => s.turn_to < turnNo)
    : allScenes;
  const lastClosedTo = closedScenes.length
    ? Number(closedScenes[closedScenes.length - 1].turn_to) || 0
    : 0;

  /* ---- 世界呼吸：把「幕外流言」送进场记单 ---- */
  // 世界呼吸在切场时推演「这段时间世界上发生了什么」；设计意图一直是让这些事件
  // 作为压力与流言进入下一场的场记单。这里只取最近一次封场及之后、rumor/public
  // 且仍 open 的事件：hidden 永不外泄；每轮最多 2 条、按人去过重，渲染进既有
  // 「压力」段（不新增段/层，也不动 system 缓存前缀）。
  //
  // 取数必须按 kind 过滤：`patches` 里各种 kind 的产出速率差两个数量级（史官每拍都会
  // 写 `skipped_targets` 这类逐拍流水），混在一起的 24 条窗口会被高频类挤满（长跑实测
  // 该窗口 17/24 不是流言），流言只剩最旧的一小撮，于是同一件旧事被反复渲染。
  // 过滤放在 SQL 里，窗口才真的属于流言。
  const rumors = [];
  {
    const seen = new Set();
    for (const p of listPatches(sessionId, { branchId, status: 'open', kind: 'offstage_event', limit: 24 })) {
      const pl = p.payload || {};
      if (pl.visibility !== 'rumor' && pl.visibility !== 'public') continue;
      if ((Number(p.turn_no) || 0) < lastClosedTo) continue;
      const who = str(pl.who);
      const what = str(pl.what);
      if (!who || !what || seen.has(who)) continue;
      seen.add(who);
      rumors.push({ who, what, visibility: pl.visibility });
      if (rumors.length >= 2) break;
    }
  }
  const presentKeys = new Set(present.flatMap((c) => [c.id, c.name]));
  // SQL 层窗口：300 条断言。**这是硬截断**——被挡在外面的行根本进不了进程，
  // 所以下面还要单独统计「库里共有多少」，否则「断言长到看不见」在报告里永远显示为健康。
  const ASSERTION_WINDOW = 300;
  const allFacts = getAssertions(sessionId, { branchId, atTurn: Number.isInteger(turnNo) ? turnNo : 0, limit: ASSERTION_WINDOW })
    .filter((a) => a.visibility !== 'secret' || presentKeys.has(a.subject));
  // 多值事实的条数由**预算**推导，不是写死的魔数（D9-A1）。
  // 旧实现的写法是双闸：这里写死 `manyLimit: 10`，渲染端再 `.slice(0, 24)` 兜一刀。
  // 50 轮实测：t31 就顶到 24 条、t42 起每拍都在切，可见率从 t1 的 100% 掉到 t51 的 12.5%
  // （27/216）；而一条事实只花 12.4 tok，24 条仅占场景层配额的 1.3%——预算根本没用上。
  // 同一份预算里辞书是「按每条成本估算条数」（见下面的 codexSlots），事实没有道理写死。
  // FACT_SHARE 同时承担推导与硬顶：事实段最多吃掉场记单配额的 25%，
  // 剩余空间才轮到关系/知识/辞书/回声（顺序在 scene-sheet 的 order 里）。
  const FACT_TOKEN_COST = 12.4;
  const FACT_SHARE = 0.25;
  const manyLimit = Math.max(10, Math.floor((budget.scene * FACT_SHARE) / FACT_TOKEN_COST));
  // 关系条数同理（D17）：一条关系约 34.5 tok（实测 31.3 字符 × 1.1 + 缩进）。
  // 旧实现写死 `.slice(0, 8)`：51 拍里只有 11/42 条过场关系露过面，8 个槽位被同几条
  // 强关系锁死，而关系段只占场景层配额的 1.6%。与 D9 的 `slice(0, 24)` 同构。
  // RELATION_SHARE 同时承担推导与硬顶：关系段最多吃掉场记单配额的 15%。
  const RELATION_TOKEN_COST = 34.5;
  const RELATION_SHARE = 0.15;
  const relationLimit = Math.max(8, Math.floor((budget.scene * RELATION_SHARE) / RELATION_TOKEN_COST));
  // 单值谓词全渲染（有界），多值谓词按相关性选（条数由预算推导）。
  const factSel = selectFacts(allFacts, {
    presentKeys,
    placeId: ledger?.place_id || null,
    threadTitles: threads.filter((t) => t.status === 'open').map((t) => t.title),
    manyLimit,
  });
  const facts = [...factSel.single, ...factSel.many];
  // 知识边界按线索组织（谁能在这一拍说出什么），而不是泛泛词表。
  const knowledgeMatrix = renderKnowledgeMatrix(present);
  // 成长曲线的「预兆」：只取已解锁且在场者，最多 2 条，进既有「压力」段。
  // 这样不需要新增注入通道——它就是压力的一种。
  const presentNames = new Set(present.flatMap((c) => [c.id, c.name]));
  const omens = renderOmens(fateState.unlocked, presentNames, 2);

  /* ---- 原声：按角色给在场者卡锚定声线（D18 后不再另生成「回声」段） ---- */
  const voiceMap = getVoiceMap(sessionId, { branchId, perWho: 3 });
  // 传 {text, turn_no} 而不是纯文本：renderCastLine 要渲染「第N轮」出处，
  // 这是回声段删掉后模型唯一能判断「这句话是什么时候说的」的地方。
  const voices = {};
  for (const [who, lines] of Object.entries(voiceMap)) {
    voices[who] = lines.map((v) => ({ text: v.text, turn_no: v.turn_no }));
  }

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
    relationLimit,
    threads,
    codex: selectedCodex,
    codexBrief: selectedBrief,
    voices,
    facts,
    knowledgeMatrix,
    omens,
    rumors,
    worldRuntime: card.runtime || {},
    // 主角运行态从 system 搬到场记单：信息不丢，但 system 得以逐字节冻结。
    playerNow: {
      condition: card.player?.condition, mood: card.player?.mood,
      location: card.player?.location, goal: card.player?.goal,
      status: card.player?.status, situation: card.player?.situation,
      // 银钱是唯一的数值路径（state-paths.js NUMBER_PATH_SET），每拍必须可见：
      // 否则模型只能靠「拥有」断言各自记一个余额，6 次面额拆解 6 次算不平。
      money: card.player?.money,
    },
    directive: directive || str(session.settings?.scene_directive),
    absentees,
    capTokens: sceneCap,
  });
  // 候选 ≠ 实际渲染：场记单预算不足时，codex/facts 可能整段被丢。
  const codexRendered = sheet.meta?.codex_rendered ?? selectedCodex.length;
  const codexBriefRendered = sheet.meta?.codex_brief_rendered ?? 0;
  // 事实按预算推导后条数是变量，必须读渲染端实际留下了几条（缺省退回候选数）。
  const factsRendered = sheet.meta?.facts_rendered ?? facts.length;
  // 关系同理（D17）：条数由预算推导，渲染端还可能按整条退让后再少几条。
  const relationsRendered = sheet.meta?.relations_rendered ?? relationLimit;

  /* ---- 系统层（稳定前缀，只读 canon） ---- */
  // 关键：传的是**模板快照** templateCard，不是投影后的 card。
  // system 一旦读运行态，前缀每轮都失效（实测 1000 轮里 system 变 251 次）。
  // 前史块（timeline canon=past）也来自模板快照：它是「开局之前已经成立」的
  // canon，不是本局演出结果。future/branch 永不渲染（红线 3）。
  // 前史块（canon=past）与索引共享 system 预算，给它 system 配额的 10%（下限 240）：
  // 前史是「开局之前已成立」的 canon，条数由作者写，不该被 240 这个旧常量截断。
  const pastCap = Math.max(240, Math.round(budget.system * 0.10));
  const timelinePast = renderTimelinePast(templateCard, pastCap);
  const systemLayer = buildSystemLayer(session, world, {
    card: templateCard,
    indexCap: budget.system,
    graph: buildWorldGraph(templateCard),
    pastText: timelinePast.text,
    craft,
  });
  const systemMsg = { role: 'system', content: systemLayer.text };

  /* ---- 场次索引（长程记忆的载体，只追加） ---- */
  // 场次边界已在上面算好（closedScenes）：索引只追加老场次行，末尾随封场增长。
  const sceneIndex = renderSceneIndex(closedScenes, budget.archive);
  const archiveMsg = sceneIndex.text ? { role: 'user', content: sceneIndex.text } : null;

  /* ---- 逐字原文窗口 ---- */
  // 窗口 = **当前场次起点到本轮之前**的全部回合：不按「最后 N 轮」取，也不做字符串裁剪。
  // 旧实现用「摘要边界 + 1」做起点；摘要被移除后，边界改由场次决定：
  // 场次记录已经覆盖的回合不再逐字出现（它们在场次索引里），当前场次逐字保留。
  // 这条不变量比旧版更强：不会出现「摘要覆盖了但场次没记」的空洞。
  const sceneCoveredTo = closedScenes.length ? closedScenes[closedScenes.length - 1].turn_to : 0;
  // 封场尾巴：再往回带 RECENT_OVERLAP_TURNS 个**回合**（回合 = player + narrator 两条行，
  // 共用同一个 turn_no）。刚切场时场次索引只剩一行摘要式记录，上一拍的逐字特征
  // （用词、句长、引号风格）全丢：长跑实测引号风格 13 次切换里 9 次发生在窗口为空时。
  // 必须按 turn_no 减、不能按「最后 N 条消息」减——减 2 条消息只拿到 1 player + 1 narrator，
  // 那只有 1 个回合。规则本体在 overlapWindowFrom()，与 recallVisibleFrom() 共读一份。
  const overlapFrom = overlapWindowFrom(sceneCoveredTo, turnNo, overlapTurns);
  const rawRows = getTurnsForBranch(sessionId, branchId, forkTurn, {
    from: overlapFrom,
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
    // 有几句回合被逐字带进原文窗口的同时也已归档在场次索引里（D1 封场尾巴）。
    // 不是错误：这是「切场后仍看得见上一拍原话」的成本，记账让报告能看见。
    overlap_turns: recentTurnNos.filter((n) => n <= sceneCoveredTo).length,
    overlap_limit: overlapTurns,
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
  const currentMsg = buildCurrent(playerText, images, branchChoice, extra, buildTail(card, { directive: directiveText, isOpening, craft }));

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
        + `请先封场（减少当前场原文）、换更大上下文的模型，或调低 SCENE_MAX_TOKENS。`,
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

  // 走向版场记单：按会话档位裁段，再原样重拼（D26）。
  // 同一份 `sheet.sections` 做 filter，不重新渲染——重渲染连字数取舍都会变。
  const branchTrim = resolveBranchSheetTrim(session.settings);
  const branchSections = selectBranchSections(sheet.sections, branchTrim);
  const branchSheetText = sheet.text ? composeSheetText(sheet.head, branchSections) : '';

  return {
    messages,
    budget: breakdown,
    // 本轮投影后的世界：下游 Agent（史官/世界呼吸/走向）用它，而不是模板。
    card,
    // 本轮工艺配置：走向 Agent 与正文必须同尺度（见 craft.js）。
    craft,
    state: ledger,
    ledger,
    anchor: anchor ? { id: anchor.id, label: anchor.label } : null,
    recentTurns: recentRows,
    // 给走向 Agent 的场记单：与送模那份逐字节相同，但按档位裁掉「走向用不上的段」（D26）。
    // 走向只需要在场者/私心/关系/线索/压力；「附近设定」是给正文展开细节用的，
    // 实测每拍 1595 tok（branch user 的 18%），从不影响走向标题与描述。
    // 为什么在这里算而不是在 branch.js 里重新渲染：重渲染会连字数取舍都变，
    // 必须保证「除被删的那段外逐字节相同」，否则 A/B 对比不成立。
    branchSheet: branchSheetText,
    meta: {
      present: present.map((c) => ({ id: c.id, name: c.name, role: c.role })),
      mentioned: linked,
      theme_tags: themeTags,
      codex: selectedCodex.slice(0, Math.min(codexRendered, 8))
        .map((c) => ({ id: c.entry.id, name: c.entry.name, why: c.why })),
      codex_total: (card.entities || []).filter((e) => e.type !== 'person').length,
      codex_candidates: codexT0.length,
      codex_rendered: codexRendered,
      codex_dropped: Math.max(0, codexT0.length - codexRendered),
      codex_brief_candidates: codexT1.length,
      codex_brief_rendered: codexBriefRendered,
      graph: {
        entities: graph.entities.size,
        edges: graph.edges.length,
      },
      timeline_past: (card.timeline || []).filter((t) => t.canon === 'past').length,
      timeline_future_held: (card.timeline || []).filter((t) => t.canon === 'future').length,
      // 前史块落位：只进 system 世界索引（与世界索引共享 system 预算），
      // 是 canon=past 的唯一入口；future/branch 不在这里计数（它们不进提示词）。
      system_blocks: {
        timeline_past: { ...timelinePast.meta, cap: pastCap },
        // 世界索引的覆盖率：卡越大，被截断的实体越多。只进 meta，不进提示词。
        index: systemLayer.meta.index_coverage,
        // 工艺块落位：落进 system，被 system 预算约束，按 floor→time→style→dialogue 整条丢。
        craft: systemLayer.meta.craft,
      },
      world_state_changes: deltas.length,
      facts: factsRendered,
      facts_candidates: facts.length,
      facts_single: factSel.meta.single,
      facts_many_rendered: factSel.meta.many_rendered,
      facts_many_dropped: factSel.meta.many_dropped,
      // 条数是**推导值**（见装配处的 FACT_SHARE），写进 meta 才能核对「预算涨了它有没有跟着涨」。
      facts_many_limit: manyLimit,
      // 关系条数同理（D17）：推导值 + 实际渲染数，两个都要能核对。
      relations_limit: relationLimit,
      relations_rendered: relationsRendered,
      // 截断可见化（D3）：上面这些计数全部发生在**已经取回**的行里。SQL 层 `LIMIT 300`
      // 挡掉的那部分永远不会出现在 `facts_many_dropped` 里——于是「断言长到看不见」
      // 这件事在报告里显示为健康。这里给出窗口外的真实行数。
      // `sql_window_full` 为真 = 这一层已经顶到 SQL LIMIT，再长就静默不渲染了。
      layers_truncated: {
        assertions: {
          rendered: factsRendered,
          loaded: allFacts.length,
          window: ASSERTION_WINDOW,
          total: countAssertions(sessionId, { branchId, atTurn: Number.isInteger(turnNo) ? turnNo : 0 }),
          sql_window_full: allFacts.length >= ASSERTION_WINDOW,
        },
        relations: {
          rendered: relationsRendered,
          loaded: relations.length,
          window: RELATION_WINDOW,
          // 真正决定模型看见什么的是渲染上限（由预算推导，D17）。
          // 只报 loaded/window=60 会让「8 条已经填满」显示成「8/60 还很空」——D3 要消灭的假健康。
          render_limit: relationLimit,
          total: countRelations(sessionId, { branchId }),
          sql_window_full: relations.length >= RELATION_WINDOW,
        },
        threads: {
          loaded: threads.length,
          window: 40,
          open_total: countThreads(sessionId, { branchId, status: 'open' }),
          // 线索有两道限额且**都不是 40**：SQL 读 40 条（open 永远远小于它，因为 D5 的
          // WIP 上限 8 在写入端就拦住了），真正会「看不到」的是场记单只渲染
          // open 的前 THREAD_RENDER_MAX 条。只报 loaded/window=40 会让「8 条已经填满」
          // 显示成「8/40 还很空」——正是 D3 要消灭的那种假健康。
          render_max: THREAD_RENDER_MAX,
          open_over_capacity: Math.max(0, countThreads(sessionId, { branchId, status: 'open' }) - THREAD_RENDER_MAX),
        },
      },
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
      // 场记单自身的降级档位：在场段可能被压到紧凑/只留名字，而不是整段丢。
      scene_sheet: {
        cast_mode: sheet.meta?.cast_mode || null,
        absentees: absentees.map((a) => ({ name: a.name, state: a.state })),
        // 世界呼吸的幕外流言：进 pressure 段的条数（hidden 不计）。
        rumors: rumors.length,
        // 回声段已删除（D18）：它原本就是「原声：」的逐字复制品（76 拍 278/278 条
        // 100% 重复），轮次信息已并入「原声：第N轮…」。旧会话的
        // scene_sheet.echoes / echoes_rendered 字段保留读取（报告按 null 处理存量）。
        // 原声可见性（D23）：`voices` 每人取 perWho 条、渲染端再 slice(0,2)，
        // 两道都是按人分区的（不是全局窗口），所以这里只报人数与可用行数，
        // 用来回答「在场的人里，有几个根本没有声线锚点」。
        voice_speakers: Object.keys(voices).length,
        voice_lines: Object.values(voices).reduce((n, a) => n + a.length, 0),
        voice_present_covered: present.filter((c) => (voices[c.name] || voices[c.id] || []).length > 0).length,
        // 走向 Agent 拿到的场记单比送模那份少了哪几段、省了多少 token（D26）。
        // 只在装配出口存在、不落库的话，A/B 对比时无法回答「走向到底少看了什么」。
        // `dropped_sections` 由实际留下的段反推，所以换档位时不用再手写一份名单。
        branch_sheet: sheet.text
          ? {
            trim: branchTrim,
            dropped_sections: (sheet.sections || [])
              .filter((s) => !branchSections.some((k) => k.key === s.key))
              .map((s) => s.key),
            tokens: estimateTokens(branchSheetText),
            full_tokens: estimateTokens(sheet.text),
          }
          : null,
      },
      branch: branchId,
      // 覆盖清单：场次索引边界 + 原文窗口。
      // 原不变量是 recent_from === scene_to + 1（场次无缝、无洞）。D1 之后允许
      // 有意的**重叠**：recent_from 可以比 scene_to + 1 小最多 `overlap_limit` 拍——
      // 刚封场时上一两拍的逐字原文仍留在窗口里，让「一来一回」的对话节奏可续。
      // 不会出现**洞**：窗口起点仍由 scene_to 兜底，只是往前多看几拍。
      coverage,
      // 摘要层已移除，保留这个字段为 null 以保持下游读取形状稳定。
      summary: null,
      // 资料员预检（D4）：**跑过就记**，不只在出文本时记。
      // 历史回查的价值要看「模型判断该查时查到了没有」，所以必须区分三种状态：
      // 没触发（null）、触发了但没查（rendered=false, queries 为空）、
      // 查了但没命中（history_queries 非空、history_hits 为空）。
      // 旧写法 `retrieval?.text ? {...} : null` 把后两种都抹成 null，报告里分不出来。
      retrieval: retrieval
        ? {
          rendered: !!retrieval.text,
          queries: retrieval.queries || [],
          entries: retrieval.entries || [],
          tokens: breakdown.retrieval,
          // 两条通道的分账：查「设定」和查「历史」是两种取证，成本要能分开看。
          // codex_tokens + history_tokens 可能略大于 tokens（各自 truncate 后整体又压了一次）。
          codex_queries: retrieval.codex_queries || [],
          history_queries: retrieval.history_queries || [],
          codex_tokens: retrieval.tokens?.codex || 0,
          history_tokens: retrieval.tokens?.history || 0,
          history_hits: retrieval.history_hits || [],
          // D4 后验：查询词本身是玩家这一拍写的字 = 「自问自答」，检索回来的必然已经看得见。
          // 有了 exclude_from 下界之后这个数应该趋近 0；它没降下去就说明下界没接上。
          history_self_echo: retrieval.history_self_echo || [],
          exclude_from: retrieval.exclude_from ?? null,
        }
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
      // 预算规划：从模型窗口推导的硬上限 / 软目标 / 各层配额（只进 meta，不进提示词）。
      // 换模型即换预算；UI 与排查都以这里为准，不再有独立的 BUDGET_* 常量。
      plan: {
        window: plan.window,
        output_reserve: plan.outputReserve,
        safety: plan.safety,
        hard_max: plan.hardMax,
        soft_max: plan.softMax,
        auto_soft: plan.autoSoft,
        layers: { ...plan.layers },
        shares: { ...plan.shares },
      },
      // 实体召回率：整轮上下文里能看见多少卡内实体（近似子串统计，只进 meta）。
      recall: measureEntityRecall(templateCard, messages),
      // 硬上限策略与「整层收窄」记录：fail 模式下本字段只出现在错误 meta 里。
      hard_cap: { mode: hardCapMode, narrowed },
    },
  };
}
