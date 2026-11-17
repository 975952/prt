/** Offline PDF.js render regression. Uses file URLs and a debugging pipe only.
 * node test/pdf-night-render.mjs [--pdf test/artifacts/2109.01134v6-public.pdf]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX } from './_env.mjs';
import { writeNightFixture } from './fixtures/make-night-pdf.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'pdf-night-render-'));
const fixture = path.join(scratch, 'night-composite.pdf');
writeNightFixture(fixture);
const harness = path.join(scratch, 'render.html');
fs.writeFileSync(harness, '<!doctype html><meta charset="utf-8"><title>Offline PDF night rendering</title><body style="margin:0;background:#222426"></body>', 'utf8');

function writePanelFixture(destination) {
  const commands = `1 g 0 0 480 320 re f
0.84 0.92 0.98 rg 24 170 200 110 re f
0.98 0.91 0.73 rg 250 170 206 110 re f
0.93 g 24 35 200 105 re f
0 1 0 rg 250 35 206 105 re f
0 g BT /F1 18 Tf 36 240 Td (Pale blue panel) Tj ET
0 g BT /F1 18 Tf 262 240 Td (Pale yellow panel) Tj ET
0 g BT /F1 18 Tf 36 100 Td (Neutral panel) Tj ET
`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 320] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}endstream`,
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let size = chunks[0].length;
  objects.forEach((body, i) => { offsets.push(size); const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`); chunks.push(chunk); size += chunk.length; });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  fs.writeFileSync(destination, Buffer.concat(chunks));
}
const panels = path.join(scratch, 'pale-panels.pdf');
writePanelFixture(panels);
const candidates = [process.env.CHROME, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
const executablePath = candidates.find(candidate => candidate && fs.existsSync(candidate));
assert.ok(executablePath, 'A Chrome-compatible browser is required (CHROME can override the path)');
const browser = await puppeteer.launch({ executablePath, pipe: true, headless: true,
  userDataDir: path.join(scratch, 'browser-profile'), defaultViewport: { width: 1300, height: 1800 },
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--no-first-run'] });
const luminance = rgb => rgb.map(v => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; })
  .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const checks = [];
function check(label, condition, detail) { checks.push({ label, ok: !!condition, detail }); console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` ${JSON.stringify(detail)}` : ''}`); }
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(harness).href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ pdfURL, themeURL, workerURL, fontsURL, wasmURL }) => {
    const pdfjs = await import(pdfURL), theme = await import(themeURL);
    pdfjs.GlobalWorkerOptions.workerSrc = workerURL;
    window.renderPDF = async ({ bytes, pageNumber = 1, night = false, brightness = 90, scale = 2 }) => {
      const data = Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
      const loading = pdfjs.getDocument({ data, standardFontDataUrl: fontsURL, wasmUrl: wasmURL, isEvalSupported: false, useSystemFonts: true });
      const doc = await loading.promise;
      const pdfPage = await doc.getPage(pageNumber), viewport = pdfPage.getViewport({ scale });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      document.body.replaceChildren(canvas);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const task = pdfPage.render({ canvasContext: context, viewport, background: night ? theme.NIGHT_PAPER : '#ffffff' });
      if (night) theme.applyNightReading(task, pdfjs.OPS, { brightness, saturation: 50 });
      await task.promise;
      const text = await pdfPage.getTextContent();
      window.rendered = { canvas, context, scale, width: viewport.width / scale, height: viewport.height / scale };
      const result = { png: canvas.toDataURL(), width: canvas.width, height: canvas.height,
        text: text.items.filter(item => item.str).map(item => ({ str: item.str, x: item.transform[4], y: item.transform[5], w: item.width, h: item.height })) };
      await loading.destroy(); return result;
    };
    window.samplePDF = (x, y) => {
      const r = window.rendered;
      return [...r.context.getImageData(Math.floor(x * r.scale), Math.floor((r.height - y) * r.scale), 1, 1).data].slice(0, 3);
    };
    window.inkPDF = (x, y, w, h, bg) => {
      const r = window.rendered, pixels = r.context.getImageData(Math.floor(x * r.scale), Math.floor((r.height - y - h) * r.scale), Math.floor(w * r.scale), Math.floor(h * r.scale)).data;
      const colors = new Map();
      for (let i = 0; i < pixels.length; i += 4) {
        const rgb = [...pixels.slice(i, i + 3)];
        if (pixels[i + 3] !== 255 || Math.max(...rgb) < 90 || rgb.every((v, j) => Math.abs(v - bg[j]) < 2)) continue;
        const key = rgb.join(','); colors.set(key, (colors.get(key) || 0) + 1);
      }
      // Small glyphs can have more antialiased edge pixels than solid ink.
      // Compare their stable lightest cluster, rather than a half-covered edge.
      return [...colors].filter(([, count]) => count >= 2).sort((a, b) =>
        b[0].split(',').reduce((sum, v) => sum + Number(v), 0) - a[0].split(',').reduce((sum, v) => sum + Number(v), 0) || b[1] - a[1])[0]?.[0].split(',').map(Number);
    };
  }, { pdfURL: pathToFileURL(path.join(ROOT, 'public/vendor/pdf.min.mjs')).href,
    themeURL: pathToFileURL(path.join(ROOT, 'public/js/pdf-reading-theme.js')).href,
    workerURL: pathToFileURL(path.join(ROOT, 'public/vendor/pdf.worker.min.mjs')).href,
    fontsURL: pathToFileURL(path.join(ROOT, 'public/vendor/standard_fonts/')).href,
    wasmURL: pathToFileURL(path.join(ROOT, 'public/vendor/wasm/')).href });
  const render = async (filename, tag, options = {}) => {
    const result = await page.evaluate(args => window.renderPDF(args), { bytes: fs.readFileSync(filename).toString('base64'), ...options });
    fs.writeFileSync(path.join(scratch, `${tag}.png`), Buffer.from(result.png.split(',')[1], 'base64'));
    delete result.png; return result;
  };
  for (const brightness of [90, 65]) {
    await render(fixture, `composite-night-${brightness}`, { night: true, brightness });
    const images = await page.evaluate(() => Object.fromEntries(Object.entries({ paper: [10, 10], orange: [50, 490], repeated: [260, 490], masked: [260, 270], white: [170, 370], black: [50, 370], blue: [170, 490], blueShape: [34, 520], greenShape: [256, 520] })
      .map(([key, coords]) => [key, window.samplePDF(...coords)])));
    check(`paper and raster/mask colors are preserved at brightness ${brightness}`, JSON.stringify(images) === JSON.stringify({ paper: [34, 36, 38], orange: [200, 108, 62], repeated: [200, 108, 62], masked: [200, 108, 62], white: [255, 255, 255], black: [0, 0, 0], blue: [0, 0, 128], blueShape: [0, 0, 128], greenShape: [0, 255, 0] }), images);
    await render(panels, `pale-panels-night-${brightness}`, { night: true, brightness });
    const samples = await page.evaluate(() => Object.fromEntries(Object.entries({ blue: { bg: [30, 180], text: [36, 238, 180, 24] }, yellow: { bg: [256, 180], text: [262, 238, 190, 24] }, neutral: { bg: [30, 45], text: [36, 98, 180, 24] } })
      .map(([key, { bg, text }]) => { const background = window.samplePDF(...bg); return [key, { background, ink: window.inkPDF(...text, background) }]; })));
    for (const [key, { background, ink }] of Object.entries(samples)) {
      check(`${key} panel is dark and text readable at brightness ${brightness}`, luminance(background) < .14 && ink && contrast(ink, background) >= 4.5, { background, ink, contrast: ink && contrast(ink, background) });
    }
    check(`pale panels retain blue/yellow hue at brightness ${brightness}`, samples.blue.background[2] > samples.blue.background[0] && samples.yellow.background[0] > samples.yellow.background[2], samples);
    check(`saturated green vector remains unchanged at brightness ${brightness}`, JSON.stringify(await page.evaluate(() => window.samplePDF(260, 45))) === '[0,255,0]');
  }
  await render(panels, 'pale-panels-original');
  const pdfIndex = process.argv.indexOf('--pdf');
  if (pdfIndex >= 0) {
    assert.ok(process.argv[pdfIndex + 1], '--pdf requires a local PDF path');
    const source = path.resolve(process.argv[pdfIndex + 1]);
    const figureSamples = info => page.evaluate(text => {
      const labels = ['a [CLASS].', '82.68', '91.83', '60.86', '94.51', '39.83', '63.58', '24.17', '83.53'];
      const samples = labels.map(label => {
        const item = text.find(item => item.str === label);
        if (!item) return { label, missing: true };
        const background = window.samplePDF(item.x - 2, item.y + 3);
        return { label, background, ink: window.inkPDF(item.x, item.y - .5, item.w, item.h + 2, background) };
      });
      const r = window.rendered, image = document.createElement('canvas');
      image.width = 80; image.height = 80;
      // Interior of the Caltech airplane raster, away from its frame/text.
      image.getContext('2d').drawImage(r.canvas, 82 * r.scale, (r.height - 735) * r.scale, 40 * r.scale, 40 * r.scale, 0, 0, 80, 80);
      return { samples, photo: image.toDataURL() };
    }, info.text);
    const original = await render(source, 'paper-page2-original', { pageNumber: 2 });
    const originalFigure = await figureSamples(original);
    for (const brightness of [90, 65]) {
      const info = await render(source, `paper-page2-night-${brightness}`, { pageNumber: 2, night: true, brightness });
      fs.writeFileSync(path.join(scratch, `paper-page2-text-${brightness}.json`), JSON.stringify(info, null, 2));
      check(`real paper page 2 renders at brightness ${brightness}`, info.width > 500 && info.text.length > 20, { width: info.width, height: info.height });
      const figure = await figureSamples(info);
      check(`CoOp Figure 1 blue and green label contrast at brightness ${brightness}`, figure.samples.every(({ missing, background, ink }) => !missing && ink && luminance(background) < .14 && contrast(ink, background) >= 4.5),
        figure.samples.map(({ label, background, ink }) => ({ label, background, ink, contrast: ink && contrast(ink, background) })));
      check(`CoOp Figure 1 photograph unchanged at brightness ${brightness}`, figure.photo === originalFigure.photo);
    }
  }
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(checks, null, 2));
  console.log(`Artifacts: ${scratch}`);
  assert.ok(checks.every(item => item.ok), `${checks.filter(item => !item.ok).length} PDF night rendering checks failed`);
} finally { await browser.close(); }
