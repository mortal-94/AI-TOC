// ==UserScript==
// @name         AI 聊天回答大纲（ChatGPT / 豆包）
// @namespace    https://local.codex/ai-chat-outline
// @version      1.0.5
// @description  为当前可见的 AI 回答生成侧边大纲；切换聊天时显示最后一个回答，滚动时自动切换。
// @author       Codex
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://www.doubao.com/chat*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const APP_ID = 'ai-chat-outline-v1';
  const HOST_ID = `${APP_ID}-host`;
  const ANCHOR_ATTR = 'data-ai-chat-outline-anchor';
  const MAX_ITEMS = 80;
  const ROUTE_SETTLE_MS = 700;
  const STORAGE_KEY = `${APP_ID}:collapsed`;

  if (window.__AI_CHAT_OUTLINE__?.destroy) {
    window.__AI_CHAT_OUTLINE__.destroy();
  }

  const state = {
    adapters: [],
    adapter: null,
    answers: [],
    currentAnswer: null,
    items: [],
    activeItem: null,
    routeKey: routeKey(),
    preferLastAnswer: true,
    preferLastUntil: 0,
    collapsed: localStorage.getItem(STORAGE_KEY) === '1',
    destroyed: false,
    scanTimer: 0,
    routeTimer: 0,
    scrollFrame: 0,
    contentTextSignature: '',
    contentSignature: '',
    observer: null,
    host: null,
    shadow: null,
    ui: null,
    restoreHistory: null,
  };

  const EXCLUDED_OUTLINE_SELECTOR = [
    'pre', 'code', 'table', 'svg', 'button', 'textarea', 'input',
    '[contenteditable="true"]', '[aria-hidden="true"]',
    '[class*="suggest-message"]', '[class*="message-action"]',
    '[class*="toolbar"]', '[class*="operation"]',
  ].join(',');

  const ANSWER_MARKER_SELECTOR = [
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[data-author="assistant"]',
    '[data-message-role="assistant"]',
    '[class*="assistant-message"]',
    '[class*="message-assistant"]',
    '[class*="bot-message"]',
    '.list_items',
    '.v_list_row',
  ].join(',');

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
  }

  function shorten(text, length = 62) {
    const value = cleanText(text);
    if (value.length <= length) return value;
    return `${value.slice(0, Math.max(1, length - 1)).trimEnd()}…`;
  }

  function routeKey() {
    return `${location.origin}${location.pathname}${location.search}`;
  }

  function uniqueElements(elements) {
    return [...new Set(elements)].filter((element) => element instanceof Element);
  }

  function elementTextLength(element) {
    return String(element?.textContent || '').trim().length;
  }

  function largestMatchingDescendant(root, selectors) {
    if (!(root instanceof Element)) return null;
    const matches = selectors.flatMap((selector) => [...root.querySelectorAll(selector)]);
    if (root.matches(selectors.join(','))) matches.push(root);
    return uniqueElements(matches)
      .filter((element) => !element.matches('[class*="suggest-message"], [class*="message-action"]'))
      .sort((a, b) => elementTextLength(b) - elementTextLength(a))[0] || root;
  }

  function explicitRole(element) {
    if (!(element instanceof Element)) return '';
    const values = [
      element.getAttribute('data-message-author-role'),
      element.getAttribute('data-role'),
      element.getAttribute('data-author'),
      element.getAttribute('data-message-role'),
      element.getAttribute('aria-label'),
      typeof element.className === 'string' ? element.className : '',
    ].filter(Boolean).join(' ').toLowerCase();

    if (/(assistant|\bbot\b|ai-message|receive-message|机器人|豆包回复)/i.test(values)) return 'assistant';
    if (/(^|[\s_-])(user|human|sender|question)([\s_-]|$)|用户|我的消息/i.test(values)) return 'user';
    return '';
  }

  function chatGptAdapter() {
    return {
      id: 'chatgpt',
      label: 'ChatGPT',
      matches: () => /(^|\.)chatgpt\.com$|^chat\.openai\.com$/i.test(location.hostname),
      collectAnswers(root) {
        const roles = [...root.querySelectorAll('[data-message-author-role="assistant"]')];
        return uniqueElements(roles.map((role) =>
          role.closest('article, [data-testid^="conversation-turn-"]') || role
        )).filter((answer) => elementTextLength(answer) > 0);
      },
      getContent(answer) {
        const role = answer.matches('[data-message-author-role="assistant"]')
          ? answer
          : answer.querySelector('[data-message-author-role="assistant"]');
        const root = role || answer;
        return root.querySelector('.markdown, [class*="markdown"], [class*="prose"]') || root;
      },
    };
  }

  function doubaoAdapter() {
    return {
      id: 'doubao',
      label: '豆包',
      matches: () => /(^|\.)doubao\.com$/i.test(location.hostname),
      collectAnswers(root) {
        const rows = [...root.querySelectorAll('.list_items > .v_list_row')]
          .filter((row) => elementTextLength(row) > 2);

        if (rows.length) {
          const explicitAssistants = rows.filter((row) => explicitRole(row) === 'assistant');
          if (explicitAssistants.length) return uniqueElements(explicitAssistants);

          // 豆包虚拟列表的有效行顺序为 user, assistant, user, assistant ...。
          // 两端的占位行没有有效文本，已在上方滤除。
          return rows.filter((row, index) => index % 2 === 1);
        }

        return collectSemanticAssistantAnswers(root);
      },
      getContent(answer) {
        return largestMatchingDescendant(answer, [
          '[class*="flow-markdown"]',
          '[class*="markdown"]',
          '[class*="message-content"]',
          '[class*="content"]',
        ]);
      },
    };
  }

  function collectSemanticAssistantAnswers(root) {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '[data-author="assistant"]',
      '[data-message-role="assistant"]',
      '[class*="assistant-message"]',
      '[class*="message-assistant"]',
      '[class*="bot-message"]',
    ];
    return uniqueElements(selectors.flatMap((selector) => [...root.querySelectorAll(selector)]))
      .map((element) => element.closest('article, [data-testid*="message"], [class*="message-row"]') || element)
      .filter((element) => elementTextLength(element) > 0);
  }

  function genericAdapter() {
    return {
      id: 'generic',
      label: 'AI Chat',
      matches: () => true,
      collectAnswers: collectSemanticAssistantAnswers,
      getContent(answer) {
        return largestMatchingDescendant(answer, [
          '.markdown', '[class*="markdown"]', '[class*="prose"]',
          '[class*="message-content"]', '[class*="content"]',
        ]);
      },
    };
  }

  state.adapters.push(chatGptAdapter(), doubaoAdapter(), genericAdapter());

  function selectAdapter() {
    state.adapter = state.adapters.find((adapter) => {
      try { return adapter.matches(location, document); } catch { return false; }
    }) || state.adapters[state.adapters.length - 1];
  }

  function registerAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object') throw new TypeError('adapter 必须是对象');
    for (const method of ['matches', 'collectAnswers', 'getContent']) {
      if (typeof adapter[method] !== 'function') throw new TypeError(`adapter.${method} 必须是函数`);
    }
    const normalized = {
      id: String(adapter.id || `custom-${Date.now()}`),
      label: String(adapter.label || adapter.id || '自定义站点'),
      matches: adapter.matches,
      collectAnswers: adapter.collectAnswers,
      getContent: adapter.getContent,
    };
    state.adapters.unshift(normalized);
    selectAdapter();
    state.preferLastAnswer = true;
    scheduleScan(0);
    return () => {
      state.adapters = state.adapters.filter((item) => item !== normalized);
      selectAdapter();
      scheduleScan(0);
    };
  }

  function createPanel() {
    const oldHost = document.getElementById(HOST_ID);
    if (oldHost) oldHost.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-ai-chat-outline-ui', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel {
          --bg: rgba(255, 255, 255, .94);
          --surface: #f6f7f9;
          --text: #202123;
          --muted: #74777d;
          --line: rgba(0, 0, 0, .10);
          --accent: #10a37f;
          position: fixed;
          z-index: 2147483000;
          top: 76px;
          right: 18px;
          width: 300px;
          max-height: calc(100vh - 112px);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: var(--text);
          background: var(--bg);
          border: 1px solid var(--line);
          border-radius: 14px;
          box-shadow: 0 12px 38px rgba(0, 0, 0, .16);
          backdrop-filter: blur(14px);
          font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          transition: width .18s ease, max-height .18s ease;
        }
        @media (prefers-color-scheme: dark) {
          .panel {
            --bg: rgba(35, 36, 40, .94);
            --surface: #2c2d31;
            --text: #ececf1;
            --muted: #a6a8ad;
            --line: rgba(255, 255, 255, .12);
            --accent: #32c49b;
          }
        }
        .panel.collapsed { width: 46px; max-height: 46px; }
        .panel.collapsed .title,
        .panel.collapsed .counter,
        .panel.collapsed .body,
        .panel.collapsed .footer { display: none; }
        .header { min-height: 45px; display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--line); }
        .panel.collapsed .header { padding: 5px; border-bottom: 0; }
        .logo { width: 22px; height: 22px; display: grid; place-items: center; flex: 0 0 auto; color: var(--accent); }
        .logo svg { width: 20px; height: 20px; }
        .title { min-width: 0; flex: 1; font-weight: 650; font-size: 14px; white-space: nowrap; }
        .counter { flex: 0 0 auto; color: var(--muted); font-size: 11px; padding: 2px 6px; border-radius: 999px; background: var(--surface); }
        .icon-button { width: 30px; height: 30px; display: grid; place-items: center; flex: 0 0 auto; color: var(--muted); background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
        .icon-button:hover { color: var(--text); background: var(--surface); }
        .icon-button svg { width: 17px; height: 17px; transition: transform .18s ease; }
        .panel.collapsed .icon-button { width: 34px; height: 34px; }
        .panel.collapsed .icon-button svg { transform: rotate(180deg); }
        .body { min-height: 56px; overflow: auto; padding: 8px; scrollbar-width: thin; }
        .empty { padding: 16px 10px; color: var(--muted); text-align: center; line-height: 1.65; }
        .outline { display: flex; flex-direction: column; gap: 2px; }
        .item { position: relative; width: 100%; min-height: 30px; padding: 6px 8px 6px calc(9px + var(--indent, 0px)); color: var(--muted); background: transparent; border: 0; border-radius: 8px; text-align: left; font: inherit; line-height: 1.4; cursor: pointer; overflow-wrap: anywhere; }
        .item::before { content: ""; position: absolute; left: calc(3px + var(--indent, 0px)); top: 9px; bottom: 9px; width: 2px; border-radius: 2px; background: transparent; }
        .item:hover { color: var(--text); background: var(--surface); }
        .item.active { color: var(--text); background: color-mix(in srgb, var(--accent) 11%, transparent); }
        .item.active::before { background: var(--accent); }
        .item[data-level="1"], .item[data-level="2"] { font-weight: 650; color: var(--text); }
        .footer { padding: 7px 12px 9px; color: var(--muted); border-top: 1px solid var(--line); font-size: 11px; display: flex; justify-content: space-between; gap: 8px; }
        @media (max-width: 900px) {
          .panel:not(.collapsed) { top: 62px; right: 8px; width: min(290px, calc(100vw - 16px)); max-height: calc(100vh - 82px); }
        }
        @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
      </style>
      <aside class="panel" aria-label="AI 回答大纲">
        <div class="header">
          <span class="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5h14M5 12h10M5 19h7"/><circle cx="3" cy="5" r=".8" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r=".8" fill="currentColor" stroke="none"/><circle cx="3" cy="19" r=".8" fill="currentColor" stroke="none"/></svg>
          </span>
          <span class="title">回答大纲</span>
          <span class="counter">等待回答</span>
          <button class="icon-button collapse" type="button" title="折叠大纲" aria-label="折叠大纲">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
        </div>
        <div class="body"><div class="empty">正在识别当前聊天的回答…</div></div>
        <div class="footer"><span class="site">AI Chat</span><span>滚动自动切换</span></div>
      </aside>
    `;
    document.documentElement.appendChild(host);

    state.host = host;
    state.shadow = shadow;
    state.ui = {
      panel: shadow.querySelector('.panel'),
      counter: shadow.querySelector('.counter'),
      body: shadow.querySelector('.body'),
      site: shadow.querySelector('.site'),
      collapse: shadow.querySelector('.collapse'),
    };
    applyCollapsedState();
    state.ui.collapse.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      localStorage.setItem(STORAGE_KEY, state.collapsed ? '1' : '0');
      applyCollapsedState();
    });
  }

  function applyCollapsedState() {
    if (!state.ui) return;
    state.ui.panel.classList.toggle('collapsed', state.collapsed);
    const action = state.collapsed ? '展开大纲' : '折叠大纲';
    state.ui.collapse.title = action;
    state.ui.collapse.setAttribute('aria-label', action);
  }

  function isExcludedNode(element, contentRoot) {
    const excluded = element.closest(EXCLUDED_OUTLINE_SELECTOR);
    return Boolean(excluded && contentRoot.contains(excluded));
  }

  function isStandaloneStrongTitle(element) {
    if (!element.matches('p, div')) return false;
    const text = cleanText(element.textContent);
    if (!text || text.length > 56) return false;
    // 独立加粗正文很常见，只有短小且不像完整句子的内容才视作标题。
    if (/[。！？；.!?;]$/.test(text)) return false;
    const children = [...element.children].filter((child) => child.tagName !== 'BR');
    if (children.length !== 1 || !children[0].matches('strong, b')) return false;
    return cleanText(children[0].textContent) === text;
  }

  function nodeLevel(element, fallback = 3) {
    const heading = /^H([1-6])$/.exec(element.tagName);
    if (heading) return Number(heading[1]);
    const ariaLevel = Number(element.getAttribute('aria-level'));
    if (Number.isInteger(ariaLevel) && ariaLevel >= 1 && ariaLevel <= 6) return ariaLevel;
    return fallback;
  }

  function domOrder(a, b) {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function extractOutline(contentRoot) {
    if (!(contentRoot instanceof Element)) return [];

    // 不遍历回答中的每一个 div/p。长回答里对大量通用容器逐个读取
    // 文本会放大为昂贵的整页布局工作；只收集真正的标题和可能的
    // “整段加粗标题”父节点即可。
    const headings = [...contentRoot.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')];
    const strongTitleParents = [...contentRoot.querySelectorAll('p > strong, p > b, div > strong, div > b')]
      .map((element) => element.parentElement)
      .filter(Boolean);
    const structural = uniqueElements([...headings, ...strongTitleParents])
      .filter((element) => !isExcludedNode(element, contentRoot))
      .filter((element) => element.matches('h1, h2, h3, h4, h5, h6, [role="heading"]') || isStandaloneStrongTitle(element))
      .map((element) => ({
        element,
        text: shorten(element.textContent),
        level: nodeLevel(element, 3),
        inferred: isStandaloneStrongTitle(element),
      }))
      .filter((item) => item.text)
      .sort((a, b) => domOrder(a.element, b.element));

    const items = dedupeOutlineItems(structural);

    // 普通段落和列表项不再作为兜底大纲，避免将大段正文误判为标题。
    if (!items.length) return [];

    const baseLevel = Math.min(...items.map((item) => item.level));
    return items.slice(0, MAX_ITEMS).map((item) => ({
      ...item,
      level: Math.max(1, Math.min(4, item.level - baseLevel + 1)),
    }));
  }

  function dedupeOutlineItems(items) {
    const seenElements = new Set();
    const result = [];
    for (const item of items) {
      if (seenElements.has(item.element)) continue;
      if (result.length && result[result.length - 1].text === item.text) continue;
      seenElements.add(item.element);
      result.push(item);
    }
    return result;
  }

  function clearOldAnchors() {
    state.items.forEach((item) => item.element?.removeAttribute?.(ANCHOR_ATTR));
  }

  function textSignature(content) {
    const text = String(content?.textContent || '');
    return `${text.length}:${text.slice(-180)}`;
  }

  function renderOutline(force = false) {
    if (!state.ui) return;
    state.ui.site.textContent = state.adapter?.label || 'AI Chat';

    const currentIndex = state.answers.indexOf(state.currentAnswer);
    state.ui.counter.textContent = currentIndex >= 0
      ? `${currentIndex + 1} / ${state.answers.length}`
      : (state.answers.length ? `${state.answers.length} 个回答` : '暂无回答');

    if (!state.currentAnswer) {
      clearOldAnchors();
      state.items = [];
      state.activeItem = null;
      state.contentTextSignature = '';
      state.contentSignature = '';
      state.ui.body.innerHTML = '<div class="empty">当前聊天还没有可识别的 AI 回答。</div>';
      return;
    }

    let content = null;
    try { content = state.adapter.getContent(state.currentAnswer, document); } catch { content = state.currentAnswer; }
    content = content instanceof Element ? content : state.currentAnswer;
    const nextTextSignature = textSignature(content);
    if (!force && nextTextSignature === state.contentTextSignature) return;

    const nextItems = extractOutline(content);
    const signature = `${nextTextSignature}:${nextItems.map((item) => item.text).join('|')}`;
    if (!force && signature === state.contentSignature) return;

    clearOldAnchors();
    state.items = nextItems;
    state.items.forEach((item, index) => {
      item.element.setAttribute(ANCHOR_ATTR, `${Date.now().toString(36)}-${index}`);
    });
    state.contentTextSignature = nextTextSignature;
    state.contentSignature = signature;
    state.activeItem = null;

    if (!state.items.length) {
      state.ui.body.innerHTML = '<div class="empty">当前回答没有可识别的标题。<br>仅显示正文标题和独立加粗短标题。</div>';
      return;
    }

    const list = document.createElement('div');
    list.className = 'outline';
    state.items.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'item';
      button.dataset.index = String(index);
      button.dataset.level = String(item.level);
      button.style.setProperty('--indent', `${(item.level - 1) * 12}px`);
      button.textContent = item.text;
      button.title = cleanText(item.element.textContent);
      button.addEventListener('click', () => {
        item.element.scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'center',
        });
        setActiveItem(item, true);
      });
      list.appendChild(button);
    });
    state.ui.body.replaceChildren(list);
    updateActiveOutlineItem();
  }

  function setActiveItem(item, ensureVisible = false) {
    if (!state.ui || item === state.activeItem) return;
    state.activeItem = item;
    const index = state.items.indexOf(item);
    state.shadow.querySelectorAll('.item').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.index) === index);
    });
    if (ensureVisible && index >= 0) {
      state.shadow.querySelector(`.item[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  function updateActiveOutlineItem() {
    if (!state.items.length) return;
    // 大纲点击使用 block: 'center'，因此高亮判定线也放在视口中央附近，
    // 避免平滑滚动完成后又误高亮到上一个小节。
    const focusY = Math.max(86, window.innerHeight * 0.5);
    let active = state.items[0];
    for (const item of state.items) {
      if (!item.element.isConnected) continue;
      const rect = item.element.getBoundingClientRect();
      if (rect.top <= focusY) active = item;
      else break;
    }
    setActiveItem(active, true);
  }

  function safeCollectAnswers() {
    let answers = [];
    try { answers = state.adapter?.collectAnswers(document) || []; } catch (error) {
      console.warn('[AI Chat Outline] collectAnswers 失败：', error);
    }
    return uniqueElements(answers).filter((answer) => answer.isConnected && elementTextLength(answer) > 0);
  }

  function visibleDistanceToFocus(element, focusY) {
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.top) || (!rect.width && !rect.height)) return Infinity;
    if (rect.top <= focusY && rect.bottom >= focusY) return -Math.min(rect.bottom - focusY, focusY - rect.top);
    return Math.min(Math.abs(rect.top - focusY), Math.abs(rect.bottom - focusY));
  }

  function answerNearViewport() {
    const focusY = Math.max(110, window.innerHeight * 0.38);
    let nearest = null;
    let nearestDistance = Infinity;
    for (const answer of state.answers) {
      const distance = visibleDistanceToFocus(answer, focusY);
      if (distance < nearestDistance) {
        nearest = answer;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function setCurrentAnswer(answer, force = false) {
    if (!(answer instanceof Element)) answer = null;
    const changed = answer !== state.currentAnswer;
    state.currentAnswer = answer;
    if (changed) {
      state.contentTextSignature = '';
      state.contentSignature = '';
    }
    if (force || changed) renderOutline(true);
  }

  function scan({ fromScroll = false } = {}) {
    if (state.destroyed) return;
    selectAdapter();

    if (fromScroll && state.answers.length && state.answers.every((answer) => answer.isConnected)) {
      setCurrentAnswer(answerNearViewport());
      updateActiveOutlineItem();
      return;
    }

    const previousAnswers = state.answers;
    state.answers = safeCollectAnswers();

    if (!state.answers.length) {
      setCurrentAnswer(null, previousAnswers.length > 0);
      return;
    }

    if (state.preferLastAnswer) {
      const remainingSettleTime = state.preferLastUntil - Date.now();
      if (remainingSettleTime > 0) {
        scheduleScan(remainingSettleTime + 20);
        return;
      }
      state.preferLastAnswer = false;
      setCurrentAnswer(state.answers[state.answers.length - 1], true);
      return;
    }

    if (fromScroll) {
      setCurrentAnswer(answerNearViewport());
      updateActiveOutlineItem();
      return;
    }

    if (!state.currentAnswer?.isConnected || !state.answers.includes(state.currentAnswer)) {
      setCurrentAnswer(answerNearViewport() || state.answers[state.answers.length - 1], true);
      return;
    }

    renderOutline(false);
    updateActiveOutlineItem();
  }

  function scheduleScan(delay = 120, options = {}) {
    clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => scan(options), delay);
  }

  function onScroll(event) {
    if (event?.composedPath?.().includes(state.host)) return;
    if (state.scrollFrame) return;
    state.scrollFrame = window.setTimeout(() => {
      state.scrollFrame = 0;
      scan({ fromScroll: true });
    }, 120);
  }

  function onRouteMaybeChanged() {
    const nextKey = routeKey();
    if (nextKey === state.routeKey) return;
    state.routeKey = nextKey;
    state.preferLastAnswer = true;
    state.preferLastUntil = Date.now() + ROUTE_SETTLE_MS;
    state.currentAnswer = null;
    state.answers = [];
    clearOldAnchors();
    state.items = [];
    state.contentTextSignature = '';
    state.contentSignature = '';
    selectAdapter();
    renderOutline(true);
    clearTimeout(state.routeTimer);
    state.routeTimer = window.setTimeout(() => scheduleScan(0), ROUTE_SETTLE_MS);
  }

  function mutationMayAffectOutline(records) {
    for (const record of records) {
      const target = record.target.nodeType === Node.TEXT_NODE
        ? record.target.parentElement
        : record.target;

      if (target instanceof Element) {
        if (state.currentAnswer?.contains(target)) return true;
        if (target.closest('.list_items')) return true;
      }

      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof Element)) continue;
        if (node.matches(ANSWER_MARKER_SELECTOR) || node.querySelector(ANSWER_MARKER_SELECTOR)) return true;
      }
    }
    return false;
  }

  function patchHistory() {
    const originals = { pushState: history.pushState, replaceState: history.replaceState };
    for (const method of ['pushState', 'replaceState']) {
      history[method] = function patchedHistory(...args) {
        const result = originals[method].apply(this, args);
        queueMicrotask(onRouteMaybeChanged);
        return result;
      };
    }
    state.restoreHistory = () => {
      history.pushState = originals.pushState;
      history.replaceState = originals.replaceState;
    };
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    clearTimeout(state.scanTimer);
    clearTimeout(state.routeTimer);
    if (state.scrollFrame) clearTimeout(state.scrollFrame);
    state.observer?.disconnect();
    state.restoreHistory?.();
    window.removeEventListener('popstate', onRouteMaybeChanged);
    window.removeEventListener('hashchange', onRouteMaybeChanged);
    document.removeEventListener('scroll', onScroll, true);
    clearOldAnchors();
    state.host?.remove();
    delete window.__AI_CHAT_OUTLINE__;
    delete window.AIChatOutline;
  }

  function init() {
    selectAdapter();
    createPanel();
    patchHistory();

    state.observer = new MutationObserver((records) => {
      const previousRoute = state.routeKey;
      onRouteMaybeChanged();
      if (previousRoute !== state.routeKey) return;
      if (mutationMayAffectOutline(records)) scheduleScan(240);
    });
    state.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    window.addEventListener('popstate', onRouteMaybeChanged);
    window.addEventListener('hashchange', onRouteMaybeChanged);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });

    const api = {
      version: '1.0.5',
      registerAdapter,
      refresh: () => scheduleScan(0),
      destroy,
      getCurrentAdapter: () => state.adapter?.id || null,
    };
    window.__AI_CHAT_OUTLINE__ = api;
    window.AIChatOutline = api;
    scheduleScan(0);
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init, { once: true });
})();
