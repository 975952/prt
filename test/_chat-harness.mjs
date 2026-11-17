/** Isolated real-browser chat harness. No user data or external model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX } from './_env.mjs';
import { stageExe, spawnReader, stopChild, waitForBase, READER_PORTS } from './_exe.mjs';

export function fixturePdf(id, pages = 4, scanned = false) {
  const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const children = [];
  for (let n = 1; n <= pages; n++) {
    const pageId = objects.length, streamId = pageId + 1;
    children.push(`${pageId} 0 R`);
    const color = id === 'analog' ? '0.15 0.35 0.75' : id === 'mobile' ? '0.65 0.25 0.15' : '0.15 0.6 0.3';
    const content = `${color} rg 40 600 180 100 re f\n` + (scanned ? '0 0 0 rg 40 550 330 12 re f\n40 525 250 12 re f\n'
      : `0 0 0 rg BT /F1 12 Tf 40 760 Td (${id.toUpperCase()}_ONLY_PAGE_${n} SHAREDKEY. This unique synthetic ${id} textbook page contains verified source content for page ${n}.) Tj ET\n`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${children.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n'; const offsets = [0];
  for (let n = 1; n < objects.length; n++) { offsets.push(Buffer.byteLength(out)); out += `${n} 0 obj\n${objects[n]}\nendobj\n`; }
  const start = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(out).toString('base64');
}

export async function withChatHarness({ tag = 'cross-file-chat', papers: rawPapers, desktop = process.argv.includes('--desktop') }, run) {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(SANDBOX, `${tag}-`));
  const papers = rawPapers.map(p => ({ ...p, folder: p.folder || '', path: p.folder ? `${p.folder}/${p.name}` : p.name,
    url: `/api/pdf?name=${encodeURIComponent(p.folder ? `${p.folder}/${p.name}` : p.name)}`, size: 10000 }));
  const pdfs = Object.fromEntries(papers.map(p => [p.path, fixturePdf(p.docId, p.numPages, p.scanned)]));
  const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
  assert(executablePath, 'Chrome-compatible browser is available');
  let browser, page, child, desktopBase;
  const assets = new Map(), errors = [], checks = [];
  const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
  try {
    if (desktop) {
      const staged = stageExe(tag), dataDir = path.join(scratch, 'data'), papersDir = path.join(scratch, 'papers');
      fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
      child = spawnReader(staged.exe, { env: { PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' } });
      desktopBase = await waitForBase({ ports: READER_PORTS, papersDir });
      assert(desktopBase, 'isolated executable starts');
      for (const file of ['/js/app.js', '/js/ai.js', '/js/agent.js', '/js/task-deadline.js', '/js/sessions.js', '/js/session-lifecycle.js',
        '/js/pdfview.js', '/js/paper-access.js', '/js/paper-target.js', '/js/chat-source.js', '/js/reading-context.js']) {
        const source = path.join(ROOT, 'public', file); if (!fs.existsSync(source)) continue;
        const response = await fetch(`${desktopBase}${file}`); assert(response.ok, `${file} embedded`);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert(bytes.equals(fs.readFileSync(source)), `${file} matches embedded build`); assets.set(file, bytes);
      }
      pass('executable contains current conversation and PDF resource code');
    }
    browser = await puppeteer.launch({ executablePath, pipe: true, headless: true, args: ['--no-sandbox', '--disable-gpu'],
      userDataDir: path.join(scratch, 'browser-profile'), defaultViewport: { width: 1400, height: 960 } });
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (process.env.DEBUG_SESSION_TEST && ['warn', 'error'].includes(message.type())) console.log(message.type(), message.text()); });
    await page.setRequestInterception(true);
    page.on('request', async request => {
      try {
        const url = new URL(request.url());
        if (url.origin !== 'http://prt-regression.test') return request.abort();
        if (url.pathname === '/api/pdf') return request.respond({ status: 200, contentType: 'application/pdf',
          body: Buffer.from(pdfs[url.searchParams.get('name') || url.searchParams.get('path')], 'base64') });
        const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        const file = path.resolve(ROOT, 'public', `.${relative}`), publicRoot = path.resolve(ROOT, 'public') + path.sep;
        if (!file.startsWith(publicRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return request.respond({ status: 404, body: '' });
        const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
          '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream';
        if (desktopBase && !assets.has(relative)) {
          const response = await fetch(`${desktopBase}${relative}`); assert(response.ok, `${relative} embedded asset loads`);
          assets.set(relative, Buffer.from(await response.arrayBuffer()));
        }
        return request.respond({ status: 200, contentType, body: desktopBase ? assets.get(relative) : fs.readFileSync(file) });
      } catch (error) { errors.push(`interception: ${error.message}`); await request.abort().catch(() => {}); }
    });
    await page.evaluateOnNewDocument(({ papers, pdfs }) => {
      localStorage.setItem('reader.locale', 'en'); localStorage.setItem('reader.session.scopeMode', 'folder');
      localStorage.setItem('reader.session.onEnter', 'resume'); localStorage.setItem('reader.session.aiTitle', '0'); localStorage.setItem('reader.agentRead', '0');
      const nativeFetch = window.fetch.bind(window), store = new Map(), requests = [], writes = [], attempts = [], rules = [], gates = [];
      const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const empty = () => ({ entries: [], history: [], ops: [], updatedAt: 0 });
      window.__mockSessions = store; window.__mockWrites = writes; window.__mockSaveAttempts = attempts; window.__mockChatRequests = requests;
      window.__mockDeletedSessions = new Set();
      window.__mockRules = rules; window.__mockGates = gates; window.__mockPdfReads = []; window.__ignoreAbortMarkers = new Set();
      window.__waitGate = async (kind, key, detail = null) => {
        const rule = rules.find(r => r.kind === kind && String(key).includes(r.match || '') && r.remaining !== 0);
        if (!rule) return null;
        if (rule.remaining !== undefined) rule.remaining--;
        const gate = { id: gates.length, kind, key, detail, state: 'waiting' }; gates.push(gate);
        return await new Promise((resolve, reject) => {
          gate.release = value => { gate.state = 'released'; resolve(value || null); };
          gate.reject = message => { gate.state = 'rejected'; reject(new Error(message || 'Synthetic gate failure')); };
        });
      };
      window.__emitModel = (marker, { text = '', done = false, toolCalls = [], withTools, late = false } = {}) => {
        const job = requests.find(r => r.source.includes(marker) && !r.done && (late || !r.aborted)
          && (withTools === undefined || !!r.body.tools === withTools));
        if (!job) throw Error(`Missing live request ${marker}`);
        const delta = { content: text };
        if (toolCalls.length) delta.tool_calls = toolCalls.map((call, index) => ({ index, id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }));
        try {
          job.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n${done ? 'data: [DONE]\n\n' : ''}`));
          if (done) { job.done = true; job.controller.close(); }
          return true;
        } catch { return false; }
      };
      window.__failModel = marker => {
        const job = requests.find(r => r.source.includes(marker) && !r.done && !r.aborted);
        if (!job) throw Error(`Missing request ${marker}`); job.done = true; job.failed = true;
        job.controller.error(new Error('Synthetic intentional model failure'));
      };
      window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
        const method = String(init.method || 'GET').toUpperCase(), body = init.body ? JSON.parse(init.body) : {};
        if (url.pathname === '/api/config') return response({ hasApiKey: true, model: 'synthetic', stream: true, autoTranslate: false, idleMs: 120000 });
        if (url.pathname === '/api/papers') {
          const result = await window.__waitGate('papers', 'library'); if (result?.status) return response({ error: 'Synthetic library error' }, result.status);
          return response({ papers, folders: [...new Set(papers.map(p => p.folder).filter(Boolean))].map(path => ({ path })), dir: 'SYNTHETIC_PAPERS' });
        }
        if (url.pathname === '/api/state') return response({ docs: {} });
        if (url.pathname === '/api/profile') return response({ version: 1, items: [] });
        if (url.pathname === '/api/notes') return response({ items: [] });
        if (url.pathname === '/api/pdf') {
          const name = url.searchParams.get('name') || url.searchParams.get('path');
          const result = await window.__waitGate('pdf', name); if (result?.status) return response({ error: 'Synthetic PDF failure' }, result.status);
          return new Response(Uint8Array.from(atob(pdfs[name]), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'application/pdf' } });
        }
        if (url.pathname === '/api/attachment') {
          await window.__waitGate('attachment', url.href);
          return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII='), c => c.charCodeAt(0)),
            { headers: { 'Content-Type': 'image/png' } });
        }
        const key = `${url.searchParams.get('doc') || ''}::${url.searchParams.get('sid') || ''}`;
        if (url.pathname === '/api/session') {
          if (method === 'POST') {
            attempts.push({ key, body: structuredClone(body) });
            const result = await window.__waitGate('save', key, body); if (result?.status) return response({ error: 'Synthetic save failure', code: result.code }, result.status);
            if (__mockDeletedSessions.has(key)) return response({ code: 'SESSION_DELETED', error: 'Synthetic remote deletion' }, 409);
            const copy = structuredClone(body); store.set(key, copy); writes.push({ key, body: copy }); return response({ ok: true, session: copy });
          }
          if (method === 'PATCH') { const copy = { ...(store.get(key) || empty()), ...body }; store.set(key, copy); return response({ ok: true, session: copy }); }
          if (method === 'DELETE') { await window.__waitGate('delete', key); store.delete(key); __mockDeletedSessions.add(key); return response({ ok: true }); }
          await window.__waitGate('session-load', key);
          if (__mockDeletedSessions.has(key)) return response({ ...empty(), deleted: true });
          return response(structuredClone(store.get(key) || empty()));
        }
        if (url.pathname === '/api/sessions') {
          const scope = url.searchParams.get('doc') || '';
          return response({ sessions: [...store].filter(([k, value]) => (url.searchParams.get('scope') === 'all' || k.startsWith(`${scope}::`))
            && !k.endsWith('::__translate') && value.entries?.length).map(([key, value]) => ({ ...value,
              title: value.title || `Session ${key.split('::')[1]}`, sid: key.split('::')[1], fileKey: key.split('::')[0], count: value.entries.length })) });
        }
        if (url.pathname === '/api/chat') {
          const source = JSON.stringify(body.messages || []);
          if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) return response({ choices: [{ message: { content: '[]' } }] });
          const job = { body, source, aborted: false, done: false };
          const stream = new ReadableStream({ start(controller) { job.controller = controller; }, cancel() { job.aborted = true; } });
          init.signal?.addEventListener('abort', () => { job.aborted = true;
            if (![...__ignoreAbortMarkers].some(marker => source.includes(marker))) try { job.controller.error(new DOMException('aborted', 'AbortError')); } catch {}
          }, { once: true });
          requests.push(job); await window.__waitGate('model-start', source);
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return response({ ok: true, items: [], results: [] });
      };
    }, { papers, pdfs });
    await page.goto('http://prt-regression.test/?topbar=static', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(count => window.__ctx && __state.papers.length === count, { timeout: 30000 }, papers.length);
    const h = {
      page, papers, scratch, errors, pass,
      open: async id => { const paper = papers.find(p => p.docId === id); assert(paper); await page.evaluate(p => __ctx.openDoc(p), paper);
        await page.waitForFunction(id => __state.viewerDocId === id, { timeout: 30000 }, id); },
      beginOpen: id => page.evaluate(p => { window.__navigationPromise = __ctx.openDoc(p);
        window.__navigationPromises ||= []; __navigationPromises.push(window.__navigationPromise); }, papers.find(p => p.docId === id)),
      beginAsk: (text, { agent = false, range = 'current' } = {}) => page.evaluate(({ text, agent, range }) => {
        __ctx.setPanelVisible('chat', true); __ctx.setAgentRead(agent); __ctx.setScopeRange(range);
        const input = document.querySelector('#chatInput'); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
        window.__testSends ||= []; __testSends.push(__ctx.send());
      }, { text, agent, range }),
      waitRequest: (marker, predicate = 'any') => page.waitForFunction(({ marker, predicate }) => __mockChatRequests.some(r => r.source.includes(marker)
        && (predicate === 'any' || (predicate === 'tools' ? !!r.body.tools : !r.body.tools))), { timeout: 15000 }, { marker, predicate }),
      emit: (marker, options) => page.evaluate(({ marker, options }) => __emitModel(marker, options), { marker, options }),
      complete: marker => page.waitForFunction(marker => __state.sessionEntries.some(e => e.block === 'chat' && e.status === 'complete' && e.text?.includes(marker)), { timeout: 15000 }, marker),
      idle: () => page.waitForFunction(() => !__state.busy, { timeout: 15000 }),
      chatText: () => page.evaluate(() => document.querySelector('[data-block="chat"] .ai-body')?.textContent || ''),
      owner: () => page.evaluate(() => `${__ctx.currentFolderKey}::${__ctx.activeSession}`),
      rule: (kind, match = '', remaining = 1) => page.evaluate(rule => __mockRules.push(rule), { kind, match, remaining }),
      gate: (kind, match = '') => page.waitForFunction(({ kind, match }) => __mockGates.some(g => g.kind === kind && String(g.key).includes(match) && g.state === 'waiting'), { timeout: 15000 }, { kind, match }),
      release: (kind, match = '', value = null) => page.evaluate(({ kind, match, value }) => {
        const gate = __mockGates.find(g => g.kind === kind && String(g.key).includes(match) && g.state === 'waiting');
        if (!gate) throw Error(`Missing gate ${kind} ${match}`); gate.release(value);
      }, { kind, match, value }),
      reject: (kind, match = '') => page.evaluate(({ kind, match }) => {
        const gate = __mockGates.find(g => g.kind === kind && String(g.key).includes(match) && g.state === 'waiting');
        if (!gate) throw Error(`Missing gate ${kind} ${match}`); gate.reject();
      }, { kind, match }),
    };
    await run(h);
    assert.deepEqual(errors, [], 'no page errors');
    fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktop ? 'desktop' : 'source', checks, errors,
      writes: await page.evaluate(() => __mockWrites), reads: await page.evaluate(() => __mockPdfReads),
      gates: await page.evaluate(() => __mockGates.map(({ id, kind, key, state }) => ({ id, kind, key, state }))),
      requests: await page.evaluate(() => __mockChatRequests.map(({ body, aborted, done, failed }) => ({ body, aborted, done, failed }))) }, null, 2), 'utf8');
    console.log(`${tag}: ${checks.length}/${checks.length} passed; ${scratch}`);
  } catch (error) {
    fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
    if (page) {
      const diagnostic = await page.evaluate(() => ({ doc: window.__state?.doc, viewerDocId: window.__state?.viewerDocId,
        busy: window.__state?.busy, sid: window.__ctx?.activeSession, currentFolder: window.__ctx?.currentFolder,
        text: document.querySelector('[data-block="chat"] .ai-body')?.textContent,
        entries: window.__state?.sessionEntries, reads: window.__mockPdfReads,
        gates: window.__mockGates?.map(({ kind, key, state }) => ({ kind, key, state })), writes: window.__mockWrites,
        attempts: window.__mockSaveAttempts, requests: window.__mockChatRequests?.map(({ body, aborted, done, failed }) => ({ body, aborted, done, failed })) })).catch(() => null);
      fs.writeFileSync(path.join(scratch, 'diagnostic.json'), JSON.stringify({ errors, diagnostic }, null, 2), 'utf8');
      console.error(`Failure evidence: ${scratch}`);
    }
    throw error;
  } finally { await browser?.close(); await stopChild(child); }
}
