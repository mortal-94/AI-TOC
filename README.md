# AI 聊天回答大纲油猴脚本

文件：`ai-chat-outline.user.js`

## 安装

1. 在 Chrome 安装 Tampermonkey（油猴）。
2. 点击[安装或更新脚本](https://raw.githubusercontent.com/mortal-94/AI-TOC/main/ai-chat-outline.user.js)，在 Tampermonkey 中确认。
3. 刷新 ChatGPT 或豆包聊天页。

也可以在 Tampermonkey 中编辑原有脚本，用 `ai-chat-outline.user.js` 的全部代码替换并保存。已安装 1.0.5 的用户需要手动更新一次；从 1.0.6 起包含 GitHub 自动更新地址。

已包含的网站：

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://www.doubao.com/chat*`

## 行为

- 打开或切换聊天：默认显示该聊天最后一个 AI 回答的大纲。
- 滚动聊天内容：视口焦点进入另一个回答时，自动换成该回答的大纲。
- 点击大纲条目：平滑滚动到回答中的对应位置。
- 回答正在生成：随着页面内容更新，自动刷新大纲。
- 没有显式标题：显示“未识别到标题”，不再把普通段落或列表正文放入大纲。
- 折叠状态：会保存在当前站点的 `localStorage` 中。

## 扩展到其他 AI 网站

先在脚本头部增加目标网站的 `@match`，例如：

```javascript
// @match https://example-ai.com/*
```

如果目标网站使用常见的 `data-role="assistant"` 等语义属性，内置通用适配器可能直接可用。否则，在脚本的 `state.adapters.push(...)` 后面增加一个适配器，或在页面环境中调用公开接口：

```javascript
window.AIChatOutline.registerAdapter({
  id: 'example-ai',
  label: 'Example AI',
  matches: () => location.hostname === 'example-ai.com',
  collectAnswers: (documentRoot) =>
    [...documentRoot.querySelectorAll('.assistant-message')],
  getContent: (answerElement) =>
    answerElement.querySelector('.markdown-body') || answerElement,
});
```

适配器需要提供三个函数：

- `matches(location, document)`：判断当前页面是否适用。
- `collectAnswers(document)`：按页面顺序返回所有 AI 回答元素。
- `getContent(answerElement, document)`：从某个回答中返回正文元素。

## 排查

如果网站改版后面板显示“暂无回答”，在开发者工具控制台执行：

```javascript
AIChatOutline.getCurrentAdapter()
```

确认适配器后，再检查回答元素选择器。修改脚本并保存后，可执行：

```javascript
AIChatOutline.refresh()
```

强制重新扫描当前聊天。

如果完全看不到大纲面板，请先确认 Tampermonkey 在当前网站启用了此脚本，且已允许运行用户脚本。浏览器拒绝注入时，脚本本身无法显示提示。

## 1.0.6 兼容修复

- 面板使用 DOM API 创建，兼容要求 TrustedHTML 的页面。
- 兼容多种 assistant / conversation-turn 标记，同一回答的多个 Markdown 片段统一提取，排除用户消息。
- 修复流式更新持续推迟大纲刷新、相同文字节点替换后点击目标失效的问题。
- 页面替换 body 后恢复面板；增加路由检测兜底；存储不可用时仍可使用。
- 保留仅提取标题的规则，普通段落和列表正文不作为大纲兜底。

## 1.0.7 回答识别修复

- 修复可见回答位于 `aria-hidden` 容器内时被全部排除的问题。`aria-hidden` 表示无障碍树状态，不等同于视觉隐藏。
- 支持只有 Markdown 正文、没有 `article` 或 assistant 属性的主聊天布局，并按消息边界合并正文片段。
- 继续排除明确标记的用户消息、HTML 隐藏备份和普通正文。
- 面板页脚显示版本；“暂无回答”下可展开“识别诊断”，只输出节点计数和站点信息，不包含聊天正文。

若更新至 1.0.7 后仍显示“暂无回答”，请将面板“识别诊断”中的 JSON 发来，便可定位具体缺失的结构。也可以在控制台执行 `AIChatOutline.getDiagnostics()`。

## 本地验证

需要 Node.js 和 Playwright：

```sh
npm install
npx playwright install chromium
npm run check
npm test
```

也可以设置 `TEST_CHROME_PATH` 指向已安装的 Chrome。测试在独立无头浏览器中运行，使用本地拦截的 ChatGPT 域名页面覆盖 Trusted Types、回答识别、流式更新、聊天切换、正文过滤与点击定位，不读取个人浏览器数据。测试通过不代表真实登录页面已完成验收。
