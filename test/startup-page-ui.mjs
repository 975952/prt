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
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'startup-page-'));
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
  const reload = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 1);
  };
  const isLibrary = () => page.evaluate(() => !document.body.classList.contains('reading') && !document.body.classList.contains('agent-full') && !document.querySelector('#home').classList.contains('hidden'));
  assert.ok(await isLibrary());
  await page.evaluate(paper => localStorage.setItem('reader.workspace.v1', JSON.stringify({ tabs: [paper], active: paper.docId })), paper);
  await reload(); assert.ok(await isLibrary());
  assert.equal(await page.evaluate(() => window.__viewer?.pdf == null), true);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('reader.workspace.v1')).tabs.length), 1);
  console.log('PASS default startup opens Library without loading PDF or deleting saved tabs');
  await page.locator('#settingsBtn').click(); await page.locator('#settingsNavBehavior').click();
  assert.equal(await page.$eval('#startupPage', n => n.value), 'library');
  await page.select('#startupPage', 'resume'); await page.locator('#closeSettings').click();
  assert.ok(await isLibrary(), 'changing preference does not navigate immediately');
  await reload(); await page.waitForFunction(() => document.body.classList.contains('reading') && window.__viewer?.pdf);
  assert.equal(await page.evaluate(() => window.__state.doc.docId), paper.docId);
  console.log('PASS settings persist resume-reading preference and restore the saved PDF');
  await page.locator('#settingsBtn').click(); await page.locator('#settingsNavBehavior').click();
  await page.select('#startupPage', 'agent'); await page.locator('#closeSettings').click();
  await reload(); await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  assert.equal(await page.evaluate(() => window.__viewer?.pdf == null), true);
  console.log('PASS agent startup opens its landing without loading a PDF');
  await page.goto(base + '/?topbar=static&document=' + encodeURIComponent(paper.docId), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('reading') && window.__viewer?.pdf);
  assert.equal(await page.evaluate(() => window.__state.doc.docId), paper.docId);
  console.log('PASS explicit document links override startup preference');
  await page.evaluate(() => {
    localStorage.setItem('reader.startupPage', 'resume');
    localStorage.setItem('reader.workspace.v1', JSON.stringify({ tabs: [], active: '' }));
  });
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('reading') && window.__viewer?.pdf);
  assert.equal(await page.evaluate(() => window.__state.doc.docId), paper.docId);
  console.log('PASS resume can use last reading record when no tabs are saved');
  await page.evaluate(() => localStorage.setItem('reader.startupPage', 'invalid'));
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 1);
  assert.ok(await isLibrary());
  await page.locator('#settingsBtn').click(); await page.locator('#settingsNavBehavior').click();
  await page.screenshot({ path: path.join(scratch, 'startup-settings.png') });
  assert.equal(await page.$eval('#startupPage', n => n.value), 'library');
  assert.deepEqual(errors, []);
  console.log('PASS invalid preference defaults to Library; ' + (desktop ? 'desktop' : 'Node') + '; ' + scratch);

} finally { await browser?.close(); await stopChild(reader); }
