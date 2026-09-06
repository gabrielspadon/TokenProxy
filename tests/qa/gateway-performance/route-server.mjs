import './aliases.mjs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NextRequest } from 'next/server.js';
const { POST } = await import('../../../src/app/api/v1/chat/completions/route.js');
const { GET } = await import('../../../src/app/api/context/route.js');
const server = http.createServer(async (req, res) => {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(new DOMException('client disconnected', 'AbortError')); });
  try {
    const request = new NextRequest(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers: req.headers, signal: abort.signal, ...(req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
    const result = req.url.startsWith('/api/context') ? await GET(request) : req.url === '/__ready' ? new Response('ready') : await POST(request);
    res.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) await pipeline(Readable.fromWeb(result.body), res); else res.end();
  } catch (error) {
    if (abort.signal.aborted) return;
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(error.message) }));
  }
});
server.listen(Number(process.env.PORT), '127.0.0.1', () => process.send?.({ type: 'ready' }));
