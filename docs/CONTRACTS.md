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
│   │   ├── craft.js        演绎工艺层：底线 / 文风取向 / 对白形态 / 推进尺度 / 结尾落点（纯函数）
│   │   ├── craft-store.js  工艺取值表的持久化（meta 表 craft_config_v1；校验失败不写库）
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
│   │   ├── craft.js        工艺取值表编辑（GET/PUT/DELETE /api/craft）
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
  // length 可选：空 = 不限定字数（引擎不注入篇幅要求）；有值才按作者写的渲染
  // bans[] 是作者钦定的「绝对禁止」，每轮写进契约并约束走向；自由文本条目，不是逐字词表。
  craft: { craft_preset?, craft_dialogue?, pacing? },
  // 卡级默认工艺：只存三个取值 id，正文永远在 craft.js 的取值表里（不在卡里留副本）。
  // 开局时作为 settings 的兜底；会话内仍可在演绎页改。空值/非法值会被丢弃，由 resolveCraft 兜底。
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
reveal / facets.sensory` 与列表路径。人物（person）另外可写 `summary / role / mood / goal / location / life_state`
与 `voice / psyche / knowledge / agenda / relations` 的列表路径；`life_state` 只接受
`LIFE_STATES` 里的四个值，代码据此判定死亡/离场（自由文本只作 `status` 展示）。
新条目第一次 `introduce` 时可以一次写清定义。

**断言语义**：只有**单值谓词**（位于 / 是 / 曾经是）在「同主同谓、对象不同、有效期重叠」时
把旧断言 `status='invalidated'` 并记 `valid_to`，**不删除**；多值谓词（知道 / 拥有 / 想要…）
的多个对象可以并存。基数表在 `server/memory/predicates.js`。
`getAssertions(atTurn)` 按时间点回溯，不过滤 status（只排除 retracted）。

**受控词表**（`server/memory/predicates.js`，提示词 re-export）：

```js
PREDICATES = ['知道','不知道','相信','想要','害怕','拥有','位于','属于',
              '敌对','效忠','隐瞒','承诺','欠','伤害','救下','是','曾经是']
STATE_FIELDS = ['condition','mood','location','goal','life_state']
LIFE_STATES  = ['alive','injured','dead','gone']   // 死亡/离场的受控值，代码据此判定
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
// 容量检查（major）：index_overflow —— renderWorldTree(card, 1200) 后仍放不下的实体（不含 muted 事实），
//                    extra:{ids, dropped}；只是提示，不拦保存。
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
renderSceneSheet({ ledger, present, relations, threads, codex, codexBrief, voices, echoes,
                   facts, knowledgeMatrix, omens, rumors, worldRuntime, playerNow, directive,
                   absentees, capTokens })
  // codex = T0 全量事实条目，codexBrief = T1 一句；人物走 present 的 renderCastLine
  // absentees = [{name, state:'dead'|'gone', note}] —— 已故/离场者，渲染成「已故／离场：…」一行
  // rumors = [{who, what, visibility:'rumor'|'public'}] —— 世界呼吸切场推演出的幕外流言，
  //          最多渲染 2 条进既有「压力」段（`幕外：…`），不新增段落；hidden 由装配层挡掉
  // 预算：need 段（when/world/player/cast）先占，可选段后占。
  //   cast 段内部按 完整 → 紧凑(renderCastCompact) → 极简(renderCastMinimal) 降级，
  //   档位不足时截断极简文本；**cast 永不整段丢弃**（人群场不能没有在场锚点）。
  // -> {text, meta}  meta:{ present, codex, codex_brief, echoes, facts, rumors, kept[], dropped[],
  //                          codex_rendered, codex_brief_rendered, cast_mode:'full'|'compact'|'minimal',
  //                          absentees:[{name,state}], tokens }
lookupCodex(card, queries, { limit })              // 模型主动检索：遍历全部实体（含 person）
renderCodexHit(entry)                              // 单条渲染；person 额外渲染身份/口吻/性格/知识边界
```

## 工艺层接口（`server/world/craft.js` 纯函数 + `server/world/craft-store.js` 持久化）

**取值表本身是可编辑的**：内置表是兜底，数据库里可以存一份覆盖（meta 表
`craft_config_v1`）。`CRAFT_AXES` / `DEFAULT_CRAFT` 由当前生效的表**派生**，不是手写常量
——这是「前后端各抄一份清单」那个 bug 的根治办法，不要再把它们改回硬编码。

```js
import { BUILTIN, CRAFT_AXES, DEFAULT_CRAFT, resolveCraft, renderCraftBlock, CRAFT_CHECKLIST,
         normalizeCraftConfig, applyCraftConfig, craftConfigView, craftCatalog,
         normalizeCraftSettings, pickCraftSettings, pickCraftHint }
  from './world/craft.js';

BUILTIN            // 内置表快照 {preset, dialogue, pacing, defaults}，冻结；「恢复内置」的对照
CRAFT_AXES         // 派生：{ preset:[{value,label,desc,text}], dialogue:[...], pacing:[{...,tail,branch}] }
DEFAULT_CRAFT      // 派生：{ preset, dialogue, pacing } 各轴默认取值
resolveCraft(settings?, overrides?, cardCraft?)   // -> 归一后的工艺配置
  // 优先级：本拍 overrides > 会话 settings > 卡级默认（cardCraft）> 程序默认
renderCraftBlock(craft, { capTokens, includeStyle })   // -> {text, meta}
  // 取舍优先级 floor → time → style → dialogue（超 system 预算时整条丢，不留半句）
CRAFT_CHECKLIST    // 构思清单 4 问；只进分段演绎的固定尾部 user，不进 system、不占层预算

normalizeCraftConfig(raw)          // -> {tables, defaults, problems}；校验失败**整轴**回落内置
applyCraftConfig(raw, {source, extraProblems})   // 把配置装进模块状态 -> {source, problems}
craftConfigView()   // 编辑器全体：每轴带 axis/key/label/hint/where/field/default/max_options/options[]
craftCatalog()      // 抽屉骨架：{axes:[{axis,key,label,hint,default,options:[{value,label,desc}]}], source}
  // GET /api/config 的 craft 段。前端「演绎工艺」抽屉的唯一数据源，前端不得自抄清单。
normalizeCraftSettings(settings, { fill, defaults })   // 写库前归一：非法值回退默认
  // fill=true 把缺省轴补成默认（开局用），defaults 传卡级默认时优先它
  // fill=false 只校验已给的键（PATCH 用，避免用户只想改 pacing 时把另两轴一并写死）
pickCraftSettings(settings, { strict })   // 只摘三个工艺轴（同卡再开一局继承写法用）
pickCraftHint(card.craft)          // 卡级默认：只取非空且合法的轴，给 settingsFromWorld 用
```

`resolveCraft()` 返回 `{preset, name, style:{id,name,text}, dialogue, dialogueText, pacing,
pacingText, pacingBranch, floor, time, ending}`。`pacingText` 进尾注、`pacingBranch` 进走向 Agent，
两者必须共读同一个 `pacing` 值。

```js
import { initCraftConfig, saveCraftConfig, resetCraftConfig, loadCraftConfigRaw }
  from './world/craft-store.js';

initCraftConfig()          // 启动装载（index.js 在 getDb() 之后调）；存储损坏 -> 回内置 + problems
saveCraftConfig(body)      // 先校验 -> 生效 -> 最后落盘；校验失败绝不写库
                           // -> {ok:true, view} | {ok:false, error, problems}
resetCraftConfig()         // 删键 + 回内置 -> {ok:true, view}
loadCraftConfigRaw()       // JSON 坏掉时返回 {__corrupt:true}，不抛错
```

**取值表的持久化契约**：`craft_config_v1` 不存在 = 从未自定义（用内置）；
存在且合法 = 用库里的表；存在但坏掉 = 回内置并在 `view.problems` 里说明原因。
保存时**整轴**回落到内置，不做「部分生效」——作者以为改了 5 条、实际生效 3 条是最坏的结果。

| 路由 | 说明 |
|---|---|
| `GET /api/craft` | `{craft: craftConfigView(), catalog: craftCatalog()}` |
| `PUT /api/craft` | body 为 `{axis:{default, options:[{value,label,desc,text|tail+branch}]}}`；400 带 `{error:{message}, problems}` |
| `DELETE /api/craft` | 恢复内置表 |

`GET /api/config` 的 `craft` 段给**选择器**（抽屉、卡级默认下拉）用的骨架，
`GET /api/craft` 给**编辑器**用的全文；两者都来自 `craft.js` 的同一份模块状态。

## Context Engine 接口

```js
import { assembleContext, buildSystemLayer, buildContract, selectFacts, renderKnowledgeMatrix }
  from './memory/context-engine.js';

const ctx = await assembleContext({ session, world, turnNo, playerText, images,
                                    branchChoice, isOpening, directive, retrieval,
                                    previousMessages });
// retrieval        = { text, queries, entries } | null   // 模型主动检索的辞书全文（当拍）
// buildContract(session, world, card?, { craft }) — craft 缺省时按 session.settings 现算；
//   作者 `prompt.style_guide` 存在时不渲染预设文风（优先级：卡 > 预设 > 默认）。
// previousMessages = 上一轮真实发出的 messages | null     // 仅用于计算前缀复用率，不影响装配内容
// -> { messages,
//      budget:{system,archive,summary,recent,scene,retrieval,current,total},   // 本轮**实际渲染**体积；summary 恒为 0（层已移除）
//      state, ledger, anchor, recentTurns, echoes,
//      craft,   // 本轮工艺配置（resolveCraft 的结果；走向 Agent 与正文共读 pacing，保证同尺度）
//      meta:{present, mentioned, theme_tags, codex, codex_candidates,
//            codex_rendered, codex_dropped, codex_brief_candidates,
//            codex_brief_rendered, graph:{entities,edges},
//            facts, facts_candidates, facts_single, facts_many_rendered, facts_many_dropped,
//            state_fixes, state_warnings,
//            fates:{total, unlocked, omens},
//            timeline_past, timeline_future_held,
//            system_blocks:{timeline_past:{count, rendered, tokens, dropped, cap},
//                           index:{total, rendered, muted, dropped, dropped_names[<=20],
//                                  tokens, cap, mode:'tree'|'flat'},   // 世界索引覆盖率（事后统计，不参与注入）
//                           craft:{preset, style, dialogue, tokens, dropped[], capped}},  // 工艺块落位与降级
//            scene_sheet:{cast_mode:'full'|'compact'|'minimal', absentees:[{name,state}], rumors},
//            dropped_sections, branch,
//            coverage:{summary_to /* = 场次覆盖边界，保留旧名 */, recent_from, recent_to, turns,
//                      scene_count, scene_to, scene_index_rendered,
//                      scene_index_dropped, scene_index_degraded},
//            cache:{prefix_shared_tokens, prefix_shared_rate, first_divergence, system_hash,
//                   drift:{verdict,index,char_offset,left_excerpt,right_excerpt,shared_messages,
//                          prev_count,next_count}},
//            summary: null, retrieval, degraded, soft_max, hard_max,
//            plan:{window, output_reserve, safety, hard_max, soft_max, auto_soft,
//                  layers:{system,archive,archiveDetail,recent,scene,retrieval,current}, shares:{...}},
//            recall:{total, visible, rate, by_type:{<type>:{visible,total}}},
//            hard_cap:{mode:'fail'|'truncate', narrowed:['scene_detail'|'scene_sheet'|'retrieval']},
//            messages:[{index, role, owner, tokens}]}} }
```

装配顺序（缓存友好）：**冻结前缀 → 只追加历史 → 易变尾部**

```
1. system   契约（含工艺块：通用底线 + 时间流速 [+ 预设文风/对白形态]）+ 命题 + 宪章 + 世界索引
            + 前史（canon=past）+ 主角 + 作者笔记（**只读模板快照，绝不读运行态**）
2. user     【本局场次索引】一行一场，只追加
3. …        当前场次逐字原文 = 上一场 turn_to + 1 起，到本轮之前（player/assistant 交替）
4. user     【刚才这一场怎么收的】最近 1–2 场细节
5. user     场记单（T0 全量设定 + T1 一句邻域 + 在场者 voice + 断言 + 知识矩阵；每场变一次）
6. user     【检索结果】（模型主动查阅的辞书全文，当拍蒸发）
7. user     本场指令 + 本轮行动 + 尾注（含【推进尺度】【怎么收尾】）
```

**工艺层落位（`server/world/craft.js`）**：三个可单选的轴——`preset`（文风取向，见
`CRAFT_AXES.preset`）· `dialogue`（对白形态）· `pacing`（推进尺度）。取值来自会话
`settings.craft_preset / craft_dialogue / pacing`，非法值回退默认（不静默生效）。
优先级恒定：**世界卡 `prompt.style_guide` > 工艺预设 > 程序默认**（作者写了文风，
预设文风就不渲染，避免同一层两套写法互相打架）。

- `preset` / `dialogue` 只影响 system，必须**整会话恒定**（每拍可变会破坏 system 的缓存前缀）。
- `pacing` 只进尾注与走向 Agent，可按拍不同语义使用；它同时决定 `branch` 选项的风险水位——
  narrator 推多少、branch 给多险的选项必须同尺度，否则「选项温和、正文翻盘」。
- 工艺块受 system 预算约束，超了按 `floor → time → style → dialogue` 的**优先级**整条丢
  （阅读顺序仍是 底线→文风→对白→时间流速），绝不留半句；结果记 `meta.system_blocks.craft`。
  之所以允许丢：世界索引是 canon，工艺是可选的表达层——挤掉索引换文风是错的。

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

`meta.plan` 是**本轮预算规划**（`server/memory/context-plan.js` 纯函数 `planContext()` 推导）：
`window` 生效 narrator 模型窗口、`output_reserve` 生成预留（narrator.maxTokens，上限 window/4）、
`safety` 安全余量、`hard_max` 提示词硬上限 = window − output_reserve − safety、
`soft_max` 软目标（`CONTEXT_SOFT_TOKENS=0` 时自动取 hard_max × 55%）、`auto_soft` 是否自动、
`layers` 各层配额、`shares` 职责份额。换模型即换预算，**没有独立的 BUDGET_* env 常量**。
`budget`（实际渲染体积）与 `plan.layers`（配额）是两回事，排查时对照着看。

`meta.recall` 是**实体召回率**：统计卡内实体 `name` 子串在本轮整条 messages（system +
场次索引 + 原文 + 场记单 + 检索）里出现的数量，返回 `{total, visible, rate, by_type}`。
近似指标，只进 `turns.meta_json`；世界索引的完整渲染情况另有 `meta.system_blocks.index`。

`buildSystemLayer(...)` 返回 `{ text, meta:{ index_coverage, craft } }`（不再是裸字符串）。
`craft` 是工艺块的落位证据 `{preset, style, dialogue, tokens, dropped[], capped}`
（`dropped` 是在 system 预算不足时被整条丢掉的部分，`capped` = 有丢弃）。
`index_coverage` 是世界索引的覆盖率事后统计：`total` 卡内实体数、`rendered` 名字出现在
最终索引文本里的实体数、`muted` 被静音的设定集条目数、`dropped` 未出现的数量、
`dropped_names`（最多 20 个，便于排查）、`tokens` / `cap` / `mode:'tree'|'flat'`。
它只用于 `meta.system_blocks.index` 审计，**不是第二次实体匹配注入**——系统层内容仍完全由
`renderWorldTree`/`renderWorldIndex` 的决定性渲染产生。

`meta.system_blocks.timeline_past` 是**前史块**的落位证据 `{count, rendered, tokens, dropped, cap}`。
前史 = 模板卡里 `canon === 'past'` 的 timeline 事件，由 `renderTimelinePast()` 渲染成
「【前史】开局之前已经发生的事实」一行一条，`buildSystemLayer()` 把它排在世界索引之后、
主角之前。硬约束：

- 只读 `session.card_snapshot`，**不读 world_state / scenes**：system 必须在连续 10 轮里逐字节不变。
- `canon === 'future'` / `'branch'` **永不渲染**（红线 3：future 只作改编卡的校勘参考，
  既不是既定事实，也不是演绎目标）；提示词里不出现 future 事件或「必达节拍」指令。
- 前史与世界索引**共享 system 预算**：前史先按 `max(240, system 配额 × 10%)` 从最新往前取
  （塞不下的旧行整条丢弃，不切半句），索引再吃剩余空间；绝不挤掉契约/宪章/主角/常驻作者笔记。

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
  超硬上限（`meta.plan.hard_max`）先**整层**收窄：删场景细节 → 删场记单 → 删检索，
  记 `degraded:['scene_detail_dropped'|'scene_sheet_dropped'|'retrieval_dropped']`；
  仍超则默认 **fail-closed**：`assembleContext()` 抛 `CONTEXT_OVER_HARD_CAP`
  （`err.meta` 含 total/hard_max/soft_max/mode/narrowed/degraded），SSE 收到 error 事件，
  **绝不把半句话送进模型**。`CONTEXT_OVER_HARD_CAP=truncate` 才回退旧行为（截断 70% +
  `degraded:['over_hard_cap']`），仅调试/应急。
- **硬上限从模型窗口推导**：`hard_max = 生效 narrator 模型 contextWindow − 生成预留 − 安全余量`
  （见 `meta.plan`）；会话 `settings.context_max_tokens` 只能**收紧**该上限
  （`hardMax = min(sessionMax, window − 生成预留 − 安全余量)`），不能突破生成预留；
  新建会话与 `settingsFromWorld()` 写入的 `context_max_tokens` 同样按该推导上限 clamped。
- 各层配额 = 软目标 × 职责份额（system 32% / archive 30% / archiveDetail 6% / scene 22% /
  retrieval 4% / current 6%）；`recent`（40%）只是强制封场的规划上限，**不裁原文**。
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
//      meta:{query, hits, limit, tokens, engine:'fts5'|'like'|'none'} }
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
searchTurnsDetailed(sessionId, query, {…同上}) -> { hits:[…], engine:'fts5'|'like'|'none' }
// engine 供 recall_history 的 meta 自报「这次到底走了哪条检索路」，不参与排序。

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
`GET /api/config` 的旧字段（`models` / `defaults` / `limits` / `budget` / `budget_shares` / `narration`）
按生效配置与当前模型窗口推导，`runtime` 字段给设置页用。

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
       // -> {models:{default, reasoning_efforts}, defaults, limits, budget, budget_shares, narration,  ← 旧字段，按生效配置计算
       //     runtime:{source:'db'|'env', providers(masked), models, agents, context, env, options}}
       // budget / budget_shares：由 context-plan.js 从模型窗口推导的各层配额与职责份额（不是 env 常量）
       // limits：{context_max_tokens(=plan.hardMax), context_soft_tokens(=plan.softMax),
       //          context_window_tokens, context_output_reserve_tokens, narrator_max_tokens}
       // runtime.context：{window_tokens, output_reserve_tokens, hard_max_tokens, soft_target_tokens,
       //                   auto_soft, layers, shares, model_id, model}
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
POST   /api/worlds/:id/sessions           body:{anchor_id?, settings?}
                                          // 工艺三轴（craft_preset / craft_dialogue / pacing）取值的
                                          // 优先级：本请求 settings > 这张卡最近一局的继承值 >
                                          // 卡级默认（card.craft，作者在编辑器「默认演绎工艺」里选）
                                          // > 程序默认。非法值归一成默认（normalizeCraftSettings）。
                                          // 其余会话参数（context_max_tokens 等）不跨局继承。

GET    /api/sessions?world_id=
POST   /api/sessions                      body:{world_id?, anchor_id?}
GET    /api/sessions/:id                  -> {session, card, world, turns, state, playerView, usage, memoryStats}
PATCH  /api/sessions/:id                  body:{scene_directive?, title?, settings?}
                                          // settings 合并写入；narration_mode:'single'|'segmented'；
                                          // status_bar:'on'|'off'（场景信息条，默认 on）
                                          // 工艺三轴只校验已给的键，不把未涉及的轴写死。
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
PATCH  /api/sessions/:id/turns/:turnNo    body:{kind?:'player'|'narrator', content}
                                          // 手工改正文（红线 4 的唯一例外）。缺省 kind='narrator'；
                                          // content 去空白后为空 -> 400；回合不存在 -> 404。
                                          // 只改 turns.content 并置 edited，**不自动重跑记忆**
                                          // （场次/断言仍是旧正文抽出来的，需要时手工重跑）。
                                          // -> {turn}

GET    /api/presets / GET /api/presets/:id
POST   /api/presets                       body:{id, card}（只接受 v5 卡）
POST   /api/presets/:id/import
GET    /api/smith/materials
POST   /api/smith/preview                 -> SSE  body:{dir, title, premise, max_chapters}
POST   /api/smith/save                    body:{id?, card}
```

### OpenAI 兼容层（`/v1`，`server/routes/openai.js`）

不带 `session_id` 时是**透传**，带 `session_id` 时跑 orchestrator。

```
GET  /v1/models            -> {object:'list', data:[…]}
                            // 运行期配置里 enabled 的模型 + 两个 roleplay 虚拟模型
                            // ('roleplay-narrator' / 'roleplay-branch')，按 id 去重
POST /v1/chat/completions
  无 session_id  -> 透传上游（流式直接 pipe SSE，不经过 chatStream）
                    // sanitizeBody() 负责剥掉本项目自定义字段：
                    // session_id / settings / generate_branches / branch_choice /
                    // roleplay / world_id / is_opening / directive
                    // model 缺省时用运行期配置补；采样字段只在客户端显式给了才转发
  有 session_id  -> 跑 runTurn()；正文作 content，推理作 reasoning_content/reasoning，
                    走向附在正文末尾（也作纯文本，否则通用客户端看不到）
                    // session_id === 'new' | 'auto'，或给了 settings 且该 id 不存在 -> 先建会话
→ {error:{message, type?, code?}}（复用 OpenAI 错误形状）
```

**新增自定义请求字段时必须加进 `sanitizeBody()` 的解构名单**，否则会被原样转发给上游。
新增 SSE 事件时，如果对 `/v1` 客户端有意义，还要同步这里的流式翻译。

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
