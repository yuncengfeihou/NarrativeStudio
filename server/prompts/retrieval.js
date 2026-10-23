/**
 * server/prompts/retrieval.js — 辞书检索预检提示词
 *
 * 模型主动取证，不是关键词触发：它只决定「这一拍要不要查、查什么」，
 * 代码只执行确定性匹配并把结果当拍注入。查不到/不需要查都返回空数组。
 */

export function retrievalSystemPrompt({ names = [], maxQueries = 3 } = {}) {
  return `# 身份
你是长篇互动剧情的「资料员」。主演这一拍要写剧情，但世界索引里只有名字与一句话。
你的唯一任务：判断这一拍是否需要查阅某些辞书条目的**全文**；需要就给出查询词，不需要就返回空数组。

# 规则
- 只查「这一拍会写到、但没有把握」的条目：地点规则、机构内情、物件来历、人物细节、制度后果。
- 不要因为名字出现过就查。玩家提到/在场，不等于要查全文；能按已有理解写清楚的就不要查。
- 最多 ${maxQueries} 条查询；每条用一个具体的名字或别名（2~8 字），不要写整句、不要写指令。
- 查询词必须是下面清单里出现过的名字/别名，或玩家原话里的专有名词。
- 只输出 JSON：{"queries":["..."]} 或 {"queries":[]}。不要解释。

# 可查条目（名字/别名）
${names.join('、')}`;
}

export function retrievalUserPrompt({ playerText = '', ledger = null, lastNarrative = '' } = {}) {
  const parts = [];
  const scene = [];
  if (ledger?.time) scene.push(`时间：${ledger.time}`);
  if (ledger?.place) scene.push(`地点：${ledger.place}`);
  const cast = Object.keys(ledger?.characters || {});
  if (cast.length) scene.push(`在场：${cast.join('、')}`);
  if (scene.length) parts.push(`【当前场景】${scene.join('｜')}`);
  if (lastNarrative) parts.push(`【上一拍结尾】${String(lastNarrative).slice(-600)}`);
  parts.push(`【玩家这一拍的行动】${String(playerText || '').trim() || '（开场）'}`);
  parts.push('请判断是否需要查阅辞书全文；只输出 JSON。');
  return parts.join('\n\n');
}
