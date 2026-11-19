import { t as tr } from './i18n.js';

const parent = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const parents = path => { const out = []; for (let at = parent(path); at; at = parent(at)) out.push(at); return out; };
const deepest = paths => [...new Set(paths)].filter(Boolean).sort((a, b) => b.split('/').length - a.split('/').length);
const sameFile = (paper, entry) => paper && Number(paper.size) === entry.size && Math.abs(Number(paper.mtime) - entry.mtime) < 2;

/** A write-ahead journal: persist intent before moving, retain uncertain results
 * for recovery after a lost response, and never overwrite a rollback conflict. */
export function createOrganizerHistory({ request = fetch, movePaper, refresh = async () => {},
  lock = work => navigator.locks.request('prt-organizer-history', { ifAvailable: true }, token => {
    if (!token) throw new Error(tr('另一窗口正在整理或回退，请稍后再试'));
    return work();
  }) } = {}) {
  async function api(path, body, method = 'POST') {
    const response = await request(path, body === undefined ? undefined : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error?.message || `HTTP ${response.status}`);
    return value;
  }
  const load = () => api('/api/organizer-history');
  async function save(history) {
    const result = await api('/api/organizer-history', history);
    history.revision = result.revision;
  }
  const listing = () => api('/api/papers');
  async function empty(path) {
    const response = await request(`/api/folders?path=${encodeURIComponent(path)}&mode=empty`, { method: 'DELETE' });
    if (response.ok || response.status === 404) return true;
    if (response.status === 409) return false;
    const value = await response.json();
    throw new Error(value?.error?.message || `HTTP ${response.status}`);
  }
  async function cleanup(history, record, candidates, keep = []) {
    const retained = [];
    for (const path of deepest(candidates)) {
      if (keep.some(target => target === path || target.startsWith(`${path}/`))) continue;
      if (!record.cleanup.includes(path)) { record.cleanup.push(path); await save(history); }
      if (!await empty(path)) retained.push(path);
    }
    return retained;
  }
  async function runBatch(tasks, execute, { all = false } = {}) {
    return lock(async () => {
      const history = await load(), files = await listing();
      if (history.records.some(record => record.status === 'running' || record.status === 'restoring')) {
        throw new Error(tr('上次整理尚未完成，请先在设置中回退后再整理'));
      }
      const record = { id: crypto.randomUUID(), date: new Date().toISOString(), status: 'running',
        folders: files.folders.map(folder => folder.path), cleanup: [], entries: tasks.map(task => {
          const paper = files.papers.find(paper => (paper.path || paper.name) === task.from);
          if (!paper) throw new Error(tr('文件已不存在，请刷新后重试'));
          return { from: task.from, to: `${task.to ? `${task.to}/` : ''}${paper.name}`,
            size: Number(paper.size), mtime: Number(paper.mtime), state: 'pending' };
        }) };
      history.records = [...history.records.slice(-9), record];
      await save(history);
      let persistenceFailed = false;
      try {
        await execute(async ({ from, to }) => {
          if (persistenceFailed) throw new Error(tr('整理记录保存失败，已停止后续移动'));
          const entry = record.entries.find(entry => entry.from === from);
          entry.state = 'moving';
          try { await save(history); } catch (error) { persistenceFailed = true; throw error; }
          const result = await movePaper({ from, to });
          entry.state = result.moved === false ? 'pending' : 'moved';
          try { await save(history); } catch (error) { persistenceFailed = true; throw error; }
          return result;
        });
        if (persistenceFailed) throw new Error(tr('整理记录保存失败，已停止后续移动'));
        const moved = record.entries.filter(entry => entry.state === 'moved');
        const candidates = moved.length ? (all ? record.folders : moved.flatMap(entry => parents(entry.from))) : [];
        const retained = await cleanup(history, record, candidates, tasks.map(task => task.to));
        record.status = 'complete'; await save(history);
        return { retained };
      } finally { await refresh(); }
    });
  }
  async function rollback() {
    return lock(async () => {
      const history = await load();
      const record = [...history.records].reverse().find(record => record.status !== 'restored');
      if (!record) throw new Error(tr('没有可回退的整理记录'));
      record.status = 'restoring'; await save(history);
      let restored = 0;
      const conflicts = [];
      try {
        for (const entry of [...record.entries].reverse()) {
          if (entry.state === 'pending' || entry.state === 'restored') continue;
          const files = (await listing()).papers;
          const original = files.find(paper => paper.path === entry.from), current = files.find(paper => paper.path === entry.to);
          // Lost move/undo responses are reconciled only when the other path is absent.
          if (sameFile(original, entry) && (!current || entry.state === 'moving')) { entry.state = 'restored'; await save(history); continue; }
          if (original || !sameFile(current, entry)) { conflicts.push(entry.from); continue; }
          entry.state = 'restoring'; await save(history);
          try { await movePaper({ from: entry.to, to: parent(entry.from) }); }
          catch { conflicts.push(entry.from); continue; }
          entry.state = 'restored'; await save(history); restored++;
        }
        // Recreate only directories which this operation attempted to remove.
        const existing = new Set((await listing()).folders.map(folder => folder.path));
        const restoreFolders = record.folders.filter(path => record.cleanup.some(cleaned => path === cleaned || path.startsWith(`${cleaned}/`)));
        for (const path of deepest(restoreFolders).reverse()) {
          if (existing.has(path)) continue;
          const response = await request('/api/folders?' + new URLSearchParams({ name: path.split('/').pop(), parent: parent(path) }), { method: 'POST' });
          if (!response.ok) throw new Error(tr('恢复原文件夹失败，请重试回退'));
          existing.add(path);
        }
        for (const path of deepest(record.entries.flatMap(entry => parents(entry.to)))) {
          if (!record.folders.includes(path)) await empty(path);
        }
        record.status = conflicts.length ? 'partial' : 'restored'; await save(history);
        return { restored, conflicts };
      } finally { await refresh(); }
    });
  }
  return { load, runBatch, rollback };
}
