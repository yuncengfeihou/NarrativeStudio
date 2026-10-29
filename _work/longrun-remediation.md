# 长跑问题的解法与 MVU 增量记账评估

> 对象：`_work/longrun-eval-8cfb7f62.md` §10 列出的 P0–P3 缺口
> 数据基线：会话 `8cfb7f62-9c16-43de-a451-ca7ccb98de96`（66 回合 / 65 拍 / 29 场，phase2 已续跑）
> 本文只给**方案与改动面**，不含实施 diff。所有判据都能用 §附录 的 SQL 复现。
>
> **状态（2026-10-29）：本文列出的方案已全部落地**（对应 D10–D13、D24、D25 等），
> 落地后的实际口径与验证结果在 `_work/longrun-scale-discussion.md`；本文保留的是「为什么这样解」的论证。

---

## 0. 两条结论先行

1. **P0 的两条不是「提示词没写清」，是「结构化判定缺一个字段/一条 op」。**
   死亡晚一拍——提示词早就写了「任何角色死亡都必须写 life_state」（`server/prompts/archivist.js:96`），t37 仍然漏了。**再加重措辞是无效的**（AGENTS §1.2 先删后加），缺的是「谁死了」这个事实在**读完整原文的那个 Agent** 手里没有结构化出口。
   数值账本——`拥有` 是 many 基数（`server/memory/predicates.js:26`），冲突失效**结构上不可能触发**（`store.js:1460` 第一行就 return）；`inventory` 按精确同名增删，而金额的「名」每次都不一样。这不是漏判，是**没有数字这个概念**。

2. **你提的 MVU 分工，本项目已经用了 90%，缺的正好是那 10%：`delta`。**
   本项目「Agent 只提案、代码才落库」= MVU「模型判断、脚本记账」；`addWorldState` 的 `op='set'` 已经实现「关闭同路径旧值」（= MVU `replace`）；`buildEffectiveWorld` 按 `valid_from` 回放（= MVU 应用 patch）；`state-paths.js` 白名单（= MVU 的 Zod schema + 只读保护）。
   **唯一缺的是数值没有一等公民地位**：`world_state` 1393 条增量里 `typeof value === 'number'` 的 **0 条**，`effective.js:190/221/232` 三处一律 `String(value ?? '')`。所以「加减」无处可做——**不是不想做，是值到落库那一步已经变成字符串了**。

---

## 1. P0-1 死亡/离场晚一拍落库

### 根因（已定位到行）

| 环节 | 位置 | 实测 |
|---|---|---|
| 判定在场只认 `life_state` | `server/memory/lint-state.js:53` `str(c.life_state) \|\| str(charState.life_state)` | 正文 t37 已写死，`life_state` 到 t38 才是 `dead` |
| 关键词兜底打不中 | `lint-state.js:55` 检查 `c.status`/`charState.condition` | t37 记的是「掌心朝上，指节不再蜷着」，不含 `DEAD_MARKERS` 任何一词 |
| 封场晚于史官 | `orchestrator.js:343` 判切场 → `:358` closeScene | 这一拍已经渲染完，只能影响下一拍 |
| 场次 outcome 其实已写死 | `scenes` S021（t37–37）outcome=「奶奶于黎明前离世」 | **信息在场，只是没结构化** |

`present` 实测：t37 `[伍卿,黎婆,军医,西装女子]`、t38 `[伍卿,凌玥,黎婆,军医]` —— 黎婆多在场一拍。

### 方案：让 `closeScene` 的结构化输出承载「谁死了」

不新增通道、不新增注入点、不堆识别器。`scene-keeper` 是**唯一读完整本场原文的 Agent**（`memory-pipeline.js:73` `getTurnsForBranch(...)`），它的 `outcome` 已经写出了死亡语义，只是没给结构化字段。

**改动 1：`server/prompts/archivist.js` 的 `sceneKeeperSystemPrompt()`（约 :178）加一个受控字段**

```jsonc
{
  "question": "...", "outcome": "...", "key_detail": "...", "causal": "...",
  "threads": [], "hooks": [],
  "life_changes": [{"who": "黎婆", "life_state": "dead"}]   // 新增，可空数组
}
```

字段规范一句话（不加段落）：
> `life_changes`：本场里有人的生死/离场发生变化才填。`life_state` 只取 `alive / injured / dead / gone`。没变就留空数组。

**改动 2：`server/agents/memory-pipeline.js` 的 `closeScene()`（:107-146 解析段 + :119 guard 之后）**

> 前置：`memory-pipeline.js:23-26` 目前**没有** import `LIFE_STATES`（受控词表在 `server/prompts/archivist.js:21`），
> 要加到已有的那条 import 里；`getCharStateMap / setCharState / addWorldState / addPatch` 已经都在 `:18-22` 的 import 里。

```js
// 解析（与 record 同批，slice 限长）。cast 名单在 :136 是内联的
//   cast: Object.keys(ledger.characters || {})
// 这一行要提前抽成 const castNames = new Set(Object.keys(ledger.characters || {})); 两处共用。
const lifeChanges = arr(parsed.life_changes)
  .map((x) => ({ who: str(obj(x).who), life_state: str(obj(x).life_state) }))
  .filter((x) => x.who && LIFE_STATES.includes(x.life_state))
  .filter((x) => castNames.has(x.who))        // 只认本场 cast，越界丢弃
  .slice(0, 8);
```

落库放在 `addScene()` **之后**（场次已是既成事实），且**幂等**：

```js
for (const c of lifeChanges) {
  const cur = getCharStateMap(sessionId, { branchId })[c.who]?.life_state;
  if (cur === 'dead' || cur === 'gone') continue;          // 史官已经写了 → 不重复
  setCharState(sessionId, { branchId, who: c.who, field: 'life_state', value: c.life_state, turn: turnNo });
  addWorldState(sessionId, {
    branch_id: branchId, entity_kind: 'person', entity_id: resolveId(c.who),
    path: 'life_state', op: 'set', value: c.life_state, turn: turnNo,
    source: 'scene-keeper', evidence: record.outcome,
  });
  addPatch(sessionId, {
    branch_id: branchId, agent: 'scene-keeper', kind: 'life_state_inferred',
    turn_no: turnNo, status: 'applied', severity: 'info',
    payload: { who: c.who, life_state: c.life_state, from: cur || null }, evidence: record.outcome,
  });
}
```

**为什么落在这一层而不是别处**：`life_state` 已经是 `state-paths.js` 的 `PERSON_SCALARS`（:17），`addWorldState` 的 `op='set'` 已经会关闭旧值，`lintState` 已经认这个字段，`renderAbsentLine` 已经会渲染「已故」。**改动只增加了一个「谁来写」的来源**，不改任何消费方。

**为什么不需要改提示词的时序**：t37 封场时（本拍末尾）就置 `dead`，t38 装配前生效——正好补上原来那一拍的空窗。

**风险与兜底**
- scene-keeper 误判（把重伤写成 dead）→ `life_changes` 走 `addPatch`，记忆面板可见；`dead` 之后手工编辑正文是唯一纠正途径（与现有 `life_state` 手工改正路径一致）。
- 与史官打架：史官 t37 若写了 `injured`、scene-keeper 写 `dead` → `set` 语义会关闭旧值，后者胜出。这是**期望行为**（读全本的人更可信），但要在 `copyBranchState()` 里确认 `character_states` 照旧随分支复制（已覆盖，`store.js:1236`）。

**验收判据**：拿 `8cfb7f62` 重放到 t37——`character_states` 应有 `黎婆/life_state=dead @t37`，且 t38 的 `meta.assembly.present` 不含黎婆。补 `tests/test-memory.js` 一条「closeScene 后 life_state 被交叉校正」。

---

## 2. P0-2 数值账本：这正是 MVU 提案的落点

### 根因（三条，缺一不可）

| # | 现象 | 位置 | 实测 |
|---|---|---|---|
| a | `拥有` 是 many → 冲突失效永不触发 | `predicates.js:26`；`store.js:1460` `if (!isFunctionalPredicate(predicate)) return []` | 伍卿 active `拥有` **48 条**；其中**以金额为主体**的 **16 条 / distinct 7 个**（27块2、93块4×2、88块4×9、88块4和5块钱、5块钱、83块4毛钱与5块钱、88块4钱+旧钢笔+…）；若把「包裹里有钱」类描述也算进来是 22 条 / distinct 13 个。**「八十八块四」精确重复 9 条** |
| b | many 渲染靠抽签 | `context-engine.js:478-481` 按 score 排序后 `slice(0, 10)`，无同 subject 去冲突 | t66 时 many 候选 273 条、只渲染 10 条，金额只抽到 1 条 |
| c | 数字到落库变字符串 | `effective.js:190` `target[path] = String(value ?? '')`；`:221`、`:232` 同 | `world_state` 1393 条，**数字型 0 条** |
| d | inventory 按精确同名增删 | `archivist.js:315-323` | 27 条里 5 条是钱：「卖破烂挣的七十几块」「六十六块二」「零钱（废品站结账所得）」「五块钱」「剩余的八十三块四」——去重全失效 |

报告 §10 初稿写「33 条含 8 个矛盾金额」是 phase1（45 拍）的数字；phase2 续跑后是 **48 条**。该行已在报告 §10 的表下加了复核更正注（标 ⚠️），以本表的 48 为准。

### 方案：给 `world_state` 补 `delta` op + 数值路径白名单

**不需要新表，不需要迁移**（`world_state.value_json` 是 TEXT 但存 JSON，天然能存 number）。改四处：

**① `server/world/state-paths.js`：新增数值路径集合（与标量路径不相交）**

```js
// 数值路径：只允许 set 数字 或 delta 增减。非数值路径保持字符串语义，不受影响。
const PERSON_NUMBER_PATHS = [];                       // 目前人物没有数值字段
const PLAYER_NUMBER_PATHS = ['money', 'money_due'];   // 银钱 / 欠债（后者可为负向语义，用正数+方向字段）
const FACT_NUMBER_PATHS   = ['condition_value'];      // 预留：伤势/耐久一类
export const NUMBER_PATH_SET = new Set([...PERSON_NUMBER_PATHS, ...PLAYER_NUMBER_PATHS, ...FACT_NUMBER_PATHS]);
```

**② `server/memory/store.js:912` 的 op 白名单加 `delta`；`:917-924` 只在 `op==='set'` 时关闭旧值**

```js
const OP_LIST = ['set', 'add', 'remove', 'introduce', 'delta'];
// delta 不关闭同 path 的旧值（它是增量，历史必须能回放）
```

**③ `server/world/effective.js:175 applyDelta()` 增加 delta 分支（投影时做加减 + 越界判定）**

```js
function numericOf(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// set 且在 NUMBER_PATH_SET 内 → 存 number，不做 String()
if (op === 'set' && NUMBER_PATH_SET.has(path)) { target[path] = numericOf(value) ?? 0; return; }
// delta → 读当前值再加减；结果为负或越界 → 不应用，留给校验器报
if (op === 'delta' && NUMBER_PATH_SET.has(path)) {
  const prev = numericOf(getAt(target, path)) ?? 0;
  const d = numericOf(value);
  if (d == null) return;
  const next = prev + d;
  if (next < 0) { target.__rejected = [...(target.__rejected || []), { path, prev, d }]; return; }
  setAt(target, path, Math.round(next * 100) / 100);   // 分位取整，避免浮点毛刺
  return;
}
```

关键：**越界不静默 clamp，而是记录并拒绝**——这就是你要的「脚本判断数值是否违规」。`__rejected` 在装配时被读走写成一条 patch（`kind='rejected_delta'`），不进提示词。

**④ 史官侧（`server/prompts/archivist.js` + `server/agents/archivist.js`）**

`changes` 数组的 `op` 增加 `delta`，并且**写进 `changes` 的字段规范里，与新数值路径同一份表**：

```jsonc
{"kind": "player", "id": "player", "path": "money", "op": "delta", "value": -60}   // 付药钱
{"kind": "player", "id": "player", "path": "money", "op": "delta", "value": 12.5}   // 卖废品
```

`sanitizeChange()`（`archivist.js:198`）加两条确定性校验：

```js
// delta 只对数值路径合法
if (op === 'delta' && !NUMBER_PATH_SET.has(path)) return null;
if (op === 'set' && NUMBER_PATH_SET.has(path)) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  value = n;
}
```

**成本**：一个新的受控路径 + 一个 op + 两个分支。没有新表、没有新 Agent、没有新提示词段落（只在既有 `changes` 规范里加两行示例）。

### 为什么这条能同时修 a/b/c/d

- **a**：金额不再走 `拥有` 断言，走 `player.money` 单值路径 → `many` 基数问题对它**不存在**了。这符合 AGENTS §1.2「先删后加」：**先删掉「拥有」承载金额的用法**，再加 `delta`。
- **b**：`player.money` 是单值投影，每拍必渲染，不再和 273 条候选抢 10 个槽。
- **c**：投影时保留 number，不再 `String()`。
- **d**：inventory 里的「钱」条目**停写**（提示词里 `inventory_add` 的例子不含钱），改由 `money` 路径承担。库存类物件仍是字符串（它们本来就没有数量概念），如果将来需要数量，同一套 `NUMBER_PATH_SET` 可以扩到 `item.quantity`。

### ⚠️ 这条必须配一个「回填」才知道对不对

新跑的局从开局 `anchors.snapshot` 播种 `money`。但玩家的初始银钱现在写在账本 `inventory` 文本里（`presets/nvzun-jianpolan.json` 的 `anchors.snapshot.inventory`）。**落地时必须同时决定**：开局账本体检——若 `snapshot` 里有钱而 `money` 路径缺失，记一条 `patch(kind='missing_number_path')` 提示作者补，**不自动解析文本**（解析「卖破烂挣的七十几块」就是堆识别器）。

### 验收判据

- 单元：`test-memory.js` 加「delta 累加 / 负数拒绝 / set 数字保持 number」三条断言；`test-context.js` 加「NUMBER_PATH_SET 与字符串路径不相交」。
- 端到端：重放 `8cfb7f62` 的 **6 次完整面额拆解**（t11/t19/t21/t24/t34/t40），`player.money` 在每一拍都能对上正文数字（t40 兜里 83.4 + 罐底 5 = 88.4）。这条**比任何机械判据都硬**。

---

## 3. P1 场次过碎（44.6% 的拍次上一拍正文不在上下文里）

### 根因（实测逐条复现 `detectSceneChange`，66 拍）

**封场原因分解**（逐拍忠实重放，29 次封场）：place 单独 **13** + place+time **13** + time 单独 **2** + 首拍自成一场 **1** = 29 场。
`SCENE_EVERY=12` **一次都没触发**（最长场次 6 拍），`SCENE_MAX_TOKENS` 也没触发。
→ **主因是地点（26/29 次封场含 place），不是时间**；时间单独只贡献 2 次（t37 黎婆死那一拍），
   它与地点叠加的 13 次说明两者高度同拍。

- `memory-pipeline.js:195` `if (prevWhen && nextWhen && prevWhen !== nextWhen) return true;` ——时间标签是自由文本，任一字符不同就切场；65 拍里变了 15 次。
- `place` 文本变化 **26** 次；65 拍共 **25 个不同地点文本**（`竹院`×6、`车上`×5、`东街十五路`×5、`村口老槐树下`×5、`湘曲市区街角`×5、`老旅馆二楼`×5 …），时间标签 16 个。
  这两组数说明**不是地名没归一，而是这局本来就在反复换地方**——所以修法不能靠地名归一，只能靠「场次下限」。
- 按「地名根 id 归一后比较」（最长 alias 命中归并）再跑一遍：**仍然是 26 次变化、29 场**——地名归一本身不减少切场。

**新发现（报告没有，两条）**

1. **`place_id` 会指到完全没有该地点的实体**：t59/t60 `place=老旅馆二楼房间`，`place_id=bie-shu`（别墅）。
   根因是 `archivist.js:800-810`：`resolveEntity('老旅馆二楼房间')` 未命中 → 走兜底 `linkEntities(...).fact`「取最长命中」，
   而 `bie-shu` 的 aliases 含 **`二楼`**（`presets/nvzun-jianpolan.json` 别墅条目），于是被抢走。
   后果是可观测的：t60/t61 的 `meta.assembly.codex` 里有 `bie-shu`（别墅条目被当成当前地点加分进场），
   而 t62 之后 `老旅馆` 自己 introduce 出来了才恢复正常。
2. **`aliasIndex` 只从卡快照构建，运行期 introduce 的实体永远解析不到**：
   `archivist.js:511 const aliasIndex = buildAliasIndex(card);` —— `buildAliasIndex` 只遍历 `card.entities`。
   而 `官道 / 柴房 / 回春堂 / 老旅馆` 全是运行期 `introduce`（`world_state op='introduce'`）出来的，
   所以它们的 `place_id` 只能是自由文本（或空）。这解释了 t17 `柴房`、t61 `回春堂` 的 `place_id` 分别为 `柴房` 与空。
   **错配的实测规模（别把规模说大）**：65 拍里 63 行有 `place_id`，按「pid 能不能落到某个真实 entries 条目」分桶：

   | 桶 | 条数 | 说明 |
   |---|---|---|
   | A `pid` 就是真实 place 的 id | **41** | 正常 |
   | B `pid` 写的是 place 的 **name** 而不是 id | **13** | `别墅`/`废品站`/`竹屋`/`伍家竹院`/`伍卿的村子（村口）` 等，按 name 能解析到同一实体 |
   | D `pid` 指向**非 place 实体** | **7** | 全是 `黑色商务车`——它在卡里是 `type='item'`，不是地点 |
   | E 自由文本 | **2** | t27/t28 `伍卿的村子（村口）` |

   - **真正「指向了错的地点」的只有 t59/t60 两条**（`老旅馆二楼房间` → `bie-shu` 别墅）。
   - B/D/E 共 22 条不会把错误设定带进上下文，**只是加不上「当前地点 +20 分」**（`context-engine.js` 的地点加分按 `place_id` 匹配）。B 桶尤其冤：13 拍的地点条目本可正常加分。

### 方案（两条独立的确定性修正，不需要模型）—— ② 是「切得太碎」，① 是「地点指错/解析不到」

**① `place_id` 改成「最长命中重算 + 必须落到真实实体」**——`archivist.js:797-811` 整段替换：

```js
// place_id 只做一件事：把地点名映射到卡里（或本分支已 introduce）的 place 实体。
// 原实现有两个洞：①先 resolveEntity 精确命中，失败才走兜底，而兜底取「第一个命中」不是最长，
// 于是「老旅馆二楼房间」被别墅的别名「二楼」抢走；②aliasIndex 只从卡快照建，运行期
// introduce 的官道/柴房/回春堂/老旅馆永远解析不到，place_id 只能是自由文本。
// 新规则两段式，且两段都只做「确定性匹配 + 唯一性判定」，不做任何名字特判：
//   ① 正向：地点文本 ⊇ 某 label（name/aliases），取最长 label 命中；
//   ② 反向：某 label ⊇ 地点文本，取最短 label 命中，且**必须唯一**（唯一性过不了就当解析失败）。
// 解析失败写空字符串 —— 空只表示「这个地点没有对应实体」，不会把错实体带进上下文。
let placeId = '';
if (scene.place) {
  const raw = str(scene.place);
  let best = '', bestLen = 0;
  for (const e of placeEntities) {                     // 卡快照 + 本分支已 introduce 的 place
    for (const label of [e.name, ...(e.aliases || [])]) {
      const l = norm(label);
      if (l && l.length >= 2 && raw.includes(l) && l.length > bestLen) { best = e.id; bestLen = l.length; }
    }
  }
  if (!best) {
    const cands = [];
    for (const e of placeEntities) {
      for (const label of [e.name, ...(e.aliases || [])]) {
        const l = norm(label);
        if (l && raw.length >= 2 && l.includes(raw)) cands.push({ id: e.id, len: l.length });
      }
    }
    cands.sort((a, b) => a.len - b.len);
    const shortest = cands.length ? cands[0].len : 0;
    const uniq = new Set(cands.filter((c) => c.len === shortest).map((c) => c.id));
    if (uniq.size === 1) best = cands[0].id;           // 歧义（别墅/凌玥的别墅/西式别墅…）→ 判失败，不猜
  }
  placeId = best;                                       // 解析不到就是空，不保留自由文本
}
// 地点没变、只有模型显式写了 place_id 时，不要用它覆盖（原逻辑会把它当自由文本写进账本）。
// 判据：place 为空 = 地点未变，此时 place_id 只能是「同一地点的 id 形式」，按 id/name 归一，
// 归一不到就保持 undefined（沿用旧值），不要写空把已有 place_id 抹掉。
if (!scene.place && scene.place_id) {
  const byId = placeEntities.find((e) => e.id === scene.place_id);
  const byName = placeEntities.find((e) => norm(e.name) === norm(scene.place_id));
  placeId = (byId || byName)?.id || '';
}
```

配套：`aliasIndex` / `placeEntities` 的构建要把 `world_state op='introduce'` 里 `entity_kind='place'` 的条目并进来
（`buildAliasIndex(card, introduced)` 加可选第二参，`archivist.js:511` 传 `getIntroducedEntities(sessionId, {branchId, atTurn: turnNo})`）。

**实测（把上述两段式规则逐拍重放 65 拍）**：**解析成功 58 / 65（89%）**，其中与原值不同 **34** 条；**解析失败 7 条**，全是 `车上` / `黑色商务车内／村路`——`黑色商务车` 在卡里是 `type='item'`，本来就不该是 place_id。落地时按「解析不到就写空」处置（空 = 只是加不上地点加分，不会把错实体带进上下文）。

关键收益有三条，都实测过：
- **`老旅馆二楼房间` 现在解析到 `老旅馆` 而不是 `bie-shu`**——单靠「最长命中」就修掉了 t59/t60 的错指（`老旅馆`=3 字 > 别墅别名 `二楼`=2 字），不需要任何特判。
- 34 条原本是自由文本或 name 的 `place_id`（`别墅 → bie-shu`、`东街十五路 → dongjie-shiwulu`、`竹院 → 伍家竹院`、`回春堂 → 回春堂`）**接上了真实实体**，「当前地点 +20 分」终于生效。
- 反向包含这一档不能省：t61 `place=回春堂` 而实体全名是 `镇东回春堂`，正向「label ⊆ place」匹配不到，反向「place ⊆ label」才能命中。**反向必须要求唯一**（最短 label 命中且只有一个实体），否则 `别墅` 会同时命中 `别墅 / 凌玥的别墅 / 古风大别墅 / 西式别墅`——这正是本项目最怕的「名字名单式猜测」，用「唯一性」把歧义直接判为解析失败，而不是猜一个。

**② 最小场长（真正把「上一拍正文」留在上下文里的那一条）**——`SCENE_EVERY=12` 只在 12 拍时才封场，
而实测场次平均 2.24 拍，说明**缺的是下限不是上限**。只在 `memory-pipeline.js:191-195` 的两个软触发前加一道闸，
硬触发（`:199` 轮数、`:208` token）**不受约束**（否则 `minTurns > sceneEvery` 会死锁）：

```js
// 场所下限：场次太短会让下一拍的「当前场次逐字原文」为空（coverage.recent_from === null），
// 模型看不到上一拍正文。注意 prev 是「上一场已封的场」，所以：
//   turnNo - prev.turn_to = 本场已经写下的拍数（不含本轮）
// 只约束「地点/时间变化」这两个软触发；轮数与 token 的强制封场必须照样生效。
const inScene = turnNo - prev.turn_to;
const tooShort = MIN_SCENE_TURNS > 0 && inScene < MIN_SCENE_TURNS;   // config.context.minSceneTurns，默认 3
if (!tooShort && isSubstantivePlaceShift(prev.place, ledger.place)) return true;
if (!tooShort && prevWhen && nextWhen && prevWhen !== nextWhen) return true;
```

> **初稿这里写错过一次，是实测抓回来的**：写成 `turnNo - prev.turn_from` 时，`prev.turn_from`
> 是**上一场的起点**而不是终点，上一场越长这个差越大，闸门就越早放行——首场之后第二场只要
> 2 拍就「满 3 拍了」。跑真实短跑时 3 拍切 3 场（1.00 拍/场）才暴露出来：`recent_from=null`
> 占 66.7%，比没加下限还差。用 `turnNo - prev.turn_to` 之后才是「本场已写下几拍」。

**实测收益（逐拍重放 `8cfb7f62` 的 65 拍，`SCENE_EVERY=12` 与 token 上限不变）**

> 重放器先做了**对齐校验**：`minTurns` 不加时重放出的 29 个已封场边界与 DB 里 `scenes` 的
> `29/29` 逐条一致（`turn_from`+`turn_to` 全中），所以下表不是估算，是同一套判定的推演。

| 配置 | 已封场数 | 平均拍/场 | 场长 | `recent_from=null` |
|---|---|---|---|---|
| 现状（minTurns=0） | 29（+1 未封） | 2.24 | 1–6 | 29 / 65 = **44.6%** |
| 仅去掉时间触发 | 27 | 2.41 | 1–6 | 27 / 65 = **41.5%** |
| minTurns=1 | 29 | 2.24 | 1–6 | 29 / 65 = 44.6% |
| minTurns=2 | 24 | 2.71 | 1–5 | 24 / 65 = 36.9% |
| **minTurns=3（推荐）** | **18** | **3.61** | 1–5 | **18 / 65 = 27.7%** |
| minTurns=4 | 15 | 4.33 | 1–5 | 15 / 65 = 23.1% |
| minTurns=5 | 14 | 4.64 | 1–5 | 14 / 65 = 21.5% |
| minTurns=2 + 去掉时间触发 | 24 | 2.71 | 1–5 | 24 / 65 = 36.9% |

（表里「场长 1」不是噪声：**第一场天然只有 1 拍**——`detectSceneChange:189` 在没有
`latestScene` 时直接 `return true`，首拍必然自成一场。下限约束只作用于第二场之后。）

三条从数字里读出来的结论：

1. **时间触发在有了下限之后完全没有收益**：`minTurns=2` 单独 24 场 / 36.9%，叠加「去掉时间触发」
   还是 24 场 / 36.9%——一场都不多省。**所以不要去动 `:195`**（AGENTS §1.2「一次只改一个变量」；
   零收益，代价是「跨日」不再自然分场、且要再动一条判定）。
2. **推荐 `minTurns=3`**：29 → 18 场，`recent_from=null` 从 44.6% 降到 27.7%；
   再上一档（4）能到 23.1%，但单场变长会推高封场时场记 Agent 的输入 token，
   而 `minTurns=3` 已经把「1 拍一场」的碎场清掉了（场长下限 1–5 → 均 3.61）。
3. **`recent_from=null` 的拍数恒等于场数**（每场第一拍必然没有「本场已有原文」），
   所以这条指标的理论下限就是 `1/平均拍每场`。目标定 **`recent_from != null` > 60%**
   （minTurns=3 时是 72.3%，minTurns=4 时 76.9%）。`scenes` 行数同步下降（65 拍从 29 场到 18 场），
   场次索引更短、token 更省——**这是顺带的好处，不是副作用**。

### 验收判据

新跑一局 20 拍，统计 `meta.coverage` 中 `recent_from != null` 的比例：现状 44.6% → 目标 **> 60%**；
同时 `scenes` 行数不应低于 `ceil(拍数/12)`（防止「一场都不关」回归），单场不得超过 `SCENE_EVERY`。

---

## 4. 其余缺口（P1/P2，逐条一句话方案）

| 缺口 | 方案 | 改动面 |
|---|---|---|
| **自造 canon 复利**（银镯纹样 → 升格「凌家的款式」） | **不修主链路**，做离线质检：`_work/longrun-drift.mjs` 比对「正文里首次出现的具体细节（数字/纹样/名字）」与「卡 + 断言」，产出待复核清单。判据是人工的，不进提示词 | 新增 `_work` 脚本，零运行时代码 |
| **玩家主观命名/承诺无承载面**（「老伙计」22 拍后消失） | 已有通道就够：`threads` 承载「未回收的约定」，加一条提示词约束「玩家给东西起了名字 / 做了口头承诺，记进 threads 或 relations.note」。**不新增断言谓词**（新增谓词要动 `PREDICATES` + 提示词 + 测试，收益不抵成本） | `prompts/archivist.js` 两行 |
| **`check-context.mjs` 模拟节奏差 3.2×** | `SCENE_EVERY` 参数化：`node _work/check-context.mjs 1000 --scene-every 2`，默认仍 12 | `_work/check-context.mjs:39` |
| **`meta.messages` / `meta.scene_sheet` 未落库** | `orchestrator.js:476 buildAssemblyMeta()` 白名单加两个键。它们是「新增内容必须落层」的验收证据，现在看不到 | 一行 |
| **记忆面板计数被截断** | 路由支持 `?limit=` 与 `hasMore`，面板显示「100+」；不要静默截断 | `routes/sessions.js:535/556/563/570/580` + 面板 |
| **`uncertain` 零消费** | **报告这条要更正**：`offstage_event` **有**消费方——`context-engine.js:738-752` 把最近一次封场之后的 `rumor/public` 事件渲染成「压力」段的流言（`hidden` 永不外泄；每轮最多 2 条、按 `who` 去重）。按它的取数逻辑（`listPatches(status:'open', limit:24)` 是 `id DESC` + `turn_no >= lastClosedTo`）逐拍严格重放 65 拍：**流言一拍都没缺（0/65 取不到）**，但被「同一人反复推同一件事」脉死了——`南荣兰冰` 在 **47/65** 拍的渲染里出现、**34/65** 拍居首（连续 **14** 拍同一人居首），`姬凡` 出现 29/65、居首 10/65；各时段的渲染里 distinct `who` 只有 **11** 个。原因是 `offstage_event` 只占 `patches` 的 `open` 57 条中的一小部分，24 条的窗口里翻来覆去就是最近那几条，内容从 t1 到 t39 反复「递拜帖 / 求见凌玥 / 备车前往」。真正零消费的**只有 `uncertain`（209 条 open）**。处置：①world-tick 加「同一人同一诉求不再重推」的去重/衰减（`memory-pipeline.js:498 runWorldTick` 只拿到 `last` 一场的 outcome，看不到历史 patches，所以重复没人拦）；②`uncertain` 要么接消费方，要么停止产出 | ①②两处，二选一不能继续堆 |
| **`longrun-report.mjs` 重复率只看 p90** | 加尾部判据「单拍 > FAIL 线的拍数占比 ≤ 5%」。实测（phase2 全量 64 个样本）：p90 = 6.5% 判 PASS，但 **t47 = 23.2%、t50 = 23.6% 已经越过 20% 的 FAIL 线**，另有 t44 13.5% / t45 14.3% 越 WARN 线——**p90 恰好把两拍真越线抹平了**（4/64 = 6.3% 越 WARN、2/64 = 3.1% 越 FAIL）。脚本不在运行时链路，改它不影响产品 | `_work/longrun-report.mjs:1448-1464` |
| **旁路 Agent 成本倒挂** | 史官输出是全文提案（`narrative` 全文回灌）。可裁剪：`changes`/`assertions` 各限条数（现在无上限），`quotes` 限 3。**先测再砍**，别一次动两个变量 | `prompts/archivist.js` + `archivist.js:595-700` |

---

## 5. MVU 评估：能借鉴什么、不必照搬什么

### 5.1 同构部分（已经在做）

| MVU | 本项目 | 位置 |
|---|---|---|
| 模型判断「改哪个字段」 | 史官 `changes` / `assertions` / `states` | `prompts/archivist.js` |
| 框架解析补丁、校验、落盘 | `sanitizeChange` → `applyArchivistUpdate` | `agents/archivist.js:198` / `:606` |
| `replace` | `addWorldState(op='set')` 先关旧值再插 | `store.js:919-924` |
| 应用 patch 到状态 | `buildEffectiveWorld` 按 `valid_from` 回放 | `world/effective.js:256-262` |
| Zod schema 结构约束 | `state-paths.js` 路径白名单 | `world/state-paths.js` |
| 只读字段保护 | 身份根不在白名单内（`id/name/identity/voice`） | 同上 |
| 派生视图给前端 | `buildPlayerView`（状态条唯一真源） | `memory/player-view.js` |

**结论：不是「要不要引入 MVU」，是「本项目的 MVU 已经长了 90%，差一个 `delta`」。**

### 5.2 缺的那一环

MVU 的 `delta` 是**自定义 op**（不是 RFC 6902 标准，报告 §6.2 已注明「本机这份聊天记录里没用过」）。它的价值不在语法，在**让数字成为一等公民**：`+5` 由脚本算，模型永远不输出 `money: 93.4` 这种「自己算完的结果」。

本项目现在**模型输出的是算完的结果**：`拥有 → 八十八块四`、`拥有 → 八十三块四`——每次都是一次独立的心算，**6 次完整面额拆解 6 次算不平**（报告 §4.4：最大偏差 −25.7 元）。这不是模型笨，是**让它做它不该做的事**。

### 5.3 不必照搬的（照搬会引入新问题）

| MVU 做法 | 为什么本项目不照搬 |
|---|---|
| JSON Pointer 路径（`/女性角色/秧秧/好感度`） | 本项目的 `(entity_kind, entity_id, path)` 二元寻址 + 白名单更窄、更可校验。JSON Pointer 要处理中文键、数组下标前移（MVU 报告 §6.3 专门写了「删多条要从大到小」的坑），这套复杂度换不来收益 |
| 世界书条目注入格式规则（`[mvu_update]`，本机 7 条共 ~30K 字符） | 违反 AGENTS §1.1 红线 1（提示词是渲染出来的，不是检索出来的）与 §1.2（不新增注入点）。本项目的 schema 在**代码里**（`sanitizeChange`），不进提示词 |
| `<UpdateVariable>` 嵌在正文里由正则抠 | 违反红线 8（旁白只写正文，永远不输出 JSON）。本项目走独立史官 Agent + `response_format: json_object`，本来就是干净的 |
| Zod 运行时依赖 | AGENTS §12 禁新依赖。用 `state-paths.js` 的白名单 + `NUMBER_PATH_SET` 手写校验，等价够用 |
| 数组 op 语义 | 本项目的 `add/remove` 只对 `LIST_PATH_SET` 合法，且按**值**而非下标操作（`effective.js:158-166` `removeList` 按值删），天然没有「下标前移」坑。**不要为了对齐 MVU 引入下标语义** |

### 5.4 可以直接借鉴的四条（都是低成本、高收益）

1. **`delta` 只对数值路径合法，类型由路径决定而不是由模型声明。** MVU 靠 Zod 的 `z.number()` 兜；本项目靠 `NUMBER_PATH_SET` 兜。**关键：模型不能通过「value 写成数字」把任意路径变成数值路径。**
2. **违规判定要显式留痕，不要静默修正。** MVU 的 schema 校验失败会抛/丢弃；本项目应写成 `patch(kind='rejected_delta')`，进记忆面板可见。静默 clamp 会让「钱变少了但没人知道为什么」——这和「静默失忆」是同一类问题。
3. **冷启动体检。** MVU 报告 §6.4 强调「第一轮没把状态填实，后面所有轮都建立在空状态上」。本项目的开局是从 `anchors.snapshot` 播种，**没有校验播种完整性**。加一节：开局后检查 `player.money` 等数值路径是否存在，缺失记 patch（提示作者补卡，不自动解析文本）。
4. **只读字段用前缀/白名单，不用约定。** MVU 用 `_` 前缀（靠模型自觉）；本项目已经用白名单硬拒，**保持**。

### 5.5 一句话回答

> **你的提案是对的，而且本项目已经有 90% 的基础设施。落地只需要「给 `world_state` 加 `delta` op + 数值路径白名单 + 越界拒写留痕」三件事，不动表结构、不加 Agent、不加提示词段落。真正的风险不在技术，在「第一次跑会不会把钱算错」——所以落地时必须用 `8cfb7f62` 的 6 次面额拆解做回归，并人工核对 `player.money` 与正文声明额一致。**

---

## 6. 建议的落地顺序（三个独立 PR，一次只动一个变量）

**PR-1（数值，收益最大、风险可控）**
`state-paths.js` 数值路径 → `store.js` op 白名单 → `effective.js` delta 分支 + 越界留痕 → `archivist.js sanitizeChange` 校验 → 史官提示词两行示例 → 测试。
验收：`8cfb7f62` 重放到 t66 金额正确；`test-memory` / `test-context` 绿。

**PR-2（死亡，收益确定、面最小）**
`sceneKeeperSystemPrompt` 加 `life_changes` → `closeScene` 交叉落库 + 幂等 + patch → 测试。
验收：重放 t37，`life_state=dead @t37`，t38 present 不含黎婆。

**PR-3（场次，收益最大但要观察）**
`place_id` 两段式重算 + 引入实体并入 alias 池 → `detectSceneChange` 加 `MIN_SCENE_TURNS` → 测试。
**不要动 `:195` 时间触发**（实测与 minTurns 叠加一场都不多省）。
验收：`node _work/longrun-report.mjs <sid>` 第 1 段的场次表（场数 / 场长 / `recent_from=null` 比例）达到 18 场 / 27.7% 那一档；
新跑 20 拍时 `recent_from != null` 比例 > 60%；`scenes` 行数 ≥ `ceil(拍数/12)`（防「一场都不关」回归）。

P2 那批（`meta` 白名单、面板分页、`uncertain` 处置、报告阈值）单独一个「杂项」PR，别和上面三个混。

---

## 附录：本文数字的复现方式（只读 DB）

```bash
# 需要 node --experimental-sqlite 或 Node >= 22.5
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/roleplay.db',{readOnly:true});"
```

```sql
-- S = '8cfb7f62-9c16-43de-a451-ca7ccb98de96'
-- 1) 「拥有」active 断言（P0-2 / 48 条）
SELECT predicate, COUNT(*) c FROM assertions WHERE session_id=S AND status='active' GROUP BY predicate ORDER BY c DESC;
SELECT object, valid_from FROM assertions WHERE session_id=S AND subject='伍卿' AND predicate='拥有' AND status='active' ORDER BY valid_from;

-- 2) world_state 数字型条数（P0-2 / 应为 0）
SELECT COUNT(*) FROM world_state WHERE session_id=S;   -- 1393
-- typeof 要在 JS 侧判 JSON.parse(value_json)

-- 3) 场次切碎（P1）
SELECT COUNT(*) FROM scenes WHERE session_id=S;                                  -- 29
SELECT scene_id, turn_from, turn_to, turn_to-turn_from+1 len FROM scenes WHERE session_id=S ORDER BY turn_from;  -- 最长 6
SELECT turn_no, json_extract(state_json,'$.place'), json_extract(state_json,'$.place_id'),
       json_extract(state_json,'$.time') FROM states WHERE session_id=S ORDER BY turn_no;
-- 场次推演（含「重放边界 vs 真实 scenes」对齐校验）：
--   场次表在 node _work/longrun-report.mjs 8cfb7f62 第 1 段

-- 4) patches 分布（P2 / offstage_event 有消费方）
SELECT kind, status, COUNT(*) c FROM patches WHERE session_id=S GROUP BY kind, status ORDER BY c DESC;

-- 5) 死亡时窗（P0-1）
SELECT who, field, value, valid_from, valid_to FROM character_states
WHERE session_id=S AND who='黎婆' AND field='life_state' ORDER BY valid_from;
SELECT scene_id, turn_from, turn_to, outcome FROM scenes WHERE session_id=S AND outcome LIKE '%离世%';
```


