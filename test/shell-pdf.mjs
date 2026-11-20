import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const staged = stageExe('shell-pdf');
const listener = net.createServer().listen(0, '127.0.0.1');
await once(listener, 'listening');
const debug = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const env = { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debug}`, PRT_DIAGNOSTICS: '1',
  PRT_DATA_DIR: path.join(staged.dir, 'data'), PRT_PAPERS_DIR: path.join(staged.dir, 'papers') };
const name = '阅读 sample.PDF';
const source = path.join(staged.dir, name);
const fixture = file => path.join(import.meta.dirname, 'fixtures', file);
fs.copyFileSync(fixture('cn-sample.pdf'), source);
const reader = spawnReader(staged.exe, { args: [source], env });
let browser;
try {
  for (let i = 0; i < 100 && !browser; i++) {
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debug}`, defaultViewport: null }); }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(browser);
  const target = await browser.waitForTarget(t => t.type() === 'page' && t.url().startsWith('http://127.0.0.1:'));
  const page = await target.page();
  const opened = wanted => page.waitForFunction(name => window.__state?.doc?.name === name
    && __state.viewerDocId === __state.doc.docId && document.body.classList.contains('reading'), {}, wanted);
  await opened(name);
  fs.copyFileSync(fixture('multipage-sample.pdf'), source);
  const forward = async file => {
    const child = spawnReader(staged.exe, { args: [file], env });
    assert.equal((await once(child, 'exit'))[0], 0);
  };
  await forward(source);
  await opened('阅读 sample (1).pdf');
  await forward(path.join(env.PRT_PAPERS_DIR, name));
  await opened(name);
  await forward(source);
  await opened('阅读 sample (1).pdf');
  assert.equal(fs.readdirSync(env.PRT_PAPERS_DIR).length, 2);
  assert.deepEqual(fs.readFileSync(path.join(env.PRT_PAPERS_DIR, name)), fs.readFileSync(fixture('cn-sample.pdf')));
  console.log('PASS: cold launch, warm forwarding, Chinese paths, collision, library reopen, duplicate reuse');
} finally { browser?.disconnect(); await stopChild(reader); }
