/**
 * server/memory/store.js — 数据层（世界卡 · 剧情会话 · 记忆）
 *
 * 结构（v3）：
 *   worlds        世界卡：宪章级设定（worldview / cast / player / rules / director / opening）
 *   lore_entries  世界词条：关键词触发的设定碎片，只在被提到时才进入上下文
 *   sessions      剧情会话：属于某张世界卡，一张卡可以有任意多个会话
 *   turns         逐轮原文（玩家行动 + 旁白），并记录本轮 token 遥测
 *   summaries     分层压缩：L1 轮 → L2 幕 → L3 卷 → L4 编年
 *   entities      实体档案（角色/地点/物品/势力/事件/概念）
 *   facts         三元组事实（可撤回，保留审计）
 *   states        场景快照（时间/地点/在场/物品/张力）
 *   notes         作者笔记（确定性记忆，永不压缩）
 *   relations     关系账本（谁对谁什么态度，随时间演化）
 *   threads       线索/伏笔账本（埋了什么、收了没有）
 *   reflections   反思洞察（跨多轮的高阶结论，比摘要更浓缩）
 */
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { estimateTokens } from '../tokens.js';

let db = null;

export function getDb() {
  if (db) return db;
  db = new DatabaseSync(config.storage.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      cover_hue INTEGER NOT NULL DEFAULT 210,
      tags_json TEXT NOT NULL DEFAULT '[]',
      card_json TEXT NOT NULL DEFAULT '{}',
      source_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lore_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      keys_json TEXT NOT NULL DEFAULT '[]',
      secondary_json TEXT NOT NULL DEFAULT '[]',
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'setting',
      priority INTEGER NOT NULL DEFAULT 50,
      constant INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lore_world ON lore_entries(world_id, enabled, priority DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      world_id TEXT REFERENCES worlds(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      turn_count INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT,
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
      usage_json TEXT,
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
      archived INTEGER NOT NULL DEFAULT 0,
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
      pinned INTEGER NOT NULL DEFAULT 0,
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
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
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

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      turn_no INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id, active, turn_no);

    -- 关系账本：两个人之间的态度，会随剧情演化
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      from_name TEXT NOT NULL,
      to_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '',        -- 亲情|主仆|爱慕|敌对|利用|旧识…
      sentiment REAL NOT NULL DEFAULT 0,    -- -1 敌意 … +1 亲近
      note TEXT NOT NULL DEFAULT '',
      turn_no INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, from_name, to_name)
    );

    -- 线索/伏笔账本：埋了什么，收没收
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',  -- open | resolved | abandoned
      weight REAL NOT NULL DEFAULT 0.5,     -- 重要度 0-1
      planted_turn INTEGER NOT NULL DEFAULT 0,
      resolved_turn INTEGER,
      note TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, title)
    );

    -- 反思洞察：跨多轮沉淀的高阶结论（比摘要更浓缩，长期携带）
    CREATE TABLE IF NOT EXISTS reflections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_from INTEGER NOT NULL,
      turn_to INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'insight', -- insight | relationship | theme | rule
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reflections_session ON reflections(session_id, turn_to DESC);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  migrate(db);
  return db;
}

/** 轻量迁移：为旧库补齐后续版本新增的列（幂等）。 */
function migrate(d) {
  const addColumn = (table, column, ddl) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  addColumn('turns', 'edited', 'edited INTEGER NOT NULL DEFAULT 0');
  addColumn('turns', 'branch_taken', 'branch_taken TEXT');
  addColumn('turns', 'usage_json', 'usage_json TEXT');
  addColumn('sessions', 'world_id', 'world_id TEXT');
  addColumn('sessions', 'usage_json', 'usage_json TEXT');

  // 索引必须在列补齐之后再建：旧库里 sessions 没有 world_id 时建索引会报错
  d.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_world ON sessions(world_id, updated_at DESC);`);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Worlds                                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

export function upsertWorld(world) {
  const d = getDb();
  const now = Date.now();
  const existing = d.prepare(`SELECT id, created_at FROM worlds WHERE id=?`).get(world.id);
  if (existing) {
    d.prepare(`
      UPDATE worlds SET title=?, subtitle=?, cover_hue=?, tags_json=?, card_json=?, source_json=?, updated_at=?
      WHERE id=?
    `).run(
      world.title || '未命名世界',
      world.subtitle || '',
      world.coverHue ?? 210,
      JSON.stringify(world.tags || []),
      JSON.stringify(world.card || {}),
      world.source ? JSON.stringify(world.source) : null,
      now,
      world.id,
    );
  } else {
    d.prepare(`
      INSERT INTO worlds (id, title, subtitle, cover_hue, tags_json, card_json, source_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      world.id,
      world.title || '未命名世界',
      world.subtitle || '',
      world.coverHue ?? 210,
      JSON.stringify(world.tags || []),
      JSON.stringify(world.card || {}),
      world.source ? JSON.stringify(world.source) : null,
      now,
      now,
    );
  }
  return getWorld(world.id);
}

function decorateWorld(row) {
  if (!row) return null;
  return {
    ...row,
    tags: JSON.parse(row.tags_json || '[]'),
    card: JSON.parse(row.card_json || '{}'),
    source: row.source_json ? JSON.parse(row.source_json) : null,
  };
}

export function getWorld(id) {
  return decorateWorld(getDb().prepare(`SELECT * FROM worlds WHERE id=?`).get(id));
}

export function listWorlds() {
  return getDb().prepare(`
    SELECT w.*, (SELECT COUNT(*) FROM sessions s WHERE s.world_id = w.id) AS session_count
    FROM worlds w ORDER BY w.updated_at DESC
  `).all().map((r) => ({ ...decorateWorld(r), session_count: r.session_count }));
}

export function deleteWorld(id) {
  getDb().prepare(`DELETE FROM worlds WHERE id=?`).run(id);
}

export function touchWorld(id) {
  getDb().prepare(`UPDATE worlds SET updated_at=? WHERE id=?`).run(Date.now(), id);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Lore entries（世界词条）                                                */
/* ══════════════════════════════════════════════════════════════════════ */

export function replaceLore(worldId, entries = []) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare(`DELETE FROM lore_entries WHERE world_id=?`).run(worldId);
    const stmt = d.prepare(`
      INSERT INTO lore_entries (world_id, keys_json, secondary_json, title, content, category, priority, constant, enabled, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    entries.forEach((e, i) => {
      const content = String(e?.content || '').trim();
      if (!content) return;
      stmt.run(
        worldId,
        JSON.stringify(Array.isArray(e.keys) ? e.keys.filter(Boolean) : []),
        JSON.stringify(Array.isArray(e.secondary) ? e.secondary.filter(Boolean) : []),
        String(e.title || '').trim(),
        content,
        String(e.category || 'setting'),
        Number.isFinite(Number(e.priority)) ? Number(e.priority) : 50,
        e.constant ? 1 : 0,
        e.enabled === false ? 0 : 1,
        i,
      );
    });
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return countLore(worldId);
}

export function countLore(worldId) {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM lore_entries WHERE world_id=?`).get(worldId)?.c || 0;
}

export function getLore(worldId, { enabledOnly = true } = {}) {
  let sql = `SELECT * FROM lore_entries WHERE world_id=?`;
  if (enabledOnly) sql += ` AND enabled=1`;
  sql += ` ORDER BY sort ASC, id ASC`;
  return getDb().prepare(sql).all(worldId).map((r) => ({
    ...r,
    keys: JSON.parse(r.keys_json || '[]'),
    secondary: JSON.parse(r.secondary_json || '[]'),
    constant: !!r.constant,
    enabled: !!r.enabled,
  }));
}

export function addLore(worldId, entry) {
  const info = getDb().prepare(`
    INSERT INTO lore_entries (world_id, keys_json, secondary_json, title, content, category, priority, constant, enabled, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    worldId,
    JSON.stringify(entry.keys || []),
    JSON.stringify(entry.secondary || []),
    entry.title || '',
    String(entry.content || ''),
    entry.category || 'setting',
    Number(entry.priority) || 50,
    entry.constant ? 1 : 0,
    entry.enabled === false ? 0 : 1,
    999,
  );
  return Number(info.lastInsertRowid);
}

export function updateLore(worldId, id, patch = {}) {
  const row = getDb().prepare(`SELECT * FROM lore_entries WHERE id=? AND world_id=?`).get(id, worldId);
  if (!row) return false;
  getDb().prepare(`
    UPDATE lore_entries SET keys_json=?, secondary_json=?, title=?, content=?, category=?, priority=?, constant=?, enabled=?
    WHERE id=?
  `).run(
    JSON.stringify(patch.keys ?? JSON.parse(row.keys_json || '[]')),
    JSON.stringify(patch.secondary ?? JSON.parse(row.secondary_json || '[]')),
    patch.title ?? row.title,
    patch.content ?? row.content,
    patch.category ?? row.category,
    patch.priority ?? row.priority,
    patch.constant == null ? row.constant : (patch.constant ? 1 : 0),
    patch.enabled == null ? row.enabled : (patch.enabled ? 1 : 0),
    id,
  );
  return true;
}

export function deleteLore(worldId, id) {
  return Number(getDb().prepare(`DELETE FROM lore_entries WHERE id=? AND world_id=?`).run(id, worldId).changes) > 0;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Sessions                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

export function createSession({ id, worldId = null, title, settings = {} }) {
  const d = getDb();
  const now = Date.now();
  d.prepare(`
    INSERT INTO sessions (id, world_id, title, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, worldId, title || '未命名剧情', JSON.stringify(settings || {}), now, now);
  return getSession(id);
}

export function getSession(id) {
  const row = getDb().prepare(`SELECT * FROM sessions WHERE id=?`).get(id);
  if (!row) return null;
  return {
    ...row,
    settings: JSON.parse(row.settings_json || '{}'),
    usage: row.usage_json ? JSON.parse(row.usage_json) : null,
  };
}

export function listSessions({ worldId = null } = {}) {
  const d = getDb();
  const sql = `
    SELECT s.*, w.title AS world_title, w.cover_hue AS world_hue,
      (SELECT content FROM turns t WHERE t.session_id = s.id AND t.kind = 'narrator'
       ORDER BY t.turn_no DESC, t.id DESC LIMIT 1) AS last_narrative
    FROM sessions s LEFT JOIN worlds w ON w.id = s.world_id
    ${worldId ? 'WHERE s.world_id = ?' : ''}
    ORDER BY s.updated_at DESC
  `;
  const rows = worldId ? d.prepare(sql).all(worldId) : d.prepare(sql).all();
  return rows.map((r) => ({
    id: r.id,
    world_id: r.world_id,
    world_title: r.world_title,
    world_hue: r.world_hue,
    title: r.title,
    turn_count: r.turn_count,
    updated_at: r.updated_at,
    created_at: r.created_at,
    status: r.status,
    usage: r.usage_json ? JSON.parse(r.usage_json) : null,
    last_message: r.last_narrative || null,
  }));
}

export function updateSession(id, { title, settings, status, worldId } = {}) {
  const s = getSession(id);
  if (!s) return null;
  const next = {
    title: title ?? s.title,
    settings: settings ? { ...s.settings, ...settings } : s.settings,
    status: status ?? s.status,
    worldId: worldId === undefined ? s.world_id : worldId,
  };
  getDb().prepare(`UPDATE sessions SET title=?, settings_json=?, status=?, world_id=?, updated_at=? WHERE id=?`)
    .run(next.title, JSON.stringify(next.settings), next.status, next.worldId, Date.now(), id);
  return getSession(id);
}

export function deleteSession(id) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    for (const t of ['turns', 'summaries', 'entities', 'facts', 'states', 'notes', 'relations', 'threads', 'reflections']) {
      d.prepare(`DELETE FROM ${t} WHERE session_id=?`).run(id);
    }
    d.prepare(`DELETE FROM sessions WHERE id=?`).run(id);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function touchSession(id, turnCount) {
  getDb().prepare(`UPDATE sessions SET updated_at=?, turn_count=? WHERE id=?`)
    .run(Date.now(), turnCount, id);
}

/** 累加会话级 token 遥测（每轮把本轮 usage 汇总进 sessions.usage_json）。 */
export function accumulateUsage(sessionId, usage) {
  if (!usage) return null;
  const s = getSession(sessionId);
  if (!s) return null;
  const prev = s.usage || {
    requests: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0,
    reasoning_tokens: 0, total_ms: 0, first_token_ms: 0, output_chars: 0,
  };
  const next = {
    requests: prev.requests + 1,
    prompt_tokens: prev.prompt_tokens + (usage.prompt_tokens || 0),
    completion_tokens: prev.completion_tokens + (usage.completion_tokens || 0),
    cached_tokens: prev.cached_tokens + (usage.cached_tokens || 0),
    reasoning_tokens: prev.reasoning_tokens + (usage.reasoning_tokens || 0),
    total_ms: prev.total_ms + (usage.duration_ms || 0),
    first_token_ms: prev.first_token_ms + (usage.ttft_ms || 0),
    output_chars: prev.output_chars + (usage.output_chars || 0),
  };
  getDb().prepare(`UPDATE sessions SET usage_json=? WHERE id=?`).run(JSON.stringify(next), sessionId);
  return next;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Turns                                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

export function addTurn(sessionId, turn) {
  const d = getDb();
  const tokenCount = turn.token_count ?? estimateTokens(turn.content);
  const info = d.prepare(`
    INSERT INTO turns (session_id, turn_no, kind, content, images_json, reasoning, branch_choice_json, token_count, usage_json, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, turn_no, kind) DO UPDATE SET
      content=excluded.content, images_json=excluded.images_json, reasoning=excluded.reasoning,
      branch_choice_json=excluded.branch_choice_json, token_count=excluded.token_count,
      usage_json=excluded.usage_json, meta_json=excluded.meta_json
  `).run(
    sessionId, turn.turn_no, turn.kind, turn.content,
    turn.images ? JSON.stringify(turn.images) : null,
    turn.reasoning || null,
    turn.branch_choice ? JSON.stringify(turn.branch_choice) : null,
    tokenCount,
    turn.usage ? JSON.stringify(turn.usage) : null,
    turn.meta ? JSON.stringify(turn.meta) : null,
    Date.now(),
  );
  return { id: Number(info.lastInsertRowid), token_count: tokenCount };
}

function decorateTurn(row) {
  return {
    ...row,
    images: row.images_json ? JSON.parse(row.images_json) : null,
    branch_choice: row.branch_choice_json ? JSON.parse(row.branch_choice_json) : null,
    usage: row.usage_json ? JSON.parse(row.usage_json) : null,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
  };
}

export function getTurns(sessionId, { from = 1, to = Number.MAX_SAFE_INTEGER, kinds = null } = {}) {
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
  `).all(sessionId, Math.max(1, n) * 2 + 4);
  return rows.reverse().map(decorateTurn);
}

export function getMaxTurnNo(sessionId) {
  const row = getDb().prepare(`SELECT MAX(turn_no) AS m FROM turns WHERE session_id=?`).get(sessionId);
  return row?.m || 0;
}

export function getTurn(sessionId, turnNo, kind) {
  const row = getDb().prepare(
    `SELECT * FROM turns WHERE session_id=? AND turn_no=? AND kind=?`,
  ).get(sessionId, turnNo, kind);
  return row ? decorateTurn(row) : null;
}

export function updateTurnContent(sessionId, turnNo, kind, content) {
  const info = getDb().prepare(
    `UPDATE turns SET content=?, token_count=?, edited=1 WHERE session_id=? AND turn_no=? AND kind=?`,
  ).run(content, estimateTokens(content), sessionId, turnNo, kind);
  return Number(info.changes) > 0;
}

/** 取最近 n 轮的原文文本，用于词条触发扫描。 */
export function getRecentText(sessionId, turnsBack = 8) {
  const max = getMaxTurnNo(sessionId);
  if (!max) return '';
  const from = Math.max(1, max - turnsBack + 1);
  const rows = getDb().prepare(`
    SELECT content FROM turns WHERE session_id=? AND turn_no>=? AND kind IN ('player','narrator')
    ORDER BY turn_no ASC, id ASC
  `).all(sessionId, from);
  return rows.map((r) => r.content || '').join('\n');
}

/**
 * 回滚到第 n 轮（含）：删除其后所有回合与派生记忆。
 */
export function truncateSession(sessionId, turnNo) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const t = d.prepare(`DELETE FROM turns WHERE session_id=? AND turn_no>?`).run(sessionId, turnNo);
    const s = d.prepare(`DELETE FROM summaries WHERE session_id=? AND turn_to>?`).run(sessionId, turnNo);
    const st = d.prepare(`DELETE FROM states WHERE session_id=? AND turn_no>?`).run(sessionId, turnNo);
    const f = d.prepare(`DELETE FROM facts WHERE session_id=? AND turn_no>?`).run(sessionId, turnNo);
    const r = d.prepare(`DELETE FROM relations WHERE session_id=? AND turn_no>?`).run(sessionId, turnNo);
    const th = d.prepare(`DELETE FROM threads WHERE session_id=? AND planted_turn>?`).run(sessionId, turnNo);
    const rf = d.prepare(`DELETE FROM reflections WHERE session_id=? AND turn_to>?`).run(sessionId, turnNo);
    // 该轮之后实体的最后出现位置需要修正，否则会指向已删除的回合
    d.prepare(`UPDATE entities SET last_turn=? WHERE session_id=? AND last_turn>?`).run(turnNo, sessionId, turnNo);
    d.prepare(`UPDATE threads SET resolved_turn=NULL, status='open' WHERE session_id=? AND resolved_turn>?`)
      .run(sessionId, turnNo);
    d.exec('COMMIT');
    touchSession(sessionId, Math.max(getMaxTurnNo(sessionId), 0));
    return {
      turns: t.changes, summaries: s.changes, states: st.changes, facts: f.changes,
      relations: r.changes, threads: th.changes, reflections: rf.changes,
    };
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Summaries                                                             */
/* ══════════════════════════════════════════════════════════════════════ */

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
  const stmt = d.prepare(`UPDATE summaries SET archived=1 WHERE id=?`);
  for (const id of ids) stmt.run(id);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Entities                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

export function upsertEntity(sessionId, entity) {
  const d = getDb();
  const existing = d.prepare(
    `SELECT * FROM entities WHERE session_id=? AND type=? AND name=?`,
  ).get(sessionId, entity.type, entity.name);
  if (existing) {
    d.prepare(`
      UPDATE entities SET summary=?, attributes_json=?, last_turn=?, importance=?, mention_count=?, updated_at=?
      WHERE id=?
    `).run(
      entity.summary || existing.summary,
      entity.attributes
        ? JSON.stringify({ ...JSON.parse(existing.attributes_json || '{}'), ...entity.attributes })
        : existing.attributes_json,
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
  return getDb().prepare(sql).all(...params).map((e) => ({ ...e, attributes: JSON.parse(e.attributes_json || '{}') }));
}

export function setEntityPinned(sessionId, entityId, pinned) {
  const info = getDb().prepare(`UPDATE entities SET pinned=? WHERE session_id=? AND id=?`)
    .run(pinned ? 1 : 0, sessionId, entityId);
  return Number(info.changes) > 0;
}

export function updateEntity(sessionId, entityId, patch = {}) {
  const row = getDb().prepare(`SELECT * FROM entities WHERE session_id=? AND id=?`).get(sessionId, entityId);
  if (!row) return false;
  getDb().prepare(
    `UPDATE entities SET name=?, summary=?, importance=?, attributes_json=?, updated_at=? WHERE id=?`,
  ).run(
    patch.name ?? row.name,
    patch.summary ?? row.summary,
    patch.importance ?? row.importance,
    patch.attributes
      ? JSON.stringify({ ...JSON.parse(row.attributes_json || '{}'), ...patch.attributes })
      : row.attributes_json,
    Date.now(),
    entityId,
  );
  return true;
}

export function deleteEntity(sessionId, entityId) {
  return Number(getDb().prepare(`DELETE FROM entities WHERE session_id=? AND id=?`).run(sessionId, entityId).changes) > 0;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Facts                                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

export function addFact(sessionId, fact) {
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

export function setFactPinned(sessionId, factId, pinned) {
  const info = getDb().prepare(`UPDATE facts SET pinned=? WHERE session_id=? AND id=?`)
    .run(pinned ? 1 : 0, sessionId, factId);
  return Number(info.changes) > 0;
}

export function deleteFact(sessionId, factId, { hard = false } = {}) {
  const info = hard
    ? getDb().prepare(`DELETE FROM facts WHERE session_id=? AND id=?`).run(sessionId, factId)
    : getDb().prepare(`UPDATE facts SET status='retracted' WHERE session_id=? AND id=?`).run(sessionId, factId);
  return Number(info.changes) > 0;
}

export function addManualFact(sessionId, { subject, predicate, object, turn_no = 0, confidence = 1 }) {
  return addFact(sessionId, { subject, predicate, object, turn_no, confidence });
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Notes                                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

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
  return Number(getDb().prepare(`DELETE FROM notes WHERE id=? AND session_id=?`).run(noteId, sessionId).changes) > 0;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* States                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

export function setState(sessionId, turnNo, state) {
  getDb().prepare(`
    INSERT INTO states (session_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, turn_no) DO UPDATE SET state_json=excluded.state_json
  `).run(sessionId, turnNo, JSON.stringify(state), Date.now());
}

export function getState(sessionId) {
  const row = getDb().prepare(
    `SELECT * FROM states WHERE session_id=? ORDER BY turn_no DESC LIMIT 1`,
  ).get(sessionId);
  return row ? { turn_no: row.turn_no, state: JSON.parse(row.state_json) } : null;
}

export function getStateAt(sessionId, turnNo) {
  const row = getDb().prepare(
    `SELECT * FROM states WHERE session_id=? AND turn_no<=? ORDER BY turn_no DESC LIMIT 1`,
  ).get(sessionId, turnNo);
  return row ? { turn_no: row.turn_no, state: JSON.parse(row.state_json) } : null;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Relations（关系账本）                                                   */
/* ══════════════════════════════════════════════════════════════════════ */

export function upsertRelation(sessionId, rel) {
  const now = Date.now();
  const existing = getDb().prepare(
    `SELECT * FROM relations WHERE session_id=? AND from_name=? AND to_name=?`,
  ).get(sessionId, rel.from, rel.to);
  if (existing) {
    getDb().prepare(`
      UPDATE relations SET kind=?, sentiment=?, note=?, turn_no=?, updated_at=? WHERE id=?
    `).run(
      rel.kind || existing.kind,
      Number.isFinite(Number(rel.sentiment)) ? Number(rel.sentiment) : existing.sentiment,
      rel.note || existing.note,
      rel.turn_no ?? existing.turn_no,
      now,
      existing.id,
    );
    return existing.id;
  }
  const info = getDb().prepare(`
    INSERT INTO relations (session_id, from_name, to_name, kind, sentiment, note, turn_no, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, rel.from, rel.to, rel.kind || '',
    Number.isFinite(Number(rel.sentiment)) ? Number(rel.sentiment) : 0,
    rel.note || '', rel.turn_no ?? 0, now,
  );
  return Number(info.lastInsertRowid);
}

export function getRelations(sessionId, { limit = 60 } = {}) {
  return getDb().prepare(`
    SELECT * FROM relations WHERE session_id=? ORDER BY ABS(sentiment) DESC, turn_no DESC LIMIT ?
  `).all(sessionId, limit);
}

export function deleteRelation(sessionId, id) {
  return Number(getDb().prepare(`DELETE FROM relations WHERE session_id=? AND id=?`).run(sessionId, id).changes) > 0;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Threads（线索 / 伏笔账本）                                              */
/* ══════════════════════════════════════════════════════════════════════ */

export function upsertThread(sessionId, t) {
  const now = Date.now();
  const existing = getDb().prepare(
    `SELECT * FROM threads WHERE session_id=? AND title=?`,
  ).get(sessionId, t.title);
  if (existing) {
    getDb().prepare(`
      UPDATE threads SET status=?, weight=?, note=?, resolved_turn=?, updated_at=? WHERE id=?
    `).run(
      t.status || existing.status,
      Number.isFinite(Number(t.weight)) ? Number(t.weight) : existing.weight,
      t.note || existing.note,
      t.resolved_turn === undefined ? existing.resolved_turn : t.resolved_turn,
      now,
      existing.id,
    );
    return existing.id;
  }
  const info = getDb().prepare(`
    INSERT INTO threads (session_id, title, status, weight, planted_turn, resolved_turn, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, t.title, t.status || 'open',
    Number.isFinite(Number(t.weight)) ? Number(t.weight) : 0.5,
    t.planted_turn ?? 0,
    t.resolved_turn ?? null,
    t.note || '', now,
  );
  return Number(info.lastInsertRowid);
}

export function getThreads(sessionId, { status = null, limit = 40 } = {}) {
  let sql = `SELECT * FROM threads WHERE session_id=?`;
  const params = [sessionId];
  if (status) { sql += ` AND status=?`; params.push(status); }
  sql += ` ORDER BY status ASC, weight DESC, updated_at DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params);
}

export function deleteThread(sessionId, id) {
  return Number(getDb().prepare(`DELETE FROM threads WHERE session_id=? AND id=?`).run(sessionId, id).changes) > 0;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Reflections（反思洞察）                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

export function addReflection(sessionId, { turn_from, turn_to, kind = 'insight', content }) {
  const tokenCount = estimateTokens(content);
  const info = getDb().prepare(`
    INSERT INTO reflections (session_id, turn_from, turn_to, kind, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, turn_from, turn_to, kind, content, tokenCount, Date.now());
  return { id: Number(info.lastInsertRowid), token_count: tokenCount };
}

export function getReflections(sessionId, { limit = 12 } = {}) {
  return getDb().prepare(`
    SELECT * FROM reflections WHERE session_id=? ORDER BY turn_to DESC LIMIT ?
  `).all(sessionId, limit).reverse();
}

export function deleteReflection(sessionId, id) {
  return Number(getDb().prepare(`DELETE FROM reflections WHERE session_id=? AND id=?`).run(sessionId, id).changes) > 0;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* misc                                                                  */
/* ══════════════════════════════════════════════════════════════════════ */

export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
}
