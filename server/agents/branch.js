/**
 * server/agents/branch.js — 剧情分支 Agent
 *
 * 输入：世界卡、当前状态、最近文本、在场人物、当前幕
 * 输出：3-4 条可执行、有分歧的走向（至少一条带赌注，其余可为日常/关系/推时间）
 *
 * 解析容错链：整体 JSON → 正则提取 {...} → 打捞 branches 数组 → 3 条通用兜底。
 * LLM 调用失败同样降级，绝不阻断回合。
 */
import { chat } from '../llm.js';
import { branchSystemPrompt, branchUserPrompt, BRANCH_TONES } from '../prompts/branch.js';

const FALLBACK_BRANCHES = [
  {
    title: '先应下',
    description: '把眼前这一关先糊弄过去，嘴上答应，心里盘算着怎么脱身。代价是欠下了一份更难还的人情。',
    tone: '谨慎', tension_delta: 0.05,
  },
  {
    title: '当场顶回去',
    description: '把话挑明，不给对方留台阶。当场会痛快，但从此这条路上多了一个记恨你的人。',
    tone: '激进', tension_delta: 0.3,
  },
  {
    title: '问一句为什么',
    description: '不接招也不翻脸，只把问题抛回去，逼对方先交代他真正的目的。',
    tone: '智取', tension_delta: 0.1,
  },
];

function summarizeScene(state) {
  if (!state || typeof state !== 'object') return '';
  const bits = [];
  if (state.time) bits.push(`时间：${state.time}`);
  if (state.location) bits.push(`地点：${state.location}`);
  if (state.weather) bits.push(`天气：${state.weather}`);
  if (typeof state.tension === 'number') bits.push(`紧张度：${state.tension.toFixed(2)}`);
  if (state.characters && typeof state.characters === 'object') {
    const chars = Object.entries(state.characters)
      .map(([name, c]) => `${name}（${c?.mood || '情绪不明'}@${c?.location || '去向不明'}）`)
      .join('、');
    if (chars) bits.push(`人物：${chars}`);
  }
  if (state.last_hook) bits.push(`上一幕钩子：${state.last_hook}`);
  return bits.join('；');
}

function tryParseJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* 落到打捞 */ }
  }
  return null;
}

function escapeRawControlCharsInStrings(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : code === 0x09 ? '\\t'
          : `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

function salvageArrayOfObjects(text, key) {
  const ki = text.indexOf(`"${key}"`);
  if (ki < 0) return [];
  const bi = text.indexOf('[', ki);
  if (bi < 0) return [];
  const out = [];
  let arrDepth = 0;
  let objDepth = 0;
  let start = -1;
  for (let i = bi; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') arrDepth++;
    else if (ch === ']') {
      arrDepth--;
      if (arrDepth === 0) break;
    } else if (ch === '{') {
      objDepth++;
      if (objDepth === 1 && arrDepth === 1 && start < 0) start = i;
    } else if (ch === '}') {
      objDepth--;
      if (objDepth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* 残缺对象跳过 */ }
        start = -1;
      }
    }
  }
  return out;
}

function sanitizeBranch(b) {
  if (!b || typeof b !== 'object') return null;
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (!description) return null;
  const rawTitle = typeof b.title === 'string' ? b.title.trim() : '';
  const title = (rawTitle || description).slice(0, 12);
  const tone = BRANCH_TONES.includes(b.tone) ? b.tone : '谨慎';
  const td = Number(b.tension_delta);
  const tension_delta = Number.isFinite(td) ? Math.round(Math.max(-0.5, Math.min(0.5, td)) * 100) / 100 : 0.1;
  return { id: '', title, description, tone, tension_delta };
}

function reindex(list) {
  return list.map((b, i) => ({ ...b, id: `b${i + 1}` }));
}

function parseBranchPayload(content) {
  const text = typeof content === 'string' ? escapeRawControlCharsInStrings(content) : '';
  const parsed = tryParseJson(text);
  let rawList = parsed && Array.isArray(parsed.branches) ? parsed.branches : [];

  if (rawList.length === 0 && text.trim()) {
    rawList = salvageArrayOfObjects(text, 'branches')
      .filter((o) => o && typeof o === 'object' && (typeof o.title === 'string' || typeof o.description === 'string'));
  }

  let branches = rawList.map(sanitizeBranch).filter(Boolean).slice(0, 4);

  if (branches.length < 3) {
    for (const fb of FALLBACK_BRANCHES) {
      if (branches.length >= 3) break;
      if (!branches.some((b) => b.title === fb.title)) branches.push({ ...fb });
    }
  }
  branches = reindex(branches);

  let scene_summary = parsed && typeof parsed.scene_summary === 'string' ? parsed.scene_summary.trim() : '';
  return { branches, scene_summary };
}

/**
 * 运行分支 Agent（非流式）。
 * @returns {Promise<{branches, scene_summary, usage}>}
 */
export async function runBranchAgent({
  world, state, recentNarrative, present, sceneSheet, craft = null, options = {}, signal,
} = {}) {
  const sceneSummary = summarizeScene(state);

  const messages = [
    { role: 'system', content: branchSystemPrompt(world, { pacing: craft?.pacingBranch || null }) },
    {
      role: 'user',
      content: branchUserPrompt({
        sceneSummary, lastNarrative: recentNarrative || '', state, present, sceneSheet,
      }),
    },
  ];

  let content = '';
  let usage = null;
  try {
    const res = await chat({
      agent: 'branch',
      messages,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort,
      model: options.model,
      responseFormat: { type: 'json_object' },
      signal,
    });
    content = res.content;
    usage = res.usage ?? null;
  } catch (err) {
    console.warn(`[branch] LLM 调用失败，降级为通用选项：${err?.message || err}`);
  }

  const parsed = parseBranchPayload(content);
  return {
    branches: parsed.branches,
    scene_summary: parsed.scene_summary || sceneSummary,
    usage,
  };
}
