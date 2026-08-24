# B站字幕 AI 助手 —— 浏览器插件开发计划（PLAN）

> 项目目录：`bilibili-subtitle-ai/`
> 目标浏览器：Chrome / Edge（Chromium 系，Manifest V3），通过「加载已解压的扩展程序」安装

## 1. 项目目标

构建一个 B 站（bilibili.com）浏览器插件，提供三大功能：

| # | 功能 | 说明 |
|---|------|------|
| 1 | 提取视频字幕 | 自动获取当前视频的字幕轨道（CC 字幕 / AI 字幕），解析为带时间轴的结构化数据 |
| 2 | 字幕 + AI 交流 | 以字幕为基础与 AI 对话：全文总结、要点提炼、翻译、针对某段字幕提问等 |
| 3 | 字幕随播放同步滚动 | 播放时字幕列表自动滚动、高亮当前正在播放的那一句，并可定位跳转 |

## 2. 技术选型

- **扩展规范**：Manifest V3（MV3），Service Worker + Content Script + Side Panel + Options
- **语言/构建**：原生 JavaScript（无构建步骤，Chrome 直接加载文件夹即可调试），UI 用 HTML/CSS
- **字幕来源**：B 站官方播放器字幕接口（`x/player/wbi/v2` 获取字幕列表，再拉取字幕 JSON），依赖当前登录态（cookie 中 SESSDATA）
- **AI 服务**：OpenAI 兼容 API（可配置 Base URL / API Key / 模型名），支持自定义端点（如 DeepSeek、本地 Ollama、通义等兼容服务）

## 3. 目录结构

```
bilibili-subtitle-ai/
├── PLAN.md                  # 本计划文档
├── manifest.json            # MV3 清单（权限、入口声明）
├── background.js            # Service Worker：字幕接口代理、AI 请求、消息路由
├── content/
│   ├── extractor.js         # 功能1：字幕提取（监听页面、读取 video、请求接口）
│   └── subtitle-view.js     # 功能3：字幕随播放同步滚动 + 高亮 + 悬浮字幕条
├── sidepanel/               # 功能2：字幕 + AI 对话界面
│   ├── panel.html / panel.css / panel.js
├── options/                 # 设置页：AI 服务配置、字幕偏好
│   ├── options.html / options.css / options.js
├── popup/                   # 工具栏弹窗：快捷开关、当前视频状态
│   ├── popup.html / popup.css / popup.js
├── assets/                  # 图标
└── README.md                # 安装与使用说明
```

## 4. 功能拆解与实现要点

### 功能1：提取视频字幕
1. Content Script 在 B 站视频页检测 `video` 元素与页面的 bvid/cid（从 URL 或 window 全局变量读取）。
2. 请求 `https://api.bilibili.com/x/player/wbi/v2?bvid=...&cid=...`（background 代理，携带登录 Cookie），拿到字幕列表（cc / ai 字幕）。
3. 拉取字幕 JSON，解析为统一格式：`[{ index, start, end, text, lang }]`。
4. 异常处理：视频无字幕、未登录、接口风控等，给出明确提示。
5. 数据缓存：同一视频（bvid+cid）字幕结果缓存，避免重复请求。

### 功能2：字幕 + AI 对话
1. Side Panel 展示：字幕全文（可折叠）、视频信息、一键操作按钮（总结 / 要点 / 翻译 / 自定义提问）。
2. 支持框选某段字幕作为上下文，与 AI 对话（携带时间轴信息）。
3. 请求经由 background 发出（规避 CORS 与 Key 泄露），支持流式输出（SSE），可中断。
4. Options 页配置：Base URL、API Key（存 chrome.storage.local）、模型名、温度、系统提示词模板。

### 功能3：字幕随播放同步滚动
1. Content Script 监听 `video` 的 `timeupdate`（节流）与 `seeked`。
2. 二分查找当前时间对应的字幕行，高亮该行并 `scrollIntoView`（居中、平滑）。
3. 点击字幕行可跳转视频到对应时间点。
4. 可选：页面右下角悬浮当前句字幕条（开关控制）。

## 5. 里程碑（Milestones）

- [ ] M0 项目骨架：manifest.json + 目录 + 空模块（可加载、无报错）
- [ ] M1 功能1：字幕提取链路打通（含登录态、缓存、错误提示）
- [ ] M2 功能3：字幕同步滚动 + 高亮 + 点击跳转
- [ ] M3 功能2：Side Panel + AI 对话 + 流式输出 + Options 设置
- [ ] M4 联调打磨：多视频验证、性能（滚动节流）、UI 完善
- [ ] M5 收尾：README、打包说明（zip / CRX 可选）

## 6. 风险与应对

| 风险 | 应对 |
|------|------|
| B 站接口变更 / 风控 | 字幕接口走 background 带登录态请求；接口封装成独立模块便于升级；预留「从播放器 DOM 读取」兜底 |
| 视频无字幕或需大会员 | 明确提示「无可用字幕」；AI 字幕（ai_subtitle）也纳入候选 |
| API Key 安全 | Key 只存本地 storage，请求只在 background 发出，不注入页面 |
| 性能 | timeupdate 节流 + 二分查找；字幕列表虚拟滚动（若行数极大时） |

## 7. 验收标准

1. 打开任意 B 站视频页，插件能列出该视频字幕，加载成功有提示。
2. 播放时字幕列表自动滚动并高亮当前句；点击字幕跳转播放。
3. 侧边栏可用字幕全文与 AI 对话，完成「总结本视频」等任务，输出流式显示。
4. 设置页可修改 AI 服务并持久化，重启浏览器后依然生效。
