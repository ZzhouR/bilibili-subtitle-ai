// B站字幕 AI 助手 - lib/sse.js
// SSE 流解析纯函数：feedBuffer 维护跨 chunk 缓冲区；parseLine 解析单行 data: JSON。
// UMD：importScripts 与 node require 均可用。
(function (global) {
  "use strict";

  // 输入已解码文本 chunk，返回 {`buffer`, `lines`}
  function feedBuffer(buffer, chunk) {
    const next = (buffer || "") + String(chunk || "");
    const parts = next.split("\n");
    const rest = parts.pop();
    return { buffer: rest, lines: parts };
  }

  // 解析一行：返回 {delta?, reasoning?, done?} 或 null
  function parseLine(rawLine) {
    const l = String(rawLine || "").trim();
    if (!l.startsWith("data:")) return null;
    const data = l.slice(5).trim();
    if (data === "[DONE]") return { done: true };
    try {
      const j = JSON.parse(data);
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (!delta) return null;
      const out = {};
      if (delta.reasoning_content) out.reasoning = delta.reasoning_content;
      if (delta.content) out.delta = delta.content;
      return out;
    } catch (_) {
      return null; // 忽略不完整/异常块
    }
  }

  const api = { feedBuffer, parseLine };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.SseLib = api;
})(typeof self !== "undefined" ? self : this);
