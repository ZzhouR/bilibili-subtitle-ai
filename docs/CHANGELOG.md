# 变更日志（CHANGELOG）

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
