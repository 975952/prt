/** Cross-file routing and asynchronous ownership regressions with real PDFs.
 * node test/cross-file-chat.mjs [--desktop] [--case substring]
 * All library, model and persistence responses are synthetic and controllable.
 */
import assert from 'node:assert/strict';
import { withChatHarness } from './_chat-harness.mjs';

const filter = process.argv[process.argv.indexOf('--case') + 1];
const selected = name => !process.argv.includes('--case') || name.includes(filter);
await withChatHarness({ papers: [
  { docId: 'mobile', name: 'MobileNet.pdf', folder: 'courses', numPages: 9 },
  { docId: 'analog', name: '模电第七版_0.pdf', folder: 'courses', numPages: 320 },
  { docId: 'physics', name: 'Physics.pdf', folder: 'other', numPages: 6 },
  { docId: 'scan', name: 'ScanTextbook.pdf', folder: 'scans', numPages: 12, scanned: true },
  { docId: 'root-a', name: 'root-a.pdf', numPages: 3 },
  { docId: 'root-b', name: 'root-b.pdf', numPages: 3 },
] }, async h => {
  const { page } = h;
  const fresh = async (id = 'mobile') => { await h.open(id); await page.evaluate(() => __ctx.newSession({ silent: true })); await h.idle(); };
  const done = async (marker, text = `${marker} complete.`) => { await h.emit(marker, { text, done: true }); await h.complete(text); await h.idle(); };
  const live = marker => page.evaluate(marker => __mockChatRequests.find(r => r.source.includes(marker) && !r.done), marker);
  const tools = (marker, calls) => h.emit(marker, { toolCalls: calls, done: true, withTools: true });
  const readRequest = marker => page.evaluate(marker => __mockChatRequests.find(r => r.source.includes(marker))?.body, marker);
  const run = async (name, action) => { if (selected(name)) { await action(); h.pass(name); } };

  // Wrap actual PDF.js documents, including streamTextContent, without changing
  // production files. This measures page work, not just a facade method count.
  const installPdfProbe = async () => page.evaluate(async () => {
    const module = await import('/js/pdfview.js');
    if (!module.createPdfPaperAccess || !module.paperAccess) return false;
    const lib = await module.initPdfjs();
    const access = module.createPdfPaperAccess({ loadPdfjs: async () => ({ ...lib, getDocument(source) {
      const loading = lib.getDocument(source);
      const original = loading.promise;
      Object.defineProperty(loading, 'promise', { value: original.then(doc => {
        const originalGetPage = doc.getPage.bind(doc);
        const key = decodeURIComponent(String(source.url || source));
        doc.getPage = async number => {
          __mockPdfReads.push({ kind: 'page', key, page: number });
          const result = await __waitGate('page', `${key}#${number}`);
          if (result?.fail) throw Error('Synthetic requested page read failed');
          const pdfPage = await originalGetPage(number);
          if (!pdfPage.__probeInstalled) {
            pdfPage.__probeInstalled = true;
            for (const method of ['getTextContent', 'streamTextContent']) if (typeof pdfPage[method] === 'function') {
              const original = pdfPage[method].bind(pdfPage);
              pdfPage[method] = (...args) => { __mockPdfReads.push({ kind: method, key, page: number }); return original(...args); };
            }
          }
          return pdfPage;
        };
        return doc;
      }), configurable: true });
      return loading;
    } }) });
    await module.paperAccess.clear?.();
    for (const key of ['info', 'readPage', 'readPages', 'search', 'renderPageImage', 'release', 'clear']) {
      if (typeof access[key] === 'function') module.paperAccess[key] = access[key].bind(access);
    }
    window.__paperAccessProbe = access;
    return true;
  });
  await installPdfProbe();

  await run('named textbook page 278 overrides the nine-page visible paper without scanning the book', async () => {
    await fresh();
    await page.evaluate(() => { __mockPdfReads.length = 0; });
    await h.beginAsk('请讲解模电教材第278页。CROSS_PAGE_278'); await h.waitRequest('CROSS_PAGE_278');
    const request = JSON.stringify(await readRequest('CROSS_PAGE_278'));
    assert(request.includes('ANALOG_ONLY_PAGE_278'), 'first request includes the requested textbook page');
    assert(!request.includes('MOBILE_ONLY_PAGE_'), 'visible MobileNet text is not passed as requested page material');
    const reads = await page.evaluate(() => __mockPdfReads.filter(r => r.key.includes('模电')));
    assert(reads.some(r => r.page === 278), 'real PDF.js read of page 278 occurs');
    assert(reads.every(r => r.page === 278), `no whole-book pre-read: ${JSON.stringify(reads)}`);
    assert.equal(await page.evaluate(() => __state.doc.docId), 'mobile', 'source lookup does not navigate the reader');
    await done('CROSS_PAGE_278');
    await page.screenshot({ path: `${h.scratch}/cross-file-source.png`, fullPage: false });
  });

  await run('tool failure retains named source and requested page in compatibility fallback', async () => {
    await fresh();
    await h.beginAsk('请讲解模电教材第278页。CROSS_TOOL_FAILURE', { agent: true }); await h.waitRequest('CROSS_TOOL_FAILURE', 'tools');
    await page.evaluate(() => __failModel('CROSS_TOOL_FAILURE'));
    await page.waitForFunction(() => __mockChatRequests.some(r => r.source.includes('CROSS_TOOL_FAILURE') && !r.body.tools), { timeout: 15000 });
    const fallback = await page.evaluate(() => __mockChatRequests.find(r => r.source.includes('CROSS_TOOL_FAILURE') && !r.body.tools).source);
    assert(fallback.includes('ANALOG_ONLY_PAGE_278') && !fallback.includes('MOBILE_ONLY_PAGE_'));
    await done('CROSS_TOOL_FAILURE');
  });

  await run('cross-file follow-up inherits next page while current-page wording returns to the visible paper', async () => {
    await fresh();
    await h.beginAsk('请讲解模电教材第278页。FOLLOW_SOURCE_BASE'); await h.waitRequest('FOLLOW_SOURCE_BASE'); await done('FOLLOW_SOURCE_BASE');
    await h.beginAsk('下一页呢？FOLLOW_SOURCE_NEXT'); await h.waitRequest('FOLLOW_SOURCE_NEXT');
    let request = await page.evaluate(() => __mockChatRequests.find(r => r.source.includes('FOLLOW_SOURCE_NEXT')).body.messages.at(-1).content);
    assert(JSON.stringify(request).includes('ANALOG_ONLY_PAGE_279'), 'next page stays with previously discussed source');
    assert(!JSON.stringify(request).includes('MOBILE_ONLY_PAGE_'), 'visible file cannot replace inherited source');
    await done('FOLLOW_SOURCE_NEXT');
    await h.beginAsk('解释当前页。FOLLOW_SCREEN_PAGE'); await h.waitRequest('FOLLOW_SCREEN_PAGE');
    request = await page.evaluate(() => __mockChatRequests.find(r => r.source.includes('FOLLOW_SCREEN_PAGE')).body.messages.at(-1).content);
    assert(JSON.stringify(request).includes('MOBILE_ONLY_PAGE_'), 'explicit current-page wording uses the visible document');
    assert(!JSON.stringify(request).includes('ANALOG_ONLY_PAGE_279'), 'prior source is only history, not current material');
    await done('FOLLOW_SCREEN_PAGE');
  });

  await run('cross-file answer source buttons navigate to the target file and page', async () => {
    await fresh();
    await h.beginAsk('请讲解模电教材第278页。SOURCE_LINK_TARGET'); await h.waitRequest('SOURCE_LINK_TARGET');
    await done('SOURCE_LINK_TARGET', 'SOURCE_LINK_TARGET complete. 〔p.278〕');
    const entryId = await page.evaluate(() => __state.sessionEntries.find(e => e.kind !== 'user' && e.text?.includes('SOURCE_LINK_TARGET'))?.id);
    await page.evaluate(id => {
      const entry = [...document.querySelectorAll('.msg')].find(e => e.__sessionRecord?.id === id);
      if (!entry?.querySelector('.role .pg')) throw Error('Source button missing');
      entry.querySelector('.role .pg').click();
    }, entryId);
    await page.waitForFunction(() => __state.doc?.docId === 'analog' && __state.viewerDocId === 'analog' && __viewer.current === 278);
    assert.equal(await page.evaluate(id => [...document.querySelectorAll('.msg')].find(e => e.__sessionRecord?.id === id)?.__sessionRecord.docId, entryId), 'analog');
    await h.open('mobile');
    await page.evaluate(id => {
      const entry = [...document.querySelectorAll('.msg')].find(e => e.__sessionRecord?.id === id);
      const citation = entry?.querySelector('.page-ref[data-page="278"]');
      if (!citation) throw Error('Page citation missing');
      citation.click();
    }, entryId);
    await page.waitForFunction(() => __state.doc?.docId === 'analog' && __state.viewerDocId === 'analog' && __viewer.current === 278);
  });

  await run('scanned cross-file explicit page is attached to the first model request without scanning the book', async () => {
    await fresh(); await page.evaluate(() => { __mockPdfReads.length = 0; });
    await h.beginAsk('Explain ScanTextbook.pdf page 8. SCANNED_FIRST_IMAGE', { agent: true }); await h.waitRequest('SCANNED_FIRST_IMAGE', 'tools');
    const request = await readRequest('SCANNED_FIRST_IMAGE');
    const content = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    assert(content.some(part => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/')), 'first request includes the actual source page image');
    assert(content.some(part => part.type === 'text' && part.text.includes('scans/ScanTextbook.pdf') && part.text.includes('p.8')), 'source label is paired with image');
    const reads = await page.evaluate(() => __mockPdfReads.filter(r => r.key.includes('ScanTextbook')));
    assert(reads.length && reads.every(row => row.page === 8), 'only requested scanned page is rendered');
    assert.equal(await page.evaluate(() => __state.doc.docId), 'mobile');
    await done('SCANNED_FIRST_IMAGE');
  });

  await run('Stop followed by immediate retry ignores late old output and reuses the original answer entry', async () => {
    await fresh(); await page.evaluate(() => __ignoreAbortMarkers.add('STOP_RETRY_OWNER'));
    await h.beginAsk('STOP_RETRY_OWNER'); await h.waitRequest('STOP_RETRY_OWNER');
    await h.emit('STOP_RETRY_OWNER', { text: 'Initial partial. ' });
    const originalId = await page.evaluate(() => __state.sessionEntries.find(e => e.kind !== 'user' && e.status === 'pending')?.id);
    await page.click('#stopBtn'); await h.idle();
    await page.evaluate(id => {
      const entry = [...document.querySelectorAll('.msg')].find(e => e.__sessionRecord?.id === id);
      const retry = [...entry.querySelectorAll('.acts button')].find(button => /Regenerate|Retry/i.test(button.textContent));
      if (!retry) throw Error('Stopped answer retry missing'); retry.click();
    }, originalId);
    await page.waitForFunction(() => __mockChatRequests.filter(r => r.source.includes('STOP_RETRY_OWNER')).length === 2);
    await h.emit('STOP_RETRY_OWNER', { text: 'FORBIDDEN_OLD_RETRY_TEXT', done: true, late: true });
    await h.emit('STOP_RETRY_OWNER', { text: 'Fresh retry complete.', done: true });
    await h.complete('Fresh retry complete.'); await h.idle();
    const rows = await page.evaluate(() => __state.sessionEntries.filter(e => e.kind !== 'user'));
    assert.equal(rows.length, 1, 'retry keeps the existing answer card');
    assert.equal(rows[0].id, originalId); assert.equal(rows[0].text, 'Fresh retry complete.');
    assert(!(await h.chatText()).includes('FORBIDDEN_OLD_RETRY_TEXT'));
  });

  await run('tool timeout retains requested textbook material and releases the conversation', async () => {
    await fresh();
    await page.evaluate(() => { window.__agentTestLimits = { callTimeoutMs: 500, totalTimeoutMs: 1500 }; });
    await h.beginAsk('请讲解模电教材第278页。CROSS_TOOL_TIMEOUT', { agent: true }); await h.waitRequest('CROSS_TOOL_TIMEOUT', 'tools');
    await page.waitForFunction(() => __mockChatRequests.some(r => r.source.includes('CROSS_TOOL_TIMEOUT') && !r.body.tools), { timeout: 15000 });
    const fallback = await page.evaluate(() => __mockChatRequests.find(r => r.source.includes('CROSS_TOOL_TIMEOUT') && !r.body.tools).source);
    assert(fallback.includes('ANALOG_ONLY_PAGE_278') && !fallback.includes('MOBILE_ONLY_PAGE_'));
    await done('CROSS_TOOL_TIMEOUT');
    await page.evaluate(() => { delete window.__agentTestLimits; });
  });

  await run('retry after switching files within a shared conversation preserves the original source', async () => {
    await fresh();
    await h.beginAsk('Explain this page. RETRY_SHARED_SOURCE'); await h.waitRequest('RETRY_SHARED_SOURCE'); await done('RETRY_SHARED_SOURCE');
    const originalId = await page.evaluate(() => __state.sessionEntries.find(e => e.kind !== 'user' && e.text?.includes('RETRY_SHARED_SOURCE'))?.id);
    await h.open('analog');
    await page.evaluate(id => {
      const entry = [...document.querySelectorAll('.msg')].find(e => e.__sessionRecord?.id === id);
      const retry = [...entry.querySelectorAll('.acts button')].find(button => /Regenerate|Retry/i.test(button.textContent));
      if (!retry) throw Error('Shared conversation answer retry missing'); retry.click();
    }, originalId);
    await page.waitForFunction(() => __mockChatRequests.filter(r => r.source.includes('RETRY_SHARED_SOURCE')).length === 2);
    const retry = await page.evaluate(() => __mockChatRequests.filter(r => r.source.includes('RETRY_SHARED_SOURCE')).at(-1).source);
    assert(retry.includes('MOBILE_ONLY_PAGE_1'), 'retry binds to the first question source');
    assert(!retry.includes('ANALOG_ONLY_PAGE_'), 'visible textbook is not substituted for retry material');
    await done('RETRY_SHARED_SOURCE', 'Shared source retry complete.');
    assert.equal(await page.evaluate(() => __state.doc.docId), 'analog', 'retry does not change the visible file');
    assert.equal(await page.evaluate(id => __state.sessionEntries.find(e => e.id === id)?.docId, originalId), 'mobile');
  });

  await run('explicit comparison keeps distinct requested files accessible in the same generation', async () => {
    await fresh();
    await h.beginAsk('Compare MobileNet.pdf page 2 and 模电第七版_0.pdf page 278. MULTI_SOURCE_COMPARE', { agent: true });
    await h.waitRequest('MULTI_SOURCE_COMPARE', 'tools');
    const initial = JSON.stringify(await readRequest('MULTI_SOURCE_COMPARE'));
    assert(initial.includes('MOBILE_ONLY_PAGE_2') && initial.includes('ANALOG_ONLY_PAGE_278'), 'each explicitly named file keeps its own requested page');
    assert(!initial.includes('ANALOG_ONLY_PAGE_2 '), 'first file page number is never applied to the second file');
    await tools('MULTI_SOURCE_COMPARE', [{ id: 'compare-book', name: 'read_other_paper', args: { name: 'courses/模电第七版_0.pdf', page: 278 } }]);
    await page.waitForFunction(() => __mockChatRequests.some(r => r.source.includes('MULTI_SOURCE_COMPARE') && r.body.messages.some(m => m.role === 'tool')));
    const request = await page.evaluate(() => __mockChatRequests.find(r => r.source.includes('MULTI_SOURCE_COMPARE') && r.body.messages.some(m => m.role === 'tool')).body);
    assert(JSON.stringify(request.messages).includes('MOBILE_ONLY_PAGE_2'), 'first named source remains in model context');
    const result = JSON.parse(request.messages.find(m => m.role === 'tool' && m.tool_call_id === 'compare-book').content);
    assert(result.text?.includes('ANALOG_ONLY_PAGE_278'), JSON.stringify(result));
    assert.equal(result.name, 'courses/模电第七版_0.pdf');
    await done('MULTI_SOURCE_COMPARE');
  });

  await run('switch during requested-page preparation preserves original conversation and target', async () => {
    await fresh(); await page.evaluate(() => __paperAccessProbe?.clear());
    const owner = await h.owner();
    await h.rule('page', '模电第七版_0.pdf#278');
    await h.beginAsk('请讲解模电教材第278页。CROSS_PREPARATION_SWITCH'); await h.gate('page', '#278');
    await h.open('physics');
    assert(!(await h.chatText()).includes('CROSS_PREPARATION_SWITCH'));
    await h.release('page', '#278'); await h.waitRequest('CROSS_PREPARATION_SWITCH');
    const request = JSON.stringify(await readRequest('CROSS_PREPARATION_SWITCH'));
    assert(request.includes('ANALOG_ONLY_PAGE_278') && !request.includes('PHYSICS_ONLY_PAGE_'));
    await h.emit('CROSS_PREPARATION_SWITCH', { text: 'Prepared background final.', done: true });
    await page.waitForFunction(({ owner }) => __mockWrites.some(w => w.key === owner
      && w.body.entries.some(e => e.text?.includes('Prepared background final.'))), {}, { owner });
    assert(!(await h.chatText()).includes('Prepared background final.'));
    await h.open('mobile'); await h.complete('Prepared background final.'); await h.idle();
  });

  await run('requested-page failure reports failure without answering from the visible paper', async () => {
    await fresh(); await page.evaluate(() => __paperAccessProbe?.clear());
    await h.rule('page', '模电第七版_0.pdf#279');
    await h.beginAsk('请讲解模电教材第279页。CROSS_PAGE_FAILURE'); await h.gate('page', '#279');
    await h.release('page', '#279', { fail: true });
    await page.waitForFunction(() => __state.sessionEntries.some(e => e.block === 'chat' && e.status === 'failed'), { timeout: 15000 });
    assert.equal(await page.evaluate(() => __mockChatRequests.some(r => r.source.includes('CROSS_PAGE_FAILURE')
      && r.source.includes('MOBILE_ONLY_PAGE_'))), false);
    await h.idle();
  });

  await run('rapid A-B-A while B waits for save keeps the latest A navigation', async () => {
    await fresh(); await h.beginAsk('NAVIGATION_SAVE_RACE'); await h.waitRequest('NAVIGATION_SAVE_RACE'); await done('NAVIGATION_SAVE_RACE');
    const owner = await h.owner(); await page.evaluate(() => __ctx.saveSessionNow());
    await h.rule('save', owner);
    await h.beginOpen('physics'); await h.gate('save', owner);
    await h.beginOpen('mobile');
    await h.release('save', owner);
    await page.waitForFunction(() => __state.viewerDocId === 'mobile' && __state.doc.docId === 'mobile');
    await page.evaluate(() => Promise.all(window.__navigationPromises));
    assert.equal(await page.evaluate(() => __state.doc.docId), 'mobile');
    assert((await h.chatText()).includes('NAVIGATION_SAVE_RACE complete.'));
  });

  await run('new-conversation save released after folder switch cannot change destination conversation', async () => {
    await fresh(); await h.beginAsk('NEW_SESSION_SAVE_RACE'); await h.waitRequest('NEW_SESSION_SAVE_RACE'); await done('NEW_SESSION_SAVE_RACE');
    const owner = await h.owner(); await page.evaluate(() => __ctx.saveSessionNow());
    await h.rule('save', owner);
    await page.evaluate(() => { window.__newSessionPromise = __ctx.newSession({ silent: true }); }); await h.gate('save', owner);
    await h.beginOpen('physics');
    await h.release('save', owner);
    await page.waitForFunction(() => __state.viewerDocId === 'physics');
    const destination = await h.owner();
    await page.evaluate(() => window.__newSessionPromise);
    assert.equal(await h.owner(), destination);
    assert(!(await h.chatText()).includes('NEW_SESSION_SAVE_RACE'));
  });

  await run('background stream error and stopped late tokens never enter another conversation', async () => {
    await fresh(); await h.beginAsk('BACKGROUND_ERROR_A'); await h.waitRequest('BACKGROUND_ERROR_A');
    await h.emit('BACKGROUND_ERROR_A', { text: 'Origin partial. ' });
    await h.open('physics'); await h.beginAsk('FOREGROUND_OK_B'); await h.waitRequest('FOREGROUND_OK_B');
    await page.evaluate(() => __failModel('BACKGROUND_ERROR_A'));
    await done('FOREGROUND_OK_B');
    assert(!(await h.chatText()).includes('Origin partial.'));
    assert.equal(await page.evaluate(() => __state.sessionEntries.some(e => e.status === 'failed')), false);
    await h.open('mobile');
    await page.waitForFunction(() => __state.sessionEntries.some(e => e.status === 'failed'));
    await page.evaluate(() => __ctx.newSession({ silent: true }));
    await page.evaluate(() => __ignoreAbortMarkers.add('STOP_LATE_A'));
    await h.beginAsk('STOP_LATE_A'); await h.waitRequest('STOP_LATE_A');
    await page.click('#stopBtn');
    await h.emit('STOP_LATE_A', { text: 'FORBIDDEN_LATE_STOP_TEXT', done: true, late: true });
    await h.idle();
    assert(!(await h.chatText()).includes('FORBIDDEN_LATE_STOP_TEXT'));
  });

  await run('closing the originating tab while tools wait retains its PDF for the same conversation', async () => {
    await fresh(); await h.beginAsk('CLOSE_TAB_TOOLS_A', { agent: true }); await h.waitRequest('CLOSE_TAB_TOOLS_A', 'tools');
    await h.open('analog');
    await page.evaluate(() => __ctx.closeTab('mobile'));
    assert.equal(await page.evaluate(() => __state.doc.docId), 'analog');
    await tools('CLOSE_TAB_TOOLS_A', [{ id: 'closed-origin-page', name: 'read_page', args: { page: 9 } }]);
    await page.waitForFunction(() => __mockChatRequests.some(r => r.source.includes('CLOSE_TAB_TOOLS_A')
      && r.body.messages.some(m => m.role === 'tool')), { timeout: 15000 });
    const result = await page.evaluate(() => JSON.parse(__mockChatRequests.find(r => r.source.includes('CLOSE_TAB_TOOLS_A')
      && r.body.messages.some(m => m.role === 'tool')).body.messages.find(m => m.role === 'tool').content));
    assert(result.text?.includes('MOBILE_ONLY_PAGE_9'), JSON.stringify(result));
    await done('CLOSE_TAB_TOOLS_A');
  });

  await run('attachment hydration released after navigation cannot append stale session messages', async () => {
    await fresh();
    const sid = 'hydration-fixture', marker = 'STALE_HYDRATION_ANSWER';
    await page.evaluate(({ sid, marker }) => {
      __mockSessions.set(`${__ctx.currentFolderKey}::${sid}`, { entries: [
        { id: 'hydrate-user', block: 'chat', kind: 'user', text: marker, docId: 'mobile', docTitle: 'MobileNet.pdf',
          shots: [{ id: 'a'.repeat(32), w: 1, h: 1 }], status: 'complete' },
      ], history: [], updatedAt: Date.now() });
    }, { sid, marker });
    await h.rule('attachment', 'a'.repeat(32));
    await page.evaluate(sid => { window.__hydrateSwitchPromise = __ctx.switchSession(sid); }, sid);
    await h.gate('attachment', 'a'.repeat(32));
    await h.open('physics'); const destination = await h.owner();
    await h.release('attachment', 'a'.repeat(32)); await page.evaluate(() => window.__hydrateSwitchPromise);
    assert.equal(await h.owner(), destination);
    assert(!(await h.chatText()).includes(marker));
    assert.equal(await page.evaluate(marker => __state.sessionEntries.some(e => e.text?.includes(marker)), marker), false);
  });

  await run('deleting a background conversation survives a delayed prior save and discards late output', async () => {
    await fresh(); await h.beginAsk('DELETE_SAVE_A'); await h.waitRequest('DELETE_SAVE_A');
    const owner = await h.owner(), sid = await page.evaluate(() => __ctx.activeSession);
    await page.evaluate(() => __ctx.newSession({ silent: true }));
    await h.rule('save', owner);
    await h.emit('DELETE_SAVE_A', { text: 'Deleted final must not return.', done: true }); await h.gate('save', owner);
    await page.evaluate(sid => { window.__deletePromise = __ctx.deleteSession(sid, { confirm: false }); }, sid);
    await h.release('save', owner); await page.evaluate(() => window.__deletePromise);
    assert.equal(await page.evaluate(owner => __mockSessions.has(owner), owner), false);
    assert(!(await h.chatText()).includes('Deleted final must not return.'));
    await page.evaluate(() => __ignoreAbortMarkers.add('DELETE_LATE_A'));
    await h.beginAsk('DELETE_LATE_A'); await h.waitRequest('DELETE_LATE_A');
    const lateOwner = await h.owner(), lateSid = await page.evaluate(() => __ctx.activeSession);
    await page.evaluate(() => __ctx.newSession({ silent: true }));
    await page.evaluate(sid => __ctx.deleteSession(sid, { confirm: false }), lateSid);
    await h.emit('DELETE_LATE_A', { text: 'FORBIDDEN_DELETED_LATE_OUTPUT', done: true, late: true });
    await page.waitForFunction(() => !__ctx.chatJobs.size, { timeout: 15000 });
    assert.equal(await page.evaluate(owner => __mockSessions.has(owner), lateOwner), false);
    assert(!(await h.chatText()).includes('FORBIDDEN_DELETED_LATE_OUTPUT'));
  });

  await run('completed background result waits behind prior save and never downgrades to pending', async () => {
    await fresh(); await h.beginAsk('SAVE_ORDER_A'); await h.waitRequest('SAVE_ORDER_A');
    const owner = await h.owner(); await h.rule('save', owner);
    await page.evaluate(() => { window.__normalSavePromise = __ctx.saveSessionNow(); }); await h.gate('save', owner);
    await h.emit('SAVE_ORDER_A', { text: 'Final save order answer.', done: true }); await h.complete('Final save order answer.');
    await h.release('save', owner); await page.evaluate(() => window.__normalSavePromise);
    await page.waitForFunction(owner => __mockSessions.get(owner)?.entries.some(e => e.status === 'complete' && e.text === 'Final save order answer.'), {}, owner);
    const saved = await page.evaluate(owner => __mockSessions.get(owner), owner);
    assert(saved.entries.some(e => e.status === 'complete' && e.text === 'Final save order answer.'));
    await h.idle();
  });

  await run('a deleted-session save response retires its running job and allows a fresh conversation', async () => {
    await fresh(); await page.evaluate(() => __ignoreAbortMarkers.add('REMOTE_DELETE_409'));
    await h.beginAsk('REMOTE_DELETE_409'); await h.waitRequest('REMOTE_DELETE_409');
    const owner = await h.owner(); await h.rule('save', owner);
    await page.evaluate(() => { window.__remoteDeleteSave = __ctx.saveSessionNow(); }); await h.gate('save', owner);
    await page.evaluate(owner => { __mockDeletedSessions.add(owner); __mockSessions.delete(owner); }, owner);
    await h.release('save', owner, { status: 409, code: 'SESSION_DELETED' });
    await page.evaluate(() => window.__remoteDeleteSave);
    await page.waitForFunction(owner => `${__ctx.currentFolderKey}::${__ctx.activeSession}` !== owner && !__state.busy, {}, owner);
    await h.emit('REMOTE_DELETE_409', { text: 'FORBIDDEN_REMOTE_409_LATE', done: true, late: true });
    assert(!(await h.chatText()).includes('REMOTE_DELETE_409'));
    await h.beginAsk('AFTER_REMOTE_409'); await h.waitRequest('AFTER_REMOTE_409'); await done('AFTER_REMOTE_409');
    assert.equal(await page.evaluate(owner => __mockSessions.has(owner), owner), false, 'old session remains deleted');
    assert(!(await h.chatText()).includes('FORBIDDEN_REMOTE_409_LATE'));
  });

  await run('a remote deletion broadcast stops the old stream and never revives its conversation', async () => {
    await fresh(); await page.evaluate(() => __ignoreAbortMarkers.add('REMOTE_DELETE_BROADCAST'));
    await h.beginAsk('REMOTE_DELETE_BROADCAST'); await h.waitRequest('REMOTE_DELETE_BROADCAST');
    const owner = await h.owner();
    await page.evaluate(owner => {
      __mockDeletedSessions.add(owner); __mockSessions.delete(owner);
      const [scope, sid] = owner.split('::');
      window.__remoteDeleteBus = new BroadcastChannel('prt.reader.windows');
      __remoteDeleteBus.postMessage({ type: 'session-saved', kind: 'chat', deleted: true, sender: 'synthetic-other-window', scope, sid });
    }, owner);
    await page.waitForFunction(owner => `${__ctx.currentFolderKey}::${__ctx.activeSession}` !== owner && !__state.busy, {}, owner);
    await h.emit('REMOTE_DELETE_BROADCAST', { text: 'FORBIDDEN_REMOTE_BROADCAST_LATE', done: true, late: true });
    await h.beginAsk('AFTER_REMOTE_BROADCAST'); await h.waitRequest('AFTER_REMOTE_BROADCAST'); await done('AFTER_REMOTE_BROADCAST');
    assert.equal(await page.evaluate(owner => __mockSessions.has(owner), owner), false);
    assert(!(await h.chatText()).includes('FORBIDDEN_REMOTE_BROADCAST_LATE'));
    await page.evaluate(() => __remoteDeleteBus.close());
  });

  await run('failed save can retry the same owner while another conversation stays unchanged', async () => {
    await fresh(); await h.beginAsk('SAVE_FAILURE_A'); await h.waitRequest('SAVE_FAILURE_A');
    const owner = await h.owner(); await h.rule('save', owner);
    await h.emit('SAVE_FAILURE_A', { text: 'Recoverable final answer.', done: true }); await h.complete('Recoverable final answer.');
    await h.gate('save', owner); await h.release('save', owner, { status: 503 }); await h.idle();
    assert((await h.chatText()).includes('Recoverable final answer.'));
    await h.open('physics'); const otherOwner = await h.owner();
    await page.evaluate(owner => {
      const view = __ctx.chatViews.get(JSON.stringify(owner.split('::')));
      if (!view) throw Error('Recoverable source view missing');
    }, owner);
    await h.open('mobile'); await page.evaluate(() => __ctx.saveSessionNow());
    assert.equal(await page.evaluate(owner => __mockSessions.get(owner)?.entries.some(e => e.text === 'Recoverable final answer.'), owner), true);
    assert.equal(await page.evaluate(owner => __mockWrites.filter(w => w.key === owner).some(w => w.body.entries.some(e => e.text === 'Recoverable final answer.')), otherOwner), false);
  });
});
