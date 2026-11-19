/** Workspace navigation geometry and real view switching with isolated fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `workspace-nav-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const firstName = 'A long paper title to check toolbar truncation.pdf', secondName = 'Second recent paper.pdf';
for (const name of [firstName, secondName]) fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papersDir, name));
const portProbe = http.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
  PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', PRT_QUIET_TOKEN: '1', NO_OPEN: '1' };
let reader, browser, page;
let checks = 0;
const errors = [], geometries = [], positions = [];
const check = (label, condition, detail) => { assert.ok(condition, `${label}${detail ? `: ${JSON.stringify(detail)}` : ''}`); checks++; console.log(`PASS ${label}`); };
try {
  reader = desktop ? spawnReader(stageExe('workspace-nav').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  check('isolated reader starts', ready);
  check('current navigation stylesheet is served', await fetch(`${base}/workspace-nav.css`).then(r => r.text()) === fs.readFileSync(path.join(ROOT, 'public/workspace-nav.css'), 'utf8'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-sandbox'], userDataDir: path.join(scratch, 'browser'), defaultViewport: { width: 1440, height: 940 } });
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if ((/^https?:$/.test(url.protocol) && url.origin !== base)
      || ['/api/chat', '/api/web-search', '/api/ref-search', '/api/import-pdf'].includes(url.pathname)) {
      errors.push(`Unexpected external/model request: ${url.origin}${url.pathname}`); return request.abort();
    }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'en');
    localStorage.setItem('reader.session.scopeMode', 'paper');
    localStorage.setItem('reader.session.onEnter', 'latest');
    localStorage.setItem('reader.session.aiTitle', '0');
  });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__ctx);
  const settled = async () => {
    await page.waitForFunction(() => document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true'
      && !document.body.classList.contains('agent-transitioning'));
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter(animation => animation.playState === 'running')
        .map(animation => animation.finished.catch(() => {})));
    });
  };
  const openAlina = async () => {
    const button = await page.$eval('#agentBtn', node => node.getClientRects().length ? '#agentBtn' : '#homeAgent');
    await page.locator(button).click();
    await page.waitForFunction(() => document.body.classList.contains('agent-full'));
    await settled();
  };
  const returnReader = async button => {
    await page.locator(button).click();
    await page.waitForFunction(() => document.body.classList.contains('reading') && !document.body.classList.contains('agent-full')
      && window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId);
    await settled();
  };
  const openLibrary = async () => {
    await page.locator('#homeBtn').click();
    await page.waitForSelector('#home', { visible: true });
    await settled();
  };
  const input = async value => {
    await page.$eval('#chatInput', (node, text) => { node.value = text; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    await page.evaluate(() => window.__ctx.flushComposerDrafts());
  };
  const position = async label => {
    const value = await page.evaluate(() => ({ path: window.__state.doc?.path, page: window.__viewer.current,
      scale: window.__viewer.scale, fit: window.__viewer._fitMode, anchor: window.__viewer._captureAnchor(),
      scrollTop: window.__viewer.container.scrollTop, samePdf: window.__navPdf === window.__viewer.pdf,
      draft: document.getElementById('chatInput').value, view: window.__ctx.agentWorkspaceState().view }));
    positions.push({ label, ...value }); return value;
  };
  const expectPosition = async (label, before) => {
    const after = await position(label);
    check(label, after.path === before.path && after.samePdf && after.page === before.page
      && Math.abs(after.scale - before.scale) < .002 && after.fit === before.fit
      && after.anchor.page === before.anchor.page && Math.abs(after.anchor.frac - before.anchor.frac) < .01, { before, after });
  };
  async function inspect(scene) {
    for (const nativeChrome of [false, true]) {
      await page.evaluate(native => document.body.classList.toggle('no-window-chrome', !native), nativeChrome);
      for (const width of nativeChrome ? [1920, 1440, 900, 560] : [1920, 1440, 900, 480, 320]) {
        await page.setViewport({ width, height: 940 });
        const geometry = await page.evaluate(() => {
          const nav = document.getElementById('workspaceNav'), bar = document.getElementById('topbar');
          const box = n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
          const buttons = [...bar.querySelectorAll('button')].filter(n => n.getClientRects().length).map(n => ({ id: n.id, ...box(n), hit: (() => {
            const r = n.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top === n || n.contains(top);
          })() }));
          return { nav: box(nav), bar: box(bar), settings: box(document.getElementById('settingsBtn')), buttons,
            labels: [...nav.querySelectorAll('button')].filter(n => n.getClientRects().length).map(n => n.innerText.trim()),
            width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1, windowMenu: !!document.getElementById('windowsBtn') };
        });
        const label = `${scene}-${nativeChrome ? 'native' : 'browser'}-${width}`;
        geometries.push({ label, ...geometry });
        check(`${label}: workspace labels stay beside Settings without overlap`, !geometry.overflow && !geometry.windowMenu
          && geometry.labels.join('|') === 'Library|Alina' && geometry.bar.height === 44
          && geometry.nav.right <= geometry.settings.left && geometry.buttons.every(b => b.hit && b.left >= 0 && b.right <= width)
          && geometry.buttons.every((b, i) => geometry.buttons.slice(i + 1).every(c => b.right <= c.left + .5 || c.right <= b.left + .5)), geometry);
        if ((nativeChrome && [1440, 560].includes(width)) || (!nativeChrome && width === 320)) {
          await page.screenshot({ path: path.join(scratch, `${label}.png`) });
        }
      }
    }
    await page.evaluate(() => document.body.classList.add('no-window-chrome'));
    await page.setViewport({ width: 1440, height: 940 });
  }
  await inspect('library');
  await page.locator('#homeBtn').click();
  check('Library without reading history remains usable', await page.$eval('#home', node => !!node.getClientRects().length));
  await page.click('#homeAgent');
  await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  check('Alina opens from its workspace tab', await page.$eval('#agentBtn', n => n.getAttribute('aria-current') === 'page'));
  await inspect('alina');
  await page.locator('#agentBtn').click(); await settled();
  check('Alina without a recent PDF leaves a usable workspace', await page.evaluate(() =>
    !window.__viewer?.pdf && (document.body.classList.contains('agent-full') || !document.getElementById('home').classList.contains('hidden'))));
  if (!await page.evaluate(() => document.body.classList.contains('agent-full'))) await openAlina();
  await page.click('#homeBtn');
  await page.waitForFunction(() => !document.body.classList.contains('agent-full'));
  check('Library tab returns to its workspace', await page.$eval('#homeBtn', n => n.getAttribute('aria-current') === 'page'));
  await page.locator(`#homeList [data-path="${firstName}"] .home-item-go`).click();
  await page.waitForFunction(() => window.__viewer?.numPages > 0 && document.body.classList.contains('reading'));
  await inspect('reader');
  await settled();
  await page.evaluate(async () => {
    const viewer = window.__viewer;
    window.__navPdf = viewer.pdf;
    viewer.setScale(1.3, { keepCenter: false }); viewer._fitMode = false;
    await viewer.goToPage(5);
    await viewer.restorePosition({ scrollTop: viewer.container.scrollTop + 170 });
  });
  await input('UNSENT_PAPER_DRAFT');
  const before = await position('initial-reading-position');
  check('fixture has an interior reading position and custom scale', before.page >= 4 && before.scrollTop > 1000 && !before.fit);
  await openLibrary(); await returnReader('#homeBtn');
  await expectPosition('Library toggles back to the same PDF and reading position', before);
  check('Library round trip preserves the unsent paper draft', await page.$eval('#chatInput', node => node.value) === 'UNSENT_PAPER_DRAFT');
  await openAlina(); await input('UNSENT_ALINA_DRAFT'); await returnReader('#agentBtn');
  await expectPosition('Alina toggles back to the same PDF, page, scale and in-page position', before);
  await openAlina();
  check('Alina round trip preserves its separate unsent draft', await page.$eval('#chatInput', node => node.value) === 'UNSENT_ALINA_DRAFT');
  await openLibrary(); await returnReader('#homeBtn');
  await expectPosition('reader to Alina to Library returns to the original reading position', before);
  await openLibrary(); await openAlina(); await returnReader('#agentBtn');
  await expectPosition('reader to Library to Alina returns to the original reading position', before);
  await openLibrary();
  await page.locator(`#homeList [data-path="${secondName}"] .home-item-go`).click();
  await page.waitForFunction(name => window.__state.doc?.path === name && window.__state.viewerDocId === window.__state.doc.docId, {}, secondName);
  await settled();
  await page.evaluate(async () => {
    window.__navPdf = window.__viewer.pdf;
    window.__viewer.fitWidth();
    await window.__viewer.goToPage(8);
    await window.__viewer.restorePosition({ scrollTop: window.__viewer.container.scrollTop + 125 });
  });
  const second = await position('second-paper-position');
  await openAlina(); await returnReader('#agentBtn');
  await expectPosition('Alina returns to the most recently read paper rather than the earlier PDF', second);
  // Library saves progress before hiding; a new empty workspace must still be
  // able to resume the persisted most recent PDF after an Alina round trip.
  await openLibrary();
  await page.waitForFunction(async () => {
    const saved = await fetch('/api/state').then(response => response.json());
    return saved.lastDoc === window.__state.doc.docId && saved.docs?.[saved.lastDoc]?.page === window.__viewer.current;
  });
  const persisted = await fetch(`${base}/api/state`).then(response => response.json());
  await page.evaluate(() => localStorage.removeItem('reader.workspace.v1'));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__ctx && !window.__viewer.pdf);
  await openAlina(); await returnReader('#agentBtn');
  const restored = await position('restored-from-persisted-history');
  check('without an open tab Alina returns to the last saved PDF and page', restored.path === secondName
    && restored.page === persisted.docs[persisted.lastDoc].page, { restored, savedPage: persisted.docs[persisted.lastDoc].page });
  check('no browser errors', errors.length === 0, errors);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors, geometries, positions }, null, 2), 'utf8');
  console.log(`workspace-navigation: ${checks}/${checks}; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: String(error), errors, geometries, positions }, null, 2), 'utf8');
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Artifacts: ${scratch}`); throw error;
} finally { await browser?.close(); await stopChild(reader); }
