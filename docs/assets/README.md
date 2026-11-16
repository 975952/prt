# 界面预览

[返回首页](../../README.md)

这三张图片由当前主分支的真实前端与隔离 Node 服务生成，展示透光、米宣和深色主题。界面未使用独立设计稿或后期替换。

- **论文：** Ashish Vaswani et al., *Attention Is All You Need*, 2017，[arXiv:1706.03762](https://arxiv.org/abs/1706.03762)。透光与米宣截图展示第 3 页的 Transformer 结构图，深色展示第 1 页的标题与摘要。论文版权属于其权利人，原 PDF 未提交到本仓库。
- **问答：** 为展示公式与回答排版而编写的演示内容，通过应用现有渲染入口呈现，不代表一次实测模型回答。
- **数据：** 使用全新临时目录，不包含维护者的论文库、配置、密钥或会话。截图过程中不调用模型接口。
- **版本：** 对应当前源码，可能先于正式 Release；以首页版本说明为准。

## 重新生成

下载论文 PDF 到本机的临时目录。安装测试依赖后运行：

```powershell
npm --prefix test ci
node test/capture-showcase.mjs --pdf "C:/path/to/attention-is-all-you-need.pdf"
```

默认使用 Edge，可通过 `CHROME` 环境变量指定浏览器。生成的三张 `reading-*.png` 写入本目录，临时阅读数据留在被 Git 忽略的 `test/artifacts/`。

更新截图后请检查原文、主题、公式、文字截断和个人信息，再提交图片。
