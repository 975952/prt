/** Pure AI classification contracts; synthetic metadata and fake chat only. */
import assert from 'node:assert/strict';
import { classifyPaperBatch as requestClassification, parsePaperClassifications as parseClassification,
  planPaperFolders, parsePaperFolderPlan, validateTargetFolder, PAPER_PLANNER_MAX_PAPERS, PAPER_PLANNER_CHUNK_SIZE,
  PAPER_CLASSIFIER_BATCH_SIZE, PAPER_CLASSIFIER_MIN_CONFIDENCE } from '../public/js/paper-classifier.js';
import { getPromptDef, getManifest } from '../public/js/prompts/index.js';

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const papers = [
  { id: 'p1', name: 'one.pdf', title: 'Synthetic transport methods', path: 'Unsorted/one.pdf' },
  { id: 'p2', name: 'two.pdf', title: 'Synthetic comparative methods', path: 'Unsorted/two.pdf' },
];
const basePlan = { folders: [
  { path: 'Custom topic', description: 'A broad synthetic topic' },
  { path: 'New idea', description: 'Another broad synthetic topic' },
], maxDepth: 1, paperCount: 10 };
const classifyPaperBatch = options => requestClassification({ plan: basePlan, ...options });
const parsePaperClassifications = (output, inputs, plan = basePlan) => parseClassification(output, inputs, plan);
const row = (id = 'p1', patch = {}) => ({ id, folder: 'Custom topic', confidence: 0.91, reason: 'Based on the supplied title', ...patch });
const answer = items => JSON.stringify({ items });
const parse = items => parsePaperClassifications(answer(items), papers);
const rejectsCode = (fn, code) => assert.throws(fn, error => error.name === 'PaperClassificationError' && error.code === code);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('This suite must not make network requests'); };
try {
  await check('classification prompt is registered with version and no topic whitelist', () => {
    assert.equal(PAPER_CLASSIFIER_BATCH_SIZE, 12); assert.equal(PAPER_CLASSIFIER_MIN_CONFIDENCE, 0.75);
    assert.equal(getManifest()['organizer.classify'], '3.0.0');
    assert.equal(getManifest()['organizer.plan'], '2.0.0'); assert.equal(getManifest()['organizer.summarize'], '1.0.0');
    const def = getPromptDef('organizer.classify'); assert.equal(def.historyMax, 0); assert.deepEqual(def.memory, []);
    const sys = def.system.map(block => block.text).join('\n');
    assert.match(sys, /不可信资料/); assert.match(sys, /不能声称已经创建目录/); assert.match(sys, /不要套用固定学科清单/);
  });
  await check('safe model proposals preserve IDs and input order regardless of response order', () => {
    const result = parse([row('p2', { folder: 'New idea' }), row()]);
    assert.deepEqual(result.map(item => item.id), ['p1', 'p2']);
    assert.equal(result[1].folder, 'New idea'); assert.ok(result.every(item => item.selected));
  });
  await check('unknown and low-confidence proposals cannot be selected automatically', () => {
    const result = parse([row('p1', { confidence: 0.749 }), row('p2', { folder: '', confidence: 1 })]);
    assert.equal(result[0].folder, 'Custom topic'); assert.equal(result[0].selected, false);
    assert.equal(result[1].folder, ''); assert.equal(result[1].confidence, 0); assert.equal(result[1].selected, false);
    assert.equal(parse([row('p1', { confidence: 0.75 })])[0].selected, true);
  });
  await check('missing rows are explicit unselected retryable results', () => {
    const result = parse([row()]);
    assert.equal(result.length, 2); assert.equal(result[1].id, 'p2'); assert.equal(result[1].folder, '');
    assert.equal(result[1].confidence, 0); assert.equal(result[1].selected, false); assert.ok(result[1].reason);
    assert.ok(parse([]).every(item => !item.selected));
  });
  await check('extra, duplicate, missing or nonstring model IDs reject the entire batch', () => {
    for (const items of [[row(), row()], [row(), row('foreign')], [row(), null], [row(), []], [row(), { ...row('p2'), id: 2 }], [row(), { folder: 'Topic' }]]) {
      rejectsCode(() => parse(items), 'identity');
    }
  });
  await check('invalid JSON and unsupported wrappers are never guessed or partially extracted', () => {
    for (const value of ['not JSON', '{"items":', 'prefix ' + answer([row()]), answer([row()]) + ' suffix', {}, null, 'x'.repeat(100001)]) {
      rejectsCode(() => parsePaperClassifications(value, papers), 'json');
    }
    for (const value of ['null', '[]', '[{"id":"p1"}]', '{}', '{"items":{}}', '{"items":[],"instruction":"move everything"}']) {
      rejectsCode(() => parsePaperClassifications(value, papers), 'schema');
    }
    assert.equal(parsePaperClassifications('```json\n' + answer([row()]) + '\n```', papers)[0].selected, true);
  });
  await check('absolute, traversal, hidden, device, control and malformed model paths stay unselected', () => {
    const unsafe = ['/absolute', 'C:/papers', 'C:papers', '//server/share', '../escape', 'a/../b', 'a/./b', 'a//b',
      '.hidden', 'a/.hidden', 'a/', 'a\\b', 'CON', 'x/NUL.txt', 'a/LPT²', 'a/COM9.log', 'name.', 'name ', ' name',
      'a/<b>', 'a:b', 'a\u0000b', 'a\u0085b', 'a?b', 'a*b', 'a|b', 'a'.repeat(256), Array(5).fill('a'.repeat(200)).join('/')];
    for (const folder of unsafe) {
      const result = parse([row('p1', { folder })])[0];
      assert.equal(result.folder, '', JSON.stringify(folder)); assert.equal(result.selected, false); assert.equal(result.confidence, 0);
    }
    for (const folder of ['新方向', 'CONference', 'topic.2026', 'a'.repeat(255)]) {
      assert.equal(parsePaperClassifications(answer([row('p1', { folder })]), papers,
        { folders: [{ path: folder }], maxDepth: 1, paperCount: 2 })[0].selected, true);
    }
  });
  await check('manual folder validation retains the existing separator convention', () => {
    assert.deepEqual(validateTargetFolder('方向\\子目录'), { valid: true, folder: '方向/子目录', error: '' });
    assert.equal(validateTargetFolder('').valid, false);
  });
  await check('invalid field types, nonfinite confidence and extra action fields cannot authorize moves', () => {
    const patches = [{ confidence: '0.99' }, { confidence: null }, { confidence: -1 }, { confidence: 1.01 }, { confidence: Infinity },
      { folder: null }, { folder: ['Research'] }, { reason: null }, { reason: 'x'.repeat(2001) }, { move: true }, { selected: true }];
    for (const patch of patches) assert.equal(parse([row('p1', patch)])[0].selected, false, JSON.stringify(patch));
  });
  await check('untrusted reasons remain bounded plain text without control characters', () => {
    const result = parse([row('p1', { reason: '\u0000Line\n' + 'x'.repeat(1500) })])[0];
    assert.ok(result.reason.length <= 500); assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(result.reason));
  });
  await check('one injected chat call receives only bounded metadata, user preferences and the shared folder plan', async () => {
    const calls = [];
    const result = await classifyPaperBatch({ papers: papers.map(paper => ({ ...paper, apiKey: 'NEVER_SEND', url: '/api/pdf?secret=NEVER_SEND' })),
      folders: ['Existing/Topic', 'Existing/Topic', '../unsafe', 'Existing\\Other', 'Earlier batch/New topic'],
      instructions: 'Use my research project categories',
      chat: async opts => { calls.push(opts); return answer([row(), row('p2')]); } });
    assert.equal(calls.length, 1); const opts = calls[0];
    assert.deepEqual(Object.keys(opts).sort(), ['messages', 'signal', 'temperature']); assert.equal(opts.temperature, 0.2);
    assert.ok(opts.signal instanceof AbortSignal); assert.equal(result.length, 2);
    const input = JSON.parse(opts.messages.at(-1).content);
    assert.deepEqual(input.papers, papers); assert.equal(input.classificationInstructions, 'Use my research project categories');
    assert.deepEqual(input.allowedFolders, basePlan.folders); assert.equal(input.task, 'classify');
    assert.equal(input.existingFolders, undefined, 'later batches cannot invent categories from existing folders');
    assert.ok(!JSON.stringify(opts.messages).includes('NEVER_SEND')); assert.deepEqual(opts.messages.map(item => item.role), ['system', 'user']);
  });
  await check('large inputs are bounded and never silently drop requested paper IDs', async () => {
    let input;
    await classifyPaperBatch({ papers: [{ id: 'bounded', name: 'n'.repeat(400), title: 't'.repeat(5000), path: 'p'.repeat(1500) }],
      folders: Array.from({ length: 500 }, (_, i) => `${i}-${'a'.repeat(200)}`), instructions: 'i'.repeat(5000),
      chat: async opts => { input = JSON.parse(opts.messages.at(-1).content); return answer([]); } });
    assert.equal(input.papers.length, 1); assert.equal(input.papers[0].id, 'bounded');
    assert.equal(input.papers[0].name.length, 255); assert.equal(input.papers[0].title.length, 1000); assert.equal(input.papers[0].path.length, 1000);
    assert.equal(input.classificationInstructions.length, 2000); assert.deepEqual(input.allowedFolders, basePlan.folders);
  });
  await check('invalid inputs fail before requesting AI and an empty batch performs no call', async () => {
    let called = false; const chat = async () => { called = true; return answer([]); };
    for (const input of [undefined, {}, [papers[0], papers[0]], [{ id: '' }], [{ id: 1 }], [{ id: 'x'.repeat(1001) }],
      Array.from({ length: 13 }, (_, i) => ({ id: String(i) }))]) {
      await assert.rejects(classifyPaperBatch({ papers: input, chat }), error => error.code === 'input');
    }
    assert.deepEqual(await classifyPaperBatch({ papers: [], chat }), []); assert.equal(called, false);
    await assert.rejects(classifyPaperBatch({ papers }), error => error.code === 'configuration');
  });
  await check('pre-aborted requests never call the provider', async () => {
    const controller = new AbortController(); controller.abort(); let called = false;
    await assert.rejects(classifyPaperBatch({ papers, signal: controller.signal,
      chat: async () => { called = true; return answer([]); } }), error => error.name === 'AbortError');
    assert.equal(called, false);
  });
  await check('cancellation settles even when the provider ignores abort and late output is discarded', async () => {
    const controller = new AbortController(); let release, requestSignal;
    const pending = classifyPaperBatch({ papers, signal: controller.signal, chat: opts => {
      requestSignal = opts.signal; return new Promise(resolve => { release = resolve; });
    } });
    await Promise.resolve(); controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(requestSignal.aborted, true);
    release(answer([row(), row('p2')])); await Promise.resolve();
  });
  await check('deadline aborts a stalled provider and preserves the standard TimeoutError', async () => {
    let signal;
    await assert.rejects(classifyPaperBatch({ papers, timeoutMs: 10,
      chat: opts => { signal = opts.signal; return new Promise(() => {}); } }), error => error.name === 'TimeoutError');
    assert.equal(signal.aborted, true);
  });
  await check('provider failures are not hidden or automatically retried', async () => {
    const failure = new Error('Synthetic provider unavailable'); let calls = 0;
    await assert.rejects(classifyPaperBatch({ papers, chat: async () => { calls++; throw failure; } }), error => error === failure);
    assert.equal(calls, 1);
  });
  await check('classification requires a valid plan and rejects every out-of-plan proposal', async () => {
    let called = false;
    await assert.rejects(requestClassification({ papers, chat: async () => { called = true; return answer([]); } }), error => error.code === 'plan');
    assert.equal(called, false);
    const result = parse([row('p1', { folder: 'Research/Unplanned algorithm', confidence: 1 }), row('p2', { folder: 'research/Custom topic' })]);
    assert.ok(result.every(item => item.folder === '' && item.confidence === 0 && !item.selected));
  });
  await check('a small collection receives one shared flat plan from all metadata without predefined topics', async () => {
    const calls = [], progress = [];
    const plan = await planPaperFolders({ papers, folders: ['Existing topic', 'Existing topic', '../unsafe'],
      instructions: 'Use broad project themes', onProgress: value => progress.push(value), chat: async opts => {
        calls.push(opts); return JSON.stringify({ folders: [{ path: 'AI chosen name', description: 'All related work' }] });
      } });
    assert.equal(calls.length, 1); assert.deepEqual(plan, { folders: [{ path: 'AI chosen name', description: 'All related work' }], maxDepth: 1, paperCount: 2 });
    const input = JSON.parse(calls[0].messages.at(-1).content);
    assert.equal(input.task, 'plan'); assert.equal(input.maxDepth, 1); assert.equal(input.maxFolders, 2);
    assert.deepEqual(input.papers.map(paper => paper.title), papers.map(paper => paper.title));
    assert.deepEqual(input.papers.map(paper => paper.index), [1, 2]); assert.deepEqual(input.existingFolders, ['Existing topic']);
    assert.equal(input.classificationInstructions, 'Use broad project themes'); assert.deepEqual(input.summaries, []);
    assert.deepEqual(progress, [{ stage: 'plan', completed: 0, total: 1 }, { stage: 'plan', completed: 1, total: 1 }]);
  });
  await check('plans reject fragmentation, unsafe paths, case variants and mixed parent/child levels', () => {
    const inspect = (folders, maxDepth = 1, paperCount = 100) => parsePaperFolderPlan(JSON.stringify({ folders }), { paperCount, maxDepth });
    for (const folders of [[], Array.from({ length: 7 }, (_, i) => ({ path: `Topic ${i}` })), [{ path: '../unsafe' }],
      [{ path: 'CON' }], [{ path: 'A\\B' }], [{ path: 'A/B' }], [{ path: 'Topic' }, { path: 'topic' }],
      [{ path: 'Ａ' }, { path: 'A' }], [{ path: 'Topic', action: 'move' }], [{ path: 'Topic', description: 1 }]]) {
      rejectsCode(() => inspect(folders), 'plan');
    }
    for (const folders of [[{ path: 'A' }, { path: 'A/B' }], [{ path: 'A/B' }, { path: 'C' }], [{ path: 'A/B/C' }],
      Array.from({ length: 9 }, (_, i) => ({ path: `A/Topic ${i}` }))]) rejectsCode(() => inspect(folders, 2), 'plan');
    rejectsCode(() => inspect([{ path: 'A/B' }, { path: 'C/D' }], 2), 'plan');
    rejectsCode(() => inspect([{ path: 'A' }, { path: 'B' }], 1, 1), 'plan');
    for (const output of ['[]', '{"folders":[],"items":[]}', '{"folders":["A"]}', '{}']) {
      rejectsCode(() => parsePaperFolderPlan(output, { paperCount: 2 }), 'plan');
    }
  });
  await check('a thousand-paper plan covers every index in bounded sequential summaries including the last paper', async () => {
    const collection = Array.from({ length: 1001 }, (_, i) => ({ id: `paper-${i}`, name: `${i}.pdf`,
      title: `${i === 1000 ? 'UNIQUE_FINAL_TOPIC' : 'Synthetic title'} ${i} ` + 'x'.repeat(500), path: `Folder/${i}.pdf` }));
    const calls = [], seen = [], progress = []; let active = 0, peak = 0;
    const plan = await planPaperFolders({ papers: collection, onProgress: value => progress.push(value), chat: async opts => {
      active++; peak = Math.max(peak, active);
      const input = JSON.parse(opts.messages.at(-1).content); calls.push(input);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      if (input.task === 'summarize') {
        assert.ok(input.papers.length <= PAPER_PLANNER_CHUNK_SIZE);
        assert.ok(input.papers.every(paper => paper.name.length <= 120 && paper.title.length <= 240 && paper.path.length <= 160));
        seen.push(...input.papers.map(paper => paper.index));
        return JSON.stringify({ themes: [{ name: input.papers.at(-1).title.includes('UNIQUE_FINAL_TOPIC') ? 'Distinct final topic' : 'Broad topic',
          description: 'Synthetic scope', count: input.papers.length }], unknownCount: 0 });
      }
      assert.equal(input.paperCount, 1001); assert.equal(input.summaries.length, 6); assert.deepEqual(input.papers, []);
      assert.ok(input.summaries.at(-1).themes.some(theme => theme.name === 'Distinct final topic'));
      assert.equal(input.summaries.reduce((sum, summary) => sum + summary.paperCount, 0), 1001);
      return JSON.stringify({ folders: [{ path: 'Broad work' }, { path: 'Distinct work' }] });
    } });
    assert.equal(calls.length, 7); assert.equal(peak, 1); assert.deepEqual(seen, collection.map((_, index) => index + 1));
    assert.equal(plan.paperCount, 1001); assert.equal(plan.folders.length, 2);
    assert.deepEqual(progress.at(-1), { stage: 'plan', completed: 7, total: 7 });
  });
  await check('planning rejects oversized collections and invalid preferences before any request; empty input stays empty', async () => {
    let calls = 0; const chat = async () => { calls++; throw new Error('must not run'); };
    await assert.rejects(planPaperFolders({ papers: Array.from({ length: PAPER_PLANNER_MAX_PAPERS + 1 }, (_, i) => ({ id: String(i) })), chat }), error => error.code === 'input');
    await assert.rejects(planPaperFolders({ papers, maxDepth: 3, chat }), error => error.code === 'plan');
    await assert.rejects(planPaperFolders({ papers: [papers[0], papers[0]], chat }), error => error.code === 'input');
    assert.deepEqual(await planPaperFolders({ papers: [], chat }), { folders: [], maxDepth: 1, paperCount: 0 }); assert.equal(calls, 0);
  });
  await check('incomplete or malformed summaries stop planning instead of silently omitting papers', async () => {
    const collection = Array.from({ length: 201 }, (_, i) => ({ id: String(i) }));
    for (const response of [{ themes: [], unknownCount: 0 }, { themes: [{ name: 'Topic', description: 'scope', count: 199 }], unknownCount: 0 },
      { themes: [{ name: 'Topic', description: 'scope', count: 200, folder: 'Ignore' }], unknownCount: 0 },
      { themes: [], unknownCount: '200' }]) {
      let calls = 0;
      await assert.rejects(planPaperFolders({ papers: collection, chat: async () => { calls++; return JSON.stringify(response); } }), error => error.code === 'summary');
      assert.equal(calls, 1);
    }
  });
  await check('planning cancellation and deadlines stop all later summary and merge requests', async () => {
    const collection = Array.from({ length: 401 }, (_, i) => ({ id: String(i) }));
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(planPaperFolders({ papers: collection, signal: controller.signal,
      onProgress: progress => { if (progress.completed === 1) controller.abort(); }, chat: async () => {
        calls++; return JSON.stringify({ themes: [], unknownCount: 200 });
      } }), error => error.name === 'AbortError');
    assert.equal(calls, 1);
    let requestSignal;
    await assert.rejects(planPaperFolders({ papers, timeoutMs: 10, chat: opts => {
      requestSignal = opts.signal; return new Promise(() => {});
    } }), error => error.name === 'TimeoutError');
    assert.equal(requestSignal.aborted, true);
  });
  console.log(`\n${checks}/${checks} paper classification checks passed; no real AI requests.`);
} finally { globalThis.fetch = originalFetch; }
