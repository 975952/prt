/** Isolated regression: fit alignment, balanced horizontal travel and compact footer. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const probeOnly = process.argv.includes('--probe');
const desktop = process.argv.includes('--desktop');
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'reader-layout-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'layout.pdf'));
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('reader-layout').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* startup */ }
    await wait(100);
  }
  for (const asset of ['style.css', 'js/app.js', 'js/pdfview.js', 'js/selection-reading-order.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'),
      `reader serves the latest ${asset}`);
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 950 } });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) errors.push(`${r.url()} ${r.failure()?.errorText}`); });
  await page.goto(`${base}/?open=layout.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0);
  await wait(500);
  const geometry = () => page.evaluate(() => {
    const v = window.__viewer, c = v.container, p = v.pageEls[1];
    const cr = c.getBoundingClientRect(), pr = p.getBoundingClientRect();
    return { scale: v.scale, left: c.scrollLeft, max: c.scrollWidth - c.clientWidth,
      centerError: pr.left + pr.width / 2 - (cr.left + c.clientLeft + c.clientWidth / 2),
      width: c.clientWidth, pageWidth: p.offsetWidth,
      footerGap: document.querySelector('#viewerFoot').getBoundingClientRect().top - cr.bottom,
      layers: [...p.children].map(el => ({ cls: el.className, w: el.getBoundingClientRect().width, left: el.offsetLeft,
        tf: getComputedStyle(el).transform })).filter(el => el.w > p.offsetWidth + 1) };
  });
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(detail)}`);
    if (!probeOnly) assert.ok(ok, label);
  };
  for (const width of [1500, 1051]) {
    await page.setViewport({ width, height: 950 });
    await wait(250);
    await page.click('#footFitWidth');
    await wait(500);
    const fit = await geometry();
    check(`fit fills and centers paper at ${width}px`, Math.abs(fit.centerError) <= 1 && fit.max <= 1 && Math.abs(fit.width - fit.pageWidth) <= 1, fit);
    check('scrollbar meets footer without an empty strip', Math.abs(fit.footerGap) <= 1, fit.footerGap);
    await page.evaluate(() => window.__viewer.setScale(window.__viewer.scale * 1.7));
    const zoom = await geometry();
    check('zoom from center gives equal left/right travel immediately', zoom.max > 20 && Math.abs(zoom.left * 2 - zoom.max) <= 2, zoom);
    await wait(550);
    const settled = await geometry();
    check('rendering does not add blank horizontal travel', Math.abs(settled.max - Math.max(0, settled.pageWidth - settled.width)) <= 2
      && Math.abs(settled.left * 2 - settled.max) <= 2, settled);
    await page.screenshot({ path: path.join(scratch, `zoom-${width}.png`) });
    await page.evaluate(() => { window.__viewer.container.scrollLeft = 99999; });
    await page.click('#footFitWidth');
    const reset = await geometry();
    check('fit clears previous pan immediately', Math.abs(reset.centerError) <= 1 && reset.max <= 1 && reset.left === 0 && Math.abs(reset.width - reset.pageWidth) <= 1, reset);
    await wait(550);
    const rendered = await geometry();
    check('fit stays centered after repaint', Math.abs(rendered.centerError) <= 1 && rendered.max <= 1, rendered);
    await page.evaluate(() => {
      const range = document.querySelector('#zoomRange');
      range.value = String(Math.round(window.__viewer.scale * 180));
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const slider = await geometry();
    check('slider zoom also centers its horizontal travel', slider.max > 20 && Math.abs(slider.left * 2 - slider.max) <= 2, slider);
    await page.click('#footFitWidth');
  }
  await page.setViewport({ width: 1050, height: 950 });
  await wait(250);
  await page.click('#footFitWidth');
  await page.click('#footTwoUp');
  await wait(300);
  const spread = await page.evaluate(() => {
    const v = window.__viewer, c = v.container, a = v.pageEls[1].getBoundingClientRect(), b = v.pageEls[2].getBoundingClientRect();
    return { width: c.clientWidth, sameRow: Math.abs(a.top - b.top) <= 1, max: c.scrollWidth - c.clientWidth,
      unused: c.clientWidth - (b.right - a.left),
      center: (a.left + b.right) / 2 - (c.getBoundingClientRect().left + c.clientWidth / 2) };
  });
  check('two-page fit fills available width without wrapping at odd widths', spread.width % 2 === 1 && spread.sameRow && spread.max <= 1 && Math.abs(spread.center) <= 1 && Math.abs(spread.unused) <= 1, spread);
  await page.click('#footTwoUp');
  await wait(250);
  const numbers = await page.evaluate(() => {
    const v = window.__viewer, first = v.pageEls[1].getBoundingClientRect(), next = v.pageEls[2].getBoundingClientRect();
    const number = v.pageEls[1].querySelector('.page-number').getBoundingClientRect();
    const input = document.querySelector('#pageInput').getBoundingClientRect(), total = document.querySelector('#pageCount').getBoundingClientRect();
    return { pageX: number.left + number.width / 2 - first.left - first.width / 2,
      pageY: number.top + number.height / 2 - (first.bottom + next.top) / 2,
      footerY: input.top + input.height / 2 - total.top - total.height / 2 };
  });
  check('page-gap and footer page numbers align on both axes', Math.abs(numbers.pageX) <= 1 && Math.abs(numbers.pageY) <= 1 && Math.abs(numbers.footerY) <= 1, numbers);
  await page.click('#pageInput'); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.type('3'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__viewer.current === 3);
  await page.click('.aibar-btn[data-block="translate"]');
  await page.evaluate(() => { const side = document.querySelector('#rightSide'); side.style.width = side.style.minWidth = side.style.maxWidth = '300px'; });
  await page.focus('#translateTargetLang'); await page.keyboard.press('End'); await page.keyboard.press('Tab');
  assert.equal(await page.$eval('#translateTargetLang', el => el.value), 'English');
  assert.equal(await page.evaluate(() => window.__viewer.current), 3, 'select keyboard navigation must not turn PDF pages');
  const targetLayout = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const box = rect('#composer .composer-row'), target = rect('.translate-target-control'), send = rect('#sendBtn'), clip = rect('#clipBtn');
    return { inside: target.left >= box.left && target.right <= box.right && target.bottom <= box.bottom,
      baseline: target.top + target.height / 2 - send.top - send.height / 2,
      separated: target.right + 4 <= clip.left, overflow: document.querySelector('#rightSide').scrollWidth - document.querySelector('#rightSide').clientWidth,
      extraRow: getComputedStyle(document.querySelector('.composer-opts')).display };
  });
  check('translation language belongs to the composer action row at 300px', targetLayout.inside && Math.abs(targetLayout.baseline) <= 1
    && targetLayout.separated && targetLayout.overflow <= 1 && targetLayout.extraRow === 'none', targetLayout);
  await page.screenshot({ path: path.join(scratch, 'translation-language.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.numPages > 0 && window.__state?.viewerDocId === window.__state?.doc?.docId
    && window.__viewer.rendered.get(window.__viewer.current)?.textDiv?.childElementCount > 0);
  await page.locator('.aibar-btn[data-block="translate"]').click();
  assert.equal(await page.$eval('#translateTargetLang', el => el.value), 'English', 'language selection survives reload');
  await page.locator('.aibar-btn[data-block="chat"]').click();
  assert.equal(await page.$eval('.translate-target-control', el => getComputedStyle(el).display), 'none', 'chat mode hides the translation-only control');
  await page.screenshot({ path: path.join(scratch, 'reader-layout.png') });
  assert.deepEqual(errors, []);
  console.log(`Artifacts: ${scratch}`);
} finally {
  await browser?.close();
  if (reader) await stopChild(reader);
}
