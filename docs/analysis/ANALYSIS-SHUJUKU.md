# shujuku × 叙事台：记忆系统与 harness 机制解剖

> 分析对象：`shujuku/`（SillyTavern 扩展「龙血玄黄·数据库 1.3」，ACU；TypeScript 源码在 `shujuku/src/`）。
> 本文只做**设计研究**，不复制其代码；落地建议一律按本仓库 v4 形状重写。
> 对照对象：本仓库 v4（世界卡 + 状态渲染式上下文 + 多 Agent 记忆），设计原则以 `AGENTS.md` 为准。
> 范围：只讨论记忆、harness/agent 上下文、注入链路、表格子系统；**不讨论 SillyTavern 兼容**
> （卡格式、世界书 keys/triggers、MVU、状态栏、EJS、TavernHelper）。
> 方法：只读源码，未跑 build/test；所有结论带 `shujuku/src/...:行号`，标注【事实】/【推断】。
> 结论日期：2026-10-24。**2026-10-25 冻结为历史记录**：原始分报告与真实验证原始数据已随
> `_work/` 精简删除，结论已并入本文；现行机制与落地状态以代码和 `AGENTS.md` 为准。

---

## 0. 先给结论

### 0.1 shujuku 是什么

不是「一个角色扮演前端」，而是**两个叠在 SillyTavern 上的独立子系统**：

1. **表格数据库（ACU）**：模型每轮把剧情写成一张作者自定义 schema 的表格（纪要表等），
   表格存在聊天消息的私有元数据里；再由世界书条目把「渲染后的表格内容」注回主模型上下文。
2. **长程 agent 管线**：`智能续写`（continuation）与 `格林推演`（simulation）各有一套
   **插件自己持久化的 Agent 会话流**：骨架分段 + 哨兵位 + 历史锚点 + 运行时快照 + 尾部预填充，
   配两个预算数与三道 fail-closed 闸，支持跨多轮的迭代/派工/压缩/交接。

一句话：**叙事台是「每轮重新渲染一个世界」；shujuku 是「让模型不断往一张表里记账，
再按需把账本召回上下文，并用一套长程 agent 循环把账本推进下去」。**

### 0.2 三个先要纠正的直觉

1. **没有摘要链。** `service/summary/merge-logic.ts` 与 `merge-executor.ts` 文件头明示已遗弃、
   仅代码存档；`checkAutoMergeTrigger_ACU()` 无条件 `return { shouldTrigger: false }`
   （`shujuku/src/service/summary/merge-logic.ts:47-51`），解析器只认 `insertRow(...)`，
   而默认合并提示词要求 `INSERT INTO chronicle`（同文件 :252）——**协议已断裂**。
   真正的长程记忆是「纪要表行 + 向量镜像 + 发送前召回」。
2. **记忆不是消息级，是行级。** 索引单元是表格行：`rowKey = summary-row:${hash(summaryKey+':'+rowId)}`
   （`shujuku/src/service/vector/summary-vector-index-archive-service.ts:350-353`），
   行与楼层没有一一映射，只有一个快照锚点 `snapshotMessageId`。
3. **召回结果不是消息注入，是「覆写一个世界书 constant 条目」。**
   `upsertOriginalSummaryIndexEntry_ACU`（`shujuku/src/service/vector/summary-vector-index-runtime.ts:492-518`）
   按 `comment` 找到固定条目，整条替换内容；这是借宿主渲染规则，不是正规注入通道。

### 0.3 最值得拿的五件事

| # | 机制 | 为什么值得（对叙事台的缺口） | 位置 |
|---|---|---|---|
| 1 | **发前容量闸 + 「预算决定可读范围，不决定截断点」** | 叙事台超 `CONTEXT_MAX_TOKENS` 时是「从最长非 system 消息截断 + 记 `degraded='over_hard_cap'`」——**模型会看到半句话**。shujuku 的两道闸证明：超限应当 fail-closed，或收窄范围但保证每个片段完整、并告知 remainder。 | `agent-final-request-gate.ts:1-34`、`agent-default-fence.ts:1-12,104-175` |
| 2 | **运行时缓存前缀探针（增强版）** | 叙事台已有 `meta.cache.prefix_shared_tokens / first_divergence / system_hash`（`server/memory/context-engine.js:775-806,863-872`），但 `first_divergence` 只到「层名」，没有逐条消息 index / 字符 offset / 两侧摘录 / 三判定。shujuku 的 drift 探针把这四项补齐，纯函数零依赖可移植。 | `agent-prompt-drift.ts:60,150` |
| 3 | **读取入口的批次原子 + 拒绝即修复协议** | 叙事台的检索/辞书结果层（`BUDGET_RETRIEVAL=1000`）是单层配额，没有「批次过大 vs 临界溢出」区分。shujuku：批次全进或全不进；拒绝回执不含正文，只给四个量、余量和更窄地址的修复协议。 | `agent-read-gate.ts:1-9,158-162` |
| 4 | **降级/预算要变成给模型的显式状态** | 叙事台层降级只写 `meta.degraded`，模型无感知、继续硬写。shujuku 把预算直接渲染成「现在还能做什么」的动作清单，额度用完即墨（`本次运行只允许一个成功读取批次，已用完，不能再读`）。 | `agent-main-loop.ts:384-413,1660` |
| 5 | **若做派生索引：行身份 + 增量 diff + 位移不敏感 revision** | 叙事台路线图 P2-2「FTS5 回忆 + 被动召回」如果落地，可直接借：只对新增行/场 embedding，delta 写在该行所属消息里，`vectorRevision = sha256(checkpoint + applied entryIds)` 对消息位移不敏感。**前提：不做「摘要的摘要」。** | `summary-sheet-rowid-timeline.ts:132-211`、`mirror-writer.ts:123-153`、`types.ts:549-570` |

### 0.4 不该拿的三类

1. **借宿主渲染规则的注入 hack**：覆写世界书 `constant` 条目（`type:constant`、`order:10000`、
   `prevent_recursion`）。副作用是与你自己的其它条目、用户手改、其它扩展争用（下一轮直接被覆盖），
   失败回退时条目突然变大，而且**注入侧零 token 预算**（行数上限 = topK 200 + 固定注入 50，
   无裁剪逻辑）。这与叙事台红线 1（渲染而非检索）和红线 10（体积有上界、永不静默失真）直接冲突。
2. **跨轮会话压缩 / handoff 摘要 / run cache**：它们只服务「单个 Agent 跨轮累积自己的会话记录」；
   叙事台每轮都重建上下文，没有这个载体。照抄 = 给事件记忆再造一层摘要，撞红线 4。
3. **依赖 ST 生态与宿主标识的隔离机制**：`chatKey` 来自聊天文件名（跨角色可重名），
   V2 scope token 是不可逆 SHA-256 指纹，registry 是 GC 唯一真源；宿主 tokenizer 缺失时回退
   `1.5 char/token`（对中文严重低估）。叙事台有自己的 session/branch id 与 CJK 估算器，不需要也不该学。

### 0.5 与梨园、叙事台的定位差异

| 维度 | 梨园 1.6.4 | shujuku（ACU） | 叙事台 v4 |
|---|---|---|---|
| 形态 | 角色扮演 harness（coding-agent 内核） | ST 扩展：表格数据库 + 长程续写/世界推演 | 单轮编排 + 旁路 Agent + 场次记忆 |
| 长程记忆 | 摘要 + 最近逐字 + 向量库 + 卡级复盘 | 表格行 + 向量召回 + 覆写常亮条目 | `scenes` 场次记录 + `turns` 原文 + 场次索引 |
| 上下文装配 | 稳定 system + 历史重建 + 末端注入 + 工具剪枝 | 骨架分段 + 自持会话流 + 两预算三闸 | 六层预算 + 级联降级 |
| 注入通道 | 世界书绿灯/索引/工具检索（多通道） | 世界书 constant 覆写 + 零层 carrier 消息 | 渲染式：system/archive/recent/scene/current，通道封闭 |
| 分支 | 只追加树 + 叶守卫 | 楼层/swipe + 零层分支 material | SQLite 分支 + fork + `branch-guard` |
| 对叙事台的价值 | 引擎设计 S 级 | 工程化「闸门/一致性」可学，注入/记忆要改形 | — |

---

## 1. shujuku 全貌与四条链路

### 1.1 分层与规模

```
shujuku/
├── index.js / 酒馆助手脚本-*.json   9MB 级构建产物（不分析）
├── src/
│   ├── presentation/                 Vue 界面 + 初始化 + 事件挂载（含 summary-vector-index-ui）
│   ├── service/
│   │   ├── table/        50 文件 1.57MB  表格存储/更新编排/结算
│   │   ├── vector/       24 文件 610KB   纪要行 → 向量镜像 → 召回
│   │   ├── continuation/ 65 文件 1.89MB  智能续写（含 agent/ 38 文件）
│   │   ├── simulation/   66 文件 1.33MB  格林推演（含 agent/）
│   │   ├── zero-layer/   70 文件 444KB   零层：把插件状态挂到消息上的载体
│   │   ├── worldbook/    12 文件 220KB   注入引擎（条目/顺序/状态/模板变量）
│   │   ├── runtime/      26 文件 437KB   状态管理/消息钩子/模板渲染
│   │   ├── ai/           20 文件 290KB   API 调用/提示词构建/原生工具/token 计数
│   │   └── summary/      2 文件 37KB    **已遗弃的合并死代码**
│   └── shared/                           骨架/布局/默认值/受限 SQL DML
```

诊断：**规模不是复杂度指标**。403 个 service 文件里既有 SOTA 级的一致性工程，
也有整块遗弃的死代码和大量以「文件」为单位的兜底分支；分析时必须逐条甄别【事实】/【推断】。

### 1.2 四条链路

**A. 填表（每轮或按频率）**：`table/update-orchestrator.ts` 发起一次「让模型填表」的调用，
输入是最近楼层窗口（纪要表/总结表取最后 10 行，`ai/prompt-builder/prompt-prepare.ts:53-55`），
输出是表格 patch；表格写在 `message.TavernDB_ACU_IsolatedData[isolationKey]` 的 JSON 里。

**B. 向量镜像与召回（发送前）**：只用纪要表。行 → rowId 时间线 diff → 新增行 embedding →
外置 ST 文件 + 消息内 delta → 发送前召回 → 覆写 `...CustomExport-纪要索引` 世界书条目。
详见 §2。

**C. 智能续写（continuation）**：给一个总目标/引子，主 Agent 在「阶段（stage）→ 轮（turn）→ 拍（node）」
的游标上循环生成正文；主 Agent 每迭代做一个动作（`finalize/delegate/block/tools/open_round/
correct_materials/adjust_progress`，`agent-model.ts:814`），可派工大纲/弧线/伏笔等子代理。
上下文 = 伪角色骨架 + 插件自持会话流（`$HISTORY_ANCHOR`）+ 运行时快照 + 尾部预填充。
详见 §3。

**D. 格林推演（simulation）**：后台世界模型，账本含
`clock / dimensions / seeds / actors / chronicle / guidance / rumors / player` 八个模块
（`simulation/model.ts:90`），常量如 chronicle 热窗口 32 条、overview 上限 512 行、
guidance 每条信号 ≤80 字。跑完后按 `projection.template`（必须恰好含一个 `$WORLD_SIGNALS`，
≤4000 字）把「场外信号」插入 AI 楼层正文，形成「正文之外的世界呼吸」。
对叙事台的对照见 §3.9。

---

## 2. 记忆系统解剖（纪要表 → 向量 → 召回）

### 2.1 数据模型：三层存储 + 行身份

| 层 | 载体 | 说明 |
|---|---|---|
| 原始消息 | 宿主 chat 数组 | 扩展不改正文；私有元数据挂 `TavernDB_ACU_IsolatedData[isolationKey]` |
| 纪要表 | 上述元数据里的 JSON 表 | `content[0]` 表头，`content[1..]` 行，`row[0]` 即 rowId |
| 向量索引 | 外置 ST 文件 + IndexedDB 缓存 + 消息内窄指针 | 指针：`summaryVectorIndexState` / `summaryVectorIndexManifest`；增量：`storageFrame.summaryVectorIndexFrame` |

- 【事实】行身份 `rowId = normalize(row[0]) || indexCode`；缺 rowId/summary/indexCode 的行
  `skippedRowCount++` **静默跳过**；重复 rowId 则**整次归档失败**（不会猜）。
- 【事实】`vectorSourceText = 概览 + 纪要正文` 一起 embedding；`vectorSourceHash` 存指纹，
  `vectorSourceText` 在 sp-9.2 之后写空串，避免正文随聊天元数据重复存储（`summary-vector-index-types.ts:146-167`）。
- 【事实】默认 1 行 1 向量（整行 embedding），可选按句切 2 句/块；索引体积与行数线性。

### 2.2 增量索引：rowId 时间线 diff

【事实】增量不比对全文，比对**行集合**：

1. `collectSummarySheetRowIdTimelineV2_ACU` 只读观察 replay，产出
   checkpoint 时 rowIds、每个触及该表的 table entry 应用后的 rowIdsAfter、head 时 rowIds
   （`shujuku/src/service/table/summary-sheet-rowid-timeline.ts:132-211`）；
2. `planUnmirroredEntryDeltasV2_ACU` 逐 entry 做集合 diff，产出
   `{messageIndex, entryId, commitRevision, added[], removed[]}`（`mirror-writer.ts:123-153`）；
3. 只对 `added` 行 embedding，`removed` 转 `{kind:'row_remove'}`；
4. 每个未镜像 entry 生成一条 delta log（`vdelta_*`、`seq` 单调、来源 entry 引用、pack 引用、
   `skippedRowCount`），**追加到该消息自己的 `frame.summaryVectorIndexFrame.logEntries`**；
5. 读取端由 checkpoint + 按序 delta 重放；`vectorRevision = sha256(checkpoint.vectorRevision +
   applied delta entryId 序列)`，**对 messageIndex 位移不敏感**（`summary-vector-index-types.ts:549-570`）；
6. 写 delta 前校验来源 entry 仍存在，失效则整条丢弃。

【推断】这是一个「以表格为唯一写入面」的系统里最稳的增量方案：表是唯一真源，
索引只是行集合的镜像；代价是**行内容被改（rowId 不变）不会自动重嵌**——
只能等全量 rebuild（`rebuild_repair`）或换 embedding 身份时的确认 UI。

### 2.3 存储、发布与 GC

- 【事实】外置文件前缀 `TavernDB_ACU_vector_v2_`（快照）/`_v2pack_`（内容寻址 pack）/
  `_v2vcp_`（manifest），向量用 `f32b64` 字符串编码（`vector-index-st-files-storage.ts:134-136`）；
- 【事实】发布是 `prepared → published` 状态机，任一步异常 `abort` 并**保留 orphan 交给 GC**；
- 【事实】三层 GC：聊天删除事件（三重防护）→ 启动期孤儿清扫（24h 节流）→ 写后 retention
  （per-scope 30min 节流）；真正删文件走 Safe GC：scope 前缀 + 内容身份回读 + **10 分钟 grace**
  + prepared/pending 保护；
- 【事实】聊天删除的删除安全边界（缺一不可）：目标是当前聊天→跳过；无法完整枚举存活聊天→
  fail-safe 跳过；同名存活聊天仍存在→跳过（chatKey 来自文件名，跨角色可重名）。
- 【事实】提交用 CAS：`commitVectorMetadataPatch_ACU(..., {expectedIndexId})` 不匹配即失败；
  镜像写入本身是一个表格写事务，失败整体还原（`snapshotIsolatedData_ACU` / `restoreIsolatedData_ACU`），
  不留半截 delta。

### 2.4 检索：dense + BM25 + RRF + 可选 rerank

【事实】发送前召回（`summary-vector-index-runtime.ts:938-1324`）：

1. 8 秒去重（signature = `chatKey:用户输入`）；同输入重复触发直接 `deduped`；
2. 用**实时表**建行并与镜像 head 对账；stale 不阻断发送，按交集召回 + 后台补 flush；
3. 固定注入：最近 `recentFixedInjectCount=50` 行（按 rowOrder 降序，不参与相似度）；
4. query = 用户输入 + 关键词 AI 生成的关键词；单条 embedding；
5. dense：逐 chunk cosine，`score < 0.35` 直接丢，降序取 `candidateLimit=1000`；
6. sparse：BM25 `k1=1.5, b=0.75`，CJK 用单字+相邻双字 bigram；
7. 融合：RRF `k=60`（**融合后 score 不再是余弦**）；
8. rerank：可选；vector 模式协议要求 rerank 参与，未 applied 即**拒注入**；
9. 选行：按 rowKey 去重取 `topK=200`，固定行优先，最终按 rowOrder 升序输出。

【事实】行数 < `summaryIndexKeywordMinRows=200` → `below_min_rows` + 概览回退。

### 2.5 注入形态与失败降级

- 【事实】成功 → `upsertOriginalSummaryIndexEntry_ACU` 覆写当前注入世界书的固定条目
  （comment 前缀 `...CustomExport-纪要索引`、`type:'constant'`、`order` 缺省 10000、
  `prevent_recursion:true`、enabled 缺省 = `zeroTkOccupyMode !== true`），内容是 Markdown 表格
  （默认时间/地点/概要/编码索引四列），0 命中写「（无命中纪要）」占位。
- 【事实】vector 模式（蓝灯）不写文本：把召中行对应的世界书条目 `type` 切 `constant`，
  失败/跳过时**撤回全部蓝灯**，避免过期结果进入本轮。
- 【事实】失败回退：8 种原因（embedding 失败、空向量、无候选、无 chunk、无选中行、
  低于最小行数、rerank 失败等）统一 `restoreSummaryIndexOverview_ACU` → 用**全部实时行**
  重写概览条目。**设计目标是「永不静默失真」，代价是失败即变大。**

### 2.6 预算与静默失真（必须对照叙事台红线 10）

- 【事实】**注入侧零 token 预算**：`buildSummaryIndexOverwriteContent_ACU` 只做转义与拼接，
  不裁剪行数/单元格长度；行数上限就是 topK(200) + 固定 50。
- 【事实】**三处静默跳行**：缺列/缺 rowId/缺 summary 的行 skip；新增 rowId 在实时表找不到只
  `logWarn` 跳过；delta 来源 entry 失效只丢弃。UI 成功 toast 只报「N 行, N chunks」，不看 skipped。
- 【事实】**失败回退到全量目录**：行数大时是「失败即变大」，没有为此设上限（只有 embedding
  侧的 24000 字符/请求预算，注入侧没有）。
- 【事实】死代码面仍在（merge-logic / merge-executor / archiveSummaryVectorIndexNow_ACU），
  有被后续维护者误接入的风险。

### 2.7 判定：记忆侧哪些是机制级

【事实/推断】可直接借鉴（与宿主无关）：

1. 行身份 + rowId 时间线 diff（增量只处理新增/删除，不做全量重嵌）；
2. delta 写在产生它的那条消息里 + `vectorRevision=sha256(checkpoint+entryIds)`（对位移不敏感）；
3. 窄指针 + 外置大对象（聊天元数据只存指针，重数据在文件/IDB）；
4. 失败回退到「完整目录」而非留空/留上一轮（对应叙事台「永不静默截断」，但**必须补 token 配额**）；
5. 一致性骨架整体可搬：scope 三元组 + mutation 锁 + generation 墓碑 + CAS + 三层 GC + grace。

宿主 hack / 需改形：

- 世界书 constant 覆写不是「记忆注入」的正规通道（见 §0.4）；
- 删除/编辑只能靠 replay 失效 + 全量重建，没有消息级删除 API；
- chatKey 用文件名、scope token 不可逆哈希、tokenizer 回退 1.5 char/token，都是绕宿主限制的补丁。

---

## 3. harness 解剖（智能续写 / 格林推演）

### 3.1 四段结构：骨架 + 哨兵 + 自持会话流 + 尾部预填充

【事实】每次请求都重建为四段（`agent-main-loop.ts:1-16`、`shared/agent-prompt-layout.ts:1-83`）：

1. **伪角色提示词骨架**（`ContinuationPromptSegment_ACU[]`，用户可编辑）；
2. **Agent 自己的会话记录**，插在哨兵 `$HISTORY_ANCHOR`（`role:'history'`）处；
3. **运行时快照**（`$RUNTIME_SNAPSHOT`），与骨架同一套 resolver 渲染，内容相同则**不追加**；
4. **尾部预填充**（`USER_PREFILL_CONTENT_ACU`），永远最后一条。

【事实】占位符是**封闭集合 + 按实际命中解析**：正则按长度降序（否则 `$STORY_ARC` 会吃掉
`$STORY_ARC_STATE`），`matchAll` 只解析真正出现的占位符，未知字段/空内容/嵌套哨兵一律拒绝
（`prompt-template.ts:43-46`）。**【推断】「段是用户可编辑的，插入位由代码控制」**——
用户改提示词不会破坏历史插入点，因为插入点是哨兵不是文本匹配。

【事实】故事正文有三个正交占位符：`$STORY_OVERVIEW`（纪要概览，可把召回行升级为全文）、
`$STORY_TAIL`（最近 N=2 个 AI 楼层**全文**）、`$STORY_CATALOG`（纯楼层索引）。
`$WORLDBOOK_CATALOG` 不返目录，而是一句固定指令 `'主会话不浏览世界书目录…不要 read $WORLDBOOK'`
——**负向占位符**：注入「不要做某事」，把成本挡在源头。

### 3.2 两个预算数

【事实】`continuation/agent/agent-model.ts:155-187`：

| 常数 | 值 | 语义 |
|---|---|---|
| `agentHistoryTokenBudget` | 120000 | 会话压缩触发线（给 128k 模型留输出余量） |
| `agentReadTokenBudget` | `'20%'` | 单批 read/search 上限（按会话预算折算） |
| `agentReadFallbackTokens` | 6000 | 临近压缩时仍放行的精读兜底 |
| `AGENT_HISTORY_EMERGENCY_FACTOR_ACU` | 2 | 轮内允许超预算倍数，超过立即压缩 |
| `AGENT_HOT_HOOK_LIMIT_ACU` | 8 | 热上下文最多展示的活跃伏笔条数（超出如实标注） |
| `AGENT_BLOCK_CHAR_LIMIT_ACU` | 4000 | 单资料块渲染字符上限（超出截断并标注） |

【事实】压缩目标不是压到阈值，而是 **80%**：`reserve = clamp(floor(trigger*0.2), 8000, 24000)`，
`targetTokens = trigger - reserve`；交接报告预算 `clamp(floor(trigger*0.08), 2000, 8000)`。
【事实】`max_tokens` 与上下文窗口是**两个量**，代码里从不混用（`ai/request-max-tokens.ts:12`）。

### 3.3 三道闸（最值得抄的部分）

**闸一 · read gate**（`agent-read-gate.ts:1-9,158-162`）——资料入口：
S = 会话预算，M = 单批预算，F = `min(6000, M)`，B = 实测批次 token，H = 已占用。
`B > M` → `read-batch-too-large`；`H + B > S && B > F` → `near-compaction-overflow`；
否则放行。**批次原子**（全进或全不进，禁止拆小绕过），拒绝回执**不含任何资料正文**，
只给每项实测 token、四个量、剩余余量与修复协议（先 search 再用更窄地址）。

**闸二 · final request capacity gate**（`agent-final-request-gate.ts:1-34`）——发前 fail-closed：
先把最终 messages + tool definitions 整体 measure；`occupied >= inputLimit` 直接抛
`READ_FENCE_CAPACITY_EXHAUSTED`，**在 provider 调用之前**；预留给读的额度 =
`floor((inputLimit - occupied) * 0.6)`。复用 simulation 侧同一个 measure 函数，**不接受两套公式**。

**闸三 · 压缩后重新计量**（`agent-main-loop.ts:1379-1416`）：`ceiling = budget*2`；
超 ceiling → 立即 `session.compact(true)` 再量；**仍超 → 抛错拒发，不截断、不摘要**；
未到 ceiling → 只做一次用户提示，压缩推迟到下一轮边界。

### 3.4 default fence：预算决定「可读范围」

【事实】`agent-default-fence.ts:1-12,104-175`：

- 默认上围栏预算 = `(inputLimit - 已占用) * 60%`；
- **预算不是正文截断阈值**：resolvedFence 内的正文必须完整、逐字返回；
- 实现是**二分搜索最大可容纳上界**；放不下时先为原子地址保留完整正文、为可收窄地址保留
  最小可证明范围，再按预算给每个地址取最大前缀；收窄后的地址重新走适配器解析，
  要求 `proof.stableAddress === address && completeWithinFence`，否则 `default-fence-proof-invalid`；
- 返回带 `remainder`（未读部分的稳定地址）；连最小范围都放不下 → 整批拒绝且**不消耗额度**。

【推断】这是「模型看到的每一段都是完整的，只是范围变窄了，并且它知道窄了多少、剩下在哪」。
叙事台目前是「超预算就降级/截断层内容」，会产生「看到半句话」的静默失真。

### 3.5 压缩与交接：非破坏 + 确定性优先

【事实】压缩是**楼层上的一个 mark，不是删除**：消息永不删除，压缩写
`compaction: {compactedThroughId, report, summaryState, metrics}`；渲染时投影掉
`id <= mark` 的消息，并把 report 合成第一条 `kind:'handoff'` 消息；**删掉承载 mark 的楼层
= 自动撤销压缩**（`agent-conversation-store.ts:1-18`）。**【推断】这是整套机制里最值得抄的设计**：
会话记录像 coding agent 一样跟随真实楼层，重 roll / 删楼自动回退。

【事实】压缩本身：结构化状态 `AgentHandoffSummaryStateV2_ACU`（`currentGoal/effectiveConstraints/
decisions/completedItems/pendingItems/blockers/continuityFacts/readKeys/recentTurns`）；
**确定性兜底优先**（`buildDeterministicState_ACU` 从消息 digest 拼，列表留最后 8 条），
语义摘要只是**可选覆盖**且必带 `degraded`；合成后按字段倒序裁剪进预算，仍超则抛错。
另一条纯本地交接 `buildAgentHandoffReport_ACU` 的注释理由很关键：
**本地拼无损，AI 摘要有损且多一条失败路径**。

【事实】还有一条显式策略 `discardPreviousRound`：新一轮开始时把上一轮整个会话丢弃、不做总结
（`agent-main-loop.ts:1164-1226`）。【推断】它说明作者认为「不累积」与「压缩」是同一问题的两种解法，
应可配置——而叙事台本来就是「永远 discard」。

### 3.6 工具协议与子代理

- 【事实】双模式运行期固定：`json`（请求体不带 tools，工具写成文本 JSON）或 `tools`（原生
  `tool_calls`）；全局开关关/通道不支持 → 降级 json 并 log；**每次运行只解析一次，整条运行固定**
  （`ai/agent-tool-mode.ts:55`）。
- 【事实】两套提示词是**同一份默认正文的定向改写**，不是两份独立维护：`JSON_SWAPS_ACU` 是
  逐条 from→to 字面替换表，只作用于内置默认正文（`agent-prompt-mode.ts:14-80`）。
- 【事实】`projectNativeToolHistoryToText_ACU`：json 模式下把带调用的 assistant 改成文本 JSON 动作、
  tool 回执改成 user 消息；`anchorNativeToolCalls_ACU` 先合并连续 assistant 并保留编号、给缺编号的
  tool 结果补占位 `read {}`（否则某些渠道报 tool id not found）。
- 【事实】子代理是**受限小循环**：派工时给种子读集，子代理可再输出 read/search 批次补充调阅，
  结果作为 user 消息追加进本次派工；种子读集与后续批次**分别**过闸一；读取失败**不得**把同批
  其它正文回灌给模型（`agent-subagent-runtime.ts:7-18`）。
- 【事实】主 Agent 只有 7 种动作（`agent-model.ts:814`），每次迭代做一个；
  `totalCallLimit = maxIterations + maxReads + 4` 防「反复发工具批次」；
  子代理派工预算默认 `iterations 4 / delegations 3 / sameAgent 2 / maxReads 4`。

### 3.7 缓存纪律与运行时探针

- 【事实】结构上保证「相邻请求 = 严格前缀 + 尾部追加」：目录/预算不进骨架、只在变化时作为
  runtime 消息追加；压缩只在轮次边界发生；骨架每次重渲染但输入不变则逐字节相同。
- 【事实】显式 prompt cache key 只在极窄条件下启用（自定义 apiMode + `openai_compat` +
  URL 主机精确 `api.openai.com` + 特定模型正则）；key 是稳定命名空间而非命中声明，
  `boundary` 默认 `'uncompacted'`，压缩后设为交接报告文本 → **压缩即宣告缓存失效，不假装命中**。
- 【事实】drift 探针 `compareAgentPromptMessages_ACU` 从 index 0 精确比对 role+content，
  首个分歧给 `divergedMessageIndex / divergedCharOffset / ±60 字摘录`，三种判定
  `identical` / `appendedMessages`（健康）/ 其它（怀疑破裂）。判据：
  **健康的分歧出现在尾部运行时段；出现在头部的分歧是缓存破裂的直接证据。**

### 3.8 与叙事台的形态差异判定

叙事台 = 单轮编排 + 旁路 Agent + 场次记忆，**上下文每轮重建、不跨轮累积**；shujuku = 长程任务，
单个 Agent 跨轮累积自己的会话。因此：

- **直接可用**（§0.3 的五条 + token 计数 memoize、双协议同源派生、工具历史投影、
  子代理「只保留自己相关素材段」）；
- **只适用长程**（会话压缩、handoff、非破坏 mark、run cache、checkpoint 楼层基线、
  `discardPreviousRound`）——叙事台已有 `turns` 原文 + `branch-guard` 等价物，
  **不要引入第二套游标或第二份预算公式**；
- **半可用**：受限于子代理小循环（叙事台现在是单次调用；若做「史官可自查再报」这是模板）。

---

### 3.9 格林推演（simulation）的账本模型

【事实】`simulation/model.ts`：账本模块固定为
`['clock','dimensions','seeds','actors','chronicle','guidance','rumors','player']`；
常量：`WORLD_LEDGER_SCHEMA_VERSION_ACU=6`、chronicle 热窗口 32 条、overview 上限 512 行、
guidance 单条信号 ≤80 字、actors 经验条数上限 30、指引注入条数 20、玩家区域访问记录 64。

- `clock`：`{day,slot,storyTime,precision:exact|approximate|unknown,evidenceRefs}`；
- `dimensions`：`{id,name,kind:pressure|growth,value,trend:rising|stable|falling,rationale,evidenceRefs,revision}`；
- `seeds`：`{status: established|incubating|active|converging|resolved|retired, level, catalyst,
  visibility:hidden|limited|public, actorIds, location, expiresAtDay, missedOutcome, exposePolicy:
  on_collision|gradual|public, evidenceRefs, retiredReason, revision}`；
- `actors`：`{interests,location,life:alive|missing|dead,diedAtDay,deathSummary,resources,goals,
  constraints,informationSources,knownFacts,visibility,currentAction{text,expectedDuration,startedAtDay,
  startedAt},longTermAction{status:ongoing|done|abandoned,outcome},experiences[],revision}`；
- `chronicle`：热区逐条 `{id,at,summary,relatedIds,evidenceRefs,missedNote}`，
  冷区 `overview rows {fingerprint,day,oneLine,archiveRef}`（512 行上限，超出走归档引用）；
- `guidance`：`signals[{text(≤80字),voice:encounter|rumor|ambient,sourceId?}]` + `excludedFacts`；
- `rumors`：`{fact,originDay,earliestRevealDay,channels,relatedActorIds,status:latent|ripe|revealed|dead,
  revealedAtDay,revision}`（TTL 由 `dynamics.rumorTTLDays` 控制）；
- `player`：`{location{region,place?},regionVisits[{region,day}],contact:open|secluded,evidenceRefs}`；
- 写入协议：字段级 upsert `{value, unset}`；`materialCompletion` 五态
  `complete_changed|complete_no_change|partial|failed|legacy_unknown`；`pendingFix` 来源
  `truncated|contract_rejected|protocol_failed|invoke_failed|transaction_rejected`；
  字段矩阵给出 `consistencyGroups`（如 `[status,retiredReason]`、`[life,diedAtDay,deathSummary]`、
  `[status,revealedAtDay]`）——【推断】这是**确定性后置校验**：模型只写字段，代码校验字段间一致性；
- 快照只读、永不回写；`projection.template` 必须恰好含一个 `$WORLD_SIGNALS`（≤4000 字），
  把信号渲染进 AI 楼层正文。

【推断】与叙事台的对应关系：

| 格林推演账本 | 叙事台对应物 | 判定 |
|---|---|---|
| `actors`（life/goals/resources/constraints/informationSources/knownFacts） | `character_states` + `card.cast.psyche/knowledge` + `world_state` | 叙事台把「角色内核」放 canon、「状态」放账本，分工更干净；shujuku 把 constraints/infoSources 也做成账本字段，可补 `world_state` 路径（需过 AGENTS.md §11.2 字段流程） |
| `seeds` 生命周期 + `exposePolicy` + `expiresAtDay/missedOutcome` | `threads`（线索）+ `fates`（成长曲线确定性解锁） | seeds 的状态机更细；叙事台 fates 不调模型、更便宜。可借「错过也发生」（missedOutcome）语义，但要落成**确定性规则**而非模型自评 |
| `chronicle` 热窗口 32 + overview 512 + archiveRef | `scenes`（每场一行）+ `turns` 原文 | 结构同构：都是「热区逐条 + 冷区索引」。shujuku 的 `fingerprint` 中继（overview 行可回指原条目）比叙事台「行 + 摘要」多一层可回指保险 |
| `guidance.signals` ≤80 字 + voice 分类 | 场记单里的「回声/线索/传闻」 | 可借「**信号有字数上限**」这条纪律；叙事台场记单目前靠 `BUDGET_SCENE` 总量约束，没有单条上限 |
| `rumors` TTL | `threads` | 叙事台红线 5 是「冲突失效不删除」，TTL 属于「过期」不是「冲突」；若引入必须区分 `status=expired` 与 `invalidated`，不能混 |
| `projection` 插入 AI 楼层正文 | 无（叙事台不允许改原文） | **不借**：违红线 4（原文唯一真相）；可改写成「场记单里增加【场外信号】一节」= 渲染，不是插入 |
| `materialCompletion` / `pendingFix` | `patches(status='stale')` + `meta.degraded` | 借「**失败具名**」：现状只有 stale/degraded 两档，可扩展为「未就绪/已截断/已降级/未覆盖」四类 |

---

## 4. 注入链路解剖（表格/世界书如何进主模型）

### 4.1 边界：宿主拼 messages，插件只做「改写」

【事实】主生成 messages 结构由 SillyTavern 宿主决定：preset + 角色卡 + 世界书（按
`position/depth/order/role`）+ 历史。插件在 `bootstrap/init.ts:209-216` 用
`makeLast(CHAT_COMPLETION_SETTINGS_READY)` 挂进渲染链，在
`runtime/helpers-remaining.ts:223-231` 遍历最终 prompt 的**每条消息**，只改 `content`
（模板变量 / `{[db…]}` / SQL / `<if>` / 随机数），**不能新增、删除、重排消息**，
也没有「追加 system」的通道。【推断】这解释了 shujuku 为什么要造 zero-layer 载体、
为什么要覆写世界书 constant 条目——宿主没给它正规注入口，它只能借道。

### 4.2 五条注入通道

| 通道 | 形态 | 关键事实 |
|---|---|---|
| A 可读数据表 | 一条 constant 世界书条目 | `worldbook/pipeline.ts:210-245`；表格→Markdown，前 10 行/表、0 基编号、空表占位 |
| B 上下文包裹 | 2 条 constant 条目 | 给数据块包标签，便于模型区分数据/指令 |
| C 摘要/重要人物/自定义行 | **keyword 条目** | `injection-engine-custom.ts:429-493`：条目 `keys` 由**数据列内容派生**，数据一变条目就「消失/复活」；命中计算在 `pipeline.ts:381-436` |
| D 逐条消息就地改写 | 渲染链后处理 | `helpers-remaining.ts:223-299`；**世界书 at_depth 消息、角色卡 prompt、导出条目里的 `sqlInjectionTemplate` 都在这一刻展开** |
| E zero-layer 拼接 | carrier/ordinary/request 三类 | 见 §4.6；把归档楼层精确 splice 进历史，并用 fingerprint 换幂等 |

【事实】默认条目位置：`DEFAULT_ENTRY_PLACEMENT_ACU = { position:'at_depth_as_system',
depth:2, order:10000 }`（`worldbook/injection-engine-config.ts:6-9`）；额外索引 10010；
固定条目 99990/99991；每表可覆盖：总结/小总结 `depth 9999 / order 99987-99988`、
总体大纲 `9998 / 99985-99986`、重要人物 `10000 / 99983-99984`、全局数据表
`before_character_definition / 99981`、包裹 `99980`。
【事实】order 分配 `allocOrder_ACU` 从 1 往上找空位（上限 99999，满了抛错），
`allocConsecutiveOrderBlock_ACU` 要求连续块；同 depth 的多行共享一个 order
（`injection-engine-entries.ts:202-254`、`pipeline.ts:314-331` 用 start/base/end 三段包裹）。
【事实】清理 `deleteAllGeneratedEntries_ACU` 只认 12 个已知前缀 + 隔离前缀 `ACU-[code]-`
（`pipeline.ts` 与 `injection-engine-custom.ts` 各一份实现）——命名即清理依据，是维护风险。

### 4.3 两段式渲染（可借鉴的骨架）

【事实】`prepareAIInput_ACU`（`ai/prompt-builder/prompt-prepare.ts:155-449`）只产**文本块**：
`{tableDataText, messagesText, conditionalSeedContent, worldbookContent,
worldbookDatabaseExcludedContent, resolveTableWorldbookContent, manualExtraHint}`；
`callCustomOpenAI_ACU`（`prompt-api-call.ts:73-557`）再按占位符段序列拼 messages：
`$0` 表格 / `$1` 历史（纪要·总结取最后 10 行）/ `$4` 世界书 / `$6` 全局数据 /
`$8` 上一拍剧情 / `$9` 世界书「数据库排除」/ `$U` 用户人设 / `$C` 角色描述 /
`{{表名}}`（该表的世界书内容，白名单 `filterTableInjectedContent`）。

### 4.4 模板变量系统：求值顺序是硬纪律

【事实】固定 10 步（`runtime/request-context.ts:14-34`、`prompt-api-call.ts:182-232`）：
random → calc → max → min → `replaceDbSqlVariables`（`{[db…]}` / `{[sql "…"]}`）→
`parseIfBlockRecursive`（`<if>`）→ 业务占位符 → send。
- `calc` 不能引用 `$v:`（v 在 calc 之后产生）；`<if>` 可以；
- **同一请求模板变量只执行一次**（`request-context.ts` 去重，失败也缓存不重跑）——
  避免每轮随机/查询漂移；
- `<if>` 最大嵌套 10，超限 warn 返回原文；只选择文本、不改任何结构；`else` 只支持第一层；
  逻辑优先级 `()` > `!` > `&` > `,`；
- 变量语法：`{{seed:}}`（条件条目）、`{{cell:}}`/`{{cell:表:列:行}}`、
  `{{random:}}`、`{{calc:}}`、`{{min/max}}`、`{{v:}}`；SQL 走独立 `{[db…]}`。

### 4.5 只读 SQL 与 fail-closed

【事实】`{[db.表.where("col","v").get("x")]}`：ORM 编译成 `new Function('db', ...)` + Proxy；
`{[sql "…"]}` 走 NameMapper（中文展示名→物理表/列）+ 只读校验；
`withSqlTemplateReadContext_ACU` **同步**、`undefined` 继承、`null` 禁用；每次请求一份脱管
sqlite 快照；未就绪 → **返回原文**（fail-closed）而不是空串；`formatResult` 输出裸文本。
【事实】无缓存、无去重、无 token 预算（`runtime/template-vars/sql-query-var.ts:26-140,856-889`）。
【推断】所以 SQL 注入是「作者能力」而非机制级通道；和叙事台红线 1/2/10 都冲突。

### 4.6 zero-layer：载体 / 普通 / 请求三元上下文

【事实】`carrier-context.ts`：载体 = `_qrf_zero_layer_v1`，写进第一个非 user 非 system
消息的 swipe 元数据；scope = `{chatId, characterKey}` + swipeId；WeakMap 重入守卫；
物理历史 SHA-256 快照；assert 不匹配即报错。
`ordinary-context.ts`：发送前用 carrier 里 `publishedMaterials` 的 permit 快照校验
messagesHash，再 splice 归档楼层；permit 是一次性 lease/epoch。
`request-context.ts`：`WeakMap<request, ChatCompletionPromptContext>`；模板变量 pass 每请求
一次（WeakSet 去重）；sqlite detached 快照。
【推断】zero-layer 的实质是「把插件状态附着在宿主消息上，用 fingerprint 换幂等」——
叙事台**不该抄形态**（我们有 DB 与 branch_id），但它的错误分类值得抄：
`pending-turn / delivery-unknown / effects-pending / revision-conflict / persist-unknown`
都是 **fail-closed 的具名状态**。

### 4.7 主模型 vs 插件旁路模型（两条互不污染的边界）

【事实】主生成 = 宿主 preset + 角色卡 + 世界书 + 插件改写；插件副模型（填表/续写/推演/优化）
= 独立 API preset（`structuredClone` 冻结，请求级不回写宿主）+ 自拼 messages + 结构化 JSON/DSL
输出 → 确定性代码落库。插件从不回写宿主 preset/角色卡，只写自己前缀的「生成条目」。
【推断】与叙事台「旁路 Agent 只读 context.card、只输出提案」同构；叙事台的差异是把
每 Agent 的模型的预算写进 `config.agents`，shujuku 是每 Agent 独立 `apiPresetName` + prompt。

### 4.8 缓存纪律与 prompt_cache_key 反例

【事实】continuation 骨架注释：「唯一静态根 system 消息；历史只尾部追加；运行时快照只在
变化时追加」（`agent-defaults.ts:103-104`、`agent-conversation-store.ts:582`），配合 drift 探针。
【事实】显式 `prompt_cache_key` 曾注入，随后退役：注释写「注入 prompt_cache_key 会让部分
Codex 兼容渠道划分独立缓存命名空间，打断前缀命中」，读入写出恒为 false
（`continuation/model.ts:346-350`、`continuation-store.ts:1087`）。
【推断】对叙事台的含义：**别为了缓存去动请求体**；稳定前缀做成结构保证比声明 cache key 有效。

### 4.9 静默失真清单（对照红线 10）

【事实】shujuku 侧至少 7 类无降级路径的静默失真：
1. 模板未就绪残留 `{[db…]}` / `<if>` 字面量；
2. 内容优化替换找不到原文时静默跳过、位置错位；
3. 世界书多步写非原子（删除→创建→回写 order），失败仅 warn；
4. flight-mode 投影失败 fail-open、回退未过滤数据（`prompt-prepare.ts:202-210`）；
5. keyword 条目 keys 与正文耦合，数据变则条目「消失」；
6. 纪要/总结行窗口硬编码 10 行，无 degraded 标记；
7. SQL 错误默认吞异常返回空（`throwOnQueryError` 才抛）。
【推断】叙事台现行「degraded 标签 + 硬上限不静默截断」方向正确；若移植新渲染器，必须把
「未就绪 / 已截断 / 已降级 / 未覆盖」作为 meta 的**四类具名状态**（现在只有 `degraded: []`
一个数组）。

### 4.10 注入链路判定

- **可借（与宿主无关）**：两段式渲染（数据块 → 占位符段 → messages）；固定求值顺序 +
  同请求只求值一次；只读 SQL 的 NameMapper + 同步 fail-closed + 隔离快照（**仅限主动检索通道**）；
  缓存前缀纪律；e2e 十字链验证；render 层只改内容并声明 kind；zero-layer 具名错误状态。
- **需改形**：`<if>` 只给粒度、不替注入决策（叙事台层与主人是代码定的，不是作者模板）；
  作者可配 depth/order → 叙事台不可，层由 `assembleContext` 定。
- **必禁**：lorebook 式 keyword 触发；写宿主聊天历史/swipe 作载体；依赖
  `worldInfoBefore/After` 锚点；把中文表名列名当协议；注入文本混入 scratch；
  多步注入非原子且失败静默。

---

## 5. 表格子系统（结构化记忆载体）

### 5.1 本质与数据形状

一句话：**ACU 的「数据库」不是 DB，是贴在聊天楼层元数据上的、作者可自定义表头的二维表格账本。**
【事实】`Sheet_ACU`（`shared/models/table-data.ts`）：

- `uid/name/orderNo`；`content[0]` 是表头，`content[1..]` 是数据行（唯一口径）；
- `updateConfig`：`contextDepth / updateFrequency / skipFloors / batchSize / groupId /
  sendLatestRows / sendRowsSqlTemplate`——**每张表自带调度与投影参数**；
- `exportConfig`：`enabled / injectIntoWorldbook / entryName / entryType(constant|keyword) /
  keywords / entryPlacement / splitByRow / injectionTemplate / extraIndexEnabled /
  extraIndexInjectionTemplate / sqlInjectionTemplate / preventRecursion`；
- `sourceData`：`note / initNode / insertNode / updateNode / deleteNode`——这些「触发器」是
  **自然语言文案**，随填表 prompt 给模型看，不是代码钩子（`prompt-prepare.ts:307-322`）。

【事实】没有 schema：单元格是 `any`，无类型/外键/行 schema（SQLite 模式才有 DDL 类型与隐藏物理列）。
AI 不能改表头：填表 prompt 只给 `Columns: [0:列名]…` 的可见列投影，模型只能写行；
改表结构是另一个功能域（`template-assistant/`，未深读）。

### 5.2 存储与生命周期

【事实】`storageMode: 'native' | 'sqlite'`，默认 `native`（`settings-service.ts:1358`）；
两种模式共用同一张表模型，只换 provider。**帧日志 V2**（`storage-frame-v2-types.ts`）：
每个 AI 楼层可挂一个 `full` checkpoint 帧或 `delta` 帧，状态 = 最近 full ⊕ 其后所有 delta
replay；调度摘要 `{lastFilledAiFloor, lastChangedAiFloor, lastImportBaselineAiFloor}` 持久化在帧上；
mutation source 枚举 10 种（`auto_fill / manual_fill / group_fill / manual_crud / raw_sql_mutation /
raw_sql_batch / import / merge_summary / template_assistant / system`），审计到「哪类入口写的」。
生命周期：建表（模板/预设）→ 首填（`initNode` 文案）→ 每轮增补 → 结算（zero-layer
`table-settlement.ts` 用 `effectId + fingerprint` 幂等）→ 回退（换 replay 根 / 删楼帧自然消失 /
`ManualCatchUpProvisionalBridgeV1` 五状态机处理「追平目标早于 full checkpoint」）。

### 5.3 一次更新的完整链路

【事实】触发：`init.ts:714` → `triggerAutomaticUpdateIfNeeded_ACU` →
`buildAutoUpdatePlan_ACU` → `executeAutoFillStagingGroups_ACU`。
默认闸门（`shared/defaults.ts:195-197`、`settings-service.ts:1287-1292`）：
`autoUpdateThreshold=3`（累积 AI 楼层）、`autoUpdateFrequency=1`、`autoUpdateTokenThreshold=500`、
`skipUpdateFloors=0`、`updateBatchSize=3`、`maxConcurrentGroups=1`（**并发默认关**）、
`autoUpdateEnabled=true`；每表可覆盖。
【事实】调度：分组键 = `scheduleSignature + indices + batchSize + staging`；
`requiresBoundaryStaging`（待填范围跨越唯一 full checkpoint）必须走隔离 staging 提交，
缺 runner 时**稳定失败** `staging_runner_unavailable`，绝不降级成普通路径（避免「写坏了还没花钱」）。
【事实】输出协议三轨（`prompt-api-call.ts:104-137,268-305`）：
1. 正文 DSL（默认）：`<tableEdit>` 内 `insertRow / updateRow / deleteRow`（只识别最后一对标签）；
2. 原生工具：`table_fill`（默认 **false**，部分渠道带 `tools` 直接报错）；
3. 严格 JSON：`strictJsonTableFillEnabled` 默认 **false**，确定性翻译成 DSL，能带
   `response_format: json_schema` 才强约束。
【事实】提交前校验：只应用本次 prompt 投影出的表（`discardUnauthorizedTableEditsEnabled=true`）、
总结表/总体大纲与标准表互斥、行锁 `tableUpdateLocks` / `specialIndexLocks`（总结表索引列默认锁）、
身份锁按工作副本解析行号。
【事实】失败处理：空内容/工具解析失败 → `RetryableAiResponseError_ACU` → 重试时把
「可读原回复 + 错误说明」回灌下一次请求（`withTableFillRetryHistory_ACU`）；输入准备失败用
`PrepareAIInputFailure_ACU {failureCode, retryable}` 分类；提交期基础设施错误不重试；
返回 `CardUpdateResult {success, error, aborted, postCommitWarnings}`，service 不驱动 UI。

### 5.4 进 prompt 的五条通道

见 §4.2 的五条；表格视角补充：

- **A 世界书导出（主通道）**：静态 Markdown（`injectionTemplate` 包裹，`splitByRow` 一行一条目、
  3 层分组）或 **延迟 SQL 模板**（SQLite 模式且 `sqlInjectionTemplate` 非空时，条目 content
  就是模板原文，留到 PROMPT_READY 展开）；
- **B `{[db…]}` / `{[sql "…"]}` 查询模板**：ORM 支持 `where/orWhere/区间/IS NULL/orderBy/
  groupBy/having/limit/offset`；`limit` 默认 **null（不限行）**；中文名经 NameMapper 重绑定；
  同步 fail-closed；输出裸文本、无预算无缓存；
- **C 发请求前统一展开**：`helpers-remaining.ts:223` 绑定 `CHAT_COMPLETION_PROMPT_READY`，
  遍历每条消息 content 依次做模板变量 → SQL → `<if>` → 随机/计算；
- **D 填表 Agent 自己的 prompt（`$0`）**：只给填表模型看，与进角色扮演 prompt 是两回事；
- **E 零层按需读表（`$TABLE:`）**：目录只给「表名（N 行）列：a | b | 整表地址」，
  `$TABLE:表名:a-b` 读行区间；超预算返回收窄建议（`agent-read-gate.ts:120`）——
  与叙事台「模型主动检索」同向，见 §3.6 与 §7.5。

### 5.5 跨分支 / 回退一致性

【事实】帧与楼层同生共死：swipe / 删楼 / 替换 frame 时其后 delta 自然消失，
**不需要回滚 API**，重建状态就是重放（`storage-frame-v2-types.ts:565-575` 注释明确：
delta 之间**不维护 revision 链**，因为删中间楼层会合法移除一条 delta，链式校验会误判损坏）。
无分支级快照：ACU 的「分支」语义 = `isolationKey`（数据隔离档案）+ 消息楼层，不是
叙事台的 `branch_id + fork_turn`。跨存储模式用 canonical snapshot 转移（不是迁移函数）；
zero-layer 是另一套 store（自己的 revision/settlement 幂等），但复用同一套填表代码。

### 5.6 可观测性

【事实】日志前缀即审计：`[更新流程] / [填表] / [SQL][readiness] / [SeedRows] / [表格日志]`；
service 只回纯数据 `CardUpdateProgressEvent`，UI 转 toast；`table-delta.ts` 把帧增量投影
成行级 delta 供面板展示；空表头表返回脱敏 `skippedSheets`；SQL 错误默认吞异常，
`throwOnQueryError` 才抛。

### 5.7 与叙事台对照 + 移植三件

| ACU 机制 | 判定 | 理由 |
|---|---|---|
| 逐行 patch + 行锁 + 「只应用提示词声明过的表/行」 | **可借鉴（需改形）** | 与「Agent 只提案、代码落库」同构；补「目标白名单」校验（表/行/字段三重），落点是既有具名表，不引入自由 schema 表格 |
| 逐楼 delta + 周期 full checkpoint + replay | **可借鉴（需改形）** | 与「原文/日志唯一真源、派生可重建」同向；落点必须是独立表 + `branch_id`，**绝不能塞 `turns.meta`** |
| `completedAiFloorBySheetKey` 游标 + `effectId/fingerprint` 幂等回执 + staging | **可借鉴** | 直接补 `branch-guard` 缺的「这条结果是否已结算过」；`aiStarted:false` 区分「没花钱」与「花了钱没落库」 |
| 输出协议三轨 + 渠道探测自动降级 + 失败原因回灌 | **可借鉴** | 正合 AGENTS.md §1.2「给通道不给指令」；叙事台分段演绎已经是同一思路，可补「失败回灌」 |
| 表格→Markdown 渲染器（列投影/隐藏列/空表跳过/行窗口/`splitByRow`） | **可借鉴** | 纯函数，可用于记忆面板/导出/`retrieval` 渲染；「隐藏列」是防泄密好做法 |
| 世界书导出 + 作者配 depth/order | **不适用** | 违反红线 9（system 唯一且首位）与 AGENTS.md §6.3 层预算：注入位置可变 = 预算不可归因、缓存前缀必被打断 |
| `{[db…]}` / `{[sql…]}` 模板注入主 prompt | **必须拒** | 三重违律：红线 1（渲染而非检索）、红线 2（SQL WHERE 即文本匹配选内容）、红线 10（`limit` 默认 null、无预算无降级） |
| SQL 的 NameMapper / 同步 fail-closed / 隔离快照 | **可借鉴（窄用途）** | 只能用于 `codex_lookup` 型只读检索：结果只进 `retrieval` 子层、当拍蒸发、带 token 上限 |
| zero-layer `$TABLE:表名:a-b` + `$TABLE_CATALOG` + read-budget 收窄协议 | **最有价值** | 与「模型主动检索、代码不按文本匹配塞设定」完全同向；目录只给地址与成本，正文要模型自己读 |
| 双存储 native↔sqlite + 快照转移信封 | **不适用** | 违反 AGENTS.md §1.3 无迁移/无兼容层 |
| `insertNode/updateNode` 等自然语言触发器驱动行为 | **不适用** | 违反红线 8 的反面：用文案当行为契约，不可测试、不可归因 |
| 手动重填/一键追平/provisional bridge | **不适用（过重）** | 叙事台回滚 = 开分支（红线 6），不需要原地重填楼层区间 |

**只移植三样**：(a) 逐行增量 + 提案白名单 → `store.js` 具名函数；
(b) `effect_id` 幂等回执 + 完成游标 → `branch-guard`；
(c) 「目录 + 地址 + 预算闸门」的按需读表 → `retrieval` / `codex_lookup`。
**不要**移植 SQL 模板注入、世界书导出注入、双存储。

### 5.8 最需警惕

1. **状态写进聊天楼层**：帧日志 → swipe/删楼/导入/追平/迁移全部要特判，代价是
   50 文件 1.57MB、`update-orchestrator` 5713 行/329KB、persist 240KB。
   叙事台若把记忆塞进 `turns.meta` 会重演同一场事故。
2. **注入位置由作者模板决定 + SQL 无预算**：prompt 体积无上界、缓存前缀被打断、无法按层降级。
3. **「触发器」是提示词文案而非代码契约**：行为不可测。
4. **分支不是一等公民**：ACU 靠 isolationKey + 楼层 + 零层自建 store；叙事台的
   `branch_id + fork_turn + copyBranchState` 更正确。
5. **双存储 + 版本标记字段**：正是叙事台（AGENTS.md §1.3）明令禁止的形态。

---

## 6. 与叙事台逐项对照

| 维度 | 叙事台 v4（现状） | shujuku（ACU） | 判定 |
|---|---|---|---|
| 长程记忆载体 | `scenes` 每场一行（只追加）+ `turns` 原文 | 表格行（纪要表）+ 向量镜像 + 召回 | 方向不同但目标一致；叙事台「原文 + 场次」结构更简单、可回查；shujuku 的「行身份 + 增量」可用于派生索引 |
| 上下文装配 | 六层预算 + 级联降级（system/archive/recent/scene/retrieval/current） | 宿主拼 + 插件改写 + 模板变量；自持会话流两预算三闸 | 叙事台装配权完整，shujuku 是「借宿主口」；shujuku 的闸门可移植 |
| 注入通道 | 封闭 7 层，唯一 `role:system` 在首位 | 5 通道（世界书 constant/keyword/覆盖/就地改写/zero-layer） | 叙事台更干净；shujuku 的 keyword 派生 keys 正是红线 1/2 要禁的形态 |
| 层预算与降级 | 每层独立配额；软目标降级；硬上限**截断**（`over_hard_cap`） | 填表行窗口硬编码 10；注入侧零 token 预算；读侧三闸 fail-closed | 叙事台预算体系更完整；**硬上限截断方式不如 shujuku 的「范围收窄 + 拒绝」** |
| 失效与回滚 | fork 新分支、旧分支 abandoned、`copyBranchState`、`branch-guard` | 帧随楼层消失；无回滚 API；provisional bridge 五状态机 | 叙事台的分支模型更正确；shujuku 是「状态寄宿楼层」的补偿 |
| 幂等与并发 | `branchSnapshot + isBranchCurrent`（写前核对），无结果幂等键 | `effectId + fingerprint` + `completedAiFloorBySheetKey` + staging + 单调 frontier | **叙事台缺结果幂等键**，是最直接可补的一块 |
| 输出协议 | 分段演绎：tools + 流式正文；失败回退单发 | 三轨（DSL/tools/JSON）+ 渠道探测降级 + 失败回灌 | 叙事台已有同构思路；缺「失败原因回灌」 |
| 可观测性 | `meta.assembly / usage / meta.cache / meta.degraded` + SSE | 日志前缀 + progress 事件 + table-delta + skippedSheets | 叙事台可观测性更强；shujuku 的「具名失败码」更细 |
| 主动检索 | `codex_lookup`、`retrieval` 子层、当拍蒸发 | `$TABLE` / `$CODEX` 目录 + 地址 + 预算闸门 | 同向；shujuku 的「目录 + 地址 + 收窄协议」更完整 |
| 缓存纪律 | system 冻结 + `meta.cache` 归因（层名粒度） | 静态根 system + 尾部追加 + drift 探针 + 显式 cache key（已退役） | 叙事台纪律已有；诊断粒度可增强 |
| schema 演进 | 无迁移、无兼容，直接改 CREATE TABLE | 双存储 + 快照转移 + 一堆 `*Version` 字段 | 叙事台更正确，**不要学** |
| 失败哲学 | 「永不静默失真」→ 但硬上限仍截断半句 | fail-closed（读闸/final gate）、具名错误码、但注入侧有 7 类静默失真 | 两边各有缺口；叙事台应把「截断」改成「整段收窄或拒发」 |

**总体判定（回答「有没有值得借鉴的地方」）**：

1. **方向被印证，不需要改架构。** shujuku 把「检索式注入」做到极致（表格→世界书→召回→
   模板变量），复杂度 90% 花在对抗宿主（状态寄宿楼层、双存储、多步写非原子）。
   叙事台的渲染式上下文 + 分支模型 + 无迁移纪律，在同样的目标下更干净。
2. **四个真缺口可补**：硬上限「整段 vs 半句」、结果幂等键、缓存归因粒度、提案目标白名单。
3. **一个可探索方向**：把主动检索做成「目录 + 地址 + 预算闸门」（分段模式内）。

---

## 7. 借鉴清单（按优先级）

> 全部**不新增注入点**、不改六层预算结构、不引入新依赖；按 AGENTS.md §11.5 记录装配基线后逐条落地。
>
> **落地状态（2026-10-24）**：P0-2、P0-1、P0-3、P0-4 均已完成代码 + 测试；
> 2026-10-25 完成 **21 轮真实模型最小验证**（StepFun + 真实 Web 服务；原始记录已删，
> 关键数据摘要见 §9 第 6 条与 §7.4/§7.5 的落地注）。
> **2026-10-25 增补**：§7.6 P1-2（失败原因回灌）已实现——史官 JSON 解析失败重问一次；
> §7.7 P2-4（渲染归属审计）已实现——`meta.messages` 逐条标 owner/tokens；
> 只落地「不新增注入点、不占预算」的纯可观测项。§7.5 P1-1 与 §7.7 其余项仍未动。

### 7.1 P0-1：硬上限不再「截断半句」

- **现状**：`context-engine.js:743-759` 从最长非 system 消息逐次 `truncateToTokens`
  到 70%，再记 `degraded: ['over_hard_cap']`——模型会看到半句话，且被截断的是单条消息。
- **借鉴**：shujuku 的 read gate / final gate 证明超限应当 **fail-closed 或整段收窄**；
  default fence 证明「范围窄但片段完整 + 告知剩余」可行。
- **改法（推荐）**：把硬上限从「单词级截断」改为「**整段/整场收窄**」：
  优先按层整体移除（场景细节 → 场记单 → 检索）并记 `degraded`；
  recent 原文与场次索引不按 token 截断（保持红线 13「无洞」），若仍超
  `CONTEXT_MAX_TOKENS` → **本轮 fail-closed**（SSE `error` 事件 + 明确建议：
  封场/换模型/降低 `BUDGET_RECENT`），而不是把半句送模。
- **落点**：`server/memory/context-engine.js` 出口逻辑 + `tests/test-context.js`。
- **测试**：构造超硬上限的 1000 轮模拟，断言 (a) 不会出现内容被截断在句中的消息；
  (b) 放不下时返回失败并带 `meta.degraded` 明细；(c) `coverage.scene_to + 1 === recent_from` 仍成立。
- **风险**：长局可能「跑不动」而不是「变笨」——需要配合「封场阈值」与用户可见提示；
  建议先做成 env 开关（默认 fail-closed），观察一轮。

### 7.2 P0-2：缓存前缀探针增强到「消息级 + 偏移 + 摘录」

- **现状**：`context-engine.js:775-806` 已算 `prefix_shared_tokens / first_divergence(层名) /
  system_hash`，但没有逐条消息 index、字符 offset、两侧摘录、三判定。
- **借鉴**：`agent-prompt-drift.ts:60,150`：逐条 role+content 比对；首分歧给
  `divergedMessageIndex / divergedCharOffset / ±60 字摘录`；判定
  `identical / appendedMessages（健康）/ 其它（破裂）`。
- **落点**：`context-engine.js` 的 `meta.cache` 增加 `drift: {verdict, index, offset,
  left_excerpt, right_excerpt}`；纯函数可放 `server/memory/` 新模块（不进提示词、不进预算）。
- **测试**：`test-context.js`：连续 10 轮 `verdict === 'appendedMessages'`；
  人为改动 system 后 `verdict === 'broken'` 且 index/offset 正确。
- **风险**：几乎无；注意摘录可能含剧透 → 只进 meta/日志，不进上下文。

### 7.3 P0-3：旁路写入结果幂等键（补 `branch-guard`）

- **现状**：`branch-guard.js` 只有 `branchSnapshot + isBranchCurrent`（写前核对分支/水位），
  重试或重复调用可能重复写同一条记忆；`patches` 有 `status='stale'` 但无 `effect_id`。
- **借鉴**：`effectId + fingerprint` 幂等回执 + `completedAiFloorBySheetKey` 完成游标 +
  `aiStarted:false`（区分「没花钱」与「花了钱但没落库」）。
- **改法**：`store.js` 新增 `effect_receipts(session_id, branch_id, turn_no, agent, effect_id,
  fingerprint, status, applied_at)` 表 + 唯一约束；`archivist / continuity / worldTick / branch`
  写入前查/写回执；失败记录 `pending` 供重放。
- **测试**：`test-memory.js`：同 `effect_id` 重复调用只落一次；stale 分支整批丢弃并记
  `patches(status='stale')`；fork 后旧线回执不影响新线。
- **风险**：新表必须接 `copyBranchState()` 复制规则（AGENTS.md §11.6）；schema 直接改、旧库删重建（AGENTS.md §1.3）。

### 7.4 P0-4：提案白名单（目标声明化）

- **现状**：史官已做「谓词白名单 + 别名归一 + 有效期 + 冲突检测」，但提案的目标
  （subject/entity）仍可能是本轮未声明/未在场的实体；越界时只能靠模型自觉。
- **借鉴**：ACU「只应用本次 prompt 投影里声明过的表/行」（`discardUnauthorizedTableEditsEnabled`）
  + 行锁。叙事台对应物：本次装配声明的在场者、辞书候选、账本路径白名单
  （`state-paths.js`）。
- **改法**：`archivist.js` 校验阶段增加「目标声明集合」比对：不在 `meta.present` /
  `meta.codex` / `state-paths` 白名单中的 subject/entity/path → 拒写并记 `skipped` 明细
  （进 `patches`，不静默）；这是**校验增强**，不是新增注入。
- **测试**：`test-memory.js`：越界 subject 被拒且记 skipped；合法 subject 正常写。
- **风险**：需要先明确「哪些字段允许新实体」（如玩家可提及未登场角色）——这是设计决策，
  建议先只对「会改变账本的写入」生效，纯记录类（原声/场次）放宽。
- **已完成**（2026-10-24）：`archivist.js` 新增 `buildDeclaredTargets()`（从投影卡 cast/codex、
  `context.meta.present` / `codex`、账本人物、玩家名收集）；`applyArchivistUpdate({ declaredTargets })`
  对断言 subject、状态 who、关系两端、账本 characters 的键、非 `introduce` 变更的实体做比对，
  越界项拒写并合并成一条 `patches(kind='skipped_targets', status='skipped')`（明细在 `payload.items`）；
  `introduce` 是唯一新实体入口（仍限 cast/codex），原声/场次/线索不设白名单。
  orchestrator 在每轮装配后构建集合并随 `runArchivist()` 传入。测试：`test-memory.js`
  新增「提案白名单：越界目标拒写并留痕」段（233 passed）。
- **真实运行修正**（2026-10-25）：运行中发现「同一批提案先 `introduce`、后对同一实体写
  ledger/relation」会被自己的白名单拒掉（states/relations 段落先于 changes 处理）。
  已在断言循环前**预扫 changes 的 introduce** 并先登记 declaredSet；补同批用例。

### 7.5 P1-1：主动检索的「目录 + 地址 + 预算闸门」

- **现状**：`codex_lookup` 是「查询 → 返回候选条目全文」，`retrieval` 子层单层预算；
  没有目录、没有地址、没有「超预算请收窄」的协议。
- **借鉴**：`$TABLE_CATALOG` / `$TABLE:表名:a-b` / read-gate 收窄建议。
- **改法（仅分段模式）**：分段演绎的 `codex_lookup` 扩展查询形态：
  `catalog`（列出可查条目：id/名/类型/成本）与 `read <id> [范围]`（读全文）；
  超 `BUDGET_TOOL_RESULTS` 时返回「批次过大/请换更窄地址」且**不回灌正文**；
  工具结果仍只在当拍临时消息，不进 `turns` / 下一轮 `recent`。
- **测试**：`_work/segmented-e2e.mjs`（假上游触发 catalog→read→超预算→收窄）；
  `test-context.js` 断言检索层不超预算、正文不落库。
- **风险**：模型可能不用目录而乱读 → 目录要短、地址要可复制；此前真实运行已观察到
  「场记单足够时模型不查辞书」，不要强迫。

### 7.6 P1-2：失败原因回灌（重试协议）

- **现状**：分段演绎失败只记 `meta.narration.fallback` 后回退单发；填表/史官重试不带错误上下文。
- **借鉴**：ACU `withTableFillRetryHistory_ACU`：重试时把「可读原回复 + 错误说明」回灌下一次请求。
- **落点**：`narrator-loop.js`（分段失败重试一次时带错误摘录）+ `archivist.js`
  （JSON 解析失败重试时带 zod/校验错误信息）。
- **测试**：`segmented-e2e.mjs` 假上游返回坏 JSON → 第二次成功；`test-memory.js` 史官坏输出
  → 重试且最终不落库脏数据。
- **风险**：回灌内容要截断（避免把整段坏输出再塞一遍）；只对「可重试错误」生效。
- **已完成（2026-10-25，史官侧）**：`archivist.js` 新增 `parseArchivistUpdateStrict()` 与
  `buildArchivistRetryMessages()`；解析失败时带坏输出（截 2000 字）+ 错误说明重问一次，
  仍失败写 `patches(kind='archivist_parse_failed', status='failed')` 并返回
  `parse_failed:true`——不落脏数据、也不静默当空提案。测试见 `test-memory.js`
  （`parseArchivistUpdateStrict` 严格判定 + `buildArchivistRetryMessages` 回灌结构：
  原消息 + assistant 坏输出 + 纠正，只有一条 system、坏输出截断 ≤2000 字、纠正要求只发 JSON）。
  端到端重试（假上游）未加自动化，靠真实运行时验证。

### 7.7 P2（视需要）

- **P2-1 派生索引**（若做 P2-2 FTS5 被动召回）：行身份（`scene_id` / `turn_no`）+ 只对新增建索引
  + delta 写在该行所属分支 + `revision = sha256(checkpoint + applied ids)`（对位移不敏感）
  + 三层 GC 骨架；**正文永远从 `scenes`/`turns` 取，索引只做候选**，禁止「摘要的摘要」。
- **P2-2 文本定位算法**（P0-4 定点改稿）：去标点 + 前后缀 + 关键词打分阈值 0.4；
  只用于改稿映射，不用于注入。
- **P2-3 `meta.degraded` 具名化**：`not_ready / truncated / degraded / uncovered` 四类
  （替代现在的字符串数组），与 SSE/前端约定同步。
- **P2-4 渲染层 owner 审计**：`assembleContext` 出口给每条消息标 `owner`（system/archive/…）
  与 `kind`（canon/state/recall），禁止未声明内容进上下文（对应 shujuku「render 层只改内容」）。
  **已实现（2026-10-25）**：`meta.messages = [{index, role, owner, tokens}]`，owner 为七层之一，
  只进 `turns.meta_json`、不进提示词；`test-context.js` 校验归属完整。

---

## 8. 明确不借

| 机制 | 原因 |
|---|---|
| 世界书 constant 条目覆写注入 | 借宿主渲染规则；与用户/其它条目争用；零 token 预算；失败回退变大。违红线 1/10 |
| keyword 条目 keys 由数据列派生 | 本质是 lorebook 触发器，违红线 1/2 |
| `{[db…]}` / `{[sql…]}` 模板注入主 prompt | 检索式注入 + SQL 文本匹配 + 无预算，三重违律 |
| 作者可配 depth/order 的注入位置 | 层与主人必须由代码定；可变位置 = 预算不可归因 + 缓存前缀被打断 |
| zero-layer 把插件状态写进聊天楼层/swipe | 叙事台有 DB 与 `branch_id`；该形态会带来 swipe/删楼/导入全量特判 |
| 双存储（native/sqlite）+ 快照转移 + `*Version` 字段 | 违 AGENTS.md §1.3 无迁移/无兼容 |
| 自然语言「触发器」驱动写入 | 违红线 8 的反面；不可测试、不可归因 |
| 回合内会话压缩 / handoff 摘要 / run cache | 只适用跨轮 agent 会话；叙事台每轮重建，照抄 = 摘要的摘要（红线 4） |
| 显式 `prompt_cache_key` | 已被 shujuku 自身证伪（打断前缀命中）；结构保证优先 |
| UI 后处理式「内容优化」 | 不在回合链路、有损改写、静默跳过；叙事台不需要第二套正文改写器 |
| 手动重填 / 一键追平 / provisional bridge | 回滚 = 开分支（红线 6），不需要原地重填 |

---

## 9. 落地顺序建议

1. **P0-2（缓存探针增强）**：纯可观测、零上下文风险，先做；同时把 `meta.cache` 输出
   接入诊断页（可选）。**已完成**：新增 `server/memory/prompt-drift.js`
   （`comparePromptMessages()`）+ `meta.cache.drift`（verdict/index/char_offset/60 字摘录），
   测试覆盖 identical/appendedMessages/broken/unknown。
2. **P0-1（硬上限语义）**：先记录基线（`_work/check-context.mjs 1000` + 一轮真实装配的
   `budget/meta`），再改出口逻辑；默认 fail-closed，可 env 回退；跑全量测试。
   **已完成**：`CONTEXT_OVER_HARD_CAP`（默认 `fail`）+ 整层收窄（场景细节→场记单→检索）+
   `meta.hard_cap`；`truncate` 仅调试回退；三条降级行为各有测试。
3. **P0-3（幂等回执）**：改 schema（删库重建）+ `store.js` 具名函数 + `branch-guard` +
   四类旁路写入接入；跑 `test-memory` 分支/并发断言。**已完成**：新增
   `effect_receipts` 表（`UNIQUE(session_id,branch_id,effect_id)`）、`runEffectOnce()`，
   archivist / scene_keeper / world_tick / continuity / branch 五处接入；fork 复制
   `applied` 回执；真实 21 轮写入 61 条回执、无重复。
4. **P0-4（提案白名单）**：只对账本类写入生效；避免误伤「玩家提及新角色」的合法路径。
   **已完成**：`buildDeclaredTargets()` + `applyArchivistUpdate({ declaredTargets })`，
   越界项拒写并记 `patches(kind='skipped_targets', status='skipped')`；`test-memory` 233 passed。
5. **P1-1（目录+地址检索）**：等分段演绎稳定（P1-1 第一阶段已在跑）后再动；
   先做 catalog，再做 read 收窄。
6. **P2**：等真实长局（≥500 轮）观察到「召回不够用」或「派生索引确有必要」时再启动，
   不要在 beta 期提前造 FTS5/向量层。**21 轮真实最小验证已完成**：装配体积
   4.3K→13.3K tok（soft 52K，未触发降级）、P0-1 未误触发、P0-2 探针可用（19 broken / 2 unknown，
   首分歧 `archive` 8 次 / `recent` 11 次）、P0-3 写入 61 条回执无重复（1 条因服务重启中止、
   验证了 failed 可重试）、P0-4 无合法目标误伤；upstream `cache_rate` 恒 0，
   本地探针是唯一缓存信号。
7. **2026-10-25 增补（已完成，无新增注入点）**：§7.6 史官失败回灌重试、§7.7 P2-4
   `meta.messages` 归属审计；同期落地 AGENTS §15 P2-4 的辞书 `muted` 静音开关
   （编辑器 + 世界索引/场记候选过滤，钉选不豁免，仍可被主动检索）。
   §7.5 P1-1（目录 + 地址检索）等分段演绎确认为主用模式后再启动。

每步都按 AGENTS.md §11.5：**一次只改一个变量，改完对比 layer tokens 与 meta**。

---

## 10. 证据索引与未覆盖

| 主题 | 覆盖章节 | 备注 |
|---|---|---|
| 记忆（纪要表→向量→召回） | §2 | 原分报告已删，结论并入本节 |
| harness（续写/推演 agent 循环） | §3 | 同上 |
| 注入链路（世界书/渲染/zero-layer） | §4 | 同上 |
| 表格子系统（schema/更新/SQL 注入） | §5 | 同上 |
| 真实运行 21 轮最小验证（P0-1~P0-4 + 数据） | §7–§9 | 原始记录已删；关键数据见 §9 第 6 条 |

未覆盖（分析时各分报告一致列出）：`template-assistant/`、`fill-mode/`、
`storage-frame-v2-persist.ts` 的修复/迁移算法、staging 原子汇合实现、
`manual-fill-planner`、`checkpoint-transfer`、`zero-layer` session/store/runtime 全量、
`visualizer`、`api-call.ts` 多通道路由、向量镜像 `SummaryVectorIndexMirror*`、
plot 任务执行内部、native-tool/strict-json 细节。本次分析只读源码、未跑 build/test，
所有行为结论来自静态阅读；标注【事实】的仅为代码写明的契约，不代表运行时一定成立。

