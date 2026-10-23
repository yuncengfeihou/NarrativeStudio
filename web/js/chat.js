/**
 * chat.js — 聊天视图（核心）
 *
 * 功能：
 *  - 导航栏：返回 + 头像 + 标题 + 记忆按钮（环形进度显示上下文占用）+ ⋯ 更多菜单
 *  - 消息列表：narrator 角色气泡（头像+名+markdown）、player 蓝气泡、system 居中灰字
 *  - 回合分隔条：「第 N 回合 · HH:mm」（按 turn_no 分组，取该轮 created_at）
 *  - 消息操作：hover 显示 ⋯ 按钮 → actionSheet（复制内容）
 *  - narrator reasoning 折叠（💭 思考过程，默认收起，流式时展开）
 *  - SSE 流式：reasoning/narrative delta 实时渲染（带文字光标）、turn_start typing 指示器
 *  - 流式错误：消息列表内红字错误条，发送按钮复位
 *  - 分支选项：branches 事件后弹出卡片组 + 输入栏上方横向分支条；选中高亮+弹跳，作为下次行动
 *  - 未生成分支时，列表末尾提供轻量「继续演绎 ▸」入口
 *  - 输入栏：+ 按钮（图片 / 自定义行动 action sheet）、毛玻璃输入框、蓝色发送按钮（流式中变停止）
 *  - 图片输入：FileReader 转 base64，消息内显示缩略图
 *  - 空会话：展示开场白
 */

import {
  $, $$, el, clear, escapeHtml, hueFromString, avatarBackground, formatClock, copyToClipboard,
} from './util.js';
import { api } from './api.js';
import { navigate, openActionSheet, openSheet, toast, showLoading, hideLoading } from './app.js';
import { openSidebar, syncActive } from './sidebar.js';
import { buildContextRing, openMemoryPanel } from './memory-panel.js';

// 分支语气 → chip 配色
const TONE_CHIP = {
  激进: 'chip-red',
  谨慎: 'chip-blue',
  探索: 'chip-green',
  情感: 'chip-purple',
  智取: 'chip-orange',
};

// 输入框默认占位符（选中分支 / 自定义输入时会临时替换）
const DEFAULT_PLACEHOLDER = '说点什么，或选择一个行动…';

export default {
  id: 'chat',
  title: '聊天',

  async mount(root, params) {
    const sessionId = params.id;
    if (!sessionId) { navigate('#/library'); return { unmount() {} }; }

    // ---------- 运行时状态 ----------
    let detail = null;          // getSession 结果
    let settings = {};
    let sessionTitle = '剧情';
    let narratorHue = 210;
    let streaming = false;
    let abortController = null;
    let stream = null;          // 流式中的 narrator 消息引用
    let branchSet = null;       // 当前分支 {branches, scene_summary}
    let selectedBranch = null;  // 已选中的分支（作为下次行动）
    let pickedImages = [];      // 待发送图片 [{name, dataUrl}]
    let contextRatio = 0;

    // ---------- DOM 引用 ----------
    let msgList, branchSection, branchBar, branchBarInner, input, sendBtn, memRingSlot,
      chatNavName, chatNavSub, chatNavAvatar, pickedBox, scroll;

    // ---------- 骨架：导航栏 ----------
    const backBtn = el('button.main-nav-btn', {
      type: 'button', onclick: goBack, title: '返回',
    }, el('span', {}, '‹'), '返回');
    chatNavAvatar = el('div.chat-nav-avatar', {}, '?');
    chatNavName = el('div.chat-nav-name', {}, '加载中…');
    chatNavSub = el('div.chat-nav-sub', {}, '');
    memRingSlot = el('span', { style: 'display:inline-flex;' });
    const memBtn = el('button.nav-memory', {
      type: 'button',
      'aria-label': '记忆系统',
      title: '记忆系统',
      onclick: openMemory,
    }, memRingSlot);
    const moreBtn = el('button.main-nav-btn.icon-only', {
      type: 'button',
      'aria-label': '更多操作',
      title: '更多操作',
      onclick: openMoreMenu,
    }, '⋯');

    const navBar = el('header.main-nav', {},
      el('button.main-nav-btn.icon-only.nav-hamburger', {
        type: 'button', 'aria-label': '打开会话库', title: '会话库',
        onclick: () => openSidebar(),
      }, '☰'),
      el('div.chat-nav-title', {},
        backBtn,
        chatNavAvatar,
        el('div.chat-nav-text', {}, chatNavName, chatNavSub),
      ),
      memBtn,
      moreBtn,
    );

    // ---------- 内容区 ----------
    msgList = el('div.msg-list');
    branchSection = el('div.branch-section', { style: 'display:none;' });
    scroll = el('div.main-scroll.chat-scroll', {}, el('div.chat-inner', {}, msgList, branchSection));

    // ---------- 底部输入栏 ----------
    branchBarInner = el('div.branch-bar');
    branchBar = el('div.branch-bar-wrap', { style: 'display:none;' }, branchBarInner);

    input = el('textarea.chat-input', {
      rows: 1,
      placeholder: DEFAULT_PLACEHOLDER,
      enterkeyhint: 'send',
    });
    input.addEventListener('input', onInputChange);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    const plusBtn = el('button.plus-btn', { type: 'button', 'aria-label': '更多', onclick: openPlusMenu }, '+');
    sendBtn = el('button.btn-send', { type: 'button', 'aria-label': '发送', onclick: onSendClick }, sendIcon());

    pickedBox = el('div.picked-images', { style: 'display:none;' });

    const inputRow = el('div.chat-input-bar', {},
      plusBtn,
      el('div.chat-input-wrap', {}, input),
      sendBtn,
    );

    const bar = el('div.view-bar.chat-bar', {}, branchBar, pickedBox, inputRow);

    // 隐藏的文件选择器（图片输入）
    const fileInput = el('input', {
      type: 'file', accept: 'image/*', multiple: true, style: 'display:none;',
    });
    fileInput.addEventListener('change', onFilesPicked);

    const view = el('section.view', { 'data-view': 'chat' }, navBar, scroll, bar, fileInput);
    root.appendChild(view);

    // 「跳到最新」浮动按钮
    const jumpBtn = el('button.jump-latest', { type: 'button', onclick: () => scrollToBottom(true) },
      '最新 ↓');
    view.appendChild(jumpBtn);
    scroll.addEventListener('scroll', () => {
      jumpBtn.classList.toggle('is-visible', !isNearBottom());
    }, { passive: true });

    // ============================================================
    // 数据加载
    // ============================================================
    (async () => {
      showLoading();
      try {
        detail = await api.getSession(sessionId);
      } catch (err) {
        hideLoading();
        toast(err.message || '加载会话失败');
        navigate('#/library');
        return;
      }
      hideLoading();
      settings = detail.session?.settings || {};
      sessionTitle = settings.title || detail.session?.title || '剧情';
      narratorHue = hueFromString(sessionTitle);

      chatNavName.textContent = sessionTitle;
      chatNavAvatar.textContent = firstChar(sessionTitle);
      chatNavAvatar.style.background = avatarBackground(narratorHue);
      updateTurnSub();

      renderExistingTurns();
      updateContextRingFromStats(detail.memoryStats, settings);
      // 空会话 → 展示开场白
      if ((detail.turns || []).length === 0) renderOpening();
      scrollToBottom(false);
    })();

    // ============================================================
    // 渲染：既有回合
    // ============================================================
    function renderExistingTurns() {
      clear(msgList);
      const turns = Array.isArray(detail.turns) ? detail.turns.slice() : [];
      turns.sort((a, b) => (a.turn_no ?? 0) - (b.turn_no ?? 0));
      let lastTurnNo = 0;
      turns.forEach((t, i) => {
        // 回合分隔条：turn_no 变化即新的一轮（player 与 narrator 共享同一 turn_no）
        const turnNo = t.turn_no || lastTurnNo + 1;
        if (turnNo !== lastTurnNo) {
          msgList.appendChild(buildTurnDivider(turnNo, t.created_at));
          lastTurnNo = turnNo;
        }
        if (t.kind === 'player') renderPlayerMessage(t.content, t.images, { stagger: i * 20 });
        else if (t.kind === 'narrator') renderNarratorMessage(t.content, t.reasoning, { stagger: i * 20, final: true });
        else if (t.kind === 'system') renderSystemMessage(t.content);
      });
    }

    /** 空会话开场白 */
    function renderOpening() {
      const opening = (settings.opening || '').trim();
      if (opening) {
        renderNarratorMessage(opening, '', { label: '开场白', final: true });
      } else {
        msgList.appendChild(el('div', {
          style: 'text-align:center;color:var(--label-tertiary);font-size:14px;padding:48px 24px;line-height:1.6;',
        }, '这段剧情还没有开场白。', el('br'), '在下方输入你的第一个行动，故事由此开始。'));
      }
    }

    // ============================================================
    // 消息构建
    // ============================================================
    function narratorAvatar() {
      return el('div.msg-avatar', { style: `background:${avatarBackground(narratorHue)};` }, firstChar(sessionTitle));
    }

    /** 回合分隔条：「第 N 回合 · HH:mm」（ts 为毫秒时间戳，可缺省） */
    function buildTurnDivider(turnNo, ts) {
      const clock = ts ? formatClock(ts) : '';
      return el('div.turn-divider', {},
        el('span.turn-divider-line'),
        el('span.turn-divider-text', {}, `第 ${turnNo} 回合${clock ? ` · ${clock}` : ''}`),
        el('span.turn-divider-line'),
      );
    }

    /** 消息操作按钮（⋯，hover 显示；getPlain 为取纯文本的函数，支持流式消息动态更新） */
    function msgActionButton(getPlain) {
      return el('button.msg-action-btn', {
        type: 'button',
        'aria-label': '消息操作',
        title: '消息操作',
        onclick: (e) => {
          e.stopPropagation();
          openMsgActions(getPlain);
        },
      }, '⋯');
    }

    /** 消息操作 actionSheet（当前：复制内容） */
    async function openMsgActions(getPlain) {
      const action = await openActionSheet({
        title: '消息操作',
        actions: [
          { label: '📋  复制内容', value: 'copy' },
        ],
      });
      if (action !== 'copy') return;
      const text = String(getPlain() ?? '').trim();
      if (!text) { toast('没有可复制的内容'); return; }
      const ok = await copyToClipboard(text);
      toast(ok ? '已复制' : '复制失败');
    }

    /** 流式错误条（红字卡片，留在消息列表中） */
    function renderErrorBar(message) {
      msgList.appendChild(el('div.msg-error', { role: 'alert' },
        el('span.msg-error-icon', {}, '⚠'),
        el('span.msg-error-text', {}, message || '生成出错'),
      ));
      scrollToBottom(true);
    }

    function renderNarratorMessage(content, reasoning, opts = {}) {
      const { label = '旁白', stagger = 0, final = false } = opts;
      const msg = el('div.msg.msg-narrator', { style: `--stagger:${stagger}ms;` },
        narratorAvatar(),
        el('div.msg-main', {},
          el('div.msg-name', {}, label),
        ),
      );
      const main = msg.querySelector('.msg-main');
      let reasoningBox = null;
      if (reasoning && reasoning.trim()) {
        reasoningBox = buildReasoningBox(reasoning, false);
        main.appendChild(reasoningBox);
      }
      const bubble = el('div.bubble.bubble-narrator');
      bubble.innerHTML = formatNarrative(content);
      main.appendChild(bubble);
      msg.appendChild(msgActionButton(() => content));
      msgList.appendChild(msg);
      return { msg, bubble, reasoningBox };
    }

    function renderPlayerMessage(content, images, opts = {}) {
      const { stagger = 0 } = opts;
      const msg = el('div.msg.msg-player', { style: `--stagger:${stagger}ms;` });
      const bubble = el('div.bubble.bubble-player');
      const imgs = normalizeImages(images);
      if (imgs.length) {
        bubble.appendChild(el('div.msg-images', {},
          imgs.map((src) => el('img', { src, alt: '图片', loading: 'lazy' })),
        ));
      }
      if (content && content.trim()) bubble.appendChild(el('div', {}, content));
      else if (!imgs.length) bubble.appendChild(el('div', {}, '（空行动）'));
      msg.appendChild(bubble);
      msg.appendChild(msgActionButton(() => content));
      msgList.appendChild(msg);
      return msg;
    }

    function renderSystemMessage(content) {
      msgList.appendChild(el('div.msg.msg-system', {}, el('div.system-line', {}, content)));
    }

    /** reasoning 折叠盒 */
    function buildReasoningBox(reasoningText, streaming) {
      const content = el('div.reasoning-content');
      content.textContent = reasoningText || '';
      const box = el('div.reasoning-box', { class: streaming ? 'is-streaming is-open' : '' },
        el('button.reasoning-toggle', { type: 'button' },
          '💭 思考过程',
          el('span.disclosure-arrow', {}, '›'),
        ),
        content,
      );
      box.querySelector('.reasoning-toggle').addEventListener('click', () => box.classList.toggle('is-open'));
      if (streaming) content.scrollTop = content.scrollHeight;
      return box;
    }

    // ============================================================
    // 流式回合
    // ============================================================
    async function sendAction({ playerText = '', images = [], branchChoice = null, silent = false, generateBranches = true } = {}) {
      if (streaming) return;
      streaming = true;
      abortController = new AbortController();
      updateSendButton();
      clearBranches();
      hideContinueButton();

      // 玩家消息上屏（silent：如「继续生成」不传玩家行动，仅 narrator 接续演绎）
      if (!silent && (playerText || (images && images.length) || branchChoice)) {
        const displayText = branchChoice && !playerText
          ? `【${branchChoice.title || '行动'}】`
          : playerText;
        renderPlayerMessage(displayText, images);
      }
      scrollToBottom(true);

      // typing 指示器
      const typing = el('div.msg.msg-narrator', {},
        narratorAvatar(),
        el('div.msg-main', {},
          el('div.msg-name', {}, '旁白'),
          el('div.typing-bubble', {}, el('span.typing', {},
            el('span.dot'), el('span.dot'), el('span.dot'),
          )),
        ),
      );
      msgList.appendChild(typing);
      scrollToBottom(true);

      stream = { el: null, bubble: null, reasoningBox: null, reasoningContent: null, reasoning: '', narrative: '', streaming: true };

      const body = {
        playerText: playerText || (branchChoice ? branchChoice.description || branchChoice.title : ''),
        images: images && images.length ? images : undefined,
        branchChoice: branchChoice || undefined,
        generateBranches,
      };

      try {
        await api.runTurn(sessionId, body, {
          signal: abortController.signal,
          onEvent: handleTurnEvent(typing),
        });
        // 兜底：流结束但始终未收到 done 事件时，手动定稿（正常路径下 done 已定稿，重复无害）
        finalizeStream();
        // 回合结束：本轮未生成分支时，提供轻量「继续演绎」入口
        if (!branchSet && !generateBranches) showContinueButton();
      } catch (err) {
        // 出错/中止时移除可能残留的 typing 指示器
        if (typing.parentNode) typing.remove();
        // 定稿已收到的部分内容（去光标、收起 reasoning）——异常终止时同样需要
        finalizeStream();
        if (err && err.name === 'AbortError') {
          toast('已停止生成');
        } else {
          toast(err.message || '回合生成失败');
          renderErrorBar(err.message || '生成出错');
        }
      } finally {
        streaming = false;
        abortController = null;
        updateSendButton();
        updateTurnSub();
      }
    }

    /** turn 事件处理（闭包捕获 typing 节点） */
    function handleTurnEvent(typing) {
      let typingRemoved = false;
      const removeTyping = () => {
        if (!typingRemoved) { typing.remove(); typingRemoved = true; }
      };
      const ensureStream = () => {
        if (stream.el) return;
        removeTyping();
        const msg = el('div.msg.msg-narrator', {},
          narratorAvatar(),
          el('div.msg-main', {}, el('div.msg-name', {}, '旁白')),
        );
        const main = msg.querySelector('.msg-main');
        const bubble = el('div.bubble.bubble-narrator');
        main.appendChild(bubble);
        // 操作按钮：纯文本随流式增量动态更新
        msg.appendChild(msgActionButton(() => stream.narrative));
        msgList.appendChild(msg);
        stream.el = msg;
        stream.bubble = bubble;
      };

      return (evt) => {
        switch (evt.type) {
          case 'turn_start': {
            updateTurnSub(evt.turn_no);
            // 当前轮分隔条插到 typing 指示器之前
            const divider = buildTurnDivider(evt.turn_no || 1, Date.now());
            if (typing.parentNode) msgList.insertBefore(divider, typing);
            else msgList.appendChild(divider);
            break;
          }
          case 'reasoning': {
            ensureStream();
            stream.reasoning += evt.delta || '';
            if (!stream.reasoningBox) {
              stream.reasoningBox = buildReasoningBox(stream.reasoning, true);
              stream.reasoningContent = stream.reasoningBox.querySelector('.reasoning-content');
              // reasoning 盒插入到气泡之前
              stream.el.querySelector('.msg-main').insertBefore(stream.reasoningBox, stream.bubble);
            } else {
              stream.reasoningContent.textContent = stream.reasoning;
              stream.reasoningContent.scrollTop = stream.reasoningContent.scrollHeight;
            }
            if (isNearBottom()) scrollToBottom(true);
            break;
          }
          case 'narrative': {
            ensureStream();
            stream.narrative += evt.delta || '';
            scheduleStreamRender();
            break;
          }
          case 'narrative_done':
            if (evt.content) stream.narrative = evt.content;
            break;
          case 'branches':
            if (evt.branches && evt.branches.length) {
              renderBranches({ branches: evt.branches, scene_summary: evt.scene_summary });
            }
            break;
          case 'memory':
            updateContextRingFromStats(evt.stats, settings);
            break;
          case 'state':
            // 状态更新：供记忆面板使用（此处无需即时渲染）
            break;
          case 'done':
            finalizeStream();
            window.dispatchEvent(new CustomEvent('sessions:changed'));
            // 仅当 done 携带上下文信息时才更新圆环，避免覆盖 memory 事件的值
            if (evt.usage) {
              const derived = deriveStats(evt.usage);
              if (derived) updateContextRingFromStats(derived, settings);
            }
            break;
          case 'error':
            throw new Error(evt.message || '生成失败');
          default:
            break;
        }
      };
    }

    /** 流式渲染调度（rAF 合并） */
    let rafPending = false;
    function scheduleStreamRender() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (!stream || !stream.bubble) return;
        stream.bubble.innerHTML = formatNarrative(stream.narrative) + '<span class="stream-cursor"></span>';
        if (isNearBottom()) scrollToBottom(true);
      });
    }

    /** 结束流式：定稿 markdown、去掉光标、收起 reasoning */
    function finalizeStream() {
      if (!stream) return;
      if (stream.bubble) {
        stream.bubble.innerHTML = formatNarrative(stream.narrative);
      }
      if (stream.reasoningBox) {
        stream.reasoningBox.classList.remove('is-streaming', 'is-open');
      }
      stream.streaming = false;
      if (isNearBottom()) scrollToBottom(true);
    }

    // ============================================================
    // 分支选项
    // ============================================================
    function renderBranches(set) {
      branchSet = set;
      selectedBranch = null;

      // 消息列表下方的卡片组
      clear(branchSection);
      branchSection.style.display = '';
      if (set.scene_summary) {
        branchSection.appendChild(el('div.branch-scene', {}, set.scene_summary));
      }
      const cards = el('div.branch-cards');
      set.branches.forEach((b, i) => {
        const card = el('button.branch-card', {
          type: 'button',
          'data-index': String(i),
          style: `--stagger:${i * 30}ms;`,
        },
          el('div.branch-card-head', {},
            el('span.chip.branch-tone', { class: TONE_CHIP[b.tone] || 'chip-blue' }, b.tone || '行动'),
            el('span.branch-card-title', {}, b.title || '行动'),
            b.tension_delta != null
              ? el('span.branch-tension', {}, `Δ${b.tension_delta > 0 ? '+' : ''}${b.tension_delta}`)
              : null,
          ),
          b.description ? el('div.branch-card-desc', {}, b.description) : null,
          el('span.branch-check', {}, '✓'),
        );
        card._branch = b;
        card.addEventListener('click', () => selectBranch(b));
        cards.appendChild(card);
      });
      branchSection.appendChild(cards);

      // 输入栏上方的横向分支条
      clear(branchBarInner);
      set.branches.forEach((b, i) => {
        const pill = el('button.branch-pill', {
          type: 'button',
          'data-index': String(i),
        },
          el('span.branch-pill-tone', {}, toneEmoji(b.tone)),
          b.title || '行动',
        );
        pill._branch = b;
        pill.addEventListener('click', () => selectBranch(b));
        branchBarInner.appendChild(pill);
      });
      // 自定义行动入口
      const customPill = el('button.branch-pill', { type: 'button', onclick: openCustomAction },
        el('span.branch-pill-tone', {}, '✏️'), '自定义行动',
      );
      branchBarInner.appendChild(customPill);
      branchBar.style.display = '';

      scrollToBottom(true);
    }

    function clearBranches() {
      branchSet = null;
      selectedBranch = null;
      branchSection.style.display = 'none';
      clear(branchSection);
      branchBar.style.display = 'none';
      clear(branchBarInner);
      // 恢复输入框占位符（可能被「将执行：…」替换过）
      input.placeholder = DEFAULT_PLACEHOLDER;
    }

    function selectBranch(b) {
      selectedBranch = b;
      // 卡片高亮 + 弹跳（用元素上挂载的分支引用匹配，兼容无 id 的选项）
      $$('.branch-card', branchSection).forEach((c) => {
        c.classList.toggle('is-selected', c._branch === b);
      });
      $$('.branch-pill', branchBarInner).forEach((p) => {
        p.classList.toggle('is-selected', p._branch === b);
      });
      // 输入框占位符提示
      input.placeholder = `将执行：${b.title || '行动'}（点 ↑ 确认）`;
      toast(`已选择：${b.title || '行动'}`);
    }

    // ============================================================
    // 「继续演绎」入口（本轮未生成分支时显示在列表末尾）
    // ============================================================
    function showContinueButton() {
      hideContinueButton();
      const btn = el('button.continue-btn', {
        type: 'button',
        onclick: () => { hideContinueButton(); continueGeneration(); },
      }, '继续演绎', el('span.continue-arrow', {}, '▸'));
      msgList.appendChild(btn);
      scrollToBottom(true);
    }

    function hideContinueButton() {
      $$('.continue-btn', msgList).forEach((n) => n.remove());
    }

    /** 继续生成：不传玩家行动，让 narrator 接着上文演绎（不生成分支） */
    function continueGeneration() {
      if (streaming) { toast('正在生成中…'); return; }
      sendAction({ playerText: '（请继续）', silent: true, generateBranches: false });
    }

    // ============================================================
    // 顶部 ⋯ 更多菜单
    // ============================================================
    async function openMoreMenu() {
      const action = await openActionSheet({
        title: '剧情操作',
        actions: [
          { label: '▶️  继续生成', value: 'continue' },
          { label: '🍂  重新生成分支', value: 'branches' },
          { label: '📤  导出剧情', value: 'export' },
          { label: '🧠  记忆系统', value: 'memory' },
        ],
      });
      if (action === 'continue') continueGeneration();
      else if (action === 'branches') regenerateBranches();
      else if (action === 'export') exportSession();
      else if (action === 'memory') openMemory();
    }

    /** 重新生成分支选项（非流式） */
    async function regenerateBranches() {
      if (streaming) { toast('正在生成中…'); return; }
      showLoading();
      try {
        const set = await api.generateBranches(sessionId);
        if (set && set.branches && set.branches.length) {
          renderBranches(set);
          toast('已生成新分支');
        } else {
          toast('未生成分支选项');
        }
      } catch (err) {
        toast(`分支生成失败：${err.message}`);
      } finally {
        hideLoading();
      }
    }

    /** 导出剧情为 Markdown（逻辑同 library.js 的导出） */
    async function exportSession() {
      try {
        const data = await api.getSession(sessionId);
        const title = data.session?.title || '剧情';
        const lines = [`# ${title}`, ''];
        const tags = data.session?.settings?.style_tags || [];
        if (tags.length) lines.push(`> 风格：${tags.join('、')}`, '');
        for (const t of data.turns || []) {
          if (t.kind === 'narrator') lines.push(t.content, '');
          else if (t.kind === 'player') lines.push(`**（玩家）** ${t.content}`, '');
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `${title}.md` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast('已导出 Markdown');
      } catch (err) {
        toast(`导出失败：${err.message}`);
      }
    }

    // ============================================================
    // 输入与发送
    // ============================================================
    function onInputChange() {
      // 自动增高（max 120px，与 CSS max-height 一致）
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      // 玩家开始自定义输入时清除分支选择
      if (input.value.trim() && selectedBranch) {
        selectedBranch = null;
        $$('.branch-card, .branch-pill', view).forEach((n) => n.classList.remove('is-selected'));
        input.placeholder = DEFAULT_PLACEHOLDER;
      }
    }

    function onSendClick() {
      if (streaming) { // 流式中 → 停止
        if (abortController) abortController.abort();
        return;
      }
      handleSend();
    }

    function handleSend() {
      const text = input.value.trim();
      const images = pickedImages.map((p) => p.dataUrl);

      if (selectedBranch && !text) {
        const b = selectedBranch;
        const imgs = pickedImages.map((p) => p.dataUrl);
        input.value = '';
        resetInputHeight();
        clearPickedImages();
        sendAction({ branchChoice: b, images: imgs });
        return;
      }
      if (!text && images.length === 0) {
        toast('输入行动或选择分支');
        return;
      }
      input.value = '';
      resetInputHeight();
      clearPickedImages();
      sendAction({ playerText: text, images });
    }

    // ---------- + 菜单 ----------
    async function openPlusMenu() {
      const action = await openActionSheet({
        title: '添加',
        actions: [
          { label: '📷  图片', value: 'image' },
          { label: '✏️  自定义行动', value: 'custom' },
        ],
      });
      if (action === 'image') fileInput.click();
      else if (action === 'custom') openCustomAction();
    }

    // ---------- 自定义行动 sheet ----------
    function openCustomAction() {
      const ta = el('textarea.action-textarea', { placeholder: '描述你要采取的行动…' });
      openSheet({
        title: '自定义行动',
        confirmText: '发送',
        cancelText: '取消',
        render(body) {
          body.appendChild(el('div.sheet-pad', {},
            ta,
            el('div', { style: 'font-size:12px;color:var(--label-tertiary);margin-top:8px;' },
              '纯文本行动，将作为你的回合发送给叙事者。'),
          ));
          setTimeout(() => ta.focus(), 200);
        },
        async onConfirm() {
          const v = ta.value.trim();
          if (!v) { toast('行动不能为空'); return false; }
          sendAction({ playerText: v });
        },
      });
    }

    // ---------- 图片选择 ----------
    function onFilesPicked(e) {
      const files = Array.from(e.target.files || []);
      files.forEach((file) => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
          pickedImages.push({ name: file.name, dataUrl: reader.result });
          renderPickedImages();
        };
        reader.readAsDataURL(file);
      });
      e.target.value = ''; // 允许重复选同一文件
    }

    function renderPickedImages() {
      clear(pickedBox);
      if (pickedImages.length === 0) { pickedBox.style.display = 'none'; return; }
      pickedBox.style.display = 'flex';
      pickedImages.forEach((p, i) => {
        pickedBox.appendChild(el('div.picked-image', {},
          el('img', { src: p.dataUrl, alt: p.name }),
          el('button.picked-image-remove', {
            type: 'button', 'aria-label': '移除图片',
            onclick: () => { pickedImages.splice(i, 1); renderPickedImages(); },
          }, '✕'),
        ));
      });
    }

    function clearPickedImages() {
      pickedImages = [];
      renderPickedImages();
    }

    // ============================================================
    // 记忆面板
    // ============================================================
    async function openMemory() {
      openMemoryPanel(sessionId);
    }

    // ============================================================
    // 上下文占用环
    // ============================================================
    function updateContextRingFromStats(stats, cfg) {
      const max = firstNum(stats?.context_max, cfg?.context_max_tokens, 200000);
      const tokens = firstNum(stats?.context_tokens);
      contextRatio = max > 0 ? Math.min(1, tokens / max) : 0;
      renderMemoryRing(contextRatio);
    }

    function renderMemoryRing(ratio) {
      clear(memRingSlot);
      memRingSlot.appendChild(buildContextRing(ratio, {
        size: 26,
        stroke: 6,
        centerPct: `${Math.round(ratio * 100)}%`,
        centerClass: 'ring-label',
        pctSize: '9px',
      }));
    }

    /** 由 usage 推导一个近似的 stats（done 事件可能只带 usage） */
    function deriveStats(usage) {
      // usage 通常是 LLM token 用量，无法直接得到上下文占用；返回空让回退逻辑处理
      return usage && (usage.context_tokens != null || usage.context_max != null) ? usage : null;
    }

    // ============================================================
    // 杂项
    // ============================================================
    function updateSendButton() {
      clear(sendBtn);
      if (streaming) {
        sendBtn.appendChild(el('span', { style: 'font-size:15px;font-weight:700;' }, '■'));
        sendBtn.setAttribute('aria-label', '停止');
        sendBtn.title = '停止生成';
      } else {
        sendBtn.appendChild(sendIcon());
        sendBtn.setAttribute('aria-label', '发送');
        sendBtn.title = '发送';
      }
    }

    function updateTurnSub(turnNo) {
      const count = turnNo != null ? turnNo : (detail?.session?.turn_count ?? (detail?.turns?.length || 0));
      chatNavSub.textContent = count ? `${count} 回合` : '新剧情';
    }

    function goBack() {
      if (history.length > 1) history.back();
      else navigate('#/library');
    }

    function isNearBottom() {
      return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
    }
    function scrollToBottom(smooth) {
      requestAnimationFrame(() => {
        scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      });
    }
    function resetInputHeight() { input.style.height = 'auto'; }

    return {
      unmount() {
        if (abortController) abortController.abort();
      },
    };
  },
};

// ============================================================
// 纯函数辅助（模块级）
// ============================================================

function sendIcon() {
  // 向上箭头 ↑
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 4l-8 9h5v7h6v-7h5z');
  svg.appendChild(path);
  return svg;
}

function firstChar(str) {
  const s = String(str || '').trim();
  return s ? [...s][0] : '?';
}

function toneEmoji(tone) {
  return ({ 激进: '⚔️', 谨慎: '🛡️', 探索: '🧭', 情感: '💗', 智取: '🧠' })[tone] || '▶';
}

/** 规整 images 为 dataURL 数组（兼容字符串 / {url} / {image_url}） */
function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images.map((im) => {
    if (typeof im === 'string') return im;
    return im?.url || im?.image_url?.url || im?.dataUrl || '';
  }).filter(Boolean);
}

function firstNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * 简易 markdown → HTML（已转义，安全）。
 * 支持：分段、**粗体**、*斜体*、「对话」引号样式化。
 */
export function formatNarrative(text) {
  const raw = String(text ?? '');
  // 分段：连续空行分段，单换行保留为 <br>
  const paragraphs = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.map((p) => {
    let html = escapeHtml(p).replace(/\n/g, '<br>');
    // 粗体
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-bold">$1</strong>');
    // 斜体（在粗体之后，避免冲突）
    html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em class="md-italic">$2</em>');
    // 「对话」引号样式化
    html = html.replace(/「([^」]*)」/g, '<span class="md-quote">「$1」</span>');
    return `<p class="md-p">${html}</p>`;
  }).join('');
}
