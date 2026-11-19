/** Moving streamed PDFs must discard transports bound to the old file path.
 * node test/organizer-range.mjs [--desktop]
 * Isolated storage, synthetic >20 MiB PDFs, no model or external requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `organizer-range-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
function writeRangePdf(file) {
  const count = 48, objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${4 + i} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 0; i < count; i++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${4 + count + i} 0 R >>`);
  for (let i = 0; i < count; i++) {
    const content = `BT /F1 18 Tf 65 700 Td (Synthetic range page ${i + 1}) Tj ET\n%${'x'.repeat(512 * 1024)}\n`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length); const chunk = Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
    chunks.push(chunk); length += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  fs.writeFileSync(file, Buffer.concat(chunks));
}
writeRangePdf(path.join(papersDir, 'large.pdf'));
fs.copyFileSync(path.join(papersDir, 'large.pdf'), path.join(papersDir, 'parked.pdf'));
writeTitlePdf(path.join(papersDir, 'other.pdf'), { title: 'Synthetic unrelated paper' });
fs.mkdirSync(path.join(papersDir, 'conflict'));
writeTitlePdf(path.join(papersDir, 'conflict', 'large.pdf'), { title: 'Synthetic conflicting target' });
assert.ok(fs.statSync(path.join(papersDir, 'large.pdf')).size > 20 * 1024 * 1024);
const checks = [], requests = [], errors = [], failedRequests = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser, page, base;
async function api(route) { const response = await fetch(`${base}${route}`); assert.ok(response.ok); return response.json(); }
async function home() {
  if (await page.evaluate(() => document.body.classList.contains('reading'))) await page.locator('#homeBtn').click();
  await page.waitForSelector('#home', { visible: true });
}
async function openOrganizer() {
  await home(); await page.locator('#homeOrganize').click();
  await page.waitForFunction(() => document.querySelector('#paperOrganizer')?.open && document.querySelector('#paperOrganizer').getAttribute('aria-busy') === 'false');
  await page.select('#paperOrganizerScope', 'all');
}
async function move(relative, folder, expected = 'done') {
  await page.$$eval('#paperOrganizerList .po-row', (rows, { relative, folder }) => {
    for (const row of rows) {
      const box = row.querySelector('input[type="checkbox"]');
      if (row.dataset.path === relative) {
        const input = row.querySelector('.po-target input'); input.value = folder;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (!box.disabled && box.checked !== (row.dataset.path === relative)) box.click();
    }
  }, { relative, folder });
  await page.locator('#paperOrganizerApply').click();
  await page.waitForFunction(({ relative, expected }) => document.querySelector('#paperOrganizer').getAttribute('aria-busy') === 'false'
    && [...document.querySelectorAll('#paperOrganizerList .po-row')].some(row => row.dataset.path === relative && row.dataset.status === expected), {}, { relative, expected });
}
async function closeOrganizer() { await page.locator('#paperOrganizer .po-actions > button:first-child').click(); }
async function readingPosition() {
  return page.evaluate(() => ({ page: window.__viewer.current, scale: window.__viewer.scale, fit: window.__viewer._fitMode,
    anchor: window.__viewer._captureAnchor(), scrollTop: window.__viewer.container.scrollTop, path: window.__state.doc.path }));
}
async function setPosition(pageNumber, scale) {
  await page.evaluate(async ({ pageNumber, scale }) => {
    const viewer = window.__viewer; viewer.setScale(scale, { keepCenter: false }); viewer._fitMode = false;
    await viewer.goToPage(pageNumber); await viewer.restorePosition({ scrollTop: viewer.container.scrollTop + 135 });
    window.__rangeOldPdf = viewer.pdf;
  }, { pageNumber, scale });
  await wait(250); return readingPosition();
}
function assertPosition(before, after) {
  assert.equal(after.page, before.page); assert.ok(Math.abs(after.scale - before.scale) < 0.001);
  assert.equal(after.fit, before.fit); assert.equal(after.anchor.page, before.anchor.page);
  assert.ok(Math.abs(after.anchor.frac - before.anchor.frac) < 0.015, JSON.stringify({ before, after }));
}
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', PRT_QUIET_TOKEN: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('organizer-range').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', data => fs.appendFileSync(path.join(scratch, 'server.log'), data));
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready); const listing = await api('/api/papers'); assert.equal(path.resolve(listing.dir), papersDir);
  const papers = Object.fromEntries(listing.papers.map(paper => [paper.path, paper]));
  assert.equal(await fetch(`${base}/js/app.js`).then(response => response.text()), fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== base || ['/api/chat', '/api/web-search', '/api/ref-search', '/api/import-pdf'].includes(url.pathname)) {
      errors.push(`Unexpected external/model request: ${url.origin}${url.pathname}`); return request.abort();
    }
    if (url.origin === base) requests.push({ route: url.pathname, path: url.searchParams.get('path'), range: request.headers().range || '', method: request.method() });
    return request.continue();
  });
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/pdf' && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN'); localStorage.setItem('reader.session.scopeMode', 'paper');
    localStorage.setItem('reader.session.onEnter', 'latest'); localStorage.setItem('reader.session.aiTitle', '0');
  });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 4);
  await page.waitForSelector('#home', { visible: true });
  await wait(500);
  await page.evaluate(paper => window.__ctx.openDoc(paper), papers['large.pdf']);
  await page.waitForFunction(id => window.__state.viewerDocId === id, {}, papers['large.pdf'].docId);
  const activePosition = await setPosition(6, 1.25);
  const activeSession = await page.evaluate(async () => {
    window.__ctx.setPanelVisible('chat', true);
    await window.__ctx.newSession({ silent: true });
    const input = document.querySelector('#chatInput'); input.value = 'UNSENT_RANGE_MOVE_DRAFT';
    input.dispatchEvent(new Event('input', { bubbles: true })); await window.__ctx.flushComposerDrafts();
    return window.__ctx.activeSession;
  });
  await openOrganizer(); await move('large.pdf', 'conflict', 'error');
  assert.ok(fs.existsSync(path.join(papersDir, 'large.pdf')));
  await closeOrganizer(); await page.locator('#homeBtn').click();
  await page.waitForFunction(id => window.__state.viewerDocId === id && window.__viewer.pdf, {}, papers['large.pdf'].docId);
  await wait(150); assertPosition(activePosition, await readingPosition());
  assert.equal(await page.$eval('#chatInput', input => input.value), 'UNSENT_RANGE_MOVE_DRAFT');
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), activeSession);
  assert.match(await page.evaluate(() => window.__viewer.getPageText(6)), /Synthetic range page 6/);
  pass('conflicting large-PDF move preserves the source and restores its reading position, draft and conversation');
  await openOrganizer();
  await page.evaluate(() => window.__ctx.chatJobs.set('range-fixture', { key: 'range-fixture', finished: false, discarded: false,
    papers: [{ path: 'large.pdf' }], controller: new AbortController() }));
  const beforeBusy = requests.filter(request => request.route === '/api/move').length;
  await move('large.pdf', 'Moved', 'error');
  assert.equal(requests.filter(request => request.route === '/api/move').length, beforeBusy);
  await page.evaluate(() => window.__ctx.chatJobs.delete('range-fixture'));
  pass('a background job holding a paper-list snapshot blocks moving its source before any API mutation');
  await move('large.pdf', 'Moved'); await closeOrganizer();
  const activeCheckpoint = requests.length;
  assert.equal(await page.evaluate(() => window.__viewer.pdf), null);
  await page.locator('#homeBtn').click();
  await page.waitForFunction(id => window.__state.viewerDocId === id && window.__viewer.pdf, {}, papers['large.pdf'].docId);
  await wait(150); assertPosition(activePosition, await readingPosition());
  assert.equal(await page.evaluate(() => window.__viewer.pdf === window.__rangeOldPdf), false);
  assert.equal(await page.$eval('#chatInput', input => input.value), 'UNSENT_RANGE_MOVE_DRAFT');
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), activeSession);
  const activeLaterCheckpoint = requests.length;
  assert.match(await page.evaluate(async () => { await window.__viewer.goToPage(40); return window.__viewer.getPageText(40); }), /Synthetic range page 40/);
  assert.ok(requests.slice(activeLaterCheckpoint).some(request => request.path === 'Moved/large.pdf' && request.range));
  assert.ok(!requests.slice(activeCheckpoint).some(request => request.path === 'large.pdf'));
  pass('current large PDF reloads at the moved URL, restores page/zoom/anchor, and reads an uncached later page through new range requests');

  await page.evaluate(paper => window.__ctx.openDoc(paper), papers['parked.pdf']);
  const parkedPosition = await setPosition(8, 1.15);
  await page.evaluate(paper => window.__ctx.openDoc(paper), papers['other.pdf']);
  await openOrganizer(); await move('parked.pdf', 'Moved'); await closeOrganizer();
  const parkedCheckpoint = requests.length;
  const movedPaper = (await api('/api/papers')).papers.find(paper => paper.path === 'Moved/parked.pdf');
  await page.evaluate(paper => window.__ctx.openDoc(paper), movedPaper);
  await wait(150); assertPosition(parkedPosition, await readingPosition());
  assert.equal(await page.evaluate(() => window.__viewer.pdf === window.__rangeOldPdf), false);
  const parkedLaterCheckpoint = requests.length;
  assert.match(await page.evaluate(async () => { await window.__viewer.goToPage(44); return window.__viewer.getPageText(44); }), /Synthetic range page 44/);
  assert.ok(requests.slice(parkedLaterCheckpoint).some(request => request.path === 'Moved/parked.pdf' && request.range));
  assert.ok(!requests.slice(parkedCheckpoint).some(request => request.path === 'parked.pdf'));
  pass('parked large PDF discards its old transport and restores its saved reading position using the moved file');
  assert.deepEqual(errors, []);
  assert.ok(!failedRequests.some(request => request.error && !/ERR_ABORTED/.test(request.error)), JSON.stringify(failedRequests));
  pass('no PDF HTTP errors, unexpected request failures, page errors, model requests or external requests');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, requests, errors, failedRequests }, null, 2));
  console.log(`${checks.length}/${checks.length} passed. Evidence: ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: error.stack, checks, requests, errors, failedRequests,
    state: await page?.evaluate(() => ({ path: window.__state?.doc?.path, viewerDocId: window.__state?.viewerDocId,
      page: window.__viewer?.current, scale: window.__viewer?.scale, text: document.querySelector('#paperOrganizer')?.textContent })).catch(() => null) }, null, 2));
  throw error;
} finally { await browser?.close(); await stopChild(reader); }
