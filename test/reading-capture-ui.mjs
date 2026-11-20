/** Screenshot selection suspends both reading cards and restores usable drafts. */
import { clickReaderTool } from './_reader-controls.mjs';
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `reading-capture-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
for (const name of ['Capture.pdf', 'Other.pdf']) {
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, name));
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const requests = [], errors = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
  }
  requests.push({ body, res });
});
let reader, browser, page;
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('reading-capture').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready, 'isolated reader starts');
  for (const asset of ['js/app.js', 'js/translation-card.js', 'reading-cards.css']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `current ${asset}`);
  }
  assert.ok((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'capture-test', visionModel: 'capture-test', apiKey: 'SYNTHETIC_CAPTURE_KEY' }) })).ok);
  const listing = (await fetch(`${base}/api/papers`).then(r => r.json())).papers;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 960 } });
  page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    Element.prototype.requestFullscreen = () => Promise.resolve(); document.exitFullscreen = () => Promise.resolve();
  });
  const loaded = () => page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.goto(`${base}/?open=Capture.pdf&topbar=static`, { waitUntil: 'domcontentloaded' }); await loaded();
  await clickReaderTool(page, '#immersiveBtn');
  await page.waitForFunction(() => document.body.classList.contains('immersive-reading') && __viewer.immersive);
  const openTool = async selector => {
    await page.mouse.move(750, 2);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#immersiveTopbar')).opacity) > .95);
    await page.click(selector);
  };
  await openTool('#immersiveChat');
  await page.type('#chatInput', 'KEEP_QA_DRAFT');
  await page.evaluate(() => {
    const entry = __ctx.addEntry({ block: 'translate', tag: 'translation', quote: 'SAVED_SOURCE', page: 1, reveal: false });
    __ctx.finishEntry(entry, '已保存的译文', { status: 'complete', page: 1 });
  });
  await openTool('#immersiveTranslate');
  await page.type('#translationCardInput', 'KEEP_TRANSLATION_DRAFT');
  await page.evaluate(() => {
    Object.assign(document.querySelector('#translationCard').style, { left: '34px', right: 'auto', top: '130px', width: '430px', height: '520px' });
    Object.assign(document.querySelector('#rightSide').style, { left: '980px', right: 'auto', top: '150px', width: '480px', height: '610px' });
    const original = __viewer.captureRegion.bind(__viewer);
    __viewer.captureRegion = async (...args) => {
      const shot = await original(...args);
      if (window.captureGate) {
        const gate = window.captureGate;
        gate.started = true;
        await gate.wait;
        if (gate.fail) throw new Error('Synthetic screenshot failure');
      }
      return shot;
    };
  });
  const snapshot = () => page.evaluate(() => {
    const card = node => {
      const r = node.getBoundingClientRect();
      return { visibility: getComputedStyle(node).visibility, hidden: node.classList.contains('hidden'),
        left: r.left, top: r.top, width: r.width, height: r.height, entryId: node.dataset.entryId || '' };
    };
    return { translation: card(document.querySelector('#translationCard')), qa: card(document.querySelector('#rightSide')),
      qaOpen: document.body.classList.contains('immersive-chat-open'),
      translationDraft: document.querySelector('#translationCardInput').value, qaDraft: document.querySelector('#chatInput').value,
      translationText: document.querySelector('#translationCardText').textContent,
      capturing: document.body.classList.contains('reading-capture-active') };
  });
  const initial = await snapshot();
  assert.equal(initial.qaDraft, 'KEEP_QA_DRAFT', 'fixture retains the QA composer');
  assert.equal(initial.translationDraft, 'KEEP_TRANSLATION_DRAFT');
  const restored = async (label, { translationDraft = initial.translationDraft, sameEntry = true } = {}) => {
    await page.waitForFunction(() => !document.body.classList.contains('reading-capture-active'));
    const actual = await snapshot();
    assert.equal(actual.translation.visibility, 'visible', `${label}: translation returns`);
    assert.equal(actual.qa.visibility, 'visible', `${label}: QA returns`);
    assert.equal(actual.qaOpen, true, `${label}: QA open state preserved`);
    assert.equal(actual.translation.hidden, false, `${label}: translation open state preserved`);
    assert.equal(actual.translationDraft, translationDraft, `${label}: translation draft preserved`);
    assert.equal(actual.qaDraft, initial.qaDraft, `${label}: QA draft preserved`);
    if (sameEntry) {
      assert.equal(actual.translation.entryId, initial.translation.entryId, `${label}: selected record preserved`);
      assert.equal(actual.translationText, initial.translationText, `${label}: result preserved`);
    }
    for (const selector of ['translation', 'qa']) for (const dimension of ['left', 'top', 'width', 'height']) {
      assert.ok(Math.abs(actual[selector][dimension] - initial[selector][dimension]) < 2, `${label}: ${selector} ${dimension}`);
    }
  };
  const hidden = async label => {
    await page.waitForFunction(() => document.body.classList.contains('reading-capture-active'));
    const actual = await snapshot();
    assert.equal(actual.translation.visibility, 'hidden', `${label}: translation hidden`);
    assert.equal(actual.qa.visibility, 'hidden', `${label}: QA hidden`);
    assert.equal(actual.translation.entryId, initial.translation.entryId, `${label}: record is not disposed`);
    assert.equal(actual.translationDraft, initial.translationDraft, `${label}: draft intact`);
  };
  const begin = async (intent = 'translate') => {
    await page.click(intent === 'translate' ? '#translationCardCapture' : '#clipBtn');
    await page.waitForSelector('#regionOverlay:not(.hidden)'); await hidden(`${intent} selection`);
  };
  const drag = async (tiny = false) => {
    const r = await page.$eval('#viewer .page:not(.immersive-hidden)', node => {
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width * .25, y: box.top + box.height * .3, width: box.width * .4, height: box.height * .2 };
    });
    await page.mouse.move(r.x, r.y); await page.mouse.down();
    await page.mouse.move(r.x + (tiny ? 5 : r.width), r.y + (tiny ? 5 : r.height), { steps: 8 }); await page.mouse.up();
  };
  const gate = async fail => page.evaluate(fail => {
    const gate = { fail, started: false };
    gate.wait = new Promise(resolve => { gate.release = resolve; }); window.captureGate = gate;
  }, fail);
  const release = async () => page.evaluate(() => { window.captureGate.release(); window.captureGate = null; });

  for (const intent of ['translate', 'chat']) {
    await begin(intent); await page.keyboard.press('Escape'); await restored(`${intent} cancel`);
    await begin(intent); await drag(true); await restored(`${intent} tiny selection`);
  }
  console.log('PASS both cards hide together and cancel/tiny selections preserve geometry, record and drafts');

  await gate(false); await begin(); await drag();
  await page.waitForFunction(() => window.captureGate?.started);
  await page.keyboard.press('Escape'); await restored('cancel rendering');
  await release(); await pause(80);
  assert.equal(await page.$$eval('#translationCardAttachments img', images => images.length), 0, 'cancelled rendering does not attach its eventual screenshot');
  await restored('cancelled render settled');

  await gate(true); await begin(); await drag();
  await page.waitForFunction(() => window.captureGate?.started);
  await hidden('capture failure pending'); await release(); await restored('capture failure');
  assert.equal(await page.$$eval('#translationCardAttachments img', images => images.length), 0);
  await gate(false); await begin(); await drag();
  await page.waitForFunction(() => window.captureGate?.started);
  await hidden('capture rendering');
  await page.screenshot({ path: path.join(scratch, 'cards-hidden-during-capture.png') });
  await release(); await restored('translation capture');
  await page.waitForSelector('#translationCardAttachments img');
  assert.ok(await page.$eval('#translationCardAttachments img', image => image.src.startsWith('data:image/')));
  assert.equal(await page.$$eval('#attachRow img', images => images.length), 0, 'translation screenshot stays in its own card');
  await page.screenshot({ path: path.join(scratch, 'translation-capture-restored.png') });

  await gate(false); await begin('chat'); await drag();
  await page.waitForFunction(() => window.captureGate?.started); await hidden('QA capture rendering');
  await release(); await restored('QA capture');
  await page.waitForSelector('#attachRow img');
  assert.equal(await page.$$eval('#translationCardAttachments img', images => images.length), 1, 'QA capture leaves translation attachment unchanged');
  console.log('PASS delayed rendering and failures restore cards; captures return to the correct editor');

  await page.focus('#translationCardInput'); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace'); await page.click('#translationCardSubmit');
  for (let i = 0; i < 100 && !requests.length; i++) await pause(100);
  assert.equal(requests.length, 1, 'image-only translation sends one model request');
  assert.ok(requests[0].body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')), 'model receives the screenshot');
  const emit = (text, done = false, requestIndex = 0) => {
    const res = requests[requestIndex].res;
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    if (done) res.end('data: [DONE]\n\n');
  };
  emit('截图译文');
  await page.waitForFunction(() => document.querySelector('#translationCardText').textContent.includes('截图译文'));
  await page.type('#translationCardInput', 'NEXT_TRANSLATION_DRAFT');
  emit('已完成。', true);
  await page.waitForFunction(() => __state.sessionEntries.some(row => row.block === 'translate' && row.status === 'complete' && row.text === '截图译文已完成。'));
  await restored('image translation', { translationDraft: 'NEXT_TRANSLATION_DRAFT', sameEntry: false });
  await page.evaluate(() => __ctx.saveSessionNow());
  const docId = await page.evaluate(() => __state.doc.docId);
  const persisted = await fetch(`${base}/api/session?doc=${encodeURIComponent(docId)}&sid=__translate`).then(r => r.json());
  assert.match(JSON.stringify(persisted), /截图译文已完成。/);
  console.log('PASS screenshot translation streams inside the same card and persists while preserving the next draft');

  await page.click('#immersiveChatClose');
  await page.click('#translationCardCapture'); await page.waitForSelector('#regionOverlay:not(.hidden)');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.classList.contains('reading-capture-active'));
  assert.equal(await page.evaluate(() => document.body.classList.contains('immersive-chat-open')), false, 'cancel does not open an originally closed QA card');
  await page.click('#translationCardClose'); await openTool('#immersiveChat');
  await page.click('#clipBtn'); await page.waitForSelector('#regionOverlay:not(.hidden)'); await page.keyboard.press('Escape');
  assert.ok(await page.$eval('#translationCard', node => node.classList.contains('hidden')), 'QA cancel does not open an originally closed translation card');

  await openTool('#immersiveTranslate'); await gate(false);
  await page.click('#translationCardCapture'); await page.waitForSelector('#regionOverlay:not(.hidden)'); await drag();
  await page.waitForFunction(() => window.captureGate?.started);
  const other = listing.find(paper => paper.name === 'Other.pdf'); assert.ok(other);
  await page.evaluate(other => __ctx.openDoc(other), other); await loaded();
  await release();
  await page.waitForFunction(() => !document.body.classList.contains('reading-capture-active'));
  assert.equal(await page.evaluate(() => __state.doc.name), 'Other.pdf');
  assert.ok(await page.$eval('#translationCard', node => node.classList.contains('hidden')), 'stale completion does not reopen cards after navigation');
  assert.equal(await page.$$eval('#translationCardAttachments img', images => images.length), 0, 'stale capture is not attached to another document');

  await page.evaluate(async () => { if (!__ctx.immersiveReading.active) await __ctx.immersiveReading.setActive(true); });
  await openTool('#immersiveTranslate');
  const queueTwoImages = async () => {
    let count = await page.$$eval('#translationCardAttachments img', images => images.length);
    while (count < 2) {
      await page.click('#translationCardCapture'); await page.waitForSelector('#regionOverlay:not(.hidden)'); await drag();
      await page.waitForFunction(() => !document.body.classList.contains('reading-capture-active'));
      await page.waitForFunction(expected => document.querySelectorAll('#translationCardAttachments img').length === expected, {}, ++count);
    }
    const requestIndex = requests.length;
    await page.click('#translationCardSubmit');
    for (let i = 0; i < 100 && requests.length === requestIndex; i++) await pause(100);
    assert.equal(requests.length, requestIndex + 1, 'only the first queue item starts');
    return requestIndex;
  };
  const queueFinished = async (requestIndex, text) => {
    emit(text, true, requestIndex);
    await page.waitForFunction(() => document.querySelector('#translationCardInput').getAttribute('aria-busy') === 'false');
    await pause(100);
    assert.equal(requests.length, requestIndex + 1, 'unstarted screenshots are not sent after leaving the queue view');
    assert.equal(await page.$$eval('#translationCardAttachments img', images => images.length), 1, 'only the unstarted screenshot returns to the draft');
  };

  const closeQueue = await queueTwoImages();
  await page.click('#translationCardClose');
  await queueFinished(closeQueue, 'CLOSE_QUEUE_DONE');
  assert.ok(await page.$eval('#translationCard', node => node.classList.contains('hidden')), 'completed queue item cannot reopen a closed card');
  await openTool('#immersiveTranslate');
  assert.equal(await page.$$eval('#translationCardAttachments img', images => images.length), 1);

  const historyQueue = await queueTwoImages();
  await page.click('#translationCardHistory');
  await page.$$eval('.reading-card-history-row', nodes => nodes.find(node => node.textContent.includes('CLOSE_QUEUE_DONE')).click());
  const selectedHistory = await page.$eval('#translationCard', node => node.dataset.entryId);
  await queueFinished(historyQueue, 'HISTORY_QUEUE_DONE');
  assert.equal(await page.$eval('#translationCard', node => node.dataset.entryId), selectedHistory, 'late completion cannot replace the selected history record');
  assert.match(await page.$eval('#translationCardText', node => node.textContent), /CLOSE_QUEUE_DONE/);

  const navigationQueue = await queueTwoImages();
  await page.evaluate(() => document.querySelector('#homeBtn').click());
  await page.waitForFunction(() => !document.body.classList.contains('reading'));
  await queueFinished(navigationQueue, 'NAVIGATION_QUEUE_DONE');
  assert.ok(await page.$eval('#translationCard', node => node.classList.contains('hidden')), 'late queue completion cannot show a card over Library');
  assert.equal(await page.evaluate(() => document.body.classList.contains('reading')), false);
  await page.click('#homeReadingEntry'); await loaded();
  await page.waitForFunction(() => document.body.classList.contains('reading'));
  await clickReaderTool(page, '#immersiveBtn'); await openTool('#immersiveTranslate');
  assert.equal(await page.$$eval('#translationCardAttachments img', images => images.length), 1, 'returning to the reader restores the remaining screenshot');
  console.log('PASS closing the card, selecting history and opening Library stop queued screenshots without stealing visibility or losing drafts');
  assert.deepEqual(errors, []);
  console.log(`PASS original visibility and navigation cleanup; ${scratch}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Artifacts: ${scratch}`); throw error;
} finally {
  for (const request of requests) if (!request.res.writableEnded) request.res.destroy();
  await browser?.close(); await stopChild(reader);
  await new Promise(resolve => upstream.close(resolve));
}
