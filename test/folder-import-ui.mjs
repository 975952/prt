/** Exercise real drop handlers, nested uploads, and target rows with isolated data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'folder-drop-ui-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.mkdirSync(path.join(papers, 'Target'));
const pdf = fs.readFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'));
fs.writeFileSync(path.join(papers, 'Target/existing.pdf'), pdf);
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function until(fn, label) {
  for (let i = 0; i < 200; i++) {
    try { const value = await fn(); if (value) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timeout: ' + label);
}
const port = await freePort(), debugPort = await freePort(), base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
  PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1',
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` };
let child, browser, page;
const errors = [], uploads = [];
try {
  child = desktop ? spawnReader(stageExe('folder-drop').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, windowsHide: true, stdio: 'ignore' });
  await until(async () => (await fetch(base + '/api/health')).ok, 'service');
  if (desktop) {
    const ws = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl, 'WebView');
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    page = await until(async () => (await browser.pages()).find(p => p.url().startsWith(base)), 'reader page');
  } else {
    browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      headless: true, args: ['--no-sandbox'], userDataDir: path.join(scratch, 'browser') });
    page = await browser.newPage();
  }
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && (url.origin !== base || url.pathname === '/api/chat')) return request.abort();
    if (url.pathname === '/api/upload') uploads.push(url.searchParams.get('folder'));
    return request.continue();
  });
  if (!desktop) await page.goto(base);
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 1);
  if (desktop) assert.equal(await (await fetch(base + '/js/folder-import.js')).text(), fs.readFileSync(path.join(ROOT, 'public/js/folder-import.js'), 'utf8'));
  const listing = async () => (await (await fetch(base + '/api/papers')).json()).papers.map(row => row.path);
  async function drop(selector, name) {
    await page.evaluate(({ selector, name, bytes }) => {
      const file = label => {
        const f = new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], label, { type: 'application/pdf' });
        return { name: label, isFile: true, file: ok => queueMicrotask(() => ok(f)) };
      };
      const dir = (label, entries) => ({ name: label, isDirectory: true, createReader() {
        let offset = 0; return { readEntries(ok) { const batch = entries.slice(offset, offset + 1); offset++; queueMicrotask(() => ok(batch)); } };
      } });
      const tree = dir(name, [file('root.pdf'), dir('Nested', [dir('Deep', [file('leaf.pdf')])]),
        dir('Empty', []), dir('.private', [file('hidden.pdf')])]);
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [], getData: () => '',
        items: [{ kind: 'file', webkitGetAsEntry: () => tree }] } });
      const node = document.querySelector(selector); if (!node) throw new Error('Missing drop target: ' + selector);
      node.dispatchEvent(event);
    }, { selector, name, bytes: pdf.toString('base64') });
  }
  await drop('#homeFolders [data-folder-path="Target"] .home-nav-btn', 'Bundle');
  await until(async () => (await listing()).includes('Target/Bundle/Nested/Deep/leaf.pdf'), 'home folder drop');
  await drop('#homeFolders [data-folder-path="Target"] .home-nav-btn', 'Bundle');
  await until(async () => (await listing()).includes('Target/Bundle (2)/Nested/Deep/leaf.pdf'), 'collision-safe folder drop');
  console.log('PASS home folder row receives the complete tree; repeated names preserve the first import');
  const existing = (await (await fetch(base + '/api/papers')).json()).papers.find(row => row.path === 'Target/existing.pdf');
  await page.evaluate(paper => window.__ctx.openDoc(paper), existing);
  await page.waitForFunction(() => document.body.classList.contains('reading') && window.__viewer?.pdf);
  await drop('#fileList li.folder[data-path="Target"]', 'Sidebar');
  await until(async () => (await listing()).includes('Target/Sidebar/Nested/Deep/leaf.pdf'), 'sidebar folder drop');
  await drop('#fileList li[data-path="Target/existing.pdf"]', 'BesidePaper');
  await until(async () => (await listing()).includes('Target/BesidePaper/Nested/Deep/leaf.pdf'), 'sidebar paper drop');
  console.log('PASS sidebar folder and paper rows keep imports in the selected folder');
  const all = await listing();
  assert.equal(all.length, 9);
  assert.equal(uploads.length, 8, 'no duplicate event bubbling uploads');
  assert(uploads.every(folder => folder.startsWith('Target/')));
  assert.equal(fs.existsSync(path.join(papers, 'Target/Bundle/Empty')), false);
  assert.equal(fs.existsSync(path.join(papers, 'Target/Bundle/.private')), false);
  assert.deepEqual(fs.readFileSync(path.join(papers, 'Target/existing.pdf')), pdf);
  assert.deepEqual(errors, []);
  console.log(`PASS ${desktop ? 'native WebView' : 'browser'} recursive drop integration, pruning and original-file preservation`);
} finally {
  if (desktop) browser?.disconnect(); else await browser?.close();
  await stopChild(child);
}
