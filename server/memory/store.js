/**
 * Memory store — SQLite schema + CRUD for the hierarchical memory system.
 *
 * Tiers (all per session):
 *   turns      — raw verbatim rounds (player action + narrator output), the archive
 *   summaries  — hierarchical compression of turns:
 *                  L1 round summary (1 turn)      ~300-500 tok
 *                  L2 arc summary  (ARC_EVERY rounds) ~1200-1800 tok
 *                  L3 saga summary (SAGA_EVERY arcs)  ~2000-3000 tok
 *                  L4 chronicle    (CHRONICLE_EVERY sagas) ~4000-6000 tok
 *   entities   — characters / items / locations / factions / events
 *   facts      — subject-predicate-object triples (relationship, ownership, status…)
 *   states     — plot state snapshots (time, location, moods, inventory, quests…)
 */
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { estimateTokens } from '../tokens.js';

let db = null;

export function getDb() {
  if (db) return db;
  db = new DatabaseSync(config.storage.dbPath);  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_no INTEGER NOT NULL,
      kind TEXT NOT NULL,                 -- player | narrator | system
      content TEXT NOT NULL,
      images_json TEXT,
      reasoning TEXT,
      branch_choice_json TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, turn_no, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_no);

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      level INTEGER NOT NULL,
      turn_from INTEGER NOT NULL,
      turn_to INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,   -- 1 = superseded by a higher level
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_level ON summaries(session_id, level, turn_from);

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      attributes_json TEXT NOT NULL DEFAULT '{}',
      first_turn INTEGER NOT NULL,
      last_turn INTEGER NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      mention_count INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, type, name)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_session ON entities(session_id, importance DESC, last_turn DESC);

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id, turn_no);

    CREATE TABLE IF NOT EXISTS states (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_no INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, turn_no)
    );

    -- 用户手写的记忆笔记：确定性事实，永不压缩、每轮强制进入上下文
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',      -- note | rule | foreshadow | retcon
      turn_no INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id, active, turn_no);
  `);
  migrate(db);
  return db;
}

/**
 * 轻量迁移：为旧库补齐后续版本新增的列。
 * SQLite 的 ALTER TABLE ADD COLUMN 幂等性由 PRAGMA 检查保证。
 */
function migrate(d) {
  const addColumn = (table, column, ddl) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  addColumn('entities', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
  addColumn('facts', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
  addColumn('facts', 'status', "status TEXT NOT NULL DEFAULT 'active'");  // active | retracted
  addColumn('turns', 'edited', 'edited INTEGER NOT NULL DEFAULT 0');
  addColumn('turns', 'branch_taken', 'branch_taken TEXT');
}

/* ------------------------------ sessions ------------------------------ */

export function createSession({ id, title, settings }) {
  const d = getDb();
  const now = Date.now();
  d.prepare(`INSERT INTO sessions (id, title, settings_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`)
    .run(id, title || settings?.title || '未命名剧情', JSON.stringify(settings), now, now);
  return getSession(id);
}

export function getSession(id) {
  const row = getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    ...row,
    settings: JSON.parse(row.settings_json),
  };
}

export function listSessions() {
  const rows = getDb().prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`).all();
  return rows.map(r => ({ ...r, settings: JSON.parse(r.settings_json) }));
}

export function updateSession(id, { title, settings, status }) {
  const s = getSession(id);
  if (!s) return null;
  const d = getDb();
  const next = {
    title: title ?? s.title,
    settings: settings ? { ...s.settings, ...settings } : s.settings,
    status: status ?? s.status,
  };
  d.prepare(`UPDATE sessions SET title=?, settings_json=?, status=?, updated_at=? WHERE id=?`)
    .run(next.title, JSON.stringify(next.settings), next.status, Date.now(), id);
  return getSession(id);
}

export function deleteSession(id) {
  const d = getDb();
  const tx = () => {
    d.prepare(`DELETE FROM turns WHERE session_id=?`).run(id);
    d.prepare(`DELETE FROM summaries WHERE session_id=?`).run(id);
    d.prepare(`DELETE FROM entities WHERE session_id=?`).run(id);
    d.prepare(`DELETE FROM facts WHERE session_id=?`).run(id);
    d.prepare(`DELETE FROM states WHERE session_id=?`).run(id);
    d.prepare(`DELETE FROM notes WHERE session_id=?`).run(id);
    d.prepare(`DELETE FROM sessions WHERE id=?`).run(id);
  };
  d.exec('BEGIN'); try { tx(); d.exec('COMMIT'); } catch (e) { d.exec('ROLLBACK'); throw e; }
}

export function touchSession(id, turnCount) {
  getDb().prepare(`UPDATE sessions SET updated_at=?, turn_count=? WHERE id=?`)
    .run(Date.now(), turnCount, id);
}

/* ------------------------------- turns -------------------------------- */

export function addTurn(sessionId, turn) {
  const d = getDb();
  const tokenCount = turn.token_count ?? estimateTokens(turn.content);
  const info = d.prepare(`
    INSERT INTO turns (session_id, turn_no, kind, content, images_json, reasoning, branch_choice_json, token_count, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, turn_no, kind) DO UPDATE SET
      content=excluded.content, images_json=excluded.images_json, reasoning=excluded.reasoning,
      branch_choice_json=excluded.branch_choice_json, token_count=excluded.token_count, meta_json=excluded.meta_json
  `).run(
    sessionId, turn.turn_no, turn.kind, turn.content,
    turn.images ? JSON.stringify(turn.images) : null,
    turn.reasoning || null,
    turn.branch_choice ? JSON.stringify(turn.branch_choice) : null,
    tokenCount,
    turn.meta ? JSON.stringify(turn.meta) : null,
    Date.now(),
  );
  return { id: Number(info.lastInsertRowid), token_count: tokenCount };
}

export function getTurns(sessionId, { from = 1, to = Infinity, kinds = null } = {}) {
  let sql = `SELECT * FROM turns WHERE session_id=? AND turn_no BETWEEN ? AND ?`;
  const params = [sessionId, from, to];
  if (kinds?.length) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  sql += ` ORDER BY turn_no ASC, id ASC`;
  return getDb().prepare(sql).all(...params).map(decorateTurn);
}

export function getRecentTurns(sessionId, n) {
  const rows = getDb().prepare(`
    SELECT * FROM turns WHERE session_id=? ORDER BY turn_no DESC, id DESC LIMIT ?
  `).all(sessionId, n * 2 + 4);
  return rows.reverse().map(decorateTurn);
}

function decorateTurn(row) {
  return {
    ...row,
    images: row.images_json ? JSON.parse(row.images_json) : null,
    branch_choice: row.branch_choice_json ? JSON.parse(row.branch_choice_json) : null,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
  };
}

export function getMaxTurnNo(sessionId) {
  const row = getDb().prepare(`SELECT MAX(turn_no) AS m FROM turns WHERE session_id=?`).get(sessionId);
  return row?.m || 0;
}

/** 单条 turn（用于编辑/审核正文）。 */
export function getTurn(sessionId, turnNo, kind) {
  const row = getDb().prepare(
    `SELECT * FROM turns WHERE session_id=? AND turn_no=? AND kind=?`
  ).get(sessionId, turnNo, kind);
  return row ? decorateTurn(row) : null;
}

/** 改写某条 turn 的正文（人工订正叙事，后续记忆将以此为准）。 */
export function updateTurnContent(sessionId, turnNo, kind, content) {
  const info = getDb().prepare(
    `UPDATE turns SET content=?, token_count=?, edited=1 WHERE session_id=? AND turn_no=? AND kind=?`
  ).run(content, estimateTokens(content), sessionId, turnNo, kind);
  return Number(info.changes) > 0;
}

/**
 * 回滚到第 n 轮（含）：删除其后所有回合与由这些回合派生的记忆。
 * 用于「这段剧情走歪了，退回去重来」。
 * @returns {{turns:number, summaries:number, states:number, facts:number}}
 */
export function truncateSession(sessionId, turnNo) {
  const d = getDb();
  const q = (sql) => d.prepare(sql).run(sessionId, turnNo);
  d.exec('BEGIN');
  try {
    const t = q(`DELETE FROM turns WHERE session_id=? AND turn_no>?`);
    const s = q(`DELETE FROM summaries WHERE session_id=? AND turn_to>?`);
    const st = q(`DELETE FROM states WHERE session_id=? AND turn_no>?`);
    const f = q(`DELETE FROM facts WHERE session_id=? AND turn_no>?`);
    // 该轮之后实体最后出现位置需要修正，否则会指向已删除的回合
    d.prepare(`UPDATE entities SET last_turn=? WHERE session_id=? AND last_turn>?`)
      .run(turnNo, sessionId, turnNo);
    d.prepare(`DELETE FROM entities WHERE session_id=? AND last_turn<? AND first_turn>?`)
      .run(sessionId, 1, turnNo);
    d.exec('COMMIT');
    touchSession(sessionId, Math.max(getMaxTurnNo(sessionId), 0));
    return { turns: t.changes, summaries: s.changes, states: st.changes, facts: f.changes };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/* ----------------------------- summaries ------------------------------ */

export function addSummary(sessionId, { level, turnFrom, turnTo, content }) {
  const tokenCount = estimateTokens(content);
  const info = getDb().prepare(`
    INSERT INTO summaries (session_id, level, turn_from, turn_to, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, level, turnFrom, turnTo, content, tokenCount, Date.now());
  return { id: Number(info.lastInsertRowid), token_count: tokenCount };
}

export function getSummaries(sessionId, { level, archived = 0, limit } = {}) {
  let sql = `SELECT * FROM summaries WHERE session_id=?`;
  const params = [sessionId];
  if (level != null) { sql += ` AND level=?`; params.push(level); }
  if (archived != null) { sql += ` AND archived=?`; params.push(archived); }
  sql += ` ORDER BY turn_from ASC`;
  if (limit) { sql += ` LIMIT ?`; params.push(limit); }
  return getDb().prepare(sql).all(...params);
}

export function getLatestSummaries(sessionId, level, n) {
  return getDb().prepare(`
    SELECT * FROM summaries WHERE session_id=? AND level=? AND archived=0
    ORDER BY turn_from DESC LIMIT ?
  `).all(sessionId, level, n).reverse();
}

export function archiveSummaries(ids) {
  if (!ids?.length) return;
  const d = getDb();
  d.exec('BEGIN');
  try {
    const stmt = d.prepare(`UPDATE summaries SET archived=1 WHERE id=?`);
    for (const id of ids) stmt.run(id);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}

export function countSummaries(sessionId, level) {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS c FROM summaries WHERE session_id=? AND level=? AND archived=0`
  ).get(sessionId, level);
  return row.c;
}

/* ----------------------------- entities ------------------------------- */

export function upsertEntity(sessionId, entity) {
  const d = getDb();
  const existing = d.prepare(
    `SELECT * FROM entities WHERE session_id=? AND type=? AND name=?`
  ).get(sessionId, entity.type, entity.name);
  if (existing) {
    d.prepare(`
      UPDATE entities SET summary=?, attributes_json=?, last_turn=?, importance=?, mention_count=?, updated_at=?
      WHERE id=?
    `).run(
      entity.summary || existing.summary,
      entity.attributes ? JSON.stringify({ ...JSON.parse(existing.attributes_json), ...entity.attributes }) : existing.attributes_json,
      Math.max(entity.last_turn ?? existing.last_turn, existing.last_turn),
      entity.importance ?? existing.importance,
      existing.mention_count + 1,
      Date.now(),
      existing.id,
    );
    return existing.id;
  }
  const info = d.prepare(`
    INSERT INTO entities (session_id, type, name, summary, attributes_json, first_turn, last_turn, importance, mention_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    sessionId, entity.type, entity.name, entity.summary || '',
    JSON.stringify(entity.attributes || {}),
    entity.first_turn ?? entity.last_turn ?? 0,
    entity.last_turn ?? entity.first_turn ?? 0,
    entity.importance ?? 0.5,
    Date.now(),
  );
  return Number(info.lastInsertRowid);
}

export function getEntities(sessionId, { types = null, limit = 60 } = {}) {
  let sql = `SELECT * FROM entities WHERE session_id=?`;
  const params = [sessionId];
  if (types?.length) { sql += ` AND type IN (${types.map(() => '?').join(',')})`; params.push(...types); }
  sql += ` ORDER BY pinned DESC, importance DESC, last_turn DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params).map(e => ({ ...e, attributes: JSON.parse(e.attributes_json) }));
}

/** 固定 / 取消固定实体（固定的实体优先进入上下文，且不会被预算挤掉）。 */
export function setEntityPinned(sessionId, entityId, pinned) {
  const info = getDb().prepare(
    `UPDATE entities SET pinned=? WHERE session_id=? AND id=?`
  ).run(pinned ? 1 : 0, sessionId, entityId);
  return Number(info.changes) > 0;
}

/** 人工编辑实体档案（订正名称/摘要/重要度）。 */
export function updateEntity(sessionId, entityId, patch = {}) {
  const row = getDb().prepare(`SELECT * FROM entities WHERE session_id=? AND id=?`).get(sessionId, entityId);
  if (!row) return false;
  getDb().prepare(
    `UPDATE entities SET name=?, summary=?, importance=?, attributes_json=?, updated_at=? WHERE id=?`
  ).run(
    patch.name ?? row.name,
    patch.summary ?? row.summary,
    patch.importance ?? row.importance,
    patch.attributes ? JSON.stringify({ ...JSON.parse(row.attributes_json), ...patch.attributes }) : row.attributes_json,
    Date.now(),
    entityId,
  );
  return true;
}

/** 删除实体（错误的记忆可以人工剔除）。 */
export function deleteEntity(sessionId, entityId) {
  const info = getDb().prepare(`DELETE FROM entities WHERE session_id=? AND id=?`).run(sessionId, entityId);
  return Number(info.changes) > 0;
}

/* ------------------------------- facts -------------------------------- */

export function addFact(sessionId, fact) {
  // dedupe identical triples
  const existing = getDb().prepare(`
    SELECT id FROM facts WHERE session_id=? AND subject=? AND predicate=? AND object=?
  `).get(sessionId, fact.subject, fact.predicate, fact.object);
  if (existing) return existing.id;
  const info = getDb().prepare(`
    INSERT INTO facts (session_id, subject, predicate, object, turn_no, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, fact.subject, fact.predicate, fact.object, fact.turn_no, fact.confidence ?? 1, Date.now());
  return Number(info.lastInsertRowid);
}

export function getFacts(sessionId, { limit = 200, subject = null, includeRetracted = false } = {}) {
  let sql = `SELECT * FROM facts WHERE session_id=?`;
  const params = [sessionId];
  if (!includeRetracted) sql += ` AND status='active'`;
  if (subject) { sql += ` AND subject=?`; params.push(subject); }
  sql += ` ORDER BY pinned DESC, turn_no DESC, id DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params);
}

/** 固定 / 取消固定事实。 */
export function setFactPinned(sessionId, factId, pinned) {
  const info = getDb().prepare(
    `UPDATE facts SET pinned=? WHERE session_id=? AND id=?`
  ).run(pinned ? 1 : 0, sessionId, factId);
  return Number(info.changes) > 0;
}

/** 撤回（作废）一条事实：不物理删除，便于审计与「剧情推翻设定」。 */
export function deleteFact(sessionId, factId, { hard = false } = {}) {
  const info = hard
    ? getDb().prepare(`DELETE FROM facts WHERE session_id=? AND id=?`).run(sessionId, factId)
    : getDb().prepare(`UPDATE facts SET status='retracted' WHERE session_id=? AND id=?`).run(sessionId, factId);
  return Number(info.changes) > 0;
}

/** 人工新增一条事实（作者钦定的设定，例如「伍卿 - 腿有旧疾 - 左腿」）。 */
export function addManualFact(sessionId, { subject, predicate, object, turn_no = 0, confidence = 1 }) {
  return addFact(sessionId, { subject, predicate, object, turn_no, confidence });
}

/* ------------------------------- notes -------------------------------- */

/**
 * 作者手写记忆笔记。与自动记忆的区别：永不被压缩、永不遗忘、每轮强制注入上下文。
 * kind: note（一般事实/偏好）| rule（硬性演出规则）| foreshadow（伏笔待回收）| retcon（覆盖既有记忆）
 */
export function addNote(sessionId, { content, kind = 'note', turn_no = 0 }) {
  const info = getDb().prepare(`
    INSERT INTO notes (session_id, content, kind, turn_no, active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(sessionId, String(content || '').trim(), kind, turn_no, Date.now());
  return Number(info.lastInsertRowid);
}

export function getNotes(sessionId, { activeOnly = true, kind = null } = {}) {
  let sql = `SELECT * FROM notes WHERE session_id=?`;
  const params = [sessionId];
  if (activeOnly) sql += ` AND active=1`;
  if (kind) { sql += ` AND kind=?`; params.push(kind); }
  sql += ` ORDER BY turn_no ASC, id ASC`;
  return getDb().prepare(sql).all(...params);
}

export function updateNote(sessionId, noteId, patch = {}) {
  const row = getDb().prepare(`SELECT * FROM notes WHERE id=? AND session_id=?`).get(noteId, sessionId);
  if (!row) return false;
  getDb().prepare(`UPDATE notes SET content=?, kind=?, active=? WHERE id=?`).run(
    patch.content ?? row.content,
    patch.kind ?? row.kind,
    patch.active == null ? row.active : (patch.active ? 1 : 0),
    noteId,
  );
  return true;
}

export function deleteNote(sessionId, noteId) {
  const info = getDb().prepare(`DELETE FROM notes WHERE id=? AND session_id=?`).run(noteId, sessionId);
  return Number(info.changes) > 0;
}

/* ------------------------------- states ------------------------------- */

export function setState(sessionId, turnNo, state) {
  getDb().prepare(`
    INSERT INTO states (session_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, turn_no) DO UPDATE SET state_json=excluded.state_json
  `).run(sessionId, turnNo, JSON.stringify(state), Date.now());
}

export function getState(sessionId) {
  const row = getDb().prepare(
    `SELECT * FROM states WHERE session_id=? ORDER BY turn_no DESC LIMIT 1`
  ).get(sessionId);
  return row ? { turn_no: row.turn_no, state: JSON.parse(row.state_json) } : null;
}

/** 关闭数据库连接（测试清理 / 优雅退出时使用）。 */
export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
}
