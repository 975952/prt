import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stopChild, waitForBase } from './_exe.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'session-memory-'));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data'));
const papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir);
fs.mkdirSync(papersDir);
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' },
  windowsHide: true,
  stdio: 'ignore',
});

const base = await waitForBase({ ports: [port], papersDir });
assert(base, 'isolated server starts');
const sid = 'memory-regression';
const url = `${base}/api/session?${new URLSearchParams({ doc: 'memory-test', sid })}`;
const request = (method, body, target = url) => fetch(target, {
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const read = async target => {
  const response = await fetch(target);
  assert.equal(response.status, 200);
  return response.json();
};

try {
  assert.equal((await request('POST', { entries: [{ id: 'question-1', text: 'keep this chat' }], history: [] })).status, 200);
  const added = { id: 'mem-one', content: 'Remember the key result', category: 'note', createdAt: 100, updatedAt: 100 };
  assert.equal((await request('PATCH', { memoryOp: { action: 'add', memory: added } })).status, 200);
  let saved = await read(url);
  assert.equal(saved.entries[0].text, 'keep this chat');
  assert.deepEqual(saved.memories.map(memory => memory.id), ['mem-one']);

  const edited = { ...added, content: 'The edited result', category: 'reference' };
  assert.equal((await request('PATCH', { memoryOp: { action: 'edit', memory: edited } })).status, 200);
  saved = await read(url);
  assert.equal(saved.memories[0].content, 'The edited result');
  assert.equal(saved.memories[0].category, 'reference');

  assert.equal((await request('PATCH', { memoryOp: { action: 'remove', memory: { id: 'mem-one' } } })).status, 200);
  saved = await read(url);
  assert.equal(saved.memories, undefined, 'removing the last item leaves an explicit empty memory state');
  assert.equal((await request('POST', { entries: [{ id: 'question-2', text: 'next chat save' }] })).status, 200);
  assert.equal((await read(url)).memories, undefined, 'chat merge cannot resurrect a removed memory');

  const newSid = 'memory-created-empty';
  const emptyUrl = `${base}/api/session?${new URLSearchParams({ doc: 'memory-test', sid: newSid })}`;
  const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) => request('PATCH', {
    memoryOp: { action: 'add', memory: { id: `mem-${index}`, content: `Concurrent ${index}`, category: 'note' } },
  }, emptyUrl)));
  assert(concurrent.every(response => response.status === 200), 'concurrent memory additions succeed');
  saved = await read(emptyUrl);
  assert.equal(saved.entries.length, 0, 'adding a memory creates an otherwise empty conversation');
  assert.equal(saved.memories.length, 12, 'concurrent memory additions are serialized without loss');

  assert.equal((await request('PATCH', { memoryOp: { action: 'clear' } }, emptyUrl)).status, 200);
  assert.equal((await read(emptyUrl)).memories, undefined, 'clear removes every memory');
  assert.equal((await request('PATCH', { memoryOp: { action: 'add', memory: { id: 'bad', content: '  ' } } }, emptyUrl)).status, 400);
  console.log('PASS session memory: add, edit, remove, clear, empty-session creation, and concurrent writes');
} finally {
  await stopChild(child);
}
