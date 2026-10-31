/**
 * 回放校验：这一拍的旁白有没有把最近一两拍的原文整段重演 / 逐字照搬。
 *
 * 为什么需要它（D7 基线局实测）：45 拍基线局 `ade41ef2` 的 t44 把 t42 的
 * 「喂药 → 女人递纸 → 皮鞋停在门外」整段重写了一遍，时间还从天已大亮**倒退**，
 * 末段约 480 字逐字相同（CJK 去标点后最长公共子串 244 字）；那一拍玩家行动只有
 * 16 字纯意图（「做出决定，去告诉奶奶，让她别送。」）。这不是文风漂移，是
 * 「行动模糊 + recent 层逐字原文」时模型直接回放上一拍。
 *
 * 判据是确定性的（CJK 最长公共子串），只在旁白产出后使用一次：
 * 命中 → 走 narrator **既有的** guidance 通道同等级重写一次（不新增注入点、
 * 不改推理等级），仍照搬就如实记 `patches(kind='narrator_replay')` 并保留。
 *
 * 本文件是纯函数：不读库、不写库、不进提示词。运行期与 `_work/longrun-report.mjs`
 * 的 `repeat_longest` 判据共用同一口径（报告侧保留自己的实现是为了不改 _work 的
 * 依赖方向；两边阈值与算法必须一致，改一处要改两处）。
 */

/** 判「照搬」的阈值（CJK 字）：报告 `repeat_longest` 的 FAIL 线就是 100 字。 */
export const REPLAY_MIN_CJK = 100;

/** 回头比对几拍。1 拍会漏「隔一拍回放」（t42→t44 正是这种）。 */
export const REPLAY_WINDOW_TURNS = 2;

/** 只留汉字：标点、空白、数字与拉丁字符都不进比对。 */
export function cjkOnly(text) {
  return String(text || '').replace(/[^\u4e00-\u9fff]/g, '');
}

/**
 * 两段文本的最长公共 CJK 子串。返回 { length, text }。
 * 用滚动数组 DP（短串在列方向），2600 字 × 2600 字约 6.8M 次比较，实测 ~20ms。
 */
export function longestCommonCjk(a, b) {
  const x = cjkOnly(a);
  const y = cjkOnly(b);
  if (!x.length || !y.length) return { length: 0, text: '' };
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  const n = short.length;
  let prev = new Uint16Array(n + 1);
  let cur = new Uint16Array(n + 1);
  let best = 0;
  let bestEnd = 0;
  for (let i = 1; i <= long.length; i += 1) {
    const ch = long.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      if (ch === short.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) { best = v; bestEnd = j; }
      } else {
        cur[j] = 0;
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return { length: best, text: short.slice(bestEnd - best, bestEnd) };
}

/**
 * 判这一拍是否在回放。
 *
 * @param {object} opts
 * @param {string} opts.content 本拍旁白正文
 * @param {Array<{turn_no:number, content:string}>} opts.recent 最近几拍的旁白（旧的在前）
 * @param {number} [opts.min] 阈值，默认 REPLAY_MIN_CJK
 * @param {number} [opts.window] 只看最后几拍，默认 REPLAY_WINDOW_TURNS
 * @returns {{hit:boolean, length:number, text:string, turn_no:number|null, ratio:number}}
 */
export function detectReplay({ content, recent = [], min = REPLAY_MIN_CJK, window = REPLAY_WINDOW_TURNS }) {
  const rows = (recent || []).filter((r) => r && String(r.content || '').trim());
  const picked = window > 0 ? rows.slice(-window) : rows;
  const total = cjkOnly(content).length || 1;
  let best = { hit: false, length: 0, text: '', turn_no: null, ratio: 0 };
  for (const r of picked) {
    const found = longestCommonCjk(content, r.content);
    if (found.length > best.length) {
      best = {
        hit: found.length >= min,
        length: found.length,
        text: found.text,
        turn_no: r.turn_no ?? null,
        ratio: found.length / total,
      };
    }
  }
  return best;
}
