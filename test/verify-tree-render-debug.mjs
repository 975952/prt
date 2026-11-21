/** Debug: trace why nested folders are not rendering with children */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'import-tree-debug-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data);
fs.mkdirSync(papers);

const pdf = fs.readFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(fn, label) {
  for (let i = 0; i < 200; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  PRT_DATA_DIR: data,
  PRT_PAPERS_DIR: papers,
  PRT_REQUIRE_TOKEN: '0',
  NO_OPEN: '1',
};

let child, browser, page;
try {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env,
    windowsHide: true,
    stdio: 'ignore',
  });

  await until(async () => (await fetch(base + '/api/health')).ok, 'service');
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--no-sandbox'],
    userDataDir: path.join(scratch, 'browser'),
  });
  page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => window.__state?.papers !== undefined);

  // Create test structure: Papers/2024/NLP/paper1.pdf
  fs.mkdirSync(path.join(papers, 'Papers/2024/NLP'), { recursive: true });
  fs.writeFileSync(path.join(papers, 'Papers/2024/NLP/paper1.pdf'), pdf);

  // Simulate what the app does after folder import
  const result = await page.evaluate(async () => {
    // 1. Fetch the fresh list
    const resp = await fetch('/api/papers');
    const apiData = await resp.json();

    console.log('API folders:', apiData.folders.map(f => f.path));
    console.log('API papers:', apiData.papers.map(p => ({ path: p.path, folder: p.folder })));

    // 2. Update state
    window.__state.folders = apiData.folders || [];
    window.__state.papers = apiData.papers || [];

    if (!window.__state.folderOpen) {
      window.__state.folderOpen = new Set();
    }

    // 3. Open all folders (what the fix does)
    for (const folder of window.__state.folders) {
      window.__state.folderOpen.add(folder.path);
    }

    console.log('Opened folders:', Array.from(window.__state.folderOpen));

    // 4. Now simulate renderTreeLevel to understand the filter logic
    function testFilter(folderPath) {
      const prefix = folderPath ? `${folderPath}/` : '';
      console.log(`\nTesting renderTreeLevel("${folderPath}"):`);
      console.log(`  prefix = "${prefix}"`);

      const subs = (window.__state.folders || []).filter((f) => {
        const result1 = !f.path.includes('/');
        const result2 = f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/');
        const result = folderPath === '' ? result1 : result2;
        console.log(`    ${f.path}: includes('/')=${f.path.includes('/')} startsWith('${prefix}')=${f.path.startsWith(prefix)} slice(${prefix.length})="${f.path.slice(prefix.length)}" includes('/')=${f.path.slice(prefix.length).includes('/')} → ${result}`);
        return result;
      });
      console.log(`  → subdirs: ${subs.map(s => s.path).join(', ')}`);

      const pdfs = (window.__state.papers || []).filter((p) => p.folder === folderPath);
      console.log(`  → pdfs: ${pdfs.map(p => p.path).join(', ')}`);
    }

    testFilter('');
    testFilter('Papers');
    testFilter('Papers/2024');
    testFilter('Papers/2024/NLP');
  });
} finally {
  if (browser) await browser.close();
  if (child) await new Promise(resolve => child.kill('SIGTERM') && child.on('exit', resolve));
}
