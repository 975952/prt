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

Library 的 AI 分类先用 `organizer.plan` 根据本次全部论文规划统一目录，再用 `organizer.classify` 每批最多 12 篇分配，后续批次只能从这份白名单中选择。目录由模型命名，不内置主题分类表。默认使用单层粗主题，最多 6 个；用户显式选择两层时，最多 8 个叶目录，目标深度必须一致，不允许父目录和子目录并列。提示词要求合并重叠主题、保持一致抽象层次，不为每个模型或算法单独建目录。目录上限不超过论文数量，也不要求模型凑满上限。

规划最多支持 5,000 篇。200 篇以内使用一次请求；超过 200 篇时，`organizer.summarize` 按每 200 篇顺序生成主题摘要，再统一合并目录，全量论文均参与，不抽样或静默截掉尾部。单篇规划元数据限制为文件名 120、标题 240、路径 160 字符，超过时保留两端并标记省略；摘要限制为每组最多 8 个主题，数量总和必须覆盖整组。5,000 篇最多 25 次摘要加 1 次全局规划，串行执行，无自动重试；超出数量会明确报错。提供进度回调，每次请求可取消并有超时，不发送正文或页图。

所有结果均校验 JSON、论文标识、目录数量/深度、相对路径和置信度；未知、计划外目录或置信度低于 0.75 的建议不自动勾选。用户可先检查并修改、合并预览目录；只有确认移动时才改动文件。

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
| `organizer.classify` | 2.0.0 |
| `organizer.plan` | 1.0.0 |
| `organizer.summarize` | 1.0.0 |
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
