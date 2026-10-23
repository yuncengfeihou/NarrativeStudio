/**
 * 记忆 Agent（memory）提示词构建。
 * 纯字符串拼装，可安全单测。输出约定为纯 JSON（调用方使用 response_format=json_object）。
 *
 * 导出：
 *   memorySystemPrompt()                                        —— system prompt
 *   roundSummaryUserPrompt({turnNo, playerText, branchChoice, narrative}) —— 每轮归档指令
 *   stateMergeUserPrompt({oldState, memoryUpdate})               —— LLM 合并 state 的备用指令
 *
 * 说明：state 的实际合并由 agents/memory-agent.js 的 mergeState() 在代码中完成（确定性、零成本），
 *       stateMergeUserPrompt 作为 LLM 合并通道导出，供调试或对照使用。
 */

/** state schema 说明（与 CONTRACTS.md 一致）。 */
const STATE_SCHEMA_HINT = `{
  "time": "第三日·黄昏",
  "location": "临江旧港区",
  "weather": "暴雨",
  "tension": 0.72,
  "characters": {"林霜": {"mood": "警惕", "location": "码头B仓", "status": "受伤"}},
  "inventory": ["生锈的钥匙", "半张船票"],
  "quests": [{"goal": "查明失踪案", "progress": "发现第二个证人", "status": "active"}],
  "threads": ["神秘组织'灰鸽'的线索", "林霜的旧伤"],
  "last_hook": "仓库深处传来铁链拖地声"
}`;

/**
 * system prompt：记忆管理员身份 + memory update JSON schema。
 * @returns {string}
 */
export function memorySystemPrompt() {
  return `# 身份
你是互动剧情项目的「记忆管理员」：把每一轮剧情压缩成高密度、可检索、可合并的结构化记忆。你不创作剧情，只做忠实的记录与提炼；宁可少记，不可编造。

# 输出要求（硬性，违反即失败）
1. 只输出一个纯 JSON 对象：禁止 Markdown 代码块、禁止解释文字（接口使用 response_format=json_object）。
2. schema 严格如下：
{
  "round_summary": "300-500字高密度摘要：关键事件、决定、状态变化、新实体、值得引用的原话、悬念钩子",
  "entities": [
    {"type": "character|item|location|faction|event|concept", "name": "世界内正式名称", "summary": "最新 consolidated 描述", "attributes": {}, "importance": 0.8}
  ],
  "facts": [
    {"subject": "林霜", "predicate": "拥有|敌对|位于|受伤|知晓|目标|信任", "object": "生锈的钥匙", "confidence": 0.9}
  ],
  "state_delta": {
    "time": "", "location": "", "weather": "", "tension": 0.7,
    "characters": {"林霜": {"mood": "警惕", "location": "码头B仓", "status": "受伤"}},
    "inventory_add": [], "inventory_remove": [],
    "quests_update": [{"goal": "查明失踪案", "progress": "发现第二个证人", "status": "active"}],
    "threads_add": [], "threads_resolve": [],
    "last_hook": ""
  }
}

# 字段规范
- round_summary：300-500 字高密度摘要。必须保留全部专有名词、数字、时间点、关键决定、物品得失、关系变化、值得记住的原话、悬念钩子；压缩修饰与废话，不写评价。
- entities：只收录本轮「新增」或「状态发生变化」的实体；没有变化的实体不要出现。type 只能取枚举值；name 用世界内正式名称（与既有名称保持一致，不得改写）。
- facts：简短谓词（拥有/敌对/位于/受伤/知晓/目标/信任等），object 写世界内对象名；confidence 取 0-1。只记本轮剧情支撑得住的事实。
- state_delta：只写「发生变化的字段」，没变化的键直接省略（或留空数组/空对象）。
  - time/location/weather/tension/last_hook：标量，变化才写；
  - characters：只写本轮状态有变的角色及其变化字段（mood/location/status 等）；
  - quests_update：按 goal 匹配——已存在的目标只更新 progress/status；全新目标视为新增条目；
  - threads_add：新增未回收线索；threads_resolve：本轮已回收/揭晓的线索原文。`;
}

/**
 * 每轮归档的 user prompt。
 * @param {object} opts
 * @param {number} opts.turnNo       回合号
 * @param {string} [opts.playerText] 玩家行动原文
 * @param {object} [opts.branchChoice] 玩家选择的分支（如有）
 * @param {string} opts.narrative    本轮剧情正文
 * @returns {string}
 */
export function roundSummaryUserPrompt({ turnNo, playerText, branchChoice, narrative } = {}) {
  const parts = [
    '请把下面这一轮剧情归档为结构化记忆（严格按 system 中的 JSON schema 输出）。',
    `【回合号】${turnNo ?? '?'}`,
    `【玩家行动】${(playerText || '').trim() || '（无——开场轮）'}`,
    `【玩家选择的分支】${branchChoice ? JSON.stringify(branchChoice) : '（无）'}`,
    '【本轮剧情正文】',
    String(narrative ?? ''),
  ];
  parts.push('只输出符合 schema 的纯 JSON；state_delta 仅包含真正发生变化的字段。');
  return parts.join('\n\n');
}

/**
 * LLM 合并 state 的 user prompt（备用通道；实际合并走 mergeState 代码路径）。
 * @param {object} opts
 * @param {object|null} opts.oldState     旧 state 快照
 * @param {object} opts.memoryUpdate      本轮 memory update（取 state_delta）
 * @returns {string}
 */
export function stateMergeUserPrompt({ oldState, memoryUpdate } = {}) {
  const delta = memoryUpdate?.state_delta && typeof memoryUpdate.state_delta === 'object'
    ? memoryUpdate.state_delta
    : {};
  return [
    '请把下面的 state_delta 深度合并进旧 state，产出完整的新 state（完整 state 的 schema 如下）：',
    STATE_SCHEMA_HINT,
    '',
    '【旧 state】',
    JSON.stringify(oldState ?? null),
    '',
    '【state_delta】',
    JSON.stringify(delta),
    '',
    '合并规则：',
    '1. time/location/weather/tension/last_hook 等标量：delta 中出现的直接覆盖，未出现的保留原值。',
    '2. characters 逐键合并：同一角色只更新其 mood/location/status 等变化字段，未提及的角色原样保留。',
    '3. inventory_add 追加（去重）；inventory_remove 移除对应物品。',
    '4. quests_update 按 goal 匹配：命中则更新 progress/status；未命中则追加新 quest。',
    '5. threads_add 追加线索（去重）；threads_resolve 移除已回收线索。',
    '6. 只输出合并后的完整 state JSON（包含所有未变化字段），不要输出任何解释。',
  ].join('\n');
}
