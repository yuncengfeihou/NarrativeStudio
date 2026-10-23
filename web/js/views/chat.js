/**
 * views/chat.js — 对话视图（核心）
 *
 * 阅读优先的排版：旁白是全宽正文，玩家是右侧气泡。
 * 功能：
 *  - SSE 流式演绎（reasoning / narrative 增量），思考过程可折叠
 *  - 分支选项卡片，选中后可发送或自由输入
 *  - 回合导航、跳转最新、消息级操作（复制/重写/回滚/编辑）
 *  - 记忆面板入口（导航栏环形进度条）
 *  - 图片输入、停止生成、错误重试
 */

import {
  $, $$, el, clear, formatClock, formatTime, firstChar, hueFromString, avatarBackground,
  copyToClipboard, readAsDataURL, isNearBottom, debounce, fmtTokens, truncate,
} from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import {
  navigate, openActionSheet, openSheet, openPopover, confirmDialog, toast,
  showLoading, hideLoading,
} from '../app.js';
import { syncActive } from '../sidebar.js';
import { ui } from '../store.js';
import { openMemoryPanel, buildRing } from '../panels/memory.js';
import { formatNarrative } from '../markdown.js';

const TONE_EMOJI = { 激进: '⚔', 谨慎: '◈', 探索: '⌖', 情感: '♡', 智取: '◐', 诡道: '☾' };

export default {
  id: 'chat',
  title: '剧情',

  async mount(root, params) {
    const sessionId = params.id;
    if (!sessionId) { navigate('#/'); return { unmount() {} }; }

    /* ---------------- 运行时状态 ---------------- */
    let detail = null;
    let settings = {};
    let title = '剧情';
    let hue = 210;
    let streaming = false;
    let abortCtl = null;
    let live = null;              // 流式中的旁白节点引用
    let branchSet = null;
    let selectedBranch = null;
    let attachments = [];
    let contextRatio = 0;
    let turnCount = 0;
    let lastTurnNo = 0;

    /* ---------------- DOM ---------------- */
    let navEl, scroll, bodyEl, msgListEl, branchHost, composerWrap;
    let input, sendBtn, attachStrip, quickRow, selStrip, ringSlot, jumpBtn, fileInput;
    let memStats = null;

    /* ---------------- 骨架 ---------------- */
    const navAvatar = el('div.nav-avatar', {}, '·');
    const navName = el('div.nav-identity-name', {}, '加载中');
    const navSub = el('div.nav-identity-sub', {}, '');
    ringSlot = el('span', { style: 'display:flex;' });

    const memBtn = el('button.nav-mem', {
      type: 'button', title: '记忆系统', 'aria-label': '记忆系统',
      onclick: () => openMemoryPanel(sessionId, { onUpdate: (s) => { if (s) { memStats = s; paintRing(); } } }),
    }, ringSlot);

    const moreBtn = el('button.icon-btn', {
      type: 'button', title: '更多', 'aria-label': '更多操作',
      onclick: () => openMore(),
    }, icon('more', { size: 18 }));

    navEl = el('header.nav', {},
      el('button.icon-btn.nav-hamburger', {
        type: 'button', 'aria-label': '会话库',
        onclick: () => import('../sidebar.js').then((m) => m.openSidebar()),
      }, icon('sidebar', { size: 19 })),
      el('button.nav-back', {
        type: 'button', title: '返回', onclick: goBack,
      }, icon('chevronLeft', { size: 19, stroke: 2.2 })),
      el('div.nav-identity', {},
        navAvatar,
        el('div.nav-identity-text', {}, navName, navSub),
      ),
      memBtn,
      moreBtn,
    );

    msgListEl = el('div.msg-list', {});
    branchHost = el('div', {});
    bodyEl = el('div.chat-body', {}, msgListEl, branchHost);
    scroll = el('div.scroll.chat-scroll', {}, bodyEl);

    /* ---------------- 输入区 ---------------- */
    input = el('textarea.composer-input', {
      rows: 1,
      placeholder: '讲述你的行动，或选择一个分支…',
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
      type: 'button', title: '添加图片 / 自定义行动', 'aria-label': '添加',
      onclick: () => openPlus(),
    }, icon('plus', { size: 19, stroke: 2 }));

    sendBtn = el('button.composer-send', {
      type: 'button', 'aria-label': '发送', title: '发送', onclick: onSendClick,
    }, icon('arrowUp', { size: 17, stroke: 2.4 }));

    selStrip = el('div', { style: 'display:none;' });
    quickRow = el('div.quick-branches', { style: 'display:none;' });
    attachStrip = el('div.attach-strip', { style: 'display:none;' });

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
        ),
      ),
    );

    fileInput = el('input', {
      type: 'file', accept: 'image/*', multiple: true, style: 'display:none;',
      onchange: onFiles,
    });

    jumpBtn = el('button.jump-latest', { type: 'button', onclick: () => scrollToBottom(true) },
      icon('chevronDown', { size: 13 }), '最新',
    );

    const view = el('section.view.chat-view', { 'data-view': 'chat' },
      navEl, scroll, composerWrap, jumpBtn, fileInput,
    );
    root.appendChild(view);

    scroll.addEventListener('scroll', () => {
      jumpBtn.classList.toggle('is-visible', !isNearBottom(scroll, 160));
      navEl.classList.toggle('is-scrolled', scroll.scrollTop > 6);
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
      navigate('#/');
      return { unmount() {} };
    }
    hideLoading();

    settings = detail.session?.settings || {};
    title = settings.title || detail.session?.title || '剧情';
    hue = typeof settings.characters?.[0]?.avatar_hue === 'number'
      ? settings.characters[0].avatar_hue : hueFromString(title);
    turnCount = detail.session?.turn_count ?? 0;

    navName.textContent = title;
    navAvatar.textContent = firstChar(title);
    navAvatar.style.background = avatarBackground(hue);
    document.title = `${title} · 角色剧场`;
    memStats = detail.memoryStats;
    paintRing();
    updateSub();
    syncActive(sessionId);

    renderTurns();

    document.addEventListener('chat:open-memory', onMemoryEvent);
    window.addEventListener('sessions:changed', onSessionsChanged);

    /* =====================================================================
     * 渲染既有回合
     * ===================================================================== */
    function renderTurns() {
      clear(msgListEl);
      const turns = (detail.turns || []).slice().sort((a, b) => (a.turn_no ?? 0) - (b.turn_no ?? 0));

      if (!turns.length) {
        renderEmptyOpening();
        return;
      }

      let shown = 0;
      for (const t of turns) {
        // 开场轮没有玩家行动，仅为占位（content 为空、无图、无分支）→ 跳过渲染
        if (t.kind === 'player' && !String(t.content || '').trim()
            && !normalizeImages(t.images).length && !t.branch_choice) {
          continue;
        }
        if (t.turn_no !== shown) {
          shown = t.turn_no;
          msgListEl.appendChild(turnMark(shown, t.created_at));
          lastTurnNo = Math.max(lastTurnNo, shown);
        }
        if (t.kind === 'player') appendPlayer(t.content, t.images, t.branch_choice);
        else if (t.kind === 'narrator') appendNarrator(t.content, t.reasoning, t.turn_no);
        else if (t.kind === 'system') appendSystem(t.content);
      }
      scrollToBottom(false);

      // 重新打开会话时，分支选项不在内存里：给一条低摩擦的召回入口，
      // 而不是自动调用一次昂贵的分支生成。
      const lastNarr = [...turns].reverse().find((t) => t.kind === 'narrator');
      if (lastNarr && !branchHost.querySelector('.branches')) {
        branchHost.appendChild(el('div.continue-row', {},
          el('button.btn.btn-tinted', {
            type: 'button',
            onclick: (e) => { e.currentTarget.closest('.continue-row')?.remove(); regenerateBranches(); },
          }, icon('compass', { size: 15 }), '看看接下来的选项'),
          el('button.btn.btn-ghost', {
            type: 'button',
            onclick: (e) => { e.currentTarget.closest('.continue-row')?.remove(); send({ silent: true }); },
          }, '直接继续演绎'),
        ));
      }
    }

    function renderEmptyOpening() {
      const opening = String(settings.opening || '').trim();
      if (opening) {
        appendNarrator(opening, '', 1, { label: '序幕', animate: false });
      } else {
        msgListEl.appendChild(el('div.empty', {},
          el('div.empty-icon', {}, icon('wand', { size: 26 })),
          el('div.empty-title', {}, '故事还没开始'),
          el('div.empty-sub', {}, '在下方输入你的第一个行动，演绎会从这里展开。'),
        ));
      }
      // 若存在开场但未生成分支，给一个继续入口
      if (opening) {
        branchHost.appendChild(el('div.continue-row', {},
          el('button.btn.btn-tinted', { type: 'button', onclick: () => send({ generateBranches: true }) },
            icon('sparkles', { size: 15 }), '开始演绎'),
        ));
      }
    }

    function turnMark(no, ts) {
      if (ui.get().showTurnMarks === false) return el('span');
      const clock = ts ? formatClock(ts) : '';
      return el('div.turn-mark', { dataset: { turn: no } },
        el('span.turn-mark-line'),
        el('span.turn-mark-label', {},
          `第 ${no} 回合${clock ? ` · ${clock}` : ''}`,
        ),
        el('span.turn-mark-line'),
      );
    }

    /* =====================================================================
     * 消息节点
     * ===================================================================== */
    function appendNarrator(content, reasoning, turnNo, opts = {}) {
      const { label = '旁白', animate = true } = opts;
      const node = el('div.narr', { style: animate ? '' : 'animation:none;' });

      const head = el('div.narr-head', {},
        el('div.narr-avatar', { style: `background:${avatarBackground(hue)};` }, firstChar(title)),
        el('span.narr-label', {}, label),
      );
      node.appendChild(head);

      if (reasoning && String(reasoning).trim()) {
        node.appendChild(thinkBox(String(reasoning), { open: ui.get().showReasoning === true }));
      }

      const prose = el('div.prose');
      prose.innerHTML = formatNarrative(content);
      node.appendChild(prose);

      node.appendChild(el('div.narr-actions', {},
        miniBtn('copy', '复制', async () => {
          const ok = await copyToClipboard(prose.innerText);
          toast(ok ? '已复制正文' : '复制失败', { type: ok ? 'success' : 'error' });
        }),
        miniBtn('rewind', '重写此轮', () => rewriteTurn(turnNo, node)),
        miniBtn('edit', '编辑', () => editTurn(turnNo, 'narrator', prose.innerText, node)),
        miniBtn('history', '回到此轮', () => rollbackTo(turnNo)),
      ));

      msgListEl.appendChild(node);
      return { node, prose };
    }

    function appendPlayer(content, images, branchChoice) {
      const node = el('div.player');
      const bubble = el('div.player-bubble');
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
          TONE_EMOJI[branchChoice.tone] || '◈',
          branchChoice.title || '分支',
        ));
      }
      const text = String(content || '').trim();
      if (text) bubble.appendChild(el('span.player-text', {}, text));
      else if (!imgs.length) bubble.appendChild(el('span', { style: 'opacity:.6;' }, '（空行动）'));

      node.appendChild(bubble);
      node.appendChild(el('div.player-actions', {},
        miniBtn('copy', '复制', async () => {
          const ok = await copyToClipboard(text);
          toast(ok ? '已复制' : '复制失败', { type: ok ? 'success' : 'error' });
        }),
      ));
      msgListEl.appendChild(node);
      return node;
    }

    function appendSystem(content) {
      msgListEl.appendChild(el('div.sysline', {}, el('span.sysline-inner', {}, content)));
    }

    function miniBtn(iconName, label, onClick) {
      return el('button.mini-btn', { type: 'button', onclick: onClick },
        icon(iconName, { size: 13 }), label);
    }

    function thinkBox(text, { open = false, streaming = false } = {}) {
      const body = el('div.think-body');
      body.textContent = text;
      const box = el('div.think', { class: `${open ? 'is-open' : ''} ${streaming ? 'is-streaming' : ''}` },
        el('button.think-toggle', { type: 'button' },
          icon('sparkles', { size: 13 }),
          '思考过程',
          el('span.chev', {}, icon('chevronRight', { size: 12 })),
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

      if (!silent && (playerText || images.length || branchChoice)) {
        const shown = playerText || (branchChoice ? branchChoice.description || branchChoice.title : '');
        appendPlayer(shown, images, branchChoice);
      }
      scrollToBottom(true);

      // 待生成指示
      const pending = el('div.gen-pending', {},
        el('span.typing-dots', {}, el('i'), el('i'), el('i')),
        el('span', {}, '演绎中'),
      );
      msgListEl.appendChild(pending);

      live = { node: null, prose: null, think: null, thinkBody: null, reasoning: '', text: '' };

      const payload = {
        playerText: playerText || (branchChoice ? branchChoice.description || branchChoice.title : ''),
        images: images.length ? images : undefined,
        branchChoice: branchChoice || undefined,
        generateBranches,
      };

      try {
        await api.runTurn(sessionId, payload, {
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
            const mark = turnMark(lastTurnNo, Date.now());
            if (pending.parentNode) msgListEl.insertBefore(mark, pending);
            else msgListEl.appendChild(mark);
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
          case 'narrative_done':
            if (evt.content) live.text = evt.content;
            break;
          case 'narrative_reset':
            // 上游只回了思考、没有正文：清空半成品，等待重试结果
            if (live) { live.text = ''; live.reasoning = ''; }
            if (live?.prose) live.prose.innerHTML = '';
            break;
          case 'branches':
            if (evt.branches?.length) {
              renderBranches({ branches: evt.branches, scene_summary: evt.scene_summary });
            } else if (evt.degraded) {
              // 分支降级：不打扰用户，只给「继续」入口
              showContinue();
            }
            break;
          case 'memory':
            if (evt.stats && !evt.stats.error) {
              memStats = { ...(memStats || {}), ...evt.stats };
              paintRing();
            }
            break;
          case 'done':
            finalize();
            updateSub();
            paintRing();
            window.dispatchEvent(new CustomEvent('sessions:changed'));
            break;
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

    function finalize() {
      if (!live) return;
      if (live.prose) live.prose.innerHTML = formatNarrative(live.text);
      if (live.think) live.think.classList.remove('is-streaming');
      if (live.node && !live.text.trim()) live.node.remove();
      live = null;
    }

    function showError(message) {
      const bar = el('div.err-bar', { role: 'alert' },
        icon('warn', { size: 16 }),
        el('div', { class: 'spacer' },
          el('div', {}, message),
          el('button.btn.btn-tinted.btn-sm', { type: 'button', onclick: () => { bar.remove(); send({ silent: true }); } },
            '重试'),
        ),
        el('button.icon-btn.is-sm', { type: 'button', 'aria-label': '关闭', onclick: () => bar.remove() },
          icon('close', { size: 14 })),
      );
      msgListEl.appendChild(bar);
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

      const wrap = el('div.branches', {});
      wrap.appendChild(el('div.branches-head', {},
        icon('compass', { size: 13 }),
        el('span', {}, '接下来'),
        el('span.spacer'),
        el('button.mini-btn', { type: 'button', onclick: regenerateBranches },
          icon('refresh', { size: 12 }), '换一批'),
      ));
      if (set.scene_summary) {
        wrap.appendChild(el('div.branches-scene', {}, set.scene_summary));
      }

      const list = el('div.branch-list');
      set.branches.forEach((b, i) => {
        list.appendChild(el('button.branch', {
          type: 'button',
          style: `--stagger:${i * 32}ms;`,
          onclick: () => selectBranch(b),
          ondblclick: () => { selectBranch(b); doSend(); },
        },
          el('span.branch-key', {}, String(i + 1)),
          el('span.branch-body', {},
            el('span.branch-title-row', {},
              el('span.branch-title', {}, b.title || '行动'),
              el('span.branch-tone', { dataset: { tone: b.tone || '' } }, b.tone || '行动'),
              b.tension_delta != null
                ? el('span.branch-tension', {}, `张力 ${Number(b.tension_delta) > 0 ? '+' : ''}${(Number(b.tension_delta) * 100).toFixed(0)}`)
                : null,
            ),
            el('span.branch-desc', {}, b.description || ''),
          ),
        ));
      });
      wrap.appendChild(list);

      wrap.appendChild(el('div.branches-foot', {},
        el('button.mini-btn', { type: 'button', onclick: openCustomAction },
          icon('edit', { size: 12 }), '自定义行动'),
        el('span.spacer'),
        el('span', { style: 'font-size:var(--fs-caption);color:var(--label-tertiary);' }, '点两下直接发送'),
      ));

      branchHost.appendChild(wrap);
      scrollToBottom(true);

      // 输入区上方快捷 pills
      set.branches.forEach((b, i) => {
        quickRow.appendChild(el('button.qb', {
          type: 'button', dataset: { idx: String(i) },
          onclick: () => selectBranch(b),
        },
          el('span.qb-tone', {}, TONE_EMOJI[b.tone] || '◈'),
          b.title || '行动',
        ));
      });
      quickRow.appendChild(el('button.qb', { type: 'button', onclick: openCustomAction },
        el('span.qb-tone', {}, '✎'), '自由行动'));
      quickRow.style.display = '';
    }

    function selectBranch(b) {
      selectedBranch = b;
      $$('.branch', branchHost).forEach((n, i) => {
        n.classList.toggle('is-selected', branchSet?.branches?.[i] === b);
      });
      $$('.qb', quickRow).forEach((n, i) => {
        n.classList.toggle('is-selected', branchSet?.branches?.[i] === b);
      });
      clear(selStrip);
      selStrip.style.display = '';
      selStrip.appendChild(icon('compass', { size: 14 }));
      selStrip.appendChild(el('span.sel-strip-title', {}, b.title || '行动'));
      selStrip.appendChild(el('span.spacer'));
      selStrip.appendChild(el('button.mini-btn', {
        type: 'button', onclick: () => { clearSelection(); },
      }, '取消'));
      input.placeholder = '点 ↑ 确认这个选择，或先说点什么…';
      input.focus();
      paintSend();
    }

    function clearSelection() {
      selectedBranch = null;
      $$('.branch.is-selected', branchHost).forEach((n) => n.classList.remove('is-selected'));
      $$('.qb.is-selected', quickRow).forEach((n) => n.classList.remove('is-selected'));
      selStrip.style.display = 'none';
      clear(selStrip);
      input.placeholder = '讲述你的行动，或选择一个分支…';
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
        el('button.btn.btn-tinted', { type: 'button', onclick: () => { removeContinue(); send({ silent: true, generateBranches: true }); } },
          icon('sparkles', { size: 15 }), '接着往下演绎'),
      ));
      scrollToBottom(true);
    }

    function removeContinue() {
      branchHost.querySelectorAll('.continue-row').forEach((n) => n.remove());
    }

    async function regenerateBranches() {
      if (streaming) return toast('正在演绎中');
      showLoading('正在设计分支…');
      try {
        const set = await api.generateBranches(sessionId);
        if (set?.branches?.length) {
          renderBranches(set);
          toast('已换一批分支', { type: 'success' });
        } else {
          toast('没能生成分支', { type: 'error' });
        }
      } catch (err) {
        toast(err.message, { type: 'error' });
      } finally {
        hideLoading();
      }
    }

    /* =====================================================================
     * 输入区交互
     * ===================================================================== */
    function onInput() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
      paintSend();
      if (input.value.trim() && selectedBranch) clearSelection();
    }

    function paintSend() {
      const has = input.value.trim().length > 0 || attachments.length > 0 || !!selectedBranch;
      if (streaming) {
        sendBtn.classList.add('is-stop');
        clear(sendBtn);
        sendBtn.appendChild(icon('stop', { size: 14, fill: true }));
        sendBtn.title = '停止生成';
        sendBtn.disabled = false;
      } else {
        sendBtn.classList.remove('is-stop');
        clear(sendBtn);
        sendBtn.appendChild(icon('arrowUp', { size: 17, stroke: 2.4 }));
        sendBtn.title = selectedBranch && !input.value.trim() ? '确认这个选择' : '发送';
        sendBtn.disabled = !has;
      }
    }

    function onSendClick() {
      if (streaming) {
        abortCtl?.abort();
        return;
      }
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
        toast('说点什么，或选一个分支');
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
          body.appendChild(el('div', { style: 'padding:12px 16px;' }, ta,
            el('div.field-hint', {}, '这段文字会作为你的回合交给演绎引擎，NPC 与世界的反应由它续写。'),
          ));
          setTimeout(() => ta.focus(), 220);
        },
        async onConfirm() {
          const v = ta.value.trim();
          if (!v) { toast('行动不能为空'); return false; }
          send({ playerText: v });
        },
      });
    }

    async function openPlus() {
      const action = await openActionSheet({
        title: '添加内容',
        actions: [
          { label: '图片', value: 'image', icon: 'image', desc: '把画面交给演绎引擎参考' },
          { label: '自定义行动', value: 'custom', icon: 'edit', desc: '打开发送前的编辑面板' },
        ],
      });
      if (action === 'image') fileInput.click();
      else if (action === 'custom') openCustomAction();
    }

    async function onFiles(e) {
      const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
      for (const f of files.slice(0, 4)) {
        try {
          const dataUrl = await readAsDataURL(f);
          attachments.push({ name: f.name, dataUrl });
        } catch { /* 跳过读取失败的 */ }
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
          }, icon('close', { size: 11, stroke: 2.6 })),
        ));
      });
    }

    /* =====================================================================
     * 消息操作：重写 / 编辑 / 回滚
     * ===================================================================== */
    async function rewriteTurn(turnNo) {
      if (streaming) return toast('正在演绎中');
      if (!turnNo) return toast('无法定位该回合');

      const ta = el('textarea.field', { rows: 3, placeholder: '可选：这次要怎么改？（例如「更压抑一些，不要引入新角色」）' });
      let guidance = '';

      openSheet({
        title: `重写第 ${turnNo} 回合`,
        confirmText: '重写',
        render(body) {
          body.appendChild(el('div', { style: 'padding:12px 16px;' },
            ta,
            el('div.field-hint', {}, '重写会先删掉这一回合并重新演绎。之前的内容无法恢复。'),
          ));
          setTimeout(() => ta.focus(), 220);
        },
        async onConfirm() {
          guidance = ta.value.trim();
          const ok = await confirmDialog({
            title: '确认重写',
            message: `第 ${turnNo} 回合会被重新演绎，此后的剧情也需要重新推进。`,
            confirmText: '重写', destructive: true,
          });
          if (!ok) return false;
          runRewrite(turnNo, guidance);
          return true;
        },
      });
    }

    /** 实际执行重写：先回滚再流式重跑 */
    async function runRewrite(turnNo, guidance) {
      if (streaming) return;
      streaming = true;
      abortCtl = new AbortController();
      paintSend();
      clearBranches();
      removeContinue();

      // 重建消息列表到 turnNo-1
      clear(msgListEl);
      const kept = (detail.turns || []).filter((t) => t.turn_no < turnNo);
      let shown = 0;
      for (const t of kept) {
        if (t.turn_no !== shown) {
          shown = t.turn_no;
          msgListEl.appendChild(turnMark(shown, t.created_at));
        }
        if (t.kind === 'player') appendPlayer(t.content, t.images, t.branch_choice);
        else if (t.kind === 'narrator') appendNarrator(t.content, t.reasoning, t.turn_no);
      }
      lastTurnNo = Math.max(0, turnNo - 1);

      const pending = el('div.gen-pending', {},
        el('span.typing-dots', {}, el('i'), el('i'), el('i')),
        el('span', {}, '重新演绎中'),
      );
      msgListEl.appendChild(pending);
      live = { node: null, prose: null, think: null, thinkBody: null, reasoning: '', text: '' };

      try {
        await api.rewrite(sessionId, { turn_no: turnNo, guidance }, {
          signal: abortCtl.signal,
          onEvent: handleEvent(pending),
        });
        finalize();
        // 刷新本地快照
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

    async function editTurn(turnNo, kind, text, node) {
      const ta = el('textarea.field', { rows: 8 });
      ta.value = text;
      openSheet({
        title: `编辑第 ${turnNo} 回合 · ${kind === 'player' ? '你的行动' : '旁白'}`,
        confirmText: '保存',
        render(body) {
          body.appendChild(el('div', { style: 'padding:12px 16px;' }, ta,
            el('div.field-hint', {}, '保存后会以新文本重新归档这一轮的记忆，让记忆与正文保持一致。'),
          ));
        },
        async onConfirm() {
          const v = ta.value.trim();
          if (!v) { toast('内容不能为空'); return false; }
          try {
            await api.updateTurn(sessionId, turnNo, { kind, content: v, rememorize: kind === 'narrator' });
            detail = await api.getSession(sessionId);
            renderTurns();
            toast('已保存并更新记忆', { type: 'success' });
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
        title: `回到第 ${turnNo} 回合`,
        message: `第 ${turnNo} 回合之后的剧情与记忆都会被删除。你可以在这一轮重新选择走向。`,
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
        toast(`已回到第 ${turnNo} 回合`, { type: 'success' });
      } catch (err) {
        toast(err.message, { type: 'error' });
      } finally {
        hideLoading();
      }
    }

    /* =====================================================================
     * 更多菜单
     * ===================================================================== */
    async function openMore() {
      const action = await openActionSheet({
        title: title,
        actions: [
          { label: '接着演绎', value: 'continue', icon: 'sparkles', desc: '不输入行动，让故事自己往下走' },
          { label: '换一批分支', value: 'branches', icon: 'compass' },
          { label: '搜索剧情', value: 'search', icon: 'search', desc: '全文检索所有回合' },
          { label: '记忆系统', value: 'memory', icon: 'memory' },
          { label: '导出剧情', value: 'export', icon: 'download' },
          { label: '编辑设定', value: 'setup', icon: 'edit' },
          { label: '删除剧情', value: 'delete', icon: 'trash', destructive: true },
        ],
      });
      if (action === 'continue') send({ silent: true, generateBranches: true });
      else if (action === 'branches') regenerateBranches();
      else if (action === 'search') openSearch();
      else if (action === 'memory') openMemoryPanel(sessionId, { onUpdate: (s) => { memStats = s; paintRing(); } });
      else if (action === 'export') {
        const { exportMarkdown } = await import('../export.js');
        exportMarkdown(sessionId).catch((e) => toast(e.message, { type: 'error' }));
      } else if (action === 'setup') navigate(`#/edit/${sessionId}`);
      else if (action === 'delete') {
        const ok = await confirmDialog({
          title: '删除剧情',
          message: '全部回合与记忆将被永久删除。',
          confirmText: '删除', destructive: true,
        });
        if (ok) {
          await api.deleteSession(sessionId);
          toast('已删除', { type: 'success' });
          window.dispatchEvent(new CustomEvent('sessions:changed'));
          navigate('#/');
        }
      }
    }

    /** 会话内全文搜索 */
    function openSearch() {
      const results = el('div', { style: 'padding:0 16px 8px;' });
      const input2 = el('input.field', { placeholder: '搜索所有回合的正文…', type: 'search' });
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
              el('div.empty-icon', {}, icon('search', { size: 22 })),
              el('div.empty-title', {}, '没有找到'),
              el('div.empty-sub', {}, `「${q}」在本段剧情中未出现。`),
            ));
            return;
          }
          results.appendChild(el('div', {
            style: 'padding:6px 2px 10px;font-size:var(--fs-caption);color:var(--label-tertiary);',
          }, `找到 ${hits.length} 处`));
          for (const h of hits) {
            results.appendChild(el('button.retrieval', {
              type: 'button',
              style: 'width:100%;text-align:left;margin-bottom:7px;cursor:pointer;',
              onclick: () => {
                handle.close?.();
                jumpToTurn(h.turn_no);
              },
            },
              el('div.retrieval-head', {},
                el('span.retrieval-src', {}, `第 ${h.turn_no} 回合 · ${h.kind === 'player' ? '你的行动' : '旁白'}`),
                el('span.retrieval-score', {}, formatTime(h.created_at)),
              ),
              el('div.retrieval-text', {},
                h.before,
                el('mark', { style: 'background:color-mix(in srgb,var(--yellow) 45%,transparent);color:inherit;border-radius:3px;padding:0 1px;' }, h.match),
                h.after,
              ),
            ));
          }
        } catch (err) {
          clear(results);
          results.appendChild(el('div.err-bar', {}, err.message));
        }
      }, 320);
      input2.addEventListener('input', run);

      const handle = openSheet({
        title: '搜索剧情',
        cancelText: '关闭',
        render(body) {
          body.appendChild(el('div', { style: 'padding:8px 16px;' }, input2));
          body.appendChild(results);
          setTimeout(() => input2.focus(), 220);
        },
      });
    }

    function jumpToTurn(turnNo) {
      const mark = msgListEl.querySelector(`.turn-mark[data-turn="${turnNo}"]`);
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'start' });
        mark.style.transition = 'opacity .4s';
        mark.style.opacity = '1';
      } else {
        toast(`第 ${turnNo} 回合不在当前视图中`);
      }
    }

    /* =====================================================================
     * 记忆环
     * ===================================================================== */
    function paintRing() {
      const max = Number(memStats?.context_max) || Number(settings.context_max_tokens) || 200000;
      const used = Number(memStats?.context_tokens) || 0;
      contextRatio = max > 0 ? Math.min(1, used / max) : 0;
      clear(ringSlot);
      ringSlot.appendChild(buildRing(contextRatio, {
        size: 26, stroke: 3.4,
        center: `${Math.round(contextRatio * 100)}`,
        centerSize: '8.5px',
      }));
      memBtn.title = `记忆系统 · 上下文 ${Math.round(contextRatio * 100)}%（${fmtTokens(used)} / ${fmtTokens(max)}）`;
    }

    /* =====================================================================
     * 杂项
     * ===================================================================== */
    function updateSub() {
      const count = detail?.session?.turn_count ?? turnCount ?? 0;
      const chars = (detail?.turns || []).reduce((s, t) => s + (t.kind === 'narrator' ? (t.content || '').length : 0), 0);
      navSub.textContent = count
        ? `${count} 回合 · ${chars > 10000 ? `${(chars / 10000).toFixed(1)} 万字` : `${chars} 字`}`
        : '新剧情';
      turnCount = count;
    }

    function scrollToBottom(smooth) {
      requestAnimationFrame(() => {
        scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      });
    }

    function goBack() {
      navigate('#/');
    }

    function onMemoryEvent() {
      openMemoryPanel(sessionId, { onUpdate: (s) => { memStats = s; paintRing(); } });
    }

    function onSessionsChanged() {
      // 侧栏自己处理；这里只刷新导航栏计数
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
        document.removeEventListener('chat:open-memory', onMemoryEvent);
        window.removeEventListener('sessions:changed', onSessionsChanged);
        document.title = '角色剧场';
      },
    };
  },
};

/* =========================================================================
 * 模块级辅助
 * ========================================================================= */

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images.map((im) => {
    if (typeof im === 'string') return im;
    return im?.url || im?.image_url?.url || im?.dataUrl || '';
  }).filter(Boolean);
}

/** 图片灯箱 */
export function openLightbox(src) {
  const box = el('div.lightbox', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': '图片预览',
    onclick: () => box.remove(),
  }, el('img', { src, alt: '' }));
  document.body.appendChild(box);
  const onKey = (e) => {
    if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', () => document.removeEventListener('keydown', onKey));
}
