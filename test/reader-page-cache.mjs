/** Cached text/image pages retain bitmaps on book turns; isolated synthetic PDFs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeScannedFixture } from './fixtures/make-scanned-pdf.mjs';
const desktop = process.argv.includes('--desktop'), measure = process.argv.includes('--measure');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'reader-page-cache-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
writeScannedFixture(path.join(papers, 'scans.pdf'));
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'text.pdf'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('reader-page-cache').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await pause(100); }
  assert.equal(await fetch(base + '/js/pdfview.js').then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public/js/pdfview.js'), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 960 } });
  const page = await browser.newPage(), errors = [], metrics = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  for (const name of ['scans.pdf', 'text.pdf']) {
    await page.goto(`${base}/?open=${name}&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
    await page.evaluate(async () => {
      const v = __viewer; document.documentElement.dataset.motion = 'off';
      await Promise.all([...v.renderTasks.values()]);
      await v.setImmersive(true); await Promise.all([...v.renderTasks.values()]);
      v._cancelPrefetch();
      window.__schedulePrefetch = v._schedulePrefetch;
      v._schedulePrefetch = () => {};
      await Promise.all([...v.renderTasks.values()]);
      const originals = new Map(); window.__pageWork = { render: 0, text: 0 };
      for (let i = 1; i <= 4; i++) {
        const p = await v.pdf.getPage(i); originals.set(p, { render: p.render, text: p.getTextContent });
        p.render = function(...args) { __pageWork.render++; return originals.get(p).render.apply(this,args); };
        p.getTextContent = function(...args) { __pageWork.text++; return originals.get(p).text.apply(this,args); };
      }
      await v.goToPage(3); await v.goToPage(1);
      window.__pageWork = { render: 0, text: 0 };
    });
    const roundTrip = await page.evaluate(async () => {
      const v = __viewer, canvases = [1,2,3,4].map(i => v.rendered.get(i).canvas);
      const start = performance.now();
      for (let i = 0; i < 3; i++) { await v.stepPage(1); await v.stepPage(-1); }
      await v.refreshPage(1); await v.refreshPage(1);
      return { ms: performance.now() - start, ...__pageWork,
        retained: canvases.every((c, i) => v.rendered.get(i + 1)?.canvas === c) };
    });
    const rescale = await page.evaluate(async () => {
      window.__pageWork = { render: 0, text: 0 }; const start = performance.now();
      for (let i = 0; i < 3; i++) await __viewer._renderPage(1, { force: true });
      return { ms: performance.now() - start, ...__pageWork };
    });
    const prefetched = await page.evaluate(async () => {
      const v = __viewer;
      v._schedulePrefetch = __schedulePrefetch;
      for (const n of [3,4]) v._teardownPage(n);
      v._schedulePrefetch(0);
      const deadline = performance.now() + 2500;
      while (performance.now() < deadline) {
        if ([3,4].every(n => v.rendered.get(n)?.canvas.width && !v.renderTasks.has(n))) return true;
        await new Promise(r => setTimeout(r, 30));
      }
      return false;
    });
    const repeatedFit = await page.evaluate(async () => {
      const v = __viewer; v._cancelPrefetch(); v._schedulePrefetch = () => {};
      await v.setImmersive(false); v.fitWidth();
      await new Promise(r => setTimeout(r, 180));
      await Promise.all([...v.renderTasks.values()]);
      window.__pageWork = { render: 0, text: 0 };
      const canvas = v.rendered.get(1).canvas;
      v.fitWidth(); v.fitWidth(); await v.refreshPage(1);
      await new Promise(r => setTimeout(r, 180));
      return { ...__pageWork, retained: canvas === v.rendered.get(1).canvas };
    });
    const beforeResize = await page.evaluate(() => {
      window.__beforeResizeCanvas = __viewer.rendered.get(1).canvas;
      return __viewer.scale;
    });
    await page.setViewport({ width: 1250, height: 960 });
    await page.waitForFunction(scale => __viewer.scale !== scale && __viewer.rendered.get(1)?.complete
      && !__viewer.rendered.get(1).dirty && !__viewer.renderTasks.has(1), {}, beforeResize);
    const resize = await page.evaluate(() => ({ replaced: __viewer.rendered.get(1).canvas !== __beforeResizeCanvas,
      matchesScale: Math.abs(__viewer.rendered.get(1).renderScale - __viewer.scale) < .001 }));
    metrics.push({ name, roundTrip, rescale, prefetched, repeatedFit, resize });
    if (!measure) {
      assert.equal(roundTrip.render, 0, `${name}: cached book turns do not rerasterize`);
      assert.equal(roundTrip.text, 0, `${name}: cached book turns do not re-extract text`);
      assert.equal(roundTrip.retained, true, `${name}: warm pages keep their exact canvas`);
      assert.equal(rescale.text, 0, `${name}: repeated raster work reuses extracted text`);
      assert.equal(prefetched, true, `${name}: next spread is prepared before navigation`);
      assert.equal(repeatedFit.render, 0, `${name}: repeated fit does not invalidate valid bitmap`);
      assert.equal(repeatedFit.retained, true, `${name}: repeated fit keeps exact canvas`);
      assert.equal(resize.replaced, true, `${name}: changed viewport receives a newly rendered bitmap`);
      assert.equal(resize.matchesScale, true, `${name}: resized bitmap matches final fit scale`);
    }
    await page.setViewport({ width: 1500, height: 960 });
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`PASS image and text page cache; ${scratch}`);
} finally { await browser?.close(); await stopChild(reader); }
