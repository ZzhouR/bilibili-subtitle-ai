// B站字幕 AI 助手 - 功能1：字幕提取（页面侧）
// 职责：识别视频页（bvid/cid）、收集当前视频信息、向 background 请求字幕并广播结果

(() => {
  if (window.__BILI_SUBTITLE_AI_EXTRACTOR__) return;
  window.__BILI_SUBTITLE_AI_EXTRACTOR__ = true;

  const isVideoPage = () => /^\/video\//.test(location.pathname);

  // 从页面全局状态提取 bvid / cid（B站播放页注入 __INITIAL_STATE__）
  function parseVideoInfo() {
    const urlMatch = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/);
    const bvid = urlMatch ? urlMatch[1] : null;
    if (!bvid) return null;
    let cid = null;
    try {
      const st = window.__INITIAL_STATE__;
      if (st && st.videoData && st.videoData.cid) cid = st.videoData.cid;
    } catch (_) { /* ignore */ }
    // 兜底：从播放器全局 aplayer 读取
    if (!cid && window.aplayer && window.aplayer.getVideoData) {
      try {
        const vd = window.aplayer.getVideoData();
        if (vd && vd.cid) cid = vd.cid;
      } catch (_) { /* ignore */ }
    }
    // cid 允许为空：由后台通过 view 接口解析
    return { bvid, cid };
  }

  let currentBvid = null;   // 当前处理中的 bvid
  let currentTracks = null; // 成功的字幕结果
  let failCount = 0;        // 连续失败次数（用于自动重试）

  async function requestSubtitles() {
    const info = parseVideoInfo();
    if (!info) return;
    // 同一视频已成功加载则跳过；SPA 内 cid 从空变有值时也重新请求
    if (info.bvid === currentBvid && currentTracks && failCount === 0) return;
    currentBvid = info.bvid;
    currentTracks = null;
    broadcast({ type: "SUB_STATUS", status: "loading", bvid: info.bvid, cid: info.cid });
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_SUBTITLES", ...info });
      if (res && res.ok) {
        failCount = 0;
        currentTracks = res.tracks || [];
        broadcast({
          type: "SUB_READY",
          bvid: info.bvid,
          cid: res.cid || info.cid,
          tracks: currentTracks,
          fromCache: !!res.fromCache,
        });
      } else {
        failCount++;
        const errText = (res && res.error) || "未知错误";
        broadcast({
          type: "SUB_STATUS",
          status: "error",
          error: errText,
          retry: failCount <= 2,
        });
        if (failCount <= 2) setTimeout(requestSubtitles, 3000); // 自动重试最多 2 次
      }
    } catch (e) {
      failCount++;
      broadcast({
        type: "SUB_STATUS",
        status: "error",
        error: e.message || String(e),
        retry: failCount <= 2,
      });
      if (failCount <= 2) setTimeout(requestSubtitles, 3000);
    }
  }

  // 向页面内其他模块广播（subtitle-view、sidepanel 等）
  function broadcast(detail) {
    window.dispatchEvent(new CustomEvent("bili-subtitle-ai", { detail }));
  }

  // 监听页面变化：SPA 切换视频时重新提取
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // 通知扩展页面（侧边栏等）：已切换视频，自动刷新字幕
      try {
        const info = parseVideoInfo();
        chrome.runtime.sendMessage({ type: "VIDEO_CHANGED", bvid: info ? info.bvid : null }).catch(() => {});
      } catch (_) { /* ignore */ }
      setTimeout(requestSubtitles, 1200); // 等新视频数据注入
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 主动触发时机：初始加载 + 视频就绪后
  setTimeout(requestSubtitles, 1500);
  const tryLater = setInterval(() => {
    if (parseVideoInfo()) {
      clearInterval(tryLater);
      requestSubtitles();
    }
  }, 1000);
  setTimeout(() => clearInterval(tryLater), 30000);
})();
