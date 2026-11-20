/** Isolated regression: narrow fit gutters, sidebar resizing, balanced pan and compact footer. */
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
const checks = [];
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
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.agent.welcome.v1', 'acknowledged'));
  const toolbarAction = async (trigger, item) => { await page.click(trigger); await page.click(item); };
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) errors.push(`${r.url()} ${r.failure()?.errorText}`); });
  await page.goto(`${base}/?open=layout.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0);
  await wait(500);
  const geometry = () => page.evaluate(() => {
    const v = window.__viewer, c = v.container, p = v.pageEls[1];
    const cr = c.getBoundingClientRect(), pr = p.getBoundingClientRect();
    const contentLeft = cr.left + c.clientLeft;
    return { scale: v.scale, fitMode: v._fitMode, left: c.scrollLeft, max: c.scrollWidth - c.clientWidth,
      centerError: pr.left + pr.width / 2 - (cr.left + c.clientLeft + c.clientWidth / 2),
      width: c.clientWidth, pageWidth: p.offsetWidth, edgeLeft: pr.left - contentLeft,
      edgeRight: contentLeft + c.clientWidth - pr.right,
      footerGap: cr.top - document.querySelector('#viewerFoot').getBoundingClientRect().bottom,
      layers: [...p.children].map(el => ({ cls: el.className, w: el.getBoundingClientRect().width, left: el.offsetLeft,
        tf: getComputedStyle(el).transform })).filter(el => el.w > p.offsetWidth + 1) };
  });
  const check = (label, ok, detail) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(detail)}`);
    if (!probeOnly) assert.ok(ok, label);
  };
  const fitsWithGutter = g => g.fitMode && g.edgeLeft >= 7 && g.edgeLeft <= 11
    && g.edgeRight >= 7 && g.edgeRight <= 11 && Math.abs(g.edgeLeft - g.edgeRight) <= 1
    && g.max <= 1 && g.width - g.pageWidth >= 16 && g.width - g.pageWidth <= 21;
  for (const width of [1500, 1051]) {
    await page.setViewport({ width, height: 950 });
    await wait(250);
    await toolbarAction('#readerZoom', '#footFitWidth');
    await wait(500);
    const fit = await geometry();
    check(`fit leaves narrow balanced paper gutters at ${width}px`, fitsWithGutter(fit), fit);
    check('reading canvas meets its toolbar without an empty strip', Math.abs(fit.footerGap) <= 1, fit.footerGap);
    await page.screenshot({ path: path.join(scratch, `fit-width-${width}.png`) });
    await page.evaluate(() => window.__viewer.setScale(window.__viewer.scale * 1.7));
    const zoom = await geometry();
    check('zoom from center gives equal left/right travel immediately', zoom.max > 20 && Math.abs(zoom.left * 2 - zoom.max) <= 2, zoom);
    await wait(550);
    const settled = await geometry();
    check('rendering does not add blank horizontal travel', Math.abs(settled.max - Math.max(0, settled.pageWidth - settled.width)) <= 2
      && Math.abs(settled.left * 2 - settled.max) <= 2, settled);
    await page.screenshot({ path: path.join(scratch, `zoom-${width}.png`) });
    await page.evaluate(() => { window.__viewer.container.scrollLeft = 99999; });
    await toolbarAction('#readerZoom', '#footFitWidth');
    const reset = await geometry();
    check('fit clears previous pan immediately and restores narrow gutters', fitsWithGutter(reset) && reset.left === 0, reset);
    await wait(550);
    const rendered = await geometry();
    check('fit keeps narrow gutters after repaint', fitsWithGutter(rendered), rendered);
    await page.evaluate(() => {
      const range = document.querySelector('#zoomRange');
      range.value = String(Math.round(window.__viewer.scale * 180));
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const slider = await geometry();
    check('slider zoom also centers its horizontal travel', slider.max > 20 && Math.abs(slider.left * 2 - slider.max) <= 2, slider);
    await toolbarAction('#readerZoom', '#footFitWidth');
  }
  await page.setViewport({ width: 1500, height: 950 });
  await wait(250);
  await toolbarAction('#readerZoom', '#footFitWidth');
  await wait(500);
  for (const [side, button] of [['right', '#topbarRightToggle'], ['left', '#topbarLeftToggle']]) {
    const initiallyClosed = await page.evaluate(side => document.body.classList.contains(`no-${side}`), side);
    for (let step = 0; step < 2; step++) {
      await page.click(button);
      await wait(550);
      const closed = await page.evaluate(side => document.body.classList.contains(`no-${side}`), side);
      check(`${side} sidebar visibility changes`, closed === (step === 0 ? !initiallyClosed : initiallyClosed), { closed, initiallyClosed, step });
      const resized = await geometry();
      check(`fit keeps narrow gutters with ${side} sidebar ${closed ? 'closed' : 'open'}`, fitsWithGutter(resized), resized);
      await page.screenshot({ path: path.join(scratch, `fit-width-${side}-${closed ? 'closed' : 'open'}.png`) });
    }
    await page.evaluate(() => window.__viewer.setScale(window.__viewer.scale * 1.6));
    const manual = await geometry();
    for (let step = 0; step < 2; step++) {
      await page.click(button);
      await wait(550);
      const resized = await geometry();
      check(`${side} sidebar toggle preserves manual zoom ${step + 1}`, !resized.fitMode && Math.abs(resized.scale - manual.scale) < 1e-8, resized);
    }
    await page.evaluate(() => { window.__viewer.container.scrollLeft = 99999; });
    await toolbarAction('#readerZoom', '#footFitWidth');
    await wait(550);
    const restored = await geometry();
    check(`fit clears pan after ${side} sidebar manual-zoom changes`, fitsWithGutter(restored) && restored.left === 0, restored);
  }
  // Exercise an odd PDF viewport outside the responsive sidebars' 420px floor.
  await page.setViewport({ width: 1500, height: 950 });
  await wait(250);
  await toolbarAction('#readerZoom', '#footFitWidth');
  await toolbarAction('#readerMore', '#footTwoUp');
  await wait(300);
  const spread = await page.evaluate(() => {
    const v = window.__viewer, c = v.container, a = v.pageEls[1].getBoundingClientRect(), b = v.pageEls[2].getBoundingClientRect();
    const contentLeft = c.getBoundingClientRect().left + c.clientLeft;
    return { width: c.clientWidth, sameRow: Math.abs(a.top - b.top) <= 1, max: c.scrollWidth - c.clientWidth,
      unused: c.clientWidth - (b.right - a.left), edgeLeft: a.left - contentLeft,
      edgeRight: contentLeft + c.clientWidth - b.right,
      center: (a.left + b.right) / 2 - (contentLeft + c.clientWidth / 2) };
  });
  check('two-page fit leaves narrow gutters without wrapping at odd widths', spread.width % 2 === 1 && spread.sameRow && spread.max <= 1
    && Math.abs(spread.center) <= 1 && spread.unused >= 16 && spread.unused <= 22
    && spread.edgeLeft >= 8 && spread.edgeLeft <= 11 && spread.edgeRight >= 8 && spread.edgeRight <= 11, spread);
  await page.screenshot({ path: path.join(scratch, 'fit-width-two-page.png') });
  await toolbarAction('#readerMore', '#footTwoUp');
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
  for (const theme of ['glass', 'light', 'dark']) {
    await page.$eval('#uiTheme', (control, value) => { control.value = value; control.dispatchEvent(new Event('input', { bubbles: true })); }, theme);
    for (const width of [1920, 740, 320]) {
      await page.setViewport({ width, height: 950 }); await wait(250);
      if (width === 320) {
        // On phone-width desktop windows the open side panel owns the width.
        // Close it through the normal controls before measuring the PDF surface.
        await page.evaluate(() => {
          if (!document.body.classList.contains('no-right')) document.querySelector('#topbarRightToggle').click();
          if (!document.body.classList.contains('no-left')) document.querySelector('#topbarLeftToggle').click();
        });
        await wait(250);
      }
      await page.evaluate(() => window.__viewer.fitWidth()); await wait(250);
      const fit = await geometry();
      check(`${theme} at ${width}px retains small symmetric gutters and no horizontal overflow`, fitsWithGutter(fit), fit);
      if (fit.width < 360) check('narrow reader uses an 8px gutter', Math.abs(fit.edgeLeft - 8) <= 1 && Math.abs(fit.edgeRight - 8) <= 1, fit);
      else check('normal reader uses a 10px gutter', Math.abs(fit.edgeLeft - 10) <= 1 && Math.abs(fit.edgeRight - 10) <= 1, fit);
      if (width !== 740) await page.screenshot({ path: path.join(scratch, `paper-gutters-${theme}-${width}.png`) });
    }
  }
  await page.$eval('#uiTheme', control => { control.value = 'glass'; control.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.setViewport({ width: 1500, height: 950 }); await wait(300);
  await page.evaluate(() => window.__ctx.resetPanels()); await wait(300);
  await page.evaluate(() => { window.__viewer.fitWidth(); window.__viewer.paintSelection({ 1: [{ x: .2, y: .2, w: .3, h: .04 }] }); });
  await page.waitForFunction(() => window.__viewer.rendered.get(1)?.hlLayer?.querySelector('.sel-mark'));
  const annotation = () => page.evaluate(() => {
    const v = window.__viewer, paper = v.pageEls[1].getBoundingClientRect();
    const mark = v.rendered.get(1).hlLayer.querySelector('.sel-mark').getBoundingClientRect();
    return { dx: mark.left - paper.left - paper.width * .2, dy: mark.top - paper.top - paper.height * .2,
      dw: mark.width - paper.width * .3, dh: mark.height - paper.height * .04 };
  });
  let mark = await annotation();
  check('fit gutters preserve normalized selection overlay coordinates', Object.values(mark).every(n => Math.abs(n) <= 1.5), mark);
  await page.evaluate(() => { const v = window.__viewer; v.setScale(v.scale * 1.6); v.fitWidth(); }); await wait(500);
  mark = await annotation();
  check('selection overlay remains aligned after zoom and fit restore', Object.values(mark).every(n => Math.abs(n) <= 1.5), mark);
  await page.evaluate(() => window.__viewer.paintSelection(null));
  await page.evaluate(() => window.__viewer.goToPage(3)); await wait(400);
  const anchor = await page.evaluate(() => window.__viewer._captureAnchor());
  const restoredAnchor = await page.evaluate(() => { const v = window.__viewer; v.setScale(v.scale * 1.4); v.fitWidth(); return v._captureAnchor(); });
  check('zoom and fit restore preserve the vertical reading anchor', anchor.page === restoredAnchor.page
    && Math.abs(anchor.frac - restoredAnchor.frac) < .003, { anchor, restoredAnchor });
  await page.click('#pageInput'); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.type('3'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__viewer.current === 3);
  await page.evaluate(() => window.__ctx.setPanelVisible('translate', true));
  await page.waitForSelector('.aibar-btn[data-block="translate"]', { visible: true });
  await page.locator('.aibar-btn[data-block="translate"]').click();
  await page.evaluate(() => { const side = document.querySelector('#rightSide'); side.style.width = side.style.minWidth = side.style.maxWidth = '300px'; });
  await page.focus('#translateTargetLang'); await page.keyboard.press('End'); await page.keyboard.press('Tab');
  assert.equal(await page.$eval('#translateTargetLang', el => el.value), 'English');
  assert.equal(await page.evaluate(() => window.__viewer.current), 3, 'select keyboard navigation must not turn PDF pages');
  const targetLayout = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const box = rect('.translation-view-controls'), target = rect('.translate-target-control'), modes = rect('.translation-view-mode');
    return { inside: target.width > 0 && target.left >= box.left && target.right <= box.right && target.bottom <= box.bottom,
      separated: target.right <= modes.left || modes.right <= target.left || target.bottom <= modes.top || modes.bottom <= target.top,
      overflow: document.querySelector('#rightSide').scrollWidth - document.querySelector('#rightSide').clientWidth };
  });
  check('language and comparison controls fit the translation panel at 300px', targetLayout.inside && targetLayout.separated && targetLayout.overflow <= 1, targetLayout);
  await page.screenshot({ path: path.join(scratch, 'translation-language.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.numPages > 0 && window.__state?.viewerDocId === window.__state?.doc?.docId
    && window.__viewer.rendered.get(window.__viewer.current)?.textDiv?.childElementCount > 0);
  await page.locator('.aibar-btn[data-block="translate"]').click();
  assert.equal(await page.$eval('#translateTargetLang', el => el.value), 'English', 'language selection survives reload');
  await page.locator('.aibar-btn[data-block="chat"]').click();
  assert.equal(await page.$eval('.translate-target-control', el => el.getClientRects().length), 0, 'chat mode hides the translation-only control');
  await page.screenshot({ path: path.join(scratch, 'reader-layout.png') });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktop ? 'desktop' : 'node', checks, errors }, null, 2), 'utf8');
  console.log(`reader-layout: ${checks.filter(row => row.ok).length}/${checks.length} passed`);
  console.log(`Artifacts: ${scratch}`);
} finally {
  await browser?.close();
  if (reader) await stopChild(reader);
}
