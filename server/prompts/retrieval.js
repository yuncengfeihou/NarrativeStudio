/**
 * server/prompts/retrieval.js — 资料员预检提示词
 *
 * 模型主动取证，不是关键词触发：它只决定「这一拍要不要查、查什么」，
 * 代码只执行确定性匹配并把结果当拍注入。查不到/不需要查都返回空数组。
 *
 * 两条通道共一次往返：`codex`（这个世界是什么）与 `history`（之前发生过什么）。
 * 后者只在 `canRecall` 为真时提供——没有分支上下文时不该让它查。
 */

export function retrievalSystemPrompt({ names = [], maxQueries = 3, canRecall = true } = {}) {
  const historyPart = canRecall
    ? `
- **history**：查已经发生过的回合原文（某人的承诺、某件东西的来历、之前说过的具体条件、
  旧伤/旧账）。**你只看得见当前这一场的逐字原文，更早的场次只剩一行摘要**——
  要接续某个旧细节就查。查询词用人物名、物件名或一个短语（2~8 字），
  不要写整句，不要当作常规回顾。`
    : '';

  const schema = canRecall
    ? '{"codex":["..."],"history":["..."]}（两个数组都可为空，也可以只给一个）'
    : '{"codex":["..."]}';

  return `# 身份
你是长篇互动剧情的「资料员」。主演这一拍要写剧情，但世界索引里只有名字与一句话。
你的任务：判断这一拍是否需要查阅**设定集条目全文**（codex）或**已经发生的回合原文**（history）；
需要就给出查询词，不需要就返回空数组。

# 规则
- codex：只查「这一拍会写到、但没有把握」的条目：地点规则、机构内情、物件来历、人物细节、制度后果。
- 不要因为名字出现过就查。玩家提到/在场，不等于要查全文；能按已有理解写清楚的就不要查。
- 最多各 ${maxQueries} 条查询；每条用一个具体的名字或别名（2~8 字），不要写整句、不要写指令。
- codex 的查询词必须是下面清单里出现过的名字/别名，或玩家原话里的专有名词。${historyPart}
- 只输出 JSON：${schema}。不要解释。

# 可查条目（名字/别名）
${names.join('、')}`;
}

export function retrievalUserPrompt({
  playerText = '', ledger = null, lastNarrative = '', canRecall = true,
} = {}) {
  const parts = [];
  const scene = [];
  if (ledger?.time) scene.push(`时间：${ledger.time}`);
  if (ledger?.place) scene.push(`地点：${ledger.place}`);
  const cast = Object.keys(ledger?.characters || {});
  if (cast.length) scene.push(`在场：${cast.join('、')}`);
  if (scene.length) parts.push(`【当前场景】${scene.join('｜')}`);
  if (lastNarrative) parts.push(`【上一拍结尾】${String(lastNarrative).slice(-600)}`);
  parts.push(`【玩家这一拍的行动】${String(playerText || '').trim() || '（开场）'}`);
  parts.push(canRecall
    ? '请判断是否需要查设定集全文或历史原文；只输出 JSON。'
    : '请判断是否需要查阅设定集全文；只输出 JSON。');
  return parts.join('\n\n');
}
