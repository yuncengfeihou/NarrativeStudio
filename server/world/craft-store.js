/**
 * server/world/craft-store.js — 工艺取值表的持久化（meta 表的一个键）
 *
 * 为什么单独一个文件：`craft.js` 是纯函数模块（不读库、不建表），
 * 而「作者能在界面里改这些条目」需要落盘。把读写拆出来，
 * 纯函数层仍然可以脱离数据库单测（tests/test-context.js 就是这么用的）。
 *
 * 形状（key = `craft_config_v1`）：
 *   {
 *     preset:   { default: 'light', options: [{value, label, desc, text}, …] },
 *     dialogue: { default: 'default', options: [{value, label, desc, text}, …] },
 *     pacing:   { default: 'bold', options: [{value, label, desc, tail, branch}, …] },
 *   }
 *
 * 不写迁移：键不存在 = 从未自定义 = 用内置表。删掉这个键就等价于恢复内置
 * （与 `runtime_config_v1` 同一套语义，见 AGENTS.md §1.3）。
 */
import { getMeta, setMeta, deleteMeta } from '../memory/store.js';
import { applyCraftConfig, normalizeCraftConfig, craftConfigView } from './craft.js';

const CRAFT_CONFIG_KEY = 'craft_config_v1';

/** 读存储里的原始配置；不存在返回 null，损坏返回 `{__corrupt:true}`。 */
export function loadCraftConfigRaw() {
  const raw = getMeta(CRAFT_CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { __corrupt: true };
  } catch {
    return { __corrupt: true };
  }
}

/**
 * 启动时把存储里的配置装进 craft.js 的当前表。
 *
 * 存储损坏或某轴校验失败时该轴回落到内置表（服务照常运行），
 * 问题进 `craftConfigView().problems` 并在设置页显示——**不静默**。
 */
export function initCraftConfig() {
  const raw = loadCraftConfigRaw();
  if (raw?.__corrupt) {
    applyCraftConfig(null, { extraProblems: ['存储里的工艺配置不是合法 JSON，已退回内置表'] });
    return craftConfigView();
  }
  applyCraftConfig(raw, { source: raw ? 'db' : 'builtin' });
  return craftConfigView();
}

/**
 * 保存一份配置：**先校验，再生效，最后落盘**。
 *
 * 顺序很重要：校验失败时绝不能写库，否则下次启动会带着坏配置起来。
 * 生效与落盘用同一份归一结果，避免「存的和跑的不是同一份」。
 *
 * @returns {{ok:true, view:object} | {ok:false, error:string, problems:string[]}}
 */
export function saveCraftConfig(body) {
  const src = body && typeof body === 'object' ? body : {};
  // 空对象 = 恢复内置（与 DELETE 同义），不是"存一份空配置"。
  if (!Object.keys(src).length) {
    resetCraftConfig();
    return { ok: true, view: craftConfigView() };
  }
  const { tables, defaults, problems } = normalizeCraftConfig(src);
  if (problems.length) return { ok: false, error: problems[0], problems };
  const payload = serialize({ tables, defaults });
  applyCraftConfig(payload, { source: 'db' });
  setMeta(CRAFT_CONFIG_KEY, JSON.stringify(payload));
  return { ok: true, view: craftConfigView() };
}

/** 删除自定义，回到内置表。 */
export function resetCraftConfig() {
  deleteMeta(CRAFT_CONFIG_KEY);
  applyCraftConfig(null);
}

/** 把归一后的表序列化成存储形状（与 `craftConfigView()` 的 axes 同构）。 */
function serialize({ tables, defaults }) {
  const out = {};
  for (const axis of Object.keys(tables)) {
    out[axis] = {
      default: defaults[axis],
      options: Object.values(tables[axis]).map((e) => ({ ...e })),
    };
  }
  return out;
}
