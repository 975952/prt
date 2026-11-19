/** Clicking the spread dismisses visible cards one at a time before turning. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'immersive-card-dismiss-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'Reading.pdf'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('immersive-card-dismiss').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore',
    });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!ready) await pause(100);
  }
  assert.ok(ready, 'isolated reader starts');
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 960 },
  });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    Element.prototype.requestFullscreen = () => Promise.resolve();
    document.exitFullscreen = () => Promise.resolve();
  });
  await page.goto(`${base}/?open=Reading.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.evaluate(async () => {
    __viewer.setTwoUp(true);
    await __viewer.goToPage(3);
  });
  await page.click('#immersiveBtn');
  await page.waitForFunction(() => __viewer.immersive && document.body.classList.contains('immersive-reading'));
  const openTool = async selector => {
    await page.mouse.move(750, 2);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#immersiveTopbar')).opacity) > .95);
    await page.click(selector);
  };
  const clickSpread = async side => {
    const point = await page.evaluate(which => {
      const viewer = document.querySelector('#viewer');
      const vr = viewer.getBoundingClientRect();
      const pages = [...viewer.querySelectorAll('.page:not(.immersive-hidden)')]
        .filter(node => { const r = node.getBoundingClientRect(); return r.width && r.height; });
      const page = which === 'left' ? pages[0] : pages.at(-1);
      const r = page.getBoundingClientRect();
      return { x: which === 'left' ? r.left + 12 : r.right - 12,
        y: Math.max(vr.top + 40, Math.min(vr.bottom - 40, r.top + r.height / 2)) };
    }, side);
    await page.mouse.click(point.x, point.y);
    await pause(280);
  };
  const visibility = () => page.evaluate(() => ({
    qa: document.body.classList.contains('immersive-chat-open'),
    translation: !document.querySelector('#translationCard').classList.contains('hidden'),
    page: __viewer.current,
  }));

  await openTool('#immersiveTranslate');
  await openTool('#immersiveChat');
  assert.deepEqual(await visibility(), { qa: true, translation: true, page: 3 });
  await clickSpread('left');
  assert.deepEqual(await visibility(), { qa: false, translation: true, page: 3 },
    'first spread click closes the most recently opened QA card');
  await clickSpread('left');
  assert.deepEqual(await visibility(), { qa: false, translation: false, page: 3 },
    'second spread click closes the remaining translation card');
  await clickSpread('right');
  assert.equal((await visibility()).page, 5, 'the next spread click turns the page');

  await openTool('#immersiveTranslate');
  await openTool('#immersiveChat');
  const scrollPoint = await page.evaluate(() => {
    const r = document.querySelector('#viewer').getBoundingClientRect();
    const paper = [...document.querySelectorAll('#viewer .page:not(.immersive-hidden)')]
      .find(node => node.getBoundingClientRect().width);
    const p = paper.getBoundingClientRect();
    return { x: p.left + 12, y: p.top + p.height / 2, viewerX: r.left };
  });
  await page.mouse.move(scrollPoint.x, scrollPoint.y);
  await page.mouse.wheel({ deltaY: 100 });
  await page.waitForFunction(() => __viewer.current === 7);
  assert.deepEqual(await visibility(), { qa: true, translation: true, page: 7 },
    'wheel still turns directly without dismissing cards');
  assert.deepEqual(errors, []);
  console.log(`PASS spread clicks dismiss recent cards one at a time; wheel still turns directly; ${scratch}`);
} catch (error) {
  console.error(`Artifacts: ${scratch}`);
  throw error;
} finally {
  await browser?.close();
  await stopChild(reader);
}
