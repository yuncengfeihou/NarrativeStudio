/**
 * server/world/scene-sheet.js — 世界索引、辞书挑选与场记单渲染
 *
 * 全部是纯函数：输入世界卡 + 当前场次的状态，输出提示词文本。
 * 不调 LLM、不碰存储、不做关键词匹配——codex 条目靠「实体连接 + 主题标签 +
 * 用户钉选」进场，场记单靠「世界状态」渲染。
 */
import { estimateTokens, truncateToTokens } from '../tokens.js';

const join = (arr, sep = '、') => (arr || []).filter(Boolean).join(sep);

/* ══════════════════════════════════════════════════════════════════════ */
/* 1. 世界索引（常驻）                                                     */
/* ══════════════════════════════════════════════════════════════════════ */

const TYPE_GROUPS = [
  { key: 'character', label: '人物' },
  { key: 'place', label: '地点' },
  { key: 'institution', label: '机构' },
  { key: 'faction', label: '势力' },
  { key: 'item', label: '物件' },
  { key: 'concept', label: '概念' },
  { key: 'custom', label: '其他' },
];

/**
 * 世界索引 = 小说开头那张「人物表」。它不提供细节，只保证模型知道世界上
 * 存在这些东西，不会凭空发明同名实体，也不会把地名写漂。
 *
 * 超预算时的降级顺序：带摘要 → 只留名字 → 末尾省略。
 */
export function renderWorldIndex(card, capTokens = 1200, { skipIds = null } = {}) {
  const cast = card.cast || [];
  const codex = (card.codex || []).filter((e) => !skipIds?.has(e.id));
  if (!cast.length && !codex.length) return '';

  const header = '【世界索引】这个世界上已存在的人物与事物。它们只说明「有什么」，'
    + '不说明「此刻如何」——细节以场记单为准。不得发明索引之外的重要实体，'
    + '不得改写这些名字。';

  const lines = [];
  let used = estimateTokens(header) + 2;

  const pushGroup = (label, items) => {
    if (!items.length) return;
    const withSummary = items.map((it) => (it.summary ? `${it.name}（${it.summary}）` : it.name));
    let line = `${label}　${join(withSummary, '｜')}`;
    let cost = estimateTokens(line) + 1;
    if (used + cost > capTokens && lines.length) {
      // 降级：只留名字
      const namesOnly = items.map((it) => it.name);
      line = `${label}　${join(namesOnly, '｜')}`;
      cost = estimateTokens(line) + 1;
      if (used + cost > capTokens) {
        const room = Math.max(0, capTokens - used - estimateTokens(`${label}　`) - 4);
        if (room > 8) lines.push(`${label}　${truncateToTokens(join(namesOnly, '｜'), room)}…`);
        return;
      }
    }
    used += cost;
    lines.push(line);
  };

  const castItems = cast
    .slice()
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .map((c) => {
      // 索引只说「现在这个人是谁」，运行期状态由场记单负责细节。
      const bits = [c.role, c.status && c.status !== c.role ? c.status : ''].filter(Boolean);
      return { name: c.name, summary: bits.join(' · ') || c.one_line || c.status };
    });
  pushGroup('人物', castItems);

  for (const g of TYPE_GROUPS) {
    if (g.key === 'character') continue;
    const items = codex
      .filter((e) => e.type === g.key)
      .map((e) => ({ name: e.name, summary: e.summary }));
    pushGroup(g.label, items);
  }

  if (!lines.length) return '';
  return `${header}\n${lines.join('\n')}`;
}

/**
 * 世界索引·树形版：有 parent_id 的卡按包含关系折叠。
 * 远处实体只留名字，近处（有摘要）保留一句话；没有包含关系时退回平铺索引。
 *
 * @param {object} card
 * @param {number} capTokens
 * @param {{skipIds?:Set<string>, currentPlaceId?:string}} opts
 */
export function renderWorldTree(card, capTokens = 1200, { skipIds = null, currentPlaceId = '' } = {}) {
  const codex = (card.codex || []).filter((e) => !skipIds?.has(e.id));
  const hasParent = codex.some((e) => e.parent_id);
  if (!hasParent) return renderWorldIndex(card, capTokens, { skipIds });

  const header = '【世界索引】这个世界上已存在的人物与事物。它们只说明「有什么」，'
    + '不说明「此刻如何」——细节以场记单为准。不得发明索引之外的重要实体，'
    + '不得改写这些名字。';

  const byKey = new Map();
  for (const e of codex) {
    byKey.set(e.id, e);
    byKey.set(e.name, e);
    for (const a of e.aliases || []) byKey.set(a, e);
  }
  const children = new Map();
  const roots = [];
  for (const e of codex) {
    const parent = e.parent_id ? byKey.get(e.parent_id) : null;
    if (parent && parent !== e) {
      if (!children.has(parent.id)) children.set(parent.id, []);
      children.get(parent.id).push(e);
    } else {
      roots.push(e);
    }
  }

  const treeTypes = new Set(['place', 'institution', 'faction']);
  const isTree = (e) => treeTypes.has(e.type) || !!e.parent_id || children.has(e.id);
  const label = (e) => {
    const bits = [e.summary].filter(Boolean);
    const mark = currentPlaceId && (e.id === currentPlaceId || e.name === currentPlaceId) ? '（当前）' : '';
    return `${e.name}${mark}${bits.length ? `（${bits[0]}）` : ''}`;
  };

  const buildLines = (withSummary) => {
    const lines = [];
    const cast = (card.cast || []).slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
    if (cast.length) {
      lines.push(`人物　${join(cast.map((c) => {
        const bits = [c.role, c.status && c.status !== c.role ? c.status : ''].filter(Boolean);
        const s = bits.join(' · ') || c.one_line || '';
        return withSummary && s ? `${c.name}（${s}）` : c.name;
      }), '｜')}`);
    }

    const walk = (e, depth) => {
      const indent = depth === 0 ? '' : `${'  '.repeat(depth)}└ `;
      lines.push(`${indent}${withSummary ? label(e) : e.name}`);
      for (const child of (children.get(e.id) || []).sort((a, b) => a.name.localeCompare(b.name))) {
        walk(child, depth + 1);
      }
    };
    for (const e of roots.filter(isTree).sort((a, b) => a.name.localeCompare(b.name))) walk(e, 0);

    for (const g of TYPE_GROUPS) {
      if (g.key === 'character' || g.key === 'place' || g.key === 'institution' || g.key === 'faction') continue;
      const items = codex.filter((e) => e.type === g.key && !isTree(e));
      if (!items.length) continue;
      lines.push(`${g.label}　${join(items.map((e) => (withSummary && e.summary ? `${e.name}（${e.summary}）` : e.name)), '｜')}`);
    }
    return lines;
  };

  let lines = buildLines(true);
  if (estimateTokens(`${header}\n${lines.join('\n')}`) > capTokens) lines = buildLines(false);
  let text = `${header}\n${lines.join('\n')}`;
  if (estimateTokens(text) > capTokens) text = truncateToTokens(text, capTokens);
  return text;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 2. 辞书挑选（无关键词）                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 按三条路径给 codex 条目打分，返回按分数排序的候选：
 *   - 实体连接：在场/被提及/被钉选的实体 id 出现在 entry.links 里
 *   - 主题标签：entry.tags 与本场主题相交
 *   - 常驻微条目：作者钉选
 *
 * @returns {Array<{entry, score, why:string[]}>}
 */
export function selectCodex(card, {
  presentIds = [], mentionedIds = [], threadTags = [], pinnedIds = [], currentPlaceId = null,
  skipIds = null,
} = {}) {
  const linkSet = new Set([...presentIds, ...mentionedIds, ...pinnedIds]);
  const tagSet = new Set((threadTags || []).filter(Boolean));
  const out = [];
  for (const entry of card.codex || []) {
    if (skipIds?.has(entry.id)) continue;
    const why = [];
    let score = 0;
    if (entry.pinned) { score += 100; why.push('钉选'); }
    // 实体连接 = 条目本身在场/被提及，或条目 links 指向在场实体。
    // 后者让「司楼」因凌玥在场而进场，前者让剧情里新发现的地点能被点名带出。
    if (linkSet.has(entry.id) || entry.links?.some((l) => linkSet.has(l))) {
      score += 60;
      why.push('实体在场');
    }
    if (tagSet.size && entry.tags?.some((t) => tagSet.has(t))) { score += 30; why.push('本场主题'); }
    if (entry.type === 'place' && currentPlaceId && entry.id === currentPlaceId) {
      score += 20;
      why.push('当前地点');
    }
    if (score > 0) out.push({ entry, score, why });
  }
  out.sort((a, b) => b.score - a.score
    || Number(b.entry.pinned) - Number(a.entry.pinned)
    || a.entry.name.localeCompare(b.entry.name));
  return out;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 3. 场记单                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

function renderCastLine(c, ledgerChar, voices) {
  const lines = [`· ${c.name}${c.role ? `（${c.role}）` : ''}`];
  // 账本是这一场的最新状态；投影后的角色字段是会话级变化（例如长伤、死亡）。
  const condition = ledgerChar?.condition || c.condition;
  const mood = ledgerChar?.mood || c.mood;
  const location = ledgerChar?.location || c.location;
  const state = [
    condition, mood, location ? `@${location}` : '',
    c.status && c.status !== '临时登场' ? c.status : '',
  ].filter(Boolean);
  if (state.length) lines.push(`  状态：${join(state, '｜')}`);
  if (c.voice.rhythm) lines.push(`  口吻：${c.voice.rhythm}`);
  if (c.agenda?.length) {
    const ag = c.agenda
      .slice()
      .sort((a, b) => (b.pressure || 0) - (a.pressure || 0))
      .map((a) => `${a.goal}${a.method ? `——${a.method}` : ''}`)
      .join('；');
    lines.push(`  私心：${ag}`);
  }
  const know = [];
  if (c.knowledge.knows.length) know.push(`她知道/他知道：${join(c.knowledge.knows)}`);
  if (c.knowledge.does_not_know.length) know.push(`不知道：${join(c.knowledge.does_not_know)}`);
  if (know.length) lines.push(`  边界：${know.join('；')}`);
  const v = voices?.[c.id];
  if (v?.length) lines.push(`  原声：${join(v.slice(0, 2), '／')}`);
  return lines.join('\n');
}

function renderCodexEntry(entry) {
  const head = entry.reveal === 'secret' ? `· 【只你可知，不得说破】${entry.name}` : `· ${entry.name}`;
  const lines = [head];
  const f = entry.facets || {};
  const history = str(f.history);
  // summary 若已被 history 覆盖（history 直接放了全文），不重复渲染
  const summary = str(entry.summary);
  const summaryRedundant = summary && history && history.includes(summary.slice(0, Math.min(20, summary.length)));
  if (summary && !summaryRedundant) lines.push(`  ${summary}`);
  if (f.rules?.length) lines.push(`  规则：${join(f.rules, '；')}`);
  if (f.consequences?.length) lines.push(`  后果：${join(f.consequences, '；')}`);
  if (f.sensory) lines.push(`  质感：${f.sensory}`);
  if (history) lines.push(`  来历：${history}`);
  // 运行态字段（world_state 投影到 effective world 后挂在这里），与定义分开渲染。
  const now = [
    entry.status ? `状态：${entry.status}` : '',
    entry.condition ? `状况：${entry.condition}` : '',
    entry.access ? `出入：${entry.access}` : '',
    entry.owner_id ? `归属：${entry.owner_id}` : '',
    entry.location_id ? `位置：${entry.location_id}` : '',
    entry.open_to ? `开放：${entry.open_to}` : '',
  ].filter(Boolean);
  if (now.length) lines.push(`  此刻：${join(now, '｜')}`);
  return lines.join('\n');
}

/** T1 邻域：只给一句摘要与当前状态，不展开规则/来历。 */
function renderCodexBrief(entry) {
  const bits = [str(entry.summary), str(entry.status), str(entry.access)].filter(Boolean);
  return `· ${entry.name}${bits.length ? `｜${join(bits, '；')}` : ''}`;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

/**
 * 渲染场记单。这是每场戏开拍前递给编剧的 brief：给条件，不给路线。
 *
 * @param {object} args
 * @param {object} args.ledger      当前场景账本
 * @param {Array}  args.present     在场卡司（normalizeCard 后的 cast 条目）
 * @param {Array}  args.relations   关系切片（已过滤）
 * @param {Array}  args.threads     未回收线索
 * @param {Array}  args.codex       选中的辞书条目（selectCodex 的 entry）
 * @param {object} args.voices      castId -> [原声台词]
 * @param {Array}  args.echoes      [{who,text,turn_no}]
 * @param {string} args.directive   用户的本场指令
 * @param {number} args.capTokens
 * @returns {{text:string, meta:object}}
 */
export function renderSceneSheet({
  ledger = {}, present = [], relations = [], threads = [], codex = [], codexBrief = [],
  voices = {}, echoes = [], facts = [], worldRuntime = {}, directive = '', capTokens = 2200,
} = {}) {
  const L = ledger || {};
  const meta = {
    present: present.length,
    codex: codex.length,
    codex_brief: codexBrief.length,
    echoes: echoes.length,
    facts: facts.length,
    kept: [],
    dropped: [],
    codex_rendered: 0,
    codex_brief_rendered: 0,
  };
  if (!present.length && !L.place && !L.time) return { text: '', meta };

  const head = [];
  head.push(`【场记单】这是当前这一刻世界的既定事实，不是新的用户发言。`);
  head.push(`从这里接续，不要复述它。`);

  const bits = [];
  if (L.time) bits.push(`时间 ${L.time}`);
  if (L.place) bits.push(`地点 ${L.place}`);
  if (L.weather) bits.push(`天气 ${L.weather}`);
  if (typeof L.tension === 'number') bits.push(`张力 ${L.tension.toFixed(2)}`);
  const whenLine = bits.join('｜');
  const runtimeLine = str(worldRuntime.status) ? `局势 ${str(worldRuntime.status)}` : '';

  const castBlock = present.map((c) => renderCastLine(c, L.characters?.[c.id], voices)).join('\n');

  const relLines = (relations || [])
    .filter((r) => present.some((p) => p.name === r.from_name || p.id === r.from_name || p.name === r.to_name || p.id === r.to_name))
    .slice(0, 8)
    .map((r) => {
      const senti = typeof r.sentiment === 'number'
        ? (r.sentiment > 0.3 ? '亲近' : r.sentiment < -0.3 ? '敌意' : '微妙')
        : '';
      const bits2 = [r.kind, senti].filter(Boolean).join('·');
      return `· ${r.from_name} → ${r.to_name}${bits2 ? `［${bits2}］` : ''}${r.note ? `：${r.note}` : ''}`;
    });

  const threadLines = (threads || [])
    .filter((t) => t.status === 'open')
    .slice(0, 8)
    .map((t) => `· ${t.title}${t.note ? `（${t.note}）` : ''}${t.weight >= 0.8 ? '［主线］' : ''}`);

  const factLines = (facts || [])
    .slice(0, 6)
    .map((f) => `· ${f.subject} —${f.predicate}→ ${f.object}${f.visibility === 'secret' ? '［引擎掌握，不得说破］' : ''}`);

  const pressure = [];
  if (L.last_hook) pressure.push(`上一轮留下的钩子：${L.last_hook}`);
  const hot = (present || [])
    .filter((c) => c.agenda?.length)
    .sort((a, b) => (b.agenda[0]?.pressure || 0) - (a.agenda[0]?.pressure || 0))[0];
  if (hot) pressure.push(`此刻最绷紧的是${hot.name}：${hot.agenda[0].goal}`);
  if ((threads || []).filter((t) => t.status === 'open').length) {
    pressure.push(`仍未回收的线索有 ${(threads || []).filter((t) => t.status === 'open').length} 条，本轮至少要动其中一条，或制造新的压力。`);
  }

  const knowledgeLine = (present || [])
    .filter((c) => c.knowledge.knows.length || c.knowledge.does_not_know.length)
    .map((c) => {
      const k = c.knowledge.knows.length ? `知道${join(c.knowledge.knows)}` : '';
      const d = c.knowledge.does_not_know.length ? `不知道${join(c.knowledge.does_not_know)}` : '';
      return `${c.name}${[k, d].filter(Boolean).join('，')}`;
    });

  const codexBlock = (codex || []).map((c) => renderCodexEntry(c.entry || c)).join('\n');
  const codexBriefBlock = (codexBrief || []).map((c) => renderCodexBrief(c.entry || c)).join('\n');

  const echoLines = (echoes || [])
    .slice(0, 4)
    .map((e) => `（${e.who ? `${e.who}·` : ''}第${e.turn_no}轮）${e.text}`);

  /* ---- 分段装配，按配额从尾部开始砍 ---- */
  const sections = [];
  if (whenLine) sections.push({ key: 'when', text: whenLine, need: true });
  if (runtimeLine) sections.push({ key: 'world', text: runtimeLine, need: true });
  if (castBlock) sections.push({ key: 'cast', text: `在场\n${castBlock}`, need: true });
  if (relLines.length) sections.push({ key: 'relations', text: `关系\n${relLines.join('\n')}` });
  if (threadLines.length) sections.push({ key: 'threads', text: `未回收的线索\n${threadLines.join('\n')}` });
  if (factLines.length) sections.push({ key: 'facts', text: `已成立的事实\n${factLines.join('\n')}` });
  if (knowledgeLine.length) sections.push({ key: 'knowledge', text: `知识边界\n${knowledgeLine.join('；')}` });
  if (pressure.length) sections.push({ key: 'pressure', text: `压力\n${pressure.join('\n')}` });
  if (codexBlock) sections.push({ key: 'codex', text: `本场可用设定\n${codexBlock}` });
  if (codexBriefBlock) sections.push({ key: 'codexBrief', text: `附近设定（只给一句，展开前先查辞书）\n${codexBriefBlock}` });
  if (echoLines.length) sections.push({ key: 'echoes', text: `回声（过去的原话，可自然带出，不要整段复述）\n${echoLines.join('\n')}` });
  if (directive) sections.push({ key: 'directive', text: `本场指令（作者钦定，优先级最高）\n${directive}` });

  const headerCost = estimateTokens(head.join('\n')) + 2;
  const order = ['when', 'world', 'cast', 'pressure', 'threads', 'facts', 'relations', 'knowledge', 'codex', 'codexBrief', 'directive', 'echoes'];
  const kept = [];
  let used = headerCost;
  for (const key of order) {
    const sec = sections.find((s) => s.key === key);
    if (!sec) continue;
    const cost = estimateTokens(sec.text) + 2;
    if (used + cost <= capTokens) { kept.push(sec); used += cost; continue; }
    // 超配额：按优先级砍——echoes/codex 先降级为截断，其余整段丢
    const room = capTokens - used - 2;
    if (room > 60 && (key === 'codex' || key === 'codexBrief' || key === 'echoes' || key === 'directive')) {
      kept.push({ ...sec, text: truncateToTokens(sec.text, room) });
      used += estimateTokens(sec.text) + 2;
    }
  }

  const keptKeys = new Set(kept.map((s) => s.key));
  meta.kept = kept.map((s) => s.key);
  meta.dropped = sections.filter((s) => !keptKeys.has(s.key)).map((s) => s.key);
  const codexText = kept.find((s) => s.key === 'codex')?.text || '';
  meta.codex_rendered = codexText
    ? codexText.split('\n').filter((line) => line.startsWith('· ')).length
    : 0;
  const briefText = kept.find((s) => s.key === 'codexBrief')?.text || '';
  meta.codex_brief_rendered = briefText
    ? briefText.split('\n').filter((line) => line.startsWith('· ')).length
    : 0;

  const body = kept.map((s) => s.text).join('\n\n');
  const text = body ? `${head.join('\n')}\n\n${body}` : '';
  meta.tokens = estimateTokens(text);
  return { text, meta };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 4. 辞书检索（模型主动取证，不是关键词自动注入）                          */
/* ══════════════════════════════════════════════════════════════════════ */

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * 按查询词在辞书里做确定性匹配，返回可渲染的条目。
 *
 * 这不是「关键词触发注入」：调用方是模型（检索预检/工具），返回结果只活在当拍；
 * 代码不会因为文本里出现某个词就自动把条目塞进上下文。
 *
 * 打分：名字/别名精确 100；互相包含 60；摘要 30；标签 20；facets 10。
 * @returns {Array<{entry: object, score: number, why: string[]}>}
 */
export function lookupCodex(card, queries, { limit = 3 } = {}) {
  const qs = (Array.isArray(queries) ? queries : [queries])
    .map(norm).filter(Boolean);
  if (!qs.length) return [];
  const out = [];
  for (const entry of card?.codex || []) {
    const names = [entry.name, ...(entry.aliases || [])].map(norm).filter(Boolean);
    const summary = norm(entry.summary);
    const detail = norm(entry.detail);
    const tags = (entry.tags || []).map(norm);
    const facets = entry.facets || {};
    const facetText = [
      facets.sensory, facets.history,
      ...(facets.rules || []), ...(facets.consequences || []),
    ].map(norm).filter(Boolean);

    let score = 0;
    const why = [];
    for (const q of qs) {
      if (names.some((n) => n === q)) { score = Math.max(score, 100); if (!why.includes('名称精确')) why.push('名称精确'); }
      else if (names.some((n) => n.includes(q) || q.includes(n))) { score = Math.max(score, 60); if (!why.includes('名称相关')) why.push('名称相关'); }
      if (summary.includes(q) || detail.includes(q)) { score = Math.max(score, Math.max(score, 30)); if (!why.includes('摘要命中')) why.push('摘要命中'); }
      if (tags.some((t) => t.includes(q))) { score = Math.max(score, Math.max(score, 20)); if (!why.includes('标签命中')) why.push('标签命中'); }
      if (facetText.some((t) => t.includes(q))) { score = Math.max(score, Math.max(score, 10)); if (!why.includes('细节命中')) why.push('细节命中'); }
    }
    if (score > 0) out.push({ entry, score, why });
  }
  out.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return out.slice(0, Math.max(1, limit));
}

/** 把一个辞书条目渲染成检索结果块（全文级，不是摘要）。 */
export function renderCodexHit(entry) {
  const lines = [`· ${entry.name}${entry.type ? `（${entry.type}）` : ''}`];
  const seen = new Set();
  // 同一段文字常同时出现在 summary / facets.history / detail 里；按归一化文本去重。
  const push = (prefix, value) => {
    const text = str(value);
    if (!text) return;
    const key = text.replace(/\s+/g, '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    lines.push(`${prefix}${text}`);
  };
  push('  ', entry.summary);
  const f = entry.facets || {};
  if (f.rules?.length) push('  规则：', join(f.rules, '；'));
  if (f.consequences?.length) push('  后果：', join(f.consequences, '；'));
  push('  质感：', f.sensory);
  push('  来历：', f.history);
  push('  细节：', entry.detail);
  if (entry.reveal === 'secret') lines.push('  （引擎掌握，不得说破）');
  return lines.join('\n');
}