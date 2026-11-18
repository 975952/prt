/** Online paper-result contracts; injected providers only, never network or user data. */
import assert from 'node:assert/strict';
import { findOnlinePapers, paperDiscoveryIntent, safePaperLink } from '../public/js/paper-discovery-online.js';

const checks = [], failures = [];
async function test(label, fn) {
  try { await fn(); checks.push(label); console.log(`PASS ${label}`); }
  catch (error) { failures.push({ label, error }); console.error(`FAIL ${label}: ${error.stack || error}`); }
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const providers = (academic, web) => async route => response(route.startsWith('/api/ref-search') ? academic : web);

await test('discovery intents require both a search request and a paper-related subject', () => {
  for (const text of ['找一下关于自注意力的论文', '有没有那篇残差网络研究', 'Find the transformer paper', 'download attention.pdf']) assert.ok(paperDiscoveryIntent(text), text);
  for (const text of ['解释注意力机制', 'search the weather', 'this paper is useful', '']) assert.equal(paperDiscoveryIntent(text), false, text);
});
await test('source links reject executable, relative, file and credential-bearing URLs', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///C:/private.pdf', '/relative.pdf', '//example.test/path',
    'https://user:pass@example.test/paper', 'https://user@example.test/paper', 'not a URL']) assert.equal(safePaperLink(value), '', value);
  assert.equal(safePaperLink('https://example.test/paper'), 'https://example.test/paper');
  assert.equal(safePaperLink('http://example.test/paper.pdf'), 'http://example.test/paper.pdf');
});
await test('invalid queries make no provider call and valid requests are encoded and bounded', async () => {
  let calls = 0;
  for (const query of ['', ' ', 'a']) await assert.rejects(findOnlinePapers({ query, fetcher: () => { calls++; } }));
  assert.equal(calls, 0);
  const routes = [];
  await findOnlinePapers({ query: `${'x'.repeat(199)}&unexpected=1`, fetcher: async route => { routes.push(new URL(route, 'http://local')); return response({ results: [] }); } });
  assert.equal(routes.length, 2);
  for (const route of routes) { assert.ok(route.searchParams.get('q').length <= 200); assert.equal(route.searchParams.has('unexpected'), false); }
  assert.equal(routes.find(route => route.pathname === '/api/ref-search').searchParams.get('scope'), 'reading');
});
await test('HTTP 200 error responses count as failed providers rather than successful no-match searches', async () => {
  const result = await findOnlinePapers({ query: 'attention model', fetcher: providers({ error: { message: 'academic unavailable' } }, { error: 'web unavailable' }) });
  assert.equal(result.status, 'failed'); assert.deepEqual(result.results, []); assert.ok(result.error);
});
await test('legacy empty academic response alone cannot confirm successful online coverage', async () => {
  const result = await findOnlinePapers({ query: 'attention model', fetcher: providers({ results: [] }, { error: 'web unavailable' }) });
  assert.equal(result.status, 'failed'); assert.deepEqual(result.results, []);
});
await test('a healthy empty web search and failed academic search remain partial', async () => {
  const result = await findOnlinePapers({ query: 'attention model', fetcher: providers({ error: 'academic unavailable' }, { provider: 'synthetic', results: [] }) });
  assert.equal(result.status, 'partial'); assert.deepEqual(result.results, []); assert.ok(result.error);
});
await test('healthy empty responses report complete zero results without inventing sources', async () => {
  const result = await findOnlinePapers({ query: 'attention model', fetcher: providers({ results: [] }, { provider: 'synthetic', results: [] }) });
  assert.equal(result.status, 'complete'); assert.deepEqual(result.results, []); assert.equal(result.error, undefined);
});
await test('unsafe rows are discarded and duplicate source links preserve a provider PDF and excerpt', async () => {
  const result = await findOnlinePapers({ query: 'attention model', fetcher: providers({ results: [
    { title: 'Attention Model: Verified Evidence', url: 'https://doi.org/10.1234/paper/#abstract', source: 'Crossref', snippet: 'Verified excerpt' },
    { title: 'Unsafe row', url: 'javascript:alert(1)', pdfUrl: 'file:///private.pdf' },
    { title: '', url: 'https://example.test/untitled' },
    { title: 'Attention Model PDF', url: 'data:text/html,unsafe', pdfUrl: 'https://arxiv.org/pdf/2601.12345.pdf' },
  ] }, { provider: 'Web', results: [
    { title: 'Attention Model: Duplicate Result', url: 'https://doi.org/10.1234/paper', pdfUrl: 'https://research.example.edu/paper.pdf', snippet: 'Duplicate excerpt' },
    { title: 'Credential row', url: 'https://user:secret@example.test/private' },
  ] }) });
  assert.equal(result.status, 'complete'); assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0], { title: 'Attention Model: Verified Evidence', url: 'https://doi.org/10.1234/paper/#abstract', pdfUrl: 'https://research.example.edu/paper.pdf',
    snippet: 'Verified excerpt', year: '', source: 'Crossref' });
  assert.equal(result.results[1].url, 'https://arxiv.org/pdf/2601.12345.pdf'); assert.equal(result.results[1].pdfUrl, result.results[1].url);
});
await test('partial channel failure retains actual source, download link and excerpt', async () => {
  const result = await findOnlinePapers({ query: 'attention model', fetcher: providers({ error: 'academic unavailable' }, { provider: 'Synthetic web', results: [
    { title: 'Attention Model: Actual Source', url: 'https://arxiv.org/abs/2601.12345', pdfUrl: 'https://arxiv.org/pdf/2601.12345', snippet: 'Actual provider evidence', year: 2026 },
  ] }) });
  assert.equal(result.status, 'partial'); assert.equal(result.results[0].source, 'Synthetic web');
  assert.equal(result.results[0].pdfUrl, 'https://arxiv.org/pdf/2601.12345'); assert.equal(result.results[0].snippet, 'Actual provider evidence');
});
await test('provider fields and result count remain bounded', async () => {
  const result = await findOnlinePapers({ query: 'bounded results', fetcher: providers({ results: Array.from({ length: 20 }, (_, index) => ({
    title: 'Bounded results ' + 't'.repeat(800), url: `https://arxiv.org/abs/2601.${String(10000 + index)}`, source: 's'.repeat(200), snippet: 'e'.repeat(1000), year: 'y'.repeat(20),
  })) }, { results: [] }) });
  assert.equal(result.results.length, 8);
  for (const row of result.results) { assert.equal(row.title.length, 500); assert.equal(row.source.length, 100); assert.equal(row.snippet.length, 700); assert.equal(row.year.length, 8); }
});
const t2tTitle = 'Tokens-to-Token ViT: Training Vision Transformers from Scratch on ImageNet';
await test('known target searches use the complete title and retain domain context instead of an ambiguous acronym', async () => {
  const routes = [];
  await findOnlinePapers({ query: 'T2T trans', keywords: ['vision transformer', 'image classification'], titles: [t2tTitle], mode: 'known',
    fetcher: async route => { routes.push(new URL(route, 'http://local')); return response({ results: [] }); } });
  assert.equal(routes.find(route => route.pathname === '/api/ref-search').searchParams.get('q'), t2tTitle);
  const web = routes.find(route => route.pathname === '/api/web-search').searchParams.get('q');
  assert.ok(web.startsWith(t2tTitle)); assert.match(web, /vision transformer/i); assert.match(web, /image classification/);
  assert.ok(routes.every(route => route.searchParams.get('q') !== 'T2T'));
});
await test('known T2T vision paper excludes genomics and papers that merely cite its full title', async () => {
  const result = await findOnlinePapers({ query: 'T2T trans', keywords: ['vision transformer'], titles: [t2tTitle], mode: 'known',
    fetcher: providers({ results: [
      { title: t2tTitle, url: 'https://arxiv.org/abs/2101.11986', source: 'arXiv' },
      { title: 'T2T: Complete Telomere-to-Telomere Human Genome Assembly', url: 'https://doi.org/10.1234/genome', source: 'OpenAlex' },
      { title: 'Swin Transformer: Hierarchical Vision Transformer using Shifted Windows', url: 'https://arxiv.org/abs/2103.14030', source: 'arXiv', snippet: `References: ${t2tTitle}` },
      { title: 'Learning Transferable Visual Models From Natural Language Supervision', url: 'https://arxiv.org/abs/2103.00020', source: 'arXiv', snippet: `Our model is compared with ${t2tTitle}` },
    ] }, { results: [] }) });
  assert.deepEqual(result.results.map(row => row.title), [t2tTitle]);
  assert.equal(result.rejectedCount, 3); assert.equal(result.rejectedReasons.relevance, 3);
});
await test('known identities reject reviews extensions and unrequested versions of the target title', async () => {
  for (const title of [t2tTitle, 'Deep Residual Learning for Image Recognition']) {
    const rows = [title, `A Review of ${title}`, `An Analysis of ${title}`, `${title} V2`,
      `${title}: A Survey`, `${title} for Medical Images`, `${title}: Revisited`]
      .map((name, index) => ({ title: name, url: `https://arxiv.org/abs/2601.${10000 + index}`, source: 'arXiv' }));
    const result = await findOnlinePapers({ query: title, titles: [title], mode: 'known',
      fetcher: providers({ results: rows }, { results: [] }) });
    assert.deepEqual(result.results.map(row => row.title), [title]);
    assert.equal(result.rejectedReasons.relevance, rows.length - 1);
  }
});
await test('known identities retain punctuation acronym and source-label variants while respecting explicitly requested versions', async () => {
  const variants = [t2tTitle, `T2T-ViT: ${t2tTitle}`, `[PDF] ${t2tTitle} - arXiv`,
    'Tokens to Token ViT Training Vision Transformer from Scratch on ImageNet'];
  const rows = variants.map((title, index) => ({ title, url: `https://arxiv.org/abs/2601.${11000 + index}` }));
  const result = await findOnlinePapers({ query: 'T2T trans', titles: [t2tTitle], mode: 'known',
    fetcher: providers({ results: [] }, { results: rows }) });
  assert.deepEqual(result.results.map(row => row.title), variants);
  const title = 'Deep Residual Learning for Image Recognition V2';
  const versioned = await findOnlinePapers({ query: title, titles: [title], mode: 'known', fetcher: providers({ results: [
    { title, url: 'https://arxiv.org/abs/2601.12000' },
    { title: title.replace(' V2', ''), url: 'https://arxiv.org/abs/2601.12001' },
    { title: title.replace('V2', 'V3'), url: 'https://arxiv.org/abs/2601.12002' },
  ] }, { results: [] }) });
  assert.deepEqual(versioned.results.map(row => row.title), [title]);
});
await test('topic disambiguation is generic for vision versus genomic T2T and language versus electrical transformers', async () => {
  for (const item of [
    { query: 'T2T vision transformer', keywords: ['image classification'], goodTitle: 'T2T Vision Transformer for Image Classification',
      goodSnippet: 'An image classification method.', badTitle: 'T2T Human Genome Assembly', badSnippet: 'Transformer models improve genome assembly.' },
    { query: 'transformer language modeling', keywords: ['neural attention', 'sequence model'], goodTitle: 'Neural Attention in Transformer Language Modeling',
      goodSnippet: 'A sequence model for language.', badTitle: 'Electrical Transformer Thermal Modeling', badSnippet: 'An efficient power transformer model improves voltage regulation.' },
  ]) {
    const result = await findOnlinePapers({ ...item, mode: 'topic', fetcher: providers({ results: [
      { title: item.goodTitle, snippet: item.goodSnippet, url: 'https://doi.org/10.1234/relevant', source: 'Crossref' },
      { title: item.badTitle, snippet: item.badSnippet, url: 'https://doi.org/10.1234/unrelated', source: 'Crossref' },
    ] }, { results: [] }) });
    assert.deepEqual(result.results.map(row => row.title), [item.goodTitle], item.query);
    assert.equal(result.rejectedReasons.relevance, 1);
  }
});
await test('blogs encyclopedias trading pages search pages spoofed hosts and arbitrary PDFs are not paper cards', async () => {
  const urls = ['https://en.wikipedia.org/wiki/T2T', 'https://blog.example.test/t2t-vision-transformer',
    'https://finance.example.test/trading/t2t', 'https://arxiv.org/search/?query=t2t',
    'https://arxiv.org.evil.test/abs/2101.11986', 'https://random.example.test/t2t.pdf'];
  const result = await findOnlinePapers({ query: 'T2T vision transformer', fetcher: providers({ results: [] }, { results:
    urls.map(url => ({ title: 'T2T Vision Transformer', url, snippet: 'T2T vision transformer research paper', source: 'OpenAlex' })) }) });
  assert.deepEqual(result.results, []); assert.equal(result.status, 'complete');
  assert.equal(result.rejectedReasons.source, urls.length); assert.equal(result.rejectedCount, urls.length);
});
await test('verifiable scholarly pages and institutional PDFs retain provider links without inventing downloads', async () => {
  const sources = [
    'https://doi.org/10.1234/attention', 'https://openreview.net/forum?id=abc123',
    'https://proceedings.mlr.press/v202/attention23a.html', 'https://openaccess.thecvf.com/content/CVPR2024/html/Smith_Attention_Model_CVPR_2024_paper.html',
    'https://aclanthology.org/2024.acl-long.123/', 'https://research.example.edu/papers/attention.pdf',
    'https://dl.acm.org/doi/10.1145/123456.123456', 'https://link.springer.com/article/10.1007/attention',
  ];
  const result = await findOnlinePapers({ query: 'attention model', fetcher: providers({ results: [] }, { results: sources.map(url => ({ title: 'Attention Model', url })) }) });
  assert.deepEqual(result.results.map(row => row.url), sources); assert.equal(result.rejectedCount, 0);
  assert.equal(result.results.filter(row => row.pdfUrl).length, 1);
});
await test('a short acronym alone cannot admit unrelated scholarly results and filtered results remain empty', async () => {
  const result = await findOnlinePapers({ query: 'T2T', fetcher: providers({ results: [
    { title: 'T2T Genome Completion', url: 'https://doi.org/10.1234/genome', source: 'OpenAlex' },
  ] }, { results: [] }) });
  assert.equal(result.status, 'complete'); assert.deepEqual(result.results, []); assert.equal(result.rejectedReasons.relevance, 1);
});
await test('distinctive single method names and translated keyword evidence remain searchable', async () => {
  for (const [query, keywords, title, snippet] of [
    ['FlashAttention', [], 'FlashAttention: Fast and Memory-Efficient Exact Attention', 'GPU attention'],
    ['找自注意力论文', ['self attention'], 'Self Attention for Machine Translation', 'Attention networks'],
  ]) {
    const result = await findOnlinePapers({ query, keywords, fetcher: providers({ results: [{ title, snippet, url: 'https://arxiv.org/abs/2601.12345' }] }, { results: [] }) });
    assert.equal(result.results.length, 1, query);
  }
});
await test('HTTP failures and invalid JSON are surfaced as failed coverage', async () => {
  const result = await findOnlinePapers({ query: 'provider errors', fetcher: async route => route.startsWith('/api/ref-search')
    ? response({}, 503) : new Response('{bad json') });
  assert.equal(result.status, 'failed'); assert.ok(result.error);
});
await test('caller cancellation reaches both channels and late provider results cannot become results', async () => {
  const controller = new AbortController(), signals = [], releases = [];
  const pending = findOnlinePapers({ query: 'cancel query', signal: controller.signal, fetcher: (_route, { signal }) => {
    signals.push(signal); return new Promise(resolve => releases.push(resolve));
  } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(signals.length, 2);
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
  assert.ok(signals.every(signal => signal.aborted));
  for (const release of releases) release(response({ results: [{ title: 'Late unwanted result', url: 'https://example.test/late' }] }));
  await new Promise(resolve => setImmediate(resolve));
});
await test('already-cancelled discovery makes no provider calls', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(findOnlinePapers({ query: 'cancelled first', signal: controller.signal, fetcher: () => { calls++; } }), error => error.name === 'AbortError');
  assert.equal(calls, 0);
});
await test('timeout bounds non-cooperating providers and aborts both underlying requests', async () => {
  const signals = [], started = Date.now();
  const result = await findOnlinePapers({ query: 'timeout query', timeoutMs: 25, fetcher: (_route, { signal }) => { signals.push(signal); return new Promise(() => {}); } });
  assert.equal(result.status, 'failed'); assert.ok(Date.now() - started < 1000); assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal.aborted));
});
console.log(`Paper discovery online: ${checks.length}/${checks.length + failures.length} passed`);
if (failures.length) process.exitCode = 1;
