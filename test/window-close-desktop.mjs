/** Native close handshake acceptance. Only a staged hidden EXE and isolated data.
 * CDP calls diagnostics and native IPC directly; no mouse, keyboard, focus,
 * screenshots, window visibility changes, real credentials or model requests.
 * node test/window-close-desktop.mjs (EXE may select an alternate build). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { ROOT, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const staged = stageExe('window-close');
const dataDir = assertIsolatedDataDir(path.join(staged.dir, 'data'));
const papersDir = path.join(staged.dir, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
for (const name of ['close-a.pdf', 'close-b.pdf']) {
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(papersDir, name));
}
const checks = [], errors = [], exits = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function until(fn, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch { /* Native page may be transitioning. */ }
    await wait(100);
  }
  throw new Error(`Timeout: ${label}`);
}
let reader, browser;
const servicePort = await freePort(), base = `http://127.0.0.1:${servicePort}`;
const observed = new WeakSet();
async function pages() {
  const rows = (await browser.pages()).filter(page => page.url().startsWith(base));
  for (const page of rows) if (!observed.has(page)) {
    observed.add(page); page.on('pageerror', error => errors.push(String(error)));
  }
  return rows;
}
async function ready(page) { await page.waitForFunction(() => !!window.__ctx && !!window.__state && window.__state.papers.length === 2, { timeout: 30000 }); }
async function start() {
  const debugPort = await freePort();
  reader = spawnReader(staged.exe, { args: ['--port', String(servicePort)], env: {
    PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  } });
  reader.on('exit', (code, signal) => exits.push({ code, signal }));
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'isolated HTTP service');
  const ws = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl, 'hidden WebView CDP');
  browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const page = await until(async () => (await pages())[0], 'hidden reader');
  await ready(page); return page;
}
async function ipc(page, type, extra = {}) {
  await page.evaluate((type, extra) => window.ipc.postMessage(JSON.stringify({ type, ...extra })), type, extra);
}
async function closeProcess(page) {
  await ipc(page, 'close'); await until(() => reader.exitCode !== null, 'clean final native close');
  assert.equal(reader.exitCode, 0); browser.disconnect(); browser = null;
}
try {
  let primary = await start();
  const listing = await (await fetch(`${base}/api/papers`)).json();
  assert.equal(path.resolve(listing.dir), path.resolve(papersDir));
  for (const asset of ['js/app.js', 'js/windows.js']) {
    assert.equal(await (await fetch(`${base}/${asset}`)).text(), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `${asset} is embedded current source`);
  }
  pass('staged native build serves current embedded close code with isolated papers and data');
  await primary.evaluate(async () => {
    localStorage.setItem('reader.session.aiTitle', '0');
    localStorage.setItem('reader.session.scopeMode', 'paper');
    await window.__ctx.openDoc(window.__state.papers.find(paper => paper.name === 'close-a.pdf'));
    const { sessionsHideEntryCard } = await import('/js/sessions.js'); sessionsHideEntryCard();
    await window.__ctx.newSession({ silent: true });
    await window.__viewer.goToPage(4);
    window.__nativeCloseRequests = [];
    const { t } = await import('/js/i18n.js');
    window.__closeFailurePrefix = t('保存失败，窗口已保留：{0}', '');
    window.addEventListener('prt-desktop', event => {
      if (event.detail?.type === 'close-request') window.__nativeCloseRequests.push(event.detail.request);
    });
    const nativeFetch = window.fetch;
    window.__nativeCloseSaveMode = 'fail';
    window.__nativeCloseSaveCalls = 0;
    window.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/session' && options?.method === 'POST') {
        window.__nativeCloseSaveCalls++;
        if (window.__nativeCloseSaveMode === 'fail') return Promise.resolve(new Response('{"error":"synthetic save failure"}', { status: 503 }));
        if (window.__nativeCloseSaveMode === 'hold') return new Promise(resolve => {
          (window.__nativeCloseReleases ||= []).push(() => resolve(nativeFetch(input, options)));
        });
      }
      return nativeFetch(input, options);
    };
    window.__ctx.addEntry({ block: 'chat', kind: 'user', text: 'NATIVE_CLOSE_RETAINED_MESSAGE' });
  });
  const owner = await primary.evaluate(() => ({ doc: window.__state.doc.docId, sid: window.__ctx.activeSession }));
  await ipc(primary, 'close');
  await primary.waitForFunction(() => window.__nativeCloseSaveCalls > 0 && document.body.textContent.includes(window.__closeFailurePrefix));
  assert.equal(reader.exitCode, null); assert.equal((await pages()).length, 1);
  assert.ok(await primary.evaluate(() => window.__state.sessionEntries.some(entry => entry.text === 'NATIVE_CLOSE_RETAINED_MESSAGE')));
  pass('a real native close with a failed save keeps the reader and unsaved conversation alive');

  const oldRequest = await primary.evaluate(() => window.__nativeCloseRequests.at(-1));
  assert.ok(Number.isSafeInteger(oldRequest) && oldRequest > 0);
  await ipc(primary, 'close-commit', { request: oldRequest }); await wait(150);
  assert.equal(reader.exitCode, null); assert.equal((await pages()).length, 1);
  pass('the shell rejects an old close acknowledgement after the save was cancelled');
  await primary.evaluate(() => { window.__nativeCloseSaveMode = 'hold'; });
  await ipc(primary, 'close');
  await primary.waitForFunction(old => window.__nativeCloseRequests.at(-1) > old && window.__nativeCloseReleases?.length, {}, oldRequest);
  await ipc(primary, 'close-commit', { request: oldRequest }); await wait(150);
  assert.equal(reader.exitCode, null); assert.equal((await pages()).length, 1);
  pass('a stale acknowledgement cannot close a newer attempt while its save is pending');
  await primary.evaluate(() => {
    window.__nativeCloseSaveMode = 'normal';
    window.__nativeCloseReleases.forEach(release => release());
  });
  await until(() => reader.exitCode !== null, 'retry completes saving and closes');
  assert.equal(reader.exitCode, 0); browser.disconnect(); browser = null;
  pass('the same native window can retry its close and exit cleanly after saving recovers');

  primary = await start();
  const restored = await (await fetch(`${base}/api/session?${new URLSearchParams(owner)}`)).json();
  assert.ok(restored.entries.some(entry => entry.text === 'NATIVE_CLOSE_RETAINED_MESSAGE'));
  const progress = await (await fetch(`${base}/api/state`)).json();
  assert.equal(progress.docs[owner.doc]?.page, 4);
  pass('restarting the isolated EXE finds the saved conversation and reading progress');
  const before = await pages();
  await primary.evaluate(async () => {
    const { sessionsHideEntryCard } = await import('/js/sessions.js'); sessionsHideEntryCard();
    await window.__ctx.openReaderWindow(window.__state.papers.find(paper => paper.name === 'close-b.pdf'));
  });
  const secondary = await until(async () => (await pages()).find(page => !before.includes(page)), 'hidden secondary reader');
  await ready(secondary);
  await ipc(primary, 'close'); await until(async () => (await pages()).length === 1, 'primary native close');
  assert.equal(reader.exitCode, null); assert.ok((await fetch(`${base}/api/health`)).ok);
  pass('closing the primary native window keeps its secondary reader and service alive');
  await closeProcess(secondary); pass('closing the last native reader exits the process cleanly');
  assert.deepEqual(errors, []); pass('native acceptance has no uncaught WebView errors');
  fs.writeFileSync(path.join(staged.dir, 'evidence.json'), JSON.stringify({ checks, errors, exits,
    exeSha256: crypto.createHash('sha256').update(fs.readFileSync(staged.exe)).digest('hex'),
    dataDir, papersDir, background: true, interaction: 'diagnostic JavaScript and native IPC only',
  }, null, 2), 'utf8');
  console.log(`window-close-desktop: ${checks.length}/${checks.length} passed; ${staged.dir}`);
} catch (error) {
  const diagnostics = browser ? await Promise.all((await pages()).map(page => page.evaluate(() => ({
    closeRequests: window.__nativeCloseRequests,
    saveCalls: window.__nativeCloseSaveCalls, saveMode: window.__nativeCloseSaveMode,
    workspace: window.__ctx?.agentWorkspaceState(), entries: window.__state?.sessionEntries,
    notices: [...document.querySelectorAll('.toast')].map(node => node.textContent),
  })).catch(error => ({ error: String(error) })))).catch(error => [{ error: String(error) }]) : [];
  fs.writeFileSync(path.join(staged.dir, 'failure.json'), JSON.stringify({ error: error.stack || String(error), checks, errors, exits, diagnostics }, null, 2), 'utf8');
  console.error(`Failure evidence: ${staged.dir}`); throw error;
} finally { browser?.disconnect(); await stopChild(reader); }
