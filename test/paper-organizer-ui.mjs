/** Library organizer preview, safe partial moves and reader continuity.
 * node test/paper-organizer-ui.mjs [--desktop]
 * Uses disposable data, synthetic PDFs and a loopback SSE model double. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';
import { startOrganizerTestModel, organizerModelInput } from './_organizer-test-model.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `paper-organizer-ui-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const activeName = 'Linear Algebra Notes.pdf', conflictName = 'Numerical Analysis Methods.pdf';
const targetConflict = `数值分析/${conflictName}`, movedActive = `Linear algebra/${activeName}`;
const retryTarget = `Reviewed analysis/${conflictName}`;
const fixtures = [
  [activeName, 'Linear Algebra Notes'], [conflictName, 'Numerical Analysis Methods'],
  ['metadata-paper.pdf', 'Computer Vision Image Recognition'], ['Unclassified Notes.pdf', 'Synthetic unclassified notes'],
  ['12345.pdf', 'Synthetic unclassified document'], [targetConflict, 'A distinct target PDF that must survive'],
];
for (const [relative, title] of fixtures) {
  fs.mkdirSync(path.dirname(path.join(papersDir, relative)), { recursive: true });
  writeTitlePdf(path.join(papersDir, relative), { title });
}
const exists = relative => fs.existsSync(path.join(papersDir, relative));
const digest = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(papersDir, relative))).digest('hex');
const originalHashes = new Map(fixtures.map(([relative]) => [relative, digest(relative)]));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], requests = [], geometry = [], observations = {};
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const row = relative => `#paperOrganizerList .po-row[data-path=${JSON.stringify(relative)}]`;
const moveRequests = () => requests.filter(item => item.path === '/api/move' && item.method === 'POST');
let base, reader, browser, page, model, metadataReading = false, activePdfReads = 0, maxPdfReads = 0;
const metadataRequests = new Set();
async function api(route, body) {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
}
async function organizer() {
  await page.locator('#homeOrganize').click();
  await page.waitForFunction(() => document.querySelector('#paperOrganizer')?.open
    && document.querySelector('#paperOrganizer').getAttribute('aria-busy') === 'false');
  assert.equal(await page.$eval('#paperOrganizerScope', node => node.value), 'all');
  await page.select('#paperOrganizerScope', 'root');
}
async function closeOrganizer() {
  await page.locator('#paperOrganizer .po-actions > button:first-child').click();
  await page.waitForFunction(() => !document.querySelector('#paperOrganizer')?.open);
}
async function editTarget(relative, folder) {
  await page.$eval(`${row(relative)} .po-target input`, (node, value) => {
    node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
  }, folder);
}
async function selectOnly(names) {
  await page.$$eval('#paperOrganizerList .po-row', (rows, names) => {
    for (const node of rows) {
      const input = node.querySelector('input[type="checkbox"]'), selected = names.includes(node.dataset.path);
      if (!input.disabled && input.checked !== selected) input.click();
    }
  }, names);
}
async function applyAndWait(expectedMoves) {
  const before = moveRequests().length;
  await page.locator('#paperOrganizerApply').click();
  await page.waitForFunction(() => document.querySelector('#paperOrganizer')?.getAttribute('aria-busy') === 'false'
    && /已移动/.test(document.querySelector('#paperOrganizer .po-status')?.textContent || ''));
  assert.equal(moveRequests().length - before, expectedMoves);
}
async function screenshotLayout(width) {
  await page.setViewport({ width, height: 940 });
  const result = await page.evaluate(() => {
    const dialog = document.querySelector('#paperOrganizer'), list = document.querySelector('#paperOrganizerList');
    const rect = dialog.getBoundingClientRect();
    const controls = [...dialog.querySelectorAll('button,input,select')].filter(node => node.getClientRects().length && !node.closest('.po-list'));
    return { width: innerWidth, left: rect.left, right: rect.right, bottom: rect.bottom,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth + 1, listOverflow: list.scrollWidth > list.clientWidth + 1,
      controlsFit: controls.every(node => { const r = node.getBoundingClientRect(); return r.left >= rect.left && r.right <= rect.right + 1; }) };
  });
  geometry.push(result);
  assert.ok(result.left >= 0 && result.right <= width && result.bottom <= 940 && !result.documentOverflow
    && !result.dialogOverflow && !result.listOverflow && result.controlsFit, JSON.stringify(result));
  await page.screenshot({ path: path.join(scratch, `organizer-${width}.png`) });
}

try {
  model = await startOrganizerTestModel(record => {
    const input = organizerModelInput(record);
    if (input.task === 'first-page') return model.reply(record, { evidence: '' });
    assert.equal(input.task, 'group');
    const groups = [], unknown = [];
    for (const paper of input.papers) {
      const folder = paper.name === activeName ? 'Proof methods' : paper.name === conflictName ? '数值分析'
        : paper.name === 'metadata-paper.pdf' ? 'Visual reasoning' : '';
      if (!folder) unknown.push(paper.index); else groups.push({ folder, papers: [paper.index] });
    }
    model.reply(record, { groups, unknown });
  });
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('paper-organizer-ui').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', data => fs.appendFileSync(path.join(scratch, 'server.log'), data));
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* service starting */ }
    if (!ready) await wait(100);
  }
  assert.ok(ready);
  const listing = await api('/api/papers');
  assert.equal(path.resolve(listing.dir), papersDir);
  assert.deepEqual(listing.papers.map(paper => paper.path).sort(), fixtures.map(([relative]) => relative).sort());
  const activePaper = listing.papers.find(paper => paper.path === activeName);
  await api('/api/config', { baseURL: model.baseURL, model: 'organizer-ui-synthetic', apiKey: 'SYNTHETIC_ORGANIZER_UI_KEY' });
  for (const asset of ['js/app.js', 'js/paper-organizer.js', 'paper-organizer.css']) {
    assert.equal(await fetch(`${base}/${asset}`).then(response => response.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  pass('only isolated synthetic PDFs and current organizer assets are served');
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== base
        || ['/api/web-search', '/api/ref-search', '/api/import-pdf'].includes(url.pathname)) {
      errors.push(`Unexpected external/model request: ${url.origin}${url.pathname}`); return request.abort();
    }
    if (url.origin === base) requests.push({ path: url.pathname, method: request.method(), query: url.search,
      body: request.method() === 'POST' && url.pathname === '/api/move' ? JSON.parse(request.postData()) : undefined });
    if (metadataReading && url.pathname === '/api/pdf') {
      metadataRequests.add(request); activePdfReads++; maxPdfReads = Math.max(maxPdfReads, activePdfReads);
      setTimeout(() => request.continue(), 80); return;
    }
    return request.continue();
  });
  const completed = request => { if (metadataRequests.delete(request)) activePdfReads--; };
  page.on('requestfinished', completed); page.on('requestfailed', completed);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    localStorage.setItem('reader.session.scopeMode', 'paper');
    localStorage.setItem('reader.session.onEnter', 'latest');
    localStorage.setItem('reader.session.aiTitle', '0');
  });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 6);
  await page.waitForFunction(() => document.querySelectorAll('.hi-preview img').length > 0
    && [...document.querySelectorAll('.hi-preview img')].every(image => image.complete && image.naturalWidth > 0));
  await wait(300);
  const beforePreview = requests.filter(item => item.path === '/api/pdf').length;
  await organizer();
  assert.equal(await page.$eval('#paperOrganizerScope', node => node.value), 'root');
  assert.equal(await page.$$eval('#paperOrganizerList .po-row', rows => rows.length), 5);
  for (const relative of [activeName, conflictName, 'Unclassified Notes.pdf', '12345.pdf', 'metadata-paper.pdf']) {
    assert.deepEqual(await page.$eval(row(relative), node => ({ target: node.querySelector('.po-target input').value,
      selected: node.querySelector('input[type="checkbox"]').checked })), { target: '', selected: false });
  }
  await wait(250);
  assert.equal(requests.filter(item => item.path === '/api/pdf').length, beforePreview, 'opening preview does not read PDFs');
  assert.equal(moveRequests().length, 0);
  assert.equal(model.requests.length, 0, 'preview does not ask the model to classify');
  for (const [relative, hash] of originalHashes) assert.equal(digest(relative), hash);
  pass('preview leaves every destination empty and unselected without PDF reads, model calls or moves');
  await screenshotLayout(1400); await screenshotLayout(480); await page.setViewport({ width: 1400, height: 940 });
  pass('organizer remains within the viewport at 1400px and 480px without horizontal overflow');
  await page.select('#paperOrganizerScope', 'all');
  assert.equal(await page.$$eval('#paperOrganizerList .po-row', rows => rows.length), 6);
  await page.select('#paperOrganizerScope', 'root');
  await closeOrganizer();
  for (const [relative, hash] of originalHashes) assert.equal(digest(relative), hash);
  assert.equal(moveRequests().length, 0);
  pass('changing preview scope and closing it preserves every file');

  await page.locator(`#homeList [data-path=${JSON.stringify(activeName)}] .home-item-go`).click();
  await page.waitForFunction(docId => window.__state?.viewerDocId === docId && window.__viewer?.pdf, {}, activePaper.docId);
  await page.evaluate(async () => {
    window.__ctx.setPanelVisible('chat', true);
    window.__organizerPdf = window.__viewer.pdf;
    window.__viewer.setScale(1.3, { keepCenter: false }); window.__viewer._fitMode = false;
    await window.__viewer.restorePosition({ scrollTop: 170 });
    document.querySelector('#chatInput').value = 'UNSENT_ORGANIZER_DRAFT';
    document.querySelector('#chatInput').dispatchEvent(new Event('input', { bubbles: true }));
    await window.__ctx.flushComposerDrafts();
  });
  const beforeReading = await page.evaluate(() => ({ page: window.__viewer.current, scale: window.__viewer.scale,
    anchor: window.__viewer._captureAnchor(), sid: window.__ctx.activeSession }));
  await api(`/api/notes?doc=${encodeURIComponent(activePaper.docId)}`, { items: [{ id: 'organizer-note', page: 1, text: 'Keep this note' }] });
  const sessionRoute = `/api/session?doc=${encodeURIComponent(activePaper.docId)}&sid=retained-organizer-history`;
  await api(sessionRoute, { title: 'Synthetic retained history', titleSource: 'user', entries: [
    { id: 'keep-question', kind: 'user', block: 'chat', text: 'Keep this saved question', status: 'user' },
    { id: 'keep-answer', kind: 'assistant', block: 'chat', docId: activePaper.docId, docPath: activeName,
      docTitle: activeName, page: 1, text: 'SAVED_ORGANIZER_ANSWER: the source remains available 〔p.1〕.', status: 'complete' },
  ], history: [{ role: 'user', content: 'Keep this saved question' }], ops: [] });
  const savedSession = await api(sessionRoute);
  const globalSessionRoute = '/api/session?doc=default&sid=retained-organizer-history';
  await api(globalSessionRoute, savedSession);
  const progressSaved = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/state'
    && JSON.parse(response.request().postData() || '{}').lastDoc === activePaper.docId);
  await page.locator('#homeBtn').click();
  await page.waitForSelector('#home', { visible: true });
  assert.equal((await progressSaved).status(), 200);
  const savedProgress = (await api('/api/state')).docs[activePaper.docId];
  await organizer();
  await page.$eval('#paperOrganizerInstructions', node => {
    node.value = 'SYNTHETIC_CUSTOM_RULE: group by research method and reuse existing folders when appropriate.';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#paperOrganizerClassify').click();
  await page.waitForFunction(() => document.querySelector('#paperOrganizer').getAttribute('aria-busy') === 'false'
    && [...document.querySelectorAll('#paperOrganizerList .po-target input')].some(node => node.value));
  assert.equal(model.requests[0].body.model, 'organizer-ui-synthetic');
  const classificationInput = JSON.parse(model.requests[0].body.messages.at(-1).content);
  assert.equal(classificationInput.task, 'group');
  assert.ok(classificationInput.preferences.includes('SYNTHETIC_CUSTOM_RULE'));
  assert.equal(await page.$eval(`${row(activeName)} .po-target input`, node => node.value), 'Proof methods');
  assert.equal(await page.$eval(`${row(conflictName)} .po-target input`, node => node.value), '数值分析');
  assert.equal(await page.$eval(`${row('Unclassified Notes.pdf')} input[type="checkbox"]`, node => node.checked), false);
  assert.equal(moveRequests().length, 0);
  pass('filename-first categories use the configured model and preferences without moving files');
  await editTarget(activeName, 'Linear algebra');
  await selectOnly([activeName, conflictName]);
  await applyAndWait(2);
  assert.equal(await page.$eval(row(activeName), node => node.dataset.status), 'done');
  assert.equal(await page.$eval(row(conflictName), node => node.dataset.status), 'error');
  assert.equal(exists(activeName), false); assert.equal(digest(movedActive), originalHashes.get(activeName));
  assert.equal(digest(conflictName), originalHashes.get(conflictName));
  assert.equal(digest(targetConflict), originalHashes.get(targetConflict));
  assert.ok(moveRequests().every(item => item.body.conflict === 'error'));
  assert.ok(!exists(`数值分析/Numerical Analysis Methods (2).pdf`));
  pass('edited destination moves the chosen PDF while a conflicting target preserves both files and reports failure');
  await editTarget(conflictName, 'Reviewed analysis');
  await applyAndWait(1);
  assert.equal(await page.$eval(row(conflictName), node => node.dataset.status), 'done');
  assert.equal(exists(conflictName), false); assert.equal(digest(retryTarget), originalHashes.get(conflictName));
  assert.equal(moveRequests().filter(item => item.body.from === activeName).length, 1);
  assert.equal(digest(targetConflict), originalHashes.get(targetConflict));
  pass('retry after a partial failure moves only the corrected row without repeating completed moves');
  await closeOrganizer();
  const state = await api('/api/state');
  assert.deepEqual(state.docs[activePaper.docId], savedProgress);
  assert.equal(new URL(state.lastUrl, base).searchParams.get('path'), movedActive);
  assert.deepEqual(await api(sessionRoute), savedSession);
  assert.ok((await api(`/api/notes?doc=${encodeURIComponent(activePaper.docId)}`)).items.some(note => note.id === 'organizer-note'));
  const movedTab = await page.evaluate(() => window.__ctx.tabs.find(tab => tab.docId === window.__state.doc.docId));
  assert.equal(movedTab.path, movedActive);
  assert.equal(new URL(movedTab.url, base).searchParams.get('path'), movedActive);
  await page.locator('#homeBtn').click();
  await page.waitForFunction(() => document.body.classList.contains('reading') && !document.body.classList.contains('agent-full')
    && window.__state?.viewerDocId === window.__state?.doc?.docId);
  const afterReading = await page.evaluate(() => ({ path: window.__state.doc.path, page: window.__viewer.current,
    scale: window.__viewer.scale, anchor: window.__viewer._captureAnchor(), samePdf: window.__organizerPdf === window.__viewer.pdf,
    draft: document.querySelector('#chatInput').value, sid: window.__ctx.activeSession }));
  observations.reading = { before: beforeReading, after: afterReading };
  assert.equal(afterReading.path, movedActive); assert.equal(afterReading.page, beforeReading.page);
  assert.equal(afterReading.samePdf, true); assert.equal(afterReading.scale, beforeReading.scale);
  assert.equal(afterReading.anchor.page, beforeReading.anchor.page);
  assert.ok(Math.abs(afterReading.anchor.frac - beforeReading.anchor.frac) < .01);
  assert.equal(afterReading.draft, 'UNSENT_ORGANIZER_DRAFT'); assert.equal(afterReading.sid, beforeReading.sid);
  pass('moving the open PDF preserves its live reader, position, zoom, draft, tab, notes, history and progress');
  await page.locator('#homeBtn').click(); await page.waitForSelector('#home', { visible: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && window.__state?.papers.length === 6
    && window.__state?.viewerDocId === window.__state?.doc?.docId && window.__viewer?.pdf);
  if (await page.evaluate(() => document.body.classList.contains('reading'))) await page.locator('#homeBtn').click();
  await page.waitForSelector('#home', { visible: true });
  assert.ok(await page.$(`#homeList [data-path=${JSON.stringify(movedActive)}]`));
  assert.ok(await page.$(`#homeList [data-path=${JSON.stringify(retryTarget)}]`));
  assert.equal(await page.$(`#homeList [data-path=${JSON.stringify(activeName)}]`), null);
  assert.equal(await page.$(`#homeList [data-path=${JSON.stringify(conflictName)}]`), null);
  const final = (await api('/api/papers')).papers;
  assert.equal(final.find(paper => paper.path === movedActive).docId, activePaper.docId);
  assert.deepEqual(errors, []);
  pass('reload shows new folders and stable document identity without stale cards or unexpected model requests');
  await page.locator(`#homeList [data-path=${JSON.stringify(movedActive)}] .home-item-go`).click();
  await page.waitForFunction(() => window.__state?.viewerDocId === window.__state?.doc?.docId && window.__viewer?.pdf);
  await page.evaluate(async () => {
    window.__ctx.setPanelVisible('chat', true);
    await window.__ctx.openAgentWorkspace({ landing: false });
    await window.__ctx.switchSession('retained-organizer-history', { force: true });
  });
  await page.waitForFunction(() => document.body.classList.contains('agent-full')
    && document.querySelector('#aiArea').textContent.includes('SAVED_ORGANIZER_ANSWER'));
  const sourceMessage = '#aiArea .msg.assistant:has(.page-ref)';
  assert.equal(await page.$eval(sourceMessage, node => node.__sessionRecord.docPath), activeName,
    'the saved answer retains its original path before organizer relocation');
  await page.locator(`${sourceMessage} .pg`).click();
  await page.waitForFunction(path => !document.body.classList.contains('agent-full')
    && window.__state.doc?.path === path && window.__state.viewerDocId === window.__state.doc.docId
    && window.__viewer.current === 1, {}, movedActive);
  observations.sourceNavigation = await page.evaluate(() => ({
    transitioning: document.body.classList.contains('agent-transitioning'),
    expandDisabled: document.querySelector('#agentExpand').disabled,
    answerPresent: document.querySelector('#aiArea').textContent.includes('SAVED_ORGANIZER_ANSWER'),
  }));
  pass('a saved answer with an old path opens the moved PDF from Alina after reload');

  // Docking reveals the reader before its animation and preparation finish.
  // Use the enabled UI control so this navigation cannot bypass its busy guard.
  await page.locator('#agentExpand').click();
  await page.waitForFunction(() => document.body.classList.contains('agent-full')
    && document.querySelector('#aiArea').textContent.includes('SAVED_ORGANIZER_ANSWER'));
  // Ambiguous identities are already possible for same-name PDFs in different
  // folders. Model that live catalog condition without mutating a real file.
  const ambiguity = await page.evaluate(async ({ sourceSelector, movedPath }) => {
    const source = document.querySelector(sourceSelector), original = window.__state.papers.find(paper => paper.path === movedPath);
    const duplicate = { ...original, path: `Another copy/${original.name}`, url: `/api/pdf?path=${encodeURIComponent(`Another copy/${original.name}`)}` };
    window.__state.papers.push(duplicate);
    const before = { path: window.__state.doc.path, openSeq: window.__state.openSeq, pdf: window.__viewer.pdf };
    source.querySelector('.page-ref').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = { stillFull: document.body.classList.contains('agent-full'), path: window.__state.doc.path,
      samePdf: window.__viewer.pdf === before.pdf, sameNavigation: window.__state.openSeq === before.openSeq,
      errorShown: document.body.textContent.includes('找不到《') };
    window.__state.papers.splice(window.__state.papers.indexOf(duplicate), 1);
    return result;
  }, { sourceSelector: sourceMessage, movedPath: movedActive });
  assert.deepEqual(ambiguity, { stillFull: true, path: movedActive, samePdf: true, sameNavigation: true, errorShown: true });
  pass('a stale source path with duplicate document identities does not guess a destination');
  assert.deepEqual(errors, []);
  console.log(`paper-organizer-ui: ${checks.length}/${checks.length}; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${scratch}`); throw error;
} finally {
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, errors, requests, geometry, observations, maxPdfReads,
    model: model?.snapshot() }, null, 2), 'utf8');
  await browser?.close(); if (desktop) await stopChild(reader); else reader?.kill();
  await model?.close();
}
