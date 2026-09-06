import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
const now = () => Number(process.hrtime.bigint()) / 1e6;
const server = http.createServer(async (req, res) => {
  const receivedAt = now();
  let id, complete = false, record;
  res.on('close', () => { if (record) process.send?.({ type: 'provider', record: { ...record, closedAt: now(), aborted: !complete } }); });
  try {
    const parts = []; for await (const part of req) parts.push(part);
    const serialized = Buffer.concat(parts).toString();
    const request = JSON.parse(serialized);
    const marker = serialized.match(/BENCH_([a-f0-9-]+)_([a-z-]+)/);
    if (!marker) { res.writeHead(400); res.end('missing benchmark identity'); return; }
    [, id] = marker;
    const profile = marker[2], claude = req.url.includes('/messages');
    const checks = { modelPreserved: request.model === (profile === 'multimodal' ? 'gpt-4o' : 'fixture-model'), identityPreserved: Boolean(marker), ...(profile === 'tools' ? { toolIdPreserved: serialized.includes('call-fixture'), schemaPreserved: serialized.includes('lookup') && serialized.includes('protected'), errorPreserved: serialized.includes('error') } : {}), ...(profile === 'multimodal' ? { imagePreserved: serialized.includes('iVBORw0KGgo') } : {}), ...(profile === 'large' ? { largeContextPreserved: serialized.includes('immutable context α') && Buffer.byteLength(serialized) > 240000 } : {}) };
    record = { id, profile, receivedAt, bodyAt: now(), inputBytes: Buffer.byteLength(serialized), writes: [], blockedWrites: 0, drainMs: 0, wireModel: request.model, path: req.url, checks };
    process.send?.({ type: 'provider-start', id, receivedAt });
    const interval = ['slow-stream', 'abort-stream', 'dashboard'].includes(profile) ? 10 : 0;
    const count = profile === 'slow-reader' ? 512 : profile.startsWith('abort') ? 200 : interval ? 20 : 6;
    const chars = profile === 'slow-reader' ? 8192 : 32;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    if (profile === 'abort-headers') await sleep(200);
    const write = async (event, data) => {
      if (res.destroyed) return false;
      if (!res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)) {
        record.blockedWrites++;
        const at = now(), cancel = new AbortController();
        try { await Promise.race([once(res, 'drain', { signal: cancel.signal }), once(res, 'close', { signal: cancel.signal })]); }
        finally { cancel.abort(); }
        record.drainMs += now() - at;
      }
      return !res.destroyed;
    };
    if (claude) {
      await write('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: request.model, usage: { input_tokens: 100, output_tokens: 0 } } });
      await write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    } else await write(null, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    for (let i = 0; i < count; i++) {
      if (interval) await sleep(interval);
      if (res.destroyed) return;
      const at = now(); record.writes.push(at);
      const text = `B_${id}_${i}_${at.toFixed(6)}_${'x'.repeat(chars)} `;
      const alive = claude
        ? await write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        : await write(null, { id, object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      if (!alive) return;
    }
    if (claude) {
      await write('content_block_stop', { type: 'content_block_stop', index: 0 });
      await write('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 32 } });
      await write('message_stop', { type: 'message_stop' });
    } else {
      await write(null, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 32, total_tokens: 132 } });
      await write(null, '[DONE]');
    }
    complete = true; res.end();
  } catch (error) {
    if (!res.destroyed) { res.writeHead(500); res.end(String(error.message)); }
  }
});
server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: server.address().port }));
