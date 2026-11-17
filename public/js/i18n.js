import { en, enSingular } from './locales/en.js';

export const LOCALE_KEY = 'reader.locale';
export const RESPONSE_LANGUAGE_KEY = 'reader.responseLanguage';
export function storedLocale() {
  try { return globalThis.localStorage?.getItem(LOCALE_KEY) === 'en' ? 'en' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}
// A window keeps its language until its UI is safely reloaded. Other windows may be generating.
export const locale = storedLocale();
export const intlLocale = locale === 'en' ? 'en-US' : 'zh-CN';
export function t(source, ...values) {
  const translated = locale === 'en' ? ((Number(values[0]) === 1 ? enSingular[source] : undefined) ?? en[source] ?? source) : source;
  return String(translated).replace(/\{(\d+)\}/g, (match, i) => i < values.length ? String(values[i] ?? '') : match);
}
export function responseLanguage() {
  let choice;
  try { choice = globalThis.localStorage?.getItem(RESPONSE_LANGUAGE_KEY); } catch { /* use interface language */ }
  return choice === 'en' || choice === 'zh-CN' ? choice : locale;
}
export function responseLanguageRule() {
  const lang = responseLanguage() === 'en' ? 'English' : 'Simplified Chinese';
  return `Response language: ${lang}. Use this language for answers, explanations, headings, suggested follow-ups, and generated conversation titles. This overrides earlier default-language examples. Follow an explicit language request in the user's current question. Preserve original quotations, technical names, citation markers, and machine-readable keys. Translation tasks must use their explicitly requested target language. Internal structured extraction must keep its required schema.`;
}

/** Run once, before the app inserts any document or user content. No DOM observer or text replacement on live content. */
export function localizeStaticDocument(root = document) {
  root.documentElement.lang = locale;
  if (locale !== 'en') return;
  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest('script, style, textarea')) continue;
    const key = node.textContent.trim();
    if (Object.hasOwn(en, key)) node.textContent = node.textContent.replace(key, en[key]);
  }
  for (const node of root.body.querySelectorAll('*')) {
    for (const name of ['title', 'aria-label', 'placeholder', 'alt']) {
      const value = node.getAttribute(name);
      if (value && Object.hasOwn(en, value)) node.setAttribute(name, en[value]);
    }
  }
}

/** Only app-owned errors go through this boundary; arbitrary service details remain verbatim. */
export function localizedError(error) {
  const message = String(error?.message || error || '');
  if (locale !== 'en' || Object.hasOwn(en, message)) return t(message);
  for (const [source, pattern, slots] of errorPatterns) {
    const match = pattern.exec(message);
    if (match) {
      const values = [];
      slots.forEach((index, i) => { values[index] = match[i + 1]; });
      return t(source, ...values);
    }
  }
  return message;
}

const errorPatterns = Object.keys(en).filter(key => /失败|不合法|非法|超过|过大|已存在/.test(key) && /\{\d+\}/.test(key))
  .map(source => {
    const slots = [];
    const pattern = source.split(/(\{\d+\})/g).map(part => {
      const slot = /^\{(\d+)\}$/.exec(part);
      if (!slot) return part.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      slots.push(Number(slot[1]));
      return '([\\s\\S]*?)';
    }).join('');
    return [source, new RegExp(`^${pattern}$`), slots];
  });

export async function localizeErrorResponse(response) {
  if (locale !== 'en' || response.ok || !response.headers.get('Content-Type')?.includes('json')) return response;
  try {
    const payload = await response.clone().json();
    if (typeof payload?.error?.message === 'string') payload.error.message = localizedError(payload.error.message);
    else if (typeof payload?.error === 'string') payload.error = localizedError(payload.error);
    else return response;
    const headers = new Headers(response.headers);
    headers.delete('Content-Length'); headers.delete('Content-Encoding');
    return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
  } catch { return response; }
}
