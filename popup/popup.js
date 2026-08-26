// 工具栏弹窗：显示当前页面状态 + 快捷入口
(() => {
  const statusEl = document.getElementById("status");
  const panelBtn = document.getElementById("panelBtn");
  const verEl = document.getElementById("ver");

  chrome.runtime.sendMessage({ type: "PING" }).then(res => {
    if (res && res.ok) verEl.textContent = res.version;
  }).catch(() => {});

  async function init() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    // 与 manifest content_scripts 一致：/video/ 与 /list/（合集播放页）
    const isVideo = tab && /^https:\/\/(www\.)?bilibili\.com\/(video\/|list\/)/.test(tab.url || "");
    if (!isVideo) {
      statusEl.textContent = "当前页面不是 B 站视频页";
      statusEl.className = "status";
      return;
    }
    statusEl.textContent = "正在读取字幕状态…";
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_CURRENT_SUBTITLES" });
      if (res && res.ok && res.tracks && res.tracks.length) {
        const total = res.tracks.reduce((n, t) => n + (t.lines ? t.lines.length : 0), 0);
        statusEl.textContent = "✅ 已加载 " + res.tracks.length + " 条轨道，共 " + total + " 行字幕";
        statusEl.className = "status ok";
      } else {
        statusEl.textContent = "视频页已就绪，但暂无字幕数据（请刷新页面）";
        statusEl.className = "status";
      }
    } catch (e) {
      statusEl.textContent = "请刷新视频页后重试（扩展未注入）";
      statusEl.className = "status err";
    }
  }

  panelBtn.addEventListener("click", async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (tab) await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (e) {
      statusEl.textContent = "打开侧边栏失败：" + (e.message || e);
      statusEl.className = "status err";
    }
  });

  document.getElementById("optBtn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  init().then(() => { panelBtn.disabled = false; });
})();
