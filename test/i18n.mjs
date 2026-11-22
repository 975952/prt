import assert from 'node:assert/strict';
import { en } from '../public/js/locales/en.js';
import { de, deSingular } from '../public/js/locales/de.js';
import { fil } from '../public/js/locales/fil.js';
import { LANGUAGES, isSupportedLocale, translationTarget } from '../public/js/languages.js';
import { splitAnswerSections } from '../public/js/output-flow.js';
import { explicitPageIn, screenPageRequested, readingIntent, stripPageLabels } from '../public/js/reading-context.js';

const settings = new Map([['reader.locale', 'en']]);
globalThis.localStorage = { getItem: k => settings.get(k) ?? null, setItem: (k,v) => settings.set(k,String(v)) };
const { t, locale, responseLanguage, responseLanguageRule, localizedError, localizeErrorResponse } = await import('../public/js/i18n.js');
assert.equal(locale, 'en');
assert.equal(t('设置'), 'Settings');
assert.equal(t('删除「{0}」', '设置 {1} <b>原文</b>'), 'Delete 设置 {1} <b>原文</b>', 'interpolated content is never translated or expanded');
assert.equal(t('unknown'), 'unknown');
assert.equal(t('{0} 个会话', 1), '1 conversation');
assert.equal(t('{0} 个会话', 2), '2 conversations');
assert.equal(localizedError('保存失败：设置.pdf'), 'Could not save: 设置.pdf');
assert.equal(localizedError('Unknown service error: 设置'), 'Unknown service error: 设置');
const sourceError = new Response(JSON.stringify({ error: '保存失败：新会话.pdf', path: '设置.pdf' }), {
  status: 409, headers: { 'Content-Type': 'application/json', 'X-Test': 'preserved', 'Content-Length': '200' },
});
const translatedError = await localizeErrorResponse(sourceError);
assert.equal(translatedError.status, 409);
assert.equal(translatedError.headers.get('X-Test'), 'preserved');
assert.equal(translatedError.headers.get('Content-Length'), null);
assert.deepEqual(await translatedError.json(), { error: 'Could not save: 新会话.pdf', path: '设置.pdf' });
assert.equal((await sourceError.json()).error, '保存失败：新会话.pdf', 'original response is still readable');
const success = new Response(JSON.stringify({ error: '保存失败：用户原文' }), { headers: { 'Content-Type': 'application/json' } });
assert.equal(await localizeErrorResponse(success), success, 'successful document responses are never translated');
for (const catalog of [en, de, fil, deSingular]) {
  if (catalog !== deSingular) assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort(), 'complete language catalog');
  for (const [source, translated] of Object.entries(catalog)) {
  const parameters = text => [...new Set(text.match(/\{\d+\}/g) || [])].sort();
  assert.deepEqual(parameters(translated), parameters(source), `parameters: ${source}`);
  assert.ok(translated.length, `nonempty translation: ${source}`);
  }
}
assert.equal(isSupportedLocale('unsupported'), false);
assert.equal(isSupportedLocale('__proto__'), false);
for (const language of LANGUAGES) assert.equal(translationTarget(language.target), language.target);
assert.equal(translationTarget('unsupported', '中文'), '中文');
for (const [id, setting, language, count] of [
  ['de', 'Einstellungen', 'German', '1 Gespräch'], ['fil', 'Mga setting', 'Filipino', '1 pag-uusap'],
]) {
  settings.set('reader.locale', id);
  settings.set('reader.responseLanguage', 'auto');
  const module = await import(`../public/js/i18n.js?${id}`);
  assert.equal(module.locale, id);
  assert.equal(module.t('设置'), setting);
  assert.equal(module.responseLanguage(), id);
  assert.match(module.responseLanguageRule(), new RegExp(`Response language: ${language}`));
  assert.equal(module.t('{0} 个会话', 1), count);
  assert.equal(module.t('删除「{0}」', '设置 {1} <b>原文</b>'), (id === 'de' ? '{0} löschen' : 'Burahin ang {0}').replace('{0}', '设置 {1} <b>原文</b>'));
  assert.equal(module.localizedError('保存失败：设置.pdf'), id === 'de' ? 'Speichern fehlgeschlagen: 设置.pdf' : 'Hindi ma-save: 设置.pdf');
  assert.equal(module.localizedError('Unknown service error: 设置'), 'Unknown service error: 设置');
  settings.set('reader.locale', 'en');
  assert.equal(module.locale, id, 'other windows cannot change a running window locale');
}
settings.set('reader.locale', 'unsupported');
assert.equal((await import('../public/js/i18n.js?fallback')).locale, 'en');
settings.set('reader.locale', 'en');
assert.equal(responseLanguage(), 'en');
settings.set('reader.responseLanguage', 'zh-CN');
assert.equal(responseLanguage(), 'zh-CN');
assert.match(responseLanguageRule(), /Simplified Chinese/);
settings.set('reader.responseLanguage', 'auto');
assert.equal(responseLanguage(), 'en');
assert.equal(explicitPageIn('Explain page 5', 10), 5);
assert.equal(explicitPageIn('Explain page 50', 10), null);
assert.equal(screenPageRequested('Explain this page'), true);
assert.equal(screenPageRequested('Compare page 2 with this page'), false);
assert.equal(readingIntent('Give me an example'), 'followup');
assert.equal(readingIntent('Explain the selected text', 'paper text'), 'explain');
assert.equal(stripPageLabels('[Page 5] content'), 'content');
assert.equal(splitAnswerSections('## Question 1\nOne\n\n## Question 2\nTwo').sections.length, 2);
const { sanitiseChips } = await import('../public/js/teaching.js');
assert.equal(sanitiseChips([{ label: 'Explain the attention mechanism', prompt: 'Explain attention' }])[0].label, 'Explain the attention mechanism');

const { streamChat, translateMessages, Settings } = await import('../public/js/ai.js');
let outgoing;
globalThis.fetch = async (_url, options) => {
  outgoing = JSON.parse(options.body);
  return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { headers: { 'Content-Type': 'application/json' } });
};
Settings.data.model = 'test-only';
const original = [{ role: 'system', content: 'Policy' }, { role: 'user', content: '设置' }];
await streamChat({ messages: original, stream: false });
assert.equal(original[0].content, 'Policy', 'does not mutate saved prompt or conversation');
assert.equal(outgoing.messages[1].content, '设置', 'does not translate user input');
assert.match(outgoing.messages[0].content, /Response language: English/);
assert.match(outgoing.messages[0].content, /explicit language request/);
await streamChat({ messages: translateMessages({ text: 'test', targetLang: '中文' }), stream: false });
assert.ok(outgoing.messages.some(m => typeof m.content === 'string' && m.content.includes('中文')), 'explicit translation target survives English UI');
assert.match(outgoing.messages[0].content, /Translation tasks must use their explicitly requested target language/);
for (const [id, language, target] of [['de', 'German', 'Deutsch'], ['fil', 'Filipino', 'Filipino']]) {
  settings.set('reader.responseLanguage', id);
  await streamChat({ messages: original, stream: false });
  assert.match(outgoing.messages[0].content, new RegExp(`Response language: ${language}`));
  settings.set('reader.responseLanguage', 'zh-CN');
  await streamChat({ messages: original, stream: false, outputLanguage: id });
  assert.match(outgoing.messages[0].content, new RegExp(`Response language: ${language}`), 'explicit output language overrides preference');
  await streamChat({ messages: translateMessages({ text: 'SOURCE', targetLang: target }), stream: false });
  assert.ok(outgoing.messages.some(message => typeof message.content === 'string' && message.content.includes(`翻译成${target}`)));
}
console.log(`PASS ${Object.keys(en).length} entries in each catalog; four locales, safe interpolation, answer languages, translation targets`);
