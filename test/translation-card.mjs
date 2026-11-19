/** Isolated view regression; synthetic translations only, no reader data or model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX } from './_env.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'translation-card-'));
const sourceHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const start = sourceHtml.indexOf('<div class="translation-card hidden"');
const end = sourceHtml.indexOf('<!-- 参考文献 -->', start);
assert.ok(start > 0 && end > start);
const fixture = `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/reading-cards.css"></head><body>
${sourceHtml.slice(start, end)}<script type="module">
import { createTranslationCard } from '/js/translation-card.js';
localStorage.setItem('reader.locale', 'zh-CN');
const initial = [
 { id:'old', block:'translate', docId:'fixture', page:2, quote:'Older complete passage', text:'Previously saved translation', status:'complete', retry:{text:'Older complete passage'} },
 { id:'live', block:'translate', docId:'fixture', page:4, quote:'Current streaming passage', text:'', status:'pending', retry:{text:'Current streaming passage'} }
];
let records = JSON.parse(localStorage.getItem('fixture.records') || 'null') || initial;
const card = document.getElementById('translationCard'), content = document.getElementById('translationCardText');
let streamVersion = 0, copied = '', saved = [], stopped = [], targetLanguage = '中文', captureCount = 0;
let documentKey = 'fixture', inputSequence = 0, launchError = false;
const inputJobs = [];
const save = () => localStorage.setItem('fixture.records', JSON.stringify(records));
const ui = createTranslationCard({ getRecords:()=>records.filter(row=>row.docId===documentKey), getDocumentKey:()=>documentKey,
 beforeSelect:()=>{streamVersion++; card.classList.add('hidden'); delete card.dataset.entryId;},
 onCopy:text=>{copied=text;}, onSave:record=>{saved.push(record.id);},
 onDelete:record=>{records=records.filter(row=>row.id!==record.id); save();},
 onStop:record=>{record.status='stopped'; stopped.push(record.id); save();},
 onRetry:record=>{record.status='pending'; record.text=''; save();}, onLocate:()=>{},
 getTargetLanguage:()=>targetLanguage, onTargetLanguageChange:next=>{targetLanguage=next;},
 onCapture:()=>{captureCount++;},
 onTranslate:async({text,targetLang,images,passages=[]})=>{
   await Promise.resolve();
   if(launchError){launchError=false;throw new Error('Fixture launch failed');}
   const record={id:'input-'+(++inputSequence),block:'translate',docId:documentKey,page:0,quote:text,text:'',status:'pending',retry:{text}};
   records.push(record);save();ui.select(record);
   return new Promise(resolve=>inputJobs.push({text,targetLang,images,passages,record,resolve}));
 }
});
document.getElementById('translationCardClose').onclick=()=>card.classList.add('hidden');
window.fixture={ui, start(){ const version=++streamVersion; card.dataset.entryId='live';
 document.getElementById('translationCardQuote').textContent='Current streaming passage';
 card.classList.remove('hidden'); ui.resetView(); return version; },
 push(version,text){ if(version===streamVersion) content.textContent=text; },
 complete(text){const row=records.find(row=>row.id==='live');row.text=text;row.status='complete';save();ui.refresh();},
 switchDocument(key){documentKey=key;ui.open();}, failLaunch(){launchError=true;},
 finishInput(status='complete',recovery={}){
   const job=inputJobs.findLast(row=>row.resolve);if(!job)throw new Error('No pending input');
   job.record.status=status;job.record.text=status==='complete'?'Translated: '+job.text:'';save();ui.refresh();
   job.resolve({status,...recovery});job.resolve=null;
 },
 state:()=>({copied,saved,stopped,ids:records.map(row=>row.id),version:streamVersion,targetLanguage,captureCount,
   jobs:inputJobs.map(({text,targetLang,images,record})=>({text,targetLang,images,id:record.id,status:record.status})),
   passageJobs:inputJobs.map(({passages})=>passages)}), save };
ui.openHistory();
</script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(fixture); return; }
  const filename = path.join(ROOT, 'public', decodeURIComponent(url.pathname));
  if (!filename.startsWith(path.join(ROOT,'public') + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'Content-Type': filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream'});
  fs.createReadStream(filename).pipe(res);
});
let browser;
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await puppeteer.launch({executablePath:process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless:true,pipe:true,args:['--no-sandbox','--disable-gpu'],defaultViewport:{width:1100,height:900}});
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(base,{waitUntil:'networkidle0'}); await page.waitForFunction(()=>window.fixture);
  assert.equal(await page.$$eval('.reading-card-history-row',nodes=>nodes.length),2);
  await page.select('#translationCardLanguage','English');
  assert.equal(await page.evaluate(()=>window.fixture.state().targetLanguage),'English');
  await page.click('#translationCardCapture');
  assert.equal(await page.evaluate(()=>window.fixture.state().captureCount),1);
  assert.ok(await page.$eval('#translationCard',node=>!node.classList.contains('hidden')), 'capture delegates visibility to the capture lifecycle');
  await page.evaluate(()=>window.fixture.ui.openHistory());
  const version=await page.evaluate(()=>window.fixture.start());
  await page.evaluate(version=>window.fixture.push(version,'Streaming partial'),version);
  await page.waitForFunction(()=>!document.getElementById('translationCardStop').hidden);
  await page.click('#translationCardHistory');
  await page.$$eval('.reading-card-history-row', nodes=>nodes[1].click());
  assert.equal(await page.$eval('#translationCardText',node=>node.textContent),'Previously saved translation');
  assert.equal(await page.$eval('#translationCardOriginal',node=>node.hidden),false, 'the original is open by default');
  await page.click('#translationCardOriginalToggle');
  assert.ok(await page.$eval('#translationCardOriginal',node=>node.hidden));
  assert.equal(await page.$eval('#translationCardQuote',node=>node.textContent),'Older complete passage');
  await page.click('#translationCardHistory');
  await page.$$eval('.reading-card-history-row', nodes=>nodes[0].click());
  assert.ok(await page.$eval('#translationCardOriginal',node=>node.hidden), 'the closed preference survives selecting another translation');
  await page.click('#translationCardHistory');
  await page.$$eval('.reading-card-history-row', nodes=>nodes[1].click());
  assert.ok(await page.$eval('#translationCardOriginal',node=>node.hidden), 'the closed preference survives returning to a translation');
  await page.click('#translationCardOriginalToggle');
  assert.equal(await page.$eval('#translationCardOriginal',node=>node.hidden),false);
  await page.evaluate(version=>window.fixture.push(version,'Late streaming output must stay elsewhere'),version);
  assert.equal(await page.$eval('#translationCardText',node=>node.textContent),'Previously saved translation');
  await page.click('#translationCardCopy'); await page.click('#translationCardSave');
  assert.deepEqual(await page.evaluate(()=>({copied:window.fixture.state().copied,saved:window.fixture.state().saved})),
    {copied:'Previously saved translation',saved:['old']});
  await page.click('#translationCardClose');
  await page.evaluate(()=>window.fixture.ui.openHistory());
  assert.equal(await page.$$eval('.reading-card-history-row',nodes=>nodes.length),2);
  await page.$$eval('.reading-card-history-row',nodes=>nodes[0].click());
  await page.evaluate(()=>window.fixture.complete('Completed and persisted translation'));
  assert.equal(await page.$eval('#translationCardText',node=>node.textContent),'Completed and persisted translation');
  await page.reload({waitUntil:'networkidle0'}); await page.waitForFunction(()=>window.fixture);
  assert.equal(await page.$$eval('.reading-card-history-row',nodes=>nodes.length),2);
  await page.$$eval('.reading-card-history-row',nodes=>nodes[0].click());
  assert.equal(await page.$eval('#translationCardText',node=>node.textContent),'Completed and persisted translation');
  assert.equal(await page.$eval('#translationCardOriginal',node=>node.hidden),false, 'the open preference survives reload');
  await page.click('#translationCardOriginalToggle');
  assert.ok(await page.$eval('#translationCardOriginal',node=>node.hidden));
  await page.reload({waitUntil:'networkidle0'}); await page.waitForFunction(()=>window.fixture);
  await page.$$eval('.reading-card-history-row',nodes=>nodes[0].click());
  assert.ok(await page.$eval('#translationCardOriginal',node=>node.hidden), 'the closed preference survives reload');
  await page.click('#translationCardOriginalToggle');
  await page.click('#translationCardRetry'); await page.waitForFunction(()=>!document.getElementById('translationCardStop').hidden);
  await page.click('#translationCardStop');
  assert.deepEqual(await page.evaluate(()=>window.fixture.state().stopped),['live']);
  await page.click('#translationCardDelete');
  assert.deepEqual(await page.evaluate(()=>window.fixture.state().ids),['old']);
  assert.equal(await page.$$eval('.reading-card-history-row',nodes=>nodes.length),1);
  await page.$$eval('.reading-card-history-row',nodes=>nodes[0].click());
  await page.evaluate(()=>{
    const card=document.getElementById('translationCard');card.style.left='80px';card.style.top='90px';card.style.right='auto';
    card.style.width='440px';card.style.height='560px';window.originalTranslationContent=document.getElementById('translationCardText');
    window.fixture.ui.open();
  });
  assert.equal(await page.$eval('#translationCard',node=>node.dataset.cardView),'translation');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'translationCardInput');
  await page.select('#translationCardLanguage','English');
  await page.type('#translationCardInput','First sentence');
  await page.keyboard.down('Shift');await page.keyboard.press('Enter');await page.keyboard.up('Shift');
  await page.keyboard.type('Second line');
  await page.$eval('#translationCardInput',node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})));
  assert.equal(await page.evaluate(()=>window.fixture.state().jobs.length),0);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.fixture.state().jobs.length===1);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'translationCardInput');
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'');
  assert.ok(await page.$eval('#translationCardSubmit',node=>node.disabled));
  await page.type('#translationCardInput','Translate again in this card');
  await page.evaluate(()=>window.fixture.finishInput());
  await page.waitForFunction(()=>!document.getElementById('translationCardSubmit').disabled);
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'Translate again in this card');
  assert.deepEqual(await page.evaluate(()=>window.fixture.state().jobs[0]),
    {text:'First sentence\nSecond line',targetLang:'English',images:[],id:'input-1',status:'complete'});
  await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');
  await page.waitForFunction(()=>window.fixture.state().jobs.length===2);
  assert.equal(await page.$eval('#translationCard',node=>node.dataset.entryId),'input-2');
  assert.deepEqual(await page.$eval('#translationCard',node=>({left:node.style.left,top:node.style.top,width:node.style.width,height:node.style.height})),
    {left:'80px',top:'90px',width:'440px',height:'560px'});
  assert.ok(await page.evaluate(()=>document.getElementById('translationCardText')===window.originalTranslationContent));
  await page.click('#translationCardHistory');
  assert.equal(await page.$$eval('.reading-card-history-row',nodes=>nodes.length),3);
  assert.ok(await page.$eval('#translationCardInput',node=>node.getBoundingClientRect().height>0));
  await page.$$eval('.reading-card-history-row',nodes=>nodes[nodes.length-1].click());
  await page.evaluate(()=>window.fixture.finishInput());
  assert.equal(await page.$eval('#translationCardText',node=>node.textContent),'Previously saved translation');
  await page.type('#translationCardInput','Keep this draft');
  await page.click('#translationCardClose');await page.evaluate(()=>window.fixture.ui.open());
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'Keep this draft');
  await page.evaluate(()=>window.fixture.switchDocument('other'));
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'');
  assert.equal(await page.$eval('#translationCardText',node=>node.textContent),'');
  await page.type('#translationCardInput','Other document draft');
  await page.evaluate(()=>window.fixture.switchDocument('fixture'));
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'Keep this draft');
  await page.evaluate(()=>window.fixture.failLaunch());
  await page.click('#translationCardSubmit');
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'Keep this draft');
  assert.equal(await page.$eval('.reading-card-status',node=>node.textContent),'Fixture launch failed');
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===3);
  await page.evaluate(()=>window.fixture.finishInput('failed'));
  await page.waitForFunction(()=>!document.getElementById('translationCardSubmit').disabled);
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'Keep this draft');
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===4);
  await page.type('#translationCardInput','A newer draft');
  await page.evaluate(()=>window.fixture.finishInput('failed'));
  await page.waitForFunction(()=>!document.getElementById('translationCardSubmit').disabled);
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'A newer draft');
  await page.evaluate(()=>window.fixture.switchDocument('other'));
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'Other document draft');
  await page.evaluate(()=>window.fixture.switchDocument('fixture'));
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===5);
  await page.evaluate(()=>window.fixture.finishInput());
  await page.waitForFunction(()=>document.getElementById('translationCardInput').getAttribute('aria-busy')==='false');
  const addShot = label => page.evaluate(label => window.fixture.ui.addCapture({
    shot:{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',width:1,height:1},page:3,label,
  }), label);
  const beforeShot = await page.evaluate(() => ({text:document.getElementById('translationCardText').textContent,version:window.fixture.state().version}));
  await addShot('First screenshot');
  assert.equal(await page.$$eval('#translationCardAttachments img',nodes=>nodes.length),1);
  assert.deepEqual(await page.evaluate(() => ({text:document.getElementById('translationCardText').textContent,version:window.fixture.state().version})),beforeShot,
    'attaching a screenshot preserves existing result and stream ownership');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'translationCardInput');
  assert.ok(await page.evaluate(()=>document.getElementById('translationCardText')===window.originalTranslationContent));
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===6);
  const imageOnly = await page.evaluate(()=>window.fixture.state().jobs[5]);
  assert.equal(imageOnly.text,'');assert.equal(imageOnly.images.length,1);assert.equal(imageOnly.images[0].label,'First screenshot');
  assert.equal(await page.$$eval('#translationCardAttachments img',nodes=>nodes.length),0);
  await addShot('New screenshot');await page.type('#translationCardInput','New text draft');
  await page.evaluate(()=>window.fixture.finishInput('failed'));
  await page.waitForFunction(()=>document.getElementById('translationCardInput').getAttribute('aria-busy')==='false');
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'New text draft');
  assert.deepEqual(await page.$$eval('#translationCardAttachments img',nodes=>nodes.map(node=>node.alt)),['First screenshot','New screenshot']);
  await page.click('.reading-card-attachment .reading-card-action');
  assert.deepEqual(await page.$$eval('#translationCardAttachments img',nodes=>nodes.map(node=>node.alt)),['New screenshot']);
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===7);
  assert.equal(await page.evaluate(()=>window.fixture.state().jobs[6].text),'New text draft');
  await page.evaluate(()=>window.fixture.finishInput('stopped'));
  await page.waitForFunction(()=>document.getElementById('translationCardInput').getAttribute('aria-busy')==='false');
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'New text draft');
  assert.equal(await page.$$eval('#translationCardAttachments img',nodes=>nodes.length),1);
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===8);
  await page.evaluate(()=>window.fixture.switchDocument('other'));
  await page.evaluate(()=>window.fixture.finishInput('failed'));
  await page.waitForFunction(()=>document.getElementById('translationCardInput').getAttribute('aria-busy')==='false');
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'Other document draft');
  assert.equal(await page.$$eval('#translationCardAttachments img',nodes=>nodes.length),0);
  await page.evaluate(()=>window.fixture.switchDocument('fixture'));
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'New text draft');
  assert.equal(await page.$$eval('#translationCardAttachments img',nodes=>nodes.length),1);
  await addShot('Remaining screenshot');
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===9);
  await page.evaluate(()=>window.fixture.finishInput('failed',{remainingText:'',remainingImages:window.fixture.state().jobs[8].images.slice(1)}));
  await page.waitForFunction(()=>document.getElementById('translationCardInput').getAttribute('aria-busy')==='false');
  assert.equal(await page.$eval('#translationCardInput',node=>node.value),'');
  assert.deepEqual(await page.$$eval('#translationCardAttachments img',nodes=>nodes.map(node=>node.alt)),['Remaining screenshot']);
  await page.evaluate(() => window.fixture.ui.addPassages([
    { id: 'passage-1', text: 'First queued passage', page: 3, docId: 'fixture' },
    { id: 'passage-2', text: 'Second queued passage', page: 4, docId: 'fixture' },
  ]));
  assert.equal(await page.$$eval('#translationCardPassages .reading-card-passage',nodes=>nodes.length),2);
  assert.equal(await page.evaluate(()=>window.fixture.state().jobs.length),9,'adding passages sends no model request');
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===10);
  assert.deepEqual(await page.evaluate(()=>window.fixture.state().passageJobs[9].map(({text,page})=>({text,page}))),[
    {text:'First queued passage',page:3},{text:'Second queued passage',page:4},
  ]);
  await page.evaluate(()=>window.fixture.finishInput());
  await page.waitForFunction(()=>document.getElementById('translationCardInput').getAttribute('aria-busy')==='false');
  assert.equal(await page.$$eval('#translationCardPassages .reading-card-passage',nodes=>nodes.length),0,
    'successful submission clears only the submitted passages');
  await page.evaluate(() => window.fixture.ui.addPassages([
    { id: 'recover-1', text: 'Submitted passage', page: 5, docId: 'fixture' },
    { id: 'recover-2', text: 'Unfinished passage', page: 6, docId: 'fixture' },
  ]));
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===11);
  await page.evaluate(()=>window.fixture.finishInput('stopped',{remainingPassages:window.fixture.state().passageJobs[10].slice(1)}));
  await page.waitForFunction(()=>document.getElementById('translationCardInput').getAttribute('aria-busy')==='false');
  assert.deepEqual(await page.$$eval('#translationCardPassages .reading-card-passage-text',nodes=>nodes.map(node=>node.title)),
    ['Unfinished passage'],'stopped batches restore only the passages that were not completed');
  await page.click('#translationCardSubmit');await page.waitForFunction(()=>window.fixture.state().jobs.length===12);
  assert.deepEqual(await page.evaluate(()=>window.fixture.state().passageJobs[11].map(({text})=>text)),['Unfinished passage']);
  await page.evaluate(()=>window.fixture.finishInput());
  await page.waitForFunction(()=>document.getElementById('translationCardInput').getAttribute('aria-busy')==='false');
  await page.screenshot({path:path.join(scratch,'translation-card-dark.png')});
  await page.setViewport({width:400,height:700});
  await page.$eval('#translationCard',node=>{node.style.left='12px';node.style.top='60px';node.style.width='';node.style.height='';});
  await page.screenshot({path:path.join(scratch,'translation-card-narrow.png')});
  assert.ok(await page.$eval('#translationCard',node=>node.scrollWidth<=node.clientWidth+1));
  assert.ok(await page.$eval('#translationCard',node=>node.scrollHeight<=node.clientHeight+1));
  assert.deepEqual(errors,[]);
  console.log('PASS direct and screenshot translation, editable pending drafts, partial failure/cancel recovery, document-owned screenshots, IME/newline controls, stable card identity/position, history/stream ownership, copy/note/retry/stop/delete, reload retention and narrow card layout');
  console.log(scratch);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
