# 功能设计：AI 视频总结（画面识别 + 语音字幕融合）

> ⚠️ **已于 0.10.0 废弃**：本文档描述的「按分段间隔自动截图 + 全片汇总」方案已被
> [FEATURE-SHOT-SUMMARY.md](FEATURE-SHOT-SUMMARY.md)（按需单帧「截图总结」+ 多轮追问）取代。
> 保留本文以记录帧采集链路（`SEEK_VIDEO` / `CAPTURE_FRAME` / `AI_VISION`）与 mini-LaTeX 渲染的设计由来 —— 这些底层能力仍在使用。

> 目标：像夸克网盘那样，对一个 B 站教学视频生成**含截图识别、数学公式 LaTeX、逐题/分步解答**的详细 AI 总结。

## 1. 原理与数据流

```
侧边栏「AI 总结」开始
  ├─ 语音：B 站官方字幕（既有能力）按时间轴分段（默认每 120s 一段）
  ├─ 画面：每段取 1 个关键帧（视频时间点）
  │     panel → background CAPTURE_FRAME
  │       → content SEEK_VIDEO（暂停视频→seek 到 t→等待稳定→返回 video 位置）
  │       → background captureVisibleTab（整页截图）
  │       → OffscreenCanvas 裁剪视频区域 + 压缩（≤1024px）
  │       → 视觉 API（OpenAI 兼容 vision，独立配置）识别公式/板书 → LaTeX 文本
  ├─ 汇总：全部时段的「字幕文本 + 画面识别结果」→ 对话模型（DeepSeek）
  │     按结构化模板生成：题目原文 / 解题思路分析 / 分步解答过程 / 重点公式
  └─ 渲染：Markdown + $..$ 数学公式（自实现 mini-LaTeX 渲染，零依赖）
```

## 2. 模块划分

| 模块 | 职责 | 新增/修改 |
|---|---|---|
| `content/subtitle-view.js` | `SEEK_VIDEO`：暂停→seek→稳定等待→返回视频元素位置/DPR | 修改 |
| `background.js` | `CAPTURE_FRAME` 截图+裁剪；`AI_VISION` 视觉识别代理；`AI_SUMMARY` 汇总（调用对话模型） | 修改 |
| `lib/latex.js` | 迷你 LaTeX→HTML（分数/根号/上下标/希腊字母/矩阵/符号） | 新增 |
| `lib/markdown.js` | 集成 `$...$` / `$$...$$` 公式渲染 | 修改 |
| `sidepanel/` | 「AI 总结」标签页：开始/进度/分段卡片/最终总结 | 修改 |
| `options/` | 视觉模型独立配置（baseUrl/apiKey/model，默认通义 qwen-vl / GLM-4V） | 修改 |
| `manifest.json` | 权限 + `activeTab`（captureVisibleTab） | 修改 |

## 3. 关键决策

- **截图方案**：`chrome.tabs.captureVisibleTab`（需要 activeTab/host 权限，B 站域已具备）+ ServiceWorker 内 `OffscreenCanvas` 裁剪视频区域。不用 canvas 截 video 帧（跨域 CDN 会污染画布）。
- **视觉模型**：OpenAI 兼容多点位（通义 qwen-vl-plus / GLM-4V / Ollama llava），独立于对话模型配置；未配置时跳过画面识别仅做字幕总结。
- **公式渲染**：环境无 npm/pip 前端资源（KaTeX 不可得），自实现 mini-LaTeX 渲染器（覆盖课程常用公式）；后续可将 KaTeX 打入 vendor 升级。
- **总结不打扰播放**：开始总结前暂停视频；逐帧截图期间保持暂停；结束后提示用户恢复。
- **成本控制**：分段时长默认 120s（可按视频长度自适应）；每段 1 帧；可取消。

## 4. 里程碑

- [ ] M1 计划与骨架：manifest activeTab、消息协议定义、plan 文档
- [ ] M2 帧采集链路：content SEEK_VIDEO + background 截图/裁剪（含 OffscreenCanvas）
- [ ] M3 视觉识别：AI_VISION 代理 + options 视觉模型配置
- [ ] M4 迷你 LaTeX 渲染器 + markdown 集成
- [ ] M5 侧边栏「AI 总结」UI：进度/分段卡片/最终结构化总结
- [ ] M6 测试/文档/版本 0.8.0/提交

## 5. 验收标准

1. 线代类教学视频点击「开始 AI 总结」能给出分段结果（截图缩略 + 公式 LaTeX）；
2. 最终总结含题目原文/思路分析/分步解答，公式以渲染后的形式显示（如 α₁、‖A+B‖、分数、矩阵）；
3. 未配置视觉模型时仅字幕总结并明确提示；
4. 总结过程可取消，进度可见；总结不打断用户（自动暂停，完成后提示）。
