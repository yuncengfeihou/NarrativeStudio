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
│   │   ├── patch-apply.js  提案的人工确定性动作（/apply：合并别名、真的改账本）
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
  player: { mode: 'original|canon', canon_character, name, …, money, knowledge },
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

**一个回合的两行原子写入**（D31）：`addTurnPair(sessionId, [playerTurn, narratorTurn])` 在一个
事务里写，要么都写、要么都不写。玩家行动过去在演绎之前单独 `addTurn`，上游 `terminated` /
`fetch failed` 时库里就留下一条没有正文的 player 行（孤儿回合）——它进不了场次原文（场记只读
narrator 行），却作为一条没有回应的 user 消息留在库里，只能靠 `_work/longrun-drive.mjs --repair`
删行收拾。正文没产出的那一拍在账本上不该发生。`addTurn` 仍保留（测试与工具用），单行写入。

**分支隔离**：`states / relations / threads / character_states / assertions / voices /
scenes / world_state` 都带 `branch_id`。`forkSession()` 采用 copy-on-fork：把分叉点仍有效的
状态复制到新分支，新分支不会读到旧线在分叉点之后写下的任何内容。

**记录都是可回滚的（D33）**：`forkSession()` 从任意一轮开新线，`checkoutBranch()` 切回任意
一条已有线继续写。两者都不删行——旧线标 `abandoned`、切回去时重新标 `active`，回合、场次、
断言、账本全都留在原处。**可见回合数是派生值** `countVisibleTurns(sessionId, branchId)`
（按祖先链 + `fork_turn` 算），`sessions.turn_count` 只是缓存：换线后必须用派生值覆盖它，
否则界面上会显示旧线的回合数，而实际能看见的只有分叉点之前的几轮。

复制时会把 `valid_to` **裁到 `fork_turn`**：旧线在分叉点之后才发生的失效，在新线上从未发生。
不裁的话，新分支往回走一步就多出一批「未来才会失效」的状态，`atTurn` 查询会返回空集——
比没有记忆更糟，因为它自相矛盾。

`relations` / `threads` 的当前表只保留最新值，所以另有两张追加式历史表
`relation_events` / `thread_events`。fork 时复制 `turn_no <= fork_turn` 的事件，再按
「每个键最后一条事件」重建当前表；分叉点之后才建立/更新/回收的关系与线索不会进入新分支。

**线索（`threads`）有 WIP 上限，且与渲染容量共读一个常量**（AGENTS §5.3）：
`scene-sheet.js` 的 `THREAD_RENDER_MAX`（= 场记单线索段的渲染条数）**同时是账本上限**。
史官新埋（`plant` 且此前不存在的标题）时两条确定性拒绝：`weight < THREAD_MIN_WEIGHT`
或 `open 条数 >= THREAD_RENDER_MAX`。被拒项不静默丢——合并成一条
`patches(kind='thread_rejected', status='rejected', payload:{total, wip_limit, items[]})`，
`payload.items[].reason ∈ 'low_weight' | 'wip_full'`。`resolve` 永远允许（它只会减少条数）。
阈值**不作用于卡内 `seeds`**：`anchors`/`seeds` 播种走 `upsertThread` 直写，作者标 0.55 也算数。
`getThreads(limit: -1)` 表示不设上限（校勘靶池用它）。

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

**`getVoiceMap()` 的上限是「每人 perWho 条」，不是「全局前 N 行」**（D23）：
旧实现 `getVoices(limit: 400)` 再在内存里按人切，那 400 是**跨所有人的全局窗口**，
长跑会顶穿——实测每拍新增 4.88 行，第 82 拍填满 400 行，之后窗口只保留「最近 82 拍里
说过话的人」，久没开口的角色（谢沐 t7、陆可 t31）整段掉出声线表、口吻锚点永久消失，
而 `layers_truncated` 里连 voices 这个键都没有。现在用 `ROW_NUMBER() OVER (PARTITION BY who
ORDER BY pinned DESC, turn_no DESC, id DESC)` 在 SQL 里按人分区取前 N 条，与总行数无关。
**判据**：`getVoices` 的 `limit` 只服务于「面板列表」这类按时间排的全量视图，
任何「按角色取最近 N 条」的读都必须走 `getVoiceMap`；把 `limit: 400` 这类全局窗口
塞进装配路径 → 违律。

**world_state 是运行期世界变化的唯一写入口**：`entity_kind` 为实体类型（`person` / `place` / `institution` / `item` / `faction` / `concept` / `custom`）或 `player | world`，
`op` 为 `set | add | remove | introduce | delta`，路径白名单在 `server/world/state-paths.js`。
身份根（id / name / identity / voice）不可写。`buildEffectiveWorld(cardSnapshot, deltas, fates)` 把
模板、增量与已解锁的成长阶段投影成当轮有效的世界（优先级：`world_state` > `fates` > 卡初始值）；
上下文引擎只读投影结果，永远不把运行期状态写回 `card_json`。

**数值路径与 `delta`**（`NUMBER_PATH_SET` / `isNumberPath(kind, path)`）：只有白名单里的数值路径
（当前仅 `player.money`）允许 `op='delta'`——模型只声明「这一拍变了多少」，加减由代码做，
模型不再自己算余额。路径是不是数值**由白名单决定，不由模型吐出的字面量类型决定**；`NUMBER_PATH_SET`
与 `LIST_PATH_SET` 不相交。非数字值、空串、`null` 一律整条拒绝（`Number('') === 0` 会把
「没写金额」误记成「余额归零」），reason=`not_a_number`。
**结果为负时照常写入**（D11）：推一条 `EffectiveWorld.overdrafts`
（`{path, op, delta_id, turn, value, prev, next}`，只供装配/编排层读、不进提示词、不占预算），
由 `orchestrator` 落成 `patches(kind='overdrawn', status='applied')` 审计；
场记单渲染成「银钱 欠 N」。**曾经的「负数整条拒绝」是错的**：`prev=0` 时任何负数必被拒、
被拒又不改基准 → 余额永久卡 0，而模型看不见余额也看不见被拒 → 50 拍里正文与账本公开矛盾 19 拍，
唯一解开的一次是史官偶然用了 `op='set'`。红线 10 反对的是**静默**失真（clamp 成 0），
不是「负」——把负数渲染出来是让事实可见，所以 `rejected_delta` 现在只剩 `not_a_number` 一种 reason。
玩家银钱经 `renderSceneSheet({playerNow})` 的「主角此刻｜银钱 N」每拍可见。

**实体定义与运行态分离**：`summary / detail / facets.history` 是作者公理，已有事实实体运行期不可写
（`FACT_CANON_PATHS`）；运行期只写 `status / condition / access / open_to / owner_id / location_id /
reveal / facets.sensory` 与列表路径。人物（person）另外可写 `summary / role / mood / goal / location / life_state`
与 `voice / psyche / knowledge / agenda / relations` 的列表路径；`life_state` 只接受
`LIFE_STATES` 里的四个值，代码据此判定死亡/离场（自由文本只作 `status` 展示）。
新条目第一次 `introduce` 时可以一次写清定义。

**主角路径的确定性别名（2026-10-31，D35 噪声收敛）**：`normalizePlayerChange({path, op})` 与模块内常量
`PLAYER_PATH_ALIASES` 在 `server/world/state-paths.js`。史官会把主角当 person 写
（`psyche.wants` / `psyche.fears` / `psyche.afraid`）、也会在标量字段上用 `op='add'`；
提示词已写明「主角是 player、动机字段是扁平的 `wants` / `afraid`」，45 拍实测仍被挡 19 条。
归一是确定性的（同一个人、同一个字段，语义不变）：`psyche.wants` → `wants`，
`psyche.fears` / `psyche.afraid` → `afraid`，`wants` / `afraid` 上的 `add` → `set`（标量没有追加）。
`remove` 不猜（清空标量的意图不明确），继续按 `op_path_mismatch` 拒；主角没有的路径
（`psyche.hides`、`life_state`）仍被白名单拒。归一在 `sanitizeChange` 里发生、照常过白名单，
返回值带 `path_from` / `op_from`，落库时汇总成 `patches(kind='path_aliased')`（见史官一节）。

**目标名的前后缀归一（2026-10-31，D13 噪声收敛）**：同一件东西被模型换了称呼时（卡/运行期
实体叫「旧围棋盒」，提案写「围棋盒」），`sanitizeChange()` 在 `resolveEntity` 与
`linkEntities` 都失败后，用 `affixDeclaredMatch(name, declaredSet)` 尝试唯一匹配。
规则是**拒绝优先**的：

- 只拿 `declaredTargets` 里的**规范名**比，且只认「提案名是声明名的前缀或后缀」
  （`旧围棋盒`.endsWith(`围棋盒`)）；反方向不认（「黑色无牌车」不并到「黑色」）。
- 两边都要 ≥2 字，且必须**唯一命中**；多命中/无命中一律保持拒绝，仍记
  `patches(kind='skipped_targets')`。
- 命中时返回值带 `target_from`（模型原本的写法），落库照常过白名单，并汇总成一条
  `patches(kind='target_aliased', status='applied', severity='info', payload={count, items})`。
  报告把它和 `skipped_targets` 并排读：「被拒变少」可能只是代码开始吸收，不是模型不换称呼了。
- 实测分布（9 局 94 条被拒）：74 条无任何匹配（模型给没 introduce 过的道具记账，拒得对）、
  12 条可归一（围棋盒/药罐/提亲帖/侍从官/竹院/嘉桌/马灯…）、其余多命中或过短。

**路径白名单按实体真实类型取（D34）**：`applyDelta` 解析出目标实体后，用
`entity.type`（而不是 `delta.entity_kind`，即模型这一拍声明的类型）去查 `pathsFor()`；
与「路径是不是数值由白名单决定、不由模型吐出的字面量类型决定」同源。
配套的两件事：

- **同名条目升级**：`op='introduce'` 声明 `person`、按 `id`/`name` 撞上卡里**非人物**条目时，
  投影里把它换成完整人物骨架（`emptyPersonEntry` + 保留 `summary/detail/facets/role/aliases/
  tags/links/...`），并记 `EffectiveWorld.promotions`（`{id, name, from, to, turn, delta_id}`）
  → `patches(kind='entity_promoted', status='applied')`。**卡模板不动**，只改会话投影；
  只升不降（`introduce` 声明非人物撞上 person 不降级）。
  为什么不能只改 `type`：概念条目没有 `voice/psyche/knowledge/identity`，场记单渲染会直接抛
  `TypeError: Cannot read properties of undefined (reading 'rhythm')`。
- **被挡的写入必须留痕**：白名单不接受的路径记 `EffectiveWorld.dropped_deltas`
  （`{entity_kind, entity_type, entity_id, path, op, turn, delta_id}`）
  → `patches(kind='dropped_delta', status='failed')`。`entity_kind ≠ entity_type` 就是
  「类型判错了」的直接证据。**与 `rejected_deltas` 分开**：那是「值非法」，这是「路径不被允许」。
  两者都不进提示词、不占预算。

**玩家（kind=`player`）没有 `life_state`**（D14）：主角不会「这一场不在镜头里」，
他离场整场戏就结束了；这条路径没有任何消费方（`absentees` 只挑 `type==='person'`），
放行只会让 `card.player.life_state` 永久停在某个值。史官对玩家写它会因白名单拒绝
并记 `patches(kind='skipped_targets')`。人物（person）的 `life_state` 不受影响。

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
  buildWorldGraph, graphNeighbors, graphAncestors,
} from './world/graph.js';
import { lintCard } from './world/lint.js';

buildWorldGraph(card)
// -> { entities:Map, edges[], aliasToId:Map, entityById:Map, personById:Map,
//      adjacency:Map, resolve(ref) }
graphNeighbors(graph, ids, { depth })   // -> Set<entityId>（1 跳/多跳邻域）
graphAncestors(graph, id)                // -> string[]（由 parent_id 决定的祖先链）
lintCard(card)
// -> {issues:[{severity:'blocker'|'major'|'minor'|'info', code, message, ids?}],
//     counts:{entities, persons, facts, edges, issues, bySeverity:{blocker,major,minor,info}}}
// 结构检查：断链/别名冲突/包含环/孤立实体/单值声明冲突；
// 容量检查（major）：index_overflow —— renderWorldTree(card, 1200) 后仍放不下的实体（不含 muted 事实），
//                    extra:{ids, dropped}；只是提示，不拦保存。
//                    seeds_over_thread_capacity —— seeds 条数 > THREAD_RENDER_MAX，多出来的开局看不见。
// 容量提醒（minor）：seeds_eat_runtime_room —— seeds 条数没超容量，但占掉了额度：
//                    THREAD_RENDER_MAX - seeds.length <= 2 时提示，extra:{seeds, runtime_room}。
//                    说明本局运行时最多还能新挖几条；不改上限，只是让作者看见这个交换。
// 内容检查（info）：person_incomplete（缺 appearance/summary/rhythm）、person_hollow（wants+hides 全空）、
//                  fact_incomplete（缺 summary/facets）
// 阻断项（blocker）：parent_cycle、duplicate_id、future_leak（有 source.canon_cutoff 时 past 事件章号 ≥ cutoff；来源不可解析则不猜）
```

## Scene Sheet 接口（纯函数）

```js
import { renderWorldIndex, renderWorldTree, selectCodex, renderSceneSheet,
         THREAD_RENDER_MAX, THREAD_MIN_WEIGHT } from './world/scene-sheet.js';

// THREAD_RENDER_MAX  = 8  —— 场记单「线索」段最多渲染几条；**同时是线索账本的 WIP 上限**。
//   两处必须共读这一个数：上限大于渲染容量等于「埋了但看不见」（AGENTS §5.3）。
// THREAD_MIN_WEIGHT  = 0.6 —— 运行时新埋线索的最低权重；低于它不落库（卡内 seeds 豁免）。

renderWorldIndex(card, capTokens, { skipIds })     // 人物段 + 设定集段；超配额降级为只留名字
renderWorldTree(card, capTokens, { skipIds })      // 有 parent_id 时按包含关系折叠；没有时退回 renderWorldIndex
renderTimelinePast(card, capTokens)                // 前史（canon='past'）一行一条；future/branch 永不渲染
selectCodex(card, { presentIds, mentionedIds, threadTags, pinnedIds, currentPlaceId, skipIds })
  // 只在事实实体里选（人物由在场判定带出）；-> [{entry, score, why[]}]
  // 实体连接 60 / 主题标签 30 / 钉选 100 / 当前地点 20；muted 条目不进入候选（静音 ≠ 删除）
renderSceneSheet({ ledger, present, relations, threads, codex, codexBrief, voices,
                   facts, knowledgeMatrix, omens, rumors, worldRuntime, playerNow, directive,
                   absentees, capTokens, relationLimit })
  // 回声（echoes）段已删除（D18）：它是「原声：」行的逐字复制（76 拍 278/278 条 100% 重复），
  //   轮次信息已由 renderCastLine 的「原声：第N轮…」承担。不要再把回声段加回来。
composeSheetText(headText, sections)               // 用同一份 head + 选中的段重拼场记单正文（D26-B）
  // 唯一用处：给旁路 Agent 一个「同一张单子少一段」的版本。必须复用 head/sections 重拼，
  //   不能在旁路再渲染一份——那样字数和取舍都会变，A/B 对比不成立。
  // codex = T0 全量事实条目，codexBrief = T1 一句；人物走 present 的 renderCastLine
  // absentees = [{name, state:'dead'|'gone', note}] —— 已故/离场者，渲染成「已故／离场：…」一行
  // rumors = [{who, what, visibility:'rumor'|'public'}] —— 世界呼吸切场推演出的幕外流言，
  //          最多渲染 2 条进既有「压力」段（`幕外：…`），不新增段落；hidden 由装配层挡掉
  // 预算：need 段（when/world/player/cast）先占，可选段后占。
  //   cast 段内部按 完整 → 紧凑(renderCastCompact) → 极简(renderCastMinimal) 降级，
  //   档位不足时截断极简文本；**cast 永不整段丢弃**（人群场不能没有在场锚点）。
  // 线索段：只渲染 status==='open' 的前 THREAD_RENDER_MAX 条（weight>=0.8 打「［主线］」；
//   planted_turn===0 的卡内 seeds 另打「预置」，合成「［主线·预置］」或「［预置］」）。
//   标注只加在行尾，不新增段、不占新预算——它区分「作者预埋」与「本局挖出」，
//   两者抢同一块渲染容量但回收时机不同（D5 可见性）。
  //   渲染条数与账本 WIP 上限共读一个常量，不要在此处写死数字。
  // 事实段**不在这里切片**（D9）：条数由装配层的 facts_many_limit（按 scene 配额推导）决定，
  //   本函数只负责「整条退让」——装不下就整段降级/丢弃，记进 meta.kept/dropped。
  //   历史上这里有一个 `.slice(0, 24)`，它与装配层的 manyLimit=10 互相遮蔽：
  //   只改装配层会被它砍回 24，只改它则永远碰不到（总数本来就 ≤24）。不要再补回来。
  // 关系段同理（D17）：本函数不再写死 `.slice(0, 8)`，条数由 relationLimit 决定
  //   （装配层 = max(8, floor(scene 配额 × 15% ÷ 34.5))）；排序先「两端都在场」再按调用方
  //   传入的 |sentiment| 顺序（稳定排序，组内顺序不变）。历史上只渲染 8 条、排序键不含
  //   「谁在场」，42 条过场关系只有 11 条曾露过面，而关系段只占场景层配额的 1.6%。
  // 银钱为负渲染成「银钱 欠 N」（D11），不是「银钱 -N」也不是省略。
  // -> {text, meta, head, sections}  meta:{ present, codex, codex_brief, facts,
  //                          facts_rendered, relations_rendered, rumors,
  //                          kept[], dropped[], codex_rendered, codex_brief_rendered,
  //                          cast_mode:'full'|'compact'|'minimal', absentees:[{name,state}], tokens }
  // facts_rendered = 事实段**实际渲染**的行数（= 装配层 facts_many_limit 与预算共同作用的结果），
  //   装配层用它填 meta.facts；reads 的 facts 是候选数，别混。
  // head / sections（D26-B）= 拼出 text 的两块原料。旁路 Agent 要用「少一段」的版本时，
  //   拿这两个字段交给 composeSheetText 重拼，不要自己再调一次本函数。
  // voice_speakers / voice_lines / voice_present_covered（D23）= 声线表里有几条可用台词、
  //   覆盖了几个在场者。`voices` 由 getVoiceMap 按人分区取 perWho 条（不是全局窗口），
  //   渲染端再 slice(0, 2)；所以「在场者里有几个根本没有声线锚点」是这里能回答的唯一问题。
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
import { assembleContext, buildSystemLayer, buildContract, selectFacts, renderKnowledgeMatrix,
         overlapWindowFrom, recallVisibleFrom,
         resolveBranchSheetTrim, selectBranchSections }
  from './memory/context-engine.js';

// 原文窗口起点（装配层与检索层共读一个函数，不许各写一份规则）：
//   overlapWindowFrom(sceneCoveredTo, turnNo, overlapTurns) -> recent_from
//   recallVisibleFrom(...) 同签名同实现，语义是「检索不该搜上下文已经看得见的那几拍」。
//   起点 = max(1, min(scene_to + 1, turnNo − overlap))：晚于 scene_to+1 是洞（违律），
//   早于它是有意的重叠。写成 max 会随场长把当前场原文从中间切掉。
//
// 走向版场记单的裁剪档位（D26，会话级开关，默认不变）：
//   resolveBranchSheetTrim(settings) -> 'default' | 'core_only'
//     读 settings.branch_sheet_trim；缺省/非法一律回 'default'（写错一个词不改文风）。
//   selectBranchSections(sections, trim) -> sections[]
//     'default'   = 去掉 codexBrief（与旧实现逐字节等价）
//     'core_only' = 只留 when/world/player/cast/relations/threads/pressure/directive
//     两者都只是对同一份 sections 做 filter，**不重新渲染**——重渲染连字数取舍都会变，
//     A/B 就不再是「只差被删的段」。
//   落点：返回值的 branchSheet 与 meta.scene_sheet.branch_sheet.trim / dropped_sections。
//   这是实验开关，不是新注入通道：送模那份场记单逐字节不变。

const ctx = await assembleContext({ session, world, turnNo, playerText, images,
                                    branchChoice, isOpening, directive, retrieval,
                                    previousMessages });
// retrieval        = { text, queries, codex_queries, history_queries,
//                      entries, history_hits, tokens:{codex,history},
//                      history_self_echo, exclude_from } | null
// branchSheet = 给走向 Agent 的场记单：与送模那份逐字节相同，但按会话档位裁段（D26）。
//   settings.branch_sheet_trim = 'default'（缺省）只去 codexBrief；'core_only' 再去
//   facts / knowledge / codex（方案 A 实验臂）。没有场记单时为空串。
//   meta.scene_sheet.branch_sheet 记 {trim, dropped_sections, tokens, full_tokens}。
//                   // 模型主动取证：辞书全文 + 历史原文片段（两者都在当拍蒸发，不落库）
//                   // exclude_from = runRetrieval 传下来的检索下界（D4 修法 ①）：
//                   //   最近这场原文已经在 recent 层看得见，再搜一遍只会「自问自答」。
//                   // history_self_echo = 那些正好是玩家本拍原话子串的 history 查询词，
//                   //   空查询 / 自问自答占比是 D4 的效果判据（见 meta.retrieval）。
// buildContract(session, world, card?, { craft }) — craft 缺省时按 session.settings 现算；
//   作者 `prompt.style_guide` 存在时不渲染预设文风（优先级：卡 > 预设 > 默认）。
// previousMessages = 上一轮真实发出的 messages | null     // 仅用于计算前缀复用率，不影响装配内容
// -> { messages,
//      budget:{system,archive,summary,recent,scene,retrieval,current,total},   // 本轮**实际渲染**体积；summary 恒为 0（层已移除）
//      state, ledger, anchor, recentTurns, branchSheet,
//      craft,   // 本轮工艺配置（resolveCraft 的结果；走向 Agent 与正文共读 pacing，保证同尺度）
//      meta:{present, mentioned, theme_tags, codex, codex_candidates,
//            codex_rendered, codex_dropped, codex_brief_candidates,
//            codex_brief_rendered, graph:{entities,edges},
//            facts, facts_candidates, facts_single, facts_many_rendered, facts_many_dropped,
//            facts_many_limit,   // 多值谓词的渲染上限 = max(10, floor(scene 配额 × 25% ÷ 12.4))
//                   // 每拍实测：一条事实约 12.4 tok；这个数**由预算推导**，不是常量（D9）。
//                   // 曾同时存在 manyLimit=10 与渲染端 slice(0,24) 两道写死的闸，
//                   // 51 拍实测可见率 100% → 16.8%（216 条候选 → 渲染 27 条），
//                   // 而场景层配额只用了 26%。两道闸互相遮蔽，只改一道看不出变化。
//                   // 现在只剩「预算」一道：renderSceneSheet 不再 slice，facts 是可选段，
//                   // 装不下按整条退让（meta.scene_sheet 记 kept/dropped_sections）。
//                   // 判据：facts_many_rendered 应随 scene 配额走；若它恒等于 10 或 24，就是回退了。
//            relations_limit, relations_rendered,
//                   // 关系段的渲染上限 = max(8, floor(scene 配额 × 15% ÷ 34.5))（D17）。
//                   // 关系段只占场景层配额的 ~5%，所以上限远大于 8（200K 窗口下是 97）。
//                   // 判据：relations_limit 若恒等于 8，就是回退成「写死条数」；旧会话没有这个字段。
//            state_fixes, state_warnings,
//            fates:{total, unlocked, omens},
//            timeline_past, timeline_future_held,
//            system_blocks:{timeline_past:{count, rendered, tokens, dropped, cap},
//                           index:{total, rendered, muted, dropped, dropped_names[<=20],
//                                  tokens, cap, mode:'tree'|'flat'},   // 世界索引覆盖率（事后统计，不参与注入）
//                           craft:{preset, style, dialogue, tokens, dropped[], capped}},  // 工艺块落位与降级
//            scene_sheet:{cast_mode:'full'|'compact'|'minimal', absentees:[{name,state}], rumors,
//                         branch_sheet:{trim, dropped_sections, tokens, full_tokens}},  // 走向版裁剪（D26）
//            dropped_sections, branch,
//            coverage:{summary_to /* = 场次覆盖边界，保留旧名 */, recent_from, recent_to, turns,
//                      overlap_turns /* 与场次索引重叠的拍数，D1 */, overlap_limit,
//                      scene_count, scene_to, scene_index_rendered,
//                      scene_index_dropped, scene_index_degraded},
//            cache:{prefix_shared_tokens, prefix_shared_rate, first_divergence, system_hash,
//                   drift:{verdict,index,char_offset,left_excerpt,right_excerpt,shared_messages,
//                          prev_count,next_count}},
//            summary: null, degraded, soft_max, hard_max,
//            retrieval:{   // 资料员这一拍做了什么；**没出文本也留痕**（否则「没触发 / 触发了没查 /
//                          // 查了没命中」三种状态全被抹成 null，比例失去分母）
//              rendered, queries, entries, tokens,
//              codex_queries, history_queries, codex_tokens, history_tokens,
//              history_hits:[{turn_no,kind,query}], history_self_echo:[...], exclude_from},

//            layers_truncated:{   // 截断可见化（D3）：degraded 看不到的那一类丢失
//              assertions:{rendered, loaded, window, total, sql_window_full},
//              relations:{rendered, loaded, window, render_limit, total, sql_window_full},
//              threads:{loaded, window, open_total, render_max, open_over_capacity}},
//                   // loaded = 进入进程的行数，total = 库里真实行数（与读取同 atTurn 口径）；
//                   // sql_window_full = 已顶到 SQL LIMIT，再长也不会被渲染。
//                   // threads 的两道限额都不是 40：SQL 读 40 无关紧要（D5 的 WIP 上限 8 在写入端
//                   // 就拦住了），真正会「看不到」的是场记单只渲染前 render_max 条（= THREAD_RENDER_MAX）。
//                   // 另注意：assertions 在窗口内还有**第二道、也是真正的**丢弃——selectFacts 的
//                   //   多值条数上限（facts_many_limit）。那一道已改为按预算推导（D9），
//                   //   facts / facts_candidates / facts_many_rendered / facts_many_dropped
//                   //   才是「实际给了模型几条事实」，比 300 那道窗早一个数量级。
//                   //   加新的可见率判据时看这几个字段，不要只看 loaded/window。
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

- **场次边界与原文窗口不能有洞，但允许有意的重叠**：
  `coverage.recent_from + coverage.overlap_turns === coverage.scene_to + 1`
  （没有更早回合时 `recent_from` 为 null）。`overlap_turns <= coverage.overlap_limit`
  （= `RECENT_OVERLAP_TURNS`，默认 2）。封场那一刻不再把上一两拍原文清零——这是
  D1 封场尾巴，代价是原文与场次索引最多重叠 2 拍（约 soft 的 2%），换来
  「切场后仍看得见上一拍怎么说话」。起点取 `min(scene_to + 1, turnNo − overlap)`：
  **晚于 `scene_to + 1` 才是洞**，早于它只是有意的重叠。原文窗口不做字符串裁剪。
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
- 场记单的可选段落按整条取舍（辞书/事实/关系少一条，不切半句）；`directive` 排在可选设定之前，
  并且逐轮 directive 同时进入尾注，避免被场记单预算丢掉。
- 在场以账本 `present`（史官声明的镜头内人物）为准；旧会话没有 `present` 时退回 `characters`。
  最近原文提到但不在场的角色只进辞书邻域/关系提示，不占完整人物卡位。
- 玩家角色永远在场（即使不在人物表里，也会造一个最小条目）。
- `turns.meta.assembly` 持久化本轮装配清单（层预算、在场、辞书候选/实渲染与原因、摘要/检索、降级标记），
  并包含 `messages`（逐条 `{index, role, owner, tokens}` 渲染归属）与 `scene_sheet`（在场渲染档位）。
  两者都是「新增内容落进了哪一层」的事后证据：只在装配出口存在、不落库时，事后无法回答
  「这一拍到底给了模型什么」（长跑实测 65 拍全部缺 `scene_sheet`）。

## Agent 接口

```js
// 旁白（单发）
runNarrator({ session, world, context, turnNo, options, onDelta, signal })
// -> {content, reasoning, usage, model, finishReason}

// 回放校验（D7；`server/memory/replay.js`，纯函数）
cjkOnly(text) -> 只留 \u4e00-\u9fff 的串
longestCommonCjk(a, b) -> {length, text}       // 滚动 DP，中文最长公共子串
detectReplay({content, recent:[{turn_no,content}], min=REPLAY_MIN_CJK, window=REPLAY_WINDOW_TURNS})
// -> {hit, length, text, turn_no, ratio}
// REPLAY_MIN_CJK=100（与报告 repeat_longest 的 FAIL 线同一个数）、REPLAY_WINDOW_TURNS=2
//   （隔一拍回放也要抓：基线局 t42→t44 就是这样）。
// 落点：orchestrator 在空正文守卫之后、落库之前跑一次；命中时用 **narrator 既有 guidance 通道**
//   同等级重写一次（不新增注入点、不降推理等级），只在「重写稿照搬更少」时采用，
//   否则保留首稿并把两稿的照搬长度都记下来——绝不静默改写正文，也不假装修好了。
// 留痕：patches(kind='narrator_replay', status= resolved?'applied':'open', severity='warn',
//   payload:{longest, prev_turn, ratio, retried, resolved, retry_longest?, error?})；
//   回合 meta 增 `replay:{longest, prev_turn, resolved, retried}`；
//   重写前推 SSE `{type:'narrative_reset', reason:'replay'}`（阅读区已上屏的错稿要能被替换）。
//   分段模式（草稿已边写边上屏）只记录不重写。

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
// -> { applied:{assertions, assertions_invalidated, states, changes, relations, threads,
//              threads_rejected, rejected_changes, voices, ledger, skipped},
//      scene_change:{changed, when, place, place_id, weather, tension, present[]},
//      uncertain, usage, stale?, parse_failed?, retried? }
// uncertain 只解析、不落库也不外发（D6）：它是史官的减压阀（允许「正文没明说，我不猜」），
//   没有消费方。不要再把它写进 patches，也不要经 SSE memory 事件推给前端。
// scene_change.present 是「这一拍镜头里的人物」的唯一依据；place 能对上辞书 place 时自动补 place_id。
// guard: () => boolean；false = 调用期间分支/回合已变，整批丢弃并记 patches(status='stale')。
// declaredTargets: 目标声明集合（buildDeclaredTargets() 产出）；越界提案拒写并记
//   patches(kind='skipped_targets', status='skipped', payload.items)；null = 不启用白名单。
// 解析失败：先带坏输出 + 错误回灌重问一次（buildArchivistRetryMessages，坏输出截 2000 字）；
//   仍失败返回 parse_failed:true 并写 patches(kind='archivist_parse_failed', status='failed')，
//   不落脏数据、也不静默当空提案。
buildDeclaredTargets({ card, present, codex, ledgerCharacters, playerName }) -> string[]
// codex = 本拍设定集候选（事实实体）；card 里的人与事实都进声明集合，越界写入拒收
// `player` 与 `world` 永远在集合里：两者都**不是卡里的实体**，而是投影目标
//   （`player/x` → `world.player.x`；`world/status` → `world.runtime.status` →
//    场记单的「局势」行 + 定稿收进常驻笔记）。D25：曾经只放行 `player`，
//   于是史官每一次世界局势变更都被这道校验静默拦掉——全库 `world_state` 里
//   `entity_kind='world'` 的写入 **0 行**，而消费方一直在。新增任何投影目标时
//   必须同步加进这里，并补一条「写入真的落库 + 投影后消费方读得到」的端到端断言。
applyArchivistUpdate({ sessionId, branchId, turnNo, update, aliasIndex, playerName, narrative, declaredTargets })   // 纯函数，可单测
// D32：`update.changes` 里的 `life_state`（kind=person、op=set）会**同时**写 `character_states`
//   （`setCharState`，键是人物名，按 aliasIndex 反查）与 `world_state`。原因：这条路过去只写
//   `world_state`，而 `reviveNamedGone()` / `applyLifeChanges()` 读的是 `character_states`——
//   gone 的回程通道对 changes 写出的离场完全失效（实测凌玥 t18 被标 gone 后 19 拍仍在正文，
//   玩家四次点名一次都没唤回）。同拍若 `update.states` 已写过同一条则跳过，避免同拍两行。
//   其它字段（condition/mood/...）仍只走 world_state，不制造第二份真相。
// 返回值里的 `applied.rejected_changes = { count, by_reason, items }`（D35）：
//   `sanitizeChange()` 阶段就丢弃的 changes 提案，形状与 `threads_rejected` / `skipped` 同族——
//   报告只需读 `count` 一个数就知道「这一拍有没有被拒的变更」，`by_reason` 按 reason 码计数，
//   `items: [{rejected, reason, op, kind, entity_id, path, entity_kind?, entity_type?, turn_no, evidence}]`
//   给明细（`items` 全量，patch payload 里截 50 条）。非空时落**一条** patch：
//   `patches(kind='rejected_change', status='failed', severity='warn', payload:{count, by_reason, items})`。
//   **`rejected_change` 与 `dropped_delta` 不许合并**：前者是「连 `world_state` 行都没写进去」
//   （要被修的是模型写的 kind/path 与提示词/白名单），后者是「写进去了、投影期按实体真实类型
//   被白名单挡掉」（D34；要被修的是卡里实体类型判错）。两者要修的东西完全不同，
//   混成一个 kind 报告就无法归因（AGENTS §5.3 D35）。
//   与 `skipped_targets` 的分工：那条是「提案合法但目标没被 declaredTargets 声明」，
//   这条是「提案本身不合法（op/kind/path/值）」，所以 status 是 `failed` 而不是 `skipped`。
parseArchivistUpdate(content)     // 容错：整体 JSON → 正则提取 → 空形状降级
// applyArchivistUpdate 的返回值除各计数外，还有 `applied.onstage: [{who, field, life_state}]`：
//   本拍**真实写进去**的「谁在镜头里」证据（states / changes / 账本 present）。
//   只供 gone 回程第二路（reviveOnstageGone）与审计用，不进提示词、不占预算、不落库。
parseArchivistUpdateStrict(content) // -> {ok, error, update}；只有顶层 JSON 对象才算成功（供重试/留痕）
sanitizeAssertion(raw, aliasIndex) / sanitizeState(raw, aliasIndex)
sanitizeChange(raw, { aliasIndex, playerName, narrative, declaredSet }) / mergeLedger(old, delta, {aliasIndex})
// 成功返回值形状（逐字段冻结，D35 未改）：普通 `{kind, entity_id, path, op, value}`；
//   introduce 多两个键 `{kind, entity_id, path:'', op:'introduce', value, name, aliases_from_narrative?}`；
//   数值路径提前返回、`value` 已 round 到两位；玩家路径归一时多 `path_from` / `op_from`（见下）；
//   目标名按前后缀归一时多 `target_from`（模型的原始写法，见「目标名的前后缀归一」）。
// **丢弃不再返回 null（D35）**，返回 `{rejected:true, reason, op, kind, entity_id, path,
//   entity_kind?, entity_type?}`——丢弃时**不能**静默消失：越界提案连 `world_state` 行都没有、
//   patch 也没有、计数也没有，报告只看得到「这一拍没变化」，状态于是悄悄停在错值上而全绿。
//   `entity_kind` = 归一后实际拿去查白名单的类型，`entity_type` = 卡里该实体的真实类型
//   （两者不同就是「类型判错了」的直接证据）。
// reason 码固定为（新增丢弃点必须同时加码并同步这一行）：
//   `bad_op` op 不在 set/add/remove/introduce/delta
//   `bad_kind` kind 不在 ENTITY_KINDS
//   `bad_introduce` introduce 的 kind 不是实体类型 / 没 name / sanitizeIntroduce 返空
//   `no_target` 非 introduce 却给不出 id/name/who/entity
//   `canon_immutable` 非人物改写 FACT_CANON_PATHS（作者公理只能走 introduce）
//   `path_not_allowed` pathsFor(kind) 不存在或没这个 path（D35 的原始病灶）
//   `op_path_mismatch` add/remove 用非列表路径、set 用列表路径
//   `not_a_number` 数值路径的值不是数字（含 op 不是 set/delta）
//   `delta_on_non_number` 非数值路径用 delta
//   `bad_reveal` reveal 不在 CODEX_REVEALS
//   `empty_value` 值缺失或被裁空
// **`life_state` 枚举外不是丢弃**：退回 `{path:'status', op:'set', value:<原文>}`，与 sanitizeState 同口径。
// 调用方判据是 `if (c?.rejected) { …; continue; }`——**不要改回 `if (!c)`**，那会把留痕吞掉。
// **主角路径归一（2026-10-31，D35 噪声收敛）**：目标解析之后、白名单之前，`kind='player'` 会过一遍
//   `normalizePlayerChange({path, op})`（`server/world/state-paths.js` 的 `PLAYER_PATH_ALIASES`）：
//   `psyche.wants` → `wants`、`psyche.fears` / `psyche.afraid` → `afraid`（主角的动机字段是**扁平标量**，
//   `normalizePlayer` 里就是 `wants` / `afraid`）；`wants` / `afraid` 上的 `add` → `set`
//   （标量没有「追加」；`remove` 不猜，继续按 `op_path_mismatch` 拒）。归一后照常过白名单——
//   主角没有的字段（`psyche.hides`、`life_state`）仍然被拒并留痕。返回值多两个**可选**键
//   `path_from` / `op_from`（只有真改过的那一维非空）。`applyArchivistUpdate` 汇总成
//   `applied.path_aliased: n` 与一条 `patches(kind='path_aliased', status='applied', severity='info',
//   payload:{count, items})`。**归一不许静默**：报告要把「噪声被吸收」与「噪声仍被拒」并排读，
//   只看 `rejected_change` 下降会把「代码开始吸收」误读成「模型变乖了」。
// narrative（D13）：introduce 时若新名字的前缀（≥2 字、且不等于正经别名）出现在本拍正文里，
//   就把它 absorbed 成别名（返回值多一个 aliases_from_narrative），让后文的简称能对上实体。
//   只收**前缀**，不做「首 2 + 末 1」组合——那是 §1.2 禁止的识别器堆叠；
//   中段省略的简称（蛇纹纸 ← 蛇纹圆印纸）抓不到，由 patches(kind='skipped_targets') 兜住可见化。
//   非 introduce 分支还有一条兜底：resolveEntity 查不到时用 linkEntities，
//   唯一命中才归一 kind/entityId（多命中保持原样，不猜）。
// declaredSet（D13）：非空时，`linkEntities` 也认不出的写法再试一次 `affixDeclaredMatch`——
//   只认同前后缀（「围棋盒」← 「旧围棋盒」）、两边 ≥2 字、唯一命中；命中时归一实体并返回
//   可选键 `target_from`（模型原本的写法）。`applyArchivistUpdate` 汇总成
//   `applied.target_aliased: n` 与一条 `patches(kind='target_aliased', status='applied',
//   severity='info', payload:{count, items})`。反方向不认、多命中不归一（见「目标名的前后缀归一」）。
// isDeclaredTarget 同样接受「实体链接能解析到已声明实体」的写法，否则简称会被目标声明挡掉。
// buildEffectiveWorld(cardSnapshot, deltas, fates) 在 server/world/effective.js，纯函数
// -> world；除卡形状外还带两个「投影期副作用记录」（不进提示词、不占预算）：
//    promotions:      [{id, name, from, to, turn, delta_id}]  introduce 声明 person 撞上卡里
//                     非人物条目 → 投影内升级成人物（D34；卡模板不动，只升不降）
//    dropped_deltas:  [{entity_kind, entity_type, entity_id, path, op, turn, delta_id}]
//                     路径不在实体白名单里而被丢掉（D34；与 rejected_deltas 的「值非法」分开）
//    两者由 orchestrator 落成 patches(kind='entity_promoted' / 'dropped_delta')。
//    白名单按 entity.type（真实类型）取，不按 delta.entity_kind（模型声明）取。

// 定稿：把当前世界线固化成新的世界卡（显式作者操作）
canonizeSession({ sessionId, title?, anchorLabel?, openingSeed?, id? })
// -> { world, card, from: { session_id, turn_no, branch } }

// 场记 / 校勘 / 检索 / 世界呼吸（server/agents/memory-pipeline.js）
closeScene({ session, world, turnNo, reason, guard })    // 切场归档；stale 返回 null
// -> {scene_id, turn_from, turn_to, importance, when_label, place, place_id, cast,
//     question, outcome, key_detail, causal, threads, hooks, life_changes, usage}
// life_changes: [{who, life_state}]，由提示词的受控字段上报，closeScene 内部转交
// applyLifeChanges() 落库；它只在「史官没写成 dead」时补写，并留
// patches(kind='life_state_inferred') 审计。理由：lint-state 只认 life_state 这个受控值，
// 而「手垂在床沿，指节不再蜷着」不含任何关键词，关键词兜底永远打不中。
// **gone 不是终态**（D10）：场记读的是整场原文，它看到这人这场在说话就该能改回来；
// guard 只挡 dead（死人复活必须模型显式写），gone → alive/injured 放行。
// 而 dead 才是真终态——两者语义不同，别再合成一个判断。
applyLifeChanges({ sessionId, branchId, turnNo, world, outcome, lifeChanges, sceneId })
// -> [{who, life_state, from}]  纯写入辅助，供 closeScene 与测试复用
// gone 的回程通道（D10-A）：每拍装配前跑，把「玩家这一拍点名了的 gone 角色」写回 alive。
reviveNamedGone({ sessionId, branchId, turnNo, world, card, playerText, ledger })
// -> [{who, from:'gone', to:'alive'}]；落 setCharState + addWorldState + patches(kind='life_state_revived')
// 只认 playerText（旁白顺带提及不算，宁缺勿滥：误判回来在剧作上可接受，误判回不来是硬伤）；
// 只处理 gone，dead 必须模型自己写。必须在 assembleContext 之前调用，
//   否则这一拍的场记单还是「已故／离场」。不产生 SSE 事件，审计走 patches。
// gone 回程第二路（D10 延伸）：史官这一拍把某人写成在场 → 写回 alive。
// 第一路（playerText 点名）漏掉的正是「玩家没点名、他自己回到镜头里」这一类：
// 110 拍实测 11 个 gone 的人里 9 个之后又被写了 location/mood/goal，只有 2 个被点过名。
// 信号全部来自结构化写入，不做文本匹配：states/changes 的 location/condition/mood/
// goal/status，以及账本 present。同一拍模型自己声明了 life_state 的不翻案（模型优先）；
// 只处理本拍之前就已是 gone 的人；dead 绝不复活。在史官落库之后、下一拍装配之前生效。
reviveOnstageGone({ sessionId, branchId, turnNo, aliasIndex, entries })
// -> [{who, from:'gone', to:'alive', via}]；落 setCharState + addWorldState +
//    patches(kind='life_state_revived', payload.reason='onstage_state', payload.via=<字段>)
// entries 由 applyArchivistUpdate 返回的 applied.onstage 提供（本拍真实写入的 who/field/life_state）。
detectSceneChange(session, update, turnNo)                // 地点/时间/在场者变了就切
runContinuity({ session, world, turnNo, signal, guard })  // -> {issues, healthy, applied, stale?}
// 单次 chat + responseFormat json_object，不调工具（工具是资料员 runLibrarian 的）。
// 修法提案的落地逻辑抽成纯函数（D12）：
applyContinuityFixes(sessionId, { branchId, turnNo, issues, threads, aliasIndex, playerName })
// -> applied 条数；三种 fix.action：invalidate_assertion / set_state / resolve_thread。
// invalidate_assertion 的 target 先 trim 再剥掉可选的一个 `#` 前缀（提示词把断言渲染成
//   `#<id>`，模型照抄带井号——历史实现在这里是 `/^\d+$/`，于是 40 拍里每一条自动修复都落空、
//   报告却记成「等人裁决」）。只放宽一个 `#`，不接受其它前缀：这不是模糊匹配。
// set_state 的 target 必须是 `who::field`（D15）。模型常把断言 id 填进 set_state 表达
//   「这条断言过时了」，那种情况按 invalidate_assertion 执行，并写
//   fix_result:{state:'applied', interpreted_as:'invalidate_assertion'} 留痕。
//   旧的 `[subject,'condition']` 兜底已删除：它把地点写进伤情字段、还会给「伍卿的积蓄」
//   这种非人物 subject 造出假人物（投影时 applyDelta 找不到实体就走 emptyPersonEntry）。
//   非人物 subject（reason='not_a_person'）与受控表外字段（reason='unknown_field'）
//   一律拒写并留痕。aliasIndex 必须是 buildAliasIndex() 产出的数组（resolveEntity 用 .find）。
// merge_alias 不是可用 action（D29）：没有实现分支，合并别名必须人确认。提示词里已从
//   action 枚举删掉；`fix_result.reason='not_implemented'` 这条分支也一并删除——枚举里没有的
//   action 永远不会出现，留着就是死代码（D36）。
// 未执行的提案写进 patch payload 的 fix_result:{action,target,state:'unmatched',retryable:false[,reason]}，
// 并记 patch.status='failed'（D31）——`open` 的唯一语义是「等人裁决」，记忆面板会给它
//   接受/忽略两个按钮；而形态填错的 set_state、非人物 subject 这两类，
//   人点了接受也不会执行。它们过去全记 open，于是看起来像在排队等人，实际是死通道。
//   reason 区分「模型的错」（stale_value = target 解析不出 `人物::字段`；bad_target_form =
//   有 `::` 但人名/字段为空）与「代码按设计拒写」（not_a_person / unknown_field）——
//   前者下一轮改提示词能修，后者修不了也不该修。set_state 的 value 是「校勘那一拍应有的值」，
//   隔 N 拍再执行会把状态改回过去，比不执行更坏，所以 retryable:false、不做存量回填
//   （只能等下一次校勘重新发现问题）。
// **alias 类提案的终态是 `noted`（D36），不是 `open`**：提示词要求 alias 一律填
//   action:'none'（合并别名要人确认），若沿用「none 记 open」，报告就会把它读成
//   「major 挂着没人处置」（45 拍实测 2 条全落这里）。现在 alias 记
//   `status='noted'` + `fix_result:{action,target,state:'manual_only',retryable:false,
//   reason:'alias_merge_needs_human'}`，语义是「按设计等人工入口」，与「模型自己说不确定」
//   区分开。**action:'none' 的非 alias 提案仍记 open**——那才是真的等人裁决。
//   人工入口见 HTTP 节 `POST /api/sessions/:id/patches/:patchId/apply`（真的改账本，
//   `/resolve` 只是改状态）。
// tests 必须覆盖它——抽成纯函数就是为了这个（抽之前 runContinuity 零测试，才让上面那条活了 40 拍）。
runLibrarian({ session, question, signal })               // -> {found, answer, citations, calls}
// 工具：search_events / search_assertions / get_character_state / get_threads / get_scene /
//       get_relations(who) / search_claims(subject,predicate)
runWorldTick({ session, world, turnNo, signal, guard })   // -> {events, usage, stale?}
// 候选 = pickOffstagePersons(entities, {presentIds, playerName, ledger, limit, recentCounts})。
// recentCounts 来自最近 6 次推演已点名的 who → 每人被点过几次（runWorldTick 内部读 patches）。
// 排序 = score − 0.12×次数（软轮转）：分数排序是静态的，不轮转时 8 次推演只会用到 7/55 人、
// 同一批人的同一件旧事被反复渲染；但硬轮转（用过的排到队尾）会在第二次推演就把主角级人物
// 整批挤出候选，世界呼吸不是发牌。软轮转的语义是「用多了才让位」。
// 不做去重不删人：次数全相等时回到纯分数序，谁都不会被饿死。
// 候选 ≤ limit 时不重排（小卡不该被打乱权重顺序）。

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

// 资料员预检（server/agents/retrieval.js）：辞书全文 + 历史原文，共用一次模型调用
shouldPrecheckRetrieval({ mode, codexCount, minCodex, playerText, branchChoice, card })
// auto：两条通道任一命中才跑——
//   辞书通道 `codexCount >= minCodex && 玩家文本/走向点名了某个 codex 条目`；
//   历史通道 `玩家文本/走向提到了已登场的人（linked.person 非空）`，**不看卡大小**。
// 理由：记忆一致性与卡多大无关；只认 linked.fact 会让小卡一局都不触发资料员。
// on/off 强制开关（off 压过一切）。
runRetrieval({ card, playerText, ledger, lastNarrative, signal,
               sessionId, branchId, forkTurn, atTurn, excludeFrom })
// -> {text, queries, codex_queries, history_queries, entries:[{id,name,why}],
//     history_hits:[{turn_no,kind,query}], history_self_echo:[...], exclude_from,
//     tokens:{codex,history}, usage} | null
// 传了 sessionId 才启用历史通道（内部调 recallHistory，limit 3/条）。
// excludeFrom（D4 修法 ①）= 检索下界：最近这场原文已经在 recent 层看得见，
//   再搜一遍只会「自问自答」。调用方用 context-engine 的 recallVisibleFrom() 算，
//   **不许在这里另写一份**（两处规则必须共读一个函数，否则装配层改了下界不跟）。
// history_self_echo = 那些正好是玩家本拍原话子串的 history 查询词。
//   判据：50 轮实测有 75% 的 history 查询是本拍原话子串（空转），下界落地后应接近 0；
//   它和「空查询占比」一起报在 meta.retrieval，两个都要看。
// 分账：两条都有结果时历史 45% / 辞书 55%，只有一条时拿满 retrieval 层；
// 拼接顺序**辞书在前、历史在后**（越靠后离当前输入越近），整体再按层预算兜底截断。
// lastNarrative 是「上一拍结尾」，提示词里一直有这一节，调用方必须传（orchestrator 已传）。
// parseRetrievalRequest(content) -> {codex:string[], history:string[]}
//   宽容解析：兼容旧形状 {queries:[...]}（当 codex 用），失败返回两个空数组。
// parseRetrievalQueries(content) -> string[]（= parseRetrievalRequest().codex，保留旧名）

// 定点改稿的确定性部分（server/agents/rewrite.js；S1，2026-10-30）
parseRewriteTarget(raw) -> {ok:true, target:{start,end,expect}|null} | {ok:false, error}
// null/undefined = 没给（整拍重演）。start/end 必须是整数且 0<=start<end；expect 非空且长度
// 等于 end-start（它是对原文的快照）；片段上限 MAX_TARGET_CHARS=4000（超了说明用户要的是整段重写）。
checkRewriteTarget({content, target}) -> {ok:true} | {ok:false, code:'text_mismatch'}
// 快照不符一律 text_mismatch：路由翻成 409 让用户重选，**不猜、不降级成整拍重演**。
composeRewriteGuidance({guidance, target}) -> string
// 拼进 narrator 既有的 guidance 通道（【本轮改稿要求】user 消息），不新增注入点；
// target 那半句只写「只重写这一段，其余内容保持原样」+【待改片段】。
assessRewrite({before, after, target}) -> {out_of_range, changed:{from,old_end,new_end},
                                           outside:{before,after}}
// 公共前后缀之差的确定性 diff（旧/新两套尾端坐标）。一字未改（前后缀吃满）不算越界；
// 没给 target 永远 false。越界只报不拦：路由落 patches(kind='rewrite_out_of_range')
// 并在 SSE 末尾补 {type:'rewrite_check'}，不自动回滚、不重试。

// 定点改稿的**片段模式**（server/agents/fragment.js；S2，2026-10-31）
// 模型只写替换片段，放哪里由代码定：范围外一个字节都不动，拼接失败 = 拒写（这一拍不落库）。
MAX_FRAGMENT_CHARS = 4000
composeFragmentGuidance({target, instruction}) -> string
// 拼进 narrator 既有的 guidance 通道（不新增注入点）：只输出替换【待改片段】的那一小段。
cleanFragment(text) -> string
// 剥掉模型爱加的包装（代码块围栏 / 「改写：」前缀 / 把整段包住的外层引号）。
// 只剥最外层——正文内部的对白引号原样保留。
spliceFragment({before, target, piece})
  -> {ok:true, text, piece, delta} | {ok:false, error:'no_target'|'empty_fragment'|'fragment_too_long'|'unchanged'}
// before 只被 target 圈定的一段替换成 piece；其余逐字不变。每个 ok:false 都是拒写。

// 历史检索（server/memory/recall-history.js；与 codex_lookup 同构的第五个分段工具）
// recallHistory({ sessionId, branchId, forkTurn, atTurn, excludeFrom, query, limit, kinds, maxTokens })
// -> { text, hits:[{turn_no, kind, snippet, token_count}],
//      meta:{query, hits, limit, tokens, engine:'fts5'|'like'|'none', excluded} }
// 只读：按 branch_id 可见链（含继承的父分支，兄弟分支不可见）+ atTurn 过滤 turns 原文；
// excludeFrom 是下界（含）：≥ 它的回合不检索。上层用 context-engine 的
// recallVisibleFrom() 算「上下文里已经看得见哪几拍」，避免把当前场原文再搜一遍回来。
// ≥3 个 Unicode 字符走 FTS5 trigram（turns_fts 外部内容表，触发器与 turns 同步，
// 启动时按行数差 rebuild 自愈），少于 3 字走 LIKE 兜底（两字人名很常见）。
// 结果只进 retrieval 子层、当拍蒸发；不写库、不进 turns、不做自动召回/embedding
// （AGENTS §1.1/§15.4）。narrator-loop：SEGMENTED_TOOLS 第 5 个工具，由
// runSegmentedTool({recall}) 注入回调；orchestrator 用当前分支 + turnNo 接线。
// HTTP：POST /api/sessions/:id/recall-history。
// renderRecallResults(query, hits, {maxTokens}) -> string（纯函数，单测用）

// 回合原文检索（server/memory/store.js）
searchTurns(sessionId, query, { branchId, forkTurn, atTurn, excludeFrom, limit, kinds })
// -> [{turn_no, kind, snippet, token_count}]，按时间从近到远；分支过滤规则同 getTurnsForBranch
searchTurnsDetailed(sessionId, query, {…同上}) -> { hits:[…], engine:'fts5'|'like'|'none' }
// engine 供 recall_history 的 meta 自报「这次到底走了哪条检索路」，不参与排序。
// excludeFrom：上界改成 min(atTurn, excludeFrom − 1)，即「不搜最近的段」。

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
//   getEffectReceipt(sessionId, effectId, {branchId})
//   status: pending（claim 产生）/ applied / failed / stale；同 effect_id 只落一次

// 提案的人工确定性动作（server/memory/patch-apply.js，D36）
applyPatchAction(sessionId, patchId, { branchId? })
// -> { found:false, ok:false }                                  提案不存在（路由回 404）
// -> { found:true, ok:true, status:'applied', already:true, fix_result }   幂等重复执行
// -> { found:true, ok:true, status:'applied', fix_result:{action:'merge_alias', target,
//      state:'applied', canonical:{id,name,type}, aliases:[…], runtime_duplicates:[…]} }
// -> { found:true, ok:false, status:'failed', reason, fix_result:{…, reason} }
//      reason ∈ kind_not_supported / need_two_names / both_in_card / neither_in_card
// 只做确定性动作，目前只有 kind='alias'（合并别名）。判据写死在代码里：
//   ① 规范名由**卡快照**的 buildAliasIndex 决定，不由模型说、也不用投影卡——
//      投影卡里可能有运行期 introduce 出来的幽灵实体（45 拍局 t30 凭空造了「提酒男子」）。
//   ② 只合并「一个名字在卡里、另一个不在卡里」。两边都在卡里（真·两名冲突）或都不在
//      （都是运行期新造的）→ 不猜，记 reason 交人；猜错不可逆。
//   ③ 动作只有一条：world_state 的 aliases add（source='human'）。**不改 name**（身份根不可写）；
//      运行期同名幽灵实体不删除（红线 4/6 只追加），但如实报进 runtime_duplicates，
//      避免「合并成功」掩盖「世界里还多着一个同名的人」。
// 与 `setPatchStatus()` 的分工：那条只改状态（「作者认可」），这条才动账本（「真的执行」）。
// 两者都走 store.js 具名函数，不许路由层直接拼 SQL（红线 7）。

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
checkoutBranch({ sessionId, branchId })                             // 切回已有世界线（不新建分支）
checkoutBranchSafe({ sessionId, branchId })                         // 路由必须走：会话锁内切
getSessionSnapshot(sessionId) / getMemoryStats(sessionId)   // snapshot 含 playerView（展示层投影）
recallSession({ sessionId, question }) / auditSession({ sessionId })
```

**重试分两层，别混（D33）**：`llm.js` 的 `withRetry` 重试**一次 HTTP 请求**；`orchestrator`
的 `NARRATION_RETRY_MAX`（默认 3）重试**一整拍演绎**。流式输出一旦开始，原连接续不上，
只能整拍重来——所以「上游中断」必须在演绎层兜，靠 `llm.js` 那一层不够。
"`terminated` / `fetch failed`" 这类 Node fetch 错误原先不在 `withRetry` 的白名单里
（真 code 藏在 `err.cause`），一次都不重试；现在 `llm.js` 用 `failureOf(err)` 遍历 `cause`
（最多 4 层）归一成 `retryable:true` 的 `LlmError`，两层才都能接上。
端到端验证见 `_work/segmented-e2e.mjs` 的「D33：上游抖动 → 自动整拍重发」段（假上游连断两次，
断言重发后行动只落库一次、残稿不混进正文、`meta.narration.transient_retries === 2`）。

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
{type:'rewrite_fragment', turn_no, piece, before_chars, after_chars, delta}
// 只在 /turns/:turnNo/rewrite-fragment 出现：piece 是洗干净的替换片段（前端要展示「只改了这几个字」），
// delta 是拼接后正文的字数变化。正文本身仍以 narrative_done 为准（那是拼好的全文）。
{type:'rebuild_memory', turn_no, source_turn}
// 只在 /turns/:turnNo/rebuild-memory 结束时出现：turn_no 是新分支上落库的回合号（全局递增，
// 可能不等于 source_turn），source_turn 是被重跑记忆的那一拍。
{type:'rewrite_check', turn_no, out_of_range, changed, outside}
// 只在 /rewrite 带 target（定点改稿）时出现，在 done 之后：这是**确定性 diff 的结论**，不是模型输出。
// changed = {from, old_end, new_end}：公共前后缀之差（旧文本被换掉的 [from,old_end)、新文本换上的
// [from,new_end)）。outside = {before, after}：落在 target 之外、被一起改掉的字符数。
// out_of_range 为真时同时落 patches(kind='rewrite_out_of_range', status='open', severity='info')，
// 报告据此数「模型重演整拍时外溢了多少」。**只报不拦**：不自动回滚、不重试——留哪一稿是人决定的。
{type:'done', turn_no, branch, narration_mode, usage, session_usage, memory}
{type:'narration_retry', turn_no, attempt, max, reason}
// 上游连接中断（fetch failed / terminated / 读流断开）时自动重发这一拍演绎。
// attempt/max 是「第几次 / 最多几次」（NARRATION_RETRY_MAX，默认 3）；reason 是归一后的原因。
// 重发期间这一拍**一行都没落库**，前端只更新进度行文案，不要弹 toast、不要清空输入框。
// 重试用尽或成功都会继续正常事件流；失败时走 {type:'error', …retryable:true}。
{type:'error', message, aborted?, not_persisted?, retryable?, empty_narration?, transient_retries?}
// not_persisted：这一拍**一行都没落库**（上游连接断了 / 正文为空），前端可以把玩家那句话
//   原样放回输入框重发。D31 起一回合的 player + narrator 两行是原子写入（addTurnPair），
//   正文没产出就整拍回滚——不再有「player 行在、narrator 缺」的孤儿回合。
// empty_narration：content 为空且关推理重试一次仍为空。同样整拍回滚，不落库空串。
//   空串落库的后果是三重的：字数统计被拉低、重复率分母虚高、一条空 assistant 消息
//   进下一拍 recent 层；下游账本（world_state/状态/断言/关系/原声）全 0 行，
//   等于玩家说了句话没人应答。
// transient_retries：这一拍在放弃前已经自动重发过几次（D33）。>0 说明上游真的抖过。
// aborted：用户取消。四种都不会留下半拍。
{type:'ping'}
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
POST   /api/sessions                      body:{world_id?, anchor_id?, settings?}
                                          // settings 原样并入会话设置（工艺三轴会被归一）。
                                          // D26 实验开关：branch_sheet_trim:'default'|'core_only'
GET    /api/sessions/:id                  -> {session, card, world, turns, state, playerView, usage, memoryStats}
PATCH  /api/sessions/:id                  body:{scene_directive?, title?, settings?}
                                          // settings 合并写入；narration_mode:'single'|'segmented'；
                                          // status_bar:'on'|'off'（场景信息条，默认 on）
                                          // branch_sheet_trim:'default'|'core_only'（D26 走向版裁剪）
                                          // 工艺三轴只校验已给的键，不把未涉及的轴写死。
DELETE /api/sessions/:id
GET    /api/sessions/:id/turns            ?from=&to=&limit=
GET    /api/sessions/:id/search           ?q=
POST   /api/sessions/:id/turn             -> SSE  body:{playerText, images, branchChoice, directive, isOpening}
POST   /api/sessions/:id/opening          -> SSE
POST   /api/sessions/:id/branches         -> {branches, scene_summary}
POST   /api/sessions/:id/rewrite          -> SSE（自动开新分支）
       body:{turn_no, guidance?, generateBranches?, target?}
       // target 缺省 = 整拍重演（旧行为）。带 target 是**定点改稿**：{start, end, expect}
       // 圈出要改的片段——字符偏移（对第 turn_no 拍的 narrator 正文）+ 原文快照。
       // 服务端逐字核对快照，不符返回 **409 {error:{message,code:'text_mismatch'}}**（让用户重选，
       // 不猜他指的是哪一段）。target 形状不对 / 片段超过 MAX_TARGET_CHARS(4000) / 区间长度与
       // expect 不符 → 400；这些校验都在开 SSE 之前，返回 JSON 而不是流。
       // 定位**不进模型**：服务端把片段拼进 narrator 既有的 guidance 通道
       // （`server/agents/rewrite.js` 的 composeRewriteGuidance），不新增注入点。
       // 改完做确定性 diff，越界只报不拦：SSE 末尾补 {type:'rewrite_check'}（见 SSE 协议）+
       // patches(kind='rewrite_out_of_range')。改中间某拍仍然是「从这一拍之前开新分支」，
       // 后面的拍留在旧线（红线 6）；「上一拍修订」= 对最后一拍调同一个接口。
POST   /api/sessions/:id/turns/:turnNo/rewrite-fragment  -> SSE（片段模式，自动开新分支）
       body:{target:{start,end,expect}, instruction?}
       // target 必填（缺了 400，不会退回整段重写）；快照不符 409 text_mismatch。
       // 模型只写 target 圈住的那一段，服务端用 spliceFragment 确定性拼接；拼接失败
       // （空片段 / 超长 / 与原文相同）= 拒写并抛错，这一拍一行不落库。
       // narrative 事件里流的是片段，narrative_done 给的是**拼好的全文**；
       // 另发 {type:'rewrite_fragment', piece, before_chars, after_chars, delta}。
POST   /api/sessions/:id/turns/:turnNo/rebuild-memory  -> SSE（正文不动，只重跑记忆）
       // 不调 narrator：把这一拍现有 narrator 正文当定稿，开新分支后跑史官 + 场记判据。
       // 补的是「PATCH /turns 改字不重跑记忆」那一半；结束时发 {type:'rebuild_memory', turn_no, source_turn}。
POST   /api/sessions/:id/rollback         body:{turn_no}   -> 新分支
GET    /api/sessions/:id/branches         -> {branches, current, turn_count}
       // 每条线带自己的 turn_count（按祖先链算的可见回合数）与 is_current。
       // 不能拿 sessions.turn_count 顶：那是缓存，换线后停在旧线的数字上。
POST   /api/sessions/:id/checkout         body:{branch_id} -> {branch_id, switched, from, turn_count, memoryStats}
       // 切回一条**已有**世界线（不新建分支），这就是「历史随时可以回去继续写」。
       // 当前线标 abandoned、目标线标 active，sessions.branch_id 跟着换；一条行都不删。
       // 切到自己返回 switched:false 且不改任何状态；未知分支 404。
       // 走 checkoutBranchSafe()＝在会话锁内切，不会和正在跑的回合交错。
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
GET    /api/sessions/:id/voices           ?limit= -> { voices, total }
// limit 默认 100（夹在 1..500）；total 是全量行数，不受 limit 影响。
// 面板的「台词样本 N」必须用 total：用列表长度会在 234 条样本上显示 100 而看不出被截断。
POST   /api/sessions/:id/voices/:id/pin   body:{pinned}
DELETE /api/sessions/:id/voices/:id
GET    /api/sessions/:id/patches          ?status=&kind=&limit=
// -> { patches, total, counts, open_total, open_counts }
// patches 按 id DESC；limit 默认 100（夹在 1..500）。
// total = 同一过滤条件下的总数；counts = 按 kind 分组计数（不受 limit 影响）。
// open_total / open_counts 是 status='open' 的同一组数：总览卡的「待处理」必须用它，
// 从这一页列表本地过滤会漏（实测报 22，实际 133）。
// 它们存在的理由：不同 kind 的产出速率差两个数量级（史官每拍都写 `skipped_targets`
// 这类流水、校勘每 10 拍才写几次矛盾），混在一起时列表被高频类占满，
// 面板无法区分「没有矛盾」和「矛盾被截断在 100 条之外」。
POST   /api/sessions/:id/patches/:id/resolve  body:{status:'applied'|'dismissed'}
// 只改状态，**不执行任何修复**。语义是「作者认可/忽略这条提案」。
// 「认可」与「执行」是两件事：对 alias 这类「同一实体两个名字」的提案，
// 点了 accepted 之后账本里两个名字依然各写各的（曾长期如此，界面显示已处理、世界没变）。
// 需要真的改账本时用下面那条 /apply。
POST   /api/sessions/:id/patches/:id/apply   body:{} -> { ok, status, already?, fix_result, patch }
// 只做**确定性**动作，目前支持 kind='alias'（合并别名）。
// -> 200 { ok:true, status:'applied', fix_result:{ canonical:{id,name,type}, aliases[], runtime_duplicates[] } }
// -> 200 { ok:true, status:'applied', already:true }  幂等：重复执行不重复写别名
// -> 404 patch 不存在
// -> 400 { error:{ message, code } }  code ∈
//      'kind_not_supported'（该类提案没有确定性动作）
//      'need_two_names'（subject 拆不出两个名字）
//      'both_in_card'（两个名字在卡里分属不同实体——真·两名冲突，猜错不可逆）
//      'neither_in_card'（两个都是运行期新造的，可能真是两个人）
// 规范名只由**卡快照**的 buildAliasIndex 决定（投影卡里有运行期 introduce 出的幽灵实体，
// 拿它当索引会把幽灵认成「卡里有的」）。合并动作只有一条：world_state 的 aliases add，
// **不改 name**（身份根不可写）；运行期同名幽灵实体不删除（红线 4/6 只追加），
// 但如实报进 fix_result.runtime_duplicates。
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
