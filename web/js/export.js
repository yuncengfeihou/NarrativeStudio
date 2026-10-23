/**
 * export.js — 会话导出（Markdown / 纯文本 / JSON）
 *
 * 导出是「作品的出口」：不只给一个 .md，而是提供三种粒度：
 *  - md   完整剧情（含设定头、回合分隔、分支选择记录）
 *  - txt  纯净正文（只保留narration 与玩家行动，用于投稿/阅读器）
 *  - json 完整数据快照（含记忆存档，可用于迁移/备份）
 */

import { api } from './api.js';
import { downloadFile, formatDate } from './util.js';
import { toast } from './app.js';

/** 组装 Markdown 文本 */
function buildMarkdown(detail) {
  const s = detail.session || {};
  const settings = s.settings || {};
  const turns = detail.turns || [];
  const lines = [];

  lines.push(`# ${s.title || settings.title || '未命名剧情'}`, '');
  const meta = [];
  if (settings.style_tags?.length) meta.push(`风格：${settings.style_tags.join('、')}`);
  if (s.turn_count) meta.push(`回合：${s.turn_count}`);
  meta.push(`导出：${formatDate(Date.now())}`);
  lines.push(`> ${meta.join(' ｜ ')}`, '');

  lines.push('---', '');

  let lastTurn = 0;
  for (const t of turns) {
    if (t.turn_no !== lastTurn) {
      lastTurn = t.turn_no;
      lines.push('', `<!-- 第 ${t.turn_no} 回合 -->`, '');
    }
    if (t.kind === 'player') {
      const choice = t.branch_choice;
      const tag = choice ? `（选择：${choice.title || ''}${choice.tone ? ` · ${choice.tone}` : ''}）` : '';
      lines.push(`**▸ 你${tag}**`, '', t.content || '（空行动）', '');
    } else if (t.kind === 'narrator') {
      lines.push(t.content || '', '');
    } else if (t.kind === 'system') {
      lines.push(`*${t.content}*`, '');
    }
  }

  // 记忆档案附录
  const mem = detail.memoryStats;
  if (mem) {
    lines.push('---', '', '## 记忆存档', '');
    const counts = [
      mem.turn_count != null ? `回合 ${mem.turn_count}` : '',
      mem.scene_count != null ? `场次 ${mem.scene_count}` : '',
      mem.branch ? `分支 ${mem.branch}` : '',
      mem.raw_tokens != null ? `原文 ${mem.raw_tokens} tok` : '',
    ].filter(Boolean);
    if (counts.length) lines.push(counts.join(' ｜ '), '');
    if (detail.state && typeof detail.state === 'object') {
      lines.push('### 最终状态快照', '', '```json', JSON.stringify(detail.state, null, 2), '```', '');
    }
  }

  return lines.join('\n');
}

/** 纯正文（无任何标记，适合阅读器或投稿） */
function buildPlainText(detail) {
  const turns = detail.turns || [];
  const out = [];
  for (const t of turns) {
    if (t.kind === 'narrator') out.push(String(t.content || '').trim());
    else if (t.kind === 'player' && t.content) {
      const c = t.branch_choice;
      out.push(`（${c?.title ? `${c.title}——` : ''}${t.content}）`);
    }
  }
  return out.filter(Boolean).join('\n\n');
}

/**
 * 导出并触发下载。
 * @param {string} id 会话 id
 * @param {'md'|'txt'|'json'} [format]
 */
export async function exportMarkdown(id, format = 'md') {
  toast('正在整理导出内容…');
  const detail = await api.getSession(id);
  const title = detail.session?.title || '剧情';
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

  if (format === 'txt') {
    downloadFile(`${safe}.txt`, buildPlainText(detail), 'text/plain;charset=utf-8');
  } else if (format === 'json') {
    downloadFile(`${safe}.json`, JSON.stringify(detail, null, 2), 'application/json;charset=utf-8');
  } else {
    downloadFile(`${safe}.md`, buildMarkdown(detail), 'text/markdown;charset=utf-8');
  }
  toast('已导出', { type: 'success' });
}
