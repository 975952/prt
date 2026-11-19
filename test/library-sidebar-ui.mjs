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
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'library-sidebar-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
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
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-sidebar-resize');
  const width = () => page.$eval('.home-sidebar', node => node.offsetWidth);
  const drag = async distance => {
    const box = await page.$eval('.home-sidebar-resize', node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 90 }; });
    await page.mouse.move(box.x, box.y); await page.mouse.down();
    await page.mouse.move(box.x + distance, box.y, { steps: 10 }); await page.mouse.up();
  };
  const initial = await width();
  await drag(140);
  assert.ok(Math.abs((await width()) - initial - 100) <= 2, '140 screen pixels = 100 layout pixels at 140% zoom');
  const saved = await width();
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.home-sidebar-resize');
  assert.equal(await width(), saved);
  console.log('PASS drag tracks Library zoom and width persists after reload');
  await page.setViewport({ width: 1100, height: 1000 }); await pause(100);
  assert.ok(await width() <= saved);
  await page.setViewport({ width: 600, height: 1000 }); await pause(100);
  assert.equal(await page.$eval('.home-sidebar-resize', n => getComputedStyle(n).display), 'none');
  await page.setViewport({ width: 1600, height: 1000 }); await pause(100);
  assert.equal(await width(), saved);
  console.log('PASS narrow layout hides the handle without overwriting the saved desktop width');
  await page.locator('.home-sidebar-resize').click(); await page.keyboard.press('ArrowRight');
  assert.equal(await width(), saved + 10);
  await page.keyboard.press('End'); assert.equal(await width(), 420);
  await page.keyboard.press('Home'); assert.equal(await width(), 160);
  console.log('PASS keyboard resizing respects minimum and maximum widths');
  const grip = await page.$('.home-sidebar-resize'); await grip.click({ clickCount: 2 });
  assert.equal(await width(), initial);
  await drag(100); const beforeCancel = await width();
  const rect = await grip.boundingBox();
  await page.mouse.move(rect.x + 4, rect.y + 70); await page.mouse.down(); await page.mouse.move(rect.x + 80, rect.y + 70);
  await page.keyboard.press('Escape'); await page.mouse.up(); assert.equal(await width(), beforeCancel);
  assert.equal(await page.$eval('html', n => n.classList.contains('library-sidebar-dragging')), false);
  assert.equal(await page.$$eval('.home-sidebar-resize', nodes => nodes.length), 1);
  await page.screenshot({ path: path.join(scratch, 'sidebar.png') });
  assert.deepEqual(errors, []);
  console.log(`PASS double-click reset, Escape cancellation, single handle; ${desktop ? 'desktop' : 'Node'}; ${scratch}`);
} finally { await browser?.close(); await stopChild(reader); }
