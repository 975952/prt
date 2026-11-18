/** Reading-output contracts. Uses synthetic text and an isolated browser only.
 * node test/render-quality.mjs [--math]
 * --math also starts a disposable fixture service for the existing math suite.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';

const CHROME = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((file) => file && fs.existsSync(file));
assert.ok(CHROME, 'a local browser is available');
// Serve the real modules so relative imports (including locale dependencies)
// resolve exactly as they do in the app, without rewriting module source.
const moduleRoot = path.join(ROOT, 'public/js');
const moduleServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html lang="en"><body></body></html>');
    return;
  }
  const file = path.resolve(moduleRoot, `.${pathname}`);
  const relative = path.relative(moduleRoot, file);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && file.endsWith('.js') && fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(fs.readFileSync(file));
    return;
  }
  res.writeHead(404); res.end();
});
const cases = {
  lists: '3. Main argument\n   - First condition\n     7. Detail\n     8. More detail\n   - Second condition\n\n4. Next argument\n\n9. Explicit numbering\n\nA separate paragraph.',
  continuation: '- First paragraph\n  continuation\n\n  Second paragraph in the same item.\n\n- Next item',
  blocks: 'Intro\n\n## A heading\n\n- One\n- Two\n\n> A quotation\n>\n> - Evidence\n> - Caveat\n\nEnd.',
  table: '| Label | Value |\n|:---|---:|\n| Extra | 1 | 99 |\n| Short |\n| `a | b` | $\\left|x\\right|$ |\n\nAfter the table.',
  links: '[paper](https://example.com/a_(b)?x=1&y=2 "A paper") and [**source**](https://example.org/)\n\n[unsafe](javascript:alert(1)) [file](file:///private)\n\n<img src=x onerror=alert(1)> <script>alert(2)</script>',
  code: '```python\nif x:\n    print("$x$ | <tag>")\n\n\n    return x\n```\n\n~~~text\n**literal**\n~~~\n\nInline: `a | b` and ``a `tick` $x$``.',
  math: 'Start $x_1$ then \\[\\begin{aligned}a&=b\\\\\nc&=d\\end{aligned}\\] then end.\n\nA broken expression: $\\frac{1}$ and prices $5 to $10.\n\n$$\\frac{1}$$',
  citations: '> Original **claim** 〔p.3‖a continuous original sentence〕\n\n## C#\n\nText \\*literal\\* and **important**.',
  interrupted: '```js\nconst x = "<unsafe>";\n  $x$\n',
  quoteCode: '> Example:\n>\n> ```python\n> if x:\n>     print("$x$")\n> ```\n\nOutside quotation.',
  edgePipe: 'A | B\n--- | ---\nvalue | ends with \\|',
  deep: `${'> '.repeat(100)}Deep content survives.`,
  entities: '**OK（也写作 okay）**&#x662F;常见的口语表达\n\n&#26159; &#X1F642; &amp; &lt; &gt; &quot; &apos; &nbsp; &copy; &mdash; &hellip; &alpha;',
  entityBlocks: '## A &amp; B\n\n- &#x662F;\n\n| Label | Value |\n| --- | --- |\n| &lt; | &#26159; |\n\n[source &#x662F;](https://example.com/)',
  entitySyntax: '&#35; Heading\n\n&#45; item\n\n&#96;not code&#96; &#42;&#42;not bold&#42;&#42; &#36;x&#36;\n\n&#91;not a link&#93;&#40;https://example.com&#41;\n\n&amp;lt; &#38;#x662F; &unknown; &#xZZ; &#x66',
  entityCode: '`&#x662F; &amp; &lt;`\n\n```html\n&#26159; &copy; &#x3C;img src=x onerror=alert(1)&#x3E;\n```',
  entityHtml: '&#x3C;img src=x onerror=alert(1)&#x3E;\n\n&lt;script&gt;alert(2)&lt;/script&gt;\n\n&#60;svg onload=alert(3)&#62;\n\n[unsafe](jav&#x61;script:alert%281%29)',
};

let browser;
try {
  await new Promise((resolve) => moduleServer.listen(0, '127.0.0.1', resolve));
  const moduleBase = `http://127.0.0.1:${moduleServer.address().port}`;
  const moduleUrl = `${moduleBase}/util.js`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1100, height: 850 } });
  const page = await browser.newPage();
  await page.goto(moduleBase);
  await page.addScriptTag({ path: path.join(ROOT, 'public/vendor/katex/katex.min.js') });
  const rendered = await page.evaluate(async ({ moduleUrl, cases }) => {
    const { renderMarkdown } = await import(moduleUrl);
    const results = {};
    for (const [name, markdown] of Object.entries(cases)) {
      const html = renderMarkdown(markdown);
      const box = document.createElement('div');
      box.innerHTML = html;
      results[name] = {
        html, text: box.textContent,
        children: [...box.children].map((node) => node.tagName),
        emptyParagraphs: [...box.querySelectorAll('p')].filter((node) => !node.textContent.trim() && !node.children.length).length,
        listStarts: [...box.querySelectorAll('ol')].map((node) => node.start),
        listValues: [...box.querySelectorAll('li[value]')].map((node) => node.value),
        nested: box.querySelectorAll('ol > li > ul > li > ol > li').length,
        outerItems: box.querySelector(':scope > ol')?.children.length || 0,
        cells: [...box.querySelectorAll('tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent)),
        headers: [...box.querySelectorAll('th')].map((node) => ({ text: node.textContent, align: node.style.textAlign })),
        code: [...box.querySelectorAll('code')].map((node) => ({ text: node.textContent, class: node.className })),
        links: [...box.querySelectorAll('a')].map((node) => ({ href: node.href, text: node.textContent, rel: node.rel })),
        dangerous: box.querySelectorAll('script, img, iframe, svg, [onclick], [onerror], [onload]').length,
        math: box.querySelectorAll('.katex').length,
        displayMath: box.querySelectorAll('.katex-display').length,
        mathBreaks: box.querySelectorAll('math br, .katex br').length,
        quoteItems: box.querySelectorAll('blockquote ul > li').length,
      };
    }
    return results;
  }, { moduleUrl, cases });

  assert.deepEqual(rendered.lists.listStarts, [3, 7]);
  assert.deepEqual(rendered.lists.listValues, [9]);
  assert.equal(rendered.lists.nested, 2);
  assert.equal(rendered.lists.outerItems, 3);
  assert.deepEqual(rendered.lists.children, ['OL', 'P']);
  console.log('PASS nested lists retain hierarchy, start number and explicit numbering');

  assert.match(rendered.continuation.html, /<li>First paragraph<br \/>continuation\s*<p>Second paragraph/);
  assert.equal((rendered.continuation.html.match(/<ul>/g) || []).length, 1);
  assert.equal((rendered.continuation.html.match(/<li>/g) || []).length, 2);
  assert.equal(rendered.continuation.emptyParagraphs, 0);
  console.log('PASS list continuations and item paragraphs remain in the same list');

  assert.deepEqual(rendered.blocks.children, ['P', 'H4', 'UL', 'BLOCKQUOTE', 'P']);
  assert.equal(rendered.blocks.quoteItems, 2);
  assert.equal(rendered.blocks.emptyParagraphs, 0);
  assert.ok(!/<p>\s*<(?:ul|ol|h[1-6]|blockquote|pre|table)/.test(rendered.blocks.html));
  console.log('PASS headings, paragraphs, lists and quotations produce legal block structure');

  assert.equal(rendered.table.cells[0][2], '99');
  assert.equal(rendered.table.cells[1].length, 3);
  assert.equal(rendered.table.cells[2][0], 'a | b');
  assert.equal(rendered.table.headers.length, 3);
  assert.equal(rendered.table.headers[1].align, 'right');
  assert.equal(rendered.table.math, 1);
  assert.ok(rendered.table.text.includes('After the table.'));
  console.log('PASS ragged tables preserve extra cells, short rows, alignment, code and math');

  assert.equal(rendered.links.links.length, 2);
  assert.equal(rendered.links.links[0].href, 'https://example.com/a_(b)?x=1&y=2');
  assert.equal(rendered.links.links[1].text, 'source');
  assert.ok(rendered.links.links.every((link) => link.rel.includes('noopener')));
  assert.equal(rendered.links.dangerous, 0);
  assert.ok(rendered.links.text.includes('<script>alert(2)</script>'));
  assert.ok(rendered.links.text.includes('javascript:alert(1)'));
  console.log('PASS safe source links work while raw HTML and unsafe URLs remain inert text');

  assert.equal(rendered.code.code.length, 4);
  assert.equal(rendered.code.code[0].class, 'language-python');
  assert.equal(rendered.code.code[0].text, 'if x:\n    print("$x$ | <tag>")\n\n\n    return x');
  assert.equal(rendered.code.code[1].text, '**literal**');
  assert.equal(rendered.code.code[3].text, 'a `tick` $x$');
  assert.equal(rendered.code.math, 0);
  assert.equal(rendered.code.dangerous, 0);
  console.log('PASS code whitespace, language, dollar signs and literal Markdown survive intact');

  assert.equal(rendered.math.math, 2);
  assert.equal(rendered.math.displayMath, 1);
  assert.equal(rendered.math.mathBreaks, 0);
  assert.ok(rendered.math.text.includes('\\frac{1}'));
  assert.ok(rendered.math.text.includes('$5 to $10'));
  assert.deepEqual(rendered.math.children.slice(0, 3), ['P', 'SPAN', 'P']);
  console.log('PASS multiline math, failed-formula fallback and currency render without content loss');

  assert.ok(rendered.citations.text.includes('〔p.3‖a continuous original sentence〕'));
  assert.ok(rendered.citations.text.includes('C#'));
  assert.ok(rendered.citations.text.includes('*literal*'));
  assert.equal((rendered.citations.html.match(/<strong>/g) || []).length, 2);
  assert.ok(rendered.interrupted.code[0].text.includes('const x = "<unsafe>";'));
  assert.equal(rendered.interrupted.dangerous, 0);
  assert.ok(rendered.deep.text.includes('Deep content survives.'));
  console.log('PASS citations, escaped punctuation, interrupted code and deep nesting stay readable');

  assert.equal(rendered.quoteCode.code[0].text, 'if x:\n    print("$x$")');
  assert.equal(rendered.quoteCode.math, 0);
  assert.deepEqual(rendered.quoteCode.children, ['BLOCKQUOTE', 'P']);
  assert.equal(rendered.edgePipe.cells[0][1], 'ends with |');
  console.log('PASS quoted code retains indentation and a final escaped table pipe remains visible');

  assert.equal(rendered.entities.text, 'OK（也写作 okay）是常见的口语表达\n是 🙂 & < > " \' \u00a0 © — … α');
  assert.equal((rendered.entities.html.match(/<strong>/g) || []).length, 1);
  assert.deepEqual(rendered.entityBlocks.children, ['H4', 'UL', 'DIV', 'P']);
  assert.ok(rendered.entityBlocks.text.startsWith('A & B\n是'));
  assert.deepEqual(rendered.entityBlocks.cells, [['<', '是']]);
  assert.equal(rendered.entityBlocks.links[0].text, 'source 是');
  console.log('PASS numeric and named entities display as characters in prose, headings, lists, tables and link labels');

  assert.deepEqual(rendered.entitySyntax.children, ['P', 'P', 'P', 'P', 'P']);
  assert.ok(rendered.entitySyntax.text.includes('`not code` **not bold** $x$'));
  assert.ok(rendered.entitySyntax.text.includes('[not a link](https://example.com)'));
  assert.ok(rendered.entitySyntax.text.endsWith('&lt; &#x662F; &unknown; &#xZZ; &#x66'));
  assert.equal(rendered.entitySyntax.code.length, 0);
  assert.equal(rendered.entitySyntax.links.length, 0);
  assert.equal(rendered.entitySyntax.math, 0);
  assert.ok(!rendered.entitySyntax.html.includes('<strong>'));
  assert.deepEqual(rendered.entityCode.code.map((node) => node.text), [
    '&#x662F; &amp; &lt;', '&#26159; &copy; &#x3C;img src=x onerror=alert(1)&#x3E;',
  ]);
  console.log('PASS entity decoding happens once, never creates Markdown syntax, and preserves code literals');

  assert.equal(rendered.entityHtml.dangerous, 0);
  assert.equal(rendered.entityHtml.links.length, 0);
  assert.ok(rendered.entityHtml.text.includes('<img src=x onerror=alert(1)>'));
  assert.ok(rendered.entityHtml.text.includes('<script>alert(2)</script>'));
  assert.ok(rendered.entityHtml.text.includes('<svg onload=alert(3)>'));
  assert.equal(rendered.entityCode.dangerous, 0);
  console.log('PASS entity-encoded tags and unsafe link schemes stay inert text');
} finally {
  await browser?.close();
  await new Promise((resolve) => moduleServer.close(resolve));
}

if (process.argv.includes('--math')) {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(SANDBOX, 'render-math-'));
  const data = assertIsolatedDataDir(path.join(scratch, 'data'));
  const papers = path.join(scratch, 'papers');
  fs.mkdirSync(data); fs.mkdirSync(papers);
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'render-fixture.pdf'));
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', BASE: base, CHROME };
  const service = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore', windowsHide: true });
  try {
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ }
    }
    assert.ok(ready, 'isolated math fixture service starts');
    const config = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'render-test', apiKey: 'SYNTHETIC_RENDER_TEST' }) });
    assert.ok(config.ok);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'test/math.mjs')], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
      child.on('error', reject); child.on('exit', resolve);
    });
    assert.equal(code, 0, 'existing math regression passes against isolated data');
  } finally { service.kill(); }
}
