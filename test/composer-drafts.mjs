/** Current-window draft isolation and failed-send recovery. No DOM, API or user data. */
import assert from 'node:assert/strict';
import { createComposerDraftStore } from '../public/js/composer-drafts.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const chat = { docId: 'paper-a', mode: 'chat' };
const translate = { docId: 'paper-a', mode: 'translate' };
const other = { docId: 'paper-b', mode: 'chat' };
const empty = { text: '', attachments: [] };

check('document and mode switches restore their own complete drafts', () => {
  const store = createComposerDraftStore();
  const drafts = [
    [chat, { text: '解释这个公式', attachments: [{ id: 'quote', kind: 'text', page: 3, from: '', text: 'x = y' }] }],
    [translate, { text: 'Translate this paragraph.', attachments: [{ id: 'shot', kind: 'image', page: 4, dataUrl: 'data:image/png;base64,AAAA' }] }],
    [other, { text: '另一个论文的问题', attachments: [] }],
  ];
  for (const [owner, draft] of drafts) store.write(owner, draft);
  for (const [owner, draft] of drafts) assert.deepEqual(store.read({ ...owner }), draft);
  assert.deepEqual(store.read({ ...other, mode: 'translate' }), empty);
});

check('owner keys cannot collide through delimiters or object property names', () => {
  const store = createComposerDraftStore();
  for (const [i, docId] of ['a|chat', 'a|translate', '["a","chat"]', '__proto__', 'constructor'].entries()) {
    store.write({ docId, mode: 'chat' }, { text: String(i) });
  }
  for (const [i, docId] of ['a|chat', 'a|translate', '["a","chat"]', '__proto__', 'constructor'].entries()) {
    assert.equal(store.read({ docId, mode: 'chat' }).text, String(i));
    assert.deepEqual(store.read({ docId, mode: 'translate' }), empty);
  }
});

check('the no-document composer and separate store instances stay isolated', () => {
  const first = createComposerDraftStore();
  const second = createComposerDraftStore();
  first.write({ mode: 'chat' }, { text: '未打开论文时的问答' });
  first.write({ docId: null, mode: 'translate' }, { text: 'Independent translation' });
  assert.equal(first.read({ docId: '', mode: 'chat' }).text, '未打开论文时的问答');
  assert.equal(first.read({ docId: '', mode: 'translate' }).text, 'Independent translation');
  assert.deepEqual(first.read(chat), empty);
  assert.deepEqual(second.read({ mode: 'chat' }), empty);
});

check('writing copies the caller array and each attachment record', () => {
  const store = createComposerDraftStore();
  const source = { text: '保留原输入', attachments: [{ id: 'q', kind: 'text', text: 'original', page: 8, from: 'right' }] };
  store.write(chat, source);
  source.text = 'changed';
  source.attachments[0].text = 'changed';
  source.attachments[0].page = 99;
  source.attachments.push({ id: 'extra' });
  assert.deepEqual(store.read(chat), { text: '保留原输入', attachments: [{ id: 'q', kind: 'text', text: 'original', page: 8, from: 'right' }] });
});

check('read and write results cannot mutate the saved draft', () => {
  const store = createComposerDraftStore();
  const saved = { text: 'question', attachments: [{ id: 'q', kind: 'text', text: 'quote', page: null, from: 'right' }] };
  const written = store.write(chat, saved);
  written.text = 'changed';
  written.attachments[0].from = '';
  written.attachments.length = 0;
  const read = store.read(chat);
  read.attachments[0].page = 20;
  read.attachments.push({ id: 'extra' });
  assert.deepEqual(store.read(chat), saved);
  const missing = store.read(other);
  missing.attachments.push({ id: 'not-saved' });
  assert.deepEqual(store.read(other), empty);
});

check('long text, whitespace and screenshot metadata survive without truncation', () => {
  const store = createComposerDraftStore();
  const text = `  \n${'原文🙂 with symbols \\alpha\r\n'.repeat(6000)}\n  `;
  const dataUrl = `data:image/png;base64,${'AAAA'.repeat(250000)}`;
  const shot = { id: 'image', kind: 'image', page: 7, from: '', dataUrl, w: 1600, h: 2400, pages: 2, label: '跨页截图', ref: 'saved-image-ref' };
  const result = store.write(translate, { text, attachments: [shot] });
  assert.equal(result.text, text);
  assert.equal(result.attachments[0].dataUrl, dataUrl);
  assert.deepEqual(store.read(translate).attachments[0], shot);
  assert.notEqual(result.attachments[0], shot);
});

check('failure recovery preserves newer text and same-ID attachments', () => {
  const store = createComposerDraftStore();
  store.write(chat, { text: '发送期间新写的问题', attachments: [
    { id: 'shared', kind: 'text', text: 'newer quote', page: null, from: 'right' },
    { id: 'new', kind: 'text', text: 'new attachment', page: 9, from: '' },
  ] });
  const restored = store.restoreAttachments(chat, [
    { id: 'old', kind: 'image', page: 2, dataUrl: 'data:image/png;base64,AAAA' },
    { id: 'shared', kind: 'text', text: 'stale quote', page: 2, from: '' },
    { id: 'old', kind: 'image', page: 99, dataUrl: 'stale duplicate' },
  ]);
  assert.equal(restored.text, '发送期间新写的问题');
  assert.deepEqual(restored.attachments.map((a) => a.id), ['old', 'shared', 'new']);
  assert.equal(restored.attachments[0].page, 2);
  assert.deepEqual(restored.attachments[1], { id: 'shared', kind: 'text', text: 'newer quote', page: null, from: 'right' });
});

check('repeated recovery is idempotent and returns detached attachments', () => {
  const store = createComposerDraftStore();
  const sent = [{ id: 'shot', kind: 'image', page: 5, dataUrl: 'data:image/png;base64,BBBB' }];
  const first = store.restoreAttachments(chat, sent);
  assert.deepEqual(store.restoreAttachments(chat, sent), first);
  sent[0].page = 90;
  first.attachments[0].page = 91;
  first.attachments.push({ id: 'extra' });
  assert.deepEqual(store.read(chat), { text: '', attachments: [{ id: 'shot', kind: 'image', page: 5, dataUrl: 'data:image/png;base64,BBBB' }] });
});

check('a late failed send restores only its original document and mode', () => {
  const store = createComposerDraftStore();
  store.write(translate, { text: '新译文草稿', attachments: [{ id: 'translation-shot', page: 6 }] });
  store.write(other, { text: '另一篇论文的新问题', attachments: [{ id: 'other-quote', page: 1 }] });
  const nextTranslation = store.read(translate);
  const nextDocument = store.read(other);
  store.restoreAttachments(chat, [{ id: 'failed-quote', kind: 'text', text: 'old source', page: 2, from: '' }]);
  assert.deepEqual(store.read(translate), nextTranslation);
  assert.deepEqual(store.read(other), nextDocument);
  assert.equal(store.read(chat).text, '');
  assert.equal(store.read(chat).attachments[0].id, 'failed-quote');
});

check('clearing one owner leaves other drafts intact and returns a detached empty result', () => {
  const store = createComposerDraftStore();
  store.write(chat, { text: 'sent', attachments: [{ id: 'sent-shot' }] });
  store.write(translate, { text: 'unsent translation' });
  const cleared = store.clear(chat);
  assert.deepEqual(cleared, empty);
  cleared.text = 'not saved';
  cleared.attachments.push({ id: 'not-saved' });
  assert.deepEqual(store.read(chat), empty);
  assert.equal(store.read(translate).text, 'unsent translation');
  assert.deepEqual(store.clear(other), empty);
});

console.log(`Composer drafts: ${passed}/${passed} passed`);
