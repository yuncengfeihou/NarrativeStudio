/**
 * panels/timeline.js — 时间轴面板
 *
 * 时间轴有两条来源，过去从来没有被合到一张图上：
 *   1. `card.timeline` —— 作者写死的既定事实（canon='past'）与原著后续（canon='future'）。
 *   2. `scenes`       —— 这一局真实发生的每一场，从完整原文重写，带 when_label / place / importance。
 *
 * 这里把它们排成一条连续的轴：既定事实在上游，这一局在中间，原著后续在末端并明确标注
 * 「不会注入提示词」（红线 §1.1.3：future 是校勘参考，不是演绎目标）。
 *
 * 粒度由 importance 决定，而 importance 是确定性规则算出来的（memory-pipeline.js:123-125），
 * 不靠模型自评：有 key_detail / hooks / threads → major；有 question / outcome → normal；
 * 都没有 → minor。所以「重要/大事件」不需要新字段，只需要按这个字段分层渲染。
 *
 * 本面板是纯只读投影：不写库、不新增端点、不影响上下文装配。
 */
import { el, clear, fmtNumber } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { openSheet } from '../app.js';

const IMPORTANCE = {
  major: { label: '大事件', rank: 0 },
  normal: { label: '推进', rank: 1 },
  minor: { label: '过渡', rank: 2 },
};

/** 打开中的面板，供 play.js 在切场/收尾时刷新。 */
const openPanels = new Set();

export function refreshTimelinePanels() {
  for (const p of [...openPanels]) {
    if (!p.isConnected()) { openPanels.delete(p); continue; }
    p.refresh();
  }
}

function placeOf(scene) {
  return String(scene.place || '').trim();
}

/**
 * 把「上一场的地点」与「这一场的地点」比较，判断是否值得显示地点条。
 * 地点没变就不重复显示——一条轴上一半的行都挂着同一个地名是噪音。
 */
function shouldShowPlace(scene, prev) {
  const here = placeOf(scene);
  if (!here) return false;
  if (!prev) return true;
  if (here !== placeOf(prev)) return true;
  return scene.importance === 'major';
}

function sceneNode(scene, prev, { onJump } = {}) {
  const level = IMPORTANCE[scene.importance] ? scene.importance : 'normal';
  const moved = prev ? placeOf(scene) !== placeOf(prev) && !!placeOf(prev) : false;
  const range = scene.turn_from === scene.turn_to
    ? `第 ${scene.turn_from} 轮`
    : `第 ${scene.turn_from}-${scene.turn_to} 轮`;

  const meta = el('div.tlx-meta', {},
    el('span.tlx-id', {}, scene.scene_id || ''),
    el('span.tlx-range', {}, range),
    scene.when_label ? el('span.tlx-when', {}, scene.when_label) : null,
    el('span.tlx-badge', { class: `tlx-badge is-${level}` }, IMPORTANCE[level].label),
  );

  const bits = [];
  if (shouldShowPlace(scene, prev)) {
    bits.push(el('div', { class: `tlx-place${moved ? ' is-moved' : ''}` },
      icon('mapPin', { size: 11 }),
      el('span', {}, placeOf(scene)),
      moved ? el('span.tlx-place-was', {}, `（此前来处：${placeOf(prev)}）`) : null,
    ));
  }
  if (scene.question) bits.push(el('div.tlx-q', {}, `本场在问：${scene.question}`));
  if (scene.outcome) bits.push(el('div.tlx-outcome', {}, scene.outcome));

  // major 才展开具体细节与钩子——这正是 importance 存在的理由。
  if (level === 'major') {
    if (scene.key_detail) {
      bits.push(el('div.tlx-detail', {}, el('span.tlx-detail-k', {}, '细节'), scene.key_detail));
    }
    if (scene.causal) {
      bits.push(el('div.tlx-causal', {}, `承接：${scene.causal}`));
    }
    if (scene.hooks?.length) {
      bits.push(el('div.tlx-hooks', {},
        ...scene.hooks.map((h) => el('span.tlx-hook', {}, h)),
      ));
    }
  }
  if (scene.threads?.length) {
    bits.push(el('div.tlx-threads', {},
      ...scene.threads.map((t) => el('span.tlx-thread', {}, `线索 · ${t}`)),
    ));
  }

  const node = el('div', {
    class: `tlx-item is-${level}`,
    role: onJump ? 'button' : null,
    tabindex: onJump ? '0' : null,
    title: onJump ? `跳到第 ${scene.turn_from} 轮` : null,
  },
    el('div.tlx-rail', {}, el('span.tlx-dot')),
    el('div.tlx-body', {}, meta, ...bits),
  );

  if (onJump) {
    node.addEventListener('click', () => onJump(scene.turn_from));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJump(scene.turn_from); }
    });
  }
  return node;
}

/** 作者写死的既定事实：没有 importance，统一按「既定」渲染。 */
function authoredNode(evt, { isFuture }) {
  return el('div', { class: `tlx-item tlx-authored${isFuture ? ' is-future' : ''}` },
    el('div.tlx-rail', {}, el('span.tlx-dot')),
    el('div.tlx-body', {},
      el('div.tlx-meta', {},
        el('span.tlx-when', {}, evt.when || '—'),
        el('span.tlx-badge', {}, isFuture ? '原著后续' : '既定事实'),
      ),
      el('div.tlx-what', {}, evt.what),
      evt.source ? el('div.tlx-src', {}, evt.source) : null,
    ),
  );
}

export async function openTimelinePanel(sessionId, opts = {}) {
  let scenes = [];
  let card = opts.card || null;
  let filter = 'all';
  let loading = true;
  let error = null;

  function summaryBar() {
    const total = scenes.length;
    const major = scenes.filter((s) => s.importance === 'major').length;
    const places = new Set(scenes.map(placeOf).filter(Boolean));
    const last = scenes[scenes.length - 1];
    const chips = [
      { label: '场次', value: fmtNumber(total) },
      { label: '大事件', value: fmtNumber(major) },
      { label: '去过的地点', value: fmtNumber(places.size) },
      { label: '最新', value: last ? `第 ${last.turn_to} 轮` : '—' },
    ];
    return el('div.tlx-summary', {}, ...chips.map((c) => el('div.tlx-chip', {},
      el('span.tlx-chip-v', {}, c.value),
      el('span.tlx-chip-l', {}, c.label),
    )));
  }

  function filterBar() {
    const make = (value, label) => el('button.tlx-tab', {
      type: 'button',
      class: filter === value ? 'is-active' : '',
      onclick: () => { filter = value; paint(); },
    }, label);
    return el('div.tlx-tabs', {},
      make('all', '全部'),
      make('major', '只看大事件'),
      make('place', '按地点'),
    );
  }

  function sceneList() {
    const list = el('div.tlx-axis');
    const shown = scenes.filter((s) => {
      if (filter === 'major') return s.importance === 'major';
      return true;
    });

    if (!shown.length) {
      list.appendChild(el('p.muted', {}, scenes.length
        ? '这一档里还没有场次。'
        : '还没有关过场。第一场会在切场时生成——地点变了、或者到了强制封场的轮数。'));
      return list;
    }

    // 按地点视图：把连续的同一个地点折叠成一个块首，方便看「在哪待了多久」。
    if (filter === 'place') {
      let block = null;
      let blockPlace = null;
      for (const s of shown) {
        const here = placeOf(s) || '（未记录地点）';
        if (!block || here !== blockPlace) {
          blockPlace = here;
          block = el('div.tlx-placeblock', {},
            el('div.tlx-placeblock-head', {},
              icon('mapPin', { size: 12 }),
              el('span', {}, here),
            ),
            el('div.tlx-placeblock-body', {}),
          );
          list.appendChild(block);
        }
        block.querySelector('.tlx-placeblock-body').appendChild(
          el('div.tlx-placeblock-row', {
            class: `is-${s.importance || 'normal'}`,
            onclick: opts.onJump ? () => opts.onJump(s.turn_from) : null,
          },
            el('span.tlx-placeblock-range', {}, `第 ${s.turn_from}${s.turn_to !== s.turn_from ? `-${s.turn_to}` : ''} 轮`),
            el('span.tlx-placeblock-q', {}, s.question || s.outcome || s.scene_id),
          ),
        );
      }
      return list;
    }

    let prev = null;
    for (const s of shown) {
      list.appendChild(sceneNode(s, prev, { onJump: opts.onJump }));
      prev = s;
    }
    return list;
  }

  function authoredSection() {
    const events = card?.timeline || [];
    const past = events.filter((e) => e.canon === 'past');
    const future = events.filter((e) => e.canon === 'future');
    if (!past.length && !future.length) return el('div', {});

    const wrap = el('div.tlx-sect', {});

    if (past.length) {
      wrap.appendChild(el('div.tlx-sect-head', {}, '起点之前 · 既定事实'));
      wrap.appendChild(el('p.tlx-sect-note', {}, '开局时这些事已经发生过，剧情必须与之自洽。'));
      wrap.appendChild(el('div.tlx-axis', {}, ...past.map((e) => authoredNode(e, { isFuture: false }))));
    }

    if (future.length) {
      wrap.appendChild(el('div.tlx-sect-head.is-muted', {}, '原著后续 · 参考'));
      wrap.appendChild(el('p.tlx-sect-note', {},
        '原著里后来发生的事。只作校勘参考，不会注入提示词，也不作为演绎目标——玩家把剧情带偏是正常玩法。'));
      wrap.appendChild(el('div.tlx-axis.is-future', {}, ...future.map((e) => authoredNode(e, { isFuture: true }))));
    }

    return wrap;
  }

  function renderBody() {
    const body = el('div.tlx', {});
    if (loading) {
      body.appendChild(el('p.muted', {}, '载入中…'));
      return body;
    }
    if (error) {
      body.appendChild(el('div.err-bar', {}, `载入失败：${error}`));
      return body;
    }

    body.appendChild(summaryBar());
    body.appendChild(el('div.tlx-sect-head', {}, '这一局 · 场次时间轴'));
    body.appendChild(el('p.tlx-sect-note', {},
      '每场从这一场的完整原文重写，不是摘要的摘要。点任意一场可以跳到对应轮次。'));
    body.appendChild(filterBar());
    body.appendChild(sceneList());
    body.appendChild(authoredSection());
    return body;
  }

  const sheetApi = openSheet({
    title: '时间轴',
    width: 780,
    render(body) {
      clear(body);
      body.appendChild(renderBody());
    },
  });

  function paint() {
    clear(sheetApi.body);
    sheetApi.body.appendChild(renderBody());
  }

  async function refresh() {
    // 面板已被关掉（Escape / 点遮罩）就别再发请求、也别再改 DOM。
    if (!sheetApi.sheet.isConnected) { openPanels.delete(entry); return; }
    try {
      const [scenesRes, sessionRes] = await Promise.all([
        api.getScenes(sessionId),
        card ? Promise.resolve(null) : api.getSession(sessionId).catch(() => null),
      ]);
      scenes = (scenesRes.scenes || []).slice()
        .sort((a, b) => (a.turn_from - b.turn_from) || (a.turn_to - b.turn_to));
      if (!card && sessionRes?.card) card = sessionRes.card;
      error = null;
    } catch (err) {
      console.error('[timeline-panel] refresh failed', err);
      error = err.message || String(err);
    }
    loading = false;
    paint();
  }

  // openSheet 的 close 是内部闭包（Escape 与点遮罩都走它），外部包装拦不住；
  // 所以不挂钩子，而是靠 isConnected 惰性自清——面板移除后下一次刷新自动剔除。
  const entry = { refresh: () => refresh(), isConnected: () => sheetApi.sheet.isConnected };
  openPanels.add(entry);

  await refresh();
  return { ...sheetApi, refresh };
}

export default { openTimelinePanel, refreshTimelinePanels };
