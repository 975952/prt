/** Landing composition and zoom geometry against a real isolated reader. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stopChild } from './_exe.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'agent-landing-layout-'));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
writeTitlePdf(path.join(papersDir, 'zoom-fixture.pdf'), { title: 'Synthetic zoom isolation paper' });
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
assert.ok(executablePath);
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, page;
const errors = [], checks = [];
const pass = label => { checks.push({ label }); console.log(`PASS ${label}`); };
const reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore',
  env: { ...process.env, PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' } });
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await wait(100);
  }
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => { localStorage.setItem('reader.locale', 'zh-CN'); localStorage.setItem('reader.session.scopeMode', 'paper'); });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__ctx);
  await page.click('#homeAgent');
  await page.waitForFunction(() => document.body.classList.contains('agent-landing') && document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true');
  for (const theme of ['glass', 'dark']) {
    // Use the real settings control so the inline palette and theme token agree.
    await page.select('#uiTheme', theme);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme
      && JSON.parse(localStorage.getItem('reader.ui')).style.theme === theme, {}, theme);
    for (const [width, scale] of [[1920, 1], [1400, 1], [900, 1], [320, 1], [1920, 1.6], [320, 1.6]]) {
      await page.setViewport({ width, height: 940 });
      await page.evaluate(scale => {
        document.documentElement.style.setProperty('--agent-scale', scale);
        document.getElementById('rightSide').scrollTop = 0;
        const recent = document.querySelector('#agentRecentTitle'); recent.hidden = false;
        recent.textContent = 'Tokens-to-Token ViT long recent conversation title that must stay inside the card';
      }, scale);
      await wait(120);
      const geometry = await page.evaluate(() => {
        const r = id => { const box = document.getElementById(id).getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; };
        const panel = document.getElementById('rightSide');
        return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
          panel: r('rightSide'), hero: r('agentLanding'), composer: r('composer'), actions: r('agentLaunchActions'),
          input: r('chatInput'), send: r('sendBtn'), scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
          hidden: ['aiArea', 'sessBar', 'agentIdentity', 'agentPaperPicker', 'agentHandoffLayer'].every(id => !document.getElementById(id).getClientRects().length),
          cardOverflow: [...document.querySelectorAll('.agent-launch-copy')].some(node => node.scrollWidth > node.clientWidth + 1) };
      });
      const label = `${theme}-${width}-${scale}`;
      assert.ok(geometry.documentWidth <= width + 1, `${label} page overflow ${JSON.stringify(geometry)}`);
      assert.ok(geometry.panel.left >= -1 && geometry.panel.right <= width + 1, `${label} panel overflow ${JSON.stringify(geometry)}`);
      assert.ok(Math.abs(geometry.panel.bottom - geometry.height) <= 1, `${label} panel does not fill available height ${JSON.stringify(geometry)}`);
      assert.ok(geometry.hero.left >= -1 && geometry.actions.right <= width + 1 && geometry.send.right <= width + 1, `${label} composition overflow ${JSON.stringify(geometry)}`);
      assert.ok(geometry.input.width > 80 && geometry.send.width > 20 && geometry.hidden && !geometry.cardOverflow, `${label} readability ${JSON.stringify(geometry)}`);
      if (geometry.scrollHeight <= geometry.clientHeight + 1) assert.ok(Math.abs((geometry.hero.top + geometry.actions.bottom) / 2 - (geometry.panel.top + geometry.panel.bottom) / 2) <= 3, `${label} not centered ${JSON.stringify(geometry)}`);
      else assert.ok(geometry.hero.top >= geometry.panel.top, `${label} scroll clips heading`);
      checks.push({ label, geometry });
      await page.screenshot({ path: path.join(scratch, `${label}.png`) });
      if (geometry.scrollHeight > geometry.clientHeight + 1) {
        const lastCard = await page.evaluate(() => {
          const panel = document.getElementById('rightSide'); panel.scrollTop = panel.scrollHeight;
          const card = document.getElementById('agentResume').getBoundingClientRect(), bounds = panel.getBoundingClientRect();
          return { top: card.top, bottom: card.bottom, panelTop: bounds.top, panelBottom: bounds.bottom };
        });
        assert.ok(lastCard.top >= lastCard.panelTop && lastCard.bottom <= lastCard.panelBottom + 1,
          `${label} last action cannot be reached ${JSON.stringify(lastCard)}`);
        await page.screenshot({ path: path.join(scratch, `${label}-bottom.png`) });
      }
      console.log(`PASS ${label}`);
    }
  }
  const draftGeometry = await page.evaluate(() => {
    const panel = document.getElementById('rightSide'); panel.scrollTop = 0;
    const box = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    const composer = document.getElementById('composer'), card = composer.querySelector('.composer-row');
    const status = document.getElementById('draftStorage'), retry = document.getElementById('draftStorageRetry');
    const before = box(card);
    status.dataset.status = 'saving'; status.classList.remove('hidden');
    document.getElementById('draftStorageText').textContent = '正在保存草稿…'; retry.classList.add('hidden');
    const saving = box(card);
    status.dataset.status = 'error'; document.getElementById('draftStorageText').textContent = 'Draft not saved. Retry before closing.';
    retry.classList.remove('hidden'); retry.scrollIntoView({ block: 'center' });
    const retryBox = retry.getBoundingClientRect(), hit = document.elementFromPoint(retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2);
    return { before, saving, error: box(status), card: box(card), action: box(document.getElementById('agentLaunchActions')),
      retryReachable: hit === retry || retry.contains(hit) };
  });
  assert.deepEqual(draftGeometry.saving, draftGeometry.before);
  pass('routine saving status leaves the narrow enlarged landing composition unchanged');
  assert.ok(draftGeometry.error.bottom <= draftGeometry.card.top && draftGeometry.card.bottom <= draftGeometry.action.top
    && draftGeometry.retryReachable, `draft error blocks controls ${JSON.stringify(draftGeometry)}`);
  await page.screenshot({ path: path.join(scratch, 'draft-error-320-1.6.png') });
  pass('a draft error keeps its retry accessible without covering the input or action cards');
  await page.evaluate(() => { const row = document.getElementById('draftStorage'); row.dataset.status = 'saved'; row.classList.add('hidden');
    document.getElementById('draftStorageRetry').classList.add('hidden'); });
  await page.setViewport({ width: 1400, height: 940 });
  await page.select('#uiTheme', 'glass');
  const preferences = () => page.evaluate(() => {
    const style = JSON.parse(localStorage.getItem('reader.ui') || '{}').style || {};
    const computed = getComputedStyle(document.documentElement);
    return { agent: Number(style.agentZoom || 100), home: Number(style.homeZoom || 100), font: Number(style.fontSize || 14),
      scale: Number(computed.getPropertyValue('--agent-scale')), fontCss: computed.getPropertyValue('--ai-fs').trim(),
      pdfScale: window.__viewer?.scale };
  });
  const shortcut = async (key, count = 1) => {
    await page.keyboard.down('Control');
    for (let i = 0; i < count; i++) await page.keyboard.press(key);
    await page.keyboard.up('Control');
  };
  const originalPreferences = await preferences();
  await shortcut('Equal', 3);
  const enlarged = await preferences();
  assert.equal(enlarged.agent, 130); assert.equal(enlarged.scale, 1.3);
  assert.equal(enlarged.home, originalPreferences.home); assert.equal(enlarged.fontCss, originalPreferences.fontCss);
  pass('full-agent keyboard zoom changes only the agent preference');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.click('#homeAgent');
  await page.waitForFunction(() => document.body.classList.contains('agent-landing') && document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true');
  assert.equal((await preferences()).agent, 130); assert.equal((await preferences()).scale, 1.3);
  pass('agent zoom persists across reload and reopening');
  await shortcut('Digit0');
  assert.equal((await preferences()).agent, 100); assert.equal((await preferences()).scale, 1);
  await shortcut('Minus', 10); assert.equal((await preferences()).agent, 70);
  await shortcut('Equal', 20); assert.equal((await preferences()).agent, 160);
  pass('agent reset and 70 to 160 percent bounds work through keyboard shortcuts');
  await shortcut('Digit0'); await shortcut('Equal', 3);
  const fullBeforeDock = await page.$eval('#rightSide', node => {
    const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  await page.evaluate(() => {
    const panel = document.getElementById('rightSide'), animate = panel.animate.bind(panel);
    window.__zoomPanel = panel; window.__zoomPanelTransitions = [];
    panel.animate = (frames, options) => {
      const animation = animate(frames, options); animation.currentTime = 0;
      const r = panel.getBoundingClientRect();
      window.__zoomPanelTransitions.push({ left: r.left, top: r.top, width: r.width, height: r.height });
      return animation;
    };
  });
  await page.evaluate(() => window.__ctx.openAgentPaper(window.__state.papers[0]));
  await page.waitForFunction(() => document.body.classList.contains('agent-docked') && window.__viewer?.pdf);
  const dockTransition = await page.evaluate(() => ({ same: window.__zoomPanel === document.getElementById('rightSide'),
    start: window.__zoomPanelTransitions[0], zoom: Number(getComputedStyle(document.getElementById('rightSide')).zoom) }));
  assert.ok(dockTransition.same); assert.equal(dockTransition.zoom, 1);
  for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(dockTransition.start[key] - fullBeforeDock[key]) <= 1,
    `zoomed full-to-dock transition jumps at ${key}: ${JSON.stringify({ fullBeforeDock, dockTransition })}`);
  pass('zoomed agent docks from the same physical bounds and restores normal sidebar scale');
  const beforeReading = await preferences();
  await shortcut('Equal');
  const afterReading = await preferences();
  assert.equal(afterReading.agent, beforeReading.agent); assert.equal(afterReading.home, beforeReading.home);
  assert.equal(afterReading.font, beforeReading.font + 1); assert.equal(afterReading.pdfScale, beforeReading.pdfScale);
  pass('reader keyboard sizing stays separate from agent and PDF zoom');
  await page.click('#agentExpand');
  await page.waitForFunction(() => document.body.classList.contains('agent-full') && document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true');
  assert.equal((await preferences()).scale, 1.3);
  await shortcut('Digit0');
  assert.equal((await preferences()).agent, 100); assert.equal((await preferences()).font, afterReading.font);
  pass('expanded conversation restores agent scale and resets without changing reading size');
  await page.click('#homeBtn');
  await page.waitForSelector('#home', { visible: true });
  const homeBefore = await preferences();
  await shortcut('Equal');
  const homeAfter = await preferences();
  assert.equal(homeAfter.home, homeBefore.home + 10); assert.equal(homeAfter.agent, homeBefore.agent);
  assert.equal(homeAfter.font, homeBefore.font); assert.equal(homeAfter.pdfScale, homeBefore.pdfScale);
  pass('library zoom remains independent of agent and reading preferences');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ checks, errors }, null, 2), 'utf8');
  console.log(`agent-landing-layout: ${checks.length}/${checks.length}; ${scratch}`);
} catch (error) {
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ errors, state: await page?.evaluate(() => ({ classes: document.body.className,
    workspace: window.__ctx?.agentWorkspaceState?.(), status: document.getElementById('agentStatus')?.textContent })).catch(() => null) }));
  console.error(`Failure evidence: ${scratch}`); throw error;
} finally { await browser?.close(); await stopChild(reader); }
