/**
 * 应用全屏验收（2026-11）：
 *  - 顶栏有全屏按钮，点击进入全屏；
 *  - 全屏只改窗口（铺满屏幕），应用内顶栏/底栏保持原样（用户口径：不要隐藏顶栏）；
 *  - 底部不留白条（底栏贴住窗口底边）；
 *  - F11 也能切换全屏；按 Esc 退出全屏。
 *
 * 浏览器里用 Fullscreen API；测试环境里把 requestFullscreen/exitFullscreen 换成桩，
 * 验证页面自己的全屏状态与布局（真实窗口全屏由桌面壳 tao 负责，cargo test 覆盖 IPC 解析）。
 *
 *   node test/fullscreen.mjs [--desktop]
 * --desktop 校验并使用隔离 exe 内嵌资源；Fullscreen API 仍使用桩，不能替代原生窗口视觉验收。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'fullscreen-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fullscreen-paper.pdf'));
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'other-paper.pdf'));

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const watchdog = setTimeout(() => { console.error('测试超时（180s），强制退出'); process.exit(3); }, 180000);
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
  reader = desktop ? spawnReader(stageExe('fullscreen').exe, { args: ['--port', String(readerPort)], env })
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
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // 桩：headless shell 里的真实 Fullscreen API 不可靠，只验证页面自己的状态与布局切换
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    localStorage.setItem('reader.session.onEnter', 'resume');
    window.__fsStub = { requested: 0, exited: 0 };
    Element.prototype.requestFullscreen = function () { window.__fsStub.requested += 1; return Promise.resolve(); };
    document.exitFullscreen = function () { window.__fsStub.exited += 1; return Promise.resolve(); };
  });

  await page.goto(`${BASE}/?open=fullscreen-paper.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await page.waitForFunction(() => __state.viewerDocId === __state.doc.docId && __ctx.activeTab === __state.doc.docId);
  await wait(600);
  const docs = await fetch(`${BASE}/api/papers`).then(response => response.json()).then(result => result.papers);
  const firstDoc = docs.find(doc => doc.name === 'fullscreen-paper.pdf'), otherDoc = docs.find(doc => doc.name === 'other-paper.pdf');
  await page.evaluate(doc => __ctx.openDoc(doc), otherDoc);
  await page.waitForFunction(id => __state.viewerDocId === id && __ctx.tabs.some(tab => tab.docId === id), {}, otherDoc.docId);
  await page.evaluate(() => __viewer.goToPage(3)); await wait(350);
  await page.evaluate(doc => __ctx.openDoc(doc), firstDoc);
  await page.waitForFunction(id => __state.viewerDocId === id && __ctx.activeTab === id, {}, firstDoc.docId);
  await page.evaluate(() => __viewer.goToPage(5)); await wait(350);

  const ui = () => page.evaluate(() => {
    const topbar = document.querySelector('.topbar');
    const foot = document.querySelector('#viewerFoot');
    const main = document.querySelector('#main');
    const btn = document.querySelector('#fullscreenBtn');
    return {
      fullscreen: document.body.classList.contains('window-fullscreen'),
      topbar: topbar ? getComputedStyle(topbar).display : 'missing',
      foot: foot ? getComputedStyle(foot).display : 'missing',
      footBottom: foot ? foot.getBoundingClientRect().bottom : 0,
      mainH: main ? main.getBoundingClientRect().height : 0,
  // 普通和全屏状态都保留标签条。
  tabBar: (() => { const n = document.getElementById('tabBar'); if (!n) return 0; const s = getComputedStyle(n); return s.display === 'none' ? 0 : n.getBoundingClientRect().height; })(),
      innerH: window.innerHeight,
      btnVisible: !!btn && getComputedStyle(btn).display !== 'none',
      pressed: btn?.getAttribute('aria-pressed') || '',
      title: btn?.title || '',
      requested: window.__fsStub?.requested || 0,
    };
  });

  const before = await ui();
  check('顶栏有全屏按钮', before.btnVisible && before.fullscreen === false, JSON.stringify(before));
  check('普通状态：顶栏与底栏都在', before.topbar !== 'none' && before.foot !== 'none', `${before.topbar}/${before.foot}`);
  const navigation = () => page.evaluate(() => ({ reading: document.body.classList.contains('reading'),
    tabs: __ctx.tabs.map(tab => tab.docId), doc: __state.doc?.docId, page: __viewer.current,
    top: document.querySelector('#viewer').scrollTop, active: document.querySelectorAll('#tabStrip .doc-tab.active').length,
    homeCurrent: document.querySelector('#homeBtn')?.getAttribute('aria-current') }));
  const clickTab = async docId => {
    await page.click(`#tabStrip .doc-tab[data-doc="${docId}"] .tab-title`);
    await page.waitForFunction(id => document.body.classList.contains('reading') && __state.viewerDocId === id, {}, docId);
    await wait(350);
  };
  const homeRoundTrip = async mode => {
    const old = await navigation();
    await page.click('#homeBtn'); await page.waitForFunction(() => !document.body.classList.contains('reading'));
    const home = await navigation();
    check(`${mode}回首页保留全部标签且首页独占活动态`, JSON.stringify(home.tabs) === JSON.stringify(old.tabs) && home.active === 0 && home.homeCurrent === 'page', JSON.stringify(home));
    await page.screenshot({ path: path.join(scratch, `home-${mode === '普通' ? 'normal' : 'fullscreen'}.png`) });
    await clickTab(old.doc);
    const restored = await navigation();
    check(`${mode}首页点击原标签恢复页码和滚动`, restored.doc === old.doc && restored.page === old.page && Math.abs(restored.top - old.top) <= 3 && restored.homeCurrent !== 'page', JSON.stringify({ old, restored }));
    await page.click('#homeBtn'); await page.waitForFunction(() => !document.body.classList.contains('reading'));
    await clickTab(otherDoc.docId);
    check(`${mode}首页点击其他标签可阅读`, (await navigation()).doc === otherDoc.docId && (await navigation()).page === 3);
    await clickTab(firstDoc.docId);
  };
  await homeRoundTrip('普通');

  /* ── 1. 点按钮进入全屏：只改窗口，应用内 chrome 不动 ── */
  await page.click('#fullscreenBtn');
  await wait(450);
  const full = await ui();
  check('点按钮进入全屏（页面状态 + 请求了 Fullscreen API）', full.fullscreen && full.requested >= 1, JSON.stringify(full));
  check('全屏时顶栏与底栏保持显示（不再隐藏上方那一栏）', full.topbar !== 'none' && full.foot !== 'none', `${full.topbar}/${full.foot}`);
  check('底栏贴住窗口底边、最下面没有白条', Math.abs(full.footBottom - full.innerH) < 2, `${full.footBottom} vs ${full.innerH}`);
  check('全屏时标签条继续显示且高度不变', full.tabBar > 0 && Math.abs(full.tabBar - before.tabBar) < 1, `tabBar=${full.tabBar}`);
  check('全屏保留标签后的主区高度与普通状态一致',
    Math.abs(full.mainH - before.mainH) < 3, `${before.mainH} → ${full.mainH}`);
  check('全屏按钮切换到「退出全屏」态', full.pressed === 'true' && /退出全屏/.test(full.title), `${full.pressed} ${full.title}`);
  await homeRoundTrip('全屏');
  const navigationBeforeExit = await navigation();

  /* ── 2. Esc 退出全屏 ── */
  await page.keyboard.press('Escape');
  await wait(450);
  const exited = await ui();
  check('按 Esc 退出全屏', exited.fullscreen === false && exited.pressed === 'false', JSON.stringify(exited));
  check('退出后顶栏与底栏恢复', exited.topbar !== 'none' && exited.foot !== 'none', `${exited.topbar}/${exited.foot}`);
  check('Esc不改变文档、页码和标签', JSON.stringify(await navigation()) === JSON.stringify(navigationBeforeExit));

  /* ── 3. F11 也能切换全屏，再按 Esc 退出 ── */
  await page.keyboard.press('F11');
  await wait(450);
  const f11 = await ui();
  check('F11 进入全屏', f11.fullscreen === true && f11.requested >= full.requested + 1, JSON.stringify(f11));
  await page.keyboard.press('Escape');
  await wait(450);
  const f11out = await ui();
  check('Esc 再次退出（F11 进入的）', f11out.fullscreen === false, JSON.stringify(f11out));
  check('F11和Esc往返保留阅读位置及标签', JSON.stringify(await navigation()) === JSON.stringify(navigationBeforeExit));
  await page.setViewport({ width: 780, height: 900 }); await wait(500);
  const clickable = selector => page.evaluate(selector => {
    const node = document.querySelector(selector); if (!node) return false;
    const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && (node === hit || node.contains(hit));
  }, selector);
  check('窄窗口首页和全屏按钮均可点', await clickable('#homeBtn') && await clickable('#fullscreenBtn'));
  await page.click('#fullscreenBtn'); await wait(350); await page.click('#homeBtn');
  await page.waitForFunction(() => !document.body.classList.contains('reading'));
  check('窄窗口全屏可以直接回首页', (await ui()).fullscreen && (await navigation()).homeCurrent === 'page');
  await clickTab(firstDoc.docId);
  check('窄窗口全屏标签可恢复阅读且底栏贴底', Math.abs((await ui()).footBottom - (await ui()).innerH) < 2 && (await navigation()).reading);
  await page.screenshot({ path: path.join(scratch, 'fullscreen-narrow.png') });
  await page.keyboard.press('Escape'); await page.setViewport({ width: 1500, height: 950 }); await wait(400);
  await page.evaluate(() => { __viewer.setScale(__viewer.scale * 1.8); }); await wait(500);
  for (const fullscreen of [false, true]) {
    if (fullscreen) { await page.keyboard.press('F11'); await wait(300); }
    await page.evaluate(() => { __viewer.container.scrollLeft = (__viewer.container.scrollWidth - __viewer.container.clientWidth) * .72; __viewer.container.scrollTop += 37; }); await wait(250);
    const snapshot = () => page.evaluate(() => ({ scale: __viewer.scale, fit: __viewer._fitMode,
      left: __viewer.container.scrollLeft, top: __viewer.container.scrollTop, page: __viewer.current }));
    const original = await snapshot();
    check(`${fullscreen ? '全屏' : '普通'}手动缩放夹具确有横向滚动`, original.left > 10 && !original.fit, JSON.stringify(original));
    await page.click('#homeBtn'); await page.waitForFunction(() => !document.body.classList.contains('reading'));
    await clickTab(firstDoc.docId);
    const restored = await snapshot();
    check(`${fullscreen ? '全屏' : '普通'}首页往返保留手动缩放和横纵位置`, Math.abs(restored.scale - original.scale) < 1e-8 && !restored.fit
      && Math.abs(restored.left - original.left) <= 3 && Math.abs(restored.top - original.top) <= 3 && restored.page === original.page,
      JSON.stringify({ original, restored }));
    if (fullscreen) { await page.keyboard.press('Escape'); await wait(300); }
  }
  await page.screenshot({ path: path.join(scratch, 'home-manual-zoom-restored.png') });

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n全屏：${checks.length - failed.length}/${checks.length} 通过`);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ mode: desktop ? 'desktop-assets' : 'source', fullscreenApi: 'stub', checks, pageErrors }, null, 2), 'utf8');
  console.log(`证据：${scratch}`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  await stopChild(reader);
}
