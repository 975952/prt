import { paperAccess } from './pdfview.js';

/** A question's reader is independent of whichever PDF is currently on screen. */
export async function createLibraryReader(paper, { signal, page = 1, timeoutMs = 30000, access = paperAccess } = {}) {
  const source = Object.freeze({ ...paper });
  // Per-tool cancellation may narrow a task, but can never detach a read from
  // the owning conversation's cancellation signal.
  const run = async (extra, operation) => {
    const controller = new AbortController(), listeners = [];
    for (const parent of new Set([signal, extra?.signal].filter(Boolean))) {
      const stop = () => controller.abort(parent.reason);
      if (parent.aborted) stop();
      else { parent.addEventListener('abort', stop, { once: true }); listeners.push([parent, stop]); }
    }
    try { return await operation({ timeoutMs, ...extra, signal: controller.signal }); }
    finally { for (const [parent, stop] of listeners) parent.removeEventListener('abort', stop); }
  };
  const info = await run(null, options => access.info(source.url, options));
  if (!Number.isInteger(page) || page < 1 || page > info.numPages) {
    throw new RangeError(`《${source.path || source.name}》PDF 页码 ${page} 超出范围（1–${info.numPages}）`);
  }
  return {
    pdf: Object.freeze({ source: source.docId }), sourcePaper: source, numPages: info.numPages,
    current: page, currentVisiblePage: () => page,
    async getPageText(n, extra) { return (await run(extra, options => access.readPage(source.url, n, options))).text; },
    async getContextAround(n, _anchor, extra) { return (await run(extra, options => access.readPage(source.url, n, options))).text; },
    async capturePageImage(n, extra) { return run(extra, options => access.renderPageImage(source.url, n, options)); },
    async scanDocProfile(extra) {
      const row = await run(extra, options => access.readPage(source.url, page, options));
      return { numPages: info.numPages, scanned: String(row.text).trim().length < 40 };
    },
    async getAllText(onProgress, extra) {
      const result = await run(extra, options => access.readPages(source.url, { maxPages: info.numPages,
        onProgress: status => onProgress?.(status.scanned, status.numPages), ...options }));
      return result.pages.map(row => `===== p.${row.page} =====\n${row.text}`).join('\n\n');
    },
  };
}
