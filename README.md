<div align="center">

# prt

**在论文旁边，把问题读明白。**

**简体中文** · [English](README.en.md)

面向 Windows 的本地 PDF 阅读器，将原文、翻译、问答与笔记放在同一个工作区。

[![Release](https://img.shields.io/github/v/release/975952/prt?style=flat-square&label=release)](https://github.com/975952/prt/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-586976?style=flat-square)](https://github.com/975952/prt/releases/latest)
[![MIT](https://img.shields.io/badge/license-MIT-586976?style=flat-square)](LICENSE)

[下载 Windows 版](https://github.com/975952/prt/releases/latest/download/prt.exe) · [使用指南](docs/使用说明书.md) · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/975952/prt/issues/new/choose)

</div>

![prt 首页：继续阅读、论文分类与书架搜索](docs/assets/home-glass.png)

<sub>v1.2.5 实际界面；书架使用独立演示数据。[截图说明](docs/assets/README.md)</sub>

## 从书架回到阅读

首页集中展示论文和阅读进度：左侧切换**全部论文、最近阅读、未读与文件夹**，右侧搜索文件名或目录。独立的“继续阅读”入口回到上次阅读的位置，导入与整理入口始终可见。

![阅读工作区：原文、问答与公式并排](docs/assets/reading-glass.png)

<sub>论文为 [Attention Is All You Need](https://arxiv.org/abs/1706.03762)；右侧问答是演示内容。</sub>

## 为阅读准备的工作区

| 从阅读到理解 | 在 prt 中完成 |
| --- | --- |
| 找到下一篇论文 | 首页搜索、最近阅读、未读筛选、文件夹导航与继续阅读 |
| 对照多篇论文 | 多标签、独立窗口与窗口平铺，保留各自的阅读位置 |
| 读懂一段原文 | 划词翻译、解释、原文对照；每条译文可直接删除，点击引用回到对应页面 |
| 看图表与公式 | 框选截图、长截图、视觉模型问答，支持公式与表格排版 |
| 连贯地追问 | 同文件夹会话、跨窗口同步、输入草稿与翻译任务恢复 |
| 留下阅读线索 | 全文搜索、目录、高亮笔记与参考文献检索 |
| 调整阅读观感 | 透光、米宣与深色主题，可调 PDF 悬浮、边缘高光、译文卡片材质及夜读文字亮度 |
| 使用自己的语言 | 简体中文 / English 全局界面；回答语言与翻译目标分别设置 |

## 开始使用

1. 从 [Releases](https://github.com/975952/prt/releases/latest) 下载 **prt.exe**，放入一个可写文件夹。
2. 双击启动，拖入 PDF 或点击导入，即可阅读、搜索和记笔记。
3. 需要翻译或问答时，在设置中填写 **OpenAI 兼容接口地址、模型名和 API Key**。图表与扫描件需要支持图像的模型。

在 **设置 → 语言 / Language** 中切换简体中文或 English。界面切换会保存当前阅读位置、会话和草稿；回答语言可跟随界面或独立选择，翻译目标保持单独设置。

桌面版免安装，无需 Node.js。支持 Windows 10/11 x64，需要 [Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（多数系统已安装）。模型服务由你自行配置，服务费用按对应提供商规则计算。

**当前版本：** [v1.2.8](https://github.com/975952/prt/releases/tag/v1.2.8)。透光主题使用近白、极轻微暖色背景，PDF 以留白、柔和外阴影与细边高光呈现悬浮层次。阅读区只给纸面圆角，首页只给主内容圆角，侧栏保持平直。首页缩放、论文标题补全、译文卡片拖动缩放与单条直接删除继续保留。

在 **设置 → 阅读外观** 调整背景色调、PDF 悬浮强度与纸面边缘高光。**译文卡片材质**提供液态玻璃与磨砂玻璃：通透度和雾化程度均可调，液态玻璃另有边缘折射滑杆；两种材质分别记住参数。液态默认通透度 55%，磨砂默认 63%，都可继续调整。纸面透明度默认 12%、界面透明度默认 88%。

v1.2.5 加强输入框光影，将背景亮度范围提高到 92%–100%。连续选段可独立翻译，侧栏最多三条同时生成并保持发起顺序；关闭浮窗后仍可立即翻译下一段。修复窄栏论文在放大后选区混入相邻栏文字的问题。

v1.2.6 修复深色阅读中淡彩色图表底框发白、浅色文字难辨的问题：保留蓝绿等色相并降低底框亮度，图片与饱和图形继续保持原色。

升级时，退出旧版并替换同一目录的 `prt.exe`，保留 `papers/` 和 `data/`。下载页提供 `SHA256SUMS.txt` 校验文件。

<details>
<summary>查看两种译文卡片、米宣与深色主题</summary>

### 液态玻璃译文卡片

![液态玻璃译文卡片与悬浮 PDF 纸面](docs/assets/translation-liquid.png)

### 磨砂玻璃译文卡片

![磨砂玻璃译文卡片，通透度和雾化程度均可调](docs/assets/translation-frosted.png)

### 深色首页

![prt 深色书架首页](docs/assets/home-dark.png)

### 米宣

![prt 米宣主题与 Transformer 论文问答](docs/assets/reading-paper.png)

### 深色

![prt 深色主题，正文柔化反色，论文图像保留原色](docs/assets/reading-dark.png)

</details>

## 数据由你保管

论文保存在程序旁的 `papers/`，配置、笔记、会话和 API Key 保存在 `data/`。备份或迁移时，将两个目录一起复制。API Key 作为本地配置保存，请妥善保管该目录。

本地服务只监听 `127.0.0.1`。阅读、搜索和笔记不需要模型服务；使用 AI 时，相关原文、截图及对话上下文会发送到你配置的接口，联网检索会向检索服务发送查询。AI 输出可能有误，可通过引用回到原文核对。

## 帮助与反馈

- **使用：** [使用指南](docs/使用说明书.md) · [多窗口阅读](docs/多窗口阅读.md) · [常见问题](docs/使用说明书.md#常见问题)
- **反馈：** [报告问题或提出建议](https://github.com/975952/prt/issues/new/choose) · [安全问题](SECURITY.md)
- **参与：** [贡献指南](CONTRIBUTING.md) · [文档索引](docs/README.md)

## 许可证

项目代码采用 [MIT License](LICENSE)。第三方组件、字体和论文分别遵循各自的授权；截图中的论文不属于本项目的 MIT 授权范围。参见 [第三方组件](docs/第三方组件.md)。
