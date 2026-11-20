import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  EXTENSION_ID,
  PLUGIN_ROOT,
  createLogger,
  createPipeReader,
  ensureAuthToken,
  getPipePath,
  spawnBrokerIfNeeded,
  writePipeMessage,
} from './protocol.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const brokerScriptPath = path.join(__dirname, 'broker.mjs');
const log = createLogger(path.join(__dirname, 'mcp-server.log'));

const SERVER_INFO = { name: 'browser-bridge', version: '1.0.0' };
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

// ---------------- Broker Pipe Client ----------------

class BrokerClient {
  constructor() {
    this.socket = null;
    this.authed = false;
    this.connectPromise = null;
    this.pending = new Map();
  }

  async ensureConnected() {
    if (this.socket && !this.socket.destroyed && this.authed) {
      return this.socket;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this._connectWithRetry().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async _connectWithRetry() {
    let spawned = false;
    let lastErr = null;
    const backoff = [45, 80, 130, 180, 240];
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        return await this._connectOnce();
      } catch (err) {
        lastErr = err;
        const code = err?.code || '';
        if ((code === 'ENOENT' || code === 'ECONNREFUSED') && !spawned) {
          spawned = true;
          spawnBrokerIfNeeded(brokerScriptPath, log);
        }
        await delay(backoff[attempt] ?? 260);
      }
    }
    throw lastErr || new Error('无法连接到 Browser Bridge Broker 管道');
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const pipePath = getPipePath();
      const token = ensureAuthToken();
      const sock = net.createConnection(pipePath);
      sock.setNoDelay?.(true);
      let settled = false;

      const fail = (err) => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(err);
        }
      };

      const timeout = setTimeout(() => {
        fail(new Error('Broker 管道握手超时'));
      }, 4000);

      sock.on('connect', () => {
        writePipeMessage(sock, {
          type: 'hello',
          role: 'mcp',
          token,
        });
      });

      createPipeReader(
        sock,
        (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (!settled && msg.type === 'hello_ack') {
            clearTimeout(timeout);
            if (!msg.ok) {
              fail(new Error(`Broker 鉴权失败: ${msg.error || 'UNKNOWN'}`));
              return;
            }
            settled = true;
            this.socket = sock;
            this.authed = true;
            resolve(sock);
            return;
          }
          if (msg.type === 'mcp_response' && msg.reqId) {
            const item = this.pending.get(msg.reqId);
            if (item) {
              clearTimeout(item.timer);
              this.pending.delete(msg.reqId);
              item.resolve(msg);
            }
          }
        },
        (err) => {
          log('warn', 'Broker pipe JSON parse error', { error: err?.message });
        }
      );

      sock.on('error', (err) => {
        clearTimeout(timeout);
        if (!settled) {
          fail(err);
        } else {
          log('warn', 'Broker socket error', { error: err?.message });
        }
      });

      sock.on('close', () => {
        clearTimeout(timeout);
        if (this.socket === sock) {
          this.socket = null;
          this.authed = false;
        }
        for (const [reqId, item] of this.pending.entries()) {
          clearTimeout(item.timer);
          this.pending.delete(reqId);
          item.reject(new Error('Broker 连接意外关闭'));
        }
      });
    });
  }

  async request(payload, timeoutMs = 20000) {
    const sock = await this.ensureConnected();
    const reqId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`请求超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      const ok = writePipeMessage(sock, {
        type: 'mcp_request',
        reqId,
        timeoutMs,
        ...payload,
      });
      if (!ok && sock.destroyed) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new Error('写入 Broker 管道失败'));
      }
    });
  }
}

const broker = new BrokerClient();

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function noBrowserGuideText() {
  const extDir = path.join(PLUGIN_ROOT, 'extension');
  return [
    '当前未检测到已连接的日常浏览器扩展。请按以下步骤连接（仅需一次）：',
    '1. 打开你的日常 Chrome（地址栏输入 `chrome://extensions`）或 Edge（`edge://extensions`）。',
    '2. 打开右上角「开发者模式」开关。',
    `3. 点击「加载未打包的扩展程序」，选择目录：\`${extDir}\``,
    `4. 确认扩展 ID 为 \`${EXTENSION_ID}\`，点击工具栏 Gemini 图标确认状态为「已连接」。`,
    '   （如果之前已安装但未连接，可在扩展弹窗点击「重连」或刷新扩展，再确认已运行注册表脚本 `native-host\\register.ps1`。）',
  ].join('\n');
}

function formatErrorResult(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function formatJsonTextResult(text) {
  return {
    content: [{ type: 'text', text }],
  };
}

// ---------------- Tool Definitions (18 Tools) ----------------

const TOOLS = [
  {
    name: 'bridge_status',
    description: '查看 Antigravity Browser Bridge 连接状态、已连接的日常浏览器（Chrome/Edge）、用户在扩展弹窗中选定的目标标签页以及当前附着调试器的标签页。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_tabs',
    description: '列出所有已连接日常浏览器（Chrome/Edge）中当前打开的全部标签页（包含标题、URL、来源浏览器、是否激活、是否被用户在弹窗中选定、标签页组和调试状态）。',
    inputSchema: {
      type: 'object',
      properties: {
        browser: { type: 'string', description: '可选，按浏览器名称筛选（如 "Chrome" 或 "Edge"）。' },
        query: { type: 'string', description: '可选，按标题或 URL 关键字过滤（不区分大小写）。' },
        activeOnly: { type: 'boolean', description: '是否只返回各窗口当前激活的标签页。' },
        selectedOnly: { type: 'boolean', description: '是否只返回用户在扩展弹窗中手动选定的标签页。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_active_tab',
    description: '获取当前正在浏览的活动标签页（同时返回用户在扩展弹窗中选定的目标标签页）。',
    inputSchema: {
      type: 'object',
      properties: {
        browser: { type: 'string', description: '可选，指定浏览器名称（如 "Chrome" 或 "Edge"）。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_page_content',
    description: '纯只读提取网页标题、URL、正文文本与主要链接（使用 chrome.scripting，不触发黄色调试器横幅）。未传 tabId 时优先读取用户在扩展中选定的标签页，否则读取当前活动页。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID（可先通过 list_tabs 获取）。' },
        browserId: { type: 'string', description: '可选，多浏览器同时连接时用于指定所属 browserId。' },
        maxLength: { type: 'integer', description: '正文最大字符数，默认 15000。' },
        includeLinks: { type: 'boolean', description: '是否包含页面主要链接列表，默认 true。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_page_snapshot',
    description: '获取页面结构化摘要及所有可见可交互元素列表，并为每个元素分配临时引用编号（e1, e2...）以便后续 click_element 或 fill_element 操作。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        maxElements: { type: 'integer', description: '最多返回的可交互元素数量，默认 120。' },
        maxTextLength: { type: 'integer', description: '页面文本摘要最大长度，默认 6000。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'switch_tab',
    description: '切换到指定标签页并将其所在浏览器窗口置前。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '要切换到的标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'open_tab',
    description: '在日常浏览器中打开一个新的标签页并访问指定 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整 URL。' },
        active: { type: 'boolean', description: '打开后是否立即激活该标签页，默认 true。' },
        browserId: { type: 'string', description: '可选，指定在哪个浏览器打开（browserId 或 Chrome/Edge）。' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'close_tab',
    description: '关闭指定的浏览器标签页。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '要关闭的标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'navigate_tab',
    description: '控制标签页导航：跳转到 URL、后退、前进或刷新（可选导航完成后立即带回页面快照或正文）。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        action: {
          type: 'string',
          enum: ['goto', 'back', 'forward', 'reload'],
          description: '导航动作，默认 goto。',
        },
        url: { type: 'string', description: '当 action 为 goto 时的目标 URL。' },
        includeSnapshot: { type: 'boolean', description: '导航后是否直接附带最新页面元素快照，默认 false。' },
        includeContent: { type: 'boolean', description: '导航后是否直接附带页面正文内容，默认 false。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'click_element',
    description: '点击页面上的元素（支持 ref、selector、可见文本 text 或坐标 x/y，自动穿透 Shadow DOM、同源及跨域子域名 iframe）。带 Gemini 虚拟鼠标并行动画，点击后自动检测新开标签页，可选直接附带点击后的页面快照或正文以省去下一轮查询。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        ref: { type: 'string', description: 'get_page_snapshot 分配的元素引用（如 "e3" 或子帧 "f14_e2"）。' },
        selector: { type: 'string', description: 'CSS 选择器。' },
        text: { type: 'string', description: '可选，按元素可见文本 / aria-label / title 模糊或精确匹配目标。' },
        x: { type: 'number', description: '视口 X 坐标。' },
        y: { type: 'number', description: '视口 Y 坐标。' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键，默认 left。' },
        doubleClick: { type: 'boolean', description: '是否双击，默认 false。' },
        waitAfterMs: { type: 'integer', description: '点击后等待检测新标签页或跳转的时间（毫秒），默认 100。' },
        includeSnapshot: { type: 'boolean', description: '点击后是否直接附带最新页面元素快照，默认 false。' },
        includeContent: { type: 'boolean', description: '点击后是否直接附带页面正文内容，默认 false。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'fill_element',
    description: '向输入框或可编辑元素填入文本（自动穿透 Shadow DOM 与同源 iframe，兼容 React/Vue/contenteditable 与原生输入框）。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        ref: { type: 'string', description: 'get_page_snapshot 分配的元素引用（如 "e5"）。' },
        selector: { type: 'string', description: 'CSS 选择器。' },
        text: { type: 'string', description: '可选，按 placeholder / aria-label / label 文本定位输入框。' },
        value: { type: 'string', description: '要输入的文本内容。' },
        clear: { type: 'boolean', description: '输入前是否清空原有内容，默认 true。' },
        pressEnter: { type: 'boolean', description: '输入后是否发送 Enter 键，默认 false。' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'press_key',
    description: '向目标标签页发送键盘按键或组合键（如 "Enter"、"Escape"、"Tab"、"Control+a"）。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        key: { type: 'string', description: '按键名或组合键，如 "Enter"、"Escape"、"Control+a"。' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'scroll_page',
    description: '滚动网页或将指定 ref 元素滚动到可视区域内。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: '滚动方向。' },
        amount: { type: 'integer', description: '当 direction 为 down/up 时的像素距离，默认 600。' },
        ref: { type: 'string', description: '可选，直接把该 ref 元素滚动到视野中。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'take_screenshot',
    description: '截取浏览器标签页画面。对当前窗口可见区域优先无横幅截图；整页截图或非激活页自动使用 CDP 截图。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        fullPage: { type: 'boolean', description: '是否截取整个可滚动页面，默认 false。' },
        format: { type: 'string', enum: ['jpeg', 'png'], description: '图片格式，默认 jpeg。' },
        quality: { type: 'integer', description: 'JPEG 质量 (1-100)，默认 80。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'evaluate_script',
    description: '通过 chrome.debugger (Runtime.evaluate) 在目标标签页上下文执行 JavaScript 表达式并返回序列化结果。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        expression: { type: 'string', description: '要执行的 JavaScript 代码或表达式。' },
        awaitPromise: { type: 'boolean', description: '如果返回 Promise 是否等待其解析，默认 true。' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'get_console_logs',
    description: '读取目标标签页缓存的控制台日志（首次调用会自动启用调试器监听）。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        clear: { type: 'boolean', description: '读取后是否清空缓存，默认 false。' },
        limit: { type: 'integer', description: '最多返回条数，默认 50。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_network_requests',
    description: '读取目标标签页缓存的网络请求记录（首次调用会自动启用 Network 调试监听）。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        clear: { type: 'boolean', description: '读取后是否清空缓存，默认 false。' },
        limit: { type: 'integer', description: '最多返回条数，默认 50。' },
        filter: { type: 'string', description: '可选，按 URL 子串过滤。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'detach_debugger',
    description: '分离指定标签页或全部标签页上的 chrome.debugger，立即关闭浏览器顶部的黄色调试横幅并隐藏虚拟鼠标。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，不传则分离全部已附着标签页。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'wait_for',
    description: '等待页面中出现指定的 CSS 选择器或可见文本元素（自动穿透 Shadow DOM 和同源 iframe），适合在点击后等待弹窗或异步内容加载完成。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        selector: { type: 'string', description: '等待出现的 CSS 选择器。' },
        text: { type: 'string', description: '等待出现的可见文本（与 selector 至少传一个）。' },
        timeoutMs: { type: 'integer', description: '超时时间（毫秒，200-20000），默认 8000。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run_steps',
    description: '在浏览器端一次连续执行多个交互步骤（click / fill / press_key / scroll / wait / wait_for / navigate / snapshot），大幅减少大模型往返次数，速度提升 3~5 倍。支持 click 步骤设置 switchToNewTab: true 自动追踪新开标签页，支持 detachWhenDone: true 完成后自动清理调试条。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '可选，起始目标标签页 ID。' },
        browserId: { type: 'string', description: '可选，所属 browserId。' },
        stopOnError: { type: 'boolean', description: '某一步失败时是否立即中止，默认 true。' },
        detachWhenDone: { type: 'boolean', description: '整批步骤完成后是否自动分离本次涉及标签页的调试器并隐藏虚拟鼠标，默认 false。' },
        includeSnapshot: { type: 'boolean', description: '全部步骤完成后是否直接附带最终页面的元素快照，默认 false。' },
        includeContent: { type: 'boolean', description: '全部步骤完成后是否直接附带最终页面的正文内容，默认 false。' },
        steps: {
          type: 'array',
          description: '按顺序执行的步骤列表（1～20 步）。',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['click', 'fill', 'press_key', 'scroll', 'wait', 'wait_for', 'navigate', 'snapshot'],
                description: '步骤动作类型。',
              },
              tabId: { type: 'integer', description: '可选，覆盖本步骤目标 tabId。' },
              ref: { type: 'string' },
              selector: { type: 'string' },
              text: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              button: { type: 'string', enum: ['left', 'right', 'middle'] },
              doubleClick: { type: 'boolean' },
              waitAfterMs: { type: 'integer' },
              switchToNewTab: { type: 'boolean', description: '仅 click 有效：为 true 且打开了新标签页时，后续步骤自动切换到该新标签页并等待加载完成。' },
              value: { type: 'string', description: 'fill 步骤要输入的文本。' },
              clear: { type: 'boolean' },
              pressEnter: { type: 'boolean' },
              key: { type: 'string', description: 'press_key 步骤的按键（如 Enter）。' },
              direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] },
              amount: { type: 'integer' },
              ms: { type: 'integer', description: 'wait 步骤等待毫秒数。' },
              timeoutMs: { type: 'integer', description: 'wait_for 步骤超时毫秒数。' },
              navAction: { type: 'string', enum: ['goto', 'back', 'forward', 'reload'] },
              url: { type: 'string' },
            },
            required: ['action'],
            additionalProperties: true,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

// ---------------- Formatting Helpers ----------------

function sortTabs(tabs) {
  return [...tabs].sort((a, b) => {
    if (Boolean(a.selected) !== Boolean(b.selected)) return a.selected ? -1 : 1;
    const af = Boolean(a.active && a.windowFocused);
    const bf = Boolean(b.active && b.windowFocused);
    if (af !== bf) return af ? -1 : 1;
    if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
    const brCmp = String(a.browser || '').localeCompare(String(b.browser || ''));
    if (brCmp !== 0) return brCmp;
    if ((a.windowId || 0) !== (b.windowId || 0)) return (a.windowId || 0) - (b.windowId || 0);
    return (a.index || 0) - (b.index || 0);
  });
}

function formatTabLine(t) {
  const flags = [];
  if (t.selected) flags.push('★ 已选定');
  if (t.active) flags.push(t.windowFocused ? '▶ 当前焦点页' : '▶ 窗口当前页');
  if (t.debuggerAttached) flags.push('🔧 调试中');
  if (t.pinned) flags.push('📌 固定');
  if (t.groupTitle) flags.push(`分组:${t.groupTitle}`);
  const flagStr = flags.length > 0 ? ` [${flags.join(' | ')}]` : '';
  return `- **${t.title || '(无标题)'}**${flagStr}\n  - 浏览器: \`${t.browser}\` (browserId: \`${t.browserId}\`) | \`tabId: ${t.tabId}\`\n  - URL: ${t.url}`;
}

async function fetchAllTabs(filters = {}) {
  const resp = await broker.request({
    kind: 'broadcast_request',
    action: 'list_tabs',
    params: filters,
    timeoutMs: 8000,
  });

  const data = resp?.data || { results: [], browserCount: 0 };
  if (!data.browserCount) {
    return { browserCount: 0, tabs: [], errors: [] };
  }

  const tabs = [];
  const errors = [];
  for (const r of data.results || []) {
    if (r.ok && Array.isArray(r.data?.tabs)) {
      for (const t of r.data.tabs) {
        tabs.push(t);
      }
    } else if (!r.ok) {
      errors.push(`${r.browserName || r.browserId}: ${r.message || r.error}`);
    }
  }
  return { browserCount: data.browserCount, tabs: sortTabs(tabs), errors };
}

// ---------------- Tool Execution ----------------

async function handleToolCall(name, args = {}) {
  if (name === 'bridge_status') {
    const statusRes = await broker.request({ kind: 'broker_status' }, 5000);
    const s = statusRes?.data || {};
    if (!s.browserCount) {
      return formatJsonTextResult(`Broker 运行正常 (PID: ${s.pid}, 管道: \`${s.pipePath}\`)，已连接浏览器数: 0。\n\n${noBrowserGuideText()}`);
    }
    const detailRes = await broker.request({ kind: 'broadcast_request', action: 'bridge_status', params: {}, timeoutMs: 5000 });
    const lines = [
      `Broker 运行正常 (PID: ${s.pid}) | 已连接浏览器: ${s.browserCount} 个`,
      '',
    ];
    for (const item of detailRes?.data?.results || []) {
      const d = item.data || {};
      const stateLabel = d.paused ? '已暂停' : '已连接';
      lines.push(`### ${item.browserName} (\`${item.browserId}\`) — ${stateLabel}`);
      lines.push(`- 扩展版本: ${d.extensionVersion || '1.0.0'} | 扩展 ID: \`${EXTENSION_ID}\``);
      lines.push(`- 打开标签页总数: ${d.tabCount ?? '?'}`);
      lines.push(`- 用户选定目标 tabId: ${d.selectedTabIds?.length ? d.selectedTabIds.join(', ') : '无'}`);
      lines.push(`- 已附着调试器 tabId: ${d.attachedTabs?.length ? d.attachedTabs.join(', ') : '无'}`);
      if (d.activeTab) {
        lines.push(`- 当前激活页: [\`${d.activeTab.tabId}\`] ${d.activeTab.title} (${d.activeTab.url})`);
      }
      lines.push('');
    }
    return formatJsonTextResult(lines.join('\n'));
  }

  if (name === 'list_tabs') {
    const { browserCount, tabs, errors } = await fetchAllTabs(args);
    if (browserCount === 0) {
      return formatErrorResult(noBrowserGuideText());
    }
    if (tabs.length === 0) {
      const errNote = errors.length ? `\n部分浏览器返回异常：\n- ${errors.join('\n- ')}` : '';
      return formatJsonTextResult(`未找到符合条件的打开标签页。${errNote}`);
    }
    const header = `共发现 ${tabs.length} 个标签页（来自 ${browserCount} 个已连接浏览器）：\n`;
    const body = tabs.map(formatTabLine).join('\n');
    const errNote = errors.length ? `\n\n> 部分浏览器异常：${errors.join('; ')}` : '';
    return formatJsonTextResult(`${header}\n${body}${errNote}`);
  }

  if (name === 'get_active_tab') {
    const { browserCount, tabs, errors } = await fetchAllTabs({ browser: args.browser });
    if (browserCount === 0) {
      return formatErrorResult(noBrowserGuideText());
    }
    const selected = tabs.filter((t) => t.selected);
    const actives = tabs.filter((t) => t.active);
    if (selected.length === 0 && actives.length === 0) {
      return formatJsonTextResult('当前未检测到激活或选定的标签页。' + (errors.length ? ` (${errors.join('; ')})` : ''));
    }
    const parts = [];
    if (selected.length > 0) {
      parts.push('### 用户在扩展弹窗中选定的目标标签页：\n' + selected.map(formatTabLine).join('\n'));
    }
    if (actives.length > 0) {
      parts.push('### 当前浏览器活动标签页：\n' + actives.map(formatTabLine).join('\n'));
    }
    return formatJsonTextResult(parts.join('\n\n'));
  }

  if (name === 'detach_debugger' && args.tabId === undefined && !args.browserId) {
    const resp = await broker.request({
      kind: 'broadcast_request',
      action: 'detach_debugger',
      params: {},
      timeoutMs: 8000,
    });
    const data = resp?.data || { results: [], browserCount: 0 };
    if (!data.browserCount) {
      return formatErrorResult(noBrowserGuideText());
    }
    const lines = data.results.map((r) =>
      r.ok ? `- ${r.browserName}: 已分离调试器 (${(r.data?.detachedTabIds || []).join(', ') || '无活跃调试标签页'})`
           : `- ${r.browserName}: 失败 (${r.message || r.error})`
    );
    return formatJsonTextResult(lines.join('\n'));
  }

  // All remaining tools are targeted single-browser requests
  const timeoutMs =
    name === 'run_steps'
      ? 60000
      : name === 'take_screenshot' || name === 'evaluate_script' || name === 'wait_for'
        ? 30000
        : 20000;
  const resp = await broker.request(
    {
      kind: 'target_request',
      browserId: args.browserId,
      action: name,
      params: args,
      timeoutMs,
    },
    timeoutMs + 2000
  );

  if (!resp.ok) {
    if (resp.error === 'NO_BROWSER_CONNECTED') {
      return formatErrorResult(noBrowserGuideText());
    }
    return formatErrorResult(`操作 ${name} 失败: ${resp.message || resp.error || '未知错误'}`);
  }

  const d = resp.data || {};
  if (name === 'take_screenshot' && d.base64) {
    return {
      content: [
        {
          type: 'text',
          text: `截图成功 | 浏览器: ${resp.browserName} | tabId: ${d.tabId} | 标题: ${d.title || ''} | URL: ${d.url || ''} | 方式: ${d.method || 'cdp'}`,
        },
        {
          type: 'image',
          data: d.base64,
          mimeType: d.mimeType || 'image/jpeg',
        },
      ],
    };
  }

  if (name === 'read_page_content') {
    const out = [
      `# ${d.title || '(无标题)'}`,
      `- 浏览器: \`${resp.browserName}\` (browserId: \`${resp.browserId}\`) | \`tabId: ${d.tabId}\``,
      `- URL: ${d.url}`,
    ];
    if (d.description) out.push(`- 摘要: ${d.description}`);
    if (Array.isArray(d.headings) && d.headings.length > 0) {
      out.push(`- 页面标题结构: ${d.headings.join(' | ')}`);
    }
    out.push('', '## 正文内容', d.text || '(页面无可提取正文)');
    if (d.truncated) {
      out.push(`\n_(正文已按 maxLength=${args.maxLength || 15000} 截断，总长度 ${d.totalLength} 字符)_`);
    }
    if (Array.isArray(d.links) && d.links.length > 0) {
      out.push('', '## 主要链接');
      for (const l of d.links) {
        out.push(`- [${l.text || l.href}](${l.href})`);
      }
    }
    return formatJsonTextResult(out.join('\n'));
  }

  if (name === 'get_page_snapshot') {
    const out = [
      `页面快照 | ${resp.browserName} | tabId: ${d.tabId} | ${d.title || ''}`,
      `URL: ${d.url}`,
      '',
      '## 可交互元素 (可用 ref 调用 click_element / fill_element / scroll_page)',
    ];
    if (Array.isArray(d.elements) && d.elements.length > 0) {
      for (const el of d.elements) {
        const val = el.value ? ` value=${JSON.stringify(el.value)}` : '';
        const href = el.href ? ` href=${el.href}` : '';
        const type = el.inputType ? `[${el.inputType}]` : '';
        const state = el.disabled ? ' (disabled)' : '';
        out.push(`- \`${el.ref}\` <${el.tag}>${type} role=${el.role} "${el.label}"${val}${href}${state} @(${el.x},${el.y})`);
      }
    } else {
      out.push('(未检测到可见可交互元素)');
    }
    out.push('', '## 页面文本节选', d.textExcerpt || '(无文本)');
    return formatJsonTextResult(out.join('\n'));
  }

  return formatJsonTextResult(JSON.stringify({ browser: resp.browserName, browserId: resp.browserId, ...d }, null, 2));
}

// ---------------- MCP JSON-RPC Stdio Loop ----------------

function sendJsonRpc(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`, 'utf8');
}

function sendResult(id, result) {
  sendJsonRpc({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  sendJsonRpc({ jsonrpc: '2.0', id, error });
}

async function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  // Notifications have no id (or start with notifications/) -> do not reply
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === 'initialize') {
      const protocolVersion = params?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
      sendResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
      });
      return;
    }

    if (method === 'ping') {
      sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const toolExists = TOOLS.some((t) => t.name === toolName);
      if (!toolExists) {
        sendError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }
      const result = await handleToolCall(toolName, toolArgs);
      sendResult(id, result);
      return;
    }

    if (method === 'resources/list') {
      try {
        const { tabs } = await fetchAllTabs({});
        const resources = tabs.map((t) => ({
          uri: `browser://${t.browserId}/tab/${t.tabId}`,
          name: `[${t.browser}] ${t.title || '(无标题)'}`,
          description: t.url,
          mimeType: 'text/plain',
        }));
        sendResult(id, { resources });
      } catch (err) {
        log('warn', 'resources/list returned empty due to error', { error: err?.message });
        sendResult(id, { resources: [] });
      }
      return;
    }

    if (method === 'resources/read') {
      const uri = String(params?.uri || '');
      const m = uri.match(/^browser:\/\/([^/]+)\/tab\/(\d+)$/);
      if (!m) {
        sendError(id, -32602, `Invalid browser tab resource URI: ${uri}`);
        return;
      }
      const browserId = m[1];
      const tabId = Number(m[2]);
      const resp = await broker.request({
        kind: 'target_request',
        browserId,
        action: 'read_page_content',
        params: { browserId, tabId },
        timeoutMs: 20000,
      });
      if (!resp.ok) {
        sendError(id, -32000, resp.message || resp.error || 'Failed to read browser tab');
        return;
      }
      const d = resp.data || {};
      const text = `标题: ${d.title || ''}\nURL: ${d.url || ''}\n\n${d.text || ''}`;
      sendResult(id, {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text,
          },
        ],
      });
      return;
    }

    if (method === 'prompts/list') {
      sendResult(id, { prompts: [] });
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    log('error', 'Error handling MCP request', { method, error: err?.message, stack: err?.stack });
    if (method === 'tools/call') {
      sendResult(id, formatErrorResult(`执行失败: ${err?.message || String(err)}`));
    } else {
      sendError(id, -32603, err?.message || 'Internal error');
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    log('warn', 'Invalid JSON-RPC line on stdin', { error: err?.message });
    return;
  }
  handleRpcMessage(parsed);
});

rl.on('close', () => {
  log('info', 'MCP stdin closed, exiting');
  process.exit(0);
});

// Pre-warm broker pipe connection on startup so the first tool call has zero handshake latency
broker.ensureConnected().catch(() => {});

log('info', 'MCP server started', { pid: process.pid });
