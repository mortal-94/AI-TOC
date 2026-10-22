// ==UserScript==
// @name         AI 聊天回答大纲（ChatGPT / 豆包）
// @namespace    https://local.codex/ai-chat-outline
// @version      1.0.8
// @description  为当前可见的 AI 回答生成侧边大纲；切换聊天时显示最后一个回答，滚动时自动切换。
// @author       Codex
// @homepageURL  https://github.com/mortal-94/AI-TOC
// @supportURL   https://github.com/mortal-94/AI-TOC/issues
// @downloadURL  https://raw.githubusercontent.com/mortal-94/AI-TOC/main/ai-chat-outline.user.js
// @updateURL    https://raw.githubusercontent.com/mortal-94/AI-TOC/main/ai-chat-outline.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://www.doubao.com/chat*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const APP_ID = 'ai-chat-outline-v1';
  const VERSION = '1.0.8';
  const HOST_ID = `${APP_ID}-host`;
  const ANCHOR_ATTR = 'data-ai-chat-outline-anchor';
  const MAX_ITEMS = 80;
  const ROUTE_SETTLE_MS = 700;
  const STORAGE_KEY = `${APP_ID}:collapsed`;

  function readCollapsedState() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  }

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
    collapsed: readCollapsedState(),
    destroyed: false,
    scanTimer: 0,
    routeTimer: 0,
    scrollFrame: 0,
    healthTimer: 0,
    contentRoot: null,
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
    '[contenteditable="true"]', '[hidden]:not([hidden="until-found"])',
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
    '[data-turn="assistant"]',
    '[data-testid="assistant-message"]',
    '[data-testid^="conversation-turn-"]',
    '.markdown',
    '.markdown-body',
    '.prose',
    '[class^="markdown-"]',
    '[class*=" markdown-"]',
    '[data-turn-key]',
    '[data-content-search-turn-key]',
    '[data-talvt-turn-state]',
    '[data-virtualized-turn-content]',
  ].join(',');

  const CHATGPT_ASSISTANT_SELECTOR = [
    '[data-message-author-role="assistant"]', '[data-role="assistant"]',
    '[data-author="assistant"]', '[data-message-role="assistant"]',
    '[data-turn="assistant"]', '[data-testid="assistant-message"]',
  ].join(',');
  const CHATGPT_USER_SELECTOR = [
    '[data-message-author-role="user"]', '[data-role="user"]',
    '[data-author="user"]', '[data-message-role="user"]',
    '[data-turn="user"]', '[data-testid="user-message"]',
  ].join(',');
  // 匹配 class token，而非任意子串；[--entity-prose-inset:0px] 不是正文标记。
  const MARKDOWN_SELECTOR = '.markdown, .markdown-body, .prose, [class^="markdown-"], [class*=" markdown-"]';
  const MESSAGE_BOUNDARY_SELECTOR = '[data-message-id], [data-turn-id], [data-testid^="conversation-turn-"], article';
  const VIRTUAL_TURN_SELECTOR = '[data-talvt-turn-state], [data-content-search-turn-key], [data-turn-key]';
  const SPEAKER_HEADING_SELECTOR = 'h1.sr-only, h2.sr-only, h3.sr-only, h4.sr-only, h5.sr-only, h6.sr-only';

  function speakerRole(heading) {
    const label = cleanText(heading.textContent);
    if (/^(?:chatgpt|assistant)(?:\b|[\s：:])|^(?:助手|豆包)(?:\s|说|回复|[：:])/i.test(label)) return 'assistant';
    if (/^(?:you|user)(?:\b|[\s：:])|^(?:你|您|用户)(?:\s|说|问|[：:])/i.test(label)) return 'user';
    return '';
  }

  function isHiddenMessage(element) {
    // aria-hidden 仅控制无障碍树；ChatGPT 的可见聊天也可能位于这种容器内。
    return Boolean(element.closest('[hidden]:not([hidden="until-found"])'));
  }

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
        const roles = [...root.querySelectorAll(CHATGPT_ASSISTANT_SELECTOR)]
          .filter((element) => !isHiddenMessage(element));
        // 保留最外层 assistant 节点，同一回答中的多个 markdown 片段统一提取。
        const answers = roles.filter((role) => !roles.some((other) => other !== role && other.contains(role)));
        // 新版虚拟聊天去掉了 author-role/markdown，通过消息中的说话人标签区分回答。
        // 标签父节点是消息正文边界；同一虚拟 turn 可以同时包含用户和 AI 消息。
        for (const heading of root.querySelectorAll(SPEAKER_HEADING_SELECTOR)) {
          if (!heading.closest(VIRTUAL_TURN_SELECTOR) || speakerRole(heading) !== 'assistant') continue;
          const message = heading.parentElement;
          if (!message || isHiddenMessage(message)) continue;
          if (message.matches(CHATGPT_USER_SELECTOR) || message.querySelector(CHATGPT_USER_SELECTOR)) continue;
          if (answers.some((answer) => answer.contains(message) || message.contains(answer))) continue;
          answers.push(message);
        }
        // 兼容只保留 conversation-turn 标记的页面；明确排除用户消息。
        const turns = [...root.querySelectorAll('main article, main [data-testid^="conversation-turn-"], [data-turn="assistant"]')];
        for (const turn of turns) {
          if (isHiddenMessage(turn)) continue;
          if (turn.matches(CHATGPT_USER_SELECTOR) || turn.querySelector(CHATGPT_USER_SELECTOR)) continue;
          if (answers.some((answer) => turn.contains(answer) || answer.contains(turn))) continue;
          if (turn.querySelector(MARKDOWN_SELECTOR)) answers.push(turn);
        }
        // 新布局可能只有 markdown 正文而没有 article/conversation-turn 外壳。
        // 逐段回溯至消息边界，既不依赖具体标签名，也不跨越用户消息。
        const mainRoots = [...root.querySelectorAll('main, [role="main"], #thread')];
        for (const main of mainRoots) {
          const markdownRoots = [...(main.matches(MARKDOWN_SELECTOR) ? [main] : []), ...main.querySelectorAll(MARKDOWN_SELECTOR)];
          const candidates = markdownRoots.flatMap((markdown) => {
            if (markdown !== main) return [markdown];
            const boundaries = [...main.querySelectorAll(MESSAGE_BOUNDARY_SELECTOR)].filter((node) => {
              const ancestor = node.parentElement?.closest(MESSAGE_BOUNDARY_SELECTOR);
              return !ancestor || ancestor === main || !main.contains(ancestor);
            });
            return boundaries.length ? boundaries : [markdown];
          });
          for (const markdown of candidates) {
            if (isHiddenMessage(markdown) || markdown.closest(CHATGPT_USER_SELECTOR)) continue;
            if (markdown.closest(EXCLUDED_OUTLINE_SELECTOR)) continue;
            const markdownParent = markdown.parentElement?.closest(MARKDOWN_SELECTOR);
            if (markdownParent && markdownParent !== main && main.contains(markdownParent)) continue;
            if (answers.some((answer) => answer.contains(markdown) || markdown.contains(answer))) continue;
            const boundary = markdown.closest(MESSAGE_BOUNDARY_SELECTOR);
            const answer = boundary && main.contains(boundary)
              && !boundary.matches(CHATGPT_USER_SELECTOR) && !boundary.querySelector(CHATGPT_USER_SELECTOR)
              ? boundary : markdown;
            if (!answers.some((existing) => existing === answer || existing.contains(answer))) answers.push(answer);
          }
        }
        return uniqueElements(answers).filter((answer) => elementTextLength(answer) > 0)
          .sort(domOrder);
      },
      getContent(answer) {
        // 不选第一个 markdown：流式回答可能拆分为多个正文片段。
        return answer;
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
    const style = document.createElement('style');
    style.textContent = `
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
    `;
    // 使用 DOM API 避开页面 require-trusted-types-for 'script' 的 HTML 写入限制。
    const make = (tag, className, text) => {
      const element = document.createElement(tag);
      element.className = className;
      if (text) element.textContent = text;
      return element;
    };
    const panel = make('aside', 'panel');
    panel.setAttribute('aria-label', 'AI 回答大纲');
    const header = make('div', 'header');
    const logo = make('span', 'logo', '≡');
    logo.setAttribute('aria-hidden', 'true');
    const counter = make('span', 'counter', '等待回答');
    const collapse = make('button', 'icon-button collapse', '‹');
    collapse.type = 'button';
    const body = make('div', 'body');
    body.append(make('div', 'empty', '正在识别当前聊天的回答…'));
    const footer = make('div', 'footer');
    footer.append(make('span', 'site', 'AI Chat'), make('span', '', '滚动自动切换'));
    header.append(logo, make('span', 'title', '回答大纲'), counter, collapse);
    panel.append(header, body, footer);
    shadow.append(style, panel);
    (document.body || document.documentElement).appendChild(host);

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
      try { localStorage.setItem(STORAGE_KEY, state.collapsed ? '1' : '0'); } catch { /* 页面禁用存储时仍可使用 */ }
      applyCollapsedState();
    });
  }

  function applyCollapsedState() {
    if (!state.ui) return;
    state.ui.panel.classList.toggle('collapsed', state.collapsed);
    state.ui.collapse.textContent = state.collapsed ? '›' : '‹';
    const action = state.collapsed ? '展开大纲' : '折叠大纲';
    state.ui.collapse.title = action;
    state.ui.collapse.setAttribute('aria-label', action);
  }

  function isExcludedNode(element, contentRoot) {
    if (element.closest('.sr-only')) return true;
    if (element.closest('[hidden]:not([hidden="until-found"]), [data-testid*="thinking"], [data-testid*="reasoning"]')) return true;
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
    state.ui.site.textContent = `${state.adapter?.label || 'AI Chat'} · ${VERSION}`;

    const currentIndex = state.answers.indexOf(state.currentAnswer);
    state.ui.counter.textContent = currentIndex >= 0
      ? `${currentIndex + 1} / ${state.answers.length}`
      : (state.answers.length ? `${state.answers.length} 个回答` : '暂无回答');

    if (!state.currentAnswer) {
      clearOldAnchors();
      state.items = [];
      state.activeItem = null;
      state.contentRoot = null;
      state.contentTextSignature = '';
      state.contentSignature = '';
      showEmpty('当前聊天还没有可识别的 AI 回答。');
      return;
    }

    let content = null;
    try { content = state.adapter.getContent(state.currentAnswer, document); } catch { content = state.currentAnswer; }
    content = content instanceof Element ? content : state.currentAnswer;
    const nextTextSignature = textSignature(content);
    const targetsConnected = state.items.every((item) => item.element.isConnected && content.contains(item.element));
    if (!force && content === state.contentRoot && targetsConnected && nextTextSignature === state.contentTextSignature) return;

    const nextItems = extractOutline(content);
    const signature = `${nextTextSignature}:${nextItems.map((item) => `${item.level}:${item.text}`).join('|')}`;
    const sameTargets = nextItems.length === state.items.length
      && nextItems.every((item, index) => item.element === state.items[index].element);
    if (!force && sameTargets && signature === state.contentSignature) {
      state.contentTextSignature = nextTextSignature;
      state.contentRoot = content;
      return;
    }

    clearOldAnchors();
    state.items = nextItems;
    state.items.forEach((item, index) => {
      item.element.setAttribute(ANCHOR_ATTR, `${Date.now().toString(36)}-${index}`);
    });
    state.contentTextSignature = nextTextSignature;
    state.contentRoot = content;
    state.contentSignature = signature;
    state.activeItem = null;

    if (!state.items.length) {
      showEmpty('当前回答没有可识别的标题。仅显示正文标题和独立加粗短标题。');
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

  function showEmpty(message) {
    const existing = state.ui.body.querySelector('.empty');
    const detailsExist = Boolean(state.ui.body.querySelector('details'));
    if (existing?.textContent === message && detailsExist === !state.answers.length) return;
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = message;
    state.ui.body.replaceChildren(empty);
    if (!state.answers.length) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '识别诊断（不含聊天正文）';
      const diagnostic = document.createElement('pre');
      diagnostic.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;margin:8px 0';
      const refreshDiagnostic = () => { diagnostic.textContent = JSON.stringify(getDiagnostics(), null, 2); };
      details.addEventListener('toggle', () => { if (details.open) refreshDiagnostic(); });
      details.append(summary, diagnostic);
      state.ui.body.append(details);
    }
  }

  function getDiagnostics() {
    const count = (selector) => document.querySelectorAll(selector).length;
    const roles = [...document.querySelectorAll(CHATGPT_ASSISTANT_SELECTOR)];
    return {
      version: VERSION,
      site: location.hostname,
      adapter: state.adapter?.id,
      answers: state.answers.length,
      assistantMarkers: roles.length,
      assistantUnderAriaHidden: roles.filter((role) => role.closest('[aria-hidden="true"]')).length,
      assistantUnderHidden: roles.filter(isHiddenMessage).length,
      conversationTurns: count('[data-testid^="conversation-turn-"]'),
      markdownBlocks: count(MARKDOWN_SELECTOR),
      mainRegions: count('main, [role="main"], #thread'),
      headings: count('main h1, main h2, main h3, main h4, main h5, main h6, [role="main"] [role="heading"]'),
      frames: count('iframe'),
      virtualTurnGroups: count('[data-talvt-turn-state]'),
      speakerHeaders: count(SPEAKER_HEADING_SELECTOR),
      assistantSpeakerHeaders: [...document.querySelectorAll(SPEAKER_HEADING_SELECTOR)].filter((heading) => speakerRole(heading) === 'assistant').length,
    };
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
    onRouteMaybeChanged();
    selectAdapter();

    if (fromScroll && !state.preferLastAnswer && state.answers.length && state.answers.every((answer) => answer.isConnected)) {
      setCurrentAnswer(answerNearViewport());
      updateActiveOutlineItem();
      return;
    }

    state.answers = safeCollectAnswers();

    if (!state.answers.length) {
      setCurrentAnswer(null, true);
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
    // 连续流式变更不能无限推迟首次扫描。
    if (state.scanTimer) return;
    state.scanTimer = window.setTimeout(() => {
      state.scanTimer = 0;
      scan(options);
    }, delay);
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
    clearTimeout(state.scanTimer);
    state.scanTimer = 0;
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
        if (target === state.host || state.host?.contains(target)) continue;
        if (state.currentAnswer?.contains(target)) return true;
        if (target.closest('.list_items')) return true;
        if (target.closest(ANSWER_MARKER_SELECTOR)) return true;
      }

      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof Element)) continue;
        if (node === state.host) continue;
        if (node.matches(ANSWER_MARKER_SELECTOR) || node.querySelector(ANSWER_MARKER_SELECTOR)) return true;
      }
    }
    return false;
  }

  function patchHistory() {
    const originals = { pushState: history.pushState, replaceState: history.replaceState };
    const wrappers = {};
    for (const method of ['pushState', 'replaceState']) {
      wrappers[method] = function patchedHistory(...args) {
        const result = originals[method].apply(this, args);
        queueMicrotask(onRouteMaybeChanged);
        return result;
      };
      try { history[method] = wrappers[method]; } catch { /* 路由轮询兜底 */ }
    }
    state.restoreHistory = () => {
      for (const method of ['pushState', 'replaceState']) {
        if (history[method] === wrappers[method]) history[method] = originals[method];
      }
    };
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    clearTimeout(state.scanTimer);
    clearTimeout(state.routeTimer);
    clearInterval(state.healthTimer);
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
      if (mutationMayAffectOutline(records)) {
        // 相同文本也可能换成了新的标题节点，不能继续使用旧点击目标。
        state.contentTextSignature = '';
        scheduleScan(240);
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-message-author-role', 'data-message-role', 'data-role', 'data-author', 'data-turn', 'data-testid', 'class', 'hidden', 'aria-hidden', 'role', 'aria-level', 'data-turn-key', 'data-content-search-turn-key', 'data-talvt-turn-state', 'data-virtualized-turn-content'],
    });

    window.addEventListener('popstate', onRouteMaybeChanged);
    window.addEventListener('hashchange', onRouteMaybeChanged);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    state.healthTimer = window.setInterval(() => {
      if (state.destroyed) return;
      onRouteMaybeChanged();
      if (!state.host?.isConnected) (document.body || document.documentElement).appendChild(state.host);
      if (!state.answers.length || state.answers.some((answer) => !answer.isConnected)) scheduleScan(0);
    }, 1000);

    const api = {
      version: VERSION,
      registerAdapter,
      refresh: () => scheduleScan(0),
      destroy,
      getCurrentAdapter: () => state.adapter?.id || null,
      getDiagnostics,
    };
    window.__AI_CHAT_OUTLINE__ = api;
    window.AIChatOutline = api;
    scheduleScan(0);
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init, { once: true });
})();
