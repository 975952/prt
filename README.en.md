<div align="center">

# prt

**Read the paper. Understand the ideas.**

[简体中文](README.md) · **English**

A local PDF reader for Windows, with translation, paper chat, and notes beside the original.

[![Release](https://img.shields.io/github/v/release/975952/prt?style=flat-square)](https://github.com/975952/prt/releases/latest)
[![Checks](https://github.com/975952/prt/actions/workflows/checks.yml/badge.svg)](https://github.com/975952/prt/actions/workflows/checks.yml)
[![MIT](https://img.shields.io/badge/license-MIT-586976?style=flat-square)](LICENSE)

[Download for Windows](https://github.com/975952/prt/releases/latest/download/prt.exe) · [Quick start](docs/quick-start.en.md) · [Report an issue](https://github.com/975952/prt/issues/new/choose)

</div>

![prt in English with Attention Is All You Need and an illustrative answer](docs/assets/reading-english.png)

<sub>Actual interface from `main`. Paper: [Attention Is All You Need](https://arxiv.org/abs/1706.03762). The answer is illustrative, not a measured model response. [Screenshot provenance](docs/assets/README.md).</sub>

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

**Release note:** the downloadable v1.1.1 predates the new themes, saved drafts, and bilingual interface shown on `main`. To use these changes before a new release, [build the current source](docs/开发指南.md). Updating source does not update an already downloaded EXE.

## Your data

Papers are stored in `papers/` beside the EXE. Settings, API keys, notes, conversations, and drafts are stored in `data/`. Keep both folders when upgrading or moving the app. Do not publish `data/` or attach it to an issue.

The local service listens on `127.0.0.1`. AI requests send the relevant text, images, and conversation context to your configured provider. Online search sends queries to search services. Verify important claims against the original paper.

## Develop and contribute

The frontend uses native JavaScript ES modules, PDF.js, and KaTeX. The desktop app uses Rust, Tao, and Wry/WebView2, embedding its frontend in one executable. A Node.js server with no npm runtime dependencies is included for development.

```powershell
npm --prefix test test
cmd /d /c desktop\build.bat
```

See the [developer guide](docs/开发指南.md), [contribution guide](CONTRIBUTING.md), [language implementation](docs/internationalization.md), and [documentation index](docs/README.md). These detailed technical guides are currently in Chinese or explicitly marked by language. Report vulnerabilities using the [security policy](SECURITY.md).

## License

Project code is licensed under [MIT](LICENSE). Third-party components and papers retain their own licenses; the paper shown in screenshots is not covered by this project's MIT license. See [third-party notices](docs/第三方组件.md).
