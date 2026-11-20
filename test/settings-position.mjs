/** Settings starts centered on each open; all data and PDFs are disposable. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `settings-position-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'settings.pdf'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], checks = [];
let reader, browser, page;
const check = (label, condition, detail) => {
  checks.push({ label, passed: !!condition, detail });
  assert.ok(condition, `${label}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${label}`);
};
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('settings-position').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* starting */ }
    if (!ready) await wait(100);
  }
  assert.ok(ready, 'isolated service starts');
  const chrome = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 960 } });
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'en'));
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const rect = () => page.$eval('#settingsModal .modal-box', node => {
    const r = node.getBoundingClientRect();
    const head = node.querySelector('.modal-head').getBoundingClientRect();
    const foot = node.querySelector('.modal-foot').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height,
      dx: r.x + r.width / 2 - innerWidth / 2, dy: r.y + r.height / 2 - innerHeight / 2,
      fits: r.left >= 7 && r.top >= 7 && r.right <= innerWidth - 7 && r.bottom <= innerHeight - 7,
      controlsFit: head.top >= r.top && foot.bottom <= r.bottom + 1,
      horizontalOverflow: node.scrollWidth - node.clientWidth, position: node.style.position };
  });
  const centered = async label => {
    await frames(); const r = await rect();
    check(label, Math.abs(r.dx) <= 1 && Math.abs(r.dy) <= 1 && r.fits && r.controlsFit && r.horizontalOverflow <= 1, r);
    return r;
  };
  const open = async () => {
    await page.click('#settingsBtn');
    await page.waitForSelector('#settingsModal:not(.hidden)', { visible: true });
    await frames();
  };
  const close = async () => { await page.click('#closeSettings'); await page.waitForSelector('#settingsModal.hidden'); };
  const stablePanes = async label => {
    const before = await rect();
    for (const pane of ['Language', 'Agent', 'Appearance', 'Behavior', 'Session', 'Memory', 'Library', 'Model']) {
      await page.click(`#settingsNav${pane}`); await frames();
      const after = await rect();
      check(`${label}: ${pane} preserves frame position and size`,
        ['x', 'y', 'width', 'height'].every(key => Math.abs(before[key] - after[key]) < 1), { before, after });
    }
  };
  await open();
  await centered('initial Settings is centered in the viewport');
  await page.screenshot({ path: path.join(scratch, 'settings-centered.png') });
  await stablePanes('centered');
  await page.click('#settingsNavLanguage');
  const beforeDrag = await rect();
  const handle = await page.$eval('#settingsModal .modal-head', n => { const r = n.getBoundingClientRect(); return { x: r.left + 50, y: r.top + 12 }; });
  await page.mouse.move(handle.x, handle.y); await page.mouse.down();
  await page.mouse.move(handle.x + 110, handle.y + 65, { steps: 8 }); await page.mouse.up();
  const dragged = await rect();
  check('Settings remains draggable during the current open', dragged.position === 'fixed' && dragged.x - beforeDrag.x > 90 && dragged.y - beforeDrag.y > 45, dragged);
  await stablePanes('after dragging');
  await close(); await open();
  await centered('reopening Settings discards the previous drag offset');
  check('reopened Settings returns to normal layout', (await rect()).position !== 'fixed');
  await close();
  await page.keyboard.down('Control'); await page.keyboard.press('+'); await page.keyboard.press('+'); await page.keyboard.up('Control');
  await open(); await centered('Library zoom does not shift Settings'); await close();
  await page.click('#homeAgent'); await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  for (let i = 0; i < 6; i++) { await page.keyboard.down('Control'); await page.keyboard.press('+'); await page.keyboard.up('Control'); }
  await open(); await centered('Alina zoom does not shift Settings'); await close();
  await page.goto(`${base}/?open=settings.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.numPages > 0 && window.__state?.viewerDocId === window.__state?.doc?.docId);
  await open(); await centered('Settings opens centered from the reader'); await close();
  for (const [width, height] of [[900, 420], [480, 720], [360, 560]]) {
    await page.setViewport({ width, height });
    await open(); await centered(`Settings fits and centers at ${width} by ${height}`);
    await stablePanes(`${width} by ${height}`);
    await page.screenshot({ path: path.join(scratch, `settings-${width}.png`) });
    await close();
  }
  check('no browser errors', errors.length === 0, errors);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors }, null, 2), 'utf8');
  console.log(`settings-position: ${checks.length}/${checks.length}; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ checks, errors, error: error.stack || String(error) }, null, 2), 'utf8');
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Settings artifacts: ${scratch}`);
  throw error;
} finally { await browser?.close(); await stopChild(reader); }
