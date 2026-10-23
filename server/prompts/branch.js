/**
 * 剧情分支 Agent（branch）提示词构建。
 * 纯字符串拼装，可安全单测。输出约定为纯 JSON（调用方使用 response_format=json_object）。
 *
 * 导出：
 *   branchSystemPrompt(session)                        —— system prompt
 *   branchUserPrompt({sceneSummary, lastNarrative, state}) —— user prompt
 */

/** tone 枚举（与 CONTRACTS.md 的 branch option 一致）。 */
export const BRANCH_TONES = ['激进', '谨慎', '探索', '情感', '智取', '诡道'];

/** 截断过长的最近剧情，只保留结尾（钩子在结尾），控制 token。 */
function tailOf(text, maxChars) {
  const t = typeof text === 'string' ? text : '';
  if (t.length <= maxChars) return t;
  return `……（前略）\n${t.slice(-maxChars)}`;
}

/**
 * system prompt：规定身份、输出 schema、选项质量标准。
 * @param {object} session
 * @returns {string}
 */
export function branchSystemPrompt(session) {
  const s = session?.settings || {};
  const title = s.title || '未命名剧情';
  const worldview = (s.worldview || '（未提供）').slice(0, 600);
  const playerRole = s.player_role || '（未设定）';
  const characters = Array.isArray(s.characters) && s.characters.length
    ? s.characters.map(c => `${c.name}（${c.role || '身份不明'}，口吻：${c.voice || '—'}）`).join('；')
    : '（未提供）';
  const rules = (s.rules || '').slice(0, 400);

  return `# 身份
你是互动剧情项目的「分支设计 Agent」：依据当前局势、状态快照与最近剧情，为玩家生成下一轮的可选走向。你设计的是「路」，不是「剧情本身」。

# 作品基调（仅用于把握风格，不要复述给玩家）
- 标题：${title}
- 世界观：${worldview}
- 玩家角色：${playerRole}
- 登场角色：${characters}
${rules ? `- 作者规则（节选）：${rules}` : ''}

# 输出要求（硬性，违反即失败）
1. 只输出一个纯 JSON 对象：禁止 Markdown 代码块、禁止解释文字、禁止前后缀（接口使用 response_format=json_object）。
2. JSON schema 严格如下：
{
  "branches": [
    {
      "id": "b1",
      "title": "不超过12个字的短标题",
      "description": "50-120字的剧情走向描述：写清玩家大致会在什么时间/地点采取什么动作，以及可能引发的后果",
      "tone": "激进|谨慎|探索|情感|智取|诡道",
      "tension_delta": 0.1
    }
  ],
  "scene_summary": "当前局势的一句话概括"
}
3. branches 固定 3-4 个选项；tone 必须多样，至少覆盖三种不同玩法风格（从「激进/谨慎/探索/情感/智取/诡道」中选取），可以包含一个「高风险高回报」选项（tension_delta 显著为正）。
4. 选项必须具体：包含时间、地点、动作、对象中的至少三项；拒绝「继续前进」「随机应变」「静观其变」这类空泛表述。
5. 选项必须基于给定的状态快照与最近剧情生成，与世界内事实、人物状态一致；不得引入与状态矛盾的地点或物品。
6. tension_delta 取值约 -0.2 ~ 0.3，表示选择该选项后局势紧张度的变化；保守选项可为负。
7. 不要替玩家做决定：选项是并列的可走之路，不写「玩家一定会成功/失败」的结论，也不在选项里替玩家说出台词。
8. id 依次为 b1、b2、b3……并按推荐程度排序（b1 为最自然、最契合当前局势的走向）。`;
}

/**
 * user prompt：喂入当前局势、最近剧情结尾、状态快照。
 * @param {object} opts
 * @param {string} [opts.sceneSummary]  当前局势一句话
 * @param {string} [opts.lastNarrative] 最近一轮剧情正文（自动截断保留结尾）
 * @param {object|null} [opts.state]    状态快照（CONTRACTS.md 的 state schema）
 * @returns {string}
 */
export function branchUserPrompt({ sceneSummary, lastNarrative, state } = {}) {
  const parts = ['请基于以下信息，生成下一轮的分支选项（3-4 个，tone 多样）。'];
  if (sceneSummary) parts.push(`【当前局势】${sceneSummary}`);
  const tail = tailOf(lastNarrative, 1500);
  if (tail) parts.push(`【最近剧情·结尾处】\n${tail}`);
  if (state && typeof state === 'object') parts.push(`【状态快照】\n${JSON.stringify(state)}`);
  parts.push('只输出符合 schema 的纯 JSON，不要任何其他文字。');
  return parts.join('\n\n');
}
