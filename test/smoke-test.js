// B站字幕 AI 助手 - 冒烟测试（node test/smoke-test.js）
// 覆盖：MD5/wbi 签名库、字幕归一化、二分定位逻辑、manifest 资源完整性、消息路由存在性
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const lib = require(path.join(ROOT, "lib/wbi.js"));
const mdd = require(path.join(ROOT, "lib/markdown.js"));

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + " 期望 " + e + " 实际 " + a); }
}
function ok(name, cond) { eq(name, !!cond, true); }

console.log("-- MD5（与 node:crypto 交叉验证）");
const md5Cases = ["", "a", "abc", "hello world", "bvid=BV1eR846LECb&cid=123&wts=1700000000", "中文字幕测试", "emoji test", "🎬 视频字幕测试 🎬", "The quick brown fox jumps over the lazy dog"];
for (const s of md5Cases) {
  eq("md5(" + JSON.stringify(s) + ")", lib.md5(s), crypto.createHash("md5").update(s, "utf8").digest("hex"));
}

console.log("-- wbi 签名");
const q = lib.encWbi({ bvid: "BV1eR846LECb", cid: 123, extra: "" }, "imgkey1234567890abcdef", "subkey0987654321fedcba");
const m = q.match(/w_rid=([0-9a-f]{32})/);
ok("w_rid 存在且 32 位 hex", !!m);
const parts = q.split("&").filter(p => !p.startsWith("w_rid="));
const sorted = parts.sort().join("&");
const mixin = lib.getMixinKey("imgkey1234567890abcdef" + "subkey0987654321fedcba");
eq("签名与 md5(query+mixinKey) 一致", m && m[1], crypto.createHash("md5").update(sorted + mixin, "utf8").digest("hex"));
ok("空值参数被过滤", !q.includes("extra="));
ok("含 wts 时间戳", /(^|&)wts=\d+(&|$)/.test(q));
eq("keyFromUrl 提取", lib.keyFromUrl("https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png"), "7cd084941338484aae1ad9425b84077c");

console.log("-- 字幕解析");
eq("parseTs 00:01.234", lib.parseTs("00:01.234"), 1.234);
eq("parseTs 1:02:03.456", lib.parseTs("1:02:03.456"), 3723.456);
eq("parseTs 123", lib.parseTs("123"), 123);
const raw = [
  { from: "00:00.000", to: "00:02.500", content: "  大家好  " },
  { from: "00:02.500", to: "00:05.000", content: "欢迎观看" },
  { from: "00:05.000", to: "00:06.000", content: "   " }
];
const norm = lib.normalizeBody(raw);
eq("归一化条数", norm.length, 2);
eq("归一化首条", norm[0], { start: 0, end: 2.5, text: "大家好" });

console.log("-- 二分定位（与 subtitle-view.js 一致）");
function findIndex(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (ans >= 0 && t <= lines[ans].end) return ans;
  return -1;
}
const lines = [
  { start: 0, end: 2, text: "a" },
  { start: 2, end: 4, text: "b" },
  { start: 4, end: 6, text: "c" }
];
eq("起始", findIndex(lines, 0), 0);
eq("边界", findIndex(lines, 2), 1);
eq("中间", findIndex(lines, 3.5), 1);
eq("结尾", findIndex(lines, 6), 2);
eq("越界", findIndex(lines, 6.5), -1);
eq("空表", findIndex([], 1), -1);

console.log("-- Markdown 渲染");
ok("md 粗体", mdd.mdToHtml("**b**").includes("<strong>b</strong>"));
ok("md 代码块", mdd.mdToHtml("```\nlet x=1;\n```").includes("<pre><code>let x=1;</code></pre>"));
ok("md XSS 转义", !mdd.mdToHtml("<script>alert(1)</script>").includes("<script>"));
ok("md 链接白名单", !mdd.mdToHtml("[x](javascript:alert(1))").includes("<a href="));

console.log("-- manifest 资源完整性");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const refs = [];
refs.push(manifest.background.service_worker);
(manifest.content_scripts || []).forEach(cs => refs.push(...(cs.js || [])));
refs.push(manifest.action.default_popup, manifest.side_panel.default_path, manifest.options_page);
Object.values(manifest.icons || {}).forEach(i => refs.push(i));
Object.values(manifest.action.default_icon || {}).forEach(i => refs.push(i));
const missing = refs.filter(p => !fs.existsSync(path.join(ROOT, p)));
eq("manifest 引用资源全部存在", missing.length, 0);
if (missing.length) console.log("    缺失:", missing.join(", "));
eq("manifest_version=3", manifest.manifest_version, 3);
eq("版本号为 0.7.0", manifest.version, "0.7.0");
ok("权限含 storage/cookies/sidePanel", ["storage", "cookies", "sidePanel"].every(p => manifest.permissions.includes(p)));

console.log("-- 关键链路存在性");
const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
['importScripts("lib/wbi.js")', "BiliLib.encWbi", "x/player/wbi/v2", "x/player/v2", "x/web-interface/view", "resolveCid", "GET_SUBTITLES", "AI_CHAT", "AI_STOP", "AI_TEST", "chrome.cookies.getAll", "getReader", "VIDEO_CHANGED", "reasoning_content", "reasoningLevel", "reasoningModel"].forEach(k => ok("background 包含 " + k, bg.includes(k)));
const extractor = fs.readFileSync(path.join(ROOT, "content/extractor.js"), "utf8");
ok("extractor 允许 cid 为空", extractor.includes("return { bvid, cid }"));
ok("extractor 有自动重试", extractor.includes("setTimeout(requestSubtitles, 3000)"));
ok("extractor 广播 VIDEO_CHANGED", extractor.includes("VIDEO_CHANGED"));
const view = fs.readFileSync(path.join(ROOT, "content/subtitle-view.js"), "utf8");
["GET_CURRENT_SUBTITLES", "JUMP_TO_TIME", "PLAYBACK_HIGHLIGHT", "broadcastHighlight", "findIndex"].forEach(k => ok("view.js 包含 " + k, view.includes(k)));
ok("view.js 已无浮动面板 UI（bili-sub-ai-panel 移除）", !view.includes("bili-sub-ai-panel") && !view.includes("bili-sub-ai-float"));
const panel = fs.readFileSync(path.join(ROOT, "sidepanel/panel.js"), "utf8");
["GET_CURRENT_SUBTITLES", "AI_STREAM", "AI_STOP", "subResizer", "--subtitle-h", "PLAYBACK_HIGHLIGHT", "VIDEO_CHANGED", "chatHistory", "sendUserMessage", "【视频字幕知识库】", "historyBtn", "openHistoryWindow", "LOAD_HISTORY_TO_PANEL", "pendingOpenRecord", "mdToHtml", "JUMP_TO_TIME", "nowLine", "reasoning"].forEach(k => ok("panel.js 包含 " + k, panel.includes(k)));
ok("panel.js 已移除 SIDEPANEL_STATE 逻辑", !panel.includes("SIDEPANEL_STATE"));
const historyJs = fs.readFileSync(path.join(ROOT, "history/history.js"), "utf8");
["chatHistory", "pendingOpenRecord", "sidePanel.open", "renameCurrent", "deleteCurrent", "MarkdownLib"].forEach(k => ok("history.js 包含 " + k, historyJs.includes(k)));
ok("history.html 存在", fs.existsSync(path.join(ROOT, "history/history.html")));
ok("history.css 存在", fs.existsSync(path.join(ROOT, "history/history.css")));

const panelHtml = fs.readFileSync(path.join(ROOT, "sidepanel/panel.html"), "utf8");
ok("panel.html 含拖拽分隔条", panelHtml.includes("p-resizer"));
ok("panel.html 含历史入口按钮且无内嵌历史视图", panelHtml.includes("historyBtn") && !panelHtml.includes("historyView"));
["ARCHITECTURE.md", "DECISIONS.md", "CHANGELOG.md"].forEach(k => ok("docs/" + k + " 存在", fs.existsSync(path.join(ROOT, "docs", k))));

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);