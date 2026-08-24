// 对话历史管理（独立窗口界面）：搜索 / 查看 / 重命名 / 删除 / 载入侧边栏继续对话
(() => {
  const $ = sel => document.querySelector(sel);
  const listWrap = $("#list");
  const countEl = $("#count");
  const searchInput = $("#search");
  const detail = $("#detailView");
  const detailEmpty = $("#detailEmpty");
  const dTitle = $("#dTitle"), dMeta = $("#dMeta"), msgs = $("#msgs");
  const HISTORY_KEY = "chatHistory";

  let records = [];
  let currentId = null;

  async function loadAll() {
    try {
      const store = await chrome.storage.local.get(HISTORY_KEY);
      records = store[HISTORY_KEY] || [];
    } catch (_) { records = []; }
    renderList();
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, "0");
    return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function renderList() {
    const q = (searchInput.value || "").trim().toLowerCase();
    const all = records.slice().reverse();
    const items = q
      ? all.filter(r => (r.title || "").toLowerCase().includes(q) || (r.messages || []).some(m => (m.content || "").toLowerCase().includes(q)))
      : all;
    countEl.textContent = records.length + " 条";
    listWrap.innerHTML = "";
    if (!items.length) {
      listWrap.innerHTML = '<div class="hh-empty"><div class="hh-empty-sub">' + (q ? "无匹配记录" : "暂无对话记录") + "</div></div>";
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach(rec => {
      const item = document.createElement("div");
      item.className = "h-item" + (rec.id === currentId ? " active" : "");
      const t = document.createElement("div");
      t.className = "h-title";
      t.textContent = rec.title || "未命名对话";
      const meta = document.createElement("div");
      meta.className = "h-meta";
      meta.textContent = (rec.bvid || "未知视频") + " · " + (rec.messages ? rec.messages.length : 0) + " 条 · " + fmtTime(rec.updatedAt || rec.createdAt);
      item.appendChild(t); item.appendChild(meta);
      item.addEventListener("click", () => openDetail(rec.id));
      frag.appendChild(item);
    });
    listWrap.appendChild(frag);
  }

  const md = window.MarkdownLib;

  function openDetail(id) {
    const rec = records.find(r => r.id === id);
    if (!rec) return;
    currentId = id;
    renderList();
    detail.hidden = false;
    detailEmpty.hidden = true;
    dTitle.textContent = rec.title || "未命名对话";
    dMeta.textContent = "视频 " + (rec.bvid || "未知") + " · " + (rec.messages ? rec.messages.length : 0) + " 条消息 · " + fmtTime(rec.updatedAt || rec.createdAt);
    msgs.innerHTML = "";
    if (rec.autoContext) {
      const sys = document.createElement("div");
      sys.className = "msg sys";
      sys.textContent = "该对话附带字幕知识库（视频 " + (rec.bvid || "未知") + "）";
      msgs.appendChild(sys);
    }
    (rec.messages || []).forEach(m => {
      const div = document.createElement("div");
      div.className = "msg " + (m.role === "user" ? "user" : m.role === "ai" ? "ai" : "sys");
      const body = document.createElement("div");
      body.className = "md-body";
      if (m.role === "user" || m.role === "ai") body.innerHTML = md.mdToHtml(m.content);
      else body.textContent = m.content;
      div.appendChild(body);
      msgs.appendChild(div);
    });
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function persist(records) {
    try { await chrome.storage.local.set({ [HISTORY_KEY]: records }); } catch (_) {}
  }

  async function renameCurrent() {
    const rec = records.find(r => r.id === currentId);
    if (!rec) return;
    const name = prompt("重命名对话", rec.title || "");
    if (name == null) return;
    rec.title = name.trim() || rec.title;
    await persist(records);
    await loadAll();
    openDetail(currentId);
  }

  async function deleteCurrent() {
    const rec = records.find(r => r.id === currentId);
    if (!rec) return;
    if (!confirm("删除这条对话记录？")) return;
    records = records.filter(r => r.id !== rec.id);
    await persist(records);
    currentId = null;
    detail.hidden = true;
    detailEmpty.hidden = false;
    renderList();
  }

  async function continueChat() {
    if (!currentId) return;
    await chrome.storage.local.set({ pendingOpenRecord: currentId });
    // 打开当前窗口的侧边栏
    try {
      const win = await chrome.windows.getCurrent();
      try { await chrome.sidePanel.open({ windowId: win.id }); }
      catch (_) {
        const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
        if (tabs[0]) await chrome.sidePanel.open({ tabId: tabs[0].id });
        else throw new Error("no tab");
      }
      window.close();
    } catch (e) {
      alert("已记录待载入对话；请打开侧边栏后自动载入。");
      window.close();
    }
  }

  // ---------- 事件 ----------
  searchInput.addEventListener("input", renderList);
  $("#refreshBtn").addEventListener("click", loadAll);
  $("#backBtn").addEventListener("click", () => window.close());
  $("#renameBtn").addEventListener("click", renameCurrent);
  $("#delBtn").addEventListener("click", deleteCurrent);
  $("#continueBtn").addEventListener("click", continueChat);

  loadAll();
})();
