import { el, escapeHtml } from './util.js';
import { iconEl } from './icons.js';
import { t as tr } from './i18n.js';

/** A view onto the reader's saved translation records, never a second store.
 * The original stream target, drag handle and resize handle keep their identity.
 */
export function createTranslationCard({ getRecords = () => [], beforeSelect,
  render = text => escapeHtml(String(text || '')), onCopy, onSave, onDelete, onRetry, onStop, onLocate,
  getTargetLanguage = () => '中文', onTargetLanguageChange, onCapture, onTranslate,
  getDocumentKey = () => '' } = {}) {
  const card = document.getElementById('translationCard');
  if (!card) return null;
  const content = document.getElementById('translationCardText');
  content.tabIndex = -1;
  const quote = document.getElementById('translationCardQuote');
  const head = card.querySelector('.pop-head');
  const close = document.getElementById('translationCardClose');
  card.classList.add('reading-tool-card');
  card.dataset.cardView = 'translation';
  let disposed = false, frame = 0, busy = false, historySignature = '', actionError = '';
  let historySelectionId = '', historySelectionText = '', submitting = false, composing = false;
  const drafts = new Map();
  let draftKey = String(getDocumentKey() || '');
  const button = (id, label, icon, action) => el('button', {
    id, class: 'reading-card-action', type: 'button', title: label, 'aria-label': label,
    onclick: action,
  }, iconEl(icon, { size: 16 }), el('span', { text: label }));
  const title = head.querySelector('.pop-title');
  title?.replaceChildren(iconEl('translate', { size: 18 }), el('span', { text: tr('译文') }));
  const historyButton = button('translationCardHistory', tr('翻译记录'), 'history', () => {
    card.dataset.cardView === 'history' ? resetView() : openHistory();
  });
  head.insertBefore(historyButton, close);
  const inputs = el('div', { class: 'reading-card-inputs' });
  const language = el('select', { id: 'translationCardLanguage', 'aria-label': tr('翻译目标语言') },
    el('option', { value: '中文', text: tr('中文') }), el('option', { value: 'English', text: 'English' }));
  const languageField = el('label', { class: 'reading-card-language', for: 'translationCardLanguage' },
    el('span', { text: tr('译成') }), language);
  language.addEventListener('change', () => void perform(onTargetLanguageChange, language.value));
  const capture = button('translationCardCapture', tr('截图翻译'), 'screenshot', () => perform(onCapture));
  languageField.hidden = !onTargetLanguageChange; capture.hidden = !onCapture;
  inputs.append(languageField, capture); inputs.hidden = !onTargetLanguageChange && !onCapture;
  head.after(inputs);
  const original = el('details', { class: 'reading-card-original', id: 'translationCardOriginal' },
    el('summary', {}, el('span', { text: tr('原文对照') }), el('span', { class: 'reading-card-original-hint', text: tr('展开') })));
  quote.before(original); original.append(quote);
  const meta = el('div', { class: 'reading-card-meta' });
  const locate = button('translationCardLocate', tr('定位原文'), 'book', () => current() && onLocate?.(current()));
  const status = el('span', { class: 'reading-card-status', 'aria-live': 'polite' });
  meta.append(locate, status); original.before(meta);
  const history = el('div', { class: 'reading-card-history', id: 'translationCardHistoryList', role: 'list', hidden: true });
  const historyTitle = el('p', { class: 'reading-card-history-caption', text: tr('当前文档的翻译记录会自动保留。') });
  history.append(historyTitle);
  card.insertBefore(history, card.querySelector('.translation-card-message'));
  const footer = el('div', { class: 'reading-card-footer' });
  const tools = el('div', { class: 'reading-card-tools' });
  const copy = button('translationCardCopy', tr('复制译文'), 'copy', () => perform(onCopy, current()?.text));
  const save = button('translationCardSave', tr('添加到笔记'), 'note-plus', () => perform(onSave, current()));
  const retry = button('translationCardRetry', tr('重新翻译'), 'refresh', () => perform(onRetry, current()));
  const stop = button('translationCardStop', tr('停止'), 'stop', () => perform(onStop, current()));
  const remove = button('translationCardDelete', tr('删除这条翻译'), 'trash', async () => {
    const record = current(); if (!record) return;
    await perform(onDelete, record);
    if (!records().some(row => row.id === record.id)) openHistory();
  });
  tools.append(copy, save, retry, stop, remove);
  const pager = el('div', { class: 'reading-card-pager' });
  const previous = button('translationCardPrevious', tr('上一条'), 'chevron-left', () => step(-1));
  const count = el('span', { class: 'reading-card-count' });
  const next = button('translationCardNext', tr('下一条'), 'chevron-right', () => step(1));
  pager.append(previous, count, next); footer.append(tools, pager);
  card.insertBefore(footer, document.getElementById('translationCardResize'));
  const editor = el('form', { class: 'reading-card-editor', hidden: !onTranslate });
  const input = el('textarea', { id: 'translationCardInput', rows: 2,
    placeholder: tr('输入或粘贴文字，继续翻译'), 'aria-label': tr('待翻译的文字') });
  const submit = button('translationCardSubmit', tr('翻译'), 'arrow-up');
  submit.type = 'submit';
  const editorActions = el('div', { class: 'reading-card-editor-actions' },
    el('span', { class: 'reading-card-editor-hint', text: tr('Enter 翻译 · Shift+Enter 换行') }), submit);
  editor.append(input, editorActions); footer.after(editor);
  input.addEventListener('input', () => { saveDraft(input.value); refresh(); });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
    event.preventDefault(); void translateInput();
  });
  editor.addEventListener('submit', event => { event.preventDefault(); void translateInput(); });

  function saveDraft(text, key = draftKey) {
    const previousDraft = drafts.get(key);
    drafts.set(key, { text, revision: (previousDraft?.revision || 0) + 1 });
  }
  function syncDraft() {
    const nextKey = String(getDocumentKey() || '');
    if (nextKey === draftKey) return;
    draftKey = nextKey; input.value = drafts.get(draftKey)?.text || '';
  }
  async function translateInput() {
    syncDraft();
    const text = input.value.trim();
    if (!text || submitting || busy || typeof onTranslate !== 'function') return;
    const sourceKey = draftKey, sourceDraft = input.value;
    input.value = ''; saveDraft('');
    const submittedRevision = drafts.get(sourceKey).revision;
    submitting = true; resetView();
    const restoreDraft = () => {
      const draft = drafts.get(sourceKey);
      if (draft?.revision !== submittedRevision || draft.text) return;
      saveDraft(sourceDraft, sourceKey);
      if (String(getDocumentKey() || '') === sourceKey) { syncDraft(); input.value = sourceDraft; }
    };
    try {
      const resultPromise = onTranslate({ text, targetLang: language.value });
      input.focus({ preventScroll: true });
      const result = await resultPromise;
      if (result === false || result?.status === 'failed') {
        restoreDraft(); actionError = String(result?.error?.message || result?.error || tr('翻译失败，请重试。'));
      }
    } catch (error) {
      restoreDraft(); actionError = String(error?.message || tr('翻译失败，请重试。'));
    } finally { submitting = false; refresh(); }
  }

  function records() {
    const seen = new Set();
    return (getRecords() || []).filter(row => {
      if (!row?.id || row.block !== 'translate' || seen.has(row.id)) return false;
      seen.add(row.id); return true;
    }).slice().reverse();
  }
  function current() { return records().find(row => row.id === card.dataset.entryId) || null; }
  function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
  async function perform(action, value) {
    if (typeof action !== 'function' || busy) return;
    busy = true; actionError = ''; refresh();
    try { await action(value); }
    catch (error) { actionError = String(error?.message || tr('操作失败，请重试。')); }
    finally { busy = false; refresh(); }
  }
  function ensureVisible() {
    card.classList.remove('hidden');
    if (!card.style.left && !card.style.right) card.style.right = '16px';
    if (!card.style.top && !card.style.bottom) card.style.top = '80px';
  }
  function resetView() {
    actionError = '';
    card.dataset.cardView = 'translation'; history.hidden = true;
    historyButton.setAttribute('aria-pressed', 'false');
    refresh();
  }
  function open() {
    const record = current() || records()[0];
    if (record && record.id !== card.dataset.entryId) select(record);
    else {
      if (!record) {
        delete card.dataset.entryId; quote.textContent = ''; content.replaceChildren();
        historySelectionId = ''; historySelectionText = '';
      }
      ensureVisible(); resetView();
    }
    if (onTranslate) input.focus({ preventScroll: true });
  }
  function select(record) {
    if (!record || !records().some(row => row.id === record.id)) return;
    const keepInputFocus = submitting && document.activeElement === input;
    beforeSelect?.(record);
    card.dataset.entryId = record.id;
    quote.textContent = record.quote || record.retry?.text || '';
    content.innerHTML = render(record.text || '');
    historySelectionId = record.id; historySelectionText = String(record.text || ''); actionError = '';
    original.open = false;
    ensureVisible(); resetView();
    content.scrollTop = 0;
    if (keepInputFocus) input.focus({ preventScroll: true });
    else content.focus({ preventScroll: true });
  }
  function step(delta) {
    const list = records(), index = list.findIndex(row => row.id === card.dataset.entryId);
    const row = list[index + delta]; if (row) select(row);
  }
  function openHistory() {
    ensureVisible();
    card.dataset.cardView = 'history'; history.hidden = false;
    historyButton.setAttribute('aria-pressed', 'true');
    refresh();
  }
  function renderHistory(list) {
    const signature = JSON.stringify(list.map(row => [row.id, row.page, row.quote, row.text, row.status]));
    if (historySignature === signature) return;
    historySignature = signature;
    const rows = list.map(row => {
      const title = String(row.quote || row.retry?.text || row.docTitle || tr('译文')).trim();
      const summary = String(row.text || (row.status === 'pending' ? tr('翻译中…') : tr('暂无译文'))).trim();
      const item = el('button', { type: 'button', class: 'reading-card-history-row', role: 'listitem',
        title, onclick: () => select(row) },
      el('span', { class: 'reading-card-history-page', text: row.page ? tr('第{0}页', row.page) : tr('译文') }),
      el('span', { class: 'reading-card-history-source', text: title }),
      el('span', { class: 'reading-card-history-result', text: summary }));
      return item;
    });
    history.replaceChildren(historyTitle, ...rows);
    if (!list.length) history.append(el('p', { class: 'reading-card-empty', text: tr('选中原文后点击翻译，译文会保存在这里。') }));
  }
  function refresh() {
    if (disposed) return;
    syncDraft();
    const list = records(), record = current();
    const targetLanguage = getTargetLanguage();
    language.value = targetLanguage === 'English' ? 'English' : '中文';
    language.disabled = busy; capture.disabled = busy;
    if (record?.id === historySelectionId && String(record.text || '') !== historySelectionText) {
      historySelectionText = String(record.text || '');
      content.innerHTML = render(historySelectionText);
    }
    const pending = record?.status === 'pending';
    const hasText = !!record?.text?.trim();
    const index = list.findIndex(row => row.id === record?.id);
    copy.disabled = busy || !hasText || !onCopy;
    save.disabled = busy || !hasText || pending || !onSave;
    retry.disabled = busy || submitting || !record?.retry || pending || !onRetry;
    remove.disabled = busy || !record || !onDelete;
    stop.hidden = !pending || !onStop; stop.disabled = busy;
    retry.hidden = pending;
    previous.disabled = index <= 0; next.disabled = index < 0 || index >= list.length - 1;
    locate.disabled = !record?.page || !onLocate;
    submit.disabled = busy || submitting || !input.value.trim();
    input.setAttribute('aria-busy', String(submitting));
    setText(locate.querySelector('span'), record?.page ? tr('第{0}页', record.page) : tr('定位原文'));
    setText(count, index >= 0 ? `${index + 1} / ${list.length}` : String(list.length));
    setText(status, actionError || (pending ? tr('翻译中…') : record?.status === 'failed' ? tr('翻译失败')
      : record?.status === 'stopped' ? tr('已停止') : record ? tr('自动保留到翻译记录') : ''));
    const showHistory = card.dataset.cardView === 'history';
    history.hidden = !showHistory;
    original.hidden = showHistory || !quote.textContent;
    meta.hidden = showHistory; footer.hidden = showHistory;
    card.querySelector('.translation-card-message').hidden = showHistory;
    if (showHistory) renderHistory(list);
  }
  function scheduleRefresh() {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => { frame = 0; refresh(); });
  }
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(card, { attributes: true, attributeFilter: ['class', 'data-entry-id'], childList: false });
  observer.observe(content, { childList: true, characterData: true, subtree: true });
  observer.observe(quote, { childList: true, characterData: true, subtree: true });
  refresh();
  return { open, openHistory, select, refresh, resetView,
    dispose() { disposed = true; observer.disconnect(); if (frame) cancelAnimationFrame(frame); } };
}
