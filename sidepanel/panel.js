// B站字幕 AI 助手 - 侧边栏：字幕浏览 + AI 对话（自动知识库 / 播放同步 / 历史 CRUD）
(() => {
  const $ = sel => document.querySelector(sel);
  const statusEl = $("#status");
  const trackBar = $("#trackBar");
  const trackSelect = $("#trackSelect");
  const subList = $("#subList");
  const lineCount = $("#lineCount");
  const msgList = $("#msgList");
  const chatForm = $("#chatForm");
  const input = $("#input");
  const sendBtn = $("#sendBtn");
  const stopBtn = $("#stopBtn");
  const ctxBox = $("#ctxBox");
  const ctxText = $("#ctxText");
  const resizer = $("#subResizer");
  const mainView = $("#mainView");
  const historyView = $("#historyView");
  const historyBtn = $("#historyBtn");
  const historySearch = $("#historySearch");
  const historyList = $("#historyList");
  const historyCount = $("#historyCount");

  let tracks = [];
  let activeIndex = -1;
  let info = null;
  const selected = new Set(); // 选中的字幕行下标
  let streamSeq = 0;
  let currentStreamId = null;
  let historyVisible = false;

  // ---------- 状态 ----------
  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = "p-status" + (kind ? " " + kind : "");
  }

  // ---------- 字幕加载 ----------
  async function loadSubtitles() {
    setStatus("正在读取当前页面字幕…");
    subList.innerHTML = '<div class="p-empty">加载中…</div>';
    trackBar.hidden = true;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !/^https:\/\/(www\.)?bilibili\.com\/video\//.test(tab.url || "")) {
        setStatus("请先打开一个 B 站视频页（www.bilibili.com/video/…）", "err");
        subList.innerHTML = '<div class="p-empty">当前标签页不是 B 站视频页</div>';
        return;
      }
      const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_CURRENT_SUBTITLES" });
      if (!res || !res.ok) {
        setStatus("视频页扩展未就绪，请刷新页面后重试", "err");
        subList.innerHTML = '<div class="p-empty">未获取到字幕：请刷新视频页</div>';
        return;
      }
      tracks = res.tracks || [];
      info = res.info || null;
      activeIndex = (typeof res.activeIndex === "number" ? res.activeIndex : 0);
      if (!tracks.length) {
        setStatus("已连接视频页，但该视频暂无字幕", "ok");
        subList.innerHTML = '<div class="p-empty">该视频暂无可用字幕（或需要登录后刷新）</div>';
        trackBar.hidden = true;
        return;
      }
      trackBar.hidden = false;
      renderTracks();
      setStatus("字幕就绪：" + tracks.length + " 条轨道" + (info ? "（" + info.bvid + "）" : ""), "ok");
      renderLines();
    } catch (e) {
      setStatus("读取字幕失败：" + (e.message || e), "err");
      subList.innerHTML = '<div class="p-empty">读取字幕失败，请刷新视频页重试</div>';
    }
  }

  function renderTracks() {
    trackSelect.innerHTML = "";
    tracks.forEach((tr, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = (tr.lan_doc || tr.lan || "轨道 " + (i + 1)) + "（" + tr.lines.length + " 条）";
      trackSelect.appendChild(opt);
    });
    if (activeIndex >= 0 && activeIndex < tracks.length) trackSelect.value = String(activeIndex);
  }

  function renderLines() {
    const lines = activeIndex >= 0 && tracks[activeIndex] ? tracks[activeIndex].lines : [];
    lineCount.textContent = lines.length ? lines.length + " 条" : "";
    subList.innerHTML = "";
    if (!lines.length) {
      subList.innerHTML = '<div class="p-empty">暂无字幕行</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    lines.forEach((line, i) => {
      const row = document.createElement("div");
      row.className = "p-line" + (selected.has(i) ? " sel" : "");
      row.dataset.index = String(i);
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = fmt(line.start);
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = line.text;
      row.appendChild(t); row.appendChild(x);
      row.addEventListener("click", () => {
        if (selected.has(i)) selected.delete(i); else selected.add(i);
        row.classList.toggle("sel", selected.has(i));
      });
      frag.appendChild(row);
    });
    subList.appendChild(frag);
  }

  // 播放同步：content 广播的高亮行
  function highlightSidebarIndex(trackIndex, idx) {
    if (trackIndex !== activeIndex) return;
    const rows = subList.querySelectorAll(".p-line");
    rows.forEach((el, i) => el.classList.toggle("now", i === idx));
    if (idx >= 0 && rows[idx]) rows[idx].scrollIntoView({ block: "center", behavior: "auto" });
  }

  function fmt(s) {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = sec.toFixed(1).padStart(4, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ---------- 字幕上下文 ----------
  function currentLines() {
    return activeIndex >= 0 && tracks[activeIndex] ? tracks[activeIndex].lines : [];
  }

  function buildContextText(lines) {
    return lines.map(l => "[" + fmt(l.start) + "] " + l.text).join("\n");
  }

  function setContext(text) {
    ctxText.textContent = text;
    ctxBox.hidden = !text;
  }

  // ---------- 消息渲染 ----------
  function addMsg(role, text, tag) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    if (tag) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = tag;
      div.appendChild(t);
    }
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = text;
    div.appendChild(body);
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
    return div;
  }

  // ---------- 历史存储（CRUD） ----------
  const HISTORY_KEY = "chatHistory";
  const HISTORY_LIMIT = 100;

  async function loadHistory() {
    try {
      const store = await chrome.storage.local.get(HISTORY_KEY);
      return store[HISTORY_KEY] || [];
    } catch (_) { return []; }
  }

  async function persistHistory(list) {
    try {
      await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(-HISTORY_LIMIT) });
    } catch (_) { /* ignore */ }
  }

  function genId() { return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  let currentRecord = null; // {id,title,bvid,createdAt,updatedAt,messages,autoContext}

  async function saveCurrentRecord() {
    if (!currentRecord) return;
    const list = await loadHistory();
    const idx = list.findIndex(r => r.id === currentRecord.id);
    if (idx >= 0) list[idx] = currentRecord; else list.push(currentRecord);
    await persistHistory(list);
  }

  // ---------- AI 对话（自动知识库 + 流式 + 历史记录） ----------
  const aiStreams = new Map(); // streamId -> {body, textEl, caretEl, fullText, saved}

  function handleStream(m) {
    const s = aiStreams.get(m.id);
    if (!s) return;
    if (m.error) { finishStream(s, null, "⚠ " + m.error, true); return; }
    if (m.done) { finishStream(s, s.fullText, null, false); return; }
    if (m.delta) {
      s.fullText += m.delta;
      s.textEl.textContent = s.fullText;
      if (s.textEl.lastChild !== s.caretEl) s.textEl.appendChild(s.caretEl);
      msgList.scrollTop = msgList.scrollHeight;
    }
  }

  function finishStream(s, aiText, errText, isErr) {
    if (s.saved) return;
    s.saved = true;
    s.caretEl.remove();
    if (isErr) {
      s.textEl.textContent = errText;
      s.textEl.classList.add("err");
    } else {
      s.textEl.textContent = aiText || s.fullText || "";
    }
    msgList.scrollTop = msgList.scrollHeight;
    // 追加 AI 回复并保存历史（增/改）
    if (currentRecord) {
      if (!isErr && s.fullText) currentRecord.messages.push({ role: "ai", content: s.fullText });
      currentRecord.updatedAt = Date.now();
      saveCurrentRecord();
    }
    aiStreams.delete(s.id);
  }

  function sendUserMessage(userText) {
    const text = String(userText || "").trim();
    if (!text) { addMsg("sys", "请输入提问内容"); return; }

    // 自动知识库：未手动附加上下文时，自动附带当前字幕全文
    let ctx = ctxText.textContent.trim();
    let autoCtx = false;
    if (!ctx) {
      const lines = currentLines();
      if (lines.length) {
        ctx = buildContextText(lines);
        autoCtx = true;
      }
    }
    const messages = [];
    if (ctx) messages.push({ role: "user", content: "【视频字幕知识库】\n" + ctx });
    messages.push({ role: "user", content: text });

    // 历史记录（当前对话）
    if (!currentRecord) {
      currentRecord = {
        id: genId(),
        title: "",
        bvid: info ? info.bvid : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        autoContext: false
      };
    }
    if (!currentRecord.title) currentRecord.title = text.slice(0, 24) || "未命名对话";
    currentRecord.autoContext = currentRecord.autoContext || autoCtx;
    currentRecord.messages.push({ role: "user", content: text });
    currentRecord.updatedAt = Date.now();

    if (autoCtx) addMsg("sys", "已自动附带字幕知识库（当前轨道 " + currentLines().length + " 行）");
    else if (ctx) addMsg("sys", "已附带字幕上下文");
    addMsg("user", text);

    const id = "s" + (++streamSeq);
    const body = addMsg("ai", "", "AI 思考中…");
    body.innerHTML = "";
    const textEl = document.createElement("span");
    const caretEl = document.createElement("span");
    caretEl.className = "caret";
    textEl.appendChild(caretEl);
    body.appendChild(textEl);
    const s = { id, body, textEl, caretEl, fullText: "", saved: false };
    aiStreams.set(id, s);

    currentStreamId = id;
    showStop(true);
    chrome.runtime.sendMessage({ type: "AI_CHAT", id, messages, stream: true })
      .then(res => {
        if (res && !res.ok) {
          const cur = aiStreams.get(id);
          if (cur) finishStream(cur, null, "⚠ " + (res.error || "请求失败"), true);
        }
      })
      .catch(e => {
        const cur = aiStreams.get(id);
        if (cur) finishStream(cur, null, "⚠ " + (e.message || e), true);
      })
      .finally(() => {
        if (currentStreamId === id) { currentStreamId = null; showStop(false); }
      });
  }

  function showStop(show) { stopBtn.hidden = !show; }

  // ---------- 历史视图（查/改/删） ----------
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, "0");
    return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  async function renderHistoryList() {
    const list = (await loadHistory()).slice().reverse();
    const q = (historySearch.value || "").trim().toLowerCase();
    const items = q
      ? list.filter(r => (r.title || "").toLowerCase().includes(q) || (r.messages || []).some(m => (m.content || "").toLowerCase().includes(q)))
      : list;
    historyCount.textContent = list.length + " 条";
    historyList.innerHTML = "";
    if (!items.length) {
      historyList.innerHTML = '<div class="p-empty">' + (q ? "无匹配记录" : "暂无对话记录，去聊一句吧") + "</div>";
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach(rec => {
      const item = document.createElement("div");
      item.className = "h-item";
      const main = document.createElement("div");
      main.className = "h-main";
      main.title = "点击载入此对话";
      const t = document.createElement("div");
      t.className = "h-title";
      t.textContent = rec.title || "未命名对话";
      const meta = document.createElement("div");
      meta.className = "h-meta";
      meta.textContent = (rec.bvid || "未知视频") + " · " + (rec.messages ? rec.messages.length : 0) + " 条消息 · " + fmtTime(rec.updatedAt || rec.createdAt);
      main.appendChild(t); main.appendChild(meta);
      const ops = document.createElement("div");
      ops.className = "h-ops";
      const ren = document.createElement("button");
      ren.className = "btn small"; ren.dataset.act = "rename"; ren.textContent = "✎"; ren.title = "重命名";
      const del = document.createElement("button");
      del.className = "btn small"; del.dataset.act = "del"; del.textContent = "🗑"; del.title = "删除";
      ops.appendChild(ren); ops.appendChild(del);
      item.appendChild(main); item.appendChild(ops);
      item.addEventListener("click", e => {
        const op = e.target.closest("[data-act]");
        if (op && op.dataset.act === "rename") {
          const name = prompt("重命名对话", rec.title || "");
          if (name != null) {
            rec.title = name.trim() || rec.title;
            persistHistoryItem(rec);
            renderHistoryList();
          }
        } else if (op && op.dataset.act === "del") {
          if (confirm("删除这条对话记录？")) {
            const remain = list.filter(r => r.id !== rec.id);
            persistHistory(remain);
            if (currentRecord && currentRecord.id === rec.id) currentRecord = null;
            renderHistoryList();
          }
        } else {
          openRecord(rec.id);
        }
      });
      frag.appendChild(item);
    });
    historyList.appendChild(frag);
  }

  async function persistHistoryItem(rec) {
    const all = await loadHistory();
    const idx = all.findIndex(r => r.id === rec.id);
    if (idx >= 0) all[idx] = Object.assign({}, all[idx], rec);
    await persistHistory(all);
  }

  async function openRecord(id) {
    const list = await loadHistory();
    const rec = list.find(r => r.id === id);
    if (!rec) return;
    currentRecord = {
      id: rec.id,
      title: rec.title || "未命名对话",
      bvid: rec.bvid || null,
      createdAt: rec.createdAt || Date.now(),
      updatedAt: rec.updatedAt || Date.now(),
      messages: JSON.parse(JSON.stringify(rec.messages || [])),
      autoContext: !!rec.autoContext
    };
    msgList.innerHTML = "";
    const sameVideo = !!(info && rec.bvid && info.bvid === rec.bvid);
    addMsg("sys", rec.autoContext
      ? (sameVideo ? "已附带字幕知识库（当前视频）" : "此对话附带其他视频的字幕知识库")
      : "历史对话（未附带字幕知识库）");
    (currentRecord.messages || []).forEach(m => addMsg(m.role, m.content));
    showHistory(false);
    setStatus(sameVideo ? "已载入历史对话" : "已载入历史对话（字幕与当前视频不一致）", sameVideo ? "ok" : "err");
  }

  function showHistory(show) {
    historyVisible = !!show;
    mainView.hidden = historyVisible;
    historyView.hidden = !historyVisible;
    historyBtn.textContent = historyVisible ? "◀ 对话" : "📚 历史";
    historyBtn.title = historyVisible ? "返回对话" : "查看对话历史";
    if (historyVisible) renderHistoryList();
  }

  // ---------- 全局消息监听 ----------
  chrome.runtime.onMessage.addListener(msg => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "AI_STREAM") handleStream(msg);
    else if (msg.type === "PLAYBACK_HIGHLIGHT") highlightSidebarIndex(msg.trackIndex, msg.index);
    else if (msg.type === "VIDEO_CHANGED") {
      // 打开新视频：自动刷新字幕，清空勾选与手动上下文（保留当前对话与历史）
      selected.clear();
      setContext("");
      loadSubtitles();
    }
  });

  // ---------- 事件绑定 ----------
  trackSelect.addEventListener("change", () => {
    activeIndex = Number(trackSelect.value);
    selected.clear();
    renderLines();
  });

  $("#reloadBtn").addEventListener("click", loadSubtitles);
  $("#selAllBtn").addEventListener("click", () => {
    currentLines().forEach((_, i) => selected.add(i));
    renderLines();
  });
  $("#selClearBtn").addEventListener("click", () => { selected.clear(); renderLines(); });

  $("#ctxSelBtn").addEventListener("click", () => {
    const lines = currentLines().filter((_, i) => selected.has(i));
    if (!lines.length) { setContext(""); addMsg("sys", "请先勾选字幕行"); return; }
    setContext(buildContextText(lines));
  });
  $("#ctxAllBtn").addEventListener("click", () => setContext(buildContextText(currentLines())));
  $("#ctxClearBtn").addEventListener("click", () => setContext(""));

  document.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const prompt = chip.dataset.prompt || "";
      const custom = input.value.trim();
      sendUserMessage(prompt + (custom ? "\n\n" + custom : ""));
      input.value = "";
    });
  });

  chatForm.addEventListener("submit", e => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) { sendUserMessage(text); input.value = ""; }
  });

  stopBtn.addEventListener("click", () => {
    if (currentStreamId) {
      chrome.runtime.sendMessage({ type: "AI_STOP", id: currentStreamId }).catch(() => {});
    }
  });

  historyBtn.addEventListener("click", () => showHistory(!historyVisible));
  $("#newChatBtn").addEventListener("click", () => {
    showHistory(false);
    currentRecord = null;
    msgList.innerHTML = "";
    setStatus("新对话（发送提问时会自动附带当前字幕）", "ok");
  });
  historySearch.addEventListener("input", renderHistoryList);

  // ---------- 侧边栏状态通知 ----------
  async function notifySidePanelState(open) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (tab && tab.id != null) {
        await chrome.tabs.sendMessage(tab.id, { type: "SIDEPANEL_STATE", open: !!open });
      }
    } catch (_) { /* 视频页未就绪时忽略 */ }
  }
  notifySidePanelState(true);
  setInterval(() => notifySidePanelState(true), 30000); // 心跳
  document.addEventListener("visibilitychange", () => {
    notifySidePanelState(document.visibilityState === "visible");
  });
  window.addEventListener("pagehide", () => notifySidePanelState(false));

  // ---------- 字幕区高度拖拽（上下区域可调节） ----------
  const SPLIT_KEY = "bili-subtitle-ai-panel-split";
  const savedSplit = Number(localStorage.getItem(SPLIT_KEY));
  if (savedSplit) {
    document.body.style.setProperty("--subtitle-h", Math.min(70, Math.max(15, savedSplit)) + "%");
  }
  resizer.addEventListener("mousedown", e => {
    e.preventDefault();
    const startY = e.clientY;
    const startPct = (() => {
      const v = document.body.style.getPropertyValue("--subtitle-h");
      if (v) return parseFloat(v) || 38;
      return parseFloat(getComputedStyle(document.body).getPropertyValue("--subtitle-h")) || 38;
    })();
    const onMove = ev => {
      const pct = Math.min(70, Math.max(15, startPct + ((ev.clientY - startY) / window.innerHeight) * 100));
      document.body.style.setProperty("--subtitle-h", pct + "%");
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      resizer.classList.remove("drag");
      const pct = Math.min(70, Math.max(15, parseFloat(document.body.style.getPropertyValue("--subtitle-h")) || 38));
      localStorage.setItem(SPLIT_KEY, String(Math.round(pct)));
    };
    resizer.classList.add("drag");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 初始加载
  loadSubtitles();
})();
