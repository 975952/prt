import { el, escapeHtml } from './util.js';
import { iconEl } from './icons.js';
import { t as tr } from './i18n.js';

const ORIGINAL_OPEN_KEY = 'reader.translationOriginalOpen.v1';
export const TRANSLATION_ORIGINAL_OPEN_EVENT = 'prt:translation-original-open';

export function getTranslationOriginalOpen() {
  try { return localStorage.getItem(ORIGINAL_OPEN_KEY) !== '0'; }
  catch { return true; }
}

export function setTranslationOriginalOpen(open) {
  const value = !!open;
  try { localStorage.setItem(ORIGINAL_OPEN_KEY, value ? '1' : '0'); } catch { /* Keep the in-memory preference. */ }
  window.dispatchEvent(new CustomEvent(TRANSLATION_ORIGINAL_OPEN_EVENT, { detail: value }));
}

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
  let captureSequence = 0, attachmentSignature = '', passageSignature = '';
  const button = (id, label, icon, action) => el('button', {
    id, class: 'reading-card-action', type: 'button', title: label, 'aria-label': label,
    onclick: action,
  }, iconEl(icon, { size: 16 }));
  const title = head.querySelector('.pop-title');
  title?.replaceChildren(iconEl('translate', { size: 18 }), el('span', { text: tr('译文') }));
  const historyButton = button('translationCardHistory', tr('翻译记录'), 'history', () => {
    card.dataset.cardView === 'history' ? resetView() : openHistory();
  });
  head.insertBefore(historyButton, close);
  const language = el('select', { id: 'translationCardLanguage', title: tr('翻译目标语言'), 'aria-label': tr('翻译目标语言') },
    el('option', { value: '中文', text: tr('中文') }), el('option', { value: 'English', text: 'English' }));
  language.addEventListener('change', () => void perform(onTargetLanguageChange, language.value));
  const capture = button('translationCardCapture', tr('截图翻译'), 'screenshot', () => perform(onCapture));
  language.hidden = !onTargetLanguageChange; capture.hidden = !onCapture;
  head.insertBefore(language, historyButton); head.insertBefore(capture, historyButton);
  const original = el('div', { class: 'reading-card-original', id: 'translationCardOriginal', hidden: true });
  let originalOpen = getTranslationOriginalOpen();
  const originalToggle = button('translationCardOriginalToggle', tr('原文对照'), 'list', () => {
    setTranslationOriginalOpen(!originalOpen);
  });
  quote.before(original); original.append(quote);
  const meta = el('div', { class: 'reading-card-meta' });
  const locate = button('translationCardLocate', tr('定位原文'), 'book', () => current() && onLocate?.(current()));
  const status = el('span', { class: 'reading-card-status', 'aria-live': 'polite' });
  meta.append(status); original.before(meta);
  const history = el('div', { class: 'reading-card-history', id: 'translationCardHistoryList', role: 'list', hidden: true });
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
  tools.append(originalToggle, locate, copy, save, retry, stop, remove);
  const pager = el('div', { class: 'reading-card-pager' });
  const previous = button('translationCardPrevious', tr('上一条'), 'chevron-left', () => step(-1));
  const count = el('span', { class: 'reading-card-count' });
  const next = button('translationCardNext', tr('下一条'), 'chevron-right', () => step(1));
  pager.append(previous, count, next); footer.append(tools, pager);
  card.insertBefore(footer, document.getElementById('translationCardResize'));
  const editor = el('form', { class: 'reading-card-editor', hidden: !onTranslate });
  const input = el('textarea', { id: 'translationCardInput', rows: 2,
    placeholder: tr('输入或粘贴文字'), 'aria-label': tr('待翻译的文字'), title: tr('Enter 翻译 · Shift+Enter 换行') });
  const submit = button('translationCardSubmit', tr('翻译'), 'arrow-up');
  submit.type = 'submit';
  const passages = el('div', { id: 'translationCardPassages', class: 'reading-card-passages', hidden: true, 'aria-label': tr('待翻译选段') });
  const attachments = el('div', { id: 'translationCardAttachments', class: 'reading-card-attachments', hidden: true });
  const editorBody = el('div', { class: 'reading-card-editor-body' }, passages, attachments, input);
  editor.append(editorBody, submit); footer.after(editor);
  input.addEventListener('input', () => { saveDraft(input.value); refresh(); });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
    event.preventDefault(); void translateInput();
  });
  editor.addEventListener('submit', event => { event.preventDefault(); void translateInput(); });

  function saveDraft(text, key = draftKey, images = drafts.get(key)?.images || [], queued = drafts.get(key)?.passages || []) {
    const previousDraft = drafts.get(key);
    drafts.set(key, { text, images, passages: queued, revision: (previousDraft?.revision || 0) + 1 });
  }
  function saveImages(images, key = draftKey) {
    const draft = drafts.get(key) || { text: '', revision: 0 };
    drafts.set(key, { ...draft, images });
  }
  function addCapture(captured, key = String(getDocumentKey() || '')) {
    if (!captured?.shot?.dataUrl || disposed) return false;
    key = String(key || '');
    const image = { id: `card-shot-${++captureSequence}`, shot: { ...captured.shot }, page: captured.page, label: captured.label };
    saveImages([...(drafts.get(key)?.images || []), image], key);
    if (key === String(getDocumentKey() || '')) {
      syncDraft(); ensureVisible(); resetView();
      input.focus({ preventScroll: true });
    }
    return true;
  }
  function addPassages(items, key = String(getDocumentKey() || '')) {
    if (disposed || !Array.isArray(items) || !items.length) return false;
    key = String(key || '');
    const draft = drafts.get(key) || { text: '', images: [], passages: [], revision: 0 };
    const additions = items.filter(item => item && String(item.text || '').trim()).map(item => ({
      id: String(item.id || `card-passage-${++captureSequence}`),
      text: String(item.text).trim(), page: Number(item.page) || null,
      endPage: Number(item.endPage || item.page) || null,
      pages: (Array.isArray(item.pages) ? item.pages : [item.page]).map(Number).filter(page => Number.isInteger(page) && page > 0),
      docId: String(item.docId || key),
    }));
    if (!additions.length) return false;
    const nextPassages = [...(draft.passages || []), ...additions];
    if (nextPassages.reduce((length, item) => length + item.text.length, String(draft.text || '').length) > 20000) return false;
    drafts.set(key, { ...draft, passages: nextPassages, revision: draft.revision + 1 });
    if (key === String(getDocumentKey() || '')) {
      syncDraft(); ensureVisible(); resetView(); refresh(); input.focus({ preventScroll: true });
    }
    return true;
  }
  function renderPassages() {
    const queued = drafts.get(draftKey)?.passages || [];
    const signature = queued.map(item => item.id).join('|');
    passages.hidden = !queued.length;
    if (signature === passageSignature) return;
    passageSignature = signature;
    passages.replaceChildren(...queued.map((item, index) => {
      const location = item.page ? tr('第{0}页', item.page) : tr('选段');
      const label = `${location} · ${item.text.replace(/\s+/g, ' ').slice(0, 90)}`;
      const removePassage = button('', tr('删除'), 'close', () => {
        const current = drafts.get(draftKey)?.passages || [];
        saveDraft(input.value, draftKey, drafts.get(draftKey)?.images || [], current.filter(row => row.id !== item.id));
        refresh(); input.focus({ preventScroll: true });
      });
      removePassage.removeAttribute('id');
      return el('div', { class: 'reading-card-passage', 'data-passage-id': item.id },
        el('span', { class: 'reading-card-passage-index', text: String(index + 1) }),
        el('span', { class: 'reading-card-passage-text', text: label, title: item.text }), removePassage);
    }));
  }
  function renderAttachments() {
    const images = drafts.get(draftKey)?.images || [];
    const signature = images.map(image => image.id).join('|');
    attachments.hidden = !images.length;
    if (signature === attachmentSignature) return;
    attachmentSignature = signature;
    attachments.replaceChildren(...images.map(image => {
      const removeImage = button('', tr('删除'), 'close', () => {
        saveImages((drafts.get(draftKey)?.images || []).filter(item => item.id !== image.id));
        refresh(); input.focus({ preventScroll: true });
      });
      removeImage.removeAttribute('id');
      return el('div', { class: 'reading-card-attachment', 'data-attachment-id': image.id },
        el('img', { src: image.shot.dataUrl, alt: image.label || tr('截图') }), removeImage);
    }));
  }
  function syncDraft() {
    const nextKey = String(getDocumentKey() || '');
    if (nextKey === draftKey) return;
    draftKey = nextKey; input.value = drafts.get(draftKey)?.text || '';
  }
  async function translateInput() {
    syncDraft();
    const text = input.value.trim();
    const images = [...(drafts.get(draftKey)?.images || [])];
    const queued = [...(drafts.get(draftKey)?.passages || [])];
    if ((!text && !images.length && !queued.length) || submitting || busy || typeof onTranslate !== 'function') return;
    const sourceKey = draftKey, sourceDraft = input.value;
    input.value = ''; saveDraft('', sourceKey, [], []);
    const submittedRevision = drafts.get(sourceKey).revision;
    submitting = true; resetView();
    const restoreDraft = (result) => {
      const draft = drafts.get(sourceKey) || { text: '', images: [], passages: [], revision: 0 };
      const restoredText = draft.revision === submittedRevision && !draft.text
        ? (typeof result?.remainingText === 'string' ? result.remainingText : sourceDraft) : draft.text;
      const remaining = Array.isArray(result?.remainingImages) ? result.remainingImages : images;
      const currentIds = new Set((draft.images || []).map(image => image.id));
      const restoredImages = [...remaining.filter(image => !currentIds.has(image.id)), ...(draft.images || [])];
      const remainingPassages = Array.isArray(result?.remainingPassages) ? result.remainingPassages : queued;
      const currentPassageIds = new Set((draft.passages || []).map(item => item.id));
      const restoredPassages = [...remainingPassages.filter(item => !currentPassageIds.has(item.id)), ...(draft.passages || [])];
      saveDraft(restoredText, sourceKey, restoredImages, restoredPassages);
      if (String(getDocumentKey() || '') === sourceKey) { syncDraft(); input.value = restoredText; }
    };
    try {
      const resultPromise = onTranslate({ text, targetLang: language.value, images, passages: queued });
      input.focus({ preventScroll: true });
      const result = await resultPromise;
      if (result === false || result?.status === 'failed' || result?.status === 'stopped') {
        restoreDraft(result); actionError = result?.status === 'stopped' ? tr('已停止')
          : String(result?.error?.message || result?.error || tr('翻译失败，请重试。'));
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
    quote.textContent = record.retry?.text || record.quote || '';
    content.innerHTML = render(record.text || '');
    historySelectionId = record.id; historySelectionText = String(record.text || ''); actionError = '';
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
    history.replaceChildren(...rows);
    if (!list.length) history.append(el('p', { class: 'reading-card-empty', text: tr('暂无译文') }));
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
    locate.hidden = !record?.page || !onLocate;
    locate.title = record?.page ? tr('第{0}页', record.page) : tr('定位原文');
    originalToggle.disabled = !quote.textContent;
    originalToggle.setAttribute('aria-pressed', String(originalOpen));
    renderPassages(); renderAttachments();
    const draft = drafts.get(draftKey);
    submit.disabled = busy || submitting || (!input.value.trim() && !draft?.images?.length && !draft?.passages?.length);
    submit.title = tr('翻译 {0} 项', (draft?.passages?.length || 0) + (draft?.images?.length || 0) + (input.value.trim() ? 1 : 0));
    input.setAttribute('aria-busy', String(submitting));
    setText(count, index >= 0 ? `${index + 1} / ${list.length}` : String(list.length));
    setText(status, actionError || (pending ? tr('翻译中…') : record?.status === 'failed' ? tr('翻译失败')
      : record?.status === 'stopped' ? tr('已停止') : ''));
    const showHistory = card.dataset.cardView === 'history';
    history.hidden = !showHistory;
    original.hidden = showHistory || !quote.textContent || !originalOpen;
    meta.hidden = showHistory || !status.textContent; footer.hidden = showHistory;
    card.querySelector('.translation-card-message').hidden = showHistory;
    if (showHistory) renderHistory(list);
  }
  function scheduleRefresh() {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => { frame = 0; refresh(); });
  }
  const syncOriginalPreference = event => {
    originalOpen = !!event.detail;
    refresh();
  };
  window.addEventListener(TRANSLATION_ORIGINAL_OPEN_EVENT, syncOriginalPreference);
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(card, { attributes: true, attributeFilter: ['class', 'data-entry-id'], childList: false });
  observer.observe(content, { childList: true, characterData: true, subtree: true });
  observer.observe(quote, { childList: true, characterData: true, subtree: true });
  refresh();
  return { open, openHistory, select, refresh, resetView, addCapture, addPassages,
    dispose() { disposed = true; observer.disconnect(); window.removeEventListener(TRANSLATION_ORIGINAL_OPEN_EVENT, syncOriginalPreference); if (frame) cancelAnimationFrame(frame); } };
}
