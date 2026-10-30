/**
 * server/model-registry.js — 运行期模型配置（服务商 / 模型 / Agent 绑定）
 *
 * 唯一真源：SQLite `meta` 表 key='runtime_config_v1'（JSON 明文，含 apiKey；
 * GET /api/config 只回掩码，明文永不出网）。没有该键 = 从未保存 = 全部回落 .env。
 *
 * 解析顺序：显式单次覆盖 > DB Agent 绑定 > .env 默认 > 内置默认。
 * 保存/重置后立即生效（模块内缓存与 DB 同一份规范化结果，无需重启）。
 *
 * 不做迁移：这里只读写这一个键；旧库没有它时视为「未保存」。
 */
import { config } from './config.js';
import { deleteMeta, getMeta, setMeta } from './memory/store.js';

export const AGENT_KEYS = [
  'narrator', 'archivist', 'sceneKeeper', 'retrieval', 'continuity',
  'librarian', 'worldTick', 'branch', 'cardSmith',
];

/** 上游协议；目前只有 OpenAI 兼容（`{baseUrl}/chat/completions`）。 */
export const PROTOCOLS = ['openai'];

/**
 * 推理强度枚举：保存的配置接受这五档。
 * 上游能力不同：StepFun 只认 low/medium/high，MiniMax-M3.1-Flash 还支持 xhigh/max
 * （省略时默认 max）。这里只做「保存配置」的枚举校验，具体某模型支持哪些档
 * 由 model.reasoningEfforts 声明、设置页按模型展示。
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const META_KEY = 'runtime_config_v1';
const CONFIG_VERSION = 1;
const ENV_PROVIDER_ID = 'env-provider';
const ENV_MODEL_ID = 'env-model';

let cacheLoaded = false;
let cacheRaw = null; // null = 用 .env 种子

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function bad(message) {
  const err = new Error(message);
  err.name = 'ConfigValidationError';
  err.status = 400;
  return err;
}

function str(value) {
  return value == null ? '' : String(value).trim();
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw bad(`${label} 必须是正数`);
  return Math.trunc(n);
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function sameBaseUrl(a, b) {
  return trimSlash(a) === trimSlash(b);
}

/* ── .env 种子（没有 DB 配置时的等价物） ────────────────────────────── */

function envMaxOutput() {
  const sizes = AGENT_KEYS
    .map((key) => Number(config.agents[key]?.maxTokens))
    .filter((n) => Number.isFinite(n) && n > 0);
  return sizes.length ? Math.max(...sizes) : 12000;
}

function envProvider() {
  return {
    id: ENV_PROVIDER_ID,
    name: '环境变量默认（StepFun）',
    baseUrl: trimSlash(config.upstream.baseUrl),
    apiKey: config.upstream.apiKey,
    protocol: 'openai',
    enabled: true,
  };
}

function envModel() {
  return {
    id: ENV_MODEL_ID,
    providerId: ENV_PROVIDER_ID,
    model: config.upstream.model,
    label: config.upstream.model,
    contextWindow: config.context.maxTokens,
    maxOutput: envMaxOutput(),
    supportsReasoning: true,
    // .env 种子固定是 StepFun 上游（见 envProvider 的注释）；它只认三档。
    // 其它服务商（MiniMax 等）走设置页配置，由 model.reasoningEfforts 自行声明。
    reasoningEfforts: ['low', 'medium', 'high'],
    supportsTemperature: true,
    enabled: true,
  };
}

/* ── 读取与规范化 ───────────────────────────────────────────────────── */

function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.providers) || !raw.providers.length) return null;
  if (!Array.isArray(raw.models) || !raw.models.length) return null;

  const providers = raw.providers
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => ({
      id: str(p.id) || `provider-${i + 1}`,
      name: str(p.name) || '未命名服务商',
      baseUrl: trimSlash(p.baseUrl),
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
      protocol: PROTOCOLS.includes(p.protocol) ? p.protocol : 'openai',
      enabled: p.enabled !== false,
    }))
    .filter((p) => p.id && p.baseUrl);

  const models = raw.models
    .filter((m) => m && typeof m === 'object')
    .map((m, i) => ({
      id: str(m.id) || `model-${i + 1}`,
      providerId: str(m.providerId),
      model: str(m.model),
      label: str(m.label) || str(m.model),
      contextWindow: Number(m.contextWindow) > 0 ? Math.trunc(Number(m.contextWindow)) : config.context.maxTokens,
      maxOutput: Number(m.maxOutput) > 0 ? Math.trunc(Number(m.maxOutput)) : envMaxOutput(),
      supportsReasoning: m.supportsReasoning !== false,
      // 不支持推理的模型允许空数组；支持推理却留空时按全档位处理（.env 种子与旧数据同样适用）。
      reasoningEfforts: Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length
        ? [...new Set(m.reasoningEfforts.map(str).filter((e) => EFFORTS.includes(e)))]
        : (m.supportsReasoning === false ? [] : [...EFFORTS]),
      supportsTemperature: m.supportsTemperature !== false,
      enabled: m.enabled !== false,
    }))
    .filter((m) => m.id && m.providerId && m.model);

  if (!providers.length || !models.length) return null;

  const agents = {};
  const storedAgents = raw.agents && typeof raw.agents === 'object' ? raw.agents : {};
  for (const key of AGENT_KEYS) {
    const a = storedAgents[key];
    if (!a || typeof a !== 'object') continue;
    agents[key] = {
      modelId: a.modelId ? str(a.modelId) : null,
      effort: EFFORTS.includes(a.effort) ? a.effort : null,
      temperature: a.temperature != null && a.temperature !== '' && Number.isFinite(Number(a.temperature))
        ? Number(a.temperature)
        : null,
      maxTokens: a.maxTokens != null && a.maxTokens !== '' && Number.isFinite(Number(a.maxTokens)) && Number(a.maxTokens) > 0
        ? Math.trunc(Number(a.maxTokens))
        : null,
    };
  }

  return { version: CONFIG_VERSION, providers, models, agents };
}

function loadRaw() {
  if (cacheLoaded) return cacheRaw;
  cacheLoaded = true;
  let parsed = null;
  try {
    const text = getMeta(META_KEY);
    if (text) parsed = JSON.parse(text);
  } catch {
    parsed = null; // meta 里的坏 JSON 视为未保存：.env 才是安全底线
  }
  cacheRaw = normalizeStored(parsed);
  return cacheRaw;
}

/* ── 解析 ───────────────────────────────────────────────────────────── */

/** 服务商生效 apiKey：显式保存的优先；空且地址与 .env 上游相同则沿用 .env。 */
function apiKeyFor(provider) {
  if (!provider) return config.upstream.apiKey;
  if (provider.apiKey) return provider.apiKey;
  if (sameBaseUrl(provider.baseUrl, config.upstream.baseUrl)) return config.upstream.apiKey;
  return '';
}

function keyHintOf(key) {
  const text = str(key);
  return text ? text.slice(-4) : '';
}

/**
 * 解析一个 Agent 的生效配置。
 * 返回 {key, source, modelId, model, providerId, baseUrl, apiKey, protocol,
 *       effort, temperature, maxTokens, contextWindow, supportsReasoning, supportsTemperature}
 * env fallback 的 effort/temperature/maxTokens 逐项等于 config.agents[key] 原值。
 */
export function resolveAgent(agentKey) {
  if (!AGENT_KEYS.includes(agentKey)) throw new Error(`未知 Agent：${agentKey}`);
  const envCfg = config.agents[agentKey] || {};
  const base = {
    key: agentKey,
    source: 'env',
    modelId: ENV_MODEL_ID,
    model: envCfg.model || config.upstream.model,
    providerId: ENV_PROVIDER_ID,
    baseUrl: trimSlash(config.upstream.baseUrl),
    apiKey: config.upstream.apiKey,
    protocol: 'openai',
    effort: envCfg.reasoningEffort ?? null,
    temperature: envCfg.temperature ?? null,
    maxTokens: envCfg.maxTokens ?? null,
    contextWindow: config.context.maxTokens,
    supportsReasoning: true,
    supportsTemperature: true,
  };

  const raw = loadRaw();
  if (!raw) return base;
  const binding = raw.agents[agentKey];
  if (!binding) return base;

  const resolved = {
    ...base,
    source: 'db',
    effort: binding.effort ?? base.effort,
    temperature: binding.temperature ?? base.temperature,
    maxTokens: binding.maxTokens ?? base.maxTokens,
  };

  const model = binding.modelId
    ? raw.models.find((m) => m.id === binding.modelId && m.enabled !== false)
    : null;
  const provider = model
    ? raw.providers.find((p) => p.id === model.providerId && p.enabled !== false)
    : null;
  // 停用的服务商/模型或引用已删除的模型：静默回落 .env，保证回合不会因配置改动而中断。
  if (!model || !provider) return resolved;

  resolved.modelId = model.id;
  resolved.model = model.model;
  resolved.providerId = provider.id;
  resolved.baseUrl = trimSlash(provider.baseUrl);
  resolved.apiKey = apiKeyFor(provider);
  resolved.protocol = provider.protocol || 'openai';
  resolved.contextWindow = model.contextWindow || base.contextWindow;
  resolved.supportsReasoning = model.supportsReasoning !== false;
  resolved.supportsTemperature = model.supportsTemperature !== false;
  resolved.maxTokens = binding.maxTokens ?? model.maxOutput ?? base.maxTokens;
  if (!resolved.supportsReasoning) resolved.effort = null;
  if (!resolved.supportsTemperature) resolved.temperature = null;
  return resolved;
}

/** 上下文硬上限：narrator 绑定模型的 contextWindow，未保存配置时等于 .env 的 CONTEXT_MAX_TOKENS。 */
export function resolveContextWindow(agentKey = 'narrator') {
  const window = Number(resolveAgent(agentKey).contextWindow);
  return Number.isFinite(window) && window > 0 ? Math.trunc(window) : config.context.maxTokens;
}

/**
 * LLM 传输目标。给 llm.js 与 /v1 兼容层用：
 * - agent 有绑定时用它（model / baseUrl / apiKey / effort 等）；
 * - 否则按显式 model 在已保存模型里找（/v1 透传），找不到就沿用 narrator 的传输目标。
 * 显式 model 永远优先于绑定里的 model 名。
 */
export function resolveModelTarget({ agent = null, model = null } = {}) {
  const overrideModel = str(model) || null;
  const envTarget = {
    baseUrl: trimSlash(config.upstream.baseUrl),
    apiKey: config.upstream.apiKey,
    protocol: 'openai',
    model: overrideModel || config.upstream.model,
    timeoutMs: config.upstream.timeoutMs,
    maxRetries: config.upstream.maxRetries,
    maxTokens: null,
    temperature: null,
    effort: null,
  };

  if (agent) {
    const r = resolveAgent(agent);
    return {
      ...envTarget,
      baseUrl: r.baseUrl,
      apiKey: r.apiKey,
      protocol: r.protocol,
      model: overrideModel || r.model,
      maxTokens: r.maxTokens,
      temperature: r.temperature,
      effort: r.effort,
    };
  }

  const raw = loadRaw();
  if (!raw) return envTarget;

  const match = overrideModel
    ? raw.models.find((m) => m.id === overrideModel) || raw.models.find((m) => m.model === overrideModel)
    : null;
  const provider = match
    ? raw.providers.find((p) => p.id === match.providerId && p.enabled !== false)
    : null;
  if (match && provider && match.enabled !== false) {
    return {
      ...envTarget,
      baseUrl: trimSlash(provider.baseUrl),
      apiKey: apiKeyFor(provider),
      protocol: provider.protocol || 'openai',
      model: overrideModel || match.model,
    };
  }

  const fallback = resolveAgent('narrator');
  return {
    ...envTarget,
    baseUrl: fallback.baseUrl,
    apiKey: fallback.apiKey,
    protocol: fallback.protocol,
    model: overrideModel || fallback.model,
  };
}

/* ── 对外视图（GET /api/config 的 runtime 段） ──────────────────────── */

function maskProvider(provider) {
  const key = apiKeyFor(provider);
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: trimSlash(provider.baseUrl),
    apiKey: '',
    hasKey: !!key,
    keyHint: keyHintOf(key),
    protocol: provider.protocol || 'openai',
    enabled: provider.enabled !== false,
  };
}

/** 生效配置视图：保存的明文 apiKey 永不出网，只给 hasKey + 末 4 位。 */
export function getEffectiveConfig() {
  const raw = loadRaw();
  const source = raw ? 'db' : 'env';
  const providers = (raw ? raw.providers : [envProvider()]).map(maskProvider);
  const models = (raw ? raw.models : [envModel()]).map((m) => ({ ...m, reasoningEfforts: [...m.reasoningEfforts] }));

  const agents = {};
  for (const key of AGENT_KEYS) {
    const r = resolveAgent(key);
    agents[key] = {
      modelId: r.modelId,
      model: r.model,
      providerId: r.providerId,
      effort: r.effort,
      temperature: r.temperature,
      maxTokens: r.maxTokens,
      contextWindow: r.contextWindow,
      source: r.source,
    };
  }

  const windowTokens = resolveContextWindow('narrator');
  return {
    source,
    providers,
    models,
    agents,
    context: {
      // 模型窗口是唯一硬事实。提示词硬上限 / 软目标 / 各层配额由
      // server/memory/context-plan.js 从窗口推导，并由路由层合并进这个视图
      // （预算模块依赖 model-registry，反过来 import 会形成循环）。
      window_tokens: windowTokens,
      output_reserve_tokens: agents.narrator.maxTokens ?? config.agents.narrator.maxTokens,
      model_id: agents.narrator.modelId,
      model: agents.narrator.model,
    },
    env: {
      baseUrl: trimSlash(config.upstream.baseUrl),
      model: config.upstream.model,
      hasKey: !!config.upstream.apiKey,
      keyHint: keyHintOf(config.upstream.apiKey),
    },
    options: {
      efforts: [...EFFORTS],
      protocols: [...PROTOCOLS],
      agent_keys: [...AGENT_KEYS],
    },
  };
}

/* ── 保存与重置 ─────────────────────────────────────────────────────── */

function normalizeProviders(input, old) {
  if (!Array.isArray(input) || !input.length) throw bad('providers 必须是非空数组');
  const seen = new Set();
  return input.map((p, i) => {
    if (!p || typeof p !== 'object') throw bad(`第 ${i + 1} 个服务商格式不正确`);
    const id = str(p.id) || `provider-${i + 1}`;
    if (seen.has(id)) throw bad(`服务商 id 重复：${id}`);
    seen.add(id);

    const name = str(p.name) || `服务商 ${i + 1}`;
    const baseUrl = trimSlash(p.baseUrl);
    if (!baseUrl) throw bad(`服务商「${name}」的 baseUrl 不能为空`);
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw bad(`服务商「${name}」的 baseUrl 不是合法 URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw bad(`服务商「${name}」的 baseUrl 只支持 http/https`);
    }

    const protocol = str(p.protocol) || 'openai';
    if (!PROTOCOLS.includes(protocol)) {
      throw bad(`服务商「${name}」的 protocol 不支持：${protocol}（目前仅支持 openai）`);
    }

    const oldProvider = old?.providers.find((x) => x.id === id);
    const supplied = typeof p.apiKey === 'string' ? p.apiKey : null;
    let apiKey;
    if (supplied == null || supplied === '***') {
      // 省略或占位符：保留已保存的 key；没有且地址仍指向 .env 上游时继承 .env 的 key。
      apiKey = oldProvider?.apiKey || '';
      if (!apiKey && sameBaseUrl(baseUrl, config.upstream.baseUrl)) apiKey = config.upstream.apiKey;
    } else {
      apiKey = supplied; // '' = 清除（解析时空 key 且同 .env 地址仍会回落到 .env）
    }

    return { id, name, baseUrl, apiKey, protocol, enabled: p.enabled !== false };
  });
}

function normalizeModels(input, providers) {
  if (!Array.isArray(input) || !input.length) throw bad('models 必须是非空数组');
  const providerIds = new Set(providers.map((p) => p.id));
  const seen = new Set();
  return input.map((m, i) => {
    if (!m || typeof m !== 'object') throw bad(`第 ${i + 1} 个模型格式不正确`);
    const id = str(m.id) || `model-${i + 1}`;
    if (seen.has(id)) throw bad(`模型 id 重复：${id}`);
    seen.add(id);

    const providerId = str(m.providerId);
    if (!providerIds.has(providerId)) {
      throw bad(`模型「${id}」引用了不存在的服务商：${providerId || '(空)'}`);
    }
    const model = str(m.model);
    if (!model) throw bad(`模型「${id}」的上游 model 不能为空`);
    const contextWindow = positiveInt(m.contextWindow, `模型「${id}」的 contextWindow`);
    const maxOutput = positiveInt(m.maxOutput, `模型「${id}」的 maxOutput`);

    const supportsReasoning = m.supportsReasoning !== false;
    let reasoningEfforts;
    if (m.reasoningEfforts == null) {
      reasoningEfforts = supportsReasoning ? [...EFFORTS] : [];
    } else {
      if (!Array.isArray(m.reasoningEfforts)) {
        throw bad(`模型「${id}」的 reasoningEfforts 必须是数组`);
      }
      if (!m.reasoningEfforts.length) {
        if (supportsReasoning) throw bad(`模型「${id}」的 reasoningEfforts 必须是非空数组（或把 supportsReasoning 设为 false）`);
        reasoningEfforts = [];
      } else {
        reasoningEfforts = [...new Set(m.reasoningEfforts.map(str))];
        const illegal = reasoningEfforts.find((e) => !EFFORTS.includes(e));
        if (illegal) throw bad(`模型「${id}」的 reasoningEfforts 含非法值：${illegal}（只支持 low / medium / high / xhigh / max）`);
      }
    }

    return {
      id,
      providerId,
      model,
      label: str(m.label) || model,
      contextWindow,
      maxOutput,
      supportsReasoning,
      reasoningEfforts,
      supportsTemperature: m.supportsTemperature !== false,
      enabled: m.enabled !== false,
    };
  });
}

function normalizeAgents(input, models) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('agents 必须是对象');
  const modelIds = new Set(models.map((m) => m.id));
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!AGENT_KEYS.includes(key)) throw bad(`未知的 Agent：${key}`);
    if (!value || typeof value !== 'object') throw bad(`Agent「${key}」的配置必须是对象`);

    const modelId = str(value.modelId) || null;
    if (modelId && !modelIds.has(modelId)) throw bad(`Agent「${key}」引用了不存在的模型：${modelId}`);

    const effort = value.effort == null || value.effort === '' ? null : str(value.effort);
    if (effort && !EFFORTS.includes(effort)) {
      throw bad(`Agent「${key}」的推理强度必须是 low / medium / high / xhigh / max`);
    }

    const temperature = value.temperature == null || value.temperature === '' ? null : Number(value.temperature);
    if (temperature != null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      throw bad(`Agent「${key}」的温度必须在 0–2 之间`);
    }

    let maxTokens = value.maxTokens == null || value.maxTokens === '' ? null : Number(value.maxTokens);
    if (maxTokens != null) {
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) throw bad(`Agent「${key}」的 maxTokens 必须是正整数`);
      maxTokens = Math.trunc(maxTokens);
    }

    result[key] = { modelId, effort, temperature, maxTokens };
  }
  return result;
}

/**
 * 保存运行期配置（全量替换）。请求体可以是 `{providers,models,agents}`，
 * 也接受 `{runtime:{...}}` 包一层。保存后无需重启，下一轮调用即生效。
 */
export function saveRuntimeConfig(body) {
  const input = body && typeof body === 'object' && body.runtime && typeof body.runtime === 'object'
    ? body.runtime
    : body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('请求体必须是对象');

  const old = loadRaw();
  const providers = normalizeProviders(input.providers, old);
  const models = normalizeModels(input.models, providers);
  const agents = normalizeAgents(input.agents, models);

  const raw = { version: CONFIG_VERSION, providers, models, agents };
  setMeta(META_KEY, JSON.stringify(raw));
  cacheLoaded = true;
  cacheRaw = raw;
  return getEffectiveConfig();
}

/** 删除运行期配置，回到 .env 默认（同样立即生效）。 */
export function resetRuntimeConfig() {
  deleteMeta(META_KEY);
  cacheLoaded = true;
  cacheRaw = null;
  return getEffectiveConfig();
}
