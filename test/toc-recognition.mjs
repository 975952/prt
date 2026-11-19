/**
 * End-to-end scan-PDF contents recognition with an isolated Node server and a fake OpenAI endpoint.
 * Run with: node test/toc-recognition.mjs [--desktop]
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const desktop = process.argv.includes('--desktop');
const checks = [];
const check = (label, condition, detail = '') => {
  const ok = !!condition;
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  assert.ok(ok, `${label}${detail ? `: ${detail}` : ''}`);
};

function imageOnlyPdf(pageImages, width = 612, height = 792) {
  const objects = [];
  const add = (value) => { objects.push(value); return objects.length; };
  const catalog = add('');
  const pageTree = add('');
  const imageIds = pageImages.map((bytes) => add({ raw: bytes, dict: `<</Type/XObject/Subtype/Image/Width 1224/Height 1584/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${bytes.length}>>` }));
  const pageObjects = [];
  for (let page = 0; page < imageIds.length; page++) {
    const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`;
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
    pageObjects.push(add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${imageIds[page]} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] = `<< /Type /Pages /Count ${imageIds.length} /Kids [${pageObjects.map((id) => `${id} 0 R`).join(' ')}] >>`;
  const pieces = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let length = pieces[0].length;
  const push = (chunk) => { pieces.push(chunk); length += chunk.length; };
  objects.forEach((object, index) => {
    offsets.push(length);
    push(Buffer.from(`${index + 1} 0 obj\n`));
    if (typeof object === 'string') push(Buffer.from(object));
    else { push(Buffer.from(`${object.dict}\nstream\n`)); push(object.raw); push(Buffer.from('\nendstream')); }
    push(Buffer.from('\nendobj\n'));
  });
  const xref = length;
  push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (const offset of offsets.slice(1)) push(Buffer.from(`${String(offset).padStart(10, '0')} 00000 n \n`));
  push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(pieces);
}

async function createScannedPages() {
  const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1224, height: 1584, deviceScaleFactor: 1 });
    const specs = [
      { title: 'Synthetic scanned paper', lines: ['A page with no printed folio.'] },
      { title: 'Publication details', lines: ['A synthetic scan used only by local tests.'], label: 'i' },
      { title: 'Table of Contents', lines: ['Preface ........................ iii', '1 Introduction ................. 1', '2 Method ....................... 2', '3 Experiments .................. 3', '4 Conclusion ................... 4'], label: 'ii' },
      { title: 'Preface', lines: ['This page begins the Roman-numbered front matter.'], label: 'iii' },
      { title: '1 Introduction', lines: ['This body begins at printed page one.'], label: '1' },
      { title: '2 Method', lines: ['The method section starts on printed page two.'], label: '2' },
      { title: '3 Experiments', lines: ['Experiments start on printed page three.'], label: '3' },
      { title: '4 Conclusion', lines: ['The conclusion starts on printed page four.'], label: '4' },
    ];
    const images = [];
    for (const spec of specs) {
      const rows = spec.lines.map((line) => `<p>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`).join('');
      await page.setContent(`<!doctype html><html><head><style>
        *{box-sizing:border-box}html,body{margin:0;width:1224px;height:1584px;background:#fff;color:#111;font-family:Arial,sans-serif}
        main{height:100%;padding:150px 130px;position:relative}h1{font-size:42px;font-weight:600;margin:0 0 70px}
        p{font-size:27px;line-height:1.6;margin:0 0 18px}.folio{position:absolute;bottom:90px;left:0;right:0;text-align:center;font-size:22px}
      </style></head><body><main><h1>${spec.title}</h1>${rows}${spec.label ? `<div class="folio">${spec.label}</div>` : ''}</main></body></html>`, { waitUntil: 'load' });
      images.push(await page.screenshot({ type: 'jpeg', quality: 90 }));
    }
    return images;
  } finally { await browser.close(); }
}

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'toc-recognition-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.writeFileSync(path.join(PAPERS, 'scanned-toc.pdf'), imageOnlyPdf(await createScannedPages()));

let mode = 'success';
const upstreamLog = [];
const entries = [
  { title: 'Preface', level: 1, printedPage: 'iii', sourcePage: 3, confidence: 0.96 },
  { title: '1 Introduction', level: 1, printedPage: '1', sourcePage: 3, confidence: 0.96 },
  { title: '2 Method', level: 1, printedPage: '2', sourcePage: 3, confidence: 0.96 },
  { title: '3 Experiments', level: 1, printedPage: '3', sourcePage: 3, confidence: 0.96 },
  { title: '4 Conclusion', level: 1, printedPage: '4', sourcePage: 3, confidence: 0.96 },
];
const printedLabel = (page) => [null, 'i', 'ii', 'iii', '1', '2', '3', '4'][page - 1] ?? null;

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    if (req.url === '/__test/mode' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      mode = ['success', 'low', 'bad'].includes(body.mode) ? body.mode : mode;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mode }));
      return;
    }
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const last = body.messages?.at(-1);
    const content = Array.isArray(last?.content) ? last.content : [];
    const text = content.find((part) => part?.type === 'text')?.text || '';
    const imageCount = content.filter((part) => part?.type === 'image_url').length;
    const pages = [...text.matchAll(/【第(\d+)页原图】/g)].map((match) => Number(match[1]));
    upstreamLog.push({ model: body.model, mode, text, pages, imageCount });
    let answer;
    if (mode === 'bad') answer = 'not valid JSON';
    else if (mode === 'low') {
      answer = JSON.stringify({ detected: true, confidence: 0.2,
        pageLabels: pages.map((pdfPage) => ({ pdfPage, label: printedLabel(pdfPage) })),
        entries: pages.includes(3) ? [{ title: 'Preface', level: 1, printedPage: 'iii', sourcePage: 3, confidence: 0.2 }] : [],
      });
    } else {
      answer = JSON.stringify({ detected: pages.includes(3), confidence: 0.96,
        pageLabels: pages.map((pdfPage) => ({ pdfPage, label: printedLabel(pdfPage) })),
        entries: pages.includes(3) ? entries : [],
      });
    }
    if (body.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const piece of (answer.match(/[\s\S]{1,80}/g) || [])) {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await wait(2);
    }
    if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  });
});

let reader = null;
let browser = null;
let staged = null;
const watchdog = setTimeout(() => { console.error('TOC test timed out'); process.exit(3); }, 180000);
watchdog.unref?.();

try {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const aiPort = upstream.address().port;
  const readerPort = await freePort();
  const readerEnv = { PORT: String(readerPort), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
    NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' };
  if (desktop) {
    staged = stageExe('toc-recognition');
    reader = spawnReader(staged.exe, { args: ['--port', String(readerPort)], env: readerEnv });
  } else {
    reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, ...readerEnv },
      stdio: 'ignore',
    });
  }
  const BASE = `http://127.0.0.1:${readerPort}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait for local server */ }
  }
  check(`isolated ${desktop ? 'desktop reader' : 'Node server'} starts`, ready);
  if (!ready) throw new Error('isolated server failed to start');
  const assetResponse = await fetch(`${BASE}/js/toc-recognition.js`);
  const servedModule = assetResponse.ok ? await assetResponse.text() : '';
  const sourceModule = fs.readFileSync(path.join(ROOT, 'public', 'js', 'toc-recognition.js'), 'utf8');
  check(`${desktop ? 'desktop embedded' : 'Node-served'} TOC module matches public source`,
    assetResponse.ok && servedModule === sourceModule, `HTTP ${assetResponse.status}`);
  const configResponse = await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'text-mock', visionModel: 'vision-mock', apiKey: 'toc-test-key' }),
  });
  check('fake vision model configured', configResponse.ok, `HTTP ${configResponse.status}`);

  const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1440, height: 900 } });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(`${BASE}/?open=scanned-toc.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc?.name === 'scanned-toc.pdf' && window.__viewer?.numPages === 8, { timeout: 40000 });
  await page.evaluate(() => window.__ctx.setPanelVisible('outline', true));
  await page.waitForFunction(() => ['ready', 'review', 'needs-vision', 'not-found', 'error'].includes(window.__ctx?.tocResult?.status), { timeout: 60000 });
  const first = await page.evaluate(() => window.__ctx.tocResult);
  check('synthetic raster pages have no searchable text layer',
    first.status === 'ready' && (await page.evaluate(async () => window.__viewer.getPageText(3))) === '',
    `status=${first.status}; error=${first.error || ''}; upstream=${JSON.stringify(upstreamLog.map((call) => ({ model: call.model, pages: call.pages, images: call.imageCount })))}`);
  check('scan PDF TOC becomes ready from fake structured vision JSON', first.status === 'ready', first.status);
  check('fake upstream receives batches of rendered page images', upstreamLog.some((call) => call.imageCount > 0 && call.pages.length === call.imageCount),
    JSON.stringify(upstreamLog.map((call) => ({ pages: call.pages, images: call.imageCount }))));
  check('OCR page labels retain the Roman and Arabic printed-page sequences',
    JSON.stringify(first.observedPageLabels.map((row) => row.label)) === JSON.stringify([null, 'i', 'ii', 'iii', '1', '2', '3', '4']),
    JSON.stringify(first.observedPageLabels));
  check('Roman and Arabic offsets include the unnumbered front page independently',
    first.offsets?.roman === 1 && first.offsets?.arabic === 4, JSON.stringify(first.offsets));
  check('printed page references map to actual PDF pages',
    JSON.stringify(first.entries.map((entry) => entry.actualPage)) === JSON.stringify([4, 5, 6, 7, 8]),
    JSON.stringify(first.entries.map((entry) => ({ printed: entry.printedPage, actual: entry.actualPage }))));

  const initialCalls = upstreamLog.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc?.name === 'scanned-toc.pdf' && window.__ctx?.tocResult?.status === 'ready', { timeout: 40000 });
  await wait(500);
  check('same-paper reload uses saved recognition without another model request', upstreamLog.length === initialCalls,
    `${initialCalls} calls before, ${upstreamLog.length} after`);

  const correction = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#outlineList .toc-entry')]
      .find((item) => item.querySelector('.outline-go')?.textContent.trim() === '1 Introduction');
    if (!row) return false;
    row.querySelector('.outline-edit')?.click();
    const input = row.querySelector('.outline-correct input');
    if (!input) return false;
    input.value = '8';
    row.querySelector('.outline-correct button')?.click();
    return window.__ctx.tocResult.entries.find((entry) => entry.title === '1 Introduction')?.manualActualPage === 8;
  });
  check('manual actual-page correction is accepted', correction);
  const correctedReloadCalls = upstreamLog.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx?.tocResult?.entries?.some((entry) => entry.title === '1 Introduction' && entry.manualActualPage === 8), { timeout: 40000 });
  await page.waitForFunction(() => window.__state?.doc?.docId && window.__state.viewerDocId === window.__state.doc.docId,
    { timeout: 40000 });
  check('manual correction survives reload without model request', upstreamLog.length === correctedReloadCalls,
    `${correctedReloadCalls} calls before, ${upstreamLog.length} after`);
  const jump = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#outlineList .toc-entry')]
      .find((item) => item.querySelector('.outline-go')?.textContent.trim() === '1 Introduction');
    const button = row?.querySelector('.outline-go');
    const entry = window.__ctx.tocResult.entries.find((item) => item.title === '1 Introduction');
    button?.click();
    return { found: !!button, disabled: !!button?.disabled, actualPage: entry?.actualPage,
      manualActualPage: entry?.manualActualPage, current: window.__viewer.current,
      doc: window.__state.doc?.docId, viewerDoc: window.__state.viewerDocId };
  });
  await wait(500);
  const landedPage = await page.evaluate(() => window.__viewer?.current);
  check('corrected outline entry jumps to the corrected PDF page', jump.found && !jump.disabled && landedPage === 8,
    `${JSON.stringify(jump)}; after-click=${landedPage}`);

  const setMode = async (next) => fetch(`http://127.0.0.1:${aiPort}/__test/mode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }),
  });
  await setMode('bad');
  const badResult = await page.evaluate(async () => await window.__ctx.retryTocRecognition());
  await page.waitForFunction(() => window.__ctx?.tocResult?.status === 'error', { timeout: 30000 });
  const retryVisible = () => page.$eval('#outlineRetry', (button) => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return !button.hidden && !button.disabled && style.display !== 'none' && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  });
  const badRetryVisible = await retryVisible();
  check('malformed model JSON produces retryable error state', badResult?.status === 'error' && badRetryVisible,
    `status=${badResult?.status}; retry=${badRetryVisible}`);

  await setMode('low');
  const lowResult = await page.evaluate(async () => await window.__ctx.retryTocRecognition());
  await page.waitForFunction(() => window.__ctx?.tocResult?.status === 'review', { timeout: 30000 });
  const lowRetryVisible = await retryVisible();
  check('low-confidence recognition remains reviewable and retryable', lowResult?.status === 'review' && lowRetryVisible,
    `status=${lowResult?.status}; confidence=${lowResult?.confidence}; retry=${lowRetryVisible}`);
  const correctionSurvivesLowConfidence = await page.evaluate(() =>
    window.__ctx.tocResult.entries.some((entry) => entry.title === '1 Introduction' && entry.manualActualPage === 8));
  check('manual correction survives a low-confidence retry', correctionSurvivesLowConfidence);

  await setMode('success');
  const beforeRetryClick = upstreamLog.length;
  await page.evaluate(() => window.__ctx.setPanelVisible('outline', true));
  await page.waitForFunction(() => {
    const button = document.querySelector('#outlineRetry');
    if (!button || button.hidden || button.disabled) return false;
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }, { timeout: 5000 });
  await page.click('#outlineRetry');
  await page.waitForFunction(() => window.__ctx?.tocResult?.status === 'ready', { timeout: 40000 });
  check('retry control reruns recognition and recovers to ready', upstreamLog.length > beforeRetryClick,
    `${beforeRetryClick} calls before retry, ${upstreamLog.length} after`);
  const correctionSurvivesRecovery = await page.evaluate(() =>
    window.__ctx.tocResult.entries.some((entry) => entry.title === '1 Introduction' && entry.manualActualPage === 8));
  check('manual correction remains active after successful retry', correctionSurvivesRecovery);
  check('page has no uncaught browser errors', pageErrors.length === 0, pageErrors.join(' | '));
  console.log(`\nTOC recognition E2E: ${checks.length} checks passed`);
} finally {
  clearTimeout(watchdog);
  try { await browser?.close(); } catch { /* ignore */ }
  if (desktop) {
    await stopChild(reader);
    if (staged?.dir) fs.rmSync(staged.dir, { recursive: true, force: true });
  } else if (reader && reader.exitCode === null) {
    reader.kill();
    await Promise.race([new Promise((resolve) => reader.once('exit', resolve)), wait(3000)]);
  }
  try { upstream.closeAllConnections?.(); await new Promise((resolve) => upstream.close(resolve)); } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true });
}
