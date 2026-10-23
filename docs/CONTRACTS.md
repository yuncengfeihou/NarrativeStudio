# AI Roleplay Studio — 模块契约 (Contracts)

所有并行开发必须严格遵循本文件。任何偏离先改契约再改代码。

## 目录结构

```
ai-roleplay/
├── package.json
├── server/
│   ├── index.js            # 入口（主控）
│   ├── config.js           # 配置（已建）
│   ├── tokens.js           # token 估算（已建）
│   ├── llm.js              # StepFun 客户端（已建）
│   ├── agents/             # Agent 实现
│   │   ├── orchestrator.js # 回合管线（主控）
│   │   ├── narrator.js     # 剧情演绎 Agent
│   │   ├── branch.js       # 剧情分支 Agent
│   │   └── memory-agent.js # 记忆 Agent
│   ├── memory/
│   │   ├── store.js        # SQLite CRUD（已建）
│   │   ├── compressor.js   # 层级压缩调度
│   │   ├── retriever.js    # BM25 检索
│   │   └── assembler.js    # 上下文装配 + 预算
│   ├── routes/
│   │   ├── openai.js       # /v1/chat/completions, /v1/models
│   │   ├── sessions.js     # /api/sessions...
│   │   └── static.js       # web 静态资源
│   └── prompts/
│       ├── narrator.js
│       ├── branch.js
│       └── memory.js
├── web/                    # 前端（原生 ES modules，无构建）
│   ├── index.html
│   ├── styles/{ios.css, app.css}
│   └── js/{app.js, api.js, chat.js, setup.js, memory-panel.js, store.js, util.js}
├── tests/
└── data/                   # SQLite（运行时生成）
```

## LLM 客户端接口 (server/llm.js, 已建)

```js
import { chat, chatStream, LlmError } from './llm.js';

// 非流式
const { content, reasoning, usage, finishReason } = await chat({
  messages, temperature, maxTokens, reasoningEffort: 'low'|'medium'|'high', signal
});

// 流式：异步生成器
for await (const ev of chatStream({ messages, reasoningEffort, signal })) {
  // ev = {type:'reasoning'|'content'|'meta', delta, usage?, model?, finishReason?}
}
```

## 记忆存储接口 (server/memory/store.js)

```js
createSession({id, title, settings}) -> session
getSession(id) -> {id,title,settings,turn_count,...} | null
listSessions(), updateSession(id,{title,settings,status}), deleteSession(id)
addTurn(sessionId, {turn_no, kind:'player'|'narrator'|'system', content, images?, reasoning?, branch_choice?, meta?, token_count?})
getTurns(sessionId,{from,to,kinds}), getRecentTurns(sessionId,n), getMaxTurnNo(sessionId)
getTurn(sessionId, turnNo, kind) -> turn | null
updateTurnContent(sessionId, turnNo, kind, content) -> bool      // 置 edited=1
truncateSession(sessionId, turnNo) -> {turns,summaries,states,facts}  // 回滚（含级联清理）
addSummary(sessionId,{level,turnFrom,turnTo,content}), getSummaries(sessionId,{level,archived,limit}),
getLatestSummaries(sessionId,level,n), archiveSummaries(ids), countSummaries(sessionId,level)
upsertEntity(sessionId,{type,name,summary,attributes,first_turn,last_turn,importance})
getEntities(sessionId,{types,limit})      // 排序：pinned DESC, importance DESC, last_turn DESC
setEntityPinned(sessionId, entityId, pinned), updateEntity(sessionId, entityId, patch), deleteEntity(sessionId, entityId)
addFact(sessionId,{subject,predicate,object,turn_no,confidence}), getFacts(sessionId,{limit,subject,includeRetracted})
addManualFact(sessionId,{subject,predicate,object,turn_no,confidence})
setFactPinned(sessionId, factId, pinned), deleteFact(sessionId, factId, {hard})
setState(sessionId,turnNo,state), getState(sessionId) -> {turn_no, state} | null
// 作者笔记（确定性记忆，永不压缩）
addNote(sessionId,{content,kind:'note'|'rule'|'foreshadow'|'retcon',turn_no}), getNotes(sessionId,{activeOnly,kind}),
updateNote(sessionId, noteId, {content,kind,active}), deleteNote(sessionId, noteId)
touchSession(id, turnCount), closeDb()
```

### 数据 Schema 增量（v2）

```sql
-- notes：作者手写记忆
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',      -- note | rule | foreshadow | retcon
  turn_no INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 迁移新增列（migrate() 幂等补齐）
entities.pinned        INTEGER NOT NULL DEFAULT 0
facts.pinned           INTEGER NOT NULL DEFAULT 0
facts.status           TEXT NOT NULL DEFAULT 'active'   -- active | retracted
turns.edited           INTEGER NOT NULL DEFAULT 0
turns.branch_taken     TEXT
```

## 数据 Schema

### settings（会话设定）
```json
{
  "title": "剧情标题",
  "opening": "开场白（第一轮 narrator 内容的种子，200-800字）",
  "worldview": "世界观设定",
  "characters": [
    {"name":"林霜","role":"女主角/追踪者","personality":"冷静、敏锐、外冷内热","voice":"台词简短，句号收尾，少用感叹","secret":"不为人知的动机","avatar_hue": 210}
  ],
  "player_role": "玩家身份设定",
  "rules": "扮演规则（禁止OOC、保持角色口吻、每轮1500-3000字等）",
  "style_tags": ["悬疑","都市异能"],
  "narrator_effort": "high",
  "context_max_tokens": 200000
}
```

### state（剧情状态快照）
```json
{
  "time": "第三日·黄昏",
  "location": "临江旧港区",
  "weather": "暴雨",
  "tension": 0.72,
  "characters": {"林霜": {"mood":"警惕","location":"码头B仓","status":"受伤"}},
  "inventory": ["生锈的钥匙", "半张船票"],
  "quests": [{"goal":"查明失踪案","progress":"发现第二个证人","status":"active"}],
  "threads": ["神秘组织'灰鸽'的线索", "林霜的旧伤"],
  "last_hook": "仓库深处传来铁链拖地声"
}
```

### branch option
```json
{"id":"b1","title":"短标题≤12字","description":"选择后剧情走向的描述（50-120字）","tone":"激进|谨慎|探索|情感|智取","tension_delta":0.15}
```

### branch set
```json
{"branches":[ ...3-4个... ], "scene_summary":"当前局势一句话"}
```

### memory update（记忆 Agent 每轮产出）
```json
{
  "round_summary": "本轮高密度摘要（300-500 tok）：关键事件、决定、状态变化、新实体、值得引用的原话、悬念钩子",
  "entities": [{"type":"character|item|location|faction|event|concept","name":"","summary":"最新 consolidated 描述","attributes":{},"importance":0.8}],
  "facts": [{"subject":"","predicate":"拥有|敌对|位于|受伤|知晓|目标","object":"","confidence":0.9}],
  "state_delta": {"time":"","location":"","tension":0.7,"characters":{},"inventory_add":[],"inventory_remove":[],"quests_update":[],"threads_add":[],"threads_resolve":[],"last_hook":""}
}
```

## Agent 接口

### agents/narrator.js
```js
export async function runNarrator({ session, context, onDelta }) 
// context 来自 assembler.assembleContext() 的产物
// onDelta({type:'reasoning'|'content', delta})
// 返回 {content, reasoning, usage, model, finishReason}
// 首轮（无历史回合）时基于 settings.opening 扩写开场
```

### agents/branch.js
```js
export async function runBranchAgent({ session, context, recentNarrative })
// 返回 {branches: [...3-4], scene_summary}   （解析失败时 fallback 到 3 个通用选项）
```

### agents/memory-agent.js
```js
export async function updateMemory({ session, turnNo, playerText, narrative, branchChoice })
// 1) 生成 round_summary 并存 L1 summary
// 2) upsert entities / add facts
// 3) setState(turnNo, mergedState)   ← 读旧 state，合并 state_delta
// 4) 调用 compressor.checkCompression(sessionId, turnNo) 做层级压缩
// 返回 {round_summary, entities: n, facts: n, compressed: [...]}
```

## 压缩器接口 (memory/compressor.js)
```js
export async function checkCompression(sessionId, turnNo)
// 每 ARC_EVERY 轮：把最近 ARC_EVERY 条 L1 摘要压缩成 1 条 L2，archive 掉那些 L1
// 每 SAGA_EVERY 条 L2 → 1 条 L3；每 CHRONICLE_EVERY 条 L3 → 1 条 L4
// 幂等：同一 turnNo 重复调用不产生重复摘要
// 返回 {created: [{level, turn_from, turn_to}], archived: n}
```

## 检索器接口 (memory/retriever.js)
```js
export class MemoryRetriever {
  constructor(sessionId)
  invalidate()                       // 有新数据后调用
  search(query, {topK})              // -> [{kind:'turn'|'summary'|'entity', ref, score, snippet}]
}
// BM25 + CJK bigram；实体名命中加权；近期加权
```

## 装配器接口 (memory/assembler.js)
```js
export async function assembleContext({ session, turnNo, playerText, images, branchChoice })
// 返回 {
//   messages: [...],            // 完整可发送的 messages（system + bible + notes + state + 记忆层 + recent + current）
//   budget: {system, bible, notes, state, summaries, entities, retrieval, recent, current, total},
//   retriever, state, recentTurns, retrievalSnippets
// }
// 硬约束：budget.total ≤ settings.context_max_tokens（默认200K）
// 装配优先级（超预算时从低到高丢弃）：retrieval > 旧summaries > entities > recent(保留至少2轮) > state > notes > bible
//
// 角色约定（重要）：只有 system 人设与 bible 使用 role:'system'，且必须位于开头；
//   notes/state/summaries/entities/retrieval 全部使用 role:'user'。
//   把额外的 system 消息插进对话中段会让上游把正文写进 reasoning、content 为空。
```

## Orchestrator 接口 (agents/orchestrator.js)

```js
export async function runTurn({ sessionId, playerText, images, branchChoice, generateBranches, options, onEvent, signal })
// onEvent 事件协议（原生 API / SSE）：
//   {type:'turn_start', turn_no}
//   {type:'reasoning', delta}
//   {type:'narrative', delta}
//   {type:'narrative_done', content, token_count, finish_reason}
//   {type:'branches', branches:[...], scene_summary}
//   {type:'memory', stats:{...}}          // 记忆更新后
//   {type:'state', state:{...}}
//   {type:'done', turn_no, usage:{...}}
//   {type:'error', message}
// 返回 {turn_no, narrative, reasoning, branches, usage, memoryStats}
// 会话级串行锁：同一 session 同时只允许一个 runTurn

export async function getSessionSnapshot(sessionId)  // 前端初始化用
```

## 原生 HTTP API (routes/sessions.js + routes/presets.js)

```
GET    /api/config                      -> {models, defaults, context_limits}
GET    /api/sessions                    -> [{id,title,turn_count,updated_at,settings:{title,style_tags}}]
POST   /api/sessions                    body:{title, settings} -> session
GET    /api/sessions/:id                -> {session, turns, state, memoryStats}
PATCH  /api/sessions/:id                body:{title?, settings?} -> session
DELETE /api/sessions/:id
POST   /api/sessions/:id/turn           body:{playerText, images?, branchChoice?, generateBranches?}
                                           -> SSE 流（orchestrator 事件协议，data: {json}）
POST   /api/sessions/:id/branches       -> {branches, scene_summary}（非流式 JSON）
GET    /api/sessions/:id/memory         -> {stats, tiers, archived_tiers, entities, facts, notes, state, compression}
GET    /api/sessions/:id/turns          ?from=&to=&kinds=&limit= -> {turns, total, from, to}
GET    /api/sessions/:id/search         ?q= -> {hits:[{turn_no,kind,created_at,before,match,after}], query}
POST   /api/sessions/:id/opening        -> SSE 流（生成/重扩开场白，事件同 narrator）

# 记忆编辑
GET    /api/sessions/:id/notes              -> {notes}
POST   /api/sessions/:id/notes              body:{content, kind?} -> {id, notes}
PATCH  /api/sessions/:id/notes/:noteId      body:{content?, kind?, active?} -> {notes}
DELETE /api/sessions/:id/notes/:noteId      -> {notes}
PATCH  /api/sessions/:id/entities/:entityId body:{pinned?, name?, summary?, importance?} -> {entities}
DELETE /api/sessions/:id/entities/:entityId -> {entities}
POST   /api/sessions/:id/facts              body:{subject,predicate,object} -> {id, facts}
PATCH  /api/sessions/:id/facts/:factId      body:{pinned?} -> {facts}
DELETE /api/sessions/:id/facts/:factId      ?hard=1 -> {facts}   （默认软删 = retracted）
PUT    /api/sessions/:id/state              body:{state, turn_no?} -> {state, turn_no}

# 剧情编辑
PATCH  /api/sessions/:id/turns/:turnNo      body:{kind:'player'|'narrator', content, rememorize?}
                                               -> {turn, rememorized}
POST   /api/sessions/:id/rollback           body:{turn_no} -> {turns,summaries,states,facts,turn_no,memoryStats}
POST   /api/sessions/:id/rewrite            body:{turn_no, guidance?, generateBranches?}
                                               -> SSE（先发 rollback 事件，再走 turn 协议）

# 剧本预设
GET    /api/presets                     -> [{id,title,subtitle,tags,characters,accent_hue,source,...}]
GET    /api/presets/:id                 -> {id, title, settings, ...}
POST   /api/presets                     body:{id, settings, title?, ...} -> {id}
```

memoryStats: `{turn_count, total_tokens, context_tokens, context_max, budget:{settings,notes,state,summaries,retrieval,recent_raw,entities,facts}, tiers:[{level,count,tokens,last}], archived_tiers:[{level,count}], archive_tokens, raw_tokens, compression, entities, facts, notes, state, state_turn, last_retrieval}`

### SSE 事件协议（扩展）

除原有的 `turn_start / reasoning / narrative / narrative_done / memory / state / branches / done / error` 外，
新增：

- `rollback`（仅 `/rewrite`）：`{turn_no, removed}` — 重写前已回滚到的位置
- `narrative_reset`：`{reason}` — 上游只返回 reasoning 而 content 为空时，
  orchestrator 会清空半成品并重试一次（关闭推理、追加「直接输出正文」指令）

> **重要约束**：装配后的 messages 中，`role:'system'` 只允许出现在**开头**
> （system 人设 + bible）。把额外的 system 消息插进对话中段，会让 step-5-preview
> 把正文全部写进 reasoning 通道、content 为空（已实测）。各记忆层
> （notes / state / summaries / entities / retrieval）一律使用 `role:'user'`。

## OpenAI 兼容 API (routes/openai.js)

```
GET /v1/models -> {object:'list', data:[{id:'step-5-preview',...},{id:'roleplay-narrator'},...]}

POST /v1/chat/completions
  标准字段: model, messages, stream, temperature, max_tokens, top_p, stop,
            reasoning_effort, reasoning_format, response_format
  图片: user 消息 content 为 [{type:'text'},{type:'image_url',image_url:{url}}]
  角色扮演扩展字段（可选，放在 body 顶层）:
    session_id: string        — 存在则进入角色扮演回合管线
    settings: object          — 首次回合时随 session_id:'new' 创建会话
    generate_branches: bool
    branch_choice: object
  行为:
    - 无 session_id：透传代理到 StepFun（带 reasoning/usage 完整转发）
    - 有 session_id：跑 orchestrator，content = narrative 文本；
      流式时 delta 携带 reasoning_content（DeepSeek 风格）与 reasoning
  错误格式: {error:{message, type, code, param}}
```

## 前端接口约定 (web/)

- 无构建，原生 ES modules，`<script type="module">`
- 所有请求同源相对路径；SSE 用 fetch + ReadableStream 解析（不用 EventSource，需 POST）
- api.js 导出: `api.listSessions()`, `api.createSession()`, `api.getSession()`, `api.deleteSession()`,
  `api.runTurn(sessionId, body, handlers)` (handlers: {onEvent, signal}), `api.getMemory()`,
  `api.generateBranches()`, `api.generateOpening()`, `api.getConfig()`
- v2 新增：`api.getTurns()`, `api.searchSession()`, `api.getNotes/addNote/updateNote/deleteNote()`,
  `api.updateEntity/deleteEntity()`, `api.addFact/updateFact/deleteFact()`, `api.putState()`,
  `api.updateTurn()`, `api.rollback()`, `api.rewrite(sessionId, body, handlers)`（SSE）,
  `api.listPresets/getPreset/savePreset()`
- store.js: 极简响应式 store（subscribe/setState），localStorage 持久化 UI 偏好
  （`ai-roleplay.prefs.v2`：theme, readingWidth, readingSize, showReasoning, showTurnMarks, lastSessionId）

### 视图模块契约

每个 `web/js/views/*.js` 与 `web/js/panels/*.js` 的 default 导出：

```js
export default {
  id, title,
  async mount(root, params) -> { unmount() }
}
```

`app.js` 负责：路由解析 → `closeAllOverlays()` → 卸载旧视图 → 动态 import 新视图 → 挂载 → 加 `is-active`。
路由切换时必定关闭所有浮层（否则 sheet 会跟着页面走）。

### 浮层 API (app.js)

```js
toast(message, {duration?, type?:'info'|'error'|'success', iconName?})
showLoading(text?) / hideLoading()            // 计数式，可重入
openSheet({title, render(body, api), confirmText?, onConfirm?, cancelText?, footer?})
  -> {close, body, sheet, veil, confirmBtn}
openActionSheet({title?, actions:[{label,value,icon?,desc?,destructive?}], cancelText?}) -> Promise<value|null>
confirmDialog({title, message, confirmText?, cancelText?, destructive?}) -> Promise<boolean>
openPopover(anchorEl, items, {align?}) -> Promise<value|null>
closeAllOverlays()                            // 路由切换时调用
```

### 样式分层（web/styles/）

```
tokens.css   设计令牌（唯一的颜色/字号/圆角/阴影/动效来源）
base.css     reset + 排版 + 基础组件
shell.css    壁纸 + 浮动窗口 + 侧栏 + 导航 + 响应式
views.css    首页 / 剧本库 / 设定编辑器 / 设置
chat.css     对话阅读区
panels.css   浮层 + 记忆面板
```

约定：**新增颜色/圆角/阴影一律先用 tokens 里的变量**；组件样式只出现在它所属的那一层文件里。
