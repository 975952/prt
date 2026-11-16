import assert from 'node:assert/strict';
import { normalizeRects } from '../public/js/pdfview.js';

const rect = (x, y, w, h) => ({ x, y, w, h });
const covers = (r, x, y) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;

// Check every cell induced by the input/output boundaries: the output must cover
// exactly the selected area once, including small references and partial endpoints.
function sameArea(source, output) {
  const cuts = (axis, size) => [...new Set([...source, ...output].flatMap((r) => [r[axis], r[axis] + r[size]]))]
    .sort((a, b) => a - b);
  const xs = cuts('x', 'w'), ys = cuts('y', 'h');
  for (let x = 1; x < xs.length; x += 1) {
    if (xs[x] - xs[x - 1] < 1e-9) continue;
    for (let y = 1; y < ys.length; y += 1) {
      if (ys[y] - ys[y - 1] < 1e-9) continue;
      const cx = (xs[x] + xs[x - 1]) / 2, cy = (ys[y] + ys[y - 1]) / 2;
      const expected = source.some((r) => covers(r, cx, cy));
      const count = output.filter((r) => covers(r, cx, cy)).length;
      assert.equal(count, Number(expected), `selected coverage at (${cx}, ${cy})`);
    }
  }
}

let passed = 0;
function check(name, source, verify = () => {}) {
  const original = structuredClone(source);
  const output = normalizeRects(source);
  sameArea(source, output);
  assert.deepEqual(source, original, 'source geometry is immutable');
  sameArea(source, normalizeRects([...source].reverse()));
  verify(output);
  passed += 1;
  console.log(`PASS ${name}`);
}

check('same-height columns keep their unselected gutter', [rect(.10, .20, .32, .018), rect(.56, .20, .32, .018)],
  (output) => assert.equal(output.length, 2));

check('word gaps and partial character endpoints are not filled',
  [rect(.56, .20, .012, .018), rect(.59, .20, .08, .018), rect(.70, .20, .018, .018)],
  (output) => assert.equal(output.length, 3));

check('small references do not shorten the body highlight',
  [rect(.56, .20, .15, .018), rect(.71, .202, .025, .009), rect(.74, .202, .025, .009)]);

check('superscripts, subscripts and overlapping fonts retain every selected region',
  [rect(.10, .20, .20, .020), rect(.29, .194, .020, .012), rect(.30, .213, .022, .012), rect(.322, .20, .15, .020)]);

check('tight line spacing preserves all rows without double opacity',
  [rect(.56, .20, .32, .030), rect(.56, .217, .32, .030), rect(.56, .234, .32, .030)]);

check('staggered columns do not clip one another vertically',
  [rect(.10, .20, .32, .025), rect(.56, .21, .32, .025), rect(.10, .23, .32, .025), rect(.56, .24, .32, .025)]);

check('duplicate rectangles and adjacent fragments compact without losing area',
  [rect(.10, .20, .10, .02), rect(.20, .20, .10, .02), rect(.10, .20, .10, .02)],
  (output) => assert.equal(output.length, 1));

const body = [rect(.10, .20, .30, .015), rect(.10, .22, .30, .015), rect(.10, .24, .30, .015)];
sameArea(body, normalizeRects([...body, rect(.01, .01, .025, .45), rect(.5, .5, 0, .02), rect(NaN, .5, .1, .02)]));
assert.deepEqual(normalizeRects([]), []);
passed += 1;
console.log('PASS existing abnormal vertical-box guard and invalid-input handling remain intact');
console.log(`Selection rectangles: ${passed}/${passed} passed`);
