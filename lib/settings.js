// B站字幕 AI 助手 - lib/settings.js
// AI 设置的默认值、旧配置迁移与 chat 请求体构造（纯函数，可单测）。
//
// 依据 DeepSeek 官方文档（https://api-docs.deepseek.com）：
//   · 模型：deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp
//   · 思考开关（OpenAI 格式）：{"thinking": {"type": "enabled" | "disabled"}}
//   · 思考强度（OpenAI 格式）：{"reasoning_effort": "low" | "medium" | "high" | "xhigh" | "max"}
//   · 默认即开启思考，默认 effort = high
//   · 思考模式下 temperature / top_p / presence_penalty / frequency_penalty 无效
//     （设置不报错但也不生效，因此本模块在开启思考时直接不发送 temperature）
//   · 思考链通过 reasoning_content 与 content 同级返回（见 lib/sse.js）
//
// UMD：importScripts（Service Worker）、<script>（设置页）与 node require（冒烟测试）均可用。
(function (global) {
  "use strict";

  const DEFAULT_SETTINGS = {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",          // off | low | medium | high | xhigh | max
    visionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    visionApiKey: "",
    visionModel: "qwen-vl-plus",
    temperature: 0.7,
    systemPrompt: "你是专业的视频内容分析助手。你只基于用户提供的视频字幕进行总结、提炼、翻译与问答。回答使用与问题相同的语言，表达简洁、结构清晰。"
  };

  // 思考等级阶梯：与 agent 侧的分级一致。off = 关闭思考，其余直接作为 reasoning_effort 取值。
  const EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];

  // DeepSeek 的「请求 effort → 实际 effort」映射（deepseek-v4-flash 与 deepseek-v4-pro 相同）。
  // medium / xhigh 都会被映射为 high，因此在 DeepSeek 上实际只有 low / high / max 三档。
  const DEEPSEEK_EFFORT_MAP = { low: "low", medium: "high", high: "high", xhigh: "high", max: "max" };

  // 已下线的旧模型名 → 新模型名（老用户的 chrome.storage 里还存着这些值，不迁移会直接 404）
  const LEGACY_MODELS = {
    "deepseek-chat": "deepseek-v4-flash",
    "deepseek-reasoner": "deepseek-v4-flash"
  };

  function numOr(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  function normalizeEffort(v) {
    const s = String(v == null ? "" : v).trim().toLowerCase();
    return EFFORT_LEVELS.indexOf(s) >= 0 ? s : DEFAULT_SETTINGS.reasoningEffort;
  }

  // DeepSeek 上该等级实际生效的强度；off 返回 null（不思考）
  function effectiveEffort(level) {
    const e = normalizeEffort(level);
    return e === "off" ? null : DEEPSEEK_EFFORT_MAP[e];
  }

  function normalizeModel(name) {
    const m = String(name == null ? "" : name).trim();
    if (!m) return DEFAULT_SETTINGS.model;
    return LEGACY_MODELS[m.toLowerCase()] || m;
  }

  // 目标端点是否为 DeepSeek（决定是否发送 thinking 字段 —— 严格的 OpenAI 端点会拒绝未知字段）
  function isDeepSeekTarget(baseUrl, model) {
    return /deepseek/i.test(String(baseUrl || "")) || /^deepseek[-.]/i.test(String(model || ""));
  }

  // 迁移 + 补默认值：未知字段原样保留，避免覆盖掉本模块不认识的配置
  function migrate(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    s.model = normalizeModel(s.model);
    // 0.11.0 之前用 reasoningLevel（0=普通 / 1=深度思考）+ reasoningModel 切模型
    if (!(raw && raw.reasoningEffort != null) && raw && raw.reasoningLevel != null) {
      s.reasoningEffort = Number(raw.reasoningLevel) === 1 ? "high" : "off";
    } else {
      s.reasoningEffort = normalizeEffort(s.reasoningEffort);
    }
    delete s.reasoningLevel;
    delete s.reasoningModel;
    s.temperature = Math.min(2, Math.max(0, numOr(s.temperature, DEFAULT_SETTINGS.temperature)));
    return s;
  }

  // 构造 /chat/completions 请求体
  function buildChatPayload(settings, messages, opts) {
    const s = migrate(settings);
    const o = opts || {};
    const model = normalizeModel(s.model);
    const effort = normalizeEffort(s.reasoningEffort);
    const deepseek = isDeepSeekTarget(s.baseUrl, model);
    const payload = {
      model,
      messages: Array.isArray(messages) ? messages : [],
      stream: o.stream !== false
    };
    if (effort === "off") {
      // DeepSeek 默认开启思考，关闭必须显式声明；其他端点不发 thinking（可能不认该字段）
      if (deepseek) payload.thinking = { type: "disabled" };
      payload.temperature = numOr(s.temperature, DEFAULT_SETTINGS.temperature);
    } else {
      if (deepseek) payload.thinking = { type: "enabled" };
      payload.reasoning_effort = effort;
      // 思考模式下 temperature 无效，直接不发
    }
    return payload;
  }

  function hasThinkingParams(payload) {
    return !!(payload && (payload.thinking || payload.reasoning_effort));
  }

  // 端点不认思考参数时，去掉思考字段并把 temperature 补回来（用于 400 后降级重试一次）
  function stripThinkingParams(payload, settings) {
    const out = Object.assign({}, payload || {});
    delete out.thinking;
    delete out.reasoning_effort;
    if (out.temperature == null) {
      out.temperature = numOr(settings && settings.temperature, DEFAULT_SETTINGS.temperature);
    }
    return out;
  }

  // 400 响应体是否在抱怨思考相关参数（非 DeepSeek 的兼容实现常见）
  function isThinkingUnsupported(text) {
    const t = String(text || "");
    if (/thinking|reasoning_effort/i.test(t)) return true;
    return /unrecognized|unsupported|unknown|invalid|extra fields|additional properties/i.test(t)
      && /(field|parameter|argument|propert)/i.test(t);
  }

  const api = {
    DEFAULT_SETTINGS,
    EFFORT_LEVELS,
    DEEPSEEK_EFFORT_MAP,
    LEGACY_MODELS,
    normalizeEffort,
    effectiveEffort,
    normalizeModel,
    isDeepSeekTarget,
    migrate,
    buildChatPayload,
    hasThinkingParams,
    stripThinkingParams,
    isThinkingUnsupported
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.SettingsLib = api;
})(typeof self !== "undefined" ? self : this);
