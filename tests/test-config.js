#!/usr/bin/env node
/**
 * tests/test-config.js — 运行期模型配置层（model-registry）
 *
 * 覆盖：
 *   - 未保存配置时，resolveAgent / resolveContextWindow / resolveModelTarget 与 .env 逐项一致
 *   - GET 视图只给掩码（apiKey 永不明文，hasKey + 末 4 位）
 *   - 保存后立即生效（DB 覆盖合并）、DELETE 后回到 .env
 *   - 单次 override 优先于 DB 绑定（llm.js 的解析顺序）
 *   - apiKey 语义：省略 / '***' 保留、'' 清除、同 .env 地址时回落 .env
 *   - 保存校验：未知 Agent、坏 URL、非法 protocol、重复 id、越界温度等一律 400
 *   - 不写迁移：只读写 meta 表的一个键，删除该键即等价于从未保存
 */
import './load-env.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DB_PATH = path.join(os.tmpdir(), `narra-config-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;

const registry = await import('../server/model-registry.js');
const {
  AGENT_KEYS, EFFORTS, PROTOCOLS, getEffectiveConfig, resetRuntimeConfig,
  resolveAgent, resolveContextWindow, resolveModelTarget, saveRuntimeConfig,
} = registry;
const { config } = await import('../server/config.js');
const store = await import('../server/memory/store.js');

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function expectBad(body, label) {
  try {
    saveRuntimeConfig(body);
    ok(false, label, '没有抛错');
  } catch (err) {
    ok(err?.status === 400 && !!err.message, label, `status=${err?.status} message=${err?.message}`);
  }
}

const ENV_KEY = config.upstream.apiKey;
const ENV_HINT = ENV_KEY.slice(-4);
const envMaxOutput = Math.max(...AGENT_KEYS.map((k) => Number(config.agents[k].maxTokens)));
const baseProvider = () => ({
  id: 'p1',
  name: '测试服务商',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-000000000000abcd',
  protocol: 'openai',
  enabled: true,
});
const baseModel = () => ({
  id: 'm1',
  providerId: 'p1',
  model: 'test-model-large',
  label: 'Test Large',
  contextWindow: 32000,
  maxOutput: 8000,
  supportsReasoning: true,
  reasoningEfforts: ['low', 'medium', 'high'],
  supportsTemperature: true,
  enabled: true,
});
const baseConfig = () => ({ providers: [baseProvider()], models: [baseModel()] });

console.log('\n=== 1. 未保存配置：与 .env / config.agents 逐项相等 ===');
{
  const view = getEffectiveConfig();
  eq(view.source, 'env', 'source=env');
  eq(view.providers.length, 1, '只有一个 .env 种子服务商');
  eq(view.providers[0].id, 'env-provider', '种子服务商 id');
  eq(view.providers[0].baseUrl, config.upstream.baseUrl.replace(/\/+$/, ''), '种子 baseUrl = STEPFUN_BASE_URL');
  eq(view.providers[0].apiKey, '', 'GET 视图不回显明文 apiKey');
  eq(view.providers[0].hasKey, !!ENV_KEY, 'hasKey 反映 .env 是否配置 key');
  eq(view.providers[0].keyHint, ENV_HINT, 'keyHint = 末 4 位');
  eq(view.models.length, 1, '只有一个 .env 种子模型');
  eq(view.models[0].model, config.upstream.model, '种子模型 = STEPFUN_MODEL');
  eq(view.models[0].contextWindow, config.context.maxTokens, '种子 contextWindow = CONTEXT_MAX_TOKENS');
  eq(view.models[0].maxOutput, envMaxOutput, '种子 maxOutput = 各 Agent maxTokens 最大值');
  eq(view.context.hard_max_tokens, config.context.maxTokens, 'hard_max_tokens = CONTEXT_MAX_TOKENS');
  eq(view.context.soft_target_tokens, Math.min(config.context.softTokens, config.context.maxTokens), 'soft_target_tokens 被硬上限夹住');
  eq(view.options.efforts, EFFORTS, 'efforts 枚举');
  eq(view.options.protocols, PROTOCOLS, 'protocols 枚举');
  eq(view.options.agent_keys, AGENT_KEYS, 'agent_keys 枚举');

  for (const key of AGENT_KEYS) {
    const envCfg = config.agents[key];
    const resolved = resolveAgent(key);
    eq(resolved.source, 'env', `${key}.source=env`);
    eq(resolved.effort, envCfg.reasoningEffort, `${key}.effort = ${envCfg.reasoningEffort}`);
    eq(resolved.temperature, envCfg.temperature, `${key}.temperature = ${envCfg.temperature}`);
    eq(resolved.maxTokens, envCfg.maxTokens, `${key}.maxTokens = ${envCfg.maxTokens}`);
    eq(resolved.model, envCfg.model || config.upstream.model, `${key}.model = ${envCfg.model || 'STEPFUN_MODEL'}`);
    eq(resolved.baseUrl, config.upstream.baseUrl.replace(/\/+$/, ''), `${key}.baseUrl = STEPFUN_BASE_URL`);
  }

  eq(resolveContextWindow('narrator'), config.context.maxTokens, 'resolveContextWindow = .env 硬上限');
  const target = resolveModelTarget({ agent: 'narrator' });
  eq(target.baseUrl, config.upstream.baseUrl.replace(/\/+$/, ''), 'resolveModelTarget.baseUrl');
  eq(target.apiKey, ENV_KEY, 'resolveModelTarget.apiKey 取 .env（服务端内部使用，不出网）');
  eq(target.model, config.agents.narrator.model || config.upstream.model, 'resolveModelTarget.model');
  eq(target.maxTokens, config.agents.narrator.maxTokens, 'resolveModelTarget.maxTokens');
  eq(target.effort, config.agents.narrator.reasoningEffort, 'resolveModelTarget.effort');
  eq(target.temperature, config.agents.narrator.temperature, 'resolveModelTarget.temperature');
  eq(resolveModelTarget({ model: 'custom-model-x' }).model, 'custom-model-x', '未登记的 model 名按原样转发');
  eq(resolveModelTarget({ model: 'custom-model-x' }).baseUrl, config.upstream.baseUrl.replace(/\/+$/, ''), '未登记 model 沿用 .env 传输目标');
}

console.log('\n=== 2. 保存：掩码 + DB 生效 + 未绑定的 Agent 继续走 .env ===');
{
  const body = {
    providers: [baseProvider()],
    models: [baseModel()],
    agents: {
      narrator: { modelId: 'm1', effort: 'low', temperature: 0.5, maxTokens: 4000 },
    },
  };
  const saved = saveRuntimeConfig(body);
  eq(saved.source, 'db', '保存后 source=db');
  eq(saved.providers[0].apiKey, '', '保存响应同样不回显明文');
  eq(saved.providers[0].keyHint, 'abcd', '保存响应给 keyHint');
  ok(!JSON.stringify(saved).includes('sk-test-000000000000abcd'), '保存响应里没有完整密钥');
  eq(store.getMeta('runtime_config_v1') !== null, true, '明文只存在 meta 表 runtime_config_v1');

  const narrator = resolveAgent('narrator');
  eq(narrator.source, 'db', 'narrator.source=db');
  eq(narrator.effort, 'low', 'narrator.effort 取绑定');
  eq(narrator.temperature, 0.5, 'narrator.temperature 取绑定');
  eq(narrator.maxTokens, 4000, 'narrator.maxTokens 取绑定');
  eq(narrator.model, 'test-model-large', 'narrator.model 取绑定模型');
  eq(narrator.baseUrl, 'https://api.example.com/v1', 'narrator.baseUrl 取绑定服务商');
  eq(narrator.apiKey, 'sk-test-000000000000abcd', 'narrator.apiKey 取绑定服务商（服务端内部）');

  const branch = resolveAgent('branch');
  eq(branch.source, 'env', '未绑定的 branch 继续 source=env');
  eq(branch.effort, config.agents.branch.reasoningEffort, '未绑定的 branch 参数不变');
  eq(branch.model, config.agents.branch.model || config.upstream.model, '未绑定的 branch 模型不变');

  eq(resolveContextWindow('narrator'), 32000, '硬上限跟随绑定模型的 contextWindow');
  eq(getEffectiveConfig().context.hard_max_tokens, 32000, 'GET 视图 hard_max_tokens 同步');
  eq(getEffectiveConfig().context.soft_target_tokens, Math.min(config.context.softTokens, 32000), '软目标仍被夹住');

  const target = resolveModelTarget({ agent: 'narrator' });
  eq(target.baseUrl, 'https://api.example.com/v1', 'resolveModelTarget.baseUrl 走 DB');
  eq(target.apiKey, 'sk-test-000000000000abcd', 'resolveModelTarget.apiKey 走 DB');
  eq(target.model, 'test-model-large', 'resolveModelTarget.model 走 DB');
  eq(target.maxTokens, 4000, 'resolveModelTarget.maxTokens 走绑定');

  // 单次 override 必须优先于 DB 绑定（llm.js 的解析顺序）。
  const overridden = resolveModelTarget({ agent: 'narrator', model: 'one-shot-model' });
  eq(overridden.model, 'one-shot-model', '显式 model override 压过 DB 绑定');
  eq(overridden.baseUrl, 'https://api.example.com/v1', 'override 只换 model 名，仍用绑定服务商');
}

console.log('\n=== 3. apiKey 语义：*** / 省略保留，空串清除，同 .env 地址回落 ===');
{
  const bindNarrator = { narrator: { modelId: 'm1' } };
  const preset = saveRuntimeConfig({ ...baseConfig(), agents: bindNarrator });
  eq(preset.providers[0].hasKey, true, '首次保存后 hasKey=true');
  eq(resolveAgent('narrator').apiKey, 'sk-test-000000000000abcd', '绑定后解析走该服务商的 key');

  const keep1 = saveRuntimeConfig({ ...baseConfig(), providers: [{ ...baseProvider(), apiKey: '***' }], agents: bindNarrator });
  eq(keep1.providers[0].keyHint, 'abcd', "'***' 保留旧 key（末 4 位不变）");
  eq(resolveAgent('narrator').apiKey, 'sk-test-000000000000abcd', "'***' 后解析仍拿到旧 key");

  const keep2 = saveRuntimeConfig({
    providers: [{ id: 'p1', name: '测试服务商', baseUrl: 'https://api.example.com/v1', protocol: 'openai' }],
    models: [baseModel()],
    agents: bindNarrator,
  });
  eq(keep2.providers[0].keyHint, 'abcd', '省略 apiKey 同样保留旧 key');

  const cleared = saveRuntimeConfig({ ...baseConfig(), providers: [{ ...baseProvider(), apiKey: '' }], agents: bindNarrator });
  eq(cleared.providers[0].hasKey, false, "apiKey='' 清除（地址与 .env 不同，不再回落）");
  eq(cleared.providers[0].keyHint, '', '清除后 keyHint 为空');
  eq(resolveAgent('narrator').apiKey, '', '清除后解析得到空 key（调用时会 401，不会被静默换成别的 key）');

  // 地址仍是 .env 上游：空 key 回落 .env，避免「界面保存一次后反而不能用了」。
  const envUrl = config.upstream.baseUrl.replace(/\/+$/, '');
  const fallback = saveRuntimeConfig({
    providers: [{ id: 'p1', name: '同 .env 上游', baseUrl: envUrl, protocol: 'openai' }],
    models: [baseModel()],
    agents: bindNarrator,
  });
  eq(fallback.providers[0].hasKey, !!ENV_KEY, '同 .env 地址时 hasKey 回落到 .env');
  if (ENV_KEY) eq(fallback.providers[0].keyHint, ENV_HINT, '同 .env 地址时 keyHint 取 .env 末 4 位');
  resetRuntimeConfig();
}

console.log('\n=== 4. 保存校验：非法输入一律 400 ===');
{
  expectBad({ providers: [], models: [baseModel()] }, 'providers 空数组');
  expectBad({ providers: [baseProvider()], models: [] }, 'models 空数组');
  expectBad({ ...baseConfig(), providers: [{ ...baseProvider(), baseUrl: 'not-a-url' }] }, 'baseUrl 不是 URL');
  expectBad({ ...baseConfig(), providers: [{ ...baseProvider(), baseUrl: 'ftp://example.com/v1' }] }, 'baseUrl 非 http/https');
  expectBad({ ...baseConfig(), providers: [{ ...baseProvider(), protocol: 'anthropic' }] }, '不支持的 protocol');
  expectBad({
    ...baseConfig(),
    providers: [baseProvider(), { ...baseProvider(), id: 'p1', baseUrl: 'https://b.example.com/v1' }],
  }, '服务商 id 重复');
  expectBad({
    providers: [baseProvider()],
    models: [{ ...baseModel(), providerId: 'missing' }],
  }, '模型引用不存在的服务商');
  expectBad({ ...baseConfig(), models: [{ ...baseModel(), contextWindow: 0 }] }, 'contextWindow=0');
  expectBad({ ...baseConfig(), models: [{ ...baseModel(), maxOutput: -100 }] }, 'maxOutput 负数');
  expectBad({ ...baseConfig(), models: [{ ...baseModel(), model: '  ' }] }, '模型上游名为空');
  expectBad({ ...baseConfig(), models: [{ ...baseModel(), reasoningEfforts: ['low', 'extreme'] }] }, 'reasoningEfforts 非法值');
  expectBad({ ...baseConfig(), models: [{ ...baseModel(), reasoningEfforts: [] }] }, '支持推理的模型 reasoningEfforts 空数组');
  expectBad({ ...baseConfig(), agents: { narrator: { effort: 'max' } } }, "Agent effort='max'（.env 可写，DB 不收）");
  expectBad({ ...baseConfig(), agents: { narrator: { temperature: 3 } } }, 'Agent 温度越界');
  expectBad({ ...baseConfig(), agents: { narrator: { maxTokens: 0 } } }, 'Agent maxTokens 非正数');
  expectBad({ ...baseConfig(), agents: { seniorArchivist: { effort: 'low' } } }, '未知 Agent key');
  expectBad({ ...baseConfig(), agents: { narrator: { modelId: 'missing' } } }, 'Agent 引用不存在的模型');
  eq(getEffectiveConfig().source, 'env', '校验失败不写库（仍 source=env）');
}

console.log('\n=== 5. 多服务商 / 多模型 / 停用回落 / 重置 ===');
{
  saveRuntimeConfig({
    providers: [
      { id: 'p1', name: '主服务商', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-main-key-9999', protocol: 'openai' },
      { id: 'p2', name: '便宜服务商', baseUrl: 'https://cheap.example.com/v1', apiKey: 'sk-cheap-key-8888', protocol: 'openai' },
    ],
    models: [
      { ...baseModel(), id: 'm1', model: 'test-model-large' },
      { ...baseModel(), id: 'm2', providerId: 'p2', model: 'cheap-model', contextWindow: 16000, maxOutput: 4000 },
      { ...baseModel(), id: 'm3', model: 'no-reasoning-model', supportsReasoning: false, reasoningEfforts: [] },
    ],
    agents: {
      narrator: { modelId: 'm1', effort: 'high', temperature: 0.9, maxTokens: 12000 },
      branch: { modelId: 'm2', effort: 'low', temperature: 0.2, maxTokens: null },
      librarian: { modelId: 'm3' },
    },
  });

  eq(resolveAgent('branch').model, 'cheap-model', '不同 Agent 绑定不同服务商的模型');
  eq(resolveAgent('branch').baseUrl, 'https://cheap.example.com/v1', 'branch.baseUrl 取自己的服务商');
  eq(resolveAgent('branch').maxTokens, 4000, 'maxTokens 为空时跟随模型 maxOutput');
  eq(resolveAgent('branch').contextWindow, 16000, 'contextWindow 取绑定模型');

  // 不支持推理的模型允许 reasoningEfforts=[]，解析出的 effort 必须清空。
  const noReasoning = getEffectiveConfig().models.find((m) => m.id === 'm3');
  eq(noReasoning.reasoningEfforts.length, 0, '非推理模型保存后 reasoningEfforts 为空数组');
  eq(resolveAgent('librarian').supportsReasoning, false, '非推理模型 supportsReasoning=false');
  eq(resolveAgent('librarian').effort, null, '非推理模型的 effort 被清空');

  // 停用服务商：其模型静默回落 .env，保证回合不因配置改动中断。
  saveRuntimeConfig({
    providers: [
      { id: 'p1', name: '主服务商', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-main-key-9999', protocol: 'openai', enabled: true },
      { id: 'p2', name: '便宜服务商', baseUrl: 'https://cheap.example.com/v1', apiKey: 'sk-cheap-key-8888', protocol: 'openai', enabled: false },
    ],
    models: [
      { ...baseModel(), id: 'm1', model: 'test-model-large' },
      { ...baseModel(), id: 'm2', providerId: 'p2', model: 'cheap-model', contextWindow: 16000, maxOutput: 4000 },
      { ...baseModel(), id: 'm3', model: 'no-reasoning-model', supportsReasoning: false, reasoningEfforts: [] },
    ],
    agents: { narrator: { modelId: 'm1' }, branch: { modelId: 'm2' }, librarian: { modelId: 'm3' } },
  });
  eq(resolveAgent('branch').source, 'db', '绑定存在时 source 仍是 db');
  eq(resolveAgent('branch').model, config.agents.branch.model || config.upstream.model, '停用服务商的模型回落 .env 模型');
  eq(resolveAgent('branch').baseUrl, config.upstream.baseUrl.replace(/\/+$/, ''), '停用服务商回落 .env 传输目标');

  // 重置：删除 meta 键，回到 .env，旧字段与第 1 节一致。
  const afterReset = resetRuntimeConfig();
  eq(afterReset.source, 'env', 'reset 后 source=env');
  eq(afterReset.providers.length, 1, 'reset 后只剩种子服务商');
  eq(store.getMeta('runtime_config_v1'), null, 'reset 删除 meta 键（等价于从未保存）');
  eq(resolveAgent('narrator').effort, config.agents.narrator.reasoningEffort, 'reset 后参数回到 .env');
  eq(resolveContextWindow('narrator'), config.context.maxTokens, 'reset 后硬上限回到 .env');
  eq(getEffectiveConfig().context.hard_max_tokens, config.context.maxTokens, 'reset 后 GET 视图回到 .env');
}

console.log('\n=== 6. 幂等：重复保存同一份配置结果稳定 ===');
{
  const body = { providers: [baseProvider()], models: [baseModel()], agents: { narrator: { modelId: 'm1' } } };
  const first = saveRuntimeConfig(body);
  const second = saveRuntimeConfig({ ...body, providers: [{ ...baseProvider(), apiKey: '***' }] });
  eq(first.providers[0].keyHint, second.providers[0].keyHint, '重复保存（***）不改变掩码');
  eq(second.source, 'db', '重复保存后 source=db');
  eq(second.agents.narrator.modelId, 'm1', 'Agent 绑定稳定');
  resetRuntimeConfig();
}

console.log('\n=== 7. meta 表读写（不写迁移，只有这一个键） ===');
{
  store.setMeta('test-key', 'v1');
  eq(store.getMeta('test-key'), 'v1', 'setMeta/getMeta 往返');
  store.setMeta('test-key', 'v2');
  eq(store.getMeta('test-key'), 'v2', 'setMeta 覆盖');
  eq(store.deleteMeta('test-key'), true, 'deleteMeta 删除存在的键返回 true');
  eq(store.getMeta('test-key'), null, '删除后读回 null');
  eq(store.deleteMeta('test-key'), false, '重复删除返回 false');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
try {
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(`${DB_PATH}-wal`, { force: true });
  fs.rmSync(`${DB_PATH}-shm`, { force: true });
} catch { /* 清理失败不影响结果 */ }
if (fail > 0) process.exit(1);
