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
  //   系统层 = 契约 + 命题 + 宪章 + 世界索引（一个会话内几乎不变，吃前缀缓存）
  //   原文层 = 最近若干轮逐字（只追加）
  //   场记单 = 当前这一刻的世界状态（每场变一次，放在尾部注意力最强处）
  // 没有词条配额、没有导演卡配额、没有检索配额——那三层在 v4 里不存在。
  context: {
    maxTokens: int(env.CONTEXT_MAX_TOKENS, 200000),
    softTokens: int(env.CONTEXT_SOFT_TOKENS, 52000),

    // 每层 token 配额（软上限）。装配器按此逐层裁剪，不会互相挤占。
    layerBudget: {
      system: int(env.BUDGET_SYSTEM, 3200),      // 契约 + 命题 + 宪章 + 世界索引
      summary: int(env.BUDGET_SUMMARY, 1800),    // 前情提要（滚动摘要）
      recent: int(env.BUDGET_RECENT, 9000),      // 最近原文（逐字）
      scene: int(env.BUDGET_SCENE, 2400),        // 场记单
      retrieval: int(env.BUDGET_RETRIEVAL, 600), // 模型主动检索到的辞书全文（当拍）
      current: int(env.BUDGET_CURRENT, 2000),    // 本轮输入 + 尾注
    },

    // 保留的原始回合数（还会按 recent 配额二次裁剪）
    recentRawTurns: int(env.RECENT_RAW_TURNS, 4),

    // 前情提要：每 SUMMARY_EVERY 轮检查一次；最近 SUMMARY_KEEP_RECENT 轮永远逐字保留。
    summaryEvery: int(env.SUMMARY_EVERY, 8),
    summaryKeepRecent: int(env.SUMMARY_KEEP_RECENT, 4),
    summaryMinChars: int(env.SUMMARY_MIN_CHARS, 2000),

    // 辞书主动检索：auto = 只在大卡上启用；on/off 可被会话 settings.codex_retrieval 覆盖。
    retrievalMinCodex: int(env.RETRIEVAL_MIN_CODEX, 24),
    retrievalMaxQueries: int(env.RETRIEVAL_MAX_QUERIES, 3),
    retrievalMinChars: int(env.RETRIEVAL_MIN_CHARS, 2),

    // 实体链接扫描最近几轮原文（只用于「玩家提到了谁」，不用于触发设定）
    loreScanDepth: int(env.LORE_SCAN_DEPTH, 8),

    // 后台 Agent 节奏
    continuityEvery: int(env.CONTINUITY_EVERY, 10),   // 每 N 轮跑一次校勘
    worldTickEvery: int(env.WORLD_TICK_EVERY, 8),     // 每 N 轮跑一次世界呼吸
    sceneEvery: int(env.SCENE_EVERY, 0),              // >0 时按固定轮数强制切场
  },

  // ---- 分段演绎（P1-1 第一阶段） ----
  // 默认 single：一次流式写完。segmented 只由会话 settings.narration_mode 开启。
  // 工具结果只活在当拍，绝不写入 turns；总预算由 toolHistoryTokens 约束。
  narration: {
    mode: env.NARRATION_MODE || 'single',            // single | segmented
    maxRounds: int(env.NARRATION_MAX_ROUNDS, 6),
    // 注意：step-5 的推理过程也计入 max_tokens。6000 会在长正文上截断，
    // 默认与 narrator 上限对齐；需要省成本时再单独调低。
    roundMaxTokens: int(env.SEGMENTED_ROUND_MAX_TOKENS, 12000),
    toolResultMaxTokens: int(env.TOOL_RESULT_MAX_TOKENS, 500),
    toolHistoryTokens: int(env.BUDGET_TOOL_RESULTS, 1200),
  },

  // ---- Agent defaults (reasoning_effort: low | medium | high) ----
  // 注意：step-5-preview 的推理过程计入 max_tokens。
  // 分工：narrator 只管正文，永远不输出 JSON；记账全部交给史官与校勘。
  agents: {
    narrator: {
      reasoningEffort: env.NARRATOR_EFFORT || 'high',
      temperature: float(env.NARRATOR_TEMPERATURE, 0.88),
      maxTokens: int(env.NARRATOR_MAX_TOKENS, 12000),
      model: env.NARRATOR_MODEL || null,
    },
    archivist: {
      reasoningEffort: env.ARCHIVIST_EFFORT || 'medium',
      temperature: float(env.ARCHIVIST_TEMPERATURE, 0.3),
      maxTokens: int(env.ARCHIVIST_MAX_TOKENS, 6000),
      model: env.ARCHIVIST_MODEL || null,
    },
    sceneKeeper: {
      reasoningEffort: env.SCENE_KEEPER_EFFORT || 'medium',
      temperature: float(env.SCENE_KEEPER_TEMPERATURE, 0.3),
      maxTokens: int(env.SCENE_KEEPER_MAX_TOKENS, 4000),
      model: env.SCENE_KEEPER_MODEL || null,
    },
    summarizer: {
      reasoningEffort: env.SUMMARY_EFFORT || 'low',
      temperature: float(env.SUMMARY_TEMPERATURE, 0.3),
      maxTokens: int(env.SUMMARY_MAX_TOKENS, 3000),
      model: env.SUMMARY_MODEL || null,
    },
    retrieval: {
      reasoningEffort: env.RETRIEVAL_EFFORT || 'low',
      temperature: float(env.RETRIEVAL_TEMPERATURE, 0.2),
      maxTokens: int(env.RETRIEVAL_MAX_TOKENS, 500),
      model: env.RETRIEVAL_MODEL || null,
    },
    continuity: {
      reasoningEffort: env.CONTINUITY_EFFORT || 'medium',
      temperature: float(env.CONTINUITY_TEMPERATURE, 0.2),
      maxTokens: int(env.CONTINUITY_MAX_TOKENS, 5000),
      model: env.CONTINUITY_MODEL || null,
    },
    librarian: {
      reasoningEffort: env.LIBRARIAN_EFFORT || 'low',
      temperature: float(env.LIBRARIAN_TEMPERATURE, 0.2),
      maxTokens: int(env.LIBRARIAN_MAX_TOKENS, 3000),
      model: env.LIBRARIAN_MODEL || null,
    },
    worldTick: {
      reasoningEffort: env.WORLD_TICK_EFFORT || 'medium',
      temperature: float(env.WORLD_TICK_TEMPERATURE, 0.7),
      maxTokens: int(env.WORLD_TICK_MAX_TOKENS, 4000),
      model: env.WORLD_TICK_MODEL || null,
    },
    branch: {
      reasoningEffort: env.BRANCH_EFFORT || 'medium',
      temperature: float(env.BRANCH_TEMPERATURE, 0.9),
      maxTokens: int(env.BRANCH_MAX_TOKENS, 5000),
      model: env.BRANCH_MODEL || null,
    },
    cardSmith: {
      reasoningEffort: env.CARD_SMITH_EFFORT || 'medium',
      temperature: float(env.CARD_SMITH_TEMPERATURE, 0.4),
      maxTokens: int(env.CARD_SMITH_MAX_TOKENS, 8000),
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
