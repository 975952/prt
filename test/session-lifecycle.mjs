import assert from 'node:assert/strict';
import { createSessionWriteQueue } from '../public/js/session-lifecycle.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// A pending snapshot must not arrive after the completed snapshot and regress it.
{
  const queue = createSessionWriteQueue(), gate = deferred(), started = deferred(), saved = [];
  const first = queue.enqueue('folder/A', async () => { started.resolve(); await gate.promise; saved.push('pending'); });
  await started.promise;
  const second = queue.enqueue('folder/A', async () => { saved.push('complete'); });
  const other = queue.enqueue('folder/B', async () => { saved.push('independent'); });
  await other;
  assert.deepEqual(saved, ['independent']);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(saved, ['independent', 'pending', 'complete']);
}

// Deletion waits for an in-flight write, skips already queued stale snapshots,
// and permits new writes only in the new lifecycle revision.
{
  const queue = createSessionWriteQueue(), gate = deferred(), started = deferred(), saved = [];
  const first = queue.enqueue('session', async () => { started.resolve(); await gate.promise; saved.push('old running'); });
  await started.promise;
  const oldRevision = queue.revision('session');
  const queued = queue.enqueue('session', async () => { saved.push('stale queued'); });
  queue.invalidate('session');
  const late = queue.enqueue('session', async () => { saved.push('stale late'); }, oldRevision);
  const deletion = queue.enqueue('session', async () => { saved.push('deleted'); });
  gate.resolve(); await Promise.all([first, queued, late, deletion]);
  assert.deepEqual(saved, ['old running', 'deleted']);
  await queue.enqueue('session', async () => { saved.push('new lifecycle'); });
  assert.equal(saved.at(-1), 'new lifecycle');
}

// A failed save cannot poison the next retry or another conversation's queue.
{
  const queue = createSessionWriteQueue();
  await assert.rejects(queue.enqueue('session', () => { throw new Error('offline'); }), /offline/);
  assert.equal(await queue.enqueue('session', () => 'retry succeeded'), 'retry succeeded');
  await queue.drain('session');
}

console.log('PASS session lifecycle: ordered saves, independent owners, stale invalidation, failed-save recovery');
