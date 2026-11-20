/**
 * B 线 P1：多标签工作区与 Welcome 验收（真浏览器 + 隔离服务，无真实 API）。
 *
 *   node test/tabs.mjs [--desktop] [--cross-folder-only]
 *
 * 覆盖设计 §10.1 的 P1 范围：打开/激活/去重/顺序、关闭与 Welcome、快捷键、拖拽排序、
 * 溢出菜单、10 个上限、刷新恢复、普通/全屏首页往返、跨文件夹标签保留及晚加载保护。
 * --desktop 使用隔离 exe 的真实内嵌资源；全屏调用使用桩，只验证页面状态和布局。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const crossFolderOnly = process.argv.includes('--cross-folder-only');
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'tabs-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
// 2 篇「正常」文档 + 8 篇用于测上限（同一合成 PDF 复制成不同名字 → docId 不同）
const MAIN = ['paper-a.pdf', 'paper-b.pdf'];
for (const name of MAIN) fs.copyFileSync(path.join(FIXTURES, 'multipage-sample.pdf'), path.join(PAPERS, name));
for (let i = 1; i <= 8; i += 1) fs.copyFileSync(path.join(FIXTURES, 'cn-sample.pdf'), path.join(PAPERS, `extra-${i}.pdf`));
// 子文件夹里放一篇未打开文档，用来验溢出菜单的「当前文件夹」分组
fs.mkdirSync(path.join(PAPERS, 'sub'), { recursive: true });
fs.copyFileSync(path.join(FIXTURES, 'cn-sample.pdf'), path.join(PAPERS, 'sub', 'in-folder.pdf'));
fs.mkdirSync(path.join(PAPERS, 'other'), { recursive: true });
fs.copyFileSync(path.join(FIXTURES, 'multipage-sample.pdf'), path.join(PAPERS, 'other', 'third-folder.pdf'));
fs.copyFileSync(path.join(FIXTURES, 'multipage-sample.pdf'), path.join(PAPERS, 'slow-paper.pdf'));

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const watchdog = setTimeout(() => { console.error('测试超时（240s），强制退出'); process.exit(3); }, 240000);
watchdog.unref?.();

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

let reader = null;
let browser = null;
try {
  const readerPort = await findPort();
  const env = { PORT: String(readerPort), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
    NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('tabs').exe, { args: ['--port', String(readerPort)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(readerPort), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
      NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    },
    stdio: 'ignore', windowsHide: true,
  });
  const BASE = `http://127.0.0.1:${readerPort}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ }
  }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('isolated server failed to start');
  for (const asset of ['style.css', 'js/app.js', 'js/tabs.js']) {
    const actual = await fetch(`${BASE}/${asset}`).then(response => response.text());
    check(`${desktop ? 'exe 内嵌' : '源码服务'} ${asset} 与当前文件一致`, actual === fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    localStorage.setItem('reader.session.onEnter', 'resume');
    // The existing hot-switch assertions explicitly exercise one shared chat.
    localStorage.setItem('reader.session.scopeMode', 'global');
    Element.prototype.requestFullscreen = () => Promise.resolve();
    document.exitFullscreen = () => Promise.resolve();
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/state' && init.method === 'POST') {
        const payload = JSON.parse(init.body || '{}');
        window.__progressRequests ||= []; window.__progressCompleted ||= [];
        __progressRequests.push(payload);
        if (window.__holdNextProgress) {
          window.__holdNextProgress = false;
          await new Promise(resolve => { window.__progressGate = { payload, release: resolve }; });
        }
        const response = await originalFetch(input, init); __progressCompleted.push(payload); return response;
      }
      if (url.pathname === '/api/config' && (!init.method || init.method === 'GET')) {
        const data = await originalFetch(input, init).then(response => response.json());
        return new Response(JSON.stringify({ ...data, hasApiKey: true, model: 'synthetic', autoTranslate: false }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/api/chat') {
        const body = JSON.parse(init.body || '{}');
        if (/后台学习记忆提取器|滚动摘要|会话标题|起标题/.test(String(body.messages?.[0]?.content || ''))
          || !JSON.stringify(body.messages || []).includes('HOME_RUNNING_TASK')) return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), { headers: { 'Content-Type': 'application/json' } });
        window.__homeModel = { aborted: false, body };
        const stream = new ReadableStream({ start(controller) { __homeModel.controller = controller; }, cancel() { __homeModel.aborted = true; } });
        init.signal?.addEventListener('abort', () => { __homeModel.aborted = true; try { __homeModel.controller.error(new DOMException('Stopped', 'AbortError')); } catch {} }, { once: true });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    };
  });

  const settle = async () => {
    await page.waitForFunction(() => window.__state?.viewerDocId === window.__state?.doc?.docId
      || (!window.__state?.doc && !document.body.classList.contains('reading')), { timeout: 40000 });
    await wait(500);
  };
  const openFirst = async () => {
    await page.goto(`${BASE}/?open=paper-a.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 60000 });
    await settle();
  };
  const tabs = () => page.evaluate(() => window.__ctx.tabs);
  const tabDom = () => page.evaluate(() => [...document.querySelectorAll('#tabStrip .doc-tab')].map((n) => ({
    doc: n.dataset.doc, title: n.querySelector('.tab-title')?.textContent || '', active: n.classList.contains('active'),
  })));
  const papers = [];
  {
    const listing = await fetch(`${BASE}/api/papers`).then((r) => r.json());
    for (const row of listing.papers || []) papers.push(row);
  }
  const paperByName = (name) => papers.find((p) => p.name === name);
  const openByDom = async (name) => {
    const p = paperByName(name);
    if (!p) throw new Error(`隔离书架里没有 ${name}`);
    await page.evaluate((doc) => window.__ctx.openDoc(doc), { name: p.name, url: p.url, docId: p.docId, path: p.path || p.name });
    await settle();
  };

  if (!crossFolderOnly) {
  /* ── 1. 打开第一篇：标签条和首页按钮可见 ── */
  await openFirst();
  let st = await tabs();
  check('打开一篇 → 1 个标签', st.length === 1 && st[0].name === 'paper-a.pdf', JSON.stringify(st));
  check('该标签是活动标签', (await page.evaluate(() => window.__ctx.activeTab)) === st[0].docId);
  check('标签条可见', await page.evaluate(() => !document.getElementById('tabBar').classList.contains('hidden')
    && !!document.querySelector('#tabStrip .doc-tab.active')));
  check('有标签时顶栏首页按钮保持可见可点', await page.evaluate(() => {
    const btn = document.getElementById('homeBtn');
    if (!btn) return false;
    const r = btn.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width > 0 && r.height > 0 && !btn.disabled && (hit === btn || btn.contains(hit));
  }));

  /* ── 2. 打开第二篇：2 个标签、第二个活动、顺序=打开顺序 ── */
  await openByDom('paper-b.pdf');
  let dom = await tabDom();
  check('打开第二篇 → 2 个标签', dom.length === 2, JSON.stringify(dom.map((t) => t.title)));
  check('顺序 = 打开顺序', dom[0].title === 'paper-a.pdf' && dom[1].title === 'paper-b.pdf', JSON.stringify(dom.map((t) => t.title)));
  check('后打开的标签激活', dom[1].active && !dom[0].active);
  check('活动标签与 state.doc 一致', await page.evaluate(() => window.__ctx.activeTab === window.__state.doc.docId));

  /* ── 3. 再点已打开文档：不新增标签、只激活（冷切换） ── */
  await openByDom('paper-a.pdf');
  dom = await tabDom();
  check('重复打开不新增标签', dom.length === 2, String(dom.length));
  check('重复打开会激活已有标签', dom[0].active && !dom[1].active);
  check('冷切换后正文是 paper-a', await page.evaluate(() => window.__state.doc.name === 'paper-a.pdf'));

  /* ── 3b. 首页是独立视图，普通和全屏都能回原标签或其他标签 ── */
  for (const fullscreen of [false, true]) {
    if (fullscreen) { await page.keyboard.press('F11'); await wait(300); }
    await page.evaluate(() => __viewer.goToPage(5)); await wait(350);
    const before = await page.evaluate(() => ({ tabs: __ctx.tabs.map(tab => tab.docId), id: __state.doc.docId,
      page: __viewer.current, top: __viewer.container.scrollTop }));
    await page.click('#homeBtn'); await page.waitForFunction(() => !document.body.classList.contains('reading'));
    check(`${fullscreen ? '全屏' : '普通'}首页保留标签并清除文档活动态`, await page.evaluate(ids => __ctx.tabs.map(tab => tab.docId).join() === ids.join()
      && document.querySelectorAll('#tabStrip .doc-tab.active').length === 0 && document.querySelector('#homeBtn').getAttribute('aria-current') === 'page'
      && getComputedStyle(document.querySelector('#tabBar')).display !== 'none', before.tabs));
    await page.click(`#tabStrip .doc-tab[data-doc="${before.id}"] .tab-title`); await settle();
    check(`${fullscreen ? '全屏' : '普通'}首页点击同一标签恢复原阅读位置`, await page.evaluate(old => document.body.classList.contains('reading')
      && __state.doc.docId === old.id && __viewer.current === old.page && Math.abs(__viewer.container.scrollTop - old.top) <= 3
      && document.querySelector('#homeBtn').getAttribute('aria-current') !== 'page', before));
    await page.click('#homeBtn'); await page.waitForFunction(() => !document.body.classList.contains('reading'));
    const other = before.tabs.find(id => id !== before.id);
    await page.click(`#tabStrip .doc-tab[data-doc="${other}"] .tab-title`); await settle();
    check(`${fullscreen ? '全屏' : '普通'}首页点击另一标签恢复其文档`, await page.evaluate(id => document.body.classList.contains('reading') && __state.viewerDocId === id, other));
    await page.click(`#tabStrip .doc-tab[data-doc="${before.id}"] .tab-title`); await settle();
    await page.screenshot({ path: path.join(scratch, fullscreen ? 'tabs-fullscreen.png' : 'tabs-normal.png') });
    if (fullscreen) { await page.keyboard.press('Escape'); await wait(300); }
  }

  /* 首页保留可达的键盘入口，Enter 和 Space 都能恢复文档。 */
  for (const key of ['Enter', 'Space']) {
    await page.click('#homeBtn'); await page.waitForFunction(() => !document.body.classList.contains('reading'));
    const entry = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('#tabStrip .doc-tab')];
      return { id: tabs[0]?.dataset.doc, reachable: tabs.filter(tab => tab.tabIndex === 0).length,
        firstReachable: tabs[0]?.tabIndex === 0 };
    });
    if (key === 'Enter') check('首页首个标签保留唯一键盘入口', entry.firstReachable && entry.reachable === 1, JSON.stringify(entry));
    await page.focus('#tabStrip .doc-tab');
    await page.keyboard.press(key); await settle();
    check(`首页 ${key} 激活键盘聚焦标签`, await page.evaluate(id => document.body.classList.contains('reading')
      && __state.viewerDocId === id && document.querySelector('#tabStrip .doc-tab.active')?.dataset.doc === id, entry.id));
  }

  /* ── 4. 键盘切换：Ctrl+Tab / Ctrl+PageDown / Ctrl+1 ── */
  await page.keyboard.down('Control');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Control');
  await settle();
  check('Ctrl+Tab 切到下一个标签', await page.evaluate(() => window.__state.doc.name === 'paper-b.pdf'));
  await page.keyboard.down('Control');
  await page.keyboard.press('PageDown');
  await page.keyboard.up('Control');
  await settle();
  check('Ctrl+PageDown 继续切', await page.evaluate(() => window.__state.doc.name === 'paper-a.pdf'));
  await page.keyboard.down('Control');
  await page.keyboard.press('2');
  await page.keyboard.up('Control');
  await settle();
  check('Ctrl+2 直达第二个标签', await page.evaluate(() => window.__state.doc.name === 'paper-b.pdf'));

  /* ── 5. 拖拽排序：把第一个拖到第二个后面 ── */
  {
    const rects = await page.evaluate(() => [...document.querySelectorAll('#tabStrip .doc-tab')].map((n) => {
      const r = n.getBoundingClientRect();
      return { doc: n.dataset.doc, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }));
    await page.mouse.move(rects[0].x, rects[0].y);
    await page.mouse.down();
    await page.mouse.move(rects[1].x + 30, rects[1].y, { steps: 8 });
    await page.mouse.up();
    await wait(300);
    dom = await tabDom();
    check('拖拽后顺序变化', dom.length === 2 && dom[0].title === 'paper-b.pdf' && dom[1].title === 'paper-a.pdf',
      JSON.stringify(dom.map((t) => t.title)));
    check('拖拽顺序已写入工作区', await page.evaluate(() => {
      const ws = JSON.parse(localStorage.getItem('reader.workspace.v1') || '{}');
      return Array.isArray(ws.tabs) && ws.tabs[0]?.name === 'paper-b.pdf';
    }));
  }

  /* ── 6. 中键关闭 / Ctrl+W 关闭 / Ctrl+Shift+T 重开 ── */
  {
    const before = (await tabs()).length;
    await page.evaluate(() => {
      const el = document.querySelector('#tabStrip .doc-tab');
      el.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });
    await settle();
    check('中键关闭一个标签', (await tabs()).length === before - 1, `${before} → ${(await tabs()).length}`);
    const remain = await tabs();
    await page.keyboard.down('Control');
    await page.keyboard.press('w');
    await page.keyboard.up('Control');
    await settle();
    check('Ctrl+W 关闭当前标签', (await tabs()).length === remain.length - 1, `${remain.length} → ${(await tabs()).length}`);
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('T');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await settle();
    check('Ctrl+Shift+T 重开最近关闭的标签', (await tabs()).length === remain.length, String((await tabs()).length));
  }

  /* ── 7. 关掉全部 → Welcome ── */
  {
    for (const t of await tabs()) {
      await page.evaluate((docId) => window.__ctx.closeTab(docId), t.docId);
      await wait(400);
    }
    await wait(500);
    const welcome = await page.evaluate(() => ({
      tabs: window.__ctx.tabs.length,
      reading: document.body.classList.contains('reading'),
      homeVisible: !document.getElementById('home')?.classList.contains('hidden'),
      tabBarHidden: document.getElementById('tabBar')?.classList.contains('hidden'),
      docName: document.getElementById('docName')?.textContent || '',
      footDisabled: !!document.getElementById('pageInput')?.disabled,
    }));
    check('关掉全部标签 → 0 个标签', welcome.tabs === 0);
    check('Welcome：退出阅读态、书架页可见', !welcome.reading && welcome.homeVisible, JSON.stringify(welcome));
    check('Welcome：标签条隐藏、文档名复位', welcome.tabBarHidden && /未打开文档|书架/.test(welcome.docName));
    check('Welcome：底栏禁用', welcome.footDisabled);
    await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__ctx?.tabs !== 'undefined', { timeout: 40000 });
    await wait(800);
    check('空工作区刷新后仍是 Welcome（不按 lastDoc 自动打开）', await page.evaluate(() =>
      window.__ctx.tabs.length === 0 && !document.body.classList.contains('reading')
      && !document.getElementById('home').classList.contains('hidden')));
  }

  /* ── 8. 溢出菜单：全部标签 + 当前文件夹文档 ── */
  {
    await openByDom('paper-a.pdf');
    await openByDom('sub/in-folder.pdf').catch(() => { /* 名字可能带路径，下面用 docId 兜底 */ });
    const opened = await tabs();
    if (opened.length < 2) await openByDom('paper-b.pdf');
    await page.click('#tabMoreBtn');
    await wait(300);
    const menu = await page.evaluate(() => ({
      visible: !document.getElementById('tabMenu')?.classList.contains('hidden'),
      items: [...document.querySelectorAll('#tabMenu .tab-menu-item')].map((n) => n.textContent),
      titles: [...document.querySelectorAll('#tabMenu .tab-menu-title')].map((n) => n.textContent),
    }));
    check('溢出菜单能打开', menu.visible);
    check('菜单列出全部标签', menu.items.some((t) => t.includes('paper-a.pdf')), JSON.stringify(menu.items.slice(0, 6)));
    check('菜单含「当前文件夹」或「书架」分组', menu.titles.some((t) => /当前文件夹|书架/.test(t)), JSON.stringify(menu.titles));
    await page.click('#homeBtn');
    await page.waitForFunction(() => !document.body.classList.contains('reading'));
    check('返回首页同时关闭标签溢出菜单', await page.evaluate(() => document.querySelector('#tabMenu').classList.contains('hidden')));
  }

  /* ── 9. 上限 10 个 ── */
  {
    const names = ['paper-a.pdf', 'paper-b.pdf', ...Array.from({ length: 8 }, (_, i) => `extra-${i + 1}.pdf`)];
    for (const name of names) {
      const already = (await tabs()).some((t) => t.name === name);
      if (!already) await openByDom(name).catch(() => {});
    }
    check('最多 10 个标签', (await tabs()).length === 10, String((await tabs()).length));
    // 找一篇还没打开的文档：第 11 个必须被拒绝
    const openIds = new Set((await tabs()).map((t) => t.docId));
    const unopened = papers.find((row) => !openIds.has(row.docId));
    check('还有未打开的文档可试第 11 个', !!unopened, JSON.stringify(papers.map((p) => p.name)));
    if (unopened) {
      await page.evaluate((doc) => window.__ctx.openDoc(doc), { name: unopened.name, url: unopened.url, docId: unopened.docId, path: unopened.path || unopened.name });
      await wait(600);
    }
    const after = await tabs();
    check('第 11 个被拒绝且仍是 10 个', after.length === 10, String(after.length));
    check('第 11 个被拒时有提示', await page.evaluate(() => [...document.querySelectorAll('.toast')].some((n) => /最多同时打开/.test(n.textContent))));
  }

  /* ── 10. 刷新恢复工作区 + 全屏保留标签 ── */
  {
    const before = await tabs();
    const activeBefore = await page.evaluate(() => window.__ctx.activeTab);
    await page.evaluate(() => localStorage.setItem('reader.startupPage', 'resume'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ctx?.tabs?.length > 0 && window.__viewer?.numPages > 0, { timeout: 60000 });
    await settle();
    const after = await tabs();
    check('刷新后恢复标签列表', after.length === before.length, `${before.length} → ${after.length}`);
    check('刷新后恢复活动标签', (await page.evaluate(() => window.__ctx.activeTab)) === activeBefore);
    check('刷新后标签条可见', await page.evaluate(() => !document.getElementById('tabBar').classList.contains('hidden')));
    const fsDisplay = await page.evaluate(() => {
      document.body.classList.add('window-fullscreen');
      const d = getComputedStyle(document.getElementById('tabBar')).display;
      document.body.classList.remove('window-fullscreen');
      return d;
    });
    check('全屏时标签条仍然可见', fsDisplay !== 'none', fsDisplay);
  }

  /* ── 11. 热切换（B 线 P2）：切回旧标签不重新下载/解析 PDF，页码/滚动保留，p95 < 350ms ── */
  {
    // 清到只剩 2 个标签（热切换只需两篇来回）
    for (const t of (await tabs()).slice(2)) {
      await page.evaluate((docId) => window.__ctx.closeTab(docId), t.docId);
      await wait(250);
    }
    const remain = await tabs();
    if (remain.length < 2) {
      await page.evaluate(() => window.__ctx.goWelcome());
      await wait(300);
      await openByDom('paper-a.pdf');
      await openByDom('paper-b.pdf');
    }
    await settle();
    const activeFirst = await page.evaluate(() => window.__state.doc.name);
    const firstId = (await tabs()).find((t) => t.name === activeFirst)?.docId;
    // 在第一篇里造两条已渲染的回答并打标记：热切回时必须复用同一批 DOM（不重放渲染）
    await page.evaluate(() => {
      window.__ctx.setPanelVisible('chat', true);
      for (let i = 0; i < 2; i += 1) {
        const entry = window.__ctx.addEntry({ block: 'chat', kind: 'assistant', text: `热切换前的第 ${i + 1} 条回答` });
        window.__ctx.finishEntry(entry, `热切换前的第 ${i + 1} 条回答`, { page: 1 });
      }
      document.querySelectorAll('#aiArea .msg').forEach((node) => { node.__hotMark = 1; });
    });
    // 在第一篇里翻到第 5 页（记录页码/滚动，切回来要「看起来没动过」）
    await page.evaluate(async () => { await window.__viewer.goToPage(5); });
    await wait(400);
    const before = await page.evaluate(() => ({ page: window.__viewer.current, top: document.getElementById('viewer').scrollTop }));
    const pdfRequests = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/pdf')).length);
    const sessionRequests = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/session')).length);
    const attachBefore = await page.evaluate(() => window.__ctx.pdfHotAttaches);
    // 先切到另一篇（冷加载会正常下载一次 PDF / 读一次会话），冷加载完成后再取基准
    const otherId = (await tabs()).find((t) => t.docId !== firstId)?.docId;
    await page.evaluate((docId) => window.__ctx.activateTab(docId), otherId);
    await settle();
    // 切回命中句柄 → 热切换：页面内计时 + 期间是否新增 PDF/会话请求（只统计这次切换本身）
    const hot = await page.evaluate(async (docId) => {
      window.__hotTrace = true;
      const pdfCount = () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/pdf')).length;
      const sessionCount = () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/session')).length;
      const pdf0 = pdfCount();
      const sess0 = sessionCount();
      const t = performance.now();
      await window.__ctx.activateTab(docId);
      const ms = Math.round(performance.now() - t);
      return { ms, pdfDelta: pdfCount() - pdf0, sessionDelta: sessionCount() - sess0 };
    }, firstId);
    await settle();
    const switchMs = hot.ms;
    const after = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#aiArea .msg')];
      return {
        page: window.__viewer.current,
        top: document.getElementById('viewer').scrollTop,
        doc: window.__state.doc.name,
        attaches: window.__ctx.pdfHotAttaches,
        handles: window.__ctx.pdfHandleCount,
        hotTrace: window.__lastHotTrace || null,
        msgCount: nodes.length,
        marks: nodes.filter((node) => node.__hotMark === 1).length,
      };
    });
    check('切回旧标签走热切换（attach 命中）', after.attaches > attachBefore, `attaches=${attachBefore}→${after.attaches}`);
    check('热切换后页码保留', after.page === before.page, `${before.page} → ${after.page}`);
    check('热切换后滚动位置保留（±3px）', Math.abs(after.top - before.top) <= 3, `${before.top} → ${after.top}`);
    check('热切换后回到正确文档', after.doc === activeFirst, after.doc);
    check('热切换不再重复下载 PDF', hot.pdfDelta === 0, `本次切换新增 ${hot.pdfDelta} 次 /api/pdf`);
    check('热切换复用已渲染的消息 DOM（不重放渲染）', after.msgCount === 2 && after.marks === 2, `msg=${after.msgCount} marks=${after.marks}`);
    check('热切换不再重新读取会话', hot.sessionDelta === 0, `本次切换新增 ${hot.sessionDelta} 次 /api/session`);
    check('热切换打点显示走恢复路径（attach + restoreView，没有 session/outline 重放）',
      !!after.hotTrace && after.hotTrace.hot === true && typeof after.hotTrace.restoreView === 'number'
      && typeof after.hotTrace.session === 'undefined' && typeof after.hotTrace.outline === 'undefined',
      JSON.stringify(after.hotTrace));
    check('单次热切换 < 350ms（页面内计时）', switchMs < 350, `${switchMs}ms；${JSON.stringify(after.hotTrace)}`);

    // p95：来回切 8 次，页面内计时取 95 分位
    const times = [];
    for (let i = 0; i < 8; i += 1) {
      const target = i % 2 === 0 ? otherId : firstId;
      const ms = await page.evaluate(async (docId) => {
        const t = performance.now();
        await window.__ctx.activateTab(docId);
        return Math.round(performance.now() - t);
      }, target);
      times.push(ms);
    }
    await settle();
    times.sort((a, b) => a - b);
    const p95 = times[Math.max(0, Math.ceil(times.length * 0.95) - 1)];
    check('热切换 p95 < 350ms', p95 < 350, `p95=${p95}ms（全部：${times.join(',')}）`);

    // 用户口径：每次切换论文都不应该重绘右侧问答栏（全局会话共用，聊天 DOM 应原样保留、节点身份不变）
    const chatRedraw = await page.evaluate(async () => {
      const chatBody = () => document.querySelector('[data-block="chat"] .ai-body');
      const first = window.__ctx.activeTab;
      const other = window.__ctx.tabs.map((t) => t.docId).find((id) => id !== first);
      const beforeNodes = [...chatBody().querySelectorAll('.msg')];
      beforeNodes.forEach((n, i) => { n.__noRedraw = i + 1; });
      const sizeBefore = beforeNodes.length;
      await window.__ctx.activateTab(other);
      await new Promise((r) => setTimeout(r, 250));
      await window.__ctx.activateTab(first);
      await new Promise((r) => setTimeout(r, 250));
      const afterNodes = [...chatBody().querySelectorAll('.msg')];
      return {
        sizeBefore,
        sizeAfter: afterNodes.length,
        sameNodes: afterNodes.length === beforeNodes.length && afterNodes.every((n, i) => n === beforeNodes[i]),
        marks: afterNodes.filter((n) => n.__noRedraw).length,
      };
    });
    check('切换论文不重绘右侧问答栏（DOM 节点原样保留）',
      chatRedraw.sameNodes && chatRedraw.marks === chatRedraw.sizeBefore && chatRedraw.sizeAfter === chatRedraw.sizeBefore,
      JSON.stringify(chatRedraw));
    // 流式输出不再有闪烁光标
    check('右侧问答栏没有闪烁光标节点', await page.evaluate(() => document.querySelectorAll('.cursor').length === 0));
  }

  /* ── 12. 首页只是隐藏会话，生成继续；返回保留原消息节点 ── */
  await page.evaluate(async () => { await __ctx.newSession({ silent: true }); __ctx.setAgentRead(false); __ctx.setScopeRange('current');
    __ctx.setPanelVisible('chat', true); const input = document.querySelector('#chatInput'); input.value = 'HOME_RUNNING_TASK';
    input.dispatchEvent(new Event('input', { bubbles: true })); window.__homeSend = __ctx.send(); });
  await page.waitForFunction(() => window.__homeModel?.controller);
  const liveDoc = await page.evaluate(() => {
    const entry = __state.sessionEntries.find(e => e.status === 'pending' && e.retry?.question === 'HOME_RUNNING_TASK');
    window.__homeAnswerNode = [...document.querySelectorAll('.msg.assistant')].find(node => node.__sessionRecord === entry);
    if (!__homeAnswerNode) throw Error('Pending home answer node not found'); return __state.doc.docId;
  });
  await page.click('#homeBtn'); await page.waitForFunction(() => !document.body.classList.contains('reading'));
  check('首页期间原会话的生成请求未取消', await page.evaluate(() => !__homeModel.aborted));
  await page.evaluate(() => { __homeModel.controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"HOME_RUNNING_TASK completed while at home."}}]}\n\ndata: [DONE]\n\n')); __homeModel.controller.close(); });
  await page.evaluate(() => window.__homeSend);
  check('后台回答完成不会把首页强制切回阅读', await page.evaluate(() => !document.body.classList.contains('reading') && !__homeModel.aborted));
  await page.click(`#tabStrip .doc-tab[data-doc="${liveDoc}"] .tab-title`); await settle();
  const liveResult = await page.evaluate(() => ({ connected: __homeAnswerNode.isConnected, status: __homeAnswerNode.__sessionRecord?.status,
    text: __homeAnswerNode.textContent, record: __homeAnswerNode.__sessionRecord?.text, aborted: __homeModel.aborted }));
  check('回原标签显示已完成回答并复用原节点', liveResult.connected && liveResult.status === 'complete' && liveResult.text.includes('completed while at home.'), JSON.stringify(liveResult));

  /* ── 12b. 旧进度保存延迟跨越 A→首页→B→首页，不能回滚新进度 ── */
  await openByDom('paper-a.pdf'); await wait(700);
  await page.evaluate(() => { window.__progressGate = null; window.__holdNextProgress = true; __viewer.goToPage(4); });
  await wait(100); await page.click('#homeBtn');
  await page.waitForFunction(() => !!window.__progressGate);
  const progressStart = await page.evaluate(() => ({ count: __progressRequests.length, completed: __progressCompleted.length }));
  await page.click(`#tabStrip .doc-tab[data-doc="${paperByName('paper-b.pdf').docId}"] .tab-title`); await settle();
  await page.evaluate(() => __viewer.goToPage(2)); await wait(100); await page.click('#homeBtn');
  await page.waitForFunction(() => !document.body.classList.contains('reading'));
  check('旧保存等待期间新进度保持排队', await page.evaluate(start => __progressRequests.length === start.count, progressStart));
  await page.evaluate(() => __progressGate.release());
  const aId = paperByName('paper-a.pdf').docId, bId = paperByName('paper-b.pdf').docId;
  await page.waitForFunction(({ aId, bId }) => __progressCompleted.some(payload => payload.docs?.[aId]?.page === 4
    && payload.docs?.[bId]?.page === 2 && payload.lastDoc === bId), {}, { aId, bId });
  const progress = await fetch(`${BASE}/api/state`).then(response => response.json());
  check('延迟旧保存释放后A和B阅读页码都保留', progress.docs?.[aId]?.page === 4 && progress.docs?.[bId]?.page === 2 && progress.lastDoc === bId,
    JSON.stringify({ a: progress.docs?.[aId], b: progress.docs?.[bId], last: progress.lastDoc }));
  check('进度保存完成不改变首页视图', await page.evaluate(() => !document.body.classList.contains('reading')));

  /* ── 13. PDF 下载晚于首页导航，旧加载不得把首页拉回去 ── */
  let heldPdf = null, holdSlow = true;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (holdSlow && !heldPdf && decodeURIComponent(request.url()).includes('slow-paper.pdf') && request.url().includes('/api/pdf')) { heldPdf = request; return; }
    void request.continue();
  });
  await page.evaluate(doc => { window.__lateOpen = __ctx.openDoc(doc); }, paperByName('slow-paper.pdf'));
  for (let i = 0; i < 100 && !heldPdf; i++) await wait(50);
  check('晚加载测试确实截住目标PDF请求', !!heldPdf);
  if (!heldPdf) throw new Error('late PDF request did not reach the gate');
  await page.click('#homeBtn'); await page.waitForFunction(() => !document.body.classList.contains('reading'));
  holdSlow = false; await heldPdf.continue(); await page.evaluate(() => window.__lateOpen); await wait(350);
  check('首页期间迟到的PDF加载不改变可见视图或活动态', await page.evaluate(() => !document.body.classList.contains('reading')
    && document.querySelectorAll('#tabStrip .doc-tab.active').length === 0 && document.querySelector('#homeBtn').getAttribute('aria-current') === 'page'));
  await page.screenshot({ path: path.join(scratch, 'home-after-late-load.png') });
  }

  /* ── 14. 标签属于工作区，跨文件夹只切文档，不隐式关闭其他标签 ── */
  const crossFolderMatrix = async () => {
    await page.goto(`${BASE}/?open=paper-a.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(id => window.__state?.viewerDocId === id && window.__ctx?.activeTab === id,
      { timeout: 60000 }, paperByName('paper-a.pdf').docId);
    // The explicit startup target only makes fixture setup deterministic; refresh must test the saved active tab.
    await page.evaluate(() => {
      localStorage.setItem('reader.startupPage', 'resume');
      history.replaceState(null, '', '/?topbar=static');
    });
    await settle();
    for (const tab of await tabs()) {
      await page.evaluate(docId => __ctx.closeTab(docId), tab.docId);
      if ((await tabs()).length) await settle();
      else await page.waitForFunction(() => !document.body.classList.contains('reading'));
    }
    const docs = ['paper-a.pdf', 'sub/in-folder.pdf', 'other/third-folder.pdf'].map(file => {
      const doc = papers.find(row => (row.path || row.name) === file);
      if (!doc) throw new Error(`缺少跨文件夹夹具 ${file}`);
      return doc;
    });
    const ids = docs.map(doc => doc.docId);
    const workspace = () => page.evaluate(() => ({
      ids: __ctx.tabs.map(tab => tab.docId), domIds: [...document.querySelectorAll('#tabStrip .doc-tab')].map(tab => tab.dataset.doc),
      active: __ctx.activeTab, activeDom: [...document.querySelectorAll('#tabStrip .doc-tab.active')].map(tab => tab.dataset.doc),
      doc: __state.doc?.docId, viewer: __state.viewerDocId, reading: document.body.classList.contains('reading'),
      stored: JSON.parse(localStorage.getItem('reader.workspace.v1') || '{}').tabs?.map(tab => tab.docId),
    }));
    const keeps = (value, expected) => JSON.stringify(value.ids) === JSON.stringify(expected)
      && JSON.stringify(value.domIds) === JSON.stringify(expected) && JSON.stringify(value.stored) === JSON.stringify(expected);
    const current = (value, id) => value.reading && value.doc === id && value.viewer === id && value.active === id
      && value.activeDom.length === 1 && value.activeDom[0] === id;
    for (let index = 0; index < docs.length; index++) {
      await page.evaluate(doc => __ctx.openDoc(doc), docs[index]); await settle();
      const actual = await workspace();
      check(`跨文件夹依次打开第 ${index + 1} 篇保留此前全部标签及顺序`, keeps(actual, ids.slice(0, index + 1)) && current(actual, ids[index]), JSON.stringify(actual));
    }
    if (!keeps(await workspace(), ids)) {
      await page.screenshot({ path: path.join(scratch, 'cross-folder-tabs-lost.png') });
      return;
    }
    for (const fullscreen of [false, true]) {
      if (fullscreen) { await page.keyboard.press('F11'); await wait(250); }
      const mode = fullscreen ? '全屏' : '普通';
      for (let index = 0; index < docs.length; index++) {
        await page.click(`#tabStrip .doc-tab[data-doc="${ids[index]}"] .tab-title`); await settle();
        const actual = await workspace();
        check(`${mode}跨文件夹点击${['首个', '中间', '最后'][index]}标签只切当前文档`, keeps(actual, ids) && current(actual, ids[index]), JSON.stringify(actual));
      }
      for (let index = 0; index < docs.length; index++) {
        await page.click('#homeBtn'); await page.waitForFunction(() => !document.body.classList.contains('reading'));
        const home = await workspace();
        if (index === 0) check(`${mode}跨文件夹回首页保留三个标签原顺序`, keeps(home, ids) && home.activeDom.length === 0, JSON.stringify(home));
        await page.click(`#tabStrip .doc-tab[data-doc="${ids[index]}"] .tab-title`); await settle();
        const actual = await workspace();
        check(`${mode}首页切回${['首个', '中间', '最后'][index]}跨文件夹标签保留整个工作区`, keeps(actual, ids) && current(actual, ids[index]), JSON.stringify(actual));
      }
      const readingContext = await page.evaluate(() => ({ doc: __state.doc.docId, folder: __ctx.currentFolder, sid: __ctx.activeSession }));
      await page.click('#homeBtn');
      await page.waitForFunction(() => !document.body.classList.contains('reading'));
      await page.click('#homeFolders [data-home-folder="sub"]');
      const filtered = await page.evaluate(() => ({
        selected: document.querySelector('#homeFolders [data-home-folder][aria-pressed="true"]')?.dataset.homeFolder,
        files: [...document.querySelectorAll('#homeList .home-item')].map(item => item.dataset.id),
        menuHidden: document.querySelector('#folderSwitchMenu').classList.contains('hidden'),
        doc: __state.doc?.docId, folder: __ctx.currentFolder, sid: __ctx.activeSession,
      }));
      check(`${mode}书架选另一文件夹只筛选首页并保留标签及原阅读会话`, keeps(await workspace(), ids)
        && filtered.selected === 'sub' && JSON.stringify(filtered.files) === JSON.stringify([ids[1]]) && filtered.menuHidden
        && filtered.doc === readingContext.doc && filtered.folder === readingContext.folder && filtered.sid === readingContext.sid, JSON.stringify(filtered));
      await page.screenshot({ path: path.join(scratch, fullscreen ? 'cross-folder-browse-home-fullscreen.png' : 'cross-folder-browse-home.png') });
      await page.click(`#tabStrip .doc-tab[data-doc="${ids[0]}"] .tab-title`); await settle();
      const afterBrowse = await workspace();
      check(`${mode}浏览另一文件夹后点旧标签正常返回且其他标签不丢`, keeps(afterBrowse, ids) && current(afterBrowse, ids[0]), JSON.stringify(afterBrowse));
      await page.click(`#tabStrip .doc-tab[data-doc="${ids[2]}"] .tab-title`); await settle();
      await page.screenshot({ path: path.join(scratch, fullscreen ? 'cross-folder-fullscreen.png' : 'cross-folder-normal.png') });
      if (fullscreen) { await page.keyboard.press('Escape'); await wait(250); }
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(id => __state?.viewerDocId === id && __ctx?.activeTab === id, { timeout: 60000 }, ids[2]);
    await settle();
    const restored = await workspace();
    check('跨文件夹刷新恢复三个标签原顺序及当前文档', keeps(restored, ids) && current(restored, ids[2]), JSON.stringify(restored));
    await page.click(`#tabStrip .doc-tab[data-doc="${ids[1]}"] .tab-close`); await settle();
    const closed = await workspace();
    check('关闭中间非活动标签只删除这一项', keeps(closed, [ids[0], ids[2]]) && current(closed, ids[2]), JSON.stringify(closed));
    await page.click(`#tabStrip .doc-tab[data-doc="${ids[2]}"] .tab-close`);
    await page.waitForFunction(id => __state.viewerDocId === id && __ctx.tabs.length === 1
      && JSON.parse(localStorage.getItem('reader.workspace.v1')).tabs.length === 1, {}, ids[0]);
    await settle();
    const closedActive = await workspace();
    check('关闭活动标签只删除这一项并激活保留的跨文件夹标签', keeps(closedActive, [ids[0]]) && current(closedActive, ids[0]), JSON.stringify(closedActive));
    await page.screenshot({ path: path.join(scratch, 'cross-folder-close-only-target.png') });
  };
  await crossFolderMatrix();

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n多标签 P1：${checks.length - failed.length}/${checks.length} 通过`);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktop ? 'desktop-assets' : 'source', subset: crossFolderOnly ? 'cross-folder' : 'full', fullscreenApi: 'stub', checks, pageErrors }, null, 2), 'utf8');
  console.log(`证据：${scratch}`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  await stopChild(reader);
}
