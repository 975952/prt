import assert from 'node:assert/strict';
import { resolveReadingRequest, readingTurn, snapshotReadingRequest } from '../public/js/reading-context.js';
import { askMessages } from '../public/js/ai.js';

const previous = resolveReadingRequest({ question: '解释一下1×1卷积', selection: '旧选区：FPN的通道变换', page: 2 });
const history = readingTurn(previous, '1×1卷积在每个位置重新组合通道。');
for (const question of ['所以到底是第一种还是第二种', '它们有什么不同？', '为什么？']) {
  const reading = resolveReadingRequest({ question, history, page: 2, screenshotCount: 2 });
  assert.equal(reading.inherited, false, 'new screenshots must not be replaced by an inherited selection');
  assert.equal(reading.selection, '');
  assert.equal(reading.focus.text, question);
  assert.equal(snapshotReadingRequest(reading).screenshotCount, 2);
  assert.equal(snapshotReadingRequest(reading).previousFocus.text, previous.focus.text);
  const messages = askMessages({ question, history, reading, page: 2, screenshotCount: 2, objectLabel: '本轮新发的 2 张截图与当前问题' });
  assert.ok(messages.some((m) => m.role === 'assistant' && m.content.includes('重新组合通道')), 'history remains available to interpret the question');
  assert.match(messages[0].content, /之前的解释和当前页文字不能盖过新图/);
  assert.match(messages.at(-1).content, /【本轮新附件】/);
  assert.match(messages.at(-1).content, /【上文讨论对象 · 追问线索，不是本轮新选区】/);
  assert.doesNotMatch(messages.at(-1).content, /【选中文本 · 本次追问沿用/);
}
const followup = resolveReadingRequest({ question: '为什么？', history });
assert.equal(followup.inherited, true, 'text-only follow-ups still inherit the existing object');
assert.equal(followup.selection, previous.selection);
const newSelection = resolveReadingRequest({ question: '比较一下', history, selection: '这次新选区', screenshotCount: 2 });
assert.equal(newSelection.selection, '这次新选区', 'new text and new screenshots can be supplied together');
console.log('PASS: new screenshots define the current evidence, history stays available, and text-only follow-ups retain their focus');
