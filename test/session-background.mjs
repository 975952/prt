/** Session ownership regression with real browser DOM and synthetic streaming.
 * Source mode needs no TCP server. Neither mode uses user files, API keys, or paid calls.
 * Run: node test/session-background.mjs [--desktop]
 * --desktop stages an isolated executable and loads its actual embedded assets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX } from './_env.mjs';
import { stageExe, spawnReader, stopChild, waitForBase, READER_PORTS } from './_exe.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'session-background-'));
const CHROME = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
assert(CHROME, 'browser available');
const papers = [
  ['analog', 'analog.pdf', 'courses'], ['physics', 'physics.pdf', 'courses'],
  ['other', 'other.pdf', 'other'], ['root-a', 'root-a.pdf', ''], ['root-b', 'root-b.pdf', ''],
].map(([docId, name, folder]) => ({ docId, name, folder, path: folder ? `${folder}/${name}` : name,
  url: `/api/pdf?name=${encodeURIComponent(folder ? `${folder}/${name}` : name)}`, size: 10000 }));
// Distinct real PDFs catch accidentally reading the newly visible document.
// Plain ASCII streams make these fixtures deterministic and dependency free.
function fixturePdf(id, pages) {
  const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const children = [];
  for (let page = 1; page <= pages; page++) {
    const pageId = objects.length, streamId = pageId + 1;
    children.push(`${pageId} 0 R`);
    const color = id === 'analog' ? '0.15 0.35 0.75' : id === 'physics' ? '0.65 0.25 0.15' : '0.15 0.6 0.3';
    const content = `${color} rg 40 600 180 100 re f\n0 0 0 rg BT /F1 12 Tf 40 760 Td `
      + `(${id.toUpperCase()}_ONLY_PAGE_${page} SHAREDKEY. This synthetic ${id} textbook page contains unique verified reading material.) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${children.join(' ')}] /Count ${pages} >>`;
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(text)); text += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) text += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text).toString('base64');
}
const pdfs = Object.fromEntries(papers.map(p => [p.path, fixturePdf(p.docId,
  p.docId === 'analog' ? 4 : p.docId === 'physics' ? 5 : 3)]));
const errors = [], checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
let browser, desktopChild, desktopBase;
const embeddedAssets = new Map();
try {
  if (process.argv.includes('--desktop')) {
    const staged = stageExe('session-background');
    const dataDir = path.join(scratch, 'data'), papersDir = path.join(scratch, 'papers');
    fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
    desktopChild = spawnReader(staged.exe, { env: { PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
      PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' } });
    desktopBase = await waitForBase({ ports: READER_PORTS, papersDir });
    assert(desktopBase, 'isolated desktop executable starts');
    for (const relative of ['/js/app.js', '/js/sessions.js']) {
      const response = await fetch(`${desktopBase}${relative}`);
      assert.equal(response.status, 200);
      const body = Buffer.from(await response.arrayBuffer());
      assert(body.equals(fs.readFileSync(path.join(ROOT, 'public', relative))), `${relative} matches embedded executable`);
      embeddedAssets.set(relative, body);
    }
    pass('desktop executable embeds the current app and conversation code');
  }
  browser = await puppeteer.launch({ executablePath: CHROME, pipe: true, headless: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser-profile'),
    defaultViewport: { width: 1400, height: 960 } });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (process.env.DEBUG_SESSION_TEST && ['error', 'warn'].includes(m.type())) console.log(m.type(), m.text()); });
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (url.origin !== 'http://prt-regression.test') return request.abort();
    if (url.pathname === '/api/pdf') return request.respond({ status: 200, contentType: 'application/pdf',
      body: Buffer.from(pdfs[url.searchParams.get('name') || url.searchParams.get('path')], 'base64') }).catch(() => {});
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(ROOT, 'public', `.${relative}`);
    const publicRoot = path.resolve(ROOT, 'public') + path.sep;
    if (!file.startsWith(publicRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (process.env.DEBUG_SESSION_TEST) console.log('missing', url.pathname);
      return request.respond({ status: 404, body: '' });
    }
    const ext = path.extname(file);
    const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
      '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[ext] || 'application/octet-stream';
    let body;
    if (desktopBase) {
      if (!embeddedAssets.has(relative)) {
        const response = await fetch(`${desktopBase}${relative}`);
        if (!response.ok) return request.respond({ status: response.status, body: '' }).catch(() => {});
        embeddedAssets.set(relative, Buffer.from(await response.arrayBuffer()));
      }
      body = embeddedAssets.get(relative);
    } else body = fs.readFileSync(file);
    return request.respond({ status: 200, contentType, body }).catch(() => {});
  });
  await page.evaluateOnNewDocument(({ papers, pdfs }) => {
    localStorage.setItem('reader.locale', 'en');
    localStorage.setItem('reader.session.scopeMode', 'folder');
    localStorage.setItem('reader.session.onEnter', 'resume');
    localStorage.setItem('reader.session.aiTitle', '0');
    localStorage.setItem('reader.agentRead', '0');
    const nativeFetch = window.fetch.bind(window), store = new Map(), requests = [], writes = [];
    const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    const empty = () => ({ entries: [], history: [], ops: [], updatedAt: 0 });
    window.__mockSessions = store; window.__mockWrites = writes; window.__mockChatRequests = requests;
    window.__emitModel = (marker, { text = '', done = false, toolCalls = [], withTools } = {}) => {
      const job = requests.find(r => r.source.includes(marker) && !r.done && !r.aborted
        && (withTools === undefined || !!r.body.tools === withTools));
      if (!job) throw Error(`Missing request ${marker}`);
      const delta = { content: text };
      if (toolCalls.length) delta.tool_calls = toolCalls.map((call, index) => ({ index, id: call.id,
        type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }));
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n${done ? 'data: [DONE]\n\n' : ''}`);
      if (!job.aborted && !job.done) { job.controller.enqueue(bytes); if (done) { job.done = true; job.controller.close(); } }
    };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
      const method = String(init.method || 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body) : {};
      if (url.pathname === '/api/config') return response({ hasApiKey: true, model: 'synthetic', stream: true, autoTranslate: false, idleMs: 120000 });
      if (url.pathname === '/api/papers') return response({ papers, folders: ['courses', 'other'].map(path => ({ path })), dir: 'SYNTHETIC_PAPERS' });
      if (url.pathname === '/api/state') return response({ docs: {} });
      if (url.pathname === '/api/profile') return response({ version: 1, items: [] });
      if (url.pathname === '/api/notes') return response({ items: [] });
      if (url.pathname === '/api/pdf') return new Response(Uint8Array.from(atob(pdfs[url.searchParams.get('name') || url.searchParams.get('path')]), c => c.charCodeAt(0)),
        { headers: { 'Content-Type': 'application/pdf' } });
      const key = `${url.searchParams.get('doc') || ''}::${url.searchParams.get('sid') || ''}`;
      if (url.pathname === '/api/session') {
        if (method === 'POST') { const copy = structuredClone(body); store.set(key, copy); writes.push({ key, body: copy }); return response({ ok: true, session: copy }); }
        if (method === 'PATCH') { const updated = { ...(store.get(key) || empty()), ...body }; store.set(key, updated); return response({ ok: true, session: updated }); }
        if (method === 'DELETE') { store.delete(key); return response({ ok: true }); }
        return response(structuredClone(store.get(key) || empty()));
      }
      if (url.pathname === '/api/sessions') {
        const scope = url.searchParams.get('doc') || '';
        return response({ sessions: [...store].filter(([k, value]) => (url.searchParams.get('scope') === 'all' || k.startsWith(`${scope}::`))
          && !k.endsWith('::__translate') && value.entries?.length)
          .map(([key, value]) => ({ ...value, title: value.title || `Session ${key.split('::')[1]}`,
            sid: key.split('::')[1], fileKey: key.split('::')[0], count: value.entries.length })) });
      }
      if (url.pathname === '/api/chat') {
        const source = JSON.stringify(body.messages || []);
        if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) return response({ choices: [{ message: { content: '[]' } }] });
        const job = { body, source, aborted: false, done: false };
        const stream = new ReadableStream({ start(controller) { job.controller = controller; }, cancel() { job.aborted = true; } });
        init.signal?.addEventListener('abort', () => { job.aborted = true; try { job.controller.error(new DOMException('aborted', 'AbortError')); } catch {} }, { once: true });
        requests.push(job);
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return response({ ok: true, items: [], results: [] });
    };
  }, { papers, pdfs });
  await page.goto('http://prt-regression.test/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state.papers.length === 5, { timeout: 30000 });
  const open = async id => {
    const paper = papers.find(p => p.docId === id); assert(paper);
    await page.evaluate(paper => window.__ctx.openDoc(paper), paper);
    await page.waitForFunction(id => window.__state.viewerDocId === id, { timeout: 30000 }, id);
  };
  const ask = async (marker, { agent = false, range = 'current' } = {}) => {
    await page.evaluate(({ marker, agent, range }) => {
      window.__ctx.setPanelVisible('chat', true); window.__ctx.setAgentRead(agent); window.__ctx.setScopeRange(range);
      const input = document.querySelector('#chatInput'); input.value = marker;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.__testSendPromises ||= []; window.__testSendPromises.push(window.__ctx.send());
    }, { marker, agent, range });
    await page.waitForFunction(marker => window.__mockChatRequests.some(r => r.source.includes(marker)), { timeout: 15000 }, marker);
  };
  const emit = (marker, text, done) => page.evaluate(({ marker, text, done }) => window.__emitModel(marker, { text, done }), { marker, text, done });
  const tools = (marker, toolCalls) => page.evaluate(({ marker, toolCalls }) => window.__emitModel(marker,
    { toolCalls, done: true, withTools: true }), { marker, toolCalls });
  const chatText = () => page.evaluate(() => document.querySelector('[data-block="chat"] .ai-body')?.textContent || '');
  const complete = marker => page.waitForFunction(marker => window.__state.sessionEntries.some(e => e.block === 'chat' && e.status === 'complete' && e.text?.includes(marker)), {}, marker);
  const idle = () => page.waitForFunction(() => !window.__state.busy);
  const owner = () => page.evaluate(() => `${__ctx.currentFolderKey}::${__ctx.activeSession}`);
  const notAborted = marker => page.evaluate(marker => __mockChatRequests.filter(r => r.source.includes(marker)).every(r => !r.aborted), marker);
  const saveWith = async (key, marker) => {
    await page.waitForFunction(({ key, marker }) => window.__mockWrites.some(w => w.key === key
      && w.body.entries?.some(e => e.text?.includes(marker))), {}, { key, marker });
    assert.equal(await page.evaluate(({ key, marker }) => window.__mockWrites.filter(w => w.key !== key)
      .some(w => w.body.entries?.some(e => e.text?.includes(marker))), { key, marker }), false,
    `${marker} must only be written to its originating conversation`);
  };
  const keepNode = label => page.evaluate(label => {
    window.__keptNodes ||= {};
    window.__keptNodes[label] = document.querySelector('[data-block="chat"] .msg:last-child');
  }, label);
  const sameNode = label => page.evaluate(label => !!window.__keptNodes[label]?.isConnected
    && document.querySelector('[data-block="chat"] .ai-body').contains(window.__keptNodes[label]), label);
  await open('analog');
  await ask('SAME_SESSION_A'); await emit('SAME_SESSION_A', 'Analog first. ', false);
  await page.waitForFunction(() => document.querySelector('[data-block="chat"] .ai-body').textContent.includes('Analog first.'));
  await keepNode('same-session');
  const sid = await page.evaluate(() => window.__ctx.activeSession);
  await page.evaluate(() => window.__ctx.jumpToPageWithHistory(3, { smooth: false }));
  assert.equal(await sameNode('same-session'), true);
  assert.equal(await notAborted('SAME_SESSION_A'), true);
  await open('physics');
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), sid);
  assert.equal(await sameNode('same-session'), true);
  assert.equal(await notAborted('SAME_SESSION_A'), true);
  const firstPrompt = await page.evaluate(() => __mockChatRequests[0].source);
  assert(firstPrompt.includes('ANALOG_ONLY_PAGE_1') && !firstPrompt.includes('PHYSICS_ONLY_PAGE_'));
  await emit('SAME_SESSION_A', 'same session tail.', true); await complete('same session tail.'); await idle();
  pass('page navigation and same-folder document switch preserve stream, exact DOM and original prompt');

  await page.evaluate(async () => {
    const row = __ctx.addEntry({ block: 'translate', tag: 'translate', page: 2, text: 'Persisted physics translation.' });
    __ctx.finishEntry(row, 'Persisted physics translation.', { page: 2 });
    await __ctx.saveSessionNow();
  });

  await ask('BACKGROUND_SESSION_A'); await emit('BACKGROUND_SESSION_A', 'Background partial. ', false);
  await keepNode('background-a');
  const ownerA = await owner();
  await open('other');
  assert.equal(await notAborted('BACKGROUND_SESSION_A'), true);
  assert(!(await chatText()).includes('Background partial.'));
  await ask('OTHER_SESSION_B'); await emit('OTHER_SESSION_B', 'Other session partial. ', false);
  const ownerB = await owner();
  assert.notEqual(ownerA, ownerB);
  await keepNode('background-b');
  await open('physics');
  assert.equal(await sameNode('background-a'), true);
  assert.equal(await page.evaluate(() => __state.busy), true);
  assert.equal(await notAborted('OTHER_SESSION_B'), true);
  assert(!(await chatText()).includes('Other session partial.'));
  await emit('BACKGROUND_SESSION_A', 'More while visible. ', false);
  await page.waitForFunction(() => document.querySelector('[data-block="chat"] .ai-body').textContent.includes('More while visible.'));
  await open('other');
  assert.equal(await sameNode('background-b'), true);
  await emit('BACKGROUND_SESSION_A', 'Background latest.', true);
  assert(!(await chatText()).includes('Background latest.'));
  await emit('OTHER_SESSION_B', 'Other session answer.', true); await complete('Other session answer.'); await idle();
  await saveWith(ownerA, 'Background latest.'); await saveWith(ownerB, 'Other session answer.');
  await open('physics'); await complete('Background latest.');
  assert(!(await chatText()).includes('Other session answer.'));
  assert.equal(await page.evaluate(() => __state.sessionEntries.some(e => e.block === 'translate'
    && e.text === 'Persisted physics translation.')), true);
  await page.evaluate(() => __ctx.setPanelVisible('translate', true));
  assert.equal(await page.evaluate(() => document.querySelector('[data-block="translate"] .ai-body')?.textContent.includes('Persisted physics translation.')), true);
  await page.evaluate(() => __ctx.setPanelVisible('chat', true));
  pass('different conversations run concurrently, return to live DOM, save to original owners and restore document translations');

  await ask('MENU_SESSION_C'); await emit('MENU_SESSION_C', 'Original menu session. ', false);
  await keepNode('menu-c');
  const sidC = await page.evaluate(() => __ctx.activeSession);
  await page.evaluate(() => __ctx.saveSessionNow());
  assert.equal(await page.$eval('#sessNew', node => node.disabled), false, 'new-conversation UI remains available during generation');
  await page.click('#sessNew');
  await page.waitForFunction(sid => __ctx.activeSession !== sid && !__state.busy, {}, sidC);
  await ask('MENU_SESSION_D'); await emit('MENU_SESSION_D', 'Only stop this session. ', false);
  await page.click('#stopBtn');
  await page.waitForFunction(() => __mockChatRequests.find(r => r.source.includes('MENU_SESSION_D'))?.aborted);
  await idle();
  assert.equal(await notAborted('MENU_SESSION_C'), true);
  await page.click('#sessBtn');
  await page.waitForFunction(sid => [...document.querySelectorAll('.sess-quick-row')].some(row => row.title === `Session ${sid}`), {}, sidC);
  await page.evaluate(sid => [...document.querySelectorAll('.sess-quick-row')].find(row => row.title === `Session ${sid}`).click(), sidC);
  await page.waitForFunction(sid => __ctx.activeSession === sid, {}, sidC);
  assert.equal(await sameNode('menu-c'), true);
  assert.equal(await page.evaluate(() => __state.busy), true);
  await emit('MENU_SESSION_C', 'Menu original completed.', true); await complete('Menu original completed.'); await idle();
  pass('new/switch conversation controls work during generation and Stop affects only the displayed conversation');

  await open('root-a'); await ask('ROOT_SHARED_A'); await emit('ROOT_SHARED_A', 'Root shared partial. ', false);
  await keepNode('root-shared');
  const rootSid = await page.evaluate(() => window.__ctx.activeSession);
  await open('root-b');
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), rootSid);
  assert.equal(await sameNode('root-shared'), true);
  assert.equal(await notAborted('ROOT_SHARED_A'), true);
  await emit('ROOT_SHARED_A', 'Root shared answer.', true); await complete('Root shared answer.'); await idle();
  assert((await chatText()).includes('Root shared answer.'));
  pass('standalone root papers share one conversation and keep its live stream and message DOM');

  await open('analog');
  await page.evaluate(() => __ctx.newSession({ silent: true }));
  const expectedImage = await page.evaluate(async () => (await __viewer.capturePageImage(2, { maxDim: 1400 })).dataUrl);
  await ask('AGENT_ORIGIN_A', { agent: true });
  const agentOwner = await owner();
  await open('other');
  assert.equal(await notAborted('AGENT_ORIGIN_A'), true);
  await tools('AGENT_ORIGIN_A', [
    { id: 'origin-state', name: 'get_reading_state' },
    { id: 'origin-page', name: 'read_page', args: { page: 2 } },
    { id: 'origin-search', name: 'search_paper', args: { query: 'ANALOG_ONLY' } },
    { id: 'origin-folder', name: 'search_papers', args: { query: 'SHAREDKEY', scope: 'folder' } },
  ]);
  await page.waitForFunction(() => __mockChatRequests.some(r => r.source.includes('AGENT_ORIGIN_A')
    && r.body.tools && r.body.messages.filter(m => m.role === 'tool').length === 4), { timeout: 20000 });
  const results = await page.evaluate(() => Object.fromEntries(__mockChatRequests.find(r => r.source.includes('AGENT_ORIGIN_A')
    && r.body.tools && r.body.messages.filter(m => m.role === 'tool').length === 4).body.messages
    .filter(m => m.role === 'tool').map(m => [m.tool_call_id, JSON.parse(m.content)])));
  const result = id => results[id].value || results[id];
  assert.equal(result('origin-state').docTitle, 'analog.pdf');
  assert.equal(result('origin-state').numPages, 4);
  assert(result('origin-page').text.includes('ANALOG_ONLY_PAGE_2'));
  assert(result('origin-search').pages.length > 0);
  assert(result('origin-search').pages.every(row => row.snippet.includes('ANALOG_ONLY')));
  assert.equal(result('origin-folder').papersTotal, 2);
  assert(result('origin-folder').hits.length > 0);
  assert(result('origin-folder').hits.every(row => row.folder === 'courses' && ['analog.pdf', 'physics.pdf'].includes(row.name)));
  await tools('AGENT_ORIGIN_A', [{ id: 'origin-image', name: 'read_page_image', args: { page: 2 } }]);
  await page.waitForFunction(() => __mockChatRequests.some(r => r.source.includes('AGENT_ORIGIN_A') && !r.body.tools
    && r.body.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'))), { timeout: 20000 });
  const actualImage = await page.evaluate(() => __mockChatRequests.find(r => r.source.includes('AGENT_ORIGIN_A') && !r.body.tools
    && r.body.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')))
    .body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(p => p.type === 'image_url').image_url.url);
  assert.equal(actualImage, expectedImage, 'delayed vision tool receives page 2 from original PDF');
  await page.evaluate(() => __emitModel('AGENT_ORIGIN_A', { text: 'ANALOG_ONLY_PAGE_2 image transcription.', done: true, withTools: false }));
  await page.waitForFunction(() => __mockChatRequests.some(r => r.source.includes('AGENT_ORIGIN_A') && r.body.tools
    && r.body.messages.filter(m => m.role === 'tool').length === 5), { timeout: 20000 });
  await emit('AGENT_ORIGIN_A', 'Agent original answer verified.', true);
  await saveWith(agentOwner, 'Agent original answer verified.');
  assert(!(await chatText()).includes('Agent original answer verified.'));
  assert.equal(await page.evaluate(() => __state.busy), false, 'background agent ticks do not mark the visible conversation busy');
  await open('analog'); await complete('Agent original answer verified.'); await idle();
  pass('delayed agent tools retain original PDF text, page image, page count, folder scope and save owner after navigation');

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktopBase ? 'desktop' : 'source', checks, errors,
    writes: await page.evaluate(() => window.__mockWrites), requests: await page.evaluate(() => window.__mockChatRequests.map(r => ({ body: r.body, aborted: r.aborted, done: r.done }))) }, null, 2), 'utf8');
  console.log(`Session background: ${checks.length}/${checks.length} passed; ${scratch}`);
} finally { await browser?.close(); await stopChild(desktopChild); }
