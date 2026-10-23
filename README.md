# AI Roleplay Studio

> character.ai 平替 · Apple iOS 美学 · 多 Agent 协同记忆系统 · OpenAI 兼容 API

一个完整的 AI 角色扮演平台：用户提供基础设定（开场白 / 世界观 / 角色 / 扮演规则），**剧情分支 Agent** 提供分支选项（玩家也可自行输入行动），**剧情演绎 Agent** 根据选择演绎每轮数千字的剧情。核心是一套**分层记忆系统**，支持**上千轮剧情不失忆**，同时**上下文始终低于 200K tokens**。

## 快速开始

```bash
# 1. 安装依赖（仅 express，Node ≥ 22.5）
pnpm install

# 2. 配置 API Key（已预填，可修改 .env）
#    STEPFUN_API_KEY / STEPFUN_BASE_URL / STEPFUN_MODEL

# 3. 启动
pnpm start          # 或 npm start / node server/index.js

# 4. 打开
#    Web 客户端      http://localhost:3210
#    OpenAI 兼容 API http://localhost:3210/v1
```

## 架构

```
┌────────────────────────────────────────────────────────────────┐
│  Web 客户端（iOS/iPadOS 美学，原生 ESM，无构建）                 │
│  浮动应用窗口 = 侧栏（会话库/搜索/外观） + 主区（仪表盘·聊天·设定）│
│  毛玻璃 · 大圆角 · 弹簧动画 · 浅色/深色双模式 · 桌面双栏/移动抽屉 │
└───────────────┬────────────────────────────────────────────────┘
                │ 原生 API（SSE）            OpenAI 兼容 API
┌───────────────▼────────────────────────────────────────────────┐
│  Express 服务端                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │  Orchestrator│──▶│   Narrator   │   │ 剧情分支 Agent      │  │
│  │  回合管线    │   │  剧情演绎    │   │ 3-4 个分支选项      │  │
│  │  (会话串行锁)│   │  流式输出    │   │                    │  │
│  └──────┬───────┘   └──────────────┘   └────────────────────┘  │
│         │                                                       │
│  ┌──────▼───────────────────────────────────────────────────┐  │
│  │              分层记忆系统（核心）                          │  │
│  │  L1 轮摘要(400tok) → L2 弧摘要(1.5K) → L3 史诗(2.5K)     │  │
│  │  → L4 编年史(5K)   每 5/25/125 轮自动压缩                  │  │
│  │  + 实体档案 + 事实三元组 + 剧情状态机 + BM25 检索           │  │
│  │  SQLite 全量归档 · 上下文装配器（预算驱动）                 │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
                │
                ▼
        StepFun API（step-5-preview，step_plan 通道）
```

## 前端形态

- **桌面（≥901px）**：iPadOS 风格浮动应用窗口（1280px 上限、24px 圆角、柔和阴影），左侧毛玻璃侧栏（292px：搜索 + 会话列表 + 外观/设置），右侧主区（毛玻璃导航栏 + 内容）
- **移动（≤900px）**：全屏单栏，侧栏变为抽屉（汉堡唤出 + 遮罩）
- **主题**：浅色 / 深色 / 跟随系统，`localStorage` 持久化，首屏前内联脚本防闪白
- **视图**：仪表盘（#/library）、聊天（#/chat/:id）、设定（#/setup、#/setup/:id）、设置（#/settings）

## 多 Agent 协同

| Agent | 职责 | 推理强度 | 输出 |
|---|---|---|---|
| **剧情演绎 Agent** (narrator) | 根据装配好的上下文演绎本轮剧情 | `high` | 1500-3000 字沉浸式叙事（流式） |
| **剧情分支 Agent** (branch) | 基于当前局势生成 3-4 个分支选项 | `medium` | JSON：标题/描述/风格/张力增量 |
| **记忆 Agent** (memory) | 每轮后更新记忆：摘要、实体、事实、状态、压缩 | `low` | L1 摘要 + 记忆更新统计 |

回合流程：`玩家行动/分支选择 → 装配上下文 → 演绎Agent流式输出 → 持久化 → 记忆Agent更新 → 分支Agent生成下一轮选项`。

## 记忆系统：上千轮不失忆，上下文 < 200K

### 分层压缩（5 轮 / 25 轮 / 125 节奏）

| 层级 | 覆盖 | 单条 tokens | 上下文中保留 |
|---|---|---|---|
| L1 轮摘要 | 1 轮 | ~400 | 最近 5 条 |
| L2 弧摘要 | 5 轮 | ~1500 | 最近 8 条 |
| L3 史诗摘要 | 25 轮 | ~2500 | 最近 8 条 |
| L4 编年史 | 125 轮 | ~5000 | 全部（预算内） |

原始档案（每轮 ~2800 tokens）全量存 SQLite；**工作上下文只装压缩表示 + 最近原始轮次**。

### 上下文装配（预算驱动，优先级从高到低）

1. 系统提示词（角色口吻/规则）— 3-8K
2. 世界观 + 角色卡 — 4-12K
3. 剧情状态机（时间/地点/关系/物品/任务/张力）— 1-4K
4. 分层摘要（L4→L3→L2→L1 倒序）— ≤60K
5. 实体档案 + 事实三元组 — ≤12K
6. **BM25 检索历史细节**（CJK bigram，与当前行动相关）— ≤16K
7. 最近 4 轮原始对话 — ~11K
8. 本轮玩家输入（文本 + 图片）

超预算时从低到高丢弃；硬上限 200K（`.env` 可调）。

### 规模验证

```bash
SIM_ROUNDS=1200 node tests/simulate-memory.js
# → 1200 轮后上下文 ~XX K tokens（压缩比 ~XXX 倍）
```

## API

### OpenAI 兼容（`/v1`）

```bash
# 透传模式（无 session_id）
curl $BASE/v1/chat/completions -H "Authorization: Bearer $KEY" -d '{
  "model": "step-5-preview",
  "messages": [{"role":"user","content":"你好"}],
  "reasoning_effort": "medium",     # 推理强调调整：low/medium/high
  "stream": true
}'

# 角色扮演模式（带 session_id，多 Agent 管线 + 记忆系统）
curl $BASE/v1/chat/completions -d '{
  "model": "step-5-preview",
  "session_id": "new",              # 或 'new' + settings 创建新会话
  "settings": {...},                # 首次必需
  "messages": [{"role":"user","content":"我推开门走了进去"}],
  "generate_branches": true,
  "stream": true
}'
```

- 图片输入：user content 用 `[{type:'text'},{type:'image_url',image_url:{url}}]`（http(s) 或 base64 data URI）
- 流式：标准 SSE，`reasoning_content`/`reasoning` 与 `content` 分字段增量下发
- `GET /v1/models` 列出可用模型

### 原生 API（`/api`，驱动 Web 客户端）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 模型/默认值/上限 |
| GET/POST | `/api/sessions` | 会话列表 / 创建 |
| GET/PATCH/DELETE | `/api/sessions/:id` | 详情 / 更新 / 删除 |
| POST | `/api/sessions/:id/turn` | 跑一轮（SSE 事件流） |
| POST | `/api/sessions/:id/opening` | 生成开场白（SSE） |
| POST | `/api/sessions/:id/branches` | 重新生成分支 |
| GET | `/api/sessions/:id/memory` | 记忆系统统计（上下文占用环） |

SSE 事件协议：`turn_start` → `reasoning`/`narrative`（增量）→ `narrative_done` → `memory` → `state` → `branches` → `done`。

## 测试

```bash
pnpm test                    # 全部
node tests/test-memory.js    # 记忆系统单元测试（13 项）
node tests/test-agents.js    # Agent + 提示词测试（17 项 mock + 2 项真实 LLM）
node tests/integration.js    # 真实 API 端到端（需要 KEY）
SIM_ROUNDS=1200 node tests/simulate-memory.js   # 记忆规模化模拟
```

### 实测结果（2026-10-23，真实 StepFun API）

| 套件 | 结果 |
|---|---|
| test-memory.js | ✅ 13/13 通过（分词/BM25/装配预算/幂等压缩/12000 tok 压测） |
| test-agents.js | ✅ 17/17 mock 通过；真实 LLM：开场 2848 字剧情、4 个 tone 多样分支 |
| integration.js | ✅ 全部通过：开场 SSE、分支选择回合、记忆统计、OpenAI 透传（流式+非流式）、OpenAI 角色扮演流式 |
| simulate-memory.js | ✅ **1200 轮后上下文仅 48,328 tok（24.2% / 200K），压缩比 70×** |
| 全量回归（6 套件） | ✅ ALL TEST SUITES PASSED |
| 浏览器全流程 | ✅ 仪表盘 / 聊天（流式 + 思考过程 + 回合分隔）/ 分支卡片 / 更多菜单 / 记忆面板 / 设置；桌面双栏 + 移动抽屉 + 深色模式 |

上下文增长曲线（模拟）：100 轮 25K → 500 轮 30K → 1000 轮 42K → 1200 轮 48K tokens。

### 交互功能

- **回合分隔条**：每轮「第 N 回合 · HH:mm」
- **分支选项**：消息列表内卡片组（tone chip + 张力增量 Δ）+ 输入栏上方 pill 条；选中后作为下次行动，支持自定义行动
- **消息操作**：悬停 ⋯ → 复制内容
- **更多菜单**（导航栏 ⋯）：继续生成 / 重新生成分支 / 导出 Markdown / 记忆系统
- **记忆面板**：上下文占用环、分层记忆堆叠条、本轮 BM25 检索命中、实体档案、剧情状态（张力仪表）
- **设置**：主题分段控件、模型与推理强度、记忆系统参数、OpenAI 接入说明

## 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `STEPFUN_API_KEY` | — | **必填** |
| `STEPFUN_BASE_URL` | `https://api.stepfun.com/step_plan/v1` | 上游 |
| `CONTEXT_MAX_TOKENS` | 200000 | 上下文硬上限 |
| `RECENT_RAW_TURNS` | 4 | 保留的原始轮数 |
| `RETRIEVAL_TOP_K` | 6 | BM25 检索条数 |
| `ARC_EVERY` / `SAGA_EVERY` / `CHRONICLE_EVERY` | 5 | 压缩节奏 |
| `NARRATOR_EFFORT` 等 | high/medium/low | 各 Agent 推理强度 |
| `NARRATOR_MAX_TOKENS` / `BRANCH_MAX_TOKENS` / `MEMORY_MAX_TOKENS` | 12000 / 5000 / 6000 | 生成上限（step-5-preview 的推理过程计入 max_tokens，已预留推理空间） |

## 目录

```
ai-roleplay/
├── server/
│   ├── index.js / load-env.js    入口（.env 优先加载）
│   ├── config.js / tokens.js / llm.js
│   ├── agents/               orchestrator · narrator · branch · memory-agent
│   ├── memory/               store(SQLite) · compressor · retriever · assembler
│   ├── prompts/              narrator · branch · memory 提示词
│   └── routes/               openai · sessions · static
├── web/                      iOS/iPadOS 美学前端（原生 ESM）
│   ├── index.html            应用外壳（侧栏 + 主区）
│   ├── styles/               ios.css(设计系统) · app.css(视图) · shell.css(外壳)
│   └── js/                   app · sidebar · library(仪表盘) · setup · chat ·
│                             memory-panel · settings · api · store · util
├── tests/                    单元 + 集成 + 模拟
└── docs/CONTRACTS.md         模块契约
```
