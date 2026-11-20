import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const staged = stageExe('icon-relaunch');
const probe = net.createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const env = { PRT_DATA_DIR: path.join(staged.dir, 'data'), PRT_PAPERS_DIR: path.join(staged.dir, 'papers'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
async function start() {
  reader = spawnReader(staged.exe, { env });
  for (let i = 0; i < 100 && !browser; i++) {
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }); }
    catch { await delay(150); }
  }
  assert.ok(browser, 'isolated WebView2 started');
}
const targets = () => browser.targets().filter(t => t.type() === 'page' && t.url().startsWith('http://127.0.0.1:'));
async function windows(count) {
  for (let i = 0; i < 100 && targets().length !== count; i++) await delay(100);
  assert.equal(targets().length, count);
  const pages = await Promise.all(targets().map(t => t.page()));
  for (const p of pages) await p.waitForFunction(() => !document.documentElement.hasAttribute('data-startup')
    && document.querySelector('#relaunchAction')?.disabled === false);
  return pages;
}
async function launchIcon() {
  // No arguments, as with an Explorer shortcut. Only the owning reader is hidden for the test.
  const child = spawn(staged.exe, [], { env: { ...process.env, ...env, PRT_BACKGROUND: '0' },
    windowsHide: true, stdio: 'ignore' });
  try { assert.equal((await once(child, 'exit', { signal: AbortSignal.timeout(12000) }))[0], 0); }
  finally { await stopChild(child); }
}
async function choose(page, mode) {
  await page.$eval('#settingsBtn', n => n.click());
  await page.waitForSelector('#settingsModal:not(.hidden)');
  await page.$eval('#settingsNavBehavior', n => n.click());
  await page.waitForSelector('#relaunchAction', { visible: true });
  await page.select('#relaunchAction', mode);
  await page.waitForFunction(mode => {
    const select = document.querySelector('#relaunchAction');
    return !select.disabled && select.value === mode;
  }, {}, mode);
  await page.$eval('#closeSettings', n => n.click());
}
try {
  await start();
  const [first] = await windows(1);
  assert.equal(await first.$eval('#relaunchAction', n => n.value), 'new');
  await first.evaluate(() => { window.originalWindowMarker = 1; });
  await Promise.all([launchIcon(), launchIcon()]);
  const pages = await windows(3);
  const keys = await Promise.all(pages.map(p => p.evaluate(() => window.__PRT_WINDOW_ID)));
  assert.equal(new Set(keys).size, 3);
  assert.equal(await first.evaluate(() => window.originalWindowMarker), 1);
  console.log('PASS two icon launches open two independent windows in the original process');
  for (const p of pages) await p.waitForSelector('#agentWelcome', { visible: true });
  await first.$eval('#agentWelcomeSkip', button => button.click());
  for (const p of pages) await p.waitForSelector('#agentWelcome', { hidden: true });
  console.log('PASS unanswered setup stays available in new windows and one explicit skip dismisses them all');
  await choose(first, 'focus');
  for (const p of pages) await p.waitForFunction(() => document.querySelector('#relaunchAction').value === 'focus');
  await launchIcon(); await delay(700); await windows(3);
  assert.equal(await first.evaluate(() => window.originalWindowMarker), 1);
  console.log('PASS showing an existing window preserves the three existing pages');
  browser.disconnect(); browser = null;
  await stopChild(reader);
  await start();
  const restored = await windows(3);
  assert.equal(await restored[0].$eval('#relaunchAction', n => n.value), 'focus');
  await launchIcon(); await delay(700); await windows(3);
  await choose(restored[0], 'new');
  await launchIcon(); await windows(4);
  assert.ok(fs.existsSync(path.join(env.PRT_DATA_DIR, 'reader-windows.json')));
  console.log('PASS the preference survives restart and switching back takes effect immediately');
} finally { browser?.disconnect(); await stopChild(reader); }
