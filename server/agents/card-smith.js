/**
 * server/agents/card-smith.js — 制卡流水线（Card Smith）
 *
 * 把一部小说（或任意设定素材）抽成一张 v5 世界卡。这是**一次性的长任务**，
 * 不是运行时行为：跑完得到一张可复用的世界沙盒。
 *
 * 流水线（按章并行 → 合并仲裁 → 定格）：
 *   1. 按章抽取：每章一个子任务，产出实体（含人物内在/声线）/ 关系 / 事件 / 台词 / 世界规则
 *   2. 合并仲裁：跨章去重、别名归并，每条都带出处（第几章）
 *   3. 定格 pass：把合并结果冻结成「起点那一刻」的卡——按章出处切 cutoff、
 *      裁剪文本、按同章共现补事实实体之间的 links
 *   4. 切时间线：cutoff 之前的事件标 past，之后标 future（只作参考走向，永不注入）
 *   5. 生成快照：起点那一刻谁在场、什么状态、谁知道什么
 *   6. 产出卡：故事方向 / 世界规则 / 实体（人物 + 世界事实）/ 时间线 / 开局点
 *
 * 关键规则：
 *   - 只抽「起点之前的剧情」作为 canon。后续章节的事件标 future，默认不注入。
 *   - 人物内在（外形、身份、欲望、恐惧、秘密、说话方式）可以来自全书；
 *     但「她在第 80 章杀了谁」不能变成起点时的知识、关系或目标。
 *   - 开场种子是新写的，不抄原文。原文只用来做声音样本；exemplars 必须逐字来自原文。
 *   - 抽取结果按章缓存在系统临时目录，断点续跑不重复花钱。缓存只是省成本，
 *     删掉重跑结果一致（指纹 = 抽取版本 + 文件名 + 文本长度 + 大小/mtime）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chat } from '../llm.js';
import { normalizeCard, isPerson, PERSON_TYPE } from '../world/schema.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const clamp01 = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : 0.5);
const clampSym = (v) => (Number.isFinite(Number(v)) ? Math.max(-1, Math.min(1, Number(v))) : 0);
const stripRef = (v) => str(v).replace(/^(?:cast|codex):/, '');

/** 单条文本按上限裁剪（换行压成空格），空串返回空串。 */
const clip = (v, maxLen) => {
  const s = str(v).replace(/\s+/g, ' ');
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
};

/** 字符串数组去空、去重、保序。 */
const dedupe = (list) => {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const s = str(item);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

/** 字符串数组：逐条裁剪 → 去重 → 截断条数。 */
const clipList = (list, maxLen, maxCount = 3) =>
  dedupe(arr(list).map((v) => clip(v, maxLen)).filter(Boolean)).slice(0, maxCount);

/* ══════════════════════════════════════════════════════════════════════ */
/* 章节读取                                                               */
/* ══════════════════════════════════════════════════════════════════════ */

/** 按文件名里的数字排序读取目录下的 .txt 章节。 */
export function readChapters(dir) {
  if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
  const files = fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.txt'))
    .map((f) => {
      const m = f.match(/(\d+)/);
      return { file: f, no: m ? Number(m[1]) : Number.MAX_SAFE_INTEGER, raw: f.replace(/\.txt$/i, '') };
    })
    .sort((a, b) => a.no - b.no || a.file.localeCompare(b.file));
  return files.map((f, i) => ({
    index: i + 1,
    no: f.no,
    title: f.raw.replace(/^第\s*\d+\s*章\s*/, '').trim() || f.raw,
    file: f.file,
    text: fs.readFileSync(path.join(dir, f.file), 'utf8').replace(/^\uFEFF/, '').trim(),
  }));
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 1. 按章抽取                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

function chapterExtractSystem() {
  return `# 身份
你是世界卡制卡师。你读一章小说，抽出**可复用的世界设定**。你不总结剧情，你建档案。

# 输出要求
只输出一个纯 JSON 对象：
{
  "entities": [
    {
      "kind": "character|place|institution|faction|item|concept",
      "name": "", "aliases": [], "summary": "一句话", "detail": "这个实体是什么，200字内",
      "appearance": "外形，60字内（仅角色）",
      "station": "身份/职业/地位，40字内（仅角色）",
      "traits": ["性格特质，最多3条（仅角色）"],
      "wants": ["想要什么，最多3条（仅角色）"],
      "fears": ["害怕什么，最多3条（仅角色）"],
      "values": ["看重什么，最多3条（仅角色）"],
      "hides": ["隐瞒的、不愿示人的一面，最多3条（仅角色）"],
      "knowledge": {"knows": ["已经知道的事"], "does_not_know": ["明确不知道的事"], "believes_falsely": ["误信的事"]},
      "agenda": [{"goal": "此刻想达成什么", "method": "打算怎么做", "pressure": 0.5, "deadline": "期限，可空"}],
      "voice": {
        "address": {"对谁": "怎么称呼"},
        "rhythm": "说话节奏/句式，一句话",
        "lexicon": ["口头禅、常用词"],
        "never": ["绝不会说的词或句式"]
      }
    }
  ],
  "relations": [
    {"from": "", "to": "", "kind": "短语", "sentiment": 0.5, "note": "关系的本质，一句话"}
  ],
  "events": [
    {"when": "章内的时间描述", "what": "发生了什么，一句话", "who": [], "significant": true}
  ],
  "voices": [
    {"who": "", "text": "原文里的一句台词，逐字照抄，不超过40字"}
  ],
  "rules": ["本章确立的世界规则/制度/礼法，一条一句"]
}

# 硬性要求
1. entities 的 name 用文中的正式名称。aliases 收文中出现的其他叫法。
2. 只收本章**真正出现**的实体。跨章才拼出全貌，不要凭常识补。
3. 角色专属字段（appearance / station / traits / wants / fears / values / hides / knowledge / agenda / voice）只对 kind=character 填；其他实体留空数组或空串。
4. knowledge 只写「到本章结束时这个角色已经知道的事」。她不知道的写 does_not_know，误信写 believes_falsely。不要写后续章节才揭示的真相。
5. agenda 是角色此刻想做的事；pressure 是 0~1 的紧迫度。
6. voice 描述说话方式：address 是称呼习惯；lexicon 是口头禅；never 是从不说的词；rhythm 是句子节奏。这些可以来自本章对她的描写，不必都有。
7. relations 的 from / to 用 entities 里的 name。
8. events 的 significant: true 只给「改变了局势或关系」的事。日常推进不给。
9. voices 必须是从正文里**逐字照抄**的台词（连标点一起），不许改写、不许自己写；原文没有引号就不要自己加。每个有台词的角色至少给 2 条，本章确实只有一句就给实际有的那一句。
10. rules 只写本章明确写出或明确演示的规矩。
11. 没有内容的字段给空数组或空串。宁可少收，不许编。`;
}

function chapterExtractUser({ chapter, index, total }) {
  return `【章节】第 ${index}/${total} 章 · ${chapter.title}\n\n${chapter.text}\n\n请按 schema 输出纯 JSON。`;
}

async function extractChapter(chapter, index, total, { signal } = {}) {
  const res = await chat({
    agent: 'cardSmith',
    messages: [
      { role: 'system', content: chapterExtractSystem() },
      { role: 'user', content: chapterExtractUser({ chapter, index, total }) },
    ],
    temperature: null,
    maxTokens: null,
    reasoningEffort: null,
    responseFormat: { type: 'json_object' },
    signal,
  });
  return parseChapterExtract(res.content, index);
}

/**
 * 归一单章抽取结果。字段上限这里放宽一点，定格 pass 再统一裁到运行时口径；
 * 模型多给的条目一律按上限截断，缺的字段给空值（宁缺勿编）。
 */
export function parseChapterExtract(content, index) {
  const text = String(content || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* 降级 */ } }
  }
  const p = obj(parsed);
  return {
    chapter: index,
    entities: arr(p.entities).map((e) => {
      const o = obj(e);
      const v = obj(o.voice);
      return {
        kind: ['character', 'place', 'institution', 'faction', 'item', 'concept'].includes(o.kind) ? o.kind : 'concept',
        name: str(o.name),
        aliases: arr(o.aliases).map(str).filter(Boolean).slice(0, 6),
        summary: str(o.summary).slice(0, 120),
        detail: str(o.detail).slice(0, 400),
        appearance: str(o.appearance).slice(0, 120),
        station: str(o.station).slice(0, 40),
        traits: arr(o.traits).map(str).filter(Boolean).slice(0, 3),
        wants: arr(o.wants).map(str).filter(Boolean).slice(0, 3),
        fears: arr(o.fears).map(str).filter(Boolean).slice(0, 3),
        values: arr(o.values).map(str).filter(Boolean).slice(0, 3),
        hides: arr(o.hides).map(str).filter(Boolean).slice(0, 3),
        knowledge: {
          knows: arr(obj(o.knowledge).knows).map(str).filter(Boolean).slice(0, 3),
          does_not_know: arr(obj(o.knowledge).does_not_know).map(str).filter(Boolean).slice(0, 3),
          believes_falsely: arr(obj(o.knowledge).believes_falsely).map(str).filter(Boolean).slice(0, 3),
        },
        agenda: arr(o.agenda).map((a) => {
          const g = obj(a);
          return {
            goal: str(g.goal).slice(0, 120),
            method: str(g.method).slice(0, 80),
            pressure: clamp01(g.pressure),
            deadline: str(g.deadline).slice(0, 40),
          };
        }).filter((a) => a.goal).slice(0, 3),
        voice: {
          address: Object.fromEntries(
            Object.entries(obj(v.address))
              .map(([k, val]) => [str(k).slice(0, 20), str(val).slice(0, 40)])
              .filter(([k, val]) => k && val)
              .slice(0, 4),
          ),
          rhythm: str(v.rhythm).slice(0, 120),
          lexicon: arr(v.lexicon).map(str).filter(Boolean).slice(0, 5),
          never: arr(v.never).map(str).filter(Boolean).slice(0, 5),
        },
      };
    }).filter((e) => e.name),
    relations: arr(p.relations).map((r) => {
      const o = obj(r);
      return {
        from: str(o.from), to: str(o.to), kind: str(o.kind).slice(0, 40),
        sentiment: clampSym(o.sentiment),
        note: str(o.note).slice(0, 200),
      };
    }).filter((r) => r.from && r.to && r.from !== r.to),
    events: arr(p.events).map((e) => {
      const o = obj(e);
      return {
        when: str(o.when).slice(0, 60),
        what: str(o.what).slice(0, 200),
        who: arr(o.who).map(str).filter(Boolean),
        significant: o.significant === false ? false : true,
      };
    }).filter((e) => e.what),
    voices: arr(p.voices).map((v) => {
      const o = obj(v);
      return { who: str(o.who), text: str(o.text).slice(0, 80) };
    }).filter((v) => v.who && v.text),
    rules: arr(p.rules).map(str).filter(Boolean).slice(0, 20),
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 2. 合并仲裁（确定性去重 + 别名归并）                                    */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 名字相同或别名相交 → 视为同一实体。
 * 每一章的抽取结果都留在 sources 里，定格 pass 才能按 cutoff 取「起点前」的
 * 知识/关系/目标，而不是被后章覆盖。
 */
function mergeEntities(chapters) {
  const out = [];
  for (const ch of chapters) {
    for (const e of ch.entities) {
      const hit = out.find((x) => x.name === e.name || x.aliases.some((a) => e.aliases.includes(a) || a === e.name));
      if (hit) {
        hit.chapters.push(ch.chapter);
        hit.sources.push({ chapter: ch.chapter, e });
        hit.aliases = [...new Set([...hit.aliases, ...e.aliases])];
        if (e.detail.length > hit.detail.length) hit.detail = e.detail;
        if (!hit.summary) hit.summary = e.summary;
      } else {
        out.push({ ...e, chapters: [ch.chapter], sources: [{ chapter: ch.chapter, e }] });
      }
    }
  }
  return out;
}

function mergeRelations(chapters, entities) {
  const names = new Set(entities.map((e) => e.name));
  const out = [];
  for (const ch of chapters) {
    for (const r of ch.relations) {
      // 只保留两端都能在实体表里找到的关系
      if (!names.has(r.from) || !names.has(r.to)) continue;
      const hit = out.find((x) => x.from === r.from && x.to === r.to);
      if (hit) {
        hit.chapters.push(ch.chapter);
        hit.sentiment = r.sentiment;
        if (r.note) hit.note = r.note;
        if (r.kind) hit.kind = r.kind;
      } else {
        out.push({ ...r, chapters: [ch.chapter] });
      }
    }
  }
  return out;
}

function mergeEvents(chapters) {
  const out = [];
  for (const ch of chapters) {
    for (const e of ch.events) {
      if (!e.significant) continue;
      const hit = out.find((x) => similarity(x.what, e.what) >= 0.6);
      if (hit) hit.chapters.push(ch.chapter);
      else out.push({ ...e, chapters: [ch.chapter] });
    }
  }
  return out.sort((a, b) => a.chapters[0] - b.chapters[0]);
}

function mergeVoices(chapters) {
  const out = [];
  const seen = new Set();
  for (const ch of chapters) {
    for (const v of ch.voices) {
      const key = `${v.who}::${v.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...v, chapter: ch.chapter });
    }
  }
  return out;
}

function mergeRules(chapters) {
  const out = [];
  for (const ch of chapters) {
    for (const r of ch.rules) {
      if (!out.some((x) => similarity(x, r) >= 0.6)) out.push(r);
    }
  }
  return out;
}

function similarity(a, b) {
  const na = String(a || '').replace(/[\s，。、；：？！""''（）()「」『』]/g, '');
  const nb = String(b || '').replace(/[\s，。、；：？！""''（）()「」『』]/g, '');
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const bi = (s) => { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; };
  const A = bi(na); const B = bi(nb);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, A.size + B.size - inter);
}

/** 实体在「起点之前」的抽取记录；起点前为空就退到最早一章，避免卡司全是空壳。 */
function sourcesBefore(entity, cutoff) {
  const sources = [...arr(entity.sources)].sort((a, b) => a.chapter - b.chapter);
  if (!Number.isFinite(cutoff)) return sources;
  const before = sources.filter((s) => s.chapter < cutoff);
  return before.length ? before : sources.slice(0, 1);
}

/** 同一实体跨章字段：取第一处非空。 */
function firstField(sources, key) {
  for (const s of sources) {
    const v = str(s.e?.[key]);
    if (v) return v;
  }
  return '';
}

/** 同一实体跨章列表字段：按上限合并。 */
function collectField(sources, key, maxLen = 40, maxCount = 3) {
  return clipList(sources.flatMap((s) => arr(s.e?.[key])), maxLen, maxCount);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 3. 组装成 v5 世界卡                                                    */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 抽取阶段的 kind → v5 实体 type。
 * 抽取契约（EXTRACT_VERSION）不变：character 仍是抽取时的叫法，落卡时统一成 person。
 */
const KIND_TO_TYPE = {
  character: PERSON_TYPE, place: 'place', institution: 'institution',
  faction: 'faction', item: 'item', concept: 'concept',
};

/**
 * 把合并后的素材组装成 v5 卡，并跑一遍定格 pass。
 * @param {object} args
 * @param {Array}  args.chapters   各章抽取结果（{chapter, entities, relations, events, voices, rules}）
 * @param {string} args.title
 * @param {string} [args.premise]  命题（作者给；不给则留空由作者补）
 * @param {number} [args.startAt]  起点章节序号（默认 1 = 序章）
 * @param {number} [args.cutoff]   canon 截止章（默认 = startAt；之前的章节才算 past）
 * @param {string} [args.openingSeed] 开场种子（新写，不抄原文）
 * @param {object} [args.player]   玩家角色
 * @param {Array<string>} [args.sourceTexts] 原文；只用来校验 exemplars 是否逐字来自原文
 */
function resolveCut(cutoff, startAt) {
  // cutoff 缺省时用起点章；null/空串/非正数都别被 Number() 悄悄转成 0
  const raw = cutoff !== null && cutoff !== undefined && cutoff !== '' ? Number(cutoff) : Number(startAt);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function buildCardFromExtracts({
  chapters, title, premise = '', startAt = 1, cutoff = null, openingSeed = '', player = null,
  sourceTexts = null, source = null,
}) {
  const cut = resolveCut(cutoff, startAt);
  const entities = mergeEntities(chapters);
  const relations = mergeRelations(chapters, entities);
  const events = mergeEvents(chapters);
  const voices = mergeVoices(chapters);
  const rules = mergeRules(chapters);

  const byName = new Map();
  for (const e of entities) for (const key of [e.name, ...e.aliases]) if (key && !byName.has(key)) byName.set(key, e);
  const nameOf = (ref) => byName.get(str(ref))?.name || '';

  // 起点之前出现过的章：初始关系/写作知识只从这些章取，后章的不能倒灌
  const initialChapters = new Set(chapters.filter((c) => c.chapter < cut).map((c) => c.chapter));
  const firstChapter = chapters[0]?.chapter ?? 1;

  // 实体的出处：按章去重成 sources；合卡后每条实体都保留「第几章出现」
  const sourcesFor = (list) => [...new Set(list.map((s) => s.chapter))].sort((a, b) => a - b)
    .map((ch) => ({ kind: 'novel', ref: `ch.${ch}`, chapter: ch }));

  const persons = entities.filter((e) => e.kind === 'character').map((e) => {
    const allSources = [...arr(e.sources)].sort((a, b) => a.chapter - b.chapter);
    const atStart = sourcesBefore(e, cut);
    const keys = new Set([e.name, ...e.aliases]);

    // 外形/声线/性格可以来自全书（提示词允许），但 knowledge / agenda / relations 必须按 cutoff 取
    const voice = { address: {}, rhythm: '', lexicon: [], never: [] };
    for (const s of allSources) {
      const v = s.e?.voice;
      if (!v) continue;
      if (!voice.rhythm && v.rhythm) voice.rhythm = v.rhythm;
      for (const [k, val] of Object.entries(obj(v.address))) if (!voice.address[k] && val) voice.address[k] = val;
      voice.lexicon.push(...arr(v.lexicon));
      voice.never.push(...arr(v.never));
    }

    const agenda = [];
    for (const s of atStart) {
      for (const a of arr(s.e?.agenda)) {
        if (!a.goal || agenda.some((x) => x.goal === a.goal)) continue;
        agenda.push({ goal: a.goal, method: a.method, pressure: a.pressure, deadline: a.deadline });
      }
    }

    const rels = [];
    const seenTo = new Set();
    for (const r of relations) {
      if (nameOf(r.from) !== e.name) continue;
      const chs = arr(r.chapters);
      const initial = initialChapters.size
        ? chs.some((c) => initialChapters.has(c))
        : chs.includes(firstChapter);
      if (!initial) continue;
      const to = nameOf(r.to) || stripRef(r.to);
      if (!to || to === e.name || seenTo.has(to)) continue;
      seenTo.add(to);
      rels.push({ to, kind: r.kind, sentiment: r.sentiment, note: r.note });
    }

    const preSources = allSources.filter((s) => s.chapter < cut);
    const knowledge = {
      knows: clipList(preSources.flatMap((s) => arr(s.e?.knowledge?.knows)), 40, 3),
      does_not_know: clipList(preSources.flatMap((s) => arr(s.e?.knowledge?.does_not_know)), 40, 3),
      believes_falsely: clipList(preSources.flatMap((s) => arr(s.e?.knowledge?.believes_falsely)), 40, 3),
    };

    return {
      id: e.name,
      type: PERSON_TYPE,
      name: e.name,
      aliases: e.aliases,
      tags: [],
      summary: e.summary,
      detail: e.detail,
      facets: { sensory: '', rules: [], consequences: [], history: '' },
      links: [],
      reveal: 'public',
      canon_from: 'prologue',
      sources: sourcesFor(allSources),
      pinned: false,
      muted: false,
      parent_id: '',
      role: e.summary,
      identity: {
        age: '',
        appearance: firstField(allSources, 'appearance'),
        station: firstField(allSources, 'station'),
        background: e.detail,
      },
      voice: {
        ...voice,
        exemplars: voices.filter((v) => keys.has(v.who)).map((v) => v.text),
      },
      psyche: {
        traits: collectField(allSources, 'traits', 40, 3),
        wants: collectField(allSources, 'wants', 40, 3),
        fears: collectField(allSources, 'fears', 40, 3),
        hides: collectField(allSources, 'hides', 40, 3),
        values: collectField(allSources, 'values', 40, 3),
      },
      knowledge,
      agenda: agenda.slice(0, 3),
      relations: rels.slice(0, 8),
      always_present: false,
      weight: e.chapters.length >= 5 ? 0.9 : e.chapters.length >= 2 ? 0.6 : 0.3,
      // 运行期初始值：定格只写静态卡，状态从空开始
      status: '', condition: '', mood: '', location: '', goal: '',
    };
  });

  const facts = entities
    .filter((e) => e.kind !== 'character')
    .map((e) => {
      const allSources = [...arr(e.sources)].sort((a, b) => a.chapter - b.chapter);
      return {
        id: e.name,
        type: KIND_TO_TYPE[e.kind] || 'custom',
        name: e.name,
        aliases: e.aliases,
        tags: [],
        summary: e.summary,
        detail: e.detail,
        facets: { sensory: '', rules: [], consequences: [], history: e.detail },
        links: [],
        reveal: 'public',
        canon_from: 'prologue',
        sources: sourcesFor(allSources),
        pinned: false,
        muted: false,
        parent_id: '',
        // 运行期初始值：定格只写静态卡，事实实体的访问/归属从空开始
        status: '', condition: '', access: '', open_to: '', owner_id: '', location_id: '',
      };
    });

  const cardEntities = [...persons, ...facts];

  const timeline = events.map((e, i) => ({
    id: `evt-${String(i + 1).padStart(3, '0')}`,
    when: e.when,
    what: e.what,
    who: e.who.map((w) => nameOf(w) || stripRef(w)).filter(Boolean),
    source: `ch.${e.chapters[0]}`,
    // 红线 3：cutoff 之后的章节是 future，只作校勘参考，永不注入
    canon: e.chapters[0] < cut ? 'past' : 'future',
  }));

  const charter = rules.slice(0, 12).map((r) => ({ rule: r, kind: 'law' }));

  // 起点快照：起点那一刻已经登场的人 + 起点章（含之前最近一章）的地点
  const startChapter = chapters.find((c) => c.chapter === cut) || chapters[0];
  const anchorPlace = (() => {
    const fromStart = startChapter?.entities.find((e) => e.kind === 'place')?.name;
    if (fromStart) return fromStart;
    const before = chapters.filter((c) => c.chapter <= cut).sort((a, b) => b.chapter - a.chapter);
    for (const c of before) {
      const hit = c.entities.find((e) => e.kind === 'place')?.name;
      if (hit) return hit;
    }
    return '';
  })();
  const snapshotChars = {};
  for (const e of entities) {
    if (e.kind !== 'character') continue;
    if (!arr(e.sources).some((s) => s.chapter <= cut)) continue;
    const sources = sourcesBefore(e, cut);
    const goal = sources.flatMap((s) => arr(s.e?.agenda)).map((a) => str(a?.goal)).find(Boolean) || '';
    snapshotChars[e.name] = { mood: '', condition: '', location: '', goal: clip(goal, 40) };
  }
  const pastEvents = timeline.filter((e) => e.canon === 'past');

  // 来源元数据：lint 的 future 泄漏检查与详情页「改编自」都依赖它。
  // smithCard 传整本素材的章数；单独调用 buildCardFromExtracts 时只记已提供的章。
  const sourceMeta = source || (chapters.length ? { kind: 'novel', title, chapters: chapters.length } : null);

  const card = normalizeCard({
    title,
    kind: 'adapted',
    premise,
    source: sourceMeta
      ? {
        kind: sourceMeta.kind || 'novel',
        title: sourceMeta.title || title,
        chapters: sourceMeta.chapters || chapters.length,
        canon_cutoff: sourceMeta.canon_cutoff || `ch${cut}`,
        path: sourceMeta.path || '',
      }
      : null,
    charter,
    entities: cardEntities,
    timeline,
    anchors: [{
      id: 'prologue',
      label: `序章 · ${startChapter?.title || '开局'}`,
      after_event: '',
      snapshot: {
        time: '',
        place: anchorPlace,
        place_id: anchorPlace,
        characters: snapshotChars,
        inventory: [],
        last_hook: pastEvents.length ? pastEvents[pastEvents.length - 1].what : '',
      },
      opening_seed: openingSeed,
    }],
    player: player || { name: '主角', mode: 'original' },
    author_notes: [],
  });

  return finalizeCard(card, { chapters, sourceTexts });
}

/**
 * 定格 pass：把合并结果凝练成「可以直接进运行时」的卡。
 * 纯函数、不调模型、可重复执行；宁缺勿编。
 * - 文本按运行时口径裁剪：appearance ≤60、background ≤160、其余每条 ≤40
 * - 人物与事实同住 entities，按 type 分派后各自裁剪；引用一律归一成裸 id
 * - links 只按「同章共现」生成：同一章出现的两个事实实体互链，不调模型、不依赖名字名单
 * - exemplars 必须是原文里逐字出现过的台词，模型编的句子直接丢
 */
export function finalizeCard(card, { chapters = [], sourceTexts = null } = {}) {
  const next = JSON.parse(JSON.stringify(card || {}));
  const rawText = sourceTexts ? arr(sourceTexts).join('\n').replace(/\s+/g, '') : '';
  const all = arr(next.entities);
  const persons = all.filter(isPerson);
  const facts = all.filter((e) => !isPerson(e));
  const idOf = (e) => str(e.id) || str(e.name);

  // 名字 / 别名 / id 都归一到实体表，卡里只允许出现裸 id
  const idByKey = new Map();
  for (const e of all) {
    for (const key of [e.id, e.name, ...arr(e.aliases)]) {
      const k = str(key);
      if (k && !idByKey.has(k)) idByKey.set(k, idOf(e));
    }
  }

  for (const c of persons) {
    c.summary = clip(c.summary, 60);
    c.role = clip(c.role, 40);
    c.identity = obj(c.identity);
    c.identity.appearance = clip(c.identity.appearance, 60);
    c.identity.background = clip(c.identity.background, 160);
    c.identity.station = clip(c.identity.station, 40);
    c.voice = obj(c.voice);
    c.voice.address = Object.fromEntries(
      Object.entries(obj(c.voice.address))
        .map(([k, v]) => [clip(k, 20), clip(v, 20)])
        .filter(([k, v]) => k && v)
        .slice(0, 4),
    );
    c.voice.rhythm = clip(c.voice.rhythm, 60);
    c.voice.lexicon = clipList(c.voice.lexicon, 20, 5);
    c.voice.never = clipList(c.voice.never, 20, 5);
    let exemplars = clipList(c.voice.exemplars, 80, 6);
    if (rawText) exemplars = exemplars.filter((t) => t.length >= 4 && rawText.includes(t.replace(/\s+/g, '')));
    c.voice.exemplars = exemplars.slice(0, 3);
    c.psyche = obj(c.psyche);
    for (const key of ['traits', 'wants', 'fears', 'hides', 'values']) c.psyche[key] = clipList(c.psyche[key], 40, 3);
    c.knowledge = obj(c.knowledge);
    for (const key of ['knows', 'does_not_know', 'believes_falsely']) c.knowledge[key] = clipList(c.knowledge[key], 40, 3);
    const goals = new Set();
    c.agenda = arr(c.agenda).map((a) => {
      const o = obj(a);
      return {
        goal: clip(o.goal, 40),
        method: clip(o.method, 40),
        pressure: clamp01(o.pressure),
        deadline: clip(o.deadline, 40),
      };
    }).filter((a) => {
      if (!a.goal || goals.has(a.goal)) return false;
      goals.add(a.goal);
      return true;
    }).slice(0, 3);
  }

  for (const e of facts) {
    e.summary = clip(e.summary, 120);
    e.detail = clip(e.detail, 400);
    e.facets = obj(e.facets);
    e.facets.history = clip(e.facets.history, 200);
  }

  // 同章共现只发生在事实实体之间；links 只记裸 id
  const factIds = new Set(facts.map(idOf));
  const linkMap = new Map();
  for (const e of facts) {
    const seeded = arr(e.links)
      .map((x) => str(idByKey.get(stripRef(x))) || stripRef(x))
      .filter(Boolean);
    linkMap.set(idOf(e), seeded);
  }
  const seenPairs = new Set();
  for (const ch of chapters) {
    const ids = [];
    for (const ent of arr(ch.entities)) {
      if (ent.kind === 'character') continue;
      const id = idByKey.get(str(ent.name))
        || arr(ent.aliases).map((a) => idByKey.get(str(a))).find(Boolean);
      if (id && factIds.has(id) && !ids.includes(id)) ids.push(id);
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        linkMap.get(a).push(b);
        linkMap.get(b).push(a);
      }
    }
  }
  for (const e of facts) {
    const own = idOf(e);
    e.links = dedupe(linkMap.get(own) || []).filter((x) => x !== own && factIds.has(x)).slice(0, 8);
  }

  // 关系：to 归一为人物 id；指向事实、坏引用与自环都丢弃
  const personIds = new Set(persons.map(idOf));
  for (const c of persons) {
    const own = idOf(c);
    const seen = new Set();
    const rels = [];
    for (const r of arr(c.relations)) {
      const o = obj(r);
      const to = str(idByKey.get(stripRef(o.to)));
      if (!to || to === own || !personIds.has(to) || seen.has(to)) continue;
      seen.add(to);
      rels.push({
        to,
        kind: clip(o.kind, 20),
        sentiment: clampSym(o.sentiment),
        note: clip(o.note, 60),
      });
    }
    c.relations = rels.slice(0, 8);
  }

  next.entities = all;
  return normalizeCard(next);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 4. 断点续跑（按章缓存）                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

/** 抽取契约的版本号：提示词/字段语义改了就 +1，旧缓存自然失效。 */
const EXTRACT_VERSION = 3;

/** 缓存目录：系统临时目录下按素材目录分桶。缓存可随时删，删掉重跑结果一致。 */
function defaultCacheRoot(dir) {
  const digest = createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'narra-smith-cache', digest);
}

/**
 * 章节指纹：抽取版本 + 文件名 + 文本长度 + 文件大小/mtime。
 * 只看 stat 不读全文，目录大时也不会重复 IO。
 */
function fingerprintOf(dir, chapter) {
  let size = 0;
  let mtimeMs = 0;
  try {
    const st = fs.statSync(path.join(dir, chapter.file));
    size = st.size;
    mtimeMs = Math.round(st.mtimeMs);
  } catch { /* 读不到就用空指纹，缓存自然失效 */ }
  return createHash('sha1')
    .update([EXTRACT_VERSION, chapter.file, chapter.text.length, size, mtimeMs].join('|'))
    .digest('hex');
}

function readCachedExtract(root, index, fingerprint) {
  try {
    const file = path.join(root, `${String(index + 1).padStart(3, '0')}.json`);
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached?.version !== EXTRACT_VERSION || cached?.fingerprint !== fingerprint) return null;
    if (!cached.extract || typeof cached.extract !== 'object') return null;
    return cached.extract;
  } catch {
    return null;
  }
}

let cacheWarned = false;
function writeCachedExtract(root, index, fingerprint, extract) {
  try {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, `${String(index + 1).padStart(3, '0')}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: EXTRACT_VERSION, fingerprint, extract }));
    fs.renameSync(tmp, file);
  } catch (err) {
    if (!cacheWarned) {
      cacheWarned = true;
      console.warn(`[card-smith] 章节缓存写入失败（不影响本次制卡）：${err?.message || err}`);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 5. 长任务入口                                                          */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 跑完整流水线。按章并行抽取，可中断可续跑（已完成的章直接读缓存）。
 *
 * @param {object} args
 * @param {string} args.dir       章节目录
 * @param {string} args.title     卡标题
 * @param {string} [args.premise]
 * @param {number} [args.concurrency] 并行度
 * @param {number} [args.maxChapters] 最多抽多少章（默认全部）
 * @param {number} [args.startAt]  起点章节（默认 1）
 * @param {number} [args.cutoff]   canon 截止章（默认 = startAt）
 * @param {string} [args.openingSeed]
 * @param {object} [args.player]
 * @param {function} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @param {function} [args.extract] 注入式抽取（测试/离线用；默认调模型）
 * @param {string} [args.cacheDir] 缓存目录（默认系统临时目录）
 * @param {boolean} [args.cache]   是否读写章节缓存（默认 true）
 * @returns {Promise<{card, stats}>}
 */
export async function smithCard({
  dir, title, premise = '', concurrency = 4, maxChapters = 0,
  startAt = 1, cutoff = null, openingSeed = '', player = null,
  onProgress = () => {}, signal, extract = null, cacheDir = null, cache = true,
}) {
  const chapters = readChapters(dir);
  const total = maxChapters > 0 ? Math.min(maxChapters, chapters.length) : chapters.length;
  const targets = chapters.slice(0, total);
  const root = cache ? (cacheDir || defaultCacheRoot(dir)) : '';
  const injected = typeof extract === 'function';
  const runExtract = injected
    ? extract
    : (ch, index, totalChapters, opts) => extractChapter(ch, index, totalChapters, opts);
  // 注入式抽取（离线假上游/测试）也要过同一套归一，不允许绕过 parse 直接拼卡
  const normalizeExtract = (raw, index) =>
    parseChapterExtract(typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}), index);

  const results = new Array(total);
  let done = 0;
  let cached = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < total) {
      if (signal?.aborted) return;
      const i = cursor++;
      const ch = targets[i];
      const fingerprint = cache ? fingerprintOf(dir, ch) : '';
      const hit = cache ? readCachedExtract(root, i, fingerprint) : null;
      if (hit) {
        results[i] = hit;
        cached++;
        done++;
        onProgress({ done, total, chapter: ch.title, cached: true });
        continue;
      }
      try {
        const raw = await runExtract(ch, i + 1, total, { signal });
        results[i] = injected ? normalizeExtract(raw, i + 1) : raw;
        if (cache) writeCachedExtract(root, i, fingerprint, results[i]);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        // 失败章不写缓存：断点续跑时会重试
        console.warn(`[card-smith] 第 ${i + 1} 章抽取失败：${err?.message || err}`);
        results[i] = { chapter: i + 1, entities: [], relations: [], events: [], voices: [], rules: [] };
      }
      done++;
      onProgress({ done, total, chapter: ch.title });
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const card = buildCardFromExtracts({
    chapters: results.filter(Boolean), title, premise, startAt, cutoff, openingSeed, player,
    sourceTexts: targets.map((c) => c.text),
    // chapters 记整本素材的章数（不是本次抽了多少章）；canon_cutoff 与 timeline 同一口径
    source: {
      kind: 'novel',
      title,
      chapters: chapters.length,
      canon_cutoff: `ch${resolveCut(cutoff, startAt)}`,
    },
  });

  return {
    card,
    stats: {
      chapters: total,
      cached,
      entities: card.entities.length,
      persons: card.entities.filter(isPerson).length,
      events: card.timeline.length,
      charter: card.charter.length,
    },
  };
}
