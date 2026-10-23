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

## 记忆存储接口 (server/memory/store.js, 已建)

```js
createSession({id, title, settings}) -> session
getSession(id) -> {id,title,settings,turn_count,...} | null
listSessions(), updateSession(id,{title,settings,status}), deleteSession(id)
addTurn(sessionId, {turn_no, kind:'player'|'narrator'|'system', content, images?, reasoning?, branch_choice?, meta?, token_count?})
getTurns(sessionId,{from,to,kinds}), getRecentTurns(sessionId,n), getMaxTurnNo(sessionId)
addSummary(sessionId,{level,turnFrom,turnTo,content}), getSummaries(sessionId,{level,archived,limit}),
getLatestSummaries(sessionId,level,n), archiveSummaries(ids), countSummaries(sessionId,level)
upsertEntity(sessionId,{type,name,summary,attributes,first_turn,last_turn,importance})
getEntities(sessionId,{types,limit})
addFact(sessionId,{subject,predicate,object,turn_no,confidence}), getFacts(sessionId,{limit,subject})
setState(sessionId,turnNo,state), getState(sessionId) -> {turn_no, state} | null
touchSession(id, turnCount)
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
//   messages: [...],            // 完整可发送的 messages（system + memory + recent + current）
//   budget: {system, bible, summaries, entities, retrieval, recent, current, total},
//   retriever, state, recentTurns
// }
// 硬约束：budget.total ≤ settings.context_max_tokens（默认200K）
// 装配优先级（超预算时从低到高丢弃）：retrieval > 旧summaries > entities > recent(保留至少2轮)
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

## 原生 HTTP API (routes/sessions.js)

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
GET    /api/sessions/:id/memory         -> {stats, tiers:[{level,count,tokens}], entities, state}
POST   /api/sessions/:id/opening        -> SSE 流（生成/重扩开场白，事件同 narrator）
```

memoryStats: `{turn_count, total_tokens, context_tokens, context_max, budget:{...}, tiers:[...], entities:n, facts:n, summaries:[{level,count,tokens}]}`

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
- store.js: 极简响应式 store（subscribe/setState），localStorage 持久化 UI 偏好（theme, lastSessionId）
