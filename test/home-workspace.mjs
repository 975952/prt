/** Home workspace interactions and responsive layouts, using isolated fixture data only. */
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
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'networkidle0' });
  const visible = selector => page.$eval(selector, n => !!n.getClientRects().length);
  const count = () => page.$$eval('#homeList .home-item', nodes => nodes.length);
  const ids = () => page.$$eval('#homeList .home-item', nodes => nodes.map(n => n.dataset.id));
  const filter = name => page.click(`[data-home-filter="${name}"]`);
  const search = async text => {
    await page.$eval('#homeSearch', (n, value) => { n.value = value; n.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  };
  check('empty library gives an actionable welcome', await page.$eval('#homeList', n => n.textContent.includes('还没有论文')));
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
  check('all papers and folders appear', await count() === papers.length && await page.$$eval('.home-folder', n => n.length) === 4);
  const readCount = papers.filter(p => [last.docId, older.docId].includes(p.docId)).length;
  check('sidebar counts match visible entries, including same-name copies', await page.$eval('#homeReadCount', n => n.textContent) === String(readCount) && await page.$eval('#homeUnreadCount', n => n.textContent) === String(papers.length - readCount));
  check('continue card shows saved page', await page.$eval('.home-continue', n => n.textContent.includes('第 5 页')));
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
  const chooser = await Promise.all([page.waitForFileChooser(), page.click('#homeOpen')]).then(r => r[0]);
  check('open PDF launches file picker', chooser.isMultiple());
  await chooser.cancel();
  for (const theme of ['glass', 'light', 'dark']) {
    await page.evaluate(value => { const select = document.querySelector('#uiTheme'); select.value = value; select.dispatchEvent(new Event('input', { bubbles: true })); }, theme);
    check(`${theme} theme applies`, await page.evaluate(() => document.documentElement.dataset.theme) === theme);
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
  await page.click('.home-continue');
  await page.waitForFunction(() => window.__viewer?.numPages > 0 && window.__state?.viewerDocId === window.__state.doc?.docId);
  check('continue opens correct paper, path and page', await page.evaluate(p => window.__state.doc.docId === p.docId && window.__state.doc.path === p.path && window.__viewer.current === 5, last));
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
  await page.hover(`#homeList [data-id="${last.docId}"]`);
  await page.click(`#homeList [data-id="${last.docId}"] .home-item-x`);
  await page.waitForFunction(id => !document.querySelector(`#homeList [data-id="${id}"] .home-item-x`), {}, last.docId);
  check('removing history retains the file as unread', (await ids()).includes(last.docId) && fs.existsSync(path.join(papersDir, last.path)));
  const removedState = await page.evaluate(() => fetch('/api/state').then(r => r.json()));
  check('removal persists and preserves other reading history', !removedState.docs[last.docId] && !!removedState.docs[older.docId] && removedState.lastDoc === null);
  check('missing history id is rejected', await page.evaluate(() => fetch('/api/state', { method: 'DELETE' }).then(r => r.status)) === 400);
  check('removing absent history is harmless', await page.evaluate(() => fetch('/api/state?doc=absent-fixture', { method: 'DELETE' }).then(r => r.json()).then(r => r.ok && r.removed === false)));
  await page.evaluate(() => localStorage.setItem('reader.locale', 'en'));
  await page.reload({ waitUntil: 'networkidle0' });
  check('English homepage is localized', await page.$eval('#homeHeading', n => n.textContent) === 'Library');
  check('removed history stays removed after reload', await page.$(`#homeList [data-id="${last.docId}"] .home-item-x`) === null);
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
