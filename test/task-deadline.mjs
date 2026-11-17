/** Cancellation/deadline behavior when a provider ignores AbortSignal. */
import assert from 'node:assert/strict';
import { runWithDeadline } from '../public/js/task-deadline.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const bounded = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Test deadline exceeded')), 1500); })]); }
  finally { clearTimeout(timer); }
};

await check('already stopped operations never start', async () => {
  const ctl = new AbortController(); ctl.abort(); let called = false;
  await assert.rejects(runWithDeadline(() => { called = true; }, { signal: ctl.signal }), { name: 'AbortError' });
  assert.equal(called, false);
});
await check('stop before the operation microtask prevents work', async () => {
  const ctl = new AbortController(); let called = false;
  const pending = runWithDeadline(() => { called = true; }, { signal: ctl.signal }); ctl.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(called, false);
});
await check('deadline rejects a hung provider and aborts its child signal', async () => {
  const late = deferred(); let child;
  const pending = runWithDeadline(signal => { child = signal; return late.promise; }, { timeoutMs: 25 });
  await assert.rejects(bounded(pending), { name: 'TimeoutError' }); assert.equal(child.aborted, true);
  late.resolve('obsolete answer'); await tick();
  await assert.rejects(pending, { name: 'TimeoutError' });
});
await check('manual stop releases a hung provider immediately and rejects late success', async () => {
  const ctl = new AbortController(), late = deferred(); let child;
  const pending = runWithDeadline(signal => { child = signal; return late.promise; }, { signal: ctl.signal, timeoutMs: 1000 });
  await tick(); ctl.abort(); await assert.rejects(bounded(pending), { name: 'AbortError' });
  assert.equal(child.aborted, true); late.resolve('obsolete answer'); await tick();
});
await check('late provider rejection remains handled after cancellation', async () => {
  const ctl = new AbortController(), late = deferred(), unhandled = [];
  const onUnhandled = error => unhandled.push(error); process.on('unhandledRejection', onUnhandled);
  try {
    const pending = runWithDeadline(() => late.promise, { signal: ctl.signal });
    await tick(); ctl.abort(); await assert.rejects(pending, { name: 'AbortError' });
    late.reject(Error('late upstream failure')); await tick(); await tick(); assert.deepEqual(unhandled, []);
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});
await check('a completed operation is not later cancelled by its former parent', async () => {
  const ctl = new AbortController(); let child;
  assert.equal(await runWithDeadline(signal => { child = signal; return 'kept'; }, { signal: ctl.signal }), 'kept');
  ctl.abort(); assert.equal(child.aborted, false);
});
await check('one conversation timing out does not cancel another operation', async () => {
  const other = deferred(); let otherSignal;
  const expired = runWithDeadline(() => new Promise(() => {}), { timeoutMs: 25 });
  const active = runWithDeadline(signal => { otherSignal = signal; return other.promise; }, { timeoutMs: 1000 });
  await assert.rejects(expired, { name: 'TimeoutError' }); assert.equal(otherSignal.aborted, false);
  other.resolve('other conversation'); assert.equal(await active, 'other conversation');
});
await check('synchronous failures and explicit timeout reasons retain their identities', async () => {
  const failure = Error('source load failed'); await assert.rejects(runWithDeadline(() => { throw failure; }), error => error === failure);
  const timeout = Object.assign(Error('request deadline'), { name: 'TimeoutError' }), ctl = new AbortController();
  ctl.abort(timeout); await assert.rejects(runWithDeadline(() => null, { signal: ctl.signal }), error => error === timeout);
});
console.log(`Task deadlines: ${passed}/${passed} passed`);
