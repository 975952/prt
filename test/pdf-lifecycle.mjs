/** Bounded PDF retirement and fail-closed ownership checks; no network or PDFs. */
import assert from 'node:assert/strict';
import { disposePdfDocument } from '../public/js/pdf-lifecycle.js';
const oldWorker = globalThis.Worker, oldLib = globalThis.pdfjsLib;
let count = 0;
const check = async (name, fn) => { await fn(); count++; console.log(`PASS ${name}`); };
const deferred = () => {
  const capability = Promise.withResolvers(); capability.promise.catch(() => {}); return capability;
};
class OwnedWorker { terminate() { this.terminated = true; } }
globalThis.Worker = OwnedWorker;
globalThis.pdfjsLib = { version: '6.3.289', TextLayer: { cleanup() {} } };
function stalledFixture() {
  const port = new OwnedWorker(), log = [];
  const worker = { port, destroyed: false, destroy() { log.push('worker'); this.port.terminate(); this.port = null; this.destroyed = true; } };
  const sink = { isCancelled: false, onCancel() { log.push('cancel-fetch'); }, error() { this.isCancelled = true; } };
  const controller = { isClosed: false, startCall: deferred(), pullCall: deferred(), cancelCall: deferred(), controller: { error() { log.push('reject-reader'); } } };
  const handler = { comObj: port, streamSinks: { one: sink }, streamControllers: { one: controller }, callbackCapabilities: { one: deferred() },
    actionHandler: { GetReader() {}, GetRangeReader() {} }, destroy() { log.push('handler'); } };
  const transport = { destroyed: false, messageHandler: handler, destroyCapability: deferred(),
    commonObjs: { clear() { log.push('common'); } }, fontLoader: { clear() { log.push('fonts'); } }, filterFactory: { destroy() { log.push('filters'); } } };
  const task = { destroyed: false, _transport: transport, _worker: worker,
    destroy() { this.destroyed = true; transport.destroyed = true; return transport.destroyCapability.promise; } };
  transport.loadingTask = task;
  const pdf = { loadingTask: task, _transport: transport };
  return { pdf, task, worker, port, transport, handler, sink, controller, log };
}
try {
  await check('uses loadingTask.destroy without a nonexistent PDFDocumentProxy.destroy and deduplicates owners', async () => {
    let calls = 0;
    const task = { async destroy() { calls++; this.destroyed = true; this._transport = null; this._worker = null; } };
    const pdf = { loadingTask: task };
    const first = disposePdfDocument(pdf), second = disposePdfDocument(task);
    assert.equal(first, second); assert.deepEqual(await first, { forced: false }); assert.equal(calls, 1);
  });
  await check('unfinished loading tasks and null resources are supported', async () => {
    assert.deepEqual(await disposePdfDocument(null), { forced: false });
    let called = false; await disposePdfDocument({ async destroy() { called = true; } }); assert.equal(called, true);
  });
  await check('stalled supported worker cancels real reader closures before terminating and rejects pending consumers', async () => {
    const fixture = stalledFixture();
    assert.deepEqual(await disposePdfDocument(fixture.pdf, { timeoutMs: 5 }), { forced: true });
    assert.equal(fixture.task.destroyed, true); assert.equal(fixture.port.terminated, true);
    assert.equal(fixture.task._transport, null); assert.equal(fixture.task._worker, null); assert.equal(fixture.worker.port, null);
    assert.deepEqual(fixture.log, ['cancel-fetch', 'handler', 'worker', 'reject-reader', 'common', 'fonts', 'filters']);
    await assert.rejects(fixture.controller.pullCall.promise, error => error.name === 'AbortException');
    assert.deepEqual(Object.keys(fixture.handler.callbackCapabilities), []);
  });
  await check('unknown vendor version fails closed without terminating a possibly shared worker or permitting mutation', async () => {
    const fixture = stalledFixture(); globalThis.pdfjsLib.version = 'unknown'; let moved = false;
    await assert.rejects((async () => { await disposePdfDocument(fixture.pdf, { timeoutMs: 5 }); moved = true; })());
    assert.equal(moved, false); assert.equal(fixture.port.terminated, undefined); assert.deepEqual(fixture.log, []);
    globalThis.pdfjsLib.version = '6.3.289';
  });
  await check('fake/shared or mismatched workers are never force-terminated', async () => {
    for (const corrupt of [fixture => { fixture.worker.port = {}; }, fixture => { fixture.handler.comObj = new OwnedWorker(); },
      fixture => { fixture.transport.loadingTask = {}; }, fixture => { fixture.pdf._transport = {}; }]) {
      const fixture = stalledFixture(); corrupt(fixture);
      await assert.rejects(disposePdfDocument(fixture.pdf, { timeoutMs: 5 })); assert.equal(fixture.port.terminated, undefined);
    }
  });
  await check('an unknown active reader cannot be silently skipped and missing public destroy is rejected', async () => {
    const fixture = stalledFixture(); delete fixture.sink.onCancel;
    await assert.rejects(disposePdfDocument(fixture.pdf, { timeoutMs: 5 }));
    assert.equal(fixture.port.terminated, undefined); assert.deepEqual(fixture.log, []);
    await assert.rejects(disposePdfDocument({ loadingTask: {} }));
  });
  console.log(`${count}/${count} PDF lifecycle checks passed.`);
} finally { globalThis.Worker = oldWorker; globalThis.pdfjsLib = oldLib; }
