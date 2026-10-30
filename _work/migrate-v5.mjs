#!/usr/bin/env node
/**
 * _work/migrate-v5.mjs — 一次性迁移：v4 世界卡（card.cast[] + card.codex[]）→ v5（card.entities[]）。
 *
 * 这是手工脚本，不参与运行时；迁移完成后 server/ 只认 v5 形状，不做兼容层。
 *
 * 用法：
 *   node _work/migrate-v5.mjs            # dry-run：只打印报告，不写盘
 *   node _work/migrate-v5.mjs --write    # 写回 presets/*.json（保留 wrapper 外层字段）
 *
 * 映射规则：
 *   - cast[] → type:'person'；one_line → summary；identity / voice / psyche / knowledge /
 *     agenda / relations / always_present / weight 原样；运行期初始值补空串。
 *   - codex[].type 不是 character → 原 type（place|institution|item|faction|concept|custom），
 *     字段原样并补运行期初始值；reveal 缺省 public。
 *   - codex[].type === 'character' → 按 name/aliases 找同名 cast person 合并：
 *       detail 并入 identity.background；summary 补 role 空位；tags / facets / sources /
 *       links / pinned / muted / reveal / canon_from / parent_id 并入。
 *     找不到同名 → 独立 person（role 用 summary，detail 放 identity.background）。
 *   - 引用（links / relations.to / parent_id / edges.from|to / timeline.who / claims /
 *     player.canon_character / anchors[].snapshot.characters 的键、place_id、inventory[].id）
 *     一律转成裸 id；解析不到的引用丢弃并计入「断链」。
 *   - id 保留；冲突时按 name slug 重建并记录。
 *   - 已 version===5 的卡跳过（幂等）。
 *
 * 不迁移的字段会在报告里列为「无法映射字段」，需要人工判断是否补进 v5 形状。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCard, slugify, PERSON_TYPE, isPerson } from '../server/world/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS_DIR = path.join(ROOT, 'presets');
const WRITE = process.argv.includes('--write');

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (list) => [...new Set(list.filter(Boolean))];
const stripRef = (v) => str(v).replace(/^(?:cast|codex):/, '');

const FACT_TYPES = new Set(['place', 'institution', 'item', 'faction', 'concept', 'custom']);
const factType = (t) => (FACT_TYPES.has(str(t)) ? str(t) : 'custom');
const revealOf = (v) => (['public', 'rumor', 'secret'].includes(str(v)) ? str(v) : '');

/* ── 迁移期字段白名单：不在里面的字段无法落进 v5，报告出来 ─────────────── */

const CARD_KEYS = new Set([
  'version', 'kind', 'title', 'subtitle', 'genre', 'tags', 'source', 'prompt', 'premise',
  'charter', 'cast', 'codex', 'timeline', 'anchors', 'edges', 'claims', 'fates', 'seeds',
  'canon_arc', 'divergence', 'player', 'author_notes',
]);
const CAST_KEYS = new Set([
  'id', 'name', 'aliases', 'role', 'one_line', 'summary', 'detail', 'tags', 'facets', 'links',
  'reveal', 'canon_from', 'sources', 'pinned', 'muted', 'parent_id', 'identity', 'voice',
  'psyche', 'knowledge', 'agenda', 'relations', 'always_present', 'weight', 'age',
  'status', 'condition', 'mood', 'location', 'goal',
]);
const CODEX_KEYS = new Set([
  'id', 'type', 'name', 'aliases', 'tags', 'summary', 'detail', 'facets', 'links', 'reveal',
  'canon_from', 'sources', 'pinned', 'muted', 'parent_id', 'status', 'condition',
  'access', 'open_to', 'owner_id', 'location_id',
  // character codex 有时会带人物字段
  'role', 'one_line', 'identity', 'voice', 'psyche', 'knowledge', 'agenda', 'relations',
  'always_present', 'weight', 'age',
]);
const IDENTITY_KEYS = new Set(['age', 'appearance', 'background', 'station']);
const VOICE_KEYS = new Set(['address', 'rhythm', 'lexicon', 'never', 'exemplars']);
const PSYCHE_KEYS = new Set(['traits', 'wants', 'fears', 'hides', 'values']);
const KNOWLEDGE_KEYS = new Set(['knows', 'does_not_know', 'believes_falsely']);
const FACET_KEYS = new Set(['sensory', 'rules', 'consequences', 'history']);

function checkNested(value, allowed, prefix, out) {
  for (const key of Object.keys(obj(value))) if (!allowed.has(key)) out.push(`${prefix}.${key}`);
}

function collectUnmapped(card, cast, codex) {
  const out = [];
  for (const key of Object.keys(card)) if (!CARD_KEYS.has(key)) out.push(key);
  cast.forEach((c, i) => {
    for (const key of Object.keys(c)) if (!CAST_KEYS.has(key)) out.push(`cast[${i}].${key}`);
    checkNested(c.identity, IDENTITY_KEYS, `cast[${i}].identity`, out);
    checkNested(c.voice, VOICE_KEYS, `cast[${i}].voice`, out);
    checkNested(c.psyche, PSYCHE_KEYS, `cast[${i}].psyche`, out);
    checkNested(c.knowledge, KNOWLEDGE_KEYS, `cast[${i}].knowledge`, out);
    checkNested(c.facets, FACET_KEYS, `cast[${i}].facets`, out);
  });
  codex.forEach((e, i) => {
    for (const key of Object.keys(e)) if (!CODEX_KEYS.has(key)) out.push(`codex[${i}].${key}`);
    checkNested(e.identity, IDENTITY_KEYS, `codex[${i}].identity`, out);
    checkNested(e.voice, VOICE_KEYS, `codex[${i}].voice`, out);
    checkNested(e.psyche, PSYCHE_KEYS, `codex[${i}].psyche`, out);
    checkNested(e.knowledge, KNOWLEDGE_KEYS, `codex[${i}].knowledge`, out);
    checkNested(e.facets, FACET_KEYS, `codex[${i}].facets`, out);
  });
  return uniq(out);
}

/* ── 实体构造 ──────────────────────────────────────────────────────────── */

function normalizeFacets(raw) {
  const f = obj(raw);
  return {
    sensory: str(f.sensory),
    rules: uniq(arr(f.rules).map(str)),
    consequences: uniq(arr(f.consequences).map(str)),
    history: str(f.history),
  };
}

function mergeFacets(cast, mergedEntries) {
  const facets = normalizeFacets(cast);
  for (const m of mergedEntries) {
    const f = normalizeFacets(m.facets);
    if (!facets.sensory) facets.sensory = f.sensory;
    if (!facets.history) facets.history = f.history;
    facets.rules.push(...f.rules);
    facets.consequences.push(...f.consequences);
  }
  facets.rules = uniq(facets.rules);
  facets.consequences = uniq(facets.consequences);
  return facets;
}

function mergeSources(cast, mergedEntries) {
  const seen = new Set();
  const out = [];
  for (const s of [...arr(cast.sources), ...mergedEntries.flatMap((m) => arr(m.sources))]) {
    const o = obj(s);
    const key = [str(o.kind), str(o.ref), str(o.title), str(o.chapter), str(o.offset), str(o.quote)].join('\u0000');
    if (!key.replace(/\u0000/g, '') || seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

function personFromCast(cast, mergedEntries) {
  const own = obj(cast.identity);
  const backgrounds = [];
  const pushBg = (v) => {
    const text = str(v);
    if (text && !backgrounds.includes(text)) backgrounds.push(text);
  };
  pushBg(own.background);
  for (const m of mergedEntries) pushBg(m.detail || m.identity?.background);
  const mergedSummary = mergedEntries.map((m) => str(m.summary)).find(Boolean) || '';
  let reveal = revealOf(cast.reveal) || 'public';
  for (const m of mergedEntries) if (revealOf(m.reveal) && revealOf(m.reveal) !== 'public') reveal = revealOf(m.reveal);
  return {
    id: '',
    type: PERSON_TYPE,
    name: str(cast.name) || str(cast.id),
    aliases: uniq([...arr(cast.aliases), ...mergedEntries.flatMap((m) => arr(m.aliases))]),
    tags: uniq([...arr(cast.tags), ...mergedEntries.flatMap((m) => arr(m.tags))]),
    summary: str(cast.one_line) || str(cast.summary) || mergedSummary,
    detail: str(cast.detail),
    facets: mergeFacets(cast.facets, mergedEntries),
    links: mergedEntries.flatMap((m) => arr(m.links)),
    reveal,
    canon_from: str(cast.canon_from) || mergedEntries.map((m) => str(m.canon_from)).find(Boolean) || '',
    sources: mergeSources(cast, mergedEntries),
    pinned: !!cast.pinned || mergedEntries.some((m) => !!m.pinned),
    muted: !!cast.muted || mergedEntries.some((m) => !!m.muted),
    parent_id: str(cast.parent_id) || mergedEntries.map((m) => str(m.parent_id)).find(Boolean) || '',
    role: str(cast.role) || mergedSummary,
    identity: {
      age: str(own.age || cast.age),
      appearance: str(own.appearance),
      background: backgrounds.join('；'),
      station: str(own.station),
    },
    voice: obj(cast.voice),
    psyche: obj(cast.psyche),
    knowledge: obj(cast.knowledge),
    agenda: arr(cast.agenda),
    relations: arr(cast.relations),
    always_present: !!cast.always_present,
    weight: cast.weight == null ? 0.5 : cast.weight,
    // 运行期初始值：迁移只搬静态卡，状态从空开始
    status: str(cast.status), condition: str(cast.condition), mood: str(cast.mood),
    location: str(cast.location), goal: str(cast.goal),
  };
}

function personFromCodex(e) {
  const own = obj(e.identity);
  return {
    id: '',
    type: PERSON_TYPE,
    name: str(e.name) || str(e.id),
    aliases: uniq(arr(e.aliases)),
    tags: uniq(arr(e.tags)),
    summary: str(e.summary),
    // detail 已经进 identity.background，公共 detail 不再重复
    detail: '',
    facets: normalizeFacets(e.facets),
    links: arr(e.links),
    reveal: revealOf(e.reveal) || 'public',
    canon_from: str(e.canon_from),
    sources: arr(e.sources).map(obj),
    pinned: !!e.pinned,
    muted: !!e.muted,
    parent_id: str(e.parent_id),
    role: str(e.role) || str(e.summary),
    identity: {
      age: str(own.age || e.age),
      appearance: str(own.appearance),
      background: str(e.detail),
      station: str(own.station),
    },
    voice: obj(e.voice),
    psyche: obj(e.psyche),
    knowledge: obj(e.knowledge),
    agenda: arr(e.agenda),
    relations: arr(e.relations),
    always_present: !!e.always_present,
    weight: e.weight == null ? 0.5 : e.weight,
    status: str(e.status), condition: str(e.condition), mood: str(e.mood),
    location: str(e.location), goal: str(e.goal),
  };
}

function factFromCodex(e) {
  return {
    id: '',
    type: factType(e.type),
    name: str(e.name) || str(e.id),
    aliases: uniq(arr(e.aliases)),
    tags: uniq(arr(e.tags)),
    summary: str(e.summary),
    detail: str(e.detail),
    facets: normalizeFacets(e.facets),
    links: arr(e.links),
    reveal: revealOf(e.reveal) || 'public',
    canon_from: str(e.canon_from),
    sources: arr(e.sources).map(obj),
    pinned: !!e.pinned,
    muted: !!e.muted,
    parent_id: str(e.parent_id),
    // 运行期初始值
    status: str(e.status), condition: str(e.condition),
    access: str(e.access), open_to: str(e.open_to),
    owner_id: str(e.owner_id), location_id: str(e.location_id),
  };
}

/* ── 引用校验（归一后自检） ────────────────────────────────────────────── */

function danglingRefs(card) {
  const ids = new Set(card.entities.map((e) => e.id));
  const personIds = new Set(card.entities.filter(isPerson).map((e) => e.id));
  const bad = { links: 0, relations: 0, parent_id: 0, edges: 0, timeline: 0, claims: 0, player: 0, snapshot: 0, inventory: 0, place_id: 0 };
  const ok = (id, set = ids) => !id || set.has(id);
  for (const e of card.entities) {
    if (!ok(e.parent_id)) bad.parent_id += 1;
    for (const x of arr(e.links)) if (!ok(x)) bad.links += 1;
    if (isPerson(e)) for (const r of arr(e.relations)) if (!ok(r.to, personIds)) bad.relations += 1;
  }
  for (const edge of arr(card.edges)) if (!ok(edge.from) || !ok(edge.to)) bad.edges += 1;
  for (const t of arr(card.timeline)) for (const w of arr(t.who)) if (!ok(w)) bad.timeline += 1;
  for (const claim of arr(card.claims)) {
    if (!ok(claim.subject) || !ok(claim.object?.id)) bad.claims += 1;
  }
  if (card.player?.canon_character && !personIds.has(card.player.canon_character)) bad.player += 1;
  for (const a of arr(card.anchors)) {
    const snap = obj(a.snapshot);
    if (!ok(snap.place_id)) bad.place_id += 1;
    for (const k of Object.keys(obj(snap.characters))) if (!ok(k)) bad.snapshot += 1;
    for (const item of arr(snap.inventory)) if (!ok(item.id)) bad.inventory += 1;
  }
  const total = Object.values(bad).reduce((a, b) => a + b, 0);
  return { ...bad, total };
}

/* ── 单卡迁移 ──────────────────────────────────────────────────────────── */

function migrateCard(card) {
  const cast = arr(card.cast).map(obj);
  const codex = arr(card.codex).map(obj);
  const unmapped = collectUnmapped(card, cast, codex);
  const stats = {
    castIn: cast.length,
    codexIn: codex.length,
    characterCodex: 0,
    merges: 0,
    orphanPersons: 0,
    renamedIds: [],
    broken: {},
    unmapped,
    brokenTotal: 0,
  };
  const broken = (field) => {
    stats.broken[field] = (stats.broken[field] || 0) + 1;
    stats.brokenTotal += 1;
  };

  // 1) character codex 的合并判定：name / aliases 找同名 cast person
  const castByKey = new Map();
  cast.forEach((c, i) => {
    for (const k of [c.id, c.name, ...arr(c.aliases)]) {
      const key = stripRef(k);
      if (key && !castByKey.has(key)) castByKey.set(key, i);
    }
  });
  const mergedByCast = new Map();
  const orphans = [];
  for (const e of codex) {
    if (str(e.type) !== 'character') continue;
    stats.characterCodex += 1;
    const hit = [e.name, ...arr(e.aliases)]
      .map((k) => castByKey.get(stripRef(k)))
      .find((v) => v !== undefined);
    if (hit === undefined) {
      orphans.push(e);
      continue;
    }
    stats.merges += 1;
    if (!mergedByCast.has(hit)) mergedByCast.set(hit, []);
    mergedByCast.get(hit).push(e);
  }
  stats.orphanPersons = orphans.length;

  // 2) 分配 id（保留原 id；冲突按 name slug 重建）
  const seenIds = new Set();
  const allocateId = (preferred, name) => {
    const wanted = str(preferred);
    const base = wanted || slugify(name) || 'entity';
    let id = base;
    let n = 2;
    while (seenIds.has(id)) id = `${base}-${n++}`;
    seenIds.add(id);
    if (wanted && id !== wanted) stats.renamedIds.push({ from: wanted, to: id, name: str(name) });
    return id;
  };

  // entries：[{ entity, person, keys }]，keys 含被合并 codex 的 id/name/aliases
  const entries = [];
  cast.forEach((c, i) => {
    const mergedEntries = mergedByCast.get(i) || [];
    const entity = personFromCast(c, mergedEntries);
    entity.id = allocateId(c.id, c.name);
    entries.push({
      entity,
      person: true,
      keys: [c.id, c.name, ...arr(c.aliases), ...mergedEntries.flatMap((m) => [m.id, m.name, ...arr(m.aliases)])],
    });
  });
  for (const e of orphans) {
    const entity = personFromCodex(e);
    entity.id = allocateId(e.id, e.name);
    entries.push({ entity, person: true, keys: [e.id, e.name, ...arr(e.aliases)] });
  }
  for (const e of codex) {
    if (str(e.type) === 'character') continue;
    const entity = factFromCodex(e);
    entity.id = allocateId(e.id, e.name);
    entries.push({ entity, person: false, keys: [e.id, e.name, ...arr(e.aliases)] });
  }

  // 3) 引用表：name / alias / id → 裸 id（关系只认 person）
  const entityRefs = new Map();
  const personRefs = new Map();
  for (const { entity, person, keys } of entries) {
    for (const key of uniq([...keys, entity.id, entity.name, ...arr(entity.aliases)].map(stripRef))) {
      if (!entityRefs.has(key)) entityRefs.set(key, entity.id);
      if (person && !personRefs.has(key)) personRefs.set(key, entity.id);
    }
  }
  const resolveAny = (v) => {
    const raw = stripRef(v);
    return raw ? str(entityRefs.get(raw)) : '';
  };
  const resolvePerson = (v) => {
    const raw = stripRef(v);
    return raw ? str(personRefs.get(raw)) : '';
  };

  // 4) 实体内部引用
  for (const { entity, person } of entries) {
    const own = entity.id;
    const seenLinks = new Set();
    const links = [];
    for (const x of arr(entity.links)) {
      const id = resolveAny(x);
      if (!id) {
        if (stripRef(x)) broken('links');
        continue;
      }
      if (id === own || seenLinks.has(id)) continue;
      seenLinks.add(id);
      links.push(id);
    }
    entity.links = links;

    const parent = resolveAny(entity.parent_id);
    if (stripRef(entity.parent_id) && !parent) broken('parent_id');
    entity.parent_id = parent;

    if (person) {
      const seen = new Set();
      const relations = [];
      for (const r of arr(entity.relations)) {
        const o = obj(r);
        const to = resolvePerson(o.to);
        if (!to) {
          if (stripRef(o.to)) broken('relations');
          continue;
        }
        if (to === own || seen.has(to)) continue;
        seen.add(to);
        relations.push({ to, kind: str(o.kind), sentiment: o.sentiment, note: str(o.note) });
      }
      entity.relations = relations;
    }
  }

  // 5) 卡级引用：edges / timeline / claims / player / anchors
  const edges = [];
  for (const e of arr(card.edges)) {
    const o = obj(e);
    const from = resolveAny(o.from);
    const to = resolveAny(o.to);
    if (!from || !to) {
      if (stripRef(o.from) || stripRef(o.to)) broken('edges');
      continue;
    }
    edges.push({ ...o, from, to });
  }

  const timeline = arr(card.timeline).map((t) => {
    const o = obj(t);
    const who = [];
    for (const w of arr(o.who)) {
      const id = resolveAny(w);
      if (!id) {
        if (stripRef(w)) broken('timeline.who');
        continue;
      }
      if (!who.includes(id)) who.push(id);
    }
    return { ...o, who };
  });

  const claims = [];
  for (const c of arr(card.claims)) {
    const o = obj(c);
    const subject = resolveAny(o.subject);
    if (!subject) {
      if (stripRef(o.subject)) broken('claims');
      continue;
    }
    const objRaw = obj(o.object);
    let objectId = str(objRaw.id);
    if (objectId) {
      const resolved = resolveAny(objectId);
      if (!resolved) {
        broken('claims.object');
        continue;
      }
      objectId = resolved;
    }
    claims.push({ ...o, subject, object: { ...objRaw, id: objectId } });
  }

  const player = { ...obj(card.player) };
  const canonRaw = str(player.canon_character);
  const canonId = resolvePerson(canonRaw);
  if (canonRaw && !canonId) broken('player.canon_character');
  player.canon_character = canonId;

  const anchors = arr(card.anchors).map((a) => {
    const o = obj(a);
    const snapshot = { ...obj(o.snapshot) };
    const characters = {};
    for (const [key, value] of Object.entries(obj(snapshot.characters))) {
      const id = resolveAny(key);
      if (!id) {
        broken('snapshot.characters');
        continue;
      }
      if (!characters[id]) characters[id] = value;
    }
    snapshot.characters = characters;
    const placeRaw = str(snapshot.place_id);
    const placeId = resolveAny(placeRaw);
    if (placeRaw && !placeId) broken('snapshot.place_id');
    snapshot.place_id = placeId;
    snapshot.inventory = arr(snapshot.inventory).map((it) => {
      const item = { ...obj(it) };
      const raw = str(item.id);
      if (!raw) {
        item.id = '';
        return item;
      }
      const id = resolveAny(raw);
      if (!id) {
        broken('snapshot.inventory');
        item.id = '';
        return item;
      }
      item.id = id;
      return item;
    });
    return { ...o, snapshot };
  });

  // 6) 组装并跑 schema 归一（v5 形状的最终真源）
  const nextCard = { ...card, entities: entries.map((x) => x.entity), edges, claims, timeline, anchors, player };
  delete nextCard.cast;
  delete nextCard.codex;
  const normalized = normalizeCard(nextCard);

  return { card: normalized, stats, residual: danglingRefs(normalized) };
}

/* ── 报告与主流程 ──────────────────────────────────────────────────────── */

function fmtBroken(broken) {
  const parts = Object.entries(broken).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(' / ') : '无';
}

const totals = {
  files: 0, migrated: 0, skipped: 0, failed: 0,
  entities: 0, persons: 0, facts: 0, merges: 0, orphans: 0,
  broken: 0, unmapped: 0, residual: 0, renamed: 0,
};

function reportFile(filePath, raw) {
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const wrapper = obj(raw);
  const isWrapper = !!wrapper.card && typeof wrapper.card === 'object' && !Array.isArray(wrapper.card);
  const card = isWrapper ? wrapper.card : raw;
  const title = str(card.title) || rel;

  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    console.log(`\n${rel}\n  跳过：不是可识别的世界卡 JSON`);
    totals.skipped += 1;
    return;
  }
  if (Number(card.version) >= 5) {
    console.log(`\n${rel}「${title}」\n  跳过：已经是 v5（version ${card.version}）`);
    totals.skipped += 1;
    return;
  }
  const hasEntitiesOnly = Array.isArray(card.entities) && !arr(card.cast).length && !arr(card.codex).length;

  let result;
  try {
    result = migrateCard(card);
  } catch (err) {
    console.log(`\n${rel}\n  失败：${err?.message || err}`);
    totals.failed += 1;
    return;
  }
  const { card: normalized, stats, residual } = result;
  const persons = normalized.entities.filter(isPerson).length;
  const facts = normalized.entities.length - persons;

  console.log(`\n${rel}「${normalized.title || title}」${hasEntitiesOnly ? '（entities 形状，仅归一）' : ''}`);
  if (hasEntitiesOnly) {
    console.log(`  输入 entities ${normalized.entities.length}｜归一后实体 ${normalized.entities.length}（person ${persons} / fact ${facts}）`);
  } else {
    console.log(`  v4 → v5：cast ${stats.castIn} + codex ${stats.codexIn}（character ${stats.characterCodex}）→ 实体 ${normalized.entities.length}（person ${persons} / fact ${facts}）`);
    console.log(`  合并：${stats.merges} 条 character codex → 同名 person；独立转 person ${stats.orphanPersons} 条`);
  }
  console.log(`  id 重建：${stats.renamedIds.length
    ? stats.renamedIds.map((r) => `${r.name || r.from}: ${r.from} → ${r.to}`).join('；')
    : '无'}`);
  console.log(`  断链：${stats.brokenTotal}（${fmtBroken(stats.broken)}）`);
  console.log(`  无法映射字段：${stats.unmapped.length ? stats.unmapped.join('、') : '无'}`);
  console.log(`  归一后实体 ${normalized.entities.length}｜残留断链 ${residual.total}${residual.total ? `（${fmtBroken(residual)}）` : ''}`);

  if (WRITE && !hasEntitiesOnly) {
    const out = isWrapper ? { ...wrapper, card: normalized } : normalized;
    fs.writeFileSync(filePath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    console.log(`  已写回 ${rel}`);
  } else if (WRITE) {
    const out = isWrapper ? { ...wrapper, card: normalized } : normalized;
    fs.writeFileSync(filePath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    console.log(`  已写回（仅归一）${rel}`);
  }

  totals.migrated += 1;
  totals.entities += normalized.entities.length;
  totals.persons += persons;
  totals.facts += facts;
  totals.merges += stats.merges;
  totals.orphans += stats.orphanPersons;
  totals.broken += stats.brokenTotal;
  totals.unmapped += stats.unmapped.length;
  totals.residual += residual.total;
  totals.renamed += stats.renamedIds.length;
}

function main() {
  if (!fs.existsSync(PRESETS_DIR)) {
    console.log(`找不到预设目录：${PRESETS_DIR}`);
    process.exitCode = 1;
    return;
  }
  const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')).sort();
  console.log(`【migrate-v5】${WRITE ? '写盘模式 --write' : 'dry-run（不写盘）'} · ${presetsRel()}`);
  for (const file of files) {
    totals.files += 1;
    const filePath = path.join(PRESETS_DIR, file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.log(`\n${file}\n  失败：JSON 解析失败（${err?.message || err}）`);
      totals.failed += 1;
      continue;
    }
    reportFile(filePath, raw);
  }

  console.log('');
  console.log(`汇总：文件 ${totals.files}｜迁移 ${totals.migrated}｜跳过 ${totals.skipped}｜失败 ${totals.failed}`);
  console.log(`      实体 ${totals.entities}（person ${totals.persons} / fact ${totals.facts}）｜character codex 合并 ${totals.merges}｜独立转 person ${totals.orphans}`);
  console.log(`      断链 ${totals.broken}｜无法映射字段 ${totals.unmapped}｜id 重建 ${totals.renamed}｜归一后残留断链 ${totals.residual}`);
  if (!WRITE) {
    console.log('dry-run 完成：未写盘。确认报告后加 --write 写回（保留 wrapper 外层字段）。');
  }
  if (totals.failed) process.exitCode = 1;
}

function presetsRel() {
  return path.relative(ROOT, PRESETS_DIR).replace(/\\/g, '/') || 'presets';
}

// 只在直接执行时跑主流程；被测试脚本 import 时只拿纯函数
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { migrateCard, danglingRefs, collectUnmapped, main };
