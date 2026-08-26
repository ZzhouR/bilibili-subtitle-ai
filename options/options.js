// 设置页：AI 服务配置
(() => {
  // 默认值 / 旧配置迁移 / 思考等级取值都来自 lib/settings.js（与 Service Worker 同一份实现）
  const DEFAULT = SettingsLib.DEFAULT_SETTINGS;

  const $ = sel => document.querySelector(sel);
  const statusEl = $("#status");

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || "";
  }

  async function load() {
    const store = await chrome.storage.local.get("aiSettings");
    const s = SettingsLib.migrate(store.aiSettings || {});
    $("#baseUrl").value = s.baseUrl;
    $("#apiKey").value = s.apiKey;
    $("#model").value = s.model;
    $("#reasoningEffort").value = s.reasoningEffort;
    $("#visionBaseUrl").value = s.visionBaseUrl;
    $("#visionApiKey").value = s.visionApiKey;
    $("#visionModel").value = s.visionModel;
    $("#temperature").value = String(s.temperature);
    $("#systemPrompt").value = s.systemPrompt;
    updateEffortHint();
  }

  // 提示 DeepSeek 侧的实际映射（medium/xhigh 会被折叠到 high）
  function updateEffortHint() {
    const el = $("#effortState");
    if (!el) return;
    const level = SettingsLib.normalizeEffort($("#reasoningEffort").value);
    const actual = SettingsLib.effectiveEffort(level);
    el.textContent = actual
      ? "当前：" + level + " → DeepSeek 实际按 " + actual + " 执行；不发送 temperature"
      : "当前：关闭思考（thinking: disabled），temperature 生效";
  }

  function read() {
    const tempRaw = Number($("#temperature").value);
    const temperature = Number.isFinite(tempRaw) ? Math.min(2, Math.max(0, tempRaw)) : DEFAULT.temperature;
    return {
      baseUrl: $("#baseUrl").value.trim() || DEFAULT.baseUrl,
      apiKey: $("#apiKey").value.trim(),
      model: SettingsLib.normalizeModel($("#model").value.trim()),
      reasoningEffort: SettingsLib.normalizeEffort($("#reasoningEffort").value),
      visionBaseUrl: $("#visionBaseUrl").value.trim() || DEFAULT.visionBaseUrl,
      visionApiKey: $("#visionApiKey").value.trim(),
      visionModel: $("#visionModel").value.trim() || DEFAULT.visionModel,
      temperature, // 0 是合法值，不能被 || 兜底吞掉
      systemPrompt: $("#systemPrompt").value.trim() || DEFAULT.systemPrompt
    };
  }

  // 保存时保留本页未呈现的既有字段，避免整体覆盖丢配置；
  // 同时清掉 0.11.0 前的 reasoningLevel / reasoningModel（已被 reasoningEffort 取代）
  async function save() {
    const store = await chrome.storage.local.get("aiSettings");
    const merged = Object.assign({}, store.aiSettings || {}, read());
    delete merged.reasoningLevel;
    delete merged.reasoningModel;
    await chrome.storage.local.set({ aiSettings: merged });
  }

  $("#reasoningEffort").addEventListener("change", updateEffortHint);

  $("#saveBtn").addEventListener("click", async () => {
    await save();
    setStatus("✅ 设置已保存", "ok");
    setTimeout(() => setStatus(""), 2500);
  });

  $("#testBtn").addEventListener("click", async () => {
    await save();
    setStatus("正在测试连接…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "AI_TEST" });
      if (res && res.ok) {
        const all = Array.isArray(res.models) ? res.models : [];
        const models = all.slice(0, 12);
        setStatus("✅ 连接成功" + (models.length ? "，可用模型：" + models.join("、") + (all.length > 12 ? "…" : "") : "（接口未返回模型列表）"), "ok");
        $("#modelList").textContent = all.length ? "共发现 " + all.length + " 个模型" : "";
      } else {
        setStatus("❌ 连接失败：" + (res && res.error ? res.error : "未知错误"), "err");
      }
    } catch (e) {
      setStatus("❌ 连接失败：" + ((e && e.message) || e), "err");
    }
  });

  // 截图兜底权限（<all_urls>）：只在直接抓帧被跨域保护时才需要，因此做成可选权限按需申请
  const SHOT_PERM = { origins: ["<all_urls>"] };

  async function refreshShotPerm() {
    const el = $("#shotPermState");
    if (!el) return;
    let granted = false;
    try { granted = await chrome.permissions.contains(SHOT_PERM); } catch (_) { granted = false; }
    el.textContent = granted ? "当前状态：已授权（整页截图兜底可用）" : "当前状态：未授权（仅使用直接抓帧）";
  }

  const grantBtn = $("#grantShotBtn");
  if (grantBtn) {
    grantBtn.addEventListener("click", async () => {
      // request 必须由用户手势直接触发，不能放在 await 之后
      let granted = false;
      try { granted = await chrome.permissions.request(SHOT_PERM); } catch (e) { granted = false; }
      setStatus(granted ? "✅ 已获得截图兜底权限" : "❌ 未获得权限（可继续使用直接抓帧）", granted ? "ok" : "err");
      refreshShotPerm();
    });
  }
  const revokeBtn = $("#revokeShotBtn");
  if (revokeBtn) {
    revokeBtn.addEventListener("click", async () => {
      try { await chrome.permissions.remove(SHOT_PERM); } catch (_) { /* ignore */ }
      setStatus("已撤销截图兜底权限");
      refreshShotPerm();
    });
  }

  load();
  refreshShotPerm();
})();
