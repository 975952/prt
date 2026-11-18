/** Isolated reading-output UI checks. node test/reading-output.mjs [--desktop] */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const CHROME = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((file) => file && fs.existsSync(file));
assert.ok(CHROME);
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `reading-output-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'reading-output.pdf'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const requests = [];
let mode = 'success';
const delta = (res, content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const part of req) chunks.push(part);
  const body = JSON.parse(Buffer.concat(chunks));
  if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
  }
  requests.push(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  delta(res, '已经收到的译文。\n\n');
  await wait(60);
  if (mode === 'fail-partial') { res.destroy(); return; }
  delta(res, '第二段译文保留完整意思。');
  res.end('data: [DONE]\n\n');
});
let reader, browser;
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0',
    PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('reading-output').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await wait(100);
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ }
  }
  assert.ok(ready, 'isolated reader starts');
  const embedded = await fetch(`${base}/js/util.js`).then((res) => res.text());
  assert.equal(embedded, fs.readFileSync(path.join(ROOT, 'public/js/util.js'), 'utf8'), 'reader serves current renderer');
  const config = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'reading-mock-a', apiKey: 'SYNTHETIC_READING_KEY' }) });
  assert.ok(config.ok);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    userDataDir: path.join(scratch, 'browser'), defaultViewport: { width: 1400, height: 940 } });
  const page = await browser.newPage();
  // This fixture asserts Chinese action labels; isolate its locale as well as data.
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${base}/?open=reading-output.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.evaluate(async () => {
    const sessions = await import('/js/sessions.js');
    await sessions.sessionsOpenLatestForOutput();
    document.body.classList.remove('no-right');
    window.__ctx.setPanelVisible('chat', true); window.__ctx.applyPanels();
    window.__ctx.setAgentRead(false); window.__ctx.setScopeRange('current');
  });

  const batches = await page.evaluate(() => ({
    related: window.__ctx.splitNumberedQuestions('1. 推导公式\n2. 将结果代入\n3. 解释上一步的结果'),
    independent: window.__ctx.splitNumberedQuestions('下面是相互独立的问题：\n1. 什么是矩阵？\n2. 什么是概率？'),
  }));
  assert.equal(batches.related, null);
  assert.equal(batches.independent?.questions.length, 2);
  const beforeIme = requests.length;
  const beforeEntries = await page.evaluate(() => {
    const input = document.querySelector('#chatInput');
    input.value = '正在选择中文候选词';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    return window.__state.sessionEntries.length;
  });
  await wait(180);
  assert.equal(requests.length, beforeIme);
  assert.equal(await page.evaluate(() => window.__state.sessionEntries.length), beforeEntries);
  await page.evaluate(() => { document.querySelector('#chatInput').value = ''; });
  console.log('PASS dependent numbered steps stay together and Chinese IME Enter does not send');

  const answer = '先说明当前这一步。\n\n## 关键推导\n\n3. 保留前提\n   - 条件 A\n   - 条件 B\n\n4. 使用前一步结果\n\n随后代入：\n\n\\[\\begin{aligned}a&=b\\\\\nc&=d\\end{aligned}\\]\n\n| 项目 | 数值 |\n|---|---:|\n| A | 12 |\n| B | 24 |\n\n最后解释这个结果。\n\n';
  await page.evaluate(() => {
    const entry = window.__ctx.addEntry({ block: 'chat', tag: 'answer', page: 1 });
    window.__outputTest = { entry, target: window.__ctx.streamTarget(entry.body) };
  });
  for (let n = 30; n < answer.length; n += 33) {
    await page.evaluate((text) => window.__outputTest.target.push(text), answer.slice(0, n)); await wait(25);
  }
  await page.evaluate((text) => window.__outputTest.target.push(text), answer);
  await wait(180);
  const stream = await page.evaluate(() => {
    const body = window.__outputTest.entry.body;
    const clone = body.cloneNode(true);
    clone.querySelectorAll('.stream-tail').forEach((node) => node.replaceWith(...node.childNodes));
    return { html: clone.innerHTML.replace(/>\s+</g, '><').trim(), ordered: body.querySelectorAll('ol').length,
      nested: body.querySelectorAll('ol > li > ul > li').length, math: body.querySelectorAll('.katex-display').length,
      rows: body.querySelectorAll('table tbody tr').length };
  });
  assert.equal(stream.ordered, 1); assert.equal(stream.nested, 2);
  assert.equal(stream.math, 1); assert.equal(stream.rows, 2);
  const finished = await page.evaluate((text) => {
    window.__outputTest.target.done(text);
    window.__ctx.finishEntry(window.__outputTest.entry, text);
    return window.__outputTest.entry.body.innerHTML.replace(/>\s+</g, '><').trim();
  }, answer);
  assert.equal(finished, stream.html, 'completed content has the same structure before and after done');
  await (await page.$('#rightSide')).screenshot({ path: path.join(scratch, 'reading-answer.png') });
  console.log('PASS streaming nested lists, display formulas and tables retain final structure');

  const cards = '## 第1题\n\n第一题的答案。\n\n## 第2题\n\n第二题的答案。\n\n';
  await page.evaluate((text) => {
    const entry = window.__ctx.addEntry({ block: 'chat', tag: 'answer' });
    window.__cardTest = { entry, target: window.__ctx.streamTarget(entry.body) };
    window.__cardTest.target.push(text);
  }, cards);
  await page.waitForFunction(() => window.__cardTest.entry.body.querySelector('.answer-cards'));
  const clickedCard = await page.evaluate(() => {
    const box = window.__cardTest.entry.body.querySelector('.answer-cards');
    box.querySelector('[data-card-action="next"]').click();
    return { connected: box.isConnected, index: box.dataset.index, html: box.querySelector('.answer-card-controls').outerHTML };
  });
  assert.equal(clickedCard.index, '1', JSON.stringify(clickedCard));
  await page.evaluate((text) => window.__cardTest.target.push(text), `${cards}继续补充。`);
  await wait(160);
  assert.equal(await page.evaluate(() => window.__cardTest.entry.body.querySelector('.answer-cards').dataset.index), '1');
  await page.evaluate((text) => window.__cardTest.target.done(text), `${cards}继续补充。`);
  assert.equal(await page.evaluate(() => window.__cardTest.entry.body.querySelector('.answer-cards').dataset.index), '1');
  await page.evaluate(() => window.__cardTest.entry.body.querySelector('[data-card-action="toggle"]').click());
  const continuous = await page.evaluate(() => {
    const box = window.__cardTest.entry.body.querySelector('.answer-cards');
    return { mode: box.dataset.mode, visible: [...box.querySelectorAll('.answer-card')].filter((node) => !node.hidden).length };
  });
  assert.deepEqual(continuous, { mode: 'continuous', visible: 2 });
  // A separate active stream verifies a view choice survives the final update.
  await page.evaluate((text) => {
    window.__cardTest.target = window.__ctx.streamTarget(window.__cardTest.entry.body);
    window.__cardTest.target.push(text);
  }, cards);
  await wait(160);
  await page.evaluate(() => window.__cardTest.entry.body.querySelector('[data-card-action="toggle"]').click());
  await page.evaluate((text) => window.__cardTest.target.push(text), `${cards}更多内容。`);
  await wait(160);
  await page.evaluate((text) => window.__cardTest.target.done(text), `${cards}更多内容。`);
  assert.equal(await page.evaluate(() => window.__cardTest.entry.body.querySelector('.answer-cards').dataset.mode), 'continuous');
  await (await page.$('#rightSide')).screenshot({ path: path.join(scratch, 'reading-cards.png') });
  console.log('PASS question cards exist while streaming and preserve selected question/continuous mode');

  const partial = await page.evaluate(() => {
    const entry = window.__ctx.addEntry({ block: 'chat', tag: 'answer' });
    const target = window.__ctx.streamTarget(entry.body);
    target.push('已收到的有效内容。\n\n');
    target.fail('本次连接中断');
    return { text: entry.body.textContent, saved: entry.root.__sessionRecord.text };
  });
  assert.ok(partial.text.includes('已收到的有效内容。'));
  assert.ok(partial.text.includes('本次连接中断'));
  assert.ok(partial.saved.includes('已收到的有效内容。'));
  console.log('PASS failed stream keeps readable and persisted partial output');

  const original = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}: The original conditions and values must remain unchanged.`).join('\n\n');
  await page.evaluate(async (text) => {
    window.__ctx.setPanelVisible('translate', true); window.__ctx.applyPanels();
    const input = document.querySelector('#chatInput'); input.value = text;
    await window.__ctx.send();
  }, original);
  const sourceClosed = await page.evaluate(() => {
    const row = document.querySelector('.ai-block[data-block="translate"] .msg');
    const details = row.querySelector('.translation-original');
    const source = row.querySelector('.translation-source');
    return { closed: !details.open, visible: source.checkVisibility(), text: source.textContent };
  });
  assert.ok(sourceClosed.closed && !sourceClosed.visible, 'the original starts collapsed');
  assert.equal(sourceClosed.text, original, 'the complete original is retained');
  await page.click('.ai-block[data-block="translate"] .msg .translation-original > summary');
  const sourceView = await page.evaluate(() => {
    const row = document.querySelector('.ai-block[data-block="translate"] .msg');
    const source = row.querySelector('.translation-source');
    source.scrollIntoView({ block: 'center' });
    const css = getComputedStyle(source);
    const rect = source.getBoundingClientRect();
    const first = document.createRange();
    first.setStart(source.firstChild, 0); first.setEnd(source.firstChild, 'Paragraph 1:'.length);
    const line = first.getBoundingClientRect();
    return { visible: source.checkVisibility(), width: rect.width, height: rect.height,
      firstVisible: line.top >= rect.top && line.bottom <= rect.bottom,
      scrollable: source.scrollHeight > source.clientHeight,
      scrollHeight: source.scrollHeight, overflow: css.overflowY,
      size: css.fontSize, bodySize: getComputedStyle(row.querySelector('.text')).fontSize };
  });
  assert.ok(sourceView.visible && sourceView.width > 0 && sourceView.height > 0, 'expanding reveals the original');
  assert.ok(sourceView.firstVisible, 'the first paragraph is visible when expanded');
  assert.equal(sourceView.size, sourceView.bodySize, 'the original uses the reading font size');
  if (sourceView.scrollable) {
    assert.ok(['auto', 'scroll'].includes(sourceView.overflow), 'a bounded original must permit user scrolling');
    const sourceBox = await (await page.$('.ai-block[data-block="translate"] .msg .translation-source')).boundingBox();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.wheel({ deltaY: sourceView.scrollHeight });
    await page.waitForFunction(() => {
      const source = document.querySelector('.ai-block[data-block="translate"] .msg .translation-source');
      return source.scrollTop + source.clientHeight >= source.scrollHeight - 1;
    });
  }
  const sourceEnd = await page.evaluate(() => {
    const source = document.querySelector('.ai-block[data-block="translate"] .msg .translation-source');
    const rect = source.getBoundingClientRect();
    const last = document.createRange();
    last.setStart(source.firstChild, source.textContent.lastIndexOf('unchanged.'));
    last.setEnd(source.firstChild, source.textContent.length);
    const line = last.getBoundingClientRect();
    return { visible: line.top >= Math.max(0, rect.top) && line.bottom <= Math.min(innerHeight, rect.bottom) + 1,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  assert.ok(sourceEnd.visible, 'the final words can be brought fully into view');
  assert.ok(sourceEnd.overflow <= 1, 'expanded original does not widen the application');
  await (await page.$('#rightSide')).screenshot({ path: path.join(scratch, 'reading-translation.png') });
  console.log('PASS translation original is collapsed by default and is readable through its final paragraph');

  mode = 'fail-partial';
  await page.evaluate(async () => {
    document.querySelector('#translateTargetLang').value = '中文';
    await window.__ctx.doTranslate({ text: 'Retry language fixture.', cleanText: 'Retry language fixture.', page: 1 });
    window.__retryTranslation = document.querySelector('.ai-block[data-block="translate"] .msg');
  });
  const failed = await page.evaluate(() => ({
    status: window.__retryTranslation.__sessionRecord.status,
    text: window.__retryTranslation.__sessionRecord.text,
  }));
  assert.equal(failed.status, 'failed'); assert.ok(failed.text.includes('已经收到的译文。'));
  const beforeRetry = requests.length;
  mode = 'success';
  await page.evaluate(() => {
    document.querySelector('#translateTargetLang').value = 'English';
    window.__retryTranslation.querySelector('.acts button').click();
  });
  await page.waitForFunction(() => !window.__state.busy && window.__state.sessionEntries.at(-1)?.status === 'complete');
  assert.equal(requests.length, beforeRetry + 1);
  assert.ok(String(requests.at(-1).messages[0].content).includes('翻译成中文'));
  console.log('PASS failed translation keeps partial text and retry keeps its original target language');

  await page.evaluate(async () => {
    document.querySelector('#translateTargetLang').value = '中文';
    await window.__ctx.doTranslate({ text: 'Cache scope fixture.', cleanText: 'Cache scope fixture.', page: 1 });
  });
  const afterInitial = requests.length;
  await page.evaluate(() => window.__ctx.doTranslate({ text: 'Cache scope fixture.', cleanText: 'Cache scope fixture.', page: 1 }));
  assert.equal(requests.length, afterInitial, 'same request uses translation cache');
  await page.evaluate(async () => {
    const { Settings } = await import('/js/ai.js');
    await Settings.save({ model: 'reading-mock-b' });
    await window.__ctx.doTranslate({ text: 'Cache scope fixture.', cleanText: 'Cache scope fixture.', page: 1 });
  });
  assert.equal(requests.length, afterInitial + 1);
  assert.equal(requests.at(-1).model, 'reading-mock-b');
  console.log('PASS changing the model invalidates translation cache');

  await page.evaluate(() => window.__ctx.saveSessionNow());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__viewer?.pdf && !window.__state.busy
    && window.__state.sessionEntries.some((entry) => entry.quote === 'Cache scope fixture.' && entry.status === 'complete'));
  const restored = await page.evaluate(() => {
    document.body.classList.remove('no-right');
    window.__ctx.setPanelVisible('translate', true); window.__ctx.applyPanels();
    const rows = [...document.querySelectorAll('.ai-block[data-block="translate"] .msg')];
    const failed = rows.find((row) => row.__sessionRecord?.quote === 'Retry language fixture.' && row.__sessionRecord?.status === 'failed');
    const complete = rows.find((row) => row.__sessionRecord?.quote === 'Cache scope fixture.' && row.__sessionRecord?.status === 'complete');
    window.__restoredFailure = failed;
    window.__restoredSuccess = complete;
    return { failed: failed && { text: failed.querySelector('.text').textContent, status: failed.__sessionRecord.status,
      retry: failed.querySelector('.acts').textContent },
      complete: complete && { text: complete.querySelector('.text').textContent,
        actions: [...complete.querySelectorAll('.acts button')].map((button) => button.getAttribute('aria-label') || button.textContent) },
      count: window.__state.sessionEntries.length };
  });
  assert.equal(restored.failed?.status, 'failed');
  assert.ok(restored.failed.text.includes('已经收到的译文。'));
  assert.ok(restored.failed.retry.includes('重试'));
  assert.ok(restored.complete?.actions.includes('重新翻译'));
  const beforeRestoredRetry = requests.length;
  await page.evaluate(() => window.__restoredFailure.querySelector('.acts button').click());
  await page.waitForFunction((count) => window.__state.sessionEntries.length > count && !window.__state.busy
    && window.__state.sessionEntries.at(-1)?.status === 'complete', {}, restored.count);
  assert.equal(requests.length, beforeRestoredRetry + 1);
  const countBeforeRetranslate = await page.evaluate(() => {
    const count = window.__state.sessionEntries.length;
    window.__restoredSuccess.querySelector('.acts button[aria-label="重新翻译"]').click();
    return count;
  });
  await page.waitForFunction((count) => window.__state.sessionEntries.length > count && !window.__state.busy
    && window.__state.sessionEntries.at(-1)?.status === 'complete', {}, countBeforeRetranslate);
  assert.equal(requests.length, beforeRestoredRetry + 2);
  console.log('PASS reload retains failed partial output/retry and successful translation regeneration');
  assert.deepEqual(errors, []);
  console.log(`PASS ${desktop ? 'desktop' : 'Node'} reading output: ${scratch}`);
} finally {
  await browser?.close();
  await stopChild(reader);
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
