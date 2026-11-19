/** Real Library layout with isolated state, no user files or model calls. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'startup-page-'));
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
  for (const asset of ['js/startup.js', 'js/windows.js', 'js/library-sidebar.js', 'js/app.js', 'style.css']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1600, height: 1000 } });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  let failModule = false, failBootstrap = false;
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (failModule && url.pathname === '/js/app.js' || failBootstrap && url.pathname === '/js/startup.js') { await request.abort(); return; }
    // Make the default home and intermediate reader layout last long enough
    // that an ungated launch would visibly expose them on ordinary hardware.
    if (url.pathname === '/api/config' || url.pathname === '/api/session') await pause(350);
    await request.continue().catch(() => {});
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    if (!localStorage.getItem('reader.ui')) localStorage.setItem('reader.ui', JSON.stringify({ style: { theme: 'dark', appearanceVersion: 4, glassBrightness: 0 } }));
    const snapshot = () => {
      const viewer = window.__viewer;
      const reading = document.body?.classList.contains('reading') && !document.body?.classList.contains('agent-full');
      const range = viewer?.pdf ? viewer._visibleRange() : [];
      return {
        view: document.body?.classList.contains('agent-full') ? 'agent' : reading ? 'reading' : 'library',
        theme: document.documentElement.dataset.theme,
        page: viewer?.current || 0,
        width: viewer?.container.clientWidth || 0,
        painted: !reading || !!range.length && Array.from({ length: range[1] - range[0] + 1 }, (_, i) => viewer._hasCurrentPageBitmap(range[0] + i)).every(Boolean),
      };
    };
    window.__startupFrames = [];
    addEventListener('prt-startup-ready', () => { window.__startupFirst = snapshot(); });
    const sample = () => {
      if (document.body && !document.documentElement.hasAttribute('data-startup')) window.__startupFrames.push(snapshot());
      if (window.__startupFrames.length < 40) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const waitForReady = async (view, expectedPage) => {
    await page.waitForFunction(() => window.__startupFirst && !document.documentElement.hasAttribute('data-startup'));
    await pause(90);
    const result = await page.evaluate(() => ({ first: window.__startupFirst, frames: window.__startupFrames }));
    assert.equal(result.first.view, view);
    assert.equal(result.first.theme, 'dark');
    assert.ok(result.first.painted, 'visible pages are painted before the first reveal');
    if (expectedPage) assert.equal(result.first.page, expectedPage, 'saved reading position is restored before the first reveal');
    assert.ok(result.frames.length > 0);
    assert.ok(result.frames.every(frame => frame.view === view && frame.painted), 'no intermediate screen or empty page is exposed');
  };
  const assertGated = async () => {
    assert.deepEqual(await page.evaluate(() => ({
      loading: document.documentElement.hasAttribute('data-startup'),
      homeHidden: getComputedStyle(document.querySelector('#home')).visibility === 'hidden',
      message: document.querySelector('#startupMessage').textContent,
      background: getComputedStyle(document.querySelector('#startupStatus')).backgroundColor,
      nativeBarHidden: document.querySelector('#startupWindowBar').hidden,
    })), { loading: true, homeHidden: true, message: '正在打开…', background: 'rgb(0, 0, 0)', nativeBarHidden: true });
  };
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await assertGated();
  await waitForReady('library');
  const paper = (await fetch(base + '/api/papers').then(r => r.json())).papers[0];
  const reload = async (view = 'library', expectedPage) => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertGated();
    await waitForReady(view, expectedPage);
  };
  const isLibrary = () => page.evaluate(() => !document.body.classList.contains('reading') && !document.body.classList.contains('agent-full') && !document.querySelector('#home').classList.contains('hidden'));
  assert.ok(await isLibrary());
  await page.evaluate(paper => localStorage.setItem('reader.workspace.v1', JSON.stringify({ tabs: [paper], active: paper.docId })), paper);
  await reload(); assert.ok(await isLibrary());
  assert.equal(await page.evaluate(() => window.__viewer?.pdf == null), true);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('reader.workspace.v1')).tabs.length), 1);
  console.log('PASS default startup opens Library without loading PDF or deleting saved tabs');
  await page.locator('#settingsBtn').click(); await page.locator('#settingsNavBehavior').click();
  assert.equal(await page.$eval('#startupPage', n => n.value), 'library');
  await page.select('#startupPage', 'resume'); await page.locator('#closeSettings').click();
  assert.ok(await isLibrary(), 'changing preference does not navigate immediately');
  await reload('reading', 1);
  assert.equal(await page.evaluate(() => window.__state.doc.docId), paper.docId);
  console.log('PASS settings persist resume-reading preference and restore the saved PDF');
  await page.locator('#settingsBtn').click(); await page.locator('#settingsNavBehavior').click();
  await page.select('#startupPage', 'agent'); await page.locator('#closeSettings').click();
  await reload('agent');
  assert.equal(await page.evaluate(() => window.__viewer?.pdf == null), true);
  console.log('PASS agent startup opens its landing without loading a PDF');
  await page.goto(base + '/?topbar=static&document=' + encodeURIComponent(paper.docId), { waitUntil: 'domcontentloaded' });
  await assertGated();
  await waitForReady('reading', 1);
  assert.equal(await page.evaluate(() => window.__state.doc.docId), paper.docId);
  console.log('PASS explicit document links override startup preference');
  await page.evaluate(() => window.__viewer.goToPage(9));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('reader.window.main.progress') || '{}').docs?.[window.__state.doc.docId]?.page === 9);
  await page.evaluate(() => {
    localStorage.setItem('reader.startupPage', 'resume');
    localStorage.setItem('reader.workspace.v1', JSON.stringify({ tabs: [], active: '' }));
  });
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await assertGated();
  await waitForReady('reading', 9);
  assert.equal(await page.evaluate(() => window.__state.doc.docId), paper.docId);
  console.log('PASS resume can use last reading record when no tabs are saved');
  await page.evaluate(() => localStorage.setItem('reader.startupPage', 'invalid'));
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await waitForReady('library');
  assert.ok(await isLibrary());
  await page.locator('#settingsBtn').click(); await page.locator('#settingsNavBehavior').click();
  await page.screenshot({ path: path.join(scratch, 'startup-settings.png') });
  assert.equal(await page.$eval('#startupPage', n => n.value), 'library');
  assert.deepEqual(errors, []);
  failModule = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.startup === 'error');
  assert.equal(await page.$eval('#startupRetry', n => n.hidden), false);
  assert.equal(await page.$eval('#home', n => getComputedStyle(n).visibility), 'hidden');
  failModule = false;
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('#startupRetry').click()]);
  await waitForReady('library');
  console.log('PASS startup waits for its target screen and saved-page paint; failed module offers a working retry');
  failModule = failBootstrap = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.startup === 'error');
  assert.equal(await page.$eval('#startupMessage', n => n.textContent), '暂时未能完成加载');
  assert.equal(await page.$eval('#startupRetry', n => n.hidden), false);
  failModule = failBootstrap = false;
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('#startupRetry').click()]);
  await waitForReady('library');
  console.log('PASS missing bootstrap and module still offer a working retry');

  // Stub only native IPC, never the real user's window. While config is held,
  // the external module has registered its graceful-close listener but boot
  // has not published an editable workspace or installed its save callbacks.
  const nativePage = await browser.newPage();
  let holdConfig = true, releaseConfig, nativeFailure = '';
  await nativePage.setRequestInterception(true);
  nativePage.on('request', async request => {
    const pathname = new URL(request.url()).pathname;
    if (nativeFailure && pathname === '/js/app.js' || nativeFailure === 'both' && pathname === '/js/startup.js') {
      await request.abort(); return;
    }
    if (holdConfig && pathname === '/api/config') await new Promise(resolve => { releaseConfig = resolve; });
    await request.continue().catch(() => {});
  });
  await nativePage.evaluateOnNewDocument(() => {
    window.__PRT_WINDOW_ID = 'main';
    window.__nativeMessages = [];
    let closeRequest = 0;
    window.ipc = { postMessage(value) {
      const message = JSON.parse(value); window.__nativeMessages.push(message);
      if (message.type === 'close') queueMicrotask(() => dispatchEvent(new CustomEvent('prt-desktop', {
        detail: { type: 'close-request', request: ++closeRequest },
      })));
    } };
  });
  const checkNativeControls = async normalHandler => {
    assert.equal(await nativePage.$eval('#startupWindowBar', node => node.hidden), false);
    assert.equal(await nativePage.evaluate(() => !!window.__prtCloseHandlerReady), normalHandler);
    await nativePage.locator('#startupMinimize').click();
    await nativePage.mouse.move(80, 18); await nativePage.mouse.down(); await nativePage.mouse.up();
    await nativePage.locator('#startupClose').click();
    await nativePage.waitForFunction(() => window.__nativeMessages.some(item => item.type === 'close-commit'));
    assert.deepEqual(await nativePage.evaluate(() => window.__nativeMessages), [
      { type: 'minimize' }, { type: 'drag' }, { type: 'close' }, { request: 1, type: 'close-commit' },
    ], 'each close request receives exactly one acknowledgement');
  };
  await nativePage.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await checkNativeControls(true);
  holdConfig = false; releaseConfig();
  await nativePage.waitForFunction(() => !document.documentElement.hasAttribute('data-startup'));
  await nativePage.evaluate(async () => {
    const { startWindows } = await import('/js/windows.js');
    startWindows({ close: () => new Promise(resolve => { window.__finishCloseSave = resolve; }) });
    window.__nativeMessages = [];
    window.ipc.postMessage(JSON.stringify({ type: 'close' }));
  });
  await nativePage.waitForFunction(() => !!window.__finishCloseSave);
  assert.deepEqual(await nativePage.evaluate(() => window.__nativeMessages), [{ type: 'close' }], 'startup must never bypass the normal save handshake');
  await nativePage.evaluate(() => window.__finishCloseSave());
  await nativePage.waitForFunction(() => window.__nativeMessages.some(item => item.type === 'close-commit'));
  assert.deepEqual(await nativePage.evaluate(() => window.__nativeMessages), [{ type: 'close' }, { request: 2, type: 'close-commit' }]);
  for (nativeFailure of ['module', 'both']) {
    await nativePage.reload({ waitUntil: 'domcontentloaded' });
    await nativePage.waitForFunction(() => document.documentElement.dataset.startup === 'error');
    await checkNativeControls(false);
  }
  await nativePage.close();
  console.log('PASS native startup close/minimize/drag work during delayed and failed boot; normal close still awaits saving');
  console.log('PASS invalid preference defaults to Library; ' + (desktop ? 'desktop' : 'Node') + '; ' + scratch);

} finally { await browser?.close(); await stopChild(reader); }
