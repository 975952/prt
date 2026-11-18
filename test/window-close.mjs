/** Bounded close handshake and progress-lock cancellation; isolated browser/IndexedDB.
 * node test/window-close.mjs
 * No reader instance, user data, model, native window or external URL is accessed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX } from './_env.mjs';

const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
assert.ok(executablePath);
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'window-close-'));
const checks = [], errors = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
let holdStateRead = false, heldStateReads = 0, abortedStateReads = 0, stateReads = 0;
let savedState = { docs: {} }, browser;
const publicRoot = path.join(ROOT, 'public');
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/state') {
    if (req.method === 'GET') {
      stateReads++;
      if (holdStateRead) { heldStateReads++; res.on('close', () => abortedStateReads++); return; }
    } else {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      savedState = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(savedState)); return;
  }
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><button id="homeBtn">Home</button><textarea id="draft"></textarea>'); return;
  }
  const file = path.resolve(publicRoot, `.${pathname}`);
  if (!file.startsWith(publicRoot + path.sep) || !file.endsWith('.js') || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(fs.readFileSync(file));
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async condition => {
  for (let attempt = 0; attempt < 150; attempt++) { if (await condition()) return; await wait(20); }
  throw new Error('Condition did not settle');
};
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => new URL(request.url()).origin === base ? request.continue() : request.abort());
  await page.evaluateOnNewDocument(() => {
    window.__PRT_WINDOW_ID = 'main';
    const nativeSetTimeout = window.setTimeout.bind(window);
    // Exercise the real production deadline without a 30-second test delay.
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 30000 ? 120 : delay, ...args);
    window.__closeTest = { ipc: [], notices: [], calls: [], holds: {}, mode: 'save', failCommit: false };
    window.ipc = { postMessage(raw) {
      const message = JSON.parse(raw), test = window.__closeTest;
      if (message.type === 'close-commit' && test.failCommit) throw new Error('Synthetic IPC delivery failure');
      test.ipc.push(message);
    } };
  });
  await page.goto(base);
  await page.evaluate(async () => {
    const test = window.__closeTest;
    const windows = await import('/js/windows.js');
    const { createDraftPersistence } = await import('/js/draft-persistence.js');
    const drafts = createDraftPersistence({ windowId: 'close-test' });
    const owner = { docId: 'synthetic-document', mode: 'chat' };
    test.read = () => drafts.load(owner);
    test.closed = windows.isWindowClosed;
    test.save = async text => { document.querySelector('#draft').value = text; await drafts.save(owner, { text, attachments: [] }); };
    windows.startWindows({
      close: async ({ signal }) => {
        const index = test.calls.length, mode = test.mode;
        test.calls.push({ mode, signal });
        if (mode === 'hold') { await new Promise(resolve => { test.holds[index] = resolve; }); return; }
        if (mode === 'fail') throw new Error('Synthetic save failure');
        await drafts.save(owner, { text: document.querySelector('#draft').value, attachments: [] });
        await drafts.flush();
      },
      notify: message => test.notices.push(message),
    });
    await test.save('Previously durable draft');
  });
  const request = id => page.evaluate(request => window.dispatchEvent(new CustomEvent('prt-desktop', { detail: { type: 'close-request', request } })), id);
  const outcome = (request, type) => page.waitForFunction(({ request, type }) => window.__closeTest.ipc.some(message => message.request === request && message.type === type), {}, { request, type });
  const snapshot = () => page.evaluate(async () => ({ ipc: window.__closeTest.ipc, notices: window.__closeTest.notices,
    calls: window.__closeTest.calls.length, closed: window.__closeTest.closed(), text: document.querySelector('#draft').value,
    durable: (await window.__closeTest.read()).text }));

  await page.evaluate(() => { window.__closeTest.mode = 'hold'; document.querySelector('#draft').value = 'Uncommitted text remains editable'; });
  await request(1); await request(1); await outcome(1, 'close-cancel');
  let state = await snapshot();
  assert.equal(state.calls, 1); assert.equal(state.closed, false);
  assert.equal(state.text, 'Uncommitted text remains editable'); assert.equal(state.durable, 'Previously durable draft');
  assert.ok(state.notices.length); assert.ok(await page.evaluate(() => window.__closeTest.calls[0].signal.aborted));
  pass('a hanging save is cancelled within the close deadline without discarding the draft or duplicating attempts');
  await page.evaluate(() => { window.__closeTest.mode = 'save'; document.querySelector('#draft').value = 'New text entered after timeout'; });
  await request(2); await outcome(2, 'close-commit');
  await page.evaluate(() => window.__closeTest.holds[0]());
  await wait(30); state = await snapshot();
  assert.equal(state.durable, 'New text entered after timeout');
  assert.deepEqual(state.ipc.filter(message => message.type === 'close-commit').map(message => message.request), [2]);
  pass('retry persists later edits and a timed-out save cannot send a late close commit');

  await page.evaluate(() => { window.__closeTest.mode = 'hold'; }); await request(3);
  await page.waitForFunction(() => !!window.__closeTest.holds[2]);
  await page.evaluate(() => { window.__closeTest.mode = 'save'; document.querySelector('#draft').value = 'Superseding request draft'; });
  await request(4); await outcome(4, 'close-commit');
  await page.evaluate(() => window.__closeTest.holds[2]()); await wait(30);
  state = await snapshot(); assert.equal(state.durable, 'Superseding request draft');
  assert.ok(!state.ipc.some(message => message.request === 3));
  pass('a fresh native request supersedes an unacknowledged attempt and ignores its late completion');

  await page.evaluate(() => { window.__closeTest.mode = 'fail'; document.querySelector('#draft').value = 'Recoverable failed save'; });
  await request(5); await outcome(5, 'close-cancel');
  state = await snapshot(); assert.equal(state.closed, false); assert.equal(state.text, 'Recoverable failed save');
  await page.evaluate(() => { window.__closeTest.mode = 'save'; }); await request(6); await outcome(6, 'close-commit');
  assert.equal((await snapshot()).durable, 'Recoverable failed save');
  pass('a rejected save leaves the window usable and a subsequent close saves the retained draft');
  await page.evaluate(() => { window.__closeTest.failCommit = true; }); await request(7); await outcome(7, 'close-cancel');
  assert.equal((await snapshot()).closed, false);
  await page.evaluate(() => { window.__closeTest.failCommit = false; }); await request(8); await outcome(8, 'close-commit');
  pass('IPC delivery failure restores the open state and permits closing again');

  holdStateRead = true;
  await page.evaluate(() => {
    const test = window.__closeTest; test.progressAbort = new AbortController();
    test.progressResult = null;
    fetch('/api/state', { method: 'POST', body: JSON.stringify({ docs: {}, marker: 'aborted-read' }), signal: test.progressAbort.signal })
      .then(() => { test.progressResult = 'resolved'; }, error => { test.progressResult = error.name; });
  });
  await until(() => heldStateReads > 0);
  await page.evaluate(() => window.__closeTest.progressAbort.abort());
  await page.waitForFunction(() => window.__closeTest.progressResult === 'AbortError');
  await until(() => abortedStateReads > 0); holdStateRead = false;
  await page.evaluate(() => fetch('/api/state', { method: 'POST', body: JSON.stringify({ docs: {}, marker: 'after-abort' }) }));
  assert.equal(savedState.marker, 'after-abort');
  pass('cancelling a progress save aborts its internal GET and releases the cross-window lock');

  await page.evaluate(() => {
    const test = window.__closeTest;
    navigator.locks.request('prt.save.progress', () => new Promise(resolve => { test.releaseLock = resolve; }));
  });
  await page.waitForFunction(() => !!window.__closeTest.releaseLock);
  const readsBefore = stateReads;
  await page.evaluate(() => {
    const test = window.__closeTest; test.progressAbort = new AbortController(); test.progressResult = null;
    fetch('/api/state', { method: 'POST', body: JSON.stringify({ docs: {}, marker: 'cancelled-queued-save' }), signal: test.progressAbort.signal })
      .then(() => { test.progressResult = 'resolved'; }, error => { test.progressResult = error.name; });
    test.progressAbort.abort();
  });
  await page.waitForFunction(() => window.__closeTest.progressResult === 'AbortError');
  await page.evaluate(() => window.__closeTest.releaseLock());
  await wait(30); assert.equal(stateReads, readsBefore); assert.equal(savedState.marker, 'after-abort');
  pass('a cancelled queued progress save never acquires the lock or writes a stale snapshot later');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors, final: await snapshot() }, null, 2), 'utf8');
  console.log(`Window close: ${checks.length}/${checks.length} passed; ${scratch}`);
} finally {
  await browser?.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
}
