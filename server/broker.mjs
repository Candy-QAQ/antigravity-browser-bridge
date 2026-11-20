import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_ROOT,
  createLogger,
  createPipeReader,
  ensureAuthToken,
  getPipePath,
  verifyToken,
  writePipeMessage,
} from './protocol.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const log = createLogger(path.join(__dirname, 'broker.log'));

const pipePath = getPipePath();
const authToken = ensureAuthToken();
const idleMs = Math.max(1000, Number(process.env.BRIDGE_IDLE_MS || 60000));
const skillsDir = process.env.BRIDGE_SKILLS_DIR || path.join(PLUGIN_ROOT, 'skills');
const syncSkillsEnabled = process.env.BRIDGE_SYNC_SKILLS !== '0';
const MAX_GLOBAL_SYNCED_TABS = 12;

/** @type {Map<string, { socket: net.Socket, browserId: string, browserName: string, extensionVersion: string, connectedAt: number, paused: boolean, selectedTabIds: number[], attachedTabs: number[], lastSeenAt: number }>} */
const browsers = new Map();
/** @type {Set<net.Socket>} */
const mcpClients = new Set();
/** @type {Map<string, { resolve: (res: any) => void, timer: NodeJS.Timeout, browserId: string }>} */
const pending = new Map();

let lastActivityAt = Date.now();
let shuttingDown = false;

function touchActivity() {
  lastActivityAt = Date.now();
}

function summarizeBrowser(entry) {
  return {
    browserId: entry.browserId,
    browserName: entry.browserName,
    extensionVersion: entry.extensionVersion,
    connectedAt: entry.connectedAt,
    paused: entry.paused,
    selectedTabIds: entry.selectedTabIds,
    attachedTabs: entry.attachedTabs,
  };
}

function sendBrowserRequest(entry, action, params, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!entry || entry.socket.destroyed || !entry.socket.writable) {
      resolve({ ok: false, error: 'BROWSER_DISCONNECTED', message: '浏览器连接已断开' });
      return;
    }
    const reqId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({
        ok: false,
        error: 'TIMEOUT',
        message: `浏览器执行操作 "${action}" 超时 (${timeoutMs}ms)`,
      });
    }, timeoutMs);

    pending.set(reqId, {
      browserId: entry.browserId,
      timer,
      resolve,
    });

    const sent = writePipeMessage(entry.socket, {
      type: 'request',
      reqId,
      action,
      params: params ?? {},
    });
    if (!sent && entry.socket.destroyed) {
      clearTimeout(timer);
      pending.delete(reqId);
      resolve({ ok: false, error: 'BROWSER_DISCONNECTED', message: '写入浏览器管道失败' });
    }
  });
}

async function resolveTargetBrowser(browserId, params) {
  if (browsers.size === 0) {
    return { error: 'NO_BROWSER_CONNECTED', message: '当前没有已连接的浏览器扩展。' };
  }

  if (browserId) {
    const direct = browsers.get(browserId);
    if (direct) return { entry: direct };
    const byName = Array.from(browsers.values()).find(
      (b) => b.browserName.toLowerCase() === String(browserId).toLowerCase()
    );
    if (byName) return { entry: byName };
    return { error: 'BROWSER_NOT_FOUND', message: `未找到浏览器: ${browserId}` };
  }

  if (params?.browser) {
    const byParamName = Array.from(browsers.values()).find(
      (b) => b.browserName.toLowerCase() === String(params.browser).toLowerCase()
    );
    if (byParamName) return { entry: byParamName };
  }

  if (browsers.size === 1) {
    return { entry: Array.from(browsers.values())[0] };
  }

  // Multiple browsers connected: query tabs to match tabId or pick active/selected browser
  const entries = Array.from(browsers.values());
  const snapshots = await Promise.all(
    entries.map(async (entry) => {
      const res = await sendBrowserRequest(entry, 'list_tabs', {}, 4000);
      return {
        entry,
        tabs: res.ok && Array.isArray(res.data?.tabs) ? res.data.tabs : [],
      };
    })
  );

  if (params?.tabId !== undefined && params?.tabId !== null) {
    const targetTabId = Number(params.tabId);
    const matching = [];
    for (const snap of snapshots) {
      const tab = snap.tabs.find((t) => t.tabId === targetTabId);
      if (tab) matching.push({ entry: snap.entry, tab });
    }
    if (matching.length === 1) {
      return { entry: matching[0].entry };
    }
    if (matching.length > 1) {
      matching.sort((a, b) => scoreTabPriority(b.tab, b.entry) - scoreTabPriority(a.tab, a.entry));
      return { entry: matching[0].entry };
    }
    return { error: 'TAB_NOT_FOUND', message: `在任何已连接浏览器中均未找到 tabId=${targetTabId}` };
  }

  // Prefer non-paused browser with selected tabs, else focused window active tab, else active tab
  const scored = snapshots.map(({ entry, tabs }) => {
    let score = entry.paused ? -1000 : 0;
    if (entry.selectedTabIds.length > 0) score += 500;
    const activeFocused = tabs.find((t) => t.active && t.windowFocused);
    if (activeFocused) score += 300;
    else if (tabs.some((t) => t.active)) score += 100;
    score += Math.min(99, Math.floor((entry.connectedAt || 0) / 1e11));
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return { entry: scored[0].entry };
}

function scoreTabPriority(tab, entry) {
  let s = entry.paused ? -1000 : 0;
  if (tab.selected) s += 500;
  if (tab.active && tab.windowFocused) s += 300;
  else if (tab.active) s += 100;
  return s;
}

function sanitizeTabSkillBase(tab) {
  const raw = String(tab.title || tab.domain || `tab-${tab.tabId}`);
  const cleaned = raw
    .replace(/[\s/\\:*?"<>|[\](){}#@!~`'"，。、《》【】（）·—&%$+=^,;]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = cleaned.slice(0, 20).replace(/-+$/g, '');
  return trimmed || `tab-${tab.tabId}`;
}

function buildTabSkillMarkdown(skillName, tab) {
  const flagPrefix = tab.selected ? '★已选定 ' : (tab.active ? '▶当前页 ' : '');
  const cleanTitle = String(tab.title || '(无标题)').replace(/[\r\n]+/g, ' ').trim();
  const cleanUrl = String(tab.url || '').replace(/[\r\n]+/g, '').trim();
  const cleanBrowser = String(tab.browser || 'Chrome').replace(/[\r\n]+/g, ' ').trim();
  const sourceText = String(tab.domain || cleanUrl || '').replace(/[\r\n]+/g, ' ').trim();
  const desc = `${flagPrefix}[${cleanBrowser}] ${cleanTitle}${sourceText ? ` — ${sourceText}` : ''}`.slice(0, 130);

  return [
    '---',
    `name: ${JSON.stringify(skillName)}`,
    `description: ${JSON.stringify(desc)}`,
    '---',
    '',
    '# 目标浏览器标签页',
    '',
    `- 标题: ${cleanTitle}`,
    `- 浏览器: \`${cleanBrowser}\` (\`browserId: ${JSON.stringify(tab.browserId)}\`)`,
    `- Tab ID: \`${tab.tabId}\``,
    `- URL: ${cleanUrl}`,
    '',
    '## 执行指令',
    '',
    `用户已通过 \`/\` 菜单直接选定了此标签页。请立即调用 \`browser-bridge\` MCP 工具读取或操作此标签页（参数：\`tabId: ${tab.tabId}\`, \`browserId: ${JSON.stringify(tab.browserId)}\`）：`,
    '- 默认优先调用 `read_page_content`（纯只读、不弹出调试横幅）读取网页内容，并结合用户的具体问题总结或回答。',
    '- 如用户要求截图、页面交互或调试报错/网络请求，则调用对应的 `take_screenshot`、`get_page_snapshot`、`click_element`、`fill_element`、`get_console_logs` 或 `get_network_requests`。',
    '- 若该标签页已关闭，再调用 `list_tabs` 查看最新标签页列表并告知用户。',
    '',
  ].join('\n');
}

function syncTabSkillsToDisk() {
  if (!syncSkillsEnabled) return;
  try {
    fs.mkdirSync(skillsDir, { recursive: true });

    const allTabs = [];
    for (const entry of browsers.values()) {
      if (entry.paused || !Array.isArray(entry.syncedTabs)) continue;
      for (const tab of entry.syncedTabs) {
        if (!tab || tab.tabId === undefined || tab.tabId === null) continue;
        allTabs.push({
          ...tab,
          browserId: tab.browserId || entry.browserId,
          browser: tab.browser || entry.browserName || 'Chrome',
        });
      }
    }

    allTabs.sort((a, b) => {
      if (Boolean(a.selected) !== Boolean(b.selected)) return a.selected ? -1 : 1;
      const af = Boolean(a.active && a.windowFocused);
      const bf = Boolean(b.active && b.windowFocused);
      if (af !== bf) return af ? -1 : 1;
      if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });

    const selectedSlice = allTabs.slice(0, MAX_GLOBAL_SYNCED_TABS);
    const usedNames = new Set();
    const desired = new Map();

    for (const tab of selectedSlice) {
      const base = sanitizeTabSkillBase(tab);
      let skillName = `标签-${base}`;
      let suffix = 2;
      while (usedNames.has(skillName)) {
        skillName = `标签-${base.slice(0, 17)}-${suffix}`;
        suffix += 1;
      }
      usedNames.add(skillName);

      const safeBrowserId = String(tab.browserId || 'browser').replace(/[^a-zA-Z0-9_-]/g, '_');
      const dirName = `_tab-${safeBrowserId}-${tab.tabId}`;
      desired.set(dirName, buildTabSkillMarkdown(skillName, tab));
    }

    const existingEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const dirent of existingEntries) {
      if (!dirent.name.startsWith('_tab-')) continue;
      if (!desired.has(dirent.name)) {
        fs.rmSync(path.join(skillsDir, dirent.name), { recursive: true, force: true });
      }
    }

    for (const [dirName, content] of desired.entries()) {
      const targetDir = path.join(skillsDir, dirName);
      const skillPath = path.join(targetDir, 'SKILL.md');
      let existingContent = null;
      try {
        existingContent = fs.readFileSync(skillPath, 'utf8');
      } catch {
        // does not exist yet
      }
      if (existingContent !== content) {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(skillPath, content, 'utf8');
      }
    }
  } catch (err) {
    log('warn', 'Failed syncing tab skills to disk', { error: err?.message });
  }
}

const server = net.createServer((socket) => {
  touchActivity();
  let role = null;
  let browserId = null;

  const authTimer = setTimeout(() => {
    if (!role) {
      log('warn', 'Closing unauthenticated pipe connection after handshake timeout');
      socket.destroy();
    }
  }, 10000);

  createPipeReader(
    socket,
    async (msg) => {
      touchActivity();
      if (!msg || typeof msg !== 'object') return;

      if (!role) {
        if (msg.type !== 'hello' || !verifyToken(msg.token, authToken)) {
          log('warn', 'Rejected unauthorized pipe client', { type: msg.type });
          writePipeMessage(socket, { type: 'hello_ack', ok: false, error: 'UNAUTHORIZED' });
          socket.destroy();
          return;
        }
        clearTimeout(authTimer);

        if (msg.role === 'browser') {
          role = 'browser';
          browserId = String(msg.browserId || crypto.randomUUID());
          const prev = browsers.get(browserId);
          if (prev && prev.socket !== socket && !prev.socket.destroyed) {
            log('info', 'Replacing stale browser socket', { browserId });
            prev.socket.destroy();
          }
          const entry = {
            socket,
            browserId,
            browserName: String(msg.browserName || 'Chrome'),
            extensionVersion: String(msg.extensionVersion || '1.0.0'),
            connectedAt: Date.now(),
            lastSeenAt: Date.now(),
            paused: Boolean(msg.paused),
            selectedTabIds: Array.isArray(msg.selectedTabIds) ? msg.selectedTabIds : [],
            attachedTabs: Array.isArray(msg.attachedTabs) ? msg.attachedTabs : [],
            syncedTabs: [],
          };
          browsers.set(browserId, entry);
          writePipeMessage(socket, { type: 'hello_ack', ok: true, browserId });
          log('info', 'Browser connected', summarizeBrowser(entry));
          syncTabSkillsToDisk();
          return;
        }

        if (msg.role === 'mcp') {
          role = 'mcp';
          mcpClients.add(socket);
          writePipeMessage(socket, { type: 'hello_ack', ok: true });
          log('info', 'MCP client connected', { totalMcp: mcpClients.size });
          return;
        }

        writePipeMessage(socket, { type: 'hello_ack', ok: false, error: 'INVALID_ROLE' });
        socket.destroy();
        return;
      }

      if (role === 'browser') {
        const entry = browsers.get(browserId);
        if (entry) entry.lastSeenAt = Date.now();

        if (msg.type === 'ping') {
          writePipeMessage(socket, { type: 'pong', ts: Date.now() });
          return;
        }
        if (msg.type === 'status_update' && entry) {
          const prevPaused = entry.paused;
          if (msg.browserName !== undefined) entry.browserName = String(msg.browserName);
          if (msg.paused !== undefined) entry.paused = Boolean(msg.paused);
          if (Array.isArray(msg.selectedTabIds)) entry.selectedTabIds = msg.selectedTabIds;
          if (Array.isArray(msg.attachedTabs)) entry.attachedTabs = msg.attachedTabs;
          if (prevPaused !== entry.paused) {
            syncTabSkillsToDisk();
          }
          return;
        }
        if (msg.type === 'tabs_sync' && entry) {
          entry.syncedTabs = Array.isArray(msg.tabs) ? msg.tabs : [];
          syncTabSkillsToDisk();
          return;
        }
        if (msg.type === 'response' && msg.reqId) {
          const item = pending.get(msg.reqId);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(msg.reqId);
            item.resolve({
              ok: Boolean(msg.ok),
              data: msg.data,
              error: msg.error,
              message: msg.message,
            });
          }
          return;
        }
        return;
      }

      if (role === 'mcp') {
        if (msg.type === 'ping') {
          writePipeMessage(socket, { type: 'pong', ts: Date.now() });
          return;
        }
        if (msg.type !== 'mcp_request' || !msg.reqId) {
          return;
        }

        const { reqId, kind, browserId: targetBrowserId, action, params, timeoutMs } = msg;

        if (kind === 'broker_status') {
          writePipeMessage(socket, {
            type: 'mcp_response',
            reqId,
            ok: true,
            data: {
              pipePath,
              pid: process.pid,
              browserCount: browsers.size,
              browsers: Array.from(browsers.values()).map(summarizeBrowser),
            },
          });
          return;
        }

        if (kind === 'broadcast_request') {
          const entries = Array.from(browsers.values());
          if (entries.length === 0) {
            writePipeMessage(socket, {
              type: 'mcp_response',
              reqId,
              ok: true,
              data: { results: [], browserCount: 0 },
            });
            return;
          }
          const results = await Promise.all(
            entries.map(async (entry) => {
              const res = await sendBrowserRequest(entry, action, params, timeoutMs || 8000);
              return {
                browserId: entry.browserId,
                browserName: entry.browserName,
                paused: entry.paused,
                ok: res.ok,
                data: res.data,
                error: res.error,
                message: res.message,
              };
            })
          );
          writePipeMessage(socket, {
            type: 'mcp_response',
            reqId,
            ok: true,
            data: { results, browserCount: entries.length },
          });
          return;
        }

        if (kind === 'target_request') {
          const resolved = await resolveTargetBrowser(targetBrowserId, params);
          if (resolved.error) {
            writePipeMessage(socket, {
              type: 'mcp_response',
              reqId,
              ok: false,
              error: resolved.error,
              message: resolved.message,
            });
            return;
          }
          const res = await sendBrowserRequest(resolved.entry, action, params, timeoutMs || 20000);
          writePipeMessage(socket, {
            type: 'mcp_response',
            reqId,
            ok: res.ok,
            browserId: resolved.entry.browserId,
            browserName: resolved.entry.browserName,
            data: res.data,
            error: res.error,
            message: res.message,
          });
        }
      }
    },
    (err) => {
      log('warn', 'Pipe JSON parse error', { role, error: err?.message });
    }
  );

  socket.on('close', () => {
    clearTimeout(authTimer);
    touchActivity();
    if (role === 'browser' && browserId) {
      const current = browsers.get(browserId);
      if (current && current.socket === socket) {
        browsers.delete(browserId);
        log('info', 'Browser disconnected', { browserId, browserName: current.browserName });
        syncTabSkillsToDisk();
        for (const [reqId, item] of pending.entries()) {
          if (item.browserId === browserId) {
            clearTimeout(item.timer);
            pending.delete(reqId);
            item.resolve({
              ok: false,
              error: 'BROWSER_DISCONNECTED',
              message: '浏览器在请求完成前断开了连接',
            });
          }
        }
      }
    } else if (role === 'mcp') {
      mcpClients.delete(socket);
      log('info', 'MCP client disconnected', { totalMcp: mcpClients.size });
    }
  });

  socket.on('error', (err) => {
    log('warn', 'Pipe socket error', { role, browserId, error: err?.message });
  });
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    log('info', 'Broker pipe already active, exiting cleanly', { pipePath });
    process.exit(0);
  }
  log('error', 'Broker server error', { error: err?.message });
  process.exit(1);
});

server.listen(pipePath, () => {
  log('info', 'Broker listening on pipe', { pipePath, pid: process.pid, idleMs });
});

const checkIntervalMs = Math.min(15000, Math.max(500, Math.floor(idleMs / 3)));
const idleTimer = setInterval(() => {
  if (shuttingDown) return;
  if (browsers.size === 0 && mcpClients.size === 0 && Date.now() - lastActivityAt >= idleMs) {
    shuttingDown = true;
    log('info', 'Idle timeout reached with no clients, shutting down');
    clearInterval(idleTimer);
    browsers.clear();
    syncTabSkillsToDisk();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }
}, checkIntervalMs);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(idleTimer);
  for (const b of browsers.values()) b.socket.destroy();
  browsers.clear();
  syncTabSkillsToDisk();
  for (const m of mcpClients) m.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
