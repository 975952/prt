/** Focused history UI checks with synthetic in-memory sessions, no real data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX } from './_env.mjs';

const executablePath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
assert.ok(executablePath, 'Chromium is available');
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'session-history-ui-'));
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/session-move.css">
<link rel="stylesheet" href="/session-history.css"><style>
body { display:block; padding:24px; overflow:auto; }
#rightSide { position:relative; display:flex; flex-direction:column; width:410px; height:630px; min-width:0; }
#sessBar { flex:0 0 auto; height:32px; } #aiArea { min-height:200px; }
#outside { position:fixed; left:520px; top:24px; }
</style></head><body class="reading"><button id="outside">Outside</button>
<aside class="side right" id="rightSide"><div id="sessBar"><button id="sessBtn"><span id="sessLabel"></span></button>
<span id="sessDot"></span><button id="sessNew">New</button><button id="sessHist">History</button></div>
<div id="sessQuickPop" class="hidden"></div><div id="sessHistory" class="sess-history hidden"></div><div id="aiArea" class="ai"></div></aside>
<script type="module">
localStorage.setItem('reader.locale','en');
const api = await import('/js/sessions.js');
const stamp = Date.now();
const papers = [{docId:'paper-alpha',name:'Alpha paper',folder:'vision',path:'vision/alpha.pdf'},
  {docId:'paper-beta',name:'Beta paper',folder:'math',path:'math/beta.pdf'}];
const rows = [
  {sid:'global-main',fileKey:'default',title:'Global reading conversation',count:12,updatedAt:stamp,docIds:['paper-alpha','paper-beta'],docTitles:['Alpha paper','Beta paper'],folderPath:'vision'},
  {sid:'global-other',fileKey:'__global__',title:'Older global conversation',count:4,updatedAt:stamp-86400000,docIds:['paper-beta'],docTitles:['Beta paper']},
  {sid:'folder-main',fileKey:'folder-vision',title:'Folder conversation',count:6,updatedAt:stamp,docIds:['paper-alpha'],docTitles:['Alpha paper'],folderPath:'vision'},
  {sid:'paper-main',fileKey:'paper-alpha',title:'Paper conversation',count:2,updatedAt:stamp,docIds:['paper-alpha'],docTitles:['Alpha paper'],folderPath:'vision'},
];
let mode = 'global', empty = false;
const currentKey = () => mode === 'global' ? 'default' : mode === 'folder' ? 'folder-vision' : 'paper-alpha';
const accepted = row => mode === 'global' ? ['default','__global__'].includes(row.fileKey) : row.fileKey === currentKey();
window.calls = [];
window.fetch = async (input, options = {}) => {
  const url = new URL(input,location.href), method = options.method || 'GET';
  window.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body:options.body});
  if(url.pathname === '/api/sessions') {
    const doc = url.searchParams.get('doc');
    const selected = empty ? [] : rows.filter(row => url.searchParams.get('scope') === 'all' || row.fileKey === doc);
    return Response.json({sessions:selected});
  }
  const row = rows.find(row => row.sid === url.searchParams.get('sid') && row.fileKey === url.searchParams.get('doc'));
  if(method === 'PATCH' && row) { Object.assign(row,JSON.parse(options.body)); return Response.json({session:row}); }
  if(method === 'DELETE' && row) { rows.splice(rows.indexOf(row),1); return Response.json({ok:true}); }
  return Response.json({error:'Unexpected fixture request'},{status:400});
};
const ctx = {
  deleteSession: async (sid, doc) => (await fetch('/api/session?' + new URLSearchParams({ sid, doc, copies:'1' }), {method:'DELETE'})).ok,
  hasDoc: () => true, isAgentWorkspace: () => mode === 'global', scopeMode: () => mode,
  scopeKey: currentKey, folderPath: () => 'vision', folderKey: () => 'folder-vision', folderKeyOf: value => 'folder-'+value,
  doc: () => mode === 'global' ? null : papers[0], currentSid: () => mode+'-main',
  acceptSessionRow: accepted, isScopeFileKey: key => key === currentKey(), papers: () => papers, folders: () => ['vision','math'],
  isBusy: () => false, renderAi: () => {}, showChatAndRender: () => {}, followCurrentSession: () => {},
  openSessionFromHistory: async (row,options) => {window.opened = {sid:row.sid,fileKey:row.fileKey,options};},
  describeSessionScope: row => row.fileKey === 'default' || row.fileKey === '__global__' ? {mode:'global'}
    : row.fileKey.startsWith('folder-') ? {mode:'folder',folderPath:row.folderPath} : {mode:'paper',docId:row.fileKey},
  moveSession: async (row,target) => {
    window.moved = {sid:row.sid,source:row.fileKey,target};
    const source = rows.find(value => value.sid === row.sid && value.fileKey === row.fileKey);
    source.fileKey = target.mode === 'global' ? 'default' : target.mode === 'folder' ? 'folder-'+target.folderPath : target.docId;
    source.folderPath = target.folderPath;
  },
};
api.initSessions(ctx);
window.setScope = async next => { mode = next; empty = false; await api.sessionsOpenWorkspace({choose:false}); api.sessionsShortcutHistory(); };
window.setEmpty = async () => {empty=true; await api.sessionsOnSessionChanged({refresh:true});};
window.setHistoryMode = value => api.sessionsSetHistoryMode(value);
window.closeOverlays = () => api.sessionsCloseOverlays();
await window.setScope('global');
window.ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
  const publicDir = path.join(ROOT, 'public'), target = path.resolve(publicDir, `.${decodeURIComponent(url.pathname)}`);
  if (!target.startsWith(publicDir + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(target));
});
let browser;
const checks = [], errors = [], failed = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await puppeteer.launch({ executablePath, headless:true, args:['--no-sandbox','--disable-gpu'], userDataDir:path.join(scratch,'browser') });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('requestfailed', request => failed.push(request.url()));
  await page.setViewport({width:1200,height:900});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready && document.querySelectorAll('.sess-hrow').length === 2);
  const row = sid => `.sess-hrow[data-sid="${sid}"]`;
  const more = sid => `${row(sid)} .sess-hmore`;
  const menu = '.sess-row-menu';
  const open = async (sid='global-main') => { await page.click(more(sid)); await page.waitForSelector(menu,{visible:true}); };
  const closed = () => page.waitForFunction(() => !document.querySelector('.sess-row-menu'));
  assert.deepEqual(await page.$$eval('.sess-hrow', nodes => nodes.map(node=>node.dataset.sid)), ['global-main','global-other']);
  assert.equal(await page.$eval('.sess-arrange-chips', node=>node.hidden),true);
  assert.equal(await page.$eval('#sessHistMemory', node=>node.hidden),true);
  assert.equal(await page.$('.sess-htrail'),null);
  assert.equal(await page.$eval(`${row('global-main')} .sess-hmeta`,node=>node.textContent),'Just now');
  assert.equal(await page.$eval(`${row('global-main')} .sess-hgo`,node=>node.getAttribute('aria-current')),'true');
  pass('global history contains only global rows, title/date, and contextual controls');

  await open();
  assert.equal(await page.$$eval(`${menu} [role="menuitem"]`,nodes=>nodes.length),5);
  assert.equal(await page.$eval(more('global-main'),node=>node.getAttribute('aria-expanded')),'true');
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('pin')),true);
  await page.evaluate(()=>{window.menuReaderKeys=[];document.addEventListener('keydown',event=>{if(['PageDown','PageUp','r','q','e','t'].includes(event.key))window.menuReaderKeys.push(event.key);});});
  for (const key of ['PageDown','PageUp','r','q','e','t']) await page.keyboard.press(key);
  assert.deepEqual(await page.evaluate(()=>window.menuReaderKeys),[]);
  pass('ordinary menu keys cannot trigger PDF navigation or selection shortcuts');
  for (const [key,cls] of [['End','danger'],['Home','pin'],['ArrowUp','danger'],['ArrowDown','pin']]) {
    await page.keyboard.press(key); assert.equal(await page.evaluate(cls=>document.activeElement.classList.contains(cls),cls),true);
  }
  await page.keyboard.press('Escape'); await closed();
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('sess-hmore')),true);
  assert.equal(await page.$eval('#sessHistory',node=>node.classList.contains('hidden')),false);
  pass('menu exposes five named actions and supports arrows, Home, End and Escape');
  await page.keyboard.press('Space'); await page.waitForSelector(menu,{visible:true});
  await page.keyboard.press('Tab'); await closed();
  assert.equal(await page.evaluate(()=>document.activeElement.closest('.sess-hrow')?.dataset.sid),'global-other');
  pass('Space opens and Tab leaves the menu in document order');

  await open(); await page.click('#outside'); await closed();
  await open(); await page.$eval('#sessHistList',node=>node.dispatchEvent(new Event('scroll'))); await closed();
  await open(); await page.setViewport({width:1220,height:900}); await closed();
  await page.evaluate(()=>document.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key==='=')window.zoomShortcutDelivered=!event.defaultPrevented;}));
  await open(); await page.keyboard.down('Control'); await page.keyboard.press('Equal'); await page.keyboard.up('Control'); await closed();
  assert.equal(await page.evaluate(()=>window.zoomShortcutDelivered),true);
  assert.equal(await page.$eval('#sessHistory',node=>node.classList.contains('hidden')),false);
  pass('outside click, scrolling, resizing and zoom shortcuts close only the menu');

  await open(); await page.keyboard.press('Enter'); await closed();
  await page.waitForFunction(()=>window.calls.some(call=>call.method==='PATCH'&&call.body==='{"pinned":true}'));
  await page.waitForFunction(()=>document.querySelector('.sess-group-label')?.textContent==='Pin'
    &&document.activeElement.classList.contains('sess-hmore'));
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('sess-hmore')),true);
  await open(); assert.equal(await page.$eval(`${menu} .pin`,node=>node.textContent),'Unpin');
  await page.click(`${menu} .rename`); await page.waitForSelector('.sess-rename-input',{visible:true});
  await page.waitForFunction(()=>document.activeElement.classList.contains('sess-rename-input'));
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.sess-rename-input'),null);
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('sess-hmore')),true);
  assert.equal(await page.$eval('#sessHistory',node=>node.classList.contains('hidden')),false);
  await page.focus(more('global-main')); await page.keyboard.press('F2'); await page.waitForSelector('.sess-rename-input');
  await page.waitForFunction(()=>document.activeElement.classList.contains('sess-rename-input'));
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await page.keyboard.type('Renamed conversation'); await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.sess-hrow[data-sid="global-main"] .sess-htitle')?.textContent==='Renamed conversation');
  pass('pin and rename persist through the original API; Escape cancels rename and F2 works');

  await open(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
  await page.waitForFunction(()=>!document.querySelector('.sess-hrow[data-sid="global-main"]')&&!!document.querySelector('.sess-group-btn'));
  await page.click('.sess-group-btn'); await page.waitForSelector(more('global-main'));
  await open(); assert.equal(await page.$eval(`${menu} .archive`,node=>node.textContent),'Unarchive');
  await page.click(`${menu} .archive`);
  await page.waitForFunction(()=>!!document.querySelector('.sess-hrow[data-sid="global-main"]')&&!document.querySelector('.sess-group-btn'));
  await open(); await page.click(`${menu} .danger`);
  await page.waitForSelector('.sess-confirm-mask:not(.hidden)',{visible:true});
  await page.click('.sess-confirm-btn.ghost');
  await page.waitForFunction(()=>document.querySelector('.sess-confirm-mask').classList.contains('hidden')&&document.activeElement.classList.contains('sess-hmore'));
  assert.ok(await page.$(row('global-main')));
  pass('archive/unarchive preserve the conversation and delete cancellation restores focus');

  await open(); await page.click(`${menu} .move`); await page.waitForSelector('#sessMoveLayer:not([hidden])',{visible:true});
  await page.waitForFunction(()=>!document.querySelector('#sessMoveMode').disabled);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('sess-hmore')),true);
  await open(); await page.click(`${menu} .move`); await page.waitForFunction(()=>!document.querySelector('#sessMoveMode').disabled);
  await page.select('#sessMoveMode','paper'); await page.select('#sessMoveTarget','paper-beta'); await page.click('#sessMoveSubmit');
  await page.waitForFunction(()=>window.moved?.target.docId==='paper-beta'&&!document.querySelector('.sess-hrow[data-sid="global-main"]'));
  assert.equal(await page.evaluate(()=>window.moved.source),'default');
  pass('scope conversion remains available and uses the original storage owner');

  await page.evaluate(()=>window.setScope('folder')); await page.waitForSelector(more('folder-main'));
  assert.deepEqual(await page.$$eval('.sess-hrow',nodes=>nodes.map(node=>node.dataset.sid)),['folder-main']);
  await page.evaluate(()=>window.setHistoryMode('file')); await page.waitForSelector('.sess-filegroup');
  assert.equal(await page.$eval('.sess-filegroup-name',node=>node.textContent),'Alpha paper');
  await page.click(`${row('folder-main')} .sess-hgo`);
  assert.deepEqual(await page.evaluate(()=>window.opened),{sid:'folder-main',fileKey:'folder-vision',options:{force:false,docIdHint:'paper-alpha'}});
  await page.evaluate(()=>window.setScope('paper')); await page.waitForSelector(more('paper-main'));
  assert.deepEqual(await page.$$eval('.sess-hrow',nodes=>nodes.map(node=>node.dataset.sid)),['paper-main']);
  pass('folder and paper history preserve filtering, file grouping and document navigation');

  await page.evaluate(()=>{ const host=document.querySelector('#rightSide'); host.style.zoom='1.6'; host.style.height='430px'; });
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await open('paper-main');
  await page.screenshot({path:path.join(scratch,'history-menu-scaled.png')});
  const geometry=await page.evaluate(()=>{const a=document.querySelector('.sess-hmore').getBoundingClientRect(),m=document.querySelector('.sess-row-menu').getBoundingClientRect();return {left:m.left,right:m.right,top:m.top,bottom:m.bottom,anchorRight:a.right,zoom:getComputedStyle(document.querySelector('.sess-row-menu')).zoom};});
  assert.equal(geometry.zoom,'1.6');
  assert.ok(geometry.left>=7&&geometry.top>=7&&geometry.right<=1220-7&&geometry.bottom<=900-7);
  assert.ok(Math.abs(geometry.right-geometry.anchorRight)<2);
  await page.evaluate(()=>window.closeOverlays()); await closed();
  pass('scaled menus remain anchored and inside the viewport; navigation closes overlays');
  await page.evaluate(()=>window.setScope('global')); await page.waitForSelector(more('global-other'));
  await open('global-other'); await page.click(`${menu} .danger`);
  await page.waitForSelector('.sess-confirm-mask:not(.hidden)',{visible:true});
  await page.click('.sess-confirm-btn.danger');
  await page.waitForFunction(()=>!document.querySelector('.sess-hrow[data-sid="global-other"]'));
  assert.ok(await page.evaluate(()=>window.calls.some(call=>call.method==='DELETE'&&call.query.doc==='__global__'&&call.query.sid==='global-other')));
  pass('confirmed deletion targets the selected conversation owner');
  await page.evaluate(()=>window.setEmpty());
  await page.waitForFunction(()=>document.querySelector('.sess-empty')?.textContent==='No conversations yet');
  assert.equal(await page.$('.sess-filegroup'),null);
  pass('empty global history has no PDF instruction or artificial paper group');
  assert.deepEqual(errors,[]); assert.deepEqual(failed,[]);
  pass('no browser errors or failed requests');
  console.log(`PASS ${checks.length}/${checks.length}; screenshots: ${scratch}`);
} finally {
  if(browser) await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
