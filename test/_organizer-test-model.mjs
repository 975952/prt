/** A loopback-only model double. Requests still pass through the real prt API. */
import http from 'node:http';

export const organizerModelInput = record => JSON.parse(record.body.messages.at(-1).content);
export const organizerModelTask = record => organizerModelInput(record).task;

export async function startOrganizerTestModel(initialResponder) {
  const requests = [], errors = [];
  let responder = initialResponder, active = 0, peak = 0;
  const server = http.createServer(async (req, res) => {
    let record;
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw new Error(`Unexpected model route: ${req.method} ${req.url}`);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      record = { id: requests.length, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), response: res, closed: false, finished: false };
      record.task = organizerModelTask(record);
      requests.push(record); active++; peak = Math.max(peak, active);
      res.on('close', () => { record.closed = true; active--; });
      await responder(record);
    } catch (error) {
      errors.push(String(error?.stack || error));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic model failed' } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  function start(record) {
    if (!record.response.headersSent) {
      record.response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      record.response.flushHeaders();
    }
  }
  function emit(record, content) {
    start(record);
    record.response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  }
  function reply(record, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    // Multiple chunks exercise the SSE collector as well as structured parsing.
    const middle = Math.max(1, Math.floor(text.length / 2));
    emit(record, text.slice(0, middle)); emit(record, text.slice(middle));
    record.finished = true; record.response.end('data: [DONE]\n\n');
  }
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests, errors, start, emit, reply,
    setResponder(next) { responder = next; },
    snapshot() { return { peak, errors, requests: requests.map(({ id, task, body, closed, finished }) => ({ id, task, body, closed, finished })) }; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
