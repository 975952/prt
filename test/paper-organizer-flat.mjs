import assert from 'node:assert/strict';
import { groupPaperCollection, parsePaperGroups } from '../public/js/paper-classifier.js';
const papers = ['Vision networks.pdf', 'Circuit design.pdf', '1234.pdf', '5678.pdf']
  .map((name, i) => ({ id: String(i), name, title: 'STALE TITLE', path: `STALE FOLDER/${name}`, url: `/${i}` }));
const input = messages => JSON.parse(Array.isArray(messages.at(-1).content) ? messages.at(-1).content[0].text : messages.at(-1).content);
const answer = value => JSON.stringify(value);
const initial = { groups: [{ folder: 'Vision', papers: [1] }, { folder: 'Electronics', papers: [2] }], unknown: [3, 4] };
let checks = 0;
async function check(name, fn) { await fn(); console.log(`PASS ${name}`); checks++; }
await check('names and current folders classify without opening PDFs or sending stale titles', async () => {
  let calls = 0;
  const result = await groupPaperCollection({ papers: papers.slice(0, 2), readFirstPage: () => { throw Error('must not read'); }, chat: async ({ messages }) => {
    calls++; assert.ok(!JSON.stringify(messages).includes('STALE TITLE')); const payload = input(messages);
    assert.deepEqual(payload.papers, papers.slice(0, 2).map((p, i) => ({ index: i + 1, name: p.name, currentFolder: 'STALE FOLDER' })));
    return answer({ groups: [{ folder: 'Research', papers: [2, 1] }], unknown: [] });
  } });
  assert.equal(calls, 1); assert.deepEqual(result.groups[0].ids, ['1', '0']);
});
await check('only unknown names read page one; usable text avoids images, scans use images, then regroup all', async () => {
  const reads = [], images = [], updates = [], requests = [];
  const result = await groupPaperCollection({ papers, onUpdate: r => updates.push(r),
    readFirstPage: async paper => {
      reads.push(paper.id);
      return { text: paper.id === '2' ? 'Synthetic first page: vision recognition methods.' : '',
        getImage: async () => { images.push(paper.id); return { dataUrl: 'data:image/jpeg;base64,TEST' }; } };
    }, chat: async ({ messages }) => {
      const payload = input(messages); requests.push(payload);
      if (payload.task === 'first-page') {
        assert.equal(Array.isArray(messages.at(-1).content), payload.name === '5678.pdf');
        return answer({ evidence: payload.name === '1234.pdf' ? 'Vision recognition' : 'Electronic circuits' });
      }
      if (!payload.papers.some(p => p.evidence)) return answer(initial);
      assert.deepEqual(payload.papers.map(p => p.evidence || ''), ['', '', 'Synthetic first page: vision recognition methods.', 'Electronic circuits']);
      return answer({ groups: [{ folder: 'Vision', papers: [3, 1] }, { folder: 'Electronics', papers: [2, 4] }], unknown: [] });
    } });
  assert.deepEqual(reads, ['2', '3']); assert.deepEqual(images, ['3']);
  assert.deepEqual(requests.map(r => r.task), ['group', 'first-page', 'group']);
  assert.equal(updates.length, 2); assert.equal(result.unknown.length, 0);
  assert.deepEqual(result.groups[0].ids, ['2', '0']);
});
await check('inconclusive extracted text falls back to an image; one broken PDF does not lose other groups', async () => {
  let images = 0, grouping = 0;
  const result = await groupPaperCollection({ papers,
    readFirstPage: async paper => {
      if (paper.id === '3') throw Error('broken PDF');
      return { text: 'Unhelpful publisher text with no title', getImage: async () => { images++; return { dataUrl: 'data:image/png;base64,TEST' }; } };
    }, chat: async ({ messages }) => {
      const payload = input(messages);
      if (payload.task === 'group') return answer(++grouping <= 2 ? initial
        : { groups: [{ folder: 'New unified research', papers: [1, 2, 3] }], unknown: [4] });
      return answer({ evidence: Array.isArray(messages.at(-1).content) ? 'Vision models' : '' });
    } });
  assert.equal(images, 1); assert.deepEqual(result.unknown, ['3']); assert.ok(result.errors.has('3'));
  assert.deepEqual(result.groups.map(g => g.folder), ['New unified research']);
});
await check('malformed, nested, duplicate and incomplete outputs never become moves', () => {
  for (const value of [
    { groups: [{ folder: 'A/B', papers: [1, 2, 3, 4] }], unknown: [] },
    { groups: [{ folder: 'A\\B', papers: [1, 2, 3, 4] }], unknown: [] },
    { groups: [{ folder: 'A', papers: [1, 1, 3, 4] }], unknown: [] },
    { groups: [{ folder: 'A', papers: [1, 2, 3] }], unknown: [] },
    { groups: [{ folder: 'A', papers: [1, 2, 3, 5] }], unknown: [] },
    { groups: [{ folder: 'A', papers: [1, 2] }, { folder: 'a', papers: [3, 4] }], unknown: [] },
    { groups: [{ folder: 'CON', papers: [1, 2, 3, 4] }], unknown: [] },
  ]) assert.throws(() => parsePaperGroups(answer(value), papers));
});
await check('cancel during first-page reading aborts work and never accepts late output', async () => {
  const controller = new AbortController(); let finishRead, updates = 0, reads = 0;
  const work = groupPaperCollection({ papers, signal: controller.signal, onUpdate: () => updates++, chat: async () => answer(initial),
    readFirstPage: () => { reads++; return new Promise(resolve => { finishRead = resolve; }); } });
  while (!finishRead) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort(); await assert.rejects(work, { name: 'AbortError' });
  finishRead({ text: 'late text' }); await Promise.resolve(); assert.equal(reads, 1); assert.equal(updates, 1);
});
await check('model timeout keeps the initial accepted preview and stops regrouping', async () => {
  let updates = 0, calls = 0;
  const work = groupPaperCollection({ papers, timeoutMs: 15, onUpdate: () => updates++,
    readFirstPage: async () => ({ text: 'Clear first-page text describing circuits' }),
    chat: async ({ messages }) => {
      calls++; const payload = input(messages);
      if (payload.task === 'first-page') return answer({ evidence: 'Circuits' });
      if (calls === 1) return answer(initial);
      return new Promise(() => {});
    } });
  await assert.rejects(work, { name: 'TimeoutError' }); assert.equal(updates, 1);
});
console.log(`PASS ${checks} filename-first classification checks; no real model requests`);
await check('already organized files stay put, including existing nested folders, without page reads', async () => {
  const result = await groupPaperCollection({ papers, readFirstPage: () => { throw Error('must not read kept papers'); },
    chat: async ({ messages }) => {
      assert.ok(input(messages).papers.every(p => p.currentFolder === 'STALE FOLDER'));
      return answer({ groups: [{ folder: 'New topic', papers: [2] }], keep: [1, 3, 4], unknown: [] });
    } });
  assert.deepEqual(result.keep, ['0', '2', '3']); assert.deepEqual(result.groups[0].ids, ['1']);
  assert.throws(() => parsePaperGroups(answer({ ...initial, keep: [1] }), papers));
  assert.throws(() => parsePaperGroups(answer({ groups: [], keep: [1, 2, 3, 5], unknown: [] }), papers));
  assert.throws(() => parsePaperGroups(answer({ groups: [], keep: 'all', unknown: [] }), papers));
});
