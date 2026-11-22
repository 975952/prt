# Interface and answer languages

[Home](../README.en.md) · [Developer guide](开发指南.md)

`public/js/i18n.js` owns the language boundary. Chinese source strings are catalog keys; `public/js/locales/` supplies English, Filipino, and German text. English and German include count-specific singular forms. `public/js/languages.js` defines supported locale IDs, display names, and stable translation targets. The frontend has no localization runtime dependency.

- `reader.locale`: `zh-CN`, `en`, `fil`, or `de`. A window captures it at startup. An unset or unsupported value defaults to English; saved choices are preserved.
- `reader.responseLanguage`: `auto` or any supported locale ID. `auto` follows that window's interface language.
- `reader.translate.targetLang`: `中文`, `English`, `Filipino`, or `Deutsch`. This is independent of the answer language. A new profile uses its interface language; changing UI language preserves an existing translation target, including saved translations and retries.

Use `t(source, ...values)` (imported as `tr`) for app-owned dynamic text. Parameters use `{0}`, `{1}`, etc.; interpolated filenames and user content are never translated. Add the same parameter set to each catalog. Preserve semantic identifiers, stored operation titles, model schema keys, and citation protocols. New untranslated keys fall back to English. Startup and recovery controls use a small inline catalog so they work even if modules fail to load.

Static HTML is translated once at boot, before user content is inserted. There is no mutation observer or translation pass over live answers or PDF content. Known app error messages are translated at their response boundary; arbitrary provider details are kept verbatim.

Language changes save drafts, conversations, tabs, and reading position before reloading. Unsaved settings/notes, active generation, and failed saves prevent the reload. Other windows receive an apply action. New AI requests receive a response-language rule, while explicit user instructions and translation targets take precedence. Answer caches include the effective language.

## Checks

```powershell
node test/i18n.mjs
node test/i18n-ui.mjs
cmd /d /c desktop\build.bat
node test/i18n-ui.mjs --desktop
```

The UI suite uses isolated data and fake model responses. It checks all four interface languages, preserved content and drafts, failed-save guards, translated settings, narrow layouts, new windows, translation targets, and outgoing model-language rules. It does not measure a real model's language compliance.
