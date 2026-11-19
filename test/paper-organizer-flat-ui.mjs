/** Real app/API, disposable PDFs, loopback AI; never touches the user's library. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';
import { writeScannedFixture } from './fixtures/make-scanned-pdf.mjs';
import { startOrganizerTestModel, organizerModelInput } from './_organizer-test-model.mjs';
const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `flat-organizer-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
const names = ['Old/Nested/Vision networks.pdf', 'Old/Circuit design.pdf', 'Old/1234.pdf', 'Old/5678.pdf'];
for (const relative of names) {
  fs.mkdirSync(path.dirname(path.join(papers, relative)), { recursive: true });
  if (relative.endsWith('5678.pdf')) writeScannedFixture(path.join(papers, relative));
  else writeTitlePdf(path.join(papers, relative), { title: relative.endsWith('1234.pdf') ? 'Visual recognition research on page one' : path.basename(relative) });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser, page, model, base, mode = 'normal', held;
const errors = [], requests = [], checks = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
async function api(route, body) {
  const response = await fetch(base + route, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
}
async function idle() { await page.waitForFunction(() => document.querySelector('#paperOrganizer').getAttribute('aria-busy') === 'false'); }
async function classify() { await page.locator('#paperOrganizerClassify').click(); await idle(); }
async function rows() {
  return page.$$eval('#paperOrganizerList .po-row', nodes => nodes.map(node => ({ path: node.dataset.path,
    target: node.querySelector('.po-target input').value, selected: node.querySelector('[type=checkbox]').checked })));
}
async function edit(index, value) {
  await page.$$eval('#paperOrganizerList .po-target input', (nodes, { index, value }) => {
    nodes[index].value = value; nodes[index].dispatchEvent(new Event('input', { bubbles: true }));
  }, { index, value });
}
try {
  model = await startOrganizerTestModel(record => {
    const input = organizerModelInput(record);
    if (mode === 'hold') { held = record; model.start(record); return; }
    if (mode === 'invalid') return model.reply(record, { groups: [{ folder: 'Bad/Nested', papers: input.papers.map(p => p.index) }], unknown: [] });
    if (input.task === 'first-page') {
      if (input.name === '5678.pdf') assert.ok(Array.isArray(record.body.messages.at(-1).content));
      else assert.match(input.text, /Visual recognition/);
      return model.reply(record, { evidence: input.name === '1234.pdf' ? 'Vision research' : 'Electronic circuits' });
    }
    assert.equal(input.task, 'group');
    assert.ok(input.papers.every(p => !('path' in p) && !('title' in p)));
    if (mode === 'replace') return model.reply(record, { groups: [{ folder: 'New research', papers: input.papers.map(p => p.index).reverse() }], unknown: [] });
    const groups = new Map(), unknown = [];
    for (const paper of input.papers) {
      const category = /Vision/i.test(paper.name) || /Vis(?:ion|ual)/i.test(paper.evidence || '') ? 'Vision'
        : /Circuit/i.test(paper.name) || /circuits/i.test(paper.evidence || '') ? 'Electronics' : '';
      if (!category) unknown.push(paper.index);
      else { if (!groups.has(category)) groups.set(category, []); groups.get(category).push(paper.index); }
    }
    model.reply(record, { groups: [...groups].map(([folder, papers]) => ({ folder, papers })), unknown });
  });
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('flat-organizer').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready); assert.equal(path.resolve((await api('/api/papers')).dir), papers);
  for (const asset of ['js/app.js', 'js/paper-organizer.js', 'js/paper-classifier.js', 'js/prompts/capabilities/organizer.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  await api('/api/config', { baseURL: model.baseURL, model: 'synthetic-flat-organizer', apiKey: 'SYNTHETIC_TEST_KEY' });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1280, height: 940 } });
  page = await browser.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== base) { errors.push(`External request ${url.origin}`); return request.abort(); }
    requests.push({ path: url.pathname, method: request.method() }); request.continue();
  });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('reader.locale', 'zh-CN'); localStorage.setItem('reader.session.aiTitle', '0'); });
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 4);
  await page.locator('#homeOrganize').click(); await idle();
  assert.equal(await page.$('#paperOrganizerDepth'), null); assert.equal(await page.$('#paperOrganizerRead'), null);
  assert.equal(model.requests.length, 0); assert.ok((await rows()).every(row => !row.target));
  assert.equal(await page.$eval('.po-page', n => n.hidden), true);
  pass('passive preview has no depth/title controls or unnecessary pagination');
  await classify();
  assert.deepEqual(model.requests.map(r => organizerModelInput(r).task), ['group', 'first-page', 'group']);
  const pageRequests = model.requests.filter(r => organizerModelInput(r).task === 'first-page');
  assert.deepEqual(pageRequests.map(r => organizerModelInput(r).name), ['5678.pdf']);
  assert.match(organizerModelInput(model.requests.at(-1)).papers.find(p => p.name === '1234.pdf').evidence, /Visual recognition/);
  const grouped = await rows(); assert.ok(grouped.every(row => row.target && !row.target.includes('/')), JSON.stringify({ grouped, errors: model.errors }));
  assert.equal(new Set(grouped.map(r => r.target)).size, 2);
  assert.equal(grouped[0].target, grouped[1].target); assert.equal(grouped[2].target, grouped[3].target);
  assert.equal(requests.filter(r => r.path === '/api/move').length, 0);
  pass('names first; ambiguous names read real page-one text/images; similar PDFs are adjacent');
  for (const width of [1280, 480]) {
    await page.setViewport({ width, height: 940 });
    const layout = await page.$eval('#paperOrganizer', node => ({ width: node.getBoundingClientRect().width, overflow: node.scrollWidth > node.clientWidth + 1 }));
    assert.ok(layout.width <= width && !layout.overflow); await page.screenshot({ path: path.join(scratch, `flat-${width}.png`) });
  }
  await page.setViewport({ width: 1280, height: 940 });
  pass('flat preview fits desktop and narrow layouts');
  await edit(0, 'Forbidden/Nested'); assert.equal((await rows())[0].selected, false);
  assert.equal(await page.$eval('#paperOrganizerList .po-target input', n => n.getAttribute('aria-invalid')), 'true');
  await edit(0, 'Manual old category');
  mode = 'replace'; const checkpoint = model.requests.length; await classify();
  assert.equal(model.requests.length, checkpoint + 1); assert.ok((await rows()).every(r => r.target === 'New research' && r.selected));
  assert.equal(await page.$$eval('.po-section-title', n => n.length), 1);
  assert.ok(!await page.$eval('#paperOrganizerPlan', n => n.textContent.includes('Manual old category')));
  pass('nested manual paths rejected; rerun replaces previous automatic and manual categories');
  mode = 'invalid'; await classify(); assert.ok((await rows()).every(r => !r.target && !r.selected));
  assert.equal(await page.$eval('#paperOrganizerApply', n => n.disabled), true);
  pass('invalid replacement cannot retain stale targets or authorize moves');
  mode = 'hold'; held = null; await page.locator('#paperOrganizerClassify').click();
  for (let i = 0; i < 100 && !held; i++) await wait(25);
  assert.ok(held); await page.locator('.po-actions button:nth-child(2)').click(); await idle();
  model.reply(held, { groups: [{ folder: 'Late result', papers: [1, 2, 3, 4] }], unknown: [] }); await wait(100);
  assert.ok((await rows()).every(r => !r.target));
  pass('stop cancels grouping and late model results never reappear');
  mode = 'replace'; await classify(); await page.locator('#paperOrganizerApply').click(); await idle();
  const final = await api('/api/papers');
  assert.ok(final.papers.every(p => p.path.startsWith('New research/') && p.path.split('/').length === 2));
  assert.ok(!final.folders.some(folder => folder.path === 'Old' || folder.path.startsWith('Old/')));
  assert.equal(requests.filter(r => r.path === '/api/move').length, 4);
  pass('confirm moves to flat categories and removes old empty nested folders');
  mode = 'normal'; await classify();
  assert.ok((await rows()).every(row => row.target === 'Vision' || row.target === 'Electronics'));
  await page.locator('#paperOrganizerApply').click(); await idle();
  const second = await api('/api/papers');
  assert.ok(second.papers.every(p => /^(Vision|Electronics)\//.test(p.path)));
  assert.ok(!second.folders.some(folder => folder.path === 'New research'));
  pass('classify again after moving uses current PDF URLs and replaces the previous physical categories');
  assert.deepEqual(errors, []); assert.deepEqual(model.errors, []);
  console.log(`PASS ${checks.length} ${desktop ? 'desktop' : 'Node'} UI checks; artifacts ${scratch}`);
} finally { await browser?.close(); await stopChild(reader); await model?.close(); }
