import { afterEach, describe, expect, it, vi } from 'vitest';
import { peekStreamForContent } from 'open-sse/utils/streamContent.js';

afterEach(() => vi.useRealTimers());
const response = body => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

describe('pre-output stream lifetime', () => {
  it('stops a silent accepted stream at the remaining budget even if cancellation acknowledgement hangs', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise(() => {}));
    const stream = new ReadableStream({ cancel });
    const pending = peekStreamForContent(response(stream), 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ hasContent: false, body: null });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('cancels only the caller-owned silent stream immediately on abort', async () => {
    const caller = new AbortController();
    const reason = new DOMException('caller left', 'AbortError');
    const cancel = vi.fn(() => new Promise(() => {}));
    const stream = new ReadableStream({ cancel });
    const siblingCancel = vi.fn();
    const sibling = new ReadableStream({ cancel: siblingCancel });
    const pending = peekStreamForContent(response(stream), 1000, { signal: caller.signal });
    const assertion = expect(pending).rejects.toBe(reason);
    caller.abort(reason);
    await assertion;
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(stream.locked).toBe(false);
    expect(siblingCancel).not.toHaveBeenCalled();
    await sibling.cancel();
  });

  it('releases the preparation timer once actionable output is available', async () => {
    vi.useFakeTimers();
    let controller;
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(c) { controller = c; }, cancel });
    const first = 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n';
    controller.enqueue(new TextEncoder().encode(first));
    const result = await peekStreamForContent(response(stream), 1000);
    expect(result.hasContent).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(cancel).not.toHaveBeenCalled();
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    controller.close();
    expect(await new Response(result.body).text()).toBe(first + 'data: [DONE]\n\n');
  });
});
