# 变更日志（CHANGELOG）

## [0.10.1] - 2025（修复截图权限失败）
### 修复
- **截图必然失败：`Either the '<all_urls>' or 'activeTab' permission is required.`**
  `chrome.tabs.captureVisibleTab` 需要 `<all_urls>` 主机权限，或由**用户手势**（点击扩展图标等）临时授予的 `activeTab`。侧边栏里的「📷 截图并总结」按钮不属于能激活 `activeTab` 的手势，manifest 里静态列出的 `activeTab` 权限因此完全帮不上忙 —— 每次截图都被拒。
  改为**双路径**，首选路径不需要任何截图权限：
  1. **直接抓帧（默认）**：content script 在页面内 `canvas.drawImage(video)` → `toDataURL`，取到的是视频原生分辨率的画面，且不受窗口是否可见/被遮挡影响。
  2. **整页截图兜底**：仅当画布被跨域污染（`SecurityError`）或抓到全黑帧时，才回退到 `captureVisibleTab` + 裁剪；此路径所需的 `<all_urls>` 降级为 `optional_host_permissions`，由用户在设置页按需授权。
### 新增
- **全黑帧探测**：硬件加速叠加层下 `drawImage` 可能得到全黑画面。抓帧后对像素抽样求均值，判定为黑帧时按 `tainted` 回退到整页截图，避免把黑图送去识别。
- **设置页「📷 截图兜底权限」**：`chrome.permissions.request/remove/contains` 提供授予、撤销与当前状态显示（默认无需授权）。
- **权限失败可直接跳转**：截图因权限失败时，截图总结页给出「打开设置页授予截图兜底权限 →」链接（`chrome.runtime.openOptionsPage`）。
### 重构
- content script 抽出 `prepareFrame()` / `resumePlayback()`：`GRAB_FRAME` 与 `SEEK_VIDEO` 共用"暂停 → 必要时 seek → 等稳定 → 恢复播放"逻辑，免 seek 优化对两条路径同时生效。

## [0.10.0] - 2025（「AI 总结」改为「截图总结」）
### 变更（破坏性）
- **「🤖 AI 总结」→「📸 截图总结」**：不再按分段间隔（默认 120s）自动遍历全片截图。改为**完全按需**：点「📷 截图并总结」→ 取当前播放位置 → 截取当前画面 → 视觉模型识别 → 流式生成结构化总结。
- **移除分段控件与逻辑**：`#segLen` 输入框、`buildSegments()`、逐段循环与进度条（`#summaryBar` / `#summarySegs` / `#summaryResult`）全部删除。
### 新增
- **围绕画面多轮追问**：截图总结页内置输入框，截图后可继续提问。会话线程 `shotThread` 保存「画面识别结果 + 历次问答」，每次请求整体回传；上限 24 条（`SHOT_THREAD_MAX`），超出丢弃最旧的。
- **连续截图**：可在同一会话里连截多张，新画面识别结果追加进同一线程；「清空」重置线程与消息列表。
- **截图缩略图可跳转**：点击消息列表中的缩略图跳回该截图时刻。
- **附近字幕开关**（`#shotWithSub`，默认开）：把截图时刻 ±30s 的字幕一起交给 AI，作为画面的语音补充。
### 修复
- **当前帧截图白等 1500ms**：`SEEK_VIDEO` 中把 `currentTime` 写成同一个值不会触发 `seeked` 事件，只能等超时。现在目标与当前时间差 ≤0.05s 时跳过 seek，稳定等待也从 350ms 降到 120ms。
- **未配置视觉模型时的语义**：截图总结的核心就是画面识别，不再静默退化成"仅字幕总结"，而是明确提示去「设置 → 视觉模型」配置。
- **「停止」可能永久禁用按钮**：后台 SW 被回收时不再广播 `done`/`error`，`shotBusy` 会常驻 true。现在发出 `AI_STOP` 后本地 1.2s 兜底收尾，按钮必然恢复。
- **非视频页截图报底层错**：截图前先校验标签页 URL（`/video/`、`/list/`），直接提示切换标签页，而不是抛 content 连接失败。
- **追问失败后上下文脏化**：请求失败/中断时撤回刚追加的提问，避免重试重复入线程、线程尾部堆叠连续 user 消息。
- **切视频后追问张冠李戴**：收到 `VIDEO_CHANGED` 时重置截图会话（线程 + 消息列表 + 计数）并提示。
### 重构
- 抽出 `appendMsg(listEl, …)` / `createStreamBubble()` / `startChatStream()`：「字幕对话」与「截图总结」共用同一套气泡与流式渲染（含 reasoning 灰框、闪烁光标、错误态）；删除截图总结页独立的临时 `onMessage` 监听器与重复的流处理代码。
- 只有「字幕对话」写入 `chatHistory`（`startChatStream({ record: true })`），截图会话不落历史。
- 顺手移除 `handleStream()` 中遗留的空 `if` 语句（no-op）。
### 测试与文档
- 冒烟断言同步：`captureAndSummarize` / `shotThread` / `askShot` / `shotView` / `SHOT_THREAD_MAX` / `needSeek` 等新标识，并反向断言 `buildSegments` / `segLen` / `summaryView` 已彻底移除。
- 新增截图总结纯逻辑用例：`needSeek` 判定、`shotThread` 截断（保留最新 24 条）、`nearbySubtitles` ±30s 区间相交；并断言 `panel.css` 已清理旧 `#summaryView` / `.p-seglen` 样式。
- 新增 `docs/FEATURE-SHOT-SUMMARY.md`；`docs/FEATURE-AI-SUMMARY.md` 标注为 0.10.0 起废弃（底层帧采集链路仍在用）。

## [0.9.3] - 2025（Bug 审查与修复）
### 修复（字幕链路）
- **请求头伪造无效**：`Cookie`/`Referer`/`User-Agent` 属于 forbidden header，扩展 `fetch` 设置后被浏览器丢弃，等于所有 B 站请求都以"未登录"身份发出。改为统一 `credentials: "include"`（浏览器自动携带 SESSDATA），`chrome.cookies` 仅用于探测登录态并在失败时给出准确提示（见 D7）。
- **字幕 CDN 未授权**：`host_permissions` 补 `https://*.hdslb.com/*` —— 字幕 JSON 由 hdslb CDN 提供，此前该请求缺少主机权限。
- **后台解析出的 cid 未回传**：`fetchSubtitleList` 现返回 `{cid, list}`，`handleGetSubtitles` 用真实 cid 写缓存并回传页面；此前 cid 为空时缓存永不生效，每次切换都重新拉取全部字幕。
- **重试掩盖真实错误**：401/403/404 标记为致命错误立即失败，仅网络错误/412·429/5xx 重试且改为指数退避；wbi 签名返回 code=-403 时清除缓存密钥以便下次重新获取。
- **单轨失败连带整体失败**：单条字幕轨道拉取异常改为跳过（返回 null），空轨道不再进入列表。
- **归一化容错**（`lib/wbi.js`）：按 `start` 升序排序（二分查找的前置条件）、丢弃非法时间戳、`end<=start` 或缺失 `to` 时用下一条 `start`（或 +5s）补齐 —— 此前这类数据会让播放高亮永久失配。
### 修复（AI 链路）
- **SSE `[DONE]` 只跳出内层循环**：读取循环不会结束，流式请求迟迟不关闭；改为终止外层循环并 `reader.cancel()`，同时补充处理末尾无换行的残留数据。
- **`temperature: 0` 被吞**：`Number(x) || 0.7` 把合法的 0 改写成 0.7（后台与设置页各一处），改用有限性判断。
- **推理模型带 temperature**：`reasoningLevel=1` 时删除该字段，避免 deepseek-reasoner 等接口报错。
- **设置页保存覆盖既有配置**：保存/测试连接改为与已存设置合并，`reasoningModel` 等本页未呈现的字段不再被清空；测试连接对 `res.models` 判空并捕获异常。
### 修复（页面与面板）
- **AI 总结截图必然失败**：content 的 `SEEK_VIDEO` 处理分支未 `return true`，异步 `sendResponse` 被丢弃，后台永远收不到视频区域坐标。
- **`/list/` 合集页完全不工作**：manifest 已注入该页面，但 extractor/subtitle-view/panel/popup 的 URL 判断都只认 `/video/`；现统一支持 `/list/...?bvid=BVxxx`。
- **切换视频后字幕不再广播**：A→B→A 返回时 `currentTracks` 已被清空但 key 未变，`requestSubtitles` 直接 return；现命中同一视频时直接重播缓存的轨道。
- **导航乱序**：extractor 增加 `reqSeq` 导航令牌，旧请求晚于新请求返回时丢弃；URL 变化仅在 bvid/分P 真正改变时才触发切换（过滤 `?t=`、`?vd_source=` 等抖动）。
- **切换视频后残留状态**：侧边栏在视频切换/加载到不同视频时清空勾选、上下文、当前句条与轨道选择，避免旧索引错位到新字幕。
- **总结"停止"停不掉**：汇总请求已发出后仅置取消标志无效，现记录流 id 并发送 `AI_STOP` 真正中断后台请求。
- **时间戳进位错乱**：`fmt()` 先按 0.1s 量化再拆分，修掉 59.96 → `59:60.0` 之类的输出。
- **历史对话待载入丢失**：初始化时不再因"当前不在视频页"而跳过 `pendingOpenRecord`，否则该记录会一直留在 storage 里且永远打不开。
### 修复（渲染）
- **多行 `$$…$$` 公式丢内容**：块级公式的续行判断必须先于"开启新块"判断，否则闭合行 `$$` 被当成新块开始，已累积的公式被丢弃；未闭合的 `$$` 块（流式生成中）现在也会渲染。
### 测试与文档
- 冒烟测试修正 `global.LatexLib` 误挂 `lib/wbi.js` 的问题（应为 `lib/latex.js`），并新增归一化容错、块级公式、`/list/` 支持、SSE 终止、cid 回传、设置合并等回归断言。
- `docs/DECISIONS.md` 新增 D7（不伪造请求头）/D8（错误分级重试），D5 标注为 0.7.0 起废弃；`docs/ARCHITECTURE.md` 移除已删除的 `SET_ACTIVE_TRACK`/`SIDEPANEL_STATE` 契约，同步字幕链路与缓存表。

## [0.9.2] - 2025
### 撤销
- **撤销"自动上下文智能降载"**（0.9.0 引入的关键词/播放位置分块检索）：AI 对话恢复为**总是自动附带当前字幕轨道全文**，保证回答准确、行为可预期（体验与 0.7.x 一致）。
- 保留长视频全文字幕 + [时间戳点击跳转]（与降载无关的独立功能不受影响）。

## [0.9.1] - 2025
### 修复
- **标签页视图重叠**：`display:flex` 布局规则覆盖了 `hidden` 属性，导致「字幕对话」与「AI 总结」两个视图同时显示与错位。新增全局 `[hidden] { display: none !important; }`，现在进入「AI 总结」页只会看到总结内容（字幕列表/对话完全隐藏），切回「字幕对话」亦然。
- 修复历史窗口详情区初始 hidden 同样被覆盖的问题。
- 视图结构确认：字幕列表 + 可拖拽分隔条 + AI 对话 属于「字幕对话」页内部布局；「AI 总结」页仅有总结相关控件。

## [0.9.0] - 2025（依据改进建议优化）
### 修复
- **AI 总结页布局重叠**：头部允许换行，标题/分段/按钮不再互相挤压。
### 优化（对应 suggestion-from-gpt5.6.md）
- **长字幕分块检索**（P0）：自动上下文不再总是全文——≤4000 字符用全文；长视频按"问题关键词命中 ±2 行 + 播放位置前后 90 秒"取相关片段（≤80 行），未命中时均匀采样。
- **当前播放位置问答**：新增 `GET_PLAYBACK_TIME`；AI 回复中的 `[mm:ss]` 时间戳可点击跳转视频。
- **SSE 解析纯函数化**：`lib/sse.js`（feedBuffer/parseLine），background 流式复用，纳入回归测试。
- **错误分类重试**：401/403 提示检查登录/Key、404 不重试、412/429 重试并提示风控。
- **双层缓存持久化**：字幕缓存 内存热缓存 + `chrome.storage.local` 持久层（TTL 30 分钟、上限 8 条 LRU 淘汰），SW 重启不丢失。
- **隐私与权限**：设置页第三方 API 隐私提示；README 新增 Manifest 权限表。
- **Prompt 预设扩充**：课程大纲 / 详细笔记 / 关键术语解释。
- **CI**：新增 `.github/workflows/ci.yml`（语法检查、manifest 校验、冒烟测试、打包 zip 产物）。

## [0.8.0] - 2025（AI 视频总结）
### 新增
- **AI 总结（画面 + 字幕融合）**：侧边栏「🤖 AI 总结」标签页；分段截图 → 视觉模型识别公式/板书 → 与字幕一起生成结构化总结（主题/题目原文/解题思路/分步解答/重点公式）。
- **帧采集链路**：content `SEEK_VIDEO` → background `CAPTURE_FRAME`（captureVisibleTab + OffscreenCanvas 裁剪，≤1024px）。
- **视觉模型配置**：设置页独立配置（默认通义 qwen-vl-plus，兼容 GLM-4V / Ollama）；未配置仅做字幕总结。
- **迷你 LaTeX 渲染**：`lib/latex.js`（希腊字母/分数/根号/上下标/矩阵/符号，词边界替换 + 转义防护）；markdown 集成 `$...$`/`$$...$$`。
- manifest 新增 `activeTab`。

## [0.7.2] - 2025
### 修复（多标签页切换字幕不刷新/报错）
- **实时跟随当前活动标签页**：移除 `activeTabId` 缓存，每次加载/跳转实时 `chrome.tabs.query` 获取当前标签页；从任意 B 站视频标签切换到另一个视频标签，侧边栏立即显示新标签的字幕。
- **标签事件监听**：`chrome.tabs.onActivated`（用户切换标签）+ `chrome.tabs.onUpdated`（站内导航完成）触发刷新，防抖合并 300–500ms。
- **加载时序防乱序**：`subLoadSeq` 序号校验，快速连续切换时旧标签请求结果不再覆盖新标签。
- **错误友好化**：切换到非 B 站视频页显示引导提示；发送消息失败不再抛"Could not establish connection"式报错。

## [0.7.1] - 2025
### 修复（SPA 切换视频字幕不更新）
- **URL 检测四通道**：MutationObserver + popstate + history.pushState/replaceState 包装 + 800ms 轮询兜底，覆盖 B 站分P切换（URL 仅改 ?p=N）与所有 SPA 跳转。
- **分P视频 cid 解析**：页面同时上报 `?p=` 分P编号，后台经 view 接口 `pages` 按 p 匹配 cid（不再错误使用主版本字幕）。
- **时序修复**：切换后新字幕加载完成时 content 再发 `SUBTITLES_READY`（经 background 转发），侧边栏此时才拉取最新字幕；切换瞬间清空旧列表防串台，4 秒兜底刷新。
- `VIDEO_CHANGED` 消息补充 `p` 字段。

## [0.7.0] - 2025
### 变更
- **完全移除视频页浮动字幕面板**：`subtitle-view.js` 精简为无 UI 播放同步服务（广播 `PLAYBACK_HIGHLIGHT`，响应 `JUMP_TO_TIME`）；字幕展示/同步滚动/当前句条/点击跳转全部在侧边栏完成。新增"当前句"显示条（跟随播放，点击跳转）。
- **SPA 切换视频链路修复**：`VIDEO_CHANGED` 改为 content → **background 统一转发** → 侧边栏（可靠通知，不再依赖 content 直发）。
- **思考等级**：设置页新增"思考等级"（普通 deepseek-chat / 深度思考 deepseek-reasoner）；流式支持 `reasoning_content`，侧边栏以灰色"思考过程"块展示后再输出正式回答。
- **Markdown 渲染**：新增零依赖 `lib/markdown.js`（代码块/标题/粗斜体/列表/引用/链接 + XSS 转义与链接白名单）；AI 回复与历史回显均按 Markdown 渲染。

## [0.6.0] - 2025
### 变更
- **对话历史独立为单独界面**：侧边栏保留「📚 历史」入口按钮，点击打开独立窗口 `history/history.html`（820×640 popup）。
- 历史窗口左侧列表（搜索/选中态），右侧详情（消息回显、重命名、删除、**在侧边栏继续对话**）。
- 「在侧边栏继续」：写入 `pendingOpenRecord` → 打开侧边栏 → 侧边栏自动载入该对话并回显。
- 侧边栏新增「＋ 新对话」按钮；历史视图相关内嵌代码全部移除（界面职责分离）。

## [0.5.0] - 2025
### 新增（侧边栏体验）
- **AI 对话自动附带字幕知识库**：未手动附加上下文时，发送提问自动注入当前轨道字幕全文（作为【视频字幕知识库】上下文），无需再手动"＋全文"。
- **侧边栏字幕随播放同步滚动高亮**：content 播放高亮变化时广播 `PLAYBACK_HIGHLIGHT`，侧边栏对应轨道字幕行同步高亮+居中滚动（蓝色标记）。
- **新视频自动刷新**：视频切换时 content 广播 `VIDEO_CHANGED`，侧边栏自动刷新字幕、清空勾选与手动上下文。
- **对话历史 CRUD**：历史存 `chrome.storage.local`（上限 100 条）；新增（对话自动保存）、查（列表+标题/内容搜索）、改（重命名 ✎）、删（🗑）、载入继续对话；自动知识库不入库以节省空间，载入时按 bvid 识别是否为原视频。

## [0.4.0] - 2025
### 变更
- **UI 全面改为 B 站风格**：白底 + 品牌粉 #FB7299 + 经典蓝 #00A1D6 + B站灰阶/圆角/边框规范，覆盖浮动字幕面板、侧边栏、popup、设置页。
- **项目纳入 Git 管理**：main 分支初始提交（包含全部源码/文档/测试）。

## [0.3.0] - 2025
### 新增
- 侧边栏打开时自动隐藏视频页浮动字幕面板（并入右侧），关闭后恢复；30s 心跳 + 150s 超时兜底。
- 侧边栏字幕区与 AI 对话区之间可拖拽调节高度（15%–70%），比例持久化到 localStorage。
- 项目文档：`docs/ARCHITECTURE.md`、`docs/DECISIONS.md`（ADR）。

## [0.2.0] - 2025（字幕识别修复）
### 修复
- **B 站字幕接口需 wbi 签名**：新增 `lib/wbi.js`（MD5 + `encWbi`），`x/player/wbi/v2` 改用签名请求；失败自动回退 `x/player/v2`。
- **cid 获取兜底**：页面状态拿不到时经 `x/web-interface/view` 解析，再失败走 `x/player/pagelist`；cid 内存缓存。
- **MD5/UTF-8 编码 bug**：utf8Bytes 分支 fall-through 导致非 4 字节对齐输入错误（ASCII/emoji 全部受影响），改为 if/continue 结构；MD5 重写为 RFC1321 表格驱动。
- extractor 失败自动重试 2 次（3s 间隔）；错误信息细化（显示接口 code/message）。
### 测试
- `test/smoke-test.js` 48 项：MD5 与 node:crypto 交叉验证、wbi 签名一致性、解析/二分/资源完整性。

## [0.1.0] - 2025（初始版本）
- MV3 骨架、图标、目录。
- 功能1 字幕提取（初版无 wbi 签名）；功能2 AI 对话（DeepSeek 流式 + 停止）；功能3 同步滚动高亮 + 悬浮字幕。
- 设置页（AI 服务配置 + 测试连接）、popup 状态栏。
