# AI 聊天回答大纲油猴脚本

文件：`ai-chat-outline.user.js`

## 安装

1. 在 Chrome 安装 Tampermonkey（油猴）。
2. 打开 Tampermonkey 管理面板，新建脚本。
3. 删除默认内容，粘贴 `ai-chat-outline.user.js` 的全部代码并保存。
4. 刷新 ChatGPT 或豆包聊天页。

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
