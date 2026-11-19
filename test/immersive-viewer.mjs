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
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'immersive-viewer-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
// Trim the synthetic page tree to 15 pages without changing object offsets.
// The unused final object remains valid PDF data; the last spread is now odd.
const fixture = fs.readFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), 'latin1');
const oddFixture = fixture.replace(/\/Type \/Pages \/Count 16 \/Kids \[([^\]]+)\]/, (_, children) =>
  '/Type /Pages /Count 15 /Kids [' + children.replace(/\d+ 0 R\s*$/, ref => ' '.repeat(ref.length)) + ']');
assert.notEqual(fixture, oddFixture);
fs.writeFileSync(path.join(papers, 'Reading.pdf'), oddFixture, 'latin1');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('immersive-viewer').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready);
  for (const asset of ['js/pdfview.js', 'immersive-viewer.css']) {
    assert.ok(await fetch(`${base}/${asset}`).then(r => r.text()) === fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `${asset} matches the current source`);
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
  assert.equal((await state()).current, 3, 'failed page rendering preserves the previous spread');
  await page.evaluate(() => {
    const viewer = window.__viewer, animate = viewer._animateImmersiveTurn;
    document.documentElement.dataset.motion = 'on';
    window.__turns = [];
    viewer._animateImmersiveTurn = async function (options) {
      const record = { target: options.start, frames: 0, coveredSetup: false, uncoveredSetup: false, unexpectedCover: false };
      const started = performance.now();
      let active = true, frame;
      const inspect = (countFrame = false) => {
        const stage = document.querySelector('.immersive-page-turn');
        const covers = document.querySelectorAll('body > .immersive-turn-snapshot').length;
        if (covers > 2) record.unexpectedCover = true;
        if (stage && getComputedStyle(stage).visibility === 'hidden') {
          if (covers === 2) record.coveredSetup = true;
          else record.uncoveredSetup = true;
        }
        if (countFrame && stage && getComputedStyle(stage).visibility === 'visible') record.frames++;
      };
      const tick = () => { inspect(true); if (active) frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
      const observer = new MutationObserver(() => inspect());
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
      try { await animate.call(this, options); }
      finally {
        active = false; cancelAnimationFrame(frame); observer.disconnect();
        record.duration = performance.now() - started;
        window.__turns.push(record);
      }
    };
  });
  await page.evaluate(() => window.__viewer.goToPage(3));
  await page.evaluate(() => {
    const viewer = window.__viewer, render = viewer._renderPage;
    window.__oldSpread = [3,4].map(n => viewer.rendered.get(n).canvas.toDataURL());
    const blocked = new Promise(resolve => { window.__releaseSlowRender = resolve; });
    viewer._renderPage = async function (n, options) {
      if (n === 5) { window.__slowPageStarted = true; await blocked; }
      return render.call(this, n, options);
    };
    window.__slowTurn = viewer.stepPage(1).finally(() => { viewer._renderPage = render; });
  });
  await page.waitForFunction(() => window.__slowPageStarted);
  assert.equal(await page.evaluate(() => {
    const covers = [...document.querySelectorAll('body > .immersive-turn-snapshot > canvas')];
    return covers.length === 2 && covers.every((canvas, i) => canvas.toDataURL() === window.__oldSpread[i]);
  }), true, 'slow destination rendering keeps the complete previous spread visible');
  await page.evaluate(async () => { window.__releaseSlowRender(); await window.__slowTurn; });
  assert.deepEqual((await state()).visible, [5,6]); assert.equal((await state()).overlays, 0);
  await page.screenshot({ path: path.join(scratch, 'spread.png') });
  await page.evaluate(() => window.__viewer.goToPage(8));
  assert.deepEqual((await state()).visible, [7,8]);
  const queued = await page.evaluate(async () => {
    const viewer = window.__viewer;
    const previous = viewer.stepPage(-1), previousAgain = viewer.stepPage(-1), next = viewer.stepPage(1);
    await Promise.all([previous, previousAgain, next]);
    return { page: viewer.current, turns: window.__turns };
  });
  assert.equal(queued.page, 5, 'rapid relative clicks each advance from the previous completed spread');
  assert.deepEqual(queued.turns.map(turn => turn.target), [5,7,5,3,5]);
  for (const turn of queued.turns) {
    assert.ok(turn.frames >= 3, `spread ${turn.target} painted animated frames: ${JSON.stringify(turn)}`);
    assert.ok(turn.duration >= 250 && turn.duration < 880, `spread ${turn.target} completed the animation, not a timer fallback`);
    assert.equal(turn.coveredSetup, true, 'old pages cover the hidden animation setup');
    assert.equal(turn.uncoveredSetup, false, 'no setup frame reveals the new spread');
    assert.equal(turn.unexpectedCover, false, 'destination snapshots are never briefly shown as static covers');
  }
  await page.evaluate(() => window.__viewer.goToPage(8));
  await page.evaluate(() => { document.documentElement.dataset.motion = 'on'; void window.__viewer.stepPage(-1); });
  await page.waitForSelector('.immersive-page-turn', { timeout: 3000 });
  await page.screenshot({ path: path.join(scratch, 'turn.png') });
  await page.evaluate(async () => {
    const viewer = window.__viewer, pending = [viewer.stepPage(-1), viewer.stepPage(1)];
    await viewer.setImmersive(false);
    await Promise.all(pending);
  });
  assert.equal((await state()).immersive, false); assert.equal((await state()).overlays, 0);
  assert.equal((await state()).scale, original.scale); assert.equal((await state()).twoUp, original.twoUp);
  assert.equal((await state()).current, 5, 'exit keeps final reading progress');
  await page.evaluate(async () => { document.documentElement.dataset.motion = 'off'; await window.__viewer.setImmersive(true); await window.__viewer.goToPage(1); });
  assert.equal((await state()).overlays, 0);
  for (const theme of ['dark', 'light', 'glass']) {
    const surface = await page.evaluate(async theme => {
      document.documentElement.dataset.theme = theme;
      await window.__viewer.goToPage(1);
      return { paper: getComputedStyle(window.__viewer.pageEls[1]).backgroundColor,
        viewport: getComputedStyle(window.__viewer.container).backgroundColor,
        renderedPaper: window.__viewer.rendered.get(1).paper };
    }, theme);
    assert.equal(surface.paper, surface.viewport, `${theme} has one continuous immersive paper surface`);
    if (theme === 'dark') {
      assert.equal(surface.paper, 'rgb(34, 36, 38)', 'dark immersive reading never inherits the white paper preference');
      assert.equal(surface.renderedPaper, '#222426', 'PDF ink uses the night rendering palette');
      await page.screenshot({ path: path.join(scratch, 'dark-spread.png') });
    }
    await page.evaluate(() => { document.documentElement.dataset.motion = 'on'; void window.__viewer.stepPage(1); });
    await page.waitForFunction(() => {
      const turn = document.querySelector('.immersive-page-turn');
      return turn && getComputedStyle(turn).visibility === 'visible';
    });
    const backgrounds = await page.$$eval('.immersive-flip-page', pages => pages.map(p => getComputedStyle(p).backgroundColor));
    assert.ok(backgrounds.length >= 4 && backgrounds.every(color => color === surface.paper), `${theme}: all page fronts and backs match the reading surface`);
    if (theme === 'dark') await page.screenshot({ path: path.join(scratch, 'dark-turn.png') });
    await page.evaluate(async () => { await window.__viewer._immersiveNavigation; document.documentElement.dataset.motion = 'off'; });
  }
  await page.evaluate(async () => { await window.__viewer.goToPage(13); document.documentElement.dataset.motion = 'on'; await window.__viewer.stepPage(1); });
  assert.equal((await state()).current, 15);
  assert.deepEqual((await state()).visible, [15]);
  assert.equal(await page.evaluate(() => {
    const viewer = window.__viewer, blank = getComputedStyle(viewer.pagesEl, '::after');
    return blank.content === '""' && parseFloat(blank.width) > 0;
  }), true, 'odd final pages retain an empty right leaf');
  await page.screenshot({ path: path.join(scratch, 'odd-final-spread.png') });
  await page.evaluate(() => window.__viewer.stepPage(-1));
  assert.equal((await state()).current, 13);
  const lastTurns = await page.evaluate(() => window.__turns.slice(-2));
  assert.deepEqual(lastTurns.map(turn => turn.target), [15,13]);
  assert.ok(lastTurns.every(turn => turn.frames >= 3 && turn.duration < 880), 'turning to and back from an odd final page both animate');
  await page.setViewport({ width: 1100, height: 760 }); await pause(150);
  assert.equal((await state()).fits, true, 'resize refits both complete pages');
  await page.evaluate(() => window.__viewer.setImmersive(false));
  assert.deepEqual(errors, []);
  console.log('PASS fixed/odd spreads, continuous queued page turns, covered animation setup, night paper, failure recovery, cancellation, and exit restoration; ' + scratch);
} finally { await browser?.close(); await stopChild(reader); }
