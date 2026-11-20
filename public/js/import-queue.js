/** One FIFO per window, shared by picker, file drops and folder drops. */
export function createImportQueue({ run, changed = () => {}, completed = () => {}, failed = () => {}, duplicate = () => {} }) {
  const tasks = [];
  let running = false, serial = 0;
  const active = task => !['done', 'failed'].includes(task.status);
  const notify = () => changed(tasks);
  async function drain() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const task = tasks.find(task => task.status === 'queued');
        if (!task) break;
        task.status = 'uploading'; task.started = Date.now(); notify();
        try {
          task.result = await run(task, status => {
            if (status === 'converting' && task.status !== 'converting') task.conversionStarted = Date.now();
            task.status = status; notify();
          });
          task.status = 'done'; task.finished = Date.now(); task.file = null; notify();
          // Reading/navigation errors must not turn an already saved PDF into a failed import.
          try { await completed(task); } catch (error) { console.warn('[import] refresh/open:', error); }
        } catch (error) {
          task.status = 'failed'; task.error = error?.message || String(error); task.finished = Date.now(); notify();
          try { await failed(task); } catch (error) { console.warn('[import] failure callback:', error); }
        }
      }
    } finally { running = false; }
  }
  return {
    tasks,
    add(files, folder = '', open = false) {
      const added = [];
      for (const file of files) {
        const key = JSON.stringify([folder, file.name, file.size, file.lastModified]);
        const previous = tasks.find(task => task.key === key && active(task));
        if (previous) { duplicate(previous); continue; }
        const task = { id: `import-${crypto.randomUUID()}-${++serial}`, key, file, name: file.name, folder, open,
          presentation: /\.pptx?$/i.test(file.name), status: 'queued', created: Date.now() };
        tasks.push(task); added.push(task);
      }
      notify(); void drain(); return added;
    },
    retry(task) {
      if (task.status !== 'failed' || !task.file) return;
      const previous = tasks.find(other => other !== task && other.key === task.key && active(other));
      if (previous) { duplicate(previous); return; }
      tasks.splice(tasks.indexOf(task), 1); tasks.push(task);
      task.status = 'queued'; task.error = ''; task.conversionStarted = null; notify(); void drain();
    },
    clearFinished() { for (let i = tasks.length - 1; i >= 0; i--) if (!active(tasks[i])) tasks.splice(i, 1); notify(); },
    hasPending: () => tasks.some(active),
  };
}
