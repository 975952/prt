/** Home navigation keeps ready document work alive and invalidates only stale opens. */
import assert from 'node:assert/strict';
import { withChatHarness } from './_chat-harness.mjs';

const papers = [
  { docId: 'home-ready', name: 'home-ready.pdf' },
  { docId: 'home-pending', name: 'home-pending.pdf' },
  { docId: 'switch-pending', name: 'switch-pending.pdf' },
  { docId: 'home-retry', name: 'home-retry.pdf' },
  { docId: 'switch-retry', name: 'switch-retry.pdf' },
];

await withChatHarness({ tag: 'home-background', papers }, async h => {
  const { page } = h;
  const home = async () => {
    await page.click('#homeBtn');
    await page.waitForFunction(() => !document.body.classList.contains('reading'));
  };
  const returnToReady = async () => {
    await page.click('#tabStrip .doc-tab[data-doc="home-ready"] .tab-title');
    await page.waitForFunction(() => document.body.classList.contains('reading') && __state.viewerDocId === 'home-ready');
  };
  await h.open('home-ready');
  await page.evaluate(async () => {
    await __ctx.newSession({ silent: true });
    __ctx.setAgentRead(false);
    __ctx.setPanelVisible('translate', true);
  });

  // The same real entry, controller and PDF must survive every view-only round trip.
  for (const kind of ['translate', 'explain']) {
    const marker = `HOME_BACKGROUND_${kind.toUpperCase()}`;
    await page.evaluate(({ kind, marker }) => {
      const selection = { text: marker, cleanText: marker, page: 1,
        box: { left: 410, right: 610, top: 200, bottom: 230 } };
      window.__homeWork = kind === 'translate' ? __ctx.doTranslate(selection, { force: true }) : __ctx.doExplain(selection);
      window.__homePdf = __viewer.pdf;
    }, { kind, marker });
    await h.waitRequest(marker);
    const before = await page.evaluate(marker => {
      const record = __state.sessionEntries.find(row => row.quote === marker);
      window.__homeEntry = [...document.querySelectorAll('.msg')].find(node => node.__sessionRecord === record);
      if (!record || !__homeEntry) throw Error(`Missing pending entry: ${marker}`);
      return { sequence: __state.openSeq, id: record.id };
    }, marker);

    await home();
    assert.equal(await page.evaluate(({ marker, sequence }) => __state.openSeq === sequence
      && !__mockChatRequests.find(row => row.source.includes(marker)).aborted, { marker, sequence: before.sequence }), true);
    await h.emit(marker, { text: `${marker} first. ` });
    await page.waitForFunction(marker => __homeEntry.textContent.includes(`${marker} first.`), {}, marker);
    await returnToReady();
    assert.equal(await page.evaluate(sequence => __state.openSeq === sequence && __viewer.pdf === __homePdf
      && __homeEntry.isConnected, before.sequence), true, `${kind}: Home return preserves task and DOM identities`);

    // Re-clicking the already active tab is also only a presentation action.
    await returnToReady();
    await h.emit(marker, { text: 'Second part. ' });
    await page.waitForFunction(() => __homeEntry.textContent.includes('Second part.'));
    await home();
    await h.emit(marker, { text: 'Finished while hidden.', done: true });
    await page.evaluate(() => window.__homeWork);
    await h.idle();
    const hidden = await page.evaluate(({ marker, sequence }) => ({
      home: !document.body.classList.contains('reading'), sequence: __state.openSeq,
      sameSequence: __state.openSeq === sequence, samePdf: __viewer.pdf === __homePdf,
      aborted: __mockChatRequests.find(row => row.source.includes(marker)).aborted,
      status: __homeEntry.__sessionRecord.status, text: __homeEntry.__sessionRecord.text,
    }), { marker, sequence: before.sequence });
    assert.equal(hidden.home, true); assert.equal(hidden.sameSequence, true); assert.equal(hidden.samePdf, true);
    assert.equal(hidden.aborted, false); assert.equal(hidden.status, 'complete');
    assert.equal(hidden.text, `${marker} first. Second part. Finished while hidden.`);
    await page.evaluate(() => __ctx.saveSessionNow());
    assert.equal(await page.evaluate(id => [...__mockSessions.values()].some(session =>
      session.entries?.some(row => row.id === id && row.status === 'complete' && row.text.endsWith('Finished while hidden.'))), before.id), true,
    `${kind}: completed hidden entry is persisted`);
    await returnToReady();
    assert.equal(await page.evaluate(() => __homeEntry.isConnected && __homeEntry.__sessionRecord.status === 'complete'), true);
    h.pass(`${kind}: before first token, mid-stream, repeated current-tab and Home completion preserve output, sequence, DOM and save`);
  }

  // Hold the real PDF proxy's first page: viewer.pdf exists, but the document is not ready.
  await page.evaluate(() => {
    const proto = Object.getPrototypeOf(__viewer.pdf), original = proto.getPage;
    window.__homePagePrototype = proto; window.__homeOriginalGetPage = original;
    proto.getPage = function (number) {
      const shouldHold = this === __viewer.pdf && number === 1 && __viewer.name === window.__homeHoldPageName;
      if (!shouldHold) return original.call(this, number);
      window.__homeHoldPageName = '';
      const pdf = this;
      window.__homePendingPdf = pdf;
      return new Promise(resolve => { window.__homeReleasePage = resolve; }).then(() => original.call(pdf, number));
    };
  });
  const beginFirstPage = async id => {
    await page.evaluate(name => { window.__homeReleasePage = null; window.__homeHoldPageName = name; }, `${id}.pdf`);
    await h.beginOpen(id);
    await page.waitForFunction(() => !!window.__homeReleasePage && __state.viewerDocId === null);
  };

  await beginFirstPage('home-pending');
  await home();
  await page.evaluate(() => __homeReleasePage());
  await page.evaluate(() => __navigationPromise);
  assert.equal(await page.evaluate(() => !document.body.classList.contains('reading') && __state.viewerDocId === null
    && !__ctx.tabs.some(tab => tab.docId === 'home-pending') && document.querySelectorAll('#tabStrip .doc-tab.active').length === 0), true);
  await returnToReady();
  assert.equal(await page.evaluate(() => __ctx.pdfHandleCount), 0, 'unfinished Home-cancelled document was not cached');
  h.pass('Home during real first-page loading prevents late completion from restoring reading or adding a tab');

  await beginFirstPage('switch-pending');
  await home();
  await returnToReady();
  const cacheAfterSwitch = await page.evaluate(() => ({ handles: __ctx.pdfHandleCount, ready: __state.viewerDocId,
    samePdf: __viewer.pdf === __homePendingPdf }));
  assert.deepEqual(cacheAfterSwitch, { handles: 0, ready: 'home-ready', samePdf: false });
  await page.evaluate(() => __homeReleasePage());
  await page.evaluate(() => __navigationPromise);
  assert.equal(await page.evaluate(() => __state.viewerDocId === 'home-ready' && __viewer.name === 'home-ready.pdf'
    && __ctx.pdfHandleCount === 0 && document.body.classList.contains('reading')), true);
  await page.evaluate(() => { __homePagePrototype.getPage = __homeOriginalGetPage; });
  h.pass('switching away before the first page is ready never caches the PDF later destroyed by stale cleanup');

  // Freeze the actual retry delay deterministically; a UI switch must invalidate it.
  await page.evaluate(() => {
    const load = __viewer.load.bind(__viewer), timeout = window.setTimeout.bind(window);
    window.__homeOriginalLoad = load; window.__homeOriginalTimeout = timeout;
    window.__homeRetryLoads = [];
    window.__homeExpectRetryTimer = false;
    __viewer.load = async function (...args) {
      if (String(args[1]).endsWith('-retry.pdf')) {
        __homeRetryLoads.push(args[1]);
        if (__homeRetryLoads.filter(name => name === args[1]).length === 1) {
          window.__homeExpectRetryTimer = true;
          throw Error('Synthetic first PDF load failure');
        }
      }
      return load(...args);
    };
    window.setTimeout = function (callback, delay, ...args) {
      if (__homeExpectRetryTimer && delay === 300) {
        window.__homeExpectRetryTimer = false;
        window.__homeReleaseRetry = () => timeout(callback, 0, ...args);
        return 0;
      }
      return timeout(callback, delay, ...args);
    };
  });
  for (const switchBack of [false, true]) {
    const id = switchBack ? 'switch-retry' : 'home-retry';
    await page.evaluate(() => { window.__homeReleaseRetry = null; });
    await h.beginOpen(id);
    await page.waitForFunction(() => !!window.__homeReleaseRetry);
    await home();
    if (switchBack) await returnToReady();
    await page.evaluate(() => __homeReleaseRetry());
    await page.evaluate(() => __navigationPromise);
    assert.equal(await page.evaluate(name => __homeRetryLoads.filter(value => value === name).length, `${id}.pdf`), 1,
      'invalidated first failure never starts a second load');
    if (switchBack) {
      assert.equal(await page.evaluate(() => __state.viewerDocId === 'home-ready' && __viewer.name === 'home-ready.pdf'
        && document.body.classList.contains('reading')), true);
    } else {
      assert.equal(await page.evaluate(() => !document.body.classList.contains('reading') && __state.viewerDocId === null), true);
      await returnToReady();
    }
    h.pass(`failed-load retry after ${switchBack ? 'Home and another tab' : 'Home'} cannot overwrite the current view or PDF`);
  }
  await page.evaluate(() => { __viewer.load = __homeOriginalLoad; window.setTimeout = __homeOriginalTimeout; });
});
