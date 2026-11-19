/** Replacement and settings rollback against isolated real servers. No models. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';
const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `organizer-history-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
const original = ['Old/One/a.pdf', 'Old/Two/b.pdf'];
for (const relative of original) {
  fs.mkdirSync(path.dirname(path.join(papers, relative)), { recursive: true });
  writeTitlePdf(path.join(papers, relative), { title: `Synthetic rollback ${relative}` });
}
fs.mkdirSync(path.join(papers, 'Empty')); fs.mkdirSync(path.join(papers, 'Keep'));
fs.writeFileSync(path.join(papers, 'Keep/note.txt'), 'KEEP');
const digest = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(papers, relative))).digest('hex');
const hashes = original.map(digest), exists = relative => fs.existsSync(path.join(papers, relative));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser, page, base; const checks = [], errors = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
async function json(route, body) {
  const response = await fetch(base + route, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }); return { status: response.status, value: await response.json() };
}
async function organize() {
  await page.locator('#homeOrganize').click();
  await page.waitForFunction(() => document.querySelector('#paperOrganizer')?.open && document.querySelector('#paperOrganizer').getAttribute('aria-busy') === 'false');
  await page.$$eval('#paperOrganizerList .po-target input', nodes => nodes.forEach(node => {
    node.value = 'Unified'; node.dispatchEvent(new Event('input', { bubbles: true }));
  }));
  await page.locator('#paperOrganizerApply').click();
  await page.waitForFunction(() => document.querySelector('#paperOrganizer').getAttribute('aria-busy') === 'false'
    && document.querySelector('#paperOrganizer .po-status').textContent.includes('旧空分类已清理'));
  await page.locator('#paperOrganizer .po-actions > button:first-child').click();
}
async function settings() {
  await page.locator('#settingsBtn').click(); await page.locator('#settingsNavLibrary').click();
  await page.waitForFunction(() => !document.querySelector('#organizerRollback').disabled);
}
async function rollback(conflicts) {
  await page.locator('#organizerRollback').click();
  await page.waitForSelector('.sess-confirm-mask:not(.hidden)');
  await page.locator('.sess-confirm-acts button:last-child').click();
  await page.waitForFunction(count => document.querySelector('#organizerHistoryStatus').textContent.includes(`${count} 项冲突`), {}, conflicts);
}
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', PRT_QUIET_TOKEN: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('organizer-history').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready); assert.equal(path.resolve((await json('/api/papers')).value.dir), papers);
  for (const asset of ['app.js', 'organizer-history.js', 'paper-organizer.js']) assert.equal(await fetch(`${base}/js/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public/js', asset), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1280, height: 900 } });
  page = await browser.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== base || ['/api/chat', '/api/web-search'].includes(url.pathname)) {
      errors.push('Unexpected model/external request'); return request.abort();
    }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('reader.locale', 'zh-CN'); localStorage.setItem('reader.session.aiTitle', '0'); });
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.papers.length === 2);
  await organize();
  assert.ok(!exists('Old')); assert.ok(!exists('Empty')); assert.equal(fs.readFileSync(path.join(papers, 'Keep/note.txt'), 'utf8'), 'KEEP');
  assert.deepEqual(['Unified/a.pdf', 'Unified/b.pdf'].map(digest), hashes);
  pass('applying classification replaces old empty category trees and preserves all PDF bytes and non-PDF files');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.__state?.papers.length === 2);
  await settings(); await rollback(0);
  assert.deepEqual(original.map(digest), hashes); assert.ok(exists('Empty')); assert.ok(!exists('Unified'));
  assert.equal((await json('/api/organizer-history')).value.records[0].status, 'restored');
  await page.screenshot({ path: path.join(scratch, 'settings-rollback.png') });
  pass('after reload, Settings restores original paths and empty directories and removes new empty categories');
  await page.locator('#closeSettings').click(); await organize();
  fs.mkdirSync(path.join(papers, 'Old/One'), { recursive: true }); fs.writeFileSync(path.join(papers, original[0]), 'CONFLICT');
  await settings(); await rollback(1);
  assert.equal(fs.readFileSync(path.join(papers, original[0]), 'utf8'), 'CONFLICT'); assert.ok(exists('Unified/a.pdf')); assert.equal(digest(original[1]), hashes[1]);
  fs.unlinkSync(path.join(papers, original[0])); await rollback(0); assert.deepEqual(original.map(digest), hashes);
  pass('rollback reports conflicts without overwriting, restores other papers, and retries remaining entries');
  const history = (await json('/api/organizer-history')).value;
  assert.equal((await json('/api/organizer-history', history)).status, 200);
  assert.equal((await json('/api/organizer-history', history)).status, 409);
  const fresh = (await json('/api/organizer-history')).value;
  const invalid = structuredClone(fresh); invalid.records[0].entries[0].from = '../escape.pdf';
  assert.equal((await json('/api/organizer-history', invalid)).status, 400);
  assert.deepEqual((await json('/api/organizer-history')).value, fresh);
  pass('persistent journal rejects stale revisions and unsafe paths without changing prior history');
  fs.writeFileSync(path.join(data, 'organizer-history.json'), '{broken');
  assert.equal((await json('/api/organizer-history')).status, 500); assert.equal((await json('/api/organizer-history', fresh)).status, 500);
  assert.equal(fs.readFileSync(path.join(data, 'organizer-history.json'), 'utf8'), '{broken');
  pass('a damaged history is preserved and blocks changes instead of silently resetting rollback records');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, errors }, null, 2));
  console.log(`${checks.length}/${checks.length} passed. Evidence: ${scratch}`);
} finally { await browser?.close(); await stopChild(reader); }
