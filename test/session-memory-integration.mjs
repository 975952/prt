/** Real application + real storage regression for memory inside Settings.
 * node test/session-memory-integration.mjs [--desktop]
 * Runs only isolated background services and a headless browser; no model calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild, waitForBase } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';

const desktop = process.argv.includes('--desktop');
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find(file => file && fs.existsSync(file));
assert(executablePath, 'Chromium is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `session-memory-integration-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data'));
const papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
writeTitlePdf(path.join(papersDir, 'memory-fixture.pdf'), { title: 'Synthetic memory verification paper' });
const errors = [], forbiddenRequests = [], checks = [];
const pass = message => { checks.push(message); console.log('PASS ' + message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, page, base, rejectMemoryWrite = false;
const query = sid => '/api/session?' + new URLSearchParams({ doc: 'default', sid });
const json = async (route, body, method = 'POST') => {
  const response = await fetch(base + route, body === undefined ? undefined : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(response.ok, `${method} ${route} returned ${response.status}`);
  return response.json();
};
const readDisk = sid => JSON.parse(fs.readFileSync(path.join(dataDir, `session-${sid}.json`), 'utf8'));
const untilSaved = async (sid, predicate, label) => {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const saved = await json(query(sid));
    if (predicate(saved.memories || [])) {
      assert(predicate(readDisk(sid).memories || []), `${label}: disk agrees with HTTP`);
      return saved;
    }
    await delay(40);
  }
  assert.fail(label + ': persisted state did not settle');
};
const visible = selector => page.$eval(selector, node => {
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return !!node.getClientRects().length && rect.width > 0 && rect.height > 0
    && style.visibility !== 'hidden' && style.display !== 'none';
});
const clickable = async selector => {
  await page.waitForSelector(selector, { visible: true });
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector), rect = node.getBoundingClientRect();
    return !node.disabled && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  }, {}, selector);
};
const settled = () => page.waitForFunction(() => document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true');
const fill = (selector, value) => page.$eval(selector, (node, value) => {
  node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
const closePanel = async () => {
  if (await visible('#settingsModal')) await page.click('#closeSettings');
};
const assertSettingsOnly = async () => {
  assert.equal(await page.$$eval('#agentMemory, #sessMemBtn', nodes => nodes.length), 0,
    'home, Alina and the reader do not expose standalone memory controls');
  assert(await page.$eval('#sessionMemoryPanel', node => !!node.closest('#settingsPaneMemory')
    && getComputedStyle(node).position !== 'fixed'), 'memory is embedded in the Settings memory page');
};
const sessionItems = '.memory-item[data-source="session"]';
const openPanel = async () => {
  if (!await visible('#settingsModal')) {
    await clickable('#settingsBtn');
    await page.click('#settingsBtn');
  }
  await page.waitForSelector('#settingsModal', { visible: true });
  await page.locator('#settingsNavMemory').click();
  await page.waitForSelector('#sessionMemoryPanel', { visible: true });
  await assertSettingsOnly();
};
const selectSession = async sid => {
  await closePanel();
  if (!await visible('#agentHistory')) {
    await page.evaluate(() => window.__ctx.openAgentWorkspace({ landing: true }));
    await settled();
  }
  if (!await visible('#sessHistory')) await page.click('#agentHistory');
  const selector = `#sessHistory .sess-hrow[data-sid="${sid}"] .sess-hgo`;
  await page.waitForSelector(selector, { visible: true });
  await page.locator(selector).click();
  await page.waitForFunction(sid => window.__ctx.activeSession === sid
    && !document.querySelector('#sessHistory').getClientRects().length
    && !document.body.classList.contains('agent-landing'), {}, sid);
  await settled();
};

try {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  child = desktop ? spawnReader(stageExe('session-memory-integration').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, windowsHide: true, stdio: 'ignore' });
  base = await waitForBase({ ports: [port], papersDir });
  assert(base, 'isolated service starts');
  const seed = (sid, text) => json(query(sid), { title: text, titleSource: 'user',
    entries: [{ id: sid + '-question', block: 'chat', kind: 'user', status: 'user', text }], history: [], ops: [] });
  await seed('memory-primary', 'Memory primary conversation');
  await seed('memory-secondary', 'Memory secondary conversation');
  const at = new Date().toISOString();
  await json('/api/profile', { version: 1, revision: 1, updatedAt: at, selfReport: '', selfReportAt: '', items: [{
    id: 'existing-global-name', topic: '称呼', aliases: [], level: '称呼：Cyan', boundary: '', note: '',
    status: 'confirmed', basis: 'user_self_report', createdAt: at, updatedAt: at, lastConfirmedAt: at,
    source: { docId: '', paper: '', capability: 'chat' },
    memory: { kind: 'identity', scope: 'global', signal: 'self_report', evidence: '记下来，我叫Cyan' },
  }] });
  browser = await puppeteer.launch({ executablePath, headless: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1400, height: 940 });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('dialog', dialog => void dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base && url.pathname === '/api/session' && request.method() === 'PATCH'
      && request.postData()?.includes('memoryOp') && rejectMemoryWrite) {
      rejectMemoryWrite = false;
      return request.respond({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Synthetic memory write failed' } }) });
    }
    if ((['http:', 'https:'].includes(url.protocol) && url.origin !== base)
      || (url.origin === base && url.pathname === '/api/chat')) {
      forbiddenRequests.push(url.href); return request.abort();
    }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    if (!localStorage.getItem('session-memory-integration-initialized')) {
      localStorage.setItem('reader.locale', 'zh-CN');
      localStorage.setItem('reader.session.scopeMode', 'global');
      localStorage.setItem('reader.session.onEnter', 'choose');
      localStorage.setItem('reader.session.aiTitle', '0');
      localStorage.setItem('reader.agentRead', '0');
      localStorage.setItem('reader.agent.welcome.v1', 'acknowledged');
      localStorage.setItem('session-memory-integration-initialized', '1');
    }
  });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && window.__state?.papers.length === 1);
  await page.waitForSelector('html:not([data-startup])');
  await assertSettingsOnly();
  await openPanel();
  assert.match(await page.$eval('.memory-item[data-memory-id="existing-global-name"] .memory-item-content', node => node.textContent), /Cyan/);
  assert.equal(await page.$$eval(sessionItems, items => items.length), 0);
  await page.screenshot({ path: path.join(scratch, 'home-settings-memory.png') });
  await closePanel();
  assert.equal(await visible('#sessionMemoryPanel'), false);
  pass('home Settings shows an existing global identity without opening a conversation');
  await page.click('#homeAgent'); await settled();
  await page.waitForSelector('body.agent-full.agent-landing', { visible: true });
  await assertSettingsOnly();
  await page.screenshot({ path: path.join(scratch, 'landing-entry.png') });
  await openPanel();
  const landingSid = await page.evaluate(() => __ctx.activeSession);
  await fill('.memory-add-input', 'Memory created before the first question');
  await page.click('.memory-add-btn');
  await untilSaved(landingSid, items => items.some(item => item.content === 'Memory created before the first question'), 'landing add');
  await page.screenshot({ path: path.join(scratch, 'landing-memory-open.png') });
  pass('Alina has no separate memory entry and Settings can persist a memory before the first question');

  await closePanel();
  await page.click('#agentSidebarToggle');
  await page.waitForSelector('body.agent-nav-collapsed');
  await openPanel();
  await closePanel();
  await page.click('#agentSidebarToggle');
  await page.setViewport({ width: 320, height: 844 });
  await page.screenshot({ path: path.join(scratch, 'mobile-entry.png') });
  await openPanel();
  assert(await page.$eval('#sessionMemoryPanel', node => {
    const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1;
  }));
  await page.locator(sessionItems + ' .memory-edit-btn').click();
  await fill('.memory-add-input', 'Memory edited on a small screen');
  await page.locator('.memory-add-btn').click();
  await untilSaved(landingSid, items => items.some(item => item.content === 'Memory edited on a small screen'), 'mobile edit');
  await page.screenshot({ path: path.join(scratch, 'mobile-memory-open.png') });
  await closePanel();
  await page.setViewport({ width: 1400, height: 940 });
  pass('Settings memory works with a collapsed sidebar and at a 320px viewport');

  await selectSession('memory-primary');
  assert(!await visible('#agentLanding'), 'history selects a real conversation');
  await openPanel();
  await fill('.memory-add-input', 'Primary memory');
  await page.click('.memory-add-btn');
  await untilSaved('memory-primary', items => items.length === 1 && items[0].content === 'Primary memory', 'primary add');
  await page.click(sessionItems + ' .memory-edit-btn');
  await fill('.memory-add-input', 'Edited primary memory');
  await page.select('.memory-add-category', 'reference');
  await page.click('.memory-add-btn');
  await untilSaved('memory-primary', items => items.length === 1 && items[0].content === 'Edited primary memory'
    && items[0].category === 'reference', 'primary edit');
  await selectSession('memory-secondary');
  await openPanel();
  assert.equal(await page.$$eval(sessionItems, items => items.length), 0, 'empty session does not show another session memory');
  assert.match(await page.$eval('.memory-item[data-source="profile"] .memory-item-content', node => node.textContent), /Cyan/);
  await selectSession('memory-primary'); await openPanel();
  assert.match(await page.$eval(sessionItems + ' .memory-item-content', node => node.textContent), /Edited primary memory/);
  await page.screenshot({ path: path.join(scratch, 'conversation-memory-open.png') });
  pass('full conversation edits persist once and switching sessions isolates memory lists');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx);
  await page.waitForSelector('html:not([data-startup])');
  await selectSession('memory-primary'); await openPanel();
  assert.equal(await page.$$eval(sessionItems + ' .memory-item-content', nodes => nodes.map(node => node.textContent).join('|')), 'Edited primary memory');
  await closePanel();
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('KeyM'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await page.waitForSelector('#sessionMemoryPanel', { visible: true });
  assert.equal(await visible('#settingsModal'), true);
  assert.equal(await page.$eval('#settingsNavMemory', node => node.getAttribute('aria-selected')), 'true');
  await assertSettingsOnly();
  pass('reloading restores saved memory and Ctrl+Shift+M opens the Settings memory page');

  rejectMemoryWrite = true;
  await fill('.memory-add-input', 'Retained after failed save'); await page.click('.memory-add-btn');
  await page.waitForSelector('.memory-retry-btn', { visible: true });
  assert.equal(await page.$eval('.memory-save-status', node => node.dataset.status), 'error');
  assert.match(await page.$eval('.memory-save-status', node => node.textContent), /未保存|失败|saved|Failed|failed/);
  assert((await page.$$eval('.memory-item-content', nodes => nodes.map(node => node.textContent))).includes('Retained after failed save'));
  assert(!(await json(query('memory-primary'))).memories.some(item => item.content === 'Retained after failed save'));
  await page.click('.memory-retry-btn');
  await untilSaved('memory-primary', items => items.some(item => item.content === 'Retained after failed save'), 'retry');
  pass('a rejected save remains visible with an explicit failure and retries successfully');

  await closePanel();
  await page.evaluate(() => __ctx.openAgentPaper(__state.papers[0]));
  await page.waitForSelector('body.agent-docked'); await settled();
  await assertSettingsOnly();
  await page.screenshot({ path: path.join(scratch, 'docked-entry.png') });
  await openPanel();
  assert.equal(await page.$$eval('#sessionMemoryPanel', nodes => nodes.length), 1, 'Settings owns a single embedded memory panel');
  assert.equal(await page.$$eval(sessionItems, nodes => nodes.length), 2);
  await page.screenshot({ path: path.join(scratch, 'docked-memory-open.png') });
  await page.click(sessionItems + ' .memory-delete-btn');
  await untilSaved('memory-primary', items => items.length === 1, 'first delete');
  await page.click(sessionItems + ' .memory-delete-btn');
  await untilSaved('memory-primary', items => items.length === 0, 'last delete');
  await page.evaluate(() => __ctx.saveSessionNow());
  assert.equal((await json(query('memory-primary'))).memories?.length || 0, 0);
  assert.equal(readDisk('memory-primary').memories?.length || 0, 0);
  pass('reader memory is managed only in Settings and deleting the last session item survives the chat save');

  await selectSession('memory-secondary'); await openPanel();
  rejectMemoryWrite = true;
  await fill('.memory-add-input', 'Failed memory in a conversation being deleted');
  await page.click('.memory-add-btn');
  await page.waitForSelector('.memory-retry-btn', { visible: true });
  assert.equal(await page.evaluate(() => __ctx.deleteSession('memory-secondary', { confirm: false, scope: 'default' })), true);
  assert.equal((await json(query('memory-secondary'))).deleted, true);
  await selectSession('memory-primary');
  await page.evaluate(() => __ctx.saveSessionNow());
  assert.equal((await json(query('memory-primary'))).entries[0].text, 'Memory primary conversation');
  pass('deleting a conversation with a failed memory save does not poison saves in the next conversation');

  const englishContext = await browser.createBrowserContext();
  page = await englishContext.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1400, height: 940 });
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if ((['http:', 'https:'].includes(url.protocol) && url.origin !== base)
      || (url.origin === base && url.pathname === '/api/chat')) {
      forbiddenRequests.push(url.href); return request.abort();
    }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'en');
    localStorage.setItem('reader.session.scopeMode', 'global');
    localStorage.setItem('reader.session.aiTitle', '0');
    localStorage.setItem('reader.agentRead', '0');
    localStorage.setItem('reader.agent.welcome.v1', 'acknowledged');
  });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx);
  await page.waitForSelector('html:not([data-startup])');
  await page.click('#homeAgent'); await settled();
  await assertSettingsOnly();
  await openPanel();
  assert.match(await page.$eval('#settingsNavMemory', node => node.textContent), /Memory|memory/);
  await page.screenshot({ path: path.join(scratch, 'english-memory-open.png') });
  pass('English Settings has a translated memory page without an extra main-screen entry');
  assert.deepEqual(errors, []);
  assert.deepEqual(forbiddenRequests, []);
  pass('the complete app loads without browser errors or model requests');
  console.log(`Session memory integration: ${checks.length}/${checks.length} passed (${desktop ? 'desktop' : 'Node'}); ${scratch}`);
} catch (error) {
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error('Failure artifacts: ' + scratch);
  if (errors.length || forbiddenRequests.length) console.error({ errors, forbiddenRequests });
  throw error;
} finally {
  await browser?.close();
  await stopChild(child);
}
