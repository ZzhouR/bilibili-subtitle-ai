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

## D5：侧边栏打开时"并入"浮动面板（心跳机制）— 已废弃（0.7.0 起）
- **背景**：视频页浮动字幕面板与侧边栏字幕列表功能重复，用户要求打开侧边栏后并入右侧。
- **当时决策**：panel 打开时向 content 发 `SIDEPANEL_STATE{open:true}` 隐藏浮动面板；30s 心跳保活；content 侧 150s 无心跳自动恢复。
- **现状**：0.7.0 移除浮动面板 UI 后，`SIDEPANEL_STATE` / `SET_ACTIVE_TRACK` 消息与心跳逻辑一并删除（回归测试断言其不存在）。字幕展示只在侧边栏，content 只保留播放同步服务。保留本条仅作历史记录，勿再实现。

## D7：不伪造请求头，登录态走 credentials
- **背景**：早期实现用 `chrome.cookies.getAll` 拼 `Cookie` 头传给 `fetch`。`Cookie`/`Referer`/`User-Agent` 都属于 forbidden header name，扩展脚本设置后会被浏览器静默丢弃——既没起作用，还掩盖了"未登录"这类真实失败原因。
- **决策**：所有 B 站请求统一 `credentials: "include"`（host_permissions 已授权 B 站与 hdslb 域，浏览器自动带上 SESSDATA）；`chrome.cookies` 只用于探测是否登录，以便在失败时给出准确提示。
- **代价**：仍需保留 `cookies` 权限（仅做登录态探测）。

## D8：错误分级重试
- **决策**：`fetchWithRetry` 只对网络错误 / 412·429 风控 / 5xx 重试（指数退避 0.6s→1.2s→2.4s）；401/403/404 立即失败并给出语义化提示（内部用 `err.fatal` 标记穿透 catch）。
- **理由**：此前 401/403/404 抛出的错误被外层 catch 接住后照旧重试，既慢又掩盖原因。

## D6：面板布局变量化
- **决策**：字幕区高度用 CSS 变量 `--subtitle-h`，分隔条拖拽修改并持久化到 localStorage。
- **理由**：避开 flex-basis 与 JS 内联样式的耦合；下限 15% / 上限 70% 保证对话区可用。

## D9：截图优先用页面内 canvas 抓帧，不用 captureVisibleTab（0.10.1）
- **背景**：0.10.0 的截图总结走 `chrome.tabs.captureVisibleTab`，实测每次都返回 `Either the '<all_urls>' or 'activeTab' permission is required.`。原因是该 API 要求 `<all_urls>` 主机权限，或**由用户手势临时授予**的 `activeTab`；侧边栏中的按钮点击不属于能激活 `activeTab` 的手势（只有点击扩展图标、快捷键、右键菜单等入口才会激活），因此 manifest 里静态声明 `activeTab` 毫无作用。
- **决策**：首选在 content script 内 `canvas.drawImage(video)` + `toDataURL` 直接抓帧 —— 视频元素属于同一页面，不需要任何截图权限。仅当画布被跨域污染（`SecurityError`）或抓到全黑帧时，才回退 `captureVisibleTab` + 裁剪，并把 `<all_urls>` 放进 `optional_host_permissions` 由用户在设置页按需授予。
- **附带收益**：抓到的是视频原生分辨率的纯画面，不含弹幕层与播放器 UI，也不受窗口遮挡/最小化影响；视口缩放不再影响清晰度。
- **已知陷阱**：硬件加速叠加层下 `drawImage` 可能得到全黑帧。必须抽样检测像素均值（阈值 4）并按 `tainted` 回退，否则会把一张黑图送去视觉识别；`getImageData` 同时充当污染检测（污染时抛 `SecurityError`）。

## D10：思考等级用 reasoning_effort 分级，不再切换模型（0.11.0）
- **背景**：0.10.x 的「思考等级」只有两档，实现方式是 `reasoningLevel=1` 时把模型名换成 `deepseek-reasoner`。DeepSeek 现行模型已改为 `deepseek-v4-flash` / `deepseek-v4-pro`（另有 `deepseek-v4-flash-vision-exp` 接受图像输入），`deepseek-chat` 与 `deepseek-reasoner` 均已下线；思考能力不再靠换模型，而是同一模型上的两个参数：开关 `thinking: {type: "enabled"|"disabled"}` 与强度 `reasoning_effort`。
- **决策**：默认模型改为 `deepseek-v4-flash`；设置项 `reasoningLevel`/`reasoningModel` 合并为单一 `reasoningEffort`，取值 `off / low / medium / high / xhigh / max`（与 agent 侧同一套分级），默认 `high`（与官方默认一致）。`off` 发 `thinking: {type:"disabled"}`，其余发 `thinking:{type:"enabled"}` + `reasoning_effort`。
- **为什么保留 medium/xhigh**：官方映射把 medium 与 xhigh 都折叠到 high（low→low、medium/high/xhigh→high、max→max），实际只有三档生效。但保留六档能与 agent 的分级一一对应，且日后官方细化映射时无需改动配置结构；设置页直接标注实际生效值，避免用户误以为六档都有区别。
- **temperature**：官方明确思考模式下 `temperature`/`top_p`/`presence_penalty`/`frequency_penalty` 无效（设置不报错但也不生效）。因此开启思考时**不发送** temperature，只在 `off` 时发送 —— 既符合文档，也避免用户以为调了温度却毫无变化。
- **兼容性**：`thinking` 是 DeepSeek 扩展字段，严格的 OpenAI 端点可能拒绝未知字段。因此只在 Base URL 或模型名含 `deepseek` 时发送该字段；若端点仍回 400 且响应明确抱怨 `thinking`/`reasoning_effort`，则去掉思考参数、补回 temperature 重试一次（只重试一次，且只在明确抱怨这两个字段时，避免把余额不足、鉴权失败之类的 400 也拖进重试）。
- **迁移**：`lib/settings.js` 的 `migrate()` 在每次读取设置时把旧配置就地转换（`reasoningLevel=1`→`high`，`=0`→`off`；`deepseek-chat`/`deepseek-reasoner`→`deepseek-v4-flash`），设置页保存时删除旧键。老用户升级后无需手动改配置，也不会因为模型已下线而收到 404。
- **代价**：新增 `lib/settings.js` 一个文件（纯函数，SW / 设置页 / node 测试三处共用），换来的是"默认值与请求体构造只有一份实现"，不再出现 background 与 options 各写一份默认值而漂移的问题。
