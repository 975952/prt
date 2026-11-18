/** Discovery contract checks with synthetic documents; no server or user library. */
import assert from 'node:assert/strict';
import { createPaperAccess } from '../public/js/paper-access.js';
import { discoverLocalPapers } from '../public/js/paper-discovery.js';

const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const paper = (path, extra = {}) => ({ path, name: path.split('/').pop(), folder: path.split('/').slice(0, -1).join('/'),
  url: `/pdf/${path}`, docId: `id:${path}`, ...extra });
function fixture(rows) {
  const opens = [], reads = [], aborts = [];
  const access = createPaperAccess({ idleMs: 0, openDocument: async (url, { signal }) => {
    opens.push(url);
    const pages = rows[url];
    if (pages instanceof Error) throw pages;
    if (!pages) throw new Error('Unknown fixture');
    return { numPages: pages.length,
      async readPageText(page, { signal: workSignal }) {
        reads.push([url, page]);
        workSignal.addEventListener('abort', () => aborts.push([url, page]), { once: true });
        return typeof pages[page - 1] === 'function' ? pages[page - 1](workSignal) : pages[page - 1];
      }, destroy() {},
    };
  } });
  return { access, opens, reads, aborts };
}
const filler = 'This document describes unrelated chemistry and laboratory measurements.';

{
  const numeric = paper('transformers/2307.08691.pdf'), other = paper('chemistry/overview.pdf');
  const pages = Array.from({ length: 42 }, () => filler);
  pages[39] = 'FlashAttention reduces memory use by using an IO-aware exact attention algorithm on GPUs.';
  const f = fixture({ [numeric.url]: pages, [other.url]: [filler] });
  const result = await discoverLocalPapers({ query: '帮我找减少注意力显存开销的文章',
    keywords: ['FlashAttention', 'memory efficient attention'], papers: [other, numeric], paperAccess: f.access });
  assert.equal(result.status, 'matched'); assert.equal(result.coverage.complete, true);
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].path, numeric.path);
  assert.equal(result.matches[0].docId, numeric.docId); assert.equal(result.matches[0].page, 40);
  assert.match(result.matches[0].snippet, /FlashAttention/);
  assert.equal(result.matches[0].matchKind, 'text');
  assert.equal(f.reads.length, 43, 'numeric filenames and late pages receive full text inspection');
  await f.access.clear(); pass('natural-language intent plus English synonyms finds evidence on page 40');
}

{
  const p = paper('reading/001.pdf', { displayTitle: 'Vision Transformers for Dense Prediction' });
  const q = paper('other/001.pdf', { displayTitle: 'A Study of Vision Transformers' });
  const f = fixture({ [p.url]: ['Vision transformers use attention to extract visual representations.'], [q.url]: [filler] });
  const result = await discoverLocalPapers({ query: '视觉 Transformer', keywords: ['vision transformers'],
    papers: [q, p], paperAccess: f.access });
  assert.equal(result.matches.length, 2); assert.equal(result.matches[0].path, p.path);
  assert.equal(result.matches[0].matchKind, 'title+text'); assert.equal(result.matches[1].page, null);
  assert.equal(new Set(result.matches.map(m => m.docId)).size, 2, 'same filenames retain independent identities');
  assert.equal(result.coverage.checked, 2); await f.access.clear();
  pass('known titles rank candidates while full text and duplicate-path identities remain intact');
}

{
  const p = paper('notes.pdf'), f = fixture({ [p.url]: [filler, 'The experimental protocol discusses bacterial staining.'] });
  const result = await discoverLocalPapers({ query: 'AI', papers: [p], paperAccess: f.access });
  assert.equal(result.status, 'not_found', 'AI must not match staining');
  assert.deepEqual(result.matches, []); assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.checked, 1); assert.equal(result.coverage.remaining, 0);
  await f.access.clear(); pass('only complete readable search can return not_found; acronym boundaries reject substrings');
}

{
  const blank = paper('scan.pdf'), mixed = paper('mixed.pdf'), broken = paper('broken.pdf');
  const f = fixture({ [blank.url]: ['', '1'], [mixed.url]: [filler, ''], [broken.url]: new Error('Damaged PDF') });
  const result = await discoverLocalPapers({ query: 'optimization', papers: [blank, mixed, broken], paperAccess: f.access });
  assert.equal(result.status, 'incomplete'); assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.checked, 2); assert.equal(result.coverage.unreadable, 3);
  assert.equal(result.coverage.remaining, 1); assert.equal(result.coverage.textlessPages, 3);
  assert.deepEqual(result.coverage.issues.map(i => i.reason).sort(), ['missing_text', 'missing_text', 'read_error']);
  assert.match(result.coverage.issues.find(i => i.reason === 'read_error').message, /Damaged/);
  await f.access.clear(); pass('scans, mixed text/image PDFs, and corrupt PDFs cannot claim local absence');
}

{
  const p = paper('readable.pdf'), q = paper('scan.pdf');
  const f = fixture({ [p.url]: ['This article introduces a sparse attention mechanism for long sequences.'], [q.url]: [''] });
  const result = await discoverLocalPapers({ query: 'sparse attention', papers: [p, q], paperAccess: f.access });
  assert.equal(result.status, 'matched'); assert.equal(result.coverage.complete, false);
  assert.equal(result.matches[0].page, 1); assert.equal(result.coverage.unreadable, 1);
  await f.access.clear(); pass('verified matches survive incomplete coverage with that limitation retained');
}

{
  const p = paper('symbols.pdf');
  const f = fixture({ [p.url]: ['We propose SELF—ATTENTION layers. 自注意力机制能够结合上下文信息来构建序列表示。'] });
  const result = await discoverLocalPapers({ query: '自注意力', keywords: ['self-attention', 'SELF ATTENTION'],
    papers: [p], paperAccess: f.access });
  assert.equal(result.status, 'matched'); assert.match(result.matches[0].snippet, /SELF—ATTENTION/);
  assert.deepEqual(result.keywords, ['自注意力', 'self-attention']);
  assert.equal(result.matches[0].matchedKeywords.length, 2);
  await f.access.clear(); pass('Chinese phrases and punctuation-normalized English synonyms keep readable evidence');
}

{
  const rows = Array.from({ length: 12 }, (_, n) => paper(`topic-${n}.pdf`));
  const f = fixture(Object.fromEntries(rows.map(p => [p.url, ['A sparse attention method supports efficient inference and learning.']])));
  const result = await discoverLocalPapers({ query: 'sparse attention', papers: rows, paperAccess: f.access, maxResults: 3 });
  assert.equal(result.matches.length, 3); assert.equal(result.coverage.checked, 12);
  assert.equal(result.coverage.complete, true); assert.equal(f.reads.length, 12);
  await f.access.clear(); pass('result limit never stops library coverage or scanning of matching pages');
}

{
  const p = paper('slow.pdf'), q = paper('later.pdf');
  let observedSignal;
  const started = Date.now();
  const result = await discoverLocalPapers({ query: 'attention', papers: [p, q], timeBudgetMs: 25,
    paperAccess: { search: (url, query, options) => { observedSignal = options.signal; return new Promise(() => {}); } } });
  assert.equal(result.status, 'incomplete'); assert.equal(result.coverage.timedOut, true);
  assert.equal(result.coverage.remaining, 2); assert.equal(result.coverage.checked, 0);
  assert.equal(observedSignal.aborted, true); assert.ok(Date.now() - started < 500, 'outer deadline bounds non-cooperative adapters');
  pass('total deadline aborts a hanging extractor and retains unsearched coverage');
}

{
  const p = paper('partial.pdf');
  const result = await discoverLocalPapers({ query: 'attention', papers: [p], paperAccess: {
    search: async (url, query, options) => {
      options.matchPage({ page: 1, text: 'An attention mechanism processes sequences with learned interactions.' });
      return { numPages: 10, scanned: 1, complete: false, truncated: true, timedOut: true, hits: [] };
    },
  } });
  assert.equal(result.status, 'matched'); assert.equal(result.matches[0].page, 1);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.partial, 1);
  assert.equal(result.coverage.timedOut, true); assert.equal(result.coverage.checked, 0);
  pass('adapter partial-timeout reports retain collected evidence without claiming completion');
}

{
  const p = paper('late.pdf'); let lateMatcher;
  const result = await discoverLocalPapers({ query: 'attention', papers: [p], timeBudgetMs: 10,
    paperAccess: { search: (url, query, options) => {
      lateMatcher = options.matchPage;
      return new Promise(() => {});
    } } });
  assert.throws(() => lateMatcher({ page: 1, text: 'A late attention mechanism result must be ignored.' }), { name: 'TimeoutError' });
  assert.equal(result.matches.length, 0); assert.equal(result.coverage.checked, 0);
  pass('late extraction callbacks cannot mutate a timed-out discovery snapshot');
}

{
  const controller = new AbortController(), p = paper('cancel.pdf');
  let innerSignal, calls = 0;
  const pending = discoverLocalPapers({ query: 'attention', papers: [p], signal: controller.signal,
    paperAccess: { search: (url, query, options) => { calls++; innerSignal = options.signal; return new Promise(() => {}); } } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected; assert.equal(innerSignal.aborted, true);
  await assert.rejects(discoverLocalPapers({ query: 'attention', papers: [p], signal: controller.signal,
    paperAccess: { search: () => { calls++; } } }), { name: 'AbortError' });
  assert.equal(calls, 1); pass('caller cancellation propagates immediately and pre-aborted runs do no work');
}

{
  const p = paper('zero.pdf'); let calls = 0;
  const result = await discoverLocalPapers({ query: 'attention', papers: [p], timeBudgetMs: 0,
    paperAccess: { search: () => { calls++; } } });
  assert.equal(result.status, 'incomplete'); assert.equal(calls, 0);
  const empty = await discoverLocalPapers({ query: 'attention', papers: [], paperAccess: { search() {} } });
  assert.equal(empty.status, 'not_found'); assert.equal(empty.coverage.complete, true);
  await assert.rejects(discoverLocalPapers({ query: ' ', papers: [], paperAccess: { search() {} } }), TypeError);
  await assert.rejects(discoverLocalPapers({ query: 'attention', paperAccess: { search() {} } }), TypeError);
  await wait(0); pass('zero budget, empty library, and invalid input have explicit safe outcomes');
}

console.log(`\n${checks.length}/${checks.length} paper discovery checks passed.`);
