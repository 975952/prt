/** Scanned PDF title inference and explicit page reading, with no real model calls.
 * node test/scan-title-topic.mjs [--desktop]
 * All PDFs, configuration and evidence live in test/artifacts/.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find(file => file && fs.existsSync(file));
assert.ok(executablePath, 'a Chromium browser is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `scan-title-topic-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data'));
const papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const fileName = 'Graph Neural Networks for Molecular Property Prediction.pdf';
const title = fileName.replace(/\.pdf$/i, '');
const topicAnswer = '根据标题判断，这篇论文大概讨论用图神经网络预测分子性质；这是标题推断，尚未核实正文。';
const pageAnswer = '已读第 2 页图片：合成页面中的公式为 y = Wx。';
const pageTranscription = 'SYNTHETIC_PAGE_TWO: The page contains the formula y = Wx.';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const checks = [], errors = [], modelRequests = [], requests = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };

/** A small image-only PDF: no text operators, bookmarks or inferred metadata. */
function scannedPdf() {
  const width = 128, height = 168, pixels = Buffer.alloc(width * height * 3, 255);
  for (let y = 16; y < height - 16; y++) for (let x = 14; x < width - 14; x++) {
    if (y % 10 < 2 && x % 19 < 16) pixels.fill(35, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  const objects = [], add = value => { objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii')); return objects.length; };
  const catalog = add(''), pages = add(''), compressed = deflateSync(pixels);
  const image = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`), compressed, Buffer.from('\nendstream')]));
  const pageIds = [];
  for (let i = 0; i < 3; i++) {
    const commands = 'q 612 0 0 792 0 0 cm /Scan Do Q\n';
    const stream = add(`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}endstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Scan ${image} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  objects[pages - 1] = Buffer.from(`<< /Type /Pages /Count 3 /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);
  const chunks = [Buffer.from('%PDF-1.4\n%SYNTHETIC\n')], offsets = [0];
  let offset = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    chunks.push(chunk); offset += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
fs.writeFileSync(path.join(papersDir, fileName), scannedPdf());

const textOf = content => Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : String(content || '');
const hasImages = body => (body.messages || []).some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
const systemOf = body => (body.messages || []).filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n');
const chunk = (res, delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
function answer(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  chunk(res, { content }); chunk(res, {}, 'stop'); res.end('data: [DONE]\n\n');
}
let phase = 'opening';
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    modelRequests.push({ phase, body });
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(systemOf(body))) { answer(res, '[]'); return; }
    if (phase === 'topic') { answer(res, topicAnswer); return; }
    if (phase === 'page' && body.tools?.length) {
      if (!(body.messages || []).some(message => message.role === 'tool')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        chunk(res, { tool_calls: [{ index: 0, id: 'read-scan-page-two', type: 'function',
          function: { name: 'read_page', arguments: '{"page":2}' } }] });
        chunk(res, {}, 'tool_calls'); res.end('data: [DONE]\n\n');
      } else answer(res, pageAnswer);
      return;
    }
    if (phase === 'page' && hasImages(body)) { answer(res, pageTranscription); return; }
    answer(res, 'UNEXPECTED_MODEL_REQUEST');
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(String(error)); }
});

let reader, browser, page, base;
const evidence = () => ({ desktop, checks, errors, requests, modelRequests: modelRequests.map(({ phase, body }) => ({
  phase, model: body.model, tools: body.tools?.map(tool => tool.function.name) || [], images: hasImages(body),
  messages: body.messages.map(message => ({ role: message.role, tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls, content: textOf(message.content) })),
})) });
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('scan-title-topic').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', data => fs.appendFileSync(path.join(scratch, 'server.log'), data));
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* service starting */ }
    if (!ready) await wait(100);
  }
  assert.ok(ready, 'isolated reader starts on its selected port');
  const listing = await fetch(`${base}/api/papers`).then(response => response.json());
  assert.equal(path.resolve(listing.dir), path.resolve(papersDir));
  assert.deepEqual(listing.papers.map(paper => paper.name), [fileName]);
  pass('reader uses only the isolated synthetic bookshelf');
  for (const asset of ['js/app.js', 'js/agent.js', 'js/prompts/capabilities/qa.js']) {
    const served = await fetch(`${base}/${asset}`).then(response => response.text());
    assert.equal(served, fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `${asset} matches current source`);
  }
  pass('reader serves current application and prompt assets');
  const configured = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'title-topic-mock',
      visionModel: 'page-vision-mock', apiKey: 'SYNTHETIC_TEST_KEY' }) });
  assert.ok(configured.ok);
  browser = await puppeteer.launch({ executablePath, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base) {
      requests.push({ method: request.method(), path: url.pathname });
      if (['/api/web-search', '/api/ref-search', '/api/import-pdf'].includes(url.pathname)) {
        errors.push(`Unexpected network-capable API: ${url.pathname}`);
        return request.abort();
      }
    } else if (['http:', 'https:'].includes(url.protocol)) {
      errors.push(`Unexpected external browser request: ${url.origin}${url.pathname}`);
      return request.abort();
    }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    localStorage.setItem('reader.session.scopeMode', 'paper');
    localStorage.setItem('reader.session.onEnter', 'latest');
    localStorage.setItem('reader.session.aiTitle', '0');
    localStorage.setItem('reader.agentRead', '1');
  });
  await page.goto(`${base}/?open=${encodeURIComponent(fileName)}&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(name => window.__state?.doc?.name === name && window.__viewer?.numPages === 3
    && window.__ctx.docProfile?.scanned === true, { timeout: 40000 }, fileName);
  const profile = await page.evaluate(async () => ({
    kinds: window.__ctx.docProfile.pages.map(row => row.kind),
    text: await Promise.all([1, 2, 3].map(number => window.__viewer.getPageText(number))),
    nativeOutline: await window.__viewer.getOutline(),
  }));
  assert.ok(profile.kinds.every(kind => kind === 'scan'));
  assert.ok(profile.text.every(text => !String(text).trim()));
  assert.deepEqual(profile.nativeOutline, []);
  await wait(1000);
  assert.equal(modelRequests.length, 0, 'opening and profiling scans must not call a model');
  assert.ok(!requests.some(request => /\/(?:outline|toc)(?:[/?-]|$)/i.test(request.path)));
  assert.equal(await page.$('#outlineStatus, #outlineRetry, .outline-status, .outline-retry'), null);
  assert.ok(!fs.readdirSync(dataDir).some(file => /^(?:toc|outline)-/i.test(file)));
  pass('image-only PDF opens and profiles without model calls, TOC requests or recognition controls');
  await page.evaluate(() => {
    window.__ctx.setPanelVisible('chat', true); window.__ctx.setScopeRange('current');
    // Memory extraction is independent of the title/read-page contract under test.
    window.__ctx.profileStore.enabled = false;
  });
  const ask = async (question, expected) => {
    await page.$eval('#chatInput', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, question);
    await page.click('#sendBtn');
    await page.waitForFunction(expected => !window.__state.busy
      && [...document.querySelectorAll('#aiArea .msg.assistant .text')].some(node => node.textContent.includes(expected)),
    { timeout: 60000 }, expected);
    await page.evaluate(() => window.__ctx.memoryIdle());
  };
  phase = 'topic';
  await ask('这篇论文大概讲什么主题？只需要判断内容方向。', topicAnswer);
  const topicRequests = modelRequests.filter(row => row.phase === 'topic');
  assert.equal(topicRequests.length, 1, 'the model can answer a topic question in one request');
  const topicBody = topicRequests[0].body;
  assert.ok(JSON.stringify(topicBody.messages).includes(title), 'the actual title reaches the model');
  assert.match(systemOf(topicBody), /标题推断/);
  assert.match(systemOf(topicBody), /根据标题判断/);
  assert.ok(topicBody.tools?.some(tool => tool.function.name === 'read_page'), 'reading tools remain available');
  assert.equal(hasImages(topicBody), false, 'topic inference does not preload scan images');
  assert.equal(await page.evaluate(() => window.__ctx.lastAgent?.stats.calls), 0, 'direct title answer executes no tools');
  pass('topic question carries the title and inference rule, and renders a qualified direct answer without reading images');

  phase = 'page';
  await ask('请读取 PDF 第 2 页，讲解其中的公式。', pageAnswer);
  const pageRequests = modelRequests.filter(row => row.phase === 'page').map(row => row.body);
  const visionRequest = pageRequests.find(body => !body.tools?.length && hasImages(body));
  assert.ok(visionRequest, 'read_page on a scan invokes vision reading');
  assert.equal(visionRequest.model, 'page-vision-mock');
  assert.match(textOf(visionRequest.messages.at(-1)?.content), /PDF 第 2 页/);
  const withTool = pageRequests.find(body => body.tools?.length && body.messages.some(message => message.role === 'tool'));
  assert.ok(withTool, 'vision result returns to the agent loop');
  assert.ok(withTool.messages.some(message => message.role === 'tool' && textOf(message.content).includes(pageTranscription)));
  const lastAgent = await page.evaluate(() => window.__ctx.lastAgent);
  assert.equal(lastAgent.stats.calls, 1);
  assert.ok(lastAgent.stats.pages.includes(2));
  assert.equal(pageRequests.length, 3, 'one tool round, one vision request and one answer round');
  pass('explicit page question still reads the correct image through read_page and returns its evidence');
  assert.deepEqual(errors, []);
  pass('browser and mock upstream complete without errors or external network requests');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify(evidence(), null, 2), 'utf8');
  console.log(`PASS ${checks.length} checks (${desktop ? 'desktop' : 'node'}); evidence: ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify(evidence(), null, 2), 'utf8');
  console.error(error); console.error(`Evidence: ${scratch}`); process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  if (desktop) await stopChild(reader); else { try { reader?.kill(); } catch { /* already exited */ } }
  upstream.closeAllConnections?.();
  await new Promise(resolve => upstream.close(resolve));
}
