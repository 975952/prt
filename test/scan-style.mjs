/** Pure image pages stay square across zoom, virtualization and theme changes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeScannedFixture } from './fixtures/make-scanned-pdf.mjs';
const desktop = process.argv.includes('--desktop');
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'scan-style-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers); writeScannedFixture(path.join(papers, 'scans.pdf'));
const wait = ms => new Promise(r => setTimeout(r, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('scan-style').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await wait(100); }
  for (const asset of ['style.css', 'js/pdfview.js']) assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()),
    fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `current embedded ${asset}`);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1350, height: 1000, deviceScaleFactor: 2 } });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}/?open=scans.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf);
  const ready = async n => page.waitForFunction(n => {
    const v = window.__viewer;
    return v?.rendered.get(n) && v.pageEls[n]?.dataset.imageOnly && !v.renderTasks.has(n);
  }, { timeout: 30000 }, n);
  const style = n => page.evaluate(n => {
    const p = window.__viewer.pageEls[n], cs = getComputedStyle(p);
    return { kind: p.dataset.imageOnly, radius: cs.borderRadius, paper: cs.backgroundColor,
      shadow: cs.boxShadow, frost: cs.backdropFilter, sheen: getComputedStyle(p, '::before').display,
      canvasRadius: getComputedStyle(p.querySelector('canvas')).borderRadius };
  }, n);
  for (const n of [1, 2, 3, 4]) {
    await page.evaluate(n => window.__viewer.goToPage(n), n); await ready(n);
    const s = await style(n);
    if (n < 4) assert.deepEqual(s, { kind: 'true', radius: '0px', paper: 'rgb(255, 255, 255)', shadow: 'none', frost: 'none', sheen: 'none', canvasRadius: '0px' });
    else { assert.equal(s.kind, 'false'); assert.equal(s.radius, '24px'); }
  }
  console.log('PASS alternating scan margins use square white paper; mixed text/image pages retain glass');
  const pixels = await page.evaluate(() => {
    const c = window.__viewer.rendered.get(2).canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let teal = 0, black = 0, white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 12 && d[i + 1] === 128 && d[i + 2] === 132 && d[i + 3] === 255) teal++;
      if (d[i] === 42 && d[i + 1] === 42 && d[i + 3] === 255) black++;
      if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255 && d[i + 3] === 255) white++;
    }
    return { teal, black, white };
  });
  assert.ok(Object.values(pixels).every(n => n > 100));
  await page.evaluate(() => { window.__viewer.setScale(.75); window.__viewer.goToPage(1); });
  await ready(1); await wait(300);
  await page.screenshot({ path: path.join(scratch, 'square-scans.png') });
  await page.evaluate(async () => {
    const v = window.__viewer; v._teardownPage(1); await v._renderPage(1, { force: true });
    v.setScale(6);
  });
  await page.waitForFunction(() => {
    const v = window.__viewer, e = v.rendered.get(1);
    return e?.slice && e.renderScale === 6 && !v.renderTasks.has(1);
  }, { timeout: 30000 });
  assert.equal((await style(1)).radius, '0px');
  console.log('PASS original colored/white/black pixels preserved; square shape survives bitmap replacement and tiled zoom');
  await page.click('#settingsBtn'); await page.waitForSelector('#settingsModal:not(.hidden)');
  for (const theme of ['light', 'dark', 'glass']) {
    await page.evaluate(theme => { const s = document.querySelector('#uiTheme'); s.value = theme; s.dispatchEvent(new Event('input', { bubbles: true })); }, theme);
    await wait(300); assert.equal((await style(1)).radius, '0px');
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.evaluate(() => window.__viewer.goToPage(1));
  await ready(1);
  assert.equal((await style(1)).radius, '0px');
  assert.deepEqual(errors, []);
  console.log(`PASS ${desktop ? 'desktop' : 'Node'} scan styling, theme switching and reload: ${scratch}`);
} finally { await browser?.close(); if (reader) await stopChild(reader); }
