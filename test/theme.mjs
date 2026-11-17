/**
 * 主题皮肤验收：透光 / 米宣 / 深色共用布局。
 * 验证透明纸面、夜读文字、图片原色、截图隔离、参数持久化和旧主题迁移。
 *
 *   node test/theme.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { writeNightFixture } from './fixtures/make-night-pdf.mjs';
const desktop = process.argv.includes('--desktop');

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'theme-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'theme-paper.pdf'));
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'image-sample.pdf'), path.join(PAPERS, 'theme-image.pdf'));

const CHROME = process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
writeNightFixture(path.join(PAPERS, 'night-composite.pdf'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const watchdog = setTimeout(() => { console.error('测试超时（180s），强制退出'); process.exit(3); }, 180000);
watchdog.unref?.();

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

let reader = null;
let browser = null;
try {
  const readerPort = await findPort();
  const env = { ...process.env, PORT: String(readerPort), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
    NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' };
  reader = desktop ? spawnReader(stageExe('theme').exe, { args: ['--port', String(readerPort)], env })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore', windowsHide: true });
  const BASE = `http://127.0.0.1:${readerPort}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ }
  }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('isolated server failed to start');

  for (const asset of ['style.css', 'js/app.js', 'js/sessions.js', 'js/pdfview.js', 'js/pdf-reading-theme.js']) {
    if (await fetch(`${BASE}/${asset}`).then(r => r.text()) !== fs.readFileSync(path.join(ROOT, 'public', asset), 'utf8')) throw new Error(`Stale embedded asset: ${asset}`);
  }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => localStorage.setItem('reader.locale', 'zh-CN'));
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const setTheme = async (value) => {
    await page.evaluate((v) => {
      const select = document.querySelector('#uiTheme');
      select.value = v;
      select.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await wait(200);
  };

  const artifactDir = path.join(import.meta.dirname, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });

  await page.goto(`${BASE}/?open=theme-paper.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal:not(.hidden)');

  const options = await page.evaluate(() => [...document.querySelectorAll('#uiTheme option')].map((o) => [o.value, o.textContent.trim()]));
  check('主题只保留透光、米宣与深色',
    JSON.stringify(options) === JSON.stringify([
      ['glass', '透光'], ['light', '米宣'], ['dark', '深色'],
    ]), JSON.stringify(options));

  /* 透明只影响纸底：验证真实像素、控件保存和不透明 AI 截图。 */
  await setTheme('glass');
  await page.waitForFunction(() => {
    const entry = window.__viewer?.rendered.get(1);
    return entry?.paper === 'rgba(0, 0, 0, 0)' && entry.textDiv?.childElementCount > 0;
  });
  const glass = await page.evaluate(() => {
    const canvas = window.__viewer.rendered.get(1).canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let empty = 0, ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) empty++;
      if (data[i + 3] === 255 && data[i] < 80) ink++;
    }
    const cs = getComputedStyle(document.documentElement);
    return { empty, ink, opacity: getComputedStyle(canvas).opacity,
      radius: cs.getPropertyValue('--glass-radius').trim(), frost: cs.getPropertyValue('--glass-frost').trim(),
      transparency: Number(cs.getPropertyValue('--glass-paper-opacity')), bg: getComputedStyle(document.body).backgroundColor };
  });
  check('玻璃纸底透明，文字像素保持不透明', glass.empty > 1000 && glass.ink > 100 && glass.opacity === '1', JSON.stringify(glass));
  check('默认采用低透明纸面 16% / 磨砂 48px / 圆角 28px', Math.abs(glass.transparency - .84) < .001 && glass.frost === '48px' && glass.radius === '28px');
  check('界面背景保持高透明度，底色近白并带极淡暖意', await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return Number(cs.getPropertyValue('--glass-surface-opacity')) === 0
      && cs.getPropertyValue('--glass-bg').trim() === 'rgb(233 233 233)';
  }));
  const crystal = await page.evaluate(() => {
    const p = document.querySelector('.page'), canvas = window.__viewer.rendered.get(1).canvas;
    const set = value => { const n = document.querySelector('#uiGlassCrystal'); n.value = value; n.dispatchEvent(new Event('input', { bubbles: true })); return [getComputedStyle(p).boxShadow, getComputedStyle(p, '::before').opacity]; };
    const low = set(0), high = set(100);
    return { low, high, sameCanvas: canvas === window.__viewer.rendered.get(1).canvas };
  });
  check('边缘高光独立于悬浮阴影且不重建正文', crystal.low[0] === crystal.high[0] && crystal.low[1] === '0' && crystal.high[1] === '1' && crystal.sameCanvas);
  const shotPixel = await page.evaluate(async () => {
    const shot = await window.__viewer.capturePageImage(1, { maxDim: 600 });
    const img = new Image(); img.src = shot.dataUrl; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(2, 2, 1, 1).data];
  });
  check('AI 截图保留白色实底', shotPixel.slice(0, 3).every(v => v > 248) && shotPixel[3] === 255, String(shotPixel));
  await page.click('#settingsNavAppearance');
  await page.screenshot({ path: path.join(artifactDir, 'theme-glass-settings.png') });
  const stable = await page.evaluate(() => {
    const viewer = window.__viewer;
    const canvas = viewer.rendered.get(1).canvas;
    const scroll = viewer.container.scrollTop;
    for (const [id, value] of [['uiGlassTransparency', 81], ['uiGlassFrost', 0], ['uiGlassRadius', 18], ['uiGlassBrightness', 96]]) {
      const input = document.getElementById(id); input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const motion = document.getElementById('uiMotion'); motion.checked = false;
    motion.dispatchEvent(new Event('input', { bubbles: true }));
    return { sameCanvas: canvas === viewer.rendered.get(1).canvas, sameScroll: scroll === viewer.container.scrollTop,
      saved: JSON.parse(localStorage.getItem('reader.ui')).style,
      transition: getComputedStyle(document.querySelector('.side')).transitionDuration };
  });
  check('滑杆即时生效且不重建画布、不跳阅读位置', stable.sameCanvas && stable.sameScroll);
  check('所有玻璃参数及动效开关均持久化，磨砂允许 0', stable.saved.glassTransparency === 81 && stable.saved.glassFrost === 0
    && stable.saved.glassRadius === 18 && stable.saved.glassBrightness === 96 && stable.saved.motion === false && stable.transition === '0s');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0);
  const restoredGlass = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { theme: document.documentElement.dataset.theme, frost: cs.getPropertyValue('--glass-frost').trim(),
      radius: cs.getPropertyValue('--glass-radius').trim(), opacity: Number(cs.getPropertyValue('--glass-paper-opacity')),
      motion: document.documentElement.dataset.motion, bg: cs.getPropertyValue('--glass-bg').trim() };
  });
  check('重开恢复玻璃控件，亮度已提亮', restoredGlass.theme === 'glass' && restoredGlass.frost === '0px' && restoredGlass.radius === '18px'
    && Math.abs(restoredGlass.opacity - .19) < .001 && restoredGlass.motion === 'off' && restoredGlass.bg === 'rgb(243 243 243)', JSON.stringify(restoredGlass));
  const focusStyle = await page.evaluate(() => {
    const input = document.querySelector('#chatInput'); input.focus();
    const cs = getComputedStyle(input);
    return { focused: document.activeElement === input, outline: cs.outlineStyle, border: cs.borderTopWidth, shadow: cs.boxShadow };
  });
  check('输入框聚焦没有黑框', focusStyle.focused && focusStyle.outline === 'none' && focusStyle.border === '0px' && focusStyle.shadow === 'none', JSON.stringify(focusStyle));
  await page.screenshot({ path: path.join(artifactDir, 'theme-glass.png') });

  const imagePage = await browser.newPage();
  await imagePage.goto(`${BASE}/?open=theme-image.pdf`, { waitUntil: 'domcontentloaded' });
  await imagePage.waitForFunction(() => window.__viewer?.rendered.get(1)?.textDiv?.childElementCount > 0);
  const imagePixels = await imagePage.evaluate(() => {
    const canvas = window.__viewer.rendered.get(1).canvas;
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let orange = 0, white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 200 && d[i + 1] === 108 && d[i + 2] === 62 && d[i + 3] === 255) orange++;
      if (d[i] === 250 && d[i + 1] === 246 && d[i + 2] === 232 && d[i + 3] === 255) white++;
    }
    return { orange, white };
  });
  check('彩图及图内白色像素保持原色', imagePixels.orange > 100 && imagePixels.white > 100, JSON.stringify(imagePixels));
  await imagePage.close();
  await page.evaluate(() => window.__viewer.setScale(2));
  await page.waitForFunction(() => {
    const viewer = window.__viewer;
    const entry = viewer.rendered.get(viewer.current);
    return entry?.paper === 'rgba(0, 0, 0, 0)' && Math.abs(entry.renderScale - 2) < .01
      && entry.textDiv?.childElementCount > 0 && !viewer.renderTasks.size;
  });
  check('透明纸底放大后文字层仍完整', await page.evaluate(() => window.__viewer.rendered.get(window.__viewer.current).textDiv.textContent.includes('Synthetic')));
  await page.evaluate(() => window.__viewer.goToPage(3));
  await page.waitForFunction(() => window.__viewer.rendered.get(3)?.textDiv?.childElementCount > 0);
  check('放大后翻页保持透明纸底', await page.evaluate(() => window.__viewer.current === 3 && window.__viewer.rendered.get(3).paper === 'rgba(0, 0, 0, 0)'));
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal:not(.hidden)');

  // Shared layout and readable paper, independent of palette.
  await page.evaluate(() => { window.__viewer.setScale(1); window.__viewer.goToPage(1); });
  const layouts = [];
  for (const theme of ['glass', 'light', 'dark']) {
    await setTheme(theme);
    await page.waitForFunction(() => {
      const v = window.__viewer, e = v.rendered.get(1);
      const theme = document.documentElement.dataset.theme;
      return e?.renderScale === 1 && !v.renderTasks.size && e.paper === (theme === 'dark' ? '#222426' : theme === 'glass' ? 'rgba(0, 0, 0, 0)' : getComputedStyle(document.documentElement).getPropertyValue('--paper').trim());
    }, { timeout: 30000 });
    await page.click('#closeSettings');
    layouts.push(await page.evaluate(() => {
      const get = selector => { const s = getComputedStyle(document.querySelector(selector)); return [s.display, s.padding, s.borderRadius, s.gap]; };
      return [get('#composer .composer-row'), get('.aibar'), get('.viewer-foot')];
    }));
    await page.screenshot({ path: path.join(artifactDir, `theme-${theme}-unified.png`) });
    if (theme === 'dark') {
      const pixels = await page.evaluate(() => {
        const c = window.__viewer.rendered.get(1).canvas, ctx = c.getContext('2d');
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let ink = 0, bg = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 215 && data[i + 1] === 217 && data[i + 2] === 219) ink++;
          if (data[i + 3] === 0) bg++;
        }
        return { ink, bg };
      });
      check('深色论文为浅字，空白纸底由可调的深色表面承载', pixels.ink > 100 && pixels.bg > 1000, JSON.stringify(pixels));
      const capture = await page.evaluate(async () => {
        const shot = await window.__viewer.capturePageImage(1, { maxDim: 600 });
        const img = new Image(); img.src = shot.dataUrl; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(2, 2, 1, 1).data];
      });
      check('夜读不改变截图和模型输入的原始纸面', capture.slice(0, 3).every(v => v > 248), String(capture));
    }
    await page.click('#settingsBtn'); await page.waitForSelector('#settingsModal:not(.hidden)');
  }
  check('三套配色共用输入框、标签栏和底栏布局', layouts.every(l => JSON.stringify(l) === JSON.stringify(layouts[0])));
  for (const theme of ['glass', 'light', 'dark']) {
    await setTheme(theme);
    await page.click('#settingsNavAppearance');
    await page.waitForFunction(() => !window.__viewer.renderTasks.size);
    const appearance = await page.evaluate(() => {
      const v = window.__viewer, canvas = v.rendered.get(1).canvas, scroll = v.container.scrollTop;
      const set = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
      const snapshot = () => {
        const paper = getComputedStyle(v.pageEls[1]), composer = getComputedStyle(document.querySelector('.composer-row'));
        return { paper: paper.backgroundColor, frost: paper.backdropFilter, radius: paper.borderRadius,
          shadow: paper.boxShadow, sheen: getComputedStyle(v.pageEls[1], '::before').opacity,
          surface: composer.background, backdrop: getComputedStyle(document.body).backgroundImage };
      };
      set('uiGlassTransparency', 0); set('uiGlassSurfaceTransparency', 0); set('uiGlassFrost', 48);
      set('uiGlassRadius', 32); set('uiGlassShadow', 100); set('uiGlassBrightness', 100); set('uiGlassCrystal', 100);
      const strong = snapshot();
      set('uiGlassTransparency', 100); set('uiGlassSurfaceTransparency', 100); set('uiGlassFrost', 0);
      set('uiGlassRadius', 0); set('uiGlassShadow', 0); set('uiGlassBrightness', 92); set('uiGlassCrystal', 0);
      return { strong, quiet: snapshot(), sameCanvas: canvas === v.rendered.get(1).canvas, sameScroll: scroll === v.container.scrollTop,
        enabled: [...document.querySelectorAll('#glassAppearanceControls input')].every(el => !el.matches(':disabled')) };
    });
    check(`${theme} 的透明、磨砂、圆角、亮度和光影真实变化，且不跳页`, appearance.enabled && appearance.sameCanvas && appearance.sameScroll
      && appearance.strong.paper !== appearance.quiet.paper && appearance.strong.surface !== appearance.quiet.surface
      && appearance.strong.backdrop !== appearance.quiet.backdrop && appearance.strong.shadow !== appearance.quiet.shadow
      && appearance.strong.frost === 'blur(48px)' && appearance.quiet.frost === 'blur(0px)'
      && appearance.quiet.radius === '0px' && appearance.quiet.sheen === '0', JSON.stringify(appearance));
    const beforeReset = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, page: window.__viewer.current, scale: window.__viewer.scale,
      font: JSON.parse(localStorage.getItem('reader.ui')).style.fontSize }));
    await page.click('#resetAppearanceEffects');
    check(`${theme} 重置效果不改变主题、字号或阅读位置`, await page.evaluate(before => {
      const style = JSON.parse(localStorage.getItem('reader.ui')).style;
      return style.theme === before.theme && style.fontSize === before.font && window.__viewer.current === before.page && window.__viewer.scale === before.scale
        && style.glassFrost === 48 && style.glassRadius === 28 && style.glassShadow === 100 && style.glassSurfaceTransparency === 100
        && style.glassTransparency === 16 && style.glassCrystal === 100;
    }, beforeReset));
    await page.screenshot({ path: path.join(artifactDir, `theme-${theme}-adjustable-settings.png`) });
  }
  const nightImage = await browser.newPage();
  await nightImage.goto(`${BASE}/?open=theme-image.pdf`, { waitUntil: 'domcontentloaded' });
  await nightImage.waitForFunction(() => window.__viewer?.rendered.get(1)?.paper === '#222426' && !window.__viewer.renderTasks.size);
  const preserved = await nightImage.evaluate(() => {
    const c = window.__viewer.rendered.get(1).canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let orange = 0, white = 0, ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 200 && d[i + 1] === 108 && d[i + 2] === 62 && d[i + 3] === 255) orange++;
      if (d[i] === 250 && d[i + 1] === 246 && d[i + 2] === 232 && d[i + 3] === 255) white++;
      if (d[i] === 215 && d[i + 1] === 217 && d[i + 2] === 219) ink++;
    }
    return { orange, white, ink };
  });
  check('夜读混排页：彩色图片和图内白色保持原色，文字反色', preserved.orange > 100 && preserved.white > 100 && preserved.ink > 100, JSON.stringify(preserved));
  await nightImage.screenshot({ path: path.join(artifactDir, 'theme-dark-images.png') });
  await nightImage.setViewport({ width: 1500, height: 950, deviceScaleFactor: 2 });
  await nightImage.goto(`${BASE}/?open=night-composite.pdf`, { waitUntil: 'domcontentloaded' });
  await nightImage.waitForFunction(() => window.__viewer?.rendered.get(1)?.paper === '#222426' && !window.__viewer.renderTasks.size);
  const composited = await nightImage.evaluate(() => {
    const c = window.__viewer.rendered.get(1).canvas, ctx = c.getContext('2d');
    const sample = (x, y) => [...ctx.getImageData(Math.floor(x / 480 * c.width), Math.floor((640 - y) / 640 * c.height), 1, 1).data];
    return { background: sample(10, 10), orange: sample(50, 490), white: sample(170, 370), black: sample(50, 370),
      repeated: sample(260, 490), masked: sample(260, 270), line: sample(100, 565) };
  });
  check('显式白色纸底与线条反色，重复图片和透明遮罩内的图片保持原色',
    JSON.stringify(composited.background) === '[34,36,38,255]' && JSON.stringify(composited.line) === '[215,217,219,255]'
    && JSON.stringify(composited.orange) === '[200,108,62,255]' && JSON.stringify(composited.repeated) === '[200,108,62,255]'
    && JSON.stringify(composited.masked) === '[200,108,62,255]' && JSON.stringify(composited.white) === '[255,255,255,255]'
    && JSON.stringify(composited.black) === '[0,0,0,255]', JSON.stringify(composited));
  const coloredText = async () => nightImage.evaluate(() => {
    const c = window.__viewer.rendered.get(1).canvas, ctx = c.getContext('2d');
    const sample = (x, y) => [...ctx.getImageData(Math.floor(x / 480 * c.width), Math.floor((640 - y) / 640 * c.height), 1, 1).data];
    const dominantInk = (x, y, w, h) => {
      const data = ctx.getImageData(Math.floor(x / 480 * c.width), Math.floor((640 - y - h) / 640 * c.height), Math.floor(w / 480 * c.width), Math.floor(h / 640 * c.height)).data;
      const colors = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const rgb = [...data.slice(i, i + 3)], key = rgb.join(',');
        if (data[i + 3] === 255 && Math.max(...rgb) > 80) colors.set(key, (colors.get(key) || 0) + 1);
      }
      return [...colors].sort((a, b) => b[1] - a[1])[0]?.[0].split(',').map(Number);
    };
    return { blue: dominantInk(28, 534, 150, 20), green: dominantInk(250, 534, 190, 20), neutral: dominantInk(28, 588, 420, 28),
      blueShape: sample(34, 520), greenShape: sample(256, 520), blueImage: sample(170, 490) };
  });
  const nightColors = await coloredText();
  const luminance = rgb => rgb.map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; })
    .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  const contrast = rgb => (luminance(rgb) + .05) / (luminance([34, 36, 38]) + .05);
  check('深蓝文字可读、绿色文字降低亮度，同时保持蓝绿区别', nightColors.blue && nightColors.green
    && contrast(nightColors.blue) >= 4.5 && contrast(nightColors.green) >= 4.5
    && luminance(nightColors.green) < .5 && nightColors.blue[2] > nightColors.blue[0] + 25
    && nightColors.green[1] > nightColors.green[0] + 20, JSON.stringify(nightColors));
  check('相同蓝绿的图形及图片未被文字调色影响', JSON.stringify(nightColors.blueShape) === '[0,0,128,255]'
    && JSON.stringify(nightColors.greenShape) === '[0,255,0,255]' && JSON.stringify(nightColors.blueImage) === '[0,0,128,255]');
  await nightImage.click('#settingsBtn'); await nightImage.waitForSelector('#settingsModal:not(.hidden)');
  await nightImage.click('#settingsNavAppearance');
  const readingBeforeBrightness = await nightImage.evaluate(() => ({ page: window.__viewer.current, top: window.__viewer.container.scrollTop, scale: window.__viewer.scale }));
  await nightImage.$eval('#uiNightBrightness', el => { el.value = 65; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await nightImage.waitForFunction(() => window.__viewer.rendered.get(1)?.nightBrightness === '65' && !window.__viewer.renderTasks.size);
  const softInk = await coloredText();
  check('正文亮度可降低，彩色文字、图片和阅读位置保持稳定', softInk.neutral
    && luminance(softInk.neutral) < luminance(nightColors.neutral) && contrast(softInk.neutral) >= 4.5
    && JSON.stringify(softInk.blue) === JSON.stringify(nightColors.blue) && JSON.stringify(softInk.blueImage) === '[0,0,128,255]'
    && await nightImage.evaluate(before => window.__viewer.current === before.page && window.__viewer.scale === before.scale
      && Math.abs(window.__viewer.container.scrollTop - before.top) < 1 && getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() === 'rgb(147 148 150)', readingBeforeBrightness), JSON.stringify(softInk));
  await nightImage.$eval('#uiNightSaturation', el => { el.value = 0; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await nightImage.waitForFunction(() => window.__viewer.rendered.get(1)?.nightSaturation === '0' && !window.__viewer.renderTasks.size);
  const grayText = await coloredText();
  check('鲜艳度可以降到灰度，图片与图形仍保持原色', grayText.blue && grayText.green
    && Math.max(...grayText.blue) - Math.min(...grayText.blue) <= 1 && Math.max(...grayText.green) - Math.min(...grayText.green) <= 1
    && JSON.stringify(grayText.blueImage) === '[0,0,128,255]' && JSON.stringify(grayText.greenShape) === '[0,255,0,255]');
  await nightImage.reload({ waitUntil: 'domcontentloaded' });
  await nightImage.waitForFunction(() => window.__viewer?.rendered.get(1)?.nightSaturation === '0' && window.__viewer.rendered.get(1)?.nightBrightness === '65' && !window.__viewer.renderTasks.size);
  check('重开恢复正文亮度和彩色文字鲜艳度', await nightImage.evaluate(() => document.documentElement.dataset.nightSaturation === '0' && document.documentElement.dataset.nightBrightness === '65'));
  await nightImage.click('#settingsBtn'); await nightImage.waitForSelector('#settingsModal:not(.hidden)');
  await nightImage.click('#settingsNavAppearance'); await nightImage.click('#resetAppearanceEffects');
  await nightImage.waitForFunction(() => window.__viewer.rendered.get(1)?.nightSaturation === '65' && window.__viewer.rendered.get(1)?.nightBrightness === '95' && !window.__viewer.renderTasks.size);
  await nightImage.click('#closeSettings');
  await nightImage.screenshot({ path: path.join(artifactDir, 'theme-dark-composite.png') });
  await nightImage.evaluate(() => window.__viewer.setScale(6));
  await nightImage.waitForFunction(() => {
    const v = window.__viewer, e = v.rendered.get(1);
    return e?.slice && e.renderScale === 6 && e.paper === '#222426' && !v.renderTasks.has(1);
  }, { timeout: 30000 });
  check('深色切片缩放不产生圆角接缝，文字层仍可选择', await nightImage.evaluate(() => {
    const e = window.__viewer.rendered.get(1);
    return getComputedStyle(e.canvas).borderRadius === '0px' && e.textDiv.textContent.includes('Night reading');
  }));
  await nightImage.close();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer?.rendered.get(1)?.paper === '#222426');
  check('刷新恢复深色主题和论文反色', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
  for (const [oldTheme, newTheme] of [['sand', 'light'], ['mist', 'glass'], ['sage', 'light'], ['fjord', 'dark'], ['plum', 'dark'], ['graphite', 'dark'], ['black', 'dark']]) {
    await page.evaluate(theme => {
      const saved = JSON.parse(localStorage.getItem('reader.ui') || '{}');
      saved.style = { ...saved.style, theme }; localStorage.setItem('reader.ui', JSON.stringify(saved));
    }, oldTheme);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0);
    const migrated = await page.evaluate(() => ({ active: document.documentElement.dataset.theme, saved: JSON.parse(localStorage.getItem('reader.ui')).style.theme }));
    check('旧主题偏好平滑迁移 ' + oldTheme, migrated.active === newTheme && migrated.saved === newTheme);
  }

  for (const [custom, transparency, brightness] of [[false, 76, 93], [true, 41, 96]]) {
    await page.evaluate(({ transparency, brightness }) => {
      localStorage.setItem('reader.ui', JSON.stringify({ style: { theme: 'glass', glassTransparency: transparency,
        glassSurfaceTransparency: 80, glassBrightness: brightness, glassFrost: 32, glassShadow: 35 } }));
    }, { transparency, brightness });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('reader.ui') || '{}').style?.appearanceVersion === 3);
    check(custom ? '升级保留用户自定义透明度和亮度' : '升级将旧默认值迁移到微暖透光默认值', await page.evaluate(custom => {
      const s = JSON.parse(localStorage.getItem('reader.ui')).style;
      return s.appearanceVersion === 3 && s.glassTransparency === (custom ? 41 : 16)
        && s.glassBrightness === (custom ? 96 : 92) && s.glassSurfaceTransparency === 100;
    }, custom));
  }
  for (const custom of [false, true]) {
    await page.evaluate(custom => {
      localStorage.setItem('reader.ui', JSON.stringify({ style: { theme: 'glass', appearanceVersion: 2,
        glassTransparency: 33, glassTone: 9, glassRadius: custom ? 11 : 24,
        glassShadow: custom ? 29 : 48, glassCrystal: custom ? 87 : 55 } }));
    }, custom);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('reader.ui') || '{}').style?.appearanceVersion === 3);
    check(custom ? '新悬浮外观保留已调圆角、光影与高光' : '新悬浮外观迁移上一版默认圆角、光影与高光', await page.evaluate(custom => {
      const s = JSON.parse(localStorage.getItem('reader.ui')).style;
      return s.glassRadius === (custom ? 11 : 28) && s.glassShadow === (custom ? 29 : 100)
        && s.glassCrystal === (custom ? 87 : 100) && s.glassTransparency === 33 && s.glassTone === 9;
    }, custom));
  }
  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n主题皮肤：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  if (reader) await stopChild(reader);
}
