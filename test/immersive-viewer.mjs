/** Real Library layout with isolated state, no user files or model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'immersive-viewer-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'Reading.pdf'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('library-sidebar').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready);
  for (const asset of ['js/library-sidebar.js', 'js/app.js', 'style.css']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1600, height: 1000 } });
  const page = await browser.newPage(), errors = [];
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', error => { errors.push(String(error)); console.log('PAGE ERROR', String(error)); });
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 1);
  const paper = (await fetch(base + '/api/papers').then(r => r.json())).papers[0];
  assert.equal(await page.$eval('#homeReadingEntry', n => n.disabled), true);
  await page.goto(base + '/?document=' + encodeURIComponent(paper.docId), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId && document.body.classList.contains('reading'));

  await page.addStyleTag({ url: base + '/immersive-viewer.css' });
  const original = await page.evaluate(async () => {
    const viewer = window.__viewer;
    await viewer.goToPage(3); viewer.setScale(.9, { keepCenter: false }); viewer._fitMode = false;
    const before = { scale: viewer.scale, twoUp: viewer._twoUp, page: viewer.current };
    await viewer.setImmersive(true);
    return before;
  });
  const state = () => page.evaluate(() => {
    const v = window.__viewer, r = v.container.getBoundingClientRect();
    return { immersive: v.immersive, current: v.current, scale: v.scale, twoUp: v._twoUp,
      visible: v.pageEls.filter(n => n && getComputedStyle(n).display !== 'none').map(n => Number(n.dataset.page)),
      fits: v.pageEls.filter(n => n && getComputedStyle(n).display !== 'none').every(n => { const p = n.getBoundingClientRect(); return p.top >= r.top && p.bottom <= r.bottom + 1 && p.left >= r.left && p.right <= r.right + 1; }),
      overlays: document.querySelectorAll('.immersive-page-turn,.immersive-turn-snapshot').length };
  });
  assert.deepEqual((await state()).visible, [3,4]); assert.equal((await state()).fits, true);
  const fixedScale = (await state()).scale;
  await page.evaluate(() => window.__viewer.setScale(5)); assert.equal((await state()).scale, fixedScale);
  const failedTurn = await page.evaluate(async () => {
    const viewer = window.__viewer, render = viewer._renderPage;
    viewer._renderPage = async function (n, options) { if (n === 5) throw new Error('synthetic page render failure'); return render.call(this, n, options); };
    try { await viewer.stepPage(1); return ''; }
    catch (error) { return error.message; }
    finally { viewer._renderPage = render; }
  });
  assert.equal(failedTurn, 'synthetic page render failure');
  assert.equal((await state()).overlays, 0, 'failed page rendering clears old page snapshots');
  await page.evaluate(() => window.__viewer.goToPage(3));
  await page.evaluate(() => window.__viewer.stepPage(1));
  assert.deepEqual((await state()).visible, [5,6]); assert.equal((await state()).overlays, 0);
  await page.screenshot({ path: path.join(scratch, 'spread.png') });
  await page.evaluate(() => window.__viewer.goToPage(8));
  assert.deepEqual((await state()).visible, [7,8]);
  await page.evaluate(() => { document.documentElement.dataset.motion = 'on'; void window.__viewer.stepPage(-1); });
  await page.waitForSelector('.immersive-page-turn', { timeout: 3000 });
  await page.screenshot({ path: path.join(scratch, 'turn.png') });
  await page.evaluate(() => window.__viewer.setImmersive(false));
  assert.equal((await state()).immersive, false); assert.equal((await state()).overlays, 0);
  assert.equal((await state()).scale, original.scale); assert.equal((await state()).twoUp, original.twoUp);
  assert.equal((await state()).current, 5, 'exit keeps final reading progress');
  await page.evaluate(async () => { document.documentElement.dataset.motion = 'off'; await window.__viewer.setImmersive(true); await window.__viewer.goToPage(1); });
  assert.equal((await state()).overlays, 0);
  await page.setViewport({ width: 1100, height: 760 }); await pause(150);
  assert.equal((await state()).fits, true, 'resize refits both complete pages');
  await page.evaluate(() => window.__viewer.setImmersive(false));
  assert.deepEqual(errors, []);
  console.log('PASS complete fixed spreads, zoom lock, forward/goto, page turn, cancellation, and exit restoration; ' + scratch);
} finally { await browser?.close(); await stopChild(reader); }
