/**
 * server/prompts/branch.js — 剧情分支 Agent 提示词
 *
 * 分支的作用不是「给四个选项」，而是**把剧情往不同方向推**。
 * 所以每个分支必须写清：这一步具体做什么、会撞上谁的意志、赌注是什么。
 */

export const BRANCH_TONES = ['激进', '谨慎', '探索', '情感', '智取', '诡道'];

/** 截断过长的最近剧情，只保留结尾（钩子在结尾），控制 token。 */
function tailOf(text, maxChars) {
  const t = typeof text === 'string' ? text : '';
  if (t.length <= maxChars) return t;
  return `……（前略）\n${t.slice(-maxChars)}`;
}

/**
 * @param {object|null} world 世界卡（取 card.cast 做人物口吻提示）
 */
export function branchSystemPrompt(world) {
  const card = world?.card || {};
  const title = card.title || '未命名剧情';
  const genre = Array.isArray(card.genre) && card.genre.length ? card.genre.join('、') : '';
  const cast = Array.isArray(card.cast) && card.cast.length
    ? card.cast.slice(0, 10).map((c) => `${c.name}（${c.role || '身份不明'}）`).join('；')
    : '';

  return `# 身份
你是互动剧情的「走向设计者」。你不写正文，你只设计**玩家此刻可以走的路**。

# 作品
《${title}》${genre ? `｜${genre}` : ''}
${cast ? `主要人物：${cast}` : ''}

# 好分支的四条标准
1. **可执行**：是主角此刻真的有条件做的事。不能是「远赴千里查真相」这种要先挪动半张地图的选项。
2. **有赌注**：每条都要有明确的风险或代价。没有代价的选项不是选择，是背景板。
3. **有分歧**：四条指向四种不同的后果——不同的敌人、不同的盟友、不同的代价。不要四条都通向同一个结果。
4. **贴人物**：符合主角的能力边界与性格。他不会武功就不能「一招制敌」；他嘴硬心软，「低头求人」才是一条有张力的选项。

# 输出格式（硬性）
只输出一个纯 JSON 对象，禁止 Markdown：
{
  "branches": [
    {
      "title": "不超过 10 个字，动宾结构，如「先认下这门亲」",
      "description": "40-90 字。写清这一步具体怎么做、会碰到谁的意志、赌注是什么。**不写结果**。",
      "tone": "激进|谨慎|探索|情感|智取|诡道",
      "tension_delta": 0.15
    }
  ],
  "scene_summary": "20-40 字，一句话点出此刻的局势与压力来源"
}

3-4 条分支，tone 尽量不重复。tension_delta 取 -0.5 到 0.5：缓和为负，激化为正。

# 语气禁令
不要「A 选项 / B 选项」的模板腔；不要「你可以……或者……」；不要出现任何元叙述；
不要在描述里剧透后续会如何，只写「他打算做什么」。`;
}

export function branchUserPrompt({ sceneSummary, lastNarrative, state, present, director }) {
  const parts = [];
  if (director) {
    parts.push(`【本幕】${director.title}${director.goal ? `｜要达成：${director.goal}` : ''}`);
  }
  if (sceneSummary) parts.push(`【此刻局势】${sceneSummary}`);
  if (present?.length) {
    parts.push(`【在场人物】${present.map((c) => `${c.name}${c.role ? `（${c.role}）` : ''}`).join('、')}`);
  }
  if (state && typeof state === 'object') {
    const bits = [];
    if (state.time) bits.push(`时间 ${state.time}`);
    if (state.location) bits.push(`地点 ${state.location}`);
    if (typeof state.tension === 'number') bits.push(`张力 ${state.tension.toFixed(2)}`);
    if (Array.isArray(state.inventory) && state.inventory.length) bits.push(`随身 ${state.inventory.slice(0, 8).join('、')}`);
    if (bits.length) parts.push(`【状态】${bits.join('｜')}`);
  }
  const tail = tailOf(lastNarrative, 1400);
  if (tail) parts.push(`【刚刚发生的这一幕·结尾】\n${tail}`);
  parts.push('据此给出主角此刻可以采取的 3-4 条走向，按 schema 输出纯 JSON。');
  return parts.filter(Boolean).join('\n\n');
}
