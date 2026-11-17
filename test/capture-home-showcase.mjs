/** Repository screenshots from the embedded app and an explicitly synthetic library. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'home-showcase-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
const names = [
  'Transformer/Attention Is All You Need.pdf', 'Transformer/An Image is Worth 16x16 Words.pdf', 'Transformer/Tokens-to-Token ViT.pdf',
  'Computer Vision/Deep Residual Learning for Image Recognition.pdf', 'Computer Vision/Squeeze-and-Excitation Networks.pdf',
  'Reading Notes/Questions on attention and representation.pdf',
];
for (const name of names) {
  const destination = path.join(papers, name); fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), destination);
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  reader = spawnReader(stageExe('home-showcase').exe, { args: ['--port', String(port)], env: {
    PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1',
  } });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready);
  const library = (await fetch(`${base}/api/papers`).then(r => r.json())).papers;
  const last = library.find(p => p.path === names[0]), prior = library.find(p => p.path === names[3]);
  await fetch(`${base}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    docs: { [last.docId]: { name: last.name, page: 3, ts: Date.now() - 1200000 }, [prior.docId]: { name: prior.name, page: 5, ts: Date.now() - 7200000 } },
    lastDoc: last.docId, lastName: last.name, lastUrl: last.url,
  }) });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 960, deviceScaleFactor: 1.5 } });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'networkidle0' }); await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.$$eval('#homeList .home-item', nodes => nodes.length), 6);
  for (const theme of ['glass', 'dark']) {
    await page.evaluate(theme => { const input = document.querySelector('#uiTheme'); input.value = theme; input.dispatchEvent(new Event('input', { bubbles: true })); }, theme);
    await wait(350); await page.screenshot({ path: path.join(ROOT, 'docs/assets', `home-${theme}.png`) });
  }
  await page.evaluate(() => localStorage.setItem('reader.locale', 'en')); await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(() => { const input = document.querySelector('#uiTheme'); input.value = 'glass'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(350); await page.screenshot({ path: path.join(ROOT, 'docs/assets/home-english.png') });
  assert.deepEqual(errors, []);
  console.log(`Captured home-glass.png, home-dark.png, home-english.png using synthetic data: ${scratch}`);
} finally { await browser?.close(); await stopChild(reader); }
