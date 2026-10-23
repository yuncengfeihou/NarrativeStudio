# 梨园 1.6.4 × 叙事台：机制解剖与借鉴清单

> 分析对象：仓库根目录 `Liyuan-1.6.4/`（PolyForm Noncommercial 1.0.0）。
> 本文只做**设计研究**，不复制其代码；所有落地建议都按本仓库 v4 的形状重写。
> 对照对象：本仓库 v4（世界卡 + 状态渲染式上下文 + 多 Agent 记忆）。
> 范围：只讨论角色扮演的引擎、上下文、记忆、分支与交互；**完全不讨论 SillyTavern 兼容**
> （卡格式、世界书 keys/triggers、regex_scripts、MVU、状态栏、预设、EJS、TavernHelper）。
>
> 结论日期：2026-10-23。相关文件行号以本仓库当前工作树为准。

---

## 0. 先给结论

### 0.1 梨园真正领先的地方

不是提示词写得更漂亮，而是**把角色扮演当成 coding agent 来搭 harness**：

- 会话是一棵**只追加的树**，正文、状态快照、摘要、存档、修订都是树上的条目；
- 模型是「演员」，通过工具在工作区里分段写稿、定点改稿、按需查资料、在岔路停下来问用户；
- harness 负责装配、预算、持久化、压缩、显示策略、并发守卫——**模型只提案，代码才落库**；
- 上下文不是「把所有相关设定塞进去」，而是**稳定前缀 + 最近原文 + 末端数据块 + 按需检索**，
  体积由结构控制，而不是靠不断摘要。

一句话：**梨园把「模型该决定什么」和「harness 该保证什么」划得很清楚。**

### 0.2 最值得拿的四件事（P0）

1. **滚动前情提要（长局压缩）**：最近 N 拍逐字 + 一条随分支滚动的摘要，覆盖边界明确；
   这是叙事台目前最大的结构性缺口。
2. **异步写入的分支/叶守卫**：任何旁路 Agent 在写库前核对分支与回合没有变；
   叙事台现在只有会话串行锁，`/rollback` 与 `/rewrite` 不进锁，存在晚写旧分支的竞态。
3. **每轮装配清单持久化**：把「这一轮为什么是这些内容」写进 `turns.meta_json` 并在 UI 可看；
   叙事台已有 `meta`，但只存在进程内存里，刷新即失。
4. **定点改稿 + 上一拍修订**：不重生成整轮，只改选中段落/指定句；原文主权不变，
   与现有「重写=开新分支」并存。

### 0.3 看起来诱人、但不该拿的三件事

1. **关键词触发的世界书绿灯**（`lorebook.ts → scanEntries`）：这正是叙事台 v4 明确禁止的
   lorebook 式注入。梨园自己也在为 off 档保留 `passiveLore` 兜底，属于历史包袱。
2. **预设拆层 / 格式栈 / 标签识别器**：为 ST 卡生态服务，且梨园自己在
   `CLAUDE.md` 里把「名单、正则、特判」列为事故源。叙事台不兼容 ST，没有这个负担。
3. **文件树 + JSONL 会话存储**：梨园用它换来「一卡一目录、可直接拷贝」，
   叙事台的 SQLite 分支模型更简单，迁移成本远大于收益。

### 0.4 设计决定（2026-10-23 已拍板两项）

1. **第五层预算（摘要）：已接受。**
   新增 `BUDGET_SUMMARY`（建议 1800 tok）承载滚动前情提要；降级顺序改为
   场记单 → 摘要 → 最近原文减半 → 截最长非 system。AGENTS.md §6.3 已记录，
   实施时把「四层」正式改成「五层」。
2. **模型主动检索：已允许。**
   梨园的做法是「标题索引 + `lorebook_search`」。它不违反「唯一字符串匹配是实体链接」——
   因为没有任何关键词自动注入，是模型自己决定查什么。实施时改写
   「辞书进场只有三条路」的表述为「三条自动路 + 一条模型主动检索路」，
   并补「没有关键词触发」的负向测试。
3. **卡级跨会话记忆（仍待拍板）：续作还是平行世界线？**
   梨园默认同一张卡的多个会话共享一个世界，所以往局复盘可以当既定事实。
   叙事台的 v4 默认「新会话从模板 + 锚点重新开始」，多个会话是平行线。
   直接照搬会把上一条线的死亡/关系带进新线。建议做成**显式开关的「续作模式」**，
   而不是全局默认。

### 0.5 成熟度速览（主观评估）

| 维度 | 评价 | 依据 |
|---|---|---|
| Harness / 会话树 / 分支正确性 | **S** | 只追加树、视图投影、叶守卫、压缩与分支坐标 |
| 长篇记忆 | **S-** | 摘要 + 最近逐字 + 归档 + 卡级复盘，三层齐全；语义绑定「同卡连续世界」 |
| 设定规模 | **A** | 常驻/索引/按需三档；但依赖模型愿意调工具 |
| 上下文工程 | **A** | 稳定 system + 末端注入 + 历史重建 + 工具结果剪枝 |
| 写作控制 | **A-** | 工作区/分段/定点改稿/上一拍修订；轮次卡偏弱约束 |
| 交互共创 | **A-** | ask 设计克制；但状态化暂停增加复杂度 |
| 可观测性 | **A** | beatLog/装配报告/旁路回执/压缩指示 |
| 产品聚焦 | **C+** | 扮演/写卡/agent/预设/前端多线并行，复杂度高 |
| 代码可维护性 | **B+** | 领域层纯函数化、测试多；但类型与模块量很大 |
| 与 ST 生态的关系 | **B** | 兼容层带来历史包袱，作者自己也在收缩 |

结论：**引擎与记忆是 SOTA 级，产品边界与兼容层是负债。** 叙事台应该拿前者，避开后者。

---

## 1. 梨园的分层与一次演出

### 1.1 分层

```
packages/@liyuan/*        pi agent 内核（模型/工具循环/会话树/JSONL 存储）
src/                      领域层：卡、世界书、状态、场记、记忆、世界线、草稿
  stage/                  台上的引擎：装配、回合、工作区、工具、压缩、场记调度
.liyuan/extensions/       接线层：把领域能力挂到 pi 的钩子上
server/ + web/            Web 调度、WS/REST、前端
```

关键点：**领域层不依赖 pi**。`assemble.ts`、`workspace.ts`、`scribe.ts`、`compact.ts`、
`state.ts` 都是纯函数 + 注入依赖，可以离线单测。这是它能维持 800 项测试的原因。

### 1.2 一次演出的链路

对应 `src/stage/engine.ts → StageEngine.#turn()`（约 788 行起）：

```
每拍开演
  1. loadStageMaterials(cwd)          现读卡/世界书/预设/skills（mtime 指纹缓存）
  2. branch = 树上的当前分支 + 本拍用户消息
  3. state = stateFromBranch(branch)  最近一条 rp-state 快照 = f(分支)
     history = rebuildHistory(branch) 只留定稿正文，补丁已套，工具痕迹不存在
  4. 计算：在场、绿灯命中、面板快照、记忆被动召回、前情摘要
  5. buildStageSystemPrompt()          会话内字节稳定（吃前缀缓存）
     buildStageInjection()             每拍变化的数据块（世界状态/名录/设定索引/记忆）
  6. pi AgentSession.prompt()          模型多轮工具循环：
       draft_write / draft_append / draft_edit / draft_read / draft_search / draft_seal
       lorebook_search / memory_search / world_state_get / skill_read / ask / 媒体 / MCP
  7. 定稿合并：稿件为主体，text 通道里的格式尾巴按块并回
  8. 落树：assistant 只留正文 + thinking；工具过程进 details.rpTimeline（不进送模历史）
  9. 场记旁路：读「定稿正文 + 当前账本」→ patch → 确定性 apply → rp-state 快照（叶守卫）
 10. 长局压缩：到期待摘要 → rp-summary（覆盖锚点）→ 被覆盖原文归档进剧情库
 11. 世界线存档（模型调用 worldline_store 时才做，排在场记之后）
```

### 1.3 一层一层拆开看

- **上下文层**：`assemble.ts`。system 是一份字节稳定的长文；每拍的动态内容走末端
  user 消息；历史由分支重建，而不是 pi 的原始消息列表。**裁剪不是减法，是装配时就不存在。**
- **工作区层**：`workspace.ts`。本拍正文是一份带版本的工件（`TurnWorkspace`），
  `draft_append` 一段段加，`draft_edit` 按唯一原文引用改，`draft_seal` 收笔；
  中间稿、时间线、媒体交付都记在工件里，定稿时才落树。
- **记账层**：`scribe-run.ts` + `state.ts`。场记是廉价旁路模型，读定稿和当前账本出 patch；
  `applyPatch` 死板合并（白名单、clamp、数组整体替换）；写树前做叶守卫。
- **记忆层**：`compact.ts`（摘要）+ `memory/service.ts`（向量库）+ `card-memory.ts`（卡级复盘）。
- **交互层**：`ask` 工具在回合内弹选择卡；`worldline.ts` 把存档点组织成世界线树；
  `postprocess.ts` 决定标签是折叠、删除、去壳还是保留。

---

## 2. 七条底层逻辑

### 2.1 分支是唯一真相，所有视图都是投影

梨园把一切都记在会话树上：正文、`rp-state`（账本快照）、`rp-summary`（摘要）、
`rp-save`（存档）、`rp-draft-revision`（修订）、`liyuan-mode`（模式）、`rp-text-debug`（过程留档）。
**没有任何视图是独立存储的**：

- 历史 = `rebuildHistory(branch)`；
- 状态 = `stateFromBranch(branch)`，最近一条快照；
- 摘要 = `activeSummary(branch)`，最后一条摘要 + 覆盖锚点；
- 记忆召回 = 向量条目带 `nodeId`，只在该节点仍属当前分支祖先链时可见。

这带来三个结构性好处：回滚/重 roll/切线不会留下「旧世界」的残留；任何视图都可以重放；
旁路写入只要核对叶节点就能保证不写错线。

**对叙事台的启示**：v4 的 branches + copy-on-fork 已经是同一方向，但状态表是「复制」而不是
「投影」。复制能工作，但 fork 之后旧线的晚写会丢。叶守卫是比复制更便宜的正确性保险。

### 2.2 harness 管结构，模型管内容

这是梨园所有设计里最重要的一条。模型决定：这一拍演什么、分几段、查不查资料、要不要问用户。
Harness 决定：哪些内容能进上下文、按什么顺序、占多少预算、什么能落库、怎么落、显示成什么样。

因此：

- 旁白不用输出 JSON，记账归场记；
- 场记只出 patch，白名单与合并规则在代码里；
- 工具结果不落历史，正文才落；
- 摘要、归档、压缩由代码触发，不由模型决定；
- 显示策略由作者的正则/声明数据决定，不由 harness 猜标签名。

**对叙事台的启示**：v4 的「Agent 只提案」已经对了一半；缺的是**运行期结构权**——
现在旁白只有一次调用，harness 无法在拍内做「先查再写 / 分段 / 停下来问」。

### 2.3 上下文体积由「渐进披露」控制，不是由摘要控制

梨园把内容分成三档：

| 档位 | 内容 | 进入方式 | 例子 |
|---|---|---|---|
| 常驻 | 卡、人设、宪章、常驻世界书、工具协议 | 每拍都在 system | 角色定义、世界法则 |
| 索引 | 标题、名字、一句话 | 每拍注入一行/一表 | 设定集索引、登场名录 |
| 按需 | 全文、细节、旧原文 | 模型调工具才加载，用完即走 | `lorebook_search`、`memory_search`、`skill_read` |

关键不是「摘要得好」，而是**默认不把全文塞进去**。索引让模型知道「世界上有这东西」，
工具让它「需要时取得到」。这样一张 10 万字世界书的卡也不会把上下文撑爆。

**对叙事台的启示**：v4 的场记单是 eager 的：按 2400 tok 配额、每条 90 tok 估算，
大卡只能塞十几条。条目一多，低分条目整条消失，模型不知道它存在。
「索引 + 主动检索」是唯一能同时保住「知道有什么」和「读得到细节」的方案。

### 2.4 长篇连续性分两层：摘要管线索，检索管细节

梨园不要求一个机制同时做两件事：

- **摘要**（`rp-summary`）负责「前情」：谁做了什么、关系到哪、承诺与伏笔、当前场景。
  只覆盖早期，最近 6 拍永远逐字保留；每次压缩把上一份摘要合并进来，所以分支上只有一份有效摘要。
- **归档/向量库**负责「细节」：被摘要覆盖的原文完整入库，之后按需召回。
  摘要丢掉的对话、物件、数字，仍然可以 `memory_search` 找回来。

**对叙事台的启示**：现在 v4 只有「最近 N 轮原文 + 场景记录 + 断言」，没有摘要层。
超过最近窗口的剧情，只剩账本里的一行 `last_hook` 和几条断言。长局必然失忆。

### 2.5 质量来自工作区与节奏，不来自更多提示词

梨园早期也试过「在提示词里写死流程」，结果是模型把状态栏写进正文、把思考当正文交。
后来的做法是：

- 给模型一个**工作区**（`draft_append` / `draft_edit` / `draft_seal`），让它一段段写；
- 给模型**回执**（计划清单、当前稿、工具结果），让它在两次生成之间重新评估；
- 流程提示只留总纲，具体「现在第几步」由工件和轮次卡表达；
- 出问题先删一句，而不是加一句（`CLAUDE.md` 铁律一）。

`PLAN-ROUND-FLOW.md` 的原话：**计划是假设，不是剧本；每段之后都必须重新决策。**
`DRAFT-prompt-rp-agent.md` 则把「怎么演」写成有正反例的演出指导，而不是 API 说明书。

**对叙事台的启示**：现在的旁白提示已经不错（契约 + 尾注），但它是「一次交全文」。
如果要提升长篇质量，最有效的不是再加规则，而是给模型一个分段写的工件。

### 2.6 跨会话记忆是独立生命周期：复盘 → 合并 → 遗忘

梨园的卡级记忆（`card-memory.ts`）不是「把旧会话拼起来」，而是三份文件 + 一个清单：

```
记忆/
  常驻摘要.md      每拍注入，≤1200 字，借【前情提要】槽位
  记忆.md          按局分块的手册 + 跨局汇总，每条带 [局:id] 来源
  局/<id>.md       一局一份复盘
  .清单.json       指纹、上次合并见过的哈希、遗忘队列
```

两阶段旁路：

1. **局复盘**：子项目内容指纹变了 → 重写这一局的复盘（合并旧复盘，不丢事实）；
2. **合并**：复盘相对上次合并没有增/改/删 → 把变化并进手册和常驻摘要；
   删掉的局进「遗忘队列」，只删**只由它支撑**的条目。

**对叙事台的启示**：机制本身很好，但语义要先定。叙事台的会话是平行世界线，
不是同一世界的连续章节。建议做成「续作模式」：用户明确选择「这是上一条线的延续」时，
才把往局回忆当既定事实；否则最多作为「同卡的往局参考」，并明确标注不是本局事实。

### 2.7 可观测性是架构的一部分

梨园把「模型看到了什么」当成一等数据：

- `beatLog`：前端能看到的每个字、每次工具调用/回执、每次注入，按时序全记进会话；
- 装配报告：每块素材去了哪（预设槽位/兜底/被丢弃），落盘可查；
- 旁路回执：模型、思考档、**实收思考字数**、耗时；
- 上下文指示器：压缩后用「压掉的估算份额」折算，而不是等下一拍真实 usage；
- 结构化事件：压缩起止、模式切换、选择卡，前端不解析字符串反推状态。

**对叙事台的启示**：v4 的 `context.meta` 已经记录了在场、辞书、预算、降级，
但只存在 `lastAssembly` 内存 Map 里。把它写进 `turns.meta_json` 并做一个「本轮装配」面板，
成本很低，收益很大——所有「为什么这段设定没进去」的问题都会变得可回答。

---

## 3. 机制解剖（逐项）

> 每项：做法 → 为什么 → 代价/边界 → 对叙事台的启示。

### 3.1 会话树与 f(分支)

**做法**：`BranchEntryLike[]` 是根→叶的有序条目；`rebuildHistory`、`stateFromBranch`、
`activeSummary`、记忆召回全部接受同一份 branch。条目类型区分 message / custom_message /
custom / compaction / toolResult；`storyBranch()` 再按模式过滤维护轮。

**为什么**：回滚、swipe、重 roll、切线都是「换一个叶」，不需要删除或逆向修补任何表。
状态、摘要、记忆都跟着分支自动正确。

**边界**：树是只追加的，条目会越来越多；靠压缩与归档控制上下文，靠 JSONL 控制存储。

**启示**：叙事台的 branches 表已经够用，不需要改成树。但要把「所有派生数据都带
`branch_id + atTurn`」贯彻到底；目前 `summaries` 还没有，未来新增任何派生层都要带这两个坐标。

### 3.2 上下文装配：稳定 system + 末端注入 + 历史重建

**做法**（`assemble.ts:294-549`）：

- system：预设素材 + 卡 + 人设 + 常驻世界书 + 消息流约定 + MCP 索引 + 卡作者指令。
  会话内字节稳定，**MCP 工具也放 system**，避免每拍变化破坏前缀缓存。
- 历史：`rebuildHistory(branch)` 只留定稿正文；作者送模正则先跑，再走 `cleanAssistantText`；
  相邻同角色合并；`rp-summary` 覆盖的条目不进历史。
- 末端：`【世界状态】【登场名录】【活跃面板】【相关设定】【设定集索引】【剧情记忆】
  【卡作者末端指令】【语言】` 压在本拍用户原话之前，`injection + userText` 同一条 user 消息。
- 顺序铁律：**用户当拍的话必须在数据块之后**。放反了，模型会把提问读成历史旧话，
  既不检索也不正面回应（8/03 实测）。

**为什么**：稳定前缀吃缓存；动态内容放尾部吃注意力；历史重建保证工具过程永不污染上下文。

**边界**：system 一旦变化（换卡/改预设/改 MCP），本会话的缓存前缀作废；
所以所有「每拍会变」的内容一律不准进 system。

**启示**：v4 的分层已经是同一思路，但有两处可以对齐：
（a）把「本轮装配清单」持久化；
（b）任何新增动态内容都必须明确落在 system / recent / scene / current 的哪一层，
不能随手插在中间。

### 3.3 长局压缩（`rp-summary`）

**做法**（`compact.ts`）：

- `KEEP_RECENT_BEATS = 6`：最近 6 拍逐字保留，摘要只接更早的；
- `activeSummary(branch)`：最后一条 `rp-summary` + `coversThroughId`，其及之前的条目
  **装配时就不存在**；
- 每次压缩把上一份摘要作为 `<previous-summary>` 一起给模型，输出新摘要并覆盖更大区间；
- 压缩前把被裁正文完整归档进向量库（`memoryArchiveCompacted`），细节可召回；
- 叶守卫：调用前后叶 id 不等则整体丢弃；
- 压缩失败/未到期只跳过，下一拍再判。

**为什么**：摘要管连续性，原文管细节；两者分开，谁也不要求对方完美。
摘要滚动合并，避免「摘要的摘要」逐层失真。

**边界**：摘要仍然是有损的；所以保留最近 6 拍逐字，并且原文永不删除、可检索。

**启示**：这是叙事台最该补的一层。设计见 §5.1。

### 3.4 草稿工作区（`draft_*`）

**做法**（`workspace.ts`、`tools.ts:109-183`）：

- 本拍一份 `TurnWorkspace`，带 `version`、`draft`、`revisions`、`timeline`、`sealed`；
- `draft_append` 追加一段，`draft_edit` 按唯一原文引用批量替换（全部成功或全不改），
  `draft_read/search` 精确读取/检索，`draft_seal` 收笔；
- 所有写操作带版本号，冲突整批拒绝；
- 流式时把工具参数的 `content` 分片转发给前端，前端看到「正文一段段长出来」；
- 定稿时 `mergeFinalText` 把 text 通道里的格式尾巴按块并回，纯闲聊尾巴丢弃；
- `previous_draft_read/edit` 修订上一拍已定稿回复，修订落成 append-only 的 revision 条目。

**为什么**：一次交全文时，模型在落笔前就把剧情凝固了；分段写让它在每段之后看到新上文，
重新评估。版本化与定点改稿让「改一句话」不必重生成整篇。

**代价**：多轮调用、更多 token、前端要处理草稿流与重同步。

**启示**：叙事台可以先做「定点改稿」（不引入模型循环），再考虑「分段演绎」。

### 3.5 演员 / 场记 / harness 三层分工 + 叶守卫

> 注意：梨园当前版本**没有**独立的「校勘」「世界呼吸」「走向」Agent；
> `scribe.ts` 明确写着「连续性/代打等事后审查已移除（费 token 且用户反馈无用）」，
> `workspace.ts` 也写着「8/10 验收整体退役」。它保留的只有**场记（记账）**、
> **压缩（摘要）**、**卡级复盘/合并**三路旁路。这一点与叙事台正好相反——
> 叙事台的多 Agent 记忆管线比梨园更重。借鉴时应借「结构纪律」，不必借「更多 Agent」。

**做法**（`scribe-run.ts`）：

- 演员只写正文；场记旁路读「定稿 + 当前账本」出 patch；
- `applyPatch` 死板合并：白名单顶层键、`characters` 按名合并、`flags` 按键合并、
  `inventory/plot_threads` 整体替换、未知键告警；
- `canonicalizeCharacterKeys` 归一大小写/空白，防同一人记成两份；
- 叶守卫：`getLeafId()` 调用前后各取一次，不等则 `{kind:'stale'}`，不写树；
- 记账失败只跳过本拍，不影响正文；下一拍补上。

**为什么**：模型不直接写表；旁路调用是异步的，必须假设用户在期间会切线。

**启示**：叙事台的史官已经做到「只提案 + 确定性落库」，但**没有叶守卫**。
`/rollback` 和 `/rewrite` 直接调 `forkSession`，不进会话锁；一场正在跑的 archivist
完全可能在 fork 之后把结果写进旧分支。这是 P0 级正确性问题。

### 3.6 按需检索（lore / skill）

**做法**：

- 常驻世界书（`constant`）全文进 system；
- 关键词命中的绿灯**只给标题**（thinking 档），让模型自己 `lorebook_search` 取正文；
  off 档（无思考通道）才退回给正文的被动供料；
- 设定集索引：全部条目名字，2000 字符预算，按条目边界截断；
- `skill_read`：skills 目录的 `名字：描述` 进工具描述，正文读了才加载；
  工具结果不落历史，当拍结束即蒸发；
- `projectToolContext`：对重复/过期的读取结果做确定性剪枝，进一步压工具上下文。

**为什么**：索引给「知道有什么」，工具给「读得到细节」；两者都不依赖关键词注入。

**边界**：模型必须愿意调工具。梨园实测：off 档不调，所以有 `passiveLore` 兜底；
thinking 档也需要工具描述写得让模型判断得出「何时该查」。

**启示**：这是解决大卡上下文的最优解，但它要求**旁白有工具循环**。
如果不引入工具循环，就只能继续 eager 渲染；那时应至少把「未入选条目」的名字
放进索引，让模型知道它们存在（虽然读不到全文）。

### 3.7 ask：回合内的决策卡

**做法**（`tools.ts:153-181`、`engine.ts:1527`）：

- `ask(question, options)` 暂停工具循环，弹出 2-4 个选项；
- 用户作答 = 新的输入回喂模型，剩余计划据此重拟；
- 用户点停止 = 笔还给用户，本拍收束；
- 触发条件写得很克制：用户求方向/递笔；或用户输入引出的未定变量会明显分岔；
  预设自带选择框格式时按格式写进正文，不调 ask。

**为什么**：关键岔路让用户拍板，比事后给 3 条走向更沉浸；答案会真正改变这一拍的写法。

**启示**：v4 现在的走向 Agent 是「回合末给选项」，用户选了作为下一轮输入。
这已经覆盖了大部分价值。回合内 ask 需要可暂停/恢复的 SSE 与前端选择卡，
建议放在「分段演绎」之后，作为可选模式。

### 3.8 计划是假设（beat_plan + 轮次卡）

**做法**：

- `beat_plan` 列 2-8 条路标（每条 ≤60 字），plan 接受后才允许写正文；
- 每演完一段，模型必须重新评估：剩余路标还成立吗？不成立就重拟；
- harness 按状态注入轮次卡（规划轮 / 开工 / 演段回看），不把这些写死在常驻 system；
- 收笔条件是「戏到停点」，不是「清单勾完」。

**代价**：轮次卡是弱约束，模型会连发工具绕过；梨园试过「同轮只允许一次 append」的硬门禁，
后来又撤掉了。最终保留的是「计划是数据、回执是工件」的轻结构。

**启示**：叙事台没有 plan 层，也不需要照搬。真正可借的是**「回执驱动」**：
让模型看到自己刚写的东西、计划状态、工具结果，而不是靠提示词反复叮嘱。

### 3.9 卡级跨会话记忆

见 §2.6。补充实现细节：

- 触发是结构信号（进入某个会话时同步整张卡），不是模型决策；
- 输入是「各会话当前分支重建出的正文 + 既有摘要 + 账本」，与模型当时读到的同一份；
- 常驻摘要 + 世界状态 + 登场名录有总封套（`RESIDENT_ENVELOPE_CHARS = 4300`）；
- 用户手改两份文件视为有效记忆，合并时不许抹掉；
- 用户删掉一局复盘 = 遗忘；只删「只由它支撑」的条目；
- 并发安全靠内容指纹（`cardMemoryInputStamp`），期间文件被改则丢弃本次结果。

**启示**：机制可以借，但语义要先定（续作 vs 平行线）。如果做，建议：
`world_memory_recaps` + `world_memory` 两张表；常驻摘要走独立预算层；
默认关闭，会话设置里开「续作模式」；删除会话触发复盘删除与下一次合并的遗忘队列。

### 3.10 世界线存档

**做法**（`worldline.ts`）：存档是树上的 `rp-save` 条目；`planNewSave` 根据「当前分支上最近的存档」
与「是否存在分叉后的其他后继」决定是同线延长还是开新线；视图把存档组织成树/线，
支持命名、软删、按名或 id 查找。

**启示**：叙事台的 branch 只有 `b<timestamp>` + note，用户看不出「哪条线是哪条」。
可以低成本加「命名存档点」：branch 表加 `label`，前端展示世界线树。
但这是 UX，不是核心机制，P2。

### 3.11 输出策略引擎

**做法**（`postprocess.ts`）：标签按策略处理——`fold`（进思维链，正文去掉）、
`strip`（标签和内容都去掉）、`unwrap`（去壳留内容，默认）、`keep`（HTML 非散文元素）。
显示层先跑作者正则，再跑策略；送模历史另有一套「只在历史剥、显示照常」的标签。
不猜作者发明的标签名，未知一律 unwrap。

**为什么**：ST 生态的卡会输出各种自定义标签；猜名字会把正文删掉（梨园真出过事故）。

**启示**：叙事台不兼容 ST，不需要这套。但可以借一个很小的点：
**正文与「过程/格式块」分开存**——正文落 `turns.content`，思考/工具/格式尾巴落 `meta`；
任何时候都不要让格式块进入送模历史。v4 目前只存 thinking 到 `turns.reasoning`，
正文里的多余块没有处理；如果未来模型输出状态块，需要一个「历史清洗」的确定性步骤。

### 3.12 可观测性

**做法**：`beatLog`、装配报告、旁路回执、结构化压缩事件、上下文占用折算。
详见 §2.7。

**启示**：P0 级低成本改进：把 `context.meta` + `budget` 写进 narrator turn 的 `meta_json`；
新增一个「本轮装配」面板，展示层预算、在场、辞书候选与原因、降级标记、事实条数。
这会让 AGENTS.md 里「为什么这段设定没进去」从猜测变成查表。

### 3.13 旁路模型与配置分层

**做法**：`getSideEntry()` 给场记/压缩一个独立模型条目（模型 + 思考档 + 标签），
与剧情模型分开；每个 Agent 有自己的 temperature / maxTokens / reasoning；连接配置支持多模型与 profile。

**启示**：叙事台的 `config.agents` 已有每 Agent 的 effort/temperature/maxTokens，
但只有一个上游。加一个 `model` 覆盖（同一 baseUrl 下的便宜模型）成本极低，
可以显著降低史官/场记/校勘的成本。跨 provider 再考虑 baseUrl/apiKey 覆盖。

### 3.14 提示词纪律（梨园 `CLAUDE.md` 的四条铁律）

这是梨园用事故换来的，值得直接借成叙事台的工作规则：

1. **禁止堆叠提示词**：出问题先问「删掉哪句能解决」，不许靠再加一句；diff 让送模文案变长 → 违律。
2. **禁止堆叠注入**：注入通道是封闭集合；新增注入点 = 架构变更，必须回答「谁负责、落哪层预算」。
3. **禁止堆叠架构（识别器/名单/特判）**：不新增枚举作者措辞的正则/名单/启发式；
   让模型声明一次，声明落成数据，harness 死板执行数据。
4. **整体性思考**：改动前答出「全集是什么、现有机制谁负责、没见过的卡会怎样」，答不出就不动代码。

叙事台的 v4 已经有很强的「不猜、不触发、只渲染」立场，这四条是它的自然延伸。

### 3.15 向量记忆：分支感知的召回

**做法**（`src/memory/`）：

- 两个库：`narrative`（剧情库，只由 agent 合并写入）与 `external`（导入/手动的资料库）；
- 剧情库按 `everyNTurns` 合并写入，单条软上限 1800 字，总条数封顶；
- 嵌入支持本地规则（零依赖）与云端 embedding（独立配置，与剧情模型分离）；
- 每个 chunk 带 `nodeId`：只有该节点仍在当前分支的祖先链上，这条记忆才可见
  （`onCurrentBranch`）；老条目/非剧情库/取树失败一律放行（**fail-open**，宁可多召回不可整体消失）；
- 每拍开始前用玩家输入做 top-k 被动召回，5 秒超时，失败就当没有；
- 压缩掉的原文完整归档进剧情库，摘要管连续性、检索管细节；
- 另有 `memory_search` / `memory_read` 工具供模型主动查。

**为什么**：重 roll/rewind 丢弃的分支如果还能被召回，模型会把废弃剧情当「上一拍」续写。
给 chunk 加分支坐标是结构性解法，不需要任何启发式。

**启示**：叙事台目前只有 `searchTurns` 的子串检索。函数本身支持 `branchId` 过滤，
但路由层 `GET /api/sessions/:id/search` 是直接写 `LIKE`、只按 session 查，没有带分支，
也没有 `turn_no <= atTurn` 的时间点约束。如果做被动召回，必须：带
`branch_id + turn_no <= atTurn` 过滤、fail-open、超时、默认关闭；
否则会把废弃分支或未来剧情召回进当前拍。

### 3.16 四个容易误解的概念：剧情引擎 / 模型预设 / 世界书 / 专门 Agent

#### 3.16.1 剧情引擎：有「回合引擎」，没有「剧情 Agent」

- `src/stage/engine.ts` 的 `StageEngine` 是**回合引擎/编排器**：装配 → 模型工具循环 → 定稿 →
  场记 → 压缩 → 存档。它不生成情节，也不决定剧情走向。
- **没有独立的导演/剧情规划 Agent**。旧 `director.ts` 已于 2026-08-02 删除；
  `src/story-guide.ts` 名字像剧情引导，实际是卡空间/会话目录路由，与剧情无关。
- `beat_plan` 是**主演模型自己**的短计划，不是第二个 Agent；计划是假设，每段后重评。
- `scribe.ts` 明确写着「连续性/代打等事后审查已移除（费 token 且用户反馈无用）」；
  `workspace.ts` 写着「8/10 验收整体退役」。梨园**没有**校勘、世界呼吸、走向、验收 Agent。

**结论：不值得照搬「剧情引擎 Agent」。** 梨园的 SOTA 恰恰是反方向——不要让第二个 agent
去规划剧情；让主演在工作区里分段演，harness 只提供上文、回执、选择点。
叙事台已有的 branch / continuity / world tick 比梨园更多，不建议再加「剧情引擎」。
可借的相邻件是 `beat_plan` 的「计划是假设」（P1-1）和 `ask` 的岔路停笔（P1-3）。

#### 3.16.2 模型预设：两层，一层值得借，一层不要碰

- **连接/模型配置**（`src/agent-config.ts`）：providers（baseUrl/api/apiKey/models[]）、
  model entries（`id + label`，同一个 id 可有多条不同思考档）、默认条目、
  profiles（`liyuan-profiles/*.json`，整套模型方案存档/启用）、
  side model（`RpConfig.sideModel`，场记/压缩走独立模型）、`$ENV`/`!command` 密钥解析。
  **值得借**：side model + 每 Agent 模型覆盖（P1-5）；profiles 可后做；
  「按条目身份而不是 id 找模型」是细节但正确。
- **提示词预设**（`src/preset*.ts`）：ST 格式导入/编译、prompt_order、marker 槽位、
  声明站点（identity/writing/thinking/draft/output/memory/wrapper）、声明结果分流到
  `APPEND_SYSTEM.md` / 卡档案 / 停用。**格式不要碰**（ST 兼容被排除）；但借两个观点：
  1. **预设 = skill**（`docs/PLAN-RP-AGENT.md` §3.1）：方法论应像 SKILL.md 一样按需加载，
     常驻的只留身份/文风摘要；纪律用代码，不用提示词。这直接支持 P1-6 技法库。
  2. **声明站点作为数据**：模型声明一次，落成 JSON，harness 死板执行；不写正则/名单。
     可借到卡匠/小说导入管线。
- **采样参数**（`src/samplers.ts`）：temperature/top_p/top_k/frequency/presence/repetition，
  按 provider/model 投影（不支持的模型不发扩展键，Kimi 等固定采样模型直接不发）。
  **值得借**：叙事台只有 temperature/maxTokens；加 sampler 配置与投影是低成本高收益。
  但不要照搬 ST 预设解析，只借「一套参数 + 按模型投影」这个做法。

#### 3.16.3 世界书：机制完整，但一半是 v4 禁忌

- **有的**（`src/lorebook.ts`、`src/tools/lore.ts`、`src/lorebook-declare.ts`）：
  多书挂载、uid、keys、constant、enabled、order、search/toggle/write/update/delete/
  create/mount、overlay（卡的补充设定集）、判定文件（协议条目在导入时落成数据）、
  来源标注（`（预设）` / `（世界书·书名）`）、导出、MVU 规则归属剥离、协议检测。
- **值得借**：
  1. 标题索引 + 模型主动检索（P1-2，已拍板）；
  2. **来源/溯源字段**：叙事台的 `codex.canon_from` 只说明出自哪一章，没有「来自哪本书/
     哪次导入/哪次卡匠产出」；加 `source` 是低风险；
  3. **补充设定集（overlay）**：用户/模型新增的设定不污染原卡；叙事台有 `world_state`
     （会话级）与 `canonizeSession`（显式固化），中间缺一个「卡级补充层」；
     可作 P2，但必须守住原则 11（不写回 `card_json`）；
  4. **判定数据化**：协议条目由导入时产出一份 JSON 判定，harness 只执行数据；
     没有数据就不动作。这个「声明一次 → 数据 → 死板执行」模式适合卡匠/导入管线；
  5. **enabled/muted 开关**：作者可以临时停用某条辞书；叙事台只有 `pinned`，没有 `muted`。
     低风险，但要想清楚与 `reveal` 的关系。
- **不要借**：`keys` / `triggers` / `constant` / 递归扫描 / `priority` / `scanEntries`
  （v4 明文禁忌）；ST 世界书格式与导出；MVU / 状态栏 / 协议识别。

#### 3.16.4 专门 Agent：梨园比叙事台少，不是多

- **有的三路旁路**（全部是「廉价模型 + 提案 + 确定性落库 + 叶守卫 + fail-open」）：
  - 场记（`scribe-run.ts`）：读定稿 + 当前账本 → patch；
  - 压缩（`compact.ts`）：读被裁原文 + 上一份摘要 + 账本 → 摘要；
  - 卡级复盘/合并（`card-memory.ts`）：局复盘 → 手册/常驻摘要 → 遗忘。
- **没有的**：校勘、世界呼吸、走向、验收、导演。它们要么被删除，要么从未在 1.6.4 存在。
- **值得借**：旁路模型 + 提案/执行分离 + 叶守卫 + fail-open（叙事台已有提案/执行，
  缺 side model 与叶守卫）；卡级复盘/合并/遗忘（若做续作模式）。
- **不要借**：不要因为「梨园有 agent」就加 agent。反过来，叙事台应审视现有
  continuity / world tick 的 token 收益，给它们开关与成本可见性；不要新增 LLM 验收/裁判
  （梨园已撤，叙事台也没有，保持）。

---

## 4. 与叙事台的逐项对照

| 维度 | 叙事台 v4 | 梨园 1.6.4 | 差距/判断 |
|---|---|---|---|
| 回合形态 | 固定管线：装配 → 旁白单发流式 → 史官 → 场记/校勘/呼吸 → 走向 | Agent 循环：多轮工具（草稿/检索/计划/ask/媒体），harness 定稿 | 叙事台更简单、延迟低；梨园更灵活、长篇控制更强 |
| 上下文真相 | 会话快照 + 分支级记忆表 | 只追加树 + 全部视图 = f(分支) | 方向一致；叙事台缺「摘要」与「叶守卫」 |
| 长程记忆 | 最近 N 轮原文 + 场景/断言/账本；无滚动摘要 | 最近 6 拍逐字 + 滚动摘要 + 归档检索 | **最大缺口** |
| 设定进场 | 世界索引常驻 + 场记单 eager 渲染（实体/标签/钉选） | 常驻 + 标题索引 + 模型主动检索 | 小卡够用；大卡会漏条目 |
| 状态记账 | 史官强类型 JSON（断言/状态/关系/线索/原声/world_state），确定性落库 | 场记扁平账本 patch，确定性合并 | 叙事台更精细（有效期、冲突失效）；梨园更轻 |
| 冲突处理 | 断言失效不删除，带有效期 | 账本覆盖式；名录追加式 | 叙事台更强，保持 |
| 分支 | branches + copy-on-fork；重写=开新分支 | 树 + 叶守卫 + 命名存档 | 叙事台缺守卫与命名 |
| 修订 | 重写=开新分支重跑；手工改正文不重跑记忆 | 版本化草稿 + 定点 edit + 上一拍修订 | 叙事台缺「只改一段」 |
| 用户参与 | 回合末 3-4 条走向 | 回合内 ask 选择卡 + 回合末选项 | 叙事台够用；ask 可选 |
| 可观测性 | SSE budget/meta；内存中的 lastAssembly；usage | beatLog/装配报告/旁路回执/压缩指示 | 叙事台需要持久化 |
| 模型分工 | 单上游 + 每 Agent 档位 | 主模型 + 旁路模型 + 多 profile | 加 side model 成本低 |
| 提示词 | 一条 system + 场记单 + 尾注 | 稳定 system + 每拍注入 + 工具 schema + 轮次卡 | 叙事台更简洁；纪律可借 |
| 扩展 | 无工具循环 | 统一工具层、MCP、媒体、skills | 看是否要走分段演绎 |

---

## 5. 借鉴清单（按优先级）

> 每项都给出：解决的问题 → 梨园做法 → 在 v4 里怎么落 → 与原则的关系 → 验收标准。
> 「落地设计」是建议，不是已实现的事实；实施前按 AGENTS.md 的流程改 CONTRACTS 与测试。

### P0-1 滚动前情提要（2026-10-23 已实施）

**解决的问题**：超过最近窗口的剧情完全消失，只剩账本与断言。长局人物声音、未回收细节、
承诺与伏笔都会丢。

**梨园做法**：`rp-summary` + `coversThroughId` + 最近 6 拍逐字 + 合并上一份摘要 +
被裁原文归档进检索库。

**v4 落地设计**：

1. 新表 `summaries`：
   ```sql
   summaries(id, session_id, branch_id, covers_turn_to, text, prev_id,
             token_count, created_at)
   ```
   一个分支只有一条有效摘要 = `covers_turn_to` 最大且 `<= 当前装配回合` 的那条。
2. `context-engine.assembleContext()`：
   - 读取有效摘要；
   - 在 system 之后插一条 `{role:'user', content:'【前情提要】...'}`；
   - 最近原文只取 `turn_no > covers_turn_to` 的回合，再按 `BUDGET_RECENT` 裁剪；
   - 若最近原文首条也是 `user`，与摘要合并成一条（部分 OpenAI 兼容上游不接受连续 user）。
3. 压缩入口放在 `orchestrator` 回合末（史官之后、走向之前或之后均可）：
   - 触发：可见回合数 ≥ `KEEP_RECENT + SUMMARY_EVERY`，且待摘要原文 ≥ 阈值；
   - 输入：待摘要区间的**完整原文**（turns 表，player + narrator）+ 上一份摘要 + 当前账本；
   - 输出：新摘要，覆盖到 `maxTurn - KEEP_RECENT`；
   - 写新行，不删旧行；失败只跳过。
4. 分支：
   - `copyBranchState()` 复制 `covers_turn_to <= forkTurn` 的最新摘要到新分支；
   - 新分支不会继承覆盖分叉点之后内容的摘要。
5. 预算：
   - 新增 `BUDGET_SUMMARY`（建议 1800 tok）；
   - 降级顺序改为：场记单（保留头 600）→ 摘要（保留头 600）→ 最近原文减半 → 截最长非 system。
   - 理由：最近原文是续演点，优先保住；摘要是压缩过的，截尾损失最小。
6. 提示词：
   - 摘要块用固定头 `【前情提要】以下是更早剧情的接力摘要，是既定事实。`；
   - 摘要提示词按固定结构输出：`## 前情提要`（按时间顺序）/ `## 人物`
     （性格、称呼、关系温度与演变）/ `## 承诺与伏笔`（宁多勿漏）/ `## 事实账`
     （物品归属、伤势、数值、剧内第几天）/ `## 当前场景`（续演点，必须是最新场景）；
   - 只记录已发生的事，不虚构、不评论、不续写、不预测；人名地名保持剧中写法；
   - 二次压缩时把上一份摘要作为 `<previous-summary>` 一并给模型，要求合并而非重写。
7. 事件与 UI：
   - 新增 SSE `summary`（start/end/ok/skipped）或复用 `memory` 统计；
   - 记忆面板显示「当前摘要覆盖到第 N 轮」与摘要全文，可手动重压。
8. 测试：
   - 压缩后旧回合不在 messages、摘要在场、最近 N 拍逐字仍在；
   - 连续两次压缩，第二次提示里包含上一份摘要，新摘要覆盖更大区间；
   - 1000 轮模拟体积不随轮数增长（`check-context.mjs` 扩展）；
   - fork 不继承覆盖分叉点之后的摘要；
   - 压缩失败不影响回合落库。

**与原则的关系**：
- 原则 4「原文是唯一真相」：摘要只影响装配，不改写 `turns`，原文仍可查 → 兼容。
- 原则 10「体积与轮数无关」：摘要是一个有界层 → 需要把「四层」改成「五层」，这是**显式修订**，不是偷偷加。
- 原则 9「只有一条 system」：摘要用 user 消息 → 兼容。

**验收标准**：100 轮会话中，第 50 轮之前的关键人物/承诺仍能在第 100 轮的上下文中出现；
上下文总量保持在 `CONTEXT_SOFT_TOKENS` 附近。

---

### P0-2 异步写入的分支/叶守卫（推荐立即做）

**解决的问题**：`runTurn` 有会话锁，但 `/rollback`、`/rewrite` 直接调 `forkSession`，
不进锁。正在跑的史官/场记/校勘/走向可能在 fork 之后把结果写进旧分支，
新分支拿不到这次写入；或者旁路读到的是旧分支状态。

**梨园做法**：所有旁路写入在调用前后取 `getLeafId()`，不等则整体丢弃；
丢弃是安全的，因为状态 = f(分支)。

**v4 落地设计**：

1. 新增 `captureBranchContext(sessionId)` → `{branchId, maxTurnNo}`；
2. 新增 `assertBranchUnchanged(ctx)`，返回布尔；
3. 在所有旁路写入前核对：
   - `runArchivist` 的 `applyArchivistUpdate`；
   - `closeScene`、`runWorldTick`、`runContinuity`、`runBranchAgent` 的落库；
4. `forkSession` 改为 async 并获取会话锁（与 `runTurn` 同一把），避免 fork 与回合并发；
   `/rollback`、`/rewrite` 改为 `await forkSession(...)`；
5. 丢弃时写一条 `patches` 记录：`status='stale'`, `agent=...`, `payload={reason:'branch changed'}`，
   便于审计，而不是静默消失；
6. 测试：
   - 注入一个延迟的 archivist 调用，期间调用 `forkSession`，断言旧分支不再新增断言/状态；
   - `/rollback` 在一个正在跑的回合期间返回「等待回合结束」或排队，而不是立即分叉。

**与原则的关系**：原则 6「回滚=开新分支」与原则 5「断言失效不删除」都不变；
这是补上「异步写入不能写错分支」的结构性保证。

**验收标准**：并发 fork × 旁路写入的测试通过；任何 stale 丢弃都有审计记录。

---

### P0-3 每轮装配清单持久化（推荐立即做）

**解决的问题**：`lastAssembly` 只在进程内存；刷新后「这一轮为什么没注入某条设定」无从查起。
记忆面板只能看到最近一次，且不精确到回合。

**梨园做法**：装配报告落盘 + beatLog 全量时序 + 旁路回执。

**v4 落地设计**：

1. `orchestrator` 在 `assembleContext` 后，把以下内容写进 narrator turn 的 `meta_json`：
   ```js
   {
     assembly: {
       budget: {system, recent, scene, current, total, soft_max, hard_max},
       present: [{id, name, role}],
       codex: [{id, name, why, score}],
       theme_tags: [...],
       facts: n,
       world_state_changes: n,
       summary: {covers_turn_to, tokens} | null,
       degraded: [...],
       model: {name, effort, temperature},
     }
   }
   ```
   注意 `addTurn` 目前覆盖 `meta_json`，要保留已有的 `model/finish_reason` 字段。
2. `GET /api/sessions/:id/turns` 已经返回 `meta`，前端无需新接口；
   在 `web/js/panels/memory.js` 增加「本轮装配」区块。
3. `docs/CONTRACTS.md` 补 `turns.meta.assembly` 的形状。
4. 测试：装配后 `getTurn(...).meta.assembly.budget.total > 0`；降级时 `degraded` 非空；
   fork 后旧回合的装配清单仍可读。

**与原则的关系**：不改变任何装配行为，只是把已有元数据持久化 → 完全兼容。

**验收标准**：任意一轮都能回答「系统层/最近原文/场记单各占多少、哪些辞书条目为什么进场」。

---

### P0-4 定点改稿 + 上一拍修订（推荐第二批）

**解决的问题**：现在 `/rewrite` 是「fork + 整轮重跑」；改一句话要重生成整篇，
且旧线被标 abandoned。用户想「只改这一段」时没有工具。

**梨园做法**：`draft_edit` 按唯一原文引用批量替换；`previous_draft_read/edit`
修订当前分支上一拍已定稿回复；修订是 append-only 的 revision 条目。

**v4 落地设计（不做工具循环，先做 API + UI）**：

1. 新接口 `POST /api/sessions/:id/turns/:turnNo/revise`（SSE 或 JSON）：
   - 入参：`{instruction, selection?: {start, end}, mode: 'replace'|'rewrite'}`；
   - `replace`：用户给出 `old` / `new`，直接精确替换（确定性，不调模型）；
   - `rewrite`：把该轮正文 + 指定选区 + 指令 + 该轮装配清单里的场记单摘要交给模型，
     要求**只输出替换后的选区文本**，不重写其他部分；
   - 写回 `updateTurnContent()`，`meta.revised = {at, instruction, mode}`；
   - 默认**不重跑史官**：正文修改不自动改写记忆（与原则 4 的例外一致）；
     提供「重算这一轮记忆」按钮，走「从这一轮重写」的分支流程，避免在同一分支上产生重复断言。
2. UI：正文选中 → 「改写这段」浮层；输入指令；展示 diff；确认后写回。
3. 测试：replace 精确替换；rewrite 只改选区；其他段落逐字不变；`edited` 标记与 meta 正确；
   不触发 archivist。

**与原则的关系**：原则 4 明确「手工编辑正文是唯一例外，且不自动重跑记忆」——
这个设计正是把该例外产品化，兼容。

**验收标准**：改 200 字的一段，不重生成整篇；其余段落 diff 为空；记忆表无新增。

---

### P1-1 演员工具循环（分段演绎，可选模式；2026-10-24 第一阶段已实施）

**解决的问题**：一次交全文，模型在落笔前凝固剧情；大卡无法按需查设定；
无法在拍内停下来问用户。

**梨园做法**：`draft_append/edit/seal` + `lorebook_search/memory_search/world_state_get/skill_read/ask`，
`MAX_ROUNDS` 安全阀，工具结果不落历史，定稿只留正文。

**v4 落地设计（建议做成 `settings.narration_mode: 'single' | 'segmented'`）**：

1. 新增 `runNarratorLoop()`，输入仍是 `context.messages`，但附带工具 schema；
2. 工件：内存中的 `draft`、`version`、`timeline`；工具结果只进临时消息列表；
3. 工具集（第一版只放 4 个）：
   - `draft_append` / `draft_edit` / `draft_seal`；
   - `codex_lookup`（见 P1-2）；
   - 可选 `ask`（见 P1-3）；
4. 轮数上限 6；每次生成后若没有工具调用则自动定稿；
5. 落库：只写 `turns(kind='narrator', content=finalText)`；
   `meta.timeline` 记录 thinking/tool/正文段，供 UI 重放；
6. 预算：工具结果属于 current 层，设 `BUDGET_TOOL_RESULTS`（建议 1200 tok），
   超出按最旧丢弃；不进入 recent；
7. SSE：新增 `draft_start/draft_delta/draft_done`；保留 `narrative` 作为兼容；
8. 测试：工具结果不进下一轮 recent；定稿只落一份正文；空稿/中断降级为直出；
   与 `/v1` 的流式翻译兼容（`openai.js` 只把正文当 content）。

**风险**：延迟与成本上升；模型可能连发工具。建议默认关闭，只对「长篇/大卡」会话开启；
保留 `single` 作为回退。

**与原则的关系**：原则 8「旁白只写正文」仍然成立——工具只写草稿，最终仍只落正文；
原则 9「一条 system」不变；原则 10 需要新增 current 层的工具结果预算。

---

### P1-2 辞书标题索引 + 检索工具（2026-10-23 已实施最小形态）

**解决的问题**：`scene * 0.45 / 90` 只能塞十几条；大卡的其余条目对模型等于不存在。

**梨园做法**：`formatLoreIndex` 全量标题（2000 字符，按条目边界截断）+ `lorebook_search`。

**实现前提**：「允许主动检索」需要一条**模型发起查询**的通道。最小实现不是完整的 P1-1 工具循环，
而是「检索预检 + 单发演绎」：

```
assembleContext()
  → 主模型做 0~3 次 codex_lookup（只有这个工具；结果进临时消息，不进 turns）
  → 把命中的条目全文压成一段【检索结果】（current 层）
  → runNarrator() 正常流式写正文（仍然只发一次、只落一条 narrator）
```

这样不改草稿工作区、不改 SSE 正文协议，只多一次「检索决策」调用；
完整的分段演绎工具循环仍按 P1-1 单独拍板。检索预检可只在「卡很大 / 场记单被截断」时触发，
避免每拍都多一次调用。

**v4 落地设计**：

1. **索引**：在 `renderSceneSheet` 末尾增加 `【辞书索引】共 N 条：标题A、标题B……`，
   只列**未被选中**的条目，预算 `BUDGET_INDEX`（建议 600 tok）；
   超预算时按条目边界截断并注明「另 N 条未列出」。
2. **检索**：`codex_lookup(query, limit)`，在 `name/aliases/summary/tags/facets` 上做
   确定性匹配（最长别名匹配优先，再子串，再标签），返回 1-3 条全文；
   没有检索通道时只加索引、不加工具（否则模型看得到名字却拿不到正文，反而更差）。
3. **不变量**：检索是**模型主动行为**，不是关键词自动注入；`linkEntities` 仍然只负责在场判定，
   不因为检索结果改变在场。
4. 预算：索引属于 scene 层（每场变一次），检索结果属于 current 层（当拍蒸发）。
5. 测试：大卡（200 条 codex）下，索引包含未入选条目标题；检索能按别名命中；
   检索结果不进入下一轮 recent；`meta.codex` 仍记录自动入选条目。

**与原则的关系**：需要修订原则 1/2 的表述：
「辞书进场只有三条路」→「三条自动路 + 一条模型主动检索路；没有任何关键词自动注入」。
这是显式修订，写在 AGENTS.md 与 CONTRACTS 里。

---

### P1-3 回合内 ask（2026-10-24 暂缓 / 待确认）

> **暂缓决定**：用户判断其交互成本可能高于 galgame 式选项，且会把回合变成有状态 SSE。
> 当前不实现；先用回合末走向与玩家自由输入验证真实长局。若模型频繁替玩家做不可逆选择，
> 再按“仅 Web、默认关、每回合最多一次、带『让旁白决定』”的克制版重新评估。

**解决的问题**：关键岔路在落笔前就该由用户拍板，而不是写完再给三条走向。

**梨园做法**：`ask` 工具暂停循环，选项卡回来，答案作为新输入继续同一拍。

**v4 落地设计**：

1. 服务端维护 `pendingAsks: Map<id, {resolve, reject, sessionId, turnNo}>`；
2. SSE 发 `{type:'ask', id, question, options}`；
3. 新接口 `POST /api/sessions/:id/asks/:askId` 传答案，resolve promise；
4. 用户停止/disconnect → reject，回合收束；
5. 答案回喂给模型，继续本轮工具循环；
6. 前端复用现有 `actionSheet` / `sheet` 浮层；
7. 触发条件写进工具描述：用户求方向、身份未定、场景 2+ 岔路；
   不要每拍都问（梨园踩过「每段都 ask」的过度使用）。

**风险**：状态化 SSE、断线恢复、并发控制。建议 P1 后段再做。

---

### P1-4 卡级跨会话记忆（2026-10-24 已决定不做）

**解决的问题**：同一张卡的不同会话之间没有连续性；用户想「接着上一局」只能手动复制设定。

**梨园做法**：复盘 → 合并 → 遗忘，三份文件 + 清单；常驻摘要 ≤1200 字，总封套 4300 字。

**v4 落地设计**：

1. 语义先定：
   - **续作模式**（`session.settings.memory_mode = 'continuation'`）：往局回忆是既定事实，
     可进入摘要层；
   - **默认模式**：不注入任何往局内容，避免平行世界线互相污染。
2. 表：
   ```sql
   world_memory_recaps(world_id, session_id, branch_id, through_turn, text,
                       source_fingerprint, created_at)
   world_memory(world_id, kind, text, updated_at)  -- kind: handbook | resident
   ```
3. 触发：显式「结束本局并复盘」按钮；开新局时若开了续作模式，先同步未复盘的会话。
4. 注入：`【往局记忆】` 块，独立预算 `BUDGET_WORLD_MEMORY`（建议 1200 tok），
   位于前情提要之后、场记单之前；块头必须写明「这是同一张卡其他世界线的记忆，
   不是本局既定事实」——除非当前是续作模式。
5. 遗忘：删除会话 → 删除对应 recap；下一次合并只删「只由它支撑」的条目。
6. 测试：平行线模式不注入；续作模式注入；删除会话后条目被遗忘；
   常驻摘要超预算截断；用户手改文件不被覆盖。

**风险**：产品语义复杂，容易把不同世界线混在一起。建议作为 P1 后段/可选功能。

---

### P1-5 旁路模型与每 Agent 模型覆盖（低成本）

**做法**：
- `config.agents.<agent>.model`（可选）；
- `llm.buildBody` 已经支持 `opts.model`，只需在 `runArchivist` / `runSceneKeeper` /
  `runContinuity` / `runWorldTick` / `runBranchAgent` 的 `chat` 调用里传
  `model: options.model ?? cfg.model`；
- `.env.example` 增加 `ARCHIVIST_MODEL` / `SCENE_KEEPER_MODEL` / `CONTINUITY_MODEL` /
  `WORLD_TICK_MODEL` / `BRANCH_MODEL`；
- UI 设置页展示「剧情模型 / 旁路模型」两行；
- 测试：mock `fetch` 断言 model 字段。

**收益**：史官/场记/校勘可以用便宜模型，剧情模型保持高质量；成本与延迟双降。

---

### P1-6 技法库（skills，依赖 P1-1）

**做法**：`skills` 表（`world_id`, `name`, `description`, `body`, `enabled`）或会话级 `notes(kind='skill')`；
工具 `skill_read(name)` 返回全文，结果不落历史；描述进入工具清单。
适用内容：文风指南、类型片套路、场景包、作者方法论——这些不该常驻 system。

**与原则的关系**：新增一个「按需」通道，必须给它独立预算（current 层），
并且**不能**用关键词触发；模型看描述自己决定读不读。

---

### P1-7 采样参数配置 + 按模型投影（低成本，建议做）

**解决的问题**：叙事台每个 Agent 只有 `temperature` / `maxTokens` / `reasoningEffort`；
没有 `top_p` / `top_k` / `frequency_penalty` / `presence_penalty` / `repetition_penalty`，
文风控制手段不足。

**梨园做法**（`samplers.ts`、`preset.ts:34`）：把一套采样参数保存在配置里，
发请求时按 provider/model 投影——核心 OpenAI 键默认带，扩展键只给认它们的源；
对固定采样模型（如 Kimi 某些版本）直接不发，避免 4xx。

**v4 落地设计**：

1. `config.agents.<agent>.samplers`（或全局 `samplers` + 每 Agent 覆盖）；
2. `llm.buildBody` 增加 sampler 白名单与按模型投影；
3. 设置页展示可编辑参数，默认折叠（高级）；
4. 测试：mock `fetch` 断言只发目标模型支持的键；不支持的键不出现。

**与原则的关系**：只影响请求参数，不进提示词、不进上下文 → 完全兼容。

---

### P2 级（先记下，不急）

- **命名存档点/世界线视图**：branch 表加 `label`，前端展示分叉树。
- **分支感知的 FTS5 回忆 + 被动召回**：SQLite `FTS5` 对 `turns.content` 建索引，
  按 `branch_id + turn_no <= atTurn` 过滤；每轮用玩家输入做一次 top-k 召回，
  作为 `【记忆召回】` 块（独立预算，默认关）。这会把「检索」引入装配层，
  与原则 1 有张力，必须显式开关。
- **统一工具注册表**：如果 P1-1 落地，把工具 schema/执行统一成 `ToolSpec`，
  依赖缺失的工具不上清单；方便单测。
- **场景索引 UI**：把 `scenes` 渲染成时间线，让用户看到「故事到哪了」。
- **辞书来源/溯源 + `muted` 开关**：codex 增加 `source`（来自哪本书/哪次导入/卡匠产出）
  与 `muted`（作者临时停用）；两者都是数据字段，不改变进场路径。
- **卡级补充设定层（overlay）**：用户/模型新增的设定存独立表，不写回 `card_json`；
  需要先明确与 `canonizeSession()` 的边界（原则 11）。

---

## 6. 明确不借的部分

| 不借 | 原因 |
|---|---|
| SillyTavern 卡格式 / 世界书 keys / triggers / priority / constant | 用户明确排除；且与 v4 原则 1 直接冲突 |
| regex_scripts / 状态栏 / MVU / EJS / TavernHelper | ST 生态兼容层；叙事台没有这个输入面 |
| 预设拆层 / 格式栈 / 标签识别器 | 同上；梨园自己也在收缩 |
| `scanEntries` 关键词绿灯注入 | 这是 lorebook 式注入的残留，v4 的禁忌 |
| 文件树 + JSONL 会话存储 | 迁移成本高；SQLite 分支模型已足够 |
| 同轮只允许一次 append 的硬门禁 | 梨园试过又撤了；会与模型手速打架 |
| 卡片工坊 / agent 模式 / 沙箱 | 产品范围不同 |
| 过度的轮次卡 / 流程提示堆叠 | 梨园 `CLAUDE.md` 明确反对，且实测会诱发「执行流水线」模式 |

---

## 7. 建议的落地顺序

### 迭代 1（1-2 天，纯增量，不动主链路）

1. P0-2 叶守卫（最高优先级：这是正确性 bug）；
2. P0-3 装配清单持久化；
3. P0-1 滚动前情提要（表 + 装配 + 压缩 Agent + 测试）。

**为什么不先做工具循环**：前三项都不改变旁白路径，风险低、可独立回滚；
而且 P0-1 会立即改善长局体验。

### 迭代 2（3-5 天，产品体验）

4. P0-4 定点改稿 + 上一拍修订；
5. P1-5 旁路模型；
6. P1-7 采样参数；
7. 记忆面板的装配视图与摘要视图。

### 迭代 3（1-2 周，架构升级，可选）

8. P1-2 辞书索引 + 检索预检（先做「0-3 次 codex_lookup → 单发演绎」，
   不要求完整工具循环）；
9. P1-1 分段演绎（默认关，按会话开）；
10. P1-3 回合内 ask；
11. P1-6 技法库。

### 迭代 4（可选，先定语义）

11. ~~P1-4 卡级跨会话记忆（续作模式）~~ — 2026-10-24 决定不做。

### 实施记录（2026-10-23 / 2026-10-24）

| 项 | 落地位置 | 备注 |
|---|---|---|
| P0-1 滚动前情提要 | `store.js`（`summaries` 表 / `getActiveSummary`）、`agents/summarizer.js`、`prompts/summarizer.js`、`context-engine.js`（第五层 + 降级） | 每 `SUMMARY_EVERY` 轮压缩到 `turnNo - SUMMARY_KEEP_RECENT`；`planSummary()` 纯函数；fork 时复制覆盖范围内的摘要 |
| P0-2 分支/叶守卫 | `memory/branch-guard.js`、`orchestrator.js`（`forkSessionSafe` + 各旁路 Agent guard） | 用 `MAX(id)` 水位线判断，而不是 `turn_no`（同轮 narrator 行会共享 turn_no） |
| P0-3 装配清单 | `orchestrator.js → buildAssemblyMeta()`，写入 narrator 回合 `meta.assembly` | 与 `state_json` 分离，便于事后回答「这一拍为什么这样写」 |
| P1-2 主动检索 | `agents/retrieval.js`、`prompts/retrieval.js`、`scene-sheet.js`（`lookupCodex` / `renderCodexHit`） | 只产 `queries` 与命中的辞书全文；结果进 `retrieval` 子层且当拍蒸发，不做关键词注入 |
| P1-5 旁路模型 | `config.js` 各 Agent 的 `model`；`llm.js` 已支持 `opts.model` | 环境变量为 `<AGENT>_MODEL`（summarizer 用 `SUMMARY_MODEL`）；调用方仍可传 `options.model` |
| P1-1 分段演绎（第一阶段） | `agents/narrator-loop.js`、`prompts/narrator.js`（`segmentedInstruction`）、`llm.js`（`tools`）、`orchestrator.js`（模式选择 + 回退）、`play.js`（`draft_*` 事件） | 工具只含 `draft_append` / `draft_edit` / `draft_seal` / `codex_lookup`；默认 `single`；工具结果当拍蒸发；`ask` 留到 P1-3 |
| P1-4 卡级记忆 | — | 2026-10-24 决定不做；需要正史化时继续走 `canonizeSession()` |

未做项与依赖关系保持 §7 的顺序；P1-1 的 `ask` 与完整工具注册表仍待后续。

### 真实运行观察（2026-10-24，step-5-preview）

用 `_work/real-segmented-run.mjs` 与 `_work/real-tool-probe.mjs` 在临时库上真实跑：

| 场景 | 结果 |
|---|---|
| 分段局 3 轮（首版提示词） | 正文 1446 / 1914 / 1451 字；`rounds=1, tools=0`；第 3 轮 `completion_tokens=6000` 正好触顶，结尾被截断 |
| 单发对照 1 轮 | 正文 1709 字；整轮 348.8s；narrator 自身 148.4s |
| 增强提示词后探针：问司楼 | `rounds=1, tools=0`，1828 字；司楼已在场记单，模型认为无需再查 |
| 增强提示词后探针：问玉佩 | `rounds=2, tools=codex_lookup(ok)`，1328 字；工具链路真实可用 |

结论：

1. **工具调用只在“场记单不够”时发生**。不要强迫每轮查辞书；当前提示词的条件性要求是合适的。
2. **6000 的轮上限会截断正文**：推理过程计入 `max_tokens`，已把默认值改成 12000；
   这是真实运行发现并修复的 bug，不是理论风险。
3. **整轮延迟主要不在分段循环**：narrator 自身约 96–148s，整轮 200–400s，
   差额来自史官/走向等后处理。评估性能时要分开计时。
4. 文风与连续性在 3 轮真实跑中保持稳定（纸团、黎婆、凌玥的动作都能接上），
   分段模式没有破坏原有 narrative 质量。

---

## 8. 需要拍板的设计决定（汇总）

| # | 决定 | 状态 | 影响面 |
|---|---|---|---|
| 1 | 是否接受第五层预算（摘要） | **已接受**；`BUDGET_SUMMARY=1800` | AGENTS.md §6、config、context-engine、测试 |
| 2 | 是否允许模型主动检索辞书 | **已允许**；最小实现为「检索预检 + 单发演绎」，不要求完整工具循环 | AGENTS.md §1.1/§5.1、CONTRACTS、工具层 |
| 3 | 卡级记忆的语义 | **已决定不做**（2026-10-24）；重开一局更干净，正史化走 `canonizeSession()` | 无需新表/新注入层 |
| 4 | 是否引入完整工具循环 | **已采纳**（2026-10-24）：先落地草稿 + `codex_lookup`，`ask` 等循环稳定后再加 | 新增 `narration-loop`、工具预算、SSE `draft_*` |
| 5 | 是否实现回合内 `ask` | **暂缓 / 待确认**（2026-10-24）：有状态 SSE 与打断阅读的交互成本可能高于收益；先用回合末走向和自由输入 | 若重启：仅 Web、默认关、每回合最多一次、必须带「让旁白决定」 |

---

## 9. 证据索引（梨园的「做法」出处）

| 机制 | 文件 |
|---|---|
| 装配 / 历史重建 / 注入 | `src/stage/assemble.ts:144,246,294,470` |
| 回合 / 工具循环 / 定稿 | `src/stage/engine.ts:788,1324,1426,1472` |
| 草稿工作区 | `src/stage/workspace.ts:81,131,287` |
| 场记 + 叶守卫 | `src/stage/scribe-run.ts:59` |
| 压缩 | `src/stage/compact.ts:41,116,235` |
| 工具 schema | `src/stage/tools.ts:24,60,109,153` |
| 素材装载 / 缓存 | `src/stage/materials.ts:269` |
| 工具上下文剪枝 | `src/stage/context.ts:2` |
| 状态账本 | `src/state.ts:88,203,313` |
| 场记提示词 | `src/scribe.ts:65` |
| 卡级记忆 | `src/card-memory.ts:51,433,478` |
| 向量记忆 | `src/memory/service.ts:64,281,351,380` |
| 世界线 | `src/worldline.ts:180,241,263` |
| 输出策略 | `src/postprocess.ts:138` |
| 模型配置 / 旁路模型 | `src/agent-config.ts:22,47,200`；`src/types.ts:163,171` |
| 提示词预设 / 声明 | `src/preset*.ts`；`src/preset-declare.ts:24,98` |
| 采样参数投影 | `src/samplers.ts`；`src/preset.ts:34` |
| 世界书 / 判定 / 来源 | `src/lorebook.ts`；`src/lorebook-declare.ts:24,65`；`src/prompt-entries.ts:48` |
| 无剧情 Agent 的证据 | `src/scribe.ts:1-4`；`src/stage/workspace.ts:221-225`；`docs/PLAN-RP-HARNESS.md` |
| 提示词纪律 | `CLAUDE.md`（仓库根） |
| 分轮流程 | `docs/PLAN-ROUND-FLOW.md` |
| 当前阶段 | `docs/PLAN-RP-AGENT-NEXT.md` |

> 叙事台对应位置：`server/memory/context-engine.js:312`、`server/agents/orchestrator.js:55`、
> `server/agents/archivist.js:398`、`server/agents/memory-pipeline.js:57,148,281,341`、
> `server/memory/store.js:1024`、`server/world/scene-sheet.js:32,98,188`、
> `server/world/effective.js:240`、`server/world/state-paths.js`。
