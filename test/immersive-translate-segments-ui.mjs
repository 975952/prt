/** 翻书模式「加入译文」：每段单独翻译、各自成条译文，结果显示在浮动译文卡片（上一条 / 下一条翻看）。
 *  node test/immersive-translate-segments-ui.mjs
 * Isolated reader + synthetic PDF + controlled local model only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { spawnReader, stopChild } from './_exe.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'immersive-translate-segments-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'Reading.pdf'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const requests = [], waiters = [];
const userText = request => String(request.body.messages.at(-1)?.content || '');
/** 请求里真正要翻的那一段（正文上下文只供理解，不参与断言）。 */
const translatedFragment = request => {
  const raw = userText(request), marker = '【需要翻译的片段】';
  const at = raw.indexOf(marker);
  return (at < 0 ? raw : raw.slice(at + marker.length)).trim();
};
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    const request = { body, res, started: false };
    requests.push(request);
    const notify = waiters.shift(); if (notify) notify(request);
  } catch { if (!res.destroyed) res.destroy(); }
});
const emit = (request, text, done = false) => {
  if (!request.res.headersSent) request.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  request.res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  if (done) request.res.end('data: [DONE]\n\n');
};
const nextRequest = index => requests[index] ? Promise.resolve(requests[index])
  : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no request #${index + 1}; received ${requests.length}`)), 15000);
    waiters.push(request => { clearTimeout(timer); resolve(request); });
  });

let reader, browser, page;
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready, 'isolated reader starts');
  assert.ok((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'segments-mock', apiKey: 'SYNTHETIC_SEGMENTS_KEY' }) })).ok);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 960 } });
  page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    Element.prototype.requestFullscreen = () => Promise.resolve(); document.exitFullscreen = () => Promise.resolve();
  });
  await page.goto(`${base}/?open=Reading.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && __state.viewerDocId === __state.doc?.docId);
  await page.click('#immersiveBtn');
  await page.waitForFunction(() => __viewer.immersive && !__viewer._immersiveNavigation);
  await pause(400);

  /** 在翻书模式当前页的真实文本层上拖选一段。 */
  const selectSpan = async (index, from, to) => {
    const geometry = await page.evaluate(({ index, from, to }) => {
      const v = __viewer, e = v.rendered.get(v.current);
      const spans = [...e.textDiv.querySelectorAll('span')].filter(s => s.textContent.length > to + 2);
      const span = spans[index];
      const node = span.firstChild, range = document.createRange();
      const point = offset => { range.setStart(node, offset); range.setEnd(node, offset + 1); const r = range.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      return { start: point(from), end: point(to) };
    }, { index, from, to });
    await page.mouse.move(geometry.start.x, geometry.start.y); await page.mouse.down();
    await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 8 }); await page.mouse.up(); await pause(220);
    return page.evaluate(() => __state.selection?.cleanText || '');
  };
  const addTranslate = async () => {
    await page.waitForSelector('#bubble:not(.hidden) [data-act="add-translate"]', { visible: true });
    await page.evaluate(() => document.querySelector('#bubble [data-act="add-translate"]').click());
  };
  const cardText = () => page.$eval('#translationCardText', node => node.textContent);
  const cardCount = () => page.$eval('#translationCard .reading-card-count', node => node.textContent.trim());
  const cardVisible = () => page.$eval('#translationCard', node => !node.classList.contains('hidden'));

  const firstSelected = await selectSpan(0, 3, 18);
  assert.ok(firstSelected && firstSelected.length > 3, `first passage selected: ${firstSelected}`);
  const title = await page.$eval('#bubble [data-act="add-translate"]', node => node.title);
  assert.match(title, /每段单独翻译/, `book-mode 加入译文 explains per-passage translation: ${title}`);
  await addTranslate();
  const firstRequest = await nextRequest(0);
  assert.ok(translatedFragment(firstRequest).includes(firstSelected), 'first passage reaches the model by itself');
  assert.equal(await cardVisible(), true, 'the floating translation card opens in book mode');
  emit(firstRequest, '第一段单独译文。', true);
  await page.waitForFunction(() => document.querySelector('#translationCardText').textContent.includes('第一段单独译文。'));
  const afterFirst = await page.evaluate(() => ({
    records: __state.sessionEntries.filter(row => row.block === 'translate').map(row => ({ id: row.id, kind: row.retry?.kind, text: row.retry?.text, page: row.retry?.page })),
    attachments: __state.attachments.length,
    segmentRows: document.querySelectorAll('#attachRow .translation-segment').length,
    entryId: document.querySelector('#translationCard').dataset.entryId,
  }));
  assert.equal(afterFirst.records.length, 1, 'one passage produces exactly one translation record');
  assert.equal(afterFirst.records[0].kind, 'translate', 'the record is a per-selection translation, not a merged draft');
  assert.equal(afterFirst.records[0].text, firstSelected, 'the record keeps this passage as its own source');
  assert.equal(afterFirst.attachments, 0, 'no hidden sidebar translation draft is used in book mode');
  assert.equal(afterFirst.segmentRows, 0, 'nothing accumulates in the invisible right-column composer');
  assert.equal(afterFirst.entryId, afterFirst.records[0].id, 'the card shows the new translation');

  const secondSelected = await selectSpan(1, 4, 16);
  assert.ok(secondSelected && secondSelected.length > 3, `second passage selected: ${secondSelected}`);
  await addTranslate();
  const secondRequest = await nextRequest(1);
  assert.ok(translatedFragment(secondRequest).includes(secondSelected), 'second passage is translated in its own request');
  assert.ok(!translatedFragment(secondRequest).includes(firstSelected), 'the first passage is not merged into the second request');
  emit(secondRequest, '第二段单独译文。', true);
  await page.waitForFunction(() => document.querySelector('#translationCardText').textContent.includes('第二段单独译文。'));
  assert.equal(await cardCount(), '1 / 2', 'the card lists both translations with its built-in pager');
  const afterSecond = await page.evaluate(() => __state.sessionEntries.filter(row => row.block === 'translate')
    .map(row => row.retry?.text));
  assert.deepEqual(afterSecond, [firstSelected, secondSelected], 'two passages stay two separate records');

  await page.evaluate(() => document.querySelector('#translationCardNext').click());
  await page.waitForFunction(() => document.querySelector('#translationCardText').textContent.includes('第一段单独译文。'));
  assert.equal(await cardCount(), '2 / 2', 'the older passage can be paged back to');
  await page.evaluate(() => document.querySelector('#translationCardPrevious').click());
  await page.waitForFunction(() => document.querySelector('#translationCardText').textContent.includes('第二段单独译文。'));
  await page.screenshot({ path: path.join(scratch, 'book-translate-segments.png') });

  assert.deepEqual(errors, []);
  console.log('PASS book-mode 加入译文 translates each passage separately into its own card entry and paging works');
  console.log(scratch);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
    const state = await page.evaluate(() => ({ selection: window.__state?.selection?.cleanText,
      records: window.__state?.sessionEntries?.filter(row => row.block === 'translate')?.map(row => row.retry?.text),
      card: document.querySelector('#translationCard')?.className })).catch(() => null);
    fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ message: String(error), state, requests: requests.map(r => r.body) }, null, 2));
    console.error(`IMMERSIVE_TRANSLATE_SEGMENTS_FAILURE ${scratch}`);
  }
  throw error;
} finally {
  for (const request of requests) if (!request.res.writableEnded) request.res.destroy();
  await browser?.close(); await stopChild(reader);
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
