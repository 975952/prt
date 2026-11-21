/** Session memory contract against isolated Node/Rust storage. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild, waitForBase, READER_PORTS } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `session-memory-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data'));
const papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir);
fs.mkdirSync(papersDir);
const env = { ...process.env, PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
  PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
let child, base;
const desktopExe = desktop ? stageExe('session-memory').exe : null;
async function start() {
  if (desktop) {
    child = spawnReader(desktopExe, { env });
    base = await waitForBase({ ports: READER_PORTS, papersDir });
  } else {
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: { ...env, PORT: String(port) }, windowsHide: true, stdio: 'ignore',
    });
    base = await waitForBase({ ports: [port], papersDir });
  }
  assert(base, 'isolated server starts');
}
const route = (sid, doc = 'memory-test') => '/api/session?' + new URLSearchParams({ doc, sid });
const request = (method, body, target) => fetch(base + target, {
  method, headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const read = async target => {
  const response = await fetch(base + target);
  assert.equal(response.status, 200);
  return response.json();
};
let checks = 0;
const pass = label => { checks++; console.log('PASS ' + label); };
const success = async (method, body, target) => {
  const response = await request(method, body, target);
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
};
const writeMemory = (action, memory, target) => success('PATCH', { memoryOp: { action, memory } }, target);

try {
  await start();
  const sid = 'memory-regression', url = route(sid);
  await success('POST', { entries: [{ id: 'question-1', text: 'keep this chat' }], history: [] }, url);
  const added = { id: 'mem-one', content: 'Remember the key result', category: 'note',
    createdAt: 1795000000000, updatedAt: 1795000000000 };
  await writeMemory('add', added, url);
  let saved = await read(url);
  assert.equal(saved.entries[0].text, 'keep this chat');
  assert.deepEqual(saved.memories.map(memory => memory.id), ['mem-one']);
  const edited = { ...added, content: 'The edited result', category: 'reference' };
  await writeMemory('edit', edited, url);
  saved = await read(url);
  assert.equal(saved.memories[0].content, 'The edited result');
  assert.equal(saved.memories[0].category, 'reference');
  assert.equal(saved.memories[0].createdAt, added.createdAt);
  pass('add/edit persist without changing messages or the creation timestamp');

  await success('POST', { entries: [], history: [] }, url);
  assert.equal((await read(url)).memories[0].content, 'The edited result');
  await writeMemory('remove', { id: 'mem-one' }, url);
  assert.equal((await read(url)).memories, undefined);
  await success('POST', { entries: [{ id: 'question-2', text: 'next chat save' }] }, url + '&merge=1');
  assert.equal((await read(url)).memories, undefined);
  pass('clearing chat preserves memories; removing the last memory survives later chat saves');

  const newSid = 'memory-created-empty', emptyUrl = route(newSid, 'memory-local-owner');
  const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) => request('PATCH', {
    memoryOp: { action: 'add', memory: { id: `mem-${index}`, content: `Concurrent ${index}`, category: 'note' } },
  }, emptyUrl)));
  assert(concurrent.every(response => response.status === 200));
  saved = await read(emptyUrl);
  assert.equal(saved.entries.length, 0);
  assert.equal(saved.memories.length, 12);
  const owner = saved.storageDoc;
  const listing = await read('/api/sessions?' + new URLSearchParams({ doc: 'memory-local-owner', scope: 'folder' }));
  assert(listing.sessions.some(row => row.sid === newSid), 'memory-only conversation retains its requested owner');
  assert.equal((await read('/api/session?' + new URLSearchParams({ sid: newSid }))).memories.length, 12);
  pass('concurrent first additions create one owned conversation and are readable by SID');

  await writeMemory('clear', undefined, emptyUrl);
  assert.equal((await read(emptyUrl)).memories, undefined);
  await success('PATCH', { memories: [added, { ...added, id: 'mem-two' }] }, emptyUrl);
  assert.equal((await read(emptyUrl)).memories.length, 2);
  await success('PATCH', { memories: [] }, emptyUrl);
  assert.equal((await read(emptyUrl)).memories, undefined);
  pass('clear and collection replacement persist including an empty replacement');

  for (const memoryOp of [
    { action: 'add', memory: { id: 'bad', content: '  ' } },
    { action: 'remove', memory: { id: '../bad' } },
    { action: 'unknown' },
  ]) assert.equal((await request('PATCH', { memoryOp }, emptyUrl)).status, 400);
  assert.equal((await request('PATCH', { memories: {} }, emptyUrl)).status, 400);
  assert.equal((await request('PATCH', { memoryOp: { action: 'edit', memory: added } }, route('does-not-exist'))).status, 404);
  assert.equal((await read(emptyUrl)).memories, undefined);
  pass('invalid operations and edits to missing records fail without changing storage');

  const legacySid = 'legacy-memory', legacyName = `session-${owner}-${legacySid}.json`;
  const legacy = { storageSid: legacySid, storageDoc: owner, entries: [{ id: 'legacy-question', text: 'Legacy chat' }],
    memories: [{ ...added, id: 'legacy-original' }] };
  fs.writeFileSync(path.join(dataDir, legacyName), JSON.stringify(legacy), 'utf8');
  await writeMemory('add', { ...added, id: 'legacy-added' }, route(legacySid, 'memory-local-owner'));
  saved = await read('/api/session?' + new URLSearchParams({ sid: legacySid }));
  assert.equal(saved.entries[0].text, 'Legacy chat');
  assert.equal(saved.memories.length, 2);
  assert.equal(saved.storageDoc, owner);
  assert(fs.existsSync(path.join(dataDir, `session-${legacySid}.json`)), 'legacy write migrates to the shared SID record');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, legacyName), 'utf8')), legacy, 'legacy source remains recoverable');
  pass('legacy scoped records migrate on a memory write without losing chat, memories, or owner');

  await writeMemory('add', { ...added, content: 'Survives restart' }, emptyUrl);
  await stopChild(child);
  await start();
  assert.equal((await read(emptyUrl)).memories[0].content, 'Survives restart');
  assert.equal((await read(url)).memories, undefined);
  assert.equal((await read(route(legacySid))).memories.length, 2);
  await success('DELETE', undefined, emptyUrl);
  assert.equal((await request('PATCH', { memoryOp: { action: 'add', memory: added } }, emptyUrl)).status, 409);
  assert.equal((await read(emptyUrl)).deleted, true);
  pass('restart restores persisted memories and conversation deletion rejects a stale memory write');
  console.log(`Session memory: ${checks}/${checks} passed (${desktop ? 'desktop HTTP' : 'Node HTTP'})`);
} finally {
  await stopChild(child);
}
