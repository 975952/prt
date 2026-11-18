import assert from 'node:assert/strict';
import { resolveReadingRequest, resolvePageRole, readingTurn, snapshotHistory, restoreReadingHistory, replaceReadingTurn,
  readingIntent, snapshotReadingRequest } from '../public/js/reading-context.js';
import { webQueryFor } from '../public/js/ai.js';

const request = resolveReadingRequest({ question: 'Explain analog page 278', page: 278 });
request.focus.document = { docId: 'analog', name: 'Analog.pdf', path: 'courses/Analog.pdf', page: 278 };
const entry = { id: 'answer-1', block: 'chat', kind: 'assistant', text: 'old long answer',
  generation: 1, generationId: 'attempt-a', retry: { question: request.question, reading: request } };
const old = replaceReadingTurn([], request, entry.text, entry);
assert.equal(snapshotHistory(old)[0].focus.document.path, 'courses/Analog.pdf');
assert.equal(snapshotHistory(old)[1].entryId, entry.id);
assert.equal(resolvePageRole({ question: '教材第278页', screenPage: 5, numPages: 9 }).page, 278);

const later = readingTurn(resolveReadingRequest({ question: 'An independent later question' }), 'later answer');
const newer = replaceReadingTurn([...old, ...later], request, 'short', { ...entry, generation: 2, generationId: 'attempt-b' });
assert.equal(newer.length, 4);
assert.equal(newer[1].content, 'short');
assert.equal(newer[1].generation, 2);
assert.equal(newer[3].content, 'later answer');
assert(!newer.some(row => row.content === 'old long answer'));

const legacy = readingTurn(request, entry.text);
const bound = restoreReadingHistory(legacy, [entry]);
assert(bound.every(row => row.entryId === entry.id));
const ambiguous = restoreReadingHistory(legacy, [entry, { ...entry, id: 'answer-2' }]);
assert(ambiguous.every(row => !row.entryId));

const replacement = replaceReadingTurn(later, request, 'retry result', { ...entry, generation: 3 }, 0);
assert.deepEqual(replacement.map(row => row.content), [request.question, 'retry result', ...later.map(row => row.content)]);
const invalid = snapshotHistory([{ role: 'assistant', content: 'x', entryId: 'ok', generation: -1, generationId: '../unsafe' }])[0];
assert.equal(invalid.generation, 0); assert.equal(invalid.generationId, '');
console.log('PASS reading source identity, deferred page validation, retry replacement, legacy matching and history order');

const topic = resolveReadingRequest({ question: 'deit的论文', page: 1 });
topic.focus.document = { docId: 'deit', name: '2012.12877.pdf', path: 'papers/2012.12877.pdf', page: 1 };
const topicHistory = readingTurn(topic, 'DeiT uses a distillation token.');
for (const question of ['ok', 'OK.', ' okay ', 'yes', 'got it', '好的', '好的！', '嗯', '明白了', '谢谢']) {
  assert.equal(readingIntent(question), 'acknowledgement', question);
  const followup = resolveReadingRequest({ question, history: topicHistory, page: 9 });
  assert.equal(followup.inherited, true, question);
  assert.deepEqual(followup.focus, topic.focus, question);
  const saved = snapshotReadingRequest(followup);
  assert.equal(saved.intent, 'acknowledgement', question);
  assert.deepEqual(saved.focus.document, topic.focus.document, question);
  assert.equal(webQueryFor(question, '', { reading: saved }), '', question);
  assert.equal(webQueryFor(question, '', { history: topicHistory }), '', question);
}
const standalone = resolveReadingRequest({ question: 'ok' });
assert.equal(standalone.inherited, false, 'a confirmation without history cannot invent a previous topic');
assert.equal(webQueryFor('ok', '', { reading: standalone }), '', 'standalone confirmation is not a dictionary lookup');
console.log('PASS short confirmations retain their intent and never start an unrelated web search');

let conversation = topicHistory;
for (const question of ['？', '？', 'ok', '嗯', '？', 'got it', '继续']) {
  const followup = resolveReadingRequest({ question, history: conversation, page: 9 });
  assert.equal(followup.inherited, true, question);
  assert.deepEqual(followup.focus, topic.focus, question);
  assert.equal(followup.page, 1, `${question}: scrolling cannot replace the topic page`);
  assert.deepEqual(resolvePageRole({ question, reading: followup, screenPage: 9 }), { page: 1, role: 'topic' }, question);
  conversation = snapshotHistory([...conversation, ...readingTurn(followup, 'Continue discussing DeiT.')]);
}
assert.equal(conversation.length, 16);
assert.equal(conversation[0].content, topic.question);
assert.equal(conversation.at(-2).focus.document.docId, 'deit');
console.log('PASS repeated punctuation and acknowledgements keep the original paper and page after scrolling');

const legacyTopic = topicHistory.map(({ role, content }) => ({ role, content }));
const legacyReplies = ['？', '？', 'ok', '好的'].flatMap(content => [
  { role: 'user', content }, { role: 'assistant', content: 'Earlier response.' },
]);
for (const history of [[...legacyTopic, ...legacyReplies], [...topicHistory, ...legacyReplies]]) {
  const recovered = resolveReadingRequest({ question: '嗯', history, page: 9 });
  assert.equal(recovered.inherited, true);
  assert.equal(recovered.focus.text, topic.question, 'legacy confirmations without focus must not hide the earlier topic');
  if (history[0].focus) {
    assert.deepEqual(recovered.focus.document, topic.focus.document);
    assert.equal(recovered.focus.page, 1);
  }
}
const changedTopicHistory = [...topicHistory, ...readingTurn(
  resolveReadingRequest({ question: 'What is batch normalization?', page: 4 }), 'A different topic.'), ...legacyReplies];
assert.equal(resolveReadingRequest({ question: 'ok', history: changedTopicHistory }).focus.text, 'What is batch normalization?',
  'backtracking stops at the newest substantive topic');
console.log('PASS legacy history without focus recovers the latest substantive topic across short replies');

const screenRequest = resolveReadingRequest({ question: 'Explain this page', history: conversation, page: 9 });
assert.equal(screenRequest.inherited, false);
assert.equal(screenRequest.focus.page, 9);
assert.equal(screenRequest.focus.document, undefined);
assert.deepEqual(resolvePageRole({ question: screenRequest.question, reading: screenRequest, screenPage: 9 }), { page: 9, role: 'screen' });
const newSelection = resolveReadingRequest({ question: 'ok', history: conversation, selection: 'A new selected passage.', page: 12 });
assert.equal(newSelection.inherited, false);
assert.equal(newSelection.focus.text, 'A new selected passage.');
assert.equal(newSelection.focus.page, 12);
assert.equal(newSelection.focus.document, undefined);
const newScreenshot = resolveReadingRequest({ question: 'ok', history: conversation, screenshotCount: 1, page: 12 });
assert.equal(newScreenshot.inherited, false);
assert.equal(newScreenshot.focus.page, 12);
assert.equal(newScreenshot.focus.document, undefined);
assert.deepEqual(newScreenshot.previousFocus, topic.focus, 'new evidence may use history without becoming the old evidence');
assert.deepEqual(resolvePageRole({ question: 'ok', reading: newScreenshot, screenPage: 9, attachmentPage: 12 }), { page: 12, role: 'selection' });
console.log('PASS explicit screen requests and newly attached evidence take priority over inherited focus');

for (const question of ['OK是什么意思', '解释一下 OK 的意思', 'What does okay mean?', 'What does yes mean?', '谢谢这个词是什么意思']) {
  const definition = resolveReadingRequest({ question, history: conversation, page: 9 });
  assert.equal(definition.intent, 'question', question);
  assert.equal(definition.inherited, false, question);
  assert.equal(definition.focus.text, question, question);
  assert(webQueryFor(question, '', { reading: definition }).length > 0, `${question}: an explicit definition remains searchable`);
}
console.log('PASS explicit word-definition questions remain independent searchable requests');
