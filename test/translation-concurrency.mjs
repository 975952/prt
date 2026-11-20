/** Isolated streaming races: independent selections, three slots, local cancellation and document switches. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `translation-concurrency-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
for (const name of ['concurrency-first.pdf', 'concurrency-next.pdf']) {
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, name));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const requests = [], errors = [], dialogs = [], checks = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
  }
  const source = JSON.stringify(body.messages?.filter(m => m.role === 'user') || []);
  const request = { body, source, res, closed: false };
  res.on('close', () => { request.closed = true; });
  requests.push(request);
});
const matching = marker => requests.filter(request => request.source.includes(marker));
const next = async marker => {
  for (let i = 0; i < 150 && !matching(marker).length; i++) await wait(100);
  assert.equal(matching(marker).length, 1, `exactly one upstream request for ${marker}`);
  return matching(marker)[0];
};
const emit = (request, text, done = false) => {
  if (request.res.destroyed || request.res.writableEnded) return;
  if (!request.res.headersSent) request.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  request.res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  if (done) request.res.end('data: [DONE]\n\n');
};
const fail = request => {
  request.res.writeHead(400, { 'Content-Type': 'application/json' });
  request.res.end(JSON.stringify({ error: { message: 'Synthetic isolated translation failure' } }));
};
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
let reader, browser, page;
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('translation-concurrency').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready, 'isolated reader starts');
  for (const asset of ['js/app.js', 'js/translation-queue.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `current ${asset}`);
  }
  const configured = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'concurrency-mock', apiKey: 'SYNTHETIC_CONCURRENCY_TEST_KEY' }) });
  assert.ok(configured.ok);
  const library = (await fetch(`${base}/api/papers`).then(r => r.json())).papers;
  const firstDoc = library.find(p => p.name === 'concurrency-first.pdf'), secondDoc = library.find(p => p.name === 'concurrency-next.pdf');
  assert.ok(firstDoc && secondDoc);
  const session = doc => fetch(`${base}/api/session?doc=${encodeURIComponent(doc.docId)}&sid=__translate`).then(r => r.json());
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 960 } });
  page = await browser.newPage(); page.on('pageerror', e => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.agent.welcome.v1', 'acknowledged'));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto(`${base}/?open=concurrency-first.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  const loaded = () => page.waitForFunction(() => window.__viewer?.pdf && window.__ctx?.doTranslate
    && window.__state.viewerDocId === window.__state.doc?.docId);
  await loaded();
  const row = marker => page.evaluate(marker => window.__state.sessionEntries.find(r => r.block === 'translate' && r.quote?.includes(marker)), marker);
  const rows = markers => page.evaluate(markers => [...(window.__state.blockMeta.translate?.body?.children || [])]
    .map(n => n.__sessionRecord).filter(r => markers.some(m => r?.quote?.includes(m))).map(r => ({ id: r.id, quote: r.quote, text: r.text, status: r.status })), markers);
  const select = async marker => {
    await page.evaluate(text => {
      window.__testTranslationPromises ||= [];
      window.__testTranslationPromises.push(window.__ctx.doTranslate({ text, cleanText: text, page: 1,
        box: { left: 410, right: 610, top: 200, bottom: 230 } }, { force: true }));
    }, marker);
    await page.waitForFunction(marker => window.__state.sessionEntries.some(r => r.block === 'translate' && r.quote?.includes(marker)), {}, marker);
  };
  const status = (marker, value) => page.waitForFunction(({ marker, value }) => window.__state.sessionEntries.some(r =>
    r.block === 'translate' && r.quote?.includes(marker) && r.status === value), {}, { marker, value });
  const idle = () => page.waitForFunction(() => !window.__state.busy);
  const remove = async marker => page.evaluate(marker => {
    const item = [...document.querySelectorAll('.msg')].find(n => n.__sessionRecord?.quote?.includes(marker));
    if (!item?.querySelector('.translation-delete')) throw Error(`Missing delete control: ${marker}`);
    item.querySelector('.translation-delete').click();
    if (item.isConnected) throw Error(`Deleted item remained connected: ${marker}`);
  }, marker);
  const sidebar = async () => {
    await page.evaluate(() => { window.__ctx.setPanelVisible('translate', true); window.__ctx.applyPanels(); });
    if (await page.evaluate(() => document.body.classList.contains('no-right'))) await page.click('#topbarRightToggle');
    await page.waitForFunction(() => !document.body.classList.contains('no-right') && !document.body.classList.contains('right-empty'));
  };
  const input = async marker => {
    await sidebar();
    if (await page.$eval('#rightSide', n => n.dataset.activePanel) !== 'translate') await page.click('.aibar-btn[data-block="translate"]');
    await page.$eval('#chatInput', (n, text) => { n.value = text; n.dispatchEvent(new Event('input', { bubbles: true })); }, marker);
    assert.equal(await page.$eval('#sendBtn', n => n.disabled), false, 'translation send remains enabled');
    await page.click('#sendBtn');
    await page.waitForFunction(marker => window.__state.sessionEntries.some(r => r.block === 'translate' && r.quote?.includes(marker)), {}, marker);
  };

  // Closing a popup detaches only its presentation; the previous result survives in the sidebar.
  await sidebar(); await page.click('#topbarRightToggle');
  await page.waitForFunction(() => document.body.classList.contains('no-right') || document.body.classList.contains('right-empty'));
  await select('CONCURRENCY_FLOAT_A'); const floatA = await next('CONCURRENCY_FLOAT_A');
  emit(floatA, 'Floating A first. ');
  await page.waitForFunction(() => document.querySelector('#translationCardText').textContent.includes('Floating A first.'));
  await page.click('#translationCardClose');
  await select('CONCURRENCY_FLOAT_B'); const floatB = await next('CONCURRENCY_FLOAT_B');
  assert.equal(floatA.res.writableEnded, false, 'B requested before A finishes');
  emit(floatB, 'Floating B alone.', true); await status('CONCURRENCY_FLOAT_B', 'complete');
  emit(floatA, 'A late tail.', true); await idle(); await wait(150);
  assert.equal(await page.$eval('#translationCardText', n => n.textContent.trim()), 'Floating B alone.');
  assert.equal((await row('CONCURRENCY_FLOAT_A')).text, 'Floating A first. A late tail.');
  assert.equal((await row('CONCURRENCY_FLOAT_B')).text, 'Floating B alone.');
  pass('closed A popup permits immediate B; late A output cannot overwrite B and A remains saved');

  // Context delay and completion order must not determine sidebar position.
  await page.click('#translationCardClose'); await sidebar();
  await page.evaluate(() => {
    const original = window.__viewer.getContextAround.bind(window.__viewer);
    window.__testOriginalContext = original;
    window.__viewer.getContextAround = async (page, text) => {
      if (text === 'CONCURRENCY_SIDE_A') await new Promise(resolve => { window.__releaseTranslationContext = resolve; });
      return original(page, text);
    };
  });
  const ordered = ['CONCURRENCY_SIDE_A', 'CONCURRENCY_SIDE_B', 'CONCURRENCY_SIDE_C', 'CONCURRENCY_SIDE_D'];
  for (const marker of ordered) await select(marker);
  const sideB = await next(ordered[1]), sideC = await next(ordered[2]);
  assert.equal(matching(ordered[0]).length, 0); assert.equal(matching(ordered[3]).length, 0);
  const beforeOrder = (await rows(ordered)).map(r => r.quote);
  assert.deepEqual(beforeOrder, [...ordered].reverse());
  await page.evaluate(() => window.__releaseTranslationContext());
  const sideA = await next(ordered[0]); await wait(250);
  assert.equal(matching(ordered[3]).length, 0, 'fourth request stays queued while three slots are occupied');
  emit(sideC, 'Side C complete.', true); await status(ordered[2], 'complete');
  const sideD = await next(ordered[3]);
  emit(sideB, 'Side B complete.', true); emit(sideD, 'Side D complete.', true); emit(sideA, 'Side A complete.', true);
  await idle();
  assert.deepEqual((await rows(ordered)).map(r => r.quote), beforeOrder);
  for (const [i, letter] of ['A', 'B', 'C', 'D'].entries()) assert.equal((await row(ordered[i])).text, `Side ${letter} complete.`);
  await page.evaluate(() => { window.__viewer.getContextAround = window.__testOriginalContext; });
  pass('three selections run concurrently, fourth waits, delayed context and out-of-order completion preserve entry order/text');

  const cancellations = ['CONCURRENCY_CANCEL_A', 'CONCURRENCY_CANCEL_B', 'CONCURRENCY_ERROR_C', 'CONCURRENCY_QUEUE_D', 'CONCURRENCY_QUEUE_E'];
  for (const marker of cancellations) await select(marker);
  const cancelA = await next(cancellations[0]), cancelB = await next(cancellations[1]), errorC = await next(cancellations[2]);
  assert.equal(matching(cancellations[3]).length, 0); assert.equal(matching(cancellations[4]).length, 0);
  const deletedIds = [(await row(cancellations[0])).id, (await row(cancellations[3])).id];
  await remove(cancellations[3]); await remove(cancellations[0]);
  const queueE = await next(cancellations[4]); emit(cancelA, 'Deleted A must not return.', true);
  await select('CONCURRENCY_ERROR_QUEUE_F');
  assert.equal(matching('CONCURRENCY_ERROR_QUEUE_F').length, 0);
  fail(errorC); await status(cancellations[2], 'failed');
  const queueF = await next('CONCURRENCY_ERROR_QUEUE_F');
  assert.equal(cancelB.res.writableEnded, false); assert.equal(queueE.res.writableEnded, false);
  emit(cancelB, 'B survives sibling deletion.', true); emit(queueE, 'E survives sibling failure.', true);
  emit(queueF, 'F uses the failed request slot.', true); await idle();
  assert.equal(matching(cancellations[3]).length, 0, 'deleted queued request is never sent');
  assert.equal((await row(cancellations[1])).text, 'B survives sibling deletion.');
  assert.equal((await row(cancellations[4])).text, 'E survives sibling failure.');
  assert.equal((await row('CONCURRENCY_ERROR_QUEUE_F')).text, 'F uses the failed request slot.');
  await page.evaluate(() => window.__ctx.saveSessionNow());
  const saved = await session(firstDoc);
  assert(deletedIds.every(id => !saved.entries.some(r => r.id === id)));
  pass('deleting active or queued work affects only that item; failure frees its slot and deleted work stays absent');

  await input('CONCURRENCY_INPUT_A'); const inputA = await next('CONCURRENCY_INPUT_A');
  await input('CONCURRENCY_INPUT_B'); const inputB = await next('CONCURRENCY_INPUT_B');
  await select('CONCURRENCY_SELECTION_C'); const selectionC = await next('CONCURRENCY_SELECTION_C');
  assert.equal(inputA.res.writableEnded, false); assert.equal(inputB.res.writableEnded, false);
  emit(selectionC, 'Selection C independent.', true); emit(inputB, 'Input B independent.', true); emit(inputA, 'Input A independent.', true); await idle();
  assert.equal((await row('CONCURRENCY_INPUT_A')).text, 'Input A independent.');
  assert.equal((await row('CONCURRENCY_INPUT_B')).text, 'Input B independent.');
  assert.equal((await row('CONCURRENCY_SELECTION_C')).text, 'Selection C independent.');
  pass('normal input submissions and selections share parallel slots without blocking each other');

  const old = ['CONCURRENCY_OLD_A', 'CONCURRENCY_OLD_B', 'CONCURRENCY_OLD_C', 'CONCURRENCY_OLD_QUEUED'];
  for (const marker of old) await select(marker);
  const oldRequests = await Promise.all(old.slice(0, 3).map(next));
  emit(oldRequests[0], 'Old document partial. ');
  await page.evaluate(doc => window.__ctx.openDoc(doc), secondDoc); await loaded(); await idle();
  for (const request of oldRequests) emit(request, 'Old document late result.', true);
  await input('CONCURRENCY_NEW_DOC'); const newDoc = await next('CONCURRENCY_NEW_DOC');
  emit(newDoc, 'New document clean result.', true); await idle();
  assert.equal(matching(old[3]).length, 0, 'document switch discards queued old work');
  assert.equal(await page.evaluate(() => window.__state.doc.docId), secondDoc.docId);
  assert.equal((await row('CONCURRENCY_NEW_DOC')).text, 'New document clean result.');
  assert.equal(await page.evaluate(() => window.__state.sessionEntries.some(r => r.quote?.includes('CONCURRENCY_OLD_') || r.text?.includes('Old document'))), false);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  assert.equal((await session(secondDoc)).entries.some(r => r.quote?.includes('CONCURRENCY_OLD_') || r.text?.includes('Old document')), false);
  pass('document switch cancels old running/queued work and keeps late output out of the new document');

  assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
  await page.screenshot({ path: path.join(scratch, 'concurrency.png') });
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, requests: requests.map(r => ({ source: r.source, closed: r.closed })), errors, dialogs }, null, 2));
  console.log(`Translation concurrency: ${checks.length}/${checks.length} passed; ${scratch}`);
} catch (error) {
  console.error(await page?.evaluate(() => ({ doc: window.__state?.doc?.name, busy: window.__state?.busy,
    rows: window.__state?.sessionEntries.map(r => ({ quote: r.quote, text: r.text, status: r.status })) })).catch(() => null));
  await page?.screenshot({ path: path.join(scratch, 'failure.png'), timeout: 5000 }).catch(() => {});
  console.error(scratch); throw error;
} finally {
  await browser?.close(); await stopChild(reader);
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
