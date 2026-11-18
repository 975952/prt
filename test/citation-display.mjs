/** Visible citation fragments must not duplicate an adjacent quotation.
 * node test/citation-display.mjs
 */
import assert from 'node:assert/strict';
import { citationAlreadyVisible } from '../public/js/citation-display.js';

const resnet = 'with the network depth increasing, accuracy gets saturated (which might be unsurprising) and then degrades rapidly';
const cases = [
  ['the reported ResNet quotation appears once', resnet, resnet, true],
  ['a prose introduction does not prevent adjacent matching', `The paper states: ${resnet}`, resnet, true],
  ['sentence casing does not repeat the same quotation', `With${resnet.slice(4)}.`, resnet, true],
  ['line wrapping and nonbreaking spaces do not duplicate a quotation', resnet.replaceAll(' ', '\n\u00a0'), resnet, true],
  ['light quotation punctuation does not duplicate the sentence', `“${resnet.replace(/[(),]/g, '')}.”`, resnet, true],
  ['a standalone citation still displays its source sentence', 'The deeper plain network has an optimization problem.', resnet, false],
  ['a paraphrase is not mistaken for the original quotation', 'As networks get deeper, their accuracy can worsen.', resnet, false],
  ['an earlier occurrence elsewhere in the same paragraph is insufficient', `${resnet}. This observation motivates residual learning.`, resnet, false],
  ['an earlier paragraph cannot consume a standalone citation', `${resnet}\n\n`, resnet, false],
  ['the current paragraph may repeat an earlier quotation legitimately', `Earlier discussion.\n\n${resnet}`, resnet, true],
  ['a fragment spanning paragraphs remains visible', 'first sentence second sentence', 'first sentence\n\nsecond sentence', false],
  ['word boundaries prevent partial-word matching', 'The paper discusses inaccuracy.', 'accuracy', false],
  ['a changed negation is not removed', 'Accuracy does not degrade rapidly.', 'Accuracy does degrade rapidly.', false],
  ['a shortened ellipsis is not considered the complete quote', 'Accuracy ... degrades rapidly.', 'Accuracy degrades rapidly.', false],
  ['a matching decimal result is deduplicated', 'The reported accuracy is 83.1%.', 'The reported accuracy is 83.1%', true],
  ['a changed decimal result remains visible', 'The reported accuracy is 83.1%.', 'The reported accuracy is 831%', false],
  ['a changed sign remains visible', 'The change is +1.', 'The change is -1.', false],
  ['formula parentheses remain meaningful', 'a+b*c', '(a+b)*c', false],
  ['formula symbol case remains meaningful', 'A = b + c', 'a = b + c', false],
  ['an identical formula still avoids duplication', 'The equation is A = b + c', 'A = b + c', true],
  ['Chinese introductory prose preserves sentence matching', '作者指出：网络加深后，准确率先饱和，再迅速下降。', '网络加深后准确率先饱和再迅速下降', true],
  ['different Chinese source sentences remain visible', '准确率会迅速下降。', '准确率不会迅速下降。', false],
  ['HTML input is rejected rather than compared as visible prose', `<blockquote>${resnet}</blockquote>`, resnet, false],
  ['empty fragments are not treated as duplicates', resnet, '', false],
  ['punctuation-only fragments are not treated as duplicates', resnet, '。', false],
];

for (const [label, before, fragment, expected] of cases) {
  assert.equal(citationAlreadyVisible(before, fragment), expected, label);
  console.log(`PASS ${label}`);
}
console.log(`citation-display: ${cases.length}/${cases.length} passed`);
