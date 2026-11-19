/** Library folder controls and path continuity; synthetic, isolated, offline.
 * node test/library-folders.mjs [--desktop] */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `library-folders-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
for (const relative of ['Study/Sub/active.pdf', 'Study/parked.pdf', 'Conflict/active.pdf', 'active.pdf',
  'RemoveMe/unique.pdf', 'Partial/a-movable.pdf', 'Partial/active.pdf']) {
  fs.mkdirSync(path.dirname(path.join(papersDir, relative)), { recursive: true });
  writeTitlePdf(path.join(papersDir, relative), { title: `Synthetic folder reading ${relative.replace(/\.pdf$/, '')}` });
}
fs.mkdirSync(path.join(papersDir, 'OtherFiles/Empty'), { recursive: true });
fs.writeFileSync(path.join(papersDir, 'OtherFiles/keep.txt'), 'NON_PDF_MUST_SURVIVE', 'utf8');
fs.mkdirSync(path.join(papersDir, 'Big'));
function rangePdf(destination) {
  const count = 42, objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${4 + i} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < count; i++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${4 + count + i} 0 R >>`);
  for (let i = 0; i < count; i++) {
    const text = `BT /F1 18 Tf 65 700 Td (Synthetic folder page ${i + 1}) Tj ET\n%${'x'.repeat(512 * 1024)}\n`;
    objects.push(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`);
  }
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  for (let i = 0; i < objects.length; i++) { offsets.push(length); const chunk = Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`); chunks.push(chunk); length += chunk.length; }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  fs.writeFileSync(destination, Buffer.concat(chunks));
}
rangePdf(path.join(papersDir, 'Big/range.pdf'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], requests = [], failed = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const folder = relative => `#homeFolders [data-folder-path=${JSON.stringify(relative)}]`;
let reader, browser, page, base;
async function api(route, body) {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }); assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
}
async function home() {
  if (await page.evaluate(() => document.body.classList.contains('reading'))) await page.locator('#homeBtn').click();
  await page.waitForSelector('#home', { visible: true });
}
async function action(relative, label, rightClick = false) {
  if (rightClick) await page.click(`${folder(relative)} .home-nav-btn`, { button: 'right' });
  else await page.locator(`${folder(relative)} .home-folder-action`).click();
  await page.waitForSelector('#fileCtx', { visible: true });
  await page.$$eval('#fileCtx button', (buttons, label) => {
    const button = buttons.find(button => button.textContent === label); if (!button) throw new Error(`Missing action ${label}`); button.click();
  }, label);
}
async function commitName(name) {
  const input = await page.waitForSelector('#homeFolders .inline-name', { visible: true });
  await input.evaluate((node, name) => { node.value = name; }, name); await input.press('Enter');
}
async function rename(from, name) { await action(from, '重命名'); await commitName(name); }
async function move(from, to) {
  await action(from, '移动到…');
  await page.$$eval('#fileCtx button', (buttons, to) => {
    const button = buttons.find(button => button.textContent === to); if (!button) throw new Error(`Missing destination ${to}`); button.click();
  }, to || '根目录');
}
async function remove(relative, confirm = true) {
  await action(relative, '删除文件夹（保留论文）');
  await page.waitForSelector('.sess-confirm-mask:not(.hidden)');
  await page.locator(`.sess-confirm-acts button:${confirm ? 'last' : 'first'}-child`).click();
  await page.waitForSelector('.sess-confirm-mask.hidden');
  if (confirm) await page.waitForFunction(() => document.querySelector('#homeFolders').getAttribute('aria-busy') !== 'true');
}
async function opened(relative) {
  const paper = (await api('/api/papers')).papers.find(paper => paper.path === relative); assert.ok(paper);
  await page.evaluate(paper => window.__ctx.openDoc(paper), paper);
  await page.waitForFunction(id => window.__state.viewerDocId === id && window.__viewer?.pdf, {}, paper.docId);
  return paper;
}
async function position() {
  return page.evaluate(() => ({ path: window.__state.doc.path, page: window.__viewer.current,
    scale: window.__viewer.scale, anchor: window.__viewer._captureAnchor(), draft: document.querySelector('#chatInput').value,
    samePdf: window.__viewer.pdf === window.__folderPdf }));
}
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('library-folders').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', data => fs.appendFileSync(path.join(scratch, 'server.log'), data));
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready); assert.equal(path.resolve((await api('/api/papers')).dir), papersDir);
  assert.equal(await fetch(`${base}/js/app.js`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage(); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(String(error.stack || error)));
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/pdf' && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== base || ['/api/chat', '/api/web-search', '/api/ref-search', '/api/import-pdf'].includes(url.pathname)) {
      errors.push(`Unexpected model/external request: ${url.pathname}`); return request.abort();
    }
    if (url.origin === base) requests.push({ route: url.pathname, query: url.search, path: url.searchParams.get('path'), method: request.method(),
      body: request.method() === 'POST' || request.method() === 'PATCH' ? request.postData() : undefined, range: request.headers().range });
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('reader.locale', 'zh-CN'); localStorage.setItem('reader.session.scopeMode', 'paper'); localStorage.setItem('reader.session.onEnter', 'latest'); localStorage.setItem('reader.session.aiTitle', '0'); });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 8);
  await page.locator('#homeNewFolder').click(); await commitName('Destination');
  await page.waitForSelector(folder('Destination'));
  await action('Destination', '新建子文件夹', true); await commitName('Existing');
  await page.waitForSelector(folder('Destination/Existing'));
  await action('Destination', '重命名'); await page.locator('#homeFolders .inline-name').fill('Cancelled');
  await page.keyboard.press('Escape'); assert.ok(await page.$(folder('Destination'))); assert.ok(!fs.existsSync(path.join(papersDir, 'Cancelled')));
  pass('Library exposes folder actions and right-click menus, creates root/subfolders, and cancels visible inline edits');

  await opened('Study/parked.pdf'); const active = await opened('Study/Sub/active.pdf');
  await page.evaluate(async () => { window.__ctx.setPanelVisible('chat', true); window.__folderPdf = window.__viewer.pdf;
    window.__viewer.setScale(1.2, { keepCenter: false }); window.__viewer._fitMode = false; await window.__viewer.restorePosition({ scrollTop: 160 });
    document.querySelector('#chatInput').value = 'KEEP_FOLDER_DRAFT'; document.querySelector('#chatInput').dispatchEvent(new Event('input', { bubbles: true })); await window.__ctx.flushComposerDrafts(); });
  const before = await position();
  await api(`/api/notes?doc=${active.docId}`, { items: [{ id: 'folder-note', page: 1, text: 'PERSIST_FOLDER_NOTE' }] });
  await home(); await page.locator(`${folder('Study')} .home-nav-btn`).click(); await rename('Study', 'Renamed');
  await page.waitForSelector(folder('Renamed/Sub'));
  assert.equal(await page.evaluate(() => window.__state.doc.path), 'Renamed/Sub/active.pdf');
  assert.ok((await page.evaluate(() => window.__ctx.tabs)).some(tab => tab.path === 'Renamed/parked.pdf'));
  assert.equal(new URL((await api('/api/state')).lastUrl, base).searchParams.get('path'), 'Renamed/Sub/active.pdf');
  assert.ok(await page.$('#homeList [data-path="Renamed/Sub/active.pdf"]'));
  await move('Renamed', 'Destination'); await page.waitForSelector(folder('Destination/Renamed/Sub'));
  await page.locator('#homeBtn').click(); await page.waitForFunction(() => document.body.classList.contains('reading')
    && window.__state.doc.path === 'Destination/Renamed/Sub/active.pdf' && window.__state.viewerDocId === window.__state.doc.docId);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await position();
  assert.equal(after.samePdf, true); assert.equal(after.scale, before.scale); assert.equal(after.draft, before.draft);
  assert.equal(after.anchor.page, before.anchor.page); assert.ok(Math.abs(after.anchor.frac - before.anchor.frac) < .02, JSON.stringify({ before, after }));
  assert.ok((await api(`/api/notes?doc=${active.docId}`)).items.some(note => note.id === 'folder-note'));
  await opened('Destination/Renamed/parked.pdf'); assert.match(await page.evaluate(() => window.__viewer.getPageText(1)), /Synthetic folder reading/);
  pass('renaming and moving a folder preserves active and parked readers, tabs, position, draft, notes and persisted last path');

  await home(); await rename('Destination/Renamed', 'Existing');
  await page.waitForFunction(() => document.body.textContent.includes('重命名失败'));
  assert.ok(fs.existsSync(path.join(papersDir, 'Destination/Renamed/Sub/active.pdf')));
  const deleteBefore = requests.filter(request => request.method === 'DELETE').length;
  await remove('Destination/Renamed', false); await wait(100);
  assert.equal(requests.filter(request => request.method === 'DELETE').length, deleteBefore);
  await remove('Conflict'); await page.waitForFunction(() => document.body.textContent.includes('删除文件夹失败'));
  assert.ok(fs.existsSync(path.join(papersDir, 'Conflict/active.pdf')) && fs.existsSync(path.join(papersDir, 'active.pdf')));
  await remove('OtherFiles'); await page.waitForFunction(() => document.body.textContent.includes('文件夹仍包含文件'));
  assert.equal(fs.readFileSync(path.join(papersDir, 'OtherFiles/keep.txt'), 'utf8'), 'NON_PDF_MUST_SURVIVE');
  await remove('Destination/Existing'); await page.waitForFunction(() => ![...document.querySelectorAll('#homeFolders [data-folder-path]')].some(node => node.dataset.folderPath === 'Destination/Existing'));
  pass('rename conflicts and cancelled deletion preserve sources, and folder deletion preserves conflicting PDFs and non-PDF files');

  await opened('RemoveMe/unique.pdf'); await home(); await remove('RemoveMe');
  assert.ok(fs.existsSync(path.join(papersDir, 'unique.pdf'))); assert.ok(!fs.existsSync(path.join(papersDir, 'RemoveMe')));
  assert.equal(await page.evaluate(() => window.__state.doc.path), 'unique.pdf');
  await remove('Partial');
  await page.waitForFunction(() => document.body.textContent.includes('删除文件夹失败'));
  assert.ok(fs.existsSync(path.join(papersDir, 'Partial/active.pdf')));
  assert.ok(fs.existsSync(path.join(papersDir, 'a-movable.pdf')) && !fs.existsSync(path.join(papersDir, 'Partial/a-movable.pdf')));
  pass('safe deletion moves the current paper to root, and a partial failure preserves moved files plus the remaining conflicting source');

  await opened('Big/range.pdf');
  await page.evaluate(async () => { window.__folderPdf = window.__viewer.pdf;
    window.__viewer.setScale(1.15, { keepCenter: false }); window.__viewer._fitMode = false;
    await window.__viewer.goToPage(7); await window.__viewer.restorePosition({ scrollTop: window.__viewer.container.scrollTop + 120 }); });
  const bigBefore = await position(); await home(); await rename('Big', 'LargeRenamed');
  await page.waitForSelector(folder('LargeRenamed')); const checkpoint = requests.length;
  assert.equal(await page.evaluate(() => window.__folderPdf.loadingTask.destroyed), true);
  await page.locator('#homeBtn').click(); await page.waitForFunction(() => window.__state.viewerDocId === window.__state.doc.docId && window.__viewer.pdf);
  const bigAfter = await position(); assert.equal(bigAfter.samePdf, false); assert.equal(bigAfter.page, bigBefore.page);
  assert.equal(bigAfter.scale, bigBefore.scale); assert.ok(Math.abs(bigAfter.anchor.frac - bigBefore.anchor.frac) < .02);
  assert.match(await page.evaluate(async () => { await window.__viewer.goToPage(40); return window.__viewer.getPageText(40); }), /Synthetic folder page 40/);
  assert.ok(requests.slice(checkpoint).some(request => request.path === 'LargeRenamed/range.pdf' && request.range));
  assert.ok(!requests.slice(checkpoint).some(request => request.path === 'Big/range.pdf'));
  pass('large PDF folder rename retires the old range transport and restores the reader before loading an uncached page from the new URL');
  await home(); await page.screenshot({ path: path.join(scratch, 'library-folders.png') });
  assert.deepEqual(errors, []);
  assert.ok(failed.every(request => /ERR_ABORTED/.test(request.error || '')), JSON.stringify(failed));
  assert.ok(requests.filter(request => request.method === 'DELETE' && request.route === '/api/folders').every(request => request.query.includes('mode=empty')));
  pass('folder UI uses only safe empty-folder deletion and has no model requests or page errors');
  console.log(`library-folders: ${checks.length}/${checks.length}; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  const pdfState = await page?.evaluate(async () => {
    const pdf = window.__folderPdf, task = pdf?.loadingTask;
    const stateOf = promise => promise ? Promise.race([Promise.resolve(promise).then(() => 'resolved', error => `rejected:${error}`), new Promise(resolve => setTimeout(() => resolve('pending'), 100))]) : 'absent';
    return { path: window.__state?.doc?.path, viewerId: window.__state?.viewerDocId, currentPdf: !!window.__viewer?.pdf,
      taskDestroyed: task?.destroyed, transportDestroyed: pdf?._transport?.destroyed,
      setup: await stateOf(task?._setupCapability?.promise), destroyed: await stateOf(pdf?._transport?.destroyCapability?.promise),
      workerDestroyed: task?._worker?.destroyed, workerPending: task?._worker?._pendingDestroy };
  }).catch(() => null);
  fs.writeFileSync(path.join(scratch, 'pdf-state.json'), JSON.stringify(pdfState, null, 2), 'utf8');
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {}); console.error(`Evidence: ${scratch}`); throw error;
} finally {
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, errors, requests, failed }, null, 2), 'utf8');
  await browser?.close(); if (desktop) await stopChild(reader); else reader?.kill();
}
