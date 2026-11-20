/** Native IPC acknowledgement ordering with isolated PDFs. No real window mutation.
 * node test/fullscreen-handshake.mjs [--desktop]
 */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'fullscreen-handshake-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'Book.pdf'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('fullscreen-handshake').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready);
  for (const asset of ['js/app.js', 'js/immersive-reading.js']) assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1280, height: 800 } });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    window.__nativeRequests = [];
    window.ipc = { postMessage: message => {
      const request = JSON.parse(message);
      if (request.type === 'fullscreen') window.__nativeRequests.push(request);
    } };
  });
  await page.goto(`${base}/?open=Book.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.evaluate(async () => {
    __viewer.setScale(1.1, { keepCenter: false }); __viewer._fitMode = false; await __viewer.goToPage(3);
    window.__modeCalls = [];
    const setImmersive = __viewer.setImmersive.bind(__viewer);
    __viewer.setImmersive = async on => {
      __modeCalls.push({ on, width: innerWidth, height: innerHeight, fullscreen: document.body.classList.contains('window-fullscreen') });
      return setImmersive(on);
    };
    window.__prtWindowState({ fullscreen: false, maximized: false });
  });
  const ack = async on => page.evaluate(fullscreen => {
    const request = window.__nativeRequests.at(-1);
    window.__prtWindowState({ ...request, fullscreen, maximized: false });
  }, on);
  const settled = () => page.waitForFunction(() => document.getElementById('immersiveTransitionCover').hidden);
  const pending = async (on, count) => {
    await page.waitForFunction(n => window.__nativeRequests.length === n, {}, count);
    await pause(160);
    assert.equal(await page.evaluate(() => window.__modeCalls.length), count - 1, 'PDF mode waits for native fullscreen acknowledgement');
    assert.equal(await page.$eval('#immersiveTransitionCover', node => node.hidden), false, 'transition remains covered while native state is pending');
    assert.equal(await page.evaluate(() => window.__nativeRequests.at(-1).on), on);
    await ack(!on);
    await pause(60);
    assert.equal(await page.evaluate(() => window.__modeCalls.length), count - 1, 'an unrelated window-state report cannot release the mode switch');
  };
  await clickReaderTool(page, '#immersiveBtn');
  await pending(true, 1);
  await page.setViewport({ width: 1600, height: 1000 });
  await ack(true);
  await pause(25);
  await page.setViewport({ width: 1580, height: 980 });
  await pause(25);
  assert.equal(await page.evaluate(() => window.__modeCalls.length), 0, 'a resize after acknowledgement keeps the transition pending');
  await settled();
  assert.deepEqual(await page.evaluate(() => window.__modeCalls[0]), { on: true, width: 1580, height: 980, fullscreen: true });
  assert.ok(await page.evaluate(() => __viewer.immersive));
  console.log('PASS Book entry waits for native acknowledgement and renders at the fullscreen viewport');

  await page.evaluate(() => document.getElementById('immersiveExit').click());
  await pending(false, 2);
  await page.setViewport({ width: 1280, height: 800 });
  await ack(false);
  await pause(25);
  await page.setViewport({ width: 1260, height: 780 });
  await pause(25);
  assert.equal(await page.evaluate(() => window.__modeCalls.length), 1, 'the final restored-window resize is also awaited');
  await settled();
  assert.deepEqual(await page.evaluate(() => window.__modeCalls[1]), { on: false, width: 1260, height: 780, fullscreen: false });
  assert.equal(await page.evaluate(() => __viewer.immersive), false);
  assert.equal(await page.evaluate(() => __viewer.current), 3);
  assert.equal(await page.evaluate(() => __viewer.scale), 1.1);
  console.log('PASS Book exit waits for restored window bounds and preserves the page and zoom');

  await page.click('#fullscreenBtn');
  await page.waitForFunction(() => window.__nativeRequests.length === 3);
  await page.setViewport({ width: 1600, height: 1000 }); await ack(true);
  await page.waitForFunction(() => document.body.classList.contains('window-fullscreen'));
  await clickReaderTool(page, '#immersiveBtn'); await settled();
  await page.waitForFunction(() => __viewer.immersive);
  await page.evaluate(() => document.getElementById('immersiveExit').click()); await settled();
  await page.waitForFunction(() => !__viewer.immersive);
  assert.equal(await page.evaluate(() => window.__nativeRequests.length), 3, 'Book preserves fullscreen owned by the ordinary fullscreen command');
  assert.ok(await page.evaluate(() => document.body.classList.contains('window-fullscreen')));
  console.log('PASS ordinary fullscreen stays independent and survives a Book round trip');
  assert.deepEqual(errors, []);
  console.log(`PASS no browser errors; ${scratch}`);
} finally { await browser?.close(); await stopChild(reader); }
