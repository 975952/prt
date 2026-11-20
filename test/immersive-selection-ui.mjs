/** Short real mouse drags on freshly rendered and prefetched book pages. */
import { clickReaderTool } from './_reader-controls.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
const desktop = process.argv.includes('--desktop'), inspect = process.argv.includes('--inspect');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'immersive-selection-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, 'Reading.pdf'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser;
try {
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', NO_OPEN: '1', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('immersive-selection').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await pause(100); }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 960 } });
  const page = await browser.newPage(), errors = [], reports = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('reader.locale', 'zh-CN');
    Element.prototype.requestFullscreen = () => Promise.resolve(); document.exitFullscreen = () => Promise.resolve();
  });
  await page.goto(base + '/?open=Reading.pdf&topbar=static', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.pdf && __state.viewerDocId === __state.doc?.docId);
  await clickReaderTool(page, '#immersiveBtn');
  await page.waitForFunction(() => __viewer.immersive && !__viewer._immersiveNavigation);
  await page.evaluate(async () => {
    document.documentElement.dataset.motion = 'off';
    await Promise.all([...__viewer.renderTasks.values()]);
    for (const n of [3,4]) __viewer._teardownPage(n);
    __viewer._schedulePrefetch(0);
  });
  await page.waitForFunction(() => [3,4].every(n => __viewer.rendered.get(n)?.complete && !__viewer.renderTasks.has(n)));
  for (const number of [1,3,4]) {
    await page.evaluate(n => __viewer.goToPage(n), number);
    const geometry = await page.evaluate(n => {
      const v = __viewer, e = v.rendered.get(n), spans = [...e.textDiv.querySelectorAll('span')];
      const span = spans.find(s => s.textContent.includes('Abstract:')) || spans.find(s => s.textContent.length > 40);
      const node = span.firstChild, range = document.createRange();
      const point = offset => { range.setStart(node, offset); range.setEnd(node, offset+1); const r=range.getBoundingClientRect(); return {x:r.left + .1,y:r.top+r.height/2}; };
      return {start:point(3),end:point(14),expected:node.textContent.slice(3,14),hitBoxes:e.hitBoxes?.length||0,text:node.textContent};
    }, number);
    if (!inspect) assert.ok(geometry.hitBoxes > 0, 'visible prefetched page has prepared text hit targets');
    for (const reverse of [false,true]) {
      await page.evaluate(() => {getSelection().removeAllRanges();__state.selection=null;__viewer.paintSelection(null);document.querySelector('#bubble').classList.add('hidden');});
      const start=reverse?geometry.end:geometry.start,end=reverse?geometry.start:geometry.end;
      await page.mouse.move(start.x,start.y);await page.mouse.down();
      await page.mouse.move(end.x,end.y,{steps:8});await page.mouse.up();await pause(180);
      const actual = await page.evaluate(() => ({text:__viewer.getSelectionInfo()?.text, saved:__state.selection?.cleanText,
        page:__viewer.getSelectionInfo()?.page,current:__viewer.current}));
      reports.push({number,reverse,geometry,actual});
      if (!inspect) { assert.equal(actual.text,geometry.expected);assert.equal(actual.saved,geometry.expected);assert.equal(actual.page,number);assert.equal(actual.current,number); }
    }
  }
  // Chromium sometimes gives valid but distant text-node endpoints during a
  // tiny drag over absolute PDF spans. Pointer coordinates must remain authoritative.
  const repaired = await page.evaluate(() => {
    const v=__viewer,e=v.rendered.get(4),spans=[...e.textDiv.querySelectorAll('span')].filter(s=>s.textContent.length>40);
    const node=spans[3].firstChild,range=document.createRange();
    const point=offset=>{range.setStart(node,offset);range.setEnd(node,offset+1);const r=range.getBoundingClientRect();return{x:r.left+.1,y:r.top+r.height/2};};
    const anchor=point(3),focus=point(14),selection=getSelection();
    selection.setBaseAndExtent(node,3,spans.at(-1).firstChild,15);
    const before=v.getSelectionInfo()?.text.length;
    const changed=v.repairSelectionEnds({anchor,focus,allowCollapsed:true});
    return{before,changed,actual:v.getSelectionInfo()?.text,expected:node.textContent.slice(3,14)};
  });
  if (!inspect) {assert.ok(repaired.before>100);assert.equal(repaired.actual,repaired.expected);}
  const wordPoint = await page.evaluate(() => {
    const node = [...__viewer.rendered.get(4).textDiv.querySelectorAll('span')].find(s=>s.textContent.startsWith('Abstract:')).firstChild;
    const r=document.createRange();r.setStart(node,2);r.setEnd(node,3);const b=r.getBoundingClientRect();
    getSelection().removeAllRanges();__state.selection=null;__viewer.paintSelection(null);document.querySelector('#bubble').classList.add('hidden');
    return{x:b.left+b.width/2,y:b.top+b.height/2};
  });
  await page.mouse.click(wordPoint.x,wordPoint.y,{clickCount:2});await pause(180);
  const word = await page.evaluate(()=>__viewer.getSelectionInfo()?.text);
  if(!inspect) assert.equal(word,'Abstract','double click still selects a word');
  const multiline = await page.evaluate(() => {
    getSelection().removeAllRanges();__state.selection=null;__viewer.paintSelection(null);document.querySelector('#bubble').classList.add('hidden');
    const spans=[...__viewer.rendered.get(4).textDiv.querySelectorAll('span')];
    const first=spans.find(s=>s.textContent.startsWith('The model maps')),last=spans.find(s=>s.textContent.startsWith('The encoder'));
    const point=(span,offset)=>{const r=document.createRange();r.setStart(span.firstChild,offset);r.setEnd(span.firstChild,offset+1);const b=r.getBoundingClientRect();return{x:b.left+.1,y:b.top+b.height/2};};
    return{start:point(last,16),end:point(first,4),expected:'model maps queries, keys, and values through scaled dot product attention.\nMulti-head attention allows the model to jointly attend to information.\nThe encoder and '};
  });
  await page.mouse.move(multiline.start.x,multiline.start.y);await page.mouse.down();
  await page.mouse.move(multiline.end.x,multiline.end.y,{steps:12});await page.mouse.up();await pause(180);
  const acrossLines = await page.evaluate(()=>({text:__viewer.getSelectionInfo()?.text,saved:__state.selection?.cleanText}));
  if(!inspect) {assert.equal(acrossLines.text?.trim(),multiline.expected.trim());assert.equal(acrossLines.saved?.trim(),multiline.expected.trim().replace(/\s+/g,' '));}
  fs.writeFileSync(path.join(scratch,'selection.json'),JSON.stringify({reports,repaired,word,multiline,acrossLines},null,2));
  if(inspect) console.log(JSON.stringify({reports,repaired,word,multiline,acrossLines},null,2));assert.deepEqual(errors,[]);
  console.log(`PASS prefetched selections, native word selection and backward multiline drag; ${scratch}`);
}finally{await browser?.close();await stopChild(reader);}
