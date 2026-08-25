// B站字幕 AI 助手 - Service Worker
// 职责：字幕接口代理（wbi 签名 + 登录态 + 缓存）、AI 请求代理（流式 + 可中断）、设置持久化
importScripts("lib/wbi.js", "lib/sse.js");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------- 基础工具 ----------
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 通过 chrome.cookies 读取 bilibili 域下所有 cookie，组装 Cookie 头
async function getBiliCookieHeader() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: ".bilibili.com" });
    if (!cookies || !cookies.length) return null;
    return cookies.map(c => c.name + "=" + c.value).join("; ");
  } catch (e) {
    console.warn("[bg] read cookies failed:", e);
    return null;
  }
}

// 统一带重试的 fetch（B站接口偶发风控/超时）
async function fetchWithRetry(url, options = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Referer": "https://www.bilibili.com/",
          ...(options.headers || {})
        },
        ...options
      });
      if (res.status === 412 || res.status === 429) {
        await sleep(500 * (i + 1));
        lastErr = new Error("HTTP " + res.status + " 风控/限流，已重试");
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error("HTTP " + res.status + "：请检查登录态 / API Key 是否有效");
      }
      if (res.status === 404) {
        throw new Error("HTTP 404：接口或资源不存在（B 站接口可能已变动）");
      }
      return res;
    } catch (e) {
      lastErr = e;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
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
async function getWbiKeys(cookieHeader) {
  const store = await chrome.storage.local.get("wbiKeys");
  if (store.wbiKeys && Date.now() - store.wbiKeys.fetchedAt < 86400000) {
    return { imgKey: store.wbiKeys.imgKey, subKey: store.wbiKeys.subKey };
  }
  const res = await fetchWithRetry("https://api.bilibili.com/x/web-interface/nav", {
    headers: { Cookie: cookieHeader || "" }
  });
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
async function resolveCid(bvid, p, cookieHeader) {
  const cacheKeyCid = (p ? bvid + ":" + p : bvid);
  const cachedCid = cidCache.get(cacheKeyCid);
  if (cachedCid) return cachedCid;

  const url1 = "https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid);
  const res1 = await fetchWithRetry(url1, { headers: { Cookie: cookieHeader || "" } });
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
  const res2 = await fetchWithRetry(url2, { headers: { Cookie: cookieHeader || "" } });
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
    .map(t => ({ lan: t.lan, lan_doc: t.lan_doc, subtitle_url: t.subtitle_url }))
    .sort((a, b) => score(a) - score(b));
}

async function fetchSubtitleList(bvid, cid, p) {
  const cookieHeader = await getBiliCookieHeader();
  if (!cid) cid = await resolveCid(bvid, p, cookieHeader);

  // 1) 首选：wbi 签名接口
  let lastErr = "";
  try {
    const keys = await getWbiKeys(cookieHeader);
    const signed = BiliLib.encWbi({ bvid, cid }, keys.imgKey, keys.subKey);
    const api = "https://api.bilibili.com/x/player/wbi/v2?" + signed;
    const res = await fetchWithRetry(api, { headers: { Cookie: cookieHeader || "" } });
    const json = await res.json();
    if (json.code === 0) return pickTracks(json);
    lastErr = "wbi/v2 code=" + json.code + " " + (json.message || "");
  } catch (e) {
    lastErr = "wbi/v2 " + (e && e.message ? e.message : String(e));
  }

  // 2) 回退：老接口 x/player/v2（无需签名）
  try {
    const api = "https://api.bilibili.com/x/player/v2?bvid=" + encodeURIComponent(bvid) + "&cid=" + encodeURIComponent(cid);
    const res = await fetchWithRetry(api, { headers: { Cookie: cookieHeader || "" } });
    const json = await res.json();
    if (json.code === 0) return pickTracks(json);
    lastErr += "；v2 code=" + json.code + " " + (json.message || "");
  } catch (e) {
    lastErr += "；v2 " + (e && e.message ? e.message : String(e));
  }
  throw new Error("字幕列表获取失败：" + lastErr);
}

async function fetchSubtitleTrack(track, cookieHeader, bvid) {
  let url = track.subtitle_url || track.url;
  if (!url) return null;
  if (url.startsWith("//")) url = "https:" + url;
  const res = await fetchWithRetry(url, {
    headers: { Cookie: cookieHeader || "", Referer: "https://www.bilibili.com/video/" + (bvid || "") }
  });
  if (!res.ok) return null;
  const json = await res.json();
  const lines = BiliLib.normalizeBody(json.body);
  return { lan: track.lan || "", lan_doc: track.lan_doc || track.label || "", url, lines };
}

async function handleGetSubtitles(msg) {
  const { bvid, cid } = msg;
  if (!bvid) return { ok: false, error: "缺少 bvid" };
  const cidNum = cid ? Number(cid) : null;
  const cacheKeyStr = cidNum ? cacheKey(bvid, cidNum) : null;

  if (cacheKeyStr) {
    const cached = await getCache(bvid, cidNum);
    if (cached) return { ok: true, fromCache: true, tracks: cached, cid: cidNum };
  }

  try {
    const list = await fetchSubtitleList(bvid, cidNum, msg.p);
    const cookieHeader = await getBiliCookieHeader();
    const results = await Promise.all(list.map(t => fetchSubtitleTrack(t, cookieHeader, bvid)));
    const tracks = results.filter(Boolean);
    if (cidNum) await setCache(bvid, cidNum, tracks);
    return { ok: true, fromCache: false, tracks, cid: cidNum, p: msg.p || null };
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
    temperature: Number(settings.temperature) || 0.7,
    stream: msg.stream !== false
  };

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
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const r = SseLib.feedBuffer(buffer, decoder.decode(value, { stream: true }));
      buffer = r.buffer;
      for (const line of r.lines) {
        const p = SseLib.parseLine(line);
        if (!p) continue;
        if (p.done) break;
        if (p.reasoning) emit({ reasoning: p.reasoning });
        if (p.delta) emit({ delta: p.delta });
      }
    }
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

// ---------- AI 总结：视频帧采集 + 视觉识别 ----------
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 截图 → 裁剪视频区域 → 压缩到 ≤1024px → dataURL
async function handleCaptureFrame(msg) {
  const { tabId, time } = msg;
  try {
    const tab = await chrome.tabs.get(tabId);
    const seed = await chrome.tabs.sendMessage(tabId, { type: "SEEK_VIDEO", time });
    if (!seed || !seed.ok || !seed.rect) {
      return { ok: false, error: "无法定位视频画面（播放器未就绪？）" };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 82 });
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
    return { ok: true, image: "data:image/jpeg;base64," + bufToBase64(buf), size: ow + "x" + oh };
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
