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
│   │   └── scene-sheet.js  世界索引 / 辞书挑选 / 场记单渲染（纯函数）
│   ├── agents/
│   │   ├── orchestrator.js    回合管线（会话级串行锁、分支感知）
│   │   ├── narrator.js        剧情演绎（流式，永不输出 JSON）
│   │   ├── archivist.js       史官：类型化抽取 + 确定性落库
│   │   ├── memory-pipeline.js 场记 / 校勘 / 检索 / 世界呼吸
│   │   ├── branch.js          走向生成
│   │   └── card-smith.js      小说 → 世界卡制卡流水线
│   ├── memory/
│   │   ├── store.js        SQLite CRUD（世界卡/会话/记忆/分支/提案）
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
│       └── narrator.js     尾注
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
    facets: { sensory, rules[], consequences[], history },
    links[], reveal: 'public|rumor|secret', canon_from, detail, pinned,
  }],
  timeline: [{ id, when, where, what, who[], source, canon: 'past|future|branch' }],
  anchors: [{ id, label, after_event, snapshot, opening_seed, note }],
  player: { mode: 'original|canon', canon_character, name, …, knowledge },
  author_notes: [{ text, scope: 'always|scene|session' }],
}
```

**投影表**（可 SQL 查询，随 saveWorld 同步）：

```sql
codex_entries(world_id, codex_id, type, name, aliases_json, tags_json, summary,
              facets_json, links_json, reveal, canon_from, detail, pinned, sort)
timeline_events(world_id, event_id, when_label, where_label, what, who_json, source, canon, sort)
anchors(world_id, anchor_id, label, after_event, snapshot_json, opening_seed, note)
```

### 会话与回合

```js
sessions { id, world_id, title, settings_json, turn_count, usage_json, status,
           branch_id, anchor_id, scene_seq, created_at, updated_at }
turns    { id, session_id, turn_no, kind, content, images_json, reasoning,
           branch_choice_json, token_count, usage_json, meta_json, branch_id, … }
branches { session_id, branch_id, parent_branch, fork_turn, status, note }
```

回合编号全局递增；`branch_id` 标记归属。分支可见 = 本分支回合 + fork_turn 之前的继承回合。

### 记忆六表

```sql
scenes(session_id, branch_id, scene_id, level, turn_from, turn_to, when_label,
       place, place_id, cast_json, question, outcome, threads_json, state_json, token_count)
assertions(session_id, branch_id, subject, predicate, object, valid_from, valid_to,
           asserted_turn, source_turn, confidence, visibility, status, superseded_by, evidence)
character_states(session_id, branch_id, who, field, value, valid_from, valid_to, updated_turn)
voices(session_id, branch_id, who, text, turn_no, kind, pinned)
patches(session_id, branch_id, agent, kind, payload_json, evidence, status, severity, turn_no, applied_at)
```

**断言语义**：冲突（同主同谓、对象不同、有效期重叠）时旧断言 `status='invalidated'`
并记 `valid_to`，**不删除**。`getAssertions(atTurn)` 按时间点回溯，不过滤 status
（只排除 retracted）。

**受控词表**（`server/prompts/archivist.js`）：

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

## Scene Sheet 接口（纯函数）

```js
import { renderWorldIndex, selectCodex, renderSceneSheet } from './world/scene-sheet.js';

renderWorldIndex(card, capTokens)                  // 人物表；超配额降级为只留名字
selectCodex(card, { presentIds, mentionedIds, threadTags, pinnedIds })
  // -> [{entry, score, why[]}]  实体连接 60 / 主题标签 30 / 钉选 100
renderSceneSheet({ ledger, present, relations, threads, codex, voices, echoes, directive, capTokens })
  // -> {text, meta}  按 when/cast/pressure/threads/relations/knowledge/directive/codex/echoes 顺序装配
```

## Context Engine 接口

```js
import { assembleContext, buildSystemLayer, buildContract } from './memory/context-engine.js';

const ctx = await assembleContext({ session, world, turnNo, playerText, images,
                                    branchChoice, isOpening, directive });
// -> { messages, budget:{system,recent,scene,current,total}, state, ledger, anchor,
//      recentTurns, echoes, meta:{present, mentioned, theme_tags, codex, branch, degraded} }
```

装配顺序（缓存友好）：**稳定前缀 → 追加原文 → 易变尾部**

```
1. system   契约 + 命题 + 宪章 + 世界索引
2. …        最近原文（player/assistant 交替）
3. user     场记单（每场变一次）
4. user     本场指令 + 本轮行动 + 尾注
```

### 硬约束

- **只有一条 `role:'system'`，且必须在最前。**
- **没有关键词触发、没有扫描深度、没有递归、没有优先级、没有常驻开关。**
- codex 条目按预估成本决定条数（`scene * 0.45 / 90`），高分优先，低分整条放弃。
- 超预算降级：裁场记单 → 砍一半最近原文 → 截断最长非 system 消息。
- 玩家角色永远在场（即使不在 cast 里，也会造一个最小条目）。

## Agent 接口

```js
// 史官（每轮后）
runArchivist({ session, world, turnNo, playerText, narrative, branchChoice, options, signal })
// -> { applied:{assertions, assertions_invalidated, states, relations, threads, voices, ledger},
//      scene_change, uncertain, usage }
applyArchivistUpdate({ sessionId, branchId, turnNo, update, aliasIndex })   // 纯函数，可单测
parseArchivistUpdate(content)     // 容错：整体 JSON → 正则提取 → 空形状降级
sanitizeAssertion(raw, aliasIndex) / sanitizeState(raw, aliasIndex) / mergeLedger(old, delta, {aliasIndex})

// 场记 / 校勘 / 检索 / 世界呼吸（server/agents/memory-pipeline.js）
closeScene({ session, world, turnNo, reason })        // 切场归档
detectSceneChange(session, update, turnNo)            // 地点/时间/在场者变了就切
runContinuity({ session, world, turnNo, signal })     // -> {issues, healthy, applied}
runLibrarian({ session, question, signal })           // -> {found, answer, citations, calls}
runWorldTick({ session, world, turnNo, signal })      // -> {events}

// 制卡（server/agents/card-smith.js）
smithCard({ dir, title, premise, concurrency, maxChapters, startAt, openingSeed, player, onProgress, signal })
// 内部步骤（不导出）：readChapters / parseChapterExtract / buildCardFromExtracts
```

## Orchestrator 接口

```js
runTurn({ sessionId, playerText, images, branchChoice, generateBranches,
          isOpening, options:{directive}, onEvent, signal })
createSessionWithSettings({ title, settings, worldId, anchorId })   // 用锚点快照初始化账本
forkSession({ sessionId, toTurn, note })                            // 回滚 = 开新分支
getSessionSnapshot(sessionId) / getMemoryStats(sessionId)
recallSession({ sessionId, question }) / auditSession({ sessionId })
```

### SSE 事件协议

```
{type:'turn_start', turn_no, is_opening, branch}
{type:'context', turn_no, budget, meta, scene_sheet}
{type:'reasoning', delta} / {type:'narrative', delta}
{type:'narrative_done', content, token_count, finish_reason, usage}
{type:'narrative_reset', reason}
{type:'memory', stats} / {type:'state', state, turn_no}
{type:'scene', scene}                    // 切场归档
{type:'world_tick', events}              // 幕后推演
{type:'continuity', report}              // 校勘
{type:'branches', branches, scene_summary}
{type:'done', turn_no, branch, usage, session_usage, memory}
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
POST   /api/worlds                        body:{id?, title?, card, source?}
PATCH  /api/worlds/:id
DELETE /api/worlds/:id
POST   /api/worlds/:id/codex/:codexId/pin body:{pinned}
POST   /api/worlds/:id/sessions           body:{anchor_id?}

GET    /api/sessions?world_id=
POST   /api/sessions                      body:{world_id?, anchor_id?}
GET    /api/sessions/:id                  -> {session, world, turns, state, usage, memoryStats}
PATCH  /api/sessions/:id                  body:{scene_directive?}
DELETE /api/sessions/:id
GET    /api/sessions/:id/turns            ?from=&to=&limit=
GET    /api/sessions/:id/search           ?q=
POST   /api/sessions/:id/turn             -> SSE  body:{playerText, images, branchChoice, directive, isOpening}
POST   /api/sessions/:id/opening          -> SSE
POST   /api/sessions/:id/branches         -> {branches, scene_summary}
POST   /api/sessions/:id/rewrite          -> SSE（自动开新分支）
POST   /api/sessions/:id/rollback         body:{turn_no}   -> 新分支
GET    /api/sessions/:id/branches

GET    /api/sessions/:id/memory           -> 完整统计
GET    /api/sessions/:id/assertions       ?subject=
POST   /api/sessions/:id/assertions       body:{subject, predicate, object, visibility?}
DELETE /api/sessions/:id/assertions/:id
GET    /api/sessions/:id/states
PUT    /api/sessions/:id/state            body:{state, turn_no?}
GET    /api/sessions/:id/scenes
GET    /api/sessions/:id/threads
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
