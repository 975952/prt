/** Pure resource ownership checks: no server, user data, PDF files or models. */
import assert from 'node:assert/strict';
import { createPaperAccess } from '../public/js/paper-access.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const cancelled = signal => signal?.reason instanceof Error ? signal.reason : new DOMException('cancelled', 'AbortError');
const gate = (signal, control) => new Promise((resolve, reject) => {
  const stop = () => reject(cancelled(signal));
  signal?.addEventListener('abort', stop, { once: true });
  control.promise.then(value => { signal?.removeEventListener('abort', stop); resolve(value); }, reject);
  if (signal?.aborted) stop();
});
const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };

function fixture(options = {}) {
  const log = { opens: [], reads: [], images: [], destroyed: [], textAborts: [], imageAborts: [] };
  const access = createPaperAccess({ defaultTimeoutMs: 1000, idleMs: 0,
    openDocument: async (url, { signal }) => {
      log.opens.push(url);
      if (options.load) await options.load(url, signal);
      return {
        numPages: options.numPages || 320,
        async readPageText(page, { signal: workSignal }) {
          log.reads.push([url, page]);
          workSignal.addEventListener('abort', () => log.textAborts.push([url, page]), { once: true });
          return options.read ? options.read(url, page, workSignal) : `${url} page ${page} searchable text`;
        },
        async renderPageImage(page, { signal: workSignal }) {
          log.images.push([url, page]);
          workSignal.addEventListener('abort', () => log.imageAborts.push([url, page]), { once: true });
          if (options.image) await options.image(url, page, workSignal);
          return { page, numPages: options.numPages || 320, width: 40, height: 60, dataUrl: `fixture:${url}:${page}` };
        },
        destroy() { log.destroyed.push(url); },
      };
    }, ...options.cache });
  return { access, log };
}

{
  const { access, log } = fixture();
  assert.deepEqual(await access.info('/textbook'), { numPages: 320 });
  assert.deepEqual(log.reads, [], 'metadata never extracts every page');
  const page = await access.readPage('/textbook', 278);
  assert.equal(page.text, '/textbook page 278 searchable text');
  assert.deepEqual(log.reads, [['/textbook', 278]]);
  await access.readPage('/textbook', 278);
  assert.equal(log.reads.length, 1, 'completed page cache reused');
  assert.throws(() => access.readPage('/textbook', 0), RangeError);
  await assert.rejects(access.readPages('/textbook', { pages: [999] }), RangeError);
  assert.equal(log.reads.length, 1, 'invalid explicit page never falls back to full-book reading');
  const progress = [];
  const pages = await access.readPages('/textbook', { pages: [278, 279, 278], onProgress: p => progress.push(p) });
  assert.deepEqual(pages.pages.map(row => row.page), [278, 279]);
  assert.deepEqual(progress.map(p => p.scanned), [1, 2]);
  assert.deepEqual(log.opens, ['/textbook']);
  await access.clear();
  assert.deepEqual(log.destroyed, ['/textbook']);
  pass('explicit page 278 reads only that page; invalid pages reject and cache/progress remain correct');
}

{
  const control = deferred(), first = new AbortController(), second = new AbortController();
  const { access, log } = fixture({ read: (_, page, signal) => gate(signal, control).then(() => `page ${page}`) });
  const a = access.readPage('/shared', 278, { signal: first.signal });
  const aRejected = assert.rejects(a, { name: 'AbortError' });
  const b = access.readPage('/shared', 278, { signal: second.signal });
  await wait(0); first.abort(); await aRejected;
  assert.equal(log.opens.length, 1); assert.equal(log.reads.length, 1);
  assert.deepEqual(log.textAborts, [], 'one subscriber does not cancel a shared page');
  assert.deepEqual(log.destroyed, []);
  control.resolve(); assert.equal((await b).text, 'page 278');
  await access.clear();
  pass('in-flight deduplication retains another consumer when the first consumer cancels');
}

{
  const control = deferred();
  const { access, log } = fixture({ read: (_, page, signal) => gate(signal, control).then(() => `page ${page}`) });
  const short = access.readPage('/shared-timeout', 7, { timeoutMs: 15 });
  const rejected = assert.rejects(short, { name: 'TimeoutError' });
  const long = access.readPage('/shared-timeout', 7, { timeoutMs: 500 });
  await rejected;
  assert.deepEqual(log.textAborts, []); assert.deepEqual(log.destroyed, []);
  control.resolve(); await long;
  await access.clear();
  pass('each consumer has its own timeout without cancelling a longer shared read');
}

{
  const control = deferred(), controller = new AbortController();
  const { access, log } = fixture({ read: (_, page, signal) => gate(signal, control).then(() => `page ${page}`) });
  const pending = access.readPage('/cancelled', 3, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await wait(0); controller.abort(); await rejected; await wait(0);
  assert.deepEqual(log.textAborts, [['/cancelled', 3]]);
  assert.deepEqual(log.destroyed, ['/cancelled']);
  assert.equal(access.stats().documents, 0);
  control.resolve();
  assert.equal((await access.readPage('/cancelled', 3)).text, 'page 3');
  assert.equal(log.opens.length, 2, 'a cancelled cache entry is never reused');
  await access.clear();
  pass('last-consumer cancellation stops extraction, releases the handle and allows a clean retry');
}

{
  const load = deferred(), controller = new AbortController();
  const { access, log } = fixture({ load: () => load.promise });
  const pending = access.info('/late-load', { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await wait(0); controller.abort(); await rejected;
  load.resolve(); await wait(0);
  assert.deepEqual(log.destroyed, ['/late-load'], 'late loader resolution is destroyed exactly once');
  assert.equal(access.stats().documents, 0);
  assert.deepEqual(log.reads, []);
  pass('cancelled loading never leaks a PDF handle even when its loader resolves late');
}

{
  const { access, log } = fixture({ cache: { maxDocuments: 2, maxCachedPages: 2, maxTextChars: 60 } });
  await access.readPage('/a', 1); await access.readPage('/b', 1); await access.readPage('/c', 1); await wait(0);
  assert.equal(access.stats().documents, 2); assert.equal(access.stats().cachedPages, 2);
  assert(access.stats().cachedChars <= 60); assert(log.destroyed.includes('/a'));
  await access.readPage('/b', 2);
  assert.equal(access.stats().cachedPages, 2);
  const before = log.reads.length;
  await access.readPage('/b', 1); assert.equal(log.reads.length, before + 1, 'least-recently-used text is evicted');
  await access.release('/b');
  assert.equal(access.stats().cachedPages, 0, 'release drops all text for that paper');
  await access.clear(); await wait(0);
  assert.equal(access.stats().documents, 0);
  pass('document and page caches obey LRU bounds and explicit release clears cached resources');
}

{
  const blocked = deferred(), progress = [];
  const { access, log } = fixture({ numPages: 320,
    read: (_, page, signal) => page === 1 ? 'target found' : gate(signal, blocked) });
  const started = Date.now();
  const result = await access.search('/slow', 'target', { timeBudgetMs: 25, onProgress: p => progress.push(p) });
  assert(Date.now() - started < 300);
  assert.equal(result.scanned, 1); assert.equal(result.hits.length, 1);
  assert.equal(result.timedOut, true); assert.equal(result.truncated, true); assert.equal(result.complete, false);
  assert.deepEqual(progress.map(p => p.page), [1]);
  await wait(0); assert.deepEqual(log.textAborts, [['/slow', 2]]); assert.deepEqual(log.destroyed, ['/slow']);
  pass('search deadline interrupts a blocked page and reports partial results with progress');
}

{
  const controller = new AbortController();
  const { access, log } = fixture({ numPages: 3, read: () => 'target' });
  await assert.rejects(access.search('/abort-search', 'target', { signal: controller.signal,
    onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(log.reads.length, 1);
  const bounded = await access.search('/limit', 'target', { maxHits: 1 });
  assert.equal(bounded.scanned, 1); assert.equal(bounded.truncated, true);
  const full = await access.search('/complete', 'target', { maxHits: 5 });
  assert.equal(full.scanned, 3); assert.equal(full.complete, true); assert.equal(full.truncated, false);
  await access.clear();
  pass('search cancellation and hit limits stop inside the file; complete scans are explicitly identified');
}

{
  const { access } = fixture({ numPages: 3 });
  const asyncResult = await access.search('/async-match', 'target', { timeBudgetMs: 15, matchPage: () => new Promise(() => {}) });
  assert.equal(asyncResult.timedOut, true); assert.equal(asyncResult.scanned, 0);
  await access.readPages('/sync-match', { maxPages: 3 });
  const syncResult = await access.search('/sync-match', 'target', { timeBudgetMs: 5, matchPage: () => {
    const end = Date.now() + 12; while (Date.now() < end) { /* Simulate a synchronous matcher. */ }
    return null;
  } });
  assert.equal(syncResult.timedOut, true); assert.equal(syncResult.complete, false);
  await access.clear();
  pass('deadlines also cover asynchronous and synchronous matchers, including cached-page scans');
}

{
  const control = deferred(), controller = new AbortController();
  const { access, log } = fixture({ image: (_, __, signal) => gate(signal, control) });
  const first = access.renderPageImage('/scan', 278, { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = access.renderPageImage('/scan', 278);
  await wait(0); controller.abort(); await rejected;
  assert.equal(log.images.length, 1); assert.deepEqual(log.imageAborts, []);
  control.resolve(); assert.equal((await second).page, 278);
  assert.equal(access.stats().cachedPages, 0, 'large encoded images do not enter the text cache');
  await access.clear();
  pass('page images share in-flight rendering but isolate cancellation and avoid unbounded image caching');
}

{
  const control = deferred();
  const { access, log } = fixture({ read: (_, __, signal) => gate(signal, control) });
  const pending = access.readPage('/release-active', 1);
  await wait(0); await access.release('/release-active');
  assert.deepEqual(log.textAborts, []); assert.deepEqual(log.destroyed, []);
  control.resolve('finished normally'); await pending; await wait(0);
  assert.deepEqual(log.destroyed, ['/release-active']);
  assert.equal(access.stats().cachedPages, 0); assert.equal(access.stats().documents, 0);
  pass('explicit release waits for active consumers and does not repopulate an evicted cache');
}

{
  const { access, log } = fixture({ read: () => { throw new Error('broken PDF text stream'); } });
  await assert.rejects(access.readPage('/broken', 4), /broken PDF text stream/);
  assert.equal(access.stats().cachedPages, 0, 'read errors are not silently cached as scanned pages');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(access.readPage('/never-open', 1, { signal: controller.signal }), { name: 'AbortError' });
  assert(!log.opens.includes('/never-open'));
  await access.clear();
  pass('extraction failures stay explicit and an already-cancelled request never opens a PDF');
}

{
  const control = deferred(), destroyed = [], opens = [];
  const access = createPaperAccess({ idleMs: 0, openDocument: async url => {
    const version = opens.length + 1; opens.push(version);
    return { numPages: 2, readPageText: async () => {
      if (version === 1) await control.promise;
      return `version ${version}`;
    }, destroy: () => destroyed.push(version) };
  } });
  const old = access.readPage('/replaced-file', 1);
  await wait(0); await access.release('/replaced-file');
  assert.equal((await access.readPage('/replaced-file', 1)).text, 'version 2');
  assert.deepEqual(destroyed, [], 'retired active task may finish normally');
  control.resolve(); assert.equal((await old).text, 'version 1'); await wait(0);
  assert.deepEqual(destroyed, [1]);
  assert.equal((await access.readPage('/replaced-file', 1)).text, 'version 2', 'old completion must not repopulate the replacement cache');
  await access.clear(); assert.deepEqual(destroyed, [1, 2]);
  pass('invalidation isolates a replacement from an older active read at the same URL');
}

console.log(`PASS paper access: ${checks.length} checks`);
