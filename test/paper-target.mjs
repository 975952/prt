/** Local target matching must never silently substitute the currently open PDF. */
import assert from 'node:assert/strict';
import { resolvePaperTarget, snapshotPaperTarget } from '../public/js/paper-target.js';
const paper = (docId, name, folder = '', more = {}) => ({ docId, name, folder, path: folder ? `${folder}/${name}` : name,
  url: `/api/pdf?name=${encodeURIComponent(folder ? `${folder}/${name}` : name)}`, ...more });
const mobile = paper('mobile', 'MobileNet.pdf', 'papers');
const analog = paper('analog7', '模电第七版_0.pdf', '课程/模电');
const transformer = paper('attention', '1706.03762.pdf', 'papers', { displayTitle: '1706.03762 · Attention Is All You Need' });
const library = [mobile, analog, transformer, paper('number12', '12.pdf'), paper('ai', 'AI.pdf')];
const resolve = (question, options = {}) => resolvePaperTarget({ question, papers: library, currentDocId: mobile.docId, ...options });
const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };

for (const question of ['模电书第278页', '模电教材第278页', '模电课本第278页', '讲一讲模电课本里面的300页的内容', '请从模电课本第278页解释这个电路']) {
  const got = resolve(question); assert.equal(got.status, 'matched', question); assert.equal(got.paper.docId, analog.docId, question);
  assert.equal(got.page, question.includes('300') ? 300 : 278); assert.equal(got.crossFile, true); assert.equal(got.explicit, true);
}
pass('Chinese textbook aliases select the requested book and page while another paper is visible');

for (const question of ['讲讲当前这篇论文', '解释当前论文第278页', '解释这一页', '当前这本书第5页', 'Explain this paper', 'Explain this page']) {
  assert.equal(resolve(question, { previousTarget: snapshotPaperTarget(analog, 278) }).status, 'none', question);
}
pass('current-paper and current-page requests remain attached to the screen rather than a missing title');

for (const question of ['1+2/12 等于多少', 'Explain this equation', '为什么要做归一化', 'What is a fair comparison?', '解释“receptive field”这个术语', '这个公式里 p 是什么']) {
  assert.equal(resolve(question).status, 'none', question);
}
pass('ordinary questions, quoted concepts, arithmetic and substrings do not identify a file');

for (const [question, id, page] of [
  ['Read page 3 of MobileNet.pdf', 'mobile', 3],
  ['Explain Attention Is All You Need page 4', 'attention', 4],
  ['1706.03762 第5页', 'attention', 5],
  ['arXiv:1706.03762 p. 6', 'attention', 6],
  ['引用《Attention Is All You Need》第3页中的定义', 'attention', 3],
  ['解释“MobileNet.pdf”的第2页', 'mobile', 2],
  ['读 12.pdf 第1页', 'number12', 1],
]) {
  const got = resolve(question); assert.equal(got.status, 'matched', question); assert.equal(got.paper.docId, id, question); assert.equal(got.page, page);
}
assert.equal(resolve('1706+03762 的结果是多少').status, 'none');
assert.equal(resolve('Read mobile.pdf page 4').status, 'missing', 'a similar but nonexistent filename is not MobileNet');
pass('English filenames, arXiv identifiers, visible titles and citations resolve without fuzzy filename substitution');

const otherCopy = paper('analog-copy', analog.name, '另一目录');
assert.equal(resolve('模电书第278页', { papers: [analog, otherCopy] }).status, 'ambiguous');
assert.equal(resolve('读取课程/模电/模电第七版_0.pdf第278页', { papers: [analog, otherCopy] }).paper.docId, analog.docId);
assert.equal(resolve('读另一目录\\模电第七版_0.pdf第278页', { papers: [analog, otherCopy] }).paper.docId, otherCopy.docId);
const edition8 = paper('analog8', '模电第八版.pdf');
assert.equal(resolve('模电课本第278页', { papers: [analog, edition8] }).status, 'ambiguous');
assert.equal(resolve('模电第七版第278页', { papers: [analog, edition8] }).paper.docId, analog.docId);
assert.equal(resolve('模电第六版第278页', { papers: [analog, edition8] }).status, 'missing');
const v1 = paper('mobile1', 'MobileNet.pdf'), v2 = paper('mobile2', 'MobileNetV2.pdf');
assert.equal(resolve('MobileNetV2.pdf 第4页', { papers: [v1, v2] }).paper.docId, 'mobile2');
pass('duplicate folders and different editions require disambiguation; exact paths win');

for (const [question, papers, expected] of [
  ['比较 MobileNet.pdf 和 MobileNetV2.pdf', [v1, v2], ['mobile1', 'mobile2']],
  ['Compare MobileNetV2.pdf with MobileNet.pdf page 3', [v1, v2], ['mobile2', 'mobile1']],
  ['比较模电第七版和模电第八版第278页', [analog, edition8], ['analog7', 'analog8']],
  ['比较课程/模电/模电第七版_0.pdf和另一目录/模电第七版_0.pdf', [analog, otherCopy], ['analog7', 'analog-copy']],
]) {
  const got = resolve(question, { papers });
  assert.equal(got.status, 'multiple', question);
  assert.deepEqual(got.papers.map(p => p.docId), expected, question);
}
assert.equal(resolve('比较模电第七版_0.pdf和MobileNet.pdf', { papers: [analog, otherCopy, mobile] }).status, 'ambiguous', 'one ambiguous member of a comparison still requires clarification');
assert.equal(resolve('比较MobileNet.pdf和MissingBook.pdf').status, 'missing', 'a missing named source cannot disappear when another source matches');
assert.equal(resolve('Compare MissingBook.pdf with 模电第七版_0.pdf').status, 'missing');
assert.equal(resolve('MobileNet.pdf的结论是否与MobileNet.pdf摘要一致', { papers: [v1, v2] }).status, 'matched', 'repeated reference to one file is not multi-source');
for (const question of ['Compare MobileNet.pdf page 2 and 模电第七版_0.pdf page 278. MULTI_SOURCE_COMPARE',
  '比较 MobileNet.pdf 第2页和模电第七版_0.pdf第278页',
  'Compare page 2 of MobileNet.pdf with page 278 of 模电第七版_0.pdf']) {
  const got = resolve(question);
  assert.equal(got.status, 'multiple', question);
  assert.deepEqual(got.targets.map(target => [target.paper.docId, target.page]), [['mobile', 2], ['analog7', 278]], question);
  assert.equal(got.page, null, 'different explicit page requests are not a shared page');
}
assert.deepEqual(resolve('Compare MobileNet.pdf and 模电第七版_0.pdf page 2').targets.map(target => target.page), [2, 2]);
pass('multiple explicitly named files remain available for cross-file comparison in mention order');

const sameIdCopy = paper(analog.docId, analog.name, 'same-id-copy');
assert.equal(resolve('模电书第278页', { papers: [analog, sameIdCopy] }).status, 'ambiguous', 'backend legacy filename IDs may collide');
assert.equal(resolve('读取same-id-copy/模电第七版_0.pdf第278页', { papers: [analog, sameIdCopy], currentDocId: analog.docId, currentPath: analog.path }).crossFile, true);
assert.equal(resolve('读取课程/模电/模电第七版_0.pdf第278页', { papers: [analog, sameIdCopy], currentDocId: analog.docId, currentPath: analog.path }).crossFile, false);
assert.equal(resolve('读取same-id-copy/模电第七版_0.pdf第278页', { papers: [analog, sameIdCopy], currentDocId: analog.docId }).crossFile, true);
assert.equal(resolve('继续讲解', { papers: [analog, sameIdCopy], previousTarget: snapshotPaperTarget(sameIdCopy, 278) }).paper.path, sameIdCopy.path);
assert.equal(resolve('继续讲解', { papers: [analog], previousTarget: snapshotPaperTarget(sameIdCopy, 278) }).status, 'missing');
pass('full paths isolate same-ID files and inherited targets never silently change copies');

for (const [question, page] of [['下一页', 279], ['上一页', 277], ['继续解释', 278], ['那本书', 278], ['那本书第300页', 300], ['next page', 279], ['Explain more', 278], ['第279页呢', 279], ['那第279页呢', 279], ['Page 279 please', 279]]) {
  const got = resolve(question, { previousTarget: snapshotPaperTarget(analog, 278) });
  assert.equal(got.status, 'matched', question); assert.equal(got.paper.docId, analog.docId); assert.equal(got.page, page);
  assert.equal(got.inherited, true); assert.equal(got.explicit, false);
}
assert.equal(resolve('下一页', { previousTarget: snapshotPaperTarget(analog, 278), papers: [mobile] }).status, 'missing');
assert.equal(resolve('模电下一页', { previousTarget: snapshotPaperTarget(analog, 278) }).page, 279);
const currentNext = resolve('当前论文下一页', { previousTarget: snapshotPaperTarget(analog, 278), currentPath: mobile.path, currentPage: 5 });
assert.equal(currentNext.paper.docId, mobile.docId); assert.equal(currentNext.page, 6);
assert.equal(resolve('下一页', { currentPage: 5 }).page, 6);
pass('follow-up questions inherit the prior target and page even after switching the visible PDF');

for (const question of ['ok', 'okay', 'yes', 'got it', '好的', '嗯', '明白了', '谢谢']) {
  const got = resolve(question, { previousTarget: snapshotPaperTarget(analog, 278), followup: true,
    currentPath: mobile.path, currentPage: 5 });
  assert.equal(got.status, 'matched', question);
  assert.equal(got.paper.path, analog.path, question);
  assert.equal(got.page, 278, question);
  assert.equal(got.inherited, true, question);
  assert.equal(got.explicit, false, question);
  assert.equal(got.crossFile, true, question);
}
assert.equal(resolve('ok', { followup: true }).status, 'none', 'confirmation cannot invent a missing previous target');
assert.equal(resolve('ok', { previousTarget: snapshotPaperTarget(analog, 278), followup: true, papers: [mobile] }).status, 'missing',
  'a removed previous target cannot silently become the visible paper');
assert.equal(resolve('OK是什么意思', { previousTarget: snapshotPaperTarget(analog, 278), followup: false }).status, 'none',
  'an independent definition must not inherit a paper target');
pass('reading-context acknowledgements recover the prior file without replacing it with the visible PDF');

const namedAfterConfirmation = resolve('Explain Attention Is All You Need page 4', {
  previousTarget: snapshotPaperTarget(analog, 278), followup: true,
});
assert.equal(namedAfterConfirmation.status, 'matched');
assert.equal(namedAfterConfirmation.paper.docId, transformer.docId);
assert.equal(namedAfterConfirmation.page, 4);
assert.equal(namedAfterConfirmation.explicit, true);
assert.equal(namedAfterConfirmation.inherited, false);
assert.equal(resolve('Read MissingBook.pdf page 4', { previousTarget: snapshotPaperTarget(analog, 278), followup: true }).status, 'missing');
for (const question of ['讲讲当前这篇论文', '解释这一页', 'Explain this page', 'Explain this paper']) {
  assert.equal(resolve(question, { previousTarget: snapshotPaperTarget(analog, 278), followup: true }).status, 'none', question);
}
const screenNextAfterConfirmation = resolve('当前论文下一页', { previousTarget: snapshotPaperTarget(analog, 278), followup: true,
  currentPath: mobile.path, currentPage: 5 });
assert.equal(screenNextAfterConfirmation.paper.docId, mobile.docId);
assert.equal(screenNextAfterConfirmation.page, 6);
assert.equal(screenNextAfterConfirmation.inherited, false);
pass('explicitly named files and screen-page requests outrank a general follow-up hint');

for (const [question, page] of [['模电课本第0页', 0], ['模电课本第-1页', -1], ['MobileNet.pdf page 2.5', 2.5], ['模电书第零页', 0]]) {
  const got = resolve(question); assert.equal(got.status, 'matched', question); assert.equal(got.invalidPage, true, question); assert.equal(got.page, page);
}
const previous = resolve('上一页', { previousTarget: snapshotPaperTarget(analog, 1) });
assert.equal(previous.page, 0); assert.equal(previous.invalidPage, true);
assert.equal(resolve('下一页', { previousTarget: snapshotPaperTarget(analog) }).invalidPage, true);
assert.equal(resolve('模电书第二百七十八页').page, 278);
assert.equal(resolve('模电书第99999页').page, 99999, 'upper bounds are checked against the selected PDF, never guessed here');
pass('invalid and relative-out-of-range pages stay explicit; Chinese numerals are supported');

assert.equal(resolve('请讲解《不存在的课本》第278页').status, 'missing');
assert.equal(resolve('讲解缺失文件.pdf第3页').status, 'missing');
assert.equal(resolve('模电课本第278页', { papers: [mobile] }).status, 'missing');
const snapshot = snapshotPaperTarget(analog, 278);
assert.deepEqual(snapshot, { docId: 'analog7', name: analog.name, path: analog.path, page: 278 });
assert.equal(snapshotPaperTarget(null), null); assert.equal(snapshotPaperTarget(analog, -1).page, null);
pass('missing explicit books never fall back, and persisted target snapshots contain only stable metadata');
console.log(`PASS paper target: ${checks.length} groups`);
