/** Isolated checks of floating PDF pages and two optical card materials. */
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
  for (const file of ['js/app.js', 'js/glass-material.js', 'js/pdfview.js', 'style.css']) assert.equal(await fetch(`${base}/${file}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, defaultViewport: { width: 1440, height: 960 } });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  await page.goto(`${base}/?open=sample.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0 && !window.__viewer.renderTasks.size);
  await page.evaluate(() => document.fonts.ready); await wait(400);
  const set = (id, value) => page.$eval(`#${id}`, (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const mode = value => page.select('#uiGlassCardMode', value);
  const snapshot = () => page.evaluate(() => {
    const v = window.__viewer, p = v.pageEls[1], c = v.rendered.get(1).canvas, style = getComputedStyle(p);
    return { bg: getComputedStyle(document.documentElement).getPropertyValue('--glass-bg').trim(), canvas: c.toDataURL(),
      scroll: v.container.scrollTop, scale: v.scale, shadow: style.boxShadow, highlight: getComputedStyle(p, '::before').opacity,
      sideRadii: [...document.querySelectorAll('.main-row .side')].map(n => getComputedStyle(n).borderRadius) };
  });
  const initial = await snapshot();
  assert.equal(initial.bg, 'rgb(233 233 233)'); assert(initial.sideRadii.every(r => r === '0px'));
  assert.equal(await page.$eval('#uiGlassBrightness', n => n.min), '92');
  await set('uiGlassBrightness', 60);
  assert.equal((await snapshot()).bg, 'rgb(233 233 233)');
  assert.equal(await page.$eval('#uiGlassBrightness', n => n.value), '92');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style.glassBrightness), 92);
  assert.equal((await snapshot()).canvas, initial.canvas);
  await set('uiGlassBrightness', 100);
  await page.evaluate(() => document.activeElement?.blur()); await wait(250);
  const inputSurface = () => page.$eval('#composer .composer-row', n => {
    const s = getComputedStyle(n), r = n.getBoundingClientRect();
    return { shadow: s.boxShadow, background: s.backgroundImage, width: r.width, height: r.height };
  });
  const restingInput = await inputSurface();
  await page.screenshot({ path: path.join(scratch, 'composer-resting.png') });
  await page.focus('#chatInput'); await wait(250);
  const focusedInput = await inputSurface();
  assert.notEqual(restingInput.shadow, 'none'); assert.notEqual(focusedInput.shadow, restingInput.shadow);
  assert(restingInput.shadow.includes('26px')); assert(focusedInput.shadow.includes('32px'));
  assert.notEqual(focusedInput.background, restingInput.background);
  assert.equal(focusedInput.width, restingInput.width); assert.equal(focusedInput.height, restingInput.height);
  assert.equal(await page.$eval('#chatInput', n => getComputedStyle(n).outlineStyle), 'none');
  await page.screenshot({ path: path.join(scratch, 'composer-focused.png') });
  console.log('PASS brighter 92–100% range and visible input surface lighting without focus outlines or layout shift');
  await set('uiGlassTone', 0); assert.equal((await snapshot()).bg, 'rgb(253 253 253)');
  await set('uiGlassTone', 100); assert.equal((await snapshot()).bg, 'rgb(255 244 224)');
  await set('uiGlassTone', 20);
  await set('uiGlassShadow', 0); await set('uiGlassCrystal', 0); const low = await snapshot();
  await page.screenshot({ path: path.join(scratch, 'paper-flat.png') });
  await set('uiGlassShadow', 100); await set('uiGlassCrystal', 100); const high = await snapshot();
  await page.screenshot({ path: path.join(scratch, 'paper-floating.png') });
  assert.notEqual(low.shadow, high.shadow); assert.equal(low.highlight, '0'); assert.equal(high.highlight, '1');
  assert(!high.shadow.includes('inset'), 'paper elevation is external');
  assert.equal(initial.canvas, high.canvas); assert.equal(initial.scroll, high.scroll); assert.equal(initial.scale, high.scale);
  console.log('PASS background tone, elevation/highlight, flat sidebars and unchanged PDF pixels/position');
  await set('uiGlassShadow', 76); await set('uiGlassCrystal', 70);
  await page.evaluate(() => {
    const card = document.querySelector('#translationCard'), p = document.querySelector('.page').getBoundingClientRect();
    card.classList.remove('hidden'); card.style.left = `${p.left + Math.min(180, p.width / 4)}px`; card.style.top = '260px';
    document.querySelector('#translationCardQuote').textContent = 'The encoder maps an input sequence to continuous representations.';
    document.querySelector('#translationCardText').textContent = '编码器将输入序列映射为连续表示，解码器利用这些表示逐步生成输出。';
  });
  await page.waitForFunction(() => document.querySelector('#prt-translation-refraction feImage')?.getAttribute('href')?.startsWith('data:image/png'));
  const optical = await page.evaluate(async () => {
    const node = document.querySelector('#prt-translation-refraction feImage'), im = new Image(); im.src = node.getAttribute('href'); await im.decode();
    const canvas = document.createElement('canvas'); canvas.width = im.width; canvas.height = im.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(im, 0, 0);
    return { center: [...ctx.getImageData(Math.floor(im.width / 2), Math.floor(im.height / 2), 1, 1).data],
      edge: [...ctx.getImageData(1, Math.floor(im.height / 2), 1, 1).data], max: Math.max(im.width, im.height) };
  });
  assert.deepEqual(optical.center, [128, 128, 128, 255]); assert.notDeepEqual(optical.edge, optical.center); assert(optical.max <= 512);
  await page.screenshot({ path: path.join(scratch, 'card-liquid.png') });
  await set('uiGlassCardTransparency', 72); await set('uiGlassCardBlur', 2.4); await set('uiGlassCardRefraction', 90);
  assert.equal(await page.$eval('#prt-translation-refraction feDisplacementMap', n => n.getAttribute('scale')), '36');
  await mode('frosted');
  assert.equal(await page.$eval('#uiGlassCardTransparency', n => n.value), '71'); assert.equal(await page.$eval('#uiGlassCardBlur', n => n.value), '9.4');
  assert(await page.$eval('#glassCardRefractionField', n => n.classList.contains('hidden')));
  assert.equal(await page.$eval('.translation-material', n => getComputedStyle(n).backdropFilter), 'blur(9.4px) saturate(0.85)');
  await page.screenshot({ path: path.join(scratch, 'card-frosted.png') });
  await set('uiGlassCardTransparency', 68); await set('uiGlassCardBlur', 19);
  await mode('liquid');
  assert.equal(await page.$eval('#uiGlassCardTransparency', n => n.value), '72'); assert.equal(await page.$eval('#uiGlassCardBlur', n => n.value), '2.4');
  await mode('frosted'); assert.equal(await page.$eval('#uiGlassCardTransparency', n => n.value), '68');
  const grip = await page.$('#translationCardResize'), rect = await grip.boundingBox();
  await page.mouse.move(rect.x + 10, rect.y + 10); await page.mouse.down(); await page.mouse.move(rect.x + 100, rect.y + 90, { steps: 5 }); await page.mouse.up();
  await mode('liquid'); await wait(150);
  assert(await page.evaluate(() => Number(document.querySelector('#prt-translation-refraction').getAttribute('width')) === document.querySelector('#translationCard').clientWidth));
  assert.equal(await page.$$eval('#prt-translation-refraction', n => n.length), 1);
  console.log('PASS bounded edge-only refraction, per-material memory and live resize');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0);
  await page.click('#settingsBtn'); await page.click('#settingsNavAppearance');
  assert.equal(await page.$eval('#uiGlassCardMode', n => n.value), 'liquid');
  assert.equal(await page.$eval('#uiGlassCardTransparency', n => n.value), '72');
  await mode('frosted'); assert.equal(await page.$eval('#uiGlassCardBlur', n => n.value), '19');
  await page.waitForSelector('#uiGlassCardTransparency', { visible: true });
  await page.focus('#uiGlassCardTransparency'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('#uiGlassCardTransparency', n => n.value), '16');
  await page.click('#resetAppearanceEffects');
  assert.equal(await page.$eval('#uiGlassCardTransparency', n => n.value), '71');
  assert.equal(await page.$eval('#uiGlassShadow', n => n.value), '100'); assert.equal(await page.$eval('#uiGlassCrystal', n => n.value), '100');
  await page.screenshot({ path: path.join(scratch, 'settings.png') });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('reader.ui'));
    saved.style.glassBrightness = 60; saved.style.appearanceVersion = 3;
    localStorage.setItem('reader.ui', JSON.stringify(saved));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style.glassBrightness), 92);
  assert.equal((await snapshot()).bg, 'rgb(233 233 233)');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style.glassCardMode), 'frosted');
  console.log('PASS older dim background preferences migrate to the new minimum and retain card material');
  assert.deepEqual(errors, []);
  console.log(`PASS keyboard, reset, reload persistence and current embedded assets (${desktop ? 'desktop' : 'Node'}). Artifacts: ${scratch}`);
} finally { await browser?.close(); await stopChild(child); }
