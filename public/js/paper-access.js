/** Shared, bounded access to PDF resources. The adapter owns PDF.js; this
 * module owns consumers, deadlines, page caches and independent cancellation. */
const errorWithName = (name, message) => Object.assign(new Error(message), { name });
const deadlines = new WeakMap();
const aborted = signal => signal?.reason instanceof Error ? signal.reason
  : errorWithName('AbortError', 'PDF access cancelled');
const checkSignal = signal => {
  const deadline = signal && deadlines.get(signal);
  if (!signal?.aborted && deadline && Date.now() >= deadline.at) {
    deadline.controller.abort(errorWithName('TimeoutError', 'PDF access timed out'));
  }
  if (signal?.aborted) throw aborted(signal);
};

function operationScope(signal, timeoutMs) {
  const controller = new AbortController();
  const forward = () => controller.abort(aborted(signal));
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  const ms = Number(timeoutMs);
  if (Number.isFinite(ms) && ms > 0) deadlines.set(controller.signal, { controller, at: Date.now() + ms });
  const timer = Number.isFinite(ms) && ms > 0 ? setTimeout(() => {
    controller.abort(errorWithName('TimeoutError', 'PDF access timed out'));
  }, ms) : null;
  return { signal: controller.signal, dispose() {
    if (timer !== null) clearTimeout(timer);
    deadlines.delete(controller.signal);
    signal?.removeEventListener('abort', forward);
  } };
}

function sharedWork(work) {
  const task = { controller: new AbortController(), consumers: new Set(), settled: false };
  task.promise = Promise.resolve().then(() => {
    checkSignal(task.controller.signal);
    return work(task.controller.signal);
  }).then(value => { task.settled = true; return value; }, error => { task.settled = true; throw error; });
  // Every consumer may leave before a worker rejects; keep that rejection handled.
  task.promise.catch(() => {});
  return task;
}

function consume(task, signal) {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const token = {};
    task.consumers.add(token);
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', cancel);
      task.consumers.delete(token);
      fn(value);
    };
    const cancel = () => {
      finish(reject, aborted(signal));
      if (!task.settled && !task.consumers.size) task.controller.abort(aborted(signal));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    task.promise.then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) cancel();
  });
}

function pageNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new RangeError('PDF page must be a positive integer');
  return n;
}

function defaultMatch(row, query) {
  const q = String(query || '').trim().toLowerCase(), lower = row.text.toLowerCase();
  if (!q) return null;
  let at = lower.indexOf(q), length = q.length;
  if (at < 0) {
    const terms = q.split(/\s+/).filter(Boolean), indexes = terms.map(term => lower.indexOf(term));
    if (!indexes.length || indexes.some(index => index < 0)) return null;
    at = Math.min(...indexes); length = Math.max(...terms.map(term => term.length));
  }
  return { page: row.page, at, length, snippet: row.text.slice(Math.max(0, at - 100), at + length + 240) };
}

/** openDocument(url,{signal}) returns {numPages,readPageText(page,{signal}),
 * renderPageImage(page,options),destroy()}. Resource methods must not refer to
 * the visible document. Active leases may exceed maxDocuments; idle retained
 * documents and cached text are bounded, and cancelled last leases release. */
export function createPaperAccess({ openDocument, maxDocuments = 4, maxCachedPages = 240,
  maxTextChars = 2_000_000, idleMs = 60_000, defaultTimeoutMs = 30_000 } = {}) {
  if (typeof openDocument !== 'function') throw new TypeError('openDocument is required');
  const documents = new Map(), textCache = new Map();
  const documentLimit = Math.max(0, Number(maxDocuments) || 0);
  const pageLimit = Math.max(0, Number(maxCachedPages) || 0);
  const charLimit = Math.max(0, Number(maxTextChars) || 0);
  let cacheChars = 0, clock = 0;
  const cacheKey = (url, page) => JSON.stringify([url, page]);
  const normalizeUrl = url => { const key = String(url || ''); if (!key) throw new TypeError('PDF URL is required'); return key; };

  function dropCached(key) {
    const row = textCache.get(key);
    if (row) { cacheChars -= row.value.text.length; textCache.delete(key); }
  }
  function cacheText(url, value) {
    if (!pageLimit || value.text.length > charLimit) return;
    const key = cacheKey(url, value.page);
    dropCached(key);
    textCache.set(key, { url, value: Object.freeze({ ...value }) });
    cacheChars += value.text.length;
    while (textCache.size > pageLimit || cacheChars > charLimit) dropCached(textCache.keys().next().value);
  }
  function cachedText(url, page) {
    const key = cacheKey(url, page), row = textCache.get(key);
    if (!row) return null;
    textCache.delete(key); textCache.set(key, row);
    return { ...row.value };
  }
  function destroyResource(resource) { return Promise.resolve().then(() => resource?.destroy?.()).catch(() => {}); }
  function dropDocument(entry) {
    if (entry.disposed) return entry.destroying || Promise.resolve();
    entry.disposed = true;
    clearTimeout(entry.idleTimer);
    if (documents.get(entry.url) === entry) documents.delete(entry.url);
    entry.opening?.controller.abort(errorWithName('AbortError', 'PDF resource released'));
    for (const task of entry.work.values()) task.controller.abort(errorWithName('AbortError', 'PDF resource released'));
    entry.work.clear();
    entry.destroying = destroyResource(entry.resource);
    return entry.destroying;
  }
  function prune() {
    const idle = [...documents.values()].filter(entry => !entry.users).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle) {
      if (documents.size <= documentLimit) break;
      void dropDocument(entry);
    }
  }
  function getDocument(url) {
    let entry = documents.get(url);
    // Invalidation retires an active handle for its existing consumers. A new
    // request must open a new version instead of joining that retired handle.
    if (entry?.releasePending) {
      if (documents.get(url) === entry) documents.delete(url);
      if (!entry.users) void dropDocument(entry);
      entry = null;
    }
    if (entry && (!entry.resource && entry.opening.controller.signal.aborted)) { void dropDocument(entry); entry = null; }
    if (!entry) {
      entry = { url, users: 0, lastUsed: ++clock, work: new Map(), resource: null, disposed: false, releasePending: false };
      entry.opening = sharedWork(async signal => {
        const resource = await openDocument(url, { signal });
        if (entry.disposed || signal.aborted) { await destroyResource(resource); throw aborted(signal); }
        if (!Number.isInteger(resource?.numPages) || resource.numPages < 1) {
          await destroyResource(resource); throw new Error('PDF has no readable pages');
        }
        entry.resource = resource;
        return resource;
      });
      documents.set(url, entry);
    }
    clearTimeout(entry.idleTimer);
    entry.users++; entry.lastUsed = ++clock;
    return entry;
  }
  async function withDocument(url, signal, fn) {
    checkSignal(signal);
    const entry = getDocument(url);
    try {
      const resource = entry.resource || await consume(entry.opening, signal);
      checkSignal(signal);
      return await fn(entry, resource);
    } finally {
      entry.users--; entry.lastUsed = ++clock;
      if (!entry.users) {
        if (signal?.aborted || entry.releasePending || !entry.resource) void dropDocument(entry);
        else if (idleMs > 0) {
          entry.idleTimer = setTimeout(() => { if (!entry.users) void dropDocument(entry); }, idleMs);
          entry.idleTimer.unref?.();
        }
      }
      prune();
    }
  }
  function sharedPage(entry, key, work, signal) {
    let task = entry.work.get(key);
    if (!task || task.controller.signal.aborted) {
      task = sharedWork(work);
      entry.work.set(key, task);
      const remove = () => { if (entry.work.get(key) === task) entry.work.delete(key); };
      task.promise.then(remove, remove);
    }
    return consume(task, signal);
  }
  async function textPage(entry, resource, n, signal) {
    checkSignal(signal);
    if (n > resource.numPages) throw new RangeError(`PDF page ${n} is outside 1–${resource.numPages}`);
    const cached = cachedText(entry.url, n);
    if (cached) return cached;
    return sharedPage(entry, `text:${n}`, async workSignal => {
      const text = await resource.readPageText(n, { signal: workSignal });
      checkSignal(workSignal);
      const value = { page: n, text: String(text || ''), numPages: resource.numPages };
      if (!entry.disposed && !entry.releasePending) cacheText(entry.url, value);
      return value;
    }, signal);
  }
  async function scoped(options, fn) {
    const scope = operationScope(options?.signal, options?.timeoutMs ?? defaultTimeoutMs);
    try {
      checkSignal(scope.signal);
      const result = await fn(scope.signal);
      checkSignal(scope.signal);
      return result;
    }
    finally { scope.dispose(); }
  }

  return {
    info(url, options = {}) {
      const key = normalizeUrl(url);
      return scoped(options, signal => withDocument(key, signal, (_, resource) => ({ numPages: resource.numPages })));
    },
    readPage(url, page, options = {}) {
      const key = normalizeUrl(url), n = pageNumber(page);
      return scoped(options, async signal => {
        const cached = cachedText(key, n);
        if (cached) return cached;
        return withDocument(key, signal, (entry, resource) => textPage(entry, resource, n, signal));
      });
    },
    readPages(url, options = {}) {
      const key = normalizeUrl(url);
      return scoped(options, signal => withDocument(key, signal, async (entry, resource) => {
        const wanted = Array.isArray(options.pages) && options.pages.length
          ? [...new Set(options.pages.map(pageNumber))]
          : Array.from({ length: Math.min(resource.numPages, Math.max(0, Math.floor(Number(options.maxPages ?? 30) || 0))) }, (_, i) => i + 1);
        if (wanted.some(n => n > resource.numPages)) throw new RangeError(`PDF page is outside 1–${resource.numPages}`);
        const pages = [];
        for (const n of wanted) {
          checkSignal(signal);
          pages.push(await textPage(entry, resource, n, signal));
          options.onProgress?.({ page: n, scanned: pages.length, total: wanted.length, numPages: resource.numPages });
          checkSignal(signal);
        }
        return { numPages: resource.numPages, pages };
      }));
    },
    async search(url, query, options = {}) {
      const key = normalizeUrl(url), q = String(query || '').trim();
      if (!q) throw new TypeError('PDF search query is required');
      const scope = operationScope(options.signal, options.timeBudgetMs ?? options.timeoutMs ?? defaultTimeoutMs);
      const result = { numPages: 0, scanned: 0, hits: [], truncated: false, complete: false };
      const maxHits = Math.max(1, Math.floor(Number(options.maxHits) || 120));
      const matcher = typeof options.matchPage === 'function' ? options.matchPage : defaultMatch;
      try {
        await withDocument(key, scope.signal, async (entry, resource) => {
          result.numPages = resource.numPages;
          const total = Math.min(resource.numPages, Math.max(0, Math.floor(Number(options.maxPages ?? resource.numPages))));
          for (let n = 1; n <= total; n++) {
            checkSignal(scope.signal);
            const row = await textPage(entry, resource, n, scope.signal);
            // An asynchronous matcher obeys the same deadline as PDF extraction.
            const matches = await consume(sharedWork(() => matcher(row, q)), scope.signal);
            checkSignal(scope.signal);
            const hits = Array.isArray(matches) ? matches : matches ? [matches] : [];
            result.scanned++;
            const available = maxHits - result.hits.length;
            result.hits.push(...hits.slice(0, available));
            options.onProgress?.({ page: n, scanned: result.scanned, numPages: resource.numPages, hits: result.hits.length });
            checkSignal(scope.signal);
            if (hits.length > available || (result.hits.length >= maxHits && n < resource.numPages)) { result.truncated = true; break; }
          }
          result.truncated ||= result.scanned < resource.numPages;
          result.complete = !result.truncated;
        });
      } catch (error) {
        if (options.signal?.aborted || error?.name !== 'TimeoutError') throw error;
        result.truncated = true; result.timedOut = true;
      } finally { scope.dispose(); }
      return result;
    },
    renderPageImage(url, page, options = {}) {
      const key = normalizeUrl(url), n = pageNumber(page);
      return scoped(options, signal => withDocument(key, signal, (entry, resource) => {
        if (n > resource.numPages) throw new RangeError(`PDF page ${n} is outside 1–${resource.numPages}`);
        const maxDim = Number(options.maxDim) || 1400, quality = Number(options.quality) || .82;
        return sharedPage(entry, `image:${n}:${maxDim}:${quality}`, workSignal => resource.renderPageImage(n,
          { ...options, maxDim, quality, signal: workSignal }), signal);
      }));
    },
    async release(url) {
      const key = normalizeUrl(url), entry = documents.get(key);
      for (const [id, row] of textCache) if (row.url === key) dropCached(id);
      if (!entry) return;
      entry.releasePending = true;
      if (!entry.users) await dropDocument(entry);
    },
    async clear() {
      textCache.clear(); cacheChars = 0;
      await Promise.all([...documents.values()].map(entry => {
        entry.releasePending = true;
        return entry.users ? undefined : dropDocument(entry);
      }));
    },
    stats() {
      return { documents: documents.size, activeDocuments: [...documents.values()].filter(entry => entry.users > 0).length,
        cachedPages: textCache.size, cachedChars: cacheChars,
        inFlightPages: [...documents.values()].reduce((sum, entry) => sum + entry.work.size, 0) };
    },
  };
}
