// B站字幕 AI 助手 - 功能3：字幕随播放同步滚动 + 高亮 + 点击跳转 + 悬浮字幕条
(() => {
  if (window.__BILI_SUBTITLE_AI_VIEW__) return;
  window.__BILI_SUBTITLE_AI_VIEW__ = true;

  const STORAGE_KEY = "bili-subtitle-ai-preferences";

  let tracks = [];          // 全部字幕轨道
  let activeIndex = -1;     // 当前轨道
  let lines = [];           // 当前轨道行 [{start,end,text}]
  let video = null;
  let lastHighlight = -1;
  let currentInfo = null;
  let panelCollapsed = false;
  let floatingEnabled = false;

  // ---------- 样式 ----------
  const style = document.createElement("style");
  style.textContent = `
.bili-sub-ai-panel {
  position: fixed; right: 16px; top: 96px; z-index: 2147483000;
  width: 340px; max-width: 40vw; height: 62vh;
  display: flex; flex-direction: column;
  background: #fff; color: #18191c;
  border: 1px solid #e3e5e7; border-radius: 10px;
  font: 13px/1.6 "PingFang SC","Microsoft YaHei",sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,.14); overflow: hidden;
}
.bili-sub-ai-panel[data-collapsed="true"] { height: auto; }
.bili-sub-ai-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-bottom: 1px solid #e3e5e7; flex-wrap: wrap;
  background: #f9fafb;
}
.bili-sub-ai-title { font-weight: 700; font-size: 13px; color: #fb7299; white-space: nowrap; }
.bili-sub-ai-track {
  flex: 1; min-width: 90px; background: #fff; color: #18191c;
  border: 1px solid #e3e5e7; border-radius: 6px; padding: 3px 6px; font-size: 12px;
}
.bili-sub-ai-track:focus { border-color: #00a1d6; outline: none; }
.bili-sub-ai-btn {
  background: #fff; color: #61666d; border: 1px solid #e3e5e7;
  border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer;
  transition: color .15s, border-color .15s;
}
.bili-sub-ai-btn:hover { color: #00a1d6; border-color: #00a1d6; }
.bili-sub-ai-list {
  flex: 1; overflow-y: auto; padding: 6px 0; scroll-behavior: auto;
}
.bili-sub-ai-line {
  display: flex; gap: 8px; padding: 5px 12px; cursor: pointer;
  border-left: 3px solid transparent; transition: background .15s;
}
.bili-sub-ai-line:hover { background: #f1f2f3; }
.bili-sub-ai-line.active {
  background: rgba(251,114,153,.10); border-left-color: #fb7299;
}
.bili-sub-ai-time {
  color: #9499a0; font-variant-numeric: tabular-nums; font-size: 12px;
  flex-shrink: 0; min-width: 62px; padding-top: 1px;
}
.bili-sub-ai-text { flex: 1; word-break: break-word; white-space: pre-wrap; }
.bili-sub-ai-empty { padding: 24px 16px; text-align: center; color: #9499a0; }
.bili-sub-ai-float {
  position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%);
  z-index: 2147483000; max-width: 72vw; text-align: center;
  background: rgba(0,0,0,.72); color: #fff; border-radius: 8px;
  padding: 8px 18px; font: 15px/1.5 "PingFang SC","Microsoft YaHei",sans-serif;
  pointer-events: none; box-shadow: 0 4px 20px rgba(0,0,0,.4);
  transition: opacity .18s;
}
.bili-sub-ai-float[hidden] { display: none; }
`;
  (document.head || document.documentElement).appendChild(style);

  // ---------- DOM ----------
  const panel = document.createElement("div");
  panel.className = "bili-sub-ai-panel";
  panel.innerHTML = `
  <div class="bili-sub-ai-head">
    <span class="bili-sub-ai-title">📝 字幕</span>
    <select class="bili-sub-ai-track" title="选择字幕轨道"><option value="-1">加载中…</option></select>
    <button class="bili-sub-ai-btn" data-act="float" title="悬浮字幕条">悬浮</button>
    <button class="bili-sub-ai-btn" data-act="collapse" title="折叠">—</button>
  </div>
  <div class="bili-sub-ai-list"></div>`;
  document.body.appendChild(panel);

  const trackSelect = panel.querySelector(".bili-sub-ai-track");
  const listEl = panel.querySelector(".bili-sub-ai-list");

  const floatEl = document.createElement("div");
  floatEl.className = "bili-sub-ai-float";
  floatEl.hidden = true;
  document.body.appendChild(floatEl);

  // ---------- 工具 ----------
  const fmt = s => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = sec.toFixed(1).padStart(4, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };

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
    requestAnimationFrame(() => { ticking = false; highlightCurrent(); });
  }

  // 二分查找当前时间对应的字幕行
  function findIndex(t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (ans >= 0 && t <= lines[ans].end) return ans;
    return -1;
  }

  function highlightCurrent() {
    const v = findVideo();
    if (!v || !lines.length) return;
    const idx = findIndex(v.currentTime);
    if (idx === lastHighlight) return;
    lastHighlight = idx;
    const rows = listEl.querySelectorAll(".bili-sub-ai-line");
    rows.forEach((el, i) => el.classList.toggle("active", i === idx));
    // 通知侧边栏同步高亮/滚动（轨道索引 + 行索引）
    try {
      chrome.runtime.sendMessage({ type: "PLAYBACK_HIGHLIGHT", trackIndex: activeIndex, index: idx }).catch(() => {});
    } catch (_) { /* ignore */ }
    if (idx >= 0) {
      const el = rows[idx];
      if (el) el.scrollIntoView({ block: "center", behavior: "auto" });
      if (floatingEnabled) {
        floatEl.textContent = lines[idx].text;
        floatEl.hidden = false;
      }
    } else if (floatingEnabled) {
      floatEl.hidden = true;
    }
  }

  // ---------- 渲染 ----------
  function renderLines() {
    listEl.innerHTML = "";
    lastHighlight = -1;
    if (!lines.length) {
      const empty = document.createElement("div");
      empty.className = "bili-sub-ai-empty";
      empty.textContent = "该视频暂无可用字幕";
      listEl.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    lines.forEach((line, i) => {
      const row = document.createElement("div");
      row.className = "bili-sub-ai-line";
      row.dataset.index = String(i);
      const t = document.createElement("span");
      t.className = "bili-sub-ai-time";
      t.textContent = fmt(line.start);
      const tx = document.createElement("span");
      tx.className = "bili-sub-ai-text";
      tx.textContent = line.text;
      row.appendChild(t); row.appendChild(tx);
      row.addEventListener("click", () => {
        const v = findVideo();
        if (v && line.start != null) v.currentTime = line.start;
      });
      frag.appendChild(row);
    });
    listEl.appendChild(frag);
    highlightCurrent();
  }

  function renderTracks() {
    trackSelect.innerHTML = "";
    if (!tracks.length) {
      const opt = document.createElement("option");
      opt.value = "-1"; opt.textContent = "暂无字幕";
      trackSelect.appendChild(opt);
      lines = [];
      renderLines();
      return;
    }
    tracks.forEach((tr, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `${tr.lan_doc || tr.lan || ("轨道 " + (i + 1))}（${tr.lines.length} 条）`;
      trackSelect.appendChild(opt);
    });
    let idx = 0;
    try {
      const prefs = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const saved = prefs.activeTrack;
      if (typeof saved === "number" && saved >= 0 && saved < tracks.length) idx = saved;
    } catch (_) { /* ignore */ }
    trackSelect.value = String(idx);
    setActiveTrack(idx);
  }

  function setActiveTrack(idx) {
    activeIndex = idx;
    lines = (tracks[idx] && tracks[idx].lines) || [];
    renderLines();
    try {
      const prefs = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      prefs.activeTrack = idx;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (_) { /* ignore */ }
    broadcast({ type: "TRACK_CHANGED", index: idx, lines });
  }

  // ---------- 事件 ----------
  trackSelect.addEventListener("change", () => setActiveTrack(Number(trackSelect.value)));

  panel.addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "collapse") {
      panelCollapsed = !panelCollapsed;
      panel.dataset.collapsed = String(panelCollapsed);
      listEl.style.display = panelCollapsed ? "none" : "";
      btn.textContent = panelCollapsed ? "▢" : "—";
    } else if (btn.dataset.act === "float") {
      floatingEnabled = !floatingEnabled;
      btn.textContent = floatingEnabled ? "悬浮✓" : "悬浮";
      if (!floatingEnabled) floatEl.hidden = true;
      else highlightCurrent();
    }
  });

  // 可拖拽（按住标题区域拖动）
  let drag = null;
  const head = panel.querySelector(".bili-sub-ai-head");
  head.addEventListener("mousedown", e => {
    if (e.target.closest("select,button")) return;
    drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop };
    e.preventDefault();
  });
  document.addEventListener("mousemove", e => {
    if (!drag) return;
    panel.style.left = Math.max(0, e.clientX - drag.dx) + "px";
    panel.style.top = Math.max(0, e.clientY - drag.dy) + "px";
    panel.style.right = "auto";
  });
  document.addEventListener("mouseup", () => { drag = null; });

  // ---------- 消息通信 ----------
  function broadcast(detail) {
    window.dispatchEvent(new CustomEvent("bili-subtitle-ai", { detail }));
  }

  window.addEventListener("bili-subtitle-ai", e => {
    const d = e.detail || {};
    if (d.type === "SUB_READY") {
      tracks = d.tracks || [];
      currentInfo = { bvid: d.bvid, cid: d.cid };
      renderTracks();
    } else if (d.type === "SUB_STATUS" && d.status === "loading") {
      const opt = document.createElement("option");
      opt.value = "-1"; opt.textContent = "字幕加载中…";
      trackSelect.innerHTML = "";
      trackSelect.appendChild(opt);
      lines = [];
      renderLines();
    } else if (d.type === "SUB_STATUS" && d.status === "error") {
      const opt = document.createElement("option");
      opt.value = "-1"; opt.textContent = "字幕获取失败";
      trackSelect.innerHTML = "";
      trackSelect.appendChild(opt);
      const retryTip = d.retry ? "（3 秒后自动重试…）" : "";
      listEl.innerHTML = `<div class="bili-sub-ai-empty">字幕获取失败：${(d.error || "未知错误").replace(/</g,"&lt;")} ${retryTip}</div>`;
    }
  });

  // 供 sidepanel 查询当前字幕
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "GET_CURRENT_SUBTITLES") {
      sendResponse({ ok: true, tracks, activeIndex, info: currentInfo });
      return;
    }
    if (msg.type === "SET_ACTIVE_TRACK") {
      if (typeof msg.index === "number" && msg.index >= 0 && msg.index < tracks.length) {
        setActiveTrack(msg.index);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "轨道索引无效" });
      }
      return;
    }
    if (msg.type === "SIDEPANEL_STATE") {
      applySidePanelState(msg.open);
      sendResponse({ ok: true });
      return;
    }
  });

  // 侧边栏打开时隐藏浮动字幕面板（内容已并入侧边栏），关闭后恢复
  let sidePanelOpen = false;
  let lastHeartbeat = 0;
  function applySidePanelState(open) {
    sidePanelOpen = !!open;
    lastHeartbeat = Date.now();
    panel.style.display = sidePanelOpen ? "none" : "";
  }
  // 兜底：心跳停止（侧边栏已关闭但未收到通知）超过 150 秒后恢复浮动面板
  setInterval(() => {
    if (sidePanelOpen && Date.now() - lastHeartbeat > 150000) {
      sidePanelOpen = false;
      panel.style.display = "";
    }
  }, 15000);

  // 定时找 video（播放器延迟挂载）
  const pollVideo = setInterval(() => { if (findVideo()) clearInterval(pollVideo); }, 800);
  setTimeout(() => clearInterval(pollVideo), 60000);
})();
