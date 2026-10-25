#!/usr/bin/env node
/**
 * _work/recall-probe.mjs — 历史检索探针（只读实验，不参与运行时）
 *
 * 回答一个问题：如果给「模型主动检索历史」做底层（规划中的 recall_history），
 * node:sqlite 自带的 FTS5 在**中文**上够不够用？
 *
 * 验证三件事：
 *   1. FTS5 是否可用、trigram tokenizer 是否可用（中文无需分词依赖）；
 *   2. trigram 对中文子串查询的实际召回（含 2 字查询的限制）与 unicode61 的对比；
 *   3. 若给出 --db，则验证「按 branch/turn 过滤后再检索」的 SQL 形状。
 *
 * 用法：
 *   node _work/recall-probe.mjs [--dir <章节目录>] [--db <sqlite 路径>] [--top 3]
 *
 * 只读：素材目录只读不写；--db 以 readonly 打开（uri: file:...?mode=ro）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = path.join(ROOT, '素材', '我在女尊世界捡破烂');
const DEFAULT_DB = path.join(ROOT, 'data', 'roleplay.db');
const DEFAULT_CARD = path.join(ROOT, 'presets', 'nvzun-jianpolan.json');

function parseArgs(argv) {
  const out = { dir: DEFAULT_DIR, db: '', card: DEFAULT_CARD, top: 3 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dir') out.dir = path.resolve(argv[++i] || out.dir);
    else if (k === '--db') out.db = path.resolve(argv[++i] || '');
    else if (k === '--card') out.card = path.resolve(argv[++i] || out.card);
    else if (k === '--top') out.top = Math.max(1, Number(argv[++i]) || 3);
    else if (k === '--help' || k === '-h') {
      console.log('用法: node _work/recall-probe.mjs [--dir <章节目录>] [--db <sqlite>] [--top N]');
      process.exit(0);
    }
  }
  return out;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const norm = (s) => str(s).replace(/\s+/g, ' ').trim();
const ms = (t0) => Math.round(performance.now() - t0);

function loadChapters(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.txt'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
  const rows = files.map((f, i) => ({
    id: i + 1,
    title: f.replace(/\.txt$/i, ''),
    body: norm(fs.readFileSync(path.join(dir, f), 'utf8')),
  }));
  return rows;
}

/** 从世界卡里取真实召回目标（角色名/别名、设定集条目名），比拍脑袋的查询更接近产品用法。 */
function queriesFromCard(cardPath) {
  const queries = [];
  try {
    const root = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    const card = root.card || root;   // presets/*.json 是 DB 行包装（{id,title,card}）
    for (const c of card.cast || []) {
      for (const n of [c.name, ...(c.aliases || [])]) {
        if (str(n).length >= 2) queries.push(str(n));
      }
    }
    for (const e of card.codex || []) {
      const n = str(e.name);
      if (n.length >= 2 && !queries.includes(n)) queries.push(n);
    }
  } catch (err) {
    console.warn(`[probe] 读卡失败（跳过真实查询）：${err.message}`);
  }
  // 固定的通用词兜底，保证语料换掉时仍有查询可跑
  const fallback = ['捡破烂', '女尊', '雨街'];
  const picked = [];
  for (const q of [...queries, ...fallback]) {
    if (!picked.includes(q)) picked.push(q);
    if (picked.length >= 12) break;
  }
  return picked;
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE docs_trigram USING fts5(title, body, tokenize='trigram');`);
  db.exec(`CREATE VIRTUAL TABLE docs_unicode USING fts5(title, body);`);
  return db;
}

function insertDocs(db, rows) {
  const insT = db.prepare('INSERT INTO docs_trigram(rowid, title, body) VALUES (?, ?, ?)');
  const insU = db.prepare('INSERT INTO docs_unicode(rowid, title, body) VALUES (?, ?, ?)');
  const t0 = performance.now();
  db.exec('BEGIN');
  for (const r of rows) {
    insT.run(r.id, r.title, r.body);
    insU.run(r.id, r.title, r.body);
  }
  db.exec('COMMIT');
  return ms(t0);
}

function groundTruth(rows, q) {
  return rows.filter((r) => r.body.includes(q) || r.title.includes(q)).map((r) => r.id);
}

function runMatch(db, table, q, limit = 0) {
  const t0 = performance.now();
  try {
    const sql = `SELECT rowid AS id, title, bm25(${table}) AS score
                 FROM ${table} WHERE ${table} MATCH ? ORDER BY score${limit ? ` LIMIT ${limit}` : ''}`;
    const hits = db.prepare(sql).all(`"${q.replace(/"/g, '""')}"`);
    return { ok: true, hits, ms: ms(t0) };
  } catch (err) {
    return { ok: false, error: err.message, hits: [], ms: ms(t0) };
  }
}

function runLike(db, q) {
  const t0 = performance.now();
  const rows = db.prepare('SELECT rowid AS id, title FROM docs_trigram WHERE body LIKE ? LIMIT 10')
    .all(`%${q}%`);
  return { rows, ms: ms(t0) };
}

function pct(a, b) { return b === 0 ? 0 : Math.round((a / b) * 100); }

function reportDir(rows, queries, topN) {
  const db = makeDb();
  const buildMs = insertDocs(db, rows);
  console.log(`\n[FTS5/trigram 中文召回探针] 语料：${rows.length} 章 / ${rows.reduce((n, r) => n + r.body.length, 0)} 字，建索引 ${buildMs} ms`);
  console.log('  （trigram 的已知限制：MATCH 查询短于 3 个 Unicode 字符不受支持，2 字人名会直接报错）\n');
  console.log('  查询          字数  trigram匹配  覆盖(命中/真实)  unicode匹配  覆盖   LIKE兜底    耗时');
  for (const q of queries) {
    const truth = groundTruth(rows, q);
    if (!truth.length) continue;
    const tg = runMatch(db, 'docs_trigram', q);            // 全量命中，用于算覆盖率
    const un = runMatch(db, 'docs_unicode', q);
    const like = runLike(db, q);
    const tgIds = new Set(tg.hits.map((h) => h.id));
    const unIds = new Set(un.hits.map((h) => h.id));
    const tgCov = pct(truth.filter((id) => tgIds.has(id)).length, truth.length);
    const unCov = pct(truth.filter((id) => unIds.has(id)).length, truth.length);
    const tgErr = tg.ok ? String(tg.hits.length) : 'ERR';
    const unErr = un.ok ? String(un.hits.length) : 'ERR';
    console.log(
      `  ${q.padEnd(10, '　')} ${String(q.length).padStart(3)}  ${tgErr.padStart(9)}  ${(tgCov + '%').padStart(11)}  ${unErr.padStart(9)}  ${(unCov + '%').padStart(4)}  ${String(like.rows.length).padStart(7)}  ${tg.ms}ms`
    );
    if (!tg.ok) console.log(`      trigram 错误：${tg.error}`);
    if (!un.ok) console.log(`      unicode61 错误：${un.error}`);
  }

  // 短语查询（>=3 字）的 top-N 精度：命中里有多少真的含该串
  console.log('\n  top-N 精度（trigram，只有含该串的命中才算对）：');
  for (const q of queries.filter((x) => x.length >= 3).slice(0, 6)) {
    const tg = runMatch(db, 'docs_trigram', q, topN);
    if (!tg.ok) continue;
    const top = tg.hits.slice(0, topN);
    const good = top.filter((h) => rows.find((r) => r.id === h.id)?.body.includes(q)).length;
    console.log(`    ${q.padEnd(8, '　')} top${top.length} 命中 ${tg.hits.length}，正确 ${good}/${top.length}`);
  }

  // LIKE 全表扫描的耗时（2 字查询的兜底方案）
  const two = queries.filter((x) => x.length === 2).slice(0, 3);
  if (two.length) {
    console.log('\n  2 字查询的兜底（LIKE 全表扫描，无法用 trigram 索引）：');
    for (const q of two) {
      const like = runLike(db, q);
      console.log(`    ${q}：命中 ${like.rows.length} 章，${like.ms} ms`);
    }
  }
  return db;
}

function reportDb(dbPath, top) {
  if (!fs.existsSync(dbPath)) {
    console.log(`\n[DB 模式] 跳过：${dbPath} 不存在`);
    return;
  }
  let db;
  try {
    db = new DatabaseSync(`file:${dbPath.replace(/\\/g, '/')}?mode=ro`, { readOnly: true });
  } catch (err) {
    console.log(`\n[DB 模式] 打开失败：${err.message}`);
    return;
  }
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM turns').get().n;
    console.log(`\n[DB 模式] turns 共 ${n} 行（${SQLITE_VERSION(db)}）`);
    if (!n) return;
    const turns = db.prepare('SELECT id, session_id, turn_no, kind, branch_id, content FROM turns ORDER BY session_id, turn_no LIMIT 200').all();
    const mem = new DatabaseSync(':memory:');
    mem.exec(`CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram');`);
    mem.exec(`CREATE TABLE meta(id INTEGER PRIMARY KEY, session_id TEXT, branch_id TEXT, turn_no INTEGER, kind TEXT);`);
    const insT = mem.prepare('INSERT INTO t(rowid, body) VALUES (?, ?)');
    const insM = mem.prepare('INSERT INTO meta(id, session_id, branch_id, turn_no, kind) VALUES (?, ?, ?, ?, ?)');
    mem.exec('BEGIN');
    for (const t of turns) {
      insT.run(t.id, norm(t.content));
      insM.run(t.id, t.session_id, t.branch_id, t.turn_no, t.kind);
    }
    mem.exec('COMMIT');
    const branch = turns[0].branch_id;
    const atTurn = Math.max(...turns.map((t) => t.turn_no));
    const q = '伍卿';
    const t0 = performance.now();
    let sql = `SELECT m.turn_no, m.kind, snippet(t, 0, '「', '」', '…', 12) AS snip
               FROM t JOIN meta m ON m.id = t.rowid
               WHERE t MATCH ? AND m.branch_id = ? AND m.turn_no <= ?
               ORDER BY bm25(t) LIMIT ?`;
    let hits = [];
    try {
      hits = mem.prepare(sql).all(`"${q}"`, branch, atTurn, top);
    } catch (err) {
      console.log(`  查询 ${q} 失败（trigram 2 字限制）：${err.message}；改用 LIKE`);
      sql = `SELECT m.turn_no, m.kind, substr(t.body, 1, 40) AS snip
             FROM t JOIN meta m ON m.id = t.rowid
             WHERE t.body LIKE ? AND m.branch_id = ? AND m.turn_no <= ? LIMIT ?`;
      hits = mem.prepare(sql).all(`%${q}%`, branch, atTurn, top);
    }
    console.log(`  按 branch=${branch} + turn<=${atTurn} 过滤后检索「${q}」：${hits.length} 条，${ms(t0)} ms`);
    for (const h of hits) console.log(`    t${h.turn_no} ${h.kind} ${str(h.snip).slice(0, 44)}`);
  } finally {
    db.close();
  }
}

function SQLITE_VERSION(db) {
  try { return `SQLite ${db.prepare('SELECT sqlite_version() AS v').get().v}`; } catch { return ''; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('[probe] node:sqlite FTS5 可用性自检…');
  const probe = new DatabaseSync(':memory:');
  try {
    probe.exec(`CREATE VIRTUAL TABLE x USING fts5(a, tokenize='trigram')`);
    console.log(`[probe] FTS5 + trigram: OK（${SQLITE_VERSION(probe)}）`);
  } catch (err) {
    console.error(`[probe] FTS5/trigram 不可用：${err.message}`);
    process.exit(2);
  } finally {
    probe.close();
  }

  if (!fs.existsSync(args.dir)) {
    console.error(`[probe] 章节目录不存在：${args.dir}`);
  } else {
    const rows = loadChapters(args.dir);
    const queries = queriesFromCard(args.card);
    reportDir(rows, queries, args.top);
  }
  if (args.db) reportDb(args.db, args.top);
  console.log('\n[probe] 结论请结合 AGENTS §15.1「历史检索工具 recall_history」阅读：本探针只验证底层可行性，不实现产品链路。');
}

main();
