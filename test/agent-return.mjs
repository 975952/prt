/** Alina navigation preserves live conversations and independent composer drafts.
 * node test/agent-return.mjs [--desktop]
 * Disposable storage, synthetic PDFs and a gated local SSE model only.
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
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
assert.ok(executablePath, 'Chromium is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `agent-return-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
writeTitlePdf(path.join(papersDir, 'return-study.pdf'), { title: 'Synthetic Navigation Study' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const checks = [], errors = [], failedRequests = [], cancelledPreviews = [], modelRequests = [], snapshots = [];
const check = (label, condition, detail = '') => {
  checks.push({ label, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
};
let reader, browser, page, base, heldResponse;
const emit = (res, content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    modelRequests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    emit(res, `LIVE_STREAM_${modelRequests.length}_START `);
    heldResponse = res;
  } catch (error) { errors.push(`Fake model: ${error.message}`); res.writeHead(500); res.end('fake failure'); }
});
const sessionUrl = sid => `/api/session?${new URLSearchParams({ doc: 'default', sid })}`;
async function json(route, body) {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
}
async function seed(sid, title, marker) {
  await json(sessionUrl(sid), { title, titleSource: 'user', createdAt: Date.now(), updatedAt: Date.now(),
    entries: [
      { id: `${sid}-question`, block: 'chat', kind: 'user', tag: '提问', text: `OLD_QUESTION_${marker}`, status: 'user' },
      { id: `${sid}-answer`, block: 'chat', kind: 'assistant', tag: '问答', text: `SAVED_ANSWER_${marker}`, status: 'complete' },
    ], history: [{ role: 'user', content: `OLD_QUESTION_${marker}` }, { role: 'assistant', content: `SAVED_ANSWER_${marker}` }], ops: [] });
}
const navSettled = () => page.waitForFunction(() => document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true');
async function snapshot(label) {
  const state = await page.evaluate(() => ({ sid: window.__ctx.activeSession, workspace: window.__ctx.agentWorkspaceState(),
    landing: document.body.classList.contains('agent-landing'), busy: window.__state.busy,
    text: document.querySelector('#aiArea').textContent, draft: document.querySelector('#chatInput').value,
    jobs: [...window.__ctx.chatJobs.values()].map(job => ({ sid: job.sid, key: job.key })),
    history: window.__state.history, entries: window.__state.sessionEntries }));
  snapshots.push({ label, ...state }); return state;
}
async function input(value) {
  await page.$eval('#chatInput', (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await page.evaluate(() => window.__ctx.flushComposerDrafts());
}
async function choose(sid) {
  const selector = `.agent-nav-session[data-agent-session="${sid}"]`;
  await page.locator(selector).click(); await navSettled();
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.all(document.querySelector('#composer').getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}
async function libraryAndBack() {
  await page.click('#homeBtn'); await page.waitForSelector('#home', { visible: true });
  await page.click('#homeAgent'); await page.waitForSelector('body.agent-full #rightSide', { visible: true }); await navSettled();
}
async function startStream(question) {
  heldResponse = null;
  await input(question); await page.click('#sendBtn');
  for (let i = 0; i < 150 && !heldResponse; i++) await wait(50);
  assert.ok(heldResponse, 'the local model receives the request');
  await page.waitForFunction(() => window.__ctx.chatJobs.size === 1 && window.__state.busy);
  await page.waitForFunction(marker => document.querySelector('#aiArea').textContent.includes(marker), {}, `LIVE_STREAM_${modelRequests.length}_START`);
}
async function finishStream() {
  assert.ok(heldResponse); emit(heldResponse, `LIVE_STREAM_${modelRequests.length}_FINISHED`);
  heldResponse.end('data: [DONE]\n\n'); heldResponse = null;
  await page.waitForFunction(() => window.__ctx.chatJobs.size === 0);
}
const report = () => ({ mode: desktop ? 'desktop' : 'node', checks, errors, failedRequests, cancelledPreviews, snapshots, modelRequests });
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('agent-return').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', chunk => fs.appendFileSync(path.join(scratch, 'server.log'), chunk));
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready, 'isolated reader starts');
  assert.equal(path.resolve((await json('/api/papers')).dir), path.resolve(papersDir));
  for (const asset of ['js/app.js', 'js/sessions.js', 'js/agent-workspace.js', 'citations.css', 'js/citation-display.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(res => res.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `${asset}: current source/build`);
  }
  check('isolated service serves current navigation code', true);
  await json('/api/config', { baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'agent-return-synthetic', apiKey: 'SYNTHETIC_AGENT_RETURN_KEY' });
  await seed('return-primary', 'First discussion', 'PRIMARY'); await seed('return-secondary', 'Second discussion', 'SECONDARY');
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  page = await browser.newPage(); await page.setViewport({ width: 1450, height: 950 }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('dialog', dialog => { void dialog.accept(); });
  page.on('requestfailed', request => {
    const row = { url: request.url(), error: request.failure()?.errorText };
    // No PDF is opened in this suite. Leaving Library intentionally aborts
    // its in-flight cover preview in stopHomeThumbnailWork(). Keep evidence
    // of those cancellations without treating them as failed chat requests.
    const url = new URL(row.url);
    if (row.error === 'net::ERR_ABORTED' && url.origin === base && url.pathname === '/api/pdf'
      && url.searchParams.get('path') === 'return-study.pdf') cancelledPreviews.push(row);
    else failedRequests.push(row);
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base && ['/api/web-search', '/api/ref-search'].includes(url.pathname)) {
      errors.push('Unexpected automatic web search'); return request.respond({ status: 200, contentType: 'application/json', body: '{"results":[]}' });
    }
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) { errors.push(`Unexpected external request: ${url.origin}${url.pathname}`); return request.abort(); }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    if (!/^https?:$/.test(location.protocol) || localStorage.getItem('agent-return-initialized')) return;
    localStorage.setItem('reader.locale', 'zh'); localStorage.setItem('reader.session.scopeMode', 'paper');
    localStorage.setItem('reader.session.onEnter', 'choose'); localStorage.setItem('reader.session.aiTitle', '0');
    localStorage.setItem('reader.agentRead', '0'); localStorage.setItem('agent-return-initialized', '1');
  });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && window.__state.papers.length === 1);
  await page.click('#homeAgent'); await navSettled();
  const firstLanding = await snapshot('first-landing');
  check('first entry has its dedicated empty landing page', firstLanding.landing && firstLanding.draft === '');
  await input('FIRST_LANDING_UNSENT_DRAFT'); await libraryAndBack();
  const landingReturn = await snapshot('landing-draft-return');
  check('an unsent landing draft survives Library navigation', landingReturn.landing
    && landingReturn.draft === 'FIRST_LANDING_UNSENT_DRAFT' && landingReturn.sid === firstLanding.sid);
  await choose('return-primary');
  const initial = await snapshot('initial-sidebar-open');
  check('sidebar opens the saved conversation without copying its question into composer', initial.sid === 'return-primary'
    && initial.text.includes('SAVED_ANSWER_PRIMARY') && initial.draft === '' && !initial.landing);
  await startStream('LIVE_QUESTION_PRIMARY: discuss navigation continuity');
  await input('UNSENT_DRAFT_PRIMARY');
  await libraryAndBack();
  const returned = await snapshot('return-while-streaming');
  check('Library return restores the generating conversation instead of the landing page', returned.sid === 'return-primary'
    && !returned.landing && returned.text.includes('LIVE_STREAM_1_START') && returned.busy && returned.jobs.length === 1);
  check('Library return preserves the unsent draft rather than restoring an old question', returned.draft === 'UNSENT_DRAFT_PRIMARY');
  await choose('return-primary');
  const current = await snapshot('same-sidebar-while-streaming');
  check('clicking the generating sidebar conversation restores its live answer', current.sid === 'return-primary'
    && !current.landing && current.text.includes('LIVE_STREAM_1_START') && current.draft === 'UNSENT_DRAFT_PRIMARY');
  await choose('return-secondary');
  const secondary = await snapshot('other-sidebar-while-streaming');
  check('another sidebar conversation opens while the first continues in background', secondary.sid === 'return-secondary'
    && secondary.text.includes('SAVED_ANSWER_SECONDARY') && !secondary.text.includes('LIVE_QUESTION_PRIMARY')
    && secondary.draft === '' && !secondary.busy && secondary.jobs.length === 1);
  await input('UNSENT_DRAFT_SECONDARY'); await finishStream();
  const background = await snapshot('background-finished');
  check('background completion leaves the selected conversation and its draft untouched', background.sid === 'return-secondary'
    && background.text.includes('SAVED_ANSWER_SECONDARY') && !background.text.includes('LIVE_STREAM_1_FINISHED')
    && background.draft === 'UNSENT_DRAFT_SECONDARY');
  await choose('return-primary');
  const finished = await snapshot('sidebar-restores-completed');
  check('sidebar restores the completed answer and the first conversation draft', finished.sid === 'return-primary'
    && finished.text.includes('LIVE_STREAM_1_FINISHED') && finished.draft === 'UNSENT_DRAFT_PRIMARY');
  await libraryAndBack();
  const after = await snapshot('return-after-finished');
  check('Library return also preserves a completed conversation and its draft', !after.landing && after.sid === 'return-primary'
    && after.text.includes('LIVE_STREAM_1_FINISHED') && after.draft === 'UNSENT_DRAFT_PRIMARY');
  await page.click('#agentNavNew'); await navSettled();
  const fresh = await snapshot('explicit-new');
  check('explicit new conversation opens the landing page with a separate empty composer', fresh.landing && fresh.draft === '');
  await input('UNSENT_NEW_CONVERSATION'); await choose('return-secondary');
  const secondAgain = await snapshot('secondary-after-new');
  check('returning from new conversation retains the second independent draft', secondAgain.sid === 'return-secondary'
    && secondAgain.text.includes('SAVED_ANSWER_SECONDARY') && secondAgain.draft === 'UNSENT_DRAFT_SECONDARY');
  await choose('return-primary'); await startStream('LIVE_QUESTION_SECOND: finish while Library is visible');
  await page.click('#homeBtn'); await page.waitForSelector('#home', { visible: true }); await finishStream();
  await page.click('#homeAgent'); await navSettled();
  const libraryFinished = await snapshot('finished-in-library');
  check('a generation completed in Library reopens as its completed conversation', libraryFinished.sid === 'return-primary'
    && !libraryFinished.landing && libraryFinished.text.includes('LIVE_STREAM_2_FINISHED') && !libraryFinished.busy);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  const saved = await json(sessionUrl('return-primary'));
  check('both generated answers persist once with no pending remnants', saved.entries.filter(row => row.kind === 'assistant'
    && row.text?.includes('LIVE_STREAM_')).length === 2 && !saved.entries.some(row => row.status === 'pending') && modelRequests.length === 2);
  await input('PRIMARY_DRAFT_BEFORE_NEW_SEND');
  await page.click('#agentNavNew'); await navSettled();
  await startStream('NEW_CONVERSATION_QUESTION: independent new conversation');
  const newSid = await page.evaluate(() => window.__ctx.activeSession);
  check('sending from the explicit new page uses its own conversation', newSid !== 'return-primary' && newSid !== 'return-secondary');
  await page.click('#agentNavNew'); await navSettled();
  const newDuringStream = await snapshot('new-page-during-generation');
  check('explicit new remains available while its previous conversation generates', newDuringStream.landing
    && newDuringStream.sid !== newSid && newDuringStream.draft === '' && !newDuringStream.busy
    && newDuringStream.jobs.length === 1 && newDuringStream.jobs[0].sid === newSid);
  await choose('return-primary');
  const oldDuringNew = await snapshot('old-draft-during-new-generation');
  check('new conversation generation does not replace the previous conversation draft', oldDuringNew.sid === 'return-primary'
    && oldDuringNew.draft === 'PRIMARY_DRAFT_BEFORE_NEW_SEND' && oldDuringNew.text.includes('LIVE_STREAM_2_FINISHED')
    && !oldDuringNew.text.includes('NEW_CONVERSATION_QUESTION') && oldDuringNew.jobs.length === 1);
  await finishStream(); await choose(newSid);
  const newCompleted = await snapshot('new-conversation-completed');
  check('new conversation opens its completed history without resurrecting its sent question', newCompleted.sid === newSid
    && newCompleted.text.includes('LIVE_STREAM_3_FINISHED') && newCompleted.draft === '' && !newCompleted.landing);
  await choose('return-primary');
  check('the previous conversation draft survives a complete new-conversation round trip',
    await page.$eval('#chatInput', node => node.value) === 'PRIMARY_DRAFT_BEFORE_NEW_SEND');
  check('navigation has no browser errors or unexpected failed requests', errors.length === 0 && failedRequests.length === 0,
    [...errors, ...failedRequests.map(row => `${row.error}: ${row.url}`)].join('\n'));
  await page.screenshot({ path: path.join(scratch, 'return-complete.png') });
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify(report(), null, 2), 'utf8');
  const failed = checks.filter(row => !row.ok);
  console.log(`agent-return: ${checks.length - failed.length}/${checks.length} passed; ${scratch}`);
  assert.equal(failed.length, 0, failed.map(row => row.label).join('\n'));
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  if (page) { await snapshot('failure').catch(() => {}); await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {}); }
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify(report(), null, 2), 'utf8');
  console.error(`Failure evidence: ${scratch}`); throw error;
} finally {
  heldResponse?.end('data: [DONE]\n\n');
  await browser?.close(); await stopChild(reader);
  upstream.closeAllConnections?.(); await new Promise(resolve => upstream.close(resolve));
}
