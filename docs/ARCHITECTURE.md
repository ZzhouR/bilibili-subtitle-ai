# 架构说明（Architecture）

> 目的：让新成员/未来的自己快速理解模块职责与数据流，避免冗余实现。代码细节以代码为准，本文只描述结构与契约。

## 1. 三层架构

```
┌────────────────────────── 扩展页面层 ──────────────────────────┐
│ sidepanel/panel  AI 对话 + 字幕浏览 + 截图总结（侧边栏）          │
│ popup 状态显示 + 快捷入口        options  AI 服务设置            │
└──────────────┬─────────────────────────────────────┬──────────┘
               │ chrome.runtime 消息                  │
┌──────────────▼──────────┐            ┌─────────────▼──────────┐
│ background (SW)          │            │ content scripts        │
│ · 字幕接口代理(wbi 签名)  │            │ · extractor 识别视频    │
│ · AI 请求代理(流式)       │            │ · subtitle-view 播放同步│
│ · 设置/密钥/缓存          │            │   （高亮/跳转/截图定位）│
└──────────────┬──────────┘            └─────────────┬──────────┘
               │ fetch(credentials)                  │ DOM/CustomEvent
               ▼                                     ▼
        api.bilibili.com / DeepSeek          页面窗口（video 元素等）
```

## 2. 模块职责

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `lib/wbi.js` | 纯函数：MD5、wbi 签名（`encWbi`）、字幕解析（`parseTs`/`normalizeBody`） | 无 DOM/Chrome 依赖，可被 SW importScripts 与 node require |
| `background.js` | 唯一访问网络/密钥的模块；消息路由；缓存（字幕 30min、wbi 密钥 1d、cid 内存缓存） | API Key 永不进入页面上下文 |
| `content/extractor.js` | 识别视频页 bvid/cid/p（`/video/` 与 `/list/`），请求字幕并广播 `SUB_READY` | cid 允许为空（由后台解析并回传）；导航令牌丢弃过期响应；失败自动重试 2 次（3s 间隔） |
| `content/subtitle-view.js` | 播放同步服务（无 UI）：监听 video、为各轨道计算当前行、广播 `PLAYBACK_HIGHLIGHT`、响应 `JUMP_TO_TIME`；截图总结 `GRAB_FRAME`（canvas 直接抓帧，免权限）与 `SEEK_VIDEO`（兜底：返回视频位置供后台裁剪） | 依赖 `SUB_READY` 广播；不再包含任何浮动面板 UI；两条截图路径共用 `prepareFrame()` |
| `lib/latex.js` | 零依赖迷你 LaTeX→HTML 渲染器（希腊字母/分数/根号/上下标/矩阵/符号/重音） | 词边界命令替换 + HTML 转义安全；矩阵单元格递归渲染 |
| `sidepanel/` | 字幕浏览（勾选行/全选）、上下文组装、AI 对话（流式 + 停止、自动知识库）、截图总结（按需单帧 + 多轮追问） | 唯一的字幕展示位置（视频页不再注入任何 UI）；两个标签页共用 `startChatStream` 流式渲染 |
| `history/` | 对话历史管理独立窗口：搜索/查看/重命名/删除/载入侧边栏续聊 | 与侧边栏经 `pendingOpenRecord` + 消息协作 |
| `options/` | AI 服务配置，存 `chrome.storage.local` 的 `aiSettings` | 支持测试连接（GET /models） |
| `popup/` | 显示当前视频字幕状态；打开侧边栏/设置 | 依赖 content 的 `GET_CURRENT_SUBTITLES` |

## 3. 消息协议（稳定契约）

| 方向 | type | 载荷 | 响应 |
|---|---|---|---|
| content → background | `GET_SUBTITLES` | `{bvid, cid?, p?}` | `{ok, tracks[], fromCache, cid}`（cid 为后台实际使用的 cid）或 `{ok:false, error}` |
| panel/popup → content | `GET_CURRENT_SUBTITLES` | – | `{ok, tracks[], info}` |
| panel → content | `GRAB_FRAME` | `{time}` | `{ok, image, size}` 或 `{ok:false, tainted?, error}`（异步；canvas 直接抓帧，免截图权限；`tainted` 表示画布被污染或全黑，需兜底） |
| panel → content | `SEEK_VIDEO` | `{time}` | `{ok, rect, viewWidth, viewHeight}`（异步；仅兜底路径使用。暂停后：目标≈当前帧则免 seek，否则 seek 并等 `seeked`/1500ms，再等画面稳定） |
| panel → content | `GET_PLAYBACK_TIME` | – | `{ok, time, duration}` |
| content → 扩展页 | `PLAYBACK_HIGHLIGHT` | `{indexes:[{trackIndex,index}]}` | –（侧边栏同步高亮/滚动） |
| content → 扩展页 | `VIDEO_CHANGED` | `{bvid}` | –（侧边栏自动刷新字幕） |
| history 窗口 → 侧边栏 | `LOAD_HISTORY_TO_PANEL` | `{id}` | –（侧边栏载入该历史对话） |
| content → background → 扩展页 | `SUBTITLES_READY` | `{bvid}` | –（新字幕就绪，侧边栏拉取最新字幕） |
| content → background → 扩展页 | `SUBTITLES_ERROR` | `{error}` | –（新字幕获取失败，侧边栏刷新状态） |
| panel → background | `CAPTURE_FRAME` | `{tabId, time}` | `{ok, image, size, via:"canvas"\|"capture"}` 或 `{ok:false,error}`（先 `GRAB_FRAME`，污染/全黑才 `captureVisibleTab`+裁剪） |
| panel → background | `AI_VISION` | `{image, prompt?}` | `{ok, content}`（视觉模型识别） |
| panel → background | `AI_CHAT` | `{id, messages[], stream}` | 异步：`AI_STREAM` 广播 + 最终 `{ok,streamed}` |
| background → 所有扩展页 | `AI_STREAM` | `{id, delta\|done\|error}` | – |
| panel/popup → background | `AI_STOP` / `AI_TEST` / `PING` | `{id?}` / – / – | `{ok}` / `{ok,models}` / `{ok,version}` |

> 页面内部：extractor 与 subtitle-view 通过 `window.dispatchEvent(new CustomEvent("bili-subtitle-ai", {detail}))` 通信（`SUB_READY` / `SUB_STATUS` / `TRACK_CHANGED`）。

## 4. 字幕提取链路

1. `extractor` 从 URL 解析 bvid（`/video/BVxxx` 或 `/list/...?bvid=BVxxx`；SPA 切换时四通道重触发，仅 bvid/分P 变化才算切换）；
2. 发 `GET_SUBTITLES`（cid 可为空），并用递增 `reqSeq` 丢弃过期响应；
3. `background`：无 cid → `x/web-interface/view` 解析（失败再试 `x/player/pagelist`），解析出的 cid 随响应回传；登录态由 `credentials:"include"` 自动携带（见 D7）；
4. 字幕列表：**优先 `x/player/wbi/v2` + wbi 签名**（code=-403 时清除缓存密钥）；失败回退 `x/player/v2`；
5. 并行拉取各轨道 JSON → `normalizeBody` 归一化（排序 + 补齐异常 `end`）→ 按 bvid:cid 缓存 → 返回；
6. `extractor` 广播 `SUB_READY` → `subtitle-view` 计算高亮，侧边栏渲染轨道/行。

## 5. AI 对话链路

1. panel 组装 messages（可含字幕上下文块：`【视频字幕】\n[mm:ss] 文本`）；
2. `AI_CHAT` → background 读 `aiSettings` → POST `{baseUrl}/chat/completions`（OpenAI 兼容）；
3. 流式：逐段 `data:` 解析 → `AI_STREAM` 广播 delta；`AI_STOP` 用 AbortController 中断。

## 5b. 截图总结链路（0.10.0，抓帧方式 0.10.1 改版）

1. panel 取当前播放位置（`GET_PLAYBACK_TIME`）→ `CAPTURE_FRAME`；后台先试 `GRAB_FRAME`（页面内 canvas 直接抓 video 帧，**不需要任何截图权限**），仅当画布被污染或抓到全黑帧时才回退 `captureVisibleTab` + 裁剪（该兜底需用户在设置页授予可选权限 `<all_urls>`）；
2. `AI_VISION` 交视觉模型识别（公式输出 LaTeX）；
3. 把「画面识别结果 +（可选）±30s 附近字幕 + 总结指令」作为一条 user 消息追加进会话线程 `shotThread`，整体经 `AI_CHAT` 流式总结；
4. 追问/再截图都追加进同一 `shotThread`（上限 24 条），因此多轮上下文连续；详见 `docs/FEATURE-SHOT-SUMMARY.md`。

## 6. 持久化与缓存

| 键 | 位置 | 有效期 | 用途 |
|---|---|---|---|
| `aiSettings` | chrome.storage.local | 永久 | AI 服务配置 |
| `wbiKeys` | chrome.storage.local | 1 天 | wbi 签名密钥 |
| 字幕缓存 | SW 内存 Map + `chrome.storage.local.subtitleCache` | 30 分钟（上限 8 条 LRU） | 同视频重复请求 |
| cid 缓存 | SW 内存 Map | 会话 | bvid[:p]→cid |
| `bili-subtitle-ai-panel-split` | localStorage（侧边栏） | 永久 | 上下区域比例 |
| `chatHistory` | chrome.storage.local | 永久（上限 100 条） | 对话历史（不含字幕知识库正文，按 bvid 关联） |
| `pendingOpenRecord` | chrome.storage.local | 一次性 | 历史窗口请求侧边栏载入的对话 id |
