/** Isolated visual regression: paper shadows escape the scroller, PDF pixels do not. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'reader-depth-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'depth.pdf'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [];
const check = (label, ok, detail) => {
  checks.push({ label, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(detail)}`);
  assert.ok(ok, label);
};
let reader, browser;
try {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('reader-depth').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* startup */ }
    await wait(100);
  }
  for (const asset of ['style.css', 'js/pdfview.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 950 } });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) errors.push(`${r.url()} ${r.failure()?.errorText}`); });
  await page.goto(`${base}/?open=depth.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0);
  await wait(400);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = () => page.evaluate(() => {
    const viewer = window.__viewer, c = viewer.container, cr = c.getBoundingClientRect();
    const shadows = [...document.querySelectorAll('.paper-shadow')].map(shadow => {
      const sr = shadow.getBoundingClientRect(), paper = viewer.pageEls[Number(shadow.dataset.page)].getBoundingClientRect();
      return { page: Number(shadow.dataset.page), dx: sr.left - paper.left, dy: sr.top - paper.top,
        dw: sr.width - paper.width, dh: sr.height - paper.height };
    });
    const paper = viewer.pageEls[viewer.current].getBoundingClientRect();
    const layer = document.querySelector('.paper-shadow-layer');
    return { shadows, layers: document.querySelectorAll('.paper-shadow-layer').length,
      width: c.clientWidth, gutter: paper.left - cr.left, travel: c.scrollWidth - c.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      layerInteractive: getComputedStyle(layer).pointerEvents !== 'none',
      viewerClip: getComputedStyle(c).overflow, wrapClip: getComputedStyle(c.parentElement).overflow,
      sideBackgrounds: ['leftSide', 'rightSide'].map(id => getComputedStyle(document.getElementById(id)).backgroundColor),
      probe: { left: Math.floor(cr.left - 14), right: Math.ceil(cr.right + 4), y: Math.floor(Math.max(cr.top + 50, paper.top + 120)) },
      outsideHit: document.elementFromPoint(cr.left - 12, Math.max(cr.top + 50, paper.top + 120))?.closest('.viewer, .paper-shadow-layer')?.className || '' };
  });
  const aligned = g => g.shadows.length > 0 && g.shadows.every(s => ['dx', 'dy', 'dw', 'dh'].every(key => Math.abs(s[key]) <= 1));
  for (const theme of ['glass', 'light', 'dark']) {
    await page.$eval('#uiTheme', (control, value) => { control.value = value; control.dispatchEvent(new Event('input', { bubbles: true })); }, theme);
    await page.evaluate(() => { window.__viewer.fitWidth(); window.__viewer.container.scrollTop = 0; });
    await wait(300); await frames();
    const g = await geometry();
    check(`${theme}: visible shadow rectangles match paper geometry`, aligned(g) && g.layers === 1, g.shadows);
    check(`${theme}: narrow gutters remain and only depth escapes the scroller`, g.gutter >= 9 && g.gutter <= 11
      && g.travel <= 1 && g.documentOverflow <= 1 && g.viewerClip === 'auto' && g.wrapClip === 'visible'
      && !g.layerInteractive && !g.outsideHit, g);
    check(`${theme}: sidebars share the background`, g.sideBackgrounds.every(color => color === 'rgba(0, 0, 0, 0)'), g.sideBackgrounds);
    const withShadow = await page.screenshot({ path: path.join(scratch, `reader-depth-${theme}.png`) });
    await page.$eval('.paper-shadow-layer', layer => { layer.style.visibility = 'hidden'; });
    const withoutShadow = await page.screenshot();
    await page.$eval('.paper-shadow-layer', layer => { layer.style.visibility = ''; });
    const difference = await page.evaluate(async ({ a, b, probe }) => {
      const pixels = async source => {
        const img = new Image(); img.src = `data:image/png;base64,${source}`; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        return { data: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width };
      };
      const [on, off] = await Promise.all([pixels(a), pixels(b)]);
      const region = x => {
        let difference = 0, count = 0;
        for (let y = probe.y; y < probe.y + 24; y++) for (let dx = 0; dx < 4; dx++) {
          const index = (y * on.width + x + dx) * 4;
          for (let c = 0; c < 3; c++) { difference += Math.abs(on.data[index + c] - off.data[index + c]); count++; }
        }
        return difference / count;
      };
      return { left: region(probe.left), right: region(probe.right) };
    }, { a: Buffer.from(withShadow).toString('base64'), b: Buffer.from(withoutShadow).toString('base64'), probe: g.probe });
    check(`${theme}: shadow pixels are visibly present beyond both viewport edges`, difference.left > .1 && difference.right > .1, difference);
  }
  await page.evaluate(() => { window.__viewer.container.scrollTop = 530; }); await frames();
  check('scroll keeps paper and its shadow together', aligned(await geometry()), (await geometry()).shadows);
  await page.evaluate(() => { const v = window.__viewer; v.previewScale(v.scale * 1.4); }); await frames();
  check('pinch preview moves shadow geometry with the paper', aligned(await geometry()), (await geometry()).shadows);
  await page.evaluate(() => window.__viewer.commitZoomPreview()); await frames();
  check('manual zoom adds no document overflow and shadows stay aligned', aligned(await geometry()) && (await geometry()).documentOverflow <= 1, await geometry());
  await page.evaluate(() => { window.__viewer.setTwoUp(true); window.__viewer.container.scrollTop = 0; }); await wait(250); await frames();
  const spread = await geometry();
  check('two-page view has independently aligned paper shadows', aligned(spread) && spread.shadows.some(s => s.page === 1)
    && spread.shadows.some(s => s.page === 2) && spread.travel <= 1, spread);
  await page.screenshot({ path: path.join(scratch, 'reader-depth-two-up.png') });
  await page.evaluate(() => { window.__viewer.setTwoUp(false); document.querySelector('#topbarRightToggle').click(); }); await wait(400); await frames();
  check('sidebar collapse preserves shadow geometry', aligned(await geometry()), await geometry());
  await page.evaluate(() => { document.querySelector('#topbarRightToggle').click(); }); await wait(400); await frames();
  check('sidebar restore preserves shadow geometry', aligned(await geometry()), await geometry());
  const divider = await page.$eval('#splitRight', el => ({ idle: getComputedStyle(el, '::after').opacity,
    handle: getComputedStyle(el, '::before').opacity, width: el.getBoundingClientRect().width }));
  await page.hover('#splitRight'); await wait(220);
  const hover = await page.$eval('#splitRight', el => getComputedStyle(el, '::before').opacity);
  check('divider is quiet at rest and reveals a usable grip on hover', Number(divider.idle) > 0 && Number(divider.handle) === 0
    && divider.width >= 8 && Number(hover) >= .65, { divider, hover });
  await page.evaluate(() => window.__viewer.close()); await frames();
  check('closing a document removes its old shadow geometry', await page.$$eval('.paper-shadow', nodes => nodes.length) === 0);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktop ? 'desktop' : 'node', checks, errors }, null, 2), 'utf8');
  console.log(`reader-depth: ${checks.length}/${checks.length}; ${scratch}`);
} finally { await browser?.close(); if (reader) await stopChild(reader); }
