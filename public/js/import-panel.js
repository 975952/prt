import { t as tr } from './i18n.js';
import { el } from './util.js';

export function createImportPanel({ open, retry, clear }) {
  let collapsed = false, tasks = [], lastMessage = '';
  const rows = new Map();
  const summary = el('span', { role: 'status', 'aria-live': 'polite' });
  const toggle = el('button', { type: 'button', class: 'import-toggle', 'aria-expanded': 'true', onclick: () => {
    collapsed = !collapsed; render(tasks);
  } }, summary);
  const clearButton = el('button', { type: 'button', class: 'import-clear', text: tr('清除已结束'), onclick: clear });
  const notice = el('div', { class: 'import-notice', role: 'status', 'aria-live': 'polite' });
  const list = el('ol', { class: 'import-task-list' });
  const panel = el('section', { id: 'importPanel', class: 'import-panel', 'aria-label': tr('文件导入'), hidden: true },
    el('div', { class: 'import-panel-head' }, toggle, clearButton), notice, list);
  document.body.append(panel);
  const terminal = task => ['done', 'failed'].includes(task.status);
  function render(next) {
    tasks = next;
    panel.hidden = !tasks.length;
    list.hidden = collapsed;
    notice.hidden = collapsed || !lastMessage;
    notice.textContent = lastMessage;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const pending = tasks.filter(task => !terminal(task)).length;
    summary.textContent = pending ? tr('文件导入 · {0} 项进行中', pending) : tr('文件导入 · 已结束');
    clearButton.disabled = !tasks.some(terminal);
    for (const [id, row] of rows) if (!tasks.some(task => task.id === id)) { row.node.remove(); rows.delete(id); }
    let waiting = 0;
    for (const task of tasks) {
      let row = rows.get(task.id);
      if (!row) {
        const name = el('div', { class: 'import-task-name', text: task.name, title: task.name });
        const status = el('div', { class: 'import-task-status' });
        const detail = el('div', { class: 'import-task-detail' });
        const action = el('button', { type: 'button', class: 'import-task-action', onclick: () => {
          if (task.status === 'done') void open(task.result); else retry(task);
        } });
        const node = el('li', { class: 'import-task', dataset: { taskId: task.id } }, name, status, detail, action);
        row = { node, status, detail, action }; rows.set(task.id, row); list.append(node);
      }
      row.node.dataset.status = task.status;
      const age = Math.max(0, Math.floor((Date.now() - (task.conversionStarted || task.started || task.created)) / 1000));
      row.status.textContent = task.status === 'queued' ? tr('等待中 · 第 {0} 项', ++waiting)
        : task.status === 'waiting' ? tr('等待 PowerPoint · 自动排队')
        : task.status === 'converting' ? tr('正在转换为 PDF · {0} 秒', age)
        : task.status === 'uploading' ? tr('正在导入 · {0} 秒', age)
        : task.status === 'failed' ? tr('导入失败') : tr('已完成 · PDF 已加入书架');
      row.detail.textContent = task.error || task.result?.path || task.folder || '';
      row.detail.hidden = !row.detail.textContent;
      row.action.hidden = !terminal(task);
      row.action.textContent = task.status === 'done' ? tr('打开 PDF') : tr('重试');
    }
  }
  // Keep elapsed time visible without replacing focused buttons or resetting the list scroll.
  setInterval(() => { if (!panel.hidden && tasks.some(task => !terminal(task))) render(tasks); }, 1000);
  return {
    render,
    show() { collapsed = false; lastMessage = ''; render(tasks); },
    duplicate(task) { collapsed = false; lastMessage = tr('「{0}」已在队列中，无需重复添加', task.name); render(tasks); },
  };
}
