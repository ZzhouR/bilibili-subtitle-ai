// B站字幕 AI 助手 - 侧边栏：字幕浏览 + AI 对话
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
  const ctxBox = $("#ctxBox");
  const ctxText = $("#ctxText");
  const resizer = $("#subResizer");

  let tracks = [];
  let activeIndex = -1;
  let info = null;
  const selected = new Set(); // 选中的字幕行下标

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

  function fmt(s) {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = sec.toFixed(1).padStart(4, "0");
    return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
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

  // ---------- AI 对话 ----------
  let streamSeq = 0;
  let currentStreamId = null;
  const stopBtn = $("#stopBtn");

  stopBtn.addEventListener("click", () => {
    if (currentStreamId) {
      chrome.runtime.sendMessage({ type: "AI_STOP", id: currentStreamId }).catch(() => {});
    }
  });

  function showStop(show) { stopBtn.hidden = !show; }

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
    return body;
  }

  function lastAiBody() {
    const nodes = msgList.querySelectorAll(".msg.ai");
    if (!nodes.length) return null;
    const last = nodes[nodes.length - 1];
    return last.querySelector(".body");
  }

  function sendToAI(messages, opts) {
    const id = "s" + (++streamSeq);
    const body = addMsg("ai", "", "AI 思考中…");
    body.innerHTML = ""; // 清空占位
    const caret = document.createElement("span");
    caret.className = "caret";
    body.appendChild(caret);
    let done = false;

    const onStream = (m) => {
      if (m.id !== id) return;
      if (m.error) {
        done = true;
        body.lastChild && body.lastChild.remove();
        body.textContent = "⚠ " + m.error;
        body.classList.add("err");
        return;
      }
      if (m.done) {
        done = true;
        body.lastChild && body.lastChild.remove();
        return;
      }
      if (m.delta) {
        const txt = body.lastChild;
        if (txt && txt.className === "caret") txt.remove();
        body.textContent = body.textContent + m.delta;
        if (!body.lastChild || body.lastChild.className !== "caret") body.appendChild(caret);
        msgList.scrollTop = msgList.scrollHeight;
      }
    };

    const handler = (m) => { if (m && m.type === "AI_STREAM") onStream(m); };
    chrome.runtime.onMessage.addListener(handler);

    currentStreamId = id;
    showStop(true);
    chrome.runtime.sendMessage({ type: "AI_CHAT", id, messages, stream: true })
      .then(res => {
        if (res && !res.ok && !done) {
          body.lastChild && body.lastChild.remove();
          body.textContent = "⚠ " + (res.error || "请求失败");
          body.classList.add("err");
        }
      })
      .catch(e => {
        if (!done) {
          body.lastChild && body.lastChild.remove();
          body.textContent = "⚠ " + (e.message || e);
          body.classList.add("err");
        }
      })
      .finally(() => {
        chrome.runtime.onMessage.removeListener(handler);
        if (currentStreamId === id) { currentStreamId = null; showStop(false); }
      });
  }

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
      const ctx = ctxText.textContent.trim();
      const custom = input.value.trim();
      const messages = [];
      const userParts = [];
      if (ctx) userParts.push("【视频字幕】\n" + ctx);
      if (custom) userParts.push(custom);
      if (prompt) userParts.push(prompt);
      if (!userParts.length) {
        addMsg("sys", "请先附加字幕上下文或输入问题");
        return;
      }
      messages.push({ role: "user", content: userParts.join("\n\n") });
      addMsg("user", userParts.join("\n\n"));
      sendToAI(messages);
      input.value = "";
    });
  });

  chatForm.addEventListener("submit", e => {
    e.preventDefault();
    const custom = input.value.trim();
    const ctx = ctxText.textContent.trim();
    if (!custom && !ctx) { addMsg("sys", "请输入问题或先附加字幕上下文"); return; }
    const userParts = [];
    if (ctx) userParts.push("【视频字幕】\n" + ctx);
    if (custom) userParts.push(custom);
    const content = userParts.join("\n\n");
    addMsg("user", content);
    sendToAI([{ role: "user", content }]);
    input.value = "";
  });

  // ---------- 侧边栏状态通知 ----------
  // 打开侧边栏时通知视频页隐藏浮动字幕面板（避免重复展示）；关闭后自动恢复
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
  setInterval(() => notifySidePanelState(true), 30000); // 心跳：content 侧据此兜底恢复
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
