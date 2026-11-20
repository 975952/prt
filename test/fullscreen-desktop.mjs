/** Native Tao/WebView2 fullscreen bounds regression, with isolated data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import puppeteer from 'puppeteer-core';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { assertIsolatedDataDir } from './_env.mjs';

const staged = stageExe('native-fullscreen');
const data = assertIsolatedDataDir(path.join(staged.dir, 'data')), papers = path.join(staged.dir, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/multipage-sample.pdf'), path.join(papers, 'Book.pdf'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function until(fn) {
  for (let n = 0; n < 100; n++) { try { const value = await fn(); if (value) return value; } catch {} await delay(100); }
  throw new Error('Native fullscreen did not settle');
}
let reader, browser;
try {
  const service = await port(), debug = await port(), base = `http://127.0.0.1:${service}`;
  reader = spawnReader(staged.exe, { args: ['--port', String(service)], env: {
    PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debug}`,
  } });
  const ws = await until(async () => (await fetch(`http://127.0.0.1:${debug}/json/version`).then(r => r.json())).webSocketDebuggerUrl);
  browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const page = await until(async () => (await browser.pages()).find(p => p.url().startsWith(base)));
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.waitForFunction(() => !!window.__ctx && window.__state?.papers.length === 1);
  await page.evaluate(async () => {
    await __ctx.openDoc(__state.papers[0]);
    window.__nativeBounds = [];
    const record = () => window.__nativeBounds.push({ width: innerWidth, height: innerHeight,
      fullscreen: document.body.classList.contains('window-fullscreen'), maximized: document.body.classList.contains('window-maximized') });
    addEventListener('resize', record); addEventListener('prt:window-state', record);
  });
  const ipc = (type, extra = {}) => page.evaluate((type, extra) => window.ipc.postMessage(JSON.stringify({ type, ...extra })), type, extra);
  const bounds = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight, maximized: document.body.classList.contains('window-maximized') }));
  const fillsScreen = async label => {
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height,
      availableHeight: screen.availHeight, viewerBottom: document.getElementById('viewer').getBoundingClientRect().bottom }));
    assert.ok(Math.abs(size.width - size.screenWidth) <= 1 && Math.abs(size.height - size.screenHeight) <= 1, `${label}: ${JSON.stringify(size)}`);
    return size;
  };
  const fullscreen = async on => {
    await ipc('fullscreen', { on });
    await page.waitForFunction(on => document.body.classList.contains('window-fullscreen') === on, {}, on);
    await delay(150);
  };
  const normal = await bounds();
  await fullscreen(true); await fillsScreen('windowed fullscreen covers the whole monitor'); await fullscreen(false);
  assert.deepEqual(await bounds(), normal, 'windowed fullscreen restores exact original dimensions');
  console.log('PASS native windowed fullscreen restores original dimensions');
  await ipc('maximize');
  await page.waitForFunction(() => document.body.classList.contains('window-maximized'));
  await delay(200);
  const maximized = await bounds();
  await page.evaluate(() => { __nativeBounds.length = 0; });
  await fullscreen(true); await fillsScreen('maximized fullscreen covers the taskbar area'); await fullscreen(false);
  assert.deepEqual(await bounds(), maximized, 'Tao restores maximized WINDOWPLACEMENT');
  const frames = await page.evaluate(() => __nativeBounds);
  assert.ok(frames.every(r => r.width >= maximized.width - 20 && r.height >= maximized.height - 20), JSON.stringify(frames));
  console.log('PASS maximized fullscreen never passes through the smaller restored window');
  await page.evaluate(() => { __nativeBounds.length = 0; document.getElementById('immersiveBtn').click(); });
  await page.waitForFunction(() => __viewer.immersive && document.getElementById('immersiveTransitionCover').hidden, { timeout: 15000 });
  const bookSize = await fillsScreen('Book view covers the whole monitor');
  assert.ok(Math.abs(bookSize.viewerBottom - bookSize.height) <= 1, 'Book viewport reaches the screen bottom');
  await page.evaluate(() => document.getElementById('immersiveExit').click());
  await page.waitForFunction(() => !__viewer.immersive && document.getElementById('immersiveTransitionCover').hidden, { timeout: 15000 });
  assert.deepEqual(await bounds(), maximized, 'Book round trip restores maximized dimensions');
  assert.ok(await page.evaluate(min => __nativeBounds.every(r => r.width >= min.width - 20 && r.height >= min.height - 20), maximized));
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(staged.dir, 'bounds.json'), JSON.stringify(await page.evaluate(() => __nativeBounds), null, 2));
  console.log(`PASS native Book round trip has no restored-size intermediate window; ${staged.dir}`);
} finally { browser?.disconnect(); await stopChild(reader); }
