// B站字幕 AI 助手 - 侧边栏（v0.7.0）
// 字幕展示/同步滚动/点击跳转/当前句条全部在此；浮动面板已移除。
// AI 对话：自动知识库、流式（含 depth-reasoner 思考过程）、Markdown 渲染、历史记录。
(() => {
  const $ = sel => document.querySelector(sel);
  const statusEl = $("#status");
  const trackBar = $("#trackBar");
  const trackSelect = $("#trackSelect");
  const subList = $("#subList");
  const nowLine = $("#nowLine");
  const lineCount = $("#lineCount");
  const msgList = $("#msgList");
  const chatForm = $("#chatForm");
  const input = $("#input");
  const stopBtn = $("#stopBtn");
  const ctxBox = $("#ctxBox");
  const ctxText = $("#ctxText");
  const resizer = $("#subResizer");
  const md = window.MarkdownLib;
  const summaryView = $("#summaryView");
  const summaryStatus = $("#summaryStatus");
  const summaryBar = $("#summaryBar");
  const summarySegs = $("#summarySegs");
  const summaryResult = $("#summaryResult");
  const summaryBtn = $("#summaryBtn");
  const summaryStopBtn = $("#summaryStopBtn");

  let tracks = [];
  let activeIndex = -1;
  let info = null;
  let nowTrackIndex = -1; // 当前高亮（侧边栏轨道内）
  let nowLineIndex = -1;  // 当前高亮行（所有轨道中带索引）
  const selected = new Set();
  let streamSeq = 0;
  let currentStreamId = null;
  let videoSwitchTimer = null; // 切换后未收到就绪通知时的兜底刷新

  // ---------- 状态 ----------
  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = "p-status" + (kind ? " " + kind : "");
  }

  // ---------- 当前活动标签页（实时查询，绝不缓存：用户在多个标签页间切换时必须跟随） ----------
  let subLoadSeq = 0;      // 加载序号：防止快速切换时旧请求结果覆盖新标签
  let refreshTimer = null; // 防抖：标签切换/导航事件合并

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadSubtitles, delay == null ? 400 : delay);
  }

  // ---------- 字幕加载（跟随当前活动标签页） ----------
  async function loadSubtitles() {
    const seq = ++subLoadSeq;
    try {
      const tab = await getActiveTab();
      if (!tab) {
        if (seq !== subLoadSeq) return;
        setStatus("未找到当前标签页", "err");
        subList.innerHTML = '<div class="p-empty">未找到当前标签页</div>';
        return;
      }
      if (!/^https:\/\/(www\.)?bilibili\.com\/video\//.test(tab.url || "")) {
        if (seq !== subLoadSeq) return;
        setStatus("当前标签页不是 B 站视频页（可切换到视频标签页）");
        trackBar.hidden = true;
        lineCount.textContent = "";
        subList.innerHTML = '<div class="p-empty">当前标签页不是 B 站视频页，请切换到视频标签页</div>';
        return;
      }
      setStatus("正在读取当前页面字幕…");
      subList.innerHTML = '<div class="p-empty">加载中…</div>';
      trackBar.hidden = true;

      const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_CURRENT_SUBTITLES" });
      if (seq !== subLoadSeq) return; // 已被更新的加载替代
      if (!res || !res.ok) {
        setStatus("视频页扩展未就绪，请刷新页面后重试", "err");
        subList.innerHTML = '<div class="p-empty">未获取到字幕：请刷新视频页后重试</div>';
        return;
      }
      tracks = res.tracks || [];
      info = res.info || null;
      if (activeIndex < 0 || activeIndex >= tracks.length) activeIndex = 0;
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
      if (seq !== subLoadSeq) return;
      setStatus("读取字幕失败，请刷新视频页后重试", "err");
      subList.innerHTML = '<div class="p-empty">读取字幕失败：' + md.esc(String((e && e.message) || e)) + "</div>";
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
      row.addEventListener("dblclick", () => jumpTo(line.start));
      frag.appendChild(row);
    });
    subList.appendChild(frag);
    // 恢复当前高亮
    if (nowTrackIndex === activeIndex && nowLineIndex >= 0) {
      applyHighlight(nowLineIndex);
    }
  }

  // AI 回复中的 [mm:ss] 时间戳点击跳转
  function bindTimestampJump(container) {
    container.addEventListener("click", e => {
      const ts = e.target.closest(".ts-link");
      if (ts) { const t = Number(ts.dataset.t); if (isFinite(t)) jumpTo(t); }
    });
  }
  bindTimestampJump(msgList);
  bindTimestampJump(summaryResult);

  // 点击/双击跳转（单击勾选用于 AI 上下文，双击跳转视频；当前句条单击跳转）
  async function jumpTo(time) {
    const tab = await getActiveTab();
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "JUMP_TO_TIME", time });
    } catch (_) { /* ignore */ }
  }

  // ---------- 播放同步（content 广播所有轨道的当前行） ----------
  function applyHighlight(index) {
    const rows = subList.querySelectorAll(".p-line");
    rows.forEach((el, i) => el.classList.toggle("now", i === index));
    if (index >= 0 && rows[index]) rows[index].scrollIntoView({ block: "center", behavior: "auto" });
  }

  function onPlaybackHighlight(indexes) {
    if (!Array.isArray(indexes)) return;
    const hit = indexes.find(x => x.trackIndex === activeIndex);
    const index = hit ? hit.index : -1;
    nowTrackIndex = activeIndex;
    nowLineIndex = index;
    applyHighlight(index);
    // 当前句条
    const lines = currentLines();
    const line = index >= 0 && lines[index] ? lines[index] : null;
    if (line) {
      nowLine.textContent = "▶ " + fmt(line.start) + "  " + line.text;
      nowLine.dataset.time = String(line.start);
    } else {
      nowLine.textContent = "";
      nowLine.dataset.time = "";
    }
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

  // ---------- 消息渲染（Markdown） ----------
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
    body.className = "body md-body";
    if (role === "user" || role === "ai") body.innerHTML = md.mdToHtml(text);
    else body.textContent = text;
    div.appendChild(body);
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
    return div;
  }

  // ---------- 历史存储 ----------
  const HISTORY_KEY = "chatHistory";
  const HISTORY_LIMIT = 100;

  async function loadHistory() {
    try {
      const store = await chrome.storage.local.get(HISTORY_KEY);
      return store[HISTORY_KEY] || [];
    } catch (_) { return []; }
  }
  async function persistHistory(list) {
    try { await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(-HISTORY_LIMIT) }); } catch (_) {}
  }
  function genId() { return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  let currentRecord = null;
  async function saveCurrentRecord() {
    if (!currentRecord) return;
    const list = await loadHistory();
    const idx = list.findIndex(r => r.id === currentRecord.id);
    if (idx >= 0) list[idx] = currentRecord; else list.push(currentRecord);
    await persistHistory(list);
  }

  // ---------- AI 对话 ----------
  const aiStreams = new Map();

  function handleStream(m) {
    const s = aiStreams.get(m.id);
    if (!s) return;
    if (m.error) { finishStream(s, null, "⚠ " + m.error, true); return; }
    if (m.done) { finishStream(s, s.fullText, null, false); return; }
    if (m.reasoning) {
      s.reasoningText += m.reasoning;
      s.reasoningEl.hidden = false;
      s.reasoningEl.textContent = s.reasoningText;
      msgList.scrollTop = msgList.scrollHeight;
    }
    if (m.delta) {
      s.fullText += m.delta;
      s.contentEl.innerHTML = md.mdToHtml(s.fullText);
      if (s.contentEl.lastChild && s.contentEl.lastChild.tagName === "DIV") {} // no-op 保持简单
      s.contentEl.appendChild(s.caretEl);
      msgList.scrollTop = msgList.scrollHeight;
    }
  }

  function finishStream(s, aiText, errText, isErr) {
    if (s.saved) return;
    s.saved = true;
    s.caretEl.remove();
    if (isErr) {
      s.contentEl.innerHTML = "<span class=\"err\">" + md.esc(errText) + "</span>";
    } else {
      s.contentEl.innerHTML = md.mdToHtml(aiText || s.fullText || "");
    }
    msgList.scrollTop = msgList.scrollHeight;
    if (currentRecord) {
      if (!isErr && s.fullText) currentRecord.messages.push({ role: "ai", content: s.fullText });
      currentRecord.updatedAt = Date.now();
      saveCurrentRecord();
    }
    aiStreams.delete(s.id);
  }

  // ---- 长字幕分块检索（suggestion P0#2）：全文≤4000字符直接全文；否则按关键词+播放位置取相关片段 ----
  const STOP_WORDS = new Set(["这个", "什么", "怎么", "我们", "一个", "那个", "就是", "还有", "可以", "因为", "所以", "如果", "如何", "为什么", "一下", "现在", "这里", "视频", "字幕", "总结", "讲解", "老师", "请问", "帮我", "关于"]);

  function extractKeywords(question) {
    const parts = String(question || "").match(/[\u4e00-\u9fa5]{2,}|[A-Za-z]{3,}/g) || [];
    const out = [];
    parts.forEach(p => { if (!STOP_WORDS.has(p) && !out.includes(p)) out.push(p); });
    return out.slice(0, 6);
  }

  function buildAutoContext(question, lines, curTime) {
    const all = buildContextText(lines);
    if (all.length <= 4000) return { text: all, mode: "full", count: lines.length };
    const kws = extractKeywords(question);
    const hit = new Set();
    lines.forEach((l, i) => {
      const hay = l.text.toLowerCase();
      if (kws.some(k => hay.includes(k.toLowerCase()))) {
        for (let d = -2; d <= 2; d++) if (lines[i + d]) hit.add(i + d);
      }
    });
    if (curTime != null) {
      lines.forEach((l, i) => { if (Math.abs((l.start + l.end) / 2 - curTime) <= 90) hit.add(i); });
    }
    let idxs = Array.from(hit).sort((a, b) => a - b);
    if (!idxs.length) {
      for (let n = 0; n < 10; n++) idxs.push(Math.min(lines.length - 1, Math.round(lines.length * n / 10)));
    }
    idxs = idxs.slice(0, 80);
    return {
      text: idxs.map(i => "[" + fmt(lines[i].start) + "] " + lines[i].text).join("\n"),
      mode: "relevant",
      count: idxs.length
    };
  }

  async function getPlaybackTime() {
    try {
      const tab = await getActiveTab();
      if (!tab) return null;
      const pt = await chrome.tabs.sendMessage(tab.id, { type: "GET_PLAYBACK_TIME" });
      return pt && pt.ok ? pt.time : null;
    } catch (_) { return null; }
  }

  function sendUserMessage(userText) {
    const text = String(userText || "").trim();
    if (!text) { addMsg("sys", "请输入提问内容"); return; }

    let ctx = ctxText.textContent.trim();
    let autoCtx = false;
    let autoInfo = "";
    if (!ctx) {
      const lines = currentLines();
      if (lines.length) {
        autoCtx = true;
        const c = buildAutoContext(text, lines, null);
        ctx = c.text;
        autoInfo = c.mode === "full" ? "全文 " + c.count + " 行" : "相关片段 " + c.count + " 行";
      }
    }
    const messages = [];
    if (ctx) messages.push({ role: "user", content: "【视频字幕知识库】\n" + ctx });
    messages.push({ role: "user", content: text });

    if (!currentRecord) {
      currentRecord = {
        id: genId(), title: "", bvid: info ? info.bvid : null,
        createdAt: Date.now(), updatedAt: Date.now(), messages: [], autoContext: false
      };
    }
    if (!currentRecord.title) currentRecord.title = text.slice(0, 24) || "未命名对话";
    currentRecord.autoContext = currentRecord.autoContext || autoCtx;
    currentRecord.messages.push({ role: "user", content: text });
    currentRecord.updatedAt = Date.now();

    if (autoCtx) addMsg("sys", "已自动附带字幕上下文（" + autoInfo + "，按关键词+播放位置检索）");
    else if (ctx) addMsg("sys", "已附带字幕上下文");
    addMsg("user", text);

    const id = "s" + (++streamSeq);
    const body = addMsg("ai", "", "AI 思考中…");
    body.innerHTML = "";
    const reasoningEl = document.createElement("div");
    reasoningEl.className = "md-reasoning";
    reasoningEl.hidden = true;
    const contentEl = document.createElement("div");
    contentEl.className = "md-body";
    const caretEl = document.createElement("span");
    caretEl.className = "caret";
    contentEl.appendChild(caretEl);
    body.appendChild(reasoningEl);
    body.appendChild(contentEl);
    const s = { id, reasoningEl, contentEl, caretEl, reasoningText: "", fullText: "", saved: false };
    aiStreams.set(id, s);

    currentStreamId = id;
    showStop(true);
    chrome.runtime.sendMessage({ type: "AI_CHAT", id, messages, stream: true })
      .then(res => {
        if (res && !res.ok) {
          const cur = aiStreams.get(id);
          if (cur) finishStream(cur, null, (res.error || "请求失败"), true);
        }
      })
      .catch(e => {
        const cur = aiStreams.get(id);
        if (cur) finishStream(cur, null, (e.message || e), true);
      })
      .finally(() => {
        if (currentStreamId === id) { currentStreamId = null; showStop(false); }
      });
  }

  function showStop(show) { stopBtn.hidden = !show; }

  // ---------- AI 总结（画面识别 + 字幕分段 + 结构化汇总） ----------
  let summaryRunning = false;
  let summaryCancelled = false;
  let summaryCards = [];
  let summaryStarted = false;

  function buildSegments(lines, segLen) {
    const segs = [];
    if (!lines.length) return segs;
    const end = lines[lines.length - 1].end || 0;
    for (let t = 0; t < end; t += segLen) {
      segs.push({ start: t, end: Math.min(t + segLen, end), lines: [] });
    }
    if (!segs.length) segs.push({ start: 0, end: end, lines: [] });
    lines.forEach(l => {
      const idx = Math.max(0, Math.min(Math.floor(l.start / segLen), segs.length - 1));
      if (segs[idx]) segs[idx].lines.push(l);
    });
    return segs;
  }

  function updateSummaryProgress(text, pct) {
    summaryStatus.textContent = text;
    if (pct != null) summaryBar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  }

  function renderSegCard(card, idx) {
    const div = document.createElement("div");
    div.className = "s-seg";
    const head = document.createElement("div");
    head.className = "s-seg-head";
    head.textContent = "第 " + (idx + 1) + " 段 · " + fmt(card.start) + " – " + fmt(card.end);
    div.appendChild(head);
    if (card.image) {
      const img = document.createElement("img");
      img.src = card.image;
      img.alt = "画面截图";
      div.appendChild(img);
    }
    if (card.vision) {
      const v = document.createElement("div");
      v.className = "s-vision";
      v.innerHTML = md.mdToHtml(card.vision);
      div.appendChild(v);
    }
    if (card.subtitle) {
      const s = document.createElement("div");
      s.className = "s-sub";
      s.textContent = card.subtitle;
      div.appendChild(s);
    }
    return div;
  }

  async function runSummaryChat(contextText) {
    const id = "sum" + (++streamSeq);
    const box = document.createElement("div");
    box.className = "s-seg";
    const head = document.createElement("div");
    head.className = "s-seg-head";
    head.textContent = "📄 视频 AI 总结";
    box.appendChild(head);
    const body = document.createElement("div");
    body.className = "md-body";
    const caret = document.createElement("span");
    caret.className = "caret";
    body.appendChild(caret);
    box.appendChild(body);
    summaryResult.appendChild(box);
    let fullText = "";
    const handler = m => {
      if (!m || m.type !== "AI_STREAM" || m.id !== id) return;
      if (m.error) { caret.remove(); body.textContent = "⚠ " + m.error; return; }
      if (m.done) { caret.remove(); body.innerHTML = md.mdToHtml(fullText); return; }
      if (m.delta) {
        fullText += m.delta;
        body.innerHTML = md.mdToHtml(fullText);
        body.appendChild(caret);
        summaryResult.scrollTop = summaryResult.scrollHeight;
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    try {
      await chrome.runtime.sendMessage({
        type: "AI_CHAT", id,
        messages: [{
          role: "user",
          content: "你是一名资深课程助教。请基于以下【画面识别结果】与【视频字幕】，生成非常详细的结构化学习总结。要求：\n" +
            "1. 开头给出视频主题与学习目标；\n" +
            "2. 按讲授顺序列出【题目原文】【解题思路分析】【分步解答过程】【重点公式】，公式用 $...$ 或 $$...$$ 输出 LaTeX；\n" +
            "3. 若有画面识别结果，逐题对照板书；若画面识别失败，也基于字幕尽力还原；\n" +
            "4. 全部使用中文，步骤尽可能详细，可直接用于复习。\n\n" + contextText
        }],
        stream: true
      });
    } catch (e) {
      caret.remove();
      body.textContent = "⚠ " + (e.message || e);
    } finally {
      chrome.runtime.onMessage.removeListener(handler);
    }
  }

  async function startSummary() {
    if (summaryRunning) return;
    const tab = await getActiveTab();
    if (!tab) { updateSummaryProgress("未找到当前标签页", 0); return; }
    const lines = currentLines();
    if (!lines.length) { updateSummaryProgress("当前视频无字幕，无法总结", 0); return; }
    const store = await chrome.storage.local.get("aiSettings");
    const settings = store.aiSettings || {};
    const visionReady = !!settings.visionApiKey;
    const segLen = Math.max(30, Number($("#segLen").value) || 120);
    const segs = buildSegments(lines, segLen);
    summaryRunning = true;
    summaryCancelled = false;
    summaryCards = [];
    summarySegs.innerHTML = "";
    summaryResult.innerHTML = "";
    summaryStopBtn.hidden = false;
    summaryBtn.disabled = true;
    updateSummaryProgress("开始总结：共 " + segs.length + " 段" + (visionReady ? "（含画面识别）" : "（未配置视觉模型，仅字幕）"), 0);
    try {
      for (let i = 0; i < segs.length; i++) {
        if (summaryCancelled) break;
        const seg = segs[i];
        const shotTime = seg.start + (seg.end - seg.start) * 0.15;
        updateSummaryProgress("分段 " + (i + 1) + "/" + segs.length + "：截取画面…", (i / segs.length) * 100);
        let image = "";
        let visionText = "";
        if (visionReady) {
          const cap = await chrome.runtime.sendMessage({ type: "CAPTURE_FRAME", tabId: tab.id, time: shotTime });
          if (summaryCancelled) break;
          if (cap && cap.ok) {
            image = cap.image;
            updateSummaryProgress("分段 " + (i + 1) + "/" + segs.length + "：识别画面…", (i / segs.length) * 100);
            const v = await chrome.runtime.sendMessage({ type: "AI_VISION", image });
            visionText = v && v.ok ? v.content : (v && v.error ? "⚠ 识别失败：" + v.error : "");
          } else if (cap && cap.error) {
            visionText = "⚠ 截图失败：" + cap.error;
          }
        }
        const card = { start: seg.start, end: seg.end, image, vision: visionText, subtitle: seg.lines.map(l => "[" + fmt(l.start) + "] " + l.text).join("\n") };
        summaryCards.push(card);
        summarySegs.appendChild(renderSegCard(card, i));
        updateSummaryProgress("已处理 " + (i + 1) + "/" + segs.length + " 段", ((i + 1) / segs.length) * 100);
      }
      if (!summaryCancelled) {
        updateSummaryProgress("正在生成结构化总结（可能耗时 1~3 分钟）…", 100);
        const parts = summaryCards.map((c, i) =>
          "【第" + (i + 1) + "段 " + fmt(c.start) + "–" + fmt(c.end) + "】\n" +
          (c.vision ? "画面识别：" + c.vision + "\n" : "") +
          "字幕：\n" + c.subtitle
        ).join("\n\n");
        await runSummaryChat(parts);
        updateSummaryProgress("✅ 总结完成", 100);
      } else {
        updateSummaryProgress("已取消", 0);
      }
    } catch (e) {
      updateSummaryProgress("总结失败：" + (e.message || e), 0);
    } finally {
      summaryRunning = false;
      summaryStopBtn.hidden = true;
      summaryBtn.disabled = false;
    }
  }

  function stopSummary() {
    summaryCancelled = true;
    updateSummaryProgress("正在取消…");
  }

  // ---------- 历史载入 ----------
  async function openRecord(id) {
    const list = await loadHistory();
    const rec = list.find(r => r.id === id);
    if (!rec) return;
    currentRecord = {
      id: rec.id, title: rec.title || "未命名对话", bvid: rec.bvid || null,
      createdAt: rec.createdAt || Date.now(), updatedAt: rec.updatedAt || Date.now(),
      messages: JSON.parse(JSON.stringify(rec.messages || [])), autoContext: !!rec.autoContext
    };
    msgList.innerHTML = "";
    const sameVideo = !!(info && rec.bvid && info.bvid === rec.bvid);
    addMsg("sys", rec.autoContext
      ? (sameVideo ? "已附带字幕知识库（当前视频）" : "此对话附带其他视频的字幕知识库")
      : "历史对话（未附带字幕知识库）");
    (currentRecord.messages || []).forEach(m => addMsg(m.role, m.content));
    setStatus(sameVideo ? "已载入历史对话" : "已载入历史对话（字幕与当前视频不一致）", sameVideo ? "ok" : "err");
  }

  async function checkPendingOpenRecord() {
    try {
      const store = await chrome.storage.local.get("pendingOpenRecord");
      if (store.pendingOpenRecord) {
        await chrome.storage.local.remove("pendingOpenRecord");
        await openRecord(store.pendingOpenRecord);
      }
    } catch (_) {}
  }

  // ---------- 历史窗口入口 ----------
  function openHistoryWindow() {
    const url = chrome.runtime.getURL("history/history.html");
    if (chrome.windows && chrome.windows.create) {
      chrome.windows.create({ url, type: "popup", width: 820, height: 640 }).catch(() => chrome.tabs.create({ url }));
    } else {
      chrome.tabs.create({ url });
    }
  }

  // ---------- 全局消息监听 ----------
  chrome.runtime.onMessage.addListener(msg => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "AI_STREAM") handleStream(msg);
    else if (msg.type === "PLAYBACK_HIGHLIGHT") onPlaybackHighlight(msg.indexes);
    else if (msg.type === "LOAD_HISTORY_TO_PANEL") openRecord(msg.id);
    else if (msg.type === "TAB_REFRESH_REQUEST") {
      scheduleRefresh(200);
    }
    else if (msg.type === "VIDEO_CHANGED") {
      selected.clear();
      setContext("");
      setStatus("检测到视频切换，正在加载新字幕…");
      subList.innerHTML = '<div class="p-empty">视频切换中，字幕加载…</div>';
      lineCount.textContent = "";
      clearTimeout(videoSwitchTimer);
      videoSwitchTimer = setTimeout(loadSubtitles, 4000); // 兜底刷新
    }
    else if (msg.type === "SUBTITLES_READY" || msg.type === "SUBTITLES_ERROR") {
      clearTimeout(videoSwitchTimer);
      loadSubtitles(); // 新字幕已就绪/失败，拉取最新状态
    }
  });

  // ---------- 事件绑定 ----------
  trackSelect.addEventListener("change", () => {
    activeIndex = Number(trackSelect.value);
    selected.clear();
    renderLines();
    nowLine.dataset.time = "";
    nowLine.textContent = "";
  });

  nowLine.addEventListener("click", () => {
    const t = Number(nowLine.dataset.time);
    if (isFinite(t)) jumpTo(t);
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

  // ---------- Tab 切换（字幕对话 / AI 总结） ----------
  document.querySelectorAll(".p-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".p-tab").forEach(b => b.classList.toggle("active", b === btn));
      const tab = btn.dataset.tab;
      mainView.hidden = tab !== "chat";
      summaryView.hidden = tab !== "summary";
      if (tab === "summary" && !summaryStarted) {
        summaryStarted = true;
        chrome.storage.local.get("aiSettings").then(store => {
          const s = store.aiSettings || {};
          updateSummaryProgress(s.visionApiKey
            ? "就绪：视觉模型 " + (s.visionModel || "qwen-vl-plus") + "（分段画面将被识别）"
            : "未配置视觉模型（设置页-视觉模型），总结仅基于字幕", 0);
        });
      }
    });
  });
  summaryBtn.addEventListener("click", startSummary);
  summaryStopBtn.addEventListener("click", stopSummary);

  $("#historyBtn").addEventListener("click", openHistoryWindow);
  $("#newChatBtn").addEventListener("click", () => {
    currentRecord = null;
    msgList.innerHTML = "";
    setStatus("新对话（发送提问时会自动附带当前字幕）", "ok");
  });

  // ---------- 字幕区高度拖拽 ----------
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

  // ---------- 标签页切换 / 导航实时跟随 ----------
  // 用户在多个标签页之间切换：立即刷新为当前活动标签页的字幕
  chrome.tabs.onActivated.addListener(() => scheduleRefresh(300));
  // 标签页内导航完成（含 B 站站内跳转）：活动标签更新时刷新
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete" || !tab || !tab.active) return;
    scheduleRefresh(500);
  });

  // 初始加载 + 历史待载入检查
  loadSubtitles().then(() => { if (info) checkPendingOpenRecord(); });
})();
