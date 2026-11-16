import assert from 'node:assert/strict';
import { orderSelectionRuns, clipSelectionRuns, selectionTextOf, selectionRunAt } from '../public/js/selection-reading-order.js';

const run = (text, left, top, width = 210, height = 10, extra = {}) => ({ text, left, top, width, height, page: 1, ...extra });
const layout = (runs) => orderSelectionRuns(runs, { width: 600, height: 800 });
const body = [run('L1 first body line', 40, 100), run('R1 right first line', 330, 100),
  run('L2 second body line', 40, 120), run('R2 right second line', 330, 120),
  run('note that was drawn early', 40, 700, 190, 8),
  run('L3 third body line', 40, 140), run('R3 right third line', 330, 140)];
const ordered = layout(body);
assert.deepEqual(ordered.map((item) => item.text), ['L1 first body line', 'L2 second body line', 'L3 third body line',
  'note that was drawn early', 'R1 right first line', 'R2 right second line', 'R3 right third line']);
const forward = clipSelectionRuns(ordered, { index: 0, offset: 3 }, { index: 2, offset: 8 });
const backward = clipSelectionRuns(ordered, { index: 2, offset: 8 }, { index: 0, offset: 3 });
assert.deepEqual(backward, forward);
assert.equal(selectionTextOf(forward), 'first body line\nL2 second body line\nL3 third');
assert.equal(selectionTextOf(clipSelectionRuns(ordered, { index: 3, offset: 0 }, { index: 3, offset: ordered[3].text.length })), 'note that was drawn early');
assert.deepEqual(clipSelectionRuns(ordered, { index: 0, offset: 2 }, { index: 0, offset: 2 }), []);
console.log('PASS interleaved columns use visual order, character clipping is directional, and explicit notes are preserved');

const withHeading = layout([run('Shared heading', 40, 65, 500, 18), ...body]);
assert.equal(withHeading[0].text, 'Shared heading');
assert.deepEqual(withHeading.slice(1).map((item) => item.text), ordered.map((item) => item.text));
const withAuthors = layout([run('First author', 40, 65, 125), run('Second author', 170, 65, 125),
  run('Third author', 300, 65, 125), run('Fourth author', 430, 65, 110), ...body]);
assert.deepEqual(withAuthors.slice(0, 4).map((item) => item.text), ['First author', 'Second author', 'Third author', 'Fourth author']);
assert.deepEqual(withAuthors.slice(4).map((item) => item.text), ordered.map((item) => item.text));
const centeredHeading = layout([run('Centered heading', 250, 65, 100, 18), ...body]);
assert.equal(centeredHeading[0].text, 'Centered heading');
assert.deepEqual(centeredHeading.slice(1).map((item) => item.text), ordered.map((item) => item.text));
const bands = layout([...body.filter((item) => !item.text.startsWith('note')),
  run('Shared mid-page heading', 40, 200, 500, 18),
  run('L4 lower left body', 40, 240), run('R4 lower right body', 330, 240),
  run('L5 lower left body', 40, 260), run('R5 lower right body', 330, 260)]);
assert.deepEqual(bands.map((item) => item.text.split(' ')[0]), ['L1', 'L2', 'L3', 'R1', 'R2', 'R3', 'Shared', 'L4', 'L5', 'R4', 'R5']);
console.log('PASS full-width headings separate column bands without splitting their text');

const table = layout([run('Method', 40, 100, 65), run('Value', 220, 100, 45),
  run('A', 40, 120, 10), run('12', 220, 120, 18), run('B', 40, 140, 10), run('24', 220, 140, 18)]);
assert.deepEqual(table.map((item) => item.text), ['Method', 'Value', 'A', '12', 'B', '24']);
const equations = layout([run('x = y + z', 40, 100, 200), run('(1)', 530, 100, 20),
  run('a = b + c', 40, 120, 200), run('(2)', 530, 120, 20),
  run('u = v + w', 40, 140, 200), run('(3)', 530, 140, 20)]);
assert.deepEqual(equations.map((item) => item.text), ['x = y + z', '(1)', 'a = b + c', '(2)', 'u = v + w', '(3)']);
const single = layout([run('Second', 40, 140, 160), run('First', 40, 100, 160)]);
assert.equal(selectionTextOf(single), 'First\nSecond');
console.log('PASS narrow table cells, equation numbers and single-column text retain row order');

const uneven = layout([run('L1 paragraph line', 40, 100), run('R1 paragraph line', 330, 103),
  run('L2 paragraph line', 40, 120), run('R2 paragraph line', 330, 123),
  run('L3 paragraph line', 40, 140), run('R3 paragraph line', 330, 143)]);
assert.equal(selectionRunAt(uneven, 100, 132).text, 'L2 paragraph line', 'left-column whitespace cannot jump to a closer right-column baseline');
assert.equal(selectionRunAt(uneven, 370, 135).text, 'R2 paragraph line');
const secondPage = layout([run('Next page first', 40, 50, 220, 10, { page: 2 })]);
assert.equal(selectionTextOf([...ordered.slice(-1), ...secondPage]), 'R3 right third line\n\nNext page first');
console.log('PASS column-aware hit testing stays within its flow and cross-page text has an explicit boundary');

const staggered = layout(Array.from({ length: 6 }, (_, i) => [
  run(`L${i + 1} staggered body line`, 40, 100 + i * 20),
  run(`R${i + 1} staggered body line`, 330, 110 + i * 20),
]).flat());
assert.deepEqual(staggered.map(item => item.text[0]), [...Array(6).fill('L'), ...Array(6).fill('R')],
  'columns with offset baselines must not become one alternating full-width flow');
assert.equal(selectionRunAt(staggered, 80, 130).text, 'L2 staggered body line');
assert.ok(clipSelectionRuns(staggered, { index: 0, offset: 0 }, { index: 2, offset: 12 }).every(run => run.text.startsWith('L')));
console.log('PASS staggered column baselines retain independent selection flows');

const mixed = layout([
  run('L1 body', 60, 200, 194), run('R1 body', 330, 200, 210),
  run('L2 body', 60, 212, 170), run('[1]', 233, 210, 15, 7), run('R2 body', 330, 212, 180), run('[2]', 513, 210, 15, 7),
  run('L3 body', 60, 224, 194), run('R3 body', 330, 224, 210),
  run('Margin identifier', 12, 202, 16, 360, { rotation: 90 }),
  run('L4 wider paragraph', 40, 260, 268), run('R4 body', 330, 260, 210),
  run('L5 wider paragraph', 40, 272, 268), run('R5 body', 330, 272, 210),
]);
assert.deepEqual(mixed.map((item) => item.text), ['L1 body', 'L2 body', '[1]', 'L3 body', 'L4 wider paragraph', 'L5 wider paragraph',
  'R1 body', 'R2 body', '[2]', 'R3 body', 'R4 body', 'R5 body', 'Margin identifier']);
assert.equal(new Set(mixed.filter((item) => /^R[1-5]/.test(item.text)).map((item) => item.line)).size, 5);
assert.equal(selectionRunAt(mixed, 307, 265).text, 'L4 wider paragraph', 'a wider lower paragraph remains inside the left flow');
const marginIndex = mixed.findIndex((item) => item.text === 'Margin identifier');
assert.equal(selectionTextOf(clipSelectionRuns(mixed, { index: marginIndex, offset: 0 },
  { index: marginIndex, offset: mixed[marginIndex].text.length })), 'Margin identifier');
console.log('PASS rotated margin text and small citations cannot join body rows or split indented columns');
