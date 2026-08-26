// B站字幕 AI 助手 - Service Worker
// 职责：字幕接口代理（wbi 签名 + 登录态 + 缓存）、AI 请求代理（流式 + 可中断）、设置持久化
importScripts("lib/wbi.js", "lib/sse.js");

// ---------- 基础工具 ----------
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 数值兜底：0 是合法值，不能被 || 吞掉（temperature=0 曾被改写为 0.7）
function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// 登录态探测：只读 SESSDATA 判断是否已登录（用于给出明确错误提示）。
// 注意：Cookie 是 forbidden header，脚本无法通过 fetch headers 设置；
// 登录态由 credentials:"include" 让浏览器自行携带（host_permissions 已授权 B 站域）。
async function hasBiliLogin() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: ".bilibili.com", name: "SESSDATA" });
    return !!(cookies && cookies.length && cookies[0].value);
  } catch (e) {
    console.warn("[bg] read cookies failed:", e);
    return false;
  }
}

// 致命错误（语义明确，不重试）
function fatalError(message) {
  const e = new Error(message);
  e.fatal = true;
  return e;
}

// 统一带重试的 fetch：仅网络错误 / 风控限流 / 5xx 重试（指数退避），4xx 语义错误立即失败。
// 说明：Cookie / Referer / User-Agent 均为 forbidden header，扩展脚本设置后会被浏览器丢弃，
// 因此这里不再伪造请求头，登录态一律依赖 credentials:"include"。
async function fetchWithRetry(url, options = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { credentials: "include", ...options });
      if (res.status === 412 || res.status === 429) {
        lastErr = new Error("HTTP " + res.status + "：触发 B 站风控/限流，请稍后重试");
        if (i < retries) await sleep(600 * Math.pow(2, i));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw fatalError("HTTP " + res.status + "：请检查 B 站登录态 / API Key 是否有效");
      }
      if (res.status === 404) {
        throw fatalError("HTTP 404：接口或资源不存在（B 站接口可能已变动）");
      }
      if (res.status >= 500) {
        lastErr = new Error("HTTP " + res.status + "：服务端异常");
        if (i < retries) await sleep(600 * Math.pow(2, i));
        continue;
      }
      return res;
    } catch (e) {
      if (e && e.fatal) throw e;
      lastErr = e;
      if (i < retries) await sleep(500 * Math.pow(2, i));
    }
  }
  throw lastErr || new Error("请求失败");
}

// ---------- 字幕缓存（内存热缓存 + chrome.storage 持久缓存，MV3 SW 重启不丢失） ----------
const STORAGE_CACHE_KEY = "subtitleCache";
const subtitleCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 8; // 持久缓存条数上限（超出按最旧淘汰）
function cacheKey(bvid, cid) { return bvid + ":" + cid; }

async function getCache(bvid, cid) {
  const k = cacheKey(bvid, cid);
  const mem = subtitleCache.get(k);
  if (mem && Date.now() - mem.fetchedAt < CACHE_TTL) return mem.tracks;
  try {
    const store = await chrome.storage.local.get(STORAGE_CACHE_KEY);
    const obj = store[STORAGE_CACHE_KEY] || {};
    const item = obj[k];
    if (item && Date.now() - item.fetchedAt < CACHE_TTL) {
      subtitleCache.set(k, item); // 回填热缓存
      return item.tracks;
    }
  } catch (_) { /* ignore */ }
  return null;
}

async function setCache(bvid, cid, tracks) {
  const k = cacheKey(bvid, cid);
  const item = { tracks, fetchedAt: Date.now() };
  subtitleCache.set(k, item);
  try {
    const store = await chrome.storage.local.get(STORAGE_CACHE_KEY);
    const obj = store[STORAGE_CACHE_KEY] || {};
    obj[k] = item;
    const keys = Object.keys(obj);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (obj[a].fetchedAt || 0) - (obj[b].fetchedAt || 0));
      keys.slice(0, keys.length - CACHE_MAX).forEach(dk => { delete obj[dk]; });
    }
    await chrome.storage.local.set({ [STORAGE_CACHE_KEY]: obj });
  } catch (_) { /* ignore */ }
}

// ---------- wbi 密钥（缓存 1 天） ----------
async function getWbiKeys() {
  const store = await chrome.storage.local.get("wbiKeys");
  if (store.wbiKeys && Date.now() - store.wbiKeys.fetchedAt < 86400000) {
    return { imgKey: store.wbiKeys.imgKey, subKey: store.wbiKeys.subKey };
  }
  const res = await fetchWithRetry("https://api.bilibili.com/x/web-interface/nav");
  const json = await res.json();
  const wbi = json && json.data && json.data.wbi_img;
  if (!wbi || !wbi.img_url || !wbi.sub_url) {
    throw new Error("获取 wbi 密钥失败（nav 接口 code=" + (json && json.code) + "）");
  }
  const keys = {
    imgKey: BiliLib.keyFromUrl(wbi.img_url),
    subKey: BiliLib.keyFromUrl(wbi.sub_url)
  };
  await chrome.storage.local.set({ wbiKeys: { ...keys, fetchedAt: Date.now() } });
  return keys;
}

// ---------- 视频信息 / 字幕提取 ----------
const cidCache = new Map(); // bvid:p -> cid（内存缓存）
// 解析 cid：优先 view 接口的 pages 按分P编号 p 匹配；无 p 用主 cid；再回退 pagelist
async function resolveCid(bvid, p) {
  const cacheKeyCid = (p ? bvid + ":" + p : bvid);
  const cachedCid = cidCache.get(cacheKeyCid);
  if (cachedCid) return cachedCid;

  const url1 = "https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid);
  const res1 = await fetchWithRetry(url1);
  const json1 = await res1.json();
  if (json1.code === 0 && json1.data) {
    let cid = null;
    if (p != null && Array.isArray(json1.data.pages)) {
      const target = json1.data.pages.find(pg => Number(pg.page) === Number(p));
      if (target && target.cid) cid = target.cid;
    }
    if (!cid && json1.data.cid) cid = json1.data.cid;
    if (cid) {
      cidCache.set(cacheKeyCid, cid);
      return cid;
    }
  }

  const url2 = "https://api.bilibili.com/x/player/pagelist?bvid=" + encodeURIComponent(bvid);
  const res2 = await fetchWithRetry(url2);
  const json2 = await res2.json();
  if (json2.code === 0) {
    const idx = p != null ? Number(p) - 1 : 0;
    const page = json2.data && (json2.data[idx] || json2.data[0]);
    if (page && page.cid) {
      cidCache.set(cacheKeyCid, page.cid);
      return page.cid;
    }
  }

  throw new Error("无法获取视频 cid（view=" + json1.code + " pagelist=" + json2.code + "）");
}

// 从播放器接口响应中提取字幕轨道列表（按中文优先排序）
function pickTracks(json) {
  const subtitle = json.data && json.data.subtitle;
  const tracks = (subtitle && subtitle.subtitles) || [];
  const score = t => {
    const lan = (t.lan || "").toLowerCase();
    if (lan.includes("zh-cn")) return 0;
    if (lan.includes("ai-zh")) return 1;
    return 2;
  };
  return tracks
    // 保留 url/label 备用字段：部分响应只带 url，此前被这里过滤掉会导致轨道无法下载
    .map(t => ({ lan: t.lan, lan_doc: t.lan_doc || t.label || "", subtitle_url: t.subtitle_url || t.url || "" }))
    .filter(t => !!t.subtitle_url)
    .sort((a, b) => score(a) - score(b));
}

// 返回 { cid, list }：cid 可能是本函数解析出来的，必须回传给调用方用于缓存与页面同步
async function fetchSubtitleList(bvid, cid, p) {
  if (!cid) cid = await resolveCid(bvid, p);

  // 1) 首选：wbi 签名接口
  let lastErr = "";
  try {
    const keys = await getWbiKeys();
    const signed = BiliLib.encWbi({ bvid, cid }, keys.imgKey, keys.subKey);
    const api = "https://api.bilibili.com/x/player/wbi/v2?" + signed;
    const res = await fetchWithRetry(api);
    const json = await res.json();
    if (json.code === 0) return { cid, list: pickTracks(json) };
    // 签名可能因密钥过期失效：清掉缓存的密钥，下次重新获取
    if (json.code === -403) await chrome.storage.local.remove("wbiKeys");
    lastErr = "wbi/v2 code=" + json.code + " " + (json.message || "");
  } catch (e) {
    lastErr = "wbi/v2 " + (e && e.message ? e.message : String(e));
  }

  // 2) 回退：老接口 x/player/v2（无需签名）
  try {
    const api = "https://api.bilibili.com/x/player/v2?bvid=" + encodeURIComponent(bvid) + "&cid=" + encodeURIComponent(cid);
    const res = await fetchWithRetry(api);
    const json = await res.json();
    if (json.code === 0) return { cid, list: pickTracks(json) };
    lastErr += "；v2 code=" + json.code + " " + (json.message || "");
  } catch (e) {
    lastErr += "；v2 " + (e && e.message ? e.message : String(e));
  }
  const loggedIn = await hasBiliLogin();
  throw new Error("字幕列表获取失败：" + lastErr + (loggedIn ? "" : "（当前浏览器未登录 B 站，部分视频字幕需登录后才可读取）"));
}

async function fetchSubtitleTrack(track) {
  let url = track.subtitle_url || track.url;
  if (!url) return null;
  if (url.startsWith("//")) url = "https:" + url;
  try {
    // Referer 同样是 forbidden header，脚本设置会被丢弃：字幕 JSON（hdslb CDN）不校验 Referer，直接请求即可
    const res = await fetchWithRetry(url);
    if (!res.ok) return null;
    const json = await res.json();
    const lines = BiliLib.normalizeBody(json.body);
    if (!lines.length) return null;
    return { lan: track.lan || "", lan_doc: track.lan_doc || track.label || "", url, lines };
  } catch (e) {
    console.warn("[bg] fetch track failed:", url, e && e.message);
    return null; // 单条轨道失败不影响其他轨道
  }
}

async function handleGetSubtitles(msg) {
  const { bvid, cid } = msg;
  if (!bvid) return { ok: false, error: "缺少 bvid" };
  const cidNum = cid ? Number(cid) : null;

  if (cidNum) {
    const cached = await getCache(bvid, cidNum);
    if (cached) return { ok: true, fromCache: true, tracks: cached, cid: cidNum, p: msg.p || null };
  }

  try {
    const { cid: realCid, list } = await fetchSubtitleList(bvid, cidNum, msg.p);
    // cid 由后台解析时也要查一次缓存，避免重复拉取整套字幕
    if (!cidNum && realCid) {
      const cached = await getCache(bvid, realCid);
      if (cached) return { ok: true, fromCache: true, tracks: cached, cid: realCid, p: msg.p || null };
    }
    const results = await Promise.all(list.map(t => fetchSubtitleTrack(t)));
    const tracks = results.filter(Boolean);
    if (realCid) await setCache(bvid, realCid, tracks);
    return { ok: true, fromCache: false, tracks, cid: realCid || cidNum, p: msg.p || null };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

// ---------- AI 配置与请求 ----------
const DEFAULT_SETTINGS = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-chat",
  reasoningLevel: 0,               // 0=普通 1=深度思考
  reasoningModel: "deepseek-reasoner",
  visionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  visionApiKey: "",
  visionModel: "qwen-vl-plus",
  temperature: 0.7,
  systemPrompt: "你是专业的视频内容分析助手。你只基于用户提供的视频字幕进行总结、提炼、翻译与问答。回答使用与问题相同的语言，表达简洁、结构清晰。"
};

async function getSettings() {
  const store = await chrome.storage.local.get("aiSettings");
  return Object.assign({}, DEFAULT_SETTINGS, store.aiSettings || {});
}

const activeStreams = new Map(); // streamId -> AbortController

async function handleAiChat(msg) {
  const settings = await getSettings();
  if (!settings.apiKey) return { ok: false, error: "未配置 API Key，请先在设置页填写" };

  const baseUrl = (settings.baseUrl || "").replace(/\/+$/, "");
  const url = baseUrl + "/chat/completions";
  const controller = new AbortController();
  const streamId = msg.id;
  if (streamId) activeStreams.set(streamId, controller);

  // 思考等级：1 时切换为推理模型（如 deepseek-reasoner），可输出 reasoning_content
  const useReasoning = Number(settings.reasoningLevel) === 1;
  const model = useReasoning ? (settings.reasoningModel || DEFAULT_SETTINGS.reasoningModel) : (settings.model || DEFAULT_SETTINGS.model);
  const payload = {
    model,
    messages: [
      { role: "system", content: settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt },
      ...(msg.messages || [])
    ],
    temperature: numOr(settings.temperature, DEFAULT_SETTINGS.temperature),
    stream: msg.stream !== false
  };
  // 推理模型（deepseek-reasoner 等）不接受 temperature，带上会被接口拒绝
  if (useReasoning) delete payload.temperature;

  const emit = (data) => {
    if (!streamId) return;
    chrome.runtime.sendMessage(Object.assign({ type: "AI_STREAM", id: streamId }, data)).catch(() => {});
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + settings.apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: "AI 接口 HTTP " + res.status + ": " + text.slice(0, 300) };
    }
    if (!payload.stream) {
      const json = await res.json();
      const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      return { ok: true, content: content || "" };
    }
    if (!res.body) return { ok: false, error: "AI 接口未返回流式响应体" };
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finished = false;
    // [DONE] 必须终止整个读取循环（此前只 break 内层 for，流不会关闭）
    const consume = (lines) => {
      for (const line of lines) {
        const p = SseLib.parseLine(line);
        if (!p) continue;
        if (p.done) { finished = true; return; }
        if (p.reasoning) emit({ reasoning: p.reasoning });
        if (p.delta) emit({ delta: p.delta });
      }
    };
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      const r = SseLib.feedBuffer(buffer, decoder.decode(value, { stream: true }));
      buffer = r.buffer;
      consume(r.lines);
    }
    // 尾部残留（最后一行可能没有换行符）
    if (!finished && buffer.trim()) consume([buffer]);
    if (finished) { try { await reader.cancel(); } catch (_) { /* ignore */ } }
    emit({ done: true });
    return { ok: true, streamed: true };
  } catch (e) {
    if (e && e.name === "AbortError") {
      emit({ error: "已中断" });
      return { ok: false, error: "已中断" };
    }
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  } finally {
    if (streamId) activeStreams.delete(streamId);
  }
}

// ---------- 截图总结：视频帧采集 + 视觉识别 ----------
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 截图 → 裁剪视频区域 → 压缩到 ≤1024px → dataURL
// 双路径：① content 内 canvas 直接抓 video 帧（无需任何截图权限，首选）；
//        ② captureVisibleTab 整页截图后裁剪（需 <all_urls>/activeTab，仅当 ① 画布被污染时兜底）。
async function handleCaptureFrame(msg) {
  const { tabId, time } = msg;
  try {
    // ① 直接抓帧：B 站用 MSE(blob:) 播放，画布不会被污染，绝大多数情况一步到位
    let grab = null;
    try {
      grab = await chrome.tabs.sendMessage(tabId, { type: "GRAB_FRAME", time });
    } catch (e) {
      return { ok: false, error: "未连接到视频页，请在 B 站视频页刷新后重试" };
    }
    if (grab && grab.ok && grab.image) {
      return { ok: true, image: grab.image, size: grab.size || "", via: "canvas" };
    }
    // 明确的非权限类失败（播放器未就绪等）：直接回报，兜底截图也救不了
    if (grab && !grab.tainted) {
      return { ok: false, error: (grab.error || "无法读取视频帧") };
    }

    // ② 兜底：整页截图 + 裁剪视频区域
    const tab = await chrome.tabs.get(tabId);
    const seed = await chrome.tabs.sendMessage(tabId, { type: "SEEK_VIDEO", time });
    if (!seed || !seed.ok || !seed.rect) {
      return { ok: false, error: "无法定位视频画面（播放器未就绪？）" };
    }
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 82 });
    } catch (e) {
      const em = (e && e.message) ? e.message : String(e);
      // activeTab 只在用户点击扩展图标等操作后临时授予，侧边栏里的按钮不会触发它，
      // 所以兜底路径需要用户显式授予全站权限。
      if (/all_urls|activeTab|permission/i.test(em)) {
        return { ok: false, error: "视频帧被跨域保护（无法直接抓帧），兜底整页截图缺少权限。请在「设置 → 视觉模型」点击「授予截图兜底权限」后重试。" };
      }
      return { ok: false, error: "整页截图失败：" + em };
    }
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = bmp.width / (seed.viewWidth || bmp.width);
    const sx = Math.max(0, Math.round(seed.rect.left * scale));
    const sy = Math.max(0, Math.round(seed.rect.top * scale));
    const sw = Math.max(1, Math.min(bmp.width - sx, Math.round(seed.rect.width * scale)));
    const sh = Math.max(1, Math.min(bmp.height - sy, Math.round(seed.rect.height * scale)));
    const maxEdge = 1024;
    const ratio = Math.min(1, maxEdge / Math.max(sw, sh));
    const ow = Math.max(1, Math.round(sw * ratio));
    const oh = Math.max(1, Math.round(sh * ratio));
    const canvas = new OffscreenCanvas(ow, oh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, ow, oh);
    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const buf = await outBlob.arrayBuffer();
    return { ok: true, image: "data:image/jpeg;base64," + bufToBase64(buf), size: ow + "x" + oh, via: "capture" };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

// 视觉识别（OpenAI 兼容 vision 接口，独立配置）
const VISION_PROMPT = "你是课程板书/屏幕识别助手。识别这张教学画面中的数学公式与关键文字：" +
  "公式一律用 LaTeX 输出（行内 $...$、块级 $$...$$）；说明性文字用中文简述。" +
  "输出格式：先列出画面中的公式，再简要说明画面的讲解主题。若画面无有效内容，输出“（无有效画面内容）”。";

async function handleAiVision(msg) {
  const settings = await getSettings();
  if (!settings.visionApiKey) return { ok: false, error: "未配置视觉模型 API Key（设置页-视觉模型）" };
  const baseUrl = (settings.visionBaseUrl || "").replace(/\/+$/, "");
  const url = baseUrl + "/chat/completions";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + settings.visionApiKey
      },
      body: JSON.stringify({
        model: settings.visionModel || "qwen-vl-plus",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: msg.prompt || VISION_PROMPT },
            { type: "image_url", image_url: { url: msg.image } }
          ]
        }],
        temperature: 0.2
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: "视觉接口 HTTP " + res.status + ": " + text.slice(0, 200) };
    }
    const json = await res.json();
    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return { ok: true, content: content || "" };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

async function handleAiTest() {
  const settings = await getSettings();
  if (!settings.apiKey) return { ok: false, error: "未配置 API Key" };
  const baseUrl = (settings.baseUrl || "").replace(/\/+$/, "");
  try {
    const res = await fetch(baseUrl + "/models", {
      headers: { "Authorization": "Bearer " + settings.apiKey }
    });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status + "，请检查 Base URL 与 Key" };
    const json = await res.json();
    const models = (json.data || []).map(m => m.id);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  (async () => {
    switch (msg.type) {
      case "PING":
        return { ok: true, version: chrome.runtime.getManifest().version };
      case "GET_SUBTITLES":
        return await handleGetSubtitles(msg);
      case "VIDEO_CHANGED":
        // 统一转发：content → background → 所有扩展页面（侧边栏自动刷新字幕）
        chrome.runtime.sendMessage({ type: "VIDEO_CHANGED", bvid: msg.bvid || null, p: msg.p || null }).catch(() => {});
        return { ok: true };
      case "SUBTITLES_READY":
        // 新字幕已就绪：通知侧边栏重新拉取（解决“切换后仍显示旧字幕”的时序问题）
        chrome.runtime.sendMessage({ type: "SUBTITLES_READY", bvid: msg.bvid || null }).catch(() => {});
        return { ok: true };
      case "SUBTITLES_ERROR":
        chrome.runtime.sendMessage({ type: "SUBTITLES_ERROR", error: msg.error || "字幕获取失败" }).catch(() => {});
        return { ok: true };
      case "AI_CHAT":
        return await handleAiChat(msg);
      case "AI_STOP": {
        const c = activeStreams.get(msg.id);
        if (c) { try { c.abort(); } catch (_) {} }
        return { ok: true };
      }
      case "AI_TEST":
        return await handleAiTest();
      case "CAPTURE_FRAME":
        return await handleCaptureFrame(msg);
      case "AI_VISION":
        return await handleAiVision(msg);
      default:
        return { ok: false, error: "未知消息类型: " + msg.type };
    }
  })().then(sendResponse).catch(err => {
    sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
  });
  return true; // 异步响应
});
