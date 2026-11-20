const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const browserBadge = document.getElementById('browserBadge');
const errorBanner = document.getElementById('errorBanner');
const enableToggle = document.getElementById('enableToggle');
const cursorToggle = document.getElementById('cursorToggle');
const syncModeSelect = document.getElementById('syncModeSelect');
const detachBtn = document.getElementById('detachBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const searchInput = document.getElementById('searchInput');
const clearSelectedBtn = document.getElementById('clearSelectedBtn');
const tabCountText = document.getElementById('tabCountText');
const selectedCountText = document.getElementById('selectedCountText');
const tabListEl = document.getElementById('tabList');
const extIdText = document.getElementById('extIdText');

let currentState = null;

async function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

function render() {
  if (!currentState) return;
  const {
    connected,
    enabled,
    virtualCursorEnabled,
    slashSyncMode,
    lastError,
    browserName,
    extensionId,
    selectedTabIds = [],
    attachedTabs = [],
    tabs = [],
  } = currentState;

  browserBadge.textContent = browserName || 'Chrome';
  extIdText.textContent = `ID: ${extensionId}`;
  enableToggle.checked = Boolean(enabled);
  cursorToggle.checked = virtualCursorEnabled !== false;
  syncModeSelect.value = slashSyncMode || 'auto';

  statusDot.className = 'status-dot';
  if (!enabled) {
    statusDot.classList.add('paused');
    statusText.textContent = '已暂停（AI 访问已禁用）';
  } else if (connected) {
    statusDot.classList.add('connected');
    statusText.textContent = '已连接到 Antigravity Native Host';
  } else {
    statusDot.classList.add('disconnected');
    statusText.textContent = '未连接（等待重连）';
  }

  if (!connected && enabled && lastError) {
    errorBanner.textContent = `连接提示: ${lastError}`;
    errorBanner.classList.remove('hidden');
  } else {
    errorBanner.classList.add('hidden');
  }

  if (attachedTabs.length > 0) {
    detachBtn.classList.remove('hidden');
    detachBtn.textContent = `分离调试器 (${attachedTabs.length})`;
  } else {
    detachBtn.classList.add('hidden');
  }

  const query = searchInput.value.trim().toLowerCase();
  const filtered = tabs.filter((t) => {
    if (!query) return true;
    return (
      (t.title || '').toLowerCase().includes(query) ||
      (t.url || '').toLowerCase().includes(query) ||
      (t.domain || '').toLowerCase().includes(query)
    );
  });

  // Sort: selected -> active -> original order
  filtered.sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return 0;
  });

  tabCountText.textContent = `标签页 (${filtered.length}/${tabs.length})`;
  selectedCountText.textContent =
    selectedTabIds.length > 0
      ? `已选定 ${selectedTabIds.length} 个目标页`
      : '点击「选定」可固定目标页';

  tabListEl.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = query ? '没有匹配的标签页' : '当前没有打开的标签页';
    tabListEl.appendChild(empty);
    return;
  }

  for (const tab of filtered) {
    const item = document.createElement('div');
    item.className = 'tab-item' + (tab.selected ? ' selected' : '');

    const main = document.createElement('div');
    main.className = 'tab-main';
    main.title = `${tab.title}\n${tab.url}\n(点击切换到此标签页)`;
    main.addEventListener('click', async () => {
      await sendMessage({ type: 'activate_tab', tabId: tab.tabId, windowId: tab.windowId });
      await refreshState();
    });

    if (tab.favIconUrl && /^https?:/i.test(tab.favIconUrl)) {
      const img = document.createElement('img');
      img.className = 'favicon';
      img.src = tab.favIconUrl;
      img.alt = '';
      img.addEventListener('error', () => {
        img.replaceWith(createFallbackIcon(tab.domain || tab.title));
      });
      main.appendChild(img);
    } else {
      main.appendChild(createFallbackIcon(tab.domain || tab.title));
    }

    const info = document.createElement('div');
    info.className = 'tab-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'tab-title';
    titleEl.textContent = tab.title || '(无标题)';
    info.appendChild(titleEl);

    const meta = document.createElement('div');
    meta.className = 'tab-meta';

    const domainEl = document.createElement('span');
    domainEl.className = 'tab-domain';
    domainEl.textContent = tab.domain || tab.url || '';
    meta.appendChild(domainEl);

    if (tab.active) {
      const b = document.createElement('span');
      b.className = 'badge badge-active';
      b.textContent = '当前';
      meta.appendChild(b);
    }
    if (tab.debuggerAttached) {
      const b = document.createElement('span');
      b.className = 'badge badge-debug';
      b.textContent = '调试中';
      meta.appendChild(b);
    }

    info.appendChild(meta);
    main.appendChild(info);

    const selBtn = document.createElement('button');
    selBtn.className = 'select-btn' + (tab.selected ? ' active' : '');
    selBtn.textContent = tab.selected ? '已选定' : '选定';
    selBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await sendMessage({ type: 'toggle_select_tab', tabId: tab.tabId });
      await refreshState();
    });

    item.appendChild(main);
    item.appendChild(selBtn);
    tabListEl.appendChild(item);
  }
}

function createFallbackIcon(text) {
  const el = document.createElement('div');
  el.className = 'favicon-fallback';
  el.textContent = (String(text || '?').trim()[0] || '?').toUpperCase();
  return el;
}

async function refreshState() {
  try {
    currentState = await sendMessage({ type: 'get_popup_state' });
    render();
  } catch (err) {
    errorBanner.textContent = `无法与后台通信: ${err?.message || err}`;
    errorBanner.classList.remove('hidden');
  }
}

enableToggle.addEventListener('change', async () => {
  await sendMessage({ type: 'set_enabled', enabled: enableToggle.checked });
  await refreshState();
});

cursorToggle.addEventListener('change', async () => {
  await sendMessage({ type: 'set_virtual_cursor', enabled: cursorToggle.checked });
  await refreshState();
});

syncModeSelect.addEventListener('change', async () => {
  await sendMessage({ type: 'set_slash_sync_mode', mode: syncModeSelect.value });
  await refreshState();
});

reconnectBtn.addEventListener('click', async () => {
  reconnectBtn.disabled = true;
  reconnectBtn.textContent = '重连中...';
  await sendMessage({ type: 'reconnect' });
  setTimeout(async () => {
    await refreshState();
    reconnectBtn.disabled = false;
    reconnectBtn.textContent = '重连';
  }, 450);
});

detachBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'detach_debugger' });
  await refreshState();
});

clearSelectedBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'clear_selected_tabs' });
  await refreshState();
});

searchInput.addEventListener('input', render);

refreshState();
