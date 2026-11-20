/** Output-column resize rail follows answers, including zoomed and floating readers. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'text-edge-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'Reading.pdf'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser, page;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('text-edge').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready);
  assert.equal(await fetch(`${base}/js/app.js`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1800, height: 1100 } });
  page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    Element.prototype.requestFullscreen = () => Promise.resolve(); document.exitFullscreen = () => Promise.resolve();
  });
  await page.goto(base + '/?open=Reading.pdf&topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  const initialSession = await page.evaluate(() => __ctx.activeSession);
  await page.click('#sessNew');
  await page.waitForFunction(previous => __ctx.activeSession !== previous, {}, initialSession);
  await page.waitForSelector('#rightSide .ai-block[data-block="chat"] > .ai-body');
  await page.evaluate(() => {
    __ctx.setPanelVisible('chat', true); __ctx.applyPanels();
    __ctx.addEntry({ block: 'chat', kind: 'user', text: 'Why?' });
    __ctx.addEntry({ block: 'chat', kind: 'assistant', text: 'A longer synthetic answer explains the idea clearly. '.repeat(12) });
    const side = document.querySelector('#rightSide');
    side.style.width = side.style.minWidth = side.style.maxWidth = '760px';
    document.body.classList.remove('no-right');
  });
  const geometry = () => page.evaluate(() => {
    const side = document.querySelector('#rightSide');
    const body = side.querySelector('.ai-block:not(.hidden) > .ai-body');
    const answer = body.querySelector('.msg.assistant').getBoundingClientRect();
    const question = body.querySelector('.msg.user').getBoundingClientRect();
    const bounds = body.getBoundingClientRect();
    return { left: answer.left, right: answer.right, width: answer.width, questionLeft: question.left,
      y: Math.max(bounds.top + 30, Math.min(bounds.bottom - 50, answer.top + 50)),
      scale: bounds.width / body.offsetWidth, bodyWidth: body.clientWidth };
  });
  const checkHandle = async label => {
    const box = await geometry();
    await page.mouse.move(box.left - 12 * box.scale, box.y); await pause(50);
    const handle = await page.$eval('.text-edge-hint', node => {
      const r = node.getBoundingClientRect(); return { on: node.classList.contains('on'), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    assert.ok(handle.on, `${label}: answer edge reveals handle`);
    assert.ok(Math.abs(handle.x - (box.left - 12 * box.scale)) < 2, `${label}: rail stays outside the answer`);
    assert.ok(await page.$eval('.text-edge-hint', node => parseFloat(getComputedStyle(node).width) <= 4), `${label}: thin rail`);
    assert.ok(Math.abs(handle.y - box.y) < 2, `${label}: rail tracks pointer height`);
    return box;
  };
  const resize = async (label, target = 450) => {
    const before = await checkHandle(label), center = (before.left + before.right) / 2;
    await page.mouse.down();
    await page.mouse.move(center - (target / 2 + 12) * before.scale, before.y, { steps: 8 });
    await pause(50);
    const during = await geometry();
    assert.ok(Math.abs(during.width / during.scale - target) < 3, `${label}: intended ${target}, got ${during.width / during.scale}`);
    const rail = await page.$eval('.text-edge-hint', node => { const r = node.getBoundingClientRect(); return r.left + r.width / 2; });
    assert.ok(Math.abs(rail - (during.left - 12 * during.scale)) < 2, `${label}: dragged rail follows outside the answer`);
    await page.mouse.up();
    assert.ok(Math.abs(await page.evaluate(() => __ctx.uiStyle.maxWidth) - target) < 2);
    assert.ok(Math.abs(await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui')).style.maxWidth) - target) < 2);
  };
  let box = await geometry();
  assert.ok(box.questionLeft - box.left > 100, 'short question and answer must have different left edges');
  await page.mouse.move(box.questionLeft, box.y); await pause(50);
  assert.equal(await page.$eval('.text-edge-hint', node => node.classList.contains('on')), false, 'question bubble must not own output rail');
  await resize('docked', 520);
  console.log('PASS docked rail follows assistant column instead of the short question; drag persists width');

  await page.$eval('#rightSide', node => { node.style.zoom = '1.25'; });
  await resize('zoomed reader', 430);
  await checkHandle('zoomed reader after release');
  await page.screenshot({ path: path.join(scratch, 'zoomed-column.png') });
  await page.$eval('#rightSide', node => { node.style.removeProperty('zoom'); });
  console.log('PASS CSS zoom preserves rail coordinates and drag distance');

  await page.click('#readerMore');
  await page.click('#readerMoreMenu #immersiveBtn');
  await page.waitForFunction(() => __viewer.immersive);
  await page.evaluate(() => __ctx.immersiveReading.showChat(true));
  await page.$eval('#rightSide', node => { node.style.width = '660px'; node.style.minWidth = '320px'; node.style.maxWidth = 'calc(100vw - 16px)'; });
  const head = await page.$eval('#immersiveChatHead', node => { const r = node.getBoundingClientRect(); return { x: r.left + 50, y: r.top + r.height / 2 }; });
  await page.mouse.move(head.x, head.y); await page.mouse.down();
  await page.mouse.move(450, 220, { steps: 10 }); await page.mouse.up();
  await resize('moved immersive card', 400);
  await checkHandle('moved immersive card after release');
  await page.screenshot({ path: path.join(scratch, 'floating-column.png') });
  await page.evaluate(() => __ctx.immersiveReading.setActive(false));
  await page.waitForFunction(() => !__viewer.immersive);
  console.log('PASS moving the floating QA card retains alignment');

  await page.evaluate(() => __ctx.openAgentWorkspace({ landing: false }));
  await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  await page.keyboard.down('Control'); await page.keyboard.press('Equal'); await page.keyboard.press('Equal'); await page.keyboard.up('Control');
  await page.evaluate(() => {
    __ctx.addEntry({ block: 'chat', kind: 'user', text: 'Question in Alina' });
    __ctx.addEntry({ block: 'chat', kind: 'assistant', text: 'A readable answer in the full workspace.' });
  });
  box = await geometry();
  assert.ok(box.scale > 1.1, 'Alina uses changed agent zoom');
  await page.mouse.move(box.left + 1, box.y); await page.mouse.down();
  assert.equal(await page.evaluate(() => document.body.classList.contains('text-edge-dragging')), false, 'text selection must not activate the outside rail');
  await page.mouse.up();
  await resize('full Alina', 460);
  assert.deepEqual(errors, []);
  console.log(`PASS thin outside rail resizes full Alina without intercepting text selection; ${scratch}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Artifacts: ${scratch}`); throw error;
} finally { await browser?.close(); await stopChild(reader); }
