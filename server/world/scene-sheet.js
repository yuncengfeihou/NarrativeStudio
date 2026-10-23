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
export function renderWorldIndex(card, capTokens = 1200) {
  const cast = card.cast || [];
  const codex = card.codex || [];
  if (!cast.length && !codex.length) return '';

  const header = '【世界索引】这个世界上已存在的人物与事物。它们只说明「有什么」，';
    + '不说明「此刻如何」——细节以场记单为准。不得发明索引之外的重要实体，';
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
    .map((c) => ({ name: c.name, summary: c.role || c.one_line }));
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
export function selectCodex(card, { presentIds = [], mentionedIds = [], threadTags = [], pinnedIds = [] } = {}) {
  const linkSet = new Set([...presentIds, ...mentionedIds, ...pinnedIds]);
  const tagSet = new Set((threadTags || []).filter(Boolean));
  const out = [];
  for (const entry of card.codex || []) {
    const why = [];
    let score = 0;
    if (entry.pinned) { score += 100; why.push('钉选'); }
    if (entry.links?.some((l) => linkSet.has(l))) { score += 60; why.push('实体在场'); }
    if (tagSet.size && entry.tags?.some((t) => tagSet.has(t))) { score += 30; why.push('本场主题'); }
    if (entry.type === 'place' && presentIds.includes(entry.id)) { score += 20; why.push('当前地点'); }
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
  const state = [ledgerChar?.condition, ledgerChar?.mood, ledgerChar?.location ? `@${ledgerChar.location}` : '']
    .filter(Boolean);
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
  return lines.join('\n');
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
  ledger = {}, present = [], relations = [], threads = [], codex = [],
  voices = {}, echoes = [], directive = '', capTokens = 2200,
} = {}) {
  const L = ledger || {};
  const meta = { present: present.length, codex: codex.length, echoes: echoes.length };
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

  const echoLines = (echoes || [])
    .slice(0, 4)
    .map((e) => `（${e.who ? `${e.who}·` : ''}第${e.turn_no}轮）${e.text}`);

  /* ---- 分段装配，按配额从尾部开始砍 ---- */
  const sections = [];
  if (whenLine) sections.push({ key: 'when', text: whenLine, need: true });
  if (castBlock) sections.push({ key: 'cast', text: `在场\n${castBlock}`, need: true });
  if (relLines.length) sections.push({ key: 'relations', text: `关系\n${relLines.join('\n')}` });
  if (threadLines.length) sections.push({ key: 'threads', text: `未回收的线索\n${threadLines.join('\n')}` });
  if (knowledgeLine.length) sections.push({ key: 'knowledge', text: `知识边界\n${knowledgeLine.join('；')}` });
  if (pressure.length) sections.push({ key: 'pressure', text: `压力\n${pressure.join('\n')}` });
  if (codexBlock) sections.push({ key: 'codex', text: `本场可用设定\n${codexBlock}` });
  if (echoLines.length) sections.push({ key: 'echoes', text: `回声（过去的原话，可自然带出，不要整段复述）\n${echoLines.join('\n')}` });
  if (directive) sections.push({ key: 'directive', text: `本场指令（作者钦定，优先级最高）\n${directive}` });

  const headerCost = estimateTokens(head.join('\n')) + 2;
  const order = ['when', 'cast', 'pressure', 'threads', 'relations', 'knowledge', 'directive', 'codex', 'echoes'];
  const kept = [];
  let used = headerCost;
  for (const key of order) {
    const sec = sections.find((s) => s.key === key);
    if (!sec) continue;
    const cost = estimateTokens(sec.text) + 2;
    if (used + cost <= capTokens) { kept.push(sec); used += cost; continue; }
    // 超配额：按优先级砍——echoes/codex 先降级为截断，其余整段丢
    const room = capTokens - used - 2;
    if (room > 60 && (key === 'codex' || key === 'echoes' || key === 'directive')) {
      kept.push({ ...sec, text: truncateToTokens(sec.text, room) });
      used += estimateTokens(sec.text) + 2;
    }
  }

  const body = kept.map((s) => s.text).join('\n\n');
  const text = body ? `${head.join('\n')}\n\n${body}` : '';
  meta.tokens = estimateTokens(text);
  return { text, meta };
}