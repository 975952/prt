# 界面预览

[返回首页](../../README.md)

[中文项目海报](prt-overview-zh.png) 用正态分布曲线举例说明截图提问与页码引用。下方为实际界面截图。

中英文首页的六张图片均截自桌面程序的黑色主题，尺寸为 2560 × 1600（16:10）。书架缩略图取自六篇公开论文的 PDF 首页；Alina 输入框展示对两篇视觉 Transformer 论文的示例提问；阅读区展示《Attention Is All You Need》第 3 页的 Figure 1，旁边是预先编写的图解。

截图书架中的论文可从 arXiv 获取：[Attention Is All You Need](https://arxiv.org/abs/1706.03762)、[ViT](https://arxiv.org/abs/2010.11929)、[Tokens-to-Token ViT](https://arxiv.org/abs/2101.11986)、[ResNet](https://arxiv.org/abs/1512.03385)、[Squeeze-and-Excitation Networks](https://arxiv.org/abs/1709.01507)、[BERT](https://arxiv.org/abs/1810.04805)。

以下为 v1.2.5 的界面与主题截图。

- **首页：** `home-glass.png`、`home-dark.png`、`home-english.png` 由 v1.2.5 桌面程序的内嵌前端生成。使用独立合成书架，文件名用于展示分类、标题补全与搜索，阅读页码和时间是演示数据，不是私人阅读记录。可用 `node test/capture-home-showcase.mjs` 重新生成。

- **论文：** Ashish Vaswani et al., *Attention Is All You Need*, 2017，[arXiv:1706.03762](https://arxiv.org/abs/1706.03762)。透光与米宣截图展示第 3 页的 Transformer 结构图，深色展示第 1 页的标题与摘要。论文版权属于其权利人，原 PDF 未提交到本仓库。
- **问答：** 为展示公式与回答排版而编写的演示内容，通过应用现有渲染入口呈现，不代表一次实测模型回答。
- **译文卡片：** `translation-liquid.png` 与 `translation-frosted.png` 展示桌面内嵌前端的两种材质，使用公开论文和演示译文，未请求模型服务。阅读区及卡片截图可用 `node test/capture-showcase.mjs --pdf <公开论文路径>` 重现，英文阅读截图追加 `--en`。
- **数据：** 截图不包含私人论文库、配置、密钥或会话。
- **版本：** 首页与阅读区截图均已按 v1.2.5 更新，展示微暖透光、悬浮纸面、米宣、深色及双语界面。
