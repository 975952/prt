/** Streaming text/tool compatibility without real APIs or user configuration. */
import assert from 'node:assert/strict';
import { streamChat } from '../public/js/ai.js';
import { parseModelResponse } from '../public/js/agent.js';

const nativeFetch = globalThis.fetch;
const encoder = new TextEncoder();
const messages = [{ role: 'user', content: 'test' }];
const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
const sse = (chunks) => new Response(new ReadableStream({
  start(controller) {
    // Split even inside multibyte UTF-8 characters and tool-argument JSON.
    for (const chunk of chunks) {
      const bytes = encoder.encode(chunk);
      for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
    }
    controller.close();
  },
}), { headers: { 'Content-Type': 'text/event-stream' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const bounded = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Cancellation did not finish')), 1500); })]); }
  finally { clearTimeout(timer); }
};

try {
  let request;
  globalThis.fetch = async (_url, opts) => {
    request = JSON.parse(opts.body);
    return sse([
      event({ tool_calls: [{ index: 1, id: 'two', function: { name: 'read_page', arguments: '{"pa' } }] }),
      event({ tool_calls: [{ index: 0, id: 'one', function: { name: 'search_', arguments: '{"query":"注' } }] }),
      event({ tool_calls: [{ index: 0, function: { name: 'paper', arguments: '意力"}' } }, { index: 1, function: { arguments: 'ge":3}' } }] }),
      event({}, 'tool_calls'),
    ]);
  };
  const tools = [{ type: 'function', function: { name: 'read_page' } }];
  const raw = await streamChat({ messages, tools, stream: true, rawResponse: true });
  const parsed = parseModelResponse(raw);
  assert.deepEqual(parsed.toolCalls, [
    { id: 'one', name: 'search_paper', args: { query: '注意力' } },
    { id: 'two', name: 'read_page', args: { page: 3 } },
  ]);
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.equal(request.stream, true);
  assert.deepEqual(request.tools, tools);
  console.log('PASS: fragmented, interleaved tool calls preserve UTF-8, arguments, IDs and order');

  const deltas = [];
  globalThis.fetch = async () => sse([event({ content: '短答' }), event({ content: '案。' }).trimEnd()]);
  const answer = await streamChat({ messages, stream: true, rawResponse: true, onDelta: (part) => deltas.push(part) });
  assert.equal(parseModelResponse(answer).content, '短答案。');
  assert.deepEqual(deltas, ['短答', '案。']);
  console.log('PASS: direct answers stream; final event survives a missing trailing newline');

  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'json', function: { name: 'read_page', arguments: '{"page":2}' } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
  assert.equal(parseModelResponse(await streamChat({ messages, rawResponse: true })).toolCalls[0].args.page, 2);
  console.log('PASS: gateways ignoring stream:true still support tool calls');

  globalThis.fetch = async () => sse([event({ content: '正常回答' })]);
  assert.equal(await streamChat({ messages, stream: true }), '正常回答');
  assert.equal(await streamChat({ messages, stream: false }), '正常回答');
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'mock error' } }));
  await assert.rejects(streamChat({ messages, rawResponse: true }), /mock error/);
  globalThis.fetch = async () => sse(['data: {"error":{"message":"stream error"}}\n\n']);
  await assert.rejects(streamChat({ messages, rawResponse: true }), /stream error/);
  console.log('PASS: ordinary text modes and upstream error propagation');

  {
    const ctl = new AbortController(); ctl.abort(); let fetches = 0;
    globalThis.fetch = async () => { fetches++; return sse([event({ content: 'late' })]); };
    await assert.rejects(streamChat({ messages, signal: ctl.signal }), { name: 'AbortError' });
    assert.equal(fetches, 0);
    console.log('PASS: already stopped requests never call the provider');
  }
  {
    const ctl = new AbortController(), late = deferred(), deltas = [];
    globalThis.fetch = () => late.promise; // deliberately ignores the supplied signal
    const pending = streamChat({ messages, signal: ctl.signal, onDelta: part => deltas.push(part) });
    await nextTurn(); ctl.abort(); await assert.rejects(bounded(pending), { name: 'AbortError' });
    late.resolve(sse([event({ content: 'must not appear' })])); await nextTurn();
    assert.deepEqual(deltas, []);
    console.log('PASS: Stop releases a hung fetch and ignores its late response');
  }
  {
    const ctl = new AbortController(), late = deferred(), entered = deferred(), deltas = [], reasons = [];
    let cancellations = 0;
    globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Type': 'text/event-stream' }), body: {
      getReader: () => ({ read() { entered.resolve(); return late.promise; }, cancel() { cancellations++; return Promise.resolve(); }, releaseLock() {} }),
    } });
    const pending = streamChat({ messages, signal: ctl.signal, rawResponse: true,
      onDelta: part => deltas.push(part), onReasoning: part => reasons.push(part) });
    await entered.promise; ctl.abort(); await assert.rejects(bounded(pending), { name: 'AbortError' });
    late.resolve({ value: encoder.encode(event({ reasoning_content: 'late reason', content: 'late answer',
      tool_calls: [{ index: 0, id: 'late', function: { name: 'read_page', arguments: '{"page":3}' } }] })), done: false });
    await nextTurn(); assert.deepEqual(deltas, []); assert.deepEqual(reasons, []); assert(cancellations > 0);
    console.log('PASS: Stop releases a hung reader and rejects late content, reasoning and tool calls');
  }
  {
    for (const [contentType, raw, stream] of [
      ['application/json', JSON.stringify({ choices: [{ message: { content: 'late JSON answer' } }] }), true],
      ['text/event-stream', event({ content: 'late buffered answer' }), false],
    ]) {
      const ctl = new AbortController(), late = deferred(), entered = deferred(), deltas = [];
      globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Type': contentType }), text() { entered.resolve(); return late.promise; } });
      const pending = streamChat({ messages, signal: ctl.signal, stream, onDelta: part => deltas.push(part) });
      await entered.promise; ctl.abort(); await assert.rejects(bounded(pending), { name: 'AbortError' });
      late.resolve(raw); await nextTurn(); assert.deepEqual(deltas, []);
    }
    console.log('PASS: late JSON and buffered SSE bodies cannot deliver after Stop');
  }
  {
    const ctl = new AbortController(), deltas = [];
    globalThis.fetch = async () => sse([event({ reasoning_content: 'first', content: 'same-chunk stale answer' })]);
    await assert.rejects(streamChat({ messages, signal: ctl.signal,
      onReasoning: () => ctl.abort(), onDelta: part => deltas.push(part) }), { name: 'AbortError' });
    assert.deepEqual(deltas, []);
    console.log('PASS: cancellation inside a callback prevents later data in the same chunk');
  }
  {
    let cancellations = 0;
    globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Type': 'text/event-stream' }), body: {
      getReader: () => ({ read: () => new Promise(() => {}), cancel() { cancellations++; return Promise.resolve(); }, releaseLock() {} }),
    } });
    await assert.rejects(bounded(streamChat({ messages, idleMs: 25 })), { name: 'TimeoutError' });
    assert(cancellations > 0);
    console.log('PASS: idle watchdog ends unresponsive reads even when cancellation is ignored');
  }
} finally {
  globalThis.fetch = nativeFetch;
}
