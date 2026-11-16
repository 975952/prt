/** Pure queue lifecycle tests. No DOM, storage, network, screenshots or real model calls. */
import assert from 'node:assert/strict';
import { createTranslationBatch, runTranslationBatch, stopTranslationBatch } from '../public/js/translation-queue.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const make = (count = 3) => createTranslationBatch({ docId: 'doc-a', sid: 'sid-a', targetLang: 'English',
  items: Array.from({ length: count }, (_, index) => ({ id: `source-${index}`, kind: 'image', label: `Image ${index + 1}` })) });

await check('captures immutable ownership and stable unique item ids without deep-cloning app entries', async () => {
  const entry = { node: 'app-owned' };
  const items = [{ id: 'same', entry, status: 'complete' }, { id: 'same' }];
  const batch = createTranslationBatch({ docId: 'a', sid: 's', targetLang: '中文', items });
  assert.notEqual(batch.items, items);
  assert.notEqual(batch.items[0], items[0]);
  assert.equal(batch.items[0].entry, entry);
  assert.equal(batch.items[0].status, 'pending');
  assert.notEqual(batch.items[0].id, batch.items[1].id);
  for (const key of ['id', 'docId', 'sid', 'targetLang']) assert.throws(() => { batch[key] = 'changed'; }, TypeError);
  assert.throws(() => { batch.items[0].id = 'changed'; }, TypeError);
  batch.items[0].refId = 'saved-image';
  assert.equal(items[0].refId, undefined);
  assert.equal(items[0].status, 'complete');
  assert.equal(batch.running, false);
});

await check('runs strictly in order with one controller and skips completed items', async () => {
  const batch = make();
  batch.items[1].status = 'complete';
  const calls = [];
  const signals = [];
  let active = 0;
  await runTranslationBatch(batch, { runItem: async (item, { signal }) => {
    assert.equal(++active, 1);
    calls.push(item.id); signals.push(signal);
    await Promise.resolve();
    active--;
    return { status: 'complete' };
  } });
  assert.deepEqual(calls, ['source-0', 'source-2']);
  assert.equal(signals[0], signals[1]);
  assert.equal(batch.status, 'complete');
  assert.equal(batch.running, false);
  assert.equal(stopTranslationBatch(batch), false);
});

await check('a stop in the gap after item completion prevents the next item from starting', async () => {
  const batch = make();
  const calls = [];
  let stopped = false;
  await runTranslationBatch(batch, {
    runItem: async (item) => { calls.push(item.id); return { status: 'complete' }; },
    onChange: (value) => {
      if (!stopped && value.items[0].status === 'complete' && value.items[1].status === 'pending') {
        stopped = true;
        stopTranslationBatch(value, 'user');
      }
    },
  });
  assert.deepEqual(calls, ['source-0']);
  assert.deepEqual(batch.items.map((item) => item.status), ['complete', 'pending', 'pending']);
  assert.equal(batch.status, 'paused');
  assert.equal(batch.reason, 'user');
  assert.equal(batch.controller.signal.aborted, true);
});

await check('stop before the first request and stop while a request ignores its signal both hold the queue', async () => {
  const before = make();
  let calls = 0;
  await runTranslationBatch(before, {
    runItem: async () => { calls++; return { status: 'complete' }; },
    onChange: (batch) => { if (batch.status === 'running') stopTranslationBatch(batch); },
  });
  assert.equal(calls, 0);
  const batch = make();
  const gate = deferred();
  const running = runTranslationBatch(batch, { runItem: async (_item, { signal }) => {
    calls++;
    await gate.promise;
    assert.equal(signal.aborted, true);
    return { status: 'complete' };
  } });
  stopTranslationBatch(batch, 'document-switch');
  assert.equal(batch.running, true);
  gate.resolve();
  await running;
  assert.equal(calls, 1);
  assert.equal(batch.items[0].status, 'stopped');
  assert.equal(batch.items[1].status, 'pending');
  assert.equal(batch.reason, 'document-switch');
  assert.equal(batch.running, false);
});

await check('returned failure and thrown failure stop the whole batch', async () => {
  for (const throws of [false, true]) {
    const batch = make();
    const calls = [];
    await runTranslationBatch(batch, { runItem: async (item) => {
      calls.push(item.id);
      if (item.id === 'source-1') {
        if (throws) throw new Error('upstream offline');
        return { status: 'failed', error: 'upstream offline' };
      }
      return { status: 'complete' };
    } });
    assert.deepEqual(calls, ['source-0', 'source-1']);
    assert.equal(batch.status, 'failed');
    assert.equal(batch.reason, 'item-failed');
    assert.equal(batch.items[1].error, 'upstream offline');
    assert.equal(batch.items[2].status, 'pending');
  }
});

await check('explicit resume uses a fresh controller and retries only incomplete items', async () => {
  const batch = make();
  const calls = [];
  let firstRun = true;
  const runItem = async (item) => {
    calls.push(item.id);
    return firstRun && item.id === 'source-1' ? { status: 'failed', error: 'retryable' } : { status: 'complete' };
  };
  await runTranslationBatch(batch, { runItem });
  const previous = batch.controller;
  firstRun = false;
  await runTranslationBatch(batch, { runItem });
  assert.notEqual(batch.controller, previous);
  assert.equal(batch.controller.signal.aborted, false);
  assert.deepEqual(calls, ['source-0', 'source-1', 'source-1', 'source-2']);
  assert.equal(batch.status, 'complete');
  assert.equal(batch.items[1].error, undefined);
  assert.equal(batch.error, '');
});

await check('concurrent runs are rejected even after stop while the earlier run is still settling', async () => {
  const batch = make();
  const gate = deferred();
  let calls = 0;
  const runItem = async () => { calls++; await gate.promise; return { status: 'complete' }; };
  const first = runTranslationBatch(batch, { runItem });
  await assert.rejects(runTranslationBatch(batch, { runItem }), { name: 'TranslationBatchBusyError' });
  stopTranslationBatch(batch);
  await assert.rejects(runTranslationBatch(batch, { runItem }), { name: 'TranslationBatchBusyError' });
  gate.resolve();
  await first;
  assert.equal(calls, 1);
  await runTranslationBatch(batch, { runItem: async () => ({ status: 'complete' }) });
  assert.equal(batch.status, 'complete');
});

await check('an obsolete document prevents work before start and discards a late completion', async () => {
  const before = make();
  let calls = 0;
  await runTranslationBatch(before, { isCurrent: () => false,
    runItem: async () => { calls++; return { status: 'complete' }; } });
  assert.equal(calls, 0);
  assert.equal(before.reason, 'context-changed');
  const batch = make();
  let current = true;
  const gate = deferred();
  const running = runTranslationBatch(batch, { isCurrent: () => current,
    runItem: async () => { calls++; await gate.promise; return { status: 'complete' }; } });
  current = false;
  gate.resolve();
  await running;
  assert.equal(calls, 1);
  assert.equal(batch.status, 'paused');
  assert.equal(batch.reason, 'context-changed');
  assert.equal(batch.items[0].status, 'stopped');
  assert.equal(batch.items[1].status, 'pending');
  assert.equal(batch.controller.signal.aborted, true);
});

await check('document change between items also stops without a manual abort', async () => {
  const batch = make();
  let current = true;
  const calls = [];
  await runTranslationBatch(batch, {
    isCurrent: () => current,
    runItem: async (item) => { calls.push(item.id); return { status: 'complete' }; },
    onChange: (value) => { if (value.items[0].status === 'complete') current = false; },
  });
  assert.deepEqual(calls, ['source-0']);
  assert.equal(batch.status, 'paused');
  assert.equal(batch.reason, 'context-changed');
});

await check('a stopped result or AbortError cannot fall through to the next screenshot', async () => {
  for (const throws of [false, true]) {
    const batch = make();
    let calls = 0;
    await runTranslationBatch(batch, { runItem: async () => {
      calls++;
      if (throws) throw new DOMException('Cancelled', 'AbortError');
      return { status: 'stopped', reason: 'user' };
    } });
    assert.equal(calls, 1);
    assert.equal(batch.status, 'paused');
    assert.equal(batch.items[0].status, 'stopped');
    assert.equal(batch.items[1].status, 'pending');
    assert.equal(batch.controller.signal.aborted, true);
  }
});

await check('invalid result fails closed and an empty or completed batch completes without calls', async () => {
  const invalid = make();
  await runTranslationBatch(invalid, { runItem: async () => undefined });
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.items[1].status, 'pending');
  let calls = 0;
  for (const batch of [make(0), make(2)]) {
    batch.items.forEach((item) => { item.status = 'complete'; });
    await runTranslationBatch(batch, { runItem: async () => { calls++; return { status: 'complete' }; } });
    assert.equal(batch.status, 'complete');
    assert.equal(batch.running, false);
  }
  assert.equal(calls, 0);
});

console.log(`\n${passed} translation queue checks passed.`);
