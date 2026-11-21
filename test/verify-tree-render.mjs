/** Verify that nested folder trees are correctly rendered from API response */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'tree-render-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data);
fs.mkdirSync(papers);

// Create test structure: Papers/2024/NLP/paper1.pdf and Papers/2024/CV/paper2.pdf
const pdf = fs.readFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'));
fs.mkdirSync(path.join(papers, 'Papers/2024/NLP'), { recursive: true });
fs.mkdirSync(path.join(papers, 'Papers/2024/CV'), { recursive: true });
fs.writeFileSync(path.join(papers, 'Papers/2024/NLP/paper1.pdf'), pdf);
fs.writeFileSync(path.join(papers, 'Papers/2024/CV/paper2.pdf'), pdf);

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
  PRT_DIAGNOSTICS: '1',
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

  // Wait for initial load
  await page.waitForFunction(() => window.__ctx && window.__state?.papers);

  // Refresh paper list to load nested structure
  await page.evaluate(async () => {
    await window.__ctx.refreshPaperList();
    // Auto-open all folders so nested structure is visible
    for (const folder of window.__state.folders) {
      window.__state.folderOpen.add(folder.path);
    }
    window.__ctx.renderPaperList();
  });

  // Wait for DOM to update
  await new Promise(resolve => setTimeout(resolve, 300));

  // 1. Check API returns nested folders
  const apiResponse = await fetch(base + '/api/papers').then(r => r.json());
  console.log('📡 API folders:', apiResponse.folders.map(f => f.path));
  console.log('📡 API papers:', apiResponse.papers.map(p => p.path));

  assert(apiResponse.folders.some(f => f.path === 'Papers'), 'Papers folder missing');
  assert(apiResponse.folders.some(f => f.path === 'Papers/2024'), 'Papers/2024 folder missing');
  assert(apiResponse.folders.some(f => f.path === 'Papers/2024/NLP'), 'Papers/2024/NLP folder missing');
  assert(apiResponse.folders.some(f => f.path === 'Papers/2024/CV'), 'Papers/2024/CV folder missing');
  assert(apiResponse.papers.some(p => p.path === 'Papers/2024/NLP/paper1.pdf'), 'paper1.pdf path missing');
  assert(apiResponse.papers.some(p => p.path === 'Papers/2024/CV/paper2.pdf'), 'paper2.pdf path missing');
  console.log('✓ API returns correct nested structure');

  // 2. Check DOM tree structure in file list
  const treeDomStructure = await page.evaluate(() => {
    const fileList = document.getElementById('fileList');
    if (!fileList) return null;

    function traverse(ul) {
      const children = [];
      for (const li of ul.querySelectorAll(':scope > li')) {
        if (li.classList.contains('folder')) {
          children.push({
            type: 'folder',
            name: li.querySelector('.folder-name').textContent,
            path: li.dataset.path,
            children: li.querySelector(':scope > .folder-children')
              ? traverse(li.querySelector(':scope > .folder-children'))
              : [],
          });
        } else {
          children.push({
            type: 'file',
            name: li.querySelector('.file-name').textContent,
            path: li.dataset.path,
          });
        }
      }
      return children;
    }

    return traverse(fileList);
  });

  console.log('\n🌳 File list DOM structure:');
  console.log(JSON.stringify(treeDomStructure, null, 2));

  // 3. Verify tree structure is nested, not flat
  const findFolder = (arr, path) => {
    for (const item of arr) {
      if (item.type === 'folder' && item.path === path) return item;
      if (item.type === 'folder' && item.children) {
        const found = findFolder(item.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const papersFolder = findFolder(treeDomStructure, 'Papers');
  assert(papersFolder, 'Papers folder not found in DOM');
  console.log('✓ Papers folder found');

  const papers2024 = findFolder(papersFolder.children, 'Papers/2024');
  assert(papers2024, 'Papers/2024 folder not found as direct child of Papers');
  console.log('✓ Papers/2024 is nested under Papers');

  const nlpFolder = findFolder(papers2024.children, 'Papers/2024/NLP');
  const cvFolder = findFolder(papers2024.children, 'Papers/2024/CV');
  assert(nlpFolder, 'Papers/2024/NLP not found');
  assert(cvFolder, 'Papers/2024/CV not found');
  console.log('✓ NLP and CV folders nested under Papers/2024');

  // 4. Check files are under correct folders, not at root
  const rootFiles = treeDomStructure.filter(item => item.type === 'file');
  assert.equal(
    rootFiles.length,
    0,
    `Files should not be at root level. Found: ${rootFiles.map(f => f.name).join(', ')}`
  );
  console.log('✓ No files at root level (correctly nested)');

  const nlpPaper = nlpFolder.children.find(item => item.path === 'Papers/2024/NLP/paper1.pdf');
  const cvPaper = cvFolder.children.find(item => item.path === 'Papers/2024/CV/paper2.pdf');
  assert(nlpPaper, 'paper1.pdf not found under NLP');
  assert(cvPaper, 'paper2.pdf not found under CV');
  console.log('✓ Papers correctly placed under their respective folders');

  console.log('\n✅ PASS: Directory structure correctly preserved and rendered as tree');
} finally {
  if (browser) await browser.close();
  await stopChild(child);
}
