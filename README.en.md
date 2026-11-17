<div align="center">

# prt

**Read the paper. Understand the ideas.**

[简体中文](README.md) · **English**

A local PDF reader for Windows, with translation, paper chat, and notes beside the original.

[![Release](https://img.shields.io/github/v/release/975952/prt?style=flat-square)](https://github.com/975952/prt/releases/latest)
[![MIT](https://img.shields.io/badge/license-MIT-586976?style=flat-square)](LICENSE)

[Download for Windows](https://github.com/975952/prt/releases/latest/download/prt.exe) · [Quick start](docs/quick-start.en.md) · [Report an issue](https://github.com/975952/prt/issues/new/choose)

</div>

![prt in English with Attention Is All You Need and an illustrative answer](docs/assets/reading-english.png)

<sub>Paper: [Attention Is All You Need](https://arxiv.org/abs/1706.03762). The answer is illustrative. [Screenshot details](docs/assets/README.md).</sub>

## A workspace for reading

| Task | In prt |
| --- | --- |
| Compare papers | Tabs, separate windows, window tiling, and saved reading positions |
| Understand a passage | Selection translation, explanations, original-text comparison, and clickable citations |
| Discuss figures | Screenshot selection, long captures, vision-model questions, equations, and tables |
| Continue a discussion | Folder conversations, history, cross-window sync, and saved drafts |
| Keep your bearings | Full-text search, outlines, highlights, notes, and reference lookup |
| Read comfortably | Glass, Rice paper, and Dark themes; adjustable transparency, blur, and night text brightness |
| Choose your language | Simplified Chinese and English throughout the interface; separate answer and translation languages |

## Get started

1. Download **prt.exe** from [Releases](https://github.com/975952/prt/releases/latest) and put it in a writable folder.
2. Open it and import or drag in a PDF. Reading, search, and notes work without an AI service.
3. For AI features, enter an OpenAI-compatible service URL, model name, and API key in Settings. Image questions require a vision-capable model.
4. In **Settings → 语言 / Language**, select **English** and apply. You can set the answer language separately; the translation target stays independent.

No installation or Node.js is required for the desktop app. Windows 10/11 x64 and [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) are required. You supply your own model service; provider charges may apply.

**Version note:** previews and features reflect the current source; some features are not yet released. See the [release notes](https://github.com/975952/prt/releases/latest) for what is included in the download.

## Your data

Papers are stored in `papers/` beside the EXE. Settings, API keys, notes, conversations, and drafts are stored in `data/`. Keep both folders when upgrading or moving the app. Do not publish `data/` or attach it to an issue.

The local service listens on `127.0.0.1`. AI requests send the relevant text, images, and conversation context to your configured provider. Online search sends queries to search services. Verify important claims against the original paper.

## Help and feedback

- **Help:** [Quick start](docs/quick-start.en.md) · [Documentation](docs/README.md)
- **Feedback:** [Report an issue or suggest a feature](https://github.com/975952/prt/issues/new/choose) · [Security policy](SECURITY.md)
- **Contribute:** [Contribution guide](CONTRIBUTING.md) · [Build from source](docs/开发指南.md)

Detailed contributor guides are currently in Chinese.

## License

Project code is licensed under [MIT](LICENSE). Third-party components and papers retain their own licenses; the paper shown in screenshots is not covered by this project's MIT license. See [third-party notices](docs/第三方组件.md).
