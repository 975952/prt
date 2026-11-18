import { t as tr, intlLocale } from './i18n.js';
import { el, toast } from './util.js';
import { iconEl } from './icons.js';

const cleanFolder = value => String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const folderLabel = value => cleanFolder(value) || tr('书架根目录');
function storageKey(value) {
  const text = String(value || '');
  if (/^(.{1,64})-([0-9a-f]{6,10})$/.test(text)) return text;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48)}-${hash.toString(16)}`;
}
function folderOptions(papers, folders) {
  const paths = new Set(['']);
  for (const value of [...folders.map(folder => typeof folder === 'string' ? folder : folder.path),
    ...papers.map(paper => paper.folder || cleanFolder(paper.path).split('/').slice(0, -1).join('/'))]) {
    const parts = cleanFolder(value).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'));
  }
  return [...paths].sort((a, b) => a.localeCompare(b, intlLocale));
}
function paperLabel(paper) { return String(paper?.label || paper?.title || paper?.name || paper?.path || tr('未命名论文')); }
function sourceScope(row, ctx, papers, folders) {
  const described = ctx.describeSessionScope?.(row);
  if (described && ['global', 'folder', 'paper'].includes(described.mode)) return described;
  const key = storageKey(row.fileKey);
  if (['default', '__global__'].some(value => storageKey(value) === key)) return { mode: 'global' };
  const paper = papers.find(value => value.docId && storageKey(value.docId) === key);
  if (paper) return { mode: 'paper', docId: paper.docId, label: paperLabel(paper) };
  const folder = folders.find(value => ctx.folderKeyOf && storageKey(ctx.folderKeyOf(value)) === key);
  if (folder !== undefined) return { mode: 'folder', folderPath: folder };
  if (/^folder-[0-9a-f]+$/.test(row.fileKey)) return { mode: 'folder', folderPath: cleanFolder(row.folderPath) };
  return { mode: '', label: tr('原会话位置') };
}
function scopeLabel(scope, papers) {
  if (scope.mode === 'global') return tr('全局会话');
  if (scope.mode === 'folder') return tr('文件夹 · {0}', scope.label || folderLabel(scope.folderPath));
  if (scope.mode === 'paper') return tr('论文 · {0}', scope.label || paperLabel(papers.find(paper => paper.docId === scope.docId)));
  return scope.label || tr('请选择目标归属');
}

/** A non-modal ownership editor. The caller performs the move and owns persistence. */
export function createSessionMove({ host, getContext, canMove, onMoved } = {}) {
  if (!host) return null;
  let source = null, origin = null, from = null, papers = [], folders = [], moving = false, loading = false, revision = 0, frame = 0;
  const title = el('h2', { id: 'sessMoveTitle', text: tr('更改会话归属') });
  const conversation = el('p', { class: 'sess-move-conversation', id: 'sessMoveConversation' });
  const mode = el('select', { id: 'sessMoveMode' },
    el('option', { value: '', text: tr('请选择目标归属') }),
    el('option', { value: 'global', text: tr('全局会话') }),
    el('option', { value: 'folder', text: tr('文件夹会话') }),
    el('option', { value: 'paper', text: tr('论文会话') }));
  const target = el('select', { id: 'sessMoveTarget' });
  const targetLabel = el('span', { id: 'sessMoveTargetLabel' });
  const targetField = el('label', { class: 'sess-move-field', id: 'sessMoveTargetField', for: 'sessMoveTarget', hidden: true }, targetLabel, target);
  const preview = el('p', { class: 'sess-move-preview', id: 'sessMovePreview', 'aria-live': 'polite' });
  const error = el('p', { class: 'sess-move-error', id: 'sessMoveError', role: 'alert', hidden: true });
  const cancel = el('button', { type: 'button', class: 'sess-move-button', id: 'sessMoveCancel', text: tr('取消'), onclick: () => close() });
  const submit = el('button', { type: 'submit', class: 'sess-move-button primary', id: 'sessMoveSubmit', text: tr('移动会话') });
  const panel = el('form', { class: 'sess-move-panel', id: 'sessMovePanel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'sessMoveTitle' },
    el('div', { class: 'sess-move-heading' }, iconEl('folder'), title), conversation,
    el('div', { class: 'sess-move-fields' }, el('label', { class: 'sess-move-field', for: 'sessMoveMode' }, el('span', { text: tr('目标归属') }), mode), targetField),
    preview,
    el('p', { class: 'sess-move-note', text: tr('保留完整对话、附件与标题，移到新的归属。') }), error,
    el('div', { class: 'sess-move-actions' }, cancel, submit));
  const layer = el('div', { class: 'sess-move-layer', id: 'sessMoveLayer', hidden: true }, panel);
  host.append(layer);

  function chosenTarget() {
    if (mode.value === 'global') return { mode: 'global', docId: '', folderPath: '' };
    if (mode.value === 'folder') return { mode: 'folder', docId: '', folderPath: target.value };
    if (mode.value === 'paper' && target.value) {
      const paper = papers.find(value => value.docId === target.value);
      if (paper) return { mode: 'paper', docId: paper.docId, folderPath: cleanFolder(paper.folder || cleanFolder(paper.path).split('/').slice(0, -1).join('/')) };
    }
    return null;
  }
  function sameTarget(next) {
    if (!next || next.mode !== from?.mode) return false;
    return next.mode === 'global' || (next.mode === 'folder' ? cleanFolder(next.folderPath) === cleanFolder(from.folderPath) : next.docId === from.docId);
  }
  function sync() {
    const next = chosenTarget(), disabled = moving || loading;
    for (const control of [mode, target, cancel]) control.disabled = disabled;
    submit.disabled = disabled || !next || sameTarget(next);
    submit.textContent = moving ? tr('正在移动…') : tr('移动会话');
    panel.setAttribute('aria-busy', String(disabled));
    const description = `${scopeLabel(from || {}, papers)} → ${next ? scopeLabel(next, papers) : tr('请选择目标归属')}`;
    preview.textContent = description;
    preview.title = description;
    conversation.title = `${conversation.textContent} · ${description}`;
  }
  function setMode() {
    error.hidden = true;
    targetField.hidden = !['folder', 'paper'].includes(mode.value);
    if (mode.value === 'folder') {
      targetLabel.textContent = tr('目标文件夹');
      target.replaceChildren(...folders.map(folder => el('option', { value: folder, text: folderLabel(folder) })));
      target.value = folders.includes(cleanFolder(from?.folderPath)) ? cleanFolder(from?.folderPath) : '';
    } else if (mode.value === 'paper') {
      targetLabel.textContent = tr('目标论文');
      target.replaceChildren(el('option', { value: '', text: papers.length ? tr('选择一篇论文') : tr('书架里还没有论文') }),
        ...papers.map(paper => el('option', { value: paper.docId, text: paper.folder ? `${paperLabel(paper)} · ${paper.folder}` : paperLabel(paper) })));
      target.value = papers.some(paper => paper.docId === from?.docId) ? from.docId : '';
    }
    sync();
  }
  function position() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!source) return;
      const history = document.getElementById('sessHistory'), area = document.getElementById('aiArea');
      const anchor = history?.offsetHeight ? history : area;
      if (!anchor?.offsetWidth || !anchor.offsetHeight) { layer.style.visibility = 'hidden'; return; }
      layer.style.left = `${anchor.offsetLeft}px`; layer.style.top = `${anchor.offsetTop}px`;
      layer.style.width = `${anchor.offsetWidth}px`; layer.style.height = `${anchor.offsetHeight}px`;
      layer.style.visibility = 'visible';
    });
  }
  function close({ focus = true, force = false } = {}) {
    if (moving && !force) return false;
    revision++; source = null; layer.hidden = true; layer.style.visibility = 'hidden';
    if (focus && origin?.isConnected) origin.focus({ preventScroll: true });
    return true;
  }
  async function open(row, trigger) {
    if (moving || !row?.fileKey || !(Number(row.count) > 0) || !canMove?.()) return;
    const request = ++revision;
    source = { ...row, docIds: [...(row.docIds || [])], _copies: row._copies?.map(copy => ({ ...copy })) };
    origin = trigger || document.activeElement; from = null; papers = []; folders = [''];
    moving = false; loading = true; mode.value = ''; error.hidden = true;
    conversation.textContent = row.title || tr('（无标题会话）');
    layer.hidden = false; setMode(); position();
    try {
      const ctx = getContext();
      const [paperRows, folderRows] = await Promise.all([ctx.papers?.() || [], ctx.folders?.() || []]);
      if (request !== revision) return;
      papers = (Array.isArray(paperRows) ? paperRows : []).filter(paper => paper?.docId)
        .slice().sort((a, b) => paperLabel(a).localeCompare(paperLabel(b), intlLocale));
      folders = folderOptions(papers, Array.isArray(folderRows) ? folderRows : []);
      from = sourceScope(source, ctx, papers, folders);
      mode.value = from.mode;
      setMode();
    } catch (cause) { error.textContent = String(cause?.message || tr('无法读取目标位置，请重试。')); error.hidden = false; }
    finally { if (request === revision) { loading = false; sync(); position(); mode.focus({ preventScroll: true }); } }
  }
  mode.addEventListener('change', setMode);
  target.addEventListener('change', () => { error.hidden = true; sync(); });
  panel.addEventListener('submit', async event => {
    event.preventDefault();
    const next = chosenTarget();
    if (moving || loading || !source || !next || sameTarget(next) || !canMove?.()) return;
    const row = source, destination = scopeLabel(next, papers), ctx = getContext();
    moving = true; error.hidden = true; sync();
    try {
      if (typeof ctx.moveSession !== 'function') throw new Error(tr('暂时无法移动会话，请重试。'));
      await ctx.moveSession(row, next);
    } catch (cause) {
      moving = false;
      error.textContent = String(cause?.message || tr('移动失败，原会话仍保留。'));
      error.hidden = false; sync(); return;
    }
    moving = false; close({ focus: false });
    toast(tr('会话已移至{0}', destination), 'ok');
    await onMoved?.(row, next);
  });
  new ResizeObserver(position).observe(host);
  for (const id of ['aiArea', 'sessHistory']) {
    const area = document.getElementById(id);
    if (area) new ResizeObserver(position).observe(area);
  }
  new MutationObserver(position).observe(host, { attributes: true, attributeFilter: ['data-sess-view', 'data-active-panel'] });
  window.addEventListener('resize', position);
  return { open, close, isOpen: () => !!source, isMoving: () => moving };
}
