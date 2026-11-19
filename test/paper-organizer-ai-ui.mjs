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
import { startOrganizerTestModel, organizerModelInput, organizerModelTask } from './_organizer-test-model.mjs';

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
const inputOf = organizerModelInput;
const classificationCalls = (start = 0) => model.requests.slice(start).filter(record => organizerModelTask(record) === 'classify');
const planningCalls = (start = 0) => model.requests.slice(start).filter(record => organizerModelTask(record) === 'plan');
function planAnswer(record) {
  const input = inputOf(record), paths = input.maxDepth === 1 ? ['海洋生态', '已有研究'] : ['海洋生态/珊瑚修复', 'Existing/Curated'];
  return { folders: paths.slice(0, Math.min(2, input.maxFolders, input.paperCount))
    .map(path => ({ path, description: `Synthetic global scope for ${path}` })) };
}
function answer(record, overrides = {}) {
  const input = inputOf(record), allowed = input.allowedFolders.map(folder => folder.path);
  return { items: inputOf(record).papers.map(paper => ({ id: paper.id,
    folder: paper.path === names[2] && allowed.length > 1 ? allowed[1] : allowed[0],
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
  assert.equal(await page.$eval('#paperOrganizerScope', node => node.value), 'all');
  await page.select('#paperOrganizerScope', 'root');
  await page.select('#paperOrganizerDepth', '2');
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
    assert.equal(record.body.model, 'organizer-ai-synthetic');
    const input = inputOf(record);
    if (input.task === 'plan') {
      assert.ok(input.papers.length > 0 && input.papers.length <= 200);
      if (mode === 'hold-plan') { held = record; model.start(record); return; }
      return model.reply(record, planAnswer(record));
    }
    assert.equal(input.task, 'classify'); phaseCount++;
    assert.ok(input.papers.length > 0 && input.papers.length <= 12);
    if (mode === 'invalid-path') return model.reply(record, answer(record, { folder: '../Outside' }));
    if (mode === 'outside-plan') return model.reply(record, answer(record, { folder: 'New topic/Unplanned' }));
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
  const initialCalls = classificationCalls(initialCheckpoint), initialPapers = initialCalls.flatMap(record => inputOf(record).papers);
  assert.equal(planningCalls(initialCheckpoint).length, 1);
  assert.deepEqual(initialCalls.map(record => inputOf(record).papers.length), [12, 12, 12, 8]);
  assert.equal(new Set(initialPapers.map(paper => paper.path)).size, 44);
  assert.ok(!initialPapers.some(paper => paper.path === names[0] || paper.path === 'Existing/Curated/Seed.pdf'));
  assert.ok(initialCalls.every(record => inputOf(record).classificationInstructions.includes('CUSTOM_CORAL_POLICY')
    && inputOf(record).allowedFolders.some(folder => folder.path === 'Existing/Curated')));
  assert.ok(inputOf(planningCalls(initialCheckpoint)[0]).existingFolders.includes('Existing/Curated'));
  assert.ok(initialCalls.every(record => JSON.stringify(inputOf(record).allowedFolders) === JSON.stringify(inputOf(initialCalls[0]).allowedFolders)));
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
  pass('one global plan constrains all four classification batches across both UI pages and preserves existing folders and manual edits');

  await page.locator(`${row(names[1])} input[type="checkbox"]`).click();
  await search('Batch-04'); await page.locator('#paperOrganizerSelect').click(); await search('');
  const retryCheckpoint = model.requests.length; setMode('good'); await classify();
  assert.deepEqual(classificationCalls(retryCheckpoint).flatMap(record => inputOf(record).papers.map(paper => paper.path)), [names[5]]);
  assert.equal((await rows()).find(row => row.path === names[1]).selected, true);
  assert.equal((await rows()).find(row => row.path === names[4]).selected, true);
  pass('low-confidence suggestions need confirmation; individual and header confirmation protect them while AI retries only the unresolved paper');

  await instructions('INVALID_RESPONSE_POLICY');
  for (const confirmed of [names[1], names[4]]) {
    const confirmedRow = (await rows()).find(row => row.path === confirmed);
    assert.equal(confirmedRow.target, '海洋生态/珊瑚修复'); assert.equal(confirmedRow.selected, true);
  }
  await search('Batch-03');
  for (const invalid of ['invalid-path', 'outside-plan', 'invalid-json']) {
    setMode(invalid); const checkpoint = model.requests.length; await classify();
    assert.equal(classificationCalls(checkpoint).length, 1);
    const invalidRow = (await rows())[0];
    assert.equal(invalidRow.target, ''); assert.equal(invalidRow.selected, false);
    if (invalid === 'invalid-json') assert.match(await page.$eval('#paperOrganizer .po-status', node => node.textContent), /分类失败/);
    else assert.match(invalidRow.reason, /无效|规划|目录/);
    assert.ok(!fs.existsSync(path.join(scratch, 'Outside')));
  }
  setMode('good'); await classify();
  assert.equal((await rows())[0].target, '海洋生态/珊瑚修复');
  pass('unsafe paths, safe but unplanned categories and malformed output cannot create new destinations and remain retryable');

  await search(''); await instructions('RETRY_BATCH_POLICY'); setMode('fail-second');
  const failCheckpoint = model.requests.length; await classify();
  assert.equal(classificationCalls(failCheckpoint).length, 2);
  assert.equal(planningCalls(failCheckpoint).length, 1);
  const completePaths = inputOf(classificationCalls(failCheckpoint)[0]).papers.map(paper => paper.path);
  assert.ok((await rows()).filter(row => completePaths.includes(row.path)).every(row => row.selected && row.target));
  setMode('good'); const recoverCheckpoint = model.requests.length; await classify();
  const recovered = classificationCalls(recoverCheckpoint).flatMap(record => inputOf(record).papers.map(paper => paper.path));
  assert.equal(planningCalls(recoverCheckpoint).length, 0, 'same-scope retry reuses the original global plan');
  assert.equal(recovered.length, 30); assert.ok(recovered.every(path => !completePaths.includes(path)));
  assert.ok(!recovered.some(path => [names[0], names[1], names[4]].includes(path)));
  assert.equal((await rows()).find(row => row.path === names[0]).target, 'Manual/My coral shelf');
  pass('a failed batch stops later requests and retry preserves completed batches and the manual destination');

  await instructions('CANCEL_AFTER_BATCH_POLICY'); setMode('hold-second');
  const cancelCheckpoint = model.requests.length; await start(); await waitHeld();
  const cancelled = held;
  await page.locator('#paperOrganizer .po-actions > button:nth-child(2)').click(); await idle();
  const beforeLate = await rows();
  assert.equal(classificationCalls(cancelCheckpoint).length, 2);
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
  assert.deepEqual(classificationCalls(reopenedCheckpoint).flatMap(record => inputOf(record).papers.map(paper => paper.path)), [names[44]]);
  assert.equal((await rows())[0].target, '海洋生态/珊瑚修复');
  pass('closing cancels classification, reopening rejects old results, and a new search classifies only the matching paper');

  await close(); await open(); await page.select('#paperOrganizerDepth', '1');
  await instructions('CANCEL_GLOBAL_PLAN_POLICY'); setMode('hold-plan');
  const planningCheckpoint = model.requests.length; await start(); await waitHeld();
  const cancelledPlan = held;
  await page.locator('#paperOrganizer .po-actions > button:nth-child(2)').click(); await idle();
  assert.equal(planningCalls(planningCheckpoint).length, 1);
  assert.equal(classificationCalls(planningCheckpoint).length, 0);
  model.reply(cancelledPlan, planAnswer(cancelledPlan)); await wait(200);
  assert.ok((await rows()).every(row => !row.target && !row.selected));
  setMode('good'); const planRetryCheckpoint = model.requests.length; await classify();
  assert.equal(planningCalls(planRetryCheckpoint).length, 1);
  assert.equal(classificationCalls(planRetryCheckpoint).length, 4);
  assert.equal(inputOf(planningCalls(planRetryCheckpoint)[0]).maxDepth, 1);
  const grouped = () => page.$$eval('#paperOrganizerPlan .po-group', nodes => nodes.map(node => ({
    folder: node.dataset.folder, count: Number(node.querySelector('.po-group-count').textContent.match(/\d+/)[0]),
  })));
  const groups = await grouped();
  assert.equal(groups.length, 2); assert.equal(groups.reduce((sum, group) => sum + group.count, 0), 45);
  assert.ok(groups.every(group => !group.folder.includes('/')));
  pass('cancelled global planning cannot start classification; retry builds a bounded single-level plan with complete cross-page counts');
  const renameGroup = async (from, to) => {
    const selector = `#paperOrganizerPlan .po-group[data-folder=${JSON.stringify(from)}]`;
    await field(`${selector} .po-group-target`, to); await page.locator(`${selector} .po-group-apply`).click();
  };
  await renameGroup(groups[0].folder, '统一研究');
  assert.equal((await grouped()).find(group => group.folder === '统一研究').count, groups[0].count);
  await renameGroup(groups[1].folder, '统一研究');
  assert.deepEqual(await grouped(), [{ folder: '统一研究', count: 45 }]);
  assert.ok((await rows()).every(row => row.target === '统一研究'));
  await page.locator('#paperOrganizer .po-page > button:last-child').click();
  assert.equal((await rows()).length, 5); assert.ok((await rows()).every(row => row.target === '统一研究'));
  await instructions('KEEP_MANUAL_GROUP_EDITS');
  assert.deepEqual(await grouped(), [{ folder: '统一研究', count: 45 }]);
  assert.equal(await page.$eval('#paperOrganizerClassify', node => node.disabled), true);
  await assertNoMutation();
  pass('category rename and merge update every page and counts, retain manual choices, and never create or move files in preview');

  await close(); await open(); await search('Batch-0');
  await instructions('MIXED_MANUAL_DEPTH_POLICY'); setMode('good'); await classify();
  await renameGroup('海洋生态/珊瑚修复', '人工归档');
  const mixedRetryCheckpoint = model.requests.length; await classify();
  assert.equal(planningCalls(mixedRetryCheckpoint).length, 1);
  assert.deepEqual(classificationCalls(mixedRetryCheckpoint).flatMap(record => inputOf(record).papers.map(paper => paper.path)), [names[2]]);
  assert.ok((await rows()).filter(row => row.path !== names[2]).every(row => row.target === '人工归档'));
  pass('a manual single-level group inside a two-level plan triggers replanning only for the remaining automatic suggestion');
  const beforeTitleRefresh = model.requests.length;
  await page.locator('#paperOrganizerRead').click(); await idle();
  assert.equal(model.requests.length, beforeTitleRefresh);
  const titleRetryCheckpoint = model.requests.length; await classify();
  assert.equal(planningCalls(titleRetryCheckpoint).length, 1);
  assert.deepEqual(classificationCalls(titleRetryCheckpoint).flatMap(record => inputOf(record).papers.map(paper => paper.path)), [names[2]]);
  assert.ok((await rows()).filter(row => row.path !== names[2]).every(row => row.target === '人工归档'));
  pass('refreshing local title evidence invalidates the old plan while preserving every manual group destination');

  await assertNoMutation();
  assert.deepEqual(errors, []); assert.deepEqual(model.errors, []);
  assert.ok(failedRequests.every(request => request.error === 'net::ERR_ABORTED'), JSON.stringify(failedRequests));
  assert.equal(requests.filter(request => request.path === '/api/chat').length, model.requests.length);
  await page.screenshot({ path: path.join(scratch, 'completed.png') });
  await page.setViewport({ width: 480, height: 940 });
  const planLayout = await page.$eval('#paperOrganizer', dialog => ({
    overflow: dialog.scrollWidth > dialog.clientWidth + 1,
    groupsOverflow: dialog.querySelector('.po-groups').scrollWidth > dialog.querySelector('.po-groups').clientWidth + 1,
    left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right,
  }));
  assert.ok(!planLayout.overflow && !planLayout.groupsOverflow && planLayout.left >= 0 && planLayout.right <= 480, JSON.stringify(planLayout));
  await page.screenshot({ path: path.join(scratch, 'completed480.png') });
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
