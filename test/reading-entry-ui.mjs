/** Real Library layout with isolated state, no user files or model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'reading-entry-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
writeTitlePdf(path.join(papers, 'Reading.pdf'), { title: 'Startup reading fixture' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('library-sidebar').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready);
  for (const asset of ['js/library-sidebar.js', 'js/app.js', 'style.css']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1600, height: 1000 } });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 1);
  const paper = (await fetch(base + '/api/papers').then(r => r.json())).papers[0];
  assert.equal(await page.$eval('#homeReadingEntry', n => n.disabled), true);
  await page.goto(base + '/?document=' + encodeURIComponent(paper.docId), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId && document.body.classList.contains('reading'));
  await page.locator('#homeBtn').click();
  await page.waitForFunction(() => !document.body.classList.contains('reading'));
  assert.equal(await page.$eval('#homeReadingEntry span', n => n.textContent), '回到阅读区');
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 1);
  assert.equal(await page.$eval('#homeReadingEntry span', n => n.textContent), '打开上次阅读区');
  assert.equal(await page.$eval('#homeReadingEntry', n => n.disabled), false);
  await page.screenshot({ path: path.join(scratch, 'library-entry.png') });
  await page.locator('#homeAgent').click();
  await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  for (const selector of ['#agentReadingEntry', '#agentNavNew']) {
    assert.ok(await page.$eval(selector, n => n.getBoundingClientRect().height > 30 && getComputedStyle(n).visibility !== 'hidden'));
  }
  assert.equal(await page.$eval('#agentReadingEntry span:last-child', n => n.textContent), '打开上次阅读区');
  await page.locator('#agentSidebarToggle').click();
  assert.ok(await page.$eval('#agentNavNew', n => n.getBoundingClientRect().width > 30));
  assert.equal(await page.$('#agentNewSessionEntry'), null);
  assert.ok(await page.$('#agentNavNew [data-agent-icon="chat-new"] svg'));
  await page.evaluate(() => window.__ctx.openAgentWorkspace({ landing: false }));
  assert.equal(await page.$eval('#sessBar', n => getComputedStyle(n).display), 'none');
  const oldSid = await page.evaluate(() => window.__ctx.activeSession);
  await page.locator('#agentNavNew').click();
  await page.waitForFunction(old => window.__ctx.activeSession !== old, {}, oldSid);
  await page.screenshot({ path: path.join(scratch, 'alina-entry.png') });
  await page.setViewport({ width: 480, height: 900 }); await pause(150);
  for (const selector of ['#agentReadingEntry', '#agentNavNew']) {
    assert.ok(await page.$eval(selector, n => { const r = n.getBoundingClientRect(); return r.width > 30 && r.left >= 0 && r.right <= innerWidth; }));
  }
  await page.setViewport({ width: 1600, height: 1000 }); await pause(100);
  console.log('PASS Library and Alina show explicit first-open entries; new session stays visible with sidebar collapsed');
  await page.locator('#agentReadingEntry').click();
  await page.waitForFunction(() => window.__viewer?.pdf && !document.body.classList.contains('agent-full') && document.body.classList.contains('reading'));
  await page.evaluate(() => { window.__viewer.setScale(1.3, { keepCenter: false }); window.__viewer._fitMode = false; });
  const before = await page.evaluate(() => ({ scale: window.__viewer.scale, docId: window.__state.doc.docId }));
  await page.locator('#agentBtn').click();
  await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  assert.equal(await page.$eval('#agentReadingEntry span:last-child', n => n.textContent), '回到阅读区');
  await page.locator('#agentReadingEntry').click();
  await page.waitForFunction(() => !document.body.classList.contains('agent-full') && document.body.classList.contains('reading'));
  assert.deepEqual(await page.evaluate(() => ({ scale: window.__viewer.scale, docId: window.__state.doc.docId })), before);
  await page.locator('#homeBtn').click();
  await page.waitForFunction(() => !document.body.classList.contains('reading'));
  assert.equal(await page.$eval('#homeReadingEntry span', n => n.textContent), '回到阅读区');
  await page.locator('#homeReadingEntry').click();
  await page.waitForFunction(() => document.body.classList.contains('reading'));
  assert.deepEqual(await page.evaluate(() => ({ scale: window.__viewer.scale, docId: window.__state.doc.docId })), before);
  assert.deepEqual(errors, []);
  console.log('PASS both entry points switch to Back to reading and preserve the live reader zoom and document; ' + scratch);

} finally { await browser?.close(); await stopChild(reader); }
