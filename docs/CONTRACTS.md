# 叙事台 — 模块契约 (Contracts)

所有并行开发必须遵循本文件。任何偏离先改契约再改代码。

## 目录结构

```
ai-roleplay/
├── package.json
├── server/
│   ├── index.js            入口
│   ├── config.js           配置（含各层 token 配额、Agent 档位）
│   ├── tokens.js           CJK 感知的 token 估算
│   ├── llm.js              OpenAI 兼容客户端 + usage 归一化
│   ├── world/
│   │   ├── schema.js       v4 卡形状归一 + 实体链接
│   │   ├── scene-sheet.js  世界索引 / 辞书挑选 / 场记单渲染 / 辞书检索（纯函数）
│   │   ├── effective.js    EffectiveWorld 投影（模板 + world_state）
│   │   └── state-paths.js  world_state 路径白名单
│   ├── agents/
│   │   ├── orchestrator.js    回合管线（会话级串行锁、分支感知）
│   │   ├── narrator.js        剧情演绎（流式，永不输出 JSON）
│   │   ├── narrator-loop.js   分段演绎：草稿工作区 + codex_lookup（默认关）
│   │   ├── archivist.js       史官：类型化抽取 + 确定性落库
│   │   ├── summarizer.js      前情提要（滚动摘要）
│   │   ├── retrieval.js       辞书检索预检（模型主动取证）
│   │   ├── memory-pipeline.js 场记 / 校勘 / 检索 / 世界呼吸
│   │   ├── branch.js          走向生成
│   │   └── card-smith.js      小说 → 世界卡制卡流水线
│   ├── memory/
│   │   ├── store.js        SQLite CRUD（世界卡/会话/记忆/分支/提案/摘要）
│   │   ├── branch-guard.js 异步写入的分支/叶守卫
│   │   └── context-engine.js 上下文装配（核心）
│   ├── routes/
│   │   ├── worlds.js       世界卡 + 辞书钉选 + 导出
│   │   ├── sessions.js     会话 + 回合 + 记忆六表 + 分支 + 校勘 + 回忆
│   │   ├── presets.js      世界卡种子（磁盘 ⇄ 数据库，只接受 v4 卡）
│   │   ├── smith.js        制卡流水线
│   │   ├── openai.js       /v1 兼容层
│   │   └── static.js       web 静态托管
│   └── prompts/
│       ├── archivist.js    史官 / 场记 / 校勘 / 检索 / 世界呼吸
│       ├── branch.js
│       └── narrator.js     尾注 + 分段演绎说明
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
│       ├── util.js         el / clear / 格式化
│       ├── views/          worlds · world · world-edit · play · settings
│       └── panels/         memory
├── presets/                世界卡种子（v4 形状）
├── tests/                  test-world-card · test-memory · test-context · test-api
├── _work/                  一次性脚本
└── data/                   SQLite（运行时生成）
```

---

## 数据模型

### 世界卡（worlds.card_json 是唯一真源）

```js
{
  version: 4,
  kind: 'original' | 'adapted' | 'remix',
  title, subtitle, genre[], tags[],
  source: { kind, title, chapters, canon_cutoff, path } | null,
  prompt: { premise, tone[], style_guide, narrator_notes, bans[], pov, length, tense },
  charter: [{ rule, kind }],
  cast: [{
    id, name, aliases[], role, one_line,
    identity: { age, appearance, background, station },
    voice: { address, rhythm, lexicon[], never[], exemplars[] },
    psyche: { wants[], fears[], hides[], values[] },
    knowledge: { knows[], does_not_know[], believes_falsely[] },
    agenda: [{ goal, method, pressure, deadline }],
    relations: [{ to, kind, sentiment, note }],
    always_present, weight,
  }],
  codex: [{
    id, type: 'place|institution|item|faction|concept|character|custom',
    name, aliases[], tags[], summary,
    facets: { sensory, rules[], consequences, history },
    links[], reveal: 'public|rumor|secret', canon_from, detail, pinned,
    parent_id,           // v5：地点/机构包含关系（可选）
    sources: [{ kind, ref, title, chapter, offset, quote, turn_no }],
  }],
  timeline: [{ id, when, where, what, who[], source, canon: 'past|future|branch' }],
  anchors: [{ id, label, after_event, snapshot, opening_seed, note }],
  // v5 图谱字段（可选）；没有时由 server/world/graph.js 从 relations/links/parent_id 推导
  edges: [{ from, to, kind, directed, weight, visibility, note }],
  claims: [{ subject, predicate, object:{kind,id,text}, cardinality:'one|many', visibility, validity }],
  player: { mode: 'original|canon', canon_character, name, …, knowledge },
  author_notes: [{ text, scope: 'always|scene|session' }],
}
```

**辞书图谱**：`buildWorldGraph(card)` 把 cast/codex 投影成统一实体图；同名 cast/codex 合并为
一个节点（`mergedCodexIds`），索引与场记单不再重复。边来自 `cast.relations`、`codex.links`、
`codex.parent_id` 与显式 `card.edges`。图只读、纯函数，不写库。

**模板快照**：`worlds.version` 在每次 `saveWorld()`（含辞书钉选）时递增。
会话创建时把整张卡写入 `sessions.card_snapshot_json` 并记录 `world_version`；
之后所有回合、阅读视图、记忆面板只读这份快照。作者编辑世界卡只影响新会话。

**投影表**（可 SQL 查询，随 saveWorld 同步）：

```sql
codex_entries(world_id, codex_id, type, name, aliases_json, tags_json, summary,
              facets_json, links_json, reveal, canon_from, detail, pinned, sort)
timeline_events(world_id, event_id, when_label, where_label, what, who_json, source, canon, sort)
anchors(world_id, anchor_id, label, after_event, snapshot_json, opening_seed, note)
```

### 会话与回合

```js
sessions { id, world_id, title, settings_json, card_snapshot_json, world_version,
           turn_count, usage_json, status, branch_id, anchor_id, scene_seq, … }
turns    { id, session_id, turn_no, kind, content, images_json, reasoning,
           branch_choice_json, token_count, usage_json, meta_json, branch_id, … }
branches { session_id, branch_id, parent_branch, fork_turn, status, note }
```

回合编号全局递增；`branch_id` 标记归属。分支可见 = **当前分支 + 祖先链**，每条祖先边只继承到
子分支 `fork_turn` 为止；不能只看全局 `turn_no`（否则嵌套分叉会读到废弃兄弟分支的回合）。

**分支隔离**：`states / relations / threads / character_states / assertions / voices /
scenes / world_state / summaries` 都带 `branch_id`。`forkSession()` 采用 copy-on-fork：把分叉点仍有效的
状态复制到新分支，新分支不会读到旧线在分叉点之后写下的任何内容。

`relations` / `threads` 的当前表只保留最新值，所以另有两张追加式历史表
`relation_events` / `thread_events`。fork 时复制 `turn_no <= fork_turn` 的事件，再按
「每个键最后一条事件」重建当前表；分叉点之后才建立/更新/回收的关系与线索不会进入新分支。

`summaries` 只复制 `covers_turn_to <= fork_turn` 的摘要；分叉后写的摘要不会出现在新分支。

**异步写入守卫**：旁路 Agent 在落库前用 `branchSnapshot()/isBranchCurrent()` 核对
`branch_id + 回合水位`。`forkSessionSafe()` 在会话锁内 fork，`/rollback`、`/rewrite` 必须走它。

### 记忆六表

```sql
scenes(session_id, branch_id, scene_id, level, turn_from, turn_to, when_label,
       place, place_id, cast_json, question, outcome, threads_json, state_json, token_count)
assertions(session_id, branch_id, subject, predicate, object, valid_from, valid_to,
           asserted_turn, source_turn, confidence, visibility, status, superseded_by, evidence)
character_states(session_id, branch_id, who, field, value, valid_from, valid_to, updated_turn)
world_state(session_id, branch_id, entity_kind, entity_id, path, op, value_json,
            valid_from, valid_to, source, evidence)
voices(session_id, branch_id, who, text, turn_no, kind, pinned)
patches(session_id, branch_id, agent, kind, payload_json, evidence, status, severity, turn_no, applied_at)
summaries(session_id, branch_id, covers_turn_to, text, prev_id, token_count, created_at)
```

`summaries` 是**装配层的派生数据**：`covers_turn_to` 及之前的回合在装配时不再逐字出现，
改由一条 `user` 级 `【前情提要】` 送达。原文永不删除；摘要可按 `covers_turn_to` 重压覆盖，
不可回写 `turns`。`getActiveSummary(sessionId, {branchId, atTurn})` 取覆盖边界不超过该轮的最新一份。

**world_state 是运行期世界变化的唯一写入口**：`entity_kind` 为 `cast | codex | player | world`，
`op` 为 `set | add | remove | introduce`，路径白名单在 `server/world/state-paths.js`。
身份根（id / name / identity / voice）不可写。`buildEffectiveWorld(cardSnapshot, deltas)` 把
模板与增量投影成当轮有效的世界；上下文引擎只读投影结果，永远不把运行期状态写回 `card_json`。

**辞书定义与运行态分离**：`summary / detail / facets.history` 是作者公理，已有条目运行期不可写
（`CODEX_CANON_PATHS`）；运行期只写 `status / condition / access / open_to / owner_id / location_id /
reveal / facets.sensory` 与列表路径。新条目第一次 `introduce` 时可以一次写清定义。

**断言语义**：只有**单值谓词**（位于 / 是 / 曾经是）在「同主同谓、对象不同、有效期重叠」时
把旧断言 `status='invalidated'` 并记 `valid_to`，**不删除**；多值谓词（知道 / 拥有 / 想要…）
的多个对象可以并存。基数表在 `server/memory/predicates.js`。
`getAssertions(atTurn)` 按时间点回溯，不过滤 status（只排除 retracted）。

**受控词表**（`server/memory/predicates.js`，提示词 re-export）：

```js
PREDICATES = ['知道','不知道','相信','想要','害怕','拥有','位于','属于',
              '敌对','效忠','隐瞒','承诺','欠','伤害','救下','是','曾经是']
STATE_FIELDS = ['condition','mood','location','goal']
VISIBILITIES = ['public','engine','secret']
```

---

## World Schema 接口

```js
import {
  normalizeCard, buildAliasIndex, linkEntities,
  resolveWho, sceneThemeTags, renderCardText, slugify,
} from './world/schema.js';

normalizeCard(raw)                 // 任意来源 → v4 形状（顶层 premise 也接受）
buildAliasIndex(card)              // [{alias, kind:'cast'|'codex', id, name}] 长别名优先
linkEntities(text, aliasIndex)     // -> {cast:[], codex:[]} 最长匹配、不重叠计数
renderCardText(card)               // 纯文本导出（时间线标 canon 供人看）
```

## 辞书图谱接口（纯函数）

```js
import {
  buildWorldGraph, graphNeighbors, graphAncestors, graphChildren, hasContainment,
} from './world/graph.js';
import { lintCard } from './world/lint.js';

buildWorldGraph(card)
// -> { entities:Map, edges[], aliasToId:Map, mergedCodexIds:Set,
//      codexById:Map, castById:Map, adjacency:Map, resolve(ref) }
graphNeighbors(graph, ids, { depth })   // -> Set<entityId>（1 跳/多跳邻域）
graphAncestors(graph, id) / graphChildren(graph, id)
lintCard(card)                          // -> {issues:[{severity,code,message,ids}], counts}
```

## Scene Sheet 接口（纯函数）

```js
import { renderWorldIndex, renderWorldTree, selectCodex, renderSceneSheet } from './world/scene-sheet.js';

renderWorldIndex(card, capTokens, { skipIds })     // 平铺索引；超配额降级为只留名字
renderWorldTree(card, capTokens, { skipIds, currentPlaceId })
  // 有 parent_id 时按包含关系折叠；没有时退回 renderWorldIndex
selectCodex(card, { presentIds, mentionedIds, threadTags, pinnedIds, currentPlaceId, skipIds })
  // -> [{entry, score, why[]}]  实体连接 60 / 主题标签 30 / 钉选 100 / 当前地点 20
  // currentPlaceId 只认账本 place_id；skipIds 用于跳过与 cast 合并的 codex
renderSceneSheet({ ledger, present, relations, threads, codex, codexBrief, voices, echoes, directive, capTokens })
  // codex = T0 全量，codexBrief = T1 一句
  // -> {text, meta}  meta 记录 kept[] / dropped[] / codex_rendered / codex_brief_rendered
```

## Context Engine 接口

```js
import { assembleContext, buildSystemLayer, buildContract } from './memory/context-engine.js';

const ctx = await assembleContext({ session, world, turnNo, playerText, images,
                                    branchChoice, isOpening, directive, retrieval });
// retrieval = { text, queries, entries } | null   // 模型主动检索的辞书全文（当拍）
// -> { messages, budget:{system,summary,recent,scene,retrieval,current,total}, state, ledger, anchor,
//      recentTurns, echoes, meta:{present, mentioned, theme_tags, codex, codex_candidates,
//                                 codex_rendered, codex_dropped, codex_brief_candidates,
//                                 codex_brief_rendered, graph:{entities,edges,merged_codex},
//                                 facts, facts_candidates, dropped_sections, branch, summary,
//                                 retrieval, degraded} }
```

装配顺序（缓存友好）：**稳定前缀 → 前情提要 → 追加原文 → 易变尾部**

```
1. system   契约 + 命题 + 宪章 + 世界索引（有 parent_id 时是树形；同名 codex 已去重）
2. user     【前情提要】滚动摘要（覆盖到 covers_turn_to）
3. …        最近原文（turn_no > covers_turn_to，player/assistant 交替）
4. user     场记单（T0 全量设定 + T1 一句邻域设定；每场变一次）
5. user     【检索结果】（模型主动查阅的辞书全文，当拍蒸发）
6. user     本场指令 + 本轮行动 + 尾注
```

### 硬约束

- **只有一条 `role:'system'`，且必须在最前。**
- **没有关键词触发、没有扫描深度、没有递归、没有优先级、没有常驻开关。**
- 辞书自动进场仍只有三条路（实体连接 / 主题标签 / 钉选）；`retrieval` 是模型发起的取证，
  不是第四条自动注入路径，代码不因文本匹配自动塞设定。
- codex 条目按预估成本决定条数（`scene * 0.45 / 90`），高分优先，低分整条放弃。
- 超预算降级：裁场记单 → 裁前情提要 → 砍一半最近原文 → 截断最长非 system 消息。
- 在场以账本 `present`（史官声明的镜头内人物）为准；旧会话没有 `present` 时退回 `characters`。
  最近原文提到但不在场的角色只进辞书邻域/关系提示，不占完整人物卡位。
- 玩家角色永远在场（即使不在 cast 里，也会造一个最小条目）。
- `turns.meta.assembly` 持久化本轮装配清单（层预算、在场、辞书候选/实渲染与原因、摘要/检索、降级标记）。

## Agent 接口

```js
// 旁白（单发）
runNarrator({ session, world, context, turnNo, options, onDelta, signal })
// -> {content, reasoning, usage, model, finishReason}

// 旁白（分段演绎，P1-1 第一阶段；会话 settings.narration_mode='segmented' 才走）
runNarratorSegmented({ session, world, context, turnNo, options, onEvent, signal })
// -> {content, reasoning, usage, model, finishReason,
//     narration:{mode:'segmented', rounds, tools, sealed}}
// 工具：draft_append / draft_edit / draft_seal / codex_lookup
// 工具结果只进当拍临时消息；总预算 config.narration.toolHistoryTokens（默认 1200）。
// 上游不支持 tools 时由 orchestrator 回退 runNarrator（narration.fallback='segmented'）。

// 纯函数（便于单测）
resolveNarrationMode(settings, defaultMode?) -> 'single'|'segmented'
applyDraftEdit(draft, find, replace, {all?}) -> {text, changed, count}
mergeToolCallDeltas(map, deltas) / parseToolArgs(raw) / mergeUsage(acc, next)
trimToolHistory(messages, baseLen, budgetTokens) -> removed

// 史官（每轮后）
runArchivist({ session, world, turnNo, playerText, narrative, branchChoice, options, signal, guard })
// -> { applied:{assertions, assertions_invalidated, states, changes, relations, threads, voices, ledger},
//      scene_change:{changed, when, place, place_id, weather, tension, present[]},
//      uncertain, usage, stale? }
// scene_change.present 是「这一拍镜头里的人物」的唯一依据；place 能对上辞书 place 时自动补 place_id。
// guard: () => boolean；false = 调用期间分支/回合已变，整批丢弃并记 patches(status='stale')。
applyArchivistUpdate({ sessionId, branchId, turnNo, update, aliasIndex, playerName })   // 纯函数，可单测
parseArchivistUpdate(content)     // 容错：整体 JSON → 正则提取 → 空形状降级
sanitizeAssertion(raw, aliasIndex) / sanitizeState(raw, aliasIndex)
sanitizeChange(raw, { aliasIndex, playerName }) / mergeLedger(old, delta, {aliasIndex})
// buildEffectiveWorld(cardSnapshot, deltas) 在 server/world/effective.js，纯函数

// 定稿：把当前世界线固化成新的世界卡（显式作者操作）
canonizeSession({ sessionId, title?, anchorLabel?, openingSeed?, id? })
// -> { world, card, from: { session_id, turn_no, branch } }

// 场记 / 校勘 / 检索 / 世界呼吸（server/agents/memory-pipeline.js）
closeScene({ session, world, turnNo, reason, guard })    // 切场归档；stale 返回 null
detectSceneChange(session, update, turnNo)                // 地点/时间/在场者变了就切
runContinuity({ session, world, turnNo, signal, guard })  // -> {issues, healthy, applied, stale?}
runLibrarian({ session, question, signal })               // -> {found, answer, citations, calls}
// 工具：search_events / search_assertions / get_character_state / get_threads / get_scene /
//       get_relations(who) / search_claims(subject,predicate)
runWorldTick({ session, world, turnNo, signal, guard })   // -> {events, stale?}

// 前情提要（server/agents/summarizer.js）
planSummary({ turnNo, active, every, keepRecent })   // 纯函数 -> {from,to,covered}|null
runSummarizer({ session, branchId, turnFrom, turnTo, previousSummary, playerName, charName, signal })
// -> {text, turns, chars, usage} | {skipped:true, reason, chars?}

// 辞书检索预检（server/agents/retrieval.js）
shouldPrecheckRetrieval({ mode, codexCount, minCodex, playerText, branchChoice, card })
// auto：大卡 + 玩家文本点名了某个 codex 才跑；on/off 强制开关。
runRetrieval({ card, playerText, ledger, lastNarrative, signal })
// -> {text, queries, entries:[{id,name,why}], usage} | null
// parseRetrievalQueries(content) -> string[]（宽容解析，失败返回空数组）

// 分支守卫（server/memory/branch-guard.js）
branchSnapshot(sessionId, branchId?) -> {sessionId, branchId, maxTurnNo, maxTurnId} | null
isBranchCurrent(snapshot) -> boolean
guardOf(snapshot) -> () => boolean

// 制卡（server/agents/card-smith.js）
smithCard({ dir, title, premise, concurrency, maxChapters, startAt, openingSeed, player, onProgress, signal })
// 内部步骤（不导出）：readChapters / parseChapterExtract / buildCardFromExtracts
```

模型选择：每个 Agent 调 `chat()` 时传 `model: cfg.model || undefined`，`cfg.model` 来自
`<AGENT>_MODEL`（summarizer 为 `SUMMARY_MODEL`）。Agent 函数层还接受 `options.model`
单次覆盖（narrator 由 `runTurn` 的 `options` 直接透传，archivist / branch 走各自的
`options.<agent>.model`）；留空时由 `llm.js` 回落到 `config.upstream.model`。
`/v1` 非流式透传沿用客户端 `model`，流式透传原样转发请求体。

## Orchestrator 接口

```js
runTurn({ sessionId, playerText, images, branchChoice, generateBranches,
          isOpening, options:{directive}, onEvent, signal })
createSessionWithSettings({ title, settings, worldId, anchorId })   // 用锚点快照初始化账本
forkSession({ sessionId, toTurn, note })                            // 回滚 = 开新分支（同步，内部/测试）
forkSessionSafe({ sessionId, toTurn, note })                        // 路由必须走：会话锁内 fork
getSessionSnapshot(sessionId) / getMemoryStats(sessionId)
recallSession({ sessionId, question }) / auditSession({ sessionId })
```

### SSE 事件协议

```
{type:'turn_start', turn_no, is_opening, branch}
{type:'context', turn_no, budget, meta, scene_sheet}
{type:'reasoning', delta} / {type:'narrative', delta}
{type:'draft_start', turn_no, mode:'segmented', max_rounds}
{type:'draft_delta', delta} / {type:'draft_reset', content}
{type:'draft_done', turn_no, content, rounds, tools, sealed}
{type:'tool_call', turn_no, round, name, ok, label}
{type:'narration_fallback', mode:'segmented', reason}
{type:'narrative_done', content, token_count, finish_reason, usage}
{type:'narrative_reset', reason}
{type:'memory', stats} / {type:'state', state, turn_no}
{type:'summary', state:'start'|'end', ok?, from?, to?, covers_turn_to?, turns?, chars?, tokens?, reason?}
{type:'scene', scene}                    // 切场归档
{type:'world_tick', events}              // 幕后推演
{type:'continuity', report}              // 校勘
{type:'branches', branches, scene_summary, stale?}
{type:'done', turn_no, branch, narration_mode, usage, session_usage, memory}
{type:'error', message, aborted?} / {type:'ping'}
```

---

## HTTP API

```
GET    /api/config
GET    /api/fonts                         -> {fonts, source}（服务端本机字体）
GET    /api/worlds                        -> 摘要列表
GET    /api/worlds/:id                    -> {world, card, codex, sessions}
GET    /api/worlds/:id/export             -> 纯文本
GET    /api/worlds/:id/lint               -> {issues, counts}（断链/别名/环/声明冲突）
POST   /api/worlds                        body:{id?, title?, card, source?}
PATCH  /api/worlds/:id
DELETE /api/worlds/:id
POST   /api/worlds/:id/codex/:codexId/pin body:{pinned}
POST   /api/worlds/:id/sessions           body:{anchor_id?}

GET    /api/sessions?world_id=
POST   /api/sessions                      body:{world_id?, anchor_id?}
GET    /api/sessions/:id                  -> {session, card, world, turns, state, usage, memoryStats}
PATCH  /api/sessions/:id                  body:{scene_directive?, title?, settings?}
                                          // settings 合并写入；narration_mode:'single'|'segmented'
DELETE /api/sessions/:id
GET    /api/sessions/:id/turns            ?from=&to=&limit=
GET    /api/sessions/:id/search           ?q=
POST   /api/sessions/:id/turn             -> SSE  body:{playerText, images, branchChoice, directive, isOpening}
POST   /api/sessions/:id/opening          -> SSE
POST   /api/sessions/:id/branches         -> {branches, scene_summary}
POST   /api/sessions/:id/rewrite          -> SSE（自动开新分支）
POST   /api/sessions/:id/rollback         body:{turn_no}   -> 新分支
GET    /api/sessions/:id/branches
POST   /api/sessions/:id/canonize         body:{title?, anchor_label?, opening_seed?} -> 新世界卡

GET    /api/sessions/:id/memory           -> 完整统计
GET    /api/sessions/:id/assertions       ?subject=
POST   /api/sessions/:id/assertions       body:{subject, predicate, object, visibility?}
DELETE /api/sessions/:id/assertions/:id
GET    /api/sessions/:id/states
PUT    /api/sessions/:id/state            body:{state, turn_no?}
GET    /api/sessions/:id/scenes
GET    /api/sessions/:id/threads
GET    /api/sessions/:id/world-state      ?at_turn= -> 本局世界线增量
GET    /api/sessions/:id/voices
POST   /api/sessions/:id/voices/:id/pin   body:{pinned}
DELETE /api/sessions/:id/voices/:id
GET    /api/sessions/:id/patches          ?status=
POST   /api/sessions/:id/patches/:id/resolve  body:{status:'applied'|'dismissed'}
GET    /api/sessions/:id/notes
POST   /api/sessions/:id/notes            body:{content, kind}
PATCH  /api/sessions/:id/notes/:id
DELETE /api/sessions/:id/notes/:id
POST   /api/sessions/:id/audit            -> 校勘报告
POST   /api/sessions/:id/recall           body:{question} -> {found, answer, citations}

GET    /api/presets / GET /api/presets/:id
POST   /api/presets                       body:{id, card}（只接受 v4 卡）
POST   /api/presets/:id/import
GET    /api/smith/materials
POST   /api/smith/preview                 -> SSE  body:{dir, title, premise, max_chapters}
POST   /api/smith/save                    body:{id?, card}
```

## 前端契约

### 视图模块

```js
export default { id, title, async mount(root, params) -> {unmount()} }
```

路由：`#/worlds` · `#/world/:id` · `#/play/:id` · `#/new` · `#/edit/:id` · `#/settings`

### 记忆面板

```js
import { openMemoryPanel } from './panels/memory.js';
openMemoryPanel(sessionId, { onUpdate, onReset })
```

分区：概览 / 分支 / 场次索引 / 断言账本 / 人物状态 / 线索 / 原声 / 校勘提案 / 作者笔记。

### el() 的 class 约定

`el('div.foo', …)` 的 tag 串**不能带空格**。条件类名必须走属性：

```js
el('div', { class: 'mem-branch' + (isCur ? ' is-current' : '') }, …)   // ✅
el('div.mem-branch is-current', …)                                     // ❌ 抛 DOMTokenList
```

### 字体与偏好

```js
import { listLocalFonts, fontStack, fontDisplayName } from './fonts.js';
import { ui, setPref, applyAppearancePrefs } from './store.js';

// uiFont      → 根节点 --font-ui（除正文外的所有界面文字）
// readingFont → 根节点 --font-read（演绎正文）
setPref('uiFont', '思源宋体');
setPref('readingFont', '霞鹜文楷');
applyAppearancePrefs();
```

`listLocalFonts()` 只在 Chromium 系浏览器可用，必须在用户手势里调用；
不支持时回退到 `COMMON_FONTS` 与手动输入。

### 样式分层

```
tokens.css   设计令牌（唯一颜色/字号/圆角/阴影来源）
base.css     reset + 排版 + 基础组件
shell.css    图标栏 + 目录栏 + 主区 + 响应式
views.css    世界卡列表/详情 + 编辑器 + 设置 + 命题/时间线/辞书 + 场记单/切场/世界呼吸/回忆
chat.css     演绎阅读区 + 遥测条 + 分支 + 输入区
panels.css   浮层 + 记忆面板
```

约定：新增颜色/圆角/阴影一律先用 tokens 变量；组件样式只出现在它所属的那层文件里。
