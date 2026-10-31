/**
 * Central configuration for AI Roleplay Studio.
 * Environment variables (or a .env file) override defaults.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const env = process.env;

export const config = {
  port: int(env.PORT, 3210),
  host: env.HOST || '0.0.0.0',

  // ---- Upstream LLM (StepFun, OpenAI-compatible) ----
  upstream: {
    baseUrl: env.STEPFUN_BASE_URL || 'https://api.stepfun.com/step_plan/v1',
    apiKey: env.STEPFUN_API_KEY || '',
    model: env.STEPFUN_MODEL || 'step-5-preview',
    timeoutMs: int(env.LLM_TIMEOUT_MS, 300000),
    maxRetries: int(env.LLM_MAX_RETRIES, 2),
  },

  // ---- Context / memory budget ----
  //
  // v4：提示词是「渲染」出来的，不是「检索」出来的。
  //   系统层 = 契约 + 命题 + 宪章 + 世界索引（**只读卡快照，会话内逐字节不变**）
  //   原文层 = 当前场次的全部回合逐字（只追加）
  //   场记单 = 当前这一刻的世界状态（每场变一次，放在尾部注意力最强处）
  // 没有词条配额、没有导演卡配额、没有检索配额——那三层在 v4 里不存在。
  //
  // 预算口径：`tokens.js` 已按真实上游标定（TOKEN_SCALE=0.72），
  // 下列数字与上游 prompt_tokens 基本同尺度，不再是「虚高的配额」。
  //
  // 各层配额不再是一组独立常量：它们由**模型窗口**推导（server/memory/context-plan.js）。
  // 旧实现把 system 钉死在 3400，换到 200K 窗口的模型后等于永久浪费 95% 窗口，
  // 而长局记忆真正需要的场次索引反而被 1800 卡死。现在只保留「软目标」这一个旋钮：
  // 0 = 按提示词硬上限自动取 55%；显式值仍可作为「这一局装到多少就开始降级」的预期。
  context: {
    maxTokens: int(env.CONTEXT_MAX_TOKENS, 200000),
    softTokens: int(env.CONTEXT_SOFT_TOKENS, 0),
    // 超硬上限策略：fail（默认）= 拒绝本轮并给出处置建议；truncate = 旧行为，
    // 从最长非 system 消息截断 70% 并记 degraded='over_hard_cap'（调试/应急用，会送半句话）。
    overHardCap: String(env.CONTEXT_OVER_HARD_CAP || 'fail').toLowerCase() === 'truncate'
      ? 'truncate'
      : 'fail',

    // 辞书主动检索：auto = 只在大卡上启用；on/off 可被会话 settings.codex_retrieval 覆盖。
    retrievalMinCodex: int(env.RETRIEVAL_MIN_CODEX, 24),
    retrievalMaxQueries: int(env.RETRIEVAL_MAX_QUERIES, 3),
    retrievalMinChars: int(env.RETRIEVAL_MIN_CHARS, 2),

    // 实体链接扫描最近几轮原文（只用于「玩家提到了谁」，不用于触发设定）
    loreScanDepth: int(env.LORE_SCAN_DEPTH, 8),

    // 封场后仍逐字带上的回合数（0 = 关）。
    // 场次内原文本来就完整；问题是**封场那一刻**整场逐字原文全部消失，只剩索引一行，
    // 上一拍的用词/句长/引号风格全丢。长跑实测引号风格逐拍随机、13 次切换里 9 次
    // 正发生在原文窗口为空时。重叠 2 拍 = 还能看出「一来一回」，成本约软目标的 2%。
    // 按**回合**（turn_no）算，不按消息条数：一个回合本来就含 player+narrator 两条行。
    recentOverlapTurns: int(env.RECENT_OVERLAP_TURNS, 2),

    // 后台 Agent 节奏
    continuityEvery: int(env.CONTINUITY_EVERY, 10),   // 每 N 轮跑一次校勘
    continuityMaxApplied: int(env.CONTINUITY_MAX_APPLIED, 20), // 单次校勘最多自动落库几条
    worldTickEvery: int(env.WORLD_TICK_EVERY, 8),     // 每 N 轮跑一次世界呼吸
    // 强制切场：>0 时按固定轮数封场。0 = 只按「地点变化」切场，会导致
    // 角色在一个地点待 100 轮就一场都不关，「最近一场」永远未归档。
    sceneEvery: int(env.SCENE_EVERY, 12),
    // 最小场长：场次至少写满这么多拍，才允许因「地点/时间变了」切场。
    // 长跑实测 65 拍切了 29 场（2.24 拍/场），每场第一拍的
    // meta.coverage.recent_from 必为 null——那一拍上下文里没有任何逐字原文，
    // 模型是凭场次索引在续写。SCENE_EVERY 只管上限（12 拍必封），
    // 缺的是下限。默认 3：65 拍 → 18 场，recent_from=null 从 44.6% 降到 27.7%。
    // 只约束软触发；轮数/ token 的强制封场不受影响（否则会与 SCENE_EVERY 死锁）。
    minSceneTurns: int(env.MIN_SCENE_TURNS, 3),
    sceneMaxTokens: int(env.SCENE_MAX_TOKENS, 20000), // 单场原文超过这个就强制封场
  },

  // ---- 分段演绎（P1-1 第一阶段） ----
  // 默认 single：一次流式写完。segmented 只由会话 settings.narration_mode 开启。
  // 工具结果只活在当拍，绝不写入 turns；总预算由 toolHistoryTokens 约束。
  narration: {
    mode: env.NARRATION_MODE || 'single',            // single | segmented
    maxRounds: int(env.NARRATION_MAX_ROUNDS, 6),
    // 注意：step-5 的推理过程也计入 max_tokens，正文在推理之后才输出。
    // 默认与 narrator 上限对齐（§13 第 19 条）；需要省成本时再单独调低。
    roundMaxTokens: int(env.SEGMENTED_ROUND_MAX_TOKENS, 20000),
    toolResultMaxTokens: int(env.TOOL_RESULT_MAX_TOKENS, 500),
    toolHistoryTokens: int(env.BUDGET_TOOL_RESULTS, 1200),
  },

  // ---- Agent defaults (reasoning_effort: low | medium | high | xhigh | max) ----
  // 注意：上游模型的推理过程计入 max_tokens。旁路 Agent 的 JSON 在推理之后才输出，
  // 预算必须给推理留足空间；否则会得到「completion_tokens 用满、content 为空」的假成功
  // （`llm.js` 会以**同等级推理** + 双倍预算重试一次，日志是「空内容且预算耗尽」）。
  // 分工：narrator 只管正文，永远不输出 JSON；记账全部交给史官与校勘。
  // 调大 narrator 的 maxTokens 要算两笔账：① 它是 context-plan 的生成预留，直接从
  // 提示词预算里扣（200K 窗口下每 +1K 就少 1K 可用上下文）；② 上限受模型 maxOutput 约束。
  agents: {
    narrator: {
      reasoningEffort: env.NARRATOR_EFFORT || 'high',
      temperature: float(env.NARRATOR_TEMPERATURE, 0.88),
      maxTokens: int(env.NARRATOR_MAX_TOKENS, 20000),
      model: env.NARRATOR_MODEL || null,
    },
    archivist: {
      reasoningEffort: env.ARCHIVIST_EFFORT || 'medium',
      temperature: float(env.ARCHIVIST_TEMPERATURE, 0.3),
      maxTokens: int(env.ARCHIVIST_MAX_TOKENS, 16000),
      model: env.ARCHIVIST_MODEL || null,
    },
    sceneKeeper: {
      reasoningEffort: env.SCENE_KEEPER_EFFORT || 'medium',
      temperature: float(env.SCENE_KEEPER_TEMPERATURE, 0.3),
      maxTokens: int(env.SCENE_KEEPER_MAX_TOKENS, 10000),
      model: env.SCENE_KEEPER_MODEL || null,
    },
    retrieval: {
      reasoningEffort: env.RETRIEVAL_EFFORT || 'low',
      temperature: float(env.RETRIEVAL_TEMPERATURE, 0.2),
      // 输出只有一个短 JSON，但推理先花预算：2000 实测经常「用满且 content 为空」，
      // 每次都白跑一次重试。4000 留够思考空间、又不会让这一拍变慢。
      maxTokens: int(env.RETRIEVAL_MAX_TOKENS, 4000),
      model: env.RETRIEVAL_MODEL || null,
    },
    continuity: {
      reasoningEffort: env.CONTINUITY_EFFORT || 'medium',
      temperature: float(env.CONTINUITY_TEMPERATURE, 0.2),
      maxTokens: int(env.CONTINUITY_MAX_TOKENS, 16000),
      model: env.CONTINUITY_MODEL || null,
    },
    librarian: {
      reasoningEffort: env.LIBRARIAN_EFFORT || 'low',
      temperature: float(env.LIBRARIAN_TEMPERATURE, 0.2),
      maxTokens: int(env.LIBRARIAN_MAX_TOKENS, 6000),
      model: env.LIBRARIAN_MODEL || null,
    },
    worldTick: {
      reasoningEffort: env.WORLD_TICK_EFFORT || 'medium',
      temperature: float(env.WORLD_TICK_TEMPERATURE, 0.7),
      maxTokens: int(env.WORLD_TICK_MAX_TOKENS, 10000),
      model: env.WORLD_TICK_MODEL || null,
    },
    branch: {
      reasoningEffort: env.BRANCH_EFFORT || 'medium',
      temperature: float(env.BRANCH_TEMPERATURE, 0.9),
      maxTokens: int(env.BRANCH_MAX_TOKENS, 10000),
      model: env.BRANCH_MODEL || null,
    },
    cardSmith: {
      reasoningEffort: env.CARD_SMITH_EFFORT || 'medium',
      temperature: float(env.CARD_SMITH_TEMPERATURE, 0.4),
      maxTokens: int(env.CARD_SMITH_MAX_TOKENS, 16000),
      model: env.CARD_SMITH_MODEL || null,
    },
  },

  storage: {
    dbPath: env.DB_PATH || path.resolve(__dirname, '..', 'data', 'roleplay.db'),
  },

  web: {
    dir: path.resolve(__dirname, '..', 'web'),
  },
};

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function float(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

export function assertConfig() {
  if (!config.upstream.apiKey) {
    throw new Error('STEPFUN_API_KEY is not set. Copy .env.example to .env and fill it in.');
  }
}
