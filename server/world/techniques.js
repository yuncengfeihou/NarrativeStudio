/**
 * 技法库：按需学习的「怎么写」条目。
 *
 * 它与 `craft.js` 的分工：
 *   - `craft.js` 是**作者选的**风格（文风取向 / 对白形态 / 推进尺度），装配进 system，
 *     会话内恒定（缓存前缀的一部分）。
 *   - 这里是**模型自己决定要不要学**的具体写法：一次只取 1–2 条，结果只进当拍的工具消息，
 *     当拍蒸发，不写库、不进 `turns`、不进下一拍 `recent`。
 *
 * 为什么不自动注入：红线 1——「要不要查」由模型判断，代码只做确定性检索。模型的 query
 * 是意图（「对白太直白」「时间不知道怎么跳」），代码只按标签/用途打分，不按正文措辞猜。
 *
 * 库本身是内置只读的通用写法，**不含任何世界卡内容**：它回答「怎么写」，不回答「发生了什么」。
 */

/** 单条技法正文上限（字符）。写长了对注意力是负收益，超了说明该拆成两条。 */
export const TECHNIQUE_TEXT_MAX = 120;
/** 一次最多返回几条。再多会挤占这一拍的正文预算。 */
export const TECHNIQUE_MATCH_MAX = 3;

/**
 * @typedef {{id:string, label:string, tags:string[], when:string, text:string}} Technique
 */

/** @type {Technique[]} */
export const TECHNIQUES = [
  {
    id: 'time-jump',
    label: '时间跳切',
    tags: ['时间', '过渡', '跳切', '推进', '拖沓'],
    when: '要推进时间却不必演完中间过程',
    text: '用一句过渡（「三天后」「等雨停时」）直接落在变化之后：先写结果，再让人物发现过程已经被跳过。',
  },
  {
    id: 'sensory-anchor',
    label: '感官锚定',
    tags: ['感官', '细节', '氛围', '环境', '空'],
    when: '场景发空、只剩对白和说明',
    text: '挑一个具体的物理细节（温度、重量、声音）贯穿整段，反复回到它，用它代替形容词式的氛围总结。',
  },
  {
    id: 'body-over-emotion',
    label: '身体代替情绪',
    tags: ['情绪', '心理', '内心', '表演'],
    when: '要写情绪但不想直说',
    text: '不写「他很难过」，写他做错了哪个动作：碗放偏了、话说一半停住、站起来却忘了下一步要做什么。',
  },
  {
    id: 'dialogue-subtext',
    label: '对白潜台词',
    tags: ['对白', '潜台词', '台词', '说话', '直白'],
    when: '对白太直白、像在交代信息',
    text: '让角色嘴上谈一件事、心里想另一件事：第一句答非所问，真正的诉求放在第二句里。',
  },
  {
    id: 'prop-pressure',
    label: '道具承压',
    tags: ['道具', '物件', '象征', '关系'],
    when: '想让关系变化有个可看的东西承载',
    text: '让一个具体物件在这一段里被使用、损坏或转手，用它的状态变化标出关系变化，不要用旁白说明。',
  },
  {
    id: 'silence-beat',
    label: '沉默节拍',
    tags: ['沉默', '节奏', '留白', '停顿', '余味'],
    when: '关键对白说完、还需要一下余味',
    text: '对白之后留一拍空白：写环境（风、雨、远处的声音）而不写人物反应；再回到人物时他已经变了。',
  },
  {
    id: 'witness',
    label: '第三者见证',
    tags: ['视角', '见证', '旁观', '配角'],
    when: '主角不方便自述关键瞬间',
    text: '让在场的一个次要角色看到它；他的沉默、转身或走开，可以替代主角自己解释发生了什么。',
  },
  {
    id: 'blocking',
    label: '空间调度',
    tags: ['空间', '走位', '调度', '距离', '权力'],
    when: '人物关系说不清、场面像浮在空中',
    text: '用位置写关系：谁站着谁坐着、谁背对门口、谁始终不进门；让走位在这一段里发生一次变化。',
  },
  {
    id: 'call-back',
    label: '旧细节回指',
    tags: ['伏笔', '回指', '呼应', '旧细节', '前文'],
    when: '想让前文的伏笔自然回来',
    text: '复用本局前文的一件具体小物或一句原话，让它在新的处境里再出现一次；不要解释它为什么重要。',
  },
  {
    id: 'partial-reveal',
    label: '半揭示',
    tags: ['信息', '揭示', '悬念', '隐瞒', '秘密'],
    when: '要让读者知道有东西被瞒着',
    text: '让角色说出一半事实就停下（被打断、改口、或转去说别的），把读者留在「知道有问题、不知道是什么」的位置。',
  },
  {
    id: 'cost-first',
    label: '代价先于选择',
    tags: ['选择', '代价', '决定', '抉择'],
    when: '角色要做重要决定',
    text: '先把代价亮出来（要失去什么、谁不会再等他），决定才有重量；不要让他先选完再补代价。',
  },
  {
    id: 'open-with-motion',
    label: '动作开场',
    tags: ['开头', '开场', '入戏', '铺陈'],
    when: '这一段开头像在铺陈',
    text: '从中段写起：不写「他站起来」，直接写他已经在做的动作和它造成的后果。',
  },
  {
    id: 'voice-diff',
    label: '声线区分',
    tags: ['声线', '人物', '口吻', '区分', '一样'],
    when: '几个人说话听起来一样',
    text: '给每个说话者一个固定的说话习惯（只用短句、总用反问、称谓特殊），靠习惯区分人，不靠在名字后面加形容词。',
  },
  {
    id: 'close-hook',
    label: '收尾留钩',
    tags: ['收尾', '结尾', '钩子', '断点', '太满'],
    when: '这一段收得太满、什么都解释完了',
    text: '停在「刚发生但还没解释」的一件小事上；不要停在感叹、总结或人物心情上。',
  },
  {
    id: 'no-recap',
    label: '防复述',
    tags: ['复述', '重复', '原地', '回放'],
    when: '玩家行动与上一拍重复、容易写成回放',
    text: '不复述上一拍的动作顺序；把镜头移到别人的反应、环境的变化或一件新的具体事上。',
  },
];

/**
 * 打分权重：标签和用途是模型的意图词，标签名更像「这一条叫什么」，正文不参与打分。
 * `when` 给 2：模型常常直接说「场景发空」「收尾太满」，那正是 `when` 的措辞。
 */
const FIELD_WEIGHT = { label: 3, tags: 2, when: 2, id: 2 };
/** 低于这个分数不返回：宁可不给，也不要给一条不相关的写法（会变成噪音）。 */
const MIN_SCORE = 2;
/**
 * 纯功能性的高频二字组不进匹配：不删它们的话，「时间不知道怎么跳」会因为
 * 「不知道」命中「半揭示」的 when，把一条无关技法塞进这一拍。
 */
const STOP_TOKENS = new Set(['不知', '知道', '怎么', '什么', '这一', '那一', '一个', '可以', '我们', '他们', '自己', '时候', '一点', '有些']);

/** 把 query 切成用于匹配的片段：CJK 连续段取二字组 + 拉丁词（≥2 字符）。 */
function techniqueTokens(query) {
  const raw = String(query || '').toLowerCase();
  const tokens = new Set();
  for (const run of raw.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) {
      if (!STOP_TOKENS.has(run)) tokens.add(run);
    }
    for (let i = 0; i + 2 <= run.length; i++) {
      const bi = run.slice(i, i + 2);
      if (!STOP_TOKENS.has(bi)) tokens.add(bi);
    }
  }
  for (const w of raw.match(/[a-z][a-z0-9_-]{1,}/g) || []) tokens.add(w);
  return [...tokens];
}

/**
 * 按 query 的意图词给技法打分。纯函数：同样输入永远同样输出（同分按 id 排，保证可复现）。
 * 没有任何命中时返回空数组——调用方据此**不注入任何内容**（不是返回「最接近的一条」）。
 */
export function rankTechniques(query, { limit = 2 } = {}) {
  const tokens = techniqueTokens(query);
  const max = Math.max(1, Math.min(TECHNIQUE_MATCH_MAX, Number(limit) || 2));
  if (!tokens.length) return [];
  const scored = [];
  for (const t of TECHNIQUES) {
    let score = 0;
    for (const [field, weight] of Object.entries(FIELD_WEIGHT)) {
      const hay = field === 'tags' ? (t.tags || []).join(' ') : String(t[field] || '');
      const low = hay.toLowerCase();
      if (!low) continue;
      for (const tok of tokens) if (low.includes(tok)) score += weight;
    }
    if (score >= MIN_SCORE) scored.push({ ...t, score });
  }
  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  return scored.slice(0, max);
}

/** 渲染成给模型看的工具结果。只列 label / when / text，不带内部 id 与分数。 */
export function renderTechniques(entries, query = '') {
  if (!entries?.length) {
    return `未匹配到与「${query}」相关的技法。按你现在的判断写，不要为了套技法改变这一拍的内容。`;
  }
  const lines = [`【技法检索：${query}】`];
  for (const t of entries) {
    lines.push(`- ${t.label}（${t.when}）：${t.text}`);
  }
  lines.push('技法只约束写法，不改变这一拍发生什么；用不上就不套。');
  return lines.join('\n');
}
