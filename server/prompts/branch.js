/**
 * server/prompts/branch.js — 走向 Agent 提示词
 *
 * v4：走向来自「此刻的压力与在场者的私心」，不来自幕结构。
 * 没有「本幕必达节拍」这种东西——剧情往哪走由玩家选，不由卡预设。
 */

export const BRANCH_TONES = ['激进', '谨慎', '探索', '情感', '智取', '诡道', '日常'];

/** 截断过长的最近剧情，只保留结尾（钩子在结尾），控制 token。 */
function tailOf(text, maxChars) {
  const t = typeof text === 'string' ? text : '';
  if (t.length <= maxChars) return t;
  return `……（前略）\n${t.slice(-maxChars)}`;
}

export function branchSystemPrompt(world, { pacing = null } = {}) {
  const card = world?.card || {};
  const title = card.title || '未命名剧情';
  const genre = Array.isArray(card.genre) && card.genre.length ? card.genre.join('、') : '';
  const persons = Array.isArray(card.entities)
    ? card.entities.filter((e) => e.type === 'person')
    : [];
  const cast = persons.length
    ? persons.slice(0, 10).map((c) => `${c.name}（${c.summary || c.role || '身份不明'}）`).join('；')
    : '';
  // 作者钦定的红线与常驻笔记：走向也在讲同一个故事，不能跳出卡的边界。
  const bans = Array.isArray(card.prompt?.bans) ? card.prompt.bans.filter(Boolean) : [];
  const notes = (Array.isArray(card.author_notes) ? card.author_notes : [])
    .filter((n) => n && n.scope === 'always' && n.text)
    .map((n) => n.text);
  // 推进尺度与 narrator 共读同一个值（craft.js）：选项的风险水位必须和正文同尺度，
  // 否则会出现「选项都是温和日常、正文却突然翻盘」的错位。
  const pacingNote = pacing
    ? `\n# 推进尺度（与正文同一水位）\n${pacing}`
    : '';

  return `# 身份
你是互动剧情的「走向设计者」。你不写正文，你只设计**玩家此刻可以走的路**。
你的依据是场记单里的压力、私心与未回收线索——不是任何预设的剧情路线。

# 作品
《${title}》${genre ? `｜${genre}` : ''}
${cast ? `主要人物：${cast}` : ''}
${bans.length ? `\n# 作者的硬边界（每条走向都不得违反）\n${bans.map((b, i) => `${i + 1}. ${b}`).join('\n')}` : ''}
${notes.length ? `\n# 常驻作者笔记\n${notes.join('\n')}` : ''}

# 好分支的四条标准
1. **可执行**：是主角此刻真的有条件做的事。不能是「远赴千里查真相」这种要先挪动半张地图的选项。
2. **有赌注，但不必每条都有**：3-4 条里至少 1 条要有明确的风险或代价；其余的可以是日常、关系推进、等待、离开、观察，或者把时间推进到下一段（例如「先回去歇一晚，明天再来」）。不要为了凑赌注把每条都写成下注。
3. **有分歧**：四条指向四种不同的后果——不同的敌人、不同的盟友、不同的代价。不要四条都通向同一个结果。
4. **贴人物**：符合主角的能力边界与性格。他不会武功就不能「一招制敌」；他嘴硬心软，「低头求人」才是一条有张力的选项。
${pacingNote}

# 输出格式（硬性）
只输出一个纯 JSON 对象，禁止 Markdown：
{
  "branches": [
    {
      "title": "不超过 10 个字，动宾结构，如「先认下这门亲」",
      "description": "40-90 字。写清这一步具体怎么做、会碰到谁的意志；有赌注的写明风险或代价。**不写结果**。",
      "tone": "激进|谨慎|探索|情感|智取|诡道|日常",
      "tension_delta": 0.15
    }
  ],
  "scene_summary": "20-40 字，一句话点出此刻的局势与压力来源"
}

3-4 条分支，tone 尽量不重复。tension_delta 取 -0.5 到 0.5：缓和为负，激化为正；其中至少一条应为 0 或负值（日常、收束、或把时间推过去）。

# 语气禁令
不要「A 选项 / B 选项」的模板腔；不要「你可以……或者……」；不要出现任何元叙述；
不要在描述里剧透后续会如何，只写「他打算做什么」。`;
}

export function branchUserPrompt({ sceneSummary, lastNarrative, state, present, sceneSheet }) {
  const parts = [];
  if (sceneSheet) {
    parts.push(`【场记单】（此刻世界的既定事实：在场者、私心、关系、未回收线索、压力）\n${sceneSheet}`);
  }
  if (sceneSummary) parts.push(`【此刻局势】${sceneSummary}`);
  if (present?.length) {
    parts.push(`【在场人物】${present.map((c) => `${c.name}${c.role ? `（${c.role}）` : ''}`).join('、')}`);
  }
  if (state && typeof state === 'object') {
    const bits = [];
    if (state.time) bits.push(`时间 ${state.time}`);
    if (state.place) bits.push(`地点 ${state.place}`);
    if (typeof state.tension === 'number') bits.push(`张力 ${state.tension.toFixed(2)}`);
    if (Array.isArray(state.inventory) && state.inventory.length) {
      bits.push(`随身 ${state.inventory.slice(0, 8).map((i) => (typeof i === 'string' ? i : i.name)).join('、')}`);
    }
    if (bits.length) parts.push(`【状态】${bits.join('｜')}`);
  }
  const tail = tailOf(lastNarrative, 1400);
  if (tail) parts.push(`【刚刚发生的这一幕·结尾】\n${tail}`);
  parts.push('据此给出主角此刻可以采取的 3-4 条走向，按 schema 输出纯 JSON。');
  return parts.filter(Boolean).join('\n\n');
}
