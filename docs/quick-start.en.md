# Quick start

[Home](../README.en.md) · [中文指南](使用说明书.md)

This guide covers [v1.2.9](https://github.com/975952/prt/releases/tag/v1.2.9), including background conversation generation, parallel translation, browser paper searches, and updated appearance defaults.

## Open a paper

Put `prt.exe` in a writable folder and launch it. Import a PDF or drag it into the app. Use tabs for multiple papers, or open a tab in another window for comparison. The page number, fit-width control, and zoom slider are in the bottom toolbar. Use `Ctrl+F` to search.

The home sidebar offers All papers, Recent, Unread, and folders. Search by filename or folder and use Continue reading to return to your saved page.

Use `Ctrl+plus` / `Ctrl+minus` to zoom the home from 70% to 160%, and `Ctrl+0` to reset to the default 140%. Numeric PDF names gain a title detected locally from metadata or first-page text; titles are searchable and original files are never renamed. Scans and files with no reliable title keep their original label.

Use **Search paper in browser** from a citation card or the reference list to open a Bing query in your default browser. Linked papers already in the library still open directly in the reader.

## Choose a language

The interface starts in **English**. Open **Settings → Language / 语言** to choose English or Simplified Chinese, then apply. The app saves the conversation, draft, and reading position before reloading. Save any open note or settings edits first; stop an active generation before switching. Other open windows show an apply action instead of interrupting their work.

**Answer language** can follow the interface or be set to Simplified Chinese or English. It controls new AI answers; an explicit language request in your question takes precedence. Existing messages, notes, filenames, and paper text are preserved.

The **To** selector in Translation is independent. Changing the interface language does not change an existing translation target.

## Connect an AI service

In **Settings → Model**, enter the service URL, model name, and API key. Save the profile and test the connection. Use a vision-capable model for screenshots and scanned pages. Keep the API key private.

Select text to translate (`T`), explain (`E`), or add it to a question (`Q`). Use screenshot selection (`R`) for figures or pages without a text layer. You can also paste text into Translation or type a question in Chat. Press Enter to send and Shift+Enter for a new line.

Conversations are managed per paper by default, with history ordered by time. **Settings → Conversations** lets you choose independent paper conversations, shared folder conversations, or global sharing, and choose how conversations open. Use history to switch, rename, or manage conversations. Saved drafts and unfinished translation tasks can be restored.

Switching papers within the same conversation preserves the message view and continues generation. Switching to another conversation hides the original view while its task keeps running; you can ask a question in the other conversation and return to see the original task's latest output. Every task keeps the paper materials and page context from when its question was submitted.

With folder sharing enabled, papers in the same folder can continue a conversation. Ungrouped files in the `papers/` root also share one common folder space. Per-paper mode continues to keep each file's conversations separate.

Delete an individual translation using its top-right trash icon. Deletion is immediate, without confirmation, and works for saved, screenshot, failed, and unfinished results. Deleting an active result cancels that request while other batch items continue. The deletion persists and syncs across windows without changing other translations or Chat.

With the right sidebar closed, translations appear in a floating card. Drag its title bar to move it or its lower-right corner to resize it. The size is saved, and long translations scroll within the card. Focus the resize handle and use arrow keys for small adjustments.

Translate successive selections without waiting for earlier results. Sidebar entries stay in submission order, with up to three translations generating at once and additional tasks queued. Closing the floating card only hides it; its task continues in the sidebar. A new selection owns the next card, so an earlier response cannot overwrite it. Use an entry's trash icon to cancel and delete that translation.

## Adjust the appearance

Choose Glass, Rice paper, or Dark in **Settings → Appearance**. Adjust transparency, blur, background brightness, lighting, and motion to taste. Dark mode defaults to 95% text brightness and 65% colored-text saturation. Pale diagram backgrounds become darker shades of their original hue so light labels remain readable. Photographs and saturated graphics keep their original colors; image-only PDF pages retain their original white background and square corners.

Glass starts with a bright, nearly neutral background. **Background tone** ranges from neutral white to warm white, defaulting to 1%, independently of the default 92% background brightness. Page transparency starts at 16%, interface transparency at 100%, blur at 48px, and paper corner radius at 28px. **PDF elevation** and **Page edge highlight** both default to 100% and remain independently adjustable. Rounded corners apply to the paper and the main home panel; sidebars stay flat and square.

Under **Settings → Appearance → Translation card material**, choose **Liquid glass** or **Frosted glass**. Card transparency ranges from 15% to 85% and blur from 0 to 28px. Liquid glass also offers edge refraction from 0% to 100%. Liquid starts at 35% transparency, 11.4px blur, and 99% refraction; Frosted starts at 71% transparency and 9.4px blur. Both remain adjustable and remember their own settings when switching.

Reading text defaults to 17px with 1.72 line spacing, 12px code text, and a 916px content width. Interface text is 13.5px and control size is 100%. Home zoom starts at 140%, with default sidebar widths of 241px on the left and 436px on the right. Existing custom layouts keep their saved values.

Settings apply immediately and are saved automatically, without fading card text or changing PDF pixels, zoom, or reading position. **Reset effects** restores appearance defaults for both card materials while keeping the selected theme, material, font size, and reading position. Existing customized values are retained when upgrading.

Background brightness ranges from 92% to 100%; older settings below that range move to the new minimum. The input box has clearer edge highlights and outer shadows, strengthened on focus. Dark mode retains its dark reading surface.

## Back up and upgrade

Close the reader and copy the executable together with `papers/` and `data/`. To upgrade, replace the executable while keeping both folders. The `data/` folder contains API keys and private conversations; do not publish it.

If an AI request fails, check the provider URL, model availability, credentials, quota, and network connection. For a bug report, include the version, steps, expected behavior, and a public or synthetic example. Remove personal information from screenshots. [Report a bug](https://github.com/975952/prt/issues/new/choose).
