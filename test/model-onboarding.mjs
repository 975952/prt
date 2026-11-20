/** No-key chat follows the ordinary saved-answer path without a provider request. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { withChatHarness } from './_chat-harness.mjs';

await withChatHarness({ tag: 'model-onboarding', papers: [] }, async h => {
  const { page, pass, scratch } = h;
  await page.waitForSelector('#agentWelcomeSkip'); await page.click('#agentWelcomeSkip');
  assert.ok(await page.$('#homeStartPdf'));
  for (const selector of ['#homeReadingEntry', '#homeOrganize', '#welcomeWarn']) {
    assert.equal(await page.$eval(selector, node => !!node.getClientRects().length), false);
  }
  assert.match(await page.$eval('#homeList', node => node.textContent), /Start with a paper, or a question/);
  await page.screenshot({ path: path.join(scratch, 'empty-library-guide.png') });
  const chooser = await Promise.all([page.waitForFileChooser(), page.click('#homeStartPdf')]).then(results => results[0]);
  await chooser.accept([]);
  pass('empty Library offers first-PDF and chat actions, opens the file chooser, and hides unavailable resume and organization controls');
  await page.click('#homeStartChat');
  await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  await page.evaluate(async () => { (await import('/js/ai.js')).Settings.data.hasApiKey = false; });
  await h.beginAsk('NO_KEY_QUESTION: How should I start learning?');
  await h.complete('one step before we can chat'); await h.idle();
  assert.equal(await page.evaluate(() => __mockChatRequests.length), 0);
  assert.equal(await page.$eval('#settingsModal', node => node.classList.contains('hidden')), true);
  assert.equal(await page.$eval('#chatInput', node => node.value), '');
  assert.deepEqual(await page.evaluate(() => __state.sessionEntries.filter(row => row.block === 'chat').map(row => [row.kind, row.status])),
    [['user', 'user'], ['assistant', 'complete']]);
  assert.equal(await page.$$eval('[data-block="chat"] .err, [data-block="chat"] .stream-error', nodes => nodes.length), 0);
  assert.equal(await page.$$eval('.model-setup-link', nodes => nodes.length), 1);
  await page.evaluate(() => __ctx.saveSessionNow());
  const sid = await page.evaluate(() => __ctx.activeSession);
  assert.ok(await page.evaluate(() => [...__mockSessions.values()].some(session => session.entries.some(row => row.tag === 'model-setup' && row.status === 'complete'))));
  await page.screenshot({ path: path.join(scratch, 'fixed-reply.png') });
  pass('missing key produces an ordinary complete assistant answer, saves the turn and never calls a model or opens settings automatically');

  await page.evaluate(() => __ctx.newSession({ silent: true }));
  await page.evaluate(sid => __ctx.switchSession(sid, { force: true }), sid);
  await page.evaluate(() => __ctx.openAgentWorkspace({ landing: false }));
  await page.waitForSelector('.model-setup-link', { visible: true });
  await page.click('.model-setup-link');
  await page.waitForFunction(() => document.activeElement.id === 'cfgApiKey');
  assert.equal(await page.$eval('#settingsPaneModel', node => node.classList.contains('hidden')), false);
  pass('the saved reply retains its button and opens model settings focused on the API key');
  await page.click('#closeSettings');
  await page.evaluate(() => {
    const reply = document.querySelector('.model-setup-link').closest('.msg');
    [...reply.querySelectorAll('button')].find(node => node.textContent === 'Regenerate').click();
  });
  await h.waitRequest('NO_KEY_QUESTION');
  await h.emit('NO_KEY_QUESTION', { text: 'LIVE_MODEL_REPLY: Start with one small concept.', done: true });
  await h.complete('LIVE_MODEL_REPLY'); await h.idle();
  assert.equal(await page.evaluate(() => __state.sessionEntries.filter(row => row.kind === 'user').length), 1);
  assert.equal(await page.$$eval('.model-setup-link', nodes => nodes.length), 0);
  pass('after configuring a model, Regenerate replaces the fixed answer with a real model reply without duplicating the question');

  await page.evaluate(() => {
    const original = window.fetch; window.__authAttempts = 0;
    window.fetch = (input, init) => {
      if (String(input) === '/api/chat') {
        __authAttempts++;
        return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Invalid API key' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }));
      }
      return original(input, init);
    };
  });
  await h.beginAsk('AUTH_REJECTED_QUESTION: Explain gradient descent.');
  await page.waitForFunction(() => __state.sessionEntries.some(row => row.tag === 'model-setup' && row.status === 'complete'));
  await h.idle();
  assert.equal(await page.evaluate(() => __authAttempts), 1);
  assert.equal(await page.$$eval('.model-setup-link', nodes => nodes.length), 1);
  assert.equal(await page.$$eval('[data-block="chat"] .stream-error', nodes => nodes.length), 0);
  pass('a rejected API key receives the same normal fixed reply instead of an error bubble');
});
