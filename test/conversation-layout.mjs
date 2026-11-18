/** Minimal translation chrome and shared chat layout. Isolated data + fake model only. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `conversation-layout-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'layout.pdf'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const errors = [], calls = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
  }
  calls.push(body);
  if (JSON.stringify(body.messages).includes('FAIL_LIVE')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Synthetic unavailable translation' } })); return;
  }
  const reply = 'Attention compares a query with the keys, then combines the values.\n\nThe weights determine which information contributes most.\n\n$$a = \\operatorname{softmax}(QK^T)V$$';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`);
});
let reader, browser, page, passed = 0;
const pass = label => { passed++; console.log(`PASS ${label}`); };
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('conversation-layout').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready, 'isolated service starts');
  const post = async (route, payload) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  };
  await post('/api/config', { baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'layout-mock', apiKey: 'SYNTHETIC_LAYOUT_KEY' });
  for (const file of ['style.css', 'js/app.js', 'agent-workspace.css', 'session-history.css']) {
    assert.equal(await fetch(`${base}/${file}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'));
  }
  pass('served frontend matches current source');
  const doc = (await fetch(`${base}/api/papers`).then(r => r.json())).papers[0];
  const route = `/api/session?doc=${encodeURIComponent(doc.docId)}&sid=__translate`;
  const entries = ['complete', 'failed', 'partial', 'pending', 'stopped'].map((kind, i) => ({
    id: kind, block: 'translate', tag: 'translation', kind: 'assistant', docId: doc.docId, page: 1,
    quote: `Original source ${kind}`, text: ['failed', 'pending'].includes(kind) ? '' : `Readable translation ${kind}.`,
    status: kind === 'partial' ? 'failed' : kind,
    retry: { kind: 'translate-text', docId: doc.docId, text: `Original source ${kind}`, targetLang: 'English',
      segments: [{ id: `segment-${i}`, kind: 'text', text: `Original source ${kind}`, page: 1, endPage: 1, pages: [1], docId: doc.docId }] },
  }));
  await post(route, { entries, history: [], ops: [] });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser'), defaultViewport: { width: 1500, height: 980 } });
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('requestfailed', req => { if (!req.failure()?.errorText.includes('ERR_ABORTED')) errors.push(req.failure()?.errorText); });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = new URL(req.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== base) { errors.push(`External browser request ${url.origin}`); return req.abort(); }
    return req.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'en');
    localStorage.setItem('reader.session.onEnter', 'latest');
    localStorage.setItem('reader.session.scopeMode', 'global');
  });
  await page.goto(`${base}/?open=layout.pdf`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state?.viewerDocId === window.__state?.doc?.docId);
  await page.evaluate(() => { window.__ctx.setPanelVisible('translate', true); window.__ctx.applyPanels(); });
  await page.waitForFunction(() => document.querySelectorAll('.msg-translation').length === 5);
  const restored = await page.evaluate(() => [...document.querySelectorAll('.msg-translation')].map(row => ({
    id: row.__sessionRecord.id, source: row.querySelector('.translation-source')?.textContent,
    notices: row.querySelectorAll('.entry-meta').length,
    body: row.querySelector('.text').textContent, opened: row.querySelector('details')?.open,
    visibleRole: !!row.querySelector('.role')?.getClientRects().length,
    resultFirst: [...row.children].indexOf(row.querySelector('.text')) < [...row.children].indexOf(row.querySelector('.translation-direction')),
    actions: [...row.querySelectorAll('.acts button')].map(button => ({ text: button.textContent, label: button.getAttribute('aria-label') || button.textContent })),
    footer: row.querySelector('.translation-direction')?.innerText,
  })));
  assert.ok(restored.every(row => !row.visibleRole && !row.opened && row.resultFirst));
  assert.ok(restored.every(row => row.source === `Original source ${row.id}`));
  assert.ok(restored.every(row => !/translated together|Text translation|Original →/.test(row.footer)));
  pass('results precede one compact footer; original text is intact and collapsed');
  for (const id of ['failed', 'partial', 'pending']) assert.equal(restored.find(row => row.id === id).notices, 1, id);
  assert.equal(restored.find(row => row.id === 'partial').body, 'Readable translation partial.');
  assert.equal(restored.find(row => row.id === 'complete').notices, 0);
  assert.ok(restored.find(row => row.id === 'complete').actions.every(action => !action.text && action.label));
  pass('restored interruptions have one notice and complete actions have accessible icons');
  await page.screenshot({ path: path.join(scratch, 'translation-restored.png') });
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.msg-translation')].find(row => row.__sessionRecord.id === 'complete');
    row.querySelector('summary').click();
    row.querySelector('.translation-locate').click();
  });
  assert.equal(await page.evaluate(() => window.__viewer.current), 1);
  pass('source disclosure and page navigation remain available');
  await page.evaluate(() => [...document.querySelectorAll('.msg-translation')].find(row => row.__sessionRecord.id === 'failed').querySelector('.acts button').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-translation')].some(row => row.__sessionRecord.text.startsWith('Attention compares')));
  assert.ok(JSON.stringify(calls.at(-1)).includes('Original source failed'));
  pass('retry sends the retained original and renders a successful result');
  await page.$eval('#chatInput', input => { input.value = 'FAIL_LIVE'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#sendBtn');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-translation')].some(row => row.__sessionRecord.retry?.text === 'FAIL_LIVE' && row.__sessionRecord.status === 'failed'));
  const failure = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.msg-translation')].find(row => row.__sessionRecord.retry?.text === 'FAIL_LIVE');
    return { notices: row.querySelectorAll('.entry-meta').length, streamErrors: row.querySelectorAll('.stream-error').length,
      source: row.querySelector('.translation-source').textContent, retry: row.querySelector('.acts button')?.textContent };
  });
  assert.deepEqual(failure, { notices: 1, streamErrors: 0, source: 'FAIL_LIVE', retry: 'Retry' });
  pass('live failure has one notice and one retry without duplicate stream error');
  await page.evaluate(() => window.__ctx.saveSessionNow());
  const saved = await fetch(base + route).then(r => r.json());
  for (const original of entries) {
    const record = saved.entries.find(row => row.id === original.id);
    assert.equal(record.text, original.text);
    assert.deepEqual(record.retry, original.retry);
  }
  pass('presentation cleanup preserves existing text and retry payloads on disk');
  await page.evaluate(() => window.__ctx.openAgentWorkspace());
  await page.waitForFunction(() => document.body.classList.contains('agent-landing'));
  await page.evaluate(() => { window.__ctx.setAgentRead(false); window.__ctx.setScopeRange('current'); });
  await page.type('#chatInput', 'Explain attention in a short example.');
  await page.click('#sendBtn');
  await page.waitForFunction(() => document.querySelector('[data-block="chat"] .msg.assistant .text')?.textContent.includes('Attention compares'));
  await wait(400);
  const chat = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    return { user: rect('[data-block="chat"] .msg.user'), answer: rect('[data-block="chat"] .msg.assistant'),
      math: document.querySelectorAll('[data-block="chat"] .katex').length,
      overflow: document.documentElement.scrollWidth > innerWidth + 1, landing: document.body.classList.contains('agent-landing') };
  });
  assert.ok(chat.user.left > chat.answer.left + 30 && chat.user.width < chat.answer.width);
  assert.ok(chat.math && !chat.overflow && !chat.landing);
  await page.screenshot({ path: path.join(scratch, 'chat-layout.png') });
  pass('chat uses a right-aligned question and open answer layout with working math');
  await page.evaluate(() => window.__ctx.deleteSession(window.__ctx.activeSession, { confirm: false }));
  await page.waitForFunction(() => document.body.classList.contains('agent-landing'));
  assert.equal(await page.$eval('#aiArea', node => !!node.getClientRects().length), false);
  assert.equal(await page.$eval('#agentLanding', node => !!node.getClientRects().length), true);
  pass('deleting the active global conversation returns to the dedicated landing');
  assert.deepEqual(errors, []);
  pass('no browser errors or external browser requests');
  console.log(`Conversation layout: ${passed}/${passed} passed; ${scratch}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`CONVERSATION_LAYOUT_FAILURE ${scratch}`); throw error;
} finally {
  await browser?.close().catch(() => {});
  if (reader) await stopChild(reader);
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
