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
  const shotView = $("#shotView");
  const shotStatus = $("#shotStatus");
  const shotList = $("#shotList");
  const shotBtn = $("#shotBtn");
  const shotStopBtn = $("#shotStopBtn");
  const shotClearBtn = $("#shotClearBtn");
  const shotForm = $("#shotForm");
  const shotInput = $("#shotInput");
  const shotSendBtn = $("#shotSendBtn");
  const shotWithSub = $("#shotWithSub");

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
      // 与 manifest content_scripts 保持一致：/video/ 与 /list/（合集播放页）都受支持
      if (!/^https:\/\/(www\.)?bilibili\.com\/(video\/|list\/)/.test(tab.url || "")) {
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
      const prevKey = info ? info.bvid + ":" + (info.p || 0) : null;
      info = res.info || null;
      const nextKey = info ? info.bvid + ":" + (info.p || 0) : null;
      // 换了视频/分P：清掉旧的勾选与上下文，否则索引会错位到新字幕上
      if (prevKey !== nextKey) {
        selected.clear();
        setContext("");
        nowTrackIndex = -1;
        nowLineIndex = -1;
        nowLine.textContent = "";
        nowLine.dataset.time = "";
      }
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
  bindTimestampJump(shotList);

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
    // 先按 0.1s 量化再拆分，避免 59.96 → "60.0"（分/秒进位错乱）
    const tenths = Math.round(Math.max(0, Number(s) || 0) * 10);
    const h = Math.floor(tenths / 36000);
    const m = Math.floor((tenths % 36000) / 600);
    const sec = (tenths % 600) / 10;
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
  // listEl 可为「字幕对话」或「截图总结」的消息列表，两个视图共用同一套气泡与流式渲染
  function appendMsg(listEl, role, text, tag) {
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
    listEl.appendChild(div);
    listEl.scrollTop = listEl.scrollHeight;
    return div;
  }

  function addMsg(role, text, tag) {
    return appendMsg(msgList, role, text, tag);
  }

  // 流式气泡：灰色思考区 + 正文 + 闪烁光标
  function createStreamBubble(listEl, tag) {
    const box = appendMsg(listEl, "ai", "", tag);
    const body = box.querySelector(".body");
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
    return { reasoningEl, contentEl, caretEl };
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
    const listEl = s.listEl || msgList;
    if (m.error) { finishStream(s, null, "⚠ " + m.error, true); return; }
    if (m.done) { finishStream(s, s.fullText, null, false); return; }
    if (m.reasoning) {
      s.reasoningText += m.reasoning;
      s.reasoningEl.hidden = false;
      s.reasoningEl.textContent = s.reasoningText;
      listEl.scrollTop = listEl.scrollHeight;
    }
    if (m.delta) {
      s.fullText += m.delta;
      s.contentEl.innerHTML = md.mdToHtml(s.fullText);
      s.contentEl.appendChild(s.caretEl);
      listEl.scrollTop = listEl.scrollHeight;
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
    const listEl = s.listEl || msgList;
    listEl.scrollTop = listEl.scrollHeight;
    // 仅「字幕对话」写入历史记录；截图总结用自己的会话线程
    if (s.record && currentRecord) {
      if (!isErr && s.fullText) currentRecord.messages.push({ role: "ai", content: s.fullText });
      currentRecord.updatedAt = Date.now();
      saveCurrentRecord();
    }
    aiStreams.delete(s.id);
    if (typeof s.onFinish === "function") s.onFinish(isErr ? null : (aiText || s.fullText || ""), isErr);
  }

  // 统一发起一次流式对话：返回 Promise（在流结束/失败后 resolve 文本或 null）
  function startChatStream(opts) {
    const listEl = opts.listEl || msgList;
    const id = opts.idPrefix + (++streamSeq);
    const parts = createStreamBubble(listEl, opts.tag || "AI 思考中…");
    return new Promise(resolve => {
      const s = {
        id, listEl,
        reasoningEl: parts.reasoningEl, contentEl: parts.contentEl, caretEl: parts.caretEl,
        reasoningText: "", fullText: "", saved: false,
        record: !!opts.record,
        onFinish: (text, isErr) => resolve(isErr ? null : text)
      };
      aiStreams.set(id, s);
      if (typeof opts.onStart === "function") opts.onStart(id);
      chrome.runtime.sendMessage({ type: "AI_CHAT", id, messages: opts.messages, stream: true })
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
          if (typeof opts.onSettled === "function") opts.onSettled(id);
        });
    });
  }

  function sendUserMessage(userText) {
    const text = String(userText || "").trim();
    if (!text) { addMsg("sys", "请输入提问内容"); return; }

    let ctx = ctxText.textContent.trim();
    let autoCtx = false;
    if (!ctx) {
      const lines = currentLines();
      if (lines.length) { ctx = buildContextText(lines); autoCtx = true; }
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

    if (autoCtx) addMsg("sys", "已自动附带字幕知识库（当前轨道 " + currentLines().length + " 行）");
    else if (ctx) addMsg("sys", "已附带字幕上下文");
    addMsg("user", text);

    showStop(true);
    startChatStream({
      listEl: msgList, idPrefix: "s", messages, record: true,
      onStart: id => { currentStreamId = id; },
      onSettled: id => { if (currentStreamId === id) { currentStreamId = null; showStop(false); } }
    });
  }

  function showStop(show) { stopBtn.hidden = !show; }

  // ---------- 截图总结（按需截取当前画面 → 视觉识别 → 总结 → 可继续追问） ----------
  let shotBusy = false;          // 截图/识别/总结进行中
  let shotCancelled = false;     // 用户中断标志
  let shotStreamId = null;       // 当前总结/追问流的 id：停止时需要真正 abort 后台请求
  let shotReady = false;         // 首次进入本标签页时的就绪提示
  let shotCount = 0;             // 已截图张数
  // 截图会话线程：截图识别结果与历次问答都留在这里，追问时整体回传，保证多轮上下文
  const shotThread = [];
  const SHOT_THREAD_MAX = 24;    // 只保留最近若干轮，避免上下文无限膨胀
  const SHOT_SUB_WINDOW = 30;    // 附近字幕窗口（秒）

  function setShotStatus(text) {
    shotStatus.textContent = text;
  }

  function pushShotThread(role, content) {
    shotThread.push({ role, content });
    if (shotThread.length > SHOT_THREAD_MAX) shotThread.splice(0, shotThread.length - SHOT_THREAD_MAX);
  }

  // 截图时刻附近的字幕（±SHOT_SUB_WINDOW 秒），作为画面的语音补充
  function nearbySubtitles(time) {
    const lines = currentLines();
    if (!lines.length || !isFinite(time)) return "";
    const from = time - SHOT_SUB_WINDOW;
    const to = time + SHOT_SUB_WINDOW;
    return lines
      .filter(l => l.end >= from && l.start <= to)
      .map(l => "[" + fmt(l.start) + "] " + l.text)
      .join("\n");
  }

  // 截图缩略图气泡（点击可跳回该时间点）
  function addShotImage(image, time) {
    const div = document.createElement("div");
    div.className = "msg user shot-img";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "📷 第 " + shotCount + " 张 · " + fmt(time);
    div.appendChild(tag);
    const img = document.createElement("img");
    img.src = image;
    img.alt = "视频画面截图 " + fmt(time);
    img.title = "点击跳回 " + fmt(time);
    img.addEventListener("click", () => jumpTo(time));
    div.appendChild(img);
    shotList.appendChild(div);
    shotList.scrollTop = shotList.scrollHeight;
    return div;
  }

  function setShotBusy(busy) {
    shotBusy = busy;
    shotBtn.disabled = busy;
    shotSendBtn.disabled = busy;
    shotStopBtn.hidden = !busy;
  }

  // 总结指令：与画面识别结果一起作为一条 user 消息进入会话线程，便于后续追问复用
  const SHOT_SUMMARY_INSTRUCTION =
    "请基于上面这张视频画面（如附带字幕则结合字幕）生成中文总结，要求：\n" +
    "1. 一句话说明这一画面在讲什么；\n" +
    "2. 分点整理画面中的关键信息（题目原文 / 步骤 / 结论 / 注意点）；\n" +
    "3. 画面中的公式一律用 $...$ 或 $$...$$ 输出 LaTeX，并简述其含义；\n" +
    "4. 若画面信息不足，明确指出缺什么，不要编造。";

  // 单次截图 → 视觉识别 → 流式总结
  async function captureAndSummarize() {
    if (shotBusy) return;
    const tab = await getActiveTab();
    if (!tab) { setShotStatus("未找到当前标签页"); return; }
    // 与 manifest content_scripts 一致：非视频页时 content 未注入，sendMessage 只会抛"could not establish connection"
    if (!/^https:\/\/(www\.)?bilibili\.com\/(video\/|list\/)/.test(tab.url || "")) {
      setShotStatus("当前标签页不是 B 站视频页");
      appendMsg(shotList, "sys", "请切换到 B 站视频标签页后再截图。");
      return;
    }
    const store = await chrome.storage.local.get("aiSettings");
    const settings = store.aiSettings || {};
    // 截图总结的核心就是画面识别：未配置视觉模型时必须明确报错，而不是静默退化成纯字幕
    if (!settings.visionApiKey) {
      setShotStatus("未配置视觉模型，无法识别画面");
      appendMsg(shotList, "sys", "截图总结需要视觉模型：请在「设置 → 视觉模型」填写 Base URL / API Key / 模型名（如 qwen-vl-plus）。");
      return;
    }
    shotCancelled = false;
    setShotBusy(true);
    try {
      setShotStatus("读取播放位置…");
      let time = 0;
      try {
        const pb = await chrome.tabs.sendMessage(tab.id, { type: "GET_PLAYBACK_TIME" });
        if (pb && isFinite(pb.time)) time = Number(pb.time) || 0;
      } catch (_) {
        throw new Error("未连接到视频页，请在 B 站视频页刷新后重试");
      }
      if (shotCancelled) { setShotStatus("已取消"); return; }

      setShotStatus("截取当前画面…");
      const cap = await chrome.runtime.sendMessage({ type: "CAPTURE_FRAME", tabId: tab.id, time });
      if (!cap || !cap.ok) throw new Error("截图失败：" + ((cap && cap.error) || "未知原因"));
      if (shotCancelled) { setShotStatus("已取消"); return; }
      shotCount++;
      addShotImage(cap.image, time);

      setShotStatus("视觉模型识别画面…");
      const v = await chrome.runtime.sendMessage({ type: "AI_VISION", image: cap.image });
      if (!v || !v.ok) throw new Error("画面识别失败：" + ((v && v.error) || "未知原因"));
      if (shotCancelled) { setShotStatus("已取消"); return; }
      const visionText = v.content || "（无有效画面内容）";
      appendMsg(shotList, "ai", visionText, "👁 画面识别 " + (cap.size || ""));

      const sub = shotWithSub.checked ? nearbySubtitles(time) : "";
      pushShotThread("user",
        "【截图 " + shotCount + " · 时间 " + fmt(time) + "】\n画面识别结果：\n" + visionText +
        (sub ? "\n\n该时刻附近字幕（±" + SHOT_SUB_WINDOW + "s）：\n" + sub : "") +
        "\n\n" + SHOT_SUMMARY_INSTRUCTION);

      setShotStatus("AI 总结中…" + (sub ? "（已附带附近字幕）" : ""));
      const text = await startChatStream({
        listEl: shotList, idPrefix: "shot", messages: shotThread.slice(), tag: "📄 截图总结",
        onStart: id => { shotStreamId = id; },
        onSettled: id => { if (shotStreamId === id) shotStreamId = null; }
      });
      if (text && !shotCancelled) {
        pushShotThread("assistant", text);
        setShotStatus("✅ 总结完成，可直接在下方继续追问，或再截一张");
      } else {
        setShotStatus(shotCancelled ? "已中断" : "总结失败，可重试");
      }
    } catch (e) {
      const err = (e && e.message) ? e.message : String(e);
      setShotStatus("⚠ " + err);
      appendMsg(shotList, "sys", "⚠ " + err);
    } finally {
      setShotBusy(false);
    }
  }

  // 基于已截取画面继续追问（多轮）
  async function askShot(question) {
    if (shotBusy) return;
    const q = String(question || "").trim();
    if (!q) return;
    if (!shotThread.length) {
      appendMsg(shotList, "sys", "请先点「📷 截图并总结」，再基于画面继续提问");
      return;
    }
    appendMsg(shotList, "user", q);
    pushShotThread("user", q);
    shotCancelled = false;
    setShotBusy(true);
    setShotStatus("AI 回答中…");
    try {
      const text = await startChatStream({
        listEl: shotList, idPrefix: "shot", messages: shotThread.slice(), tag: "AI 思考中…",
        onStart: id => { shotStreamId = id; },
        onSettled: id => { if (shotStreamId === id) shotStreamId = null; }
      });
      if (text && !shotCancelled) {
        pushShotThread("assistant", text);
        setShotStatus("✅ 已回答，可继续追问");
      } else {
        // 失败/中断时把刚追加的提问撤回：否则重试会重复入线程，且线程尾部堆叠连续 user 消息
        if (shotThread.length && shotThread[shotThread.length - 1].role === "user") shotThread.pop();
        setShotStatus(shotCancelled ? "已中断" : "回答失败，可重试");
      }
    } finally {
      setShotBusy(false);
    }
  }

  function stopShot() {
    shotCancelled = true;
    setShotStatus("正在中断…");
    // 已发出流时仅置标志无效，必须让后台 abort
    if (!shotStreamId) return; // 还在截图/识别阶段：由各步的 shotCancelled 检查收尾（不能提前解禁按钮，否则会并发再截一次）
    const id = shotStreamId;
    chrome.runtime.sendMessage({ type: "AI_STOP", id }).catch(() => {});
    // 兜底：后台若已失活（SW 被回收）不会再广播 done/error，本地必须自行收尾，
    // 否则 shotBusy 常驻 true，截图/发送按钮被永久禁用。
    setTimeout(() => {
      const cur = aiStreams.get(id);
      if (cur) finishStream(cur, null, "⚠ 已中断", true);
    }, 1200);
  }

  function clearShot() {
    if (shotBusy) stopShot();
    shotThread.length = 0;
    shotCount = 0;
    shotList.innerHTML = "";
    setShotStatus("已清空，点「📷 截图并总结」重新开始");
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
      tracks = [];
      activeIndex = -1;
      nowTrackIndex = -1;
      nowLineIndex = -1;
      nowLine.textContent = "";
      nowLine.dataset.time = "";
      trackBar.hidden = true;
      setStatus("检测到视频切换，正在加载新字幕…");
      subList.innerHTML = '<div class="p-empty">视频切换中，字幕加载…</div>';
      lineCount.textContent = "";
      clearTimeout(videoSwitchTimer);
      videoSwitchTimer = setTimeout(loadSubtitles, 4000); // 兜底刷新
      // 截图会话绑定的是旧视频的画面：换视频后继续追问会张冠李戴，直接重置
      if (shotThread.length || shotCount) {
        clearShot();
        setShotStatus("已切换视频，截图会话已重置");
      }
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

  // ---------- Tab 切换（字幕对话 / 截图总结） ----------
  document.querySelectorAll(".p-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".p-tab").forEach(b => b.classList.toggle("active", b === btn));
      const tab = btn.dataset.tab;
      mainView.hidden = tab !== "chat";
      shotView.hidden = tab !== "shot";
      if (tab === "shot" && !shotReady) {
        shotReady = true;
        chrome.storage.local.get("aiSettings").then(store => {
          const s = store.aiSettings || {};
          setShotStatus(s.visionApiKey
            ? "就绪：视觉模型 " + (s.visionModel || "qwen-vl-plus") + "，点「📷 截图并总结」"
            : "未配置视觉模型（设置页-视觉模型），无法识别画面");
        });
      }
    });
  });
  shotBtn.addEventListener("click", captureAndSummarize);
  shotStopBtn.addEventListener("click", stopShot);
  shotClearBtn.addEventListener("click", clearShot);
  shotForm.addEventListener("submit", e => {
    e.preventDefault();
    const text = shotInput.value.trim();
    if (text) { askShot(text); shotInput.value = ""; }
  });

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
  // 待载入的历史对话与当前是否在视频页无关：不能因为 info 为空就丢弃（会一直留在 storage 里打不开）
  loadSubtitles().finally(() => { checkPendingOpenRecord(); });
})();
