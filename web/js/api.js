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

/** 构造一个携带 status 的 Error */
async function makeError(res) {
  let message = `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      if (data && data.error && data.error.message) message = data.error.message;
      else if (data && typeof data.message === 'string') message = data.message;
    }
  } catch { /* 非 JSON 响应，保留默认消息 */ }
  const err = new Error(message);
  err.status = res.status;
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
      throw new Error(evt.message || '服务端返回错误事件');
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
  /** GET /api/config -> {models, defaults, context_limits} */
  getConfig(signal) {
    return request('/api/config', { signal });
  },

  /** GET /api/sessions -> [{id,title,turn_count,updated_at,settings:{title,style_tags}}] */
  listSessions(signal) {
    return request('/api/sessions', { signal });
  },

  /** POST /api/sessions  body:{title, settings} -> session */
  createSession(body, signal) {
    return request('/api/sessions', { method: 'POST', body, signal });
  },

  /** GET /api/sessions/:id -> {session, turns, state, memoryStats} */
  getSession(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}`, { signal });
  },

  /** PATCH /api/sessions/:id  body:{title?, settings?} -> session */
  patchSession(id, body, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body, signal });
  },

  /** DELETE /api/sessions/:id */
  deleteSession(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
  },

  /** GET /api/sessions/:id/memory -> {stats, tiers, entities, state} */
  getMemory(id, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/memory`, { signal });
  },

  /** POST /api/sessions/:id/branches -> {branches, scene_summary}（非流式） */
  generateBranches(id, body = {}, signal) {
    return request(`/api/sessions/${encodeURIComponent(id)}/branches`, { method: 'POST', body, signal });
  },

  /** POST /api/sessions/:id/opening -> SSE（生成/重扩开场白） */
  generateOpening(id, handlers = {}) {
    return runStream(`/api/sessions/${encodeURIComponent(id)}/opening`, {}, handlers);
  },

  /**
   * POST /api/sessions/:id/turn -> SSE（orchestrator 事件协议）
   * @param {string} sessionId
   * @param {object} body {playerText, images?, branchChoice?, generateBranches?}
   * @param {object} [handlers] {onEvent, signal}
   * @returns {Promise<object>} 最终 done 事件
   */
  runTurn(sessionId, body, handlers = {}) {
    return runStream(`/api/sessions/${encodeURIComponent(sessionId)}/turn`, body, handlers);
  },
};

// 供调试：在控制台可访问
if (typeof window !== 'undefined') window.__api = api;
