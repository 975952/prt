/** Real mouse selection on isolated, intentionally interleaved two-column pages.
 * Run: node test/selection-columns.mjs [--desktop]
 * One explicit translation uses an intercepted synthetic response; no external API or user paper.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { selectionFixtureRows, writeSelectionFixture } from './fixtures/make-selection-pdf.mjs';

const desktop = process.argv.includes('--desktop');
const CHROME = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((file) => file && fs.existsSync(file));
assert.ok(CHROME);
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `selection-columns-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
writeSelectionFixture(path.join(papers, 'selection-columns.pdf'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const results = [], pageErrors = [], apiCalls = [], chatBodies = [];
const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const markers = (text) => String(text || '').match(/P[12][LR]\d\d/g) || [];
const rows = (page, column, from, to) => selectionFixtureRows.filter((row) => row.page === page && row.column === column
  && Number(row.marker.slice(-2)) >= from && Number(row.marker.slice(-2)) <= to);
function check(name, ok, evidence) {
  results.push({ name, ok: !!ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

let reader, browser, page;
try {
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('selection-columns').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await wait(100); try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ }
  }
  assert.ok(ready, 'isolated reader starts');
  const listing = await fetch(`${base}/api/papers`).then((response) => response.json());
  assert.equal(path.resolve(listing.dir), path.resolve(papers));
  for (const asset of ['app.js', 'pdfview.js', 'selection-reading-order.js'].filter((name) => fs.existsSync(path.join(ROOT, 'public/js', name)))) {
    assert.equal(await fetch(`${base}/js/${asset}`).then((response) => response.text()),
      fs.readFileSync(path.join(ROOT, 'public/js', asset), 'utf8'), `reader serves current ${asset}`);
  }
  assert.ok((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'selection-local-mock', apiKey: 'SYNTHETIC_SELECTION_KEY' }) })).ok);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser-profile'),
    defaultViewport: { width: 1400, height: 1900 } });
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('request', (request) => { if (/\/api\/(chat|agent)/.test(request.url())) apiCalls.push(request.url()); });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/chat') {
      chatBodies.push(JSON.parse(request.postData() || '{}'));
      request.respond({ status: 200, contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: '两段所选正文的连续译文。' } }] })}\n\ndata: [DONE]\n\n` }).catch(() => {});
    } else request.continue().catch(() => {});
  });
  await page.goto(`${base}/?open=selection-columns.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.evaluate(async () => { window.__viewer.setScale(1); await window.__viewer.goToPage(1); });
  await page.waitForFunction(() => [1, 2].every((n) => [...document.querySelectorAll(`.page[data-page="${n}"] .textLayer span`)]
    .some((span) => span.textContent.includes(`P${n}R12`))));
  await wait(250);
  await (await page.$('.pages')).screenshot({ path: path.join(scratch, 'fixture-pages.png') });
  const domOrder = await page.evaluate(() => [...document.querySelectorAll('.page[data-page="1"] .textLayer span')]
    .flatMap((span) => span.textContent.match(/P1[LR]\d\d|FOOTNOTE_1|CAPTION_1/g) || []));
  assert.ok(domOrder.indexOf('P1R01') < domOrder.indexOf('P1L02'), 'fixture really interleaves columns in the PDF text layer');
  assert.ok(domOrder.indexOf('FOOTNOTE_1') < domOrder.indexOf('P1L07'), 'fixture really emits its bottom footnote amid body commands');

  const point = (marker, end) => page.evaluate(({ marker, end }) => {
    const span = [...document.querySelectorAll('.textLayer span:not(.markedContent)')].find((node) => node.textContent.includes(marker));
    if (!span?.firstChild) throw new Error(`Missing fixture span ${marker}`);
    const node = span.firstChild, range = document.createRange();
    range.setStart(node, end ? node.textContent.length - 1 : 0);
    range.setEnd(node, end ? node.textContent.length : 1);
    const rect = range.getBoundingClientRect(), viewer = document.querySelector('#viewer').getBoundingClientRect();
    const x = end ? rect.right - 0.1 : rect.left + 0.1, y = rect.top + rect.height / 2;
    if (y < viewer.top || y > viewer.bottom) throw new Error(`Fixture point outside reader: ${marker}`);
    return { x, y };
  }, { marker, end });
  const snapshot = () => page.evaluate(() => ({
    native: window.getSelection()?.toString(), info: window.__viewer.getSelectionInfo(), selection: window.__state.selection,
    marks: [...document.querySelectorAll('.page')].map((page) => ({ page: Number(page.dataset.page),
      rects: [...page.querySelectorAll('.sel-mark')].map((mark) => {
        const r = mark.getBoundingClientRect(), p = page.getBoundingClientRect();
        return { x: (r.left - p.left) / p.width, y: (r.top - p.top) / p.height, w: r.width / p.width, h: r.height / p.height };
      }) })),
  }));
  const drag = async (first, last, { reverse = false, ctrl = false, clear = true } = {}) => {
    if (clear) await page.keyboard.press('Escape');
    const a = await point(first, false), b = await point(last, true);
    const start = reverse ? b : a, end = reverse ? a : b;
    if (ctrl) await page.keyboard.down('Control');
    try {
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 18 }); await page.mouse.up();
    } finally { if (ctrl) await page.keyboard.up('Control'); }
    await wait(180);
    return snapshot();
  };
  for (const column of ['L', 'R']) {
    for (const reverse of [false, true]) {
      const actual = await drag(`P1${column}01`, `P1${column}03`, { reverse });
      const expected = rows(1, column, 1, 3).map((row) => row.text).join(' ');
      const text = actual.selection?.cleanText || actual.info?.text;
      const marksStayInColumn = actual.marks.filter((page) => page.page === 1).flatMap((page) => page.rects)
        .every((r) => column === 'L' ? r.x + r.w < 0.51 : r.x > 0.5);
      check(`${column === 'L' ? 'left' : 'right'} column ${reverse ? 'reverse' : 'forward'} drag excludes the other column`,
        norm(text) === norm(expected) && marksStayInColumn, { expected, actual });
    }
  }
  const acrossExpected = [...rows(1, 'L', 10, 12), ...rows(1, 'R', 1, 3)].map((row) => row.marker);
  const crossExpected = [...rows(1, 'R', 10, 12), ...rows(2, 'L', 1, 3)].map((row) => row.marker);
  for (const reverse of [false, true]) {
    const acrossColumns = await drag('P1L10', 'P1R03', { reverse });
    check(`cross-column ${reverse ? 'reverse' : 'forward'} drag follows column reading order`,
      JSON.stringify(markers(acrossColumns.selection?.cleanText)) === JSON.stringify(acrossExpected), { expected: acrossExpected, actual: acrossColumns });
    const acrossPages = await drag('P1R10', 'P2L03', { reverse });
    check(`cross-page ${reverse ? 'reverse' : 'forward'} drag has ordered body text and highlights on both source pages`,
      JSON.stringify(markers(acrossPages.selection?.cleanText)) === JSON.stringify(crossExpected)
        && JSON.stringify(acrossPages.selection?.pages) === '[1,2]'
        && acrossPages.marks.filter((page) => page.rects.length).length === 2, { expected: crossExpected, actual: acrossPages });
  }

  for (const marker of ['CAPTION_1', 'FOOTNOTE_1']) {
    const actual = await drag(marker, marker);
    const expected = selectionFixtureRows.find((row) => row.marker === marker).text;
    check(`an explicitly selected ${marker.startsWith('CAPTION') ? 'caption' : 'footnote'} remains selectable`,
      norm(actual.selection?.cleanText) === norm(expected), { expected, actual });
  }

  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.page[data-page="1"] .textLayer'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.querySelector('#viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await wait(180);
  const fullPage = await snapshot();
  const allBody = [...rows(1, 'L', 1, 12), ...rows(1, 'R', 1, 12)].map((row) => row.marker);
  check('whole-page element-boundary selection includes every body line, caption and footnote',
    JSON.stringify(markers(fullPage.selection?.cleanText)) === JSON.stringify(allBody)
      && /CAPTION_1/.test(fullPage.selection?.cleanText || '') && /FOOTNOTE_1/.test(fullPage.selection?.cleanText || '')
      && JSON.stringify(fullPage.selection?.pages) === '[1]', { expected: allBody, actual: fullPage });

  const focusPoint = await point('P1L01', false);
  await page.mouse.click(focusPoint.x, focusPoint.y); await wait(50);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await wait(180);
  const selectAll = await snapshot();
  const allPagesBody = [...allBody, ...rows(2, 'L', 1, 12).map((row) => row.marker), ...rows(2, 'R', 1, 12).map((row) => row.marker)];
  check('Ctrl+A on rendered PDF pages includes both pages and their explicitly selected notes',
    JSON.stringify(markers(selectAll.info?.text)) === JSON.stringify(allPagesBody)
      && ['CAPTION_1', 'FOOTNOTE_1', 'CAPTION_2', 'FOOTNOTE_2'].every((marker) => selectAll.info?.text.includes(marker))
      && JSON.stringify(selectAll.info?.pages) === '[1,2]', { expected: allPagesBody, actual: selectAll });
  await page.keyboard.press('Escape'); await wait(100);
  const keyboardCleared = await snapshot();
  check('Escape clears a keyboard-created PDF selection and its painted highlights',
    !keyboardCleared.native?.trim() && !keyboardCleared.info && !keyboardCleared.selection
      && keyboardCleared.marks.every((page) => page.rects.length === 0), keyboardCleared);

  const firstPiece = await drag('P1L01', 'P1L02');
  const merged = await drag('P2R04', 'P2R05', { ctrl: true, clear: false });
  const mergeExpected = [...rows(1, 'L', 1, 2), ...rows(2, 'R', 4, 5)].map((row) => row.marker);
  check('Ctrl selection retains both pieces, page provenance and highlights while skipping captions/footnotes',
    JSON.stringify(markers(merged.selection?.cleanText)) === JSON.stringify(mergeExpected)
      && !/CAPTION_|FOOTNOTE_/.test(merged.selection?.cleanText || '')
      && JSON.stringify(merged.selection?.pages) === '[1,2]'
      && merged.marks.filter((page) => page.rects.length).length === 2, { firstPiece, expected: mergeExpected, actual: merged });
  await (await page.$('#viewer')).screenshot({ path: path.join(scratch, 'ctrl-selection.png') });
  const copied = await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
    document.dispatchEvent(event);
    return { text: clipboardData.getData('text/plain'), prevented: event.defaultPrevented };
  });
  check('copying a Ctrl selection preserves both chosen pieces in reading order', copied.prevented
    && JSON.stringify(markers(copied.text)) === JSON.stringify(mergeExpected)
    && !/CAPTION_|FOOTNOTE_/.test(copied.text), copied);
  assert.equal(apiCalls.length, 0, 'selecting and copying do not send a model request');
  await page.click('#bubble button[data-act="translate"]');
  await page.waitForFunction(() => !window.__state.busy && window.__state.sessionEntries.some((entry) =>
    entry.block === 'translate' && entry.status === 'complete' && entry.text === '两段所选正文的连续译文。'));
  const translatedSource = String(chatBodies.at(-1)?.messages?.at(-1)?.content || '').split('【需要翻译的片段】\n').at(-1);
  check('direct translation sends both Ctrl-selected pieces exactly once without the skipped notes', chatBodies.length === 1
    && JSON.stringify(markers(translatedSource)) === JSON.stringify(mergeExpected)
    && !/CAPTION_|FOOTNOTE_/.test(translatedSource), { requestCount: chatBodies.length, translatedSource });

  await page.evaluate(() => window.__viewer.goToPage(1)); await wait(200);
  const beforeNavigation = await drag('P1L01', 'P1L02');
  await page.click('#footNextPage'); await wait(250);
  const afterNavigation = await snapshot();
  await page.evaluate(() => window.__viewer.goToPage(1)); await wait(250);
  const afterReturn = await snapshot();
  check('page navigation preserves the selected source and restores its highlights',
    norm(afterNavigation.selection?.cleanText) === norm(beforeNavigation.selection?.cleanText)
      && afterReturn.marks.some((page) => page.page === 1 && page.rects.length),
    { beforeNavigation, afterNavigation, afterReturn });
  check('only the explicit intercepted translation is requested and there are no page exceptions', apiCalls.length === 1 && pageErrors.length === 0,
    { apiCalls, pageErrors });
  const passed = results.filter((result) => result.ok).length;
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, passed, total: results.length, domOrder, results }, null, 2), 'utf8');
  console.log(`Selection columns: ${passed}/${results.length} passed; evidence: ${scratch}`);
  if (passed !== results.length) process.exitCode = 1;
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: String(error.stack || error), pageErrors, results }, null, 2), 'utf8');
  console.error(`Selection columns evidence: ${scratch}`); throw error;
} finally {
  if (browser) await browser.close();
  if (reader) await stopChild(reader);
}
