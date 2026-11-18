/** Pure navigation intent and planner boundaries; no model, files or network. */
import assert from 'node:assert/strict';
import { isPaperNavigationRequest, normalizePaperSearchPlan, PAPER_SEARCH_PLAN_PROMPT } from '../public/js/paper-request.js';
let count = 0;
function test(label, fn) { fn(); count++; console.log(`PASS ${label}`); }

test('plain Chinese and English paper navigation requests take the lookup lane', () => {
  for (const question of ['我想看t2t trans的论文', '帮我找到ResNet论文', '打开《Attention Is All You Need》',
    '找一下关于稀疏注意力的论文', '有没有视觉Transformer相关文献', '下载2101.11986.pdf',
    'Find the T2T-ViT paper', 'I want to read the Transformer paper', 'Open attention.pdf',
    'Look for papers about sparse attention', 'Can you show me the original ResNet paper?']) {
    assert.equal(isPaperNavigationRequest(question), true, question);
  }
});
test('content requests stay in the reading agent even when they also mention finding a paper', () => {
  for (const question of ['解释T2T论文', '我想看T2T论文的引言', '找T2T论文并总结', '找ResNet论文然后比较它与DenseNet',
    '这篇论文为什么要这样设计', '帮我找这篇论文的公式', '看看论文第3页', '找论文里这个结论在哪一页',
    '打开T2T论文并解释图2', '找T2T论文，带我读', '这篇论文是什么', '分析T2T和ViT的区别',
    '帮我找论文里提到的数据集', '我想看这篇论文的实验结果', '找T2T论文，讲下它做了什么',
    'Find the paper and explain it', 'Open this paper at page 4', 'Show the introduction of the paper',
    'Find and compare ResNet and DenseNet papers', 'I want to read the abstract of this paper',
    'Where is this equation in the paper?', 'Why does this paper use attention?', 'How do I implement the paper?',
    'Summarize this paper', 'Translate the paper', 'What is the Transformer paper about?',
    'Open the Transformer paper and tell me its core idea', 'Find the experiment in the paper']) {
    assert.equal(isPaperNavigationRequest(question, { previousDiscovery: true }), false, question);
  }
});
test('content words inside quoted titles do not override a navigation request', () => {
  for (const question of ['Find the paper “An Analysis of Vision Transformers”',
    '我想看《An Analysis of Vision Transformers》这篇论文',
    '打开《自注意力机制的分析与实现》', 'Find the paper "What Makes a Good Representation?"',
    '下载《A Comparison of Graph Neural Networks》论文']) {
    assert.equal(isPaperNavigationRequest(question), true, question);
  }
  for (const question of ['找《An Analysis of Vision Transformers》并分析方法',
    'Find “An Analysis of Vision Transformers” paper and explain it',
    'Show the introduction of "What Makes a Good Representation?" paper',
    '打开《自注意力机制的分析与实现》并总结', 'Explain “Attention Is All You Need”']) {
    assert.equal(isPaperNavigationRequest(question), false, question);
  }
});
test('one-paper corrections require discovery context and do not trigger unsolicited exposition', () => {
  for (const question of ['？我只需要那一篇论文', '只要那篇，不要解释', '就那篇就行', '打开它',
    'just that paper', 'only that paper, no explanation', 'I only need that paper', 'Open it']) {
    assert.equal(isPaperNavigationRequest(question, { previousDiscovery: true }), true, question);
    if (!/打开|Open/.test(question)) assert.equal(isPaperNavigationRequest(question), false, question);
  }
  assert.equal(isPaperNavigationRequest('只要那篇，帮我解释方法', { previousDiscovery: true }), false);
});
test('attachments general chat and explicitly rejected searches never enter the lookup lane', () => {
  assert.equal(isPaperNavigationRequest('找这篇论文', { hasAttachments: true, previousDiscovery: true }), false);
  for (const question of ['', 'This paper is useful', '这篇论文不错', '找一下天气', '我想看YouTube',
    '不要找论文', '我不是找论文', 'Do not search for the paper']) assert.equal(isPaperNavigationRequest(question), false, question);
});
test('valid single target drops unsolicited second queries and different canonical titles', () => {
  const result = normalizePaperSearchPlan({ queries: [
    { query: 'vision transformer target', mode: 'known', titles: ['The canonical vision paper', 'A different text paper'], aliases: ['ViT'], keywords: ['vision transformer'] },
    { query: 'unrequested text transformer', mode: 'known', titles: ['A different text paper'] },
  ] }, '我想看视觉transformer的论文');
  assert.equal(result.reliable, true); assert.equal(result.queries.length, 1);
  assert.deepEqual(result.queries[0].titles, ['The canonical vision paper']); assert.equal(result.queries[0].mode, 'known');
});
test('only explicitly plural paper requests allow multiple plans up to four', () => {
  const raw = { queries: Array.from({ length: 7 }, (_, index) => ({ query: `specific topic ${index}` })) };
  for (const question of ['找几篇稀疏注意力论文', '找3篇相关论文', '分别找ResNet和DenseNet的论文', 'Find papers about attention']) {
    assert.equal(normalizePaperSearchPlan(raw, question).queries.length, 4, question);
  }
  for (const question of ['我只需要那一篇论文', 'Find that paper', '找关于视觉和语言的论文',
    '不要多篇，只要那一篇论文', 'Just one paper, not multiple papers']) {
    assert.equal(normalizePaperSearchPlan(raw, question).queries.length, 1, question);
  }
});
test('legacy query and keywords responses remain reliable and normalized', () => {
  const result = normalizePaperSearchPlan('```json\n{"query":"  memory efficient attention  ","keywords":["FlashAttention","flashattention",null," attention "]}\n```', '找节约显存的论文');
  assert.equal(result.reliable, true);
  assert.deepEqual(result.queries, [{ query: 'memory efficient attention', keywords: ['FlashAttention', 'attention'], titles: [], aliases: [], mode: 'auto' }]);
});
test('invalid JSON shapes and invalid first targets fall back to the original request without claiming a reliable plan', () => {
  for (const raw of ['{invalid', '[]', 'null', '{}', '{"queries":[]}', { query: 'x' },
    { queries: [{ query: '' }, { query: 'Unsolicited second target' }] },
    'Here is the plan: {"query":"Invented title"}']) {
    assert.deepEqual(normalizePaperSearchPlan(raw, '我想看原来的论文'), { queries: [{ query: '我想看原来的论文', keywords: [], titles: [], aliases: [], mode: 'auto' }], reliable: false });
  }
});
test('planner fields are bounded and unknown properties do not reach discovery', () => {
  const result = normalizePaperSearchPlan({ query: 'q'.repeat(400), mode: 'unsafe', titles: ['t'.repeat(300)],
    aliases: ['  model name  ', 'MODEL NAME', ...Array.from({ length: 12 }, (_, n) => `${n}${'a'.repeat(150)}`)],
    keywords: Array.from({ length: 12 }, (_, n) => `${n}${'k'.repeat(150)}`), url: 'https://invented.example/paper' }, 'find a paper');
  const plan = result.queries[0];
  assert.equal(plan.query.length, 200); assert.equal(plan.titles[0].length, 200); assert.equal(plan.mode, 'auto');
  assert.equal(plan.aliases.length, 6); assert.equal(plan.aliases[0], 'model name'); assert.equal(plan.aliases[1].length, 100);
  assert.equal(plan.keywords.length, 6); assert.equal(plan.keywords[0].length, 100); assert.equal(plan.url, undefined);
});
test('an explicitly uncertain plan stays conservative and the planner prompt treats its knowledge as candidates', () => {
  assert.equal(normalizePaperSearchPlan({ query: 'some paper', reliable: false }, 'find that paper').reliable, false);
  assert.match(PAPER_SEARCH_PLAN_PROMPT, /PAPER_DISCOVERY_QUERY_PLAN/);
  assert.match(PAPER_SEARCH_PLAN_PROMPT, /provisional search candidates/);
  assert.match(PAPER_SEARCH_PLAN_PROMPT, /exactly one query/);
  assert.ok(!/T2T|T5/.test(PAPER_SEARCH_PLAN_PROMPT), 'general behavior must not depend on one paper acronym');
});
console.log(`Paper request: ${count}/${count} passed`);
