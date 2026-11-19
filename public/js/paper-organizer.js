import { t as tr } from './i18n.js';
import { el, debounce } from './util.js';
import { iconEl } from './icons.js';
import { PAPER_CLASSIFIER_BATCH_SIZE, PAPER_PLANNER_MAX_PAPERS, parsePaperFolderPlan, validateTargetFolder } from './paper-classifier.js';
import { runWithDeadline } from './task-deadline.js';
export { validateTargetFolder };

const paperPath = paper => String(paper.path || paper.name || '').replace(/\\/g, '/');
const parentFolder = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const fileName = path => path.slice(path.lastIndexOf('/') + 1);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const PAGE_SIZE = 40;

/** Preview first; this component never moves a file until Apply is clicked. */
export function createPaperOrganizer({ getPapers = () => [], getFolders = () => [],
  getLabel = paper => paper.name, readTitle, planFolders, classifyBatch, checkAIReady = () => {}, movePaper, onComplete = () => {} } = {}) {
  let rows = [], page = 0, opening = 0, loading = false, reading = false, moving = false;
  let stopped = false, activeReads = 0, lastFocus = null, operation = null;
  let existingFolders = [], activePlan = null;
  const nodes = new Map();
  const heading = el('h2', { id: 'paperOrganizerTitle', text: tr('整理 PDF') });
  const description = el('p', { class: 'po-description', text: tr('AI 先统一规划少量主题目录，再为论文归类。预览中可整类改名或合并，确认后再移动。') });
  const scope = el('select', { id: 'paperOrganizerScope', 'aria-label': tr('整理范围') },
    el('option', { value: 'all', text: tr('全部论文') }), el('option', { value: 'root', text: tr('根目录未归类') }));
  const search = el('input', { type: 'search', id: 'paperOrganizerSearch', placeholder: tr('搜索标题或文件路径'), 'aria-label': tr('搜索标题或文件路径') });
  const read = el('button', { type: 'button', class: 'po-button', id: 'paperOrganizerRead', text: tr('补充识别标题'), onclick: enrichTitles });
  const instructions = el('input', { type: 'text', id: 'paperOrganizerInstructions', maxLength: 1000,
    placeholder: tr('例如：合并相近主题，不要按具体模型或单篇论文建文件夹'), 'aria-label': tr('分类要求（可选）') });
  const depth = el('select', { id: 'paperOrganizerDepth', 'aria-label': tr('分类层级') },
    el('option', { value: '1', text: tr('一级主题（推荐）') }), el('option', { value: '2', text: tr('二级分类') }));
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
    el('p', { class: 'po-note', text: tr('将多个分类改成相同目录即可合并。这里仅修改预览，原文件夹不会被删除。') }), planGroups);
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
    el('div', { class: 'po-toolbar' }, scope, search, read),
    el('div', { class: 'po-ai-toolbar' }, el('label', { for: instructions.id, text: tr('分类要求（可选）') }), instructions, depth, classify),
    el('p', { class: 'po-note', text: tr('AI 分类会读取标题，并将文件名、标题和相对目录发送给设置中的模型。纯图片文件依据已有标题或文件名判断。') }),
    planPreview, el('div', { class: 'po-list-head' }, el('label', {}, selection, tr('选择本页可移动项')), count), list, datalist,
    el('div', { class: 'po-page' }, prev, pagination, next), status,
    el('p', { class: 'po-note', text: tr('同名冲突会保留原文件。停止只影响后续文件，已完成的移动不会撤销。') }),
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
  depth.addEventListener('change', resetPlan);

  function filtered() {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(row => (scope.value === 'all' || !parentFolder(row.from))
      && terms.every(term => `${row.title} ${row.from}`.toLocaleLowerCase().includes(term)));
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
      row.reason = tr('已确认此建议，AI 不会覆盖');
    }
  }
  function planKey() { return JSON.stringify([scope.value, search.value.trim(), instructions.value.trim(), depth.value]); }
  function pendingRows() {
    return filtered().filter(row => !row.done && !row.edited && (row.aiState !== 'complete' || activePlan?.key !== planKey()));
  }
  function clearSuggestion(row) {
    row.target = ''; row.selected = false; row.aiState = 'pending'; row.error = '';
    row.reason = tr('等待 AI 分类，或手动指定文件夹');
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
          row.reason = tr('已手动指定，AI 不会覆盖'); row.selected = movable(row);
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
    ui.title.textContent = row.title;
    ui.title.title = row.title;
  }
  function sync() {
    const busy = loading || reading || moving, shown = currentPage(), eligible = shown.filter(movable);
    const selected = eligible.filter(row => row.selected).length;
    scope.disabled = busy; search.disabled = busy;
    read.disabled = busy || activeReads > 0 || typeof readTitle !== 'function' || !shown.some(row => !row.done);
    instructions.disabled = depth.disabled = busy;
    classify.disabled = busy || activeReads > 0 || typeof classifyBatch !== 'function' || typeof planFolders !== 'function' || !pendingRows().length;
    classify.textContent = tr('AI 分类 {0} 篇', pendingRows().length);
    selection.disabled = busy || !eligible.length;
    selection.checked = !!eligible.length && selected === eligible.length;
    selection.indeterminate = selected > 0 && selected < eligible.length;
    for (const [row, ui] of nodes) syncRow(row, ui);
    const visible = filtered(), pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    count.textContent = tr('{0} 篇 · 已选择 {1} 篇', visible.length, selectedRows().length);
    pagination.textContent = tr('第 {0} / {1} 页', page + 1, pages);
    prev.disabled = busy || page === 0; next.disabled = busy || page + 1 >= pages;
    apply.disabled = busy || activeReads > 0 || !selectedRows().length || typeof movePaper !== 'function';
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
    for (const row of currentPage()) {
      const checkbox = el('input', { type: 'checkbox', 'aria-label': tr('选择 {0}', row.title), onchange: () => { setSelected(row, checkbox.checked); sync(); } });
      const title = el('strong', { class: 'po-paper-title', text: row.title });
      const reason = el('p', { class: 'po-reason' });
      const target = el('input', { type: 'text', value: row.target, list: datalist.id,
        placeholder: tr('选择或输入目标文件夹'), 'aria-label': tr('目标文件夹：{0}', row.title),
        oninput: () => { row.target = target.value; row.edited = true; row.error = ''; row.reason = tr('已手动指定，AI 不会覆盖'); row.selected = movable(row); sync(); renderPlan(); } });
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
    status.textContent = moving ? tr('正在等待当前文件完成；之后停止，已移动文件会保留。') : tr('已停止分类和标题读取；已完成的建议保留，文件未移动。');
    sync();
  }
  function close() {
    if (moving) { requestStop(); return; }
    if (reading) requestStop();
    dialog.close();
  }
  async function enrichTitles() {
    if (loading || moving || reading || activeReads || typeof readTitle !== 'function') return;
    const tasks = currentPage().filter(row => !row.done), task = beginOperation();
    activePlan = null;
    for (const row of rows) if (!row.done && !row.edited) clearSuggestion(row);
    try {
      await readTitles(tasks, task, { force: true });
      if (isCurrent(task)) status.textContent = tr('已识别 {0} / {1} 篇', tasks.length, tasks.length);
    } catch (error) {
      if (isCurrent(task)) status.textContent = tr('标题读取失败：{0}', error.message || String(error));
    } finally { finishOperation(task); }
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
  async function readTitles(targets, task, { force = false } = {}) {
    if (typeof readTitle !== 'function') return;
    const tasks = targets.filter(row => force || !row.titleRead);
    let index = 0, finished = 0;
    const worker = async () => {
      while (isCurrent(task) && index < tasks.length) {
        const row = tasks[index++];
        activeReads++;
        let settled = false;
        const readingTitle = Promise.resolve().then(() => readTitle(row.paper.url, row.paper.name, { signal: task.controller.signal }));
        readingTitle.finally(() => { settled = true; activeReads--; if (dialog.open) sync(); }).catch(() => {});
        try {
          const title = await runWithDeadline(() => readingTitle, { signal: task.controller.signal, timeoutMs: 12000 });
          if (!isCurrent(task)) return;
          row.titleRead = true;
          if (typeof title === 'string' && title.trim()) {
            row.title = title.trim().slice(0, 320);
            row.error = '';
            if (!row.edited) row.reason = tr('标题已读取，等待 AI 分类');
          } else if (!row.edited) row.reason = tr('未读到标题，AI 将依据文件名判断');
        } catch (error) {
          if (!isCurrent(task)) return;
          // A provider that ignores cancellation must not accumulate workers.
          if (error.name === 'TimeoutError' && !settled) {
            task.controller.abort();
            status.textContent = tr('标题读取超时，已停止后续识别');
            return;
          }
          row.titleRead = true;
          if (!row.edited) row.reason = tr('未读到标题，AI 将依据文件名判断');
        }
        finished++;
        if (isCurrent(task)) { status.textContent = tr('正在读取标题 {0} / {1}…', finished, tasks.length); sync(); }
      }
    };
    await Promise.all([worker(), worker()]);
  }
  async function classifyPapers() {
    if (loading || moving || reading || activeReads || typeof classifyBatch !== 'function' || typeof planFolders !== 'function') return;
    try { await checkAIReady(); }
    catch (error) { status.textContent = error.message || String(error); return; }
    if (!dialog.open || loading || reading || moving) return;
    const planningRows = filtered().filter(row => !row.done);
    if (planningRows.length > PAPER_PLANNER_MAX_PAPERS) {
      status.textContent = tr('一次最多整理 {0} 篇，请先缩小范围。', PAPER_PLANNER_MAX_PAPERS); return;
    }
    const key = planKey();
    if (activePlan?.key !== key) {
      activePlan = null;
      for (const row of planningRows) if (!row.edited) clearSuggestion(row);
    }
    const tasks = pendingRows(), task = beginOperation();
    let finished = 0, uncertain = 0;
    const preferences = instructions.value.trim();
    try {
      if (!activePlan) {
        await readTitles(planningRows, task);
        if (!isCurrent(task)) return;
        status.textContent = tr('AI 正在为整批论文规划统一目录…');
        const plan = await planFolders({ papers: planningRows.map(row => ({ id: row.from, name: row.paper.name, title: row.title, path: row.from })),
          folders: updateFolders(), instructions: preferences, maxDepth: Number(depth.value), signal: task.controller.signal,
          onProgress: progress => {
            if (isCurrent(task)) status.textContent = progress.stage === 'summarize'
              ? tr('正在汇总全库主题 {0} / {1}…', progress.completed, progress.total) : tr('AI 正在为整批论文规划统一目录…');
          } });
        if (!isCurrent(task)) return;
        activePlan = { key, plan };
        planPreview.open = true;
        updateFolders(); render();
      }
      for (let start = 0; start < tasks.length && isCurrent(task); start += PAPER_CLASSIFIER_BATCH_SIZE) {
        const batch = tasks.slice(start, start + PAPER_CLASSIFIER_BATCH_SIZE);
        for (const row of batch) clearSuggestion(row);
        await readTitles(batch, task);
        if (!isCurrent(task)) return;
        status.textContent = tr('AI 正在分类 {0}–{1} / {2} 篇…', start + 1, start + batch.length, tasks.length);
        const proposals = await classifyBatch({ papers: batch.map(row => ({ id: row.from, name: row.paper.name, title: row.title, path: row.from })),
          folders: updateFolders(), plan: activePlan.plan, instructions: preferences, signal: task.controller.signal });
        if (!isCurrent(task)) return;
        const byId = new Map(proposals.map(proposal => [proposal.id, proposal]));
        for (const row of batch) {
          const proposal = byId.get(row.from);
          const valid = proposal && validateTargetFolder(proposal.folder).valid;
          row.target = valid ? proposal.folder : '';
          row.aiState = valid && proposal.selected ? 'complete' : 'review';
          row.selected = !!(valid && proposal.selected && movable(row));
          row.reason = valid && proposal.selected ? tr('AI 建议：{0}', proposal.reason)
            : tr('需确认：{0}', proposal?.reason || tr('信息不足，请手动选择文件夹'));
          if (row.aiState === 'review') uncertain++;
        }
        finished += batch.length;
        updateFolders(); render();
      }
      if (isCurrent(task)) status.textContent = tr('AI 已分类 {0} 篇，{1} 篇需确认。检查建议后再移动。', finished, uncertain);
    } catch (error) {
      if (isCurrent(task)) status.textContent = tr('AI 分类失败：{0}。已完成的建议保留，可重试剩余项。', error.message || String(error));
    } finally { finishOperation(task); }
  }
  async function applyMoves() {
    if (loading || reading || moving || activeReads || typeof movePaper !== 'function') return;
    const tasks = selectedRows().map(row => ({ row, from: row.from, to: targetOf(row).folder }));
    if (!tasks.length) return;
    moving = true; stopped = false; const moves = []; let failures = 0;
    sync();
    for (const task of tasks) {
      if (stopped) break;
      const { row, from, to } = task;
      row.moving = true; row.error = ''; sync();
      status.textContent = tr('正在移动 {0} / {1}：{2}', moves.length + failures + 1, tasks.length, from);
      try {
        const result = await movePaper({ from, to });
        if (result?.ok === false || result?.moved === false) throw new Error(result?.error?.message || tr('文件未移动，请检查目标文件夹'));
        row.done = true; row.selected = false;
        row.newPath = typeof result?.to === 'string' ? result.to : `${to}/${fileName(from)}`;
        moves.push({ from, to: row.newPath, folder: to, paper: row.paper, result });
      } catch (error) { failures++; row.error = tr('移动失败：{0}', error.message || String(error)); }
      finally { row.moving = false; sync(); renderPlan(); }
    }
    try { if (moves.length) await onComplete(moves); }
    catch (error) { status.textContent = tr('文件已移动，但列表刷新失败：{0}', error.message || String(error)); moving = false; sync(); return; }
    moving = false;
    status.textContent = stopped ? tr('已停止：已移动 {0} 篇，失败 {1} 篇；其余文件未处理。', moves.length, failures)
      : tr('已移动 {0} 篇，失败 {1} 篇。失败项可修改后重试。', moves.length, failures);
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
        const title = String(getLabel(paper) || paper.name || from);
        const row = { paper, from, title, target: '', reason: tr('等待 AI 分类，或手动指定文件夹'),
          selected: false, edited: false, done: false, error: '', aiState: 'pending', titleRead: false };
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
