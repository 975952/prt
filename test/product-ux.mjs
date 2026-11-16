/** Isolated product flows: compact entry, accessible actions and narrow layouts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const scratch = fs.mkdtempSync(path.join(SANDBOX, `product-ux-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'reading.pdf'));
const wait = ms => new Promise(r => setTimeout(r, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('product-ux').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} await wait(100); }
  assert.ok(ready);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1350, height: 880 } });
  const page = await browser.newPage(), errors = [], failedRequests = [], modelCalls = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) failedRequests.push(r.url()); });
  page.on('request', r => { if (/\/api\/(chat|translate|agent)/.test(r.url())) modelCalls.push(r.url()); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#welcomeWarn:not(.hidden) .welcome-action');
  assert.ok(!await page.$eval('#welcomeWarn', n => /data\/|不会离开/.test(n.textContent)));
  await page.click('#welcomeWarn .welcome-action');
  await page.waitForSelector('#settingsModal:not(.hidden)');
  assert.equal(await page.$eval('.settings-box', n => n.dataset.settingsPane), 'model');
  await page.click('#closeSettings');
  assert.equal(await page.$eval('.home-folder .hf-name', n => n.textContent), '未分组');
  await page.screenshot({ path: path.join(scratch, 'bookshelf.png') });
  await page.click('.home-item-go');
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.waitForFunction(async () => (await import('/js/sessions.js')).sessionsIsEntryMode());
  await page.waitForSelector('#aiArea .reading-welcome .welcome-action', { visible: true });
  await page.type('#chatInput', '保留我的草稿');
  await page.screenshot({ path: path.join(scratch, 'welcome-before-suggestion.png') });
  await page.click('#aiArea .welcome-action');
  assert.equal(await page.$eval('#chatInput', n => n.value), '保留我的草稿\n请解释当前页的核心概念。');
  assert.deepEqual(modelCalls, [], 'suggestions only fill a draft');
  await page.evaluate(() => { const n = document.querySelector('#chatInput'); n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#sessNew');
  await page.waitForFunction(() => window.__ctx.activeSession && !document.querySelector('#aiArea > .entry-card'));
  const sid = await page.evaluate(async () => {
    const e = window.__ctx.addEntry({ block: 'chat', tag: '回答', page: 1 });
    window.__ctx.finishEntry(e, '局部窗口将注意力计算限制在窗口内部。\n\n这是用于验证恢复的内容。');
    await window.__ctx.saveSessionNow();
    const sessions = await import('/js/sessions.js'); sessions.sessionsSetEnterMode('choose');
    const row = sessions.sessionsGetList().find(r => r.sid === window.__ctx.activeSession);
    return { sid: window.__ctx.activeSession, key: row?.fileKey };
  });
  const all = await fetch(`${base}/api/sessions?scope=all`).then(r => r.json());
  const record = all.sessions.find(r => r.sid === sid.sid);
  assert.ok(record, 'seeded conversation saved');
  const key = record.fileKey || record.doc;
  assert.ok(key, 'server returns session ownership');
  assert.ok((await fetch(`${base}/api/session?doc=${encodeURIComponent(key)}&sid=${sid.sid}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Swin Transformer 局部窗口机制' }),
  })).ok);
  await page.evaluate(() => window.__ctx.flushComposerDrafts());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#aiArea .entry-primary');
  assert.equal(await page.$eval('.entry-primary-main', n => n.textContent), 'Swin Transformer 局部窗口机制');
  assert.equal(await page.$eval('.entry-card', n => n.querySelectorAll('button').length), 3);
  assert.ok(!await page.$eval('.entry-card', n => /默认|自动恢复|选择卡片|null/.test(n.textContent)));
  await page.setViewport({ width: 1100, height: 650 });
  await page.evaluate(() => { const side = document.querySelector('#rightSide'); side.style.width = '300px'; side.style.minWidth = '300px'; side.style.maxWidth = '300px'; });
  const fit = await page.evaluate(() => {
    const side = document.querySelector('#rightSide'), card = document.querySelector('.entry-card'), composer = document.querySelector('#composer');
    return { width: side.getBoundingClientRect().width, overflow: side.scrollWidth - side.clientWidth,
      card: card.getBoundingClientRect().bottom, composer: composer.getBoundingClientRect().top,
      buttonOverflow: [...card.querySelectorAll('button')].some(n => n.scrollWidth > n.clientWidth + 1) };
  });
  assert.equal(fit.width, 300); assert.ok(fit.overflow < 2 && fit.card <= fit.composer + 1 && !fit.buttonOverflow, JSON.stringify(fit));
  await page.screenshot({ path: path.join(scratch, 'session-entry-narrow.png') });
  await page.click('.entry-link'); await page.waitForSelector('#sessHistory:not(.hidden)');
  await page.waitForFunction(() => document.querySelector('#sessHistory').textContent.includes('Swin Transformer'));
  await page.evaluate(() => [...document.querySelectorAll('.sess-foot-btn')].find(n => n.textContent === '会话设置').click());
  await page.waitForFunction(() => !document.querySelector('#settingsModal').classList.contains('hidden') && document.querySelector('.settings-box').dataset.settingsPane === 'session');
  assert.equal(await page.$eval('#settOnEnter', n => n.value), 'choose');
  await page.screenshot({ path: path.join(scratch, 'session-settings.png') });
  await page.click('#closeSettings'); await page.click('.sess-hist-back');
  await page.click('.entry-primary');
  await page.waitForFunction(() => document.querySelector('#aiArea .msg .text')?.textContent.includes('局部窗口'));
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), sid.sid);
  await page.click('#sessNew');
  await page.waitForFunction(old => window.__ctx.activeSession !== old && !!document.querySelector('#aiArea .reading-welcome'), {}, sid.sid);
  await page.click('.aibar-btn[data-block="translate"]');
  await page.waitForSelector('#aiArea .reading-welcome');
  assert.ok(await page.$eval('#aiArea', n => n.textContent.includes('读懂每一段')));
  assert.equal(await page.$eval('#composerHint', n => n.textContent), '');
  await page.screenshot({ path: path.join(scratch, 'translation-empty.png') });
  assert.deepEqual(modelCalls, []);
  assert.deepEqual(errors, []); assert.deepEqual(failedRequests, []);
  console.log(`PASS ${desktop ? 'desktop' : 'Node'} product UX: welcome, drafts, continue/new/history/settings, narrow layout and translation: ${scratch}`);
} finally { await browser?.close(); if (reader) await stopChild(reader); }
