/**
 * server/memory/store.js — 数据层（世界卡 · 剧情会话 · 记忆）
 *
 * 结构（v4）：世界卡描述世界，不描述故事。
 *
 *   世界卡（worlds + 三张投影表）
 *     worlds            card_json 是唯一真源（命题/宪章/卡司/辞书/时间线/锚点）
 *     codex_entries     类型化辞书：靠 links/tags 进场，不靠关键词触发
 *     timeline_events   past = 既定事实；future = 原著参考，默认不注入
 *     anchors           可玩时间点，每个带一份世界快照
 *
 *   剧情会话
 *     sessions          运行期参数 + 当前分支 + 当前锚点
 *     branches          回滚 = 开新分支，历史不删
 *     turns             逐轮原文，只追加，永不修改（branch_id 标记归属）
 *
 *   记忆（原文永远是唯一真相）
 *     states            场景账本：时间/地点/在场/随身/张力/钩子
 *     relations         关系账本：谁对谁什么态度，随时间演化
 *     threads           线索账本：埋了什么、收了没有
 *     notes             作者笔记：确定性记忆，优先级最高
 *     scenes            场次记录，从完整原文重写，不是摘要的摘要
 *     assertions        断言，带有效期；冲突时旧断言失效，不删除
 *     character_states  人物状态，按字段可寻址，局部更新
 *     voices            原声台词样本，用来锚定声音
 *     patches           Agent 提案审计：谁提的、证据是什么、接受了哪条
 */
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { estimateTokens } from '../tokens.js';
import { isFunctionalPredicate } from './predicates.js';

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
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      world_id TEXT REFERENCES worlds(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      card_snapshot_json TEXT,
      world_version INTEGER,
      turn_count INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      branch_id TEXT NOT NULL DEFAULT 'main',
      anchor_id TEXT,
      scene_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      turn_no INTEGER NOT NULL,
      kind TEXT NOT NULL,                 -- player | narrator | system
      content TEXT NOT NULL,
      images_json TEXT,
      reasoning TEXT,
      branch_choice_json TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT,
      meta_json TEXT,
      branch_taken TEXT,
      edited INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, turn_no, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_no);

    -- 场景账本是分支级状态：回滚后新分支必须回到分叉点的世界，而不是沿用旧线最新状态。
    CREATE TABLE IF NOT EXISTS states (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      turn_no INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, branch_id, turn_no)
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
      branch_id TEXT NOT NULL DEFAULT 'main',
      from_name TEXT NOT NULL,
      to_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '',        -- 亲情|主仆|爱慕|敌对|利用|旧识…
      sentiment REAL NOT NULL DEFAULT 0,    -- -1 敌意 … +1 亲近
      note TEXT NOT NULL DEFAULT '',
      turn_no INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, branch_id, from_name, to_name)
    );

    -- 线索/伏笔账本：埋了什么，收没收
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',  -- open | resolved | abandoned
      weight REAL NOT NULL DEFAULT 0.5,     -- 重要度 0-1
      planted_turn INTEGER NOT NULL DEFAULT 0,
      resolved_turn INTEGER,
      note TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, branch_id, title)
    );

    -- 关系/线索的追加式历史：当前表只保留最新值，分叉时按事件重放到分叉点。
    CREATE TABLE IF NOT EXISTS relation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      from_name TEXT NOT NULL,
      to_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '',
      sentiment REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      turn_no INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relation_events
      ON relation_events(session_id, branch_id, turn_no);

    CREATE TABLE IF NOT EXISTS thread_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      weight REAL NOT NULL DEFAULT 0.5,
      planted_turn INTEGER NOT NULL DEFAULT 0,
      resolved_turn INTEGER,
      note TEXT NOT NULL DEFAULT '',
      turn_no INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_events
      ON thread_events(session_id, branch_id, turn_no);

    /* ══════════════════════════════════════════════════════════════════ */
    /* v4：世界卡（类型化辞书 / 时间线 / 可玩时间点）                        */
    /* ══════════════════════════════════════════════════════════════════ */

    -- 辞书：类型化实体。靠 links/tags 进场，不靠关键词触发。
    CREATE TABLE IF NOT EXISTS codex_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      codex_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'custom',
      name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      facets_json TEXT NOT NULL DEFAULT '{}',
      links_json TEXT NOT NULL DEFAULT '[]',
      reveal TEXT NOT NULL DEFAULT 'public',
      canon_from TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_codex_world ON codex_entries(world_id, pinned DESC, sort ASC);

    -- 时间线：past 是既定事实，future 只是原著参考（默认不注入）。
    CREATE TABLE IF NOT EXISTS timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      when_label TEXT NOT NULL DEFAULT '',
      where_label TEXT NOT NULL DEFAULT '',
      what TEXT NOT NULL,
      who_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT '',
      canon TEXT NOT NULL DEFAULT 'future',
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_world ON timeline_events(world_id, canon, sort);

    -- 可玩时间点：每个起点带一份世界快照，中途开局才不会演崩。
    CREATE TABLE IF NOT EXISTS anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      anchor_id TEXT NOT NULL,
      label TEXT NOT NULL,
      after_event TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      opening_seed TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT ''
    );

    /* ══════════════════════════════════════════════════════════════════ */
    /* v4：记忆（分支 / 场次 / 断言 / 人物状态 / 原声 / 提案审计）            */
    /* ══════════════════════════════════════════════════════════════════ */

    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL,
      parent_branch TEXT NOT NULL DEFAULT '',
      fork_turn INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_branches ON branches(session_id, branch_id);

    -- 场次记录：从完整原文重写，不是摘要的摘要。
    CREATE TABLE IF NOT EXISTS scenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      scene_id TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      turn_from INTEGER NOT NULL,
      turn_to INTEGER NOT NULL,
      when_label TEXT NOT NULL DEFAULT '',
      place TEXT NOT NULL DEFAULT '',
      place_id TEXT NOT NULL DEFAULT '',
      cast_json TEXT NOT NULL DEFAULT '[]',
      question TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      threads_json TEXT NOT NULL DEFAULT '[]',
      state_json TEXT NOT NULL DEFAULT '{}',
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scenes_session ON scenes(session_id, branch_id, turn_from);

    -- 断言：带有效期。冲突时旧断言失效，不删除——「她曾经相信过什么」是剧情资产。
    CREATE TABLE IF NOT EXISTS assertions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from INTEGER NOT NULL DEFAULT 0,
      valid_to INTEGER,
      asserted_turn INTEGER NOT NULL DEFAULT 0,
      source_turn INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.9,
      visibility TEXT NOT NULL DEFAULT 'public',
      status TEXT NOT NULL DEFAULT 'active',
      superseded_by INTEGER,
      evidence TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assertions ON assertions(session_id, branch_id, subject, predicate);

    -- 人物状态：按字段可寻址，局部更新，不动身份根。
    CREATE TABLE IF NOT EXISTS character_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      who TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      valid_from INTEGER NOT NULL DEFAULT 0,
      valid_to INTEGER,
      updated_turn INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_char_states ON character_states(session_id, branch_id, who, field, valid_from);

    -- 世界状态增量：实体 + 路径 + 值，带有效期。
    -- 这是剧情中「世界发生变化」的唯一运行期写入口；永远不写回世界卡模板。
    CREATE TABLE IF NOT EXISTS world_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      entity_kind TEXT NOT NULL,            -- cast | codex | player | world
      entity_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      op TEXT NOT NULL DEFAULT 'set',       -- set | add | remove | introduce
      value_json TEXT NOT NULL DEFAULT 'null',
      valid_from INTEGER NOT NULL DEFAULT 0,
      valid_to INTEGER,
      source TEXT NOT NULL DEFAULT 'archivist',
      evidence TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_world_state ON world_state(session_id, branch_id, entity_kind, entity_id, path, valid_from);

    -- 原声：从正文里摘出来的台词样本，用来锚定声音，不靠形容词描述。
    CREATE TABLE IF NOT EXISTS voices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      who TEXT NOT NULL,
      text TEXT NOT NULL,
      turn_no INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'line',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voices ON voices(session_id, branch_id, who, turn_no DESC);

    -- 提案审计：Agent 只提案，代码才落库。这里记下谁提的、证据是什么。
    CREATE TABLE IF NOT EXISTS patches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      agent TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      evidence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'proposed',
      severity TEXT NOT NULL DEFAULT 'info',
      turn_no INTEGER NOT NULL DEFAULT 0,
      applied_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_patches ON patches(session_id, branch_id, created_at DESC);

    -- 前情提要：滚动摘要，分支级。covers_turn_to 及之前的回合在装配时不再逐字出现。
    -- 原文永不删除：摘要只影响装配，细节仍可从 turns 检索/回溯。
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL DEFAULT 'main',
      covers_turn_to INTEGER NOT NULL,
      text TEXT NOT NULL,
      prev_id INTEGER,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, branch_id, covers_turn_to)
    );
    CREATE INDEX IF NOT EXISTS idx_summaries ON summaries(session_id, branch_id, covers_turn_to DESC);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_states_branch ON states(session_id, branch_id, turn_no);
    CREATE INDEX IF NOT EXISTS idx_relations_branch ON relations(session_id, branch_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_branch ON threads(session_id, branch_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_world ON sessions(world_id, updated_at DESC);
  `);
  return db;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Worlds                                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

function upsertWorld(world) {
  const d = getDb();
  const now = Date.now();
  const existing = d.prepare(`SELECT id, created_at FROM worlds WHERE id=?`).get(world.id);
  if (existing) {
    d.prepare(`
      UPDATE worlds SET title=?, subtitle=?, cover_hue=?, tags_json=?, card_json=?, source_json=?,
        version=version+1, updated_at=?
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
      INSERT INTO worlds (id, title, subtitle, cover_hue, tags_json, card_json, source_json, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
export function createSession({
  id, worldId = null, title, settings = {}, cardSnapshot = null, worldVersion = null,
}) {
  const d = getDb();
  const now = Date.now();
  d.prepare(`
    INSERT INTO sessions (id, world_id, title, settings_json, card_snapshot_json, world_version,
      created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, worldId, title || '未命名剧情', JSON.stringify(settings || {}),
    cardSnapshot ? JSON.stringify(cardSnapshot) : null,
    worldVersion ?? null, now, now,
  );
  return getSession(id);
}

export function getSession(id) {
  const row = getDb().prepare(`SELECT * FROM sessions WHERE id=?`).get(id);
  if (!row) return null;
  return {
    ...row,
    settings: JSON.parse(row.settings_json || '{}'),
    card_snapshot: row.card_snapshot_json ? JSON.parse(row.card_snapshot_json) : null,
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
    for (const t of ['turns', 'states', 'notes', 'relations', 'threads',
      'scenes', 'assertions', 'character_states', 'voices', 'patches', 'branches']) {
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
    INSERT INTO turns (session_id, turn_no, kind, content, images_json, reasoning, branch_choice_json, token_count, usage_json, meta_json, branch_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, turn_no, kind) DO UPDATE SET
      content=excluded.content, images_json=excluded.images_json, reasoning=excluded.reasoning,
      branch_choice_json=excluded.branch_choice_json, token_count=excluded.token_count,
      usage_json=excluded.usage_json, meta_json=excluded.meta_json,
      branch_id=excluded.branch_id
  `).run(
    sessionId, turn.turn_no, turn.kind, turn.content,
    turn.images ? JSON.stringify(turn.images) : null,
    turn.reasoning || null,
    turn.branch_choice ? JSON.stringify(turn.branch_choice) : null,
    tokenCount,
    turn.usage ? JSON.stringify(turn.usage) : null,
    turn.meta ? JSON.stringify(turn.meta) : null,
    turn.branch_id || 'main',
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

export function getMaxTurnNo(sessionId) {
  const row = getDb().prepare(`SELECT MAX(turn_no) AS m FROM turns WHERE session_id=?`).get(sessionId);
  return row?.m || 0;
}

/**
 * 回合高水位：最大回合号 + 最大行 id。
 * 分支守卫用行 id：同一回合的 narrator/player 是两行，只看 turn_no 检测不到追写。
 */
export function getTurnWatermark(sessionId) {
  const row = getDb().prepare(
    `SELECT COALESCE(MAX(turn_no),0) AS max_turn, COALESCE(MAX(id),0) AS max_id FROM turns WHERE session_id=?`,
  ).get(sessionId);
  return { maxTurnNo: row?.max_turn || 0, maxId: row?.max_id || 0 };
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

export function setState(sessionId, turnNo, state, branchId = 'main') {
  getDb().prepare(`
    INSERT INTO states (session_id, branch_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, branch_id, turn_no) DO UPDATE SET state_json=excluded.state_json
  `).run(sessionId, branchId || 'main', turnNo, JSON.stringify(state), Date.now());
}

/**
 * 取账本。branchId 为空时保留「全会话最新」的旧行为（只给不区分分支的读取用）；
 * 装配与管线必须显式传 branchId + atTurn。
 */
export function getState(sessionId, { branchId = null, atTurn = null } = {}) {
  let sql = `SELECT * FROM states WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  if (atTurn != null) { sql += ` AND turn_no<=?`; params.push(atTurn); }
  sql += ` ORDER BY turn_no DESC LIMIT 1`;
  const row = getDb().prepare(sql).get(...params);
  return row ? { turn_no: row.turn_no, branch_id: row.branch_id, state: JSON.parse(row.state_json) } : null;
}

export function upsertRelation(sessionId, rel) {
  const now = Date.now();
  const branchId = rel.branch_id || 'main';
  const existing = getDb().prepare(
    `SELECT * FROM relations WHERE session_id=? AND branch_id=? AND from_name=? AND to_name=?`,
  ).get(sessionId, branchId, rel.from, rel.to);

  const next = existing
    ? {
      kind: rel.kind || existing.kind,
      sentiment: Number.isFinite(Number(rel.sentiment)) ? Number(rel.sentiment) : existing.sentiment,
      note: rel.note || existing.note,
      turn_no: rel.turn_no ?? existing.turn_no,
    }
    : {
      kind: rel.kind || '',
      sentiment: Number.isFinite(Number(rel.sentiment)) ? Number(rel.sentiment) : 0,
      note: rel.note || '',
      turn_no: rel.turn_no ?? 0,
    };

  let id;
  if (existing) {
    getDb().prepare(`
      UPDATE relations SET kind=?, sentiment=?, note=?, turn_no=?, updated_at=? WHERE id=?
    `).run(next.kind, next.sentiment, next.note, next.turn_no, now, existing.id);
    id = existing.id;
  } else {
    const info = getDb().prepare(`
      INSERT INTO relations (session_id, branch_id, from_name, to_name, kind, sentiment, note, turn_no, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, branchId, rel.from, rel.to, next.kind, next.sentiment, next.note, next.turn_no, now);
    id = Number(info.lastInsertRowid);
  }

  // 追加式历史：分叉时按 turn_no 重放，而不是整表复制「最新值」。
  getDb().prepare(`
    INSERT INTO relation_events
      (session_id, branch_id, from_name, to_name, kind, sentiment, note, turn_no, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, branchId, rel.from, rel.to, next.kind, next.sentiment, next.note, next.turn_no, now);
  return id;
}

export function getRelations(sessionId, { branchId = null, limit = 60 } = {}) {
  let sql = `SELECT * FROM relations WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  sql += ` ORDER BY ABS(sentiment) DESC, turn_no DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params);
}

export function upsertThread(sessionId, t) {
  const now = Date.now();
  const branchId = t.branch_id || 'main';
  const existing = getDb().prepare(
    `SELECT * FROM threads WHERE session_id=? AND branch_id=? AND title=?`,
  ).get(sessionId, branchId, t.title);

  const next = existing
    ? {
      status: t.status || existing.status,
      weight: Number.isFinite(Number(t.weight)) ? Number(t.weight) : existing.weight,
      note: t.note || existing.note,
      resolved_turn: t.resolved_turn === undefined ? existing.resolved_turn : t.resolved_turn,
      planted_turn: existing.planted_turn,
    }
    : {
      status: t.status || 'open',
      weight: Number.isFinite(Number(t.weight)) ? Number(t.weight) : 0.5,
      note: t.note || '',
      resolved_turn: t.resolved_turn ?? null,
      planted_turn: t.planted_turn ?? 0,
    };
  const eventTurn = t.turn_no ?? t.resolved_turn ?? t.planted_turn ?? existing?.planted_turn ?? 0;

  let id;
  if (existing) {
    getDb().prepare(`
      UPDATE threads SET status=?, weight=?, note=?, resolved_turn=?, updated_at=? WHERE id=?
    `).run(next.status, next.weight, next.note, next.resolved_turn, now, existing.id);
    id = existing.id;
  } else {
    const info = getDb().prepare(`
      INSERT INTO threads (session_id, branch_id, title, status, weight, planted_turn, resolved_turn, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, branchId, t.title, next.status, next.weight,
      next.planted_turn, next.resolved_turn, next.note, now,
    );
    id = Number(info.lastInsertRowid);
  }

  getDb().prepare(`
    INSERT INTO thread_events
      (session_id, branch_id, title, status, weight, planted_turn, resolved_turn, note, turn_no, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, branchId, t.title, next.status, next.weight,
    next.planted_turn, next.resolved_turn, next.note, eventTurn, now,
  );
  return id;
}

export function getThreads(sessionId, { branchId = null, status = null, limit = 40 } = {}) {
  let sql = `SELECT * FROM threads WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  if (status) { sql += ` AND status=?`; params.push(status); }
  sql += ` ORDER BY status ASC, weight DESC, updated_at DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* v4：世界状态增量（实体 + 路径 + 有效期）                                 */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 追加一条世界状态增量。set 会关闭同一 (entity, path) 的旧值；
 * add / remove / introduce 保留历史，由投影器按顺序应用。
 */
export function addWorldState(sessionId, delta) {
  const d = getDb();
  const branchId = delta.branch_id || 'main';
  const kind = String(delta.entity_kind || '').trim();
  const entityId = String(delta.entity_id || '').trim();
  const path = String(delta.path || '').trim();
  const op = ['set', 'add', 'remove', 'introduce'].includes(delta.op) ? delta.op : 'set';
  if (!kind || !entityId) return null;
  if (op !== 'introduce' && !path) return null;
  const turn = Number(delta.turn ?? delta.valid_from ?? 0) || 0;

  d.exec('BEGIN');
  try {
    if (op === 'set') {
      d.prepare(`
        UPDATE world_state SET valid_to=?
        WHERE session_id=? AND branch_id=? AND entity_kind=? AND entity_id=? AND path=? AND valid_to IS NULL
      `).run(turn, sessionId, branchId, kind, entityId, path);
    }
    const info = d.prepare(`
      INSERT INTO world_state (session_id, branch_id, entity_kind, entity_id, path, op,
        value_json, valid_from, valid_to, source, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      sessionId, branchId, kind, entityId, path, op,
      JSON.stringify(delta.value ?? null), turn,
      String(delta.source || 'archivist'), String(delta.evidence || ''), Date.now(),
    );
    d.exec('COMMIT');
    return Number(info.lastInsertRowid);
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** 取某分支在 atTurn 时刻仍有效的全部增量，按写入顺序返回。 */
export function getWorldState(sessionId, { branchId = null, atTurn = null } = {}) {
  let sql = `SELECT * FROM world_state WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  if (atTurn != null) { sql += ` AND valid_from<=?`; params.push(atTurn); }
  sql += ` ORDER BY valid_from ASC, id ASC`;
  const rows = getDb().prepare(sql).all(...params);
  return rows
    .filter((r) => r.valid_to == null || atTurn == null || r.valid_to > atTurn)
    .map((r) => ({
      ...r,
      value: JSON.parse(r.value_json ?? 'null'),
    }));
}

const jsonOf = (v) => JSON.stringify(v ?? []);

/**
 * 保存整张世界卡：card_json 是唯一真源，codex / timeline / anchors 表是
 * 它的可查询投影（供「按实体/按 canon 查」这类 SQL 查询使用）。
 */
export function saveWorld(world) {
  const card = world.card || {};
  upsertWorld(world);
  const w = getWorld(world.id);
  replaceCodex(w.id, card.codex || []);
  replaceTimeline(w.id, card.timeline || []);
  replaceAnchors(w.id, card.anchors || []);
  return w;
}

function replaceCodex(worldId, entries = []) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare(`DELETE FROM codex_entries WHERE world_id=?`).run(worldId);
    const stmt = d.prepare(`
      INSERT INTO codex_entries (world_id, codex_id, type, name, aliases_json, tags_json, summary,
        facets_json, links_json, reveal, canon_from, detail, pinned, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    entries.forEach((e, i) => {
      if (!e?.name && !e?.summary) return;
      stmt.run(
        worldId, String(e.id || ''), String(e.type || 'custom'), String(e.name || ''),
        jsonOf(e.aliases), jsonOf(e.tags), String(e.summary || ''),
        jsonOf(e.facets || {}), jsonOf(e.links), String(e.reveal || 'public'),
        String(e.canon_from || ''), String(e.detail || ''), e.pinned ? 1 : 0, i,
      );
    });
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return getCodex(worldId);
}

export function getCodex(worldId) {
  return getDb().prepare(`SELECT * FROM codex_entries WHERE world_id=? ORDER BY pinned DESC, sort ASC, id ASC`)
    .all(worldId)
    .map((r) => ({
      ...r,
      aliases: JSON.parse(r.aliases_json || '[]'),
      tags: JSON.parse(r.tags_json || '[]'),
      facets: JSON.parse(r.facets_json || '{}'),
      links: JSON.parse(r.links_json || '[]'),
      pinned: !!r.pinned,
    }));
}

export function setCodexPinned(worldId, codexId, pinned) {
  const info = getDb().prepare(`UPDATE codex_entries SET pinned=? WHERE world_id=? AND codex_id=?`)
    .run(pinned ? 1 : 0, worldId, codexId);
  if (Number(info.changes) > 0) {
    // 钉选属于模板变更：已开的会话继续用旧快照，新会话才看到新版本。
    getDb().prepare(`UPDATE worlds SET version=version+1, updated_at=? WHERE id=?`).run(Date.now(), worldId);
  }
  return Number(info.changes) > 0;
}

function replaceTimeline(worldId, events = []) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare(`DELETE FROM timeline_events WHERE world_id=?`).run(worldId);
    const stmt = d.prepare(`
      INSERT INTO timeline_events (world_id, event_id, when_label, where_label, what, who_json, source, canon, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    events.forEach((e, i) => {
      if (!e?.what) return;
      stmt.run(
        worldId, String(e.id || `evt-${i + 1}`), String(e.when || ''), String(e.where || ''),
        String(e.what), jsonOf(e.who), String(e.source || ''),
        ['past', 'future', 'branch'].includes(e.canon) ? e.canon : 'future', i,
      );
    });
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

function replaceAnchors(worldId, anchors = []) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.prepare(`DELETE FROM anchors WHERE world_id=?`).run(worldId);
    const stmt = d.prepare(`
      INSERT INTO anchors (world_id, anchor_id, label, after_event, snapshot_json, opening_seed, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    anchors.forEach((a) => {
      if (!a?.label) return;
      stmt.run(
        worldId, String(a.id || a.label), String(a.label), String(a.after_event || ''),
        JSON.stringify(a.snapshot || {}), String(a.opening_seed || ''), String(a.note || ''),
      );
    });
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
/* v4：分支（回滚 = 开新分支，历史不删）                                    */
/* ══════════════════════════════════════════════════════════════════════ */

export function createBranch(sessionId, { branchId, parentBranch = '', forkTurn = 0, note = '' }) {
  getDb().prepare(`
    INSERT INTO branches (session_id, branch_id, parent_branch, fork_turn, status, note, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(session_id, branch_id) DO UPDATE SET status='active', note=excluded.note
  `).run(sessionId, branchId, parentBranch, forkTurn, note, Date.now());
  return getBranch(sessionId, branchId);
}

export function getBranch(sessionId, branchId) {
  return getDb().prepare(`SELECT * FROM branches WHERE session_id=? AND branch_id=?`).get(sessionId, branchId) || null;
}

export function listBranches(sessionId) {
  return getDb().prepare(`SELECT * FROM branches WHERE session_id=? ORDER BY id ASC`).all(sessionId);
}

export function setBranchStatus(sessionId, branchId, status) {
  getDb().prepare(`UPDATE branches SET status=? WHERE session_id=? AND branch_id=?`).run(status, sessionId, branchId);
}

export function setSessionBranch(sessionId, branchId, anchorId = null) {
  getDb().prepare(`UPDATE sessions SET branch_id=?, anchor_id=COALESCE(?, anchor_id), updated_at=? WHERE id=?`)
    .run(branchId, anchorId, Date.now(), sessionId);
}

/** 设置会话的当前起点锚点。 */
export function setSessionAnchor(sessionId, anchorId, branchId = null) {
  getDb().prepare(`UPDATE sessions SET anchor_id=?, branch_id=COALESCE(?, branch_id), updated_at=? WHERE id=?`)
    .run(anchorId, branchId, Date.now(), sessionId);
  return getSession(sessionId);
}

/**
 * 分叉时复制「分叉点仍然有效」的世界状态到新分支。
 *
 * 采用 copy-on-fork 而不是沿分支血缘回溯：新分支只看自己的行，
 * 回滚/重写不会读到旧线在分叉点之后写下的任何东西。历史仍完整留在旧分支。
 */
export function copyBranchState(sessionId, { fromBranch, toBranch, forkTurn = 0 }) {
  const d = getDb();
  const from = fromBranch || 'main';
  const to = toBranch;
  const turn = Number(forkTurn) || 0;
  d.exec('BEGIN');
  try {
    const state = getState(sessionId, { branchId: from, atTurn: turn });
    if (state?.state) {
      d.prepare(`
        INSERT INTO states (session_id, branch_id, turn_no, state_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, branch_id, turn_no) DO UPDATE SET state_json=excluded.state_json
      `).run(sessionId, to, turn, JSON.stringify(state.state), Date.now());
    }

    // 关系/线索：复制分叉点之前的事件，再按「每个键最后一条事件」重建当前表。
    // 旧会话没有事件表时，退回「只复制分叉点前的行」，至少不再把之后的更新带进来。
    d.prepare(`
      INSERT INTO relation_events
        (session_id, branch_id, from_name, to_name, kind, sentiment, note, turn_no, created_at)
      SELECT session_id, ?, from_name, to_name, kind, sentiment, note, turn_no, created_at
      FROM relation_events WHERE session_id=? AND branch_id=? AND turn_no<=?
    `).run(to, sessionId, from, turn);

    const relEvents = d.prepare(
      `SELECT COUNT(*) AS c FROM relation_events WHERE session_id=? AND branch_id=? AND turn_no<=?`,
    ).get(sessionId, to, turn).c;
    if (relEvents) {
      d.prepare(`DELETE FROM relations WHERE session_id=? AND branch_id=?`).run(sessionId, to);
      d.prepare(`
        INSERT INTO relations
          (session_id, branch_id, from_name, to_name, kind, sentiment, note, turn_no, updated_at)
        SELECT e.session_id, ?, e.from_name, e.to_name, e.kind, e.sentiment, e.note, e.turn_no, e.created_at
        FROM relation_events e
        JOIN (
          SELECT from_name, to_name, MAX(id) AS id
          FROM relation_events
          WHERE session_id=? AND branch_id=? AND turn_no<=?
          GROUP BY from_name, to_name
        ) latest ON latest.id = e.id
      `).run(to, sessionId, to, turn);

      // 混合库：升级前就存在、没有事件的关系，按当前行补进来（只取分叉点之前的）。
      d.prepare(`
        INSERT INTO relations
          (session_id, branch_id, from_name, to_name, kind, sentiment, note, turn_no, updated_at)
        SELECT r.session_id, ?, r.from_name, r.to_name, r.kind, r.sentiment, r.note, r.turn_no, r.updated_at
        FROM relations r
        WHERE r.session_id=? AND r.branch_id=? AND r.turn_no<=?
          AND NOT EXISTS (
            SELECT 1 FROM relation_events e
            WHERE e.session_id=? AND e.branch_id=? AND e.from_name=r.from_name
              AND e.to_name=r.to_name AND e.turn_no<=?
          )
      `).run(to, sessionId, from, turn, sessionId, to, turn);
    } else {
      d.prepare(`
        INSERT INTO relations
          (session_id, branch_id, from_name, to_name, kind, sentiment, note, turn_no, updated_at)
        SELECT session_id, ?, from_name, to_name, kind, sentiment, note, turn_no, updated_at
        FROM relations WHERE session_id=? AND branch_id=? AND turn_no<=?
      `).run(to, sessionId, from, turn);
    }

    d.prepare(`
      INSERT INTO thread_events
        (session_id, branch_id, title, status, weight, planted_turn, resolved_turn, note, turn_no, created_at)
      SELECT session_id, ?, title, status, weight, planted_turn, resolved_turn, note, turn_no, created_at
      FROM thread_events WHERE session_id=? AND branch_id=? AND turn_no<=?
    `).run(to, sessionId, from, turn);

    const threadEvents = d.prepare(
      `SELECT COUNT(*) AS c FROM thread_events WHERE session_id=? AND branch_id=? AND turn_no<=?`,
    ).get(sessionId, to, turn).c;
    if (threadEvents) {
      d.prepare(`DELETE FROM threads WHERE session_id=? AND branch_id=?`).run(sessionId, to);
      d.prepare(`
        INSERT INTO threads
          (session_id, branch_id, title, status, weight, planted_turn, resolved_turn, note, updated_at)
        SELECT e.session_id, ?, e.title, e.status, e.weight, e.planted_turn, e.resolved_turn, e.note, e.created_at
        FROM thread_events e
        JOIN (
          SELECT title, MAX(id) AS id
          FROM thread_events
          WHERE session_id=? AND branch_id=? AND turn_no<=?
          GROUP BY title
        ) latest ON latest.id = e.id
      `).run(to, sessionId, to, turn);

      // 混合库：没有事件的旧线索按当前行补；分叉点之后才回收的，恢复成 open。
      d.prepare(`
        INSERT INTO threads
          (session_id, branch_id, title, status, weight, planted_turn, resolved_turn, note, updated_at)
        SELECT r.session_id, ?, r.title,
          CASE WHEN r.resolved_turn IS NOT NULL AND r.resolved_turn>? THEN 'open' ELSE r.status END,
          r.weight, r.planted_turn,
          CASE WHEN r.resolved_turn>? THEN NULL ELSE r.resolved_turn END,
          r.note, r.updated_at
        FROM threads r
        WHERE r.session_id=? AND r.branch_id=? AND r.planted_turn<=?
          AND NOT EXISTS (
            SELECT 1 FROM thread_events e
            WHERE e.session_id=? AND e.branch_id=? AND e.title=r.title AND e.turn_no<=?
          )
      `).run(to, turn, turn, sessionId, from, turn, sessionId, to, turn);
    } else {
      d.prepare(`
        INSERT INTO threads
          (session_id, branch_id, title, status, weight, planted_turn, resolved_turn, note, updated_at)
        SELECT session_id, ?, title, status, weight, planted_turn, resolved_turn, note, updated_at
        FROM threads WHERE session_id=? AND branch_id=? AND planted_turn<=?
      `).run(to, sessionId, from, turn);
    }

    d.prepare(`
      INSERT INTO character_states (session_id, branch_id, who, field, value, valid_from, valid_to, updated_turn, created_at)
      SELECT session_id, ?, who, field, value, valid_from, valid_to, updated_turn, created_at
      FROM character_states
      WHERE session_id=? AND branch_id=? AND valid_from<=?
        AND (valid_to IS NULL OR valid_to>=?)
    `).run(to, sessionId, from, turn, turn);

    d.prepare(`
      INSERT INTO assertions (session_id, branch_id, subject, predicate, object, valid_from, valid_to,
        asserted_turn, source_turn, confidence, visibility, status, superseded_by, evidence, created_at)
      SELECT session_id, ?, subject, predicate, object, valid_from, valid_to,
        asserted_turn, source_turn, confidence, visibility, status, NULL, evidence, created_at
      FROM assertions
      WHERE session_id=? AND branch_id=? AND valid_from<=?
        AND (valid_to IS NULL OR valid_to>?) AND status<>'retracted'
    `).run(to, sessionId, from, turn, turn);

    d.prepare(`
      INSERT INTO voices (session_id, branch_id, who, text, turn_no, kind, pinned, created_at)
      SELECT session_id, ?, who, text, turn_no, kind, pinned, created_at
      FROM voices WHERE session_id=? AND branch_id=? AND turn_no<=?
    `).run(to, sessionId, from, turn);

    d.prepare(`
      INSERT INTO scenes (session_id, branch_id, scene_id, level, turn_from, turn_to, when_label, place,
        place_id, cast_json, question, outcome, threads_json, state_json, token_count, created_at)
      SELECT session_id, ?, scene_id, level, turn_from, turn_to, when_label, place,
        place_id, cast_json, question, outcome, threads_json, state_json, token_count, created_at
      FROM scenes WHERE session_id=? AND branch_id=? AND turn_to<=?
    `).run(to, sessionId, from, turn);

    d.prepare(`
      INSERT INTO world_state (session_id, branch_id, entity_kind, entity_id, path, op,
        value_json, valid_from, valid_to, source, evidence, created_at)
      SELECT session_id, ?, entity_kind, entity_id, path, op,
        value_json, valid_from, valid_to, source, evidence, created_at
      FROM world_state WHERE session_id=? AND branch_id=? AND valid_from<=?
    `).run(to, sessionId, from, turn);

    // 摘要只继承覆盖到分叉点为止的那部分；分叉之后写下的摘要不能被新线看到。
    d.prepare(`
      INSERT INTO summaries (session_id, branch_id, covers_turn_to, text, prev_id, token_count, created_at)
      SELECT session_id, ?, covers_turn_to, text, NULL, token_count, created_at
      FROM summaries WHERE session_id=? AND branch_id=? AND covers_turn_to<=?
      ON CONFLICT(session_id, branch_id, covers_turn_to) DO UPDATE SET
        text=excluded.text, token_count=excluded.token_count, created_at=excluded.created_at
    `).run(to, sessionId, from, turn);

    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return { branch_id: to, fork_turn: turn };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* v4：场次                                                               */
/* ══════════════════════════════════════════════════════════════════════ */

export function addScene(sessionId, scene) {
  const d = getDb();
  const existing = d.prepare(`SELECT id FROM scenes WHERE session_id=? AND branch_id=? AND scene_id=?`)
    .get(sessionId, scene.branch_id || 'main', scene.scene_id);
  if (existing) {
    d.prepare(`
      UPDATE scenes SET turn_to=?, question=?, outcome=?, cast_json=?, threads_json=?, state_json=?, token_count=?
      WHERE id=?
    `).run(
      scene.turn_to, scene.question || '', scene.outcome || '',
      JSON.stringify(scene.cast || []), JSON.stringify(scene.threads || []),
      JSON.stringify(scene.state || {}),
      estimateTokens(`${scene.question || ''}${scene.outcome || ''}`), existing.id,
    );
    return existing.id;
  }
  const info = d.prepare(`
    INSERT INTO scenes (session_id, branch_id, scene_id, level, turn_from, turn_to, when_label, place, place_id,
      cast_json, question, outcome, threads_json, state_json, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, scene.branch_id || 'main', scene.scene_id, scene.level || 1,
    scene.turn_from, scene.turn_to, scene.when_label || '', scene.place || '', scene.place_id || '',
    JSON.stringify(scene.cast || []), scene.question || '', scene.outcome || '',
    JSON.stringify(scene.threads || []), JSON.stringify(scene.state || {}),
    estimateTokens(`${scene.question || ''}${scene.outcome || ''}`), Date.now(),
  );
  return Number(info.lastInsertRowid);
}

function decorateScene(row) {
  if (!row) return null;
  return {
    ...row,
    cast: JSON.parse(row.cast_json || '[]'),
    threads: JSON.parse(row.threads_json || '[]'),
    state: JSON.parse(row.state_json || '{}'),
  };
}

export function getScenes(sessionId, { branchId = null, level = null, limit = 100 } = {}) {
  let sql = `SELECT * FROM scenes WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  if (level != null) { sql += ` AND level=?`; params.push(level); }
  sql += ` ORDER BY turn_from ASC, id ASC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params).map(decorateScene);
}

export function getSceneAt(sessionId, turnNo, branchId = null) {
  let sql = `SELECT * FROM scenes WHERE session_id=? AND turn_from<=? AND turn_to>=?`;
  const params = [sessionId, turnNo, turnNo];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  sql += ` ORDER BY turn_from DESC LIMIT 1`;
  return decorateScene(getDb().prepare(sql).get(...params));
}

export function latestScene(sessionId, branchId = null) {
  let sql = `SELECT * FROM scenes WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  sql += ` ORDER BY turn_from DESC, id DESC LIMIT 1`;
  return decorateScene(getDb().prepare(sql).get(...params));
}

/* ══════════════════════════════════════════════════════════════════════ */
/* v4：断言（带有效期，冲突失效不删除）                                     */
/* ══════════════════════════════════════════════════════════════════════ */

export function addAssertion(sessionId, a) {
  const info = getDb().prepare(`
    INSERT INTO assertions (session_id, branch_id, subject, predicate, object, valid_from, valid_to,
      asserted_turn, source_turn, confidence, visibility, status, superseded_by, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', NULL, ?, ?)
  `).run(
    sessionId, a.branch_id || 'main', String(a.subject || ''), String(a.predicate || ''),
    String(a.object || ''), Number(a.valid_from) || 0, Number(a.asserted_turn) || 0,
    Number(a.source_turn) || 0, Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : 0.9,
    String(a.visibility || 'public'), String(a.evidence || ''), Date.now(),
  );
  return Number(info.lastInsertRowid);
}

/** 旧断言失效（不是删除）：「她曾经相信过什么」本身就是剧情资产。 */
export function invalidateAssertion(sessionId, id, { validTo, supersededBy = null }) {
  getDb().prepare(`
    UPDATE assertions SET status='invalidated', valid_to=?, superseded_by=COALESCE(?, superseded_by)
    WHERE session_id=? AND id=?
  `).run(validTo, supersededBy, sessionId, id);
}

export function retractAssertion(sessionId, id) {
  getDb().prepare(`UPDATE assertions SET status='retracted' WHERE session_id=? AND id=?`).run(sessionId, id);
}

export function getAssertions(sessionId, {
  branchId = null, subject = null, predicate = null, atTurn = null,
  includeInvalid = false, visibility = null, limit = 500,
} = {}) {
  let sql = `SELECT * FROM assertions WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  if (subject) { sql += ` AND subject=?`; params.push(subject); }
  if (predicate) { sql += ` AND predicate=?`; params.push(predicate); }
  if (visibility) { sql += ` AND visibility=?`; params.push(visibility); }
  if (atTurn != null) {
    // 按时间点回溯：看当时还有效的。后来才失效的断言在那时仍然成立，
    // 所以不过滤 status，只按有效期窗口筛。
    // valid_to 是「失效发生在这一轮」：这一轮起旧断言不再成立。
    sql += ` AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) AND status<>'retracted'`;
    params.push(atTurn, atTurn);
  } else if (!includeInvalid) {
    sql += ` AND status='active'`;
  }
  sql += ` ORDER BY valid_from DESC, id DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params);
}

/** 找出与待写入断言冲突的旧断言：同主同谓、对象不同、有效期重叠。 */
export function findConflictingAssertions(sessionId, { branchId, subject, predicate, object, validFrom }) {
  if (!subject || !predicate || !object) return [];
  // 多值谓词（知道/拥有/想要…）可以同时有多个对象；只有单值谓词才算矛盾。
  if (!isFunctionalPredicate(predicate)) return [];
  const rows = getDb().prepare(`
    SELECT * FROM assertions
    WHERE session_id=? AND branch_id=? AND subject=? AND predicate=? AND status='active'
      AND object<>? AND valid_from<=?
  `).all(sessionId, branchId || 'main', subject, predicate, object, validFrom || 0);
  return rows.filter((r) => r.valid_to == null || r.valid_to >= (validFrom || 0));
}

/* ══════════════════════════════════════════════════════════════════════ */
/* v4：人物状态（按字段可寻址）                                            */
/* ══════════════════════════════════════════════════════════════════════ */

export function setCharState(sessionId, { branchId, who, field, value, turn }) {
  const d = getDb();
  d.prepare(`
    UPDATE character_states SET valid_to=?
    WHERE session_id=? AND branch_id=? AND who=? AND field=? AND valid_to IS NULL
  `).run(turn, sessionId, branchId || 'main', who, field);
  const info = d.prepare(`
    INSERT INTO character_states (session_id, branch_id, who, field, value, valid_from, valid_to, updated_turn, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(sessionId, branchId || 'main', who, field, String(value ?? ''), turn, turn, Date.now());
  return Number(info.lastInsertRowid);
}

export function getCharStates(sessionId, { branchId = null, who = null, atTurn = null } = {}) {
  let sql = `SELECT * FROM character_states WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  if (who) { sql += ` AND who=?`; params.push(who); }
  if (atTurn != null) sql += ` AND valid_from<=? AND (valid_to IS NULL OR valid_to>=?)`;
  if (atTurn != null) params.push(atTurn, atTurn);
  sql += ` ORDER BY who ASC, field ASC, valid_from DESC`;
  return getDb().prepare(sql).all(...params);
}

/** 取每个 (who, field) 在 atTurn 时刻的最新值，组装成 {who: {field: value}}。 */
export function getCharStateMap(sessionId, { branchId = null, atTurn = null } = {}) {
  const rows = getCharStates(sessionId, { branchId, atTurn });
  const out = {};
  for (const r of rows) {
    out[r.who] = out[r.who] || {};
    if (!(r.field in out[r.who])) out[r.who][r.field] = r.value;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* v4：原声（台词样本）                                                    */
/* ══════════════════════════════════════════════════════════════════════ */

export function addVoice(sessionId, v) {
  const info = getDb().prepare(`
    INSERT INTO voices (session_id, branch_id, who, text, turn_no, kind, pinned, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, v.branch_id || 'main', String(v.who || ''), String(v.text || ''),
    Number(v.turn_no) || 0, String(v.kind || 'line'), v.pinned ? 1 : 0, Date.now(),
  );
  return Number(info.lastInsertRowid);
}

export function getVoices(sessionId, { branchId = null, who = null, limit = 40, pinnedOnly = false } = {}) {
  let sql = `SELECT * FROM voices WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  if (who) { sql += ` AND who=?`; params.push(who); }
  if (pinnedOnly) sql += ` AND pinned=1`;
  sql += ` ORDER BY pinned DESC, turn_no DESC, id DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params);
}

export function setVoicePinned(sessionId, id, pinned) {
  getDb().prepare(`UPDATE voices SET pinned=? WHERE session_id=? AND id=?`).run(pinned ? 1 : 0, sessionId, id);
}

export function deleteVoice(sessionId, id) {
  return Number(getDb().prepare(`DELETE FROM voices WHERE session_id=? AND id=?`).run(sessionId, id).changes) > 0;
}

/** 每个 who 取最近 n 条原声，组装成 {who: [text]}。 */
export function getVoiceMap(sessionId, { branchId = null, perWho = 3 } = {}) {
  const rows = getVoices(sessionId, { branchId, limit: 400 });
  const out = {};
  for (const r of rows) {
    if (!r.who) continue;
    out[r.who] = out[r.who] || [];
    if (out[r.who].length < perWho) out[r.who].push(r.text);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* v4：提案审计                                                           */
/* ══════════════════════════════════════════════════════════════════════ */

export function addPatch(sessionId, p) {
  const info = getDb().prepare(`
    INSERT INTO patches (session_id, branch_id, agent, kind, payload_json, evidence, status, severity, turn_no, applied_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, p.branch_id || 'main', String(p.agent || ''), String(p.kind || ''),
    JSON.stringify(p.payload ?? {}), String(p.evidence || ''), String(p.status || 'proposed'),
    String(p.severity || 'info'), Number(p.turn_no) || 0,
    p.status === 'applied' ? Date.now() : null, Date.now(),
  );
  return Number(info.lastInsertRowid);
}

export function listPatches(sessionId, { branchId = null, status = null, limit = 50 } = {}) {
  let sql = `SELECT * FROM patches WHERE session_id=?`;
  const params = [sessionId];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  if (status) { sql += ` AND status=?`; params.push(status); }
  sql += ` ORDER BY id DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params).map((r) => ({ ...r, payload: JSON.parse(r.payload_json || '{}') }));
}

export function setPatchStatus(sessionId, id, status) {
  getDb().prepare(`UPDATE patches SET status=?, applied_at=CASE WHEN ?='applied' THEN ? ELSE applied_at END WHERE session_id=? AND id=?`)
    .run(status, status, Date.now(), sessionId, id);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* v4：分支可见的回合与原文检索                                            */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 取某分支可见的回合：分支自己的回合 + 分叉点之前继承来的回合。
 * 回合编号全局递增，回rollback只是换分支，不是删历史。
 */
/* ══════════════════════════════════════════════════════════════════════ */
/* v4：前情提要（滚动摘要）                                                */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 写入一份摘要。同一分支/同一覆盖边界重复写入时覆盖（重压安全）。
 * 不删除旧摘要：它们保留在表里，作为「当时怎么概括的」审计记录。
 */
export function addSummary(sessionId, { branchId = 'main', coversTurnTo, text, prevId = null, tokenCount = null }) {
  const covers = Number(coversTurnTo);
  if (!Number.isFinite(covers) || covers < 1) throw new Error('summary coversTurnTo must be >= 1');
  const body = String(text || '').trim();
  if (!body) throw new Error('summary text is empty');
  const tokens = tokenCount ?? estimateTokens(body);
  const d = getDb();
  d.prepare(`
    INSERT INTO summaries (session_id, branch_id, covers_turn_to, text, prev_id, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, branch_id, covers_turn_to) DO UPDATE SET
      text=excluded.text, prev_id=excluded.prev_id, token_count=excluded.token_count, created_at=excluded.created_at
  `).run(sessionId, branchId, covers, body, prevId ?? null, tokens, Date.now());
  const row = d.prepare(`SELECT * FROM summaries WHERE session_id=? AND branch_id=? AND covers_turn_to=?`)
    .get(sessionId, branchId, covers);
  return row ? decorateSummary(row) : null;
}

function decorateSummary(row) {
  return {
    id: row.id,
    session_id: row.session_id,
    branch_id: row.branch_id,
    covers_turn_to: row.covers_turn_to,
    text: row.text,
    prev_id: row.prev_id,
    token_count: row.token_count,
    created_at: row.created_at,
  };
}

/**
 * 某一轮生效的摘要 = 覆盖边界不超过该轮的最新一份。
 * atTurn 省略时取最新（UI 查看用）；装配必须传当前回合。
 */
export function getActiveSummary(sessionId, { branchId = 'main', atTurn = null } = {}) {
  const limit = Number.isInteger(atTurn) ? atTurn : Number.MAX_SAFE_INTEGER;
  const row = getDb().prepare(`
    SELECT * FROM summaries
    WHERE session_id=? AND branch_id=? AND covers_turn_to<=?
    ORDER BY covers_turn_to DESC, id DESC LIMIT 1
  `).get(sessionId, branchId, limit);
  return row ? decorateSummary(row) : null;
}

/** 摘要历史（记忆面板/调试用）。 */
export function getSummaries(sessionId, { branchId = 'main', limit = 20 } = {}) {
  return getDb().prepare(`
    SELECT * FROM summaries WHERE session_id=? AND branch_id=?
    ORDER BY covers_turn_to DESC, id DESC LIMIT ?
  `).all(sessionId, branchId, limit).map(decorateSummary);
}

/**
 * 当前分支 → 祖先链，每条边带上「祖先可继承到哪一轮」的上限。
 *
 * 上限来自**子分支**的 fork_turn：b3 从 b2 的第 13 轮分叉，那么 b3 能看见
 * b2 的 ≤13 轮；b2 从 main 的第 8 轮分叉，那么 b2 能看见 main 的 ≤8 轮。
 * 只看全局 turn_no 会把兄弟分支的回合也带进来（嵌套分叉串线）。
 */
function branchChain(sessionId, branchId) {
  const rows = getDb().prepare(
    `SELECT branch_id, parent_branch, fork_turn FROM branches WHERE session_id=?`,
  ).all(sessionId);
  if (!rows.length) return null;
  const byId = new Map(rows.map((r) => [r.branch_id, r]));
  if (!byId.has(branchId)) return null;

  const chain = [];
  const seen = new Set();
  let cur = byId.get(branchId);
  let limit = null; // 当前分支没有上限
  while (cur && !seen.has(cur.branch_id) && chain.length < 64) {
    seen.add(cur.branch_id);
    chain.push({ branch_id: cur.branch_id, limit });
    limit = Number(cur.fork_turn) || 0;
    cur = cur.parent_branch ? byId.get(cur.parent_branch) : null;
  }
  return chain;
}

export function getTurnsForBranch(sessionId, branchId, forkTurn, { from = 0, to = Number.MAX_SAFE_INTEGER, kinds = null } = {}) {
  const chain = branchChain(sessionId, branchId);
  let sql = `SELECT * FROM turns WHERE session_id=? AND turn_no BETWEEN ? AND ?`;
  const params = [sessionId, from, to];
  const limits = chain ? new Map(chain.map((c) => [c.branch_id, c.limit])) : null;

  if (limits) {
    const ids = [...limits.keys()];
    sql += ` AND branch_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else {
    // 兼容没有分支记录的旧会话/纯回合测试：退回「自己的 + 编号不大于分叉点」。
    sql += ` AND (branch_id=? OR turn_no<=?)`;
    params.push(branchId, forkTurn);
  }
  if (kinds?.length) { sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`; params.push(...kinds); }
  sql += ` ORDER BY turn_no ASC, id ASC`;

  const rows = getDb().prepare(sql).all(...params);
  if (!limits) return rows.map(decorateTurn);
  return rows
    .filter((r) => {
      const lim = limits.get(r.branch_id);
      return lim == null || r.turn_no <= lim;
    })
    .map(decorateTurn);
}

/**
 * 分支内最近 n 个**回合**的原文（含继承部分），按时间正序。
 * 一个回合 = 一条 player + 一条 narrator。
 * 注意：跨分支继承时回合编号可能不连续（b2 从第 2 轮分叉，接着写第 4 轮），
 * 所以按「实际出现的回合序号」取后 n 个，而不是按编号区间。
 */
export function getRecentTurnsForBranch(sessionId, branchId, forkTurn, turns = 1) {
  const rows = getTurnsForBranch(sessionId, branchId, forkTurn, { kinds: ['player', 'narrator'] });
  if (!rows.length) return [];
  const turnNos = [...new Set(rows.map((r) => r.turn_no))].sort((a, b) => a - b);
  const keep = new Set(turnNos.slice(Math.max(0, turnNos.length - Math.max(1, turns))));
  return rows.filter((r) => keep.has(r.turn_no));
}

/** 分支可见的原文纯文本（实体链接用）。 */
export function getRecentTextForBranch(sessionId, branchId, forkTurn, turnsBack = 8) {
  const rows = getTurnsForBranch(sessionId, branchId, forkTurn, { kinds: ['player', 'narrator'] });
  const max = rows.length ? rows[rows.length - 1].turn_no : 0;
  const from = Math.max(1, max - turnsBack + 1);
  return rows.filter((r) => r.turn_no >= from).map((r) => r.content || '').join('\n');
}

/**
 * 在回合原文里做子串检索。中文没有词边界，LIKE 子串比分词更可靠。
 * @returns {Array<{turn_no, kind, snippet}>}
 */
export function searchTurns(sessionId, query, { branchId = null, limit = 8, kinds = ['player', 'narrator'] } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  let sql = `SELECT turn_no, kind, content, token_count FROM turns
             WHERE session_id=? AND kind IN (${kinds.map(() => '?').join(',')}) AND content LIKE ? ESCAPE '\\'`;
  const params = [sessionId, ...kinds, like];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  sql += ` ORDER BY turn_no DESC, id DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params).map((r) => ({
    turn_no: r.turn_no,
    kind: r.kind,
    snippet: truncate(r.content, 400),
    token_count: r.token_count,
  }));
}

/** 在断言里按主/谓/对象文本检索。 */
export function searchAssertions(sessionId, query, { branchId = null, limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  let sql = `SELECT * FROM assertions WHERE session_id=? AND status='active'
             AND (subject LIKE ? ESCAPE '\\' OR predicate LIKE ? ESCAPE '\\' OR object LIKE ? ESCAPE '\\')`;
  const params = [sessionId, like, like, like];
  if (branchId) { sql += ` AND branch_id=?`; params.push(branchId); }
  sql += ` ORDER BY valid_from DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params);
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}
