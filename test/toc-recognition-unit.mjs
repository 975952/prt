import assert from 'node:assert/strict';
import {
  assessTocConfidence,
  mapPrintedPages,
  normalizePrintedPage,
  normalizeVisionTocResult,
  parseTextContentsPages,
  romanToInt,
} from '../public/js/toc-recognition.js';

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
  console.log(`PASS ${name}`);
};

check('Roman numerals are canonical and case-insensitive', () => {
  assert.equal(romanToInt('iv'), 4);
  assert.equal(romanToInt('XLII'), 42);
  assert.equal(romanToInt('MCMXCIX'), 1999);
  assert.equal(romanToInt('IIII'), null);
  assert.equal(romanToInt(''), null);
});

check('printed page tokens normalize Roman and Arabic labels', () => {
  assert.deepEqual(normalizePrintedPage(' p. XIV. '), { scheme: 'roman', value: 14, label: 'xiv' });
  assert.deepEqual(normalizePrintedPage('００７'), { scheme: 'arabic', value: 7, label: '7' });
  assert.equal(normalizePrintedPage('0'), null);
  assert.equal(normalizePrintedPage('10000'), null);
});

check('text contents parser detects mixed Roman and Arabic rows and derives levels', () => {
  const parsed = parseTextContentsPages([
    { page: 1, text: 'A preface without a contents heading.' },
    { page: 2, text: 'Table of Contents\nPreface ............ iv\n1 Introduction ....... 1\n1.1 Background ....... 2\n2 Method ............. 5' },
    { page: 3, text: '2.1 Model ........... 6\nReferences ........... xii' },
  ]);
  assert.equal(parsed.found, true);
  assert.deepEqual(parsed.headingPages, [2]);
  assert.equal(parsed.entries.length, 6);
  assert.deepEqual(parsed.entries.map((entry) => entry.level), [1, 1, 2, 1, 2, 1]);
  assert.equal(parsed.entries[0].printedPage, 'iv');
  assert.equal(parsed.entries[1].printedPage, '1');
  assert.equal(parsed.entries.at(-1).printedPage, 'xii');
  assert.equal(parsed.entries[2].tocPage, 2);
});

check('Chinese titles use numbering and indentation; unreadable pages remain visible', () => {
  const parsed = parseTextContentsPages([
    { page: 1, error: 'synthetic decode failure' },
    { page: 2, text: '目 录\n第一章 绪论 ........ 1\n  1.1 研究背景 ...... 2\n    1.1.1 研究问题 ... 3' },
    { page: 3, readable: false },
  ]);
  assert.deepEqual(parsed.unreadablePages, [1, 3]);
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.entries.map((entry) => entry.level), [1, 2, 3]);
});

check('printed page mapping uses independent Roman and Arabic offsets', () => {
  const labels = new Array(9);
  labels[2] = 'i'; labels[3] = 'ii'; labels[4] = 'iii';
  labels[5] = '1'; labels[6] = '2'; labels[7] = '3';
  const mapped = mapPrintedPages([
    { title: 'Preface', printedPage: 'ii' },
    { title: 'Introduction', printedPage: '1' },
    { title: 'Method', printedPage: '4' },
  ], labels, 9);
  assert.deepEqual(mapped.offsets, { arabic: 5, roman: 2 });
  assert.deepEqual(mapped.entries.map((entry) => entry.actualPage), [4, 6, 9]);
  assert.deepEqual(mapped.entries.map((entry) => entry.mappingSource), ['observed-label', 'observed-label', 'sequence-offset']);
  assert.equal(mapped.complete, true);
});

check('missing labels and out-of-range estimates stay unresolved', () => {
  const mapped = mapPrintedPages([
    { title: 'Missing target', printedPage: 'iii' },
    { title: 'Beyond file', printedPage: '99' },
  ], [null, 'i', 'ii', null, '1', '2'], 6);
  assert.equal(mapped.entries[0].actualPage, null);
  assert.equal(mapped.entries[0].mappingReason, 'label-missing-at-target');
  assert.equal(mapped.entries[1].actualPage, null);
  assert.equal(mapped.entries[1].mappingReason, 'out-of-bounds');
  assert.equal(mapped.complete, false);
});

check('duplicate labels and non-monotonic sequences do not produce guessed mappings', () => {
  const duplicate = mapPrintedPages([{ printedPage: '1' }], ['1', '1', '2'], 3);
  assert.equal(duplicate.entries[0].mappingReason, 'duplicate-label');
  const broken = mapPrintedPages([{ printedPage: 'iv' }], ['i', 'iii', 'ii', null], 4);
  assert.equal(broken.offsets.roman, null);
  assert.equal(broken.entries[0].actualPage, null);
  assert.equal(broken.entries[0].mappingReason, 'non-monotonic-labels');
  const explicitMissing = mapPrintedPages([{ printedPage: 'iii' }], ['i', 'ii', null, '1', '2'], 5);
  assert.equal(explicitMissing.entries[0].actualPage, null);
  assert.equal(explicitMissing.entries[0].mappingReason, 'label-missing-at-target');
});

check('no usable page labels never falls back to a guessed constant offset', () => {
  const mapped = mapPrintedPages([{ printedPage: '1' }], [null, null, null], 3);
  assert.equal(mapped.entries[0].actualPage, null);
  assert.equal(mapped.entries[0].mappingStatus, 'unresolved');
});

check('vision output is parsed, sanitized, bounded, and tied to supplied pages', () => {
  const normalized = normalizeVisionTocResult('```json\n{"detected":true,"confidence":0.9,"entries":[{"title":"  1 Intro\\n<unsafe> ","printedPage":"1","level":1,"sourcePage":2,"confidence":0.8},{"title":"bad page","printedPage":"0","level":1,"sourcePage":2},{"title":"wrong source","printedPage":"2","level":2,"sourcePage":99}]}\n```', [2]);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.detected, true);
  assert.equal(normalized.entries.length, 1);
  assert.equal(normalized.entries[0].sourcePage, 2);
  assert.equal(normalized.entries[0].title.length <= 180, true);
  assert.equal(normalized.rejectedEntries, 2);
  assert.deepEqual(normalizeVisionTocResult('{not json}', [1]), {
    ok: false, reason: 'invalid-json', detected: false, entries: [], issues: ['invalid-response'],
  });
  assert.equal(normalizeVisionTocResult({ entries: [{ title: 'x' }] }).entries.length, 0);
});

check('recognition confidence rejects sparse or unmapped results and accepts adequate results', () => {
  const low = assessTocConfidence({ found: true, entries: [{ title: 'Only', printedPage: '1' }] });
  assert.equal(low.confident, false);
  assert.ok(low.reasons.includes('too-few-entries'));
  const entries = ['1', '2', '3', '4'].map((printedPage) => ({ printedPage, confidence: 0.9 }));
  const high = assessTocConfidence({ found: true, entries, mapping: { entries: entries.map((entry, i) => ({ ...entry, actualPage: i + 4 })) } });
  assert.equal(high.confident, true);
  assert.equal(high.unresolvedCount, 0);
  const weakMap = assessTocConfidence({ found: true, entries, mapping: { entries: entries.map((entry, i) => ({ ...entry, actualPage: i ? null : 4 })) } });
  assert.equal(weakMap.confident, false);
  assert.ok(weakMap.reasons.includes('too-many-unmapped-pages'));
});

console.log(`\nPASS ${checks.length} TOC recognition unit checks`);
