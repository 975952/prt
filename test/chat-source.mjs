/** The task reader owns its source and its parent's cancellation throughout. */
import assert from 'node:assert/strict';
import { createLibraryReader } from '../public/js/chat-source.js';
import { createPaperAccess } from '../public/js/paper-access.js';

const calls = [];
const access = createPaperAccess({ idleMs: 0, openDocument: async url => ({ numPages: 300,
  readPageText: async (page, { signal }) => {
    calls.push([url, page]);
    if (page === 299) return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    });
    return `This is sufficient searchable text from ${url} page ${page}.`;
  },
  renderPageImage: async page => ({ page, dataUrl: `${url}#${page}` }), destroy() {},
}) });
const paper = { docId: 'book', name: 'textbook.pdf', path: 'course/textbook.pdf', url: '/textbook' };
const task = new AbortController();
const reader = await createLibraryReader(paper, { signal: task.signal, page: 278, access });
paper.url = '/different-file'; paper.path = 'other.pdf';
assert.match(await reader.getPageText(278), /\/textbook page 278/);
assert.equal(reader.sourcePaper.path, 'course/textbook.pdf');
assert.deepEqual(calls, [['/textbook', 278]]);
assert.equal((await reader.capturePageImage(278)).dataUrl, '/textbook#278');
assert.equal((await reader.scanDocProfile()).scanned, false);
console.log('PASS task reader snapshots source identity and reads only requested pages');

const tool = new AbortController();
const pending = reader.getPageText(299, { signal: tool.signal });
const rejected = assert.rejects(pending, { name: 'AbortError' });
task.abort(); await rejected;
assert.equal(tool.signal.aborted, false, 'cancelling the owner does not mutate another controller');
await assert.rejects(reader.getPageText(278, { signal: new AbortController().signal }), { name: 'AbortError' });
console.log('PASS a tool signal cannot override the owning conversation cancellation');

const otherTask = new AbortController();
const other = await createLibraryReader({ ...paper, url: '/other' }, { signal: otherTask.signal, page: 278, access });
assert.match(await other.getPageText(278), /\/other page 278/);
await assert.rejects(createLibraryReader({ ...paper, url: '/other' }, { page: 301, access }), RangeError);
await access.clear();
console.log('PASS cancelling one task leaves another file independent and invalid pages fail explicitly');
