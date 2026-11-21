/** Update UI regression with the real module and isolated Node app.
 * All release responses are local fixtures. Never downloads or installs a binary.
 * node test/updater-ui.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stopChild, waitForBase } from './_exe.mjs';

const chrome = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find(file => file && fs.existsSync(file));
assert(chrome, 'Chromium is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'updater-ui-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
const markup = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .match(/<section\b[^>]*id="settingsPaneUpdates"[^>]*>[\s\S]*?<\/section>/)?.[0];
assert(markup, 'the fixture uses the production update controls');
const checks = [], errors = [], forbidden = [];
const pass = message => { checks.push(message); console.log('PASS ' + message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, page, context, base;
const initial = (overrides = {}) => ({ supported: true, currentVersion: '1.4.4', mode: 'installed',
  phase: 'idle', availableVersion: '', error: '', bytes: 0, total: 0, autoCheckAllowed: true, ...overrides });
const fixture = options => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/style.css"><style>body{display:block;padding:28px}#settingsPaneUpdates{display:block;max-width:680px}.hidden{display:none}</style></head>
<body><input id="readingDraft" aria-label="Reading draft" value="Unsent question">${markup.replace('settings-pane hidden', 'settings-pane')}
<script type="module">
localStorage.setItem('reader.locale', 'en');
localStorage.setItem('reader.updates.autoCheck', ${JSON.stringify(options.auto === false ? '0' : '1')});
localStorage.setItem('reader.updates.lastCheck', ${JSON.stringify(String(options.lastCheck || 0))});
const { createAppUpdates } = await import('/js/app-updates.js');
window.updateEvents = { notifications: [], posts: [] };
window.updater = createAppUpdates({ root: document.querySelector('#settingsPaneUpdates'), native: true, autoDelay: 0,
  notify: version => updateEvents.notifications.push(version), postMessage: message => updateEvents.posts.push(message) });
document.querySelector('#readingDraft').focus();
await updater.start(); window.fixtureReady = true;
</script></body></html>`;

async function newFixture(options = {}) {
  await context?.close();
  context = await browser.createBrowserContext();
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.setViewport({ width: 1100, height: 760 });
  const api = { state: initial(options.state), checks: 0, downloads: 0, reads: 0,
    checkError: false, downloadError: false, holdStatus: false, heldStatuses: [] };
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    const respond = (value, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin === base && url.pathname === '/__update-test.html') {
      return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture(options) });
    }
    if (url.origin === base && url.pathname === '/api/update') {
      api.reads++;
      if (api.holdStatus) { const snapshot = { ...api.state }; api.heldStatuses.push(() => respond(snapshot)); return; }
      return respond(api.state);
    }
    if (url.origin === base && url.pathname === '/api/update/check') {
      assert.equal(request.method(), 'POST');
      api.checks++;
      if (api.checkError) return respond({ error: { message: 'Synthetic offline check' } }, 503);
      api.state = { ...api.state, phase: 'checking', error: '' };
      return respond(api.state);
    }
    if (url.origin === base && url.pathname === '/api/update/download') {
      assert.equal(request.method(), 'POST');
      api.downloads++;
      if (api.downloadError) {
        api.state = { ...api.state, phase: 'error', error: 'Synthetic checksum failure' };
        return respond(api.state);
      }
      api.state = { ...api.state, phase: 'downloading', error: '', bytes: 25, total: 100 };
      return respond(api.state);
    }
    if ((['http:', 'https:'].includes(url.protocol) && url.origin !== base) || url.pathname === '/api/chat') {
      forbidden.push(url.href); return request.abort();
    }
    return request.continue();
  });
  await page.goto(base + '/__update-test.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.fixtureReady);
  return api;
}
const status = () => page.$eval('#updateStatus', node => node.textContent);
const posts = () => page.evaluate(() => updateEvents.posts.map(message => JSON.parse(message)));
const waitPhase = phase => page.waitForFunction(phase => {
  const status = document.querySelector('#updateStatus');
  return phase === 'error' ? status.dataset.error === 'true'
    : phase === 'downloading' ? !document.querySelector('#updateProgress').hidden
      : phase === 'available' ? /1\.4\.5/.test(status.textContent)
        : phase === 'installing' ? /restart|saving/i.test(status.textContent) && document.querySelector('#updateInstall').disabled
          : false;
}, {}, phase);

try {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
      PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' } });
  base = await waitForBase({ ports: [port], papersDir: papers });
  assert(base, 'isolated service starts');
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu'],
    userDataDir: path.join(scratch, 'browser') });

  let api = await newFixture();
  await page.waitForFunction(() => /checking/i.test(document.querySelector('#updateStatus').textContent));
  assert.equal(api.checks, 1);
  assert.equal(api.downloads, 0);
  api.state = { ...api.state, phase: 'available', availableVersion: '1.4.5' };
  await waitPhase('available');
  assert.deepEqual(await page.evaluate(() => updateEvents.notifications), ['1.4.5']);
  assert.equal(await page.$eval('#readingDraft', node => document.activeElement === node && node.value === 'Unsent question'), true);
  assert.equal(api.downloads, 0);
  assert.deepEqual(await posts(), []);
  pass('startup check announces an update without downloading, installing, or taking focus');

  await page.click('#updateInstall');
  await waitPhase('downloading');
  assert.equal(api.downloads, 1);
  assert.equal(await page.$eval('#updateProgress', node => node.value / node.max), 0.25);
  assert.deepEqual(await posts(), []);
  api.state = { ...api.state, phase: 'ready', bytes: 100 };
  await page.waitForFunction(() => updateEvents.posts.length === 1);
  await page.evaluate(() => updater.refresh());
  assert.deepEqual(await posts(), [{ type: 'update-install' }]);
  assert.equal(await page.$eval('#updateInstall', node => node.disabled), true);
  pass('one click downloads and requests exactly one native install after verification is ready');

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('prt-desktop', {
    detail: { type: 'update-error', message: 'Synthetic window save failure' },
  })));
  await waitPhase('error');
  assert.match(await status(), /Synthetic window save failure/);
  assert.equal(await page.$eval('#updateInstall', node => node.disabled), false);
  assert.equal((await posts()).length, 1);
  pass('a native save failure keeps the page open with an error and an enabled retry');

  api = await newFixture({ auto: false, state: { phase: 'available', availableVersion: '1.4.5' } });
  api.downloadError = true;
  await page.click('#updateInstall');
  await waitPhase('error');
  assert.match(await status(), /Synthetic checksum failure/);
  assert.deepEqual(await posts(), []);
  api.downloadError = false;
  await page.click('#updateInstall');
  await waitPhase('downloading');
  assert.equal(api.downloads, 2);
  api.state = { ...api.state, phase: 'ready', bytes: 100 };
  await page.waitForFunction(() => updateEvents.posts.length === 1);
  assert.deepEqual(await posts(), [{ type: 'update-install' }]);
  pass('download or checksum failure never requests installation and a retry can complete');

  api = await newFixture({ auto: false, state: { phase: 'available', availableVersion: '1.4.5' } });
  api.holdStatus = true;
  await page.evaluate(() => { window.delayedStatus = updater.refresh(); });
  const holdDeadline = Date.now() + 5000;
  while (!api.heldStatuses.length && Date.now() < holdDeadline) await delay(10);
  assert.equal(api.heldStatuses.length, 1, 'the old status read is in flight');
  await page.click('#updateInstall');
  await waitPhase('downloading');
  api.holdStatus = false;
  await api.heldStatuses.shift()();
  await page.evaluate(() => delayedStatus);
  assert.equal(await page.$eval('#updateProgress', node => node.hidden), false);
  assert.deepEqual(await posts(), []);
  api.state = { ...api.state, phase: 'ready', bytes: 100 };
  await page.evaluate(() => updater.refresh());
  assert.deepEqual(await posts(), [{ type: 'update-install' }]);
  pass('a late pre-download status cannot overwrite progress or prevent the verified restart');

  api = await newFixture({ state: { phase: 'ready', availableVersion: '1.4.5', autoCheckAllowed: false } });
  await page.evaluate(() => updater.refresh());
  assert.deepEqual(await posts(), []);
  assert.equal(api.downloads, 0);
  await page.click('#updateInstall');
  await page.waitForFunction(() => updateEvents.posts.length === 1);
  assert.equal(api.downloads, 0);
  pass('an already downloaded update waits for an explicit click before restarting');

  for (const options of [{ auto: false }, { lastCheck: Date.now() }, { state: { autoCheckAllowed: false } }]) {
    api = await newFixture(options);
    await delay(40);
    assert.equal(api.checks, 0);
    assert.equal(api.downloads, 0);
  }
  await page.click('#updateAutoCheck');
  assert.equal(await page.evaluate(() => localStorage.getItem('reader.updates.autoCheck')), '0');
  pass('automatic checks respect the saved preference, daily interval, and backend restriction');

  const previousCheck = Date.now() - 3600000;
  for (const phase of ['available', 'up_to_date']) {
    api = await newFixture({ auto: false, lastCheck: previousCheck,
      state: { phase, availableVersion: phase === 'available' ? '1.4.5' : '' } });
    await page.evaluate(() => updater.refresh());
    assert.equal(await page.evaluate(() => localStorage.getItem('reader.updates.lastCheck')), String(previousCheck));
  }
  await page.click('#updateCheck');
  await page.waitForFunction(() => /checking/i.test(document.querySelector('#updateStatus').textContent));
  api.state = { ...api.state, phase: 'up_to_date' };
  await page.evaluate(() => updater.refresh());
  const completedCheck = await page.evaluate(() => Number(localStorage.getItem('reader.updates.lastCheck')));
  assert(completedCheck > previousCheck && completedCheck <= Date.now());
  pass('reading cached update status preserves the last-check time while a completed check advances it');

  api = await newFixture({ auto: false });
  api.checkError = true;
  await page.click('#updateCheck');
  await waitPhase('error');
  assert.match(await status(), /Synthetic offline check/);
  assert.deepEqual(await posts(), []);
  api.checkError = false;
  await page.click('#updateCheck');
  api.state = { ...api.state, phase: 'up_to_date' };
  await page.evaluate(() => updater.refresh());
  await page.waitForFunction(() => /latest|up to date/i.test(document.querySelector('#updateStatus').textContent));
  assert.equal(await page.$eval('#updateInstall', node => node.hidden), true);
  pass('an offline check can be retried and an up-to-date app has no install action');

  await context.close(); context = await browser.createBrowserContext(); page = await context.newPage();
  const nodeUpdateRequests = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/update')) nodeUpdateRequests.push(url.pathname);
    if ((['http:', 'https:'].includes(url.protocol) && url.origin !== base) || url.pathname === '/api/chat') {
      forbidden.push(url.href); return request.abort();
    }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'en');
    localStorage.setItem('reader.agent.welcome.v1', 'acknowledged');
  });
  await page.setViewport({ width: 1400, height: 940 });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx);
  await page.waitForSelector('html:not([data-startup])');
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal:not(.hidden)', { visible: true });
  await page.click('#settingsNavUpdates');
  await page.waitForSelector('#settingsPaneUpdates:not(.hidden)', { visible: true });
  assert.match(await status(), /Windows|desktop/i);
  assert.equal(await page.$eval('#updateCheck', node => node.disabled), true);
  assert.equal(await page.$eval('#updateInstall', node => node.hidden), true);
  assert.deepEqual(nodeUpdateRequests, []);
  await page.screenshot({ path: path.join(scratch, 'node-updates-settings.png') });
  pass('the actual Node app opens Settings Updates with an unsupported message and no release request');
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  pass('no browser errors, external network requests, model calls, or installer execution');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors, forbidden }, null, 2), 'utf8');
  console.log(`Updater UI: ${checks.length}/${checks.length} passed; ${scratch}`);
} catch (error) {
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error('Updater UI artifacts: ' + scratch);
  throw error;
} finally {
  await browser?.close();
  await stopChild(child);
}
