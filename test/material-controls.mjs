/** Isolated visual/interaction checks for background tone and crystal surfaces. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `material-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'sample.pdf'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser;
try {
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`, env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  child = desktop ? spawnReader(stageExe('material').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready);
  for (const file of ['js/app.js', 'style.css']) assert.equal(await fetch(`${base}/${file}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}/?open=sample.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0 && !window.__viewer.renderTasks.size);
  await page.evaluate(() => document.fonts.ready);
  if (await page.$eval('#rightCols', el => el.getBoundingClientRect().width === 0)) await page.click('#topbarRightToggle');
  await page.waitForFunction(() => document.querySelector('#rightCols').getBoundingClientRect().width > 200 && !window.__viewer.renderTasks.size);
  await wait(350);
  const set = (id, value) => page.$eval(`#${id}`, (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const snapshot = () => page.evaluate(() => ({
    bg: getComputedStyle(document.documentElement).getPropertyValue('--glass-bg').trim(),
    low: getComputedStyle(document.documentElement).getPropertyValue('--glass-bg-low').trim(),
    title: document.querySelector('#uiGlassToneValue').textContent,
    canvas: window.__viewer.rendered.get(1).canvas.toDataURL(),
    scroll: window.__viewer.container.scrollTop, scale: window.__viewer.scale,
  }));
  const initial = await snapshot();
  assert.equal(initial.bg, 'rgb(252 250 247)', 'default retains the accepted subtly warm background');
  await set('uiGlassTone', 0); const neutral = await snapshot();
  await page.screenshot({ path: path.join(scratch, 'neutral.png') });
  await set('uiGlassTone', 100); const warm = await snapshot();
  await page.screenshot({ path: path.join(scratch, 'warm.png') });
  assert.equal(neutral.bg, 'rgb(253 253 253)'); assert.equal(warm.bg, 'rgb(255 244 224)');
  assert.notEqual(neutral.low, warm.low); assert.equal(warm.title, '100%');
  assert.equal(neutral.canvas, warm.canvas); assert.equal(neutral.scroll, warm.scroll); assert.equal(neutral.scale, warm.scale);
  console.log('PASS tone changes neutral white to warm white without recoloring PDF pixels or moving the page');
  await set('uiGlassTone', 20);
  const screenshots = [];
  for (const value of [0, 55, 100]) {
    await set('uiGlassCrystal', value); await wait(100);
    screenshots.push(Buffer.from(await page.screenshot({ path: path.join(scratch, `crystal-${value}.png`) })).toString('base64'));
  }
  const difference = await page.evaluate(async ([low, high]) => {
    const decode = async b64 => {
      const im = new Image(); im.src = `data:image/png;base64,${b64}`; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, c.width, c.height);
    };
    const [a, b] = await Promise.all([decode(low), decode(high)]);
    const r = document.querySelector('#rightSide').getBoundingClientRect();
    const areas = [{ x: r.right - 14, y: r.top + 40, width: 12, height: r.height - 80 }];
    let total = 0, count = 0, changed = 0;
    for (const area of areas) for (let y = Math.ceil(area.y); y < Math.min(a.height, area.y + area.height); y++) for (let x = Math.ceil(area.x); x < Math.min(a.width, area.x + area.width); x++) {
      const i = (y * a.width + x) * 4;
      const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
      total += d; count++; if (d > 5) changed++;
    }
    return { mean: total / count, changed: changed / count };
  }, [screenshots[0], screenshots[2]]);
  assert.ok(difference.mean > 6 && difference.changed > .5, `material visibly changes rendered edge pixels: ${JSON.stringify(difference)}`);
  assert.equal((await snapshot()).canvas, initial.canvas, 'crystal does not modify the PDF canvas');
  console.log(`PASS crystal 0–100 visibly changes rendered edge pixels: ${JSON.stringify(difference)}`);
  await page.click('#settingsBtn'); await page.click('#settingsNavAppearance');
  await page.waitForSelector('#uiGlassTone', { visible: true });
  await page.focus('#uiGlassTone'); await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.$eval('#uiGlassTone', n => n.value), '99');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--glass-crystal') === '1');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style);
  assert.equal(saved.glassTone, 99); assert.equal(saved.glassCrystal, 100);
  await page.click('#settingsBtn'); await page.click('#settingsNavAppearance');
  assert.equal(await page.$eval('#uiGlassTone', n => n.value), '99');
  await page.screenshot({ path: path.join(scratch, 'settings.png') });
  await page.click('#resetAppearanceEffects');
  assert.equal(await page.$eval('#uiGlassTone', n => n.value), '20');
  assert.equal(await page.$eval('#uiGlassCrystal', n => n.value), '55');
  assert.deepEqual(errors, []);
  console.log(`PASS keyboard adjustment, reload persistence and default reset (${desktop ? 'embedded desktop' : 'Node'}). Artifacts: ${scratch}`);
} finally { await browser?.close(); await stopChild(child); }
