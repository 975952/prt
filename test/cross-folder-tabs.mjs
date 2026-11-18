/** Cross-folder workspace/session matrix with real PDFs and synthetic model streams.
 * node test/cross-folder-tabs.mjs [--desktop]
 * Browser state and all persistence are isolated by _chat-harness.mjs.
 */
import assert from 'node:assert/strict';
import { withChatHarness } from './_chat-harness.mjs';

const papers = [
  { docId: 'folder-a', name: 'folder-a.pdf', folder: 'folder-one' },
  { docId: 'folder-b', name: 'folder-b.pdf', folder: 'folder-two' },
  { docId: 'root-one', name: 'root-one.pdf' },
  { docId: 'root-two', name: 'root-two.pdf' },
];

await withChatHarness({ tag: 'cross-folder-tabs', papers }, async h => {
  const { page } = h;
  // Runs after the harness fixture on every reload. Each matrix cell begins with
  // a fresh workspace, session map, fake backend and the requested preferences.
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    const cell = JSON.parse(sessionStorage.getItem('test.crossFolderCell') || '{}');
    for (const key of ['reader.workspace.v1', 'reader.activeSession', 'reader.currentFolder.v1']) localStorage.removeItem(key);
    localStorage.setItem('reader.session.scopeMode', cell.scope || 'folder');
    localStorage.setItem('reader.session.onEnter', cell.onEnter || 'resume');
  });
  const activeSid = () => page.evaluate(() => __ctx.activeSession);
  const tabIds = () => page.evaluate(() => __ctx.tabs.map(tab => tab.docId));
  const activate = async id => {
    await page.click(`#tabStrip .doc-tab[data-doc="${id}"] .tab-title`);
    await page.waitForFunction(id => __state.viewerDocId === id && document.body.classList.contains('reading'), {}, id);
  };
  const capture = async marker => page.evaluate(marker => {
    const record = __state.sessionEntries.find(row => row.kind !== 'user' && row.retry?.question === marker);
    const node = [...document.querySelectorAll('.msg')].find(row => row.__sessionRecord === record);
    const job = [...__ctx.chatJobs.values()].find(row => row.pending?.question === marker);
    if (!record || !node || !job) throw Error(`Missing pending conversation: ${marker}`);
    window.__crossFolderEntries ||= {};
    __crossFolderEntries[marker] = { record, node, job };
    return { sid: __ctx.activeSession, id: record.id, scope: job.scope, key: job.key };
  }, marker);
  const assertLive = async (marker, owner, visible) => {
    const result = await page.evaluate(({ marker, key }) => {
      const saved = __crossFolderEntries[marker];
      const displayed = __state.sessionEntries.find(row => row.id === saved.record.id);
      return { running: __ctx.chatJobs.get(key) === saved.job, aborted: saved.job.controller.signal.aborted,
        sameRecord: displayed === saved.record, connected: saved.node.isConnected,
        status: saved.record.status, sid: __ctx.activeSession };
    }, { marker, key: owner.key });
    assert.equal(result.running, true, `${marker}: same background job`);
    assert.equal(result.aborted, false, `${marker}: task was not cancelled`);
    assert.equal(result.status, 'pending', `${marker}: task remains pending until the fake stream finishes`);
    assert.equal(result.connected, visible, `${marker}: original message node visibility`);
    assert.equal(result.sameRecord, visible, `${marker}: visible entries have the correct owner`);
    if (visible) assert.equal(result.sid, owner.sid, `${marker}: original active session`);
  };
  const finish = async (marker, owner, prefix) => {
    await h.emit(marker, { text: 'Finished.', done: true });
    await h.complete(`${prefix}Finished.`);
    await h.idle();
    await page.evaluate(() => __ctx.saveSessionNow());
    const result = await page.evaluate(({ marker, owner }) => {
      const saved = __crossFolderEntries[marker];
      const stored = __mockSessions.get(`${owner.scope}::${owner.sid}`);
      return { connected: saved.node.isConnected, status: saved.record.status, text: saved.record.text,
        sid: __ctx.activeSession, stored: stored?.entries?.find(row => row.id === owner.id),
        copies: [...__mockSessions].filter(([, value]) => value.entries?.some(row => row.id === owner.id)).map(([key]) => key) };
    }, { marker, owner });
    assert.equal(result.connected, true); assert.equal(result.status, 'complete');
    assert.equal(result.sid, owner.sid); assert.equal(result.text, `${prefix}Finished.`);
    assert.equal(result.stored?.text, result.text);
    assert.deepEqual(result.copies, [`${owner.scope}::${owner.sid}`], `${marker}: no cross-folder persistence copy`);
  };

  for (const scope of ['paper', 'folder', 'global']) {
    for (const onEnter of ['new', 'choose', 'resume']) {
      const label = `${scope}/${onEnter}`;
      await page.evaluate(cell => sessionStorage.setItem('test.crossFolderCell', JSON.stringify(cell)), { scope, onEnter });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__ctx && __state.papers.length === 4);
      assert.deepEqual(await page.evaluate(() => ({ scope: localStorage.getItem('reader.session.scopeMode'),
        onEnter: localStorage.getItem('reader.session.onEnter') })), { scope, onEnter });
      await h.open('folder-a');
      await page.evaluate(() => __ctx.newSession({ silent: true, fromEntry: true }));
      const marker = `CROSS_FOLDER_${scope}_${onEnter}`;
      const prefix = `${marker} First. Hidden continuation. `;
      await h.beginAsk(marker); await h.waitRequest(marker);
      await h.emit(marker, { text: `${marker} First. ` });
      const owner = await capture(marker);

      await h.open('folder-b');
      assert.deepEqual(await tabIds(), ['folder-a', 'folder-b'], `${label}: opening another folder retains A`);
      await assertLive(marker, owner, scope === 'global');
      if (scope !== 'global') assert.notEqual(await activeSid(), owner.sid, `${label}: B uses a distinct conversation slot`);
      await h.emit(marker, { text: 'Hidden continuation. ' });
      await activate('folder-a');
      assert.deepEqual(await tabIds(), ['folder-a', 'folder-b'], `${label}: activating A retains B`);
      await assertLive(marker, owner, true);
      assert.equal(await page.evaluate(marker => __crossFolderEntries[marker].node.textContent.includes('Hidden continuation.'), marker), true);
      h.pass(`${label}: A-B-A preserves both tabs, original session, original message DOM and live output`);

      // Explicit folder selection browses Home; the reading/session owner stays A
      // until an actual file is opened from that directory.
      const beforeBrowse = await page.evaluate(() => ({ doc: __state.doc.docId, folder: __ctx.currentFolder,
        sid: __ctx.activeSession, sequence: __state.openSeq }));
      await page.evaluate(() => __ctx.switchFolder('folder-two'));
      assert.deepEqual(await page.evaluate(() => ({ doc: __state.doc.docId, folder: __ctx.currentFolder,
        sid: __ctx.activeSession, sequence: __state.openSeq })), beforeBrowse, `${label}: folder browsing preserves reading owner`);
      assert.equal(await page.evaluate(() => !document.body.classList.contains('reading')
        && document.querySelector('[data-home-folder="folder-two"]')?.getAttribute('aria-pressed') === 'true'), true);
      assert.deepEqual(await tabIds(), ['folder-a', 'folder-b']);
      await assertLive(marker, owner, true);
      await activate('folder-a');
      await assertLive(marker, owner, true);
      h.pass(`${label}: folder picker browses Home without closing tabs or changing a running conversation owner`);

      await h.open('root-one');
      assert.deepEqual(await tabIds(), ['folder-a', 'folder-b', 'root-one']);
      await assertLive(marker, owner, scope === 'global');
      let rootMarker, rootOwner;
      if (scope !== 'global') {
        rootMarker = `ROOT_FILES_${scope}_${onEnter}`;
        await h.beginAsk(rootMarker); await h.waitRequest(rootMarker);
        await h.emit(rootMarker, { text: `${rootMarker} First. ` });
        rootOwner = await capture(rootMarker);
      }
      await h.open('root-two');
      assert.deepEqual(await tabIds(), ['folder-a', 'folder-b', 'root-one', 'root-two']);
      if (scope === 'global') await assertLive(marker, owner, true);
      else await assertLive(rootMarker, rootOwner, scope === 'folder');
      await activate('root-one');
      if (scope !== 'global') {
        await assertLive(rootMarker, rootOwner, true);
        await finish(rootMarker, rootOwner, `${rootMarker} First. `);
      } else await assertLive(marker, owner, true);
      await activate('folder-a');
      await assertLive(marker, owner, true);
      assert.deepEqual(await tabIds(), ['folder-a', 'folder-b', 'root-one', 'root-two']);
      await finish(marker, owner, prefix);
      h.pass(`${label}: root files retain all workspace tabs and obey paper/folder/global ownership while other work continues`);
    }
  }
});
