import assert from 'node:assert/strict';
import { createOrganizerHistory } from '../public/js/organizer-history.js';

function fixture() {
  let history = { revision: 0, records: [] }, failSave = false, lostMove = false, moves = 0;
  const folders = new Set(['Old', 'Old/Sub', 'Empty', 'Keep']);
  const files = new Map([['Old/Sub/a.pdf', { size: 10, mtime: 123 }], ['Keep/private.txt', { size: 5, mtime: 100 }]]);
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const parent = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const mkdir = path => { if (path) { mkdir(parent(path)); folders.add(path); } };
  const request = async (route, init = {}) => {
    const url = new URL(route, 'http://fixture');
    if (url.pathname === '/api/organizer-history') {
      if (!init.method) return reply(structuredClone(history));
      if (failSave) return reply({ error: { message: 'disk unavailable' } }, 500);
      const body = JSON.parse(init.body);
      assert.equal(body.revision, history.revision);
      history = { ...body, revision: body.revision + 1 };
      return reply({ revision: history.revision });
    }
    if (url.pathname === '/api/papers') return reply({ folders: [...folders].map(path => ({ path })),
      papers: [...files].filter(([path]) => path.endsWith('.pdf')).map(([path, value]) => ({ path, name: path.split('/').pop(), ...value })) });
    if (init.method === 'DELETE') {
      const path = url.searchParams.get('path');
      if ([...files.keys()].some(file => file.startsWith(path + '/'))) return reply({}, 409);
      for (const dir of folders) if (dir === path || dir.startsWith(path + '/')) folders.delete(dir);
      return reply({ ok: true });
    }
    if (init.method === 'POST') { mkdir([url.searchParams.get('parent'), url.searchParams.get('name')].filter(Boolean).join('/')); return reply({ ok: true }); }
    throw Error(route);
  };
  const movePaper = async ({ from, to }) => {
    moves++;
    // Intent must be persisted before any filesystem mutation.
    assert.ok(history.records.some(record => record.entries.some(entry => ['moving', 'restoring'].includes(entry.state))));
    const target = [to, from.split('/').pop()].filter(Boolean).join('/');
    if (!files.has(from) || files.has(target)) throw Error('conflict');
    mkdir(to); files.set(target, files.get(from)); files.delete(from);
    if (lostMove) { lostMove = false; throw Error('lost response'); }
    return { moved: true, to: target };
  };
  const create = () => createOrganizerHistory({ request, movePaper, lock: work => work() });
  return { create, files, folders, request, get history() { return history; }, get moves() { return moves; },
    failSave(value) { failSave = value; }, loseResponse() { lostMove = true; } };
}
const tasks = [{ from: 'Old/Sub/a.pdf', to: 'New' }];
async function apply(f) { return f.create().runBatch(tasks, async move => { for (const task of tasks) await move(task); }, { all: true }); }
let checks = 0;
async function test(name, work) { await work(); checks++; console.log(`PASS ${name}`); }
await test('replacement removes old empty categories, preserves other files, and reload rollback restores the exact tree', async () => {
  const f = fixture(); const result = await apply(f);
  assert.deepEqual([...f.files.keys()].sort(), ['Keep/private.txt', 'New/a.pdf']);
  assert.ok(!f.folders.has('Old')); assert.ok(!f.folders.has('Empty')); assert.deepEqual(result.retained, ['Keep']);
  const restored = await f.create().rollback(); assert.equal(restored.restored, 1); assert.deepEqual(restored.conflicts, []);
  assert.ok(f.files.has('Old/Sub/a.pdf')); assert.ok(f.folders.has('Empty')); assert.ok(!f.folders.has('New'));
  assert.equal(f.history.records[0].status, 'restored');
});
await test('journal write failure prevents all moves and leaves previous records intact', async () => {
  const f = fixture(); f.failSave(true); await assert.rejects(apply(f));
  assert.equal(f.moves, 0); assert.ok(f.files.has('Old/Sub/a.pdf')); assert.equal(f.history.records.length, 0);
});
await test('lost move response is recovered after reopening instead of losing the rollback', async () => {
  const f = fixture(); f.loseResponse(); await assert.rejects(apply(f));
  assert.equal(f.history.records[0].entries[0].state, 'moving'); assert.ok(f.files.has('New/a.pdf'));
  await assert.rejects(apply(f), /上次整理|previous operation/);
  await f.create().rollback(); assert.ok(f.files.has('Old/Sub/a.pdf')); assert.ok(!f.files.has('New/a.pdf'));
});
await test('rollback preserves conflicting and modified files and supports retry after resolving the conflict', async () => {
  const f = fixture(); await apply(f);
  f.files.set('Old/Sub/a.pdf', { size: 999, mtime: 999 });
  let result = await f.create().rollback(); assert.equal(result.conflicts.length, 1); assert.equal(f.files.get('Old/Sub/a.pdf').size, 999);
  f.files.delete('Old/Sub/a.pdf'); f.files.get('New/a.pdf').mtime = 1000;
  result = await f.create().rollback(); assert.equal(result.conflicts.length, 1); assert.ok(f.files.has('New/a.pdf'));
  f.files.get('New/a.pdf').mtime = 123;
  result = await f.create().rollback(); assert.deepEqual(result.conflicts, []); assert.ok(f.files.has('Old/Sub/a.pdf'));
});
await test('consecutive classifications unwind newest-first and preserve preexisting destinations', async () => {
  const f = fixture(); f.folders.add('New'); await apply(f);
  await f.create().runBatch([{ from: 'New/a.pdf', to: 'Final' }], move => move({ from: 'New/a.pdf', to: 'Final' }), { all: true });
  await f.create().rollback(); assert.ok(f.files.has('New/a.pdf'));
  await f.create().rollback(); assert.ok(f.files.has('Old/Sub/a.pdf')); assert.ok(f.folders.has('New')); assert.ok(!f.folders.has('Final'));
});
console.log(`${checks}/${checks} organizer history checks passed.`);
