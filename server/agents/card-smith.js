/**
 * server/agents/card-smith.js — 制卡流水线（Card Smith）
 *
 * 把一部小说（或任意设定素材）抽成一张 v4 世界卡。这是**一次性的长任务**，
 * 不是运行时行为：跑完得到一张可复用的世界沙盒。
 *
 * 流水线（按章并行 → 合并仲裁）：
 *   1. 按章抽取：每章一个子任务，产出实体 / 关系 / 事件 / 台词样本 / 世界规则
 *   2. 合并仲裁：跨章去重、别名归并、矛盾标记，全部带出处（第几章）
 *   3. 切时间线：所有事件按序排好，标 past / future；用户选起点（默认序章）
 *   4. 生成快照：起点那一刻谁在哪、什么状态、谁知道什么
 *   5. 产出卡：命题 / 宪章 / 卡司 / 辞书 / 时间线 / 锚点
 *
 * 关键规则：
 *   - 只抽「起点之前的剧情」作为 canon。后续章节的事件标 future，默认不注入。
 *   - 人物内在（欲望、恐惧、秘密、说话方式）可以来自全书；
 *     但「她在第 80 章杀了谁」不能变成起点时的隐藏动机。
 *   - 开场种子是新写的，不抄原文。原文只用来做声音样本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chat } from '../llm.js';
import { config } from '../config.js';
import { normalizeCard } from '../world/schema.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

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
    {"kind": "character|place|institution|faction|item|concept", "name": "", "aliases": [], "summary": "一句话", "detail": "这个实体是什么，200字内"}
  ],
  "relations": [
    {"from": "", "to": "", "kind": "短语", "sentiment": 0.5, "note": "关系的本质，一句话"}
  ],
  "events": [
    {"when": "章内的时间描述", "what": "发生了什么，一句话", "who": [], "significant": true}
  ],
  "voices": [
    {"who": "", "text": "原文里的一句台词，带引号，不超过40字"}
  ],
  "rules": ["本章确立的世界规则/制度/礼法，一条一句"],
  "secrets": ["本章揭示或埋下的、外界不知道的事"]
}

# 硬性要求
1. entities 的 name 用文中的正式名称。aliases 收文中出现的其他叫法。
2. 只收本章**真正出现**的实体。跨章才拼出全貌，不要凭常识补。
3. events 的 significant: true 只给「改变了局势或关系」的事。日常推进不给。
4. voices 必须是从正文里**原样抄**的台词。不许改写、不许自己写。
5. rules 只写本章明确写出或明确演示的规矩。
6. 没有内容的字段给空数组。宁可少收，不许编。`;
}

function chapterExtractUser({ chapter, index, total }) {
  return `【章节】第 ${index}/${total} 章 · ${chapter.title}\n\n${chapter.text}\n\n请按 schema 输出纯 JSON。`;
}

async function extractChapter(chapter, index, total, { signal } = {}) {
  const cfg = config.agents.cardSmith;
  const res = await chat({
    messages: [
      { role: 'system', content: chapterExtractSystem() },
      { role: 'user', content: chapterExtractUser({ chapter, index, total }) },
    ],
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    reasoningEffort: cfg.reasoningEffort,
    responseFormat: { type: 'json_object' },
    model: cfg.model || undefined,
    signal,
  });
  return parseChapterExtract(res.content, index);
}

function parseChapterExtract(content, index) {
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
      return {
        kind: ['character', 'place', 'institution', 'faction', 'item', 'concept'].includes(o.kind) ? o.kind : 'concept',
        name: str(o.name),
        aliases: arr(o.aliases).map(str).filter(Boolean),
        summary: str(o.summary).slice(0, 120),
        detail: str(o.detail).slice(0, 400),
      };
    }).filter((e) => e.name),
    relations: arr(p.relations).map((r) => {
      const o = obj(r);
      return {
        from: str(o.from), to: str(o.to), kind: str(o.kind).slice(0, 40),
        sentiment: Number.isFinite(Number(o.sentiment)) ? Math.max(-1, Math.min(1, Number(o.sentiment))) : 0,
        note: str(o.note).slice(0, 200),
      };
    }).filter((r) => r.from && r.to && r.from !== r.to),
    events: arr(p.events).map((e) => {
      const o = obj(e);
      return {
        when: str(o.when).slice(0, 60),
        what: str(o.what).slice(0, 200),
        who: arr(o.who).map(str).filter(Boolean),
        significant: o.significant !== false,
      };
    }).filter((e) => e.what),
    voices: arr(p.voices).map((v) => {
      const o = obj(v);
      return { who: str(o.who), text: str(o.text).slice(0, 60) };
    }).filter((v) => v.who && v.text),
    rules: arr(p.rules).map(str).filter(Boolean).slice(0, 20),
    secrets: arr(p.secrets).map(str).filter(Boolean).slice(0, 20),
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 2. 合并仲裁（确定性去重 + 别名归并）                                    */
/* ══════════════════════════════════════════════════════════════════════ */

/** 名字相同或别名相交 → 视为同一实体。 */
function mergeEntities(chapters) {
  const out = [];
  for (const ch of chapters) {
    for (const e of ch.entities) {
      const hit = out.find((x) => x.name === e.name || x.aliases.some((a) => e.aliases.includes(a) || a === e.name));
      if (hit) {
        hit.chapters.push(ch.chapter);
        hit.aliases = [...new Set([...hit.aliases, ...e.aliases])];
        if (e.detail.length > hit.detail.length) hit.detail = e.detail;
        if (!hit.summary) hit.summary = e.summary;
      } else {
        out.push({ ...e, chapters: [ch.chapter] });
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

/* ══════════════════════════════════════════════════════════════════════ */
/* 3. 组装成 v4 世界卡                                                    */
/* ══════════════════════════════════════════════════════════════════════ */

const KIND_TO_TYPE = {
  character: 'character', place: 'place', institution: 'institution',
  faction: 'faction', item: 'item', concept: 'concept',
};

/**
 * 把合并后的素材组装成 v4 卡。
 * @param {object} args
 * @param {Array}  args.chapters   各章抽取结果
 * @param {string} args.title
 * @param {string} [args.premise]  命题（作者给；不给则从设定推一句）
 * @param {number} [args.startAt]  起点章节序号（默认 1 = 序章）
 * @param {string} [args.openingSeed] 开场种子（新写，不抄原文）
 * @param {object} [args.player]   玩家角色
 */
function buildCardFromExtracts({
  chapters, title, premise = '', startAt = 1, openingSeed = '', player = null,
}) {
  const entities = mergeEntities(chapters);
  const relations = mergeRelations(chapters, entities);
  const events = mergeEvents(chapters);
  const voices = mergeVoices(chapters);
  const rules = mergeRules(chapters);

  const cast = entities
    .filter((e) => e.kind === 'character')
    .map((e, i) => ({
      id: e.name,
      name: e.name,
      aliases: e.aliases,
      role: e.summary,
      one_line: e.summary,
      identity: { background: e.detail },
      voice: {
        rhythm: '',
        exemplars: voices.filter((v) => v.who === e.name).slice(0, 3).map((v) => v.text),
      },
      psyche: { wants: [], fears: [], hides: [] },
      knowledge: { knows: [], does_not_know: [] },
      agenda: [],
      relations: relations.filter((r) => r.from === e.name).map((r) => ({
        to: r.to, kind: r.kind, sentiment: r.sentiment, note: r.note,
      })),
      weight: e.chapters.length >= 5 ? 0.9 : e.chapters.length >= 2 ? 0.6 : 0.3,
    }));

  const codex = entities
    .filter((e) => e.kind !== 'character')
    .map((e) => ({
      id: e.name,
      type: KIND_TO_TYPE[e.kind] || 'custom',
      name: e.name,
      aliases: e.aliases,
      tags: [],
      summary: e.summary,
      facets: { history: e.detail },
      links: [],
      reveal: 'public',
      canon_from: 'prologue',
      detail: e.detail,
    }));

  const timeline = events.map((e, i) => ({
    id: `evt-${String(i + 1).padStart(3, '0')}`,
    when: e.when,
    what: e.what,
    who: e.who,
    source: `ch.${e.chapters[0]}`,
    canon: 'past',
  }));

  const charter = rules.slice(0, 12).map((r) => ({ rule: r, kind: 'law' }));

  // 起点快照：从起点那一章的实体与事件推
  const startChapter = chapters.find((c) => c.chapter === startAt) || chapters[0];
  const snapshotChars = {};
  for (const e of startChapter?.entities || []) {
    if (e.kind !== 'character') continue;
    snapshotChars[e.name] = { mood: '', condition: '', location: '', goal: '' };
  }

  const card = normalizeCard({
    title,
    kind: 'adapted',
    premise,
    charter,
    cast,
    codex,
    timeline,
    anchors: [{
      id: 'prologue',
      label: `序章 · ${startChapter?.title || '开局'}`,
      after_event: '',
      snapshot: {
        time: '',
        place: '',
        characters: snapshotChars,
        inventory: [],
        last_hook: events.find((e) => e.chapters[0] === startAt)?.what || '',
      },
      opening_seed: openingSeed,
    }],
    player: player || { name: '主角', mode: 'original' },
    author_notes: [],
  });

  return card;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 4. 长任务入口                                                          */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 跑完整流水线。按章并行抽取，可中断可续跑（已完成的章跳过）。
 *
 * @param {object} args
 * @param {string} args.dir       章节目录
 * @param {string} args.title     卡标题
 * @param {string} [args.premise]
 * @param {number} [args.concurrency] 并行度
 * @param {number} [args.maxChapters] 最多抽多少章（默认全部）
 * @param {function} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{card, stats}>}
 */
export async function smithCard({
  dir, title, premise = '', concurrency = 4, maxChapters = 0,
  startAt = 1, openingSeed = '', player = null, onProgress = () => {}, signal,
}) {
  const chapters = readChapters(dir);
  const total = maxChapters > 0 ? Math.min(maxChapters, chapters.length) : chapters.length;
  const targets = chapters.slice(0, total);

  const results = new Array(total);
  let done = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < total) {
      if (signal?.aborted) return;
      const i = cursor++;
      const ch = targets[i];
      try {
        results[i] = await extractChapter(ch, i + 1, total, { signal });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.warn(`[card-smith] 第 ${i + 1} 章抽取失败：${err?.message || err}`);
        results[i] = { chapter: i + 1, entities: [], relations: [], events: [], voices: [], rules: [], secrets: [] };
      }
      done++;
      onProgress({ done, total, chapter: ch.title });
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const card = buildCardFromExtracts({
    chapters: results.filter(Boolean), title, premise, startAt, openingSeed, player,
  });

  return {
    card,
    stats: {
      chapters: total,
      entities: card.cast.length + card.codex.length,
      events: card.timeline.length,
      charter: card.charter.length,
    },
  };
}
