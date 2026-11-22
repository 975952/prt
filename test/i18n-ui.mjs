/** End-to-end locale changes against isolated Node or embedded desktop assets. No model service is used. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';

const desktop = process.argv.includes('--desktop');
const scratch = fs.mkdtempSync(path.join(SANDBOX, `i18n-${desktop ? 'desktop' : 'node'}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers); fs.mkdirSync(path.join(papers, '设置'));
fs.copyFileSync(path.join(ROOT, 'test/fixtures/multipage-sample.pdf'), path.join(papers, '设置', '新会话.pdf'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let reader, browser, activePage;
const errors = [], failed = [];
try {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1' };
  reader = desktop ? spawnReader(stageExe('i18n').exe, { args: ['--port', String(port)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  let ready = false;
  for (let i=0; i<150&&!ready; i++) { try { ready=(await fetch(`${base}/api/health`)).ok; } catch {} if(!ready)await wait(100); }
  assert.ok(ready, 'isolated service starts');
  for (const asset of ['js/i18n.js', 'js/languages.js', 'js/locales/de.js', 'js/locales/fil.js']) {
    assert.equal(await fetch(`${base}/${asset}`).then(response => response.text()),
      fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8'), `current embedded asset: ${asset}`);
  }
  const configured = await fetch(`${base}/api/config`, { method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({baseURL:'http://127.0.0.1:1/v1',model:'i18n-test-only',apiKey:'i18n-fixture-key'}) });
  assert.ok(configured.ok, 'isolated mock model configured');
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1350, height: 880 } });
  const page = activePage = await browser.newPage();
  let failWrites = false;
  const modelRequests = [];
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (failWrites && url.pathname === '/api/session' && request.method() === 'POST') {
      return request.respond({ status:503, contentType:'application/json', body:JSON.stringify({error:'保存失败：fixture'}) });
    }
    if (url.pathname === '/api/chat') {
      modelRequests.push(JSON.parse(request.postData()));
      const answer = 'The attention mechanism compares queries and keys, then combines values.\n\n**Key idea:** each token gathers relevant context.';
      return request.respond({ status:200, contentType:'text/event-stream',
        body:`data: ${JSON.stringify({choices:[{delta:{content:answer}}]})}\n\ndata: [DONE]\n\n` });
    }
    return request.continue();
  });
  page.on('dialog', async dialog => { console.error('Unexpected dialog:', dialog.message()); await dialog.dismiss(); });
  page.on('pageerror', e => {errors.push(String(e)); console.error('Page error:',String(e));});
  page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) failed.push(r.url()); });
  await page.goto(`${base}/?open=${encodeURIComponent('新会话.pdf')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.numPages >= 2 && window.__state?.viewerDocId === window.__state.doc?.docId);
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en', 'fresh profile starts in English');
  assert.equal(await page.evaluate(() => localStorage.getItem('reader.locale')), null, 'fresh profile has no saved locale override');
  await page.waitForSelector('#agentWelcomeSkip', { visible: true });
  await page.click('#agentWelcomeSkip');
  await page.click('#settingsBtn'); await page.locator('#settingsNavLanguage').click();
  await page.select('#uiLanguage', 'zh-CN');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#applyLanguage')]);
  await page.waitForFunction(() => window.__viewer?.numPages >= 2 && document.documentElement.lang === 'zh-CN'
    && window.__state?.viewerDocId === window.__state.doc?.docId);
  await page.click('#closeSettings');
  console.log('Verified English default and explicit Chinese preference');
  console.log('Opened paper');
  await page.click('.aibar-btn[data-block="chat"]');
  await page.click('#sessNew');
  await page.waitForFunction(() => window.__ctx.activeSession && !document.querySelector('#aiArea > .entry-card'));
  console.log('Created session');
  const prior = await page.evaluate(async () => {
    const ctx=window.__ctx;
    const e=ctx.addEntry({ block:'chat', kind:'assistant', tag:'回答', text:'设置\n\n新会话\n\n原文内容不应改变。' });
    ctx.finishEntry(e, '设置\n\n新会话\n\n原文内容不应改变。');
    await ctx.saveSessionNow();
    window.__viewer.goToPage(2);
    return { sid:ctx.activeSession, docId:window.__state.doc.docId,
      targetLang:document.querySelector('#translateTargetLang').value };
  });
  await page.type('#chatInput', '设置 新会话 draft to keep');
  await page.click('#settingsBtn'); await page.locator('#settingsNavLanguage').click();
  assert.equal(await page.$eval('#uiLanguage', n=>n.value), 'zh-CN');
  await page.select('#uiLanguage', 'en');
  await page.evaluate(() => { document.querySelector('#cfgLongTermMemory').value = 'unsaved memory'; });
  await page.click('#applyLanguage');
  await page.waitForFunction(() => document.querySelector('#toastWrap').textContent.includes('请先保存'));
  assert.equal(await page.evaluate(()=>document.documentElement.lang), 'zh-CN', 'unsaved settings block reload');
  await page.evaluate(() => { document.querySelector('#cfgLongTermMemory').value = ''; });
  failWrites = true;
  await page.click('#applyLanguage');
  await page.waitForFunction(() => document.querySelector('#toastWrap').textContent.includes('语言切换失败'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('reader.locale')), 'zh-CN', 'failed save retains the prior locale');
  assert.equal(await page.$eval('#chatInput', n=>n.value), '设置 新会话 draft to keep', 'failed save preserves draft');
  failWrites = false;
  await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}), page.click('#applyLanguage')]);
  console.log('Language page reloaded');
  await page.waitForFunction(() => window.__ctx?.activeSession && document.documentElement.lang === 'en'
    && document.querySelector('.settings-box').dataset.settingsPane === 'language');
  assert.equal(await page.evaluate(()=>window.__ctx.activeSession), prior.sid, 'same conversation after switching');
  assert.equal(await page.evaluate(()=>window.__state.doc.docId), prior.docId, 'same paper');
  assert.equal(await page.evaluate(()=>window.__viewer.current), 2, 'same page');
  assert.equal(await page.$eval('#chatInput', n=>n.value), '设置 新会话 draft to keep', 'draft survives');
  assert.equal(await page.$eval('#docName', n=>n.textContent), '新会话.pdf', 'file name is not translated');
  assert.ok(await page.$eval('#aiArea', n=>n.textContent.includes('原文内容不应改变。')), 'existing answer stays unchanged');
  assert.equal(await page.$eval('#translateTargetLang', n=>n.value), prior.targetLang, 'translation direction stays unchanged');
  const allow = new Set(['语言 / Language','简体中文']);
  const scan = async () => page.evaluate(() => {
    const out=[], walker=document.createTreeWalker(document.querySelector('#settingsModal'),NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {const n=walker.currentNode, s=n.textContent.trim();if (/[\u3400-\u9fff]/.test(s)&&n.parentElement.getClientRects().length)out.push(s);}
    return [...new Set(out)];
  });
  for (const pane of ['Language','Model','Appearance','Behavior','Session','Memory']) {
    await page.click(`#settingsNav${pane}`);
    assert.deepEqual((await scan()).filter(s=>!allow.has(s)), [], `${pane} translated`);
    assert.ok(await page.$eval('.settings-panes', n=>n.scrollWidth <= n.clientWidth+1), `${pane} fits`);
  }
  await page.click('#settingsNavAppearance');
  await page.screenshot({path:path.join(scratch,'english-appearance.png')});
  await page.click('#settingsNavLanguage');
  await page.screenshot({path:path.join(scratch,'english-language.png')});
  await page.click('#closeSettings');
  await page.setViewport({width:1100,height:700});
  await page.evaluate(()=> {const s=document.querySelector('#rightSide');s.style.width=s.style.minWidth=s.style.maxWidth='300px';});
  await page.click('#opsBtn');
  assert.ok(await page.$eval('#opsMenu', n=>!/先给|我需要|局限/.test(n.textContent)), 'teaching menu translated');
  await page.keyboard.press('Escape');
  await page.click('#sessHist');
  await page.waitForSelector('#sessHistory:not(.hidden)');
  await page.screenshot({path:path.join(scratch,'english-history-narrow.png')});
  assert.ok(await page.$eval('#rightSide', n=>n.scrollWidth <= n.clientWidth+1), 'narrow sidebar fits');
  await page.click('.sess-hist-back');
  await page.screenshot({path:path.join(scratch,'english-reader.png')});
  await page.$eval('#chatInput', n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.type('#chatInput','Explain this page');
  await page.click('#sendBtn');
  await page.waitForFunction(()=>!window.__state.busy && document.querySelector('#aiArea').textContent.includes('each token gathers relevant context'));
  assert.ok(modelRequests.some(r=>r.messages.some(m=>m.role==='system' && m.content.includes('Response language: English'))), 'English rule reaches actual UI model request');
  assert.ok(await page.$eval('#aiArea', n=>n.textContent.includes('Explain this page')), 'English question appears unchanged');
  await page.$eval('#chatInput', n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.type('#chatInput','设置 新会话 draft to keep');
  const second=await browser.newPage();
  console.log('Opening second window');
  await second.goto(base,{waitUntil:'domcontentloaded'});
  await second.waitForFunction(()=>window.__ctx && document.documentElement.lang==='en');
  assert.equal(await second.$eval('#settingsBtn',n=>n.title),'Settings','new window inherits global preference');
  console.log('Second window ready');
  await page.bringToFront();
  await page.click('#settingsBtn'); await page.locator('#settingsNavLanguage').click();
  console.log('Changing answer language');
  for (const [id, label, language, target] of [
    ['de', 'Einstellungen', 'German', 'Deutsch'], ['fil', 'Mga setting', 'Filipino', 'Filipino'],
  ]) {
    await page.select('#answerLanguage', 'auto');
    await page.select('#translateTargetLang', target);
    await page.select('#uiLanguage', id);
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#applyLanguage')]);
    await page.waitForFunction(id => document.documentElement.lang === id && window.__ctx?.activeSession
      && window.__state.viewerDocId === window.__state.doc?.docId
      && document.querySelector('.settings-box').dataset.settingsPane === 'language', {}, id);
    assert.equal(await page.$eval('#settingsBtn', node => node.title), label);
    assert.equal(await page.$eval('#chatInput', node => node.value), '设置 新会话 draft to keep');
    assert.equal(await page.evaluate(() => __ctx.activeSession), prior.sid);
    assert.equal(await page.$eval('#translateTargetLang', node => node.value), target);
    assert.ok(await page.$eval('#aiArea', node => node.textContent.includes('原文内容不应改变。')));
    for (const pane of ['Language', 'Model', 'Appearance', 'Behavior', 'Session', 'Memory']) {
      await page.click(`#settingsNav${pane}`);
      assert.deepEqual((await scan()).filter(text => !allow.has(text)), [], `${id} ${pane} translated`);
      assert.ok(await page.$eval('.settings-panes', node => node.scrollWidth <= node.clientWidth + 1), `${id} ${pane} fits`);
    }
    await page.click('#settingsNavLanguage');
    await page.screenshot({ path: path.join(scratch, `${id}-language.png`) });
    const cardPrompt = await page.evaluate(async () => (await import('/js/agent-card.js')).cardGenerationMessages([], { name: 'Test' }));
    assert.ok(cardPrompt[0].content.includes(`Character card language: ${language}`));
    assert.ok(cardPrompt.at(-1).content.includes(`in ${language}`));
    await page.evaluate(async () => {
      await (await import('/js/ai.js')).streamChat({ messages: [{ role: 'user', content: 'LANGUAGE_TEST' }], stream: true });
    });
    assert.ok(modelRequests.at(-1).messages.some(message => message.content.includes(`Response language: ${language}`)));
    await page.click('#closeSettings');
    await page.click('.aibar-btn[data-block="translate"]');
    await page.$eval('#chatInput', (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, `TRANSLATION_${id}`);
    await page.click('#sendBtn');
    await page.waitForFunction(text => __state.sessionEntries.some(row => row.retry?.text === text && row.status === 'complete'), {}, `TRANSLATION_${id}`);
    assert.ok(modelRequests.some(request => request.messages.some(message => typeof message.content === 'string' && message.content.includes(`翻译成${target}`))), `${id} target reaches request`);
    await page.evaluate(async () => { await __ctx.flushComposerDrafts(); await __ctx.saveSessionNow(); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(text => window.__state?.sessionEntries.some(row => row.retry?.text === text && row.status === 'complete'), {}, `TRANSLATION_${id}`);
    assert.equal(await page.evaluate(text => __state.sessionEntries.find(row => row.retry?.text === text).retry.targetLang, `TRANSLATION_${id}`), target, 'saved translation keeps target after reload');
    assert.equal(await page.$eval('#translationCardLanguage', node => node.value), target, 'floating card supports the target');
    await page.click('.aibar-btn[data-block="chat"]');
    assert.equal(await page.$eval('#chatInput', node => node.value), '设置 新会话 draft to keep');
    await page.click('#settingsBtn'); await page.locator('#settingsNavLanguage').click();
    console.log(`Verified ${language}: settings, drafts, character card, answer rule, translation request and restored target`);
  }
  await page.select('#answerLanguage','zh-CN');
  await second.waitForFunction(()=>document.querySelector('#answerLanguage').value==='zh-CN', { polling:100 });
  console.log('Answer preference synchronized');
  await page.select('#uiLanguage','zh-CN');
  await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.click('#applyLanguage')]);
  await page.waitForFunction(()=>document.documentElement.lang==='zh-CN' && document.querySelector('.settings-box').dataset.settingsPane==='language');
  assert.equal(await page.$eval('#chatInput',n=>n.value),'设置 新会话 draft to keep');
  assert.equal(await page.$eval('#answerLanguage',n=>n.value),'zh-CN','explicit answer language preserved');
  assert.equal(await second.evaluate(()=>document.documentElement.lang),'en','other active windows are not reloaded unexpectedly');
  await second.waitForFunction(()=>document.querySelector('#toastWrap').textContent.includes('language changed'), {polling:100});
  assert.deepEqual(errors,[], 'no page errors'); assert.deepEqual(failed,[], 'no failed requests');
  console.log(`PASS ${desktop?'desktop':'Node'}: full settings, language round trip, drafts, paper, session, content boundaries, narrow layout, multiple windows\n${scratch}`);
} catch(error) {
  if(activePage && !activePage.isClosed()) {
    console.error(await activePage.evaluate(()=>({locale:document.documentElement.lang, sid:window.__ctx?.activeSession,
      pane:document.querySelector('.settings-box')?.dataset.settingsPane, toast:document.querySelector('#toastWrap')?.textContent,
      doc:window.__state?.doc?.name, language:document.querySelector('#uiLanguage')?.value, body:document.body.innerText.slice(-1400)})));
    await activePage.screenshot({path:path.join(scratch,'failure.png')});
  }
  throw error;
} finally { await browser?.close(); if(reader)await stopChild(reader); }
