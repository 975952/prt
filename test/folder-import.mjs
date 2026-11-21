import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import {
  buildTreesFromRelativeFiles,
  collectExternalDrop,
  importScannedFolderTree,
  isImportableFileName,
  scanDirectoryEntry,
} from '../public/js/folder-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function makeFile(name, bytes = Buffer.from('%PDF-1.4\n%%EOF\n')) {
  return {
    name,
    size: bytes.length,
    lastModified: 1,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function makeFileEntry(name, bytes) {
  const file = makeFile(name, bytes);
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok) => ok(file),
  };
}

function makeDirEntry(name, children, batchSize = 2) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let index = 0;
      return {
        readEntries(ok) {
          if (index >= children.length) { ok([]); return; }
          const slice = children.slice(index, index + batchSize);
          index += slice.length;
          ok(slice);
        },
      };
    },
  };
}

// 1. Filename filtering
assert.equal(isImportableFileName('paper.pdf'), true);
assert.equal(isImportableFileName('SLIDES.PPTX'), true);
assert.equal(isImportableFileName('deck.ppt'), true);
assert.equal(isImportableFileName('._paper.pdf'), false, 'ignores macOS AppleDouble files');
assert.equal(isImportableFileName('notes.txt'), false);
assert.equal(isImportableFileName('.hidden.pdf'), false);
await assert.rejects(scanDirectoryEntry({ name: 'Denied', createReader: () => ({
  readEntries: (_ok, fail) => fail(new Error('permission denied')),
}) }), /permission denied/, 'unreadable folders must not masquerade as empty folders');
await assert.rejects(scanDirectoryEntry(makeDirEntry('Unreadable', [{
  name: 'locked.pdf', isFile: true, file: (_ok, fail) => fail(new Error('file unavailable')),
}])), /file unavailable/);

// 2. Synchronous DataTransfer snapshot
{
  const dir = makeDirEntry('Research', []);
  const pdf = makeFile('top.pdf');
  const dt = {
    items: [
      { kind: 'file', webkitGetAsEntry: () => dir },
      { kind: 'file', webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: 'top.pdf' }), getAsFile: () => pdf },
      { kind: 'file', webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: 'readme.md' }), getAsFile: () => makeFile('readme.md') },
      { kind: 'file', webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: '.DS_Store' }), getAsFile: () => makeFile('.DS_Store') },
    ],
  };
  const snap = collectExternalDrop(dt);
  assert.equal(snap.dirs.length, 1);
  assert.equal(snap.files.length, 1);
  assert.equal(snap.files[0].name, 'top.pdf');
  assert.equal(snap.skippedFiles, 1, 'counts unsupported user files but ignores .DS_Store');
}

// 3. Recursive directory scan with batching, pruning, and ignored directories
const fixtureBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'multipage-sample.pdf'));
const sampleDir = makeDirEntry('Research', [
  makeFileEntry('intro.pdf', fixtureBytes),
  makeFileEntry('notes.txt'),
  makeFileEntry('.DS_Store'),
  makeFileEntry('._intro.pdf'),
  makeDirEntry('EmptySub', []),
  makeDirEntry('ImagesOnly', [makeFileEntry('fig1.png'), makeFileEntry('fig2.jpg')]),
  makeDirEntry('__MACOSX', [makeFileEntry('._ghost.pdf')]),
  makeDirEntry('.private', [makeFileEntry('hidden.pdf')]),
  makeDirEntry('2026', [
    makeDirEntry('NLP', [
      makeFileEntry('paper1.pdf', fixtureBytes),
      makeFileEntry('talk.PPTX'),
    ]),
    makeDirEntry('CV', [
      makeDirEntry('Deep', [
        makeFileEntry('vision.PDF', fixtureBytes),
      ]),
    ]),
  ]),
]);

const tree = await scanDirectoryEntry(sampleDir);
assert.equal(tree.name, 'Research');
assert.equal(tree.totalFiles, 4);
assert.equal(tree.skippedFiles, 3, 'notes.txt + fig1.png + fig2.jpg');
assert.deepEqual(tree.files.map((f) => f.name), ['intro.pdf']);
assert.deepEqual(tree.children.map((c) => c.name), ['2026'], 'prunes EmptySub, ImagesOnly, and __MACOSX');
assert.deepEqual(tree.children[0].children.map((c) => c.name), ['CV', 'NLP']);
assert.deepEqual(tree.children[0].children[0].children.map((c) => c.name), ['Deep']);
assert.deepEqual(tree.children[0].children[0].children[0].files.map((f) => f.name), ['vision.PDF']);
assert.deepEqual(tree.children[0].children[1].files.map((f) => f.name), ['paper1.pdf', 'talk.PPTX']);

// 4. Depth truncation guard
const shallow = await scanDirectoryEntry(sampleDir, { maxDepth: 1 });
assert.equal(shallow.totalFiles, 1);
assert.equal(shallow.truncatedDirs, 2, 'CV and NLP are beyond maxDepth=1');

// 5. Materialize tree with renamed root propagation
{
  const created = [];
  const queued = [];
  const result = await importScannedFolderTree(tree, 'Course', {
    createFolder: async (name, parent) => {
      const actual = parent === 'Course' && name === 'Research' ? 'Research (2)' : name;
      const full = parent ? `${parent}/${actual}` : actual;
      created.push(full);
      return full;
    },
    enqueueFiles: async (files, folderPath) => {
      queued.push({ folderPath, names: files.map((f) => f.name) });
    },
  });
  assert.equal(result.empty, false);
  assert.equal(result.rootPath, 'Course/Research (2)');
  assert.deepEqual(created, [
    'Course/Research (2)',
    'Course/Research (2)/2026',
    'Course/Research (2)/2026/CV',
    'Course/Research (2)/2026/CV/Deep',
    'Course/Research (2)/2026/NLP',
  ]);
  assert.deepEqual(queued, [
    { folderPath: 'Course/Research (2)', names: ['intro.pdf'] },
    { folderPath: 'Course/Research (2)/2026/CV/Deep', names: ['vision.PDF'] },
    { folderPath: 'Course/Research (2)/2026/NLP', names: ['paper1.pdf', 'talk.PPTX'] },
  ]);
}

// 6. Empty folder does not create any directory
{
  const queued = [];
  const result = await importScannedFolderTree(tree, '', {
    createFolder: async (name, parent) => {
      if (name === 'CV') throw new Error('cannot create CV');
      return parent ? `${parent}/${name}` : name;
    },
    enqueueFiles: async (files, folder) => queued.push({ folder, count: files.length }),
  });
  assert.equal(result.failedFolders.length, 1);
  assert.equal(result.queuedFiles, 3);
  assert(queued.some(row => row.folder === 'Research/2026/NLP'));
  assert(!queued.some(row => row.folder.endsWith('/Deep')));
}

{
  const emptyDir = makeDirEntry('NothingHere', [makeFileEntry('readme.txt'), makeDirEntry('Sub', [])]);
  const emptyTree = await scanDirectoryEntry(emptyDir);
  let called = false;
  const result = await importScannedFolderTree(emptyTree, '', {
    createFolder: async () => { called = true; return 'NothingHere'; },
    enqueueFiles: async () => { called = true; },
  });
  assert.equal(result.empty, true);
  assert.equal(called, false);
}

// 7. webkitRelativePath fallback tree builder
{
  const { trees, skippedFiles } = buildTreesFromRelativeFiles([
    { ...makeFile('a.pdf'), webkitRelativePath: 'Pack/Sub/a.pdf' },
    { ...makeFile('b.txt'), webkitRelativePath: 'Pack/Sub/b.txt' },
    { ...makeFile('c.pptx'), webkitRelativePath: 'Pack/c.pptx' },
  ]);
  assert.equal(trees.length, 1);
  assert.equal(trees[0].totalFiles, 2);
  assert.equal(skippedFiles, 1);
  assert.deepEqual(trees[0].children.map((c) => c.name), ['Sub']);
}

// 8. Live Node server.js integration test (nested POST /api/folders + POST /api/upload + GET /api/papers)
async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'folder-import-'));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data'));
const papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir);
fs.mkdirSync(papersDir);
const port = await findPort();
const base = `http://127.0.0.1:${port}`;
const desktop = process.argv.includes('--desktop');
const serverEnv = { ...process.env, PORT: String(port), PRT_PAPERS_DIR: papersDir,
  PRT_DATA_DIR: dataDir, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0' };
const server = desktop ? spawnReader(stageExe('folder-import').exe, {
  args: ['--port', String(port)], env: serverEnv,
}) : spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  windowsHide: true,
  env: {
    ...process.env,
    PORT: String(port),
    PRT_PAPERS_DIR: papersDir,
    PRT_DATA_DIR: dataDir,
    NO_OPEN: '1',
    PRT_REQUIRE_TOKEN: '0',
  },
  stdio: 'ignore',
});

try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* wait */ }
  }
  assert.ok(ready, 'server started for folder import integration test');

  const pdfOnlyDir = makeDirEntry('Lab', [
    makeFileEntry('root.pdf', fixtureBytes),
    makeFileEntry('ignore.md'),
    makeDirEntry('Empty', []),
    makeDirEntry('2026', [
      makeDirEntry('Agents', [makeFileEntry('agent.pdf', fixtureBytes)]),
      makeDirEntry('Systems', [makeFileEntry('sys.pdf', fixtureBytes)]),
    ]),
  ]);
  const scanned = await scanDirectoryEntry(pdfOnlyDir);
  const res = await importScannedFolderTree(scanned, '', {
    createFolder: async (name, parent) => {
      const q = new URLSearchParams({ name });
      if (parent) q.set('parent', parent);
      const r = await fetch(`${base}/api/folders?${q}`, { method: 'POST' });
      const j = await r.json();
      assert.equal(r.ok, true, `create folder ${name} failed: ${JSON.stringify(j)}`);
      return j.path;
    },
    enqueueFiles: async (files, folderPath) => {
      for (const f of files) {
        const q = new URLSearchParams({ name: f.name, folder: folderPath });
        const r = await fetch(`${base}/api/upload?${q}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: await f.arrayBuffer(),
        });
        const j = await r.json();
        assert.equal(r.ok, true, `upload ${f.name} failed: ${JSON.stringify(j)}`);
      }
    },
  });
  assert.equal(res.queuedFiles, 3);
  assert.equal(res.skippedFiles, 1);

  const listed = await (await fetch(`${base}/api/papers`)).json();
  const folderPaths = listed.folders.map((f) => f.path).sort();
  const paperPaths = listed.papers.map((p) => p.path).sort();
  assert.deepEqual(folderPaths, ['Lab', 'Lab/2026', 'Lab/2026/Agents', 'Lab/2026/Systems']);
  assert.deepEqual(paperPaths, ['Lab/2026/Agents/agent.pdf', 'Lab/2026/Systems/sys.pdf', 'Lab/root.pdf']);
} finally {
  await stopChild(server);
}

console.log('PASS folder import: recursive scan, pruning, depth limit, structure preservation, and live server integration');
