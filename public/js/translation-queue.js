/** In-window bounded translation batches. No DOM, storage, fetch or model dependencies. */

let sequence = 0;
const batches = new WeakMap();
const id = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 8)}`}`;
const messageOf = (error) => String(error?.message || error || 'Translation failed');

function metaOf(batch) {
  const meta = batches.get(batch);
  if (!meta) throw new TypeError('Expected a batch created by createTranslationBatch');
  return meta;
}

function notify(run) {
  // Rendering a status line must not discard an otherwise recoverable queue.
  try { run?.onChange?.(run.batch); } catch { /* the caller owns its UI diagnostics */ }
}

function pause(run, reason) {
  if (!run.stopReason) run.stopReason = String(reason || 'user');
  run.batch.status = 'paused';
  run.batch.reason = run.stopReason;
  for (const item of run.items) if (item.status === 'running') item.status = 'stopped';
  if (!run.controller.signal.aborted) run.controller.abort(run.stopReason);
}

/**
 * Capture ownership and item order at submission. Items are shallow copies: source
 * objects are not mutated, while app-owned entry/refId fields may be attached later.
 * A paused batch remains in this window only; this module does not persist it.
 */
export function createTranslationBatch({ docId = '', sid = '', targetLang = '中文', items = [] } = {}) {
  if (!Array.isArray(items)) throw new TypeError('Translation items must be an array');
  const seen = new Set();
  const copied = items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Each translation item must be an object');
    let itemId = String(item.id || '');
    if (!itemId || seen.has(itemId)) itemId = id('ti');
    seen.add(itemId);
    const copy = { ...item, status: 'pending' };
    Object.defineProperty(copy, 'id', { value: itemId, enumerable: true, writable: false, configurable: false });
    return copy;
  });
  const batch = { status: 'paused', reason: '', error: '', controller: null };
  Object.defineProperties(batch, {
    id: { value: id('tb'), enumerable: true },
    docId: { value: String(docId || ''), enumerable: true },
    sid: { value: String(sid || ''), enumerable: true },
    targetLang: { value: String(targetLang || '中文'), enumerable: true },
    items: { value: Object.freeze(copied), enumerable: true },
    running: { enumerable: true, get: () => !!batches.get(batch)?.run },
  });
  batches.set(batch, { run: null });
  return batch;
}

/** Stop the entire batch, including the gap between items. Completed items are retained.
 * `running` stays true until the in-flight runItem settles; resume is allowed afterwards.
 */
export function stopTranslationBatch(batch, reason = 'user') {
  const meta = metaOf(batch);
  if (batch.status === 'complete') return false;
  if (meta.run) {
    pause(meta.run, reason);
    notify(meta.run);
  } else {
    batch.status = 'paused';
    batch.reason = String(reason || 'user');
    if (batch.controller && !batch.controller.signal.aborted) batch.controller.abort(batch.reason);
  }
  return true;
}

/**
 * Run pending/failed/stopped items in order; complete items are never re-run.
 * runItem(item, { signal, batch }) must return { status: 'complete'|'failed'|'stopped' }.
 * isCurrent(batch) is a synchronous ownership predicate, checked before and after work.
 * The caller must also guard its own streaming writes with signal/ownership checks.
 * Re-invoke explicitly to resume. Concurrent invocations reject with TranslationBatchBusyError.
 */
export async function runTranslationBatch(batch, { runItem, isCurrent = () => true, onChange, concurrency = 1 } = {}) {
  const meta = metaOf(batch);
  if (typeof runItem !== 'function') throw new TypeError('runItem must be a function');
  if (typeof isCurrent !== 'function') throw new TypeError('isCurrent must be a function');
  if (meta.run) {
    const error = new Error('This translation batch is already running');
    error.name = 'TranslationBatchBusyError';
    throw error;
  }
  const run = { batch, controller: new AbortController(), onChange, items: new Set(), stopReason: '', failed: false };
  meta.run = run;
  batch.controller = run.controller;
  batch.status = 'running';
  batch.reason = '';
  batch.error = '';
  const current = () => {
    let matches = false;
    try { matches = !!isCurrent(batch); } catch { /* unavailable context is not a safe target */ }
    if (!matches) pause(run, 'context-changed');
    else if (run.controller.signal.aborted && !run.stopReason) pause(run, 'stopped');
    return matches && !run.controller.signal.aborted && !run.stopReason;
  };
  try {
    notify(run);
    if (!current()) return batch;
    let cursor = 0;
    const worker = async () => {
      while (cursor < batch.items.length && !run.failed) {
        const item = batch.items[cursor++];
        if (item.status === 'complete' || item.deleted) continue;
        if (!current()) break;
        run.items.add(item);
        item.status = 'running';
        delete item.error;
        notify(run);
        // onChange may synchronously stop or change the active document.
        if (!current()) { run.items.delete(item); break; }
        let result;
        try {
          result = await runItem(item, { signal: run.controller.signal, batch });
        } catch (error) {
          result = error?.name === 'AbortError'
            ? { status: 'stopped', reason: 'stopped' }
            : { status: 'failed', error: messageOf(error) };
        }
        if (!current()) {
          item.status = 'stopped';
          run.items.delete(item);
          break;
        }
        if (item.deleted) { item.status = 'deleted'; run.items.delete(item); notify(run); continue; }
        if (!['complete', 'failed', 'stopped'].includes(result?.status)) {
          result = { status: 'failed', error: 'Translation item returned an invalid status' };
        }
        item.status = result.status;
        run.items.delete(item);
        if (result.status === 'failed') {
          item.error = messageOf(result.error || result.message);
          batch.status = 'failed';
          batch.reason = 'item-failed';
          batch.error = item.error;
          run.failed = true;
          break;
        }
        if (result.status === 'stopped') {
          pause(run, result.reason || 'stopped');
          break;
        }
        notify(run);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, Math.trunc(Number(concurrency)) || 1)) }, worker));
    if (current() && batch.items.every((item) => item.status === 'complete' || item.deleted)) {
      batch.status = 'complete';
      batch.reason = '';
    }
    return batch;
  } finally {
    run.items.clear();
    if (meta.run === run) meta.run = null;
    notify(run);
  }
}
