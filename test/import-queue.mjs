import assert from 'node:assert/strict';
import { createImportQueue } from '../public/js/import-queue.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await wait(5); assert.ok(predicate()); };
const pending = [], order = [], duplicates = [], completed = [];
let active = 0, peak = 0;
const queue = createImportQueue({
  run: async (task, update) => {
    active++; peak = Math.max(peak, active); order.push(task.name); update('converting');
    try { return await new Promise((resolve, reject) => pending.push({ resolve, reject })); }
    finally { active--; }
  },
  duplicate: task => duplicates.push(task.name), completed: task => completed.push(task.name),
});
const file = name => ({ name, size: 5, lastModified: 1 });
queue.add([file('a.pptx')]);
queue.add([file('b.pptx'), file('c.pdf')]);
queue.add([file('a.pptx')]);
assert.equal(queue.tasks.length, 3, 'repeated additions are deduplicated while pending');
assert.deepEqual(duplicates, ['a.pptx']);
assert.deepEqual(order, ['a.pptx'], 'later drops do not start competing uploads');
assert.equal(queue.tasks[1].status, 'queued');
pending[0].resolve({ name: 'a.pdf' });
await until(() => pending.length === 2);
assert.equal(queue.tasks[0].status, 'done');
assert.equal(queue.tasks[0].file, null, 'successful imports release source bytes');
pending[1].reject(new Error('bad file'));
await until(() => pending.length === 3);
assert.equal(queue.tasks[1].status, 'failed');
pending[2].resolve({ name: 'c.pdf' });
await until(() => !queue.hasPending());
queue.retry(queue.tasks[1]);
await until(() => pending.length === 4);
pending[3].resolve({ name: 'b.pdf' });
await until(() => !queue.hasPending());
assert.equal(peak, 1, 'at most one upload/conversion runs');
assert.deepEqual(order, ['a.pptx', 'b.pptx', 'c.pdf', 'b.pptx']);
assert.deepEqual(completed, ['a.pptx', 'c.pdf', 'b.pptx']);
queue.clearFinished(); assert.equal(queue.tasks.length, 0);
console.log('PASS import queue: repeated drops, pending deduplication, FIFO, failure continuation, retry, result retention and cleanup');
