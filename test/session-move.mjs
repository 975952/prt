/** Single-conversation transfer contract against isolated Node/Rust HTTP storage.
 * node test/session-move.mjs [--desktop] (EXE may point at target/release/prt.exe)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, stopChild, waitForBase, READER_PORTS } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `session-move-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const serverLog = path.join(scratch, 'server.log');
const serverLogFd = fs.openSync(serverLog, 'w');
console.log(`Session move service log: ${serverLog}`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
let child, base, checks = 0;
const pass = name => { checks++; console.log(`PASS ${name}`); };
const session = (doc, sid, merge = false) => `/api/session?${new URLSearchParams({ doc, sid, ...(merge ? { merge: '1' } : {}) })}`;
const request = (route, body, method = 'POST') => fetch(`${base}${route}`, {
  method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
const read = async route => { const response = await fetch(`${base}${route}`); assert.equal(response.status, 200); return response.json(); };
const write = async (doc, sid, body) => assert.equal((await request(session(doc, sid), body)).status, 200);
const seed = async (doc, sid, extra = {}) => write(doc, sid, { entries: [{ id: 'seed', kind: 'user', block: 'chat', text: 'Seed', status: 'user' }], history: [], ops: [], ...extra });
const move = async (fromDoc, fromSid, toDoc, toSid, expected = 200, folderPath = '/target') => {
  const response = await request('/api/sessions/move', { fromDoc, fromSid, toDoc, toSid, folderPath });
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
};
const list = doc => read(`/api/sessions?${new URLSearchParams({ doc, scope: 'folder', archived: 'all' })}`);
const upload = async (doc, sid) => {
  const response = await fetch(`${base}/api/attachment?${new URLSearchParams({ doc, sid })}`, { method: 'POST', body: png });
  assert.equal(response.status, 200); return (await response.json()).id;
};
const image = async (doc, sid, id) => {
  const response = await fetch(`${base}/api/attachment?${new URLSearchParams({ doc, sid, id })}`);
  assert.equal(response.status, 200, `${doc}/${sid}/${id}`); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
};

try {
  const env = { ...process.env, PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  if (desktop) {
    child = spawn(stageExe('session-move').exe, ['--background'], {
      env: { ...env, PRT_BACKGROUND: '1' }, windowsHide: true, stdio: ['ignore', serverLogFd, serverLogFd],
    });
    base = await waitForBase({ ports: READER_PORTS, papersDir });
  } else {
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: { ...env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', serverLogFd, serverLogFd],
    });
    base = await waitForBase({ ports: [port], papersDir });
  }
  assert(base, 'isolated service starts');
  assert.equal(path.resolve((await read('/api/papers')).dir), path.resolve(papersDir));
  const fromDoc = '__global__', fromSid = '', toDoc = 'target-paper.pdf', toSid = 'moved-paper';
  const localImage = await upload(fromDoc, fromSid), externalDoc = 'Original evidence.pdf';
  const externalImage = await upload(externalDoc, fromSid);
  const retry = { kind: 'chat', question: 'A source question', inputValue: 'A source question', docId: externalDoc,
    docTitle: 'Original evidence', firstPage: 3, attachmentDoc: fromDoc, attachmentSid: fromSid,
    composerOwner: { docId: 'agent:default:new', mode: 'chat' },
    attachments: [{ kind: 'image', id: localImage, draftId: 'draft-one', w: 1, h: 1, page: 3 }] };
  await seed(fromDoc, fromSid, {
    title: 'Preserve my title', titleSource: 'user', summary: 'Summary retained', summaryCovered: 2,
    summaryPrompt: 'Custom summary', createdAt: 1700000000000, updatedAt: 1700000000010,
    pinned: true, archived: true, customMeta: { retained: true }, folderPath: '/old',
    docIds: [externalDoc], docTitles: ['Original evidence'], teaching: { retained: true },
    entries: [
      { id: 'explicit-user', block: 'chat', kind: 'user', text: 'A source question', docId: externalDoc, page: 3,
        attachmentDoc: fromDoc, attachmentSid: fromSid, shots: [{ id: localImage, page: 3, w: 1, h: 1 }] },
      { id: 'explicit-answer', block: 'chat', kind: 'assistant', text: 'Partial answer', status: 'failed', docId: externalDoc, page: 3, retry },
      { id: 'old-user', block: 'chat', kind: 'user', text: 'Old paper image', docId: externalDoc, page: 4, shots: [{ id: externalImage }] },
      { id: 'old-answer', block: 'chat', kind: 'assistant', text: 'Old answer', status: 'complete', retry: {
        kind: 'chat', docId: externalDoc, firstPage: 4, attachments: [{ kind: 'image', id: externalImage }] } },
      { id: 'old-scope-user', block: 'chat', kind: 'user', text: 'Scope-stored old image', docId: externalDoc, page: 5, shots: [{ id: localImage }] },
    ], history: [{ role: 'user', content: 'A source question', docId: externalDoc, page: 3 }], ops: [{ id: 'op', text: 'Operation retained' }],
  });
  const before = await read(session(fromDoc, fromSid));
  const alias = (await list(fromDoc)).sessions.find(row => row.sid === fromSid).fileKey;
  const result = await move(fromDoc, fromSid, toDoc, toSid);
  const saved = await read(session(toDoc, toSid));
  for (const key of ['title', 'titleSource', 'summary', 'summaryCovered', 'summaryPrompt', 'createdAt', 'updatedAt', 'pinned', 'archived',
    'customMeta', 'docIds', 'docTitles', 'teaching', 'history', 'ops', 'contentRev']) assert.deepEqual(saved[key], before[key], key);
  assert.equal(saved.folderPath, '/target'); assert.deepEqual(saved.draftOwner, result.draftOwner);
  assert.match(saved.draftOwner.docId, /^session:.*:moved-paper$/);
  for (const entry of saved.entries) {
    const original = before.entries.find(row => row.id === entry.id);
    assert.equal(entry.docId, original.docId); assert.equal(entry.page, original.page);
    if (entry.retry) {
      assert.equal(entry.retry.docId, original.retry.docId); assert.equal(entry.retry.firstPage, original.retry.firstPage);
      assert.deepEqual(entry.retry.composerOwner, saved.draftOwner);
    }
  }
  for (const id of ['explicit-user', 'old-scope-user']) {
    const row = saved.entries.find(row => row.id === id); assert.equal(row.attachmentDoc, toDoc); assert.equal(row.attachmentSid, toSid);
  }
  assert.equal(saved.entries[1].retry.attachmentDoc, toDoc); assert.equal(saved.entries[1].retry.attachmentSid, toSid);
  for (const owner of [saved.entries[2], saved.entries[3].retry]) {
    assert.equal(owner.attachmentDoc, externalDoc); assert.equal(owner.attachmentSid, fromSid);
  }
  await image(toDoc, toSid, localImage); await image(externalDoc, fromSid, externalImage);
  for (const doc of [fromDoc, alias]) {
    assert.equal((await read(session(doc, fromSid))).deleted, true);
    for (const method of ['POST', 'PATCH']) assert.equal((await request(session(doc, fromSid, true), method === 'POST' ? before : { title: 'Late rename' }, method)).status, 409);
    assert(!(await list(doc)).sessions.some(row => row.sid === fromSid));
  }
  assert.equal((await request(session(fromDoc, fromSid), undefined, 'DELETE')).status, 200);
  await image(toDoc, toSid, localImage);
  pass('legacy empty-sid global transfer preserves metadata, evidence, independent drafts and exact screenshot bytes; source aliases reject late saves');

  await move(toDoc, toSid, 'folder-move-12345678', 'moved-folder', 200, '/folder');
  await image('folder-move-12345678', 'moved-folder', localImage);
  await move('folder-move-12345678', 'moved-folder', 'default', 'moved-global', 200, '');
  const roundTrip = await read(session('default', 'moved-global'));
  assert.equal(roundTrip.entries[1].retry.attachmentDoc, 'default');
  assert.equal(roundTrip.entries[1].retry.attachmentSid, 'moved-global');
  assert.equal(roundTrip.entries[1].retry.docId, externalDoc);
  await image('default', 'moved-global', localImage); await image(externalDoc, fromSid, externalImage);
  pass('paper to folder to global transfers keep original evidence and migrate source-owned screenshots repeatedly');

  await seed('validation-source', 'source');
  const validation = await read(session('validation-source', 'source'));
  const validationAlias = (await list('validation-source')).sessions[0].fileKey;
  await move('validation-source', 'source', validationAlias, 'other', 400);
  await move('validation-source', '__translate', 'other-scope', 'dest', 400);
  await move('validation-source', 'source', 'other-scope', '__translate', 400);
  await move('validation-source', 'source', 'other-scope', '../unsafe', 400);
  await move('missing-source', 'source', 'other-scope', 'dest', 404);
  await move(fromDoc, fromSid, 'other-scope', 'dest', 409);
  await seed('occupied', 'dest'); await move('validation-source', 'source', 'occupied', 'dest', 409);
  await request(session('occupied', 'deleted'), undefined, 'DELETE');
  await move('validation-source', 'source', 'occupied', 'deleted', 409);
  assert.deepEqual(await read(session('validation-source', 'source')), validation);
  assert.equal((await request('/api/sessions/move', undefined, 'GET')).status, 405);
  pass('invalid scopes and translation IDs, missing/deleted sources and occupied/tombstoned targets never alter the source');

  const generatingSid = 'generating-chat', generatingTargetSid = 'generated-chat';
  await seed('generating-source', generatingSid, { entries: [
    { id: 'question', block: 'chat', kind: 'user', status: 'user', text: 'Still generating' },
    { id: 'answer', block: 'chat', kind: 'assistant', status: 'pending', text: 'Partial output', generation: 1, generationId: 'attempt' },
  ], history: [{ role: 'user', content: 'Still generating' }] });
  const generating = await read(session('generating-source', generatingSid));
  assert.equal((await move('generating-source', generatingSid, 'generating-target', generatingTargetSid, 409)).code, 'SESSION_GENERATING');
  assert.deepEqual(await read(session('generating-source', generatingSid)), generating);
  assert.equal((await list('generating-target')).sessions.length, 0);
  // A real Stop/completion is an ordinary same-attempt merge, not a replacement
  // that discards the rest of the conversation. This is also the crash-retry path.
  assert.equal((await request(session('generating-source', generatingSid, true), { entries: [
    { ...generating.entries[1], status: 'stopped' },
  ] })).status, 200);
  await move('generating-source', generatingSid, 'generating-target', generatingTargetSid);
  assert.equal((await read(session('generating-target', generatingTargetSid))).entries.find(row => row.id === 'answer').status, 'stopped');
  for (const status of ['complete', 'failed']) {
    const id = `terminal-${status}`;
    await seed(id, id, { entries: [{ id: 'answer', block: 'chat', kind: 'assistant', status, text: 'Retained answer' }] });
    await move(id, id, 'terminal-target', status);
  }
  await seed('user-pending-source', 'pending-user-chat', { entries: [{ id: 'question', kind: 'user', status: 'pending', text: 'Legacy user row' }] });
  await move('user-pending-source', 'pending-user-chat', 'terminal-target', 'user-pending');
  pass('pending assistant output blocks transfer without mutation; stopped, complete, failed and legacy user rows remain movable');

  await seed('missing-image-source', 'missing-image-chat', { entries: [{ id: 'lost', block: 'chat', kind: 'user', shots: [{ id: 'a'.repeat(32) }] }] });
  const missing = await read(session('missing-image-source', 'missing-image-chat'));
  const missingResult = await move('missing-image-source', 'missing-image-chat', 'missing-image-target', 'moved-missing-image', 409);
  assert.equal(missingResult.code, 'SESSION_ATTACHMENT_MISSING');
  assert.deepEqual(await read(session('missing-image-source', 'missing-image-chat')), missing);
  assert.equal((await list('missing-image-target')).sessions.length, 0);
  pass('missing referenced screenshots abort before publishing any target');

  const faultDoc = 'fault-source', faultSid = 'fault-chat', faultImage = await upload(faultDoc, faultSid);
  await seed(faultDoc, faultSid, { entries: [{ id: 'image', block: 'chat', kind: 'user', attachmentDoc: faultDoc, attachmentSid: faultSid, shots: [{ id: faultImage }] }] });
  const faultBefore = await read(session(faultDoc, faultSid));
  const barrier = path.join(dataDir, `deleted-chat-${faultSid}.json.tmp`);
  fs.mkdirSync(barrier);
  assert.equal((await move(faultDoc, faultSid, 'fault-target', 'moved-fault-chat', 500)).code, 'SESSION_MOVE_FAILED');
  assert.deepEqual(await read(session(faultDoc, faultSid)), faultBefore);
  assert.equal((await list('fault-target')).sessions.length, 0);
  await image(faultDoc, faultSid, faultImage);
  fs.rmdirSync(barrier);
  await move(faultDoc, faultSid, 'fault-target', 'moved-fault-chat'); await image('fault-target', 'moved-fault-chat', faultImage);
  pass('failure while committing the source tombstone rolls back the target and preserves original JSON and images for retry');

  await seed('race-source', 'race');
  const writes = Array.from({ length: 16 }, (_, index) => request(session('race-source', 'race', true), {
    entries: [{ id: `answer-${index}`, block: 'chat', kind: 'assistant', status: 'complete', text: `Concurrent answer ${index}` }],
  }));
  const moving = move('race-source', 'race', 'race-target', 'moved-race');
  const responses = await Promise.all(writes); await moving;
  const raced = await read(session('race-target', 'moved-race'));
  responses.forEach((response, index) => {
    assert([200, 409].includes(response.status));
    if (response.status === 200) assert(raced.entries.some(entry => entry.id === `answer-${index}`), `successful write ${index} retained`);
  });
  assert.equal((await request(session('race-source', 'race', true), { entries: [{ id: 'late', text: 'Late stale save' }] })).status, 409);
  await seed('contender-a', 'contender-a'); await seed('contender-b', 'contender-b');
  const contenders = await Promise.all(['contender-a', 'contender-b'].map(fromDoc => request('/api/sessions/move', {
    fromDoc, fromSid: fromDoc, toDoc: 'contested-target', toSid: 'contested-chat', folderPath: '',
  })));
  assert.deepEqual(contenders.map(response => response.status).sort(), [200, 409]);
  const loser = contenders[0].status === 409 ? 'contender-a' : 'contender-b';
  assert.equal((await read(session(loser, loser))).entries[0].text, 'Seed');
  pass('simultaneous saves and competing moves preserve all acknowledged writes and never overwrite an occupied target');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ backend: desktop ? 'Rust' : 'Node', passed: checks }, null, 2), 'utf8');
  console.log(`Session move: ${checks}/${checks} passed; ${scratch}`);
} finally { await stopChild(child); fs.closeSync(serverLogFd); }
