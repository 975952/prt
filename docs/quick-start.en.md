# Quick start

[Home](../README.en.md) · [中文指南](使用说明书.md)

This guide covers [v1.2.0](https://github.com/975952/prt/releases/tag/v1.2.0), including the new themes, bilingual interface, and draft recovery.

## Open a paper

Put `prt.exe` in a writable folder and launch it. Import a PDF or drag it into the app. Use tabs for multiple papers, or open a tab in another window for comparison. The page number, fit-width control, and zoom slider are in the bottom toolbar. Use `Ctrl+F` to search.

## Choose a language

Open **设置 → 语言 / Language**, select **English**, then apply. The app saves the conversation, draft, and reading position before reloading. Save any open note or settings edits first; stop an active generation before switching. Other open windows show an apply action instead of interrupting their work.

**Answer language** can follow the interface or be set to Simplified Chinese or English. It controls new AI answers; an explicit language request in your question takes precedence. Existing messages, notes, filenames, and paper text are preserved.

The **To** selector in Translation is independent. Changing the interface language does not change an existing translation target.

## Connect an AI service

In **Settings → Model**, enter the service URL, model name, and API key. Save the profile and test the connection. Use a vision-capable model for screenshots and scanned pages. Keep the API key private.

Select text to translate (`T`), explain (`E`), or add it to a question (`Q`). Use screenshot selection (`R`) for figures or pages without a text layer. You can also paste text into Translation or type a question in Chat. Press Enter to send and Shift+Enter for a new line.

Conversations are associated with folders by default. Use history to resume a conversation or start a new one; switching papers within the same folder can continue the discussion. Conversation behavior is configurable in Settings. Saved drafts and unfinished translation tasks can be restored.

## Adjust the appearance

Choose Glass, Rice paper, or Dark in **Settings → Appearance**. Adjust transparency, blur, background brightness, lighting, and motion to taste. Dark mode offers separate text-brightness and colored-text controls. Images keep their original colors; image-only PDF pages retain square corners.

## Back up and upgrade

Close the reader and copy the executable together with `papers/` and `data/`. To upgrade, replace the executable while keeping both folders. The `data/` folder contains API keys and private conversations; do not publish it.

If an AI request fails, check the provider URL, model availability, credentials, quota, and network connection. For a bug report, include the version, steps, expected behavior, and a public or synthetic example. Remove personal information from screenshots. [Report a bug](https://github.com/975952/prt/issues/new/choose).
