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
    { title: 'Academic first title', url: 'https://example.test/paper/#abstract', source: 'Academic', snippet: 'Verified excerpt' },
    { title: 'Unsafe row', url: 'javascript:alert(1)', pdfUrl: 'file:///private.pdf' },
    { title: '', url: 'https://example.test/untitled' },
    { title: 'PDF-only result', url: 'data:text/html,unsafe', pdfUrl: 'https://example.test/paper-two.pdf' },
  ] }, { provider: 'Web', results: [
    { title: 'Duplicate web title', url: 'https://example.test/paper', pdfUrl: 'https://example.test/paper.pdf', snippet: 'Duplicate excerpt' },
    { title: 'Credential row', url: 'https://user:secret@example.test/private' },
  ] }) });
  assert.equal(result.status, 'complete'); assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0], { title: 'Academic first title', url: 'https://example.test/paper/#abstract', pdfUrl: 'https://example.test/paper.pdf',
    snippet: 'Verified excerpt', year: '', source: 'Academic' });
  assert.equal(result.results[1].url, 'https://example.test/paper-two.pdf'); assert.equal(result.results[1].pdfUrl, result.results[1].url);
});
await test('partial channel failure retains actual source, download link and excerpt', async () => {
  const result = await findOnlinePapers({ query: 'attention model', fetcher: providers({ error: 'academic unavailable' }, { provider: 'Synthetic web', results: [
    { title: 'Actual source', url: 'https://example.test/actual', pdfUrl: 'https://example.test/actual.pdf', snippet: 'Actual provider evidence', year: 2026 },
  ] }) });
  assert.equal(result.status, 'partial'); assert.equal(result.results[0].source, 'Synthetic web');
  assert.equal(result.results[0].pdfUrl, 'https://example.test/actual.pdf'); assert.equal(result.results[0].snippet, 'Actual provider evidence');
});
await test('provider fields and result count remain bounded', async () => {
  const result = await findOnlinePapers({ query: 'bounded results', fetcher: providers({ results: Array.from({ length: 20 }, (_, index) => ({
    title: 't'.repeat(800), url: `https://example.test/${index}`, source: 's'.repeat(200), snippet: 'e'.repeat(1000), year: 'y'.repeat(20),
  })) }, { results: [] }) });
  assert.equal(result.results.length, 8);
  for (const row of result.results) { assert.equal(row.title.length, 500); assert.equal(row.source.length, 100); assert.equal(row.snippet.length, 700); assert.equal(row.year.length, 8); }
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
