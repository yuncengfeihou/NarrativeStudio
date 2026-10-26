/**
 * longrun-audit.mjs — 长跑回合的离线审计（只读 DB，不调模型、不改数据）。
 *
 * 用途：真实浏览器长跑结束后，回答「这一局到底发生了什么」：
 *   1) 体量与时序     逐轮字数、场景数、故事内时间/地点跨度
 *   2) 预算与召回     装配 plan/budget/coverage/index 与「正文实际点名率」
 *   3) 节奏            分支 tone / tension_delta 分布、玩家行动来源、结尾是否公式化
 *   4) 重复与越界      母题轮数、敏感词命中（悬念是否被提前揭底）
 *   5) 记忆落库        assertions/relations/threads/voices/patches 计数
 *
 * 注意：`meta.recall` 是「整轮 messages 里卡内实体名字的可见率」，世界索引会把
 * 全部实体名塞进 system，因此它恒为 100%——它衡量索引完整性，不衡量叙事是否用到卡。
 * 本脚本另算 `narrative 点名率`（实体名是否出现在 turns 正文里），那才是叙事覆盖。
 *
 * 用法：
 *   node _work/longrun-audit.mjs <session_id>
 *   node _work/longrun-audit.mjs <session_id> --db data/roleplay.db --max-lines 400
 */

import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
if (!sessionId) {
  console.error('usage: node _work/longrun-audit.mjs <session_id> [--db data/roleplay.db]');
  process.exit(2);
}
const dbPath = opt('db', 'data/roleplay.db');

const db = new DatabaseSync(dbPath, { readOnly: true });
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const h = (s) => `\n${'═'.repeat(12)} ${s} ${'═'.repeat(12)}`;

try {
  const session = db.prepare('select * from sessions where id = :id').get({ id: sessionId });
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }
  const turns = db.prepare(
    'select turn_no, kind, content, branch_choice_json, meta_json, usage_json, token_count from turns where session_id = :sid order by turn_no'
  ).all({ sid: sessionId });
  const narr = turns.filter((t) => t.kind === 'narrator');
  const players = turns.filter((t) => t.kind === 'player');
  const scenes = db.prepare('select * from scenes where session_id = :sid order by turn_from').all({ sid: sessionId });
  const settings = safeJson(session.settings_json);
  const card = safeJson(session.card_snapshot_json);
  const usage = safeJson(session.usage_json);

  /* ── 1. 体量与时序 ── */
  const lens = narr.map((t) => (t.content || '').length);
  const totalChars = lens.reduce((a, b) => a + b, 0);
  const sorted = [...lens].sort((a, b) => a - b);
  console.log(h('1. 体量与时序'));
  console.log(`session      ${session.id}`);
  console.log(`title        ${session.title}｜world ${settings.world_id || '?'}`);
  console.log(`回合         turn_count=${session.turn_count}｜turns 行 ${turns.length}（player ${players.length} / narrator ${narr.length}）`);
  if (narr.length) {
    const pctile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
    const buckets = [0, 500, 1000, 1600, 2600, Infinity];
    const dist = [];
    for (let i = 0; i < buckets.length - 1; i++) {
      const lo = buckets[i];
      const hi = buckets[i + 1];
      dist.push(`${lo}-${hi === Infinity ? '∞' : hi}:${lens.filter((n) => n >= lo && n < hi).length}`);
    }
    console.log(`正文         总 ${totalChars} 字｜均 ${Math.round(totalChars / narr.length)}｜最短 ${sorted[0]}｜中位 ${sorted[Math.floor(sorted.length / 2)]}｜最长 ${sorted[sorted.length - 1]}`);
    console.log(`字数分位     p25=${pctile(0.25)} p50=${pctile(0.5)} p75=${pctile(0.75)} p90=${pctile(0.9)}`);
    console.log(`字数分布     ${dist.join(' · ')}`);
  }
  const places = [...new Set(scenes.map((s) => s.place).filter(Boolean))];
  const whens = [...new Set(scenes.map((s) => s.when_label).filter(Boolean))];
  const whenSeq = scenes.map((s) => s.when_label).filter(Boolean);
  const whenChanges = whenSeq.slice(1).filter((w, i) => w !== whenSeq[i]).length;
  console.log(`场景         ${scenes.length} 场｜地点 ${places.length} 个｜时间标签 ${whens.length} 种`);
  console.log(`时间推进     when 标签变化 ${whenChanges} 次（相邻场时间不同即算一次）`);
  for (const s of scenes) {
    const hooks = safeJson(s.hooks_json);
    console.log(`  ${s.scene_id} t${s.turn_from}-${s.turn_to} ${s.when_label || '—'} @ ${s.place || '—'}` +
      `｜${s.importance || '—'}` +
      (Array.isArray(hooks) && hooks.length ? `｜hooks ${hooks.length}` : ''));
  }
  console.log('  时间标签序列：' + whens.join(' → '));

  /* ── 2. 预算与召回 ── */
  console.log(h('2. 装配预算与实体覆盖'));
  const lastMeta = safeJson(narr[narr.length - 1]?.meta_json);
  const firstMeta = safeJson(narr[0]?.meta_json);
  const asm = lastMeta.assembly || {};
  const asm0 = firstMeta.assembly || {};
  const budgetTotals = narr
    .map((t) => safeJson(t.meta_json).assembly?.budget?.total || 0)
    .filter((n) => n > 0);
  console.log(`plan         window=${asm.plan?.window} hard_max=${asm.plan?.hard_max} soft_max=${asm.plan?.soft_max} ` +
    `layers=${JSON.stringify(asm.plan?.layers || {})}`);
  console.log(`budget 首/末 ${asm0.budget?.total || '—'} → ${asm.budget?.total || '—'}｜峰值 ${Math.max(0, ...budgetTotals)}`);
  console.log(`末轮分层    ${JSON.stringify(asm.budget || {})}`);
  console.log(`index        rendered=${asm.index?.rendered}/${asm.index?.total} dropped=${asm.index?.dropped} tokens=${asm.index?.tokens} mode=${asm.index?.mode}`);
  console.log(`coverage     ${JSON.stringify(asm.coverage || {})}`);
  console.log(`recall(装配) ${JSON.stringify(asm.recall || {})}  ← 索引饱和口径，见文件头注释`);
  const droppedTurns = narr.filter((t) => (safeJson(t.meta_json).assembly?.dropped_sections || []).length).length;
  const degradedTurns = narr.filter((t) => {
    const d = safeJson(t.meta_json).assembly?.degraded;
    return Array.isArray(d) ? d.length > 0 : Boolean(d);
  }).length;
  console.log(`降级         dropped_sections=${droppedTurns} 轮｜degraded=${degradedTurns} 轮`);

  if (card?.entities?.length) {
    const text = narr.map((t) => t.content || '').join('\n');
    const byType = {};
    let hit = 0;
    const neverNamed = [];
    for (const e of card.entities) {
      byType[e.type] = byType[e.type] || { hit: 0, total: 0 };
      byType[e.type].total += 1;
      const forms = [e.name, ...(e.aliases || [])].filter(Boolean);
      const found = forms.some((f) => f.length > 1 && text.includes(f));
      if (found) { hit += 1; byType[e.type].hit += 1; } else if (e.type === 'person') neverNamed.push(e.name);
    }
    console.log(`叙事点名     ${hit}/${card.entities.length}（${pct(hit, card.entities.length)}）｜${JSON.stringify(byType)}`);
    if (neverNamed.length) console.log(`未登场角色   ${neverNamed.length} 人：${neverNamed.slice(0, 20).join('、')}${neverNamed.length > 20 ? ' …' : ''}`);

    // 按卡自带 weight 分档统计覆盖率：分档不是新字段，只是给已有 weight 一个可读口径。
    // high = 作者/制卡标出的主线级人物（weight ≥ 0.8）。
    const tiers = { high: { hit: 0, total: 0 }, mid: { hit: 0, total: 0 }, low: { hit: 0, total: 0 } };
    const tierHits = (e) => [e.name, ...(e.aliases || [])]
      .filter((f) => f && String(f).length > 1).some((f) => text.includes(f));
    for (const e of card.entities.filter((x) => x.type === 'person')) {
      const t = Number(e.weight) >= 0.8 ? 'high' : Number(e.weight) >= 0.5 ? 'mid' : 'low';
      tiers[t].total += 1;
      if (tierHits(e)) tiers[t].hit += 1;
    }
    const tierText = Object.entries(tiers)
      .map(([k, v]) => `${k} ${v.hit}/${v.total}`).join('｜');
    console.log(`分档点名     ${tierText}（high=weight≥0.8）`);
  }

  /* ── 3. 节奏：分支与结尾 ── */
  console.log(h('3. 节奏：走向与结尾'));
  const tones = new Map();
  const tds = [];
  let copied = 0;
  let gamble = 0;
  let risk = 0;
  let calm = 0;
  const RISK_TONES = new Set(['激进', '智取', '诡道', '探索']);
  for (const p of players) {
    const c = safeJson(p.branch_choice_json);
    if (c && c.title) {
      tones.set(c.tone || '(none)', (tones.get(c.tone || '(none)') || 0) + 1);
      if (RISK_TONES.has(c.tone)) risk += 1; else calm += 1;
      if (typeof c.tension_delta === 'number') tds.push(c.tension_delta);
      if (c.description && String(p.content || '').trim() === String(c.description).trim()) copied += 1;
    }
    if (/赌/.test(String(p.content || ''))) gamble += 1;
  }
  const mean = tds.length ? tds.reduce((a, b) => a + b, 0) / tds.length : 0;
  console.log(`分支选择     ${tds.length}/${players.length} 轮有分支｜tones ${JSON.stringify([...tones.entries()].sort((a, b) => b[1] - a[1]))}`);
  // 只统计玩家实际选中的那条：生成出来的全部选项没有落库，不能在这里二次统计。
  console.log(`走向形态     冒险面 ${risk}｜日常/关系/时间面 ${calm}（选中项口径）`);
  console.log(`张力         mean=${mean.toFixed(3)}｜>0 ${tds.filter((x) => x > 0).length}｜<0 ${tds.filter((x) => x < 0).length}｜=0 ${tds.filter((x) => x === 0).length}｜范围 ${Math.min(...tds)}..${Math.max(...tds)}`);
  console.log(`玩家行动     含「赌」${gamble}/${players.length}｜= 分支描述原文 ${copied}/${players.length}`);
  let must = 0;
  let countdown = 0;
  for (const t of narr) {
    const tail = String(t.content || '').slice(-120);
    if (/必须立刻|必须在这|必须出声|必须决定|必须选择|必须给出|必须回应|该抽手|该选/.test(tail)) must += 1;
    if (/[一二三]声|[一二三]——|数到|倒数/.test(tail)) countdown += 1;
  }
  console.log(`结尾公式     含「必须…」${must}/${narr.length}｜含倒数/数声 ${countdown}/${narr.length}`);

  /* ── 4. 重复与越界 ── */
  console.log(h('4. 重复母题与越界探针'));
  const motifs = (card?.entities || []).length
    ? [...new Set([...((card.entities || []).filter((e) => e.type === 'person').map((e) => e.name)), ...((card.entities || []).filter((e) => e.type === 'item' || e.type === 'place').slice(0, 12).map((e) => e.name))])].slice(0, 20)
    : ['雨', '枪', '玉佩', '旧伤', '血'];
  const motifCount = Object.fromEntries(motifs.map((m) => [m, narr.filter((t) => String(t.content || '').includes(m)).length]));
  console.log(`母题轮数     ${JSON.stringify(motifCount)}`);
  const probes = ['七年前', '东街十五路', '真相', '秘密', '失忆', '吸干', '吸血', '系统', '金手指', '穿越', '作为AI', '本章', '字数'];
  const probeHit = {};
  for (const q of probes) probeHit[q] = narr.filter((t) => String(t.content || '').includes(q)).length;
  console.log(`探针轮数     ${JSON.stringify(probeHit)}`);

  /* ── 5. 记忆落库 ── */
  console.log(h('5. 记忆落库'));
  for (const t of ['scenes', 'assertions', 'character_states', 'world_state', 'voices', 'relations', 'threads', 'patches', 'effect_receipts', 'states']) {
    const r = db.prepare(`select count(*) c from ${t} where session_id = :sid`).get({ sid: sessionId });
    process.stdout.write(`${t}=${r.c}  `);
  }
  console.log();
  const patchKinds = db.prepare(
    'select agent, kind, status, count(*) c from patches where session_id = :sid group by agent, kind, status order by c desc'
  ).all({ sid: sessionId });
  if (patchKinds.length) console.log('patches      ' + patchKinds.map((p) => `${p.agent}/${p.kind}/${p.status}=${p.c}`).join(' · '));
  const assertStat = db.prepare('select status, count(*) c from assertions where session_id = :sid group by status').all({ sid: sessionId });
  if (assertStat.length) console.log('assertions   ' + assertStat.map((a) => `${a.status}=${a.c}`).join(' '));
  const threadStat = db.prepare('select status, count(*) c from threads where session_id = :sid group by status').all({ sid: sessionId });
  if (threadStat.length) console.log('threads      ' + threadStat.map((t) => `${t.status}=${t.c}`).join(' '));
  const tickThreads = db.prepare("select count(*) c from threads where session_id = :sid and note = '世界呼吸推演'").get({ sid: sessionId });
  console.log(`线索来源     世界呼吸写入 ${tickThreads.c} 条`);
  // 生命体征：life_state 是代码唯一能判定死亡/离场的字段。正文出现死亡表述却没有
  // dead/gone 写入，就是下一拍「死人还会开口」的风险（语义漂移的独立口径）。
  const lifeStates = db.prepare(
    "select value, count(*) c from character_states where session_id = :sid and field = 'life_state' group by value"
  ).all({ sid: sessionId });
  const lifeMap = Object.fromEntries(lifeStates.map((r) => [r.value, r.c]));
  const deathTurns = narr.filter((t) => /死|断气|咽气|身亡|离世|尸体|尸首/.test(String(t.content || '')));
  const deadWrites = (lifeMap.dead || 0) + (lifeMap.gone || 0);
  console.log(`生命体征     life_state ${lifeStates.length ? JSON.stringify(lifeMap) : '(无)'}｜正文含死亡表述 ${deathTurns.length} 轮｜dead/gone 写入 ${deadWrites} 行`);
  // 场外流言是否真的被后文接住：offstage_event 的 who 之后是否在旁白正文里再出现。
  const offstage = db.prepare(
    "select turn_no, payload_json from patches where session_id = :sid and kind = 'offstage_event' order by turn_no, id"
  ).all({ sid: sessionId });
  let cited = 0;
  for (const p of offstage) {
    const pl = safeJson(p.payload_json);
    const names = [].concat(pl.who || []).map(String).filter(Boolean);
    if (names.length && narr.some((t) => Number(t.turn_no) > Number(p.turn_no) &&
      names.some((w) => String(t.content || '').includes(w)))) cited += 1;
  }
  if (offstage.length) console.log(`场外事件     ${offstage.length} 条｜被后文正文点名 ${cited}（${pct(cited, offstage.length)}）`);

  /* ── 6. 用量 ── */
  console.log(h('6. 模型用量（session.usage_json）'));
  console.log(`总计         requests=${usage.requests} prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} ` +
    `cached=${usage.cached_tokens}（命中 ${pct(usage.cached_tokens || 0, usage.prompt_tokens || 0)}） total_ms=${usage.total_ms}`);
  if (usage.by_agent) {
    for (const [agent, u] of Object.entries(usage.by_agent)) {
      console.log(`  ${agent.padEnd(12)} req=${u.requests} prompt=${u.prompt_tokens} completion=${u.completion_tokens} cached=${u.cached_tokens}`);
    }
  }
  console.log();
} finally {
  db.close();
}

function safeJson(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}
