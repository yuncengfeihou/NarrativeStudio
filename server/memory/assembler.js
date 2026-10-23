/**
 * server/memory/assembler.js — 上下文装配器 + 预算管理
 *
 * 把分层记忆装配成可直接发送给 LLM 的 messages。优先级从高到低：
 *   1. system      narrator 系统提示词骨架（人设 / 口吻 / 输出格式）
 *   2. bible       世界观 + 角色详细卡 + 玩家身份 + 扮演规则
 *   3. state       当前剧情状态快照（getState，为 null 则省略）
 *   4. summaries   剧情记忆摘要（L4 全部 → L3 → L2 → L1，超预算从最老的 L3 开始丢）
 *   5. entities    关键实体与事实档案（top 40 实体 + 最近 80 条事实）
 *   6. retrieval   BM25 检索到的历史细节（与本轮玩家输入相关）
 *   7. recent      最近若干轮原始对话（至少保 2 轮 = 4 条消息）
 *   8. current     本轮玩家输入（含分支选择与图片）
 *
 * 硬上限：settings.context_max_tokens ?? config.context.maxTokens（默认 200000）。
 * 超过 softTokens 时停止追加低优先级层；超过硬上限时按
 *   retrieval → 老 summaries → entities → recent（保底 2 轮）→ state → bible 截断
 * 的顺序降级，最后兜底截断 system / current，保证 budget.total ≤ 硬上限。
 *
 * 调用约定：先 addTurn(player) 再 assembleContext —— 这样 retrieval 能索引到本轮
 * 玩家消息；同时 recent 层会过滤掉 turn_no ≥ turnNo 的行，避免与 current 重复。
 */
import { config } from '../config.js';
import { estimateMessageTokens, estimateMessagesTokens, estimateTokens, truncateToTokens } from '../tokens.js';
import { getEntities, getFacts, getLatestSummaries, getNotes, getRecentTurns, getState, getSummaries } from './store.js';
import { MemoryRetriever } from './retriever.js';

/** 摘要层目标总量（tok） */
const SUMMARY_TARGET_TOKENS = 60000;
/** 实体+事实层上限（tok） */
const ENTITY_FACT_MAX_TOKENS = 12000;
/** 保底的最近原始消息条数（2 轮 = 4 条） */
const RECENT_FLOOR_MESSAGES = 4;
/** L3 保底条数（至少保留最近 8 条） */
const L3_KEEP_MIN = 8;
/** system 提示词里世界观/规则的摘要长度上限（tok），完整版在 bible 层 */
const WORLDVIEW_DIGEST_TOKENS = 1200;
const RULES_DIGEST_TOKENS = 800;
/** 单条 user 消息的角色开销近似（role + 结构位） */
const MSG_OVERHEAD = estimateTokens('user') + 4;

/** 实体类型中文标签 */
const ENTITY_TYPE_LABELS = {
  character: '角色', item: '物品', location: '地点',
  faction: '势力', event: '事件', concept: '概念',
};

/** 角色卡字段中文标签（未知字段回退为原始键名） */
const CHAR_FIELD_LABELS = {
  name: '姓名', role: '定位', personality: '性格', voice: '台词风格',
  secret: '秘密', background: '背景', goal: '目标', relationship: '关系',
  speaking_style: '说话方式', age: '年龄', identity: '身份',
};
const CHAR_FIELD_SKIP = new Set(['avatar_hue', 'avatar', 'id', 'color']);

/* ------------------------------------------------------------------ */
/* 系统提示词 / 世界圣经                                               */
/* ------------------------------------------------------------------ */

/**
 * 生成 narrator 的系统提示词骨架（供 narrator agent 与 assembler 复用）。
 * @param {{settings?:object}} session
 * @returns {string}
 */
export function buildNarratorSystemPrompt(session) {
  const s = session?.settings || {};
  const out = [];

  out.push('你是剧情演绎引擎，负责把玩家的行动实时演绎成高质量的小说式剧情。');
  if (s.title) out.push(`剧情标题：《${s.title}》`);
  if (s.style_tags?.length) out.push(`风格标签：${s.style_tags.join('、')}`);

  if (s.characters?.length) {
    out.push('', '【角色口吻】');
    for (const c of s.characters) {
      let line = `- ${c.name || '未命名角色'}${c.role ? `（${c.role}）` : ''}`;
      if (c.personality) line += `：${c.personality}`;
      if (c.voice) line += `；台词风格：${c.voice}`;
      out.push(line);
    }
  }

  // 世界观只放摘要，完整设定由 bible 层承载（避免同一段长文本重复占用预算）
  if (s.worldview) {
    out.push('', '【世界观要点】', truncateToTokens(String(s.worldview), WORLDVIEW_DIGEST_TOKENS));
  }
  if (s.rules) {
    out.push('', '【扮演规则】', truncateToTokens(String(s.rules), RULES_DIGEST_TOKENS));
  }

  out.push(
    '', '【输出格式】',
    '- 只输出剧情正文本身，不要输出思考过程、自我说明、Markdown 标题或 JSON。',
    '- 使用连贯的小说体叙事，综合环境、动作、对话与心理描写。',
    '- 不要复述或转写玩家的输入内容。',
    '- 严格保持角色口吻与世界观设定，不 OOC，不擅自添加设定外的强设定。',
  );
  return out.join('\n');
}

/** 生成世界圣经消息（世界观 + 角色详细卡 + 玩家身份 + 规则） */
function buildBibleMessage(session, cap = Infinity) {
  const s = session?.settings || {};
  const sections = ['【世界观与角色设定】'];

  if (s.worldview) sections.push(`◇ 世界观\n${s.worldview}`);
  if (s.characters?.length) {
    const cards = s.characters.map(c => {
      const lines = [`· ${c.name || '未命名角色'}${c.role ? `（${c.role}）` : ''}`];
      for (const [k, v] of Object.entries(c)) {
        if (CHAR_FIELD_SKIP.has(k) || k === 'name' || k === 'role') continue;
        if (v == null || v === '') continue;
        const label = CHAR_FIELD_LABELS[k] || k;
        lines.push(`  ${label}：${Array.isArray(v) ? v.join('、') : String(v)}`);
      }
      return lines.join('\n');
    });
    sections.push(`◇ 角色档案\n${cards.join('\n')}`);
  }
  if (s.player_role) sections.push(`◇ 玩家身份\n${s.player_role}`);
  if (s.rules) sections.push(`◇ 扮演规则\n${s.rules}`);

  let content = sections.join('\n\n');
  if (cap !== Infinity) content = truncateToTokens(content, cap);
  return { role: 'system', content };
}

/* ------------------------------------------------------------------ */
/* 各层消息构建                                                        */
/* ------------------------------------------------------------------ */

/** 摘要层：L4 全部 → L3（保底最近 8 条）→ L2 最近 recentArcs 条 → L1 最近 5 条 */
function buildSummariesMessage(sessionId, capTokens) {
  if (capTokens <= 0) return null;
  const l4 = getSummaries(sessionId, { level: 4, archived: 0 });
  const l3 = getSummaries(sessionId, { level: 3, archived: 0 });
  const l2 = getLatestSummaries(sessionId, 2, config.context.recentArcs);
  const l1 = getLatestSummaries(sessionId, 1, 5);
  if (!l4.length && !l3.length && !l2.length && !l1.length) return null;

  const lineOf = e => `[第${e.from}-${e.to}轮] ${e.text}`;
  const costOf = e => estimateTokens(lineOf(e)) + 1;
  const entries = [];
  const push = (s, tier, droppable) => entries.push({
    tier, droppable, from: s.turn_from, to: s.turn_to, text: s.content || '',
  });
  for (const s of l4) push(s, 4, false);                                  // L4 高层级不丢
  for (let i = 0; i < l3.length; i++) push(l3[i], 3, i < l3.length - L3_KEEP_MIN);
  for (const s of l2) push(s, 2, true);
  for (const s of l1) push(s, 1, true);
  for (const e of entries) e.cost = costOf(e);

  let total = entries.reduce((s, e) => s + e.cost, 0);
  let kept = entries;

  // 1) 超预算 → 从最老的 droppable 开始丢（老 L3 → L2 → L1）
  if (total > capTokens) {
    const dropOrder = entries
      .filter(e => e.droppable)
      .sort((a, b) => a.from - b.from || a.tier - b.tier);
    const dropped = new Set();
    for (const e of dropOrder) {
      if (total <= capTokens) break;
      dropped.add(e);
      total -= e.cost;
    }
    kept = entries.filter(e => !dropped.has(e));
  }

  // 2) 仅剩不可丢项仍超预算 → 按比例压缩每条；仍放不下则从最老开始丢，直到放得下
  while (kept.length && total > capTokens) {
    const scale = capTokens / Math.max(1, total);
    const scaled = kept.map(e => ({
      ...e,
      text: truncateToTokens(e.text, Math.max(60, Math.floor(estimateTokens(e.text) * scale))),
    }));
    const t2 = scaled.reduce((s, e) => s + costOf(e), 0);
    if (t2 <= capTokens) { kept = scaled; break; }
    if (scaled.length === 1) return null;          // 一条都放不下 → 整层省略
    const dropCost = kept[0].cost;
    kept = kept.slice(1);
    total -= dropCost;
  }
  if (!kept.length) return null;

  const content = `【剧情记忆摘要】（由高层到低层，覆盖全部历史）\n${kept.map(lineOf).join('\n')}`;
  return { role: 'user', content };
}

/** 实体 + 事实层：固定项优先，其余按 importance 降序 / 时间降序 */
function buildEntitiesMessage(sessionId, capTokens) {
  if (capTokens <= 0) return null;
  const entities = getEntities(sessionId, { limit: 40 });
  const facts = getFacts(sessionId, { limit: 80 });
  if (!entities.length && !facts.length) return null;

  const lines = [];
  let used = MSG_OVERHEAD + estimateTokens('【关键实体与事实档案】');
  for (const e of entities) {
    const label = ENTITY_TYPE_LABELS[e.type] || e.type || '实体';
    const pin = e.pinned ? '★' : '';
    const line = `【${label}${pin}】${e.name}：${e.summary || ''}`;
    const cost = estimateTokens(line) + 1;
    // 固定实体永不被预算挤掉（除非自身已超上限）
    if (used + cost > capTokens && !e.pinned) break;
    lines.push(line);
    used += cost;
  }
  if (facts.length) {
    lines.push('—— 事实关系 ——');
    used += estimateTokens('—— 事实关系 ——') + 1;
    for (const f of facts) {
      const line = `${f.subject} - ${f.predicate} - ${f.object}`;
      const cost = estimateTokens(line) + 1;
      if (used + cost > capTokens && !f.pinned) break;
      lines.push(line);
      used += cost;
    }
  }
  if (!lines.length) return null;
  return { role: 'user', content: `【关键实体与事实档案】\n${lines.join('\n')}` };
}

/**
 * 作者笔记层：人工固化的确定性记忆（设定补充 / 硬规则 / 未回收伏笔 / 覆盖记忆）。
 * 这一层永不压缩、永不丢弃，位置放在摘要之前，保证模型的最高注意力落在它身上。
 *
 * 用 role:'user' 而非 'system'：与 state / summaries / entities / retrieval 各层
 * 保持一致。把额外的 system 消息插进对话中段，部分模型（实测 step-5-preview）
 * 会把正文全写进 reasoning 通道，content 为空。
 */
const NOTE_KIND_LABEL = {
  note: '补充设定',
  rule: '硬性规则',
  foreshadow: '待回收伏笔',
  retcon: '覆盖既有记忆',
};

function buildNotesMessage(sessionId) {
  const notes = getNotes(sessionId, { activeOnly: true });
  if (!notes.length) return null;
  const lines = notes.map(n => `【${NOTE_KIND_LABEL[n.kind] || '笔记'}】${n.content}`);
  return {
    role: 'user',
    content: `【作者笔记】（以下为作者钦定的事实与规则，优先级高于自动记忆与即兴创作，必须严格遵守）\n${lines.join('\n')}`,
  };
}

/** 检索层：用本轮玩家输入（+ 分支描述）召回历史细节 */
function buildRetrievalMessage(retriever, query, capTokens) {
  const hits = retriever.search(query, { topK: config.context.retrievalTopK });
  if (!hits.length || capTokens <= 0) return { msg: null, hits };

  const lines = [];
  let used = MSG_OVERHEAD + estimateTokens('【检索到的历史细节】');
  for (const h of hits) {
    let label;
    if (h.kind === 'turn') label = `[第${h.turn_no}轮·原始记录]`;
    else if (h.kind === 'summary') {
      label = h.turn_from != null ? `[第${h.turn_from}-${h.turn_to}轮·摘要]` : `[第${h.turn_no}轮·摘要]`;
    } else label = h.name ? `[实体档案·${h.name}]` : '[实体档案]';
    const line = `${label} ${h.snippet}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > capTokens) break;
    lines.push(line);
    used += cost;
  }
  if (!lines.length) return { msg: null, hits };
  return {
    msg: { role: 'user', content: `【检索到的历史细节】（与当前行动相关的旧线索）\n${lines.join('\n')}` },
    hits,
  };
}

/** 原始 turn 行 → 对话消息（system 类存档行不参与装配；历史图片不重复发送） */
function toRecentMessages(rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind === 'player') out.push({ role: 'user', content: r.content });
    else if (r.kind === 'narrator') out.push({ role: 'assistant', content: r.content });
    // kind === 'system' 的存档行忽略
  }
  return out;
}

/** 在预算内尽量多地保留最近的原始消息（装不下则丢最老的，保底 4 条） */
function fitRecent(msgs, capTokens) {
  if (!msgs.length) return [];
  let total = msgs.reduce((s, m) => s + estimateMessageTokens(m), 0);
  let start = 0;
  while (start < msgs.length && total > capTokens && msgs.length - start > RECENT_FLOOR_MESSAGES) {
    total -= estimateMessageTokens(msgs[start]);
    start++;
  }
  return msgs.slice(start);
}

/** 本轮玩家输入消息（分支选择 + 多图 multipart） */
function buildCurrentMessage(playerText, images, branchChoice) {
  let text = '';
  if (branchChoice) {
    text = `【玩家选择的剧情分支】${branchChoice.title || ''}：${branchChoice.description || ''}\n【玩家行动】${playerText || ''}`;
  } else if (playerText) {
    text = String(playerText);
  }

  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of normalizeImages(images)) parts.push({ type: 'image_url', image_url: { url } });
  if (!parts.length) parts.push({ type: 'text', text: '请开始剧情。' });   // 首轮开场兜底

  const content = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
  return { role: 'user', content };
}

/** 归一化图片输入：字符串 URL / {url} / {image_url:{url}} → URL 数组 */
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

/* ------------------------------------------------------------------ */
/* 硬上限兜底降级                                                      */
/* ------------------------------------------------------------------ */

const sameMessage = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.role === b.role && a.content === b.content;
};

/**
 * 超硬上限时的降级阶梯。ctx 结构：
 *   { layers:[{key,msg|null}], makers:{key:{cap,make}}, recent:[], current:msg|null, hardMax }
 */
function enforceHardLimit(ctx) {
  const hardMax = ctx.hardMax;
  const allMessages = () => [
    ...ctx.layers.filter(l => l.msg).map(l => l.msg),
    ...ctx.recent,
    ...(ctx.current ? [ctx.current] : []),
  ];
  const total = () => estimateMessagesTokens(allMessages());
  const layer = key => ctx.layers.find(l => l.key === key);

  const dropLayer = key => {
    const l = layer(key);
    if (!l || !l.msg) return false;
    l.msg = null;
    return true;
  };
  const shrinkLayer = key => {
    const m = ctx.makers[key];
    const l = layer(key);
    if (!m || !l) return false;
    if (m.cap <= 0) return false;                 // 已无可缩空间
    const next = Math.floor(m.cap / 2);
    m.cap = next;
    const msg = m.make(next);
    if (sameMessage(l.msg, msg)) return false;    // 无实际变化 → 让阶梯继续往下走
    l.msg = msg;
    return true;
  };
  const shrinkRecent = () => {
    if (ctx.recent.length > RECENT_FLOOR_MESSAGES) {
      ctx.recent = ctx.recent.slice(1);           // 丢最老的一条，保底 2 轮
      return true;
    }
    return false;
  };
  // 兜底：截断最老的、仍超过 40 tok 的 recent 内容（保护最新上下文）
  const truncateOldestRecent = () => {
    for (const m of ctx.recent) {
      const t = estimateMessageTokens(m);
      if (t <= 40 || typeof m.content !== 'string') continue;
      const next = truncateToTokens(m.content, Math.max(40, Math.floor(t / 2)));
      if (next === m.content) continue;          // 无实际变化 → 试下一条
      m.content = next;
      return true;
    }
    return false;
  };
  const truncateMessage = (msg, minTokens) => {
    if (!msg) return false;
    const t = estimateMessageTokens(msg);
    if (t <= minTokens) return false;
    if (typeof msg.content === 'string') {
      msg.content = truncateToTokens(msg.content, Math.max(minTokens, Math.floor(t / 2)));
      return true;
    }
    if (Array.isArray(msg.content)) {
      // multipart：先丢图片，再截文本
      const text = msg.content.find(p => p.type === 'text');
      if (msg.content.some(p => p.type === 'image_url')) {
        msg.content = msg.content.filter(p => p.type !== 'image_url');
        return true;
      }
      if (text) {
        text.text = truncateToTokens(text.text, Math.max(minTokens, Math.floor(t / 2)));
        return true;
      }
    }
    return false;
  };

  const steps = [
    () => dropLayer('retrieval'),
    () => shrinkLayer('summaries'),
    () => shrinkLayer('entities'),
    shrinkRecent,
    () => dropLayer('state'),
    () => dropLayer('notes'),        // 笔记层：仅在最极端超限时才舍弃
    () => shrinkLayer('bible'),
    truncateOldestRecent,
    () => truncateMessage(ctx.layers.find(l => l.key === 'system')?.msg, 80),
    () => truncateMessage(ctx.current, 20),
  ];

  for (let guard = 0; guard < 500; guard++) {
    if (total() <= hardMax) return;
    let progressed = false;
    for (const step of steps) {
      if (step()) { progressed = true; break; }
    }
    if (!progressed) break;
  }

  // 绝对兜底：按缺口精确截断（含多图消息退图为纯文本），保证 total ≤ hardMax
  for (let guard = 0; guard < 200 && total() > hardMax; guard++) {
    let overflow = total() - hardMax;
    const msgs = allMessages();
    for (const m of msgs) {
      if (overflow <= 0) break;
      const cur = estimateMessageTokens(m);
      if (Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')) {
        m.content = m.content.filter(p => p.type !== 'image_url');
        overflow -= 900;
        continue;
      }
      const text = typeof m.content === 'string' ? m.content : m.content?.find(p => p.type === 'text')?.text;
      if (typeof text !== 'string') continue;
      const target = Math.max(0, cur - overflow - 4);
      if (target >= cur) continue;
      const next = truncateToTokens(text, target);
      const saved = cur - (estimateTokens(next) + estimateTokens(m.role) + 4);
      if (saved <= 0) continue;
      if (typeof m.content === 'string') m.content = next;
      else m.content.find(p => p.type === 'text').text = next;
      overflow -= saved;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 装配一轮 LLM 请求的完整 messages。
 * @param {{session:object, turnNo?:number, playerText?:string,
 *          images?:Array, branchChoice?:object}} args
 * @returns {Promise<{messages:Array, budget:object, retriever:MemoryRetriever,
 *                    state:object|null, recentTurns:Array, retrievalSnippets:Array}>}
 */
export async function assembleContext({ session, turnNo, playerText, images, branchChoice }) {
  const settings = session?.settings || {};
  const hardMax = settings.context_max_tokens ?? config.context.maxTokens;
  const softMax = Math.min(config.context.softTokens, hardMax);

  /* ---- 1. system ---- */
  const systemMsg = { role: 'system', content: buildNarratorSystemPrompt(session) };

  /* ---- 2. world bible ---- */
  const bibleMsg = buildBibleMessage(session);

  /* ---- 2.5 作者笔记（人工固化记忆，优先级极高） ---- */
  const notesMsg = buildNotesMessage(session.id);

  /* ---- 3. state ---- */
  const stateRec = getState(session.id);
  const state = stateRec?.state ?? null;
  const stateMsg = stateRec
    ? { role: 'user', content: `【当前剧情状态】（第 ${stateRec.turn_no} 轮快照）\n${JSON.stringify(state)}` }
    : null;

  /* ---- 4. summaries ---- */
  const usedBeforeSummaries =
    estimateMessageTokens(systemMsg) + estimateMessageTokens(bibleMsg) +
    (notesMsg ? estimateMessageTokens(notesMsg) : 0) +
    (stateMsg ? estimateMessageTokens(stateMsg) : 0);
  const summaryCap = Math.min(SUMMARY_TARGET_TOKENS, Math.max(0, softMax - usedBeforeSummaries));
  const summariesMsg = buildSummariesMessage(session.id, summaryCap);

  /* ---- 5. entities + facts ---- */
  const entityCap = Math.min(ENTITY_FACT_MAX_TOKENS, Math.max(0, softMax - usedBeforeSummaries - (summariesMsg ? estimateMessageTokens(summariesMsg) : 0)));
  const entitiesMsg = buildEntitiesMessage(session.id, entityCap);

  /* ---- 6. retrieval ---- */
  const retriever = new MemoryRetriever(session.id);
  const query = `${playerText || ''} ${branchChoice?.description || ''}`.trim();
  const retrievalCap = Math.min(config.context.retrievalMaxTokens, Math.max(0, softMax - usedBeforeSummaries -
    (summariesMsg ? estimateMessageTokens(summariesMsg) : 0) -
    (entitiesMsg ? estimateMessageTokens(entitiesMsg) : 0)));
  const { msg: retrievalMsg, hits: retrievalHits } = buildRetrievalMessage(retriever, query, retrievalCap);

  /* ---- 7. recent raw turns（排除本轮，避免与 current 重复） ---- */
  const rawRows = getRecentTurns(session.id, config.context.recentRawTurns);
  const recentRows = (Number.isInteger(turnNo) && turnNo > 0)
    ? rawRows.filter(r => r.turn_no < turnNo)
    : rawRows;
  const usedBeforeRecent = usedBeforeSummaries +
    (summariesMsg ? estimateMessageTokens(summariesMsg) : 0) +
    (entitiesMsg ? estimateMessageTokens(entitiesMsg) : 0) +
    (retrievalMsg ? estimateMessageTokens(retrievalMsg) : 0);
  const recentMsgs = fitRecent(toRecentMessages(recentRows), Math.max(0, softMax - usedBeforeRecent));

  /* ---- 8. current ---- */
  const currentMsg = buildCurrentMessage(playerText, images, branchChoice);

  const ctx = {
    hardMax,
    layers: [
      { key: 'system', msg: systemMsg },
      { key: 'bible', msg: bibleMsg },
      { key: 'notes', msg: notesMsg },
      { key: 'state', msg: stateMsg },
      { key: 'summaries', msg: summariesMsg },
      { key: 'entities', msg: entitiesMsg },
      { key: 'retrieval', msg: retrievalMsg },
    ],
    makers: {
      // bible 的 cap 初值取其自然体积，之后逐次减半
      bible: { cap: estimateMessageTokens(bibleMsg), make: cap => buildBibleMessage(session, cap) },
      summaries: { cap: summaryCap, make: cap => buildSummariesMessage(session.id, cap) },
      entities: { cap: entityCap, make: cap => buildEntitiesMessage(session.id, cap) },
    },
    recent: recentMsgs,
    current: currentMsg,
  };

  /* ---- 硬上限兜底 ---- */
  enforceHardLimit(ctx);

  /* ---- 汇总 ---- */
  const messages = [
    ...ctx.layers.filter(l => l.msg).map(l => l.msg),
    ...ctx.recent,
    ...(ctx.current ? [ctx.current] : []),
  ];
  const budget = {
    system: 0, bible: 0, notes: 0, state: 0, summaries: 0, entities: 0,
    retrieval: 0, recent: 0, current: 0, total: 0,
  };
  for (const l of ctx.layers) if (l.msg) budget[l.key] = estimateMessageTokens(l.msg);
  budget.recent = ctx.recent.reduce((s, m) => s + estimateMessageTokens(m), 0);
  if (ctx.current) budget.current = estimateMessageTokens(ctx.current);
  budget.total = budget.system + budget.bible + budget.notes + budget.state +
    budget.summaries + budget.entities + budget.retrieval + budget.recent + budget.current;

  return {
    messages,
    budget,
    retriever,
    state,
    recentTurns: recentRows,
    retrievalSnippets: retrievalHits,
  };
}
