// 设置页：AI 服务配置
(() => {
  const DEFAULT = {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-chat",
    reasoningLevel: 0,
    visionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    visionApiKey: "",
    visionModel: "qwen-vl-plus",
    temperature: 0.7,
    systemPrompt: "你是专业的视频内容分析助手。你只基于用户提供的视频字幕进行总结、提炼、翻译与问答。回答使用与问题相同的语言，表达简洁、结构清晰。"
  };

  const $ = sel => document.querySelector(sel);
  const statusEl = $("#status");

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || "";
  }

  async function load() {
    const store = await chrome.storage.local.get("aiSettings");
    const s = Object.assign({}, DEFAULT, store.aiSettings || {});
    $("#baseUrl").value = s.baseUrl;
    $("#apiKey").value = s.apiKey;
    $("#model").value = s.model;
    $("#reasoningLevel").value = String(s.reasoningLevel);
    $("#visionBaseUrl").value = s.visionBaseUrl;
    $("#visionApiKey").value = s.visionApiKey;
    $("#visionModel").value = s.visionModel;
    $("#temperature").value = String(s.temperature);
    $("#systemPrompt").value = s.systemPrompt;
  }

  function read() {
    return {
      baseUrl: $("#baseUrl").value.trim() || DEFAULT.baseUrl,
      apiKey: $("#apiKey").value.trim(),
      model: $("#model").value.trim() || DEFAULT.model,
      reasoningLevel: Number($("#reasoningLevel").value) === 1 ? 1 : 0,
      visionBaseUrl: $("#visionBaseUrl").value.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      visionApiKey: $("#visionApiKey").value.trim(),
      visionModel: $("#visionModel").value.trim() || "qwen-vl-plus",
      temperature: Math.min(2, Math.max(0, Number($("#temperature").value) || 0.7)),
      systemPrompt: $("#systemPrompt").value.trim() || DEFAULT.systemPrompt
    };
  }

  $("#saveBtn").addEventListener("click", async () => {
    await chrome.storage.local.set({ aiSettings: read() });
    setStatus("✅ 设置已保存", "ok");
    setTimeout(() => setStatus(""), 2500);
  });

  $("#testBtn").addEventListener("click", async () => {
    await chrome.storage.local.set({ aiSettings: read() });
    setStatus("正在测试连接…");
    const res = await chrome.runtime.sendMessage({ type: "AI_TEST" });
    if (res && res.ok) {
      const models = (res.models || []).slice(0, 12);
      setStatus("✅ 连接成功，可用模型：" + models.join("、") + (res.models.length > 12 ? "…" : ""), "ok");
      $("#modelList").textContent = "共发现 " + res.models.length + " 个模型";
    } else {
      setStatus("❌ 连接失败：" + (res && res.error ? res.error : "未知错误"), "err");
    }
  });

  load();
})();
