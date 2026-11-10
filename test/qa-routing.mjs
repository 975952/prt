import assert from 'node:assert/strict';
import { needsDocumentLookup } from '../public/js/reading-context.js';

for (const inputValue of ['什么是自注意力？', '为什么要除以根号d？', '这段话是什么意思？', '帮我翻译一下', '解释这张图', '能举个具体例子吗？', '矩阵乘法怎么计算？', '这个方法为什么更快？', 'What is self-attention?']) {
  assert.equal(needsDocumentLookup({ inputValue }), false, inputValue);
}
for (const inputValue of ['查一下原文', '去查啊', '核对这个公式', '找出定义的页码', '第3页讲什么？', '第三页的定理', '前几个PDF有没有提到这个？', '这篇论文的核心方法是什么？', '总结这篇论文', '本文主要贡献是什么', '请在文件夹里找例子', '你确定吗？', 'Verify the source on page 3', 'Search all papers']) {
  assert.equal(needsDocumentLookup({ inputValue }), true, inputValue);
}
for (const flag of ['forceFull', 'useFullText', 'useWeb']) assert.equal(needsDocumentLookup({ inputValue: '解释一下', [flag]: true }), true, flag);
console.log('PASS: ordinary questions use current materials; explicit lookup, document tasks and scope selections retain retrieval');
