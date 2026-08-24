# 技术决策记录（DECISIONS / ADR）

> 记录"为什么这样做"，避免后续重复论证或误改。新决策按编号追加。

## D1：原生 JS，无构建步骤
- **决策**：不引入打包器/框架（Vite、TS、React 均不用），直接加载目录即可调试。
- **理由**：功能规模小；免构建意味着用户拉下来就能"加载已解压"；排查问题路径短。
- **代价**：无类型检查；跨文件复用需用 `importScripts`/全局（`lib/wbi.js` 用 UMD 风格同时支持）。

## D2：wbi 签名内嵌实现（lib/wbi.js）
- **背景**：`x/player/wbi/v2` 无签名返回 -403，是"识别不到字幕"的首因。
- **决策**：自实现 MD5（RFC1321 表格驱动）+ 签名（mixinKeyEncTab）放入纯函数库；SW 用 `importScripts` 加载，node 测试 `require`。
- **理由**：crypto.subtle 不支持 MD5；引入第三方库与"无构建"冲突。
- **已知陷阱**：手写 UTF-8 编码时分支必须 `continue`/else，否则 ASCII 会被多编码 3 字节（已修复并加测试锁定）。

## D3：字幕接口双通道
- **决策**：优先 wbi/v2（签名），失败自动回退 x/player/v2；cid 优先页面状态，缺省走 view/pagelist 接口。
- **理由**：B 站接口随时调整，双通道 + 明确错误信息降低对单一路径的依赖。

## D4：AI 请求全部走 background
- **决策**：API Key 只存 chrome.storage.local，请求只由 SW 发出（含流式 SSE 转发、AbortController 中断）。
- **理由**：Key 不进入页面上下文；规避 CORS；页面被注入的脚本无法窃取。

## D5：侧边栏打开时"并入"浮动面板（心跳机制）
- **背景**：视频页浮动字幕面板与侧边栏字幕列表功能重复，用户要求打开侧边栏后并入右侧。
- **决策**：panel 打开时向 content 发 `SIDEPANEL_STATE{open:true}` 隐藏浮动面板；30s 心跳保活；content 侧 150s 无心跳自动恢复。
- **理由**：Chrome Side Panel 关闭时无可靠回调，心跳+超时是简单可靠的兜底。

## D6：面板布局变量化
- **决策**：字幕区高度用 CSS 变量 `--subtitle-h`，分隔条拖拽修改并持久化到 localStorage。
- **理由**：避开 flex-basis 与 JS 内联样式的耦合；下限 15% / 上限 70% 保证对话区可用。
