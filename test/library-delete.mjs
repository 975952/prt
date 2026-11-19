/** Library PDF deletion against isolated storage and synthetic PDFs.
 * node test/library-delete.mjs [--desktop]
 * --repro uses the existing desktop deliverable to record the old recent-only X behavior.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';

const reproduce = process.argv.includes('--repro');
const desktop = process.argv.includes('--desktop') || reproduce;
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find(file => file && fs.existsSync(file));
assert.ok(executablePath, 'Chromium is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `library-delete-${reproduce ? 'repro' : desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data'));
const papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const fixturePaths = ['read-paper.pdf', 'retry-paper.pdf', 'unread-paper.pdf', 'one/shared.pdf', 'two/shared.pdf'];
for (const relative of fixturePaths) {
  fs.mkdirSync(path.dirname(path.join(papersDir, relative)), { recursive: true });
  writeTitlePdf(path.join(papersDir, relative), { title: `Synthetic ${relative.replace(/[/.]/g, ' ')} research` });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const checks = [], errors = [], requests = [], dialogs = [], observations = {};
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const card = relative => `#homeList .home-item:has(.home-item-go[title^="${relative}"])`;
const mask = '.sess-confirm-mask:not(.hidden)';
let reader, browser, page, base, failNextDelete = '', failedDeletes = 0;

async function api(route, body, method = 'POST') {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return response.json();
}
async function library() {
  await page.click('#homeBtn');
  await page.waitForFunction(() => !document.body.classList.contains('reading') && !document.querySelector('#home').classList.contains('hidden'));
  await page.click('[data-home-filter="all"]');
}
async function open(relative) {
  await page.locator(`${card(relative)} .home-item-go`).click();
  await page.waitForFunction(relative => document.body.classList.contains('reading')
    && window.__state?.viewerDocId === window.__state?.doc?.docId
    && (window.__state.doc.path || new URL(window.__state.doc.url, location.href).searchParams.get('path')) === relative
    && window.__viewer?.numPages > 0, { timeout: 20000 }, relative);
}
async function requestDelete(relative) {
  // Title extraction can refresh the grid while a click is being prepared.
  await page.locator(`${card(relative)} .home-item-x`).click();
  await page.waitForSelector(mask, { visible: true });
}
async function confirmDelete(relative) {
  const response = page.waitForResponse(response => response.request().method() === 'DELETE'
    && new URL(response.url()).pathname === '/api/papers'
    && new URL(response.url()).searchParams.get('path') === relative);
  await page.click(`${mask} .danger`);
  return response;
}
async function dialogClosed() {
  await page.waitForFunction(() => !document.querySelector('.sess-confirm-mask:not(.hidden)'));
}
const deletes = () => requests.filter(request => request.method === 'DELETE');
const exists = relative => fs.existsSync(path.join(papersDir, relative));
const tabs = () => page.evaluate(() => window.__ctx.tabs.map(tab => ({ docId: tab.docId, url: tab.url, path: tab.path })));
const hasTabPath = (rows, relative) => rows.some(tab => tab.path === relative || new URL(tab.url, base).searchParams.get('path') === relative);

try {
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('library-delete').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', data => fs.appendFileSync(path.join(scratch, 'server.log'), data));
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* service starting */ }
    if (!ready) await wait(100);
  }
  assert.ok(ready, 'isolated reader starts');
  const listing = await api('/api/papers');
  assert.equal(path.resolve(listing.dir), path.resolve(papersDir));
  assert.deepEqual(listing.papers.map(paper => paper.path).sort(), [...fixturePaths].sort());
  const readPaper = listing.papers.find(paper => paper.path === 'read-paper.pdf');
  const retryPaper = listing.papers.find(paper => paper.path === 'retry-paper.pdf');
  pass('only isolated synthetic PDFs are served');
  if (!reproduce) for (const asset of ['js/app.js', 'js/sessions.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(response => response.text()),
      fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `${asset} is current`);
  }
  browser = await puppeteer.launch({ executablePath, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('dialog', dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); void dialog.dismiss(); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base) {
      requests.push({ method: request.method(), path: url.pathname, query: url.search });
      if (['/api/chat', '/api/web-search', '/api/ref-search', '/api/import-pdf'].includes(url.pathname)) {
        errors.push(`Unexpected model/network API: ${url.pathname}`); return request.abort();
      }
      if (request.method() === 'DELETE' && url.pathname === '/api/papers' && url.searchParams.get('path') === failNextDelete) {
        failNextDelete = ''; failedDeletes++;
        return request.respond({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Synthetic delete failure"}}' });
      }
    } else if (['http:', 'https:'].includes(url.protocol)) {
      errors.push(`Unexpected external request: ${url.origin}${url.pathname}`); return request.abort();
    }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    localStorage.setItem('reader.session.scopeMode', 'paper');
    localStorage.setItem('reader.session.onEnter', 'latest');
    localStorage.setItem('reader.session.aiTitle', '0');
  });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && document.querySelectorAll('#homeList .home-item').length === 5);
  await open('read-paper.pdf'); await library();

  if (reproduce) {
    const before = deletes().length;
    await page.click(`${card('read-paper.pdf')} .home-item-x`);
    await page.waitForFunction(() => !document.querySelector('#homeList .home-item-go[title^="read-paper.pdf"]').closest('.home-item').querySelector('.home-item-x'));
    observations.afterOldX = { requests: deletes().slice(before), fileExists: exists('read-paper.pdf'),
      cardExists: !!await page.$(card('read-paper.pdf')), buttonExists: !!await page.$(`${card('read-paper.pdf')} .home-item-x`) };
    try { await open('read-paper.pdf'); observations.reopened = true; }
    catch (error) { observations.reopened = false; observations.reopenError = String(error); }
    console.log(JSON.stringify(observations, null, 2));
    pass('recorded old X behavior and attempted reopening');
  } else {
    assert.equal(await page.$$eval('#homeList .home-item', nodes => nodes.filter(node => node.querySelector('.home-item-x')).length), 5);
    pass('every Library card has a delete control, including unread papers');
    const beforeCancel = deletes().length;
    await requestDelete('read-paper.pdf');
    assert.match(await page.$eval(`${mask} .sess-confirm-body`, node => node.textContent), /read-paper\.pdf/);
    await page.click(`${mask} .ghost`); await dialogClosed();
    assert.equal(deletes().length, beforeCancel); assert.ok(exists('read-paper.pdf'));
    await open('read-paper.pdf'); await library();
    await requestDelete('read-paper.pdf'); await page.keyboard.press('Escape'); await dialogClosed();
    assert.equal(deletes().length, beforeCancel); assert.ok(exists('read-paper.pdf'));
    await open('read-paper.pdf'); await library();
    pass('in-app cancellation and Escape preserve the PDF and allow reopening');

    // Keep an inactive read-paper tab while retry-paper is the most recent reader.
    await open('retry-paper.pdf'); await library();
    assert.ok(hasTabPath(await tabs(), 'read-paper.pdf'));
    assert.ok(hasTabPath(await tabs(), 'retry-paper.pdf'));
    await api(`/api/notes?doc=${encodeURIComponent(readPaper.docId)}`, { items: [{ id: 'keep-note', page: 1, text: 'Synthetic saved note' }] });
    await requestDelete('read-paper.pdf');
    assert.equal((await confirmDelete('read-paper.pdf')).status(), 200);
    await page.waitForFunction(selector => !document.querySelector(selector), {}, card('read-paper.pdf'));
    assert.equal(exists('read-paper.pdf'), false);
    const afterDeleteTabs = await tabs();
    assert.equal(hasTabPath(afterDeleteTabs, 'read-paper.pdf'), false);
    assert.ok(hasTabPath(afterDeleteTabs, 'retry-paper.pdf'));
    assert.ok((await api(`/api/notes?doc=${encodeURIComponent(readPaper.docId)}`)).items.some(note => note.id === 'keep-note'));
    assert.ok((await api('/api/state')).docs?.[readPaper.docId], 'deleting PDF preserves reading progress');
    assert.ok(!deletes().some(request => request.path === '/api/state'));
    pass('confirm deletes only the PDF and card, clears its inactive tab, and preserves notes and reading progress');

    failNextDelete = 'retry-paper.pdf';
    await requestDelete('retry-paper.pdf');
    assert.equal((await confirmDelete('retry-paper.pdf')).status(), 503);
    await dialogClosed();
    await page.waitForFunction(() => document.body.textContent.includes('Synthetic delete failure'));
    assert.equal(failedDeletes, 1); assert.ok(exists('retry-paper.pdf'));
    assert.ok(await page.$(`${card('retry-paper.pdf')} .home-item-x`));
    await open('retry-paper.pdf'); await library();
    const activeBeforeDelete = await page.evaluate(() => ({
      path: window.__state.doc?.path, viewerDocId: window.__state.viewerDocId,
      pdf: !!window.__viewer.pdf, reading: document.body.classList.contains('reading'),
    }));
    assert.deepEqual(activeBeforeDelete, { path: 'retry-paper.pdf', viewerDocId: retryPaper.docId, pdf: true, reading: false },
      'Library retains the active PDF until deletion succeeds');
    const beforeRepeatedClick = deletes().length;
    // Deliver two clicks to the same handler before confirmation resolves.
    await page.$eval(`${card('retry-paper.pdf')} .home-item-x`, button => { button.click(); button.click(); });
    await page.waitForSelector(mask, { visible: true });
    assert.equal(await page.$$eval('.sess-confirm-mask', nodes => nodes.length), 1);
    assert.equal(deletes().length, beforeRepeatedClick, 'confirmation is required before either click can delete');
    const clearedResumeTarget = page.waitForResponse(response => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/state') return false;
      try { return JSON.parse(response.request().postData() || '{}').lastDoc === null; } catch { return false; }
    });
    assert.equal((await confirmDelete('retry-paper.pdf')).status(), 200);
    assert.equal((await clearedResumeTarget).status(), 200, 'cleared resume target is saved before checking disk state');
    await page.waitForFunction(selector => !document.querySelector(selector), {}, card('retry-paper.pdf'));
    assert.equal(exists('retry-paper.pdf'), false);
    assert.equal(hasTabPath(await tabs(), 'retry-paper.pdf'), false);
    assert.equal(deletes().length, beforeRepeatedClick + 1, 'repeated clicks send only one DELETE');
    pass('a failed deletion preserves the file/card and reopening, and retry clears its tab on success');
    assert.deepEqual(await page.evaluate(() => ({ doc: window.__state.doc,
      viewerDocId: window.__state.viewerDocId, pdf: window.__viewer.pdf })),
    { doc: null, viewerDocId: null, pdf: null }, 'the deleted active reader is fully detached');
    const afterActiveDelete = await api('/api/state');
    assert.ok(afterActiveDelete.docs?.[retryPaper.docId], 'active PDF progress remains saved');
    assert.equal(afterActiveDelete.lastDoc, null, 'the deleted active PDF is no longer the resume target');
    const savedProgress = afterActiveDelete.docs[retryPaper.docId];
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 3);
    await library();
    assert.deepEqual((await api('/api/state')).docs[retryPaper.docId], savedProgress,
      'reloading does not prune the intentionally deleted PDF progress');
    assert.equal(hasTabPath(await tabs(), 'retry-paper.pdf'), false);
    await open('two/shared.pdf');
    assert.match(await page.evaluate(() => window.__viewer.getPageText(1)), /Synthetic two shared pdf research/);
    await library();
    pass('active reader teardown preserves progress across reload, repeated clicks delete once, and another PDF opens normally');

    await requestDelete('unread-paper.pdf');
    assert.equal((await confirmDelete('unread-paper.pdf')).status(), 200);
    await page.waitForFunction(selector => !document.querySelector(selector), {}, card('unread-paper.pdf'));
    assert.equal(exists('unread-paper.pdf'), false);
    pass('an unread paper can be deleted without first opening it');

    await open('two/shared.pdf'); await library();
    await requestDelete('one/shared.pdf');
    assert.match(await page.$eval(`${mask} .sess-confirm-body`, node => node.textContent), /one\/shared\.pdf/);
    assert.equal((await confirmDelete('one/shared.pdf')).status(), 200);
    await page.waitForFunction(selector => !document.querySelector(selector), {}, card('one/shared.pdf'));
    assert.equal(exists('one/shared.pdf'), false); assert.ok(exists('two/shared.pdf'));
    assert.ok(hasTabPath(await tabs(), 'two/shared.pdf'), 'same-name sibling tab survives');
    await open('two/shared.pdf');
    assert.match(await page.evaluate(() => window.__viewer.getPageText(1)), /Synthetic two shared pdf research/);
    assert.deepEqual((await api('/api/papers')).papers.map(paper => paper.path), ['two/shared.pdf']);
    pass('same-name PDFs in different folders are targeted by exact path; sibling file/tab remains readable');
    await library(); await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 1);
    await library();
    await page.waitForFunction(() => document.querySelectorAll('#homeList .home-item').length === 1);
    const restoredTabs = await tabs();
    assert.ok(restoredTabs.every(tab => new URL(tab.url, base).searchParams.get('path') === 'two/shared.pdf'));
    assert.ok(await page.$(`${card('two/shared.pdf')} .home-item-x`));
    assert.deepEqual(dialogs, [], 'no native browser confirmation dialogs');
    assert.deepEqual(errors, []);
    pass('reload keeps the remaining card and no deleted tabs, with no native dialogs or model requests');
  }
  console.log(`PASS ${checks.length} checks; evidence: ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  console.error(error); console.error(`Evidence: ${scratch}`); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, reproduce, checks, errors, dialogs, requests, observations }, null, 2), 'utf8');
  try { await browser?.close(); } catch { /* already closed */ }
  if (desktop) await stopChild(reader); else { try { reader?.kill(); } catch { /* already exited */ } }
}
