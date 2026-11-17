/** Narrow-gutter journal regression using the public CoOp paper (arXiv 2109.01134v6).
 * node test/selection-journal.mjs --pdf <public PDF> [--desktop] [--source-ref <old ref>]
 * The paper is copied only into an isolated test/artifacts directory; no paid calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i + 1]; };
const source = option('--pdf'), desktop = process.argv.includes('--desktop'), sourceRef = option('--source-ref');
assert(source && fs.existsSync(source), 'Pass --pdf <public 2109.01134v6 PDF>');
assert(!desktop || !sourceRef, 'Desktop checks must use embedded sources');
const scratch = fs.mkdtempSync(path.join(SANDBOX, `selection-journal-${desktop ? 'desktop' : sourceRef || 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers); fs.copyFileSync(source, path.join(papers, 'journal.pdf'));
const baseline = sourceRef ? execFileSync('git', ['show', `${sourceRef}:public/js/selection-reading-order.js`], { cwd: ROOT, encoding: 'utf8' }) : null;
const LEFT = `like CLIP have shown great potential in learning repre-
sentations that are transferable across a wide range of
downstream tasks. Different from the traditional repre-
sentation learning that is based mostly on discretized
labels, vision-language pre-training aligns images and
texts in a common feature space, which allows zero-`;
const RIGHT = `implementations of CoOp: unified context and class-
specific context. Through extensive experiments on 11
datasets, we demonstrate that CoOp requires as few as
one or two shots to beat hand-crafted prompts with a
decent margin and is able to gain significant improve-
ments over prompt engineering with more shots, e.g.,
with 16 shots the average gain is around 15% (with the
highest reaching over 45%). Despite being a learning-
based approach, CoOp achieves superb domain general-
ization performance compared with the zero-shot model
using hand-crafted prompts.`;
const PAGE2_LEFT = `images and raw texts using two separate encoders—one
for each modality. For instance, both CLIP and ALIGN
formulate the learning objective as a contrastive loss,
which pulls together images and their textual descrip-
tions while pushes away unmatched pairs in the feature
space. By pre-training at a large scale, models can learn
diverse visual concepts and can readily be transferred`;
const PAGE2_RIGHT = 'resulting prompts are by no means guaranteed to be optimal for these downstream tasks.';
const compact = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
const wait = ms => new Promise(r => setTimeout(r, ms));
let child, browser;
const results = [], errors = [], calls = [];
const check = (name, ok, evidence) => { results.push({ name, ok, evidence }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
try {
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`, env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  child = desktop ? spawnReader(stageExe('selection-journal').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let n = 0; n < 100 && !ready; n++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert(ready);
  if (!baseline) assert.equal(await fetch(`${base}/js/selection-reading-order.js`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public/js/selection-reading-order.js'), 'utf8'));
  await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'journal-selection-mock', apiKey: 'SYNTHETIC_JOURNAL_KEY' }) });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, defaultViewport: { width: 3840, height: 2160 } });
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(String(e)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (baseline && pathname === '/js/selection-reading-order.js') return request.respond({ status: 200, contentType: 'text/javascript', body: baseline });
    if (pathname === '/api/chat') {
      calls.push(JSON.parse(request.postData()));
      return request.respond({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: '独立栏选区的测试译文。' } }] })}\n\ndata: [DONE]\n\n` });
    }
    return request.continue();
  });
  await page.goto(`${base}/?open=journal.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  const show = async (n, scale) => {
    await page.keyboard.press('Escape');
    await page.evaluate(({ n, scale }) => { window.__viewer.setScale(scale); window.__viewer.goToPage(n); }, { n, scale });
    await page.waitForFunction(({ n, scale }) => { const v = window.__viewer, e = v.rendered.get(n);
      return e?.hitBoxes?.length && !v.renderTasks.has(n) && !e.dirty && Math.abs(e.renderScale - scale) < .001;
    }, { timeout: 30000 }, { n, scale });
  };
  // Glyph coordinates come from native DOM Ranges, never the reading-order algorithm.
  const point = (n, text, end) => page.evaluate(({ n, text, end }) => {
    const span = [...document.querySelectorAll(`.page[data-page="${n}"] .textLayer span:not(.markedContent)`) ].find(s => s.textContent === text);
    if (!span?.firstChild) throw new Error(`Missing independently chosen text: ${text}`);
    const range = document.createRange(), len = span.firstChild.length;
    range.setStart(span.firstChild, end ? len - 1 : 0); range.setEnd(span.firstChild, end ? len : 1);
    const r = range.getBoundingClientRect(); return { x: end ? r.right - .1 : r.left + .1, y: r.top + r.height / 2 };
  }, { n, text, end });
  const drag = async (n, text, reverse = false) => {
    await page.keyboard.press('Escape'); const lines = text.split('\n');
    const start = await point(n, lines[0], false), end = await point(n, lines.at(-1), true);
    const a = reverse ? end : start, b = reverse ? start : end;
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up(); await wait(130);
    return page.evaluate(n => ({ info: window.__viewer.getSelectionInfo(), action: window.__state.selection?.cleanText,
      painted: [...document.querySelectorAll(`.page[data-page="${n}"] .sel-mark`)].map(m => {
        const r = m.getBoundingClientRect(), p = m.closest('.page').getBoundingClientRect(); return { x: (r.left - p.left) / p.width, right: (r.right - p.left) / p.width };
      }) }), n);
  };
  for (const scale of [.75, 1, 1.5, 2, 3]) {
    await show(1, scale);
    for (const [side, expected] of [['left', LEFT], ['right', RIGHT]]) for (const reverse of [false, true]) {
      const result = await drag(1, expected, reverse);
      const rects = result.info?.rectsByPage[1] || [];
      const within = r => side === 'left' ? (r.right ?? r.x + r.w) < .49 : r.x > .49;
      check(`${scale * 100}% ${side} ${reverse ? 'backwards' : 'forwards'} text and highlights stay in their column`,
        compact(result.action) === compact(expected) && rects.length > 0 && rects.every(within) && result.painted.length > 0 && result.painted.every(within), result);
      if (scale === 2 && !reverse) await page.screenshot({ path: path.join(scratch, `200-percent-${side}.png`) });
    }
  }
  await show(2, 2);
  const secondLeft = await drag(2, PAGE2_LEFT);
  check('body below a full-width figure keeps left-column text and highlights', compact(secondLeft.action) === compact(PAGE2_LEFT)
    && secondLeft.painted.every(r => r.right < .49), secondLeft);
  const secondRight = await drag(2, PAGE2_RIGHT.replace(' optimal', '\noptimal'));
  check('body below a full-width figure keeps right-column text and highlights', compact(secondRight.action) === compact(PAGE2_RIGHT)
    && secondRight.painted.every(r => r.x > .49), secondRight);
  await page.click('#bubble button[data-act="translate"]');
  await page.waitForFunction(() => window.__state.sessionEntries.some(e => e.block === 'translate' && e.status === 'complete' && e.text === '独立栏选区的测试译文。'));
  const sent = String(calls.at(-1)?.messages?.at(-1)?.content || '').split('【需要翻译的片段】\n').at(-1);
  check('translation request contains only the chosen column', calls.length === 1 && compact(sent) === compact(PAGE2_RIGHT), { sent });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ results, errors }, null, 2), 'utf8');
  const passed = results.filter(r => r.ok).length;
  console.log(`Journal selection: ${passed}/${results.length} passed; ${scratch}`);
  if (passed !== results.length) process.exitCode = 1;
} finally { await browser?.close(); await stopChild(child); }
