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
export function segmentedInstruction({ maxRounds = 6, checklist = '' } = {}) {
  const lines = [
    `【分段演绎】这一拍允许分段写，最多 ${maxRounds} 轮。`,
    '- 当玩家问到具体地点、机构、物品、规矩或人物来历，或你准备写到某个辞书条目的规则/后果/细节时，先调用 codex_lookup 查证；不要凭印象补全。',
    '- 只是普通推进、场记单已经足够时，直接写正文；不要每段都查。',
    '- 需要修改已经写下的内容时，调用 draft_edit（find 必须是草稿里原样出现的片段）。',
    '- 确认写完后调用 draft_seal；如果不再调用工具，最后写下的正文就是定稿。',
    '- 不要把工具调用或 JSON 写进正文；定稿后不再修改。',
    '- 可以一次写完，也可以分段推进；无论哪种，都要保持可读，不要提前把整场收束。',
  ];
  // 构思清单只在分段模式出现（单发没有回旋余地，列清单只会变成正文里的说教）。
  if (checklist) lines.push('', `落笔前在心里过一遍（不要把问题写进正文）：\n${checklist}`);
  return lines.join('\n');
}

/** 尾注：最后一条指令。 */
export function narratorTailInstruction(card, { directive = '', isOpening = false, craft = null } = {}) {
  const p = card?.prompt || {};
  const lines = [];
  if (isOpening) lines.push('这是剧情的第一轮，此前没有任何历史。');
  if (directive) {
    lines.push(`【本场指令】（作者对这一幕的要求，优先级高于上文一切默认规范）\n${directive}`);
  }
  // 篇幅只跟作者写的卡走；没写就不提。
  // 结尾不做强制：这一拍可以停在需要回应的情势前，也可以自然走完或把时间推进；
  // 强制「必须立刻回应」会让时间永远停在同一个下午。
  // 时间推进只给许可、不点名何时该用：是否跳过中间过程由这一拍的内容决定。
  // 玩家明说要做的位移/等待先发生：旧长跑里玩家说「回村」仍被架上车，
  // 根因是每一拍都在等「必须回应」的钩子，玩家动作被当成待处理的背景。
  // 「不总结、不预告」不再写在这里：契约的「不得出现元叙述」和工艺层的【怎么收尾】
  // 已经各说过一次，同一条规则第三次出现只是稀释注意力（§1.2 替换，不叠加）。
  const len = p.length ? `篇幅 ${p.length}。` : '';
  lines.push(`【此刻的要求】从场记单接续，不要复述它。玩家明确要做的动作（走、停、等、回家）先让它发生，不要让每一拍都被旁人拦回原地。这一拍如果本来就该结束，可以直接用一句过渡把时间推到几小时后、次日或更晚，不必把中间的每一分钟都演完。${len}`);
  // 推进尺度与结尾落点：与 buildContract 的工艺块同源（craft.js），
  // 放在最贴近生成点的位置——规则在 system、即时尺度在这里。
  if (craft) {
    if (craft.pacingText) lines.push(`【推进尺度·${craft.pacing === 'steady' ? '保守' : craft.pacing === 'bold' ? '激进' : '正常'}】${craft.pacingText}`);
    if (craft.ending) lines.push(`【怎么收尾】${craft.ending}`);
  }
  return lines.join('\n');
}
