// B站字幕 AI 助手 - 冒烟测试（node test/smoke-test.js）
// 覆盖：MD5/wbi 签名库、字幕归一化、二分定位逻辑、manifest 资源完整性、消息路由存在性
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const lib = require(path.join(ROOT, "lib/wbi.js"));
const mdd = require(path.join(ROOT, "lib/markdown.js"));
const sselib = require(path.join(ROOT, "lib/sse.js"));
// markdown 通过 globalThis.LatexLib 取渲染器：必须挂真正的 latex 库（此前误挂 wbi 库，
// 一旦出现 $...$ 就会因缺少 latexToHtml 抛错）
global.LatexLib = require(path.join(ROOT, "lib/latex.js"));

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

console.log("-- 字幕归一化容错（0.9.3 回归）");
const messy = lib.normalizeBody([
  { from: "00:02.000", to: "00:04.000", content: "b" },
  { from: "00:00.000", to: "00:00.000", content: "a" },   // end<=start：应补齐为下一条 start
  { from: "00:06.000", content: "c" },                     // 缺失 to：应补 +5s
  { from: "oops", to: "00:09.000", content: "x" },         // 非法 start：应丢弃
  { from: "00:10.000", to: "00:12.000", content: "   " }    // 空文本：应丢弃
]);
eq("非法/空行被丢弃", messy.length, 3);
eq("按 start 升序（二分查找前置条件）", messy.map(x => x.text), ["a", "b", "c"]);
eq("end<=start 用下一条 start 补齐", messy[0].end, 2);
eq("末条缺 to 补 +5s", messy[2].end, 11);
ok("所有 end > start（高亮不会永久失配）", messy.every(x => x.end > x.start));

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

console.log("-- SSE 解析");
let sseBuf = "";
const r1 = sselib.feedBuffer(sseBuf, "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n");
sseBuf = r1.buffer;
eq("SSE 分片1", r1.lines.length, 1);
const p1 = sselib.parseLine(r1.lines[0]);
eq("SSE delta", p1.delta, "你");
const r2 = sselib.feedBuffer(sseBuf, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考\"}}]}\n\ndata: [DONE]\n\n");
sseBuf = r2.buffer;
const p2 = sselib.parseLine(r2.lines[0]);
eq("SSE reasoning", p2.reasoning, "思考");
ok("SSE [DONE]", sselib.parseLine("data: [DONE]").done);
ok("SSE 跨块缓冲", sselib.feedBuffer("", "data: {\"x\"") !== null);
console.log("-- 时间戳渲染");
ok("md 时间戳链接", mdd.mdToHtml("跳转到 [12:36] 看看").includes('class="ts-link" data-t="756"'));

console.log("-- 块级公式渲染（0.9.3 回归）");
const blockMd = mdd.mdToHtml("$$\nx^2+y^2=z^2\n$$");
ok("多行 $$ 输出 latex-block", blockMd.includes("latex-block"));
ok("多行 $$ 不丢公式内容", blockMd.includes("x") && blockMd.includes("z"));
ok("单行 $$ 渲染", mdd.mdToHtml("$$a+b$$").includes("latex-block"));
ok("未闭合 $$ 也渲染（流式输出中）", mdd.mdToHtml("$$\nE=mc^2").includes("latex-block"));

console.log("-- 公式渲染增强（0.10.2）");
const BS = String.fromCharCode(92); // 反斜杠
const leMd = mdd.mdToHtml("1 " + BS + "le r(A) " + BS + "le 2");
ok("裸 \\le 渲染为 ≤", leMd.includes("≤") && !leMd.includes(BS + "le"));
const lrMd = mdd.mdToHtml(BS + "Leftrightarrow A = B");
ok("裸 \\Leftrightarrow 渲染为 ⇔", lrMd.includes("⇔") && !lrMd.includes(BS + "Leftrightarrow"));
const mxMd = mdd.mdToHtml(BS + "begin{vmatrix} A " + BS + BS + " " + BS + "alpha^T " + BS + "end{vmatrix}");
ok("裸矩阵环境渲染", mxMd.includes("lmatrix") && mxMd.includes("lcell"));
ok("矩阵单元格递归渲染", mxMd.includes("α<sup>T</sup>"));
ok("pmatrix 有括号定界", mdd.mdToHtml(BS + "begin{pmatrix} a " + BS + "end{pmatrix}").includes("ldelim"));
const dblMd = mdd.mdToHtml("$$x^2+1$$ 因此");
ok("行内 $$ 不残留 $", dblMd.includes("x<sup>2</sup>") && !dblMd.includes("$$x"));
ok("分隔线 ---", mdd.mdToHtml("---").includes("<hr>"));
const BT = String.fromCharCode(96);
const codeMd = mdd.mdToHtml(BT + BS + "alpha" + BT + " 与 $" + BS + "alpha$");
ok("行内代码不公式化", codeMd.includes("<code>" + BS + "alpha</code>") && codeMd.includes("α"));

console.log("-- 截图总结逻辑（与 sidepanel/panel.js、content/subtitle-view.js 一致）");
// needSeek：目标≈当前帧时必须跳过 seek（写入同值不触发 seeked，只能等 1500ms 超时）
const needSeek = (cur, target) => Math.abs((cur || 0) - target) > 0.05;
ok("当前帧免 seek", needSeek(123.4, 123.4) === false);
ok("微小抖动免 seek", needSeek(123.42, 123.4) === false);
ok("time=0 免 seek", needSeek(0, 0) === false);
ok("跨帧仍 seek", needSeek(100, 123.4) === true);
// shotThread：先进先出截断，保留最新 SHOT_THREAD_MAX 条
const SHOT_THREAD_MAX = 24;
const thread = [];
const pushThread = (role, content) => {
  thread.push({ role, content });
  if (thread.length > SHOT_THREAD_MAX) thread.splice(0, thread.length - SHOT_THREAD_MAX);
};
for (let i = 0; i < 40; i++) pushThread(i % 2 ? "assistant" : "user", "m" + i);
eq("会话线程上限 24", thread.length, 24);
eq("保留最新一条", thread[thread.length - 1].content, "m39");
eq("丢弃最旧", thread[0].content, "m16");
// nearbySubtitles：截图时刻 ±30s 的字幕（区间相交，含边界）
const SHOT_SUB_WINDOW = 30;
const shotLines = [
  { start: 0, end: 5, text: "a" }, { start: 100, end: 105, text: "b" },
  { start: 130, end: 140, text: "c" }, { start: 200, end: 210, text: "d" }
];
const near = t => shotLines.filter(l => l.end >= t - SHOT_SUB_WINDOW && l.start <= t + SHOT_SUB_WINDOW).map(l => l.text).join(",");
eq("附近字幕窗口 ±30s", near(120), "b,c");
eq("边界相交计入", near(135), "b,c");
eq("窗口外不取", near(400), "");
// 抓帧双路径分流（与 background.handleCaptureFrame 一致）：
// canvas 成功直接用；tainted（污染/全黑）才回退整页截图；其他失败不该白跑一次截图
const routeGrab = grab => {
  if (grab && grab.ok && grab.image) return "canvas";
  if (grab && !grab.tainted) return "fail";
  return "capture";
};
eq("抓帧成功走 canvas", routeGrab({ ok: true, image: "data:..." }), "canvas");
eq("画布污染回退整页截图", routeGrab({ ok: false, tainted: true, error: "SecurityError" }), "capture");
eq("全黑帧回退整页截图", routeGrab({ ok: false, tainted: true, error: "抓到全黑帧（硬件加速叠加层）" }), "capture");
eq("播放器未就绪不回退", routeGrab({ ok: false, error: "视频帧尚未就绪（播放器仍在加载？）" }), "fail");
// 权限类错误识别（后台判断是否给授权指引 / 面板是否插入设置页入口）
const permRe = /all_urls|activeTab|permission/i;
ok("识别 chrome 原始权限报错", permRe.test("Either the '<all_urls>' or 'activeTab' permission is required."));
ok("非权限错误不误判", !permRe.test("视觉接口 HTTP 401: invalid api key"));
// 全黑帧探测：对 RGBA 抽样求均值，阈值 4
const blackScore = fill => {
  const probe = new Array(1024 * 4).fill(fill);
  let sum = 0, n = 0;
  for (let i = 0; i < probe.length; i += 4 * 64) { sum += probe[i] + probe[i + 1] + probe[i + 2]; n += 3; }
  return n ? sum / n : 0;
};
ok("全黑帧被判定为黑", blackScore(0) < 4);
ok("极暗画面不判黑", !(blackScore(5) < 4));
ok("正常画面不判黑", !(blackScore(120) < 4));

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
eq("版本号为 0.10.2", manifest.version, "0.10.2");
ok("权限含 storage/cookies/sidePanel/activeTab", ["storage", "cookies", "sidePanel", "activeTab"].every(p => manifest.permissions.includes(p)));
ok("host_permissions 含字幕 CDN hdslb", (manifest.host_permissions || []).includes("https://*.hdslb.com/*"));
const csMatches = (manifest.content_scripts || []).flatMap(cs => cs.js ? cs.matches : []);
ok("content_scripts 覆盖 /video/ 与 /list/", csMatches.some(m => m.includes("/video/")) && csMatches.some(m => m.includes("/list/")));

console.log("-- 关键链路存在性");
const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
['importScripts("lib/wbi.js", "lib/sse.js")', "BiliLib.encWbi", "x/player/wbi/v2", "x/player/v2", "x/web-interface/view", "resolveCid", "GET_SUBTITLES", "AI_CHAT", "AI_STOP", "AI_TEST", "chrome.cookies.getAll", "getReader", "VIDEO_CHANGED", "SUBTITLES_READY", "SUBTITLES_ERROR", "reasoning_content", "reasoningLevel", "reasoningModel", "CAPTURE_FRAME", "AI_VISION", "OffscreenCanvas", "createImageBitmap", "visionModel", "SseLib", "subtitleCache", "HTTP 404"].forEach(k => ok("background 包含 " + k, bg.includes(k)));
const extractor = fs.readFileSync(path.join(ROOT, "content/extractor.js"), "utf8");
ok("extractor 允许 cid 为空（携带 p）", extractor.includes("return { bvid, cid, p }"));
ok("extractor 有自动重试", extractor.includes("setTimeout(requestSubtitles, 3000)"));
ok("extractor 广播 VIDEO_CHANGED", extractor.includes("VIDEO_CHANGED"));
ok("extractor 四通道 URL 检测", extractor.includes("pushState") && extractor.includes("popstate") && extractor.includes("setInterval(checkUrlChange"));
ok("extractor 分P解析 p", extractor.includes("URLSearchParams") && extractor.includes("pages"));
ok("extractor 字幕就绪通知", extractor.includes("SUBTITLES_READY"));
ok("extractor 支持 /list/ 合集页（0.9.3）", extractor.includes("/^\\/list\\//"));
ok("extractor 导航令牌防乱序（0.9.3）", extractor.includes("reqSeq") && extractor.includes("seq !== reqSeq"));
const view = fs.readFileSync(path.join(ROOT, "content/subtitle-view.js"), "utf8");
["GET_CURRENT_SUBTITLES", "JUMP_TO_TIME", "PLAYBACK_HIGHLIGHT", "broadcastHighlight", "findIndex", "VIDEO_CHANGED", "SEEK_VIDEO", "GET_PLAYBACK_TIME"].forEach(k => ok("view.js 包含 " + k, view.includes(k)));
ok("view.js 已无浮动面板 UI（bili-sub-ai-panel 移除）", !view.includes("bili-sub-ai-panel") && !view.includes("bili-sub-ai-float"));
ok("view.js SEEK_VIDEO 保持异步消息通道（0.9.3）", view.includes("return true; // 异步响应"));
ok("view.js 支持 /list/ 合集页（0.9.3）", view.includes("/^\\/list\\//"));
const panel = fs.readFileSync(path.join(ROOT, "sidepanel/panel.js"), "utf8");
["GET_CURRENT_SUBTITLES", "AI_STREAM", "AI_STOP", "subResizer", "--subtitle-h", "PLAYBACK_HIGHLIGHT", "VIDEO_CHANGED", "chatHistory", "sendUserMessage", "【视频字幕知识库】", "historyBtn", "openHistoryWindow", "LOAD_HISTORY_TO_PANEL", "pendingOpenRecord", "mdToHtml", "JUMP_TO_TIME", "nowLine", "reasoning"].forEach(k => ok("panel.js 包含 " + k, panel.includes(k)));
["SUBTITLES_READY", "SUBTITLES_ERROR", "videoSwitchTimer"].forEach(k => ok("panel.js 包含 " + k, panel.includes(k)));
["captureAndSummarize", "CAPTURE_FRAME", "AI_VISION", "shotView", "shotThread", "askShot"].forEach(k => ok("panel.js 包含 " + k, panel.includes(k)));
ok("panel.js 恢复全文自动上下文", panel.includes("已自动附带字幕知识库（当前轨道"));
ok("panel.js 智能降载已撤销", !panel.includes("buildAutoContext") && !panel.includes("extractKeywords") && !panel.includes("STOP_WORDS"));
ok("panel.js 时间戳点击保留", panel.includes("ts-link"));
ok("panel.js 标签页切换监听", panel.includes("chrome.tabs.onActivated") && panel.includes("chrome.tabs.onUpdated"));
ok("panel.js 实时跟随（无标签缓存）", !panel.includes("activeTabId") && panel.includes("subLoadSeq"));
ok("panel.js 已移除 SIDEPANEL_STATE 逻辑", !panel.includes("SIDEPANEL_STATE"));
ok("panel.js 支持 /list/ 合集页（0.9.3）", panel.includes("(video\\/|list\\/)"));
ok("panel.js 截图总结停止会中断后台流（0.10.0）", panel.includes("shotStreamId"));
ok("panel.js 已移除分段间隔总结（0.10.0）", !panel.includes("buildSegments") && !panel.includes("segLen") && !panel.includes("summaryView"));
ok("panel.js 截图取当前播放位置（0.10.0）", panel.includes("GET_PLAYBACK_TIME"));
ok("panel.js 截图会话支持多轮追问（0.10.0）", panel.includes("SHOT_THREAD_MAX") && panel.includes("pushShotThread"));
ok("panel.js 截图总结共用流式渲染（0.10.0）", panel.includes("startChatStream") && panel.includes("createStreamBubble"));
ok("view.js 当前帧免 seek（0.10.0）", view.includes("needSeek"));
ok("panel.js 截图前校验视频页（0.10.0）", panel.includes("当前标签页不是 B 站视频页") && panel.includes("请切换到 B 站视频标签页后再截图"));
ok("panel.js 中断有本地兜底收尾（0.10.0）", panel.includes('finishStream(cur, null, "⚠ 已中断", true)'));
ok("panel.js 追问失败撤回提问（0.10.0）", panel.includes('shotThread[shotThread.length - 1].role === "user"') && panel.includes("shotThread.pop()"));
ok("panel.js 切视频重置截图会话（0.10.0）", panel.includes("已切换视频，截图会话已重置"));
ok("view.js 支持免权限直接抓帧 GRAB_FRAME（0.10.1）", view.includes("GRAB_FRAME") && view.includes("videoWidth") && view.includes("toDataURL"));
ok("view.js 抓帧与截图共用 prepareFrame（0.10.1）", view.includes("function prepareFrame") && view.includes("resumePlayback"));
ok("view.js 画布污染回报 tainted（0.10.1）", view.includes("tainted: true"));
ok("background 抓帧优先 canvas 再兜底截图（0.10.1）", bg.includes('type: "GRAB_FRAME"') && bg.includes('via: "canvas"') && bg.includes('via: "capture"'));
ok("background 截图权限错误给出授权指引（0.10.1）", bg.includes("all_urls|activeTab|permission") && bg.includes("授予截图兜底权限"));
ok("manifest 声明可选全站权限（0.10.1）", (manifest.optional_host_permissions || []).includes("<all_urls>"));
const optsHtml = fs.readFileSync(path.join(ROOT, "options/options.html"), "utf8");
const optsJs2 = fs.readFileSync(path.join(ROOT, "options/options.js"), "utf8");
ok("options 提供截图权限授予/撤销（0.10.1）", optsHtml.includes("grantShotBtn") && optsHtml.includes("revokeShotBtn"));
ok("options.js 用 permissions.request 申请（0.10.1）", optsJs2.includes("chrome.permissions.request") && optsJs2.includes("chrome.permissions.remove") && optsJs2.includes("chrome.permissions.contains"));
ok("panel.js 权限失败给出设置页入口（0.10.1）", panel.includes("chrome.runtime.openOptionsPage") && panel.includes("打开设置页授予截图兜底权限"));
const panelCss = fs.readFileSync(path.join(ROOT, "sidepanel/panel.css"), "utf8");
ok("panel.css 含截图总结样式且已清理旧样式（0.10.0）",
  panelCss.includes(".msg.shot-img") && panelCss.includes("#shotView") && panelCss.includes(".p-shot-status")
  && !panelCss.includes("#summaryView") && !panelCss.includes(".p-seglen"));
const popupJs = fs.readFileSync(path.join(ROOT, "popup/popup.js"), "utf8");
ok("popup.js 支持 /list/ 合集页（0.9.3）", popupJs.includes("(video\\/|list\\/)"));
const historyJs = fs.readFileSync(path.join(ROOT, "history/history.js"), "utf8");
["chatHistory", "pendingOpenRecord", "sidePanel.open", "renameCurrent", "deleteCurrent", "MarkdownLib"].forEach(k => ok("history.js 包含 " + k, historyJs.includes(k)));
ok("history.html 存在", fs.existsSync(path.join(ROOT, "history/history.html")));
ok("history.css 存在", fs.existsSync(path.join(ROOT, "history/history.css")));

const panelHtml = fs.readFileSync(path.join(ROOT, "sidepanel/panel.html"), "utf8");
ok("panel.html 含拖拽分隔条", panelHtml.includes("p-resizer"));
ok("panel.html 含截图总结页与 latex 引入", panelHtml.includes("shotView") && panelHtml.includes("../lib/latex.js") && panelHtml.includes("p-tab"));
ok("panel.html 截图总结含追问输入框（0.10.0）", panelHtml.includes("shotForm") && panelHtml.includes("shotInput") && panelHtml.includes("shotBtn"));
ok("panel.html 已移除分段间隔控件（0.10.0）", !panelHtml.includes("segLen") && !panelHtml.includes("summaryView"));
const latexJs = fs.readFileSync(path.join(ROOT, "lib/latex.js"), "utf8");
["latexToHtml", "GREEK", "lmatrix"].forEach(k => ok("latex.js 包含 " + k, latexJs.includes(k)));
ok("panel.html 含历史入口按钮且无内嵌历史视图", panelHtml.includes("historyBtn") && !panelHtml.includes("historyView"));
["ARCHITECTURE.md", "DECISIONS.md", "CHANGELOG.md", "FEATURE-AI-SUMMARY.md", "FEATURE-SHOT-SUMMARY.md"].forEach(k => ok("docs/" + k + " 存在", fs.existsSync(path.join(ROOT, "docs", k))));
ok("CI workflow 存在", fs.existsSync(path.join(ROOT, ".github/workflows/ci.yml")));
ok("sse.js 存在", fs.existsSync(path.join(ROOT, "lib/sse.js")));
const optsJs = fs.readFileSync(path.join(ROOT, "options/options.js"), "utf8");
["visionBaseUrl", "visionApiKey", "visionModel"].forEach(k => ok("options.js 包含 " + k, optsJs.includes(k)));
ok("options.js 保存时合并既有设置（0.9.3）", optsJs.includes("Object.assign({}, store.aiSettings || {}, read())"));
ok("options.js 模型列表判空（0.9.3）", optsJs.includes("Array.isArray(res.models)"));
ok("background 不再伪造 forbidden header（0.9.3）", !bg.includes("Cookie: cookieHeader") && bg.includes('credentials: "include"'));
ok("background SSE [DONE] 终止外层循环（0.9.3）", bg.includes("while (!finished)"));
ok("background temperature=0 不被吞（0.9.3）", bg.includes("numOr(settings.temperature"));
ok("background 回传解析出的 cid（0.9.3）", bg.includes("const { cid: realCid, list }"));

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);