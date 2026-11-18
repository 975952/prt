/** Concise session switching, real persistence and keyboard access with isolated data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `session-quick-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser, page, checks = 0;
const errors = [];
const pass = label => { checks++; console.log(`PASS ${label}`); };
try {
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', PRT_QUIET_TOKEN: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('session-quick').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert(ready);
  for (const [sid, title, pinned] of [['first', 'A long discussion about visual token merging and the next experiment to run', true], ['second', 'A shorter discussion', false]]) {
    const response = await fetch(`${base}/api/session?doc=default&sid=${sid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      title, titleSource: 'user', pinned, updatedAt: Date.now() - 540000, entries: [
        { id: `${sid}-q`, kind: 'user', block: 'chat', text: 'Question', status: 'user' },
        { id: `${sid}-a`, kind: 'assistant', block: 'chat', text: `ANSWER_${sid}`, status: 'complete' }], history: [], ops: [] }) });
    assert(response.ok);
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-sandbox'], userDataDir: path.join(scratch, 'browser'), defaultViewport: { width: 1440, height: 940 } });
  page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'en'));
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.click('#homeAgent');
  await page.waitForSelector('#agentHistory', { visible: true }); await page.click('#agentHistory');
  await page.waitForSelector('#sessHistory .sess-hrow[data-sid="first"] .sess-hgo', { visible: true });
  await page.click('#sessHistory .sess-hrow[data-sid="first"] .sess-hgo');
  await page.waitForFunction(() => window.__ctx.activeSession === 'first' && document.querySelector('#aiArea').textContent.includes('ANSWER_first'));
  await page.click('#sessBtn');
  await page.waitForSelector('.sess-quick-row[data-sid="first"]', { visible: true });
  const visibleText = await page.$eval('#sessQuickPop', n => n.innerText);
  assert(!/Switch conversation|All papers|messages|minutes ago|View all conversations|Change conversation scope/.test(visibleText), visibleText);
  assert.equal(await page.$('.sess-quick-head,.sess-quick-meta'), null);
  assert.equal(await page.$$eval('.sess-quick-row', rows => rows.length), 2);
  assert(await page.$eval('.sess-quick-row[aria-current="true"]', n => n.dataset.sid === 'first' && n.querySelectorAll('.sess-quick-status').length === 2));
  pass('quick switch shows titles, selected/pinned icons and two short actions without metadata prose');
  await page.focus('.sess-quick-search'); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.sid), 'first');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__ctx.activeSession === 'second' && document.querySelector('#aiArea').textContent.includes('ANSWER_second'));
  pass('keyboard chooses a title and restores the actual independent conversation');
  await page.click('#sessBtn'); await page.waitForSelector('#sessQuickMore', { visible: true });
  assert.equal(await page.$eval('#sessQuickMenu', n => n.hidden), true);
  await page.focus('#sessQuickMore'); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sessQuickMove');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sessQuickMore');
  assert.equal(await page.$eval('#sessQuickMenu', n => n.hidden), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sessBtn');
  pass('More opens by keyboard and Escape returns focus through the menu and switcher');
  await page.click('#sessBtn'); await page.click('#sessQuickMore'); await page.click('#sessQuickMove');
  await page.waitForSelector('#sessMovePanel', { visible: true });
  await page.click('#sessMoveCancel');
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), 'second');
  pass('scope conversion remains available in More without altering the source on cancel');
  for (const [width, scale] of [[1440, 1], [900, 1.6], [320, 1], [320, 1.6]]) {
    await page.setViewport({ width, height: 940 });
    await page.evaluate(scale => document.documentElement.style.setProperty('--agent-scale', scale), scale);
    if (await page.$eval('#sessQuickPop', n => n.classList.contains('hidden'))) await page.click('#sessBtn');
    const geometry = await page.$eval('#sessQuickPop', n => {
      const r = n.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, overflow: n.scrollWidth > n.clientWidth + 1,
        buttons: [...n.querySelectorAll('button')].filter(b => b.getClientRects().length).every(b => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit === b || b.contains(hit); }) };
    });
    assert(geometry.left >= 0 && geometry.right <= width + 1 && !geometry.overflow && geometry.buttons, JSON.stringify(geometry));
    await page.screenshot({ path: path.join(scratch, `quick-${width}-${scale}.png`) });
    pass(`title switcher fits and all controls are reachable at ${width}px / ${scale}`);
  }
  assert.deepEqual(errors, []); pass('no browser errors');
  console.log(`session-quick-layout: ${checks}/${checks}; ${scratch}`);
} catch (error) {
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Artifacts: ${scratch}`); throw error;
} finally { await browser?.close(); await stopChild(reader); }
