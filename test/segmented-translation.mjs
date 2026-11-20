/** Segmented translation UI regression. node test/segmented-translation.mjs [--desktop]
 * Uses an isolated reader, synthetic PDFs and a controlled local model only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const CHROME = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((file) => file && fs.existsSync(file));
assert.ok(CHROME, 'Chrome or Edge is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `segmented-translation-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
const OPENING = 'Selected opening paragraph before the figure.';
const CAPTION = 'UNSELECTED_CAPTION_SENTINEL';
const FOOTNOTE = 'UNSELECTED_FOOTNOTE_SENTINEL';
const SELECTED_FOOTNOTE = 'Footnote 2: EXPLICIT_SELECTED_FOOTNOTE_SENTINEL must remain.';

function fixturePdf() {
  const objects = [];
  const add = (text) => { objects.push(text); return objects.length; };
  const catalog = add(''), root = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const lines = [[OPENING, `Figure 1: ${CAPTION}.`, 'Selected continuation after the figure.', `Footnote 1: ${FOOTNOTE}.`],
    ['Selected closing paragraph on page two.', SELECTED_FOOTNOTE], ['Third-page continuation with no extra material.']];
  const pages = lines.map((pageLines) => {
    const stream = 'BT /F1 12 Tf 55 750 Td 22 TL\n' + pageLines.map((line, index) => `${index ? 'T* ' : ''}(${line.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n') + '\nET';
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${root} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${root} 0 R >>`;
  objects[root - 1] = `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
fs.writeFileSync(path.join(papers, 'segments-a.pdf'), fixturePdf());
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'segments-b.pdf'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const requests = [], waiters = new Map(), evidence = [];
const allText = (request) => request.body.messages.map((message) => typeof message.content === 'string' ? message.content
  : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')).join('\n');
const userText = (request) => String(request.body.messages.at(-1).content);
function nextRequest(index) {
  if (requests[index]) return Promise.resolve(requests[index]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(index); reject(new Error(`Expected request ${index + 1}; received ${requests.length}`)); }, 15000);
    waiters.set(index, (request) => { clearTimeout(timer); resolve(request); });
  });
}
function emit(request, text) {
  assert.ok(!request.res.destroyed && !request.res.writableEnded);
  if (!request.started) { request.res.writeHead(200, { 'Content-Type': 'text/event-stream' }); request.started = true; }
  request.res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
}
function complete(request, text) { emit(request, text); request.res.end('data: [DONE]\n\n'); }
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    const request = { body, res, started: false };
    requests.push(request); const notify = waiters.get(requests.length - 1);
    waiters.delete(requests.length - 1); notify?.(request);
  } catch { if (!res.destroyed) res.destroy(); }
});

let reader, browser, page, stagedExe;
let passed = 0;
const pass = (name, detail = {}) => { passed++; evidence.push({ name, ...detail }); console.log(`PASS ${name}`); };
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe); const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0',
    PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  if (desktop) stagedExe = stageExe('segmented-translation').exe;
  reader = desktop ? spawnReader(stagedExe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let index = 0; index < 100 && !ready; index++) { await wait(100); try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} }
  assert.ok(ready, 'isolated reader starts');
  const assetHashes = [];
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();
  // index.html receives a per-process authentication bootstrap at runtime.
  for (const asset of ['js/app.js', 'js/composer-drafts.js', 'js/draft-persistence.js', 'js/translation-queue.js',
    'js/selection-reading-order.js', 'style.css']) {
    const response = await fetch(`${base}/${asset}`); assert.ok(response.ok, `${asset} is served`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, fs.readFileSync(path.join(ROOT, 'public', asset)), `${asset} matches the current source byte-for-byte`);
    assetHashes.push({ asset, bytes: bytes.length, sha256: hash(bytes) });
  }
  assert.ok((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'segments-mock', apiKey: 'SYNTHETIC_SEGMENTS_KEY' }) })).ok);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    userDataDir: path.join(scratch, 'browser'), defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.agent.welcome.v1', 'acknowledged'));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  const errors = []; page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${base}/?open=segments-a.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  const loaded = () => page.waitForFunction(() => window.__viewer?.pdf && window.__ctx?.addToTranslate
    && !document.documentElement.hasAttribute('data-startup')
    && window.__state.viewerDocId === window.__state.doc?.docId, { timeout: 15000 });
  await loaded();
  await page.evaluate(async () => {
    const sessions = await import('/js/sessions.js'); await sessions.sessionsOpenLatestForOutput();
    document.body.classList.remove('no-right');
    window.__ctx.setPanelVisible('chat', true); window.__ctx.applyPanels();
    window.__ctx.setAgentRead(false); window.__ctx.setScopeRange('current');
  });
  const mode = async (name) => {
    if (await page.$eval('#rightSide', (node) => node.dataset.activePanel) !== name) await page.click(`#aiBar .aibar-btn[data-block="${name}"]`);
    await page.waitForFunction((wanted) => document.querySelector('#rightSide').dataset.activePanel === wanted, {}, name);
  };
  const draft = () => page.evaluate(() => ({ text: document.querySelector('#chatInput').value, attachments: window.__state.attachments }));
  const setInput = (text) => page.$eval('#chatInput', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  const clearDraft = async () => {
    await setInput('');
    while (await page.$('#attachRow .at-x')) await page.$eval('#attachRow .at-x', (button) => button.click());
  };
  const add = (text, pageNumber = 1, extra = {}) => page.evaluate(async (selection) => window.__ctx.addToTranslate(selection),
    { text, cleanText: text, page: pageNumber, endPage: pageNumber, pages: [pageNumber],
      rectsByPage: { [pageNumber]: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }] }, ...extra });
  const edit = (index, text) => page.evaluate(({ index, text }) => {
    const row = document.querySelectorAll('#attachRow .translation-segment')[index];
    row.open = true; const input = row.querySelector('textarea.at-edit');
    input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { index, text });
  const control = (index, selector) => page.evaluate(({ index, selector }) => document.querySelectorAll('#attachRow .translation-segment')[index].querySelector(selector).click(), { index, selector });
  const idle = () => page.waitForFunction(() => !window.__state.busy, { timeout: 15000 });
  const paused = async () => { await idle(); await page.waitForFunction(() => {
    const button = document.querySelector('#translationBatchReturn'); return button && !button.disabled && button.getClientRects().length;
  }, { timeout: 15000 }); };
  const unchanged = async (count, message) => { await wait(300); assert.equal(requests.length, count, message); };
  const textVisible = (text) => page.waitForFunction((wanted) => [...document.querySelectorAll('.ai-block .text')].some((node) => node.textContent.includes(wanted)), { timeout: 15000 }, text);
  const send = async () => { const index = requests.length; await page.click('#sendBtn'); return nextRequest(index); };
  const records = () => page.evaluate(() => window.__state.sessionEntries.filter((entry) => entry.block === 'translate'));
  const refresh = async () => {
    await page.evaluate(async () => { await window.__ctx.saveSessionNow(); await window.__ctx.flushComposerDrafts(); });
    await page.reload({ waitUntil: 'domcontentloaded' }); await loaded(); await mode('translate');
  };
  const retry = async (id) => {
    const index = requests.length;
    await page.evaluate((id) => {
      const row = [...document.querySelectorAll('.msg')].find((node) => node.__sessionRecord?.id === id);
      [...row.querySelectorAll('.acts button')].find((button) => (button.getAttribute('aria-label') || button.textContent) === '重新翻译').click();
    }, id);
    return nextRequest(index);
  };

  await setInput('问答区已经写好的问题');
  await page.evaluate(() => window.__ctx.addToChat({ text: 'Independent chat quotation.', page: 1 }));
  const chatDraft = await draft();
  await page.waitForFunction((text) => [...document.querySelectorAll('#viewer .textLayer span')].some((node) => node.textContent === text), {}, OPENING);
  // Sidebar transitions and PDF fit-width can move the text after it first appears.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !window.__viewer.renderTasks.size);
  await wait(600);
  const openingBox = await page.evaluate((text) => {
    const node = [...document.querySelectorAll('#viewer .textLayer span')].find((element) => element.textContent === text);
    const range = document.createRange(); range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, y: (box.top + box.bottom) / 2 };
  }, OPENING);
  await page.mouse.move(openingBox.left + 0.1, openingBox.y); await page.mouse.down();
  await page.mouse.move(openingBox.right + 1, openingBox.y, { steps: 12 }); await page.mouse.up();
  await page.waitForSelector('#bubble:not(.hidden) [data-act="add-translate"]', { visible: true });
  await page.click('#bubble [data-act="add-translate"]'); await mode('translate');
  await page.waitForFunction(() => window.__state.attachments.length === 1);
  assert.equal((await draft()).attachments[0].text, OPENING);
  assert.equal((await draft()).attachments[0].page, 1);
  assert.equal(await page.$eval('#attachRow .translation-segment', (node) => node.tagName), 'DETAILS');
  assert.ok(await page.$('#attachRow .translation-segment summary'));
  assert.ok(await page.$('#attachRow .translation-segment textarea.at-edit'));
  await mode('chat'); assert.deepEqual(await draft(), chatDraft); await mode('translate');
  pass('the selection bubble adds a translation segment without changing the chat draft');

  const editedOpening = `${OPENING}\n\n${'完整保留编辑后的原文、Figure 2 引用、x_i 与否定条件。'.repeat(160)}\nEND_OF_LONG_SELECTED_PARAGRAPH`;
  const closing = 'Selected closing paragraph across pages two and three.';
  await add(closing, 2, { endPage: 3, pages: [2, 3], rectsByPage: {
    2: [{ x: 0.12, y: 0.85, w: 0.5, h: 0.05 }], 3: [{ x: 0.12, y: 0.1, w: 0.4, h: 0.04 }],
  } });
  await add('This temporary segment will be explicitly removed.', 2);
  await add(SELECTED_FOOTNOTE, 2);
  await edit(0, editedOpening);
  await control(1, '.at-up');
  assert.deepEqual((await draft()).attachments.map((item) => item.text), [closing, editedOpening, 'This temporary segment will be explicitly removed.', SELECTED_FOOTNOTE]);
  await control(3, '.at-up'); await control(2, '.at-down');
  await control(2, '.at-x');
  const supplement = 'Typed supplementary source comes after all selected paragraphs.';
  await setInput(supplement);
  const selectedDraft = await draft();
  assert.deepEqual(selectedDraft.attachments.map((item) => item.text), [closing, editedOpening, SELECTED_FOOTNOTE]);
  assert.deepEqual(selectedDraft.attachments[0].pages, [2, 3]);
  assert.equal(selectedDraft.attachments[0].endPage, 3);
  assert.match(await page.$eval('#sendBtn', (button) => button.title), /合并翻译/);
  await refresh();
  await page.waitForFunction((text) => document.querySelector('#chatInput').value === text && window.__state.attachments.length === 3, {}, supplement);
  assert.deepEqual(await draft(), selectedDraft, 'full text and all selection metadata survive refresh');
  await mode('chat'); assert.deepEqual(await draft(), chatDraft); await mode('translate');
  await page.screenshot({ path: path.join(scratch, 'segments-draft.png') });
  const side = await page.$('#rightSide'); const sideBox = await side.boundingBox();
  const splitter = await (await page.$('#splitRight')).boundingBox();
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + 100); await page.mouse.down();
  await page.mouse.move(splitter.x + splitter.width / 2 + sideBox.width - 300, splitter.y + 100, { steps: 12 }); await page.mouse.up();
  await page.click('#attachRow .translation-segment:nth-of-type(2) summary');
  await page.$eval('#attachRow .translation-segment:nth-of-type(2) .at-tools', (node) => node.scrollIntoView({ block: 'nearest' }));
  await page.click('#attachRow .translation-segment:nth-of-type(2) .at-edit');
  await page.waitForFunction(() => /合并翻译\s*3\s*段/.test(document.querySelector('#composerHint').textContent));
  const narrowLayout = await page.evaluate(() => {
    const side = document.querySelector('#rightSide').getBoundingClientRect();
    const attachmentBox = document.querySelector('#attachRow').getBoundingClientRect();
    const segment = document.querySelectorAll('#attachRow .translation-segment')[1];
    const describe = (node, clip = side) => {
      const rect = node.getBoundingClientRect();
      return { visible: rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden',
        contained: rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1,
        overflow: node.scrollWidth > node.clientWidth + 1, width: rect.width, height: rect.height, disabled: !!node.disabled };
    };
    const editor = segment.querySelector('.at-edit');
    const hint = document.querySelector('#composerHint');
    return { width: side.width, open: segment.open, hint: { ...describe(hint), text: hint.textContent },
      editor: { ...describe(editor, attachmentBox), focused: document.activeElement === editor, readOnly: editor.readOnly },
      tools: ['.at-up', '.at-down', '.at-x'].map((selector) => ({ selector, ...describe(segment.querySelector(selector), attachmentBox) })),
      send: { ...describe(document.querySelector('#sendBtn')), title: document.querySelector('#sendBtn').title } };
  });
  assert.ok(narrowLayout.width >= 295 && narrowLayout.width <= 305, JSON.stringify(narrowLayout));
  assert.ok(narrowLayout.open && narrowLayout.hint.visible && narrowLayout.hint.contained && !narrowLayout.hint.overflow, JSON.stringify(narrowLayout));
  assert.match(narrowLayout.hint.text, /合并翻译\s*3\s*段/);
  assert.ok(narrowLayout.editor.visible && narrowLayout.editor.contained && !narrowLayout.editor.disabled && !narrowLayout.editor.readOnly && narrowLayout.editor.focused, JSON.stringify(narrowLayout));
  assert.ok(narrowLayout.tools.every((tool) => tool.visible && tool.contained && !tool.disabled), JSON.stringify(narrowLayout));
  assert.ok(narrowLayout.send.visible && narrowLayout.send.contained && !narrowLayout.send.disabled && /合并翻译/.test(narrowLayout.send.title), JSON.stringify(narrowLayout));
  await side.screenshot({ path: path.join(scratch, 'segments-draft-narrow.png') });
  pass('editing, reordering and explicit removal preserve complete multi-page segments and refresh correctly', { selectedDraft, narrowLayout });

  await page.select('#translateTargetLang', '中文');
  const combined = [closing, editedOpening, SELECTED_FOOTNOTE, supplement].join('\n\n');
  const firstIndex = requests.length; const first = await send();
  assert.ok(userText(first).includes(combined), 'all segments are joined once in list order before typed source');
  assert.ok(!allText(first).includes(CAPTION) && !allText(first).includes(FOOTNOTE), 'unselected figure caption and footnote are absent');
  assert.ok(userText(first).includes(SELECTED_FOOTNOTE), 'a deliberately selected footnote is retained');
  assert.ok(first.body.messages.every((message) => typeof message.content === 'string'), 'selected text remains a text-only request');
  const translation = '这是合并后的连续译文。\n\n第二段保留完整正文与明确选中的脚注。';
  complete(first, translation); await idle(); await textVisible('这是合并后的连续译文。');
  await unchanged(firstIndex + 1, 'multiple text segments produce one model request');
  const firstRows = await records();
  const firstResult = firstRows.find((row) => row.text === translation);
  assert.ok(firstResult); assert.equal(firstRows.filter((row) => row.text === translation).length, 1);
  assert.equal(firstResult.retry.text, combined, 'retry keeps the complete combined source');
  assert.ok(firstResult.retry.segments[1].rectsByPage[1].length, 'the real PDF selection keeps a page-relative anchor after editing and reordering');
  assert.ok(firstResult.retry.segments[1].readingStart.run >= 0, 'the selection stores its reading order within the PDF page');
  await page.evaluate((id) => {
    window.__copiedTranslation = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedTranslation = text; } } });
    const row = [...document.querySelectorAll('.msg')].find((node) => node.__sessionRecord?.id === id);
    row.querySelector('.acts button[aria-label="复制译文"]').click();
  }, firstResult.id);
  assert.equal(await page.evaluate(() => window.__copiedTranslation), translation);
  pass('selected material becomes one continuous translation; unselected material stays out and copy keeps the output intact', { resultId: firstResult.id, combined });

  await refresh(); await page.select('#translateTargetLang', 'English');
  const retried = await retry(firstResult.id);
  assert.match(String(retried.body.messages[0].content), /翻译成中文/);
  assert.ok(userText(retried).includes(combined));
  complete(retried, '重新翻译仍使用原文及原目标语言。'); await idle();
  assert.equal(await page.$eval('#translateTargetLang', (select) => select.value), 'English');
  pass('retry after refresh uses the original complete source and target language');

  await clearDraft();
  const tooLongA = `START_A${'甲'.repeat(10900)}END_A`, tooLongB = `START_B${'乙'.repeat(10000)}END_B`;
  await add(tooLongA, 1); await add('Editable second source.', 2); await edit(1, tooLongB); await setInput('KEEP_TYPED_SUFFIX');
  const oversized = await draft(); const beforeOversize = requests.length;
  await page.click('#sendBtn'); await unchanged(beforeOversize, 'oversized combined source does not call the model');
  assert.deepEqual(await draft(), oversized, 'no input or selected text is silently truncated or removed');
  assert.equal(await page.evaluate(() => window.__state.busy), false);
  await clearDraft();
  pass('a combined source over 20,000 characters is rejected without truncating any draft content');

  for (const failureKind of ['failure', 'stop']) {
    const originalText = `${failureKind}: typed original source`;
    await add(`${failureKind}: first selected paragraph`, 1);
    await add(`${failureKind}: second selected paragraph`, 2);
    await setInput(originalText);
    const original = await draft();
    const request = await send(); emit(request, `${failureKind}: partial translation`);
    await textVisible(`${failureKind}: partial translation`);
    if (failureKind === 'failure') request.res.destroy(); else await page.click('#stopBtn');
    if (failureKind === 'failure') {
      // A single failed item returns automatically; only a stopped batch needs Return.
      await idle();
      await page.waitForFunction(text => document.querySelector('#chatInput').value === text, {}, originalText);
      assert.deepEqual(await draft(), original);
      await refresh();
      await page.waitForFunction(text => document.querySelector('#chatInput').value === text, {}, originalText);
      assert.deepEqual(await draft(), original);
      await clearDraft();
      pass('a single failed translation automatically restores its complete draft and survives refresh');
      continue;
    }
    await paused();
    const nextText = `${failureKind}: newly typed next source`;
    await setInput(nextText); await add(`${failureKind}: new paragraph after pause`, 3);
    const next = await draft(); const beforeReturn = requests.length;
    await page.click('#translationBatchReturn');
    await page.waitForFunction(() => !document.querySelector('#translationBatchReturn').getClientRects().length);
    const restored = await draft();
    assert.equal(restored.text, `${originalText}\n\n${nextText}`);
    assert.deepEqual(restored.attachments, [...original.attachments, ...next.attachments], 'return restores original ordered segments without changing newer material');
    await unchanged(beforeReturn, 'return-to-draft does not automatically issue a translation');
    await refresh();
    await page.waitForFunction((text) => document.querySelector('#chatInput').value === text, {}, restored.text);
    assert.deepEqual(await draft(), restored, 'returned source and metadata persist without duplication');
    await clearDraft();
    pass(`${failureKind} returns the original segments and typed source while retaining the newer draft`);
  }

  await page.select('#translateTargetLang', '中文');
  const repeat = 'Identical source deliberately selected in two different places.';
  await add(repeat, 1); await add(repeat, 2);
  const repeated = await send();
  assert.ok(userText(repeated).includes(`${repeat}\n\n${repeat}`), 'same text at different locations must not be auto-deduplicated');
  complete(repeated, '两个明确选中的重复段落均保留。'); await idle();
  pass('identical text selected at different locations is retained twice');

  const cacheA = 'CACHE_SOURCE_A: an ambiguous academic word in context A.';
  const cacheB = 'CACHE_SOURCE_B: a different source with the same translated wording.';
  const sameOutput = '两个不同原文恰好得到同一译文。';
  for (const source of [cacheA, cacheB]) {
    await clearDraft(); await setInput(source);
    const request = await send(); assert.ok(userText(request).includes(source));
    complete(request, sameOutput); await idle();
  }
  const collisionRows = (await records()).filter((row) => row.text === sameOutput);
  assert.equal(collisionRows.length, 2);
  assert.deepEqual(collisionRows.map((row) => row.retry.text).sort(), [cacheA, cacheB].sort());
  await page.evaluate(() => {
    window.__translationCacheFocus = null;
    for (const row of document.querySelectorAll('.msg')) {
      const nativeScroll = row.scrollIntoView.bind(row);
      row.scrollIntoView = (...args) => { window.__translationCacheFocus = row.__sessionRecord?.retry?.text; return nativeScroll(...args); };
    }
  });
  await setInput(cacheA); const beforeCache = requests.length; await page.click('#sendBtn'); await idle();
  await unchanged(beforeCache, 'the identical source uses its cached translation');
  assert.equal(await page.evaluate(() => window.__translationCacheFocus), cacheA, 'cache focuses the matching source rather than another row with the same translated output');
  assert.equal((await records()).filter((row) => row.text === sameOutput).length, 2);
  pass('cached results match their original source even when different sources produce identical translations');

  await mode('chat'); assert.deepEqual(await draft(), chatDraft, 'all translation operations preserve the independent question draft');
  assert.deepEqual(errors, [], 'no page errors');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, passed, evidence, assetHashes,
    exe: stagedExe ? { path: stagedExe, bytes: fs.statSync(stagedExe).size, sha256: hash(fs.readFileSync(stagedExe)) } : null,
    requests: requests.map((request) => request.body), pageErrors: errors }, null, 2), 'utf8');
  console.log(`Segmented translation: ${passed}/${passed} passed; evidence: ${scratch}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
    const state = await page.evaluate(() => ({ doc: window.__state?.doc?.name, busy: window.__state?.busy,
      input: document.querySelector('#chatInput')?.value, attachments: window.__state?.attachments,
      entries: window.__state?.sessionEntries?.map((entry) => ({ id: entry.id, status: entry.status, block: entry.block, retry: entry.retry, text: entry.text })) })).catch(() => null);
    fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ message: String(error), passed, state,
      requests: requests.map((request) => request.body) }, null, 2), 'utf8');
    console.error(`SEGMENTED_TRANSLATION_FAILURE ${scratch}`);
  }
  throw error;
} finally {
  await browser?.close(); await stopChild(reader);
  upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
}
