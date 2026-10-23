/**
 * views/play.js — 演绎视图
 *
 * 阅读优先：旁白是全宽正文，玩家行动是右侧气泡。
 * 每一轮旁白下方有 token 遥测（首字/用时/输入/输出/速度/缓存）。
 */

import {
  el, clear, formatClock, fmtTokens, fmtPercent, isNearBottom, readAsDataURL,
  copyToClipboard,
} from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import {
  navigate, openActionSheet, openSheet, confirmDialog, toast, showLoading, hideLoading,
} from '../app.js';
import { ui } from '../store.js';
import { openMemoryPanel } from '../panels/memory.js';
import { formatNarrative } from '../markdown.js';
import { usageBar, buildRing } from '../ui-kit.js';

const TONE_MARK = { 激进: '!', 谨慎: '·', 探索: '?', 情感: '♡', 智取: '○', 诡道: '△' };

export default {
  id: 'play',
  title: '演绎',

  async mount(root, params) {
    const sessionId = params.id;
    if (!sessionId) { navigate('#/worlds'); return { unmount() {} }; }

    /* ---------------- 状态 ---------------- */
    let detail = null;
    let world = null;
    let streaming = false;
    let abortCtl = null;
    let live = null;
    let branchSet = null;
    let selectedBranch = null;
    let attachments = [];
    let memStats = null;
    let lastTurnNo = 0;
    let contextMeta = null;
    let assemblerBudget = null;
    let fallbackNotified = false;

    /* ---------------- DOM ---------------- */
    let navTitle, navSub, scroll, msgList, branchHost, composerWrap, ctxMeterFill;
    let input, sendBtn, attachStrip, quickRow, selStrip, ringSlot, jumpBtn, fileInput;

    /* ---------------- 骨架 ---------------- */
    navTitle = el('div', {}, '加载中');
    navSub = el('div.topbar-sub', {}, '');
    ringSlot = el('span', { style: 'display:flex;' });

    const memBtn = el('button.icon-btn', {
      type: 'button', title: '记忆与上下文', 'aria-label': '记忆与上下文',
      onclick: () => openMemory(),
    }, ringSlot);

    const moreBtn = el('button.icon-btn', {
      type: 'button', title: '更多', 'aria-label': '更多操作',
      onclick: () => openMore(),
    }, icon('more', { size: 16 }));

    const nav = el('header.topbar', {},
      el('button.icon-btn.mobile-only', {
        type: 'button', 'aria-label': '目录',
        onclick: () => import('../shell.js').then((m) => m.openDrawer()),
      }, icon('sidebar', { size: 17 })),
      el('div.topbar-title', {}, navTitle, navSub),
      el('div.topbar-actions', {}, memBtn, moreBtn),
    );

    msgList = el('div.play-body', {});
    branchHost = el('div', {});
    msgList.appendChild(branchHost);
    scroll = el('div.scroll.play-scroll', {}, msgList);
    msgList = msgList; // keep

    /* ---------------- 输入区 ---------------- */
    input = el('textarea.composer-input', {
      rows: 1,
      placeholder: '讲述你的行动，或选一个走向…',
      enterkeyhint: 'send',
      'aria-label': '输入行动',
    });
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
      }
    });

    const plusBtn = el('button.icon-btn', {
      type: 'button', title: '添加图片', 'aria-label': '添加图片',
      onclick: () => fileInput.click(),
    }, icon('plus', { size: 16 }));

    sendBtn = el('button.composer-send', {
      type: 'button', 'aria-label': '发送', title: '发送', onclick: onSendClick,
    }, icon('arrowUp', { size: 15, stroke: 2.2 }));

    selStrip = el('div', { style: 'display:none;' });
    quickRow = el('div.quick-branches', { style: 'display:none;' });
    attachStrip = el('div.attach-strip', { style: 'display:none;' });
    ctxMeterFill = el('div.ctx-meter-fill', { style: 'width:0%;' });

    const composerBox = el('div.composer-box', {},
      plusBtn,
      input,
      el('div.composer-tools', {}, sendBtn),
    );

    composerWrap = el('div.composer-wrap', {},
      el('div.composer', {},
        selStrip,
        quickRow,
        attachStrip,
        composerBox,
        el('div.composer-hint', {},
          el('span', {}, 'Enter 发送 · Shift+Enter 换行'),
          el('span.ctx-meter', {},
            el('span', {}, '上下文'),
            el('div.ctx-meter-bar', {}, ctxMeterFill),
            el('span', { class: 'ctx-meter-val' }, '—'),
          ),
        ),
      ),
    );

    fileInput = el('input', {
      type: 'file', accept: 'image/*', multiple: true, style: 'display:none;',
      onchange: onFiles,
    });

    jumpBtn = el('button.jump-latest', { type: 'button', onclick: () => scrollToBottom(true) },
      icon('chevronDown', { size: 12 }), '最新',
    );

    const view = el('section.view.play-view', { 'data-view': 'play' },
      nav, scroll, composerWrap, jumpBtn, fileInput,
    );
    root.appendChild(view);

    scroll.addEventListener('scroll', () => {
      jumpBtn.classList.toggle('is-visible', !isNearBottom(scroll, 160));
    }, { passive: true });

    /* =====================================================================
     * 载入
     * ===================================================================== */
    showLoading();
    try {
      detail = await api.getSession(sessionId);
    } catch (err) {
      hideLoading();
      toast(err.message || '会话加载失败', { type: 'error' });
      navigate('#/worlds');
      return { unmount() {} };
    }
    hideLoading();

    world = detail.world || null;
    memStats = detail.memoryStats;
    if (detail.session?.world_id) {
      try {
        const shell = await import('../shell.js');
        shell.setContext({ worldId: detail.session.world_id, sessionId });
      } catch { /* 忽略 */ }
    }

    // 阅读视图用会话创建时冻结的卡片快照，不读作者后来改过的模板。
    const card = detail.card || await loadWorldCard();
    paintHeader(card);
    paintRing();
    paintCtxMeter();
    renderTurns();

    document.addEventListener('sessions:changed', onSessionsChanged);

    async function loadWorldCard() {
      if (!detail.session?.world_id) return null;
      try {
        const w = await api.getWorld(detail.session.world_id);
        return w?.card || null;
      } catch { return null; }
    }

    /* =====================================================================
     * 头部
     * ===================================================================== */
    function paintHeader(card) {
      const title = detail.session?.title || world?.title || '剧情';
      navTitle.textContent = title;
      document.title = `${title} · 叙事台`;
      updateSub();
    }

    function updateSub() {
      const count = detail?.session?.turn_count ?? 0;
      const turns = detail?.turns || [];
      const chars = turns.reduce((s, t) => s + (t.kind === 'narrator' ? (t.content || '').length : 0), 0);
      const uso = detail?.usage;
      const parts = [];
      if (count) parts.push(`${count} 轮`);
      if (chars) parts.push(chars > 10000 ? `${(chars / 10000).toFixed(1)} 万字` : `${chars} 字`);
      if (uso?.prompt_tokens) parts.push(`累计 ${fmtTokens(uso.prompt_tokens + uso.completion_tokens)} tok`);
      navSub.textContent = parts.join(' · ');
    }

    /* =====================================================================
     * 渲染既有回合
     * ===================================================================== */
    function renderTurns() {
      const host = scroll.querySelector('.play-body');
      clear(host);
      branchHost = el('div', {});
      host.appendChild(branchHost);

      const turns = (detail.turns || []).slice().sort((a, b) => (a.turn_no ?? 0) - (b.turn_no ?? 0));
      if (!turns.length) {
        renderEmpty(card);
        return;
      }

      let shown = 0;
      for (const t of turns) {
        if (t.kind === 'player' && !String(t.content || '').trim()
          && !normalizeImages(t.images).length && !t.branch_choice) continue;
        if (t.turn_no !== shown) {
          shown = t.turn_no;
          host.insertBefore(host.appendChild(turnMark(shown, t.created_at)), branchHost);
          lastTurnNo = Math.max(lastTurnNo, shown);
        }
        if (t.kind === 'player') appendPlayer(t.content, t.images, t.branch_choice, host);
        else if (t.kind === 'narrator') appendNarrator(t.content, t.reasoning, t.turn_no, { usage: t.usage, host });
        else if (t.kind === 'system') host.appendChild(el('div.sysline', {}, el('span.sysline-inner', {}, t.content)));
      }
      scrollToBottom(false);

      // 重新打开会话：给一个低摩擦的继续入口，而不是自动烧一次分支生成
      const lastNarr = [...turns].reverse().find((t) => t.kind === 'narrator');
      if (lastNarr && !branchHost.querySelector('.branches')) showContinue();
    }

    function renderEmpty(card2) {
      const host = scroll.querySelector('.play-body');
      const anchor = card2?.anchors?.find((a) => a.id === detail?.session?.anchor_id) || card2?.anchors?.[0];
      const seed = String(anchor?.opening_seed || '').trim();
      if (seed) {
        appendNarrator(seed, '', 1, { label: '序幕', host, noUsage: true });
        showStartButtons();
      } else {
        host.insertBefore(el('div.empty', { style: 'padding-top:60px;' },
          el('div.empty-icon', {}, icon('wand', { size: 20 })),
          el('div.empty-title', {}, '故事还没开始'),
          el('div.empty-sub', {}, '在下方输入第一个行动，或者直接让引擎起笔。'),
          el('button.btn.btn-primary', { type: 'button', onclick: () => runOpening() },
            icon('play', { size: 12, fill: true }), '让它起笔'),
        ), branchHost);
      }
    }

    function showStartButtons() {
      branchHost.appendChild(el('div.continue-row', {},
        el('button.btn.btn-primary', { type: 'button', onclick: () => send({ generateBranches: true }) },
          icon('sparkles', { size: 13 }), '从这里开始演绎'),
      ));
    }

    function turnMark(no, ts) {
      if (ui.get().showTurnMarks === false) return el('span');
      const clock = ts ? formatClock(ts) : '';
      return el('div.turn-mark', { dataset: { turn: no } },
        el('span.turn-mark-line'),
        el('span.turn-mark-label', {}, `第 ${no} 轮${clock ? ` · ${clock}` : ''}`),
        el('span.turn-mark-line'),
      );
    }

    /* =====================================================================
     * 消息节点
     * ===================================================================== */
    function narratorGlyph() {
      return el('div.narr-glyph', {}, [...(world?.title || '叙')][0]);
    }

    function appendNarrator(content, reasoning, turnNo, opts = {}) {
      const { label = '旁白', usage = null, host = null, noUsage = false } = opts;
      const target = host || scroll.querySelector('.play-body');
      const node = el('div.narr');

      node.appendChild(el('div.narr-head', {}, narratorGlyph(), el('span.narr-label', {}, label)));

      if (reasoning && String(reasoning).trim()) {
        node.appendChild(thinkBox(String(reasoning), { open: ui.get().showReasoning === true }));
      }

      const prose = el('div.prose');
      prose.innerHTML = formatNarrative(content);
      node.appendChild(prose);

      if (!noUsage && ui.get().showUsage !== false) {
        node.appendChild(usageBar(usage, { compact: true }));
      }

      node.appendChild(el('div.narr-actions', {},
        miniBtn('copy', '复制', async () => {
          const ok = await copyToClipboard(prose.innerText);
          toast(ok ? '已复制' : '复制失败', { type: ok ? 'success' : 'error' });
        }),
        turnNo ? miniBtn('rewind', '重写', () => rewriteTurn(turnNo)) : null,
        turnNo ? miniBtn('edit', '编辑', () => editTurn(turnNo, 'narrator', prose.innerText)) : null,
        turnNo ? miniBtn('history', '回到此轮', () => rollbackTo(turnNo)) : null,
      ));

      target.insertBefore(node, branchHost);
      return { node, prose };
    }

    function appendPlayer(content, images, branchChoice, host) {
      const target = host || scroll.querySelector('.play-body');
      const node = el('div.player');
      const bubble = el('div.player-bubble');
      const who = detail?.card?.player?.name || world?.player?.name || '你';

      node.appendChild(el('div.player-head', {},
        el('span.player-glyph', {}, [...who][0] || '你'),
        el('span.player-label', {}, who),
      ));

      const imgs = normalizeImages(images);
      if (imgs.length) {
        bubble.appendChild(el('div.player-imgs', {},
          imgs.map((src) => el('img', {
            src, alt: '玩家上传的图片', loading: 'lazy',
            onclick: () => openLightbox(src),
          })),
        ));
      }
      if (branchChoice) {
        bubble.appendChild(el('span.branch-tag', {},
          TONE_MARK[branchChoice.tone] || '·',
          branchChoice.title || '走向',
        ));
      }
      const text = String(content || '').trim();
      if (text) bubble.appendChild(el('span.player-text', {}, text));
      else if (!imgs.length) bubble.appendChild(el('span', { style: 'opacity:.5;' }, '（空行动）'));

      node.appendChild(bubble);
      node.appendChild(el('div.player-actions', {},
        miniBtn('copy', '复制', async () => {
          const ok = await copyToClipboard(text);
          toast(ok ? '已复制' : '复制失败', { type: ok ? 'success' : 'error' });
        }),
      ));
      target.insertBefore(node, branchHost);
      return node;
    }

    function miniBtn(iconName, label, onClick) {
      return el('button.mini-btn', { type: 'button', onclick: onClick },
        icon(iconName, { size: 12 }), label);
    }

    function thinkBox(text, { open = false, streaming = false } = {}) {
      const body = el('div.think-body');
      body.textContent = text;
      const box = el('div.think', { class: `${open ? 'is-open' : ''} ${streaming ? 'is-streaming' : ''}` },
        el('button.think-toggle', { type: 'button' },
          icon('sparkles', { size: 12 }),
          '思考过程',
          el('span.chev', {}, icon('chevronRight', { size: 11 })),
        ),
        body,
      );
      box.querySelector('.think-toggle').addEventListener('click', () => box.classList.toggle('is-open'));
      return box;
    }

    /* =====================================================================
     * 发送一轮
     * ===================================================================== */
    async function send({ playerText = '', images = [], branchChoice = null, silent = false, generateBranches = true } = {}) {
      if (streaming) return;
      streaming = true;
      abortCtl = new AbortController();
      paintSend();
      clearBranches();
      removeContinue();

      const host = scroll.querySelector('.play-body');
      if (!silent && (playerText || images.length || branchChoice)) {
        const shown = playerText || (branchChoice ? branchChoice.description || branchChoice.title : '');
        appendPlayer(shown, images, branchChoice, host);
      }
      scrollToBottom(true);

      const pending = el('div.gen-pending', {},
        el('span.typing-dots', {}, el('i'), el('i'), el('i')),
        el('span', {}, '演绎中'),
      );
      host.insertBefore(pending, branchHost);

      live = { node: null, prose: null, think: null, thinkBody: null, reasoning: '', text: '', usage: null, startedAt: Date.now() };

      try {
        await api.runTurn(sessionId, {
          playerText: playerText || (branchChoice ? branchChoice.description || branchChoice.title : ''),
          images: images.length ? images : undefined,
          branchChoice: branchChoice || undefined,
          generateBranches,
        }, {
          signal: abortCtl.signal,
          onEvent: handleEvent(pending),
        });
        finalize();
      } catch (err) {
        pending.remove();
        finalize();
        if (err?.name === 'AbortError') {
          toast('已停止生成');
        } else {
          toast(err.message || '生成失败', { type: 'error', duration: 3200 });
          showError(err.message || '生成出错');
        }
      } finally {
        streaming = false;
        abortCtl = null;
        paintSend();
        updateSub();
        paintRing();
      }
    }

    function handleEvent(pending) {
      let pendingGone = false;
      const dropPending = () => {
        if (!pendingGone) { pending.remove(); pendingGone = true; }
      };

      const ensureLive = () => {
        if (live.node) return;
        dropPending();
        const { node, prose } = appendNarrator('', '', lastTurnNo, { label: '旁白' });
        live.node = node;
        live.prose = prose;
      };

      return (evt) => {
        switch (evt.type) {
          case 'turn_start': {
            lastTurnNo = evt.turn_no || lastTurnNo + 1;
            fallbackNotified = false;
            const host = scroll.querySelector('.play-body');
            const mark = turnMark(lastTurnNo, Date.now());
            if (pending.parentNode) host.insertBefore(mark, pending);
            else host.insertBefore(mark, branchHost);
            break;
          }
          case 'context': {
            assemblerBudget = evt.budget;
            contextMeta = evt.meta;
            paintCtxMeter();
            if (evt.scene_sheet) showSceneSheet(evt.scene_sheet);
            break;
          }
          case 'scene': {
            appendSceneCard(evt);
            break;
          }
          case 'world_tick': {
            if (evt.events?.length) appendWorldTick(evt.events);
            break;
          }
          case 'continuity': {
            const issues = evt.report?.issues || [];
            if (issues.length) {
              const hasBlocker = issues.some((i) => i.severity === 'blocker');
              toast(`校勘发现 ${issues.length} 处问题${hasBlocker ? '（含阻断级）' : ''}`, { type: 'warn' });
            }
            break;
          }
          case 'reasoning': {
            ensureLive();
            live.reasoning += evt.delta || '';
            if (!live.think) {
              live.think = thinkBox(live.reasoning, { streaming: true });
              live.thinkBody = live.think.querySelector('.think-body');
              live.node.insertBefore(live.think, live.prose);
            } else {
              live.thinkBody.textContent = live.reasoning;
              live.thinkBody.scrollTop = live.thinkBody.scrollHeight;
            }
            if (isNearBottom(scroll, 160)) scrollToBottom(true);
            break;
          }
          case 'narrative': {
            ensureLive();
            live.text += evt.delta || '';
            schedulePaint();
            break;
          }
          case 'draft_start':
            // 分段演绎开始：此时还没有正文，保持「演绎中」占位。
            fallbackNotified = false;
            break;
          case 'draft_delta': {
            ensureLive();
            live.text += evt.delta || '';
            schedulePaint();
            break;
          }
          case 'draft_reset': {
            ensureLive();
            live.text = evt.content || '';
            schedulePaint();
            break;
          }
          case 'draft_done':
            if (live && evt.content != null) live.text = evt.content;
            break;
          case 'tool_call': {
            if (!pendingGone) {
              const label = pending.querySelector('span:last-child');
              if (label) label.textContent = evt.label ? `${evt.label}…` : '处理中…';
            }
            break;
          }
          case 'narration_fallback':
            if (!fallbackNotified) {
              fallbackNotified = true;
              toast('分段演绎不可用，已回退单发', { type: 'warn' });
            }
            break;
          case 'narrative_done':
            if (live && evt.content) live.text = evt.content;
            break;
          case 'narrative_reset':
            if (live) { live.text = ''; live.reasoning = ''; }
            if (live?.prose) live.prose.innerHTML = '';
            if (live?.thinkBody) live.thinkBody.textContent = '';
            break;
          case 'branches':
            if (evt.branches?.length) {
              renderBranches({ branches: evt.branches, scene_summary: evt.scene_summary });
            } else if (evt.degraded) {
              showContinue();
            }
            break;
          case 'memory':
            if (evt.stats && !evt.stats.error) {
              memStats = { ...(memStats || {}), ...evt.stats };
              paintRing();
            }
            break;
          case 'summary': {
            // 前情提要：best-effort。成功时给一条轻提示，失败静默（下一拍会再判）。
            if (evt.state === 'end' && evt.ok) {
              memStats = {
                ...(memStats || {}),
                summary: { covers_turn_to: evt.covers_turn_to, tokens: evt.tokens },
              };
              paintRing();
              toast(`前情提要已更新（覆盖到第 ${evt.covers_turn_to} 轮）`, { type: 'info' });
            }
            break;
          }
          case 'done': {
            if (evt.usage && live) live.usage = evt.usage;
            finalize(evt);
            updateSub();
            paintRing();
            window.dispatchEvent(new CustomEvent('sessions:changed'));
            break;
          }
          case 'error':
            throw new Error(evt.message || '生成失败');
          default:
            break;
        }
      };
    }

    let rafPending = false;
    function schedulePaint() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (!live?.prose) return;
        live.prose.innerHTML = formatNarrative(live.text) + '<span class="caret"></span>';
        if (isNearBottom(scroll, 200)) scrollToBottom(false);
      });
    }

    function finalize(doneEvt) {
      if (!live) return;
      if (live.prose) live.prose.innerHTML = formatNarrative(live.text);
      if (live.think) live.think.classList.remove('is-streaming');
      if (live.node) {
        if (!live.text.trim()) {
          live.node.remove();
        } else if (ui.get().showUsage !== false) {
          // 挂上遥测条
          const u = doneEvt?.usage || live.usage || null;
          if (u) live.node.appendChild(usageBar(u, { compact: true }));
        }
      }
      live = null;
    }

    function showError(message) {
      const host = scroll.querySelector('.play-body');
      const bar = el('div.err-bar', { role: 'alert' },
        icon('warn', { size: 14 }),
        el('div.spacer', {},
          el('div', {}, message),
          el('button.btn.btn-secondary.btn-sm', { type: 'button', style: 'margin-top:6px;', onclick: () => { bar.remove(); send({ silent: true }); } },
            '重试'),
        ),
        el('button.icon-btn.is-sm', { type: 'button', 'aria-label': '关闭', onclick: () => bar.remove() },
          icon('close', { size: 12 })),
      );
      host.insertBefore(bar, branchHost);
      scrollToBottom(true);
    }

    /* =====================================================================
     * 分支
     * ===================================================================== */
    function renderBranches(set) {
      branchSet = set;
      selectedBranch = null;
      clear(branchHost);
      clear(quickRow);
      clear(selStrip);

      const wrap = el('div.branches');
      wrap.appendChild(el('div.branches-head', {},
        el('span', {}, '接下来'),
        el('span.spacer'),
        el('button.mini-btn', { type: 'button', onclick: regenerateBranches },
          icon('refresh', { size: 11 }), '换一批'),
      ));
      if (set.scene_summary) {
        wrap.appendChild(el('div.branches-scene', {}, set.scene_summary));
      }

      const list = el('div.branch-list');
      set.branches.forEach((b, i) => {
        list.appendChild(el('button.branch', {
          type: 'button',
          onclick: () => selectBranch(b),
          ondblclick: () => { selectBranch(b); doSend(); },
        },
          el('span.branch-key', {}, String(i + 1)),
          el('span.branch-body', {},
            el('span.branch-title-row', {},
              el('span.branch-title', {}, b.title || '行动'),
              el('span.chip.is-plain', { style: 'font-size:9.5px;padding:0 5px;' }, b.tone || '行动'),
              typeof b.tension_delta === 'number' && b.tension_delta !== 0
                ? el('span.chip', {
                  class: b.tension_delta > 0 ? 'is-warn' : 'is-ok',
                  style: 'font-size:9.5px;padding:0 5px;margin-left:auto;',
                }, `张力 ${b.tension_delta > 0 ? '+' : ''}${(b.tension_delta * 100).toFixed(0)}`)
                : null,
            ),
            el('span.branch-desc', {}, b.description || ''),
          ),
        ));
      });
      wrap.appendChild(list);

      wrap.appendChild(el('div.branches-foot', {},
        el('button.mini-btn', { type: 'button', onclick: openCustomAction },
          icon('edit', { size: 11 }), '自定义行动'),
        el('span.spacer'),
        el('span', { style: 'font-size:10px;color:var(--ink-4);' }, '双击直接发送'),
      ));

      branchHost.appendChild(wrap);
      scrollToBottom(true);

      set.branches.forEach((b) => {
        quickRow.appendChild(el('button.qb', {
          type: 'button',
          onclick: () => selectBranch(b),
        },
          el('span', { style: 'opacity:.6;font-size:10px;' }, TONE_MARK[b.tone] || '·'),
          b.title || '行动',
        ));
      });
      quickRow.appendChild(el('button.qb', { type: 'button', onclick: openCustomAction },
        el('span', { style: 'opacity:.6;font-size:10px;' }, '✎'), '自由行动'));
      quickRow.style.display = '';
    }

    function selectBranch(b) {
      selectedBranch = b;
      branchHost.querySelectorAll('.branch').forEach((n, i) => {
        n.classList.toggle('is-selected', branchSet?.branches?.[i] === b);
      });
      quickRow.querySelectorAll('.qb').forEach((n, i) => {
        n.classList.toggle('is-selected', branchSet?.branches?.[i] === b);
      });
      clear(selStrip);
      selStrip.style.display = '';
      selStrip.appendChild(icon('compass', { size: 12 }));
      selStrip.appendChild(el('span.sel-strip-title', {}, b.title || '走向'));
      selStrip.appendChild(el('span.spacer'));
      selStrip.appendChild(el('button.mini-btn', {
        type: 'button', onclick: () => clearSelection(),
      }, '取消'));
      input.placeholder = '按 ↑ 确认这个走向，或先说点什么…';
      input.focus();
      paintSend();
    }

    function clearSelection() {
      selectedBranch = null;
      branchHost.querySelectorAll('.branch.is-selected').forEach((n) => n.classList.remove('is-selected'));
      quickRow.querySelectorAll('.qb.is-selected').forEach((n) => n.classList.remove('is-selected'));
      selStrip.style.display = 'none';
      clear(selStrip);
      input.placeholder = '讲述你的行动，或选一个走向…';
      paintSend();
    }

    function clearBranches() {
      branchSet = null;
      selectedBranch = null;
      clear(branchHost);
      clear(quickRow);
      quickRow.style.display = 'none';
      selStrip.style.display = 'none';
      clear(selStrip);
    }

    function showContinue() {
      removeContinue();
      branchHost.appendChild(el('div.continue-row', {},
        el('button.btn.btn-secondary', { type: 'button', onclick: () => { removeContinue(); send({ silent: true, generateBranches: true }); } },
          icon('sparkles', { size: 13 }), '接着往下演绎'),
        el('button.btn.btn-ghost', { type: 'button', onclick: () => { removeContinue(); regenerateBranches(); } },
          icon('compass', { size: 13 }), '看看走向'),
      ));
      scrollToBottom(true);
    }

    function removeContinue() {
      branchHost.querySelectorAll('.continue-row').forEach((n) => n.remove());
    }

    async function regenerateBranches() {
      if (streaming) return toast('正在演绎中');
      showLoading('正在设计走向…');
      try {
        const set = await api.generateBranches(sessionId);
        if (set?.branches?.length) {
          renderBranches(set);
          toast('已换一批', { type: 'success' });
        } else {
          toast('没能生成走向', { type: 'error' });
        }
      } catch (err) {
        toast(err.message, { type: 'error' });
      } finally {
        hideLoading();
      }
    }

    /* =====================================================================
     * 输入区
     * ===================================================================== */
    function onInput() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
      paintSend();
      if (input.value.trim() && selectedBranch) clearSelection();
    }

    function paintSend() {
      const has = input.value.trim().length > 0 || attachments.length > 0 || !!selectedBranch;
      if (streaming) {
        sendBtn.classList.add('is-stop');
        clear(sendBtn);
        sendBtn.appendChild(icon('stop', { size: 12, fill: true }));
        sendBtn.title = '停止生成';
        sendBtn.disabled = false;
      } else {
        sendBtn.classList.remove('is-stop');
        clear(sendBtn);
        sendBtn.appendChild(icon('arrowUp', { size: 15, stroke: 2.2 }));
        sendBtn.title = selectedBranch && !input.value.trim() ? '确认这个走向' : '发送';
        sendBtn.disabled = !has;
      }
    }

    function onSendClick() {
      if (streaming) { abortCtl?.abort(); return; }
      doSend();
    }

    function doSend() {
      if (streaming) return;
      const text = input.value.trim();
      const imgs = attachments.map((a) => a.dataUrl);

      if (selectedBranch && !text) {
        const b = selectedBranch;
        resetInput();
        send({ branchChoice: b, images: imgs });
        return;
      }
      if (!text && !imgs.length) {
        toast('说点什么，或选一个走向');
        return;
      }
      resetInput();
      send({ playerText: text, images: imgs });
    }

    function resetInput() {
      input.value = '';
      input.style.height = 'auto';
      attachments = [];
      renderAttachments();
      clearSelection();
      paintSend();
    }

    function openCustomAction() {
      const ta = el('textarea.field', { placeholder: '描述你打算做什么、说什么…', rows: 5 });
      openSheet({
        title: '自定义行动',
        confirmText: '发送',
        render(body) {
          body.appendChild(el('div', {}, ta,
            el('div.field-hint', {}, '这段文字会作为你的回合交给演绎引擎，NPC 与世界的反应由它续写。'),
          ));
          setTimeout(() => ta.focus(), 200);
        },
        async onConfirm() {
          const v = ta.value.trim();
          if (!v) { toast('行动不能为空'); return false; }
          send({ playerText: v });
        },
      });
    }

    async function onFiles(e) {
      const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
      for (const f of files.slice(0, 4)) {
        try {
          const dataUrl = await readAsDataURL(f);
          attachments.push({ name: f.name, dataUrl });
        } catch { /* 跳过 */ }
      }
      renderAttachments();
      paintSend();
      e.target.value = '';
    }

    function renderAttachments() {
      clear(attachStrip);
      if (!attachments.length) { attachStrip.style.display = 'none'; return; }
      attachStrip.style.display = '';
      attachments.forEach((a, i) => {
        attachStrip.appendChild(el('div.attach', {},
          el('img', { src: a.dataUrl, alt: a.name, onclick: () => openLightbox(a.dataUrl) }),
          el('button.attach-x', {
            type: 'button', 'aria-label': '移除',
            onclick: () => { attachments.splice(i, 1); renderAttachments(); paintSend(); },
          }, icon('close', { size: 10, stroke: 2.4 })),
        ));
      });
    }

    /* =====================================================================
     * 消息操作
     * ===================================================================== */
    async function rewriteTurn(turnNo) {
      if (streaming) return toast('正在演绎中');
      if (!turnNo) return toast('无法定位该轮');

      const ta = el('textarea.field', { rows: 3, placeholder: '可选：这次要怎么改？（例如「更压抑一些，不要引入新角色」）' });
      openSheet({
        title: `重写第 ${turnNo} 轮`,
        confirmText: '重写',
        render(body) {
          body.appendChild(el('div', {}, ta,
            el('div.field-hint', {}, '重写会从这一轮之前开一条新分支，旧线保留为「如果当时那么写」。再用同样的行动重新演绎。'),
          ));
          setTimeout(() => ta.focus(), 200);
        },
        async onConfirm() {
          const guidance = ta.value.trim();
          const ok = await confirmDialog({
            title: '确认重写',
            message: `会从第 ${turnNo} 轮之前开一条新分支，当前分支标为 abandoned（历史不删）。`,
            confirmText: '重写', destructive: true,
          });
          if (!ok) return false;
          runRewrite(turnNo, guidance);
          return true;
        },
      });
    }

    async function runRewrite(turnNo, guidance) {
      if (streaming) return;
      streaming = true;
      abortCtl = new AbortController();
      paintSend();
      clearBranches();
      removeContinue();

      const host = scroll.querySelector('.play-body');
      clear(host);
      branchHost = el('div', {});
      host.appendChild(branchHost);

      const kept = (detail.turns || []).filter((t) => t.turn_no < turnNo);
      let shown = 0;
      for (const t of kept) {
        if (t.turn_no !== shown) {
          shown = t.turn_no;
          host.insertBefore(turnMark(shown, t.created_at), branchHost);
        }
        if (t.kind === 'player') appendPlayer(t.content, t.images, t.branch_choice, host);
        else if (t.kind === 'narrator') appendNarrator(t.content, t.reasoning, t.turn_no, { usage: t.usage, host });
      }
      lastTurnNo = Math.max(0, turnNo - 1);

      const pending = el('div.gen-pending', {},
        el('span.typing-dots', {}, el('i'), el('i'), el('i')),
        el('span', {}, '重新演绎中'),
      );
      host.insertBefore(pending, branchHost);
      live = { node: null, prose: null, think: null, thinkBody: null, reasoning: '', text: '', usage: null };

      try {
        await api.rewrite(sessionId, { turn_no: turnNo, guidance }, {
          signal: abortCtl.signal,
          onEvent: handleEvent(pending),
        });
        finalize();
        detail = await api.getSession(sessionId);
        renderTurns();
        updateSub();
        paintRing();
      } catch (err) {
        pending.remove();
        finalize();
        if (err?.name !== 'AbortError') toast(err.message || '重写失败', { type: 'error' });
      } finally {
        streaming = false;
        abortCtl = null;
        paintSend();
      }
    }

    async function editTurn(turnNo, kind, text) {
      const ta = el('textarea.field', { rows: 8 });
      ta.value = text;
      openSheet({
        title: `编辑第 ${turnNo} 轮 · ${kind === 'player' ? '你的行动' : '旁白'}`,
        confirmText: '保存',
        render(body) {
          body.appendChild(el('div', {}, ta,
            el('div.field-hint', {}, '只改这一轮的正文。已经写进记忆账本的内容不会自动重算——需要时用「重写」重跑这一轮。'),
          ));
        },
        async onConfirm() {
          const v = ta.value.trim();
          if (!v) { toast('内容不能为空'); return false; }
          try {
            await api.updateTurn(sessionId, turnNo, { kind, content: v });
            detail = await api.getSession(sessionId);
            renderTurns();
            toast('已保存', { type: 'success' });
          } catch (err) {
            toast(err.message, { type: 'error' });
            return false;
          }
          return true;
        },
      });
    }

    async function rollbackTo(turnNo) {
      if (streaming) return toast('正在演绎中');
      const ok = await confirmDialog({
        title: `回到第 ${turnNo} 轮`,
        message: `会从第 ${turnNo} 轮开一条新分支。当前这条线标为 abandoned，历史不删，随时可以回去看。`,
        confirmText: '回滚', destructive: true,
      });
      if (!ok) return;
      showLoading();
      try {
        await api.rollback(sessionId, turnNo);
        detail = await api.getSession(sessionId);
        renderTurns();
        clearBranches();
        showContinue();
        updateSub();
        paintRing();
        toast(`已回到第 ${turnNo} 轮`, { type: 'success' });
      } catch (err) {
        toast(err.message, { type: 'error' });
      } finally {
        hideLoading();
      }
    }

    /* =====================================================================
     * 更多 / 搜索
     * ===================================================================== */
    function segmentationOn() {
      return detail?.session?.settings?.narration_mode === 'segmented';
    }

    function segmentationLabel() {
      const v = detail?.session?.settings?.narration_mode;
      if (v === 'segmented') return '分段演绎：已开';
      if (v === 'single') return '分段演绎：已关';
      return '开启分段演绎';
    }

    async function toggleSegmentation() {
      const next = segmentationOn() ? 'single' : 'segmented';
      try {
        const updated = await api.patchSession(sessionId, { settings: { narration_mode: next } });
        if (detail?.session) detail.session = updated || { ...detail.session, settings: { ...(detail.session.settings || {}), narration_mode: next } };
        toast(next === 'segmented' ? '已开启分段演绎（下一拍生效）' : '已关闭分段演绎', { type: 'success' });
      } catch (err) {
        toast(err.message || '切换失败', { type: 'error' });
      }
    }

    async function openMore() {
      const action = await openActionSheet({
        title: detail.session?.title || '剧情',
        actions: [
          { label: '接着演绎', value: 'continue', icon: 'sparkles' },
          {
            label: segmentationLabel(),
            value: 'segmented',
            icon: 'sparkles',
          },
          { label: '换一批走向', value: 'branches', icon: 'compass' },
          { label: '搜索本段剧情', value: 'search', icon: 'search' },
          { label: '回忆旧事', value: 'recall', icon: 'rewind' },
          { label: '记忆与上下文', value: 'memory', icon: 'memory' },
          { label: '跑一次校勘', value: 'audit', icon: 'check' },
          { label: '导出', value: 'export', icon: 'download' },
          { label: '世界卡', value: 'world', icon: 'book' },
          { label: '删除这段剧情', value: 'delete', icon: 'trash', destructive: true },
        ],
      });
      if (action === 'continue') send({ silent: true, generateBranches: true });
      else if (action === 'segmented') toggleSegmentation();
      else if (action === 'branches') regenerateBranches();
      else if (action === 'search') openSearch();
      else if (action === 'recall') openRecall();
      else if (action === 'memory') openMemory();
      else if (action === 'audit') {
        try {
          const report = await api.audit(sessionId);
          const issues = report.issues || [];
          if (!issues.length) toast('校勘通过：没有发现矛盾');
          else {
            toast(`发现 ${issues.length} 处问题，详见记忆面板`);
            openMemory();
          }
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      }
      else if (action === 'export') {
        const { exportMarkdown } = await import('../export.js');
        exportMarkdown(sessionId).catch((e) => toast(e.message, { type: 'error' }));
      } else if (action === 'world') {
        navigate(detail.session?.world_id ? `#/world/${detail.session.world_id}` : '#/worlds');
      } else if (action === 'delete') {
        const ok = await confirmDialog({
          title: '删除剧情', message: '全部轮次与记忆将被永久删除。',
          confirmText: '删除', destructive: true,
        });
        if (ok) {
          await api.deleteSession(sessionId);
          toast('已删除', { type: 'success' });
          window.dispatchEvent(new CustomEvent('worlds:changed'));
          navigate(detail.session?.world_id ? `#/world/${detail.session.world_id}` : '#/worlds');
        }
      }
    }

    function openSearch() {
      const results = el('div');
      const input2 = el('input.field', { placeholder: '搜索所有轮次的正文…', type: 'search' });
      const run = debounce(async () => {
        const q = input2.value.trim();
        clear(results);
        if (!q) return;
        results.appendChild(el('div', { style: 'padding:20px;text-align:center;' }, el('span.spinner')));
        try {
          const { hits } = await api.searchSession(sessionId, q);
          clear(results);
          if (!hits.length) {
            results.appendChild(el('div.empty', {},
              el('div.empty-icon', {}, icon('search', { size: 18 })),
              el('div.empty-title', {}, '没有找到'),
              el('div.empty-sub', {}, `「${q}」在这段剧情里没有出现。`),
            ));
            return;
          }
          results.appendChild(el('div', {
            style: 'padding:4px 2px 10px;font-size:var(--fs-caption);color:var(--ink-4);',
          }, `找到 ${hits.length} 处`));
          for (const h of hits) {
            results.appendChild(el('button', {
              type: 'button',
              style: 'display:block;width:100%;text-align:left;padding:9px 11px;margin-bottom:5px;border:1px solid var(--line);border-radius:8px;background:var(--paper-raised);',
              onclick: () => { handle.close?.(); jumpToTurn(h.turn_no); },
            },
              el('div', { style: 'font-size:10px;color:var(--ink-4);margin-bottom:3px;' },
                `第 ${h.turn_no} 轮 · ${h.kind === 'player' ? '你的行动' : '旁白'}`),
              el('div', { style: 'font-size:var(--fs-caption);line-height:1.7;color:var(--ink-2);' },
                h.before,
                el('mark', { style: 'background:var(--accent-soft);color:var(--accent);border-radius:2px;padding:0 1px;' }, h.match),
                h.after,
              ),
            ));
          }
        } catch (err) {
          clear(results);
          results.appendChild(el('div.err-bar', {}, err.message));
        }
      }, 300);
      input2.addEventListener('input', run);

      const handle = openSheet({
        title: '搜索剧情',
        cancelText: '关闭',
        render(body) {
          body.appendChild(el('div', { style: 'margin-bottom:10px;' }, input2));
          body.appendChild(results);
          setTimeout(() => input2.focus(), 200);
        },
      });
    }

    function jumpToTurn(turnNo) {
      const mark = scroll.querySelector(`.turn-mark[data-turn="${turnNo}"]`);
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        toast(`第 ${turnNo} 轮不在当前视图中`);
      }
    }

    /* =====================================================================
     * 上下文 / 记忆
     * ===================================================================== */
    function paintRing() {
      const max = Number(memStats?.context_max) || 200000;
      const used = Number(memStats?.context_tokens) || 0;
      const ratio = max > 0 ? Math.min(1, used / max) : 0;
      clear(ringSlot);
      ringSlot.appendChild(buildRing(ratio, {
        size: 20, stroke: 2.4,
        center: `${Math.round(ratio * 100)}`,
        centerSize: '7px',
        color: ratio > 0.85 ? 'var(--warn)' : 'var(--accent)',
      }));
      memBtn.title = `上下文 ${fmtPercent(ratio)}（${fmtTokens(used)} / ${fmtTokens(max)}）`;
    }

    function paintCtxMeter() {
      const soft = Number(memStats?.context_soft) || 52000;
      const used = assemblerBudget?.total ?? (Number(memStats?.context_tokens) || 0);
      const ratio = soft > 0 ? Math.min(1, used / soft) : 0;
      ctxMeterFill.style.width = `${(ratio * 100).toFixed(1)}%`;
      ctxMeterFill.style.background = ratio > 0.9 ? 'var(--warn)' : 'var(--accent)';
      const val = composerWrap.querySelector('.ctx-meter-val');
      if (val) val.textContent = `${fmtTokens(used)} / ${fmtTokens(soft)}`;
    }

    function openMemory() {
      openMemoryPanel(sessionId, {
        onUpdate: (s) => {
          if (!s) return;
          memStats = s;
          paintRing();
          paintCtxMeter();
        },
      });
    }

    /* =====================================================================
     * 场记单 / 切场 / 世界呼吸 / 回忆
     *
     * 这四个东西是 v4 的「世界在呼吸」的可视化：
     *   - 场记单：这一刻世界的既定事实（引擎据此接续）
     *   - 切场卡片：一场戏结束时发生了什么变化
     *   - 世界呼吸：玩家看不见的地方，人物按自己的私心动了
     *   - 回忆：按需去原文里找旧事，带出处
     * ===================================================================== */

    /** 在场记单位置展示本轮的场记单（可折叠）。 */
    function showSceneSheet(text) {
      let host = scroll.querySelector('.scene-sheet-slot');
      if (!host) {
        host = el('div.scene-sheet-slot');
        const body = scroll.querySelector('.play-body');
        if (body) body.appendChild(host);
      }
      clear(host);
      const box = el('details.scene-sheet', {},
        el('summary', {}, '本场场记单'),
        el('pre.scene-sheet-text', {}, text),
      );
      host.appendChild(box);
    }

    /** 切场时在正文流里插一张场次卡。 */
    function appendSceneCard(evt) {
      const body = scroll.querySelector('.play-body');
      if (!body) return;
      const card = el('div.scene-card', {},
        el('div.scene-card-head', {},
          el('span.scene-card-id', {}, evt.scene_id || ''),
          el('span.scene-card-range', {}, `第 ${evt.turn_from}-${evt.turn_to} 轮`),
        ),
        evt.question ? el('div.scene-card-q', {}, `本场在问：${evt.question}`) : null,
        evt.outcome ? el('div.scene-card-outcome', {}, evt.outcome) : null,
      );
      body.appendChild(card);
    }

    /** 世界呼吸：幕后事件以流言形式出现，不直接告诉玩家「发生了什么」。 */
    function appendWorldTick(events) {
      const body = scroll.querySelector('.play-body');
      if (!body) return;
      const visible = events.filter((e) => e.visibility !== 'hidden');
      if (!visible.length) return;
      const card = el('div.world-tick', {},
        el('div.world-tick-head', {}, '此刻别处'),
        ...visible.map((e) => el('div.world-tick-item', {},
          el('span.world-tick-who', {}, (e.who || []).join('、')),
          el('span.world-tick-what', {}, e.what),
        )),
      );
      body.appendChild(card);
    }

    /** 回忆：问一句旧事，检索 Agent 去原文里找，带出处。 */
    async function openRecall() {
      const q = window.prompt('想问哪件旧事？');
      if (!q || !q.trim()) return;
      const sheet = openSheet({
        title: '回忆',
        width: 560,
        render(b) {
          clear(b);
          b.appendChild(el('p.muted', {}, '检索中…'));
        },
      });
      try {
        const r = await api.recall(sessionId, q.trim());
        clear(sheet.body);
        if (!r.found) {
          sheet.body.appendChild(el('p.muted', {}, '正文里没有写过这个。'));
          return;
        }
        sheet.body.appendChild(el('p.recall-answer', {}, r.answer));
        if (r.citations?.length) {
          sheet.body.appendChild(el('h4', {}, '出处'));
          for (const c of r.citations) {
            sheet.body.appendChild(el('div.recall-cite', {},
              el('span.recall-cite-turn', {}, `第 ${c.turn_no} 轮`),
              el('span.recall-cite-text', {}, c.quote),
            ));
          }
        }
      } catch (err) {
        clear(sheet.body);
        sheet.body.appendChild(el('p.muted', {}, `检索失败：${err.message}`));
      }
    }

    /* =====================================================================
     * 杂项
     * ===================================================================== */
    function scrollToBottom(smooth) {
      requestAnimationFrame(() => {
        scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      });
    }

    async function runOpening() {
      if (streaming) return;
      streaming = true;
      abortCtl = new AbortController();
      paintSend();
      clearBranches();
      const host = scroll.querySelector('.play-body');
      clear(host);
      branchHost = el('div', {});
      host.appendChild(branchHost);

      const pending = el('div.gen-pending', {},
        el('span.typing-dots', {}, el('i'), el('i'), el('i')),
        el('span', {}, '起笔中'),
      );
      host.insertBefore(pending, branchHost);
      live = { node: null, prose: null, think: null, thinkBody: null, reasoning: '', text: '', usage: null };

      try {
        await api.generateOpening(sessionId, {
          signal: abortCtl.signal,
          onEvent: handleEvent(pending),
        });
        finalize();
        detail = await api.getSession(sessionId);
        updateSub();
      } catch (err) {
        pending.remove();
        finalize();
        if (err?.name !== 'AbortError') toast(err.message || '起笔失败', { type: 'error' });
      } finally {
        streaming = false;
        abortCtl = null;
        paintSend();
      }
    }

    function onSessionsChanged() {
      api.getSession(sessionId).then((d) => {
        detail = d;
        updateSub();
      }).catch(() => {});
    }

    paintSend();
    paintRing();

    return {
      unmount() {
        abortCtl?.abort();
        document.removeEventListener('sessions:changed', onSessionsChanged);
        document.title = '叙事台';
      },
    };
  },
};

/* =========================================================================
 * 辅助
 * ========================================================================= */

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images.map((im) => {
    if (typeof im === 'string') return im;
    return im?.url || im?.image_url?.url || im?.dataUrl || '';
  }).filter(Boolean);
}

function openLightbox(src) {
  const box = el('div.lightbox', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': '图片预览',
  }, el('img', { src, alt: '' }));
  document.body.appendChild(box);
  const onKey = (e) => {
    if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
  });
}

function debounce(fn, wait = 300) {
  let t = null;
  return function debounced(...args) {
    if (t != null) clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(this, args); }, wait);
  };
}
