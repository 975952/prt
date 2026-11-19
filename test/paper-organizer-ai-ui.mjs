/** Real /api/chat integration with a local SSE model and disposable PDF fixtures.
 * node test/paper-organizer-ai-ui.mjs [--desktop] */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';
import { startOrganizerTestModel } from './_organizer-test-model.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `paper-organizer-ai-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const names = Array.from({ length: 45 }, (_, index) => `Batch-${String(index).padStart(2, '0')}.pdf`);
for (const name of [...names, 'Existing/Curated/Seed.pdf']) {
  fs.mkdirSync(path.dirname(path.join(papersDir, name)), { recursive: true });
  writeTitlePdf(path.join(papersDir, name), { title: `Synthetic coral restoration study ${path.basename(name, '.pdf')}` });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], requests = [], failedRequests = [], observations = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const row = name => `#paperOrganizerList .po-row[data-path=${JSON.stringify(name)}]`;
let base, model, reader, browser, page, mode = 'initial', phaseCount = 0, held;
const inputOf = record => JSON.parse(record.body.messages.at(-1).content);
function answer(record, overrides = {}) {
  return { items: inputOf(record).papers.map(paper => ({ id: paper.id,
    folder: paper.path === names[2] ? 'Existing/Curated' : '海洋生态/珊瑚修复',
    confidence: mode === 'initial' && [names[1], names[4], names[5]].includes(paper.path) ? 0.35 : 0.93,
    reason: 'Synthetic AI analysis of coral restoration title', ...overrides,
  })) };
}
function setMode(next) { mode = next; phaseCount = 0; held = null; }
async function api(route, body) {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
}
async function open() {
  await page.locator('#homeOrganize').click();
  await page.waitForFunction(() => document.querySelector('#paperOrganizer')?.open
    && document.querySelector('#paperOrganizer').getAttribute('aria-busy') === 'false');
}
async function idle() {
  await page.waitForFunction(() => document.querySelector('#paperOrganizer').getAttribute('aria-busy') === 'false');
}
async function field(selector, value) {
  await page.$eval(selector, (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
}
async function instructions(value) { await field('#paperOrganizerInstructions', value); }
async function search(value) {
  await field('#paperOrganizerSearch', value);
  await wait(150);
}
async function start() { await page.locator('#paperOrganizerClassify').click(); }
async function classify() { await start(); await idle(); }
async function close() {
  await page.locator('#paperOrganizer .po-actions > button:first-child').click();
  await page.waitForFunction(() => !document.querySelector('#paperOrganizer').open);
}
async function rows() {
  return page.$$eval('#paperOrganizerList .po-row', nodes => nodes.map(node => ({
    path: node.dataset.path, target: node.querySelector('.po-target input').value,
    selected: node.querySelector('input[type="checkbox"]').checked, status: node.dataset.status,
    reason: node.querySelector('.po-reason').textContent,
  })));
}
async function waitHeld() {
  for (let attempt = 0; attempt < 200 && !held; attempt++) await wait(50);
  assert.ok(held, 'local fake model received the gated classification request');
}
async function assertNoMutation() {
  assert.equal(requests.filter(request => request.path === '/api/move').length, 0);
  assert.deepEqual((await api('/api/papers')).papers.map(paper => paper.path).sort(), [...names, 'Existing/Curated/Seed.pdf'].sort());
}

try {
  model = await startOrganizerTestModel(record => {
    phaseCount++;
    assert.equal(record.body.model, 'organizer-ai-synthetic');
    const input = inputOf(record);
    assert.ok(input.papers.length > 0 && input.papers.length <= 12);
    if (mode === 'invalid-path') return model.reply(record, answer(record, { folder: '../Outside' }));
    if (mode === 'invalid-json') return model.reply(record, 'This is not the required classification JSON.');
    if (mode === 'fail-second' && phaseCount === 2) {
      record.response.writeHead(500, { 'Content-Type': 'application/json' });
      record.finished = true; record.response.end(JSON.stringify({ error: { message: 'Synthetic classifier unavailable' } })); return;
    }
    if (mode === 'hold-first' || mode === 'hold-second' && phaseCount === 2) {
      held = record; model.start(record); return;
    }
    model.reply(record, answer(record));
  });
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('paper-organizer-ai').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', data => fs.appendFileSync(path.join(scratch, 'server.log'), data));
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready);
  assert.equal(path.resolve((await api('/api/papers')).dir), papersDir);
  for (const asset of ['js/app.js', 'js/paper-organizer.js', 'js/paper-classifier.js', 'js/prompts/capabilities/organizer.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(response => response.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  await api('/api/config', { baseURL: model.baseURL, model: 'organizer-ai-synthetic', apiKey: 'SYNTHETIC_ORGANIZER_AI_KEY' });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== base || ['/api/web-search', '/api/ref-search', '/api/import-pdf'].includes(url.pathname)) {
      errors.push(`Unexpected external request: ${url.origin}${url.pathname}`); return request.abort();
    }
    if (url.origin === base) requests.push({ path: url.pathname, method: request.method(), query: url.search });
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN'); localStorage.setItem('reader.session.aiTitle', '0');
  });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 46);
  await open();
  assert.equal((await rows()).length, 40);
  assert.ok((await rows()).every(row => !row.target && !row.selected));
  assert.equal(model.requests.length, 0);
  await field(`${row(names[0])} .po-target input`, 'Manual/My coral shelf');
  await instructions('CUSTOM_CORAL_POLICY: organize by ecosystem and reuse Existing/Curated when appropriate.');
  const initialCheckpoint = model.requests.length;
  await classify();
  const initialCalls = model.requests.slice(initialCheckpoint), initialPapers = initialCalls.flatMap(record => inputOf(record).papers);
  assert.deepEqual(initialCalls.map(record => inputOf(record).papers.length), [12, 12, 12, 8]);
  assert.equal(new Set(initialPapers.map(paper => paper.path)).size, 44);
  assert.ok(!initialPapers.some(paper => paper.path === names[0] || paper.path === 'Existing/Curated/Seed.pdf'));
  assert.ok(initialCalls.every(record => inputOf(record).classificationInstructions.includes('CUSTOM_CORAL_POLICY')
    && inputOf(record).existingFolders.includes('Existing/Curated')));
  assert.ok(initialPapers.every(paper => paper.title.includes('Synthetic coral restoration study')));
  const firstPage = await rows();
  assert.equal(firstPage.find(item => item.path === names[0]).target, 'Manual/My coral shelf');
  assert.equal(firstPage.find(item => item.path === names[1]).selected, false);
  assert.equal(firstPage.find(item => item.path === names[2]).target, 'Existing/Curated');
  assert.equal(firstPage.find(item => item.path === names[3]).target, '海洋生态/珊瑚修复');
  await page.locator('#paperOrganizer .po-page > button:last-child').click();
  assert.equal((await rows()).length, 5); assert.ok((await rows()).every(row => row.target === '海洋生态/珊瑚修复' && row.selected));
  await page.locator('#paperOrganizer .po-page > button:first-child').click();
  await assertNoMutation();
  observations.push({ phase: 'initial', calls: initialCalls.map(record => inputOf(record).papers.length), rows: firstPage });
  pass('45 PDFs classify across four bounded batches and both UI pages, reuse existing folders, accept novel categories and preserve manual edits');

  await page.locator(`${row(names[1])} input[type="checkbox"]`).click();
  await search('Batch-04'); await page.locator('#paperOrganizerSelect').click(); await search('');
  const retryCheckpoint = model.requests.length; setMode('good'); await classify();
  assert.deepEqual(model.requests.slice(retryCheckpoint).flatMap(record => inputOf(record).papers.map(paper => paper.path)), [names[5]]);
  assert.equal((await rows()).find(row => row.path === names[1]).selected, true);
  assert.equal((await rows()).find(row => row.path === names[4]).selected, true);
  pass('low-confidence suggestions need confirmation; individual and header confirmation protect them while AI retries only the unresolved paper');

  await instructions('INVALID_RESPONSE_POLICY');
  for (const confirmed of [names[1], names[4]]) {
    const confirmedRow = (await rows()).find(row => row.path === confirmed);
    assert.equal(confirmedRow.target, '海洋生态/珊瑚修复'); assert.equal(confirmedRow.selected, true);
  }
  await search('Batch-03');
  for (const invalid of ['invalid-path', 'invalid-json']) {
    setMode(invalid); const checkpoint = model.requests.length; await classify();
    assert.equal(model.requests.length - checkpoint, 1);
    const invalidRow = (await rows())[0];
    assert.equal(invalidRow.target, ''); assert.equal(invalidRow.selected, false);
    if (invalid === 'invalid-json') assert.match(await page.$eval('#paperOrganizer .po-status', node => node.textContent), /分类失败/);
    else assert.match(invalidRow.reason, /无效/);
    assert.ok(!fs.existsSync(path.join(scratch, 'Outside')));
  }
  setMode('good'); await classify();
  assert.equal((await rows())[0].target, '海洋生态/珊瑚修复');
  pass('unsafe folders and malformed model output are rejected with retryable errors and no file mutation');

  await search(''); await instructions('RETRY_BATCH_POLICY'); setMode('fail-second');
  const failCheckpoint = model.requests.length; await classify();
  assert.equal(model.requests.length - failCheckpoint, 2);
  const completePaths = inputOf(model.requests[failCheckpoint]).papers.map(paper => paper.path);
  assert.ok((await rows()).filter(row => completePaths.includes(row.path)).every(row => row.selected && row.target));
  setMode('good'); const recoverCheckpoint = model.requests.length; await classify();
  const recovered = model.requests.slice(recoverCheckpoint).flatMap(record => inputOf(record).papers.map(paper => paper.path));
  assert.equal(recovered.length, 30); assert.ok(recovered.every(path => !completePaths.includes(path)));
  assert.ok(!recovered.some(path => [names[0], names[1], names[4]].includes(path)));
  assert.equal((await rows()).find(row => row.path === names[0]).target, 'Manual/My coral shelf');
  pass('a failed batch stops later requests and retry preserves completed batches and the manual destination');

  await instructions('CANCEL_AFTER_BATCH_POLICY'); setMode('hold-second');
  const cancelCheckpoint = model.requests.length; await start(); await waitHeld();
  const cancelled = held;
  await page.locator('#paperOrganizer .po-actions > button:nth-child(2)').click(); await idle();
  const beforeLate = await rows();
  assert.equal(model.requests.length - cancelCheckpoint, 2);
  assert.equal(beforeLate.filter(row => row.target && ![names[0], names[1], names[4]].includes(row.path)).length, 12);
  model.reply(cancelled, answer(cancelled, { folder: 'Late/Must not appear' })); await wait(200);
  assert.deepEqual(await rows(), beforeLate);
  pass('stop keeps the first complete batch, aborts the pending batch and ignores its late result');

  await instructions('CLOSE_PENDING_POLICY'); setMode('hold-first'); await start(); await waitHeld();
  const closed = held; await close(); await open();
  assert.ok((await rows()).every(row => !row.target && !row.selected));
  model.reply(closed, answer(closed, { folder: 'Late/Closed dialog' })); await wait(200);
  assert.ok((await rows()).every(row => !row.target && !row.selected));
  await search('Batch-44'); setMode('good'); const reopenedCheckpoint = model.requests.length; await classify();
  assert.deepEqual(model.requests.slice(reopenedCheckpoint).flatMap(record => inputOf(record).papers.map(paper => paper.path)), [names[44]]);
  assert.equal((await rows())[0].target, '海洋生态/珊瑚修复');
  pass('closing cancels classification, reopening rejects old results, and a new search classifies only the matching paper');

  await assertNoMutation();
  assert.deepEqual(errors, []); assert.deepEqual(model.errors, []);
  assert.ok(failedRequests.every(request => request.error === 'net::ERR_ABORTED'), JSON.stringify(failedRequests));
  assert.equal(requests.filter(request => request.path === '/api/chat').length, model.requests.length);
  await page.screenshot({ path: path.join(scratch, 'completed.png') });
  pass('every classification used the real chat endpoint and local fake model, with no moves, external calls or page errors');
  console.log(`paper-organizer-ai: ${checks.length}/${checks.length}; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  observations.push({ phase: 'failure', rows: await rows().catch(() => []), dialog: await page?.$eval('#paperOrganizer', node => node.textContent).catch(() => '') });
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${scratch}`); throw error;
} finally {
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, errors, requests, failedRequests, observations,
    model: model?.snapshot() }, null, 2), 'utf8');
  await browser?.close(); if (desktop) await stopChild(reader); else reader?.kill(); await model?.close();
}
