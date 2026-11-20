/** Slide presentation and book regression, using only synthetic isolated PDFs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'immersive-slides-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
function fixture(width, height, rotation = 0) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 3 /Kids [4 0 R 6 0 R 8 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < 3; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotation} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = `0.92 0.95 1 rg 0 0 ${width} ${height} re f\n0.1 0.2 0.4 rg BT /F1 28 Tf 40 ${height - 70} Td (Slide ${i + 1}) Tj ET\n`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
for (const [name, w, h, r] of [['Wide', 960, 540, 0], ['Classic', 720, 540, 0], ['Rotated', 540, 960, 90], ['Portrait', 540, 720, 0]]) {
  fs.writeFileSync(path.join(papers, `${name}.pdf`), fixture(w, h, r));
}
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = process.argv.includes('--desktop') ? spawnReader(stageExe('immersive-slides').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const asset of ['js/pdfview.js', 'js/immersive-reading.js', 'immersive-reading.css']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 960 } });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    Element.prototype.requestFullscreen = () => Promise.resolve();
    document.exitFullscreen = () => Promise.resolve();
  });
  const settled = () => page.waitForFunction(() => __viewer.immersive && !__viewer._immersiveNavigation && document.getElementById('immersiveTransitionCover').hidden);
  const state = () => page.evaluate(() => {
    const v = __viewer, box = v.container.getBoundingClientRect();
    const pages = v.pageEls.filter(n => n && getComputedStyle(n).display !== 'none');
    const top = document.getElementById('immersiveTopbar'), bottom = document.getElementById('immersiveFooter');
    return { current: v.current, presentation: v.immersivePresentation, visible: pages.map(n => +n.dataset.page),
      fits: pages.every(n => { const r = n.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right + 1 && r.top >= box.top && r.bottom <= box.bottom + 1; }),
      clearOfBars: box.top >= top.getBoundingClientRect().bottom && box.bottom <= bottom.getBoundingClientRect().top,
      barsVisible: [top, bottom].every(n => getComputedStyle(n).opacity === '1' && getComputedStyle(n).pointerEvents === 'auto'),
      previousDisabled: document.getElementById('immersivePrev').disabled, nextDisabled: document.getElementById('immersiveNext').disabled,
      blankLeaf: v.pagesEl.classList.contains('immersive-last-single') };
  });
  for (const name of ['Wide', 'Classic', 'Rotated', 'Portrait']) {
    await page.goto(`${base}/?open=${name}.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
    await page.evaluate(async () => { __viewer.setTwoUp(true); await __viewer.goToPage(2); });
    const original = await page.evaluate(() => ({ scale: __viewer.scale, twoUp: __viewer._twoUp }));
    // Switching documents and two-up mode can still move the toolbar; invoke
    // its real handler without racing the ordinary reader's layout animation.
    await page.$eval('#immersiveBtn', button => button.click());
    await settled().catch(async error => {
      console.error(name, errors, await page.evaluate(() => ({ active: __ctx.immersiveReading.active, immersive: __viewer.immersive,
        classes: document.body.className, cover: document.getElementById('immersiveTransitionCover').hidden })));
      await page.screenshot({ path: path.join(scratch, 'failure.png') }); throw error;
    });
    const s = await state();
    assert.equal(s.presentation, name !== 'Portrait');
    assert.deepEqual(s.visible, name === 'Portrait' ? [1, 2] : [2]);
    assert.ok(s.fits);
    if (name !== 'Portrait') {
      assert.ok(s.clearOfBars && s.barsVisible); assert.equal(s.previousDisabled, false); assert.equal(s.nextDisabled, false);
      await page.mouse.move(750, 480);
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.ok((await state()).barsVisible, 'bars remain visible after idle');
      await page.keyboard.press('ArrowDown'); await settled();
      assert.equal((await state()).current, 3); assert.ok((await state()).nextDisabled); assert.equal((await state()).blankLeaf, false);
      await page.keyboard.press('Home'); await settled(); assert.equal((await state()).current, 1); assert.ok((await state()).previousDisabled);
      await page.click('#immersiveNext'); await settled(); assert.equal((await state()).current, 2);
      await page.evaluate(() => document.getElementById('viewer').focus());
      await page.keyboard.down('Shift'); await page.keyboard.press('Space'); await page.keyboard.up('Shift');
      await settled(); assert.equal((await state()).current, 1);
      await page.mouse.move(750, 480); await page.mouse.wheel({ deltaY: 100 });
      await page.waitForFunction(() => __viewer.current === 2); await settled();
      await page.keyboard.press('End'); await settled(); assert.equal((await state()).current, 3);
      await page.click('#immersivePrev'); await settled(); assert.equal((await state()).current, 2);
      await page.evaluate(() => Promise.all([__viewer.stepPage(-1), __viewer.stepPage(1), __viewer.stepPage(1)]));
      assert.deepEqual((await state()).visible, [3]);
      await page.$eval('#immersivePage', n => { n.value = '2'; n.dispatchEvent(new Event('change')); }); await settled();
      assert.deepEqual((await state()).visible, [2]);
      const failure = await page.evaluate(async () => {
        const v = __viewer, render = v._renderPage;
        v._renderPage = async () => { throw new Error('synthetic render failure'); };
        try { await v.stepPage(1); } catch (e) { return e.message; } finally { v._renderPage = render; }
      });
      assert.equal(failure, 'synthetic render failure'); assert.deepEqual((await state()).visible, [2]);
      assert.equal(await page.$$eval('.immersive-page-turn,.immersive-turn-snapshot', nodes => nodes.length), 0);
      await page.screenshot({ path: path.join(scratch, `${name}.png`) });
      await page.setViewport({ width: 560, height: 820 });
      await page.waitForFunction(() => { const v = __viewer, r = v.pageEls[v.current].getBoundingClientRect(); return r.width <= v.container.clientWidth; });
      assert.ok((await state()).fits && (await state()).clearOfBars);
      await page.setViewport({ width: 1500, height: 960 });
    }
    await page.evaluate(() => __ctx.immersiveReading.setActive(false));
    assert.deepEqual(await page.evaluate(() => ({ scale: __viewer.scale, twoUp: __viewer._twoUp })), original);
    assert.equal(await page.evaluate(() => document.body.classList.contains('immersive-presentation')), false);
    console.log(`PASS ${name}: geometry, navigation, chrome, resize and restoration`);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS slide presentation; ${scratch}`);
} finally { await browser?.close(); await stopChild(reader); }
