# 世界书（辞书）v5 设计提案：从「条目列表」到「实体图谱 + 场景视图」

> 状态：**核心已实施（2026-10-24）**。已落地：实体图谱与同名去重、`parent_id` 包含树、
> 显式 `edges/claims` 字段、T0/T1 分档场记单、树形世界索引、定义/运行态分离、卡级 lint、
> 检索门控、校勘写入上限。未落地：完整 v5 卡格式重写、按角色可见性、作者图视图。
>
> 本文只讨论卡级设定（`card.codex` / cast / timeline）的结构与装配，
> 不讨论 SillyTavern 世界书兼容，也不引入 `keys` / `triggers` / `priority` / `constant` /
> 递归扫描。所有落地都必须在 AGENTS.md §1.1 的十一条红线内。
>
> 依据：2026-10-24 真实 12 轮运行（`_work/real-10turn-report.json`）与当前 v4 代码。
> 目标不是「塞更多设定」，而是让「哪些设定该出现、以什么粒度出现」由**结构**回答。

---

## 0. 先说结论

当前辞书是一个**扁平条目列表**：每条有 `name / aliases / type / summary / facets / links / reveal / pinned`。
它在 30 条规模、5–9 个在场者时还能工作；真实 12 轮里已经出现三个信号：

1. 在场者从 5 涨到 13（含未在场者），场记单预算 2400 被人物块吃满，辞书/事实被挤到末尾；
2. 世界索引 30 条就占掉 system 3186/3200 tok，条目再翻十倍时只剩名字；
3. 9 条断言被「同主同谓、对象不同」判为冲突而失效，其中大量是 `知道 / 拥有` 这类**多值谓词**，
   属于误判。

所以 v5 的核心不是加字段，而是换模型：

> **辞书 2.0 = 实体（节点）+ 类型化关系（边）+ 事实（带基数与来源的声明）+ 场景视图（确定性投影）。**
> 仍然坚持「模型只提案、代码才落库」「不按关键词自动注入」「future 永不进提示词」。

一句话对比：

| | v4 | v5 |
|---|---|---|
| 数据形状 | 条目数组 | 实体图 + 声明图 |
| 关系 | `links: string[]`（无语义） | 类型化边（方向/基数/有效期/可见性） |
| 角色与辞书 | 两套 id，可能重复（本卡「张兰」同时在 cast 和 codex） | 统一实体，role 只是 kind |
| 静态设定与运行态 | `facets` 可被运行期 `world_state` 覆写 | `definition` 不可写，`runtime` 单独带有效期 |
| 进场 | 实体连接 / 主题 / 钉选，平铺打分 | 焦点集 → 邻域 → 三档渲染（全量/一句/仅名字） |
| 索引 | 全部条目 + 摘要 | 按包含关系折叠的树，远处只留名字 |
| 冲突 | 同主同谓不同对象 → 失效 | 先看谓词基数；只有单值谓词才失效 |
| 可解释性 | 只有 `canon_from` 字符串 | 每条声明带 `source / quote / turn / confidence` |

---

## 1. 现状诊断（来自真实运行与代码）

### 1.1 结构问题

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| 1 | 在场者只增不减 | 12 轮 present 数：5,5,6,7,8,9,9,9,9,12,12,13 | 场记单人物块吃满预算，辞书/事实被挤掉 |
| 2 | 「被提及」=「在场」 | `context-engine.js:139-158` 把 `ledger.characters` 全部键与 `linked.cast`（最近 8 轮原文命中的别名）都加进 present | 远处角色、只被对话提到的人都占完整人物卡位 |
| 3 | 辞书候选 ≠ 实际渲染 | `context-engine.js:490` 记录 `candidates.slice(0,8)`；`renderSceneSheet` 的 `order` 把 codex 放在倒数第二（`scene-sheet.js:269`） | 装配清单说选了 8 条，场记单里可能一条都没有 |
| 4 | 当前地点加分失真 | `scene-sheet.js:113` 用 `presentIds.includes(entry.id)`，而 `presentIds` 同时含「被提及」的 codex（`context-engine.js:198-204`） | 所有被提到的地点都被标成「当前地点」 |
| 5 | 同一实体两套身份 | 本卡「张兰」同时在 `cast` 与 `codex`，渲染两次 | 索引/辞书重复，id 引用歧义 |
| 6 | 索引平铺 | `renderWorldIndex` 对全部条目按类型分组，带摘要 | 30 条已占 3186 tok；300 条只能截断 |
| 7 | 运行期可覆写 canon | `state-paths.js` 的 `CODEX_SCALARS` 含 `summary / detail / facets.history` | 史官一句 `set` 就能改写「司楼是官营青楼」这类公理 |
| 8 | 关系/线索无历史 | `relations`、`threads` 原地 upsert，只有 `turn_no` 没有有效期 | 回滚到旧轮次时无法恢复当时的关系/线索 |

### 1.2 真实运行里已确认的缺陷

1. **回滚不复原关系/线索**：fork 到第 8 轮后，新分支出现了第 9 轮才埋的线索
   （`黎婆被司楼执事拦截`，`planted_turn=9`）和第 9 轮才更新的关系（`turn_no=9`）。
   原因：`copyBranchState()`（`store.js:1050`）对 `relations` / `threads` 是整表复制，没有按分叉点过滤，
   而且这两张表本身只保留「最新值」。
2. **嵌套分叉会串线**：从 b2 再回滚到 b2 的某一轮时，`getTurnsForBranch()` 的条件是
   `branch_id=? OR turn_no<=fork_turn`（`store.js:1456-1463`），会把**兄弟/废弃分支**里
   编号更小的回合也带进来。已用确定性脚本复现：b3 看到了 main 第 9–12 轮。
3. **张力每轮被清零**：`parseArchivistUpdate` 把缺失的 `scene_change.tension` 解析成 0
   （`archivist.js:325`），`mergeLedger` 又接受 0（`archivist.js:210`）。
   锚点初始 0.35，第 1 轮后永远 0.00。
4. **断言误判冲突**：`findConflictingAssertions`（`store.js:1260`）对所有谓词都按「单值」处理。
   真实运行 32 条断言中有 9 条被失效，典型是
   `伍卿 知道 A` 被 `伍卿 知道 B` 失效、`伍卿 拥有 玉佩甲` 被 `伍卿 拥有 玉佩乙` 失效——
   这些不是矛盾，是多值事实。
5. **`state.turn_no` 内部字段永远是 0**：`mergeLedger` 保留 base 里的 `turn_no`（`archivist.js:205`），
   行级 `turn_no` 才是对的。事件顶层字段正确，但对象内部会误导排查。

这些缺陷里 1/2/3/4 与辞书结构直接相关：它们都源于「用自由文本当身份、用单值模型当事实」。

---

## 2. 设计目标与红线

### 2.1 目标

1. **规模无关的索引**：条目从 30 涨到 300，system 层仍然可控。
2. **关系可查询**：不再只有 `links: string[]`；地点包含、势力归属、持有、债务、知情关系都能被确定性地遍历。
3. **事实可判定**：同一谓词是单值还是多值由数据声明，代码不再猜。
4. **静态与运行态分离**：canon 只读；运行期变化带有效期、来源、可见性。
5. **装配可解释**：每条进入/没进入上下文的设定都有原因、层级和 token 记录。

### 2.2 红线（不因为「更先进」而破）

- 不做关键词触发；`keys / triggers / priority / constant / 递归扫描` 一律不出现。
- 唯一字符串匹配仍然是实体链接，且只用于「提到了谁」，不决定注入哪段设定。
- `timeline.canon === 'future'` 永不进提示词，也不当演绎目标。
- 原文是唯一真相；声明/关系/图都是派生数据，必须能从 turns 重建。
- 断言冲突失效不删除；回滚开分支不删历史。
- 模型只提案，确定性代码落库。
- 新增内容必须落进某一层预算；1000 轮体积恒定。

---

## 3. v5 数据模型

### 3.1 实体（Entity）：cast 与 codex 统一

```js
{
  id: 'ling-yue',                     // 稳定 slug；全卡唯一，引用一律用 id
  kind: 'character' | 'place' | 'institution' | 'item' | 'faction'
      | 'concept' | 'event' | 'custom',
  name: '凌玥',
  aliases: ['玥姐姐', '家主'],
  tags: ['凌家', '帝都'],

  // 地点/机构专用：包含关系（树）
  parent_id: 'ling-fu',               // 可为空
  order: 0,

  // 作者写死的定义（运行期不可写）
  definition: {
    one_line: '帝都凌家家主',
    summary: '……',
    detail: '……',
    facets: { sensory: '', rules: [], consequences: [], history: '' },
    // character 专属字段继续放在这里（voice/psyche/knowledge/agenda/relations 可保留）
  },

  // 分层文本：同一实体对不同视角有不同说法
  layers: {
    public: { summary: '', rules: [], sensory: '' },   // 世人皆知
    rumor:  { summary: '' },                            // 市井传闻，可能为假
    engine: { truth: '', consequences: [], secrets: [] } // 引擎掌握，不得说破
  },

  // 可选：显式知情边界；缺省时回落到 cast.knowledge
  knowledge: { known_by: [], hidden_from: [] },

  // 运行期允许写的路径（schema 声明，值在 world_state）
  runtime_paths: ['status', 'condition', 'owner_id', 'access', 'location_id'],

  sources: [
    { kind: 'novel', title: '我在女尊世界捡破烂', chapter: 3, offset: 120, quote: '……' },
    { kind: 'author', note: '卡匠补写' },
    { kind: 'play', session_id: '...', turn_no: 6 }
  ]
}
```

要点：

- `cast` 与 `codex` 不再分两套真源。卡里可以保留两个数组作为作者视图，但 `normalizeCard` 应生成
  统一的 `entities` 索引，并**在导入时去重**（同名/同别名 → 同一 id，给出 warning）。
- `definition` 是公理，运行期只能写 `runtime`。这直接修掉「史官改 summary」的口子。
- `layers` 不是三份完整文案，而是同一个实体的三种视角；`engine.truth` 与 `public.summary`
  可以矛盾（传闻 vs 真相），这正是剧情张力的来源。

### 3.2 关系（Edge）：类型化、有方向、有有效期

```js
{
  id: 'e-ling-yue-owns-yupei',
  from: 'ling-yue',
  to: 'wu-qing',                       // 或实体 id / event id
  kind: 'owns' | 'located_in' | 'member_of' | 'supervises' | 'owes'
      | 'protects' | 'hides' | 'loves' | 'hates' | 'related_to' | 'caused',
  directed: true,
  validity: { from_turn: 0, to_turn: null, from_event: null, to_event: null },
  visibility: 'public' | 'rumor' | 'engine' | 'secret',
  weight: 0.0,                         // 关系强度，用于排序与预算
  note: '她第一次没有甩开他的手',
  sources: [{ kind: 'archivist', turn: 6, confidence: 0.9 }]
}
```

约定：

- `located_in` 的逆关系是 `contains`，由代码推导，不重复存。
- `member_of` / `supervises` 用于势力/机构；`location_id` 仍由账本维护，边只表达稳定关系。
- 关系同样有有效期：`owes` 可以被清偿，`member_of` 可以被逐出；不要原地覆盖。
- 现有的 `relations` 表（从→到、kind、sentiment、note）可以视为 `Edge` 的一个子集；
  v5 把 `sentiment` 留在边上，把「关系变化事件」写进 claims/事件，不再覆盖旧值。

### 3.3 声明（Claim）：事实原子，带基数

```js
{
  id: 123,
  subject: 'wu-qing',                  // 实体 id 优先；没有实体才用字面量
  predicate: 'knows',                  // 受控词表
  object: { kind: 'entity' | 'literal' | 'event', id: 'yupei', text: '' },
  cardinality: 'one' | 'many',         // 关键：由谓词表决定，不由代码猜
  validity: { from_turn: 4, to_turn: null },
  visibility: 'public' | 'engine' | 'secret',
  source: { kind: 'archivist' | 'author' | 'continuity', turn: 4, quote: '……', confidence: 0.9 },
  status: 'active' | 'invalidated' | 'retracted',
  superseded_by: null,
  evidence: '……'
}
```

谓词表（示意，不是最终版）：

| predicate | cardinality | 说明 |
|---|---|---|
| `located_in` | one | 同一时刻只在一个地点 |
| `is` / `was` | one | 身份判断 |
| `knows` / `does_not_know` | many | 知道 A 不影响知道 B |
| `believes` | many | 信念可以并存 |
| `owns` | many | 可以拥有多件物品 |
| `wants` / `fears` | many | 欲望/恐惧可并存 |
| `owes` | many | 可以欠多个人 |
| `hides` | many | 可以隐瞒多件事 |
| `member_of` / `loyal_to` | many | 可以多重效忠 |
| `hostile_to` | many | 可以与多人敌对 |

**冲突判定只在 `cardinality === 'one'` 时执行**：
同 subject + 同 predicate + 不同 object + 有效期重叠 → 旧声明失效。
多值谓词永远不因为「对象不同」而失效；它们只在正文明确否定/收回时失效。

对象优先落成实体 id。自由文本对象（例如「她不能扶他，因为门外有眼睛」）保留为 `literal`，
不参与冲突判定。这修掉真实运行里 9 条误失效中的大多数。

### 3.4 运行态（Runtime）：与定义分离

```js
// world_state 的路径白名单按实体类型收紧
CODEX_RUNTIME_PATHS = ['status', 'condition', 'owner_id', 'access', 'location_id', 'open_to']
CODEX_CANON_PATHS   = []                     // definition 不可写
CAST_RUNTIME_PATHS  = ['status', 'condition', 'mood', 'location', 'goal', 'one_line']
PLAYER_RUNTIME_PATHS = [...]
```

- `world_state` 仍然是运行期唯一写入口，带 `valid_from / valid_to / source / evidence`。
- 新实体的 `introduce` 允许写 `definition`（第一次创建），之后只能写 `runtime`。
- `owner_id / access / open_to` 让「凌府今天戒严」「司楼只接待官身」这类状态有地方放，
  而不是塞进 `summary` 或账本的自由文本。

### 3.5 来源（Provenance）

每条实体、边、声明都可以带 `sources`。最低要求：

- 小说导入：`title / chapter / offset / quote`
- 作者手写：`note`
- 游戏内：`session_id / turn_no`
- 连续性修正：`turn / issue_id`

收益：卡匠/导入可追溯；连续性 Agent 可以指出「这条声明来自第 6 轮旁白」；作者改卡时能知道
哪些内容是原创、哪些来自原著。

### 3.6 场景视图（Scene View）：确定性的三档渲染

这是 v5 最重要的运行时部分。每次装配只做四步，全部是纯函数：

```
1) 焦点集 focus
   = 账本 present（显式在场，见 §4.1）
   ∪ 玩家
   ∪ 当前地点及其祖先（located_in 反向）
   ∪ 随身物（inventory ids）
   ∪ 未回收线索锚点
   ∪ 作者钉选

2) 邻域 neighbors
   = focus 出发、depth=1、weight>=阈值、visibility 允许的边所指向的实体
   （包含 contains 的子地点；不含 depth=2，避免图爆炸）

3) 分档
   T0 全量：focus —— definition 的相关层 + runtime + rules/consequences
   T1 一句：neighbors —— one_line + runtime + 边上的 note
   T2 仅名字：其余实体 —— 按 parent_id 折叠成树，只给名字

4) 预算
   按 T0 → T1 → T2 顺序填；超预算时先丢 T2，再截 T1，T0 永远保留。
   meta 记录：每档的 id、为什么进来（哪条边/哪个焦点）、渲染 token、被丢弃的条目。
```

示例（同一张卡，场景在凌府天井）：

```
【世界索引·目录】
帝都
  凌府（当前）—— 天井 / 偏房 / 正厅
  司楼
  西街训练场
湘曲市
  十七街
  商务大厦
山村
  竹屋

【本场可用设定】
· 凌府（当前地点）
  规则：内外院分界；家主的私物不落外院。
  此刻：正门封闭，天井有守卫。
· 凌璇（neighbors：凌玥的母亲）
  一句：凌家老家主，笑不达眼底。
  关系：凌玥 →（母女·裂痕）凌璇
· 无纹玉佩（neighbors：伍卿持有）
  一句：无纹无氏牌，贴身会透出「凌」字。
  【只你可知】它是全书唯一的超自然物件。
```

与现在的区别：

- 远处实体只占名字，不再每条都带摘要；
- T0/T1 的粒度由图距离决定，不由「名字有没有在最近原文出现」决定；
- 模型主动检索可以把任意实体提升为 T0（当拍），但不改变自动路径。

### 3.7 检索（模型主动取证）的操作符

保留当前的「模型发起 → 确定性匹配 → 当拍蒸发」，但把查询从「名字子串」扩展为：

```json
{"queries":[
  {"op":"entity","name":"无纹玉佩"},
  {"op":"neighbors","id":"ling-fu","kind":"located_in","depth":1},
  {"op":"claims","subject":"wu-qing","predicate":"owes"},
  {"op":"events","who":"ling-yue","from_turn":1,"to_turn":6},
  {"op":"text","q":"七年前 雨夜"}
]}
```

代码只执行**结构化查询**，不做关键词自动注入。`text` 查询可以走 SQLite LIKE/FTS5（P2-2 已规划），
但触发者仍然是模型。返回值按实体/边/声明渲染成紧凑块，仍然只进 `retrieval` 子层。

同时给 Librarian 增加两个工具：`get_relations`、`search_claims`。真实运行里
`recall("凌玥和伍卿之间的债是什么？")` 回答「正文里没有写过这个」，
就是因为工具只有 `search_events / search_assertions / get_character_state / get_threads / get_scene`，
没有关系/声明查询。

### 3.8 卡级 lint（确定性，无模型）

保存卡时跑一遍，只报告不阻断：

- 断链：edge/claim 指向不存在的实体 id；
- 别名冲突：两个实体共享同一别名；别名长度 < 2；
- 重复身份：同名实体同时出现在 character 和其他 kind；
- 孤岛：没有任何边、也没有钉选的实体；
- 不可达：`visibility=secret` 但没有任何 `reveal` 路径；
- 矛盾：`cardinality=one` 的声明在有效期上重叠且对象不同；
- 预算：每条实体在 T0/T1 的渲染 token 估算，索引树总 token；
- 死重：连续 N 局从未进入任何 T0/T1 的实体（给作者看，不自动删）。

---

## 4. 与现有代码的映射

### 4.1 在场（先修语义，再谈图）

当前 `pickPresent` 把三件事混在一起：

```
账本 characters（状态跟踪） ∪ 最近原文提到的 cast（linked） ∪ always_present
```

v5 拆成三个显式概念：

- `present`：这一场真的在镜头里。由史官的 `scene_change.present`（或 enter/exit）维护；
- `tracked`：有状态跟踪但不一定在场（原 `ledger.characters`）；
- `mentioned`：最近原文提到，只用于关系/知识/辞书邻域，不占完整人物卡位。

`always_present` 改名为 `travels_with`（只对玩家随行者有意义），或者保留但只影响
「neighbors」，不再无条件进 T0。

落地文件：

- `server/memory/context-engine.js:139` `pickPresent`
- `server/agents/archivist.js` schema：增加 `scene_change.present` / `enter` / `exit`
- `server/memory/store.js` `mergeLedger`：维护 `present` 集合（不是只增）

### 4.2 选择与渲染

| 现在 | v5 |
|---|---|
| `renderWorldIndex`（全部条目 + 摘要） | `renderWorldTree`（parent_id 折叠；T2 只名字） |
| `selectCodex`（三条路径平铺打分） | `buildSceneView`（焦点 → 1 跳邻域 → 三档） |
| `renderSceneSheet` 内 codex 段 | `renderSceneView` 的 T0/T1/T2 段 |
| `meta.codex = candidates.slice(0,8)` | `meta.view = { t0:[], t1:[], t2_count, dropped:[] }` |

`renderSceneSheet` 的 `order` 里 codex 在 `directive` 之后、`echoes` 之前
（`scene-sheet.js:269`）。v5 应把 T0 设定放到 `cast` 之后、`pressure` 之前，
避免被人物块挤掉；T2 索引留在 system，不占场记单预算。

### 4.3 预算

不新增层。仍然五层：

| 层 | v5 内容 |
|---|---|
| system | 契约 + 命题 + 宪章 + **世界树（T2 名字）** + 主角 + 常驻笔记 |
| summary | 滚动摘要 |
| recent | 最近原文 |
| scene | 账本 + **T0/T1 设定** + 关系/线索/事实 + 指令 |
| current | 本轮输入 + 尾注 |

变化的是 system 的「世界索引」从平铺摘要变成树，scene 的「辞书」从平铺条目变成 T0/T1。
两者都受既有配额约束，1000 轮体积恒定不变。

### 4.4 分支与派生数据

新增任何图/声明表都必须：

1. 带 `session_id + branch_id`（如果是运行期）；
2. 在 `copyBranchState()` 补复制规则；
3. 带有效期，能回答「分叉点当时是什么」；
4. 能被 `turns` 重建（卡级图除外，它来自卡快照）。

同时修两个现有问题：

- `copyBranchState` 对 `relations / threads` 按分叉点复制；如果做不到，就把它们改成
  追加式事件（`relation_events` / `thread_events`），fork 时重放到分叉点。
- `getTurnsForBranch` 改成**祖先链**可见性，而不是「全局 turn_no <= fork_turn」。

---

## 5. v5 卡形状（示意）

```json
{
  "version": 5,
  "title": "我在女尊世界捡破烂",
  "entities": [
    {
      "id": "ling-yue",
      "kind": "character",
      "name": "凌玥",
      "aliases": ["玥姐姐", "家主"],
      "definition": {
        "one_line": "帝都凌家家主 · 伍卿的「妻主」",
        "voice": { "rhythm": "陈述句、短句、笑着说的狠话" },
        "psyche": { "wants": ["把伍卿带回凌府"], "fears": ["他不认她"] }
      },
      "layers": {
        "public": { "summary": "帝都最有权势的女人之一" },
        "engine": { "truth": "七年前她站在街边，没有伸手", "secrets": ["她一直在找他"] }
      },
      "sources": [{ "kind": "novel", "chapter": 2, "quote": "「卿儿。」" }]
    },
    {
      "id": "ling-fu",
      "kind": "place",
      "name": "凌府",
      "parent_id": "di-du",
      "definition": { "one_line": "凌家主宅", "facets": { "rules": ["内外院分界"] } },
      "runtime_paths": ["status", "access", "open_to"]
    }
  ],
  "edges": [
    { "from": "ling-yue", "to": "ling-fu", "kind": "located_in", "visibility": "public" },
    { "from": "ling-yue", "to": "wu-qing", "kind": "owes", "weight": 0.9,
      "note": "七年前她欠他一个真相" },
    { "from": "ling-fu", "to": "di-du", "kind": "located_in" }
  ],
  "claims": [
    { "subject": "wu-qing", "predicate": "owns", "object": { "kind": "entity", "id": "wu-wen-yu-pei" },
      "cardinality": "many", "validity": { "from_turn": 0 } },
    { "subject": "wu-qing", "predicate": "located_in", "object": { "kind": "entity", "id": "ling-fu" },
      "cardinality": "one", "validity": { "from_turn": 4, "to_turn": 5 } }
  ]
}
```

`cast` / `codex` / `relations` 仍然可以保留为导出视图，但运行期只读 `entities / edges / claims`。

---

## 6. 迁移路径（beta，不做兼容层）

AGENTS §5.4 明确：只认当前版本，旧格式不自动迁移。v5 同样：

1. `normalizeCard()` 只读 v5；旧字段直接忽略。
2. 提供一次性离线脚本 `_work/upgrade-card-v5.mjs`：
   - cast → `entities[kind=character]`
   - codex → `entities[kind=type]`
   - cast.relations → `edges`
   - timeline → `entities[kind=event]` + `claims`（`canon: past|future` 保留）
   - 同名/同别名去重，输出 lint 报告
3. 重写 `presets/*.json` 为 v5；不在业务代码里加版本分支。
4. 会话创建时冻结 v5 快照；运行期只写 `world_state`。

---

## 7. 分期落地

### P0：先修正确性（不需要改卡形状）

1. `tension` 解析：`scene.tension != null` 才转换，缺失保持 null。
2. `getTurnsForBranch` 改祖先链可见性；补「嵌套分叉不串线」测试。
3. `relations / threads` 分叉历史：改成事件表或快照重放；补「回滚后不出现分叉后线索」测试。
4. `place_id` 由地点名确定性解析（实体链接）；当前地点加分只看 `ledger.place_id`。
5. 在场语义拆分：`present / tracked / mentioned`；先止损人物块。
6. `meta.codex` 记录「渲染了几条/丢了几条」，而不是只记候选。

### P1：图与场景视图（v5 主体）

1. `entities / edges / claims` 三张卡级投影表 + `normalizeCard` v5。
2. `renderWorldTree` + `buildSceneView` + 三档预算。
3. 谓词基数表 + 冲突判定只对单值谓词。
4. `definition` 与 `runtime` 分离；收紧 `state-paths`。
5. 卡匠/导入输出 edges 与 claims，不再只输出 `links: []`。

### P2：可解释与创作工具

1. `sources` 溯源 + lint。
2. 检索操作符 + Librarian 的 `get_relations / search_claims`。
3. 作者视图：树/图/表三视图、场景视图预览、覆盖率与死重报告。
4. 按角色可见性（`known_by`）与传闻层（`rumor`）的高级渲染。

---

## 8. 明确不做

- SillyTavern 的 `keys / triggers / priority / constant / 递归扫描`；
- 关键词自动注入、按名字正则决定注入；
- 把 `future` 事件当剧本或必达节拍；
- 自动从正文「总结出」新设定并直接写进 canon（只能提案，作者确认）；
- 向量召回替代结构（可以作为 `text` 检索的补充，但不能成为自动注入路径）。

---

## 9. 验收标准

1. `test-context.js`：300 条实体的卡，system 仍在 3200 tok 内；T0/T1/T2 层各自受配额。
2. `test-context.js`：1000 轮体积恒定；新增 meta 记录 tier 与 dropped。
3. `test-memory.js`：
   - 嵌套分叉 b3 看不到 main 9–12；
   - 回滚到 8 后看不到第 9 轮埋的线索/关系；
   - `知道 A` 与 `知道 B` 并存；`位于 A` 与 `位于 B` 失效；
   - `definition` 路径写入被拒绝。
4. `test-world-card.js`：同名 cast/codex 去重；lint 报出断链与别名冲突。
5. 真实 12 轮：present 数量不再单调增长；场记单里 T0 设定实际渲染（meta 可验证）。

---

## 10. 最小可行版本（如果只想做一件事）

如果只愿意改一处，优先做 **P0-5 在场语义拆分 + P0-6 渲染 meta**：

- 把 `present` 从「账本里出现过的所有人」改成「史官显式声明的在场者」；
- 把「候选 8 条」改成「实际渲染 N 条 / 丢弃 M 条」。

这两处不改卡形状、不动图模型，却能立刻把场记单预算从人物块里释放出来，
让现有的 30 条辞书真正有机会进入提示词。之后再上图模型，收益才不会被预算吃掉。
