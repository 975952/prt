/** Real Library layout with isolated state, no user files or model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { writeTitlePdf } from './fixtures/make-title-pdf.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
const desktop = process.argv.includes('--desktop');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'reading-entry-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
writeTitlePdf(path.join(papers, 'Reading.pdf'), { title: 'Startup reading fixture' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('library-sidebar').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await pause(100); }
  assert.ok(ready);
  for (const asset of ['js/library-sidebar.js', 'js/agent-resize.js', 'js/agent-workspace.js', 'js/app.js', 'style.css', 'agent-workspace.css']) {
    assert.equal(await fetch(`${base}/${asset}`).then(r => r.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1600, height: 1000 } });
  const page = await browser.newPage(), errors = [];
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 1);
  const paper = (await fetch(base + '/api/papers').then(r => r.json())).papers[0];
  assert.equal(await page.$eval('#homeReadingEntry', n => n.disabled), true);
  await page.goto(base + '/?document=' + encodeURIComponent(paper.docId), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && window.__state.viewerDocId === window.__state.doc?.docId && document.body.classList.contains('reading'));
  const filesRail = '#railLeft [data-rail="files"]';
  if (await page.$eval(filesRail, n => !n.classList.contains('active'))) await page.click(filesRail);
  await page.click(filesRail);
  assert.ok(await page.evaluate(() => document.body.classList.contains('no-left')));
  assert.equal(await page.$('#railLeft .active'), null);
  await page.click('#topbarLeftToggle');
  if (await page.$eval(filesRail, n => !n.classList.contains('active'))) await page.click(filesRail);
  assert.ok(await page.$eval(filesRail, n => n.classList.contains('active')));
  assert.equal(await page.$('.panel-hide'), null);
  await page.locator('#homeBtn').click();
  await page.waitForFunction(() => !document.body.classList.contains('reading'));
  await page.evaluate(() => {
    const theme = document.querySelector('#uiTheme'); theme.value = 'dark';
    theme.dispatchEvent(new Event('input', { bubbles: true }));
    const brightness = document.querySelector('#uiGlassBrightness'); brightness.value = '70';
    brightness.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.ok(await page.$eval('.home-content', n => {
    const probe = document.createElement('span');
    probe.style.background = 'var(--workspace-content)'; n.append(probe);
    const expected = getComputedStyle(probe).backgroundColor; probe.remove();
    return getComputedStyle(n).backgroundColor === expected && expected !== getComputedStyle(document.querySelector('.home-sidebar')).backgroundColor;
  }), 'dark library content follows the shared theme and has its own surface');
  await page.screenshot({ path: path.join(scratch, 'library-dark.png') });
  assert.equal(await page.$eval('#homeReadingEntry span', n => n.textContent), '回到阅读区');
  await page.goto(base + '/?topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length === 1);
  assert.equal(await page.$eval('#homeReadingEntry span', n => n.textContent), '继续阅读');
  assert.equal(await page.$eval('#homeReadingEntry', n => n.disabled), false);
  await page.screenshot({ path: path.join(scratch, 'library-entry.png') });
  await page.locator('#homeAgent').click();
  await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  assert.equal(await page.$eval('#agentLandingName', n => n.textContent), 'Alina');
  const launchCards = await page.$$eval('#agentLaunchActions > button', nodes => nodes.length);
  assert.equal(launchCards, 3, 'landing shows all three launch cards');
  assert.equal(await page.$('#agentNav #agentReadingEntry'), null, 'landing does not duplicate the reading card in the sidebar');
  await pause(400);
  await page.hover('#agentStartSearch'); await pause(350);
  const hoverTransform = await page.$eval('#agentStartSearch', n => getComputedStyle(n).transform);
  assert.ok(await page.$eval('#agentStartSearch', n => { const m = new DOMMatrixReadOnly(getComputedStyle(n).transform); return m.a > 1 && m.m42 === 0; }), 'hover gently enlarges without vertical movement');
  await page.mouse.down(); await pause(120);
  const pressTransform = await page.$eval('#agentStartSearch', n => getComputedStyle(n).transform);
  assert.notEqual(pressTransform, hoverTransform, 'pressing a launch card must visibly depress it');
  await page.mouse.move(5, 5); await page.mouse.up(); await pause(350);
  assert.equal(await page.$eval('#agentStartSearch', n => getComputedStyle(n).transform), 'none');
  for (const selector of ['#agentReadingEntry', '#agentNavNew']) {
    assert.ok(await page.$eval(selector, n => n.getBoundingClientRect().height > 30 && getComputedStyle(n).visibility !== 'hidden'));
  }
  assert.equal(await page.$eval('#agentReadingEntry .agent-launch-title', n => n.textContent), '继续阅读');
  assert.equal(await page.$eval('#agentReadingEntry .agent-resume-name', n => n.textContent), 'Reading');
  await page.evaluate(() => {
    window.__readingEntryNode = document.querySelector('#agentReadingEntry');
    window.__originalReadingTitle = document.querySelector('.agent-resume-name').textContent;
    document.querySelector('.agent-resume-name').textContent = 'Learning Transferable Visual Models From Natural Language Supervision — 完整论文标题显示测试';
    document.querySelector('#agentRecentTitle').textContent = 'Harry Potter and the Chamber of Secrets — 完整会话标题不应该被省略';
  });
  const fullText = () => page.$$eval('#agentLaunchActions .agent-launch-copy span', nodes => nodes.every(n => {
    const cs = getComputedStyle(n); return cs.textOverflow !== 'ellipsis' && cs.whiteSpace !== 'nowrap' && n.scrollWidth <= n.clientWidth + 1;
  }));
  assert.ok(await fullText(), 'all three launch cards wrap their full text');
  await page.screenshot({ path: path.join(scratch, 'alina-three-cards.png') });
  await page.locator('#agentSidebarToggle').click();
  assert.ok(await page.$eval('#agentNavNew', n => n.getBoundingClientRect().width > 30));
  assert.equal(await page.$$eval('#agentLaunchActions > button', nodes => nodes.filter(n => n.getClientRects().length).length), 3);
  assert.ok(await fullText(), 'collapsed sidebar still leaves all landing text visible');
  assert.equal(await page.$('#agentNewSessionEntry'), null);
  assert.ok(await page.$('#agentNavNew [data-agent-icon="chat-new"] svg'));
  await page.evaluate(() => window.__ctx.openAgentWorkspace({ landing: false }));
  await pause(350);
  assert.ok(await page.evaluate(() => document.querySelector('#agentReadingEntry').closest('#agentNav') !== null));
  assert.ok(await page.evaluate(() => window.__readingEntryNode === document.querySelector('#agentReadingEntry')));
  await page.locator('#agentSidebarToggle').click(); await pause(280);
  await page.evaluate(() => { document.querySelector('.agent-resume-name').textContent = 'Learning Transferable Visual Models From Natural Language Supervision — 完整论文标题显示测试'; });
  const box = selector => page.$eval(selector, n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const drag = async (selector, dx, dy) => {
    const r = await box(selector), x = r.x + r.width / 2, y = r.y + r.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up(); await pause(80);
  };
  let beforeSidebar = await box('#agentNav');
  await drag('.agent-resize-x', 90, 0);
  assert.ok(Math.abs((await box('#agentNav')).width - beforeSidebar.width - 90) < 3, 'sidebar follows the drag');
  const sidebarWidth = await page.evaluate(() => Number(localStorage.getItem('reader.agent.sidebarWidth')));
  assert.ok(sidebarWidth > beforeSidebar.width + 80);
  const beforeHeight = await box('.agent-nav-foot');
  await drag('.agent-resize-y', 0, -80);
  assert.ok((await box('.agent-nav-foot')).height > beforeHeight.height + 60, 'bottom reading area grows upwards');
  assert.ok(await page.$eval('.agent-resume-name', n => getComputedStyle(n).whiteSpace === 'normal' && n.scrollWidth <= n.clientWidth + 1));
  await page.evaluate(() => {
    const entry = window.__ctx.addEntry({ block: 'chat', tag: 'answer', text: 'Answer width fixture' });
    entry.body.textContent = 'An answer whose left and right edges remain draggable in Alina. '.repeat(10);
  });
  const answerSelector = '#aiArea .ai-block[data-block="chat"] .msg.assistant';
  await page.waitForSelector(answerSelector, { visible: true });
  const answer = await box(answerSelector), y = answer.y + Math.min(answer.height / 2, 60);
  const rightGripX = answer.x + answer.width + 12;
  await page.mouse.move(rightGripX, y); await pause(50);
  assert.ok(await page.$eval('.text-edge-hint', n => n.classList.contains('on')), 'Alina exposes the existing answer edge grip');
  await page.mouse.down(); await page.mouse.move(rightGripX - 80, y, { steps: 12 }); await page.mouse.up(); await pause(80);
  assert.ok(Math.abs((await box(answerSelector)).width - answer.width + 160) < 4, 'output width tracks a symmetric edge drag');
  await page.screenshot({ path: path.join(scratch, 'alina-adjustable-conversation.png') });
  await page.evaluate(() => document.documentElement.style.setProperty('--agent-scale', '1.6')); await pause(280);
  beforeSidebar = await box('#agentNav');
  await drag('.agent-resize-x', -64, 0);
  assert.ok(Math.abs((await box('#agentNav')).width - beforeSidebar.width + 64) < 4, 'sidebar drag accounts for 160% zoom');
  const zoomAnswer = await box(answerSelector), zoomY = zoomAnswer.y + 55;
  const zoomGripX = zoomAnswer.x + zoomAnswer.width + 12 * 1.6;
  await page.mouse.move(zoomGripX, zoomY); await pause(70);
  const edge = await box('.text-edge-hint');
  assert.ok(Math.abs(edge.x + edge.width / 2 - zoomGripX) < 4, 'output grip stays outside the text edge at 160% zoom');
  await page.evaluate(() => document.documentElement.style.setProperty('--agent-scale', '1')); await pause(280);
  const savedWidth = await page.evaluate(() => Number(localStorage.getItem('reader.agent.sidebarWidth')));
  await page.locator('#agentSidebarToggle').click(); await pause(260);
  await page.locator('#agentSidebarToggle').click(); await pause(260);
  assert.ok(Math.abs((await box('#agentNav')).width - savedWidth) < 2, 'collapse and expand preserve the selected width');
  assert.equal(await page.$eval('#sessBar', n => getComputedStyle(n).display), 'none');
  const oldSid = await page.evaluate(() => window.__ctx.activeSession);
  await page.locator('#agentNavNew').click();
  await page.waitForFunction(old => window.__ctx.activeSession !== old, {}, oldSid);
  await page.screenshot({ path: path.join(scratch, 'alina-entry.png') });
  await page.setViewport({ width: 480, height: 900 }); await pause(150);
  await page.screenshot({ path: path.join(scratch, 'alina-mobile.png') });
  assert.ok(await fullText(), 'small screens wrap every card label: ' + JSON.stringify(await page.$$eval('#agentLaunchActions .agent-launch-copy span', nodes => nodes.map(n => ({ cls: n.className, hidden: n.hidden, width: n.clientWidth, scroll: n.scrollWidth, white: getComputedStyle(n).whiteSpace, overflow: getComputedStyle(n).textOverflow })))));
  for (const selector of ['#agentReadingEntry', '#agentNavNew']) {
    assert.ok(await page.$eval(selector, n => { const r = n.getBoundingClientRect(); return r.width > 30 && r.left >= 0 && r.right <= innerWidth; }));
  }
  await page.setViewport({ width: 1600, height: 1000 }); await pause(100);
  await page.evaluate(() => { document.querySelector('.agent-resume-name').textContent = window.__originalReadingTitle; });
  console.log('PASS Library and Alina show explicit first-open entries; new session stays visible with sidebar collapsed');
  await page.locator('#agentReadingEntry').click();
  await page.waitForFunction(() => window.__viewer?.pdf && !document.body.classList.contains('agent-full') && document.body.classList.contains('reading'));
  await page.evaluate(() => { window.__viewer.setScale(1.3, { keepCenter: false }); window.__viewer._fitMode = false; });
  const before = await page.evaluate(() => ({ scale: window.__viewer.scale, docId: window.__state.doc.docId }));
  await page.locator('#agentBtn').click();
  await page.waitForFunction(() => document.body.classList.contains('agent-full'));
  assert.equal(await page.$eval('#agentReadingEntry .agent-launch-title', n => n.textContent), '回到阅读区');
  await page.locator('#agentReadingEntry').click();
  await page.waitForFunction(() => !document.body.classList.contains('agent-full') && document.body.classList.contains('reading'));
  assert.deepEqual(await page.evaluate(() => ({ scale: window.__viewer.scale, docId: window.__state.doc.docId })), before);
  await page.locator('#homeBtn').click();
  await page.waitForFunction(() => !document.body.classList.contains('reading'));
  assert.equal(await page.$eval('#homeReadingEntry span', n => n.textContent), '回到阅读区');
  assert.equal(await page.$eval('#homeReadingEntry .home-reading-title', n => n.textContent), 'Reading');
  assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('#homeOpen')).backgroundColor !==
    getComputedStyle(document.querySelector('#homeOrganize')).backgroundColor), 'Import is distinct from the secondary organize action');
  await page.locator('#homeReadingEntry').click();
  await page.waitForFunction(() => document.body.classList.contains('reading'));
  assert.deepEqual(await page.evaluate(() => ({ scale: window.__viewer.scale, docId: window.__state.doc.docId })), before);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ctx);
  await page.evaluate(() => window.__ctx.openAgentWorkspace({ landing: true }));
  await pause(400);
  assert.ok(Math.abs((await box('#agentNav')).width - savedWidth) < 2, 'sidebar width survives reload');
  const cardMotion = await page.evaluate(async () => {
    const card = document.getElementById('agentReadingEntry');
    const from = card.getBoundingClientRect();
    const start = { landing: document.body.classList.contains('agent-landing'), collapsed: document.body.classList.contains('agent-nav-collapsed'), parent: card.parentElement.id };
    const pending = window.__ctx.openAgentWorkspace({ landing: false });
    await new Promise(resolve => requestAnimationFrame(resolve));
    const animation = card.getAnimations().find(a => a.effect?.getKeyframes().some(f => String(f.transform).includes('translate(')));
    const visible = card.getBoundingClientRect();
    const result = { animated: !!animation, hit: !!document.elementFromPoint(visible.x + visible.width / 2, visible.y + visible.height / 2)?.closest('#agentReadingEntry'), start, parent: card.parentElement.id, fromX: from.x, transform: animation?.effect.getKeyframes()[0]?.transform };
    await pending; return result;
  });
  assert.ok(cardMotion.animated, 'reading card moves smoothly from the landing canvas to the sidebar: ' + JSON.stringify(cardMotion));
  assert.ok(cardMotion.hit, 'moving reading card stays above both panels');
  await pause(400);
  assert.ok((await box('.agent-nav-foot')).height >= beforeHeight.height + 50, 'reading area height survives reload');
  const readerMotion = await page.evaluate(async () => {
    const cached = !!window.__viewer?.pdf;
    document.getElementById('agentReadingEntry').click();
    for (let frame = 0; frame < 180; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const animated = document.querySelector('.viewer-wrap').getAnimations().some(a => a.effect?.getKeyframes().some(f => String(f.transform).includes('scale(')));
      if (animated) return { animated, frame, cached };
    }
    return { animated: false, cached, body: document.body.className };
  });
  assert.ok(readerMotion.animated, 'return to reader visibly animates as soon as the document is ready: ' + JSON.stringify(readerMotion));
  if (readerMotion.cached) assert.ok(readerMotion.frame < 2, 'cached reader animates on the first frame');
  await page.waitForFunction(() => !document.body.classList.contains('agent-full'));
  assert.deepEqual(errors, []);
  console.log('PASS both entry points switch to Back to reading and preserve the live reader zoom and document; ' + scratch);

} finally { await browser?.close(); await stopChild(reader); }
