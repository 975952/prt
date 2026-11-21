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
localStorage.setItem('reader.locale', 'zh-CN');
const { SessionMemoryManager } = await import('/js/session-memory.js');
const { SessionMemoryPanel } = await import('/js/session-memory-ui.js');
const { profileStore } = await import('/js/profile.js');
const manager = new SessionMemoryManager();
window.profileStore = profileStore;
await profileStore.load();
window.memoryChanges = [];
manager.onChange(change => window.memoryChanges.push(change.action));
window.panel = new SessionMemoryPanel(manager, { profileStore });
window.panel.init(document.querySelector('#sessMemBtn'));
window.panel.setSession('fixture-sid');
window.ready = true;
</script></body></html>`;
let profile = { version: 1, revision: 0, updatedAt: '', selfReport: '', selfReportAt: '', items: [] };
let failNextWrite = false;
let failNextRead = false;
let holdNextRead = false;
let heldRead = null;
let holdNextWriteAck = false;
let heldWriteAck = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/profile') {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        if (failNextWrite) { failNextWrite = false; res.writeHead(503); res.end('{}'); return; }
        if (Number(req.headers['if-match']) !== profile.revision) { res.writeHead(409); res.end('{}'); return; }
        profile = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (holdNextWriteAck) {
          holdNextWriteAck = false;
          heldWriteAck = () => { res.end('{}'); heldWriteAck = null; };
        } else res.end('{}');
      });
    } else if (failNextRead) {
      failNextRead = false; res.writeHead(503); res.end('{}');
    } else if (holdNextRead) {
      holdNextRead = false;
      const snapshot = JSON.stringify(profile);
      heldRead = () => { res.end(snapshot); heldRead = null; };
    } else res.end(JSON.stringify(profile));
    return;
  }
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

  const item = (id, kind, scope, docId, level, boundary = '') => ({
    id, topic: id === 'identity' ? '称呼' : id, aliases: [], level, boundary,
    status: 'confirmed', basis: 'user_self_report', note: '',
    createdAt: '2026-11-21T10:18:54+08:00', updatedAt: '2026-11-21T10:18:54+08:00',
    source: { docId, paper: '', capability: 'chat' },
    memory: { kind, scope, signal: 'self_report', evidence: id === 'identity' ? '记下来，我叫Cyan' : level },
  });
  profile = { ...profile, revision: 1, items: [
    item('identity', 'identity', 'global', '', '称呼：Cyan', 'Keep this exact boundary'),
    item('paper-a', 'knowledge', 'paper', 'doc-a', 'Only paper A'),
    item('paper-b', 'knowledge', 'paper', 'doc-b', 'Only paper B'),
  ] };
  await page.evaluate(async () => { await window.profileStore.load(); });
  assert.equal(await page.$eval('#sessMemBtn', node => node.dataset.count), '1', 'saved identity appears through the profile subscription');
  assert.equal(await page.$eval('.memory-item-content', node => node.textContent), '称呼：Cyan');
  assert.equal(await page.$eval('.memory-scope', node => node.textContent), '全局');
  assert.equal(await page.evaluate(() => window.panel.sessionMemory.getMemories('fixture-sid').length), 0,
    'profile records are never duplicated into session storage');
  await page.evaluate(() => window.panel.setSession('fixture-sid', { docId: 'doc-a' }));
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 2);
  assert.match(await page.$eval('.memory-list', node => node.textContent), /Only paper A/);
  assert.doesNotMatch(await page.$eval('.memory-list', node => node.textContent), /Only paper B/);
  await page.select('.memory-category-filter', 'identity');
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 1);
  await page.type('.memory-search-input', 'Cyan');
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 1);
  await page.$eval('.memory-search-input', node => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); });

  failNextWrite = true;
  await page.click('.memory-edit-btn');
  assert.equal(await page.$eval('.memory-add-category', node => node.hidden), true);
  await page.$eval('.memory-add-input', node => { node.value = '称呼：Sky'; });
  await page.click('.memory-add-btn');
  await page.waitForSelector('.memory-save-status[data-status="error"]');
  assert.equal(await page.$eval('.memory-add-input', node => node.value), '称呼：Sky', 'failed edit keeps the draft');
  assert.equal(profile.items[0].level, '称呼：Cyan', 'failed edit does not change stored data');
  assert.equal(await page.$eval('.memory-item-content', node => node.textContent), '称呼：Cyan', 'failed edit does not pretend success');
  await page.click('.memory-retry-btn');
  await page.waitForFunction(() => window.profileStore.data.items[0].level === '称呼：Sky' && !window.panel.profileWrite);
  assert.equal(profile.items[0].level, '称呼：Sky');
  assert.equal(profile.items[0].boundary, 'Keep this exact boundary');
  assert.equal(profile.items[0].memory.evidence, '记下来，我叫Cyan');
  assert.equal(profile.items[0].memory.kind, 'identity');
  assert.equal(profile.items[0].memory.scope, 'global');

  holdNextRead = true;
  await page.evaluate(() => { window.olderLoad = window.profileStore.load(); });
  for (let i = 0; !heldRead && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(heldRead, 'an older profile read is in flight');
  await page.click('.memory-edit-btn');
  await page.$eval('.memory-add-input', node => { node.value = '称呼：Cyan'; });
  await page.click('.memory-add-btn');
  await page.waitForFunction(() => window.profileStore.data.items[0].level === '称呼：Cyan' && !window.panel.profileWrite);
  heldRead();
  await page.evaluate(() => window.olderLoad);
  assert.equal(await page.$eval('.memory-item-content', node => node.textContent), '称呼：Cyan', 'late load cannot overwrite a committed edit');
  failNextRead = true;
  await page.evaluate(() => window.profileStore.load());
  assert.equal(await page.evaluate(() => window.profileStore.data.items[0].level), '称呼：Cyan',
    'failed reads preserve the last known saved profile');
  assert.equal(await page.$eval('.memory-item-content', node => node.textContent), '称呼：Cyan');

  failNextWrite = true;
  await page.click('.memory-delete-btn');
  await page.waitForSelector('.memory-save-status[data-status="error"]');
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 1, 'failed delete keeps the visible card');
  assert(profile.items.some(item => item.id === 'identity'));
  await page.click('.memory-retry-btn');
  await page.waitForFunction(() => !window.profileStore.data.items.some(item => item.id === 'identity') && !window.panel.profileWrite);
  assert(!profile.items.some(item => item.id === 'identity'));
  await page.evaluate(() => window.profileStore.load());
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 0, 'deleted profile memory stays deleted on reload');
  assert.equal(await page.$eval('#sessMemBtn', node => node.dataset.count), '1', 'badge counts visible scope, independently of search/category filters');
  await page.evaluate(() => window.panel.setSession('other-session', { docId: 'doc-b' }));
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 1);
  assert.equal(await page.$eval('.memory-item-content', node => node.textContent), 'Only paper B');
  assert.equal(await page.evaluate(() => window.profileStore.memoryEditRevision), 5,
    'manual edit and delete attempts invalidate stale background extraction even after failure');

  holdNextWriteAck = true;
  await page.click('.memory-edit-btn');
  await page.$eval('.memory-add-input', node => { node.value = 'Edited before another window deletes it'; });
  await page.click('.memory-add-btn');
  for (let i = 0; !heldWriteAck && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(heldWriteAck, 'the edit is saved while its successful POST response is delayed');
  assert.equal(profile.items.find(item => item.id === 'paper-b').level, 'Edited before another window deletes it');
  const revisionBeforeDelete = profile.revision;
  const remoteDelete = await fetch(`http://127.0.0.1:${server.address().port}/api/profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': String(revisionBeforeDelete) },
    body: JSON.stringify({ ...profile, revision: revisionBeforeDelete + 1,
      items: profile.items.filter(item => item.id !== 'paper-b') }),
  });
  assert.equal(remoteDelete.status, 200, 'another window deletes the saved item at a newer revision');
  await page.evaluate(() => window.profileStore.load());
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 0);
  heldWriteAck();
  await page.waitForFunction(() => !window.panel.profileWrite);
  assert.equal(await page.evaluate(() => window.profileStore.data.revision), revisionBeforeDelete + 1,
    'an old successful POST response cannot roll back a newer loaded revision');
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 0,
    'the delayed edit acknowledgement cannot resurrect an item deleted in another window');
  assert.equal(await page.$eval('#sessMemBtn', node => node.dataset.count), '0');
  await page.setViewport({ width: 390, height: 844 });
  const panelRect = await page.$eval('#sessionMemoryPanel', node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, display: getComputedStyle(node).display };
  });
  assert(panelRect.left >= 0 && panelRect.right <= 390 && panelRect.width <= 374);
  assert.equal(panelRect.display, 'flex');
  assert.deepEqual(errors, []);
  console.log('PASS memory UI: session CRUD, saved profile visibility, scope/filter/count, profile edit/delete retry, late read/commit protection, safe rendering, and mobile bounds');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
