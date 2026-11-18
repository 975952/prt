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
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papersDir, 'A long paper title to check toolbar truncation.pdf'));
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
const errors = [], geometries = [];
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
  await page.evaluateOnNewDocument(() => { localStorage.setItem('reader.locale', 'en'); });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__ctx);
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
  await page.click('#homeAgent');
  await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  check('Alina opens from its workspace tab', await page.$eval('#agentBtn', n => n.getAttribute('aria-current') === 'page'));
  await inspect('alina');
  await page.click('#homeBtn');
  await page.waitForFunction(() => !document.body.classList.contains('agent-full'));
  check('Library tab returns to its workspace', await page.$eval('#homeBtn', n => n.getAttribute('aria-current') === 'page'));
  await page.click('#homeList .home-item-go');
  await page.waitForFunction(() => window.__viewer?.numPages > 0 && document.body.classList.contains('reading'));
  await inspect('reader');
  check('no browser errors', errors.length === 0, errors);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors, geometries }, null, 2), 'utf8');
  console.log(`workspace-navigation: ${checks}/${checks}; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: String(error), errors, geometries }, null, 2), 'utf8');
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Artifacts: ${scratch}`); throw error;
} finally { await browser?.close(); await stopChild(reader); }
