# 功能设计：截图总结（按需截屏 → 视觉识别 → 可追问）

> 目标：在教学视频里看到关键板书时，点一下就把**当前画面**交给视觉模型识别，生成结构化中文总结，并能围绕这张画面**继续多轮追问**。
>
> 0.10.0 起取代旧的「AI 总结（按分段间隔自动截图）」：不再按 120s 分段遍历整个视频，改为完全由用户驱动的单帧截图。

## 1. 原理与数据流

```
侧边栏「📸 截图总结」→ 点「📷 截图并总结」
  ├─ 播放位置：panel → content GET_PLAYBACK_TIME（当前 currentTime）
  ├─ 画面：panel → background CAPTURE_FRAME { tabId, time }
  │   ① 首选（免权限）：→ content GRAB_FRAME
  │        暂停；当前帧免 seek，否则 seek 后等 seeked/1500ms
  │        → canvas.drawImage(video) → 抽样探测全黑帧 → toDataURL(jpeg, 0.85)
  │   ② 兜底（需授权）：仅当画布被污染 / 抓到全黑帧（tainted）时
  │        → content SEEK_VIDEO 返回 video 位置
  │        → background captureVisibleTab（整页截图）
  │        → OffscreenCanvas 裁剪视频区域 + 压缩（≤1024px, JPEG q0.85）→ dataURL
  ├─ 识别：panel → background AI_VISION { image } → 视觉模型（OpenAI 兼容）→ LaTeX/文字
  ├─ 总结：把「画面识别结果 +（可选）附近 ±30s 字幕 + 总结指令」作为一条 user 消息
  │     追加进 shotThread，整个线程发给对话模型（AI_CHAT, stream）
  └─ 追问：用户在本页输入框继续提问 → 同一个 shotThread 追加 user 消息 → 再次 AI_CHAT
        （可随时再截一张：新画面识别结果继续追加进同一线程）
```

### 为什么首选 `canvas.drawImage(video)` 而不是 `captureVisibleTab`（0.10.1）

`chrome.tabs.captureVisibleTab` 要求 `<all_urls>` 主机权限，或由**用户手势**临时授予的 `activeTab`。侧边栏按钮不是能激活 `activeTab` 的手势，manifest 静态声明的 `activeTab` 对它无效 —— 0.10.0 里每次截图都返回 `Either the '<all_urls>' or 'activeTab' permission is required.`。

直接抓帧没有这个限制，且额外更优：分辨率是视频原生尺寸（不是视口缩放后的），不受窗口遮挡/最小化影响，也不会把播放器 UI、弹幕层截进去。仅在画布被跨域污染或抓到全黑帧时才需要整页截图兜底，因此 `<all_urls>` 放进 `optional_host_permissions` 按需申请。

## 2. UI 结构（`sidepanel/panel.html` `#shotView`）

| 元素 | 作用 |
|---|---|
| `#shotBtn` | 截图并总结（进行中禁用） |
| `#shotStopBtn` | 中断：`AI_STOP` 真正 abort 后台流 |
| `#shotClearBtn` | 清空会话线程与消息列表 |
| `#shotWithSub` | 是否附带截图时刻附近 ±30s 字幕（默认开） |
| `#shotStatus` | 单行状态：读取播放位置 / 截图 / 识别 / 总结 / 完成 / 错误 |
| `#shotList` | 消息列表：截图缩略图（点击跳回该时间点）+ 画面识别 + AI 总结/回答 |
| `#shotForm` / `#shotInput` | 追问输入（必须先截图，否则提示） |

## 3. 关键决策

- **单帧、按需**：截图时机由用户决定，成本可控、无长时间占用播放器；旧的分段遍历（`segLen` / `buildSegments`）整体移除。
- **多轮上下文**：`shotThread` 保存「画面识别结果 + 历次问答」，每次请求整体回传；上限 `SHOT_THREAD_MAX = 24` 条，超出丢弃最旧的，避免上下文无限膨胀。
- **视觉模型必需**：截图总结的核心是画面识别，未配置 `visionApiKey` 时直接给出明确指引（不再静默退化为纯字幕总结）。
- **当前帧免 seek**：`prepareFrame()` 中若目标与 `currentTime` 差值 ≤0.05s 则跳过 seek —— 写入同值不会触发 `seeked`，否则每次截图都要白等 1500ms 超时。`GRAB_FRAME` 与 `SEEK_VIDEO` 共用这段逻辑。
- **零权限优先**：截图默认不申请任何额外权限；`<all_urls>` 作为 `optional_host_permissions` 仅在兜底路径需要时由用户在设置页授予（见上文 1 节）。
- **共用流式渲染**：`startChatStream()` / `createStreamBubble()` 由「字幕对话」与「截图总结」共用；只有字幕对话写入 `chatHistory`（`record: true`），截图会话不落历史。
- **公式渲染**：识别结果与总结均走 `lib/markdown.js` + `lib/latex.js`，`$...$` / `$$...$$` 直接渲染。

## 3b. 失败与边界处理

| 情形 | 行为 |
|---|---|
| 未配置 `visionApiKey` | 明确指引「设置 → 视觉模型」，不发任何截图请求 |
| 当前标签页非 B 站视频页 | 截图前用 URL 正则（`/video/`、`/list/`）拦下，提示切换标签页 |
| content 未注入（页面未刷新） | `GET_PLAYBACK_TIME` 抛错 → 提示"在 B 站视频页刷新后重试" |
| 画布被跨域污染 / 抓到全黑帧 | content 回报 `tainted: true` → 后台自动回退整页截图裁剪 |
| 兜底截图缺少 `<all_urls>` | 提示去设置页「授予截图兜底权限」，截图总结页附可点击的设置页入口 |
| 截图 / 识别失败 | 状态栏与消息列表都给出接口原因（含 HTTP 状态码），按钮解禁可重试 |
| 点「停止」 | 发 `AI_STOP` abort 后台流；本地 1.2s 兜底收尾，防止 SW 被回收后按钮永久禁用 |
| 追问失败 / 中断 | 撤回刚追加的提问，线程不残留未答的 user 消息 |
| 视频切换（`VIDEO_CHANGED`） | 重置截图会话（线程 + 列表 + 计数）并提示，避免对旧画面继续追问 |

## 4. 验收标准

1. 视频播放到某页板书 → 点「📷 截图并总结」：出现缩略图 → 画面识别（公式为 LaTeX）→ 流式结构化总结；
2. 在下方输入框追问（如“第 2 步为什么可以约掉”），AI 基于该画面继续回答，多轮不丢上下文；
3. 可连续截多张，新画面进入同一会话线程；「清空」重置；
4. 「停止」能真正中断后台流；未配置视觉模型时给出明确提示；
5. 缩略图点击可跳回截图时刻；
6. 非视频页 / content 未就绪 / 接口失败时，状态栏给出可操作提示且按钮不会卡在禁用态。
