/** Pure streaming boundary and numbered-answer tests. No DOM, model calls or user data. */
import assert from 'node:assert/strict';
import { completedMarkdownEnd, splitAnswerSections, unfinishedDisplayMathStart } from '../public/js/output-flow.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const prefix = 'An introductory paragraph.\n\n';

check('freezes completed paragraphs, retaining partial lines and table tails', () => {
  assert.equal(completedMarkdownEnd('One line'), 0);
  assert.equal(completedMarkdownEnd('One line\n'), 0);
  assert.equal(completedMarkdownEnd(prefix + 'unfinished'), prefix.length);
  const table = '| A | B |\n|---|---|\n| 1 | 2 |\n';
  assert.equal(completedMarkdownEnd(prefix + table), prefix.length);
  assert.equal(completedMarkdownEnd(prefix + table + '\n'), prefix.length + table.length + 1);
});

check('loose and nested lists are not split at their internal blank lines', () => {
  const list = '- First item\n\n  Continuation paragraph\n\n  - Nested item\n\n    More detail\n\n- Second item\n\n';
  for (let i = 0; i <= list.length; i++) {
    assert.equal(completedMarkdownEnd(prefix + list.slice(0, i)), prefix.length, `list offset ${i}`);
  }
  const full = prefix + list + 'Next paragraph.\n';
  assert.equal(completedMarkdownEnd(full), prefix.length + list.length);
});

check('numbered lists, tab-indented continuations and internal fences remain one block', () => {
  const list = '1. First\n\n\tContinuation\n\n2. Code:\n\n   ```js\n   a();\n\n   b();\n   ```\n\n3. Last\n\n';
  assert.equal(completedMarkdownEnd(prefix + list), prefix.length);
  assert.equal(completedMarkdownEnd(prefix + list + '## Next\n'), prefix.length + list.length);
});

check('quotes and indented code keep their interior blank lines', () => {
  for (const block of [
    '> First\n>\n> Second\n\n> Third\n\n',
    '    a();\n\n    b();\n\n',
  ]) {
    assert.equal(completedMarkdownEnd(prefix + block), prefix.length);
    assert.equal(completedMarkdownEnd(prefix + block + 'Next paragraph.\n'), prefix.length + block.length);
  }
});

check('fence type and length must match before a code block can freeze', () => {
  const open = '````md\n## 第1题\n\n```\n\n~~~\n';
  assert.equal(completedMarkdownEnd(prefix + open), prefix.length);
  const close = '`````\n';
  assert.equal(completedMarkdownEnd(prefix + open + close), prefix.length + open.length + close.length);
  assert.equal(completedMarkdownEnd('~~~js\nx();\n\n'), 0);
  assert.equal(completedMarkdownEnd('~~~js\nx();\n~~~\n'), '~~~js\nx();\n~~~\n'.length);
});

check('list and quote syntax inside code cannot masquerade as a closing fence', () => {
  for (const fake of ['> ```', '- ```', '    ```']) {
    const block = `\`\`\`md\n${fake}\n\n## 第1题\n## 第2题\n`;
    assert.equal(completedMarkdownEnd(prefix + block), prefix.length);
    assert.equal(splitAnswerSections(block), null);
  }
  const quoted = '> ```md\n> > ```\n>\n> ## 第1题\n> ## 第2题\n> ```\n\n';
  assert.equal(completedMarkdownEnd(prefix + quoted), prefix.length);
  assert.equal(completedMarkdownEnd(prefix + quoted + 'Next.\n'), prefix.length + quoted.length);
});

check('display math cannot freeze until its own closing delimiter', () => {
  for (const [open, close] of [['$$', '$$'], ['\\[', '\\]']]) {
    const block = `${open}\nx^2 +\n\ny^2\n`;
    for (let i = 0; i <= block.length; i++) {
      assert.equal(completedMarkdownEnd(prefix + block.slice(0, i)), prefix.length, `${open} offset ${i}`);
    }
    const full = prefix + block + close + '\n';
    assert.equal(completedMarkdownEnd(full), full.length);
  }
  assert.equal(completedMarkdownEnd('$$x = 1$$\n'), '$$x = 1$$\n'.length);
  assert.equal(completedMarkdownEnd('\\[x = 1\\]\n'), '\\[x = 1\\]\n'.length);
});

check('escaped math tokens and inline code do not open display formulas', () => {
  for (const block of ['Literal \\$$ marker.\n\n', 'Literal `$$` marker.\n\n', 'Literal `\\[` marker.\n\n']) {
    assert.equal(completedMarkdownEnd(block), block.length);
  }
  assert.equal(completedMarkdownEnd('Text before $$\nx\n\n'), 0);
});

check('incremental from offsets equal full scans for every character slice', () => {
  const text = prefix + '- one\n\n  - nested\n\n- two\n\nNext.\n\n'
    + '```js\nx();\n\n```\n\n\\[\nx^2\n\n\\]\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nTail';
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    const part = text.slice(0, i);
    const actual = completedMarkdownEnd(part, from);
    assert.equal(actual, completedMarkdownEnd(part), `offset ${i}`);
    assert.ok(actual >= from && actual <= part.length);
    from = actual;
  }
});

check('CRLF positions refer to original text and invalid offsets fail back to a full scan', () => {
  const text = 'Intro\r\n\r\n- item\r\n\r\n  detail\r\n\r\nNext\r\n';
  const expected = text.indexOf('Next');
  assert.equal(completedMarkdownEnd(text), expected);
  for (const from of [-1, 1, 1.2, text.length + 5, NaN]) assert.equal(completedMarkdownEnd(text, from), expected);
});

check('question sections preserve intro, exact source and numbered heading variations', () => {
  const text = 'Intro\n\n## 第1题：定义\nA\n\n### 第 2 题\nB\n\n#### （3） More\nC';
  const split = splitAnswerSections(text);
  assert.equal(split.intro, 'Intro\n\n');
  assert.equal(split.sections.length, 3);
  assert.ok(split.sections[0].startsWith('## 第1题'));
  assert.ok(split.sections[2].startsWith('#### （3）'));
  assert.equal(split.intro + split.sections.join(''), text);
});

check('numbered headings inside fences, formulas and indented code are ignored', () => {
  const text = '```md\n## 第1题\n\n## 第2题\n```\n\n'
    + '$$\n## 第1题\n## 第2题\n$$\n\n'
    + '\\[\n## 第1题\n## 第2题\n\\]\n\n'
    + '    ## 第1题\n    ## 第2题\n\n';
  assert.equal(splitAnswerSections(text), null);
  const real = text + '## 第1题\nReal A\n\n## 第2题\nReal B';
  const split = splitAnswerSections(real);
  assert.equal(split.intro, text);
  assert.equal(split.sections.length, 2);
});

check('only contiguous question numbers activate the multi-question layout', () => {
  for (const text of [
    '', '## 第1题\nA', '## 第2题\nA\n## 第3题\nB', '## 第1题\nA\n## 第3题\nB',
    '## 第1题\nA\n## 第1题\nB', '# 第1题\nA\n# 第2题\nB', '## Methods\nA\n## Results\nB',
    '> ## 第1题\n> A\n> ## 第2题\n> B', '## 第1题内容\nA\n## 第2题内容\nB',
  ]) assert.equal(splitAnswerSections(text), null, text);
});

check('partial streams never split on fake headings in open code or math', () => {
  const text = '## 第1题\nA\n\n```md\n## 第2题\n```\n\n\\[\n## 第2题\n\\]\n\n## 第2题\nB';
  const realSecond = text.lastIndexOf('## 第2题');
  for (let i = 0; i < realSecond + '## 第2题'.length; i++) {
    assert.equal(splitAnswerSections(text.slice(0, i)), null, `offset ${i}`);
  }
  assert.equal(splitAnswerSections(text).sections.length, 2);
});

check('unfinished display math reports exact source offsets including a partial final line', () => {
  for (const [open, close] of [['$$', '$$'], ['\\[', '\\]']]) {
    const text = prefix + open + '\nx^2 + y^2';
    assert.equal(unfinishedDisplayMathStart(text), prefix.length);
    assert.equal(unfinishedDisplayMathStart(text + close), -1);
    for (let i = prefix.length + open.length; i <= text.length; i++) {
      assert.equal(unfinishedDisplayMathStart(text.slice(0, i)), prefix.length);
    }
  }
  const text = '前文\r\n\r\nText before $$\nx';
  assert.equal(unfinishedDisplayMathStart(text), text.indexOf('$$'));
  assert.equal(unfinishedDisplayMathStart('$$x$$\n\n\\[y'), '$$x$$\n\n'.length);
});

check('unfinished math excludes fenced code, escaped tokens and inline code', () => {
  for (const text of ['```tex\n$$\n', '```tex\n> ```\n$$\n', '    $$\n', '`$$`', '\\$$', '`\\[`']) {
    assert.equal(unfinishedDisplayMathStart(text), -1, text);
  }
  assert.equal(unfinishedDisplayMathStart('```tex\n$$\n```\n\\['), '```tex\n$$\n```\n'.length);
});

console.log(`\n${passed} output flow checks passed.`);
