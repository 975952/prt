/** Session ownership regression with real browser DOM and synthetic streaming.
 * No TCP server, user files, API keys, or paid calls. Chrome is controlled by pipe.
 * Run: node test/session-background.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX } from './_env.mjs';

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
const pdf = fs.readFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf')).toString('base64');
const errors = [], checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, pipe: true, headless: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser-profile'),
    defaultViewport: { width: 1400, height: 960 } });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (process.env.DEBUG_SESSION_TEST && ['error', 'warn'].includes(m.type())) console.log(m.type(), m.text()); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== 'http://prt-regression.test') return request.abort();
    if (url.pathname === '/api/pdf') return request.respond({ status: 200, contentType: 'application/pdf', body: Buffer.from(pdf, 'base64') }).catch(() => {});
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
    return request.respond({ status: 200, contentType, body: fs.readFileSync(file) }).catch(() => {});
  });
  await page.evaluateOnNewDocument(({ papers, pdf }) => {
    localStorage.setItem('reader.session.scopeMode', 'folder');
    localStorage.setItem('reader.session.onEnter', 'resume');
    localStorage.setItem('reader.session.aiTitle', '0');
    localStorage.setItem('reader.agentRead', '0');
    const nativeFetch = window.fetch.bind(window), store = new Map(), requests = [], writes = [];
    const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    const empty = () => ({ entries: [], history: [], ops: [], updatedAt: 0 });
    window.__mockSessions = store; window.__mockWrites = writes; window.__mockChatRequests = requests;
    window.__emitChat = (marker, text, done = false) => {
      const job = requests.find(r => r.source.includes(marker));
      if (!job) throw Error(`Missing request ${marker}`);
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n${done ? 'data: [DONE]\n\n' : ''}`);
      if (!job.aborted && !job.done) { job.controller.enqueue(bytes); if (done) { job.done = true; job.controller.close(); } }
    };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
      const method = String(init.method || 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body) : {};
      if (url.pathname === '/api/config') return response({ hasApiKey: true, model: 'synthetic', stream: true, autoTranslate: false, idleMs: 120000 });
      if (url.pathname === '/api/papers') return response({ papers, folders: ['courses', 'other'], dir: 'SYNTHETIC_PAPERS' });
      if (url.pathname === '/api/state') return response({ docs: {} });
      if (url.pathname === '/api/profile') return response({ version: 1, items: [] });
      if (url.pathname === '/api/notes') return response({ items: [] });
      if (url.pathname === '/api/pdf') return new Response(Uint8Array.from(atob(pdf), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'application/pdf' } });
      const key = `${url.searchParams.get('doc') || ''}::${url.searchParams.get('sid') || ''}`;
      if (url.pathname === '/api/session') {
        if (method === 'POST') { const copy = structuredClone(body); store.set(key, copy); writes.push({ key, body: copy }); return response({ ok: true, session: copy }); }
        if (method === 'PATCH') return response({ ok: true, session: { ...(store.get(key) || empty()), ...body } });
        if (method === 'DELETE') { store.delete(key); return response({ ok: true }); }
        return response(structuredClone(store.get(key) || empty()));
      }
      if (url.pathname === '/api/sessions') {
        const scope = url.searchParams.get('doc') || '';
        return response({ sessions: [...store].filter(([k, value]) => k.startsWith(`${scope}::`) && !k.endsWith('::__translate') && value.entries?.length)
          .map(([key, value]) => ({ ...value, sid: key.split('::')[1], fileKey: scope, count: value.entries.length })) });
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
  }, { papers, pdf });
  await page.goto('http://prt-regression.test/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state.papers.length === 5, { timeout: 30000 });
  const open = async id => {
    const paper = papers.find(p => p.docId === id); assert(paper);
    await page.evaluate(paper => window.__ctx.openDoc(paper), paper);
    await page.waitForFunction(id => window.__state.viewerDocId === id, { timeout: 30000 }, id);
  };
  const ask = async marker => {
    await page.evaluate(marker => {
      window.__ctx.setPanelVisible('chat', true); window.__ctx.setAgentRead(false); window.__ctx.setScopeRange('current');
      const input = document.querySelector('#chatInput'); input.value = marker;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.__testSendPromises ||= []; window.__testSendPromises.push(window.__ctx.send());
    }, marker);
    await page.waitForFunction(marker => window.__mockChatRequests.some(r => r.source.includes(marker)), { timeout: 15000 }, marker);
  };
  const emit = (marker, text, done) => page.evaluate(({ marker, text, done }) => window.__emitChat(marker, text, done), { marker, text, done });
  const chatText = () => page.evaluate(() => document.querySelector('[data-block="chat"] .ai-body')?.textContent || '');
  const complete = marker => page.waitForFunction(marker => window.__state.sessionEntries.some(e => e.block === 'chat' && e.status === 'complete' && e.text?.includes(marker)), {}, marker);
  await open('analog');
  await ask('SAME_SESSION_A'); await emit('SAME_SESSION_A', 'Analog first. ', false);
  await page.waitForFunction(() => document.querySelector('[data-block="chat"] .ai-body').textContent.includes('Analog first.'));
  await page.evaluate(() => { window.__originalChatNode = document.querySelector('[data-block="chat"] .msg:last-child'); });
  const sid = await page.evaluate(() => window.__ctx.activeSession);
  await open('physics');
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), sid);
  assert.equal(await page.evaluate(() => window.__originalChatNode.isConnected && document.querySelector('[data-block="chat"] .ai-body').contains(window.__originalChatNode)), true);
  assert.equal(await page.evaluate(() => window.__mockChatRequests[0].aborted), false);
  await emit('SAME_SESSION_A', 'same session tail.', true); await complete('same session tail.');
  pass('same-folder document switch preserves the active stream, session and exact message DOM');

  await ask('BACKGROUND_SESSION_A'); await emit('BACKGROUND_SESSION_A', 'Background partial. ', false);
  await open('other');
  assert.equal(await page.evaluate(() => window.__mockChatRequests.find(r => r.source.includes('BACKGROUND_SESSION_A')).aborted), false);
  assert(!(await chatText()).includes('Background partial.'));
  await ask('OTHER_SESSION_B'); await emit('OTHER_SESSION_B', 'Other session answer.', true); await complete('Other session answer.');
  await emit('BACKGROUND_SESSION_A', 'Background latest.', true);
  assert(!(await chatText()).includes('Background latest.'));
  await open('physics'); await complete('Background latest.');
  assert(!(await chatText()).includes('Other session answer.'));
  pass('different-session switch hides original work, runs another session, and restores latest background output');

  await open('root-a'); await ask('ROOT_SHARED_A'); await emit('ROOT_SHARED_A', 'Root shared answer.', true); await complete('Root shared answer.');
  const rootSid = await page.evaluate(() => window.__ctx.activeSession);
  await open('root-b');
  assert.equal(await page.evaluate(() => window.__ctx.activeSession), rootSid);
  assert((await chatText()).includes('Root shared answer.'));
  pass('standalone papers in the root directory share the public folder session');

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors,
    writes: await page.evaluate(() => window.__mockWrites), requests: await page.evaluate(() => window.__mockChatRequests.map(r => ({ body: r.body, aborted: r.aborted, done: r.done }))) }, null, 2), 'utf8');
  console.log(`Session background: ${checks.length}/${checks.length} passed; ${scratch}`);
} finally { await browser?.close(); }
