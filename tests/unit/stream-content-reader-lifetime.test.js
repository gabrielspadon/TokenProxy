import { describe, expect, it, vi } from 'vitest';
import { peekStreamForContent } from 'open-sse/utils/streamContent.js';
const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
const response = body => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
describe('peek reader lifetime', () => {
  it('releases the original reader after replay reaches EOF', async () => {
    const source = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    const result = await peekStreamForContent(response(source), 1000);
    expect(await new Response(result.body).text()).toBe(new TextDecoder().decode(bytes));
    expect(source.locked).toBe(false);
  });
  it('awaits upstream cancellation, forwards its reason, and releases once cleanup settles', async () => {
    let acknowledge;
    const cancelled = vi.fn(() => new Promise(resolve => { acknowledge = resolve; }));
    const source = new ReadableStream({ start(c) { c.enqueue(bytes); }, cancel: cancelled });
    const result = await peekStreamForContent(response(source), 1000);
    let settled = false;
    const cancellation = result.body.cancel('client stopped').then(() => { settled = true; });
    await Promise.resolve();
    expect(cancelled).toHaveBeenCalledExactlyOnceWith('client stopped');
    expect(settled).toBe(false);
    acknowledge(); await cancellation;
    expect(source.locked).toBe(false);
  });
});
