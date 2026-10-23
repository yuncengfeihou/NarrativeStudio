/**
 * panels/memory.js — 记忆与上下文面板（v4）
 *
 * 分区：概览 / 分支 / 场次索引 / 断言账本 / 人物状态 / 线索 / 原声 / 校勘 / 笔记
 *
 * 设计取向：这些数字存在的意义是「让作者知道引擎记得什么」。
 * v4 的记忆是「原文 + 场次 + 断言账本 + 原声」，没有摘要金字塔——
 * 所以这里能看到的每一样东西都能点开看到原文出处。
 */
import { el, clear, fmtNumber, truncate } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { openSheet, toast, confirmDialog } from '../app.js';

const VISIBILITY_LABEL = { public: '公开', engine: '引擎', secret: '只你可知' };
const PATCH_KIND_LABEL = {
  contradiction: '矛盾', knowledge_breach: '知识越界', timeline: '时间线',
  alias: '别名冲突', stale_thread: '线索陈旧', state_jump: '状态跳变',
  offstage_event: '幕后事件', uncertain: '待确认', scene: '场次', assertion: '断言',
  world_change: '世界变化',
};
const SEVERITY_LABEL = { blocker: '阻断', major: '重要', minor: '轻微', info: '提示' };

export async function openMemoryPanel(sessionId, opts = {}) {
  let data = null;
  let assertions = [];
  let states = [];
  let scenes = [];
  let threads = [];
  let voices = [];
  let patches = [];
  let branches = [];
  let worldChanges = [];
  let worldVersion = null;

  function renderBody() {
    const body = el('div', {});
    if (!data) {
      body.appendChild(el('p.muted', {}, '载入中…'));
      return body;
    }

    /* ---------------- 概览 ---------------- */
    const overview = el('div.mem-overview');
    const cards = [
      { label: '回合', value: fmtNumber(data.turn_count), hint: '原文逐字保留，永不修改' },
      { label: '场次', value: fmtNumber(data.scene_count), hint: '每场从完整原文重写，不是摘要的摘要' },
      { label: '有效断言', value: fmtNumber(assertions.length), hint: '带有效期；冲突时旧的失效，不删除' },
      { label: '世界变化', value: fmtNumber(worldChanges.length), hint: '本局世界线相对初始卡片的增量，不写回模板' },
      { label: '未回收线索', value: fmtNumber(threads.filter((t) => t.status === 'open').length), hint: '埋了没收的，和已经收掉的' },
      { label: '原声样本', value: fmtNumber(voices.length), hint: '从正文里摘的台词，用来锚定声音' },
      { label: '待处理', value: fmtNumber(patches.filter((p) => p.status !== 'applied' && p.status !== 'dismissed').length), hint: '校勘与幕后推演的提案' },
    ];
    for (const c of cards) {
      overview.appendChild(el('div', { class: 'mem-card' },
        el('span.mem-card-value', {}, c.value),
        el('span.mem-card-label', {}, c.label),
        el('span.mem-card-hint', {}, c.hint),
      ));
    }
    body.appendChild(overview);

    const world = data.world || {};
    if (world.title) {
      body.appendChild(el('div.mem-world', {},
        el('h4', {}, `世界卡 · ${world.title}`),
        el('p.muted', {},
          `卡司 ${world.cast_count}｜辞书 ${world.codex_count}｜`
          + `起点前事件 ${world.timeline_past}｜扣留的原著后续 ${world.timeline_future}`),
        el('p.mem-world-note', {},
          world.timeline_future > 0
            ? '原著后续只作校勘参考，不会注入提示词，也不作为演绎目标。'
            : '这是一张原创世界卡：没有原著路线，故事完全由玩家与角色推动。'),
      ));
    }

    /* ---------------- 本局世界状态 ---------------- */
    body.appendChild(el('h4', {}, '本局世界状态'));
    body.appendChild(el('p.muted', {},
      `相对初始卡片的变化。它只属于这条世界线，新会话仍从初始设定开始${worldVersion ? `（模板 v${worldVersion}）` : ''}。`));
    const changeList = el('div.mem-states');
    if (!worldChanges.length) changeList.appendChild(el('p.muted', {}, '还没有变化。世界仍等于开局设定。'));
    for (const c of worldChanges.slice(-80).reverse()) {
      const value = typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
      changeList.appendChild(el('div.mem-state', {},
        el('span.mem-state-who', {}, `${c.entity_id}${c.path ? `·${c.path}` : ''}`),
        el('span.mem-state-fields', {},
          `${c.op === 'introduce' ? '登场' : c.op === 'add' ? '新增' : c.op === 'remove' ? '移除' : '改为'} ${truncate(value, 90)}`
          + `（第 ${c.valid_from} 轮）`),
      ));
    }
    body.appendChild(changeList);
    body.appendChild(el('button.btn.btn-secondary.btn-sm', {
      type: 'button', style: 'margin-top:8px;',
      onclick: async () => {
        const ok = await confirmDialog({
          title: '定稿为新的世界卡？',
          message: '会把本局当前的人物状态、知识、辞书与新出场实体固化到一张新卡，并生成一个当前场景的起点锚点。原世界卡与进行中的会话都不会被改动。',
          confirmText: '定稿',
        });
        if (!ok) return;
        try {
          const r = await api.canonizeSession(sessionId);
          toast(`已生成世界卡：${r.world.title}`, { type: 'success' });
        } catch (err) {
          toast(err.message || '定稿失败', { type: 'error' });
        }
      },
    }, icon('book', { size: 13 }), '定稿为新世界卡'));

    /* ---------------- 分支 ---------------- */
    body.appendChild(el('h4', {}, '分支'));
    body.appendChild(el('p.muted', {}, '回滚不是删历史，是从分叉点开一条新线。旧线标为 abandoned，随时可以回去看。'));
    const branchList = el('div.mem-branches');
    for (const b of branches) {
      branchList.appendChild(el('div', { class: 'mem-branch' + (b.branch_id === data.branch ? ' is-current' : '') },
        el('span.mem-branch-id', {}, b.branch_id + (b.branch_id === data.branch ? ' · 当前' : '')),
        el('span.mem-branch-meta', {}, `第 ${b.fork_turn} 轮分叉｜${b.status}`),
        b.note ? el('span.mem-branch-note', {}, b.note) : null,
      ));
    }
    body.appendChild(branchList);

    /* ---------------- 场次索引 ---------------- */
    body.appendChild(el('h4', {}, '场次索引'));
    body.appendChild(el('p.muted', {}, '每一行是一场戏。它是检索入口，不是摘要——要看细节就点开读原文。'));
    if (!scenes.length) {
      body.appendChild(el('p.muted', {}, '还没有场次记录。切场时会自动归档。'));
    } else {
      const sceneList = el('div.mem-scenes');
      for (const s of scenes.slice().reverse()) {
        sceneList.appendChild(el('div.mem-scene', {},
          el('span.mem-scene-id', {}, s.scene_id),
          el('span.mem-scene-range', {}, `第 ${s.turn_from}-${s.turn_to} 轮`),
          el('span.mem-scene-place', {}, [s.when_label, s.place].filter(Boolean).join(' · ') || '—'),
          el('span.mem-scene-q', {}, s.question || '—'),
          s.outcome ? el('span.mem-scene-outcome', {}, s.outcome) : null,
        ));
      }
      body.appendChild(sceneList);
    }

    /* ---------------- 断言账本 ---------------- */
    body.appendChild(el('h4', {}, '断言账本'));
    body.appendChild(el('p.muted', {}, '世界的真相。同主同谓不同对象的旧断言会被标记失效而不是删掉——「她曾经相信过什么」本身就是剧情。'));
    const assertionList = el('div.mem-assertions');
    if (!assertions.length) {
      assertionList.appendChild(el('p.muted', {}, '还没有断言。史官每轮会从正文里抽取。'));
    }
    for (const a of assertions.slice(0, 60)) {
      assertionList.appendChild(el('div', { class: 'mem-assertion' },
        el('span.mem-assertion-main', {}, `${a.subject} —${a.predicate}→ ${a.object}`),
        el('span.mem-assertion-meta', {},
          `第 ${a.valid_from} 轮起${a.visibility !== 'public' ? `｜${VISIBILITY_LABEL[a.visibility] || a.visibility}` : ''}`
          + `${a.confidence < 0.7 ? `｜置信 ${a.confidence}` : ''}`),
        a.evidence ? el('span.mem-assertion-ev', {}, truncate(a.evidence, 80)) : null,
        el('button.btn-icon', {
          title: '撤回',
          onclick: async () => {
            await api.retractAssertion(sessionId, a.id);
            toast('已撤回');
            await refresh();
          },
        }, icon('x')),
      ));
    }
    body.appendChild(assertionList);

    /* ---------------- 人物状态 ---------------- */
    body.appendChild(el('h4', {}, '人物状态'));
    body.appendChild(el('p.muted', {}, '按字段可寻址：改了「情绪」不会动到「位置」。'));
    const stateList = el('div.mem-states');
    const byWho = {};
    for (const s of states) {
      byWho[s.who] = byWho[s.who] || {};
      if (!(s.field in byWho[s.who])) byWho[s.who][s.field] = s.value;
    }
    if (!Object.keys(byWho).length) stateList.appendChild(el('p.muted', {}, '暂无'));
    for (const [who, fields] of Object.entries(byWho)) {
      stateList.appendChild(el('div', { class: 'mem-state' },
        el('span.mem-state-who', {}, who),
        el('span.mem-state-fields', {}, Object.entries(fields).map(([k, v]) => `${k} ${v}`).join('｜')),
      ));
    }
    body.appendChild(stateList);

    /* ---------------- 线索 ---------------- */
    body.appendChild(el('h4', {}, '线索'));
    const threadList = el('div.mem-threads');
    if (!threads.length) threadList.appendChild(el('p.muted', {}, '暂无线索。'));
    for (const t of threads) {
      threadList.appendChild(el('div', { class: 'mem-thread' },
        el('span', { class: 'mem-thread-status' + (t.status === 'open' ? ' is-open' : ' is-done') },
          t.status === 'open' ? '未回收' : t.status === 'resolved' ? '已回收' : '已放弃'),
        el('span.mem-thread-title', {}, t.title),
        el('span.mem-thread-meta', {}, `第 ${t.planted_turn} 轮埋｜权重 ${t.weight}`),
        t.note ? el('span.mem-thread-note', {}, t.note) : null,
      ));
    }
    body.appendChild(threadList);

    /* ---------------- 原声 ---------------- */
    body.appendChild(el('h4', {}, '原声'));
    body.appendChild(el('p.muted', {}, '从正文里原样摘出来的台词。它比「这个人说话短促」有用得多。'));
    const voiceList = el('div.mem-voices');
    if (!voices.length) voiceList.appendChild(el('p.muted', {}, '暂无。史官每轮会摘本轮出现的台词。'));
    for (const v of voices.slice(0, 40)) {
      voiceList.appendChild(el('div', { class: 'mem-voice' },
        el('span.mem-voice-who', {}, v.who),
        el('span.mem-voice-text', {}, v.text),
        el('span.mem-voice-turn', {}, `第 ${v.turn_no} 轮`),
        v.pinned ? el('span.mem-voice-pin', {}, '钉选') : null,
      ));
    }
    body.appendChild(voiceList);

    /* ---------------- 校勘提案 ---------------- */
    body.appendChild(el('h4', {}, '校勘与幕后推演'));
    body.appendChild(el('p.muted', {}, 'Agent 只提案，代码才落库。这里能看到谁提的、证据是什么。'));
    const patchList = el('div.mem-patches');
    if (!patches.length) patchList.appendChild(el('p.muted', {}, '暂无提案。'));
    for (const p of patches.slice(0, 40)) {
      const pending = p.status !== 'applied' && p.status !== 'dismissed';
      patchList.appendChild(el('div', { class: 'mem-patch' + (pending ? ' is-pending' : '') },
        el('span.mem-patch-kind', {}, PATCH_KIND_LABEL[p.kind] || p.kind),
        el('span.mem-patch-sev', {}, SEVERITY_LABEL[p.severity] || p.severity),
        el('span.mem-patch-agent', {}, p.agent),
        el('span.mem-patch-claim', {}, truncate(p.payload?.claim || p.payload?.what || JSON.stringify(p.payload), 140)),
        p.evidence ? el('span.mem-patch-ev', {}, truncate(p.evidence, 120)) : null,
        el('span.mem-patch-status', {}, p.status),
        pending ? el('div.mem-patch-actions', {},
          el('button.btn-sm', {
            onclick: async () => {
              await api.resolvePatch(sessionId, p.id, 'applied');
              toast('已接受');
              await refresh();
            },
          }, '接受'),
          el('button.btn-sm btn-ghost', {
            onclick: async () => {
              await api.resolvePatch(sessionId, p.id, 'dismissed');
              await refresh();
            },
          }, '忽略'),
        ) : null,
      ));
    }
    body.appendChild(patchList);

    /* ---------------- 笔记 ---------------- */
    body.appendChild(el('h4', {}, '作者笔记'));
    body.appendChild(el('p.muted', {}, '你亲手写下的事实，优先级高于一切自动记忆。'));
    const noteList = el('div.mem-notes');
    if (!data.notes?.length) noteList.appendChild(el('p.muted', {}, '暂无。'));
    for (const n of data.notes) {
      noteList.appendChild(el('div', { class: 'mem-note' },
        el('span.mem-note-kind', {}, n.kind),
        el('span.mem-note-text', {}, n.content),
        el('button.btn-icon', {
          title: '删除',
          onclick: async () => {
            if (!(await confirmDialog('删除这条笔记？'))) return;
            await api.deleteNote(sessionId, n.id);
            await refresh();
          },
        }, icon('trash')),
      ));
    }
    body.appendChild(noteList);

    const noteInput = el('input.input', { placeholder: '写一条作者笔记…' });
    body.appendChild(el('div.mem-add-note', {},
      noteInput,
      el('button.btn', {
        onclick: async () => {
          const text = String(noteInput.value || '').trim();
          if (!text) return;
          await api.addNote(sessionId, { content: text, kind: 'note' });
          noteInput.value = '';
          await refresh();
        },
      }, '添加'),
    ));

    return body;
  }

  const sheetApi = openSheet({
    title: '记忆',
    width: 760,
    render(body) {
      clear(body);
      body.appendChild(renderBody());
    },
  });

  async function refresh() {
    try {
      const [mem, a, st, sc, th, v, p, br, ws] = await Promise.all([
        api.getMemory(sessionId),
        api.getAssertions(sessionId),
        api.getStates(sessionId),
        api.getScenes(sessionId),
        api.getThreads(sessionId),
        api.getVoices(sessionId),
        api.getPatches(sessionId),
        api.getBranches(sessionId),
        api.getWorldState(sessionId),
      ]);
      data = mem;
      assertions = a.assertions || [];
      states = st.states || [];
      scenes = sc.scenes || [];
      threads = th.threads || [];
      voices = v.voices || [];
      patches = p.patches || [];
      branches = br.branches || [];
      worldChanges = ws.changes || [];
      worldVersion = ws.world_version ?? null;
      clear(sheetApi.body);
      sheetApi.body.appendChild(renderBody());
      opts.onUpdate?.(mem);
    } catch (err) {
      console.error('[memory-panel] refresh failed', err);
      clear(sheetApi.body);
      sheetApi.body.appendChild(el('div.err-bar', {}, `载入失败：${err.message}`));
    }
  }

  await refresh();
  return sheetApi;
}

export default { openMemoryPanel };
