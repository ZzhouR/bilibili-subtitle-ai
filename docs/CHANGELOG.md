# 变更日志（CHANGELOG）

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
