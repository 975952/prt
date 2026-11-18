/** Windows setup lifecycle checks. Uses an isolated AppId, install directory,
 * synthetic library, and explicit PRT_* storage paths. Never installs the real app.
 * node test/installer.mjs [--previous-exe path --previous-version version]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, SANDBOX } from './_env.mjs';
import { deliverableExe, spawnReader, stopChild, waitForBase } from './_exe.mjs';

if (process.platform !== 'win32') throw new Error('Installer lifecycle checks require Windows.');
const option = name => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : '';
};
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'installer-'));
const installDir = path.join(scratch, 'app');
const id = `prt-test-${crypto.randomUUID()}`;
const appName = `prt QA ${path.basename(scratch)}`;
const version = fs.readFileSync(path.join(ROOT, 'desktop/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)[1];
const previousExe = option('--previous-exe');
const previousVersion = option('--previous-version');
assert.equal(Boolean(previousExe), Boolean(previousVersion), 'Previous EXE and version must be supplied together.');
const executable = path.resolve(deliverableExe());
const data = path.join(scratch, 'user', 'data');
const papers = path.join(scratch, 'user', 'papers');
const env = { ...process.env, PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
  PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', PRT_BACKGROUND: '1' };
delete env.PRT_ALLOW_MULTI_INSTANCE;
const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inside = file => {
  const relative = path.relative(scratch, path.resolve(file));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Expected isolated target: ${file}`);
};
const run = (command, args, extra = {}) => {
  const result = spawnSync(command, args, { cwd: ROOT, env, windowsHide: true,
    encoding: 'utf8', timeout: 150000, ...extra });
  if (result.error) throw result.error;
  return result;
};
const build = (folder, exe = executable, appVersion = version) => {
  const output = path.join(scratch, folder);
  const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'desktop/build-setup.ps1'), '-SkipBuild',
    '-OutputDir', output, '-AppId', id, '-AppName', appName, '-DefaultDir', installDir,
    '-ExePath', path.resolve(exe), '-Version', appVersion]);
  fs.writeFileSync(path.join(scratch, `${folder}-build.log`), result.stdout + result.stderr, 'utf8');
  assert.equal(result.status, 0, `${folder} build failed; see ${folder}-build.log`);
  const setup = path.join(output, 'prt-setup.exe');
  assert(fs.existsSync(setup), 'Setup output exists');
  return setup;
};
const install = (setup, label, extra = [], environment = env) => {
  inside(installDir);
  const taskOptions = extra.some(value => value.toUpperCase().startsWith('/TASKS=')) ? [] : ['/TASKS='];
  return run(setup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-',
    `/DIR=${installDir}`, `/GROUP=${appName}`, ...taskOptions,
    `/LOG=${path.join(scratch, label + '.log')}`, ...extra], { env: environment });
};
const uninstall = label => {
  const uninstaller = path.join(installDir, 'unins000.exe');
  inside(uninstaller);
  if (!fs.existsSync(uninstaller)) return;
  const result = run(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
    `/LOG=${path.join(scratch, label + '.log')}`]);
  assert.equal(result.status, 0, `${label} uninstall failed`);
};
const registryVersion = () => {
  const result = run('reg.exe', ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}_is1`, '/v', 'DisplayVersion']);
  assert.equal(result.status, 0, 'Isolated uninstall registration exists');
  return result.stdout.match(/DisplayVersion\s+REG_SZ\s+([^\r\n]+)/)?.[1].trim();
};
const tree = directory => {
  const result = {};
  const visit = (folder, rel = '') => {
    if (!fs.existsSync(folder)) return;
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const key = path.join(rel, item.name);
      if (item.isDirectory()) visit(path.join(folder, item.name), key);
      else result[key] = sha(path.join(folder, item.name));
    }
  };
  visit(directory);
  return result;
};
const seed = (targetData, targetPapers) => {
  fs.mkdirSync(path.join(targetData, 'webview2'), { recursive: true });
  fs.mkdirSync(path.join(targetPapers, 'course'), { recursive: true });
  fs.writeFileSync(path.join(targetData, 'config.json'), JSON.stringify({ baseUrl: 'https://example.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model' }), 'utf8');
  fs.writeFileSync(path.join(targetData, 'session-fixture.json'), JSON.stringify({ entries: [{ id: 'fixture', text: 'Saved conversation', kind: 'assistant' }] }), 'utf8');
  fs.writeFileSync(path.join(targetData, 'webview2', 'migration-fixture.txt'), 'synthetic window data', 'utf8');
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(targetPapers, 'course', 'fixture.pdf'));
};

let child;
try {
  const setup = build('current');
  const baseline = previousExe ? build('previous', previousExe, previousVersion) : setup;
  assert.equal(install(baseline, 'first-install').status, 0);
  assert(fs.existsSync(path.join(installDir, 'prt.exe')));
  assert(fs.existsSync(path.join(installDir, 'prt-installed.flag')));
  assert.equal(registryVersion(), previousVersion || version);
  pass('fresh setup creates the app, installed marker and isolated uninstall registration');

  const programs = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Programs')"], { encoding: 'utf8', windowsHide: true }).trim();
  const shortcutDir = path.join(programs, appName);
  const desktop = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8', windowsHide: true }).trim();
  const desktopShortcut = path.join(desktop, appName + '.lnk');
  assert(fs.existsSync(shortcutDir), 'Isolated Start menu group exists');
  assert(fs.readdirSync(shortcutDir).some(name => name.endsWith('.lnk')), 'Start menu shortcut exists');
  assert(!fs.existsSync(desktopShortcut), 'Desktop shortcut is optional');
  pass('setup creates its isolated Start menu entry and leaves the optional desktop shortcut disabled');

  seed(data, papers);
  const saved = { data: tree(data), papers: tree(papers) };
  assert.equal(install(setup, 'upgrade', ['/TASKS=desktopicon']).status, 0);
  assert.equal(sha(path.join(installDir, 'prt.exe')), sha(executable));
  assert.equal(registryVersion(), version);
  assert.deepEqual({ data: tree(data), papers: tree(papers) }, saved);
  assert(fs.existsSync(desktopShortcut), 'Selected desktop shortcut is created');
  pass(`${previousVersion ? 'upgrade from ' + previousVersion : 'reinstall'} replaces program files while preserving papers, settings, conversations and window data`);

  const report = path.join(scratch, 'storage.json');
  assert.equal(run(path.join(installDir, 'prt.exe'), ['--storage-info', '--report', report, '--silent']).status, 0);
  const storage = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(storage.mode, 'installed');
  const hasPath = (value, expected) => typeof value === 'string'
    ? path.resolve(value) === path.resolve(expected)
    : value && typeof value === 'object' && Object.values(value).some(item => hasPath(item, expected));
  assert(hasPath(storage, data));
  assert(hasPath(storage, papers));
  pass('installed application reports isolated override paths without starting a reader');

  child = spawnReader(path.join(installDir, 'prt.exe'), { args: ['--port', '8950'], env });
  const base = await waitForBase({ ports: Array.from({ length: 20 }, (_, i) => 8950 + i), papersDir: papers, timeoutMs: 30000 });
  assert(base, 'Installed executable starts with its synthetic library');
  const library = await fetch(base + '/api/papers').then(r => r.json());
  assert.equal(library.papers.length, 1);
  assert.equal(library.papers[0].name, 'fixture.pdf');
  await stopChild(child); child = null;
  pass('installed executable serves its isolated PDF library after upgrade');

  const beforeUninstall = { data: tree(data), papers: tree(papers) };
  uninstall('first-uninstall');
  assert(!fs.existsSync(path.join(installDir, 'prt.exe')));
  assert.deepEqual({ data: tree(data), papers: tree(papers) }, beforeUninstall);
  assert(!fs.existsSync(shortcutDir));
  assert(!fs.existsSync(desktopShortcut));
  assert.notEqual(run('reg.exe', ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}_is1`]).status, 0);
  pass('uninstall removes only app files and shortcuts, retaining the complete personal data and library');

  const legacy = path.join(scratch, 'legacy');
  const legacyData = path.join(legacy, 'data');
  const legacyPapers = path.join(legacy, 'papers');
  seed(legacyData, legacyPapers);
  const original = tree(legacy);
  const migratedData = path.join(scratch, 'migrated', 'data');
  const migratedPapers = path.join(scratch, 'migrated', 'papers');
  const migrationEnv = { ...env, PRT_DATA_DIR: migratedData, PRT_PAPERS_DIR: migratedPapers };
  assert.equal(install(setup, 'migration', [`/MIGRATEFROM=${legacy}`], migrationEnv).status, 0);
  assert.deepEqual(tree(legacy), original);
  assert.deepEqual(tree(migratedData), tree(legacyData));
  assert.deepEqual(tree(migratedPapers), tree(legacyPapers));
  pass('setup imports explicitly selected portable data into empty targets without changing the source');

  fs.writeFileSync(path.join(migratedData, 'keep.txt'), 'existing installed data', 'utf8');
  const occupied = { data: tree(migratedData), papers: tree(migratedPapers) };
  const conflict = install(setup, 'migration-conflict', [`/MIGRATEFROM=${legacy}`], migrationEnv);
  assert.equal(conflict.status, 20, 'Migration conflict must report the dedicated import failure code');
  assert.deepEqual({ data: tree(migratedData), papers: tree(migratedPapers) }, occupied);
  assert.deepEqual(tree(legacy), original);
  pass('setup reports conflicting migration as a failure and preserves both source and target');

  uninstall('final-uninstall');
  assert.deepEqual({ data: tree(migratedData), papers: tree(migratedPapers) }, occupied);
  assert.deepEqual(tree(legacy), original);
  pass('uninstall after migration still retains imported and original files');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ version, previousVersion, appId: id, checks, errors: [] }, null, 2) + '\n', 'utf8');
  console.log(`installer: ${checks.length}/${checks.length} passed; ${scratch}`);
} finally {
  await stopChild(child);
  uninstall('cleanup');
}
