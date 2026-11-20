const HOST_NAME = 'com.antigravity.browser_bridge';
const EXT_VERSION = chrome.runtime.getManifest().version || '1.0.0';
const MAX_SYNC_TABS = 10;

let port = null;
let connected = false;
let lastError = '';
let browserId = null;
let browserName = detectBrowserName();
let enabled = true;
let virtualCursorEnabled = true;
let slashSyncMode = 'auto'; // 'auto' | 'selected' | 'off'
let selectedTabIds = [];
let reconnectDelayMs = 1000;
let reconnectTimer = null;
let pingTimer = null;
let tabSyncTimer = null;
let lastTabSyncSig = '';

const attachedTabs = new Set();
const tabDomains = new Map(); // tabId -> Set<string>
const tabLogs = new Map(); // tabId -> { console: [], network: [], reqMap: Map }
const lastCursorPosByTab = new Map(); // tabId -> { x: number, y: number }
const recentCreatedTabs = []; // { ts: number, tab: chrome.tabs.Tab }
const chunkAssembler = new Map();

// ---------------- Browser & Storage Helpers ----------------

function detectBrowserName() {
  const brands = navigator.userAgentData?.brands || [];
  const brandStr = brands.map((b) => b.brand).join(' ');
  const ua = navigator.userAgent || '';
  if (/Microsoft Edge/i.test(brandStr) || /\bEdg\//.test(ua)) return 'Edge';
  if (/Brave/i.test(brandStr)) return 'Brave';
  if (/Vivaldi/i.test(ua)) return 'Vivaldi';
  if (/Opera/i.test(brandStr) || /\bOPR\//.test(ua)) return 'Opera';
  return 'Chrome';
}

async function loadState() {
  const local = await chrome.storage.local.get([
    'browserId',
    'bridgeEnabled',
    'virtualCursorEnabled',
    'slashSyncMode',
    'selectedTabIdsFallback',
  ]);
  if (local.browserId) {
    browserId = local.browserId;
  } else {
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    browserId = `${browserName.toLowerCase()}-${rand}`;
    await chrome.storage.local.set({ browserId });
  }
  enabled = local.bridgeEnabled !== false;
  virtualCursorEnabled = local.virtualCursorEnabled !== false;
  slashSyncMode = ['auto', 'selected', 'off'].includes(local.slashSyncMode) ? local.slashSyncMode : 'auto';

  if (chrome.storage.session) {
    const sess = await chrome.storage.session.get(['selectedTabIds']);
    selectedTabIds = Array.isArray(sess.selectedTabIds) ? sess.selectedTabIds : [];
  } else {
    selectedTabIds = Array.isArray(local.selectedTabIdsFallback) ? local.selectedTabIdsFallback : [];
  }
}

async function saveSelectedTabs(ids) {
  selectedTabIds = Array.from(new Set(ids.map((n) => Number(n)).filter(Number.isInteger)));
  if (chrome.storage.session) {
    await chrome.storage.session.set({ selectedTabIds });
  } else {
    await chrome.storage.local.set({ selectedTabIdsFallback: selectedTabIds });
  }
  sendStatusUpdate();
  scheduleTabSync(true);
}

function updateBadge() {
  if (!enabled) {
    chrome.action.setBadgeText({ text: '·' });
    chrome.action.setBadgeBackgroundColor({ color: '#D97706' });
    chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
    chrome.action.setTitle({ title: 'Antigravity Browser Bridge（已暂停）' });
  } else if (connected) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Antigravity Browser Bridge（已连接）' });
  } else {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
    chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
    chrome.action.setTitle({ title: 'Antigravity Browser Bridge（未连接）' });
  }
}

// ---------------- Native Messaging Connection ----------------

function sendNative(msg) {
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch (err) {
    lastError = err?.message || String(err);
    return false;
  }
}

function sendStatusUpdate() {
  if (!connected || !browserId) return;
  sendNative({
    type: 'status_update',
    browserId,
    browserName,
    paused: !enabled,
    selectedTabIds,
    attachedTabs: Array.from(attachedTabs),
  });
}

function handleChunkedFrame(msg) {
  const { chunkId, idx, total, encoding, data } = msg;
  if (!chunkId || !Number.isInteger(idx) || !Number.isInteger(total) || total <= 0) {
    return null;
  }
  let entry = chunkAssembler.get(chunkId);
  if (!entry) {
    entry = { total, parts: new Array(total), received: 0, createdAt: Date.now() };
    chunkAssembler.set(chunkId, entry);
  }
  if (entry.parts[idx] === undefined) {
    entry.parts[idx] = data;
    entry.received += 1;
  }
  if (entry.received < entry.total) {
    return null;
  }
  chunkAssembler.delete(chunkId);
  const joined = entry.parts.join('');
  if (encoding === 'base64') {
    const bin = atob(joined);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(text);
  }
  return JSON.parse(joined);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const wait = reconnectDelayMs;
  reconnectDelayMs = Math.min(30000, Math.round(reconnectDelayMs * 1.8));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, wait);
}

async function connectNative(force = false) {
  await initReady;
  if (port && !force) return;
  if (port && force) {
    try { port.disconnect(); } catch { /* ignore */ }
    port = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    connected = false;
    lastError = err?.message || String(err);
    updateBadge();
    scheduleReconnect();
    return;
  }

  connected = true;
  lastError = '';
  reconnectDelayMs = 1000;
  updateBadge();

  sendNative({
    type: 'hello',
    browserId,
    browserName,
    extensionVersion: EXT_VERSION,
    paused: !enabled,
    selectedTabIds,
    attachedTabs: Array.from(attachedTabs),
  });
  lastTabSyncSig = '';
  scheduleTabSync(true);

  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    sendNative({ type: 'ping', ts: Date.now() });
  }, 25000);

  port.onMessage.addListener(async (rawMsg) => {
    let msg = rawMsg;
    if (msg && msg.__chunked === true) {
      try {
        msg = handleChunkedFrame(msg);
      } catch (err) {
        lastError = `Chunk decode error: ${err?.message}`;
        return;
      }
      if (!msg) return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'pong') return;

    if (msg.type === 'request' && msg.reqId) {
      try {
        const data = await dispatchAction(msg.action, msg.params || {});
        sendNative({ type: 'response', reqId: msg.reqId, ok: true, data });
      } catch (err) {
        sendNative({
          type: 'response',
          reqId: msg.reqId,
          ok: false,
          error: err?.code || 'ACTION_ERROR',
          message: err?.message || String(err),
        });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    const errMsg = chrome.runtime.lastError?.message || '';
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    port = null;
    connected = false;
    lastError = errMsg || 'Native Messaging Host 已断开';
    updateBadge();
    scheduleReconnect();
  });
}

// ---------------- Tab, Scripting & Debugger Helpers ----------------

function isRestrictedUrl(url = '') {
  return /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url) ||
    /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i.test(url);
}

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertNotRestricted(tab) {
  if (isRestrictedUrl(tab?.url || '')) {
    throw makeError(
      'RESTRICTED_URL',
      `该页面属于浏览器受保护页面 (${tab.url})，安全策略禁止注入脚本或附加调试器。`
    );
  }
}

async function resolveTargetTab(params = {}) {
  if (params.tabId !== undefined && params.tabId !== null) {
    try {
      return await chrome.tabs.get(Number(params.tabId));
    } catch {
      throw makeError('TAB_NOT_FOUND', `未找到 tabId=${params.tabId} 对应的标签页（可能已被关闭）`);
    }
  }

  for (const id of selectedTabIds) {
    try {
      return await chrome.tabs.get(id);
    } catch {
      // ignore closed tab
    }
  }

  const focusedActive = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focusedActive.length > 0) return focusedActive[0];

  const anyActive = await chrome.tabs.query({ active: true });
  if (anyActive.length > 0) return anyActive[0];

  const all = await chrome.tabs.query({});
  if (all.length > 0) return all[0];

  throw makeError('NO_TABS', '当前浏览器没有任何打开的标签页');
}

function getTabLogBucket(tabId) {
  let bucket = tabLogs.get(tabId);
  if (!bucket) {
    bucket = { console: [], network: [], reqMap: new Map() };
    tabLogs.set(tabId, bucket);
  }
  return bucket;
}

function pushBounded(arr, item, max = 200) {
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}

async function ensureDebugger(tabId, domains = []) {
  if (!attachedTabs.has(tabId)) {
    const tab = await chrome.tabs.get(tabId);
    assertNotRestricted(tab);
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
    tabDomains.set(tabId, new Set());
    getTabLogBucket(tabId);
    sendStatusUpdate();
  }

  if (domains.length > 0) {
    let enabledSet = tabDomains.get(tabId);
    if (!enabledSet) {
      enabledSet = new Set();
      tabDomains.set(tabId, enabledSet);
    }
    const toEnable = domains.filter((d) => !enabledSet.has(d));
    if (toEnable.length > 0) {
      await Promise.allSettled(
        toEnable.map(async (domain) => {
          await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
          enabledSet.add(domain);
        })
      );
    }
  }
}

function sendCdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;
  const bucket = getTabLogBucket(tabId);

  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type || '')))
      .join(' ');
    pushBounded(bucket.console, {
      ts: new Date().toISOString(),
      source: 'console',
      level: params.type || 'log',
      text,
    });
  } else if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails || {};
    const msg = details.exception?.description || details.text || 'Uncaught exception';
    pushBounded(bucket.console, {
      ts: new Date().toISOString(),
      source: 'exception',
      level: 'error',
      text: msg,
    });
  } else if (method === 'Log.entryAdded') {
    const e = params.entry || {};
    pushBounded(bucket.console, {
      ts: new Date().toISOString(),
      source: e.source || 'browser',
      level: e.level || 'info',
      text: e.text || '',
      url: e.url,
    });
  } else if (method === 'Network.requestWillBeSent') {
    const rec = {
      requestId: params.requestId,
      ts: new Date().toISOString(),
      method: params.request?.method || 'GET',
      url: params.request?.url || '',
      type: params.type || 'Other',
      status: null,
      failed: false,
    };
    bucket.reqMap.set(params.requestId, rec);
    if (bucket.reqMap.size > 400) {
      const oldestKey = bucket.reqMap.keys().next().value;
      bucket.reqMap.delete(oldestKey);
    }
    pushBounded(bucket.network, rec);
  } else if (method === 'Network.responseReceived') {
    const rec = bucket.reqMap.get(params.requestId);
    if (rec) {
      rec.status = params.response?.status ?? null;
      rec.mimeType = params.response?.mimeType;
    }
  } else if (method === 'Network.loadingFailed') {
    const rec = bucket.reqMap.get(params.requestId);
    if (rec) {
      rec.failed = true;
      rec.errorText = params.errorText;
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    tabDomains.delete(source.tabId);
    if (attachedTabs.delete(source.tabId)) {
      sendStatusUpdate();
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  tabDomains.delete(tabId);
  tabLogs.delete(tabId);
  lastCursorPosByTab.delete(tabId);
  if (selectedTabIds.includes(tabId)) {
    saveSelectedTabs(selectedTabIds.filter((id) => id !== tabId));
  }
  scheduleTabSync();
});

chrome.tabs.onCreated.addListener((tab) => {
  recentCreatedTabs.push({ ts: Date.now(), tab });
  if (recentCreatedTabs.length > 25) {
    recentCreatedTabs.shift();
  }
  scheduleTabSync();
});
chrome.tabs.onActivated.addListener(() => scheduleTabSync());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    changeInfo.title !== undefined ||
    changeInfo.url !== undefined ||
    changeInfo.status === 'complete'
  ) {
    scheduleTabSync();
  }
  if (changeInfo.status === 'complete' && attachedTabs.has(tabId) && virtualCursorEnabled) {
    showVirtualCursor(tabId, { type: 'standby', label: '待命中' }).catch(() => {});
  }
});
chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) {
    scheduleTabSync();
  }
});

async function syncTabsToSlashMenu(force = false) {
  await initReady;
  if (!connected || !browserId) return;

  let payloadTabs = [];
  if (enabled && slashSyncMode !== 'off') {
    const allTabs = await queryEnrichedTabs();
    let candidates = allTabs.filter(
      (t) => !isRestrictedUrl(t.url) && /^https?:/i.test(t.url || '')
    );
    if (slashSyncMode === 'selected') {
      candidates = candidates.filter((t) => t.selected);
    }
    candidates.sort((a, b) => {
      if (Boolean(a.selected) !== Boolean(b.selected)) return a.selected ? -1 : 1;
      const af = Boolean(a.active && a.windowFocused);
      const bf = Boolean(b.active && b.windowFocused);
      if (af !== bf) return af ? -1 : 1;
      if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
      if ((a.lastAccessed || 0) !== (b.lastAccessed || 0)) {
        return (b.lastAccessed || 0) - (a.lastAccessed || 0);
      }
      return (a.index || 0) - (b.index || 0);
    });
    payloadTabs = candidates.slice(0, MAX_SYNC_TABS).map((t) => ({
      tabId: t.tabId,
      browser: t.browser,
      browserId: t.browserId,
      title: t.title,
      url: t.url,
      domain: t.domain,
      active: t.active,
      windowFocused: t.windowFocused,
      selected: t.selected,
      lastAccessed: t.lastAccessed,
    }));
  }

  const sig =
    JSON.stringify(
      payloadTabs.map((t) => [t.tabId, t.title, t.url, t.domain, t.active, t.windowFocused, t.selected])
    ) +
    `|${slashSyncMode}|${enabled}`;

  if (!force && sig === lastTabSyncSig) {
    return;
  }
  lastTabSyncSig = sig;
  sendNative({
    type: 'tabs_sync',
    browserId,
    browserName,
    syncMode: slashSyncMode,
    tabs: payloadTabs,
  });
}

function scheduleTabSync(immediate = false) {
  if (tabSyncTimer) {
    clearTimeout(tabSyncTimer);
    tabSyncTimer = null;
  }
  if (immediate) {
    syncTabsToSlashMenu(true).catch(() => {});
    return;
  }
  tabSyncTimer = setTimeout(() => {
    tabSyncTimer = null;
    syncTabsToSlashMenu(false).catch(() => {});
  }, 600);
}

// ---------------- Action Handlers ----------------

async function queryEnrichedTabs() {
  const [tabs, windows] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll({}),
  ]);
  const focusedWinIds = new Set(windows.filter((w) => w.focused).map((w) => w.id));

  const groupMap = new Map();
  if (chrome.tabGroups?.query) {
    try {
      const groups = await chrome.tabGroups.query({});
      for (const g of groups) {
        groupMap.set(g.id, { title: g.title || '', color: g.color || '' });
      }
    } catch {
      // ignore if browser/window lacks tabGroups
    }
  }

  const liveIds = new Set(tabs.map((t) => t.id));
  const prunedSelected = selectedTabIds.filter((id) => liveIds.has(id));
  if (prunedSelected.length !== selectedTabIds.length) {
    await saveSelectedTabs(prunedSelected);
  }
  const selectedSet = new Set(prunedSelected);

  return tabs.map((t) => {
    let domain = '';
    try {
      domain = new URL(t.url || '').hostname;
    } catch {
      domain = '';
    }
    const group = t.groupId >= 0 ? groupMap.get(t.groupId) : null;
    return {
      browser: browserName,
      browserId,
      tabId: t.id,
      windowId: t.windowId,
      index: t.index,
      active: Boolean(t.active),
      windowFocused: focusedWinIds.has(t.windowId),
      pinned: Boolean(t.pinned),
      selected: selectedSet.has(t.id),
      groupTitle: group?.title || '',
      groupColor: group?.color || '',
      title: t.title || '',
      url: t.url || '',
      domain,
      favIconUrl: t.favIconUrl || '',
      status: t.status || '',
      lastAccessed: t.lastAccessed || 0,
      debuggerAttached: attachedTabs.has(t.id),
    };
  });
}

async function runScripting(tabId, func, args = [], frameId = 0) {
  const target = frameId !== undefined && frameId !== null ? { tabId, frameIds: [frameId] } : { tabId };
  const res = await chrome.scripting.executeScript({
    target,
    func,
    args,
  });
  return res?.[0]?.result;
}

async function runAllFramesScripting(tabId, func, args = []) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args,
    });
    return Array.isArray(res) ? res : [];
  } catch {
    const single = await runScripting(tabId, func, args, 0);
    return single ? [{ frameId: 0, result: single }] : [];
  }
}

function resolveChildFrameOffset(topRes, childRes) {
  const list = topRes?.crossOriginIframes || [];
  if (list.length === 0 || !childRes) return { ox: 0, oy: 0 };
  const cUrl = String(childRes.frameUrl || '');
  const cName = String(childRes.frameName || '');
  const cw = Number(childRes.innerWidth || 0);
  const ch = Number(childRes.innerHeight || 0);

  let best =
    list.find((f) => f.src && (f.src === cUrl || cUrl.startsWith(f.src) || f.src.startsWith(cUrl))) ||
    list.find((f) => cName && f.name === cName) ||
    list.find((f) => cw > 0 && ch > 0 && Math.abs(f.width - cw) <= 35 && Math.abs(f.height - ch) <= 35) ||
    list[0];
  return { ox: best?.left || 0, oy: best?.top || 0 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Unified isolated-world DOM + Shadow DOM + same-origin/cross-origin iframe + Virtual Cursor dispatcher
function pageOperation(op, payload = {}) {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');

  let isSameOriginChild = false;
  try {
    isSameOriginChild = window !== window.top && Boolean(window.frameElement && window.top.document);
  } catch {
    isSameOriginChild = false;
  }

  if (payload?.allFramesMode && isSameOriginChild) {
    return { skippedSameOriginChild: true };
  }

  function getShadowRootAny(el) {
    if (!(el instanceof HTMLElement)) return null;
    if (typeof chrome !== 'undefined' && typeof chrome.dom?.openOrClosedShadowRoot === 'function') {
      try {
        return chrome.dom.openOrClosedShadowRoot(el);
      } catch {
        // fallback below
      }
    }
    return el.shadowRoot || null;
  }

  function collectRoots(startDoc = document) {
    const roots = [];
    const docs = [];
    const crossOriginIframes = [];
    const seen = new Set();
    const queue = [{ node: startDoc, doc: startDoc, frameChain: [] }];

    while (queue.length > 0) {
      const item = queue.shift();
      const { node, doc, frameChain } = item;
      if (!node || seen.has(node)) continue;
      seen.add(node);
      roots.push(item);
      if (node === doc && !docs.includes(item)) {
        docs.push(item);
      }
      if (!node.querySelectorAll) continue;
      for (const el of node.querySelectorAll('*')) {
        const sr = getShadowRootAny(el);
        if (sr) {
          queue.push({ node: sr, doc, frameChain });
        }
        if (el.tagName === 'IFRAME') {
          const r = el.getBoundingClientRect();
          if (r.width <= 5 || r.height <= 5) continue;
          let sameOriginDoc = null;
          try {
            sameOriginDoc = el.contentDocument;
          } catch {
            sameOriginDoc = null;
          }
          if (sameOriginDoc && sameOriginDoc.documentElement) {
            queue.push({ node: sameOriginDoc, doc: sameOriginDoc, frameChain: [...frameChain, { el, parentDoc: doc }] });
          } else {
            const { ox, oy } = getFrameOffset(frameChain);
            const cs = (doc.defaultView || window).getComputedStyle(el);
            const bl = parseFloat(cs.borderLeftWidth) || 0;
            const bt = parseFloat(cs.borderTopWidth) || 0;
            const pl = parseFloat(cs.paddingLeft) || 0;
            const pt = parseFloat(cs.paddingTop) || 0;
            crossOriginIframes.push({
              src: el.src || '',
              id: el.id || '',
              name: el.name || '',
              left: Math.round(ox + r.left + bl + pl),
              top: Math.round(oy + r.top + bt + pt),
              width: Math.round(r.width),
              height: Math.round(r.height),
            });
          }
        }
      }
    }
    return { roots, docs, crossOriginIframes };
  }

  function getFrameOffset(frameChain) {
    let ox = 0;
    let oy = 0;
    for (const step of frameChain) {
      const r = step.el.getBoundingClientRect();
      const cs = step.parentDoc.defaultView.getComputedStyle(step.el);
      ox += r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      oy += r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
    }
    return { ox, oy };
  }

  function isVisible(el, doc) {
    const win = doc.defaultView || window;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  }

  function getElLabel(el, doc) {
    let lbl =
      el.getAttribute('aria-label') ||
      el.innerText ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.getAttribute('name') ||
      '';
    if (!lbl && el.id && doc) {
      try {
        const labelEl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (labelEl) lbl = labelEl.innerText || '';
      } catch { /* ignore */ }
    }
    return norm(lbl);
  }

  function findTarget(opts) {
    const { ref, selector, text, inputsOnly } = opts || {};
    const { roots } = collectRoots(document);

    if (ref) {
      const sel = `[data-ag-ref="${CSS.escape(ref)}"]`;
      for (const r of roots) {
        const el = r.node.querySelector?.(sel);
        if (el) return { el, doc: r.doc, frameChain: r.frameChain };
      }
      return null;
    }

    if (selector) {
      for (const r of roots) {
        try {
          const list = r.node.querySelectorAll?.(selector) || [];
          for (const el of list) {
            if (isVisible(el, r.doc)) {
              return { el, doc: r.doc, frameChain: r.frameChain };
            }
          }
        } catch { /* invalid selector in sub-context */ }
      }
      return null;
    }

    if (text) {
      const want = norm(text);
      const wantLower = want.toLowerCase();
      const interactiveSel = inputsOnly
        ? 'input:not([type="hidden"]),textarea,select,[contenteditable="true"],[role="textbox"]'
        : 'a,button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="textbox"],[role="tab"],[role="menuitem"],summary,[class*="video-like"],[class*="video-coin"],.mc-box,.bi-btn,label,[onclick]';
      const fallbackSel = inputsOnly ? '' : 'span,div,p,li,h1,h2,h3,h4';

      const candidates = [];
      for (const passSel of fallbackSel ? [interactiveSel, fallbackSel] : [interactiveSel]) {
        const isPrimary = passSel === interactiveSel;
        for (const r of roots) {
          for (const el of r.node.querySelectorAll?.(passSel) || []) {
            if (!isVisible(el, r.doc)) continue;
            const rect = el.getBoundingClientRect();
            if (!isPrimary && (rect.width > 600 || rect.height > 260)) continue;
            const lbl = getElLabel(el, r.doc);
            if (!lbl) continue;
            const lblLower = lbl.toLowerCase();
            let tier = -1;
            if (lbl === want) tier = 0;
            else if (lblLower === wantLower) tier = 1;
            else if (lblLower.includes(wantLower)) tier = 2;
            if (tier >= 0) {
              candidates.push({
                el,
                doc: r.doc,
                frameChain: r.frameChain,
                score: (isPrimary ? 0 : 100) + tier * 10 + Math.min(9, lbl.length / 40),
                len: lbl.length,
              });
            }
          }
        }
        if (candidates.length > 0 && isPrimary) break;
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => a.score - b.score || a.len - b.len);
        const best = candidates[0];
        return { el: best.el, doc: best.doc, frameChain: best.frameChain };
      }
    }
    return null;
  }

  function scrollTargetIntoView(hit) {
    for (const step of hit.frameChain) {
      step.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    hit.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const { ox, oy } = getFrameOffset(hit.frameChain);
    const r = hit.el.getBoundingClientRect();
    return {
      x: Math.round(ox + r.left + r.width / 2),
      y: Math.round(oy + r.top + r.height / 2),
      tag: hit.el.tagName.toLowerCase(),
      label: getElLabel(hit.el, hit.doc).slice(0, 60),
    };
  }

  function ensureVirtualCursor() {
    if (globalThis.__agVirtualCursor) return globalThis.__agVirtualCursor;
    const host = document.createElement('div');
    host.id = '__ag-vc-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const POINTER_ARROW_PATH =
      'M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.0872 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z';

    shadow.innerHTML = `
      <style>
        .edge-glow {
          position: fixed; inset: 0; pointer-events: none; opacity: 0;
          box-shadow: inset 0 0 26px rgba(51,156,255,0.34), inset 0 0 8px rgba(139,92,246,0.28);
          transition: opacity 280ms ease;
        }
        .edge-glow.visible { opacity: 1; }
        .edge-glow.visible.standby { opacity: 0.32; }
        .cursor-wrap {
          position: fixed; left: 0; top: 0; pointer-events: none; opacity: 0;
          will-change: transform, opacity;
          transition: opacity 140ms ease;
        }
        .cursor-wrap.visible { opacity: 1; }
        .pointer-rotator {
          transform-origin: 4px 4px;
          will-change: transform;
        }
        .pointer-svg {
          width: 28px; height: 28px; display: block;
          filter: drop-shadow(0 0 6px rgba(51, 156, 255, 0.9)) drop-shadow(0 0 15px rgba(51, 156, 255, 0.48));
          transform-origin: 4px 4px;
          transition: transform 80ms ease;
        }
        .cursor-wrap.clicking .pointer-svg { transform: scale(0.82); }
        .pill {
          position: absolute; left: 22px; top: 18px;
          padding: 4px 10px; border-radius: 999px;
          background: rgba(15, 23, 42, 0.88);
          backdrop-filter: blur(8px);
          border: 1px solid rgba(51, 156, 255, 0.55);
          color: #f8fafc; font-size: 12px; font-weight: 500;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
          white-space: nowrap; max-width: 230px; overflow: hidden; text-overflow: ellipsis;
          box-shadow: 0 4px 14px rgba(15, 23, 42, 0.32);
          transform-origin: left center;
          transition: opacity 240ms ease, transform 240ms ease, border-color 240ms ease;
        }
        .cursor-wrap.standby .pill {
          opacity: 0.72;
          transform: scale(0.93);
          border-color: rgba(51, 156, 255, 0.32);
        }
        .ripple {
          position: fixed; left: 0; top: 0; width: 34px; height: 34px;
          margin-left: -17px; margin-top: -17px; border-radius: 50%;
          pointer-events: none; opacity: 0;
          border: 2.5px solid #339cff;
          background: radial-gradient(circle, rgba(51,156,255,0.38) 0%, rgba(139,92,246,0.18) 65%, transparent 100%);
        }
        .ripple.animate {
          animation: agRipple 360ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        @keyframes agRipple {
          0% { transform: scale(0.32); opacity: 0.95; }
          100% { transform: scale(2.45); opacity: 0; }
        }
      </style>
      <div class="edge-glow"></div>
      <div class="ripple"></div>
      <div class="cursor-wrap">
        <div class="pointer-rotator">
          <svg class="pointer-svg" viewBox="0 0 28 28" fill="none">
            <defs>
              <linearGradient id="vcSpark" x1="15" y1="15" x2="26" y2="26" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#0EA5E9"/>
                <stop offset="50%" stop-color="#4285F4"/>
                <stop offset="100%" stop-color="#D96570"/>
              </linearGradient>
            </defs>
            <path d="${POINTER_ARROW_PATH}" fill="#0B0F19" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round" paint-order="stroke fill" transform="scale(1.32)"/>
            <path d="M22 15.5C22 18.4 23.6 20 26.5 20C23.6 20 22 21.6 22 24.5C22 21.6 20.4 20 17.5 20C20.4 20 22 18.4 22 15.5Z" fill="url(#vcSpark)"/>
          </svg>
        </div>
        <div class="pill">Gemini</div>
      </div>
    `;

    const attachHost = () => {
      const root = document.documentElement || document.body;
      if (root && !host.isConnected) {
        root.appendChild(host);
      }
    };
    attachHost();

    // Self-healing observer in case SPA hydration wipes documentElement children
    const mo = new MutationObserver(() => {
      if (activeVisible && !host.isConnected) attachHost();
    });
    if (document.documentElement) {
      mo.observe(document.documentElement, { childList: true });
    }

    // Tab Favicon Badge helper
    let savedFavicons = [];
    let badgeApplied = false;
    function setTabFaviconBadge(active) {
      try {
        if (active && !badgeApplied) {
          const links = Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]'));
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#0F172A" opacity="0.18"/><path d="${POINTER_ARROW_PATH}" fill="#0B0F19" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke fill" transform="translate(-2 -2) scale(2.05)"/><circle cx="24" cy="24" r="6" fill="#339cff" stroke="#FFFFFF" stroke-width="1.5"/></svg>`;
          const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;
          if (links.length > 0) {
            savedFavicons = links.map((l) => ({ link: l, href: l.getAttribute('href'), created: false }));
            for (const item of savedFavicons) item.link.href = dataUrl;
          } else if (document.head) {
            const link = document.createElement('link');
            link.rel = 'icon';
            link.href = dataUrl;
            document.head.appendChild(link);
            savedFavicons = [{ link, href: null, created: true }];
          }
          badgeApplied = true;
        } else if (!active && badgeApplied) {
          for (const item of savedFavicons) {
            if (item.created) item.link.remove();
            else if (item.href) item.link.href = item.href;
          }
          savedFavicons = [];
          badgeApplied = false;
        }
      } catch {
        // ignore favicon restrictions
      }
    }

    const glowEl = shadow.querySelector('.edge-glow');
    const cursorEl = shadow.querySelector('.cursor-wrap');
    const rotatorEl = shadow.querySelector('.pointer-rotator');
    const pillEl = shadow.querySelector('.pill');
    const rippleEl = shadow.querySelector('.ripple');

    let curX = Math.round(window.innerWidth * 0.58);
    let curY = Math.round(window.innerHeight * 0.55);
    let curPosInitialized = false;
    let curAngle = 0;
    let rafId = null;
    let standbyTimer = null;
    let activeVisible = false;

    const renderTransform = (x, y, angleDeg = 0, stretchX = 1, stretchY = 1) => {
      cursorEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      rotatorEl.style.transform = `rotate(${angleDeg.toFixed(1)}deg) scale(${stretchX.toFixed(3)}, ${stretchY.toFixed(3)})`;
    };
    renderTransform(curX, curY, 0, 1, 1);

    const enterStandby = () => {
      standbyTimer = null;
      if (!activeVisible) return;
      glowEl.classList.add('standby');
      cursorEl.classList.add('standby');
      pillEl.textContent = 'Gemini · 待命中';
    };

    const scheduleStandby = (delayMs = 1500) => {
      if (standbyTimer) clearTimeout(standbyTimer);
      standbyTimer = setTimeout(enterStandby, delayMs);
    };

    // Cubic bezier flight with natural arc, tangent rotation, and velocity stretch
    function animateCurvedFlight(targetX, targetY, durationMs, onDone) {
      if (rafId) cancelAnimationFrame(rafId);
      const startX = curX;
      const startY = curY;
      const dx = targetX - startX;
      const dy = targetY - startY;
      const dist = Math.hypot(dx, dy);
      if (dist < 2 || durationMs <= 16) {
        curX = targetX;
        curY = targetY;
        renderTransform(curX, curY, 0, 1, 1);
        onDone?.();
        return;
      }

      // Compute perpendicular arc control points (~0.22 arc factor)
      const inv = 1 / dist;
      const ux = dx * inv;
      const uy = dy * inv;
      const nx = -uy;
      const ny = ux;
      const arcSign = dx >= 0 ? -1 : 1;
      const arcMag = Math.min(140, dist * 0.22) * arcSign;
      const c1x = startX + dx * 0.32 + nx * arcMag;
      const c1y = startY + dy * 0.32 + ny * arcMag;
      const c2x = startX + dx * 0.72 + nx * (arcMag * 0.55);
      const c2y = startY + dy * 0.72 + ny * (arcMag * 0.55);

      const t0 = performance.now();
      const step = (now) => {
        const raw = Math.min(1, (now - t0) / durationMs);
        // Spring-like easeOutQuint/Cubic blend
        const t = 1 - Math.pow(1 - raw, 3);
        const mt = 1 - t;
        const x = mt * mt * mt * startX + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * targetX;
        const y = mt * mt * mt * startY + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * targetY;

        // Derivative tangent for organic rotation
        const tx = 3 * mt * mt * (c1x - startX) + 6 * mt * t * (c2x - c1x) + 3 * t * t * (targetX - c2x);
        const ty = 3 * mt * mt * (c1y - startY) + 6 * mt * t * (c2y - c1y) + 3 * t * t * (targetY - c2y);
        const bell = Math.sin(raw * Math.PI);
        const tangentAngle = Math.max(-24, Math.min(24, (Math.atan2(ty, tx) * 180) / Math.PI * 0.18)) * bell;
        const stretch = 1 + Math.min(0.12, (dist / 1600) * bell);

        curX = x;
        curY = y;
        curAngle = tangentAngle;
        renderTransform(curX, curY, curAngle, stretch, 1 / Math.sqrt(stretch));

        if (raw < 1) {
          rafId = requestAnimationFrame(step);
        } else {
          rafId = null;
          curX = targetX;
          curY = targetY;
          curAngle = 0;
          renderTransform(curX, curY, 0, 1, 1);
          onDone?.();
        }
      };
      rafId = requestAnimationFrame(step);
    }

    const fireClickEffect = (tx, ty) => {
      cursorEl.classList.add('clicking');
      setTimeout(() => cursorEl.classList.remove('clicking'), 125);
      rippleEl.style.left = `${tx}px`;
      rippleEl.style.top = `${ty}px`;
      rippleEl.classList.remove('animate');
      void rippleEl.offsetWidth;
      rippleEl.classList.add('animate');
    };

    const api = {
      update(opts = {}) {
        attachHost();
        activeVisible = true;
        setTabFaviconBadge(true);

        if (!curPosInitialized && typeof opts.initX === 'number' && typeof opts.initY === 'number') {
          curX = opts.initX;
          curY = opts.initY;
          renderTransform(curX, curY, 0, 1, 1);
          curPosInitialized = true;
        }

        const isStandbyCall = opts.type === 'standby';
        if (opts.label) {
          pillEl.textContent = `Gemini · ${opts.label}`;
        }
        glowEl.classList.add('visible');
        cursorEl.classList.add('visible');
        if (isStandbyCall) {
          glowEl.classList.add('standby');
          cursorEl.classList.add('standby');
        } else {
          glowEl.classList.remove('standby');
          cursorEl.classList.remove('standby');
        }

        const isPageVisible = document.visibilityState === 'visible';
        const hasCoords = typeof opts.x === 'number' && typeof opts.y === 'number';
        if (hasCoords) {
          curPosInitialized = true;
        }

        if (!isPageVisible) {
          if (hasCoords) {
            curX = opts.x;
            curY = opts.y;
            renderTransform(curX, curY, 0, 1, 1);
          }
          scheduleStandby(1200);
          return { skippedInvisible: true };
        }

        if (opts.type === 'move_and_click' && hasCoords) {
          animateCurvedFlight(opts.x, opts.y, 72, () => {
            fireClickEffect(opts.x, opts.y);
          });
        } else if (opts.type === 'click') {
          if (hasCoords) {
            curX = opts.x;
            curY = opts.y;
            renderTransform(curX, curY, 0, 1, 1);
          }
          fireClickEffect(curX, curY);
        } else if (hasCoords) {
          animateCurvedFlight(opts.x, opts.y, 72);
        }

        if (!isStandbyCall) {
          scheduleStandby(1500);
        }
        return { skippedInvisible: false };
      },
      hide() {
        activeVisible = false;
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (standbyTimer) {
          clearTimeout(standbyTimer);
          standbyTimer = null;
        }
        glowEl.classList.remove('visible', 'standby');
        cursorEl.classList.remove('visible', 'standby');
        setTabFaviconBadge(false);
      },
    };
    globalThis.__agVirtualCursor = api;
    return api;
  }

  if (op === 'cursor_update') {
    const res = ensureVirtualCursor().update(payload);
    return { ok: true, ...res };
  }

  if (op === 'cursor_hide') {
    globalThis.__agVirtualCursor?.hide();
    return { ok: true };
  }

  if (op === 'read_content') {
    const maxLen = payload.maxLength || 15000;
    const wantLinks = payload.includeLinks !== false;
    const { roots, docs, crossOriginIframes } = collectRoots(document);
    const frameMeta = {
      frameUrl: location.href,
      frameName: window.name || '',
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      crossOriginIframes,
    };

    const descEl = document.querySelector('meta[name="description"], meta[property="og:description"]');
    const description = descEl?.getAttribute('content')?.trim() || '';

    const headings = [];
    const headingSeen = new Set();
    for (const r of roots) {
      for (const h of r.node.querySelectorAll?.('h1, h2, h3') || []) {
        const t = norm(h.innerText);
        if (t && !headingSeen.has(t)) {
          headingSeen.add(t);
          headings.push(t);
          if (headings.length >= 20) break;
        }
      }
      if (headings.length >= 20) break;
    }

    let bestText = '';
    for (const d of docs) {
      const curDoc = d.doc;
      const mainEl = curDoc.querySelector('main, article, [role="main"]');
      const mainText = mainEl ? (mainEl.innerText || '').trim() : '';
      const bodyText = curDoc.body ? (curDoc.body.innerText || '').trim() : '';
      const candidate = mainText.length >= 200 ? mainText : bodyText;
      if (candidate.length > bestText.length) {
        bestText = candidate;
      }
    }

    const totalLength = bestText.length;
    const truncated = totalLength > maxLen;
    const text = truncated ? bestText.slice(0, maxLen) : bestText;

    const links = [];
    if (wantLinks) {
      const seen = new Set();
      for (const r of roots) {
        for (const a of r.node.querySelectorAll?.('a[href]') || []) {
          const href = a.href;
          if (!href || !/^https?:/i.test(href) || seen.has(href)) continue;
          const label = norm(a.innerText || a.getAttribute('aria-label'));
          if (!label) continue;
          seen.add(href);
          links.push({ text: label.slice(0, 80), href });
          if (links.length >= 40) break;
        }
        if (links.length >= 40) break;
      }
    }

    return {
      ...frameMeta,
      title: document.title || '',
      url: location.href,
      description,
      headings,
      text,
      totalLength,
      truncated,
      links,
    };
  }

  if (op === 'snapshot') {
    const maxEl = payload.maxElements || 120;
    const maxTxt = payload.maxTextLength || 6000;
    const { roots, docs, crossOriginIframes } = collectRoots(document);
    const frameMeta = {
      frameUrl: location.href,
      frameName: window.name || '',
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      crossOriginIframes,
    };

    for (const r of roots) {
      r.node.querySelectorAll?.('[data-ag-ref]').forEach((el) => el.removeAttribute('data-ag-ref'));
    }

    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="tab"]',
      '[contenteditable="true"]',
      'summary',
      '[class*="video-like"]',
      '[class*="video-coin"]',
      '.mc-box',
      '.bi-btn',
      '[onclick]',
    ].join(',');

    const elements = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let count = 0;

    for (const r of roots) {
      const { ox, oy } = getFrameOffset(r.frameChain);
      for (const el of r.node.querySelectorAll?.(selector) || []) {
        if (!isVisible(el, r.doc)) continue;
        const rect = el.getBoundingClientRect();
        count += 1;
        const ref = `e${count}`;
        el.setAttribute('data-ag-ref', ref);

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag);
        const label = getElLabel(el, r.doc).slice(0, 80);

        let value;
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          value = el.type === 'password' ? '***' : String(el.value || '').slice(0, 80);
        }

        const absLeft = ox + rect.left;
        const absTop = oy + rect.top;
        elements.push({
          ref,
          tag,
          role,
          inputType: tag === 'input' ? (el.type || 'text') : undefined,
          label,
          value: value || undefined,
          href: tag === 'a' ? String(el.href || '').slice(0, 120) : undefined,
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          inViewport: absTop + rect.height > 0 && absTop < vh && absLeft + rect.width > 0 && absLeft < vw,
          x: Math.round(absLeft + rect.width / 2),
          y: Math.round(absTop + rect.height / 2),
        });
        if (elements.length >= maxEl) break;
      }
      if (elements.length >= maxEl) break;
    }

    let bestExcerpt = '';
    for (const d of docs) {
      const txt = d.doc.body ? (d.doc.body.innerText || '').trim() : '';
      if (txt.length > bestExcerpt.length) bestExcerpt = txt;
    }

    return {
      ...frameMeta,
      title: document.title || '',
      url: location.href,
      elements,
      textExcerpt: bestExcerpt.slice(0, maxTxt),
    };
  }

  const baseFrameMeta = () => {
    const { crossOriginIframes } = collectRoots(document);
    return {
      frameUrl: location.href,
      frameName: window.name || '',
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      crossOriginIframes,
    };
  };

  if (op === 'frame_meta') {
    return baseFrameMeta();
  }

  if (op === 'locate') {
    const hit = findTarget(payload);
    if (!hit) return { found: false, ...baseFrameMeta() };
    const pos = scrollTargetIntoView(hit);
    return { found: true, ...pos, ...baseFrameMeta() };
  }

  if (op === 'fill_prep') {
    const hit = findTarget({ ...payload, inputsOnly: true }) || findTarget(payload);
    if (!hit) return { found: false, ...baseFrameMeta() };
    const pos = scrollTargetIntoView(hit);
    const el = hit.el;
    el.focus();

    if (el.tagName === 'SELECT') {
      if (payload.selectValue !== undefined) {
        el.value = String(payload.selectValue);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { found: true, isSelect: true, ...pos, ...baseFrameMeta() };
    }

    if (payload.shouldClear) {
      const win = hit.doc.defaultView || window;
      if ('value' in el) {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc?.set) desc.set.call(el, '');
        else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.isContentEditable) {
        const range = hit.doc.createRange();
        range.selectNodeContents(el);
        const selection = win.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        hit.doc.execCommand('delete');
      }
    }
    return { found: true, isSelect: false, ...pos, ...baseFrameMeta() };
  }

  if (op === 'scroll') {
    const { ref, selector, text, direction, amount } = payload;
    if (ref || selector || text) {
      const hit = findTarget({ ref, selector, text });
      if (!hit) return { ok: false, reason: 'ELEMENT_NOT_FOUND', ...baseFrameMeta() };
      const pos = scrollTargetIntoView(hit);
      return { ok: true, scrollY: window.scrollY, ...pos, ...baseFrameMeta() };
    }
    if (direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
    else if (direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    else if (direction === 'up') window.scrollBy(0, -Math.abs(amount || 600));
    else window.scrollBy(0, Math.abs(amount || 600));
    return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
  }

  if (op === 'wait_check') {
    const hit = findTarget(payload);
    if (!hit) return { found: false, ...baseFrameMeta() };
    const { ox, oy } = getFrameOffset(hit.frameChain);
    const r = hit.el.getBoundingClientRect();
    return {
      found: true,
      x: Math.round(ox + r.left + r.width / 2),
      y: Math.round(oy + r.top + r.height / 2),
      tag: hit.el.tagName.toLowerCase(),
      text: getElLabel(hit.el, hit.doc).slice(0, 60),
      ...baseFrameMeta(),
    };
  }

  return { error: `Unknown pageOperation: ${op}` };
}

async function runCrossFrameLocateOp(tabId, opName, payload) {
  const refStr = String(payload?.ref || '');
  const refMatch = refStr.match(/^f(\d+)_(e\d+)$/);
  if (refMatch) {
    const targetFrameId = Number(refMatch[1]);
    const localRef = refMatch[2];
    const [topMeta, childRes] = await Promise.all([
      runScripting(tabId, pageOperation, ['frame_meta', {}], 0),
      runScripting(tabId, pageOperation, [opName, { ...payload, ref: localRef }], targetFrameId),
    ]);
    if (!childRes || (!childRes.found && !childRes.ok)) {
      return childRes || { found: false, ok: false };
    }
    const { ox, oy } = resolveChildFrameOffset(topMeta, childRes);
    return {
      ...childRes,
      frameId: targetFrameId,
      x: typeof childRes.x === 'number' ? childRes.x + ox : childRes.x,
      y: typeof childRes.y === 'number' ? childRes.y + oy : childRes.y,
    };
  }

  const topRes = await runScripting(tabId, pageOperation, [opName, payload], 0);
  if (topRes?.found || topRes?.ok) {
    return { ...topRes, frameId: 0 };
  }

  if (!topRes?.crossOriginIframes?.length) {
    return topRes || { found: false, ok: false };
  }

  const allFrames = await runAllFramesScripting(tabId, pageOperation, [
    opName,
    { ...payload, allFramesMode: true },
  ]);
  for (const f of allFrames) {
    if (f.frameId === 0 || !f.result || f.result.skippedSameOriginChild) continue;
    if (f.result.found || f.result.ok) {
      const { ox, oy } = resolveChildFrameOffset(topRes, f.result);
      return {
        ...f.result,
        frameId: f.frameId,
        x: typeof f.result.x === 'number' ? f.result.x + ox : f.result.x,
        y: typeof f.result.y === 'number' ? f.result.y + oy : f.result.y,
      };
    }
  }
  return topRes || { found: false, ok: false };
}

async function showVirtualCursor(tabId, opts = {}) {
  if (!virtualCursorEnabled) return { skippedInvisible: true };
  try {
    const prev = lastCursorPosByTab.get(tabId);
    const payload = {
      ...opts,
      initX: prev?.x,
      initY: prev?.y,
    };
    if (typeof opts.x === 'number' && typeof opts.y === 'number') {
      lastCursorPosByTab.set(tabId, { x: opts.x, y: opts.y });
    }
    return (await runScripting(tabId, pageOperation, ['cursor_update', payload])) || { skippedInvisible: false };
  } catch {
    return { skippedInvisible: true };
  }
}

async function hideVirtualCursor(tabId) {
  try {
    await runScripting(tabId, pageOperation, ['cursor_hide', {}]);
  } catch {
    // ignore
  }
}

async function dispatchAction(action, params) {
  if (!enabled && action !== 'bridge_status') {
    throw makeError('BRIDGE_PAUSED', '用户已在扩展弹窗中暂停 AI 连接，请点击扩展图标开启「启用 AI 连接」');
  }

  switch (action) {
    case 'bridge_status': {
      const tabs = await queryEnrichedTabs();
      const activeTab = tabs.find((t) => t.active && t.windowFocused) || tabs.find((t) => t.active) || null;
      return {
        browserId,
        browserName,
        extensionVersion: EXT_VERSION,
        paused: !enabled,
        virtualCursorEnabled,
        slashSyncMode,
        selectedTabIds,
        attachedTabs: Array.from(attachedTabs),
        tabCount: tabs.length,
        activeTab,
      };
    }

    case 'list_tabs': {
      let tabs = await queryEnrichedTabs();
      if (params.browser) {
        const want = String(params.browser).toLowerCase();
        tabs = tabs.filter((t) => t.browser.toLowerCase() === want);
      }
      if (params.activeOnly) {
        tabs = tabs.filter((t) => t.active);
      }
      if (params.selectedOnly) {
        tabs = tabs.filter((t) => t.selected);
      }
      if (params.query) {
        const q = String(params.query).toLowerCase();
        tabs = tabs.filter(
          (t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)
        );
      }
      return { tabs };
    }

    case 'read_page_content': {
      const tab = await resolveTargetTab(params);
      assertNotRestricted(tab);
      const maxLength = Math.max(500, Number(params.maxLength || 15000));
      const includeLinks = params.includeLinks !== false;
      const topRes = await runScripting(
        tab.id,
        pageOperation,
        ['read_content', { maxLength, includeLinks }],
        0
      );
      if (!topRes?.crossOriginIframes?.length) {
        return { tabId: tab.id, ...topRes };
      }

      const allFrames = await runAllFramesScripting(tab.id, pageOperation, [
        'read_content',
        { maxLength, includeLinks, allFramesMode: true },
      ]);
      const textParts = topRes.text ? [topRes.text] : [];
      const headings = [...(topRes.headings || [])];
      const links = [...(topRes.links || [])];
      const linkSeen = new Set(links.map((l) => l.href));

      for (const f of allFrames) {
        if (f.frameId === 0 || !f.result || f.result.skippedSameOriginChild) continue;
        if (f.result.text) textParts.push(f.result.text);
        for (const h of f.result.headings || []) {
          if (headings.length < 25 && !headings.includes(h)) headings.push(h);
        }
        for (const l of f.result.links || []) {
          if (links.length < 50 && !linkSeen.has(l.href)) {
            linkSeen.add(l.href);
            links.push(l);
          }
        }
      }

      const combinedText = textParts.join('\n\n---\n\n');
      const totalLength = combinedText.length;
      const truncated = totalLength > maxLength;
      return {
        tabId: tab.id,
        title: topRes.title,
        url: topRes.url,
        description: topRes.description,
        headings,
        text: truncated ? combinedText.slice(0, maxLength) : combinedText,
        totalLength,
        truncated,
        links,
      };
    }

    case 'get_page_snapshot': {
      const tab = await resolveTargetTab(params);
      assertNotRestricted(tab);
      if (!params.silent) {
        void ensureDebugger(tab.id).catch(() => {});
        if (virtualCursorEnabled) {
          void showVirtualCursor(tab.id, { type: 'standby', label: '观察页面中' });
        }
      }
      const maxElements = Math.max(10, Number(params.maxElements || 120));
      const maxTextLength = Math.max(500, Number(params.maxTextLength || 6000));
      const topRes = await runScripting(
        tab.id,
        pageOperation,
        ['snapshot', { maxElements, maxTextLength }],
        0
      );
      if (!topRes?.crossOriginIframes?.length) {
        return { tabId: tab.id, ...topRes };
      }

      const allFrames = await runAllFramesScripting(tab.id, pageOperation, [
        'snapshot',
        { maxElements, maxTextLength, allFramesMode: true },
      ]);
      const elements = [...(topRes.elements || [])];
      const excerpts = topRes.textExcerpt ? [topRes.textExcerpt] : [];

      for (const f of allFrames) {
        if (f.frameId === 0 || !f.result || f.result.skippedSameOriginChild) continue;
        const { ox, oy } = resolveChildFrameOffset(topRes, f.result);
        if (f.result.textExcerpt) excerpts.push(f.result.textExcerpt);
        for (const el of f.result.elements || []) {
          if (elements.length >= maxElements) break;
          elements.push({
            ...el,
            ref: `f${f.frameId}_${el.ref}`,
            x: el.x + ox,
            y: el.y + oy,
          });
        }
      }

      return {
        tabId: tab.id,
        title: topRes.title,
        url: topRes.url,
        elements: elements.slice(0, maxElements),
        textExcerpt: excerpts.join('\n\n---\n\n').slice(0, maxTextLength),
      };
    }

    case 'switch_tab': {
      const tab = await resolveTargetTab(params);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { tabId: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url };
    }

    case 'open_tab': {
      const tab = await chrome.tabs.create({
        url: params.url,
        active: params.active !== false,
      });
      return { tabId: tab.id, windowId: tab.windowId, url: tab.pendingUrl || tab.url || params.url };
    }

    case 'close_tab': {
      const tab = await resolveTargetTab(params);
      await chrome.tabs.remove(tab.id);
      return { closedTabId: tab.id, title: tab.title, url: tab.url };
    }

    case 'navigate_tab': {
      const tab = await resolveTargetTab(params);
      const act = params.action || 'goto';
      if (act === 'goto') {
        if (!params.url) throw makeError('INVALID_ARGS', 'action="goto" 时必须提供 url');
        await chrome.tabs.update(tab.id, { url: params.url });
      } else if (act === 'back') {
        await chrome.tabs.goBack(tab.id);
      } else if (act === 'forward') {
        await chrome.tabs.goForward(tab.id);
      } else if (act === 'reload') {
        await chrome.tabs.reload(tab.id);
      }
      await waitForTabLoad(tab.id, 6000);
      const updated = await chrome.tabs.get(tab.id);
      const out = { tabId: updated.id, title: updated.title, url: updated.url, status: updated.status };
      if (params.includeSnapshot) {
        out.snapshot = await dispatchAction('get_page_snapshot', { tabId: updated.id }).catch(() => null);
      }
      if (params.includeContent) {
        out.content = await dispatchAction('read_page_content', { tabId: updated.id }).catch(() => null);
      }
      return out;
    }

    case 'click_element': {
      const tab = await resolveTargetTab(params);
      assertNotRestricted(tab);
      let x = params.x;
      let y = params.y;
      let label = '';

      if (x === undefined || y === undefined) {
        if (!params.ref && !params.selector && !params.text) {
          throw makeError('INVALID_ARGS', '请提供 ref、selector、text 或 x/y 坐标');
        }
        const loc = await runCrossFrameLocateOp(tab.id, 'locate', {
          ref: params.ref || '',
          selector: params.selector || '',
          text: params.text || '',
        });
        if (!loc?.found) {
          throw makeError(
            'ELEMENT_NOT_FOUND',
            `未找到目标元素 (${params.ref || params.selector || params.text})，可先调用 get_page_snapshot 查看最新元素`
          );
        }
        x = loc.x;
        y = loc.y;
        label = loc.label || '';
      }

      const clickStartedAt = Date.now();
      const beforeUrl = tab.url || '';
      const cursorLabel = label ? `点击「${label.slice(0, 18)}」` : `点击 (${x},${y})`;

      // Parallelize virtual cursor glide & chrome.debugger attach (20ms fast sync when visible, 0ms when already attached)
      await Promise.all([
        ensureDebugger(tab.id),
        virtualCursorEnabled && tab.active
          ? showVirtualCursor(tab.id, { type: 'move_and_click', x, y, label: cursorLabel }).then((res) =>
              res?.skippedInvisible ? undefined : sleep(20)
            )
          : Promise.resolve(),
      ]);

      const button = params.button || 'left';
      const clickCount = params.doubleClick ? 2 : 1;
      await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      for (let c = 1; c <= clickCount; c++) {
        await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: c });
        await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: c });
      }

      const waitAfterMs = Math.min(5000, Math.max(0, Number(params.waitAfterMs ?? 35)));
      if (waitAfterMs > 0) await sleep(waitAfterMs);

      const createdEntry =
        recentCreatedTabs.find(
          (item) => item.ts >= clickStartedAt - 30 && item.tab.openerTabId === tab.id
        ) ||
        recentCreatedTabs.find(
          (item) => item.ts >= clickStartedAt - 30 && item.tab.windowId === tab.windowId
        );
      let newTab = null;
      if (createdEntry) {
        newTab = await chrome.tabs.get(createdEntry.tab.id).catch(() => createdEntry.tab);
        if (newTab?.id) {
          lastCursorPosByTab.set(newTab.id, { x, y });
          void ensureDebugger(newTab.id).catch(() => {});
        }
      }
      const updatedTab = await chrome.tabs.get(tab.id).catch(() => tab);
      const resultTabId = newTab?.id || tab.id;

      const out = {
        tabId: tab.id,
        clicked: true,
        x,
        y,
        button,
        doubleClick: Boolean(params.doubleClick),
        label,
        urlChanged: (updatedTab.url || '') !== beforeUrl,
        currentUrl: updatedTab.url || '',
        title: updatedTab.title || '',
        openedNewTab: newTab
          ? {
              tabId: newTab.id,
              title: newTab.title || '',
              url: newTab.pendingUrl || newTab.url || '',
            }
          : null,
      };
      if (params.includeSnapshot) {
        out.snapshot = await dispatchAction('get_page_snapshot', { tabId: resultTabId }).catch(() => null);
      }
      if (params.includeContent) {
        out.content = await dispatchAction('read_page_content', { tabId: resultTabId }).catch(() => null);
      }
      return out;
    }

    case 'fill_element': {
      const tab = await resolveTargetTab(params);
      assertNotRestricted(tab);
      if (!params.ref && !params.selector && !params.text) {
        throw makeError('INVALID_ARGS', '请提供 ref、selector 或 text');
      }

      const prep = await runCrossFrameLocateOp(tab.id, 'fill_prep', {
        ref: params.ref || '',
        selector: params.selector || '',
        text: params.text || '',
        shouldClear: params.clear !== false,
      });

      if (!prep?.found) {
        throw makeError('ELEMENT_NOT_FOUND', `未找到输入框 (${params.ref || params.selector || params.text})`);
      }

      if (prep.isSelect) {
        if (virtualCursorEnabled && typeof prep.x === 'number') {
          await showVirtualCursor(tab.id, { type: 'move', x: prep.x, y: prep.y, label: '选择选项' });
        }
        await runCrossFrameLocateOp(tab.id, 'fill_prep', {
          ref: params.ref || '',
          selector: params.selector || '',
          text: params.text || '',
          selectValue: String(params.value),
        });
      } else {
        await Promise.all([
          ensureDebugger(tab.id),
          virtualCursorEnabled && typeof prep.x === 'number'
            ? showVirtualCursor(tab.id, { type: 'move', x: prep.x, y: prep.y, label: '输入文本' }).then(() => sleep(15))
            : Promise.resolve(),
        ]);
        await sendCdp(tab.id, 'Input.insertText', { text: String(params.value) });
        if (params.pressEnter) {
          await dispatchKeyCombo(tab.id, 'Enter');
        }
      }
      return {
        tabId: tab.id,
        filled: true,
        target: params.ref || params.selector || params.text,
        length: String(params.value).length,
      };
    }

    case 'press_key': {
      const tab = await resolveTargetTab(params);
      assertNotRestricted(tab);
      await Promise.all([
        ensureDebugger(tab.id),
        virtualCursorEnabled
          ? showVirtualCursor(tab.id, { type: 'move', label: `按键 ${params.key}` })
          : Promise.resolve(),
      ]);
      await dispatchKeyCombo(tab.id, params.key);
      return { tabId: tab.id, key: params.key, pressed: true };
    }

    case 'scroll_page': {
      const tab = await resolveTargetTab(params);
      assertNotRestricted(tab);
      void ensureDebugger(tab.id).catch(() => {});
      if (virtualCursorEnabled) {
        void showVirtualCursor(tab.id, { type: 'move', label: '滚动页面' });
      }
      const res = await runCrossFrameLocateOp(tab.id, 'scroll', {
        ref: params.ref || '',
        selector: params.selector || '',
        text: params.text || '',
        direction: params.direction || 'down',
        amount: Number(params.amount || 600),
      });
      if (!res?.ok) {
        throw makeError('ELEMENT_NOT_FOUND', `未找到要滚动到的元素 (${params.ref || params.selector || params.text})`);
      }
      return { tabId: tab.id, ...res };
    }

    case 'wait_for': {
      const tab = await resolveTargetTab(params);
      assertNotRestricted(tab);
      void ensureDebugger(tab.id).catch(() => {});
      if (!params.selector && !params.text) {
        throw makeError('INVALID_ARGS', 'wait_for 需要提供 selector 或 text');
      }
      const timeoutMs = Math.min(20000, Math.max(200, Number(params.timeoutMs || 8000)));
      const started = Date.now();
      while (Date.now() - started <= timeoutMs) {
        const hit = await runCrossFrameLocateOp(tab.id, 'wait_check', {
          selector: params.selector || '',
          text: params.text || '',
        });
        if (hit?.found) {
          return {
            tabId: tab.id,
            found: true,
            elapsedMs: Date.now() - started,
            x: hit.x,
            y: hit.y,
            tag: hit.tag,
            text: hit.text,
            frameId: hit.frameId,
          };
        }
        await sleep(100);
      }
      throw makeError(
        'WAIT_TIMEOUT',
        `等待目标 (${params.selector || params.text}) 超时 (${timeoutMs}ms)`
      );
    }

    case 'run_steps': {
      const steps = Array.isArray(params.steps) ? params.steps : [];
      if (steps.length === 0 || steps.length > 20) {
        throw makeError('INVALID_ARGS', 'steps 必须是包含 1～20 个步骤的数组');
      }
      const stopOnError = params.stopOnError !== false;
      // Keep debugger attached and virtual cursor visible by default for instant follow-up actions
      const forceDetach = Boolean(params.forceDetach);

      const initialTab = await resolveTargetTab(params);
      let activeTabId = initialTab.id;
      const touchedTabs = new Set([activeTabId]);
      const results = [];

      try {
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i] || {};
          const act = String(step.action || '');
          const stepTabId = step.tabId !== undefined ? Number(step.tabId) : activeTabId;
          touchedTabs.add(stepTabId);

          try {
            let stepRes;
            if (act === 'wait') {
              const ms = Math.min(10000, Math.max(0, Number(step.ms ?? 300)));
              await sleep(ms);
              stepRes = { waitedMs: ms };
            } else if (act === 'wait_for') {
              stepRes = await dispatchAction('wait_for', { ...step, tabId: stepTabId });
            } else if (act === 'click') {
              stepRes = await dispatchAction('click_element', { ...step, tabId: stepTabId });
              if (step.switchToNewTab === true && stepRes.openedNewTab?.tabId) {
                activeTabId = stepRes.openedNewTab.tabId;
                touchedTabs.add(activeTabId);
                await chrome.tabs.update(activeTabId, { active: true });
                await waitForTabLoad(activeTabId, 6000);
              }
            } else if (act === 'fill') {
              stepRes = await dispatchAction('fill_element', { ...step, tabId: stepTabId });
            } else if (act === 'press_key') {
              stepRes = await dispatchAction('press_key', { ...step, tabId: stepTabId });
            } else if (act === 'scroll') {
              stepRes = await dispatchAction('scroll_page', { ...step, tabId: stepTabId });
            } else if (act === 'navigate') {
              const navAct = step.navAction || (step.url ? 'goto' : 'reload');
              stepRes = await dispatchAction('navigate_tab', { ...step, action: navAct, tabId: stepTabId });
            } else if (act === 'snapshot') {
              stepRes = await dispatchAction('get_page_snapshot', { ...step, tabId: stepTabId });
            } else {
              throw makeError('INVALID_STEP_ACTION', `不支持的步骤动作: ${act}`);
            }
            results.push({ step: i + 1, action: act, ok: true, data: stepRes });
          } catch (err) {
            const failInfo = {
              step: i + 1,
              action: act,
              ok: false,
              error: err?.code || 'STEP_ERROR',
              message: err?.message || String(err),
            };
            results.push(failInfo);
            if (stopOnError) break;
          }
        }
      } finally {
        if (forceDetach) {
          for (const id of touchedTabs) {
            await hideVirtualCursor(id);
            tabDomains.delete(id);
            if (attachedTabs.has(id)) {
              await chrome.debugger.detach({ tabId: id }).catch(() => {});
              attachedTabs.delete(id);
            }
          }
          sendStatusUpdate();
        }
      }

      const finalTab = await chrome.tabs.get(activeTabId).catch(() => null);
      const completedSteps = results.filter((r) => r.ok).length;
      const out = {
        ok: completedSteps === steps.length,
        finalTabId: activeTabId,
        finalUrl: finalTab?.url || '',
        finalTitle: finalTab?.title || '',
        completedSteps,
        totalSteps: steps.length,
        results,
      };
      if (params.includeSnapshot) {
        out.snapshot = await dispatchAction('get_page_snapshot', { tabId: activeTabId }).catch(() => null);
      }
      if (params.includeContent) {
        out.content = await dispatchAction('read_page_content', { tabId: activeTabId }).catch(() => null);
      }
      return out;
    }

    case 'take_screenshot': {
      const tab = await resolveTargetTab(params);
      assertNotRestricted(tab);
      const format = params.format === 'png' ? 'png' : 'jpeg';
      const quality = Math.max(1, Math.min(100, Number(params.quality || 80)));

      if (!params.fullPage && tab.active) {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format,
            quality: format === 'jpeg' ? quality : undefined,
          });
          const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
          return {
            tabId: tab.id,
            title: tab.title,
            url: tab.url,
            mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
            base64,
            method: 'captureVisibleTab (无调试横幅)',
          };
        } catch {
          // Fallback to CDP below if window minimized or captureVisibleTab failed
        }
      }

      await ensureDebugger(tab.id);
      const shotParams = { format };
      if (format === 'jpeg') shotParams.quality = quality;
      if (params.fullPage) {
        const metrics = await sendCdp(tab.id, 'Page.getLayoutMetrics');
        const contentSize = metrics.cssContentSize || metrics.contentSize;
        if (contentSize) {
          shotParams.captureBeyondViewport = true;
          shotParams.clip = {
            x: 0,
            y: 0,
            width: Math.min(contentSize.width, 4096),
            height: Math.min(contentSize.height, 16384),
            scale: 1,
          };
        }
      }
      const res = await sendCdp(tab.id, 'Page.captureScreenshot', shotParams);
      return {
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
        base64: res.data,
        method: 'CDP Page.captureScreenshot',
      };
    }

    case 'evaluate_script': {
      const tab = await resolveTargetTab(params);
      assertNotRestricted(tab);
      await ensureDebugger(tab.id);
      const res = await sendCdp(tab.id, 'Runtime.evaluate', {
        expression: String(params.expression),
        awaitPromise: params.awaitPromise !== false,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Script exception';
        throw makeError('SCRIPT_ERROR', msg);
      }
      return {
        tabId: tab.id,
        type: res.result?.type,
        value: res.result?.value !== undefined ? res.result.value : res.result?.description,
      };
    }

    case 'get_console_logs': {
      const tab = await resolveTargetTab(params);
      await ensureDebugger(tab.id, ['Runtime', 'Log']);
      const bucket = getTabLogBucket(tab.id);
      const limit = Math.max(1, Number(params.limit || 50));
      const logs = bucket.console.slice(-limit);
      if (params.clear) bucket.console.length = 0;
      return { tabId: tab.id, count: logs.length, logs };
    }

    case 'get_network_requests': {
      const tab = await resolveTargetTab(params);
      await ensureDebugger(tab.id, ['Network']);
      const bucket = getTabLogBucket(tab.id);
      const limit = Math.max(1, Number(params.limit || 50));
      let items = bucket.network;
      if (params.filter) {
        const f = String(params.filter).toLowerCase();
        items = items.filter((r) => r.url.toLowerCase().includes(f));
      }
      const requests = items.slice(-limit);
      if (params.clear) {
        bucket.network.length = 0;
        bucket.reqMap.clear();
      }
      return { tabId: tab.id, count: requests.length, requests };
    }

    case 'detach_debugger': {
      const detachedTabIds = [];
      if (params.tabId !== undefined && params.tabId !== null) {
        const id = Number(params.tabId);
        await hideVirtualCursor(id);
        tabDomains.delete(id);
        if (attachedTabs.has(id)) {
          await chrome.debugger.detach({ tabId: id }).catch(() => {});
          attachedTabs.delete(id);
          detachedTabIds.push(id);
        }
      } else {
        for (const id of Array.from(attachedTabs)) {
          await hideVirtualCursor(id);
          tabDomains.delete(id);
          await chrome.debugger.detach({ tabId: id }).catch(() => {});
          attachedTabs.delete(id);
          detachedTabIds.push(id);
        }
      }
      sendStatusUpdate();
      return { detachedTabIds };
    }

    default:
      throw makeError('UNKNOWN_ACTION', `未知操作: ${action}`);
  }
}

async function dispatchKeyCombo(tabId, combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  let modifiers = 0;
  let mainKey = parts[parts.length - 1] || 'Enter';
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].toLowerCase();
    if (m === 'alt') modifiers |= 1;
    else if (m === 'ctrl' || m === 'control') modifiers |= 2;
    else if (m === 'meta' || m === 'cmd' || m === 'command') modifiers |= 4;
    else if (m === 'shift') modifiers |= 8;
  }

  const keyInfo = mapKeyDefinition(mainKey);
  await sendCdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    modifiers,
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.keyCode,
    nativeVirtualKeyCode: keyInfo.keyCode,
  });
  if (keyInfo.text && (modifiers & ~8) === 0) {
    await sendCdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'char',
      modifiers,
      text: keyInfo.text,
    });
  }
  await sendCdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers,
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.keyCode,
    nativeVirtualKeyCode: keyInfo.keyCode,
  });
}

function mapKeyDefinition(key) {
  const special = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  };
  const lower = key.toLowerCase();
  if (special[lower]) return special[lower];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : key;
    return { key, code, keyCode: upper.charCodeAt(0), text: key };
  }
  return { key, code: key, keyCode: 0 };
}

function waitForTabLoad(tabId, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// ---------------- Popup UI Messages ----------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await initReady;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'get_popup_state') {
      const tabs = await queryEnrichedTabs();
      return {
        connected,
        enabled,
        virtualCursorEnabled,
        slashSyncMode,
        lastError,
        browserId,
        browserName,
        extensionId: chrome.runtime.id,
        selectedTabIds,
        attachedTabs: Array.from(attachedTabs),
        tabs,
      };
    }

    if (msg.type === 'set_enabled') {
      enabled = Boolean(msg.enabled);
      await chrome.storage.local.set({ bridgeEnabled: enabled });
      updateBadge();
      sendStatusUpdate();
      scheduleTabSync(true);
      if (enabled && !connected) {
        connectNative();
      }
      return { ok: true, enabled };
    }

    if (msg.type === 'set_virtual_cursor') {
      virtualCursorEnabled = Boolean(msg.enabled);
      await chrome.storage.local.set({ virtualCursorEnabled });
      for (const id of attachedTabs) {
        if (virtualCursorEnabled) {
          showVirtualCursor(id, { type: 'standby', label: '待命中' }).catch(() => {});
        } else {
          hideVirtualCursor(id).catch(() => {});
        }
      }
      return { ok: true, virtualCursorEnabled };
    }

    if (msg.type === 'set_slash_sync_mode') {
      const mode = String(msg.mode || 'auto');
      if (!['auto', 'selected', 'off'].includes(mode)) {
        return { ok: false, error: 'INVALID_SYNC_MODE' };
      }
      slashSyncMode = mode;
      await chrome.storage.local.set({ slashSyncMode });
      scheduleTabSync(true);
      return { ok: true, slashSyncMode };
    }

    if (msg.type === 'reconnect') {
      reconnectDelayMs = 1000;
      await connectNative(true);
      return { ok: true, connected, lastError };
    }

    if (msg.type === 'toggle_select_tab') {
      const id = Number(msg.tabId);
      const exists = selectedTabIds.includes(id);
      const next = exists ? selectedTabIds.filter((x) => x !== id) : [...selectedTabIds, id];
      await saveSelectedTabs(next);
      return { ok: true, selectedTabIds };
    }

    if (msg.type === 'clear_selected_tabs') {
      await saveSelectedTabs([]);
      return { ok: true, selectedTabIds: [] };
    }

    if (msg.type === 'activate_tab') {
      await chrome.tabs.update(Number(msg.tabId), { active: true });
      if (msg.windowId) {
        await chrome.windows.update(Number(msg.windowId), { focused: true });
      }
      return { ok: true };
    }

    if (msg.type === 'detach_debugger') {
      await dispatchAction('detach_debugger', { tabId: msg.tabId });
      return { ok: true, attachedTabs: Array.from(attachedTabs) };
    }

    return { ok: false, error: 'UNKNOWN_MESSAGE' };
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

// ---------------- Keepalive Alarms & Startup ----------------

chrome.alarms.create('bridge-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge-keepalive' && enabled && !connected) {
    connectNative();
  }
});

const initReady = loadState().then(() => {
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => connectNative());
chrome.runtime.onInstalled.addListener(() => connectNative());
connectNative();
