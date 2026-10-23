/**
 * server/prompts/narrator.js — 旁白提示词
 *
 * v4 之后旁白的 system 层由 context-engine 的 buildSystemLayer 生成
 * （契约 + 命题 + 宪章 + 世界索引）。这里只留「尾注」——紧贴玩家行动的
 * 最后一两条指令。SillyTavern 的经验：越靠近底部的指令影响力越强，
 * 所以只把「此刻的事」放在这里，不要把整份规范重复一遍。
 */

/** 尾注：最后一条指令。 */
export function narratorTailInstruction(card, { directive = '', isOpening = false } = {}) {
  const p = card?.prompt || {};
  const lines = [];
  if (isOpening) lines.push('这是剧情的第一轮，此前没有任何历史。');
  if (directive) {
    lines.push(`【本场指令】（作者对这一幕的要求，优先级高于上文一切默认规范）\n${directive}`);
  }
  lines.push(`【此刻的要求】从场记单接续，不要复述它。篇幅 ${p.length || '1600-2600 字'}。`);
  lines.push('结尾停在一个必须立刻回应的情势前。不要总结，不要预告，不要平稳收尾。');
  return lines.join('\n');
}