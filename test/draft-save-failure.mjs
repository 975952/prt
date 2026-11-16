/** Isolated draft-storage failure checks. node test/draft-save-failure.mjs
 * Real IndexedDB, synthetic storage faults and IPC recording; no native window is closed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stopChild } from './_exe.mjs';

const CHROME = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((file) => file && fs.existsSync(file));
assert.ok(CHROME, 'Chrome or Edge is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'draft-save-failure-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'draft-failure.pdf'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const requests = [];
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '草稿存储故障不影响这次问答。' } }] })}\n\ndata: [DONE]\n\n`);
  } catch { if (!res.destroyed) res.destroy(); }
});

function installStorageFaults() {
  const faults = window.__draftFaults = {
    open: sessionStorage.getItem('test.draft.open-failure') === '1', put: false, abort: false,
    openFailures: 0, putFailures: 0, abortFailures: 0, events: [], ipc: [],
  };
  const databaseName = 'prt-composer-drafts-v1';
  const open = IDBFactory.prototype.open;
  window.__draftNativeOpen = (...args) => open.apply(indexedDB, args);
  IDBFactory.prototype.open = function (...args) {
    if (args[0] === databaseName && faults.open) {
      faults.openFailures++;
      throw new DOMException('Synthetic draft database open failure', 'SecurityError');
    }
    return open.apply(this, args);
  };
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = transaction.apply(this, args);
    if (this.name === databaseName && args[1] === 'readwrite') {
      tx.addEventListener('complete', () => faults.events.push({ type: 'transaction-complete' }));
      tx.addEventListener('abort', () => faults.events.push({ type: 'transaction-abort' }));
    }
    return tx;
  };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.transaction.db.name !== databaseName) return put.apply(this, args);
    if (faults.put) {
      faults.putFailures++;
      throw new DOMException('Synthetic draft quota failure', 'QuotaExceededError');
    }
    const request = put.apply(this, args);
    if (faults.abort) {
      const tx = this.transaction;
      faults.abortFailures++;
      queueMicrotask(() => tx.abort());
    }
    return request;
  };
  window.ipc = { postMessage(raw) {
    const message = JSON.parse(raw);
    faults.ipc.push(message);
    faults.events.push({ type: `ipc-${message.type}` });
  } };
}

let reader, browser, page;
let passed = 0;
const pageErrors = [], evidence = [];
const check = (name) => { passed++; console.log(`PASS ${name}`); };
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
      PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await wait(100);
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ }
  }
  assert.ok(ready, 'isolated service starts');
  const listing = await fetch(`${base}/api/papers`).then((response) => response.json());
  assert.equal(path.resolve(listing.dir), path.resolve(papers));
  const paper = listing.papers.find((item) => item.name === 'draft-failure.pdf');
  assert.ok(paper);
  const key = JSON.stringify(['main', paper.docId, 'chat']);
  assert.ok((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'draft-fault-mock', apiKey: 'SYNTHETIC_DRAFT_FAULT_KEY' }) })).ok);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser-profile'),
    defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.evaluateOnNewDocument(installStorageFaults);
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.session.onEnter', 'resume'));
  const readyPage = async () => {
    await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx
      && window.__state.viewerDocId === window.__state.doc?.docId);
    await page.evaluate(async () => {
      const sessions = await import('/js/sessions.js'); await sessions.sessionsOpenLatestForOutput();
      document.body.classList.remove('no-right');
      window.__ctx.setPanelVisible('chat', true); window.__ctx.applyPanels();
      window.__ctx.setAgentRead(false); window.__ctx.setScopeRange('current');
    });
  };
  await page.goto(`${base}/?open=draft-failure.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await readyPage();
  const setDraft = async (text) => {
    await page.click('#chatInput');
    await page.evaluate((text) => {
      const input = document.querySelector('#chatInput'); input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
  };
  const saved = () => page.waitForFunction(() => document.querySelector('#draftStorage')?.dataset.status === 'saved');
  const failed = () => page.waitForFunction(() => document.querySelector('#draftStorage')?.dataset.status === 'error');
  const flush = () => page.evaluate(() => window.__ctx.flushComposerDrafts());
  const stored = () => page.evaluate(async (key) => {
    const database = await new Promise((resolve, reject) => {
      const request = window.__draftNativeOpen('prt-composer-drafts-v1');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction('drafts', 'readonly').objectStore('drafts').get(key);
        request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  }, key);
  const beforeUnloadBlocked = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  const ipcClose = () => page.evaluate(() => {
    window.__draftFaults.ipc.length = 0;
    window.dispatchEvent(new CustomEvent('prt-desktop', { detail: { type: 'close-request' } }));
  });
  const faultSnapshot = () => page.evaluate(() => ({
    text: document.querySelector('#chatInput').value,
    status: document.querySelector('#draftStorage').dataset.status,
    message: document.querySelector('#draftStorageText').textContent,
    faults: window.__draftFaults,
  }));

  await saved();
  await setDraft('Previously committed draft'); await flush(); await saved();
  assert.equal((await stored()).text, 'Previously committed draft');
  check('baseline draft commits to the isolated real IndexedDB');

  await page.evaluate(() => { window.__draftFaults.put = true; });
  await setDraft('New draft retained during quota failure'); await failed();
  assert.equal((await stored()).text, 'Previously committed draft');
  assert.equal(await page.$eval('#chatInput', (input) => input.value), 'New draft retained during quota failure');
  assert.equal(await page.$eval('#draftStorageRetry', (button) => button.classList.contains('hidden')), false);
  assert.equal(await beforeUnloadBlocked(), true, 'dirty draft prevents silent unload');
  assert.equal(await page.evaluate(async () => {
    try { await window.__ctx.flushComposerDrafts(); return 'resolved'; } catch { return 'rejected'; }
  }), 'rejected');
  const previousRightWidth = await page.evaluate(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--right-w');
    root.style.setProperty('--right-w', '300px');
    return previous;
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const narrowLayout = await page.evaluate(() => {
    const panel = document.querySelector('#rightSide');
    const row = document.querySelector('#draftStorage');
    const message = document.querySelector('#draftStorageText');
    const retry = document.querySelector('#draftStorageRetry');
    const rect = (element) => {
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    return { panel: rect(panel), row: rect(row), message: rect(message), retry: rect(retry),
      rowOverflow: row.scrollWidth > row.clientWidth + 1,
      messageOverflow: message.scrollWidth > message.clientWidth + 1,
      visible: [row, message, retry].every((element) => element.getBoundingClientRect().height > 0
        && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none') };
  });
  assert.ok(Math.abs(narrowLayout.panel.width - 300) <= 1, 'narrow sidebar is 300px wide');
  assert.equal(narrowLayout.visible, true, 'failure message and retry button remain visible');
  assert.equal(narrowLayout.rowOverflow || narrowLayout.messageOverflow, false, 'failure row does not overflow');
  assert.ok(narrowLayout.message.right <= narrowLayout.retry.x && narrowLayout.retry.right <= narrowLayout.panel.right
    && narrowLayout.row.x >= narrowLayout.panel.x && narrowLayout.row.bottom <= narrowLayout.panel.bottom,
  'failure message and retry button fit within the narrow sidebar without overlapping');
  const screenshot = path.join(scratch, 'quota-failure-narrow.png');
  await (await page.$('#rightSide')).screenshot({ path: screenshot });
  await page.evaluate((width) => {
    if (width) document.documentElement.style.setProperty('--right-w', width);
    else document.documentElement.style.removeProperty('--right-w');
  }, previousRightWidth);
  evidence.push({ case: 'quota-failure', ...(await faultSnapshot()), narrowLayout, screenshot });
  check('quota failure retains old disk record and new input, exposes retry and blocks unload');

  await ipcClose();
  await page.waitForFunction(() => window.__draftFaults.ipc.some((message) => message.type === 'close-cancel'));
  assert.equal(await page.evaluate(() => window.__draftFaults.ipc.some((message) => message.type === 'close-commit')), false);
  assert.equal(await page.$eval('#chatInput', (input) => input.value), 'New draft retained during quota failure');
  await page.evaluate(() => { window.__draftFaults.put = false; });
  await page.click('#draftStorageRetry'); await saved();
  assert.equal((await stored()).text, 'New draft retained during quota failure');
  assert.equal(await beforeUnloadBlocked(), false);
  evidence.push({ case: 'quota-retry', ...(await faultSnapshot()) });
  check('native close is cancelled on save failure and retry commits the retained draft');

  await page.evaluate(() => { window.__draftFaults.abort = true; });
  await setDraft('Draft retained after transaction abort'); await failed();
  assert.equal((await stored()).text, 'New draft retained during quota failure');
  assert.equal(await page.evaluate(() => window.__draftFaults.abortFailures > 0), true);
  await page.evaluate(() => { window.__draftFaults.abort = false; });
  await page.click('#draftStorageRetry'); await saved();
  assert.equal((await stored()).text, 'Draft retained after transaction abort');
  evidence.push({ case: 'transaction-abort-retry', ...(await faultSnapshot()) });
  check('transaction abort is atomic and its failed snapshot can be retried');

  await flush();
  await page.evaluate(() => sessionStorage.setItem('test.draft.open-failure', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await readyPage(); await failed();
  assert.equal(await page.$eval('#chatInput', (input) => input.value), '');
  assert.equal((await stored()).text, 'Draft retained after transaction abort');
  assert.equal(await page.evaluate(() => window.__draftFaults.openFailures > 0), true);
  assert.equal(await page.evaluate(() => window.__draftFaults.events.some((event) => event.type === 'transaction-complete')), false);
  check('failed initial read and empty rendering do not delete the saved record');

  await setDraft('Question while draft storage cannot open');
  assert.equal(await beforeUnloadBlocked(), true);
  const beforeRequests = requests.length;
  await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy && window.__state.sessionEntries.some((entry) => entry.text?.includes('草稿存储故障不影响这次问答。')));
  assert.equal(requests.length, beforeRequests + 1);
  assert.ok(requests.at(-1).messages.some((message) => String(message.content).includes('Question while draft storage cannot open')));
  assert.equal((await stored()).text, 'Draft retained after transaction abort');
  await setDraft('New input must win when storage read recovers');
  await page.evaluate(() => { window.__draftFaults.open = false; sessionStorage.removeItem('test.draft.open-failure'); });
  await page.click('#draftStorageRetry'); await saved();
  assert.equal(await page.$eval('#chatInput', (input) => input.value), 'New input must win when storage read recovers');
  assert.equal((await stored()).text, 'New input must win when storage read recovers');
  evidence.push({ case: 'open-failure-send-retry', ...(await faultSnapshot()) });
  check('storage read failure does not block asking, and retry preserves newly entered text');

  await page.evaluate(() => { window.__draftFaults.events.length = 0; });
  await setDraft('Last keystroke before native close');
  await ipcClose();
  await page.waitForFunction(() => window.__draftFaults.ipc.some((message) => message.type === 'close-commit'));
  assert.equal((await stored()).text, 'Last keystroke before native close');
  const order = await page.evaluate(() => window.__draftFaults.events.map((event) => event.type));
  assert.ok(order.indexOf('transaction-complete') >= 0 && order.indexOf('transaction-complete') < order.indexOf('ipc-close-commit'));
  assert.equal(await page.evaluate(() => window.__draftFaults.ipc.some((message) => message.type === 'close-cancel')), false);
  evidence.push({ case: 'native-close-commit', ...(await faultSnapshot()) });
  check('native close commits only after the final draft transaction completes');

  assert.deepEqual(pageErrors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ passed, pageErrors, requestCount: requests.length, evidence }, null, 2), 'utf8');
  console.log(`Draft save failure: ${passed}/${passed} passed; evidence: ${scratch}`);
} catch (error) {
  if (page && !page.isClosed()) {
    const snapshot = await page.evaluate(() => ({ url: location.href, text: document.querySelector('#chatInput')?.value,
      status: document.querySelector('#draftStorage')?.dataset.status, message: document.querySelector('#draftStorageText')?.textContent,
      faults: window.__draftFaults })).catch(() => null);
    fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: String(error.stack || error), pageErrors, snapshot, evidence }, null, 2), 'utf8');
  }
  console.error(`Draft save failure evidence: ${scratch}`);
  throw error;
} finally {
  if (browser) await browser.close();
  if (reader) await stopChild(reader);
  upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
}
