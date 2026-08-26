// B站字幕 AI 助手 - 功能1：字幕提取（页面侧）
// 职责：识别视频页（bvid/cid/p）、收集当前视频信息、向 background 请求字幕并广播结果。
// SPA 切换检测：MutationObserver + popstate + pushState/replaceState 包装 + 轮询兜底。
// 通知协议：VIDEO_CHANGED（切换即刻）→ SUBTITLES_READY / SUBTITLES_ERROR（字幕就绪/失败，侧边栏据此拉取）。

(() => {
  if (window.__BILI_SUBTITLE_AI_EXTRACTOR__) return;
  window.__BILI_SUBTITLE_AI_EXTRACTOR__ = true;

  // 从 URL 与页面全局状态提取 bvid / cid / p（分P编号）
  // 兼容两种页面（与 manifest 的 content_scripts 匹配项一致）：
  //   /video/BVxxx           → bvid 在路径里
  //   /list/xxx?bvid=BVxxx   → 合集/列表播放页，bvid 在 query 里
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
    let p = null;
    try {
      const pRaw = params ? params.get("p") : null;
      if (pRaw && /^\d+$/.test(pRaw)) p = Number(pRaw);
    } catch (_) { /* ignore */ }

    let cid = null;
    // 1) 优先：分P列表（__INITIAL_STATE__.videoData.pages）按当前 p 匹配
    try {
      const st = window.__INITIAL_STATE__;
      const pages = st && st.videoData && st.videoData.pages;
      if (Array.isArray(pages)) {
        const target = p != null ? pages.find(pg => Number(pg.page) === p) : null;
        if (target && target.cid) cid = target.cid;
        else if (pages[0] && pages[0].cid && !cid) cid = pages[0].cid;
      }
      if (!cid && st && st.videoData && st.videoData.cid) cid = st.videoData.cid;
    } catch (_) { /* ignore */ }
    // 2) 兜底：播放器全局 aplayer（分P切换后返回当前分P数据）
    if (!cid && window.aplayer && window.aplayer.getVideoData) {
      try {
        const vd = window.aplayer.getVideoData();
        if (vd && vd.cid) cid = vd.cid;
      } catch (_) { /* ignore */ }
    }
    // cid 允许为空：由后台经 view 接口按 bvid+p 解析
    return { bvid, cid, p };
  }

  let currentKey = null;      // bvid:p，避免重复请求
  let currentTracks = null;
  let failCount = 0;
  let reqSeq = 0;             // 导航令牌：旧请求晚于新请求返回时必须丢弃

  async function requestSubtitles() {
    const info = parseVideoInfo();
    if (!info) return;
    const key = info.bvid + ":" + (info.p || 0);
    if (key === currentKey && currentTracks && failCount === 0) return;
    const seq = ++reqSeq;
    currentKey = key;
    currentTracks = null;
    broadcast({ type: "SUB_STATUS", status: "loading", bvid: info.bvid, cid: info.cid, p: info.p });
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_SUBTITLES", ...info });
      if (seq !== reqSeq) return; // 已被更新的导航替代，丢弃过期结果
      if (res && res.ok) {
        failCount = 0;
        currentTracks = res.tracks || [];
        const payload = {
          type: "SUB_READY",
          bvid: info.bvid,
          cid: res.cid || info.cid,
          p: info.p,
          tracks: currentTracks,
          fromCache: !!res.fromCache,
        };
        broadcast(payload);
        notifyExt({ type: "SUBTITLES_READY", bvid: info.bvid, p: info.p, hasTracks: !!currentTracks.length });
      } else {
        failCount++;
        const errText = (res && res.error) || "未知错误";
        broadcast({ type: "SUB_STATUS", status: "error", error: errText, retry: failCount <= 2 });
        if (failCount <= 2) setTimeout(requestSubtitles, 3000);
        else notifyExt({ type: "SUBTITLES_ERROR", error: errText });
      }
    } catch (e) {
      if (seq !== reqSeq) return;
      failCount++;
      broadcast({ type: "SUB_STATUS", status: "error", error: e.message || String(e), retry: failCount <= 2 });
      if (failCount <= 2) setTimeout(requestSubtitles, 3000);
      else notifyExt({ type: "SUBTITLES_ERROR", error: e.message || String(e) });
    }
  }

  // 向页面内其他模块广播
  function broadcast(detail) {
    window.dispatchEvent(new CustomEvent("bili-subtitle-ai", { detail }));
  }

  // 通知 background（由其统一转发给所有扩展页面，可靠链路）
  function notifyExt(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { /* ignore */ }
  }

  function onVideoChanged() {
    const info = parseVideoInfo();
    failCount = 0;
    // 已有同一视频（bvid+p）的字幕：直接重播，不必清空重拉
    if (info && currentTracks && currentKey === info.bvid + ":" + (info.p || 0)) {
      broadcast({ type: "SUB_READY", bvid: info.bvid, cid: info.cid, p: info.p, tracks: currentTracks, fromCache: true });
      notifyExt({ type: "SUBTITLES_READY", bvid: info.bvid, p: info.p, hasTracks: !!currentTracks.length });
      return;
    }
    currentKey = null;
    currentTracks = null;
    // 页面内事件：subtitle-view 据此清空旧 tracks
    broadcast({ type: "VIDEO_CHANGED", bvid: info ? info.bvid : null, p: info ? info.p : null });
    // 扩展链路：background 转发 → 侧边栏显示“加载中”
    notifyExt({ type: "VIDEO_CHANGED", bvid: info ? info.bvid : null, p: info ? info.p : null });
    // 等新分P数据注入后再请求字幕
    setTimeout(requestSubtitles, 800);
  }

  // ---------- SPA URL 变化检测（四通道） ----------
  let lastUrl = location.href;
  let lastKey = (() => { const i = parseVideoInfo(); return i ? i.bvid + ":" + (i.p || 0) : null; })();
  function checkUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const info = parseVideoInfo();
    const key = info ? info.bvid + ":" + (info.p || 0) : null;
    // 仅 bvid/分P 变化才算切换视频：过滤 ?t=/?vd_source= 等无关参数抖动
    if (key === lastKey) return;
    lastKey = key;
    onVideoChanged();
  }

  // 1) DOM 变化（B站播放器重建等）
  const observer = new MutationObserver(() => checkUrlChange());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // 2) 浏览器前进/后退
  window.addEventListener("popstate", checkUrlChange);
  // 3) history API 包装（分P切换 / SPA pushState）
  const wrap = fn => function (...args) {
    const r = fn.apply(this, args);
    setTimeout(checkUrlChange, 0);
    return r;
  };
  try {
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
  } catch (_) { /* ignore */ }
  // 4) 轮询兜底（800ms，开销可忽略）
  setInterval(checkUrlChange, 800);

  // 主动触发：初始加载 + 视频就绪后
  setTimeout(requestSubtitles, 1500);
  const tryLater = setInterval(() => {
    if (parseVideoInfo()) {
      clearInterval(tryLater);
      requestSubtitles();
    }
  }, 1000);
  setTimeout(() => clearInterval(tryLater), 30000);
})();
