/** Typed translations stay in one floating card, stream independently and survive reload. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `translation-input-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'Translation.pdf'));
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
  requests.push({ body, source: JSON.stringify(body.messages?.filter(row => row.role === 'user') || []), res });
});
const next = async marker => {
  for (let i = 0; i < 100 && !requests.some(request => request.source.includes(marker)); i++) await pause(100);
  const found = requests.filter(request => request.source.includes(marker));
  assert.equal(found.length, 1, `one model request for ${marker}`); return found[0];
};
const emit = (request, text, done = false) => {
  if (!request.res.headersSent) request.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  request.res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  if (done) request.res.end('data: [DONE]\n\n');
};
let reader, browser, page;
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('translation-input').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready, 'isolated reader starts');
  for (const asset of ['js/app.js', 'js/translation-card.js', 'reading-cards.css']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `current ${asset}`);
  }
  assert.ok((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'typed-translation-test', apiKey: 'SYNTHETIC_TRANSLATION_INPUT_KEY' }) })).ok);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 960 } });
  page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    Element.prototype.requestFullscreen = () => Promise.resolve(); document.exitFullscreen = () => Promise.resolve();
  });
  const loaded = () => page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.goto(`${base}/?open=Translation.pdf&topbar=static`, { waitUntil: 'domcontentloaded' }); await loaded();
  const open = async () => {
    await page.mouse.move(750, 2);
    await page.waitForFunction(() => document.body.classList.contains('immersive-chrome-visible'));
    await page.click('#immersiveTranslate'); await page.waitForSelector('#translationCard:not(.hidden)');
  };
  await clickReaderTool(page, '#immersiveBtn'); await open();
  await page.waitForSelector('#translationCardInput', { visible: true });
  const bounds = () => page.$eval('#translationCard', node => {
    const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const handle = await page.$eval('#translationCard .pop-head', node => {
    const r = node.getBoundingClientRect(); return { x: r.left + 45, y: r.top + r.height / 2 };
  });
  await page.mouse.move(handle.x, handle.y); await page.mouse.down();
  await page.mouse.move(435, 228, { steps: 8 }); await page.mouse.up();
  await page.focus('#translationCardResize'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  const position = await bounds();
  const unchanged = async label => {
    const actual = await bounds();
    for (const key of Object.keys(position)) assert.ok(Math.abs(position[key] - actual[key]) < 2, `${label}: preserve ${key}`);
    assert.ok(await page.$eval('#translationCard', node => !node.classList.contains('hidden')), `${label}: same card remains open`);
    assert.equal(await page.evaluate(() => document.body.classList.contains('immersive-chat-open')), false, `${label}: no sidebar opened`);
  };
  const status = (marker, expected) => page.waitForFunction(({ marker, expected }) => __state.sessionEntries.some(row =>
    row.block === 'translate' && row.retry?.text === marker && row.status === expected), {}, { marker, expected });
  const first = 'TYPED_FIRST passage', second = 'TYPED_SECOND passage\nSecond line';
  await page.type('#translationCardInput', first); await page.click('#translationCardSubmit');
  const requestA = await next('TYPED_FIRST');
  assert.equal(await page.$eval('#translationCardInput', node => node.value), '');
  assert.equal(await page.$eval('#translationCardInput', node => node.disabled), false);
  assert.equal(await page.$eval('#translationCardSubmit', node => node.disabled), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'translationCardInput', 'submission keeps the editor focused for the next passage');
  emit(requestA, '第一段译文');
  await page.waitForFunction(() => document.querySelector('#translationCardText').textContent.includes('第一段译文'));
  await page.keyboard.type('TYPED_SECOND passage');
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await page.keyboard.type('Second line');
  assert.equal(requests.length, 1, 'Shift+Enter only inserts a newline');
  emit(requestA, '已完成。', true); await status(first, 'complete');
  await page.waitForFunction(() => !document.querySelector('#translationCardSubmit').disabled);
  assert.equal(await page.$eval('#translationCardInput', node => node.value), second, 'next draft survives completion');
  await unchanged('first translation');
  await page.keyboard.press('Enter'); const requestB = await next('TYPED_SECOND');
  emit(requestB, '第二段译文已完成。', true); await status(second, 'complete');
  await page.waitForFunction(() => !document.querySelector('#translationCardInput').value && document.querySelector('#translationCardText').textContent.includes('第二段译文已完成。'));
  await unchanged('second translation');
  await page.screenshot({ path: path.join(scratch, 'continuous-translation.png') });
  console.log('PASS typing, streaming, Shift+Enter and consecutive translations preserve card position and size');

  await page.type('#translationCardInput', 'TYPED_FAILURE'); await page.click('#translationCardSubmit');
  const failed = await next('TYPED_FAILURE');
  failed.res.writeHead(400, { 'Content-Type': 'application/json' });
  failed.res.end(JSON.stringify({ error: { message: 'Synthetic failure for draft recovery' } }));
  await status('TYPED_FAILURE', 'failed');
  await page.waitForFunction(() => document.querySelector('#translationCardInput').value === 'TYPED_FAILURE');
  await page.click('#translationCardClose'); await open();
  assert.equal(await page.$eval('#translationCardInput', node => node.value), 'TYPED_FAILURE', 'closing and reopening retains failed draft');
  await page.focus('#translationCardInput'); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.type('#translationCardInput', 'TYPED_FAILURE_NEW'); await page.click('#translationCardSubmit');
  const failedWithDraft = await next('TYPED_FAILURE_NEW');
  await page.type('#translationCardInput', 'Keep the newer draft');
  failedWithDraft.res.writeHead(400, { 'Content-Type': 'application/json' });
  failedWithDraft.res.end(JSON.stringify({ error: { message: 'Synthetic failure with newer draft' } }));
  await status('TYPED_FAILURE_NEW', 'failed');
  await page.waitForFunction(() => !document.querySelector('#translationCardSubmit').disabled);
  assert.equal(await page.$eval('#translationCardInput', node => node.value), 'Keep the newer draft', 'failure cannot overwrite newer typing');
  console.log('PASS failed submissions restore their source without overwriting a newer draft');

  await page.click('#translationCardHistory');
  await page.waitForFunction(() => document.querySelector('#translationCardHistoryList').textContent.includes('第一段译文已完成。')
    && document.querySelector('#translationCardHistoryList').textContent.includes('第二段译文已完成。'));
  await page.evaluate(() => __ctx.saveSessionNow());
  const docId = await page.evaluate(() => __state.doc.docId);
  const persisted = await fetch(`${base}/api/session?doc=${encodeURIComponent(docId)}&sid=__translate`).then(r => r.json());
  assert.match(JSON.stringify(persisted), /第一段译文已完成。/); assert.match(JSON.stringify(persisted), /第二段译文已完成。/);
  await page.reload({ waitUntil: 'domcontentloaded' }); await loaded();
  await clickReaderTool(page, '#immersiveBtn'); await open();
  if (await page.$eval('#translationCard', node => node.dataset.cardView !== 'history')) await page.click('#translationCardHistory');
  await page.waitForFunction(() => document.querySelector('#translationCardHistoryList').textContent.includes('第一段译文已完成。')
    && document.querySelector('#translationCardHistoryList').textContent.includes('第二段译文已完成。'));
  assert.deepEqual(errors, []);
  console.log(`PASS both typed translations survive reload; ${scratch}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Artifacts: ${scratch}`); throw error;
} finally {
  for (const request of requests) if (!request.res.writableEnded) request.res.destroy();
  await browser?.close(); await stopChild(reader);
  await new Promise(resolve => upstream.close(resolve));
}
