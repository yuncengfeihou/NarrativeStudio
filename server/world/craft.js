/**
 * server/world/craft.js — 演绎工艺层（纯函数 + 常量，不建表、不读库）
 *
 * 这里放的是「怎么写」，与世界卡（写什么）严格分工：
 *   世界卡：这个世界有什么、角色是谁、这部作品特有的措辞与禁忌（`prompt.style_guide` / `bans`）
 *   工艺层：通用的叙事工艺——底线、文风取向、对白形态、推进尺度、结尾落点、构思清单
 *
 * 为什么不照抄 SillyTavern 的预设包：那三份预设里 40% 内容互相重叠，还有两处
 * 直接互斥（短句 vs 长句），并且每包都混着与叙事质量无关的破甲层。所以这里
 * 拆成**可单选的轴**，每轴只取一份，取值是明确的命名常量而不是整包文本。
 *
 * 三条硬约束（违反就不是工艺层了）：
 *   1. 不含任何越狱/破甲/防拒答内容——那是与剧情质量无关的一层。
 *   2. 不引入关键词触发、词条库、优先级、递归扫描（§1.1 红线 1）。
 *   3. 优先级恒定：世界卡 > 工艺预设 > 程序默认。卡里的 `bans` 永远压过这里的一切。
 *
 * 落点全部在既有函数里，不新增注入通道（§1.2 红线 2）：
 *   buildContract()            ← 底线 + 文风 + 对白 + 时间流速   （system）
 *   narratorTailInstruction()  ← 推进尺度 + 结尾落点             （current 尾注）
 *   branchSystemPrompt()       ← 推进尺度（与 narrator 共读一个值）
 *   segmentedInstruction()     ← 构思清单                        （固定尾部 user）
 *   renderCastLine()           ← 人物声音 exemplars/lexicon/values（场记单）
 */

import { estimateTokens } from '../tokens.js';

/** 所有轴的取值白名单。会话 settings 里的值不在这张表里就回退默认，不静默生效。 */
export const CRAFT_AXES = Object.freeze({
  preset: Object.freeze(['default', 'light', 'literary', 'webnovel', 'gufeng', 'plain']),
  dialogue: Object.freeze(['default', 'separated', 'long']),
  pacing: Object.freeze(['steady', 'adventurous', 'bold']),
});

/**
 * 轴的界面元数据（标签 / 说明 / 对应的会话 settings 键）。
 *
 * 存在的唯一理由：**取值清单只能有一个主人**。前端曾自己抄了一份选项列表，
 * 结果是「后端加了预设、前端还显示旧选项」，用户点旧选项被 pick() 静默回退成默认——
 * 看起来选中了、其实没生效。现在前端一律读 craftCatalog()，不再手写清单。
 */
const AXIS_META = Object.freeze({
  preset: {
    key: 'craft_preset',
    label: '文风取向',
    hint: '卡的「文风」里写了内容时，以卡为准，这里只兜底。',
  },
  dialogue: { key: 'craft_dialogue', label: '对白形态', hint: '' },
  pacing: {
    key: 'pacing',
    label: '推进尺度',
    hint: '同时作用于正文与「走向」选项，保证选项的风险水位与正文一致。',
  },
});

/**
 * 前端渲染「演绎工艺」抽屉所需的全部数据（含每个取值的标签与一句话说明）。
 *
 * @returns {{axes: Array<{key:string, axis:string, label:string, hint:string,
 *   default:string, options:Array<{value:string, label:string, desc:string}>}>}}
 */
export function craftCatalog() {
  const sources = { preset: STYLES, dialogue: DIALOGUES, pacing: PACINGS };
  return {
    axes: Object.keys(CRAFT_AXES).map((axis) => {
      const meta = AXIS_META[axis];
      const table = sources[axis];
      return {
        axis,
        key: meta.key,
        label: meta.label,
        hint: meta.hint,
        default: DEFAULT_CRAFT[axis],
        options: CRAFT_AXES[axis].map((value) => ({
          value,
          label: (table[value] || {}).name || value,
          desc: (table[value] || {}).desc || '',
        })),
      };
    }),
  };
}

export const DEFAULT_CRAFT = Object.freeze({
  preset: 'default',
  dialogue: 'default',
  pacing: 'adventurous',
});

/**
 * 通用底线：常驻，不可选，不属于任何一份预设。
 *
 * 这几条是三份预设里唯一高度一致、且与叙事质量直接相关的部分：
 * 冰山原则、正向叙事、不重复设定、契诃夫之枪、活人感、不替玩家决定。
 * 它们替代了旧契约里「不要总结、不要预告」之外那些零散的同义提醒——
 * 是**替换**，不是在其上再叠一层。
 */
const FLOOR = [
  '只给证据，不写判决：情绪、动机、关系不直接解释。用动作、对白、物件、身体反应让读者自己得出结论。',
  '正向叙述：写存在的东西（动作、观察、变化）。不用否定句定义人物——不写「他没有哭」「不是害怕，而是……」「与其说……不如说……」。',
  '不复述设定：上一段已写过的称谓、身份、外貌，这一段不再重复；设定通过人物言行与旁人反应体现，不用旁白朗读。',
  '写下来的都要起作用：反复出现的物件、习惯、细节，必须在情节、关系或情绪里兑现。不要用形容词和比喻做装饰。',
  '角色有自己的第一反应：反应来自他的性格、处境与底线，不是来自「剧情需要他这样」。允许心口不一，允许误解、记错、说不出口。',
  '不替玩家做决定：主角的行动由玩家给。可以有身体反应与外界变化，但不替他选择、表态、说出决定性的话。',
  '名词一次定义、终身一致：人名、地名、称谓、器物名不得漂移或改写。',
];

/**
 * 时间流速：常驻。
 * 篇幅长不等于过了很久——这一条治的是「每一拍都只过去五分钟」和
 * 「为了凑字数把等待走路吃饭逐分钟演一遍」两种相反的毛病。
 */
const TIME = '文字长不等于时间过去了很久。按事情实际要花的时间推进：一句话可以跨过一夜，一场对峙可以只过去十秒。'
  + '需要跳时间就直接跳到下一个有意义的时刻，不为凑字去演等待、走路、吃饭；反过来，关键时刻不加速。';

/**
 * 文风取向：单选。
 *
 * 每一份给的是**可判定的写法**（句长、对白密度、意象密度、内心处理），
 * 不是「请写得更有张力」这类无法验收的形容词。卡的 `style_guide` 永远压过这里。
 */
const STYLES = Object.freeze({
  default: {
    name: '默认（不额外指定）',
    // 界面副标题：一句话说清「选它会怎样」，供前端渲染，不进提示词。
    desc: '只留通用底线',
    text: '',
  },
  light: {
    name: '轻喜剧·快节奏',
    desc: '短句、对白密、语气轻',
    text: '短句为主，句均不长；对白密度高，叙述让位于对话。允许主角视角的短促吐槽，但不写成段内心独白。'
      + '环境描写只给推动这一拍的那一两个细节，不铺陈。整体语气偏轻松，冲突也用轻的方式写。',
  },
  literary: {
    name: '文学·细腻留白',
    desc: '句长有变化、感官密、多留白',
    text: '句长有变化，允许长句与从句；感官密度高，用具体的物与身体感觉承载情绪。'
      + '多留白：把解释删掉，让动作与停顿承担意义。比喻要新、要贴此刻，禁止「某种/说不出/难以名状」。'
      + '不写成段心理分析，情绪用可见的行为外化。',
  },
  webnovel: {
    name: '网文·强推进',
    desc: '段短、钩子密、冲突直接',
    text: '段落短，每段都要有信息或推进，不写原地打转的过渡段。钩子密：每一段末尾留一个让人想看下一段的点。'
      + '对白带信息量与立场，少大段内心。冲突直接、代价明确、不拖。',
  },
  gufeng: {
    name: '古风·克制',
    desc: '半文半白、称谓讲究、不用现代词',
    text: '半文半白，句子偏短，用文言虚词但不用生僻典故。称谓、礼数、身份称呼讲究且前后一致。'
      + '不用现代口语与网络词。情绪克制，重动作、器物与礼节。写景用古典意象但不堆砌。',
  },
  plain: {
    name: '白描·冷硬',
    desc: '几乎无形容词、只写动作与事实',
    text: '几乎不用形容词与比喻。只写动作、对白与可观察的事实，句子极短。'
      + '不写内心、不写解释、不写判断。留白靠不写，而不是靠抒情。',
  },
});

/** 对白形态：单选。 */
const DIALOGUES = Object.freeze({
  default: { name: '默认', desc: '不做额外要求', text: '' },
  separated: {
    name: '对白独立成段',
    desc: '叙述和对白不挤在同一段',
    text: '对白独立成段：一段里只有对白，不把对白和叙述挤在同一段。',
  },
  long: {
    name: '长对白',
    desc: '不为了短把话切碎',
    text: '允许长对白：人物可以把一件事一口气说完，不为了「短」把话切碎。',
  },
});

/**
 * 推进尺度：每拍可换（会话 settings.pacing，或本拍 directive）。
 *
 * 它在尾注（最贴近生成点）与走向 Agent 里共读同一个值：
 * narrator 推多少、branch 给多险的选项，必须同尺度，否则会出现
 * 「选项都是温和日常、正文却突然翻盘」的错位。
 */
const PACINGS = Object.freeze({
  steady: {
    name: '保守',
    desc: '只推一小步，不引入新事件',
    tail: '这一拍只推进一小步：把情势推到需要有人回应的位置就停。不引入新的外部事件，不让人物做出改变局势的决定。',
    branch: '走向按「保守」给：多数是观察、试探、等待、关系上的小位移，最多一条带风险。',
  },
  adventurous: {
    name: '正常',
    desc: '局势可以有变化',
    tail: '这一拍正常推进一幕：局势可以有变化，有人可以做出决定，新信息可以进来。但不要跳到结局，也不要把这一场收束掉。',
    branch: '走向按「正常」给：至少一条有明确代价或风险，其余可以是日常、关系推进或把时间推过去。',
  },
  bold: {
    name: '激进',
    desc: '允许意外与明显转折，代价要落到人身上',
    tail: '这一拍可以让意外发生、让关系或局势明显转折，代价要真的落到人身上。仍然不替主角做决定，也不替玩家收场。',
    branch: '走向按「激进」给：允许多条高风险、强对抗、可能伤到人的选项；不要为了稳而把选项写软。',
  },
});

/** 结尾落点：常驻，进尾注。治「每拍结尾都在升华 / 抛二选一 / 等玩家回应」。 */
const ENDING = '结尾用在场者的动作、台词或一个未完成的场景收住：不升华、不总结、不预告，不抛「你会怎么做」这类二选一提问，'
  + '也不特意强调有人在等玩家回应。';

/**
 * 构思清单：分段演绎专用（关掉也无损单发模式）。
 * 取三份预设里可压缩的那几条，压成 4 问——它只在分段模式的循环里出现，
 * 不占层预算、不进 system。
 */
export const CRAFT_CHECKLIST = [
  '这一拍谁会先动，他为什么现在动（不是「剧情需要」）？',
  '听到这句话的人，第一反应和真正说出口的话是不是一回事？',
  '这一段里哪个具体的物/动作在替情绪说话？没有就换一个，不要加形容词。',
  '结尾那一句是不是停在情势里，而不是总结或提问？',
].map((q, i) => `${i + 1}. ${q}`).join('\n');

/** 该轴的合法取值；非法值回退默认（不静默生效，由调用方读 meta 发现）。 */
function pick(axis, value) {
  const allowed = CRAFT_AXES[axis];
  return allowed.includes(value) ? value : DEFAULT_CRAFT[axis];
}

/**
 * 写入会话 settings 前的归一：非法值回退默认，不留脏值。
 *
 * 放在这里而不是路由里，是因为「哪些取值合法」的唯一主人是 `CRAFT_AXES`。
 * 曾经这段逻辑只存在于一条路由（`POST /api/sessions`），另一条开局路由
 * （`POST /api/worlds/:id/sessions`）绕过它——于是从世界卡页开局时工艺设置
 * 既不校验也不填默认，看起来「每开一局都回默认」。
 *
 * @param {object} settings
 * @param {{fill?:boolean}} [opts] fill=true 时把缺省的轴也补成默认（开局用）；
 *   false 时只校验已给的键，避免用户只想改 pacing 却把另两轴一并写死。
 */
export function normalizeCraftSettings(settings, { fill = false } = {}) {
  const s = { ...(settings || {}) };
  const fixed = {
    craft_preset: ['preset', DEFAULT_CRAFT.preset],
    craft_dialogue: ['dialogue', DEFAULT_CRAFT.dialogue],
    pacing: ['pacing', DEFAULT_CRAFT.pacing],
  };
  for (const [key, [axis, def]] of Object.entries(fixed)) {
    if (s[key] === undefined) { if (fill) s[key] = def; continue; }
    s[key] = pick(axis, s[key]);
  }
  return s;
}

/**
 * 从一组会话 settings 里摘出三个工艺轴（含非法值归一）。
 * 用于「同一张卡再开一局时继承上一局的写法」——只搬这三项，
 * 不搬温度/预算/指令等其余会话参数。
 *
 * @returns {{craft_preset:string, craft_dialogue:string, pacing:string}}
 */
export function pickCraftSettings(settings) {
  const s = settings || {};
  return {
    craft_preset: pick('preset', s.craft_preset),
    craft_dialogue: pick('dialogue', s.craft_dialogue),
    pacing: pick('pacing', s.pacing),
  };
}

/**
 * 解析会话的工艺配置。
 *
 * @param {object} [settings] 会话 settings（可缺省）
 * @param {{preset?:string, dialogue?:string, pacing?:string}} [overrides] 本拍覆盖（directive 级）
 * @returns {{preset:string, style:object, dialogue:string, dialogueText:string, pacing:string,
 *   pacingText:string, pacingBranch:string, floor:string, time:string, ending:string, name:string}}
 */
export function resolveCraft(settings = {}, overrides = {}) {
  const s = settings || {};
  const o = overrides || {};
  const preset = pick('preset', o.preset ?? s.craft_preset);
  const dialogue = pick('dialogue', o.dialogue ?? s.craft_dialogue);
  const pacing = pick('pacing', o.pacing ?? s.pacing);
  const style = STYLES[preset] || STYLES.default;
  return {
    preset,
    name: style.name,
    style: { id: preset, name: style.name, text: style.text },
    dialogue,
    dialogueText: (DIALOGUES[dialogue] || DIALOGUES.default).text,
    pacing,
    pacingText: (PACINGS[pacing] || PACINGS.adventurous).tail,
    pacingBranch: (PACINGS[pacing] || PACINGS.adventurous).branch,
    floor: FLOOR.map((r, i) => `${i + 1}. ${r}`).join('\n'),
    time: TIME,
    ending: ENDING,
  };
}

/**
 * 渲染 system 层的工艺块（底线 + 文风 + 对白 + 时间流速）。
 *
 * 取舍规则：**通用底线是硬保留**，其余按 `time → style → dialogue` 的优先级整条丢，
 * 绝不留半句。之所以允许丢：世界索引是 canon，工艺是可选的表达层——
 * 挤掉索引换文风是错的。反之底线不能丢：它是「怎么写」的最后防线，
 * 丢了就等于整块工艺没接上，只留一些风格形容词反而更糟。
 *
 * 若 `capTokens` 小到连底线都放不下，仍保留底线，并在 meta 里记
 * `over_floor: true`——让调用方能看见「这里的上限给错了」，而不是静默降级成没有底线。
 *
 * @returns {{text:string, meta:{preset:string, style:string, dialogue:string, tokens:number,
 *   dropped:string[], capped:boolean, over_floor:boolean}}}
 */
export function renderCraftBlock(craft, { capTokens = 1800, includeStyle = true } = {}) {
  const parts = [];
  if (craft.floor) parts.push({ key: 'floor', text: `【怎么写】这些是通用底线，任何场景下都成立。\n${craft.floor}` });
  if (includeStyle && craft.style?.text) parts.push({ key: 'style', text: `【文风取向·${craft.style.name}】${craft.style.text}` });
  if (craft.dialogueText) parts.push({ key: 'dialogue', text: `【对白形态】${craft.dialogueText}` });
  if (craft.time) parts.push({ key: 'time', text: `【时间流速】${craft.time}` });

  const floor = parts.find((p) => p.key === 'floor');
  const floorCost = floor ? estimateTokens(floor.text) + 2 : 0;
  const floorOver = Boolean(floor) && floorCost > capTokens;
  const remaining = Math.max(0, capTokens - floorCost);

  const dropped = [];
  const keep = floor ? [floor] : [];
  let used = floorCost;
  // 取舍顺序即优先级：时间流速短且价值高，然后才轮到文风与对白。
  for (const key of ['time', 'style', 'dialogue']) {
    const p = parts.find((x) => x.key === key);
    if (!p) continue;
    const cost = estimateTokens(p.text) + 2;
    if (used - floorCost + cost <= remaining) { keep.push(p); used += cost; continue; }
    dropped.push(key);
  }
  // 输出顺序保持「底线 → 文风 → 对白 → 时间流速」的阅读顺序，但取舍按上面的优先级。
  const text = ['floor', 'style', 'dialogue', 'time']
    .map((k) => keep.find((p) => p.key === k))
    .filter(Boolean)
    .map((p) => p.text)
    .join('\n\n');
  return {
    text,
    meta: {
      preset: craft.preset,
      style: craft.style?.name || '',
      dialogue: craft.dialogue,
      tokens: used,
      dropped,
      capped: dropped.length > 0 || floorOver,
      // 上限小到连底线都放不下：仍保留底线，但把「这里的预算给错了」暴露出来。
      over_floor: floorOver,
    },
  };
}
