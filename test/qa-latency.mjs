/** Isolated browser checks for response latency, citations, batching and cancellation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild, waitForBase, READER_PORTS } from './_exe.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'qa-latency-'));
const DATA = assertIsolatedDataDir(path.join(scratch, 'data'));
const PAPERS = path.join(scratch, 'papers');
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(PAPERS, 'latency.pdf'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let mode = 'direct';
let logs = [];
let active = 0;
let peak = 0;
let completed = [];
let finalEnded = false;
let heldReplies = [];
const holdReply = () => new Promise(resolve => heldReplies.push(resolve));
const chunk = (res, delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
const hasImages = (body) => body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
const reply = async (res, text, delay = 900) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  chunk(res, { content: text });
  await wait(delay);
  if (!res.destroyed) { chunk(res, { content: '（完成）' }, 'stop'); res.end('data: [DONE]\n\n'); }
  finalEnded = true;
};
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks));
  const sys = String(body.messages[0]?.content || '');
  if (/后台学习记忆提取器|滚动摘要|会话标题|问答会话起标题/.test(sys)) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
    return;
  }
  logs.push(body);
  if (mode.startsWith('waiting')) {
    if (mode === 'waiting-fallback' && body.tools) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tools unsupported' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(res, { reasoning_content: 'Synthetic reasoning heartbeat.' });
    await holdReply();
    if (res.destroyed) return;
    if (mode === 'waiting-tools' && !body.messages.some(row => row.role === 'tool')) {
      chunk(res, { tool_calls: [{ index: 0, id: 'status-page', function: { name: 'read_page', arguments: '{"page":3}' } }] });
      chunk(res, {}, 'tool_calls'); res.end('data: [DONE]\n\n');
    } else {
      chunk(res, { content: 'STATUS_FINAL_ANSWER' });
      await holdReply();
      if (!res.destroyed) { chunk(res, {}, 'stop'); res.end('data: [DONE]\n\n'); }
    }
    return;
  }
  const last = body.messages.at(-1)?.content;
  const one = typeof last === 'string' && last.startsWith('本次只解答下面这一道题') ? Number(last.match(/PERF_Q(\d)/)?.[1]) : 0;
  if (one) {
    active++;
    peak = Math.max(peak, active);
    try {
      if (mode === 'batch-fail' && one === 3) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock question failure' } }));
      } else {
        await reply(res, `ANSWER_${one}`, mode === 'batch-stop' ? 3000 : [0, 1100, 250, 650, 300, 300, 300][one]);
        completed.push(one);
      }
    } finally { active--; }
    return;
  }
  if (mode === 'unsupported' && body.tools) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'tools unsupported' } }));
    return;
  }
  if ((mode.startsWith('batch') || mode === 'tools' || mode === 'ready' || mode === 'scan' || mode === 'escalate') && body.tools) {
    if (!body.messages.some((m) => m.role === 'tool')) {
      const tool = mode === 'scan' ? 'read_page_image' : 'read_page';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(res, { tool_calls: [
        { index: 0, id: 'page3', function: { name: tool, arguments: '{"page":3}' } },
        { index: 1, id: 'page5', function: { name: tool, arguments: mode === 'scan' ? '{"page":3}' : '{"page":5}' } },
      ] });
      chunk(res, {}, 'tool_calls');
      res.end('data: [DONE]\n\n');
    } else if (mode.startsWith('batch') || mode === 'ready') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '材料已读够。' } }] }));
    } else await reply(res, '读取后的短答案。〔p.3〕 未读页〔p.8〕');
    return;
  }
  if (hasImages(body)) { await reply(res, mode === 'image' ? '截图内容的模型回答。' : '第3页的识读文本。', 150); return; }
  if (mode === 'keepalive' && body.tools) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < 5; i++) {
      chunk(res, { content: `持续输出${i}。` });
      await wait(350);
    }
    res.end('data: [DONE]\n\n');
    return;
  }
  await reply(res, mode === 'direct' ? '短答案。' : '回退后的最终答案。');
});

let reader;
let browser;
const watchdog = setTimeout(() => { console.error('qa-latency timed out'); process.exit(3); }, 120000);
watchdog.unref();
try {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const readerPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const desktop = process.argv.includes('--desktop');
  if (desktop) reader = spawnReader(stageExe('qa-latency').exe, { env: {
    PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
  } });
  else reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(readerPort), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' }, stdio: 'ignore',
  });
  const BASE = desktop ? await waitForBase({ ports: READER_PORTS, papersDir: PAPERS }) : `http://127.0.0.1:${readerPort}`;
  assert.ok(BASE, 'isolated reader must start');
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
    await wait(100);
  }
  // An external test base must also use disposable fixture data.
  const listing = await (await fetch(`${BASE}/api/papers`)).json();
  assertIsolatedDataDir(resolveDataDir(listing.dir));
  assert.ok(listing.papers.some((p) => p.name === 'latency.pdf'), 'test fixture base required');
  assert.ok((await fetch(`${BASE}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'openai/gpt-6-luna', apiKey: 'fake-test-key' }) })).ok);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', headless: 'shell', userDataDir: path.join(scratch, 'chrome-profile'), args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1450, height: 950 } });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(`${BASE}/?open=latency.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0 && window.__state.viewerDocId === window.__state.doc.docId);
  await page.evaluate(() => { window.__ctx.setPanelVisible('chat', true); window.__ctx.setScopeRange('current'); window.__ctx.setAgentRead(true); });
  const start = async (text = '请核对这篇论文的核心方法。') => {
    logs = []; completed = []; peak = 0; finalEnded = false;
    await page.evaluate((text) => {
      const input = document.querySelector('#chatInput');
      input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.click('#sendBtn');
  };
  const finish = () => page.waitForFunction(() => !window.__state.busy, { timeout: 30000 });
  const lastText = () => page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent || '');
  const attachImage = () => page.evaluate(() => window.__state.attachments.push({ id: crypto.randomUUID(), kind: 'image', label: 'test screenshot', w: 1, h: 1,
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }));

  const waitForHeld = async count => {
    for (let i = 0; i < 200 && heldReplies.length < count; i++) await wait(25);
    assert.ok(heldReplies.length >= count, `synthetic request ${count} reached the gate`);
  };
  const waitingSlots = () => page.evaluate(() => {
    const last = [...document.querySelectorAll('#aiArea .msg.assistant')].at(-1);
    return {
      labels: [...last.querySelectorAll('.thinking,.agent-steps .as-text')].filter(n => n.getClientRects().length).map(n => n.textContent),
      composer: /Thinking|思考/.test(document.querySelector('#composerHint').textContent),
      record: last.__sessionRecord.text,
    };
  });
  for (const waitingMode of ['waiting-tools', 'waiting-fallback', 'waiting-stop']) {
    mode = waitingMode; heldReplies = [];
    await start('请核对这篇论文的核心方法。');
    await waitForHeld(1);
    let view = await waitingSlots();
    assert.equal(view.labels.length, 1, `${mode}: exactly one waiting label`);
    assert.equal(view.composer, false, `${mode}: composer does not duplicate thinking`);
    assert.equal(view.record, '', `${mode}: waiting text is not saved as an answer`);
    if (mode === 'waiting-stop') {
      await page.evaluate(() => window.__state.abort.abort());
      await finish(); heldReplies[0]();
      assert.equal((await waitingSlots()).labels.length, 0, 'stopping removes the pending state');
    } else {
      heldReplies[0]();
      let finalGate = 2;
      if (mode === 'waiting-tools') {
        await waitForHeld(2);
        view = await waitingSlots();
        assert.equal(view.labels.length, 1, 'second model round still owns only one waiting label');
        assert.equal(view.record, '', 'tool status stays out of persisted answer text');
        heldReplies[1](); finalGate = 3;
      }
      await waitForHeld(finalGate);
      await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('STATUS_FINAL_ANSWER'));
      assert.equal((await waitingSlots()).labels.length, 0, `${mode}: streaming replaces the waiting label`);
      heldReplies[finalGate - 1](); await finish();
      assert.equal((await waitingSlots()).record, 'STATUS_FINAL_ANSWER');
    }
  }
  console.log('PASS: one waiting state across tool rounds, unsupported-tool fallback and stop; streaming replaces it without saving status as prose');
  mode = 'direct';

  await page.evaluate(() => {
    window.__latencyOldProfile = { profile: window.__state.docProfile, doc: window.__state.docProfileDoc, promise: window.__state.docProfilePromise };
    window.__state.docProfile = null; window.__state.docProfileDoc = null;
    window.__state.docProfilePromise = new Promise(() => {});
  });
  const quickStarted = Date.now();
  await start('什么是自注意力？');
  await page.waitForFunction(() => window.__state.busy && [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('短答案。'));
  assert.equal(finalEnded, false, 'answer must be visible before the model finishes');
  const firstTextMs = Date.now() - quickStarted;
  assert.ok(firstTextMs < 2500, `local first text should arrive within seconds: ${firstTextMs}`);
  await finish();
  assert.equal(logs.length, 1, 'short direct answer must not be generated twice');
  assert.equal(logs[0].stream, true);
  assert.equal(logs[0].reasoning_effort, 'none', 'configured Luna uses its Chat Completions tool-compatible reasoning mode');
  assert.equal(Boolean(logs[0].tools), true, 'the model must have tools even when it chooses a direct answer');
  assert.match(await lastText(), /短答案。/);
  await page.evaluate(() => {
    const old = window.__latencyOldProfile;
    window.__state.docProfile = old.profile; window.__state.docProfileDoc = old.doc; window.__state.docProfilePromise = old.promise;
  });
  console.log(`PASS: ordinary answer bypasses whole-document scanning; model chooses direct answer in one streamed request (${firstTextMs} ms)`);

  await start('？'); await finish();
  assert.equal(logs.length, 1, 'a question mark must not cause a forced material-gathering request: ' + JSON.stringify(logs.map((b) => ({ tools: !!b.tools, system: String(b.messages[0]?.content).slice(0, 180) }))));
  assert.ok(logs[0].tools?.length > 0, 'a question mark must not disable model-selected tools either');
  assert.match(await lastText(), /短答案/);
  assert.doesNotMatch(logs[0].messages[0].content, /PRT_NEEDS_MATERIALS|查一下.*重新生成/);
  console.log('PASS: question-mark reply is model generated, with tools available and no forced re-read');

  mode = 'image';
  await page.evaluate(() => { window.__state.history = [
    { role: 'user', content: '1×1卷积再简单讲一下', focus: { text: '旧选区：FPN通道变换', page: 2, kind: 'selection', source: '' } },
    { role: 'assistant', content: '1×1卷积会在每个位置重新组合通道。' },
  ]; });
  await attachImage(); await attachImage(); await start('所以到底是第一种还是第二种'); await finish();
  assert.equal(logs.length, 1, 'initial screenshot must not need a second generation');
  assert.ok(hasImages(logs[0]) && logs[0].tools?.length > 0);
  const visualParts = logs[0].messages.at(-1).content;
  assert.equal(visualParts.filter((p) => p.type === 'image_url').length, 2);
  assert.match(visualParts[0].text, /本轮新附件|本轮新发的 2 张截图/);
  assert.doesNotMatch(visualParts[0].text, /【选中文本 · 本次追问沿用/);
  assert.match(visualParts.at(-1).text, /【读者此刻的问题】所以到底是第一种还是第二种/);
  assert.ok(logs[0].messages.some((m) => m.role === 'assistant' && String(m.content).includes('重新组合通道')));
  assert.match(await lastText(), /截图内容的模型回答/);
  assert.match(await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant')].at(-1)?.querySelector('.entry-basis')?.textContent || ''), /(?:本轮 2 张截图|2 screenshots)/);
  console.log('PASS: two fresh screenshots and the question take precedence while prior conversation stays available');

  mode = 'tools';
  await start('？'); await finish();
  assert.equal(logs.length, 2, 'one tool round plus one answer, without extra generation');
  assert.deepEqual(logs[1].messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ['page3', 'page5']);
  const pages = await page.evaluate(() => [...[...document.querySelectorAll('#aiArea .msg.assistant')].at(-1).querySelectorAll('.page-ref')].map((n) => n.dataset.page));
  assert.ok(pages.includes('3'));
  assert.ok(!pages.includes('8'));
  console.log('PASS: tool streams preserve result order, reuse short answers and enforce citation pages');

  mode = 'escalate';
  const beforeEscalate = await page.evaluate(() => document.querySelectorAll('#aiArea .msg.assistant').length);
  await start('解释一下这个概念。'); await finish();
  // The follow-on material read starts immediately after the first request unwinds.
  await page.waitForFunction(() => !window.__state.busy && [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('读取后的短答案'));
  assert.equal(logs.length, 2);
  assert.ok(Boolean(logs[0].tools) && Boolean(logs[1].tools));
  assert.equal(await page.evaluate(() => document.querySelectorAll('#aiArea .msg.assistant').length), beforeEscalate + 1);
  console.log('PASS: ordinary wording also permits model-selected tool calls without an extra routing request');

  mode = 'scan';
  await start(); await finish();
  assert.equal(logs.filter(hasImages).length, 1, 'same-page calls must share one vision request');
  assert.equal(logs.length, 3, 'page OCR must not trigger another final image upload');
  console.log('PASS: concurrent reads of one image share OCR and avoid repeat image generation');

  mode = 'ready';
  await start(); await finish();
  assert.match(await lastText(), /回退后的最终答案/);
  assert.equal(logs.length, 3, 'readiness marker is not a user answer');
  mode = 'unsupported';
  await start(); await finish();
  assert.equal(logs.length, 2);
  assert.equal(Boolean(logs.at(-1).tools), false);
  assert.match(await lastText(), /回退后的最终答案/);
  console.log('PASS: readiness-only and unsupported-tool responses still generate final answers');

  mode = 'keepalive';
  await page.evaluate(() => { window.__agentTestLimits = { callTimeoutMs: 1000 }; });
  const keepaliveStarted = Date.now();
  await start(); await finish();
  fs.writeFileSync(path.join(scratch, 'keepalive.json'), JSON.stringify({ elapsed: Date.now() - keepaliveStarted,
    requests: logs.map(body => ({ tools: !!body.tools, hasImages: hasImages(body) })),
    agent: await page.evaluate(() => window.__lastAgent), text: await lastText() }, null, 2), 'utf8');
  assert.equal(logs.length, 1, 'healthy streams longer than timeout must not restart');
  assert.match(await lastText(), /持续输出4/);
  await page.evaluate(() => { delete window.__agentTestLimits; });
  console.log('PASS: active streaming refreshes idle timeout instead of aborting a healthy answer');

  // Parallel generation requires the user's explicit independence instruction;
  // ordinary numbered derivation steps must remain one connected request.
  assert.equal(await page.evaluate(() => window.__ctx.splitNumberedQuestions('1. 推导公式\n2. 代入上一步结果\n3. 解释结果')), null);
  const six = '以下题目相互独立，请查原文后逐题回答。\n' + Array.from({ length: 6 }, (_, i) => `${i + 1}. PERF_Q${i + 1} 请完整作答。`).join('\n');
  mode = 'batch';
  await attachImage();
  const began = Date.now();
  await start(six); await finish();
  const elapsed = Date.now() - began;
  assert.equal(peak, 3);
  assert.equal(logs.filter((b) => b.tools).length, 2, 'batch shares one material-gathering loop');
  assert.equal(logs.filter((b) => !b.tools).length, 6);
  assert.ok(logs.filter((b) => !b.tools).every(hasImages), 'all question requests retain the original screenshot after material gathering');
  assert.equal(completed[0], 2, 'finish order should differ from question order');
  const text = await lastText();
  for (let i = 1; i <= 6; i++) {
    assert.match(text, new RegExp(`ANSWER_${i}`));
    if (i > 1) assert.ok(text.indexOf(`ANSWER_${i - 1}`) < text.indexOf(`ANSWER_${i}`));
  }
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant')].at(-1).querySelectorAll('.answer-card').length), 6);
  console.log(`PASS: six questions run with concurrency 3, retain order/cards, and share materials (${elapsed} ms)`);

  mode = 'batch-fail';
  await start(six); await finish();
  const partial = await lastText();
  assert.match(partial, /mock question failure/);
  assert.match(partial, /ANSWER_6/);
  console.log('PASS: a failed question does not prevent the other questions from completing');

  mode = 'batch-stop';
  await start(six);
  await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('ANSWER_1'));
  await page.evaluate(() => window.__state.abort.abort());
  await finish();
  await wait(300);
  assert.ok(logs.filter((b) => !b.tools).length <= 3, 'stop must not start queued questions');
  assert.match(await lastText(), /ANSWER_1/);
  assert.deepEqual(errors, []);
  console.log('PASS: stop cancels active questions, preserves partial text and leaves queued questions unstarted');
} finally {
  heldReplies.forEach(release => release());
  clearTimeout(watchdog);
  await browser?.close();
  await stopChild(reader);
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
