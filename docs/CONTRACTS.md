# 叙事台 — 模块契约 (Contracts)

所有并行开发必须遵循本文件。任何偏离先改契约再改代码。

## 目录结构

```
NarrativeStudio/
├── package.json
├── server/
│   ├── index.js            入口
│   ├── config.js           配置（含各层 token 配额、Agent 档位）
│   ├── tokens.js           CJK 感知的 token 估算
│   ├── llm.js              OpenAI 兼容客户端 + usage 归一化
│   ├── world/
│   │   ├── schema.js       v5 卡形状归一（entities 单命名空间）+ 实体链接
│   │   ├── scene-sheet.js  世界索引 / 辞书挑选 / 场记单渲染 / 辞书检索（纯函数）
│   │   ├── effective.js    EffectiveWorld 投影（模板 + world_state）
│   │   └── state-paths.js  world_state 路径白名单
│   ├── agents/
│   │   ├── orchestrator.js    回合管线（会话级串行锁、分支感知）
│   │   ├── narrator.js        剧情演绎（流式，永不输出 JSON）
│   │   ├── narrator-loop.js   分段演绎：草稿工作区 + codex_lookup / recall_history（默认关）
│   │   ├── archivist.js       史官：类型化抽取 + 确定性落库
│   │   ├── retrieval.js       辞书检索预检（模型主动取证）
│   │   ├── memory-pipeline.js 场记 / 校勘 / 检索 / 世界呼吸
│   │   ├── branch.js          走向生成
│   │   └── card-smith.js      小说 → 世界卡制卡流水线
│   ├── memory/
│   │   ├── store.js        SQLite CRUD（世界卡/会话/记忆/分支/提案/实体投影）
│   │   ├── branch-guard.js 异步写入的分支/叶守卫
│   │   ├── player-view.js  玩家可见状态投影（纯函数；场景信息条唯一数据源）
│   │   └── context-engine.js 上下文装配（核心）
│   ├── routes/
│   │   ├── worlds.js       世界卡 + 辞书钉选 + 导出
│   │   ├── sessions.js     会话 + 回合 + 记忆六表 + 分支 + 校勘 + 回忆
│   │   ├── presets.js      世界卡种子（磁盘 ⇄ 数据库，只接受 v5 卡）
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
├── presets/                世界卡种子（v5 形状，entities[]）
├── tests/                  test-world-card · test-memory · test-context · test-api
├── _work/                  开发期脚本（不参与运行时；清单见 _work/README.md）
└── data/                   SQLite（运行时生成）
```

---

## 数据模型

### 世界卡（worlds.card_json 是唯一真源）

```js
{
  version: 5,
  kind: 'original' | 'adapted' | 'remix',
  title, subtitle, genre[], tags[],
  source: { kind, title, chapters, canon_cutoff, path } | null,
  prompt: { premise, tone[], style_guide, narrator_notes, bans[], pov, length, tense },
  charter: [{ rule, kind }],
  entities: [{           // 单一命名空间：人物与设定集条目同表，id 在整卡内唯一
    id, type: 'person|place|institution|item|faction|concept|custom',
    name, aliases[], tags[], summary, detail,
    facets: { sensory, rules[], consequences[], history },
    links[], reveal: 'public|rumor|secret', canon_from, pinned, muted, parent_id,
    sources: [{ kind, ref, title, chapter, offset, quote, turn_no }],
    // type === 'person'：有声音与动机的角色
    role, status, condition, mood, location, goal,
    identity: { age, appearance, background, station },
    voice: { address, rhythm, lexicon[], never[], exemplars[] },
    psyche: { traits[], wants[], fears[], hides[], values[] },
    knowledge: { knows[], does_not_know[], believes_falsely[] },
    agenda: [{ goal, method, pressure, deadline }],
    relations: [{ to, kind, sentiment, note }],
    always_present, weight,
    // type !== 'person'：世界事实的运行期可写字段
    access, open_to, owner_id, location_id,
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

**实体图**：`buildWorldGraph(card)` 直接读 `card.entities`（单一命名空间，不再合并 cast/codex）。
边来自 `entity.relations`（人物）、`entity.links`（设定集）、`entity.parent_id` 与显式 `card.edges`。
图只读、纯函数，不写库。

**模板快照**：`worlds.version` 在每次 `saveWorld()`（含辞书钉选）时递增。
会话创建时把整张卡写入 `sessions.card_snapshot_json` 并记录 `world_version`；
之后所有回合、阅读视图、记忆面板只读这份快照。作者编辑世界卡只影响新会话。

**投影表**（可 SQL 查询，随 saveWorld 同步）：

```sql
entities(world_id, entity_id, type, name, aliases_json, tags_json, summary, detail,
         facets_json, links_json, reveal, canon_from, pinned, muted, parent_id, sort)
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
scenes / world_state` 都带 `branch_id`。`forkSession()` 采用 copy-on-fork：把分叉点仍有效的
状态复制到新分支，新分支不会读到旧线在分叉点之后写下的任何内容。

复制时会把 `valid_to` **裁到 `fork_turn`**：旧线在分叉点之后才发生的失效，在新线上从未发生。
不裁的话，新分支往回走一步就多出一批「未来才会失效」的状态，`atTurn` 查询会返回空集——
比没有记忆更糟，因为它自相矛盾。

`relations` / `threads` 的当前表只保留最新值，所以另有两张追加式历史表
`relation_events` / `thread_events`。fork 时复制 `turn_no <= fork_turn` 的事件，再按
「每个键最后一条事件」重建当前表；分叉点之后才建立/更新/回收的关系与线索不会进入新分支。

**异步写入守卫**：旁路 Agent 在落库前用 `branchSnapshot()/isBranchCurrent()` 核对
`branch_id + 回合水位`。`forkSessionSafe()` 在会话锁内 fork，`/rollback`、`/rewrite` 必须走它。

### 记忆六表

```sql
scenes(session_id, branch_id, scene_id, level, turn_from, turn_to, when_label,
       place, place_id, cast_json, question, outcome, key_detail, causal, importance,
       threads_json, hooks_json, state_json, token_count)
assertions(session_id, branch_id, subject, predicate, object, valid_from, valid_to,
           asserted_turn, source_turn, confidence, visibility, status, superseded_by, evidence)
character_states(session_id, branch_id, who, field, value, valid_from, valid_to, updated_turn)
world_state(session_id, branch_id, entity_kind, entity_id, path, op, value_json,
            valid_from, valid_to, source, evidence)
voices(session_id, branch_id, who, text, turn_no, kind, pinned)
patches(session_id, branch_id, agent, kind, payload_json, evidence, status, severity, turn_no, applied_at)
```

> **`summaries` 表已删除**（2026-10-24）。「一份滚动摘要」要求 1056:1 的压缩比，
> 结构上不可能承载千轮；且它以上一份摘要为输入（摘要的摘要），违反「原文是唯一真相」。

`scenes` 是**长程记忆的载体**：每场一行、只追加、永不互相改写，输入是本场完整原文。
`question / outcome / key_detail / causal / hooks` 共同承担「这一场发生了什么、为什么走到这里、
还悬着什么」；`importance`（major/normal/minor）决定渲染粒度，由确定性规则判定。
装配时渲染为「场次索引」层与「最近 1–2 场细节」块。

**写入 `assertions` / `voices` / `patches` 必须显式给 `branch_id`**（缺省抛错，不再静默兜底 `main`）。

**world_state 是运行期世界变化的唯一写入口**：`entity_kind` 为实体类型（`person` / `place` / `institution` / `item` / `faction` / `concept` / `custom`）或 `player | world`，
`op` 为 `set | add | remove | introduce`，路径白名单在 `server/world/state-paths.js`。
身份根（id / name / identity / voice）不可写。`buildEffectiveWorld(cardSnapshot, deltas, fates)` 把
模板、增量与已解锁的成长阶段投影成当轮有效的世界（优先级：`world_state` > `fates` > 卡初始值）；
上下文引擎只读投影结果，永远不把运行期状态写回 `card_json`。

**实体定义与运行态分离**：`summary / detail / facets.history` 是作者公理，已有事实实体运行期不可写
（`FACT_CANON_PATHS`）；运行期只写 `status / condition / access / open_to / owner_id / location_id /
reveal / facets.sensory` 与列表路径。人物（person）另外可写 `summary / role / mood / goal / location`
与 `voice / psyche / knowledge / agenda / relations` 的列表路径。新条目第一次 `introduce` 时可以一次写清定义。

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
  CARD_VERSION, ENTITY_TYPES, PERSON_TYPE, isPerson, isFact, slugify,
  normalizeCard, buildAliasIndex, linkEntities, resolveWho, resolveEntity,
  sceneThemeTags, renderCardText,
} from './world/schema.js';

normalizeCard(raw)                 // 任意来源 → v5 形状（entities[] 单命名空间）
buildAliasIndex(card)              // [{alias, type, id, name, role}] 长别名优先
linkEntities(text, aliasIndex)     // -> {person:[], fact:[]} 最长匹配、不重叠计数
resolveWho(name, aliasIndex)       // -> {type,id,name}；只认 person（账本人物）
resolveEntity(name, aliasIndex)    // -> {type,id,name}；任意实体
renderCardText(card)               // 纯文本导出（角色段 + 设定集段；时间线标 canon 供人看）
```

## 辞书图谱接口（纯函数）

```js
import {
  buildWorldGraph, graphNeighbors, graphAncestors, graphChildren, hasContainment,
} from './world/graph.js';
import { lintCard } from './world/lint.js';

buildWorldGraph(card)
// -> { entities:Map, edges[], aliasToId:Map, entityById:Map, personById:Map,
//      adjacency:Map, resolve(ref) }
graphNeighbors(graph, ids, { depth })   // -> Set<entityId>（1 跳/多跳邻域）
graphAncestors(graph, id) / graphChildren(graph, id) / hasContainment(graph)
lintCard(card)
// -> {issues:[{severity:'blocker'|'major'|'minor'|'info', code, message, ids?}],
//     counts:{entities, persons, facts, edges, issues, bySeverity:{blocker,major,minor,info}}}
// 结构检查：断链/别名冲突/包含环/孤立实体/单值声明冲突；
// 内容检查（info）：person_incomplete（缺 appearance/summary/rhythm）、person_hollow（wants+hides 全空）、
//                  fact_incomplete（缺 summary/facets）
// 阻断项（blocker）：parent_cycle、duplicate_id、future_leak（有 source.canon_cutoff 时 past 事件章号 ≥ cutoff；来源不可解析则不猜）
```

## Scene Sheet 接口（纯函数）

```js
import { renderWorldIndex, renderWorldTree, selectCodex, renderSceneSheet } from './world/scene-sheet.js';

renderWorldIndex(card, capTokens, { skipIds })     // 人物段 + 设定集段；超配额降级为只留名字
renderWorldTree(card, capTokens, { skipIds })      // 有 parent_id 时按包含关系折叠；没有时退回 renderWorldIndex
renderTimelinePast(card, capTokens)                // 前史（canon='past'）一行一条；future/branch 永不渲染
selectCodex(card, { presentIds, mentionedIds, threadTags, pinnedIds, currentPlaceId, skipIds })
  // 只在事实实体里选（人物由在场判定带出）；-> [{entry, score, why[]}]
  // 实体连接 60 / 主题标签 30 / 钉选 100 / 当前地点 20；muted 条目不进入候选（静音 ≠ 删除）
renderSceneSheet({ ledger, present, relations, threads, codex, codexBrief, voices, echoes, directive, capTokens })
  // codex = T0 全量事实条目，codexBrief = T1 一句；人物走 present 的 renderCastLine
  // -> {text, meta}  meta 记录 kept[] / dropped[] / codex_rendered / codex_brief_rendered
lookupCodex(card, queries, { limit })              // 模型主动检索：遍历全部实体（含 person）
renderCodexHit(entry)                              // 单条渲染；person 额外渲染身份/口吻/性格/知识边界
```

## Context Engine 接口

```js
import { assembleContext, buildSystemLayer, buildContract, selectFacts, renderKnowledgeMatrix }
  from './memory/context-engine.js';

const ctx = await assembleContext({ session, world, turnNo, playerText, images,
                                    branchChoice, isOpening, directive, retrieval,
                                    previousMessages });
// retrieval        = { text, queries, entries } | null   // 模型主动检索的辞书全文（当拍）
// previousMessages = 上一轮真实发出的 messages | null     // 仅用于计算前缀复用率，不影响装配内容
// -> { messages,
//      budget:{system,archive,summary,recent,scene,retrieval,current,total},   // summary 恒为 0（层已移除）
//      state, ledger, anchor, recentTurns, echoes,
//      meta:{present, mentioned, theme_tags, codex, codex_candidates,
//            codex_rendered, codex_dropped, codex_brief_candidates,
//            codex_brief_rendered, graph:{entities,edges},
//            facts, facts_candidates, facts_single, facts_many_rendered, facts_many_dropped,
//            state_fixes, state_warnings,
//            fates:{total, unlocked, omens},
//            timeline_past, timeline_future_held,
//            system_blocks:{timeline_past:{count, rendered, tokens, dropped, cap}},
//            dropped_sections, branch,
//            coverage:{summary_to /* = 场次覆盖边界，保留旧名 */, recent_from, recent_to, turns,
//                      scene_count, scene_to, scene_index_rendered,
//                      scene_index_dropped, scene_index_degraded},
//            cache:{prefix_shared_tokens, prefix_shared_rate, first_divergence, system_hash,
//                   drift:{verdict,index,char_offset,left_excerpt,right_excerpt,shared_messages,
//                          prev_count,next_count}},
//            summary: null, retrieval, degraded, soft_max, hard_max,
//            hard_cap:{mode:'fail'|'truncate', narrowed:['scene_detail'|'scene_sheet'|'retrieval']},
//            messages:[{index, role, owner, tokens}]}} }
```

装配顺序（缓存友好）：**冻结前缀 → 只追加历史 → 易变尾部**

```
1. system   契约 + 命题 + 宪章 + 世界索引 + 前史（canon=past）+ 主角 + 作者笔记（**只读模板快照，绝不读运行态**）
2. user     【本局场次索引】一行一场，只追加
3. …        当前场次逐字原文 = 上一场 turn_to + 1 起，到本轮之前（player/assistant 交替）
4. user     【刚才这一场怎么收的】最近 1–2 场细节
5. user     场记单（T0 全量设定 + T1 一句邻域 + 在场者 voice + 断言 + 知识矩阵；每场变一次）
6. user     【检索结果】（模型主动查阅的辞书全文，当拍蒸发）
7. user     本场指令 + 本轮行动 + 尾注
```

`meta.cache` 是缓存归因：`prefix_shared_tokens` 是与上一轮消息序列的最长公共前缀（估算 tok），
`first_divergence` 指出第一个断点落在哪一层（system/archive/recent/scene/retrieval/current），
`system_hash` 用于跨轮判断 system 是否真的冻结。纯字符串比较，零 token 成本。

`meta.cache.drift`（`server/memory/prompt-drift.js` 纯函数 `comparePromptMessages()`）把
`first_divergence` 细化到**消息级**：`verdict` = `identical` / `appendedMessages`（上一轮是
本轮的真前缀，最理想）/ `broken`（中间有消息被改写或删除）/ `unknown`（没有上一轮基线）；
`index` = 第一条不同的消息下标；`char_offset` = 该消息内第一个不同字符的偏移；
`left_excerpt` / `right_excerpt` = 断点两侧各 60 字。只写 `turns.meta_json`，
不进提示词、不占预算；摘录可能含正文，不往前端展示面推。

`meta.messages` 是**渲染归属审计**：装配出口逐条列出 `{index, role, owner, tokens}`，
`owner` ∈ `system / archive / recent / scene_detail / scene_sheet / retrieval / current`。
只写 `turns.meta_json`，不进提示词；用于回答「这条消息算谁的预算」，也是新增内容必须
落进某一层配额的可核对证据。

`meta.system_blocks.timeline_past` 是**前史块**的落位证据 `{count, rendered, tokens, dropped, cap}`。
前史 = 模板卡里 `canon === 'past'` 的 timeline 事件，由 `renderTimelinePast()` 渲染成
「【前史】开局之前已经发生的事实」一行一条，`buildSystemLayer()` 把它排在世界索引之后、
主角之前。硬约束：

- 只读 `session.card_snapshot`，**不读 world_state / scenes**：system 必须在连续 10 轮里逐字节不变。
- `canon === 'future'` / `'branch'` **永不渲染**（红线 3：future 只作改编卡的校勘参考，
  既不是既定事实，也不是演绎目标）；提示词里不出现 future 事件或「必达节拍」指令。
- 前史与世界索引**共享 system 预算**：先按上限 240 tok 从最新往前取（塞不下的旧行整条丢弃，
  不切半句），索引再吃剩余空间；绝不挤掉契约/宪章/主角/常驻作者笔记。

### 记忆覆盖不变量

- **场次边界 + 1 必须等于原文窗口第一轮**：`coverage.recent_from === coverage.scene_to + 1`
  （没有更早回合时 `recent_from` 为 null）。原文窗口不做字符串裁剪。
- **场次只追加、不互相改写**：每场只从自己的完整原文生成（`closeScene()`）。
- **强制封场**：`SCENE_EVERY` 轮或 `SCENE_MAX_TOKENS` token 触发。只靠「地点变化」会让
  同一地点的长剧情一场都不关，场次索引根本建不起来。
- 结构化记忆（账本/断言/关系/线索/场次）是**主要**记忆载体；场次记录的
  `question / outcome / key_detail / causal / hooks` 承担因果、时间顺序与关键细节。
- **system 必须逐字节冻结**：连续 10 轮（即使史官一直写 `entity.role` / `player.situation` /
  `introduce`）`messages[0].content` 完全一致。这是缓存命中率的前提。

### 硬约束

- **只有一条 `role:'system'`，且必须在最前。**
- **没有关键词触发、没有扫描深度、没有递归、没有优先级、没有常驻开关。**
- 辞书自动进场仍只有三条路（实体连接 / 主题标签 / 钉选）；`retrieval` 是模型发起的取证，
  不是第四条自动注入路径，代码不因文本匹配自动塞设定。
- codex 条目按预估成本决定条数（`scene * 0.45 / 90`），高分优先，低分整条放弃。
- 超预算降级：软目标内裁场次细节 → 裁场记单（原文窗口与场次索引不参与软目标裁剪）。
  超硬上限（`CONTEXT_MAX_TOKENS`）先**整层**收窄：删场景细节 → 删场记单 → 删检索，
  记 `degraded:['scene_detail_dropped'|'scene_sheet_dropped'|'retrieval_dropped']`；
  仍超则默认 **fail-closed**：`assembleContext()` 抛 `CONTEXT_OVER_HARD_CAP`
  （`err.meta` 含 total/hard_max/soft_max/mode/narrowed/degraded），SSE 收到 error 事件，
  **绝不把半句话送进模型**。`CONTEXT_OVER_HARD_CAP=truncate` 才回退旧行为（截断 70% +
  `degraded:['over_hard_cap']`），仅调试/应急。
- **硬上限取生效模型窗口**：`assembleContext()` 用
  `min(session.settings.context_max_tokens 或 生效 narrator 模型 contextWindow)`，
  其中 contextWindow 来自运行期模型配置（见「模型选择」）；新建会话与 `settingsFromWorld()`
  写入的 `context_max_tokens` 同样按该窗口 clamped。
- system 层先为契约/宪章/主角/常驻作者笔记预留预算；世界索引与前史只吃剩余空间，
  超了先砍索引、再丢最旧的前史行，绝不从尾部截断主角或作者笔记。
- 场记单的可选段落按整条取舍（辞书/回声少一条，不切半句）；`directive` 排在可选设定之前，
  并且逐轮 directive 同时进入尾注，避免被场记单预算丢掉。
- 在场以账本 `present`（史官声明的镜头内人物）为准；旧会话没有 `present` 时退回 `characters`。
  最近原文提到但不在场的角色只进辞书邻域/关系提示，不占完整人物卡位。
- 玩家角色永远在场（即使不在人物表里，也会造一个最小条目）。
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
// 工具：draft_append / draft_edit / draft_seal / codex_lookup / recall_history
// 工具结果只进当拍临时消息；总预算 config.narration.toolHistoryTokens（默认 1200）。
// 上游不支持 tools 时由 orchestrator 回退 runNarrator（narration.fallback='segmented'）。

// 纯函数（便于单测）
resolveNarrationMode(settings, defaultMode?) -> 'single'|'segmented'
applyDraftEdit(draft, find, replace, {all?}) -> {text, changed, count}
mergeToolCallDeltas(map, deltas) / parseToolArgs(raw) / mergeUsage(acc, next)
trimToolHistory(messages, baseLen, budgetTokens) -> removed

// 史官（每轮后）
runArchivist({ session, world, turnNo, playerText, narrative, branchChoice, options, declaredTargets, signal, guard })
// -> { applied:{assertions, assertions_invalidated, states, changes, relations, threads, voices, ledger, skipped},
//      scene_change:{changed, when, place, place_id, weather, tension, present[]},
//      uncertain, usage, stale?, parse_failed?, retried? }
// scene_change.present 是「这一拍镜头里的人物」的唯一依据；place 能对上辞书 place 时自动补 place_id。
// guard: () => boolean；false = 调用期间分支/回合已变，整批丢弃并记 patches(status='stale')。
// declaredTargets: 目标声明集合（buildDeclaredTargets() 产出）；越界提案拒写并记
//   patches(kind='skipped_targets', status='skipped', payload.items)；null = 不启用白名单。
// 解析失败：先带坏输出 + 错误回灌重问一次（buildArchivistRetryMessages，坏输出截 2000 字）；
//   仍失败返回 parse_failed:true 并写 patches(kind='archivist_parse_failed', status='failed')，
//   不落脏数据、也不静默当空提案。
buildDeclaredTargets({ card, present, codex, ledgerCharacters, playerName }) -> string[]
// codex = 本拍设定集候选（事实实体）；card 里的人与事实都进声明集合，越界写入拒收
applyArchivistUpdate({ sessionId, branchId, turnNo, update, aliasIndex, playerName, declaredTargets })   // 纯函数，可单测
parseArchivistUpdate(content)     // 容错：整体 JSON → 正则提取 → 空形状降级
parseArchivistUpdateStrict(content) // -> {ok, error, update}；只有顶层 JSON 对象才算成功（供重试/留痕）
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
runWorldTick({ session, world, turnNo, signal, guard })   // -> {events, usage, stale?}

// 成长曲线（server/world/fates.js，纯函数，不调模型）
evaluateFates(card, { turnNo, ledger, assertions, relations, charStates })
// -> {unlocked:[{who,stage,label,change,omen}], meta:{total,unlocked,skipped_by_order}}
// 条件全部用代码判定（after_turn / after_events / claims / knowledge / min_relation /
// any_of / all_of）；前一阶段没解锁时，后面的阶段都不解锁（成长是路径依赖的）。
applyFates(world, unlocked, { touched })
// 把已解锁阶段的 change 投影进 effective world；`touched` 里已由 world_state
// 显式写过的标量路径不覆盖（优先级：world_state > fates > 卡初始值）。
renderOmens(unlocked, presentNames, limit)
// -> [{who, stage, text}]  每人最多一条，进既有的「压力」段（不新增注入通道）

// 场次记忆（server/world/scene-sheet.js，纯函数）
renderSceneIndex(scenes, capTokens)
// -> {text, meta:{total, rendered, dropped, degraded}}
// 一行一场，按 importance 决定粒度；超预算从最旧端降级，再整行丢弃。
renderRecentScenes(scenes, capTokens)
// -> {text, meta:{rendered}}  最近 1–2 场的 outcome / 细节 / 因果 / 钩子

// 渲染前体检（server/memory/lint-state.js，纯函数）
lintState({ ledger, present, assertions, scenes, turnNo })
// -> {fixes, warnings, ledger, present}
// 能确定性修的（死亡角色仍在场）就地修；修不了的作为 warnings 带到台面上。
// 在副本上操作，不改调用方对象。

// 辞书检索预检（server/agents/retrieval.js）
shouldPrecheckRetrieval({ mode, codexCount, minCodex, playerText, branchChoice, card })
// auto：大卡 + 玩家文本点名了某个 codex 才跑；on/off 强制开关。
runRetrieval({ card, playerText, ledger, lastNarrative, signal })
// -> {text, queries, entries:[{id,name,why}], usage} | null
// parseRetrievalQueries(content) -> string[]（宽容解析，失败返回空数组）

// 历史检索（server/memory/recall-history.js；与 codex_lookup 同构的第五个分段工具）
// recallHistory({ sessionId, branchId, forkTurn, atTurn, query, limit, kinds, maxTokens })
// -> { text, hits:[{turn_no, kind, snippet, token_count}],
//      meta:{query, hits, limit, tokens} }
// 只读：按 branch_id 可见链（含继承的父分支，兄弟分支不可见）+ atTurn 过滤 turns 原文；
// ≥3 个 Unicode 字符走 FTS5 trigram（turns_fts 外部内容表，触发器与 turns 同步，
// 启动时按行数差 rebuild 自愈），少于 3 字走 LIKE 兜底（两字人名很常见）。
// 结果只进 retrieval 子层、当拍蒸发；不写库、不进 turns、不做自动召回/embedding
// （AGENTS §1.1/§15.4）。narrator-loop：SEGMENTED_TOOLS 第 5 个工具，由
// runSegmentedTool({recall}) 注入回调；orchestrator 用当前分支 + turnNo 接线。
// HTTP：POST /api/sessions/:id/recall-history。
// renderRecallResults(query, hits, {maxTokens}) -> string（纯函数，单测用）

// 回合原文检索（server/memory/store.js）
searchTurns(sessionId, query, { branchId, forkTurn, atTurn, limit, kinds })
// -> [{turn_no, kind, snippet, token_count}]，按时间从近到远；分支过滤规则同 getTurnsForBranch

// 分支守卫（server/memory/branch-guard.js）
branchSnapshot(sessionId, branchId?) -> {sessionId, branchId, maxTurnNo, maxTurnId} | null
isBranchCurrent(snapshot) -> boolean
guardOf(snapshot) -> () => boolean
makeEffectId(agent, ...parts) -> string
hashFingerprint(...parts) -> string（sha1；输入拼接后哈希，用于幂等指纹）
runEffectOnce(snapshot, fn, { isStale? }) -> Promise<
  { status: 'applied'|'stale'|'failed', result? } |
  { skipped: 'applied'|'stale'|'conflict'|'pending', effect_id, fingerprint }>
// fn 正常返回 -> settleEffect('applied')；guard 失效/快照过时 -> 'stale'；抛错 -> settleEffect('failed') 后重新抛
// 幂等回执（store.js）：claimEffect({sessionId,branchId,turnNo,agent,effectId,fingerprint})
//   settleEffect(sessionId, effectId, {branchId,status,turnNo,agent})
//   getEffectReceipt(sessionId, effectId, {branchId}) / listEffectReceipts(sessionId, {branchId})
//   status: pending（claim 产生）/ applied / failed / stale；同 effect_id 只落一次

// 制卡（server/agents/card-smith.js）
smithCard({ dir, title, premise, concurrency, maxChapters, startAt, openingSeed, player,
            cutoff, extract, cacheDir, cache, onProgress, signal })
// -> {card, stats:{chapters, cached, entities, persons, events, charter, ...}}
// card 直出 v5：entities[]（抽取的 character → type:'person'，其余 kind → 事实类型）
// card.source = {kind:'novel', title, chapters, canon_cutoff:'chN'}（cutoff 之后的事件写 future）
// 断点续跑缓存：指纹 = EXTRACT_VERSION + 文件名 + 文本长度/字节数/mtimeMs，按素材绝对路径分桶，
//   源文件或抽取版本变化即失效；失败章不缓存。cutoff/extract/cacheDir 只供测试注入。
// 导出（测试用）：readChapters / parseChapterExtract / buildCardFromExtracts / finalizeCard
// finalizeCard(card, { chapters, sourceTexts })：定格 pass（appearance≤60/background≤160/其余≤40、
//   exemplars 逐字校验、同章共现 links 只在事实实体之间生成、relations.to 归一到 person id）

// 运行期模型配置（server/model-registry.js）
AGENT_KEYS   // ['narrator','archivist','sceneKeeper','retrieval','continuity','librarian','worldTick','branch','cardSmith']
EFFORTS      // ['low','medium','high']
PROTOCOLS    // ['openai']（OpenAI 兼容的 /chat/completions）
getEffectiveConfig() -> {source:'db'|'env', providers(masked), models, agents, context, env, options}
// 视图永不含明文 apiKey：provider 只有 {apiKey:'', hasKey, keyHint}（末 4 位）；source='db' 表示有运行期配置
saveRuntimeConfig(body) -> 同上视图；body = {providers, models, agents}（也接受 {runtime:{...}}）
// 校验失败抛 Error{status:400, message}，不写库；成功后下一次 Agent 调用即生效
resetRuntimeConfig() -> 同上视图           // 删除 meta 表 runtime_config_v1，回到 .env 种子
resolveAgent(agentKey) -> {key, source, modelId, model, providerId, baseUrl, apiKey, protocol,
                           effort, temperature, maxTokens, contextWindow, supportsReasoning, supportsTemperature}
// 解析顺序：DB Agent 绑定 > .env（config.agents / config.upstream）> 内置默认；停用的模型/服务商回落 .env
resolveContextWindow(agentKey = 'narrator') -> number    // 生效模型的上下文窗口
resolveModelTarget({agent, model}) -> {baseUrl, apiKey, protocol, model, timeoutMs, maxRetries}
// llm.js / /v1 透传用：显式 model 覆盖名字但保留 agent 绑定的传输目标；未绑定则回落 .env
```

模型选择：Agent 调 `chat()` / `chatStream()` 时必须传 `agent: '<AGENT_KEY>'`，由 `llm.js` 调
`resolveModelTarget()` 解析服务商、密钥、模型与传输参数，并用 `resolveAgent()` 补齐未显式传入的
`temperature` / `maxTokens` / `reasoningEffort`。解析优先级为
**显式单次覆盖 > 运行期配置里的 Agent 绑定 > `.env` 种子 > 内置默认**：
Agent 函数层的 `options.model` / `options.temperature` / `options.maxTokens` / `options.reasoningEffort`
（narrator 由 `runTurn` 的 `options` 直接透传，archivist / branch 走各自的 `options.<agent>`）永远压过绑定；
未传时用 DB 绑定值，仍未保存运行期配置时逐项等于 `config.agents`（即 `<AGENT>_EFFORT` /
`<AGENT>_TEMPERATURE` / `<AGENT>_MAX_TOKENS` / `<AGENT>_MODEL`，`<AGENT>_MODEL` 留空跟随
`STEPFUN_MODEL`）。分段演绎的 `maxTokens` 取 `min(该 Agent 生效 maxTokens, SEGMENTED_ROUND_MAX_TOKENS)`。
`/v1` 透传路径没有 `agent`，`llm.js` 只解析 `model` / `baseUrl` / `apiKey` / `timeoutMs` / `maxRetries`，
不注入任何采样默认值；非流式沿用客户端 `model`（未登记的名字原样转发），流式透传原样转发请求体。
`GET /api/config` 的旧字段（`models` / `defaults` / `limits` / `budget` / `narration`）按生效配置计算，
`runtime` 字段给设置页用。

## Orchestrator 接口

```js
runTurn({ sessionId, playerText, images, branchChoice, generateBranches,
          isOpening, options:{directive}, onEvent, signal })
createSessionWithSettings({ title, settings, worldId, anchorId })   // 用锚点快照初始化账本
forkSession({ sessionId, toTurn, note })                            // 回滚 = 开新分支（同步，内部/测试）
forkSessionSafe({ sessionId, toTurn, note })                        // 路由必须走：会话锁内 fork
getSessionSnapshot(sessionId) / getMemoryStats(sessionId)   // snapshot 含 playerView（展示层投影）
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
{type:'memory', stats} / {type:'state', state, turn_no, player_view}
// state 是完整账本，仅供导出/排查；player_view 是 player-view.js 的白名单投影
// （{time, place, weather, present[]}，present 已归一为显示名）。场景信息条只读 player_view，
// 前端不得从 state 自行取展示字段——心境/目标/物品/任务/张力/last_hook 不在白名单内。
// scene_record 是 closeScene() 的返回值；when_label / place / place_id / cast 来自账本，
// 时间轴面板靠它们把「这一场发生在哪、什么时候」直接画出来，不需要再查一次库。
// scene_record = {scene_id, turn_from, turn_to, importance, when_label, place, place_id, cast[],
//                 question, outcome, key_detail, causal, hooks[], threads[], usage}
{type:'scene', scene: scene_record}
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
       // -> {models:{default, reasoning_efforts}, defaults, limits, budget, narration,   ← 旧字段，按生效配置计算
       //     runtime:{source:'db'|'env', providers(masked), models, agents, context, env, options}}
       // runtime 给设置页：providers 只有 {apiKey:'', hasKey, keyHint}，永不含明文密钥
PUT    /api/config                        body:{providers, models, agents}（或 {runtime:{...}}）
       // -> {ok:true, runtime}；全量替换运行期配置（meta 表 runtime_config_v1），下一次调用即生效
       // apiKey：省略或 '***' 保留同 id 旧值、'' 清除、其他字符串为新值；校验失败 400
       // -> {error:{message}}，不写库（空 providers/models、坏 baseUrl、未知 Agent、非法 effort 等）
DELETE /api/config                        -> {ok:true, runtime}   // 删除运行期配置，回到 .env 种子
GET    /api/fonts                         -> {fonts, source}（服务端本机字体）
GET    /api/worlds                        -> 摘要列表（顶层 persons[] / entity_count / fact_count）
GET    /api/worlds/:id                    -> {world, card, entities, sessions}
                                          // entities[] 为全部实体（含 person 与 pinned/muted）
GET    /api/worlds/:id/export             -> 纯文本
GET    /api/worlds/:id/lint               -> {issues, counts}（结构检查 + 内容充分性 +
                                             blocker：parent_cycle / duplicate_id / future_leak；
                                             counts 含 bySeverity）
POST   /api/worlds                        body:{id?, title?, card, source?}
                                             // 保存前跑 lintCard；有 blocker -> 422
                                             // {error:{message, issues:[...]}}
PATCH  /api/worlds/:id                     // 同上，blocker 拒绝保存（422）
DELETE /api/worlds/:id
POST   /api/worlds/:id/entities/:entityId/pin body:{pinned}   // -> {entities}；muted 随整卡保存
POST   /api/worlds/:id/sessions           body:{anchor_id?}

GET    /api/sessions?world_id=
POST   /api/sessions                      body:{world_id?, anchor_id?}
GET    /api/sessions/:id                  -> {session, card, world, turns, state, playerView, usage, memoryStats}
PATCH  /api/sessions/:id                  body:{scene_directive?, title?, settings?}
                                          // settings 合并写入；narration_mode:'single'|'segmented'；
                                          // status_bar:'on'|'off'（场景信息条，默认 on）
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
POST   /api/sessions/:id/recall-history   body:{query, limit?, kinds?, at_turn?} -> {query, hits, text, meta}

GET    /api/presets / GET /api/presets/:id
POST   /api/presets                       body:{id, card}（只接受 v5 卡）
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

### 场景信息条

演绎页顶部一行只读信息（时间 · 地点 · 天气，展开看在场）。

```js
import { buildPlayerView } from '../server/memory/player-view.js';   // 服务端纯函数
buildPlayerView(ledger, { persons })  // -> {time, place, weather, present[]}
```

- 前端唯一数据源是 `playerView`（GET `/api/sessions/:id`）与 SSE `state.player_view`。
- **不得**从同响应的 `state`（完整账本）自行取展示字段：白名单外的内容不出网。
- 默认显示摘要行；`settings.status_bar === 'off'` 时整条隐藏。
- 组件在 `web/js/views/play.js`（`paintStatusBar`），样式在 `chat.css` 的 `.status-strip`。

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
