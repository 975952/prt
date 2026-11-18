/** Real PDF/text extraction + isolated synthetic model; no personal data or network.
 * node test/paper-navigation-flow.mjs [--desktop] */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
assert.ok(executablePath);
const scratch = fs.mkdtempSync(path.join(SANDBOX, `paper-navigation-flow-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const title = 'Tokens-to-Token ViT: Training Vision Transformers from Scratch on ImageNet';
const twinsTitle = 'Twins: Revisiting the Design of Spatial Attention';
const targetName = '2101.11986v3.pdf';
function pdf(name, heading, pages) {
  const literal = value => String(value).replace(/[\\()]/g, '\\$&');
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pageIds = [];
  for (const lines of pages) {
    const pageId = objects.length + 1, contentId = pageId + 1;
    pageIds.push(pageId);
    const content = lines.map((line, i) => `BT /F1 ${i ? 10 : 14} Tf 50 ${730 - i * 20} Td (${literal(line)}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  const info = objects.length + 1;
  objects.push(`<< /Title (${literal(heading)}) >>`);
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`;
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(papersDir, name), out, 'utf8');
}
pdf(targetName, title, [[title, 'Synthetic authors', 'Abstract', 'Tokens-to-token representation for vision transformers.'],
  ['Synthetic methods', 'A readable second page for restoration testing.'],
  ['Saved reading position', 'This is the third PDF page, unrelated to the matching title page.'],
  ['Synthetic evaluation', 'A readable fourth page for keyboard activation checks.']]);
pdf('swin.pdf', 'Swin Transformer: Hierarchical Vision Transformer using Shifted Windows',
  [['Swin Transformer: Hierarchical Vision Transformer using Shifted Windows', 'Synthetic unrelated abstract'],
    ['References', `[1] Li Yuan et al. ${title}. 2021.`, '[2] Other researchers. Other paper. 2020.']]);
pdf('twins.pdf', twinsTitle,
  [[twinsTitle, 'Synthetic unrelated abstract'],
    ['References', `[1] Li Yuan et al. ${title}. 2021.`, '[2] Other researchers. Other paper. 2020.']]);
pdf('medical.pdf', 'T2T-ViT for Medical Image Segmentation',
  [['T2T-ViT for Medical Image Segmentation', 'Abstract', 'A different follow-up work with a similar abbreviation.']]);

const checks = [], errors = [], requests = [], plans = [], qa = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let base, listing, reader, browser, page;
function reply(res, body, content) {
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }] })); }
}
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const system = body.messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
    if (/PAPER_DISCOVERY_QUERY_PLAN/.test(system)) {
      plans.push(body);
      const question = String(body.messages.filter(row => row.role === 'user').at(-1)?.content || '');
      const planTitle = /Twins/i.test(question) ? twinsTitle : title;
      reply(res, body, JSON.stringify({ queries: [{ query: planTitle, mode: 'known', titles: [planTitle],
        aliases: planTitle === title ? ['T2T-ViT', 'Tokens-to-Token ViT'] : ['Twins'], keywords: [planTitle] }] })); return;
    }
    if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(system)) { reply(res, body, '[]'); return; }
    qa.push(body); reply(res, body, 'SYNTHETIC_NORMAL_QA: 这里是对方法差异的回答。');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
async function json(route, body) {
  const res = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(res.ok, `${route}: ${res.status}`); return res.json();
}
const settled = () => page.waitForFunction(() => !window.__state.busy && document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true');
const latest = () => page.evaluate(() => [...window.__state.sessionEntries].reverse().find(row => row.kind === 'assistant'));
async function newPage(names) {
  const context = await browser.createBrowserContext(); page = await context.newPage();
  await page.setViewport({ width: 1600, height: 960 }); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('dialog', dialog => void dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base && url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, query: url.search });
    if (url.origin === base && url.pathname === '/api/papers') return request.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...listing, papers: listing.papers.filter(row => names.includes(row.name)) }) });
    if (url.origin === base && ['/api/ref-search', '/api/web-search'].includes(url.pathname)) return request.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', results: [
        { title, url: 'https://arxiv.org/abs/2101.11986', pdfUrl: 'https://arxiv.org/pdf/2101.11986', source: 'arXiv' },
        { title: 'T2T genome sequencing and chromosome assembly', url: 'https://zhuanlan.zhihu.com/p/497203767', source: 'Bing' },
        { title: 'T2T - electronic commerce model', url: 'https://baike.baidu.com/item/t2t/18400327', source: 'Bing' },
        { title: 'T2T Genome Hub', url: 'https://example.edu/genome/', source: 'Bing' },
      ] }) });
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) {
      errors.push(`Unexpected external request: ${url.origin}${url.pathname}`); return request.abort();
    }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN'); localStorage.setItem('reader.responseLanguage', 'zh-CN');
    localStorage.setItem('reader.session.scopeMode', 'paper'); localStorage.setItem('reader.session.onEnter', 'choose');
    localStorage.setItem('reader.session.aiTitle', '0'); localStorage.setItem('reader.agentRead', '1');
  });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(n => !!window.__ctx && window.__state.papers.length === n, {}, names.length);
  await page.click('#homeAgent'); await page.waitForSelector('body.agent-landing', { visible: true });
  await settled(); await page.evaluate(() => window.__ctx.setScopeRange('web'));
}
async function send(question) {
  const before = await page.evaluate(() => window.__state.sessionEntries.filter(row => row.kind === 'assistant').length);
  await page.$eval('#chatInput', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, question);
  await page.click('#sendBtn');
  await page.waitForFunction(before => {
    const rows = window.__state.sessionEntries.filter(row => row.kind === 'assistant');
    return rows.length > before && rows.at(-1)?.status === 'complete' && !window.__state.busy;
  }, {}, before);
  await settled(); return latest();
}
const targetSelector = `button.paper-discovery-local[data-paper-path="${targetName}"]`;
try {
  await listen(upstream); const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('paper-navigation-flow').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready);
  listing = await json('/api/papers'); assert.equal(path.resolve(listing.dir), path.resolve(papersDir));
  for (const asset of ['js/app.js', 'js/paper-request.js', 'js/paper-discovery.js', 'js/paper-discovery-ui.js'])
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  await json('/api/config', { baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'navigation-synthetic', apiKey: 'SYNTHETIC_NAV_KEY' });
  const target = listing.papers.find(row => row.name === targetName);
  await json('/api/state', { docs: { [target.docId]: { page: 3, scale: 1, fit: true, ts: Date.now(), name: targetName } }, lastDoc: null, lastUrl: null, lastName: null });
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  pass('isolated current assets, generated multipage PDFs and synthetic model');

  await newPage([targetName, 'swin.pdf', 'twins.pdf', 'medical.pdf']);
  const answer = await send('我想看t2t trans的论文');
  assert.equal(plans.length, 1); assert.equal(qa.length, 0);
  assert.ok(answer.text.length < 80); assert.ok(!/p\.\s*\d|第\d+页|摘要|指标|T5|Sources/i.test(answer.text));
  assert.equal(answer.page, null); assert.ok(!answer.basis);
  assert.deepEqual(answer.discovery.local.matches.map(row => row.path), [targetName]);
  assert.equal(await page.$$eval('button.paper-discovery-local', nodes => nodes.length), 1);
  assert.equal(await page.$$eval('.paper-discovery-primary, .paper-discovery-local button, .paper-discovery-local a', nodes => nodes.length), 0);
  assert.equal(requests.filter(row => ['/api/ref-search', '/api/web-search'].includes(row.path)).length, 0);
  assert.ok(!await page.$eval('.paper-discovery', node => /Page|第\d+页|已检查|Open page|继续联网/.test(node.textContent)));
  await page.screenshot({ path: path.join(scratch, 'target-only-full.png'), fullPage: true });
  pass('original Chinese lookup returns one short answer and the actual paper, without citation noise, page buttons or network');

  const sid = await page.evaluate(() => window.__ctx.activeSession);
  await page.locator(targetSelector).click();
  await page.waitForFunction(() => document.body.classList.contains('agent-docked') && window.__viewer.current === 3);
  await settled(); assert.equal(await page.evaluate(() => window.__ctx.activeSession), sid);
  assert.equal(await page.evaluate(() => window.__ctx.agentWorkspaceState().scope), 'default');
  assert.ok(await page.$eval('#agentHandoff', node => !node.hidden));
  pass('clicking the whole card docks the same conversation and restores page 3 instead of the matching title page');

  for (const [key, savedPage] of [['Enter', 4], ['Space', 2]]) {
    await page.click('#agentContinue'); await page.evaluate(n => window.__viewer.goToPage(n), savedPage);
    await page.waitForFunction(n => window.__viewer.current === n, {}, savedPage);
    await page.click('#agentExpand'); await settled();
    await page.waitForSelector(targetSelector, { visible: true }); await page.focus(targetSelector);
    await page.keyboard.press(key); await page.waitForFunction(n => document.body.classList.contains('agent-docked') && window.__viewer.current === n, {}, savedPage);
    await settled(); assert.equal(await page.evaluate(() => window.__ctx.activeSession), sid);
  }
  pass('Enter and Space activate the whole card and retain the current reading position');

  await page.click('#agentContinue'); await page.click('#agentExpand'); await settled();
  const corrected = await send('？我只需要那一篇论文');
  assert.equal(plans.length, 2); assert.equal(qa.length, 0);
  assert.ok(plans[1].messages.some(row => String(row.content).includes('Previous paper lookup') && String(row.content).includes(title)));
  assert.deepEqual(corrected.discovery.local.matches.map(row => row.path), [targetName]);
  assert.ok(corrected.text.length < 80);
  pass('the correction only that paper keeps the prior target and remains a short lookup');

  const later = await send('再帮我找Twins的论文');
  assert.deepEqual(later.discovery.local.matches.map(row => row.path), ['twins.pdf']);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  const saved = await json(`/api/session?${new URLSearchParams({ doc: 'default', sid })}`);
  assert.equal(saved.entries.find(row => row.id === corrected.id).retry.previousDiscovery.titles[0], title);
  for (const legacy of [false, true]) {
    if (legacy) {
      const old = await json(`/api/session?${new URLSearchParams({ doc: 'default', sid })}`);
      delete old.entries.find(row => row.id === corrected.id).retry.previousDiscovery;
      await json(`/api/session?${new URLSearchParams({ doc: 'default', sid })}`, old);
    }
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !!window.__ctx);
    await page.waitForSelector('#agentBtn', { visible: true }); await page.locator('#agentBtn').click();
    await page.waitForSelector('body.agent-landing', { visible: true }); await settled();
    await page.click('#agentHistory');
    const sessionSelector = `#sessHistory .sess-hrow[data-sid=${JSON.stringify(sid)}] .sess-hgo`;
    await page.waitForSelector(sessionSelector, { visible: true }); await page.locator(sessionSelector).click(); await settled();
    await page.waitForFunction(id => !document.body.classList.contains('agent-landing')
      && [...document.querySelectorAll('#aiArea .msg.assistant')].some(node => node.__sessionRecord?.id === id), {}, corrected.id);
    const beforeRows = await page.evaluate(() => window.__state.sessionEntries.length), beforePlans = plans.length;
    await page.evaluate(id => {
      const root = [...document.querySelectorAll('#aiArea .msg.assistant')].find(node => node.__sessionRecord?.id === id);
      const button = [...root.querySelectorAll('button')].find(node => node.textContent === '重新生成');
      button.dataset.navigationRetry = 'true';
    }, corrected.id);
    await page.locator('button[data-navigation-retry="true"]').click();
    await page.waitForFunction(id => !window.__state.busy && window.__state.sessionEntries.find(row => row.id === id)?.status === 'complete', {}, corrected.id);
    await settled();
    assert.equal(plans.length, beforePlans + 1);
    const retryContext = plans.at(-1).messages.find(row => String(row.content).startsWith('Previous paper lookup'))?.content;
    assert.ok(retryContext?.includes(title)); assert.ok(!retryContext?.includes(twinsTitle));
    const retried = await page.evaluate(id => window.__state.sessionEntries.find(row => row.id === id), corrected.id);
    assert.equal(await page.evaluate(() => window.__state.sessionEntries.length), beforeRows);
    assert.ok(retried.text.length < 80); assert.equal(retried.page, null); assert.ok(!retried.basis);
    assert.deepEqual(retried.discovery.local.matches.map(row => row.path), [targetName]);
    assert.equal(retried.retry.firstPage, null);
    await page.evaluate(() => window.__ctx.saveSessionNow());
  }
  pass('saved and legacy regenerated corrections keep their earlier target even after a different paper lookup, without adding a turn or page badge');

  const planCount = plans.length;
  const content = await send('解释一下这篇论文和Swin的区别');
  assert.equal(plans.length, planCount); assert.ok(qa.length > 0);
  assert.match(content.text, /SYNTHETIC_NORMAL_QA/); assert.ok(!content.discovery);
  pass('a paper-content comparison uses the reading agent rather than the navigation shortcut');

  await newPage(['swin.pdf', 'twins.pdf']);
  const referenceOnly = await send('我想看t2t trans的论文');
  assert.deepEqual(referenceOnly.discovery.local.matches, []);
  assert.equal(referenceOnly.discovery.local.status, 'not_found'); assert.ok(referenceOnly.discovery.local.coverage.complete);
  assert.deepEqual(referenceOnly.discovery.online.results.map(row => row.title), [title]);
  assert.ok(requests.filter(row => ['/api/ref-search', '/api/web-search'].includes(row.path)).every(row => decodeURIComponent(row.query).includes('Tokens-to-Token')));
  assert.equal(await page.$$eval('button.paper-discovery-local', nodes => nodes.length), 0);
  assert.equal(await page.$$eval('a.paper-discovery-source', nodes => nodes.length), 1);
  pass('references alone are a local miss, while full-title online lookup filters unrelated genomics and commerce results');

  assert.deepEqual(errors, []); pass('no uncaught browser errors or real external service requests');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktop ? 'desktop' : 'node', checks, errors, requests, plannerCalls: plans.length, qaCalls: qa.length }, null, 2), 'utf8');
  console.log(`paper-navigation-flow: ${checks.length}/${checks.length} passed; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  if (page) {
    await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
    const diagnostic = await page.evaluate(() => ({ body: document.body.className, workspace: window.__ctx?.agentWorkspaceState(),
      currentPage: window.__viewer?.current, entries: window.__state?.sessionEntries, text: document.querySelector('#rightSide')?.textContent })).catch(() => null);
    fs.writeFileSync(path.join(scratch, 'diagnostic.json'), JSON.stringify({ errors, diagnostic, requests, plans, qa }, null, 2), 'utf8');
  }
  console.error(`Failure evidence: ${scratch}`); throw error;
} finally {
  await browser?.close(); await stopChild(reader); upstream.closeAllConnections?.(); await new Promise(resolve => upstream.close(resolve));
}
