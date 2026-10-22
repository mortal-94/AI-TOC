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
