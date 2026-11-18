/**
 * A 线 P2.5：Agent 只读工具循环单测（纯 Node，不需要浏览器/网络）。
 *
 *   node test/agent-unit.mjs
 *
 * 覆盖：工具 schema/参数校验、模型响应解析、只读工具执行、有界循环
 * （最多 AGENT_MAX_ROUNDS 轮 / 每轮最多 AGENT_MAX_CALLS_PER_ROUND 个 / 总超时 / abort）、
 * 读过页的收集、失败回退信号。
 */
globalThis.localStorage = { getItem: key => key === 'reader.locale' ? 'zh-CN' : null };
const {
  AGENT_MAX_ROUNDS, AGENT_MAX_CALLS_PER_ROUND, AGENT_TOOL_SPECS, AGENT_SYSTEM_NOTE,
  validateToolCall, parseModelResponse, executeToolCall, runAgentLoop, agentStats,
  toolStepLabel, summarizeToolResult,
} = await import('../public/js/agent.js');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass++;
  else failures.push({ name, detail });
};

/* ── 1. 工具声明 ── */
console.log('▶ 工具声明');
check('12 个只读工具', AGENT_TOOL_SPECS.length === 12, String(AGENT_TOOL_SPECS.length));
check('全部是 function 形状', AGENT_TOOL_SPECS.every((t) => t.type === 'function' && t.function.name && t.function.parameters));
check('工具名符合契约', AGENT_TOOL_SPECS.map((t) => t.function.name).join(',')
  === 'discover_papers,search_web,get_reading_state,read_page,search_paper,read_scan_page,read_page_image,read_memory,list_papers,search_papers,read_other_paper,read_other_paper_image');
check('system 说明里的轮次上限与常量一致',
  new RegExp(`最多 ${AGENT_MAX_ROUNDS} 轮、每轮最多 ${AGENT_MAX_CALLS_PER_ROUND} 个`).test(AGENT_SYSTEM_NOTE));

/* ── 2. 参数校验 ── */
console.log('\n▶ 工具参数校验');
const v = (name, args, opts) => validateToolCall({ name, args }, opts);
check('未知工具被拒', !!v('rm_rf', {}).error);
check('read_page 页码合法', !v('read_page', { page: 5 }, { numPages: 9 }).error);
check('read_page 页码 0 被拒', !!v('read_page', { page: 0 }, { numPages: 9 }).error);
check('read_page 超过总页数被拒', !!v('read_page', { page: 10 }, { numPages: 9 }).error);
check('read_page 字符串页码可转数字', v('read_page', { page: '3' }, { numPages: 9 }).args.page === 3);
check('search_paper 短查询被拒', !!v('search_paper', { query: 'a' }).error);
check('search_paper 正常查询通过', !v('search_paper', { query: '注意力机制' }).error);
check('search_papers 短查询被拒', !!v('search_papers', { query: 'a' }).error);
check('search_papers 默认 scope=folder', v('search_papers', { query: '注意力' }).args.scope === 'folder');
check('search_papers scope=all 通过', v('search_papers', { query: '注意力', scope: 'all' }).args.scope === 'all');
check('read_memory 空 topic 被拒', !!v('read_memory', { topic: '  ' }).error);
check('get_reading_state 无参数', !v('get_reading_state', {}).error);
for (const name of ['discover_papers', 'search_web']) {
  check(`${name} 拒绝空白/单字查询`, [' ', 'a'].every(query => !!v(name, { query }).error));
  const bounded = v(name, { query: 'q'.repeat(250), keywords: ['attention'], url: 'https://invented.invalid', scope: 'all' }).args;
  check(`${name} 查询限长且不能接受任意网址/范围注入`, bounded.query.length === 200 && !('url' in bounded) && !('scope' in bounded));
}
const discoverArgs = v('discover_papers', { query: '  attention model  ', keywords: [null, {}, 3, 'x', '', '  注意力  ', '注意力',
  'a'.repeat(130), 'two', 'three', 'four', 'five', 'six', 'seven'] }).args;
check('论文发现关键词去重、裁剪、去空并保留最多六项', discoverArgs.query === 'attention model'
  && JSON.stringify(discoverArgs.keywords) === JSON.stringify(['注意力', 'a'.repeat(100), 'two', 'three', 'four', 'five']));
check('论文发现忽略非数组关键词', v('discover_papers', { query: '论文发现', keywords: '注意力' }).args.keywords.length === 0);
check('普通联网搜索不透传论文关键词字段', !('keywords' in v('search_web', { query: '资料查询', keywords: ['keyword'] }).args));

/* ── 3. 响应解析 ── */
console.log('\n▶ 模型响应解析');
const parsed = parseModelResponse({
  choices: [{
    message: {
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_page', arguments: '{"page":3}' } },
        { id: 'call_2', type: 'function', function: { name: 'search_paper', arguments: { query: 'BLEU' } } },
      ],
    },
  }],
});
check('解析出 2 个 tool_calls', parsed.toolCalls.length === 2);
check('字符串 arguments 被解析成对象', parsed.toolCalls[0].args.page === 3);
check('对象 arguments 原样保留', parsed.toolCalls[1].args.query === 'BLEU');
check('无 tool_calls 时为空数组', parseModelResponse({ choices: [{ message: { content: '答' } }] }).toolCalls.length === 0);
check('坏 JSON arguments 不抛错', parseModelResponse({ choices: [{ message: { tool_calls: [{ function: { name: 'x', arguments: '{bad' } }] } }] }).toolCalls[0].args != null);

/* ── 4. 工具执行（只读 runtime） ── */
console.log('\n▶ 工具执行');
const runtime = {
  numPages: 9,
  async getReadingState() { return { docTitle: 'T', numPages: 9, currentPage: 2, scanned: false }; },
  async readPage(page) { return { page, text: `第 ${page} 页正文` }; },
  async searchPaper(query) { return { query, pages: [{ page: 4, snippet: '命中片段' }] }; },
  async readScanPage(page) { return { page, text: `扫描 ${page}` }; },
  async readPageImage(page) { return { page, note: 'ok' }; },
  async readMemory(topic) { return { items: [{ topic, kind: 'knowledge' }] }; },
  async searchPapers() { return { query: '注意力', scope: 'folder', count: 1, hits: [{ name: 'a.pdf', page: 3 }] }; },
  async discoverPapers(args) { return { query: args.query, local: { status: 'complete', results: [{ path: 'vision/a.pdf', page: 40 }] } }; },
  async searchWeb(args) { return { query: args.query, results: [{ title: 'Source', url: 'https://example.test/source' }] }; },
};
{
  for (const name of ['get_reading_state', 'read_page', 'search_paper', 'read_scan_page', 'read_page_image', 'read_memory', 'search_papers']) {
    const args = name === 'read_page' || name === 'read_scan_page' || name === 'read_page_image' ? { page: 3 }
      : name === 'search_paper' || name === 'search_papers' ? { query: '注意力' }
      : name === 'read_memory' ? { topic: '注意力' } : {};
    const r = await executeToolCall({ name, args }, runtime);
    check(`执行 ${name} 成功`, r.ok === true, JSON.stringify(r.value || r.error).slice(0, 60));
  }
  const bad = await executeToolCall({ name: 'read_page', args: { page: 99 } }, runtime);
  check('越界工具调用返回错误而不是抛异常', bad.ok === false && /总页数/.test(bad.error));
  const thrown = await executeToolCall({ name: 'read_page', args: { page: 2 } }, { ...runtime, readPage: async () => { throw new Error('boom'); } });
  check('工具内部异常被收敛成错误文本', thrown.ok === false && /boom/.test(thrown.error));
  for (const [name, method] of [['discover_papers', 'discoverPapers'], ['search_web', 'searchWeb']]) {
    const signal = new AbortController().signal;
    let captured;
    const result = await executeToolCall({ name, args: { query: '  bounded source  ', extra: true } }, {
      ...runtime, [method]: async (args, options) => { captured = { args, signal: options.signal }; return { results: [] }; },
    }, { signal });
    check(`${name} 向运行时传规范参数和当前任务signal`, result.ok && captured.args.query === 'bounded source'
      && !('extra' in captured.args) && captured.signal === signal);
    const rejected = await executeToolCall({ name, args: { query: 'source query' } }, {
      ...runtime, [method]: async () => { throw new Error('Synthetic provider failure'); },
    });
    check(`${name} 异常不会伪装成没有结果`, !rejected.ok && rejected.error.includes('Synthetic provider failure'));
    const declared = await executeToolCall({ name, args: { query: 'source query' } }, {
      ...runtime, [method]: async () => ({ error: 'Network not permitted' }),
    });
    check(`${name} 明确拒绝会传回错误`, !declared.ok && declared.error === 'Network not permitted');
  }
}

/* ── 5. 有界循环 ── */
console.log('\n▶ 有界 Agent 循环');
const baseMessages = [{ role: 'system', content: 'sys' }, { role: 'user', content: '问题' }];
{
  const found = { query: 'attention model', local: { status: 'complete', results: [{ path: 'vision/a.pdf', docId: 'a-12345678', page: 40, snippet: 'Original evidence' }] },
    online: { status: 'partial', results: [{ title: 'Academic source', url: 'https://example.test/source', pdfUrl: 'https://example.test/source.pdf' }], error: 'One provider unavailable' } };
  let turns = 0, received;
  const run = await runAgentLoop({ messages: baseMessages, runtime: { ...runtime, discoverPapers: async () => found },
    callModel: async ({ messages }) => {
      if (++turns === 1) return { choices: [{ message: { tool_calls: [{ id: 'find-paper', function: { name: 'discover_papers', arguments: '{"query":"attention model","keywords":["self attention"]}' } }] } }] };
      received = messages.find(message => message.role === 'tool' && message.tool_call_id === 'find-paper');
      return { choices: [{ message: { content: 'Based on the actual discovery results.' } }] };
    } });
  check('发现结果及部分渠道失败信息完整传给下一轮模型', run.ok && JSON.stringify(JSON.parse(received.content)) === JSON.stringify(found));
  check('其它论文的发现页码不会变成当前PDF的来源页', run.pages.length === 0 && run.imagePages.length === 0);
}
{
  let turns = 0, received;
  const run = await runAgentLoop({ messages: baseMessages, runtime: { ...runtime, searchWeb: async () => { throw new Error('Synthetic network unavailable'); } },
    callModel: async ({ messages }) => {
      if (++turns === 1) return { choices: [{ message: { tool_calls: [{ id: 'web-error', function: { name: 'search_web', arguments: '{"query":"source query"}' } }] } }] };
      received = JSON.parse(messages.find(message => message.role === 'tool' && message.tool_call_id === 'web-error').content);
      return { choices: [{ message: { content: 'The search was unavailable.' } }] };
    } });
  check('联网工具失败以错误回传模型而非成功空列表', run.ok && received.error.includes('Synthetic network unavailable') && !('results' in received));
}
{
  const ctl = new AbortController(); let entered, finishLate, signal, modelCalls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const events = [];
  const task = runAgentLoop({ messages: baseMessages, signal: ctl.signal,
    runtime: { ...runtime, discoverPapers: (_args, options) => { signal = options.signal; entered(); return new Promise(resolve => { finishLate = resolve; }); } },
    callModel: async () => { modelCalls++; return { choices: [{ message: { tool_calls: [{ id: 'cancel-discovery', function: { name: 'discover_papers', arguments: '{"query":"paper query"}' } }] } }] }; },
    onStep: event => events.push(event.type) });
  await started; ctl.abort(); const run = await task;
  finishLate({ local: { status: 'complete', results: [{ path: 'late.pdf', page: 9 }] } }); await new Promise(resolve => setImmediate(resolve));
  check('停止论文发现取消底层signal且忽略晚结果和后续模型请求', run.reason === 'aborted' && signal.aborted && modelCalls === 1
    && !events.includes('tool_done') && !run.pages.length);
}
{
  let turns = 0;
  const run = await runAgentLoop({ messages: baseMessages, callTimeoutMs: 10, totalTimeoutMs: 2000,
    runtime: { ...runtime, discoverPapers: async () => {
      await new Promise(resolve => setTimeout(resolve, 35));
      return { local: { status: 'not_found', coverage: { complete: true } }, online: { status: 'complete', results: [] } };
    } },
    callModel: async () => ++turns === 1
      ? { choices: [{ message: { tool_calls: [{ id: 'long-discovery', function: { name: 'discover_papers', arguments: '{"query":"paper query"}' } }] } }] }
      : { choices: [{ message: { content: 'Discovery completed within its own budget.' } }] } });
  check('论文发现可超过普通单次调用时限并在独立预算内完成', run.ok && run.calls[0]?.ok === true && turns === 2);
}
{
  let toolSignal, modelCalls = 0, finishLate;
  const started = Date.now();
  const run = await runAgentLoop({ messages: baseMessages, callTimeoutMs: 10, totalTimeoutMs: 600,
    runtime: { ...runtime, discoverPapers: (_args, options) => { toolSignal = options.signal; return new Promise(resolve => { finishLate = resolve; }); } },
    callModel: async () => { modelCalls++; return { choices: [{ message: { tool_calls: [{ id: 'bounded-discovery', function: { name: 'discover_papers', arguments: '{"query":"paper query"}' } }] } }] }; } });
  check('论文发现独立预算仍由整轮总deadline封顶并取消底层任务', run.reason === 'timeout' && toolSignal?.aborted && modelCalls === 1 && Date.now() - started < 2000);
  finishLate({ local: { status: 'matched', matches: [{ path: 'late.pdf' }] } });
  await new Promise(resolve => setImmediate(resolve));
  check('论文发现总deadline之后的结果不重开模型轮次', modelCalls === 1 && run.calls[0]?.ok === false);
}
{
  // 第 1 轮：2 个工具；第 2 轮：直接回答 → done
  const script = [
    { choices: [{ message: { content: '', tool_calls: [
      { id: 'c1', function: { name: 'get_reading_state', arguments: '{}' } },
      { id: 'c2', function: { name: 'read_page', arguments: '{"page":2}' } },
    ] } }] },
    { choices: [{ message: { content: '最终回答' } }] },
  ];
  const callsSeen = [];
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async ({ messages, tools }) => {
      callsSeen.push({ count: messages.length, tools: tools.length });
      return script.shift();
    },
  });
  check('两轮后结束（done）', run.ok && run.rounds === 2 && run.reason === 'done', JSON.stringify(agentStats(run)));
  check('记录了 2 次工具调用', run.calls.length === 2);
  check('收集到读过的页', run.pages.includes(2), JSON.stringify(run.pages));
  check('每轮请求都带 tools', callsSeen.every((c) => c.tools === AGENT_TOOL_SPECS.length));
  check('工具结果以 role=tool 追加', run.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c2'));
  check('assistant 的 tool_calls 被原样回传', run.messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length === 2));
}

{
  // 持续读取新页仍可用足轮数；每轮调用数受上限约束。
  let modelCalls = 0;
  const run = await runAgentLoop({
    messages: baseMessages, runtime: { ...runtime, numPages: 1000 },
    callModel: async () => {
      modelCalls++;
      return { choices: [{ message: { content: '', tool_calls: [1, 2, 3, 4, 5].map((i) => ({
        id: `c${modelCalls}_${i}`, function: { name: 'read_page', arguments: JSON.stringify({ page: (modelCalls - 1) * 5 + i }) },
      })) } }] };
    },
  });
  check(`最多 ${AGENT_MAX_ROUNDS} 轮`, modelCalls === AGENT_MAX_ROUNDS, `${modelCalls}`);
  check(`每轮最多 ${AGENT_MAX_CALLS_PER_ROUND} 个工具`, run.calls.length === AGENT_MAX_ROUNDS * AGENT_MAX_CALLS_PER_ROUND, `${run.calls.length}`);
  check('轮次用尽标记 max-rounds', run.reason === 'max-rounds');
}

{
  let requests = 0;
  const run = await runAgentLoop({ messages: baseMessages, runtime,
    callModel: async () => { requests++; return { choices: [{ message: { tool_calls: [
      { id: `repeat-${requests}`, function: { name: 'read_page', arguments: '{"page":2}' } },
    ] } }] }; } });
  check('重复相同读取无新材料时停止空转', run.reason === 'no-progress' && requests === 3);
  check('停止空转仍保留已读材料和页码', run.messages.some(m => m.role === 'tool') && run.pages.includes(2));
}

{
  // 模型决定不调用工具（直接回答）：不算失败，交给调用方流式生成最终回答
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async () => ({ choices: [{ message: { content: '直接答' } }] }),
  });
  check('模型不调工具时 ok 且 done', run.ok && run.reason === 'done' && run.calls.length === 0);
  check('directContent 带回来', run.directContent === '直接答');
}

{
  // 总超时：callModel 超时 → reason timeout → 调用方回退
  const started = Date.now();
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    totalTimeoutMs: 600, callTimeoutMs: 200,
    callModel: async ({ timeoutMs }) => new Promise((resolve, reject) => {
      setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs + 10);
    }),
  });
  check('超时 → ok=false 且 reason 可识别', run.ok === false && /timeout|error/.test(run.reason), run.reason);
  check('超时不会等满 25 秒', Date.now() - started < 3000, `${Date.now() - started}ms`);
}

{
  // 上游报错（模型不支持 tools）→ ok=false，调用方回退
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async () => { throw Object.assign(new Error('HTTP 400'), { status: 400 }); },
  });
  check('调用失败 → ok=false', run.ok === false && run.reason.startsWith('error'), run.reason);
}

{
  // abort
  const ctl = new AbortController();
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    signal: ctl.signal,
    callModel: async () => { ctl.abort(); return { choices: [{ message: { content: '' } }] }; },
  });
  check('abort 后不继续循环', run.reason === 'aborted', run.reason);
}

/* Providers may ignore cancellation; waiting and late results still stay bounded. */
{
  let idleBudget;
  const run = await runAgentLoop({ messages: baseMessages, callTimeoutMs: 25, totalTimeoutMs: 1000,
    callManagesIdleTimeout: true,
    callModel: async ({ timeoutMs }) => {
      idleBudget = timeoutMs;
      await new Promise(resolve => setTimeout(resolve, 80));
      return { choices: [{ message: { content: 'Active streamed answer' } }] };
    } });
  check('有独立空闲看门狗的流可以持续超过单次空闲预算', run.ok && run.directContent === 'Active streamed answer');
  check('流式调用仍收到原空闲预算而非整个任务预算', idleBudget === 25, String(idleBudget));
}
{
  let childSignal, finishLate;
  const started = Date.now();
  const run = await runAgentLoop({ messages: baseMessages, callTimeoutMs: 25, totalTimeoutMs: 600,
    callManagesIdleTimeout: true,
    callModel: ({ signal }) => { childSignal = signal; return new Promise(resolve => { finishLate = resolve; }); } });
  const elapsed = Date.now() - started;
  check('流式调用由整轮总deadline封顶并取消底层任务', !run.ok && run.reason === 'timeout' && childSignal.aborted
    && elapsed >= 500 && elapsed < 2000, `${elapsed}ms`);
  finishLate({ choices: [{ message: { content: 'Too late' } }] });
}
{
  let finishLate, childSignal, reads = 0;
  const events = [];
  const run = await runAgentLoop({ messages: baseMessages, runtime: { ...runtime, readPage: async () => { reads++; return {}; } },
    callTimeoutMs: 25, totalTimeoutMs: 1000,
    callModel: ({ signal }) => { childSignal = signal; return new Promise(resolve => { finishLate = resolve; }); },
    onStep: event => events.push(event.type) });
  check('忽略取消的模型请求仍会超时退出', !run.ok && /TimeoutError|timeout/.test(run.reason), run.reason);
  check('模型超时向子请求转发取消', childSignal.aborted);
  const before = events.length;
  finishLate({ choices: [{ message: { tool_calls: [{ id: 'late', function: { name: 'read_page', arguments: '{"page":2}' } }] } }] });
  await new Promise(resolve => setImmediate(resolve));
  check('超时后晚工具指令不执行且不刷新过程', reads === 0 && events.length === before);
}
{
  const ctl = new AbortController(); let started, finishLate, calls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = runAgentLoop({ messages: baseMessages, runtime, signal: ctl.signal,
    callModel: () => { calls++; started(); return new Promise(resolve => { finishLate = resolve; }); } });
  await entered; ctl.abort(); const run = await pending;
  check('等待模型时Stop立即结束并保持aborted语义', !run.ok && run.reason === 'aborted', run.reason);
  finishLate({ choices: [{ message: { content: '过期回答' } }] }); await new Promise(resolve => setImmediate(resolve));
  check('停止后晚回答不进入directContent也不重开轮次', !run.directContent && calls === 1);
}
{
  let finishLate, toolSignal, seenError = false, modelCalls = 0;
  const events = [];
  const run = await runAgentLoop({ messages: baseMessages,
    runtime: { ...runtime, readPage: (_page, { signal }) => { toolSignal = signal; return new Promise(resolve => { finishLate = resolve; }); } },
    callTimeoutMs: 25, totalTimeoutMs: 1000,
    callModel: async ({ messages }) => {
      modelCalls++;
      if (modelCalls === 1) return { choices: [{ message: { tool_calls: [{ id: 'slow-page', function: { name: 'read_page', arguments: '{"page":3}' } }] } }] };
      seenError = messages.some(m => m.role === 'tool' && JSON.parse(m.content).error);
      return { choices: [{ message: { content: '明确说明材料读取失败' } }] };
    }, onStep: event => events.push(event) });
  check('工具超时显式传回错误而不是伪造空正文', run.ok && seenError && run.calls[0]?.ok === false);
  check('工具超时取消底层读取且不添加来源页', toolSignal.aborted && !run.pages.includes(3));
  const eventCount = events.length; finishLate({ page: 3, text: '迟到的正文' }); await new Promise(resolve => setImmediate(resolve));
  check('晚工具结果不补来源页或发送后续UI事件', events.length === eventCount && !run.pages.includes(3));
}
{
  const ctl = new AbortController(); let toolStarted, finishLate, modelCalls = 0;
  const entered = new Promise(resolve => { toolStarted = resolve; }), events = [];
  const pending = runAgentLoop({ messages: baseMessages, signal: ctl.signal,
    runtime: { ...runtime, readPage: () => { toolStarted(); return new Promise(resolve => { finishLate = resolve; }); } },
    callModel: async () => { modelCalls++; return { choices: [{ message: { tool_calls: [{ id: 'cancel-page', function: { name: 'read_page', arguments: '{"page":4}' } }] } }] }; },
    onStep: event => events.push(event.type) });
  await entered; ctl.abort(); const run = await pending;
  check('工具读取途中Stop结束会话且没有工具完成事件', run.reason === 'aborted' && !events.includes('tool_done'), run.reason);
  finishLate({ page: 4, text: '不可采用' }); await new Promise(resolve => setImmediate(resolve));
  check('停止后迟到页不再触发模型请求', modelCalls === 1 && !run.pages.includes(4));
}

/* ── 6. 过程展示（右侧「一条一条列出干了什么」） ── */
console.log('\n▶ 过程展示（步骤标签 / 结果摘要 / onStep 事件）');
check('读取页步骤文案', toolStepLabel({ name: 'read_page', args: { page: 3 } }) === '读取第 3 页');
check('检索步骤文案带查询词', /检索「注意力机制」/.test(toolStepLabel({ name: 'search_paper', args: { query: '注意力机制' } })));
check('阅读状态步骤文案', toolStepLabel({ name: 'get_reading_state', args: {} }) === '查看当前阅读状态');
check('论文库检索步骤文案', /检索论文库「帅哥」（当前文件夹）/.test(toolStepLabel({ name: 'search_papers', args: { query: '帅哥', scope: 'folder' } })));
const sumLib = summarizeToolResult({ name: 'search_papers', args: { query: '帅哥' } },
  { ok: true, value: { scope: 'folder', count: 2, hits: [{}, {}], papersScanned: 8, papersTotal: 8 } });
check('论文库检索摘要带命中数', /2 条命中/.test(sumLib), sumLib);
const sumSearch = summarizeToolResult({ name: 'search_paper', args: { query: 'BLEU' } }, { ok: true, value: { pages: [{ page: 2 }, { page: 5 }] } });
check('检索结果摘要列出命中页', /命中 p\.2、p\.5/.test(sumSearch), sumSearch);
const sumRead = summarizeToolResult({ name: 'read_page', args: { page: 4 } }, { ok: true, value: { page: 4, text: 'x'.repeat(1234) } });
check('读取结果摘要带页码与字数', /读取第 4 页/.test(sumRead) && /1,234/.test(sumRead), sumRead);
const sumState = summarizeToolResult({ name: 'get_reading_state', args: {} }, { ok: true, value: { numPages: 18, currentPage: 4, scanned: false } });
check('阅读状态摘要带总页数/当前页', /共 18 页/.test(sumState) && /当前第 4 页/.test(sumState), sumState);
const sumFail = summarizeToolResult({ name: 'read_page', args: { page: 9 } }, { ok: false, error: 'page 超出总页数' });
check('失败摘要说明原因', /失败：page 超出总页数/.test(sumFail), sumFail);

{
  // 工具并发启动；每个调用的 start 在 done 前，下一轮等所有工具完成。
  const script = [
    { choices: [{ message: { content: '', tool_calls: [
      { id: 'c1', function: { name: 'get_reading_state', arguments: '{}' } },
      { id: 'c2', function: { name: 'read_page', arguments: '{"page":2}' } },
    ] } }] },
    { choices: [{ message: { content: '最终回答' } }] },
  ];
  const events = [];
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async () => script.shift(),
    onStep: (ev) => events.push(ev),
  });
  check('onStep 收到过程事件', events.length >= 7, `${events.length} 个事件`);
  check('同轮工具先并发启动，完成后才进入下一轮',
    events[0]?.type === 'round' && events[1]?.type === 'tools'
    && events[2]?.type === 'tool_start' && events[3]?.type === 'tool_start'
    && events[4]?.type === 'tool_done' && events[5]?.type === 'tool_done'
    && events[6]?.type === 'round' && events[7]?.type === 'ready',
    events.map((e) => e.type).join(','));
  check('tool_done 带可读摘要', events[4]?.summary === '阅读状态：共 9 页，当前第 2 页' && /读取第 2 页/.test(events[5]?.summary || ''),
    `${events[4]?.summary} / ${events[5]?.summary}`);
  check('循环结果不受 onStep 影响', run.ok && run.rounds === 2);
}

{
  // onStep 抛错不能打断 Agent（界面 DOM 异常也不能让回答失败）
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async () => ({ choices: [{ message: { content: '答案' } }] }),
    onStep: () => { throw new Error('ui boom'); },
  });
  check('onStep 抛错不影响循环', run.ok && run.reason === 'done');
}

/* ── 7. 只读保证 ── */
console.log('\n▶ 只读边界');
check('agent.js 没有任何写接口（fetch / localStorage / document）',
  !/fetch\(|localStorage|document\./.test((await import('node:fs')).readFileSync(new URL('../public/js/agent.js', import.meta.url), 'utf8')));

console.log(`\n结果：${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
