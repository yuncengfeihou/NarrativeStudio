#!/usr/bin/env node
/**
 * _work/card-enrich.mjs — 用素材重跑制卡抽取，把新抽取并入一张已有的 v5 世界卡
 *
 * 为什么要合并而不是直接换新卡：现有预设里的 prompt（bans/style_guide）、player、
 * 锚点与 opening_seed、seeds/canon_arc/divergence 是手写资产，制卡器不生成；
 * 重跑只负责补「实体画像 + 关系 + 时间线」这些从原文里抽出来的内容。
 *
 *   node _work/card-enrich.mjs                     # 全本抽取 + 合并，预览写到临时文件
 *   node _work/card-enrich.mjs --write             # 合并结果写回 --out 指定的预设
 *   node _work/card-enrich.mjs --chapters 3        # 只抽前 3 章（冒烟，走缓存）
 *   node _work/card-enrich.mjs --no-merge          # 只产出制卡器结果（不并入预设）
 *
 * 章级缓存由 card-smith 维护（os.tmpdir()/narra-smith-cache/<素材目录哈希>），
 * 中断后重跑只会补缺的章；改素材文件会让对应章缓存自动失效。
 */
import '../server/load-env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChapters, smithCard } from '../server/agents/card-smith.js';
import { normalizeCard, isPerson } from '../server/world/schema.js';
import { lintCard } from '../server/world/lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['write', 'no-merge'].includes(key)) { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dir = path.resolve(ROOT, args.dir || '素材/我在女尊世界捡破烂');
const baseFile = path.resolve(ROOT, args.base || 'presets/nvzun-jianpolan.json');
const outFile = args.out ? path.resolve(ROOT, args.out) : path.join(os.tmpdir(), `card-enrich-${Date.now()}.json`);
const cutoff = Number(args.cutoff ?? 5);
const concurrency = Math.max(1, Math.min(8, Number(args.concurrency ?? 4)));
const maxChapters = Number(args.chapters ?? 0);
const write = Boolean(args.write);
const merge = !args['no-merge'];

if (!fs.existsSync(dir)) { console.error(`素材目录不存在：${dir}`); process.exit(1); }
const chapters = readChapters(dir);
console.log(`素材：${path.relative(ROOT, dir)}｜章节 ${chapters.length}｜抽取 ${maxChapters > 0 ? Math.min(maxChapters, chapters.length) : chapters.length} 章｜并发 ${concurrency}｜cutoff ch${cutoff}`);

const baseRaw = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, 'utf8')) : null;
const base = baseRaw ? normalizeCard(baseRaw.card || {}) : null;
const baseId = baseRaw?.id || 'nvzun-jianpolan';
const baseCoverHue = baseRaw?.cover_hue;
console.log(`底卡：${base ? `${base.title}｜实体 ${base.entities.length}` : '（无，--no-merge 模式）'}`);

const started = Date.now();
let lastLog = 0;
const t0 = Date.now();
const { card: generated, stats } = await smithCard({
  dir,
  title: base?.title || path.basename(dir),
  premise: base?.prompt?.premise || '',
  concurrency,
  maxChapters,
  startAt: 1,
  cutoff,
  player: base?.player || null,
  cache: true,
  onProgress: (p) => {
    const now = Date.now();
    if (p.cached || p.done === p.total || now - lastLog > 20000) {
      lastLog = now;
      const el = ((now - t0) / 1000).toFixed(0);
      console.log(`  [${p.done}/${p.total}] ${p.cached ? '缓存' : p.chapter || ''}`.trimEnd() + `  (${el}s)`);
    }
  },
});
console.log(`抽取完成：${((Date.now() - started) / 1000).toFixed(0)}s｜${JSON.stringify(stats)}`);

/* ── 合并 ─────────────────────────────────────────────────────────── */

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const nonEmpty = (v) => (typeof v === 'number' ? Number.isFinite(v) : str(v) !== '');
const uniq = (list) => {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const key = typeof x === 'string' ? x : JSON.stringify(x);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
};
// 底卡优先：手写的字段不被机器抽取覆盖，空位才由新抽取补
const pick = (a, b) => (nonEmpty(a) ? a : b);

const fieldFilled = { identity: 0, voice: 0, psyche: 0, knowledge: 0, agenda: 0, relations: 0 };
function mergeEntity(oldE, newE) {
  const identity = { age: pick(oldE.identity?.age, newE.identity?.age), appearance: pick(oldE.identity?.appearance, newE.identity?.appearance), background: pick(oldE.identity?.background, newE.identity?.background), station: pick(oldE.identity?.station, newE.identity?.station) };
  const voice = {
    address: { ...(obj(newE.voice?.address) ? newE.voice.address : {}), ...(obj(oldE.voice?.address) ? oldE.voice.address : {}) },
    rhythm: pick(oldE.voice?.rhythm, newE.voice?.rhythm),
    lexicon: uniq([...arr(oldE.voice?.lexicon), ...arr(newE.voice?.lexicon)]),
    never: uniq([...arr(oldE.voice?.never), ...arr(newE.voice?.never)]),
    exemplars: uniq([...arr(oldE.voice?.exemplars), ...arr(newE.voice?.exemplars)]),
  };
  const psyche = {
    traits: uniq([...arr(oldE.psyche?.traits), ...arr(newE.psyche?.traits)]),
    wants: uniq([...arr(oldE.psyche?.wants), ...arr(newE.psyche?.wants)]),
    fears: uniq([...arr(oldE.psyche?.fears), ...arr(newE.psyche?.fears)]),
    hides: uniq([...arr(oldE.psyche?.hides), ...arr(newE.psyche?.hides)]),
    values: uniq([...arr(oldE.psyche?.values), ...arr(newE.psyche?.values)]),
  };
  const knowledge = {
    knows: uniq([...arr(oldE.knowledge?.knows), ...arr(newE.knowledge?.knows)]),
    does_not_know: uniq([...arr(oldE.knowledge?.does_not_know), ...arr(newE.knowledge?.does_not_know)]),
    believes_falsely: uniq([...arr(oldE.knowledge?.believes_falsely), ...arr(newE.knowledge?.believes_falsely)]),
  };
  const agendaKey = (a) => str(a?.goal) || JSON.stringify(a);
  const agenda = [];
  const seenAgenda = new Set();
  for (const a of [...arr(oldE.agenda), ...arr(newE.agenda)]) {
    const k = agendaKey(a);
    if (!k || seenAgenda.has(k)) continue;
    seenAgenda.add(k);
    agenda.push(a);
  }
  const relKey = (r) => `${str(r?.to)}|${str(r?.kind)}`;
  const relations = [];
  const seenRel = new Set();
  for (const r of [...arr(oldE.relations), ...arr(newE.relations)]) {
    const k = relKey(r);
    if (!str(r?.to) || seenRel.has(k)) continue;
    seenRel.add(k);
    relations.push(r);
  }
  if (identity.appearance || identity.background || identity.station || identity.age) fieldFilled.identity++;
  if (voice.rhythm || voice.exemplars.length) fieldFilled.voice++;
  if (psyche.traits.length || psyche.wants.length) fieldFilled.psyche++;
  if (knowledge.knows.length) fieldFilled.knowledge++;
  if (agenda.length) fieldFilled.agenda++;
  if (relations.length) fieldFilled.relations++;

  const merged = {
    ...newE,
    ...oldE,
    id: str(oldE.id) || str(newE.id),
    name: pick(oldE.name, newE.name),
    aliases: uniq([...arr(oldE.aliases), ...arr(newE.aliases)]),
    summary: pick(oldE.summary, newE.summary),
    detail: pick(oldE.detail, newE.detail),
    role: pick(oldE.role, newE.role),
    tags: uniq([...arr(newE.tags), ...arr(oldE.tags)]),
    sources: uniq([...arr(oldE.sources), ...arr(newE.sources)]),
    weight: Math.max(Number(oldE.weight) || 0, Number(newE.weight) || 0),
    reveal: pick(oldE.reveal, newE.reveal),
    canon_from: pick(oldE.canon_from, newE.canon_from),
    pinned: Boolean(oldE.pinned ?? newE.pinned),
    muted: Boolean(oldE.muted ?? newE.muted),
    parent_id: pick(oldE.parent_id, newE.parent_id),
    links: uniq([...arr(oldE.links), ...arr(newE.links)]),
    facets: {
      sensory: pick(oldE.facets?.sensory, newE.facets?.sensory),
      rules: uniq([...arr(oldE.facets?.rules), ...arr(newE.facets?.rules)]),
      consequences: uniq([...arr(oldE.facets?.consequences), ...arr(newE.facets?.consequences)]),
      history: pick(oldE.facets?.history, newE.facets?.history),
    },
  };
  if (isPerson(merged)) Object.assign(merged, { identity, voice, psyche, knowledge, agenda, relations });
  else Object.assign(merged, {
    status: pick(oldE.status, newE.status),
    condition: pick(oldE.condition, newE.condition),
    access: pick(oldE.access, newE.access),
    open_to: pick(oldE.open_to, newE.open_to),
    owner_id: pick(oldE.owner_id, newE.owner_id),
    location_id: pick(oldE.location_id, newE.location_id),
  });
  return merged;
}

function entityIndex(list) {
  const map = new Map();
  for (const e of list) {
    for (const key of [e.id, e.name, ...arr(e.aliases)]) {
      const k = str(key).toLowerCase();
      if (k && !map.has(k)) map.set(k, e);
    }
  }
  return map;
}

function mergeCard(baseCard, genCard) {
  const oldList = arr(baseCard?.entities);
  const newList = arr(genCard?.entities);
  const entities = oldList.map((e) => ({ ...e, identity: { ...(e.identity || {}) }, voice: { ...(e.voice || {}) }, psyche: { ...(e.psyche || {}) }, knowledge: { ...(e.knowledge || {}) }, facets: { ...(e.facets || {}) } }));
  // 底卡实体先占住所有 id/名字/别名；机器抽取的实体按同样的键归并进来。
  // 这样「凌总」「黎婆」这类后文才给出正名的抽取结果会并进底卡的「凌玥」「黎婆」，
  // 而不是在卡里再长出一个重复人物。
  // 索引里存 id 而不是实体对象：合并会替换数组元素，存对象引用会让后续查找指向
  // 一个已不在数组里的旧对象，导致同一实体的第二次合并被写丢。
  const keyIndex = new Map();
  const posById = new Map();
  const indexEntity = (e, pos) => {
    const id = str(e.id);
    posById.set(id, pos);
    for (const key of [e.id, e.name, ...arr(e.aliases)]) {
      const k = str(key).toLowerCase();
      if (k && !keyIndex.has(k)) keyIndex.set(k, id);
    }
  };
  entities.forEach((e, i) => indexEntity(e, i));
  const statsMerge = { matched: 0, baseOnly: 0, genOnly: 0 };
  const matchedOldPos = new Set();
  for (const genE of newList) {
    let hitPos = -1;
    for (const key of [genE.id, genE.name, ...arr(genE.aliases)]) {
      const id = keyIndex.get(str(key).toLowerCase());
      const pos = id === undefined ? undefined : posById.get(id);
      if (pos !== undefined && pos >= 0) { hitPos = pos; break; }
    }
    if (hitPos >= 0) {
      if (hitPos < oldList.length) matchedOldPos.add(hitPos);
      const mergedE = mergeEntity(entities[hitPos], genE);
      entities[hitPos] = mergedE;
      indexEntity(mergedE, hitPos);
      statsMerge.matched++;
    } else {
      const e = { ...genE };
      entities.push(e);
      indexEntity(e, entities.length - 1);
      statsMerge.genOnly++;
    }
  }
  statsMerge.baseOnly = oldList.filter((_, i) => !matchedOldPos.has(i)).length;

  // 第二轮：机器抽取里有些实体的「名字本身就是底卡后来获得的别名」（太女 / 医院 /
  // 皇室）。它们首次出现时还不存在于索引里，会先被建成新实体；后来另一章的实体才把
  // 这个别名带进底卡，于是留下一个同名副本。这里按「底卡实体在合并后的名字/别名」
  // 建索引，把名字命中的机器实体并回底卡原实体（只认底卡这一侧，避免泛称名字连锁）。
  const baseIds = new Set(oldList.map((e) => str(e.id)));
  const baseNameIndex = new Map();
  for (const e of entities) {
    if (!baseIds.has(str(e.id))) continue;
    for (const key of [e.name, ...arr(e.aliases)]) {
      const k = str(key).toLowerCase();
      if (k && !baseNameIndex.has(k)) baseNameIndex.set(k, str(e.id));
    }
  }
  statsMerge.mergedPass2 = 0;
  const keptEntities = [];
  for (const e of entities) {
    const isBase = baseIds.has(str(e.id));
    const ownerId = isBase ? '' : baseNameIndex.get(str(e.name).toLowerCase());
    if (!ownerId || ownerId === str(e.id)) { keptEntities.push(e); continue; }
    const idx = keptEntities.findIndex((x) => str(x.id) === ownerId);
    if (idx < 0) { keptEntities.push(e); continue; }
    keptEntities[idx] = mergeEntity(keptEntities[idx], e);
    statsMerge.mergedPass2++;
  }
  entities.length = 0;
  entities.push(...keptEntities);

  // 别名去歧义：同一个别名被多个实体同时持有（「夫人 / 姐姐 / 女人 / 总裁」这类
  // 泛称）时，实体链接只能命中第一个，lint 也会报 alias_collision；而且它多半是
  // 抽取把「称呼别人的词」挂到了自己身上。策略：底卡手写的别名保留在底卡实体上，
  // 其余实体上的歧义别名剥掉；两侧都是机器抽取的重复别名则全部剥掉。
  const baseAliasOwners = new Map();
  for (const e of oldList) {
    for (const a of arr(e.aliases)) {
      const k = str(a).toLowerCase();
      if (!k) continue;
      if (!baseAliasOwners.has(k)) baseAliasOwners.set(k, new Set());
      baseAliasOwners.get(k).add(str(e.id));
    }
  }
  const aliasOwners = new Map();
  for (const e of entities) {
    for (const a of arr(e.aliases)) {
      const k = str(a).toLowerCase();
      if (!k) continue;
      if (!aliasOwners.has(k)) aliasOwners.set(k, new Set());
      aliasOwners.get(k).add(str(e.id));
    }
  }
  statsMerge.ambiguousAliases = 0;
  statsMerge.prunedAliases = 0;
  for (const [alias, ownerIds] of aliasOwners) {
    if (ownerIds.size <= 1) continue;
    statsMerge.ambiguousAliases++;
    const baseIds = baseAliasOwners.get(alias);
    const keepId = baseIds && baseIds.size === 1 ? [...baseIds][0] : '';
    for (const e of entities) {
      if (!arr(e.aliases).some((a) => str(a).toLowerCase() === alias)) continue;
      if (keepId && str(e.id) === keepId) continue;
      e.aliases = e.aliases.filter((a) => str(a).toLowerCase() !== alias);
      statsMerge.prunedAliases++;
    }
  }

  // 引用归一：名字/别名 → 最终 id；解析不到就丢弃（宁缺勿编）
  const finalIdx = entityIndex(entities);
  const idSet = new Set(entities.map((e) => str(e.id)));
  const toId = (v) => {
    const s = str(v);
    if (!s) return '';
    if (idSet.has(s)) return s;
    const hit = finalIdx.get(s.toLowerCase());
    return hit ? str(hit.id) : '';
  };
  let droppedRefs = 0;
  for (const e of entities) {
    e.links = uniq(arr(e.links).map(toId).filter(Boolean));
    e.parent_id = toId(e.parent_id) || '';
    if (isPerson(e)) {
      const rels = [];
      for (const r of arr(e.relations)) {
        const to = toId(r?.to);
        if (!to || to === str(e.id)) { droppedRefs++; continue; }
        rels.push({ ...r, to });
      }
      e.relations = rels;
    }
  }

  const edges = [];
  for (const edge of arr(baseCard?.edges)) {
    const from = toId(edge?.from);
    const to = toId(edge?.to);
    if (!from || !to || from === to) { droppedRefs++; continue; }
    edges.push({ ...edge, from, to });
  }

  const timeline = [];
  const seenEvt = new Set();
  for (const evt of arr(genCard?.timeline)) {
    const key = `${str(evt?.when)}|${str(evt?.what)}`;
    if (!str(evt?.what) || seenEvt.has(key)) continue;
    seenEvt.add(key);
    const who = uniq(arr(evt?.who).map(toId).filter(Boolean));
    timeline.push({ ...evt, who });
  }
  for (const evt of arr(baseCard?.timeline)) {
    const key = `${str(evt?.when)}|${str(evt?.what)}`;
    if (!str(evt?.what) || seenEvt.has(key)) continue;
    seenEvt.add(key);
    timeline.push(evt);
  }

  // charter：手写规则优先，机器抽取的规则去重后补位（最多 16 条）
  const charter = [];
  for (const rule of [...arr(baseCard?.charter), ...arr(genCard?.charter)]) {
    const text = str(rule?.rule);
    if (!text || charter.length >= 16) continue;
    if (charter.some((x) => str(x.rule) === text)) continue;
    charter.push(typeof rule === 'string' ? { rule: text, kind: 'law' } : { ...rule, rule: text });
  }

  const player = baseCard?.player ? { ...baseCard.player } : genCard?.player;
  if (player?.canon_character) player.canon_character = toId(player.canon_character) || player.canon_character;

  let anchors = arr(baseCard?.anchors).length ? arr(baseCard?.anchors) : arr(genCard?.anchors);
  anchors = anchors.map((a) => {
    const snap = a?.snapshot ? { ...a.snapshot } : a?.snapshot;
    if (snap) {
      if (snap.place_id) snap.place_id = toId(snap.place_id) || snap.place_id;
      if (obj(snap.characters)) {
        const chars = {};
        for (const [name, st] of Object.entries(snap.characters)) {
          const id = toId(name) || name;
          chars[id] = st;
        }
        snap.characters = chars;
      }
    }
    return { ...a, snapshot: snap };
  });

  const merged = {
    ...genCard,
    ...baseCard,
    kind: baseCard?.kind || genCard?.kind,
    subtitle: baseCard?.subtitle || genCard?.subtitle,
    genre: arr(baseCard?.genre).length ? baseCard.genre : genCard?.genre,
    tags: arr(baseCard?.tags).length ? baseCard.tags : genCard?.tags,
    prompt: baseCard?.prompt || genCard?.prompt,
    charter,
    entities,
    timeline,
    edges,
    anchors,
    player,
    source: {
      ...(genCard?.source || {}),
      ...(baseCard?.source || {}),
      chapters: genCard?.source?.chapters || baseCard?.source?.chapters,
      canon_cutoff: genCard?.source?.canon_cutoff || baseCard?.source?.canon_cutoff,
      path: baseCard?.source?.path || genCard?.source?.path || '',
    },
  };
  return { card: normalizeCard(merged), stats: statsMerge, droppedRefs };
}

if (!merge) {
  const card = normalizeCard(generated);
  const lint = lintCard(card);
  console.log(`制卡结果：实体 ${card.entities.length}（人物 ${card.entities.filter(isPerson).length}）｜时间线 ${card.timeline.length}｜charter ${card.charter.length}`);
  console.log(`lint：${JSON.stringify(lint.counts)}`);
  fs.writeFileSync(outFile, JSON.stringify({ id: baseId, title: card.title, subtitle: card.subtitle, cover_hue: baseCoverHue, tags: card.tags, source: card.source, card }, null, 1));
  console.log(`已写出：${outFile}`);
  process.exit(0);
}

if (!base) { console.error('没有底卡可合并（--no-merge 只看制卡结果）'); process.exit(1); }
const merged = mergeCard(base, generated);
const card = merged.card;
const lint = lintCard(card);

const persons = card.entities.filter(isPerson);
const facts = card.entities.filter((e) => !isPerson(e));
const coverage = {
  persons: persons.length,
  facts: facts.length,
  withAppearance: persons.filter((e) => str(e.identity?.appearance)).length,
  withBackground: persons.filter((e) => str(e.identity?.background)).length,
  withRhythm: persons.filter((e) => str(e.voice?.rhythm)).length,
  withExemplars: persons.filter((e) => arr(e.voice?.exemplars).length).length,
  withTraits: persons.filter((e) => arr(e.psyche?.traits).length).length,
  withWants: persons.filter((e) => arr(e.psyche?.wants).length).length,
  withFears: persons.filter((e) => arr(e.psyche?.fears).length).length,
  withHides: persons.filter((e) => arr(e.psyche?.hides).length).length,
  withValues: persons.filter((e) => arr(e.psyche?.values).length).length,
  withKnowledge: persons.filter((e) => arr(e.knowledge?.knows).length).length,
  withAgenda: persons.filter((e) => arr(e.agenda).length).length,
  withRelations: persons.filter((e) => arr(e.relations).length).length,
  withFacets: facts.filter((e) => str(e.facets?.sensory) || arr(e.facets?.rules).length).length,
  withTags: card.entities.filter((e) => arr(e.tags).length).length,
  withSources: card.entities.filter((e) => arr(e.sources).length).length,
  timelinePast: card.timeline.filter((e) => e.canon === 'past').length,
  timelineFuture: card.timeline.filter((e) => e.canon === 'future').length,
  edges: card.edges.length,
  links: card.entities.reduce((s, e) => s + arr(e.links).length, 0),
  anchors: card.anchors.length,
  charter: card.charter.length,
  seeds: arr(card.seeds).length,
  authorNotes: arr(card.author_notes).length,
};

console.log('\n合并：', JSON.stringify(merged.stats), '｜丢弃引用', merged.droppedRefs);
console.log('覆盖度：', JSON.stringify(coverage, null, 1));
console.log('lint：', JSON.stringify(lint.counts));
for (const issue of lint.issues.slice(0, 12)) console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
if (lint.issues.length > 12) console.log(`  … 其余 ${lint.issues.length - 12} 条`);

const report = {
  generated: stats, merge: merged.stats, droppedRefs: merged.droppedRefs,
  coverage, lint: { counts: lint.counts, issues: lint.issues },
  baseFile: path.relative(ROOT, baseFile), dir: path.relative(ROOT, dir), cutoff,
};
const reportFile = args.report ? path.resolve(ROOT, args.report) : path.join(os.tmpdir(), `card-enrich-report-${Date.now()}.json`);
fs.writeFileSync(reportFile, JSON.stringify(report, null, 1));

const outPayload = {
  id: baseId,
  title: card.title,
  subtitle: card.subtitle,
  cover_hue: baseCoverHue,
  tags: card.tags,
  source: card.source,
  card,
};
if (write) {
  const backup = path.join(os.tmpdir(), `nvzun-jianpolan-backup-${Date.now()}.json`);
  if (fs.existsSync(outFile)) fs.copyFileSync(outFile, backup);
  fs.writeFileSync(outFile, JSON.stringify(outPayload, null, 1));
  console.log(`\n已写回：${path.relative(ROOT, outFile)}`);
} else {
  fs.writeFileSync(outFile, JSON.stringify(outPayload, null, 1));
  console.log(`\n预览已写出：${outFile}（加 --write 才写回预设）`);
}
console.log(`报告：${reportFile}`);
