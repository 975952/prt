/** Real-frame regression for Alina -> reader choreography, using isolated PDFs.
 * node test/agent-spatial-motion.mjs [--desktop]
 * Never starts, stops or focuses a user's application window. */
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
const scratch = fs.mkdtempSync(path.join(SANDBOX, `agent-spatial-motion-${desktop ? 'desktop' : 'node'}-`));
const dataDir = assertIsolatedDataDir(path.join(scratch, 'data')), papersDir = path.join(scratch, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], requestFailures = [], runs = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
assert.ok(executablePath, 'A Chromium browser is available');
function writePdf(name) {
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], ids = [];
  for (let i = 1; i <= 3; i++) {
    const id = objects.length + 1; ids.push(id);
    const content = `BT /F1 20 Tf 60 720 Td (Spatial reading motion - page ${i}) Tj ET\n`
      + Array.from({ length: 27 }, (_, line) => `BT /F1 11 Tf 60 ${675 - line * 18} Td (Synthetic paper content. The page should appear as one stable surface.) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Count 3 /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] >>`;
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(papersDir, name), result, 'utf8');
}
writePdf('motion-a.pdf'); writePdf('motion-b.pdf');
fs.writeFileSync(path.join(papersDir, 'broken.pdf'), 'This is deliberately not a PDF.', 'utf8');
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = { PORT: String(port), PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir,
  PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', PRT_QUIET_TOKEN: '1' };
let reader, browser, page, delayPdf = false, delayedRequests = 0;
const json = async (route, body) => {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
};
const settled = () => page.waitForFunction(() => !window.__state.busy
  && document.querySelector('#rightSide').getAttribute('aria-busy') !== 'true'
  && !document.body.classList.contains('agent-transitioning'));
async function full() {
  await page.evaluate(() => window.__ctx.openAgentWorkspace({ landing: false }));
  await settled();
}
async function picker(name) {
  await page.locator('#agentPapersToggle').click();
  const selector = `button[data-agent-paper="${name}"]`;
  await page.waitForSelector(selector, { visible: true });
  return selector;
}
async function capture(name, trigger, { screenshot = false } = {}) {
  await page.evaluate(name => {
    const box = node => { if (!node?.getClientRects().length) return null; const r = node.getBoundingClientRect();
      let effectiveOpacity = 1; for (let ancestor = node; ancestor instanceof Element; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor); effectiveOpacity *= Number(style.opacity);
        if (style.visibility === 'hidden' || style.display === 'none') effectiveOpacity = 0;
      }
      return { x: r.x, y: r.y, w: r.width, h: r.height, opacity: getComputedStyle(node).opacity,
        effectiveOpacity, transform: getComputedStyle(node).transform, visibility: getComputedStyle(node).visibility }; };
    const record = window.__motionRun = { name, started: performance.now(), frames: [], animations: [], pageRenders: [], stop: false };
    const seenAnimations = new WeakSet();
    const track = animation => {
      if (seenAnimations.has(animation)) return;
      seenAnimations.add(animation);
      const effect = animation.effect, target = effect?.target;
      record.animations.push({ at: performance.now() - record.started,
        target: `${target?.id || target?.className || target?.tagName || ''}${effect?.pseudoElement || ''}`,
        pseudoElement: effect?.pseudoElement || '', animationName: animation.animationName || '',
        frames: effect?.getKeyframes().map(frame => ({ transform: frame.transform, opacity: frame.opacity,
          width: frame.width, height: frame.height, offset: frame.offset })) || [],
        duration: effect?.getTiming().duration, rect: box(target) });
    };
    const original = Element.prototype.animate;
    record.restore = () => { Element.prototype.animate = original; };
    Element.prototype.animate = function (frames, options) {
      const animation = original.call(this, frames, options);
      track(animation);
      return animation;
    };
    record.renderListener = event => record.pageRenders.push({ at: performance.now() - record.started, page: event.detail.page });
    document.addEventListener('pdfview:page-rendered', record.renderListener);
    const frame = () => {
      const current = window.__viewer?.current, entry = window.__viewer?.rendered?.get(current);
      for (const animation of document.documentElement.getAnimations({ subtree: true })) track(animation);
      const viewGroups = ['alina-surface', 'alina-composer', 'alina-messages', 'alina-identity', 'alina-paper', 'alina-outline', 'alina-tabs', 'alina-tools']
        .flatMap(name => ['group', 'old', 'new'].map(part => {
          const pseudo = `::view-transition-${part}(${name})`, style = getComputedStyle(document.documentElement, pseudo);
          return { name, part, animation: style.animationName, transform: style.transform, opacity: style.opacity,
            width: style.width, height: style.height, visibility: style.visibility };
        }));
      record.frames.push({ at: performance.now() - record.started, body: document.body.className,
        phase: document.documentElement.dataset.agentMotion || '', paperReady: document.documentElement.dataset.agentPaperReady === 'true',
        panel: box(document.getElementById('rightSide')),
        composer: box(document.querySelector('#composer .composer-row')), identity: box(document.getElementById('agentIdentity')),
        viewer: box(document.getElementById('viewer')), paper: box(window.__viewer?.pageEls?.[current]),
        sidebar: box(document.getElementById('leftSide')), current,
        rendered: !!entry?.canvas && !entry.dirty && !window.__viewer?.renderTasks?.has(current),
        visibleAnimations: document.documentElement.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running')
          .map(animation => `${animation.effect?.target?.id || animation.effect?.target?.className || ''}${animation.effect?.pseudoElement || ''}:${animation.animationName || ''}`),
        viewGroups,
        overlay: [...document.querySelectorAll('[data-agent-motion], .agent-transition-surface, .agent-motion-surface, .agent-flight')].map(node => ({ target: node.id || node.className, ...box(node) })),
      });
      if (!record.stop) requestAnimationFrame(frame);
    };
    frame();
  }, name);
  const started = Date.now();
  const action = trigger();
  if (screenshot) {
    await wait(130); await page.screenshot({ path: path.join(scratch, `${name}-pressed.png`) });
    await page.waitForFunction(() => document.documentElement.dataset.agentMotion === 'dock'
      && document.body.classList.contains('agent-docked')
      || document.documentElement.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'
        && animation.effect?.target?.id === 'rightSide'), { timeout: 15000, polling: 'raf' });
    await wait(80); await page.screenshot({ path: path.join(scratch, `${name}-moving.png`) });
    await wait(230); await page.screenshot({ path: path.join(scratch, `${name}-arriving.png`) });
  }
  await action; await settled();
  await page.evaluate(async () => { await Promise.allSettled(document.getAnimations().map(animation => animation.finished)); });
  await wait(100);
  const result = await page.evaluate(() => {
    const record = window.__motionRun; record.stop = true; record.restore();
    document.removeEventListener('pdfview:page-rendered', record.renderListener);
    return { name: record.name, frames: record.frames, animations: record.animations, pageRenders: record.pageRenders,
      after: { classes: document.body.className, workspace: window.__ctx.agentWorkspaceState(),
        draft: document.getElementById('chatInput').value, panelTransform: getComputedStyle(document.getElementById('rightSide')).transform,
        motionPhase: document.documentElement.dataset.agentMotion || '',
        activeAnimations: document.getAnimations().filter(animation => animation.playState === 'running').map(animation => animation.effect?.target?.id || animation.effect?.target?.className) } };
  });
  result.elapsed = Date.now() - started; runs.push(result);
  fs.writeFileSync(path.join(scratch, `${name}-frames.json`), JSON.stringify(result, null, 2), 'utf8');
  if (screenshot) await page.screenshot({ path: path.join(scratch, `${name}-settled.png`) });
  return result;
}
function clean(result) {
  assert.ok(!result.after.classes.includes('agent-transitioning'), `${result.name}: transition class released`);
  assert.equal(result.after.motionPhase, '', `${result.name}: snapshot phase released`);
  assert.equal(result.after.panelTransform, 'none', `${result.name}: panel transform cleared`);
  assert.deepEqual(result.after.activeAnimations, [], `${result.name}: no stranded animations`);
}
try {
  reader = desktop ? spawnReader(stageExe('spatial-motion').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) { try { ready = (await fetch(`${base}/api/health`)).ok; } catch {} if (!ready) await wait(100); }
  assert.ok(ready);
  const listing = await json('/api/papers'); assert.equal(path.resolve(listing.dir), path.resolve(papersDir));
  const paperA = listing.papers.find(paper => paper.name === 'motion-a.pdf'), paperB = listing.papers.find(paper => paper.name === 'motion-b.pdf');
  assert.ok(paperA && paperB);
  for (const asset of ['agent-workspace.css', 'agent-motion.css', 'js/agent-motion.js', 'js/agent-workspace.js', 'js/app.js'])
    assert.equal(await fetch(`${base}/${asset}`).then(response => response.text()), fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'));
  await json('/api/session?doc=default&sid=motion-primary', { title: 'Motion continuity', createdAt: Date.now(), updatedAt: Date.now(),
    entries: [{ id: 'motion-user', block: 'chat', kind: 'user', tag: '提问', text: 'Continue from this global conversation.', status: 'user' },
      { id: 'motion-answer', block: 'chat', kind: 'assistant', tag: '问答', text: 'SYNTHETIC_MOTION_CONVERSATION', status: 'complete' }],
    history: [{ role: 'user', content: 'Continue from this global conversation.' }, { role: 'assistant', content: 'SYNTHETIC_MOTION_CONVERSATION' }], ops: [] });
  await json('/api/state', { docs: { [paperA.docId]: { page: 3, fit: true, scale: 1, ts: Date.now(), name: paperA.name } } });
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true,
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(scratch, 'browser') });
  page = await browser.newPage(); await page.setViewport({ width: 1600, height: 960 }); page.setDefaultTimeout(30000);
  await page.setCacheEnabled(false);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) {
      errors.push(`Unexpected external request: ${url.origin}${url.pathname}`); await request.abort(); return;
    }
    if (delayPdf && url.origin === base && url.pathname === '/api/pdf' && url.searchParams.get('path') === 'motion-a.pdf') {
      delayPdf = false; delayedRequests++; await wait(850);
    }
    await request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN'); localStorage.setItem('reader.session.scopeMode', 'paper');
    localStorage.setItem('reader.session.onEnter', 'choose'); localStorage.setItem('reader.session.aiTitle', '0');
  });
  await page.goto(`${base}/?topbar=static`, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !!window.__ctx);
  await full(); await page.evaluate(() => window.__ctx.switchSession('motion-primary')); await settled();
  await page.$eval('#chatInput', input => { input.value = 'UNSENT_MOTION_DRAFT'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const sid = await page.evaluate(() => window.__ctx.activeSession);
  assert.equal(sid, 'motion-primary'); pass('isolated real PDF reader and saved global conversation');
  const source = await picker(paperA.path); delayPdf = true;
  const cold = await capture('cold-delayed', () => page.locator(source).click(), { screenshot: true });
  assert.equal(delayedRequests, 1, 'The cold PDF response was deliberately delayed');
  assert.equal(cold.after.workspace.view, 'docked'); assert.equal(cold.after.workspace.sid, sid);
  assert.equal(cold.after.draft, 'UNSENT_MOTION_DRAFT');
  assert.equal(cold.frames.at(-1).current, 3); clean(cold);
  const finalPaper = cold.frames.at(-1).paper, finalViewer = cold.frames.at(-1).viewer;
  assert.ok(finalPaper && finalViewer && finalPaper.y < finalViewer.y + finalViewer.h
    && finalPaper.y + finalPaper.h > finalViewer.y, 'The restored PDF page is actually visible, not just selected in the page control');
  pass('cold open preserves global conversation, unsent draft and saved PDF page');

  // Choreography assertions are based on user-visible moving surfaces, not timer names.
  const dockFrames = cold.frames.filter(frame => frame.phase === 'dock' && frame.body.includes('agent-docked'));
  const values = (name, part) => dockFrames.flatMap(frame => frame.viewGroups.filter(group => group.name === name && group.part === part));
  const surfaceMotion = values('alina-surface', 'group').filter(group => group.transform && group.transform !== 'none');
  assert.ok(surfaceMotion.length > 2 && new Set(surfaceMotion.map(group => group.transform)).size > 1,
    `The named Alina surface should visibly travel, got ${JSON.stringify(surfaceMotion)}`);
  const paperReveal = values('alina-paper', 'new');
  assert.ok(paperReveal.some(group => /alina-paper-in/.test(group.animation))
    && paperReveal.some(group => Number(group.opacity) < 1 || group.transform !== 'none'), 'PDF has a staged reveal');
  assert.ok(cold.animations.some(animation => animation.target === 'agent-paper-row' && animation.at < 250), 'click/loading gives immediate visible feedback');
  pass('immediate click response, coordinated moving controls and a real PDF reveal');
  const travelFrames = dockFrames.filter(frame => frame.viewGroups.some(group => group.name === 'alina-surface'
    && group.part === 'group' && group.animation !== 'none'));
  assert.ok(travelFrames.at(-1).at - travelFrames[0].at >= 600, 'The surface remains visibly in motion for a readable interval');
  const earlyTravel = travelFrames.filter(frame => frame.at - travelFrames[0].at >= 150 && frame.at - travelFrames[0].at <= 300);
  assert.ok(earlyTravel.length > 1 && earlyTravel.every(frame => frame.viewGroups.some(group => group.name === 'alina-surface'
    && group.part === 'old' && Number(group.opacity) >= .9)), 'The source surface stays visible while it travels, instead of immediately fading away');
  const revealedPaper = travelFrames.filter(frame => frame.viewGroups.some(group => group.name === 'alina-paper'
    && group.part === 'new' && group.animation === 'alina-paper-in' && Number(group.opacity) > .05));
  assert.ok(revealedPaper.length && revealedPaper.every(frame => frame.paperReady), 'The PDF is prepared before its reveal starts');
  pass('720 ms travel preserves the moving surface and reveals only the prepared PDF');

  const readingAnchor = await page.evaluate(async () => {
    window.__viewer._restoreAnchor({ page: 3, frac: .56 });
    await new Promise(resolve => requestAnimationFrame(resolve));
    return window.__viewer._captureAnchor();
  });
  assert.equal(readingAnchor.page, 3);
  assert.ok(Math.abs(readingAnchor.frac - .56) < .01);
  const expand = await capture('expand', () => page.locator('#agentExpand').click());
  assert.equal(expand.after.workspace.view, 'full'); assert.equal(expand.after.workspace.sid, sid); clean(expand);
  pass('reverse expansion preserves the conversation and cleans the animation');
  await page.evaluate(() => document.documentElement.style.setProperty('--agent-scale', '1.3'));
  const again = await picker(paperA.path);
  const zoomed = await capture('same-paper-zoomed', () => page.locator(again).click());
  assert.equal(zoomed.after.workspace.view, 'docked'); assert.equal(zoomed.after.workspace.sid, sid);
  assert.equal(zoomed.frames.at(-1).current, 3); clean(zoomed);
  const restoredAnchor = await page.evaluate(() => window.__viewer._captureAnchor());
  assert.equal(restoredAnchor.page, readingAnchor.page);
  assert.ok(Math.abs(restoredAnchor.frac - readingAnchor.frac) < .01,
    `Same-paper return keeps the actual reading offset: ${JSON.stringify({ readingAnchor, restoredAnchor })}`);
  pass('repeat opening at 130% agent zoom preserves page and final geometry');

  await full(); await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const reducedSource = await picker(paperB.path);
  const reduced = await capture('reduced-motion', () => page.locator(reducedSource).click());
  assert.equal(reduced.after.workspace.view, 'docked');
  assert.ok(!reduced.animations.some(animation => animation.duration > 100 && animation.frames.some(frame => frame.transform && frame.transform !== 'none')),
    'Reduced-motion preference suppresses spatial travel'); clean(reduced);
  pass('reduced-motion mode opens the paper without spatial travel');

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await full();
  await page.evaluate(() => { window.__nativeViewTransition = document.startViewTransition; document.startViewTransition = undefined; });
  const fallbackSource = await picker(paperB.path);
  const fallback = await capture('fallback', () => page.locator(fallbackSource).click());
  assert.equal(fallback.after.workspace.view, 'docked'); assert.equal(fallback.after.workspace.sid, sid); clean(fallback);
  const firstDocked = fallback.frames.find(frame => frame.body.includes('agent-docked'));
  assert.ok(firstDocked?.panel?.transform && firstDocked.panel.transform !== 'none', 'Fallback paints its inverse transform in the first docked frame');
  assert.ok(fallback.animations.some(animation => animation.target === 'rightSide' && animation.duration >= 300));
  await page.evaluate(() => { document.startViewTransition = window.__nativeViewTransition; delete window.__nativeViewTransition; });
  pass('non-View-Transition fallback paints motion before the first docked frame');

  await full(); const failedSource = await picker('broken.pdf');
  const failed = await capture('failed-paper', () => page.locator(failedSource).click());
  assert.equal(failed.after.workspace.view, 'full'); assert.equal(failed.after.workspace.sid, sid);
  assert.equal(failed.after.draft, 'UNSENT_MOTION_DRAFT'); clean(failed);
  assert.ok(await page.$eval('#agentStatus', node => !node.hidden && !!node.textContent));
  pass('failed PDF returns to the full workspace with draft intact and controls unlocked');

  assert.deepEqual(errors, []); pass('no uncaught errors or external service access');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, errors, requestFailures, runs }, null, 2), 'utf8');
  console.log(`agent-spatial-motion: ${checks.length}/${checks.length}; ${scratch}`);
} catch (error) {
  fs.writeFileSync(path.join(scratch, 'failure.txt'), error.stack || String(error), 'utf8');
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ desktop, checks, errors, requestFailures, runs }, null, 2), 'utf8');
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Failure evidence: ${scratch}`); throw error;
} finally { await browser?.close(); await stopChild(reader); }
