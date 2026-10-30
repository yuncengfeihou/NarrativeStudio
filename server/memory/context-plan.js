/**
 * server/memory/context-plan.js — 从「模型窗口」推导本轮上下文预算（纯函数）
 *
 * 旧实现是七个独立的 env 常量（BUDGET_SYSTEM=3400 等）。那些默认值是 32K 窗口
 * 时代拍的，换到 200K 窗口的模型后，它们把装配永久卡在 5–6K：每轮扔掉 95% 的
 * 可用窗口，而真正该省的是「不产生新信息」的重复，不是记忆载体。
 *
 * 现在只有一个输入：**这一轮能用多少提示词预算**（模型窗口 − 生成预留）。
 * 各层按职责比例分配（比例之和 = 1），并设下限，避免小窗口下某层被压没。
 *
 * 比例的设计目标是「记忆载体优先」：
 *   archive（场次索引）+ recent（逐字原文）拿 0.70 —— 长程与短程记忆；
 *   system 0.32（含世界索引）—— canon 与世界可见性（实体召回率）；
 *   scene 0.22（场记单）—— 本拍运行态；
 *   其余 0.16 给场次细节 / 检索 / 本轮输入。
 *
 * `recent` 是**规划上限**，不是截断阈值：装配层从不按 token 裁逐字原文（那是
 * 静默失忆）。它唯一的用途是决定「当前场该在多大时强制封场」——让原文窗口
 * 在场次记录接住之前，自己收敛到配额内（见 memory-pipeline 的 detectSceneChange）。
 *
 * 所有数字都只是软标准：装配器按优先级分配，超了先降易变尾部，再收窄历史；
 * 硬上限只作为安全网（fail-closed），不是日常策略。
 */
import { config } from '../config.js';
import { resolveAgent } from '../model-registry.js';

/** 各层占软目标的比例。和 = 1.00，改动前先想清楚「挤掉的是谁」。 */
const LAYER_SHARES = Object.freeze({
  system: 0.32,        // 契约 + 命题 + 宪章 + 世界索引 + 前史 + 主角（canon，冻结）
  archive: 0.30,       // 场次索引：一行一场、只追加（长程记忆载体）
  archiveDetail: 0.06, // 最近 1–2 场的细节
  recent: 0.40,        // 当前场逐字原文的规划上限（只用于强制封场，不裁原文）
  scene: 0.22,         // 场记单（运行态 + 辞书 + 关系 + 知识边界）
  retrieval: 0.04,     // 模型主动检索到的设定全文（当拍蒸发）
  current: 0.06,       // 本轮行动 + 本场指令 + 尾注
});

/** 每层下限：小窗口下也不允许某层被压到 0（否则记忆/在场会整段消失）。 */
const LAYER_FLOORS = Object.freeze({
  system: 1200,
  archive: 600,
  archiveDetail: 300,
  recent: 2000,
  scene: 800,
  retrieval: 300,
  current: 400,
});

/** 生成预留的默认值：narrator 没配 maxTokens 时按这个从窗口里扣。 */
const DEFAULT_OUTPUT_RESERVE = 12000;
/** 安全余量：估算器与上游 tokenizer 的误差、消息封装的固定开销。 */
const SAFETY_TOKENS = 2000;
/** 自动软目标 = 提示词硬上限的这个比例（约等于「装到一半就开始降级」）。 */
const AUTO_SOFT_RATIO = 0.55;

const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : 0);

/**
 * @param {object} args
 * @param {number} args.windowTokens       narrator 绑定模型的上下文窗口
 * @param {number} [args.outputTokens]     生成预留（narrator 的 max_tokens）
 * @param {number} [args.softTokens]       显式软目标；0/缺省 = 按窗口自动
 * @param {number} [args.sessionMaxTokens] 会话级提示词硬上限（不能超过窗口）
 * @returns {{window:number, outputReserve:number, safety:number, hardMax:number,
 *   softMax:number, autoSoft:boolean, layers:object, shares:object, floors:object}}
 */
export function planContext({
  windowTokens, outputTokens, softTokens, sessionMaxTokens,
} = {}) {
  const window = pos(windowTokens) || 200000;
  // 生成预留不能吃掉整个窗口：上限取窗口的 1/4。
  const outputReserve = Math.min(
    pos(outputTokens) || DEFAULT_OUTPUT_RESERVE,
    Math.max(1000, Math.floor(window * 0.25)),
  );
  // 提示词硬上限：窗口 − 生成预留 − 安全余量。下限 2000，避免小窗口算出负数。
  // 会话显式上限只能**收紧**，不能突破这个上限：会话创建时会把 settings 的
  // context_max_tokens 播成整个窗口（worlds.js），若这里不夹，等于把生成预留
  // 又还给了提示词——上游会同时收到「满窗口输入 + max_tokens 生成」而超窗。
  const fromWindow = Math.max(2000, window - outputReserve - SAFETY_TOKENS);
  const sessionMax = pos(sessionMaxTokens);
  const hardMax = sessionMax ? Math.min(sessionMax, fromWindow) : fromWindow;

  const autoSoft = !pos(softTokens);
  const softRaw = autoSoft ? Math.round(hardMax * AUTO_SOFT_RATIO) : pos(softTokens);
  // 不设大下限：显式小软目标（测试/极端会话）也要能触发降级路径；下限只防 0。
  const softMax = Math.max(200, Math.min(softRaw, hardMax));

  const layers = {};
  for (const [key, share] of Object.entries(LAYER_SHARES)) {
    layers[key] = Math.min(hardMax, Math.max(LAYER_FLOORS[key], Math.round(softMax * share)));
  }
  return {
    window,
    outputReserve,
    safety: SAFETY_TOKENS,
    hardMax,
    softMax,
    autoSoft,
    layers,
    shares: { ...LAYER_SHARES },
    floors: { ...LAYER_FLOORS },
  };
}

/**
 * 当前生效的预算规划：narrator 绑定模型窗口 + 生成预留 + .env 软目标（0=自动）。
 * 装配器、检索、强制封场、配置接口都从这里取同一份规划，避免各自读不同的常量。
 * @param {{session?: object}} [args]
 */
export function currentPlan({ session } = {}) {
  const narrator = resolveAgent('narrator');
  return planContext({
    windowTokens: narrator.contextWindow,
    outputTokens: narrator.maxTokens,
    softTokens: config.context.softTokens,
    sessionMaxTokens: Number(session?.settings?.context_max_tokens),
  });
}
