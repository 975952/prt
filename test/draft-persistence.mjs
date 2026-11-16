/** Draft durability checks. Real IndexedDB uses a fresh, isolated browser profile.
 * No app server, model call, localStorage or user data is read or written.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX } from './_env.mjs';
import { createDraftPersistence } from '../public/js/draft-persistence.js';

const chat = { docId: 'paper-a', mode: 'chat' };
const translate = { docId: 'paper-a', mode: 'translate' };
const other = { docId: 'paper-b', mode: 'chat' };
const empty = { text: '', attachments: [] };
const keyOf = (owner, windowId = 'main') => JSON.stringify([windowId, String(owner?.docId ?? ''), owner?.mode === 'translate' ? 'translate' : 'chat']);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function memoryAdapter() {
  const rows = new Map();
  const events = [];
  const adapter = {
    rows, events, closed: false, before: async () => {},
    async get(key) { events.push(['get', key]); await adapter.before('get', key); return structuredClone(rows.get(key)); },
    async put(record) { events.push(['put', record.key]); await adapter.before('put', record.key); rows.set(record.key, structuredClone(record)); },
    async remove(key) { events.push(['remove', key]); await adapter.before('remove', key); rows.delete(key); },
    async close() { events.push(['close']); adapter.closed = true; },
  };
  return adapter;
}

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }

await check('window, document, mode and empty-document keys remain independent', async () => {
  const adapter = memoryAdapter();
  const main = createDraftPersistence({ adapter });
  const second = createDraftPersistence({ windowId: 'second', adapter });
  for (const owner of [chat, translate, other, { docId: '', mode: 'chat' }, { docId: 'a|translate', mode: 'chat' }, { docId: '__proto__', mode: 'chat' }]) {
    await main.save(owner, { text: keyOf(owner) });
    await second.save(owner, { text: keyOf(owner, 'second') });
    assert.equal((await main.load(owner)).text, keyOf(owner));
    assert.equal((await second.load(owner)).text, keyOf(owner, 'second'));
  }
  assert.deepEqual(await main.load({ docId: 'never-saved' }), empty);
  await main.remove(chat);
  assert.deepEqual(await main.load(chat), empty);
  assert.equal((await second.load(chat)).text, keyOf(chat, 'second'));
  await main.close(); await second.close();
});

await check('full text, nested metadata and image bytes survive without stale session refs', async () => {
  const adapter = memoryAdapter();
  const store = createDraftPersistence({ adapter });
  const text = ` \n${'中文🙂 \\alpha\r\n'.repeat(10000)}\n `;
  const bytes = Uint8Array.from({ length: 100000 }, (_, index) => index % 256);
  const dataUrl = `data:image/PNG;base64,${Buffer.from(bytes).toString('base64')}`;
  const shot = { id: 'image-a', kind: 'image', dataUrl, ref: 'old-session-image', page: 3, w: 1600, h: 2400,
    pages: 2, label: '跨页截图', metadata: { source: ['page-3', 'page-4'], empty: null } };
  const quote = { id: 'quote', kind: 'text', text: '  selected source\n', page: null, from: 'right', ref: 'text-metadata' };
  await store.save(translate, { text, attachments: [shot, quote] });
  const packed = adapter.rows.get(keyOf(translate)).attachments[0];
  assert.ok(packed.image instanceof Blob);
  assert.equal(packed.value.dataUrl, undefined);
  assert.equal(packed.value.ref, undefined);
  assert.deepEqual(new Uint8Array(await packed.image.arrayBuffer()), bytes);
  const result = await store.load(translate);
  const expected = { ...shot }; delete expected.ref;
  assert.deepEqual(result, { text, attachments: [expected, quote] });
  assert.equal(shot.ref, 'old-session-image', 'caller source is not mutated');
  result.attachments[0].metadata.source.push('changed');
  assert.deepEqual((await store.load(translate)).attachments[0], expected);
  await store.close();
});

await check('draft and owner are captured when save is called, before queued work starts', async () => {
  const adapter = memoryAdapter();
  const store = createDraftPersistence({ adapter });
  const owner = { ...chat };
  const draft = { text: 'original', attachments: [{ id: 'quote', kind: 'text', text: 'original quote', extra: { page: 4 } }] };
  const saved = store.save(owner, draft);
  owner.docId = 'changed'; draft.text = 'changed'; draft.attachments[0].extra.page = 99; draft.attachments.push({ id: 'extra' });
  await saved;
  assert.deepEqual(await store.load(chat), { text: 'original', attachments: [{ id: 'quote', kind: 'text', text: 'original quote', extra: { page: 4 } }] });
  assert.deepEqual(await store.load(owner), empty);
  await store.close();
});

await check('slow saves cannot overtake remove or resurrect a cleared draft', async () => {
  const adapter = memoryAdapter();
  const entered = deferred(), release = deferred();
  adapter.before = async (operation) => { if (operation === 'put') { entered.resolve(); await release.promise; } };
  const store = createDraftPersistence({ adapter });
  const saved = store.save(chat, { text: 'slow old draft' });
  const removed = store.remove(chat);
  const loaded = store.load(chat);
  const flushed = store.flush();
  let finished = false; flushed.then(() => { finished = true; });
  await entered.promise;
  assert.deepEqual(adapter.events.map(([operation]) => operation), ['put']);
  assert.equal(finished, false);
  release.resolve();
  await Promise.all([saved, removed, flushed]);
  assert.deepEqual(await loaded, empty);
  assert.deepEqual(adapter.events.map(([operation]) => operation), ['put', 'remove', 'get']);
  await store.close();
});

await check('empty drafts delete atomically while whitespace and attachment-only drafts remain', async () => {
  const adapter = memoryAdapter();
  const store = createDraftPersistence({ adapter });
  await store.save(chat, { text: ' \n\t ' });
  assert.equal((await store.load(chat)).text, ' \n\t ');
  await store.save(chat, { text: '', attachments: [{ id: 'text', kind: 'text', text: 'source' }] });
  assert.equal((await store.load(chat)).attachments.length, 1);
  await store.save(chat, empty);
  assert.equal(adapter.rows.has(keyOf(chat)), false);
  assert.deepEqual(await store.load(chat), empty);
  await store.close();
});

await check('a caught write failure stays visible to flush until the same owner is saved', async () => {
  const adapter = memoryAdapter();
  const store = createDraftPersistence({ adapter });
  await store.save(chat, { text: 'last durable draft' });
  adapter.before = async (operation, key) => { if (operation === 'put' && key === keyOf(chat)) throw new Error('quota reached'); };
  await assert.rejects(store.save(chat, { text: 'unsaved edit' }), /quota reached/);
  assert.equal((await store.load(chat)).text, 'last durable draft');
  await store.save(other, { text: 'different owner succeeded' });
  await assert.rejects(store.flush(), /quota reached/);
  await assert.rejects(store.flush(), /quota reached/);
  adapter.before = async () => {};
  await store.save(chat, { text: 'recovered edit' });
  await store.flush();
  assert.equal((await store.load(chat)).text, 'recovered edit');
  await store.close();
});

await check('flush drains all earlier work before reporting an earlier write failure', async () => {
  const adapter = memoryAdapter();
  const entered = deferred(), release = deferred();
  adapter.before = async (operation, key) => {
    if (operation !== 'put') return;
    if (key === keyOf(chat)) throw new Error('first write failed');
    entered.resolve(); await release.promise;
  };
  const store = createDraftPersistence({ adapter });
  const failed = store.save(chat, { text: 'failure' });
  const success = store.save(other, { text: 'later slow success' });
  const barrier = store.flush();
  let settled = false; barrier.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise;
  assert.equal(settled, false);
  release.resolve();
  await assert.rejects(failed, /first write failed/); await success;
  await assert.rejects(barrier, /first write failed/);
  await store.remove(chat); await store.flush();
  assert.equal((await store.load(other)).text, 'later slow success');
  await store.close();
});

await check('read and remove errors reject without poisoning subsequent operations', async () => {
  const adapter = memoryAdapter();
  const store = createDraftPersistence({ adapter });
  await store.save(chat, { text: 'keep on failed delete' });
  adapter.before = async (operation) => { if (operation === 'get') throw new Error('database read failed'); };
  await assert.rejects(store.load(chat), /database read failed/);
  adapter.before = async (operation) => { if (operation === 'remove') throw new Error('database delete failed'); };
  await assert.rejects(store.remove(chat), /database delete failed/);
  await assert.rejects(store.flush(), /database delete failed/);
  assert.equal((await store.load(chat)).text, 'keep on failed delete');
  adapter.before = async () => {};
  await store.remove(chat); await store.flush();
  assert.deepEqual(await store.load(chat), empty);
  await store.close();
});

await check('unavailable IndexedDB and corrupt stored records are errors, never empty reads', async () => {
  const unavailable = createDraftPersistence({ indexedDB: null });
  await assert.rejects(unavailable.load(chat), /IndexedDB is unavailable/);
  await assert.rejects(unavailable.save(chat, { text: 'must not disappear' }), /IndexedDB is unavailable/);
  await assert.rejects(unavailable.flush(), /IndexedDB is unavailable/);
  await assert.rejects(unavailable.close(), /IndexedDB is unavailable/);
  const adapter = memoryAdapter();
  adapter.rows.set(keyOf(chat), { text: 'bad storage format' });
  const store = createDraftPersistence({ adapter });
  await assert.rejects(store.load(chat), /Saved draft is invalid/);
  assert.deepEqual(adapter.rows.get(keyOf(chat)), { text: 'bad storage format' });
  await store.close();
});

await check('unusual data URLs retain their exact form instead of losing source data', async () => {
  const store = createDraftPersistence({ adapter: memoryAdapter() });
  const sources = ['data:image/svg+xml,%3Csvg%2F%3E', 'data:image/png;base64,AQ', 'data:image/png;base64,%%%%', 'data:image/png;base64,'];
  const attachments = sources.map((dataUrl, index) => ({ id: String(index), kind: 'image', dataUrl, ref: 'stale' }));
  await store.save(chat, { attachments });
  const actual = (await store.load(chat)).attachments;
  assert.deepEqual(actual.map((image) => image.dataUrl), sources);
  assert.ok(actual.every((image) => !Object.hasOwn(image, 'ref')));
  await store.close();
});

await check('uncloneable metadata fails without replacing the prior durable draft', async () => {
  const store = createDraftPersistence({ adapter: memoryAdapter() });
  await store.save(chat, { text: 'durable' });
  await assert.rejects(store.save(chat, { text: 'not saved', attachments: [{ id: 'bad', callback() {} }] }), { name: 'DataCloneError' });
  assert.equal((await store.load(chat)).text, 'durable');
  await assert.rejects(store.flush(), { name: 'DataCloneError' });
  await store.save(chat, { text: 'fixed' }); await store.flush(); await store.close();
});

await check('close drains accepted work, is idempotent and rejects new work', async () => {
  const adapter = memoryAdapter();
  const entered = deferred(), release = deferred();
  adapter.before = async () => { entered.resolve(); await release.promise; };
  const store = createDraftPersistence({ adapter });
  const saving = store.save(chat, { text: 'last pending edit' });
  const closing = store.close();
  assert.equal(store.close(), closing);
  assert.equal(store.flush(), closing);
  await entered.promise;
  assert.equal(adapter.closed, false);
  await assert.rejects(store.save(other, { text: 'too late' }), /closed/);
  await assert.rejects(store.load(chat), /closed/);
  await assert.rejects(store.remove(chat), /closed/);
  release.resolve(); await saving; await closing;
  assert.equal(adapter.closed, true);
  assert.equal(adapter.rows.get(keyOf(chat)).text, 'last pending edit');
});

await check('close still releases the database when an unresolved write error exists', async () => {
  const adapter = memoryAdapter();
  adapter.before = async () => { throw new Error('disk write failed'); };
  const store = createDraftPersistence({ adapter });
  await assert.rejects(store.save(chat, { text: 'edit' }), /disk write failed/);
  await assert.rejects(store.close(), /disk write failed/);
  assert.equal(adapter.closed, true);
});

const CHROME = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((file) => file && fs.existsSync(file));
assert.ok(CHROME, 'Chrome or Edge is available for real IndexedDB checks');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'draft-persistence-'));
const source = fs.readFileSync(path.join(ROOT, 'public/js/draft-persistence.js'), 'utf8');
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/draft-persistence.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(source); }
  else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>Isolated draft persistence test</title>'); }
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const launch = () => puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    userDataDir: path.join(scratch, 'browser') });
  browser = await launch();
  let page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  await check('real IndexedDB atomically stores Blob images, full text and window isolation', async () => {
    const result = await page.evaluate(async () => {
      const { createDraftPersistence } = await import('/draft-persistence.js');
      const main = createDraftPersistence();
      const side = createDraftPersistence({ windowId: 'side' });
      const owner = { docId: 'real-paper', mode: 'translate' };
      const dataUrl = 'data:image/png;base64,AQIDBAU=';
      await main.save(owner, { text: '  长草稿🙂\r\n'.repeat(20000), attachments: [{ id: 'shot', kind: 'image', dataUrl,
        ref: 'old-sid-ref', page: 5, w: 40, h: 50, pages: 2, label: '原图', extra: { note: '完整保留' } }] });
      await side.save(owner, { text: 'second window' });
      await main.flush();
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('prt-composer-drafts-v1', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const raw = await new Promise((resolve, reject) => {
        const tx = db.transaction('drafts');
        const request = tx.objectStore('drafts').get(JSON.stringify(['main', owner.docId, owner.mode]));
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      db.close();
      const stored = await main.load(owner);
      const isolated = await side.load(owner);
      await main.close(); await side.close();
      return { text: stored.text, image: stored.attachments[0], second: isolated.text,
        blob: raw.attachments[0].image instanceof Blob, storedDataUrl: Object.hasOwn(raw.attachments[0].value, 'dataUrl') };
    });
    assert.equal(result.text, '  长草稿🙂\r\n'.repeat(20000));
    assert.deepEqual(result.image, { id: 'shot', kind: 'image', dataUrl: 'data:image/png;base64,AQIDBAU=', page: 5,
      w: 40, h: 50, pages: 2, label: '原图', extra: { note: '完整保留' } });
    assert.equal(result.second, 'second window'); assert.equal(result.blob, true); assert.equal(result.storedDataUrl, false);
  });

  await check('page refresh restores committed drafts from the same origin', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const { createDraftPersistence } = await import('/draft-persistence.js');
      const store = createDraftPersistence();
      const draft = await store.load({ docId: 'real-paper', mode: 'translate' });
      await store.close();
      return { textLength: draft.text.length, image: draft.attachments[0].dataUrl };
    });
    assert.equal(result.textLength, '  长草稿🙂\r\n'.repeat(20000).length);
    assert.equal(result.image, 'data:image/png;base64,AQIDBAU=');
  });

  await check('browser restart with the same profile and origin restores committed drafts', async () => {
    await browser.close(); browser = await launch(); page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const { createDraftPersistence } = await import('/draft-persistence.js');
      const store = createDraftPersistence();
      const draft = await store.load({ docId: 'real-paper', mode: 'translate' });
      await store.close();
      return { textLength: draft.text.length, image: draft.attachments[0].dataUrl, label: draft.attachments[0].label };
    });
    assert.equal(result.textLength, '  长草稿🙂\r\n'.repeat(20000).length);
    assert.equal(result.image, 'data:image/png;base64,AQIDBAU='); assert.equal(result.label, '原图');
  });

  await check('aborted real IndexedDB writes preserve the old draft and recover on a later save', async () => {
    const result = await page.evaluate(async () => {
      const { createDraftPersistence } = await import('/draft-persistence.js');
      const store = createDraftPersistence();
      const owner = { docId: 'atomic', mode: 'chat' };
      await store.save(owner, { text: 'original durable text' });
      const nativePut = IDBObjectStore.prototype.put;
      let saveError = '', flushError = '';
      try {
        IDBObjectStore.prototype.put = function (...args) {
          const request = nativePut.apply(this, args); this.transaction.abort(); return request;
        };
        try { await store.save(owner, { text: 'aborted replacement' }); } catch (error) { saveError = error.name; }
      } finally { IDBObjectStore.prototype.put = nativePut; }
      try { await store.flush(); } catch (error) { flushError = error.name; }
      const retained = await store.load(owner);
      await store.save(owner, { text: 'success after abort' }); await store.flush();
      const recovered = await store.load(owner);
      await store.remove(owner); await store.flush();
      const removed = await store.load(owner);
      await store.close();
      return { saveError, flushError, retained: retained.text, recovered: recovered.text, removed };
    });
    assert.equal(result.saveError, 'AbortError'); assert.equal(result.flushError, 'AbortError');
    assert.equal(result.retained, 'original durable text'); assert.equal(result.recovered, 'success after abort');
    assert.deepEqual(result.removed, empty);
  });

  await check('an IndexedDB open failure rejects and the same instance can later recover', async () => {
    const result = await page.evaluate(async () => {
      const { createDraftPersistence } = await import('/draft-persistence.js');
      let fail = true;
      const factory = { open(...args) {
        if (fail) throw new DOMException('Storage permission denied', 'SecurityError');
        return indexedDB.open(...args);
      } };
      const store = createDraftPersistence({ indexedDB: factory });
      const owner = { docId: 'open-retry', mode: 'chat' };
      let loadError = '', saveError = '', flushError = '';
      try { await store.load(owner); } catch (error) { loadError = error.name; }
      try { await store.save(owner, { text: 'not yet saved' }); } catch (error) { saveError = error.name; }
      try { await store.flush(); } catch (error) { flushError = error.name; }
      fail = false;
      await store.save(owner, { text: 'saved after permission recovered' }); await store.flush();
      const restored = await store.load(owner); await store.close();
      return { loadError, saveError, flushError, text: restored.text };
    });
    assert.deepEqual(result, { loadError: 'SecurityError', saveError: 'SecurityError', flushError: 'SecurityError',
      text: 'saved after permission recovered' });
  });
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`Draft persistence: ${passed}/${passed} passed`);
