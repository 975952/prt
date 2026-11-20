import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'tr-order-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'tr-fixture.pdf'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d = '') => { checks.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const p = probe.address().port;
  await new Promise((r) => probe.close(r));
  return p;
}

let browser;
let server;
try {
  const port = await findPort();
  const env = { PORT: String(port), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' };
  server = desktop ? spawnReader(stageExe('translation-alignment').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  const BASE = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) { await wait(100); try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ } }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('服务没起来');
  if (desktop) {
    for (const asset of ['js/translation-alignment.js', 'translation-alignment.css', 'js/app.js']) {
      const embedded = Buffer.from(await (await fetch(BASE + '/' + asset)).arrayBuffer());
      check('嵌入资源匹配当前源码 ' + asset, embedded.equals(fs.readFileSync(path.join(ROOT, 'public', asset))));
    }
  }
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'tr', apiKey: 'tr-key' }),
  });

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.agent.welcome.v1', 'acknowledged'));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${BASE}/?open=${encodeURIComponent('tr-fixture.pdf')}&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await wait(600);

  /* Open the translation sidebar before checking its visible order. */
  await page.evaluate(() => {
    // 必须同时把右栏展开：只 setPanelVisible 的话块虽然"可见"，
    // 但整条右栏还在收起的 body 状态里，元素在屏幕外 → 所有 getBoundingClientRect 都是 0
    document.body.classList.remove('no-right');
    window.__ctx.setPanelVisible('translate', true);
    window.__ctx.applyPanels();
  });
  await wait(500);
  const shown = await page.evaluate(() => ({
    noRight: document.body.classList.contains('no-right'),
    blockW: Math.round(document.querySelector('.ai-block[data-block="translate"]')?.getBoundingClientRect().width || 0),
  }));
  check('（前置）译文块真的显示在屏幕上', !shown.noRight && shown.blockW > 200, JSON.stringify(shown));
  await page.waitForFunction(() => window.__state.viewerDocId === window.__state.doc?.docId);
  await page.evaluate(() => {
    function add(id, page, retry) {
      const entry = window.__ctx.addEntry({ id, block: 'translate', tag: 'translation', page, quote: id, retry });
      window.__ctx.streamTarget(entry.body).done(id);
      window.__ctx.finishEntry(entry, id, { page });
    }
    add('legacy', 2, null);
    add('paste', null, { kind: 'translate-text', text: 'paste' });
    // The right column begins higher on the page but follows the left column.
    for (const [id, run, x, y] of [['right', 15, .55, .18], ['left', 3, .09, .26]]) {
      add(id, 1, { kind: 'translate', text: id, page: 1,
        readingStart: { page: 1, run, offset: 0 }, rectsByPage: { 1: [{ x, y, w: .25, h: .018 }] } });
    }
  });
  const rows = '.ai-block[data-block="translate"] .ai-body > .msg';
  const order = await page.$$eval(rows, nodes => nodes.map(node => node.__sessionRecord.id));
  check('按页和栏内阅读顺序排列，旧条目按页定位，粘贴文本排在后面', order.join(',') === 'left,right,legacy,paste', order.join(','));
  const numbers = await page.$$eval(rows + ' .translation-number', nodes => nodes.map(n => n.textContent).join(','));
  check('编号连续', numbers === '1,2,3,4', numbers);
  await page.waitForSelector('.page[data-page="1"] .translation-pin');
  check('只在有真实选区的位置显示页边标记', await page.$$eval('.translation-pin', nodes => nodes.every(n => ['left', 'right'].includes(n.dataset.translationId)) && nodes.length === 2));
  await page.click('#translationOnly');
  await page.$eval(rows + ' .translation-original summary', n => n.click());
  const open = await page.$$eval(rows + ' .translation-original', nodes => nodes.map(n => n.open).join(','));
  check('仅译文模式下可单独打开一条原文', open === 'true,false,false,false', open);
  await page.click('#translationBoth');
  check('切回对照会展开全部原文', await page.$$eval(rows + ' .translation-original', nodes => nodes.every(n => n.open)));
  const pin = '.page[data-page="1"] .translation-pin[data-translation-id="left"]';
  await page.hover(pin);
  await page.waitForSelector('.translation-source-mark');
  check('悬停页边编号同步高亮译文与对应原文', await page.$eval(rows + '.translation-linked', n => n.__sessionRecord.id === 'left'));
  const source = await page.$eval('.page[data-page="1"]', n => {
    const box = n.getBoundingClientRect();
    return { x: box.left + box.width * .59, y: box.top + box.height * .185 };
  });
  await page.mouse.move(source.x, source.y);
  await page.waitForFunction(() => document.querySelector('.translation-linked')?.__sessionRecord.id === 'right');
  check('直接悬停已翻译的原文也能找到右侧译文', true);
  await page.evaluate(() => { window.__ctx.setPanelVisible('chat', true); window.__ctx.applyPanels(); });
  await page.click(pin);
  await page.waitForFunction(() => document.querySelector('#rightSide').dataset.activePanel === 'translate' && document.activeElement.closest('.msg')?.__sessionRecord?.id === 'left');
  check('点击页边编号可从问答切回对应译文', true);
  await page.evaluate(async () => {
    const viewer = window.__viewer;
    viewer.setScale(viewer.scale * 1.3);
    await viewer.refreshPage(1);
  });
  await page.waitForSelector(pin);
  const ratio = await page.$eval(pin, n => {
    const bounds = n.closest('.page').getBoundingClientRect();
    return (n.getBoundingClientRect().top - bounds.top) / bounds.height;
  });
  check('缩放和重新渲染后编号仍锚定原行', Math.abs(ratio - .26) < .025, String(ratio));
  await page.evaluate(async () => {
    await window.__viewer.goToPage(2);
    [...document.querySelectorAll('.msg')].find(n => n.__sessionRecord?.id === 'left').querySelector('.translation-position').click();
  });
  await page.waitForFunction(() => window.__viewer.current === 1 && !!document.querySelector('.page[data-page="1"] .translation-source-mark'));
  check('点击译文编号返回原页并高亮原段', true);
  await page.evaluate(() => {
    [...document.querySelectorAll('.msg')].find(n => n.__sessionRecord?.id === 'right').querySelector('.translation-delete').click();
  });
  await page.waitForFunction(() => !document.querySelector('.translation-pin[data-translation-id="right"]'));
  check('删除后页边编号和译文编号同步', await page.$$eval(rows + ' .translation-number', nodes => nodes.map(n => n.textContent).join(',') === '1,2,3'));
  const scopedSessions = await page.evaluate(async () => {
    await window.__ctx.saveSessionNow();
    return (await fetch('/api/sessions?doc=' + encodeURIComponent(window.__state.doc.docId))).json();
  });
  check('单篇会话历史不会列出文档级译文存储', scopedSessions.sessions.every(row => row.sid !== '__translate'));

  /* Keep the overflow hint at the bottom of the source-ordered list. */
  const fade = await page.evaluate(() => {
    const block = document.querySelector('.ai-block[data-block="translate"]');
    const cs = getComputedStyle(block, '::after');
    const panelBg = getComputedStyle(document.documentElement).getPropertyValue('--bg-elev').trim();
    return { bottom: cs.bottom, top: cs.top, bg: cs.backgroundImage, panelBg };
  });
  const stops = (fade.bg.match(/rgba?\([^)]*\)/g) || []);
  check('溢出渐隐仍在底边，提示下方还有译文',
    fade.bottom === '0px'
      && stops.length >= 2
      && /rgba\(0, 0, 0, 0\)/.test(stops[0])
      && stops.at(-1) !== stops[0],
    `${fade.bottom} ${stops.join(' → ')}`);

  /* 问答流不受影响：仍是时间顺序 */
  const chat = await page.evaluate(async () => {
    await (await import('/js/sessions.js')).sessionsOpenLatestForOutput();
    window.__ctx.setPanelVisible('chat', true);
    await new Promise(resolve => setTimeout(resolve, 200));
    return getComputedStyle(window.__state.blockMeta.chat.body).flexDirection;
  });
  check('问答流没有跟着反转（仍是最新在下面）', chat === 'column', chat);

  await page.evaluate(() => window.__ctx.saveSessionNow());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
  await page.waitForSelector(pin);
  const restored = await page.evaluate(() => [...window.__state.blockMeta.translate.body.querySelectorAll('.msg')]
    .map(row => row.__sessionRecord.id).join(','));
  check('冷启动恢复原文锚点、已删除状态与编号顺序', restored === 'left,legacy,paste', restored);

  check('整页无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n════════════════════════════════════════');
  const failed = checks.filter((c) => !c.ok);
  console.log(`译文顺序验收：${checks.length} 条断言，失败 ${failed.length} 条`);
  if (failed.length) { failed.forEach((c) => console.log(`  · ${c.n}`)); process.exitCode = 1; } else { console.log('全部通过。'); }
} finally {
  await browser?.close().catch(() => {});
  if (desktop) await stopChild(server); else server?.kill();
}
