# 📝 B站字幕 AI 助手（浏览器插件）

一款针对 **bilibili.com（B站）视频页**的 Chrome / Edge 扩展（Manifest V3），三大核心功能：

1. **提取视频字幕** —— 自动读取当前视频的官方字幕轨道（CC / AI 字幕），结构化展示；
2. **字幕 + AI 交流** —— 以字幕为上下文与 AI 对话：一键总结、提取要点、翻译，或自由提问（流式输出，可中断）；
3. **字幕随播放同步滚动** —— 播放时字幕列表自动滚动并高亮当前句，点击任意行可跳转视频到对应时间点。

## ✨ 功能预览

| 入口 | 说明 |
|---|---|
| 视频页右侧「📝 字幕」浮动面板 | 字幕列表、轨道切换、同步高亮滚动、点击跳转、悬浮字幕条、可拖拽/折叠 |
| 工具栏弹窗 | 显示当前视频字幕状态；一键打开 AI 侧边栏 / 设置 |
| AI 侧边栏 | 浏览与勾选字幕行、附加所选字幕/全文为上下文、总结/要点/翻译快捷指令、自定义提问（流式） |
| 设置页 | 配置 OpenAI 兼容 AI 服务（默认 DeepSeek）：Base URL / API Key / 模型 / 温度 / 系统提示词，支持一键测试连接 |

## 📦 安装（开发者模式加载）

1. 下载 / 解压本项目文件夹（`bilibili-subtitle-ai`）；
2. 打开 Chrome（或 Edge）地址栏输入 `chrome://extensions`（Edge 为 `edge://extensions`）；
3. 打开右上角 **开发者模式**；
4. 点击 **加载已解压的扩展程序**，选择本项目文件夹；
5. 打开任意 B 站视频页，等待 1~2 秒即可看到字幕面板。

> 提示：字幕接口依赖 B 站登录态（Cookie 中的 SESSDATA），请保持浏览器已登录 B 站。

## ⚙️ 配置 AI 服务（首次必做）

点击扩展图标 →「设置」，填写：

- **Base URL**：`https://api.deepseek.com`（或其他 OpenAI 兼容端点，如通义 `https://open.bigmodel.cn/api/paas/v4`、本地 Ollama `http://127.0.0.1:11434/v1` 等）
- **API Key**：在 [platform.deepseek.com](https://platform.deepseek.com) 申请；仅保存在本地浏览器（chrome.storage.local），请求仅在扩展后台发出
- **模型**：`deepseek-chat`（DeepSeek-V3）或 `deepseek-reasoner`（R1）
- 点「测试连接」可拉取模型列表验证

## 🚀 使用流程

1. 打开 B 站视频页 → 右侧出现字幕面板，选择字幕轨道（中文 CC / AI 字幕）；
2. 播放视频，字幕随播放自动滚动、当前句高亮；点击任意字幕行可跳转；
3. 点击工具栏图标 →「打开 AI 侧边栏」；
4. 在侧边栏勾选字幕行（或点「＋全文」附加整个视频字幕），再点击「总结 / 要点 / 英译」，或直接输入问题发送；
5. 生成中可随时点「停止」中断。

## 📁 目录结构

```
bilibili-subtitle-ai/
├── manifest.json            # MV3 清单
├── background.js            # Service Worker：字幕接口代理（带登录态+缓存）、AI 流式代理、设置
├── content/
│   ├── extractor.js         # 功能1：识别视频页 bvid/cid、请求字幕、广播
│   └── subtitle-view.js     # 功能3：浮动字幕面板、同步滚动高亮、点击跳转、悬浮字幕条
├── sidepanel/               # 功能2：AI 对话侧边栏（panel.html/css/js）
├── options/                 # AI 服务设置页
├── popup/                   # 工具栏弹窗
├── assets/                  # 图标（16/48/128）
├── test/smoke-test.js       # 冒烟测试（node test/smoke-test.js）
├── docs/                    # 项目记录文档（见下方"文档索引"）
└── PLAN.md                  # 开发计划文档
```

## 📚 文档索引

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构说明：模块职责、消息协议、字幕/AI 链路、缓存策略
- [docs/DECISIONS.md](docs/DECISIONS.md) —— 技术决策记录（ADR）：为什么用 wbi 签名、双通道、心跳并入机制等
- [docs/CHANGELOG.md](docs/CHANGELOG.md) —— 变更日志：0.1.0 → 0.3.0 的修复与演进

> 修改涉及消息协议/接口逻辑时，请同步更新 ARCHITECTURE.md 与 CHANGELOG.md，保持项目可持续维护。

## 🧪 开发与测试

```bash
node --check background.js
node --check content/extractor.js content/subtitle-view.js
node --check sidepanel/panel.js options/options.js popup/popup.js
node test/smoke-test.js      # 逻辑回归 + 资源完整性
```

修改代码后回到 `chrome://extensions` 点击扩展卡片上的 **刷新** 按钮重载。

## 📤 打包分发

```bash
cd ..
zip -r bilibili-subtitle-ai.zip bilibili-subtitle-ai -x "*/test/*"
```

将 zip 发布到扩展商店或直接解压后「加载已解压的扩展程序」。

## ⚠️ 已知限制

- 字幕数据来自 B 站官方播放器字幕接口：需**已登录**；部分视频（无字幕/版权受限）无可用字幕；
- B 站接口偶有风控（HTTP 412），已内置自动重试；接口变动时需更新 `background.js` 中相关逻辑；
- AI 请求消耗用户自己的 API 额度，与 B 站无关；
- 侧边栏为 Chrome 116+ 的 Side Panel 特性（旧版本浏览器可改用 popup 方式）。
