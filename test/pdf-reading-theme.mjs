/** Offline color/graphics-state checks. No browser, user data or network. */
import assert from 'node:assert/strict';
import { applyNightReading, nightFillColor, nightTextColor } from '../public/js/pdf-reading-theme.js';

const rgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
const luminance = color => rgb(color).map(v => {
  const x = v / 255;
  return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
}).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

for (const brightness of [65, 75, 90, 100]) {
  for (const color of ['#ddebf7', '#e5f0f8', '#fff2cc', '#f8dddd', '#ddf4e5', '#eef2f6']) {
    const fill = nightFillColor(color, brightness);
    assert(luminance(fill) < .065, `${color} has a dark background`);
    assert(contrast(fill, nightTextColor('#000000', 50, brightness)) >= 4.5, `${color} at ${brightness}% has readable labels`);
    const original = rgb(color), mapped = rgb(fill);
    assert.equal(original.indexOf(Math.max(...original)), mapped.indexOf(Math.max(...mapped)), `${color} retains its dominant channel`);
    assert(Math.max(...mapped) - Math.min(...mapped) >= 8, `${color} does not become neutral white/gray`);
  }
}
console.log('PASS pastel blue/yellow/red/green fills keep their hue and label contrast at every text brightness');

for (const color of ['#000080', '#00ff00', '#ff0000', '#2266aa', '#ffcc00']) {
  assert.equal(nightFillColor(color), color, `${color} saturated diagram fill is unchanged`);
}
assert.equal(nightFillColor('#ffffff'), '#222426');
assert.equal(nightFillColor('#000000'), '#cbcdcf');
for (const color of ['transparent', 'rgb(12, 34, 56)', null, { pattern: true }]) assert.equal(nightFillColor(color), color);
console.log('PASS saturated graphics, neutral paper/ink and unsupported colors retain their existing behavior');

const OPS = Object.fromEntries(['setFillRGBColor', 'setStrokeRGBColor', 'showText', 'beginGroup', 'endGroup',
  'paintImageMaskXObject', 'paintImageXObject'].map((name, i) => [name, i + 1]));
function renderer() {
  const calls = [], stack = [];
  const gfx = {
    current: { fillColor: '#000000', strokeColor: '#000000' },
    ctx: { fillStyle: '#000000', strokeStyle: '#000000' },
    setFillRGBColor(index, color) { this.ctx.fillStyle = this.current.fillColor = color; },
    setStrokeRGBColor(index, color) { this.ctx.strokeStyle = this.current.strokeColor = color; },
    showText() { calls.push({ kind: 'text', fill: this.current.fillColor, stroke: this.current.strokeColor }); },
    beginGroup() {
      stack.push({ current: this.current, fill: this.ctx.fillStyle, stroke: this.ctx.strokeStyle });
      this.current = Object.create(this.current);
    },
    endGroup() { const saved = stack.pop(); this.current = saved.current; this.ctx.fillStyle = saved.fill; this.ctx.strokeStyle = saved.stroke; },
    paintImageMaskXObject() { calls.push({ kind: 'mask', fill: this.current.fillColor }); },
    paintImageXObject(index, image) { calls.push({ kind: 'image', image }); },
  };
  for (const name of Object.keys(OPS)) gfx[OPS[name]] = gfx[name];
  const task = { _internalRenderTask: { gfx }, cancel() { this.cancelled = true; } };
  applyNightReading(task, OPS);
  let resumed = 0;
  task.onContinue(() => resumed++);
  task.onContinue(() => resumed++);
  assert.equal(resumed, 2);
  return { gfx, calls, task };
}

{
  const { gfx, calls } = renderer();
  gfx[OPS.setFillRGBColor](0, '#ddebf7');
  const fill = gfx.current.fillColor;
  assert.equal(fill, nightFillColor('#ddebf7'));
  gfx[OPS.setStrokeRGBColor](1, '#ddebf7');
  assert.equal(gfx.current.strokeColor, '#ddebf7', 'colored strokes are not background fills');
  gfx[OPS.showText](2, []);
  assert.deepEqual(calls.at(-1), { kind: 'text', fill: nightTextColor('#ddebf7'), stroke: nightTextColor('#ddebf7') });
  assert.equal(gfx.current.fillColor, fill);
  assert.equal(gfx.ctx.fillStyle, fill);
  gfx.paintImageMaskXObject();
  assert.equal(calls.at(-1).fill, '#ddebf7');
  assert.equal(gfx.current.fillColor, fill);
  const image = { pixels: new Uint8Array([255, 255, 255, 0, 0, 128]) };
  gfx.paintImageXObject(3, image);
  assert.equal(calls.at(-1).image, image);
  assert.deepEqual([...image.pixels], [255, 255, 255, 0, 0, 128]);
}
console.log('PASS operator and named dispatch separate fill/stroke/text, restore screen state and preserve image inputs');

{
  const { gfx, calls } = renderer();
  gfx.setFillRGBColor(0, '#ffffff');
  const saved = gfx.current;
  gfx.current = Object.create(saved);
  gfx.setFillRGBColor(1, '#fffffe');
  assert.equal(gfx.current.fillColor, saved.fillColor, 'two original colors deliberately collide after mapping');
  gfx.paintImageMaskXObject();
  assert.equal(calls.at(-1).fill, '#fffffe');
  gfx.current = saved;
  gfx.paintImageMaskXObject();
  assert.equal(calls.at(-1).fill, '#ffffff', 'restoring state recovers its own exact original color');
  gfx.setFillRGBColor(2, '#ddebf7');
  gfx.current.fillColor = gfx.ctx.fillStyle = 'transparent';
  gfx.showText();
  assert.equal(calls.at(-1).fill, 'transparent', 'a later transparent/pattern setter invalidates old raw metadata');
}
console.log('PASS cloned graphics states own their original colors even when dark palette values collide');

{
  const { gfx, calls } = renderer();
  gfx.setFillRGBColor(0, '#ddebf7');
  const fill = gfx.current.fillColor;
  gfx.beginGroup(1, { smask: true });
  assert.equal(gfx.current.fillColor, '#ddebf7');
  gfx.setFillRGBColor(2, '#fff2cc');
  gfx.setStrokeRGBColor(3, '#000000');
  gfx.beginGroup(4, { smask: false });
  gfx.showText();
  assert.deepEqual(calls.at(-1), { kind: 'text', fill: '#fff2cc', stroke: '#000000' });
  gfx.endGroup(5, { smask: false });
  gfx.endGroup(6, { smask: true });
  assert.equal(gfx.current.fillColor, fill);
  gfx.setFillRGBColor(7, '#fff2cc');
  assert.equal(gfx.current.fillColor, nightFillColor('#fff2cc'));
}
console.log('PASS nested transparency masks keep original colors and screen remapping resumes after restore');
