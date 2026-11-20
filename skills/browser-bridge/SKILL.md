---
name: browser-bridge
description: 通过 Native Messaging 扩展直接控制并调试用户日常主浏览器（Chrome / Edge），支持标签页管理、纯只读正文提取、页面快照与点击输入自动化、截图、JS 执行以及控制台与网络请求抓取。
---

# Antigravity Browser Bridge

此插件通过 Chrome Native Messaging + Windows Named Pipe 连接到用户日常正在使用的 Chrome / Edge 浏览器，保留全部登录态、Cookie 与已打开标签页。

## 工具清单（20 个工具）

- **状态与标签页发现**
  - `bridge_status`：查看 Broker、已连接浏览器（Chrome/Edge）、弹窗选定页与调试器附着状态。
  - `list_tabs`：跨所有已连接浏览器列出全部标签页（支持 `browser`、`query`、`activeOnly`、`selectedOnly`）。
  - `get_active_tab`：获取弹窗选定目标页与各浏览器当前活动标签页。
- **只读读取与快照（默认无黄色调试横幅，自动穿透 Shadow DOM 与同源 iframe）**
  - `read_page_content`：提取标题、摘要、标题大纲、正文文本与主要链接。仅阅读网页信息时**优先用它**。
  - `get_page_snapshot`：提取页面摘要及可见可交互元素表，分配 `e1`, `e2`... 临时 `ref` 编号与精准视口坐标。
- **标签页控制**
  - `switch_tab` / `open_tab` / `close_tab` / `navigate_tab`（支持 `goto`、`back`、`forward`、`reload`）。
- **页面交互与高速批量自动化（带 Gemini 虚拟鼠标动画，自动穿透 Shadow DOM 与同源 iframe）**
  - `click_element`：支持 `ref`、`selector`、`text` 或 `(x, y)` 坐标点击/双击/右键，点击后自动检测是否打开新标签页。
  - `fill_element`：支持 `ref`、`selector` 或 `text` 定位输入框，兼容 React/Vue/contenteditable 与原生 `<select>`。
  - `press_key`：发送单键或组合键（如 `Enter`、`Escape`、`Control+a`）。
  - `scroll_page`：滚动窗口或将指定 `ref` 元素滚入视野。
  - `wait_for`：等待指定 `selector` 或 `text` 出现在页面中。
  - **`run_steps`（多步任务首选）**：在浏览器端一次连续执行多步（`click` / `fill` / `wait_for` / `wait` / `press_key` / `scroll`），减少往返耗时 3～5 倍；支持 `click` 设置 `switchToNewTab: true` 自动追随新开标签页，支持 `includeSnapshot: true` / `includeContent: true` 一步返回最终页面快照。
- **截图与 DevTools 调试**
  - `take_screenshot`：对当前激活页可见区域优先无横幅截图；整页 (`fullPage: true`) 或后台标签页使用 CDP 截图。
  - `evaluate_script`：在页面上下文执行 JS 表达式并返回结果。
  - `get_console_logs` / `get_network_requests`：首次调用自动附加调试器监听并读取缓存日志/网络请求。
  - `detach_debugger`：分离指定或全部标签页的 `chrome.debugger` 并隐藏虚拟鼠标（默认保持常驻，仅在用户明确要求关闭调试时调用）。

## 最佳实践

1. **优先选择轻量只读方式**：纯读网页文本内容优先 `read_page_content`。
2. **连续多步交互优先用 `run_steps`**：例如“往下划 → 打开某个条目 → 点选选项 → 点赞”，直接合并到 1 次 `run_steps` 调用（配合 `includeSnapshot: true`），避免多轮大模型往返拖慢速度。
3. **常驻调试与虚拟鼠标待命**：完成交互后**默认保持调试连接与虚拟鼠标常驻**，不要主动调用 `detach_debugger`，使后续指令实现 0ms 瞬发响应与连贯的鼠标移动轨迹。
4. **单步精准操作**：执行 `click_element` / `fill_element` 可直接传 `text` / `selector`，或先调用 `get_page_snapshot` 获取最新 `ref`（调用 `get_page_snapshot` 时后台会自动预热调试器并唤出待命虚拟鼠标）。
5. **多浏览器并存**：Chrome 和 Edge 可同时连接，操作特定标签页时把 `list_tabs` 返回的 `tabId` 和 `browserId` 一并传入，避免歧义。
