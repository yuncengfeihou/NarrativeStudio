/**
 * server/prompts/narrator.js — 旁白提示词
 *
 * v4 之后旁白的 system 层由 context-engine 的 buildSystemLayer 生成
 * （契约 + 命题 + 宪章 + 世界索引）。这里只留「尾注」——紧贴玩家行动的
 * 最后一两条指令。SillyTavern 的经验：越靠近底部的指令影响力越强，
 * 所以只把「此刻的事」放在这里，不要把整份规范重复一遍。
 */

/**
 * 分段演绎的操作说明（P1-1 第一阶段）。
 *
 * 这是「怎么用工具」的说明，不是设定注入；放在最后一条 user 之前，
 * 不改变 system 层，也不改变场记单的渲染主路径。
 */
export function segmentedInstruction({ maxRounds = 6 } = {}) {
  return [
    `【分段演绎】这一拍允许分段写，最多 ${maxRounds} 轮。`,
    '- 当玩家问到具体地点、机构、物品、规矩或人物来历，或你准备写到某个辞书条目的规则/后果/细节时，先调用 codex_lookup 查证；不要凭印象补全。',
    '- 只是普通推进、场记单已经足够时，直接写正文；不要每段都查。',
    '- 需要修改已经写下的内容时，调用 draft_edit（find 必须是草稿里原样出现的片段）。',
    '- 确认写完后调用 draft_seal；如果不再调用工具，最后写下的正文就是定稿。',
    '- 不要把工具调用或 JSON 写进正文；定稿后不再修改。',
    '- 可以一次写完，也可以分段推进；无论哪种，都要保持可读，不要提前把整场收束。',
  ].join('\n');
}

/** 尾注：最后一条指令。 */
export function narratorTailInstruction(card, { directive = '', isOpening = false } = {}) {
  const p = card?.prompt || {};
  const lines = [];
  if (isOpening) lines.push('这是剧情的第一轮，此前没有任何历史。');
  if (directive) {
    lines.push(`【本场指令】（作者对这一幕的要求，优先级高于上文一切默认规范）\n${directive}`);
  }
  // 篇幅只跟作者写的卡走；没写就不提。
  // 结尾不做强制：这一拍可以停在需要回应的情势前，也可以自然走完或把时间推进；
  // 强制「必须立刻回应」会让时间永远停在同一个下午。
  const len = p.length ? `篇幅 ${p.length}。` : '';
  lines.push(`【此刻的要求】从场记单接续，不要复述它。不要总结，不要预告。${len}`);
  return lines.join('\n');
}