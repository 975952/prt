/** Immersive spread and floating tools regression using isolated synthetic PDFs. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'immersive-reading-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'Immersive.pdf'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('immersive-reading').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready);
  for (const asset of ['js/immersive-reading.js', 'js/pdfview.js', 'js/pdf-reading-theme.js']) {
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
  await page.goto(base + '/?open=Immersive.pdf&topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId)
    .catch(error => { console.error('Browser errors:', errors); throw error; });
  if (await page.$eval('#railLeft [data-rail="files"]', node => !node.classList.contains('active'))) await page.click('#railLeft [data-rail="files"]');
  const sidebar = await page.evaluate(() => ({
    search: document.querySelector('#fileFilter').getBoundingClientRect().height,
    import: document.querySelector('#readerImport').getBoundingClientRect().height,
    drop: getComputedStyle(document.querySelector('#dropzone')).display,
    folder: getComputedStyle(document.querySelector('.folder-switch-row')).display,
  }));
  assert.ok(sidebar.search > 20 && sidebar.import > 20);
  assert.equal(sidebar.drop, 'none'); assert.equal(sidebar.folder, 'none');
  await page.screenshot({ path: path.join(scratch, 'reader-sidebar.png') });
  await page.evaluate(async () => { __viewer.setTwoUp(false); __viewer.setScale(1.1, { keepCenter: false }); __viewer._fitMode = false; await __viewer.goToPage(3); });
  const original = await page.evaluate(() => ({ scale: __viewer.scale, twoUp: __viewer._twoUp }));
  await page.click('#immersiveBtn');
  await page.waitForFunction(() => document.body.classList.contains('immersive-reading') && __viewer.immersive && document.body.classList.contains('immersive-chrome-visible'));
  await pause(500);
  const spread = () => page.evaluate(() => {
    const view = __viewer.container.getBoundingClientRect();
    const visible = [...document.querySelectorAll('#viewer .page')].filter(node => {
      const r = node.getBoundingClientRect(); return r.width && r.height && getComputedStyle(node).visibility !== 'hidden'
        && r.bottom > view.top && r.top < view.bottom && r.right > view.left && r.left < view.right;
    }).map(node => { const r = node.getBoundingClientRect(); return { page: Number(node.dataset.page), top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
    return { visible, view: { top: view.top, bottom: view.bottom, left: view.left, right: view.right }, scale: __viewer.scale, current: __viewer.current };
  });
  let state = await spread();
  assert.equal(state.visible.length, 2);
  assert.ok(state.visible.every(r => r.top >= state.view.top - 2 && r.bottom <= state.view.bottom + 2));
  const initialScale = state.scale;
  await page.click('#immersiveNext').catch(async error => {
    console.log(await page.$eval('#immersiveNext', n => ({rect:n.getBoundingClientRect().toJSON(),display:getComputedStyle(n).display, footer:n.parentElement.getBoundingClientRect().toJSON(), body:document.body.className})));
    await page.screenshot({path:path.join(scratch,'failed-chrome.png')}); throw error;
  }); await pause(600);
  state = await spread(); assert.equal(state.current, 5); assert.equal(state.visible.length, 2); assert.equal(state.scale, initialScale);
  await page.mouse.move(750, 460); await page.evaluate(() => document.activeElement?.blur());
  await page.waitForFunction(() => !document.body.classList.contains('immersive-chrome-visible'), { timeout: 4500 });
  await page.mouse.move(750, 2);
  await page.waitForFunction(() => document.body.classList.contains('immersive-chrome-visible'));
  await page.mouse.move(750, 460);
  await page.mouse.click(1300, 500); await pause(650);
  assert.equal((await spread()).current, 7);
  await page.mouse.click(200, 500); await pause(650);
  assert.equal((await spread()).current, 5);
  await page.evaluate(() => document.querySelector('#viewer').focus());
  await page.keyboard.press('ArrowRight'); await pause(600);
  assert.equal((await spread()).current, 7);
  const textPoint = await page.$eval('#viewer .page:not(.immersive-hidden) .textLayer span', node => {
    const r = node.getBoundingClientRect(); return { x: r.left + 2, y: r.top + r.height / 2, width: r.width };
  });
  await page.mouse.move(textPoint.x, textPoint.y); await page.mouse.down();
  await page.mouse.move(textPoint.x + Math.max(35, Math.min(100, textPoint.width)), textPoint.y, { steps: 8 });
  await page.mouse.up(); await pause(450);
  assert.equal((await spread()).current, 7, 'dragging to select text must not turn the page');
  await page.evaluate(() => getSelection()?.removeAllRanges());
  console.log('PASS fixed complete spreads, direct left/right navigation, keyboard turns and edge-revealed chrome');

  await page.mouse.move(750, 2); await page.click('#immersiveChat');
  await page.waitForFunction(() => document.body.classList.contains('immersive-chat-open'));
  const previousSession = await page.evaluate(() => __ctx.activeSession);
  await page.click('#sessNew');
  await page.waitForFunction(previous => __ctx.activeSession !== previous, {}, previousSession);
  await page.evaluate(() => {
    __ctx.addEntry({ block: 'chat', kind: 'user', text: '这两页讲了什么？', page: 7 });
    const answer = __ctx.addEntry({ block: 'chat', tag: 'qa', page: 7 });
    __ctx.finishEntry(answer, '这两页分别介绍第 2 节的两个主题。\n\n可以先阅读左页，再对照右页的例子。需要核对时，点击来源即可回到原文。\n\n这是一段独立测试内容，用来检查浮动问答卡片的排版与输入框。', { page: 7 });
  });
  await page.type('#chatInput', 'Keep this draft while reading');
  const card = await page.$eval('#rightSide', node => { const r = node.getBoundingClientRect(); return { position: getComputedStyle(node).position, width: r.width, bottom: r.bottom }; });
  assert.ok(['fixed', 'absolute'].includes(card.position)); assert.ok(card.width > 300 && card.bottom <= 962);
  const composerVisible = () => page.evaluate(() => {
    const input = document.querySelector('#chatInput'), bounds = input.getBoundingClientRect(), side = document.querySelector('#rightSide').getBoundingClientRect();
    return bounds.width > 100 && bounds.height > 20 && bounds.top >= side.top && bounds.bottom <= side.bottom && bounds.right <= innerWidth;
  });
  assert.ok(await composerVisible());
  await page.click('#sessBtn');
  assert.equal(await page.$eval('#sessQuickPop', node => node.classList.contains('hidden')), true, 'session title must not open a duplicate menu');
  await page.click('#sessHist');
  await page.waitForFunction(() => !document.querySelector('#sessHistory').classList.contains('hidden'));
  await page.click('.sess-hist-back');
  await page.waitForFunction(() => document.querySelector('#sessHistory').classList.contains('hidden'));
  assert.ok(await composerVisible());
  await page.screenshot({ path: path.join(scratch, 'immersive-qa.png') });
  await page.setViewport({ width: 560, height: 820 }); await pause(350);
  assert.ok(await composerVisible(), 'narrow floating card must retain a usable composer');
  await page.screenshot({ path: path.join(scratch, 'immersive-qa-narrow.png') });
  await page.setViewport({ width: 1500, height: 960 }); await pause(350);
  await page.click('#immersiveChatClose');
  await page.mouse.move(750, 2); await page.click('#immersiveChat');
  assert.equal(await page.$eval('#chatInput', node => node.value), 'Keep this draft while reading');
  await page.click('#immersiveChatClose');
  await page.evaluate(() => {
    for (const [quote, text] of [['First original passage', '第一条译文'], ['Second original passage', '第二条译文']]) {
      const entry = __ctx.addEntry({ block: 'translate', tag: 'translation', quote, page: 7 });
      __ctx.finishEntry(entry, text, { status: 'complete', page: 7 });
    }
  });
  await page.mouse.move(750, 2); await page.click('#immersiveTranslate');
  await page.waitForSelector('#translationCard:not(.hidden)');
  await page.waitForFunction(() => document.querySelector('#translationCardHistoryList').textContent.includes('第二条译文'));
  assert.ok(await page.$eval('#translationCardHistoryList', node => node.textContent.includes('第一条译文')));
  await page.click('#translationCardHistoryList .reading-card-history-row');
  await page.click('#translationCardSave');
  await page.waitForFunction(() => __state.highlights.some(note => note.note === '第二条译文'));
  await page.click('#translationCardHistory');
  await page.$$eval('#translationCardHistoryList .reading-card-history-row', rows => rows.find(row => row.textContent.includes('第一条译文')).click());
  await page.click('#translationCardDelete');
  await page.waitForFunction(() => document.querySelector('#translationCardHistoryList').textContent.includes('第二条译文')
    && !document.querySelector('#translationCardHistoryList').textContent.includes('第一条译文'));
  await page.click('#translationCardClose');
  await page.mouse.move(750, 2); await page.click('#immersiveTranslate');
  assert.ok(await page.$eval('#translationCardHistoryList', node => node.textContent.includes('第二条译文')));
  await page.click('#translationCardCapture');
  await page.waitForSelector('#regionOverlay:not(.hidden)');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#regionOverlay.hidden');
  assert.ok(await page.evaluate(() => __viewer.immersive && document.body.classList.contains('immersive-reading')), 'Escape cancels screenshot without leaving book view');
  await page.screenshot({ path: path.join(scratch, 'immersive-spread.png') });
  console.log('PASS floating chat retains draft and translation card reopens saved records');
  await page.mouse.move(750, 2); await page.click('#immersiveExit');
  await page.waitForFunction(() => !document.body.classList.contains('immersive-reading') && !__viewer.immersive);
  assert.deepEqual(await page.evaluate(() => ({ scale: __viewer.scale, twoUp: __viewer._twoUp })), original);
  assert.equal(await page.evaluate(() => __viewer.current), 7);
  assert.equal(await page.evaluate(() => document.body.classList.contains('window-fullscreen')), false);
  await page.click('#fullscreenBtn');
  await page.waitForFunction(() => document.body.classList.contains('window-fullscreen'));
  assert.equal(await page.evaluate(() => __viewer.immersive), false, 'ordinary fullscreen must not enable book mode');
  await page.click('#immersiveBtn');
  await page.waitForFunction(() => document.body.classList.contains('immersive-chrome-visible'));
  await page.click('#immersiveExit');
  await page.waitForFunction(() => !__viewer.immersive);
  assert.ok(await page.evaluate(() => document.body.classList.contains('window-fullscreen')), 'exit must preserve fullscreen already active before book mode');
  await page.click('#fullscreenBtn');
  await page.evaluate(() => __ctx.saveSessionNow());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.click('#immersiveBtn');
  await page.waitForFunction(() => document.body.classList.contains('immersive-chrome-visible'));
  await page.click('#immersiveTranslate');
  await page.waitForFunction(() => document.querySelector('#translationCardHistoryList').textContent.includes('第二条译文'));
  assert.ok(await page.evaluate(() => __state.highlights.some(note => note.note === '第二条译文')));
  assert.equal(await page.$eval('#translationCardHistoryList', node => node.textContent.includes('第一条译文')), false);
  assert.deepEqual(errors, []);
  console.log(`PASS exit restores normal zoom/layout at the final page; ${scratch}`);
} finally { await browser?.close(); await stopChild(reader); }
