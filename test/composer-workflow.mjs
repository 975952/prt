/** Isolated composer/batch UI checks. node test/composer-workflow.mjs [--desktop]
 * Every model response is controlled by this test; no user data or external API is used.
 */
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
assert.ok(CHROME, 'Chrome or Edge is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `composer-workflow-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
for (const name of ['composer-a.pdf', 'composer-b.pdf']) {
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, name));
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const requests = [];
const waiters = new Map();
const messagesText = (request) => (request.body.messages || []).map((message) => typeof message.content === 'string'
  ? message.content : (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')).join('\n');
const requestImages = (request) => (request.body.messages || []).flatMap((message) => Array.isArray(message.content)
  ? message.content.filter((part) => part.type === 'image_url').map((part) => part.image_url?.url) : []);
function nextRequest(index) {
  if (requests[index]) return Promise.resolve(requests[index]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(index); reject(new Error(`Timed out waiting for request ${index + 1}; received ${requests.length}`)); }, 15000);
    waiters.set(index, (request) => { clearTimeout(timer); resolve(request); });
  });
}
function emit(request, content) {
  assert.ok(!request.res.destroyed && !request.res.writableEnded, 'mock response is still open');
  if (!request.started) {
    request.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    request.started = true;
  }
  request.res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
}
function complete(request, text) {
  emit(request, text);
  request.res.end('data: [DONE]\n\n');
}
function fail(request, text = '已收到的部分内容。') {
  emit(request, text);
  // The caller waits for the partial text before destroying the connection.
  return () => request.res.destroy();
}
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    const request = { body, res, started: false };
    requests.push(request);
    const notify = waiters.get(requests.length - 1);
    waiters.delete(requests.length - 1); notify?.(request);
  } catch { if (!res.destroyed) res.destroy(); }
});

let reader, browser, page;
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0',
    PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('composer-workflow').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await wait(100);
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ }
  }
  assert.ok(ready, 'isolated reader starts');
  for (const asset of ['app.js', 'composer-drafts.js', 'translation-queue.js']) {
    assert.equal(await fetch(`${base}/js/${asset}`).then((res) => res.text()),
      fs.readFileSync(path.join(ROOT, 'public/js', asset), 'utf8'), `reader serves the current ${asset}`);
  }
  assert.ok((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'composer-mock', apiKey: 'SYNTHETIC_COMPOSER_KEY' }) })).ok);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    userDataDir: path.join(scratch, 'browser'), defaultViewport: { width: 1400, height: 940 } });
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${base}/?open=composer-a.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.evaluate(async () => {
    const sessions = await import('/js/sessions.js');
    await sessions.sessionsOpenLatestForOutput();
    document.body.classList.remove('no-right');
    window.__ctx.setPanelVisible('chat', true); window.__ctx.applyPanels();
    window.__ctx.setAgentRead(false); window.__ctx.setScopeRange('current');
  });
  const docs = (await fetch(`${base}/api/papers`).then((res) => res.json())).papers;
  const paperA = docs.find((paper) => paper.name === 'composer-a.pdf');
  const paperB = docs.find((paper) => paper.name === 'composer-b.pdf');
  assert.ok(paperA && paperB);

  const mode = async (name) => {
    if (await page.$eval('#rightSide', (node) => node.dataset.activePanel) !== name) {
      await page.click(`#aiBar .aibar-btn[data-block="${name}"]`);
    }
    await page.waitForFunction((wanted) => document.querySelector('#rightSide')?.dataset.activePanel === wanted, {}, name);
  };
  const draft = () => page.evaluate(() => ({ text: document.querySelector('#chatInput').value,
    images: [...document.querySelectorAll('#attachRow .attach.image .at-text')].map((node) => node.textContent),
    quotes: [...document.querySelectorAll('#attachRow .attach.text .at-text')].map((node) => node.textContent) }));
  const type = async (text) => {
    await page.click('#chatInput'); await page.keyboard.down('Control'); await page.keyboard.press('KeyA');
    await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
    if (text) await page.type('#chatInput', text);
  };
  const clearDraft = async () => {
    await type('');
    while (await page.$('#attachRow .at-x')) await page.click('#attachRow .at-x');
  };
  let imageSequence = 0;
  const image = (label) => page.evaluate(({ label, sequence }) => {
    const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 32;
    const context = canvas.getContext('2d'); context.fillStyle = `hsl(${sequence * 37},70%,55%)`; context.fillRect(0, 0, 48, 32);
    context.fillStyle = '#111'; context.font = '14px sans-serif'; context.fillText(String(sequence), 3, 22);
    const dataUrl = canvas.toDataURL('image/png');
    window.__ctx.addImageToChat({ dataUrl, width: 48, height: 32, pages: 1 }, 1, label);
    return dataUrl;
  }, { label, sequence: ++imageSequence });
  const idle = () => page.waitForFunction(() => !window.__state.busy, { timeout: 15000 });
  const paused = async () => {
    await idle();
    await page.waitForFunction(() => {
      const button = document.querySelector('#translationBatchResume');
      return button && !button.disabled && button.getClientRects().length;
    }, { timeout: 15000 });
  };
  const unchangedRequests = async (count, message) => { await wait(250); assert.equal(requests.length, count, message); };
  const switchDoc = async (paper, initial = false) => {
    if (initial) await page.evaluate((doc) => window.__ctx.openDoc(doc), paper);
    else await page.click(`#tabStrip .doc-tab[data-doc="${paper.docId}"] .tab-title`);
    await page.waitForFunction((id) => window.__state.doc?.docId === id && window.__state.viewerDocId === id, { timeout: 15000 }, paper.docId);
  };
  const textVisible = (text) => page.waitForFunction((wanted) => [...document.querySelectorAll('.ai-block .text')]
    .some((node) => node.textContent.includes(wanted)), { timeout: 15000 }, text);
  const completedRecords = () => page.evaluate(() => window.__state.sessionEntries.filter((entry) => entry.block === 'translate'
    && entry.status === 'complete').map((entry) => ({ id: entry.id, text: entry.text })));
  const assertChinese = (request) => assert.match(String(request.body.messages?.[0]?.content || ''), /翻译成中文/, 'submitted target language stays Chinese');
  const send = async () => { const index = requests.length; await page.click('#sendBtn'); return nextRequest(index); };

  await type('论文 A 的问答草稿'); await image('A 问答图片');
  await mode('translate'); assert.deepEqual(await draft(), { text: '', images: [], quotes: [] });
  await type('Paper A translation draft.'); await image('A 翻译图片');
  await mode('chat'); assert.deepEqual(await draft(), { text: '论文 A 的问答草稿', images: ['A 问答图片'], quotes: [] });
  await mode('translate'); assert.deepEqual(await draft(), { text: 'Paper A translation draft.', images: ['A 翻译图片'], quotes: [] });
  await page.evaluate(() => window.__ctx.addToChat({ text: '译文中选中的句子', cleanText: '译文中选中的句子', source: 'right' }));
  await mode('chat');
  assert.deepEqual(await draft(), { text: '论文 A 的问答草稿', images: ['A 问答图片'], quotes: ['译文中选中的句子'] });
  await mode('translate'); assert.deepEqual(await draft(), { text: 'Paper A translation draft.', images: ['A 翻译图片'], quotes: [] });
  await switchDoc(paperB, true); await mode('translate'); assert.deepEqual(await draft(), { text: '', images: [], quotes: [] });
  await type('Paper B translation draft.'); await image('B 翻译图片');
  await mode('chat'); assert.deepEqual(await draft(), { text: '', images: [], quotes: [] });
  await type('论文 B 的问答草稿');
  await switchDoc(paperA); await mode('chat');
  assert.deepEqual(await draft(), { text: '论文 A 的问答草稿', images: ['A 问答图片'], quotes: ['译文中选中的句子'] });
  await mode('translate'); assert.deepEqual(await draft(), { text: 'Paper A translation draft.', images: ['A 翻译图片'], quotes: [] });
  console.log('PASS per-document text/image drafts stay separate and add-to-chat preserves translation draft');

  await clearDraft(); await type('翻译区尚未提交的文字'); await image('保留的翻译图片');
  await mode('chat'); await clearDraft(); await type('问答失败后仍应恢复的问题'); const qaImage = await image('待恢复的问答图片');
  const qa = await send(); assert.deepEqual(requestImages(qa), [qaImage]);
  await page.evaluate(() => {
    window.__composerTestQa = [...document.querySelectorAll('.ai-block[data-block="chat"] .msg')]
      .find((node) => node.__sessionRecord?.status === 'pending');
  });
  await mode('translate');
  const breakQa = fail(qa, '问答已收到的部分内容。');
  // The chat panel is parked while translation is active; the request has nevertheless started.
  await page.waitForFunction(() => window.__composerTestQa?.querySelector('.text')?.textContent.includes('问答已收到的部分内容。'));
  breakQa(); await idle();
  assert.deepEqual(await draft(), { text: '翻译区尚未提交的文字', images: ['保留的翻译图片'], quotes: [] });
  await mode('chat'); assert.deepEqual(await draft(), { text: '问答失败后仍应恢复的问题', images: ['待恢复的问答图片'], quotes: [] });
  await clearDraft();
  console.log('PASS a failed question restores its own draft while the translation panel is active');

  await mode('translate'); await clearDraft(); await page.select('#translateTargetLang', '中文');
  await type('Batch text before three images.');
  const batchImages = [await image('顺序图片一'), await image('顺序图片二'), await image('顺序图片三')];
  const start = requests.length;
  const textRequest = await send(); assert.equal(requestImages(textRequest).length, 0);
  assert.ok(messagesText(textRequest).includes('Batch text before three images.')); assertChinese(textRequest);
  complete(textRequest, '批次文字已完成。');
  const firstImage = await nextRequest(start + 1); assert.deepEqual(requestImages(firstImage), [batchImages[0]]); assertChinese(firstImage);
  complete(firstImage, '批次第一张已完成。');
  const secondImage = await nextRequest(start + 2); assert.deepEqual(requestImages(secondImage), [batchImages[1]]);
  emit(secondImage, '批次第二张部分译文。'); await textVisible('批次第二张部分译文。');
  const completedBeforeStop = await completedRecords();
  await page.select('#translateTargetLang', 'English'); await type('生成期间写下的下一条翻译草稿');
  await page.click('#stopBtn'); await paused();
  await unchangedRequests(start + 3, 'stop pauses the whole batch before the third image');
  assert.equal((await draft()).text, '生成期间写下的下一条翻译草稿');
  assert.ok(await page.$eval('#translationBatchStatus', (node) => node.textContent.trim()), 'paused batch has readable progress');

  // Exercise the normal splitter, then inspect the real task controls at a narrow reading width.
  const side = await page.$('#rightSide'); const sideBox = await side.boundingBox();
  const splitter = await (await page.$('#splitRight')).boundingBox();
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + 100); await page.mouse.down();
  await page.mouse.move(splitter.x + splitter.width / 2 + sideBox.width - 300, splitter.y + 100, { steps: 12 }); await page.mouse.up();
  const taskLayout = await page.evaluate(() => {
    const aside = document.querySelector('#rightSide').getBoundingClientRect();
    return { width: aside.width, controls: ['translationBatchStatus', 'translationBatchResume'].map((id) => {
      const node = document.getElementById(id), rect = node.getBoundingClientRect();
      return { id, visible: rect.width > 0 && rect.height > 0, contained: rect.left >= aside.left && rect.right <= aside.right + 1,
        overflow: node.scrollWidth > node.clientWidth + 1 };
    }) };
  });
  assert.ok(taskLayout.width >= 240 && taskLayout.width <= 310, JSON.stringify(taskLayout));
  assert.ok(taskLayout.controls.every((control) => control.visible && control.contained && !control.overflow), JSON.stringify(taskLayout));
  await side.screenshot({ path: path.join(scratch, 'composer-paused-narrow.png') });

  await page.$eval('#translationBatchResume', (button) => { button.click(); button.click(); });
  const resumedSecond = await nextRequest(start + 3); assert.deepEqual(requestImages(resumedSecond), [batchImages[1]]); assertChinese(resumedSecond);
  await unchangedRequests(start + 4, 'repeated resume clicks do not start duplicate work');
  complete(resumedSecond, '批次第二张已完成。');
  const thirdImage = await nextRequest(start + 4); assert.deepEqual(requestImages(thirdImage), [batchImages[2]]); assertChinese(thirdImage);
  complete(thirdImage, '批次第三张已完成。'); await idle();
  await unchangedRequests(start + 5, 'resume sends only the unfinished images');
  const completedAfterStop = await completedRecords();
  for (const entry of completedBeforeStop) assert.deepEqual(completedAfterStop.find((row) => row.id === entry.id), entry, 'successful items retain their original records');
  assert.equal((await draft()).text, '生成期间写下的下一条翻译草稿');
  assert.equal(await page.$eval('#translateTargetLang', (node) => node.value), 'English');
  console.log('PASS text/image order, whole-batch stop, fixed target language, idempotent resume and next-draft retention');

  await clearDraft(); await page.select('#translateTargetLang', '中文');
  await type('单项失败后应自动回到草稿并释放发送队列。');
  const singleFailureStart = requests.length;
  const singleFailure = await send();
  const endSingleFailure = fail(singleFailure, '单项失败的部分译文。');
  await textVisible('单项失败的部分译文。'); endSingleFailure();
  await page.waitForFunction(() => !document.querySelector('#translationBatchStatus')?.getClientRects().length);
  assert.equal((await draft()).text, '单项失败后应自动回到草稿并释放发送队列。');
  await unchangedRequests(singleFailureStart + 1, 'single failure returns to draft without an automatic retry');
  await clearDraft();
  console.log('PASS a single failed translation returns to draft and immediately releases the send queue');

  await clearDraft(); await page.select('#translateTargetLang', '中文');
  const failureImages = [await image('失败后继续第一张'), await image('失败后继续第二张')];
  const failedStart = requests.length;
  const failing = await send(); assert.deepEqual(requestImages(failing), [failureImages[0]]);
  const breakImage = fail(failing, '失败图片的部分译文。'); await textVisible('失败图片的部分译文。'); breakImage();
  await paused(); await unchangedRequests(failedStart + 1, 'a failed image pauses later images');
  await page.click('#translationBatchResume');
  const retryFailed = await nextRequest(failedStart + 1); assert.deepEqual(requestImages(retryFailed), [failureImages[0]]);
  complete(retryFailed, '失败后重试第一张完成。');
  const afterFailed = await nextRequest(failedStart + 2); assert.deepEqual(requestImages(afterFailed), [failureImages[1]]);
  complete(afterFailed, '失败后第二张完成。'); await idle();
  await unchangedRequests(failedStart + 3, 'resume retries the failed item once and then the pending item');
  console.log('PASS a failed batch pauses and resumes the failed plus pending items');

  await clearDraft(); await page.select('#translateTargetLang', '中文');
  const switchImages = [await image('切论文第一张'), await image('切论文第二张'), await image('切论文第三张')];
  const switchedStart = requests.length;
  const switchFirst = await send(); complete(switchFirst, '切论文前第一张已完成。');
  const switchSecond = await nextRequest(switchedStart + 1); assert.deepEqual(requestImages(switchSecond), [switchImages[1]]);
  emit(switchSecond, '切论文前第二张的部分内容。'); await textVisible('切论文前第二张的部分内容。');
  await switchDoc(paperB); await idle(); await mode('translate');
  assert.deepEqual(await draft(), { text: 'Paper B translation draft.', images: ['B 翻译图片'], quotes: [] });
  await unchangedRequests(switchedStart + 2, 'switching document stops the later batch items');
  await page.select('#translateTargetLang', 'English');
  await switchDoc(paperA); await mode('translate'); await paused();
  await unchangedRequests(switchedStart + 2, 'returning to the original paper does not restart automatically');
  await page.click('#translationBatchResume');
  const switchResume = await nextRequest(switchedStart + 2); assert.deepEqual(requestImages(switchResume), [switchImages[1]]); assertChinese(switchResume);
  await mode('chat'); await type('切到问答后编辑的下一条问题');
  complete(switchResume, '切论文后第二张已完成。');
  const switchLast = await nextRequest(switchedStart + 3); assert.deepEqual(requestImages(switchLast), [switchImages[2]]); assertChinese(switchLast);
  assert.equal(await page.$eval('#rightSide', (node) => node.dataset.activePanel), 'chat', 'the next image does not steal the active question panel');
  complete(switchLast, '切论文后第三张已完成。'); await idle();
  assert.equal((await draft()).text, '切到问答后编辑的下一条问题');
  await unchangedRequests(switchedStart + 4, 'document resume preserves the already successful first image');
  await mode('translate'); await textVisible('切论文后第三张已完成。');
  const finalRows = await completedRecords();
  assert.equal(finalRows.filter((entry) => entry.text === '切论文前第一张已完成。').length, 1);
  assert.equal(finalRows.filter((entry) => entry.text === '切论文后第二张已完成。').length, 1, 'resumed result belongs to the live session records');
  assert.equal(finalRows.filter((entry) => entry.text === '切论文后第三张已完成。').length, 1);
  await side.screenshot({ path: path.join(scratch, 'composer-complete-narrow.png') });
  console.log('PASS document switching pauses its batch, resume uses the original source, and background results preserve the active draft');

  await clearDraft(); await type('Completed source text must not return to the draft.');
  const returnImages = [await image('放回前已完成的图片'), await image('应放回的未完成图片')];
  const returnStart = requests.length;
  const returnText = await send(); complete(returnText, '放回测试的文字已完成。');
  const returnFirst = await nextRequest(returnStart + 1); assert.deepEqual(requestImages(returnFirst), [returnImages[0]]);
  complete(returnFirst, '放回测试的第一张已完成。');
  const returnSecond = await nextRequest(returnStart + 2); assert.deepEqual(requestImages(returnSecond), [returnImages[1]]);
  emit(returnSecond, '放回前未完成的译文。'); await textVisible('放回前未完成的译文。');
  await type('暂停前新写的下一条内容'); await page.click('#stopBtn'); await paused();
  const nextDraftImage = await image('下一条的新图片');
  await page.click('#translationBatchReturn');
  await page.waitForFunction(() => !document.querySelector('#translationBatchStatus')?.getClientRects().length);
  assert.deepEqual(await draft(), { text: '暂停前新写的下一条内容', images: ['应放回的未完成图片', '下一条的新图片'], quotes: [] });
  await unchangedRequests(returnStart + 3, 'returning a stopped queue does not send or regenerate anything');
  const returnedComplete = await completedRecords();
  assert.equal(returnedComplete.filter((entry) => entry.text === '放回测试的第一张已完成。').length, 1);
  console.log('PASS return-to-draft keeps only unfinished images and preserves newly typed text/images');

  const previousSid = await page.evaluate(() => window.__ctx.activeSession);
  await mode('chat'); await page.click('#sessNew');
  await page.waitForFunction((old) => window.__ctx.activeSession !== old, {}, previousSid);
  await mode('translate');
  assert.deepEqual(await draft(), { text: '暂停前新写的下一条内容', images: ['应放回的未完成图片', '下一条的新图片'], quotes: [] });
  const returnedStart = requests.length;
  const returnedTextRequest = await send(); complete(returnedTextRequest, '新会话重新提交的文字。');
  const returnedImageRequest = await nextRequest(returnedStart + 1); assert.deepEqual(requestImages(returnedImageRequest), [returnImages[1]]);
  complete(returnedImageRequest, '新会话重新提交的旧截图。');
  const nextDraftRequest = await nextRequest(returnedStart + 2); assert.deepEqual(requestImages(nextDraftRequest), [nextDraftImage]);
  complete(nextDraftRequest, '新会话重新提交的新截图。'); await idle();
  const returnedRefs = await page.evaluate(() => ({ sid: window.__ctx.activeSession,
    entries: window.__state.sessionEntries.filter((entry) => entry.block === 'translate' && entry.status === 'complete'
      && ['新会话重新提交的旧截图。', '新会话重新提交的新截图。'].includes(entry.text))
      .map((entry) => ({ text: entry.text, shots: entry.shots, retry: entry.retry })) }));
  assert.equal(returnedRefs.entries.length, 2);
  for (const entry of returnedRefs.entries) {
    assert.equal(entry.retry.sid, returnedRefs.sid, 'returned image is owned by the new session');
    assert.equal(entry.shots.length, 1, 'completed screenshot retains a persisted thumbnail reference');
    assert.equal(entry.shots[0].id, entry.retry.refId, 'thumbnail and retry refer to the same saved image');
    const response = await fetch(`${base}/api/attachment?doc=${encodeURIComponent(paperA.docId)}&sid=${encodeURIComponent(returnedRefs.sid)}&id=${entry.retry.refId}`);
    assert.ok(response.ok, 'returned image can be read from its new session');
    const expected = entry.text.includes('旧截图') ? returnImages[1] : nextDraftImage;
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(expected.split(',')[1], 'base64'));
  }
  console.log('PASS returned images can be sent in a new session and retain readable thumbnail/retry references');

  // A saved conversation makes choose-on-entry wait for new-session preparation.
  // Hold that real API request while the user changes panels and drafts.
  await page.evaluate(async () => {
    await window.__ctx.saveSessionNow();
    await window.__ctx.flushComposerDrafts();
    const sessions = await import('/js/sessions.js'); sessions.sessionsSetEnterMode('choose');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx && window.__state.viewerDocId === window.__state.doc?.docId);
  await mode('translate');
  await page.waitForFunction(() => [...document.querySelectorAll('.ai-block[data-block="translate"] .msg')]
    .some((node) => node.__sessionRecord?.text === '新会话重新提交的旧截图。'));
  const restoredImages = await page.evaluate(() => [...document.querySelectorAll('.ai-block[data-block="translate"] .msg')]
    .filter((node) => ['切论文后第二张已完成。', '新会话重新提交的旧截图。'].includes(node.__sessionRecord?.text))
    .map((node) => ({ text: node.__sessionRecord.text, status: node.__sessionRecord.status,
      sid: node.__sessionRecord.retry?.sid, shots: node.__sessionRecord.shots,
      image: node.querySelector('.shots img')?.src, complete: node.querySelector('.shots img')?.complete,
      imageWidth: node.querySelector('.shots img')?.naturalWidth })));
  const oldSessionImage = restoredImages.find((entry) => entry.text === '切论文后第二张已完成。');
  const newSessionImage = restoredImages.find((entry) => entry.text === '新会话重新提交的旧截图。');
  assert.ok(oldSessionImage && newSessionImage, 'both old- and new-session translated images are restored');
  assert.equal(oldSessionImage.status, 'complete', 'resumed second item remains complete after save/reload');
  assert.equal(oldSessionImage.sid, previousSid); assert.equal(oldSessionImage.image, switchImages[1]);
  assert.equal(newSessionImage.status, 'complete'); assert.equal(newSessionImage.sid, returnedRefs.sid);
  assert.equal(newSessionImage.image, returnImages[1]);
  assert.ok(restoredImages.every((entry) => entry.complete && entry.imageWidth === 48 && entry.shots.length === 1),
    'old and new session thumbnail bytes really decode, without missing-image placeholders');
  console.log('PASS saved resumed results stay complete and old/new-session thumbnails restore after reload');
  await mode('chat');
  await page.waitForFunction(async () => (await import('/js/sessions.js')).sessionsIsEntryMode());
  await page.evaluate(() => { window.__ctx.setAgentRead(false); window.__ctx.setScopeRange('current'); });
  await mode('translate'); await type('会话准备前的译文草稿'); await image('准备期间保留的翻译图片');
  await mode('chat'); await type('会话准备前提交的问答'); await image('准备期间保留的问答图片');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const held = [];
  let holding = true, notifyHeld;
  const heldReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('New-session preparation did not request its session list')), 15000);
    notifyHeld = () => { clearTimeout(timer); resolve(); };
  });
  const intercept = (request) => {
    if (holding && /\/api\/sessions\?/.test(request.url()) && request.method() === 'GET') {
      held.push(request); notifyHeld(); return;
    }
    request.continue().catch(() => {});
  };
  await page.setRequestInterception(true); page.on('request', intercept);
  const beforePreparing = requests.length;
  await page.click('#sendBtn'); await heldReady;
  await page.click('#sendBtn');
  await mode('translate'); await type('准备期间修改后的译文草稿');
  assert.equal(held.length, 1, 'repeated send does not prepare multiple new sessions');
  holding = false;
  const preparationDone = page.waitForResponse((response) => /\/api\/sessions\?/.test(response.url())
    && response.request().method() === 'GET' && response.ok(), { timeout: 15000 });
  await Promise.all(held.map((request) => request.continue()));
  await preparationDone;
  await unchangedRequests(beforePreparing, 'a changed composer is never sent after asynchronous session preparation');
  assert.deepEqual(await draft(), { text: '准备期间修改后的译文草稿', images: ['准备期间保留的翻译图片'], quotes: [] });
  await mode('chat'); assert.deepEqual(await draft(), { text: '会话准备前提交的问答', images: ['准备期间保留的问答图片'], quotes: [] });
  page.off('request', intercept); await page.setRequestInterception(false);
  console.log('PASS switching drafts during session preparation prevents stale sends and repeated preparation');
  assert.deepEqual(errors, []);
  console.log(`PASS ${desktop ? 'desktop' : 'Node'} composer workflow: ${scratch}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(scratch, 'composer-failure.png') }).catch(() => {});
    const snapshot = await page.evaluate(() => ({ active: document.querySelector('#rightSide')?.dataset.activePanel,
      doc: window.__state?.doc?.name, busy: window.__state?.busy, input: document.querySelector('#chatInput')?.value,
      attachments: [...document.querySelectorAll('#attachRow .at-text')].map((node) => node.textContent),
      batch: document.querySelector('#translationBatchStatus')?.textContent,
      entries: window.__state?.sessionEntries?.map((entry) => ({ block: entry.block, status: entry.status, text: entry.text, quote: entry.quote })) })).catch(() => null);
    console.error(JSON.stringify({ scratch, requests: requests.length, snapshot }, null, 2));
  }
  throw error;
} finally {
  await browser?.close();
  await stopChild(reader);
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
