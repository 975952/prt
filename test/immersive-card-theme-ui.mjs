import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const styles = ['style.css', 'reading-cards.css', 'immersive-reading.css']
  .map(name => fs.readFileSync(path.join(root, 'public', name), 'utf8'));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu'],
});
try {
  const page = await browser.newPage();
  await page.setContent(`<html data-theme="glass"><head>${styles.map(css => `<style>${css}</style>`).join('')}</head>
    <body class="reading immersive-reading immersive-chat-open">
      <div id="rightCols"><aside id="rightSide" class="side right reading-qa-card"></aside></div>
      <div id="translationCard" class="translation-card reading-tool-card" data-material="liquid">
        <div class="translation-material"></div>
      </div>
    </body></html>`);
  const surface = async theme => page.evaluate(theme => {
    document.documentElement.dataset.theme = theme;
    const read = selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return Object.fromEntries(['backgroundColor', 'borderColor', 'borderWidth', 'borderRadius', 'boxShadow', 'backdropFilter']
        .map(property => [property, style[property]]));
    };
    return {
      translation: read('#translationCard'),
      qa: read('#rightSide'),
      materialDisplay: getComputedStyle(document.querySelector('.translation-material')).display,
    };
  }, theme);
  for (const theme of ['light', 'glass']) {
    const result = await surface(theme);
    assert.deepEqual(result.translation, result.qa, `${theme} floating cards use the same surface`);
    if (theme === 'glass') assert.equal(result.materialDisplay, 'none', 'book mode suppresses the translation-only glass layer');
  }
  console.log('PASS immersive translation and QA cards share one surface in light and glass themes');
} finally {
  await browser.close();
}
