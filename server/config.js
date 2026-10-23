/**
 * Central configuration for AI Roleplay Studio.
 * Environment variables (or a .env file loaded via --env-file) override defaults.
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
    timeoutMs: int(env.LLM_TIMEOUT_MS, 180000),
    maxRetries: int(env.LLM_MAX_RETRIES, 2),
  },

  // ---- Context / memory budget ----
  // Hard ceiling for assembled prompt tokens. Requirement: always < 200K.
  context: {
    maxTokens: int(env.CONTEXT_MAX_TOKENS, 200000),
    // soft target — assembler stops adding optional tiers at this point
    softTokens: int(env.CONTEXT_SOFT_TOKENS, 170000),
    // raw verbatim turns kept in context
    recentRawTurns: int(env.RECENT_RAW_TURNS, 4),
    // number of level-2 (arc) summaries kept in context
    recentArcs: int(env.RECENT_ARCS, 8),
    // retrieval: how many archive snippets to pull in
    retrievalTopK: int(env.RETRIEVAL_TOP_K, 6),
    retrievalMaxTokens: int(env.RETRIEVAL_MAX_TOKENS, 16000),
    // summarization cadence
    arcEvery: int(env.ARC_EVERY, 5),        // rounds per level-2 arc summary
    sagaEvery: int(env.SAGA_EVERY, 5),      // arcs per level-3 saga summary
    chronicleEvery: int(env.CHRONICLE_EVERY, 5), // sagas per level-4 chronicle
  },

  // ---- Agent defaults (reasoning_effort: low | medium | high) ----
  // 注意：step-5-preview 的推理过程计入 max_tokens（实测 low  effort 下
  // 摘要类任务推理约 2500-3200 tok），因此每项预算都预留了推理空间。
  agents: {
    narrator: {
      reasoningEffort: env.NARRATOR_EFFORT || 'high',
      temperature: float(env.NARRATOR_TEMPERATURE, 0.85),
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

  storage: {
    dbPath: env.DB_PATH || path.resolve(__dirname, '..', 'data', 'roleplay.db'),
  },

  web: {
    // served from ../web
    dir: path.resolve(__dirname, '..', '..', 'web'),
  },
};

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function float(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

export function assertConfig() {
  if (!config.upstream.apiKey) {
    throw new Error('STEPFUN_API_KEY is not set. Copy .env.example to .env and fill it in.');
  }
}
