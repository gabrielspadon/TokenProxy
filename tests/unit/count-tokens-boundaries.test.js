import { describe, expect, it } from 'vitest';
import { POST, OPTIONS } from '../../src/app/api/v1/messages/count_tokens/route.js';
const request = (body, options = {}) => new Request('http://localhost/v1/messages/count_tokens', { method: 'POST', body: JSON.stringify(body), ...options });
describe('count endpoint provenance and admission', () => {
  it('labels Claude and unknown models as estimates with no verified tokenizer', async () => {
    const response = await POST(request({ model: 'claude-sonnet-4', messages: [{ content: 'hello world' }] }));
    expect(await response.json()).toMatchObject({ input_tokens: 3, estimated: true, estimation: { encoding: null, method: 'character_heuristic', provider_calls: 0 } });
  });
  it('counts verified model text locally but labels provider framing unverified', async () => {
    const response = await POST(request({ model: 'gpt-4o', messages: [{ content: 'hello world' }] }));
    expect(await response.json()).toMatchObject({ input_tokens: 2, estimated: true, estimation: { text_tokens: 2, encoding: 'o200k_base' } });
  });
  it('does not tokenize encoded media and exposes its unbounded heuristic error', async () => {
    const response = await POST(request({ model: 'gpt-4o', messages: [{ content: [{ type: 'image', source: { data: 'a'.repeat(1024 * 1024) } }] }] }));
    const body = await response.json();
    expect(body).toMatchObject({ input_tokens: 1600, estimation: { text_tokens: 0, media_blocks: 1, media_tokens_per_block: 1600 } });
    expect(body.estimation.limitations.join(' ')).toContain('without an error bound');
  });
  it('rejects oversized JSON and text, malformed JSON, arrays and null', async () => {
    for (const body of [null, [], 'malformed']) expect((await POST(request(body))).status).toBe(400);
    expect((await POST(request({ messages: [{ content: 'a'.repeat(4 * 1024 * 1024) }] }))).status).toBe(413);
    expect((await POST(request({ model: 'gpt-4o', messages: [{ content: 'a'.repeat(131073) }] }))).status).toBe(413);
  });
  it('rejects deeply nested content before recursion overflows', async () => {
    let nested = 'x'; for (let n = 0; n < 40; n++) nested = { nested };
    expect((await POST(request({ system: nested }))).status).toBe(400);
  });
  it('releases stalled body admissions on cancellation and permits a later request', async () => {
    const controller = new AbortController();
    const jobs = Array.from({ length: 16 }, () => POST(new Request('http://localhost/count', { method: 'POST', duplex: 'half', signal: controller.signal, body: new ReadableStream({ start() {} }) })));
    expect((await POST(request({}))).status).toBe(503);
    controller.abort();
    expect((await Promise.all(jobs)).every(value => value.status === 408)).toBe(true);
    expect((await POST(request({}))).status).toBe(200);
  });
  it('preserves preflight headers', async () => { expect((await OPTIONS()).headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS'); });
});
