import { describe, expect, it, vi } from 'vitest';
import { convertResponsesStreamToJson } from 'open-sse/transformer/streamToJsonConverter.js';
import { peekStreamForContent } from 'open-sse/utils/streamContent.js';
import { consumeResponseBodyWithDeadline } from 'open-sse/utils/bodyTimeout.js';

const encoder = new TextEncoder();
const terminal = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 123 } } };
const items = [
  { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'item-2', call_id: 'call-2', name: 'lookup', arguments: '{"identity":"José 🐋", "number":9007199254740993}' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'item-1', encrypted_content: 'OPAQUE-SIGNED-Σ', summary: [{ type: 'summary_text', text: 'Evidence' }] } },
];
const events = [{ type: 'response.created', response: { id: 'resp-framing', created_at: 42 } }, ...items, terminal];
function source(text, size = Infinity, { cancel = () => {} } = {}) {
  const bytes = encoder.encode(text); let offset = 0;
  return new ReadableStream({ pull(controller) { if (offset >= bytes.length) { controller.close(); return; } const end = Math.min(bytes.length, offset + size); controller.enqueue(bytes.subarray(offset, end)); offset = end; }, cancel }, { highWaterMark: 0 });
}
const frame = (event, newline = '\n', multiline = false) => `event: ${event.type}${newline}data: ${JSON.stringify(event, null, multiline ? 2 : 0).replaceAll('\n', `${newline}data: `)}${newline}${newline}`;
const response = body => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

for (const newline of ['\n', '\r\n', '\r']) for (const multiline of [false, true]) {
  it(`collects ordered identity/signature/cache fields for ${JSON.stringify(newline)}, multiline=${multiline}`, async () => {
    const text = ': heartbeat' + newline + newline + 'id: reconnection-only' + newline + 'retry: 5' + newline + newline + events.map(e => frame(e, newline, multiline)).join('');
    const output = await convertResponsesStreamToJson(source(text, 7));
    expect(output).toMatchObject({ id: 'resp-framing', status: 'completed', created_at: 42, usage: terminal.response.usage });
    expect(output.output).toEqual([items[1].item, items[0].item]);
  });
}

describe('framing boundaries and lifetime', () => {
  it('preserves an otherwise complete final JSON event without an SSE blank delimiter', async () => {
    const output = await convertResponsesStreamToJson(source(events.map(e => frame(e)).join('').trimEnd(), 1));
    expect(output.status).toBe('completed'); expect(output.output).toEqual([items[1].item, items[0].item]);
  });
  it('does not promote truncated JSON to a terminal or accept a comment/id/retry as payload', async () => {
    const text = ': data: [DONE]\nid: response.completed\nretry: 0\n\ndata: {"type":"response.completed",\n';
    const output = await convertResponsesStreamToJson(source(text, 3));
    expect(output.status).toBe('in_progress'); expect(output.output).toEqual([]);
  });
  it('detects multiline real progress and replays the original bytes including metadata', async () => {
    const text = ': heartbeat\r\nid: exact-id\r\nretry: 12\r\nevent: content_block_delta\r\ndata: {"type":"content_block_delta",\r\ndata: "delta":{"text":"José 🐋"}}\r\n\r\n';
    const result = await peekStreamForContent(response(source(text, 3)), 1000);
    expect(result.hasContent).toBe(true); expect(await new Response(result.body).text()).toBe(text);
  });
  it('retains peek byte-threshold fallback and raw bytes for oversized incomplete frames', async () => {
    const text = 'data: ' + 'x'.repeat(270 * 1024);
    const result = await peekStreamForContent(response(source(text, 1024)), 1000);
    expect(result.hasContent).toBe(true); expect(await new Response(result.body).text()).toBe(text);
  });
  it('reads progressively under a slow consumer and cancels the upstream reader once', async () => {
    let pulls = 0, cancels = 0;
    const wire = encoder.encode('data: {"choices":[{"delta":{"content":"progress"}}]}\n\n');
    const upstream = new ReadableStream({ pull(c) { pulls++; c.enqueue(wire); }, cancel() { cancels++; } }, { highWaterMark: 0 });
    const result = await peekStreamForContent(response(upstream), 1000);
    const reader = result.body.getReader();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(pulls).toBeLessThanOrEqual(2);
    for (let n = 0; n < 4; n++) { expect((await reader.read()).value).toEqual(wire); await new Promise(resolve => setTimeout(resolve, 2)); }
    const beforeCancel = pulls; await reader.cancel('client stopped');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(cancels).toBe(1); expect(pulls).toBe(beforeCancel);
    expect(upstream.locked).toBe(false);
  });
  it('releases a replay reader at normal EOF', async () => {
    const upstream = source('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    const result = await peekStreamForContent(response(upstream), 1000);
    await new Response(result.body).text();
    expect(upstream.locked).toBe(false);
  });
  it('keeps outer abort ownership during an incomplete event and releases the reader once', async () => {
    const cancel = vi.fn(); const abort = new AbortController();
    const stream = new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: {"unfinished":"🐋')); }, cancel });
    const result = consumeResponseBodyWithDeadline({ body: stream, callerSignal: abort.signal, timeoutMs: 1000, consume: reader => convertResponsesStreamToJson(null, { reader }) });
    const started = performance.now(); abort.abort('client stopped');
    await expect(result).rejects.toMatchObject({ name: 'CallerAbortError' });
    expect(performance.now() - started).toBeLessThan(100); expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false);
  });
});
