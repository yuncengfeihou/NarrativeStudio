/**
 * server/world/schema.js — 世界卡 v4：结构化提示词的数据形状
 *
 * 设计原则（详见 docs/CONTRACTS.md「世界卡 v4」）：
 *   1. 卡描述世界，不描述故事。没有幕、没有必达节拍、没有忌避清单。
 *   2. canon 与 destiny 分离：timeline 里 past 是既定事实，future 只是原著参考，默认不注入。
 *   3. 词条（codex）是类型化实体，靠 links / tags 进场，不靠关键词触发。
 *   4. 每个字段都可缺省。最小卡只要 premise + player + opening 三样就能玩。
 *   5. 三种来源：original（原创）/ adapted（小说抽取）/ remix（混编）。
 *
 * 本模块只做形状归一与纯函数推导，不碰存储、不调 LLM。
 */
const CARD_VERSION = 4;

export const CODEX_TYPES = ['place', 'institution', 'item', 'faction', 'concept', 'character', 'custom'];
const CODEX_REVEALS = ['public', 'rumor', 'secret'];

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
    length: str(p.length) || '1600-2600 字',
    tense: str(p.tense) || '过去时叙述',
  };
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

function normalizeCast(raw) {
  const taken = new Set();
  return asArray(raw)
    .map((c) => {
      const o = obj(c);
      const name = str(o.name);
      if (!name) return null;
      const voice = obj(o.voice);
      const psyche = obj(o.psyche);
      const knowledge = obj(o.knowledge);
      const identity = obj(o.identity);
      const entry = {
        id: str(o.id) || uniqueId(slugify(name), taken),
        name,
        aliases: asStringArray(o.aliases),
        role: str(o.role),
        one_line: str(o.one_line),
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
        agenda: asArray(o.agenda)
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
          .filter(Boolean),
        relations: asArray(o.relations)
          .map((r) => {
            const g = obj(r);
            const to = str(g.to);
            if (!to) return null;
            return { to, kind: str(g.kind), sentiment: Math.max(-1, Math.min(1, num(g.sentiment, 0))), note: str(g.note) };
          })
          .filter(Boolean),
        always_present: !!o.always_present,
        weight: clamp01(o.weight, 0.5),
      };
      return entry;
    })
    .filter(Boolean);
}

function normalizeCodex(raw) {
  const taken = new Set();
  return asArray(raw)
    .map((c) => {
      const o = obj(c);
      const name = str(o.name);
      if (!name && !str(o.summary)) return null;
      const facets = obj(o.facets);
      const entry = {
        id: str(o.id) || uniqueId(slugify(name || str(o.summary).slice(0, 8)), taken),
        type: CODEX_TYPES.includes(o.type) ? o.type : 'custom',
        name: name || str(o.summary).slice(0, 12),
        aliases: asStringArray(o.aliases),
        tags: asStringArray(o.tags),
        summary: str(o.summary),
        facets: {
          sensory: str(facets.sensory),
          rules: asStringArray(facets.rules),
          consequences: asStringArray(facets.consequences),
          history: str(facets.history),
        },
        links: asStringArray(o.links),
        reveal: CODEX_REVEALS.includes(o.reveal) ? o.reveal : 'public',
        canon_from: str(o.canon_from),
        detail: str(o.detail),
        pinned: !!o.pinned,
      };
      return entry;
    })
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

function normalizePlayer(raw, cast) {
  const p = obj(raw);
  const name = str(p.name);
  const knowledge = obj(p.knowledge);
  const canonCharacter = str(p.canon_character);
  // canon_character 可以是 cast id、cast 名，或者干脆省略（用 player.name 反查）
  const lookup = canonCharacter || (p.mode === 'canon' ? name : '');
  const matched = lookup
    ? cast.find((c) => c.id === lookup || c.name === lookup)
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
    knowledge: {
      knows: asStringArray(knowledge.knows),
      does_not_know: asStringArray(knowledge.does_not_know),
    },
  };
}

/** 把任意来源的卡对象归一成 v4 形状。只接受 v4 字段，不做旧格式迁移。 */
export function normalizeCard(raw) {
  const c = obj(raw);
  // premise 既允许写在 prompt 里，也允许写在顶层（手写卡更自然）
  const prompt = normalizePrompt({ ...obj(c.prompt), premise: c.premise || obj(c.prompt).premise });
  const cast = normalizeCast(c.cast);
  const codex = normalizeCodex(c.codex);
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
    charter: normalizeCharter(c.charter),
    cast,
    codex,
    timeline,
    anchors,
    player: normalizePlayer(c.player, cast),
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
  for (const c of card.cast || []) {
    for (const a of [c.name, ...c.aliases]) {
      if (a && a.length >= 2) out.push({ alias: a, kind: 'cast', id: c.id, name: c.name, role: c.role });
    }
  }
  for (const e of card.codex || []) {
    for (const a of [e.name, ...e.aliases]) {
      if (a && a.length >= 2) out.push({ alias: a, kind: 'codex', id: e.id, name: e.name, type: e.type });
    }
  }
  // 长别名优先，避免「玥姐姐」被「姐姐」抢先
  return out.sort((a, b) => b.alias.length - a.alias.length);
}

/**
 * 在文本里做实体链接。最长匹配优先，已被更长匹配覆盖的区间不再重复计数。
 * @returns {{cast:string[], codex:string[]}}
 */
export function linkEntities(text, aliasIndex) {
  const t = str(text);
  if (!t || !aliasIndex?.length) return { cast: [], codex: [] };
  const claimed = [];
  const cast = new Set();
  const codex = new Set();
  for (const e of aliasIndex) {
    let idx = t.indexOf(e.alias);
    while (idx !== -1) {
      const end = idx + e.alias.length;
      const overlap = claimed.some(([s, ee]) => idx < ee && s < end);
      if (!overlap) {
        claimed.push([idx, end]);
        (e.kind === 'cast' ? cast : codex).add(e.id);
        break;
      }
      idx = t.indexOf(e.alias, idx + 1);
    }
  }
  return { cast: [...cast], codex: [...codex] };
}

/** 把一个名字/别名解析成规范 id；解析不了就原样返回。 */
export function resolveWho(name, aliasIndex) {
  const n = str(name);
  if (!n) return '';
  const hit = aliasIndex.find((e) => e.alias === n);
  return hit ? hit.id : n;
}

/** 场景主题标签：在场实体的 tags ∪ 账本 theme_tags ∪ 线索 tags。 */
export function sceneThemeTags(card, presentIds, extra = []) {
  const tags = new Set(extra.filter(Boolean));
  for (const e of card.codex || []) {
    if (presentIds.includes(e.id)) for (const t of e.tags) tags.add(t);
  }
  return [...tags];
}

/** 世界卡导出的纯文本形态（给用户直接取用/外带）。 */
export function renderCardText(card) {
  const c = normalizeCard(card);
  const lines = [`# ${c.title}${c.subtitle ? ` · ${c.subtitle}` : ''}`, ''];
  if (c.prompt.premise) lines.push('## 命题', c.prompt.premise, '');
  if (c.charter.length) {
    lines.push('## 宪章');
    for (const r of c.charter) lines.push(`- ${r.rule}`);
    lines.push('');
  }
  if (c.cast.length) {
    lines.push('## 卡司');
    for (const p of c.cast) {
      lines.push(`### ${p.name}${p.role ? `（${p.role}）` : ''}`);
      if (p.one_line) lines.push(p.one_line);
      if (p.voice.rhythm) lines.push(`口吻：${p.voice.rhythm}`);
      if (p.psyche.wants.length) lines.push(`想要：${p.psyche.wants.join('、')}`);
      if (p.psyche.hides.length) lines.push(`藏着：${p.psyche.hides.join('、')}`);
      if (p.agenda.length) {
        lines.push('私心：');
        for (const a of p.agenda) lines.push(`- ${a.goal}${a.method ? `｜${a.method}` : ''}`);
      }
      lines.push('');
    }
  }
  if (c.codex.length) {
    lines.push('## 辞书');
    for (const e of c.codex) {
      lines.push(`### ${e.name}${e.summary ? `｜${e.summary}` : ''}`);
      if (e.facets.rules.length) lines.push(`规则：${e.facets.rules.join('；')}`);
      if (e.detail) lines.push(e.detail);
      lines.push('');
    }
  }
  if (c.timeline.length) {
    lines.push('## 时间线');
    for (const e of c.timeline) {
      lines.push(`- [${e.canon}] ${e.when ? `${e.when} · ` : ''}${e.what}`);
    }
    lines.push('');
  }
  if (c.anchors.length) {
    lines.push('## 可玩时间点');
    for (const a of c.anchors) lines.push(`- ${a.label}${a.note ? `｜${a.note}` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}
