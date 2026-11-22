// Stable locale IDs and translation targets are shared by settings and saved records.
export const LANGUAGES = Object.freeze([
  Object.freeze({ id: 'zh-CN', label: '简体中文', name: 'Simplified Chinese', intl: 'zh-CN', target: '中文' }),
  Object.freeze({ id: 'en', label: 'English', name: 'English', intl: 'en-US', target: 'English' }),
  Object.freeze({ id: 'fil', label: 'Filipino', name: 'Filipino', intl: 'fil-PH', target: 'Filipino' }),
  Object.freeze({ id: 'de', label: 'Deutsch', name: 'German', intl: 'de-DE', target: 'Deutsch' }),
]);

export const isSupportedLocale = value => LANGUAGES.some(language => language.id === value);
export const languageInfo = value => LANGUAGES.find(language => language.id === value) || LANGUAGES[1];
export const translationTarget = (value, fallback = '') => LANGUAGES.some(language => language.target === value) ? value : fallback;
