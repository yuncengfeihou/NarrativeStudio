# 叙事台 — 模块契约 (Contracts)

所有并行开发必须遵循本文件。任何偏离先改契约再改代码。

## 目录结构

```
ai-roleplay/
├── package.json
├── server/
│   ├── index.js            入口
│   ├── config.js           配置（含各层 token 配额）
│   ├── tokens.js           CJK 感知的 token 估算
│   ├── llm.js              OpenAI 兼容客户端 + usage 归一化
│   ├── agents/
│   │   ├── orchestrator.js 回合管线（会话级串行锁）
│   │   ├── narrator.js     剧情演绎（流式）
│   │   ├── branch.js       走向生成
│   │   └── memory-agent.js 记忆归档 + 反思
│   ├── memory/
│   │   ├── store.js        SQLite CRUD（世界卡/词条/会话/记忆）
│   │   ├── context-engine.js 上下文装配（核心）
│   │   ├── compressor.js   分层压缩
│   │   └── retriever.js    BM25 混合检索
│   ├── routes/
│   │   ├── worlds.js       世界卡 + 词条
│   │   ├── sessions.js     剧情会话 + 回合 + 记忆编辑
│   │   ├── presets.js      世界卡种子（磁盘 ⇄ 数据库）
│   │   ├── openai.js       /v1 兼容层
│   │   └── static.js       web 静态托管
│   └── prompts/
│       ├── memory.js
│       └── branch.js
├── web/                    原生 ESM，无构建
│   ├── index.html
│   ├── styles/             tokens · base · shell · views · chat · panels
│   └── js/
│       ├── app.js          路由 + 浮层
│       ├── shell.js        图标栏 + 目录栏
│       ├── store.js        UI 状态 + 偏好
│       ├── api.js          API 客户端（SSE 解码）
│       ├── ui-kit.js       遥测条 / 环形进度 / 通用行
│       ├── icons.js
│       ├── markdown.js
│       ├── export.js
│       ├── util.js
│       ├── views/          worlds · world · world-edit · play · settings
│       └── panels/         memory
├── presets/                世界卡种子
├── tests/
├── _work/                  一次性脚本
└── data/                   SQLite（运行时生成）
```

---

## 数据模型

### worlds（世界卡）

```js
{
  id, title, subtitle, cover_hue, tags: [],
  card: {
    title, subtitle, genre: [],
    style: { pov, voice, length, tense },
    charter: [{ rule }],
    player: { name, age, identity, situation, capability, inner_voice, wants, afraid },
    cast: [{ name, alias[], role, one_line, personality, voice, secret,
             background, relation, manner, always, weight, avatar_hue }],
    arcs: [{ title, turns, goal, beats[], avoid[] }],
    arc_turns, bans: [], opening_seed, opening_state
  },
  source: { kind, title, chapters, chars, path, analysis }
}
```

### lore_entries（词条）

```js
{
  id, world_id,
  keys: [],          // 任一命中即触发
  secondary: [],     // 有此项时必须再命中其一
  title, content,
  category,          // setting|rule|location|institution|faction|character|item|mystery|foreshadow
  priority,          // 超配额时的保留顺序
  constant,          // 无条件常驻
  enabled, sort
}
```

### sessions（剧情会话）

```js
{ id, world_id, title, settings: { narrator_effort, context_max_tokens, style_tags },
  turn_count, usage: { requests, prompt_tokens, completion_tokens, cached_tokens,
                       reasoning_tokens, total_ms, first_token_ms, output_chars },
  status, created_at, updated_at }
```

### turns（回合）

```js
{ id, session_id, turn_no, kind: 'player'|'narrator'|'system',
  content, images[], reasoning, branch_choice, token_count,
  usage: { prompt_tokens, completion_tokens, total_tokens, cached_tokens,
           reasoning_tokens, ttft_ms, duration_ms, output_chars, tps, cache_rate },
  meta, edited, created_at }
```

### 记忆表

```sql
summaries   (level 1-4, turn_from, turn_to, content, token_count, archived)
entities    (type, name, summary, attributes_json, first_turn, last_turn, importance, pinned)
facts       (subject, predicate, object, turn_no, confidence, pinned, status)
states      (turn_no, state_json)
notes       (content, kind, turn_no, active)
relations   (from_name, to_name, kind, sentiment, note, turn_no)   -- 关系账本
threads     (title, status, weight, planted_turn, resolved_turn, note) -- 线索账本
reflections (turn_from, turn_to, kind, content)                    -- 反思洞察
```

### state（场景账本）

```json
{
  "time": "初冬 · 午后",
  "location": "湘曲市 · 商务大厦门口",
  "weather": "初冬冷雨",
  "tension": 0.35,
  "characters": { "伍卿": {"mood": "窘迫", "location": "雨里", "status": "湿透"} },
  "inventory": ["无纹玉佩"],
  "quests": [{"goal": "弄清她为什么认识自己", "progress": "还没问出口", "status": "active"}],
  "last_hook": "她喊出了「卿儿」"
}
```

---

## Context Engine 接口

```js
import { assembleContext } from './memory/context-engine.js';

const ctx = await assembleContext({
  session, world, turnNo, playerText, images, branchChoice, isOpening,
});
// -> {
//   messages: [...],        // 可直接发送
//   budget: { contract, world, cast, lore, scene, director, memory,
//             retrieval, recent, current, setting, total },
//   retriever, state, recentTurns, retrievalSnippets,
//   meta: { cast_present, cast_absent, lore_entries, lore_matched,
//           director, memory_split, soft_max, hard_max }
// }
```

### 分层装配顺序

```
1. system   演绎契约（唯一允许的 system 消息）
2. user     世界宪章 + 主角速写 + 在场卡司 + 触发词条 + 场景账本 + 导演卡
3. user     分层记忆（笔记/反思/摘要/关系/线索/实体）
4. user     历史检索
5. (recent) 最近原文（user/assistant 交替）
6. user     本轮输入
```

### 硬约束

- **只有一条 `role:'system'`，且必须在最前。** 把额外的 system 插进对话中段，
  会让 step-5-preview 把正文全部写进 reasoning、content 为空（已实测）。
- 每层有独立配额（`config.context.layerBudget`），互相不挤占。
- 总量先受 `softTokens` 约束（丢检索 → 裁记忆），最后受 `hardMax` 兜底。

### 导出的纯函数（可单测）

```js
buildContract(session, world)            // 契约文本
buildCharter(world, cap)                 // 宪章层
buildProtagonist(world, session, cap)    // 主角层
pickCast(card, { playerText, recentText, state })   // -> {present, absent}
buildCast(card, {...})                   // 卡司层
scanLore(loreEntries, scanText, {recursion})        // -> {entries, matchedKeys}
buildLore(loreEntries, scanText, cap, {...})        // 词条层
buildScene(stateRec, cap)                // 场景账本
buildDirector(world, turnNo, cap)        // -> {text, arc, arcIndex, progress}
buildMemory(sessionId, cap)              // 记忆层（内部再分配）
buildOpeningSeed(world)                  // 开场种子
```

---

## Memory Agent 接口

```js
import { updateMemory, mergeState, similarity, parseMemoryUpdate, parseReflections }
  from './agents/memory-agent.js';

await updateMemory({ session, turnNo, playerText, narrative, branchChoice, options, signal });
// -> { round_summary, entities, facts, relations, threads, reflection, compressed, usage }
```

LLM 输出 schema：

```json
{
  "round_summary": "300-500 字",
  "entities": [{"type": "", "name": "", "summary": "", "importance": 0.8}],
  "facts": [{"subject": "", "predicate": "", "object": "", "confidence": 0.9}],
  "state_delta": {"time": "", "characters": {}, "inventory_add": [], "quests_update": []},
  "relations": [{"from": "", "to": "", "kind": "", "sentiment": 0.7, "note": ""}],
  "threads": [{"title": "", "action": "plant|resolve", "weight": 0.9, "note": ""}]
}
```

容错链：整体 JSON → 正则提取 `{...}` → 字段打捞 → 正文截断降级。**绝不抛错中断回合。**

---

## Compressor 接口

```js
import { checkCompression } from './memory/compressor.js';
await checkCompression(sessionId, turnNo);
// -> { created: [{level, turn_from, turn_to}], archived, error? }
```

- L1 → L2：每 `ARC_EVERY` 条连续 L1
- L2 → L3：每 `SAGA_EVERY` 条连续 L2
- L3 → L4：每 `CHRONICLE_EVERY` 条连续 L3

幂等：先查目标范围是否已被更高层覆盖。失败绝不阻塞主流程。

---

## Retriever 接口

```js
import { MemoryRetriever, tokenize } from './memory/retriever.js';

const r = new MemoryRetriever(sessionId);
r.search(query, { topK, minScore });
// -> [{kind:'turn'|'summary'|'entity'|'relation'|'thread'|'reflection',
//      ref, score, snippet, turn_no, turn_from?, turn_to?, name?}]
```

BM25（k1=1.2, b=0.75）+ 结构加权：
- 实体/线索名被 query 精确包含 → ×1.6
- 线索/反思 → ×1.25
- turn 新近度 → ×(1 + turn_no/12000)

---

## LLM 客户端接口

```js
import { chat, chatStream, normalizeUsage, LlmError } from './llm.js';

const { content, reasoning, usage, model, finishReason } = await chat({
  messages, temperature, maxTokens, reasoningEffort, responseFormat, signal,
});

for await (const ev of chatStream({ messages, signal })) {
  // ev = {type:'reasoning'|'content'|'meta', delta?, usage?, model?, finishReason?}
}
```

`usage` 归一化后包含：

```js
{ prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens,
  ttft_ms, duration_ms, output_chars, tps, cache_rate }
```

---

## Orchestrator 接口

```js
import { runTurn, getSessionSnapshot, getMemoryStats, createSessionWithSettings }
  from './agents/orchestrator.js';

await runTurn({ sessionId, playerText, images, branchChoice, generateBranches,
                isOpening, options, onEvent, signal });
```

### SSE 事件协议

```
{type:'turn_start', turn_no, is_opening}
{type:'context', turn_no, budget, meta}          // 本轮装配诊断
{type:'reasoning', delta}
{type:'narrative', delta}
{type:'narrative_done', content, token_count, finish_reason, usage}
{type:'narrative_reset', reason}                 // 上游只回思考时触发重试
{type:'memory', stats}
{type:'state', state, turn_no}
{type:'branches', branches, scene_summary}
{type:'done', turn_no, usage, session_usage}
{type:'error', message, aborted?}
{type:'ping'}
```

---

## HTTP API

### 世界卡

```
GET    /api/worlds                       -> [{id,title,subtitle,cover_hue,tags,card,session_count}]
GET    /api/worlds/:id                   -> {...world, lore, sessions}
POST   /api/worlds                       body:{id?,title,card,lore?,tags?,cover_hue?}
PATCH  /api/worlds/:id                   body:{title?,subtitle?,card?,tags?}
DELETE /api/worlds/:id

POST   /api/worlds/:id/lore              body:{content,keys?,secondary?,title?,category?,constant?,priority?}
PATCH  /api/worlds/:id/lore/:entryId
DELETE /api/worlds/:id/lore/:entryId
POST   /api/worlds/:id/sessions          body:{title?} -> 新会话
```

### 会话与回合

```
GET    /api/config                       -> {models, defaults, limits, budget}
GET    /api/sessions?world_id=           -> [{id,title,turn_count,updated_at,world_title,...}]
POST   /api/sessions                     body:{title?,settings?,world_id?}
GET    /api/sessions/:id                 -> {session,world,turns,state,usage,memoryStats}
PATCH  /api/sessions/:id
DELETE /api/sessions/:id
GET    /api/sessions/:id/turns           ?from=&to=&kinds=&limit=
GET    /api/sessions/:id/search          ?q=
POST   /api/sessions/:id/turn            -> SSE
POST   /api/sessions/:id/opening         -> SSE
POST   /api/sessions/:id/branches        -> {branches, scene_summary}
```

### 记忆

```
GET    /api/sessions/:id/memory          -> 完整统计
GET/POST   /api/sessions/:id/notes
PATCH/DELETE /api/sessions/:id/notes/:id
PATCH/DELETE /api/sessions/:id/entities/:id
POST   /api/sessions/:id/facts
PATCH/DELETE /api/sessions/:id/facts/:id
PUT    /api/sessions/:id/state           body:{state, turn_no?}
DELETE /api/sessions/:id/relations/:id
DELETE /api/sessions/:id/threads/:id
DELETE /api/sessions/:id/reflections/:id
```

### 剧情编辑

```
PATCH  /api/sessions/:id/turns/:turnNo   body:{kind, content, rememorize?}
POST   /api/sessions/:id/rollback        body:{turn_no}
POST   /api/sessions/:id/rewrite         body:{turn_no, guidance?} -> SSE
```

### memoryStats 形状

```js
{
  turn_count, context_tokens, context_max, context_soft,
  budget: { system, world, lore, scene, director, memory, recent, retrieval, current,
            summaries, recent_raw, entities, facts },
  tiers: [{level,count,tokens,last}], archive_tokens, raw_tokens, compression,
  entities, facts, relations, threads, reflections, notes,
  state, state_turn, usage, last_retrieval, last_assembly
}
```

---

## OpenAI 兼容

```
GET  /v1/models
POST /v1/chat/completions
```

扩展字段（body 顶层）：`session_id`、`world_id`、`settings`、`generate_branches`、`branch_choice`、`is_opening`

- 无 `session_id`：透传到上游
- 有 `session_id`：走 orchestrator；流式时 reasoning 放在 `reasoning_content`
- 响应 `usage` 含 `prompt_tokens_details.cached_tokens`
- 角色扮演响应额外带 `roleplay: { session_id, turn_no, branches, usage, session_usage }`

---

## 前端契约

### 视图模块

```js
export default {
  id, title,
  async mount(root, params) -> { unmount() }
}
```

`app.js` 负责：路由解析 → `closeAllOverlays()` → 卸载旧视图 → 动态 import → 挂载。

路由：

```
#/worlds            世界卡列表
#/world/:id         世界卡详情
#/play/:id          演绎阅读器
#/new  #/edit/:id   世界卡编辑器
#/settings          设置
```

### 浮层 API

```js
toast(message, {duration?, type?:'info'|'error'|'success'})
showLoading(text?) / hideLoading()
openSheet({title, render(body, api), confirmText?, onConfirm?, cancelText?, width?})
  -> {close, body, sheet, veil, confirmBtn}
openActionSheet({title?, actions:[...], cancelText?}) -> Promise<value|null>
confirmDialog({title, message, confirmText?, cancelText?, destructive?}) -> Promise<boolean>
openPopover(anchorEl, items, {align?}) -> Promise<value|null>
```

### 外壳

```js
import { initShell, openDrawer, closeDrawer, refresh, setContext } from './shell.js';

setContext({ worldId, sessionId });   // 切上下文后目录栏自动刷新会话列表
```

### UI 组件

```js
import { usageBar, sessionUsageSummary, buildRing, hueTint, hueGlyph,
         section, emptyState, infoRow, toggleRow, toneChip } from './ui-kit.js';
```

### 样式分层

```
tokens.css   设计令牌（唯一颜色/字号/圆角/阴影来源）
base.css     reset + 排版 + 基础组件
shell.css    图标栏 + 目录栏 + 主区 + 响应式
views.css    世界卡列表/详情 + 编辑器 + 设置
chat.css     演绎阅读区 + 遥测条 + 分支 + 输入区
panels.css   浮层 + 记忆面板
```

约定：新增颜色/圆角/阴影一律先用 tokens 变量；组件样式只出现在它所属的那层文件里。
