/** Home workspace interactions and responsive layouts, using isolated fixture data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `home-workspace-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papersDir);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser, page;
const errors = [];
let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papersDir, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('home-workspace').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  check('isolated service starts', ready);
  for (const file of ['index.html', 'style.css', 'js/app.js', 'js/windows.js', 'js/locales/en.js']) {
    let served = await fetch(`${base}/${file}`).then(r => r.text());
    if (file === 'index.html') served = served.replace(/\n<!-- prt-auth:[\s\S]*?<\/script>\n/, '');
    check(`current asset: ${file}`, served === fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'));
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 960 } });
  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    if (!localStorage.getItem('reader.locale')) localStorage.setItem('reader.locale', 'zh-CN');
  });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'networkidle0' });
  const visible = selector => page.$eval(selector, n => !!n.getClientRects().length);
  const count = () => page.$$eval('#homeList .home-item', nodes => nodes.length);
  const ids = () => page.$$eval('#homeList .home-item', nodes => nodes.map(n => n.dataset.id));
  const filter = name => page.click(`[data-home-filter="${name}"]`);
  const zoomKey = async key => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); };
  const search = async text => {
    await page.$eval('#homeSearch', (n, value) => { n.value = value; n.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  };
  check('empty library gives an actionable welcome', await page.$eval('#homeList', n => n.textContent.includes('还没有论文')));
  check('Library is the single top-level name', await page.$eval('#homeHeading', n => n.textContent === 'Library')
    && await page.$eval('#homeBtn', n => n.textContent.includes('Library'))
    && await page.$eval('#docName', n => n.textContent === 'Library'));
  check('reading toolbar is hidden on home', !(await visible('.viewer-foot')) && !(await visible('#opsBtn')));
  await page.screenshot({ path: path.join(scratch, 'empty.png') });
  const fixtureNames = [
    'Transformer 阅读笔记与问题整理.pdf',
    'Transformer/Attention Is All You Need.pdf',
    'Transformer/Tokens-to-Token ViT — Training Vision Transformers from Scratch.pdf',
    '计算机视觉/Deep Residual Learning for Image Recognition.pdf',
    '计算机视觉/Squeeze-and-Excitation Networks.pdf',
    '计算机视觉/子目录/Attention Is All You Need.pdf',
  ];
  for (const name of fixtureNames) {
    fs.mkdirSync(path.dirname(path.join(papersDir, name)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papersDir, name));
  }
  fs.mkdirSync(path.join(papersDir, 'Empty folder'));
  const papers = (await fetch(`${base}/api/papers`).then(r => r.json())).papers;
  const last = papers.find(p => p.path === fixtureNames[1]);
  const older = papers.find(p => p.path === fixtureNames[3]);
  const duplicate = papers.find(p => p.path === fixtureNames[5]);
  assert.ok(last && older && duplicate);
  await fetch(`${base}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    docs: { [last.docId]: { name: last.name, page: 5, ts: Date.now() - 3600000 }, [older.docId]: { name: older.name, page: 2, ts: Date.now() - 7200000 } },
    lastDoc: last.docId, lastName: last.name, lastUrl: last.url,
  }) });
  await page.reload({ waitUntil: 'networkidle0' });
  check('all papers and folders appear', await count() === papers.length && await page.$$eval('#homeFolders [data-home-folder]', n => n.length) === 5);
  const readCount = papers.filter(p => [last.docId, older.docId].includes(p.docId)).length;
  check('sidebar counts match visible entries, including same-name copies', await page.$eval('#homeReadCount', n => n.textContent) === String(readCount) && await page.$eval('#homeUnreadCount', n => n.textContent) === String(papers.length - readCount));
  check('paper cards replace repeated headings and text rows', await page.evaluate(() =>
    !document.querySelector('.home-eyebrow') && !document.querySelector('.home-description')
    && !document.querySelector('.home-list-head') && !document.querySelector('.home-drop').getClientRects().length
    && !document.querySelector('.home-continue') && document.querySelector('#homeResultCount').hidden
    && getComputedStyle(document.querySelector('#homeList')).display === 'grid'
    && document.querySelector('#homeList .hi-name')?.getClientRects().length
    && !document.querySelector('#homeList .hi-meta') && document.querySelector('#homeList .hi-status')?.getClientRects().length));
  await page.waitForFunction(() => [...document.querySelectorAll('.hi-preview img')].some(img => img.naturalWidth > 0), { timeout: 20000 });
  const loadedBeforeScroll = await page.$$eval('.hi-preview img', nodes => nodes.filter(img => img.naturalWidth > 0).length);
  check('visible paper cards render real first-page PDF thumbnails', loadedBeforeScroll > 0 && loadedBeforeScroll <= papers.length);
  await page.$eval('.home-content', node => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }));
  await page.waitForFunction(() => [...document.querySelectorAll('.hi-preview img')].every(img => img.naturalWidth > 0), { timeout: 20000 });
  check('scrolling through the grid loads the remaining thumbnails', await page.$$eval('.hi-preview img', nodes => nodes.length === nodes.filter(img => img.naturalWidth > 0).length));
  await page.setViewport({ width: 1440, height: 960 });
  await page.$eval('.home-content', node => node.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: path.join(scratch, 'home-desktop.png') });
  await filter('recent');
  assert.deepEqual(await ids(), [...papers.filter(p => p.docId === last.docId).map(p => p.docId), older.docId]); checks++; console.log('PASS recent papers are ordered by last read');
  await filter('unread');
  check('unread filter excludes started papers', await count() === papers.length - readCount && !(await ids()).includes(last.docId));
  check('unread filter has no unrelated continue card', await page.$('.home-continue') === null);
  await page.click('[data-home-folder="计算机视觉"]');
  check('folder view includes nested folders', await count() === 3);
  await page.click('[data-home-folder="计算机视觉/子目录"]');
  assert.deepEqual(await ids(), [duplicate.docId]); checks++; console.log('PASS nested folder isolates same-name paper');
  check('folder button keeps keyboard focus', await page.evaluate(() => document.activeElement.dataset.homeFolder === '计算机视觉/子目录'));
  await page.click('[data-home-folder="Empty folder"]');
  check('empty folder explains its state', await page.$eval('.home-empty', n => n.textContent.includes('这个文件夹还没有论文')));
  await filter('all');
  await search('ATTENTION');
  check('search matches case-insensitively and keeps duplicates', await count() === 2);
  await search('计算机视觉');
  check('search matches folder paths', await count() === 3);
  await search('<no such paper>');
  check('no matches has a reset action', await page.$('.home-reset') !== null && await count() === 0);
  await page.click('.home-reset');
  check('reset restores all papers and clears query', await count() === 6 && await page.$eval('#homeSearch', n => n.value) === '');
  await page.focus('#homeSearch'); await page.type('#homeSearch', 'Tokens');
  check('typing retains input focus', await page.evaluate(() => document.activeElement.id === 'homeSearch'));
  await page.keyboard.press('Escape');
  check('Escape clears search', await count() === 6);
  const headingBefore = await page.$eval('#homeHeading', n => n.getBoundingClientRect().height);
  const initialZoom = await page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--home-scale')) * 100);
  const fontBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ai-fs'));
  await zoomKey('+'); await zoomKey('+');
  check('Ctrl+plus zooms home with focused search', await page.$eval('#homeHeading', (n, before) => n.getBoundingClientRect().height > before, headingBefore));
  check('home zoom leaves reader font unchanged', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ai-fs')) === fontBefore);
  await page.reload({ waitUntil: 'networkidle0' });
  check('home zoom persists', await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style.homeZoom) === Math.min(160, initialZoom + 20));
  await zoomKey('-');
  check('Ctrl+minus reduces home zoom', await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style.homeZoom) === Math.min(160, initialZoom + 20) - 10);
  for (let i = 0; i < 10; i++) await zoomKey('+');
  check('home zoom has an upper bound', await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style.homeZoom) === 160);
  for (const width of [900, 480, 360]) {
    await page.setViewport({ width, height: 850 });
    check(`enlarged home fits at ${width}px`, await page.evaluate(() => ['#home', '.home-content', '.home-workspace', '.home-list'].every(s => { const n = document.querySelector(s); return n.scrollWidth <= n.clientWidth + 1; })));
  }
  await page.setViewport({ width: 1440, height: 960 });
  await zoomKey('0');
  check('Ctrl+0 resets home zoom', await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style.homeZoom) === initialZoom);
  check('library content shares the full work surface with a single folder divider', await page.evaluate(() =>
    getComputedStyle(document.querySelector('#home')).borderRadius === '0px'
    && parseFloat(getComputedStyle(document.querySelector('.home-content')).borderRadius) === 0
    && getComputedStyle(document.querySelector('.home-content')).boxShadow === 'none'
    && getComputedStyle(document.querySelector('.home-sidebar')).borderStyle !== 'none'));
  const chooser = await Promise.all([page.waitForFileChooser(), page.click('#homeOpen')]).then(r => r[0]);
  check('open PDF launches file picker', chooser.isMultiple());
  await chooser.cancel();
  for (const theme of ['glass', 'light', 'dark']) {
    await page.evaluate(value => { const select = document.querySelector('#uiTheme'); select.value = value; select.dispatchEvent(new Event('input', { bubbles: true })); }, theme);
    check(`${theme} theme applies`, await page.evaluate(() => document.documentElement.dataset.theme) === theme);
    await page.focus('#homeSearch');
    check(`${theme} focused search has no extra frame`, await page.$eval('#homeSearch', input => {
      const field = getComputedStyle(input), shell = getComputedStyle(input.closest('.home-search'));
      return field.outlineStyle === 'none' && field.boxShadow === 'none' && field.backgroundColor === 'rgba(0, 0, 0, 0)'
        && shell.outlineStyle === 'none' && shell.boxShadow === 'none';
    }));
    await page.screenshot({ path: path.join(scratch, `home-${theme}.png`) });
  }
  for (const width of [1920, 1280, 900, 700, 480, 360]) {
    await page.setViewport({ width, height: 850 });
    check(`home fits at ${width}px`, await page.evaluate(() => ['#home', '.home-content', '.home-workspace', '.home-list'].every(s => { const n = document.querySelector(s); return n.scrollWidth <= n.clientWidth + 1; })));
    check(`sidebar and main remain usable at ${width}px`, await page.$eval('#homeOpen', n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; }));
    if (width === 480 || width === 900) await page.screenshot({ path: path.join(scratch, `home-${width}.png`) });
  }
  await page.setViewport({ width: 1440, height: 960 });
  await page.evaluate(() => { const s = document.querySelector('#uiTheme'); s.value = 'glass'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await filter('all');
  await filter('recent');
  await page.click(`#homeList [data-id="${last.docId}"] .home-item-go`);
  await page.waitForFunction(() => window.__viewer?.numPages > 0 && window.__state?.viewerDocId === window.__state.doc?.docId);
  check('clicking a recent paper card resumes its saved path and page', await page.evaluate(p => window.__state.doc.docId === p.docId && window.__state.doc.path === p.path && window.__viewer.current === 5, last));
  check('reading toolbar returns in reader', await visible('.viewer-foot') && await visible('#opsBtn'));
  await page.screenshot({ path: path.join(scratch, 'reader-regression.png') });
  await page.click('.doc-tab.active .tab-close');
  await page.waitForFunction(() => !document.body.classList.contains('reading'));
  check('closing last tab restores home', await visible('#home') && !(await visible('#viewer')));
  await page.click(`[data-home-folder="计算机视觉/子目录"]`);
  await page.click('#homeList .home-item-go');
  await page.waitForFunction(id => window.__state?.doc?.docId === id && window.__viewer?.numPages > 0, {}, duplicate.docId);
  check('same-name document opens by exact path', await page.evaluate(p => window.__state.doc.docId === p.docId && window.__state.doc.path === p.path, duplicate));
  await page.waitForSelector('.doc-tab.active .tab-close', { visible: true });
  await page.click('.doc-tab.active .tab-close');
  await page.waitForFunction(() => !document.body.classList.contains('reading'));
  await filter('all');
  await page.hover(`#homeList [data-path="${last.path}"]`);
  await page.click(`#homeList [data-path="${last.path}"] .home-item-x`);
  await page.waitForSelector('.sess-confirm-mask:not(.hidden)', { visible: true });
  await page.click('.sess-confirm-mask .sess-confirm-btn.danger');
  await page.waitForFunction(filePath => ![...document.querySelectorAll('#homeList [data-path]')].some(row => row.dataset.path === filePath), {}, last.path);
  check('Library deletion removes the paper card and PDF file', await page.$(`#homeList [data-path="${last.path}"]`) === null && !fs.existsSync(path.join(papersDir, last.path)));
  const removedState = await page.evaluate(() => fetch('/api/state').then(r => r.json()));
  check('file deletion preserves saved reading history', !!removedState.docs[last.docId] && !!removedState.docs[older.docId]);
  check('missing history id is rejected', await page.evaluate(() => fetch('/api/state', { method: 'DELETE' }).then(r => r.status)) === 400);
  check('removing absent history is harmless', await page.evaluate(() => fetch('/api/state?doc=absent-fixture', { method: 'DELETE' }).then(r => r.json()).then(r => r.ok && r.removed === false)));
  await page.evaluate(() => localStorage.setItem('reader.locale', 'en'));
  await page.reload({ waitUntil: 'networkidle0' });
  check('English homepage is localized', await page.$eval('#homeHeading', n => n.textContent) === 'Library');
  check('deleted paper stays absent after reload', await page.$(`#homeList [data-path="${last.path}"]`) === null);
  const untranslated = await page.evaluate(() => {
    const out = [], walker = document.createTreeWalker(document.querySelector('#home'), NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement.closest('.hi-name,.hc-name,.hf-name,[data-home-folder]')) continue;
      if (/[\u3400-\u9fff]/.test(n.textContent) && n.parentElement.getClientRects().length) out.push(n.textContent.trim());
    }
    return out;
  });
  assert.deepEqual(untranslated, []); checks++; console.log('PASS English UI has no untranslated application text');
  await page.screenshot({ path: path.join(scratch, 'home-english.png') });
  writeTitlePdf(path.join(papersDir, '1706.03762.pdf'));
  writeTitlePdf(path.join(papersDir, '2101.11986.pdf'), { title: 'A Prominent First Page Title', metadata: 'Untitled' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#homeList').textContent.includes('1706.03762 · Attention Is All You Need')
    && document.querySelector('#homeList').textContent.includes('2101.11986 · A Prominent First Page Title'));
  check('numeric PDFs show metadata and first-page titles', true);
  await search('Prominent First'); check('search matches an extracted title', await count() === 1);
  await page.click('#homeList .home-item-go');
  await page.waitForFunction(() => window.__viewer?.numPages > 0 && window.__state?.doc?.path === '2101.11986.pdf');
  check('title label opens the original path', fs.existsSync(path.join(papersDir, '2101.11986.pdf')) && !fs.existsSync(path.join(papersDir, 'A Prominent First Page Title.pdf')));
  assert.deepEqual(errors, []); checks++; console.log('PASS no browser errors');
  console.log(`PASS ${checks} checks (${desktop ? 'embedded desktop' : 'Node'}). Screenshots: ${scratch}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
    console.error(await page.evaluate(async () => ({ home: document.querySelector('#home').innerText, toast: document.querySelector('#toastWrap')?.innerText,
      state: await fetch('/api/state').then(r => r.json()), errors: [] })).catch(() => ({})));
  }
  console.error('Artifacts:', scratch);
  throw error;
} finally {
  await browser?.close();
  await stopChild(reader);
}
