/** Update backend regression. Rust fixtures use only temporary directories and loopback HTTP.
 * node test/updater.mjs             -> validation, downloads and real helper process roundtrips
 * EXE=... node test/updater.mjs --desktop -> additionally smoke-test the real embedded backend
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { ROOT, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild, waitForBase } from './_exe.mjs';

const tests = spawn('cargo', ['test', 'updater', '--', '--nocapture'], {
  cwd: path.join(ROOT, 'desktop'), windowsHide: true, stdio: 'inherit',
});
assert.equal((await once(tests, 'exit'))[0], 0, 'updater Rust regression');
if (process.argv.includes('--desktop')) {
  const staged = stageExe('updater');
  const data = assertIsolatedDataDir(path.join(staged.dir, 'data'));
  const papers = path.join(staged.dir, 'papers');
  const local = path.join(staged.dir, 'local');
  fs.mkdirSync(data); fs.mkdirSync(papers); fs.mkdirSync(local);
  fs.writeFileSync(path.join(data, 'updater-sentinel'), 'existing user data fixture');
  fs.writeFileSync(path.join(papers, 'updater-sentinel'), 'existing paper fixture');
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawnReader(staged.exe, { args: ['--port', String(port)], env: {
    PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, LOCALAPPDATA: local, PRT_DIAGNOSTICS: '1', PRT_REQUIRE_TOKEN: '0',
  } });
  try {
    const base = await waitForBase({ ports: [port], papersDir: papers, timeoutMs: 30000 });
    assert(base, 'isolated desktop service started');
    const status = await (await fetch(base + '/api/update')).json();
    assert.equal(status.supported, true); assert.equal(status.mode, 'portable');
    assert.equal(status.phase, 'idle'); assert.equal(status.autoCheckAllowed, false);
    assert.match(status.currentVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(status.bytes, 0); assert.equal(status.total, 0);
    for (const route of ['/api/update/check?url=https://evil.test/a', '/api/update/download?path=C:/bad.exe']) {
      assert.equal((await fetch(base + route, { method: 'POST' })).status, 400);
    }
    assert.equal((await fetch(base + '/api/update/check', { method: 'POST', body: '{"url":"https://evil.test/a"}' })).status, 400);
    assert.equal((await fetch(base + '/api/update/download', { method: 'POST' })).status, 400, 'no download without a validated release');
    assert.equal((await fetch(base + '/api/update/check')).status, 405);
    assert.equal((await (await fetch(base + '/api/update')).json()).phase, 'idle', 'invalid calls never begin network work');
    assert.equal(fs.readFileSync(path.join(data, 'updater-sentinel'), 'utf8'), 'existing user data fixture');
    assert.equal(fs.readFileSync(path.join(papers, 'updater-sentinel'), 'utf8'), 'existing paper fixture');
    assert.equal(fs.existsSync(path.join(local, 'prt', 'updates')), false, 'status-only checks create no update cache');
    console.log('PASS desktop updater: status contract, auto-check suppression, fixed API inputs, and data isolation');
  } finally { await stopChild(child); }
}
