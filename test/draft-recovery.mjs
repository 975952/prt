/** Isolated durable-draft UI checks. node test/draft-recovery.mjs [--desktop]
 * Uses a private browser profile, fixture papers, and a local synthetic model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const CHROME = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((file) => file && fs.existsSync(file));
assert.ok(CHROME, 'Chrome or Edge is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `draft-recovery-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
const profile = path.join(scratch, 'browser-profile');
fs.mkdirSync(data); fs.mkdirSync(papers);
for (const name of ['draft-a.pdf', 'draft-b.pdf']) {
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, name));
}
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
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `隔离草稿测试回答 ${requests.length}。` } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch { if (!res.destroyed) res.destroy(); }
});

const sha = (text) => createHash('sha256').update(String(text)).digest('hex');
function signature(draft) {
  return { text: draft.text, attachments: draft.attachments.map((attachment) => {
    const { dataUrl, ...metadata } = attachment;
    return { ...metadata, ...(dataUrl ? { imageHash: sha(dataUrl), imageLength: dataUrl.length } : {}) };
  }) };
}

// Delay real IndexedDB success delivery, without replacing persisted data or app functions.
// This leaves the read snapshot old while the user edits the live composer.
function installReadGate(docId) {
  const gate = window.__draftReadGate = { enabled: true, held: 0, released: 0, calls: [], callbacks: [] };
  const delayedTransactions = new WeakSet();
  gate.release = () => {
    gate.enabled = false;
    for (const callback of gate.callbacks.splice(0)) { callback(); gate.released += 1; }
  };
  function delayedTarget(target, eventName, shouldDelay) {
    let proxy;
    const delay = (listener) => (event) => {
      const deliver = () => typeof listener === 'function' ? listener.call(proxy, event) : listener?.handleEvent?.(event);
      if (!gate.enabled || !shouldDelay()) { deliver(); return; }
      gate.held += 1; gate.callbacks.push(deliver);
    };
    const wrapped = new Map();
    proxy = new Proxy(target, {
      get(nativeTarget, key) {
        if (key === 'addEventListener') return (name, listener, options) => {
          const callback = name === eventName ? delay(listener) : listener;
          wrapped.set(listener, callback); nativeTarget.addEventListener(name, callback, options);
        };
        if (key === 'removeEventListener') return (name, listener, options) => nativeTarget.removeEventListener(name, wrapped.get(listener) || listener, options);
        const value = Reflect.get(nativeTarget, key, nativeTarget);
        return typeof value === 'function' ? value.bind(nativeTarget) : value;
      },
      set(nativeTarget, key, value) {
        return Reflect.set(nativeTarget, key, key === `on${eventName}` && value ? delay(value) : value, nativeTarget);
      },
    });
    return proxy;
  }
  const nativeTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const transaction = nativeTransaction.apply(this, args);
    if ((args[1] || 'readonly') !== 'readonly' || !/draft|composer/i.test(`${this.name}/${args[0]}`)) return transaction;
    return delayedTarget(transaction, 'complete', () => delayedTransactions.has(transaction));
  };
  for (const method of ['get', 'getAll']) {
    const native = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function (...args) {
      const request = native.apply(this, args);
      const owner = `${this.transaction.db.name}/${this.name}`;
      if (!/draft|composer/i.test(owner) || !gate.enabled || (method === 'get' && !String(args[0]).includes(docId))) return request;
      gate.calls.push({ method, owner });
      delayedTransactions.add(this.transaction);
      return delayedTarget(request, 'success', () => true);
    };
  }
}

let reader, browser, page, other;
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0',
    PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('draft-recovery').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await wait(100); try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ }
  }
  assert.ok(ready, 'isolated reader starts');
  for (const asset of ['app.js', 'composer-drafts.js', 'draft-persistence.js']) {
    assert.equal(await fetch(`${base}/js/${asset}`).then((res) => res.text()),
      fs.readFileSync(path.join(ROOT, 'public/js', asset), 'utf8'), `reader serves the current ${asset}`);
  }
  assert.ok((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'draft-recovery-mock', apiKey: 'SYNTHETIC_DRAFT_KEY' }) })).ok);
  const errors = [];
  const launch = () => puppeteer.launch({ executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: profile, defaultViewport: { width: 1400, height: 940 } });
  const boot = async (target, { windowId = '', setup = true } = {}) => {
    target.on('pageerror', (error) => errors.push(String(error)));
    await target.bringToFront();
    await target.goto(`${base}/?open=draft-a.pdf&topbar=static${windowId ? `&readerWindow=${windowId}` : ''}`, { waitUntil: 'domcontentloaded' });
    await target.waitForFunction(() => window.__viewer?.pdf && window.__ctx && window.__state.viewerDocId === window.__state.doc?.docId);
    if (setup) await target.evaluate(async () => {
      const sessions = await import('/js/sessions.js'); await sessions.sessionsOpenLatestForOutput();
      document.body.classList.remove('no-right');
      window.__ctx.setAgentRead(false); window.__ctx.setScopeRange('current');
    });
  };
  const mode = async (target, name) => {
    await target.bringToFront();
    if (await target.$eval('#rightSide', (node) => node.dataset.activePanel) !== name) await target.click(`#aiBar .aibar-btn[data-block="${name}"]`);
    await target.waitForFunction((wanted) => document.querySelector('#rightSide')?.dataset.activePanel === wanted, {}, name);
  };
  const type = async (target, value) => {
    await target.bringToFront();
    await target.click('#chatInput'); await target.keyboard.down('Control'); await target.keyboard.press('KeyA');
    await target.keyboard.up('Control'); await target.keyboard.press('Backspace');
    const lines = value.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (index) { await target.keyboard.down('Shift'); await target.keyboard.press('Enter'); await target.keyboard.up('Shift'); }
      if (lines[index]) await target.type('#chatInput', lines[index]);
    }
  };
  const draft = (target) => target.evaluate(() => ({ text: document.querySelector('#chatInput').value,
    attachments: window.__state.attachments.map((attachment) => Object.fromEntries(
      ['id', 'kind', 'page', 'text', 'from', 'dataUrl', 'w', 'h', 'pages', 'label']
        .filter((key) => attachment[key] !== undefined).map((key) => [key, attachment[key]]))) }));
  const expectDraft = async (target, expected, message) => {
    await target.waitForFunction(({ text, count }) => document.querySelector('#chatInput')?.value === text
      && window.__state?.attachments?.length === count, { timeout: 15000 }, { text: expected.text, count: expected.attachments.length });
    assert.deepEqual(signature(await draft(target)), signature(expected), message);
  };
  const stored = async (target, marker, expected = true) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await target.evaluate(async (needle) => {
        let matched = 0, found = false;
        for (const info of await indexedDB.databases()) {
          if (!info.name) continue;
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open(info.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          const stores = [...database.objectStoreNames].filter((name) => /draft|composer/i.test(`${info.name}/${name}`));
          for (const name of stores) {
            matched += 1;
            const rows = await new Promise((resolve, reject) => {
              const request = database.transaction(name, 'readonly').objectStore(name).getAll();
              request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            if (JSON.stringify(rows).includes(needle)) found = true;
          }
          database.close();
        }
        return { matched, found };
      }, marker);
      if (result.matched && result.found === expected) {
        // A matching text can belong to an older revision while its image write is pending.
        await target.waitForFunction(() => document.querySelector('#draftStorage')?.dataset.status === 'saved', { timeout: 15000 });
        return;
      }
      await wait(50);
    }
    throw new Error(`Durable draft ${expected ? 'did not save' : 'did not clear'} marker: ${marker}`);
  };
  const reload = async (target) => {
    await target.bringToFront();
    await target.reload({ waitUntil: 'domcontentloaded' });
    await target.waitForFunction(() => window.__viewer?.pdf && window.__ctx && window.__state.viewerDocId === window.__state.doc?.docId);
  };
  const addImage = (target, label, large = false) => target.evaluate(({ label, large }) => {
    const canvas = document.createElement('canvas'); canvas.width = large ? 640 : 64; canvas.height = large ? 480 : 48;
    const context = canvas.getContext('2d'), pixels = context.createImageData(canvas.width, canvas.height);
    let seed = [...label].reduce((value, char) => Math.imul(value ^ char.codePointAt(0), 16777619) >>> 0, 2166136261);
    for (let i = 0; i < pixels.data.length; i += 4) {
      for (let color = 0; color < 3; color += 1) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels.data[i + color] = seed & 255; }
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    window.__ctx.addImageToChat({ dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, pages: large ? 3 : 1 }, large ? 2 : 1, label);
  }, { label, large });
  const clearDraft = async (target) => {
    await type(target, '');
    while (await target.$('#attachRow .at-x')) await target.click('#attachRow .at-x');
  };
  const listing = (await fetch(`${base}/api/papers`).then((res) => res.json())).papers;
  const paperA = listing.find((item) => item.name === 'draft-a.pdf');
  const paperB = listing.find((item) => item.name === 'draft-b.pdf');
  assert.ok(paperA && paperB);
  const openDoc = async (target, paper) => {
    if (await target.evaluate((docId) => window.__state.doc?.docId === docId, paper.docId)) return;
    const selector = `#tabStrip .doc-tab[data-doc="${paper.docId}"] .tab-title`;
    if (await target.$(selector)) await target.click(selector);
    else await target.evaluate((doc) => window.__ctx.openDoc(doc), paper);
    await target.waitForFunction((id) => window.__state.doc?.docId === id && window.__state.viewerDocId === id, { timeout: 15000 }, paper.docId);
  };
  const send = async (target, expectedRequests) => {
    const before = requests.length;
    await target.click('#sendBtn');
    for (let i = 0; i < 150 && requests.length < before + expectedRequests; i += 1) await wait(50);
    assert.equal(requests.length, before + expectedRequests, 'submitted draft reaches only the synthetic model');
    await target.waitForFunction(() => !window.__state.busy && !window.__state.sessionEntries.some((entry) => entry.status === 'pending'), { timeout: 15000 });
  };

  browser = await launch(); page = await browser.newPage(); await boot(page); await mode(page, 'chat');
  await type(page, 'A 问答草稿：刷新后保留公式 α≤β 与完整选区。');
  await addImage(page, 'A 大图：跨三页，原始像素与来源必须保留', true);
  await page.evaluate(() => window.__ctx.addToChat({ text: '来自右栏的文字。\n第二行仍需保留。', cleanText: '来自右栏的文字。\n第二行仍需保留。', source: 'right' }));
  let aChat = await draft(page);
  assert.ok(aChat.attachments.find((item) => item.kind === 'image').dataUrl.length > 500000, 'fixture is a genuinely large PNG');
  assert.equal(aChat.attachments.find((item) => item.kind === 'text').from, 'right');
  await stored(page, aChat.text);
  await mode(page, 'translate'); await type(page, 'Paper A translation draft before refresh.'); await addImage(page, 'A 翻译原图');
  const aTranslate = await draft(page); await stored(page, aTranslate.text);
  await openDoc(page, paperB); await mode(page, 'chat'); await type(page, 'B 问答独立草稿'); await addImage(page, 'B 问答原图');
  const bChat = await draft(page); await stored(page, bChat.text);
  await mode(page, 'translate'); await type(page, 'Paper B translation draft before refresh.'); await addImage(page, 'B 翻译原图');
  const bTranslate = await draft(page); await stored(page, bTranslate.text);
  await reload(page);
  for (const [paper, kind, expected] of [[paperB, 'translate', bTranslate], [paperB, 'chat', bChat], [paperA, 'translate', aTranslate], [paperA, 'chat', aChat]]) {
    await openDoc(page, paper); await mode(page, kind); await expectDraft(page, expected, `${paper.name}/${kind} restores its exact draft`);
  }
  console.log('PASS refresh restores four document/mode drafts with original large-image bytes, dimensions and right-side source');

  aChat = { ...aChat, text: `${aChat.text}\n继续编辑后的第二段，不回退到旧文本。` };
  await type(page, aChat.text); await expectDraft(page, aChat, 'editing preserves all original images and right-side quotes');
  await stored(page, '继续编辑后的第二段，不回退到旧文本。');
  await reload(page); await mode(page, 'chat'); await expectDraft(page, aChat, 'editing a recovered draft is persisted');
  console.log('PASS recovered drafts remain editable and later refresh uses the newest revision');

  other = await browser.newPage(); await boot(other, { windowId: 'draft-recovery-other' }); await mode(other, 'chat');
  await expectDraft(other, { text: '', attachments: [] }, 'another reader window starts with its own draft');
  await type(other, '第二个阅读窗口的私有问答草稿'); await addImage(other, '第二窗口图片');
  const otherChat = await draft(other); await stored(other, otherChat.text);
  await reload(page); await mode(page, 'chat'); await expectDraft(page, aChat, 'other window cannot overwrite the main draft');
  await reload(other); await mode(other, 'chat'); await expectDraft(other, otherChat, 'second window restores its own draft');
  console.log('PASS readerWindow namespaces isolate drafts across simultaneous windows and reloads');

  await mode(page, 'translate'); await expectDraft(page, aTranslate, 'original translation is available before clearing');
  await clearDraft(page); await stored(page, aTranslate.text, false);
  await reload(page); await mode(page, 'translate');
  await expectDraft(page, { text: '', attachments: [] }, 'cleared text and images do not reappear');
  await mode(page, 'chat'); await expectDraft(page, aChat, 'clearing translation leaves the question draft intact');
  console.log('PASS manually cleared drafts stay empty after reload without affecting other modes');

  await openDoc(page, paperB); await mode(page, 'chat'); await expectDraft(page, bChat, 'question draft is restored before submission');
  await page.evaluate(async () => { const sessions = await import('/js/sessions.js'); await sessions.sessionsOpenLatestForOutput(); });
  await send(page, 1); await stored(page, bChat.text, false);
  await reload(page); await openDoc(page, paperB); await mode(page, 'chat'); await expectDraft(page, { text: '', attachments: [] }, 'sent question does not revive');
  await mode(page, 'translate'); await expectDraft(page, bTranslate, 'translation draft is restored before submission');
  await send(page, 2); await stored(page, bTranslate.text, false);
  await reload(page); await openDoc(page, paperB); await mode(page, 'translate'); await expectDraft(page, { text: '', attachments: [] }, 'sent translation does not revive');
  console.log('PASS successful question and translation sends durably clear their submitted text and images');

  await openDoc(page, paperA); await mode(page, 'chat'); await expectDraft(page, aChat, 'main draft is ready for process restart');
  await browser.close(); browser = null; page = null; other = null;
  browser = await launch(); page = await browser.newPage(); await boot(page); await mode(page, 'chat');
  await expectDraft(page, aChat, 'same-profile browser restart restores the exact large image and right-side quote');
  await page.waitForFunction((text) => [...document.querySelectorAll('.ai-block[data-block="chat"] .msg')]
    .some((node) => node.__sessionRecord?.kind === 'user' && node.__sessionRecord.text === text
      && node.querySelector('.shots img')?.complete), { timeout: 15000 }, bChat.text);
  const restoredQuestionShot = await page.evaluate((text) => {
    const row = [...document.querySelectorAll('.ai-block[data-block="chat"] .msg')]
      .find((node) => node.__sessionRecord?.kind === 'user' && node.__sessionRecord.text === text);
    const image = row.querySelector('.shots img');
    return { docId: window.__state.doc.docId, sourceDocId: row.__sessionRecord.docId,
      src: image.src, width: image.naturalWidth, height: image.naturalHeight, visibleText: row.textContent };
  }, bChat.text);
  const originalQuestionShot = bChat.attachments.find((attachment) => attachment.kind === 'image');
  assert.equal(restoredQuestionShot.docId, paperA.docId, 'paper A is active while restoring the shared conversation');
  assert.equal(restoredQuestionShot.sourceDocId, paperB.docId, 'the historical screenshot still belongs to paper B');
  assert.ok(restoredQuestionShot.src === originalQuestionShot.dataUrl, 'paper B history restores the exact original PNG bytes while paper A is active');
  assert.equal(restoredQuestionShot.width, originalQuestionShot.w); assert.equal(restoredQuestionShot.height, originalQuestionShot.h);
  assert.doesNotMatch(restoredQuestionShot.visibleText, /截图文件缺失|截图附件未保存|请重新添加截图/);
  console.log('PASS shared chat history restores paper B screenshot bytes while paper A is open');
  other = await browser.newPage(); await boot(other, { windowId: 'draft-recovery-other' }); await mode(other, 'chat');
  await expectDraft(other, otherChat, 'same-profile restart preserves the other window namespace');
  await page.bringToFront();
  await (await page.$('#rightSide')).screenshot({ path: path.join(scratch, 'draft-restored-after-restart.png') });
  console.log('PASS closing and relaunching the same browser profile restores both window drafts');

  await page.close(); page = await browser.newPage();
  await page.evaluateOnNewDocument(installReadGate, paperA.docId);
  await boot(page, { setup: false }); await mode(page, 'chat');
  await page.waitForFunction(() => window.__draftReadGate?.held > 0, { timeout: 15000 });
  assert.deepEqual(await draft(page), { text: '', attachments: [] }, 'the old draft is still held before new user input');
  await type(page, '读取旧草稿期间新输入的文字必须优先。'); await addImage(page, '恢复期间新增的图片');
  const typedDuringRead = await draft(page);
  await page.evaluate(() => window.__draftReadGate.release());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expectDraft(page, typedDuringRead, 'late IndexedDB reads cannot replace user edits or new attachments');
  await stored(page, typedDuringRead.text);
  await reload(page); await mode(page, 'chat');
  // Disable the new-document gate installed for the preceding race before waiting for recovery.
  await page.waitForFunction(() => window.__draftReadGate?.held > 0, { timeout: 15000 });
  await page.evaluate(() => window.__draftReadGate.release());
  await expectDraft(page, typedDuringRead, 'the winning new draft is durable after the delayed read');
  console.log('PASS typing during an actual delayed IndexedDB read wins and is persisted');
  assert.deepEqual(errors, []);
  console.log(`PASS ${desktop ? 'desktop' : 'Node'} draft recovery: ${scratch}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.bringToFront().catch(() => {});
    await page.screenshot({ path: path.join(scratch, 'draft-recovery-failure.png') }).catch(() => {});
    const state = await page.evaluate(() => ({ doc: window.__state?.doc?.name,
      viewerDocId: window.__state?.viewerDocId, docId: window.__state?.doc?.docId, hasPdf: !!window.__viewer?.pdf,
      mode: document.querySelector('#rightSide')?.dataset.activePanel, text: document.querySelector('#chatInput')?.value,
      attachments: window.__state?.attachments?.map(({ id, kind, w, h, page, label, from, dataUrl }) => ({ id, kind, w, h, page, label, from, imageLength: dataUrl?.length })),
      readGate: window.__draftReadGate ? { held: window.__draftReadGate.held, released: window.__draftReadGate.released, calls: window.__draftReadGate.calls } : null })).catch(() => null);
    console.error(JSON.stringify({ scratch, requests: requests.length, state }, null, 2));
  }
  throw error;
} finally {
  await browser?.close(); await stopChild(reader);
  upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
}
