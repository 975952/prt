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
} finally {
  globalThis.fetch = nativeFetch;
}
