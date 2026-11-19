/** Organizer moves preserve PDF identity and never replace conflicting files.
 * node test/organizer-move.mjs [--desktop]
 * Disposable storage and synthetic PDFs only; no model or external requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `organizer-move-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const fixture = (relative, title) => {
  const absolute = path.join(papersDir, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  writeTitlePdf(absolute, { title });
};
for (const [relative, title] of [
  ['study.pdf', 'Synthetic organizer study'], ['guard.pdf', 'Synthetic unchanged guard'],
  ['one/same.pdf', 'Synthetic conflict A'], ['target/same.pdf', 'Synthetic conflict B'],
  ['one/different.pdf', 'Synthetic short'], ['target/different.pdf', 'Synthetic much longer conflicting contents'],
  ['one/race.pdf', 'Synthetic race A'], ['two/race.pdf', 'Synthetic race B'],
  ['single.pdf', 'Synthetic one source'], ['legacy.pdf', 'Synthetic legacy copy'],
  ['target/legacy.pdf', 'Synthetic legacy copy'],
]) fixture(relative, title);
fs.writeFileSync(path.join(papersDir, 'note.txt'), 'Synthetic non-PDF', 'utf8');
fs.mkdirSync(path.join(papersDir, 'fake.pdf'));
fs.mkdirSync(path.join(papersDir, 'blocked', 'study.pdf'), { recursive: true });
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hash = relative => digest(path.join(papersDir, relative));
const exists = relative => fs.existsSync(path.join(papersDir, relative));
const checks = [], requests = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, junction;
async function api(method, route, body) {
  assert.ok(route.startsWith('/api/'));
  requests.push({ method, route, body });
  const response = await fetch(`${base}${route}`, { method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
}
const move = (from, to) => api('POST', '/api/move', { from, to, conflict: 'error' });
try {
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', PRT_QUIET_TOKEN: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('organizer-move').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', data => fs.appendFileSync(path.join(scratch, 'server.log'), data));
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* starting */ }
    if (!ready) await wait(100);
  }
  assert.ok(ready, 'isolated service starts');
  const initial = (await api('GET', '/api/papers')).json;
  assert.equal(path.resolve(initial.dir), papersDir);
  const study = initial.papers.find(paper => paper.path === 'study.pdf');
  assert.ok(study);
  const originalHash = hash(study.path);
  const notes = { items: [{ id: 'organizer-note', page: 1, text: 'Keep the synthetic note' }] };
  const progress = { lastDoc: study.docId, lastUrl: study.url, lastName: study.name,
    docs: { [study.docId]: { name: study.name, page: 1, scale: 1.25, fit: false, ts: 123456 } } };
  assert.equal((await api('POST', `/api/notes?doc=${encodeURIComponent(study.docId)}`, notes)).status, 200);
  assert.equal((await api('POST', '/api/state', progress)).status, 200);
  const sessionRoute = `/api/session?doc=${encodeURIComponent(study.docId)}&sid=organizer-fixture`;
  assert.equal((await api('POST', sessionRoute, { title: 'Synthetic retained conversation', titleSource: 'user',
    entries: [{ id: 'organizer-question', kind: 'user', block: 'chat', text: 'Retain this question', status: 'user' }],
    history: [{ role: 'user', content: 'Retain this question' }], ops: [] })).status, 200);
  const savedSession = (await api('GET', sessionRoute)).json;
  const savedFiles = new Map(fs.readdirSync(dataDir).filter(name => /^(?:notes-|session-|state\.json$)/.test(name))
    .map(name => [name, digest(path.join(dataDir, name))]));
  const initialOrder = JSON.parse(fs.readFileSync(path.join(dataDir, 'papers-order.json'), 'utf8')).order;
  const moved = await move(study.path, '机器学习/Transformer');
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.json, { ok: true, from: 'study.pdf', to: '机器学习/Transformer/study.pdf', name: 'study.pdf', moved: true });
  assert.ok(!exists('study.pdf')); assert.equal(hash(moved.json.to), originalHash);
  const next = (await api('GET', '/api/papers')).json.papers.find(paper => paper.path === moved.json.to);
  assert.equal(next.docId, study.docId); assert.equal(next.name, study.name);
  const served = await fetch(`${base}${next.url}`).then(response => response.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(Buffer.from(served)).digest('hex'), originalHash);
  assert.deepEqual((await api('GET', `/api/notes?doc=${encodeURIComponent(study.docId)}`)).json, notes);
  assert.deepEqual((await api('GET', '/api/state')).json, progress);
  assert.deepEqual((await api('GET', sessionRoute)).json, savedSession);
  for (const [name, before] of savedFiles) assert.equal(digest(path.join(dataDir, name)), before, `${name} stays unchanged`);
  const nextOrder = JSON.parse(fs.readFileSync(path.join(dataDir, 'papers-order.json'), 'utf8')).order;
  assert.equal(nextOrder.indexOf(moved.json.to), initialOrder.indexOf('study.pdf'));
  assert.ok(!nextOrder.includes('study.pdf'));
  pass('nested safe move preserves file bytes, filename, docId, notes, sessions, progress and relative order');

  const unchanged = await move(moved.json.to, '机器学习/Transformer');
  assert.equal(unchanged.status, 200); assert.equal(unchanged.json.moved, false); assert.equal(unchanged.json.to, moved.json.to);
  assert.equal(hash(moved.json.to), originalHash);
  pass('same-directory move is a no-op and returns the original full relative path');

  const sourceHash = hash('one/same.pdf'), targetHash = hash('target/same.pdf');
  assert.notEqual(sourceHash, targetHash);
  assert.equal(fs.statSync(path.join(papersDir, 'one/same.pdf')).size, fs.statSync(path.join(papersDir, 'target/same.pdf')).size);
  assert.equal((await move('one/same.pdf', 'target')).status, 409);
  assert.equal(hash('one/same.pdf'), sourceHash); assert.equal(hash('target/same.pdf'), targetHash);
  assert.ok(!exists('target/same (2).pdf'));
  const differentSource = hash('one/different.pdf'), differentTarget = hash('target/different.pdf');
  assert.notEqual(fs.statSync(path.join(papersDir, 'one/different.pdf')).size, fs.statSync(path.join(papersDir, 'target/different.pdf')).size);
  assert.equal((await move('one/different.pdf', 'target')).status, 409);
  assert.equal(hash('one/different.pdf'), differentSource); assert.equal(hash('target/different.pdf'), differentTarget);
  assert.equal((await move(moved.json.to, 'blocked')).status, 409);
  assert.equal(hash(moved.json.to), originalHash); assert.ok(fs.statSync(path.join(papersDir, 'blocked/study.pdf')).isDirectory());
  pass('any existing target causes 409 without deleting, renaming or replacing either source or target');

  assert.equal((await move('missing.pdf', 'must-not-create')).status, 404);
  assert.equal(exists('must-not-create'), false);
  assert.equal((await move('note.txt', 'must-not-create')).status, 400);
  assert.equal((await move('fake.pdf', 'must-not-create')).status, 400);
  assert.ok(exists('note.txt')); assert.ok(exists('fake.pdf'));
  const guardHash = hash('guard.pdf');
  for (const invalid of ['../escape', '/absolute', 'C:/escape', 'folder\\nested', 'a//b', 'a/./b', 'a/../b',
    'CON', 'AUX.txt', 'COM1', 'LPT²', 'tail.', 'tail ', '.hidden', 'bad\u0000name', 'bad\u001fname', '']) {
    if (!invalid) continue; // An empty destination deliberately means the library root.
    assert.equal((await move('guard.pdf', invalid)).status, 400, `invalid destination ${JSON.stringify(invalid)}`);
    assert.equal(hash('guard.pdf'), guardHash);
  }
  for (const invalid of ['', '../guard.pdf', '/guard.pdf', 'C:/guard.pdf', 'one/../guard.pdf', 'one\\same.pdf']) {
    assert.equal((await move(invalid, 'target')).status, 400, `invalid source ${JSON.stringify(invalid)}`);
  }
  assert.equal((await api('POST', '/api/move', { from: 'guard.pdf', to: null, conflict: 'error' })).status, 400);
  pass('missing files, non-PDF sources, absolute/traversal/control paths and Windows device names are rejected');

  const outside = path.join(scratch, 'outside'); fs.mkdirSync(outside);
  writeTitlePdf(path.join(outside, 'external.pdf'), { title: 'Synthetic outside boundary' });
  const outsideHash = digest(path.join(outside, 'external.pdf'));
  junction = path.join(papersDir, 'linked-folder');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await move('linked-folder/external.pdf', 'target')).status, 400);
  assert.equal((await move('guard.pdf', 'linked-folder/new-folder')).status, 400);
  assert.equal(digest(path.join(outside, 'external.pdf')), outsideHash);
  assert.equal(fs.existsSync(path.join(outside, 'new-folder')), false); assert.equal(hash('guard.pdf'), guardHash);
  fs.unlinkSync(junction); junction = null;
  pass('symbolic directory and Windows junction paths cannot read or mutate files outside the library');

  const raceSources = ['one/race.pdf', 'two/race.pdf'];
  const raceHashes = raceSources.map(hash);
  const raced = await Promise.all(raceSources.map(source => move(source, 'race-destination')));
  assert.deepEqual(raced.map(result => result.status).sort(), [200, 409]);
  const winner = raced.findIndex(result => result.status === 200), loser = 1 - winner;
  assert.equal(exists(raceSources[winner]), false); assert.equal(hash(raceSources[loser]), raceHashes[loser]);
  assert.equal(hash('race-destination/race.pdf'), raceHashes[winner]);
  pass('concurrent moves to the same target have one winner and leave the losing source intact');

  const singleHash = hash('single.pdf');
  const sameSource = await Promise.all(['first-destination', 'second-destination'].map(to => move('single.pdf', to)));
  assert.deepEqual(sameSource.map(result => result.status).sort(), [200, 404]);
  const singleMove = sameSource.find(result => result.status === 200).json;
  assert.equal(hash(singleMove.to), singleHash);
  assert.equal(['first-destination/single.pdf', 'second-destination/single.pdf'].filter(exists).length, 1);
  pass('concurrent moves of one source do not create extra destination copies');

  const legacyHash = hash('legacy.pdf');
  assert.equal((await api('POST', '/api/move', { from: 'legacy.pdf', to: 'target' })).status, 200);
  assert.equal(exists('legacy.pdf'), false); assert.equal(hash('target/legacy.pdf'), legacyHash);
  pass('the existing ordinary move API keeps its previous behavior');
  console.log(`organizer-move: ${checks.length}/${checks.length}; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  console.error(`Artifacts: ${scratch}`); throw error;
} finally {
  if (junction) fs.unlinkSync(junction);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, requests }, null, 2), 'utf8');
  if (desktop) await stopChild(reader); else reader?.kill();
}
