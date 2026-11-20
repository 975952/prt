/** Global background brightness through real controls; isolated files and no model calls. */
import { clickReaderTool } from './_reader-controls.mjs';
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `global-brightness-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
// Explicit white fills catch a PDF canvas that fails to follow its dark paper.
const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Count 4 /Kids [4 0 R 5 0 R 6 0 R 7 0 R] >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
for (let n = 0; n < 4; n++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 640] /Resources << /Font << /F1 3 0 R >> >> /Contents ${8 + n} 0 R >>`);
for (let n = 0; n < 4; n++) {
  const content = `1 g 0 0 480 640 re f\n0 g BT /F1 18 Tf 36 580 Td (Global brightness synthetic page ${n + 1}) Tj 0 -32 Td (Readable text follows the night palette.) Tj 0 -32 Td (An explicit white page fill must turn black.) Tj ET\n`;
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
}
const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
objects.forEach((object, i) => { offsets.push(length); const chunk = Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`); chunks.push(chunk); length += chunk.length; });
chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
fs.writeFileSync(path.join(papers, 'Brightness.pdf'), Buffer.concat(chunks));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser, page;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('global-brightness').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready);
  for (const asset of ['js/app.js', 'js/pdfview.js', 'js/pdf-reading-theme.js', 'style.css', 'agent-workspace.css', 'immersive-viewer.css']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 960 } });
  page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    Element.prototype.requestFullscreen = () => Promise.resolve();
    document.exitFullscreen = () => Promise.resolve();
  });
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && __state.papers.length === 1);
  const set = (id, value) => page.$eval(`#${id}`, (node, next) => {
    node.value = next; node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  const pixel = async (selector, corner = 'bottom') => {
    const point = await page.$eval(selector, (node, corner) => {
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.right - 24), y: Math.round(corner === 'top' ? r.top + 24 : r.bottom - 24) };
    }, corner);
    const png = await page.screenshot({ encoding: 'base64' });
    return page.evaluate(async ({ png, point }) => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(point.x, point.y, 1, 1).data].slice(0, 3);
    }, { png, point });
  };
  await page.click('#settingsBtn'); await page.click('#settingsNavAppearance');
  assert.deepEqual(await page.$eval('#uiGlassBrightness', node => [node.min, node.max]), ['0', '100']);
  await set('uiTheme', 'dark'); await set('uiGlassBrightness', '0');
  assert.equal(await page.$eval('#uiGlassBrightnessValue', node => node.textContent.trim()), '0%');
  assert.equal(await page.$eval('#uiGlassBrightness', node => node.closest('label').textContent.includes('92')), false);
  await page.click('#closeSettings');
  assert.deepEqual(await pixel('.home-content'), [0, 0, 0], 'Library reaches pure black');
  assert.equal(await page.$eval('body', node => getComputedStyle(node).backgroundImage), 'linear-gradient(145deg, rgb(0, 0, 0), rgb(0, 0, 0))');
  await set('uiGlassBrightness', '100');
  const brightLibrary = await pixel('.home-content');
  assert.ok(brightLibrary.every(v => v > 0 && v < 70), 'Library brightness affects its actual surface');
  await page.click('#homeAgent'); await page.waitForFunction(() => document.body.classList.contains('agent-full') && !document.body.classList.contains('agent-transitioning'));
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  assert.deepEqual(await pixel('#rightSide', 'top'), brightLibrary, 'Alina and Library share the same brightness');
  await set('uiGlassBrightness', '0');
  assert.deepEqual(await pixel('#rightSide', 'top'), [0, 0, 0], 'Alina reaches pure black immediately');
  await page.screenshot({ path: path.join(scratch, 'alina-pure-black.png') });
  console.log('PASS normalized brightness control applies immediately to Library and Alina, including pure black');

  await page.goto(base + '/?open=Brightness.pdf&topbar=static', { waitUntil: 'domcontentloaded' });
  const renderedPaper = expected => page.waitForFunction(expected => {
    const v = window.__viewer, entry = v?.rendered.get(v.current);
    return entry?.paper === expected && entry.textDiv?.childElementCount > 0 && !v.renderTasks.size;
  }, {}, expected);
  await renderedPaper('#000000');
  const blankPixel = () => page.evaluate(() => {
    const canvas = __viewer.rendered.get(__viewer.current).canvas;
    return [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data];
  });
  assert.deepEqual(await blankPixel(), [0, 0, 0, 255], 'explicit white PDF fill becomes pure black');
  assert.deepEqual(await pixel('#viewer', 'top'), [0, 0, 0], 'normal reader background is pure black');
  const inkColor = await page.$eval('#rightSide', node => getComputedStyle(node).color);
  await set('uiGlassBrightness', '100'); await renderedPaper('#222426');
  assert.deepEqual(await blankPixel(), [34, 36, 38, 255], 'normal PDF canvas follows background brightness');
  assert.equal(await page.$eval('#rightSide', node => getComputedStyle(node).color), inkColor, 'background brightness does not dim text');
  await set('uiGlassBrightness', '0'); await renderedPaper('#000000');
  await clickReaderTool(page, '#immersiveBtn'); await page.waitForFunction(() => __viewer.immersive);
  await renderedPaper('#000000');
  assert.equal(await page.$eval('#viewer', node => getComputedStyle(node).backgroundColor), 'rgb(0, 0, 0)');
  assert.deepEqual(await blankPixel(), [0, 0, 0, 255], 'book canvas is pure black');
  await page.evaluate(() => { void __viewer.stepPage(1); });
  await page.waitForFunction(() => {
    const stage = document.querySelector('.immersive-page-turn');
    return stage && getComputedStyle(stage).visibility === 'visible';
  });
  assert.ok(await page.$$eval('.immersive-flip-page', nodes => nodes.length === 4 && nodes.every(node => getComputedStyle(node).backgroundColor === 'rgb(0, 0, 0)')), 'turning page fronts and backs stay pure black');
  await page.screenshot({ path: path.join(scratch, 'book-pure-black-turn.png') });
  await page.evaluate(() => __viewer._immersiveNavigation);
  await set('uiGlassBrightness', '100'); await renderedPaper('#222426');
  assert.equal(await page.$eval('#viewer', node => getComputedStyle(node).backgroundColor), 'rgb(34, 36, 38)');
  assert.deepEqual(await blankPixel(), [34, 36, 38, 255]);
  console.log('PASS normal and book PDF canvas, background and animated fronts/backs follow the same brightness');

  await set('uiGlassBrightness', '40'); await renderedPaper('#0e0e0f');
  await page.reload({ waitUntil: 'domcontentloaded' }); await renderedPaper('#0e0e0f');
  await page.waitForFunction(() => !document.querySelector('#startupStatus'));
  await page.locator('#settingsBtn').click(); await page.locator('#settingsNavAppearance').click();
  assert.equal(await page.$eval('#uiGlassBrightness', node => node.value), '40');
  assert.equal(await page.$eval('#uiGlassBrightnessValue', node => node.textContent.trim()), '40%');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style.appearanceVersion), 4);
  await page.click('#closeSettings');
  await set('uiTheme', 'light');
  await page.waitForFunction(() => __viewer.rendered.get(__viewer.current)?.isNight === false && !__viewer.renderTasks.size);
  await set('uiGlassBrightness', '0');
  const lightLow = await pixel('#viewer', 'top');
  await set('uiGlassBrightness', '100');
  const lightHigh = await pixel('#viewer', 'top');
  assert.ok(lightLow.every(v => v > 190) && lightHigh.some((v, i) => v > lightLow[i]), 'light theme stays readable throughout the normalized range');
  await clickReaderTool(page, '#immersiveBtn'); await page.waitForFunction(() => __viewer.immersive && !__viewer.renderTasks.size);
  const bookSurface = () => page.evaluate(() => ({
    viewport: getComputedStyle(__viewer.container).backgroundColor,
    page: getComputedStyle(__viewer.pageEls[__viewer.current]).backgroundColor,
    exportPaper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
    canvas: __viewer.rendered.get(__viewer.current).canvas.toDataURL(),
  }));
  for (const theme of ['light', 'glass']) {
    await set('uiTheme', theme);
    await page.waitForFunction(() => __viewer.rendered.get(__viewer.current)?.isNight === false && !__viewer.renderTasks.size);
    await set('uiGlassBrightness', '0'); const dim = await bookSurface();
    await set('uiGlassBrightness', '100'); const bright = await bookSurface();
    assert.equal(dim.viewport, dim.page, `${theme} book has one continuous background at zero`);
    assert.equal(bright.viewport, bright.page, `${theme} book has one continuous background at full brightness`);
    assert.notEqual(dim.viewport, bright.viewport, `${theme} book background responds to global brightness`);
    assert.equal(dim.exportPaper, bright.exportPaper, `${theme} export paper remains unchanged`);
    assert.ok(dim.canvas === bright.canvas, `${theme} original PDF pixels remain unchanged`);
    assert.equal((await blankPixel())[3], 0, `${theme} white PDF background stays transparent above its reading surface`);
  }
  console.log('PASS light and glass book surfaces follow brightness while PDF pixels and export paper stay unchanged');
  await set('uiTheme', 'dark'); await set('uiGlassBrightness', '0'); await renderedPaper('#000000');
  assert.deepEqual(await blankPixel(), [0, 0, 0, 255], 'switching themes applies the current background immediately');
  assert.deepEqual(errors, []);
  console.log(`PASS saved brightness survives reload and theme changes; ${scratch}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Artifacts: ${scratch}`); throw error;
} finally { await browser?.close(); await stopChild(reader); }
