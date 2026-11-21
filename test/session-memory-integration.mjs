/** Real application + real storage regression for visible session memory controls.
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
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
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
  if (await visible('#sessionMemoryPanel')) await page.click('.memory-close-btn');
};
const openPanel = async selector => {
  await clickable(selector);
  if (!await visible('#sessionMemoryPanel')) await page.click(selector);
  await page.waitForSelector('#sessionMemoryPanel', { visible: true });
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
  await page.click('#homeAgent'); await settled();
  await page.waitForSelector('body.agent-full.agent-landing', { visible: true });
  await clickable('#agentMemory');
  assert.match(await page.$eval('#agentMemory', node => node.textContent), /会话记忆/);
  assert.equal(await visible('#sessBar'), false, 'the old hidden header is not the only memory entrance');
  await page.screenshot({ path: path.join(scratch, 'landing-entry.png') });
  await openPanel('#agentMemory');
  const landingSid = await page.evaluate(() => __ctx.activeSession);
  await fill('.memory-add-input', 'Memory created before the first question');
  await page.click('.memory-add-btn');
  await untilSaved(landingSid, items => items.some(item => item.content === 'Memory created before the first question'), 'landing add');
  await page.screenshot({ path: path.join(scratch, 'landing-memory-open.png') });
  pass('Alina landing has a labelled visible control and can persist the first memory before any chat');

  await closePanel();
  await page.click('#agentSidebarToggle');
  await page.waitForSelector('body.agent-nav-collapsed');
  await openPanel('#agentMemory');
  await closePanel();
  await page.click('#agentSidebarToggle');
  await page.setViewport({ width: 320, height: 844 });
  await clickable('#agentMemory');
  assert(await page.$eval('#agentMemory > span:last-child', node => node.scrollWidth <= node.clientWidth + 1),
    'the memory label is readable without truncation at 320px');
  await page.screenshot({ path: path.join(scratch, 'mobile-entry.png') });
  await openPanel('#agentMemory');
  assert(await page.$eval('#sessionMemoryPanel', node => {
    const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  }));
  await page.screenshot({ path: path.join(scratch, 'mobile-memory-open.png') });
  await closePanel();
  await page.setViewport({ width: 1400, height: 940 });
  pass('memory control works with a collapsed sidebar and at a 320px viewport');

  await selectSession('memory-primary');
  assert(!await visible('#agentLanding'), 'history selects a real conversation');
  await openPanel('#agentMemory');
  await fill('.memory-add-input', 'Primary memory');
  await page.click('.memory-add-btn');
  await untilSaved('memory-primary', items => items.length === 1 && items[0].content === 'Primary memory', 'primary add');
  await page.click('.memory-edit-btn');
  await fill('.memory-add-input', 'Edited primary memory');
  await page.select('.memory-add-category', 'reference');
  await page.click('.memory-add-btn');
  await untilSaved('memory-primary', items => items.length === 1 && items[0].content === 'Edited primary memory'
    && items[0].category === 'reference', 'primary edit');
  await selectSession('memory-secondary');
  await openPanel('#agentMemory');
  assert.equal(await page.$$eval('.memory-item', items => items.length), 0, 'empty session does not show another session memory');
  await selectSession('memory-primary'); await openPanel('#agentMemory');
  assert.match(await page.$eval('.memory-item-content', node => node.textContent), /Edited primary memory/);
  await page.screenshot({ path: path.join(scratch, 'conversation-memory-open.png') });
  pass('full conversation edits persist once and switching sessions isolates memory lists');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx);
  await page.waitForSelector('html:not([data-startup])');
  await selectSession('memory-primary'); await openPanel('#agentMemory');
  assert.equal(await page.$$eval('.memory-item-content', nodes => nodes.map(node => node.textContent).join('|')), 'Edited primary memory');
  await closePanel();
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('KeyM'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await page.waitForSelector('#sessionMemoryPanel', { visible: true });
  pass('reloading restores saved memory and Ctrl+Shift+M opens the real panel');

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
  await clickable('#sessMemBtn');
  assert.match(await page.$eval('#sessMemBtn', node => node.textContent), /记忆/);
  await page.screenshot({ path: path.join(scratch, 'docked-entry.png') });
  await openPanel('#sessMemBtn');
  assert.equal(await page.$$eval('#sessionMemoryPanel', nodes => nodes.length), 1, 'full and docked controls share a single panel');
  assert.equal(await page.$$eval('.memory-item', nodes => nodes.length), 2);
  await page.screenshot({ path: path.join(scratch, 'docked-memory-open.png') });
  await page.click('.memory-delete-btn');
  await untilSaved('memory-primary', items => items.length === 1, 'first delete');
  await page.click('.memory-delete-btn');
  await untilSaved('memory-primary', items => items.length === 0, 'last delete');
  await page.evaluate(() => __ctx.saveSessionNow());
  assert.equal((await json(query('memory-primary'))).memories?.length || 0, 0);
  assert.equal(readDisk('memory-primary').memories?.length || 0, 0);
  pass('reader has a labelled memory button and deleting the last item survives the normal chat save');

  await selectSession('memory-secondary'); await openPanel('#agentMemory');
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
  await clickable('#agentMemory');
  assert.match(await page.$eval('#agentMemory', node => node.textContent), /Conversation memory/);
  await openPanel('#agentMemory');
  assert.match(await page.$eval('.memory-panel-header', node => node.textContent), /Conversation memory/);
  await page.screenshot({ path: path.join(scratch, 'english-memory-open.png') });
  pass('English landing exposes a translated memory control that opens the same panel');
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
