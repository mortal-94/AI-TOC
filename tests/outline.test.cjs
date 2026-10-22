const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const script = process.env.TEST_SCRIPT_REF
  ? require('node:child_process').execFileSync('git', ['show', `${process.env.TEST_SCRIPT_REF}:ai-chat-outline.user.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
  : fs.readFileSync(path.join(__dirname, '..', 'ai-chat-outline.user.js'), 'utf8');
const scriptVersion = /^\/\/ @version\s+(\S+)/m.exec(script)[1];
let browser;
const baseUrl = 'https://chatgpt.com';
const fixtureHtml = '<!doctype html><html><head><style>body{margin:0}article{min-height:1100px;padding:50px;width:600px}h3{margin-top:450px}</style></head><body><main></main></body></html>';

function answer(number, attributes = 'data-message-author-role="assistant"') {
  return `<article ${attributes} id="answer-${number}"><div class="markdown"><h2>标题 ${number}</h2><p>普通正文不应成为标题。</p><h3>小节 ${number}</h3></div></article>`;
}

before(async () => {
  const executablePath = process.env.TEST_CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});

after(async () => {
  await browser?.close();
});

async function setup(t, html, { denyStorage = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Every request is fulfilled locally: exercise the production hostname without contacting ChatGPT.
  await page.route('**/*', (route) => {
    if (route.request().url() === `${baseUrl}/userscript.js`) {
      return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: { 'Content-Security-Policy': "require-trusted-types-for 'script'" },
      body: fixtureHtml,
    });
  });
  await page.goto(baseUrl);
  // Fixture creation itself follows Trusted Types; the userscript must work without a default policy.
  await page.evaluate((markup) => {
    const policy = trustedTypes.createPolicy('fixture', { createHTML: (value) => value });
    document.querySelector('main').innerHTML = policy.createHTML(markup);
  }, html);
  if (denyStorage) {
    await page.evaluate(() => Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('Storage denied', 'SecurityError'); },
    }));
  }
  await page.evaluate(() => {
      const policy = trustedTypes.createPolicy('fixture-url', { createScriptURL: (url) => url });
      const element = document.createElement('script');
      element.src = policy.createScriptURL('/userscript.js');
      document.body.append(element);
  });
  await page.waitForFunction((version) => window.AIChatOutline?.version === version, scriptVersion);
  assert.equal(await page.evaluate(() => AIChatOutline.getCurrentAdapter()), 'chatgpt');
  return { page, errors };
}

async function state(page) {
  return page.evaluate(() => {
    const shadow = document.getElementById('ai-chat-outline-v1-host')?.shadowRoot;
    return {
      counter: shadow?.querySelector('.counter')?.textContent,
      items: [...(shadow?.querySelectorAll('.item') || [])].map((item) => item.textContent),
      empty: shadow?.querySelector('.empty')?.textContent,
    };
  });
}

async function waitCounter(page, text) {
  await page.waitForFunction((value) => document.getElementById('ai-chat-outline-v1-host')?.shadowRoot.querySelector('.counter')?.textContent === value, text, { timeout: 3000 });
}

test('Trusted Types 下创建面板，仅提取标题且默认最后回答', async (t) => {
  const { page, errors } = await setup(t, answer(1) + answer(2));
  await waitCounter(page, '2 / 2');
  assert.deepEqual((await state(page)).items, ['标题 2', '小节 2']);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => {
    try { document.createElement('div').innerHTML = '<b>blocked</b>'; return false; } catch { return true; }
  }), true);
});

test('新版 role/turn 标记及无 role 的 markdown 回答，排除用户标题', async (t) => {
  const html = answer('用户', 'data-turn="user"')
    + answer(1, 'data-turn="assistant"')
    + answer(2, 'data-testid="conversation-turn-4"');
  const { page } = await setup(t, html);
  await waitCounter(page, '2 / 2');
  assert.deepEqual((await state(page)).items, ['标题 2', '小节 2']);
});

test('多个 markdown 片段合并且嵌套角色标记去重', async (t) => {
  const { page } = await setup(t, '<article data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown"><h2>前半标题</h2></div><div class="markdown"><h3>后半标题</h3><p>正文</p></div></div></article>');
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, ['前半标题', '后半标题']);
});

test('延迟标记角色的水合节点可以识别', async (t) => {
  const { page } = await setup(t, '<section id="late"><h2>后到的回答</h2></section>');
  await page.evaluate(() => document.getElementById('late').setAttribute('data-turn', 'assistant'));
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, ['后到的回答']);
});

test('可见回答的祖先有 aria-hidden 也能识别与提取标题', async (t) => {
  const { page } = await setup(t, `<div aria-hidden="true">${answer(1)}${answer(2)}</div>`);
  await waitCounter(page, '2 / 2');
  assert.deepEqual((await state(page)).items, ['标题 2', '小节 2']);
  const diagnostics = await page.evaluate(() => AIChatOutline.getDiagnostics());
  assert.equal(diagnostics.assistantUnderAriaHidden, 2);
  assert.equal(diagnostics.answers, 2);
});

test('缺少 article 和 assistant 标记时识别 main 中的 markdown', async (t) => {
  const { page } = await setup(t, '<div data-message-id="one"><div class="markdown"><h2>新布局回答一</h2></div><div class="markdown"><h3>同一回答的第二部分</h3></div></div><div data-message-id="two"><div class="markdown"><h2>新布局回答二</h2></div></div>');
  await waitCounter(page, '2 / 2');
  assert.deepEqual((await state(page)).items, ['新布局回答二']);
  await page.evaluate(() => {
    document.querySelector('[data-message-id="one"]').style.height = '1500px';
    window.scrollTo(0, 100);
  });
  await waitCounter(page, '1 / 2');
  assert.deepEqual((await state(page)).items, ['新布局回答一', '同一回答的第二部分']);
});

test('Markdown 就是 main 自身时仍识别回答', async (t) => {
  const html = Array.from({ length: 10 }, (_, index) => `<h2>回答小节 ${index + 1}</h2><p>普通正文</p>`).join('') + '<iframe title="辅助框架"></iframe>';
  const { page } = await setup(t, html);
  await page.evaluate(() => document.querySelector('main').className = 'markdown');
  const diagnostic = await page.evaluate(() => AIChatOutline.getDiagnostics());
  assert.equal(diagnostic.assistantMarkers, 0);
  assert.equal(diagnostic.conversationTurns, 0);
  assert.equal(diagnostic.markdownBlocks, 1);
  assert.equal(diagnostic.mainRegions, 1);
  assert.equal(diagnostic.headings, 10);
  assert.equal(diagnostic.frames, 1);
  await waitCounter(page, '1 / 1');
  assert.equal((await state(page)).items.length, 10);
});

test('main 自带 Markdown 样式时按消息边界分离回答', async (t) => {
  const html = '<section data-message-id="first"><h2>第一回答</h2><p>正文一</p></section>'
    + '<section data-message-id="user" data-role="user"><h2>用户提示</h2></section>'
    + '<section data-message-id="last"><h2>最后回答</h2><p>正文二</p></section>';
  const { page } = await setup(t, html);
  await page.evaluate(() => document.querySelector('main').className = 'markdown');
  await waitCounter(page, '2 / 2');
  assert.deepEqual((await state(page)).items, ['最后回答']);
});

test('布局 CSS 变量中的 prose 不是 Markdown 正文', async (t) => {
  const { page } = await setup(t, '<div class="[--entity-prose-inset:0px]"><h2>布局标题</h2><p>布局内容</p></div>');
  await waitCounter(page, '暂无回答');
  const diagnostic = await page.evaluate(() => AIChatOutline.getDiagnostics());
  assert.equal(diagnostic.markdownBlocks, 0);
  assert.deepEqual((await state(page)).items, []);
});

test('含 prose 变量的外层布局不吞掉真实的多个正文块', async (t) => {
  const { page } = await setup(t, '<div class="[--entity-prose-inset:0px]"><section data-message-id="one"><div class="markdown-body"><h2>第一正文</h2></div></section><section data-message-id="two"><div class="markdown-body"><h2>最后正文</h2></div></section></div>');
  await waitCounter(page, '2 / 2');
  assert.deepEqual((await state(page)).items, ['最后正文']);
  const diagnostic = await page.evaluate(() => AIChatOutline.getDiagnostics());
  assert.equal(diagnostic.markdownBlocks, 2);
});

function virtualTurn(key, speaker, content) {
  return `<div data-turn-key="${key}" class="[&_[data-virtualized-turn-content]]:[content-visibility:visible]"><div data-content-search-turn-key="${key}"><div class="flex flex-col gap-1.5"><div class="group flex flex-col" data-talvt-turn-state="complete"><div class="flex flex-col gap-3 browser:gap-1"><div class="block-BQZwFn"><h4 class="sr-only m-0 select-none print:not-sr-only">${speaker}</h4>${content}</div></div></div></div></div></div>`;
}

test('真实虚拟 turn 结构不依赖旧角色属性及 Markdown 类', async (t) => {
  const html = '<div class="[--entity-prose-inset:0px]">'
    + virtualTurn('u1', '你说：', '<h2>用户提示标题</h2>')
    + virtualTurn('a1', 'ChatGPT 说：', '<h2>第一回答</h2><p>正文</p>')
    + virtualTurn('u2', '你说：', '<p>再问一次</p>')
    + virtualTurn('a2', 'ChatGPT 说：', '<h2>第二回答</h2><h3>小节</h3>') + '</div>';
  const { page } = await setup(t, html);
  await waitCounter(page, '2 / 2');
  assert.deepEqual((await state(page)).items, ['第二回答', '小节']);
  const diagnostic = await page.evaluate(() => AIChatOutline.getDiagnostics());
  assert.equal(diagnostic.assistantMarkers, 0);
  assert.equal(diagnostic.conversationTurns, 0);
  assert.equal(diagnostic.markdownBlocks, 0);
  assert.equal(diagnostic.virtualTurnGroups, 4);
  assert.equal(diagnostic.assistantSpeakerHeaders, 2);
});

test('一个虚拟 turn 内的用户消息和回答分离，英文说话人标签可用', async (t) => {
  const { page } = await setup(t, '<div data-turn-key="combined"><div data-talvt-turn-state="complete"><div><h4 class="sr-only">You said:</h4><h2>用户标题</h2></div><div><h4 class="sr-only">ChatGPT said:</h4><h2>回答标题</h2></div></div></div>');
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, ['回答标题']);
});

test('用户确认的双说话人虚拟 turn：默认最后回答、滚动切换与定位', async (t) => {
  function exchange(key, number) {
    return `<div data-turn-key="${key}"><div data-content-search-turn-key="${key}"><div data-talvt-turn-state="complete" class="group flex flex-col"><div class="flex flex-col gap-3 browser:gap-1"><div class="block-BQZwFn"><h4 class="sr-only m-0 select-none print:not-sr-only">你说：</h4><h2>用户标题 ${number}</h2></div><div id="assistant-${number}" class="block-answer" style="min-height:1200px"><h4 class="sr-only m-0 select-none print:not-sr-only">ChatGPT 说：</h4><h2>回答 ${number}</h2><h3>回答 ${number} 小节</h3><p>普通段落</p></div></div></div></div></div>`;
  }
  const { page } = await setup(t, `<div class="[--entity-prose-inset:0px]">${exchange('first', 1)}${exchange('last', 2)}</div>`);
  await waitCounter(page, '2 / 2');
  assert.deepEqual((await state(page)).items, ['回答 2', '回答 2 小节']);
  assert.equal(await page.evaluate(() => AIChatOutline.getDiagnostics().virtualTurnGroups), 2);
  await page.evaluate(() => window.scrollTo(0, 150));
  await waitCounter(page, '1 / 2');
  assert.deepEqual((await state(page)).items, ['回答 1', '回答 1 小节']);
  await page.locator('#ai-chat-outline-v1-host .item').nth(1).click();
  await page.waitForFunction(() => Math.abs(document.querySelector('#assistant-1 h3').getBoundingClientRect().top - innerHeight / 2) < 80);
  await page.evaluate((html) => {
    history.pushState({}, '', '/c/virtual-second');
    const policy = trustedTypes.createPolicy('virtual-route', { createHTML: (value) => value });
    document.querySelector('main').innerHTML = policy.createHTML(html);
  }, exchange('new-first', 3) + exchange('new-last', 4));
  await page.waitForFunction(() => document.getElementById('ai-chat-outline-v1-host').shadowRoot.querySelector('.item')?.textContent === '回答 4');
  assert.equal((await state(page)).counter, '2 / 2');
});

test('虚拟消息中的 sr-only 标签不作为正文标题，无标题回答保持空大纲', async (t) => {
  const { page } = await setup(t, virtualTurn('a1', 'ChatGPT 说：', '<p>这个回答只有普通段落。</p>'));
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, []);
  assert.match((await state(page)).empty, /没有可识别的标题/);
});

test('只有 role=main 的布局也识别正文，排除用户和隐藏备份', async (t) => {
  const { page } = await setup(t, '<div class="markdown" data-turn="user"><h2>用户标题</h2></div><div hidden><div class="markdown"><h2>隐藏标题</h2></div></div><div class="markdown prose"><h2>可见回答</h2><div class="markdown"><h3>嵌套正文</h3></div></div>');
  await page.evaluate(() => {
    const main = document.querySelector('main');
    const replacement = document.createElement('section');
    replacement.setAttribute('role', 'main');
    replacement.append(...main.childNodes);
    main.replaceWith(replacement);
  });
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, ['可见回答', '嵌套正文']);
});

test('无回答的识别诊断不包含正文，展开状态跨定时扫描保留', async (t) => {
  const { page } = await setup(t, '<section id="unknown"><p>PRIVATE_CHAT_BODY_SENTINEL</p></section>');
  await waitCounter(page, '暂无回答');
  await page.locator('#ai-chat-outline-v1-host summary').click();
  await page.waitForFunction(() => document.getElementById('ai-chat-outline-v1-host').shadowRoot.querySelector('pre')?.textContent);
  const text = await page.locator('#ai-chat-outline-v1-host pre').textContent();
  assert.equal(JSON.parse(text).answers, 0);
  assert.equal(text.includes('PRIVATE_CHAT_BODY_SENTINEL'), false);
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#ai-chat-outline-v1-host details').getAttribute('open'), '');
});

test('滚动切换回答，点击大纲后定位正确', async (t) => {
  const { page } = await setup(t, answer(1) + answer(2));
  await waitCounter(page, '2 / 2');
  await page.evaluate(() => window.scrollTo(0, 200));
  await waitCounter(page, '1 / 2');
  await page.locator('#ai-chat-outline-v1-host .item').nth(1).click();
  await page.waitForFunction(() => Math.abs(document.querySelector('#answer-1 h3').getBoundingClientRect().top - innerHeight / 2) < 80);
  assert.deepEqual((await state(page)).items, ['标题 1', '小节 1']);
});

test('SPA 切换后默认新聊天最后回答', async (t) => {
  const { page } = await setup(t, answer(1) + answer(2));
  await waitCounter(page, '2 / 2');
  await page.evaluate((html) => {
    history.pushState({}, '', '/c/second');
    const policy = trustedTypes.createPolicy('route-fixture', { createHTML: (value) => value });
    document.querySelector('main').innerHTML = policy.createHTML(html);
  }, answer(3) + answer(4));
  await waitCounter(page, '2 / 2');
  await page.waitForFunction(() => document.getElementById('ai-chat-outline-v1-host').shadowRoot.querySelector('.item')?.textContent === '标题 4');
});

test('同文字标题节点替换后点击引用更新', async (t) => {
  const { page } = await setup(t, answer(1));
  await waitCounter(page, '1 / 1');
  await page.evaluate(() => {
    const heading = document.querySelector('h2');
    const replacement = document.createElement('h2');
    replacement.textContent = heading.textContent;
    replacement.id = 'replacement';
    heading.replaceWith(replacement);
  });
  await page.waitForFunction(() => document.getElementById('replacement').hasAttribute('data-ai-chat-outline-anchor'));
  await page.locator('#ai-chat-outline-v1-host .item').first().click();
  assert.equal((await state(page)).items[0], '标题 1');
});

test('流式内容连续变化时不饿死大纲刷新', async (t) => {
  const { page } = await setup(t, answer(1));
  await waitCounter(page, '1 / 1');
  await page.evaluate(() => {
    const heading = document.createElement('h3');
    heading.textContent = '流式新标题';
    document.querySelector('.markdown').append(heading);
    window.streamInterval = setInterval(() => {
      document.querySelector('p').textContent += '续';
    }, 40);
  });
  await page.waitForFunction(() => [...document.getElementById('ai-chat-outline-v1-host').shadowRoot.querySelectorAll('.item')].some((item) => item.textContent === '流式新标题'), null, { timeout: 1500 });
  await page.evaluate(() => clearInterval(window.streamInterval));
});

test('正文不兜底成标题，无标题提示能显示', async (t) => {
  const { page, errors } = await setup(t, '<article data-role="assistant"><div class="markdown"><p>这是一段普通正文。</p><p><strong>这是加粗的完整句子。</strong></p><ul><li>普通列表内容</li></ul></div></article>');
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, []);
  assert.match((await state(page)).empty, /没有可识别的标题/);
  assert.deepEqual(errors, []);
});

test('存储被禁用时仍启动，折叠按钮可用', async (t) => {
  const { page, errors } = await setup(t, answer(1), { denyStorage: true });
  await waitCounter(page, '1 / 1');
  await page.getByRole('button', { name: '折叠大纲' }).click();
  assert.equal(await page.getByRole('button', { name: '展开大纲' }).count(), 1);
  assert.deepEqual(errors, []);
});

test('body 被替换后面板自动恢复', async (t) => {
  const { page } = await setup(t, answer(1));
  await waitCounter(page, '1 / 1');
  await page.evaluate((html) => {
    const body = document.createElement('body');
    const main = document.createElement('main');
    const policy = trustedTypes.createPolicy('body-fixture', { createHTML: (value) => value });
    main.innerHTML = policy.createHTML(html);
    body.append(main);
    document.body.replaceWith(body);
  }, answer(3));
  await page.waitForFunction(() => document.getElementById('ai-chat-outline-v1-host')?.shadowRoot.querySelector('.item')?.textContent === '标题 3');
});

test('空聊天显示提示，静止时不重复设置标题锚点', async (t) => {
  const { page } = await setup(t, '');
  await page.waitForFunction(() => document.getElementById('ai-chat-outline-v1-host')?.shadowRoot.querySelector('.counter')?.textContent === '暂无回答');
  assert.match((await state(page)).empty, /还没有可识别/);
  await page.evaluate((html) => {
    const policy = trustedTypes.createPolicy('hydrate-fixture', { createHTML: (value) => value });
    document.querySelector('main').innerHTML = policy.createHTML(html);
  }, answer(1));
  await waitCounter(page, '1 / 1');
  await page.evaluate(() => {
    window.anchorWrites = 0;
    new MutationObserver((records) => { window.anchorWrites += records.length; }).observe(document.querySelector('main'), { attributes: true, subtree: true, attributeFilter: ['data-ai-chat-outline-anchor'] });
  });
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.anchorWrites), 0);
});

test('六级层次完整保留，默认前三层并可逐层展开、折叠和定位', async (t) => {
  const html = '<article data-role="assistant">' + Array.from({ length: 6 }, (_, index) => `<h${index + 1}>第${index + 1}级</h${index + 1}>`).join('') + '</article>';
  const { page, errors } = await setup(t, html);
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, ['第1级', '第2级', '第3级']);
  for (const level of [3, 4, 5]) {
    await page.getByRole('button', { name: `展开“第${level}级”的子标题`, exact: true }).click();
  }
  const levels = await page.locator('#ai-chat-outline-v1-host .item').evaluateAll((buttons) => buttons.map((button) => Number(button.dataset.level)));
  assert.deepEqual(levels, [1, 2, 3, 4, 5, 6]);
  await page.locator('#ai-chat-outline-v1-host .item[data-level="6"]').click();
  await page.getByRole('button', { name: '折叠“第1级”的子标题', exact: true }).click();
  assert.deepEqual((await state(page)).items, ['第1级']);
  await page.getByRole('button', { name: '展开“第1级”的子标题', exact: true }).click();
  assert.equal((await state(page)).items.length, 6);
  assert.deepEqual(errors, []);
});

test('最浅标题归一级且跳级标题保持层次差异', async (t) => {
  const { page } = await setup(t, '<article data-role="assistant"><h2>起始</h2><h4>跳级</h4><h6>最深</h6></article>');
  await waitCounter(page, '1 / 1');
  const levels = await page.locator('#ai-chat-outline-v1-host .item').evaluateAll((buttons) => buttons.map((button) => Number(button.dataset.level)));
  assert.deepEqual(levels, [1, 3, 5]);
});

test('有正式或 ARIA 标题时不混入独立加粗正文', async (t) => {
  const { page } = await setup(t, '<article data-role="assistant"><p><strong>加粗短句</strong></p><h2>正式标题</h2><div role="heading" aria-level="3">ARIA 小节</div><p><strong>另一个加粗短句</strong></p></article>');
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, ['正式标题', 'ARIA 小节']);
});

test('没有正式标题时才使用加粗短标题，sr-only 说话人不阻止备选', async (t) => {
  const { page } = await setup(t, virtualTurn('bold', 'ChatGPT 说：', '<p><strong>备选标题一</strong></p><p>普通段落</p><p><strong>这是完整句子。</strong></p><p><b>备选标题二</b></p>'));
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, ['备选标题一', '备选标题二']);
  await page.evaluate(() => {
    const heading = document.createElement('h2');
    heading.textContent = '生成中的正式标题';
    document.querySelector('.block-BQZwFn').append(heading);
  });
  await page.waitForFunction(() => document.getElementById('ai-chat-outline-v1-host').shadowRoot.querySelectorAll('.item').length === 1);
  assert.deepEqual((await state(page)).items, ['生成中的正式标题']);
});

test('超过 80 项明确提示并分批加载到末尾，不丢弃后半段标题', async (t) => {
  const html = '<article data-role="assistant">' + Array.from({ length: 161 }, (_, index) => `<h2>条目 ${index + 1}</h2>`).join('') + '</article>';
  const { page } = await setup(t, html);
  await waitCounter(page, '1 / 1');
  assert.equal((await state(page)).items.length, 80);
  assert.equal(await page.locator('#ai-chat-outline-v1-host .outline-status').textContent(), '已加载 80 / 161 个标题');
  await page.getByRole('button', { name: '加载更多（剩余 81 条）', exact: true }).click();
  assert.equal((await state(page)).items.length, 160);
  await page.getByRole('button', { name: '加载更多（剩余 1 条）', exact: true }).click();
  assert.equal((await state(page)).items.length, 161);
  assert.equal((await state(page)).items.at(-1), '条目 161');
  assert.equal(await page.locator('#ai-chat-outline-v1-host .load-more').count(), 0);
});

test('流式正文刷新保留手动折叠和已加载页数', async (t) => {
  const html = '<article data-role="assistant"><h1>章节</h1>' + Array.from({ length: 90 }, (_, index) => `<h2>小节 ${index + 1}</h2>`).join('') + '<p>正文</p></article>';
  const { page } = await setup(t, html);
  await waitCounter(page, '1 / 1');
  await page.locator('#ai-chat-outline-v1-host .load-more').click();
  await page.getByRole('button', { name: '折叠“章节”的子标题', exact: true }).click();
  await page.evaluate(() => document.querySelector('p').textContent += '继续生成');
  await page.waitForTimeout(450);
  assert.deepEqual((await state(page)).items, ['章节']);
  await page.getByRole('button', { name: '展开“章节”的子标题', exact: true }).click();
  assert.equal((await state(page)).items.length, 91);
});

test('滚动至折叠且未加载的小节时展开路径并加载当前标题', async (t) => {
  const html = '<article data-role="assistant"><h1>章节</h1><h2>部分</h2><h3>默认收起</h3>' + Array.from({ length: 90 }, (_, index) => `<h4 id="deep-${index}">深层 ${index + 1}</h4>`).join('') + '<div style="height:900px"></div></article>';
  const { page } = await setup(t, html);
  await waitCounter(page, '1 / 1');
  assert.equal((await state(page)).items.length, 3);
  await page.evaluate(() => document.getElementById('deep-89').scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => document.getElementById('ai-chat-outline-v1-host').shadowRoot.querySelector('.item[data-index="92"]'));
  assert.equal(await page.locator('#ai-chat-outline-v1-host .item.active').textContent(), '深层 90');
});

test('不同位置同名标题保留，不因文字相同吞掉结构', async (t) => {
  const { page } = await setup(t, '<article data-role="assistant"><h2>总结</h2><h2>总结</h2></article>');
  await waitCounter(page, '1 / 1');
  assert.deepEqual((await state(page)).items, ['总结', '总结']);
});
