/** Cross-paper ranges, literal code and complete citation payloads.
 * node test/citation-ranges.mjs [--desktop]
 * Isolated synthetic PDFs and front-end rendering only; no model requests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const scratch = fs.mkdtempSync(path.join(SANDBOX, `citation-ranges-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
for (const name of ['current.pdf', '2012.12877v2.pdf', '视觉模型.pdf']) {
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, name));
}
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
assert.ok(executablePath);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' };
let browser, page;
const reader = desktop ? spawnReader(stageExe('citation-ranges').exe, { args: ['--port', String(port)], env })
  : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
const checks = [], errors = [], forbidden = [];
const check = (label, passed, detail = '') => { checks.push({ label, passed, detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`); };
const raw = '## Cross-paper sources\n\n'
  + 'DeiT.〔《2012.12877v2.pdf》p.1–2〕 Repeat.〔《2012.12877v2.pdf》p.1-2〕 '
  + 'Training.〔《2012.12877v2.pdf》p.8—9〕 Single.〔《2012.12877v2.pdf》p.8〕 '
  + 'Chinese filename.〔《视觉模型.pdf》p.3－4〕 Chinese range.〔《视觉模型.pdf》第3至4页〕 '
  + 'Chinese separator.〔《视觉模型.pdf》p.5到6〕 Tilde.〔《视觉模型.pdf》p.7～8〕 '
  + 'Local range.〔p.1–2〕 Local Chinese.〔第3到4页〕';
try {
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready);
  for (const asset of ['js/app.js', 'js/citation-display.js', 'js/citation-validator.js', 'js/pdfview.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(response => response.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `${asset}: exact current build`);
  }
  check('isolated service serves the current citation modules', true);
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  page = await browser.newPage(); await page.setViewport({ width: 1450, height: 1000 }); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if ((['http:', 'https:'].includes(url.protocol) && url.origin !== base) || /\/api\/(?:chat|web-search|ref-search)/.test(url.pathname)) {
      forbidden.push(`${url.origin}${url.pathname}`); return request.abort();
    }
    return request.continue();
  });
  await page.goto(`${base}/?open=current.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__viewer?.numPages === 16
    && window.__state.viewerDocId === window.__state.doc?.docId && document.querySelector('#docLoading').classList.contains('hidden'));
  await wait(700);
  const render = async text => page.evaluate(async text => {
    const sessions = await import('/js/sessions.js'); sessions.sessionsHideEntryCard();
    window.__ctx.setPanelVisible('chat', true);
    const entry = window.__ctx.addEntry({ block: 'chat', kind: 'assistant', text, restore: true });
    window.__citationRangeEntry = entry.root;
    return [...entry.root.querySelectorAll('.citation-sources .page-ref')].map(button => ({
      paper: button.dataset.paper || '', page: button.dataset.page, end: button.dataset.pageEnd || '', label: button.textContent,
    }));
  }, text);
  const refs = await render(raw);
  const expected = [
    ['2012.12877v2.pdf', '1', '2'], ['2012.12877v2.pdf', '8', '9'], ['2012.12877v2.pdf', '8', ''],
    ['视觉模型.pdf', '3', '4'], ['视觉模型.pdf', '5', '6'], ['视觉模型.pdf', '7', '8'], ['', '1', '2'], ['', '3', '4'],
  ];
  check('single pages and ranges preserve document, first page and final page', JSON.stringify(refs.map(row => [row.paper, row.page, row.end])) === JSON.stringify(expected), JSON.stringify(refs));
  check('hyphen, en dash, em dash and Chinese spellings merge the same range once', refs.length === 8);
  const renderedText = await page.evaluate(() => window.__citationRangeEntry.textContent);
  check('recognized ranges leave no raw citation brackets in the answer', !renderedText.includes('〔'));
  const invalid = await render('Invalid descending.〔《2012.12877v2.pdf》p.9–8〕 Zero.〔《视觉模型.pdf》p.0–2〕 Local outside PDF.〔p.15–99〕');
  check('descending, zero and out-of-document local ranges remain noninteractive', invalid.length === 0);
  const literal = 'Prose.〔《2012.12877v2.pdf》p.1–2〕\n\n`〔《2012.12877v2.pdf》p.8–9〕` and `〔p.3〕`\n\n'
    + '```text\n〔《视觉模型.pdf》第3至4页〕\n〔p.5–6〕\n```\n\n[〔p.2〕](https://example.com "〔p.7〕")';
  await render(literal);
  const literalState = await page.evaluate(() => ({
    code: [...window.__citationRangeEntry.querySelectorAll('code')].map(node => node.textContent),
    codeButtons: window.__citationRangeEntry.querySelectorAll('pre button, code button, a button').length,
    sources: window.__citationRangeEntry.querySelectorAll('.citation-sources .page-ref').length,
    link: window.__citationRangeEntry.querySelector('a')?.textContent,
  }));
  check('inline and fenced code keep citation spelling verbatim', JSON.stringify(literalState.code) === JSON.stringify(['〔《2012.12877v2.pdf》p.8–9〕', '〔p.3〕', '〔《视觉模型.pdf》第3至4页〕\n〔p.5–6〕']));
  check('code and existing links cannot become page controls or sources', literalState.codeButtons === 0 && literalState.sources === 1 && literalState.link === '〔p.2〕');
  await render('Quoted code word.〔p.1‖the `network` has depth〕');
  check('an inline code word inside a real quotation retains plain-text navigation data', await page.evaluate(() =>
    window.__citationRangeEntry.querySelector('.citation-sources .page-ref')?.dataset.fragment === 'the network has depth'
    && window.__citationRangeEntry.querySelector('.quote-inline code')?.textContent === 'network'));
  await render(raw);
  await page.evaluate(() => [...window.__citationRangeEntry.querySelectorAll('.page-ref')].find(button => button.dataset.paper === '2012.12877v2.pdf' && button.dataset.page === '8' && button.dataset.pageEnd === '9').click());
  await page.waitForFunction(() => window.__state.doc?.path === '2012.12877v2.pdf' && window.__viewer.current === 8);
  check('clicking a cross-paper range opens its real PDF at the first cited page', true);
  await render(raw);
  await page.evaluate(() => [...window.__citationRangeEntry.querySelectorAll('.page-ref')].find(button => button.dataset.paper === '视觉模型.pdf' && button.dataset.page === '3').click());
  await page.waitForFunction(() => window.__state.doc?.path === '视觉模型.pdf' && window.__viewer.current === 3);
  check('a Chinese document and page range opens the correct local PDF', true);
  const longQuote = await page.evaluate(async () => (await window.__viewer.getPageText(5)).replace(/\s+/g, ' ').trim().slice(0, 900));
  assert.ok(longQuote.length > 600);
  await render(`Long source.〔《2012.12877v2.pdf》p.5–6‖${longQuote}〕`);
  const payload = await page.evaluate(() => {
    const source = window.__citationRangeEntry.querySelector('.citation-sources .page-ref');
    const quote = window.__citationRangeEntry.querySelector('.citation-quote-link');
    return { source: source?.dataset.fragment, quote: quote?.dataset.fragment, end: quote?.dataset.pageEnd };
  });
  check('long quotation and source buttons retain the complete fragment and range', payload.source === longQuote && payload.quote === longQuote && payload.end === '6');
  await page.evaluate(() => window.__citationRangeEntry.querySelector('.citation-sources .page-ref').click());
  await page.waitForFunction(length => window.__state.doc?.path === '2012.12877v2.pdf' && window.__ctx.quoteState.fragment.length === length, {}, longQuote.length);
  check('cross-document navigation passes the full quotation to highlighting without the old 200-character cutoff',
    await page.evaluate(() => window.__ctx.quoteState.fragment) === longQuote);
  await page.waitForFunction(() => document.querySelectorAll('.quote-hit').length > 0);
  check('the long cross-paper citation produces real PDF highlight rectangles', true);
  const across = await page.evaluate(async () => {
    const first = String(await window.__viewer.getPageText(5)).replace(/\s+/g, ' ').trim().slice(-70).trim();
    const second = String(await window.__viewer.getPageText(6)).replace(/\s+/g, ' ').trim().slice(0, 180).trim();
    return { fragment: `${first} ${second}`, second };
  });
  await render(`Across pages.〔《视觉模型.pdf》p.5–6‖${across.fragment}〕`);
  await page.evaluate(() => window.__citationRangeEntry.querySelector('.citation-sources .page-ref').click());
  await page.waitForFunction(() => window.__state.doc?.path === '视觉模型.pdf' && window.__viewer._quote?.extra?.[6]
    && document.querySelectorAll('.page[data-page="5"] .quote-hit').length > 0
    && document.querySelectorAll('.page[data-page="6"] .quote-hit').length > 0);
  check('a cross-paper range highlights both pages through the end of its continuation',
    await page.evaluate(second => window.__viewer._quote.extra[6].replace(/\s+/g, '') === second.replace(/\s+/g, ''), across.second));
  await render(raw);
  await page.screenshot({ path: path.join(scratch, 'cross-paper-ranges.png') });
  check('no browser error or model/network call occurred', errors.length === 0 && forbidden.length === 0, [...errors, ...forbidden].join('\n'));
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktop ? 'desktop' : 'node', checks, errors, forbidden, refs, payload }, null, 2), 'utf8');
  assert.ok(checks.every(row => row.passed), checks.filter(row => !row.passed).map(row => row.label).join('\n'));
  console.log(`citation-ranges: ${checks.length}/${checks.length} passed; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), String(error.stack || error), 'utf8');
  if (page) {
    await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
    const state = await page.evaluate(() => ({ doc: window.__state?.doc, page: window.__viewer?.current,
      toast: document.querySelector('#toastWrap')?.textContent, text: document.querySelector('#aiArea')?.textContent })).catch(() => null);
    fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors, forbidden, state }, null, 2), 'utf8');
  }
  console.error(`Failure evidence: ${scratch}`); throw error;
} finally { await browser?.close(); await stopChild(reader); }
