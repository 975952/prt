/** Empty-folder deletion never removes files, links or a partially scanned tree.
 * node test/folders-empty.mjs [--desktop]; disposable synthetic files only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `folders-empty-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const mkdir = relative => fs.mkdirSync(path.join(papersDir, relative), { recursive: true });
const fixture = (relative, content) => {
  mkdir(path.dirname(relative)); fs.writeFileSync(path.join(papersDir, relative), content, 'utf8');
};
mkdir('empty/nested/leaf'); mkdir('empty/.hidden-empty');
mkdir('mixed/first-empty/leaf'); fixture('mixed/last-file/keep.pdf', 'Synthetic PDF sentinel');
fixture('nonpdf/.hidden-note', 'Synthetic hidden sentinel');
fixture('nonpdf/note.txt', 'Synthetic text sentinel');
fixture('conflict/study.pdf', 'Synthetic source'); fixture('study.pdf', 'Synthetic target');
const outside = path.join(scratch, 'outside'); fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'keep.txt'), 'Synthetic outside sentinel', 'utf8');
const links = []; let reader;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const checks = []; const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const remove = async relative => {
  const response = await fetch(`${base}/api/folders?${new URLSearchParams({ path: relative, mode: 'empty' })}`, { method: 'DELETE' });
  return { status: response.status, body: await response.json() };
};
try {
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', PRT_QUIET_TOKEN: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('folders-empty').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', chunk => fs.appendFileSync(path.join(scratch, 'server.log'), chunk));
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* starting */ }
    if (!ready) await wait(100);
  }
  assert.ok(ready, 'isolated service starts');
  const listing = await (await fetch(`${base}/api/papers`)).json();
  assert.equal(path.resolve(listing.dir), papersDir);
  assert.equal((await remove('empty')).status, 200);
  assert.equal(fs.existsSync(path.join(papersDir, 'empty')), false);
  pass('removes a completely empty nested tree including hidden empty directories');
  assert.equal((await remove('mixed')).status, 409);
  assert.equal(fs.readFileSync(path.join(papersDir, 'mixed/last-file/keep.pdf'), 'utf8'), 'Synthetic PDF sentinel');
  assert.ok(fs.existsSync(path.join(papersDir, 'mixed/first-empty/leaf')));
  pass('preflight finds a nested PDF before removing any earlier empty directory');
  assert.equal((await remove('nonpdf')).status, 409);
  assert.equal(fs.readFileSync(path.join(papersDir, 'nonpdf/.hidden-note'), 'utf8'), 'Synthetic hidden sentinel');
  assert.equal(fs.readFileSync(path.join(papersDir, 'nonpdf/note.txt'), 'utf8'), 'Synthetic text sentinel');
  pass('hidden and non-PDF files prevent deletion and retain their contents');
  for (const relative of ['', '.', '..', '/', '../outside', '/empty', 'C:/empty', 'mixed/../nonpdf', 'mixed\\last-file']) {
    assert.equal((await remove(relative)).status, 400, relative);
  }
  assert.equal((await remove('missing')).status, 404);
  assert.equal((await remove('study.pdf')).status, 400);
  pass('rejects root, absolute, traversal, noncanonical paths, missing folders and files');
  const move = await fetch(`${base}/api/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'conflict/study.pdf', to: '', conflict: 'error' }) });
  assert.equal(move.status, 409); assert.equal((await remove('conflict')).status, 409);
  assert.equal(fs.readFileSync(path.join(papersDir, 'conflict/study.pdf'), 'utf8'), 'Synthetic source');
  assert.equal(fs.readFileSync(path.join(papersDir, 'study.pdf'), 'utf8'), 'Synthetic target');
  pass('a failed exclusive move cannot turn empty-folder cleanup into file deletion');
  for (const relative of ['junction', 'link-tree/child']) {
    mkdir(path.dirname(relative));
    const link = path.join(papersDir, relative);
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); links.push(link);
  }
  assert.equal((await remove('junction')).status, 400);
  assert.equal((await remove('link-tree')).status, 409);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'Synthetic outside sentinel');
  assert.ok(fs.lstatSync(path.join(papersDir, 'link-tree/child')).isSymbolicLink());
  pass('rejects root and descendant links or junctions without touching the destination');
  console.log(`folders-empty: ${checks.length}/${checks.length}; ${scratch}`);
} finally {
  if (desktop) await stopChild(reader); else reader?.kill();
  for (const link of links) fs.unlinkSync(link);
}
