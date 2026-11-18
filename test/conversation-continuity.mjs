/** Conversation continuity across the global workspace, paper handoff and reload.
 * node test/conversation-continuity.mjs [--desktop]
 * Uses disposable storage, a synthetic PDF and a local fake model only.
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
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find(file => file && fs.existsSync(file));
assert.ok(executablePath, 'a Chromium browser is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `conversation-continuity-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data'));
const papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
writeTitlePdf(path.join(papersDir, 'DeiT.pdf'), { title: 'DeiT - Data-efficient Image Transformers' });
writeTitlePdf(path.join(papersDir, 'second-study.pdf'), { title: 'Second Study - Independent Selection' });
const firstQuestion = 'DeiT 的蒸馏 token 怎么从教师模型学习？';
const firstAnswer = 'DEIT_ORIGINAL_ANSWER：蒸馏 token 用 CNN 教师给出的目标计算蒸馏损失。';
const sid = 'deit-continuity-global';
const checks = [], errors = [], failedRequests = [], modelRequests = [], webRequests = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const check = (label, condition, detail = '') => {
  checks.push({ label, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
};
const textOf = content => typeof content === 'string' ? content : (content || []).map(part => part.text || '').join('\n');
let reader, browser, page, base;
let currentTurn = { id: 0, mode: 'direct', answer: '' };
const emit = (res, delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(textOf(body.messages?.[0]?.content))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    const turn = { ...currentTurn };
    modelRequests.push({ turn: turn.id, body });
    if (turn.mode === 'unsupported' && body.tools?.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tools unsupported by this synthetic model' } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (turn.mode === 'search' && body.tools?.length && !body.messages.some(row => row.role === 'tool')) {
      emit(res, { tool_calls: [{ index: 0, id: `deit-search-${turn.id}`, function: {
        name: 'search_web', arguments: JSON.stringify({ query: 'DeiT distillation teacher evidence' }),
      } }] });
      emit(res, {}, 'tool_calls');
    } else {
      emit(res, { content: turn.answer });
      emit(res, {}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(`Fake model: ${error.message}`);
    res.writeHead(500); res.end('fake model failure');
  }
});
async function json(route, body) {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${route}: ${response.status}`);
  return response.json();
}
const sessionUrl = `/api/session?${new URLSearchParams({ doc: 'default', sid })}`;
const settled = () => page.waitForFunction(() => document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true');
async function resumeGlobal() {
  await page.evaluate(() => window.__ctx.openAgentWorkspace());
  await page.waitForSelector('body.agent-full #rightSide', { visible: true });
  await settled();
  await page.click('#agentHistory');
  const selector = `#sessHistory .sess-hrow[data-sid="${sid}"] .sess-hgo`;
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector);
  await page.waitForFunction(sid => window.__ctx.activeSession === sid
    && document.querySelector('#aiArea').textContent.includes('DEIT_ORIGINAL_ANSWER'), {}, sid);
  await settled();
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.all(document.querySelector('#composer').getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}
async function send(question, { mode = 'direct', answer = '继续讨论 DeiT 的蒸馏 token。' } = {}) {
  currentTurn = { id: currentTurn.id + 1, mode, answer: `CONTINUITY_REPLY_${currentTurn.id + 1}：${answer}` };
  const turn = { ...currentTurn };
  await page.$eval('#chatInput', (input, text) => {
    input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
  }, question);
  await page.click('#sendBtn');
  await page.waitForFunction(answer => !window.__state.busy
    && document.querySelector('#aiArea').textContent.includes(answer), { timeout: 30000 }, turn.answer);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  return { ...turn, requests: modelRequests.filter(row => row.turn === turn.id).map(row => row.body),
    searches: webRequests.filter(row => row.turn === turn.id) };
}
const lastUser = body => textOf([...body.messages].reverse().find(row => row.role === 'user')?.content);
const focus = () => page.evaluate(() => [...window.__state.history].reverse().find(row => row.role === 'user')?.focus);
const report = () => ({ mode: desktop ? 'desktop' : 'node', checks, errors, failedRequests, webRequests, modelRequests });

try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('conversation-continuity').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  for (const stream of [reader.stdout, reader.stderr]) stream?.on('data', chunk => fs.appendFileSync(path.join(scratch, 'server.log'), chunk));
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* starting */ }
    if (!ready) await wait(100);
  }
  assert.ok(ready, 'isolated reader starts');
  const listing = await json('/api/papers');
  assert.equal(path.resolve(listing.dir), path.resolve(papersDir), 'server owns only disposable papers');
  const paper = listing.papers.find(row => row.name === 'DeiT.pdf');
  const secondPaper = listing.papers.find(row => row.name === 'second-study.pdf');
  assert.ok(paper && secondPaper);
  for (const asset of ['js/app.js', 'js/reading-context.js', 'js/ai.js', 'js/paper-target.js', 'js/prompts/capabilities/qa.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(res => res.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `${asset} serves the current source/build`);
  }
  check('isolated service serves current conversation code', true);
  await json('/api/config', { baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'continuity-synthetic', apiKey: 'SYNTHETIC_CONTINUITY_KEY' });
  const originalFocus = { text: firstQuestion, page: 1, kind: 'question', source: '',
    document: { docId: paper.docId, name: paper.name, path: paper.path, page: 1 } };
  await json(sessionUrl, { title: 'DeiT discussion', titleSource: 'user', createdAt: Date.now(), updatedAt: Date.now(),
    docIds: [paper.docId], entries: [
      { id: 'deit-original-question', block: 'chat', kind: 'user', tag: '提问', text: firstQuestion, status: 'user' },
      { id: 'deit-original-answer', block: 'chat', kind: 'assistant', tag: '问答', text: firstAnswer, status: 'complete' },
    ], history: [{ role: 'user', content: firstQuestion, focus: originalFocus }, { role: 'assistant', content: firstAnswer }], ops: [] });
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  page = await browser.newPage();
  await page.setViewport({ width: 1450, height: 950 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('dialog', dialog => { void dialog.accept(); });
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base && ['/api/web-search', '/api/ref-search'].includes(url.pathname)) {
      const query = url.searchParams.get('q') || '';
      webRequests.push({ turn: currentTurn.id, query, path: url.pathname,
        modelCalls: modelRequests.filter(row => row.turn === currentTurn.id).length });
      const result = /\bOK\b/i.test(query) ? {
        title: 'OK meaning dictionary', url: 'https://example.invalid/ok-definition',
        snippet: 'OK_SYNTHETIC_DEFINITION: OK is an expression of agreement or acceptance.',
      } : {
        title: 'DeiT distillation teacher evidence', url: 'https://example.invalid/deit-distillation',
        snippet: 'DEIT_SYNTHETIC_WEB_EVIDENCE: DeiT distillation uses a teacher target.',
      };
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [result] }) });
    }
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) {
      errors.push(`Unexpected external browser request: ${url.origin}${url.pathname}`);
      return request.abort();
    }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    if (!/^https?:$/.test(location.protocol)) return;
    if (localStorage.getItem('continuity-initialized')) return;
    localStorage.setItem('reader.locale', 'zh');
    localStorage.setItem('reader.session.scopeMode', 'paper');
    localStorage.setItem('reader.session.onEnter', 'choose');
    localStorage.setItem('reader.session.aiTitle', '0');
    localStorage.setItem('reader.agentRead', '1');
    localStorage.setItem('continuity-initialized', '1');
  });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && window.__state.papers.length === 2);
  await resumeGlobal();
  const beforeHandoff = await page.evaluate(() => JSON.stringify(window.__state.history));
  await page.click('#agentPapersToggle');
  await page.waitForSelector('#agentPaperPicker', { visible: true });
  await page.click(`.agent-paper-row[data-agent-paper=${JSON.stringify(paper.path || paper.docId)}]`);
  await page.waitForFunction(id => window.__viewer?.pdf && window.__state.viewerDocId === id
    && document.body.classList.contains('agent-docked'), {}, paper.docId);
  await page.waitForSelector('#agentHandoff', { visible: true });
  await page.waitForFunction(() => !document.querySelector('#agentContinue').disabled);
  await page.click('#agentContinue'); await settled();
  check('paper picker handoff retains the global session and its history', await page.evaluate(({ sid, beforeHandoff }) =>
    window.__ctx.activeSession === sid && window.__ctx.agentWorkspaceState().scope === 'default'
    && JSON.stringify(window.__state.history) === beforeHandoff, { sid, beforeHandoff }));
  await page.evaluate(() => { window.__ctx.setScopeRange('web'); window.__ctx.setAgentRead(true); });
  const marks = [];
  for (const question of ['？', '？', 'ok']) {
    const turn = await send(question); marks.push(turn);
    check(`${question} turn ${turn.id} reaches the model without automatic web search`, turn.searches.length === 0, JSON.stringify(turn.searches));
    check(`${question} turn ${turn.id} preserves the DeiT topic and source document`, (await focus())?.text === firstQuestion && (await focus())?.document?.docId === paper.docId);
    check(`${question} turn ${turn.id} carries inherited topic into its current prompt`, lastUser(turn.requests[0]).includes(firstQuestion)
      && /当前话题|上一轮话题/.test(lastUser(turn.requests[0])));
  }
  const okBody = marks.at(-1).requests[0];
  const recent = okBody.messages.filter(row => row.role !== 'system').slice(0, -1);
  check('ok receives the complete recent six-message discussion', recent.length === 6
    && textOf(recent[0].content).includes(firstQuestion) && textOf(recent[1].content).includes(firstAnswer)
    && textOf(recent[3].content).includes(marks[0].answer) && textOf(recent[5].content).includes(marks[1].answer));
  check('short replies are answered once with tools still available', marks.every(turn => turn.requests.length === 1
    && turn.requests[0].tools?.some(tool => tool.function?.name === 'search_web')));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && window.__state.papers.length === 2);
  await resumeGlobal();
  await page.evaluate(() => { window.__ctx.setScopeRange('web'); window.__ctx.setAgentRead(true); });
  const reloaded = await send('好的');
  check('reloading and reopening retains the topic for an acknowledgment', (await focus())?.text === firstQuestion
    && lastUser(reloaded.requests[0]).includes(firstQuestion) && reloaded.searches.length === 0);
  check('reopened global conversation carries the preceding answer', reloaded.requests[0].messages.some(row => row.role === 'assistant'
    && textOf(row.content).includes(marks.at(-1).answer)));
  const selected = await send('请查证这个教师监督的来源。', { mode: 'search' });
  check('model-selected search runs exactly its explicit query', selected.searches.length === 1
    && selected.searches[0].query === 'DeiT distillation teacher evidence', JSON.stringify(selected.searches));
  check('search results return to the model as a tool result', selected.requests.length === 2
    && selected.requests[1].messages.some(row => row.role === 'tool' && textOf(row.content).includes('DEIT_SYNTHETIC_WEB_EVIDENCE')));
  // Exercise the legacy pre-search branch with a visible, bound PDF as well;
  // an unbound full global workspace does not meet that branch's docId gate.
  await page.click('#agentPapersToggle');
  await page.waitForSelector('#agentPaperPicker', { visible: true });
  await page.click(`.agent-paper-row[data-agent-paper=${JSON.stringify(paper.path || paper.docId)}]`);
  await page.waitForFunction(id => window.__state.viewerDocId === id && document.body.classList.contains('agent-docked'), {}, paper.docId);
  await page.waitForSelector('#agentHandoff', { visible: true });
  await page.waitForFunction(() => !document.querySelector('#agentContinue').disabled);
  await page.click('#agentContinue'); await settled();
  await page.evaluate(() => { window.__ctx.setScopeRange('web'); window.__ctx.setAgentRead(false); });
  const fallback = await send('ok');
  check('agent-disabled acknowledgment does not pre-search', fallback.searches.length === 0, JSON.stringify(fallback.searches));
  check('agent-disabled acknowledgment preserves its current conversation topic', (await focus())?.text === '请查证这个教师监督的来源。'
    && lastUser(fallback.requests[0]).includes('请查证这个教师监督的来源。'));
  const definition = await send('OK 是什么意思？', { answer: '这里明确询问单词 OK 的含义。' });
  check('an explicit OK definition remains a new question', (await focus())?.text === 'OK 是什么意思？'
    && lastUser(definition.requests[0]).includes('OK 是什么意思？'));
  check('agent-disabled explicit definition may still use web search', definition.searches.some(row => /\bOK\b/i.test(row.query)));

  await page.evaluate(() => window.__ctx.setAgentRead(true));
  const unsupportedDefinition = await send('OK 是什么意思？', { mode: 'unsupported', answer: '工具不可用时仍可解释明确的词义问题。' });
  check('unsupported tools fall back to a normal model request', unsupportedDefinition.requests.some(body => body.tools?.length)
    && unsupportedDefinition.requests.some(body => !body.tools?.length));
  check('unsupported tools preserve explicit definition search after the failed model attempt', unsupportedDefinition.searches.length === 1
    && /\bOK\b/i.test(unsupportedDefinition.searches[0].query) && unsupportedDefinition.searches[0].modelCalls > 0,
  JSON.stringify(unsupportedDefinition.searches));
  check('fallback answer receives the actual synthetic definition source', lastUser(unsupportedDefinition.requests.at(-1)).includes('OK_SYNTHETIC_DEFINITION'));
  const unsupportedAck = await send('ok', { mode: 'unsupported' });
  check('unsupported tools acknowledgment still avoids automatic search', unsupportedAck.searches.length === 0
    && unsupportedAck.requests.some(body => body.tools?.length) && unsupportedAck.requests.some(body => !body.tools?.length));
  check('unsupported tools acknowledgment retains the preceding topic and answer', (await focus())?.text === 'OK 是什么意思？'
    && unsupportedAck.requests.at(-1).messages.some(row => row.role === 'assistant' && textOf(row.content).includes(unsupportedDefinition.answer)));

  // Establish a real DeiT target immediately before changing the visible PDF.
  // A new selection must bind to that new PDF even when the text is only "？".
  const deitAnchor = await send(firstQuestion);
  assert.equal((await focus())?.document?.docId, paper.docId, 'previous turn is explicitly anchored in DeiT');
  await page.click('#agentExpand');
  await page.waitForSelector('body.agent-full #rightSide', { visible: true }); await settled();
  await page.click('#agentPapersToggle');
  await page.waitForSelector('#agentPaperPicker', { visible: true });
  await page.click(`.agent-paper-row[data-agent-paper=${JSON.stringify(secondPaper.path || secondPaper.docId)}]`);
  await page.waitForFunction(id => window.__state.viewerDocId === id && document.body.classList.contains('agent-docked'), {}, secondPaper.docId);
  await page.waitForSelector('#agentHandoff', { visible: true });
  await page.waitForFunction(() => !document.querySelector('#agentContinue').disabled);
  await page.click('#agentContinue'); await settled();
  const selectedText = 'SECOND_PAPER_SELECTION_ONLY: This new experiment measures independent attention blocks.';
  await page.evaluate(text => {
    window.__ctx.setScopeRange('web'); window.__ctx.setAgentRead(true);
    window.__ctx.addToChat({ cleanText: text, page: 1 });
  }, selectedText);
  const newSelection = await send('？', { answer: '根据第二份论文的新选区解释本轮问题。' });
  const newBody = newSelection.requests[0];
  check('fresh selection after changing PDF binds to the second document', (await focus())?.document?.docId === secondPaper.docId
    && textOf(newBody.messages[0].content).includes(`【本次目标文件】${secondPaper.path}`)
    && lastUser(newBody).includes(`【论文】${secondPaper.path}`));
  check('fresh selection text remains in the model prompt without automatic web search', lastUser(newBody).includes(selectedText)
    && newSelection.searches.length === 0);
  check('new attachment preserves the previous DeiT discussion in history', newBody.messages.some(row => row.role === 'user' && textOf(row.content).includes(firstQuestion))
    && newBody.messages.some(row => row.role === 'assistant' && textOf(row.content).includes(deitAnchor.answer)));
  check('second paper selection continues the same global conversation', await page.evaluate(sid => window.__ctx.activeSession === sid
    && window.__ctx.agentWorkspaceState().scope === 'default', sid));
  const saved = await json(sessionUrl);
  check('all replies persist in the original global conversation', saved.history.some(row => row.content === firstQuestion)
    && saved.history.some(row => row.content?.includes(newSelection.answer)));

  // Reopen a real saved retry record with the pre-fix "ok = question" schema.
  // The later second-paper conversation must not change this older turn's target.
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
  const legacySaved = await json(sessionUrl);
  const legacyEntry = legacySaved.entries.find(row => row.text === marks[2].answer);
  assert.ok(legacyEntry?.retry?.reading, 'the original acknowledgment has a durable retry payload');
  legacyEntry.retry.reading = { ...legacyEntry.retry.reading, intent: 'question', inherited: false,
    focus: { ...originalFocus, text: 'ok' } };
  for (const row of legacySaved.history) {
    if (row.entryId === legacyEntry.id && row.role === 'user') row.focus = { ...originalFocus, text: 'ok' };
  }
  await json(sessionUrl, legacySaved);
  assert.equal((await json(sessionUrl)).entries.find(row => row.id === legacyEntry.id).retry.reading.intent, 'question');
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && window.__state.papers.length === 2);
  await resumeGlobal();
  await page.evaluate(() => window.__ctx.setAgentRead(true));
  const entriesBeforeRetry = await page.evaluate(() => window.__state.sessionEntries.length);
  await page.evaluate(id => {
    const row = [...document.querySelectorAll('#aiArea .msg.assistant')].find(node => node.__sessionRecord?.id === id);
    const button = [...row.querySelectorAll('.acts button')].find(node => /重新生成|Regenerate/.test(node.textContent));
    if (!button) throw new Error('missing the saved reply regeneration button');
    button.dataset.continuityRetry = 'legacy';
  }, legacyEntry.id);
  currentTurn = { id: currentTurn.id + 1, mode: 'direct', answer: 'LEGACY_ACK_RETRY_FIXED' };
  await page.locator('[data-continuity-retry="legacy"]').click();
  await page.waitForFunction(({ id, answer }) => !window.__state.busy
    && window.__state.sessionEntries.find(row => row.id === id)?.text === answer, { timeout: 30000 },
  { id: legacyEntry.id, answer: currentTurn.answer });
  await page.evaluate(() => window.__ctx.saveSessionNow());
  const retryRequests = modelRequests.filter(row => row.turn === currentTurn.id).map(row => row.body);
  const retriedEntry = (await json(sessionUrl)).entries.find(row => row.id === legacyEntry.id);
  check('regenerating a legacy acknowledgment rebuilds its original inherited topic', retryRequests.length === 1
    && lastUser(retryRequests[0]).includes(firstQuestion) && retriedEntry.retry.reading.intent === 'acknowledgement'
    && retriedEntry.retry.reading.inherited && retriedEntry.retry.reading.focus.text === firstQuestion);
  check('legacy acknowledgment retry keeps its original paper and performs no automatic search',
    retriedEntry.retry.reading.focus.document?.docId === paper.docId
    && textOf(retryRequests[0].messages[0].content).includes(`【本次目标文件】${paper.path}`)
    && !webRequests.some(row => row.turn === currentTurn.id));
  check('legacy regeneration replaces its answer without adding conversation entries',
    await page.evaluate(() => window.__state.sessionEntries.length) === entriesBeforeRetry);
  check('no browser errors, failed requests or external network requests', errors.length === 0 && failedRequests.length === 0,
    [...errors, ...failedRequests.map(row => `${row.error}: ${row.url}`)].join('\n'));
  await page.screenshot({ path: path.join(scratch, 'continuity-complete.png') });
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify(report(), null, 2), 'utf8');
  const failed = checks.filter(row => !row.ok);
  console.log(`conversation-continuity: ${checks.length - failed.length}/${checks.length} passed; ${scratch}`);
  assert.equal(failed.length, 0, failed.map(row => row.label).join('\n'));
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify(report(), null, 2), 'utf8');
  if (page) {
    await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
    const state = await page.evaluate(() => ({ body: document.body.className, doc: window.__state?.doc,
      workspace: window.__ctx?.agentWorkspaceState(), history: window.__state?.history,
      text: document.querySelector('#rightSide')?.textContent })).catch(() => null);
    fs.writeFileSync(path.join(scratch, 'diagnostic.json'), JSON.stringify(state, null, 2), 'utf8');
  }
  console.error(`Failure evidence: ${scratch}`); throw error;
} finally {
  await browser?.close();
  await stopChild(reader);
  upstream.closeAllConnections?.();
  await new Promise(resolve => upstream.close(resolve));
}
