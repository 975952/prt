import { runWithDeadline } from './task-deadline.js';
import { t as tr } from './i18n.js';

const disposals = new WeakMap();
const shutdownError = () => Object.assign(new Error('PDF document was closed'), { name: 'AbortException' });

/** PDF.js 6.3.289 can leave GetTextContent tasks awaiting a stream after
 * Terminate. Its public destroy then waits forever before cancelling requests.
 * This fallback is deliberately restricted to that bundled version and an
 * exclusively owned real Worker. Unknown implementations fail closed. */
function finishOwnedWorker(task, pdf) {
  const transport = task._transport, worker = task._worker, handler = transport?.messageHandler;
  if (globalThis.pdfjsLib?.version !== '6.3.289' || !transport || !transport.destroyed
    || transport.loadingTask !== task || (pdf && pdf._transport !== transport)
    || typeof globalThis.Worker !== 'function' || !(worker?.port instanceof globalThis.Worker)
    || handler?.comObj !== worker.port || typeof worker.destroy !== 'function'
    || typeof handler.destroy !== 'function' || !handler.streamSinks || !handler.streamControllers
    || !handler.callbackCapabilities || typeof handler.actionHandler?.GetRangeReader !== 'function'
    || typeof transport.commonObjs?.clear !== 'function' || typeof transport.fontLoader?.clear !== 'function'
    || typeof transport.filterFactory?.destroy !== 'function') {
    throw new Error(tr('无法安全停止 PDF 读取，原文件已保留，请重新打开后重试'));
  }
  const reason = shutdownError();
  // These are the vendor's actual GetReader/GetRangeReader closures. Cancelling
  // them aborts fetch, rather than merely setting the loading task's flag.
  for (const sink of Object.values(handler.streamSinks)) {
    if (!sink.isCancelled && typeof sink.onCancel !== 'function') throw new Error(tr('无法安全取消 PDF 请求，原文件已保留'));
  }
  handler.actionHandler.GetReader = handler.actionHandler.GetRangeReader = (_data, sink) => sink.error(reason);
  for (const sink of Object.values(handler.streamSinks)) {
    if (!sink.isCancelled) {
      Promise.resolve(sink.onCancel(reason)).catch(() => {});
      sink.error(reason);
    }
  }
  // Stop delivery before terminating so late worker messages cannot allocate a
  // new HTTP reader. PDFWorker.destroy() calls the owned Worker.terminate().
  handler.destroy();
  worker.destroy();
  if (!worker.destroyed || worker.port) throw new Error(tr('PDF 读取尚未停止，原文件已保留'));
  // Reject pending consumers so detached renders and scans release their
  // closures instead of retaining a never-settling Terminate/text promise.
  for (const state of Object.values(handler.streamControllers)) {
    for (const key of ['startCall', 'pullCall', 'cancelCall']) {
      const capability = state[key];
      if (capability) { capability.promise.catch(() => {}); capability.reject(reason); }
    }
    try { if (!state.isClosed) state.controller.error(reason); } catch { /* already closed */ }
  }
  for (const capability of Object.values(handler.callbackCapabilities)) {
    capability.promise.catch(() => {}); capability.reject(reason);
  }
  transport.destroyCapability?.promise.catch(() => {});
  transport.destroyCapability?.reject(reason);
  transport.commonObjs.clear();
  transport.fontLoader.clear();
  transport.filterFactory.destroy();
  globalThis.pdfjsLib.TextLayer?.cleanup();
  handler.streamSinks = Object.create(null);
  handler.streamControllers = Object.create(null);
  handler.callbackCapabilities = Object.create(null);
  transport.messageHandler = null;
  task._transport = null;
  task._worker = null;
  return { forced: true };
}

/** Accept a loaded PDFDocumentProxy or an unfinished PDFDocumentLoadingTask.
 * Call only after detaching UI and ensuring no active chat owns the document.
 * Mutating callers must await success; a timeout on an unknown API is an error. */
export function disposePdfDocument(value, { timeoutMs = 1500 } = {}) {
  if (!value) return Promise.resolve({ forced: false });
  const pdf = value.loadingTask ? value : null;
  const task = pdf ? pdf.loadingTask : value;
  if (!task || typeof task.destroy !== 'function') return Promise.reject(new Error(tr('无法安全停止 PDF 读取，原文件已保留，请重新打开后重试')));
  if (disposals.has(task)) return disposals.get(task);
  const disposal = (async () => {
    try {
      const duration = Number(timeoutMs);
      await runWithDeadline(() => task.destroy(), { timeoutMs: Number.isFinite(duration) && duration > 0 ? Math.min(duration, 10000) : 1500 });
      return { forced: false };
    } catch (error) {
      // An already completed disposal is safe even if a duplicate vendor call
      // rejected while observing the same terminated worker.
      if (task.destroyed && task._transport === null && task._worker === null) return { forced: false };
      return finishOwnedWorker(task, pdf);
    }
  })();
  disposals.set(task, disposal);
  return disposal;
}
