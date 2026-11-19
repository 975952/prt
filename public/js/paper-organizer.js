import { t as tr } from './i18n.js';
import { el, debounce } from './util.js';
import { iconEl } from './icons.js';

const RULES = [
  ['数学/数值分析', /数值分析|数值计算|数值方法|迭代法|有限元|numerical\s+(?:analysis|methods?|computation)|finite\s+element|conjugate\s+gradient|iterative\s+(?:method|solver)|runge[ -]kutta/ig],
  ['数学/概率统计', /概率|统计|随机过程|贝叶斯|probabilit\w*|statistics?|stochastic|bayesian|markov\s+chain/ig],
  ['计算机/计算机视觉', /计算机视觉|图像|目标检测|视觉|残差网络|computer\s+vision|image\s+(?:recognition|classification|segmentation|generation)|object\s+detection|vision\s+transformer|\b(?:resnet|detr|deit|yolo|cifar|imagenet|vit)\b|tokens?[ -]to[ -]tokens?|squeeze[ -]and[ -]excitation/ig],
  ['计算机/自然语言处理', /自然语言|语言模型|机器翻译|文本分类|分词|natural\s+language|language\s+model|machine\s+translation|text\s+classification|attention\s+is\s+all\s+you\s+need|\b(?:bert|gpt[ -]?\d*|llms?|nlp)\b/ig],
  ['计算机/深度学习', /深度学习|神经网络|机器学习|强化学习|反向传播|deep\s+learning|neural\s+networks?|machine\s+learning|reinforcement\s+learning|backpropagation|\btransformers?\b/ig],
  ['数学/线性代数', /线性代数|矩阵|特征值|特征向量|线性方程|linear\s+algebra|matri(?:x|ces)|eigenvalues?|eigenvectors?|singular\s+value|\bAx\s*[=＝]\s*b\b/ig],
  ['物理/电子与电路', /电子|电路|运算放大器|半导体|晶体管|electronic|circuits?|semiconductor|transistor|operational\s+amplifier|op[ -]?amp/ig],
  ['物理/物理学', /物理|光学|偏振|量子|电磁|热力学|力学|physics|optics|polarization|quantum|electromagnet|thermodynamics|mechanics/ig],
  ['数学/数学分析', /数学分析|微积分|复变函数|微分方程|calculus|complex\s+analysis|differential\s+equations?|real\s+analysis/ig],
];
export const organizerFolders = RULES.map(([folder]) => folder);

/** Conservative local rules. An unrecognized title always needs a manual choice. */
export function classifyPaper({ name = '', title = '', label = '' } = {}) {
  const text = [title, label, String(name || '').replace(/\.pdf$/i, '').replace(/_/g, ' ')].join(' ');
  for (const [folder, rule] of RULES) {
    const keywords = [...new Set(text.match(rule) || [])].slice(0, 3);
    if (keywords.length) return { folder, keywords, reason: tr('匹配标题关键词：{0}', keywords.join('、')) };
  }
  return { folder: '', keywords: [], reason: tr('信息不足，请手动选择文件夹') };
}

/** A relative folder only: no traversal, absolute paths or Windows device names. */
export function validateTargetFolder(value) {
  const raw = String(value ?? '');
  const folder = raw.replace(/\\/g, '/');
  if (!folder.trim()) return { valid: false, folder: '', error: tr('请选择目标文件夹') };
  if (folder.length > 1000 || /^[\s/]|[\s/]$/.test(folder) || /[<>:"|?*\u0000-\u001f\u007f-\u009f]/.test(folder)) {
    return { valid: false, folder, error: tr('请输入有效的相对文件夹路径') };
  }
  const bad = folder.split('/').some(part => !part || part.startsWith('.') || part.length > 255
    || /[.\s]$/.test(part) || /^\s/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
  return bad ? { valid: false, folder, error: tr('文件夹名称包含无效字符或保留名称') }
    : { valid: true, folder, error: '' };
}

const paperPath = paper => String(paper.path || paper.name || '').replace(/\\/g, '/');
const parentFolder = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const fileName = path => path.slice(path.lastIndexOf('/') + 1);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const PAGE_SIZE = 40;

/** Preview first; this component never moves a file until Apply is clicked. */
export function createPaperOrganizer({ getPapers = () => [], getFolders = () => [],
  getLabel = paper => paper.name, readTitle, movePaper, onComplete = () => {} } = {}) {
  let rows = [], page = 0, opening = 0, loading = false, reading = false, moving = false;
  let stopped = false, readRun = 0, activeReads = 0, lastFocus = null;
  const nodes = new Map();
  const heading = el('h2', { id: 'paperOrganizerTitle', text: tr('整理 PDF') });
  const description = el('p', { class: 'po-description', text: tr('按文件名和本地标题建议文件夹。检查目标后再移动，文件名保持不变。') });
  const scope = el('select', { id: 'paperOrganizerScope', 'aria-label': tr('整理范围') },
    el('option', { value: 'root', text: tr('根目录未归类') }), el('option', { value: 'all', text: tr('全部论文') }));
  const search = el('input', { type: 'search', id: 'paperOrganizerSearch', placeholder: tr('搜索标题或文件路径'), 'aria-label': tr('搜索标题或文件路径') });
  const read = el('button', { type: 'button', class: 'po-button', id: 'paperOrganizerRead', text: tr('补充识别标题'), onclick: enrichTitles });
  const selection = el('input', { type: 'checkbox', id: 'paperOrganizerSelect', onchange: () => {
    for (const row of currentPage()) if (movable(row)) row.selected = selection.checked;
    sync();
  } });
  const list = el('div', { class: 'po-list', id: 'paperOrganizerList', role: 'list' });
  const datalist = el('datalist', { id: 'paperOrganizerFolders' });
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
    el('p', { class: 'po-note', text: tr('补充识别会读取当前页文件的标题；扫描件可手动分类。') }),
    el('div', { class: 'po-list-head' }, el('label', {}, selection, tr('选择本页可移动项')), count), list, datalist,
    el('div', { class: 'po-page' }, prev, pagination, next), status,
    el('p', { class: 'po-note', text: tr('同名冲突会保留原文件。停止只影响后续文件，已完成的移动不会撤销。') }),
    el('div', { class: 'po-actions' }, cancel, stop, apply));
  document.body.append(dialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { ++opening; ++readRun; stopped = true; lastFocus?.focus?.({ preventScroll: true }); });
  scope.addEventListener('change', () => { page = 0; render(); });
  search.addEventListener('input', debounce(() => { page = 0; render(); }, 100));

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
    selection.disabled = busy || !eligible.length;
    selection.checked = !!eligible.length && selected === eligible.length;
    selection.indeterminate = selected > 0 && selected < eligible.length;
    for (const [row, ui] of nodes) syncRow(row, ui);
    const visible = filtered(), pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    count.textContent = tr('{0} 篇 · 已选择 {1} 篇', visible.length, selectedRows().length);
    pagination.textContent = tr('第 {0} / {1} 页', page + 1, pages);
    prev.disabled = busy || page === 0; next.disabled = busy || page + 1 >= pages;
    apply.disabled = busy || !selectedRows().length || typeof movePaper !== 'function';
    apply.textContent = tr('移动选中的 {0} 个文件', selectedRows().length);
    stop.hidden = !moving && !reading;
    stop.disabled = stopped;
    cancel.textContent = moving ? tr('停止后续处理') : tr('关闭');
    dialog.setAttribute('aria-busy', String(busy));
  }
  function render() {
    const total = filtered().length;
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)));
    nodes.clear(); list.replaceChildren();
    for (const row of currentPage()) {
      const checkbox = el('input', { type: 'checkbox', 'aria-label': tr('选择 {0}', row.title), onchange: () => { row.selected = checkbox.checked; sync(); } });
      const title = el('strong', { class: 'po-paper-title', text: row.title });
      const reason = el('p', { class: 'po-reason' });
      const target = el('input', { type: 'text', value: row.target, list: datalist.id,
        placeholder: tr('选择或输入目标文件夹'), 'aria-label': tr('目标文件夹：{0}', row.title),
        oninput: () => { row.target = target.value; row.edited = true; row.error = ''; row.selected = movable(row); sync(); } });
      const root = el('div', { class: 'po-row', role: 'listitem', dataset: { path: row.from } }, checkbox,
        el('div', { class: 'po-paper' }, title, el('span', { class: 'po-source', text: row.from, title: row.from })),
        el('div', { class: 'po-target' }, target, reason));
      nodes.set(row, { root, checkbox, title, target, reason }); list.append(root);
    }
    if (!total) list.append(el('p', { class: 'po-empty', text: loading ? tr('正在读取文件列表…') : tr('没有待整理的论文') }));
    sync();
  }
  function requestStop() {
    stopped = true;
    if (reading) ++readRun;
    status.textContent = moving ? tr('正在等待当前文件完成；之后停止，已移动文件会保留。') : tr('已停止后续识别；正在读取的文件会自行结束。');
    sync();
  }
  function close() {
    if (moving) { requestStop(); return; }
    if (reading) requestStop();
    dialog.close();
  }
  async function enrichTitles() {
    if (loading || moving || reading || activeReads || typeof readTitle !== 'function') return;
    const tasks = currentPage().filter(row => !row.done), run = ++readRun, opened = opening;
    let index = 0, finished = 0;
    stopped = false; reading = true; sync();
    const current = () => run === readRun && dialog.open && !stopped;
    const worker = async () => {
      while (current() && index < tasks.length) {
        const row = tasks[index++];
        activeReads++;
        let timer;
        // If an adapter ignores cancellation, stop this queue at the deadline
        // instead of starting more reads while the old PDF worker is still alive.
        const readingTitle = Promise.resolve().then(() => readTitle(row.paper.url, row.paper.name));
        readingTitle.finally(() => { activeReads--; if (dialog.open) sync(); }).catch(() => {});
        try {
          const title = await Promise.race([readingTitle, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(tr('标题读取超时，已停止后续识别'))), 12000);
          })]);
          if (!current()) return;
          if (typeof title === 'string' && title.trim()) {
            row.title = title.trim().slice(0, 320);
            const proposal = classifyPaper({ name: row.paper.name, title: row.title });
            row.reason = proposal.reason;
            if (!row.edited) { row.target = proposal.folder; row.selected = movable(row); }
            row.error = '';
          } else row.error = tr('未读到标题，可手动选择文件夹');
        } catch (error) {
          if (!current()) return;
          row.error = tr('标题读取失败：{0}', error.message || String(error));
          if (activeReads > 0 && String(error.message).includes(tr('标题读取超时，已停止后续识别'))) {
            stopped = true; ++readRun;
          }
        } finally { clearTimeout(timer); }
        finished++;
        if (dialog.open) { status.textContent = tr('已识别 {0} / {1} 篇', finished, tasks.length); render(); }
      }
    };
    await Promise.all([worker(), worker()]);
    reading = false;
    if (dialog.open) { if (stopped && opened === opening) status.textContent = tr('已停止后续识别；正在读取的文件会自行结束。'); sync(); }
  }
  async function applyMoves() {
    if (loading || reading || moving || typeof movePaper !== 'function') return;
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
      finally { row.moving = false; sync(); }
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
    rows = []; page = 0; scope.value = 'root'; search.value = ''; status.textContent = '';
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
        const proposal = classifyPaper({ name: paper.name, title });
        const row = { paper, from, title, target: proposal.folder, reason: proposal.reason, selected: false, edited: false, done: false, error: '' };
        row.selected = movable(row); rows.push(row);
        if (index % 100 === 99) { if (index === 99) render(); await pause(); if (revision !== opening || !dialog.open) return; }
      }
      const folderNames = new Set(organizerFolders);
      for (const folder of folders || []) {
        const value = typeof folder === 'string' ? folder : folder.path;
        const checked = validateTargetFolder(value);
        if (checked.valid) folderNames.add(checked.folder);
      }
      datalist.replaceChildren(...[...folderNames].sort().map(value => el('option', { value })));
    } catch (error) { if (revision === opening && dialog.open) status.textContent = tr('读取文件列表失败：{0}', error.message || String(error)); }
    finally { if (revision === opening && dialog.open) { loading = false; render(); search.focus(); } }
  }
  return { open };
}
