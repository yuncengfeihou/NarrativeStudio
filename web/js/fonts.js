/**
 * fonts.js — 字体枚举与字体栈工具
 *
 * 网页本身不能直接读系统字体目录。Chromium 系浏览器提供了
 * Local Font Access API（window.queryLocalFonts），它会在用户点击后
 * 请求一次授权，然后返回本机所有字体族。Safari / Firefox 没有这个接口，
 * 所以这里同时提供常用字体清单和手动输入作为降级路径。
 *
 * 存储约定：偏好里存字体族名（如「思源宋体」）或完整字体栈。
 * 完整栈用于内置预设；用户从列表里选中的一律是族名。
 */

/** 阅读字体预设。stack 为空表示跟随出厂默认。 */
export const FONT_PRESETS = [
  {
    id: 'system',
    label: '系统默认',
    hint: '无衬线，长读不累',
    stack: '',
  },
  {
    id: 'serif',
    label: '衬线 · 宋体系',
    hint: '书面感强，适合权谋/古风',
    stack: '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", SimSun, "STSong", NSimSun, serif',
  },
  {
    id: 'hei',
    label: '黑体',
    hint: '笔画粗，对比强',
    stack: '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans CJK SC", SimHei, sans-serif',
  },
  {
    id: 'kai',
    label: '楷体',
    hint: '手写感，适合回忆/书信',
    stack: '"Kaiti SC", KaiTi, STKaiti, "Noto Serif CJK SC", serif',
  },
  {
    id: 'wenkai',
    label: '霞鹜文楷',
    hint: '偏手写的宋楷，适合长篇',
    stack: '"LXGW WenKai", "霞鹜文楷", "Kaiti SC", KaiTi, serif',
  },
  {
    id: 'yuan',
    label: '圆体',
    hint: '柔和，适合日常/治愈',
    stack: '"Yuanti SC", "Hiragino Maru Gothic ProN", YouYuan, "Noto Sans CJK SC", sans-serif',
  },
  {
    id: 'mono',
    label: '等宽',
    hint: '机械感，适合科幻/日志',
    stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace',
  },
];

/** 无法读取本机字体时展示的常见字体。不代表一定已安装，仍会自动回退。 */
export const COMMON_FONTS = [
  'PingFang SC', 'Songti SC', 'Kaiti SC', 'Heiti SC', 'Yuanti SC',
  'Microsoft YaHei', 'Microsoft JhengHei', 'SimSun', 'SimHei', 'KaiTi',
  'FangSong', 'STKaiti', 'STSong', 'STFangsong', 'YouYuan', 'DengXian',
  'Source Han Sans SC', 'Source Han Serif SC', 'Noto Sans CJK SC', 'Noto Serif CJK SC',
  'LXGW WenKai', 'Smiley Sans', 'Hiragino Sans GB', 'WenQuanYi Micro Hei',
  'Georgia', 'Times New Roman', 'Palatino', 'Optima', 'Arial', 'Helvetica Neue',
  'Segoe UI', 'SF Pro Text', 'Inter', 'Menlo', 'Consolas', 'JetBrains Mono', 'Fira Code',
];

let cache = null;
let pending = null;

/** 当前浏览器是否支持读取本机字体。 */
export function supportsLocalFonts() {
  return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';
}

/**
 * 读取本机字体族（去重、按中文优先排序）。
 * 必须在用户手势里首次调用，浏览器会弹一次授权。
 * @returns {Promise<string[]>}
 */
export async function listLocalFonts({ force = false } = {}) {
  if (!supportsLocalFonts()) throw new Error('unsupported');
  if (cache && !force) return cache;
  if (pending) return pending;

  pending = window.queryLocalFonts()
    .then((fonts) => {
      const families = new Set();
      for (const font of fonts || []) {
        const family = String(font?.family || '').trim();
        if (family) families.add(family);
      }
      const collator = new Intl.Collator(['zh-Hans-CN', 'en'], { sensitivity: 'base', numeric: true });
      cache = [...families].sort(collator.compare);
      return cache;
    })
    .finally(() => { pending = null; });

  return pending;
}

/* ------------------------------------------------------------------ */
/* 字体栈                                                              */
/* ------------------------------------------------------------------ */

function quoteFamily(name) {
  return `"${String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 把偏好值转成可直接写进 CSS 的字体栈。
 * 值里已经有逗号时视为完整栈，否则当成一个族名补引号。
 * @param {string} value
 * @param {string} fallback CSS 变量或字体族
 */
export function fontStack(value, fallback = 'var(--font-ui)') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const stack = raw.includes(',') ? raw : quoteFamily(raw);
  return `${stack}, ${fallback}`;
}

/** 用于界面展示的短名字：取栈里的第一个族名。 */
function fontLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '系统默认';
  const first = raw.split(',')[0].trim().replace(/^["']|["']$/g, '');
  return first || '系统默认';
}

/** 展示名：内置预设显示「衬线 · 宋体系」，其他显示族名。 */
export function fontDisplayName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '系统默认';
  const preset = FONT_PRESETS.find((p) => p.stack === raw);
  return preset ? preset.label : fontLabel(raw);
}
