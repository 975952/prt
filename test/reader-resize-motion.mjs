/** Actual divider drags: live fit, bitmap continuity and isolated reader data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop'), probe = process.argv.includes('--probe');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `reader-resize-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'resize.pdf'));
const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const base = `http://127.0.0.1:${port}`, checks = [], errors = [], runs = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (label, value, detail = null) => { checks.push({ label, ok: !!value, detail }); console.log(`${value ? 'PASS' : 'FAIL'} ${label}`); };
let reader, browser, page;
try {
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('reader-resize').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await wait(100); }
  for (const asset of ['style.css', 'js/app.js', 'js/pdfview.js']) assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  page = await browser.newPage(); await page.setViewport({ width: 1600, height: 960 }); page.setDefaultTimeout(20000);
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) errors.push(r.failure()?.errorText); });
  await page.goto(`${base}/?open=resize.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0);
  await page.evaluate(() => window.__ctx.resetPanels()); await wait(350);
  await page.evaluate(() => window.__viewer.fitWidth()); await wait(300);
  for (const [side, delta] of [['right', -220], ['right', 180], ['left', 170], ['left', -130]]) {
    const selector = side === 'left' ? '#splitLeft' : '#splitRight';
    const handle = await page.$eval(selector, n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.evaluate(side => {
      const v = window.__viewer;
      const sidebar = document.getElementById(side === 'left' ? 'leftSide' : 'rightSide');
      const sample = () => {
        const p = v.pageEls[v.current], c = v.container, pr = p.getBoundingClientRect(), cr = c.getBoundingClientRect();
        const canvas = [...p.querySelectorAll('canvas')].filter(n => getComputedStyle(n).visibility !== 'hidden' && n.width > 0);
        const bitmap = canvas[0]?.getBoundingClientRect();
        const entry = v.rendered.get(v.current);
        const inside = document.elementsFromPoint(cr.right + 6, Math.min(cr.bottom - 20, cr.top + 160));
        return { at: performance.now(), width: c.clientWidth, pageWidth: pr.width, canvasWidth: bitmap?.width || 0,
          lag: Math.abs(c.clientWidth - 20 - pr.width), visibleCanvas: canvas.length,
          clipped: !inside.some(n => n.tagName === 'CANVAS' && p.contains(n)), scale: v.scale,
          dirty: entry?.dirty, renderScale: entry?.renderScale,
          widthTransition: getComputedStyle(sidebar).transitionDuration,
          dragging: document.body.classList.contains('dragging') };
      };
      const trace = window.__resizeTrace = { frames: [], renders: [], starts: [], sample, renderPage: v._renderPage };
      v._renderPage = function(...args) {
        trace.starts.push({ at: performance.now(), page: args[0], dragging: document.body.classList.contains('dragging') });
        return trace.renderPage.apply(this, args);
      };
      trace.observer = new ResizeObserver(() => trace.frames.push(sample())); trace.observer.observe(v.container);
      trace.listener = e => trace.renders.push({ at: performance.now(), page: e.detail.page, dragging: document.body.classList.contains('dragging') });
      document.addEventListener('pdfview:page-rendered', trace.listener);
    }, side);
    await page.mouse.move(handle.x, handle.y); await page.mouse.down();
    for (let step = 1; step <= 24; step++) {
      await page.mouse.move(handle.x + delta * step / 24, handle.y); await wait(18);
      if (step === 12) await page.screenshot({ path: path.join(scratch, `${side}-${delta}-drag.png`) });
    }
    const beforeRelease = await page.evaluate(() => window.__resizeTrace.sample());
    await page.mouse.up(); await wait(500);
    const result = await page.evaluate(() => {
      const t = window.__resizeTrace; t.observer.disconnect(); document.removeEventListener('pdfview:page-rendered', t.listener);
      window.__viewer._renderPage = t.renderPage;
      return { frames: t.frames, renders: t.renders, starts: t.starts, settled: t.sample() };
    });
    result.side = side; result.delta = delta; result.beforeRelease = beforeRelease; runs.push(result);
    const moving = result.frames.filter(f => f.dragging);
    check(`${side} divider follows the pointer without width easing`, moving.length > 12 && moving.every(f =>
      !f.widthTransition.split(',').some(t => parseFloat(t) > 0)), { durations: [...new Set(moving.map(f => f.widthTransition))], frames: moving.length });
    check(`${side} fit tracks each visible divider frame`, moving.length > 12 && moving.every(f => f.lag <= 2.5), { maxLag: Math.max(...moving.map(f => f.lag)) });
    check(`${side} keeps an aligned visible bitmap throughout dragging`, moving.every(f => f.visibleCanvas >= 1 && Math.abs(f.canvasWidth - f.pageWidth) <= 2));
    check(`${side} keeps PDF pixels clipped separately from its shadow`, moving.every(f => f.clipped));
    check(`${side} postpones sharp repaint until release`, !result.starts.some(r => r.dragging) && result.renders.filter(r => r.dragging).length <= 1,
      { starts: result.starts, completed: result.renders });
    check(`${side} release preserves the final width`, Math.abs(beforeRelease.pageWidth - result.settled.pageWidth) <= 2 && result.settled.lag <= 2);
    check(`${side} release replaces the preview with a sharp bitmap`, result.settled.dirty === false &&
      Math.abs(result.settled.renderScale - result.settled.scale) < 0.001);
  }
  check('dragging leaves no browser errors', errors.length === 0, errors);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, runs, errors }, null, 2), 'utf8');
  console.log(`reader-resize-motion: ${checks.filter(c => c.ok).length}/${checks.length}; ${scratch}`);
  if (!probe) assert.equal(checks.filter(c => !c.ok).length, 0, checks.filter(c => !c.ok).map(c => c.label).join('\n'));
} finally { await browser?.close(); await stopChild(reader); }
