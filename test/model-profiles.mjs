/** Isolated API + settings UI regression. Only synthetic credentials are used.
 * node test/model-profiles.mjs [--desktop]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'model-profiles-'));
const DATA = assertIsolatedDataDir(path.join(scratch, 'data'));
const PAPERS = path.join(scratch, 'papers');
fs.mkdirSync(DATA); fs.mkdirSync(PAPERS);
const CONFIG = path.join(DATA, 'config.json');
const desktop = process.argv.includes('--desktop');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let chatCalls = 0;
let rejectChat = false;
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* consume synthetic request */ }
  chatCalls++;
  res.writeHead(rejectChat ? 401 : 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rejectChat ? { error: { message: 'synthetic connection failure' } }
    : { choices: [{ message: { content: '可用' } }] }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const BASE = `http://127.0.0.1:${port}`;
const oldA = { model: 'reader-alpha', baseURL: endpoint, apiKey: 'FAKE_PROFILE_A_SECRET', visionModel: 'vision-alpha', temperature: 0.4, stream: false };
const oldB = { model: 'reader-beta', baseURL: endpoint, apiKey: 'FAKE_PROFILE_B_SECRET', visionModel: 'vision-beta', temperature: 0.7, stream: true };
fs.writeFileSync(CONFIG, JSON.stringify({ ...oldB, modelProfiles: [oldA, oldB], longTermMemory: 'synthetic memory' }), 'utf8');
let reader;
let browser;
const start = async () => {
  const env = { PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', PRT_QUIET_TOKEN: '1' };
  let startupError = '';
  reader = desktop ? spawnReader(stageExe('model-profiles').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, ...env, PORT: String(port), NO_OPEN: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
  reader.stderr?.on('data', chunk => { startupError = (startupError + chunk).slice(-4000); });
  reader.on('error', error => { startupError = String(error); });
  let lastError = '';
  for (let i = 0; i < 150; i++) {
    if (reader.exitCode !== null) throw new Error(`isolated reader exited ${reader.exitCode}: ${startupError}`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        const listing = await (await fetch(`${BASE}/api/papers`)).json();
        assert.equal(path.resolve(listing.dir), path.resolve(PAPERS));
        return;
      }
    } catch (error) { lastError = String(error); }
    await wait(100);
  }
  throw new Error(`isolated reader failed to start: ${startupError || lastError}`);
};
const get = async () => {
  const r = await fetch(`${BASE}/api/config`);
  assert.equal(r.status, 200);
  const cfg = await r.json();
  assert.doesNotMatch(JSON.stringify(cfg), /FAKE_PROFILE_[AB]_SECRET/);
  assert.equal(cfg.apiKey, '');
  assert.ok(cfg.modelProfiles.every(p => !Object.hasOwn(p, 'apiKey')));
  return cfg;
};
const post = async (patch, status = 200) => {
  const r = await fetch(`${BASE}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  const body = await r.json();
  assert.equal(r.status, status, JSON.stringify(body));
  assert.doesNotMatch(JSON.stringify(body), /FAKE_PROFILE_[AB]_SECRET/);
  return body;
};
const stored = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
try {
  await start();
  let cfg = await get();
  assert.equal(cfg.modelProfiles.length, 2);
  const [a, b] = cfg.modelProfiles.map(p => p.id);
  assert.equal(cfg.activeProfile, b);
  assert.deepEqual((await get()).modelProfiles, cfg.modelProfiles);
  assert.equal(cfg.modelProfiles[0].visionModel, 'vision-alpha');
  assert.equal(cfg.modelProfiles[0].stream, false);
  console.log('PASS: legacy profiles migrate without duplicates or credential disclosure');

  await post({ profileAction: 'save', profileId: a, profileName: '日常阅读', model: 'reader-alpha-edited', apiKey: '' });
  cfg = await get();
  assert.equal(cfg.activeProfile, a);
  assert.equal(cfg.modelProfiles.length, 2);
  assert.equal(stored().apiKey, oldA.apiKey, 'blank key must preserve the edited profile, not the previously active key');
  assert.equal(cfg.visionModel, oldA.visionModel);
  assert.equal(cfg.temperature, oldA.temperature);
  assert.equal(cfg.stream, oldA.stream);
  await post({ profileAction: 'save', profileId: a, model: 'reader-alpha-edited-again' });
  assert.equal((await get()).modelProfiles.length, 2);
  console.log('PASS: editing preserves identity, its own key and advanced settings');

  await post({ profileAction: 'create', profileName: '本地模型', model: 'reader-local', baseURL: endpoint });
  cfg = await get();
  const c = cfg.activeProfile;
  assert.notEqual(c, a); assert.notEqual(c, b);
  assert.equal(cfg.hasApiKey, false);
  assert.equal(stored().apiKey, '');
  assert.equal(cfg.visionModel, '');
  const concurrent = await Promise.all([1, 2, 3].map(n => post({ profileAction: 'create', model: `parallel-${n}`, baseURL: endpoint })));
  const concurrentIds = concurrent.map(r => r.config.activeProfile);
  assert.equal(new Set(concurrentIds).size, 3);
  assert.equal((await get()).modelProfiles.length, 6, 'parallel saves must not lose configurations');
  await Promise.all(concurrentIds.map(id => post({ profileAction: 'delete', profileId: id })));
  assert.equal((await get()).modelProfiles.length, 3, 'parallel deletes must not resurrect configurations');
  await post({ selectProfile: b });
  assert.equal(stored().apiKey, oldB.apiKey);
  await post({ profileAction: 'delete', profileId: a });
  cfg = await get();
  assert.equal(cfg.activeProfile, b);
  assert.deepEqual(cfg.modelProfiles.map(p => p.id), [b, c]);
  await post({ profileAction: 'delete', profileId: b });
  cfg = await get();
  assert.equal(cfg.activeProfile, c);
  assert.equal(cfg.model, 'reader-local');
  assert.equal(cfg.hasApiKey, false);
  console.log('PASS: creation does not inherit secrets; deletion keeps other IDs and selects the stated replacement');

  const beforeError = fs.readFileSync(CONFIG, 'utf8');
  await post({ profileAction: 'delete', profileId: a }, 400);
  await post({ profileAction: 'delete', profileId: c, model: 'conflicting-edit' }, 400);
  await post({ profileAction: 'delete', profileId: c, selectProfile: c }, 400);
  await post({ profileAction: 'save', profileId: c, baseURL: 'javascript:invalid' }, 400);
  await post({ profileAction: 'create', model: 'bad', baseURL: endpoint, profileName: 'x'.repeat(81) }, 400);
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), beforeError);
  await post({ profileAction: 'delete', profileId: c });
  await post({ longTermMemory: 'retained memory' });
  cfg = await get();
  assert.deepEqual(cfg.modelProfiles, []);
  assert.equal(cfg.activeProfile, '');
  for (const field of ['model', 'baseURL', 'apiKey', 'visionModel']) assert.equal(stored()[field], '');
  await stopChild(reader); await start();
  assert.deepEqual((await get()).modelProfiles, []);
  await post({ profileAction: 'create', profileName: '日常阅读', model: 'reader-alpha', baseURL: endpoint, apiKey: oldA.apiKey });
  cfg = await get();
  const first = cfg.activeProfile;
  assert.ok(![a, b, c].includes(first), 'deleted IDs must not be reused');
  await post({ profileAction: 'create', profileName: '图表识读', model: 'reader-beta', visionModel: 'vision-beta', baseURL: endpoint, apiKey: oldB.apiKey });
  const second = (await get()).activeProfile;
  console.log('PASS: invalid changes are atomic; deleting the last profile survives restart and unrelated saves');

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: true, userDataDir: path.join(scratch, 'browser'),
    args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1360, height: 960 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'networkidle0' });
  assert.deepEqual(await page.evaluate(async () => {
    const settings = window.__settings;
    const { theme, fontSize } = settings.data;
    await settings.save({ theme: 'dark', fontSize: 19 });
    const actual = { theme: settings.data.theme, fontSize: settings.data.fontSize };
    await settings.save({ theme, fontSize });
    return actual;
  }), { theme: 'dark', fontSize: 19 }, 'configuration response must preserve local appearance settings');
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal:not(.hidden)');
  await page.click('#settingsNavModel');
  const set = (selector, value) => page.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const enabled = () => page.waitForFunction(() => !document.querySelector('#saveSettings').disabled);
  const save = async () => {
    await page.click('#saveSettings');
    await page.waitForFunction(() => document.querySelector('#testResult').classList.contains('ok'));
    await enabled();
  };
  const dialog = accept => page.once('dialog', d => accept ? d.accept() : d.dismiss());

  await page.select('#cfgProfile', first);
  assert.equal((await get()).activeProfile, second, 'selection only previews the profile');
  assert.equal(await page.$eval('#cfgModel', el => el.value), 'reader-alpha');
  assert.equal(await page.$eval('#cfgApiKey', el => el.value), '');
  assert.equal(await page.$eval('#testModel', el => el.disabled), true);
  await page.click('#settingsNavMemory');
  await set('#cfgLongTermMemory', 'updated synthetic memory');
  await save();
  assert.equal((await get()).activeProfile, second, 'saving another pane must not activate a previewed profile');
  await page.click('#settingsNavModel');
  await page.select('#cfgProfile', first);
  await set('#cfgModel', 'reader-alpha-renamed');
  dialog(false); await page.select('#cfgProfile', second);
  assert.equal(await page.$eval('#cfgProfile', el => el.value), first);
  assert.equal(await page.$eval('#cfgModel', el => el.value), 'reader-alpha-renamed');
  dialog(false); await page.click('#closeSettings');
  assert.equal(await page.$eval('#settingsModal', el => el.classList.contains('hidden')), false);
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (input, options) => {
      if (String(input) === '/api/config' && options?.method === 'POST') {
        window.fetch = original;
        return Promise.resolve(new Response(JSON.stringify({ error: { message: 'synthetic write failure' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }));
      }
      return original(input, options);
    };
  });
  await page.click('#saveSettings');
  await page.waitForFunction(() => document.querySelector('#testResult').textContent.includes('synthetic write failure'));
  await enabled();
  assert.equal(await page.$eval('#cfgModel', el => el.value), 'reader-alpha-renamed');
  assert.equal((await get()).activeProfile, second, 'failed saves must retain the current profile');
  await save();
  assert.equal((await get()).activeProfile, first);
  assert.equal((await get()).modelProfiles.length, 2);
  assert.equal(chatCalls, 0, 'saving must not silently send a model request');
  await save();
  assert.equal((await get()).modelProfiles.length, 2);
  console.log('PASS: preview does not switch models, unsaved edits are protected, saving never adds duplicates or tests implicitly');

  await page.click('#testModel');
  await page.waitForFunction(() => document.querySelector('#testResult').textContent.includes('连接正常'));
  await enabled();
  assert.equal(chatCalls, 1);
  rejectChat = true;
  await page.click('#testModel');
  await page.waitForFunction(() => document.querySelector('#testResult').textContent.includes('配置仍已保存'));
  await enabled();
  assert.equal((await get()).activeProfile, first);
  rejectChat = false;
  console.log('PASS: connection tests are explicit and failure leaves the saved configuration intact');

  await page.click('#newProfile');
  assert.equal(await page.$eval('#cfgApiKey', el => el.value), '');
  assert.equal(await page.$eval('#cfgModel', el => el.value), '');
  assert.equal(await page.$eval('#deleteProfile', el => el.disabled), true);
  await set('#cfgProfileName', '独立新配置');
  await set('#cfgBaseURL', endpoint);
  await set('#cfgModel', 'reader-new');
  await save();
  const third = (await get()).activeProfile;
  assert.equal((await get()).hasApiKey, false);
  dialog(false); await page.click('#deleteProfile');
  assert.equal((await get()).modelProfiles.length, 3);
  dialog(true); await page.click('#deleteProfile');
  await page.waitForFunction(() => document.querySelector('#testResult').textContent === '配置已删除。');
  await enabled();
  cfg = await get();
  assert.equal(cfg.activeProfile, second);
  assert.ok(!cfg.modelProfiles.some(p => p.id === third));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal:not(.hidden)');
  await page.click('#settingsNavModel');
  assert.equal(await page.$$eval('#cfgProfile option', rows => rows.length), 2);
  assert.equal(await page.$eval('#cfgProfile', el => el.value), second);
  await page.screenshot({ path: path.join(scratch, 'settings-desktop.png') });
  await page.setViewport({ width: 540, height: 820 });
  await page.screenshot({ path: path.join(scratch, 'settings-narrow.png') });
  assert.ok(await page.$eval('.settings-box', el => el.scrollWidth <= el.clientWidth + 1), 'narrow dialog must not overflow horizontally');
  assert.ok(await page.$eval('.settings-nav', el => el.getBoundingClientRect().height < 80), 'narrow tabs must not retain the desktop sidebar width as their height');
  assert.ok(await page.evaluate(() => {
    const body = document.querySelector('.settings-body').getBoundingClientRect();
    const foot = document.querySelector('.settings-box .modal-foot').getBoundingClientRect();
    return body.bottom <= foot.top && foot.bottom <= innerHeight;
  }), 'narrow form and footer must not overlap or leave the viewport');
  assert.deepEqual(errors, []);
  console.log('PASS: new and deleted configurations persist through reload; no browser errors or narrow-dialog overflow');
  console.log(`Verified ${desktop ? 'desktop EXE' : 'Node'} backend. Screenshots: ${scratch}`);
} finally {
  await browser?.close();
  await stopChild(reader);
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
