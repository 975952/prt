/** Verify persisted retry versions on shared Node/Rust fixtures.
 * Default: pure Node merge; --http: isolated Node HTTP service;
 * --desktop: isolated copy of the built desktop executable. No user data.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild, waitForBase, READER_PORTS } from './_exe.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/session-regeneration.json', import.meta.url), 'utf8'));
const desktop = process.argv.includes('--desktop'), network = desktop || process.argv.includes('--http');
let child, base, scratch;
try {
  let merge;
  if (network) {
    fs.mkdirSync(SANDBOX, { recursive: true });
    scratch = fs.mkdtempSync(path.join(SANDBOX, 'session-regeneration-'));
    const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
    fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
    const env = { ...process.env, PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
      PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
    if (desktop) {
      child = spawnReader(stageExe('session-regeneration').exe, { env });
      base = await waitForBase({ ports: READER_PORTS, papersDir });
    } else {
      const probe = http.createServer();
      await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port;
      await new Promise(resolve => probe.close(resolve));
      child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
      base = await waitForBase({ ports: [port], papersDir });
    }
    assert(base, 'isolated service started');
  } else merge = createRequire(import.meta.url)('../server.js').__test.mergeSessionPayload;
  for (const [i, test] of cases.entries()) {
    let saved = {};
    const url = `${base}/api/session?doc=regeneration-test-${i}&sid=case&merge=1`;
    for (const write of test.writes) {
      if (network) {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(write) });
        assert.equal(response.status, 200, `${test.name}: save`);
      } else saved = merge(saved, write);
    }
    if (network) { const response = await fetch(url); assert.equal(response.status, 200); saved = await response.json(); }
    assert.deepEqual(saved.entries, test.expectedEntries, test.name);
    if (test.expectedHistory) assert.deepEqual(saved.history, test.expectedHistory, `${test.name}: history`);
    console.log(`PASS ${test.name}`);
  }
  if (network) {
    const doc = 'Concurrent metadata and answers.pdf', sid = 'racecase';
    const url = `${base}/api/session?${new URLSearchParams({ doc, sid, merge: '1' })}`;
    const write = (method, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await write('POST', { entries: [{ id: 'seed', status: 'complete', text: 'Seed' }] })).status, 200);
    const concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => [
      write('POST', { entries: [{ id: `answer-${i}`, status: 'complete', text: `Answer ${i}`, generation: i + 1, generationId: 'answer' }] }),
      write('PATCH', { title: `Rename ${i}`, pinned: true, lastOpenedAt: 1794900000000 + i }),
    ]).flat());
    assert(concurrent.every(response => response.status === 200), 'concurrent metadata and answer writes succeed');
    const saved = await (await fetch(url)).json();
    assert.equal(saved.entries.length, 21, 'PATCH cannot restore an old answer snapshot');
    assert.equal(new Set(saved.entries.map(row => row.id)).size, 21);
    assert(saved.title.startsWith('Rename ') && saved.pinned === true, 'answer writes retain metadata');
    console.log('PASS concurrent title/pin updates and answers retain every saved entry');

    const listing = await (await fetch(`${base}/api/sessions?${new URLSearchParams({ doc })}`)).json();
    const fileKey = listing.sessions.find(row => row.sid === sid)?.fileKey;
    assert(fileKey, 'resolved storage alias is exposed in isolated listing');
    const aliasUrl = `${base}/api/session?${new URLSearchParams({ doc: fileKey, sid, merge: '1' })}`;
    const racing = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => write('POST', { entries: [{ id: `late-${i}`, status: 'complete', text: `Late ${i}` }] })),
      write('DELETE'),
      write('PATCH', { title: 'Late title' }),
    ]);
    assert(racing.every(response => response.status === 200 || response.status === 409));
    for (const target of [url, aliasUrl]) {
      const deleted = await (await fetch(target)).json();
      assert.equal(deleted.deleted, true); assert.equal(deleted.code, 'SESSION_DELETED');
      assert.deepEqual(deleted.entries, []);
      for (const method of ['POST', 'PATCH']) {
        const response = await fetch(target, { method, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(method === 'POST' ? { entries: saved.entries, updatedAt: Date.now() + 10000 } : { title: 'Restore stale window' }) });
        assert.equal(response.status, 409, 'a late old window cannot recreate the deleted conversation');
        assert.equal((await response.json()).code, 'SESSION_DELETED');
      }
    }
    assert.equal((await write('DELETE')).status, 200, 'delete stays idempotent');
    const after = await (await fetch(`${base}/api/sessions?${new URLSearchParams({ doc })}`)).json();
    assert(!after.sessions.some(row => row.sid === sid), 'deletion markers never appear in history');
    console.log('PASS deletion rejects concurrent and later stale writes through canonical and alias keys');

    const cleared = `${base}/api/session?doc=clear-scope&sid=clearcase`;
    const clearWrite = body => fetch(cleared, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await clearWrite({ entries: [{ id: 'old', text: 'Old' }] })).status, 200);
    assert.equal((await clearWrite({ entries: [], history: [] })).status, 200);
    assert.equal((await clearWrite({ entries: [{ id: 'new', text: 'New' }] })).status, 200);
    const stale = await fetch(`${cleared}&merge=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ id: 'old', text: 'Old' }], history: [] }) });
    assert.equal(stale.status, 200);
    assert.deepEqual((await (await fetch(cleared)).json()).entries.map(row => row.id), ['new']);
    console.log('PASS clearing permits a new question and rejects old entries saved by another window');
  }
  const total = cases.length + (network ? 3 : 0);
  console.log(`Session regeneration: ${total}/${total} passed (${desktop ? 'desktop HTTP' : network ? 'Node HTTP' : 'Node pure'})`);
} finally { await stopChild(child); }
