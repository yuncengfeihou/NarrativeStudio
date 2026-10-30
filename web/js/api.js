/**
 * api.js — API 客户端
 *
 * 覆盖 docs/CONTRACTS.md 「原生 HTTP API」全部端点。
 * SSE 说明：POST 无法使用 EventSource，因此用 fetch + ReadableStream 手动解析。
 *   - 帧格式：`data: {json}\n\n`，事件类型在 JSON 的 `type` 字段
 *   - 解析器对 UTF-8 多字节字符、跨 chunk 的数据行均做了健壮处理
 * 错误约定：非 2xx 响应解析 `{error:{message}}` 并抛出 Error(message)。
 */

const BASE = ''; // 同源相对路径，由后端 express 静态托管

// ============================================================
// 健壮 SSE 解码器
// ============================================================

/**
 * 把字节流解析为 SSE 事件对象数组。
 *
 * 健壮性要点：
 *  1) TextDecoder 使用 stream 模式，正确处理跨 chunk 的 UTF-8 多字节字符（中文）
 *  2) 内部维护字符串 buffer，未组成完整行的数据留待下一个 chunk 拼接
 *  3) 兼容 \n / \r\n / \r 行尾；空行视为事件边界
 *  4) 多个 data: 行按 SSE 规范用 \n 连接后再 JSON.parse
 *  5) feed() 每喂入一个 Uint8Array chunk，返回该 chunk 产生的完整事件数组
 */
class SSEDecoder {
  constructor() {
    this.decoder = new TextDecoder('utf-8');
    this.buffer = '';
    this.dataLines = [];
    this.seenFirst = false;
  }

  /** 喂入一个二进制 chunk，返回解析出的完整事件对象数组 */
  feed(chunk) {
    // stream:true —— 跨 chunk 的多字节字符由解码器内部缓存补齐
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const events = [];
    let nl;
    // 逐行提取：只有遇到 \n 才认为一行完整，剩余部分留在 buffer
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1); // \r\n 归一化
      const evt = this._handleLine(line);
      if (evt !== null) events.push(evt);
    }
    return events;
  }

  /** 流结束时调用：冲刷解码器尾部，并派发可能残留的未终止事件 */
  end() {
    const events = [];
    // 冲刷 TextDecoder 内部可能缓存的字节
    const tail = this.decoder.decode();
    if (tail) this.buffer += tail;
    // 若 buffer 还有未换行的内容，补一个换行当作最后一行
    if (this.buffer.length) {
      let line = this.buffer;
      this.buffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const evt = this._handleLine(line);
      if (evt !== null) events.push(evt);
    }
    // 派发残留事件（容错：正常情况下 done 事件已被 \n\n 终止）
    const evt = this._dispatch();
    if (evt !== null) events.push(evt);
    return events;
  }

  /** 处理单行；返回事件对象或 null */
  _handleLine(line) {
    if (line === '') {
      // 空行 = 事件边界
      return this._dispatch();
    }
    if (line.startsWith(':')) return null; // 注释 / 心跳行
    const colon = line.indexOf(':');
    let field;
    let value;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1); // 规范：去掉单个前导空格
    }
    // 本协议只关心 data 字段；event/id/retry 忽略（type 在 JSON 内）
    if (field === 'data') this.dataLines.push(value);
    return null;
  }

  /** 把累积的 data 行组装成事件对象 */
  _dispatch() {
    if (this.dataLines.length === 0) return null;
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch (err) {
      // 数据行不完整或非法：包装成 error 事件，避免整个流崩断
      return { type: 'error', message: `SSE 数据解析失败: ${err.message}`, _raw: data };
    }
  }
}

// ============================================================
// 底层请求封装
// ============================================================

/** 构造一个携带 status 的 Error；服务端 422 的阻断项挂在 err.issues 上供表单展示 */
async function makeError(res) {
  let message = `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
  let issues = null;
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      if (data && data.error && data.error.message) message = data.error.message;
      else if (data && typeof data.message === 'string') message = data.message;
      if (data && data.error && Array.isArray(data.error.issues)) issues = data.error.issues;
    }
  } catch { /* 非 JSON 响应，保留默认消息 */ }
  const err = new Error(message);
  err.status = res.status;
  if (issues) err.issues = issues;
  return err;
}

/** 普通 JSON 请求 */
async function request(path, { method = 'GET', body, signal } = {}) {
  const opts = { method, headers: {}, signal };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) throw await makeError(res);
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

/**
 * 通用 SSE 流执行器（fetch + ReadableStream）。
 *
 * @param {string} path  请求路径（POST）
 * @param {object} body  请求体
 * @param {object} [handlers]
 * @param {(evt:object)=>void} [handlers.onEvent] 每个事件回调
 * @param {AbortSignal} [handlers.signal]  取消信号
 * @returns {Promise<object|null>} 解析到最终 done 事件（若无则返回最后一个事件）
 */
async function runStream(path, body, handlers = {}) {
  const { onEvent, signal } = handlers;
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body || {}),
    signal,
  });
  if (!res.ok) throw await makeError(res);
  if (!res.body) throw new Error('当前浏览器不支持流式响应（ReadableStream 缺失）');

  const decoder = new SSEDecoder();
  const reader = res.body.getReader();
  let final = null;

  const handle = (evt) => {
    if (!evt) return;
    if (evt.type === 'error') {
      // 把原始事件挂在错误上：`not_persisted` / `empty_narration` / `retryable` 这几个
      // 字段决定调用方能不能把这一拍安全地重发（服务器没落库 vs 落了半拍）。
      // 只留一句 message 的话，界面层只能一律当「失败」，无法区分。
      const fail = new Error(evt.message || '服务端返回错误事件');
      fail.evt = evt;
      throw fail;
    }
    if (evt.type === 'done') final = evt;
    else if (final == null || final.type !== 'done') final = evt;
    if (typeof onEvent === 'function') onEvent(evt);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const evt of decoder.feed(value)) handle(evt);
    }
    for (const evt of decoder.end()) handle(evt);
  } finally {
    try { reader.releaseLock(); } catch { /* 已取消时忽略 */ }
  }
  return final;
}

// ============================================================
// 公开 API
// ============================================================

export const api = {
  /** GET /api/config */
  getConfig(signal) {
    return request('/api/config', { signal });
  },

  /**
   * PUT /api/config -> { ok, runtime }
   * 体：{ providers, models, agents }；apiKey 省略或 '***' 表示保留已保存的密钥，'' 表示清除。
   */
  saveConfig(body, signal) {
    return request('/api/config', { method: 'PUT', body, signal });
  },

  /** DELETE /api/config -> { ok, runtime }（删除运行期配置，回到 .env 默认） */
  resetConfig(signal) {
    return request('/api/config', { method: 'DELETE', signal });
  },

  /** GET /api/fonts -> { fonts: string[], source }（服务端本机字体，浏览器 API 的兜底） */
  getFonts(signal) {
    return request('/api/fonts', { signal });
  },

  /* ---------------- 演绎工艺（取值表本身，可增删改） ---------------- */

  /** GET /api/craft -> { craft, catalog }（craft 带每条正文，编辑器用） */
  getCraft(signal) {
    return request('/api/craft', { signal });
  },

  /** PUT /api/craft  body:{preset:{default,options[]},dialogue:…,pacing:…}；空体 = 恢复内置 */
  saveCraft(body, signal) {
    return request('/api/craft', { method: 'PUT', body, signal });
  },

  /** DELETE /api/craft -> 回到内置表 */
  resetCraft(signal) {
    return request('/api/craft', { method: 'DELETE', signal });
  },

  /* ---------------- 世界卡 ---------------- */

  /** GET /api/worlds -> [{id,title,subtitle,cover_hue,tags,card,session_count}] */
  listWorlds(signal) {
    return request('/api/worlds', { signal });
  },

  /** GET /api/worlds/:id -> {…world, codex, sessions} */
  getWorld(id, signal) {
    return request(`/api/worlds/${encodeURIComponent(id)}`, { signal });
  },

  /** GET /api/worlds/:id/lint -> {issues, counts}（只读内容体检，blocker 会拦保存） */
  getWorldLint(id, signal) {
    return request(`/api/worlds/${encodeURIComponent(id)}/lint`, { signal });
  },

  /** POST /api/worlds  body:{id?, title?, card, tags?, cover_hue?} */
  saveWorld(body, signal) {
    return request('/api/worlds', { method: 'POST', body, signal });
  },

  /** PATCH /api/worlds/:id */
  patchWorld(id, body, signal) {
    return request(`/api/worlds/${encodeURIComponent(id)}`, { method: 'PATCH', body, signal });
  },

  deleteWorld(id, signal) {
    return request(`/api/worlds/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
  },

  /** POST /api/worlds/:id/sessions -> session（开一局，可带 anchor_id） */
  createWorldSession(worldId, body = {}, signal) {
    return request(`/api/worlds/${encodeURIComponent(worldId)}/sessions`, { method: 'POST', body, signal });
  },

  /** GET /api/worlds/:id/export -> 纯文本卡 */
  exportWorld(id, signal) {
    return fetch(`/api/worlds/${encodeURIComponent(id)}/export`, { signal }).then((r) => r.text());
  },

  /** POST /api/worlds/:id/entities/:entityId/pin  body:{pinned}（v5：person 与事实实体共用一套钉选） */
  setEntityPinned(worldId, entityId, pinned, signal) {
    return request(`/api/worlds/${encodeURIComponent(worldId)}/entities/${encodeURIComponent(entityId)}/pin`,
      { method: 'POST', body: { pinned }, signal });
  },

  /* ---------------- 制卡 ---------------- */

  /** GET /api/smith/materials -> [{name,chapters,chars,first,last}] */
  listMaterials(signal) {
    return request('/api/smith/materials', { signal });
  },

  /** POST /api/smith/preview（SSE）body:{dir,title,premise,max_chapters,…} */
  previewSmith(body, handlers = {}) {
    return runStream('/api/smith/preview', body, handlers);
  },

  /** POST /api/smith/save  body:{id?,card,tags?,source?} */
  saveSmith(body, signal) {
    return request('/api/smith/save', { method: 'POST', body, signal });
  },

  /* ---------------- 剧情会话 ---------------- */

  /** GET /api/sessions?world_id= -> [{id,title,turn_count,updated_at}] */
  listSessions({ world_id = null } = {}, signal) {
    const qs = world_id ? `?world_id=${encodeURIComponent(world_id)}` : '';
    return request(`/api/sessions${qs}`, { signal });
  },

  createSession(body, signal) {
    return request('/api/sessions', { method: 'POST', body, signal });
  },

  /** GET /api/sessions/:id -> {session, card, world, turns, state, playerView, usage, memoryStats}
   *  state 是完整账本（导出/排查用）；展示层只读 playerView。 */
  getSession(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}`, { signal });
  },

  patchSession(id, body, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body, signal });
  },

  deleteSession(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
  },

  getMemory(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/memory`, { signal });
  },

  /** 本局世界线的运行期变化（不是世界卡模板） */
  getWorldState(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/world-state`, { signal });
  },

  /** 把当前世界线存为一张新世界卡（显式操作） */
  canonizeSession(id, body = {}, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/canonize`, { method: 'POST', body, signal });
  },

  /* ---------------- 分页 / 检索 ---------------- */

  getTurns(id, { from = 1, to = '' } = {}, signal) {
    const qs = new URLSearchParams({ from: String(from), limit: '400' });
    if (to !== '' && to != null) qs.set('to', String(to));
    return request(`/api/sessions/${encodeURIComponent(id)}/turns?${qs}`, { signal });
  },

  searchSession(id, q, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}`, { signal });
  },

  /* ---------------- 记忆六表（v4） ---------------- */

  getNotes(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/notes`, { signal });
  },
  addNote(id, body, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/notes`, { method: 'POST', body, signal });
  },
  updateNote(id, noteId, body, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/notes/${noteId}`, { method: 'PATCH', body, signal });
  },
  deleteNote(id, noteId, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/notes/${noteId}`, { method: 'DELETE', signal });
  },
  getAssertions(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/assertions`, { signal });
  },
  addAssertion(id, body, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/assertions`, { method: 'POST', body, signal });
  },
  retractAssertion(id, assertionId, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/assertions/${assertionId}`, { method: 'DELETE', signal });
  },
  getStates(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/states`, { signal });
  },
  putState(id, body, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/state`, { method: 'PUT', body, signal });
  },
  getScenes(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/scenes`, { signal });
  },
  getThreads(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/threads`, { signal });
  },
  getVoices(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/voices`, { signal });
  },
  pinVoice(id, voiceId, pinned, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/voices/${voiceId}/pin`, { method: 'POST', body: { pinned }, signal });
  },
  deleteVoice(id, voiceId, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/voices/${voiceId}`, { method: 'DELETE', signal });
  },
  /** params: { status?, kind?, limit? }；响应同时给 total / counts（按 kind 分组）。 */
  getPatches(id, params = {}, signal) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.kind) qs.set('kind', params.kind);
    if (params.limit) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return request(`/api/sessions/${encodeURIComponent(id)}/patches${q ? `?${q}` : ''}`, { signal });
  },
  resolvePatch(id, patchId, status, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/patches/${patchId}/resolve`,
      { method: 'POST', body: { status }, signal });
  },
  /**
   * 真正执行一条提案（目前只有 `alias` 的确定性别名合并）。
   *
   * 与 `resolvePatch` 的区别是「有没有动世界」：那条只改状态，对实体零效果，
   * 点了接受之后别名冲突照旧存在。这条走 `patch-apply.js` 的确定性动作，
   * 400 时 `message` 就是拒绝原因（`both_in_card` / `neither_in_card` / `need_two_names`）。
   */
  applyPatch(id, patchId, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/patches/${patchId}/apply`,
      { method: 'POST', body: {}, signal });
  },

  /* ---------------- 分支 / 一致性检查 / 回忆 ---------------- */

  getBranches(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/branches`, { signal });
  },
  /** POST /api/sessions/:id/checkout body:{branch_id} -> 切到另一条已有世界线（不新建分支） */
  checkoutBranch(id, branchId, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/checkout`, {
      method: 'POST', body: { branch_id: branchId }, signal,
    });
  },
  /** POST /api/sessions/:id/audit -> 立即跑一次一致性检查 */
  audit(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/audit`, { method: 'POST', signal });
  },
  /** POST /api/sessions/:id/recall  body:{question} -> 检索 Agent 的结论 */
  recall(id, question, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/recall`, { method: 'POST', body: { question }, signal });
  },


  /* ---------------- 剧情编辑 ---------------- */

  updateTurn(id, turnNo, body, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/turns/${turnNo}`, { method: 'PATCH', body, signal });
  },

  rollback(id, turnNo, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/rollback`, { method: 'POST', body: { turn_no: turnNo }, signal });
  },

  /** POST /api/sessions/:id/rewrite -> SSE（先回滚再重跑该轮） */
  rewrite(id, body = {}, handlers = {}) {
    return runStream(`/api/sessions/${encodeURIComponent(id)}/rewrite`, body, handlers);
  },

  /* ---------------- 预设种子 ---------------- */

  listPresets(signal) {
    return request('/api/presets', { signal });
  },
  getPreset(id, signal) {
    return request(`/api/presets/${encodeURIComponent(id)}`, { signal });
  },
  importPreset(id, signal) {
    return request(`/api/presets/${encodeURIComponent(id)}/import`, { method: 'POST', signal });
  },

  /** POST /api/sessions/:id/branches -> {branches, scene_summary} */
  generateBranches(id, body = {}, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/branches`, { method: 'POST', body, signal });
  },

  /** POST /api/sessions/:id/opening -> SSE */
  generateOpening(id, handlers = {}) {
    return runStream(`/api/sessions/${encodeURIComponent(id)}/opening`, {}, handlers);
  },

  runTurn(sessionId, body, handlers = {}) {
    return runStream(`/api/sessions/${encodeURIComponent(sessionId)}/turn`, body, handlers);
  },
};

// 供调试：在控制台可访问
if (typeof window !== 'undefined') window.__api = api;
