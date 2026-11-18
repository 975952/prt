/** Isolated retry/draft races. node test/retry-draft-safety.mjs
 * Real IndexedDB and attachment HTTP, private profile/data, synthetic model only.
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'retry-draft-safety-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'retry-draft.pdf'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const requests = [], evidence = [], pageErrors = [];
let rejectAnswer = true, passed = 0;
const check = (name) => { passed++; console.log(`PASS ${name}`); };
const imagesOf = (body) => (body.messages || []).flatMap((message) => Array.isArray(message.content)
  ? message.content.filter((part) => part.type === 'image_url').map((part) => part.image_url?.url) : []);
const textOf = (body) => (body.messages || []).map((message) => typeof message.content === 'string'
  ? message.content : (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')).join('\n');
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    requests.push(body);
    if (rejectAnswer) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic request rejected for retry testing.' } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '截图重试已完成。' } }] })}\n\ndata: [DONE]\n\n`);
  } catch { if (!res.destroyed) res.destroy(); }
});

// Keep native read data and transaction ordering; delay their delivery to the app.
function installReadGate(docId) {
  const gate = window.__retryReadGate = {
    enabled: sessionStorage.getItem('test.retry.hold-read') === '1', held: 0, released: 0, callbacks: [],
  };
  sessionStorage.removeItem('test.retry.hold-read');
  const heldTransactions = new WeakSet();
  gate.release = () => {
    gate.enabled = false;
    for (const callback of gate.callbacks.splice(0)) { callback(); gate.released++; }
  };
  function delayed(target, eventName, shouldDelay) {
    let proxy;
    const wrap = (listener) => (event) => {
      const deliver = () => typeof listener === 'function' ? listener.call(proxy, event) : listener?.handleEvent?.(event);
      if (!gate.enabled || !shouldDelay()) { deliver(); return; }
      gate.held++; gate.callbacks.push(deliver);
    };
    const wrappers = new Map();
    proxy = new Proxy(target, {
      get(native, key) {
        if (key === 'addEventListener') return (name, listener, options) => {
          const callback = name === eventName ? wrap(listener) : listener;
          wrappers.set(listener, callback); native.addEventListener(name, callback, options);
        };
        if (key === 'removeEventListener') return (name, listener, options) => native.removeEventListener(name, wrappers.get(listener) || listener, options);
        const value = Reflect.get(native, key, native);
        return typeof value === 'function' ? value.bind(native) : value;
      },
      set(native, key, value) { return Reflect.set(native, key, key === `on${eventName}` && value ? wrap(value) : value, native); },
    });
    return proxy;
  }
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = transaction.apply(this, args);
    if (this.name !== 'prt-composer-drafts-v1' || (args[1] || 'readonly') !== 'readonly') return tx;
    return delayed(tx, 'complete', () => heldTransactions.has(tx));
  };
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (...args) {
    const request = get.apply(this, args);
    if (!gate.enabled || this.transaction.db.name !== 'prt-composer-drafts-v1'
      || String(args[0]) !== JSON.stringify(['main', docId, 'chat'])) return request;
    heldTransactions.add(this.transaction);
    return delayed(request, 'success', () => true);
  };
}

let reader, browser, page;
const heldImages = [];
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
      PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await wait(100); try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ }
  }
  assert.ok(ready, 'isolated service starts');
  const listing = await fetch(`${base}/api/papers`).then((response) => response.json());
  assert.equal(path.resolve(listing.dir), path.resolve(papers));
  const paper = listing.papers.find((item) => item.name === 'retry-draft.pdf');
  assert.ok(paper);
  assert.ok((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'retry-draft-mock', apiKey: 'SYNTHETIC_RETRY_KEY' }) })).ok);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser-profile'),
    defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.evaluateOnNewDocument(installReadGate, paper.docId);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    localStorage.setItem('reader.session.onEnter', 'resume');
  });
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
  const reload = async () => { await page.reload({ waitUntil: 'domcontentloaded' }); await readyPage(); };
  const saved = () => page.waitForFunction(() => document.querySelector('#draftStorage')?.dataset.status === 'saved');
  const save = async () => {
    await page.evaluate(async () => { await window.__ctx.saveSessionNow(); await window.__ctx.flushComposerDrafts(); });
    await saved();
  };
  const draft = () => page.evaluate(() => ({ text: document.querySelector('#chatInput').value,
    attachments: window.__state.attachments.map((item) => ({ ...item })) }));
  const type = (text) => page.evaluate((value) => {
    const input = document.querySelector('#chatInput'); input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  const record = (id) => page.evaluate((id) => window.__state.sessionEntries.find((entry) => entry.id === id), id);
  const clickRetry = (id) => page.evaluate((id) => {
    const row = [...document.querySelectorAll('.msg.assistant')].find((node) => node.__sessionRecord?.id === id);
    if (!row?.querySelector('.acts button')) throw new Error(`Missing retry button for ${id}`);
    window.__retryClickedRow = row;
    row.querySelector('.acts button').click();
  }, id);
  const reached = async (count, status, id = '') => {
    for (let i = 0; i < 150 && requests.length < count; i++) await wait(50);
    assert.equal(requests.length, count, 'exactly the intended synthetic request is sent');
    await page.waitForFunction(({ status, id }) => !window.__state.busy
      && window.__state.sessionEntries.some((entry) => entry.status === status && (!id || entry.id === id)),
    { timeout: 15000 }, { status, id });
  };
  await page.goto(`${base}/?open=retry-draft.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await readyPage(); await saved();

  await type('Failed question must survive a session switch during draft hydration.');
  await page.evaluate(() => window.__ctx.addToChat({ text: 'A right-panel quotation retained with the question.', source: 'right' }));
  await page.click('#sendBtn'); await reached(1, 'failed');
  const original = await page.evaluate(() => ({ sid: window.__ctx.activeSession,
    row: window.__state.sessionEntries.find((entry) => entry.status === 'failed') }));
  const originalDraft = await draft(); await save();
  await page.evaluate(() => sessionStorage.setItem('test.retry.hold-read', '1'));
  await reload();
  await page.waitForFunction(() => window.__retryReadGate.held >= 2);
  assert.deepEqual(await draft(), { text: '', attachments: [] }, 'real saved draft is withheld before hydration');
  assert.equal((await record(original.row.id)).status, 'failed');
  await clickRetry(original.row.id);
  await wait(50);
  assert.equal(requests.length, 1, 'retry awaits the held IndexedDB read');
  await page.evaluate(() => window.__ctx.newSession({ silent: true }));
  const nextSid = await page.evaluate(() => window.__ctx.activeSession);
  assert.notEqual(nextSid, original.sid, 'the active session really changed');
  assert.equal(await page.evaluate(() => window.__state.doc.docId), paper.docId, 'the same paper remains open');
  await page.evaluate(() => window.__retryReadGate.release());
  await saved(); await wait(250);
  assert.equal(requests.length, 1, 'stale retry does not reach the model after hydration');
  assert.deepEqual(await draft(), originalDraft, 'stale retry does not consume the hydrated text or attachment');
  assert.deepEqual(await page.evaluate(() => ({ status: window.__retryClickedRow.__sessionRecord.status,
    text: window.__retryClickedRow.__sessionRecord.text })), { status: original.row.status, text: original.row.text },
  'the old answer is not reset to pending before the session guard');
  evidence.push({ case: 'hydration-session-switch', originalSid: original.sid, nextSid, requestCount: requests.length,
    gate: await page.evaluate(() => ({ held: window.__retryReadGate.held, released: window.__retryReadGate.released })), draft: await draft() });
  check('a same-paper session switch during real delayed hydration neither sends nor consumes the old draft');

  await type('');
  while (await page.$('#attachRow .at-x')) await page.click('#attachRow .at-x');
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 40;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#3c8875'; ctx.fillRect(0, 0, 64, 40);
    ctx.fillStyle = '#fff'; ctx.font = '16px sans-serif'; ctx.fillText('retry', 8, 26);
    const dataUrl = canvas.toDataURL('image/png');
    window.__ctx.addImageToChat({ dataUrl, width: 64, height: 40, pages: 1 }, 1, 'Screenshot-only retry fixture');
    return dataUrl;
  });
  await page.click('#sendBtn'); await reached(2, 'failed');
  const shotId = await page.evaluate(() => window.__state.sessionEntries.find((entry) => entry.status === 'failed').id);
  const shotDraft = await draft();
  assert.equal(shotDraft.text, ''); assert.equal(shotDraft.attachments.length, 1);
  for (let cycle = 0; cycle < 2; cycle++) {
    await save(); await reload(); await saved();
    assert.deepEqual(await draft(), shotDraft, `screenshot-only draft survives save/reload ${cycle + 1}`);
    const restored = await record(shotId);
    assert.equal(restored.retry.inputValue, '', 'serialized input stays empty');
    assert.equal(restored.retry.attachments[0].draftId, shotDraft.attachments[0].id);
    assert.match(restored.retry.attachments[0].id, /^[a-f0-9]{32}$/i, 'image file reference survives repeat serialization');
  }
  const rowIds = await page.evaluate(() => window.__state.sessionEntries.map((entry) => entry.id));
  await clickRetry(shotId); await reached(3, 'failed', shotId);
  assert.deepEqual(imagesOf(requests[2]), [imageData], 'retry sends the original image');
  assert.match(textOf(requests[2]), /没有写文字问题/, 'retry retains screenshot-only semantics');
  assert.equal((await record(shotId)).retry.inputValue, '', 'retry record preserves the explicit empty input');
  // Session retries store the image identity, pixels, size, label and first page;
  // the live capture's optional multi-page count is not part of that schema.
  const retriedShotDraft = await draft();
  const { pages: capturePageCount, ...savedShotFields } = shotDraft.attachments[0];
  assert.deepEqual(retriedShotDraft, { text: '', attachments: [savedShotFields] },
    'second failure restores only the same image and no internal question prompt');
  assert.deepEqual(await page.evaluate(() => window.__state.sessionEntries.map((entry) => entry.id)), rowIds, 'retry reuses the original two message rows');
  evidence.push({ case: 'screenshot-only-repeat-failure', rowIds, requestCount: requests.length,
    capturePageCount, draft: retriedShotDraft });
  check('screenshot-only retry survives two save/reload cycles and fails without inserting an internal prompt or duplicate attachment');

  await save(); await reload(); await saved();
  let holdImage = true;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (holdImage && request.method() === 'GET' && new URL(request.url()).pathname === '/api/attachment') heldImages.push(request);
    else request.continue().catch(() => {});
  });
  await clickRetry(shotId);
  for (let i = 0; i < 100 && !heldImages.length; i++) await wait(50);
  assert.equal(heldImages.length, 1, 'the restored retry really waits for its image HTTP request');
  assert.equal(requests.length, 3, 'image hydration finishes before model sending');
  const newText = 'Keep this newly typed question while the earlier screenshot is retried.';
  await type(newText);
  await page.evaluate(() => window.__ctx.addToChat({ text: 'A new unrelated quotation for the next question.', source: 'right' }));
  const newer = await draft();
  const expectedNewer = { text: newer.text, attachments: newer.attachments.filter((item) => item.id !== shotDraft.attachments[0].id) };
  assert.equal(expectedNewer.attachments.length, 1);
  rejectAnswer = false; holdImage = false;
  await heldImages.shift().continue();
  await reached(4, 'complete', shotId);
  assert.deepEqual(imagesOf(requests[3]), [imageData]);
  assert.ok(!textOf(requests[3]).includes(newText) && !textOf(requests[3]).includes(expectedNewer.attachments[0].text),
    'the retry request excludes the newly typed draft');
  assert.deepEqual(await draft(), expectedNewer, 'successful retry consumes only the old image and preserves the new text/attachment');
  await save(); await reload(); await saved();
  assert.deepEqual(await draft(), expectedNewer, 'refresh preserves the newer draft without reviving the consumed image');
  evidence.push({ case: 'edit-during-image-fetch', requestCount: requests.length, draft: await draft() });
  check('new input during delayed image retrieval survives successful retry and refresh');

  assert.deepEqual(pageErrors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ passed, pageErrors, requestCount: requests.length, evidence }, null, 2), 'utf8');
  console.log(`Retry draft safety: ${passed}/${passed} passed; evidence: ${scratch}`);
} catch (error) {
  const snapshot = page && !page.isClosed() ? await page.evaluate(() => ({
    text: document.querySelector('#chatInput')?.value, attachments: window.__state?.attachments,
    busy: window.__state?.busy, entries: window.__state?.sessionEntries,
    gate: window.__retryReadGate && { held: window.__retryReadGate.held, released: window.__retryReadGate.released },
  })).catch(() => null) : null;
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: String(error.stack || error),
    requestCount: requests.length, pageErrors, snapshot, evidence }, null, 2), 'utf8');
  console.error(`Retry draft safety evidence: ${scratch}`);
  throw error;
} finally {
  for (const request of heldImages) await request.abort().catch(() => {});
  if (browser) await browser.close();
  if (reader) await stopChild(reader);
  upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
}
