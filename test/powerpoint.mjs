/** Windows + PowerPoint integration: node test/powerpoint.mjs [--desktop]. All writes are isolated. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

if (process.platform !== 'win32') throw new Error('Requires Windows and PowerPoint');
const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `ppt-${desktop ? 'desktop' : 'node'}-`));
const papers = path.join(scratch, 'papers'), data = assertIsolatedDataDir(path.join(scratch, 'data'));
fs.mkdirSync(papers); fs.mkdirSync(data);
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(ROOT, 'test/powerpoint-fixture.ps1'), '-Directory', scratch], { windowsHide: true, timeout: 60000 });
const pptx = fs.readFileSync(path.join(scratch, 'fixture.pptx'));
const ppt = fs.readFileSync(path.join(scratch, 'fixture.ppt'));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('ppt').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  const upload = async (name, body, folder = '') => {
    const r = await fetch(`${base}/api/upload?${new URLSearchParams({ name, folder })}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
      signal: AbortSignal.timeout(135000),
    });
    return { status: r.status, json: await r.json() };
  };
  assert.equal((await upload('fake.pptx', Buffer.from('not a presentation'))).status, 400);
  assert.equal((await upload('empty.ppt', Buffer.alloc(0))).status, 400);
  assert.equal((await upload('bad-folder.pptx', pptx, '../outside')).status, 400);
  assert.deepEqual(fs.readdirSync(papers), [], 'invalid requests leave no output');
  const first = await upload('中文 演示.PPTX', pptx);
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.json.name, '中文 演示.pdf');
  const originalPdf = fs.readFileSync(path.join(papers, first.json.name));
  assert.ok(originalPdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
  const second = await upload('中文 演示.PPTX', pptx);
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.equal(second.json.name, '中文 演示 (2).pdf');
  assert.deepEqual(fs.readFileSync(path.join(papers, first.json.name)), originalPdf, 'existing PDF is preserved');
  fs.mkdirSync(path.join(papers, '课程'));
  const legacy = await upload('legacy.ppt', ppt, '课程');
  assert.equal(legacy.status, 200, JSON.stringify(legacy));
  assert.equal(legacy.json.path, '课程/legacy.pdf');
  assert.equal((await upload('regular.pdf', originalPdf)).status, 200, 'PDF uploads still work');
  console.log('PASS API: PPTX, legacy PPT, Chinese names, destination folder, collisions, invalid input, ordinary PDF');

  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1350, height: 880 } });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  await page.goto(base, { waitUntil: 'networkidle0' });
  assert.match(await page.$eval('#fileInput', el => el.accept), /\.pptx/);
  await (await page.$('#fileInput')).uploadFile(path.join(scratch, 'fixture.pptx'));
  await page.waitForFunction(() => window.__viewer?.numPages === 2 && window.__state?.doc?.name === 'fixture.pdf', { timeout: 135000 });
  const text = await page.evaluate(async () => {
    const pdf = window.__viewer.pdf;
    return (await (await pdf.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
  });
  assert.match(text, /PRT conversion fixture/);
  console.log('PASS UI: converted file opens with two readable pages');
  fs.writeFileSync(path.join(scratch, 'broken.pptx'), 'invalid data');
  const rejected = page.waitForResponse(r => r.url().includes('/api/upload?') && r.url().includes('broken.pptx'));
  await (await page.$('#fileInput')).uploadFile(path.join(scratch, 'broken.pptx'));
  assert.equal((await rejected).status(), 400);
  await page.waitForFunction(() => document.body.innerText.includes('这不是有效的 PPT/PPTX 文件'), { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.__state.doc.name), 'fixture.pdf', 'failed PPT never opens as a PDF blob');
  console.log('PASS UI: invalid PPT returns 400 and preserves current reader');
  fs.copyFileSync(path.join(scratch, 'fixture.ppt'), path.join(scratch, 'batch.ppt'));
  fs.writeFileSync(path.join(scratch, 'batch-pdf.pdf'), originalPdf);
  await (await page.$('#fileInput')).uploadFile(path.join(scratch, 'batch.ppt'), path.join(scratch, 'batch-pdf.pdf'));
  await page.waitForFunction(() => window.__state?.papers?.some(p => p.name === 'batch.pdf')
    && window.__state?.papers?.some(p => p.name === 'batch-pdf.pdf'), { timeout: 135000 });
  console.log('PASS UI: mixed PPT/PDF batch');
  await page.evaluate(encoded => {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const file = new File([bytes], 'folder-slides.pptx');
    const leaf = { isFile: true, name: file.name, file: callback => callback(file) };
    const directory = { isDirectory: true, name: '拖入课程', createReader() {
      let read = false;
      return { readEntries(callback) { const entries = read ? [] : [leaf]; read = true; callback(entries); } };
    } };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], items: [{ kind: 'file', webkitGetAsEntry: () => directory }] } });
    document.querySelector('#dropzone').dispatchEvent(event);
  }, pptx.toString('base64'));
  await page.waitForFunction(() => window.__state?.papers?.some(p => p.path === '拖入课程/folder-slides.pdf'), { timeout: 135000 });
  assert.equal((await fetch(`${base}/api/health`)).status, 200, 'test backend remains alive');
  await page.screenshot({ path: path.join(scratch, 'import-result.png') });
  assert.deepEqual(errors, []);
  assert.deepEqual(fs.readFileSync(path.join(scratch, 'fixture.pptx')), pptx, 'source is unchanged');
  assert.deepEqual(fs.readFileSync(path.join(scratch, 'fixture.ppt')), ppt, 'legacy source is unchanged');
  console.log(`PASS UI: picker, two-page rendering, invalid input returns 400, mixed batch, folder drop, failure preserves reader. ${scratch}`);
} finally {
  if (browser) await browser.close();
  await stopChild(reader);
}
