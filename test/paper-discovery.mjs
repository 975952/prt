/** Discovery contract checks with synthetic documents; no server or user library. */
import assert from 'node:assert/strict';
import { createPaperAccess } from '../public/js/paper-access.js';
import { discoverLocalPapers } from '../public/js/paper-discovery.js';

const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const paper = (path, extra = {}) => ({ path, name: path.split('/').pop(), folder: path.split('/').slice(0, -1).join('/'),
  url: `/pdf/${path}`, docId: `id:${path}`, ...extra });
function fixture(rows) {
  const opens = [], reads = [], aborts = [];
  const access = createPaperAccess({ idleMs: 0, openDocument: async (url, { signal }) => {
    opens.push(url);
    const pages = rows[url];
    if (pages instanceof Error) throw pages;
    if (!pages) throw new Error('Unknown fixture');
    return { numPages: pages.length,
      async readPageText(page, { signal: workSignal }) {
        reads.push([url, page]);
        workSignal.addEventListener('abort', () => aborts.push([url, page]), { once: true });
        return typeof pages[page - 1] === 'function' ? pages[page - 1](workSignal) : pages[page - 1];
      }, destroy() {},
    };
  } });
  return { access, opens, reads, aborts };
}
const filler = 'This document describes unrelated chemistry and laboratory measurements.';

{
  const numeric = paper('transformers/2307.08691.pdf'), other = paper('chemistry/overview.pdf');
  const pages = Array.from({ length: 42 }, () => filler);
  pages[39] = 'FlashAttention reduces memory use by using an IO-aware exact attention algorithm on GPUs.';
  const f = fixture({ [numeric.url]: pages, [other.url]: [filler] });
  const result = await discoverLocalPapers({ query: '帮我找减少注意力显存开销的文章',
    keywords: ['FlashAttention', 'memory efficient attention'], papers: [other, numeric], paperAccess: f.access });
  assert.equal(result.status, 'matched'); assert.equal(result.coverage.complete, true);
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].path, numeric.path);
  assert.equal(result.matches[0].docId, numeric.docId); assert.equal(result.matches[0].page, 40);
  assert.match(result.matches[0].snippet, /FlashAttention/);
  assert.equal(result.matches[0].matchKind, 'text');
  assert.equal(f.reads.length, 43, 'numeric filenames and late pages receive full text inspection');
  await f.access.clear(); pass('natural-language intent plus English synonyms finds evidence on page 40');
}

{
  const p = paper('reading/001.pdf', { displayTitle: 'Vision Transformers for Dense Prediction' });
  const q = paper('other/001.pdf', { displayTitle: 'A Study of Vision Transformers' });
  const f = fixture({ [p.url]: ['Vision transformers use attention to extract visual representations.'], [q.url]: [filler] });
  const result = await discoverLocalPapers({ query: '视觉 Transformer', keywords: ['vision transformers'],
    papers: [q, p], paperAccess: f.access });
  assert.equal(result.matches.length, 2); assert.equal(result.matches[0].path, p.path);
  assert.equal(result.matches[0].matchKind, 'title+text'); assert.equal(result.matches[1].page, null);
  assert.equal(new Set(result.matches.map(m => m.docId)).size, 2, 'same filenames retain independent identities');
  assert.equal(result.coverage.checked, 2); await f.access.clear();
  pass('known titles rank candidates while full text and duplicate-path identities remain intact');
}

{
  const p = paper('notes.pdf'), f = fixture({ [p.url]: [filler, 'The experimental protocol discusses bacterial staining.'] });
  const result = await discoverLocalPapers({ query: 'AI', papers: [p], paperAccess: f.access });
  assert.equal(result.status, 'not_found', 'AI must not match staining');
  assert.deepEqual(result.matches, []); assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.checked, 1); assert.equal(result.coverage.remaining, 0);
  await f.access.clear(); pass('only complete readable search can return not_found; acronym boundaries reject substrings');
}

{
  const blank = paper('scan.pdf'), mixed = paper('mixed.pdf'), broken = paper('broken.pdf');
  const f = fixture({ [blank.url]: ['', '1'], [mixed.url]: [filler, ''], [broken.url]: new Error('Damaged PDF') });
  const result = await discoverLocalPapers({ query: 'optimization', papers: [blank, mixed, broken], paperAccess: f.access });
  assert.equal(result.status, 'incomplete'); assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.checked, 2); assert.equal(result.coverage.unreadable, 2);
  assert.equal(result.coverage.readable, 1); assert.equal(result.coverage.textIncomplete, 1);
  assert.equal(result.coverage.remaining, 1); assert.equal(result.coverage.textlessPages, 3);
  assert.deepEqual(result.coverage.issues.map(i => i.reason).sort(), ['missing_text', 'partial_text', 'read_error']);
  assert.match(result.coverage.issues.find(i => i.reason === 'read_error').message, /Damaged/);
  await f.access.clear(); pass('scans and corrupt PDFs are unreadable; a partial text layer stays readable but coverage remains incomplete');
}

{
  const p = paper('readable.pdf'), q = paper('scan.pdf');
  const f = fixture({ [p.url]: ['This article introduces a sparse attention mechanism for long sequences.'], [q.url]: [''] });
  const result = await discoverLocalPapers({ query: 'sparse attention', papers: [p, q], paperAccess: f.access });
  assert.equal(result.status, 'matched'); assert.equal(result.coverage.complete, false);
  assert.equal(result.matches[0].page, 1); assert.equal(result.coverage.unreadable, 1);
  await f.access.clear(); pass('verified matches survive incomplete coverage with that limitation retained');
}

{
  const p = paper('symbols.pdf');
  const f = fixture({ [p.url]: ['We propose SELF—ATTENTION layers. 自注意力机制能够结合上下文信息来构建序列表示。'] });
  const result = await discoverLocalPapers({ query: '自注意力', keywords: ['self-attention', 'SELF ATTENTION'],
    papers: [p], paperAccess: f.access });
  assert.equal(result.status, 'matched'); assert.match(result.matches[0].snippet, /SELF—ATTENTION/);
  assert.deepEqual(result.keywords, ['自注意力', 'self-attention']);
  assert.equal(result.matches[0].matchedKeywords.length, 2);
  await f.access.clear(); pass('Chinese phrases and punctuation-normalized English synonyms keep readable evidence');
}

{
  const rows = Array.from({ length: 12 }, (_, n) => paper(`topic-${n}.pdf`));
  const f = fixture(Object.fromEntries(rows.map(p => [p.url, ['A sparse attention method supports efficient inference and learning.']])));
  const result = await discoverLocalPapers({ query: 'sparse attention', papers: rows, paperAccess: f.access, maxResults: 3 });
  assert.equal(result.matches.length, 3); assert.equal(result.coverage.checked, 12);
  assert.equal(result.coverage.complete, true); assert.equal(f.reads.length, 12);
  await f.access.clear(); pass('result limit never stops library coverage or scanning of matching pages');
}

{
  const p = paper('slow.pdf'), q = paper('later.pdf');
  let observedSignal;
  const started = Date.now();
  const result = await discoverLocalPapers({ query: 'attention', papers: [p, q], timeBudgetMs: 25,
    paperAccess: { search: (url, query, options) => { observedSignal = options.signal; return new Promise(() => {}); } } });
  assert.equal(result.status, 'incomplete'); assert.equal(result.coverage.timedOut, true);
  assert.equal(result.coverage.remaining, 2); assert.equal(result.coverage.checked, 0);
  assert.equal(observedSignal.aborted, true); assert.ok(Date.now() - started < 500, 'outer deadline bounds non-cooperative adapters');
  pass('total deadline aborts a hanging extractor and retains unsearched coverage');
}

{
  const p = paper('partial.pdf');
  const result = await discoverLocalPapers({ query: 'attention', papers: [p], paperAccess: {
    search: async (url, query, options) => {
      options.matchPage({ page: 1, text: 'An attention mechanism processes sequences with learned interactions.' });
      return { numPages: 10, scanned: 1, complete: false, truncated: true, timedOut: true, hits: [] };
    },
  } });
  assert.equal(result.status, 'matched'); assert.equal(result.matches[0].page, 1);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.partial, 1);
  assert.equal(result.coverage.timedOut, true); assert.equal(result.coverage.checked, 0);
  pass('adapter partial-timeout reports retain collected evidence without claiming completion');
}

{
  const p = paper('late.pdf'); let lateMatcher;
  const result = await discoverLocalPapers({ query: 'attention', papers: [p], timeBudgetMs: 10,
    paperAccess: { search: (url, query, options) => {
      lateMatcher = options.matchPage;
      return new Promise(() => {});
    } } });
  assert.throws(() => lateMatcher({ page: 1, text: 'A late attention mechanism result must be ignored.' }), { name: 'TimeoutError' });
  assert.equal(result.matches.length, 0); assert.equal(result.coverage.checked, 0);
  pass('late extraction callbacks cannot mutate a timed-out discovery snapshot');
}

{
  const controller = new AbortController(), p = paper('cancel.pdf');
  let innerSignal, calls = 0;
  const pending = discoverLocalPapers({ query: 'attention', papers: [p], signal: controller.signal,
    paperAccess: { search: (url, query, options) => { calls++; innerSignal = options.signal; return new Promise(() => {}); } } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected; assert.equal(innerSignal.aborted, true);
  await assert.rejects(discoverLocalPapers({ query: 'attention', papers: [p], signal: controller.signal,
    paperAccess: { search: () => { calls++; } } }), { name: 'AbortError' });
  assert.equal(calls, 1); pass('caller cancellation propagates immediately and pre-aborted runs do no work');
}

{
  const p = paper('zero.pdf'); let calls = 0;
  const result = await discoverLocalPapers({ query: 'attention', papers: [p], timeBudgetMs: 0,
    paperAccess: { search: () => { calls++; } } });
  assert.equal(result.status, 'incomplete'); assert.equal(calls, 0);
  const empty = await discoverLocalPapers({ query: 'attention', papers: [], paperAccess: { search() {} } });
  assert.equal(empty.status, 'not_found'); assert.equal(empty.coverage.complete, true);
  await assert.rejects(discoverLocalPapers({ query: ' ', papers: [], paperAccess: { search() {} } }), TypeError);
  await assert.rejects(discoverLocalPapers({ query: 'attention', paperAccess: { search() {} } }), TypeError);
  await wait(0); pass('zero budget, empty library, and invalid input have explicit safe outcomes');
}

{
  const target = paper('2101.11986.pdf', { displayTitle: '2101.11986 · Tokens-to-Token ViT: Training Vision Transformers from Scratch on ImageNet' });
  const swin = paper('2103.14030.pdf', { displayTitle: 'Swin Transformer: Hierarchical Vision Transformer using Shifted Windows' });
  const twins = paper('2104.13840.pdf', { displayTitle: 'Twins: Revisiting the Design of Spatial Attention in Vision Transformers' });
  const v2 = paper('t2t-v2.pdf', { displayTitle: 'T2T-ViT V2: Improved Tokenization for Vision Transformers' });
  const f = fixture({
    [target.url]: ['Tokens-to-Token ViT: Training Vision Transformers from Scratch on ImageNet\nLi Yuan and collaborators\nAbstract\nWe introduce a new tokens-to-token transformation.', filler],
    [swin.url]: ['Swin Transformer: Hierarchical Vision Transformer using Shifted Windows\nAbstract\nWe study hierarchical window attention.', 'References\n[1] Yuan et al. Tokens-to-Token ViT: Training Vision Transformers from Scratch on ImageNet. 2021.'],
    [twins.url]: ['Twins: Revisiting the Design of Spatial Attention in Vision Transformers\nAbstract\nOur architecture uses two attention mechanisms.', 'References\n[2] Yuan et al. T2T-ViT: Training Vision Transformers from Scratch. 2021.'],
    [v2.url]: ['T2T-ViT V2: Improved Tokenization for Vision Transformers\nAbstract\nWe improve the earlier T2T-ViT model.'],
  });
  const result = await discoverLocalPapers({ query: '我想看T2T-ViT', mode: 'known',
    titles: ['Tokens-to-Token ViT: Training Vision Transformers from Scratch on ImageNet'], aliases: ['T2T-ViT', 'Tokens-to-Token ViT'],
    keywords: ['vision transformer', 'tokenization'], papers: [swin, twins, v2, target], paperAccess: f.access });
  assert.equal(result.mode, 'known'); assert.equal(result.status, 'matched');
  assert.deepEqual(result.matches.map(row => row.path), [target.path]);
  assert.equal(result.matches[0].relation, 'identity'); assert.equal(result.matches[0].page, 1);
  assert.ok(!result.matches[0].title.startsWith('2101.11986'));
  assert.deepEqual(result.referenceMatches.map(row => row.path).sort(), [swin.path, twins.path].sort());
  assert.ok(result.relatedMatches.some(row => row.path === v2.path));
  assert.ok(result.referenceMatches.every(row => row.relation === 'mention'));
  await f.access.clear(); pass('a specific T2T-ViT request returns its own paper, not Swin/Twins references or the V2 follow-up');
}

{
  const p = paper('reference-only.pdf', { displayTitle: 'Unrelated Architecture Study' });
  const f = fixture({ [p.url]: [filler, 'References\n[9] He, Zhang, Ren, Sun. Deep Residual Learning for Image Recognition. ResNet. 2016.'] });
  const result = await discoverLocalPapers({ query: '打开ResNet论文', mode: 'known', aliases: ['ResNet'],
    titles: ['Deep Residual Learning for Image Recognition'], papers: [p], paperAccess: f.access });
  assert.equal(result.status, 'not_found'); assert.equal(result.matches.length, 0);
  assert.equal(result.referenceMatches[0].path, p.path); assert.equal(result.referenceMatches[0].page, 2);
  assert.equal(result.coverage.complete, true);
  await f.access.clear(); pass('references alone never establish that the requested paper is in the library');
}

{
  const original = paper('resnet.pdf', { title: 'Deep Residual Learning for Image Recognition' });
  const followup = paper('resnet-v2.pdf', { title: 'ResNet V2: Improved Residual Representations' });
  const analysis = paper('analysis.pdf', { title: 'An Analysis of ResNet Architectures' });
  const f = fixture({ [original.url]: ['Deep Residual Learning for Image Recognition\nAbstract\nWe present residual learning for deep networks.'],
    [followup.url]: ['ResNet V2: Improved Residual Representations\nAbstract\nThis follow-up develops improved representations.'],
    [analysis.url]: ['An Analysis of ResNet Architectures\nAbstract\nResNet models are compared in this evaluation.'] });
  const base = await discoverLocalPapers({ query: 'ResNet', mode: 'known', aliases: ['ResNet'],
    titles: ['Deep Residual Learning for Image Recognition'], papers: [analysis, followup, original], paperAccess: f.access });
  assert.deepEqual(base.matches.map(row => row.path), [original.path]);
  assert.equal(base.relatedMatches.length, 2);
  const v2 = await discoverLocalPapers({ query: 'ResNet V2', mode: 'known', aliases: ['ResNet', 'ResNet V2'],
    papers: [original, followup, analysis], paperAccess: f.access });
  assert.deepEqual(v2.matches.map(row => row.path), [followup.path]);
  await f.access.clear(); pass('identity rules generalize to ResNet and keep requested V2 separate from original and analysis papers');
}

{
  const numeric = paper('98765.pdf'), discussion = paper('discussion.pdf');
  const f = fixture({ [numeric.url]: ['DenseNet: Densely Connected Convolutional Networks\nSynthetic authors\nAbstract\nWe connect layers for efficient feature reuse.'],
    [discussion.url]: ['DenseNet is widely used in modern image classification experiments.'] });
  const result = await discoverLocalPapers({ query: '我想看DenseNet', papers: [discussion, numeric], paperAccess: f.access });
  assert.equal(result.mode, 'known'); assert.deepEqual(result.matches.map(row => row.path), [numeric.path]);
  assert.equal(result.matches[0].matchKind, 'first-page-title');
  assert.ok(result.relatedMatches.some(row => row.path === discussion.path));
  await f.access.clear(); pass('auto mode recognizes a named paper and distinguishes a first-page heading from a sentence mentioning it');
}

{
  const primary = paper('topics.pdf'), bibliography = paper('bibliography.pdf');
  const f = fixture({ [primary.url]: ['This work develops efficient sparse attention for sequence learning.'],
    [bibliography.url]: [filler, 'References\n[1] Smith et al. Efficient sparse attention. 2022.\n[2] Jones et al. Long sequence learning. 2023.'] });
  const result = await discoverLocalPapers({ query: '想找稀疏注意力相关论文', mode: 'topic', keywords: ['sparse attention'],
    papers: [bibliography, primary], paperAccess: f.access });
  assert.deepEqual(result.matches.map(row => row.path), [primary.path]);
  assert.equal(result.matches[0].relation, 'topic'); assert.equal(result.referenceMatches[0].path, bibliography.path);
  await f.access.clear(); pass('topical discovery still uses body evidence but excludes bibliography-only matches');
}

{
  const p = paper('blank-last-page.pdf', { title: 'Deep Residual Learning for Image Recognition' });
  const f = fixture({ [p.url]: ['Deep Residual Learning for Image Recognition\nAbstract\nWe present residual learning.', ''] });
  const result = await discoverLocalPapers({ query: 'ResNet', mode: 'known', titles: ['Deep Residual Learning for Image Recognition'],
    papers: [p], paperAccess: f.access });
  assert.equal(result.status, 'matched'); assert.equal(result.coverage.unreadable, 0);
  assert.equal(result.coverage.readable, 1); assert.equal(result.coverage.textIncomplete, 1);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.issues[0].reason, 'partial_text');
  await f.access.clear(); pass('one blank page does not label an otherwise readable matching paper as unreadable');
}

{
  const v1 = paper('1706.03762v1.pdf', { title: 'Attention Is All You Need' });
  const v2 = paper('1706.03762v2.pdf', { title: 'Attention Is All You Need' });
  const f = fixture({ [v1.url]: ['Attention Is All You Need Abstract This is the original archived paper version.'],
    [v2.url]: ['Attention Is All You Need Abstract This is the revised archived paper version.'] });
  const requested = await discoverLocalPapers({ query: 'Attention Is All You Need v2', mode: 'known',
    titles: ['Attention Is All You Need'], papers: [v1, v2], paperAccess: f.access });
  assert.deepEqual(requested.matches.map(row => row.path), [v2.path]);
  assert.equal(requested.matches[0].page, 1);
  const unspecified = await discoverLocalPapers({ query: 'Attention Is All You Need', mode: 'known',
    titles: ['Attention Is All You Need'], papers: [v1, v2], paperAccess: f.access });
  assert.equal(unspecified.matches.length, 2, 'both archived revisions retain stable paths when no revision was requested');
  await f.access.clear(); pass('same-title arXiv revisions respect an explicit version while flat first-page text remains usable');
}

{
  const derivative = paper('medical.pdf', { title: 'T2T-ViT for Medical Image Segmentation' });
  const misleading = paper('T2T-ViT.pdf', { title: 'An Analysis of Vision Transformers' });
  const alternate = paper('original.pdf', { title: 'T2T-ViT: Training Vision Transformers from Scratch on ImageNet' });
  const f = fixture({ [derivative.url]: ['T2T-ViT for Medical Image Segmentation\nAbstract\nWe adapt a known method to medical imaging.'],
    [misleading.url]: ['An Analysis of Vision Transformers\nAbstract\nOur study compares several architectures.'],
    [alternate.url]: ['T2T-ViT: Training Vision Transformers from Scratch on ImageNet\nAbstract\nWe train vision transformers from scratch.'] });
  const result = await discoverLocalPapers({ query: '我想看T2T-ViT', mode: 'known',
    titles: ['Tokens-to-Token ViT: Training Vision Transformers from Scratch on ImageNet'], aliases: ['T2T-ViT'],
    papers: [derivative, misleading, alternate], paperAccess: f.access });
  assert.deepEqual(result.matches.map(row => row.path), [alternate.path]);
  assert.ok(result.relatedMatches.some(row => row.path === derivative.path));
  assert.ok(result.relatedMatches.some(row => row.path === misleading.path));
  await f.access.clear(); pass('a canonical title defeats derivative alias prefixes and misleading filenames while accepting equivalent subtitles');
}

{
  const title = 'Tokens-to-Token ViT: Training Vision Transformers from Scratch on ImageNet';
  const wrong = paper('wrong/T2T-ViT.pdf'), bodyOnly = paper('body-only/T2T-ViT.pdf'), good = paper('good/T2T-ViT.pdf');
  const f = fixture({
    [wrong.url]: ['Swin Transformer: Hierarchical Vision Transformer using Shifted Windows\nSynthetic authors\nAbstract\nWe propose shifted windows.',
      'Our baseline comparison includes T2T-ViT.'],
    [bodyOnly.url]: ['This work uses T2T-ViT for image classification.'],
    [good.url]: [`${title}\nSynthetic authors\nAbstract\nOur method uses progressive tokenization.`,
      'A related paper is Swin Transformer: Hierarchical Vision Transformer using Shifted Windows.'],
  });
  const result = await discoverLocalPapers({ query: 'T2T-ViT', mode: 'known', titles: [title], aliases: ['T2T-ViT'],
    papers: [wrong, bodyOnly, good], paperAccess: f.access });
  assert.deepEqual(result.matches.map(row => row.path).sort(), [bodyOnly.path, good.path].sort());
  assert.ok(result.relatedMatches.some(row => row.path === wrong.path));
  assert.ok(!result.matches.some(row => row.path === wrong.path), 'a contradictory first-page title defeats a misleading filename');
  const aliasOnly = await discoverLocalPapers({ query: 'T2T-ViT', mode: 'known', aliases: ['T2T-ViT'],
    papers: [good], paperAccess: f.access });
  assert.equal(aliasOnly.matches.length, 1, 'an unknown canonical title is not disproved just because its expanded form differs from the acronym');
  await f.access.clear(); pass('confident first-page titles override filename-only identities without mistaking ordinary body text for a title');
}

console.log(`\n${checks.length}/${checks.length} paper discovery checks passed.`);
