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
    let params = null;
    try { params = new URLSearchParams(location.search); } catch (_) { params = null; }
    let bvid = null;
    const urlMatch = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/);
    if (urlMatch) bvid = urlMatch[1];
    else if (/^\/list\//.test(location.pathname) && params) {
      const q = params.get("bvid") || "";
      if (/^BV[0-9A-Za-z]+$/.test(q)) bvid = q;
    }
    if (!bvid) return null;
    let cid = null;
    try {
      const st = window.__INITIAL_STATE__;
      if (st && st.videoData && st.videoData.cid) cid = st.videoData.cid;
    } catch (_) { /* ignore */ }
    return { bvid, cid };
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
    if (msg.type === "GET_PLAYBACK_TIME") {
      const v = findVideo();
      sendResponse({ ok: true, time: v ? v.currentTime || 0 : 0, duration: v ? (v.duration || 0) : 0 });
      return;
    }
    // 截图总结：暂停→（必要时）seek 到目标时间→画面稳定后返回视频元素位置（供后台截图裁剪）
    if (msg.type === "SEEK_VIDEO") {
      const v = findVideo();
      if (!v || typeof msg.time !== "number" || !isFinite(msg.time)) {
        sendResponse({ ok: false, error: "video 不可用" });
        return;
      }
      const wasPlaying = !v.paused;
      try { v.pause(); } catch (_) { /* ignore */ }
      const dur = v.duration && isFinite(v.duration) ? v.duration : msg.time;
      const target = Math.max(0, Math.min(msg.time, dur));
      // 目标就是当前帧（截取"当前画面"的常见情形）：写入同值不会触发 seeked，
      // 会白等 1500ms 超时，因此直接跳过 seek。
      const needSeek = Math.abs((v.currentTime || 0) - target) > 0.05;
      const settled = needSeek ? new Promise(resolve => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        const tm = setTimeout(fin, 1500);
        v.addEventListener("seeked", () => { clearTimeout(tm); fin(); }, { once: true });
        v.currentTime = target;
      }) : Promise.resolve();
      settled.then(() => {
        setTimeout(() => {
          const r = v.getBoundingClientRect();
          sendResponse({
            ok: true,
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            viewWidth: window.innerWidth,
            viewHeight: window.innerHeight,
          });
          if (wasPlaying) { try { v.play().catch(() => {}); } catch (_) { /* ignore */ } }
        }, needSeek ? 350 : 120);
      });
      return true; // 异步响应：必须返回 true 保持消息通道，否则 sendResponse 失效
    }
  });

  // 定时找 video（播放器延迟挂载）
  const pollVideo = setInterval(() => { if (findVideo()) clearInterval(pollVideo); }, 800);
  setTimeout(() => clearInterval(pollVideo), 60000);
})();
