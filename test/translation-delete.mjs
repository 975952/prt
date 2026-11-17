/** Direct translation deletion, persistence, concurrent saves and streaming; isolated fixtures only. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `translation-delete-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'translation-demo.pdf'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const requests = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
  }
  requests.push({ body, res });
});
const emit = (request, text, done = false) => {
  if (!request.res.headersSent) request.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  request.res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  if (done) request.res.end('data: [DONE]\n\n');
};
const nextRequest = async index => {
  for (let i = 0; i < 150 && !requests[index]; i++) await wait(100);
  assert.ok(requests[index], `model request ${index}`); return requests[index];
};
let reader, browser, page, checks = 0;
const errors = [], dialogs = [];
const pass = name => { checks++; console.log(`PASS ${name}`); };
try {
  await listen(upstream);
  const probe = http.createServer(); await listen(probe); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('translation-delete').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready);
  const post = async (url, payload) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.ok(response.ok, `${url}: ${response.status}`); return response.json();
  };
  await post('/api/config', { baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'deletion-mock', apiKey: 'SYNTHETIC_DELETE_TEST_KEY' });
  const doc = (await fetch(`${base}/api/papers`).then(r => r.json())).papers[0];
  const sessionURL = `/api/session?doc=${encodeURIComponent(doc.docId)}&sid=__translate`;
  const readSession = () => fetch(base + sessionURL).then(r => r.json());
  const entries = ['text', 'shot', 'failed', 'pending', 'stopped', 'keep'].map(id => ({
    id, block: 'translate', tag: 'translation', kind: 'assistant', docId: doc.docId, page: 1,
    quote: `Original ${id}`, text: `Translation ${id}`, status: ['failed', 'pending', 'stopped'].includes(id) ? id : 'complete',
    screenshot: id === 'shot', retry: { kind: id === 'shot' ? 'translate-shot' : 'translate-text', text: `Original ${id}`, targetLang: '中文' },
  }));
  const legacy = { block: 'translate', kind: 'assistant', tag: 'translation', text: 'Legacy 同文 🧪', quote: 'Legacy original', status: 'complete' };
  await post(sessionURL, { entries: [...entries, legacy, legacy], history: [], ops: [] });
  const original = await readSession();
  const legacyIds = original.entries.filter(row => row.text === legacy.text).map(row => row.id);
  assert.equal(new Set(legacyIds).size, 2); assert.ok(legacyIds.every(id => id.startsWith('legacy-')));
  pass('legacy entries receive stable separate IDs');
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 960 } });
  let windowSequence = 0;
  const open = async () => {
    const p = await browser.newPage(); page ||= p; p.on('pageerror', e => errors.push(String(e)));
    p.on('console', msg => { if (msg.type() === 'error') console.error('BROWSER', msg.text()); });
    p.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await p.goto(`${base}/?open=translation-demo.pdf&readerWindow=deletion-${++windowSequence}`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.__viewer?.pdf && window.__ctx?.restoreSession && window.__state.viewerDocId === window.__state.doc?.docId);
    await p.evaluate(() => { window.__ctx.setPanelVisible('translate', true); window.__ctx.applyPanels(); });
    await p.waitForFunction(() => [...document.querySelectorAll('.msg')].some(row => row.__sessionRecord?.id === 'keep'));
    return p;
  };
  page = await open(); const other = await open();
  const remove = async (id, p = page) => {
    await p.evaluate(id => {
      const row = [...document.querySelectorAll('.msg')].find(row => row.__sessionRecord?.id === id);
      const button = row?.querySelector('.translation-delete');
      if (!button || !button.getClientRects().length) throw Error(`Missing visible delete: ${id}`);
      button.focus(); button.click();
      if (row.isConnected) throw Error('Delete did not remove the row immediately');
    }, id);
    await p.evaluate(() => window.__ctx.saveSessionNow());
  };
  for (const id of ['text', 'shot', 'failed', 'pending', 'stopped', legacyIds[0]]) {
    await remove(id);
    assert.ok(!(await readSession()).entries.some(row => row.id === id));
    pass(`${id.startsWith('legacy') ? 'legacy' : id} translation deletes directly and persists`);
  }
  await other.waitForFunction(() => ![...document.querySelectorAll('.msg')].some(row => row.__sessionRecord?.id === 'text'));
  pass('another open window removes deleted results');
  await post(sessionURL + '&merge=1', original);
  let saved = await readSession();
  assert.deepEqual(saved.entries.map(row => row.id).sort(), ['keep', legacyIds[1]].sort());
  assert.equal(saved.deletedEntryIds.length, 6);
  await post(sessionURL, original); // A stale legacy writer cannot bypass tombstones with a replacement save.
  saved = await readSession();
  assert.deepEqual(saved.entries.map(row => row.id).sort(), ['keep', legacyIds[1]].sort());
  pass('stale merge and replacement saves cannot resurrect deleted translations');
  await Promise.all([
    post(sessionURL + '&merge=1', { entries: [], deletedEntryIds: [legacyIds[1]] }),
    post(sessionURL + '&merge=1', { entries: [{ ...entries[5], id: 'concurrent', text: 'Concurrent survivor' }] }),
  ]);
  assert.deepEqual((await readSession()).entries.map(row => row.id).sort(), ['concurrent', 'keep']);
  pass('concurrent deletion and insertion both survive');
  await other.close(); await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state?.sessionEntries.some(row => row.id === 'concurrent'));
  await page.waitForFunction(() => window.__state.blockMeta.translate?.body?.querySelectorAll('.translation-delete').length === 2);
  await page.evaluate(() => { window.__ctx.setPanelVisible('translate', true); window.__ctx.applyPanels(); });
  if (await page.$eval('#rightSide', node => node.dataset.activePanel) !== 'translate') await page.click('.aibar-btn[data-block="translate"]');
  assert.equal(await page.$$eval('.translation-delete', nodes => nodes.length), 2);
  pass('reload restores only surviving translations');
  await page.evaluate(async () => {
    await (await import('/js/sessions.js')).sessionsOpenLatestForOutput();
    window.__ctx.setPanelVisible('translate', true); window.__ctx.applyPanels();
  });
  const chatBefore = await page.evaluate(() => JSON.stringify(window.__state.sessionEntries.filter(row => row.block !== 'translate')));
  await page.$eval('#chatInput', input => { input.value = 'Source deleted during generation.'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#sendBtn'); const stream = await nextRequest(0);
  emit(stream, 'Partial translation that will be deleted.');
  await page.waitForFunction(() => window.__state.busy && [...document.querySelectorAll('.msg')].some(row => row.textContent.includes('Partial translation')));
  const streamingId = await page.evaluate(() => window.__state.sessionEntries.find(row => row.block === 'translate' && row.status === 'pending').id);
  await remove(streamingId);
  await page.waitForFunction(() => !window.__state.busy);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  assert.ok(!(await readSession()).entries.some(row => row.id === streamingId));
  assert.equal(await page.$eval('#chatInput', input => input.value), '');
  pass('deleting an active result cancels its request without returning deleted material to the draft');
  await page.$eval('#chatInput', input => { input.value = 'Independent next translation.'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#sendBtn'); emit(await nextRequest(1), 'Independent surviving translation.', true);
  await page.waitForFunction(() => !window.__state.busy);
  await remove('keep');
  assert.ok((await readSession()).entries.some(row => row.text === 'Independent surviving translation.'));
  assert.equal(await page.evaluate(() => JSON.stringify(window.__state.sessionEntries.filter(row => row.block !== 'translate'))), chatBefore);
  pass('other translations and chat remain intact and a new request works');
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 80;
    const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 160, 80);
    context.fillStyle = 'black'; context.fillText('Synthetic source', 12, 40);
    const shot = { dataUrl: canvas.toDataURL(), width: 160, height: 80 };
    window.__ctx.addImageToChat(shot, 1, 'First image'); window.__ctx.addImageToChat(shot, 2, 'Second image');
  });
  await page.click('#sendBtn'); const firstImage = await nextRequest(2);
  emit(firstImage, 'First image partial result.');
  await page.waitForFunction(() => window.__state.sessionEntries.some(row => row.screenshot && row.status === 'pending'));
  const firstImageId = await page.evaluate(() => window.__state.sessionEntries.find(row => row.screenshot && row.status === 'pending').id);
  await remove(firstImageId);
  const secondImage = await nextRequest(3);
  await remove('concurrent'); // Removing an older result must not abort the running screenshot.
  emit(secondImage, 'Second image survives deletion of its sibling.', true);
  await page.waitForFunction(() => !window.__state.busy);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  saved = await readSession();
  assert.ok(!saved.entries.some(row => row.id === firstImageId || row.id === 'concurrent'));
  assert.ok(saved.entries.some(row => row.screenshot && row.text === 'Second image survives deletion of its sibling.'));
  assert.equal(requests.length, 4);
  pass('deleting one running screenshot continues the batch; deleting an older result leaves the current request intact');
  assert.deepEqual(dialogs, []); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(scratch, 'translation-delete.png') });
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, dialogs, errors, legacyIds, saved: await readSession() }, null, 2));
  console.log(`Translation deletion: ${checks}/${checks} passed; ${scratch}`);
} catch (error) {
  console.error(await page?.evaluate(() => ({ doc: window.__state?.doc, entries: window.__state?.sessionEntries, messages: document.querySelectorAll('.msg').length })).catch(() => null));
  await page?.screenshot({ path: path.join(scratch, 'failure.png'), timeout: 5000 }).catch(() => {});
  console.error(scratch); throw error;
} finally {
  await browser?.close(); await stopChild(reader);
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
