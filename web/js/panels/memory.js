/**
 * panels/memory.js — 记忆与上下文面板（v4）
 *
 * 分区：概览 / 分支 / 场次索引 / 事实记录账本 / 人物状态 / 线索 / 台词样本 / 一致性检查 / 笔记
 *
 * 设计取向：这些数字存在的意义是「让作者知道引擎记得什么」。
 * v4 的记忆是「原文 + 场次 + 事实记录账本 + 台词样本」，没有摘要金字塔——
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
  offstage_event: '幕后事件', scene: '场次', assertion: '事实记录',
  world_change: '世界变化', rejected_delta: '数值被拒',
  // 下面四类没进标签表会以裸标识符露在分组摘要里（`skipped_targets 10`），
  // 面板面向作者，代码标识符不该出现在界面上。
  skipped_targets: '越界写入', life_state_inferred: '生死补齐',
  archivist_parse_failed: '记忆整理失败', stale: '过期作废',
};
const SEVERITY_LABEL = { blocker: '阻断', major: '重要', minor: '轻微', info: '提示' };
// 提案落到 `failed` 终态后，界面要回答「为什么没执行」——否则作者只会看到一条
// 点了没反应的记录。「形态没写对」和「这条通道没实现」是两件不同的事，
// 后者不是模型的错，也不该期待重试。
const FAIL_REASON_LABEL = {
  stale_value: '这条修复要改的是当场应有的值，隔拍再执行会把状态改回过去，已作废',
  not_implemented: '这类修复还没有实现，仅作记录',
  not_a_person: '目标不是角色，无法改人物状态',
  unknown_field: '字段不在受控表里，拒写',
};

/** 从提案的 payload.fix_result 里取「为什么没执行」的原因码。 */
function patchFailReason(p) {
  return p?.payload?.fix_result?.reason || null;
}

/**
 * 提案的「一句话说明」。
 *
 * 各类提案把话放在不同字段（断言/矛盾是 claim，世界变化是 path/op/value 三元组），
 * 缺一档就会把整条 JSON 原样显示给作者。
 * 世界变化最多，且 payload 全是机器字段，退回 JSON 等于面板里一大片花括号。
 */
function patchClaim(p) {
  const pl = p.payload || {};
  if (pl.claim) return pl.claim;
  if (pl.what) return pl.what;
  if (pl.text) return pl.text;
  if (pl.detail) return pl.detail;
  // 断言的三元组（subject/predicate/object）：中文里「谁 谓词 什么」直接连起来就是人话。
  if (pl.subject && pl.predicate) {
    const obj = Array.isArray(pl.object) ? pl.object.join('、') : (pl.object ?? '');
    const tail = obj && obj !== true ? ` ${obj}` : '';
    return `${pl.subject} ${pl.predicate}${tail}`;
  }
  if (pl.op === 'introduce') {
    // introduce 没有 path（是「凭空多出一个实体」），只有 kind + name/value.name。
    const kind = { person: '角色', place: '地点' }[pl.kind || pl.entity_kind] || pl.kind || '实体';
    const name = pl.name || pl.value?.name || pl.entity_id || '';
    return `新增${kind}「${name}」`;
  }
  if (pl.path) {
    const op = { add: '新增', set: '改写', remove: '移除', delta: '增减' }[pl.op] || pl.op || '写入';
    const val = pl.value !== undefined && pl.value !== null ? String(pl.value) : '';
    return `${op} ${pl.path}${val ? ` = ${val}` : ''}`;
  }
  // 实在没有可读字段时给一段短的结构化描述，不要把 JSON 直接铺在界面上。
  return Object.keys(pl).slice(0, 3).map((k) => `${k}: ${truncate(JSON.stringify(pl[k]), 40)}`).join('，');
}

export async function openMemoryPanel(sessionId, opts = {}) {
  let data = null;
  let assertions = [];
  let states = [];
  let scenes = [];
  let threads = [];
  let voices = [];
  let patches = [];
  let patchCounts = {};
  let patchTotal = 0;
  let patchOpenTotal = 0;
  let voiceTotal = 0;
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
      { label: '有效事实记录', value: fmtNumber(assertions.length), hint: '带有效期；冲突时旧的作废，不删除' },
      { label: '世界变化', value: fmtNumber(worldChanges.length), hint: '本局世界线相对初始卡片的增量，不写回模板' },
      { label: '未回收线索', value: fmtNumber(threads.filter((t) => t.status === 'open').length), hint: '埋了没收的，和已经收掉的' },
      { label: '台词样本', value: fmtNumber(voiceTotal), hint: '从正文里摘的台词，用来锚定声音' },
      { label: '待处理', value: fmtNumber(patchOpenTotal), hint: '一致性检查与幕后推演的提案' },
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
          `角色 ${world.person_count}｜设定集 ${world.fact_count}｜`
          + `前史 ${world.timeline_past}｜参考走向 ${world.timeline_future}`),
        el('p.mem-world-note', {},
          world.timeline_future > 0
            ? '参考走向只作作者对照，不会注入提示词，也不作为演绎目标。'
            : '没有参考走向：故事完全由玩家与角色推动。'),
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
          title: '存为新的世界卡？',
          message: '会把本局当前的人物状态、知识、设定集与新出场实体固化到一张新卡，并生成一个当前场景的起点。原世界卡与进行中的会话都不会被改动。',
          confirmText: '保存',
        });
        if (!ok) return;
        try {
          const r = await api.canonizeSession(sessionId);
          toast(`已生成世界卡：${r.world.title}`, { type: 'success' });
        } catch (err) {
          toast(err.message || '保存失败', { type: 'error' });
        }
      },
    }, icon('book', { size: 13 }), '存为新世界卡'));

    /* ---------------- 分支 ---------------- */
    body.appendChild(el('h4', {}, '分支'));
    body.appendChild(el('p.muted', {}, '回滚不是删历史，是从分叉点开一条新线。每条线都能切回去继续写。'));
    const branchList = el('div.mem-branches');
    const isCurrent = (b) => (b.is_current != null ? b.is_current : b.branch_id === data.branch);
    for (const b of branches) {
      const cur = isCurrent(b);
      const row = el('div', { class: 'mem-branch' + (cur ? ' is-current' : '') },
        el('span.mem-branch-id', {}, b.branch_id + (cur ? ' · 当前' : '')),
        el('span.mem-branch-meta', {},
          `第 ${b.fork_turn} 轮分叉｜${b.turn_count != null ? `${b.turn_count} 轮` : b.status}`),
        b.note ? el('span.mem-branch-note', {}, b.note) : null,
      );
      if (!cur) {
        row.appendChild(el('button.mem-branch-go', {
          type: 'button',
          title: '切到这条线继续写（不新建分支）',
          onclick: async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog({
              title: `切到 ${b.branch_id}`,
              message: `这一局会从 ${b.branch_id} 继续写。当前那条线标为已废弃，但不删，随时能再切回来。`,
              confirmText: '切过去',
            });
            if (!ok) return;
            try {
              await api.checkoutBranch(sessionId, b.branch_id);
              await refresh();
              opts.onUpdate?.();
              toast(`已切到 ${b.branch_id}`, { type: 'success' });
            } catch (err) {
              toast(err.message, { type: 'error' });
            }
          },
        }, '切到这条线'));
      }
      branchList.appendChild(row);
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

    /* ---------------- 事实记录账本 ---------------- */
    body.appendChild(el('h4', {}, '事实记录账本'));
    body.appendChild(el('p.muted', {}, '世界的真相。同主同谓不同对象的旧事实记录会被标记作废而不是删掉——「她曾经相信过什么」本身就是剧情。'));
    const assertionList = el('div.mem-assertions');
    if (!assertions.length) {
      assertionList.appendChild(el('p.muted', {}, '还没有事实记录。记忆整理每轮会从正文里抽取。'));
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

    /* ---------------- 台词样本 ---------------- */
    body.appendChild(el('h4', {}, '台词样本'));
    body.appendChild(el('p.muted', {}, '从正文里原样摘出来的台词。它比「这个人说话短促」有用得多。'));
    const voiceList = el('div.mem-voices');
    if (!voices.length) voiceList.appendChild(el('p.muted', {}, '暂无。记忆整理每轮会摘本轮出现的台词。'));
    for (const v of voices.slice(0, 40)) {
      voiceList.appendChild(el('div', { class: 'mem-voice' },
        el('span.mem-voice-who', {}, v.who),
        el('span.mem-voice-text', {}, v.text),
        el('span.mem-voice-turn', {}, `第 ${v.turn_no} 轮`),
        v.pinned ? el('span.mem-voice-pin', {}, '固定带出') : null,
      ));
    }
    body.appendChild(voiceList);

    /* ---------------- 一致性检查提案 ---------------- */
    body.appendChild(el('h4', {}, '一致性检查与幕后推演'));
    body.appendChild(el('p.muted', {}, 'Agent 只提案，代码才落库。这里能看到谁提的、证据是什么。'));
    const patchList = el('div.mem-patches');
    if (!patches.length) patchList.appendChild(el('p.muted', {}, '暂无提案。'));
    // 按类分堆：不同 kind 的产出速率差两个数量级，混在一起会把真正需要处置的少数几条
    // 挤出可视范围。这里显示每一类的总数，并说明列表里只展示最近多少条——不静默截断。
    const shown = patches.slice(0, 40);
    const counts = patchCounts || {};
    const shownKinds = {};
    for (const p of shown) shownKinds[p.kind] = (shownKinds[p.kind] || 0) + 1;
    const kindSummary = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${PATCH_KIND_LABEL[k] || k} ${shownKinds[k] ? `${shownKinds[k]}/${n}` : `${n}`}`)
      .join(' · ');
    if (kindSummary) {
      patchList.appendChild(el('p.muted', {},
        `${kindSummary}（斜线后为该类总数；共 ${patchTotal} 条，列表只显示最近 ${shown.length} 条，未逐条列出不代表没有问题）`));
    }
    for (const p of shown) {
      // `failed`（D31：模型给出的修复提案形态不对、或那类通道根本没实现）是终态，
      // 再点「接受」也不会执行——只有 `open` 才是等人裁决。把它当 pending 会给出
      // 两个按了没反应的按钮，比不显示更坏。
      const terminalFail = p.status === 'failed';
      // `noted`（alias 类）不是「等你裁决」，是「系统按设计不动、要你亲手合并」：
      // 它同样该给按钮，但按钮必须真的改世界（POST …/patches/:id/apply），
      // 而不是 /resolve 那条只改状态的老路——那条对实体零效果，点了等于骗人。
      const noted = p.status === 'noted';
      const pending = !terminalFail && p.status !== 'applied' && p.status !== 'dismissed';
      const canAutoApply = p.kind === 'alias' && (noted || pending);
      const statusLabel = terminalFail ? '未执行' : (noted ? '待人工合并' : p.status);
      patchList.appendChild(el('div', { class: 'mem-patch' + (pending ? ' is-pending' : '') + (terminalFail ? ' is-failed' : '') },
        el('span.mem-patch-kind', {}, PATCH_KIND_LABEL[p.kind] || p.kind),
        el('span.mem-patch-sev', {}, SEVERITY_LABEL[p.severity] || p.severity),
        el('span.mem-patch-agent', {}, p.agent),
        // 各类提案把话放在不同字段，统一走 patchClaim 归一，不要把 JSON 铺在界面上。
        el('span.mem-patch-claim', {}, truncate(patchClaim(p), 140)),
        p.evidence ? el('span.mem-patch-ev', {}, truncate(p.evidence, 120)) : null,
        el('span.mem-patch-status', {}, statusLabel),
        terminalFail ? el('span.mem-patch-note', {}, FAIL_REASON_LABEL[patchFailReason(p)] || '这条修复无法自动执行') : null,
        noted ? el('span.mem-patch-note', {}, '系统只记录、不自动合并：点「合并别名」按卡里的名字确定规范名') : null,
        (pending || noted) ? el('div.mem-patch-actions', {},
          canAutoApply ? el('button.btn-sm', {
            onclick: async () => {
              try {
                const r = await api.applyPatch(sessionId, p.id);
                const kept = r?.fix_result?.canonical?.name || '';
                const dups = r?.fix_result?.runtime_duplicates || [];
                toast(kept ? `已合并为「${kept}」${dups.length ? `（运行期同名：${dups.join('、')}）` : ''}` : '已合并');
              } catch (err) {
                // 400 的 reason 是「为什么不能自动合并」，必须让作者看见：
                // 静默失败会让人以为点过了、世界已经改了。
                toast(`无法自动合并：${err?.message || '未知原因'}`);
              }
              await refresh();
            },
          }, '合并别名') : el('button.btn-sm', {
            onclick: async () => {
              await api.resolvePatch(sessionId, p.id, 'applied');
              toast('已接受');
              await refresh();
            },
          }, '接受'),
          el('button.btn-sm', {
            class: 'btn-ghost',
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
      voiceTotal = Number(v.total) || voices.length;
      patches = p.patches || [];
      patchCounts = p.counts || {};
      patchTotal = Number(p.total) || patches.length;
      // 总览卡的「待处理」必须用后端 open 计数：列表只取最近 100 条，
      // 用 patches 本地过滤会把它报成「22」，实际 133（长跑实测）。
      // 只有后端字段缺失（旧响应）时才退回本地过滤，不要用 `|| 0` 判真——
      // 真正 0 条 open 与「字段没给」是两件事。
      patchOpenTotal = Number.isFinite(Number(p.open_total))
        ? Number(p.open_total)
        : patches.filter((x) => x.status !== 'applied' && x.status !== 'dismissed').length;
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
