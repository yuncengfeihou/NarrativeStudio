/**
 * markdown.js — 旁白正文的轻量渲染
 *
 * 剧情正文不是 Markdown 文档，而是小说文本。因此这里只做「阅读排版」，
 * 不做完整的 Markdown 解析：
 *  - 按空行分段（连续单换行保留为 <br>）
 *  - 「…」/“…” 内的对白着色为 .say
 *  - （…）内的内心独白着为 .inner
 *  - **粗体** / *斜体* 支持
 *  - 全部先 escapeHtml，杜绝注入
 */

import { escapeHtml } from './util.js';

/**
 * @param {string} text
 * @returns {string} HTML（已转义）
 */
export function formatNarrative(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';

  const paragraphs = raw
    .split(/\n{2,}/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim().length > 0);

  return paragraphs.map((p) => `<p>${renderInline(p)}</p>`).join('');
}

function renderInline(text) {
  let html = escapeHtml(text).replace(/\n/g, '<br>');

  // **粗体** → strong
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // *斜体* → em（避开已处理的 bold）
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // 「对白」着色
  html = html.replace(/「([^「」]{1,600})」/g, '<span class="say">「$1」</span>');
  // “对白”
  html = html.replace(/“([^“”]{1,600})”/g, '<span class="say">“$1”</span>');
  // （内心独白）—— 只处理较短的括号内容
  html = html.replace(/（([^（）]{1,200})）/g, '<span class="inner">（$1）</span>');

  return html;
}