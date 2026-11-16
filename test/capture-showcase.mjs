/** Capture the real app with a public paper and explicitly illustrative answers. No model requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stopChild } from './_exe.mjs';

const input = process.argv[process.argv.indexOf('--pdf') + 1];
assert.ok(process.argv.includes('--pdf') && input && fs.existsSync(input), 'Pass --pdf <Attention Is All You Need.pdf>');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'repository-showcase-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(input, path.join(papers, 'Attention Is All You Need.pdf'));
const output = path.join(ROOT, 'docs/assets');
fs.mkdirSync(output, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
      PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' } });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ }
    if (!ready) await wait(100);
  }
  assert.ok(ready, 'isolated server starts');
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1500, height: 980, deviceScaleFactor: 1.5 } });
  const page = await browser.newPage(), errors = [], modelCalls = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (/\/api\/(chat|agent|translate)(?:\?|$)/.test(request.url())) modelCalls.push(request.url()); });
  await page.goto(`${base}/?open=Attention%20Is%20All%20You%20Need.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.numPages > 3 && window.__state?.doc);
  await page.locator('.aibar-btn[data-block="chat"]').click();
  await page.click('#sessNew');
  await page.waitForFunction(() => window.__ctx.activeSession && !document.querySelector('#aiArea > .entry-card'));
  await page.evaluate(() => {
    const side = document.querySelector('#rightSide');
    side.style.width = side.style.minWidth = side.style.maxWidth = '440px';
    window.__ctx.addEntry({ block: 'chat', kind: 'user', text: '图 1 的编码器和解码器是怎么配合的？' });
    const answer = String.raw`**编码器理解输入，解码器逐步生成输出。** 图 1 左边是编码器，右边是解码器，两侧都堆叠了 $N$ 层。

### 沿着图中的连线看

1. **左侧：读完整个输入。** 词向量加上位置编码后，经过自注意力和前馈网络，得到每个位置的上下文表示。
2. **右侧下方：读已经生成的词。** 掩码自注意力挡住未来位置，预测时只能看当前位置及之前的内容。
3. **中间的连线：对照输入。** 解码器用自身的表示作 $Q$，用编码器输出作 $K$ 和 $V$，找到此刻需要的信息。
4. **右侧顶部：预测下一个词。** 经过线性层和 softmax，得到词表上的概率分布。

### 注意力在做什么？

$$
\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\!\left(\frac{QK^{\mathsf T}}{\sqrt{d_k}}\right)V
$$

$QK^{\mathsf T}$ 决定“看哪里”，加权后的 $V$ 提供“读到什么”。每层的残差连接与归一化帮助信息稳定传递。

回到图 1：**跨越左右两侧的箭头，就是编码器与解码器交换信息的位置。**`;
    const reply = window.__ctx.addEntry({ block: 'chat', tag: '回答', page: 3, text: answer });
    window.__ctx.finishEntry(reply, answer);
  });
  for (const [theme, file] of [['glass', 'reading-glass.png'], ['light', 'reading-paper.png'], ['dark', 'reading-dark.png']]) {
    await page.evaluate(theme => {
      const input = document.querySelector('#uiTheme');
      input.value = theme;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.__viewer.fitWidth();
      window.__viewer.goToPage(theme === 'dark' ? 1 : 3);
    }, theme);
    await page.waitForFunction(() => !window.__viewer.renderTasks.size && window.__viewer.rendered.get(window.__viewer.current)?.textDiv?.childElementCount > 0);
    await wait(600);
    await page.evaluate(theme => {
      window.__viewer.goToPage(theme === 'dark' ? 1 : 3);
      const area = document.querySelector('#aiArea');
      area.scrollTop = 0;
      for (const ancestor of [area.parentElement, area.parentElement.parentElement]) ancestor.scrollTop = 0;
    }, theme);
    assert.ok(await page.$eval('#aiArea', node => node.textContent.includes('跨越左右两侧的箭头')));
    await page.screenshot({ path: path.join(output, file) });
    console.log(`Captured ${file}`);
  }
  assert.deepEqual(errors, [], 'no application errors during capture');
  assert.deepEqual(modelCalls, [], 'showcase sends no model requests');
  console.log('Showcase captured using isolated data; answers are illustrative.');
} finally {
  await browser?.close();
  if (reader) await stopChild(reader);
}
