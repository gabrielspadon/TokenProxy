import http from 'node:http';
import { performance } from 'node:perf_hooks';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const token = 'soak-content';
const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
const chunk = (id, delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } } : {}) })}\n\n`;

// Per-request scenario selection survives concurrency and cannot spill into the next request.
// The seed and actual API routes are shared with the T07 started fixture.
export async function startSoakProvider({ sustainedMs = 30_000 } = {}) {
  const requests = [];
  let active = 0;
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    let bytes = 0;
    const parts = [];
    for await (const part of request) {
      bytes += part.length;
      if (bytes > 64 * 1024) { json(response, 413, { error: 'fixture request too large' }); return; }
      parts.push(part);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { json(response, 400, { error: 'fixture JSON' }); return; }
    const content = body.messages?.find((message) => message.role === 'user')?.content;
    const match = /^soak:([a-z]+-[0-9]+):([a-z-]+)$/u.exec(content || '');
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions') || !match) {
      json(response, 400, { error: 'fixture contract' }); return;
    }
    const [, id, scenario] = match;
    const receipt = { id, scenario, model: body.model, beganAtMs: performance.now(), contentStarted: false, completed: false };
    requests.push(receipt);
    active += 1;
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true; active -= 1; receipt.endedAtMs = performance.now();
    };
    response.once('close', finish);
    response.once('finish', finish);
    if (scenario === 'provider-reject') { json(response, 400, { error: { type: 'invalid_request_error', message: 'deterministic fixture rejection' } }); return; }
    if (!body.stream) {
      receipt.contentStarted = true; receipt.completed = true;
      json(response, 200, { id, object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: token }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(chunk(id, { role: 'assistant' }));
    response.write(chunk(id, { content: token }));
    receipt.contentStarted = true;
    if (scenario === 'stream-reset') { await wait(25); response.destroy(); return; }
    const lifetime = ['sustained', 'cancel'].includes(scenario) ? (id.startsWith('deterministic-') ? 40 : sustainedMs) : 0;
    const end = performance.now() + lifetime;
    while (!response.destroyed && performance.now() < end) {
      await wait(Math.min(250, Math.max(1, end - performance.now())));
      if (!response.destroyed) response.write(': heartbeat\n\n');
    }
    if (!response.destroyed) {
      receipt.completed = true;
      response.end(`${chunk(id, {}, 'stop')}data: [DONE]\n\n`);
    }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`, requests,
    get active() { return active; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return !server.listening && sockets.size === 0;
    },
  };
}
