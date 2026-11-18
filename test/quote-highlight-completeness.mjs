/** Complete source highlights, using synthetic spans/PDFs and no AI requests.
 * node test/quote-highlight-completeness.mjs [--unit|--desktop]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { PdfViewer } from '../public/js/pdfview.js';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log(`PASS ${label}`); };
const bareViewer = () => Object.create(PdfViewer.prototype);
const spans = rows => rows.map(textContent => ({ textContent }));
const coveredText = (rows, match) => match.hits.map(hit => rows[hit.spanIndex].slice(hit.start, hit.end)).join('');
const splitRows = ['The network learns rich repre-', 'sentations and improves classifi-', 'cation performance with additional lay-', 'ers.'];
const splitQuote = 'The network learns rich representations and improves classification performance with additional layers.';
let match = bareViewer()._matchQuote(spans(splitRows), splitQuote);
check('line-end word splits still highlight through the final line', match.hits.at(-1)?.spanIndex === 3 && match.hits.at(-1)?.end === 4);
const compoundRows = ['The data-', 'efficient model retains its complete source quotation.'];
match = bareViewer()._matchQuote(spans(compoundRows), 'The data-efficient model retains its complete source quotation.');
check('lexical hyphens preserved in a quote still match a compound split over PDF lines', match.hits.at(-1)?.spanIndex === 1 && match.hits.at(-1)?.end === compoundRows[1].length);
match = bareViewer()._matchQuote(spans(['The value is xy.']), 'The value is x-y.');
check('single-letter subtraction is not collapsed into a different symbol', match.hits.length === 0);
const glyphRows = ['The ﬁnal efﬁcient network uses residual learning.'];
match = bareViewer()._matchQuote(spans(glyphRows), 'The final efficient network uses residual learning.');
check('PDF ligatures map back to every original glyph', match.hits.length === 1 && match.hits[0].end === glyphRows[0].length);
for (const [rows, quote] of [
  [['The classiﬁ-', 'cation result retains its final source words.'], 'The classification result retains its final source words.'],
  [['The ef-', 'ﬁcient model retains its final source words.'], 'The efficient model retains its final source words.'],
]) {
  match = bareViewer()._matchQuote(spans(rows), quote);
  check(`a ligature adjoining a PDF word break preserves the complete original range: ${rows[0]}`,
    match.hits.at(-1)?.spanIndex === 1 && match.hits.at(-1)?.end === rows[1].length);
}
check('numeric ranges remain distinct from concatenated numbers', bareViewer()._normPageText('10-20').lower === '10-20'
  && bareViewer()._matchQuote(spans(['The range is 1020.']), 'The range is 10-20.').hits.length === 0);
const softRows = ['The representa\u00adtion remains visible through its final word.'];
match = bareViewer()._matchQuote(spans(softRows), 'The representation remains visible through its final word.');
check('soft hyphens cannot truncate the rest of the sentence', coveredText(softRows, match).endsWith('final word.'));
const longQuote = Array.from({ length: 12 }, (_, i) => `Quoted line ${i + 1} contains a distinct scientific observation and remains part of the same source passage.`).join(' ');
match = bareViewer()._matchQuote(spans([longQuote]), longQuote);
check('a complete long quotation is not reduced to its opening anchor', match.hits[0]?.end === longQuote.length);
const unrelated = 'Matching introduction. Entirely unrelated inserted paragraph. The original final clause.';
match = bareViewer()._matchQuote(spans([unrelated]), 'Matching introduction. The original final clause.');
check('the matcher does not bridge unrelated text merely because a suffix agrees', match.hits.length === 0);
const pageOne = 'This is the first page boundary.';
const pageTwo = 'The next page continues with complete quoted evidence and finishes with an essential conclusion. '.repeat(3).trim();
let v = bareViewer(); v._quote = { page: 1, fragment: `${pageOne} ${pageTwo}` }; v.numPages = 2; v.getPageText = async () => pageTwo;
let extras = await v._quoteExtraPages(1, pageOne.replace(/\s+/g, '').length);
check('a continuation longer than eighty characters is highlighted to its real end', extras[2] === pageTwo);
const pageThree = 'A third page contains the actual end of this continuing quotation.';
v = bareViewer(); v._quote = { page: 1, fragment: `${pageOne} ${pageTwo} ${pageThree}` }; v.numPages = 3;
v.getPageText = async page => page === 2 ? pageTwo : pageThree;
extras = await v._quoteExtraPages(1, pageOne.replace(/\s+/g, '').length);
check('three-page passages consume each full continuation before advancing', extras[2] === pageTwo && extras[3] === pageThree);
v = bareViewer(); v._quote = { page: 1, fragment: 'The quotation ends with layers.' }; v.numPages = 2; v.getPageText = async () => 'ers.';
extras = await v._quoteExtraPages(1, 'Thequotationendswithlay'.length);
check('a final word split across pages retains its short continuation', extras[2] === 'ers.');
v = bareViewer(); v._quote = { page: 1, fragment: `${pageOne} ${pageTwo}` }; v.numPages = 2;
v.getPageText = async () => { v._quote = { page: 2, fragment: 'A newer selection.' }; return pageTwo; };
extras = await v._quoteExtraPages(1, pageOne.replace(/\s+/g, '').length);
check('a superseded asynchronous lookup cannot attach continuations to a newer quote', Object.keys(extras).length === 0);

if (process.argv.includes('--unit')) { console.log(`quote-highlight-completeness: ${checks.length}/${checks.length} passed`); process.exit(0); }
const desktop = process.argv.includes('--desktop');
const scratch = fs.mkdtempSync(path.join(SANDBOX, `quote-highlight-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
const literal = text => text.replace(/[\\()]/g, '\\$&');
const longRows = Array.from({ length: 12 }, (_, i) => `Evidence ${i + 1}: this continuous source passage retains all of its words when the citation is highlighted.`);
const longBrowserQuote = longRows.join(' ');
const firstCross = ['A quoted passage starts near the end of one page', 'and continues without losing its later evidence.'];
const secondCross = Array.from({ length: 5 }, (_, i) => `Continuation ${i + 1} includes important source details beyond the old eighty character limit.`);
const browserCross = [...firstCross, ...secondCross].join(' ');
const pageRows = [
  [...longRows.map((text, i) => ({ text, y: 720 - i * 18 })), ...splitRows.map((text, i) => ({ text, y: 420 - i * 18 }))],
  firstCross.map((text, i) => ({ text, y: 110 - i * 18 })),
  secondCross.map((text, i) => ({ text, y: 720 - i * 18 })),
];
function writeFixture(file) {
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const ids = [];
  for (const rows of pageRows) {
    const content = rows.map(row => `BT /F1 9 Tf 1 0 0 1 40 ${row.y} Tm (${literal(row.text)}) Tj ET`).join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    const contentId = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`); ids.push(objects.length);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Count 3 /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] >>`;
  let content = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(content)); content += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, content, 'ascii');
}
writeFixture(path.join(papers, 'complete-quote.pdf'));
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
const reader = desktop ? spawnReader(stageExe('quote-highlight').exe, { args: ['--port', String(port)], env })
  : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
let browser; const errors = [], evidence = [];
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(await fetch(`${base}/js/pdfview.js`).then(response => response.text()), fs.readFileSync(path.join(ROOT, 'public/js/pdfview.js'), 'utf8'), 'the served viewer is the current source/build');
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if ((['http:', 'https:'].includes(url.protocol) && url.origin !== base) || /\/api\/(?:chat|web-search|ref-search)/.test(url.pathname)) { errors.push(`Unexpected network: ${url.pathname}`); return request.abort(); }
    return request.continue();
  });
  await page.goto(`${base}/?open=complete-quote.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__viewer?.numPages === 3);
  const verifyHighlight = async (target, quote, endPage, marker) => {
    const result = await page.evaluate(async ({ target, quote, endPage, marker }) => {
      const viewer = window.__viewer; const ok = await viewer.highlightQuote(target, quote);
      // Rendering a continuation later must restore the full retained fragment.
      await viewer.renderTasks.get(endPage)?.catch(() => {});
      if (!viewer.rendered.get(endPage)?.textDiv) await viewer.refreshPage(endPage);
      viewer._paintQuote(endPage);
      const entry = viewer.rendered.get(endPage), spans = viewer._quoteSpans(endPage);
      const actual = target === endPage ? viewer._quote.fragment : viewer._quote.extra?.[endPage];
      const found = viewer._matchQuote(spans, actual);
      const covered = found.hits.map(hit => spans[hit.spanIndex].textContent.slice(hit.start, hit.end)).join(' ');
      const lastSpan = spans.find(span => span.textContent.includes(marker));
      if (!lastSpan) throw new Error(`Missing final span ${marker}: ${JSON.stringify({ ok, actual, spans: spans.map(span => span.textContent) })}`);
      const glyph = document.createRange(); glyph.selectNodeContents(lastSpan);
      const bounds = glyph.getBoundingClientRect(), pageBounds = viewer.pageEls[endPage].getBoundingClientRect();
      const finalTop = bounds.top - pageBounds.top;
      const finalPainted = [...entry.quoteLayer.children].some(node => {
        const top = parseFloat(node.style.top), bottom = top + parseFloat(node.style.height);
        return top <= finalTop + bounds.height && bottom >= finalTop;
      });
      return { ok, inputLength: quote.length, retainedLength: viewer._quote.fragment.length, covered, finalPainted, hits: entry.quoteLayer.children.length };
    }, { target, quote, endPage, marker });
    evidence.push(result); return result;
  };
  let result = await verifyHighlight(1, longBrowserQuote, 1, 'Evidence 12:');
  check('a real PDF highlights the last line of a quote beyond six hundred characters', result.ok && result.retainedLength === longBrowserQuote.length && result.covered.includes(longRows.at(-1)) && result.finalPainted);
  result = await verifyHighlight(1, splitQuote, 1, 'ers.');
  check('a real PDF with several line-end hyphens highlights the final continuation', result.ok && result.covered.endsWith('ers.') && result.finalPainted);
  result = await verifyHighlight(2, browserCross, 3, 'Continuation 5');
  check('a real PDF highlights the entire next-page continuation beyond eighty characters', result.ok && result.covered.includes(secondCross.at(-1)) && result.finalPainted);
  check('source highlighting makes no model calls and causes no browser errors', errors.length === 0);
  await page.screenshot({ path: path.join(scratch, 'complete-highlight.png') });
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors, evidence }, null, 2), 'utf8');
  console.log(`quote-highlight-completeness: ${checks.length}/${checks.length} passed; ${scratch}`);
} finally { await browser?.close(); await stopChild(reader); }
