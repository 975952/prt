/** Private CLIP 2103.00020v1 regression; PDF is copied only into test/artifacts.
 * node test/selection-real-pdf.mjs --pdf <path> [--desktop] [--source-ref bc26916]
 * Expectations were independently transcribed from the PDF, not from the selection algorithm.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const option = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; };
const source = option('--pdf') || process.env.SELECTION_PDF;
assert.ok(source && fs.existsSync(source), 'supply the private CLIP 2103.00020v1 PDF with --pdf');
const desktop = process.argv.includes('--desktop'), sourceRef = option('--source-ref');
assert.ok(!desktop || !sourceRef, 'desktop verification must use the real embedded sources');
const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
assert.equal(sourceHash, '6478b6e571a7d6fcd846d8ef77bfd60c285f1986abb8f475eedc43de403074f5', 'the independently transcribed expectations belong to this exact PDF');
const CHROME = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((file) => file && fs.existsSync(file));
assert.ok(CHROME);
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `selection-real-${desktop ? 'desktop' : sourceRef || 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers); fs.copyFileSync(source, path.join(papers, 'clip.pdf'));
const assets = ['app.js', 'pdfview.js', 'selection-reading-order.js'];
const baseline = new Map(sourceRef ? assets.map((name) => [`/js/${name}`,
  execFileSync('git', ['show', `${sourceRef}:public/js/${name}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })]) : []);
const compact = (text) => String(text || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
const LEFT_INTRO = `Pre-training methods which learn directly from raw text
have revolutionized NLP over the last few years (Dai &
Le, 2015; Peters et al., 2018; Howard & Ruder, 2018; Rad-
ford et al., 2018; Devlin et al., 2018; Raffel et al., 2019).`;
const RIGHT_INTRO = `Task-agnostic objectives such as autoregressive and masked
language modeling have scaled across many orders of mag-
nitude in compute, model capacity, and data, steadily im-
proving capabilities. The development of “text-to-text” as
a standardized input-output interface (McCann et al., 2018;
Radford et al., 2019; Raffel et al., 2019) has enabled task-
agnostic architectures to zero-shot transfer to downstream
datasets removing the need for specialized output heads or
dataset specific customization. Flagship systems like GPT-3
(Brown et al., 2020) are now competitive across many tasks
with bespoke models while requiring little to no dataset
specific training data.
These results suggest that the aggregate supervision acces-
sible to modern pre-training methods within web-scale col-
lections of text surpasses that of high-quality crowd-labeled
NLP datasets. However, in other fields such as computer
vision it is still standard practice to pre-train models on
crowd-labeled datasets such as ImageNet (Deng et al., 2009).
Could scalable pre-training methods which learn directly
from web text result in a similar breakthrough in computer
vision? Prior work is encouraging.`;
const RIGHT_LONG = `Over 20 years ago Mori et al. (1999) explored improving
content based image retrieval by training a model to pre-
dict the nouns and adjectives in text documents paired with
images. Quattoni et al. (2007) demonstrated it was possi-
ble to learn more data efficient image representations via
manifold learning in the weight space of classifiers trained
to predict words in captions associated with images. Sri-
vastava & Salakhutdinov (2012) explored deep represen-
tation learning by training multimodal Deep Boltzmann
Machines on top of low-level image and text tag features.
Joulin et al. (2016) modernized this line of work and demon-
strated that CNNs trained to predict words in image cap-
tions learn useful image representations. They converted
the title, description, and hashtag metadata of images in the
YFCC100M dataset (Thomee et al., 2016) into a bag-of-
words multi-label classification task and showed that pre-
training AlexNet (Krizhevsky et al., 2012) to predict these
labels learned representations which preformed similarly
to ImageNet-based pre-training on transfer tasks. Li et al.
(2017) then extended this approach to predicting phrase n-
grams in addition to individual words and demonstrated the
ability of their system to zero-shot transfer to other image`;
const PAGE2_CONTINUATION = `classification datasets by scoring target classes based on
their dictionary of learned visual n-grams and predicting the
one with the highest score. Adopting more recent architec-
tures and pre-training approaches, VirTex (Desai & Johnson,
2020), ICMLM (Bulent Sariyildiz et al., 2020), and Con-
VIRT (Zhang et al., 2020) have recently demonstrated the
potential of transformer-based language modeling, masked
language modeling, and contrastive objectives to learn im-
age representations from text.`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const results = [], pageErrors = [], chatBodies = [];
function check(name, ok, evidence) { results.push({ name, ok: !!ok, evidence }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
let reader, browser, page;
try {
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0',
    PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('selection-real').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { await wait(100); try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ } }
  assert.ok(ready);
  assert.equal(path.resolve((await fetch(`${base}/api/papers`).then((r) => r.json())).dir), path.resolve(papers));
  if (!sourceRef) for (const name of assets) assert.equal(await fetch(`${base}/js/${name}`).then((r) => r.text()),
    fs.readFileSync(path.join(ROOT, 'public/js', name), 'utf8'), `reader serves current ${name}`);
  await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'clip-selection-mock', apiKey: 'SYNTHETIC_CLIP_KEY' }) });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    userDataDir: path.join(scratch, 'browser-profile'), defaultViewport: { width: 3840, height: 2160 } });
  page = await browser.newPage(); page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (baseline.has(pathname)) request.respond({ status: 200, contentType: 'text/javascript', body: baseline.get(pathname) }).catch(() => {});
    else if (pathname === '/api/chat') {
      chatBodies.push(JSON.parse(request.postData() || '{}'));
      request.respond({ status: 200, contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: '真实选区回归译文。' } }] })}\n\ndata: [DONE]\n\n` }).catch(() => {});
    } else request.continue().catch(() => {});
  });
  await page.goto(`${base}/?open=clip.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx && window.__state.viewerDocId === window.__state.doc?.docId);
  const settled = (p, scale = null) => page.waitForFunction(({ p, scale }) => {
    const viewer = window.__viewer, entry = viewer?.rendered.get(p);
    return entry?.hitBoxes?.length && !entry.dirty && !viewer.renderTasks.has(p)
      && (scale === null || Math.abs(entry.renderScale - scale) < 0.001);
  }, { timeout: 30000 }, { p, scale });
  await settled(1);
  const scaleTo = async (scale) => {
    await page.keyboard.press('Escape');
    await page.evaluate(async (scale) => { window.__viewer.setScale(scale); await window.__viewer.goToPage(1); }, scale);
    await settled(1, scale); await wait(100);
  };
  const descriptor = (needle, column = 'right', pageNum = 1, last = false) => ({ needle, column, page: pageNum, last });
  const point = (where, end = false) => page.evaluate(({ where, end }) => {
    const host = document.querySelector(`.page[data-page="${where.page}"]`), pr = host.getBoundingClientRect();
    const pool = [...host.querySelectorAll('.textLayer span:not(.markedContent)')].filter((span) => {
      const r = span.getBoundingClientRect(), x = (r.left - pr.left) / pr.width;
      return span.firstChild?.nodeType === 3 && span.textContent.includes(where.needle)
        && (where.column === 'right' ? x > 0.49 : x < 0.49);
    });
    const span = where.last ? pool.at(-1) : pool[0];
    if (!span) throw new Error(`Cannot locate ${JSON.stringify(where)}`);
    const offset = span.textContent.indexOf(where.needle) + (end ? where.needle.length : 0), range = document.createRange();
    range.setStart(span.firstChild, end ? offset - 1 : offset); range.setEnd(span.firstChild, end ? offset : offset + 1);
    const r = range.getBoundingClientRect();
    return { x: end ? r.right - 0.1 : r.left + 0.1, y: r.top + r.height / 2,
      page: where.page, nx: ((end ? r.right : r.left) - pr.left) / pr.width, ny: (r.top + r.height / 2 - pr.top) / pr.height };
  }, { where, end });
  const snapshot = () => page.evaluate(() => ({ native: window.getSelection()?.toString(), info: window.__viewer.getSelectionInfo(),
    selection: window.__state.selection, marks: [...document.querySelectorAll('.page')].flatMap((host) => {
      const pr = host.getBoundingClientRect();
      return [...host.querySelectorAll('.sel-mark')].map((mark) => { const r = mark.getBoundingClientRect();
        return { page: Number(host.dataset.page), x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height,
          w: r.width / pr.width, h: r.height / pr.height }; });
    }) }));
  // Independently sample native per-character Range rectangles, never selection runs.
  const rightGlyphCoverage = (a, b) => page.evaluate(({ a, b }) => {
    const host = document.querySelector('.page[data-page="1"]'), pr = host.getBoundingClientRect();
    const y0 = pr.top + Math.min(a.ny, b.ny) * pr.height, y1 = pr.top + Math.max(a.ny, b.ny) * pr.height;
    const marks = [...host.querySelectorAll('.sel-mark')].map((mark) => mark.getBoundingClientRect());
    let glyphs = 0, samples = 0, missedSamples = 0;
    const misses = [], bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const span of host.querySelectorAll('.textLayer span:not(.markedContent)')) {
      const node = span.firstChild;
      if (node?.nodeType !== 3) continue;
      for (let i = 0; i < node.textContent.length; i++) {
        if (!node.textContent[i].trim()) continue;
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect(), x = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
        if (r.width <= 0 || r.height <= 0 || x < pr.left + pr.width * 0.49 || cy < y0 - 0.5 || cy > y1 + 0.5) continue;
        glyphs++; bounds.left = Math.min(bounds.left, r.left); bounds.top = Math.min(bounds.top, r.top);
        bounds.right = Math.max(bounds.right, r.right); bounds.bottom = Math.max(bounds.bottom, r.bottom);
        const ys = [r.top + Math.min(0.25, r.height / 4), cy, r.bottom - Math.min(0.25, r.height / 4)];
        for (const [position, y] of ys.entries()) {
          samples++;
          if (marks.some((mark) => x >= mark.left - 0.5 && x <= mark.right + 0.5 && y >= mark.top - 0.5 && y <= mark.bottom + 0.5)) continue;
          missedSamples++;
          if (misses.length < 30) misses.push({ character: node.textContent[i], offset: i, line: span.textContent,
            position: ['top', 'middle', 'bottom'][position], x, y, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
        }
      }
    }
    return { glyphs, samples, missedSamples, misses, bounds };
  }, { a, b });
  const drag = async (from, to, { reverse = false, ctrl = false, clear = true, scroll = false } = {}) => {
    if (clear) await page.keyboard.press('Escape');
    const a = await point(from), b = await point(to, true);
    let start = reverse ? b : a, end = reverse ? a : b;
    if (ctrl) await page.keyboard.down('Control');
    try {
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      if (scroll) {
        const limits = await page.$eval('#viewer', (v) => ({ top: v.getBoundingClientRect().top, bottom: v.getBoundingClientRect().bottom }));
        await page.mouse.move(start.x, limits.bottom - 30, { steps: 6 });
        await page.mouse.wheel({ deltaY: Math.max(0, end.y - limits.bottom + 150) });
        await wait(250); end = await point(to, true);
      }
      await page.mouse.move(end.x, end.y, { steps: 24 }); await page.mouse.up();
    } finally { if (ctrl) await page.keyboard.up('Control'); }
    await wait(180); return { a, b, ...(await snapshot()) };
  };
  const dump = async (scale) => {
    const value = await page.evaluate(() => {
      const viewer = window.__viewer, entry = viewer.rendered.get(1);
      return { scale: viewer.scale, width: entry.cssW, height: entry.cssH,
        raw: entry.hitBoxes.map((box, index) => ({ index, text: box.node.textContent, l: box.l, t: box.t, w: box.w, h: box.h,
          tilted: box.tilted, style: box.span.getAttribute('style') })),
        ordered: viewer._selectionRunsForPage(1).map(({ node, span, ...run }) => run) };
    });
    fs.writeFileSync(path.join(scratch, `runs-${scale}.json`), JSON.stringify(value, null, 2), 'utf8');
  };
  const introStart = descriptor('Task-agnostic'), introEnd = descriptor('encouraging.');
  const leftStart = descriptor('Pre-training', 'left'), leftEnd = descriptor('2019).', 'left', 1, true);
  const longStart = descriptor('Over 20 years ago'), longEnd = descriptor('other image');
  for (const scale of [1, 2.28]) {
    await scaleTo(scale); await dump(scale);
    for (const reverse of [false, true]) {
      const actual = await drag(introStart, introEnd, { reverse });
      const text = actual.selection?.cleanText || actual.info?.text || '';
      const missingLines = RIGHT_INTRO.split('\n').filter((line) => !compact(text).includes(compact(line)));
      const coverage = await rightGlyphCoverage(actual.a, actual.b);
      check(`CLIP right introduction ${Math.round(scale * 100)}% ${reverse ? 'reverse' : 'forward'} preserves every line and citation`,
        compact(text) === compact(RIGHT_INTRO) && !/github|OpenAI\/CLIP/i.test(text)
          && actual.marks.length > 0 && actual.marks.every((mark) => mark.page === 1 && mark.x > 0.48),
        { expected: RIGHT_INTRO, missingLines, actual });
      check(`CLIP right introduction ${Math.round(scale * 100)}% ${reverse ? 'reverse' : 'forward'} highlights every glyph from top to bottom`,
        coverage.glyphs > 800 && coverage.missedSamples === 0, coverage);
      if (scale === 2.28 && !reverse) {
        await page.screenshot({ path: path.join(scratch, 'right-introduction-228.png') });
        const { left, top, right, bottom } = coverage.bounds;
        await page.screenshot({ path: path.join(scratch, 'right-introduction-228-detail.png'),
          clip: { x: left - 16, y: top - 44, width: right - left + 32, height: bottom - top + 60 } });
        await page.click('#bubble button[data-act="translate"]');
        await page.waitForFunction(() => !window.__state.busy && window.__state.sessionEntries.some((entry) => entry.text === '真实选区回归译文。'));
        const sent = String(chatBodies.at(-1)?.messages?.at(-1)?.content || '').split('【需要翻译的片段】\n').at(-1);
        check('the direct translation request contains the complete right-column source and no left text',
          chatBodies.length === 1 && compact(sent) === compact(RIGHT_INTRO), { requestCount: chatBodies.length, sent });
      }
    }
    const long = await drag(longStart, longEnd);
    check(`CLIP long right paragraph ${Math.round(scale * 100)}% keeps every author/year and its final line`,
      compact(long.selection?.cleanText) === compact(RIGHT_LONG) && !/github/i.test(long.selection?.cleanText || ''),
      { expected: RIGHT_LONG, missingLines: RIGHT_LONG.split('\n').filter((line) => !compact(long.selection?.cleanText).includes(compact(line))), actual: long });
    const across = await drag(leftStart, introEnd);
    const acrossText = compact(across.selection?.cleanText), leftAt = acrossText.indexOf(compact(LEFT_INTRO)), rightAt = acrossText.indexOf(compact(RIGHT_INTRO));
    check(`CLIP left introduction to right introduction ${Math.round(scale * 100)}% includes both bodies in order`,
      leftAt >= 0 && rightAt > leftAt && !/github/i.test(across.selection?.cleanText || ''), { expectedLeft: LEFT_INTRO, expectedRight: RIGHT_INTRO, actual: across });
    await drag(leftStart, leftEnd);
    const combined = await drag(introStart, introEnd, { ctrl: true, clear: false });
    check(`CLIP Ctrl-separated introduction ${Math.round(scale * 100)}% skips unselected footnotes and the GitHub link`,
      compact(combined.selection?.cleanText) === compact(LEFT_INTRO + RIGHT_INTRO)
        && !/github|Equal contribution|Correspondence to/i.test(combined.selection?.cleanText || ''), { actual: combined });
  }

  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__viewer.goToPage(2)); await settled(2, 2.28);
  await page.evaluate(() => window.__viewer.goToPage(1)); await settled(1, 2.28);
  const cross = await drag(descriptor('ability of their system'), descriptor('representations from text.', 'left', 2), { scroll: true });
  const tail = RIGHT_LONG.split('\n').at(-1), crossText = compact(cross.selection?.cleanText);
  check('CLIP 228% cross-page mouse drag retains the page-one tail and complete page-two continuation',
    crossText.includes(compact(tail)) && crossText.includes(compact(PAGE2_CONTINUATION))
      && JSON.stringify(cross.selection?.pages) === '[1,2]' && !/github/i.test(cross.selection?.cleanText || ''),
    { expectedTail: tail, expectedContinuation: PAGE2_CONTINUATION, actual: cross });
  check('no browser exception and exactly one intercepted model call', pageErrors.length === 0 && chatBodies.length === 1, { pageErrors, requestCount: chatBodies.length });
  const passed = results.filter((result) => result.ok).length;
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, sourceRef, sourceHash, passed, total: results.length, results }, null, 2), 'utf8');
  console.log(`Real PDF selection: ${passed}/${results.length} passed; evidence: ${scratch}`);
  if (passed !== results.length) process.exitCode = 1;
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: String(error.stack || error), pageErrors, results }, null, 2), 'utf8');
  console.error(`Real PDF selection evidence: ${scratch}`); throw error;
} finally {
  if (browser) await browser.close();
  if (reader) await stopChild(reader);
}
