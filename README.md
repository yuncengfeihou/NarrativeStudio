# 叙事台 · Narrative Desk

> 世界卡驱动 · 触发式设定注入 · 分层记忆 · OpenAI 兼容 API

一套给长篇小说/互动剧情用的**演绎工作台**。

一张**世界卡**承载一个世界的全部硬设定（宪章、人物、幕结构、词条库）。
从这张卡可以开出任意多段**剧情会话**，每段独立推进、独立记忆，互不干扰。
每一轮由**剧情演绎 Agent** 流式写出数千字正文，**记忆 Agent** 归档，
**分支 Agent** 给出下一步的三四条路。

核心是一套**上下文引擎**：写再多的设定，进入提示词的也只有「这一刻用得到的部分」。
剧情推进一千轮，每轮装配出来的提示词仍然是一万来 token，而不是一路涨到百万级。

---

## 快速开始

```bash
pnpm install          # 只依赖 express，Node ≥ 22.5
pnpm start            # 或 node server/index.js

# 打开 http://localhost:3210
```

首次运行需要把 `presets/` 里的世界卡导入数据库：

```bash
node _work/seed-worlds.mjs           # 导入
node _work/seed-worlds.mjs --reset   # 清空旧数据后导入
```

配置在 `.env`（已含默认值）。必填的只有 `STEPFUN_API_KEY`。

---

## 它解决什么问题

写长剧情的 AI 应用通常死在同一个地方：**设定与记忆无节制地堆进提示词**。

- 一开始把世界观、角色卡、规则全塞进 system ——3 万 token 起步。
- 剧情走长了，摘要、实体、事实、检索结果层层叠加 ——很快就顶到上限。
- 顶到上限之后开始丢东西，于是角色开始忘事、设定开始漂移。

叙事台的做法是把「什么进上下文」变成**逐层配额 + 触发注入**：

| 层 | 内容 | 配额 | 什么时候进 |
|---|---|---|---|
| 演绎契约 | 视角 / 文风 / 篇幅 / 禁令 | ~1.0K | 永远（固定文本） |
| 世界宪章 | 世界的物理与制度底座 | ~1.5K | 永远 |
| 主角速写 | 处境 / 能力边界 / 内心声音 | ~0.6K | 永远 |
| 在场卡司 | **只有本轮在场的**角色卡 | ~0.8K | 按名字/场景命中 |
| 触发词条 | 设定碎片 | ~0.7K | **关键词命中才进** |
| 场景账本 | 时间 / 地点 / 在场 / 随身 / 张力 | ~0.15K | 有快照时 |
| 导演卡 | 当前幕的目标与必达节拍 | ~0.3K | 世界卡有幕结构时 |
| 分层记忆 | 摘要 / 关系 / 线索 / 实体 / 反思 / 笔记 | ≤14K | 有内容时，内部再分配 |
| 历史检索 | 与本次行动相关的旧片段 | ~0.2K | 命中时 |
| 最近原文 | 逐字保留的最近几轮 | ≤9K | 有历史时 |

每一层的配额是**独立的**。设定写得再多，只会撑满「触发词条」这一层，
不会把记忆层挤掉；记忆长得再大，也不会挤掉宪章。

实测（`_work/check-context.mjs`，400 轮模拟）：

```
轮次  总量   契约  世界  卡司  词条  场景  导演  记忆  检索  最近  输入
  20  11075   994  1436   806   699   142   276   2497   129  4066    30
 200  13170   994  1436   806   699   142   232   4636   129  4066    30
 400  14651   994  1436   806   699   142   232   6117   129  4066    30
```

总量在 11K–17K 之间锯齿波动（记忆层填满配额后趋于稳定），而不是线性增长。

---

## 世界卡

一张世界卡由五部分组成：

### 1. 宪章（charter）

任何场景下都成立的硬设定。**不写具体事件，只写这个世界的规则**。

```json
"charter": [
  { "rule": "女子主外、掌权、娶夫；男子主内、被娶、称「嫁」。" },
  { "rule": "司楼是合法存在的官营青楼，是悬在每个男人头上的刀。" }
]
```

十条左右为宜。它会每轮都进入上下文，所以每条都要「不写就会演错」。

### 2. 卡司（cast）

每个角色的卡里，重要的是三件事：

- `voice` 口吻 —— 台词风格、自称、对主角的称呼
- `secret` 隐秘动机 —— **引擎会遵守，但不会说破**
- `one_line` 一句话 —— 装不下详版时的降级形式

`always: true` 的角色（如始终在场的亲人）每轮都在；
其余角色**只在本轮被提到、或在场景账本里有时才进上下文**。
12 个角色的卡，通常只有 2–4 个会进入某一轮的提示词。

### 3. 幕（arcs）

```json
{
  "title": "雨街·先预定",
  "turns": 8,
  "goal": "让玩家亲历「被认出来」这一刻",
  "beats": ["雨落下，张兰赶人，凌玥认出他", "她喊出「卿儿」"],
  "avoid": ["不要让伍卿立刻相信她"]
}
```

幕结构解决的是「设定很丰富但剧情原地打转」。引擎每轮都会收到
**当前是第几幕、这一幕要达成什么、必达节拍是什么、不要做什么**，
于是它会往前推，而不是无限铺陈氛围。

### 4. 词条（lore）

```json
{
  "keys": ["司楼", "青楼", "卖进去"],
  "secondary": [],
  "title": "司楼",
  "content": "官营的、合法存在的青楼。男子被卖进司楼，是这个世界最彻底的「消失」。",
  "priority": 75,
  "constant": false
}
```

- `keys`：任一出现即触发
- `secondary`：必须同时命中其中之一才触发（过滤「凌」这种泛词）
- `constant`：无条件常驻
- `priority`：超配额时的保留顺序

词条是「设定可以很细，但上下文不膨胀」的关键。一张卡可以写 30 条词条，
某一轮通常只触发 2–5 条。

### 5. 开场种子 + 开场场景

`opening_seed` 是第一轮的种子文本；`opening_state` 是开场的场景锚点
（时间、地点、天气、在场人物、随身物品）。

后者很重要：没有它，引擎会自己猜季节和地点——实测把「初冬的湘曲」猜成了「A 市的夏天」。

---

## 记忆系统

### 分层压缩

| 层 | 覆盖 | 压缩节奏 |
|---|---|---|
| L1 轮 | 1 轮 | 每轮生成 |
| L2 幕 | 6 轮 | 每 6 条 L1 合并 |
| L3 卷 | 24 轮 | 每 4 条 L2 合并 |
| L4 编年 | 96 轮 | 每 4 条 L3 合并 |

### 四本账

除了摘要，记忆 Agent 每轮还会维护：

| 账本 | 记什么 | 为什么单独记 |
|---|---|---|
| **关系账本** | 谁对谁什么态度、为什么变 | 关系是剧情的主要张力来源，混在 state 里每轮被覆盖就丢了 |
| **线索账本** | 埋了什么伏笔、收没收 | 防止「埋了忘收」，也防止把已回收的当悬念 |
| **实体 + 事实** | 人物/地点/物件的档案与三元组 | 可检索、可人工修正 |
| **反思** | 每 5 轮回看摘要提炼的判断 | 比摘要更浓缩，防止剧情走形 |

### 检索

BM25（CJK bigram）+ 结构加权，语料覆盖摘要、实体、关系、线索、反思与最近原文。
配置了嵌入模型时会混入向量相似度，未配置则完全跳过。

### 可编辑

记忆面板里可以直接：

- 固定实体 / 事实（永远不会被预算挤掉）
- 撤回事实（软删除，保留审计）
- 修正场景账本（时间/地点/随身/张力）
- 停用笔记
- 删除错误的档案、线索、反思

### 回滚

回到第 N 轮会级联清理：回合 → 摘要 → 状态 → 事实 → 关系 → 线索 → 反思，
并把已回收的线索复位为未回收。

---

## Token 遥测

每一轮旁白下方都有一条遥测（悬停显示）：

```
首字 2.9s   用时 3m06s   输入 2.5K   输出 11K   速度 61.6 tok/s
```

- **首字**：从发请求到第一个字出现（TTFT）
- **用时**：整轮耗时
- **输入 / 输出**：这一轮消耗的 token
- **速度**：生成阶段的 tok/s（不含排队与预填充）
- **缓存**：前缀缓存命中率（上游返回时才有）

记忆面板的「遥测」页给出**整个会话**的汇总：总请求、总输入、总输出、
平均首字、平均速度、累计缓存命中率。

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  Web（原生 ESM，无构建）                                       │
│  图标栏 + 目录栏 + 主区                                        │
│  世界卡列表 · 世界卡详情 · 演绎阅读器 · 世界卡编辑器 · 设置      │
└───────────────┬──────────────────────────────────────────────┘
                │ 原生 API（SSE）
┌───────────────▼──────────────────────────────────────────────┐
│  Express                                                      │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐    │
│  │ Orchestrator│─▶│  Narrator  │  │  Branch Agent        │    │
│  │  回合管线   │  │  流式演绎   │  │  3-4 条走向          │    │
│  └──────┬─────┘  └────────────┘  └──────────────────────┘    │
│         │                                                     │
│  ┌──────▼─────────────────────────────────────────────────┐  │
│  │  Context Engine（核心）                                  │  │
│  │  契约 → 宪章 → 主角 → 在场卡司 → 触发词条 → 场景账本     │  │
│  │  → 导演卡 → 分层记忆 → 检索 → 最近原文 → 本轮输入        │  │
│  │  每层独立配额，体积不随剧情增长                          │  │
│  └──────┬─────────────────────────────────────────────────┘  │
│         │                                                     │
│  ┌──────▼─────────────────────────────────────────────────┐  │
│  │  Memory                                                 │  │
│  │  分层压缩（轮→幕→卷→编年）                               │  │
│  │  + 关系账本 + 线索账本 + 反思 + 实体/事实                │  │
│  │  + BM25 检索 + 回滚 + 人工修正                           │  │
│  │  SQLite 全量归档                                         │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────┬──────────────────────────────────────────────┘
                ▼
        StepFun API（OpenAI 兼容）
```

---

## API

### 世界卡

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/worlds` | 卡列表（含会话数） |
| GET | `/api/worlds/:id` | 完整卡（card + lore + sessions） |
| POST | `/api/worlds` | 新建 / 覆盖 |
| PATCH | `/api/worlds/:id` | 局部更新 |
| DELETE | `/api/worlds/:id` | 删除 |
| POST | `/api/worlds/:id/lore` | 新增词条 |
| PATCH | `/api/worlds/:id/lore/:entryId` | 修改词条 |
| DELETE | `/api/worlds/:id/lore/:entryId` | 删除词条 |
| POST | `/api/worlds/:id/sessions` | 从这张卡开一局 |

### 剧情会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions?world_id=` | 会话列表 |
| GET | `/api/sessions/:id` | 详情（含 turns / state / usage / 记忆统计） |
| PATCH / DELETE | `/api/sessions/:id` | 更新 / 删除 |
| POST | `/api/sessions/:id/turn` | 跑一轮（SSE） |
| POST | `/api/sessions/:id/opening` | 生成开场（SSE） |
| POST | `/api/sessions/:id/branches` | 重新生成走向 |
| GET | `/api/sessions/:id/turns` | 分页读回合 |
| GET | `/api/sessions/:id/search` | 全文检索 |

### 记忆

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions/:id/memory` | 完整统计 |
| GET/POST | `/api/sessions/:id/notes` | 笔记 |
| PATCH/DELETE | `/api/sessions/:id/notes/:id` | 改 / 删笔记 |
| PATCH/DELETE | `/api/sessions/:id/entities/:id` | 固定 / 编辑 / 删实体 |
| POST | `/api/sessions/:id/facts` | 新增事实 |
| PATCH/DELETE | `/api/sessions/:id/facts/:id` | 固定 / 撤回 |
| PUT | `/api/sessions/:id/state` | 修正场景账本 |
| DELETE | `/api/sessions/:id/relations/:id` | 删关系 |
| DELETE | `/api/sessions/:id/threads/:id` | 删线索 |
| DELETE | `/api/sessions/:id/reflections/:id` | 删反思 |

### 剧情编辑

| 方法 | 路径 | 说明 |
|---|---|---|
| PATCH | `/api/sessions/:id/turns/:turnNo` | 改写正文（可重建记忆） |
| POST | `/api/sessions/:id/rollback` | 回滚（级联清理） |
| POST | `/api/sessions/:id/rewrite` | 重写某轮（SSE） |

### SSE 事件

```
turn_start → context → reasoning / narrative（增量）→ narrative_done
          → memory → state → branches → done
```

`context` 事件携带本轮的装配预算与诊断信息（在场人物、触发词条、当前幕）。

### OpenAI 兼容（`/v1`）

```bash
# 透传（无 session_id）
curl $BASE/v1/chat/completions -d '{"model":"step-5-preview","messages":[...]}'

# 角色扮演（带 world_id + session_id）
curl $BASE/v1/chat/completions -d '{
  "model": "step-5-preview",
  "world_id": "nvzun-jianpolan",
  "session_id": "new",
  "messages": [{"role":"user","content":"我的行动"}],
  "generate_branches": true,
  "stream": true
}'
```

---

## 测试

```bash
node tests/run-all.js              # 全部（自动跳过需要服务端的套件）
node tests/run-all.js memory       # 只跑记忆

node tests/test-context-engine.js  # 上下文引擎（38 项，无网络）
node tests/test-memory.js          # 记忆确定性逻辑（38 项，无网络）
node tests/test-api.js             # HTTP 集成（38 项，需服务已启动）

node _work/check-context.mjs 400   # 400 轮上下文规模模拟（无网络）
```

实测结果：

| 套件 | 结果 |
|---|---|
| test-context-engine.js | ✅ 38/38 |
| test-memory.js | ✅ 38/38 |
| test-api.js | ✅ 38/38 |
| check-context.mjs（400 轮） | ✅ 上下文 11K→16.6K tok，锯齿稳定 |

真实 API 跑通开场轮：3931 字，首字 3.7s，52.3 tok/s，记忆产出 7 实体 / 9 事实 / 2 关系 / 3 线索。

---

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `STEPFUN_API_KEY` | — | 必填 |
| `STEPFUN_BASE_URL` | `api.stepfun.com/step_plan/v1` | 上游 |
| `CONTEXT_SOFT_TOKENS` | 52000 | 每轮装配的软目标 |
| `CONTEXT_MAX_TOKENS` | 200000 | 硬上限（安全网） |
| `BUDGET_*` | 见 `.env.example` | 各层配额 |
| `RECENT_RAW_TURNS` | 4 | 逐字保留的最近轮数 |
| `ARC_EVERY` / `SAGA_EVERY` / `CHRONICLE_EVERY` | 6/4/4 | 压缩节奏 |
| `REFLECT_EVERY` | 5 | 反思间隔 |
| `LORE_RECURSION` | 0 | 词条递归触发（默认关，开了容易膨胀） |
| `NARRATOR_EFFORT` 等 | high/medium/low | 各 Agent 推理强度 |

---

## 目录

```
ai-roleplay/
├── server/
│   ├── index.js / config.js / tokens.js / llm.js
│   ├── agents/         orchestrator · narrator · branch · memory-agent
│   ├── memory/         store · context-engine · compressor · retriever
│   ├── prompts/        memory · branch
│   └── routes/         worlds · sessions · presets · openai · static
├── web/                原生 ESM 前端（无构建）
│   ├── styles/         tokens · base · shell · views · chat · panels
│   └── js/
│       ├── app.js / shell.js / store.js / api.js / ui-kit.js
│       ├── views/      worlds · world · world-edit · play · settings
│       └── panels/     memory
├── presets/            世界卡种子
│   └── nvzun-jianpolan.json
├── 素材/               原作与深度分析
├── tests/              单元 + 集成
├── _work/              一次性脚本（播种、模拟、清理）
└── docs/CONTRACTS.md   模块契约
```

---

## 剧本实战：《我在女尊世界捡破烂》

`presets/nvzun-jianpolan.json` 是把 `素材/我在女尊世界捡破烂/` 的 124 章（27.7 万字）
转成的一张世界卡：

- **宪章 10 条**：女尊男卑的制度、礼法、司楼、私兵上限、物价锚点、专名表、三条悬念线
- **卡司 12 人**：凌玥 / 黎婆 / 大黑牛 / 陆可 / 谢沐 / 姬淮澄 / 南荣兰冰 / 凌璇 / 许映 / 张兰 / 姬延 / 姬凡
- **幕 10 段**：从「雨街·先预定」到「天生的王者」，每幕带目标、必达节拍与忌避
- **词条 30 条**：司楼、玉佩、腿伤、动物亲和、凌府、巍江、称呼礼法、钱与物价…
- **开场锚点**：初冬 · 湘曲市商务大厦门口的雨街

几处刻意保留的「原文陷阱」：

- 村名原文从未给出 → 保持无名
- 玉佩 / 腿伤成因 / 动物亲和 → 只许暗示，不许揭底
- 情色尺度 → 清水，写进宪章
