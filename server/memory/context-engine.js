/**
 * server/memory/context-engine.js — 世界卡上下文引擎（v3 的核心）
 *
 * 设计目标：让「世界卡的设定」在上下文里真正被演绎出来，同时**体积不随剧情增长**。
 *
 * 九个层，每层独立 token 配额（见 config.context.layerBudget）：
 *   1. contract   演绎契约   —— 固定文本：视角/文风/篇幅/禁令。永不增长。
 *   2. charter    世界宪章   —— 世界的物理与制度底座（从世界卡生成，压缩后约 1.6K）。
 *   3. protagonist 主角速写  —— 玩家角色的处境、能力边界、内心声音。
 *   4. cast       在场卡司   —— 只放**本轮在场**的角色卡（含未说破的隐秘动机）。
 *   5. lore       触发词条   —— 关键词命中才注入的世界细节。这是「设定不膨胀」的关键。
 *   6. scene      场景账本   —— 时间/地点/在场/手持/张力。
 *   7. director   导演卡     —— 当前幕的意图、必达节拍、需要回避的坑。
 *   8. memory     分层记忆   —— 摘要/关系/线索/实体/反思/笔记（各自配额）。
 *   9. recent     最近原文   —— 逐字保留，保证语感与连贯。
 *  10. current    本轮输入
 *
 * 与 v2 的关键差异：
 *   - 世界观不再整段塞进 system。system 只留「怎么演」，设定走 charter + lore。
 *   - 角色卡按「本轮是否在场」投放，而不是全部平铺。12 个角色 → 通常 2-4 个。
 *   - 触发词条让「司楼」「玉佩」「长柳点云图」这类细节按需进入上下文，
 *     既有细节密度，又不占常驻预算。
 *   - 记忆层内部再分配配额，任何一层爆掉都不会挤掉设定。
 */
import { config } from '../config.js';
import { estimateMessageTokens, estimateTokens, truncateToTokens } from '../tokens.js';
import {
  getEntities, getFacts, getLatestSummaries, getNotes, getRecentText, getRecentTurns,
  getReflections, getRelations, getState, getSummaries, getThreads, getLore,
} from './store.js';
import { MemoryRetriever } from './retriever.js';

/* ══════════════════════════════════════════════════════════════════════ */
/* 常量与标签                                                             */
/* ══════════════════════════════════════════════════════════════════════ */

const ENTITY_TYPE_LABELS = {
  character: '角色', item: '物品', location: '地点',
  faction: '势力', event: '事件', concept: '概念',
};

const NOTE_KIND_LABEL = {
  note: '补充设定',
  rule: '硬性规则',
  foreshadow: '待回收伏笔',
  retcon: '覆盖记忆',
};

const REFLECTION_KIND_LABEL = {
  insight: '剧情洞察',
  relationship: '关系洞察',
  theme: '主题基调',
  rule: '演绎约束',
};

/** 用于「在场判定」的常见场所词（出现在玩家输入里 → 该角色可能在场） */
const PRESENCE_HINTS = [
  '屋', '院', '厅', '房', '街', '巷', '楼', '店', '铺', '堂', '馆', '城',
  '门口', '车里', '车上', '桌', '床', '山坡', '江', '码头', '训练场', '府',
];

/* ══════════════════════════════════════════════════════════════════════ */
/* 通用工具                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

/** 取数组前若干项，用中文顿号连接 */
function joinList(arr, sep = '、') {
  return (Array.isArray(arr) ? arr : []).filter(Boolean).join(sep);
}

/**
 * 按配额贪心装入若干文本行。
 * 固定项（pinned）即使超配额也保留，但单独有硬上限防止失控。
 */
function packLines(lines, capTokens, { header = '', pinnedMax = Infinity } = {}) {
  const out = [];
  let used = header ? estimateTokens(header) + 1 : 0;
  let pinnedUsed = 0;
  for (const line of lines) {
    if (!line?.text) continue;
    const cost = estimateTokens(line.text) + 1;
    if (line.pinned) {
      if (pinnedUsed + cost > pinnedMax) continue;
      pinnedUsed += cost;
    } else if (used + cost > capTokens) {
      continue;      // 不 break：后面的短行可能还装得下
    }
    used += cost;
    out.push(line);
  }
  if (!out.length) return '';
  return header ? `${header}\n${out.map((l) => l.text).join('\n')}` : out.map((l) => l.text).join('\n');
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 1. 演绎契约（固定 system 文本，不含任何世界观细节）                      */
/* ══════════════════════════════════════════════════════════════════════ */

export function buildContract(session, world) {
  const card = world?.card || {};
  const style = card.style || {};
  const title = card.title || session?.title || '未命名剧情';
  const pov = style.pov || '第三人称限知，镜头贴在主角身上';
  const voice = style.voice || '短句为主，一段不超过三行；对白与动作交错，少用形容词堆砌';
  const length = style.length || '1600-2600 字';
  const tense = style.tense || '过去时叙述';

  const lines = [
    '你是一台剧情演绎引擎。你不是助手，不是评论员，不是写作教练——你就是这部作品的世界本身。',
    '',
    `# 作品`,
    `《${title}》${card.subtitle ? ` · ${card.subtitle}` : ''}`,
    '',
    '# 演出范式（硬性）',
    `1. 视角：${pov}。主角不在场的信息只能通过痕迹、传闻、他人转述呈现，不得直接叙述。`,
    `2. 文风：${voice}`,
    `3. 篇幅：本轮 ${length}。`,
    `4. 时态与密度：${tense}；每一段都必须推动情势或揭示人物，不写纯装饰性描写。`,
    '5. 结尾必须留钩子：停在悬念、危机、或一个必须立刻做出的选择前夜。禁止平稳收尾，禁止「——待续——」。',
    '6. 不得出现元叙述：不写「作为 AI」「本章」「综上所述」「作者」，不解释、不总结、不预告。',
    '7. 不得替主角做决定、不代写主角的台词与内心。主角的行动由玩家给出。',
    '8. 不得让任何角色说出他不可能知道的信息；不得为了推进剧情让角色降智。',
    '9. 专有名词一次定义、终身一致：人名、地名、称谓、器物名不得漂移或改写。',
    '10. 只输出剧情正文。不要标题、不要章节号、不要 Markdown 标记、不要任何前后缀说明。',
  ];

  const bans = Array.isArray(card.bans) ? card.bans.filter(Boolean) : [];
  if (bans.length) {
    lines.push('', '# 绝对禁止（作者钦定）');
    bans.forEach((b, i) => lines.push(`${i + 1}. ${b}`));
  }

  return lines.join('\n');
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 2. 世界宪章（从世界卡 + 词条提取骨架）                                   */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 世界宪章 = 这个世界的「物理与制度底座」。
 * 它必须是**任何场景下都成立**的硬设定，不含具体事件。
 * 由世界卡 card.charter 提供（结构化的几条），或回退到 worldview 的摘要。
 */
export function buildCharter(world, capTokens) {
  const card = world?.card || {};
  const charter = card.charter;

  let text = '';
  if (Array.isArray(charter) && charter.length) {
    text = charter
      .filter((c) => c && (c.rule || c.text))
      .map((c, i) => `${i + 1}. ${c.rule || c.text}`)
      .join('\n');
  } else if (typeof charter === 'string' && charter.trim()) {
    text = charter.trim();
  } else {
    text = str(card.worldview).trim();
  }

  if (!text) return '';
  const header = '【世界宪章】这个世界的硬设定，任何场景下都成立，不得违背。';
  const body = truncateToTokens(text, Math.max(200, capTokens - estimateTokens(header)));
  return `${header}\n${body}`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 3. 主角速写                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

export function buildProtagonist(world, session, capTokens) {
  const card = world?.card || {};
  const p = card.player;
  if (!p) return '';

  const lines = [];
  const name = p.name || '主角';
  lines.push(`【主角】${name}${p.age ? `，${p.age}` : ''}${p.identity ? `｜${p.identity}` : ''}`);
  if (p.situation) lines.push(`处境：${p.situation}`);
  if (p.capability) lines.push(`能力边界：${p.capability}`);
  if (p.inner_voice) lines.push(`内心声音：${p.inner_voice}`);
  if (p.wants) lines.push(`想要的：${p.wants}`);
  if (p.afraid) lines.push(`害怕的：${p.afraid}`);

  const text = lines.join('\n');
  return truncateToTokens(text, Math.max(150, capTokens));
}

/** 首轮开场：把开场种子包成一句强指令（不塞进常驻 system）。 */
export function buildOpeningSeed(world) {
  const card = world?.card || {};
  const seed = str(card.opening_seed).trim();
  if (!seed) return '';
  return seed;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 4. 在场卡司                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

/** 角色卡字段中文标签 */
const CHAR_FIELD_LABELS = {
  role: '定位', personality: '性格', voice: '口吻', secret: '隐秘动机',
  background: '背景', goal: '目标', relation: '与主角', appearance: '外貌',
  manner: '习惯动作', tell: '破绽/口头禅',
};
const CHAR_FIELD_SKIP = new Set(['name', 'avatar_hue', 'avatar', 'id', 'color', 'tags', 'always']);

/**
 * 判定本轮在场角色。
 *
 * 规则（按优先级）：
 *   1. always:true 的角色（主角的固定关系人，如全程跟随的亲人）常驻
 *   2. 名字或别名出现在「本轮玩家输入 + 最近原文 + 场景账本 characters」里
 *   3. 场景账本里 location 与当前 location 相同的角色
 *   4. 兜底：至少保留 1 个 strongest 角色，避免上下文里没有任何对话对象
 *
 * @returns {{present:Array, absent:Array}}
 */
export function pickCast(card, { playerText = '', recentText = '', state = null } = {}) {
  const cast = Array.isArray(card.cast) ? card.cast.filter((c) => c?.name) : [];
  if (!cast.length) return { present: [], absent: [] };

  const haystack = `${playerText}\n${recentText}`;
  const stateChars = state?.characters && typeof state.characters === 'object' ? state.characters : {};
  const stateNames = Object.keys(stateChars);
  const location = str(state?.location);

  const scored = cast.map((c) => {
    let score = 0;
    const aliases = [c.name, ...(Array.isArray(c.alias) ? c.alias : [])].filter(Boolean);
    for (const a of aliases) {
      if (!a) continue;
      if (playerText.includes(a)) score += 100;          // 玩家直接提到 → 必在场
      else if (haystack.includes(a)) score += 30;        // 最近文本提到
      if (stateNames.includes(a)) score += 60;           // 场景账本记录着状态
    }
    // 场景账本里的地点与当前地点一致
    const sc = stateChars[c.name];
    if (sc?.location && location && str(sc.location).includes(location.slice(0, 4))) score += 25;
    // 场景账本里有状态但没写地点 → 视为在场
    if (sc && !sc.location) score += 20;
    if (c.always) score += 80;
    score += (Number(c.weight) || 0.5) * 8;              // 重要度微调
    return { c, score };
  });

  const present = scored.filter((s) => s.score >= 20).sort((a, b) => b.score - a.score);
  const absent = scored.filter((s) => s.score < 20).sort((a, b) => b.score - a.score);

  return {
    present: present.map((s) => s.c),
    absent: absent.map((s) => s.c),
  };
}

/** 渲染一张角色卡（在场用详版，离场只留一句）。 */
function renderCharCard(c, { brief = false } = {}) {
  const head = `· ${c.name}${c.role ? `（${c.role}）` : ''}`;
  if (brief) {
    return `${head}${c.one_line ? `：${c.one_line}` : ''}`;
  }
  const lines = [head];
  for (const [k, label] of Object.entries(CHAR_FIELD_LABELS)) {
    const v = c[k];
    if (v == null || v === '') continue;
    if (CHAR_FIELD_SKIP.has(k)) continue;
    lines.push(`  ${label}：${Array.isArray(v) ? v.join('、') : str(v)}`);
  }
  if (c.secret) {
    lines.push('  （以上「隐秘动机」仅你可知：严禁在正文中点破或让角色主动说出，但其言行必须与它自洽，只让玩家看见蛛丝马迹。）');
  }
  return lines.join('\n');
}

/**
 * 组装在场卡司层。
 * @returns {{text:string, present:Array, absent:Array}}
 */
export function buildCast(card, { playerText, recentText, state, capTokens }) {
  const { present, absent } = pickCast(card, { playerText, recentText, state });
  if (!present.length && !absent.length) return { text: '', present: [], absent: [] };

  const header = '【在场人物】以下角色此刻在场或刚刚离场，言行必须与各自口吻、隐秘动机自洽。';
  const parts = [];
  let used = estimateTokens(header);

  for (const c of present) {
    const cardText = renderCharCard(c);
    const cost = estimateTokens(cardText) + 1;
    if (used + cost > capTokens && parts.length > 0) {
      // 装不下的在场角色 → 降级为一行速写
      const brief = renderCharCard(c, { brief: true });
      const bcost = estimateTokens(brief) + 1;
      if (used + bcost > capTokens) continue;
      parts.push(brief);
      used += bcost;
      continue;
    }
    parts.push(cardText);
    used += cost;
  }

  return {
    text: parts.length ? `${header}\n${parts.join('\n')}` : '',
    present,
    absent: absent.slice(0, 8),
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 5. 触发式世界词条（lorebook）                                           */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 扫描世界词条。
 *
 * 触发逻辑（借鉴 SillyTavern 的 World Info，但简化为两步）：
 *   1. 常驻词条（constant）无条件注入
 *   2. 其他词条：任一主键（keys）出现在「扫描文本」中即触发；
 *      若该词条有 secondary 键，则必须再命中至少一个 secondary 才触发（AND 逻辑）
 *   3. 可选一轮递归：已触发词条的内容再当扫描文本扫一遍（深度 1），
 *      让「凌府」触发后能带出「东街九十五号」词条
 *
 * 排序：priority 降序 → 同分按 sort 升序（作者手排的顺序）
 *
 * @returns {{entries:Array, matchedKeys:string[]}}
 */
export function scanLore(loreEntries, scanText, { recursion = 1 } = {}) {
  if (!Array.isArray(loreEntries) || !loreEntries.length) return { entries: [], matchedKeys: [] };

  const hits = new Map();      // id -> entry
  const matchedKeys = new Set();
  let haystack = str(scanText);

  for (let depth = 0; depth <= recursion; depth++) {
    let added = false;
    for (const e of loreEntries) {
      if (!e.enabled || e.constant) continue;
      if (hits.has(e.id)) continue;
      const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean) : [];
      if (!keys.length) continue;
      const hitKey = keys.find((k) => haystack.includes(k));
      if (!hitKey) continue;
      // secondary 键存在时要求二次命中（避免「女」这种泛词误触发）
      const secondary = Array.isArray(e.secondary) ? e.secondary.filter(Boolean) : [];
      if (secondary.length && !secondary.some((k) => haystack.includes(k))) continue;
      hits.set(e.id, e);
      matchedKeys.add(hitKey);
      added = true;
    }
    if (!added || depth === recursion) break;
    // 递归：把新触发的内容并入扫描文本，让词条之间可以互相带出
    const extra = [...hits.values()].map((e) => `${e.title}\n${e.content}`).join('\n');
    haystack = `${haystack}\n${extra}`;
  }

  const constants = loreEntries.filter((e) => e.enabled && e.constant);
  for (const c of constants) hits.set(c.id, c);

  const entries = [...hits.values()].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (a.sort || 0) - (b.sort || 0);
  });

  return { entries, matchedKeys: [...matchedKeys] };
}

/**
 * 组装词条层。超出配额时按 priority 降序保留。
 * @returns {{text:string, entries:Array, matchedKeys:string[]}}
 */
export function buildLore(loreEntries, scanText, capTokens, { recursion = 1 } = {}) {
  const { entries, matchedKeys } = scanLore(loreEntries, scanText, { recursion });
  if (!entries.length) return { text: '', entries: [], matchedKeys };

  const header = '【世界细节】以下是与当前场景相关的设定，需要时自然带出，不得改写。';
  const parts = [];
  let used = estimateTokens(header);

  for (const e of entries) {
    const body = e.title ? `· ${e.title}\n${e.content}` : `· ${e.content}`;
    const cost = estimateTokens(body) + 1;
    if (used + cost > capTokens) continue;
    parts.push(body);
    used += cost;
  }

  return {
    text: parts.length ? `${header}\n${parts.join('\n')}` : '',
    entries, matchedKeys,
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 6. 场景账本                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

export function buildScene(stateRec, capTokens) {
  if (!stateRec?.state) return '';
  const s = stateRec.state;
  const lines = [];

  const bits = [];
  if (s.time) bits.push(`时间 ${s.time}`);
  if (s.location) bits.push(`地点 ${s.location}`);
  if (s.weather) bits.push(`天气 ${s.weather}`);
  if (typeof s.tension === 'number') bits.push(`张力 ${s.tension.toFixed(2)}`);
  if (bits.length) lines.push(bits.join('｜'));

  if (s.characters && typeof s.characters === 'object') {
    const who = Object.entries(s.characters).map(([n, v]) => {
      const t = [v?.mood, v?.status].filter(Boolean).join('/');
      const loc = v?.location ? `@${v.location}` : '';
      return `${n}${t ? `（${t}）` : ''}${loc}`;
    });
    if (who.length) lines.push(`人物状态：${who.join('、')}`);
  }
  if (Array.isArray(s.inventory) && s.inventory.length) {
    lines.push(`随身：${joinList(s.inventory.slice(0, 14))}`);
  }
  if (Array.isArray(s.quests) && s.quests.length) {
    lines.push(`当前目标：${s.quests.filter((q) => q?.status === 'active').map((q) => q.goal || '').filter(Boolean).join('；')}`);
  }
  if (s.last_hook) lines.push(`上一幕留下的钩子：${s.last_hook}`);

  if (!lines.length) return '';
  const text = `【场景账本】（第 ${stateRec.turn_no} 轮快照，本轮必须从这里接续）\n${lines.join('\n')}`;
  return truncateToTokens(text, Math.max(200, capTokens));
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 7. 导演卡                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 导演卡 = 这一「幕」的意图。它解决「设定很丰富但剧情原地打转」的问题。
 *
 * 内容来自：
 *   - 世界卡的 arc 列表（作者设计的幕结构）
 *   - 当前推进到哪一幕（由 turn_no 与 arc.turns 估算）
 *   - 该幕的核心冲突 / 必达节拍 / 忌避事项
 *
 * @returns {{text:string, arc:object|null, arcIndex:number, progress:number}}
 */
export function buildDirector(world, turnNo, capTokens) {
  const card = world?.card || {};
  const arcs = Array.isArray(card.arcs) ? card.arcs.filter((a) => a?.title) : [];
  if (!arcs.length) return { text: '', arc: null, arcIndex: -1, progress: 0 };

  // 每幕默认 8 轮；作者可用 arc.turns 覆盖
  const DEFAULT_TURNS = Number(card.arc_turns) || 8;
  let cursor = 1;
  let arcIndex = 0;
  let arc = arcs[0];
  let progress = 0;
  for (let i = 0; i < arcs.length; i++) {
    const span = Number(arcs[i].turns) || DEFAULT_TURNS;
    if (turnNo < cursor + span) {
      arcIndex = i;
      arc = arcs[i];
      progress = Math.max(0, Math.min(1, (turnNo - cursor + 1) / span));
      break;
    }
    cursor += span;
    arcIndex = i;
    arc = arcs[i];
    progress = 1;
  }

  const lines = [`【本幕】第 ${arcIndex + 1}/${arcs.length} 幕 · ${arc.title}${progress > 0 && progress < 1 ? `（进度 ${Math.round(progress * 100)}%）` : ''}`];
  if (arc.goal) lines.push(`这一幕要达成：${arc.goal}`);
  if (Array.isArray(arc.beats) && arc.beats.length) {
    lines.push(`必达节拍（按序推进，不必一轮走完）：${arc.beats.join(' → ')}`);
  }
  if (Array.isArray(arc.avoid) && arc.avoid.length) {
    lines.push(`这一幕不要做：${arc.avoid.join('；')}`);
  }
  if (progress >= 1 && arcIndex < arcs.length - 1) {
    lines.push(`本幕已到尾声：请收束并自然过渡到下一幕「${arcs[arcIndex + 1].title}」。`);
  }

  const text = truncateToTokens(lines.join('\n'), Math.max(200, capTokens));
  return { text, arc, arcIndex, progress };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 8. 记忆层                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

/** 8.1 分层摘要：L4 → L3 → L2 最近 N → L1 最近 N（全部可裁剪，见下） */
function buildSummaries(sessionId, capTokens) {
  if (capTokens <= 0) return '';
  const l4 = getSummaries(sessionId, { level: 4, archived: 0 });
  const l3 = getSummaries(sessionId, { level: 3, archived: 0 });
  const l2 = getLatestSummaries(sessionId, 2, config.context.recentArcs);
  const l1 = getLatestSummaries(sessionId, 1, config.context.recentRounds);
  if (!l4.length && !l3.length && !l2.length && !l1.length) return '';

  const lineOf = (s) => `[第${s.turn_from}-${s.turn_to}轮] ${s.content}`;

  // L4 是「历史总纲」：只认最近 3 条，全部可裁剪。
  // 若把 L4 标为不可丢弃，它会随剧情线性增长（每 96 轮多一条），
  // 这正是「上下文无限膨胀」的经典来源。
  const l4Keep = l4.slice(-3);
  const l3Keep = l3.slice(-4);

  const items = [];
  const push = (s, tier, pinned) => items.push({ tier, pinned, from: s.turn_from, text: lineOf(s) });
  l4Keep.forEach((s) => push(s, 4, false));
  l3Keep.forEach((s) => push(s, 3, false));
  l2.forEach((s) => push(s, 2, false));
  l1.forEach((s) => push(s, 1, false));

  const header = '【剧情记忆】（由远及近，覆盖全部已发生的历史）';
  const body = packLines(
    items.map((it) => ({ text: it.text, pinned: false })),
    Math.max(0, capTokens - estimateTokens(header) - 1),
  );
  return body ? `${header}\n${body}` : '';
}

/** 8.2 关系账本 */
function buildRelations(sessionId, capTokens) {
  if (capTokens <= 0) return '';
  const rels = getRelations(sessionId, { limit: 40 });
  if (!rels.length) return '';
  const lines = rels.map((r) => {
    const senti = typeof r.sentiment === 'number'
      ? (r.sentiment > 0.3 ? '亲近' : r.sentiment < -0.3 ? '敌意' : '微妙')
      : '';
    const bits = [r.kind, senti].filter(Boolean).join('·');
    return `· ${r.from_name} → ${r.to_name}${bits ? `［${bits}］` : ''}${r.note ? `：${r.note}` : ''}`;
  });
  const header = '【关系账本】人物之间的态度与变化，新的一轮必须与它一致，除非剧情明确推动了变化。';
  const body = packLines(lines.map((t) => ({ text: t })), Math.max(0, capTokens - estimateTokens(header) - 1));
  return body ? `${header}\n${body}` : '';
}

/** 8.3 线索 / 伏笔账本 */
function buildThreads(sessionId, capTokens) {
  if (capTokens <= 0) return '';
  const threads = getThreads(sessionId, { limit: 30 });
  if (!threads.length) return '';
  const open = threads.filter((t) => t.status === 'open');
  const done = threads.filter((t) => t.status !== 'open').slice(0, 6);
  const lines = [];
  if (open.length) {
    lines.push('未回收：');
    for (const t of open) {
      lines.push(`· ${t.title}${t.note ? `（${t.note}）` : ''}`);
    }
  }
  if (done.length) {
    lines.push(`已回收：${done.map((t) => t.title).join('；')}`);
  }
  const header = '【线索账本】埋下的伏笔与未解之事。可以继续埋，但不要遗忘；已回收的不得再当悬念。';
  const body = packLines(lines.map((t) => ({ text: t })), Math.max(0, capTokens - estimateTokens(header) - 1));
  return body ? `${header}\n${body}` : '';
}

/** 8.4 实体档案 + 事实 */
function buildEntities(sessionId, capTokens) {
  if (capTokens <= 0) return '';
  const entities = getEntities(sessionId, { limit: 40 });
  const facts = getFacts(sessionId, { limit: 70 });
  if (!entities.length && !facts.length) return '';

  const header = '【已知档案】已经确立的人物/地点/物件，以及它们之间的关系。';
  const lines = [];
  for (const e of entities) {
    const label = ENTITY_TYPE_LABELS[e.type] || e.type || '实体';
    lines.push({ text: `· ［${label}］${e.name}：${e.summary || ''}`, pinned: !!e.pinned });
  }
  if (facts.length) {
    lines.push({ text: '· 事实关系：' });
    for (const f of facts) {
      lines.push({ text: `  ${f.subject} —${f.predicate}→ ${f.object}`, pinned: !!f.pinned });
    }
  }
  const body = packLines(lines, Math.max(0, capTokens - estimateTokens(header) - 1));
  return body ? `${header}\n${body}` : '';
}

/** 8.5 作者笔记（确定性记忆，优先级最高） */
function buildNotes(sessionId, capTokens) {
  if (capTokens <= 0) return '';
  const notes = getNotes(sessionId, { activeOnly: true });
  if (!notes.length) return '';
  const header = '【作者笔记】作者亲手写下的事实与规则，优先级高于一切自动记忆与即兴创作，必须严格遵守。';
  const lines = notes.map((n) => ({ text: `· ［${NOTE_KIND_LABEL[n.kind] || '笔记'}］${n.content}`, pinned: true }));
  const body = packLines(lines, Math.max(0, capTokens - estimateTokens(header) - 1), { pinnedMax: capTokens * 2 });
  return body ? `${header}\n${body}` : '';
}

/** 8.6 反思洞察 */
function buildReflections(sessionId, capTokens) {
  if (capTokens <= 0) return '';
  const refs = getReflections(sessionId, { limit: 8 });
  if (!refs.length) return '';
  const header = '【反思】从多轮剧情中沉淀下来的判断，比摘要更浓缩，用来保持长期一致性。';
  const lines = refs.map((r) => ({ text: `· ［${REFLECTION_KIND_LABEL[r.kind] || '洞察'}｜第${r.turn_from}-${r.turn_to}轮］${r.content}` }));
  const body = packLines(lines, Math.max(0, capTokens - estimateTokens(header) - 1));
  return body ? `${header}\n${body}` : '';
}

/**
 * 记忆层总装。内部按 memorySplit 分配配额，任何子层爆掉都不影响其它层。
 * @returns {{text:string, split:object}}
 */
export function buildMemory(sessionId, capTokens) {
  if (capTokens <= 0) return { text: '', split: {} };
  const split = { ...config.context.memorySplit };
  // 按比例缩放到实际可用配额
  const nominal = Object.values(split).reduce((a, b) => a + b, 0);
  const scale = nominal > 0 ? capTokens / nominal : 1;
  const q = (k) => Math.max(0, Math.floor(split[k] * scale));

  const blocks = [
    buildNotes(sessionId, q('notes')),
    buildReflections(sessionId, q('reflections')),
    buildSummaries(sessionId, q('summaries')),
    buildRelations(sessionId, q('relations')),
    buildThreads(sessionId, q('threads')),
    buildEntities(sessionId, q('entities')),
  ].filter(Boolean);

  return { text: blocks.join('\n\n'), split: { ...split, scale } };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 9. 检索层                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

function buildRetrieval(retriever, query, capTokens) {
  if (!query || capTokens <= 0) return { text: '', hits: [] };
  const hits = retriever.search(query, { topK: config.context.retrievalTopK });
  if (!hits.length) return { text: '', hits: [] };

  const header = '【旧事重提】与本轮行动直接相关的历史片段，可以自然带出，但不要整段复述。';
  const lines = [];
  let used = estimateTokens(header) + 1;
  for (const h of hits) {
    const label = h.kind === 'turn' ? `[第${h.turn_no}轮·原文]`
      : h.kind === 'summary' ? `[第${h.turn_from}-${h.turn_to}轮·摘要]`
        : h.kind === 'entity' ? `[档案·${h.name || ''}]`
          : '[历史]';
    const text = `${label} ${h.snippet}`;
    const cost = estimateTokens(text) + 1;
    if (used + cost > capTokens) break;
    lines.push(text);
    used += cost;
  }
  return { text: lines.length ? `${header}\n${lines.join('\n')}` : '', hits };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 10. 本轮输入                                                            */
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

function buildCurrent(playerText, images, branchChoice, extra) {
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
  return { role: 'user', content };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 最近原文                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

function toRecentMessages(rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind === 'player') out.push({ role: 'user', content: r.content });
    else if (r.kind === 'narrator') out.push({ role: 'assistant', content: r.content });
  }
  return out;
}

function fitRecent(msgs, capTokens, floor = 4) {
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
 * @returns {Promise<object>}
 */
export async function assembleContext({
  session, world, turnNo, playerText, images, branchChoice, isOpening = false,
}) {
  const budgetCfg = config.context.layerBudget;
  const hardMax = session?.settings?.context_max_tokens ?? config.context.maxTokens;
  const softMax = Math.min(config.context.softTokens, hardMax);
  const sessionId = session.id;
  const card = world?.card || {};
  const lore = world ? getLore(world.id) : [];

  /* ---- 扫描文本：本轮输入 + 最近原文 + 场景账本 + 开场种子 ---- */
  // 开场种子必须参与扫描：它本身就是「这一轮正在发生的事」，
  // 否则第一轮会找不到在场人物（凌玥明明就在雨里，却不在卡司里）。
  // 首轮没有场景快照时，用世界卡的 opening_state 顶替。
  // 否则引擎会自己猜季节与地点——实测会猜成「A 市夏天」，而这场戏是初冬的湘曲。
  const rawState = getState(sessionId);
  const openingState = isOpening && !rawState && card.opening_state
    ? { turn_no: 0, state: card.opening_state }
    : null;
  const stateRec = rawState || openingState;
  const recentText = getRecentText(sessionId, config.context.loreScanDepth);
  const sceneText = stateRec?.state
    ? `${stateRec.state.location || ''} ${Object.keys(stateRec.state.characters || {}).join(' ')} ${(stateRec.state.inventory || []).join(' ')}`
    : '';
  const openingSeed = isOpening ? buildOpeningSeed(world) : '';
  const scanText = [playerText || '', branchChoice?.description || '', sceneText, recentText, openingSeed].join('\n');

  /* ---- 1. system：契约（唯一允许的 system 消息） ---- */
  const systemMsg = { role: 'system', content: buildContract(session, world) };

  /* ---- 2-7. 设定层（全部 role:'user'，避免上游把正文写进 reasoning） ---- */
  const charterText = buildCharter(world, budgetCfg.world * 0.62);
  const protagonistText = buildProtagonist(world, session, budgetCfg.world * 0.28);
  const worldText = [charterText, protagonistText].filter(Boolean).join('\n\n');

  const castResult = buildCast(card, {
    playerText: [playerText || '', openingSeed, recentText].filter(Boolean).join('\n'),
    recentText,
    state: stateRec?.state || null,
    capTokens: budgetCfg.world * 0.36,
  });

  const loreResult = buildLore(lore, scanText, budgetCfg.lore, {
    recursion: config.context.loreRecursion,
  });

  const sceneText2 = buildScene(stateRec, budgetCfg.scene);
  const directorResult = buildDirector(world, turnNo || 1, budgetCfg.director);

  const settingBlocks = [worldText, castResult.text, loreResult.text, sceneText2, directorResult.text].filter(Boolean);
  const settingMsg = settingBlocks.length
    ? { role: 'user', content: settingBlocks.join('\n\n') }
    : null;

  /* ---- 8. 记忆层 ---- */
  const memoryResult = buildMemory(sessionId, budgetCfg.memory);
  const memoryMsg = memoryResult.text ? { role: 'user', content: memoryResult.text } : null;

  /* ---- 9. 检索层 ---- */
  const retriever = new MemoryRetriever(sessionId);
  const query = `${playerText || ''} ${branchChoice?.description || ''} ${castResult.present.map((c) => c.name).join(' ')}`.trim();
  const retrievalResult = buildRetrieval(retriever, query, budgetCfg.retrieval);
  const retrievalMsg = retrievalResult.text ? { role: 'user', content: retrievalResult.text } : null;

  /* ---- 10. 最近原文（排除本轮） ---- */
  const rawRows = getRecentTurns(sessionId, config.context.recentRawTurns);
  const recentRows = (Number.isInteger(turnNo) && turnNo > 0)
    ? rawRows.filter((r) => r.turn_no < turnNo)
    : rawRows;
  const recentMsgs = fitRecent(toRecentMessages(recentRows), budgetCfg.recent);

  /* ---- 11. 本轮输入 ---- */
  let extra = '';
  if (isOpening) {
    const seed = buildOpeningSeed(world) || str(card.opening_seed).trim();
    extra = seed
      ? `【开场】这是剧情的第一轮，此前没有任何历史。请把下面的开场种子扩写成一幕完整的开场：交代环境、主角处境与第一个可回应的情势，让主要人物以各自的方式登场，并埋下核心悬念。\n\n${seed}`
      : '【开场】这是剧情的第一轮。请依据世界宪章与主角设定，自行起笔一个强有力的开场，交代环境、处境与悬念。';
  }
  const currentMsg = buildCurrent(playerText, images, branchChoice, extra);

  /* ---- 超预算时的降级：从最低优先级的层开始砍 ---- */
  const layers = [
    { key: 'system', msg: systemMsg, droppable: false },
    { key: 'setting', msg: settingMsg, droppable: false },
    { key: 'memory', msg: memoryMsg, droppable: true },
    { key: 'retrieval', msg: retrievalMsg, droppable: true },
  ];

  const totalNow = () => layers.reduce((s, l) => s + (l.msg ? estimateMessageTokens(l.msg) : 0), 0)
    + recentMsgs.reduce((s, m) => s + estimateMessageTokens(m), 0)
    + estimateMessageTokens(currentMsg);

  // 软上限：先丢检索，再按比例裁记忆
  if (totalNow() > softMax) {
    const ret = layers.find((l) => l.key === 'retrieval');
    if (ret) ret.msg = null;
  }
  if (totalNow() > softMax) {
    const mem = layers.find((l) => l.key === 'memory');
    if (mem?.msg) {
      const excess = totalNow() - softMax;
      const cur = estimateMessageTokens(mem.msg);
      const target = Math.max(600, cur - excess);
      mem.msg = mem.msg.content
        ? { role: 'user', content: truncateToTokens(mem.msg.content, target) }
        : mem.msg;
    }
  }
  // 硬上限兜底：逐条截断最长的非 system 消息
  for (let guard = 0; guard < 40 && totalNow() > hardMax; guard++) {
    const candidates = [...layers.filter((l) => l.droppable && l.msg), { msg: currentMsg }]
      .filter((l) => l.msg && typeof l.msg.content === 'string');
    if (!candidates.length) break;
    candidates.sort((a, b) => estimateMessageTokens(b.msg) - estimateMessageTokens(a.msg));
    const m = candidates[0].msg;
    const t = estimateMessageTokens(m);
    if (t < 60) break;
    m.content = truncateToTokens(m.content, Math.max(40, Math.floor(t * 0.7)));
  }

  /* ---- 汇总 ---- */
  const messages = [
    ...layers.filter((l) => l.msg).map((l) => l.msg),
    ...recentMsgs,
    currentMsg,
  ];

  const budgetOf = (msg) => (msg ? estimateMessageTokens(msg) : 0);
  const breakdown = {
    contract: budgetOf(layers.find((l) => l.key === 'system')?.msg),
    world: estimateTokens(worldText) + 4,
    cast: budgetOf({ role: 'user', content: castResult.text }),
    lore: budgetOf({ role: 'user', content: loreResult.text }),
    scene: budgetOf({ role: 'user', content: sceneText2 }),
    director: budgetOf({ role: 'user', content: directorResult.text }),
    memory: budgetOf(layers.find((l) => l.key === 'memory')?.msg),
    retrieval: budgetOf(layers.find((l) => l.key === 'retrieval')?.msg),
    recent: recentMsgs.reduce((s, m) => s + estimateMessageTokens(m), 0),
    current: estimateMessageTokens(currentMsg),
  };
  breakdown.total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  breakdown.setting = breakdown.world + breakdown.cast + breakdown.lore + breakdown.scene + breakdown.director;

  return {
    messages,
    budget: breakdown,
    retriever,
    state: stateRec?.state || null,
    recentTurns: recentRows,
    retrievalSnippets: retrievalResult.hits,
    // 供 UI / 调试展示
    meta: {
      cast_present: castResult.present.map((c) => ({ name: c.name, role: c.role })),
      cast_absent: castResult.absent.map((c) => ({ name: c.name, role: c.role })),
      lore_entries: loreResult.entries.map((e) => ({ id: e.id, title: e.title, category: e.category, constant: e.constant })),
      lore_matched: loreResult.matchedKeys,
      director: directorResult.arc
        ? { index: directorResult.arcIndex, title: directorResult.arc.title, progress: directorResult.progress }
        : null,
      memory_split: memoryResult.split,
      soft_max: softMax,
      hard_max: hardMax,
    },
  };
}
