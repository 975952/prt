import assert from 'node:assert/strict';
import { numericPaperName, cleanPaperTitle, firstPageTitle, createPaperTitleIndex } from '../public/js/paper-titles.js';
for (const name of ['1706.03762.pdf', '2101.11986v2.pdf', '12345.pdf', 'arXiv-1706.03762 (2).PDF']) assert.ok(numericPaperName(name), name);
for (const name of ['Attention Is All You Need.pdf', '2026 report.pdf']) assert.ok(!numericPaperName(name), name);
for (const title of ['Untitled', 'Microsoft Word - paper', '1706.03762', 'arXiv:1706.03762', 'draft.tex', '12345.pdf']) assert.equal(cleanPaperTitle(title), '');
assert.equal(cleanPaperTitle('  Attention\nIs All You Need  '), 'Attention Is All You Need');
const run = (str, x, y, size = 20) => ({ str, width: str.length * size * .5, transform: [size, 0, 0, size, x, y] });
const items = [run('Proceedings of a conference', 50, 775, 24), run('Attention Is All', 80, 700), run('You Need', 180, 675),
  run('Authors and affiliations', 80, 640, 10), run('Abstract', 50, 600, 12),
  ...Array.from({ length: 24 }, (_, i) => run('A body text line with repeated words for the fixture.', 50, 570 - i * 13, 10)),
  { ...run('arXiv:1706.03762', 15, 200), transform: [0, 20, -20, 0, 15, 200] }];
assert.equal(firstPageTitle(items, 800), 'Attention Is All You Need');
assert.equal(firstPageTitle([], 800), '');
assert.equal(firstPageTitle(items.slice(5), 800), '', 'ordinary body text is not promoted to a title');
const store = new Map();
const storage = { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) };
let active = 0, peak = 0, calls = 0;
const papers = Array.from({ length: 5 }, (_, i) => ({ path: `folder/${i}.pdf`, name: `${i}.pdf`, size: 200, mtime: 1, url: `/${i}` }));
const index = createPaperTitleIndex({ storage, readTitle: async url => {
  calls++; active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--;
  return url === '/4' ? '' : `A title for ${url}`;
} });
index.update(papers); index.update(papers);
await new Promise(r => setTimeout(r, 80));
assert.equal(calls, 5); assert.equal(peak, 2);
assert.equal(index.label(papers[0]), '0 · A title for /0'); assert.equal(index.label(papers[4]), '4');
const cached = createPaperTitleIndex({ storage, readTitle: async () => { calls++; return 'Updated paper title'; } });
cached.update(papers); await new Promise(r => setTimeout(r, 5)); assert.equal(calls, 5, 'successful misses are cached');
const replaced = { ...papers[0], mtime: 2 };
cached.update([replaced]); await new Promise(r => setTimeout(r, 5));
assert.equal(cached.label(replaced), '0 · Updated paper title');
assert.equal(papers[0].path, 'folder/0.pdf', 'identity stays unchanged');
console.log('PASS title detection, layout fallback, noise rejection, bounded reads, cache and file replacement');
