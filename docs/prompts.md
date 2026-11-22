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

Library 的 AI 分类使用 `organizer.group` 先按文件名一次生成单层主题分类和相似排序，发送当前目录供判断是否需要调整，不发送旧标题。200 篇以内只请求一份分组，最多 6 个类别；无法判断的文件才读取第一页。文字直接加入下一次统一分类，不逐篇额外调用模型；扫描页或文字仍无法判断的页使用 `organizer.first-page` 看图。类别和文件编号须完整、唯一且安全；不允许嵌套目录。每次重跑覆盖整个旧预览（包括手动调整），确认后才移动，并沿用整理记录与空目录清理、回退机制。

最多支持 5,000 篇。超过 200 篇时，`organizer.summarize` 按每 200 篇顺序归纳全部主题，再用 `organizer.plan` 规划统一单层目录，`organizer.classify` 每 12 篇分配到这份白名单；全量参与，不抽样。小批分组只传文件名、当前目录和必要的第一页依据，页文字最多 4,000 字符。每个模型请求可取消且总时限为 180 秒；单篇读取失败保留其他结果并标注待确认，不自动移动。

所有结果均校验 JSON、完整唯一的论文标识、目录数量和单层安全名称；未能判断的文件不自动勾选。大库的分批分配额外校验置信度，低于 0.75 时补读第一页。用户可检查并修改、合并预览目录；只有确认移动时才改动文件。

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
| `organizer.group` | 2.0.0 |
| `organizer.first-page` | 1.0.0 |
| `organizer.classify` | 4.0.0 |
| `organizer.plan` | 3.0.0 |
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
| `translate.screenshot` | 1.1.1 |
| `translate.selection` | 2.1.0 |

分类优先保留已合理放置的文件，以 keep 编号列表明确返回且不补读第一页；只有待整理项产生新单层目标。全部编号在 groups、keep、unknown 中恰好出现一次。确认只移动变更项，清理仅限实际移出文件的旧空目录，不清理其他空目录。
