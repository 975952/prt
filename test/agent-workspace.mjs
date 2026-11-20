/** Global assistant workspace and reader handoffs against real isolated storage.
 * node test/agent-workspace.mjs [--desktop]
 * Synthetic PDFs and a local model only; never reads the user's data or papers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';

const desktop = process.argv.includes('--desktop');
const moveReview = process.argv.includes('--move-review');
const landingReview = process.argv.includes('--landing-review');
const sourcesReview = process.argv.includes('--sources-review');
const historyDeletionReview = process.argv.includes('--history-deletion');
const includeHistoryDeletion = historyDeletionReview || !(sourcesReview || moveReview || landingReview);
const previouslyDeletedSid = 'previouslydeletedsid';
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find(file => file && fs.existsSync(file));
assert.ok(executablePath, 'a Chromium browser is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `agent-workspace-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data'));
const papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const fixturePaths = ['vision/alpha.pdf', 'vision/beta.pdf', 'math/gamma.pdf', 'math/unavailable.pdf'];
for (const relative of fixturePaths) {
  fs.mkdirSync(path.dirname(path.join(papersDir, relative)), { recursive: true });
  writeTitlePdf(path.join(papersDir, relative), { title: `Synthetic ${path.basename(relative, '.pdf')} research` });
}
if (includeHistoryDeletion) {
  // Exact storage left by the old version after deleting from Alina: its
  // global file is gone, the old per-file marker and the folder copy remain.
  const marker = 'deleted-session-default-9ce67dce-' + previouslyDeletedSid + '.json';
  const survivor = 'session-' + folderScope('vision') + '-' + previouslyDeletedSid + '.json';
  fs.writeFileSync(path.join(dataDir, marker), JSON.stringify({ v: 1, deletedAt: Date.now() }));
  fs.writeFileSync(path.join(dataDir, survivor), JSON.stringify({ title: 'Previous deletion', entries: [
    { id: 'old-question', block: 'chat', kind: 'user', text: 'A previously deleted question' },
  ] }));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const checks = [], errors = [], apiRequests = [], modelRequests = [], dialogs = [], animationChecks = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const check = (label, condition) => { assert.ok(condition, label); pass(label); };
let reader, browser, page, base;
let failPdf = '', failedReads = 0;
let failMove = false, failedMoves = 0;
let delayMove = false, delayedMove = null, rejectReviewRetry = false, holdReviewRetry = false;
let holdGeneric = false, heldGeneric = null;
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    modelRequests.push(body);
    const source = JSON.stringify(body.messages?.at(-1)?.content || '');
    if (source.includes('REVIEW_RETRY_SOURCE') && rejectReviewRetry) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"Synthetic retry source failure"}}'); return;
    }
    if (source.includes('REVIEW_RETRY_SOURCE') && holdReviewRetry) { holdReviewRetry = false; heldGeneric = res; return; }
    if (holdGeneric && source.includes('FULL_GENERIC_QUESTION')) { holdGeneric = false; heldGeneric = res; return; }
    const answer = source.includes('AFTER_PDF_FAILURE_QUESTION') ? 'SYNTHETIC_RECOVERY_REPLY'
      : source.includes('FIRST_NAME_DISMISS_QUESTION') ? 'SYNTHETIC_NAME_DISMISS_REPLY'
      : source.includes('LOCAL_NEW_QUESTION') ? 'SYNTHETIC_LOCAL_REPLY'
      : source.includes('HANDOFF_AUTOCONTINUE_QUESTION') ? 'SYNTHETIC_HANDOFF_REPLY'
        : 'SYNTHETIC_GLOBAL_REPLY: The isolated assistant retained this discussion.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});

async function json(route, body, method = 'POST') {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return response.json();
}
const sessionUrl = (scope, sid) => `/api/session?${new URLSearchParams({ doc: scope, sid })}`;
function folderScope(folder) {
  let hash = 0x811c9dc5;
  for (const character of `/${folder}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return `folder-${hash.toString(16).padStart(8, '0')}`;
}
async function seed(scope, sid, title, marker, paper = null) {
  const stamp = Date.now();
  await json(sessionUrl(scope, sid), {
    title, titleSource: 'user', createdAt: stamp, updatedAt: stamp,
    folderPath: paper?.folder || '', docIds: paper ? [paper.docId] : [],
    entries: [
      { id: `${sid}-question`, block: 'chat', kind: 'user', tag: '提问', text: `Question ${marker}`,
        status: 'user', docId: paper?.docId || '', docTitle: paper?.name || '' },
      { id: `${sid}-answer`, block: 'chat', kind: 'assistant', tag: '问答', text: marker,
        status: 'complete', docId: paper?.docId || '', docTitle: paper?.name || '' },
    ],
    history: [{ role: 'user', content: `Question ${marker}` }, { role: 'assistant', content: marker }], ops: [],
  });
}
async function newPage(mode, locale = 'en') {
  const context = await browser.createBrowserContext();
  const tab = await context.newPage();
  page = tab;
  await tab.setViewport({ width: 1400, height: 940 });
  await tab.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  tab.setDefaultTimeout(20000);
  tab.on('pageerror', error => errors.push(String(error)));
  tab.on('dialog', dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); void dialog.accept(); });
  tab.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base && url.pathname.startsWith('/api/')) apiRequests.push({ method: request.method(), path: url.pathname, query: url.search });
  });
  await tab.setRequestInterception(true);
  tab.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base && ['/api/web-search', '/api/ref-search'].includes(url.pathname)) {
      return request.respond({ status: 200, contentType: 'application/json', body: '{"results":[]}' });
    }
    if (url.origin === base && url.pathname === '/api/sessions/move' && failMove) {
      failMove = false; failedMoves++;
      return request.respond({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Synthetic move unavailable"}}' });
    }
    if (url.origin === base && url.pathname === '/api/sessions/move' && delayMove) {
      delayMove = false;
      void (async () => {
        const response = await fetch(request.url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.postData() });
        delayedMove = { request, status: response.status, body: await response.text() };
      })();
      return;
    }
    if (url.origin === base && url.pathname === '/api/pdf'
      && failPdf && (url.searchParams.get('name') || url.searchParams.get('path')) === failPdf) {
      failedReads++;
      return request.respond({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic PDF unavailable"}' });
    }
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) {
      errors.push(`Unexpected browser network access: ${url.origin}${url.pathname}`);
      return request.abort();
    }
    return request.continue();
  });
  await tab.evaluateOnNewDocument(({ mode, locale }) => {
    if (!localStorage.getItem('agent-workspace-test-initialized')) {
      localStorage.setItem('reader.locale', locale);
      localStorage.setItem('reader.session.scopeMode', mode);
      localStorage.setItem('reader.session.onEnter', 'choose');
      localStorage.setItem('reader.session.aiTitle', '0');
      localStorage.setItem('reader.agentRead', '0');
      localStorage.setItem('agent-workspace-test-initialized', '1');
    }
  }, { mode, locale });
  await tab.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await tab.waitForFunction(() => !!window.__ctx && window.__state?.papers.length === 4);
  await tab.evaluate(() => window.__ctx.setScopeRange('current'));
  return tab;
}
const visible = selector => page.$eval(selector, node => !!node.getClientRects().length);
const sid = () => page.evaluate(() => window.__ctx.activeSession);
const scope = () => page.evaluate(() => window.__ctx.agentWorkspaceState().scope);
const draft = () => page.$eval('#chatInput', input => input.value);
const chatText = () => page.$eval('#aiArea', node => node.textContent);
const settled = () => page.waitForFunction(() => document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true');
async function typeDraft(value) {
  await page.$eval('#chatInput', (input, value) => {
    input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.evaluate(() => window.__ctx.flushComposerDrafts());
}
async function full({ landing = false } = {}) {
  if (await page.evaluate(() => document.body.classList.contains('agent-full'))) {
    await page.click('#homeBtn');
    await page.waitForSelector('#home', { visible: true });
    await page.click('#homeAgent');
  } else await page.click(await visible('#homeAgent') ? '#homeAgent' : '#agentBtn');
  await page.waitForSelector('body.agent-full #rightSide', { visible: true });
  await settled();
  if (landing && !await visible('#agentLanding')) {
    await page.click('#agentNavNew'); await settled();
  }
  if (!landing && await visible('#agentLanding') && !await page.$eval('#agentResume', button => button.disabled)) {
    await page.click('#agentResume'); await settled();
  }
  // A restored conversation keeps the same input card and animates it into its
  // footer. Wait for that visible transition before clicking content behind it.
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.all(document.querySelector('#composer').getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}
async function history() {
  if (!await visible('#sessHistory')) await page.click(await visible('#agentHistory') ? '#agentHistory' : '#sessHist');
  await page.waitForSelector('#sessHistory .sess-hrow', { visible: true });
}
async function openSessionMove(sourceSid) {
  if (!sourceSid && await visible('#agentChatMove')) {
    await page.click('#agentChatMove');
  } else {
    const id = sourceSid || await sid();
    await history();
    await page.locator(`#sessHistory .sess-hrow[data-sid=${JSON.stringify(id)}] .sess-hmore`).click();
    await page.locator('.sess-row-menu .sess-hact.move').click();
  }
}
async function chooseGlobal() {
  await history();
  await page.click('#sessHistory .sess-hrow[data-sid="global-primary"] .sess-hgo');
  await page.waitForFunction(() => window.__ctx.activeSession === 'global-primary'
    && document.querySelector('#aiArea').textContent.includes('GLOBAL_PRIMARY_ONLY'));
}
async function reviewHistoryDeletion(paper) {
  const owners = ['default', paper.docId, folderScope(paper.folder)];
  const removed = ['historyactive', 'historyinactive'];
  const retained = 'independenthistory';
  const title = 'Two discussions with the same title';
  // Changing the scope setting copies the conversation and its SID. Alina
  // shows its global owner while the reader's history spans all owners.
  for (const id of removed) {
    for (const owner of owners) await seed(owner, id, title, id, paper);
  }
  await seed(paper.docId, retained, title, 'INDEPENDENT_HISTORY', paper);
  const row = id => `#sessHistory .sess-hrow[data-sid=${JSON.stringify(id)}]`;
  page = await newPage('paper');
  await full({ landing: true }); await history();
  await page.locator(row(removed[0]) + ' .sess-hgo').click();
  await page.waitForFunction(id => __ctx.activeSession === id && !document.querySelector('#sessHistory').getClientRects().length, {}, removed[0]);
  for (const id of [...removed].reverse()) {
    await history();
    await page.locator(row(id) + ' .sess-hmore').click();
    await page.locator('#sessRowMenu .danger').click();
    await page.locator('.sess-confirm-mask:not(.hidden) .sess-confirm-btn.danger').click();
    await page.waitForFunction(id => !document.querySelector(`#sessHistory .sess-hrow[data-sid="${id}"]`), {}, id);
  }
  check('Alina history removes both the open conversation and a different selected row',
    (await Promise.all(removed.map(id => json(sessionUrl('default', id))))).every(session => session.deleted));
  for (const cold of [false, true]) {
    if (cold) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__ctx && __state.papers.length === 4);
    }
    if (!await visible('#home')) await page.locator('#homeBtn').click();
    await page.locator(`#homeList .home-item[data-id=${JSON.stringify(paper.docId)}] .home-item-go`).click();
    await page.waitForFunction(id => window.__state.viewerDocId === id && document.body.classList.contains('reading'), {}, paper.docId);
    await history();
    await page.waitForSelector(row(retained), { visible: true });
    const ids = await page.$$eval('#sessHistory .sess-hrow', nodes => nodes.map(node => node.dataset.sid));
    check(`reader history keeps the independent same-title chat and omits both deleted conversations ${cold ? 'after reload' : 'on return'}`,
      ids.includes(retained) && removed.every(id => !ids.includes(id)));
    check(`the reader also omits the copy left by an earlier Alina deletion ${cold ? 'after reload' : 'on return'}`,
      !ids.includes(previouslyDeletedSid));
  }
  for (const id of removed) {
    for (const owner of owners) assert.equal((await json(sessionUrl(owner, id))).deleted, true, `deleted ${owner}/${id}`);
  }
  check('deletion reaches every historical owner and preserves the unrelated conversation on disk',
    (await json(sessionUrl(paper.docId, retained))).entries.some(entry => entry.text === 'INDEPENDENT_HISTORY'));
}
async function reviewSources(paperA, paperB) {
  const url = sessionUrl('default', 'global-primary');
  const saved = await json(url);
  saved.entries[1].docId = paperA.docId;
  saved.entries[1].docTitle = paperA.name;
  saved.entries[1].docPath = paperA.path;
  saved.entries[1].text += ' 〔p.1〕 〔《vision/alpha.pdf》p.1〕 〔《vision/beta.pdf》p.1‖Synthetic beta research〕';
  saved.entries.push({ ...saved.entries[1], id: 'no-citations', text: 'A later uncited answer.' });
  await json(url, saved);
  page = await newPage('paper'); await full(); await chooseGlobal();
  await page.waitForSelector('#agentSources .agent-sources-empty', { visible: true });
  const welcomeSkip = await page.$('#agentWelcomeSkip');
  if (welcomeSkip) await welcomeSkip.click();
  check('most recent uncited answer has an empty source panel', !await page.$('#agentSources .agent-source-paper'));
  await page.click('#aiArea .msg.assistant .agent-answer-sources');
  await page.waitForFunction(() => document.querySelectorAll('#agentSources .agent-source-paper').length === 2);
  assert.deepEqual(await page.$$eval('#agentSources .agent-source-page strong', nodes => nodes.map(node => node.textContent)), ['p.1', 'p.1']);
  pass('source rail merges duplicate citations to the same paper and preserves equal page numbers across papers');
  await page.screenshot({ path: path.join(scratch, 'sources-wide.png') });
  await page.setViewport({ width: 850, height: 800 });
  await page.waitForSelector('#agentSources', { hidden: true });
  await page.click('#agentSourcesToggle');
  await page.waitForSelector('#agentSources', { visible: true });
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#agentSourcesToggle', el => el === document.activeElement && el.getAttribute('aria-expanded') === 'false'), true);
  await page.click('#agentSourcesToggle');
  await page.click('#agentSourceList .agent-source-paper:nth-child(2) .agent-source-page');
  await page.waitForFunction(doc => document.body.classList.contains('agent-docked') && window.__state.viewerDocId === doc, {}, paperB.docId);
  await page.waitForFunction(() => window.__viewer.rendered.get(1)?.quoteLayer?.firstElementChild);
  check('source opens the correct PDF in the reader, retaining the global conversation', await sid() === 'global-primary'
    && !await visible('#agentSources') && (await chatText()).includes('GLOBAL_PRIMARY_ONLY'));
  await page.setViewport({ width: 1400, height: 900 });
  await full(); await history();
  await page.click('#sessHistory .sess-hrow[data-sid="global-secondary"] .sess-hgo');
  await page.waitForFunction(() => window.__ctx.activeSession === 'global-secondary'
    && document.querySelector('#aiArea').textContent.includes('GLOBAL_SECONDARY_ONLY') && !document.querySelector('#sessHistory').getClientRects().length);
  await settled();
  await page.waitForSelector('#agentSources .agent-sources-empty', { visible: true });
  check('switching conversations clears the previous answer citations', !await page.$('#agentSources .agent-source-page'));
  await typeDraft('FIRST_NAME_DISMISS_QUESTION'); await page.focus('#chatInput'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#aiArea').textContent.includes('SYNTHETIC_NAME_DISMISS_REPLY') && !window.__state.busy);
  check('finished uncited streaming answer leaves the rail empty', await visible('#agentSources .agent-sources-empty'));
}
async function pick(paper) {
  await page.click('#agentPapersToggle');
  await page.waitForSelector('#agentPaperPicker', { visible: true });
  const selector = `.agent-paper-row[data-agent-paper=${JSON.stringify(paper.path || paper.docId)}]`;
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector);
}
async function handoff(paper) {
  await pick(paper);
  await page.waitForFunction(id => window.__viewer?.pdf && window.__state.viewerDocId === id
    && document.body.classList.contains('agent-docked'), {}, paper.docId);
  await page.waitForSelector('#agentHandoff', { visible: true });
  await page.waitForFunction(() => !document.querySelector('#agentContinue').disabled);
}
async function chooseLocal(expectedSid, marker) {
  if (await sid() !== expectedSid) {
    await page.waitForSelector('#sessEntryCard .entry-primary', { visible: true });
    await page.click('#sessEntryCard .entry-primary');
  }
  await page.waitForFunction(({ expectedSid, marker }) => window.__ctx.activeSession === expectedSid
    && document.querySelector('#aiArea').textContent.includes(marker), {}, { expectedSid, marker });
  await settled();
}
async function layout(label) {
  const result = await page.evaluate(() => {
    const panel = document.querySelector('#rightSide').getBoundingClientRect();
    const input = document.querySelector('#chatInput').getBoundingClientRect();
    const send = document.querySelector('#sendBtn').getBoundingClientRect();
    const composer = document.querySelector('#composer');
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      panel: { left: panel.left, right: panel.right, width: panel.width },
      input: { left: input.left, right: input.right, width: input.width },
      send: { left: send.left, right: send.right, width: send.width },
      composerWidth: composer.clientWidth, composerScrollWidth: composer.scrollWidth };
  });
  assert.ok(result.documentWidth <= result.viewport + 1, `${label}: root overflow ${JSON.stringify(result)}`);
  assert.ok(result.panel.left >= -1 && result.panel.right <= result.viewport + 1 && result.panel.width >= 250,
    `${label}: panel stays usable ${JSON.stringify(result)}`);
  assert.ok(result.input.width > 80 && result.input.left >= result.panel.left - 1 && result.input.right <= result.panel.right + 1,
    `${label}: input stays inside panel ${JSON.stringify(result)}`);
  assert.ok(result.send.width > 0 && result.send.right <= result.panel.right + 1
    && result.composerScrollWidth <= result.composerWidth + 1, `${label}: composer controls fit ${JSON.stringify(result)}`);
  pass(label);
}

async function reviewMoveCases({ paperA, paperB }) {
  await seed('default', 'reviewglobal', 'Review global source', 'REVIEW_GLOBAL_SOURCE');
  await seed(paperA.docId, 'reviewa', 'Review paper A existing', 'REVIEW_A_EXISTING', paperA);
  await seed(paperB.docId, 'reviewb', 'Review paper B existing', 'REVIEW_B_EXISTING', paperB);
  const pngUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
  const choose = async currentSid => {
    await history();
    await page.waitForSelector(`#sessHistory .sess-hrow[data-sid=${JSON.stringify(currentSid)}] .sess-hgo`, { visible: true });
    await page.locator(`#sessHistory .sess-hrow[data-sid=${JSON.stringify(currentSid)}] .sess-hgo`).click();
    await page.waitForFunction(currentSid => window.__ctx.activeSession === currentSid, {}, currentSid);
    await settled();
  };
  const openMove = async (targetPaper, sourceSid = '') => {
    await openSessionMove(sourceSid);
    await page.waitForSelector('#sessMovePanel', { visible: true });
    await page.waitForFunction(() => !document.querySelector('#sessMoveMode').disabled);
    await page.select('#sessMoveMode', 'paper'); await page.select('#sessMoveTarget', targetPaper.docId);
    await page.waitForFunction(() => !document.querySelector('#sessMoveSubmit').disabled);
  };
  const finishMove = async (oldSid, targetPaper) => {
    await page.waitForFunction(({ oldSid, docId }) => window.__ctx.activeSession !== oldSid
      && window.__ctx.agentWorkspaceState().scope === docId && !document.querySelector('#sessMoveLayer').getClientRects().length,
    {}, { oldSid, docId: targetPaper.docId });
    await settled();
    await page.waitForFunction(() => !document.querySelector('#sendBtn').disabled);
    return sid();
  };
  const releaseModel = async answer => {
    for (let attempt = 0; attempt < 200 && !heldGeneric; attempt++) await wait(25);
    assert.ok(heldGeneric, 'held synthetic model request exists');
    heldGeneric.writeHead(200, { 'Content-Type': 'text/event-stream' });
    heldGeneric.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
    heldGeneric = null;
  };
  const draftState = () => page.evaluate(() => ({ text: document.querySelector('#chatInput').value,
    images: window.__state.attachments.filter(item => item.kind === 'image').map(item => item.dataUrl) }));
  page = await newPage('paper'); await full(); await choose('reviewglobal');
  await handoff(paperA); await page.click('#agentRestore'); await chooseLocal('reviewa', 'REVIEW_A_EXISTING');
  await typeDraft('EXISTING_TARGET_A_DRAFT'); await full();
  await handoff(paperB); await page.click('#agentRestore'); await chooseLocal('reviewb', 'REVIEW_B_EXISTING');
  await typeDraft('EXISTING_TARGET_B_DRAFT'); await full(); await choose('reviewglobal');
  await typeDraft('DRAFT_BEFORE_HTTP_MOVE');
  await page.evaluate(pngUrl => window.__ctx.addImageToChat({ dataUrl: pngUrl, width: 1, height: 1 }, 1, 'Move review image'), pngUrl);
  await page.evaluate(() => window.__ctx.flushComposerDrafts());
  await openMove(paperB); delayMove = true; await page.click('#sessMoveSubmit');
  for (let attempt = 0; attempt < 200 && !delayedMove; attempt++) await wait(25);
  assert.ok(delayedMove, 'real move completed on server while response is delayed');
  assert.equal(delayedMove.status, 200, delayedMove.body);
  check('move review commits the real backend before the delayed browser response',
    (await json(sessionUrl('default', 'reviewglobal'))).deleted && await scope() === 'default');
  await typeDraft('LATEST_DRAFT_TYPED_DURING_MOVE_RESPONSE');
  const modelCount = modelRequests.length;
  await page.evaluate(() => window.__ctx.send());
  await page.click('#sendBtn');
  check('a delayed ownership move disables sending and rejects the direct send path',
    await page.$eval('#sendBtn', button => button.disabled) && modelRequests.length === modelCount);
  await delayedMove.request.respond({ status: delayedMove.status, contentType: 'application/json', body: delayedMove.body }); delayedMove = null;
  const firstMovedSid = await finishMove('reviewglobal', paperB);
  assert.deepEqual(await draftState(), { text: 'LATEST_DRAFT_TYPED_DURING_MOVE_RESPONSE', images: [pngUrl] });
  pass('the committed move uses the latest text typed during its HTTP response delay');
  await choose('reviewb');
  assert.equal(await draft(), 'EXISTING_TARGET_B_DRAFT');
  await choose(firstMovedSid);
  await page.evaluate(() => {
    const nativeSetItem = Storage.prototype.setItem;
    window.__moveStorageFailures = [];
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && ['reader.session.draftOwners.v1', 'reader.activeSession'].includes(key)) {
        window.__moveStorageFailures.push(key); throw new DOMException('Synthetic storage quota failure', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };
    window.__restoreMoveStorage = () => { Storage.prototype.setItem = nativeSetItem; };
  });
  await openMove(paperA); await page.click('#sessMoveSubmit');
  const storageFallbackSid = await finishMove(firstMovedSid, paperA);
  assert.deepEqual(await draftState(), { text: 'LATEST_DRAFT_TYPED_DURING_MOVE_RESPONSE', images: [pngUrl] });
  assert.deepEqual(await page.evaluate(() => [...new Set(window.__moveStorageFailures)].sort()),
    ['reader.activeSession', 'reader.session.draftOwners.v1']);
  await page.evaluate(async () => { await window.__ctx.flushComposerDrafts(); await window.__ctx.saveSessionNow(); });
  const fallbackSession = await json(sessionUrl(paperA.docId, storageFallbackSid));
  assert.equal(fallbackSession.entries.length, 2); assert.ok(fallbackSession.draftOwner.docId.startsWith('session:'));
  pass('committed moves retain the new session and independent draft when localStorage pointer writes fail');
  await choose('reviewa'); assert.equal(await draft(), 'EXISTING_TARGET_A_DRAFT');
  await choose(storageFallbackSid);
  assert.deepEqual(await draftState(), { text: 'LATEST_DRAFT_TYPED_DURING_MOVE_RESPONSE', images: [pngUrl] });
  pass('in-memory ownership fallback preserves the target old draft and restores the moved draft separately');
  await page.evaluate(() => window.__restoreMoveStorage());

  rejectReviewRetry = true;
  await typeDraft('REVIEW_RETRY_SOURCE: explain this synthetic screenshot.'); await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy && window.__state.sessionEntries.some(entry => entry.status === 'failed'));
  await page.evaluate(() => window.__ctx.saveSessionNow());
  const failed = await page.evaluate(() => window.__state.sessionEntries.find(entry => entry.status === 'failed'));
  assert.equal(failed.retry.docId, paperA.docId); assert.ok(failed.retry.attachments.some(item => item.kind === 'image'));
  await openMove(paperB); await page.click('#sessMoveSubmit');
  const retryMovedSid = await finishMove(storageFallbackSid, paperB);
  rejectReviewRetry = false; holdReviewRetry = true;
  await page.evaluate(id => {
    const row = [...document.querySelectorAll('.msg.assistant')].find(node => node.__sessionRecord?.id === id);
    if (!row?.querySelector('.acts button')) throw new Error('Missing real retry button');
    row.querySelector('.acts button').click();
  }, failed.id);
  for (let attempt = 0; attempt < 200 && !heldGeneric; attempt++) await wait(25);
  assert.ok(heldGeneric, 'retry starts from the new paper without reopening its old source');
  const retryContext = await page.evaluate(() => {
    const job = [...window.__ctx.chatJobs.values()].find(job => job.pending?.question.includes('REVIEW_RETRY_SOURCE'));
    return { sourceDoc: job?.pending.docId, jobScope: job?.scope, sid: job?.sid, visibleDoc: window.__state.viewerDocId,
      images: job?.pending.attachments.filter(item => item.kind === 'image').map(item => item.dataUrl) };
  });
  assert.deepEqual(retryContext, { sourceDoc: paperA.docId, jobScope: paperB.docId, sid: retryMovedSid, visibleDoc: paperB.docId, images: [pngUrl] });
  const retryImages = modelRequests.at(-1).messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url?.url) : []);
  assert.ok(retryImages.includes(pngUrl));
  await releaseModel('SYNTHETIC_MOVED_RETRY_REPLY');
  await page.waitForFunction(() => !window.__state.busy && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_MOVED_RETRY_REPLY'));
  await page.evaluate(() => window.__ctx.saveSessionNow());
  const retried = await json(sessionUrl(paperB.docId, retryMovedSid));
  assert.ok(retried.entries.some(entry => entry.id === failed.id && entry.text === 'SYNTHETIC_MOVED_RETRY_REPLY'));
  pass('a moved chat retries its original paper image while the destination paper remains visible');

  holdGeneric = true;
  await typeDraft('FULL_GENERIC_QUESTION: BACKGROUND_MOVE_REVIEW'); await page.click('#sendBtn');
  for (let attempt = 0; attempt < 200 && !heldGeneric; attempt++) await wait(25);
  assert.ok(heldGeneric);
  await choose('reviewb');
  await page.waitForFunction(() => !window.__state.busy && window.__ctx.chatJobs.size > 0);
  await openMove(paperA, retryMovedSid);
  const moveCount = apiRequests.filter(request => request.path === '/api/sessions/move').length;
  await page.click('#sessMoveSubmit'); await page.waitForSelector('#sessMoveError', { visible: true });
  check('history refuses to move a source generating in the background while another session is active',
    await sid() === 'reviewb' && await draft() === 'EXISTING_TARGET_B_DRAFT'
    && apiRequests.filter(request => request.path === '/api/sessions/move').length === moveCount
    && !(await json(sessionUrl(paperB.docId, retryMovedSid))).deleted);
  await page.click('#sessMoveCancel');
  let pendingSource;
  for (let attempt = 0; attempt < 100; attempt++) {
    pendingSource = await json(sessionUrl(paperB.docId, retryMovedSid));
    if (pendingSource.entries.some(entry => entry.status === 'pending')) break;
    await wait(25);
  }
  assert.ok(pendingSource.entries.some(entry => entry.status === 'pending'));
  const pendingMove = await fetch(`${base}/api/sessions/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromDoc: paperB.docId, fromSid: retryMovedSid, toDoc: paperA.docId, toSid: 'forbidden-background-move', folderPath: 'vision' }) });
  assert.equal(pendingMove.status, 409); assert.equal((await pendingMove.json()).code, 'SESSION_GENERATING');
  pass('backend independently rejects a session with a persisted pending answer');
  await releaseModel('SYNTHETIC_BACKGROUND_FINISHED');
  await page.waitForFunction(() => window.__ctx.chatJobs.size === 0);
  await choose(retryMovedSid);
  check('the rejected background move leaves the original answer able to complete', (await chatText()).includes('SYNTHETIC_BACKGROUND_FINISHED'));
}

try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('agent-workspace').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', chunk => fs.appendFileSync(path.join(scratch, 'server.log'), chunk));
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* service starting */ }
    if (!ready) await wait(100);
  }
  check('isolated reader starts', ready);
  for (const asset of ['index.html', 'style.css', 'agent-workspace.css', 'session-history.css', 'js/app.js', 'js/agent-workspace.js',
    'js/agent-profile.js', 'js/agent-settings.js', 'js/ai.js', 'js/sessions.js', 'js/session-move.js']) {
    let served = await fetch(`${base}/${asset}`).then(response => response.text());
    if (asset === 'index.html') served = served.replace(/\n<!-- prt-auth:[\s\S]*?<\/script>\n/, '');
    assert.equal(served, fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `${asset} is the current source/build`);
  }
  pass('reader serves the current assistant assets');
  await json('/api/config', { baseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
    model: 'agent-workspace-synthetic', apiKey: 'SYNTHETIC_AGENT_WORKSPACE_KEY' });
  const papers = (await json('/api/papers')).papers;
  const paperA = papers.find(paper => paper.path === fixturePaths[0]);
  const paperB = papers.find(paper => paper.path === fixturePaths[1]);
  const broken = papers.find(paper => paper.path === fixturePaths[3]);
  assert.ok(paperA && paperB && broken);
  const visionScope = folderScope('vision');
  await seed('default', 'global-primary', 'Global research primary', 'GLOBAL_PRIMARY_ONLY');
  await seed('default', 'global-secondary', 'Global research secondary', 'GLOBAL_SECONDARY_ONLY');
  await seed(paperA.docId, 'paper-a-old', 'Paper A private discussion', 'PAPER_A_PRIVATE_ONLY', paperA);
  await seed(paperB.docId, 'paper-b-old', 'Paper B private discussion', 'PAPER_B_PRIVATE_ONLY', paperB);
  await seed(visionScope, 'folder-old', 'Folder private discussion', 'FOLDER_PRIVATE_ONLY', paperA);
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  if (historyDeletionReview) await reviewHistoryDeletion(paperA);
  else if (sourcesReview) await reviewSources(paperA, paperB);
  else if (moveReview) await reviewMoveCases({ paperA, paperB });
  else {
  if (!landingReview) {
  page = await newPage('paper');
  check('home assistant entry is available before opening any PDF', await visible('#homeAgent')
    && !await visible('#agentBtn') && await page.evaluate(() => !window.__state.doc && !window.__viewer.pdf));
  await page.click('#homeAgent');
  await page.waitForSelector('body.agent-full #rightSide', { visible: true });
  await settled();
  check('first English visit has a dedicated landing with a usable composer',
    await page.$eval('#agentLandingName', node => node.textContent) === 'Alina'
    && await visible('#agentLanding') && await visible('#chatInput') && !await visible('#aiArea'));
  check('landing gives find, resume and history one visible entrance each', await page.evaluate(() =>
    ['agentStartSearch', 'agentResume', 'agentHistory'].every(id => document.getElementById(id).getClientRects().length)
    && ['agentIdentity', 'sessBar'].every(id => !document.getElementById(id).getClientRects().length)
    && document.querySelector('#agentNav .agent-nav-primary #agentPapersToggle')?.getClientRects().length
    && document.querySelector('#workspaceNav #agentBtn')?.getClientRects().length
    && !document.querySelector('#agentLanding [data-agent-icon]')
    && !document.getElementById('agentNameEdit') && !document.getElementById('agentNameForm')));
  check('Library and Alina share workspace navigation with only the application Settings entrance', await page.evaluate(() =>
    !document.getElementById('agentNavLibrary')
    && !document.getElementById('agentNavSettings')
    && document.getElementById('settingsBtn')?.getClientRects().length
    && document.querySelector('#workspaceNav #homeBtn')?.textContent.includes('Library')));
  await page.click('#agentStartSearch');
  check('find papers focuses the shared composer without an extra dialog', await page.evaluate(() =>
    document.activeElement.id === 'chatInput' && document.body.classList.contains('agent-landing')));
  for (const width of [1920, 900, 320]) {
    await page.setViewport({ width, height: 940 }); await wait(150);
    await layout(`dedicated landing fits ${width}px`);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.agent-launch-copy')].every(node => {
      const box = node.getBoundingClientRect(), card = node.closest('.agent-launch').getBoundingClientRect();
      return box.left >= card.left && box.right <= card.right && node.clientWidth >= node.scrollWidth;
    })), `landing action labels fit their cards at ${width}px`);
    await page.screenshot({ path: path.join(scratch, `landing-${width}.png`) });
  }
  await page.setViewport({ width: 1400, height: 940 });
  check('no-PDF assistant owns the canonical global scope', await scope() === 'default');
  await history();
  const globalRows = await page.$$eval('#sessHistory .sess-hrow', nodes => nodes.map(node => node.dataset.sid));
  assert.deepEqual([...new Set(globalRows)].sort(), ['global-primary', 'global-secondary']);
  pass('full global history excludes paper and folder sessions');
  await page.keyboard.press('Escape');
  await page.click('#settingsBtn'); await page.waitForSelector('#settingsModal', { visible: true });
  await page.click('#settingsNavAgent');
  await page.click('#agentCustomize');
  await page.click('#agentWriteCard');
  check('the name and persona editor is available only in Settings', await visible('#agentNameInput')
    && await page.$eval('#agentNameDisplay', node => node.tagName) === 'SPAN' && !await visible('#saveSettings'));
  await page.$eval('#agentNameInput', input => { input.value = 'Research companion'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#agentProfileSave');
  await page.waitForFunction(() => document.querySelector('#agentIdentity').textContent.includes('Research companion'));
  await settled();
  check('assistant name changes through Settings', await page.$eval('#agentLandingName', node => node.textContent.includes('Research companion')));
  await page.click('#agentViewCard');
  await page.$eval('#agentPersonalityInput', input => { input.value = 'Clear, patient, concise'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('#agentGenderSelect', '女');
  await page.$eval('#agentHabitsInput', input => { input.value = 'Start with intuition'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#agentProfileSave');
  await page.waitForFunction(() => document.querySelector('#agentProfileSave').disabled);
  await page.click('#closeSettings');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && window.__state?.papers.length === 4);
  await page.evaluate(() => window.__ctx.setScopeRange('current'));
  await full({ landing: true });
  check('assistant name survives a reload', await page.$eval('#agentIdentity', node => node.textContent.includes('Research companion')));
  check('returning to Alina shows the landing without a naming overlay', await visible('#agentLanding')
    && await page.$('#agentNameForm') === null);
  await page.click('#settingsBtn'); await page.waitForSelector('#settingsModal', { visible: true }); await page.click('#settingsNavAgent');
  await page.click('#agentViewCard');
  check('optional personality fields survive a reload', await page.evaluate(() =>
    document.querySelector('#agentPersonalityInput').value === 'Clear, patient, concise'
    && document.querySelector('#agentGenderSelect').value === '女'
    && document.querySelector('#agentHabitsInput').value === 'Start with intuition'));
  await page.click('#closeSettings');
  await chooseGlobal();
  await page.click('#agentNavNew'); await settled();
  check('conversation returns to its landing through the sidebar new-chat entrance', await visible('#agentLanding')
    && !await visible('#agentLandingBack') && await scope() === 'default');
  await chooseGlobal();
  await typeDraft('A question without an open PDF');
  await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_GLOBAL_REPLY'));
  await page.evaluate(() => window.__ctx.saveSessionNow());
  check('no-PDF conversation saves to the global session', (await json(sessionUrl('default', 'global-primary'))).entries
    .some(entry => entry.text?.includes('SYNTHETIC_GLOBAL_REPLY')));
  const globalDraft = 'GLOBAL_DRAFT_MUST_STAY_WITH_GLOBAL';
  await typeDraft(globalDraft);
  await page.evaluate(() => { window.__testAgentPanel = document.querySelector('#rightSide'); });
  await handoff(paperA);
  check('real paper picker opens a PDF and reuses the full workspace DOM in the reader', await page.evaluate(() =>
    window.__viewer.numPages === 1 && window.__testAgentPanel === document.querySelector('#rightSide')));
  check('handoff choices float inside the message area without covering the composer', await page.evaluate(() => {
    const handoff = document.querySelector('#agentHandoff').getBoundingClientRect();
    const area = document.querySelector('#aiArea').getBoundingClientRect();
    const composer = document.querySelector('#composer').getBoundingClientRect();
    return handoff.top >= area.top - 1 && handoff.bottom <= area.bottom + 1
      && handoff.left >= area.left - 1 && handoff.right <= area.right + 1 && handoff.bottom <= composer.top + 1;
  }));
  check('handoff preserves global conversation and draft before choosing', await sid() === 'global-primary' && await draft() === globalDraft);
  const handoffLayout = () => page.evaluate(() => {
    const area = document.querySelector('#aiArea').getBoundingClientRect();
    const composer = document.querySelector('#composer').getBoundingClientRect();
    const chat = document.querySelector('[data-block="chat"] .ai-body');
    return [area.top, area.height, composer.top, composer.height, chat?.scrollTop || 0];
  });
  const beforeContinue = await handoffLayout();
  await page.click('#agentContinue');
  await page.waitForFunction(() => !document.querySelector('#agentHandoff').getClientRects().length);
  await settled();
  const afterContinue = await handoffLayout();
  check('dismissing handoff alone keeps message dimensions and scroll anchor',
    beforeContinue.every((value, index) => Math.abs(value - afterContinue[index]) <= 1));
  check('continue keeps global history and ownership in the reader', await sid() === 'global-primary'
    && await scope() === 'default' && (await chatText()).includes('GLOBAL_PRIMARY_ONLY') && await draft() === globalDraft);
  check('opening the assistant never changes the paper preference', await page.evaluate(() => localStorage.getItem('reader.session.scopeMode')) === 'paper');
  await page.click('#agentExpand');
  await page.waitForSelector('body.agent-full #rightSide', { visible: true });
  await settled();
  check('expand returns the same global conversation and draft', await sid() === 'global-primary' && await draft() === globalDraft
    && await page.evaluate(() => window.__testAgentPanel === document.querySelector('#rightSide')));
  await page.evaluate(() => localStorage.setItem('reader.session.onEnter', 'new'));
  await handoff(paperB);
  check('onEnter=new never replaces an active global conversation when opening a paper', await sid() === 'global-primary' && await scope() === 'default');
  await page.evaluate(() => {
    const card = document.querySelector('#agentHandoff');
    const nativeAnimate = card.animate.bind(card);
    window.__handoffAnimations = [];
    card.animate = (frames, options) => {
      window.__handoffAnimations.push({ frames, duration: options?.duration });
      return nativeAnimate(frames, options);
    };
  });
  await typeDraft('HANDOFF_AUTOCONTINUE_QUESTION');
  const geometry = () => page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    return { area: rect('#aiArea'), composer: rect('#composer') };
  });
  const beforeDismiss = await geometry();
  await page.click('#sendBtn');
  await page.waitForFunction(() => !document.querySelector('#agentHandoff').getClientRects().length
    && !window.__state.busy && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_HANDOFF_REPLY'));
  const afterDismiss = await geometry();
  assert.ok(beforeDismiss.area.slice(0, 3).every((value, index) => Math.abs(value - afterDismiss.area[index]) <= 1)
    && Math.abs(beforeDismiss.area[3] + beforeDismiss.composer[3] - afterDismiss.area[3] - afterDismiss.composer[3]) <= 1
    && Math.abs(beforeDismiss.composer[1] + beforeDismiss.composer[3] - afterDismiss.composer[1] - afterDismiss.composer[3]) <= 1,
    `handoff dismissal changes layout: ${JSON.stringify({ beforeDismiss, afterDismiss })}`);
  check('sending without a handoff choice fades the card without changing message/composer geometry', await page.evaluate(() =>
    window.__handoffAnimations.some(animation => animation.duration === 160 && animation.frames.some(frame => Number(frame.opacity) === 0))));
  check('implicit continuation still belongs to the global session', await scope() === 'default' && await sid() === 'global-primary');
  await page.evaluate(() => localStorage.setItem('reader.session.onEnter', 'choose'));
  await typeDraft(globalDraft);
  await full();
  await handoff(paperB);
  await page.click('#agentRestore');
  await chooseLocal('paper-b-old', 'PAPER_B_PRIVATE_ONLY');
  check('restore selects the paper conversation without importing global text or draft', !(await chatText()).includes('GLOBAL_PRIMARY_ONLY')
    && await draft() !== globalDraft && await scope() === paperB.docId);
  await typeDraft('LOCAL_B_DRAFT');
  await page.click('#agentExpand'); await settled();
  check('expanding a local conversation preserves its owner, session and draft', await scope() === paperB.docId
    && await sid() === 'paper-b-old' && await draft() === 'LOCAL_B_DRAFT' && await visible('#aiArea'));
  holdGeneric = true;
  await typeDraft('FULL_GENERIC_QUESTION LOCAL_EXPANDED_SOURCE: Explain this paper.'); await page.click('#sendBtn');
  for (let attempt = 0; attempt < 200 && !heldGeneric; attempt++) await wait(25);
  assert.ok(heldGeneric, 'expanded local paper question reaches the synthetic model');
  const localExpandedContext = await page.evaluate(() => {
    const job = [...window.__ctx.chatJobs.values()].find(job => job.pending?.question.includes('LOCAL_EXPANDED_SOURCE'));
    return { docId: job?.pending.docId, sourceDocId: job?.pending.sourcePaper?.docId, pages: job?.reader?.numPages };
  });
  assert.equal(localExpandedContext.docId, paperB.docId);
  assert.equal(localExpandedContext.sourceDocId, paperB.docId);
  assert.equal(localExpandedContext.pages, 1);
  heldGeneric.writeHead(200, { 'Content-Type': 'text/event-stream' });
  heldGeneric.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'SYNTHETIC_LOCAL_EXPANDED_REPLY' } }] })}\n\ndata: [DONE]\n\n`);
  heldGeneric = null;
  await page.waitForFunction(() => !window.__state.busy && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_LOCAL_EXPANDED_REPLY'));
  pass('expanded local questions retain their visible PDF context');
  await typeDraft('LOCAL_B_DRAFT');
  await handoff(paperA); await page.click('#agentContinue'); await settled();
  check('opening another paper from an expanded local chat keeps the original conversation owner',
    await scope() === paperB.docId && await sid() === 'paper-b-old' && await draft() === 'LOCAL_B_DRAFT'
    && (await chatText()).includes('PAPER_B_PRIVATE_ONLY'));
  await full();
  check('returning to global restores its own draft', await draft() === globalDraft && await sid() === 'global-primary');
  await handoff(paperA);
  await page.click('#agentNew');
  await page.waitForFunction(() => !!window.__ctx.activeSession && !['global-primary', 'paper-a-old'].includes(window.__ctx.activeSession));
  await settled();
  check('new creates a local conversation without replacing its old history', !(await chatText()).includes('PAPER_A_PRIVATE_ONLY')
    && !(await chatText()).includes('GLOBAL_PRIMARY_ONLY') && await draft() === '' && await scope() === paperA.docId);
  check('old paper conversation remains in real storage', (await json(sessionUrl(paperA.docId, 'paper-a-old'))).entries.some(entry => entry.text === 'PAPER_A_PRIVATE_ONLY'));
  const newLocalSid = await sid();
  await typeDraft('LOCAL_NEW_QUESTION'); await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_LOCAL_REPLY'));
  await page.evaluate(() => window.__ctx.saveSessionNow());
  check('new local messages save only to the new paper session',
    (await json(sessionUrl(paperA.docId, newLocalSid))).entries.some(entry => entry.text?.includes('SYNTHETIC_LOCAL_REPLY'))
    && !(await json(sessionUrl('default', 'global-primary'))).entries.some(entry => entry.text?.includes('SYNTHETIC_LOCAL_REPLY')));
  await full();
  check('new local conversation leaves global draft intact', await draft() === globalDraft && await sid() === 'global-primary');
  holdGeneric = true;
  await typeDraft('FULL_GENERIC_QUESTION: Explain the difference between a stack and a queue.');
  await page.click('#sendBtn');
  for (let attempt = 0; attempt < 200 && !heldGeneric; attempt++) await wait(25);
  assert.ok(heldGeneric, 'generic full-workspace question reaches the model');
  const genericContext = await page.evaluate(() => {
    const job = [...window.__ctx.chatJobs.values()].find(job => job.pending?.question.includes('FULL_GENERIC_QUESTION'));
    if (!job) throw new Error('Generic question has no active job');
    return { docId: job.pending.docId, sourceDoc: job.pending.sourcePaper?.docId || null,
      page: job.pending.firstPage, screenPage: job.pending.screenPage };
  });
  check('full workspace does not silently reuse the previous PDF for a general question',
    !genericContext.docId && !genericContext.sourceDoc && !genericContext.page && !genericContext.screenPage);
  const movesBeforeBusy = apiRequests.filter(request => request.path === '/api/sessions/move').length;
  await openSessionMove();
  check('a generating conversation cannot open the ownership editor or send a move request',
    !await visible('#sessMoveLayer') && await sid() === 'global-primary' && await scope() === 'default'
    && apiRequests.filter(request => request.path === '/api/sessions/move').length === movesBeforeBusy);
  if (await visible('#sessHistory')) await page.click('.sess-hist-back');
  heldGeneric.writeHead(200, { 'Content-Type': 'text/event-stream' });
  heldGeneric.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'SYNTHETIC_GENERIC_REPLY' } }] })}\n\ndata: [DONE]\n\n`);
  heldGeneric = null;
  await page.waitForFunction(() => !window.__state.busy && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_GENERIC_REPLY'));
  await typeDraft(globalDraft);
  async function clickReference(paper, explicitPaper) {
    await page.evaluate(({ paper, explicitPaper }) => {
      document.querySelector('#agent-test-reference')?.remove();
      const message = document.createElement('div'); message.className = 'msg';
      if (!explicitPaper) message.__sessionRecord = { docId: paper.docId, docPath: paper.path };
      const button = document.createElement('button'); button.id = 'agent-test-reference';
      button.className = 'page-ref'; button.dataset.page = '1'; button.textContent = 'Synthetic source p.1';
      if (explicitPaper) button.dataset.paper = paper.path;
      message.append(button); document.querySelector('[data-block="chat"] .ai-body').append(message);
    }, { paper, explicitPaper });
    await page.click('#agent-test-reference');
    await page.waitForFunction(id => document.body.classList.contains('agent-docked')
      && window.__state.viewerDocId === id && window.__viewer.current === 1, {}, paper.docId);
    await page.waitForFunction(() => !document.querySelector('#agentContinue').disabled);
  }
  await clickReference(paperB, true);
  check('cross-paper reference opens the real PDF and docks the same global conversation', await sid() === 'global-primary'
    && await scope() === 'default' && await page.evaluate(() => window.__testAgentPanel === document.querySelector('#rightSide')));
  await full();
  await clickReference(paperB, false);
  check('same-paper page reference also makes the PDF visible from full workspace', await sid() === 'global-primary'
    && await scope() === 'default' && await visible('#viewer'));
  await full();
  failPdf = broken.path;
  const beforeFailure = failedReads;
  await pick(broken);
  for (let attempt = 0; attempt < 100 && failedReads === beforeFailure; attempt++) await wait(50);
  assert.ok(failedReads > beforeFailure, 'failure injection reached the real PDF request');
  await page.waitForFunction(() => document.body.classList.contains('agent-full')
    && !document.querySelector('#docLoading')?.getClientRects().length);
  await settled();
  check('PDF opening failure retains full workspace, conversation and draft', await sid() === 'global-primary'
    && await draft() === globalDraft && await visible('#rightSide'));
  failPdf = '';
  if (await visible('#agentPaperPicker')) await page.click('#agentPapersClose');
  await typeDraft('AFTER_PDF_FAILURE_QUESTION'); await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_RECOVERY_REPLY'));
  check('a failed PDF open still allows a real follow-up in the global conversation', await scope() === 'default' && await sid() === 'global-primary');
  await typeDraft(globalDraft);
  await page.waitForFunction(() => !document.querySelector('#toastWrap .toast'), { timeout: 10000 });
  for (const width of [1400, 900, 320]) {
    await page.setViewport({ width, height: 940 });
    await wait(300);
    await layout(`full assistant fits ${width}px`);
    await page.screenshot({ path: path.join(scratch, `full-${width}.png`) });
  }
  await page.setViewport({ width: 1400, height: 940 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await handoff(paperA);
  await page.click('#agentContinue');
  await settled();
  check('reduced motion disables assistant transition animation', await page.$eval('#rightSide', node => {
    const style = getComputedStyle(node);
    return style.transitionDuration.split(',').every(value => parseFloat(value) === 0)
      && node.getAnimations().every(animation => animation.playState !== 'running');
  }));
  for (const width of [1400, 900, 320]) {
    await page.setViewport({ width, height: 940 });
    await wait(300);
    await layout(`docked assistant fits ${width}px`);
    await page.screenshot({ path: path.join(scratch, `docked-${width}.png`) });
  }
  await page.setViewport({ width: 1400, height: 940 });
  await full();
  await handoff(paperB);
  await page.click('#agentRestore');
  await chooseLocal('paper-b-old', 'PAPER_B_PRIVATE_ONLY');
  check('local draft also survives global and paper handoffs', await draft() === 'LOCAL_B_DRAFT');
  await full();
  await page.click('#homeBtn');
  await page.waitForSelector('#home', { visible: true });
  await page.click(`#homeList .home-item[data-id=${JSON.stringify(paperB.docId)}] .home-item-go`);
  await page.waitForFunction(id => window.__state.viewerDocId === id && document.body.classList.contains('reading')
    && window.__ctx.agentWorkspaceState().scope === id, {}, paperB.docId);
  await chooseLocal('paper-b-old', 'PAPER_B_PRIVATE_ONLY');
  check('returning through the bookshelf to the same PDF restores its local scope and draft', await draft() === 'LOCAL_B_DRAFT');
  await full();
  check('global draft survives ordinary bookshelf navigation', await scope() === 'default' && await sid() === 'global-primary' && await draft() === globalDraft);

  const transferTitle = 'Portable conversation with evidence';
  const transferMarker = 'TRANSFER_QUESTION_WITH_ORIGINAL_EVIDENCE';
  const transferDraft = 'UNSENT_TRANSFER_DRAFT';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
  const pngUrl = `data:image/png;base64,${png.toString('base64')}`;
  await seed('default', 'transfer-global', transferTitle, transferMarker, paperA);
  const attachmentResponse = await fetch(`${base}/api/attachment?${new URLSearchParams({ doc: 'default', sid: 'transfer-global' })}`,
    { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(attachmentResponse.status, 200);
  const transferImage = (await attachmentResponse.json()).id;
  const sourceTransfer = await json(sessionUrl('default', 'transfer-global'));
  Object.assign(sourceTransfer.entries[0], { page: 1, attachmentDoc: 'default', attachmentSid: 'transfer-global',
    shots: [{ id: transferImage, w: 1, h: 1, label: 'Original synthetic evidence' }] });
  await json(sessionUrl('default', 'transfer-global'), sourceTransfer);
  await history();
  await page.waitForSelector('#sessHistory .sess-hrow[data-sid="transfer-global"] .sess-hgo', { visible: true });
  await page.click('#sessHistory .sess-hrow[data-sid="transfer-global"] .sess-hgo');
  await page.waitForFunction(() => window.__ctx.activeSession === 'transfer-global');
  await settled();
  await typeDraft(transferDraft);
  await page.evaluate(pngUrl => {
    window.__ctx.addImageToChat({ dataUrl: pngUrl, width: 1, height: 1 }, 1, 'Unsent synthetic screenshot');
  }, pngUrl);
  await page.evaluate(() => window.__ctx.flushComposerDrafts());
  const untouchedPaper = await json(sessionUrl(paperB.docId, 'paper-b-old'));
  const untouchedFolder = await json(sessionUrl(visionScope, 'folder-old'));
  const untouchedGlobal = await json(sessionUrl('default', 'global-primary'));
  const draftState = () => page.evaluate(() => ({ text: document.querySelector('#chatInput').value,
    attachments: window.__state.attachments.map(item => ({ dataUrl: item.dataUrl, label: item.label, kind: item.kind })) }));
  const originalDraftState = await draftState();
  assert.equal(originalDraftState.attachments.length, 1);
  async function openMove(mode, target = null, fromHistory = false) {
    await openSessionMove(fromHistory ? await sid() : '');
    await page.waitForSelector('#sessMovePanel', { visible: true });
    await page.waitForFunction(() => !document.querySelector('#sessMoveMode').disabled);
    assert.equal(await page.$eval('#sessMoveSubmit', node => node.disabled), true, 'same ownership cannot be submitted');
    await page.select('#sessMoveMode', mode);
    if (target !== null) await page.select('#sessMoveTarget', target);
    await page.waitForFunction(() => !document.querySelector('#sessMoveSubmit').disabled);
  }
  await openMove('paper', paperB.docId);
  const moveFormGeometry = await page.evaluate(() => {
    const panel = document.querySelector('#sessMovePanel').getBoundingClientRect();
    const composer = document.querySelector('#composer').getBoundingClientRect();
    return { bottom: panel.bottom, composerTop: composer.top };
  });
  check('ownership editor leaves the unsent composer unobstructed', moveFormGeometry.bottom <= moveFormGeometry.composerTop + 1);
  await page.screenshot({ path: path.join(scratch, 'ownership-editor.png') });
  failMove = true;
  await page.click('#sessMoveSubmit');
  await page.waitForSelector('#sessMoveError', { visible: true });
  check('a rejected move keeps the original session, content, draft and image', failedMoves === 1
    && await sid() === 'transfer-global' && await scope() === 'default'
    && (await chatText()).includes(transferMarker)
    && JSON.stringify(await draftState()) === JSON.stringify(originalDraftState)
    && !(await json(sessionUrl('default', 'transfer-global'))).deleted);
  await page.click('#sessMoveCancel');
  const movedSids = [];
  async function moveAndVerify(mode, target, expectedScope, fromHistory = false) {
    const oldScope = await scope(), oldSid = await sid();
    await openMove(mode, target, fromHistory);
    await page.click('#sessMoveSubmit');
    await page.waitForFunction(({ expectedScope, oldSid }) => window.__ctx.agentWorkspaceState().scope === expectedScope
      && window.__ctx.activeSession !== oldSid && !document.querySelector('#sessMoveLayer').getClientRects().length,
    {}, { expectedScope, oldSid });
    await settled();
    const newSid = await sid(); movedSids.push(newSid);
    await page.waitForFunction(marker => document.querySelector('#aiArea').textContent.includes(marker), {}, transferMarker);
    await page.evaluate(async () => { await window.__ctx.flushComposerDrafts(); await window.__ctx.saveSessionNow(); });
    assert.deepEqual(await draftState(), originalDraftState, 'text and unsent screenshot remain intact');
    const targetSession = await json(sessionUrl(expectedScope, newSid));
    assert.equal(targetSession.title, transferTitle);
    assert.equal(targetSession.entries.length, sourceTransfer.entries.length);
    const screenshotRow = targetSession.entries.find(entry => entry.shots?.some(shot => shot.id === transferImage));
    assert.ok(screenshotRow, 'stored screenshot reference survives');
    assert.equal(screenshotRow.docId, paperA.docId, 'original evidence paper is preserved');
    assert.equal(screenshotRow.page, 1, 'original evidence page is preserved');
    assert.equal(screenshotRow.attachmentSid, newSid);
    const imageResponse = await fetch(`${base}/api/attachment?${new URLSearchParams({ doc: screenshotRow.attachmentDoc, sid: newSid, id: transferImage })}`);
    assert.equal(imageResponse.status, 200); assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
    assert.equal((await json(sessionUrl(oldScope, oldSid))).deleted, true);
    const allSessions = (await json('/api/sessions?scope=all&archived=all')).sessions;
    assert.ok(!allSessions.some(session => session.sid === oldSid), 'source is removed from the history list');
    assert.equal(allSessions.filter(session => session.sid === newSid).length, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('reader.session.scopeMode')), 'paper');
    pass(`${mode} conversion creates one independent session with intact title, messages, evidence and draft`);
  }
  await moveAndVerify('paper', paperB.docId, paperB.docId);
  await moveAndVerify('folder', 'vision', visionScope, true);
  await moveAndVerify('global', null, 'default');
  assert.equal(new Set(movedSids).size, 3);
  for (const [scopeKey, sessionId, snapshot] of [[paperB.docId, 'paper-b-old', untouchedPaper],
    [visionScope, 'folder-old', untouchedFolder], ['default', 'global-primary', untouchedGlobal]]) {
    const current = await json(sessionUrl(scopeKey, sessionId));
    assert.equal(current.title, snapshot.title); assert.deepEqual(current.entries, snapshot.entries);
  }
  pass('three-way conversion never merges into existing target conversations');
  const roundTripSid = await sid();
  await handoff(paperB); await page.click('#agentRestore');
  await chooseLocal('paper-b-old', 'PAPER_B_PRIVATE_ONLY');
  check('conversion leaves the target paper conversation draft intact', await draft() === 'LOCAL_B_DRAFT');
  await full();
  await page.waitForFunction(currentSid => window.__ctx.activeSession === currentSid, {}, roundTripSid);
  assert.deepEqual(await draftState(), originalDraftState);
  pass('round-trip conversation retains its independent draft after returning from an old target session');
  await page.evaluate(async () => { await window.__ctx.flushComposerDrafts(); await window.__ctx.saveSessionNow(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && window.__state?.papers.length === 4);
  await full();
  await page.waitForFunction(currentSid => window.__ctx.activeSession === currentSid
    && document.querySelector('#aiArea').textContent.includes('TRANSFER_QUESTION_WITH_ORIGINAL_EVIDENCE'), {}, roundTripSid);
  assert.deepEqual(await draftState(), originalDraftState);
  pass('moved conversation and its text/image draft survive a full page reload');
  await moveAndVerify('folder', '', folderScope(''));
  check('moving to a folder without PDFs opens its own full conversation space', await page.evaluate(() =>
    document.body.classList.contains('agent-full')) && await scope() === folderScope(''));
  await page.evaluate(() => { for (const attachment of [...window.__state.attachments]) window.__ctx.removeAttach(attachment.id); });
  holdGeneric = true;
  await typeDraft('FULL_GENERIC_QUESTION: EMPTY_FOLDER_SCOPE. Explain a stack.');
  await page.click('#sendBtn');
  for (let attempt = 0; attempt < 200 && !heldGeneric; attempt++) await wait(25);
  assert.ok(heldGeneric, 'empty-folder conversation reaches the model');
  const emptyFolderContext = await page.evaluate(() => {
    const job = [...window.__ctx.chatJobs.values()].find(job => job.pending?.question.includes('EMPTY_FOLDER_SCOPE'));
    return { docId: job?.pending.docId, sourceDoc: job?.pending.sourcePaper?.docId || null,
      page: job?.pending.firstPage, screenPage: job?.pending.screenPage };
  });
  check('a general question in an empty-folder conversation has no stale PDF context',
    !emptyFolderContext.docId && !emptyFolderContext.sourceDoc && !emptyFolderContext.page && !emptyFolderContext.screenPage);
  heldGeneric.writeHead(200, { 'Content-Type': 'text/event-stream' });
  heldGeneric.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'SYNTHETIC_EMPTY_FOLDER_REPLY' } }] })}\n\ndata: [DONE]\n\n`);
  heldGeneric = null;
  await page.waitForFunction(() => !window.__state.busy && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_EMPTY_FOLDER_REPLY'));
  await page.evaluate(() => window.__ctx.saveSessionNow());
  check('a folder without PDFs can continue and save its real conversation',
    (await json(sessionUrl(folderScope(''), await sid()))).entries.some(entry => entry.text === 'SYNTHETIC_EMPTY_FOLDER_REPLY'));

  page = await newPage('folder');
  await full(); await chooseGlobal(); await handoff(paperA);
  await page.click('#agentRestore'); await chooseLocal('folder-old', 'FOLDER_PRIVATE_ONLY');
  check('folder preference restores its folder conversation and stays unchanged',
    await page.evaluate(() => localStorage.getItem('reader.session.scopeMode')) === 'folder'
    && await scope() === visionScope && !(await chatText()).includes('GLOBAL_PRIMARY_ONLY'));
  await page.evaluate(() => window.__ctx.saveSessionNow());
  check('restored folder conversation saves under the folder key', (await json(sessionUrl(visionScope, 'folder-old'))).entries
    .some(entry => entry.text === 'FOLDER_PRIVATE_ONLY'));

  page = await newPage('global');
  await full(); await chooseGlobal(); await handoff(paperA);
  await page.click('#agentContinue');
  await settled();
  check('global preference uses the same global session in both views', await sid() === 'global-primary'
    && await page.evaluate(() => localStorage.getItem('reader.session.scopeMode')) === 'global');
  }
  page = await newPage('paper', 'zh-CN');
  await full({ landing: true });
  check('first Chinese visit displays the default Chinese name without an inline editor',
    await page.$eval('#agentLandingName', node => node.textContent.includes('Alina'))
    && await page.$eval('#agentNameInput', input => input.value) === 'Alina' && !await visible('#agentNameInput'));
  await history();
  check('full history hides the duplicated conversation entrances', !await visible('#agentIdentity')
    && !await visible('#sessBar') && await visible('.sess-hist-back'));
  await page.click('.sess-hist-back');
  check('history opened from the landing returns to the landing', await visible('#agentLanding') && !await visible('#aiArea'));
  await page.keyboard.down('Control');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Equal');
  await page.keyboard.up('Control');
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--agent-scale').trim() === '1.6');
  const previousLandingSid = await sid();
  const captureLandingTrace = () => page.evaluate(() => {
    const composer = document.getElementById('composer'), animate = composer.animate.bind(composer);
    window.__landingComposer = composer; window.__landingAnimations = [];
    composer.animate = (frames, options) => {
      const animation = animate(frames, options);
      animation.currentTime = 0;
      const rect = () => { const r = composer.querySelector('.composer-row').getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height }; };
      const trace = { frames, duration: options?.duration, start: rect(), samples: [], done: false };
      window.__landingAnimations.push(trace);
      const sample = () => { trace.samples.push(rect()); if (animation.playState === 'running') requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
      void animation.finished.then(() => { trace.end = rect(); trace.done = true; }, () => { trace.cancelled = true; });
      return animation;
    };
  });
  const verifyLandingTrace = async (before, label) => {
    await page.waitForFunction(() => window.__landingAnimations.some(animation => animation.duration === 260 && animation.done));
    const animation = await page.evaluate(() => window.__landingAnimations.find(animation => animation.duration === 260));
    for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(animation.start[key] - before[key]) <= 1,
      `${label} input-card animation at ${key}: ${JSON.stringify({ before, animation })}`);
    assert.ok(animation.samples.length >= 3, 'observe the rendered transition across real frames');
    for (const key of ['left', 'top', 'width', 'height']) {
      const increasing = animation.end[key] >= animation.start[key];
      const samples = [animation.start, ...animation.samples, animation.end];
      for (let i = 1; i < samples.length; i++) assert.ok(increasing ? samples[i][key] >= samples[i - 1][key] - 1
        : samples[i][key] <= samples[i - 1][key] + 1, `${label} input-card ${key} reverses during animation: ${JSON.stringify(animation)}`);
    }
    animationChecks.push({ label, before, animation });
    pass(label);
  };
  await captureLandingTrace();
  await typeDraft('FIRST_NAME_DISMISS_QUESTION');
  const landingComposerBefore = await page.$eval('#composer .composer-row', node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
  await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_NAME_DISMISS_REPLY'));
  check('a question from the landing uses its independent global conversation without setup', !await visible('#agentLanding')
    && await scope() === 'default' && !!previousLandingSid && await sid() === previousLandingSid);
  check('the first question moves the same composer with a short transform animation', await page.evaluate(() =>
    document.getElementById('composer') === window.__landingComposer
    && window.__landingAnimations.some(animation => animation.duration === 260
      && animation.frames.every(frame => typeof frame.transform === 'string'))));
  await verifyLandingTrace(landingComposerBefore, 'the visible input card keeps its physical bounds and moves continuously at 160% zoom');
  await layout('conversation keeps the composer usable at 160% zoom');
  await page.evaluate(async () => { await window.__ctx.flushComposerDrafts(); await window.__ctx.saveSessionNow(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && window.__state?.papers.length === 4);
  await full({ landing: true });
  check('returning after the first question opens the dedicated landing again', await visible('#agentLanding')
    && await page.$('#agentNameForm') === null);
  await captureLandingTrace();
  await typeDraft('FIRST_NAME_DISMISS_QUESTION\nCompare the assumptions in this synthetic example.\nExplain the first step carefully.\nThen check the second step.\nFinally summarize the differences.');
  await page.$eval('#chatInput', input => input.focus({ preventScroll: true }));
  const multilineBefore = await page.$eval('#composer .composer-row', node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.body.classList.contains('agent-landing') && !window.__state.busy
    && document.querySelector('#aiArea').textContent.includes('SYNTHETIC_NAME_DISMISS_REPLY'));
  await verifyLandingTrace(multilineBefore, 'multiline first questions keep the input card continuous as the textarea clears');
  await page.evaluate(() => window.__ctx.saveSessionNow());
  await page.keyboard.down('Control'); await page.keyboard.press('Digit0'); await page.keyboard.up('Control');
  const beforeHistorySid = await sid();
  await history();
  await page.click('#sessHistory .sess-hrow .sess-hmore');
  await page.waitForSelector('.sess-row-menu', { visible: true });
  await wait(250);
  await page.screenshot({ path: path.join(scratch, 'real-global-history-menu.png') });
  await page.keyboard.press('Escape'); await page.click('.sess-hist-back');
  check('history opened from a conversation returns to that same conversation', await sid() === beforeHistorySid
    && !await visible('#agentLanding') && await visible('#aiArea') && (await chatText()).includes('SYNTHETIC_NAME_DISMISS_REPLY'));
  }
  if (includeHistoryDeletion && !historyDeletionReview) await reviewHistoryDeletion(paperA);
  if (historyDeletionReview) check('history deletion needs no model requests', !modelRequests.length);
  else check('only the local synthetic model was used', modelRequests.length >= 1);
  assert.deepEqual(errors, [], 'no uncaught browser errors or external requests');
  pass('no browser errors or external service requests');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktop ? 'desktop' : 'node',
    checks, errors, dialogs, apiRequests, animationChecks, modelRequests: modelRequests.length, failedReads, failedMoves }, null, 2), 'utf8');
  console.log(`agent-workspace: ${checks.length}/${checks.length} passed; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  if (page) {
    await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
    const diagnostic = await page.evaluate(() => ({ body: document.body.className, doc: window.__state?.doc,
      sid: window.__ctx?.activeSession, workspace: window.__ctx?.agentWorkspaceState?.(),
      handoffAnimations: window.__handoffAnimations, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      draft: document.querySelector('#chatInput')?.value, text: document.querySelector('#rightSide')?.textContent,
      historyRows: [...document.querySelectorAll('#sessHistory .sess-hrow')].map(node => ({ sid: node.dataset.sid, fileKey: node.dataset.fileKey, text: node.textContent })),
      active: document.activeElement?.id })).catch(() => null);
    fs.writeFileSync(path.join(scratch, 'diagnostic.json'), JSON.stringify({ errors, diagnostic, apiRequests }, null, 2), 'utf8');
  }
  console.error(`Failure evidence: ${scratch}`);
  throw error;
} finally {
  await browser?.close();
  await stopChild(reader);
  upstream.closeAllConnections?.();
  await new Promise(resolve => upstream.close(resolve));
}
