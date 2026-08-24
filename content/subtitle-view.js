// B站字幕 AI 助手 - 播放同步服务（无 UI）
// 版本 0.7.0 起浮动字幕面板完全移除，字幕展示/同步滚动/点击跳转全部在侧边栏完成。
// 职责：监听 video 播放进度 → 为每条字幕轨道计算当前行 → 广播 PLAYBACK_HIGHLIGHT；响应跳转请求。
(() => {
  if (window.__BILI_SUBTITLE_AI_SYNC__) return;
  window.__BILI_SUBTITLE_AI_SYNC__ = true;

  let tracks = [];
  let currentInfo = null;
  let video = null;
  let lastVolley = ""; // 上次广播的索引签名，避免重复广播

  function findVideo() {
    if (video && !video.isConnected) video = null;
    if (video) return video;
    video = document.querySelector("video");
    if (video) {
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("seeked", onTimeUpdate);
      video.addEventListener("play", onTimeUpdate);
    }
    return video;
  }

  let ticking = false;
  function onTimeUpdate() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; broadcastHighlight(); });
  }

  // 二分查找当前时间对应的字幕行
  function findIndex(lines, t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (ans >= 0 && t <= lines[ans].end) return ans;
    return -1;
  }

  // 广播：所有轨道的当前行（侧边栏按自己选择的轨道消费）
  function broadcastHighlight() {
    const v = findVideo();
    if (!v || !tracks.length) return;
    const t = v.currentTime;
    const indexes = tracks.map((tr, ti) => ({ trackIndex: ti, index: findIndex(tr.lines || [], t) }));
    const sig = indexes.map(x => x.trackIndex + ":" + x.index).join("|");
    if (sig === lastVolley) return;
    lastVolley = sig;
    try {
      chrome.runtime.sendMessage({ type: "PLAYBACK_HIGHLIGHT", indexes }).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  function parseVideoInfo() {
    const urlMatch = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/);
    if (!urlMatch) return null;
    let cid = null;
    try {
      const st = window.__INITIAL_STATE__;
      if (st && st.videoData && st.videoData.cid) cid = st.videoData.cid;
    } catch (_) { /* ignore */ }
    return { bvid: urlMatch[1], cid };
  }

  // 接收 extractor 的字幕数据
  window.addEventListener("bili-subtitle-ai", e => {
    const d = e.detail || {};
    if (d.type === "SUB_READY") {
      tracks = d.tracks || [];
      currentInfo = { bvid: d.bvid, cid: d.cid || null, p: d.p || null };
      lastVolley = "";
      broadcastHighlight();
    } else if (d.type === "VIDEO_CHANGED" || d.type === "SUB_STATUS") {
      // 切换视频：立即清空旧字幕，避免侧边栏拉到旧数据；新数据由 SUBTITLES_READY 通知
      tracks = [];
      lastVolley = "";
      try {
        chrome.runtime.sendMessage({ type: "PLAYBACK_HIGHLIGHT", indexes: [] }).catch(() => {});
      } catch (_) { /* ignore */ }
    }
  });

  // popup / 侧边栏查询与跳转
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "GET_CURRENT_SUBTITLES") {
      const info = currentInfo || parseVideoInfo();
      sendResponse({ ok: true, tracks, info });
      return;
    }
    if (msg.type === "JUMP_TO_TIME") {
      const v = findVideo();
      if (v && typeof msg.time === "number" && isFinite(msg.time)) {
        v.currentTime = msg.time;
      }
      sendResponse({ ok: true });
      return;
    }
  });

  // 定时找 video（播放器延迟挂载）
  const pollVideo = setInterval(() => { if (findVideo()) clearInterval(pollVideo); }, 800);
  setTimeout(() => clearInterval(pollVideo), 60000);
})();
