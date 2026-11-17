# Quick start

[Home](../README.en.md) · [中文指南](使用说明书.md)

This guide covers [v1.2.4](https://github.com/975952/prt/releases/tag/v1.2.4), including library zoom, automatic paper titles, adjustable glass translation cards, and floating paper surfaces.

## Open a paper

Put `prt.exe` in a writable folder and launch it. Import a PDF or drag it into the app. Use tabs for multiple papers, or open a tab in another window for comparison. The page number, fit-width control, and zoom slider are in the bottom toolbar. Use `Ctrl+F` to search.

The home sidebar offers All papers, Recent, Unread, and folders. Search by filename or folder and use Continue reading to return to your saved page.

Use `Ctrl+plus` / `Ctrl+minus` to zoom the home from 70% to 160%, and `Ctrl+0` to reset. Numeric PDF names gain a title detected locally from metadata or first-page text; titles are searchable and original files are never renamed. Scans and files with no reliable title keep their original label.

## Choose a language

Open **设置 → 语言 / Language**, select **English**, then apply. The app saves the conversation, draft, and reading position before reloading. Save any open note or settings edits first; stop an active generation before switching. Other open windows show an apply action instead of interrupting their work.

**Answer language** can follow the interface or be set to Simplified Chinese or English. It controls new AI answers; an explicit language request in your question takes precedence. Existing messages, notes, filenames, and paper text are preserved.

The **To** selector in Translation is independent. Changing the interface language does not change an existing translation target.

## Connect an AI service

In **Settings → Model**, enter the service URL, model name, and API key. Save the profile and test the connection. Use a vision-capable model for screenshots and scanned pages. Keep the API key private.

Select text to translate (`T`), explain (`E`), or add it to a question (`Q`). Use screenshot selection (`R`) for figures or pages without a text layer. You can also paste text into Translation or type a question in Chat. Press Enter to send and Shift+Enter for a new line.

Conversations are associated with folders by default. Use history to resume a conversation or start a new one; switching papers within the same folder can continue the discussion. Conversation behavior is configurable in Settings. Saved drafts and unfinished translation tasks can be restored.

Delete an individual translation using its top-right trash icon. Deletion is immediate, without confirmation, and works for saved, screenshot, failed, and unfinished results. Deleting an active result cancels that request while other batch items continue. The deletion persists and syncs across windows without changing other translations or Chat.

With the right sidebar closed, translations appear in a floating card. Drag its title bar to move it or its lower-right corner to resize it. The size is saved, and long translations scroll within the card. Focus the resize handle and use arrow keys for small adjustments.

## Adjust the appearance

Choose Glass, Rice paper, or Dark in **Settings → Appearance**. Adjust transparency, blur, background brightness, lighting, and motion to taste. Dark mode offers separate text-brightness and colored-text controls. Images keep their original colors; image-only PDF pages retain square corners.

Glass uses a near-white, subtly warm background. **Background tone** ranges from neutral white to warm white, with a default of 20%, independently of brightness. Its default page transparency is 12%, while interface transparency is 88%. **PDF elevation** (76% by default) controls the soft outer shadow; **Page edge highlight** (70%) adjusts the fine edge separately. Rounded corners apply to the paper and the main home panel; sidebars stay flat and square.

Under **Settings → Appearance → Translation card material**, choose **Liquid glass** or **Frosted glass**. Card transparency ranges from 15% to 85% and blur from 0 to 28px. Liquid glass also offers edge refraction from 0% to 100%. Liquid starts at 55% transparency and 1.2px blur; Frosted starts at 63% transparency and 15px blur. Both remain adjustable and remember their own settings when switching.

Settings apply immediately and are saved automatically, without fading card text or changing PDF pixels, zoom, or reading position. **Reset effects** restores appearance defaults for both card materials while keeping the selected theme, material, font size, and reading position. Existing customized values are retained when upgrading.

## Back up and upgrade

Close the reader and copy the executable together with `papers/` and `data/`. To upgrade, replace the executable while keeping both folders. The `data/` folder contains API keys and private conversations; do not publish it.

If an AI request fails, check the provider URL, model availability, credentials, quota, and network connection. For a bug report, include the version, steps, expected behavior, and a public or synthetic example. Remove personal information from screenshots. [Report a bug](https://github.com/975952/prt/issues/new/choose).
