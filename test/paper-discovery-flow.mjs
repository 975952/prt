/** Isolated global-agent discovery, persistence and local-first network checks.
 * node test/paper-discovery-flow.mjs [--desktop]
 * Only generated PDFs, synthetic keys and an on-machine model are used. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `paper-discovery-flow-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
writeTitlePdf(path.join(papersDir, '2307.08691.pdf'), { title: 'FlashAttention Efficient Exact Attention' });
writeTitlePdf(path.join(papersDir, 'chemistry.pdf'), { title: 'Chemical Measurements and Laboratory Methods' });
writeTitlePdf(path.join(papersDir, 'unavailable.pdf'), { title: 'Unreadable research fixture' });
function imageOnlyPdf() {
  const content = '0.2 0.2 0.2 rg 60 600 450 12 re f\n60 570 430 12 re f\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(out)); out += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  return out + `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
fs.writeFileSync(path.join(papersDir, 'scan.pdf'), imageOnlyPdf(), 'utf8');
const checks = [], errors = [], apiRequests = [], modelRequests = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let reader, browser, page, base, listing;
let plannerCalls = 0;
function reply(res, body, message) {
  if (body.stream) {
    const delta = message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : { content: message.content };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] })); }
}
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const system = body.messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
    if (/PAPER_DISCOVERY_QUERY_PLAN/.test(system)) {
      if (body.messages.some(m => JSON.stringify(m.content).includes('CASE_MALFORMED'))) {
        plannerCalls++; reply(res, body, { content: '{broken planner JSON' }); return;
      }
      plannerCalls++; reply(res, body, { content: JSON.stringify({ query: '减少注意力显存开销的文章', keywords: ['FlashAttention', 'memory efficient attention'] }) }); return;
    }
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(system)) { reply(res, body, { content: '[]' }); return; }
    modelRequests.push(body);
    const markedUser = body.messages.findLastIndex(m => m.role === 'user' && /CASE_[A-Z_]+/.test(JSON.stringify(m.content)));
    const latestUser = markedUser >= 0 ? markedUser : body.messages.findLastIndex(m => m.role === 'user');
    const question = JSON.stringify(body.messages[latestUser]?.content || '');
    const marker = /CASE_([A-Z_]+)/.exec(question)?.[1] || 'UNMARKED';
    const toolResult = body.messages.slice(latestUser + 1).find(m => m.role === 'tool');
    if (marker === 'MULTI' && body.tools && !toolResult) {
      reply(res, body, { content: '', tool_calls: ['FlashAttention', 'Chemical Measurements'].map((query, index) => ({
        id: `discovery_MULTI_${index}`, type: 'function', function: { name: 'discover_papers',
          arguments: JSON.stringify({ query, keywords: [query] }) },
      })) }); return;
    }
    if (!['GENERIC', 'FALLBACK', 'MALFORMED'].includes(marker) && body.tools && !toolResult) {
      reply(res, body, { content: '', tool_calls: [{ id: `discovery_${marker}`, type: 'function',
        function: { name: 'discover_papers', arguments: JSON.stringify({
          query: marker === 'LOCAL' ? '减少注意力显存开销的文章' : 'quantum widget discovery',
          keywords: marker === 'LOCAL' ? ['FlashAttention', 'memory efficient attention'] : ['quantum widget'],
        }) } }] }); return;
    }
    reply(res, body, { content: `SYNTHETIC_DISCOVERY_REPLY_${marker}: 已根据本轮检索结果回答。` });
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
const json = async (route, body) => {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
};
const sessionUrl = (scope, sid) => `/api/session?${new URLSearchParams({ doc: scope, sid })}`;
const networkCount = () => apiRequests.filter(r => ['/api/ref-search', '/api/web-search'].includes(r.path)).length;
const settled = () => page.waitForFunction(() => !window.__state.busy && document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true');
const discovery = () => page.evaluate(() => [...window.__state.sessionEntries].reverse().find(entry => entry.discovery)?.discovery || null);
async function newPage(names, range = 'web', options = {}) {
  const context = await browser.createBrowserContext();
  const tab = await context.newPage(); page = tab;
  await tab.setViewport({ width: 1400, height: 940 }); tab.setDefaultTimeout(20000);
  tab.on('pageerror', error => errors.push(String(error)));
  tab.on('dialog', dialog => void dialog.accept());
  await tab.setRequestInterception(true);
  tab.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base && url.pathname.startsWith('/api/')) apiRequests.push({ path: url.pathname, query: url.search, page: names.join(',') });
    if (url.origin === base && url.pathname === '/api/papers') return request.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...listing, papers: listing.papers.filter(p => names.includes(p.name)) }) });
    if (url.origin === base && url.pathname === '/api/import-pdf' && options.importScenario) {
      const scenario = options.importScenario; scenario.attempts++;
      if (scenario.attempts === 1) return request.respond({ status: 503, contentType: 'application/json',
        body: '{"error":{"message":"Synthetic import temporarily unavailable"}}' });
      const name = 'imported-widget.pdf';
      writeTitlePdf(path.join(papersDir, name), { title: 'Quantum Widget Imported Preprint' });
      void json('/api/papers').then(updated => {
        listing = updated; if (!names.includes(name)) names.push(name);
        scenario.imported = listing.papers.find(paper => paper.name === name);
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...scenario.imported }) });
      }).catch(error => request.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: error.message } }) }));
      return;
    }
    if (url.origin === base && ['/api/web-search', '/api/ref-search'].includes(url.pathname)) {
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: url.searchParams.get('q'),
        provider: 'synthetic', status: 'ok', results: [
          { title: 'Quantum Widget Research', url: 'https://example.test/research/widget', source: 'OpenAlex', year: 2024,
            snippet: 'A synthetic topical result with a landing page only.' },
          { title: 'Quantum Widget Preprint', url: 'https://arxiv.org/abs/2401.12345', pdfUrl: 'https://arxiv.org/pdf/2401.12345',
            source: 'arXiv', year: 2024, snippet: 'A synthetic preprint with an explicit PDF URL.' },
        ] }) });
    }
    if (url.origin === base && url.pathname === '/api/pdf' && url.searchParams.get('path') === 'unavailable.pdf')
      return request.respond({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic unavailable PDF"}' });
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) {
      errors.push(`Unexpected external browser access: ${url.origin}${url.pathname}`); return request.abort();
    }
    return request.continue();
  });
  await tab.evaluateOnNewDocument(() => {
    if (!localStorage.getItem('discovery-flow-initialized')) {
      localStorage.setItem('reader.locale', 'zh-CN'); localStorage.setItem('reader.session.scopeMode', 'paper');
      localStorage.setItem('reader.session.onEnter', 'choose'); localStorage.setItem('reader.session.aiTitle', '0');
      localStorage.setItem('reader.agentRead', '1'); localStorage.setItem('discovery-flow-initialized', '1');
    }
  });
  await tab.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await tab.waitForFunction(count => !!window.__ctx && window.__state.papers.length === count, {}, names.length);
  await tab.click('#homeAgent'); await tab.waitForSelector('body.agent-full #rightSide', { visible: true });
  await settled(); await tab.evaluate(async range => { await window.__ctx.newSession({ silent: true }); window.__ctx.setScopeRange(range); }, range);
  await settled(); return tab;
}
async function send(marker, question = '请帮我找研究 quantum widget 的论文', finish = true) {
  await page.$eval('#chatInput', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, `${question} CASE_${marker}`);
  await page.click('#sendBtn');
  if (finish) {
    await page.waitForFunction(marker => !window.__state.busy && document.querySelector('#aiArea').textContent.includes(`SYNTHETIC_DISCOVERY_REPLY_${marker}`), {}, marker);
    await settled();
  }
}

try {
  await listen(upstream); const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('paper-discovery-flow').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready, 'isolated reader starts');
  listing = await json('/api/papers'); assert.equal(path.resolve(listing.dir), path.resolve(papersDir));
  for (const asset of ['js/app.js', 'js/agent.js', 'js/paper-discovery.js', 'js/paper-discovery-ui.js'])
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `${asset} current source`);
  await json('/api/config', { baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'discovery-flow-synthetic', apiKey: 'SYNTHETIC_DISCOVERY_KEY' });
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  pass('isolated reader serves current assets and uses a synthetic local model');

  await newPage(['2307.08691.pdf', 'chemistry.pdf']);
  const beforeLocal = networkCount();
  assert.ok(await page.evaluate(() => !window.__state.doc && !window.__viewer.pdf));
  await send('LOCAL', '帮我找减少注意力显存开销的论文');
  const local = await discovery(); assert.equal(local.local.status, 'matched');
  assert.ok(local.local.coverage.complete); assert.equal(local.local.matches[0].path, '2307.08691.pdf');
  assert.match(local.local.matches[0].snippet, /FlashAttention/); assert.equal(networkCount(), beforeLocal);
  await page.waitForSelector('.paper-discovery-card[data-paper-path="2307.08691.pdf"] .paper-discovery-primary', { visible: true });
  if (desktop) await page.screenshot({ path: path.join(scratch, 'discovery-local-full.png'), fullPage: true });
  const sourceSid = await page.evaluate(() => window.__ctx.activeSession);
  await page.locator('.paper-discovery-card[data-paper-path="2307.08691.pdf"] .paper-discovery-primary').click();
  await page.waitForFunction(() => !!window.__viewer.pdf && document.body.classList.contains('agent-docked'));
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), sourceSid);
  assert.equal(await page.evaluate(() => window.__ctx.agentWorkspaceState().scope), 'default');
  pass('no-PDF Chinese discovery uses English evidence and opens the local paper in the same docked chat without networking');

  await page.evaluate(() => window.__ctx.saveSessionNow());
  const saved = await json(sessionUrl('default', sourceSid));
  assert.ok(saved.entries.some(entry => entry.discovery?.local.matches[0]?.path === '2307.08691.pdf'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !!window.__ctx);
  await page.click('#agentBtn'); await page.waitForSelector('body.agent-full #rightSide', { visible: true });
  await settled(); await page.evaluate(sid => window.__ctx.switchSession(sid, { force: true }), sourceSid);
  await page.waitForSelector('.paper-discovery-card[data-paper-path="2307.08691.pdf"]', { visible: true });
  pass('structured discovery cards survive real session save and page reload');
  const target = listing.papers.find(p => p.name === 'chemistry.pdf');
  await page.click('#sessBtn'); await page.waitForSelector('#sessQuickMove', { visible: true }); await page.click('#sessQuickMove');
  await page.waitForSelector('#sessMovePanel', { visible: true }); await page.waitForFunction(() => !document.querySelector('#sessMoveMode').disabled);
  await page.select('#sessMoveMode', 'paper'); await page.select('#sessMoveTarget', target.docId);
  await page.waitForFunction(() => !document.querySelector('#sessMoveSubmit').disabled); await page.click('#sessMoveSubmit');
  await page.waitForFunction(docId => window.__ctx.agentWorkspaceState().scope === docId && !document.querySelector('#sessMoveLayer').getClientRects().length, {}, target.docId);
  const movedSid = await page.evaluate(() => window.__ctx.activeSession), moved = await json(sessionUrl(target.docId, movedSid));
  assert.ok(moved.entries.some(entry => entry.discovery?.local.matches[0]?.path === '2307.08691.pdf'));
  await page.waitForSelector('.paper-discovery-card[data-paper-path="2307.08691.pdf"]', { visible: true });
  pass('moving the conversation preserves its original paper-discovery cards');

  await newPage(['2307.08691.pdf', 'chemistry.pdf']);
  await send('LOCAL', '帮我找减少注意力显存开销的论文');
  await page.evaluate(() => {
    const nativeFetch = window.fetch; let held = false;
    window.__lateOpenButton = document.querySelector('.paper-discovery-primary');
    window.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!held && url.pathname === '/api/papers') {
        held = true; window.__lateOpenRefreshStarted = true;
        return new Promise(resolve => { window.__releaseLateOpenRefresh = () => {
          window.fetch = nativeFetch; resolve(nativeFetch(input, options));
        }; });
      }
      return nativeFetch(input, options);
    };
  });
  await page.locator('.paper-discovery-card[data-paper-path="2307.08691.pdf"] .paper-discovery-primary').click();
  await page.waitForFunction(() => window.__lateOpenRefreshStarted);
  await page.evaluate(() => window.__ctx.newSession({ silent: true }));
  await settled();
  const switchedSid = await page.evaluate(() => window.__ctx.activeSession);
  await page.$eval('#chatInput', input => { input.value = '新会话的草稿保持原处'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => window.__releaseLateOpenRefresh());
  await page.waitForFunction(() => !window.__lateOpenButton.disabled);
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), switchedSid);
  assert.equal(await page.evaluate(() => window.__ctx.agentWorkspaceState().view), 'full');
  assert.ok(await page.evaluate(() => !window.__state.doc && !window.__viewer.pdf));
  assert.equal(await page.$eval('#chatInput', input => input.value), '新会话的草稿保持原处');
  pass('a delayed local-card refresh cannot navigate or change drafts after switching conversation');

  await newPage(['chemistry.pdf']); const beforeOnline = networkCount();
  await send('ONLINE'); const online = await discovery();
  assert.equal(online.local.status, 'not_found'); assert.ok(online.local.coverage.complete);
  assert.ok(networkCount() > beforeOnline); assert.ok(online.online.results.length >= 1);
  const firstNetwork = apiRequests.findIndex((r, index) => index >= 0 && r.page === 'chemistry.pdf' && ['/api/ref-search', '/api/web-search'].includes(r.path));
  assert.ok(apiRequests.slice(0, firstNetwork).some(r => r.page === 'chemistry.pdf' && r.path === '/api/pdf'), 'PDF checked before online discovery');
  const landingCard = await page.$$eval('.paper-discovery-card', cards => cards.find(card => card.textContent.includes('Quantum Widget Research'))?.textContent || '');
  assert.ok(landingCard); assert.ok(!/导入书架|打开 PDF 链接/.test(landingCard));
  if (desktop) {
    await page.screenshot({ path: path.join(scratch, 'discovery-online-full.png'), fullPage: true });
    await page.setViewport({ width: 320, height: 940 });
    await page.screenshot({ path: path.join(scratch, 'discovery-online-narrow.png'), fullPage: true });
    await page.setViewport({ width: 1400, height: 940 });
  }
  pass('complete local miss allows online discovery while a landing-page result is never presented as a downloadable PDF');

  await newPage(['chemistry.pdf']);
  await page.evaluate(() => {
    const nativeFetch = window.fetch;
    window.__stoppedOnlineRequests = [];
    window.__restoreOnlineFetch = () => { window.fetch = nativeFetch; };
    window.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (['/api/ref-search', '/api/web-search'].includes(url.pathname)) {
        return new Promise(resolve => window.__stoppedOnlineRequests.push({ signal: options.signal,
          release: () => resolve(new Response(JSON.stringify({ status: 'ok', results: [{
            title: 'LATE_RESULT_MUST_NOT_APPEAR', url: 'https://example.test/late',
          }] }), { headers: { 'Content-Type': 'application/json' } })) }));
      }
      return nativeFetch(input, options);
    };
  });
  await send('ONLINE_STOP', undefined, false);
  await page.waitForFunction(() => window.__stoppedOnlineRequests.length === 2
    && window.__state.sessionEntries.some(entry => entry.discovery?.online.status === 'loading'));
  await page.waitForSelector('#stopBtn:not(.hidden)', { visible: true }); await page.click('#stopBtn'); await settled();
  assert.equal((await discovery()).online.status, 'failed');
  assert.ok(await page.evaluate(() => window.__stoppedOnlineRequests.every(request => request.signal.aborted)));
  await page.evaluate(() => { window.__stoppedOnlineRequests.forEach(request => request.release()); window.__restoreOnlineFetch(); });
  await wait(150);
  assert.equal((await discovery()).online.results.length, 0);
  assert.ok(!(await page.$eval('#aiArea', area => area.textContent)).includes('LATE_RESULT_MUST_NOT_APPEAR'));
  const stoppedSid = await page.evaluate(() => window.__ctx.activeSession);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  const stoppedSave = await json(sessionUrl('default', stoppedSid));
  assert.equal(stoppedSave.entries.find(entry => entry.discovery)?.discovery.online.status, 'failed');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !!window.__ctx);
  await page.click('#agentBtn'); await page.waitForSelector('body.agent-full #rightSide', { visible: true });
  await settled(); await page.evaluate(async sid => {
    const { sessionsHideEntryCard } = await import('/js/sessions.js');
    sessionsHideEntryCard(); await window.__ctx.switchSession(sid, { force: true });
  }, stoppedSid);
  await page.waitForFunction(() => [...document.querySelectorAll('.paper-discovery-action')].some(button => button.textContent === '重试联网查找'));
  assert.equal((await discovery()).online.status, 'failed');
  assert.ok(!(await page.$eval('#aiArea', area => area.textContent)).includes('正在查找网络论文'));
  const beforeRetry = networkCount();
  await page.evaluate(() => [...document.querySelectorAll('.paper-discovery-action')].find(button => button.textContent === '重试联网查找').click());
  await page.waitForFunction(() => window.__state.sessionEntries.some(entry => entry.discovery?.online.results?.length));
  assert.ok(networkCount() > beforeRetry);
  pass('stopped automatic online discovery persists a retryable card after reload and ignores late results');

  for (const [name, marker] of [['scan.pdf', 'SCAN'], ['unavailable.pdf', 'ERROR']]) {
    await newPage([name]); const before = networkCount(); await send(marker); const found = await discovery();
    assert.equal(found.local.status, 'incomplete'); assert.equal(found.local.coverage.complete, false);
    assert.equal(networkCount(), before); assert.ok(found.local.coverage.unreadable >= 1);
    if (marker === 'SCAN') {
      await page.locator('.paper-discovery-footer .paper-discovery-action').click();
      await page.waitForFunction(() => [...window.__state.sessionEntries].some(entry => entry.discovery?.online.results?.length));
      assert.ok(networkCount() > before);
    }
    pass(`${marker.toLowerCase()} coverage blocks automatic networking${marker === 'SCAN' ? ' but explicit continue can search' : ''}`);
  }

  await newPage(['chemistry.pdf'], 'current'); const beforeBlocked = networkCount(); await send('BLOCKED');
  assert.equal(networkCount(), beforeBlocked); assert.equal((await discovery()).local.coverage.complete, true);
  assert.equal(await page.evaluate(() => window.__ctx.scopeRange), 'current');
  pass('the current send scope disables automatic online lookup');

  await newPage(['2307.08691.pdf']); const beforeFallback = networkCount(), plansBefore = plannerCalls;
  await send('FALLBACK', '帮我找能减少注意力显存开销的论文');
  assert.ok(plannerCalls > plansBefore); assert.equal((await discovery()).local.matches[0].path, '2307.08691.pdf');
  assert.equal(networkCount(), beforeFallback); pass('explicit discovery falls back to model keyword planning when tools are ignored');

  await newPage(['chemistry.pdf']); const beforeMalformed = networkCount(), malformedPlans = plannerCalls;
  await send('MALFORMED', '帮我找关于量子器件耦合机制的论文');
  const malformed = await discovery();
  assert.ok(plannerCalls > malformedPlans); assert.equal(malformed.local.status, 'incomplete');
  assert.ok(malformed.local.error); assert.equal(malformed.local.matches.length, 0);
  assert.equal(networkCount(), beforeMalformed);
  pass('a malformed keyword plan cannot convert a raw-sentence local miss into automatic online discovery');

  await newPage(['2307.08691.pdf', 'chemistry.pdf']); const beforeMulti = networkCount();
  await send('MULTI', '帮我分别找注意力和化学测量相关论文');
  const grouped = await page.evaluate(() => window.__state.sessionEntries.find(entry => entry.discoveries?.length)?.discoveries);
  assert.deepEqual(grouped.map(row => row.query).sort(), ['Chemical Measurements', 'FlashAttention']);
  assert.deepEqual(grouped.flatMap(row => row.local.matches.map(match => match.path)).sort(), ['2307.08691.pdf', 'chemistry.pdf']);
  assert.equal(await page.$$eval('.paper-discovery', nodes => nodes.length), 2); assert.equal(networkCount(), beforeMulti);
  const multiSid = await page.evaluate(() => window.__ctx.activeSession);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  const multiSaved = await json(sessionUrl('default', multiSid));
  assert.equal(multiSaved.entries.find(entry => entry.discoveries?.length).discoveries.length, 2);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !!window.__ctx);
  await page.click('#agentBtn'); await page.waitForSelector('body.agent-full #rightSide', { visible: true });
  await settled(); await page.evaluate(async sid => {
    const { sessionsHideEntryCard } = await import('/js/sessions.js'); sessionsHideEntryCard();
    await window.__ctx.switchSession(sid, { force: true });
  }, multiSid);
  await page.waitForFunction(() => document.querySelectorAll('.paper-discovery').length === 2);
  assert.equal(await page.$$eval('.paper-discovery-card[data-paper-path="2307.08691.pdf"], .paper-discovery-card[data-paper-path="chemistry.pdf"]', nodes => nodes.length), 2);
  pass('two discovery calls in one round preserve both result groups through save and reload');

  const importScenario = { attempts: 0 };
  await newPage(['chemistry.pdf'], 'web', { importScenario }); await send('IMPORT');
  const importSid = await page.evaluate(() => window.__ctx.activeSession);
  const importButton = '.paper-discovery-card button.paper-discovery-action';
  await page.waitForSelector(importButton, { visible: true }); await page.locator(importButton).click();
  await page.waitForSelector('.paper-discovery-card .paper-discovery-error', { visible: true });
  assert.equal(importScenario.attempts, 1); assert.equal((await discovery()).online.results.filter(row => row.pdfUrl).length, 1);
  assert.equal(await page.$eval(importButton, button => button.disabled), false);
  await page.locator(importButton).click();
  await page.waitForSelector('.paper-discovery-card[data-paper-path="imported-widget.pdf"] .paper-discovery-primary', { visible: true });
  assert.equal(importScenario.attempts, 2); assert.ok(importScenario.imported);
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), importSid);
  assert.ok(await page.evaluate(() => !window.__viewer.pdf && document.body.classList.contains('agent-full')));
  assert.ok(await page.evaluate(() => window.__state.papers.some(paper => paper.path === 'imported-widget.pdf')));
  const imported = await discovery(); assert.equal(imported.local.matches[0].path, 'imported-widget.pdf');
  assert.equal(imported.online.results.filter(row => row.pdfUrl).length, 0);
  assert.equal(await page.$$eval('.paper-discovery-card button.paper-discovery-action', nodes => nodes.filter(node => node.textContent.includes('导入书架')).length), 0);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !!window.__ctx);
  await page.click('#agentBtn'); await page.waitForSelector('body.agent-full #rightSide', { visible: true });
  await settled(); await page.evaluate(async sid => {
    const { sessionsHideEntryCard } = await import('/js/sessions.js'); sessionsHideEntryCard();
    await window.__ctx.switchSession(sid, { force: true });
  }, importSid);
  await page.waitForSelector('.paper-discovery-card[data-paper-path="imported-widget.pdf"] .paper-discovery-primary', { visible: true });
  await page.locator('.paper-discovery-card[data-paper-path="imported-widget.pdf"] .paper-discovery-primary').click();
  await page.waitForFunction(docId => !!window.__viewer.pdf && window.__state.viewerDocId === docId
    && document.body.classList.contains('agent-docked'), {}, importScenario.imported.docId);
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), importSid);
  pass('failed import remains retryable; successful import adds a persistent local card without automatic navigation or duplicate import');

  await newPage(['chemistry.pdf']); const beforeTimeout = networkCount();
  const timed = await page.evaluate(async () => {
    const { paperAccess } = await import('/js/pdfview.js'); const original = paperAccess.search;
    paperAccess.search = () => new Promise(() => {});
    try { return await window.__ctx.discoverPapers('quantum widget', ['quantum widget'], { useWeb: true, timeBudgetMs: 25 }); }
    finally { paperAccess.search = original; }
  });
  assert.equal(timed.local.coverage.complete, false); assert.equal(networkCount(), beforeTimeout);
  pass('an actual discovery deadline cannot trigger late online fallback');

  await page.evaluate(async () => {
    const { paperAccess } = await import('/js/pdfview.js'); window.__originalDiscoverySearch = paperAccess.search;
    paperAccess.search = (url, query, options) => new Promise(resolve => {
      window.__discoverySearchStarted = true; window.__discoverySignal = options.signal;
      window.__releaseDiscoverySearch = () => resolve({ numPages: 1, scanned: 1, complete: true, truncated: false, hits: [] });
    });
  });
  const beforeStop = networkCount(); await send('STOP', undefined, false);
  await page.waitForFunction(() => window.__discoverySearchStarted); await page.waitForSelector('#stopBtn:not(.hidden)', { visible: true });
  await page.click('#stopBtn'); await settled();
  assert.ok(await page.evaluate(() => window.__discoverySignal.aborted));
  await page.evaluate(async () => { window.__releaseDiscoverySearch(); const { paperAccess } = await import('/js/pdfview.js'); paperAccess.search = window.__originalDiscoverySearch; });
  await wait(150); assert.equal(networkCount(), beforeStop);
  pass('stopping discovery aborts its extraction and ignores late completion without networking');

  await newPage(['chemistry.pdf']); const beforeGeneric = networkCount();
  await send('GENERIC', '解释一下栈和队列的区别');
  assert.equal(await discovery(), null); assert.equal(networkCount(), beforeGeneric);
  pass('general no-PDF conversation does not force paper or online discovery');
  assert.deepEqual(errors, []); pass('no uncaught browser errors or real external service requests');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktop ? 'desktop' : 'node', checks, errors,
    apiRequests, modelRequests: modelRequests.length, plannerCalls }, null, 2), 'utf8');
  console.log(`paper-discovery-flow: ${checks.length}/${checks.length} passed; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  if (page) {
    await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
    const diagnostic = await page.evaluate(() => ({ body: document.body.className, sid: window.__ctx?.activeSession,
      workspace: window.__ctx?.agentWorkspaceState?.(), entries: window.__state?.sessionEntries,
      text: document.querySelector('#rightSide')?.textContent })).catch(() => null);
    fs.writeFileSync(path.join(scratch, 'diagnostic.json'), JSON.stringify({ errors, diagnostic, apiRequests,
      modelRequests: modelRequests.map(r => ({ stream: r.stream, tools: r.tools?.map(t => t.function.name), messages: r.messages })) }, null, 2), 'utf8');
  }
  console.error(`Failure evidence: ${scratch}`); throw error;
} finally {
  await browser?.close(); await stopChild(reader); upstream.closeAllConnections?.();
  await new Promise(resolve => upstream.close(resolve));
}
