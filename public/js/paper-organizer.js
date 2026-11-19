import { t as tr } from './i18n.js';
import { el, debounce } from './util.js';
import { iconEl } from './icons.js';
import { PAPER_PLANNER_MAX_PAPERS, parsePaperFolderPlan, validateCategory as validateTargetFolder } from './paper-classifier.js';
export { validateTargetFolder };

const paperPath = paper => String(paper.path || paper.name || '').replace(/\\/g, '/');
const parentFolder = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const fileName = path => path.slice(path.lastIndexOf('/') + 1);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const PAGE_SIZE = 40;

/** Preview first; this component never moves a file until Apply is clicked. */
export function createPaperOrganizer({ getPapers = () => [], getFolders = () => [],
  getLabel = paper => paper.name, groupCollection, checkAIReady = () => {}, movePaper, runMoves, onComplete = () => {} } = {}) {
  let rows = [], page = 0, opening = 0, loading = false, reading = false, moving = false;
  let stopped = false, lastFocus = null, operation = null;
  let existingFolders = [], activePlan = null;
  const nodes = new Map();
  const heading = el('h2', { id: 'paperOrganizerTitle', text: tr('整理 PDF') });
  const description = el('p', { class: 'po-description', text: tr('按名字分类，相似内容放一起。只用一层文件夹，确认后移动。') });
  const scope = el('select', { id: 'paperOrganizerScope', 'aria-label': tr('整理范围') },
    el('option', { value: 'all', text: tr('全部论文') }), el('option', { value: 'root', text: tr('根目录未归类') }));
  const search = el('input', { type: 'search', id: 'paperOrganizerSearch', placeholder: tr('搜索标题或文件路径'), 'aria-label': tr('搜索标题或文件路径') });
  const instructions = el('input', { type: 'text', id: 'paperOrganizerInstructions', maxLength: 1000,
    placeholder: tr('例如：合并相近主题，不要按具体模型或单篇论文建文件夹'), 'aria-label': tr('分类要求（可选）') });
  const classify = el('button', { type: 'button', class: 'po-button primary', id: 'paperOrganizerClassify', text: tr('AI 分类'), onclick: classifyPapers });
  const selection = el('input', { type: 'checkbox', id: 'paperOrganizerSelect', onchange: () => {
    for (const row of currentPage()) if (movable(row)) setSelected(row, selection.checked);
    sync();
  } });
  const list = el('div', { class: 'po-list', id: 'paperOrganizerList', role: 'list' });
  const datalist = el('datalist', { id: 'paperOrganizerFolders' });
  const planSummary = el('summary');
  const planGroups = el('div', { class: 'po-groups' });
  const planPreview = el('details', { id: 'paperOrganizerPlan', class: 'po-plan', hidden: true }, planSummary,
    el('p', { class: 'po-note', text: tr('将多个分类改成相同目录即可合并。应用后替换旧分类并清理旧空目录，可在设置中回退。') }), planGroups);
  const status = el('p', { class: 'po-status', role: 'status', 'aria-live': 'polite' });
  const count = el('span', { class: 'po-count' });
  const prev = el('button', { type: 'button', class: 'po-button', text: tr('上一页'), onclick: () => { page--; render(); } });
  const next = el('button', { type: 'button', class: 'po-button', text: tr('下一页'), onclick: () => { page++; render(); } });
  const pagination = el('span', { class: 'po-pagination' });
  const cancel = el('button', { type: 'button', class: 'po-button', text: tr('关闭'), onclick: close });
  const stop = el('button', { type: 'button', class: 'po-button', text: tr('停止后续处理'), hidden: true, onclick: requestStop });
  const apply = el('button', { type: 'button', class: 'po-button primary', id: 'paperOrganizerApply', text: tr('移动选中的文件'), onclick: applyMoves });
  const dialog = el('dialog', { class: 'paper-organizer', id: 'paperOrganizer', 'aria-labelledby': heading.id },
    el('div', { class: 'po-heading' }, iconEl('folder'), heading), description,
    el('div', { class: 'po-toolbar' }, scope, search, classify),
    el('details', { class: 'po-options' }, el('summary', { text: tr('分类偏好') }),
      el('div', { class: 'po-ai-toolbar' }, instructions)),
    el('p', { class: 'po-note', text: tr('先发送文件名；无法判断时才发送第一页文字或图片。每次重新分类覆盖旧方案。') }),
    planPreview, el('div', { class: 'po-list-head' }, el('label', {}, selection, tr('选择本页可移动项')), count), list, datalist,
    el('div', { class: 'po-page' }, prev, pagination, next), status,
    el('div', { class: 'po-actions' }, cancel, stop, apply));
  document.body.append(dialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => {
    ++opening; operation?.controller.abort(); operation = null; reading = false; stopped = true;
    lastFocus?.focus?.({ preventScroll: true });
  });
  scope.addEventListener('change', () => { page = 0; render(); });
  search.addEventListener('input', debounce(() => { page = 0; render(); }, 100));
  const resetPlan = () => {
    activePlan = null;
    for (const row of rows) if (!row.done && !row.edited) clearSuggestion(row);
    status.textContent = tr('分类要求已更新，请重新运行 AI 分类。'); render();
  };
  instructions.addEventListener('input', resetPlan);

  function filtered() {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(row => (scope.value === 'all' || !parentFolder(row.from))
      && terms.every(term => `${row.title} ${row.from}`.toLocaleLowerCase().includes(term)))
      .sort((a, b) => {
        const groups = activePlan?.plan.folders.map(folder => folder.path) || [];
        const rank = row => row.target ? (groups.indexOf(row.target) < 0 ? groups.length : groups.indexOf(row.target)) : groups.length + 1;
        return rank(a) - rank(b) || (a.target || '').localeCompare(b.target || '') || (a.order ?? 0) - (b.order ?? 0);
      });
  }
  function currentPage() { return filtered().slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE); }
  function targetOf(row) {
    const result = validateTargetFolder(row.target);
    if (result.valid && result.folder.toLocaleLowerCase() === parentFolder(row.from).toLocaleLowerCase()) {
      return { ...result, valid: false, error: tr('已在此文件夹中') };
    }
    return result;
  }
  function movable(row) { return !row.done && !row.moving && targetOf(row).valid; }
  function selectedRows() { return filtered().filter(row => row.selected && movable(row)); }
  function setSelected(row, selected) {
    row.selected = selected;
    if (selected && row.aiState === 'review') {
      row.edited = true;
      row.reason = tr('已手动调整；重新分类会替换');
    }
  }
  function planKey() { return JSON.stringify([scope.value, search.value.trim(), instructions.value.trim()]); }
  function pendingRows() {
    return filtered();
  }
  function clearSuggestion(row) {
    row.target = ''; row.selected = false; row.aiState = 'pending'; row.error = '';
    row.reason = '';
  }
  function updateFolders() {
    const folders = new Set(existingFolders);
    if (activePlan?.key === planKey()) for (const folder of activePlan.plan.folders) folders.add(folder.path);
    for (const row of rows) { const target = validateTargetFolder(row.target); if (target.valid) folders.add(target.folder); }
    datalist.replaceChildren(...[...folders].sort().map(value => el('option', { value })));
    return [...folders];
  }
  function renderPlan() {
    const groups = new Map();
    if (activePlan?.key === planKey()) for (const folder of activePlan.plan.folders) groups.set(folder.path, []);
    for (const row of filtered()) {
      if (row.done || !validateTargetFolder(row.target).valid) continue;
      if (!groups.has(row.target)) groups.set(row.target, []);
      groups.get(row.target).push(row);
    }
    planPreview.hidden = !groups.size;
    planSummary.textContent = tr('分类方案：{0} 个目录 · 查看篇数、改名或合并', groups.size);
    planGroups.replaceChildren();
    for (const [folder, members] of groups) {
      const input = el('input', { class: 'po-group-target', value: folder, list: datalist.id,
        'aria-label': tr('分类目录：{0}', folder) });
      const change = el('button', { type: 'button', class: 'po-button po-group-apply', text: tr('改名 / 合并'), onclick: () => {
        const target = validateTargetFolder(input.value);
        if (!target.valid) { status.textContent = target.error; input.focus(); return; }
        if (target.folder === folder) return;
        for (const row of members) {
          row.target = target.folder; row.edited = true; row.error = '';
          row.reason = tr('已手动调整；重新分类会替换'); row.selected = movable(row);
        }
        if (activePlan?.key === planKey()) {
          const planned = activePlan.plan.folders.map(item => item.path === folder ? { ...item, path: target.folder } : item);
          const unique = [...new Map(planned.map(item => [item.path, item])).values()];
          try {
            activePlan.plan = parsePaperFolderPlan(JSON.stringify({ folders: unique }), {
              paperCount: activePlan.plan.paperCount, maxDepth: activePlan.plan.maxDepth,
            });
          } catch { activePlan = null; }
        }
        status.textContent = tr('已更新 {0} 篇的目标目录，确认移动前不会修改文件。', members.length);
        updateFolders(); render();
      } });
      input.disabled = change.disabled = loading || reading || moving;
      planGroups.append(el('div', { class: 'po-group', dataset: { folder } },
        el('span', { class: 'po-group-count', text: tr('{0} 篇论文', members.length) }), input, change));
    }
  }
  function syncRow(row, ui) {
    const target = targetOf(row);
    ui.checkbox.checked = row.selected && !row.done;
    ui.checkbox.disabled = loading || moving || reading || !movable(row);
    ui.target.disabled = loading || moving || reading || row.done;
    ui.target.setAttribute('aria-invalid', String(!!row.target && !target.valid));
    ui.root.dataset.status = row.done ? 'done' : row.error ? 'error' : row.moving ? 'moving' : '';
    ui.reason.textContent = row.done ? tr('已移动到：{0}', row.newPath) : row.moving ? tr('正在移动…')
      : row.error || (!target.valid && row.target ? target.error : row.reason);
    ui.reason.hidden = !ui.reason.textContent;
    ui.title.textContent = row.title;
    ui.title.title = row.title;
  }
  function sync() {
    const busy = loading || reading || moving, shown = currentPage(), eligible = shown.filter(movable);
    const selected = eligible.filter(row => row.selected).length;
    scope.disabled = busy; search.disabled = busy;
    instructions.disabled = busy;
    classify.disabled = busy || typeof groupCollection !== 'function' || !pendingRows().length;
    classify.textContent = activePlan ? tr('重新分类') : tr('开始分类');
    selection.disabled = busy || !eligible.length;
    selection.checked = !!eligible.length && selected === eligible.length;
    selection.indeterminate = selected > 0 && selected < eligible.length;
    for (const [row, ui] of nodes) syncRow(row, ui);
    const visible = filtered(), pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    count.textContent = tr('{0} 篇 · 已选择 {1} 篇', visible.length, selectedRows().length);
    pagination.textContent = tr('第 {0} / {1} 页', page + 1, pages);
    pagination.parentElement.hidden = pages <= 1;
    prev.disabled = busy || page === 0; next.disabled = busy || page + 1 >= pages;
    apply.disabled = busy || !selectedRows().length || typeof movePaper !== 'function';
    apply.textContent = tr('移动选中的 {0} 个文件', selectedRows().length);
    stop.hidden = !moving && !reading;
    stop.disabled = stopped;
    cancel.textContent = moving ? tr('停止后续处理') : tr('关闭');
    for (const control of planGroups.querySelectorAll('input,button')) control.disabled = busy;
    dialog.setAttribute('aria-busy', String(busy));
  }
  function render() {
    const total = filtered().length;
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)));
    nodes.clear(); list.replaceChildren();
    let previousGroup = null;
    for (const row of currentPage()) {
      const group = row.target || tr('待分类');
      if (group !== previousGroup && activePlan) {
        list.append(el('div', { class: 'po-section-title', text: group })); previousGroup = group;
      }
      const checkbox = el('input', { type: 'checkbox', 'aria-label': tr('选择 {0}', row.title), onchange: () => { setSelected(row, checkbox.checked); sync(); } });
      const title = el('strong', { class: 'po-paper-title', text: row.title });
      const reason = el('p', { class: 'po-reason' });
      const target = el('input', { type: 'text', value: row.target, list: datalist.id,
        placeholder: tr('分类名称'), 'aria-label': tr('目标文件夹：{0}', row.title),
        oninput: () => { row.target = target.value; row.edited = true; row.error = ''; row.reason = tr('已手动调整；重新分类会替换'); row.selected = movable(row); sync(); renderPlan(); } });
      const root = el('div', { class: 'po-row', role: 'listitem', dataset: { path: row.from } }, checkbox,
        el('div', { class: 'po-paper' }, title, el('span', { class: 'po-source', text: row.from, title: row.from })),
        el('div', { class: 'po-target' }, target, reason));
      nodes.set(row, { root, checkbox, title, target, reason }); list.append(root);
    }
    if (!total) list.append(el('p', { class: 'po-empty', text: loading ? tr('正在读取文件列表…') : tr('没有待整理的论文') }));
    renderPlan();
    sync();
  }
  function requestStop() {
    stopped = true;
    operation?.controller.abort();
    status.textContent = moving ? tr('正在等待当前文件完成；之后停止，已移动文件会保留。') : tr('已停止分类；本次已完成的建议保留，文件未移动。');
    sync();
  }
  function close() {
    if (moving) { requestStop(); return; }
    if (reading) requestStop();
    dialog.close();
  }
  function beginOperation() {
    const task = { controller: new AbortController(), opening };
    operation = task; stopped = false; reading = true; sync();
    return task;
  }
  function isCurrent(task) { return operation === task && task.opening === opening && dialog.open && !task.controller.signal.aborted; }
  function finishOperation(task) {
    if (operation !== task) return;
    operation = null; reading = false;
    if (dialog.open) { updateFolders(); render(); }
  }
  async function classifyPapers() {
    if (loading || moving || reading || typeof groupCollection !== 'function') return;
    try { await checkAIReady(); }
    catch (error) { status.textContent = error.message || String(error); return; }
    if (!dialog.open || loading || reading || moving) return;
    const tasks = pendingRows();
    if (tasks.length > PAPER_PLANNER_MAX_PAPERS) {
      status.textContent = tr('一次最多整理 {0} 篇，请先缩小范围。', PAPER_PLANNER_MAX_PAPERS); return;
    }
    // A new run replaces the whole preview, including manual edits and selections.
    activePlan = null;
    for (const row of rows) {
      if (row.done) { row.from = row.newPath; row.done = false; }
      clearSuggestion(row); row.edited = false; row.order = 0;
    }
    page = 0;
    const key = planKey(), task = beginOperation(); render();
    const accept = result => {
      if (!isCurrent(task)) return;
      const byId = new Map(tasks.map(row => [row.from, row]));
      for (const row of tasks) clearSuggestion(row);
      let order = 0;
      for (const group of result.groups) for (const id of group.ids) {
        const row = byId.get(id);
        if (!row) continue;
        row.target = group.folder; row.order = order++; row.aiState = 'complete'; row.selected = movable(row);
      }
      for (const id of result.unknown) {
        const row = byId.get(id);
        if (row) { row.aiState = 'review'; row.reason = tr('待确认'); row.order = order++; }
      }
      activePlan = { key, plan: { folders: result.groups.map(group => ({ path: group.folder })), maxDepth: 1, paperCount: tasks.length } };
      planPreview.open = false;
      updateFolders(); render();
    };
    try {
      const result = await groupCollection({ papers: tasks.map(row => ({ ...row.paper, id: row.from, path: row.from, name: fileName(row.from) })),
        instructions: instructions.value.trim(), signal: task.controller.signal, onUpdate: accept,
        onProgress: progress => {
          if (!isCurrent(task)) return;
          status.textContent = progress.stage === 'group' ? tr('正在按主题分类…')
            : progress.stage === 'image' ? tr('正在查看第一页图片：{0}', progress.name) : tr('正在读取第一页：{0}', progress.name);
        } });
      if (!isCurrent(task)) return;
      accept(result);
      for (const row of tasks) if (!row.target && result.errors?.has(row.from)) row.reason = result.errors.get(row.from);
      status.textContent = tr('{0} 个分类，{1} 篇待确认。确认后移动。', result.groups.length, result.unknown.length);
    } catch (error) {
      if (isCurrent(task)) status.textContent = error.name === 'TimeoutError'
        ? tr('模型响应超时，已完成的分类保留。可重新分类。')
        : tr('分类失败：{0}。可重新分类。', error.message || String(error));
    } finally { finishOperation(task); }
  }
  async function applyMoves() {
    if (loading || reading || moving || typeof movePaper !== 'function') return;
    const tasks = selectedRows().map(row => ({ row, from: row.from, to: targetOf(row).folder }));
    if (!tasks.length) return;
    moving = true; stopped = false; const moves = []; let failures = 0;
    sync();
    let replacement, operationError = '';
    try { replacement = await (runMoves || ((_tasks, execute) => execute(movePaper)))(tasks, async managedMove => {
    for (const task of tasks) {
      if (stopped) break;
      const { row, from, to } = task;
      row.moving = true; row.error = ''; sync();
      status.textContent = tr('正在移动 {0} / {1}：{2}', moves.length + failures + 1, tasks.length, from);
      try {
        const result = await managedMove({ from, to });
        if (result?.ok === false || result?.moved === false) throw new Error(result?.error?.message || tr('文件未移动，请检查目标文件夹'));
        row.done = true; row.selected = false;
        row.newPath = typeof result?.to === 'string' ? result.to : `${to}/${fileName(from)}`;
        moves.push({ from, to: row.newPath, folder: to, paper: row.paper, result });
      } catch (error) { failures++; row.error = tr('移动失败：{0}', error.message || String(error)); }
      finally { row.moving = false; sync(); renderPlan(); }
    }
    }, { all: scope.value === 'all' && !search.value.trim() }); }
    catch (error) { operationError = tr('整理未完成：{0}。可在设置中回退或重试。', error.message || String(error)); }
    try { if (moves.length) await onComplete(moves); }
    catch (error) { status.textContent = tr('文件已移动，但列表刷新失败：{0}', error.message || String(error)); moving = false; sync(); return; }
    moving = false;
    status.textContent = operationError || (stopped ? tr('已停止：已移动 {0} 篇，失败 {1} 篇；其余文件未处理。', moves.length, failures)
      : tr('已移动 {0} 篇，失败 {1} 篇。失败项可修改后重试。', moves.length, failures));
    if (replacement) status.textContent += tr('旧空分类已清理，{0} 个非空目录已保留。可在设置中回退。', replacement.retained.length);
    sync();
  }
  async function open() {
    if (dialog.open) { search.focus(); return; }
    const revision = ++opening;
    lastFocus = document.activeElement;
    rows = []; activePlan = null; existingFolders = []; planPreview.open = false;
    page = 0; scope.value = 'all'; search.value = ''; status.textContent = '';
    loading = true; stopped = false; dialog.showModal(); render();
    try {
      const [papers, folders] = await Promise.all([getPapers(), getFolders()]);
      if (revision !== opening || !dialog.open) return;
      const seen = new Set();
      for (let index = 0; index < (papers || []).length; index++) {
        const paper = papers[index], from = paperPath(paper);
        if (!from || seen.has(from)) continue;
        seen.add(from);
        const title = String(paper.name || getLabel(paper) || from).replace(/\.pdf$/i, '');
        const row = { paper, from, title, target: '', reason: '',
          selected: false, edited: false, done: false, error: '', aiState: 'pending' };
        rows.push(row);
        if (index % 100 === 99) { if (index === 99) render(); await pause(); if (revision !== opening || !dialog.open) return; }
      }
      const folderNames = new Set();
      for (const folder of folders || []) {
        const value = typeof folder === 'string' ? folder : folder.path;
        const checked = validateTargetFolder(value);
        if (checked.valid) folderNames.add(checked.folder);
      }
      existingFolders = [...folderNames]; updateFolders();
    } catch (error) { if (revision === opening && dialog.open) status.textContent = tr('读取文件列表失败：{0}', error.message || String(error)); }
    finally { if (revision === opening && dialog.open) { loading = false; render(); search.focus(); } }
  }
  return { open };
}
