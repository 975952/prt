import assert from 'node:assert/strict';
import { resolveReadingRequest, resolvePageRole, readingTurn, snapshotHistory, restoreReadingHistory, replaceReadingTurn } from '../public/js/reading-context.js';

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
