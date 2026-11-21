import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX } from './_env.mjs';

const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
assert.ok(executablePath, 'Chromium is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'session-memory-ui-'));
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/css/session-memory.css">
<style>body{display:block;padding:24px}#sessBar{display:flex;width:360px;height:34px}</style></head>
<body><div id="sessBar"><button id="sessMemBtn" type="button" aria-controls="sessionMemoryPanel" aria-expanded="false"></button></div>
<script type="module">
import { SessionMemoryManager } from '/js/session-memory.js';
import { SessionMemoryPanel } from '/js/session-memory-ui.js';
const manager = new SessionMemoryManager();
window.memoryChanges = [];
manager.onChange(change => window.memoryChanges.push(change.action));
window.panel = new SessionMemoryPanel(manager);
window.panel.init(document.querySelector('#sessMemBtn'));
window.panel.setSession('fixture-sid');
window.ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
  const publicDir = path.join(ROOT, 'public');
  const target = path.resolve(publicDir, `.${decodeURIComponent(url.pathname)}`);
  if (!target.startsWith(publicDir + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'text/javascript');
  res.end(fs.readFileSync(target));
});

let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await puppeteer.launch({ executablePath, headless: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1100, height: 800 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready);

  await page.click('#sessMemBtn');
  assert.equal(await page.$eval('#sessionMemoryPanel', node => node.classList.contains('hidden')), false);
  await page.type('.memory-add-input', 'Remember this result');
  await page.click('.memory-add-btn');
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 1);
  assert.equal(await page.$eval('#sessMemBtn', node => node.dataset.count), '1');

  await page.type('.memory-search-input', 'missing');
  assert.match(await page.$eval('.memory-empty', node => node.textContent), /没有找到/);
  await page.$eval('.memory-search-input', node => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('.memory-edit-btn');
  await page.$eval('.memory-add-input', node => { node.value = 'Edited result'; });
  await page.select('.memory-add-category', 'reference');
  await page.click('.memory-add-btn');
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 1, 'edit does not create an extra memory');
  assert.equal(await page.$eval('.memory-item-content', node => node.textContent), 'Edited result');
  assert.equal(await page.$eval('.memory-category-badge', node => node.textContent), '引用');

  await page.evaluate(() => {
    window.panel.sessionMemory.import('fixture-sid', [{ id: 'unsafe', content: '<img src=x onerror=alert(1)>', category: '<img>' }]);
    window.panel.render();
  });
  assert.equal(await page.$('.memory-item img'), null, 'untrusted memory text is never parsed as HTML');
  assert.equal(await page.$eval('.memory-item-content', node => node.textContent), '<img src=x onerror=alert(1)>');

  await page.evaluate(() => { window.confirm = () => true; });
  await page.click('.memory-delete-btn');
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 0);
  assert.equal(await page.$eval('#sessMemBtn', node => node.dataset.count), '0');
  await page.setViewport({ width: 390, height: 844 });
  const panelRect = await page.$eval('#sessionMemoryPanel', node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, display: getComputedStyle(node).display };
  });
  assert(panelRect.left >= 0 && panelRect.right <= 390 && panelRect.width <= 374);
  assert.equal(panelRect.display, 'flex');
  assert.deepEqual(errors, []);
  console.log('PASS session memory UI: open, add, search, edit, safe rendering, delete, and mobile bounds');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
