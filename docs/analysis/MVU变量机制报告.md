# SillyTavern MVU 变量机制报告

> 编写日期：2026-10-23（2026-10-25 冻结为历史记录，只作机制参考，非现行约束）
> 工作目录：`D:\SillyTavern\public\scripts\extensions\third-party`
> 证据来源分两类，正文中用标签标明：
> **【本地实证】** —— 本机仓库/角色卡/聊天记录里直接读到的源码或数据；
> **【TW 技能】** —— TavernWeave 技能库（`~\.agents\skills\TavernWeave`）中的指南结论；
> **【未验证】** —— 需要联网或在真实宿主里跑一遍才能确认的说法。

---

## 0. 摘要

MVU（MagVarUpdate）不是 SillyTavern 的内置功能，而是一个**跑在角色卡里的结构化状态框架**。它要解决的问题很具体：模型没有记忆，"它说它记得"不等于"状态真的被存下来了"。MVU 的做法是让模型在每轮回复末尾输出一段带 JSONPatch 的变量更新块，由框架解析、校验、回写，再把结果喂给下一轮和前端状态栏。

一次完整的 MVU 回合由三层协作完成：**世界书条目**教模型输出什么格式，**卡片脚本里的 bundle** 真正解析并打补丁，**Zod schema** 拦掉非法结构。三者缺一层，状态就会漂移。

本机能直接读到的完整实证样本是角色卡 `WuWa Solaris-3 MVU Edition`（chara_card_v2 + ccv3，563 条世界书条目，8 个 Tavern Helper 脚本），它的世界书里有 `[mvu_update]` 系列规则条目，脚本里有一条 `import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'`，聊天记录里能翻到模型真实吐出的 `<UpdateVariable>` 块。

---

## 1. MVU 变量是什么

### 1.1 定位

MVU 的全称是 MagVarUpdate，一份 MIT 许可的开源扩展，上游仓库是 `MagicalAstrogy/MagVarUpdate`。【TW 技能】它给角色卡提供：

- 一套**结构化的持久变量表**（不是散落的字符串宏）；
- 一套**更新协议**——模型输出 JSONPatch，框架应用；
- 一套**生命周期事件**，让前端知道"变量变了，该刷新了"。

【本地实证】本机这张卡的加载方式很典型：在 ccv3 的 `extensions.tavern_helper.scripts` 里有一条名为 `MVU` 的脚本，内容只有一行——

```js
import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';
```

也就是说 **MVU 本体不是装在 SillyTavern 里的扩展，而是角色卡通过 CDN 远程拉进来的一段运行时代码**。它依赖 Tavern Helper（或 JS-Slash-Runner）来执行卡片脚本。【TW 技能】

### 1.2 它和 ST 原生变量不是一回事

这点最容易混。SillyTavern 原生有 `{{getvar}}` / `{{setvar}}` 三层变量（global / chat / message），也有 Tavern Helper 的 `getVariables({type: ...})`。MVU 的 `stat_data` 是**另一套存储**，只是物理上寄存在 message 作用域的 `variables` 字段里。【TW 技能】

【本地实证】在 JS-Slash-Runner 的 `src/function/variables.ts` 里，`type: 'message'` 的读法就是：

```ts
return chat_message?.variables?.[chat_message?.swipe_id ?? 0] ?? {};
```

MVU 的 `stat_data` 就住在这个对象里。**混写两套存储是常见的 bug 来源。**

---

## 2. 用来干什么

### 2.1 核心动机：状态不能靠"口头记住"

模型每轮都是无状态的。让卡"记得"主角现在几点、在哪、背包里有什么，靠提示词反复贴状态文本是可行的，但谁来维护这段文本？如果让模型自由散文式地维护，格式会迅速退化，前后轮对不上，也没法被前端安全读取。

MVU 的分工是把"决策"和"记账"分开：

| 角色 | 承担者 | 职责 |
|---|---|---|
| 语义判断 | 模型 | 判断这轮发生了什么，该改哪个字段 |
| 结构化记账 | 框架 | 解析补丁、校验类型、落盘 |
| 派生计算 | 卡片脚本 | 确定性公式、批量同步、只读视图 |
| 展示 | 状态栏/HUD | 读 `stat_data`，画 DOM |

【TW 技能】有一句话概括得比较准：**"稳定卡的状态不靠模型『口头记住』，靠 MVU 三层。"**

### 2.2 典型用途

从本机这张卡的实际字段看，MVU 承载的是一整套玩法状态：

- **时间与地点**：`当前时间`（严格格式 `第N年 M月D日 周X HH:MM`）、`所在地点`（四级层级 `国家/地区-大地点-小地点-具体位置`）
- **剧情进度机**：`已完成的上一个事件`、`当前演绎事件节点`、`即将进行的下一个事件节点`、`章节终止条件`
- **定时器与暗线**：`剧情触发器` 数组，带倒计时和状态流转
- **伏笔管理**：`伏笔` 数组，带上限 10 条、回收、蝴蝶效应检测
- **角色档案**：`女性角色` 记录表，好感度、当前穿着、内心想法、性爱日志
- **物品栏**：动态 key 的 record，增删改
- **指令通道**：`指令` 对象，模型通过它向脚本发请求（如"请求跳转剧情版本"）

这些字段没有一个是纯展示用的——它们都会被下一轮的 prompt 读走，形成闭环。

---

## 3. 三层闭环架构

【TW 技能】MVU 的完整闭环由三层构成，缺一不可：

| 层 | 载体 | 职责 |
|---|---|---|
| 规则进 prompt | 世界书条目（名字带 `[mvu_update]`） | 告诉模型该输出什么块、什么格式、什么约束 |
| bundle | 卡片脚本 import 的 `bundle.js` | 解析 `<UpdateVariable>`，应用 JSONPatch，发事件 |
| schema | 卡片脚本里的 Zod 定义 | 结构约束；非法结构被拦下 |

### 3.1 第一层：世界书规则条目

【本地实证】本机卡片的 563 条世界书条目里，MVU 相关的有 7 条，全部是 `position: after_char`、`constant: true`（常驻注入）、`insertion_order: 1001`：

| 条目名 | 状态 | 作用 |
|---|---|---|
| `[mvu_update]变量更新规则[默认]` | 启用 | 7390 字符，逐字段的更新规则 |
| `[mvu_update]变量更新规则[精简]` | 禁用 | 3516 字符，省 token 版 |
| `[mvu_update]变量输出格式[默认]` | 启用 | 12997 字符，输出格式模板 |
| `[mvu_update]变量输出格式[精简]` | 禁用 | 7380 字符 |
| `[mvu_update]变量格式强调` | 启用 | 一句话强调"必须在回复末尾且不能省略" |
| `[mvu_update]变量禁词表` | 启用 | 变量更新时禁用的词表（防八股） |
| `[mvu_plot]变量格式防呆` | 启用 | 声明"改变量不是你的职责，除非用户要求" |

`[默认]` 和 `[精简]` 是**互斥的一对**，用世界书启用状态切换——本机当前启用的是"默认"档。

【本地实证】卡片脚本 `世界书控制.js` 里有个 `executeMvuModeSwitch()` 实现这个切换，判定函数很简单：

```js
function getMvuModeType(entryName) {
  if (/\[\s*默认\s*\]/.test(entryName)) return "default";
  if (/\[\s*精简\s*\]/.test(entryName)) return "minimal";
  return "none";
}
```

它按名字标记批量开关条目，无标记条目不动。另外还有个 6 秒一次的心跳在对比"状态栏设置里的 minimalMode"和"世界书实际启用状态"，不一致就全量切一遍——因为**用户可能从两个入口改同一个开关**。

### 3.2 第二层：bundle

【本地实证】`import '.../MagVarUpdate/artifact/bundle.js'`。它负责：

- 在回复里找 `<UpdateVariable>...</UpdateVariable>` 块；
- 取出 `<JSONPatch>` 数组；
- 按 op 应用到当前 `stat_data`；
-  Zod 校验；
- 触发 `Mvu.events.VARIABLE_UPDATE_ENDED`。

【TW 技能】bundle 的加载有时序要求：**先等世界书 Ready，再 import**。有些卡用 Ready 信号，生产卡会加轮询降级。

### 3.3 第三层：Zod schema

【本地实证】本机卡片脚本 `变量结构.js`（49160 字符）开头：

```js
import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';
```

末尾：

```js
$(() => {
    registerMvuSchema(Schema);
    console.log("【核心变量结构】已注册。");
});
```

它定义了完整的变量蓝图。用的手法值得注意：

```js
const smartBoolean = z.preprocess((val) => {
    if (typeof val === 'string') {
        const lower = val.toLowerCase().trim();
        return lower === 'true' || lower === 'yes' || lower === '1';
    }
    if (typeof val === 'number') return val === 1;
    return val;
}, z.boolean());
```

——因为模型会把布尔值写成 `"true"` 字符串、`1` 数字，`preprocess` 先把它们规整成布尔。

```js
_对主角的态度: z.string().readonly().describe('由逻辑控制器根据好感度自动计算，AI不可修改').prefault('')
```

——`.readonly()` 标记只读字段，`.describe()` 写给人看的说明，`.prefault()` 给缺省值。

【TW 技能】schema 是**结构约束**，不是玩法结算。它保证字段类型对、缺省值补上，但不保证业务规则被遵守（比如好感度该不该涨，schema 不管）。

---

## 4. 数据存在哪

### 4.1 存储结构

【本地实证】从本机聊天记录 `WuWa Solaris-3 MVU Edition - 2026-10-08@11h56m25s704ms.jsonl` 直接读到：

每条消息的 `variables` 是**按 swipe 索引的数组**，`variables_initialized` 同步记录每个 swipe 是否初始化过：

```
msg 10:
  swipe_id: 0
  variables: [ { initialized_lorebooks, stat_data, schema } ]
  variables_initialized: [ true ]
```

`stat_data` 顶层的 25 个键（实测）：

```
当前时间, 所在地点, _storyState, 章节终止条件,
已完成的上一个事件, 已完成的上一个事件节点,
当前演绎事件, 当前演绎事件节点, 即将进行的下一个事件节点,
当前长期目标, 主角信息, NPC漂泊者, 女性角色,
_现场女性角色显示, _精简模式女性角色显示, _精简模式主角信息显示,
_已知角色名单, 剧情触发器, 伏笔, 指令,
剧情显示, 剧情权重, 是否为后日谈, 插图系统, _伏笔显示
```

另外两个键：

- `initialized_lorebooks`：记录哪些世界书已完成初始化（本机是 `{"Eldoria":[],"WuWa World Info MVU":[]}`）；
- `schema`：本机这张卡里是字符串 `"没有用别管这个"`（卡作者的玩笑值，实际不承载 schema）。

### 4.2 只读字段约定

**字段名以 `_` 开头就是只读。** 本机卡片的输出格式规则里写得很死：

```
READ-ONLY PROTECTION: Do not update field names starting with `_` (e.g., `_变量`), as they are readonly.
```

这些 `_` 字段是脚本算出来给模型和前端看的派生视图：

- `_已知角色名单`：女性角色的唯一性索引，模型新增角色前先查它，防止同名不同 key；
- `_伏笔显示`：把 `伏笔` 数组转成数字键视图，规则里明确说"键 0,1,2 就是数组下标，JSONPatch 路径直接抄"；
- `_现场女性角色显示` / `_精简模式女性角色显示` / `_精简模式主角信息显示`：给状态栏用的投影。

### 4.3 stat_data / display_data / delta_data

【TW 技能】分工是：

- `stat_data`：给下一轮模型和 HUD 读的**权威状态**；
- `display_data`：只给前端，不参与下一轮 prompt；
- `delta_data`：增量数据。

【本地实证】本机这张卡的 `variables` 对象里**只有 `stat_data`**，没有 `display_data` / `delta_data` 键——它的前端投影走的是 `stat_data` 内部的 `_` 前缀字段，而不是独立的 `display_data`。

不过 `display_data` / `delta_data` 这个命名在第三方代码里确实存在。`LittleWhiteBox/modules/ena-planner/ena-planner.js` 里就这样显式跳过它们：

```js
// Skip MVU internal metadata keys
if (key === 'schema' || key === 'display_data' || key === 'delta_data') continue;
```

**结论：这三个名字是 MVU 生态的通用约定，但具体卡片用不用、怎么分，得看那张卡自己的约定，不能假定。**

---

## 5. 一次回合的完整链路

把本地实证拼起来，一轮对话里 MVU 部分发生的事按顺序是：

```
① 世界书扫描
   [mvu_update] 系列条目（constant + after_char）被注入 prompt
        ↓
② 模型生成
   正文 + <UpdateVariable><Analysis>…</Analysis><JSONPatch>[…]</JSONPatch></UpdateVariable>
        ↓
③ 正则分流（卡片 regex_scripts，placement=[1,2] 即用户/AI 输出都跑）
   [不发送]去除变量更新  promptOnly=true  → 从发给模型的 prompt 里删掉整块
   [美化]变量更新中/完整变量更新  markdownOnly=true → 换成可折叠的 HTML 展示框
        ↓
④ bundle 解析
   找到 <UpdateVariable>，取出 <JSONPatch>，按 op 应用
        ↓
⑤ Zod 校验
   不合结构的字段被拦/补默认值
        ↓
⑥ 回写
   写进该条消息 swipe 对应的 variables[swipe_id].stat_data
        ↓
⑦ 发事件
   Mvu.events.VARIABLE_UPDATE_ENDED(vars, oldVars)
        ↓
⑧ 消费者刷新
   状态栏（<StatusPlaceHolderImpl/> 替换出的 HTML）debounce 100ms 后重画
   卡片脚本监听同一事件做业务校验和派生计算
        ↓
⑨ 下一轮
   stat_data 被重新注入 prompt，闭环
```

### 5.1 第 ③ 步的三条正则

【本地实证】本机卡片 22 条 regex_scripts 里，跟 MVU 直接相关的四条：

| 脚本名 | placement | markdownOnly | promptOnly | findRegex |
|---|---|---|---|---|
| `[不发送]去除变量更新` | [1,2] | false | **true** | `/<(update(?:variable)?)>(?:(?!.*<\/\1>)(?:(?!<\1>).)*$\|(?:(?!<\1>).)*<\/\1?>)/gsi` |
| `[美化]变量更新中` | [1,2] | **true** | false | `/<(update(?:variable)?)>(?!.*<\/\1>)\s*((?:(?!<\1>).)*)\s*$/gsi` |
| `[美化]完整变量更新` | [1,2] | **true** | false | `/<(update(?:variable)?)>\s*((?:(?!<\1>).)*)\s*<\/\1>/gsi` |
| `[状态栏]MVU浪潮状态栏` | [2] | **true** | false | `<StatusPlaceHolderImpl\/>` |

要点：

- `markdownOnly` / `promptOnly` 这两个开关决定了**同一条文本在"给模型看"和"给用户看"两条路上被区别对待**。`[不发送]去除变量更新` 只作用于 prompt，所以模型永远看不到自己过去吐的 `<UpdateVariable>` 块；`[美化]` 系列只作用于展示，把机器块换成折叠框。
- `[美化]变量更新中` 处理的是**流式输出中途**的未闭合块（正则尾部 `\s*$` 配 `s` 标志），`[美化]完整变量更新` 处理闭合的完整块。两条配合覆盖生成中和生成完两个时机。
- `<StatusPlaceHolderImpl/>` 是 MVU 生态约定的**状态栏占位符**，卡片用一条正则把它替换成完整的 HTML 页面（本机这张卡的替换体有 180757 字符）。

### 5.2 模型真正吐出来的块

【本地实证】从聊天记录里摘一段真实的（第 10 楼，AI 回复末尾）：

```text
<UpdateVariable>
<Analysis>
1. Initialization Check: /当前时间 is contextual, variables populated. No cold start needed.
2. Time & Event Summary: +10 minutes elapsed; date advances to 15:05. Party moved deeper into the Tacet Field. No item changes. Affection remains stable as the scene is combat-focused.
3. Core Logic & Story State: The barrier and Crownless awakening bullet point is now being performed. The next bullet point will cover joint defeat and the failed terminal absorption.
4. Timers & Plot Devices: Removed old "无冠者苏醒" trigger. Added active暗线 for ongoing combat. No foreshadowing changes.
5. Character & Sex Logic: Female characters present; inner thoughts refreshed to reflect current battle tension. No sexual contact.
6. Value Calculation: Time string corrected, location refined, event nodes aligned to source XML bullets.
7. Sanity Check: Paths valid, no readonly fields modified, descriptions under limit.
8. Banned Words Avoidance: Used "grinding", "chilling", "raw concussion" instead of banned vocal descriptors. Avoided "not X but Y" constructions in variable text.
</Analysis>
<JSONPatch>
[
  {"op":"replace","path":"/当前时间","value":"第1年 3月15日 周一 15:05"},
  {"op":"replace","path":"/所在地点","value":"瑝珑-今州-云陵谷-无音区深处"},
  {"op":"replace","path":"/当前长期目标","value":"在新生无音区中与秧秧协力对抗无冠者，寻找屏障突破口"},
  {"op":"replace","path":"/当前演绎事件节点","value":"变故突生，一道屏障将炽霞、白芷隔在外。漂泊者与秧秧遭遇无冠者，一头具象化了战争行为本身的强大残象。"},
  {"op":"replace","path":"/即将进行的下一个事件节点","value":"漂泊者与秧秧合力击溃无冠者，残象原地留下金色虚影（残响）。炽霞让漂泊者用终端吸收，却发现终端无法回收。"},
  {"op":"remove","path":"/剧情触发器/0"},
  {"op":"insert","path":"/剧情触发器/-","value":{"事件类别":"暗线","事件简述":"无冠者暴起伤人，与漂泊者激烈交战","事件计时":"剩15分钟","状态":"进行中"}},
  {"op":"replace","path":"/女性角色/秧秧/额外信息/内心想法","value":"风全被锁在这壳子里头了，我得把它引开。"},
  {"op":"replace","path":"/女性角色/炽霞/额外信息/内心想法","value":"外头干着急，这屏障滑得抓不住缝。"},
  {"op":"replace","path":"/女性角色/白芷/额外信息/内心想法","value":"忧昙被弹回来了，只能等他们自己寻到路。"}
]
</JSONPatch>
</UpdateVariable>
```

注意 `<Analysis>` 的位置和内容：**它在块内、在 JSONPatch 之前**，逐条列这轮的判断依据。规则里对它有硬性要求，第 8 条甚至专门留了一段给"怎么绕开禁词表"。

【本地实证】对整份聊天记录统计实际出现的 op：`replace` 38 次、`add` 9 次、`remove` 3 次、`insert` 1 次。**没有出现 `delta` 和 `move`。**

---

## 6. JSONPatch 方言

### 6.1 规则怎么写

【本地实证】本机卡片 `[mvu_update]变量输出格式[默认]` 条目里的格式约束（原文是英文 YAML，节选）：

```yaml
variable_update_format:
  rule:
    - You must output the update analysis and the actual update commands at the end of the reply.
    - The update commands must be a valid JSON Patch array (RFC 6902).
    - FORMAT CONSTRAINTS:
      - `op` must be one of:
        - "replace": replace value of existing paths.
        - "add" or "insert": insert new items into object or array (use `-` as array index to append to end).
        - "remove": remove an item.
        - "move": move values from one path to another.
        - "delta": update existing number paths by a delta value (custom op).
      - `path` FORMATTING & ESCAPING (CRITICAL):
        - MUST be a valid JSON pointer string starting with `/` (e.g., "/主角信息/当前状态").
      - Do not output markdown code blocks (like ```json) inside the <JSONPatch> tag.
    - SAFETY CHECK:
      - Only update variables that explicitly exist in the Variable List provided above.
      - Do not invent new variables unless allowed by the rules (e.g., new items in inventory).
      - READ-ONLY PROTECTION: Do not update field names starting with `_`, as they are readonly.
```

### 6.2 关键点

- **`path` 是 JSON Pointer**，必须以 `/` 开头。中文键名直接用，不需要转义（`/女性角色/秧秧/好感度`）。
- **`add` 和 `insert` 在这套方言里是同义词**，都指向"往对象或数组里插"。
- **数组追加写 `/-`**，不写数字下标。规则里反复强调：`新增：用 add，path 固定写 "/伏笔/-"（追加到数组末尾），不要指定数字键`。
- **`delta` 是自定义 op**，不是 RFC 6902 的标准 op，用来做数值增量。本机这份聊天记录里没用过。
- **不要 markdown 代码块**：`<JSONPatch>` 里直接写裸 JSON 数组。

### 6.3 数组操作的坑

这是 MVU 卡片规则里写得最细的部分，因为**数组下标会前移**。本机卡片的伏笔规则原文：

```
- 删除：用 remove，path 直接写 "/伏笔/<数字键>"；同一轮删多条时，必须从编号大的往小删，防止下标前移错位
```

同理，`剧情触发器` 的删除也是按索引。多个 remove 如果不倒序写，删掉 `/剧情触发器/0` 之后，原来的 `/剧情触发器/1` 就变成了 0，第二个 remove 就删错了。

【本地实证】真实聊天里能看到正确的倒序写法：

```json
{ "op": "remove", "path": "/剧情触发器/1" },
{ "op": "remove", "path": "/剧情触发器/0" }
```

### 6.4 初始化（冷启动）

规则里有一段专门的冷启动判定：

```
INITIALIZATION & COLD START:
  - Trigger:
    1. If multiple key variables are "无", "未知", "等待AI观测..." or "等待设定..." etc.
    2. OR if `/当前时间` is at default without context justification.
  - Action:
    1. Time Fix: Use "replace" op to update `/当前时间` to a contextual string. Do NOT use "1月1日".
    2. Deep Scan: Perform a full scan of the Opening Message and User's Reply to populate ALL missing fields.
    3. Identity Anchor: If /主角信息/身份与额外设定 is empty or blank, fill it with a concise identity summary based on the User's Persona.
```

**第一轮是关键**：如果第一轮没把状态填实，后面所有轮都建立在空状态上。

---

## 7. 世界书条目路由：`[mvu_update]` vs `[mvu_plot]`

【TW 技能】MVU 生态有个约定：**条目名字里带 `[mvu_plot]` 或 `[mvu_update]` 标记，决定这条目进哪个模型的上下文**。

| 条目名包含 | 同代生成时 | 额外更新模型那一趟 |
|---|---|---|
| `[mvu_plot]` | 正常激活条目 | 只进 plot 模型 |
| `[mvu_update]` | 正常激活条目 | 只进 update 模型 |
| 两者都没有 | 正常激活条目 | 两个模型都进 |

也就是说，MVU 卡常常是**两次生成**：一次正常写剧情（plot 模型），一次专门算变量（update 模型）。条目名里的标记决定材料分流。

几个注意点：

- 标记可以出现在条目名的**任意位置**，不要求是前缀；
- **标记不等于激活**。启用状态、关键词匹配、扫描/递归策略、budget、position、order 是另一套独立检查；
- 名字里同时有两个标记的条目，除非具体 MVU 实现明确定义了，否则当歧义处理。

【本地实证】本机这张卡两种标记都用到了：

- `[mvu_update]变量更新规则[默认]` / `[mvu_update]变量输出格式[默认]` / `[mvu_update]变量格式强调` / `[mvu_update]变量禁词表` —— 变量相关的只进 update 模型；
- `[mvu_plot]变量格式防呆` / `[mvu_plot]CG插图` / `[mvu_plot]角色扮演注意事项` 等 —— 剧情相关的只进 plot 模型。

`[mvu_plot]变量格式防呆` 那条内容挺有意思，它反而在**劝退**模型：

```
rule: Modifying variables is not your responsibility; it is handled by other LLMs.
**DO NOT** modify or output variables in any way without the user's request,
unless the user explicitly instructs you to do so.
```

---

## 8. 编程接口

### 8.1 Mvu 全局对象

【本地实证】从卡片脚本 `剧情逻辑.js` 和状态栏脚本里读到的实际用法：

```js
// 等待框架就绪（必须在任何 Mvu.* 调用之前）
await waitGlobalInitialized('Mvu');

// 读当前楼层的 MVU 数据
const mvuData = await Mvu.getMvuData({ type: 'message', message_id: -1 });
const stat = mvuData.stat_data;

// 改完整体回写
mvuData.stat_data = processedData;
await Mvu.replaceMvuData(mvuData, { type: 'message', message_id: -1 });

// 订阅刷新事件
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async (vars, oldVars) => { ... });
```

`message_id: -1` 是**负索引**，指最后一楼。JS-Slash-Runner 的 `variables.ts` 印证了这个语义：

```ts
const normalized_message_id =
  option.message_id === undefined || option.message_id === 'latest' ? -1 : option.message_id;
```

`'latest'` 和 `-1` 等价。

### 8.2 事件常量的拼写陷阱

【TW 技能】这是最阴的一个坑：

> MVU 源码把初始化事件拼成 `'mag_variable_initiailized'`（`initiailized`，双 i）。这是库的已知拼写。**必须写 `Mvu.events.VARIABLE_INITIALIZED`，禁止手写字符串。** 手写正确英文会订阅到一个不存在的事件，HUD 永远不刷新。

刷新主挂点是 `Mvu.events.VARIABLE_UPDATE_ENDED`。

【本地实证】本机卡片两处都遵守了这个约定，全部走 `Mvu.events.VARIABLE_UPDATE_ENDED`，没有一处手写字符串。

⚠️ **这条的"双 i"说法我无法在本地证实**——bundle.js 是远程加载的，本机没有副本，也没有网络。但它作为工程建议依然成立：**永远用 `Mvu.events.*` 常量，不要手抄字符串**，这样上游改了拼写你也跟着对。

### 8.3 Tavern Helper 的变量 API

【本地实证】JS-Slash-Runner `src/function/variables.ts` 里的完整作用域：

```ts
type VariableOptionNormal = { type: 'chat' | 'character' | 'preset' | 'global' };
type VariableOptionMessage = { type: 'message'; message_id?: number | 'latest' };
type VariableOptionScript  = { type: 'script'; script_id?: string };
type VariableOptionExtension = { type: 'extension'; extension_id: string };
```

| type | 物理位置 |
|---|---|
| `message` | `chat_message.variables[swipe_id]` |
| `chat` | `chat_metadata.variables` |
| `character` | 角色设置 store 的 `variables` |
| `preset` | 预设设置 store 的 `variables` |
| `global` | `extension_settings.variables.global` |
| `script` | 脚本 iframe runtime 的 `data` |
| `extension` | `extension_settings[extension_id]` |

配套函数：

- `getVariables(option)` —— 读，返回**深拷贝**（klona）
- `get_variables_without_clone(option)` —— 读，不拷贝，性能敏感时用
- `replaceVariables(variables, option)` —— 整体替换
- `updateVariablesWith(updater, option)` ——  updater 函数式更新
- `registerVariableSchema(schema, {type})` —— 注册 schema

还有 `_getAllVariables()` 做合并视图，注意它在 message iframe 里的行为不同——会把当前楼层及之前所有楼层的 message 变量依次 assign 进来，**后写的楼层覆盖先写的**。

【TW 技能】优先用 updater 函数，少用整体替换——整体替换会擦掉别的脚本拥有的字段。

### 8.4 iframe 里的可见性

【本地实证】`JS-Slash-Runner/src/iframe/predefine.js` 里有专门的 MVU 桥接：

```js
// 其实应该用 waitGlobalInitialized 来等待 Mvu 初始化完毕, 这里设置 window.Mvu 只是为了兼容性
if (_.has(window.parent, 'Mvu')) {
  Object.defineProperty(window, 'Mvu', {
    get: () => _.get(window.parent, 'Mvu'),
    // Mvu 脚本自己还会 `_.set()` 自己的变量, 所以这里设置一个空 set
    set: () => {},
    configurable: true,
  });
}
```

两个细节：`set` 是空函数，防止 iframe 内的脚本误以为能通过赋值改 Mvu；注释明说"其实应该用 `waitGlobalInitialized`"。

【TW 技能】**顶层窗口能用不代表 iframe 里能用。** message iframe、script iframe、prompt template、STScript 管线是四个不同的执行上下文，各自要单独验。

---

## 9. 状态栏 / HUD

【本地实证】状态栏的载体是 `<StatusPlaceHolderImpl/>` 占位符 + 一条正则替换。替换体是一整份 HTML（本机这张卡 180757 字符），里面这样起：

```js
async function init() {
    if (window.waitGlobalInitialized) await waitGlobalInitialized('Mvu');
    // ...立绘缓存、设置恢复、昼夜模式...
    render();  // 首次渲染

    // 监听 MVU 变量更新：加入防抖功能并读取事件参数中的最新数据
    if (window.eventOn && window.Mvu) {
        eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, (vars) => {
            if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
            // 等待 100 毫秒后再渲染，将 MVU 底层传出的最新变量传给 render
            renderDebounceTimer = setTimeout(() => {
                render(vars && vars.stat_data ? vars.stat_data : null);
            }, 100);
        });
    }
}
```

读数据的路径也是 `Mvu.getMvuData({type:'message', message_id:-1})`（在这份替换体里出现了几十次）。

【TW 技能】状态栏的典型四层是：**正则把状态栏 HTML 变成 iframe → iframe 里读变量 → 画 DOM → 听事件刷新**。

### 9.1 为什么用 iframe

因为状态栏 HTML 是塞进消息里的，如果不用 iframe 隔离，它的 CSS 和 JS 会污染整个 SillyTavern 页面。正则替换出的内容包一层 `<iframe>`，里面自带 `<style>` 和 `<script>`，跟宿主 DOM 完全隔离。

### 9.2 防抖

100ms debounce 不是随便选的。MVU 事件可能在流式输出过程中多次触发，不防抖会疯狂重画。

---

## 10. 第三方插件怎么接 MVU

### 10.1 LittleWhiteBox（ena-planner）

【本地实证】`LittleWhiteBox/modules/ena-planner/ena-planner.js` 是个比较规范的消费者：

```js
function getLatestMessageVarTable() {
    try {
        if (window.Mvu?.getMvuData) {
            return window.Mvu.getMvuData({ type: 'message', message_id: 'latest' });
        }
    } catch { }
    try {
        const getVars = window.TavernHelper?.getVariables || window.Mvu?.getMvuData;
        if (typeof getVars === 'function') {
            return getVars({ type: 'message', message_id: 'latest' });
        }
    } catch { }
    return {};
}
```

三级降级：MVU → TavernHelper → 空对象。而且**每一层都包 try/catch**，因为任何一层不在都不会报错到用户脸上。

它的合并策略也值得抄：

```js
// 2) Always merge message-level variables (some presets store vars here instead of chat-level)
const msgVars = getLatestMessageVarTable();
if (msgVars && typeof msgVars === 'object') {
    for (const key of Object.keys(msgVars)) {
        if (key === 'schema' || key === 'display_data' || key === 'delta_data') continue;
        if (vars[key] === undefined) {
            vars[key] = msgVars[key];          // chat 级没有这个键 → 从 message 级取
        } else if (/* 两边都是对象 */) {
            // 浅合并，message 级补空缺
        }
    }
}
```

——先读 chat 级，再补 message 级，同时显式跳过 MVU 的内部元数据键。

同一个文件还有 `{{get_message_variable::path}}` 和 `{{format_message_variable::path}}` 两个自定义宏，前者深取值，后者把对象转 YAML——这是让模板能读 MVU 变量的常见手法。

另外它有个世界书排除名单：

```js
worldbookExcludeNames: ['mvu_update'],
```

——做剧情规划时不想把 MVU 的变量更新规则喂进去，所以按条目名排除。

### 10.2 hide 扩展

【本地实证】`hide/index.js:4074` 有一段跟 MVU 直接相关的坑：

```js
// 关键：还要复制"上一条消息的变量"。ST-Prompt-Template 会把每条消息的变量存在
// variables/variables_initialized（按 swipe 索引的数组）里，EJS 的 getvar 等据此渲染；
// 真实发送时 ST-PT 会 clonePreviousMessage 为这条新消息复制变量。若我们注入的消息不带变量，
// EJS（MVU 类世界书）会以"空变量"渲染，导致统计偏低、与真实发送不一致。
if (trimmed) {
    let prevVars = {};
    for (let i = chatArr.length - 1; i >= 0; i--) {
        const v = chatArr[i]?.variables?.[chatArr[i]?.swipe_id ?? 0];
        if (v != null) { prevVars = JSON.parse(JSON.stringify(v)); break; }
    }
    const injectedMessage = {
        // ...
        variables: [prevVars],
        variables_initialized: [true],
        // ...
    };
}
```

**任何要在内存里伪造消息楼来做"模拟发送/预演"的插件，都必须带上一条变量，否则 MVU 类的 EJS 世界书会以空变量渲染。** CHANGELOG 里记着实测数据：修复前"输入内容"比"留空"少约 3400 tokens。

### 10.3 JS-Slash-Runner

就是上面 8.3、8.4 讲的那套。它同时是 **MVU 的宿主**（提供 `waitGlobalInitialized`、`eventOn`、iframe 桥）和 **MVU 的消费者**（`getVariables({type:'message'})`）。

---

## 11. 常见陷阱汇总

1. **手写事件字符串**。必须用 `Mvu.events.VARIABLE_UPDATE_ENDED`。上游有已知拼写问题，手抄必炸。
2. **不 `await waitGlobalInitialized('Mvu')`**。bundle 是异步 import 的，DOM ready 不等于 Mvu ready。
3. **混用 ST 原生变量和 MVU `stat_data`**。两套存储，`{{getvar}}` 读不到 `stat_data`。
4. **数组多删不倒序**。`/伏笔/0` 和 `/伏笔/2` 同轮删，必须先删 2。
5. **数组追加写数字键**。追加一律 `/-`。
6. **改 `_` 前缀字段**。只读，schema 标了 `.readonly()`，规则也明令禁止。
7. **伪造消息楼不带变量**。见 10.2，EJS 会空变量渲染。
8. **整体 replace 变量对象**。擦掉别的脚本的字段，用 updater。
9. **顶层 console 能跑就以为 iframe 里能跑**。四个上下文各自验。
10. **把"模型说要改"当成"已经改了"**。补丁是提议，回写和事件才是证据。
11. **第一轮冷启动没做**。`/当前时间` 停在默认值会污染后面所有轮。
12. **`[默认]`/`[精简]` 两档条目同时启用或同时禁用**。互斥对，用启用状态切。

---

## 12. 边界与未验证项

- **bundle.js 内部未验证**。本机无网络，`bundle.js`、`mvu_zod.js` 都只见到 import 语句，没读到实现。本文所有关于 op 集合、事件名、`stat_data` 结构的描述，来源是**卡片规则文本 + 实际聊天数据 + TavernWeave 技能**，不是 bundle 源码。
- **`delta` / `move` 未在本机观测到使用**。规则文本里列了，聊天记录里没用。
- **`display_data` / `delta_data` 未在本机卡片出现**。只有 LittleWhiteBox 的跳过逻辑证明这两个名字在生态里存在。
- **MVU 版本无法确定**。本机卡片的 import 没有 pin 到具体 commit，CDN 上 `artifact/bundle.js` 是滚动构建。【TW 技能】上游明确指出"package version 不是可靠的 extension-release 标识"。
- **运行时行为未实测**。新建聊天、编辑、swipe 切换、重载、持久化这些场景，静态读代码证明不了。要真机矩阵。
- 本机这张 `WuWa Solaris-3 MVU Edition` 卡除了 MVU 相关脚本，还带着 6 个非 MVU 的业务脚本（剧情数据库、剧情逻辑、世界书控制、飞讯、CG 图鉴、开场白跳转），本文只取了其中与 MVU 机制相关的部分。

---

## 13. 参考

**本地实证材料**

| 路径 | 内容 |
|---|---|
| `data/default-user/characters/WuWa Solaris-3 MVU Edition.png` | 完整 MVU 卡（chara_card_v2 + ccv3，563 条世界书，8 个 TH 脚本，22 条正则） |
| `data/default-user/chats/WuWa Solaris-3 MVU Edition/*.jsonl` | 11 楼真实聊天，含实际 `<UpdateVariable>` 块和变量表 |
| `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/variables.ts` | 变量作用域与 `getVariables`/`replaceVariables`/`updateVariablesWith`/`registerVariableSchema` 实现 |
| `public/scripts/extensions/third-party/JS-Slash-Runner/src/iframe/predefine.js` | iframe 内的 Mvu 桥接 |
| `public/scripts/extensions/third-party/LittleWhiteBox/modules/ena-planner/ena-planner.js` | 三级降级读 MVU、变量合并、`get_message_variable` 宏 |
| `public/scripts/extensions/third-party/hide/index.js` | 模拟发送时的消息变量复制（约 4074 行） |

**TavernWeave 技能**

| 文件 | 关键结论 |
|---|---|
| `consult-tavernweave-library/references/design-wiki/MVU变量闭环.md` | 三层架构、事件拼写陷阱、HUD 读法、字段链 |
| `tavern-card-builder/references/variable-systems.md` | `[mvu_plot]`/`[mvu_update]` 路由矩阵、CoT 边界 |
| `tavern-card-builder/references/card-types-and-runtime-dependencies.md` | `text`/`mvu_zod`/`hybrid` 分类、MVU Zod 依赖分级 |
| `sillytavern-api-reference/references/core-facts.md` | MagVarUpdate 上游定位、MVU 表面路由、置信度规则 |
| `sillytavern-api-reference/SKILL.md` | 运行时验证工作流、交付合同 |
| `sillytavern-database-rolecards/SKILL.md` | in-card 数据模型、字段绑定检查、真机验收门 |
| `consult-tavernweave-library/references/sillytavern-runtime-foundations.md` | 纯文字最小回合、MVU 接入边界、swipe/重生成注意 |

**上游**

- MagVarUpdate: `github.com/MagicalAstrogy/MagVarUpdate`（MIT，公开 beta 快照）
- MVU Zod 注册辅助: `testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js`
- Tavern Helper / JS-Slash-Runner: `github.com/N0VI028/JS-Slash-Runner`（AFPL-9，上游明确声明非开源）
- ST-Prompt-Template: `github.com/zonde306/ST-Prompt-Template`（AGPL-3.0）
