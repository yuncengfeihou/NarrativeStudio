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
  // 关键设计：每一层都有「与剧情长度无关的固定上限」。
  // 剧情推进 1000 轮，装配出来的提示词体积也不会增长 —— 溢出的是
  // 摘要密度，不是层数。硬上限 200K 只是安全网，实际软目标 ~35K。
  context: {
    maxTokens: int(env.CONTEXT_MAX_TOKENS, 200000),
    softTokens: int(env.CONTEXT_SOFT_TOKENS, 52000),

    // 每层 token 配额（软上限）。装配器按此逐层裁剪，不会互相挤占。
    layerBudget: {
      system: int(env.BUDGET_SYSTEM, 1500),      // 演绎契约（固定文本）
      world: int(env.BUDGET_WORLD, 3000),        // 世界宪章 + 主角 + 卡司骨架
      lore: int(env.BUDGET_LORE, 3000),          // 触发式世界词条
      scene: int(env.BUDGET_SCENE, 900),         // 在场状态（时间/地点/人物/物品）
      director: int(env.BUDGET_DIRECTOR, 700),   // 导演卡（当前节拍）
      memory: int(env.BUDGET_MEMORY, 14000),     // 分层记忆总配额
      recent: int(env.BUDGET_RECENT, 9000),      // 最近原文
      retrieval: int(env.BUDGET_RETRIEVAL, 1500),// 检索召回
      current: int(env.BUDGET_CURRENT, 2000),    // 本轮输入
    },

    // memory 层的内部再分配
    memorySplit: {
      reflections: 1400,   // 反思洞察（高阶结论）
      summaries: 5600,     // 分层摘要
      relations: 1600,     // 关系账本
      threads: 900,        // 线索/伏笔账本
      entities: 2600,      // 实体档案 + 事实
      notes: 1900,         // 作者笔记（确定性记忆）
    },

    // 保留的原始回合数（还会按 recent 配额二次裁剪）
    recentRawTurns: int(env.RECENT_RAW_TURNS, 4),
    // 摘要层保留多少条最新 L2
    recentArcs: int(env.RECENT_ARCS, 6),
    // L1 摘要保留条数
    recentRounds: int(env.RECENT_ROUNDS, 6),

    // 检索
    retrievalTopK: int(env.RETRIEVAL_TOP_K, 5),

    // 词条触发扫描
    loreScanDepth: int(env.LORE_SCAN_DEPTH, 8),        // 扫描最近几轮对话
    // 递归 0 = 关闭（推荐）。开启后，被触发词条的内容会再次参与扫描，
    // 容易让「称呼礼法」这类词条顺带把整张卡司都拉进上下文。
    loreRecursion: int(env.LORE_RECURSION, 0),

    // 压缩节奏
    arcEvery: int(env.ARC_EVERY, 6),
    sagaEvery: int(env.SAGA_EVERY, 4),
    chronicleEvery: int(env.CHRONICLE_EVERY, 4),
    reflectEvery: int(env.REFLECT_EVERY, 5),           // 每 N 轮生成一次反思
  },

  // ---- Agent defaults (reasoning_effort: low | medium | high) ----
  // 注意：step-5-preview 的推理过程计入 max_tokens。
  agents: {
    narrator: {
      reasoningEffort: env.NARRATOR_EFFORT || 'high',
      temperature: float(env.NARRATOR_TEMPERATURE, 0.88),
      maxTokens: int(env.NARRATOR_MAX_TOKENS, 12000),
      minTokens: int(env.NARRATOR_MIN_TOKENS, 1800),
    },
    branch: {
      reasoningEffort: env.BRANCH_EFFORT || 'medium',
      temperature: float(env.BRANCH_TEMPERATURE, 0.9),
      maxTokens: int(env.BRANCH_MAX_TOKENS, 5000),
    },
    memory: {
      reasoningEffort: env.MEMORY_EFFORT || 'low',
      temperature: float(env.MEMORY_TEMPERATURE, 0.3),
      maxTokens: int(env.MEMORY_MAX_TOKENS, 6000),
    },
  },

  // ---- 可选：嵌入模型（用于语义检索）。留空则只用 BM25 + 实体图 ----
  embed: {
    enabled: Boolean(env.EMBED_API_KEY && env.EMBED_BASE_URL && env.EMBED_MODEL),
    baseUrl: env.EMBED_BASE_URL || '',
    apiKey: env.EMBED_API_KEY || '',
    model: env.EMBED_MODEL || '',
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
