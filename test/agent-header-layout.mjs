/** Open-paper controls keep separate hit targets in full and docked workspaces.
 * node test/agent-header-layout.mjs [--desktop] — isolated synthetic PDF/session only. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `agent-header-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'header-fixture.pdf'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let reader, browser, page, passed = 0;
const errors = [], evidence = [];
const pass = label => { passed++; console.log(`PASS ${label}`); };
try {
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
  reader = desktop ? spawnReader(stageExe('agent-header').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready, 'isolated reader starts');
  assert.equal(await fetch(`${base}/agent-workspace.css`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public/agent-workspace.css'), 'utf8'));
  const response = await fetch(`${base}/api/session?doc=default&sid=header-fixture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    title: 'A discussion with a long title to preserve space for the paper controls', titleSource: 'user', createdAt: Date.now(), updatedAt: Date.now(),
    entries: [{ id: 'user', kind: 'user', block: 'chat', text: 'Keep this conversation while I choose a paper.', status: 'user' },
      { id: 'answer', kind: 'assistant', block: 'chat', text: 'Choose a paper to continue reading.', status: 'complete' }], history: [], ops: [],
  }) });
  assert.ok(response.ok);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push(request.failure()?.errorText); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== base) { errors.push(`External browser request ${url.origin}`); return request.abort(); }
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'en');
    localStorage.setItem('reader.session.scopeMode', 'global');
    localStorage.setItem('reader.session.onEnter', 'latest');
  });
  await page.setViewport({ width: 1400, height: 940 });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__ctx);
  await page.evaluate(() => { window.__paperActionReference = document.getElementById('agentPapersToggle'); });
  await page.click('#homeAgent');
  await page.waitForFunction(() => document.body.classList.contains('agent-landing'));
  const geometry = () => page.evaluate(() => {
    const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const ids = ['agentPapersToggle', 'agentPapersClose', 'agentPaperPicker', 'sessBar', 'rightSide'];
    const boxes = Object.fromEntries(ids.map(id => [id, rect(id)]));
    const hit = id => { const r = boxes[id], node = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!node?.closest(`#${id}`); };
    return { ...boxes, toggleHit: hit('agentPapersToggle'), closeHit: hit('agentPapersClose'),
      full: document.body.classList.contains('agent-full'), headerVisible: !!document.getElementById('sessBar').getClientRects().length,
      actionInNavigation: !!document.querySelector('#agentNav .agent-nav-primary #agentPapersToggle'),
      actionInReader: !!document.querySelector('#agentIdentity .agent-identity-actions #agentPapersToggle'),
      sameAction: document.getElementById('agentPapersToggle') === window.__paperActionReference && document.querySelectorAll('#agentPapersToggle').length === 1,
      overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  const checkPicker = async label => {
    await page.click('#agentPapersToggle'); await page.waitForSelector('#agentPaperPicker', { visible: true });
    const g = await geometry(); evidence.push({ label, ...g });
    const a = g.agentPapersToggle, b = g.agentPapersClose;
    const overlap = Math.min(a.right, b.right) - Math.max(a.x, b.x) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > .5;
    assert.ok(!overlap, `${label}: Open paper and close must not overlap: ${JSON.stringify(g)}`);
    assert.ok(g.toggleHit && g.closeHit && !g.overflow, `${label}: controls must retain independent hit targets: ${JSON.stringify(g)}`);
    assert.ok(g.sameAction && (g.full ? g.actionInNavigation : g.actionInReader), `${label}: same button belongs to the current workspace navigation`);
    if (g.full && g.headerVisible) assert.ok(g.agentPaperPicker.y >= g.sessBar.bottom - .5, `${label}: picker begins below the conversation header`);
    if (!g.full) assert.ok(g.agentPaperPicker.y >= a.bottom - .5, `${label}: picker begins below the reader action`);
    await page.click('#agentPapersClose');
    assert.equal(await page.$eval('#agentPaperPicker', node => node.hidden), true, `${label}: close collapses the picker`);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'agentPapersToggle', `${label}: close restores focus`);
    pass(label);
  };
  await checkPicker('landing: paper chooser opens from sidebar and closes independently');
  const expandedWidth = await page.$eval('#rightSide', node => node.getBoundingClientRect().width);
  const panelStyle = await page.$eval('#rightSide', node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return { radius: parseFloat(style.borderRadius), shadow: style.boxShadow, background: style.backgroundImage,
      right: rect.right, bottom: rect.bottom, viewport: { width: innerWidth, height: innerHeight } };
  });
  assert.ok(panelStyle.radius >= 16 && panelStyle.shadow !== 'none' && panelStyle.background !== 'none'
    && panelStyle.right < panelStyle.viewport.width && panelStyle.bottom < panelStyle.viewport.height);
  pass('Alina has a rounded translucent surface with breathing room around the edges');
  await page.screenshot({ path: path.join(scratch, 'landing-expanded.png') });
  await page.click('#agentSidebarToggle');
  await page.waitForFunction(width => document.getElementById('rightSide').getBoundingClientRect().width > width + 120, {}, expandedWidth);
  const collapsed = await page.evaluate(() => {
    const nav = document.getElementById('agentNav');
    const buttons = [...nav.querySelectorAll('.agent-nav-primary button')];
    return { expanded: document.getElementById('agentSidebarToggle').getAttribute('aria-expanded'),
      saved: localStorage.getItem('reader.agent.sidebarCollapsed'),
      controls: buttons.every(button => button.getClientRects().length && button.getAttribute('aria-label')
        && button.querySelector('[data-agent-icon]').getClientRects().length),
      labelsHidden: buttons.every(button => !button.querySelector('span:last-child').getClientRects().length) };
  });
  assert.deepEqual(collapsed, { expanded: 'false', saved: '1', controls: true, labelsHidden: true });
  pass('collapse expands the main workspace and retains labeled icon controls');
  await checkPicker('collapsed sidebar: same paper control remains usable');
  await page.screenshot({ path: path.join(scratch, 'landing-collapsed.png') });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__ctx);
  await page.evaluate(() => { window.__paperActionReference = document.getElementById('agentPapersToggle'); });
  await page.click('#homeAgent');
  await page.waitForFunction(() => document.body.classList.contains('agent-landing'));
  assert.equal(await page.$eval('#agentSidebarToggle', node => node.getAttribute('aria-expanded')), 'false');
  assert.ok(await page.$eval('#agentNav', node => node.getBoundingClientRect().width < 100));
  pass('sidebar collapse preference survives a reload');
  await page.setViewport({ width: 900, height: 940 });
  await page.evaluate(() => document.documentElement.style.setProperty('--agent-scale', 1.6));
  await checkPicker('collapsed sidebar at 160%: paper controls remain separate');
  await page.setViewport({ width: 320, height: 940 });
  await checkPicker('narrow at 160%: navigation becomes a compact usable row');
  assert.equal(await page.$eval('#agentSidebarToggle', node => !!node.getClientRects().length), false);
  await page.setViewport({ width: 1400, height: 940 });
  await page.evaluate(() => document.documentElement.style.setProperty('--agent-scale', 1));
  await page.click('#agentSidebarToggle');
  await page.waitForFunction(width => Math.abs(document.getElementById('rightSide').getBoundingClientRect().width - width) < 2, {}, expandedWidth);
  assert.equal(await page.evaluate(() => localStorage.getItem('reader.agent.sidebarCollapsed')), '0');
  pass('expanding restores the navigation and main workspace geometry');
  for (const theme of ['dark', 'glass']) {
    await page.select('#uiTheme', theme);
    await page.screenshot({ path: path.join(scratch, `landing-${theme}.png`) });
  }
  await page.click('#agentResume');
  await page.waitForFunction(() => document.body.classList.contains('agent-full') && !document.body.classList.contains('agent-landing')
    && document.querySelector('#aiArea').textContent.includes('Choose a paper to continue reading.'));
  for (const width of [900, 1920, 480, 320]) {
    for (const scale of [1, 1.6]) {
      await page.setViewport({ width, height: 940 });
      await page.evaluate(scale => document.documentElement.style.setProperty('--agent-scale', scale), scale);
      await checkPicker(`full ${width}px at ${scale * 100}%: separate Open paper and close controls`);
    }
  }
  await page.setViewport({ width: 1400, height: 940 });
  await page.evaluate(() => document.documentElement.style.setProperty('--agent-scale', 1));
  await page.click('#agentHistory');
  await page.waitForFunction(() => document.getElementById('rightSide').dataset.sessView === 'history');
  await checkPicker('history: paper chooser remains available from sidebar');
  await page.click('#agentNavNew');
  await page.waitForFunction(() => document.body.classList.contains('agent-landing') && document.getElementById('rightSide').getAttribute('aria-busy') !== 'true');
  await page.click('#agentResume');
  await page.waitForFunction(() => document.body.classList.contains('agent-full') && !document.body.classList.contains('agent-landing'));
  await page.click('#agentPapersToggle');
  await page.screenshot({ path: path.join(scratch, 'full-picker.png') });
  await page.click('.agent-paper-row');
  await page.waitForFunction(() => document.body.classList.contains('agent-docked') && !document.body.classList.contains('agent-transitioning'));
  for (const width of [1400, 900, 480, 320]) {
    await page.setViewport({ width, height: 940 });
    await checkPicker(`docked ${width}px: separate Open paper and close controls`);
  }
  await page.click('#agentPapersToggle');
  await page.screenshot({ path: path.join(scratch, 'docked-picker.png') });
  assert.deepEqual(errors, []); pass('no browser errors or external service requests');
  console.log(`Agent header layout: ${passed}/${passed}; ${scratch}`);
} catch (error) {
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Agent header artifacts: ${scratch}`); throw error;
} finally {
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ passed, errors, geometry: evidence }, null, 2), 'utf8');
  await browser?.close().catch(() => {}); await stopChild(reader);
}
