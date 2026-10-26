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
  { key: 'place', label: '地点' },
  { key: 'institution', label: '机构' },
  { key: 'faction', label: '势力' },
  { key: 'item', label: '物件' },
  { key: 'concept', label: '概念' },
  { key: 'custom', label: '其他' },
];

const isPerson = (e) => e?.type === 'person';
const personsOf = (card) => (card.entities || []).filter((e) => isPerson(e));
/** 事实实体：非 person 且未被作者静音。静音只在「自动带出」路径生效。 */
const factsOf = (card, skipIds = null) => (card.entities || [])
  .filter((e) => !isPerson(e) && !skipIds?.has(e.id) && !e.muted);

/**
 * 世界索引 = 小说开头那张「人物表」。它不提供细节，只保证模型知道世界上
 * 存在这些东西，不会凭空发明同名实体，也不会把地名写漂。
 *
 * 超预算时的降级顺序：带摘要 → 只留名字 → 末尾省略。
 */
export function renderWorldIndex(card, capTokens = 1200, { skipIds = null } = {}) {
  const persons = personsOf(card);
  const facts = factsOf(card, skipIds);
  if (!persons.length && !facts.length) return '';

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

  const personItems = persons
    .slice()
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .map((c) => {
      // 索引只承载 canon（这个人是谁）；受伤/死亡/失势等运行态由场记单负责。
      return { name: c.name, summary: c.role || c.summary || '' };
    });
  pushGroup('人物', personItems);

  for (const g of TYPE_GROUPS) {
    const items = facts
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
 * @param {{skipIds?:Set<string>}} opts
 */
export function renderWorldTree(card, capTokens = 1200, { skipIds = null } = {}) {
  const facts = factsOf(card, skipIds);
  const hasParent = facts.some((e) => e.parent_id);
  if (!hasParent) return renderWorldIndex(card, capTokens, { skipIds });

  const header = '【世界索引】这个世界上已存在的人物与事物。它们只说明「有什么」，'
    + '不说明「此刻如何」——细节以场记单为准。不得发明索引之外的重要实体，'
    + '不得改写这些名字。';

  const byKey = new Map();
  for (const e of facts) {
    byKey.set(e.id, e);
    byKey.set(e.name, e);
    for (const a of e.aliases || []) byKey.set(a, e);
  }
  const children = new Map();
  const roots = [];
  for (const e of facts) {
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
  // 索引只承载 canon，不标注「当前地点」——那是运行态，会破坏前缀缓存，也误导模型的「此刻」判断。
  const label = (e) => `${e.name}${e.summary ? `（${e.summary}）` : ''}`;

  const buildLines = (withSummary) => {
    const lines = [];
    const persons = personsOf(card).slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
    if (persons.length) {
      // 索引只承载 canon。status 是运行态（史官会写「左肩中箭」这类），
      // 一旦渲染进 system，卡上有 parent_id 时 system 就每轮失效——而平铺卡不会，
      // 于是「会不会破坏缓存」取决于卡的形状，比稳定地坏更糟。
      lines.push(`人物　${join(persons.map((c) => {
        const s = c.role || c.summary || '';
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
      if (g.key === 'place' || g.key === 'institution' || g.key === 'faction') continue;
      const items = facts.filter((e) => e.type === g.key && !isTree(e));
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
/* 1.5 前史（开局之前已经发生的事实）                                      */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 前史 = 模板卡 timeline 里 canon === 'past' 的事件，作为 canon 进 system。
 *
 * 只读模板快照，不读账本：system 必须逐字节冻结（AGENTS §6.2），
 * 运行期新增的事件是演出结果，不是「开局前就该成立的事实」。
 * canon === 'future'（原著后续）与 'branch' 永不渲染——红线 3：它们既不是
 * 既定事实，也不是演绎目标，只给作者看。
 *
 * 预算：从最新往前取。离开局越近的前史越影响人物此刻的处境；远到塞不下的
 * 旧事整条丢弃，不把一句话切半（半句话进提示词比没有更坏）。
 */
export function renderTimelinePast(card, capTokens = 240) {
  const events = (card.timeline || []).filter((e) => e.canon === 'past' && str(e.what));
  if (!events.length) return { text: '', meta: { count: 0, rendered: 0, tokens: 0, dropped: 0 } };

  const header = '【前史】开局之前已经发生的事实（既定设定）。据此理解人物处境，不必在对话里复述。';
  const line = (e) => {
    const when = str(e.when);
    const where = str(e.where);
    return `· ${when ? `${when} · ` : ''}${str(e.what)}${where ? `（${where}）` : ''}`;
  };

  const picked = [];
  let used = estimateTokens(header) + 2;
  let dropped = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const l = line(events[i]);
    const cost = estimateTokens(l) + 1;
    if (used + cost > capTokens) { dropped = i + 1; break; }
    picked.unshift(l);
    used += cost;
  }
  if (!picked.length) {
    return { text: '', meta: { count: events.length, rendered: 0, tokens: 0, dropped: events.length } };
  }
  const text = `${header}\n${picked.join('\n')}`;
  return { text, meta: { count: events.length, rendered: picked.length, tokens: estimateTokens(text), dropped } };
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
  // 只在「事实实体」里选：人物由在场判定带出，不做设定集条目。
  for (const entry of (card.entities || [])) {
    if (isPerson(entry)) continue;
    if (skipIds?.has(entry.id)) continue;
    // 静音优先于钉选：作者关掉自动进场后，不该再被「钉选无条件 +100」偷偷带回来。
    if (entry.muted) continue;
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
  // 外形与性格：作者写在卡里的稳定形象锚点，每场随在场者带出。
  // 只给「这一场要记住的长相、身份与脾气」；背景故事留在世界索引与检索里，
  // 不在这里展开——场记单是当拍事实，不是人物小传。
  const look = str(c.identity?.appearance);
  const station = str(c.identity?.station);
  const shape = [
    look ? `外形：${truncateToTokens(look, 36)}` : '',
    station ? `身份：${truncateToTokens(station, 12)}` : '',
  ].filter(Boolean);
  if (shape.length) lines.push(`  ${join(shape, '；')}`);
  if (c.psyche?.traits?.length) {
    lines.push(`  性格：${truncateToTokens(join(c.psyche.traits.slice(0, 4), '、'), 24)}`);
  }
  // 称呼 + 绝不说：这是抗 OOC 最便宜的两条确定性约束。
  // 「他绝不会叫她『夫人』」比一整段性格描写更能防止人物崩坏。
  if (c.voice.address && Object.keys(c.voice.address).length) {
    const addr = Object.entries(c.voice.address)
      .map(([to, how]) => `${to}→${how}`).join('；');
    if (addr) lines.push(`  称呼：${addr}`);
  }
  if (c.voice.never?.length) lines.push(`  绝不说：${join(c.voice.never, '／')}`);
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
  // 原声按「规范名」存（voices.who 是 canon 名），但卡司条目可能是 id，
  // 两个键都要查，否则原声永远匹配不到（旧实现只查 id，导致 voices 传了也白传）。
  const v = voices?.[c.id] || voices?.[c.name];
  if (v?.length) lines.push(`  原声：${join(v.slice(0, 2), '／')}`);
  return lines.join('\n');
}

/** 紧凑档：名字（身份）+ 一句状态 + 口吻。人群场用。 */
function renderCastCompact(c, ledgerChar) {
  const condition = ledgerChar?.condition || c.condition;
  const mood = ledgerChar?.mood || c.mood;
  const location = ledgerChar?.location || c.location;
  const state = [condition, mood, location ? `@${location}` : '',
    c.status && c.status !== '临时登场' ? c.status : ''].filter(Boolean);
  const tail = [state.length ? join(state, '｜') : '', str(c.voice?.rhythm)].filter(Boolean).join('；');
  return `· ${c.name}${c.role ? `（${c.role}）` : ''}${tail ? `：${tail}` : ''}`;
}

/** 最低档：只留名字 + 此刻状态。「谁在场」是这一层唯一不能丢的信息。 */
function renderCastMinimal(c, ledgerChar) {
  const condition = ledgerChar?.condition || c.condition;
  const mood = ledgerChar?.mood || c.mood;
  const location = ledgerChar?.location || c.location;
  const state = [condition, mood, location ? `@${location}` : ''].filter(Boolean);
  return `· ${c.name}${state.length ? `（${state.join('｜')}）` : ''}`;
}

/**
 * 已故 / 离场一行：只解释「名单里为什么少了一个人」，不展开小传。
 * 运行态生死由 world_state 的 life_state 投影而来；不是名单里每个死者都值得占位，
 * 所以最多 3 人 + 计数，且跟着在场段一起取舍。
 */
function renderAbsentLine(absentees = []) {
  const list = (absentees || []).filter((a) => a && a.name);
  if (!list.length) return '';
  const shown = list.slice(0, 3).map((a) => {
    const kind = a.state === 'gone' ? '已离场' : '已故';
    const note = str(a.note) ? `：${truncateToTokens(str(a.note), 18)}` : '';
    return `${a.name}（${kind}${note}）`;
  });
  return `已故／离场：${shown.join('；')}${list.length > 3 ? ` 等 ${list.length} 人` : ''}`;
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

/**
 * 按整条条目裁剪：超预算时从末尾整条丢弃，绝不切半条。
 * 第一行是段落标题，后续条目由 entryStart 开头（codex 是「· 」，回声是「（」）。
 */
function fitEntries(text, maxTokens, entryStart = '· ') {
  if (!text) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split('\n');
  const header = lines[0] || '';
  const entries = [];
  let cur = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith(entryStart) && cur.length) {
      entries.push(cur.join('\n'));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) entries.push(cur.join('\n'));

  const kept = [];
  for (const entry of entries) {
    const candidate = [header, ...kept, entry].join('\n');
    if (estimateTokens(candidate) + 2 > maxTokens) break;
    kept.push(entry);
  }
  return kept.length ? [header, ...kept].join('\n') : '';
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
 * @param {Array}  args.rumors     世界呼吸推演的幕外流言 [{who,what,visibility}]
 * @param {string} args.directive   用户的本场指令
 * @param {number} args.capTokens
 * @returns {{text:string, meta:object}}
 */
export function renderSceneSheet({
  ledger = {}, present = [], relations = [], threads = [], codex = [], codexBrief = [],
  voices = {}, echoes = [], facts = [], worldRuntime = {}, playerNow = null,
  knowledgeMatrix = null, omens = null, rumors = [], directive = '', absentees = [], capTokens = 2200,
} = {}) {
  const L = ledger || {};
  const meta = {
    present: present.length,
    codex: codex.length,
    codex_brief: codexBrief.length,
    echoes: echoes.length,
    facts: facts.length,
    rumors: (rumors || []).length,
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

  // 主角的运行态放在这里，而不是 system：system 是 canon（他是谁），
  // 这里才是「他此刻如何」。放在 system 会让缓存前缀每轮失效。
  // 注意 situation 与 system 的「来路」是同名字段：system 用模板值讲出身，
  // 这里用投影后的现值讲此刻，两者不会同时渲染同一份文本。
  const playerBits = [];
  if (playerNow) {
    const p = playerNow;
    if (p.status) playerBits.push(`处境 ${str(p.status)}`);
    if (p.situation) playerBits.push(`眼下 ${str(p.situation)}`);
    if (p.condition) playerBits.push(`身体 ${str(p.condition)}`);
    if (p.mood) playerBits.push(`情绪 ${str(p.mood)}`);
    if (p.location) playerBits.push(`所在 ${str(p.location)}`);
    if (p.goal) playerBits.push(`当下想要 ${str(p.goal)}`);
  }
  const playerLine = playerBits.length ? `主角此刻：${playerBits.join('｜')}` : '';

  const castFull = present.map((c) => renderCastLine(c, L.characters?.[c.id], voices)).join('\n');
  const castCompact = present.map((c) => renderCastCompact(c, L.characters?.[c.id])).join('\n');
  const castMinimal = present.map((c) => renderCastMinimal(c, L.characters?.[c.id])).join('\n');
  const absentLine = renderAbsentLine(absentees);
  const castBody = (body) => [body ? `在场\n${body}` : '', absentLine].filter(Boolean).join('\n');

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
    .slice(0, 24)
    .map((f) => `· ${f.subject} —${f.predicate}→ ${f.object}${f.visibility === 'secret' ? '［引擎掌握，不得说破］' : ''}`);

  const pressure = [];
  if (L.last_hook) pressure.push(`上一轮留下的钩子：${L.last_hook}`);
  const hot = (present || [])
    .filter((c) => c.agenda?.length)
    .sort((a, b) => (b.agenda[0]?.pressure || 0) - (a.agenda[0]?.pressure || 0))[0];
  if (hot) pressure.push(`此刻最绷紧的是${hot.name}：${hot.agenda[0].goal}`);
  // 成长曲线的预兆：写「倾向」，不写「结局」。
  // 它复用压力段（不新增注入通道），且只对已解锁阶段生效。
  for (const o of (omens || []).slice(0, 2)) {
    pressure.push(`${o.who}正在往「${o.text}」的方向变`);
  }
  // 世界呼吸在切场时推演出的幕外动静：这是「这段时间世界上发生了什么」的可见面，
  // 只以听来的/看见的流言形态出现（hidden 事件在装配层就被挡掉，永不外泄）。
  for (const r of (rumors || []).slice(0, 2)) {
    pressure.push(`幕外：${r.who}${r.what}`);
  }
  if ((threads || []).filter((t) => t.status === 'open').length) {
    pressure.push(`仍未回收的线索有 ${(threads || []).filter((t) => t.status === 'open').length} 条，本轮至少要动其中一条，或制造新的压力。`);
  }

  // 知识边界优先用「按线索组织」的矩阵（谁知道/谁不知道同一件事），
  // 退回按角色罗列。前者直接回答「这一拍谁不能说什么」。
  const knowledgeLine = (knowledgeMatrix && knowledgeMatrix.length)
    ? knowledgeMatrix
    : (present || [])
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

  /* ---- 分段装配：可选段落整条取舍，不做半句截断 ---- */
  const sections = [];
  if (whenLine) sections.push({ key: 'when', text: whenLine, need: true });
  if (runtimeLine) sections.push({ key: 'world', text: runtimeLine, need: true });
  if (playerLine) sections.push({ key: 'player', text: playerLine, need: true });
  // 在场段是「这一刻」的骨架，但站的人多时不能整段丢：先降级到紧凑/只留名字。
  // 人群场（宴席/朝堂）先牺牲的必须是可选设定，不是在场者。
  const castVariants = [];
  if (castFull) {
    castVariants.push({ mode: 'full', text: castBody(castFull) });
    if (castCompact !== castFull) castVariants.push({ mode: 'compact', text: castBody(castCompact) });
    if (castMinimal !== castCompact) castVariants.push({ mode: 'minimal', text: castBody(castMinimal) });
  } else if (absentLine) {
    castVariants.push({ mode: 'minimal', text: absentLine });
  }
  if (castVariants.length) {
    sections.push({ key: 'cast', text: castVariants[0].text, need: true, variants: castVariants });
  }
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
  // directive 声明「优先级最高」，就必须排在可选设定之前；放不下时它还能靠尾注通道活下来。
  // 主角运行态必须紧跟时间地点（它是「此刻」的一部分），不能被裁掉。
  const order = ['when', 'world', 'player', 'cast', 'directive', 'pressure', 'threads', 'facts', 'relations', 'knowledge', 'codex', 'codexBrief', 'echoes'];
  // 「此刻」骨架先占位：它们在第一轮吃预算，可选段只能在剩下的空间里排。
  // 旧实现按 order 一次过，人群场会先丢在场段、给后面的设定/知识/关系腾地方——
  // 9 人同场时旁白会失去全部人物锚点，而知识边界和辞书反而回来，优先级是反的。
  const NEED_KEYS = new Set(['when', 'world', 'player', 'cast']);
  const kept = [];
  const dropped = [];
  let used = headerCost;
  let castMode = null;

  for (const key of order) {
    if (!NEED_KEYS.has(key)) continue;
    const sec = sections.find((s) => s.key === key);
    if (!sec) continue;
    if (!sec.variants) {
      const cost = estimateTokens(sec.text) + 2;
      if (used + cost <= capTokens) { kept.push(sec); used += cost; } else dropped.push(key);
      continue;
    }
    // 在场段按档位挑：第一个装得下的；都装不下就把最低档裁到剩余空间
    // （只可能发生在极小预算，正常人群场只需降到「只留名字」）。
    let chosen = sec.variants.find((v) => used + estimateTokens(v.text) + 2 <= capTokens);
    if (!chosen) {
      const room = capTokens - used - 2;
      const minimal = sec.variants[sec.variants.length - 1];
      chosen = room > 8
        ? { mode: `${minimal.mode}_trunc`, text: truncateToTokens(minimal.text, room) }
        : null;
    }
    if (!chosen) { dropped.push(key); continue; }
    castMode = chosen.mode;
    kept.push({ key, text: chosen.text });
    used += estimateTokens(chosen.text) + 2;
  }

  for (const key of order) {
    if (NEED_KEYS.has(key)) continue;
    const sec = sections.find((s) => s.key === key);
    if (!sec) continue;
    const cost = estimateTokens(sec.text) + 2;
    if (used + cost <= capTokens) { kept.push(sec); used += cost; continue; }

    const room = capTokens - used - 2;
    if (room <= 60) { dropped.push(key); continue; }
    // 辞书/回声按整条取舍：宁可少一条，也不留下半条设定。
    const fitted = (key === 'codex' || key === 'codexBrief' || key === 'echoes')
      ? fitEntries(sec.text, room, key === 'echoes' ? '（' : '· ')
      : '';
    if (fitted) {
      kept.push({ ...sec, text: fitted });
      used += estimateTokens(fitted) + 2;
    } else {
      // 其余段落整段丢弃；不截半句。
      dropped.push(key);
    }
  }

  meta.kept = kept.map((s) => s.key);
  meta.dropped = dropped;
  meta.cast_mode = castMode;
  meta.absentees = (absentees || []).length;
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
  // 检索覆盖全部实体（含人物）：模型问「凌玥是谁」时，人物条目也要能查全文。
  for (const entry of card?.entities || []) {
    const names = [entry.name, ...(entry.aliases || [])].map(norm).filter(Boolean);
    const summary = norm(entry.summary);
    const detail = norm(entry.detail);
    const tags = (entry.tags || []).map(norm);
    const facets = entry.facets || {};
    const facetText = [
      facets.sensory, facets.history,
      ...(facets.rules || []), ...(facets.consequences || []),
      isPerson(entry) ? [entry.identity?.appearance, entry.identity?.background,
        ...(entry.psyche?.traits || []), ...(entry.psyche?.wants || [])].filter(Boolean).join(' ') : '',
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

/* ══════════════════════════════════════════════════════════════════════ */
/* 5. 场次索引（长程记忆的载体）                                            */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 场次索引：一行一场，只追加，永不互相改写。
 *
 * 这是「滚动摘要」的替代品。摘要把全部历史摊薄成一份定长文本，
 * 而场次索引给每条历史一个等宽的槽位：第 12 轮的事不会因为第 900 轮
 * 又压了一次而变模糊。
 *
 * 渲染是**确定性的**：只按 importance 与位置决定粒度，不做语义打分。
 *   major  → 编号｜轮次｜地点｜问题｜结果｜细节｜钩子
 *   normal → 编号｜轮次｜地点｜问题｜结果
 *   minor  → 编号｜轮次｜地点｜结果首句
 *
 * 超预算时从**最旧**端开始降级（老场的细节先让位给近场），而不是整段砍掉。
 *
 * @param {Array}  scenes   已按 turn_from 正序
 * @param {number} capTokens
 * @returns {{text:string, meta:{total:number, rendered:number, dropped:number, degraded:number}}}
 */
export function renderSceneIndex(scenes = [], capTokens = 1800) {
  const list = (scenes || []).filter((s) => s && Number.isFinite(Number(s.turn_from)));
  const meta = { total: list.length, rendered: 0, dropped: 0, degraded: 0 };
  if (!list.length) return { text: '', meta };

  const header = '【本局场次索引】下面是这一局已经发生过的每一场，按时间顺序。'
    + '它是既定事实的目录：需要更早的细节时，先看这里的锚点，不要凭空补全，也不要改写已经写过的结果。';

  const turnLabel = (s) => (s.turn_from === s.turn_to ? `${s.turn_from}` : `${s.turn_from}-${s.turn_to}`);
  const firstSentence = (t) => {
    const s = str(t);
    const i = s.search(/[。；！？]/);
    return i > 0 ? s.slice(0, i + 1) : s;
  };

  const renderOne = (s, level) => {
    const head = `${s.scene_id || 'S?'}｜${turnLabel(s)}｜${str(s.place) || '（未记地点）'}`;
    if (level === 'minor') return `${head}｜${firstSentence(s.outcome)}`;
    const bits = [head];
    if (str(s.question)) bits.push(str(s.question));
    if (str(s.outcome)) bits.push(str(s.outcome));
    if (level !== 'major') return bits.join('｜');
    if (str(s.key_detail)) bits.push(`细节：${str(s.key_detail)}`);
    if ((s.hooks || []).length) bits.push(`钩子：${s.hooks.join('；')}`);
    return bits.join('｜');
  };

  // 先按「自然粒度」渲染；放不下就把最古老的降一级，直到装得下。
  const levels = list.map((s) => (s.importance === 'minor' ? 'minor'
    : s.importance === 'major' ? 'major' : 'normal'));
  const build = () => `${header}\n${list.map((s, i) => renderOne(s, levels[i])).join('\n')}`;

  let text = build();
  let guard = 0;
  const downgrade = { major: 'normal', normal: 'minor' };
  while (estimateTokens(text) > capTokens && guard++ < list.length * 3) {
    // 找最旧的一个还能降级的场次
    const idx = levels.findIndex((lv) => downgrade[lv]);
    if (idx < 0) break;
    levels[idx] = downgrade[levels[idx]];
    meta.degraded++;
    text = build();
  }

  // 还放不下：从最旧端整行丢弃（保留头部的说明，让模型知道索引被截短了）。
  if (estimateTokens(text) > capTokens) {
    const lines = text.split('\n');
    while (lines.length > 2 && estimateTokens(lines.join('\n')) > capTokens) {
      lines.splice(1, 1);
      meta.dropped++;
    }
    lines.splice(1, 0, `（更早的 ${meta.dropped} 场已省略）`);
    text = lines.join('\n');
  }

  meta.rendered = list.length - meta.dropped;
  return { text, meta };
}

/**
 * 最近 1–2 场的细节块：放在原文窗口之后、场记单之前。
 * 索引给「目录」，这里给「刚才那场到底怎么收的」，两者粒度不同、位置不同。
 */
export function renderRecentScenes(scenes = [], capTokens = 900) {
  const list = (scenes || []).slice(-2);
  if (!list.length) return { text: '', meta: { rendered: 0 } };
  const blocks = list.map((s) => {
    const lines = [`· ${s.scene_id || 'S?'}｜第 ${s.turn_from}-${s.turn_to} 轮｜${str(s.place)}`];
    if (str(s.question)) lines.push(`  这一场在问：${str(s.question)}`);
    if (str(s.outcome)) lines.push(`  结果：${str(s.outcome)}`);
    if (str(s.key_detail)) lines.push(`  记住这个：${str(s.key_detail)}`);
    if (str(s.causal)) lines.push(`  为什么走到这里：${str(s.causal)}`);
    if ((s.hooks || []).length) lines.push(`  还悬着：${s.hooks.join('；')}`);
    return lines.join('\n');
  });
  let text = `【刚才这一场怎么收的】作为接续的起点，不要复述。\n${blocks.join('\n')}`;
  if (estimateTokens(text) > capTokens) text = truncateToTokens(text, capTokens);
  return { text, meta: { rendered: list.length } };
}

/** 把一个辞书条目渲染成检索结果块（全文级，不是摘要）。 */
export function renderCodexHit(entry) {
  const person = isPerson(entry);
  const lines = [`· ${entry.name}${entry.type ? `（${person ? '人物' : entry.type}）` : ''}`];
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
  if (person) {
    const id = entry.identity || {};
    if (str(id.age)) push('  年龄：', id.age);
    if (str(id.appearance)) push('  外貌：', id.appearance);
    if (str(id.station)) push('  身份：', id.station);
    if (str(id.background)) push('  背景：', id.background);
    if (entry.psyche?.traits?.length) push('  性格：', entry.psyche.traits.join('、'));
    if (entry.voice?.rhythm) push('  口吻：', entry.voice.rhythm);
    if (entry.voice?.never?.length) push('  绝不说：', entry.voice.never.join('／'));
    if (entry.psyche?.hides?.length) push('  藏着：', entry.psyche.hides.join('；'));
    if (entry.agenda?.length) {
      push('  私心：', entry.agenda.map((a) => a.goal).filter(Boolean).join('；'));
    }
    if (entry.knowledge?.knows?.length) push('  知道：', entry.knowledge.knows.join('、'));
    if (entry.knowledge?.does_not_know?.length) push('  不知道：', entry.knowledge.does_not_know.join('、'));
  }
  const f = entry.facets || {};
  if (f.rules?.length) push('  规则：', join(f.rules, '；'));
  if (f.consequences?.length) push('  后果：', join(f.consequences, '；'));
  push('  质感：', f.sensory);
  push('  来历：', f.history);
  push('  细节：', entry.detail);
  if (entry.reveal === 'secret') lines.push('  （引擎掌握，不得说破）');
  return lines.join('\n');
}