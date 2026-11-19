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
const save = () => localStorage.setItem('fixture.records', JSON.stringify(records));
const ui = createTranslationCard({ getRecords:()=>records,
 beforeSelect:()=>{streamVersion++; card.classList.add('hidden'); delete card.dataset.entryId;},
 onCopy:text=>{copied=text;}, onSave:record=>{saved.push(record.id);},
 onDelete:record=>{records=records.filter(row=>row.id!==record.id); save();},
 onStop:record=>{record.status='stopped'; stopped.push(record.id); save();},
 onRetry:record=>{record.status='pending'; record.text=''; save();}, onLocate:()=>{},
 getTargetLanguage:()=>targetLanguage, onTargetLanguageChange:next=>{targetLanguage=next;},
 onCapture:()=>{captureCount++;card.classList.add('hidden');}
});
document.getElementById('translationCardClose').onclick=()=>card.classList.add('hidden');
window.fixture={ui, start(){ const version=++streamVersion; card.dataset.entryId='live';
 document.getElementById('translationCardQuote').textContent='Current streaming passage';
 card.classList.remove('hidden'); ui.resetView(); return version; },
 push(version,text){ if(version===streamVersion) content.textContent=text; },
 complete(text){const row=records.find(row=>row.id==='live');row.text=text;row.status='complete';save();ui.refresh();},
 state:()=>({copied,saved,stopped,ids:records.map(row=>row.id),version:streamVersion,targetLanguage,captureCount}), save };
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
  assert.ok(await page.$eval('#translationCard',node=>node.classList.contains('hidden')));
  await page.evaluate(()=>window.fixture.ui.openHistory());
  const version=await page.evaluate(()=>window.fixture.start());
  await page.evaluate(version=>window.fixture.push(version,'Streaming partial'),version);
  await page.waitForFunction(()=>!document.getElementById('translationCardStop').hidden);
  await page.click('#translationCardHistory');
  await page.$$eval('.reading-card-history-row', nodes=>nodes[1].click());
  assert.equal(await page.$eval('#translationCardText',node=>node.textContent),'Previously saved translation');
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
  await page.click('#translationCardRetry'); await page.waitForFunction(()=>!document.getElementById('translationCardStop').hidden);
  await page.click('#translationCardStop');
  assert.deepEqual(await page.evaluate(()=>window.fixture.state().stopped),['live']);
  await page.click('#translationCardDelete');
  assert.deepEqual(await page.evaluate(()=>window.fixture.state().ids),['old']);
  assert.equal(await page.$$eval('.reading-card-history-row',nodes=>nodes.length),1);
  await page.$$eval('.reading-card-history-row',nodes=>nodes[0].click());
  await page.screenshot({path:path.join(scratch,'translation-card-dark.png')});
  await page.setViewport({width:400,height:700});
  await page.screenshot({path:path.join(scratch,'translation-card-narrow.png')});
  assert.ok(await page.$eval('#translationCard',node=>node.scrollWidth<=node.clientWidth+1));
  assert.deepEqual(errors,[]);
  console.log('PASS target language and capture actions, saved-history browsing, stream ownership, copy/note/retry/stop/delete, reload retention and narrow card layout');
  console.log(scratch);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
