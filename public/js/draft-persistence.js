/** Durable composer drafts. No backend, localStorage, model or session dependency. */

const DATABASE_NAME = 'prt-composer-drafts-v1';
const STORE_NAME = 'drafts';

const emptyDraft = () => ({ text: '', attachments: [] });
const objectRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);

function ownerKey(windowId, owner) {
  return JSON.stringify([windowId, String(owner?.docId ?? ''), owner?.mode === 'translate' ? 'translate' : 'chat']);
}

function copyAttachment(attachment) {
  const value = structuredClone(attachment);
  // A draft outlives the chat session that originally uploaded this image.
  if (value.kind === 'image') delete value.ref;
  return value;
}

function snapshot(draft) {
  return {
    text: String(draft?.text ?? ''),
    attachments: (Array.isArray(draft?.attachments) ? draft.attachments : [])
      .filter(objectRecord).map(copyAttachment),
  };
}

function packAttachment(attachment) {
  const value = copyAttachment(attachment);
  if (value.kind !== 'image' || typeof value.dataUrl !== 'string') return { value };
  const match = /^(data:(image\/[^;,]+);base64,)([A-Za-z0-9+/]*={0,2})$/.exec(value.dataUrl);
  if (!match) return { value };
  let binary;
  try { binary = atob(match[3]); } catch { return { value }; }
  // Preserve unusual/invalid data URLs verbatim rather than normalizing user data.
  if (btoa(binary) !== match[3]) return { value };
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const image = new Blob([bytes], { type: match[2] });
  delete value.dataUrl;
  return { value, image, prefix: match[1] };
}

async function unpackAttachment(stored) {
  if (!objectRecord(stored) || !objectRecord(stored.value)) throw new Error('Saved draft attachment is invalid');
  const value = copyAttachment(stored.value);
  if (stored.image !== undefined) {
    if (!(stored.image instanceof Blob) || typeof stored.prefix !== 'string'
      || !/^data:image\/[^;,]+;base64,$/.test(stored.prefix)) throw new Error('Saved draft image is invalid');
    const bytes = new Uint8Array(await stored.image.arrayBuffer());
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    }
    value.dataUrl = stored.prefix + btoa(parts.join(''));
  }
  return value;
}

async function unpackDraft(stored) {
  if (stored === undefined) return emptyDraft();
  if (!objectRecord(stored) || stored.version !== 1 || typeof stored.text !== 'string'
    || !Array.isArray(stored.attachments)) throw new Error('Saved draft is invalid');
  return { text: stored.text, attachments: await Promise.all(stored.attachments.map(unpackAttachment)) };
}

function indexedDBStore(factory) {
  let database = null;
  let opening = null;

  function open() {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const attempt = new Promise((resolve, reject) => {
      if (!factory?.open) { reject(new Error('IndexedDB is unavailable')); return; }
      let request;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error || new Error('Could not open the draft database'));
      };
      try { request = factory.open(DATABASE_NAME, 1); } catch (error) { fail(error); return; }
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        try {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        } catch (error) {
          try { request.transaction?.abort(); } catch { /* the request may already have aborted */ }
          fail(error);
        }
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('The draft database is blocked by another window'));
      request.onsuccess = () => {
        const opened = request.result;
        if (settled) { opened.close(); return; }
        settled = true;
        database = opened;
        opened.onversionchange = () => {
          opened.close();
          if (database === opened) database = null;
        };
        opened.onclose = () => { if (database === opened) database = null; };
        resolve(opened);
      };
    });
    opening = attempt;
    attempt.then(() => { if (opening === attempt) opening = null; }, () => { if (opening === attempt) opening = null; });
    return attempt;
  }

  async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      let failure;
      try { tx = db.transaction(STORE_NAME, mode); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('Draft database transaction was aborted'));
      // Request errors abort the transaction by default. Wait for that abort before
      // permitting the next queued operation to run against the database.
      tx.onerror = () => { failure ||= tx.error; };
      try {
        const request = operation(tx.objectStore(STORE_NAME));
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => { failure = request.error; };
      } catch (error) {
        failure = error;
        try { tx.abort(); } catch { reject(error); }
      }
    });
  }

  return {
    get: (key) => transaction('readonly', (store) => store.get(key)),
    put: (record) => transaction('readwrite', (store) => store.put(record)),
    remove: (key) => transaction('readwrite', (store) => store.delete(key)),
    close: () => { database?.close(); database = null; },
  };
}

/**
 * owner: { docId, mode: 'chat' | 'translate' }; absent mode means chat.
 * load returns a detached { text, attachments } or an empty draft for a missing key.
 * save/remove reject on failure; an unsuccessful operation never blocks later ones.
 * flush waits for earlier queued work and reports any unresolved write failure, even
 * if its save/remove promise was caught. Only a successful write to that same owner
 * clears the failure. Later operations are not included in the flush barrier.
 * close first stops accepting work, then drains the queue and closes the database.
 *
 * Optional test adapter: { get(key), put(record), remove(key), close() }. Its writes
 * must replace/delete one record atomically; the production adapter uses IndexedDB.
 */
export function createDraftPersistence({ windowId = 'main', indexedDB = globalThis.indexedDB, adapter = null } = {}) {
  const scope = String(windowId ?? 'main');
  const storage = adapter || indexedDBStore(indexedDB);
  const failedWrites = new Map();
  let tail = Promise.resolve();
  let closing = false;
  let closePromise = null;

  function enqueue(operation, writeKey = null, internal = false) {
    if (closing && !internal) return Promise.reject(new Error('Draft persistence is closed'));
    const result = tail.then(async () => {
      try {
        const value = await operation();
        if (writeKey !== null) failedWrites.delete(writeKey);
        return value;
      } catch (error) {
        if (writeKey !== null) failedWrites.set(writeKey, error);
        throw error;
      }
    });
    // Keep a separate recovered tail: callers still receive the original rejection.
    tail = result.catch(() => {});
    return result;
  }

  function load(owner) {
    const key = ownerKey(scope, owner);
    return enqueue(async () => unpackDraft(await storage.get(key)));
  }

  function save(owner, draft) {
    const key = ownerKey(scope, owner);
    let captured;
    let failure;
    try { captured = snapshot(draft); } catch (error) { failure = error; }
    return enqueue(async () => {
      if (failure) throw failure;
      if (!captured.text && !captured.attachments.length) { await storage.remove(key); return; }
      await storage.put({ key, version: 1, text: captured.text, attachments: captured.attachments.map(packAttachment) });
    }, key);
  }

  function remove(owner) {
    const key = ownerKey(scope, owner);
    return enqueue(async () => { await storage.remove(key); }, key);
  }

  function assertPersisted() {
    if (failedWrites.size) throw failedWrites.values().next().value;
  }

  function flush() {
    if (closing) return closePromise;
    return enqueue(assertPersisted);
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = enqueue(async () => {
      try { assertPersisted(); } finally { await storage.close(); }
    }, null, true);
    return closePromise;
  }

  return { load, save, remove, flush, close };
}
