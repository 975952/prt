/**
 * Offline PdfViewer visibility and load-ownership regressions.
 * Run: node test/viewer-visibility.mjs
 * Uses synthetic DOM/PDF objects only: no browser, service, files or user data.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PdfViewer } from '../public/js/pdfview.js';
import { disposePdfDocument } from '../public/js/pdf-lifecycle.js';

const viewerMethods = PdfViewer.prototype;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const fakePage = () => ({ style: { setProperty() {} }, classList: { toggle() {} }, offsetTop: 0, offsetHeight: 0 });
const hiddenViewer = () => ({
  pagesEl: { classList: { toggle() {} }, style: { setProperty() {} } }, container: { clientWidth: 0, clientHeight: 0, scrollTop: 640, scrollLeft: 71 },
  pdf: {}, baseSizes: [null, { width: 612, height: 792 }], numPages: 2, scale: 2, _fitMode: true,
  offsets: [null, 8, 1630], heights: [null, 1584, 1584], pageEls: [null, fakePage(), fakePage()],
  _sizeOf: () => ({ width: 612, height: 792 }),
  _rowStartOf: n => n,
  _captureAnchor() { throw new Error('Hidden layout captured a zero-sized anchor'); },
  _restoreAnchor() { throw new Error('Hidden layout changed the scroll position'); },
  _computeFitScale() { throw new Error('Hidden fit calculated a zero-width scale'); },
});
const loadingViewer = () => ({
  _gen: 5, _destroyed: false, opts: {},
  container: { scrollTop: 0, querySelectorAll: () => [], append() {} },
  close() { this._gen++; this.pdf = null; },
  _applyTwoUpClass() {}, _buildPageEls() {}, layout() {},
  _renderVisible: async () => {}, _handleScroll() {}, _schedulePrefetch() {},
});
const cachedPdf = () => ({ numPages: 1, destroyed: 0, destroy() { this.destroyed++; } });
const handle = pdf => ({
  pdf, numPages: 1, baseSizes: [null, { width: 612, height: 792 }],
  scale: 1.5, page: 1, scrollTop: 210,
});

// Execute the actual production load method with only its PDF.js initialization
// dependency replaced. This lets the test control the two await boundaries
// without importing the vendor runtime, downloading PDFs or copying the method.
const loadWith = initPdfjs => {
  const source = viewerMethods.load.toString();
  assert.match(source, /^async load\(/, 'PdfViewer.load is an async method');
  return Function('initPdfjs', 'disposePdfDocument', `return (${source.replace(/^async load\(/, 'async function(')});`)(initPdfjs, disposePdfDocument);
};

await test('hidden ready document retains scale, geometry and scroll', () => {
  const viewer = hiddenViewer();
  const offsets = viewer.offsets, heights = viewer.heights;
  viewerMethods.layout.call(viewer, { keepAnchor: true });
  viewerMethods.fitWidth.call(viewer);
  assert.equal(viewer.offsets, offsets);
  assert.equal(viewer.heights, heights);
  assert.equal(viewer.scale, 2);
  assert.equal(viewer._fitMode, true);
  assert.equal(viewer.container.scrollTop, 640);
  assert.equal(viewer.container.scrollLeft, 71);
});

await test('initial hidden load still initializes PDF page dimensions', () => {
  const viewer = hiddenViewer();
  viewer.offsets = []; viewer.heights = [];
  viewerMethods.layout.call(viewer);
  for (const page of viewer.pageEls.slice(1)) {
    assert.equal(page.style.width, '1224px');
    assert.equal(page.style.height, '1584px');
  }
});

await test('visible layout measures valid page positions again', () => {
  const viewer = hiddenViewer();
  viewer.container.clientWidth = 800; viewer.container.clientHeight = 600;
  viewer.pageEls[1].offsetTop = 8; viewer.pageEls[1].offsetHeight = 1584;
  viewer.pageEls[2].offsetTop = 1630; viewer.pageEls[2].offsetHeight = 1584;
  viewerMethods.layout.call(viewer);
  assert.deepEqual(viewer.offsets.slice(1), [8, 1630]);
  assert.deepEqual(viewer.heights.slice(1), [1584, 1584]);
});

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
globalThis.document = { createElement: () => ({ className: '' }) };
try {
  await test('cached attach invalidates old loading without destroying its PDF', async () => {
    const viewer = loadingViewer(), pdf = cachedPdf(), before = viewer._gen;
    const result = await viewerMethods.attach.call(viewer, handle(pdf));
    assert.equal(result.hot, true);
    assert.ok(viewer._gen > before);
    assert.equal(viewer.pdf, pdf);
    assert.equal(pdf.destroyed, 0);
    assert.equal(viewer.container.scrollTop, 210);
  });

  await test('late first-page measurement cannot overwrite a newer attachment', { timeout: 5000 }, async () => {
    const viewer = loadingViewer(), pdf = cachedPdf(), firstPage = deferred();
    const pending = viewerMethods.attach.call(viewer, {
      pdf: { numPages: 1, getPage: () => firstPage.promise }, numPages: 1, baseSizes: [],
    });
    await viewerMethods.attach.call(viewer, handle(pdf));
    const pages = viewer.pagesEl, sizes = viewer.baseSizes;
    firstPage.resolve({ getViewport: () => ({ width: 999, height: 999 }) });
    assert.equal((await pending).stale, true);
    assert.equal(viewer.pdf, pdf);
    assert.equal(viewer.pagesEl, pages);
    assert.equal(viewer.baseSizes, sizes);
    assert.equal(pdf.destroyed, 0);
  });

  await test('superseded initialization never starts an obsolete PDF request', { timeout: 5000 }, async () => {
    const viewer = loadingViewer(), pdf = cachedPdf(), initialization = deferred();
    let created = 0;
    const pending = loadWith(() => initialization.promise).call(viewer, '/pending.pdf');
    await viewerMethods.attach.call(viewer, handle(pdf));
    initialization.resolve({ getDocument() { created++; throw new Error('Obsolete PDF request started'); } });
    assert.equal((await pending).stale, true);
    assert.equal(created, 0);
    assert.equal(viewer.pdf, pdf);
    assert.equal(pdf.destroyed, 0);
  });

  await test('late PDF response cannot replace or destroy the cached document', { timeout: 5000 }, async () => {
    const viewer = loadingViewer(), pdf = cachedPdf(), obsoletePdf = cachedPdf();
    const response = deferred(), started = deferred();
    const load = loadWith(async () => ({ getDocument() { started.resolve(); return { promise: response.promise }; } }));
    const pending = load.call(viewer, '/late.pdf');
    await started.promise;
    await viewerMethods.attach.call(viewer, handle(pdf));
    response.resolve(obsoletePdf);
    assert.equal((await pending).stale, true);
    assert.equal(viewer.pdf, pdf);
    assert.equal(obsoletePdf.destroyed, 1);
    assert.equal(pdf.destroyed, 0);
  });
} finally {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
}
