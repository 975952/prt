# 提示词参考

[文档索引](README.md) · [开发指南](开发指南.md)

提示词定义位于 [`public/js/prompts/`](../public/js/prompts/)。公共规则在 `base.js`，结构与引用协议在 `contracts.js`，组合和预算处理在 `compose.js`，版本注册在 `registry.js`。回答语言由 `i18n.js` 与 `ai.js` 按用户设置注入。

## 修改与校验

修改提示词时，更新对应定义的版本和下表；涉及共享规则或缓存语义时，同时更新 `PROMPT_SYSTEM_VERSION`。随后更新快照并检查：

```powershell
node test/prompts-manifest.mjs --update
node test/prompts-manifest.mjs
npm --prefix test test
```

快照保存在 `test/fixtures/prompts-manifest.json`，用于检查代码、文档与版本是否一致。系统版本：**2026.11.8**。

纯图片论文的主题和内容方向可依据已提供的标题或有意义的文件名初步判断，回答明确标注“根据标题判断”。标题不足时保留不确定性；具体内容与页码仍须核对原文或页图。打开文档不自动识别扫描目录。

Library 的 AI 分类使用 `organizer.classify`，每批最多 12 篇，只提供标题、文件名、相对路径、已有及本次已建议的目录和用户分类偏好。目录由模型建议，不内置主题分类表。模型结果必须通过 JSON、论文标识、置信度及相对路径校验；未知或低于 0.75 的建议不自动勾选。请求支持取消和超时，建议经过用户检查确认后才移动文件。

## 注册清单

以下为已注册的定义；具体调用入口以源码为准。

| ID | 版本 |
| --- | --- |
| `bg.digest` | 1.0.0 |
| `bg.memory.extract` | 1.0.0 |
| `bg.scan.transcribe` | 1.0.0 |
| `bg.sessionSummary` | 1.0.0 |
| `bg.sessionTitle` | 1.0.0 |
| `op.evidence` | 2.2.0 |
| `op.limits` | 2.2.0 |
| `organizer.classify` | 1.0.0 |
| `qa.chat` | 2.4.0 |
| `qa.explain` | 2.4.0 |
| `qa.screenshot` | 1.0.0 |
| `teach.condense` | 1.0.0 |
| `teach.intro` | 2.2.0 |
| `teach.prereq` | 2.2.0 |
| `teach.prereq.one` | 2.2.0 |
| `teach.visual` | 2.2.0 |
| `teach.walk` | 2.2.0 |
| `teach.walk.continue` | 2.2.0 |
| `teach.walk.reteach` | 2.2.0 |
| `translate.screenshot` | 1.1.0 |
| `translate.selection` | 2.1.0 |
