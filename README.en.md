<div align="center">

# prt

**Ask questions as you read.**

[简体中文](README.md) · **English**

prt is a local PDF reader for Windows with built-in AI chat. Organize papers and lecture notes by topic in Library, then open a PDF to translate a passage or ask about a figure. To compare papers, ask Alina a question across files and follow the page references back to each source.

[![Release](https://img.shields.io/github/v/release/975952/prt?style=flat-square)](https://github.com/975952/prt/releases/latest)
[![MIT](https://img.shields.io/badge/license-MIT-586976?style=flat-square)](LICENSE)

[Download installer](https://github.com/975952/prt/releases/latest/download/prt-setup.exe) · [Portable app](https://github.com/975952/prt/releases/latest/download/prt.exe) · [Quick start](docs/quick-start.en.md) · [Report an issue](https://github.com/975952/prt/issues/new/choose)

</div>

## Three workspaces in dark mode

![Library with folders, search, and recently read papers](docs/assets/library-dark-16x10-en.png)

<sub>The library in dark mode, with first-page previews from six public papers including ViT and ResNet. [Papers and screenshot details](docs/assets/README.md).</sub>

![Alina workspace with chat input and shortcuts to reading and paper search](docs/assets/alina-dark-16x10-en.png)

![Reader showing the Transformer architecture alongside an illustrative explanation](docs/assets/reader-dark-16x10-en.png)

<sub>Paper: [Attention Is All You Need](https://arxiv.org/abs/1706.03762). The answer is illustrative.</sub>

When a paper or slide is hard to follow, you often copy text or take a screenshot, switch to an AI app, then return to find your place. Exam revision adds another round of searching through handouts and slide decks. prt brings reading, AI questions, and document organization into one workspace, keeping the source beside the discussion.


## Main features

| Use case | In prt |
| --- | --- |
| **Exam revision** | Import PDF handouts and PPT/PPTX slides, ask AI to organize concepts and explain difficult passages, and discuss several documents together |
| **Document organization** | Keep course material, books, and papers in one library; preview and adjust AI classification before moving files, with organization history you can roll back |
| **Research reading** | Translate selections, explain passages, and ask whole-document questions; select screenshots or long captures to discuss equations, figures, and scanned pages |
| **Cross-file search and comparison** | Search a document, folder, or the whole library; ask cross-file questions with separate page references, jump to the source, and compare documents in tabs or tiled windows |
| **Paper and reference lookup** | Find local papers by title, research topic, or a description; search online, browse references, and manually import online results that have an available PDF link |
| **Notes and conversations** | Highlight, take notes, save translations, and organize conversations per document, folder, or globally, with saved drafts and reading positions |
| **A personal AI assistant** | Chat with Alina outside the reader, use learning memory to adapt explanations, and optionally customize the assistant's name, personality, and communication style |
| **Reading comfort** | Continuous reading, two-page Book view, and single-page landscape slides; Glass, Rice paper, and Dark themes, Chinese/English UI, and separate answer and translation languages |

PPT/PPTX import requires **Microsoft PowerPoint installed locally on Windows** to convert slides to PDF for reading; it does not provide native slide editing. AI features use your configured model service. Figures, screenshots, and scanned-page questions require a vision-capable model.

## Library, Alina, and the reader

Start in Library by default, or choose the reader or Alina in settings. Alina places the reading, paper search, and resume-chat actions together below the input. New chat stays in the sidebar, with a bubble-plus icon when collapsed. Workspace switches preserve reading position and conversations.

PDF organization uses filenames first, then first-page text or images when needed. It proposes flat topic folders, groups similar documents, and preserves existing organization where appropriate. Each classification replaces previous suggestions; files move only after preview and confirmation. Library has a resizable sidebar and shares Alina's dark background.

Source citations show the full document title and page number, with a link back to the original. Chat with Alina in its own workspace or beside the document, and continue discussions per document, folder, or globally.

The separate **Book view** mode uses a two-page spread with a realistic page fold for portrait documents and a single page for landscape slides. Toolbars hide automatically. Translation and chat use movable floating cards, with saved translation history, source comparison, copying, and notes. Ordinary F11 fullscreen keeps the continuous reading layout.

Browse **All papers, Recent, Unread, or folders** from the sidebar. Search by filename or folder, and use the dedicated continue-reading card to return to your saved page. Import and library management stay within reach. During reading, use the top-bar Home button to browse the library, then select a tab to return with its reading position, zoom, and background generation preserved.

## Get started

1. Download **prt-setup.exe** from [Releases](https://github.com/975952/prt/releases/latest) and install it for your Windows account. Administrator privileges are not required.
2. Open **prt** from the Start menu or desktop shortcut and import or drag in a PDF. Reading, search, and notes work without an AI service.
3. For AI features, enter an OpenAI-compatible service URL, model name, and API key in Settings. Image questions require a vision-capable model.
4. The interface starts in **English**. Use **Settings → Language / 语言** to switch between English and Simplified Chinese. The answer language and translation target can be set separately.

Windows 10/11 x64 and [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) are required; the installer checks for the runtime. Node.js is not needed. For an app that runs without installation, download **prt.exe** into a writable folder. You supply your own model service; provider charges may apply.

The [latest release](https://github.com/975952/prt/releases/latest) provides a Windows setup wizard, Start menu and desktop shortcuts, upgrades, and an uninstaller. The installed app keeps program files separate from papers and conversation data. Upgrades preserve your files, and uninstalling keeps personal data. During first installation, you can select a portable copy to copy its papers, settings, and conversations; the original folder remains intact.

Switching between folders keeps open tabs, and reloading restores their order. Fullscreen keeps the tab bar and Home button visible, and generation continues while you browse Home. **Fit width** fills the available reading area and adapts when sidebars or window size change.

Questions can target other imported files and specific pages without scanning an entire textbook. Scanned pages are supplied as images, and comparisons keep each file's page numbers separate. Generation stays with its conversation through navigation; cancellation, retries and ordered saves prevent late results from entering another conversation or replacing a newer answer.

Updated appearance defaults include 17px reading text, 140% home zoom, 16% page transparency, 100% interface transparency, and 92% background brightness. All remain adjustable in **Settings → Appearance**. **Translation card material** offers independently saved Liquid glass and Frosted glass settings: Liquid starts at 35% transparency, 11.4px blur, and 99% edge refraction; Frosted starts at 71% transparency and 9.4px blur. See the [quick start](docs/quick-start.en.md#adjust-the-appearance) for the other defaults.

Conversations are managed per paper by default, with history ordered by time. Choose folder sharing in Settings to continue a discussion across papers in the same folder; ungrouped files then share a common root-folder conversation space.

This release also includes recent reading fixes: clearer input highlights and shadows, a 92%–100% background brightness range, up to three translations generating at once in submission order, correct selection boundaries in narrow-column papers, and readable pastel diagram backgrounds in dark mode. **Search paper in browser** opens the default browser with a Bing query from citation cards and reference lists.

## Your data

| Content | Installed app | Portable app |
| --- | --- | --- |
| Program | `%LOCALAPPDATA%\Programs\prt` | The folder containing `prt.exe` |
| Paper library | `prt\papers` inside your Windows Documents folder | `papers/` beside the EXE |
| Settings, notes, conversations, API keys, and window data | `%LOCALAPPDATA%\prt\data` | `data/` beside the EXE |

The installed app follows the Windows Documents folder, including redirected locations or OneDrive. Close prt before backing up both the library and data folders. Uninstalling preserves them. Migration copies into empty destinations and refuses to merge or overwrite existing data. Import requires ordinary local source and destination directories; links, junctions, and cloud placeholder paths stop the import with an explanation. Do not publish your data folder or attach it to an issue.

To upgrade the installed app, close prt and run the latest **prt-setup.exe**. For the portable app, replace **prt.exe** in its original folder and keep `papers/` and `data/`. Releases include a source archive and `SHA256SUMS.txt`.

The local service listens on `127.0.0.1`. AI requests send the relevant text, images, and conversation context to your configured provider. Online search sends queries to search services. Verify important claims against the original paper.

## Help and feedback

- **Help:** [Quick start](docs/quick-start.en.md) · [Documentation](docs/README.md)
- **Feedback:** [Report an issue or suggest a feature](https://github.com/975952/prt/issues/new/choose) · [Security policy](SECURITY.md)
- **Contribute:** [Contribution guide](CONTRIBUTING.md) · [Build from source](docs/开发指南.md)

Detailed contributor guides are currently in Chinese.

## License

Project code is licensed under [MIT](LICENSE). Third-party components and papers retain their own licenses; the paper shown in screenshots is not covered by this project's MIT license. See [third-party notices](docs/第三方组件.md).
