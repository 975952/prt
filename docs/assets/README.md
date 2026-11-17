# 界面预览

[返回首页](../../README.md)

这些图片展示 prt 的真实界面，包括书架首页、透光、米宣、深色主题与英文界面。

- **首页：** `home-glass.png`、`home-dark.png`、`home-english.png` 由 v1.2.5 桌面程序的内嵌前端生成。使用独立合成书架，文件名用于展示分类、标题补全与搜索，阅读页码和时间是演示数据，不是私人阅读记录。可用 `node test/capture-home-showcase.mjs` 重新生成。

- **论文：** Ashish Vaswani et al., *Attention Is All You Need*, 2017，[arXiv:1706.03762](https://arxiv.org/abs/1706.03762)。透光与米宣截图展示第 3 页的 Transformer 结构图，深色展示第 1 页的标题与摘要。论文版权属于其权利人，原 PDF 未提交到本仓库。
- **问答：** 为展示公式与回答排版而编写的演示内容，通过应用现有渲染入口呈现，不代表一次实测模型回答。
- **译文卡片：** `translation-liquid.png` 与 `translation-frosted.png` 展示桌面内嵌前端的两种材质，使用公开论文和演示译文，未请求模型服务。阅读区及卡片截图可用 `node test/capture-showcase.mjs --pdf <公开论文路径>` 重现，英文阅读截图追加 `--en`。
- **数据：** 截图不包含私人论文库、配置、密钥或会话。
- **版本：** 首页与阅读区截图均已按 v1.2.5 更新，展示微暖透光、悬浮纸面、米宣、深色及双语界面。
