/** Real executable storage selection and legacy-process migration lock checks.
 * node test/storage-cli.mjs [--previous-exe <portable binary>]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, SANDBOX } from './_env.mjs';
import { deliverableExe, spawnReader, stopChild, waitForBase } from './_exe.mjs';

if (process.platform !== 'win32') throw Error('Windows storage CLI checks require Windows.');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'storage-cli-'));
const app = path.join(scratch, 'app');
fs.mkdirSync(app);
const exe = path.join(app, 'prt.exe');
fs.copyFileSync(deliverableExe(), exe);
const env = { ...process.env };
for (const key of ['PRT_DATA_DIR', 'PRT_PAPERS_DIR', 'PRT_ALLOW_MULTI_INSTANCE']) delete env[key];
const known = name => execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Environment]::GetFolderPath('${name}')`], { encoding: 'utf8', windowsHide: true }).trim();
const defaultData = path.join(known('LocalApplicationData'), 'prt', 'data');
const defaultPapers = path.join(known('MyDocuments'), 'prt', 'papers');
const before = [defaultData, defaultPapers].map(dir => fs.existsSync(dir));
const checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const cli = (label, args = ['--storage-info'], customEnv = env) => {
  const report = path.join(scratch, `${label}.json`);
  const result = spawnSync(exe, [...args, '--report', report, '--silent'], { env: customEnv, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (result.error) throw result.error;
  return { result, report: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null };
};
const portable = cli('portable');
assert.equal(portable.result.status, 0);
assert.equal(portable.report.mode, 'portable');
assert.equal(path.resolve(portable.report.data), path.join(app, 'data'));
assert.equal(path.resolve(portable.report.papers), path.join(app, 'papers'));
assert(!fs.existsSync(path.join(app, 'data')) && !fs.existsSync(path.join(app, 'papers')));
pass('unmarked portable executable reports adjacent storage without creating folders');

fs.writeFileSync(path.join(app, 'prt-installed.flag'), 'installed\n');
const installed = cli('installed');
assert.equal(installed.result.status, 0);
assert.equal(installed.report.mode, 'installed');
assert.equal(path.resolve(installed.report.data), defaultData);
assert.equal(path.resolve(installed.report.papers), defaultPapers);
assert.deepEqual([defaultData, defaultPapers].map(dir => fs.existsSync(dir)), before);
pass('installed executable resolves Windows known folders without creating or reading user files');

const targetData = path.join(scratch, 'target', 'data');
const targetPapers = path.join(scratch, 'target', 'papers');
const isolated = { ...env, PRT_DATA_DIR: targetData, PRT_PAPERS_DIR: targetPapers };
const overridden = cli('overrides', ['--storage-info'], isolated);
assert.equal(overridden.result.status, 0);
assert.equal(path.resolve(overridden.report.data), targetData);
assert.equal(path.resolve(overridden.report.papers), targetPapers);
assert(!fs.existsSync(targetData) && !fs.existsSync(targetPapers));
pass('explicit isolated directories take precedence over installed defaults');

const previousIndex = process.argv.indexOf('--previous-exe');
if (previousIndex >= 0) {
  const source = path.join(scratch, 'legacy');
  const sourceData = path.join(source, 'data');
  const sourcePapers = path.join(source, 'papers');
  fs.mkdirSync(sourceData, { recursive: true });
  fs.mkdirSync(sourcePapers, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/cn-sample.pdf'), path.join(sourcePapers, 'fixture.pdf'));
  const legacyExe = path.join(source, 'prt.exe');
  fs.copyFileSync(path.resolve(process.argv[previousIndex + 1]), legacyExe);
  const child = spawnReader(legacyExe, { args: ['--port', '8970'], env: {
    PRT_DATA_DIR: sourceData, PRT_PAPERS_DIR: sourcePapers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
  } });
  try {
    const base = await waitForBase({ ports: Array.from({ length: 10 }, (_, i) => 8970 + i), papersDir: sourcePapers, timeoutMs: 30000 });
    assert(base, 'Legacy reader starts with synthetic data');
    const rejected = cli('legacy-running', ['--migrate-from', source], isolated);
    assert.equal(rejected.result.status, 2);
    assert.equal(rejected.report.ok, false);
    assert.match(rejected.report.error, /in use/i);
    assert(!fs.existsSync(targetData) && !fs.existsSync(targetPapers));
    pass('migration respects the previous portable version mutex and rejects a running source');
  } finally { await stopChild(child); }
  const copied = cli('legacy-stopped', ['--migrate-from', source], isolated);
  assert.equal(copied.result.status, 0, copied.report?.error);
  assert.equal(copied.report.ok, true);
  assert(fs.existsSync(path.join(targetPapers, 'fixture.pdf')));
  assert(fs.existsSync(path.join(sourcePapers, 'fixture.pdf')));
  pass('the same import succeeds after the isolated legacy process closes, retaining its original files');
}
fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors: [] }, null, 2) + '\n', 'utf8');
console.log(`storage-cli: ${checks.length}/${checks.length} passed; ${scratch}`);
