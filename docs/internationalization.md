# Interface and answer languages

[Home](../README.en.md) · [Developer guide](开发指南.md)

`public/js/i18n.js` owns the language boundary. Chinese source strings are catalog keys; `public/js/locales/en.js` supplies English text and count-specific singular forms. The frontend has no localization runtime dependency.

- `reader.locale`: `zh-CN` or `en`. A window captures it at startup. Existing installations default to Chinese.
- `reader.responseLanguage`: `auto`, `zh-CN`, or `en`. `auto` follows that window's interface language.
- `reader.translate.targetLang`: independent translation direction. Changing UI language preserves it.

Use `t(source, ...values)` (imported as `tr`) for app-owned dynamic text. Parameters use `{0}`, `{1}`, etc.; interpolated filenames and user content are never translated. Add the same parameter set to the English catalog. Preserve semantic identifiers, stored operation titles, model schema keys, and citation protocols.

Static HTML is translated once at boot, before user content is inserted. There is no mutation observer or translation pass over live answers or PDF content. Known app error messages are translated at their response boundary; arbitrary provider details are kept verbatim.

Language changes save drafts, conversations, tabs, and reading position before reloading. Unsaved settings/notes, active generation, and failed saves prevent the reload. Other windows receive an apply action. New AI requests receive a response-language rule, while explicit user instructions and translation targets take precedence. Answer caches include the effective language.

## Checks

```powershell
node test/i18n.mjs
node test/i18n-ui.mjs
cmd /d /c desktop\build.bat
node test/i18n-ui.mjs --desktop
```

The UI suite uses isolated data and fake model responses. It checks both switching directions, preserved content and drafts, failed-save guards, English settings, narrow layouts, new windows, and outgoing model-language rules. It does not measure a real model's language compliance.
