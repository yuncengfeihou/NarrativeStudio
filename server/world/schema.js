/**
 * server/world/schema.js — 世界卡 v5：结构化提示词的数据形状
 *
 * 设计原则（详见 docs/CONTRACTS.md「世界卡 v5」）：
 *   1. 卡描述世界，不描述故事。没有幕、没有必达节拍、没有忌避清单。
 *   2. canon 与 destiny 分离：timeline 里 past 是既定事实，future 只是原著参考，默认不注入。
 *   3. 实体（entity）是唯一的世界构成单位，靠 links / tags / 在场进场，不靠关键词触发。
 *      人物（type='person'）与世界事实（place/institution/item/faction/concept/custom）共用
 *      一个命名空间、一套别名索引、一套 id；区别只在字段分派与渲染方式。
 *   4. 每个字段都可缺省。最小卡只要 premise + player + opening 三样就能玩。
 *   5. 三种来源：original（原创）/ adapted（小说抽取）/ remix（混编）。
 *
 * 本模块只做形状归一与纯函数推导，不碰存储、不调 LLM。
 */
const CARD_VERSION = 5;

/** 实体类型。`person` 有 voice/psyche/agenda/relations；其余都是「世界事实」。 */
export const ENTITY_TYPES = ['person', 'place', 'institution', 'item', 'faction', 'concept', 'custom'];
export const PERSON_TYPE = 'person';
const FACT_TYPES = new Set(ENTITY_TYPES.filter((t) => t !== PERSON_TYPE));
const ENTITY_REVEALS = ['public', 'rumor', 'secret'];

/** 观察一个实体条目是不是人物。 */
export const isPerson = (entity) => entity?.type === PERSON_TYPE;

/** 观察一个实体条目是不是世界事实（非人物）。 */
const isFact = (entity) => FACT_TYPES.has(entity?.type);

/* ══════════════════════════════════════════════════════════════════════ */
/* 小工具                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const asStringArray = (v) => asArray(v)
  .filter((x) => typeof x === 'string' && x.trim())
  .map((x) => x.trim());
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp01 = (v, d = 0.5) => Math.max(0, Math.min(1, num(v, d)));

/** 把中文名/标题转成可用作 id 的短横线串。 */
export function slugify(name) {
  const s = str(name)
    .replace(/[\s，。、；：？！""''（）()《》【】「」『』·…—\-]/g, '')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
  return s || 'x';
}

/** 在 id 集合里保证唯一。 */
function uniqueId(base, taken) {
  let id = base;
  let i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  taken.add(id);
  return id;
}

function normalizeType(raw, fallback = 'custom') {
  const t = str(raw);
  return ENTITY_TYPES.includes(t) ? t : fallback;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 归一化                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

function normalizePrompt(raw) {
  const p = obj(raw);
  return {
    premise: str(p.premise),
    tone: asStringArray(p.tone),
    style_guide: str(p.style_guide),
    narrator_notes: str(p.narrator_notes),
    bans: asStringArray(p.bans),
    pov: str(p.pov) || '第三人称限知，镜头贴在主角身上',
    // 篇幅是作者可选项：留空 = 不限定字数，由这一拍的内容需要决定。
    // 引擎不再给默认区间，避免把「篇幅」变成填充任务。
    length: str(p.length),
    tense: str(p.tense) || '过去时叙述',
  };
}

/**
 * 卡级默认工艺（可选）。
 *
 * 只存三个取值 id，不存正文——正文的唯一主人在 `server/world/craft.js` 的当前表。
 * 卡里写的是「这张卡默认用什么写法」，取值被作者在设置页删掉时由
 * `resolveCraft()` 回落到程序默认（不在这里判定合法性：schema 是纯形状层，
 * 不该知道当前有哪些取值）。
 */
function normalizeCardCraft(raw) {
  const c = obj(raw);
  const out = {};
  for (const [key, alias] of [['craft_preset', 'preset'], ['craft_dialogue', 'dialogue'], ['pacing', 'pacing']]) {
    const v = str(c[key] ?? c[alias]);
    if (v) out[key] = v;
  }
  return out;
}

function normalizeCharter(raw) {
  return asArray(raw)
    .map((c) => {
      if (typeof c === 'string') return { rule: c.trim(), kind: 'law' };
      const o = obj(c);
      return { rule: str(o.rule || o.text), kind: str(o.kind) || 'law' };
    })
    .filter((c) => c.rule);
}

function normalizeFacets(raw) {
  const f = obj(raw);
  return {
    sensory: str(f.sensory),
    rules: asStringArray(f.rules),
    consequences: asStringArray(f.consequences),
    history: str(f.history),
  };
}

function normalizeSources(raw) {
  return asArray(raw)
    .map((s) => {
      const x = obj(s);
      return {
        kind: str(x.kind),
        ref: str(x.ref),
        title: str(x.title),
        chapter: num(x.chapter, 0),
        offset: num(x.offset, 0),
        quote: str(x.quote),
        turn_no: num(x.turn_no, 0),
      };
    })
    .filter((s) => s.kind || s.ref || s.title || s.quote);
}

function normalizeAgenda(raw) {
  return asArray(raw)
    .map((a) => {
      const g = obj(a);
      const goal = str(g.goal);
      if (!goal) return null;
      return {
        goal,
        method: str(g.method),
        pressure: clamp01(g.pressure, 0.5),
        deadline: str(g.deadline),
      };
    })
    .filter(Boolean);
}

function normalizeRelations(raw) {
  return asArray(raw)
    .map((r) => {
      const g = obj(r);
      const to = str(g.to);
      if (!to) return null;
      return { to, kind: str(g.kind), sentiment: Math.max(-1, Math.min(1, num(g.sentiment, 0))), note: str(g.note) };
    })
    .filter(Boolean);
}

/** 人物专属字段：身份、口吻、动机、知识、议程、关系。 */
function normalizePersonFields(o) {
  const voice = obj(o.voice);
  const psyche = obj(o.psyche);
  const knowledge = obj(o.knowledge);
  const identity = obj(o.identity);
  return {
    // 运行期状态字段允许写在卡里作为初始值；会话世界线会覆盖它们。
    status: str(o.status),
    condition: str(o.condition),
    mood: str(o.mood),
    location: str(o.location),
    goal: str(o.goal),
    role: str(o.role),
    identity: {
      age: str(identity.age),
      appearance: str(identity.appearance),
      background: str(identity.background),
      station: str(identity.station),
    },
    voice: {
      address: obj(voice.address),
      rhythm: str(voice.rhythm),
      lexicon: asStringArray(voice.lexicon),
      never: asStringArray(voice.never),
      exemplars: asStringArray(voice.exemplars).slice(0, 6),
    },
    psyche: {
      // 性格是「稳定的行为倾向」，与想要/害怕/藏着/在意分开：
      // 前四者是动机，traits 是外显的脾气与处事方式，场记单会渲染它。
      traits: asStringArray(psyche.traits),
      wants: asStringArray(psyche.wants),
      fears: asStringArray(psyche.fears),
      hides: asStringArray(psyche.hides),
      values: asStringArray(psyche.values),
    },
    knowledge: {
      knows: asStringArray(knowledge.knows),
      does_not_know: asStringArray(knowledge.does_not_know),
      believes_falsely: asStringArray(knowledge.believes_falsely),
    },
    agenda: normalizeAgenda(o.agenda),
    relations: normalizeRelations(o.relations),
    always_present: !!o.always_present,
    weight: clamp01(o.weight, 0.5),
  };
}

/** 世界事实专属字段：可及性、归属、运行期位置的初始值。 */
function normalizeFactFields(o) {
  return {
    status: str(o.status),
    condition: str(o.condition),
    access: str(o.access),
    open_to: str(o.open_to),
    owner_id: str(o.owner_id),
    location_id: str(o.location_id),
  };
}

/**
 * 归一化一条实体。人物与事实共用公共字段，只按 type 追加各自的字段。
 * id 在整张卡里唯一（人物与事实共享命名空间）。
 */
function normalizeEntity(raw, taken) {
  const o = obj(raw);
  const name = str(o.name);
  const summary = str(o.summary);
  if (!name && !summary) return null;
  const type = normalizeType(o.type);
  const id = str(o.id) || uniqueId(slugify(name || summary.slice(0, 8)), taken);
  if (str(o.id)) {
    if (taken.has(id)) return null; // 同一张卡里 id 必须唯一；重复条目直接丢掉，交给 lint 报
    taken.add(id);
  }
  const entry = {
    id,
    type,
    name: name || summary.slice(0, 12),
    aliases: asStringArray(o.aliases),
    tags: asStringArray(o.tags),
    summary,
    detail: str(o.detail),
    facets: normalizeFacets(o.facets),
    links: asStringArray(o.links),
    reveal: ENTITY_REVEALS.includes(o.reveal) ? o.reveal : 'public',
    canon_from: str(o.canon_from),
    sources: normalizeSources(o.sources),
    pinned: !!o.pinned,
    // 静音：作者明确「不要自动进场」。它仍留在卡里可被模型主动检索，
    // 但世界索引与场记单候选都不再自动渲染它；静音优先于钉选，避免两个开关互相打脸。
    muted: !!o.muted,
    // 包含关系与来源（可选）。没有时由 graph 层从 links/relations 推导。
    parent_id: str(o.parent_id),
  };
  return type === PERSON_TYPE
    ? { ...entry, ...normalizePersonFields(o) }
    : { ...entry, ...normalizeFactFields(o) };
}

function normalizeEntities(raw) {
  const taken = new Set();
  return asArray(raw)
    .map((e) => normalizeEntity(e, taken))
    .filter(Boolean);
}

function normalizeTimeline(raw) {
  const taken = new Set();
  return asArray(raw)
    .map((e) => {
      const o = obj(e);
      const what = str(o.what);
      if (!what) return null;
      return {
        id: str(o.id) || uniqueId(`evt-${taken.size + 1}`, taken),
        when: str(o.when),
        where: str(o.where),
        what,
        who: asStringArray(o.who),
        source: str(o.source),
        canon: ['past', 'future', 'branch'].includes(o.canon) ? o.canon : 'future',
      };
    })
    .filter(Boolean);
}

function normalizeSnapshot(raw) {
  const s = obj(raw);
  const characters = {};
  for (const [k, v] of Object.entries(obj(s.characters))) {
    const c = obj(v);
    characters[k] = {
      mood: str(c.mood),
      condition: str(c.condition || c.status),
      location: str(c.location),
      goal: str(c.goal),
    };
  }
  return {
    time: str(s.time),
    place: str(s.place),
    place_id: str(s.place_id),
    weather: str(s.weather),
    tension: clamp01(s.tension, 0.3),
    characters,
    inventory: asArray(s.inventory).map((i) => {
      if (typeof i === 'string') return { id: '', name: i, holder: '' };
      const o = obj(i);
      return { id: str(o.id), name: str(o.name), holder: str(o.holder) };
    }).filter((i) => i.name),
    quests: asArray(s.quests).map((q) => {
      if (typeof q === 'string') return { goal: q, status: 'active', progress: '' };
      const o = obj(q);
      return { goal: str(o.goal), status: str(o.status) || 'active', progress: str(o.progress) };
    }).filter((q) => q.goal),
    last_hook: str(s.last_hook),
    theme_tags: asStringArray(s.theme_tags),
  };
}

function normalizeAnchors(raw) {
  const taken = new Set();
  return asArray(raw)
    .map((a) => {
      const o = obj(a);
      const label = str(o.label);
      if (!label) return null;
      return {
        id: str(o.id) || uniqueId(slugify(label), taken),
        label,
        after_event: str(o.after_event),
        snapshot: normalizeSnapshot(o.snapshot),
        opening_seed: str(o.opening_seed),
        note: str(o.note),
      };
    })
    .filter(Boolean);
}

/**
 * 图谱扩展字段（可选）：类型化关系边。
 * 卡没有 edges 时，graph 层会从 relations / links / parent_id 推导等价边。
 */
const GRAPH_VISIBILITIES = ['public', 'rumor', 'engine', 'secret'];

function normalizeEdges(raw) {
  return asArray(raw)
    .map((e) => {
      const o = obj(e);
      const from = str(o.from);
      const to = str(o.to);
      if (!from || !to) return null;
      return {
        from,
        to,
        kind: str(o.kind) || 'related_to',
        directed: o.directed !== false,
        weight: clamp01(o.weight, 0.5),
        visibility: GRAPH_VISIBILITIES.includes(o.visibility) ? o.visibility : 'public',
        note: str(o.note).slice(0, 200),
      };
    })
    .filter(Boolean);
}

/** 图谱扩展字段（可选）：卡级事实声明。运行期断言仍写 assertions 表。 */
function normalizeClaims(raw) {
  return asArray(raw)
    .map((c) => {
      const o = obj(c);
      const subject = str(o.subject);
      const predicate = str(o.predicate);
      if (!subject || !predicate) return null;
      const objRaw = o.object;
      const object = typeof objRaw === 'object' && objRaw != null
        ? { kind: str(objRaw.kind) || 'literal', id: str(objRaw.id), text: str(objRaw.text) }
        : { kind: 'literal', id: '', text: str(objRaw) };
      const validity = obj(o.validity);
      return {
        subject,
        predicate,
        object,
        cardinality: o.cardinality === 'one' ? 'one' : 'many',
        visibility: GRAPH_VISIBILITIES.includes(o.visibility) ? o.visibility : 'public',
        validity: {
          from_turn: num(validity.from_turn, 0),
          to_turn: validity.to_turn == null ? null : num(validity.to_turn, 0),
        },
      };
    })
    .filter(Boolean);
}

/**
 * 成长曲线（fates）。全部可选；缺省 = 该卡没有这一层。
 *
 * 这是「未来固定」的正确形状：不是事件清单（会变成必达节拍），
 * 而是「阶段 + 确定性解锁条件 + 增量 + 一行预兆」。
 * 运行期由 `server/world/fates.js` 的纯函数求值，不调模型。
 */
function normalizeUnlock(raw) {
  const u = obj(raw);
  const rule = (r) => {
    const o = obj(r);
    return {
      subject: str(o.subject),
      predicate: str(o.predicate),
      object: o.object == null ? null : str(o.object || ''),
    };
  };
  return {
    after_turn: num(u.after_turn, 0),
    after_events: asStringArray(u.after_events),
    claims: asArray(u.claims).map(rule).filter((c) => c.subject && c.predicate),
    knowledge: asStringArray(u.knowledge),
    min_relation: asArray(u.min_relation).map((r) => {
      const o = obj(r);
      if (!str(o.to)) return null;
      return {
        to: str(o.to),
        kind: str(o.kind),
        sentiment_gte: o.sentiment_gte == null ? null : num(o.sentiment_gte, 0),
      };
    }).filter(Boolean),
    any_of: asArray(u.any_of).map(normalizeUnlock),
    all_of: asArray(u.all_of).map(normalizeUnlock),
  };
}

function normalizeFateChange(raw) {
  const c = obj(raw);
  const voice = obj(c.voice);
  const psyche = obj(c.psyche);
  const knowledge = obj(c.knowledge);
  return {
    role: str(c.role),
    summary: str(c.summary),
    voice: {
      rhythm: str(voice.rhythm),
      lexicon_add: asStringArray(voice.lexicon_add),
      never_add: asStringArray(voice.never_add),
    },
    psyche: {
      wants_add: asStringArray(psyche.wants_add),
      fears_add: asStringArray(psyche.fears_add),
      hides_add: asStringArray(psyche.hides_add),
      values_add: asStringArray(psyche.values_add),
    },
    knowledge: {
      knows_add: asStringArray(knowledge.knows_add),
      believes_falsely_add: asStringArray(knowledge.believes_falsely_add),
    },
    agenda_add: normalizeAgenda(c.agenda_add),
    relations_set: normalizeRelations(c.relations_set),
  };
}

function normalizeFates(raw) {
  return asArray(raw)
    .map((f) => {
      const o = obj(f);
      const who = str(o.who);
      if (!who) return null;
      return {
        id: str(o.id) || uniqueId(`fate-${slugify(who)}-${num(o.stage, 1)}`, new Set()),
        who,
        stage: Math.max(1, num(o.stage, 1)),
        label: str(o.label),
        unlock: normalizeUnlock(o.unlock),
        change: normalizeFateChange(o.change),
        omen: asStringArray(o.omen),
        visibility: ['engine', 'author'].includes(o.visibility) ? o.visibility : 'engine',
        sources: asArray(o.sources).map((s) => {
          const x = obj(s);
          return { kind: str(x.kind), chapter: num(x.chapter, 0), quote: str(x.quote) };
        }).filter((s) => s.kind || s.chapter || s.quote),
      };
    })
    .filter(Boolean);
}

/** 伏笔表：开局播种成 threads，避免「记忆整理没埋到就永久丢失」。 */
function normalizeSeeds(raw) {
  return asArray(raw)
    .map((s) => {
      const o = obj(s);
      const title = str(o.title);
      if (!title) return null;
      return {
        id: str(o.id) || uniqueId(`seed-${slugify(title)}`, new Set()),
        title,
        kind: ['mystery', 'debt', 'promise', 'secret'].includes(o.kind) ? o.kind : 'mystery',
        weight: clamp01(o.weight, 0.5),
        note: str(o.note),
        payoff_hint: str(o.payoff_hint),
        source: obj(o.source),
      };
    })
    .filter(Boolean);
}

/** 原著事件骨架：永不注入，只给作者视图与偏离检测。 */
function normalizeCanonArc(raw) {
  return asArray(raw)
    .map((a) => {
      const o = obj(a);
      if (!str(o.id) && !str(o.label)) return null;
      return {
        id: str(o.id) || uniqueId(`arc-${slugify(str(o.label))}`, new Set()),
        chapter_from: num(o.chapter_from, 0),
        chapter_to: num(o.chapter_to, 0),
        label: str(o.label),
        summary: str(o.summary),
        beats: asArray(o.beats).map((b) => {
          const x = obj(b);
          return {
            what: str(x.what),
            who: asStringArray(x.who),
            where: str(x.where),
          };
        }).filter((b) => b.what),
        load_bearing: !!o.load_bearing,
      };
    })
    .filter(Boolean);
}

/** 偏离度：只影响 fates 解锁条件的宽严与 canon_arc 的可引用度，不新增注入层。 */
function normalizeDivergence(raw) {
  const d = obj(raw);
  const cutoff = obj(d.cutoff);
  return {
    mode: ['strict', 'loose', 'free'].includes(d.mode) ? d.mode : 'loose',
    cutoff: {
      chapter: num(cutoff.chapter, 0),
      arc_id: str(cutoff.arc_id),
      label: str(cutoff.label),
    },
    must_hold: asStringArray(d.must_hold),
    allow: asStringArray(d.allow),
  };
}

function normalizePlayer(raw, entities) {
  const p = obj(raw);
  const name = str(p.name);
  const knowledge = obj(p.knowledge);
  const canonCharacter = str(p.canon_character);
  const persons = entities.filter(isPerson);
  // canon_character 可以是人物 id、人物名，或者干脆省略（用 player.name 反查）
  const lookup = canonCharacter || (p.mode === 'canon' ? name : '');
  const matched = lookup
    ? persons.find((c) => c.id === lookup || c.name === lookup)
    : null;
  return {
    mode: p.mode === 'canon' || matched ? 'canon' : 'original',
    canon_character: matched ? matched.id : '',
    name: name || matched?.name || '主角',
    age: str(p.age),
    identity: str(p.identity),
    situation: str(p.situation),
    capability: str(p.capability),
    inner_voice: str(p.inner_voice),
    wants: str(p.wants),
    afraid: str(p.afraid),
    status: str(p.status),
    condition: str(p.condition),
    mood: str(p.mood),
    location: str(p.location),
    goal: str(p.goal),
    // 银钱：唯一的数值字段（state-paths.js NUMBER_PATH_SET）。缺省 0 而不是空串，
    // 否则「第一次 delta」会从 undefined 开始算，模型和代码对不上同一个起点。
    money: num(p.money, 0),
    knowledge: {
      knows: asStringArray(knowledge.knows),
      does_not_know: asStringArray(knowledge.does_not_know),
    },
  };
}

/** 把任意来源的卡对象归一成 v5 形状。只接受 v5 字段，不做旧格式迁移。 */
export function normalizeCard(raw) {
  const c = obj(raw);
  // premise 既允许写在 prompt 里，也允许写在顶层（手写卡更自然）
  const prompt = normalizePrompt({ ...obj(c.prompt), premise: c.premise || obj(c.prompt).premise });
  const entities = normalizeEntities(c.entities);
  const timeline = normalizeTimeline(c.timeline);
  const source = obj(c.source);
  const kind = ['original', 'adapted', 'remix'].includes(c.kind) ? c.kind : (source.title ? 'adapted' : 'original');
  const anchors = normalizeAnchors(c.anchors);

  return {
    version: CARD_VERSION,
    kind,
    title: str(c.title) || '未命名世界',
    subtitle: str(c.subtitle),
    genre: asStringArray(c.genre),
    tags: asStringArray(c.tags),
    source: source.title
      ? {
        kind: str(source.kind) || 'novel',
        title: str(source.title),
        chapters: num(source.chapters, 0),
        canon_cutoff: str(source.canon_cutoff) || 'prologue',
        path: str(source.path),
      }
      : null,
    prompt,
    // 卡级默认工艺：只存取值 id（正文归 craft.js）。开局时作会话 settings 的初始值，
    // 会话内仍可随时改；作者改卡不会改写已开的会话（settings 是会话的，不是卡的）。
    craft: normalizeCardCraft(c.craft),
    charter: normalizeCharter(c.charter),
    entities,
    timeline,
    anchors,
    // 图谱扩展字段（可选）；没有时由 server/world/graph.js 从 relations/links/parent_id 推导。
    edges: normalizeEdges(c.edges),
    claims: normalizeClaims(c.claims),
    // 成长曲线（可选）。缺省为空 → 该卡没有这一层。
    // 手搓原创卡同样适用：canon_arc 为空、unlock 用 after_turn。
    fates: normalizeFates(c.fates),
    seeds: normalizeSeeds(c.seeds),
    canon_arc: normalizeCanonArc(c.canon_arc),
    divergence: normalizeDivergence(c.divergence),
    player: normalizePlayer(c.player, entities),
    author_notes: asArray(c.author_notes)
      .map((n) => {
        if (typeof n === 'string') return { text: n.trim(), scope: 'always' };
        const o = obj(n);
        return { text: str(o.text), scope: ['always', 'scene', 'session'].includes(o.scope) ? o.scope : 'always' };
      })
      .filter((n) => n.text),
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 别名索引与实体链接                                                     */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 建立「别名 → 实体」索引。这是唯一保留的字符串匹配：
 * 它只回答「文本里提到了谁/什么」，用来更新场记单的在场者与随身物，
 * 不回答「该注入哪段设定」。
 */
export function buildAliasIndex(card) {
  const out = [];
  for (const e of card.entities || []) {
    for (const a of [e.name, ...e.aliases]) {
      if (a && a.length >= 2) {
        out.push({
          alias: a,
          kind: e.type,
          id: e.id,
          name: e.name,
          type: e.type,
          role: e.type === PERSON_TYPE ? e.role : '',
        });
      }
    }
  }
  // 长别名优先，避免「玥姐姐」被「姐姐」抢先
  return out.sort((a, b) => b.alias.length - a.alias.length);
}

/**
 * 在文本里做实体链接。最长匹配优先，已被更长匹配覆盖的区间不再重复计数。
 * @returns {{person:string[], fact:string[]}}
 */
export function linkEntities(text, aliasIndex) {
  const t = str(text);
  if (!t || !aliasIndex?.length) return { person: [], fact: [] };
  const claimed = [];
  const person = new Set();
  const fact = new Set();
  for (const e of aliasIndex) {
    let idx = t.indexOf(e.alias);
    while (idx !== -1) {
      const end = idx + e.alias.length;
      const overlap = claimed.some(([s, ee]) => idx < ee && s < end);
      if (!overlap) {
        claimed.push([idx, end]);
        (e.type === PERSON_TYPE ? person : fact).add(e.id);
        break;
      }
      idx = t.indexOf(e.alias, idx + 1);
    }
  }
  return { person: [...person], fact: [...fact] };
}

/** 把一个名字/别名解析成规范 id；解析不了就原样返回。 */
export function resolveWho(name, aliasIndex) {
  const n = str(name);
  if (!n) return '';
  const hit = aliasIndex.find((e) => e.alias === n);
  return hit ? hit.id : n;
}

/** 解析成实体引用；解析不了返回 type=''，由调用方决定是否当作临时实体。 */
export function resolveEntity(name, aliasIndex) {
  const n = str(name);
  if (!n) return { type: '', id: '', name: '' };
  const hit = (aliasIndex || []).find((e) => e.alias === n);
  return hit
    ? { type: hit.type || hit.kind, id: hit.id, name: hit.name }
    : { type: '', id: n, name: n };
}

/** 场景主题标签：在场实体的 tags ∪ 账本 theme_tags ∪ 线索 tags。 */
export function sceneThemeTags(card, presentIds, extra = []) {
  const tags = new Set(extra.filter(Boolean));
  for (const e of card.entities || []) {
    if (e.type === PERSON_TYPE) continue; // 人物不参与设定集的自动候选
    if (presentIds.includes(e.id)) for (const t of e.tags) tags.add(t);
  }
  return [...tags];
}

/** 世界卡导出的纯文本形态（给用户直接取用/外带）。 */
export function renderCardText(card) {
  const c = normalizeCard(card);
  const persons = c.entities.filter(isPerson);
  const facts = c.entities.filter(isFact);
  const lines = [`# ${c.title}${c.subtitle ? ` · ${c.subtitle}` : ''}`, ''];
  if (c.prompt.premise) lines.push('## 故事方向', c.prompt.premise, '');
  if (c.charter.length) {
    lines.push('## 世界规则');
    for (const r of c.charter) lines.push(`- ${r.rule}`);
    lines.push('');
  }
  if (persons.length) {
    lines.push('## 角色');
    for (const p of persons) {
      lines.push(`### ${p.name}${p.role ? `（${p.role}）` : ''}`);
      if (p.summary) lines.push(p.summary);
      if (p.identity.age) lines.push(`年龄：${p.identity.age}`);
      if (p.identity.appearance) lines.push(`外貌：${p.identity.appearance}`);
      if (p.identity.station) lines.push(`身份：${p.identity.station}`);
      if (p.identity.background) lines.push(`背景：${p.identity.background}`);
      if (p.psyche.traits.length) lines.push(`性格：${p.psyche.traits.join('、')}`);
      if (p.voice.rhythm) lines.push(`口吻：${p.voice.rhythm}`);
      const addr = Object.entries(p.voice.address || {}).map(([to, how]) => `${to}→${how}`).join('；');
      if (addr) lines.push(`称呼：${addr}`);
      if (p.psyche.wants.length) lines.push(`想要：${p.psyche.wants.join('、')}`);
      if (p.psyche.hides.length) lines.push(`藏着：${p.psyche.hides.join('、')}`);
      if (p.agenda.length) {
        lines.push('私心：');
        for (const a of p.agenda) lines.push(`- ${a.goal}${a.method ? `｜${a.method}` : ''}`);
      }
      lines.push('');
    }
  }
  if (facts.length) {
    lines.push('## 设定集');
    for (const e of facts) {
      lines.push(`### ${e.name}${e.summary ? `｜${e.summary}` : ''}`);
      if (e.facets.rules.length) lines.push(`规则：${e.facets.rules.join('；')}`);
      if (e.detail) lines.push(e.detail);
      lines.push('');
    }
  }
  if (c.timeline.length) {
    lines.push('## 时间线');
    for (const e of c.timeline) {
      lines.push(`- [${e.canon === 'past' ? '前史' : '参考走向'}] ${e.when ? `${e.when} · ` : ''}${e.what}`);
    }
    lines.push('');
  }
  if (c.anchors.length) {
    lines.push('## 开局点');
    for (const a of c.anchors) lines.push(`- ${a.label}${a.note ? `｜${a.note}` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}
